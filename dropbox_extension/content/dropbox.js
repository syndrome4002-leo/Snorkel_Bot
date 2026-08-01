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

  function currentFolder() {
    const el = document.querySelector('[data-testid="browse-renamable-title"]');
    if (!el) return null;
    // The heading renders the name twice (a visually hidden copy), so a plain
    // .trim() yields "All files\n   \n  All files". Take the first real line.
    const [first] = el.textContent
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    return first || null;
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

    // Snapshot first: if a file of the same name is already here, Dropbox will
    // save ours under a suffixed name and waiting for the exact name would hang.
    const before = listedNames();
    const existed = before.has(msg.fileName);

    injectFile(input, file);

    const stem = msg.fileName.replace(/\.[^.]+$/, '');
    const landed = await waitFor(
      () => {
        const now = listedNames();
        if (!existed && now.has(msg.fileName)) return msg.fileName;
        for (const name of now) {
          if (!before.has(name) && (name === msg.fileName || name.startsWith(stem))) return name;
        }
        return null;
      },
      {
        timeout: msg.uploadTimeout || 240000,
        interval: 1000,
        label: `"${msg.fileName}" to appear in the Dropbox file list`,
      }
    );

    return {
      uploaded: true,
      file_name: msg.fileName,
      dropbox_name: landed,
      renamed: landed !== msg.fileName,
      folder: currentFolder(),
      bytes: bytes.length,
    };
  }

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

    if (msg.type === 'UPLOAD_FILE') {
      handleUpload(msg)
        .then((data) => sendResponse({ ok: true, url: location.href, ...data }))
        .catch((err) => sendResponse({ ok: false, url: location.href, error: String(err.message || err) }));
      return true;
    }

    return false;
  });
})();
