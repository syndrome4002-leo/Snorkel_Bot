/*
 * The same question, asked by two different forms, with two different sets of
 * answers.
 *
 * "What issue did you find with the task/components?" offers seven categories
 * about instructions and tests on the fixable form, and two about scope and the
 * environment on the unfixable one. Answering the second with the first's
 * categories leaves the question blank on the page — the form filler will not
 * guess, and it is right not to.
 */

import assert from 'node:assert/strict';
import { schemaForStage } from '../src/prompts.js';
import { normaliseAnswers } from '../src/answers.js';

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

await check('the unfixable form asks with its own two options', async () => {
  const spec = (await schemaForStage('invalid')).what_issues_found;
  assert.deepEqual(spec.enum, ['PR scope needs to be changed or reduced', 'Environment Issues']);
});

await check('the fixable stage keeps all seven categories', async () => {
  // 'revision' was a stage here until reviewer revisions were removed; a build
  // and the check-fix that answers its upload are all that is left.
  const spec = (await schemaForStage('build')).what_issues_found;
  assert.equal(spec.enum.length, 7, 'build should keep the full list');
  assert.ok(spec.enum.includes('the instructions are overly-prescriptive'));
});

await check('valid-as-is is never asked the question at all', async () => {
  // It is not claiming anything is wrong, and the page does not have the field.
  const schema = await schemaForStage('valid-as-is');
  assert.equal(schema.what_issues_found, undefined);
  assert.equal(schema.environment_issue_specifics, undefined);
});

await check('an unfixable answer survives validation', async () => {
  const { answers, problems } = await normaliseAnswers(
    { what_issues_found: ['Environment Issues'] },
    { stage: 'invalid' }
  );
  assert.deepEqual(answers.what_issues_found, ['Environment Issues']);
  assert.deepEqual(problems, []);
});

await check('the answer that caused this is rejected on the unfixable form', async () => {
  // Exactly what was stored on the task that came back unfilled. Better to drop
  // it here, where it is reported, than to carry it to a page with no such box.
  const { answers } = await normaliseAnswers(
    { what_issues_found: ['the instructions are overly-prescriptive'] },
    { stage: 'invalid' }
  );
  assert.equal(answers.what_issues_found, undefined);
});

await check('the environment follow-up is offered only on the unfixable form', async () => {
  const spec = (await schemaForStage('invalid')).environment_issue_specifics;
  assert.ok(spec, 'should be asked on the invalid stage');
  assert.deepEqual(spec.enum, [
    'Image/Dependency Build Failures',
    'Oracle timeout',
    'External-network dependency at build/solve time',
  ]);
  assert.equal((await schemaForStage('build')).environment_issue_specifics, undefined);
});

await check('a fixable answer is still validated against the fixable list', async () => {
  const { answers } = await normaliseAnswers(
    { what_issues_found: ['the instructions are overly-prescriptive'] },
    { stage: 'build' }
  );
  assert.deepEqual(answers.what_issues_found, ['the instructions are overly-prescriptive']);
});

console.log(failures ? `\n${failures} verdict-answer check(s) failed` : '\nthe verdict answers hold');
process.exit(failures ? 1 : 0);
