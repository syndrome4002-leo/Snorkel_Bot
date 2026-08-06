/*
 * Which finished task the submit sweep picks.
 *
 * The case that prompted this: a revision is built, uploaded and ready, but the
 * platform is not offering a row to open it by. Nothing is wrong with the task —
 * it just cannot be opened this minute. Left in front of the queue it costs a
 * ninety-second wait every sweep and every other finished task waits behind it.
 */

process.env.WORKSPACE = 'ours';
process.env.MACHINE_ID = 'our-server';

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

const assert = (value, message) => {
  if (!value) throw new Error(message);
};

/*
 * The selection, as findReadyToSubmit does it: eligible tasks, oldest first,
 * minus the ones parked for having no row. Kept here rather than reaching into
 * Firestore so the rule can be checked without a database.
 */
function pick(tasks, skip = []) {
  const skipping = new Set(skip.map(String));
  const eligible = tasks
    .filter((t) => t.file_uploaded === true || t.needs_upload === false)
    .filter((t) => !skipping.has(String(t.UID)))
    .sort((a, b) => String(a.updated_at || '').localeCompare(String(b.updated_at || '')));
  return { task: eligible[0] || null, eligible: eligible.length };
}

const READY = [
  { UID: 'older', file_uploaded: true, updated_at: '2026-08-06T01:00:00Z' },
  { UID: 'newer', file_uploaded: true, updated_at: '2026-08-06T02:00:00Z' },
];

check('normally the task that has waited longest goes first', () => {
  assert(pick(READY).task.UID === 'older', 'should pick the oldest');
});

check('a task with no row on the list steps aside for the next one', () => {
  const chosen = pick(READY, ['older']);
  assert(chosen.task.UID === 'newer', 'should move on to the next ready task');
});

check('stepping aside does not mark it done or failed — it is simply not chosen', () => {
  // The whole point: nothing about the task changes. It is still ready, still
  // uploaded, and comes back the moment it is unparked.
  const chosen = pick(READY, []);
  assert(chosen.task.UID === 'older', 'should be picked again once unparked');
  assert(chosen.eligible === 2, 'both are still eligible');
});

check('with every task parked the sweep finds nothing to do', () => {
  const chosen = pick(READY, ['older', 'newer']);
  assert(chosen.task === null, 'nothing should be picked');
  assert(chosen.eligible === 0, 'none eligible while all are parked');
});

check('parking never overrides the Dropbox rule', () => {
  // A task whose file is not up yet is mid-flight, not parked, and must not be
  // picked just because the parked one stepped aside.
  const tasks = [
    { UID: 'no-file', file_uploaded: false, updated_at: '2026-08-06T00:00:00Z' },
    { UID: 'ready', file_uploaded: true, updated_at: '2026-08-06T03:00:00Z' },
  ];
  assert(pick(tasks, []).task.UID === 'ready', 'should skip the one with no file');
  assert(pick(tasks, ['ready']).task === null, 'and not fall back to it when parked');
});

check('a verdict task with nothing to upload is still submittable', () => {
  const tasks = [{ UID: 'verdict', needs_upload: false, updated_at: '2026-08-06T00:00:00Z' }];
  assert(pick(tasks).task.UID === 'verdict', 'needs_upload false is eligible');
});

console.log(failures ? `\n${failures} submit-parking check(s) failed` : '\nthe submit parking holds');
process.exit(failures ? 1 : 0);
