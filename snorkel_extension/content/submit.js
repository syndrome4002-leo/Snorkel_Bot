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
  async function expandSections() {
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
      await SnorkelBot.sleep(250);
    }

    if (opened) await SnorkelBot.sleep(600);
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
      await SnorkelBot.sleep(400);
    }

    return chosen;
  }

  /**
   * Gets the page into the state where a file can be attached and the checks
   * can be clicked. Nothing here uploads or submits anything.
   */
  SnorkelBot.on('SUBMIT_PREPARE', async (msg) => {
    const opened = await expandSections();
    const chosen = await chooseFixable();

    // Setting the answers is what makes React render the upload field; it is not
    // instant, and attaching before it exists is the failure this waits out.
    const field = await SnorkelBot.waitFor(() => $(OUTPUT_FIELD), {
      timeout: msg.timeout || 30000,
      label: 'the re-upload field to appear',
    }).catch(() => null);

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

    return { sections_opened: opened, chosen, upload_control: control };
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
      buttons.find((b) => /button-danger/.test(b.className || ''));

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
      await SnorkelBot.sleep(500);
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
      await SnorkelBot.sleep(400);
    }

    const regionId = toggle.getAttribute('aria-controls');
    const region =
      (regionId && document.getElementById(regionId)) ||
      panel.querySelector('[role="region"]') ||
      null;

    return region ? SnorkelBot.cleanBlock(SnorkelBot.text(region)) : '';
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
  async function runCheck(key, spec, timeoutMs) {
    const field = $(spec.field);
    if (!field) throw new Error(`Could not find the ${spec.label} field on this page.`);

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
    const timeout = msg.checkTimeout || 600000;
    const results = [];

    for (const [key, spec] of Object.entries(CHECKS)) {
      if (results.length) await SnorkelBot.sleep(msg.betweenChecksMs || 2000);
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
  const FORM_TIMES = [
    { key: 'review', minutes: 45, label: 'review the initial task and determine its validity' },
    { key: 'rewrite', minutes: 120, label: 'complete the initial task rewrite only' },
    { key: 'additional', minutes: 20, label: 'complete the additional questions on the form' },
    { key: 'revisions', minutes: 185, label: 'complete all revisions' },
  ];

  /** Everything in this one gets ticked; it is a list of things to affirm. */
  const CONFIRM_ALL = 'confirm your task meets all the following requirements';

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

  async function fillRadio(field, value) {
    const wanted = SnorkelBot.normText(value).toLowerCase();
    const options = $$('button[role="radio"]', field);
    const hit =
      options.find((b) => SnorkelBot.normText(b.getAttribute('value') || '').toLowerCase() === wanted) ||
      options.find((b) => SnorkelBot.normText(SnorkelBot.text(b)).toLowerCase() === wanted);

    if (!hit) {
      return { ok: false, why: `no option "${value}" (have: ${options.map((b) => b.getAttribute('value')).join(', ')})` };
    }
    if (hit.getAttribute('aria-checked') !== 'true') {
      SnorkelBot.click(hit);
      await SnorkelBot.sleep(200);
    }
    return { ok: true };
  }

  /** Ticks the wanted options in a multi-select, leaving the rest alone. */
  async function fillMulti(field, values, { all = false } = {}) {
    const boxes = $$('[role="checkbox"], button[role="option"], [role="menuitemcheckbox"]', field);
    if (!boxes.length) return { ok: false, why: 'no options found' };

    const wanted = (values || []).map((v) => SnorkelBot.normText(v).toLowerCase());
    let ticked = 0;

    for (const box of boxes) {
      const label = SnorkelBot.normText(
        box.getAttribute('aria-label') || SnorkelBot.text(box) || box.getAttribute('value') || ''
      )
        .replace(/<[^>]*>/g, '')
        .toLowerCase();

      // Substring both ways: the stored answers are shortened versions of the
      // option text ("oracle" for "Oracle Solution"), and the option text is
      // sometimes a shortened version of the answer.
      const want = all || wanted.some((w) => label.includes(w) || w.includes(label));
      const checked = box.getAttribute('aria-checked') === 'true' || box.getAttribute('data-state') === 'checked';

      if (want && !checked) {
        SnorkelBot.click(box);
        ticked++;
        await SnorkelBot.sleep(150);
      }
    }
    return { ok: true, ticked, of: boxes.length };
  }

  /**
   * Writes the stored answers onto the form, and nothing else.
   *
   * Never ticks "Send to Reviewer" and never clicks Submit. The whole point is
   * that a person looks at this before it goes anywhere.
   */
  SnorkelBot.on('SUBMIT_FILL_FORM', async (msg) => {
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
          res.ok ? filled.push(`${spec.key} (${res.ticked} ticked)`) : skipped.push(`${spec.key} (${res.why})`);
        } else {
          const how = await fillText(field, String(value));
          how ? filled.push(`${spec.key} (${how})`) : skipped.push(`${spec.key} (no input in the field)`);
        }
      } catch (err) {
        skipped.push(`${spec.key} (${err.message})`);
      }
      await SnorkelBot.sleep(250);
    }

    // Every requirement gets affirmed. It is a checklist of things that must be
    // true, and the task has been through the platform's own checks by now.
    const confirmField = fieldByLabel(CONFIRM_ALL);
    if (confirmField) {
      const res = await fillMulti(confirmField, [], { all: true });
      filled.push(`confirmations (${res.ticked}/${res.of} ticked)`);
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
      const minutes = Number.isFinite(sent) && sent > 0 ? Math.round(sent) : time.minutes;

      setNativeValue(box, String(minutes));
      filled.push(`${time.label} = ${minutes}`);
      await SnorkelBot.sleep(200);
    }

    return { filled, skipped, filled_at: new Date().toISOString(), page_url: location.href };
  });

  /** The UID shown on this page, so the caller can confirm it is the right task. */
  SnorkelBot.on('SUBMIT_PAGE_UID', async () => {
    const badge = $$('*', document).find((el) => /^UID:/i.test(SnorkelBot.text(el)));
    const match = badge && /UID:\s*([0-9a-f-]{8,})/i.exec(SnorkelBot.text(badge));
    return { uid: match ? match[1] : null, page_url: location.href };
  });
})();
