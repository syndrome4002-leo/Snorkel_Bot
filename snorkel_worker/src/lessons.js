/*
 * lessons.js — the worker's half of the failure pipeline.
 *
 * snorkel_server files each failed check under a signature and marks it beaten
 * when a later run passes. This side does the two things that need Claude:
 * writing down what actually fixed a failure, and putting what is already known
 * in front of the next build.
 *
 * Only confirmed lessons are ever shown. An unconfirmed one is a guess about a
 * failure nobody has fixed yet, and feeding guesses back into the build is how a
 * knowledge base starts teaching its own mistakes.
 */

import admin from 'firebase-admin';
import { config } from './config.js';

const COLLECTION = () => config.firebase.lessonsCollection;

/** Beyond this a prompt is being padded rather than informed. */
const MAX_IN_PROMPT = 15;

const db = () => admin.firestore();

/**
 * The lessons worth telling the model about, most frequent first.
 *
 * Frequency is the ranking because it is the closest thing to importance the
 * data has: a complaint seen on nine tasks will probably be the tenth task's
 * problem too.
 */
export async function confirmedLessons(limit = MAX_IN_PROMPT) {
  try {
    const snap = await db().collection(COLLECTION()).where('confirmed', '==', true).limit(200).get();
    return snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((l) => l.lesson)
      .sort((a, b) => (b.occurrences || 0) - (a.occurrences || 0))
      .slice(0, limit);
  } catch (err) {
    // Never allowed to stop a build. The lessons are an advantage, not a
    // dependency, and a task that cannot read them should still be worked.
    console.warn('[lessons] could not be read:', err.message);
    return [];
  }
}

/** Those lessons as a block for a prompt, or '' when there are none yet. */
export async function lessonsBlock() {
  const lessons = await confirmedLessons();
  if (!lessons.length) return '';

  const lines = lessons.map(
    (l) => `${l.label || l.check}: ${l.lesson}${l.occurrences > 1 ? ` (seen ${l.occurrences} times)` : ''}`
  );

  return (
    `These are checks that have failed on earlier tasks and what fixed them. ` +
    `Avoid repeating them here.\n\n${lines.join('\n\n')}\n`
  );
}

/**
 * Stores what fixed a failure, against the signatures the task was carrying.
 *
 * Written after the fix, before it is known to have worked — `confirmed` stays
 * false until the platform actually passes the task, which is snorkel_server's
 * job. So a lesson is recorded early and trusted late.
 */
export async function recordLesson(signatures, lesson) {
  const text = String(lesson || '').trim();
  if (!text) return 0;

  const list = (signatures || []).map((s) => (typeof s === 'string' ? s : s.signature)).filter(Boolean);
  if (!list.length) return 0;

  let written = 0;
  for (const signature of list) {
    try {
      await db()
        .collection(COLLECTION())
        .doc(signature)
        .set({ lesson: text.slice(0, 1500), lesson_written_at: new Date().toISOString() }, { merge: true });
      written++;
    } catch (err) {
      console.warn(`[lessons] could not write ${signature}:`, err.message);
    }
  }
  return written;
}
