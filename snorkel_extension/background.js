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

  /*
   * Deliberate pauses while collecting feedback.
   *
   * Every wait in the flow is a "wait until X exists" check, which fires the
   * moment the element appears — before the app has finished settling around
   * it. Clicking or reading at that instant is what makes the run look frantic
   * and read half-drawn panes. These are flat plain pauses on top of those
   * checks, tunable from chrome.storage without touching the code.
   */
  paceAfterLoadMs: 2000,     // page reported ready -> do something with it
  paceBeforeCopyMs: 2500,    // review page ready -> start reading it
  paceBetweenTasksMs: 4000,  // one task finished -> move to the next
};

const REVIEW_URL_RE = /\/projects\/[^/]+\/submission-[^/]+\/review/i;
const KEEPALIVE_ALARM = 'snorkel-bot-keepalive';
const REVISION_ALARM = 'snorkel-bot-revision-check';
const REVISION_EVERY_MINUTES = 5;

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

  // The dashboard owns the schedule; the alarm is re-created rather than
  // adjusted, because chrome.alarms has no way to change an existing period.
  if (msg.type === 'configure') {
    const requestId = msg.requestId || String(Date.now());
    try {
      const every = Number(msg.revisionEveryMinutes);
      if (Number.isFinite(every) && every >= 1) {
        await chrome.alarms.clear(REVISION_ALARM);
        chrome.alarms.create(REVISION_ALARM, { periodInMinutes: every });
        await chrome.storage.local.set({ revisionEveryMinutes: every });
        log(`revision check interval set to ${every} min`);
      }
      send({
        type: 'result',
        requestId,
        ok: true,
        revisionEveryMinutes: every,
        next_check_at: await nextRevisionCheckAt(),
      });
    } catch (err) {
      send({ type: 'result', requestId, ok: false, error: String((err && err.message) || err) });
    }
    return;
  }

  // The server asks for feedback only for the UIDs it cares about, so this
  // never opens more task pages than necessary.
  if (msg.type === 'collect_feedback') {
    const requestId = msg.requestId || String(Date.now());
    if (busy) {
      return void send({ type: 'result', requestId, ok: false, error: 'Extension is busy.' });
    }
    busy = true;
    try {
      const result = await collectFeedback(requestId, msg.uids || [], msg.options || {});
      send({ type: 'result', requestId, ok: true, ...result });
    } catch (err) {
      send({ type: 'result', requestId, ok: false, error: String((err && err.message) || err), code: err && err.code });
    } finally {
      busy = false;
    }
  }

  if (msg.type === 'check_revisions') {
    const requestId = msg.requestId || String(Date.now());
    // Reading the revise list navigates the tab, which would walk out from under
    // an upload in progress.
    if (busy) {
      return void send({ type: 'result', requestId, ok: false, error: 'Extension is busy.' });
    }
    try {
      const result = await listRevisions();
      send({ type: 'result', requestId, ok: true, ...result });
    } catch (err) {
      send({ type: 'result', requestId, ok: false, error: String((err && err.message) || err) });
    }
  }

  /*
   * Upload a finished task and run the platform's checks on it.
   *
   * Holds `busy` for the whole run, which is what keeps the revision sweep and
   * any attempt to start a new task off the tab while a file is going up. Both
   * of those navigate, and either would abandon the upload halfway with no sign
   * that anything went wrong.
   */
  if (msg.type === 'submit_check') {
    const requestId = msg.requestId || String(Date.now());
    if (busy) {
      return void send({ type: 'result', requestId, ok: false, error: 'Extension is busy.' });
    }
    busy = true;
    try {
      const result = await submitCheck(requestId, msg.options || msg || {});
      send({ type: 'result', requestId, ok: true, ...result });
    } catch (err) {
      send({
        type: 'result',
        requestId,
        ok: false,
        error: String((err && err.message) || err),
        code: err && err.code,
      });
    } finally {
      busy = false;
    }
    return;
  }

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
      lastRun = { ok: false, at: Date.now(), error, code: err && err.code };
      log('flow failed:', error);
      // The code travels with the message so the dashboard can tell "no task was
      // available" apart from "something broke".
      send({ type: 'result', requestId, ok: false, error, code: err && err.code });
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

async function openHome(homeUrl, timeout = 120000) {
  const [existing] = await chrome.tabs.query({ url: 'https://experts.snorkel-ai.com/*' });

  // Leaving the review form raises Chrome's "Leave site?" dialog, which is
  // native and cannot be clicked by an extension — a navigation that hits it
  // just stops. Silencing the page's beforeunload first is what lets the
  // feedback loop go back to the list between tasks. Best effort: a tab with
  // no content script yet has nothing to silence, and needs nothing silenced.
  if (existing) {
    await askTab(existing.id, { type: 'SUPPRESS_UNLOAD' }).catch(() => {});
  }

  const tab = existing
    ? await chrome.tabs.update(existing.id, { url: homeUrl, active: true })
    : await chrome.tabs.create({ url: homeUrl, active: true });
  await waitForTabComplete(tab.id, timeout);
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
  //
  // Clicking Start does not always get you a task: the platform can refuse
  // (daily limit reached, nothing left in the queue, the assignment taken by
  // somebody else) and simply leave you on /home. That is a normal outcome, not
  // a broken extension, so it is reported with its own code rather than as a
  // generic timeout.
  progress(requestId, 'await_review_page');
  let reviewTab;
  try {
    reviewTab = await waitForUrl(tab.id, REVIEW_URL_RE, options.reviewTimeout || 90000);
  } catch (err) {
    const stillHome = await getTab(tab.id).then((t) => t && /\/home/i.test(t.url || ''));
    const failure = new Error(
      stillHome
        ? 'Clicked Start but the site stayed on the home page — no task was handed out ' +
          '(daily limit, empty queue, or the assignment went to someone else).'
        : `Clicked Start but never reached a task page: ${err.message}`
    );
    failure.code = 'START_UNAVAILABLE';
    throw failure;
  }
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

// --------------------------------------------------------- revisions ----

/*
 * Every few minutes, reload the home page and see which submissions the site is
 * asking to have revised.
 *
 * The page is reloaded rather than read as-is because the assignments list is
 * rendered once at load; a tab left open for hours would keep showing what was
 * true when it opened.
 */
async function listRevisions() {
  const cfg = await getConfig();
  // Logged before the navigation, not after: this is the moment the tab jumps
  // to the home page, and without a line here there is nothing to explain it.
  log(`revision check: reloading ${cfg.homeUrl}`);
  const tab = await openHome(cfg.homeUrl);
  await sleep(cfg.paceAfterLoadMs);
  const res = await askTab(tab.id, { type: 'LIST_REVISIONS', projectKey: cfg.projectKey });

  if (!res.rendered) {
    log('revision check: the home page never rendered any cards — treating as nothing to do');
  } else {
    log(
      `revision check: ${res.count} awaiting revision of ${res.cards} card(s)` +
        (res.count ? ' — ' + res.revisions.map((r) => r.uid).join(', ') : '')
    );
  }
  return { revisions: res.revisions, count: res.count, checked_at: new Date().toISOString() };
}

/** When Chrome will next fire the revision alarm, as an ISO string. */
async function nextRevisionCheckAt() {
  try {
    const alarm = await chrome.alarms.get(REVISION_ALARM);
    return alarm ? new Date(alarm.scheduledTime).toISOString() : null;
  } catch {
    return null;
  }
}

/** Reports what is awaiting revision; the server decides what to do about it. */
async function reportRevisions() {
  if (busy) return log('revision check skipped — a task is running');
  if (!ws || ws.readyState !== WebSocket.OPEN) return log('revision check skipped — not connected');

  busy = true;
  try {
    const { revisions, checked_at } = await listRevisions();
    send({
      type: 'revisions',
      uids: revisions.map((r) => r.uid),
      checked_at,
      // Chrome's own schedule, not an assumption about the interval — an alarm
      // that has drifted or been rescheduled still reports the truth.
      next_check_at: await nextRevisionCheckAt(),
    });
  } catch (err) {
    log('revision check failed:', err.message);
    send({ type: 'revisions', uids: [], error: String(err.message || err) });
  } finally {
    busy = false;
  }
}

/**
 * Opens each submission's task page through its Revise button and reads the
 * reviewer feedback. One at a time, because they all share the one tab.
 */
/**
 * Puts a finished task's zip into the form and runs the platform's two checks.
 *
 * Getting to the page differs by what kind of task it is. A new one is still the
 * assignment this account is holding, so the Sentinel card's Start button leads
 * back into it; one that has been through review is reached by its own Revise
 * button in the list. There is no third way in.
 */
async function submitCheck(requestId, options) {
  const cfg = await getConfig();
  const uid = String(options.uid || '');
  if (!uid) throw new Error('submit_check needs a uid.');
  if (!options.file_url) throw new Error('submit_check needs a file_url to fetch the zip from.');

  const projectKey = options.projectKey || cfg.projectKey;

  progress(requestId, 'open_home', options.homeUrl || cfg.homeUrl);
  const tab = await openHome(options.homeUrl || cfg.homeUrl);
  await sleep(options.paceAfterLoadMs ?? cfg.paceAfterLoadMs);

  if (options.is_new_task) {
    progress(requestId, 'click_start', `${uid} is a new task — taking the Start button`);
    await askTab(tab.id, { type: 'CLICK_START', projectKey, mode: options.mode || cfg.mode });
  } else {
    progress(requestId, 'click_revise', uid);
    await askTab(tab.id, { type: 'CLICK_REVISE', uid, projectKey, timeout: 90000 });
  }

  await waitForUrl(tab.id, REVIEW_URL_RE, options.reviewTimeout || 120000);
  await askTab(tab.id, { type: 'WAIT_READY', timeout: 120000 });
  await sleep(options.paceBeforeCopyMs ?? cfg.paceBeforeCopyMs);

  /*
   * Confirm the page is the task we were asked about before touching anything.
   *
   * Start hands out whatever assignment the account currently holds. Nearly
   * always that is the task we mean, but if it has already been submitted or
   * taken away, Start quietly produces a different one — and uploading this
   * task's zip onto somebody else's task is not something you could undo.
   */
  const page = await askTab(tab.id, { type: 'SUBMIT_PAGE_UID' }).catch(() => ({ uid: null }));
  if (page.uid && page.uid !== uid) {
    const err = new Error(
      `Expected task ${uid} but the page is showing ${page.uid}. Nothing was uploaded.`
    );
    err.code = 'WRONG_TASK';
    throw err;
  }
  if (!page.uid) log(`could not read a UID from ${page.page_url || 'the page'} — continuing`);

  progress(requestId, 'attach', options.file_name || 'the task zip');
  const attached = await askTab(tab.id, {
    type: 'SUBMIT_ATTACH',
    file_url: options.file_url,
    file_name: options.file_name || `${uid}.zip`,
    uploadTimeout: options.uploadTimeout || 300000,
  });
  progress(requestId, 'attached', `${attached.bytes} bytes — ${attached.steps.join('; ')}`);

  progress(requestId, 'checks', 'running Check feedback and Check prescriptiveness');
  const checks = await askTab(tab.id, {
    type: 'SUBMIT_RUN_CHECKS',
    checkTimeout: options.checkTimeout || 600000,
    betweenChecksMs: options.betweenChecksMs || 2000,
  });

  progress(
    requestId,
    'checked',
    checks.results.map((r) => `${r.label}: ${r.verdict}`).join(', ')
  );

  return { uid, page_uid: page.uid || null, attached, ...checks };
}

async function collectFeedback(requestId, uids, options) {
  const cfg = await getConfig();
  const collected = [];
  const failures = [];

  // Overridable per command, so a slow machine can be paced from the server
  // without editing the extension.
  const afterLoad = options.paceAfterLoadMs ?? cfg.paceAfterLoadMs;
  const beforeCopy = options.paceBeforeCopyMs ?? cfg.paceBeforeCopyMs;
  const betweenTasks = options.paceBetweenTasksMs ?? cfg.paceBetweenTasksMs;

  for (const [index, uid] of uids.entries()) {
    // Between tasks, not after the last one — no point idling before finishing.
    if (index > 0) {
      progress(requestId, 'pausing', `${betweenTasks}ms before the next task`);
      await sleep(betweenTasks);
    }

    progress(requestId, 'feedback', uid);
    try {
      // Back to the list each time: after reading one task the tab is on that
      // task's page, and the next Revise button only exists on the home page.
      const tab = await openHome(options.homeUrl || cfg.homeUrl);
      await sleep(afterLoad);

      await askTab(tab.id, { type: 'CLICK_REVISE', uid, projectKey: cfg.projectKey, timeout: 90000 });
      await waitForUrl(tab.id, REVIEW_URL_RE, options.reviewTimeout || 120000);
      await askTab(tab.id, { type: 'WAIT_READY', timeout: 120000 });

      // The review page is heavy: the sidebar cards and the Monaco panes mount
      // after WAIT_READY is satisfied. Reading immediately is what returned
      // half-drawn panes.
      await sleep(beforeCopy);

      const res = await askTab(tab.id, { type: 'COPY_FEEDBACK' });
      collected.push({
        uid,
        // The page's own UID is kept when it disagrees with the card's, so a
        // mismatch is visible in the data rather than silently wrong.
        page_uid: res.uid || null,
        feedback: res.feedback,
        // Kept apart as well as joined, so "Reviewer Feedback" and "Automated
        // feedback" stay distinguishable in the database.
        notes: res.notes || [],
        checks: res.checks || [],
        page_url: res.page_url,
        collected_at: res.collected_at,
      });
      const d = res.check_diagnostics || {};
      progress(
        requestId,
        'feedback_ok',
        `${uid} (${res.feedback.length} chars, ${(res.notes || []).length} note(s), ` +
          `${(res.checks || []).filter((c) => c.text).length}/${(res.checks || []).length} check pane(s))`
      );
      // Printed in full so a pane that came back empty can be told apart from
      // one that was never on the page.
      log(
        `check panes for ${uid}: ${d.panes_with_text}/${d.panes_found} with text, ` +
          `missing [${(d.missing || []).join(', ') || 'none'}], ` +
          `opened ${d.sections_opened} section(s) + ${d.notes_opened} note(s), ` +
          `monaco ${d.monaco ? 'found' : 'NOT FOUND'} — ${(d.via || []).join(' ')}`
      );
    } catch (err) {
      log(`feedback for ${uid} failed:`, err.message);
      failures.push({ uid, error: String(err.message || err) });
    }
  }

  return { collected, failures };
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

// The period the dashboard last set wins over the built-in default; the alarm
// is re-created on every worker start, so without this it would silently drop
// back to the default each time Chrome evicted the worker.
chrome.storage.local.get({ revisionEveryMinutes: REVISION_EVERY_MINUTES }).then(({ revisionEveryMinutes }) => {
  const every = Number(revisionEveryMinutes) >= 1 ? Number(revisionEveryMinutes) : REVISION_EVERY_MINUTES;
  chrome.alarms.create(REVISION_ALARM, { periodInMinutes: every });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    if (ws && ws.readyState === WebSocket.OPEN) send({ type: 'heartbeat', at: Date.now() });
    else connect();
    return;
  }
  if (alarm.name === REVISION_ALARM) reportRevisions();
});

chrome.runtime.onStartup.addListener(() => connect());
chrome.runtime.onInstalled.addListener(() => connect());
connect();
