/*
 * rtdb.js — the worker's half of the Realtime Database channel.
 *
 * The worker takes no commands: it watches Firestore for work and gets on with
 * it. What it needs from here is the other two directions —
 *
 *   read   /machines/<id>/settings   how many tasks it may run at once
 *   write  /machines/<id>/logs       so its progress shows up on the dashboard
 *          /machines/<id>/ticker     the one line that updates in place
 *          /machines/<id>/worker     what it is doing right now
 *
 * It writes into the same machine branch snorkel_server uses, so one dashboard
 * shows both halves of the machine's work in a single stream rather than making
 * you look in two places to follow one task.
 */

import admin from 'firebase-admin';
import { config } from './config.js';
import { firebaseStatus } from './firebase.js';
import { machineId, machineInfo } from './machine.js';

const SETTINGS = () => `machines/${machineId()}/settings`;
const LOGS = () => `machines/${machineId()}/logs`;
const TICKER = () => `machines/${machineId()}/ticker`;
/*
 * Workers register in one shared place, not under the machine they happen to
 * run on.
 *
 * A worker is told which machines to work for and is usually on none of them —
 * so looking for it under the machine you are viewing finds nothing, which is
 * exactly what the dashboard did. `/workers` is where you look when you want to
 * know whether a worker exists at all.
 */
const WORKER = () => `workers/${config.worker.workspace}/${machineId()}`;

/**
 * The master switch. One node for the whole system, not per machine.
 *
 * Off means stop taking new work. Whatever is already running is left alone:
 * killing a Claude session halfway wastes it, and abandoning a browser mid
 * upload leaves a task in a state nobody chose.
 */
const SYSTEM = () => `system/${config.worker.workspace}`;

export function watchSystem(onChange) {
  if (!db) return () => {};
  const ref = db.ref(SYSTEM());
  // Absent means on. A system that switched itself off because nobody had ever
  // touched the setting would be a poor surprise.
  const handler = (snapshot) => onChange((snapshot.val() || {}).enabled !== false);
  ref.on('value', handler);
  return () => ref.off('value', handler);
}

/**
 * Watches for the dashboard asking this worker to refresh its usage figures.
 *
 * The one thing a browser may write under `workers/` — everything else there is
 * this process reporting on itself, and the rules keep it that way. The request
 * is a timestamp rather than a flag, so a second click while the first is still
 * running is a new request rather than an unnoticed repeat.
 */
export function watchUsageRefresh(onRequest) {
  if (!db) return () => {};
  const ref = db.ref(`${WORKER()}/refresh_request`);
  let handled = null;

  const handler = (snapshot) => {
    const at = snapshot.val();
    if (!at || at === handled) return;
    handled = at;
    onRequest(at);
  };
  ref.on('value', handler);
  return () => ref.off('value', handler);
}

/**
 * Watches for the dashboard asking this worker to delete a task's folder.
 *
 * Same one-writable-key arrangement as the usage refresh: a browser may put a
 * request here and nothing else. The request carries the uid and a timestamp, so
 * asking twice for the same task is two requests rather than one write nobody
 * notices.
 */
export function watchDeleteRequests(onRequest) {
  if (!db) return () => {};
  const ref = db.ref(`${WORKER()}/delete_request`);
  let handled = null;

  const handler = (snapshot) => {
    const value = snapshot.val();
    if (!value || !value.uid || !value.at || value.at === handled) return;
    handled = value.at;
    onRequest(value);
  };
  ref.on('value', handler);
  return () => ref.off('value', handler);
}

/** What came of a delete, for the dashboard and the log. */
export async function publishDeleteResult(result) {
  if (!db) return;
  try {
    await db.ref(`${WORKER()}/delete_result`).set({ at: new Date().toISOString(), ...result });
  } catch (err) {
    console.warn('[rtdb] could not publish the delete result:', err.message);
  }
}

/** What came of it, so the dashboard can stop showing a spinner. */
export async function publishRefreshResult(result) {
  if (!db) return;
  try {
    await db.ref(`${WORKER()}/refresh_result`).set({
      at: new Date().toISOString(),
      ...result,
    });
  } catch (err) {
    console.warn('[rtdb] could not publish the refresh result:', err.message);
  }
}

/*
 * The machines the dashboard has been told to work.
 *
 * Scoped to the workspace: shared by this deployment's dashboard and worker,
 * and by nothing else. Two set-ups in one Firebase project reading the same
 * list is how a worker ends up trying to build a task whose folder is on
 * somebody else's computer.
 */
const MACHINE_INDEX = () => `machines_index/${config.worker.workspace}`;

/**
 * One stream per task, keyed by UID rather than by machine.
 *
 * The machine stream answers "what is this computer doing"; this answers "what
 * happened to this task", which is a different question with a different
 * lifetime. A task can be built on one machine and revised weeks later, and its
 * history should not be spread across two log streams with everything else
 * interleaved between.
 */
const TASK_LOGS = (uid) => `task_logs/${uid}`;

const LOG_CAP = 300;

/** Per task. Lower than the machine stream: one task should not need 300 lines. */
const TASK_LOG_CAP = 200;

/** Realtime Database keys cannot contain these; a UID never should either. */
const safeKey = (value) => String(value).replace(/[.$#[\]/]/g, '_');

let db = null;
let initError = null;
let statusTimer = null;

export function rtdbStatus() {
  if (!config.firebase.databaseUrl) {
    return { enabled: false, ready: false, reason: 'FIREBASE_DATABASE_URL is not set.' };
  }
  if (db) return { enabled: true, ready: true, url: config.firebase.databaseUrl, machine_id: machineId() };
  return { enabled: true, ready: false, reason: initError ? initError.message : 'not connected' };
}

function withTimeout(promise, ms, what) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out trying to ${what}.`)), ms)),
  ]);
}

export async function initRtdb() {
  if (!config.firebase.databaseUrl) {
    console.log('[rtdb] FIREBASE_DATABASE_URL is not set — the worker will log to the console only');
    return null;
  }
  if (db) return db;

  /*
   * Do not connect with credentials that are already known to be bad. The
   * Realtime Database client retries auth forever, so a missing service-account
   * key becomes a FIREBASE WARNING every second or two, repeating until the
   * process is killed, while the real cause scrolls away above it.
   */
  const firestore = firebaseStatus();
  if (firestore.enabled && !firestore.ready) {
    console.error('[rtdb] not connecting — Firebase credentials are not usable:');
    console.error(`[rtdb]   ${firestore.reason}`);
    console.error('[rtdb] fix that first; the dashboard channel needs the same credentials.');
    initError = new Error(firestore.reason);
    return null;
  }

  try {
    const app = admin.apps.length ? admin.app() : null;
    if (!app) throw new Error('Firebase admin is not initialised.');

    db = admin.database(app);
    await withTimeout(db.ref('.info/connected').once('value'), 15000, 'connect to the Realtime Database');
    console.log(`[rtdb] connected as machine "${machineId()}"`);
    return db;
  } catch (err) {
    initError = err;
    db = null;
    console.error('[rtdb] not usable:', err.message);
    console.error('[rtdb] the worker will keep going; its progress just will not reach the dashboard');
    return null;
  }
}

// ------------------------------------------------------------ settings ----

export function watchSettings(onChange) {
  if (!db) return () => {};
  const ref = db.ref(SETTINGS());
  const handler = (snapshot) => onChange(snapshot.val() || {});
  ref.on('value', handler);
  return () => ref.off('value', handler);
}

// ------------------------------------------------------- machine index ----

/**
 * The machines whose tasks this worker should pick up.
 *
 * This is the whole reason the worker does not need to run on the same computer
 * as the thing that produced the work: it is told which machines to work for,
 * rather than assuming it is one of them. Called once with whatever is there,
 * then again on every change, so adding a machine on the dashboard takes effect
 * within seconds and without a restart.
 */
export function watchMachineIndex(onChange) {
  if (!db) return () => {};
  const ref = db.ref(MACHINE_INDEX());
  const handler = (snapshot) => {
    const rows = [];
    snapshot.forEach((child) => {
      rows.push({ id: child.key, ...(child.val() || {}) });
    });
    rows.sort((a, b) => String(a.added_at || '').localeCompare(String(b.added_at || '')));
    onChange(rows.map((row) => row.id));
  };
  ref.on('value', handler);
  return () => ref.off('value', handler);
}

/** One-shot read of the same list, for the check script. */
export async function readMachineIndex() {
  if (!db) return [];
  const snapshot = await db.ref(MACHINE_INDEX()).once('value');
  const ids = [];
  snapshot.forEach((child) => {
    ids.push(child.key);
  });
  return ids;
}

// ---------------------------------------------------------------- logs ----

let logsSinceTrim = 0;

/**
 * One line into the machine's log stream.
 *
 * Fire-and-forget on purpose: logging must never fail the thing it reports on,
 * and must never make the caller wait for a network round trip.
 */
export function pushLog(entry) {
  const line = {
    at: new Date().toISOString(),
    level: entry.level || 'info',
    emoji: entry.emoji || 'ℹ️',
    event: entry.event || 'log',
    message: String(entry.message == null ? '' : entry.message),
    ...(entry.uid ? { uid: entry.uid } : {}),
  };

  const tag = line.level === 'error' ? '[worker!]' : '[worker]';
  console.log(`${tag} ${line.emoji} ${line.event}: ${line.message}`);

  if (!db) return;
  db.ref(LOGS())
    .push(line)
    .then(() => {
      if (++logsSinceTrim < 50) return;
      logsSinceTrim = 0;
      return trimLogs();
    })
    .catch((err) => console.warn('[rtdb] could not push a log line:', err.message));

  // A line about a task goes to that task's own history as well. Written from
  // the same call so no caller has to remember to do both.
  if (line.uid) pushTaskLog(line.uid, line);
}

const taskLogsSinceTrim = new Map();

/**
 * Appends to one task's history.
 *
 * `source` says which process wrote the line, because a task's history spans
 * both: the server downloads it, the worker builds it, and reading them
 * interleaved is only useful if you can tell them apart.
 */
export function pushTaskLog(uid, entry) {
  if (!db || !uid) return;

  const key = safeKey(uid);
  db.ref(TASK_LOGS(key))
    .push({
      at: entry.at || new Date().toISOString(),
      level: entry.level || 'info',
      emoji: entry.emoji || 'ℹ️',
      event: entry.event || 'log',
      message: String(entry.message == null ? '' : entry.message),
      source: entry.source || 'worker',
      machine_id: machineId(),
    })
    .then(() => {
      const count = (taskLogsSinceTrim.get(key) || 0) + 1;
      if (count < 25) {
        taskLogsSinceTrim.set(key, count);
        return;
      }
      taskLogsSinceTrim.set(key, 0);
      return trimTaskLog(key);
    })
    .catch((err) => console.warn('[rtdb] could not push a task log line:', err.message));
}

/**
 * The line that changes rather than accumulates — "2 of 3 slots busy" would add
 * a line every poll and bury everything worth reading.
 */
export function setTicker(key, entry) {
  if (!db) return;
  db.ref(`${TICKER()}/${key}`)
    .set({
      at: new Date().toISOString(),
      emoji: entry.emoji || '⏳',
      event: entry.event || 'ticker',
      message: String(entry.message == null ? '' : entry.message),
    })
    .catch((err) => console.warn('[rtdb] could not set the ticker:', err.message));
}

async function trimTaskLog(key) {
  try {
    const snapshot = await db.ref(TASK_LOGS(key)).orderByKey().once('value');
    const keys = [];
    snapshot.forEach((child) => {
      keys.push(child.key);
    });
    if (keys.length <= TASK_LOG_CAP) return;
    const updates = {};
    // Push keys sort chronologically, so the excess is at the front.
    for (const k of keys.slice(0, keys.length - TASK_LOG_CAP)) updates[k] = null;
    await db.ref(TASK_LOGS(key)).update(updates);
  } catch (err) {
    console.warn('[rtdb] could not trim a task log:', err.message);
  }
}

async function trimLogs() {
  try {
    const snapshot = await db.ref(LOGS()).orderByKey().once('value');
    const keys = [];
    snapshot.forEach((child) => {
      keys.push(child.key);
    });
    if (keys.length <= LOG_CAP) return;
    const updates = {};
    for (const key of keys.slice(0, keys.length - LOG_CAP)) updates[key] = null;
    await db.ref(LOGS()).update(updates);
  } catch (err) {
    console.warn('[rtdb] could not trim logs:', err.message);
  }
}

// -------------------------------------------------------------- status ----

/**
 * Publishes what the worker is doing under its own key, so it sits alongside
 * the server's status rather than fighting it for the same node.
 */
export async function publishWorker(snapshot) {
  if (!db) return;
  const ref = db.ref(WORKER());
  try {
    // Executed by Firebase's servers, not by us — so it still fires if this
    // process is killed rather than shut down.
    await ref.onDisconnect().update({ online: false, updated_at: new Date().toISOString() });
    await ref.update({
      ...machineInfo(),
      ...snapshot,
      online: true,
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.warn('[rtdb] could not publish worker status:', err.message);
  }
}

let snapshotSource = null;

export function startWorkerHeartbeat(getSnapshot, everyMs = 10000) {
  snapshotSource = getSnapshot;
  publishNow();
  if (!db) return;
  statusTimer = setInterval(publishNow, everyMs);
  statusTimer.unref?.();
}

export async function publishNow() {
  if (!db || !snapshotSource) return;
  try {
    await publishWorker(await snapshotSource());
  } catch (err) {
    console.warn('[rtdb] worker status publish failed:', err.message);
  }
}

export async function goOffline() {
  if (!db) return;
  if (statusTimer) clearInterval(statusTimer);
  statusTimer = null;
  try {
    await db.ref(WORKER()).update({ online: false, updated_at: new Date().toISOString() });
  } catch {
    // Shutting down anyway; onDisconnect will handle it.
  }
}
