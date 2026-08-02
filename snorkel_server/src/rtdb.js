/*
 * rtdb.js — the server's half of the Realtime Database channel.
 *
 * Instead of the dashboard calling this server over HTTP, both sides meet at
 * Firebase. The server only ever makes *outbound* connections, so it works from
 * behind NAT, a VM, or a home router with nothing forwarded.
 *
 *   /machines/<machineId>/commands/<pushId>   work the dashboard is asking for
 *   /machines/<machineId>/status              what this server can see, live
 *
 * Everything is scoped by machine id, so several machines can share one Firebase
 * project without seeing each other's work. Each server only ever watches its
 * own branch.
 *
 * A command is claimed with a transaction before it runs, so even if two copies
 * of the server were pointed at the same branch only one would pick it up.
 */

import admin from 'firebase-admin';
import { config } from './config.js';
import { machineId, machineInfo } from './machine.js';

const COMMANDS = () => `machines/${machineId()}/commands`;
const STATUS = () => `machines/${machineId()}/status`;
const SETTINGS = () => `machines/${machineId()}/settings`;
const LOGS = () => `machines/${machineId()}/logs`;
const TICKER = () => `machines/${machineId()}/ticker`;

/**
 * One stream per task, keyed by UID rather than by machine.
 *
 * The machine stream answers "what is this computer doing"; this answers "what
 * happened to this task". Both this server and snorkel_worker write here, so a
 * task's history reads as one sequence even though two processes on two
 * different computers produced it.
 */
const TASK_LOGS = (uid) => `task_logs/${uid}`;

/** Log lines kept per machine. Old ones are trimmed rather than kept forever. */
const LOG_CAP = 300;

/** Per task. Lower than the machine stream: one task should not need 300 lines. */
const TASK_LOG_CAP = 200;

/** Realtime Database keys cannot contain these; a UID never should either. */
const safeKey = (value) => String(value).replace(/[.$#[\]/]/g, '_');

/** Older than this when we first see it and it is not worth running. */
const STALE_MS = 10 * 60 * 1000;

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

/**
 * Connects to the database. firebase-admin has already been initialised by
 * firebase.js; this adds the databaseURL that the RTDB client needs.
 */
export async function initRtdb() {
  if (!config.firebase.databaseUrl) {
    console.log('[rtdb] FIREBASE_DATABASE_URL is not set — the dashboard channel is off');
    return null;
  }
  if (db) return db;

  try {
    const app = admin.apps.length ? admin.app() : null;
    if (!app) throw new Error('Firebase admin is not initialised.');

    db = admin.database(app);
    // A cheap read proves the URL is real and the credentials work. Without it
    // the client would sit there retrying a wrong hostname forever.
    await withTimeout(db.ref('.info/connected').once('value'), 15000, 'connect to the Realtime Database');

    console.log(`[rtdb] connected to ${config.firebase.databaseUrl} as machine "${machineId()}"`);
    return db;
  } catch (err) {
    initError = err;
    db = null;
    console.error('[rtdb] not usable:', err.message);
    console.error('[rtdb] the dashboard will not be able to reach this server');
    return null;
  }
}

function withTimeout(promise, ms, what) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out trying to ${what}.`)), ms)),
  ]);
}

// -------------------------------------------------------------- status ----

/**
 * Publishes what the dashboard needs for its status pills, and arranges for the
 * "online" flag to flip by itself if this process dies — onDisconnect is
 * executed by Firebase's servers, not by us.
 */
export async function publishStatus(snapshot) {
  if (!db) return;
  const ref = db.ref(STATUS());
  try {
    await ref.onDisconnect().update({ online: false, updated_at: new Date().toISOString() });
    await ref.update({
      ...machineInfo(),
      ...snapshot,
      online: true,
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.warn('[rtdb] could not publish status:', err.message);
  }
}

let snapshotSource = null;

export function startStatusHeartbeat(getSnapshot, everyMs = 10000) {
  if (!db) return;
  snapshotSource = getSnapshot;
  publishNow();
  statusTimer = setInterval(publishNow, everyMs);
  statusTimer.unref?.();
}

/**
 * Pushes the status straight away instead of waiting for the next beat. Used
 * when something the dashboard reacts to changes — a run starting or ending —
 * so the button does not stay wrong for up to ten seconds.
 */
export async function publishNow() {
  if (!db || !snapshotSource) return;
  try {
    await publishStatus(await snapshotSource());
  } catch (err) {
    console.warn('[rtdb] status publish failed:', err.message);
  }
}

export function stopStatusHeartbeat() {
  if (statusTimer) clearInterval(statusTimer);
  statusTimer = null;
}

// ------------------------------------------------------------ settings ----

/**
 * Per-machine settings the dashboard writes and this server reads.
 * Called once with whatever is there, then again on every change.
 */
export function watchSettings(onChange) {
  if (!db) return () => {};
  const ref = db.ref(SETTINGS());
  const handler = (snapshot) => onChange(snapshot.val() || {});
  ref.on('value', handler);
  return () => ref.off('value', handler);
}

// ---------------------------------------------------------------- logs ----

let logsSinceTrim = 0;

/**
 * Publishes one line to the machine's log stream.
 *
 * Deliberately fire-and-forget: logging must never be able to fail the thing it
 * is reporting on, and must never make the caller wait.
 */
export function pushLog(entry) {
  if (!db) return;
  const line = {
    at: new Date().toISOString(),
    level: entry.level || 'info',
    emoji: entry.emoji || 'ℹ️',
    event: entry.event || 'log',
    message: String(entry.message == null ? '' : entry.message),
    ...(entry.uid ? { uid: entry.uid } : {}),
  };

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

/** Appends to one task's history. `source` says which process wrote the line. */
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
      source: entry.source || 'server',
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

async function trimTaskLog(key) {
  try {
    const snapshot = await db.ref(TASK_LOGS(key)).orderByKey().once('value');
    const keys = [];
    snapshot.forEach((child) => {
      keys.push(child.key);
    });
    if (keys.length <= TASK_LOG_CAP) return;
    const updates = {};
    for (const k of keys.slice(0, keys.length - TASK_LOG_CAP)) updates[k] = null;
    await db.ref(TASK_LOGS(key)).update(updates);
  } catch (err) {
    console.warn('[rtdb] could not trim a task log:', err.message);
  }
}

/**
 * The one line that changes rather than accumulates.
 *
 * A countdown pushed into the log stream would add a line a minute — 1,440 a
 * day, burying everything worth reading. This is a single node that is
 * overwritten in place, so the dashboard can show it pinned under the stream
 * without it ever becoming history.
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

/** Drops the oldest lines once the stream grows past the cap. */
async function trimLogs() {
  try {
    const snapshot = await db.ref(LOGS()).orderByKey().once('value');
    const keys = [];
    snapshot.forEach((child) => {
      keys.push(child.key);
    });
    if (keys.length <= LOG_CAP) return;
    // Push keys sort chronologically, so the excess is at the front.
    const updates = {};
    for (const key of keys.slice(0, keys.length - LOG_CAP)) updates[key] = null;
    await db.ref(LOGS()).update(updates);
  } catch (err) {
    console.warn('[rtdb] could not trim logs:', err.message);
  }
}

// ------------------------------------------------------------ commands ----

/**
 * Marks a command as ours. Returns false when somebody else got there first, or
 * when it is too old to be worth running (queued while the server was down for
 * a long time — the person who asked has moved on).
 */
async function claim(ref) {
  const requestedAt = (await ref.child('requested_at').once('value')).val();
  if (requestedAt && Date.now() - new Date(requestedAt).getTime() > STALE_MS) {
    await ref.update({ status: 'expired', error: 'The server was not running when this was requested.' });
    return false;
  }

  const result = await ref.child('status').transaction((current) => {
    if (current !== 'pending') return undefined; // abort: not ours to take
    return 'running';
  });
  return result.committed;
}

/**
 * Watches for new commands and hands each one to `run`.
 *
 * `run(command, report)` should do the work; `report(patch)` writes progress
 * back to the same node so the dashboard sees it live.
 */
export function watchCommands(run) {
  if (!db) return () => {};

  const ref = db.ref(COMMANDS());

  const onAdded = async (snapshot) => {
    const command = snapshot.val();
    if (!command || command.status !== 'pending') return;

    const commandRef = snapshot.ref;
    if (!(await claim(commandRef))) return;

    const id = snapshot.key;
    console.log(`[rtdb] claimed command ${id} (${command.type})`);

    const report = (patch) => commandRef.update(patch).catch((err) => {
      console.warn(`[rtdb] could not report progress for ${id}:`, err.message);
    });

    try {
      const result = await run(command, report);
      await commandRef.update({
        status: 'succeeded',
        finished_at: new Date().toISOString(),
        ...result,
      });
      console.log(`[rtdb] command ${id} succeeded`);
    } catch (err) {
      await commandRef.update({
        status: 'failed',
        error: String(err.message || err),
        // e.g. START_UNAVAILABLE (no task was handed out) or TASK_IN_BUILD.
        // The dashboard reacts to the code rather than matching on wording.
        error_code: err.code || null,
        finished_at: new Date().toISOString(),
      });
      console.error(`[rtdb] command ${id} failed: ${err.message}`);
    }
  };

  // child_added fires for existing children too, which is what picks up a
  // command queued while this process was starting.
  ref.on('child_added', onAdded);
  console.log(`[rtdb] watching ${COMMANDS()} for work`);

  return () => ref.off('child_added', onAdded);
}
