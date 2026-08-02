/*
 * lock.js — one worker per machine, enforced.
 *
 * Two workers on one machine would be a quiet kind of broken. They would not
 * corrupt a task — claims go through a Firestore transaction — but they would
 * each keep their own count of how many tasks are open, so a cap of three would
 * really be six, and a machine set up to run three Claude sessions would be
 * running six. Nothing would report an error; it would just be slow, expensive,
 * and wrong in a way you would only notice from the bill.
 *
 * So the second one refuses to start, and says which process is already holding
 * the machine.
 *
 * The lock is a file rather than a database entry on purpose: "one per machine"
 * is a fact about this computer, and it has to hold even with no network.
 */

import { open, readFile, rm } from 'node:fs/promises';
import { readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { workerRoot } from './config.js';
import { machineId } from './machine.js';

const LOCK_FILE = path.join(workerRoot, 'worker.lock');

export class AlreadyRunningError extends Error {
  constructor(holder) {
    const since = holder.started_at ? ` since ${holder.started_at}` : '';
    super(
      `Another worker is already running on this machine (pid ${holder.pid}${since}).\n` +
        `Only one worker may run per machine — two would each keep their own count of ` +
        `open tasks, so the concurrency cap would silently be doubled.\n\n` +
        `  stop it:   kill ${holder.pid}\n` +
        `  look:      ps -p ${holder.pid} -o pid,etime,args\n\n` +
        `If that process is long gone, delete ${LOCK_FILE} and start again.`
    );
    this.code = 'WORKER_ALREADY_RUNNING';
    this.holder = holder;
  }
}

/** Is that pid still there? EPERM means it exists but belongs to someone else. */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * Is that pid still *this* program?
 *
 * The lock file outlives a reboot, and pids are recycled — without this check a
 * machine could come back up with something unrelated sitting on the old pid and
 * refuse to start the worker, with a message blaming a process that has nothing
 * to do with it.
 *
 * Linux only; elsewhere a live pid is taken at face value, which errs towards
 * refusing to start rather than towards running twice.
 */
async function looksLikeWorker(pid) {
  try {
    const cmdline = await readFile(`/proc/${pid}/cmdline`, 'utf8');
    return cmdline.includes('index.js') || cmdline.includes('snorkel_worker');
  } catch (err) {
    if (err.code === 'ENOENT') return process.platform !== 'linux';
    return true;
  }
}

async function readLock() {
  try {
    return JSON.parse(await readFile(LOCK_FILE, 'utf8'));
  } catch {
    // Unreadable or half-written: treat as stale rather than jamming the worker
    // shut on a corrupt file.
    return null;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How long to wait for a holder that is on its way out.
 *
 * `node --watch` starts the replacement process as soon as it has signalled the
 * old one, so during development the lock is routinely held for a moment by a
 * process that is already shutting down. Refusing immediately made every other
 * save fail with "another worker is already running", which is noise rather than
 * a warning. A live holder that is really staying put still gets refused — just
 * two seconds later.
 */
const HANDOVER_GRACE_MS = 2000;
const HANDOVER_POLL_MS = 100;

/**
 * Takes the machine's worker lock, or throws AlreadyRunningError.
 *
 * `wx` creates the file only if it does not exist — the check and the create are
 * one operation, so two workers starting at the same instant cannot both win.
 */
export async function acquireLock({ graceMs = HANDOVER_GRACE_MS } = {}) {
  const deadline = Date.now() + graceMs;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const handle = await open(LOCK_FILE, 'wx');
      await handle.writeFile(
        JSON.stringify(
          {
            pid: process.pid,
            machine_id: machineId(),
            hostname: os.hostname(),
            started_at: new Date().toISOString(),
          },
          null,
          2
        )
      );
      await handle.close();
      return LOCK_FILE;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;

      const holder = await readLock();

      if (holder?.pid && alive(holder.pid) && (await looksLikeWorker(holder.pid))) {
        // Give a departing holder its moment before declaring a conflict.
        let waited = false;
        while (Date.now() < deadline) {
          await sleep(HANDOVER_POLL_MS);
          waited = true;
          if (!alive(holder.pid)) break;
        }
        if (alive(holder.pid)) throw new AlreadyRunningError(holder);
        if (waited) console.log(`[lock] pid ${holder.pid} finished shutting down — taking over`);
      } else {
        console.warn(
          `[lock] ${LOCK_FILE} was left behind by pid ${holder?.pid ?? 'unknown'}, which is gone — taking it over`
        );
      }

      await rm(LOCK_FILE, { force: true });
    }
  }

  throw new Error(`Could not take ${LOCK_FILE} after three attempts.`);
}

/** Gives the lock up, but only if it is still ours. */
export async function releaseLock() {
  const holder = await readLock();
  if (holder && holder.pid !== process.pid) return;
  await rm(LOCK_FILE, { force: true });
}

/**
 * The same, from a process.on('exit') handler, where nothing async can run.
 *
 * The last resort: whatever else happens on the way down, the lock should not
 * outlive the process that took it.
 */
export function releaseLockSync() {
  try {
    const holder = JSON.parse(readFileSync(LOCK_FILE, 'utf8'));
    if (holder.pid !== process.pid) return;
    unlinkSync(LOCK_FILE);
  } catch {
    // Already gone, unreadable, or somebody else's — nothing to do either way.
  }
}

/** Who holds it, or null. For reporting — does not take anything. */
export async function lockHolder() {
  const holder = await readLock();
  if (!holder?.pid) return null;
  if (!(await workerProcessAlive(holder.pid))) return null;
  return holder;
}

/**
 * Is a worker with this pid still running on this machine?
 *
 * Used by crash recovery as a second opinion. Recovery is sound *because* the
 * lock guarantees one worker per machine — but a lock file can be deleted by
 * hand, and the advice for a worker that will not start is to do exactly that.
 * Do it while the first worker is still alive and the second one's recovery would
 * reclaim tasks that are being worked on right now.
 *
 * So recovery asks about the pid as well as the status. Cheap, local, and it
 * turns a bypassed lock from data loss into a warning.
 */
export async function workerProcessAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  if (!alive(n)) return false;
  return looksLikeWorker(n);
}

export { LOCK_FILE };
