/*
 * tasks.js — the Tasks collection, read straight from Firestore.
 *
 * The server writes these; the dashboard only reads. onSnapshot means the table
 * updates itself the moment a task is saved or flipped to uploaded, with no
 * refresh button and no request to the server.
 */

import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  limit,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  where,
} from 'firebase/firestore';
import { firestore } from './firebase';

export const TASKS_COLLECTION = process.env.NEXT_PUBLIC_FIREBASE_COLLECTION || 'Tasks';

/** Matches TASK_STATUS_STARTED on the server: a task that is still being worked on. */
export const TASK_STATUS_IN_BUILD = 'in build';

/** The task currently in build on this machine, if there is one. */
export function findInBuild(tasks) {
  return tasks.find((task) => task.task_status === TASK_STATUS_IN_BUILD) || null;
}

/**
 * Live task list, newest first.
 *
 * `machine` is one machine id, or '' for all of them — where "all" means every
 * machine on THIS dashboard's list, not every task in the database. The Tasks
 * collection is shared by every deployment in the Firebase project, so an
 * unfiltered read shows another set-up's work as if it were yours. `mine` is
 * that list, and an empty one shows nothing rather than everything.
 *
 * Filtering by machine deliberately sorts in the browser instead of asking
 * Firestore to. A where() plus an orderBy() on a different field needs a
 * composite index created by hand, and this list is small enough that it is not
 * worth making you click through that.
 */
export function watchTasks(machine, mine, onUpdate, onError, max = 200) {
  const tasks = collection(firestore(), TASKS_COLLECTION);
  const list = Array.isArray(mine) ? mine.filter(Boolean) : [];

  if (!machine && !list.length) {
    // No machines on this dashboard: nothing of ours to show. Reporting zero is
    // right; falling back to an unfiltered read would show everyone else's.
    onUpdate([]);
    return () => {};
  }

  /*
   * Firestore's `in` takes at most 30 values. Past that the query is dropped and
   * the filtering happens in the browser — still scoped, just less efficient,
   * which is the right trade at a size nobody has yet reached.
   */
  const byList = !machine && list.length <= 30;

  const q = machine
    ? query(tasks, where('machine_id', '==', machine), limit(max))
    : byList
      ? query(tasks, where('machine_id', 'in', list), limit(max))
      : query(tasks, orderBy('updated_at', 'desc'), limit(max));

  const wanted = new Set(list);

  return onSnapshot(
    q,
    (snapshot) => {
      let rows = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      // Only the over-30 fallback needs filtering here; the other two queries
      // are already scoped by Firestore.
      if (!machine && !byList) rows = rows.filter((row) => wanted.has(row.machine_id));
      rows.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
      onUpdate(rows);
    },
    (err) => onError?.(err)
  );
}

/**
 * Removes a task's record.
 *
 * Only the record. The folder is the worker's to delete (only that machine has
 * it) and the tracking sheet is deliberately left alone — a row there is the
 * history of what was submitted, and deleting a task here does not un-submit
 * it.
 */
export function deleteTask(uid) {
  return deleteDoc(doc(firestore(), TASKS_COLLECTION, String(uid)));
}

/** Set on records added here rather than downloaded, so the two can be told apart. */
export const ADDED_BY_HAND = 'added by hand';

/**
 * Records a UID the bot should leave alone.
 *
 * For submissions done before the bot existed, or by somebody else on this
 * account. The bot skips any UID already in this collection, so a row here is
 * enough — it does not need to look like a real task, and deliberately does
 * not: no file, no Dropbox path, nothing for the worker to pick up.
 *
 * Refuses rather than overwrites when the UID is already known. Writing over a
 * real task's record with a bare one would lose its answers and its history,
 * and "add" is not a word anybody expects to mean that.
 */
export async function addKnownUid(uid, { machine = '' } = {}) {
  const id = String(uid || '').trim();
  if (!id) throw new Error('Enter a UID.');

  const ref = doc(firestore(), TASKS_COLLECTION, id);
  const existing = await getDoc(ref);
  if (existing.exists()) {
    const status = existing.data()?.task_status;
    throw new Error(`${id} is already on the list${status ? ` (${status})` : ''}.`);
  }

  const now = new Date().toISOString();
  await setDoc(ref, {
    UID: id,
    task_status: ADDED_BY_HAND,
    added_by_hand: true,
    ...(machine ? { machine_id: machine } : {}),
    created_at: now,
    updated_at: now,
  });
  return id;
}
