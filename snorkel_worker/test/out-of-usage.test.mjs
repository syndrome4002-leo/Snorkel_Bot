/*
 * Telling "the subscription is spent" apart from "this task went wrong".
 *
 * The first means stop taking work until it resets; the second means this task
 * failed and the next one may well be fine. Confusing them is expensive in both
 * directions — one way the worker retries a hopeless task every thirty seconds
 * all night, the other way it sits idle over a fault it could have skipped past.
 */

import assert from 'node:assert/strict';
import { outOfUsage } from '../src/usage.js';

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

check('the message that caused the retry storm', () => {
  assert.equal(
    outOfUsage("Claude reported an error: You're out of extra usage · resets 5:10am (Europe/Berlin)"),
    true
  );
});

check('the same thing without the "extra"', () => {
  assert.equal(outOfUsage("You're out of usage · resets 9pm"), true);
});

check('the other wordings for a spent subscription', () => {
  assert.equal(outOfUsage('Usage limit reached'), true);
  assert.equal(outOfUsage('You have reached your usage limit for this period'), true);
  assert.equal(outOfUsage('5-hour limit reached · resets 3:00am'), true);
});

check('an ordinary task failure is not a reason to stop everything', () => {
  assert.equal(outOfUsage('Tests failed: 3 of 41 assertions'), false);
  assert.equal(outOfUsage('could not resume session 768fdaac — starting a fresh session'), false);
  assert.equal(outOfUsage('ENOENT: no such file or directory'), false);
});

check('a task that merely mentions usage is not the subscription running out', () => {
  // A task about, say, memory usage limits should not stop the worker.
  assert.equal(outOfUsage('the README documents the usage of the limit flag'), false);
  assert.equal(outOfUsage('assertion failed: expected usage to be within limits'), false);
});

check('nothing at all is not out of usage', () => {
  assert.equal(outOfUsage(''), false);
  assert.equal(outOfUsage(null), false);
  assert.equal(outOfUsage(undefined), false);
});

console.log(failures ? `\n${failures} out-of-usage check(s) failed` : '\nthe out-of-usage check holds');
process.exit(failures ? 1 : 0);
