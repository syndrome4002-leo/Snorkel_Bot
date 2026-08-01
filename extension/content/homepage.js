/*
 * homepage.js — step 2 of the flow: find the Sentinel project card on
 * https://experts.snorkel-ai.com/home and click its "Start" button.
 *
 * Card markup (from snorkel_homepage.html):
 *
 *   <div data-testid="project-card">
 *     <h5>Submission</h5>
 *     <a data-testid="Submission-CDG_Sentinel_Ultra_00000"
 *        href="/projects/<projectId>/submission-<submissionId>/review">
 *       <button>Start</button>
 *     </a>
 *     ... <div>Project:</div> CDG_Sentinel_Ultra_00000
 *   </div>
 *
 * Two flavours of card exist for the same project:
 *   - "Submission-<projectKey>"        -> hands out a NEW task            (mode: 'new')
 *   - "<assignmentUuid>-<projectKey>"  -> resumes an already-claimed task (mode: 'resume')
 * Default is 'new', falling back to a resume card only when mode is 'any'.
 */

(function () {
  const PROJECT_CARD = '[data-testid="project-card"]';

  function anchorsForProject(projectKey) {
    const suffix = `-${projectKey}`;
    return Array.from(document.querySelectorAll('a[data-testid]')).filter((a) =>
      a.getAttribute('data-testid').endsWith(suffix)
    );
  }

  function isResumeAnchor(a) {
    // "029c1c0c-15f1-4ee6-...-CDG_Sentinel_Ultra_00000" -> starts with a UUID
    return SnorkelBot.UUID_RE.test(a.getAttribute('data-testid').slice(0, 36));
  }

  /** Last-resort scan when the data-testid convention changes. */
  function anchorByCardText(projectKey) {
    for (const card of document.querySelectorAll(PROJECT_CARD)) {
      if (!SnorkelBot.text(card).includes(projectKey)) continue;
      const a = card.querySelector('a[href*="/review"]');
      if (a) return a;
    }
    return null;
  }

  function pickAnchor(projectKey, mode) {
    const anchors = anchorsForProject(projectKey);
    const fresh = anchors.filter((a) => !isResumeAnchor(a));
    const resume = anchors.filter(isResumeAnchor);

    if (mode === 'resume') return resume[0] || null;
    if (mode === 'any') return fresh[0] || resume[0] || anchorByCardText(projectKey);
    return fresh[0] || anchorByCardText(projectKey); // 'new'
  }

  function startButton(anchor) {
    // The <button>Start</button> lives inside the anchor; click the button when
    // it is there (React binds to it) and fall back to the anchor itself.
    const btn = anchor.querySelector('button');
    if (btn) return btn;
    return anchor;
  }

  SnorkelBot.on('CLICK_START', async (msg) => {
    const projectKey = msg.projectKey || 'CDG_Sentinel_Ultra_00000';
    const mode = msg.mode || 'new';

    if (/\/login/i.test(location.pathname)) {
      throw new Error('Not signed in — the browser is on the Snorkel login page.');
    }

    const anchor = await SnorkelBot.waitFor(() => pickAnchor(projectKey, mode), {
      timeout: msg.timeout || 30000,
      label: `a Start card for project "${projectKey}" (mode: ${mode})`,
    });

    const href = anchor.getAttribute('href') || '';
    const testid = anchor.getAttribute('data-testid') || '';
    const label = SnorkelBot.text(startButton(anchor)) || 'Start';

    SnorkelBot.click(startButton(anchor));

    return {
      clicked: true,
      buttonLabel: label,
      testid,
      href,
      targetUrl: href ? new URL(href, location.origin).href : null,
      resumed: isResumeAnchor(anchor) || false,
    };
  });

  /** Diagnostic helper — lets the popup/server see what cards are on offer. */
  SnorkelBot.on('LIST_PROJECTS', () => ({
    cards: Array.from(document.querySelectorAll(PROJECT_CARD)).map((card) => {
      const a = card.querySelector('a[data-testid]');
      return {
        title: SnorkelBot.text(card.querySelector('h5')),
        testid: a ? a.getAttribute('data-testid') : null,
        href: a ? a.getAttribute('href') : null,
      };
    }),
  }));
})();
