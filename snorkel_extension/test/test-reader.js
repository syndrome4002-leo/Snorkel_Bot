/*
 * Reads four virtualised panes and checks the capture is complete.
 *
 * Run against the current file, or against any revision:
 *   node test-reader.js                       # working tree
 *   node test-reader.js HEAD                  # committed version
 */
const { execSync } = require('child_process');
const { makeDoc, buildPage, readFeedback, fs, path } = require('./monaco-harness');

const REPO = path.join(__dirname, '..', '..');
const REL = 'snorkel_extension/content/feedback-main.js';

function sourceFor(rev) {
  if (rev && rev.endsWith('.js')) return fs.readFileSync(rev, 'utf8');
  if (!rev) return fs.readFileSync(path.join(REPO, REL), 'utf8');
  return execSync(`git -C ${REPO} show ${rev}:${REL}`, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

// The four real panes, with the Agentic Judge report the long one.
const PANES = [
  { testid: 'field-difficulty_check_summary', doc: makeDoc(12) },
  { testid: 'field-code-rubric_panel_judge', doc: makeDoc(420) },
  { testid: 'field-oracle_check_summary', doc: makeDoc(3, { wrapEvery: 0 }) },
  { testid: 'field-quality_check_summary', doc: makeDoc(60) },
];

(async () => {
  const rev = process.argv[2] || null;
  const dom = buildPage(PANES);
  const result = await readFeedback(dom, sourceFor(rev));

  let failures = 0;
  console.log(`\n=== feedback-main.js @ ${rev || 'working tree'} ===\n`);
  for (const pane of PANES) {
    const expected = pane.doc.lines.map((l) => l.text).join('\n');
    const got = (result.checks.find((c) => c.testid === pane.testid) || {}).text || '';
    const via = (result.checks.find((c) => c.testid === pane.testid) || {}).via || '-';

    const gotLines = got.split('\n').filter((l) => l.trim());
    const wantLines = expected.split('\n');
    const missing = wantLines.filter((l) => !gotLines.includes(l));

    const ok = missing.length === 0;
    if (!ok) failures++;
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${pane.testid.padEnd(34)} ` +
        `${String(got.length).padStart(7)}/${String(expected.length).padEnd(7)} chars  ` +
        `${wantLines.length - missing.length}/${wantLines.length} lines   via: ${via}`
    );
    if (!ok) {
      console.log(`        first missing: ${JSON.stringify(missing[0])}`);
      console.log(`        missing ${missing.length} of ${wantLines.length} lines`);
    }
  }

  console.log(`\n${failures ? `${failures} pane(s) incomplete` : 'every pane captured in full'}\n`);
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error('harness error:', err);
  process.exit(2);
});
