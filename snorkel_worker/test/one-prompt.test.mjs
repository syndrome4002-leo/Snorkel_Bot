/*
 * One job, one prompt.
 *
 * Every prompt is a separate `claude --print` process, and every process pays
 * the same toll before it does anything: a cold start, and the conversation so
 * far written to cache at full price. That toll does not care whether the reply
 * is a single word or a rewritten test suite.
 *
 * Which is why a build used to cost three times what it needed to. It sent the
 * documents and waited, asked "is this fixable?" and waited, and only then asked
 * for the work — three tolls to do what a person does in one message. Measured,
 * the two preliminaries cost as much per unit of output as the prompt that did
 * the work.
 *
 * These hold the collapse in place: the documents ride along with the first
 * prompt instead of being a turn, and the judgement is made in the same reply as
 * the work it decides on.
 */

import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

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

/*
 * A stand-in for the CLI that records each time it is run. What is being counted
 * is processes, so counting them for real — rather than trusting a reading of
 * the code — is the whole point of the exercise.
 */
const root = await mkdtemp(path.join(tmpdir(), 'one-prompt-'));
const ledger = path.join(root, 'invocations');
const fake = path.join(root, 'fake-claude');
await writeFile(
  fake,
  `#!/bin/sh
cat >> ${JSON.stringify(ledger)}.stdin
echo "$@" >> ${JSON.stringify(ledger)}.args
echo "run" >> ${JSON.stringify(ledger)}
echo '{"result":"ok","session_id":"11111111-1111-1111-1111-111111111111","num_turns":1,"is_error":false}'
`
);
await chmod(fake, 0o755);

process.env.CLAUDE_BIN = fake;
process.env.CLAUDE_PERMISSION_MODE = '';

const { openSession } = await import('../src/claude.js');
const { buildPrompt, buildAnswersBlock } = await import('../src/prompts.js');

const runs = async () => (await readFile(ledger, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).length;
const sent = async () => readFile(`${ledger}.stdin`, 'utf8').catch(() => '');

await check('documents and the first prompt are one process, not two', async () => {
  const session = openSession({
    cwd: root,
    preamble: () => 'THE DOCUMENTS GO HERE',
    timeoutMs: 30000,
  });
  await session.send('THE ACTUAL WORK');

  assert.equal(await runs(), 1, 'a preamble must not cost a process of its own');
  const body = await sent();
  assert.ok(body.includes('THE DOCUMENTS GO HERE'), 'the documents still reach Claude');
  assert.ok(body.includes('THE ACTUAL WORK'), 'and so does the prompt');
  assert.ok(
    body.indexOf('THE DOCUMENTS GO HERE') < body.indexOf('THE ACTUAL WORK'),
    'documents first, so they are read before the work is asked for'
  );
});

await check('the conversation window is capped on every turn', async () => {
  /*
   * The flag a resumed round depends on. A revision arrives long after the
   * five-minute cache window has closed, so the whole conversation is written
   * again at full price before any work starts — bounded here, or not at all.
   */
  const before = await runs();
  const session = openSession({ cwd: root, timeoutMs: 30000, autocompact: '150000' });
  await session.send('WORK');
  assert.equal(await runs(), before + 1);

  const args = await readFile(`${ledger}.args`, 'utf8').catch(() => '');
  assert.match(args, /--autocompact 150000/, 'the window never reached the CLI');
});

await check('a resumed round gets the tighter window than a fresh one', async () => {
  /*
   * A build starts from nothing, so the window never binds on it. A resumed
   * round starts by re-writing everything the task has said so far — 159k on a
   * measured revision — and that is the write worth bounding as hard as the CLI
   * allows.
   */
  const { config } = await import('../src/config.js');
  assert.ok(
    Number(config.claude.autocompactResumed) < Number(config.claude.autocompact),
    'a resumed round must not be given the wider window'
  );
  // 100k is the CLI's floor; asking for less is refused, so this is the most
  // that can be bounded without the round doing less work.
  assert.equal(Number(config.claude.autocompactResumed), 100000);
});

await check('a build asks for the judgement and the work in the same breath', async () => {
  const prompt =
    (await buildPrompt({ uid: 'u', taskDir: '/tmp/u', initialInfos: 'infos' })) +
    (await buildAnswersBlock());

  // The judgement, on its own line, so readVerdict() can find it.
  assert.match(prompt, /fixable, invalid, or valid-as-is/i);
  // And the work, in the same message rather than after a round trip.
  assert.match(prompt, /make the corrections in this task directory/i);
  assert.doesNotMatch(
    prompt,
    /before i order|let me know first|do not do anything/i,
    'nothing may tell it to stop and wait for a second prompt'
  );
});

await check('all three judgements have their questions in that one prompt', async () => {
  const block = await buildAnswersBlock();
  for (const verdict of ['FIXABLE', 'INVALID', 'VALID-AS-IS']) {
    assert.ok(block.includes(`judgement is ${verdict}`), `${verdict} has no questions`);
  }
  /*
   * The point of carrying all three: a non-fixable verdict must not have to be
   * asked for its answers afterwards, or the saved prompt comes straight back.
   */
  assert.match(block, /answer only the set that matches your judgement/i);
});

await rm(root, { recursive: true, force: true });
console.log(failures ? `\n${failures} one-prompt check(s) failed` : '\none job, one prompt');
process.exit(failures ? 1 : 0);
