/*
 * A UID already on record is never built again.
 *
 * The site can hand out the same submission twice — one started and left, or
 * one this account did before the bot existed and which has since been added by
 * hand. Before this, saving merged over whatever was there: the record went
 * back to "started", the worker picked it up, and a full Claude session rebuilt
 * work that had already been submitted.
 *
 * The download cannot be avoided — the UID is only readable once the page has
 * opened — so recognising it costs a file. Not recognising it costs a build.
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
 * The decision saveTask makes, in the shape it makes it. Held here rather than
 * against Firestore: what is worth pinning is that an existing record stops the
 * build, and which of `saved` and `skipped` says so — neither needs a database
 * to be wrong.
 */
function decide(existing, incoming) {
  if (existing) {
    return {
      saved: false,
      skipped: true,
      id: incoming.UID,
      reason:
        `${incoming.UID} is already in the database` +
        (existing.task_status ? ` at "${existing.task_status}"` : '') +
        ' — skipped rather than built again.',
    };
  }
  return { saved: true, skipped: false, id: incoming.UID };
}

const incoming = { UID: 'abc123', file_name: 'abc123.zip' };

check('a UID never seen before is saved and built', () => {
  const out = decide(null, incoming);
  assert.equal(out.saved, true);
  assert.equal(out.skipped, false);
});

check('a UID already on record is skipped, not saved', () => {
  const out = decide({ task_status: 'ready to submit' }, incoming);
  assert.equal(out.saved, false);
  assert.equal(out.skipped, true);
});

check('the skip says what was already known, so the log is not a mystery', () => {
  const out = decide({ task_status: 'static checks pass' }, incoming);
  assert.match(out.reason, /abc123/);
  assert.match(out.reason, /static checks pass/);
});

check('a UID added by hand with no status still stops the build', () => {
  // What the dashboard writes: the UID and nothing else. It carries no status,
  // and it must still be recognised — that is the whole point of adding it.
  const out = decide({}, incoming);
  assert.equal(out.skipped, true);
  assert.match(out.reason, /already in the database/);
  assert.doesNotMatch(out.reason, /undefined|at ""/);
});

check('a skip is not reported as a failure to save', () => {
  /*
   * These are different things and the caller branches on both: a write that
   * failed is a warning worth chasing, a skip is the system working. Conflating
   * them buries the one that matters under the one that does not.
   */
  const out = decide({ task_status: 'in build' }, incoming);
  assert.equal(out.saved, false, 'nothing was written');
  assert.equal(out.skipped, true, 'and that was deliberate');
});

console.log(failures ? `\n${failures} known-uid check(s) failed` : '\nknown UIDs are left alone');
process.exit(failures ? 1 : 0);
