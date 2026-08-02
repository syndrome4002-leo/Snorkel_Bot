/*
 * firebase.js — the only place that talks to Firestore.
 *
 * Collection: "Tasks"   (override with FIREBASE_COLLECTION)
 * Document id: the submission UID, so re-running the same task updates the
 *              existing record instead of creating a duplicate.
 * Fields:      UID, machine_id, file_name, initial_infos, file_uploaded,
 *              task_status  (+ created_at / updated_at / source_url / local_path)
 */

import path from 'node:path';
import { appendFile, readFile, writeFile, rm } from 'node:fs/promises';
import admin from 'firebase-admin';
import { config, serverRoot } from './config.js';
import { machineId } from './machine.js';

/**
 * Records that could not reach Firestore are appended here as one JSON object
 * per line, in full. Nothing is lost while the database is unreachable, and
 * flushPending() replays the file once it comes back.
 */
export const PENDING_FILE = path.join(serverRoot, 'pending-tasks.jsonl');

/*
 * A task is "in build" from the moment it is started, and stays that way.
 *
 * The upload to Dropbox does NOT change it: getting the file into Dropbox is
 * part of setting the task up, not finishing it — the work itself still has to
 * be done. Only file_uploaded moves, so the two facts stay separate:
 *
 *   task_status = "in build"   this task is not finished
 *   file_uploaded = true       its zip has reached Dropbox
 *
 * This is what makes the one-task-at-a-time guard mean what it says: an earlier
 * "new" status released the guard as soon as the upload landed, which let a
 * second task start while the first had not been worked on at all.
 */
export const TASK_STATUS_STARTED = 'in build';

/** Submitted on Snorkel and waiting for a reviewer. Set from the dashboard. */
export const TASK_STATUS_SENT = 'sent';

/** The reviewer sent it back; `feedbacks` holds what they said. */
export const TASK_STATUS_NEEDS_REVISION = 'needs revision';

let db = null;
let initError = null;
let credentialSource = 'none';
let missingKeyPath = null;

const SETUP_HINT = (projectId) =>
  `Firestore has not been created in project "${projectId || 'your project'}" yet. ` +
  `Open https://console.firebase.google.com/project/${projectId}/firestore and click ` +
  `"Create database" (pick a region — it is permanent), then restart this server.`;

/** Turns opaque gRPC / auth errors into something actionable. */
function describe(err) {
  const message = err ? String(err.message || err) : 'unknown error';

  // The classic symptom of a checkout that arrived without its key file:
  // firebase-admin falls back to ADC and then cannot work out which project it
  // is meant to talk to. Name the file rather than repeating Google's wording.
  if (/Unable to detect a Project Id/i.test(message)) {
    if (missingKeyPath) {
      return (
        `No Firebase credentials. Expected the service-account key at ${missingKeyPath}, ` +
        `but there is no file there — it is git-ignored, so it does not travel with a ` +
        `clone or copy of the project. Put the key at that path (or set ` +
        `FIREBASE_SERVICE_ACCOUNT_JSON to its contents) and restart. ` +
        `This is the Google Cloud project id, nothing to do with your task records.`
      );
    }
    return (
      `Firebase could not determine which project to use. Set FIREBASE_PROJECT_ID, or ` +
      `supply a service-account key. This is the Google Cloud project id, nothing to do ` +
      `with your task records.`
    );
  }

  if (err && err.code === 5) return SETUP_HINT(config.firebase.projectId);
  if (err && err.code === 7) {
    return `Permission denied writing to Firestore. Check that the service account ` +
      `has the "Cloud Datastore User" role in project "${config.firebase.projectId}".`;
  }
  return err ? err.message : 'unknown error';
}

/** Accepts either raw JSON or the base64 of it, so it survives any env-var plumbing. */
function parseInlineKey(value) {
  const text = value.trim().startsWith('{')
    ? value
    : Buffer.from(value, 'base64').toString('utf8');
  const key = JSON.parse(text);
  if (!key.private_key || !key.client_email) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is missing private_key/client_email.');
  }
  return key;
}

/**
 * Resolves credentials without caring which machine this is:
 * inline env var -> key file -> Application Default Credentials.
 */
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
    // A path you explicitly configured and that is missing is a mistake worth
    // reporting; the built-in default simply means "try ADC instead".
    if (!credentialsPathIsDefault) {
      throw new Error(
        `Service-account file not found at ${credentialsPath}. Set FIREBASE_SERVICE_ACCOUNT ` +
          `(relative paths are resolved from the snorkel_server/ folder), or pass the key inline ` +
          `via FIREBASE_SERVICE_ACCOUNT_JSON.`
      );
    }
    // Remembered so a later ADC failure can name the file that was missing,
    // instead of surfacing a bare "Unable to detect a Project Id".
    missingKeyPath = credentialsPath;
    console.warn(`[firebase] no service-account file at ${credentialsPath}`);
    console.warn('[firebase] falling back to application default credentials');
  }

  credentialSource = 'application-default credentials';
  return { credential: admin.credential.applicationDefault(), projectId: '' };
}

export async function initFirebase() {
  if (!config.firebase.enabled) {
    console.log('[firebase] disabled (FIREBASE_ENABLED=false) — task writes will only be logged');
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
        // Needed up front: the RTDB client cannot be pointed at a database
        // after the app has been created.
        ...(config.firebase.databaseUrl ? { databaseURL: config.firebase.databaseUrl } : {}),
      });
      console.log(`[firebase] credentials from ${credentialSource}`);
    }
    const candidate = admin.firestore();
    candidate.settings({ ignoreUndefinedProperties: true });

    // Credentials loading is not the same as Firestore being reachable: the
    // database may simply not exist yet. Probe once so /api/status tells the
    // truth instead of failing on the first real task.
    await candidate.collection(config.firebase.collection).limit(1).get();

    db = candidate;
    initError = null;
    console.log(
      `[firebase] ready — writing to collection "${config.firebase.collection}"` +
        (config.firebase.projectId ? ` in project ${config.firebase.projectId}` : '')
    );
    return db;
  } catch (err) {
    initError = err;
    db = null;
    console.error('[firebase] not usable:', describe(err));
    console.error('[firebase] the server will keep running; task writes will be logged only');
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

// ------------------------------------------------------ pending spool ----

async function spool(record) {
  try {
    await appendFile(PENDING_FILE, JSON.stringify(record) + '\n', 'utf8');
  } catch (err) {
    console.error('[firebase] could not spool the record to disk:', err.message);
  }
}

async function readPending() {
  try {
    const raw = await readFile(PENDING_FILE, 'utf8');
    return raw
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

export async function pendingCount() {
  return (await readPending()).length;
}

/**
 * Replays every spooled record into Firestore. Later entries win for a repeated
 * UID, matching the merge-by-UID behaviour of a live save. The file is removed
 * only when everything lands; on partial failure the survivors stay queued.
 */
export async function flushPending() {
  const pending = await readPending();
  if (!pending.length) return { flushed: 0, remaining: 0 };
  if (!db) {
    return {
      flushed: 0,
      remaining: pending.length,
      reason: initError ? describe(initError) : 'Firestore is not connected.',
    };
  }

  const failed = [];
  let flushed = 0;
  for (const record of pending) {
    try {
      const ref = db.collection(config.firebase.collection).doc(String(record.UID));
      const existing = await ref.get();
      if (!existing.exists && !record.created_at) record.created_at = record.updated_at;
      await ref.set(record, { merge: true });
      flushed++;
    } catch (err) {
      console.error(`[firebase] replay failed for ${record.UID}:`, describe(err));
      failed.push(record);
    }
  }

  if (failed.length) {
    await writeFile(PENDING_FILE, failed.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  } else {
    await rm(PENDING_FILE, { force: true });
  }

  console.log(`[firebase] replayed ${flushed} pending record(s); ${failed.length} still queued`);
  return { flushed, remaining: failed.length };
}

/**
 * Saves one task. `task` must carry UID, file_name and initial_infos; `meta` is
 * optional context from the extension (page url, download path, ...).
 */
export async function saveTask(task, meta = {}) {
  if (!task || !task.UID) throw new Error('Cannot save a task without a UID.');

  const record = {
    UID: String(task.UID),
    // Which computer actually ran this. Lets the dashboard show one machine's
    // work when several report into the same project.
    machine_id: machineId(),
    file_name: task.file_name ? String(task.file_name) : null,
    initial_infos: task.initial_infos ? String(task.initial_infos) : '',
    source_url: meta.page_url || null,
    // Where Chrome put the zip, so the Dropbox step can find it later even
    // across a server restart.
    local_path: meta.download_path || null,
    // Set up front so the fields always exist and can be queried. The Dropbox
    // step flips file_uploaded to true and leaves task_status alone.
    file_uploaded: false,
    task_status: TASK_STATUS_STARTED,
    updated_at: new Date().toISOString(),
  };

  if (!db) {
    const reason = config.firebase.enabled
      ? describe(initError)
      : 'Firebase is disabled (FIREBASE_ENABLED=false).';
    await spool(record);
    console.log(`[firebase] NOT WRITTEN — ${reason}`);
    console.log(`[firebase] full record spooled to ${PENDING_FILE} — replay it with POST /api/flush`);
    return { saved: false, id: record.UID, record, reason, spooled: true };
  }

  try {
    const ref = db.collection(config.firebase.collection).doc(record.UID);
    const existing = await ref.get();
    if (!existing.exists) record.created_at = record.updated_at;

    await ref.set(record, { merge: true });
    console.log(`[firebase] saved ${config.firebase.collection}/${record.UID} (${record.file_name})`);
    return { saved: true, id: record.UID, record };
  } catch (err) {
    // The task itself succeeded, so the record is spooled and returned to the
    // caller rather than thrown away.
    const reason = describe(err);
    await spool(record);
    console.error('[firebase] write failed —', reason);
    console.error(`[firebase] full record spooled to ${PENDING_FILE}`);
    return { saved: false, id: record.UID, record, reason, spooled: true };
  }
}

/**
 * Marks a task as uploaded to Dropbox. This is the state change the whole
 * Dropbox step exists to make.
 */
export async function markUploaded(uid, extra = {}) {
  if (!db) throw new Error(describe(initError));
  const patch = {
    file_uploaded: true,
    // Deliberately does not touch task_status: the task stays "in build".
    uploaded_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...extra,
  };
  await db.collection(config.firebase.collection).doc(String(uid)).set(patch, { merge: true });
  console.log(`[firebase] ${config.firebase.collection}/${uid} -> file_uploaded=true (still "in build")`);
  return patch;
}

/** Marks a task as submitted and awaiting review. */
export async function markSent(uid) {
  if (!db) throw new Error(describe(initError));
  const patch = {
    task_status: TASK_STATUS_SENT,
    sent_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  await db.collection(config.firebase.collection).doc(String(uid)).set(patch, { merge: true });
  console.log(`[firebase] ${config.firebase.collection}/${uid} -> task_status="${TASK_STATUS_SENT}"`);
  return patch;
}

/**
 * Records reviewer feedback and flips the task to "needs revision".
 *
 * `feedbacks` is an append-only array, so a task sent back several times keeps
 * every round rather than only the latest. A round already stored with the same
 * text is not added twice — the periodic check will see the same feedback
 * again on every pass until the task is resubmitted.
 */
export async function addFeedback(uid, entry, extra = {}) {
  if (!db) throw new Error(describe(initError));

  const ref = db.collection(config.firebase.collection).doc(String(uid));
  const snapshot = await ref.get();
  const existing = snapshot.exists ? snapshot.data() : null;
  const feedbacks = Array.isArray(existing?.feedbacks) ? existing.feedbacks : [];

  const duplicate = feedbacks.some((item) => item && item.text === entry.text);
  const next = duplicate ? feedbacks : [...feedbacks, entry];

  const now = new Date().toISOString();
  const record = {
    UID: String(uid),
    machine_id: existing?.machine_id || machineId(),
    task_status: TASK_STATUS_NEEDS_REVISION,
    feedbacks: next,
    // Stamped even when the feedback was unchanged, so an unchanged task is not
    // reopened on every single sweep.
    feedback_checked_at: now,
    updated_at: now,
    ...extra,
  };
  // A submission the reviewer sent back that this bot never downloaded is still
  // a task worth having — it just starts life needing revision.
  if (!snapshot.exists) {
    record.created_at = now;
    record.file_uploaded = false;
    record.initial_infos = existing?.initial_infos || '';
  }

  await ref.set(record, { merge: true });
  console.log(
    `[firebase] ${config.firebase.collection}/${uid} -> task_status="${TASK_STATUS_NEEDS_REVISION}", ` +
      `${next.length} feedback round(s)${duplicate ? ' (unchanged)' : ''}${snapshot.exists ? '' : ' [new task]'}`
  );
  return { record, created: !snapshot.exists, duplicate, rounds: next.length };
}

/** How long before a task already carrying feedback is looked at again. */
export const RECOLLECT_AFTER_MS = Number(process.env.RECOLLECT_AFTER_MINUTES || 60) * 60 * 1000;

/**
 * Which of `uids` are worth opening to read feedback from.
 *
 * A task is a candidate when:
 *   - this database has never seen it,
 *   - it is marked "sent" and so is waiting on a reviewer, or
 *   - it already has feedback but has not been looked at for a while.
 *
 * That last case is the one that matters for a task sent back MORE THAN ONCE.
 * The rule used to be "sent or unknown" only, which meant that the moment a
 * task's first feedback was stored its status became "needs revision" and it
 * was skipped by every later sweep — so a second round could never arrive, and
 * the first round looked like the only one there would ever be.
 *
 * Re-reading is safe because addFeedback ignores feedback whose text it has
 * already stored; an unchanged reviewer message does not pile up.
 */
export async function findFeedbackCandidates(uids, recollectAfterMs = RECOLLECT_AFTER_MS) {
  if (!db || !uids.length) return { wanted: [], reasons: {} };

  const wanted = [];
  const reasons = {};
  const now = Date.now();

  // Read one at a time by document id: an "in" query is capped at 30 values and
  // these lists are short.
  for (const uid of uids) {
    const snap = await db.collection(config.firebase.collection).doc(String(uid)).get();

    if (!snap.exists) {
      wanted.push(String(uid));
      reasons[uid] = 'not seen before';
      continue;
    }

    const task = snap.data();
    if (task.task_status === TASK_STATUS_SENT) {
      wanted.push(String(uid));
      reasons[uid] = 'sent, awaiting a reviewer';
      continue;
    }

    const last = task.feedback_checked_at ? new Date(task.feedback_checked_at).getTime() : 0;
    if (!last || now - last > recollectAfterMs) {
      wanted.push(String(uid));
      reasons[uid] = last
        ? `last read ${Math.round((now - last) / 60000)} min ago`
        : 'never read';
    }
  }

  return { wanted, reasons };
}

/**
 * The task this machine is still working on, if any.
 *
 * Two equality filters need no composite index — Firestore merges the automatic
 * single-field ones — so this works without any index setup.
 */
export async function findInBuildTask(machine) {
  if (!db) return null;
  const snap = await db
    .collection(config.firebase.collection)
    .where('machine_id', '==', machine)
    .where('task_status', '==', TASK_STATUS_STARTED)
    .limit(1)
    .get();
  return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
}

/**
 * The most recently updated task whose file has not reached Dropbox yet.
 * Filtering happens in memory on purpose: a where() + orderBy() on different
 * fields would require a composite index to be created by hand first.
 */
export async function findPendingUpload() {
  const recent = await listTasks(50);
  return recent.find((t) => t.file_uploaded !== true && t.UID) || null;
}

export async function listTasks(limit = 50) {
  if (!db) return [];
  const snap = await db
    .collection(config.firebase.collection)
    .orderBy('updated_at', 'desc')
    .limit(limit)
    .get();
  return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

export async function getTask(uid) {
  if (!db) return null;
  const doc = await db.collection(config.firebase.collection).doc(String(uid)).get();
  return doc.exists ? { id: doc.id, ...doc.data() } : null;
}
