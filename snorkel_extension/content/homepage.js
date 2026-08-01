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
 *   - "Submission-<projectKey>"     -> button says "Start", hands out a NEW task
 *   - "<submissionUid>-<projectKey>" -> button says "Revise", a task the
 *                                       reviewer has sent back
 *
 * The revise cards are titled with the submission UID, which is the same value
 * the review page shows as "UID:". That is what makes them findable later: the
 * server asks for feedback by UID and this clicks that card's Revise button.
 */

(function () {
  const PROJECT_CARD = '[data-testid="project-card"]';

  function anchorsForProject(projectKey) {
    const suffix = `-${projectKey}`;
    return Array.from(document.querySelectorAll('a[data-testid]')).filter((a) =>
      a.getAttribute('data-testid').endsWith(suffix)
    );
  }

  /** A card whose testid starts with a UUID is a revise card, not a fresh task. */
  function isReviseAnchor(a) {
    return SnorkelBot.UUID_RE.test(a.getAttribute('data-testid').slice(0, 36));
  }

  /** The submission UID a revise card is for. */
  function uidOf(a) {
    const match = a.getAttribute('data-testid').match(SnorkelBot.UUID_RE);
    return match ? match[0] : null;
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

  /**
   * Only ever returns a card that hands out a NEW task.
   *
   * Revise cards are deliberately excluded: an earlier version treated them as
   * "resume" cards, so asking for a task could click Revise on work that had
   * been sent back — which is a different thing entirely.
   */
  function pickAnchor(projectKey) {
    const fresh = anchorsForProject(projectKey).filter((a) => !isReviseAnchor(a));
    return fresh[0] || anchorByCardText(projectKey);
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

    const anchor = await SnorkelBot.waitFor(() => pickAnchor(projectKey), {
      timeout: msg.timeout || 30000,
      label: `a Start card for project "${projectKey}"`,
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
    };
  });

  /**
   * Every submission the site is asking to have revised.
   *
   * The card's <h5> is the submission UID; the button reads "Revise". Both are
   * checked so a future card type with a UUID title but a different action is
   * not mistaken for one of these.
   */
  SnorkelBot.on('LIST_REVISIONS', (msg) => {
    const projectKey = msg.projectKey || 'CDG_Sentinel_Ultra_00000';

    const revisions = anchorsForProject(projectKey)
      .filter(isReviseAnchor)
      .filter((a) => /revise/i.test(SnorkelBot.text(a.querySelector('button') || a)))
      .map((a) => ({
        uid: uidOf(a),
        href: a.getAttribute('href'),
        title: SnorkelBot.text(a.closest(PROJECT_CARD)?.querySelector('h5')),
      }))
      .filter((entry) => entry.uid);

    return { revisions, count: revisions.length };
  });

  /** Opens one submission's review page by clicking its Revise button. */
  SnorkelBot.on('CLICK_REVISE', async (msg) => {
    const projectKey = msg.projectKey || 'CDG_Sentinel_Ultra_00000';
    const wanted = String(msg.uid || '').toLowerCase();

    const anchor = await SnorkelBot.waitFor(
      () =>
        anchorsForProject(projectKey)
          .filter(isReviseAnchor)
          .find((a) => (uidOf(a) || '').toLowerCase() === wanted),
      { timeout: msg.timeout || 30000, label: `a Revise card for ${msg.uid}` }
    );

    const href = anchor.getAttribute('href') || '';
    SnorkelBot.click(startButton(anchor));
    return { clicked: true, uid: msg.uid, href };
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
