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

  // ---------------------------------------------------------- feedback ----

  /*
   * Reviewer feedback, read from the Task Notes sidebar.
   *
   * Ported from stn_ext/src/notes.js, which gets three things right that a
   * document-wide search for a "Reviewer Feedback" button does not:
   *
   *   1. A COLLAPSED CARD KEEPS NO BODY IN THE DOM. The form is a Radix
   *      accordion and unmounts closed content, so a card that happens to be
   *      shut reads as empty. Every wanted card is opened first, with a pause
   *      between clicks and a settle afterwards.
   *   2. There are TWO notes worth having — "Reviewer Feedback" and
   *      "Automated feedback" — not one.
   *   3. The prose sits in .whitespace-pre-line OR .whitespace-pre-wrap. Taking
   *      only the former misses the other kind entirely.
   *
   * Everything is scoped to the sidebar panel so a collapsible elsewhere on the
   * form cannot be mistaken for a note.
   */
  const NOTES_PANEL = '[data-testid="collapsible-sidebar-panel"]';
  const WANTED_NOTES = ['Reviewer Feedback', 'Automated feedback'];

  function isNoteHeader(el) {
    return (
      el.tagName === 'BUTTON' &&
      !!el.getAttribute('aria-controls') &&
      el.getAttribute('aria-expanded') != null &&
      !!el.querySelector(':scope > div')
    );
  }

  function noteHeaders() {
    // The panel is the right scope. Falling back to the whole document keeps
    // this working if the sidebar is ever restructured — a wanted title is
    // still required, so nothing unrelated gets swept in.
    const panel = document.querySelector(NOTES_PANEL) || document;
    return Array.from(panel.querySelectorAll('button[aria-controls]')).filter(isNoteHeader);
  }

  function noteTitle(header) {
    const first = header.querySelector(':scope > div');
    return first ? SnorkelBot.normText(SnorkelBot.text(first)) : '';
  }

  function isWantedNote(title) {
    const t = SnorkelBot.normLabel(title);
    return WANTED_NOTES.some((w) => SnorkelBot.normLabel(w) === t);
  }

  function noteBody(header) {
    const id = header.getAttribute('aria-controls');
    const region = id ? document.getElementById(id) : null;
    if (!region) return '';

    // The prose only — the controls beneath it are not part of the note.
    const prose = region.querySelectorAll('.whitespace-pre-line, .whitespace-pre-wrap');
    if (prose.length) {
      return Array.from(prose)
        .map((node) => SnorkelBot.cleanBlock(SnorkelBot.text(node)))
        .filter(Boolean)
        .join('\n\n');
    }
    const grouped = region.querySelector('.space-y-12');
    return SnorkelBot.cleanBlock(SnorkelBot.text(grouped || region));
  }

  /** Opens the wanted cards that are shut, so their bodies exist to be read. */
  async function expandNotes() {
    let opened = 0;
    for (const header of noteHeaders()) {
      if (header.getAttribute('aria-expanded') !== 'false') continue;
      if (!isWantedNote(noteTitle(header))) continue;
      SnorkelBot.click(header);
      opened++;
      await SnorkelBot.sleep(120);
    }
    if (opened) await SnorkelBot.sleep(200);
    return opened;
  }

  /** [{ title, body }] for the notes actually present, in WANTED_NOTES order. */
  function noteSections() {
    const headers = noteHeaders();
    const out = [];
    for (const wanted of WANTED_NOTES) {
      for (const header of headers) {
        if (SnorkelBot.normLabel(noteTitle(header)) !== SnorkelBot.normLabel(wanted)) continue;
        const body = noteBody(header);
        if (!body) continue;
        out.push({ title: SnorkelBot.normText(noteTitle(header)), body });
      }
    }
    return out;
  }


  // ------------------------------------------------------- check panes ----

  /*
   * The four automated check panes.
   *
   * These are Monaco editors, which only render the lines currently scrolled
   * into view — so reading their DOM gives whatever fits the viewport, cut off
   * without saying so. Three ways of getting the text, best first:
   *
   *   monaco-model   the editor's own value, via the page-world bridge
   *   react-props    the string React was handed, same bridge
   *   viewport       scroll the pane and stitch the rendered lines together
   *
   * Which one produced each pane is recorded, because only the first two are
   * guaranteed complete. A pane read by "viewport" that ends mid-sentence is
   * then identifiable rather than quietly wrong.
   */
  const CHECK_PANES = [
    { title: 'Difficulty Check', testid: 'field-difficulty_check_summary' },
    { title: 'Agentic Judge Quality Report', testid: 'field-code-rubric_panel_judge' },
    { title: 'Oracle Check', testid: 'field-oracle_check_summary' },
    { title: 'Quality Check', testid: 'field-quality_check_summary' },
  ];

  const MONACO_REQUEST_ATTR = 'data-snorkelbot-monaco-request';
  const MONACO_RESULT_ID = '__snorkelbot_monaco_result';

  /** Asks the MAIN-world bridge for a pane's true value. */
  function askBridge(testid, timeout = 2000) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        window.removeEventListener('snorkelbot:monaco-ready', onReady);
        clearTimeout(timer);
        resolve(value);
      };

      const onReady = () => {
        const node = document.getElementById(MONACO_RESULT_ID);
        if (!node) return finish(null);
        try {
          const payload = JSON.parse(node.textContent || '{}');
          finish(payload.testid === testid ? payload : null);
        } catch {
          finish(null);
        }
      };

      const timer = setTimeout(() => finish(null), timeout);
      window.addEventListener('snorkelbot:monaco-ready', onReady);

      document.documentElement.setAttribute(MONACO_REQUEST_ATTR, testid);
      window.dispatchEvent(new Event('snorkelbot:read-monaco'));
    });
  }

  /**
   * Last resort: scroll the pane and collect the rendered lines.
   *
   * Monaco positions each .view-line absolutely, so the lines are keyed by
   * their `top` and merged across scroll steps — that is what puts them back in
   * order rather than in the order they happened to be rendered.
   */
  async function stitchViewport(host) {
    const lines = new Map();
    const scroller =
      host.querySelector('.monaco-scrollable-element') ||
      host.querySelector('.overflow-guard') ||
      host;

    const collect = () => {
      for (const line of host.querySelectorAll('.view-line')) {
        const top = parseFloat(line.style.top || '0');
        if (!Number.isNaN(top)) lines.set(top, line.textContent || '');
      }
    };

    collect();
    let lastTop = -1;
    let guard = 0;
    // 200 steps is far more than any real report and stops a pane that refuses
    // to scroll from spinning here forever.
    while (scroller.scrollTop !== lastTop && guard++ < 200) {
      lastTop = scroller.scrollTop;
      scroller.scrollTop = lastTop + scroller.clientHeight;
      await SnorkelBot.sleep(60);
      collect();
      if (scroller.scrollTop === lastTop) break;
    }

    return [...lines.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, value]) => value)
      .join('\n');
  }

  /**
   * Opens collapsed sections until the panes exist.
   *
   * The panes live inside the "Submission Feedback" accordion section, which
   * unmounts its contents while shut — so a closed section means the fields are
   * not merely hidden, they are absent. Opening is retried because a section can
   * itself contain a nested collapsible, and because the fields mount a beat
   * after the click.
   */
  async function ensurePanesPresent() {
    const present = () => CHECK_PANES.filter((p) => document.querySelector(`[data-testid="${p.testid}"]`)).length;
    if (present()) return { opened: 0, rounds: 0 };

    let opened = 0;
    let rounds = 0;
    for (; rounds < 3; rounds++) {
      const collapsed = document.querySelectorAll('button[aria-controls][aria-expanded="false"]');
      if (!collapsed.length) break;
      for (const button of collapsed) {
        SnorkelBot.click(button);
        opened++;
        await SnorkelBot.sleep(150);
      }
      await SnorkelBot.sleep(700);
      if (present()) break;
    }
    return { opened, rounds };
  }

  async function readCheckPanes() {
    const expansion = await ensurePanesPresent();

    const out = [];
    const missing = [];
    for (const pane of CHECK_PANES) {
      const host = document.querySelector(`[data-testid="${pane.testid}"]`);
      if (!host) {
        // Recorded rather than skipped in silence: "the pane is not on this
        // page" and "the pane is here but empty" are different problems and
        // used to look identical from the outside.
        missing.push(pane.testid);
        continue;
      }

      let text = null;
      let via = 'unavailable';

      const bridged = await askBridge(pane.testid);
      if (bridged && bridged.text) {
        text = bridged.text;
        via = bridged.via;
      } else if (host.querySelector('.view-line')) {
        text = await stitchViewport(host);
        via = 'viewport';
      }

      const cleaned = SnorkelBot.cleanBlock(text || '');
      out.push({
        title: pane.title,
        testid: pane.testid,
        // An empty pane is reported rather than dropped: "has not run yet" is
        // itself worth knowing.
        text: cleaned,
        via: cleaned ? via : 'empty',
        chars: cleaned.length,
      });
    }

    return {
      checks: out,
      diagnostics: {
        found: out.length,
        missing,
        expanded: expansion.opened,
        expand_rounds: expansion.rounds,
        monaco_bridge: Boolean(document.getElementById(MONACO_RESULT_ID)),
        via: out.map((c) => `${c.testid}=${c.via}(${c.chars})`),
      },
    };
  }

  SnorkelBot.on('COPY_FEEDBACK', async (msg) => {
    assertOnReviewPage();

    // Wait for the sidebar rather than for one particular card: which notes are
    // present depends on how far the review got.
    await SnorkelBot.waitFor(() => noteHeaders().length > 0, {
      timeout: msg.timeout || 90000,
      label: 'the Task Notes sidebar',
    });

    const opened = await expandNotes();
    const sections = noteSections();
    const paneResult = await readCheckPanes();
    const checks = paneResult.checks;

    if (!sections.length && !checks.some((c) => c.text)) {
      throw new Error(
        'Nothing to read here: no Reviewer Feedback or Automated feedback in the sidebar, ' +
          'and none of the four check panes have any content.'
      );
    }

    // Each note under its own heading, so the two are still tellable apart
    // after they have been joined into one stored string.
    const text = sections.map((n) => `${n.title}\n\n${n.body}`).join('\n\n');

    return {
      uid: findUid(),
      feedback: text,
      notes: sections,
      // Kept apart from the reviewer's prose: these are automated output.
      checks,
      // Why the panes came back as they did — the only way to tell a page
      // without panes from panes that could not be read.
      check_diagnostics: paneResult.diagnostics,
      expanded: opened,
      page_url: location.href,
      collected_at: new Date().toISOString(),
    };
  });

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
        timeout: msg.timeout || 120000,
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

  /*
   * The download button navigates the page to a signed URL, which trips the
   * form's beforeunload guard and puts a "Leave site?" dialog in the way. A
   * native dialog cannot be dismissed by an extension, so unload-guard.js
   * (MAIN world) silences the handler while we click and restores it after.
   */
  function suppressUnloadPrompt() {
    window.dispatchEvent(new CustomEvent('snorkelbot:suppress-unload'));
  }

  function restoreUnloadPrompt() {
    window.dispatchEvent(new CustomEvent('snorkelbot:restore-unload'));
  }

  SnorkelBot.on('CLICK_DOWNLOAD', async (msg) => {
    assertOnReviewPage();

    const field = await SnorkelBot.waitFor(findDownloadField, {
      timeout: msg.timeout || 90000,
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

    suppressUnloadPrompt();
    // Safety net: if the background never gets to send RESTORE_UNLOAD (the tab
    // is closed, the flow errors out), put the site's guard back anyway rather
    // than leaving the page unprotected.
    const restoreTimer = setTimeout(restoreUnloadPrompt, 30000);

    try {
      SnorkelBot.click(btn);
    } catch (err) {
      clearTimeout(restoreTimer);
      restoreUnloadPrompt();
      throw err;
    }

    return { clicked: true, file_name: fileName, unload_prompt_suppressed: true };
  });
})();
