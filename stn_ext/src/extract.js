/* Sentinel Submission Helper - pulling text back out of the page.
 * Two jobs: the task detail panel on the left, and the four Monaco panes in
 * the Submission Feedback section.
 */
(function () {
  'use strict';
  const STN = window.__STN__ || (window.__STN__ = {});
  if (STN.extract) return;
  const U = STN.util;
  const P = STN.page;

  /* ------------------------------------------------------- task detail */

  // The outermost white-space: pre-wrap nodes, which is where the platform
  // parks a value that has real line breaks, such as the metadata TOML.
  function preWrapNodes(el) {
    const nodes = Array.prototype.slice.call(el.querySelectorAll('[style*="pre-wrap"]'));
    return nodes.filter((n) => {
      const anc = n.parentElement && n.parentElement.closest('[style*="pre-wrap"]');
      return !anc || !el.contains(anc);
    });
  }

  function detailValue(el) {
    const list = el.querySelector('ol, ul');
    if (list) {
      const ordered = list.tagName === 'OL';
      const items = Array.prototype.slice.call(list.children).filter((n) => n.tagName === 'LI');
      return items
        .map((li, i) => (ordered ? (i + 1) + '. ' : '- ') + U.normText(U.visibleText(li)))
        .join('\n');
    }
    // Read the value node itself rather than its wrapper, so no layout
    // indentation leaks into the first line.
    const pre = preWrapNodes(el);
    if (pre.length) {
      return U.cleanBlock(pre.map((n) => String(n.textContent == null ? '' : n.textContent)).join('\n'));
    }
    return U.cleanBlock(U.visibleText(el));
  }

  // Heading + value per block, blocks separated by a blank line. The metadata
  // block is white-space: pre-wrap on the page, so innerText keeps its TOML
  // line breaks and indentation.
  function taskDetailText() {
    const panel = document.querySelector(P.SEL.leftPanel) || document.querySelector(P.SEL.leftPanelFallback);
    if (!panel) return null;
    const blocks = [];
    const heads = panel.querySelectorAll('h3');
    for (const head of heads) {
      const title = U.normText(U.visibleText(head));
      if (!title) continue;
      let valueEl = head.nextElementSibling;
      if (!valueEl && head.parentElement) {
        valueEl = head.parentElement.querySelector(':scope > div');
      }
      const body = valueEl ? detailValue(valueEl) : '';
      blocks.push(body ? title + '\n' + body : title);
    }
    if (!blocks.length) {
      const whole = U.cleanBlock(U.visibleText(panel));
      return whole || null;
    }
    return blocks.join('\n\n');
  }

  /* ----------------------------------------------------- monaco reading */

  function lineHeight(edEl) {
    const vl = edEl.querySelector('.view-lines .view-line');
    const v = vl ? parseFloat(vl.style.height) : 0;
    return v && v > 0 ? v : 19;
  }

  function collectLines(host, lh, map) {
    const lines = host.querySelectorAll('.view-line');
    for (const vl of lines) {
      const top = parseFloat(vl.style.top || '0') || 0;
      const idx = Math.round(top / lh);
      map.set(idx, String(vl.textContent == null ? '' : vl.textContent).replace(/\u00a0/g, ' '));
    }
  }

  function assemble(map) {
    if (!map.size) return '';
    const max = Math.max.apply(null, Array.from(map.keys()));
    const out = [];
    for (let i = 0; i <= max; i++) out.push(map.has(i) ? map.get(i) : '');
    return out.join('\n').replace(/\s+$/, '');
  }

  // The bundler does not always park Monaco on window.monaco, so look for any
  // global that quacks like it. Worked out once and remembered.
  let monacoCache;
  function monacoApi() {
    if (monacoCache !== undefined) return monacoCache;
    const quacks = (m) => !!(m && m.editor &&
      (typeof m.editor.getModels === 'function' || typeof m.editor.getEditors === 'function'));
    monacoCache = null;
    if (quacks(window.monaco)) { monacoCache = window.monaco; return monacoCache; }
    try {
      for (const k of Object.getOwnPropertyNames(window)) {
        if (/^\d+$/.test(k) || k === 'monaco' || k === 'window' || k === 'self' ||
          k === 'top' || k === 'parent' || k === 'frames' || k === 'document') continue;
        let v = null;
        try { v = window[k]; } catch (e) { continue; }
        if (v && typeof v === 'object' && quacks(v)) { monacoCache = v; break; }
      }
    } catch (e) { /* nothing that looks like Monaco */ }
    return monacoCache;
  }

  // 1. the Monaco API, when the app exposes it anywhere reachable
  function valueFromMonacoApi(edEl) {
    const m = monacoApi();
    if (!m || !m.editor) return null;
    try {
      if (typeof m.editor.getEditors === 'function') {
        for (const ed of m.editor.getEditors()) {
          const dom = typeof ed.getDomNode === 'function' ? ed.getDomNode() : null;
          if (dom && (dom === edEl || edEl.contains(dom) || dom.contains(edEl))) {
            const model = typeof ed.getModel === 'function' ? ed.getModel() : null;
            if (model && typeof model.getValue === 'function') return model.getValue();
          }
        }
      }
    } catch (e) { /* fall through */ }
    try {
      const uri = edEl.getAttribute('data-uri');
      if (uri && typeof m.editor.getModels === 'function') {
        for (const model of m.editor.getModels()) {
          if (String(model.uri) === uri) return model.getValue();
        }
      }
    } catch (e) { /* fall through */ }
    return null;
  }

  // 2. the string the React wrapper was handed. Named props first, then any
  // prop that reads like a document rather than a setting, because a custom
  // wrapper may call it something else entirely.
  const CONTENT_KEYS = ['value', 'defaultValue', 'code', 'content', 'text', 'summary', 'body'];
  const NOT_CONTENT = /^(class|className|id|key|style|theme|language|defaultLanguage|path|defaultPath|uri|type|name|label|title|placeholder|role|href|src|width|height|dir|lang|testid|data-testid)$/;

  function looksLikeDocument(k, v) {
    if (typeof v !== 'string' || !v.trim()) return false;
    if (NOT_CONTENT.test(k)) return false;
    return v.indexOf('\n') >= 0 || v.length >= 40;
  }

  function valueFromReact(edEl) {
    const named = U.fiberFindUp(edEl, (props) => {
      for (const k of CONTENT_KEYS) {
        const v = props[k];
        if (typeof v === 'string' && v.trim()) return v;
      }
      return null;
    }, 30);
    if (named) return named;
    return U.fiberFindUp(edEl, (props) => {
      for (const k of Object.keys(props)) {
        if (looksLikeDocument(k, props[k])) return props[k];
      }
      return null;
    }, 30);
  }

  function isScrollable(edEl) {
    const sb = edEl.querySelector('.monaco-scrollable-element > .scrollbar.vertical');
    if (!sb) return false;
    const slider = sb.querySelector('.slider');
    if (!slider) return false;
    const sbH = parseFloat(sb.style.height) || sb.getBoundingClientRect().height;
    const slH = parseFloat(slider.style.height) || slider.getBoundingClientRect().height;
    return sbH > 4 && slH > 0 && slH < sbH - 2;
  }

  function now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  // 3. Monaco only renders the lines you can see, so walk the viewport down
  //    and stitch the rendered lines together by their absolute position.
  //    This is the slow route and runs under a deadline, because the copy
  //    should land while the click that asked for it is still warm.
  async function valueByScrolling(edEl, budgetMs) {
    const deadline = now() + (budgetMs || 2500);
    const target = edEl.querySelector('.monaco-scrollable-element') ||
      edEl.querySelector('.overflow-guard') || edEl;
    const host = edEl.querySelector('.view-lines');
    if (!host) return '';
    const lh = lineHeight(edEl);
    const viewH = parseFloat(host.style.height) || edEl.getBoundingClientRect().height || 150;
    const step = Math.max(lh, viewH - lh * 2);
    const map = new Map();
    const wheel = (dy) => {
      target.dispatchEvent(new WheelEvent('wheel', {
        deltaY: dy, deltaX: 0, deltaMode: 0, bubbles: true, cancelable: true,
      }));
    };

    for (let i = 0; i < 80; i++) wheel(-4000);
    await U.raf();
    await U.sleep(8);

    let lastMax = -1;
    let stagnant = 0;
    let ranOut = false;
    for (let i = 0; i < 400 && stagnant < 3; i++) {
      if (now() > deadline) { ranOut = true; break; }
      collectLines(host, lh, map);
      const mx = map.size ? Math.max.apply(null, Array.from(map.keys())) : -1;
      if (mx <= lastMax) stagnant++;
      else { stagnant = 0; lastMax = mx; }
      wheel(step);
      await U.raf();
      await U.sleep(4);
    }
    collectLines(host, lh, map);
    for (let i = 0; i < 200; i++) wheel(-4000);
    await U.raf();
    return { text: assemble(map), truncated: ranOut };
  }

  async function readCodeField(container, budgetMs) {
    const edEl = container.querySelector('.monaco-editor[data-uri]') || container.querySelector('.monaco-editor');
    if (!edEl) {
      const ta = P.realTextarea(container);
      if (ta) return { text: ta.value, how: 'textarea' };
      const pre = container.querySelector('pre, code');
      if (pre) return { text: U.visibleText(pre), how: 'pre' };
      return { text: '', how: 'none' };
    }

    let v = valueFromMonacoApi(edEl);
    if (v != null && v.trim()) return { text: v, how: 'monaco model' };

    v = valueFromReact(edEl);
    if (v != null && v.trim()) return { text: v, how: 'react props' };

    const visible = assemble((function () {
      const host = edEl.querySelector('.view-lines');
      const map = new Map();
      if (host) collectLines(host, lineHeight(edEl), map);
      return map;
    })());

    if (!isScrollable(edEl)) return { text: visible, how: 'rendered lines' };

    // Budget already spent by earlier panes: take what is on screen and say so
    // rather than making the click wait any longer.
    if (budgetMs != null && budgetMs <= 0) {
      return { text: visible, how: 'rendered lines, out of time', truncated: true };
    }

    const started = now();
    const stitched = await valueByScrolling(edEl, budgetMs);
    const ms = Math.round(now() - started);
    if (stitched.text.length < visible.length) {
      return { text: visible, how: 'rendered lines' };
    }
    return {
      text: stitched.text,
      how: 'scrolled lines in ' + ms + 'ms',
      slow: true,
      truncated: stitched.truncated,
    };
  }

  // The task's own name, from the left panel, so a copied report says which
  // task it belongs to.
  function originalDirectoryName() {
    const panel = document.querySelector(P.SEL.leftPanel) || document.querySelector(P.SEL.leftPanelFallback);
    if (!panel) return '';
    const heads = panel.querySelectorAll('h3');
    for (const head of heads) {
      if (U.normLabel(U.visibleText(head)) !== 'original directory name') continue;
      let valueEl = head.nextElementSibling;
      if (!valueEl && head.parentElement) valueEl = head.parentElement.querySelector(':scope > div');
      return valueEl ? U.normText(detailValue(valueEl)) : '';
    }
    return '';
  }

  const MARKER = U.MARKER;
  // one blank line under a heading, five between one pane and the next
  const HEADING_GAP = '\n\n';
  const PANE_GAP = '\n\n\n\n\n\n';

  function paneHeading(title) {
    return MARKER + ' ' + title + ' ' + MARKER;
  }

  // Everything F copies: the Task Notes cards first, in the order the notes
  // module lists them, then the four check panes. A note that is not on the
  // page contributes nothing at all, heading included. The panes share one
  // time budget, so four slow ones cannot add up to a wait.
  async function feedbackText(budgetMs) {
    const parts = [];
    const missing = [];
    const how = [];
    let slow = 0;
    let truncated = 0;
    let notes = 0;
    let left = budgetMs || 3000;

    if (STN.notes) {
      try {
        await STN.notes.expandAll();
        for (const note of STN.notes.sections()) {
          parts.push(paneHeading(note.title) + HEADING_GAP + note.body);
          how.push(note.title + ': task notes');
          notes++;
        }
      } catch (e) { /* the sidebar is not always there */ }
    }

    for (const pane of P.FEEDBACK_PANES) {
      let container = P.fieldByTestId(pane.testid);
      if (!container) {
        const guess = P.findField(pane.label);
        if (guess && (guess.querySelector('.monaco-editor') || P.realTextarea(guess))) container = guess;
      }
      if (!container) { missing.push(pane.title); continue; }

      const started = now();
      const res = await readCodeField(container, left);
      left -= now() - started;
      if (res.slow) slow++;
      if (res.truncated) truncated++;

      const body = res.text && res.text.trim() ? U.cleanBlock(res.text) : '(no result yet)';
      parts.push(paneHeading(pane.title) + HEADING_GAP + body);
      how.push(pane.title + ': ' + res.how);
    }

    const dir = originalDirectoryName();
    const body = parts.join(PANE_GAP);
    return {
      text: dir ? dir + PANE_GAP + body : body,
      directory: dir,
      missing: missing,
      notes: notes,
      panes: parts.length - notes,
      found: parts.length,
      how: how,
      slow: slow,
      truncated: truncated,
    };
  }

  STN.extract = { taskDetailText, originalDirectoryName, readCodeField, feedbackText };
})();
