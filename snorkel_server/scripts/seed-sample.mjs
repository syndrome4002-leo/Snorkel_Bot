/*
 * Creates the "Tasks" collection by writing one sample row, then reads it back.
 *
 *   npm run seed          add/refresh the sample row
 *   npm run seed:delete   remove it again
 *
 * Firestore has no schema and no "create table" step: a collection springs into
 * existence when its first document is written, and disappears when the last one
 * is deleted. Writing this row IS creating the table.
 */

import { initFirebase, saveTask, getTask, firebaseStatus } from '../src/firebase.js';
import { config } from '../src/config.js';
import admin from 'firebase-admin';

const SAMPLE_UID = '00000000-0000-0000-0000-000000000000';

const SAMPLE = {
  UID: SAMPLE_UID,
  file_name: 'SAMPLE_submission.zip',
  initial_infos: [
    'SAMPLE ROW — created by npm run seed. Safe to delete.',
    '',
    'Original Directory Name',
    '20260720_033755__platformplatform_platformplatform__860',
    'Category',
    'evolution_and_maintenance',
    'Difficulty',
    'hard',
    'Task Tags',
    'postgresql',
    'entity-framework',
    'database-migration',
    'Languages',
    'C#',
    'TypeScript',
    'Metadata',
    'schema_version = "1.3"',
    '[metadata]',
    'category = "evolution_and_maintenance"',
    'subcategory = "migration"',
    'coding_language = "csharp"',
    'repo_name = "platformplatform"',
  ].join('\n'),
};

const remove = process.argv.includes('--delete');

await initFirebase();
const status = firebaseStatus();

if (!status.ready) {
  console.error('\nFirestore is not reachable, so nothing was written.\n');
  console.error(`  reason: ${status.reason}\n`);
  process.exit(1);
}

if (remove) {
  await admin.firestore().collection(config.firebase.collection).doc(SAMPLE_UID).delete();
  console.log(`Deleted ${config.firebase.collection}/${SAMPLE_UID}`);
  process.exit(0);
}

const result = await saveTask(SAMPLE, { page_url: 'https://experts.snorkel-ai.com/ (sample row)' });
if (!result.saved) {
  console.error(`\nWrite failed: ${result.reason}\n`);
  process.exit(1);
}

const readBack = await getTask(SAMPLE_UID);
console.log(`\nCollection "${config.firebase.collection}" now exists in project ${status.projectId}.`);
console.log(`Document id: ${readBack.id}\n`);
for (const [key, value] of Object.entries(readBack)) {
  if (key === 'id') continue;
  const shown = key === 'initial_infos'
    ? `${String(value).split('\n')[0]} … (${String(value).length} chars, ${String(value).split('\n').length} lines)`
    : value;
  console.log(`  ${key.padEnd(14)} ${shown}`);
}
console.log(`\nView it: https://console.firebase.google.com/project/${status.projectId}/firestore/data/~2F${config.firebase.collection}`);
console.log('Remove it: npm run seed:delete');
process.exit(0);
