/*
 * Asking for a new task on a timer, not only when something changes.
 *
 * Every other path that starts a task is a reaction: a revise count arriving, a
 * backoff expiring. Both are real signals, and between them are stretches where
 * the platform has work and this machine has room and nothing asks, because
 * nothing changed on our side.
 *
 * The sweep only makes the question get asked. maybeAutoStart still does all the
 * deciding, so the danger is not that it starts too much — it cannot — but that
 * it fires when there is nothing sensible to ask with, or that switching it off
 * leaves a timer running.
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

/** What scheduleStartSweep decides, given a setting. */
function schedule(value) {
  const n = Number(value);
  const every = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  return { running: every > 0, everyMs: every * 60000 };
}

/** Whether a firing actually asks. */
const asks = (lastReviseCount) => lastReviseCount !== null;

check('a number turns the timer on', () => {
  assert.deepEqual(schedule(10), { running: true, everyMs: 600000 });
});

check('0 and blank leave it off', () => {
  for (const off of [0, '', null, undefined, 'off']) {
    assert.equal(schedule(off).running, false, String(off));
  }
});

check('a negative or nonsense value is off, not an interval of zero', () => {
  /*
   * setInterval(fn, 0) is a busy loop that would ask the platform for a task as
   * fast as the event loop turns. Refusing is the only safe reading.
   */
  assert.equal(schedule(-5).running, false);
  assert.equal(schedule('soon').running, false);
});

check('a firing with no revise count yet asks nothing', () => {
  // The extension has not reported since startup. The revise limit is the main
  // guard on starting anything, and it cannot be applied to a count nobody has.
  assert.equal(asks(null), false);
});

check('a firing with a known count asks', () => {
  assert.equal(asks(0), true, 'zero awaiting revision is a count, not an absence');
  assert.equal(asks(7), true);
});

console.log(failures ? `\n${failures} start-sweep check(s) failed` : '\nthe start sweep asks on time');
process.exit(failures ? 1 : 0);
