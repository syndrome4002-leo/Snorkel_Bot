/*
 * The form a task gets when its verdict ends it, run against the real pages.
 *
 * unfixable.html and valid-as-is.html are the same task with the validity
 * answer set differently, which is the whole point: the platform drops the
 * upload field, both check buttons, the confirmation checklist and two of the
 * four time fields the moment the answer stops being "fixable". A filler built
 * for the fixable form finds none of what it expects and half of what it does
 * find belongs to a different question.
 */
const { JSDOM, VirtualConsole } = require('jsdom');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const EXT = path.join(__dirname, '..');

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        ${detail}`}`);
  if (!ok) failures++;
};

function load(file) {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {});
  const dom = new JSDOM(fs.readFileSync(path.join(REPO, file), 'utf8'), {
    url: 'https://experts.snorkel-ai.com/projects/x/submission-y/review',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole,
  });
  const { window } = dom;
  window.chrome = { runtime: { onMessage: { addListener() {} } } };
  window.Element.prototype.scrollIntoView = function scrollIntoView() {};

  /*
   * jsdom has no execCommand, which is how the rich-text fields are written to
   * in a real browser. Stubbed to write into the focused contenteditable, which
   * is what insertText does.
   */
  window.document.execCommand = (command, _ui, value) => {
    const target = window.document.activeElement;
    if (!target || target.getAttribute('contenteditable') !== 'true') return false;
    if (command === 'selectAll') return true;
    if (command === 'insertText') {
      target.textContent = value;
      return true;
    }
    return false;
  };

  /*
   * The saved pages are static: their radios do not respond to a click. Wire up
   * the behaviour the real page has, so choosing a verdict actually takes.
   */
  for (const group of window.document.querySelectorAll('[role="radiogroup"], [data-testid^="field-"]')) {
    const radios = [...group.querySelectorAll('button[role="radio"]')];
    if (radios.length < 2) continue;
    for (const radio of radios) {
      radio.addEventListener('click', () => {
        for (const other of radios) other.setAttribute('aria-checked', other === radio ? 'true' : 'false');
      });
    }
  }
  for (const box of window.document.querySelectorAll('[role="checkbox"]')) {
    box.addEventListener('click', () =>
      box.setAttribute('aria-checked', box.getAttribute('aria-checked') === 'true' ? 'false' : 'true')
    );
  }

  window.eval(fs.readFileSync(path.join(EXT, 'content/common.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(EXT, 'content/submit.js'), 'utf8'));
  return window;
}

const chosen = (window, testid) => {
  const field = window.document.querySelector(`[data-testid="${testid}"]`);
  if (!field) return null;
  const hit = [...field.querySelectorAll('button[role="radio"]')].find(
    (b) => b.getAttribute('aria-checked') === 'true'
  );
  return hit ? hit.getAttribute('value') : null;
};

const ANSWERS = {
  validity_required: 'invalid',
  // This form's own options, not the fixable questionnaire's — see the schema.
  what_issues_found: ['Environment Issues'],
  environment_issue_specifics: ['Oracle timeout'],
  why_unfixable:
    'instruction.md asks for a retry policy the tests never exercise, and the oracle implements a different one.',
  what_makes_difficult: 'The retry budget interacts with the dispatcher in a way that is easy to miss.',
  comments_for_reviewer: 'The PR scope cannot be changed without rewriting the oracle, so this cannot be fixed.',
  senior_estimated_time: '20-40 minutes',
};

const TIMES = { review: 41, complete: 73 };

(async () => {
  // ---- unfixable ----------------------------------------------------------
  {
    const window = load('unfixable.html');
    const res = await window.SnorkelBot.handlers.SUBMIT_VERDICT_FORM({
      verdict: 'invalid',
      answers: ANSWERS,
      times: TIMES,
      pace_scale: 0.01,
    });

    check(
      'both validity questions are set to Invalid',
      chosen(window, 'field-multidimensionradio-segments-valid') === 'Invalid' &&
        chosen(window, 'field-radio-ec-valid') === 'Invalid',
      `segments=${chosen(window, 'field-multidimensionradio-segments-valid')} ec=${chosen(window, 'field-radio-ec-valid')}`
    );

    const doc = window.document;
    const why = doc.querySelector(
      '[data-testid="field-textarea-please_explain_in_more_detail_why_this_task_is_unfixable"] textarea'
    );
    check(
      'the "why is it unfixable" explanation is written',
      why && why.value.includes('retry policy'),
      `got ${JSON.stringify(why && why.value.slice(0, 60))}`
    );

    const times = [...doc.querySelectorAll('[data-testid^="field-numeric-"] input')].map((i) => i.value);
    check(
      'both time fields are filled with the numbers sent',
      times.includes('41') && times.includes('73'),
      `got ${JSON.stringify(times)}`
    );

    check(
      'the senior estimate is chosen',
      chosen(window, 'field-radio-sr-engineer-aht') !== null,
      'no option selected'
    );

    /*
     * Every field the unfixable form has must be filled. An earlier version of
     * this only looked for "not on this page", which let three fields be
     * skipped for other reasons and still passed.
     */
    for (const key of [
      'validity_required',
      'duplicate',
      'what_issues_found',
      'environment_issue_specifics',
      'why_unfixable',
      'what_makes_difficult',
      'comments_for_reviewer',
      'senior_estimated_time',
    ]) {
      check(
        `${key} is filled`,
        res.filled.some((f) => f.startsWith(key)),
        `skipped: ${JSON.stringify(res.skipped.filter((sk) => sk.startsWith(key)))}`
      );
    }

    /*
     * The same question, answered with the OTHER form's vocabulary.
     *
     * This is what a task looked like before the schema knew that the unfixable
     * form asks with its own two options: seven categories about instructions
     * and tests, none of which is on this page. It must still be refused rather
     * than guessed at — fillMulti unticks as well as ticks, so a guess would
     * clear the question instead of leaving it short — and the report must name
     * what the page offered, or nobody can tell a wrong answer from a renamed
     * option.
     */
    {
      const window = load('unfixable.html');
      const res = await window.SnorkelBot.handlers.SUBMIT_VERDICT_FORM({
        verdict: 'invalid',
        answers: { ...ANSWERS, what_issues_found: ['the instructions are overly-prescriptive'] },
        times: TIMES,
      });
      const said = res.skipped.find((sk) => sk.startsWith('what_issues_found')) || '';
      check(
        'the fixable form’s categories are refused here, not guessed at',
        !res.filled.some((f) => f.startsWith('what_issues_found')) && /matched the options/.test(said),
        `filled=${JSON.stringify(res.filled)} skipped=${JSON.stringify(res.skipped)}`
      );
      check(
        'and the report says what the page did offer',
        /offered:.*PR scope needs to be changed or reduced/.test(said) &&
          /Environment Issues/.test(said),
        said || '(nothing reported)'
      );
    }

    check(
      'it does not submit unless asked',
      res.submitted === false,
      'the form was handed in without auto_submit'
    );
    console.log(`        filled: ${res.filled.join(', ')}`);
  }

  /*
   * A form with a required question left blank is filled, and not handed in.
   *
   * The platform validates on submit rather than by disabling the button, so
   * pressing it produces a rejection and a half-filled form — the run spent and
   * the task still needing somebody. Not submitting leaves the same form, with
   * everything it is missing written down next to it.
   */
  {
    const window = load('unfixable.html');
    const short = { ...ANSWERS };
    delete short.comments_for_reviewer;
    const res = await window.SnorkelBot.handlers.SUBMIT_VERDICT_FORM({
      verdict: 'invalid',
      answers: short,
      times: TIMES,
      auto_submit: true,
    });

    check(
      'a required answer missing means the form is not handed in',
      res.submitted === false && res.blockers.includes('comments_for_reviewer'),
      `submitted=${res.submitted} blockers=${JSON.stringify(res.blockers)}`
    );
    check(
      'and everything there is an answer for is still filled',
      res.filled.some((f) => f.startsWith('validity_required')) &&
        res.filled.some((f) => f.startsWith('what_issues_found')),
      `filled=${JSON.stringify(res.filled)}`
    );
    check(
      'the refusal says so rather than going quiet',
      res.skipped.some((sk) => sk.startsWith('submit (not handed in')),
      JSON.stringify(res.skipped)
    );
  }

  /*
   * An optional question left blank is not a reason to hold a form back. "If
   * Environment Issues was selected above" does not apply unless it was.
   */
  {
    const window = load('unfixable.html');
    const noFollowUp = { ...ANSWERS, what_issues_found: ['PR scope needs to be changed or reduced'] };
    delete noFollowUp.environment_issue_specifics;
    const res = await window.SnorkelBot.handlers.SUBMIT_VERDICT_FORM({
      verdict: 'invalid',
      answers: noFollowUp,
      times: TIMES,
      auto_submit: true,
    });

    check(
      'an optional question left blank does not hold the form back',
      res.blockers.length === 0,
      `blockers=${JSON.stringify(res.blockers)} skipped=${JSON.stringify(res.skipped)}`
    );
  }

  // ---- valid-as-is --------------------------------------------------------
  {
    const window = load('valid-as-is.html');
    const res = await window.SnorkelBot.handlers.SUBMIT_VERDICT_FORM({
      verdict: 'valid-as-is',
      answers: { ...ANSWERS, validity_required: 'valid-as-is' },
      times: TIMES,
      pace_scale: 0.01,
    });

    check(
      'both validity questions are set to Valid-as-is',
      chosen(window, 'field-multidimensionradio-segments-valid') === 'Valid-as-is' &&
        chosen(window, 'field-radio-ec-valid') === 'Valid-as-is',
      `segments=${chosen(window, 'field-multidimensionradio-segments-valid')} ec=${chosen(window, 'field-radio-ec-valid')}`
    );

    check(
      'the unfixable-only questions are not asked for',
      !res.filled.some((f) => /why_unfixable|what_issues_found/.test(f)) &&
        !res.skipped.some((sk) => /why_unfixable|what_issues_found/.test(sk)),
      `filled=${JSON.stringify(res.filled)} skipped=${JSON.stringify(res.skipped)}`
    );

    const times = [...window.document.querySelectorAll('[data-testid^="field-numeric-"] input')].map((i) => i.value);
    check('both time fields are filled', times.includes('41') && times.includes('73'), JSON.stringify(times));
    console.log(`        filled: ${res.filled.join(', ')}`);
  }

  // ---- and it refuses a verdict it does not know --------------------------
  {
    const window = load('valid-as-is.html');
    let refused = null;
    await window.SnorkelBot.handlers
      .SUBMIT_VERDICT_FORM({ verdict: 'fixable', answers: {}, times: {} })
      .catch((err) => (refused = err.message));
    check(
      'a fixable task is refused by this handler',
      Boolean(refused),
      'it tried to fill a verdict form for a fixable task'
    );
  }

  console.log(failures ? `\n${failures} failed\n` : '\nthe verdict form holds\n');
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error('harness error:', err);
  process.exit(2);
});
