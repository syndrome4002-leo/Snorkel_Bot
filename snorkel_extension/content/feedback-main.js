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

  /**
   * The nearest ancestor React actually owns.
   *
   * Monaco builds its own DOM imperatively, so `.monaco-editor` and everything
   * under it carry no `__reactFiber$` key — starting the fiber walk there found
   * nothing and returned immediately, every time. The container React rendered
   * is a few levels up.
   */
  function fiberHost(node) {
    let el = node;
    for (let up = 0; el && up < 20; up++) {
      if (reactFiber(el)) return el;
      el = el.parentElement;
    }
    return null;
  }

  function valueFromReact(el) {
    const edEl = fiberHost(el) || el;
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

  /*
   * Lines are keyed by their pixel offset in the document, NOT by
   * top / lineHeight as before. With word wrap on — which these report panes
   * use — a `.view-line` is as tall as the number of rows it wraps to, so tops
   * are not multiples of a single line height, and the old key collapsed
   * several different lines onto the same slot, each overwriting the last.
   */
  function collectLines(host, map) {
    for (const vl of host.querySelectorAll('.view-line')) {
      const top = Math.round(parseFloat(vl.style.top || '0') || 0);
      const height = Math.round(parseFloat(vl.style.height || '0') || 0);
      map.set(top, {
        height,
        text: String(vl.textContent == null ? '' : vl.textContent).replace(/ /g, ' '),
      });
    }
  }

  /**
   * Joins the collected lines top to bottom, and counts the holes.
   *
   * A hole is a line that starts below where the previous one ended, meaning
   * the scroll skipped a stretch that was never rendered. The text itself is
   * unrecoverable here, but reporting it beats returning a join that reads as
   * continuous prose with a chunk silently missing.
   */
  /**
   * How far down the pane has been read without a hole.
   *
   * Counting from the topmost line collected, this walks the collected lines
   * while each starts where the previous one ended, and returns where that run
   * stops. It is what the scroll aims just above on the next pass, so a jump
   * that skipped a stretch gets scrolled back to rather than left behind.
   */
  function coveredBottom(map, lh) {
    if (!map.size) return 0;
    const tops = Array.from(map.keys()).sort((a, b) => a - b);
    let bottom = tops[0];
    for (const top of tops) {
      if (top > bottom + 2) break;
      const row = map.get(top);
      const end = top + (row.height || lh || 0);
      if (end > bottom) bottom = end;
    }
    return bottom;
  }

  function assemble(map, lh) {
    if (!map.size) return { text: '', gaps: 0 };
    const tops = Array.from(map.keys()).sort((a, b) => a - b);
    const out = [];
    let gaps = 0;
    let prevBottom = null;
    for (const top of tops) {
      const row = map.get(top);
      if (prevBottom != null && top > prevBottom + 2) gaps++;
      out.push(row.text);
      prevBottom = top + (row.height || lh || 0);
    }
    return { text: out.join('\n').replace(/\s+$/, ''), gaps };
  }

  /**
   * Reads a Monaco editor in full by scrolling it and keeping what goes past.
   *
   * Monaco virtualises: only the lines on screen exist in the DOM, and it moves
   * on WHEEL events rather than scrollTop, so the pane has to be walked down a
   * screen at a time and the results stitched together.
   */
  async function valueByScrolling(edEl, budgetMs) {
    const deadline = Date.now() + (budgetMs == null ? 2500 : budgetMs);
    const target =
      edEl.querySelector('.monaco-scrollable-element') || edEl.querySelector('.overflow-guard') || edEl;
    const host = edEl.querySelector('.view-lines');
    if (!host) return { text: '', truncated: false, gaps: 0 };

    const lh = lineHeight(edEl);
    /*
     * The VISIBLE height of the editor, used only to size the jumps back to the
     * top. It used to come from `.view-lines`' own style height and drive the
     * downward step as well — but Monaco sets that to the height of the WHOLE
     * document, not the viewport, so the step was as tall as the entire report:
     * one wheel jumped from the first screenful straight to the last, and
     * everything between was never rendered, never collected, and silently
     * absent from the result. That is why a long report came back "scrolled" in
     * ~130ms holding two screenfuls.
     */
    const clip = edEl.querySelector('.overflow-guard') || edEl;
    const viewH = clip.clientHeight || clip.getBoundingClientRect().height || 150;
    // The height of the whole document, which is what tells the loop below when
    // it has actually reached the end rather than merely stopped moving.
    const docH = parseFloat(host.style.height) || 0;

    const map = new Map();
    const wheel = (dy) =>
      target.dispatchEvent(
        new WheelEvent('wheel', { deltaY: dy, deltaX: 0, deltaMode: 0, bubbles: true, cancelable: true })
      );
    const topmost = () => {
      let min = Infinity;
      for (const vl of host.querySelectorAll('.view-line')) {
        const t = parseFloat(vl.style.top || '0') || 0;
        if (t < min) min = t;
      }
      return min === Infinity ? 0 : min;
    };

    /*
     * Back to the start, however far down the pane happens to be sitting. A
     * pass that appears to change nothing is not proof of having arrived — a
     * smooth-scrolling editor is simply still moving — so it takes several
     * before giving up.
     */
    const toTop = async () => {
      for (let i = 0, still = 0; i < 400 && still < 4; i++) {
        const before = topmost();
        if (before <= 0) return;
        wheel(-Math.max(4000, viewH * 4));
        await raf();
        await sleep(8);
        if (topmost() >= before) still++;
        else still = 0;
      }
    };

    await toTop();
    await sleep(8);

    /*
     * The descent is closed-loop, and it aims at where the scroll is GOING
     * rather than where it currently is.
     *
     * A wheel event's deltaY is not a promise of pixels. Monaco scales it by
     * mouseWheelScrollSensitivity, clamps it, and with smooth scrolling on, the
     * position is still travelling several frames later. Aiming from the
     * position measured mid-flight compounds: the pane is already heading
     * somewhere, and another wheel adds to that, so it sails past a stretch of
     * the report that is then never rendered and never read.
     *
     * So `expected` models where the scroll will come to rest, and each pass
     * asks only for the difference between that and the next screen wanted.
     * When there is nothing left to ask for, the loop waits; once the position
     * stops changing it re-anchors on reality, learns this editor's actual
     * pixels-per-delta from the round trip, and — if it overshot — simply aims
     * back up at the hole it left.
     */
    let ranOut = false;
    let scale = 1; // pixels travelled per pixel of deltaY, learned below
    let idle = 0;
    let stalls = 0;
    let lastCovered = -1;
    let expected = topmost();
    let anchor = expected; // where the last settled measurement put us
    let askedSince = 0; // deltaY asked for since that measurement
    let coveredAtAnchor = -1;
    /*
     * How much of the aim to actually ask for. An editor whose scrolling is not
     * proportional at all — a sensitivity that varies per event — cannot be hit
     * by a learned scale, and each miss leaves a hole. Asking for less after
     * every unproductive round shrinks the miss until it lands.
     */
    let caution = 1;

    // A runaway guard only — the deadline and the checks below end this
    // normally. At about a screen per pass, a long report needs hundreds.
    for (let i = 0; i < 8000; i++) {
      if (Date.now() > deadline) {
        ranOut = true;
        break;
      }
      collectLines(host, map);

      const covered = coveredBottom(map, lh);
      // The whole document has gone past. `.view-lines` is as tall as the
      // document, so this is exact rather than a guess.
      if (docH > 0 && covered >= docH - 2) break;
      if (covered > lastCovered) {
        lastCovered = covered;
        idle = 0;
      }

      const want = covered - lh; // the next screen, overlapping by one line
      const delta = want - expected;
      if (Math.abs(delta) >= 1) {
        const ask = (delta / scale) * caution;
        wheel(ask);
        askedSince += ask;
        expected += ask * scale;
        idle = 0;
        await raf();
        await sleep(4);
        continue;
      }

      // Everything wanted has been asked for; give the pane time to get there.
      idle++;
      await raf();
      await sleep(8);
      if (idle < 4) continue;

      // It has stopped moving. Re-anchor on where it really is, and learn.
      const landed = topmost();
      if (askedSince !== 0) {
        const observed = (landed - anchor) / askedSince;
        if (Number.isFinite(observed) && observed > 0.05 && observed < 20) {
          scale = scale * 0.5 + observed * 0.5;
        }
        /*
         * Asked to move and did not: synthetic wheel events are not reaching
         * this editor, and no amount of asking will change that. Only counted
         * when enough travel was asked for to shift the top line — `topmost`
         * is quantised by line height, so a smaller move is invisible here and
         * is not evidence of anything.
         */
        const meaningful = Math.abs(askedSince * scale) >= Math.max(lh, 4);
        if (landed === anchor && meaningful && ++stalls >= 3) break;
      }
      // Did the last round actually read anything new? If not, aim smaller.
      caution =
        covered > coveredAtAnchor ? Math.min(1, caution * 1.5) : Math.max(0.15, caution * 0.5);
      coveredAtAnchor = covered;
      anchor = landed;
      expected = landed;
      askedSince = 0;
      idle = 0;
    }
    collectLines(host, map);

    const built = assemble(map, lh);

    /*
     * `.view-lines` is as tall as the whole document, which makes it a free
     * answer to "did this reach the bottom?" — if the last line collected ends
     * well above that, the read stopped short.
     */
    const deepest = map.size ? Math.max.apply(null, Array.from(map.keys())) : -1;
    const bottom = deepest >= 0 ? deepest + ((map.get(deepest) || {}).height || lh) : 0;
    const short = docH > 0 && bottom > 0 && bottom < docH - lh * 2;

    // Leave the pane where it was found.
    await toTop();

    return { text: built.text, truncated: ranOut || short || built.gaps > 0, gaps: built.gaps, short, ranOut };
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

    // What is on screen right now. Cheap, and it doubles as the yardstick for
    // the two shortcuts below.
    const map = new Map();
    const host = edEl.querySelector('.view-lines');
    if (host) collectLines(host, map);
    const lh = lineHeight(edEl);
    const visible = assemble(map, lh).text;

    /*
     * The shortcuts return a whole document from somewhere other than this
     * pane's own DOM — Monaco's model registry, or a React prop found by
     * walking up from here. Either can land on the WRONG editor: several of
     * these panes are on the page at once, and the walk upwards passes through
     * components that hold other people's text. So a shortcut is only believed
     * if it actually contains what this pane is displaying.
     */
    const believable = matcher(visible, { docH: host ? parseFloat(host.style.height) || 0 : 0, lh });

    let v = valueFromMonacoApi(edEl);
    if (v != null && v.trim() && believable(v)) return { text: v, how: 'monaco model' };

    v = valueFromReact(edEl);
    if (v != null && v.trim() && believable(v)) return { text: v, how: 'react props' };

    if (budgetMs != null && budgetMs <= 0) {
      return { text: visible, how: 'rendered lines, out of time', truncated: true };
    }

    /*
     * The scroll used to be gated on isScrollable(), which looked for a
     * rendered scrollbar slider — and Monaco hides those until a pane is
     * hovered, so an untouched pane holding hundreds of lines reported
     * "nothing to scroll" and only its first screenful was kept. It is now
     * always attempted; on a pane that genuinely fits, it costs a few hundred
     * milliseconds and returns the same text.
     */
    const started = Date.now();
    const stitched = await valueByScrolling(edEl, budgetMs);
    const ms = Date.now() - started;
    if (stitched.text.length <= visible.length) {
      return { text: visible, how: `rendered lines (scroll added nothing, ${ms}ms)` };
    }
    const notes = [`scrolled lines in ${ms}ms`];
    if (stitched.gaps) notes.push(`${stitched.gaps} gap(s)`);
    if (stitched.short) notes.push('stopped above the last line');
    if (stitched.ranOut) notes.push('out of time');
    return { text: stitched.text, how: notes.join(', '), truncated: stitched.truncated };
  }

  /**
   * Builds a test for "does this text belong to the pane showing `sample`?".
   *
   * Two signals, because either alone is beatable:
   *
   *   - the longest line currently on screen has to appear in the candidate,
   *     with runs of whitespace flattened (the model keeps tabs where the DOM
   *     renders spaces, and Monaco pads with non-breaking spaces);
   *   - the candidate cannot have more lines than the pane has rows. Monaco
   *     sizes `.view-lines` to the whole document, and every line takes at
   *     least one row, so that height is a hard ceiling. Sibling panes running
   *     the same report format defeat the line check on their own — this is
   *     what separates them.
   */
  function matcher(sample, { docH = 0, lh = 0 } = {}) {
    const flat = (s) => String(s).replace(/\s+/g, ' ').trim();
    const longest = String(sample || '')
      .split('\n')
      .map(flat)
      .reduce((a, b) => (b.length > a.length ? b : a), '');
    const maxLines = docH > 0 && lh > 0 ? Math.round(docH / lh) + 2 : Infinity;
    const needle = longest.length >= 12 ? longest.slice(0, 120) : null;
    // Nothing to check against: an empty pane, or one line of "OK", in an
    // editor that did not say how tall it is. Then a candidate has to be taken
    // on trust.
    if (!needle && maxLines === Infinity) return () => true;
    return (candidate) => {
      if (String(candidate).split('\n').length > maxLines) return false;
      return needle ? flat(candidate).includes(needle) : true;
    };
  }


  // ------------------------------------------------------- the F button ----

  async function collectFeedback(budgetMs) {
    const notes = [];
    const checks = [];
    const missing = [];
    /*
     * Every pane is now scrolled to its end rather than read off the screen, so
     * the old 12s for all four is not enough — a long Agentic Judge report alone
     * can take that. The isolated side waits 90s, leaving room for this.
     */
    let left = budgetMs || 60000;

    const openedSections = await expandAllSections();

    try {
      const openedNotes = await expandNotes();
      for (const note of noteSections()) notes.push(note);
      var noteExpansion = openedNotes;
    } catch {
      var noteExpansion = 0; // the sidebar is not always there
    }

    const present = FEEDBACK_PANES.filter((pane) => {
      if (fieldByTestId(pane.testid)) return true;
      missing.push(pane.testid);
      return false;
    });

    for (let i = 0; i < present.length; i++) {
      const pane = present[i];
      const container = fieldByTestId(pane.testid);
      if (!container) continue; // it was there a moment ago; nothing to read now
      // Monaco lays out lazily; give the pane a moment before reading it.
      await sleep(PACE.betweenPanes);
      const started = Date.now();
      /*
       * Each pane gets its own slice of what is left, so the first long one
       * cannot eat the budget and leave the rest reading a single screenful —
       * which is exactly the truncation this is meant to cure. A pane that
       * finishes early hands its unused time to the ones after it.
       */
      const share = Math.max(4000, Math.floor(left / (present.length - i)));
      /*
       * The same reader the build logs use: the pane's own Copy button, the
       * editor model, the rendered text and a scroll, whichever yields most.
       * These panes are Monaco too, and they truncate the same way.
       */
      const res = await readLogRegion(container, share, { onePaneOnly: true });
      left -= Date.now() - started;

      const body = res.text && res.text.trim() ? cleanBlock(res.text) : '';
      checks.push({
        title: pane.title,
        testid: pane.testid,
        text: body,
        via: body ? res.how : 'empty',
        chars: body.length,
        truncated: Boolean(res.truncated),
        // What each reader returned, so a short capture can be diagnosed from
        // the stored feedback instead of by reproducing it on the page.
        tried: res.tried || [],
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

  // ----------------------------------------------------- build logs ----

  /*
   * Reading a build-log panel in full.
   *
   * The panel is virtualised: only the rows on screen exist in the DOM, so
   * reading its textContent gives you the first screenful and nothing else —
   * about seven lines of a log that runs to hundreds. The isolated world cannot
   * do better, because the ways out of this all need page-world access: the
   * editor's own model, React's props, or scrolling the thing and stitching what
   * appears.
   *
   * Which of those applies depends on what the panel is built from, and that is
   * not knowable from here — so all of them are tried and the longest result
   * wins. `how` says which one worked, so the logs tell you rather than leaving
   * you to guess.
   */

  const scrollableIn = (root) => {
    if (root.scrollHeight > root.clientHeight + 4) return root;
    const nodes = root.querySelectorAll('*');
    for (const el of nodes) {
      if (el.scrollHeight > el.clientHeight + 4) {
        const style = getComputedStyle(el);
        if (/(auto|scroll)/.test(style.overflowY)) return el;
      }
    }
    return null;
  };

  /**
   * Scrolls a plain (non-Monaco) virtualised list and keeps what goes past.
   *
   * Rows are keyed by their offset within the scrolled content, which is stable
   * as the list re-renders — so a row seen twice lands in the same slot instead
   * of being appended again, and identical lines at different heights stay
   * distinct. Keying on the text would collapse a log's many repeated lines into
   * one.
   */
  async function readByScrollingPlain(box, budgetMs) {
    // `|| 45000` would turn an exhausted budget of 0 into a fresh 45 seconds.
    const deadline = Date.now() + (budgetMs == null ? 45000 : budgetMs);
    const rows = new Map();

    const harvest = () => {
      const base = box.scrollTop;
      for (const el of box.querySelectorAll('div, span, p, tr, li, pre')) {
        if (el.children.length) continue; // leaves only, or every line counts twice
        const text = String(el.textContent == null ? '' : el.textContent).replace(/ /g, ' ');
        if (!text.trim()) continue;
        const top = Math.round(base + el.getBoundingClientRect().top - box.getBoundingClientRect().top);
        rows.set(top, text);
      }
    };

    box.scrollTop = 0;
    await raf();
    harvest();

    let lastTop = -1;
    while (Date.now() < deadline) {
      if (box.scrollTop === lastTop) break; // hit the bottom
      lastTop = box.scrollTop;
      box.scrollTop = box.scrollTop + Math.max(80, box.clientHeight - 40);
      box.dispatchEvent(new WheelEvent('wheel', { deltaY: 400, bubbles: true }));
      await raf();
      await new Promise((r) => setTimeout(r, 40));
      harvest();
    }

    const ordered = Array.from(rows.keys()).sort((a, b) => a - b);
    return {
      text: ordered.map((k) => rows.get(k)).join('\n').replace(/\s+$/, ''),
      truncated: Date.now() >= deadline,
    };
  }

  /**
   * Uses the panel's own Copy button, by catching what it copies.
   *
   * The page has already solved this problem — its Copy button produces the
   * whole log, virtualised or not. Reading the clipboard back would need a
   * permission and a focused document, so instead the write is intercepted:
   * `navigator.clipboard.writeText` is shadowed for the length of one click, and
   * a `copy` listener catches the `execCommand` route. Both are put back
   * afterwards, and nothing ever reaches the real clipboard.
   */
  async function readByCopyButton(region, { onePaneOnly = false } = {}) {
    let host = region;
    let button = null;
    // The button sits in the panel header, above the editor, so it is usually a
    // sibling of the region rather than inside it — hence walking up. But the
    // check panes sit side by side, and walking up far enough reaches the NEXT
    // pane's Copy button; its text would then win on length and be filed under
    // the wrong check. So the walk stops as soon as the host spans two fields.
    for (let up = 0; up < 4 && host && !button; up++) {
      if (onePaneOnly && up > 0 && host.querySelectorAll('[data-testid^="field-"]').length > 1) break;
      button = Array.from(host.querySelectorAll('button')).find(
        (b) => /^copy$/i.test((b.getAttribute('title') || '').trim()) || /^copy$/i.test(visibleText(b))
      );
      host = host.parentElement;
    }
    if (!button) return { text: '', how: 'no copy button' };

    let captured = '';
    const clip = navigator.clipboard;
    const hadOwn = clip ? Object.prototype.hasOwnProperty.call(clip, 'writeText') : false;
    const original = clip ? clip.writeText : null;

    // Bubble phase, so the page's own handler has already put the text in.
    const onCopy = (event) => {
      try {
        const text = event.clipboardData && event.clipboardData.getData('text/plain');
        if (text && text.length > captured.length) captured = text;
      } catch {
        /* not readable from here */
      }
    };

    document.addEventListener('copy', onCopy);
    if (clip) {
      clip.writeText = function (text) {
        captured = String(text == null ? '' : text);
        return Promise.resolve();
      };
    }

    try {
      button.click();
      // The handler may be async; a moment is enough for either route.
      await new Promise((r) => setTimeout(r, 350));
    } finally {
      document.removeEventListener('copy', onCopy);
      if (clip) {
        if (hadOwn && original) clip.writeText = original;
        else delete clip.writeText;
      }
    }

    return { text: captured, how: 'copy button' };
  }

  async function readLogRegion(region, budgetMs, options = {}) {
    const attempts = [];
    // One deadline for all the attempts together — passing the full budget to
    // each of them separately would let a single region run three times over.
    const deadline = Date.now() + (budgetMs || 45000);
    const timeLeft = () => Math.max(0, deadline - Date.now());

    // The page's own Copy button, which already produces the whole log.
    try {
      const viaCopy = await readByCopyButton(region, options);
      if (viaCopy.text) attempts.push(viaCopy);
    } catch (err) {
      attempts.push({ text: '', how: `copy button failed: ${err.message}` });
    }

    // The editor-aware path: model, React props, or Monaco's own scrolling.
    let gotCode = false;
    try {
      const viaCode = await readCodeField(region, timeLeft());
      if (viaCode && viaCode.text) {
        gotCode = true;
        attempts.push({ ...viaCode, how: `code field (${viaCode.how})` });
      }
    } catch (err) {
      attempts.push({ text: '', how: `code field failed: ${err.message}` });
    }

    /*
     * Whatever happens to be rendered right now — the old behaviour, kept as a
     * floor so this can never do worse than before. It is skipped once the
     * code-field path has produced something, because for an editor it reads
     * the same lines plus the panel heading, and on a short pane that extra
     * heading would win on length and end up inside the captured text.
     */
    const hasEditor = !!region.querySelector('.monaco-editor');
    if (!gotCode || !hasEditor) attempts.push({ text: visibleText(region), how: 'rendered text' });

    /*
     * A plain virtualised list, which the code-field path does not know about.
     * Skipped for an editor that already read, for the same reason as the
     * floor above: it harvests every leaf in the region, headings included, and
     * on a short pane that would outweigh the real text.
     */
    const box = gotCode && hasEditor ? null : scrollableIn(region);
    if (box) {
      try {
        const scrolled = await readByScrollingPlain(box, timeLeft());
        if (scrolled.text) attempts.push({ ...scrolled, how: 'scrolled the panel' });
      } catch (err) {
        attempts.push({ text: '', how: `scrolling failed: ${err.message}` });
      }
    }

    const best = attempts.reduce((a, b) => (b.text.length > a.text.length ? b : a), { text: '', how: 'nothing' });
    return { ...best, tried: attempts.map((a) => `${a.how}=${a.text.length}`) };
  }

  const LOGS_REQUEST_ATTR = 'data-snorkelbot-logs-request';
  const LOGS_RESULT_ID = '__snorkelbot_logs_result';

  function publishLogs(payload) {
    let node = document.getElementById(LOGS_RESULT_ID);
    if (!node) {
      node = document.createElement('script');
      node.type = 'application/json';
      node.id = LOGS_RESULT_ID;
      (document.documentElement || document).appendChild(node);
    }
    node.textContent = JSON.stringify(payload);
    window.dispatchEvent(new Event('snorkelbot:logs-ready'));
  }

  window.addEventListener('snorkelbot:read-logs', async () => {
    let request = {};
    try {
      request = JSON.parse(document.documentElement.getAttribute(LOGS_REQUEST_ATTR) || '{}');
    } catch {
      // handled below as a missing region
    }
    const token = request.token || '';

    try {
      const region = request.regionId ? document.getElementById(request.regionId) : null;
      if (!region) throw new Error(`No element with id "${request.regionId}" — the panel may have closed.`);
      publishLogs({ token, ok: true, ...(await readLogRegion(region, request.budgetMs || 45000)) });
    } catch (err) {
      publishLogs({ token, ok: false, error: String((err && err.message) || err) });
    }
  });

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
      // Well inside the isolated side's 90s wait, with room for the section and
      // note expansions that run before the panes are read.
      publish({ token, ok: true, ...(await collectFeedback(60000)) });
    } catch (err) {
      publish({ token, ok: false, error: String((err && err.message) || err) });
    }
  });
})();
