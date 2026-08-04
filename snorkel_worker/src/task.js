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
import { openSession } from './claude.js';
import {
  documentPaths,
  extractPrompt,
  fixPrompt,
  introPrompt,
  revisionPrompt,
  lessonPrompt,
  staticFixPrompt,
  triagePrompt,
} from './prompts.js';
import { normaliseAnswers, parseJsonReply } from './answers.js';
import { lessonsBlock, recordLesson } from './lessons.js';
import {
  TASK_STATUS_BUILD,
  TASK_STATUS_INVALID,
  TASK_STATUS_STATIC_FAIL,
  TASK_STATUS_VALID_AS_IS,
  markDownloaded,
  markReady,
  markTriaged,
  patchTask,
  saveAnswers,
} from './firebase.js';

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
 * Reads fixable / invalid / valid-as-is out of the triage reply.
 *
 * The prompt asks for the word on its own first line, and usually that is what
 * comes back. The whole reply is searched as a fallback, because a run should
 * not be thrown away over a sentence of preamble — but a reply with no verdict
 * in it at all is a real failure and is treated as one.
 */
export function readVerdict(text) {
  const body = String(text || '').trim();
  const first = body.split('\n')[0].trim().toLowerCase();

  const match = (haystack) => {
    // valid-as-is before fixable: "valid as is" contains neither, but a reply
    // saying "not fixable, it is invalid" must not be read as fixable.
    if (/\bvalid[\s-]*as[\s-]*is\b/.test(haystack)) return 'valid-as-is';
    if (/\binvalid\b|\bnot fixable\b/.test(haystack)) return 'invalid';
    if (/\bfixable\b/.test(haystack)) return 'fixable';
    return null;
  };

  const verdict = match(first) || match(body.toLowerCase());
  if (!verdict) {
    throw new Error(
      `Could not read a verdict from the triage answer. It started: ${body.slice(0, 200)}`
    );
  }

  // Everything after the verdict line is the reason, which is worth keeping for
  // a task that stops here — it is the only explanation anyone will get.
  const note = body.split('\n').slice(1).join('\n').trim();
  return { verdict, note: note.slice(0, 4000) };
}

/** The build logs from whichever platform checks failed. */
export function failedCheckLogs(task) {
  const results = task.static_check_result?.results || [];
  const failed = results.filter((r) => r.verdict !== 'pass');
  if (!failed.length) return '';

  return failed
    .map((r) => `--- ${r.label}: ${String(r.verdict || 'unknown').toUpperCase()} ---\n${r.summary || ''}\n\n${r.logs || '(no build logs were captured)'}`)
    .join('\n\n');
}

/**
 * The zip to upload.
 *
 * Claude is asked to build one in the task folder, named after the original
 * directory, because the platform expects that name. If it did so, that is the
 * file to send — repacking the folder ourselves would produce a different
 * archive from the one it just checked its own work against.
 *
 * Falling back to packing the folder keeps a run that got everything else right
 * from failing over a missing file.
 */
async function zipToUpload(task, taskDir) {
  const zips = [];
  for (const entry of await readdir(taskDir, { withFileTypes: true })) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.zip') continue;
    const full = path.join(taskDir, entry.name);
    zips.push({ name: entry.name, path: full, mtime: (await stat(full)).mtimeMs });
  }

  if (zips.length) {
    // Newest wins: an earlier round's zip may still be sitting there.
    zips.sort((a, b) => b.mtime - a.mtime);
    return { path: zips[0].path, name: zips[0].name, madeByClaude: true };
  }

  const name = await zipNameFor(task, taskDir);
  const out = path.join(config.workDir, name);
  await zipFolder(taskDir, out);
  return { path: out, name, madeByClaude: false };
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
 * Puts a finished task's zip back in Dropbox, without involving Claude.
 *
 * For a task the server already handed to the browser and then deleted from
 * Dropbox, where the browser failed before attaching it. The work is long done
 * and the folder is still here; all that is missing is the file.
 */
export async function reuploadTask(task, { log } = {}) {
  const uid = String(task.UID || task.id);
  const say = log || (() => {});

  const taskDir = await findTaskDir(uid);
  if (!taskDir) {
    const looked = [config.workDir, ...config.extraTaskDirs].join(', ');
    throw new Error(
      `No folder for ${uid}, so its zip cannot be rebuilt — looked in: ${looked}. ` +
        `The task will need building again.`
    );
  }

  const { path: outZip, name: zipName, madeByClaude } = await zipToUpload(task, taskDir);
  say('⬆️', 'reupload', `putting ${zipName} back in Dropbox`);

  const uploaded = await uploadFile(outZip, { fileName: zipName });
  if (!madeByClaude) await rm(outZip, { force: true });

  await markReady(uid, {
    file_name: zipName,
    dropbox_path: uploaded.dropbox_path,
    local_path: taskDir,
    // Cleared so this is not mistaken for another lost upload next time round.
    submit_file_served_at: null,
  });

  say('🔁', 'reupload_done', `${uid} has a file again and can be submitted`);
  return { uid, taskDir, zipName, dropboxPath: uploaded.dropbox_path };
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
        `No folder for ${uid}. A task at "${from}" is worked in place and is never ` +
          `downloaded, so its folder has to be on disk already — looked for ` +
          `"${uid}_submission" in: ${looked}. Move the folder there, or add its ` +
          `location to EXTRA_TASK_DIRS.`
      );
    }
    say('📂', 'found', `working in ${taskDir}`);
  }

  // ------------------------------------------------------------- Claude ---
  const rounds = Array.isArray(task.feedbacks) ? task.feedbacks.length : 0;

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
        `still working ${uid} — ${Math.round((Date.now() - beatStarted) / 60000)} min so far`
      ),
    HEARTBEAT_MS
  );
  heartbeat.unref?.();

  /*
   * A failed platform check is answered inside the conversation that produced
   * the task, not a new one. That session still holds the documents, the files
   * it read and the answers it wrote, so "fix this and rewrite the answers"
   * means something. Starting fresh would pay to read all of it again and hope
   * for the same conclusions.
   */
  const session = openSession({
    cwd: taskDir,
    // The documents sit outside the task folder, so Claude has to be allowed to
    // read there explicitly.
    addDirs: config.docsDir ? [config.docsDir] : [],
    timeoutMs,
    label: uid,
    resume: from === TASK_STATUS_STATIC_FAIL ? task.worker_session_id || null : null,
    onLog: (line) => onSession && onSession(line),
  });

  let stage = 'revision';
  let triage = null;

  try {
    if (from === TASK_STATUS_STATIC_FAIL) {
      // ---- the platform rejected the last upload -------------------------
      stage = 'build';
      const logs = failedCheckLogs(task);
      if (!logs) {
        throw new Error(`${uid} is at "${from}" but has no static_check_result logs to work from.`);
      }

      const attempt = Number(task.static_fix_attempts || 0) + 1;
      say('🔁', 'static_fix', `${uid} failed the platform checks — fixing (attempt ${attempt})`);

      // Only intro if this is not a resumed conversation; a resumed one has it.
      if (!task.worker_session_id) await session.send(await introPrompt(docs));
      await session.send(await staticFixPrompt({ uid, taskDir, logs, lessons: await lessonsBlock() }));
      await patchTask(uid, { static_fix_attempts: attempt });

      /*
       * Write down what fixed it, against the signatures this failure was filed
       * under. Recorded now but not trusted yet: snorkel_server marks it
       * confirmed only if the platform actually passes the next upload, so a
       * lesson that turns out to be wrong never reaches another task.
       */
      const lesson = await session.send(await lessonPrompt());
      const written = await recordLesson(task.static_check_signatures, lesson.text);
      if (written) say('📚', 'lesson', `noted what fixed this, against ${written} known failure(s)`);
    } else if (from === TASK_STATUS_BUILD) {
      // ---- a first build -------------------------------------------------
      stage = 'build';
      say('🧠', 'claude_start', `building ${uid} with ${docs.length} document(s) attached`);

      await session.send(await introPrompt(docs));
      const verdict = await session.send(
        await triagePrompt({ uid, taskDir, initialInfos: task.initial_infos })
      );

      triage = readVerdict(verdict.text);
      say('🔎', 'triage', `${uid} is ${triage.verdict}`);

      /*
       * Anything but fixable ends the run here. There are no corrections to
       * make and no form to fill in, so asking for them would only produce
       * answers about work that was never done.
       */
      if (triage.verdict !== 'fixable') {
        clearInterval(heartbeat);
        const status = triage.verdict === 'invalid' ? TASK_STATUS_INVALID : TASK_STATUS_VALID_AS_IS;
        await markTriaged(uid, status, triage.note);
        say('🛑', 'triage_stop', `${uid} -> "${status}", nothing to build`);
        return {
          uid,
          from,
          taskDir,
          triage: triage.verdict,
          status,
          sessionId: session.id,
          costUsd: session.costUsd,
          durationMs: session.durationMs,
        };
      }

      await session.send(await fixPrompt({ uid, taskDir, lessons: await lessonsBlock() }));
    } else {
      // ---- a reviewer sent it back ---------------------------------------
      say('🧠', 'claude_start', `revising ${uid} from ${rounds} feedback round(s)`);
      await session.send(await introPrompt(docs));
      await session.send(await revisionPrompt({ uid, taskDir, feedbacks: task.feedbacks }));
    }

    // The answers as prose are what a person reads; this turn is the same thing
    // per field, so it can be stored and pasted into the form.
    await session.send(await extractPrompt(stage));
  } finally {
    clearInterval(heartbeat);
  }

  say(
    '✅',
    'claude_done',
    `${uid} finished in ${Math.round(session.durationMs / 1000)}s` +
      (session.costUsd ? ` ($${session.costUsd.toFixed(2)})` : '')
  );

  // ------------------------------------------------------- the answers ----
  /*
   * The turn before last is the answer as a person would write it; the last is
   * that same answer per field. Both are kept: the prose goes into any box the
   * schema does not cover, and it is the only way to tell a bad answer from a
   * bad extraction of a good one.
   */
  const turns = session.turns;
  const prose = turns.length > 1 ? turns[turns.length - 2].text : '';
  const { answers, ignored, problems } = await normaliseAnswers(
    parseJsonReply(turns[turns.length - 1].text)
  );

  if (triage && !answers.validity_required) answers.validity_required = triage.verdict;

  if (ignored.length) {
    say('⚠️', 'answers_extra', `ignored key(s) not in the schema: ${ignored.join(', ')}`);
  }
  for (const problem of problems) say('⚠️', 'answers_value', problem);

  const saved = await saveAnswers(uid, answers, {
    from,
    session_id: session.id,
    // Lines an answer round up with the feedback round it responds to.
    feedback_rounds: rounds,
    text: prose,
  });

  say(
    '📝',
    'answers_saved',
    `${saved.fields} field(s) stored` +
      (saved.changed.length ? `, changed: ${saved.changed.join(', ')}` : ', nothing changed')
  );

  // -------------------------------------------------------- back up -------
  const { path: outZip, name: zipName, madeByClaude } = await zipToUpload(task, taskDir);
  say('📦', 'packed', `${zipName}${madeByClaude ? ' (built by Claude)' : ' (packed from the folder)'}`);

  say('⬆️', 'upload', `uploading ${zipName}`);
  const uploaded = await uploadFile(outZip, { fileName: zipName });

  // Only remove what we made ourselves. A zip Claude built belongs to the task
  // folder and is what the next round starts from.
  if (!madeByClaude) await rm(outZip, { force: true });

  await markReady(uid, {
    file_name: zipName,
    dropbox_path: uploaded.dropbox_path,
    local_path: taskDir,
    worker_session_id: session.id,
    worker_cost_usd: session.costUsd || null,
  });

  say('🏁', 'ready', `${uid} is ready to submit (answers round ${saved.round})`);

  return {
    uid,
    from,
    taskDir,
    answerFields: saved.fields,
    answersRound: saved.round,
    sessionId: session.id,
    dropboxPath: uploaded.dropbox_path,
    costUsd: session.costUsd,
    durationMs: session.durationMs,
  };
}
