/*
 * The shortcuts are the dangerous part: the Monaco model registry, a React prop
 * found by walking up the DOM, and a Copy button found by walking up the DOM.
 * Each can reach text belonging to a DIFFERENT pane, and each returns early —
 * so a wrong answer would be stored silently, which is worse than a short one.
 *
 * These check that a shortcut is used when it is right and refused when it is
 * not.
 */
const { makeDoc, buildPage, readFeedback, fs, path } = require('./monaco-harness');

const REPO = path.join(__dirname, '..', '..');
const SRC = path.join(__dirname, '..', 'content', 'feedback-main.js');

const A = 'field-difficulty_check_summary';
const B = 'field-code-rubric_panel_judge';

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        ${detail}`}`);
  if (!ok) failures++;
};

async function run(name, decorate, assert) {
  const panes = [
    { testid: A, doc: makeDoc(40) },
    { testid: B, doc: makeDoc(80) },
  ];
  const dom = buildPage(panes);
  dom.window.navigator.clipboard = { writeText: async () => {} };
  decorate(dom, panes);
  const result = await readFeedback(dom, fs.readFileSync(SRC, 'utf8'));
  const by = (id) => result.checks.find((c) => c.testid === id) || {};
  assert({ panes, by, result });
}

const fullText = (pane) => pane.doc.lines.map((l) => l.text).join('\n');

(async () => {
  // 1. A React ancestor holding SOMEONE ELSE'S text must not be believed.
  await run(
    'wrong react prop',
    (dom, panes) => {
      const host = dom.window.document.querySelector(`[data-testid="${A}"]`).parentElement;
      host['__reactFiber$test'] = {
        memoizedProps: { value: fullText(panes[1]) }, // pane B's report, on pane A's ancestor
        return: null,
      };
    },
    ({ panes, by }) => {
      check(
        'a react prop from another pane is refused',
        by(A).text === fullText(panes[0]),
        `pane A got ${by(A).chars} chars via ${by(A).via}; expected its own ${fullText(panes[0]).length}`
      );
    }
  );

  // 2. A React ancestor holding THIS pane's text is the fast path, and must be.
  await run(
    'right react prop',
    (dom, panes) => {
      const host = dom.window.document.querySelector(`[data-testid="${A}"]`).parentElement;
      host['__reactFiber$test'] = { memoizedProps: { value: fullText(panes[0]) }, return: null };
    },
    ({ panes, by }) => {
      check(
        'a react prop matching the pane is used',
        by(A).text === fullText(panes[0]) && /react props/.test(by(A).via),
        `via was "${by(A).via}" with ${by(A).chars} chars`
      );
    }
  );

  // 3. A Copy button in the pane's own header is the best route available.
  await run(
    'own copy button',
    (dom, panes) => {
      const field = dom.window.document.querySelector(`[data-testid="${A}"]`);
      const button = dom.window.document.createElement('button');
      button.setAttribute('title', 'Copy');
      button.addEventListener('click', () => dom.window.navigator.clipboard.writeText(fullText(panes[0])));
      field.insertBefore(button, field.firstChild);
    },
    ({ panes, by }) => {
      check(
        "a pane's own copy button is used",
        by(A).text === fullText(panes[0]) && /copy button/.test(by(A).via),
        `via was "${by(A).via}" with ${by(A).chars} chars`
      );
    }
  );

  // 4. A Copy button ABOVE all the panes copies the lot; using it for one pane
  //    would file every pane's text under whichever pane found it first.
  await run(
    'shared copy button',
    (dom, panes) => {
      const button = dom.window.document.createElement('button');
      button.setAttribute('title', 'Copy');
      const everything = panes.map(fullText).join('\n');
      button.addEventListener('click', () => dom.window.navigator.clipboard.writeText(everything));
      dom.window.document.body.insertBefore(button, dom.window.document.body.firstChild);
    },
    ({ panes, by }) => {
      check(
        'a copy button shared by several panes is refused',
        by(A).text === fullText(panes[0]) && by(B).text === fullText(panes[1]),
        `A: ${by(A).chars} via ${by(A).via} | B: ${by(B).chars} via ${by(B).via}`
      );
    }
  );

  console.log(`\n${failures ? `${failures} guard(s) failed` : 'all guards hold'}\n`);
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error('harness error:', err);
  process.exit(2);
});
