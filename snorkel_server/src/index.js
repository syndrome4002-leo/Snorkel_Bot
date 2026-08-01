/*
 * index.js — Snorkel Bot node server.
 *
 *   POST /api/start        ask the extension to start a Sentinel task, wait for
 *                          the result, save it to Firestore, return the record
 *   GET  /api/status       is the extension connected? is Firebase ready?
 *   GET  /api/tasks        recent Tasks documents
 *   GET  /api/tasks/:uid   one Tasks document
 *   GET  /api/events       server-sent events stream of live progress
 *
 * The extension connects to ws://<host>:<port>/extension.
 */

import http from 'node:http';
import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { ExtensionHub } from './hub.js';
import { initFirebase, saveTask, listTasks, getTask, firebaseStatus } from './firebase.js';

const app = express();
const hub = new ExtensionHub();

app.use(cors());
app.use(express.json({ limit: '5mb' }));

app.get('/api/status', (_req, res) => {
  res.json({ ok: true, extension: hub.status(), firebase: firebaseStatus() });
});

app.post('/api/start', async (req, res) => {
  if (!hub.isConnected()) {
    return res.status(503).json({
      ok: false,
      error: 'No extension is connected. Open Chrome with the Snorkel Bot extension loaded.',
    });
  }

  try {
    const { task, meta, progress } = await hub.startSentinel(req.body || {});
    const saved = await saveTask(task, meta);
    res.json({
      ok: true,
      task: saved.record,
      saved: saved.saved,
      // Present only when the browser half succeeded but the record did not
      // reach Firestore — the caller must not read `ok:true` as "stored".
      ...(saved.saved ? {} : { warning: `Task NOT saved to Firestore: ${saved.reason}` }),
      meta,
      progress,
    });
  } catch (err) {
    console.error('[api] /api/start failed:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

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

const server = http.createServer(app);
hub.attach(server);

await initFirebase();

server.listen(config.port, () => {
  console.log(`[server] http://localhost:${config.port}`);
  console.log(`[server] extension websocket: ws://localhost:${config.port}/extension`);
  if (config.botToken) console.log('[server] token auth is ON');
  console.log('[server] trigger a run with: curl -X POST http://localhost:' + config.port + '/api/start');
});
