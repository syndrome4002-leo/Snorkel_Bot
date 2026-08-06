/*
 * What happens when the platform answers a check button with an error instead
 * of a result.
 *
 * "Feedback API error" is the platform failing to run the check at all, which
 * looks the same from here as a check still running: no verdict panel. The
 * difference matters — a check that FAILED has an answer and clicking again
 * would only get the same one, while a check that never ran has no answer and
 * clicking again is the entire remedy.
 *
 * Run against the real review page, so the buttons, the field ids and the panel
 * markup are the platform's rather than something written to pass.
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
  window.eval(fs.readFileSync(path.join(EXT, 'content/common.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(EXT, 'content/submit.js'), 'utf8'));
  return window;
}

const STATIC_FIELD = '[data-testid="field-feedbackbutton-static_checks"]';

/** The button the check runs from, as the page has it. */
function checkButton(window) {
  const field = window.document.querySelector(STATIC_FIELD);
  return [...field.querySelectorAll('button')].find((b) =>
    /^check feedback$/i.test((b.textContent || '').trim())
  );
}

/**
 * Wires the button up to behave like the platform on a given run.
 *
 * `script` is one entry per click: 'error' puts the platform's message on the
 * page, 'pass' renders a verdict panel. Nothing else about the page changes,
 * which is the point — from the extension's side the two are told apart only by
 * what appears.
 */
function program(window, script) {
  const field = window.document.querySelector(STATIC_FIELD);
  const button = checkButton(window);
  let click = 0;

  button.addEventListener('click', () => {
    const step = script[click++];
    if (step === 'error') {
      const toast = window.document.createElement('div');
      toast.textContent = 'Feedback API error';
      window.document.body.appendChild(toast);
      return;
    }
    // A result arrives, and any error message from an earlier attempt goes.
    for (const el of [...window.document.body.querySelectorAll('div')]) {
      if ((el.textContent || '').trim() === 'Feedback API error') el.remove();
    }
    const panel = window.document.createElement('div');
    panel.className = 'rounded-md border-2 border-success';
    panel.textContent = 'PASS — all static checks succeeded';
    field.appendChild(panel);
  });

  return () => click;
}

(async () => {
  // ---- the platform errors once, then works ------------------------------
  {
    const window = load('sentinel_revise_UI.html');
    const clicks = program(window, ['error', 'pass']);

    const res = await window.SnorkelBot.handlers.SUBMIT_RUN_CHECKS({
      run_prescriptiveness: false,
      checkTimeout: 4000,
      check_retries: 3,
      // No real waiting: this is about what it does, not how long it waits.
      check_retry_wait_ms: 0,
    });

    const result = res.results[0];
    check('it clicks the button again after a platform error', clicks() === 2, `clicked ${clicks()} time(s)`);
    check('and reports the verdict from the run that worked', result.verdict === 'pass', JSON.stringify(result));
    check(
      'the error is kept on the record rather than passed over in silence',
      Array.isArray(result.platform_errors) && /feedback api error/i.test(result.platform_errors[0] || ''),
      JSON.stringify(result.platform_errors)
    );
    check('and the run is reported as passed overall', res.passed === true, JSON.stringify(res.passed));
  }

  // ---- it errors every time ----------------------------------------------
  {
    const window = load('sentinel_revise_UI.html');
    const clicks = program(window, ['error', 'error', 'error', 'error']);

    let message = '';
    try {
      await window.SnorkelBot.handlers.SUBMIT_RUN_CHECKS({
        run_prescriptiveness: false,
        checkTimeout: 4000,
        check_retries: 3,
        check_retry_wait_ms: 0,
      });
    } catch (err) {
      message = err.message;
    }

    check('it gives up after the number of attempts it was given', clicks() === 3, `clicked ${clicks()} time(s)`);
    check(
      'and says what the platform said, so it is not mistaken for a failed check',
      /feedback api error/i.test(message),
      message || '(no error thrown)'
    );
  }

  // ---- a check that genuinely fails is not retried ------------------------
  {
    /*
     * The important one. A failing task's build logs quote whatever its own
     * tests printed — on a task that talks to an API, that can include the very
     * words this looks for. Retrying there would run the check again to be told
     * the same thing, twice as slowly.
     */
    const window = load('sentinel_revise_UI.html');
    const field = window.document.querySelector(STATIC_FIELD);
    const button = checkButton(window);
    let clicks = 0;
    button.addEventListener('click', () => {
      clicks++;
      const panel = window.document.createElement('div');
      panel.className = 'rounded-md border-2 border-error';
      panel.textContent = 'FAIL — test_client.py: Feedback API error while calling the fixture';
      field.appendChild(panel);
    });

    const res = await window.SnorkelBot.handlers.SUBMIT_RUN_CHECKS({
      run_prescriptiveness: false,
      checkTimeout: 4000,
      check_retries: 3,
      check_retry_wait_ms: 0,
    });

    check('a real FAIL is reported once, not retried', clicks === 1, `clicked ${clicks} time(s)`);
    check('and it is still a fail', res.results[0].verdict === 'fail', JSON.stringify(res.results[0].verdict));
  }

  console.log(failures ? `\n${failures} failed` : '\nthe check retry holds');
  process.exit(failures ? 1 : 0);
})();
