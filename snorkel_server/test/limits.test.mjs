/*
 * What the daily cap means.
 *
 * Empty is no limit; 0 is none. Those are different answers and the field had
 * been giving the same one to both — so setting "new tasks per day" to 0 to stop
 * new tasks turned the limit off and the bot carried on starting them.
 */

import assert from 'node:assert/strict';
import { dailySubmitLimit } from '../src/limits.js';

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

check('zero means no new tasks today', () => {
  assert.equal(dailySubmitLimit(0), 0);
  assert.equal(dailySubmitLimit('0'), 0);
});

check('empty means no limit', () => {
  // Never set, rather than set to nothing. A system that stopped working
  // because nobody filled in a box would be a poor default.
  assert.equal(dailySubmitLimit(''), null);
  assert.equal(dailySubmitLimit(null), null);
  assert.equal(dailySubmitLimit(undefined), null);
});

check('a number is that number', () => {
  assert.equal(dailySubmitLimit(3), 3);
  assert.equal(dailySubmitLimit('5'), 5);
});

check('a fraction is rounded down rather than refused', () => {
  assert.equal(dailySubmitLimit(2.7), 2);
});

check('something unreadable is treated as unset, not as zero', () => {
  // The alternative is a typo silently stopping the day's work.
  assert.equal(dailySubmitLimit('three'), null);
  assert.equal(dailySubmitLimit({}), null);
});

check('a negative number is not a negative cap', () => {
  assert.equal(dailySubmitLimit(-1), null);
});

console.log(failures ? `\n${failures} limit check(s) failed` : '\nthe daily limit holds');
process.exit(failures ? 1 : 0);
