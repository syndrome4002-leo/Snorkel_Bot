/*
 * A synthetic wheel event does not move Monaco by deltaY pixels. It is scaled
 * by mouseWheelScrollSensitivity, clamped, and with smooth scrolling on, the
 * position is still travelling when the next frame is read. These are the ways
 * that goes wrong.
 */
const { JSDOM } = require('jsdom');
const { makeDoc, readFeedback, fs, path, VIEW_H } = require('./monaco-harness');

const SRC = path.join(__dirname, '..', 'content', 'feedback-main.js');
const source = fs.readFileSync(SRC, 'utf8');
const TESTID = 'field-code-rubric_panel_judge';

let failures = 0;

/* A pane whose wheel handling is deliberately awkward. `move` turns a requested
 * delta into the pixels actually travelled, and `lag` delays applying it. */
function build(doc, { move = (d) => d, lag = 0, startAt = 0 } = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window, window: { document } } = dom;

  const field = document.createElement('div');
  field.setAttribute('data-testid', TESTID);
  const editor = document.createElement('div');
  editor.className = 'monaco-editor';
  editor.setAttribute('data-uri', 'inmemory://model/x');
  const guard = document.createElement('div');
  guard.className = 'overflow-guard';
  Object.defineProperty(guard, 'clientHeight', { value: VIEW_H });
  const scrollable = document.createElement('div');
  scrollable.className = 'monaco-scrollable-element';
  const viewLines = document.createElement('div');
  viewLines.className = 'view-lines';
  viewLines.style.height = `${doc.height}px`;
  scrollable.appendChild(viewLines);
  guard.appendChild(scrollable);
  editor.appendChild(guard);
  field.appendChild(editor);
  document.body.appendChild(field);

  let scrollTop = 0;
  const render = () => {
    viewLines.textContent = '';
    for (const line of doc.lines) {
      if (line.top + line.height <= scrollTop || line.top >= scrollTop + VIEW_H) continue;
      const el = document.createElement('div');
      el.className = 'view-line';
      el.style.top = `${line.top}px`;
      el.style.height = `${line.height}px`;
      el.textContent = line.text;
      viewLines.appendChild(el);
    }
  };
  const max = () => Math.max(0, doc.height - VIEW_H);
  const seek = (to) => {
    const next = Math.min(max(), Math.max(0, to));
    if (next === scrollTop) return;
    scrollTop = next;
    render();
  };

  /*
   * Smooth scrolling: a wheel sets a target and the position travels towards it
   * over the next frames on its own, without needing further events. Modelling
   * it as a queue that drains on the next wheel would deadlock any reader that
   * waits to see motion before scrolling again — which is not what a browser
   * does.
   */
  let goal = 0;
  if (lag) {
    const tick = () => {
      if (Math.abs(goal - scrollTop) >= 1) seek(scrollTop + (goal - scrollTop) * 0.34);
      window.setTimeout(tick, 16);
    };
    tick();
  }

  scrollable.addEventListener('wheel', (e) => {
    const delta = move(e.deltaY);
    if (!lag) return seek(scrollTop + delta);
    goal = Math.min(max(), Math.max(0, goal + delta));
  });
  scrollTop = Math.min(max(), startAt);
  goal = scrollTop;
  render();
  return dom;
}

async function run(name, doc, behaviour) {
  const dom = build(doc, behaviour);
  const result = await readFeedback(dom, source);
  const check = result.checks[0] || {};
  const want = doc.lines.map((l) => l.text);
  const got = new Set(check.text.split('\n'));
  const missing = want.filter((l) => !got.has(l));
  const ok = missing.length === 0;
  if (!ok) failures++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(38)} ${want.length - missing.length}/${want.length} lines   ${check.via}`
  );
  if (!ok) console.log(`        lost ${missing.length} lines, truncated=${check.truncated}`);
}

(async () => {
  const doc = makeDoc(300);
  await run('exact: 1 px per delta', doc);
  await run('sluggish: a quarter of the delta', doc, { move: (d) => d * 0.25 });
  await run('sensitive: three times the delta', doc, { move: (d) => d * 3 });
  await run('clamped: never more than 100px', doc, { move: (d) => Math.max(-100, Math.min(100, d)) });
  await run('smooth: a frame behind', doc, { lag: 1 });
  await run('smooth and sensitive', doc, { move: (d) => d * 2.5, lag: 1 });
  await run('starts at the bottom', doc, { startAt: 1e9 });
  await run('starts halfway, smooth', doc, { startAt: 3000, lag: 1 });
  await run('jittery: delta plus noise', doc, {
    move: (() => {
      let n = 0;
      return (d) => d * (0.5 + ((n++ % 7) * 0.25));
    })(),
  });

  console.log(`\n${failures ? `${failures} scroll mode(s) lost text` : 'every scroll mode read the pane in full'}\n`);
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error('harness error:', err);
  process.exit(2);
});
