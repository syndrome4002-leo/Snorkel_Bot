/* Sentinel Submission Helper - writing into the submission form.
 * Every setter re-reads the control after acting and reports what it saw, so
 * a field that silently refused a value shows up in the autofill report.
 */
(function () {
  'use strict';
  const STN = window.__STN__ || (window.__STN__ = {});
  if (STN.set) return;
  const U = STN.util;
  const P = STN.page;

  // React can replace a container between ticks; find it again by test id.
  function live(container) {
    if (container && container.isConnected) return container;
    const testid = container && container.getAttribute && container.getAttribute('data-testid');
    if (testid) {
      const again = document.querySelector('[data-testid="' + testid + '"]');
      if (again) return again;
    }
    return container;
  }

  /* ---------------------------------------------------------------- radio */

  function pickRadio(radios, wanted) {
    if (!radios.length) return null;
    const w = U.normLabel(wanted);
    for (const r of radios) if (U.normLabel(P.radioValue(r)) === w) return r;
    for (const r of radios) if (U.normLabel(P.radioText(r)) === w) return r;
    const cw = U.canonVerdict(wanted);
    if (cw) {
      for (const r of radios) if (U.canonVerdict(P.radioValue(r)) === cw) return r;
      for (const r of radios) if (U.canonVerdict(P.radioText(r)) === cw) return r;
    }
    const byValue = U.bestMatches(wanted, radios, P.radioValue);
    if (byValue.length) return byValue[0];
    const byText = U.bestMatches(wanted, radios, P.radioText);
    if (byText.length) return byText[0];
    return null;
  }

  async function setRadio(container, wanted) {
    const resolve = () => pickRadio(P.radioButtons(live(container)), wanted);
    if (!resolve()) {
      const seen = P.radioButtons(live(container)).map(P.radioValue).join(', ');
      return { ok: false, reason: 'no option matching "' + wanted + '"' + (seen ? ' (page offers: ' + seen + ')' : '') };
    }
    let useLabel = false;
    for (let i = 0; i < 5; i++) {
      const btn = resolve();
      if (!btn) break;
      if (P.radioChecked(btn)) return { ok: true, value: P.radioValue(btn) || P.radioText(btn) };
      const lab = btn.closest('label');
      const target = useLabel && lab ? lab : btn;
      target.click();
      await U.sleep(150);
      const after = resolve();
      if (after && !P.radioChecked(after)) useLabel = !useLabel;
    }
    const btn = resolve();
    if (btn && P.radioChecked(btn)) return { ok: true, value: P.radioValue(btn) || P.radioText(btn) };
    return { ok: false, reason: 'the option would not take the click' };
  }

  /* ------------------------------------------------------------- checkbox */

  async function setCheckboxAt(container, index, want) {
    let useParent = false;
    for (let i = 0; i < 5; i++) {
      const box = P.checkboxes(live(container))[index];
      if (!box) return { ok: false, reason: 'option vanished from the page' };
      const before = P.checkboxChecked(box);
      if (before === want) return { ok: true };
      const target = useParent && box.parentElement ? box.parentElement : box;
      target.click();
      await U.sleep(150);
      const now = P.checkboxes(live(container))[index];
      const after = now ? P.checkboxChecked(now) : before;
      // A click with no net effect usually means the handler sits on the row,
      // and our click toggled it twice. Aim one level up next time.
      if (after === before) useParent = !useParent;
    }
    const box = P.checkboxes(live(container))[index];
    return {
      ok: !!box && P.checkboxChecked(box) === want,
      reason: 'could not toggle the option',
    };
  }

  // options: [{ label, checked }]
  async function setCheckboxGroup(container, options) {
    const boxes = P.checkboxes(live(container));
    const pageLabels = boxes.map(P.checkboxText);
    const notes = [];
    const used = new Set();
    let set = 0;

    for (const opt of options) {
      const wanted = opt && (opt.label != null ? opt.label : opt.text);
      const want = !!(opt && (opt.checked != null ? opt.checked : opt.value));
      const free = pageLabels.map((t, i) => ({ t: t, i: i })).filter((x) => !used.has(x.i));
      const hit = U.bestMatches(wanted, free, (x) => x.t)[0];
      if (!hit) {
        notes.push('no page option matching "' + U.normText(wanted) + '"');
        continue;
      }
      used.add(hit.i);
      const res = await setCheckboxAt(container, hit.i, want);
      if (res.ok) set++;
      else notes.push('"' + U.normText(wanted) + '": ' + res.reason);
    }

    pageLabels.forEach((t, i) => {
      if (!used.has(i)) notes.push('left untouched: "' + t + '" (not listed in the JSON)');
    });

    return { ok: notes.filter((n) => !/^left untouched/.test(n)).length === 0, set: set, total: options.length, notes: notes };
  }

  /* -------------------------------------------------- textarea and number */

  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  function plainInput(container, kind) {
    const c = live(container);
    if (kind === 'number') return c.querySelector('input[type="number"]');
    return P.realTextarea(c) || c.querySelector('input[type="text"]') || c.querySelector('input[type="number"]');
  }

  async function setPlainValue(container, value, kind) {
    const el = plainInput(container, kind);
    if (!el) return { ok: false, reason: 'no input in this field' };
    const want = value == null ? '' : String(value);

    el.focus({ preventScroll: true });
    setNativeValue(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    setNativeValue(el, want);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
    await U.sleep(120);

    const after = plainInput(container, kind);
    const got = after ? after.value : '';
    const out = { ok: got === want, got: got };
    if (!out.ok) out.reason = 'the field kept "' + got + '"';
    if (out.ok && after && kind === 'number') {
      const min = after.getAttribute('min');
      const max = after.getAttribute('max');
      const n = Number(want);
      if (min !== null && n < Number(min)) out.warn = 'below the field minimum of ' + min;
      if (max !== null && n > Number(max)) out.warn = 'above the field maximum of ' + max;
    }
    return out;
  }

  /* -------------------------------------------------------------- richtext */

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function textToHtml(text) {
    const blocks = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split(/\n{2,}/);
    return blocks.map((b) => '<p>' + b.split('\n').map(escapeHtml).join('<br>') + '</p>').join('');
  }

  function selectAllIn(el) {
    const doc = el.ownerDocument;
    const sel = doc.getSelection();
    const range = doc.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function tiptapEditor(ce) {
    return U.fiberFindUp(ce, (props) => {
      const e = props && props.editor;
      if (e && e.commands && typeof e.commands.setContent === 'function') return e;
      return null;
    }, 25);
  }

  function viaTipTap(ce, text) {
    const ed = tiptapEditor(ce);
    if (!ed) return false;
    ed.commands.setContent(textToHtml(text), true);
    return true;
  }

  function viaPaste(ce, text) {
    ce.focus({ preventScroll: true });
    selectAllIn(ce);
    const dt = new DataTransfer();
    dt.setData('text/plain', String(text));
    dt.setData('text/html', textToHtml(text));
    const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
    ce.dispatchEvent(ev);
    return true;
  }

  function viaExecCommand(ce, text) {
    ce.focus({ preventScroll: true });
    selectAllIn(ce);
    document.execCommand('delete');
    const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    let ok = true;
    for (let i = 0; i < lines.length; i++) {
      if (i) ok = document.execCommand('insertParagraph') && ok;
      if (lines[i]) ok = document.execCommand('insertText', false, lines[i]) && ok;
    }
    return ok;
  }

  function richTextMatches(ce, want) {
    return U.normText(U.visibleText(ce)) === U.normText(want);
  }

  // The answers guide is blunt about auto-linkification, so strip what the
  // editor added and say so when anything is left.
  function tidyLinks(ce) {
    let links = ce.querySelectorAll('a').length;
    if (!links) return 0;
    const ed = tiptapEditor(ce);
    if (ed && ed.commands && typeof ed.commands.unsetLink === 'function') {
      try {
        ed.chain().focus(null, { scrollIntoView: false }).selectAll().unsetLink().run();
      } catch (e) { /* leave them for the human */ }
      links = ce.querySelectorAll('a').length;
    }
    return links;
  }

  async function setRichText(container, text) {
    const c = live(container);
    const ce = c.querySelector('[contenteditable="true"]');
    if (!ce) return { ok: false, reason: 'no rich text editor in this field' };
    const want = String(text == null ? '' : text);

    const strategies = [viaTipTap, viaPaste, viaExecCommand];
    for (const strategy of strategies) {
      try { strategy(ce, want); } catch (e) { /* try the next one */ }
      await U.sleep(180);
      if (richTextMatches(ce, want)) {
        const links = tidyLinks(ce);
        return { ok: true, warn: links ? links + ' link(s) the editor created are still there, clear them by hand' : '' };
      }
    }
    return {
      ok: false,
      reason: 'the editor kept different text',
      got: U.normText(U.visibleText(ce)).slice(0, 120),
    };
  }

  STN.set = {
    live, pickRadio, setRadio,
    setCheckboxAt, setCheckboxGroup,
    setNativeValue, setPlainValue,
    setRichText, textToHtml, tiptapEditor,
  };
})();
