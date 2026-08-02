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
} from './dropbox.js';
import { updateEnvFile, ENV_PATH } from './envfile.js';
import { initRtdb, rtdbStatus, startStatusHeartbeat, publishNow, watchCommands } from './rtdb.js';
import { machineId, machineInfo } from './machine.js';
import {
  initFirebase,
  saveTask,
  listTasks,
  getTask,
  markUploaded,
  findPendingUpload,
  findInBuildTask,
  markSent,
  addFeedback,
  findSentTasks,
  findUnknownUids,
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

app.use(cors());
app.use(express.json({ limit: '5mb' }));

// The dashboard itself is public — it holds no secrets and only asks for the
// token. Everything it calls is not.
if (existsSync(config.dashboardDir)) {
  app.use(express.static(config.dashboardDir));
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
  if (!existing) return;

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
  if (!uids.length) return { considered: 0, collected: 0 };

  const [sent, unknown] = await Promise.all([findSentTasks(uids), findUnknownUids(uids)]);
  const wanted = [...new Set([...sent.map((t) => t.UID), ...unknown])];

  if (!wanted.length) {
    console.log(`[revisions] ${uids.length} awaiting revision, none of them new`);
    return { considered: uids.length, collected: 0 };
  }

  console.log(
    `[revisions] ${wanted.length} to collect feedback for ` +
      `(${sent.length} previously sent, ${unknown.length} not seen before)`
  );

  const result = await hub.command('snorkel', { type: 'collect_feedback', uids: wanted });

  let stored = 0;
  for (const item of result.collected || []) {
    await addFeedback(
      item.uid,
      {
        text: item.feedback,
        notes: item.notes || [],
        collected_at: item.collected_at || new Date().toISOString(),
      },
      { source_url: item.page_url || null }
    );
    stored++;
  }
  for (const failure of result.failures || []) {
    console.warn(`[revisions] could not read feedback for ${failure.uid}: ${failure.error}`);
  }

  return { considered: uids.length, collected: stored, failed: (result.failures || []).length };
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
  const snorkel = await runSnorkelStep(options);

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
  if (msg.error) return console.warn('[revisions] extension check failed:', msg.error);
  try {
    await handleRevisionReport(msg.uids || []);
  } catch (err) {
    console.error('[revisions] handling failed:', err.message);
  }
};

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
