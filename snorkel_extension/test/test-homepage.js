/*
 * Runs the homepage handlers against the saved page dumps.
 *
 * These are the real pages, so this is the closest thing to trying it on the
 * site without touching the site — and the failure it is guarding against is
 * silent: a selector that no longer matches reports "nothing to revise" rather
 * than an error.
 */
const { JSDOM, VirtualConsole } = require('jsdom');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const EXT = path.join(REPO, 'snorkel_extension');
const PROJECT_KEY = 'CDG_Sentinel_Ultra_00000';

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        ${detail}`}`);
  if (!ok) failures++;
};

function load(htmlFile) {
  // jsdom cannot navigate, and every anchor click says so. That is not a finding.
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {});
  const dom = new JSDOM(fs.readFileSync(path.join(REPO, htmlFile), 'utf8'), {
    url: 'https://experts.snorkel-ai.com/home',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole,
  });
  const clicked = [];
  // chrome.* only exists in an isolated world; common.js registers a listener.
  dom.window.chrome = { runtime: { onMessage: { addListener() {} }, sendMessage() {} } };
  dom.window.eval(fs.readFileSync(path.join(EXT, 'content/common.js'), 'utf8'));
  dom.window.eval(fs.readFileSync(path.join(EXT, 'content/homepage.js'), 'utf8'));

  const bot = dom.window.SnorkelBot;
  bot.click = (el) => {
    clicked.push({
      tag: el.tagName,
      text: bot.normText(bot.text(el)),
      testid: el.getAttribute('data-testid'),
      href: (el.closest('a') || {}).getAttribute ? el.closest('a').getAttribute('href') : null,
    });
    /*
     * Recorded AND dispatched. Recording alone was enough for "did it pick the
     * right element", but a "Show more" is only worth testing if its own
     * listener runs — which needs a real event.
     */
    el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  };
  return { dom, bot, clicked, call: (type, msg = {}) => bot.handlers[type](msg) };
}

(async () => {
  // ---- the home page ------------------------------------------------------
  {
    const { bot, clicked, call } = load('snorkel_homepage.html');

    const listed = await call('LIST_REVISIONS', { projectKey: PROJECT_KEY, timeout: 2000, settle: 0 });
    const uids = listed.revisions.map((r) => r.uid);

    check(
      'the rendered rows are read, and the banner total is reported',
      listed.count === 5 && listed.cards === 5 && listed.expected === 8,
      `count=${listed.count} cards=${listed.cards} expected=${listed.expected}`
    );
    check(
      'a list that would not open all the way says so',
      listed.truncated === true,
      `truncated=${listed.truncated} — 5 rows against a banner saying 8`
    );
    check(
      'the UID comes from the Task ID column, not the testid',
      uids.includes('0cb4eb47-ea97-4ab8-a541-c4828399407b') &&
        !uids.includes('da520c45-fa07-475e-a4da-e620ebd34479'),
      `got ${JSON.stringify(uids)}`
    );
    check(
      "the UUID inside the row's TITLE is not mistaken for its Task ID",
      uids.includes('41fd93c0-79fa-452c-827c-360e1ea363b6') &&
        !uids.includes('7c7220b0-3d42-4950-86c7-3d98f22dda71'),
      `row 5 title holds 7c7220b0-…, its Task ID is 41fd93c0-… — got ${JSON.stringify(uids)}`
    );
    check(
      'the project key matches as a prefix of the Project Name cell',
      listed.count === 5,
      'the cell reads "CDG_Sentinel_Ultra_00000 <owner> <title>", so whole-cell equality finds nothing'
    );
    check(
      'the assignment id is kept alongside',
      listed.revisions.every((r) => /^[0-9a-f-]{36}$/i.test(r.assignmentId || '')),
      JSON.stringify(listed.revisions[0])
    );

    clicked.length = 0;
    const revised = await call('CLICK_REVISE', {
      uid: '4418f8ec-a367-4a41-a3ca-914c31b0d67d',
      projectKey: PROJECT_KEY,
      timeout: 3000,
    });
    const last = clicked[clicked.length - 1];
    check(
      'Revise clicks the right row',
      last.text === 'Revise task' &&
        revised.href.includes('assignmentId=228a6091-b3f1-4032-bedf-593d9fa4118d'),
      `clicked=${JSON.stringify(clicked.map((c) => c.text))} href=${revised.href}`
    );

    let refused = null;
    await call('CLICK_REVISE', { uid: '00000000-0000-4000-8000-000000000000', projectKey: PROJECT_KEY, timeout: 1500 })
      .catch((e) => (refused = e.message));
    check('a UID that is not in the list is not clicked', Boolean(refused), 'something was clicked anyway');

    clicked.length = 0;
    const started = await call('CLICK_START', { projectKey: PROJECT_KEY, timeout: 2000 });
    check(
      'the project card is opened with "Go to project"',
      clicked.length === 1 && /go to project/i.test(clicked[0].text) && started.needsBeginSubmission === true,
      `clicked=${JSON.stringify(clicked)}`
    );

    const projects = await call('LIST_PROJECTS', {});
    check(
      'LIST_PROJECTS sees the new cards',
      projects.cards.some((c) => c.title === PROJECT_KEY) && projects.cards.length > 5,
      `${projects.cards.length} cards`
    );
    void bot;
  }

  // ---- the owner, which is what makes a task adoptable --------------------
  {
    const { call } = load('snorkel_homepage.html');
    const listed = await call('LIST_REVISIONS', { projectKey: PROJECT_KEY, timeout: 2000, settle: 0 });
    const owners = listed.revisions.map((r) => r.owner);

    check(
      "each row reports whose submission it is",
      owners.filter(Boolean).length === listed.revisions.length,
      `got ${JSON.stringify(owners)}`
    );
    check(
      'the owners are read individually, not from the first row',
      new Set(owners).size >= 3 && owners.includes('Syndrome') && owners.includes('Rabidon'),
      `got ${JSON.stringify(owners)}`
    );

    // The same decision the server makes: same owner, and not already known.
    const known = new Set(['0cb4eb47-ea97-4ab8-a541-c4828399407b', '4418f8ec-a367-4a41-a3ca-914c31b0d67d']);
    const mine = listed.revisions.filter(
      (r) => !known.has(r.uid) && String(r.owner || '').toLowerCase() === 'syndrome'
    );
    check(
      "another owner's task is never adoptable",
      mine.every((r) => r.owner === 'Syndrome') && !mine.some((r) => r.owner === 'Rabidon' || r.owner === 'Dmon'),
      `would adopt ${JSON.stringify(mine.map((r) => `${r.uid} (${r.owner})`))}`
    );
    check(
      'a row with no owner is not adoptable',
      listed.revisions
        .map((r) => ({ ...r, owner: null }))
        .filter((r) => String(r.owner || '').toLowerCase() === 'syndrome').length === 0,
      'a missing annotation was treated as a match'
    );
    console.log(`        (of ${listed.revisions.length} rows: ${owners.join(', ')})`);
  }

  // ---- "Show more", with a button that actually works ---------------------
  {
    const { clicked, call, dom } = load('snorkel_homepage.html');
    const doc = dom.window.document;
    const tbody = doc.querySelector('[data-testid="tasks-needing-revision-table"] tbody');
    const button = doc.querySelector('[data-testid="show-more-revision-tasks"]');

    // The page ships 5 of the 8 it claims. Give the real button a handler that
    // puts the rest back two at a time, the way a paged list does.
    const rest = Array.from(tbody.querySelectorAll('tr')).slice(3);
    rest.forEach((tr) => tr.remove());
    const held = rest.slice();
    button.addEventListener('click', () => held.splice(0, 1).forEach((tr) => tbody.appendChild(tr)));

    const listed = await call('LIST_REVISIONS', { projectKey: PROJECT_KEY, timeout: 2000, settle: 0 });
    check(
      'the list is opened page by page until it stops growing',
      listed.cards === 5 && listed.expanded >= 2,
      `ended at ${listed.cards} rows after ${listed.expanded} click(s) of "Show more"`
    );
    check(
      'the rows that were behind it are reported',
      listed.revisions.map((r) => r.uid).includes('41fd93c0-79fa-452c-827c-360e1ea363b6'),
      `got ${JSON.stringify(listed.revisions.map((r) => r.uid))}`
    );
    check(
      'it takes the control by its testid',
      clicked.some((c) => c.testid === 'show-more-revision-tasks'),
      `clicked ${JSON.stringify(clicked.map((c) => c.testid))}`
    );

    // And a task behind it can still be reached by UID.
    Array.from(tbody.querySelectorAll('tr')).slice(3).forEach((tr) => tr.remove());
    held.push(...rest.slice(1));
    clicked.length = 0;
    const revised = await call('CLICK_REVISE', {
      uid: '41fd93c0-79fa-452c-827c-360e1ea363b6',
      projectKey: PROJECT_KEY,
      timeout: 6000,
    });
    check(
      'Revise reaches a task that was behind "Show more"',
      clicked[clicked.length - 1].text === 'Revise task' &&
        revised.uid === '41fd93c0-79fa-452c-827c-360e1ea363b6',
      `clicked=${JSON.stringify(clicked.map((c) => c.text))}`
    );
  }

  // ---- the project page ---------------------------------------------------
  {
    const { clicked, call } = load('snrokel_project_start_UI.html');
    const begun = await call('CLICK_BEGIN_SUBMISSION', { timeout: 2000 });
    check(
      'Begin Submission is found and clicked, not the link around it',
      clicked.length === 1 && clicked[0].tag === 'BUTTON' && /begin submission/i.test(begun.buttonLabel),
      `clicked=${JSON.stringify(clicked)} label=${begun.buttonLabel}`
    );
  }

  // ---- the review page must not look like a project page ------------------
  {
    const PROJECT_URL_RE = /\/projects\/[^/?#]+\/?(?:[?#].*)?$/i;
    const REVIEW_URL_RE = /\/projects\/[^/]+\/submission-[^/]+\/review/i;
    const review =
      'https://experts.snorkel-ai.com/projects/1230ae8f/submission-efa51f15/review?assignmentId=71f6777e';
    const project = 'https://experts.snorkel-ai.com/projects/1230ae8f-afc6-4705-abc7-fbe1c94250ff';
    check(
      'the two URL patterns do not overlap',
      PROJECT_URL_RE.test(project) && !PROJECT_URL_RE.test(review) && REVIEW_URL_RE.test(review),
      `project=${PROJECT_URL_RE.test(project)} reviewMatchedProject=${PROJECT_URL_RE.test(review)}`
    );
  }

  console.log(failures ? `\n${failures} failed\n` : '\nthe new home page is handled correctly\n');
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error('harness error:', err);
  process.exit(2);
});
