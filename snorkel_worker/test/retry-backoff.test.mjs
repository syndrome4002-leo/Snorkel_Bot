/*
 * How long a task is left alone after the worker failed on it.
 *
 * The failure that prompted this cost $1.76 a time and repeated every thirty
 * seconds, because a failed task went straight back into the queue it had just
 * come out of. Retrying is right; retrying immediately is not.
 */

import assert from 'node:assert/strict';
import { retryDue, retryWaitMinutes } from '../src/firebase.js';

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

const minutesAgo = (n) => new Date(Date.now() - n * 60000).toISOString();

check('a task that has never failed is workable', () => {
  assert.equal(retryDue({}), true);
  assert.equal(retryDue({ worker_failed_at: null }), true);
});

check('a task that just failed is left alone', () => {
  assert.equal(retryDue({ worker_failed_at: minutesAgo(0.5), worker_failures: 1 }), false);
});

check('the first retry comes round after five minutes', () => {
  assert.equal(retryDue({ worker_failed_at: minutesAgo(4), worker_failures: 1 }), false);
  assert.equal(retryDue({ worker_failed_at: minutesAgo(6), worker_failures: 1 }), true);
});

check('each failure in a row waits longer than the last', () => {
  assert.deepEqual([1, 2, 3, 4].map(retryWaitMinutes), [5, 15, 45, 60]);
});

check('a task failing over and over is tried hourly, not abandoned', () => {
  // Plenty of failures are worth retrying eventually — a lost network, a full
  // disk, a usage window that resets. Slow is the point; never is not.
  assert.equal(retryWaitMinutes(9), 60);
  assert.equal(retryDue({ worker_failed_at: minutesAgo(59), worker_failures: 9 }), false);
  assert.equal(retryDue({ worker_failed_at: minutesAgo(61), worker_failures: 9 }), true);
});

check('a failure with no count still waits', () => {
  // Written by an older worker, or lost to a crash between the two fields.
  assert.equal(retryDue({ worker_failed_at: minutesAgo(1) }), false);
  assert.equal(retryDue({ worker_failed_at: minutesAgo(10) }), true);
});

check('an unreadable timestamp does not park the task forever', () => {
  assert.equal(retryDue({ worker_failed_at: 'not a date', worker_failures: 2 }), true);
});

console.log(failures ? `\n${failures} retry-backoff check(s) failed` : '\nthe retry backoff holds');
process.exit(failures ? 1 : 0);
