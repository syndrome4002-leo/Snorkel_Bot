/*
 * dropbox.js — content script for dropbox.com.
 *
 * Dropbox's "Upload" button opens a native OS file dialog, which no extension
 * can drive. It does not have to: the page keeps a hidden file input that the
 * dialog would have filled in anyway, so we fill it in ourselves and let
 * Dropbox's own uploader take it from there.
 *
 * Landmarks (from dropbox_ui.html):
 *
 *   the input the OS dialog normally populates:
 *     <input type="file" id="uploader-file-field"
 *            data-testid="uploader-file-field" multiple style="display: none;">
 *
 *   the file listing, used to tell when the upload has actually landed:
 *     <div role="grid">
 *       <div role="row" aria-label="File, prewitt_golden_solution.zip">
 *         <div role="gridcell" data-filename="prewitt_golden_solution.zip">
 *
 *   current folder name: <div data-testid="browse-renamable-title">All files</div>
 */

(function () {
  const FILE_INPUT = 'input[data-testid="uploader-file-field"], input#uploader-file-field';
  const GRID = '[role="grid"]';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(fn, { timeout = 30000, interval = 400, label = 'condition' } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await fn();
      if (value) return value;
      await sleep(interval);
    }
    throw new Error(`Timed out after ${timeout}ms waiting for ${label}`);
  }

  /** Every file/folder name currently rendered in the listing. */
  function listedNames() {
    const names = new Set();
    for (const cell of document.querySelectorAll('[data-filename]')) {
      const name = cell.getAttribute('data-filename');
      if (name) names.add(name);
    }
    // aria-label="File, <name>" is the fallback if data-filename ever goes away.
    for (const row of document.querySelectorAll('[role="row"][aria-label^="File, "]')) {
      names.add(row.getAttribute('aria-label').slice('File, '.length).trim());
    }
    return names;
  }

  /**
   * The heading renders its name twice (a visually hidden copy). In saved,
   * pretty-printed HTML the two copies are separated by formatting whitespace;
   * in the live DOM they are not, so textContent reads "All filesAll files".
   * Handle both: take the first non-empty line, then undouble it.
   */
  function currentFolder() {
    const el = document.querySelector('[data-testid="browse-renamable-title"]');
    if (!el) return null;

    const [first] = el.textContent
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (!first) return null;

    const half = first.length / 2;
    if (Number.isInteger(half) && first.slice(0, half) === first.slice(half)) {
      return first.slice(0, half);
    }
    return first;
  }

  function base64ToBytes(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  /**
   * Puts the file into the hidden input exactly as the OS dialog would, then
   * fires the events Dropbox's React handler is listening for.
   */
  function injectFile(input, file) {
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;

    if (input.files.length !== 1) throw new Error('The browser rejected the injected file.');

    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /*
   * Injection and completion-checking are deliberately SEPARATE messages.
   *
   * An earlier version held one message channel open for the whole upload and
   * failed with "the message channel closed before a response was received":
   * Dropbox is a single-page app that navigates (dropbox.com/home redirects),
   * and a navigation destroys the content script mid-await, killing the
   * channel. Every handler here now answers immediately, and the service worker
   * polls with short calls it can retry — re-injecting this script if the page
   * replaced it. Nothing is remembered between calls, so a fresh copy of this
   * script can answer just as well as the one that did the injecting.
   */
  async function handleUpload(msg) {
    if (/\/login/i.test(location.pathname)) {
      throw new Error('Not signed in to Dropbox.');
    }

    const input = await waitFor(() => document.querySelector(FILE_INPUT), {
      timeout: msg.timeout || 30000,
      label: 'the Dropbox upload input (is this a file browser page?)',
    });

    const bytes = base64ToBytes(msg.base64);
    if (!bytes.length) throw new Error('The file arrived empty.');

    const file = new File([bytes], msg.fileName, {
      type: msg.mime || 'application/zip',
      lastModified: Date.now(),
    });

    injectFile(input, file);

    return { injected: true, file_name: msg.fileName, bytes: bytes.length, folder: currentFolder() };
  }

  /**
   * Has the upload landed? `before` is the caller's snapshot of the listing
   * taken before injection, passed in each time so this stays stateless.
   */
  function checkUpload(msg) {
    const before = new Set(msg.before || []);
    const now = listedNames();
    const stem = String(msg.fileName).replace(/\.[^.]+$/, '');

    // A file of the same name already present means Dropbox will store ours
    // suffixed ("… (1).zip"), so an exact-name match would never arrive.
    if (!before.has(msg.fileName) && now.has(msg.fileName)) {
      return { landed: msg.fileName, folder: currentFolder() };
    }
    for (const name of now) {
      if (!before.has(name) && (name === msg.fileName || name.startsWith(stem))) {
        return { landed: name, folder: currentFolder() };
      }
    }
    return { landed: null, listed: now.size, folder: currentFolder() };
  }

  // The service worker re-injects this file whenever a PING goes unanswered.
  // Without this guard a race could leave two listeners on the same page, both
  // answering the same message.
  if (window.__snorkelDropboxBotLoaded) return;
  window.__snorkelDropboxBotLoaded = true;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return false;

    if (msg.type === 'PING') {
      sendResponse({
        ok: true,
        url: location.href,
        hasInput: !!document.querySelector(FILE_INPUT),
        hasGrid: !!document.querySelector(GRID),
        folder: currentFolder(),
      });
      return false;
    }

    if (msg.type === 'SNAPSHOT_FILES') {
      sendResponse({ ok: true, url: location.href, names: [...listedNames()], folder: currentFolder() });
      return false;
    }

    if (msg.type === 'CHECK_UPLOAD') {
      // Synchronous: answers now, so the channel is never left open across a
      // navigation.
      try {
        sendResponse({ ok: true, url: location.href, ...checkUpload(msg) });
      } catch (err) {
        sendResponse({ ok: false, url: location.href, error: String(err.message || err) });
      }
      return false;
    }

    if (msg.type === 'UPLOAD_FILE') {
      // Async only long enough to find the input and decode the bytes — seconds,
      // not the length of the upload.
      handleUpload(msg)
        .then((data) => sendResponse({ ok: true, url: location.href, ...data }))
        .catch((err) => sendResponse({ ok: false, url: location.href, error: String(err.message || err) }));
      return true;
    }

    return false;
  });
})();
