/*
 * Edge cases around the scroll-stitcher:
 *   - a scroll that overshoots (real wheel handling is not pixel-exact)
 *   - a report too long for the time allowed
 *   - a plain non-Monaco panel, which is the build-log path
 *   - the pane is left where it was found
 */
const { JSDOM } = require('jsdom');
const { makeDoc, buildPage, readFeedback, fs, path } = require('./monaco-harness');

const SRC = path.join(__dirname, '..', 'content', 'feedback-main.js');
const source = fs.readFileSync(SRC, 'utf8');
const A = 'field-difficulty_check_summary';

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        ${detail}`}`);
  if (!ok) failures++;
};
const fullText = (pane) => pane.doc.lines.map((l) => l.text).join('\n');

(async () => {
  // 1. Overshooting wheel: every scroll lands 40% further than asked.
  {
    const panes = [{ testid: A, doc: makeDoc(200) }];
    const dom = buildPage(panes);
    const scrollable = dom.window.document.querySelector('.monaco-scrollable-element');
    scrollable.addEventListener('wheel', (e) => {
      if (e.deltaY > 0) scrollable.dispatchEvent(new dom.window.WheelEvent('wheel', { deltaY: e.deltaY * 0.4 }));
    });
    const r = await readFeedback(dom, source);
    const got = r.checks[0];
    const missing = fullText(panes[0])
      .split('\n')
      .filter((l) => !got.text.split('\n').includes(l));
    check(
      'an overshooting scroll is reported, not hidden',
      missing.length === 0 || got.truncated,
      `${missing.length} lines missing and truncated=${got.truncated}, via "${got.via}"`
    );
    if (missing.length) console.log(`        (lost ${missing.length} lines, flagged: ${got.via})`);
  }

  // 2. A report far too long for the time allowed.
  {
    const panes = [{ testid: A, doc: makeDoc(4000) }];
    const dom = buildPage(panes);
    // The budget the pane loop hands out is derived from this.
    const r = await readFeedback(dom, source.replace('collectFeedback(60000)', 'collectFeedback(6000)'));
    const got = r.checks[0];
    check(
      'running out of time is flagged',
      got.truncated === true,
      `truncated=${got.truncated} at ${got.chars} of ${fullText(panes[0]).length} chars, via "${got.via}"`
    );
    console.log(`        (${got.chars} chars captured, via ${got.via})`);
  }

  // 3. The pane is left at the top, not halfway down someone's report.
  {
    const panes = [{ testid: A, doc: makeDoc(200) }];
    const dom = buildPage(panes);
    await readFeedback(dom, source);
    check('the pane is scrolled back to the top', panes[0].scrollTopNow() === 0, `left at ${panes[0].scrollTopNow()}px`);
  }

  // 4. A plain virtualised panel — the build-log path, which must still work.
  {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    });
    const { window, window: { document } } = dom;
    const region = document.createElement('div');
    region.id = 'log-region';
    const lines = Array.from({ length: 40 }, (_, i) => `build log line ${i}`);
    for (const text of lines) {
      const row = document.createElement('div');
      row.textContent = text;
      region.appendChild(row);
    }
    document.body.appendChild(region);
    window.eval(source);

    const got = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no answer')), 60000);
      window.addEventListener('snorkelbot:logs-ready', () => {
        clearTimeout(timer);
        resolve(JSON.parse(document.getElementById('__snorkelbot_logs_result').textContent));
      });
      document.documentElement.setAttribute(
        'data-snorkelbot-logs-request',
        JSON.stringify({ token: 't', regionId: 'log-region', budgetMs: 5000 })
      );
      window.dispatchEvent(new window.Event('snorkelbot:read-logs'));
    });
    const missing = lines.filter((l) => !got.text.includes(l));
    check('a plain (non-Monaco) log panel still reads in full', got.ok && missing.length === 0, `missing ${missing.length}`);
  }

  console.log(`\n${failures ? `${failures} edge case(s) failed` : 'edge cases hold'}\n`);
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error('harness error:', err);
  process.exit(2);
});
