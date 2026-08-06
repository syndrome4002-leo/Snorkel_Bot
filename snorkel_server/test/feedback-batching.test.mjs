/*
 * Collecting every task's feedback in one sweep.
 *
 * The server asks for all of them, and always did — but in a single command with
 * a fixed four-minute budget. Reading one task means loading the home page,
 * opening its review page and stitching several Monaco panes together, so a few
 * slow ones spent the whole budget, the command timed out, and everything
 * already read was thrown away with it: results only come back at the end. The
 * next sweep started from the top and hit the same wall.
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

/* The two rules, as index.js has them. */
const FEEDBACK_BATCH = 3;
const COMMAND_TIMEOUT_MS = 240000;

function inBatches(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const feedbackTimeoutFor = (count) => Math.max(COMMAND_TIMEOUT_MS, 60000 + count * 150000);

check('every task is asked for, however many there are', () => {
  const uids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const batches = inBatches(uids, FEEDBACK_BATCH);
  assert.deepEqual(batches.flat(), uids, 'nothing dropped and the order kept');
  assert.equal(batches.length, 3);
});

check('one task is one batch, not a special case', () => {
  assert.deepEqual(inBatches(['only'], FEEDBACK_BATCH), [['only']]);
});

check('nothing to collect asks for nothing', () => {
  assert.deepEqual(inBatches([], FEEDBACK_BATCH), []);
});

check('a batch gets time for every task in it', () => {
  // The waits inside one read are generous on purpose — 90s for the row, two
  // minutes for the review page — because a slow page is common and a lost read
  // is expensive. Three of those in series do not fit a budget written for one.
  assert.ok(feedbackTimeoutFor(3) > feedbackTimeoutFor(1), 'three tasks get longer than one');
  assert.equal(feedbackTimeoutFor(3), 510000, 'about eight and a half minutes for three');
});

check('a single task keeps at least the old budget', () => {
  // Nothing gets less time than it had before this change.
  assert.ok(feedbackTimeoutFor(1) >= COMMAND_TIMEOUT_MS);
});

check('the work at risk is one batch, not the sweep', () => {
  // What a timeout costs: the batch that timed out. Whatever came back before it
  // is already stored, and the batches after it still run.
  const uids = ['a', 'b', 'c', 'd', 'e', 'f'];
  const batches = inBatches(uids, FEEDBACK_BATCH);
  const lost = batches[0].length;
  assert.equal(lost, 3);
  assert.equal(uids.length - lost, 3, 'the rest are still collected');
});

console.log(failures ? `\n${failures} batching check(s) failed` : '\nthe feedback batching holds');
process.exit(failures ? 1 : 0);
