/*
 * commands.js — asking the server to do something, via the Realtime Database.
 *
 * Writing a command is the whole request. The server is listening on
 * /commands and claims new ones with a transaction; it then writes progress
 * back onto the same node, which arrives here as live updates. No polling, and
 * nothing needs to be able to reach the server directly.
 */

import { limitToLast, onValue, push, query, ref, serverTimestamp, set, update } from 'firebase/database';
import { rtdb } from './firebase';

// Everything is scoped by machine so several machines can share one project.
export const commandsPath = (machine) => `machines/${machine}/commands`;
export const statusPath = (machine) => `machines/${machine}/status`;
export const settingsPath = (machine) => `machines/${machine}/settings`;
export const logsPath = (machine) => `machines/${machine}/logs`;
export const tickerPath = (machine) => `machines/${machine}/ticker`;
export const workerPath = (machine) => `machines/${machine}/worker`;

/** Queues a command for one machine. Returns its id so the caller can watch it. */
async function queue(machine, type, extra = {}) {
  if (!machine) throw new Error('Pick a machine first.');
  const commandRef = push(ref(rtdb(), commandsPath(machine)));
  await set(commandRef, {
    type,
    status: 'pending',
    step: 'queued',
    machine_id: machine,
    // ISO for the server's staleness check; serverTimestamp for ordering that
    // does not depend on this device's clock being right.
    requested_at: new Date().toISOString(),
    requested_at_ms: serverTimestamp(),
    ...extra,
  });
  return commandRef.key;
}

export function startNewTask(machine, options = {}) {
  return queue(machine, 'start_new_task', { options });
}

/** Asks the machine to check for tasks needing revision now, not in 30 minutes. */
export function checkRevisions(machine) {
  return queue(machine, 'check_revisions');
}

/** Per-machine settings the server reads — currently just the revise limit. */
export function watchSettings(machine, onUpdate) {
  return onValue(ref(rtdb(), settingsPath(machine)), (snapshot) => onUpdate(snapshot.val() || {}));
}

export function saveSettings(machine, patch) {
  return update(ref(rtdb(), settingsPath(machine)), patch);
}

/**
 * The machine's log stream, newest last.
 *
 * limitToLast keeps this bounded on the client as well as the server: a machine
 * that has been running for days should not send its whole history to a browser
 * that only wants the recent lines.
 */
export function watchLogs(machine, onUpdate, max = 200) {
  const q = query(ref(rtdb(), logsPath(machine)), limitToLast(max));
  return onValue(q, (snapshot) => {
    const rows = [];
    snapshot.forEach((child) => {
      rows.push({ id: child.key, ...child.val() });
    });
    onUpdate(rows);
  });
}

/**
 * The single line that changes rather than accumulates — currently the
 * countdown to the next revision check. Kept out of the log stream on purpose:
 * a line a minute would bury everything else.
 */
export function watchTicker(machine, onUpdate) {
  return onValue(ref(rtdb(), tickerPath(machine)), (snapshot) => onUpdate(snapshot.val()));
}

/** Live updates for one command. Returns an unsubscribe function. */
export function watchCommand(machine, id, onUpdate) {
  return onValue(ref(rtdb(), `${commandsPath(machine)}/${id}`), (snapshot) => {
    onUpdate(snapshot.val());
  });
}

/**
 * Live server status. `online` is maintained by Firebase itself through
 * onDisconnect, so it flips to false even if the server is killed outright.
 */
export function watchServerStatus(machine, onUpdate) {
  return onValue(ref(rtdb(), statusPath(machine)), (snapshot) => {
    onUpdate(snapshot.val());
  });
}

/**
 * What snorkel_worker is doing, including how much of the Claude subscription
 * it can see left. Published under its own key so it sits alongside the
 * server's status rather than competing with it for the same node.
 */
export function watchWorker(machine, onUpdate) {
  return onValue(ref(rtdb(), workerPath(machine)), (snapshot) => onUpdate(snapshot.val()));
}
