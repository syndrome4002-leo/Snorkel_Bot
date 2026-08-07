/*
 * Filling the submission form against Radix controls.
 *
 * Two failures live here, both silent from the outside:
 *
 *   - a click that lands mid-render is dropped, the log says the field was
 *     filled, and the finished form has an empty question;
 *   - a revision re-fills a form that still has the previous round's boxes
 *     ticked, so a filler that only ever ticks makes the selection grow every
 *     round until it claims far more than the answer said.
 */
const { JSDOM, VirtualConsole } = require('jsdom');
const fs = require('fs');
const path = require('path');

const EXT = path.join(__dirname, '..');

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        ${detail}`}`);
  if (!ok) failures++;
};

/*
 * A section wrapper, because SUBMIT_FILL_FORM opens the accordions first and
 * waits 20 seconds for one to appear. Without it every case in this file pays
 * that timeout before it starts.
 */
function sectioned(document, field) {
  const section = document.createElement('div');
  section.setAttribute('data-testid', 'section-Submitter Questions');
  section.setAttribute('data-state', 'open');
  section.appendChild(field);
  return section;
}

function page() {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {}); // jsdom cannot navigate; not a finding
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole,
  });
  dom.window.chrome = { runtime: { onMessage: { addListener() {} } } };
  // jsdom does no layout, so it has no scrollIntoView; the click helper calls it.
  dom.window.Element.prototype.scrollIntoView = function scrollIntoView() {};
  return dom;
}

function load(dom) {
  dom.window.eval(fs.readFileSync(path.join(EXT, 'content/common.js'), 'utf8'));
  dom.window.eval(fs.readFileSync(path.join(EXT, 'content/submit.js'), 'utf8'));
  return dom.window;
}

/* A radio group. `dropFirst` ignores the first N clicks, which is what a control
 * being re-rendered underneath you does. */
function radioField({ dropFirst = 0 } = {}) {
  const dom = page();
  const { document } = dom.window;
  const field = document.createElement('div');
  field.setAttribute('data-testid', 'field-radio-ec-valid');

  let dropped = 0;
  for (const value of ['Fixable', 'Invalid', 'Valid-as-is']) {
    const b = document.createElement('button');
    b.setAttribute('role', 'radio');
    b.setAttribute('value', value);
    b.setAttribute('aria-checked', 'false');
    b.textContent = value;
    b.addEventListener('click', () => {
      if (dropped++ < dropFirst) return; // swallowed by a re-render
      for (const other of field.querySelectorAll('[role="radio"]')) {
        other.setAttribute('aria-checked', other === b ? 'true' : 'false');
      }
    });
    field.appendChild(b);
  }
  document.body.appendChild(sectioned(document, field));
  return { field, window: load(dom) };
}

const OPTIONS = [
  'the instructions are overly-prescriptive',
  'the instructions appear LLM generated',
  'the task leaks solution information',
  'less than 10 fail-to-pass tests in test suite',
];

/* A multi-select, optionally already ticked from a previous round. */
function multiField({ preTicked = [] } = {}) {
  const dom = page();
  const { document } = dom.window;
  const field = document.createElement('div');
  field.setAttribute('data-testid', 'field-multiselect-what_issue');
  const label = document.createElement('label');
  label.textContent = 'What issues did you find with the task';
  field.appendChild(label);

  for (const text of OPTIONS) {
    const box = document.createElement('div');
    box.setAttribute('role', 'checkbox');
    box.setAttribute('aria-label', text);
    box.setAttribute('aria-checked', preTicked.includes(text) ? 'true' : 'false');
    box.addEventListener('click', () =>
      box.setAttribute('aria-checked', box.getAttribute('aria-checked') === 'true' ? 'false' : 'true')
    );
    field.appendChild(box);
  }
  document.body.appendChild(sectioned(document, field));
  return { field, window: load(dom) };
}

const chosen = (field) =>
  [...field.querySelectorAll('[role="radio"]')]
    .filter((b) => b.getAttribute('aria-checked') === 'true')
    .map((b) => b.getAttribute('value'));

const ticked = (field) =>
  [...field.querySelectorAll('[role="checkbox"]')]
    .filter((b) => b.getAttribute('aria-checked') === 'true')
    .map((b) => b.getAttribute('aria-label'));

const fill = (window, answers) =>
  window.SnorkelBot.handlers.SUBMIT_FILL_FORM({ answers, pace_scale: 0.01 });

(async () => {
  // ---- a click that gets dropped is retried ------------------------------
  for (const [name, dropFirst] of [
    ['a control that responds at once', 0],
    ['a control that swallows the first click', 1],
    ['a control that swallows two', 2],
  ]) {
    const { field, window } = radioField({ dropFirst });
    const res = await fill(window, { duplicate: 'fixable' });
    check(
      name,
      JSON.stringify(chosen(field)) === JSON.stringify(['Fixable']) &&
        res.filled.some((f) => f.startsWith('duplicate')),
      `selected ${JSON.stringify(chosen(field))} filled=${JSON.stringify(res.filled)}`
    );
  }

  {
    const { field, window } = radioField({ dropFirst: 99 });
    const res = await fill(window, { duplicate: 'fixable' });
    check(
      'a click that never registers is reported, not counted as filled',
      chosen(field).length === 0 &&
        !res.filled.some((f) => f.startsWith('duplicate')) &&
        res.skipped.some((sk) => sk.startsWith('duplicate')),
      `filled=${JSON.stringify(res.filled)} skipped=${JSON.stringify(res.skipped)}`
    );
  }

  {
    const { field, window } = radioField();
    await fill(window, { duplicate: 'fixable' });
    check(
      'a lowercase answer matches the capitalised option',
      chosen(field)[0] === 'Fixable',
      JSON.stringify(chosen(field))
    );
  }

  // ---- the answer is the whole set, not an addition to it ---------------
  {
    const { field, window } = multiField({ preTicked: [OPTIONS[0], OPTIONS[1], OPTIONS[2]] });
    const res = await fill(window, { what_issues_found: [OPTIONS[1]] });
    check(
      'boxes the answer does not name are cleared',
      JSON.stringify(ticked(field)) === JSON.stringify([OPTIONS[1]]),
      `left ticked: ${JSON.stringify(ticked(field))} filled=${JSON.stringify(res.filled)}`
    );
    check(
      'what was cleared is reported, not only what was ticked',
      res.filled.some((f) => /what_issues_found.*cleared/.test(f)),
      JSON.stringify(res.filled)
    );
  }

  {
    const { field, window } = multiField({ preTicked: [OPTIONS[0]] });
    const res = await fill(window, { what_issues_found: [OPTIONS[1], OPTIONS[3]] });
    check(
      'it ticks and unticks in the same pass',
      JSON.stringify(ticked(field)) === JSON.stringify([OPTIONS[1], OPTIONS[3]]),
      JSON.stringify(ticked(field))
    );
  }

  // ---- and never wipes a field over a matching failure -------------------
  {
    const { field, window } = multiField({ preTicked: [OPTIONS[0]] });
    const res = await fill(window, { what_issues_found: ['something no option says'] });
    check(
      'an answer matching no option leaves the field alone',
      JSON.stringify(ticked(field)) === JSON.stringify([OPTIONS[0]]) &&
        res.skipped.some((sk) => /matched the options/.test(sk)),
      `ticked=${JSON.stringify(ticked(field))} skipped=${JSON.stringify(res.skipped)}`
    );
  }

  {
    const { field, window } = multiField({ preTicked: [OPTIONS[1]] });
    const res = await fill(window, { what_issues_found: [OPTIONS[1]] });
    check(
      'a field already matching the answer is not touched',
      JSON.stringify(ticked(field)) === JSON.stringify([OPTIONS[1]]) &&
        !res.filled.some((f) => f.startsWith('what_issues_found')),
      `ticked=${JSON.stringify(ticked(field))} filled=${JSON.stringify(res.filled)}`
    );
  }

  /*
   * "[Duplicate] What is your analysis…" is the same question as the one above
   * it, and the page says so. The stored answer for it used a wording that is
   * not on the page — "invalid/Not Fixable" against options Fixable, Invalid,
   * Valid-as-is — so it never matched, and once an unfilled question stops the
   * form being handed in, that one field parked every finished revision at
   * "static checks pass" with nobody submitting it.
   */
  {
    const { field, window } = radioField();
    const res = await fill(window, {
      validity_required: 'invalid',
      duplicate: 'invalid/Not Fixable',
    });
    check(
      'a wording the page does not use is covered by the twin question',
      JSON.stringify(chosen(field)) === JSON.stringify(['Invalid']) &&
        res.filled.some((f) => f.startsWith('duplicate')),
      `selected ${JSON.stringify(chosen(field))} skipped=${JSON.stringify(res.skipped)}`
    );
    check(
      'and that leaves nothing blocking the submission',
      !(res.blockers || []).includes('duplicate'),
      `blockers=${JSON.stringify(res.blockers)}`
    );
  }

  {
    /*
     * The trap this must never fall into. "Fixable" is a substring of
     * "invalid/Not Fixable", so any substring-based matching answers "this task
     * is fine" to a question whose answer was "this task cannot be fixed" —
     * which on this form is not a typo, it is the wrong submission.
     */
    const { field, window } = radioField();
    const res = await fill(window, { duplicate: 'invalid/Not Fixable' });
    check(
      'with no twin to fall back on it is left alone, never guessed',
      chosen(field).length === 0 &&
        res.skipped.some((s) => s.startsWith('duplicate (no option')),
      `selected ${JSON.stringify(chosen(field))} skipped=${JSON.stringify(res.skipped)}`
    );
  }

  {
    const { field, window } = radioField();
    const res = await fill(window, { validity_required: 'fixable', duplicate: 'fixable' });
    check(
      'an answer the page does use still wins on its own',
      JSON.stringify(chosen(field)) === JSON.stringify(['Fixable']),
      `selected ${JSON.stringify(chosen(field))}`
    );
  }

  console.log(failures ? `\n${failures} failed\n` : '\nthe form filler holds\n');
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error('harness error:', err);
  process.exit(2);
});
