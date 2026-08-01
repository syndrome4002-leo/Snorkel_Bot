/*
 * background.js — MV3 service worker for the Dropbox uploader.
 *
 * Connects to the node server as role "dropbox" and waits for work:
 *
 *   server: {type:"upload_to_dropbox", requestId, task, fileUrl}
 *      1. fetch the zip from the server (the service worker does this, not the
 *         content script: it holds the host permission and is not subject to
 *         the page's CORS or private-network rules)
 *      2. open/reuse a tab on dropbox.com
 *      3. hand the bytes to the content script, which injects them into the
 *         hidden upload input and waits for the file to appear in the listing
 *   extension: {type:"result", requestId, ok, ...}
 *
 * The server owns everything after that: deleting the local file and flipping
 * file_uploaded / task_status in Firestore.
 */

const DEFAULT_CONFIG = {
  serverUrl: 'ws://localhost:8787/extension',
  token: '',
  dropboxUrl: 'https://www.dropbox.com/home',
  folder: '', // '' = the Dropbox root ("All files")
  autoConnect: true,
};

const KEEPALIVE_ALARM = 'dropbox-bot-keepalive';

let ws = null;
let busy = false;
let reconnectDelay = 1000;
let reconnectTimer = null;
let lastRun = null;

async function getConfig() {
  const stored = await chrome.storage.local.get(DEFAULT_CONFIG);
  return { ...DEFAULT_CONFIG, ...stored };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...args) => console.log('[dropbox-bot]', ...args);

// ---------------------------------------------------------- websocket ----

function socketState() {
  if (!ws) return 'disconnected';
  return ['connecting', 'connected', 'closing', 'disconnected'][ws.readyState] || 'unknown';
}

function send(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
    return true;
  }
  return false;
}

function progress(requestId, step, message) {
  log(step, message || '');
  send({ type: 'progress', requestId, step, message: message || '', at: Date.now() });
}

async function connect() {
  const cfg = await getConfig();
  if (!cfg.autoConnect) return;
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;

  // role= lets the server tell the two extensions apart before "hello" arrives.
  let url = cfg.serverUrl + (cfg.serverUrl.includes('?') ? '&' : '?') + 'role=dropbox';
  if (cfg.token) url += '&token=' + encodeURIComponent(cfg.token);

  log('connecting to', cfg.serverUrl);
  try {
    ws = new WebSocket(url);
  } catch (err) {
    log('socket construction failed', err);
    return scheduleReconnect();
  }

  ws.onopen = () => {
    reconnectDelay = 1000;
    log('connected');
    send({
      type: 'hello',
      client: 'dropbox-extension',
      role: 'dropbox',
      version: chrome.runtime.getManifest().version,
    });
  };

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return log('ignoring non-JSON frame');
    }
    handleServerMessage(msg);
  };

  ws.onclose = () => {
    log('disconnected');
    ws = null;
    scheduleReconnect();
  };

  ws.onerror = () => {
    /* onclose always follows */
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

async function handleServerMessage(msg) {
  if (msg.type === 'ping') return void send({ type: 'pong', at: Date.now() });

  if (msg.type === 'upload_to_dropbox') {
    const requestId = msg.requestId || String(Date.now());
    if (busy) {
      return void send({
        type: 'result',
        requestId,
        ok: false,
        error: 'The Dropbox extension is already uploading.',
      });
    }
    busy = true;
    try {
      const result = await runUpload(requestId, msg);
      lastRun = { ok: true, at: Date.now(), ...result };
      send({ type: 'result', requestId, ok: true, ...result });
    } catch (err) {
      const error = String((err && err.message) || err);
      lastRun = { ok: false, at: Date.now(), error };
      log('upload failed:', error);
      send({ type: 'result', requestId, ok: false, error });
    } finally {
      busy = false;
    }
  }
}

// --------------------------------------------------------- tab helpers ----

async function getTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

async function waitForTabComplete(tabId, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const tab = await getTab(tabId);
    if (!tab) throw new Error('The Dropbox tab was closed.');
    if (tab.status === 'complete') return tab;
    await sleep(300);
  }
  throw new Error('Timed out waiting for Dropbox to load.');
}

async function ensureContentScript(tabId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
      if (res && res.ok) return res;
    } catch {
      // not injected yet
    }
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content/dropbox.js'] });
    } catch (err) {
      log('injection attempt failed', err);
    }
    await sleep(500);
  }
  throw new Error('Could not reach the content script in the Dropbox tab.');
}

/**
 * One short round-trip to the page, re-injecting the content script first if a
 * navigation has replaced it. Every message the page handles answers promptly,
 * so no channel is ever left open across a page change.
 */
async function askTab(tabId, message) {
  await ensureContentScript(tabId);
  const res = await chrome.tabs.sendMessage(tabId, message);
  if (!res) throw new Error(`No response from the Dropbox page for ${message.type}.`);
  if (!res.ok) throw new Error(res.error || `${message.type} failed.`);
  return res;
}

async function openDropbox(url) {
  const [existing] = await chrome.tabs.query({ url: 'https://www.dropbox.com/*' });
  const tab = existing
    ? await chrome.tabs.update(existing.id, { url, active: true })
    : await chrome.tabs.create({ url, active: true });
  await waitForTabComplete(tab.id);
  return tab;
}

// ------------------------------------------------------------ transfer ----

/** Chunked so a multi-MB zip does not blow the call stack in String.fromCharCode. */
function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function fetchFile(fileUrl, token) {
  const url = token
    ? fileUrl + (fileUrl.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token)
    : fileUrl;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`The server would not hand over the file (HTTP ${res.status}). ${await res.text().catch(() => '')}`.trim());
  }
  const buffer = await res.arrayBuffer();
  if (!buffer.byteLength) throw new Error('The server returned an empty file.');
  return buffer;
}

// ---------------------------------------------------------- the flow ----

async function runUpload(requestId, msg) {
  const cfg = await getConfig();
  const fileName = (msg.task && msg.task.file_name) || 'task.zip';
  const folder = (msg.options && msg.options.folder) || cfg.folder;
  const target = folder ? `${cfg.dropboxUrl}/${folder.replace(/^\/+/, '')}` : cfg.dropboxUrl;

  // 1 — bytes from the server
  progress(requestId, 'fetch_file', msg.fileUrl);
  const buffer = await fetchFile(msg.fileUrl, msg.token || cfg.token);
  const base64 = bytesToBase64(buffer);
  progress(requestId, 'fetched', `${buffer.byteLength} bytes`);

  // 2 — a Dropbox tab showing a file browser
  progress(requestId, 'open_dropbox', target);
  const tab = await openDropbox(target);
  const ping = await ensureContentScript(tab.id);
  if (!ping.hasInput) {
    throw new Error(`No Dropbox upload input on ${ping.url} — is this a file browser page?`);
  }

  // 3 — snapshot the listing, inject, then poll
  //
  // Each call is short and retryable. Holding one channel open for the whole
  // upload used to fail with "the message channel closed before a response was
  // received": Dropbox navigates (dropbox.com/home redirects), which destroys
  // the content script and takes the channel with it.
  const snapshot = await askTab(tab.id, { type: 'SNAPSHOT_FILES' });
  const before = snapshot.names || [];

  progress(requestId, 'upload', `${fileName} -> ${ping.folder || 'Dropbox'}`);
  const injected = await askTab(tab.id, {
    type: 'UPLOAD_FILE',
    fileName,
    base64,
    mime: 'application/zip',
  });
  progress(requestId, 'injected', `${injected.bytes} bytes handed to Dropbox`);

  const landed = await pollForUpload(tab.id, fileName, before, msg.uploadTimeout || 240000, requestId);

  progress(requestId, 'uploaded', landed.name);

  return {
    uploaded: true,
    file_name: fileName,
    dropbox_name: landed.name,
    dropbox_path: `${landed.folder || 'Dropbox'}/${landed.name}`,
    renamed: landed.name !== fileName,
    bytes: buffer.byteLength,
  };
}

/**
 * Polls the page until the file shows up in the listing. Tolerates the content
 * script being torn down by a navigation: askTab re-injects it, and because
 * CHECK_UPLOAD is stateless the fresh copy can answer just as well.
 */
async function pollForUpload(tabId, fileName, before, timeoutMs, requestId) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  let announced = false;

  while (Date.now() < deadline) {
    try {
      const res = await askTab(tabId, { type: 'CHECK_UPLOAD', fileName, before });
      if (res.landed) return { name: res.landed, folder: res.folder };
      lastError = null;
      if (!announced) {
        announced = true;
        progress(requestId, 'waiting', 'Dropbox is still uploading');
      }
    } catch (err) {
      // A navigation mid-poll is expected, not fatal — try again next tick.
      lastError = err;
    }
    await sleep(1500);
  }

  throw new Error(
    `Dropbox did not show "${fileName}" in the file list within ${Math.round(timeoutMs / 1000)}s` +
      (lastError ? ` (last error: ${lastError.message})` : '') +
      '. The upload may still be in progress — check Dropbox before retrying.'
  );
}

// --------------------------------------------------- popup / lifecycle ----

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.tab) return false;
  if (!msg || typeof msg.type !== 'string') return false;

  if (msg.type === 'BG_STATUS') {
    getConfig().then((config) =>
      sendResponse({ ok: true, socket: socketState(), busy, lastRun, config })
    );
    return true;
  }

  if (msg.type === 'BG_SAVE_CONFIG') {
    chrome.storage.local.set(msg.config).then(() => {
      if (ws) ws.close();
      ws = null;
      reconnectDelay = 1000;
      connect().then(() => sendResponse({ ok: true }));
    });
    return true;
  }

  return false;
});

chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  if (ws && ws.readyState === WebSocket.OPEN) send({ type: 'heartbeat', at: Date.now() });
  else connect();
});

chrome.runtime.onStartup.addListener(() => connect());
chrome.runtime.onInstalled.addListener(() => connect());
connect();
