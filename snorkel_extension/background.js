/*
 * background.js — MV3 service worker.
 *
 * Holds the WebSocket to the node server and runs the whole Sentinel flow when
 * the server asks for it:
 *
 *   server: {type:"start_sentinel", requestId}
 *      1. open/reuse a tab on https://experts.snorkel-ai.com/home
 *      2. content script clicks the Sentinel card's "Start" button
 *      3. wait for the SPA to land on .../submission-<id>/review
 *      4. scrape submission UID + left-panel infos, click the download button,
 *         and capture the real saved filename via chrome.downloads
 *   extension: {type:"result", requestId, ok, task, meta}
 *
 * The server is the one that talks to Firebase; this worker never does.
 */

const DEFAULT_CONFIG = {
  serverUrl: 'ws://localhost:8787/extension',
  token: '',
  homeUrl: 'https://experts.snorkel-ai.com/home',
  projectKey: 'CDG_Sentinel_Ultra_00000',
  mode: 'new', // 'new' | 'resume' | 'any'
  autoConnect: true,
};

const REVIEW_URL_RE = /\/projects\/[^/]+\/submission-[^/]+\/review/i;
const KEEPALIVE_ALARM = 'snorkel-bot-keepalive';

let ws = null;
let busy = false;
let reconnectDelay = 1000;
let reconnectTimer = null;
let lastRun = null; // surfaced in the popup

// ------------------------------------------------------------- config ----

async function getConfig() {
  const stored = await chrome.storage.local.get(DEFAULT_CONFIG);
  return { ...DEFAULT_CONFIG, ...stored };
}

function log(...args) {
  console.log('[snorkel-bot]', ...args);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  // role= lets the server tell this extension from the Dropbox one before the
  // "hello" frame arrives.
  let url = cfg.serverUrl + (cfg.serverUrl.includes('?') ? '&' : '?') + 'role=snorkel';
  if (cfg.token) url += '&token=' + encodeURIComponent(cfg.token);

  log('connecting to', cfg.serverUrl);
  try {
    ws = new WebSocket(url);
  } catch (err) {
    log('socket construction failed', err);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    reconnectDelay = 1000;
    log('connected');
    send({
      type: 'hello',
      client: 'snorkel-extension',
      role: 'snorkel',
      version: chrome.runtime.getManifest().version,
      projectKey: cfg.projectKey,
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
    // onclose always follows, so reconnection is handled there.
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, 30000); // capped exponential backoff
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

async function handleServerMessage(msg) {
  if (msg.type === 'ping') return void send({ type: 'pong', at: Date.now() });

  if (msg.type === 'start_sentinel') {
    const requestId = msg.requestId || String(Date.now());
    if (busy) {
      return void send({
        type: 'result',
        requestId,
        ok: false,
        error: 'Extension is already running a task.',
      });
    }
    busy = true;
    try {
      const result = await runSentinelFlow(requestId, msg.options || {});
      lastRun = { ok: true, at: Date.now(), ...result };
      send({ type: 'result', requestId, ok: true, ...result });
    } catch (err) {
      const error = String((err && err.message) || err);
      lastRun = { ok: false, at: Date.now(), error };
      log('flow failed:', error);
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
    if (!tab) throw new Error('The Snorkel tab was closed.');
    if (tab.status === 'complete') return tab;
    await sleep(300);
  }
  throw new Error('Timed out waiting for the page to finish loading.');
}

async function waitForUrl(tabId, regex, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const tab = await getTab(tabId);
    if (!tab) throw new Error('The Snorkel tab was closed.');
    if (tab.url && regex.test(tab.url)) return tab;
    if (tab.url && /\/login/i.test(tab.url)) {
      throw new Error('Redirected to the Snorkel login page — sign in and retry.');
    }
    await sleep(400);
  }
  throw new Error(`Timed out waiting for the page to navigate to ${regex}`);
}

/**
 * Content scripts are declared in the manifest, but a tab that was already open
 * before the extension loaded (or reloaded) will not have them. Ping first and
 * inject on demand.
 */
async function ensureContentScripts(tabId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
      if (res && res.ok) return;
    } catch {
      // not injected yet
    }
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content/common.js', 'content/homepage.js', 'content/sentinel.js'],
      });
    } catch (err) {
      log('injection attempt failed', err);
    }
    await sleep(500);
  }
  throw new Error('Could not reach the content script in the Snorkel tab.');
}

async function askTab(tabId, message) {
  await ensureContentScripts(tabId);
  const res = await chrome.tabs.sendMessage(tabId, message);
  if (!res) throw new Error(`No response from the page for ${message.type}.`);
  if (!res.ok) throw new Error(res.error || `${message.type} failed.`);
  return res;
}

async function openHome(homeUrl) {
  const [existing] = await chrome.tabs.query({ url: 'https://experts.snorkel-ai.com/*' });
  const tab = existing
    ? await chrome.tabs.update(existing.id, { url: homeUrl, active: true })
    : await chrome.tabs.create({ url: homeUrl, active: true });
  await waitForTabComplete(tab.id);
  return tab;
}

// ---------------------------------------------------------- downloads ----

/**
 * Arms a one-shot listener BEFORE the download button is clicked, so the
 * chrome.downloads event cannot be missed. Resolves with the DownloadItem, or
 * null if nothing started within the timeout.
 */
function armDownloadCapture(timeoutMs = 45000) {
  let settle;
  const promise = new Promise((resolve) => (settle = resolve));

  const onCreated = (item) => finish(item);
  const timer = setTimeout(() => finish(null), timeoutMs);

  function finish(item) {
    clearTimeout(timer);
    chrome.downloads.onCreated.removeListener(onCreated);
    settle(item);
  }

  chrome.downloads.onCreated.addListener(onCreated);
  return { promise, cancel: () => finish(null) };
}

async function waitForDownloadComplete(downloadId, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const [item] = await chrome.downloads.search({ id: downloadId });
    if (!item) return null;
    if (item.state === 'complete') return item;
    if (item.state === 'interrupted') {
      throw new Error(`Download interrupted: ${item.error || 'unknown reason'}`);
    }
    await sleep(500);
  }
  return null; // still downloading; we report the name we already have
}

function basename(p) {
  if (!p) return null;
  return p.split(/[\\/]/).pop() || null;
}

// --------------------------------------------------------- the flow ----

async function runSentinelFlow(requestId, options) {
  const cfg = await getConfig();
  const projectKey = options.projectKey || cfg.projectKey;
  const mode = options.mode || cfg.mode;
  const homeUrl = options.homeUrl || cfg.homeUrl;

  // 1 — home page
  progress(requestId, 'open_home', homeUrl);
  const tab = await openHome(homeUrl);

  // 2 — click Start on the Sentinel card
  progress(requestId, 'click_start', `looking for project "${projectKey}" (${mode})`);
  const start = await askTab(tab.id, { type: 'CLICK_START', projectKey, mode });
  progress(requestId, 'clicked_start', start.href || '');

  // 3 — the SPA routes to the review page
  progress(requestId, 'await_review_page');
  const reviewTab = await waitForUrl(tab.id, REVIEW_URL_RE, 90000);
  await waitForTabComplete(reviewTab.id).catch(() => {}); // SPA routes stay 'complete'
  await askTab(tab.id, { type: 'WAIT_READY', timeout: 90000 });

  // 4a — scrape
  progress(requestId, 'scrape');
  const scraped = await askTab(tab.id, { type: 'SCRAPE' });
  progress(requestId, 'scraped', `UID ${scraped.uid}`);

  // 4b — download (listener armed before the click)
  //
  // CLICK_DOWNLOAD silences the page's beforeunload guard first: the button
  // navigates the tab to a signed URL, and Chrome asks "Leave site?" before it
  // can tell that the response is a download. That dialog is native, so no
  // extension can dismiss it — it has to be prevented. The guard goes back on
  // as soon as the download has been observed.
  progress(requestId, 'download', scraped.file_name || '(filename unknown)');
  const capture = armDownloadCapture(options.downloadTimeout || 45000);
  let item = null;
  try {
    await askTab(tab.id, { type: 'CLICK_DOWNLOAD' });
    item = await capture.promise;
  } catch (err) {
    capture.cancel();
    throw err;
  } finally {
    // Runs on the error path too, so the site's guard is never left off.
    await askTab(tab.id, { type: 'RESTORE_UNLOAD' }).catch(() => {});
  }

  let savedName = null;
  let savedPath = null;
  if (item) {
    const done = await waitForDownloadComplete(item.id).catch((err) => {
      throw new Error(`${err.message} (file: ${basename(item.filename) || 'unknown'})`);
    });
    const final = done || item;
    savedPath = final.filename || null;
    savedName = basename(savedPath) || null;
    progress(requestId, 'downloaded', savedName || '');
  } else {
    progress(requestId, 'download_not_observed', 'falling back to the filename shown on the page');
  }

  const fileName = savedName || scraped.file_name || null;
  if (!fileName) throw new Error('Could not determine the downloaded file name.');

  // The tab is deliberately left open so the task can be worked on by hand.
  return {
    task: {
      UID: scraped.uid,
      file_name: fileName,
      initial_infos: scraped.initial_infos,
    },
    meta: {
      page_url: scraped.page_url,
      project_key: projectKey,
      resumed: !!start.resumed,
      dom_file_name: scraped.file_name || null,
      download_path: savedPath,
      download_confirmed: !!item,
      sections: scraped.sections || {},
      scraped_at: scraped.scraped_at,
    },
  };
}

// --------------------------------------------------- popup / lifecycle ----

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.tab) return false; // content-script traffic is handled per-tab
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

  if (msg.type === 'BG_RUN_NOW') {
    // Manual trigger from the popup — same flow, result is not sent anywhere
    // unless the socket happens to be open.
    if (busy) {
      sendResponse({ ok: false, error: 'Already running.' });
      return false;
    }
    busy = true;
    const requestId = 'manual-' + Date.now();
    runSentinelFlow(requestId, msg.options || {})
      .then((result) => {
        lastRun = { ok: true, at: Date.now(), ...result };
        send({ type: 'result', requestId, ok: true, ...result });
        sendResponse({ ok: true, ...result });
      })
      .catch((err) => {
        const error = String((err && err.message) || err);
        lastRun = { ok: false, at: Date.now(), error };
        sendResponse({ ok: false, error });
      })
      .finally(() => {
        busy = false;
      });
    return true;
  }

  if (msg.type === 'BG_RECONNECT') {
    if (ws) ws.close();
    ws = null;
    reconnectDelay = 1000;
    connect().then(() => sendResponse({ ok: true, socket: socketState() }));
    return true;
  }

  return false;
});

// An MV3 worker is evicted when idle. The alarm wakes it up so the socket is
// re-established (and stays re-established) without the user touching anything.
chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  if (ws && ws.readyState === WebSocket.OPEN) send({ type: 'heartbeat', at: Date.now() });
  else connect();
});

chrome.runtime.onStartup.addListener(() => connect());
chrome.runtime.onInstalled.addListener(() => connect());
connect();
