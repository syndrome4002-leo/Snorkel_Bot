/*
 * tasks.js — the Tasks collection, read straight from Firestore.
 *
 * The server writes these; the dashboard only reads. onSnapshot means the table
 * updates itself the moment a task is saved or flipped to uploaded, with no
 * refresh button and no request to the server.
 */

import { collection, limit, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import { firestore } from './firebase';

export const TASKS_COLLECTION = process.env.NEXT_PUBLIC_FIREBASE_COLLECTION || 'Tasks';

/**
 * Live task list, newest first. Pass a machine id to see only that machine's
 * work, or '' for all of them.
 *
 * Filtering by machine deliberately sorts in the browser instead of asking
 * Firestore to. A where() plus an orderBy() on a different field needs a
 * composite index created by hand, and this list is small enough that it is not
 * worth making you click through that.
 */
export function watchTasks(machine, onUpdate, onError, max = 200) {
  const tasks = collection(firestore(), TASKS_COLLECTION);

  const q = machine
    ? query(tasks, where('machine_id', '==', machine), limit(max))
    : query(tasks, orderBy('updated_at', 'desc'), limit(max));

  return onSnapshot(
    q,
    (snapshot) => {
      const rows = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      if (machine) rows.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
      onUpdate(rows);
    },
    (err) => onError?.(err)
  );
}
