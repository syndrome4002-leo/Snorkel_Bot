/*
 * backfill-is-new-task.mjs — fills in is_new_task on tasks that predate it.
 *
 *   npm run backfill:new-task            show what would change
 *   npm run backfill:new-task -- --apply write it
 *
 * Inferred rather than guessed: a task carrying feedback has been through a
 * reviewer, and so is not new whatever else is true of it. Everything else was
 * started by the bot and never sent back, which is what new means.
 *
 * Tasks that already have the field are left alone — the inference is a
 * best-effort reconstruction and should never overwrite something written at the
 * time it actually happened.
 */

import { config } from '../src/config.js';
import { initFirebase } from '../src/firebase.js';
import admin from 'firebase-admin';

const apply = process.argv.includes('--apply');

await initFirebase();
const db = admin.firestore();

const snap = await db.collection(config.firebase.collection).get();
if (snap.empty) {
  console.log(`No documents in "${config.firebase.collection}".`);
  process.exit(0);
}

let already = 0;
const planned = [];

for (const doc of snap.docs) {
  const task = doc.data();
  if (typeof task.is_new_task === 'boolean') {
    already++;
    continue;
  }

  const reviewed =
    (Array.isArray(task.feedbacks) && task.feedbacks.length > 0) ||
    task.task_status === 'needs revision';

  planned.push({
    uid: doc.id,
    value: !reviewed,
    why: reviewed
      ? Array.isArray(task.feedbacks) && task.feedbacks.length
        ? `${task.feedbacks.length} feedback round(s)`
        : 'status is "needs revision"'
      : `never reviewed (status "${task.task_status || 'unknown'}")`,
  });
}

console.log(`\n${snap.size} task(s): ${already} already set, ${planned.length} to fill in\n`);
for (const row of planned) {
  console.log(`  ${row.uid}  is_new_task=${String(row.value).padEnd(5)}  ${row.why}`);
}

if (!planned.length) {
  console.log('\nNothing to do.\n');
  process.exit(0);
}

if (!apply) {
  console.log('\nDry run. Re-run with --apply to write these.\n');
  process.exit(0);
}

// Batches are capped at 500 writes.
for (let i = 0; i < planned.length; i += 400) {
  const batch = db.batch();
  for (const row of planned.slice(i, i + 400)) {
    batch.set(
      db.collection(config.firebase.collection).doc(row.uid),
      { is_new_task: row.value, is_new_task_backfilled: true },
      { merge: true }
    );
  }
  await batch.commit();
}

console.log(`\nWrote ${planned.length} document(s).\n`);
process.exit(0);
