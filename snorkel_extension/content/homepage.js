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
  const ATTENTION_BANNER = '[data-testid="needs-attention-banner"]';

  const SHOW_MORE = '[data-testid="show-more-revision-tasks"]';
  /** A fallback for when that testid changes, matched on what it reads. */
  const MORE_BUTTON = /^(show|view|see|load)\s+(more|all)(\s+tasks?)?$/i;

  const text = (el) => (el ? SnorkelBot.text(el) : '');

  /**
   * A cell's OWN text, ignoring anything nested inside it.
   *
   * The Project Name cell is a bare text node followed by an annotation block:
   *
   *   <td>CDG_Sentinel_Ultra_00000<div class="snorkel-card-meta">
   *         <span>Syndrome</span><span>[Sentinel] - 0cb4eb47-…</span></div></td>
   *
   * Read whole, that runs together as "CDG_Sentinel_Ultra_00000Syndrome[…]" —
   * textContent puts no space between elements — so neither an equality test nor
   * a "starts with the key and a space" test matches. The direct text node is
   * the project name and nothing else.
   */
  const ownText = (el) =>
    !el
      ? ''
      : SnorkelBot.normText(
          Array.from(el.childNodes)
            .filter((n) => n.nodeType === 3)
            .map((n) => n.nodeValue || '')
            .join(' ')
        );
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
   * Which column is which, read from the header rather than assumed.
   *
   * Position alone is not safe any more: the Project Name cell now carries the
   * submission's title, and that title contains a UUID of its own —
   *
   *   Task ID       41fd93c0-79fa-452c-827c-360e1ea363b6
   *   Project Name  CDG_Sentinel_Ultra_00000 Dmon [Sentinel] - 7c7220b0-…
   *
   * — so "the first cell holding a UUID" is one inserted column away from
   * quietly returning the wrong task.
   */
  function columnsOf(table) {
    const heads = Array.from(table.querySelectorAll('thead th')).map((th) =>
      SnorkelBot.normText(text(th)).toLowerCase()
    );
    return {
      uid: heads.findIndex((h) => /task\s*id/.test(h)),
      project: heads.findIndex((h) => /project/.test(h)),
      due: heads.findIndex((h) => /due/.test(h)),
    };
  }

  const firstUuid = (s) => (String(s || '').match(SnorkelBot.UUID_RE) || [])[0] || null;

  function rowInfo(tr, cols = {}) {
    const cells = Array.from(tr.querySelectorAll('td'));
    if (!cells.length) return null;

    const texts = cells.map((cell) => SnorkelBot.normText(text(cell)));
    // The named column when the header gave one, and only then a scan — which
    // takes the first UUID in row order, so the Task ID column still wins.
    const uid =
      (cols.uid >= 0 ? firstUuid(texts[cols.uid]) : null) || texts.map(firstUuid).find(Boolean) || null;
    const anchor = tr.querySelector(REVISE_ANCHOR) || tr.querySelector('a[href*="/review"]');
    const href = anchor ? anchor.getAttribute('href') || '' : '';

    return {
      uid,
      texts,
      project: cols.project >= 0 ? ownText(cells[cols.project]) || texts[cols.project] : '',
      projectFull: cols.project >= 0 ? texts[cols.project] : '',
      anchor,
      href,
      /*
       * Who the row belongs to.
       *
       * NOT the platform's markup — a separate script annotates each row from
       * the shared sheet, which is where `.snorkel-card-owner` comes from. It is
       * the only way to tell a submission of ours from somebody else's when the
       * task is not in the database, so an absent one means "unknown owner", and
       * the server treats unknown as "leave it alone" rather than as a match.
       */
      owner: SnorkelBot.normText(text(tr.querySelector('.snorkel-card-owner'))) || null,
      title:
        (tr.querySelector('.snorkel-card-task') &&
          SnorkelBot.normText(tr.querySelector('.snorkel-card-task').getAttribute('title') || '')) ||
        null,
      // The assignment id, kept because it is what the platform's own URL uses
      // and what any support conversation about a stuck row will quote.
      assignmentId: (href.match(/assignmentId=([0-9a-f-]{36})/i) || [])[1] || null,
      due: cols.due >= 0 ? texts[cols.due] : texts[2] || null,
    };
  }

  /**
   * Does this row belong to the project we are working?
   *
   * The project cell's own text is the name exactly, so that is an equality
   * test. The prefix test on the whole cell is the fallback for a row with no
   * annotation block, where the two are the same string — anchored at the start
   * rather than merely contained, because a submission's title routinely
   * mentions another project.
   */
  function belongsTo(row, projectKey) {
    const key = SnorkelBot.normText(projectKey).toLowerCase();
    if (!key) return false;
    if (row.project && row.project.toLowerCase() === key) return true;

    const candidates = row.projectFull ? [row.projectFull] : row.texts;
    return candidates.some((cell) => {
      const value = SnorkelBot.normText(cell).toLowerCase();
      return value === key || value.startsWith(key);
    });
  }

  const rowsFor = (projectKey) => {
    const table = document.querySelector(REVISION_TABLE);
    if (!table) return [];
    const cols = columnsOf(table);
    return Array.from(table.querySelectorAll('tbody tr'))
      .map((tr) => rowInfo(tr, cols))
      .filter((row) => row && row.uid && belongsTo(row, projectKey));
  };

  /** The button inside the row's link; React binds to it, not to the anchor. */
  const clickTarget = (anchor) => (anchor && anchor.querySelector('button')) || anchor;

  const tableRows = () => document.querySelectorAll(`${REVISION_TABLE} tbody tr`).length;

  /**
   * How many the page says there are: "You have 8 tasks that require revision".
   *
   * The banner is the only honest total. The table shows a first page and hides
   * the rest behind a "Show more", so counting rows answers "how many are on
   * screen", which is a different question — and the difference is silent.
   */
  function statedTotal() {
    const banner = document.querySelector(ATTENTION_BANNER);
    if (!banner) return null;
    const match = SnorkelBot.normText(text(banner)).match(/\b(\d+)\s+tasks?\b/i);
    return match ? Number(match[1]) : null;
  }

  /**
   * Opens the rest of the list, however many pages deep it goes.
   *
   * Driven by the banner's count rather than by finding the button: the button
   * only exists when the list is long enough to need it, so its absence proves
   * nothing, whereas "the banner says 23 and I can see 10" is unambiguous.
   * Clicking continues while the rows grow, so a control that adds a page at a
   * time works the same as one that reveals everything at once.
   */
  async function expandRevisionTable({ timeout = 20000 } = {}) {
    const wanted = statedTotal();
    let clicks = 0;

    for (let i = 0; i < 20; i++) {
      const before = tableRows();
      if (wanted != null && before >= wanted) break;

      const table = document.querySelector(REVISION_TABLE);
      if (!table) break;

      /*
       * The page names this control, so take it by name. The text search below
       * is the fallback for when it is renamed — searched from the table
       * upwards so it belongs to this list rather than some other section, and
       * never from inside the table, where "Revise task" lives.
       */
      let button = document.querySelector(SHOW_MORE);
      let host = table.parentElement;
      for (let up = 0; up < 4 && host && !button; up++) {
        button = Array.from(host.querySelectorAll('button')).find(
          (b) => !table.contains(b) && MORE_BUTTON.test(SnorkelBot.normText(text(b)))
        );
        host = host.parentElement;
      }
      if (!button || button.disabled) break;

      SnorkelBot.click(button);
      clicks++;

      // Rows are fetched, so they arrive a moment after the click.
      const deadline = Date.now() + Math.min(timeout, 8000);
      while (Date.now() < deadline && tableRows() === before) await SnorkelBot.sleep(300);
      if (tableRows() === before) break; // clicked, nothing came — stop asking
    }

    return { clicks, rows: tableRows(), expected: wanted };
  }

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

    // Everything past the first page is behind "Show more" — without this the
    // sweep silently reports only what happened to fit on screen.
    const expansion = appeared ? await expandRevisionTable() : { clicks: 0, rows: 0, expected: null };

    const rows = rowsFor(projectKey);
    const allRows = tableRows();

    return {
      revisions: rows.map((row) => ({
        uid: row.uid,
        href: row.href,
        assignmentId: row.assignmentId,
        due: row.due,
        owner: row.owner,
        title: row.title || row.uid,
      })),
      count: rows.length,
      // `cards` keeps the old name the server logs. It tells "nothing to revise"
      // apart from "the page never rendered", and now also apart from "the table
      // is full of another project's work".
      cards: allRows,
      rendered: Boolean(appeared),
      // What the banner claims, so a list that would not open all the way is
      // visible as a number rather than as a quietly short answer.
      expected: expansion.expected,
      expanded: expansion.clicks,
      truncated: expansion.expected != null && allRows < expansion.expected,
    };
  });

  /** Opens one submission's review page from its row in the table. */
  SnorkelBot.on('CLICK_REVISE', async (msg) => {
    const projectKey = msg.projectKey || 'CDG_Sentinel_Ultra_00000';
    const wanted = String(msg.uid || '').toLowerCase();
    assertSignedIn();

    /*
     * Open the whole list first. A task on the second page has no row to click,
     * and the failure reads exactly like a task that has been taken off the
     * list — which is a different thing entirely.
     */
    await SnorkelBot.waitFor(() => tableRows() || null, { timeout: 30000, interval: 400 }).catch(() => 0);
    await expandRevisionTable();

    /*
     * A task can be finished and ready to hand in without having a row here.
     * The list holds what the platform is currently offering, and a submission
     * it has not put back yet — or has moved elsewhere — simply is not on it.
     *
     * That is a "not now", not a fault: the work is done and waiting, and the
     * row usually turns up on a later sweep. It gets its own code so the server
     * can leave this task for later and spend the sweep on another one, rather
     * than trying the same absent row every few minutes.
     */
    const row = await SnorkelBot.waitFor(
      () => rowsFor(projectKey).find((r) => (r.uid || '').toLowerCase() === wanted) || null,
      { timeout: msg.timeout || 90000, label: `a "Revise task" row for ${msg.uid}` }
    ).catch(() => null);

    if (!row) {
      const listed = rowsFor(projectKey).length;
      const failure = new Error(
        `${msg.uid} is not in the revise list (${listed} row(s) there now) — nothing to open.`
      );
      failure.code = 'ROW_NOT_LISTED';
      throw failure;
    }

    if (!row.anchor) {
      const failure = new Error(`The row for ${msg.uid} has no "Revise task" link to follow.`);
      failure.code = 'ROW_NOT_LISTED';
      throw failure;
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
    revisions: (() => {
      const table = document.querySelector(REVISION_TABLE);
      if (!table) return [];
      const cols = columnsOf(table);
      return Array.from(table.querySelectorAll('tbody tr'))
        .map((tr) => rowInfo(tr, cols))
        .filter(Boolean)
        .map((row) => ({ uid: row.uid, project: row.project || null, href: row.href }));
    })(),
  }));
})();
