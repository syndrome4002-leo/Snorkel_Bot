/*
 * commands.js — asking the server to do something, via the Realtime Database.
 *
 * Writing a command is the whole request. The server is listening on
 * /commands and claims new ones with a transaction; it then writes progress
 * back onto the same node, which arrives here as live updates. No polling, and
 * nothing needs to be able to reach the server directly.
 */

import { push, ref, onValue, serverTimestamp, set } from 'firebase/database';
import { rtdb } from './firebase';

// Everything is scoped by machine so several machines can share one project.
export const commandsPath = (machine) => `machines/${machine}/commands`;
export const statusPath = (machine) => `machines/${machine}/status`;

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

/**
 * Marks a task as submitted and awaiting a reviewer.
 *
 * Goes through the server rather than writing to Firestore directly: the
 * dashboard has read-only access there, and it is the "sent" status that later
 * makes a task eligible for feedback collection.
 */
export function markSent(machine, uid) {
  return queue(machine, 'mark_sent', { uid });
}

/** Asks the machine to check for tasks needing revision now, not in 30 minutes. */
export function checkRevisions(machine) {
  return queue(machine, 'check_revisions');
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
