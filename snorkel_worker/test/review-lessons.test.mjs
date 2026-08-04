/*
 * The review half of the lessons pipeline, end to end, against a fake Firestore.
 *
 *   node test/review-lessons.test.mjs
 *
 * No credentials and no network. What it holds to is the rule that makes this
 * store safe to feed back into a prompt: a round that broke something teaches
 * nothing, however much it also fixed.
 */
/*
 * Both halves are patched, and they are different module instances: the worker
 * resolves firebase-admin from its own node_modules and snorkel_server from
 * its. Patching one leaves the other reaching for a real app that does not
 * exist.
 */
import admin from 'firebase-admin';
import serverAdmin from '../../snorkel_server/node_modules/firebase-admin/lib/index.js';
import { diffRounds, madeThingsWorse } from '../src/checksigns.js';

// ---- a Firestore that lives in a Map --------------------------------------
const store = new Map();
const docFor = (id) => ({
  id,
  async get() {
    return { exists: store.has(id), data: () => store.get(id) };
  },
  async set(value, options) {
    store.set(id, options && options.merge ? { ...(store.get(id) || {}), ...value } : value);
  },
});
const fakeFirestore = () => ({
  collection: () => ({
    doc: docFor,
    where: () => ({
      limit: () => ({
        async get() {
          return {
            docs: [...store.entries()]
              .filter(([, v]) => v.confirmed === true)
              .map(([id, v]) => ({ id, data: () => v })),
          };
        },
      }),
    }),
  }),
});

// `firestore` is a getter on the namespace, so it is redefined rather than
// assigned. Both modules call `admin.firestore()` at use time, not at import.
for (const ns of [admin, serverAdmin]) {
  Object.defineProperty(ns, 'firestore', { configurable: true, value: fakeFirestore });
}

const { recordReviewFailures, confirmReviewLessons, reviewDocId } = await import(
  '../../snorkel_server/src/lessons.js'
);
const { recordLesson, lessonsBlock, confirmedLessons } = await import('../src/lessons.js');

let bad = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
};

const round = (...checks) => ({ checks });
const judge = (t) => ({ title: 'Agentic Judge Quality Report', text: t });
const quality = (t) => ({ title: 'Quality Check', text: t });
const oracle = (t) => ({ title: 'Oracle Check', text: t });

// ---- a signature with a slash is a legal document id ----------------------
check(
  'a signature containing a slash becomes a legal document id',
  !reviewDocId('judge:discuss/overreach').includes('/'),
  `${reviewDocId('judge:discuss/overreach')} — Firestore rejects "/" in an id`
);

// ---- the clean case: complaint seen, fixed, lesson confirmed --------------
{
  store.clear();
  const r1 = round(judge('Status: ⚠️ DISCUSS\nReason: overreach'), quality('❌ 1 must-have quality criteria failed'));
  await recordReviewFailures('TASK-A', diffRounds(null, r1).open);
  await recordLesson(['judge:discuss/overreach'], 'Trim the instruction to observable behaviour.', {
    source: 'review',
  });

  const before = await confirmedLessons(15, { source: 'review' });
  check('a lesson is not usable before the complaint is beaten', before.length === 0, `${before.length} usable`);

  const r2 = round(judge('Status: ✅ OK\nReason: n/a'), quality('✅ datapoint meets quality bar (15/15)'));
  const diff = diffRounds(r1, r2);
  await confirmReviewLessons('TASK-A', diff.fixed, { clean: !madeThingsWorse(diff) });

  const after = await confirmedLessons(15, { source: 'review' });
  check(
    'a clean round confirms the lesson',
    after.length === 1 && after[0].signature === 'judge:discuss/overreach',
    JSON.stringify(after.map((l) => l.signature))
  );

  const block = await lessonsBlock({ source: 'review' });
  check(
    'it reaches the revision prompt',
    block.includes('Trim the instruction') && block.includes('come back from review'),
    JSON.stringify(block.slice(0, 90))
  );
}

// ---- the dangerous case: fixed three, broke the oracle -------------------
{
  store.clear();
  const r1 = round(judge('Status: ⚠️ DISCUSS\nReason: overreach'));
  await recordReviewFailures('TASK-B', diffRounds(null, r1).open);
  await recordLesson(['judge:discuss/overreach'], 'Rewrote the oracle and deleted two tests.', {
    source: 'review',
  });

  const r2 = round(judge('Status: ✅ OK\nReason: n/a'), oracle('Oracle did not pass all runs: 0/3.'));
  const diff = diffRounds(r1, r2);
  check('the round is recognised as having caused damage', madeThingsWorse(diff), JSON.stringify(diff));

  await confirmReviewLessons('TASK-B', diff.fixed, { clean: !madeThingsWorse(diff) });
  const usable = await confirmedLessons(15, { source: 'review' });
  check(
    'a round that broke something teaches nothing',
    usable.length === 0,
    `it confirmed ${usable.length} lesson(s) from a round that knocked the oracle to 0/3`
  );
}

// ---- the two sources do not leak into each other -------------------------
{
  store.clear();
  await recordReviewFailures('TASK-C', ['quality:must_have_failed']);
  await recordLesson(['quality:must_have_failed'], 'Add the missing must-have criterion.', { source: 'review' });
  await confirmReviewLessons('TASK-C', ['quality:must_have_failed'], { clean: true });
  store.set('abc123hash', { signature: 'abc123hash', lesson: 'A build-log fix.', confirmed: true, occurrences: 9 });

  const review = await lessonsBlock({ source: 'review' });
  const staticBlock = await lessonsBlock({ source: 'static' });
  check(
    'a build lesson stays out of the revision prompt, and the reverse',
    review.includes('must-have') && !review.includes('build-log fix') &&
      staticBlock.includes('build-log fix') && !staticBlock.includes('must-have'),
    `review=${review.slice(0, 60)} | static=${staticBlock.slice(0, 60)}`
  );
}

console.log(bad ? `\n${bad} failed\n` : '\nthe review lessons pipeline holds\n');
process.exit(bad ? 1 : 0);
