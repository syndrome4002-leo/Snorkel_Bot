/* Sentinel Submission Helper - what each bar button does. */
(function () {
  'use strict';
  const STN = window.__STN__ || (window.__STN__ = {});
  if (STN.actions) return;
  const U = STN.util;
  const P = STN.page;

  const ui = () => STN.ui;

  /* ------------------------------------------------- D  copy task detail */

  async function detailCopy() {
    const text = STN.extract.taskDetailText();
    if (!text) {
      ui().toast('Could not find the task detail panel on this page.', 'error');
      return;
    }
    const ok = await U.copyToClipboard(text);
    if (ok) ui().toast('Task detail copied, ' + text.split('\n').length + ' lines.', 'ok');
    else ui().showText('Task detail', text, 'The browser blocked the copy. Take it from here.');
  }

  /* ---------------------------------------------------- F  copy feedback */

  async function feedbackCopy() {
    const busy = ui().progress('Reading the feedback panes…');
    let res;
    try {
      await P.expandAllSections();
      res = await STN.extract.feedbackText();
    } catch (e) {
      busy.close();
      ui().toast('Reading the feedback failed: ' + e.message, 'error');
      return;
    }
    busy.close();

    if (!res.found) {
      ui().toast('No feedback panes here. The Submission Feedback section only shows on the Fixable path.', 'error');
      return;
    }
    // Reading a long pane scrolls its editor, so land on Difficulty Check last.
    U.reveal(P.fieldByTestId(P.FEEDBACK_PANES[0].testid) || P.findField(P.FEEDBACK_PANES[0].label));
    const ok = await U.copyToClipboard(res.text);
    const asides = [];
    if (res.missing.length) asides.push('Missing: ' + res.missing.join(', ') + '.');
    if (res.truncated) {
      asides.push(res.truncated + ' pane(s) were too long to read in full. Open them and copy by hand.');
    }
    if (ok) {
      const what = (res.notes ? res.notes + ' note' + (res.notes === 1 ? '' : 's') + ' and ' : '') +
        res.panes + ' of 4 feedback panes';
      ui().toast(
        'Copied ' + what + '.' + (asides.length ? ' ' + asides.join(' ') : ''),
        asides.length ? 'warn' : 'ok'
      );
    } else {
      ui().showText('Submission feedback', res.text,
        'The browser blocked the copy, which happens when the read runs long. Take it from here.');
    }
  }

  /* -------------------------------------------------- A  answer autofill */

  function answerUpload() {
    ui().pickFile('.json,application/json', async (file) => {
      let raw;
      try {
        raw = await file.text();
      } catch (e) {
        ui().toast('Could not read that file: ' + e.message, 'error');
        return;
      }
      const busy = ui().progress('Reading ' + file.name + '…');
      let res;
      try {
        res = await STN.autofill.run(raw, (msg) => busy.update(msg));
      } catch (e) {
        busy.close();
        ui().toast(e.message, 'error');
        return;
      }
      busy.close();
      ui().showReport(res, file.name);
    });
  }

  /* ---------------------------------------------------- T  task uploader */

  function openFileInput(input) {
    if (typeof input.showPicker === 'function') {
      try { input.showPicker(); return true; } catch (e) { /* fall back to a click */ }
    }
    // The dropzone around the input opens the picker too, so keep our
    // synthetic click from bubbling into it and opening a second dialog.
    const stop = (e) => e.stopPropagation();
    input.addEventListener('click', stop, true);
    try { input.click(); } finally {
      setTimeout(() => input.removeEventListener('click', stop, true), 0);
    }
    return true;
  }

  function taskUpload() {
    const target = P.taskUploadTarget();
    if (!target) {
      P.expandAllSections().then(() => {
        const again = P.taskUploadTarget();
        if (again) ui().toast('The uploader was in a collapsed section. It is open now, press T again.', 'warn');
        else ui().toast('No task uploader on this page. Only the Fixable and Invalid paths have one.', 'error');
      });
      return;
    }
    U.reveal(target.zone || target.field);

    // With a file already on it the widget shows a success box instead of the
    // dropzone, so there is no input to open until that file is removed.
    if (!target.input) {
      const held = target.attached && target.attached.name ? target.attached.name : 'a file';
      ui().toast(
        'That uploader already holds ' + held + '. ' +
        (target.attached && target.attached.removable
          ? 'Press Remove file on it, then press T again.'
          : 'Its Remove button is disabled, so it cannot be replaced from here.'),
        'warn'
      );
      return;
    }

    openFileInput(target.input);
    ui().toast('Opened the picker for: ' + target.label, 'ok');
  }

  /* --------------------------------------------------- C  check feedback */

  function disabledHint(field) {
    if (!field) return '';
    const notes = field.querySelectorAll('.text-color-secondary, .text-color-tertiary');
    for (const n of notes) {
      const t = U.normText(U.visibleText(n));
      if (t) return t;
    }
    return '';
  }

  // Clear the flags an earlier version of this wrote, so nothing lingers.
  // Whether the check has run is the page's business, not something to
  // remember: a stored flag goes stale as soon as the platform offers the
  // run again, and then it blocks a check that genuinely needs doing.
  try {
    const stale = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.indexOf('stn-ext-static-checks-ran') === 0) stale.push(k);
    }
    stale.forEach((k) => localStorage.removeItem(k));
  } catch (e) { /* storage disabled */ }

  // Built around the Static Checks field rather than its button, because the
  // platform takes the button away once the check has run. Going there is
  // useful either way, so the scroll happens before anything is decided.
  async function checkFeedback() {
    let field = P.feedbackButtonField();
    if (!field) {
      await P.expandAllSections();
      field = P.feedbackButtonField();
    }
    if (!field) {
      const section = document.querySelector('[data-testid="section-Submission Feedback"]');
      if (section) {
        U.reveal(section);
        ui().toast('The Submission Feedback section is here but it has no Static Checks field.', 'error');
      } else {
        ui().toast('No Submission Feedback section on this page. It only shows on the Fixable path.', 'error');
      }
      return;
    }

    U.reveal(field);

    const found = P.checkFeedbackButton();
    const btn = found && field.contains(found) ? found : null;

    if (!btn) {
      // Same class as "already ticked": the check is done, nothing was needed.
      ui().toast('Static Checks has already run, so there is no button to press. Moved you to it.', 'info');
      return;
    }
    if (btn.disabled) {
      const hint = disabledHint(field);
      ui().toast('Check feedback is disabled. ' + (hint || 'Fill the required fields first.'), 'warn');
      return;
    }

    // The button is there and live, so the platform is offering the run.
    btn.click();
    ui().toast('Check feedback clicked.', 'ok');
    // Pressing it re-renders the section, and a smooth scroll whose target
    // gets replaced mid animation simply stops. Land it again once React has
    // settled, against whatever node is there by then.
    await U.sleep(350);
    U.reveal(P.feedbackButtonField() || field);
  }

  /* ------------------------------------------------- R  send to reviewer */

  async function sendToReviewer() {
    let field = P.sendToReviewerField();
    if (!field) {
      await P.expandAllSections();
      field = P.sendToReviewerField();
    }
    if (!field) {
      ui().toast('No "Send to Reviewer" field here. It sits in Submission Feedback, which only shows on the Fixable path.', 'error');
      return;
    }
    U.reveal(field);

    const boxes = P.checkboxes(field);
    if (!boxes.length) {
      ui().toast('Found the Send to Reviewer field but no checkbox inside it.', 'error');
      return;
    }
    if (P.checkboxChecked(boxes[0])) {
      // What you wanted is already true and nothing was done, which is not a
      // success and not a problem. Neutral.
      ui().toast('Send to reviewer is already ticked.', 'info');
      return;
    }
    const res = await STN.set.setCheckboxAt(field, 0, true);
    // ticking re-renders the row, which can cut the scroll short the same way
    U.reveal(P.sendToReviewerField() || field);
    if (res.ok) ui().toast('Send to reviewer ticked.', 'ok');
    else ui().toast('Could not tick Send to reviewer: ' + res.reason, 'warn');
  }

  /* ------------------------------------------------ arrows  jump the form */

  function jump(toBottom) {
    const el = P.formScroller();
    if (!el) return;
    const top = toBottom ? el.scrollHeight : 0;
    try { el.scrollTo({ top: top, behavior: 'smooth' }); }
    catch (e) { el.scrollTop = top; }
  }

  function scrollToTop() { jump(false); }
  function scrollToBottom() { jump(true); }

  STN.actions = {
    scrollToTop, detailCopy, feedbackCopy, answerUpload, taskUpload,
    checkFeedback, sendToReviewer, scrollToBottom,
  };
})();
