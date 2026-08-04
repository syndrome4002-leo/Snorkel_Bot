/*
 * lessons.js — what the platform's checks keep rejecting, and what fixed it.
 *
 * Every failed check is worth more than the one task it blocked. The same
 * complaints come back across tasks, and a failure that has already been solved
 * once should not have to be discovered again at the cost of a Claude session
 * and two platform builds.
 *
 * Collection: "CheckLessons", one document per distinct failure.
 *
 *   signature    what makes two failures "the same"
 *   occurrences  how often it has been seen
 *   lesson       one line on how to avoid it, written after a fix worked
 *   confirmed    whether that lesson has actually been proven by a later pass
 *
 * Only confirmed lessons are ever put in front of the model. An unconfirmed one
 * is a guess about a failure nobody has fixed yet, and feeding guesses back into
 * the build is how a knowledge base starts teaching its own mistakes.
 */

import { createHash } from 'node:crypto';
import admin from 'firebase-admin';
import { config } from './config.js';

const COLLECTION = () => config.firebase.lessonsCollection;

/**
 * Strips everything that makes one run different from another.
 *
 * Build ids, timestamps, durations, temp paths and hashes all change every time
 * while saying nothing about what went wrong. Left in, the same failure would
 * hash differently on every task and the collection would be a list, not an
 * index.
 */
export function normaliseLog(text) {
  return String(text || '')
    .replace(/CodeExecutionEnvironment:[0-9a-f-]+/gi, 'CodeExecutionEnvironment:<id>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b[0-9a-f]{32,}\b/gi, '<hash>')
    .replace(/\d{4}[/-]\d{2}[/-]\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?/g, '<time>')
    .replace(/\b\d+(\.\d+)?\s*(ms|s|sec|secs|seconds|m|min|mins|minutes)\b/gi, '<duration>')
    .replace(/\/tmp\/[^\s'"]+/g, '/tmp/<path>')
    .replace(/(^|\s)\d+(\s|$)/g, '$1<n>$2')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * The part of a build log worth fingerprinting.
 *
 * A build log is mostly the same setup chatter every time; what differs is the
 * error near the end. Taking the tail keeps the signature about the failure
 * rather than about the container that hosted it.
 */
function essence(logs, summary) {
  const normalised = normaliseLog(logs);
  const lines = normalised.split(' ').length > 40 ? normalised.slice(-1200) : normalised;
  return `${normaliseLog(summary)} :: ${lines}`;
}

export function signatureOf(check) {
  return createHash('sha256').update(essence(check.logs, check.summary)).digest('hex').slice(0, 16);
}

const db = () => admin.firestore();

/**
 * Records the checks that failed on one task.
 *
 * Returns the signatures, so the task can carry a note of which known failures
 * it hit — that is what later lets a pass be attributed to the right lesson.
 */
export async function recordFailures(uid, result) {
  const failed = (result.results || []).filter((r) => r.verdict !== 'pass');
  if (!failed.length) return [];

  const now = new Date().toISOString();
  const signatures = [];

  for (const check of failed) {
    const signature = signatureOf(check);
    signatures.push({ signature, check: check.key, label: check.label });

    const ref = db().collection(COLLECTION()).doc(signature);
    const snap = await ref.get();

    if (snap.exists) {
      const seen = snap.data();
      await ref.set(
        {
          occurrences: (seen.occurrences || 0) + 1,
          last_seen_at: now,
          // Capped: a lesson seen on fifty tasks does not need fifty uids, and
          // the document has a size limit.
          uids: [...new Set([...(seen.uids || []), uid])].slice(-25),
        },
        { merge: true }
      );
      continue;
    }

    await ref.set({
      signature,
      check: check.key,
      label: check.label,
      summary: check.summary || '',
      // Enough of the log to recognise it and to write a lesson from, not the
      // whole thing — this collection is an index, not an archive.
      excerpt: String(check.logs || '').slice(-4000),
      occurrences: 1,
      first_seen_at: now,
      last_seen_at: now,
      uids: [uid],
      lesson: null,
      confirmed: false,
    });
  }

  console.log(`[lessons] ${uid} hit ${signatures.length} failure(s): ${signatures.map((s) => s.signature).join(', ')}`);
  return signatures;
}

/**
 * Marks the failures a task was carrying as beaten.
 *
 * Called when its checks finally pass. A lesson written after a fix is only a
 * claim until this happens — this is the moment it becomes something worth
 * telling the next task about.
 */
export async function confirmLessons(uid, signatures) {
  const list = (signatures || []).map((s) => (typeof s === 'string' ? s : s.signature)).filter(Boolean);
  if (!list.length) return 0;

  let confirmed = 0;
  for (const signature of list) {
    const ref = db().collection(COLLECTION()).doc(signature);
    const snap = await ref.get();
    if (!snap.exists) continue;

    await ref.set(
      {
        resolved_count: (snap.data().resolved_count || 0) + 1,
        // A lesson with no text cannot teach anything, so it stays unconfirmed
        // until the worker has written one.
        confirmed: Boolean(snap.data().lesson),
        last_resolved_at: new Date().toISOString(),
        last_resolved_by: uid,
      },
      { merge: true }
    );
    confirmed++;
  }

  console.log(`[lessons] ${uid} resolved ${confirmed} known failure(s)`);
  return confirmed;
}

/*
 * ----------------------------------------------------------- review side ----
 *
 * The same store, for the complaints a reviewer's automated panes make. Two
 * differences from the platform checks above:
 *
 *   - the signature is already readable (`judge:discuss/overreach`) rather than
 *     a hash of a build log, so there is nothing to normalise;
 *   - it contains a slash, and a Firestore document id may not. Hence the
 *     encoding below — without it every write throws.
 */

const REVIEW_PREFIX = 'review__';

/** A review signature as something Firestore will accept as a document id. */
export const reviewDocId = (signature) => `${REVIEW_PREFIX}${String(signature).replace(/\//g, '~')}`;

/**
 * Counts the complaints a round is carrying.
 *
 * Called for every round, including ones that changed nothing: `occurrences` is
 * how the prompt ranks lessons, and a complaint that keeps coming back is the
 * one most worth telling the next task about.
 */
export async function recordReviewFailures(uid, signatures) {
  const list = [...new Set((signatures || []).filter(Boolean))];
  if (!list.length) return [];

  const now = new Date().toISOString();
  for (const signature of list) {
    const ref = db().collection(COLLECTION()).doc(reviewDocId(signature));
    const snap = await ref.get();

    if (snap.exists) {
      const seen = snap.data();
      await ref.set(
        {
          occurrences: (seen.occurrences || 0) + 1,
          last_seen_at: now,
          uids: [...new Set([...(seen.uids || []), uid])].slice(-25),
        },
        { merge: true }
      );
      continue;
    }

    await ref.set({
      signature,
      source: 'review',
      check: signature.split(':')[0],
      label: signature,
      occurrences: 1,
      first_seen_at: now,
      last_seen_at: now,
      uids: [uid],
      lesson: null,
      confirmed: false,
    });
  }

  console.log(`[lessons] ${uid} round carries ${list.length} review complaint(s): ${list.join(', ')}`);
  return list;
}

/**
 * Marks review complaints as beaten, but only when the round was a clean win.
 *
 * A round that fixed three things and broke the oracle is not evidence about
 * what fixes things — whatever Claude wrote down after it describes the damage
 * as well as the repair. Confirming from a round like that is how the store
 * starts teaching its own mistakes, so those rounds teach nothing at all.
 */
export async function confirmReviewLessons(uid, fixed, { clean = true } = {}) {
  const list = [...new Set((fixed || []).filter(Boolean))];
  if (!list.length) return 0;
  if (!clean) {
    console.log(
      `[lessons] ${uid} fixed ${list.length} review complaint(s) but introduced others — not confirming`
    );
    return 0;
  }

  let confirmed = 0;
  for (const signature of list) {
    const ref = db().collection(COLLECTION()).doc(reviewDocId(signature));
    const snap = await ref.get();
    if (!snap.exists) continue;

    await ref.set(
      {
        resolved_count: (snap.data().resolved_count || 0) + 1,
        // No text, nothing to teach — it waits for the worker to write one.
        confirmed: Boolean(snap.data().lesson),
        last_resolved_at: new Date().toISOString(),
        last_resolved_by: uid,
      },
      { merge: true }
    );
    confirmed++;
  }

  console.log(`[lessons] ${uid} confirmed ${confirmed} review lesson(s)`);
  return confirmed;
}

/** Everything worth showing, newest and most frequent first. */
export async function listLessons(limit = 100) {
  const snap = await db().collection(COLLECTION()).limit(limit).get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.occurrences || 0) - (a.occurrences || 0));
}
