/*
 * One task, one conversation — for every prompt it ever gets.
 *
 * The rule used to be about status: a revision or a failed check continued the
 * previous session, a build started one. But a build that failed and is being
 * tried again is not a new task, and treating it as one is how a single task
 * accumulated nine conversations on disk, each of them reading the whole folder
 * from scratch before doing anything.
 *
 * So the folder decides. These check the lookup that answers "what conversation
 * has this task been having", including against Claude Code's real layout.
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';

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
 * The sessions live under CLAUDE_CONFIG_DIR, so pointing that at a scratch
 * directory lets these run against a made-up layout without touching the real
 * one — and without the tests depending on what this machine happens to hold.
 */
const root = await mkdtemp(path.join(tmpdir(), 'sessions-'));
process.env.CLAUDE_CONFIG_DIR = root;
const { latestSessionFor } = await import('../src/claude.js');

const slug = (p) => String(p).replace(/[^a-zA-Z0-9]/g, '-');

async function conversation(taskDir, id, minutesAgo) {
  const dir = path.join(root, 'projects', slug(taskDir));
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  await writeFile(file, '{}\n');
  const when = new Date(Date.now() - minutesAgo * 60000);
  await utimes(file, when, when);
}

const TASK = '/home/someone/Downloads/abc123_submission';

await check('a folder that has never been worked starts fresh', async () => {
  assert.equal(await latestSessionFor('/home/someone/Downloads/never_submission'), null);
});

await check('the one conversation a task has is the one it continues', async () => {
  await conversation(TASK, 'session-one', 10);
  assert.equal(await latestSessionFor(TASK), 'session-one');
});

await check('with several, the most recent is continued — not a tenth', async () => {
  // The 2fa5025c case: nine conversations, none of them recorded on the task.
  await conversation(TASK, 'older', 120);
  await conversation(TASK, 'newest', 1);
  assert.equal(await latestSessionFor(TASK), 'newest');
});

await check('the id on the task record wins while it still exists', async () => {
  // The record is authoritative where it can be; the folder is the fallback.
  assert.equal(await latestSessionFor(TASK, 'older'), 'older');
});

await check('and is ignored once its conversation is gone', async () => {
  // A stored id whose file the CLI has since pruned. Falling back beats
  // starting over: the newest surviving conversation still knows the task.
  assert.equal(await latestSessionFor(TASK, 'pruned-long-ago'), 'newest');
});

await check('one task’s conversation is never offered to another', async () => {
  const other = '/home/someone/Downloads/different_submission';
  assert.equal(await latestSessionFor(other), null);
});

await check('the slug matches Claude Code’s real directory layout', async () => {
  /*
   * The lookup reproduces a naming rule that belongs to the CLI, so it is worth
   * holding against the real thing rather than only against itself. Skipped
   * where there is nothing real to compare with.
   */
  const projects = path.join(homedir(), '.claude', 'projects');
  if (!existsSync(projects)) return;
  const real = '/home/goran/Downloads/08f2d5cc-ea39-4536-a3bb-738019883865_submission';
  const expected = '-home-goran-Downloads-08f2d5cc-ea39-4536-a3bb-738019883865-submission';
  assert.equal(slug(real), expected);
});

/*
 * And the question above it: should this task continue anything at all?
 *
 * Conversations outlive the tasks they were had for. A task deleted from the
 * dashboard and built again gets a new record but the same folder, and the
 * folder still holds the old task's sessions — so "continue whatever is here"
 * had a fresh build adopting a conversation about work it had never done.
 */
const { conversationFor } = await import('../src/task.js');

await check('a task built for the first time starts its own conversation', async () => {
  // The folder is full of history belonging to a task that was deleted.
  await conversation(TASK, 'belongs-to-a-deleted-task', 5);
  assert.equal(await conversationFor({ UID: 'new' }, TASK), null);
});

await check('a task adopted from the revise list does too', async () => {
  // Somebody else built and submitted it; this worker has never had a session.
  assert.equal(await conversationFor({ UID: 'adopted', feedbacks: [{}, {}] }, TASK), null);
});

await check('a task this worker has run continues that conversation', async () => {
  assert.equal(
    await conversationFor({ UID: 'ours', worker_session_id: 'newest' }, TASK),
    'newest'
  );
});

await check('a recorded conversation that was pruned falls back within the folder', async () => {
  const id = await conversationFor({ UID: 'ours', worker_session_id: 'gone' }, TASK);
  assert.ok(id && id !== 'gone', 'the same task’s newest surviving conversation');
});

await check('turning resuming off starts fresh however much history there is', async () => {
  assert.equal(
    await conversationFor({ UID: 'ours', worker_session_id: 'newest' }, TASK, {
      resumeSessions: false,
    }),
    null
  );
});

await rm(root, { recursive: true, force: true });
console.log(failures ? `\n${failures} session check(s) failed` : '\nthe one-session rule holds');
process.exit(failures ? 1 : 0);
