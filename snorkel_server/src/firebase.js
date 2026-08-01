/*
 * firebase.js — the only place that talks to Firestore.
 *
 * Collection: "Tasks"   (override with FIREBASE_COLLECTION)
 * Document id: the submission UID, so re-running the same task updates the
 *              existing record instead of creating a duplicate.
 * Fields:      UID, file_name, initial_infos  (+ created_at / updated_at / source_url)
 */

import { readFile } from 'node:fs/promises';
import admin from 'firebase-admin';
import { config } from './config.js';

let db = null;
let initError = null;
let credentialSource = 'none';

const SETUP_HINT = (projectId) =>
  `Firestore has not been created in project "${projectId || 'your project'}" yet. ` +
  `Open https://console.firebase.google.com/project/${projectId}/firestore and click ` +
  `"Create database" (pick a region — it is permanent), then restart this server.`;

/** Turns the opaque "5 NOT_FOUND" gRPC error into something actionable. */
function describe(err) {
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
      admin.initializeApp({ credential: loaded.credential, ...(projectId ? { projectId } : {}) });
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

/**
 * Saves one task. `task` must carry UID, file_name and initial_infos; `meta` is
 * optional context from the extension (page url, download path, ...).
 */
export async function saveTask(task, meta = {}) {
  if (!task || !task.UID) throw new Error('Cannot save a task without a UID.');

  const record = {
    UID: String(task.UID),
    file_name: task.file_name ? String(task.file_name) : null,
    initial_infos: task.initial_infos ? String(task.initial_infos) : '',
    source_url: meta.page_url || null,
    updated_at: new Date().toISOString(),
  };

  if (!db) {
    const reason = config.firebase.enabled
      ? describe(initError)
      : 'Firebase is disabled (FIREBASE_ENABLED=false).';
    console.log('[firebase] NOT WRITTEN —', reason, '\n', {
      ...record,
      initial_infos: `${record.initial_infos.slice(0, 120)}… (${record.initial_infos.length} chars)`,
    });
    return { saved: false, id: record.UID, record, reason };
  }

  try {
    const ref = db.collection(config.firebase.collection).doc(record.UID);
    const existing = await ref.get();
    if (!existing.exists) record.created_at = record.updated_at;

    await ref.set(record, { merge: true });
    console.log(`[firebase] saved ${config.firebase.collection}/${record.UID} (${record.file_name})`);
    return { saved: true, id: record.UID, record };
  } catch (err) {
    // The task itself succeeded, so the record is still returned to the caller
    // (and logged) rather than thrown away.
    const reason = describe(err);
    console.error('[firebase] write failed —', reason);
    return { saved: false, id: record.UID, record, reason };
  }
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
