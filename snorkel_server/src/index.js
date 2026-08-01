/*
 * index.js — Snorkel Bot node server.
 *
 *   /start_new_task             the whole workflow — the one call you need.
 *                                 GET or POST; returns a job id immediately
 *   GET  /api/jobs[/:id]        how a run is going
 *   POST /api/run               same pipeline, but blocking unless {"async":true}
 *   POST /api/start             Snorkel step only: start a task, scrape, download, save
 *   POST /api/upload            Dropbox step only: upload, delete, flip the flags
 *   GET  /api/status            extensions connected? Firebase ready? queue depth?
 *   GET  /api/tasks             recent Tasks documents
 *   GET  /api/tasks/:uid        one Tasks document
 *   GET  /api/tasks/:uid/file   the downloaded zip (fetched by the Dropbox extension)
 *   POST /api/flush             replay tasks that could not reach Firestore
 *   GET  /api/events            server-sent events stream of live progress
 *
 * Both extensions connect to ws://<host>:<port>/extension?role=snorkel|dropbox.
 */

import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { ExtensionHub } from './hub.js';
import { locateTaskFile, deleteTaskFile } from './localfile.js';
import {
  initFirebase,
  saveTask,
  listTasks,
  getTask,
  markUploaded,
  findPendingUpload,
  firebaseStatus,
  flushPending,
  pendingCount,
} from './firebase.js';

const app = express();
const hub = new ExtensionHub();

app.use(cors());
app.use(express.json({ limit: '5mb' }));

// ------------------------------------------------------------- status ----

app.get('/api/status', async (_req, res) => {
  const pending = await pendingCount().catch(() => 0);
  res.json({
    ok: true,
    extensions: hub.status(),
    firebase: firebaseStatus(),
    downloads_dir: config.downloadsDir,
    // Tasks scraped successfully but not yet in Firestore, waiting on a flush.
    pending_tasks: pending,
  });
});

app.post('/api/flush', async (_req, res) => {
  try {
    res.json({ ok: true, ...(await flushPending()) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// -------------------------------------------------------- snorkel step ----

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
    res.json({ ok: true, ...(await runSnorkelStep(req.body || {})) });
  } catch (err) {
    console.error('[api] /api/start failed:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// -------------------------------------------------------- dropbox step ----

/**
 * Serves the downloaded zip to the Dropbox extension. The extension's service
 * worker fetches this (it has host permission for localhost), turns it into a
 * File, and injects it into Dropbox's hidden upload input.
 */
app.get('/api/tasks/:uid/file', async (req, res) => {
  try {
    const task = await getTask(req.params.uid);
    if (!task) return res.status(404).json({ ok: false, error: 'Task not found.' });

    const file = await locateTaskFile(task);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Length', file.size);
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(file.path)}"`);
    res.sendFile(file.path);
  } catch (err) {
    const status = err.code === 'FILE_NOT_FOUND' ? 404 : 500;
    res.status(status).json({ ok: false, error: err.message });
  }
});

/**
 * The Dropbox half: hand the file to the extension, and once it confirms the
 * upload, delete the local copy and flip file_uploaded / task_status.
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

  // Fail fast with a clear message rather than sending the extension on an
  // errand for a file that is not there.
  const file = await locateTaskFile(task);

  const fileUrl = `http://127.0.0.1:${config.port}/api/tasks/${encodeURIComponent(task.UID)}/file`;
  const result = await hub.uploadToDropbox({
    task: { uid: task.UID, file_name: path.basename(file.path) },
    fileUrl,
    token: config.botToken || undefined,
    options: { folder: options.folder || '' },
  });

  const cleanup = await deleteTaskFile(file.path);
  const patch = await markUploaded(task.UID, {
    dropbox_path: result.dropbox_path || null,
    local_path: null, // the file is gone; stop pointing at it
  });

  return {
    task: { ...task, ...patch },
    uploaded: true,
    file: { name: path.basename(file.path), size: file.size, deleted: cleanup.deleted },
    ...(cleanup.deleted ? {} : { warning: `Uploaded, but the local file could not be deleted: ${cleanup.error}` }),
    progress: result.progress,
  };
}

app.post('/api/upload', async (req, res) => {
  if (!hub.isConnected('dropbox')) {
    return res.status(503).json({
      ok: false,
      error: 'No "dropbox" extension is connected. Load dropbox_extension/ in Chrome.',
    });
  }
  try {
    const { uid, ...options } = req.body || {};
    res.json({ ok: true, ...(await runDropboxStep(uid, options)) });
  } catch (err) {
    console.error('[api] /api/upload failed:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ----------------------------------------------------- the whole thing ----

/** Snorkel step then Dropbox step, with no caller involvement in between. */
async function runFullPipeline(options, onStep = () => {}) {
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
  const missing = ['snorkel', 'dropbox'].filter((role) => !hub.isConnected(role));
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
    console.error('[api] /api/run failed:', err.message);
    res.status(500).json({ ok: false, error: err.message });
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
  const missing = ['snorkel', 'dropbox'].filter((role) => !hub.isConnected(role));
  if (missing.length) {
    return res
      .status(503)
      .json({ ok: false, error: `Not connected: ${missing.join(', ')} extension(s).` });
  }

  const body = req.method === 'GET' ? {} : req.body || {};
  const { async: runAsync = true, ...options } = body;

  if (runAsync) {
    const job = startJob(options);
    return res.status(202).json({ ok: true, job: summarise(job), poll: `/api/jobs/${job.id}` });
  }

  try {
    res.json({ ok: true, ...(await runFullPipeline(options)) });
  } catch (err) {
    console.error('[api] /start_new_task failed:', err.message);
    res.status(500).json({ ok: false, error: err.message });
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

server.listen(config.port, () => {
  console.log(`[server] http://localhost:${config.port}`);
  console.log(`[server] extension websocket: ws://localhost:${config.port}/extension`);
  console.log(`[server] downloads folder: ${config.downloadsDir}`);
  if (config.botToken) console.log('[server] token auth is ON');
  console.log(`[server] full pipeline: curl -X POST http://localhost:${config.port}/api/run`);
});
