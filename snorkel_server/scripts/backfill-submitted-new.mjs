/*
 * Gives `submitted_new_at` to tasks that were first sent before it existed.
 *
 *   node scripts/backfill-submitted-new.mjs          show what would change
 *   node scripts/backfill-submitted-new.mjs --write  apply it
 *
 * The daily cap now counts on that timestamp. Without this, every task sent
 * before today reads as never having been submitted as a new one — which is
 * harmless for the cap (they are not today's) but leaves the field lying about
 * their history.
 *
 * `sent_at` is the best available stand-in: for a task never revised it IS the
 * moment it was first sent, and for one that has been, it is the closest thing
 * on the record.
 */
import { initFirebase } from '../src/firebase.js';
import { config } from '../src/config.js';

const write = process.argv.includes('--write');
const db = await initFirebase();
if (!db) {
  console.error('Firestore is not reachable.');
  process.exit(1);
}

const snap = await db.collection(config.firebase.collection).get();
let touched = 0;

for (const doc of snap.docs) {
  const t = doc.data();
  if (t.submitted_new !== true || t.submitted_new_at || !t.sent_at) continue;
  touched++;
  console.log(`${doc.id}  submitted_new_at <- ${t.sent_at}`);
  if (write) await doc.ref.set({ submitted_new_at: t.sent_at }, { merge: true });
}

console.log(`\n${touched} task(s) ${write ? 'updated' : 'would be updated'}${write ? '' : ' — re-run with --write'}`);
process.exit(0);
