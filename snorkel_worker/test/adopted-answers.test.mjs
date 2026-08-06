/*
 * The answers a task has never had.
 *
 * A revision is asked only for what CHANGED, because everything else is already
 * stored and merging over it leaves the rest alone. That holds for a task this
 * system built — and not at all for one somebody submitted by hand, which we
 * only took on when the reviewer sent it back. Nothing was ever recorded, so a
 * round that writes only its changes fills three boxes on the form and leaves
 * the rest empty.
 */

import assert from 'node:assert/strict';
import { missingAnswerKeys, missingForStage } from '../src/task.js';
import { schemaForStage } from '../src/prompts.js';

let failures = 0;

async function check(what, fn) {
  try {
    await fn();
    console.log('PASS ', what);
  } catch (err) {
    failures++;
    console.log('FAIL ', what);
    console.log('      ', err.message);
  }
}

await check('a task with nothing stored is missing every question', async () => {
  const expected = Object.entries(await schemaForStage('revision')).filter(
    ([, s]) => !s.when && !s.supplied_by_server
  ).length;
  assert.equal((await missingAnswerKeys({})).length, expected);
  assert.equal((await missingAnswerKeys({ answers: {} })).length, expected);
});

await check('a task this system built is missing none', async () => {
  const all = Object.fromEntries(
    Object.keys(await schemaForStage('revision')).map((key) => [key, 'an answer'])
  );
  assert.deepEqual(await missingAnswerKeys({ answers: all }), []);
});

await check('a partly answered task is missing only the rest', async () => {
  const gaps = await missingAnswerKeys({
    answers: { issues_in_detail: 'the instruction was vague', files_changed: 'tests/test_api.py' },
  });
  assert.ok(!gaps.includes('issues_in_detail'), 'stored answers are not gaps');
  assert.ok(!gaps.includes('files_changed'), 'stored answers are not gaps');
  assert.ok(gaps.includes('what_makes_difficult'), 'unanswered ones are');
});

await check('the handling times are not gaps — the server sends those', async () => {
  // On no task's record, ever: the numbers are drawn once per task by the server
  // and travel with the submission. Reported as missing they would be three
  // permanent gaps on every task, answered with numbers the form ignores.
  const gaps = await missingAnswerKeys({});
  for (const key of ['review_time_min', 'rewrite_time_min', 'submission_time_min']) {
    assert.ok(!gaps.includes(key), `${key} should not be asked for`);
  }
});

await check('a conditional question with no answer is not a gap', async () => {
  // "If you added to the PR in any way" is NA when the PR was not touched.
  // Listing it would invite an answer to a question that did not apply.
  assert.ok(!(await missingAnswerKeys({})).includes('added_PR_explain'));
});

await check('an empty string or empty list counts as missing', async () => {
  const gaps = await missingAnswerKeys({
    answers: { issues_in_detail: '   ', what_issues_found: [], files_changed: null },
  });
  for (const key of ['issues_in_detail', 'what_issues_found', 'files_changed']) {
    assert.ok(gaps.includes(key), `${key} should count as missing`);
  }
});

await check('answers stored in the old list shape are treated as nothing', async () => {
  // Early records kept a list of rounds rather than an object keyed by field.
  // Reading one as though it were the current shape would find every key
  // missing anyway — this just makes that explicit rather than accidental.
  const expected = Object.entries(await schemaForStage('revision')).filter(
    ([, s]) => !s.when && !s.supplied_by_server
  ).length;
  assert.equal((await missingAnswerKeys({ answers: [{ round: 1 }] })).length, expected);
});

await check('a verdict run is checked against its own form', async () => {
  // A verdict task gets one round. Whatever is missing when it ends is missing
  // on the form somebody submits, so the gaps are worth finding before then.
  const invalid = await missingForStage('invalid', { validity_required: 'invalid' });
  assert.ok(invalid.includes('why_unfixable'), 'the unfixable form asks why');
  assert.ok(invalid.includes('comments_for_reviewer'));
  assert.ok(!invalid.includes('validity_required'), 'the stored answer is not a gap');
  assert.ok(!invalid.includes('issues_in_detail'), 'that question is not on this form');
});

await check('valid-as-is is checked against the shorter form still', async () => {
  const gaps = await missingForStage('valid-as-is', {});
  assert.ok(!gaps.includes('why_unfixable'), 'it is not claiming anything is wrong');
  assert.ok(!gaps.includes('what_issues_found'), 'that question is not on this form');
  assert.ok(gaps.includes('what_makes_difficult'));
});

await check('an optional follow-up is not counted as a gap', async () => {
  // "If Environment Issues was selected above" — a question that only applies
  // when it applies. Asking for it unconditionally invites an invented answer.
  assert.ok(!(await missingForStage('invalid', {})).includes('environment_issue_specifics'));
});

console.log(failures ? `\n${failures} adopted-answer check(s) failed` : '\nthe adopted answers hold');
process.exit(failures ? 1 : 0);
