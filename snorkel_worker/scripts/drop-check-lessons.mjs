/*
 * drop-check-lessons.mjs — delete the CheckLessons collection.
 *
 *   npm run drop:lessons             what would go, and nothing else
 *   npm run drop:lessons -- --confirm   actually delete it
 *
 * The lessons pipeline was removed in August 2026: it spent 12% of everything
 * this system used to produce 12k tokens of output across 133 runs. The code is
 * gone from both the worker and the server, but the documents it wrote outlive
 * it, and nothing reads them.
 *
 * Deleting them frees no Claude usage — stored rows cost nothing. This exists
 * only so the store does not sit there looking like a feature.
 *
 * Not reversible, and the project is shared: another machine still running an
 * older commit would read an empty collection. That is survivable — the old code
 * treated an unreachable store as "no lessons" and carried on — but it is the
 * reason this asks before doing anything.
 */

import admin from 'firebase-admin';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const COLLECTION = 'CheckLessons';
const BATCH = 200;

const here = path.dirname(fileURLToPath(import.meta.url));
const confirm = process.argv.includes('--confirm');

const keyFile =
  process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(here, '..', 'serviceAccount.json');

let credentials;
try {
  credentials = JSON.parse(readFileSync(keyFile, 'utf8'));
} catch (err) {
  console.error(`Could not read service account at ${keyFile}: ${err.message}`);
  process.exit(1);
}

admin.initializeApp({ credential: admin.credential.cert(credentials) });
const db = admin.firestore();

const first = await db.collection(COLLECTION).limit(BATCH).get();
if (first.empty) {
  console.log(`${COLLECTION} is already empty — nothing to do.`);
  process.exit(0);
}

if (!confirm) {
  // Counted rather than estimated, so the number in front of you is the number
  // that would go.
  let total = 0;
  let cursor = null;
  for (;;) {
    let q = db.collection(COLLECTION).orderBy('__name__').limit(BATCH);
    if (cursor) q = q.startAfter(cursor);
    const page = await q.get();
    if (page.empty) break;
    total += page.size;
    cursor = page.docs[page.docs.length - 1];
    if (page.size < BATCH) break;
  }
  console.log(`${COLLECTION}: ${total} document(s) would be deleted.`);
  console.log('Nothing has been changed. Re-run with --confirm to delete them.');
  process.exit(0);
}

let removed = 0;
for (;;) {
  const page = await db.collection(COLLECTION).limit(BATCH).get();
  if (page.empty) break;
  const batch = db.batch();
  page.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
  removed += page.size;
  console.log(`  deleted ${removed}...`);
}

const left = await db.collection(COLLECTION).limit(1).get();
console.log(`Deleted ${removed} document(s). ${COLLECTION} is now ${left.empty ? 'empty' : 'NOT empty'}.`);
process.exit(0);
