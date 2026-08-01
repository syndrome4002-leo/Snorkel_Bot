/*
 * sentinel.js — step 3 of the flow, on the Sentinel review page
 * (https://experts.snorkel-ai.com/projects/<projectId>/submission-<submissionId>/review).
 *
 * Scrapes the three things the server needs and clicks the task download button.
 *
 * Landmarks (from snorkel_sentinel_project_UI.html):
 *
 *   Submission UID — top bar:
 *     <div ...>UID:</div><span ...>9e399c85-a496-42d8-a4a6-554172b53604<button .../></span>
 *
 *   Left-side infos — the whole left panel:
 *     <div data-testid="document-review-left-panel"> Original Directory Name /
 *     Category / Difficulty / Task Tags / Languages / Metadata ... </div>
 *
 *   Download file — the S3 uploader field whose testid starts with
 *   "field-s3fileuploader-download_sentinel_20_task_here...":
 *     <div class="text-color-success">9fcb0b00-..._submission.zip</div>
 *     <button aria-label="Download file" title="Download file">
 *
 *   NOTE: the page has a SECOND file widget, data-testid="field-output_file",
 *   holding the expert's *uploaded* result (e.g. "..._corrected.zip"). Selectors
 *   here are scoped to the download field so that one is never picked up.
 */

(function () {
  const LEFT_PANEL = '[data-testid="document-review-left-panel"]';
  const DOWNLOAD_FIELD_PREFIX = 'field-s3fileuploader-download_sentinel';
  const REVIEW_PATH_RE = /\/projects\/[^/]+\/submission-[^/]+\/review/i;

  // ---------------------------------------------------------------- UID ----

  function uidFromTopbar() {
    for (const el of document.querySelectorAll('div, span, p')) {
      if (el.childElementCount !== 0) continue;
      if (el.textContent.trim() !== 'UID:') continue;
      const scope = el.parentElement || el;
      const m = SnorkelBot.text(scope).match(SnorkelBot.UUID_RE);
      if (m) return m[0];
    }
    return null;
  }

  function uidFromBodyText() {
    const m = document.body.innerText.match(/UID:\s*([0-9a-f-]{36})/i);
    return m ? m[1] : null;
  }

  function uidFromUrl() {
    // Falls back to the assignment/submission id in the URL if the badge moved.
    const params = new URLSearchParams(location.search);
    const assignment = params.get('assignmentId');
    if (assignment && SnorkelBot.UUID_RE.test(assignment)) return assignment;
    const m = location.pathname.match(/submission-([0-9a-f-]{36})/i);
    return m ? m[1] : null;
  }

  function findUid() {
    return uidFromTopbar() || uidFromBodyText() || uidFromUrl();
  }

  // -------------------------------------------------------- left panel ----

  function findLeftPanel() {
    return (
      document.querySelector(LEFT_PANEL) ||
      document.querySelector('[data-testid="left"] [class*="left-panel"]') ||
      document.querySelector('[data-testid="left"]')
    );
  }

  /**
   * The panel as plain text, plus a best-effort section split. `initial_infos`
   * is stored as the raw text (that is what was asked for); `sections` is a
   * convenience extra the server may ignore.
   */
  function readLeftPanel() {
    const panel = findLeftPanel();
    if (!panel) return null;

    const raw = SnorkelBot.text(panel);
    if (!raw) return null;

    const sections = {};
    for (const h of panel.querySelectorAll('h3, h4')) {
      const key = SnorkelBot.text(h);
      if (!key) continue;
      // The value block is the sibling that follows the heading inside its wrapper.
      const holder = h.parentElement;
      if (!holder) continue;
      const value = SnorkelBot.text(holder).slice(key.length).trim();
      if (value) sections[key] = value;
    }

    return { text: raw, sections };
  }

  // ---------------------------------------------------------- download ----

  function findDownloadField() {
    const exact = document.querySelector(`[data-testid^="${DOWNLOAD_FIELD_PREFIX}"]`);
    if (exact) return exact;

    // Fallback: any s3fileuploader field that is a *download* field, explicitly
    // excluding the output/upload widget.
    const candidates = Array.from(
      document.querySelectorAll('[data-testid^="field-s3fileuploader"]')
    ).filter((el) => {
      const id = el.getAttribute('data-testid') || '';
      return /download/i.test(id) && !/output/i.test(id);
    });
    return candidates[0] || null;
  }

  function fileNameFrom(field) {
    const success = field.querySelector('.text-color-success');
    const name = SnorkelBot.text(success);
    if (name) return name;
    const m = SnorkelBot.text(field).match(/[\w.\-()]+\.(zip|tar\.gz|tgz|gz|json)/i);
    return m ? m[0] : null;
  }

  function downloadButtonIn(field) {
    return (
      field.querySelector('button[aria-label="Download file"]') ||
      field.querySelector('button[title="Download file"]') ||
      field.querySelector('button[aria-label*="Download" i], button[title*="Download" i]')
    );
  }

  // ---------------------------------------------------------- handlers ----

  function assertOnReviewPage() {
    if (/\/login/i.test(location.pathname)) {
      throw new Error('Not signed in — the browser is on the Snorkel login page.');
    }
    if (!REVIEW_PATH_RE.test(location.pathname)) {
      throw new Error(`Not on a Sentinel review page (current path: ${location.pathname})`);
    }
  }

  /** Waits until UID, left panel and download field have all rendered. */
  SnorkelBot.on('WAIT_READY', async (msg) => {
    assertOnReviewPage();
    return SnorkelBot.waitFor(
      () => {
        const uid = findUid();
        const panel = readLeftPanel();
        const field = findDownloadField();
        if (uid && panel && field) return { uid, hasPanel: true, hasDownloadField: true };
        return null;
      },
      {
        timeout: msg.timeout || 60000,
        label: 'the Sentinel review page to finish rendering (UID + left panel + download field)',
      }
    );
  });

  SnorkelBot.on('SCRAPE', async () => {
    assertOnReviewPage();

    const uid = findUid();
    if (!uid) throw new Error('Could not find the submission UID on the page.');

    const panel = readLeftPanel();
    if (!panel) throw new Error('Could not find the left-hand info panel on the page.');

    const field = findDownloadField();
    const fileName = field ? fileNameFrom(field) : null;

    return {
      uid,
      file_name: fileName,
      initial_infos: panel.text,
      sections: panel.sections,
      page_url: location.href,
      scraped_at: new Date().toISOString(),
    };
  });

  SnorkelBot.on('CLICK_DOWNLOAD', async (msg) => {
    assertOnReviewPage();

    const field = await SnorkelBot.waitFor(findDownloadField, {
      timeout: msg.timeout || 30000,
      label: 'the Sentinel task download field',
    });

    const fileName = fileNameFrom(field);
    const btn = downloadButtonIn(field);
    if (!btn) {
      throw new Error(
        'Found the download field but no download button inside it' +
          (fileName ? ` (file shown: ${fileName})` : ' (no file attached?)')
      );
    }
    if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') {
      throw new Error('The download button is disabled — no task file is attached yet.');
    }

    SnorkelBot.click(btn);
    return { clicked: true, file_name: fileName };
  });
})();
