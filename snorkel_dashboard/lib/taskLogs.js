/*
 * taskLogs.js — one task's history, rather than one machine's.
 *
 * The machine stream answers "what is this computer doing"; this answers "what
 * happened to this task". Both the server and the worker write into it, so a
 * task built on one machine and revised weeks later still reads as a single
 * sequence.
 */

import { limitToLast, onValue, query, ref } from 'firebase/database';
import { rtdb } from './firebase';

/** Realtime Database keys cannot contain these; the writers strip them too. */
const safeKey = (value) => String(value).replace(/[.$#[\]/]/g, '_');

export const taskLogsPath = (uid) => `task_logs/${safeKey(uid)}`;

/** Live log for one task, oldest first. Returns an unsubscribe function. */
export function watchTaskLogs(uid, onUpdate, max = 200) {
  const q = query(ref(rtdb(), taskLogsPath(uid)), limitToLast(max));
  return onValue(q, (snapshot) => {
    const rows = [];
    snapshot.forEach((child) => {
      rows.push({ id: child.key, ...child.val() });
    });
    onUpdate(rows);
  });
}
