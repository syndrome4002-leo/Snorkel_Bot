/*
 * A fake Snorkel review page with virtualised Monaco panes, for testing the
 * MAIN-world feedback reader without a browser.
 *
 * Fidelity that matters here:
 *   - only the lines inside the viewport exist in the DOM
 *   - `.view-line` style.top is the ABSOLUTE offset in the document
 *   - `.view-lines` style.height is the height of the WHOLE document
 *   - the editor moves on wheel events, not scrollTop
 *   - wrapped lines are taller than one line height
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const LINE_H = 19;
const VIEW_H = 200;

function makeDoc(lineCount, { wrapEvery = 5, wrapRows = 3 } = {}) {
  const lines = [];
  let top = 0;
  for (let i = 0; i < lineCount; i++) {
    const wraps = wrapEvery && i % wrapEvery === wrapEvery - 1;
    const rows = wraps ? wrapRows : 1;
    const text = wraps
      ? `L${String(i).padStart(4, '0')}: ` + 'a long wrapped sentence that runs on and on '.repeat(3).trim()
      : `L${String(i).padStart(4, '0')}: ordinary line of report text`;
    lines.push({ text, top, height: rows * LINE_H });
    top += rows * LINE_H;
  }
  return { lines, height: top };
}

function buildPage(panes) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const { document } = window;

  for (const pane of panes) {
    const field = document.createElement('div');
    field.setAttribute('data-testid', pane.testid);

    const editor = document.createElement('div');
    editor.className = 'monaco-editor';
    editor.setAttribute('data-uri', `inmemory://model/${pane.testid}`);

    const guard = document.createElement('div');
    guard.className = 'overflow-guard';
    Object.defineProperty(guard, 'clientHeight', { value: VIEW_H });

    const scrollable = document.createElement('div');
    scrollable.className = 'monaco-scrollable-element';

    const content = document.createElement('div');
    content.className = 'lines-content';

    const viewLines = document.createElement('div');
    viewLines.className = 'view-lines';
    // Monaco sets this to the height of the whole document, not the viewport.
    viewLines.style.height = `${pane.doc.height}px`;

    content.appendChild(viewLines);
    scrollable.appendChild(content);
    guard.appendChild(scrollable);
    editor.appendChild(guard);
    field.appendChild(editor);
    document.body.appendChild(field);

    let scrollTop = 0;
    const render = () => {
      const from = scrollTop;
      const to = scrollTop + VIEW_H;
      viewLines.textContent = '';
      for (const line of pane.doc.lines) {
        if (line.top + line.height <= from || line.top >= to) continue;
        const el = document.createElement('div');
        el.className = 'view-line';
        el.style.top = `${line.top}px`;
        el.style.height = `${line.height}px`;
        el.textContent = line.text;
        viewLines.appendChild(el);
      }
      pane.renders = (pane.renders || 0) + 1;
    };

    scrollable.addEventListener('wheel', (event) => {
      const max = Math.max(0, pane.doc.height - VIEW_H);
      const next = Math.min(max, Math.max(0, scrollTop + event.deltaY));
      if (next === scrollTop) return;
      scrollTop = next;
      render();
    });

    render();
    pane.scrollTopNow = () => scrollTop;
  }

  return dom;
}

function readFeedback(dom, source, timeoutMs = 120000) {
  const { window } = dom;
  return new Promise((resolve, reject) => {
    window.eval(source);
    const timer = setTimeout(() => reject(new Error('reader never answered')), timeoutMs);
    window.addEventListener('snorkelbot:feedback-ready', () => {
      clearTimeout(timer);
      const node = window.document.getElementById('__snorkelbot_feedback_result');
      resolve(JSON.parse(node.textContent));
    });
    window.document.documentElement.setAttribute('data-snorkelbot-feedback-request', 'tok');
    window.dispatchEvent(new window.Event('snorkelbot:read-feedback'));
  });
}

module.exports = { LINE_H, VIEW_H, makeDoc, buildPage, readFeedback, fs, path };
