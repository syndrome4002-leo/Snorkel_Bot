/*
 * task.js — one task, start to finish.
 *
 * Two entry states, one exit state:
 *
 *   "in build"        the zip is on Dropbox. Fetch it, delete it there, unpack
 *                     it, work it, pack it, put it back.
 *   "needs revision"  the folder is already on disk. Work it from the feedback,
 *                     pack it, put it back.
 *
 * Both end at "ready to submit" with the answer recorded.
 *
 * The order of the Dropbox steps is deliberate. The file is deleted remotely
 * *after* it is safely on disk and Firestore has been told, so an interruption
 * can never leave a task whose only copy has just been deleted.
 */

import { rm, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { unzipTo, zipFolder } from './archive.js';
import { downloadFile, deleteFile, uploadFile } from './dropbox.js';
import { runSession } from './claude.js';
import { buildPrompt, documentPaths, introPrompt, revisionPrompt } from './prompts.js';
import { TASK_STATUS_BUILD, appendAnswer, markDownloaded, markReady, patchTask } from './firebase.js';

/** How often a long build says it is still alive. */
const HEARTBEAT_MS = 5 * 60 * 1000;

async function isDirectory(p) {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Where a task's folder is, or null.
 *
 * The naming convention is `<uid>_submission`, but a bare `<uid>` and a folder
 * merely starting with the uid are both accepted — these folders are unpacked by
 * hand often enough that being strict would just mean failing on a typo.
 */
export async function findTaskDir(uid) {
  const roots = [config.workDir, ...config.extraTaskDirs];
  const exact = [`${uid}_submission`, String(uid)];

  for (const root of roots) {
    for (const name of exact) {
      const candidate = path.join(root, name);
      if (await isDirectory(candidate)) return candidate;
    }
  }

  for (const root of roots) {
    let entries = [];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue; // a configured folder that does not exist is not an error here
    }
    const match = entries.find((e) => e.isDirectory() && e.name.startsWith(String(uid)));
    if (match) return path.join(root, match.name);
  }

  return null;
}

/** Where a task's folder should be created. */
export function taskDirFor(uid) {
  return path.join(config.workDir, `${uid}_submission`);
}

/**
 * The name to pack back up under.
 *
 * Prefers the name the platform gave the download, then any zip left in the
 * folder from an earlier round — the name is how a person recognises the file in
 * Dropbox, so inventing a new one for every round would be unhelpful.
 */
async function zipNameFor(task, taskDir) {
  if (task.file_name) return path.basename(task.file_name);

  try {
    const zips = (await readdir(taskDir)).filter((n) => n.toLowerCase().endsWith('.zip'));
    if (zips.length) return zips.sort()[0];
  } catch {
    // fall through
  }
  return `${path.basename(taskDir)}.zip`;
}

/**
 * Fetches a task's zip and unpacks it, removing it from Dropbox on the way.
 *
 * Deleting it is what makes Dropbox a handover point rather than a copy: while a
 * file is there, nobody is working on that task.
 */
async function fetchAndUnpack(task, log) {
  const remote = task.dropbox_path || task.file_name;
  if (!remote) {
    throw new Error(
      `Task ${task.UID} is "in build" but has no dropbox_path or file_name, so there is nothing to fetch.`
    );
  }

  const zipName = path.basename(remote);
  const localZip = path.join(config.workDir, zipName);

  log('⬇️', 'download', `fetching ${remote}`);
  const downloaded = await downloadFile(remote, localZip);

  // Recorded before the delete: if the process dies here, the record already
  // says the file is no longer in Dropbox and points at the local copy.
  await markDownloaded(task.UID, localZip);

  log('🗑️', 'dropbox_clear', `removing ${downloaded.path} from Dropbox`);
  await deleteFile(downloaded.path);

  const taskDir = taskDirFor(task.UID);
  await unzipTo(localZip, taskDir);
  // The folder is the working copy now; the archive it came from is redundant.
  await rm(localZip, { force: true });
  // Point local_path at what actually exists. Until the unpack succeeded the zip
  // was the only copy, which is why it was recorded first.
  await patchTask(task.UID, { local_path: taskDir });

  log('📂', 'unpacked', `${zipName} -> ${taskDir}`);
  return taskDir;
}

/**
 * Runs one task through Claude and puts the result back.
 *
 * `task` is the record as it looked *before* being claimed, so `worked_from`
 * tells us which of the two paths to take.
 */
export async function workOnTask(task, { log, onSession } = {}) {
  const uid = String(task.UID || task.id);
  const from = task.task_status;
  const say = log || (() => {});

  const timeoutMs = config.worker.taskTimeoutMinutes * 60 * 1000;
  const docs = await documentPaths();

  // ---------------------------------------------------------- the folder --
  let taskDir;
  if (from === TASK_STATUS_BUILD) {
    /*
     * A second attempt must not try to download again. The first attempt deletes
     * the zip from Dropbox as soon as it has it, so a task that failed after
     * that point would otherwise fail forever on a file that is no longer there.
     *
     * `downloaded_at` with no `dropbox_path` is the proof that this worker
     * already fetched it — a stamp rather than merely "a folder exists", so a
     * leftover folder from an unrelated run cannot be mistaken for a download.
     */
    const alreadyFetched = task.downloaded_at && !task.dropbox_path ? await findTaskDir(uid) : null;

    if (alreadyFetched) {
      taskDir = alreadyFetched;
      say('📂', 'resumed', `already downloaded — working in ${taskDir}`);
    } else {
      taskDir = await fetchAndUnpack(task, say);
    }
  } else {
    taskDir = await findTaskDir(uid);
    if (!taskDir) {
      const looked = [config.workDir, ...config.extraTaskDirs].join(', ');
      throw new Error(
        `No folder for ${uid}. A task needing revision is worked in place, so its folder ` +
          `has to be on disk already — looked for "${uid}_submission" in: ${looked}. ` +
          `Move the folder there, or add its location to EXTRA_TASK_DIRS.`
      );
    }
    say('📂', 'found', `working in ${taskDir}`);
  }

  // ------------------------------------------------------------- Claude ---
  const prompts = [
    await introPrompt(docs),
    from === TASK_STATUS_BUILD
      ? await buildPrompt({ uid, taskDir, initialInfos: task.initial_infos })
      : await revisionPrompt({ uid, taskDir, feedbacks: task.feedbacks }),
  ];

  const rounds = Array.isArray(task.feedbacks) ? task.feedbacks.length : 0;
  say(
    '🧠',
    'claude_start',
    from === TASK_STATUS_BUILD
      ? `building ${uid} with ${docs.length} document(s) attached`
      : `revising ${uid} from ${rounds} feedback round(s)`
  );

  /*
   * A build is quiet for a long time — Claude reads, edits and runs tests
   * without saying anything until it is done. On the dashboard that looks
   * identical to a hung task, so mark the time every few minutes. Cheap, and it
   * is the difference between "still going" and "something is wrong".
   */
  const beatStarted = Date.now();
  const heartbeat = setInterval(
    () =>
      say(
        '⏳',
        'claude_working',
        `still building ${uid} — ${Math.round((Date.now() - beatStarted) / 60000)} min so far`
      ),
    HEARTBEAT_MS
  );
  heartbeat.unref?.();

  let session;
  try {
    session = await runSession(prompts, {
      cwd: taskDir,
      // The documents sit outside the task folder, so Claude has to be allowed
      // to read there explicitly.
      addDirs: config.docsDir ? [config.docsDir] : [],
      timeoutMs,
      label: uid,
      onLog: (line) => onSession && onSession(line),
    });
  } finally {
    clearInterval(heartbeat);
  }

  say(
    '✅',
    'claude_done',
    `${uid} finished in ${Math.round(session.durationMs / 1000)}s` +
      (session.costUsd ? ` ($${session.costUsd.toFixed(2)})` : '')
  );

  // ------------------------------------------------------- the answer -----
  const answerRound = await appendAnswer(uid, {
    text: session.finalText,
    written_at: new Date().toISOString(),
    from,
    session_id: session.sessionId,
    // Lines up an answer with the feedback round it responds to.
    feedback_rounds: rounds,
  });

  // -------------------------------------------------------- back up -------
  const zipName = await zipNameFor(task, taskDir);
  const outZip = path.join(config.workDir, zipName);
  await zipFolder(taskDir, outZip);

  say('⬆️', 'upload', `uploading ${zipName}`);
  const uploaded = await uploadFile(outZip, { fileName: zipName });

  // Dropbox has it; a second copy in the downloads folder is only clutter. The
  // unpacked folder stays — the next revision round works in it.
  await rm(outZip, { force: true });

  await markReady(uid, {
    file_name: zipName,
    dropbox_path: uploaded.dropbox_path,
    local_path: taskDir,
    worker_session_id: session.sessionId,
    worker_cost_usd: session.costUsd || null,
  });

  say('🏁', 'ready', `${uid} is ready to submit (answer round ${answerRound})`);

  return {
    uid,
    from,
    taskDir,
    answerRound,
    sessionId: session.sessionId,
    dropboxPath: uploaded.dropbox_path,
    costUsd: session.costUsd,
    durationMs: session.durationMs,
  };
}
