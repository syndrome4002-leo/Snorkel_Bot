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
