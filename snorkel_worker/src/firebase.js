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
/** Claude is done; the platform's checks run next. */
export const TASK_STATUS_READY = 'ready to submit';

/** Set by snorkel_server when one of the platform's checks came back FAIL. */
export const TASK_STATUS_STATIC_FAIL = 'static check fail';
/** Both platform checks passed. The end of the road for the bot. */
export const TASK_STATUS_STATIC_PASS = 'static checks pass';

/*
 * Triage outcomes. A task that is not fixable is not worked at all: there are no
 * corrections to make, no zip to build and no form to fill in, so the run stops
 * at the answer and the task waits for a person.
 */
export const TASK_STATUS_INVALID = 'invalid';
export const TASK_STATUS_VALID_AS_IS = 'valid-as-is';

/**
 * The statuses the worker picks up, and nothing else.
 *
 * All three are on. Revisions were held back for a while so the first-build path
 * could be watched on its own; HANDLE_REVISIONS=false puts them back on hold
 * without removing anything.
 *
 * "static check fail" is not a reviewer's round — it is whatever was last
 * uploaded being corrected, whether that came from a build or a revision.
 */
export const WORKABLE = [
  TASK_STATUS_BUILD,
  TASK_STATUS_STATIC_FAIL,
  ...(config.worker.handleRevisions ? [TASK_STATUS_NEEDS_REVISION] : []),
];

/**
 * Every status a claimed task may be put back to.
 *
 * Deliberately not the same list. A task is picked up from WORKABLE, but it has
 * to be returned to wherever it actually came from — including a status the
 * worker is no longer taking. Sharing one list would quietly reset an
 * interrupted revision to "in build", and the next run would download the zip
 * again and rebuild it from scratch, losing the round it was part way through.
 */
export const RESTORABLE = [
  TASK_STATUS_BUILD,
  TASK_STATUS_NEEDS_REVISION,
  TASK_STATUS_STATIC_FAIL,
  TASK_STATUS_READY,
];

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
/*
 * How long a task is left alone after the worker failed on it, by attempt.
 *
 * A failure is usually not a coincidence: the same task, resumed into the same
 * session, reaches the same conclusion. Without a wait it is re-claimed on the
 * next poll thirty seconds later, and each of those attempts is a full Claude
 * session — a task failing overnight ran up a session every half minute until
 * somebody noticed.
 *
 * It escalates rather than giving up, because plenty of failures are worth
 * retrying eventually: a lost network, a full disk, a usage window that resets.
 * An hour apart is cheap enough to leave running and slow enough to notice.
 */
const RETRY_WAIT_MINUTES = [5, 15, 45, 60];

/** Whether enough time has passed since this task last failed. */
export function retryDue(task) {
  if (!task || !task.worker_failed_at) return true;
  const failedAt = new Date(task.worker_failed_at).getTime();
  if (!Number.isFinite(failedAt)) return true;
  const failures = Math.max(1, Number(task.worker_failures) || 1);
  const wait = RETRY_WAIT_MINUTES[Math.min(failures, RETRY_WAIT_MINUTES.length) - 1];
  return Date.now() >= failedAt + wait * 60000;
}

/** What retryDue() is waiting for, in minutes. Exported for the failure message. */
export function retryWaitMinutes(failures) {
  return RETRY_WAIT_MINUTES[Math.min(Math.max(1, failures), RETRY_WAIT_MINUTES.length) - 1];
}

export async function findWorkableTasks(machineIds = [], limit = 10, staticFixLimit = null) {
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

  /*
   * A task that has been round the fix loop too many times is left alone.
   *
   * "Until both checks pass" and "forever" are the same instruction when the fix
   * is not working, and each round costs a Claude session and two platform
   * builds. Past the limit it stays at "static check fail" for a person.
   */
  const eligible = [...found.values()].filter((task) => {
    // Failures repeat. Trying again immediately buys a second identical failure
    // at the price of a whole Claude session — see retryDue().
    if (!retryDue(task)) return false;
    if (task.task_status !== TASK_STATUS_STATIC_FAIL) return true;
    const cap = staticFixLimit ?? config.worker.maxStaticFixAttempts;
    const attempts = Number(task.static_fix_attempts || 0);
    if (attempts < cap) return true;
    console.log(`[firebase] ${task.UID} has had ${attempts} static-check fixes (limit ${cap}) — leaving it`);
    return false;
  });

  return eligible.sort((a, b) => String(a.updated_at || '').localeCompare(String(b.updated_at || '')));
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

/**
 * Puts a task back after a failure, with the reason attached.
 *
 * Counts the failure too. Consecutive failures are what the retry wait is based
 * on, and the count is kept on the task rather than in this process so it
 * survives a restart — a worker restarted in a loop would otherwise reset the
 * wait to nothing every time.
 */
export async function releaseTask(uid, toStatus, reason) {
  if (!db) return { failures: 0, retryInMinutes: 0 };
  const now = new Date().toISOString();
  const before = await docRef(uid).get().catch(() => null);
  const failures = (Number(before?.data()?.worker_failures) || 0) + 1;
  await docRef(uid).set(
    {
      task_status: toStatus,
      worker_error: reason ? String(reason).slice(0, 2000) : null,
      worker_failed_at: now,
      worker_failures: failures,
      worker_pid: null,
      updated_at: now,
    },
    { merge: true }
  );
  console.log(`[firebase] ${uid} -> back to "${toStatus}" (${reason || 'no reason given'})`);
  return { failures, retryInMinutes: retryWaitMinutes(failures) };
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

  const ref = docRef(uid);
  const snap = await ref.get();
  const existing = snap.exists && snap.data().answers && !Array.isArray(snap.data().answers)
    ? snap.data().answers
    : {};

  /*
   * An empty reply means two different things depending on what is already here.
   *
   * On a revision it is an ordinary outcome, and one the prompt asks for: it
   * requests the answers that CHANGED and says to leave out anything still
   * correct, so a round that fixed the code without altering what the form says
   * about it correctly returns nothing. Treating that as a failure put the task
   * back to "needs revision", where it was picked up again half a minute later,
   * ran the same Claude session to the same conclusion, and failed the same way
   * — for as long as nobody was watching, at the cost of a full session each
   * time.
   *
   * With no stored answers there is nothing to fall back on, so an empty reply
   * is a genuinely failed extraction and still stops the run.
   */
  const empty = !answers || !Object.keys(answers).length;
  if (empty && !Object.keys(existing).length) {
    throw new Error('Refusing to save an empty answers object.');
  }
  const history = Array.isArray(snap.data()?.answers_history) ? snap.data().answers_history : [];

  const now = new Date().toISOString();
  const merged = { ...existing, ...answers };
  const changed = Object.keys(answers || {}).filter(
    (key) => JSON.stringify(existing[key]) !== JSON.stringify(answers[key])
  );

  /*
   * Nothing to merge and nothing worth a history entry — the stored answers are
   * already what this round would have written. The round is still visible in
   * the log and in `feedbacks`; a history entry holding no fields would only
   * make the answer history harder to read.
   */
  if (empty) {
    console.log(`[firebase] ${uid} -> revision changed no answers; keeping the ${Object.keys(existing).length} already stored`);
    return { fields: Object.keys(existing).length, changed: [], round: history.length, unchanged: true };
  }

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

/**
 * Ends a run without producing a submission.
 *
 * Used when triage says the task is invalid or already valid: nothing was
 * changed, nothing is uploaded, and the task stops here for a person to look at.
 */
export async function markTriaged(uid, status, note = '') {
  if (!db) throw new Error(describe(initError));
  const now = new Date().toISOString();
  const patch = {
    task_status: status,
    triage_note: note || null,
    triaged_at: now,
    worker_pid: null,
    worker_error: null,
    // A run that got somewhere clears the failure record, so an old failure
    // cannot go on delaying a task that is now working.
    worker_failures: 0,
    worker_failed_at: null,
    updated_at: now,
  };
  await db.collection(config.firebase.collection).doc(String(uid)).set(patch, { merge: true });
  console.log(`[firebase] ${uid} -> task_status="${status}" (triage)`);
  return patch;
}

/**
 * The end state: Claude is done and, if there was anything to upload, the zip is
 * back on Dropbox.
 *
 * `file_uploaded` follows from whether an upload actually happened, rather than
 * being asserted. It used to be hard-coded true, which was right for the path
 * that had just uploaded a zip and wrong for the one that never uploads
 * anything: a task ending at a verdict has nothing to pack — the folder is the
 * reviewer's own file — so it was being recorded as having a file in Dropbox
 * that had never been put there.
 *
 * The claim matters. `file_uploaded` is what the submit sweep reads as "there is
 * a file to fetch and attach", and what the lost-upload sweep reads as "this one
 * is fine". A task that says yes and means no is a submission that goes looking
 * for a file nobody uploaded.
 *
 * The evidence is the path: the two callers that upload pass `dropbox_path`, and
 * the verdict caller passes `needs_upload: false` and no path. Any path already
 * on the record is left alone — it may still point at a real file from an
 * earlier step, and this function has no way to know.
 */
export async function markReady(uid, extra = {}) {
  if (!db) throw new Error(describe(initError));
  const now = new Date().toISOString();
  const uploaded = Boolean(extra.dropbox_path) && extra.needs_upload !== false;
  const patch = {
    task_status: TASK_STATUS_READY,
    file_uploaded: uploaded,
    worker_finished_at: now,
    worker_pid: null,
    worker_error: null,
    // A run that got somewhere clears the failure record, so an old failure
    // cannot go on delaying a task that is now working.
    worker_failures: 0,
    worker_failed_at: null,
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
 * Tasks that are finished but have no file anywhere.
 *
 * The server hands a task's zip to the browser and deletes it from Dropbox in
 * the same breath, which is what stops a stale build being uploaded later. If
 * the browser then fails before attaching it — a collapsed section, a lost tab —
 * the task is left at "ready to submit" with `file_uploaded` false and nothing
 * in Dropbox. The submit sweep requires `file_uploaded`, so it skips it forever.
 *
 * Nothing is lost: the unpacked folder is still here. This finds those tasks so
 * the zip can be put back, and no Claude session is involved — the work was done
 * long ago.
 */
export async function findLostUploads(machineIds = []) {
  if (!db) return [];

  const found = new Map();
  const base = db.collection(config.firebase.collection).where('task_status', '==', TASK_STATUS_READY);

  const collect = async (query) => {
    const snap = await query.limit(20).get();
    for (const doc of snap.docs) {
      const task = { id: doc.id, ...doc.data() };
      // Only ones the server has already consumed. A task waiting for its first
      // upload is the worker's ordinary business, not this.
      if (task.file_uploaded === true) continue;
      /*
       * And never one that has nothing to upload. A verdict task's folder is the
       * reviewer's own file, unchanged — packing it and calling it a rebuilt
       * submission would upload their file back to them as our work.
       */
      if (task.needs_upload === false) continue;
      if (!task.submit_file_served_at) continue;

      /*
       * And only once the submission can no longer be in progress.
       *
       * A healthy run leaves the task in exactly this state for as long as it
       * takes to upload a couple of hundred megabytes and wait on two platform
       * builds. Re-uploading during that would put a second copy in Dropbox
       * underneath a browser that is still working, and the worker has no way to
       * see the browser — so the only thing separating "failed" from "still
       * going" is how long ago it started.
       */
      const servedMs = new Date(task.submit_file_served_at).getTime();
      const ageMinutes = (Date.now() - servedMs) / 60000;
      if (!Number.isFinite(ageMinutes) || ageMinutes < config.worker.lostUploadAfterMinutes) continue;

      found.set(doc.id, { ...task, stranded_for_minutes: Math.round(ageMinutes) });
    }
  };

  if (config.worker.anyMachine) await collect(base);
  else for (const machine of machineIds) await collect(base.where('machine_id', '==', machine));

  return [...found.values()];
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
