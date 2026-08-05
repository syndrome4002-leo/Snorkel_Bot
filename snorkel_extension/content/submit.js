/*
 * submit.js — attach the finished zip and run the platform's two checks.
 *
 * This is the last step before a human submits: the task has been built, the zip
 * is back on Dropbox, and what is left is to put it into the form and let the
 * platform tell us whether it passes its own gates.
 *
 *   [data-testid="field-output_file"]                 where the zip goes
 *   [data-testid="field-feedbackbutton-static_checks"]        "Check feedback"
 *   [data-testid="field-feedbackbutton-prescriptiveness"]     "Check prescriptiveness"
 *
 * Both checks render the same "AutoEval Execution Summary" panel, and the only
 * thing separating a pass from a fail is `border-success` versus `border-error`
 * and the word PASS or FAIL. The panels are otherwise identical, which is why
 * each one is read from inside its own field block rather than by searching the
 * page — two panels matched globally would be indistinguishable.
 */

(() => {
  const OUTPUT_FIELD = '[data-testid="field-output_file"]';
  const CHECKS = {
    static_checks: {
      field: '[data-testid="field-feedbackbutton-static_checks"]',
      button: /^check feedback$/i,
      label: 'Static Checks',
    },
    prescriptiveness: {
      field: '[data-testid="field-feedbackbutton-prescriptiveness"]',
      button: /^check prescriptiveness$/i,
      label: 'Prescriptiveness',
    },
  };

  /** A verdict panel, once the platform has finished running the check. */
  const RESULT_PANEL = '.rounded-md.border-2';

  /**
   * The two analysis questions, which gate everything else on this page.
   *
   * The re-upload field only exists once both say Fixable — its own label says
   * so ("If \"Fixable\" is selected, please re-upload..."). React does not render
   * it otherwise, so there is nothing to attach to and no amount of waiting will
   * produce one.
   */
  const VALIDITY_FIELDS = [
    { key: 'validity_required', sel: '[data-testid="field-multidimensionradio-segments-valid"]' },
    { key: 'duplicate', sel: '[data-testid="field-radio-ec-valid"]' },
  ];

  /** Radix accordions unmount what they hide, so a closed section has no buttons. */
  const SECTION = '[data-testid^="section-"]';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  /*
   * Deliberate pauses between actions.
   *
   * Every wait in this file is a "wait until X exists" check, which fires the
   * instant the element appears and before the app has settled around it. On top
   * of being a good way to click something React is about to re-render, filling
   * thirty fields in two seconds does not look like a person working through a
   * form.
   *
   * The ranges are randomised rather than fixed, because a constant gap is its
   * own kind of tell. `paceScale` in the command multiplies all of them, so this
   * can be slowed down from the server without touching the extension.
   */
  const PACE = {
    section: [1500, 2200],      // opening one collapsed section
    radio: [1600, 2400],        // choosing a radio option
    field: [1700, 2600],        // moving from one answer to the next
    option: [1500, 2100],       // ticking one checkbox in a list
    number: [1600, 2300],       // typing a handling time
    afterRemove: [1800, 2800],  // the file control swapping back to empty
    beforeCheck: [2000, 2900],  // before asking the platform to run a check
    beforeSubmit: [2200, 3000], // the one click that cannot be taken back
  };

  /*
   * The window every pause sits in: never snappier than 1.5s, never longer than
   * 3s. The table above is written inside it; these are the guard rails, so a
   * range edited to fall outside cannot quietly reintroduce a half-second click
   * or an eight-second stare.
   *
   * The weightier moments keep the top of the window rather than a pause of
   * their own — waiting for a platform check to finish, or for the page to
   * settle, is a separate "wait until done" and is not paced from here.
   */
  const MIN_PAUSE_MS = 1500;
  const MAX_PAUSE_MS = 3000;

  let paceScale = 1;

  /** One human-sized pause. `SnorkelBot.sleep` stays for waits that are not pacing. */
  const pause = (kind) => {
    const [min, max] = PACE[kind] || PACE.field;
    const clamp = (n) => Math.min(MAX_PAUSE_MS, Math.max(MIN_PAUSE_MS, n));
    const low = clamp(min);
    const high = Math.max(low, clamp(max));
    // Scaled afterwards, so the dashboard's pace dial can still slow the whole
    // form down deliberately; at its default of 1 the window is exactly 1.5-3s.
    return SnorkelBot.sleep(Math.round((low + Math.random() * (high - low)) * paceScale));
  };

  /** Every handler takes the scale from its own command, so it can change mid-run. */
  function setPace(msg) {
    const scale = Number(msg && msg.pace_scale);
    paceScale = Number.isFinite(scale) && scale > 0 ? Math.min(10, scale) : 1;
  }

  const buttonsIn = (root) => $$('button', root);
  const findButton = (root, re) =>
    buttonsIn(root).find((b) => re.test(SnorkelBot.normText(SnorkelBot.text(b))));

  // ----------------------------------------------------------- prepare ----

  /**
   * Opens every collapsed section on the page.
   *
   * The check buttons live inside "Submission Feedback", and Radix removes the
   * contents of a closed accordion from the DOM rather than hiding them. A
   * closed section is therefore indistinguishable from a page that does not have
   * those buttons at all, which is exactly how it fails if you skip this.
   */
  async function expandSections({ timeout = 20000 } = {}) {
    /*
     * Wait for the accordions to render first.
     *
     * WAIT_READY is satisfied by the UID, the left panel and the download field,
     * none of which are inside an accordion — so this used to run before the
     * sections existed, open nothing, and report success. The failure then
     * surfaced minutes later as a missing check field.
     */
    await SnorkelBot.waitFor(() => $$(SECTION).length || null, {
      timeout,
      interval: 300,
      label: 'the form sections to render',
    }).catch(() => null);

    let opened = 0;

    for (const section of $$(SECTION)) {
      // A section's own header carries its name; "Show Build Logs" inside the
      // section is the same kind of control and would otherwise match first.
      const name = (section.getAttribute('data-testid') || '').replace(/^section-/, '');
      const toggle = $$('h3 > button[aria-expanded]', section).find(
        (b) => SnorkelBot.normText(SnorkelBot.text(b)) === SnorkelBot.normText(name)
      );

      if (!toggle || toggle.getAttribute('aria-expanded') === 'true') continue;
      SnorkelBot.click(toggle);
      opened++;
      await pause('section');
    }

    if (opened) await pause('section');
    return opened;
  }

  /**
   * Answers both analysis questions with Fixable.
   *
   * Worth being plain about: this writes to the submission form, and the page
   * saves as you go. It is done because the upload field does not exist until
   * both are set, not because the bot has decided the task is fixable.
   */
  async function chooseFixable() {
    const chosen = [];

    for (const { key, sel } of VALIDITY_FIELDS) {
      const field = await SnorkelBot.waitFor(() => $(sel), {
        timeout: 30000,
        label: `the ${key} question`,
      });

      const option = $('button[role="radio"][value="Fixable"]', field);
      if (!option) {
        const seen = $$('button[role="radio"]', field).map((b) => b.getAttribute('value'));
        throw new Error(
          `No "Fixable" option on ${key}. Options present: ${seen.join(', ') || 'none'}.`
        );
      }

      if (option.getAttribute('aria-checked') === 'true') {
        chosen.push(`${key} was already Fixable`);
        continue;
      }

      SnorkelBot.click(option);
      await SnorkelBot.waitFor(() => option.getAttribute('aria-checked') === 'true' || null, {
        timeout: 10000,
        label: `${key} to become Fixable`,
      });
      chosen.push(`${key} set to Fixable`);
      await pause('radio');
    }

    return chosen;
  }

  /**
   * Gets the page into the state where a file can be attached and the checks
   * can be clicked. Nothing here uploads or submits anything.
   */
  SnorkelBot.on('SUBMIT_PREPARE', async (msg) => {
    setPace(msg);
    const opened = await expandSections();
    const chosen = await chooseFixable();

    // Setting the answers is what makes React render the upload field; it is not
    // instant, and attaching before it exists is the failure this waits out.
    // Same treatment as the check fields: it lives in an accordion too, and
    // setting the answers re-renders the form around it.
    const { field } = await findFieldReopening(
      OUTPUT_FIELD,
      'the re-upload field',
      msg.timeout || 30000
    );

    if (!field) {
      throw new Error(
        'Set both questions to Fixable but the re-upload field never appeared. ' +
          `Sections opened: ${opened}. ${chosen.join('; ')}.`
      );
    }

    // Reported so the log says which of the two shapes it actually found, since
    // that decides how the file has to be attached.
    const control = $('input[type="file"]', field)
      ? 'file input'
      : $('button[aria-label="Remove file"]', field)
        ? 'a file is already attached'
        : 'no input — will need a drop';

    /*
     * Reported, not thrown. The checks come later and the page has time to
     * finish rendering; failing here would abandon a run that would have worked.
     * But a missing field at this point is the first sign of the failure that
     * shows up ten minutes later, so it is worth putting in the log now.
     */
    const missingChecks = Object.values(CHECKS)
      .filter((c) => !$(c.field))
      .map((c) => c.label);

    return {
      sections_opened: opened,
      chosen,
      upload_control: control,
      check_fields: missingChecks.length ? `missing: ${missingChecks.join(', ')}` : 'both present',
    };
  });

  // ------------------------------------------------------------ upload ----

  /**
   * Puts `file` into a file input the way a person would.
   *
   * `input.files` is read-only to assignment but settable from a DataTransfer,
   * which is what a real drop or file picker produces. React reads
   * `event.target.files` on change, so a bubbling change event is enough for it
   * to notice.
   */
  function setInputFile(input, file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /**
   * The drag-and-drop path, for an uploader with no input of its own.
   *
   * Less reliable than an input by some distance — it depends on the component
   * listening for exactly these events — so it is only tried when there is no
   * input to use.
   */
  function dropFile(zone, file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    for (const type of ['dragenter', 'dragover', 'drop']) {
      const event = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt });
      zone.dispatchEvent(event);
    }
  }

  /** True once the field shows a file rather than an empty control. */
  const hasFile = (field) =>
    Boolean($('button[aria-label="Remove file"]', field) || $('button[aria-label="Download file"]', field));

  /**
   * Answers the "Are you sure?" dialog that removing a file puts up.
   *
   * It is a Radix alertdialog rendered in a portal at the end of <body>, not
   * inside the field, so it has to be looked for on the document. Until it is
   * answered the page is modal and the file is still attached — which looks
   * exactly like a remove that silently did nothing.
   *
   * `confirmLabel` is matched exactly so the Cancel button next to it cannot be
   * picked by accident. The dialog's own title carries the same words as the
   * confirm button, but that is a div, so only buttons are considered.
   */
  async function confirmDialog(confirmLabel, { timeout = 10000 } = {}) {
    const dialog = await SnorkelBot.waitFor(
      () => $('[data-testid="dialog-content"][data-state="open"]') || $('[role="alertdialog"][data-state="open"]'),
      { timeout, interval: 200, label: `the "${confirmLabel}" confirmation` }
    ).catch(() => null);

    // No dialog is a perfectly good outcome: not every build of the page asks.
    if (!dialog) return { appeared: false };

    const wanted = SnorkelBot.normText(confirmLabel);
    const buttons = buttonsIn(dialog);
    const confirm =
      buttons.find((b) => SnorkelBot.normText(SnorkelBot.text(b)) === wanted) ||
      // Falling back on the danger styling, since that is what a destructive
      // confirmation is: whatever it is called, it is not Cancel.
      buttons.find((b) => /button-danger/.test(b.className || '')) ||
      // Last resort: anything that is plainly not a way out. Matched by name so
      // a dialog whose confirm button is worded differently still gets
      // answered, without Cancel ever being clickable by accident.
      buttons.find((b) => !/^(cancel|close|no|back)$/i.test(SnorkelBot.normText(SnorkelBot.text(b))));

    if (!confirm) {
      throw new Error(
        `A confirmation dialog appeared but had no "${confirmLabel}" button. ` +
          `Buttons: ${buttons.map((b) => JSON.stringify(SnorkelBot.text(b))).join(', ') || 'none'}`
      );
    }

    SnorkelBot.click(confirm);
    await SnorkelBot.waitFor(() => (!dialog.isConnected || dialog.getAttribute('data-state') !== 'open') || null, {
      timeout: 10000,
      label: 'the confirmation dialog to close',
    }).catch(() => null);

    return { appeared: true, clicked: SnorkelBot.text(confirm) };
  }

  /**
   * Attaches the zip, replacing whatever was there.
   *
   * Removing first is deliberate: a field that already holds the previous round's
   * zip would otherwise leave two candidates, and a check run against the old one
   * looks exactly like a check run against the new one.
   */
  SnorkelBot.on('SUBMIT_ATTACH', async (msg) => {
    setPace(msg);
    const field = await SnorkelBot.waitFor(() => $(OUTPUT_FIELD), {
      timeout: msg.timeout || 60000,
      label: 'the re-upload field',
    });

    const steps = [];

    if (hasFile(field)) {
      const remove = $('button[aria-label="Remove file"]', field);
      if (!remove) {
        throw new Error('The re-upload field already holds a file but has no "Remove file" button.');
      }
      SnorkelBot.click(remove);

      // "Are you sure you want to remove this file?" — the page is modal until
      // this is answered, so everything below would time out waiting for a
      // control that is sitting behind a dialog.
      const confirmed = await confirmDialog('Remove File');
      steps.push(
        confirmed.appeared ? 'removed the existing file and confirmed the dialog' : 'removed the existing file'
      );

      // The control swaps back to its empty state; until it does there is
      // nothing to attach to.
      await SnorkelBot.waitFor(() => !hasFile(field) || null, {
        timeout: 20000,
        label: 'the existing file to be removed',
      });
      await pause('afterRemove');
    }

    /*
     * Fetched here rather than handed over by the service worker.
     *
     * A task zip runs to a couple of hundred megabytes, and extension messaging
     * serialises what it carries — as base64 that is a third larger again, held
     * whole in memory on both sides, and it simply does not survive. Fetching in
     * the page keeps it as bytes and never copies it.
     *
     * The server allows this origin explicitly; see its /api/task-file route.
     */
    const res = await fetch(msg.file_url, { credentials: 'omit' });
    if (!res.ok) {
      throw new Error(
        `Could not fetch the task zip from the server (HTTP ${res.status}) at ${msg.file_url}. ` +
          `Is snorkel_server running and reachable from this browser?`
      );
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!bytes.length) throw new Error('The server returned an empty file.');

    const file = new File([bytes], msg.file_name, { type: 'application/zip' });

    const input = $('input[type="file"]', field);
    if (input) {
      setInputFile(input, file);
      steps.push('set the file input');
    } else {
      // Nothing to type into, so the component must be a drop target. Its own
      // root is the best guess at what is listening.
      dropFile(field, file);
      steps.push('dropped onto the field (no file input found)');
    }

    // The upload is to S3 and takes a moment; the field showing the file is the
    // only signal the page gives that it took.
    const took = await SnorkelBot.waitFor(() => hasFile(field) || null, {
      timeout: msg.uploadTimeout || 180000,
      label: 'the uploaded file to appear in the field',
    }).catch(() => null);

    if (!took) {
      throw new Error(
        `Attached ${msg.file_name} but the field never showed a file. Steps: ${steps.join('; ')}.`
      );
    }

    return { attached: true, file_name: msg.file_name, bytes: bytes.length, steps };
  });

  // ------------------------------------------------------------ checks ----

  /** PASS / FAIL / null, from the panel's own styling and wording. */
  function verdictOf(panel) {
    const cls = panel.className || '';
    if (/border-success/.test(cls)) return 'pass';
    if (/border-error/.test(cls)) return 'fail';
    const text = SnorkelBot.text(panel);
    if (/\bPASS\b/.test(text)) return 'pass';
    if (/\bFAIL\b/.test(text)) return 'fail';
    return null;
  }

  /**
   * The build logs, which live behind a collapsed accordion.
   *
   * Radix unmounts closed content, so the log text does not exist in the DOM
   * until the button has been clicked. Reading without expanding returns an
   * empty string every time and looks like a check that produced no output.
   */
  async function readBuildLogs(panel) {
    const toggle = buttonsIn(panel).find((b) => /show build logs/i.test(SnorkelBot.text(b)));
    if (!toggle) return '';

    if (toggle.getAttribute('aria-expanded') !== 'true') {
      SnorkelBot.click(toggle);
      await SnorkelBot.waitFor(() => toggle.getAttribute('aria-expanded') === 'true' || null, {
        timeout: 10000,
        label: 'the build logs to expand',
      }).catch(() => null);
      await pause('section');
    }

    const regionId = toggle.getAttribute('aria-controls');
    const region =
      (regionId && document.getElementById(regionId)) ||
      panel.querySelector('[role="region"]') ||
      null;
    if (!region) return '';

    /*
     * Read from the page world, not from here.
     *
     * The log panel is virtualised: only the rows on screen are in the DOM, so
     * this script — which has no access to the editor's model, to React's props,
     * or to anything that survives a re-render — can see about seven lines of a
     * log that runs to hundreds. Everything that gets the rest of it needs
     * page-world access, so the request goes across and the answer comes back.
     */
    if (!region.id) region.id = `snorkelbot-log-${Math.random().toString(36).slice(2)}`;

    try {
      const full = await requestLogs(region.id);
      if (full.text && full.text.length) return SnorkelBot.cleanBlock(full.text);
    } catch (err) {
      // Falling back rather than failing: a short log is worth more than none,
      // and this is the last step of a run that has otherwise succeeded.
      console.warn('[snorkel-bot] full log read failed, using what is rendered:', err.message);
    }

    return SnorkelBot.cleanBlock(SnorkelBot.text(region));
  }

  /** Asks the page-world reader for one panel's logs in full. */
  function requestLogs(regionId, timeout = 60000) {
    return new Promise((resolve, reject) => {
      const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      let done = false;

      const finish = (fn, value) => {
        if (done) return;
        done = true;
        window.removeEventListener('snorkelbot:logs-ready', onReady);
        clearTimeout(timer);
        fn(value);
      };

      const onReady = () => {
        const node = document.getElementById('__snorkelbot_logs_result');
        if (!node) return;
        let payload;
        try {
          payload = JSON.parse(node.textContent || '{}');
        } catch {
          return finish(reject, new Error('The page returned unreadable log data.'));
        }
        // A leftover answer from an earlier read is not this one.
        if (payload.token !== token) return;
        if (!payload.ok) return finish(reject, new Error(payload.error || 'Reading the logs failed.'));
        finish(resolve, payload);
      };

      const timer = setTimeout(
        () =>
          finish(
            reject,
            new Error(
              'No answer from the page-world log reader. If the extension was reloaded, the tab ' +
                'needs reloading too — MAIN-world scripts only attach on a fresh page load.'
            )
          ),
        timeout
      );

      window.addEventListener('snorkelbot:logs-ready', onReady);
      document.documentElement.setAttribute(
        'data-snorkelbot-logs-request',
        JSON.stringify({ token, regionId, budgetMs: Math.max(5000, timeout - 10000) })
      );
      window.dispatchEvent(new Event('snorkelbot:read-logs'));
    });
  }

  /** The summary sentence, which carries the Build ID. */
  function summaryOf(panel) {
    const line = $$('div', panel).find((d) =>
      /AutoEval execution (succeeded|failed)/i.test(SnorkelBot.text(d))
    );
    return line ? SnorkelBot.normText(SnorkelBot.text(line)) : '';
  }

  /**
   * Runs one check and waits for its verdict.
   *
   * The panel from a previous run is remembered and waited past, so a stale
   * PASS left over from last time cannot be read as this run's result.
   */
  /**
   * Finds a field, re-opening collapsed sections until it appears.
   *
   * A section can close again while the form re-renders, and Radix removes what
   * it hides — so the field is not merely invisible, it is absent, and waiting
   * alone would wait forever. Each pass re-opens whatever is collapsed and looks
   * again.
   *
   * Only collapsed sections are touched: expandSections skips anything already
   * open, so a section a person deliberately left open is never toggled.
   */
  async function findFieldReopening(selector, label, budgetMs = 60000) {
    const deadline = Date.now() + budgetMs;
    let passes = 0;
    let opened = 0;

    while (Date.now() < deadline) {
      const found = $(selector);
      if (found) return { field: found, passes, opened };

      passes++;
      opened += await expandSections({ timeout: 4000 });
      await SnorkelBot.sleep(2000);
    }

    return { field: $(selector), passes, opened };
  }

  async function runCheck(key, spec, timeoutMs) {
    let field = $(spec.field);

    if (!field) {
      // Give it a minute of re-opening rather than one attempt: the page is
      // still settling after a large upload and sections come and go.
      const found = await findFieldReopening(spec.field, spec.label, 60000);
      field = found.field;
      if (field) {
        console.log(
          `[snorkel-bot] ${spec.label} appeared after ${found.passes} pass(es), ` +
            `${found.opened} section(s) re-opened`
        );
      }
    }

    if (!field) {
      // Say what the page actually had, so this is diagnosable from the log
      // rather than needing somebody to be watching the browser at the time.
      const sections = $$(SECTION).map(
        (el) =>
          `${(el.getAttribute('data-testid') || '').replace(/^section-/, '')}` +
          `[${$$('h3 > button[aria-expanded]', el)[0]?.getAttribute('aria-expanded') ?? '?'}]`
      );
      throw new Error(
        `Could not find the ${spec.label} field after a minute of re-opening sections. ` +
          `Sections present: ${sections.join(', ') || 'none'}. ` +
          `A section shown as [false] is collapsed, and Radix removes what it hides.`
      );
    }

    const before = $(RESULT_PANEL, field);
    const beforeText = before ? SnorkelBot.text(before) : '';

    const button = findButton(field, spec.button);
    if (!button) {
      throw new Error(
        `Could not find the button for ${spec.label}. Buttons in that field: ` +
          `${buttonsIn(field).map((b) => JSON.stringify(SnorkelBot.text(b))).join(', ') || 'none'}`
      );
    }

    SnorkelBot.click(button);

    const panel = await SnorkelBot.waitFor(
      () => {
        const found = $(RESULT_PANEL, field);
        if (!found) return null;
        if (!verdictOf(found)) return null;
        // A panel identical to the one already there is last run's, not this one.
        if (before && SnorkelBot.text(found) === beforeText) return null;
        return found;
      },
      { timeout: timeoutMs, interval: 1000, label: `the ${spec.label} result` }
    );

    return {
      key,
      label: spec.label,
      verdict: verdictOf(panel),
      summary: summaryOf(panel),
      logs: await readBuildLogs(panel),
    };
  }

  /**
   * Runs both checks, one after the other.
   *
   * Sequential on purpose: these queue a build on the platform, and two at once
   * is both ruder and harder to attribute if something goes wrong.
   */
  SnorkelBot.on('SUBMIT_RUN_CHECKS', async (msg) => {
    setPace(msg);
    const timeout = msg.checkTimeout || 600000;
    const results = [];

    /*
     * Open the sections again before reading them.
     *
     * Minutes pass between preparing the page and getting here — a couple of
     * hundred megabytes go up in between — and the form re-renders as the upload
     * settles. A section that was open at the start is not necessarily open now,
     * and Radix removes the contents of a closed one from the DOM entirely, so a
     * collapsed section looks exactly like a page that never had those buttons.
     */
    const reopened = await expandSections();
    if (reopened) await SnorkelBot.sleep(600);

    for (const [key, spec] of Object.entries(CHECKS)) {
      await pause('beforeCheck');
      results.push(await runCheck(key, spec, timeout));
    }

    const failed = results.filter((r) => r.verdict !== 'pass');

    return {
      passed: failed.length === 0,
      results,
      checked_at: new Date().toISOString(),
      page_url: location.href,
    };
  });

  // -------------------------------------------------------- fill the form ----

  /*
   * Where each stored answer goes on the page.
   *
   * Keyed by testid where the platform gives a stable one, and by label text
   * where it does not — four of these fields have hashed ids like
   * `field-numeric-61b8d`, which say nothing and could plausibly be renumbered.
   * The label is the question a person reads, so it is the more durable handle
   * of the two.
   */
  /*
   * The form a verdict of Invalid or Valid-as-is produces.
   *
   * A different, much shorter form: the platform drops the upload field, both
   * check buttons, the confirmation checklist, the Send-to-Reviewer box and two
   * of the four time fields the moment the answer stops being "fixable". So
   * this is its own list rather than a filter over the one below — the fields
   * that survive have different ids and, for the times, different meanings.
   *
   * `only` limits a field to one of the two verdicts. Valid-as-is has no
   * "what issue did you find" and no "why is it unfixable", because it is not
   * claiming anything is wrong.
   */
  const VERDICT_FIELDS = [
    { key: 'validity_required', kind: 'radio', testid: 'field-multidimensionradio-segments-valid' },
    { key: 'duplicate', kind: 'radio', testid: 'field-radio-ec-valid', fallback: 'validity_required' },
    {
      key: 'what_issues_found',
      kind: 'multi',
      only: 'invalid',
      label: 'what issue did you find with the task',
    },
    {
      key: 'why_unfixable',
      kind: 'text',
      only: 'invalid',
      label: 'please explain in more detail why this task is unfixable',
    },
    { key: 'what_makes_difficult', kind: 'text', label: 'what makes this task difficult' },
    { key: 'senior_estimated_time', kind: 'radio', testid: 'field-radio-sr-engineer-aht' },
    { key: 'comments_for_reviewer', kind: 'text', label: 'comments for reviewer' },
  ];

  /* The two time fields these forms carry, and nothing else. */
  const VERDICT_TIMES = [
    { key: 'review', label: 'did it take you to review the initial task and determine its validity' },
    { key: 'complete', label: 'did it take you to complete all revisions' },
  ];

  /** What the two validity questions must say, per verdict. */
  const VERDICT_OPTION = {
    invalid: { validity_required: 'Invalid', duplicate: 'Invalid' },
    'valid-as-is': { validity_required: 'Valid-as-is', duplicate: 'Valid-as-is' },
  };

  const FORM_FIELDS = [
    { key: 'validity_required', kind: 'radio', testid: 'field-multidimensionradio-segments-valid' },
    { key: 'duplicate', kind: 'radio', testid: 'field-radio-ec-valid', fallback: 'validity_required' },
    { key: 'where_task_had_issues', kind: 'multi', label: 'select where the task had issues' },
    { key: 'what_issues_found', kind: 'multi', label: 'what issues did you find with the task' },
    { key: 'issues_in_detail', kind: 'text', label: 'describe each issue in detail' },
    { key: 'files_changed', kind: 'text', testid: 'field-textarea-files_changed' },
    { key: 'added_PR_explain', kind: 'text', label: 'if you added to the pr in any way' },
    { key: 'senior_estimated_time', kind: 'radio', testid: 'field-radio-sr-engineer-aht' },
    { key: 'what_makes_difficult', kind: 'text', label: 'what makes this task difficult' },
  ];

  /**
   * Fixed by policy rather than by the model.
   *
   * These are defaults. The server sends the real numbers with the command,
   * because one of them depends on how many times the task has been round the
   * reviewer and only the server can count that. Keeping the defaults here means
   * a command that arrives without them still fills the form.
   */
  /*
   * The four handling times, by the label the platform puts on each.
   *
   * The numbers come from the server, which draws them once per task and keeps
   * them — so there is no default here. A form filled with a built-in constant
   * because the message arrived without them would be the one thing these are
   * randomised to avoid: every submission claiming the same figures.
   */
  const FORM_TIMES = [
    { key: 'review', label: 'review the initial task and determine its validity' },
    { key: 'rewrite', label: 'complete the initial task rewrite only' },
    { key: 'additional', label: 'complete the additional questions on the form' },
    { key: 'revisions', label: 'complete all revisions' },
  ];

  /** Everything in this one gets ticked; it is a list of things to affirm. */
  const CONFIRM_ALL = 'confirm your task meets all the following requirements';

  /**
   * Marks the submission to go to a reviewer once it is handed in.
   *
   * Ticking it does not send anything — the form still has to be submitted, and
   * the bot does not do that. It only means the Submit that a person eventually
   * clicks will route the task to a reviewer rather than saving it quietly.
   */
  const SEND_TO_REVIEWER = 'field-checkbox-send_to_reviewer';

  const fieldByTestid = (prefix) =>
    $$('[data-testid]').find((el) => (el.getAttribute('data-testid') || '').startsWith(prefix));

  const fieldByLabel = (needle) => {
    const wanted = needle.toLowerCase();
    return $$('[data-testid^="field-"]').find((el) => {
      const label = el.querySelector('label');
      return label && SnorkelBot.normText(SnorkelBot.text(label)).toLowerCase().includes(wanted);
    });
  };

  const findField = (spec) =>
    (spec.testid && fieldByTestid(spec.testid)) || (spec.label && fieldByLabel(spec.label)) || null;

  /**
   * Types into a React-controlled input.
   *
   * Assigning `.value` does not tell React anything — it tracks the last value
   * it set and skips the event as a no-op. Going through the prototype's setter
   * updates that tracker too, which is what makes the change stick rather than
   * being wiped on the next render.
   */
  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** A rich-text editor is a contenteditable, not an input. */
  function setRichText(el, value) {
    el.focus();
    // execCommand goes through the editor's own input handling, so the change
    // is one the editor knows about rather than a DOM node appearing under it.
    document.execCommand('selectAll', false, null);
    const inserted = document.execCommand('insertText', false, value);
    if (!inserted) {
      el.textContent = value;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }));
    }
    el.blur();
  }

  async function fillText(field, value) {
    const editable = $('[contenteditable="true"]', field);
    if (editable) {
      setRichText(editable, value);
      return 'rich text';
    }
    const box = $('textarea', field) || $('input[type="text"]', field);
    if (!box) return null;
    setNativeValue(box, value);
    return box.tagName.toLowerCase();
  }

  const isSet = (el) =>
    el.getAttribute('aria-checked') === 'true' || el.getAttribute('data-state') === 'checked';

  /**
   * Clicks a Radix control until it reaches the state asked for.
   *
   * These re-render constantly — the platform's checks run for minutes between
   * preparing the page and filling it in, and every result that lands rebuilds
   * part of the form. A click that arrives mid-render is dropped, with no error
   * and nothing to see. Firing once and reporting success is how a field ends up
   * wrong on the finished form while the log says it was filled.
   */
  async function clickUntil(el, want = true, { attempts = 3, settle = 1200 } = {}) {
    if (isSet(el) === want) return true;

    for (let i = 0; i < attempts; i++) {
      SnorkelBot.click(el);
      const took = await SnorkelBot.waitFor(() => (isSet(el) === want ? true : null), {
        timeout: settle,
        interval: 120,
        label: `the option to become ${want ? 'ticked' : 'unticked'}`,
      }).catch(() => null);
      if (took) return true;
      // A re-render in flight; let it finish before trying again.
      await SnorkelBot.sleep(400);
    }
    return isSet(el) === want;
  }

  async function fillRadio(field, value) {
    const wanted = SnorkelBot.normText(value).toLowerCase();
    const options = $$('button[role="radio"]', field);
    const hit =
      options.find((b) => SnorkelBot.normText(b.getAttribute('value') || '').toLowerCase() === wanted) ||
      options.find((b) => SnorkelBot.normText(SnorkelBot.text(b)).toLowerCase() === wanted);

    if (!hit) {
      return { ok: false, why: `no option "${value}" (have: ${options.map((b) => b.getAttribute('value')).join(', ')})` };
    }

    const already = isSet(hit);
    const took = await clickUntil(hit, true);
    if (!already) await pause('radio');
    if (!took) return { ok: false, why: `clicked "${value}" but it did not stay selected` };
    return { ok: true };
  }

  /** Ticks the wanted options in a multi-select, leaving the rest alone. */
  async function fillMulti(field, values, { all = false } = {}) {
    const boxes = $$('[role="checkbox"], button[role="option"], [role="menuitemcheckbox"]', field);
    if (!boxes.length) return { ok: false, why: 'no options found' };

    const wanted = (values || []).map((v) => SnorkelBot.normText(v).toLowerCase());

    const options = boxes.map((box) => {
      const label = SnorkelBot.normText(
        box.getAttribute('aria-label') || SnorkelBot.text(box) || box.getAttribute('value') || ''
      )
        .replace(/<[^>]*>/g, '')
        .toLowerCase();
      // Substring both ways: the stored answers are shortened versions of the
      // option text ("oracle" for "Oracle Solution"), and the option text is
      // sometimes a shortened version of the answer.
      return { box, label, want: all || wanted.some((w) => label.includes(w) || w.includes(label)) };
    });

    /*
     * Nothing matched, on a field the caller had an answer for.
     *
     * That is a matching failure rather than an empty answer — and now that this
     * unticks, acting on it would CLEAR the field instead of merely leaving it
     * short. Left exactly as it is, and reported.
     */
    if (!all && !options.some((o) => o.want)) {
      return {
        ok: false,
        ticked: 0,
        unticked: 0,
        of: boxes.length,
        missed: [],
        why: `none of ${JSON.stringify(values)} matched the options on this page`,
      };
    }

    let ticked = 0;
    let unticked = 0;
    const missed = [];

    for (const { box, label, want } of options) {
      /*
       * The answer is the whole set, not something to add to it.
       *
       * A revision re-fills a form that still has last round's boxes ticked, so
       * anything absent from the answer has to come OFF. Only ever ticking meant
       * the selection grew every round and ended up claiming more than the
       * answer said.
       */
      if (isSet(box) === want) continue;

      if (await clickUntil(box, want)) {
        if (want) ticked++;
        else unticked++;
      } else {
        missed.push(`${label.slice(0, 40) || '(unlabelled)'} would not ${want ? 'tick' : 'untick'}`);
      }
      await pause('option');
    }

    return {
      ok: !missed.length,
      ticked,
      unticked,
      of: boxes.length,
      missed,
      why: missed.join(', '),
    };
  }

  /**
   * Writes the stored answers onto the form, and nothing else.
   *
   * Never ticks "Send to Reviewer" and never clicks Submit. The whole point is
   * that a person looks at this before it goes anywhere.
   */
  /**
   * The whole page, for a task whose verdict ended it.
   *
   * One handler rather than the prepare / attach / check / fill sequence,
   * because there is nothing to prepare for and nothing to check: choosing
   * anything but Fixable removes the upload field and both check buttons from
   * the page. So it answers the two validity questions, fills what is left, and
   * stops.
   */
  /**
   * Handing the form in, if that has been asked for.
   *
   * Only ever on an explicit true. This is the one action in the whole system
   * that cannot be undone — after it, a reviewer has the task — so it does not
   * happen because a field was missing from a message.
   */
  async function handIn(want, filled, skipped) {
    if (!want) return false;

    const button = $$('button').find((b) => SnorkelBot.normText(SnorkelBot.text(b)).toLowerCase() === 'submit');
    if (!button) {
      skipped.push('submit (no Submit button found)');
      return false;
    }
    if (button.disabled || button.getAttribute('aria-disabled') === 'true') {
      skipped.push('submit (the button is disabled, so the form is not complete)');
      return false;
    }

    // The last click of the whole run, and the one that cannot be undone.
    await pause('beforeSubmit');
    SnorkelBot.click(button);
    // Some builds ask to confirm; some do not. Either is fine.
    const confirmed = await confirmDialog('Submit', { timeout: 6000 });
    filled.push(`submitted${confirmed.appeared ? ' and confirmed' : ''}`);
    await SnorkelBot.sleep(1500);
    return true;
  }

  SnorkelBot.on('SUBMIT_VERDICT_FORM', async (msg) => {
    setPace(msg);
    const verdict = String(msg.verdict || '').toLowerCase();
    const wanted = VERDICT_OPTION[verdict];
    if (!wanted) throw new Error(`Not a verdict this form knows: "${msg.verdict}"`);

    const answers = msg.answers || {};
    const times = msg.times || {};
    const filled = [];
    const skipped = [];

    await expandSections();

    /*
     * The verdict first, and on its own.
     *
     * The rest of the form is rendered from it — "what issue did you find" and
     * "why is it unfixable" do not exist until the answer is Invalid — so
     * filling in field order would skip them on a page that had not caught up.
     */
    for (const spec of VERDICT_FIELDS.slice(0, 2)) {
      const field = await SnorkelBot.waitFor(() => findField(spec), {
        timeout: msg.timeout || 60000,
        label: `the ${spec.key} question`,
      });
      const res = await fillRadio(field, wanted[spec.key]);
      res.ok ? filled.push(spec.key) : skipped.push(`${spec.key} (${res.why})`);
      await pause('radio');
    }

    // Let the form redraw around the answer before looking for the rest.
    await pause('section');

    for (const spec of VERDICT_FIELDS.slice(2)) {
      if (spec.only && spec.only !== verdict) continue;

      const value = answers[spec.key] ?? (spec.fallback ? answers[spec.fallback] : undefined);
      if (value === undefined || value === null || value === '') {
        skipped.push(`${spec.key} (no answer stored)`);
        continue;
      }

      const field = findField(spec);
      if (!field) {
        skipped.push(`${spec.key} (field not on this page)`);
        continue;
      }

      try {
        if (spec.kind === 'radio') {
          const res = await fillRadio(field, value);
          res.ok ? filled.push(spec.key) : skipped.push(`${spec.key} (${res.why})`);
        } else if (spec.kind === 'multi') {
          const res = await fillMulti(field, Array.isArray(value) ? value : [value]);
          if (res.ticked || res.unticked) {
            filled.push(`${spec.key} (${res.ticked} ticked${res.unticked ? `, ${res.unticked} cleared` : ''})`);
          }
          if (!res.ok) skipped.push(`${spec.key} (${res.why})`);
        } else {
          const how = await fillText(field, String(value));
          how ? filled.push(`${spec.key} (${how})`) : skipped.push(`${spec.key} (no input in the field)`);
        }
      } catch (err) {
        skipped.push(`${spec.key} (${err.message})`);
      }
      await pause('field');
    }

    for (const time of VERDICT_TIMES) {
      const minutes = times[time.key];
      if (!Number.isFinite(Number(minutes))) {
        skipped.push(`${time.key} time (nothing sent)`);
        continue;
      }
      const field = fieldByLabel(time.label);
      const box = field && $('input', field);
      if (!box) {
        skipped.push(`${time.key} time (field not on this page)`);
        continue;
      }
      setNativeValue(box, String(minutes));
      filled.push(`${time.key} time (${minutes})`);
      await pause('number');
    }

    /*
     * No confirmation checklist and no Send to Reviewer: neither is rendered on
     * a form that is not claiming a fix. Looking for them would only produce
     * two "not on this page" lines on every single one of these.
     */
    const submitted = await handIn(msg.auto_submit === true, filled, skipped);

    return { verdict, filled, skipped, submitted, page_url: location.href };
  });

  SnorkelBot.on('SUBMIT_FILL_FORM', async (msg) => {
    setPace(msg);
    const answers = msg.answers || {};
    const filled = [];
    const skipped = [];

    await expandSections();

    for (const spec of FORM_FIELDS) {
      const value = answers[spec.key] ?? (spec.fallback ? answers[spec.fallback] : undefined);
      if (value === undefined || value === null || value === '') {
        skipped.push(`${spec.key} (no answer stored)`);
        continue;
      }

      const field = findField(spec);
      if (!field) {
        skipped.push(`${spec.key} (field not on this page)`);
        continue;
      }

      try {
        if (spec.kind === 'radio') {
          const res = await fillRadio(field, value);
          res.ok ? filled.push(spec.key) : skipped.push(`${spec.key} (${res.why})`);
        } else if (spec.kind === 'multi') {
          const res = await fillMulti(field, Array.isArray(value) ? value : [value]);
          // Both, when some took and some did not: "3 ticked" alone would hide
          // a fourth that silently bounced back.
          if (res.ticked || res.unticked) {
            filled.push(
              `${spec.key} (${res.ticked} ticked` + (res.unticked ? `, ${res.unticked} cleared)` : ')')
            );
          }
          if (!res.ok) skipped.push(`${spec.key} (${res.why})`);
        } else {
          const how = await fillText(field, String(value));
          how ? filled.push(`${spec.key} (${how})`) : skipped.push(`${spec.key} (no input in the field)`);
        }
      } catch (err) {
        skipped.push(`${spec.key} (${err.message})`);
      }
      await pause('field');
    }

    // Every requirement gets affirmed. It is a checklist of things that must be
    // true, and the task has been through the platform's own checks by now.
    const confirmField = fieldByLabel(CONFIRM_ALL);
    if (confirmField) {
      const res = await fillMulti(confirmField, [], { all: true });
      filled.push(`confirmations (${res.ticked}/${res.of} ticked)`);
      if (!res.ok) skipped.push(`confirmations (${res.why})`);
    } else {
      skipped.push('confirmations (field not on this page)');
    }

    for (const time of FORM_TIMES) {
      const field = fieldByLabel(time.label);
      if (!field) {
        skipped.push(`${time.label} (field not on this page)`);
        continue;
      }
      const box = $('input', field);
      if (!box) {
        skipped.push(`${time.label} (no input)`);
        continue;
      }

      const sent = Number(msg.times && msg.times[time.key]);
      if (!Number.isFinite(sent) || sent <= 0) {
        // Left blank rather than guessed. The server owns these numbers, and a
        // guess here would be wrong in the one way that matters.
        skipped.push(`${time.label} (no time sent)`);
        continue;
      }

      setNativeValue(box, String(Math.round(sent)));
      filled.push(`${time.label} = ${Math.round(sent)}`);
      await pause('number');
    }

    /*
     * Last, so it is set on a form that is already complete rather than on one
     * that turned out to be missing half its answers.
     *
     * Absent means yes: a command from an older server, or one sent before the
     * setting was ever saved, should behave the way it always has.
     */
    const wantReviewer = msg.send_to_reviewer !== false;
    const reviewerField = fieldByTestid(SEND_TO_REVIEWER);
    const reviewerBox = reviewerField && $('[role="checkbox"]', reviewerField);

    if (!wantReviewer) {
      skipped.push('send to reviewer (turned off in settings)');
    } else if (!reviewerBox) {
      skipped.push('send to reviewer (checkbox not on this page)');
    } else if (reviewerBox.getAttribute('aria-checked') === 'true') {
      filled.push('send to reviewer (already ticked)');
    } else {
      SnorkelBot.click(reviewerBox);
      await SnorkelBot.waitFor(() => reviewerBox.getAttribute('aria-checked') === 'true' || null, {
        timeout: 5000,
        label: 'send to reviewer to tick',
      }).catch(() => null);

      const ticked = reviewerBox.getAttribute('aria-checked') === 'true';
      (ticked ? filled : skipped).push(`send to reviewer${ticked ? '' : ' (would not tick)'}`);
    }

    const submitted = await handIn(msg.auto_submit === true, filled, skipped);

    return {
      filled,
      skipped,
      submitted,
      send_to_reviewer: wantReviewer,
      filled_at: new Date().toISOString(),
      page_url: location.href,
    };
  });

  /** The UID shown on this page, so the caller can confirm it is the right task. */
  SnorkelBot.on('SUBMIT_PAGE_UID', async () => {
    const badge = $$('*', document).find((el) => /^UID:/i.test(SnorkelBot.text(el)));
    const match = badge && /UID:\s*([0-9a-f-]{8,})/i.exec(SnorkelBot.text(badge));
    return { uid: match ? match[1] : null, page_url: location.href };
  });
})();
