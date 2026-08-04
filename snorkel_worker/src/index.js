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
  startWorkerHeartbeat,
  watchSettings,
  watchMachineIndex,
  watchSystem,
  goOffline,
  publishNow,
} from './rtdb.js';
import { startConnectServer } from './connect.js';
import { checkClaude } from './claude.js';
import { dropboxConfigured } from './dropbox.js';
import { workOnTask, reuploadTask } from './task.js';
import { readClaudeUsage } from './usage.js';
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
      await releaseTask(uid, from, err.message).catch((e) =>
        console.error(`[worker] could not release ${uid}:`, e.message)
      );
    } finally {
      running.delete(uid);
      publishNow();
      updateTicker();
    }
  })();

  return true;
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
   * The first snapshot is awaited rather than just subscribed to. Settings
   * arrive asynchronously, so polling straight away would use the env default
   * for a second or two — long enough to claim three tasks when the dashboard
   * says one, which is exactly the mistake the setting exists to prevent.
   */
  const firstSettings = new Promise((resolve) => {
    let seen = false;
    watchSettings((value) => {
      const before = seen ? maxConcurrent() : null;
      settings = value || {};
      if (!seen) {
        seen = true;
        return resolve();
      }
      const after = maxConcurrent();
      if (after !== before) {
        log('⚙️', 'settings', `max concurrent tasks: ${before} -> ${after}`);
        updateTicker();
        publishNow();
      }
    });
  });

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

  await Promise.race([
    Promise.all([firstSettings, firstMachines]),
    // Without the Realtime Database there is no snapshot coming at all.
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);

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
