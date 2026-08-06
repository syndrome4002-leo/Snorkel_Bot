/*
 * index.js — the worker loop.
 *
 * There is no API and nothing to call. The worker polls Firestore for tasks in
 * "in build" or "needs revision", claims what it has room for, and runs each one
 * through Claude. Firestore is the queue; the dashboard changes settings, not
 * commands.
 *
 * Concurrency is capped, and the cap is read live from the dashboard: three
 * Claude sessions each building a repo and running its tests is already enough to
 * saturate a laptop, and the right number depends on the machine.
 */

import { mkdir } from 'node:fs/promises';
import { config } from './config.js';
import { deleteFile } from './dropbox.js';
import { machineId } from './machine.js';
import {
  TASK_STATUS_BUILD,
  TASK_STATUS_WORKING,
  WORKABLE,
  RESTORABLE,
  claimTask,
  findOrphanedTasks,
  findWorkableTasks,
  findLostUploads,
  firebaseStatus,
  initFirebase,
  releaseTask,
} from './firebase.js';
import {
  initRtdb,
  pushLog,
  setTicker,
  publishDeleteResult,
  publishRefreshResult,
  startWorkerHeartbeat,
  watchDeleteRequests,
  watchUsageRefresh,
  watchSettings,
  settingsFrom,
  watchMachineIndex,
  watchSystem,
  goOffline,
  publishNow,
} from './rtdb.js';
import { startConnectServer } from './connect.js';
import { checkClaude } from './claude.js';
import { dropboxConfigured } from './dropbox.js';
import { deleteTaskFolder, workOnTask, reuploadTask } from './task.js';
import { readClaudeUsage, refreshClaudeUsage, outOfUsage } from './usage.js';
import { acquireLock, releaseLock, releaseLockSync, workerProcessAlive } from './lock.js';

/** uid -> what it is doing, for the status the dashboard reads. */
const running = new Map();

let settings = {};

/*
 * The master switch, shared with snorkel_server. Off means claim nothing new;
 * tasks already open are left to finish, because a Claude session killed halfway
 * is simply wasted.
 */
let systemEnabled = true;
/** Whose tasks to work, from the dashboard. Empty means there is nothing to do. */
let machines = [];
let stopping = false;
let pollTimer = null;

const log = (emoji, event, message, extra = {}) => pushLog({ emoji, event, message, ...extra });

/** The dashboard's number wins; the env var is the fallback for a headless box. */
function staticFixLimit() {
  const fromDashboard = Number(settings.static_fix_limit);
  if (Number.isFinite(fromDashboard) && fromDashboard > 0) return Math.floor(fromDashboard);
  return Math.max(1, config.worker.maxStaticFixAttempts);
}

/** What this worker takes from the machines' settings. The rest is the server's. */
const WORKER_SETTINGS = new Set(['worker_max_concurrent', 'static_fix_limit']);

function maxConcurrent() {
  const fromDashboard = Number(settings.worker_max_concurrent);
  if (Number.isFinite(fromDashboard) && fromDashboard > 0) return Math.floor(fromDashboard);
  return Math.max(1, config.worker.maxConcurrent);
}

async function snapshot() {
  return {
    // Read fresh each beat: the file is rewritten by whichever Claude run last
    // heard from the API, which may not be this process.
    claude_usage: await readClaudeUsage(),
    role: 'worker',
    running: running.size,
    max_concurrent: maxConcurrent(),
    static_fix_limit: staticFixLimit(),
    // Null unless Claude has said there is nothing left to spend.
    paused_until: pausedUntil,
    paused_reason: pauseReason || null,
    tasks: [...running.values()].map((t) => ({ uid: t.uid, from: t.from, started_at: t.startedAt })),
    poll_seconds: config.worker.pollSeconds,
    working_for: machines,
    system_enabled: systemEnabled,
  };
}

/** What the connect page shows. Read live, not captured at startup. */
function connectState() {
  return { machines, running: running.size, max: maxConcurrent() };
}

/**
 * Puts back anything a previous run left claimed.
 *
 * "Working.." is a claim, and a claim outlives the process that made it — a
 * crash mid-task would otherwise park that task forever, because nothing else
 * looks at that status.
 *
 * Only one worker runs per machine, and this runs before that worker has claimed
 * anything, so a task marked "Working.." by *this* machine is necessarily
 * abandoned. That is what makes it safe to reclaim without a heartbeat or a
 * timeout: there is no second worker whose live work this could be.
 */
async function recoverOrphans() {
  const orphans = await findOrphanedTasks();
  if (!orphans.length) return;

  for (const task of orphans) {
    // Belt and braces against a lock that was deleted by hand: if the process
    // that claimed this is still running, it is not an orphan, it is somebody
    // else's live work. Reclaiming it would put two Claude sessions in one folder.
    if (task.worker_pid && (await workerProcessAlive(task.worker_pid))) {
      log(
        '⚠️',
        'still_live',
        `${task.UID} is claimed by pid ${task.worker_pid}, which is still running — leaving it alone. ` +
          `Two workers appear to be running on this machine; stop one.`,
        { level: 'warn', uid: String(task.UID) }
      );
      continue;
    }

    // RESTORABLE, not WORKABLE: a task goes back where it came from even if the
    // worker is no longer taking that status.
    const back = RESTORABLE.includes(task.worked_from) ? task.worked_from : TASK_STATUS_BUILD;
    await releaseTask(task.UID, back, 'The worker stopped while this task was open.');
    log('♻️', 'recovered', `${task.UID} was left in "${TASK_STATUS_WORKING}" — put back to "${back}"`, {
      level: 'warn',
      uid: String(task.UID),
    });
  }
}

/*
 * Set when Claude says the subscription is spent, and until when.
 *
 * Without it the worker spends the rest of the night doing this, once every
 * poll: claim a task, start Claude, get told there is no usage left, put the
 * task back, claim it again. Nothing progresses, and the task's history is
 * pushed out of the log stream by hundreds of identical failures — so the one
 * thing you would want to read in the morning is the thing that gets lost.
 */
let pausedUntil = null;
let pauseReason = '';

/**
 * When to try again after running out.
 *
 * The reset time from the usage figures rather than the one in Claude's message:
 * it is already an exact timestamp, where the message says something like
 * "resets 5:10am (Europe/Berlin)" that would have to be parsed, in a timezone
 * that is not necessarily this machine's, into a time that may be tomorrow.
 *
 * Half an hour if the figures cannot say. Waiting slightly too long costs one
 * cycle of doing nothing; waiting too little costs the storm this exists to stop.
 */
async function usageResetsAt() {
  try {
    const usage = await readClaudeUsage();
    const at = usage && usage.reset_5h ? new Date(usage.reset_5h) : null;
    if (at && Number.isFinite(at.getTime()) && at.getTime() > Date.now()) return at;
  } catch {
    // Fall through to the fixed wait.
  }
  return new Date(Date.now() + 30 * 60000);
}

async function pauseForUsage(message) {
  const until = await usageResetsAt();
  // Do not let a later failure from a task that was already running shorten a
  // pause that is already set.
  if (pausedUntil && new Date(pausedUntil).getTime() >= until.getTime()) return;
  pausedUntil = until.toISOString();
  pauseReason = String(message || 'Claude is out of usage').slice(0, 200);
  const minutes = Math.max(1, Math.round((until.getTime() - Date.now()) / 60000));
  log(
    '⏳',
    'usage_pause',
    `Claude is out of usage — claiming nothing for ${minutes} min, until ${until.toLocaleTimeString()}`,
    { level: 'warn' }
  );
  updateTicker();
  publishNow();
}

/** True while the pause is in force. Clears itself, and says so, once it is over. */
function pausedForUsage() {
  if (!pausedUntil) return false;
  if (Date.now() < new Date(pausedUntil).getTime()) return true;
  pausedUntil = null;
  pauseReason = '';
  log('▶️', 'usage_pause', 'usage should have reset — taking work again');
  updateTicker();
  publishNow();
  return false;
}

async function startTask(task) {
  const uid = String(task.UID || task.id);
  const from = task.task_status;

  const claimed = await claimTask(uid, from);
  if (!claimed) {
    // Somebody else took it, or it moved on between the query and the claim.
    return false;
  }

  const entry = { uid, from, startedAt: new Date().toISOString() };
  running.set(uid, entry);
  publishNow();

  log('🚀', 'task_claimed', `${uid} picked up from "${from}" (${running.size}/${maxConcurrent()} busy)`, {
    uid,
  });

  // Deliberately not awaited: the loop carries on filling the other slots.
  (async () => {
    try {
      await workOnTask(claimed, {
        log: (emoji, event, message) => log(emoji, event, message, { uid }),
        onSession: (line) => {
          // Claude's own chatter is noisy; keep it on the console only.
          if (line.trim()) console.log(`[claude:${uid.slice(0, 8)}] ${line.trim()}`);
        },
      });
    } catch (err) {
      log('❌', 'task_failed', `${uid}: ${err.message}`, { level: 'error', uid });
      // Put the task back first — it is not at fault and must stay claimable —
      // then stop taking anything until there is usage to work with.
      if (outOfUsage(err.message)) await pauseForUsage(err.message);
      const put = await releaseTask(uid, from, err.message).catch((e) => {
        console.error(`[worker] could not release ${uid}:`, e.message);
        return null;
      });
      /*
       * Say when it will be tried again. Without this the task simply goes quiet
       * for up to an hour, which reads like the worker forgot about it.
       */
      if (put && put.failures > 0) {
        logRetry(uid, put);
      }
    } finally {
      running.delete(uid);
      publishNow();
      updateTicker();
    }
  })();

  return true;
}

/** One line on when a failed task comes round again, and how often it has failed. */
function logRetry(uid, put) {
  log(
    '⏭️',
    'task_retry',
    `${uid} will be tried again in ${put.retryInMinutes} min` +
      (put.failures > 1 ? ` (${put.failures} failures in a row)` : ''),
    { uid }
  );
}

function updateTicker() {
  const max = maxConcurrent();

  if (!systemEnabled) {
    setTicker('worker', {
      emoji: '⏹️',
      event: 'worker',
      message: running.size
        ? `System disabled — finishing ${running.size} task(s), then stopping`
        : 'System disabled — claiming nothing',
    });
    return;
  }

  if (pausedUntil && Date.now() < new Date(pausedUntil).getTime()) {
    const minutes = Math.max(1, Math.round((new Date(pausedUntil).getTime() - Date.now()) / 60000));
    setTicker('worker', {
      emoji: '⏳',
      event: 'worker',
      message: running.size
        ? `Claude is out of usage — finishing ${running.size} task(s), nothing new for ${minutes} min`
        : `Claude is out of usage — taking nothing for ${minutes} min`,
    });
    return;
  }

  if (!machines.length && !config.worker.anyMachine) {
    setTicker('worker', {
      emoji: '🕳️',
      event: 'worker',
      message: 'No machines added on the dashboard — nothing to work on',
    });
    return;
  }

  setTicker('worker', {
    emoji: running.size ? '🧠' : '💤',
    event: 'worker',
    message: running.size
      ? `Claude is on ${running.size} of ${max} task(s): ${[...running.keys()]
          .map((u) => u.slice(0, 8))
          .join(', ')}`
      : `Idle — ${max} slot(s) free, watching ${machines.length} machine(s), next look in ${config.worker.pollSeconds}s`,
  });
}

/**
 * Re-uploads finished tasks whose zip was consumed but never attached.
 *
 * The server deletes a task's zip from Dropbox as soon as the browser has it,
 * which is what stops a stale build being uploaded later. When the browser then
 * fails before attaching — a section collapsed, a tab closed — the task is left
 * finished with no file anywhere, and the submit sweep skips it forever because
 * it requires `file_uploaded`.
 *
 * Nothing was lost, only misplaced: the unpacked folder is still on this
 * machine.
 */
async function recoverLostUploads() {
  let lost = [];
  try {
    lost = await findLostUploads(machines);
  } catch (err) {
    return log('⚠️', 'reupload', `could not look for lost uploads: ${err.message}`, { level: 'warn' });
  }
  if (!lost.length) return;

  for (const task of lost) {
    const uid = String(task.UID);
    try {
      log(
        '🔁',
        'reupload',
        `${uid} has had no file in Dropbox for ${task.stranded_for_minutes} min — rebuilding it`,
        { uid }
      );
      await reuploadTask(task, { log: (e, ev, m) => log(e, ev, m, { uid }) });
    } catch (err) {
      // Left as it is. Repeating the message every poll would be noise, but the
      // alternative is a task that is quietly stuck, which is worse.
      log('⚠️', 'reupload', `${uid}: ${err.message}`, { uid, level: 'warn' });
    }
  }
}

async function poll() {
  if (stopping) return;
  if (!systemEnabled) return;

  try {
    const max = maxConcurrent();
    const free = max - running.size;
    updateTicker();
    if (free <= 0) return;

    // No machine list means the dashboard has not been told what to work on.
    // Silence would look identical to "nothing to do", so say it in the ticker
    // rather than in the log stream, where it would repeat every poll.
    if (!machines.length && !config.worker.anyMachine) return;

    /*
     * First, anything finished that has lost its file.
     *
     * Cheap and Claude-free — it only rebuilds a zip from a folder that is
     * already here — so it runs before the real work rather than competing with
     * it for a slot.
     */
    await recoverLostUploads();

    /*
     * Deliberately after the recovery above: rebuilding a zip from a folder that
     * is already on disk needs no Claude at all, so there is no reason for an
     * exhausted subscription to hold it up. Everything below this line does need
     * Claude.
     */
    if (pausedForUsage()) return;

    // Ask for more than there is room for: some will already be claimed by the
    // time we get to them, and a short list would leave slots idle.
    const candidates = await findWorkableTasks(machines, free + 5, staticFixLimit());
    const available = candidates.filter((t) => !running.has(String(t.UID || t.id)));
    if (!available.length) return;

    log('🔎', 'found_work', `${available.length} task(s) waiting, ${free} slot(s) free`);

    for (const task of available) {
      if (stopping || running.size >= maxConcurrent()) break;
      await startTask(task);
    }
    updateTicker();
  } catch (err) {
    log('⚠️', 'poll_failed', err.message, { level: 'warn' });
  }
}

async function preflight() {
  const problems = [];

  const fb = firebaseStatus();
  if (!fb.ready) problems.push(`Firestore: ${fb.reason}`);

  if (!dropboxConfigured()) {
    const where = `http://${config.connect.host}:${config.connect.port}/`;
    problems.push(
      config.dropbox.appKey && config.dropbox.appSecret
        ? `Dropbox: no refresh token yet — open ${where} and click "Connect Dropbox". ` +
          `Tasks cannot be downloaded or uploaded until then.`
        : `Dropbox: DROPBOX_APP_KEY and DROPBOX_APP_SECRET are not set — copy them from ` +
          `snorkel_server/.env, then connect at ${where}`
    );
  }

  try {
    const version = await checkClaude();
    console.log(`[worker] claude ${version}`);
  } catch (err) {
    problems.push(`Claude: ${err.message}`);
  }

  if (!config.docsDir) {
    console.warn('[worker] DOCS_DIR is not set — Claude will get the task with no reference documents');
  }

  return problems;
}

async function main() {
  // Before anything else, and before any Firestore connection: a second worker
  // on this machine must not get far enough to claim a task.
  await acquireLock();

  console.log(`[worker] machine ${machineId()} (pid ${process.pid})`);
  /*
   * Said out loud because a mismatch is invisible otherwise: a worker on the
   * wrong workspace reads an empty machine list and reports "nothing to do"
   * forever, which looks exactly like a quiet day.
   */
  console.log(`[worker] workspace ${config.worker.workspace}`);
  console.log(`[worker] work dir ${config.workDir}`);
  if (config.extraTaskDirs.length) console.log(`[worker] also searching ${config.extraTaskDirs.join(', ')}`);

  await mkdir(config.workDir, { recursive: true });

  await initFirebase();
  await initRtdb();

  const problems = await preflight();
  if (problems.length) {
    // Firestore being unreachable is fatal — there is no queue to read. Anything
    // else is reported and left to fail per-task, so one bad credential does not
    // stop the worker from doing the parts that still work.
    for (const problem of problems) {
      log('🛑', 'preflight', problem, { level: 'error' });
    }
    if (!firebaseStatus().ready) {
      console.error('[worker] cannot run without Firestore — stopping');
      process.exit(1);
    }
  }

  /*
   * Whose tasks to work. This is what lets the worker sit on a different machine
   * from the one that produced the task: it is told, rather than assuming it is
   * the machine in question. Awaited for the same reason as the settings — the
   * first poll must not run against an empty list and conclude there is nothing
   * to do.
   */
  if (config.worker.onlyMachines.length) {
    machines = config.worker.onlyMachines;
    log(
      '📌',
      'machines_pinned',
      `ONLY_MACHINES is set — working ${machines.join(', ')} and ignoring the dashboard's list`,
      { level: 'warn' }
    );
  }

  const firstMachines = new Promise((resolve) => {
    if (config.worker.onlyMachines.length) return resolve();
    let seen = false;
    watchMachineIndex((ids) => {
      const before = machines;
      machines = ids;
      // Their settings are this worker's settings — see rtdb.js — so a machine
      // added or removed on the dashboard changes what this worker obeys, not
      // just whose tasks it takes. (Nothing happens on the first call: the
      // settings are not subscribed to until just below, once this list exists.)
      settingsFrom(machines);
      if (!seen) {
        seen = true;
        return resolve();
      }
      const added = ids.filter((id) => !before.includes(id));
      const gone = before.filter((id) => !ids.includes(id));
      if (added.length) log('➕', 'machines', `now also working for ${added.join(', ')}`);
      if (gone.length) log('➖', 'machines', `no longer working for ${gone.join(', ')}`);
      if (added.length || gone.length) {
        updateTicker();
        publishNow();
      }
    });
  });

  /*
   * Five seconds for both, not five each: a worker that cannot reach the
   * Realtime Database should start late, not twice as late.
   */
  const startBy = Date.now() + 5000;
  const outOfTime = () => new Promise((resolve) => setTimeout(resolve, Math.max(0, startBy - Date.now())));

  // Without the Realtime Database there is no snapshot coming at all.
  await Promise.race([firstMachines, outOfTime()]);

  /*
   * The first snapshot is awaited rather than just subscribed to. Settings
   * arrive asynchronously, so polling straight away would use the env default
   * for a second or two — long enough to claim three tasks when the dashboard
   * says one, which is exactly the mistake the setting exists to prevent.
   *
   * "The first snapshot" means the first one with every branch reporting: they
   * come from the machines this worker works for, so there are usually several,
   * and the earliest arrival is not the whole answer. Which is also why this is
   * set up after the machine list and not before it — subscribing to the
   * branches one at a time as the list trickles in would let the wait finish
   * against a branch that is merely the first to answer.
   */
  let settingsSources = [];
  const firstSettings = new Promise((resolve) => {
    let seen = false;
    watchSettings((value, meta) => {
      const before = seen ? maxConcurrent() : null;
      settings = value || {};

      const sources = meta?.sources || [];
      if (sources.join(',') !== settingsSources.join(',')) {
        settingsSources = sources;
        if (seen) log('⚙️', 'settings', `now reading settings from ${sources.join(', ') || 'nowhere'}`);
      }
      /*
       * Two machines asking for different numbers is not something to resolve
       * quietly — whoever set the second one is watching for it to take effect.
       *
       * Only the settings this worker actually obeys are worth a line. Most of
       * what is in that branch is the server's, and two machines having
       * different sheet owners is normal rather than a problem.
       */
      const clashes = (meta?.clashes || []).filter((key) => WORKER_SETTINGS.has(key));
      if (clashes.length) {
        log(
          '⚠️',
          'settings_clash',
          `${clashes.join(', ')} differ between ${sources.join(' and ')} — using the lower number`,
          { level: 'warn' }
        );
      }

      if (!seen) {
        if (!meta || meta.complete) {
          seen = true;
          resolve();
        }
        return;
      }
      const after = maxConcurrent();
      if (after !== before) {
        log('⚙️', 'settings', `max concurrent tasks: ${before} -> ${after}`);
        updateTicker();
        publishNow();
      }
    });
  });
  settingsFrom(machines);

  await Promise.race([firstSettings, outOfTime()]);

  watchSystem((enabled) => {
    if (enabled === systemEnabled) return;
    systemEnabled = enabled;
    log(
      enabled ? '▶️' : '⏹️',
      'system',
      enabled
        ? 'System enabled — picking up work again'
        : 'System disabled from the dashboard — claiming nothing new (running tasks finish)',
      { level: enabled ? 'info' : 'warn' }
    );
    updateTicker();
    publishNow();
  });

  startWorkerHeartbeat(snapshot, 10_000);

  /*
   * The dashboard asking for the current figures.
   *
   * Worth a button because nothing else can produce them: the percentages come
   * from rate-limit headers, so on an idle worker they stay as old as the last
   * task. The heartbeat above republishes the same stale numbers every ten
   * seconds; only a call to the API makes them newer.
   */
  /*
   * The dashboard asking for a task to be thrown away.
   *
   * Only the folder is this worker's to remove; the record and the Dropbox copy
   * are the server's. Split that way because only this machine has the files,
   * and only the server has the credentials.
   */
  watchDeleteRequests(async ({ uid, at, dropbox_path: dropboxPath }) => {
    log('🗑️', 'delete_folder', `asked to throw ${uid} away`, { uid });
    try {
      const result = await deleteTaskFolder(uid);

      /*
       * And the Dropbox copy, which only a worker or the server can reach. Done
       * here so one request clears everything outside the database, and reported
       * separately: a folder deleted with a file left behind is a different
       * outcome from both gone.
       */
      let dropbox = 'none recorded';
      if (dropboxPath) {
        try {
          await deleteFile(dropboxPath);
          dropbox = `removed ${dropboxPath}`;
        } catch (err) {
          dropbox = `could not remove ${dropboxPath}: ${err.message}`;
        }
      }

      await publishDeleteResult({ ok: true, uid, requested_at: at, dropbox, ...result });
      log(
        result.deleted ? '🗑️' : '➖',
        'delete_folder_done',
        (result.deleted ? `removed ${result.path}` : `no folder here — ${result.reason}`) +
          `; dropbox: ${dropbox}`,
        { uid }
      );
    } catch (err) {
      await publishDeleteResult({ ok: false, uid, requested_at: at, error: err.message });
      log('⚠️', 'delete_folder_failed', `${uid}: ${err.message}`, { uid, level: 'warn' });
    }
  });

  watchUsageRefresh(async (at) => {
    log('🔄', 'usage_refresh', 'asking Anthropic for the current usage figures');
    try {
      const usage = await refreshClaudeUsage();
      await publishRefreshResult({
        ok: true,
        requested_at: at,
        refreshed: Boolean(usage.refreshed),
        reason: usage.reason || null,
      });
      await publishNow();
      log(
        usage.refreshed ? '📈' : '➖',
        'usage_refreshed',
        usage.refreshed
          ? `${usage.session_5h_pct}% of the 5-hour window, ${usage.weekly_7d_pct}% of the week`
          : `could not ask just now (${usage.reason || 'unknown'}) — showing what was last read`
      );
    } catch (err) {
      await publishRefreshResult({ ok: false, requested_at: at, error: err.message });
      log('⚠️', 'usage_refresh_failed', err.message, { level: 'warn' });
    }
  });
  startConnectServer(connectState);

  await recoverOrphans();

  if (machines.length) {
    log(
      '🤖',
      'worker_up',
      `Worker ready — up to ${maxConcurrent()} task(s) at once, working for ` +
        `${machines.length} machine(s): ${machines.join(', ')}`
    );
    // Worth saying every start: a revision sitting untouched looks like a bug
    // unless you know revisions are switched off.
    if (!config.worker.handleRevisions) {
      log('⏭️', 'revisions_off', 'Reviewer revisions are off — only new tasks are picked up (HANDLE_REVISIONS=true turns them back on)');
    }
  } else if (config.worker.anyMachine) {
    log('🤖', 'worker_up', `Worker ready — up to ${maxConcurrent()} task(s) at once, taking work from any machine`);
  } else {
    // Worth a log line rather than only the ticker: this is the state where a
    // correctly configured worker still does nothing, and it should be obvious
    // why rather than looking like a machine that has run out of work.
    log(
      '🕳️',
      'no_machines',
      'No machines have been added on the dashboard, so there is nothing to work on. ' +
        'Add the machine id that snorkel_server prints on startup.',
      { level: 'warn' }
    );
  }

  await poll();
  pollTimer = setInterval(poll, config.worker.pollSeconds * 1000);
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`\n[worker] ${signal} — stopping`);
  if (pollTimer) clearInterval(pollTimer);

  /*
   * Release the lock first, before the tidy-up that follows.
   *
   * `node --watch` starts the replacement as soon as it has signalled this
   * process, so anything done while still holding the lock — a final status
   * write, a log flush — is time the next process spends being told a worker is
   * already running. The lock protects against a second worker *doing work*, and
   * this one has already stopped taking any.
   */
  await releaseLock().catch(() => {});

  if (running.size) {
    // The tasks themselves are killed with the process; recoverOrphans on the
    // next start puts them back.
    log('🛑', 'worker_down', `Stopping with ${running.size} task(s) open — they will be released on restart`, {
      level: 'warn',
    });
  } else {
    log('🛑', 'worker_down', 'Worker stopped');
  }

  await goOffline();
  // Give the log write a moment to leave the process before it exits.
  setTimeout(() => process.exit(0), 1500).unref?.();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
// Last resort: however this process ends, the lock should not outlive it.
process.on('exit', releaseLockSync);

main().catch(async (err) => {
  if (err.code === 'WORKER_ALREADY_RUNNING') {
    // Not a crash — the machine already has its worker. Say so plainly and
    // leave the other one's lock alone.
    console.error(`\n[worker] ${err.message}\n`);
    process.exit(1);
  }
  console.error('[worker] failed to start:', err);
  await releaseLock().catch(() => {});
  process.exit(1);
});
