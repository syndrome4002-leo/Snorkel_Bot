/* Sentinel Submission Helper - walking submission_answers_<repo>_<pr>.json
 * into the form. Fields are matched by their question text, which is the
 * contract the answers guide sets out, and every write is read back.
 */
(function () {
  'use strict';
  const STN = window.__STN__ || (window.__STN__ = {});
  if (STN.autofill) return;
  const U = STN.util;
  const P = STN.page;
  const S = STN.set;

  function isVerdictField(field) {
    const id = String(field.id || '').toLowerCase();
    if (id === 'verdict' || id === 'validity' || id === 'analysis') return true;
    const lab = U.normLabel(field.label || '');
    if (/what is your analysis of the sentinel task/.test(lab)) return true;
    const opts = Array.isArray(field.options) ? field.options : [];
    if (opts.length === 3) {
      const canon = new Set(opts.map((o) => U.canonVerdict(typeof o === 'string' ? o : o && o.label)).filter(Boolean));
      if (canon.size === 3) return true;
    }
    return false;
  }

  function verdictContainers() {
    return P.verdictRadioGroups().map((g) => g.closest('[data-testid^="field-"]') || g);
  }

  // Whatever the page currently has selected, if anything.
  function verdictOnPage() {
    for (const c of verdictContainers()) {
      const on = P.radioButtons(c).filter(P.radioChecked);
      if (on.length) return P.radioValue(on[0]) || P.radioText(on[0]);
    }
    return null;
  }

  function normalizeOptions(field) {
    const opts = Array.isArray(field.options) ? field.options : [];
    if (opts.length && typeof opts[0] === 'object' && opts[0] !== null) {
      return opts.map((o) => ({
        label: o.label != null ? o.label : o.text,
        checked: !!(o.checked != null ? o.checked : o.value),
      }));
    }
    const raw = Array.isArray(field.value) ? field.value : (field.value != null ? [field.value] : []);
    const chosen = new Set(raw.map((v) => U.normLabel(v)));
    if (opts.length) {
      return opts.map((o) => ({ label: String(o), checked: chosen.has(U.normLabel(o)) }));
    }
    return raw.map((v) => ({ label: String(v), checked: true }));
  }

  function describeValue(v) {
    const s = U.normText(typeof v === 'object' ? JSON.stringify(v) : String(v == null ? '' : v));
    return s.length > 70 ? s.slice(0, 70) + '…' : s;
  }

  async function applyField(field, report) {
    const label = field.label != null && String(field.label).trim() ? field.label : (field.id || '');
    const entry = { label: U.normText(label) || String(field.id || 'field'), id: field.id || '', status: 'fail', detail: '' };
    report.push(entry);

    const jsonType = String(field.type || '').toLowerCase();

    if (jsonType === 'file' || jsonType === 'upload') {
      entry.status = 'manual';
      entry.detail = 'browsers do not let a script fill a file input. Attach ' +
        (field.value ? String(field.value) : 'the archive') + ' with the T button.';
      return entry;
    }

    const verdict = isVerdictField(field);
    let containers = verdict ? verdictContainers() : P.findFields(label);
    if (!containers.length && verdict) containers = P.findFields(label);
    if (!containers.length) {
      entry.status = 'miss';
      const near = P.closestLabel(label);
      entry.detail = 'no field on this page matches that question' +
        (near ? '. The closest is "' + near + '"' : '');
      return entry;
    }

    const kind = P.detectControl(containers[0]) || jsonType;
    entry.detail = '';

    if (kind === 'radio') {
      const results = [];
      for (const c of containers) results.push(await S.setRadio(c, field.value));
      const bad = results.filter((r) => !r.ok);
      if (!bad.length) {
        entry.status = 'ok';
        entry.detail = 'set to "' + (results[0].value || field.value) + '"' +
          (containers.length > 1 ? ' on both copies of the question' : '');
      } else {
        entry.status = 'fail';
        entry.detail = bad.map((r) => r.reason).join('; ');
      }
      return entry;
    }

    if (kind === 'checkbox_group') {
      const options = normalizeOptions(field);
      if (!options.length) {
        entry.status = 'fail';
        entry.detail = 'the JSON lists no options for this checkbox group';
        return entry;
      }
      const res = await S.setCheckboxGroup(containers[0], options);
      const hard = res.notes.filter((n) => !/^left untouched/.test(n));
      const soft = res.notes.filter((n) => /^left untouched/.test(n));
      const ticked = options.filter((o) => o.checked).length;
      if (!hard.length) {
        entry.status = soft.length ? 'warn' : 'ok';
        entry.detail = ticked + ' of ' + options.length + ' options ticked' +
          (soft.length ? '. ' + soft.join('. ') : '');
      } else {
        entry.status = 'fail';
        entry.detail = hard.join('. ') + (soft.length ? '. ' + soft.join('. ') : '');
      }
      return entry;
    }

    if (kind === 'richtext') {
      const res = await S.setRichText(containers[0], field.value);
      entry.status = res.ok ? (res.warn ? 'warn' : 'ok') : 'fail';
      entry.detail = res.ok ? (res.warn || describeValue(field.value)) : (res.reason + (res.got ? ' (got "' + res.got + '")' : ''));
      return entry;
    }

    if (kind === 'textarea' || kind === 'text' || kind === 'number') {
      const res = await S.setPlainValue(containers[0], field.value, kind === 'number' ? 'number' : 'text');
      entry.status = res.ok ? (res.warn ? 'warn' : 'ok') : 'fail';
      entry.detail = res.ok ? (res.warn || describeValue(field.value)) : res.reason;
      return entry;
    }

    if (kind === 'file') {
      entry.status = 'manual';
      entry.detail = 'this is a file field, attach it with the T button';
      return entry;
    }

    entry.status = 'fail';
    entry.detail = 'could not work out what kind of control this field uses';
    return entry;
  }

  function readJson(raw) {
    let data;
    try {
      data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (e) {
      throw new Error('That file is not valid JSON: ' + e.message);
    }
    if (!data || typeof data !== 'object') throw new Error('The JSON root has to be an object.');
    if (!Array.isArray(data.fields)) {
      throw new Error('The JSON has no "fields" array. Expected the sentinel-submission-answers/v1 shape.');
    }
    return data;
  }

  async function run(raw, onProgress) {
    const data = readJson(raw);
    const report = [];
    const say = typeof onProgress === 'function' ? onProgress : function () {};

    say('Opening every section…');
    await P.expandAllSections();

    const fields = data.fields.slice();
    const vIndex = fields.findIndex(isVerdictField);

    // The verdict decides which of the three field sets the platform renders,
    // so it goes in first and the page gets a moment to redraw.
    if (vIndex > 0) fields.unshift(fields.splice(vIndex, 1)[0]);
    if (vIndex < 0 && data.verdict) {
      fields.unshift({ id: 'verdict', label: 'What is your analysis of the Sentinel task you downloaded above?', type: 'radio', value: data.verdict });
    }

    // Without a verdict the platform renders none of the path specific
    // questions, so say that plainly rather than reporting a wall of misses.
    if (vIndex < 0 && !data.verdict) {
      const already = verdictOnPage();
      if (!already) {
        report.push({
          id: 'verdict',
          label: 'Verdict',
          status: 'fail',
          detail: 'this JSON carries no verdict, so the platform never rendered the questions that go with one. ' +
            'Add a verdict field, or a top level "verdict" key, and run it again. Nothing else was filled.',
        });
        return { report: report, counts: { ok: 0, warn: 0, fail: 1, miss: 0, manual: 0 }, task: data.task || null, verdict: null };
      }
      report.push({
        id: 'verdict',
        label: 'Verdict',
        status: 'warn',
        detail: 'the JSON sets no verdict, so the page was left on "' + already + '"',
      });
    }

    // Filling a field focuses it, which would drag the view down the form.
    // The setters ask for preventScroll; this puts right anything that slips.
    const lock = U.scrollLock(P.fieldContainers()[0] || P.formRoot());

    for (let i = 0; i < fields.length; i++) {
      const field = fields[i];
      say('Filling ' + (i + 1) + ' of ' + fields.length + ': ' + U.normText(field.label || field.id || ''));
      await applyField(field, report);
      if (i === 0 && isVerdictField(field)) {
        await U.sleep(900);
        await P.expandAllSections();
      } else {
        await U.sleep(220);
      }
      lock.restore();
    }
    lock.restore();

    const counts = { ok: 0, warn: 0, fail: 0, miss: 0, manual: 0 };
    report.forEach((r) => { counts[r.status] = (counts[r.status] || 0) + 1; });
    return { report: report, counts: counts, task: data.task || null, verdict: data.verdict || null };
  }

  STN.autofill = { run, readJson, isVerdictField, verdictContainers, verdictOnPage };
})();
