/*
 * What happens to a task whose checks passed but whose form did not go in.
 *
 * "static checks pass" is written the moment the platform's checks come back
 * clean, before anything knows whether Submit was pressed. It is the right
 * status for a form filled and left for a person — and the wrong one for a
 * submission that was meant to happen, because nothing sweeps it: the submit
 * sweep looks for "ready to submit" and nothing else. A task that lands there
 * silently stops, checked and filled and never handed in.
 */

import assert from 'node:assert/strict';

let failures = 0;

function check(what, fn) {
  try {
    fn();
    console.log('PASS ', what);
  } catch (err) {
    failures++;
    console.log('FAIL ', what);
    console.log('      ', err.message);
  }
}

const MAX_SUBMIT_ATTEMPTS = 3;

/**
 * The decision the sweep makes after a passing run, as index.js makes it.
 * Returns what happens to the task.
 */
function outcome({ maySubmit, form, attemptsSoFar = 0 }) {
  if (!form) return 'left as static checks pass';
  if (form.submitted) return 'sent';
  if (!maySubmit) return 'left as static checks pass';

  const attempts = attemptsSoFar + 1;
  if (form.blockers?.length) return 'left as static checks pass';
  if (attempts < MAX_SUBMIT_ATTEMPTS) return 'back to ready to submit';
  return 'left as static checks pass';
}

check('a submitted form ends as sent', () => {
  assert.equal(outcome({ maySubmit: true, form: { submitted: true } }), 'sent');
});

check('auto-submit off leaves it for a person, as it always did', () => {
  // Nothing was meant to be clicked; "waiting for you" is exactly true.
  assert.equal(
    outcome({ maySubmit: false, form: { submitted: false, skipped: [] } }),
    'left as static checks pass'
  );
});

check('a click that did not land is tried again', () => {
  // No Submit button, a click that did not take, a run that died on the way —
  // about the page, not about the submission.
  const form = { submitted: false, blockers: [], skipped: ['submit (no Submit button found)'] };
  assert.equal(outcome({ maySubmit: true, form }), 'back to ready to submit');
});

check('and only a few times, because each try is a whole run', () => {
  const form = { submitted: false, blockers: [], skipped: ['submit (no Submit button found)'] };
  assert.equal(outcome({ maySubmit: true, form, attemptsSoFar: 1 }), 'back to ready to submit');
  assert.equal(outcome({ maySubmit: true, form, attemptsSoFar: 2 }), 'left as static checks pass');
  assert.equal(outcome({ maySubmit: true, form, attemptsSoFar: 9 }), 'left as static checks pass');
});

check('a missing answer is not retried at all', () => {
  // Clicking Submit again would fail the same way. This one needs an answer,
  // which is a person's job or the next round's.
  const form = {
    submitted: false,
    blockers: ['comments_for_reviewer'],
    skipped: ['submit (not handed in — comments_for_reviewer still unanswered)'],
  };
  assert.equal(outcome({ maySubmit: true, form }), 'left as static checks pass');
  assert.equal(outcome({ maySubmit: true, form, attemptsSoFar: 0 }), 'left as static checks pass');
});

check('the daily cap still parks a new task rather than retrying it', () => {
  // maySubmit is false at the cap, so the form is filled and left — retrying
  // would spend the same minutes to be refused by the same rule.
  assert.equal(
    outcome({ maySubmit: false, form: { submitted: false, blockers: [] } }),
    'left as static checks pass'
  );
});

console.log(failures ? `\n${failures} outcome check(s) failed` : '\nthe submit outcome holds');
process.exit(failures ? 1 : 0);
