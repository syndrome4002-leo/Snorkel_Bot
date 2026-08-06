/*
 * What the daily cap means.
 *
 * Empty is no limit; 0 is none. Those are different answers and the field had
 * been giving the same one to both — so setting "new tasks per day" to 0 to stop
 * new tasks turned the limit off and the bot carried on starting them.
 */

import assert from 'node:assert/strict';
import { dailySubmitLimit, revisionCheckLateBy } from '../src/limits.js';

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

const MIN = 60000;
const at = (isoOffsetMin) => new Date(Date.UTC(2026, 7, 6, 12, 0, 0) + isoOffsetMin * MIN).toISOString();
const NOW = Date.UTC(2026, 7, 6, 12, 0, 0);

check('a check due in the future is not late', () => {
  assert.equal(revisionCheckLateBy({ next_check_at: at(4), checked_at: at(-1) }, 5, NOW), 0);
});

check('a check due a minute ago is still inside its grace', () => {
  // The browser's alarm is allowed to be a little late before the server steps
  // in — otherwise the two race each other every time.
  assert.equal(revisionCheckLateBy({ next_check_at: at(-0.5), checked_at: at(-5) }, 5, NOW), 0);
});

check('the 43-minute case is late, and by how much', () => {
  const late = revisionCheckLateBy({ next_check_at: at(-38), checked_at: at(-43) }, 5, NOW);
  assert.equal(Math.round(late / MIN), 37, 'late by the overdue time, less the grace');
});

check('a check that has just happened is never late', () => {
  // The case that made it check every minute: the server asks for a check, the
  // extension reports when it read the list and nothing about its alarm, so the
  // old — now past — next time is kept and reads as overdue straight away.
  const justNow = { next_check_at: at(-38), checked_at: at(-0.2) };
  assert.equal(revisionCheckLateBy(justNow, 5, NOW), 0);
});

check('and it becomes late again once the interval is up', () => {
  const stale = { next_check_at: at(-38), checked_at: at(-7) };
  assert.ok(revisionCheckLateBy(stale, 5, NOW) > 0, 'seven minutes on a five-minute interval');
});

check('a report with no next time falls back to the interval', () => {
  // Late: last checked 20 minutes ago on a 5-minute interval.
  assert.ok(revisionCheckLateBy({ checked_at: at(-20) }, 5, NOW) > 0);
  // Not late: checked 2 minutes ago.
  assert.equal(revisionCheckLateBy({ checked_at: at(-2) }, 5, NOW), 0);
});

check('a longer interval is respected', () => {
  assert.equal(revisionCheckLateBy({ checked_at: at(-20) }, 30, NOW), 0);
});

check('no report at all is not "late"', () => {
  // The extension has never reported. That is a different problem, with its own
  // message — asking for a count here would say the wrong thing about it.
  assert.equal(revisionCheckLateBy(null, 5, NOW), 0);
  assert.equal(revisionCheckLateBy({}, 5, NOW), 0);
});

check('an unreadable timestamp does not read as infinitely late', () => {
  assert.equal(revisionCheckLateBy({ next_check_at: 'soon' }, 5, NOW), 0);
});

console.log(failures ? `\n${failures} limit check(s) failed` : '\nthe limits hold');
process.exit(failures ? 1 : 0);
