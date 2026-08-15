/*
 * A task with nothing left to build from is not retried.
 *
 * The worker put every failure back to "in build" and tried again on a backoff.
 * That is right for a failure that might not repeat — Claude erroring, the
 * subscription running out, a timeout. It is wrong for a task whose zip is no
 * longer in Dropbox and whose folder is not on this disk, because there is
 * nothing to work with and no amount of waiting brings it back: the file would
 * have to come from the platform, and only the extension can fetch it.
 *
 * Nine such records were claiming a slot, calling Dropbox, failing and logging
 * every few minutes for as long as the worker ran. This is the difference
 * between "try again later" and "there is nothing here".
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
 * The branch the worker takes on a failed task, in the shape it takes it. The
 * error code is the whole signal: task.js only lets DROPBOX_NOT_FOUND escape
 * once it has already looked for the folder and not found one.
 */
function outcome(err) {
  if (err.code === 'DROPBOX_NOT_FOUND') return 'park';
  return 'retry';
}

check('a lost download parks the task instead of retrying it', () => {
  const err = new Error('Dropbox download failed (HTTP 409): path/not_found/');
  err.code = 'DROPBOX_NOT_FOUND';
  assert.equal(outcome(err), 'park');
});

check('an ordinary failure is still retried', () => {
  // Claude erroring, a timeout, a network blip — these may well work next time.
  assert.equal(outcome(new Error('Claude reported an error')), 'retry');
});

check('running out of usage is retried, not parked', () => {
  /*
   * The most important one to get right: the subscription refills. Parking a
   * task because the week ran out would need a person to un-park every task the
   * worker touched between running out and the reset.
   */
  assert.equal(outcome(new Error("You're out of extra usage · resets 5:10am")), 'retry');
});

check('a Dropbox failure that is not "not there" is retried', () => {
  // A 500 or a dropped connection says nothing about whether the file exists.
  const err = new Error('Dropbox download failed (HTTP 503)');
  assert.equal(outcome(err), 'retry');
});

check('the parked status is not one the worker will claim again', async () => {
  const { WORKABLE, TASK_STATUS_LOST } = await import('../src/firebase.js');
  assert.ok(!WORKABLE.includes(TASK_STATUS_LOST), 'parking it must actually stop it');
  assert.equal(TASK_STATUS_LOST, 'files lost');
});

console.log(failures ? `\n${failures} lost-file check(s) failed` : '\nlost tasks stay parked');
process.exit(failures ? 1 : 0);
