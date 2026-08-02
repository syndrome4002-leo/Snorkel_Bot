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
import { machineId, machineInfo } from './machine.js';

const SETTINGS = () => `machines/${machineId()}/settings`;
const LOGS = () => `machines/${machineId()}/logs`;
const TICKER = () => `machines/${machineId()}/ticker`;
const WORKER = () => `machines/${machineId()}/worker`;

/** The machines the dashboard has been told to work. Shared, not per-machine. */
const MACHINE_INDEX = 'machines_index';

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
  const ref = db.ref(MACHINE_INDEX);
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
  const snapshot = await db.ref(MACHINE_INDEX).once('value');
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
