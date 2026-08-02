/* Sentinel Submission Helper - reading the submission page.
 * Everything here is selector knowledge about the platform's form.
 */
(function () {
  'use strict';
  const STN = window.__STN__ || (window.__STN__ = {});
  if (STN.page) return;
  const U = STN.util;

  const SEL = {
    leftPanel: '[data-testid="document-review-left-panel"]',
    leftPanelFallback: '[data-testid="left"]',
    rightPanel: '[data-testid="right"]',
    section: '[data-testid^="section-"]',
    field: '[data-testid^="field-"]',
    staticChecks: '[data-testid="field-feedbackbutton-static_checks"]',
    sendToReviewer: '[data-testid="field-checkbox-send_to_reviewer"]',
    fixableZip: '[data-testid="field-output_file"]',
    unfixableZip: '[data-testid="field-s3FileUploader-c496d"]',
    downloadTask: '[data-testid^="field-s3fileuploader-download"]',
  };

  // The four Monaco panes btn2 copies, in the order the page shows them.
  const FEEDBACK_PANES = [
    { title: 'Difficulty Check', testid: 'field-difficulty_check_summary', label: 'Difficulty Check' },
    { title: 'Agentic Judge Quality Report', testid: 'field-code-rubric_panel_judge', label: 'Agentic Judge Quality Report' },
    { title: 'Oracle Check', testid: 'field-oracle_check_summary', label: 'Oracle Check' },
    { title: 'Quality Check', testid: 'field-quality_check_summary', label: 'Quality Check' },
  ];

  const VERDICT_TO_DOM = {
    'fixable': 'Fixable',
    'invalid': 'Invalid',
    'valid-as-is': 'Valid-as-is',
  };

  /* --------------------------------------------------------- form regions */

  function formRoot() {
    return document.querySelector(SEL.rightPanel) || document.body;
  }

  function fieldContainers() {
    return Array.prototype.slice.call(document.querySelectorAll(SEL.field));
  }

  // The question text the platform renders above a field.
  function fieldLabel(container) {
    if (!container) return '';
    const lab = container.querySelector('label[for]');
    if (lab) return U.normText(U.visibleText(lab));
    const testid = container.getAttribute('data-testid') || '';
    return U.normText(testid.replace(/^field-/, '').replace(/[-_]+/g, ' '));
  }

  function fieldByTestId(testid) {
    return document.querySelector('[data-testid="' + testid + '"]');
  }

  // Label driven lookup, which is what the answers JSON contract relies on.
  // Returns every container that matched exactly, or the single best guess.
  function findFields(label) {
    const all = fieldContainers();
    if (!all.length) return [];
    return U.bestMatches(label, all, fieldLabel);
  }

  function findField(label) {
    const hits = findFields(label);
    return hits.length ? hits[0] : null;
  }

  // When nothing matches, name the question the page came closest to, so a
  // reworded label is obvious rather than just missing.
  function closestLabel(label) {
    let best = null;
    let bestScore = -1;
    for (const c of fieldContainers()) {
      const t = fieldLabel(c);
      const a = U.normLabel(label).split(' ').filter(Boolean);
      const b = U.normLabel(t).split(' ').filter(Boolean);
      if (!a.length || !b.length) continue;
      const sb = new Set(b);
      let inter = 0;
      new Set(a).forEach((w) => { if (sb.has(w)) inter++; });
      const s = inter / new Set(a.concat(b)).size;
      if (s > bestScore) { bestScore = s; best = t; }
    }
    return bestScore >= 0.25 ? best : null;
  }

  /* ------------------------------------------------------- control typing */

  function realTextarea(container) {
    const list = container.querySelectorAll('textarea');
    for (const ta of list) {
      if (ta.classList.contains('ime-text-area')) continue;
      if (ta.getAttribute('aria-hidden') === 'true') continue;
      if (ta.readOnly) continue;
      return ta;
    }
    return null;
  }

  // Detected from the DOM, not from the JSON, because the answers guide types
  // Files Changed and the unfixable explanation as richtext while the platform
  // renders both as plain textareas.
  function detectControl(container) {
    if (!container) return null;
    if (container.querySelector('[contenteditable="true"]')) return 'richtext';
    if (container.querySelector('.monaco-editor')) return 'code';
    if (realTextarea(container)) return 'textarea';
    if (container.querySelector('input[type="number"]')) return 'number';
    if (container.querySelector('button[role="radio"]')) return 'radio';
    if (container.querySelector('[role="checkbox"]')) return 'checkbox_group';
    if (container.querySelector('input[type="file"]')) return 'file';
    if (container.querySelector('input[type="text"]')) return 'text';
    return null;
  }

  function radioButtons(container) {
    return Array.prototype.slice.call(container.querySelectorAll('button[role="radio"]'));
  }

  function radioValue(btn) {
    return btn.getAttribute('value') || '';
  }

  function radioText(btn) {
    const lab = btn.closest('label');
    if (lab) {
      // The label holds the radio dot plus the option text; the dot is empty.
      const box = lab.querySelector(':scope > div:last-child');
      return U.normText(U.visibleText(box || lab));
    }
    return U.normText(radioValue(btn));
  }

  function radioChecked(btn) {
    const aria = btn.getAttribute('aria-checked');
    if (aria != null) return aria === 'true';
    return btn.getAttribute('data-state') === 'checked';
  }

  function checkboxes(container) {
    return Array.prototype.slice.call(container.querySelectorAll('[role="checkbox"]'));
  }

  function checkboxText(box) {
    const t = U.normText(U.visibleText(box));
    if (t) return t;
    return U.normText(U.stripTags(box.getAttribute('aria-label') || ''));
  }

  function checkboxChecked(box) {
    return box.getAttribute('aria-checked') === 'true';
  }

  /* ------------------------------------------------------------- sections */

  function sections() {
    return Array.prototype.slice.call(document.querySelectorAll(SEL.section));
  }

  function sectionTrigger(section) {
    // Only the accordion headers, never the language comboboxes further down.
    return section.querySelector(':scope > div h3 > button[aria-expanded]');
  }

  // Radix unmounts collapsed accordion content, so nothing can be filled or
  // read until every section is open.
  async function expandAllSections() {
    let opened = 0;
    for (const s of sections()) {
      const trigger = sectionTrigger(s);
      if (!trigger) continue;
      const closed = s.getAttribute('data-state') === 'closed' ||
        trigger.getAttribute('aria-expanded') === 'false';
      if (!closed) continue;
      trigger.click();
      opened++;
      await U.sleep(150);
    }
    if (opened) await U.sleep(350);
    return opened;
  }

  /* --------------------------------------------------------- button targets */

  // The Static Checks field, by test id, then by its question text, then by
  // being a feedback button field that calls itself Static Checks.
  function feedbackButtonField() {
    const known = document.querySelector(SEL.staticChecks);
    if (known) return known;
    // no button test here: once the check has run the button is gone, and the
    // field is still the place to go
    const byLabel = findField('Static Checks');
    if (byLabel) return byLabel;
    for (const c of fieldContainers()) {
      const testid = c.getAttribute('data-testid') || '';
      if (!/^field-feedbackbutton-/i.test(testid)) continue;
      if (/static\s*checks/i.test(fieldLabel(c))) return c;
    }
    return null;
  }

  // Once the field is found its action button is the button, whatever the
  // platform is calling it today. Matching on the words alone missed it as
  // soon as the label changed.
  function checkFeedbackButton() {
    const field = feedbackButtonField();
    if (field) {
      // Only a button that says what it does. Taking whatever button happens
      // to be there would press Download once the check has run.
      const buttons = Array.prototype.slice.call(field.querySelectorAll('button'));
      const named = buttons.filter((b) => /check|run|verify/i.test(U.normText(U.visibleText(b))));
      if (named.length) return named[0];
    }
    const buttons = Array.prototype.slice.call(formRoot().querySelectorAll('button'));
    for (const b of buttons) {
      if (/check\s*feedback/i.test(U.normText(U.visibleText(b)))) return b;
    }
    return null;
  }

  // "Send to Reviewer (optional)", which sits in the Submission Feedback
  // section and so only exists on the Fixable path.
  function sendToReviewerField() {
    const known = document.querySelector(SEL.sendToReviewer);
    if (known) return known;
    const guess = findField('Send to Reviewer');
    if (guess && guess.querySelector('[role="checkbox"]')) return guess;
    return null;
  }

  // Once a file is attached the widget swaps the dropzone, and its hidden
  // file input, for a success box with Download and Remove buttons.
  function attachedFile(container) {
    if (!container) return null;
    const remove = container.querySelector(
      'button[title="Remove file"], button[aria-label="Remove file"]'
    );
    if (!remove) return null;
    const name = container.querySelector('.text-color-success');
    return {
      remove: remove,
      removable: !remove.disabled,
      name: name ? U.normText(U.visibleText(name)) : '',
    };
  }

  // Every uploader on this page except the read only task download at the top.
  function uploaderFields() {
    const out = [];
    const seen = new Set();
    const add = (c) => {
      if (c && !seen.has(c)) { seen.add(c); out.push(c); }
    };
    add(document.querySelector(SEL.fixableZip));
    add(document.querySelector(SEL.unfixableZip));
    for (const c of fieldContainers()) {
      const testid = c.getAttribute('data-testid') || '';
      if (/^field-s3fileuploader-download/i.test(testid)) continue;
      if (/^download sentinel/i.test(fieldLabel(c))) continue;
      if (c.querySelector('input[type="file"]') || attachedFile(c)) add(c);
    }
    return out;
  }

  // The zip uploader for the current path: the Fixable re-upload, or the
  // Not Fixable attempt upload. An uploader that is open for a new file wins
  // over one that is already holding a file.
  function taskUploadTarget() {
    const fields = uploaderFields();
    for (const c of fields) {
      const input = c.querySelector('input[type="file"]');
      if (input) {
        return {
          field: c, input: input, label: fieldLabel(c), attached: null,
          zone: input.parentElement || c,
        };
      }
    }
    for (const c of fields) {
      const att = attachedFile(c);
      if (att) {
        return {
          field: c, input: null, label: fieldLabel(c), attached: att,
          zone: att.remove.closest('.rounded-lg') || att.remove.parentElement || c,
        };
      }
    }
    return null;
  }

  // The element the form actually scrolls in, which is not the window: the
  // right hand panel has its own overflow.
  function formScroller() {
    const anchor = document.querySelector(SEL.field) || document.querySelector(SEL.rightPanel);
    let n = anchor && anchor.parentElement;
    while (n && n !== document.documentElement) {
      const s = window.getComputedStyle(n);
      if (/(auto|scroll|overlay)/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 4) return n;
      n = n.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  // Both copies of the verdict question, found by their radio values so a
  // relabelled question still resolves.
  function verdictRadioGroups() {
    const groups = [];
    const seen = new Set();
    const radios = document.querySelectorAll('button[role="radio"]');
    for (const r of radios) {
      const group = r.closest('[role="radiogroup"]');
      if (!group || seen.has(group)) continue;
      const values = radioButtons(group).map((b) => U.canonVerdict(radioValue(b)));
      const uniq = new Set(values.filter(Boolean));
      if (uniq.size >= 3 && uniq.has('fixable') && uniq.has('invalid') && uniq.has('valid-as-is')) {
        seen.add(group);
        groups.push(group);
      }
    }
    return groups;
  }

  function onSubmissionPage() {
    return !!(document.querySelector(SEL.field) || document.querySelector(SEL.leftPanel));
  }

  STN.page = {
    SEL, FEEDBACK_PANES, VERDICT_TO_DOM,
    formRoot, fieldContainers, fieldLabel, fieldByTestId, findFields, findField, closestLabel,
    detectControl, realTextarea,
    radioButtons, radioValue, radioText, radioChecked,
    checkboxes, checkboxText, checkboxChecked,
    sections, expandAllSections,
    feedbackButtonField, checkFeedbackButton, sendToReviewerField,
    attachedFile, uploaderFields, taskUploadTarget, formScroller, verdictRadioGroups,
    onSubmissionPage,
  };
})();
