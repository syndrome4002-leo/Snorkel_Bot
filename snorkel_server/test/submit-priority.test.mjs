/*
 * What the submit sweep picks when the revise list is at its limit.
 *
 * Starting a new task was already gated on the backlog. Submitting one that had
 * already been built was not — so a new task finished before the backlog grew
 * went out anyway, and every submission of it adds another task that will come
 * back for revision, on top of a list that is already over the line.
 *
 * Revisions are what shorten that list: handing one back takes it off it.
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

/* findReadyToSubmit's selection, with the sweep's two exclusion reasons. */
function pick(tasks, { atCap = false, backlogFull = false, skip = [] } = {}) {
  const skipping = new Set(skip);
  let eligible = tasks
    .filter((t) => t.file_uploaded === true || t.needs_upload === false)
    .filter((t) => !skipping.has(t.UID));

  const held = atCap || backlogFull ? eligible.filter((t) => t.is_new_task === true).length : 0;
  if (atCap || backlogFull) eligible = eligible.filter((t) => t.is_new_task !== true);

  eligible.sort((a, b) => String(a.updated_at || '').localeCompare(String(b.updated_at || '')));
  return { picked: eligible[0]?.UID ?? null, held, eligible: eligible.length };
}

/** The rule the sweep uses to decide the backlog is full. */
const backlogFull = (count, limit) =>
  Number.isFinite(limit) && limit > 0 && count !== null && count >= limit;

const READY = [
  { UID: 'new-task', is_new_task: true, file_uploaded: true, updated_at: '2026-08-07T01:00:00Z' },
  { UID: 'revision', is_new_task: false, file_uploaded: true, updated_at: '2026-08-07T02:00:00Z' },
];

check('with the backlog at its limit, the revision goes first', () => {
  // Even though the new task has waited longer, which is the order otherwise.
  const out = pick(READY, { backlogFull: true });
  assert.equal(out.picked, 'revision');
  assert.equal(out.held, 1);
});

check('once the backlog drops, the waiting new task goes', () => {
  assert.equal(pick(READY, { backlogFull: false }).picked, 'new-task');
});

check('a new task alone with a full backlog waits, rather than going out', () => {
  const out = pick([READY[0]], { backlogFull: true });
  assert.equal(out.picked, null);
  assert.equal(out.held, 1, 'and it is counted, so the ticker can say why');
});

check('a revision alone is submitted whatever the backlog is', () => {
  // Revisions are the thing that shortens the list; holding them back would be
  // the wrong lever entirely.
  assert.equal(pick([READY[1]], { backlogFull: true }).picked, 'revision');
});

check('the backlog is full at the limit, not only above it', () => {
  assert.equal(backlogFull(5, 5), true, 'five awaiting with a limit of five is full');
  assert.equal(backlogFull(4, 5), false);
  assert.equal(backlogFull(6, 5), true);
});

check('no limit set means nothing is held back', () => {
  // revise_limit empty or 0 turns auto-start off; it must not quietly become a
  // rule that stops submissions as well.
  assert.equal(backlogFull(9, 0), false);
  assert.equal(backlogFull(9, NaN), false);
});

check('an unknown backlog holds nothing back', () => {
  // The extension has not reported a count yet. Guessing "full" would stall
  // every new task until the first read.
  assert.equal(backlogFull(null, 5), false);
});

check('the daily cap still holds new tasks on its own', () => {
  const out = pick(READY, { atCap: true });
  assert.equal(out.picked, 'revision');
  assert.equal(out.held, 1);
});

console.log(failures ? `\n${failures} priority check(s) failed` : '\nthe submit priority holds');
process.exit(failures ? 1 : 0);
