/*
 * Runs the homepage handlers against the saved page dumps.
 *
 * These are the real pages, so this is the closest thing to trying it on the
 * site without touching the site — and the failure it is guarding against is
 * silent: a selector that no longer matches reports "nothing to revise" rather
 * than an error.
 */
const { JSDOM } = require('jsdom');
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
  const dom = new JSDOM(fs.readFileSync(path.join(REPO, htmlFile), 'utf8'), {
    url: 'https://experts.snorkel-ai.com/home',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const clicked = [];
  // chrome.* only exists in an isolated world; common.js registers a listener.
  dom.window.chrome = { runtime: { onMessage: { addListener() {} }, sendMessage() {} } };
  dom.window.eval(fs.readFileSync(path.join(EXT, 'content/common.js'), 'utf8'));
  dom.window.eval(fs.readFileSync(path.join(EXT, 'content/homepage.js'), 'utf8'));

  const bot = dom.window.SnorkelBot;
  const realClick = bot.click;
  bot.click = (el) => {
    clicked.push({
      tag: el.tagName,
      text: bot.normText(bot.text(el)),
      testid: el.getAttribute('data-testid'),
      href: (el.closest('a') || {}).getAttribute ? el.closest('a').getAttribute('href') : null,
    });
    return realClick ? undefined : undefined;
  };
  return { dom, bot, clicked, call: (type, msg = {}) => bot.handlers[type](msg) };
}

(async () => {
  // ---- the home page ------------------------------------------------------
  {
    const { bot, clicked, call } = load('snorkel_homepage.html');

    const listed = await call('LIST_REVISIONS', { timeout: 2000, settle: 0 });
    const uids = listed.revisions.map((r) => r.uid);
    check(
      'the revise table is read, Sentinel rows only',
      listed.count === 4 && listed.cards === 8,
      `count=${listed.count} of ${listed.cards} rows: ${JSON.stringify(uids)}`
    );
    check(
      'the UID comes from the Task ID cell, not the testid',
      uids.includes('0cb4eb47-ea97-4ab8-a541-c4828399407b') &&
        uids.includes('4418f8ec-a367-4a41-a3ca-914c31b0d67d') &&
        !uids.includes('da520c45-fa07-475e-a4da-e620ebd34479'),
      `got ${JSON.stringify(uids)}`
    );
    check(
      "another project's rows are left alone",
      !uids.includes('0322c33f-3a9d-4d7a-ac05-964775e99915'),
      `Geranium row leaked: ${JSON.stringify(uids)}`
    );
    check(
      'the assignment id is kept alongside',
      listed.revisions.every((r) => /^[0-9a-f-]{36}$/i.test(r.assignmentId || '')),
      JSON.stringify(listed.revisions[0])
    );

    const revised = await call('CLICK_REVISE', {
      uid: '4418f8ec-a367-4a41-a3ca-914c31b0d67d',
      projectKey: PROJECT_KEY,
      timeout: 2000,
    });
    check(
      'Revise clicks the right row',
      clicked.length === 1 &&
        clicked[0].text === 'Revise task' &&
        revised.href.includes('assignmentId=228a6091-b3f1-4032-bedf-593d9fa4118d'),
      `clicked=${JSON.stringify(clicked)} href=${revised.href}`
    );

    let refused = null;
    await call('CLICK_REVISE', { uid: '0322c33f-3a9d-4d7a-ac05-964775e99915', projectKey: PROJECT_KEY, timeout: 1200 })
      .catch((e) => (refused = e.message));
    check('a row from another project is not clickable as ours', Boolean(refused), 'it was found anyway');

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
