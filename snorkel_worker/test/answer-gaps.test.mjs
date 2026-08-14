/*
 * Which questions a run still owes an answer to.
 *
 * The build asks for the work and the answers in one reply, and usually gets
 * both. When it does not, one narrow follow-up asks for the keys that are
 * missing and nothing else — so "missing" has to mean exactly the right thing.
 * Too broad and every task pays for a follow-up it did not need; too narrow and
 * a question reaches the reviewer blank.
 *
 * This was `adopted-answers` while the bot still took tasks back from the
 * reviewer, where a task submitted by hand arrived with no answers on record at
 * all. That is gone; the stage-aware part of it is not, because a task judged
 * invalid is asked a different, shorter set of questions than a fixable one.
 */

import assert from 'node:assert/strict';
import { missingForStage } from '../src/task.js';
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

/** What a stage would ask for if nothing at all had been answered. */
async function askedFor(stage) {
  const schema = await schemaForStage(stage);
  return Object.entries(schema)
    .filter(([, spec]) => !spec.when && !spec.supplied_by_server)
    .map(([key]) => key);
}

await check('a build with nothing stored is missing every question it asks', async () => {
  const expected = (await askedFor('build')).length;
  assert.ok(expected > 0, 'a build must ask for something');
  assert.equal((await missingForStage('build', {})).length, expected);
  assert.equal((await missingForStage('build', null)).length, expected);
});

await check('a build that answered everything is missing none', async () => {
  const all = Object.fromEntries((await askedFor('build')).map((key) => [key, 'x']));
  assert.deepEqual(await missingForStage('build', all), []);
});

await check('a partly answered build is missing only the rest', async () => {
  const keys = await askedFor('build');
  const gaps = await missingForStage('build', { [keys[0]]: 'answered' });
  assert.ok(!gaps.includes(keys[0]));
  assert.equal(gaps.length, keys.length - 1);
});

await check('the handling times are not gaps — the server sends those', async () => {
  /*
   * Asking for them would report the same gaps on every task forever, and get
   * back numbers the form then ignores.
   */
  const gaps = await missingForStage('build', {});
  for (const key of ['rewrite_time_min', 'review_time_min', 'submission_time_min']) {
    assert.ok(!gaps.includes(key), `${key} is the server's to supply`);
  }
});

await check('a conditional question with no answer is not a gap', async () => {
  // No answer means the question did not apply, not that it was skipped.
  assert.ok(!(await missingForStage('build', {})).includes('added_PR_explain'));
});

await check('an empty string or empty list counts as missing', async () => {
  const keys = await askedFor('build');
  const gaps = await missingForStage('build', { [keys[0]]: '   ', [keys[1]]: [] });
  assert.ok(gaps.includes(keys[0]), 'whitespace is not an answer');
  assert.ok(gaps.includes(keys[1]), 'an empty list is not an answer');
});

await check('answers stored in the old list shape are treated as nothing', async () => {
  // Early records kept a list of rounds rather than an object of answers.
  const expected = (await askedFor('build')).length;
  assert.equal((await missingForStage('build', [{ round: 1 }])).length, expected);
});

await check('a verdict run is checked against its own, shorter form', async () => {
  const invalid = await missingForStage('invalid', { validity_required: 'invalid' });
  assert.ok(!invalid.includes('validity_required'));
  // The fixable form's questions are not on the page an invalid verdict fills.
  assert.ok(!invalid.includes('files_changed'));
});

await check('valid-as-is is checked against its own form too', async () => {
  const gaps = await missingForStage('valid-as-is', {});
  assert.ok(gaps.length > 0, 'it still has a form to fill in');
  assert.ok(!gaps.includes('why_unfixable'), 'that belongs to the invalid form');
});

await check('an optional follow-up is not counted as a gap', async () => {
  assert.ok(!(await missingForStage('invalid', {})).includes('environment_issue_specifics'));
});

console.log(failures ? `\n${failures} answer-gap check(s) failed` : '\nthe answer gaps hold');
process.exit(failures ? 1 : 0);
