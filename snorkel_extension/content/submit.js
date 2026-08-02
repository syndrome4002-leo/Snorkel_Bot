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

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const buttonsIn = (root) => $$('button', root);
  const findButton = (root, re) =>
    buttonsIn(root).find((b) => re.test(SnorkelBot.normText(SnorkelBot.text(b))));

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
      steps.push('removed the existing file');
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

  /** The UID shown on this page, so the caller can confirm it is the right task. */
  SnorkelBot.on('SUBMIT_PAGE_UID', async () => {
    const badge = $$('*', document).find((el) => /^UID:/i.test(SnorkelBot.text(el)));
    const match = badge && /UID:\s*([0-9a-f-]{8,})/i.exec(SnorkelBot.text(badge));
    return { uid: match ? match[1] : null, page_url: location.href };
  });
})();
