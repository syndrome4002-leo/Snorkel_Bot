/*
 * index.js — Snorkel Bot node server.
 *
 *   /start_new_task             the whole workflow — the one call you need.
 *                                 GET or POST; returns a job id immediately
 *   GET  /api/jobs[/:id]        how a run is going
 *   POST /api/run               same pipeline, but blocking unless {"async":true}
 *   POST /api/start             Snorkel step only: start a task, scrape, download, save
 *   POST /api/upload            Dropbox step only: upload, delete, flip the flags
 *   GET  /api/status            extension connected? Firebase ready? queue depth?
 *   GET  /api/tasks             recent Tasks documents
 *   GET  /api/tasks/:uid        one Tasks document
 *   POST /api/flush             replay tasks that could not reach Firestore
 *   GET  /api/events            server-sent events stream of live progress
 *   GET  /                      the dashboard (public/)
 *
 * The Snorkel extension connects to ws://<host>:<port>/extension?role=snorkel.
 * Dropbox uploads go straight from this server over HTTPS.
 */

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { requireToken, authEnabled } from './auth.js';
import { ExtensionHub } from './hub.js';
import { locateTaskFile, deleteTaskFile } from './localfile.js';
import {
  uploadFile,
  dropboxConfigured,
  checkAccount,
  buildAuthUrl,
  exchangeCode,
  applyRefreshToken,
  downloadStream,
} from './dropbox.js';
import { updateEnvFile, ENV_PATH } from './envfile.js';
import {
  initRtdb,
  rtdbStatus,
  startStatusHeartbeat,
  publishNow,
  watchCommands,
  watchSettings,
  pushLog,
  setTicker,
} from './rtdb.js';
import { machineId, machineInfo } from './machine.js';
import {
  initFirebase,
  saveTask,
  listTasks,
  getTask,
  markUploaded,
  findPendingUpload,
  findInBuildTask,
  findNewTaskInProgress,
  TASK_STATUS_STATIC_FAIL,
  TASK_STATUS_READY,
  saveStaticCheck,
  markTaken,
  findReadyToSubmit,
  markSent,
  addFeedback,
  findFeedbackCandidates,
  firebaseStatus,
  flushPending,
  pendingCount,
} from './firebase.js';

const app = express();
const hub = new ExtensionHub();

// Behind a tunnel or reverse proxy (Cloudflare Tunnel, nginx, ngrok) every
// request arrives from 127.0.0.1, which would make the auth throttle treat all
// callers as one client. TRUST_PROXY=1 makes Express read X-Forwarded-For.
if (config.trustProxy) app.set('trust proxy', true);

/*
 * Chrome's Private Network Access check.
 *
 * The page doing the fetch is https://experts.snorkel-ai.com and this server is
 * on a private address, which Chrome treats as a step down in trust: it sends a
 * preflight first and refuses unless the server says it is expecting requests
 * from a public site. Without this header the upload fetch fails with a CORS
 * error that says nothing about the real reason.
 *
 * Ahead of cors(), which answers preflights itself and ends the request there.
 * Registered after it, this never ran for the OPTIONS that actually matters.
 */
app.use('/api/task-file', (_req, res, next) => {
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  next();
});

app.use(cors());
app.use(express.json({ limit: '5mb' }));

// The dashboard itself is public — it holds no secrets and only asks for the
// token. Everything it calls is not.
if (existsSync(config.dashboardDir)) {
  /*
   * The HTML must never be cached; everything under /_next/static may be cached
   * forever.
   *
   * Next puts a content hash in every JS/CSS filename but not in index.html, so
   * a browser holding an old index.html keeps loading the old chunks — the page
   * looks stale after a rebuild even though the new files are sitting right
   * there. Which is exactly what happened.
   */
  app.use(
    express.static(config.dashboardDir, {
      setHeaders(res, filePath) {
        if (filePath.endsWith('.html')) {
          res.setHeader('Cache-Control', 'no-cache, must-revalidate');
        } else if (filePath.includes(`${path.sep}_next${path.sep}static${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    })
  );
} else {
  console.warn(
    `[server] no built dashboard at ${config.dashboardDir}\n` +
      '[server]   build it with:  cd snorkel_dashboard && npm install && npm run build\n' +
      '[server]   or run it in dev mode:  npm run dev  (serves on :3000)'
  );
}
app.use(['/api', '/start_new_task'], requireToken);

// ------------------------------------------------------------- status ----

app.get('/api/status', async (_req, res) => {
  const pending = await pendingCount().catch(() => 0);
  res.json({
    ok: true,
    extension: hub.status(),
    firebase: firebaseStatus(),
    dropbox: {
      configured: dropboxConfigured(),
      folder: config.dropbox.folder || '/',
    },
    realtime_db: rtdbStatus(),
    machine: machineInfo(),
    task_in_flight: Boolean(currentRun()),
    downloads_dir: config.downloadsDir,
    // Tasks scraped successfully but not yet in Firestore, waiting on a flush.
    pending_tasks: pending,
  });
});

/*
 * Dropbox connect flow, hosted by the server.
 *
 *   open  http://localhost:<port>/api/dropbox/connect
 *   -> Dropbox asks you to approve the app (the one step that needs a human)
 *   -> Dropbox redirects back to /api/dropbox/callback with a code
 *   -> the server exchanges it, writes DROPBOX_REFRESH_TOKEN into .env, and
 *      starts using it straight away
 *
 * The redirect URI has to be registered on the app's Settings page first, or
 * Dropbox refuses the request.
 */
const pendingStates = new Set();

function callbackUrl(req) {
  return `${req.protocol}://${req.get('host')}/api/dropbox/callback`;
}

app.get('/api/dropbox/connect', (req, res) => {
  if (!config.dropbox.appKey || !config.dropbox.appSecret) {
    return res
      .status(400)
      .type('text/plain')
      .send('Set DROPBOX_APP_KEY and DROPBOX_APP_SECRET in .env first, then reload this page.');
  }
  const state = randomUUID();
  pendingStates.add(state);
  // Nothing to gain from remembering these forever.
  setTimeout(() => pendingStates.delete(state), 10 * 60 * 1000).unref();
  res.redirect(buildAuthUrl(callbackUrl(req), state));
});

app.get('/api/dropbox/callback', async (req, res) => {
  const page = (title, body) =>
    res.type('html').send(
      `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
        `<body style="font:15px/1.6 system-ui;max-width:40em;margin:3em auto;padding:0 1em">` +
        `<h2>${title}</h2>${body}</body>`
    );

  if (req.query.error) {
    return page('Dropbox connection cancelled', `<p><code>${req.query.error_description || req.query.error}</code></p>`);
  }
  // Guards against a stray callback being used to plant someone else's token.
  if (!req.query.state || !pendingStates.delete(req.query.state)) {
    return res.status(400).type('text/plain').send('Unknown or expired state — start again at /api/dropbox/connect.');
  }

  try {
    const token = await exchangeCode(req.query.code, callbackUrl(req));
    applyRefreshToken(token.refresh_token);
    await updateEnvFile({
      DROPBOX_APP_KEY: config.dropbox.appKey,
      DROPBOX_APP_SECRET: config.dropbox.appSecret,
      DROPBOX_REFRESH_TOKEN: token.refresh_token,
    });

    const account = await checkAccount().catch(() => null);
    console.log(`[dropbox] connected${account ? ` as ${account.email}` : ''}; refresh token saved to ${ENV_PATH}`);
    page(
      'Dropbox connected',
      `<p>${account ? `Connected as <strong>${account.name}</strong> &lt;${account.email}&gt;.` : 'Refresh token stored.'}</p>` +
        `<p>Saved to <code>${ENV_PATH}</code>. No restart needed — the server is already using it.</p>` +
        `<p>You can close this tab.</p>`
    );
  } catch (err) {
    console.error('[dropbox] connect failed:', err.message);
    page('Dropbox connection failed', `<p><code>${err.message}</code></p><p><a href="/api/dropbox/connect">Try again</a></p>`);
  }
});

/** Confirms the Dropbox credentials without uploading anything. */
app.get('/api/dropbox/check', async (_req, res) => {
  try {
    res.json({ ok: true, account: await checkAccount() });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

app.post('/api/flush', async (_req, res) => {
  try {
    res.json({ ok: true, ...(await flushPending()) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// -------------------------------------------------------- snorkel step ----

/**
 * Refuses to start a second task while one is still in build.
 *
 * The dashboard checks this too, but that check lives in a browser: a second
 * tab, another machine's dashboard, or a plain curl would sail past it. Here it
 * holds however the task was started. Downloading a second task before the
 * first is finished and uploaded would leave two zips in ~/Downloads and make
 * the pipeline pick the wrong one.
 *
 * Pass {"force": true} to override — needed when a task is genuinely stuck in
 * build and would otherwise wedge this machine for good.
 */
/*
 * Set for as long as a pipeline is in flight.
 *
 * The Firestore check below cannot cover the start of a run: the task document
 * is only written once the download has finished, so for the minute or so the
 * Snorkel step takes there is nothing in Firestore to find. This closes that
 * window, and unlike the dashboard's disabled button it survives a page reload
 * and applies to every caller.
 */
let runInFlight = null;

export function currentRun() {
  return runInFlight;
}

async function assertNoTaskInBuild(options = {}) {
  if (options.force) return;

  if (runInFlight) {
    const error = new Error(
      `A task is in building (started ${runInFlight.started_at}). Wait for it to finish, ` +
        `or pass {"force": true} to start another anyway.`
    );
    error.code = 'TASK_IN_BUILD';
    throw error;
  }

  const existing = await findInBuildTask(machineId()).catch((err) => {
    // Not being able to check is not a reason to refuse work.
    console.warn('[server] could not check for a task in build:', err.message);
    return null;
  });

  if (!existing) {
    /*
     * Nothing on this machine — but a new task being built anywhere counts.
     * The per-machine check above stops one browser being driven into two tasks
     * at once; this stops the account collecting several unfinished new
     * submissions because a second machine also decided it was free.
     *
     * Only new tasks block. A machine working through revisions is not a reason
     * to refuse a fresh one.
     */
    const elsewhere = await findNewTaskInProgress().catch((err) => {
      console.warn('[server] could not check for a new task elsewhere:', err.message);
      return null;
    });
    if (!elsewhere) return;

    const error = new Error(
      `A new task is not finished yet: ${elsewhere.UID} is at "${elsewhere.task_status}" on ` +
        `${elsewhere.machine_id || 'another machine'}. Submit it first, ` +
        `or pass {"force": true} to start another anyway.`
    );
    error.code = 'TASK_IN_BUILD';
    error.uid = elsewhere.UID;
    throw error;
  }

  const error = new Error(
    `A task is in building (${existing.UID}). Finish and upload it first, ` +
      `or pass {"force": true} to start another anyway.`
  );
  error.code = 'TASK_IN_BUILD';
  error.uid = existing.UID;
  throw error;
}

/** 409 rather than 500: a task already in build is a conflict, not a fault. */
function sendError(res, err, where) {
  const status = err.code === 'TASK_IN_BUILD' ? 409 : 500;
  if (status !== 409) console.error(`[api] ${where} failed:`, err.message);
  res.status(status).json({
    ok: false,
    error: err.message,
    ...(err.code ? { code: err.code } : {}),
    ...(err.uid ? { uid: err.uid } : {}),
  });
}

/**
 * Runs `fn` as the machine's one task. Refuses if another is already in flight
 * or in build, and always releases, so a thrown error cannot wedge the machine.
 */
async function withRunLock(options, fn) {
  await assertNoTaskInBuild(options);
  runInFlight = { started_at: new Date().toISOString() };
  publishNow();
  try {
    return await fn();
  } finally {
    runInFlight = null;
    publishNow();
  }
}

async function runSnorkelStep(options) {
  const { task, meta, progress } = await hub.startSentinel(options);
  const saved = await saveTask(task, meta);
  return {
    task: saved.record,
    saved: saved.saved,
    ...(saved.saved ? {} : { warning: `Task NOT saved to Firestore: ${saved.reason}` }),
    meta,
    progress,
  };
}

/*
 * Hands a task's zip to the browser.
 *
 * Streamed straight from Dropbox rather than saved and served: these run to a
 * couple of hundred megabytes, and the only consumer is a fetch happening a few
 * milliseconds away on the same machine. Nothing is written to disk, so there is
 * nothing to clean up and no half-written file to serve after a crash.
 */
app.get('/api/task-file/:uid', async (req, res) => {
  const uid = String(req.params.uid || '');

  try {
    const task = await getTask(uid);
    if (!task) return res.status(404).json({ ok: false, error: `No task ${uid}.` });
    if (!task.dropbox_path) {
      return res.status(409).json({
        ok: false,
        error: `Task ${uid} has no dropbox_path — its file is not in Dropbox.`,
      });
    }

    const { body, size, path: remote } = await downloadStream(task.dropbox_path);
    const name = task.file_name || `${uid}.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(name)}"`);
    if (size) res.setHeader('Content-Length', String(size));

    console.log(`[server] streaming ${remote} to the browser for ${uid}`);
    // Node's Readable.fromWeb, via the pipeline helper, so a client that goes
    // away mid-download tears the Dropbox request down with it.
    await pipeline(Readable.fromWeb(body), res);
  } catch (err) {
    console.error(`[server] could not serve ${uid}:`, err.message);
    if (!res.headersSent) {
      res.status(err.code === 'DROPBOX_NOT_FOUND' ? 404 : 502).json({ ok: false, error: err.message });
    } else {
      res.destroy(err);
    }
  }
});

app.post('/api/start', async (req, res) => {
  if (!hub.isConnected('snorkel')) {
    return res.status(503).json({
      ok: false,
      error: 'No "snorkel" extension is connected. Load snorkel_extension/ in Chrome.',
    });
  }
  try {
    const options = req.body || {};
    res.json({ ok: true, ...(await withRunLock(options, () => runSnorkelStep(options))) });
  } catch (err) {
    sendError(res, err, '/api/start');
  }
});

// -------------------------------------------------------- dropbox step ----

/**
 * The Dropbox half: upload the file, then delete the local copy and flip
 * file_uploaded / task_status.
 */
async function runDropboxStep(uid, options = {}) {
  const task = uid ? await getTask(uid) : await findPendingUpload();
  if (!task) {
    throw new Error(
      uid ? `Task ${uid} not found in Firestore.` : 'No task is waiting to be uploaded.'
    );
  }
  if (task.file_uploaded === true && !options.force) {
    return { task, skipped: true, reason: 'Already uploaded (pass {"force":true} to redo it).' };
  }

  // Fail fast with a clear message rather than starting an upload for a file
  // that is not there.
  const file = await locateTaskFile(task);
  const fileName = path.basename(file.path);

  // Straight to Dropbox over HTTPS: no browser involved, real status codes, and
  // Dropbox's own autorename handles name clashes.
  const result = await uploadFile(file.path, {
    folder: options.folder || config.dropbox.folder,
    fileName,
    size: file.size,
  });

  const cleanup = await deleteTaskFile(file.path);
  const patch = await markUploaded(task.UID, {
    dropbox_path: result.dropbox_path || null,
    local_path: null, // the file is gone; stop pointing at it
  });

  return {
    task: { ...task, ...patch },
    uploaded: true,
    file: {
      name: fileName,
      size: file.size,
      deleted: cleanup.deleted,
      dropbox_name: result.dropbox_name,
      renamed: !!result.renamed,
    },
    ...(cleanup.deleted ? {} : { warning: `Uploaded, but the local file could not be deleted: ${cleanup.error}` }),
    progress: result.progress,
  };
}

/** The server uploads to Dropbox itself, so only the Snorkel extension is needed. */
function requiredRoles() {
  return ['snorkel'];
}

function uploadUnavailable() {
  return dropboxConfigured()
    ? null
    : 'Dropbox credentials are missing. Open /api/dropbox/connect, or run "npm run dropbox:auth".';
}

app.post('/api/upload', async (req, res) => {
  const unavailable = uploadUnavailable();
  if (unavailable) return res.status(503).json({ ok: false, error: unavailable });
  try {
    const { uid, ...options } = req.body || {};
    res.json({ ok: true, ...(await runDropboxStep(uid, options)) });
  } catch (err) {
    console.error('[api] /api/upload failed:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// -------------------------------------------------------------- logs ----

/*
 * One line to the console and one to the machine's log stream, so the dashboard
 * shows the same story the terminal does. The emoji is what makes a long stream
 * skimmable — you can find the failures without reading every line.
 */
function logEvent(emoji, event, message, extra = {}) {
  const text = `${emoji} ${message}`;
  if (extra.level === 'error') console.error(`[log] ${text}`);
  else if (extra.level === 'warn') console.warn(`[log] ${text}`);
  else console.log(`[log] ${text}`);
  pushLog({ emoji, event, message, ...extra });
}

// ------------------------------------------------------------- ticker ----

/*
 * A one-line countdown to the extension's next revision sweep, refreshed every
 * minute and OVERWRITTEN each time rather than appended — a per-minute log line
 * would add 1,440 entries a day and bury everything else.
 *
 * The time comes from the extension reporting its own chrome.alarms schedule,
 * so a drifted or rescheduled alarm still reads correctly instead of this
 * assuming a fixed five minutes.
 */
let lastRevisionReport = null;
let lastReviseCount = null;
let nextAutoTryAt = null;
/** Refreshed alongside the ticker so the countdown can say why it will not run. */
let inBuildUid = null;

function humanIn(iso) {
  if (!iso) return null;
  const left = new Date(iso).getTime() - Date.now();
  if (left <= 0) return 'due now';
  return `in ~${Math.max(1, Math.round(left / 60000))} min`;
}

function updateTicker() {
  // --- when the revise list is next read ---
  if (!lastRevisionReport) {
    setTicker('checks', { emoji: '🔌', message: 'waiting for the extension to report in' });
  } else {
    const { next_check_at: next, checked_at: last } = lastRevisionReport;
    const ago = last ? Math.round((Date.now() - new Date(last).getTime()) / 60000) : null;
    const agoText =
      ago === null ? '' : ago <= 0 ? ' (last checked just now)' : ` (last checked ${ago} min ago)`;
    const when = humanIn(next);
    setTicker('checks', {
      emoji: when === 'due now' ? '🔄' : '⏳',
      message: when
        ? `check revise list ${when}${agoText}`
        : `check revise list pending${agoText}`,
    });
  }

  // --- when a new task is next attempted ---
  const limit = Number(settings.revise_limit);
  if (!Number.isFinite(limit) || limit <= 0) {
    setTicker('tries', { emoji: '🛑', message: 'auto-start is off — set a revise tasks limit' });
    return;
  }
  if (inBuildUid) {
    setTicker('tries', { emoji: '🔨', message: `${inBuildUid} is in build — not starting anything` });
    return;
  }
  if (submitInFlight) {
    setTicker('tries', {
      emoji: '📤',
      message: `uploading ${submitInFlight.uid} — not starting anything until it finishes`,
    });
    return;
  }
  if (submitBlocked) {
    setTicker('tries', {
      emoji: '⛔',
      message:
        `Snorkel will not open ${submitBlocked.uid} — waiting for the revise list to fall below ` +
        `${submitBlocked.reviseCount === Infinity ? 'its current size' : submitBlocked.reviseCount}`,
    });
    return;
  }

  const countText = lastReviseCount === null ? 'count unknown yet' : `${lastReviseCount} awaiting, limit ${limit}`;
  const when = humanIn(nextAutoTryAt);
  setTicker('tries', {
    emoji: when === 'due now' ? '🤖' : '⏳',
    message: when ? `try new task ${when} — ${countText}` : `try new task pending — ${countText}`,
  });
}

// ------------------------------------------------------------ settings ----

/** Whatever the dashboard has set for this machine. */
let settings = {};

/**
 * Keeps starting tasks so long as fewer than `revise_limit` are waiting to be
 * revised.
 *
 * The count comes from the extension's own five-minute sweep, which reloads the
 * home page and counts the Revise cards — so it is what the site actually says,
 * not a number this server has inferred from its own records.
 */
async function maybeAutoStart(reviseCount) {
  const limit = Number(settings.revise_limit);
  if (!Number.isFinite(limit) || limit <= 0) return;

  // Starting a task navigates the tab an upload is using. The upload is the
  // longer and less repeatable of the two, so it wins.
  if (submitInFlight) {
    logEvent('⏸️', 'auto_skip', `uploading ${submitInFlight.uid} — not starting a task meanwhile`);
    return;
  }

  if (reviseCount >= limit) {
    logEvent('⏸️', 'auto_skip', `${reviseCount} awaiting revision, limit is ${limit} — not starting`);
    return;
  }

  if (currentRun()) {
    logEvent('⏸️', 'auto_skip', 'a task is already running');
    return;
  }

  // Checked here rather than left to the pipeline's own guard: that guard would
  // throw after the attempt had begun, and the point is not to try at all while
  // a task is in build.
  const inBuild = await findInBuildTask(machineId()).catch(() => null);
  if (inBuild) {
    logEvent('⏸️', 'auto_skip', `${inBuild.UID} is in build — nothing to start`, { uid: inBuild.UID });
    return;
  }

  /*
   * And no new task anywhere may be unfinished.
   *
   * Broader than the check above in both directions: every machine, and every
   * state short of "sent". A new task sitting at "ready to submit" or "static
   * check fail" is still holding the account's assignment — it has been built
   * but not handed in — and starting another would leave two unfinished
   * submissions with nobody having decided to do that.
   */
  const unfinished = await findNewTaskInProgress().catch(() => null);
  if (unfinished) {
    logEvent(
      '⏸️',
      'auto_skip',
      `${unfinished.UID} is a new task at "${unfinished.task_status}" ` +
        `on ${unfinished.machine_id || 'another machine'} — not starting another`,
      { uid: unfinished.UID }
    );
    return;
  }

  logEvent('🤖', 'auto_start', `${reviseCount} awaiting revision, below the limit of ${limit} — starting one`);

  try {
    const result = await runFullPipeline({}, () => {});
    if (result.snorkel.saved) {
      logEvent('✅', 'auto_done', `started ${result.snorkel.task.UID}`, { uid: result.snorkel.task.UID });
    } else {
      logEvent('⚠️', 'auto_warn', result.snorkel.warning, { level: 'warn' });
    }
  } catch (err) {
    // Both of these are ordinary outcomes, not faults: the site may hand out
    // nothing, and a task may already be in build.
    if (err.code === 'START_UNAVAILABLE') {
      logEvent('🚫', 'auto_unavailable', 'Snorkel handed out no task this time');
    } else if (err.code === 'TASK_IN_BUILD') {
      logEvent('⏸️', 'auto_skip', err.message);
    } else {
      logEvent('❌', 'auto_failed', err.message, { level: 'error' });
    }
  }
}

// --------------------------------------------------------- revisions ----

/*
 * The extension reports every submission the site wants revised, on its own
 * timer. Two of those are worth acting on:
 *
 *   - one we already know about and marked as "sent" — the reviewer has come
 *     back with feedback
 *   - one this database has never seen — somebody else's task, or one started
 *     before the bot existed; it becomes a task that starts life needing revision
 *
 * Anything else in the list is already in build or already recorded as needing
 * revision, so there is nothing new to fetch.
 */
async function handleRevisionReport(uids) {
  // Always says something. An empty report used to return in silence, which
  // looked identical to the report never arriving.
  console.log(`[revisions] extension reported ${uids.length} awaiting revision`);
  if (!uids.length) return { considered: 0, collected: 0 };

  const { wanted, reasons, unknown } = await findFeedbackCandidates(uids);

  /*
   * Said out loud rather than passed over. The revise list belongs to the whole
   * account, so submissions this bot never built are normal and expected there —
   * but "12 awaiting revision, collecting 0" reads like a broken sweep unless
   * you can see that 12 of them are simply not ours.
   */
  if (unknown.length) {
    console.log(`[revisions] ignoring ${unknown.length} not in the database: ${unknown.join(', ')}`);
    logEvent('🙈', 'feedback_skip', `${unknown.length} in the revise list are not this bot's tasks`);
  }

  if (!wanted.length) {
    console.log(
      `[revisions] ${uids.length} awaiting revision, nothing to collect ` +
        `(${unknown.length} not ours, ${uids.length - unknown.length} already read)`
    );
    return { considered: uids.length, collected: 0, ignored: unknown.length };
  }

  console.log(
    `[revisions] ${wanted.length} to collect feedback for — ` +
      wanted.map((uid) => `${uid} (${reasons[uid]})`).join(', ')
  );

  logEvent('📥', 'feedback_start', `collecting feedback for ${wanted.length} task(s)`);
  const result = await hub.command('snorkel', { type: 'collect_feedback', uids: wanted });

  let stored = 0;
  for (const item of result.collected || []) {
    const saved = await addFeedback(
      item.uid,
      {
        text: item.feedback,
        notes: item.notes || [],
        // Automated check output, kept separate from the reviewer's prose.
        checks: item.checks || [],
        collected_at: item.collected_at || new Date().toISOString(),
      },
      { source_url: item.page_url || null }
    );

    if (saved.skipped) {
      logEvent('⚠️', 'feedback_skipped', `${item.uid}: ${saved.reason}`, { level: 'warn', uid: item.uid });
      continue;
    }

    stored++;
    logEvent('📝', 'feedback_saved', `feedback stored for ${item.uid}`, { uid: item.uid });
  }
  for (const failure of result.failures || []) {
    logEvent('⚠️', 'feedback_failed', `${failure.uid}: ${failure.error}`, { level: 'warn', uid: failure.uid });
  }

  return {
    considered: uids.length,
    collected: stored,
    ignored: unknown.length,
    failed: (result.failures || []).length,
  };
}

// ----------------------------------------------------- the whole thing ----

/** Snorkel step then Dropbox step, with no caller involvement in between. */
async function runFullPipeline(options, onStep = () => {}) {
  // The lock is taken around the whole pipeline, not just the Snorkel step, so
  // a second run cannot start while the first is still uploading.
  return withRunLock(options, () => runPipelineSteps(options, onStep));
}

async function runPipelineSteps(options, onStep) {
  onStep('snorkel');
  logEvent('🚀', 'task_start', 'starting a new task on Snorkel');
  const snorkel = await runSnorkelStep(options);
  if (snorkel.saved) {
    logEvent('⬇️', 'task_downloaded', `${snorkel.task.file_name} (${snorkel.task.UID})`, {
      uid: snorkel.task.UID,
    });
  }

  if (!snorkel.saved) {
    // Without a Firestore record there is nothing to flip afterwards, and the
    // upload step reads the task back from Firestore.
    onStep('done');
    return {
      snorkel,
      dropbox: { skipped: true, reason: 'Task was not saved to Firestore; upload skipped.' },
    };
  }

  onStep('dropbox');
  const dropbox = await runDropboxStep(snorkel.task.UID, options);
  if (dropbox.uploaded) {
    logEvent('☁️', 'task_uploaded', `${dropbox.file.name} -> ${dropbox.task.dropbox_path}`, {
      uid: snorkel.task.UID,
    });
  }
  onStep('done');
  return { snorkel, dropbox };
}

/*
 * Jobs exist so one API call can start the workflow and return immediately.
 * Held in memory only: a restart loses the job list, but never the work — every
 * durable effect is already in Firestore or on disk.
 */
const jobs = new Map();
const JOB_HISTORY = 50;

function newJob(options) {
  const id = randomUUID();
  const job = {
    id,
    status: 'running',
    step: 'queued',
    started_at: new Date().toISOString(),
    finished_at: null,
    options,
    result: null,
    error: null,
  };
  jobs.set(id, job);
  // Keep the map from growing without bound.
  while (jobs.size > JOB_HISTORY) jobs.delete(jobs.keys().next().value);
  return job;
}

function startJob(options) {
  const job = newJob(options);
  console.log(`[job] ${job.id} started`);

  runFullPipeline(options, (step) => {
    job.step = step;
  })
    .then((result) => {
      job.result = result;
      // Downloading the file is not the job. If the record never reached
      // Firestore the Dropbox step was skipped too, so reporting "succeeded"
      // would be a lie — the task is half done and sitting in the spool.
      if (!result.snorkel.saved) {
        job.status = 'failed';
        job.error =
          `${result.snorkel.warning} The file was downloaded and the record is queued in ` +
          `pending-tasks.jsonl — fix Firebase, then POST /api/flush and POST /api/upload.`;
        console.error(`[job] ${job.id} INCOMPLETE — ${result.snorkel.warning}`);
        return;
      }
      job.status = 'succeeded';
      console.log(`[job] ${job.id} succeeded (${result.snorkel.task.UID})`);
    })
    .catch((err) => {
      job.status = 'failed';
      job.error = err.message;
      job.error_code = err.code || null;
      console.error(`[job] ${job.id} failed: ${err.message}`);
    })
    .finally(() => {
      job.step = 'done';
      job.finished_at = new Date().toISOString();
    });

  return job;
}

function summarise(job) {
  return {
    id: job.id,
    status: job.status,
    step: job.step,
    started_at: job.started_at,
    finished_at: job.finished_at,
    ...(job.error ? { error: job.error } : {}),
    ...(job.error_code ? { error_code: job.error_code } : {}),
    ...(job.result
      ? {
          uid: job.result.snorkel.task.UID,
          file_name: job.result.snorkel.task.file_name,
          file_uploaded: job.result.dropbox.task ? job.result.dropbox.task.file_uploaded : false,
          task_status: job.result.dropbox.task ? job.result.dropbox.task.task_status : null,
        }
      : {}),
  };
}

app.post('/api/run', async (req, res) => {
  const missing = requiredRoles().filter((role) => !hub.isConnected(role));
  if (missing.length) {
    return res
      .status(503)
      .json({ ok: false, error: `Not connected: ${missing.join(', ')} extension(s).` });
  }

  const { async: runAsync, ...options } = req.body || {};

  // Fire and forget: answer straight away and let the workflow finish on its own.
  if (runAsync) {
    const job = startJob(options);
    return res.status(202).json({
      ok: true,
      job: summarise(job),
      poll: `/api/jobs/${job.id}`,
    });
  }

  // Blocking: hold the response until the whole thing is done. Simpler to
  // script against, but the caller must tolerate a multi-minute request.
  try {
    res.json({ ok: true, ...(await runFullPipeline(options)) });
  } catch (err) {
    sendError(res, err, '/api/run');
  }
});

/*
 * /start_new_task — the one call that runs everything.
 *
 * Defaults to fire-and-forget (a job id comes back immediately) because the
 * point of this endpoint is to hand the work over and walk away. Pass
 * {"async": false} to hold the connection until the whole thing is finished.
 *
 * GET is accepted too, so it can be triggered from a browser or a plain cron
 * line without having to spell out a POST.
 */
async function startNewTask(req, res) {
  const missing = requiredRoles().filter((role) => !hub.isConnected(role));
  if (missing.length) {
    return res
      .status(503)
      .json({ ok: false, error: `Not connected: ${missing.join(', ')} extension(s).` });
  }

  const body = req.method === 'GET' ? {} : req.body || {};
  const { async: runAsync = true, ...options } = body;

  // Checked before the job is created so the caller gets a straight 409 rather
  // than a 202 and a job that fails a moment later.
  try {
    await assertNoTaskInBuild(options);
  } catch (err) {
    return sendError(res, err, '/start_new_task');
  }

  if (runAsync) {
    const job = startJob(options);
    return res.status(202).json({ ok: true, job: summarise(job), poll: `/api/jobs/${job.id}` });
  }

  try {
    res.json({ ok: true, ...(await runFullPipeline(options)) });
  } catch (err) {
    sendError(res, err, '/start_new_task');
  }
}

app.get('/start_new_task', startNewTask);
app.post('/start_new_task', startNewTask);
app.get('/api/start_new_task', startNewTask);
app.post('/api/start_new_task', startNewTask);

app.get('/api/jobs', (_req, res) => {
  res.json({ ok: true, jobs: [...jobs.values()].reverse().map(summarise) });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: 'Job not found.' });
  res.json({ ok: true, job: summarise(job), result: job.result });
});

// -------------------------------------------------------------- reads ----

app.get('/api/tasks', async (_req, res) => {
  try {
    res.json({ ok: true, tasks: await listTasks() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/tasks/:uid', async (req, res) => {
  try {
    const task = await getTask(req.params.uid);
    if (!task) return res.status(404).json({ ok: false, error: 'Not found.' });
    res.json({ ok: true, task });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');
  const off = hub.onEvent((event) => res.write(`data: ${JSON.stringify(event)}\n\n`));
  req.on('close', off);
});

// ------------------------------------------------------------- boot ----

const server = http.createServer(app);
hub.attach(server);

await initFirebase();

// Anything spooled while Firestore was down goes in as soon as it is back.
const queued = await pendingCount().catch(() => 0);
if (queued) {
  console.log(`[server] ${queued} task(s) queued from earlier runs`);
  const { flushed, remaining, reason } = await flushPending();
  if (remaining) console.log(`[server] ${remaining} still queued${reason ? ` — ${reason}` : ''}`);
  else if (flushed) console.log('[server] queue is now empty');
}

/*
 * The Realtime Database channel.
 *
 * This is how the dashboard reaches the server without the server being
 * reachable: both sides connect outward to Firebase. The dashboard writes a
 * command, this picks it up, runs the same pipeline as POST /start_new_task,
 * and reports progress back onto the same node.
 */
await initRtdb();

startStatusHeartbeat(async () => ({
  // Lets the dashboard block the button during the window where a run has
  // started but its task document does not exist yet.
  task_in_flight: Boolean(currentRun()),
  extension_connected: hub.isConnected('snorkel'),
  firebase_ready: firebaseStatus().ready === true,
  dropbox_configured: dropboxConfigured(),
  pending_tasks: await pendingCount().catch(() => 0),
  downloads_dir: config.downloadsDir,
}));

/*
 * The extension raises this by itself on its own timer; nothing asked for it,
 * so it is handled here rather than as a command reply.
 */
hub.onRevisions = async (msg) => {
  if (msg.error) {
    return logEvent('⚠️', 'revision_check_failed', msg.error, { level: 'warn' });
  }

  const uids = msg.uids || [];
  lastRevisionReport = { checked_at: msg.checked_at, next_check_at: msg.next_check_at };
  lastReviseCount = (msg.uids || []).length;
  updateTicker();
  logEvent('🔍', 'revision_check', `${uids.length} task(s) awaiting revision`);

  try {
    await handleRevisionReport(uids);
  } catch (err) {
    logEvent('❌', 'revision_failed', err.message, { level: 'error' });
  }

  // Auto-start runs on its own interval now, so this only records the count it
  // will use.
  lastReviseCount = uids.length;
  updateTicker();
};

/** Once a minute, in place. unref so it never holds the process open. */
async function tick() {
  const inBuild = await findInBuildTask(machineId()).catch(() => null);
  inBuildUid = inBuild ? inBuild.UID : null;
  updateTicker();
}

tick();
setInterval(tick, 60000).unref();

/** Minutes, with a floor so a typo cannot turn this into a busy loop. */
function minutes(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

const DEFAULT_TRY_EVERY = 5;
const DEFAULT_CHECK_EVERY = 5;

let autoTryTimer = null;

/** Re-arms the auto-start timer whenever its interval changes. */
function scheduleAutoTry() {
  const every = minutes(settings.try_new_task_every_min, DEFAULT_TRY_EVERY);
  if (autoTryTimer) clearInterval(autoTryTimer);

  nextAutoTryAt = new Date(Date.now() + every * 60000).toISOString();
  autoTryTimer = setInterval(async () => {
    nextAutoTryAt = new Date(Date.now() + every * 60000).toISOString();
    try {
      // Uses the most recent count from the extension's own sweep rather than
      // asking for a fresh one: the two run on their own intervals, and forcing
      // a page reload here would fight with the revise check.
      if (lastReviseCount !== null) await maybeAutoStart(lastReviseCount);
    } catch (err) {
      logEvent('❌', 'auto_failed', err.message, { level: 'error' });
    }
    updateTicker();
  }, every * 60000);
  autoTryTimer.unref?.();
  updateTicker();
}

// --------------------------------------------------- static check sweep ----

/**
 * True while a zip is being put into the platform.
 *
 * Held here as well as in the extension because the two halves decide different
 * things: the extension refuses commands that would navigate the tab, and this
 * stops the server issuing them in the first place. Either alone would leave the
 * other doing pointless work and logging failures for it.
 */
let submitInFlight = null;

const DEFAULT_SUBMIT_EVERY = 3;
let submitTimer = null;

/**
 * Set when the platform refused to open a task because the revise queue is full.
 *
 * Retrying on the normal three-minute beat would be pointless: nothing changes
 * until some of the backlog is handed in, and each attempt costs a page load and
 * a minute of the browser. So the sweep waits for the one thing that actually
 * moves it — the revise count going down.
 *
 * `until` is a backstop for the case where that count never arrives, because the
 * extension has gone away or nobody is revising anything. Without it a single
 * refusal would park the sweep for good.
 */
let submitBlocked = null;

const SUBMIT_BLOCK_MAX_MINUTES = 60;

/** True while the platform is still refusing, and says so once when it stops. */
function submitStillBlocked() {
  if (!submitBlocked) return false;

  if (lastReviseCount !== null && lastReviseCount < submitBlocked.reviseCount) {
    logEvent(
      '🔓',
      'submit_unblocked',
      `revise list is down to ${lastReviseCount} from ${submitBlocked.reviseCount} — trying again`
    );
    submitBlocked = null;
    return false;
  }

  if (Date.now() >= submitBlocked.until) {
    logEvent('🔁', 'submit_unblocked', `waited ${SUBMIT_BLOCK_MAX_MINUTES} min — trying again anyway`);
    submitBlocked = null;
    return false;
  }

  return true;
}

/**
 * Finds a finished task and asks the extension to upload it and run the checks.
 *
 * Deliberately one at a time. Each check queues a build on the platform and the
 * whole thing owns the browser tab for minutes, so a queue of them would just be
 * a slower way to do the same work with more ways to interleave badly.
 */
async function maybeSubmitCheck() {
  if (submitInFlight) return;
  if (!hub.isConnected('snorkel')) return;
  // A task being started or read is using the same tab.
  if (currentRun()) return;
  if (submitStillBlocked()) return;

  const found = await findReadyToSubmit(machineId()).catch((err) => {
    console.warn('[server] could not look for tasks to check:', err.message);
    return null;
  });
  if (!found) return;

  if (!found.task) {
    if (found.waiting) {
      setTicker('submits', {
        emoji: '⏸️',
        message: `${found.waiting} task(s) ready to submit but their file is not in Dropbox yet`,
      });
    }
    return;
  }

  const task = found.task;
  const uid = String(task.UID);
  submitInFlight = { uid, started_at: new Date().toISOString() };
  updateTicker();
  publishNow();

  const fileUrl =
    `http://127.0.0.1:${config.port}/api/task-file/${encodeURIComponent(uid)}` +
    (config.botToken ? `?token=${encodeURIComponent(config.botToken)}` : '');

  logEvent('📤', 'submit_start', `${uid} — uploading ${task.file_name || 'the task zip'} and running the checks`, {
    uid,
  });

  try {
    const result = await hub.command(
      'snorkel',
      {
        type: 'submit_check',
        options: {
          uid,
          is_new_task: task.is_new_task === true,
          file_url: fileUrl,
          file_name: task.file_name || `${uid}.zip`,
        },
      },
      // Two platform builds back to back, on a zip this size.
      config.submitTimeoutMs
    );

    /*
     * The assignment was gone and the extension came back holding a different
     * task. Nothing was uploaded; what it has instead is that task, already
     * scraped and downloaded.
     *
     * The lost task is retired so it stops blocking, and the new one goes
     * through exactly the same save-and-upload the normal start does. From the
     * worker's point of view a new task simply appeared, which is what happened.
     */
    if (result.wrong_task) {
      logEvent('🫥', 'task_taken', `New task is taken by anyone — ${uid} is gone`, {
        uid,
        level: 'warn',
      });
      await markTaken(uid, result.page_uid || null);
      await adoptTakenTask(result.taken, result.page_uid);
      return;
    }

    await saveStaticCheck(uid, result);

    if (result.passed) {
      logEvent('✅', 'submit_pass', `${uid} passed both checks — ready for you to submit`, { uid });
    } else {
      const failed = (result.results || []).filter((r) => r.verdict !== 'pass').map((r) => r.label);
      logEvent('🚫', 'submit_fail', `${uid} failed ${failed.join(' and ')} — "${TASK_STATUS_STATIC_FAIL}"`, {
        uid,
        level: 'warn',
      });
    }
  } catch (err) {
    if (err.code === 'START_UNAVAILABLE') {
      /*
       * The platform would not open the task. Wait for the revise backlog to
       * come down rather than asking again in three minutes — the answer will
       * be the same until somebody hands one in.
       */
      submitBlocked = {
        uid,
        reviseCount: lastReviseCount ?? Infinity,
        until: Date.now() + SUBMIT_BLOCK_MAX_MINUTES * 60000,
      };
      logEvent(
        '⛔',
        'submit_blocked',
        `Snorkel would not open ${uid}` +
          (lastReviseCount === null
            ? ' — waiting until the revise list has been read'
            : ` with ${lastReviseCount} awaiting revision — waiting for that to drop`),
        { uid, level: 'warn' }
      );
    } else {
      // Left as "ready to submit" so the next sweep tries again. A failure to
      // run the checks is not a failed check, and recording it as one would put
      // a task in front of a person for no reason.
      logEvent('❌', 'submit_error', `${uid}: ${err.message}`, { uid, level: 'error' });
    }
  } finally {
    submitInFlight = null;
    updateTicker();
    publishNow();
  }
}

/**
 * Takes on the task the platform handed us instead.
 *
 * The browser half of a start has already happened — the page was scraped and
 * the file downloaded — so this is only the half the server does anyway: write
 * the record, then put the zip in Dropbox. After that the worker picks it up
 * like any other new task.
 */
async function adoptTakenTask(taken, pageUid) {
  if (!taken || !taken.task || !taken.task.UID) {
    logEvent('⚠️', 'task_taken', `nothing usable was captured from ${pageUid || 'the new page'}`, {
      level: 'warn',
    });
    return;
  }

  const uid = taken.task.UID;
  logEvent('🚀', 'task_start', `taking on ${uid} instead`, { uid });

  const saved = await saveTask(taken.task, taken.meta || {});
  if (!saved.saved) {
    logEvent('⚠️', 'task_warn', `${uid} could not be saved: ${saved.reason}`, { uid, level: 'warn' });
    return;
  }
  logEvent('⬇️', 'task_downloaded', `${taken.task.file_name} (${uid})`, { uid });

  try {
    const dropbox = await runDropboxStep(uid, {});
    if (dropbox.uploaded) {
      logEvent('☁️', 'task_uploaded', `${dropbox.file.name} -> ${dropbox.task.dropbox_path}`, { uid });
    }
  } catch (err) {
    // The record exists and the file is on disk, so the ordinary upload retry
    // path can still finish this. Not worth failing the whole sweep over.
    logEvent('⚠️', 'task_warn', `${uid} was saved but not uploaded: ${err.message}`, {
      uid,
      level: 'warn',
    });
  }
}

function scheduleSubmitSweep() {
  const every = minutes(settings.submit_check_every_min, DEFAULT_SUBMIT_EVERY);
  if (submitTimer) clearInterval(submitTimer);
  submitTimer = setInterval(() => {
    maybeSubmitCheck().catch((err) => console.warn('[server] submit sweep failed:', err.message));
  }, every * 60000);
  submitTimer.unref?.();
}

/** Tells the extension how often to re-read the revise list. */
function pushCheckInterval() {
  if (!hub.isConnected('snorkel')) return;
  const every = minutes(settings.check_revise_every_min, DEFAULT_CHECK_EVERY);
  hub
    .command('snorkel', { type: 'configure', revisionEveryMinutes: every })
    .then(() => logEvent('⚙️', 'settings', `extension will check the revise list every ${every} min`))
    .catch((err) => logEvent('⚠️', 'settings', `could not set the check interval: ${err.message}`, { level: 'warn' }));
}

watchSettings((value) => {
  const before = settings;
  settings = value;

  if (before.revise_limit !== settings.revise_limit) {
    logEvent('⚙️', 'settings', `revise tasks limit is now ${settings.revise_limit ?? 'unset'}`);
  }
  if (before.try_new_task_every_min !== settings.try_new_task_every_min) {
    logEvent('⚙️', 'settings', `try new task every ${minutes(settings.try_new_task_every_min, DEFAULT_TRY_EVERY)} min`);
    scheduleAutoTry();
  }
  if (before.check_revise_every_min !== settings.check_revise_every_min) {
    pushCheckInterval();
  }
  if (before.submit_check_every_min !== settings.submit_check_every_min) {
    logEvent('⚙️', 'settings',
      `look for tasks to upload every ${minutes(settings.submit_check_every_min, DEFAULT_SUBMIT_EVERY)} min`);
    scheduleSubmitSweep();
  }
  updateTicker();
});

scheduleAutoTry();
scheduleSubmitSweep();

watchCommands(async (command, report) => {
  // Marks a task submitted, which is what later makes it eligible for feedback
  // collection. The dashboard cannot write to Firestore itself, so it asks.
  if (command.type === 'mark_sent') {
    if (!command.uid) throw new Error('mark_sent needs a uid.');
    await markSent(command.uid);
    return { step: 'done', uid: command.uid, task_status: 'sent' };
  }

  if (command.type === 'check_revisions') {
    const report_ = await hub.command('snorkel', { type: 'check_revisions' });
    const outcome = await handleRevisionReport(report_.revisions?.map((r) => r.uid) || []);
    return { step: 'done', ...outcome };
  }

  if (command.type !== 'start_new_task') {
    throw new Error(`Unknown command type "${command.type}".`);
  }

  const missing = requiredRoles().filter((role) => !hub.isConnected(role));
  if (missing.length) throw new Error(`Not connected: ${missing.join(', ')} extension(s).`);

  const result = await runFullPipeline(command.options || {}, (step) => report({ step }));

  if (!result.snorkel.saved) {
    // Same rule as the HTTP job: a downloaded file with no record and no upload
    // is not a success.
    throw new Error(
      `${result.snorkel.warning} The file was downloaded and the record is queued in ` +
        `pending-tasks.jsonl — fix Firebase, then POST /api/flush and POST /api/upload.`
    );
  }

  return {
    step: 'done',
    uid: result.snorkel.task.UID,
    file_name: result.snorkel.task.file_name,
    file_uploaded: result.dropbox.task ? result.dropbox.task.file_uploaded : false,
    task_status: result.dropbox.task ? result.dropbox.task.task_status : null,
    dropbox_path: result.dropbox.task ? result.dropbox.task.dropbox_path || null : null,
  };
});

/** Addresses another machine on the same network can actually reach. */
function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((nic) => nic && nic.family === 'IPv4' && !nic.internal)
    .map((nic) => nic.address);
}

// Binding to 0.0.0.0 (the default) is what lets the dashboard be opened from
// another PC. That is also why the token warning below matters.
server.listen(config.port, () => {
  console.log(`[server] machine id: ${machineId()}`);
  console.log(`[server] dashboard:  http://localhost:${config.port}`);
  for (const address of lanAddresses()) {
    console.log(`[server]             http://${address}:${config.port}   <- from another PC`);
  }
  console.log(`[server] websocket:  ws://localhost:${config.port}/extension`);
  console.log(`[server] downloads:  ${config.downloadsDir}`);

  if (authEnabled()) {
    console.log('[server] token auth is ON — the dashboard will ask for BOT_TOKEN');
  } else {
    console.warn(
      '[server] WARNING: BOT_TOKEN is empty, so anyone who can reach this port can\n' +
        '[server]          start tasks and read every stored task. Set BOT_TOKEN in .env\n' +
        '[server]          before using the dashboard from another machine.'
    );
  }
});
