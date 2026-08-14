/*
 * task.js — one task, start to finish.
 *
 * Two entry states, one exit state:
 *
 *   "in build"          the zip is on Dropbox. Fetch it, delete it there, unpack
 *                       it, work it, pack it, put it back.
 *   "static check fail" the folder is already on disk. Answer the platform's
 *                       complaint, pack it, put it back.
 *
 * Both end at "ready to submit" with the answer recorded.
 *
 * The order of the Dropbox steps is deliberate. The file is deleted remotely
 * *after* it is safely on disk and Firestore has been told, so an interruption
 * can never leave a task whose only copy has just been deleted.
 */

import { rm, stat, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { unzipTo, zipFolder } from './archive.js';
import { downloadFile, deleteFile, uploadFile } from './dropbox.js';
import { openSession, latestSessionFor } from './claude.js';
import { openInEditor } from './editor.js';
import {
  answersBlock,
  buildAnswersBlock,
  buildPrompt,
  documentPaths,
  extractPrompt,
  gapPrompt,
  introPrompt,
  schemaForStage,
  rewritePrompt,
  staticFixPrompt,
} from './prompts.js';
import {
  issueFormatProblems,
  missingVerdicts,
  normaliseAnswers,
  hasJsonReply,
  parseJsonReply,
  processNarration,
  wrappedLines,
} from './answers.js';
import {
  TASK_STATUS_BUILD,
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

/** The same question asked of any stage's answer set. */
export async function missingForStage(stage, answers) {
  const stored = answers && !Array.isArray(answers) ? answers : {};
  const schema = await schemaForStage(stage);

  return Object.entries(schema)
    .filter(([, spec]) => !spec.when && !spec.supplied_by_server)
    .map(([key]) => key)
    .filter((key) => {
      const value = stored[key];
      if (value === undefined || value === null) return true;
      if (Array.isArray(value)) return value.length === 0;
      return String(value).trim() === '';
    });
}

/**
 * Which conversation this task should continue, if any.
 *
 * Every prompt a task ever gets belongs in the conversation it started in — a
 * build that failed and is being retried is not a new task, and treating it as
 * one is how a single task once ended up with nine conversations on disk, each
 * reading the whole folder from scratch.
 *
 * But the *record* decides that, not the folder. Conversations outlive the task
 * they were had for: delete a task from the dashboard, build it again, and the
 * folder still holds every session belonging to the task that no longer exists.
 * Letting the folder decide meant a fresh build silently adopted one of those
 * and carried on as though it already understood work it had never done.
 *
 * `worker_session_id` is written the moment a conversation exists, so a task
 * this worker has run carries one. No id means no conversation of ours, however
 * much history the folder happens to hold — so it starts fresh, which is what a
 * task being built for the first time should do.
 *
 * The folder is still the fallback for a task that *does* have an id whose file
 * the CLI has since pruned: same task, same folder, and the newest surviving
 * conversation there is still one of its own.
 */
export async function conversationFor(task, taskDir, { resumeSessions = true } = {}) {
  if (!resumeSessions) return null;
  const recorded = task.worker_session_id;
  if (!recorded) return null;
  return latestSessionFor(taskDir, recorded);
}

/**
 * Keeps environment/problem_statement.md identical to instruction.md.
 *
 * The two files must always match, and every session spent turns keeping them
 * that way by hand — one of them copied the file six times in a single round,
 * because every edit to the instruction breaks the invariant again.
 *
 * It is a copy, not a judgement, so it belongs here: done once, at the end, when
 * the instruction has stopped changing. Missing files are left alone — a task
 * without one of them is not a task with a stale one.
 */
async function syncProblemStatement(taskDir, say) {
  const source = path.join(taskDir, 'instruction.md');
  const target = path.join(taskDir, 'environment', 'problem_statement.md');

  try {
    const [instruction, statement] = await Promise.all([
      readFile(source, 'utf8'),
      readFile(target, 'utf8').catch(() => null),
    ]);
    if (statement === null || statement === instruction) return;

    await writeFile(target, instruction);
    say('📄', 'problem_statement', 'environment/problem_statement.md brought back in line with instruction.md');
  } catch {
    // No instruction.md, or an unreadable folder. Neither is this function's
    // business to report — the packing below will fail loudly if it matters.
  }
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
/**
 * The zip to hand to the platform, packed here rather than by Claude.
 *
 * It used to take whichever zip the session had left in the folder, and the
 * prompts asked for one. That is an expensive way to run `zip`: in one session
 * it cost nineteen turns of zipping, unzipping to check the result, and deleting
 * the previous attempt — at Opus prices, on a job the worker does in one line
 * and gets right every time.
 *
 * A zip a session happens to have built is ignored, not used: the folder is the
 * work, and packing it here means the archive always matches what is on disk
 * rather than whatever state it was in when somebody last ran `zip`.
 */
async function zipToUpload(task, taskDir) {
  const name = await zipNameFor(task, taskDir);
  const out = path.join(config.workDir, name);
  await zipFolder(taskDir, out);
  // Packed outside the task folder, so it is ours to delete once uploaded and
  // never becomes an input to the next round.
  return { path: out, name };
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

  const { path: outZip, name: zipName } = await zipToUpload(task, taskDir);
  say('⬆️', 'reupload', `putting ${zipName} back in Dropbox`);

  const uploaded = await uploadFile(outZip, { fileName: zipName });
  await rm(outZip, { force: true });

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
export async function workOnTask(
  task,
  { log, onSession, model = '', resumeSessions = true, openEditor, autocompact } = {}
) {
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

  /*
   * Both paths above end with a folder, which is the moment to put it on screen
   * — a build has just unpacked it, a revision has just found it, and neither
   * has spent anything on Claude yet. Never fails the task: see editor.js.
   */
  await openInEditor(taskDir, { log: say, enabled: openEditor });

  // ------------------------------------------------------------- Claude ---

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
        `still working ${uid} — ${Math.round((Date.now() - beatStarted) / 60000)} min so far`,
        // Every five minutes for as long as the build runs, and eight rounds of
        // that would be the whole of this task's history — see pushLog().
        { recurring: true }
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
  /*
   * One task, one conversation, for every round of it.
   *
   * The task was understood during the first build; a revision continues that
   * work rather than meeting it for the first time. So the session is resumed,
   * and what it already knows — the files, the corrections it made, the reasons
   * — is there without being read again.
   *
   * The cost of this is real and worth stating: a resumed conversation carries
   * every file read and test run from every earlier round, and re-reads all of
   * it on each turn, so a long-running task grows expensive per turn as it goes.
   * Turn the dashboard setting off to start each round fresh instead, which
   * trades that for re-reading the task at the start of every round.
   */
  const resume = await conversationFor(task, taskDir, { resumeSessions });
  if (resume && resume !== task.worker_session_id) {
    say('🧵', 'session', `continuing this task's existing conversation (${resume.slice(0, 8)})`);
  }

  /*
   * A resumed round gets the tighter window.
   *
   * It arrives long after the five-minute cache has gone, so its first call
   * re-writes the whole conversation at full price before any work starts —
   * measured at 159k on a revision, against 45k for the same work done by hand
   * in a session still warm enough to write only the delta. A build has no
   * history to re-write and its conversation never reached the wider window
   * anyway, so it is left alone.
   */
  const window = autocompact ?? (resume ? config.claude.autocompactResumed : config.claude.autocompact);
  const session = openSession({
    cwd: taskDir,
    // Chosen on the dashboard, per machine. Empty means the CLI's own default.
    model,
    autocompact: window,
    // The documents sit outside the task folder, so Claude has to be allowed to
    // read there explicitly.
    addDirs: config.docsDir ? [config.docsDir] : [],
    timeoutMs,
    label: uid,
    resume,
    /*
     * Stored the moment the conversation exists, so one task keeps one session
     * across every round of it.
     *
     * It used to be written only when a round finished, which meant any round
     * that failed — a Claude error, an exhausted subscription, a timeout — left
     * nothing to continue from, and the next attempt started a fresh
     * conversation that had to read the whole task again. Every failure was
     * quietly paying for a rebuild of the context.
     */
    onSessionId: (id, { lost } = {}) => {
      if (id === task.worker_session_id) return;
      if (lost) {
        say('🧵', 'session_lost', `the earlier conversation could not be resumed — continuing in a new one`, {
          level: 'warn',
        });
      }
      patchTask(uid, { worker_session_id: id }).catch((err) =>
        say('⚠️', 'session_lost', `could not record the session id: ${err.message}`, { level: 'warn' })
      );
    },
    // Sent before the first turn of any conversation that is not a resumed one,
    // including a resume that turned out to be dead. Nothing below has to know
    // which of those happened.
    preamble: () => introPrompt(docs),
    onLog: (line) => onSession && onSession(line),
  });

  let stage = 'build';
  let triage = null;

  try {
    if (from === TASK_STATUS_STATIC_FAIL) {
      // ---- the platform rejected the last upload -------------------------
      const logs = failedCheckLogs(task);
      if (!logs) {
        throw new Error(`${uid} is at "${from}" but has no static_check_result logs to work from.`);
      }

      const attempt = Number(task.static_fix_attempts || 0) + 1;
      say('🔁', 'static_fix', `${uid} failed the platform checks — fixing (attempt ${attempt})`);

      await session.send(
        (await staticFixPrompt({ uid, taskDir, logs })) + (await answersBlock(stage))
      );
      await patchTask(uid, { static_fix_attempts: attempt });
    } else if (from === TASK_STATUS_BUILD) {
      // ---- a first build -------------------------------------------------
      stage = 'build';
      say('🧠', 'claude_start', `building ${uid} with ${docs.length} document(s) attached`);

      /*
       * One prompt: judge the task, do what the judgement calls for, and fill in
       * the matching form.
       *
       * It used to be two — "is this fixable?", then, knowing the answer, the
       * work. Splitting it reads like the careful order to do things in, but the
       * first prompt is a whole process that pays to establish the conversation
       * and comes back with one word. Measured across 63 runs it cost as much
       * per unit of output as the prompt that did the actual work.
       *
       * Nothing was gained by knowing the verdict first: every branch continues
       * in the same conversation anyway, so the only thing the split bought was
       * a second cold start. A person looking at one of these tasks decides and
       * acts in one sitting; this now does the same.
       */
      const built = await session.send(
        (await buildPrompt({ uid, taskDir, initialInfos: task.initial_infos })) +
          (await buildAnswersBlock())
      );

      triage = readVerdict(built.text);
      /*
       * Anything but fixable means there was nothing to correct and nothing to
       * upload — but the form still had to be filled in, and it is the only
       * thing the reviewer will read. The prompt above asks for the shorter set
       * of questions in that case, so the answers are already in this reply.
       */
      stage =
        triage.verdict === 'fixable'
          ? 'build'
          : triage.verdict === 'invalid'
            ? 'invalid'
            : 'valid-as-is';
      say('🔎', 'triage', `${uid} is ${triage.verdict}`);
      if (triage.verdict !== 'fixable') {
        say('🛑', 'triage_stop', `${uid} is ${triage.verdict} — the form saying so is filled in`);
      }
    } else {
      /*
       * The bot builds and submits; nothing else is worked. A task reaching
       * here is at a status this worker was never meant to claim, which is a
       * bug in the query rather than something to guess its way through.
       */
      throw new Error(`${uid} is at "${from}", which this worker does not handle.`);
    }

    /*
     * The answers should already be in the reply above — the work prompt asked
     * for them there, so that this round is one message and one process rather
     * than three, each paying to rebuild the cache over the whole conversation.
     *
     * Asking again is the fallback for a reply that came back without them, not
     * the normal path.
     */
    if (!hasJsonReply(session.turns[session.turns.length - 1]?.text)) {
      say('📋', 'answers_second_ask', 'the reply had no answers block — asking for it on its own');
      await session.send(await extractPrompt(stage));
    }
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
  /*
   * The prose and the JSON arrive in one reply now, so the prose is whatever
   * came before the fenced block. A reply that needed the fallback ask above has
   * them in two turns, as before.
   */
  const last = turns[turns.length - 1]?.text || '';
  const prose = hasJsonReply(last)
    ? last.slice(0, last.search(/```(?:json)?/i)).trim()
    : turns.length > 1
      ? turns[turns.length - 2].text
      : '';
  const { answers, ignored, problems } = await normaliseAnswers(
    parseJsonReply(turns[turns.length - 1].text),
    // A verdict run answers the form that verdict produces, whose questions and
    // options are not the fixable form's.
    { stage }
  );

  if (triage && !answers.validity_required) answers.validity_required = triage.verdict;

  /*
   * The form asks the validity question twice — the second is labelled
   * "[Duplicate]" and the page says "Ensure your selection matches the question
   * above". So it is one answer, stored once: the schema has no key for the
   * second, and the form filler reads `validity_required` for both. Storing two
   * copies only created the chance of a submission contradicting itself, and
   * then of one of the copies using a wording the page does not offer.
   */

  /*
   * Anything the extraction left out, asked for once.
   *
   * The extract turn is told to leave out keys that do not apply, which is right
   * — but "does not apply" and "I did not write one" look identical from here,
   * and the platform rejects a form with a required question blank. A fixable
   * task recovers on its own: it comes back for revision and the next round
   * fills the gap. A verdict task has exactly one round, so whatever is missing
   * when this turn ends is missing on the form somebody submits.
   *
   * One turn, and the answers already written are left alone.
   */
  const gaps = await missingForStage(stage, answers);
  if (gaps.length) {
    say('📝', 'answers_gaps', `${gaps.join(', ')} came back empty — asking for ${gaps.length === 1 ? 'it' : 'them'}`, {
      level: 'warn',
    });
    try {
      const filled = await session.send(await gapPrompt(stage, gaps));
      const { answers: extra } = await normaliseAnswers(parseJsonReply(filled.text), { stage });
      const got = gaps.filter((key) => {
        const value = extra[key];
        const has = Array.isArray(value) ? value.length > 0 : value != null && String(value).trim() !== '';
        if (has) answers[key] = value;
        return has;
      });
      const still = gaps.filter((key) => !got.includes(key));
      say(
        still.length ? '⚠️' : '✅',
        'answers_gaps',
        still.length ? `${got.length} written, still empty: ${still.join(', ')}` : `${got.length} written`,
        still.length ? { level: 'warn' } : {}
      );
    } catch (err) {
      // Whatever was written stands. A missing answer is a question left blank;
      // losing the run over it would be the whole task.
      say('⚠️', 'answers_gaps', `could not ask again: ${err.message}`, { level: 'warn' });
    }
  }

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

  await syncProblemStatement(taskDir, say);

  const { path: outZip, name: zipName } = await zipToUpload(task, taskDir);
  say('📦', 'packed', `${zipName} (packed from the folder)`);

  say('⬆️', 'upload', `uploading ${zipName}`);
  const uploaded = await uploadFile(outZip, { fileName: zipName });

  // Ours, built outside the task folder for this upload only.
  await rm(outZip, { force: true });


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
