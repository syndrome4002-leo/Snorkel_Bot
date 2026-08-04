/*
 * Fills in `check_signatures` on feedback rounds recorded before the checks
 * pipeline existed.
 *
 *   node scripts/backfill-check-signatures.mjs          show what would change
 *   node scripts/backfill-check-signatures.mjs --write  actually write it
 *
 * Nothing is removed and nothing is recomputed: a round that already has
 * signatures is left exactly as it is. Without this the dashboard's scorecard is
 * blank for every round already in the database, because it has no "before" to
 * subtract from.
 */

import { initFirebase } from '../src/firebase.js';
import { config } from '../src/config.js';
import { signaturesOf, diffRounds, describeDiff } from '../src/checksigns.js';

const write = process.argv.includes('--write');

const db = await initFirebase();
if (!db) {
  console.error('Firestore is not reachable — nothing to do.');
  process.exit(1);
}

const snap = await db.collection(config.firebase.collection).get();
const tasks = [];
snap.forEach((doc) => tasks.push({ id: doc.id, ...doc.data() }));

let touched = 0;
let rounds = 0;

for (const task of tasks) {
  const feedbacks = Array.isArray(task.feedbacks) ? task.feedbacks : [];
  if (!feedbacks.length) continue;

  let changed = false;
  const next = feedbacks.map((round) => {
    if (Array.isArray(round.check_signatures)) return round;
    changed = true;
    rounds++;
    return { ...round, check_signatures: signaturesOf(round) };
  });
  if (!changed) continue;

  touched++;
  console.log(`\n${task.id}  (${feedbacks.length} round(s))`);
  for (const [i, round] of next.entries()) {
    console.log(`  round ${i + 1}: ${describeDiff(diffRounds(i ? next[i - 1] : null, round))}`);
  }

  if (write) {
    const latest = diffRounds(next.length > 1 ? next[next.length - 2] : null, next[next.length - 1]);
    await db
      .collection(config.firebase.collection)
      .doc(task.id)
      .set(
        {
          feedbacks: next,
          check_progress: {
            at: new Date().toISOString(),
            round: next.length,
            first: Boolean(latest.first),
            fixed: latest.fixed,
            persisted: latest.persisted,
            introduced: latest.introduced,
            open: latest.open,
            regressed: !latest.first && latest.introduced.length > 0,
            summary: describeDiff(latest),
            backfilled: true,
          },
        },
        { merge: true }
      );
  }
}

console.log(
  `\n${touched} task(s), ${rounds} round(s) ${write ? 'updated' : 'would be updated'}` +
    (write ? '' : ' — re-run with --write to apply')
);
process.exit(0);
