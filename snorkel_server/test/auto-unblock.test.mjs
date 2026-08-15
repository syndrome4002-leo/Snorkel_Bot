/*
 * A backoff must not outlive its reason.
 *
 * Snorkel hands out nothing while too many of this account's submissions are
 * awaiting review, so "handed out no task" and "the revise list is full" are
 * usually the same fact wearing different clothes. Backing off for five minutes
 * is right while that stays true — asking again immediately gets the same
 * answer — and wrong the moment it stops.
 *
 * The count dropping below the limit is exactly the event that changes the
 * answer. Waiting out the timer after that is waiting for nothing, which is
 * what it did: room on the list, a task ready to start, and five minutes spent
 * doing neither.
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

/*
 * The decision made when a revise report lands, in the shape the server makes
 * it: does this report clear an outstanding wait?
 */
function clearsBackoff({ waiting, previous, now, limit }) {
  if (!waiting) return false;
  const roomNow = Number.isFinite(limit) && limit > 0 && now < limit;
  const wasFull = previous === null || previous >= limit;
  return roomNow && wasFull;
}

check('a list that drops below the limit cuts the wait short', () => {
  assert.equal(clearsBackoff({ waiting: true, previous: 5, now: 3, limit: 5 }), true);
});

check('a first report with room clears it too', () => {
  // previous === null: nothing known before, and there is room now. The wait was
  // set by a failure whose cause we cannot see, so the visible fact wins.
  assert.equal(clearsBackoff({ waiting: true, previous: null, now: 2, limit: 5 }), true);
});

check('a list still at the limit keeps the wait', () => {
  assert.equal(clearsBackoff({ waiting: true, previous: 6, now: 5, limit: 5 }), false);
});

check('a list that was already under the limit keeps the wait', () => {
  /*
   * The important one. If there was room before the failure and room after it,
   * the revise list was never the reason — something else was, and asking again
   * straight away would get the same answer. That is what the backoff is for.
   */
  assert.equal(clearsBackoff({ waiting: true, previous: 2, now: 1, limit: 5 }), false);
});

check('nothing is cleared when nothing is waiting', () => {
  assert.equal(clearsBackoff({ waiting: false, previous: 9, now: 1, limit: 5 }), false);
});

check('auto-start switched off never clears anything', () => {
  // limit 0 or blank is "off"; there is no room to be under.
  assert.equal(clearsBackoff({ waiting: true, previous: 9, now: 0, limit: 0 }), false);
  assert.equal(clearsBackoff({ waiting: true, previous: 9, now: 0, limit: NaN }), false);
});

console.log(failures ? `\n${failures} auto-unblock check(s) failed` : '\nthe backoff clears with its reason');
process.exit(failures ? 1 : 0);
