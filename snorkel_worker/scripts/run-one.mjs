/*
 * run-one.mjs — work a single named task and stop.
 *
 *   npm run once -- <UID>
 *   npm run once -- <UID> --dry     print the prompts, run nothing
 *
 * The loop is the normal way in. This exists for the first run, when you want to
 * watch one task go through end to end without waiting for a poll, and for the
 * case where a task failed and you want to retry just that one.
 */

import { config } from '../src/config.js';
import { initFirebase, claimTask, getTask, releaseTask, WORKABLE } from '../src/firebase.js';
import { initRtdb } from '../src/rtdb.js';
import { workOnTask, findTaskDir } from '../src/task.js';
import { lockHolder } from '../src/lock.js';
import {
  documentPaths,
  fixPrompt,
  introPrompt,
  revisionPrompt,
  staticFixPrompt,
  triagePrompt,
} from '../src/prompts.js';
import { failedCheckLogs } from '../src/task.js';
import { TASK_STATUS_BUILD, TASK_STATUS_STATIC_FAIL } from '../src/firebase.js';

const args = process.argv.slice(2);
const uid = args.find((a) => !a.startsWith('-'));
const dry = args.includes('--dry');

if (!uid) {
  console.error('Usage: npm run once -- <UID> [--dry]');
  process.exit(1);
}

/*
 * This does not take the machine's worker lock. It is a deliberate, one-named-
 * task command, and the Firestore claim is what stops it colliding with the
 * loop — the loop simply will not see a task this has already claimed. Worth
 * saying out loud though, because two Claude sessions at once is a surprise if
 * you did not mean it.
 */
const holder = await lockHolder();
if (holder) {
  console.warn(
    `Note: the worker loop is running (pid ${holder.pid}). This task will be claimed ` +
      `here, so the loop will not touch it — but both will be using Claude at once.\n`
  );
}

await initFirebase();
await initRtdb();

const task = await getTask(uid);
if (!task) {
  console.error(`No task ${uid} in ${config.firebase.collection}.`);
  process.exit(1);
}

if (!WORKABLE.includes(task.task_status)) {
  console.error(
    `${uid} is "${task.task_status}". The worker only picks up ${WORKABLE.map((s) => `"${s}"`).join(' or ')}.`
  );
  process.exit(1);
}

if (dry) {
  const taskDir = (await findTaskDir(uid)) || '(would be downloaded and unpacked)';
  const docs = await documentPaths();

  /*
   * A revision and a static fix continue the conversation that built the task,
   * so turn one is only sent when there is no session to go back to — and the
   * dry run says which case this is rather than always printing it.
   */
  const resumes = task.task_status !== TASK_STATUS_BUILD && Boolean(task.worker_session_id);

  const turns = [];
  if (task.task_status === TASK_STATUS_BUILD) {
    turns.push(['triage', await triagePrompt({ uid, taskDir, initialInfos: task.initial_infos })]);
    turns.push(['fix (only if triage says fixable)', await fixPrompt({ uid, taskDir })]);
  } else if (task.task_status === TASK_STATUS_STATIC_FAIL) {
    turns.push(['static fix', await staticFixPrompt({ uid, taskDir, logs: failedCheckLogs(task) })]);
  } else {
    turns.push([
      'revision',
      await revisionPrompt({
        uid,
        taskDir,
        feedbacks: task.feedbacks,
        applied: task.revision_notes_applied || [],
      }),
    ]);
  }

  if (resumes) {
    console.log(`(resuming session ${task.worker_session_id} — the documents are already in it)\n`);
  } else {
    console.log('='.repeat(70));
    console.log('TURN 1  intro');
    console.log('='.repeat(70));
    console.log(await introPrompt(docs));
  }

  let n = resumes ? 0 : 1;
  for (const [label, text] of turns) {
    console.log('\n' + '='.repeat(70));
    console.log(`TURN ${++n}  ${label}  (${task.task_status})`);
    console.log('='.repeat(70));
    console.log(text);
  }
  process.exit(0);
}

const claimed = await claimTask(uid, task.task_status);
if (!claimed) {
  console.error(`Could not claim ${uid} — its status changed. Is the worker already running?`);
  process.exit(1);
}

try {
  const result = await workOnTask(claimed, {
    log: (emoji, event, message) => console.log(`${emoji}  ${event}: ${message}`),
    onSession: (line) => line.trim() && console.log(`   | ${line.trim()}`),
  });
  console.log('\nDone:', JSON.stringify(result, null, 2));
  process.exit(0);
} catch (err) {
  console.error(`\nFailed: ${err.message}`);
  await releaseTask(uid, task.task_status, err.message);
  process.exit(1);
}
