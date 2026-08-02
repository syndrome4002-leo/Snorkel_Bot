/* Sentinel Submission Helper - reading the Task Notes sidebar.
 *
 * Reviewer Feedback and Automated feedback are cards there: a header button
 * carrying the title and a timestamp, plus a collapsible region holding the
 * prose. Both go into what the F button copies, ahead of the check panes.
 */
(function () {
  'use strict';
  const STN = window.__STN__ || (window.__STN__ = {});
  if (STN.notes) return;
  const U = STN.util;

  const PANEL = '[data-testid="collapsible-sidebar-panel"]';

  // The notes F copies, in the order it copies them.
  const WANTED = ['Reviewer Feedback', 'Automated feedback'];

  function isHeader(el) {
    return el.tagName === 'BUTTON' &&
      !!el.getAttribute('aria-controls') &&
      el.getAttribute('aria-expanded') != null &&
      !!el.querySelector(':scope > div');
  }

  function noteHeaders() {
    const panel = document.querySelector(PANEL);
    if (!panel) return [];
    return Array.prototype.slice.call(panel.querySelectorAll('button[aria-controls]')).filter(isHeader);
  }

  function noteTitle(header) {
    const first = header.querySelector(':scope > div');
    return first ? U.normText(U.visibleText(first)) : '';
  }

  // "Automated feedback" on the page, "Automated Feedback" in the copy, to
  // match the heading style the other sections use.
  function titleCase(s) {
    return String(s).replace(/\b[a-z]/g, (c) => c.toUpperCase());
  }

  function noteBody(header) {
    const id = header.getAttribute('aria-controls');
    const region = id ? document.getElementById(id) : null;
    if (!region) return '';
    // The prose only. The controls under it are not part of the note.
    const prose = region.querySelectorAll('.whitespace-pre-line, .whitespace-pre-wrap');
    if (prose.length) {
      return Array.prototype.map.call(prose, (n) => U.cleanBlock(U.visibleText(n)))
        .filter(Boolean)
        .join('\n\n');
    }
    const grouped = region.querySelector('.space-y-12');
    return U.cleanBlock(U.visibleText(grouped || region));
  }

  // A collapsed card keeps no body in the DOM, so open the ones we are about
  // to read, the same way the form's own sections get opened.
  async function expandAll() {
    let opened = 0;
    for (const header of noteHeaders()) {
      if (header.getAttribute('aria-expanded') !== 'false') continue;
      if (!isWanted(noteTitle(header))) continue;
      header.click();
      opened++;
      await U.sleep(120);
    }
    if (opened) await U.sleep(200);
    return opened;
  }

  function isWanted(title) {
    const t = U.normLabel(title);
    return WANTED.some((w) => U.normLabel(w) === t);
  }

  // [{ title, body }] for the notes that are actually on the page, in the
  // order WANTED lists them. A note that is not there contributes nothing,
  // heading included.
  function sections() {
    const headers = noteHeaders();
    const out = [];
    for (const wanted of WANTED) {
      for (const header of headers) {
        if (U.normLabel(noteTitle(header)) !== U.normLabel(wanted)) continue;
        const body = noteBody(header);
        if (!body) continue;
        out.push({ title: titleCase(noteTitle(header)), body: body });
      }
    }
    return out;
  }

  STN.notes = { noteHeaders, noteTitle, noteBody, sections, expandAll, WANTED };
})();
