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
import { recordFailures, confirmLessons, recordReviewFailures, confirmReviewLessons } from './lessons.js';
import { diffRounds, describeDiff, madeThingsWorse, signaturesOf } from './checksigns.js';
import { deleteFile } from './dropbox.js';

/**
 * Whether a task document belongs to this deployment.
 *
 * One Firebase project can carry several set-ups that have nothing to do with
 * each other — different people, different Snorkel accounts, different machines
 * — and they share this collection. So "is a new task already in progress" and
 * "how many went out today" are questions about *our* tasks; answered over the
 * whole collection, somebody else building a task stops us from starting one,
 * and their submissions spend our daily limit. Both of which happened.
 *
 * Documents written before the workspace was recorded fall back to the machine:
 * this server created them, so its own id is on them. It is the narrower test —
 * it would miss a second server in the same workspace — but it only applies to
 * documents already written, and every one saved from now on carries the
 * workspace outright.
 */
export function ours(task) {
  if (!task) return false;
  if (task.workspace) return task.workspace === config.workspace;
  return task.machine_id === machineId();
}

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

/** Set by snorkel_worker when Claude is done and the zip is back on Dropbox. */
export const TASK_STATUS_READY = 'ready to submit';

/** One of the platform's own checks came back FAIL. Needs a person. */
export const TASK_STATUS_STATIC_FAIL = 'static check fail';

/** Both of the platform's checks passed. Waiting on a person to submit it. */
export const TASK_STATUS_STATIC_PASS = 'static checks pass';

/**
 * The platform gave this assignment to somebody else while we still had it.
 *
 * A dead end rather than a failure: there is no page left to open and nothing
 * to submit. It exists mainly so the task stops counting as unfinished — left
 * at "ready to submit" it would block every future start, waiting to be handed
 * in on a page that no longer belongs to us.
 */
export const TASK_STATUS_TAKEN = 'taken by other';

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
    /*
     * Which deployment this task belongs to — see ours(). The machine alone is
     * not enough to answer that: a deployment is a set of machines, and the
     * questions that matter ("is one of ours already in build") are asked about
     * the set.
     */
    workspace: config.workspace,
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
    /*
     * A task the bot started from scratch, as opposed to one that turned up in
     * the revise list already needing work. It stays true through the first
     * build and the first submission, and is cleared the moment a reviewer sends
     * feedback back — from then on every round is a revision.
     *
     * Worth its own field rather than being inferred from `feedbacks.length`:
     * "has never been reviewed" and "we have not collected the feedback yet" are
     * different things, and only one of them means the task is new.
     */
    is_new_task: meta.adopted ? false : true,
    /*
     * Taken on from the revise list rather than started from the project page:
     * somebody submitted it by hand, it came back for revision, and the owner
     * matches ours. Two things follow from it — the submission already exists,
     * so it is reached by its "Revise task" row rather than by starting a new
     * one, and it is already in the tracking sheet, so no row is added when it
     * goes back.
     */
    ...(meta.adopted ? { adopted: true, adopted_at: new Date().toISOString() } : {}),
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

/**
 * How many tasks have been submitted since midnight, and which.
 *
 * Counted from `sent_at` rather than from a tally kept somewhere, so it survives
 * restarts, is right across several machines, and cannot drift out of step with
 * what actually happened. Midnight is this machine's local midnight, which is
 * the day boundary a person means when they say "per day".
 *
 * Not scoped to a machine: the limit is about the Snorkel account, and two
 * machines each submitting up to the limit would be twice the intended number.
 * It is scoped to the deployment, though — another set-up sharing this Firebase
 * project is a different Snorkel account, and its submissions are not ours to
 * count. Filtered in memory because the date range already uses the one field a
 * query may range over.
 */
export async function countSentToday({ newOnly = true } = {}) {
  if (!db) return { count: 0, uids: [], since: null };

  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const since = midnight.toISOString();

  // A range on one field needs no composite index, and ISO-8601 strings in UTC
  // compare correctly as strings.
  /*
   * Counted on when a task was FIRST sent as a new one, not on when it was last
   * sent at all.
   *
   * A task revised three times is still one new task submitted today, and it
   * belongs to the day it went out — not to the day of its latest round. The
   * old query asked `sent_at >= midnight`, which moved a task from day to day
   * as it was revised and counted it again each time it happened to land in the
   * window.
   */
  const field = newOnly ? 'submitted_new_at' : 'sent_at';
  const snap = await db.collection(config.firebase.collection).where(field, '>=', since).get();

  const uids = snap.docs.filter((d) => ours(d.data())).map((d) => d.id);

  return { count: uids.length, uids, since };
}

/** Merges a patch into one task. The generic escape hatch. */
export async function patchTask(uid, patch) {
  if (!db) throw new Error(describe(initError));
  await db
    .collection(config.firebase.collection)
    .doc(String(uid))
    .set({ ...patch, updated_at: new Date().toISOString() }, { merge: true });
}

/** Marks a task as submitted and awaiting review. */
export async function markSent(uid) {
  if (!db) throw new Error(describe(initError));

  /*
   * Remember whether this was a new task, before the flag is cleared below.
   *
   * The daily cap counts new tasks, and `is_new_task` stops being true the
   * instant a task is submitted — so afterwards there is no way to tell a new
   * submission from a revision. This is that fact, written down while it is
   * still knowable.
   */
  const before = await db.collection(config.firebase.collection).doc(String(uid)).get();
  const wasNew = before.exists && before.data().is_new_task === true;

  const patch = {
    /*
     * Written ONCE, on the first send of a task that was new, and never
     * unwritten.
     *
     * It used to be `submitted_new: wasNew` on every send. A new task that got
     * sent, came back for revision and was resubmitted then had it overwritten
     * with false — because `is_new_task` is cleared by the revision itself — so
     * the day's count fell as tasks were revised and the cap never bit. On a
     * busy day the count sat near zero however many new tasks had gone out.
     *
     * The timestamp is what the count actually reads: a task first sent as new
     * today belongs to today whatever happens to it afterwards.
     */
    ...(wasNew ? { submitted_new: true, submitted_new_at: new Date().toISOString() } : {}),
    task_status: TASK_STATUS_SENT,
    /*
     * Submitted, so it is no longer the new task the account is holding — the
     * slot is free and the next one can start.
     *
     * "sent" is already outside the set of statuses that block a start, so this
     * is belt and braces. It matters anyway: the flag is what the guard reads,
     * and leaving it true would mean one wrong status elsewhere silently
     * reintroduced the block.
     */
    is_new_task: false,
    sent_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  await db.collection(config.firebase.collection).doc(String(uid)).set(patch, { merge: true });
  console.log(`[firebase] ${config.firebase.collection}/${uid} -> task_status="${TASK_STATUS_SENT}"`);

  /*
   * Anything still in Dropbox has outlived its purpose.
   *
   * Normally the copy is gone before this — deleted the moment the browser
   * collected it. But there are ways for one to survive: a task submitted by
   * hand, so the server never served it, or a race where something put a copy
   * back. Whatever the route, a zip sitting in Dropbox for a task that has been
   * submitted is a stale build that a later retry could pick up and upload, and
   * nothing else in the system removes it.
   *
   * Best effort, and never allowed to fail the send: the task really has been
   * submitted, and reporting an error now would misrepresent that.
   */
  if (before.exists && before.data().dropbox_path) {
    try {
      await deleteFile(before.data().dropbox_path);
      await db
        .collection(config.firebase.collection)
        .doc(String(uid))
        .set({ dropbox_path: null, file_uploaded: false }, { merge: true });
      console.log(`[firebase] ${uid} -> cleared its Dropbox copy on send`);
      patch.dropbox_path = null;
      patch.file_uploaded = false;
    } catch (err) {
      console.warn(`[firebase] ${uid}: could not clear the Dropbox copy on send: ${err.message}`);
    }
  }

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

  /*
   * Always append. Never compare, never replace.
   *
   * There used to be a guard here that dropped an entry whose text matched one
   * already stored. It made sense when every task in the revise list was
   * re-read on every sweep — without it the same message would have piled up.
   * Now that a task is only read when it is "sent" or unknown, a collection is
   * a deliberate act: you set the status back to "sent" precisely because you
   * want that round recorded. Silently discarding it was the reason feedback
   * looked like it was being replaced.
   */
  /*
   * What this round says about the last revision.
   *
   * Reduced to signatures and subtracted from the previous round, so a task that
   * comes back carries the one fact nothing else in the system records: whether
   * the work done on it helped. A round that fixes three complaints and breaks
   * the oracle is otherwise indistinguishable from a round that fixed three
   * complaints.
   */
  const previous = feedbacks.length ? feedbacks[feedbacks.length - 1] : null;
  const diff = diffRounds(previous, entry);
  entry.check_signatures = signaturesOf(entry);

  const next = [...feedbacks, entry];

  const now = new Date().toISOString();
  const record = {
    UID: String(uid),
    machine_id: existing?.machine_id || machineId(),
    task_status: TASK_STATUS_NEEDS_REVISION,
    // A reviewer has now looked at it, so whatever it was before, it is a
    // revision from here on.
    is_new_task: false,
    feedbacks: next,
    // Stamped even when the feedback was unchanged, so an unchanged task is not
    // reopened on every single sweep.
    feedback_checked_at: now,
    updated_at: now,
    /*
     * Kept on the task, not only inside the round, because this is what the
     * next revision is told and what the dashboard shows. `regressed` is the
     * one to read: it means the revision caused something, as opposed to merely
     * failing to fix it.
     */
    check_progress: {
      at: now,
      round: next.length,
      first: Boolean(diff.first),
      fixed: diff.fixed,
      persisted: diff.persisted,
      introduced: diff.introduced,
      open: diff.open,
      regressed: madeThingsWorse(diff),
      summary: describeDiff(diff),
    },
    ...extra,
  };
  /*
   * Never creates a task.
   *
   * Feedback is only collected for submissions already in this database, so a
   * missing document here means it was deleted between the sweep choosing it and
   * this write. Creating one would quietly reintroduce exactly the behaviour
   * that rule exists to prevent, so it is reported and skipped instead.
   */
  if (!snapshot.exists) {
    console.warn(`[firebase] ${uid} is no longer in ${config.firebase.collection} — feedback not stored`);
    return { record: null, skipped: true, reason: 'the task is not in the database' };
  }

  await ref.set(record, { merge: true });

  /*
   * Feed the round into the lessons store.
   *
   * Counting what is open runs on every round; confirming what is fixed runs
   * only when the round introduced nothing, because a round that broke
   * something is not evidence about what fixes things. Neither is allowed to
   * fail the write above — the feedback is the record, this is bookkeeping on
   * top of it.
   */
  try {
    await recordReviewFailures(uid, diff.open);
    if (diff.fixed.length) {
      await confirmReviewLessons(uid, diff.fixed, { clean: !madeThingsWorse(diff) });
    }
  } catch (err) {
    console.warn(`[lessons] ${uid}: review pipeline skipped — ${err.message}`);
  }

  console.log(
    `[firebase] ${config.firebase.collection}/${uid} -> task_status="${TASK_STATUS_NEEDS_REVISION}", ` +
      `round ${next.length} appended — ${describeDiff(diff)}`
  );
  return {
    record,
    skipped: false,
    rounds: next.length,
    progress: record.check_progress,
  };
}

/**
 * Which of `uids` are worth opening to read feedback from.
 *
 * Exactly two cases:
 *   - this database has never seen the task, or
 *   - it is marked "sent" and so is waiting on a reviewer.
 *
 * A task that already carries feedback is NOT reopened. Re-reading every task
 * in the revise list on every sweep meant visiting pages whose feedback was
 * already stored — minutes of browsing per sweep to re-read text that had not
 * changed.
 *
 * The cost of that is real: a task can only pick up a second round of feedback
 * by returning to "sent" first.
 */
export async function findFeedbackCandidates(uids) {
  if (!db || !uids.length) return { wanted: [], reasons: {}, unknown: [] };

  const wanted = [];
  const reasons = {};
  const unknown = [];

  // Read one at a time by document id: an "in" query is capped at 30 values and
  // these lists are short.
  for (const uid of uids) {
    const snap = await db.collection(config.firebase.collection).doc(String(uid)).get();

    /*
     * A submission this database has never seen is left alone.
     *
     * It used to be collected and stored as a new task. The revise list is the
     * whole account's, though, not just this bot's — anything worked by hand, or
     * before the bot existed, shows up there too. Adopting those meant the Tasks
     * collection filled with rows the bot had never built and could not do
     * anything useful with, and every sweep spent minutes opening their pages.
     *
     * Only tasks this bot already knows about are followed now.
     */
    if (!snap.exists) {
      unknown.push(String(uid));
      continue;
    }

    if (snap.data().task_status === TASK_STATUS_SENT) {
      wanted.push(String(uid));
      reasons[uid] = 'sent, awaiting a reviewer';
    }
  }

  return { wanted, reasons, unknown };
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
 * The next task waiting to have its zip put back into the platform.
 *
 * Only tasks whose file actually reached Dropbox are eligible: `file_uploaded`
 * false means the worker has the folder but nothing was uploaded, so there is
 * nothing to fetch and nothing to attach. Those are skipped rather than failed —
 * they are mid-flight, not broken.
 */
export async function findReadyToSubmit(machine, { excludeNew = false } = {}) {
  if (!db) return null;

  const snap = await db
    .collection(config.firebase.collection)
    .where('machine_id', '==', machine)
    .where('task_status', '==', TASK_STATUS_READY)
    .limit(10)
    .get();

  const rows = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  // Filtered here rather than in the query: a third equality would still be
  // index-free, but keeping it in memory lets the caller see how many were
  // skipped and why, which is the difference between "nothing to do" and
  // "three tasks are stuck waiting on an upload".
  /*
   * A file in Dropbox is what makes a task submittable — except for one whose
   * verdict ended it. Those have nothing to upload: the run stopped before any
   * corrections, so the folder is the reviewer's own file, and the form's upload
   * field is optional. Waiting for a file that will never arrive would leave
   * them stuck at "ready to submit" forever.
   */
  let eligible = rows.filter(
    (t) => t.file_uploaded === true || t.needs_upload === false
  );
  const waiting = rows.length - eligible.length;

  /*
   * At the daily cap, new tasks are left alone entirely.
   *
   * Uploading one and running the platform's checks only to stop short of
   * submitting spends real time and two platform builds on something that
   * cannot be handed in today. Revisions are unaffected — the cap counts new
   * tasks, and stopping a revision because of it would be the wrong limit
   * applied to the wrong thing.
   */
  const heldByCap = excludeNew ? eligible.filter((t) => t.is_new_task === true).length : 0;
  if (excludeNew) eligible = eligible.filter((t) => t.is_new_task !== true);

  eligible.sort((a, b) => String(a.updated_at || '').localeCompare(String(b.updated_at || '')));
  return { task: eligible[0] || null, eligible: eligible.length, waiting, heldByCap };
}

/**
 * Retires a task the platform has reassigned.
 *
 * `is_new_task` is cleared as well as the status: it is the field the start
 * guard reads, and a task nobody can open should not hold the account's slot.
 */
export async function markTaken(uid, replacedBy = null) {
  if (!db) throw new Error(describe(initError));
  const now = new Date().toISOString();
  const patch = {
    task_status: TASK_STATUS_TAKEN,
    is_new_task: false,
    taken_at: now,
    taken_replaced_by: replacedBy,
    updated_at: now,
  };
  await db.collection(config.firebase.collection).doc(String(uid)).set(patch, { merge: true });
  console.log(`[firebase] ${uid} -> task_status="${TASK_STATUS_TAKEN}"${replacedBy ? ` (now holding ${replacedBy})` : ''}`);
  return patch;
}

/**
 * Records what the platform's checks said.
 *
 * A failure is a state a person has to look at, so it gets its own status. A
 * pass deliberately does not change `task_status`: the bot never submits, and
 * moving the task on would suggest it had.
 */
export async function saveStaticCheck(uid, result) {
  if (!db) throw new Error(describe(initError));

  const now = new Date().toISOString();
  const passed = result.passed === true;

  const patch = {
    static_check_result: {
      passed,
      checked_at: result.checked_at || now,
      page_url: result.page_url || null,
      results: (result.results || []).map((r) => ({
        key: r.key,
        label: r.label,
        verdict: r.verdict || null,
        summary: r.summary || '',
        logs: String(r.logs || '').slice(0, 60000),
      })),
    },
    static_checked_at: now,
    updated_at: now,
  };

  // A pass is the end of the road for the bot: the task has been built, checked
  // and accepted by the platform's own gates, and only a person submits it.
  patch.task_status = passed ? TASK_STATUS_STATIC_PASS : TASK_STATUS_STATIC_FAIL;

  /*
   * Every failure is filed against a signature so the same complaint on another
   * task is recognised rather than rediscovered; every pass settles whichever
   * failures this task was carrying.
   *
   * Deliberately not allowed to break the check itself. A knowledge base that
   * can fail a working submission is worse than no knowledge base.
   */
  try {
    if (passed) {
      const carrying = (await getTask(uid))?.static_check_signatures || [];
      await confirmLessons(uid, carrying);
      patch.static_check_signatures = [];
    } else {
      patch.static_check_signatures = await recordFailures(uid, result);
    }
  } catch (err) {
    console.warn('[lessons] could not be updated:', err.message);
  }

  await db.collection(config.firebase.collection).doc(String(uid)).set(patch, { merge: true });
  console.log(
    `[firebase] ${uid} -> static checks ${passed ? 'PASSED' : `FAILED, task_status="${TASK_STATUS_STATIC_FAIL}"`}`
  );
  return patch;
}

/**
 * A brand-new task that is still being worked, anywhere in the system.
 *
 * Deliberately not scoped to a machine. `findInBuildTask` answers "is this
 * computer busy", which is about not driving one browser into two tasks at once.
 * This answers a different question — "is the bot already building something
 * new" — and that one is about the account, not the hardware. Two machines each
 * starting a fresh task means two unfinished submissions against the same
 * Snorkel account.
 *
 * "Working.." counts: the task is still being built, it just moved from the
 * browser to Claude.
 */
/**
 * Every state a new task passes through before it has been handed in.
 *
 * `sent` is deliberately not here: once a submission is with a reviewer the slot
 * is free and the next task can be started. Nor is `needs revision`, which a new
 * task cannot be — the moment feedback arrives it stops being new.
 */
export const UNFINISHED_NEW_STATUSES = [
  TASK_STATUS_STARTED,
  'Working..',
  TASK_STATUS_READY,
  TASK_STATUS_STATIC_FAIL,
  // Built and accepted by the platform's checks, but still not handed in — so it
  // is still holding the account's assignment.
  TASK_STATUS_STATIC_PASS,
];

export async function findNewTaskInProgress() {
  if (!db) return null;

  for (const status of UNFINISHED_NEW_STATUSES) {
    const snap = await db
      .collection(config.firebase.collection)
      .where('is_new_task', '==', true)
      .where('task_status', '==', status)
      /*
       * Read several and pick ours, rather than reading one and hoping.
       * Somebody else's unfinished task is not a reason to hold ours back, and
       * with limit(1) their document was frequently the one that came back.
       * Fifty is far more unfinished new tasks than can exist across every
       * deployment at once — a new task is one per account at a time.
       */
      .limit(50)
      .get();
    const mine = snap.docs.find((doc) => ours(doc.data()));
    if (mine) return { id: mine.id, ...mine.data() };
  }
  return null;
}

/**
 * The most recently updated task whose file has not reached Dropbox yet.
 * Filtering happens in memory on purpose: a where() + orderBy() on different
 * fields would require a composite index to be created by hand first.
 *
 * Scoped to this machine rather than this deployment, which is stricter and has
 * to be: what gets uploaded is a file in this computer's download folder, and a
 * task built on another machine has no file here to upload.
 */
export async function findPendingUpload() {
  const recent = await listTasks(100);
  return (
    recent.find((t) => t.file_uploaded !== true && t.UID && t.machine_id === machineId()) || null
  );
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
