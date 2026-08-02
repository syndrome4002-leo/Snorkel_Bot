/*
 * feedback-main.js — the F button, mirrored, running in the page's MAIN world.
 *
 * This is a port of stn_ext's feedback copy: util.js + page.js + notes.js +
 * extract.js, reduced to the parts the F button uses.
 *
 * WHY THE WHOLE THING LIVES HERE
 * ------------------------------
 * stn_ext runs its entire content script with "world": "MAIN", which is what
 * lets it reach window.monaco and the React fibers. Earlier attempts here kept
 * the extraction in the isolated world and bridged only the awkward bits across
 * — and it kept failing, because almost every part of this needs page-world
 * access, not just one part. So the whole job runs here and the isolated side
 * asks for a finished answer.
 *
 * The isolated side cannot simply be given MAIN world: it needs chrome.* APIs
 * (messaging, downloads, storage), which only exist in an isolated world. Hence
 * two worlds, with the DOM as the channel between them.
 *
 * WHAT IT COLLECTS, in the order the F button uses:
 *   1. Task Notes sidebar — "Reviewer Feedback", "Automated feedback"
 *   2. the four check panes — Difficulty / Agentic Judge / Oracle / Quality
 */

(function () {
  const REQUEST_ATTR = 'data-snorkelbot-feedback-request';
  const RESULT_ID = '__snorkelbot_feedback_result';

  // ------------------------------------------------------------- util ----

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /*
   * How long to wait after poking the page.
   *
   * Radix animates a section open and React mounts its fields afterwards, so
   * clicking and reading in the same tick reads a section that is technically
   * open but still empty. These are the original stn_ext numbers roughly
   * doubled — it copies on a keypress while you watch, this runs unattended and
   * can afford to be patient.
   */
  const PACE = {
    afterSectionClick: 300,
    afterAllSections: 900,
    afterNoteClick: 250,
    afterAllNotes: 600,
    betweenPanes: 400,
  };
  const raf = () => new Promise((r) => requestAnimationFrame(() => r()));

  const visibleText = (el) => (!el ? '' : String(el.innerText != null ? el.innerText : el.textContent || ''));

  function normText(s) {
    return String(s == null ? '' : s)
      .replace(/ /g, ' ')
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[–—]/g, '-')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normLabel(s) {
    return normText(s)
      .toLowerCase()
      .replace(/^\[[^\]]*\]\s*/, '')
      .replace(/^\([^)]*\)\s*/, '')
      .replace(/\s*\(optional\)\s*$/, '')
      .replace(/[\s:;.,]+$/, '')
      .trim();
  }

  function cleanBlock(s) {
    return String(s == null ? '' : s)
      .replace(/\r\n?/g, '\n')
      .replace(/ /g, ' ')
      .split('\n')
      .map((l) => l.replace(/[ \t]+$/, ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\n+/, '')
      .replace(/\s+$/, '');
  }

  // ------------------------------------------------------------- page ----

  const SECTION_SEL = '[data-testid^="section-"]';

  const FEEDBACK_PANES = [
    { title: 'Difficulty Check', testid: 'field-difficulty_check_summary' },
    { title: 'Agentic Judge Quality Report', testid: 'field-code-rubric_panel_judge' },
    { title: 'Oracle Check', testid: 'field-oracle_check_summary' },
    { title: 'Quality Check', testid: 'field-quality_check_summary' },
  ];

  const fieldByTestId = (testid) => document.querySelector(`[data-testid="${testid}"]`);

  /** Only the accordion headers — never the comboboxes further down the form. */
  const sectionTrigger = (section) => section.querySelector(':scope > div h3 > button[aria-expanded]');

  /**
   * The form is a Radix accordion and UNMOUNTS the contents of a closed
   * section, so a shut section means the panes are absent, not merely hidden.
   */
  async function expandAllSections() {
    let opened = 0;
    for (const section of document.querySelectorAll(SECTION_SEL)) {
      const trigger = sectionTrigger(section);
      if (!trigger) continue;
      const closed =
        section.getAttribute('data-state') === 'closed' ||
        trigger.getAttribute('aria-expanded') === 'false';
      if (!closed) continue;
      trigger.click();
      opened++;
      await sleep(PACE.afterSectionClick);
    }
    if (opened) await sleep(PACE.afterAllSections);
    return opened;
  }

  function realTextarea(container) {
    for (const ta of container.querySelectorAll('textarea')) {
      if (ta.classList.contains('ime-text-area')) continue;
      if (ta.getAttribute('aria-hidden') === 'true') continue;
      if (ta.readOnly) continue;
      return ta;
    }
    return null;
  }

  // ------------------------------------------------------------ notes ----

  const NOTES_PANEL = '[data-testid="collapsible-sidebar-panel"]';
  const WANTED_NOTES = ['Reviewer Feedback', 'Automated feedback'];

  const isNoteHeader = (el) =>
    el.tagName === 'BUTTON' &&
    !!el.getAttribute('aria-controls') &&
    el.getAttribute('aria-expanded') != null &&
    !!el.querySelector(':scope > div');

  function noteHeaders() {
    const panel = document.querySelector(NOTES_PANEL);
    if (!panel) return [];
    return Array.from(panel.querySelectorAll('button[aria-controls]')).filter(isNoteHeader);
  }

  function noteTitle(header) {
    const first = header.querySelector(':scope > div');
    return first ? normText(visibleText(first)) : '';
  }

  const isWantedNote = (title) => WANTED_NOTES.some((w) => normLabel(w) === normLabel(title));

  function noteBody(header) {
    const id = header.getAttribute('aria-controls');
    const region = id ? document.getElementById(id) : null;
    if (!region) return '';
    const prose = region.querySelectorAll('.whitespace-pre-line, .whitespace-pre-wrap');
    if (prose.length) {
      return Array.from(prose)
        .map((n) => cleanBlock(visibleText(n)))
        .filter(Boolean)
        .join('\n\n');
    }
    const grouped = region.querySelector('.space-y-12');
    return cleanBlock(visibleText(grouped || region));
  }

  /** A collapsed card keeps no body in the DOM; open the ones about to be read. */
  async function expandNotes() {
    let opened = 0;
    for (const header of noteHeaders()) {
      if (header.getAttribute('aria-expanded') !== 'false') continue;
      if (!isWantedNote(noteTitle(header))) continue;
      header.click();
      opened++;
      await sleep(PACE.afterNoteClick);
    }
    if (opened) await sleep(PACE.afterAllNotes);
    return opened;
  }

  function noteSections() {
    const headers = noteHeaders();
    const out = [];
    for (const wanted of WANTED_NOTES) {
      for (const header of headers) {
        if (normLabel(noteTitle(header)) !== normLabel(wanted)) continue;
        const body = noteBody(header);
        if (!body) continue;
        out.push({ title: normText(noteTitle(header)), body });
      }
    }
    return out;
  }

  // ---------------------------------------------------------- monaco ----

  const CONTENT_KEYS = ['value', 'defaultValue', 'code', 'content', 'text', 'summary', 'body'];
  const NOT_CONTENT =
    /^(class|className|id|key|style|theme|language|defaultLanguage|path|defaultPath|uri|type|name|label|title|placeholder|role|href|src|width|height|dir|lang|testid|data-testid)$/;

  let monacoCache;
  const quacks = (m) =>
    !!(m && m.editor && (typeof m.editor.getModels === 'function' || typeof m.editor.getEditors === 'function'));

  function monacoApi() {
    if (monacoCache !== undefined) return monacoCache;
    monacoCache = null;
    if (quacks(window.monaco)) return (monacoCache = window.monaco);
    try {
      for (const k of Object.getOwnPropertyNames(window)) {
        if (/^\d+$/.test(k)) continue;
        if (['monaco', 'window', 'self', 'top', 'parent', 'frames', 'document'].includes(k)) continue;
        let v = null;
        try {
          v = window[k];
        } catch {
          continue;
        }
        if (v && typeof v === 'object' && quacks(v)) {
          monacoCache = v;
          break;
        }
      }
    } catch {
      /* nothing that looks like Monaco */
    }
    return monacoCache;
  }

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
    } catch {
      /* fall through */
    }
    try {
      const uri = edEl.getAttribute('data-uri');
      if (uri && typeof m.editor.getModels === 'function') {
        for (const model of m.editor.getModels()) {
          if (String(model.uri) === uri) return model.getValue();
        }
      }
    } catch {
      /* fall through */
    }
    return null;
  }

  function reactFiber(node) {
    if (!node) return null;
    for (const k in node) {
      if (k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')) return node[k];
    }
    return null;
  }

  /** Upwards, not downwards: React keeps the value on an ancestor component. */
  function fiberFindUp(node, pick, maxUp = 30) {
    let fiber = reactFiber(node);
    let left = maxUp;
    while (fiber && left-- > 0) {
      const props = fiber.memoizedProps || fiber.pendingProps;
      if (props) {
        let got = null;
        try {
          got = pick(props);
        } catch {
          got = null;
        }
        if (got != null) return got;
      }
      fiber = fiber.return;
    }
    return null;
  }

  const looksLikeDocument = (k, v) =>
    typeof v === 'string' && !!v.trim() && !NOT_CONTENT.test(k) && (v.indexOf('\n') >= 0 || v.length >= 40);

  function valueFromReact(edEl) {
    const named = fiberFindUp(edEl, (props) => {
      for (const k of CONTENT_KEYS) {
        const v = props[k];
        if (typeof v === 'string' && v.trim()) return v;
      }
      return null;
    });
    if (named) return named;
    return fiberFindUp(edEl, (props) => {
      for (const k of Object.keys(props)) if (looksLikeDocument(k, props[k])) return props[k];
      return null;
    });
  }

  const lineHeight = (edEl) => {
    const vl = edEl.querySelector('.view-lines .view-line');
    const v = vl ? parseFloat(vl.style.height) : 0;
    return v && v > 0 ? v : 19;
  };

  function collectLines(host, lh, map) {
    for (const vl of host.querySelectorAll('.view-line')) {
      const top = parseFloat(vl.style.top || '0') || 0;
      map.set(Math.round(top / lh), String(vl.textContent == null ? '' : vl.textContent).replace(/ /g, ' '));
    }
  }

  function assemble(map) {
    if (!map.size) return '';
    const max = Math.max.apply(null, Array.from(map.keys()));
    const out = [];
    for (let i = 0; i <= max; i++) out.push(map.has(i) ? map.get(i) : '');
    return out.join('\n').replace(/\s+$/, '');
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

  /** Monaco virtualises scrolling and reacts to WHEEL events, not scrollTop. */
  async function valueByScrolling(edEl, budgetMs) {
    const deadline = Date.now() + (budgetMs || 2500);
    const target =
      edEl.querySelector('.monaco-scrollable-element') || edEl.querySelector('.overflow-guard') || edEl;
    const host = edEl.querySelector('.view-lines');
    if (!host) return { text: '', truncated: false };

    const lh = lineHeight(edEl);
    const viewH = parseFloat(host.style.height) || edEl.getBoundingClientRect().height || 150;
    const step = Math.max(lh, viewH - lh * 2);
    const map = new Map();
    const wheel = (dy) =>
      target.dispatchEvent(
        new WheelEvent('wheel', { deltaY: dy, deltaX: 0, deltaMode: 0, bubbles: true, cancelable: true })
      );

    for (let i = 0; i < 80; i++) wheel(-4000);
    await raf();
    await sleep(8);

    let lastMax = -1;
    let stagnant = 0;
    let ranOut = false;
    for (let i = 0; i < 400 && stagnant < 3; i++) {
      if (Date.now() > deadline) {
        ranOut = true;
        break;
      }
      collectLines(host, lh, map);
      const mx = map.size ? Math.max.apply(null, Array.from(map.keys())) : -1;
      if (mx <= lastMax) stagnant++;
      else {
        stagnant = 0;
        lastMax = mx;
      }
      wheel(step);
      await raf();
      await sleep(4);
    }
    collectLines(host, lh, map);
    for (let i = 0; i < 200; i++) wheel(-4000);
    await raf();
    return { text: assemble(map), truncated: ranOut };
  }

  async function readCodeField(container, budgetMs) {
    const edEl =
      container.querySelector('.monaco-editor[data-uri]') || container.querySelector('.monaco-editor');
    if (!edEl) {
      const ta = realTextarea(container);
      if (ta) return { text: ta.value, how: 'textarea' };
      const pre = container.querySelector('pre, code');
      if (pre) return { text: visibleText(pre), how: 'pre' };
      return { text: '', how: 'none' };
    }

    let v = valueFromMonacoApi(edEl);
    if (v != null && v.trim()) return { text: v, how: 'monaco model' };

    v = valueFromReact(edEl);
    if (v != null && v.trim()) return { text: v, how: 'react props' };

    const map = new Map();
    const host = edEl.querySelector('.view-lines');
    if (host) collectLines(host, lineHeight(edEl), map);
    const visible = assemble(map);

    if (!isScrollable(edEl)) return { text: visible, how: 'rendered lines' };
    if (budgetMs != null && budgetMs <= 0) {
      return { text: visible, how: 'rendered lines, out of time', truncated: true };
    }

    const started = Date.now();
    const stitched = await valueByScrolling(edEl, budgetMs);
    const ms = Date.now() - started;
    if (stitched.text.length < visible.length) return { text: visible, how: 'rendered lines' };
    return { text: stitched.text, how: `scrolled lines in ${ms}ms`, truncated: stitched.truncated };
  }

  // ------------------------------------------------------- the F button ----

  async function collectFeedback(budgetMs) {
    const notes = [];
    const checks = [];
    const missing = [];
    let left = budgetMs || 12000;

    const openedSections = await expandAllSections();

    try {
      const openedNotes = await expandNotes();
      for (const note of noteSections()) notes.push(note);
      var noteExpansion = openedNotes;
    } catch {
      var noteExpansion = 0; // the sidebar is not always there
    }

    for (const pane of FEEDBACK_PANES) {
      const container = fieldByTestId(pane.testid);
      if (!container) {
        missing.push(pane.testid);
        continue;
      }
      // Monaco lays out lazily; give the pane a moment before reading it.
      await sleep(PACE.betweenPanes);
      const started = Date.now();
      const res = await readCodeField(container, left);
      left -= Date.now() - started;

      const body = res.text && res.text.trim() ? cleanBlock(res.text) : '';
      checks.push({
        title: pane.title,
        testid: pane.testid,
        text: body,
        via: body ? res.how : 'empty',
        chars: body.length,
        truncated: Boolean(res.truncated),
      });
    }

    const parts = [
      ...notes.map((n) => `${n.title}\n\n${n.body}`),
      ...checks.filter((c) => c.text).map((c) => `${c.title}\n\n${c.text}`),
    ];

    return {
      text: parts.join('\n\n'),
      notes,
      checks,
      diagnostics: {
        sections_opened: openedSections,
        notes_opened: noteExpansion,
        notes_found: notes.length,
        panes_found: checks.length,
        panes_with_text: checks.filter((c) => c.text).length,
        missing,
        monaco: Boolean(monacoApi()),
        via: checks.map((c) => `${c.testid}=${c.via}(${c.chars})`),
      },
    };
  }

  // ---------------------------------------------------------- channel ----

  function publish(payload) {
    let node = document.getElementById(RESULT_ID);
    if (!node) {
      node = document.createElement('script');
      node.type = 'application/json';
      node.id = RESULT_ID;
      (document.documentElement || document).appendChild(node);
    }
    node.textContent = JSON.stringify(payload);
    window.dispatchEvent(new Event('snorkelbot:feedback-ready'));
  }

  window.addEventListener('snorkelbot:read-feedback', async () => {
    const token = document.documentElement.getAttribute(REQUEST_ATTR) || '';
    try {
      publish({ token, ok: true, ...(await collectFeedback()) });
    } catch (err) {
      publish({ token, ok: false, error: String((err && err.message) || err) });
    }
  });
})();
