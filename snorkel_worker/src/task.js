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
  noteFingerprint,
  revisionPrompt,
  rewritePrompt,
  reviewerNotes,
  lessonPrompt,
  staticFixPrompt,
  triagePrompt,
  verdictPrompt,
} from './prompts.js';
import {
  issueFormatProblems,
  missingVerdicts,
  normaliseAnswers,
  parseJsonReply,
  processNarration,
  wrappedLines,
} from './answers.js';
import { lessonsBlock, recordLesson } from './lessons.js';
import { signaturesOf } from './checksigns.js';
import {
  TASK_STATUS_BUILD,
  TASK_STATUS_NEEDS_REVISION,
  TASK_STATUS_STATIC_FAIL,
  markDownloaded,
  markReady,
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

/**
 * Whether a folder holds anything.
 *
 * An empty folder is what a half-finished unpack leaves behind, and treating one
 * as a completed download would hand Claude an empty working directory and call
 * it a resume.
 */
async function hasContent(dir) {
  try {
    return (await readdir(dir)).length > 0;
  } catch {
    return false;
  }
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
    /*
     * Never the difficulty artefact, however new it is. It is deleted before we
     * get here, but a run that died between fetching and packing would leave one
     * behind — and uploading the platform's own check results as the task is not
     * a mistake worth leaving one failure away.
     */
    if (/^difficulty_/i.test(entry.name)) continue;
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
 * Puts the difficulty check results into the task folder, if there are any.
 *
 * The platform attaches this once it has run the task: the agent simulation and
 * the per-verifier statistics behind the difficulty summary. The browser
 * downloaded it on another machine, so it comes back through Dropbox like
 * everything else.
 *
 * Returns the file name for the prompt to point at, or null. Never throws — a
 * revision without it is the revision we did yesterday, and losing the round
 * over an optional attachment would be a poor trade.
 */
async function fetchDifficultyFile(task, taskDir, say) {
  const meta = task.difficulty_file;
  if (!meta || !meta.dropbox_path) return null;

  const name = meta.name || path.basename(meta.dropbox_path);
  const target = path.join(taskDir, name);

  try {
    // Already here from an earlier round; no reason to fetch it twice.
    if (await stat(target).then(() => true).catch(() => false)) return name;

    await downloadFile(meta.dropbox_path, target);
    say('📐', 'difficulty_file', `${name} put in the task folder`);

    /*
     * Out of Dropbox now that it is on disk, and in that order.
     *
     * The record is cleared first so an interruption cannot leave a task
     * pointing at a file that has just been deleted — the same reason the task
     * zip is recorded before its remote copy goes. Losing the delete instead
     * leaves one orphan file, which is the cheaper of the two failures.
     *
     * `dropbox_path` going null is also what stops the next round trying to
     * fetch it again: the guard at the top of this function reads an absent path
     * as "there is nothing waiting", which is exactly true.
     */
    await patchTask(String(task.UID || task.id), {
      difficulty_file: { ...meta, dropbox_path: null, fetched_at: new Date().toISOString() },
    });
    await deleteFile(meta.dropbox_path);
    say('🗑️', 'difficulty_file', `${name} removed from Dropbox — the folder has it now`);

    return name;
  } catch (err) {
    say('⚠️', 'difficulty_file_failed', `could not fetch ${name}: ${err.message}`, { level: 'warn' });
    return null;
  }
}

/**
 * Removes a task's folder from this machine.
 *
 * Only the folder. The database record and the Dropbox copy are the server's to
 * clear — this is the one part that can only be done where the files are.
 *
 * `findTaskDir` is used rather than a computed path, because a folder unpacked
 * by hand may not follow the naming convention, and deleting the wrong
 * directory is not a mistake worth risking to save a lookup.
 */
export async function deleteTaskFolder(uid) {
  const taskDir = await findTaskDir(uid);
  if (!taskDir) return { deleted: false, reason: 'no folder for it on this machine' };

  /*
   * A last check that this is what it claims to be. `findTaskDir` matches a
   * folder merely starting with the uid, and rm -rf on a path that came over the
   * network deserves one more look than that.
   */
  if (!path.basename(taskDir).startsWith(String(uid))) {
    return { deleted: false, reason: `${taskDir} does not belong to ${uid}` };
  }
  if (path.dirname(taskDir) === taskDir) {
    return { deleted: false, reason: 'refusing to delete a filesystem root' };
  }

  await rm(taskDir, { recursive: true, force: true });
  return { deleted: true, path: taskDir };
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
      try {
        taskDir = await fetchAndUnpack(task, say);
      } catch (err) {
        /*
         * The file is not in Dropbox, and the record says it should be.
         *
         * Which is a contradiction only until you remember what Dropbox is here:
         * a handover point that whoever takes a file empties. So "not there"
         * almost always means an earlier run already took it — and if that run
         * was this worker, the unpacked folder is on this disk right now.
         *
         * The stamp above is the tidy version of this check and misses it when
         * the two fields disagree: `downloaded_at` set and `dropbox_path` still
         * pointing at the file the download deleted. Then the task is asked to
         * fetch a file nobody has, forever, while the work sits in the folder
         * next to it.
         *
         * So the folder is the fallback, and Dropbox's own answer is what
         * triggers it — no guessing about which of the two fields is stale.
         */
        if (err.code !== 'DROPBOX_NOT_FOUND') throw err;

        const onDisk = await findTaskDir(uid);
        if (!onDisk || !(await hasContent(onDisk))) throw err;

        taskDir = onDisk;
        say(
          '📂',
          'resumed',
          `${path.basename(task.dropbox_path || task.file_name || '')} is no longer in Dropbox, ` +
            `but the unpacked folder is here — working in ${taskDir}`,
          { level: 'warn' }
        );

        /*
         * And put the record straight, so the next round takes the quiet path
         * above instead of asking Dropbox the same question again.
         */
        await patchTask(uid, {
          dropbox_path: null,
          file_uploaded: false,
          local_path: taskDir,
          downloaded_at: task.downloaded_at || new Date().toISOString(),
        });
      }
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
  /*
   * A revision continues the conversation too, for the same reason: it already
   * holds the task, the corrections it made and the answers it wrote, so "the
   * reviewer says this is still wrong" lands against work it remembers doing.
   *
   * Unlike a failed check, though, a revision can arrive days later, and Claude
   * Code keeps sessions on disk per project — one cleared out, or a folder moved
   * between machines, means the id no longer resolves. So it is an attempt, not
   * a requirement, and `usedSession` records which way it went, because a fresh
   * conversation needs the documents and a resumed one already has them.
   */
  const resumable = from === TASK_STATUS_STATIC_FAIL || from === TASK_STATUS_NEEDS_REVISION;
  const session = openSession({
    cwd: taskDir,
    // The documents sit outside the task folder, so Claude has to be allowed to
    // read there explicitly.
    addDirs: config.docsDir ? [config.docsDir] : [],
    timeoutMs,
    label: uid,
    resume: resumable ? task.worker_session_id || null : null,
    // Sent before the first turn of any conversation that is not a resumed one,
    // including a resume that turned out to be dead. Nothing below has to know
    // which of those happened.
    preamble: () => introPrompt(docs),
    onLog: (line) => onSession && onSession(line),
  });

  let stage = 'revision';
  let triage = null;
  // The reviewer note this round is answering, so the next round can tell an
  // unchanged note from a new one instead of asking Claude to remember.
  const applied = Array.isArray(task.revision_notes_applied) ? task.revision_notes_applied : [];
  let noteHash = '';
  /*
   * The difficulty artefact, if one was fetched into the folder for this round.
   * Held out here because it goes in before the Claude turns and has to come
   * out again after them, and those are in different branches.
   */
  let difficultyFile = null;

  try {
    if (from === TASK_STATUS_STATIC_FAIL) {
      // ---- the platform rejected the last upload -------------------------
      /*
       * Which set of answer keys this run may write depends on what the upload
       * was, not on the failure. A check that fails on a revision is still a
       * revision, and asking it for the build's keys would leave the reviewer's
       * own questions out of anything it wants to change.
       */
      stage = rounds > 0 ? 'revision' : 'build';
      const logs = failedCheckLogs(task);
      if (!logs) {
        throw new Error(`${uid} is at "${from}" but has no static_check_result logs to work from.`);
      }

      const attempt = Number(task.static_fix_attempts || 0) + 1;
      say('🔁', 'static_fix', `${uid} failed the platform checks — fixing (attempt ${attempt})`);

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

      const verdict = await session.send(
        await triagePrompt({ uid, taskDir, initialInfos: task.initial_infos })
      );

      triage = readVerdict(verdict.text);
      say('🔎', 'triage', `${uid} is ${triage.verdict}`);

      /*
       * Anything but fixable means there is nothing to correct and nothing to
       * upload — but there is still a form to fill in, and it is the only thing
       * the reviewer will read. The run used to stop here, which left that form
       * empty and the task waiting for a person.
       *
       * The questions are a different, much shorter set: the platform drops the
       * upload, the two checks and half the form the moment the verdict is not
       * "fixable".
       */
      if (triage.verdict !== 'fixable') {
        stage = triage.verdict === 'invalid' ? 'invalid' : 'valid-as-is';
        say('🛑', 'triage_stop', `${uid} is ${triage.verdict} — filling in the form that says so`);
        await session.send(await verdictPrompt({ uid, taskDir, verdict: stage }));
      } else {
        await session.send(await fixPrompt({ uid, taskDir, lessons: await lessonsBlock() }));
      }
    } else {
      // ---- a reviewer sent it back ---------------------------------------
      const latest = Array.isArray(task.feedbacks) ? task.feedbacks[task.feedbacks.length - 1] : null;
      const notes = reviewerNotes(latest);
      noteHash = noteFingerprint(notes);
      const seen = noteHash && applied.some((entry) => entry?.hash === noteHash);

      say(
        '🧠',
        'claude_start',
        `revising ${uid} — round ${rounds}, ` +
          (notes ? (seen ? 'the reviewer note repeats an earlier one' : 'a new reviewer note') : 'no reviewer note') +
          `, ${(latest?.checks || []).filter((c) => c.text).length} check pane(s)`
      );

      /*
       * The counter belongs to an upload, not to a task. Leaving the build's
       * tally in place would let one round's spent attempts stop the platform's
       * checks from ever being answered on the next.
       */
      if (Number(task.static_fix_attempts || 0)) await patchTask(uid, { static_fix_attempts: 0 });

      difficultyFile = await fetchDifficultyFile(task, taskDir, say);

      await session.send(
        await revisionPrompt({
          uid,
          taskDir,
          feedbacks: task.feedbacks,
          applied,
          lessons: await lessonsBlock({ source: 'review' }),
          difficultyFile,
        })
      );

      /*
       * Write down what was done about each complaint this round was answering.
       *
       * Recorded now, trusted later: it stays unconfirmed until the NEXT round
       * shows the complaint gone — and snorkel_server refuses to confirm from a
       * round that introduced something new, so a fix that broke the oracle
       * teaches nothing.
       */
      const open = signaturesOf(latest);
      if (open.length) {
        const lesson = await session.send(await lessonPrompt());
        const written = await recordLesson(open, lesson.text, { source: 'review' });
        if (written) {
          say('📚', 'lesson', `noted what was done about ${written} review complaint(s)`);
        }
      }
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
    parseJsonReply(turns[turns.length - 1].text),
    // A verdict run answers the form that verdict produces, whose questions and
    // options are not the fixable form's.
    { stage }
  );

  if (triage && !answers.validity_required) answers.validity_required = triage.verdict;

  /*
   * "Addressed in a previous round" is not an answer.
   *
   * Whoever reads the form sees only the finished submission — no rounds, no
   * feedback, no judge — so an answer written in those terms says nothing. The
   * prompts forbid it, and this is what happens when that does not take: one
   * more turn, showing the model the sentence it wrote, rewriting only the
   * fields that need it.
   *
   * A failed rewrite keeps the original. A clumsy answer is worth having; losing
   * the run over the phrasing is not.
   */
  const narrating = [
    ...processNarration(answers).map((n) => ({ ...n, kind: 'narration' })),
    // Question 3 wants a fixable verdict on every item. The ones that go short
    // are the issues dealt with in an earlier round, which is the same habit as
    // the process talk above and is worth the same one turn to put right.
    ...missingVerdicts(answers).map((head) => ({ key: 'issues_in_detail', kind: 'verdict', match: head })),
    // The shape question 3 asks for: the category in brackets is one that was
    // selected, written as it is written there, on a line of its own.
    ...issueFormatProblems(answers).map((why) => ({ key: 'issues_in_detail', kind: 'format', match: why })),
    // A sentence wrapped at eighty columns turns one part of an item into three,
    // and the item's shape is carried entirely by its line breaks.
    ...wrappedLines(answers).map((where) => ({
      key: 'issues_in_detail',
      kind: 'format',
      match: `a sentence is wrapped onto the next line: ${where}`,
    })),
  ];
  if (narrating.length) {
    say(
      '✏️',
      'answers_rewrite',
      narrating
        .map((n) =>
          n.kind === 'verdict'
            ? `${n.match} has no fixable verdict`
            : n.kind === 'format'
              ? n.match
              : `${n.key} ("${n.match}")`
        )
        .join('; ')
    );
    try {
      const redone = await session.send(await rewritePrompt(narrating));
      const { answers: fixedFields } = await normaliseAnswers(parseJsonReply(redone.text));
      let replaced = 0;
      for (const { key } of narrating) {
        if (fixedFields[key] != null && String(fixedFields[key]).trim()) {
          answers[key] = fixedFields[key];
          replaced++;
        }
      }
      const left = [
        ...processNarration(answers).map((n) => n.key),
        ...missingVerdicts(answers).map((h) => `${h} (no verdict)`),
        ...issueFormatProblems(answers),
        ...wrappedLines(answers).map(() => 'a sentence is still wrapped'),
      ];
      say(
        left.length ? '⚠️' : '✅',
        'answers_rewritten',
        left.length
          ? `${replaced} rewritten, but still not right: ${left.join(', ')}`
          : `${replaced} answer(s) rewritten`,
        left.length ? { level: 'warn' } : {}
      );
    } catch (err) {
      say('⚠️', 'answers_rewrite_failed', `keeping the original answers: ${err.message}`, {
        level: 'warn',
      });
    }
  }

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
    saved.unchanged
      ? `no answer needed changing — the ${saved.fields} already stored still describe the task`
      : `${saved.fields} field(s) stored` +
          (saved.changed.length ? `, changed: ${saved.changed.join(', ')}` : ', nothing changed')
  );

  // -------------------------------------------------------- back up -------
  /*
   * A verdict that ends the task has nothing to pack.
   *
   * The folder is byte-identical to what was downloaded — the run stopped
   * before any corrections — so a zip would be the reviewer's own file handed
   * back. The form's upload field is optional and is left empty. The task still
   * goes to "ready to submit": the form has answers and wants submitting, it
   * just wants submitting without a file.
   */
  if (triage && triage.verdict !== 'fixable') {
    await markReady(uid, {
      needs_upload: false,
      triage_verdict: triage.verdict,
      triage_note: triage.note || null,
      worker_session_id: session.id,
      worker_cost_usd: session.costUsd || null,
    });
    say('🏁', 'ready', `${uid} is ${triage.verdict} — form answered, ready to submit with no upload`);
    return {
      uid,
      from,
      taskDir,
      triage: triage.verdict,
      answerFields: saved.fields,
      answersRound: saved.round,
      sessionId: session.id,
      costUsd: session.costUsd,
      durationMs: session.durationMs,
    };
  }

  /*
   * The difficulty artefact goes before anything is packed.
   *
   * It was reference material for this round, not part of the task — leaving it
   * would put the platform's own check results inside the submission. Worse, it
   * is a .zip in the task folder and the packer below takes the newest zip it
   * finds: a round where Claude did not build one would upload the difficulty
   * results to the platform as the task.
   */
  if (difficultyFile) {
    await rm(path.join(taskDir, difficultyFile), { force: true }).catch((err) =>
      say('⚠️', 'difficulty_file_failed', `could not remove ${difficultyFile}: ${err.message}`, {
        level: 'warn',
      })
    );
    say('🧹', 'difficulty_file', `${difficultyFile} removed before packing`);
  }

  const { path: outZip, name: zipName, madeByClaude } = await zipToUpload(task, taskDir);
  say('📦', 'packed', `${zipName}${madeByClaude ? ' (built by Claude)' : ' (packed from the folder)'}`);

  say('⬆️', 'upload', `uploading ${zipName}`);
  const uploaded = await uploadFile(outZip, { fileName: zipName });

  // Only remove what we made ourselves. A zip Claude built belongs to the task
  // folder and is what the next round starts from.
  if (!madeByClaude) await rm(outZip, { force: true });

  /*
   * Written only now, with the zip uploaded and the answers stored.
   *
   * Recording it any earlier would mark a note as dealt with on a round that
   * then failed, and the next round would be told to skip the very thing that
   * never happened. Bounded, because only the recent rounds are ever compared.
   */
  const notesApplied = noteHash
    ? [...applied.filter((entry) => entry?.hash !== noteHash), { hash: noteHash, at: new Date().toISOString(), round: rounds }].slice(-20)
    : applied;

  await markReady(uid, {
    file_name: zipName,
    dropbox_path: uploaded.dropbox_path,
    local_path: taskDir,
    worker_session_id: session.id,
    worker_cost_usd: session.costUsd || null,
    ...(noteHash ? { revision_notes_applied: notesApplied } : {}),
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
