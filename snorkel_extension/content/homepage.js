/*
 * homepage.js — step 2 of the flow: get from https://experts.snorkel-ai.com/home
 * into a task, either a new one or one sent back for revision.
 *
 * THE HOME PAGE WAS REDESIGNED, and none of the old markup survived it. What it
 * looks like now (from snorkel_homepage.html):
 *
 *   <div data-testid="ec-project-card-CDG_Sentinel_Ultra_00000">
 *     Project  CDG_Sentinel_Ultra_00000
 *     <button>Go to project</button>          <- no longer hands out a task
 *   </div>
 *
 *   <table data-testid="tasks-needing-revision-table">
 *     Task ID | Project Name | Due Date | Action
 *     0cb4eb47-…  CDG_Sentinel_Ultra_00000  8/10/2026  <a
 *        data-testid="revise-task-<assignmentId>"
 *        href="/projects/<projectId>/submission-<submissionId>/review?assignmentId=…"
 *        ><button>Revise task</button></a>
 *   </table>
 *
 * Two changes matter more than the rest:
 *
 * 1. STARTING A NEW TASK TAKES TWO PAGES. "Go to project" only opens the project
 *    overview (snrokel_project_start_UI.html); the task comes from the "Begin
 *    Submission" button there. The old card went straight to the review page.
 *
 * 2. THE UID IS IN THE ROW, NOT IN THE TESTID. `revise-task-<uuid>` carries the
 *    ASSIGNMENT id, which is a different value from the Task ID in the first
 *    cell — and the Task ID is what the rest of this system calls a UID. Reading
 *    the testid, as the old code did for `<uid>-<projectKey>` anchors, would
 *    hand the server eight ids it has never seen.
 *
 * The table also mixes projects — Geranium rows sit alongside Sentinel ones — so
 * the project name is now a filter rather than something implied by the testid.
 */

(function () {
  const PROJECT_CARDS = '[data-testid^="ec-project-card-"]';
  const REVISION_TABLE = '[data-testid="tasks-needing-revision-table"]';
  const REVISE_ANCHOR = 'a[data-testid^="revise-task-"]';

  const text = (el) => (el ? SnorkelBot.text(el) : '');
  const same = (a, b) => SnorkelBot.normText(a).toLowerCase() === SnorkelBot.normText(b).toLowerCase();

  const buttonBy = (root, re) =>
    Array.from(root.querySelectorAll('button')).find((b) => re.test(SnorkelBot.normText(text(b))));

  /*
   * Matched by walking the cards rather than by building a selector, because a
   * project key goes into `data-testid` verbatim and CSS.escape is the only safe
   * way to interpolate one — this needs no escaping at all, and picks up a key
   * that differs only in case or surrounding space along the way.
   */
  const projectCard = (key) =>
    Array.from(document.querySelectorAll(PROJECT_CARDS)).find((card) =>
      same((card.getAttribute('data-testid') || '').replace(/^ec-project-card-/, ''), key)
    ) || null;

  function assertSignedIn() {
    if (/\/login/i.test(location.pathname)) {
      throw new Error('Not signed in — the browser is on the Snorkel login page.');
    }
  }

  // ------------------------------------------------------ the revise table ----

  /**
   * One row, read by what its cells contain rather than by their position.
   *
   * The UID is found by scanning for a UUID and the project by matching the name
   * against every cell, so a column inserted in front of either does not silently
   * shift what gets read — which, for the UID, would mean acting on the wrong
   * task.
   */
  function rowInfo(tr) {
    const cells = Array.from(tr.querySelectorAll('td'));
    if (!cells.length) return null;

    const texts = cells.map((cell) => SnorkelBot.normText(text(cell)));
    const uid = texts.map((t) => (t.match(SnorkelBot.UUID_RE) || [])[0]).find(Boolean) || null;
    const anchor = tr.querySelector(REVISE_ANCHOR) || tr.querySelector('a[href*="/review"]');
    const href = anchor ? anchor.getAttribute('href') || '' : '';

    return {
      uid,
      texts,
      anchor,
      href,
      // The assignment id, kept because it is what the platform's own URL uses
      // and what any support conversation about a stuck row will quote.
      assignmentId: (href.match(/assignmentId=([0-9a-f-]{36})/i) || [])[1] || null,
      due: texts[2] || null,
    };
  }

  const rowsFor = (projectKey) => {
    const table = document.querySelector(REVISION_TABLE);
    if (!table) return [];
    return Array.from(table.querySelectorAll('tbody tr'))
      .map(rowInfo)
      .filter((row) => row && row.uid && row.texts.some((t) => same(t, projectKey)));
  };

  /** The button inside the row's link; React binds to it, not to the anchor. */
  const clickTarget = (anchor) => (anchor && anchor.querySelector('button')) || anchor;

  // ------------------------------------------------------- starting a task ----

  /**
   * Step one of two: open the project.
   *
   * Still called CLICK_START because that is what it is for, but it no longer
   * produces a task on its own — background.js follows it with
   * CLICK_BEGIN_SUBMISSION on the page this lands on.
   */
  SnorkelBot.on('CLICK_START', async (msg) => {
    const projectKey = msg.projectKey || 'CDG_Sentinel_Ultra_00000';
    assertSignedIn();

    const card = await SnorkelBot.waitFor(() => projectCard(projectKey), {
      timeout: msg.timeout || 90000,
      label: `the "${projectKey}" project card`,
    });

    const button = buttonBy(card, /go to project/i) || card.querySelector('button');
    if (!button) {
      throw new Error(
        `Found the "${projectKey}" card but it has no button to open the project — the home ` +
          `page markup has changed again.`
      );
    }

    const anchor = button.closest('a');
    const href = anchor ? anchor.getAttribute('href') || '' : '';
    SnorkelBot.click(button);

    return {
      clicked: true,
      buttonLabel: SnorkelBot.normText(text(button)),
      testid: `ec-project-card-${projectKey}`,
      href,
      targetUrl: href ? new URL(href, location.origin).href : null,
      // Says plainly that a task has not been handed out yet.
      needsBeginSubmission: true,
    };
  });

  /**
   * Step two of two, on the project overview page: take the task.
   *
   * The button sits inside an anchor pointing at the project page itself, so
   * following the link would only reload where we already are — the button's own
   * handler is what routes to the review page. Hence the button, never the link.
   */
  SnorkelBot.on('CLICK_BEGIN_SUBMISSION', async (msg) => {
    assertSignedIn();

    const button = await SnorkelBot.waitFor(() => buttonBy(document, /begin submission/i), {
      timeout: msg.timeout || 60000,
      label: 'the "Begin Submission" button on the project page',
    });

    if (button.disabled || button.getAttribute('aria-disabled') === 'true') {
      const failure = new Error(
        'The "Begin Submission" button is disabled — the platform is not handing out a task ' +
          'right now, usually because too many submissions are waiting to be revised.'
      );
      failure.code = 'START_UNAVAILABLE';
      throw failure;
    }

    SnorkelBot.click(button);
    return { clicked: true, buttonLabel: SnorkelBot.normText(text(button)) };
  });

  // ------------------------------------------------------------ revisions ----

  /**
   * Every submission the site is asking to have revised.
   *
   * A timeout here is not an error. A home page with nothing to revise renders
   * no table at all, and throwing would turn a legitimate zero into a failed
   * check on every sweep.
   */
  SnorkelBot.on('LIST_REVISIONS', async (msg) => {
    const projectKey = msg.projectKey || 'CDG_Sentinel_Ultra_00000';
    assertSignedIn();

    /*
     * The tab reports "complete" as soon as the document has loaded, which on a
     * single-page app is well before React has drawn the table. Reading straight
     * away found an empty page and reported zero revisions every time.
     *
     * Waiting on the ROWS, not the table: the table renders with its header
     * first and sits empty for a moment, so waiting for it would leave the same
     * hole, only narrower.
     */
    const appeared = await SnorkelBot.waitFor(
      () => document.querySelectorAll(`${REVISION_TABLE} tbody tr`).length || null,
      { timeout: msg.timeout || 90000, interval: 400, label: 'the revision table to render' }
    ).catch(() => 0);

    // Rows arrive in batches; let the table stop growing before counting it.
    if (appeared) {
      let seen = -1;
      const settleDeadline = Date.now() + (msg.settle || 8000);
      while (Date.now() < settleDeadline) {
        const now = document.querySelectorAll(`${REVISION_TABLE} tbody tr`).length;
        if (now === seen) break;
        seen = now;
        await SnorkelBot.sleep(700);
      }
    }

    const rows = rowsFor(projectKey);
    const allRows = document.querySelectorAll(`${REVISION_TABLE} tbody tr`).length;

    return {
      revisions: rows.map((row) => ({
        uid: row.uid,
        href: row.href,
        assignmentId: row.assignmentId,
        due: row.due,
        title: row.uid,
      })),
      count: rows.length,
      // `cards` keeps the old name the server logs. It tells "nothing to revise"
      // apart from "the page never rendered", and now also apart from "the table
      // is full of another project's work".
      cards: allRows,
      rendered: Boolean(appeared),
    };
  });

  /** Opens one submission's review page from its row in the table. */
  SnorkelBot.on('CLICK_REVISE', async (msg) => {
    const projectKey = msg.projectKey || 'CDG_Sentinel_Ultra_00000';
    const wanted = String(msg.uid || '').toLowerCase();
    assertSignedIn();

    const row = await SnorkelBot.waitFor(
      () => rowsFor(projectKey).find((r) => (r.uid || '').toLowerCase() === wanted) || null,
      { timeout: msg.timeout || 90000, label: `a "Revise task" row for ${msg.uid}` }
    );

    if (!row.anchor) {
      throw new Error(`The row for ${msg.uid} has no "Revise task" link to follow.`);
    }

    SnorkelBot.click(clickTarget(row.anchor));
    return { clicked: true, uid: msg.uid, href: row.href, assignmentId: row.assignmentId };
  });

  /** Diagnostic helper — lets the popup/server see what the page is offering. */
  SnorkelBot.on('LIST_PROJECTS', () => ({
    cards: Array.from(document.querySelectorAll(PROJECT_CARDS)).map((card) => ({
      title: (card.getAttribute('data-testid') || '').replace(/^ec-project-card-/, ''),
      testid: card.getAttribute('data-testid'),
      button: SnorkelBot.normText(text(card.querySelector('button'))) || null,
    })),
    revisions: Array.from(document.querySelectorAll(`${REVISION_TABLE} tbody tr`))
      .map(rowInfo)
      .filter(Boolean)
      .map((row) => ({ uid: row.uid, project: row.texts[1] || null, href: row.href })),
  }));
})();
