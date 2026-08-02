/*
 * firebase.js — the worker's slice of Firestore.
 *
 * Deliberately narrow: the worker only ever finds work, claims it, and reports
 * the outcome. Everything about *producing* tasks lives in snorkel_server.
 *
 * Claiming goes through a transaction. Two workers pointed at the same project,
 * or one worker whose poll overlaps its own previous poll, must not both start
 * the same task — Claude editing one folder from two processes would be a mess
 * that is hard to notice and harder to undo.
 */

import { readFile } from 'node:fs/promises';
import admin from 'firebase-admin';
import { config } from './config.js';
import { machineId } from './machine.js';

/** Set by snorkel_server when the extension downloads a task. */
export const TASK_STATUS_BUILD = 'in build';
/** Set by snorkel_server when reviewer feedback comes back. */
export const TASK_STATUS_NEEDS_REVISION = 'needs revision';
/** Held while Claude has the folder open. */
export const TASK_STATUS_WORKING = 'Working..';
/** Claude is done; a human submits it. */
export const TASK_STATUS_READY = 'ready to submit';

/** The two statuses the worker picks up, and nothing else. */
export const WORKABLE = [TASK_STATUS_BUILD, TASK_STATUS_NEEDS_REVISION];

let db = null;
let initError = null;
let credentialSource = '';
let missingKeyPath = '';

function describe(err) {
  const message = String(err?.message || err);

  if (err?.code === 5 || /NOT_FOUND/.test(message)) {
    return (
      `${message} — the Firestore database does not exist in project ` +
      `"${config.firebase.projectId || 'unknown'}". Create it at ` +
      `https://console.firebase.google.com/project/${config.firebase.projectId || '_'}/firestore`
    );
  }
  if (err?.code === 7 || /PERMISSION_DENIED/.test(message)) {
    return (
      `${message} — the service account cannot reach Firestore. Grant it the ` +
      `"Cloud Datastore User" role in Google Cloud IAM.`
    );
  }
  if (/Unable to detect a Project Id/i.test(message) && missingKeyPath) {
    return (
      `${message} — there is no service-account key at ${missingKeyPath} and no ` +
      `application-default credentials on this machine. That file is git-ignored, ` +
      `so it does not travel with a clone: copy it across, or set ` +
      `FIREBASE_SERVICE_ACCOUNT_JSON with the key inline.`
    );
  }
  return message;
}

function parseInlineKey(value) {
  const raw = value.trim();
  const text = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  const key = JSON.parse(text);
  // A key pasted through a shell often arrives with the newlines escaped.
  if (key.private_key) key.private_key = key.private_key.replace(/\\n/g, '\n');
  return key;
}

async function loadCredential() {
  const { credentialsJson, credentialsPath, credentialsPathIsDefault } = config.firebase;

  if (credentialsJson) {
    const key = parseInlineKey(credentialsJson);
    credentialSource = 'FIREBASE_SERVICE_ACCOUNT_JSON';
    return { credential: admin.credential.cert(key), projectId: key.project_id };
  }

  try {
    const key = JSON.parse(await readFile(credentialsPath, 'utf8'));
    credentialSource = credentialsPath;
    return { credential: admin.credential.cert(key), projectId: key.project_id };
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    if (!credentialsPathIsDefault) {
      throw new Error(
        `Service-account file not found at ${credentialsPath}. Set FIREBASE_SERVICE_ACCOUNT ` +
          `(relative paths resolve from the snorkel_worker/ folder), or pass the key inline ` +
          `via FIREBASE_SERVICE_ACCOUNT_JSON.`
      );
    }
    missingKeyPath = credentialsPath;
    console.warn(`[firebase] no service-account file at ${credentialsPath}`);
    console.warn('[firebase] falling back to application default credentials');
  }

  credentialSource = 'application-default credentials';
  return { credential: admin.credential.applicationDefault(), projectId: '' };
}

export async function initFirebase() {
  if (!config.firebase.enabled) {
    console.log('[firebase] disabled (FIREBASE_ENABLED=false) — there is nothing for the worker to do');
    return null;
  }
  if (db) return db;

  try {
    if (!admin.apps.length) {
      const loaded = await loadCredential();
      const projectId = config.firebase.projectId || loaded.projectId;
      if (!config.firebase.projectId && projectId) config.firebase.projectId = projectId;
      admin.initializeApp({
        credential: loaded.credential,
        ...(projectId ? { projectId } : {}),
        // The RTDB client cannot be pointed at a database after the app exists.
        ...(config.firebase.databaseUrl ? { databaseURL: config.firebase.databaseUrl } : {}),
      });
      console.log(`[firebase] credentials from ${credentialSource}`);
    }

    const candidate = admin.firestore();
    candidate.settings({ ignoreUndefinedProperties: true });
    await candidate.collection(config.firebase.collection).limit(1).get();

    db = candidate;
    initError = null;
    console.log(
      `[firebase] ready — collection "${config.firebase.collection}"` +
        (config.firebase.projectId ? ` in project ${config.firebase.projectId}` : '')
    );
    return db;
  } catch (err) {
    initError = err;
    db = null;
    console.error('[firebase] not usable:', describe(err));
    return null;
  }
}

export function firebaseStatus() {
  if (!config.firebase.enabled) return { enabled: false, ready: false, reason: 'disabled by config' };
  if (db) {
    return {
      enabled: true,
      ready: true,
      projectId: config.firebase.projectId,
      collection: config.firebase.collection,
      credentials: credentialSource,
    };
  }
  return { enabled: true, ready: false, reason: initError ? describe(initError) : 'not initialised' };
}

const docRef = (uid) => db.collection(config.firebase.collection).doc(String(uid));

/**
 * Tasks this worker could pick up, oldest first so nothing starves.
 *
 * `machineIds` is the list from the dashboard — whose work to do. The worker
 * does not have to be one of them: it may sit on a completely different computer
 * from the one that produced the task, because an "in build" task arrives as a
 * zip from Dropbox and everything after that happens locally.
 *
 * One query per machine per status rather than a single `in`: two equality
 * filters are covered by Firestore's automatic single-field indexes, whereas
 * mixing an equality with an `in` would need a composite index created by hand
 * first. The lists here are short, so a handful of small exact queries beats one
 * broad one that has to be filtered afterwards.
 */
export async function findWorkableTasks(machineIds = [], limit = 10) {
  if (!db) return [];

  const found = new Map();

  for (const status of WORKABLE) {
    const base = db.collection(config.firebase.collection).where('task_status', '==', status);

    if (config.worker.anyMachine) {
      const snap = await base.limit(limit).get();
      for (const doc of snap.docs) found.set(doc.id, { id: doc.id, ...doc.data() });
      continue;
    }

    for (const machine of machineIds) {
      const snap = await base.where('machine_id', '==', machine).limit(limit).get();
      for (const doc of snap.docs) found.set(doc.id, { id: doc.id, ...doc.data() });
    }
  }

  return [...found.values()].sort((a, b) => String(a.updated_at || '').localeCompare(String(b.updated_at || '')));
}

/**
 * Flips one task to "Working..", but only if it is still in the state we saw.
 *
 * Returns the task as it was before the claim (so the caller knows which of the
 * two paths to take), or null when somebody else got there first.
 */
export async function claimTask(uid, fromStatus) {
  if (!db) throw new Error(describe(initError));

  const ref = docRef(uid);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;

    const data = snap.data();
    if (data.task_status !== fromStatus) return null;

    const now = new Date().toISOString();
    tx.set(
      ref,
      {
        task_status: TASK_STATUS_WORKING,
        // Remembered so a failure — or a crash — can put the task back exactly
        // where it came from rather than guessing.
        worked_from: fromStatus,
        worker_machine: machineId(),
        worker_pid: process.pid,
        worker_started_at: now,
        worker_error: null,
        updated_at: now,
      },
      { merge: true }
    );

    return { id: snap.id, ...data };
  });
}

/** Puts a task back after a failure, with the reason attached. */
export async function releaseTask(uid, toStatus, reason) {
  if (!db) return;
  const now = new Date().toISOString();
  await docRef(uid).set(
    {
      task_status: toStatus,
      worker_error: reason ? String(reason).slice(0, 2000) : null,
      worker_failed_at: now,
      worker_pid: null,
      updated_at: now,
    },
    { merge: true }
  );
  console.log(`[firebase] ${uid} -> back to "${toStatus}" (${reason || 'no reason given'})`);
}

/**
 * Records the submitter-form answers.
 *
 * An object keyed by field name, not a list of rounds, because that is the shape
 * the answers are used in: each key is one box on the platform's form.
 *
 * It is also what makes a revision work. A reviewer sends back a handful of
 * points, and the revision prompt asks for the fields that changed and only
 * those, so merging the reply over what is already stored leaves the untouched
 * answers exactly as they were. A list of rounds could not do that without
 * somebody reading both and working out which won.
 *
 * `answers_history` keeps a copy of each round anyway. Merging loses the
 * previous value of an overwritten field, and when an answer gets worse rather
 * than better, that is the thing you want to look at.
 */
export async function saveAnswers(uid, answers, meta = {}) {
  if (!db) throw new Error(describe(initError));
  if (!answers || !Object.keys(answers).length) {
    throw new Error('Refusing to save an empty answers object.');
  }

  const ref = docRef(uid);
  const snap = await ref.get();
  const existing = snap.exists && snap.data().answers && !Array.isArray(snap.data().answers)
    ? snap.data().answers
    : {};
  const history = Array.isArray(snap.data()?.answers_history) ? snap.data().answers_history : [];

  const now = new Date().toISOString();
  const merged = { ...existing, ...answers };
  const changed = Object.keys(answers).filter(
    (key) => JSON.stringify(existing[key]) !== JSON.stringify(answers[key])
  );

  await ref.set(
    {
      answers: merged,
      answers_history: [...history, { ...meta, at: now, round: history.length + 1, fields: answers }],
      answers_updated_at: now,
      updated_at: now,
    },
    { merge: true }
  );

  console.log(
    `[firebase] ${uid} -> ${Object.keys(merged).length} answer field(s), ` +
      `${changed.length} changed this round (${changed.join(', ') || 'none'})`
  );
  return { fields: Object.keys(merged).length, changed, round: history.length + 1 };
}

/** The end state: Claude is done and the zip is back on Dropbox. */
export async function markReady(uid, extra = {}) {
  if (!db) throw new Error(describe(initError));
  const now = new Date().toISOString();
  const patch = {
    task_status: TASK_STATUS_READY,
    file_uploaded: true,
    worker_finished_at: now,
    worker_pid: null,
    worker_error: null,
    updated_at: now,
    ...extra,
  };
  await docRef(uid).set(patch, { merge: true });
  console.log(`[firebase] ${uid} -> task_status="${TASK_STATUS_READY}"`);
  return patch;
}

/**
 * The zip has been pulled off Dropbox and deleted there, so nothing is stored
 * remotely any more.
 */
export async function markDownloaded(uid, localPath) {
  if (!db) throw new Error(describe(initError));
  const now = new Date().toISOString();
  await docRef(uid).set(
    {
      file_uploaded: false,
      dropbox_path: null,
      local_path: localPath || null,
      downloaded_at: now,
      updated_at: now,
    },
    { merge: true }
  );
}

export async function patchTask(uid, patch) {
  if (!db) return;
  await docRef(uid).set({ ...patch, updated_at: new Date().toISOString() }, { merge: true });
}

export async function getTask(uid) {
  if (!db) return null;
  const doc = await docRef(uid).get();
  return doc.exists ? { id: doc.id, ...doc.data() } : null;
}

/**
 * Tasks left stuck in "Working.." by a worker that died.
 *
 * A status is a claim, and a claim outlives the process that made it. Without
 * this a single crash would park a task forever, because "Working.." is not a
 * state anything else picks up.
 */
export async function findOrphanedTasks() {
  if (!db) return [];

  // Always scoped to this worker's own claims — `worker_machine` is who was
  // doing the work, not whose task it is. Another machine's worker may be
  // partway through one of these right now, and its claims are not ours to
  // release however the task list is configured.
  const snap = await db
    .collection(config.firebase.collection)
    .where('task_status', '==', TASK_STATUS_WORKING)
    .where('worker_machine', '==', machineId())
    .limit(25)
    .get();

  return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}
