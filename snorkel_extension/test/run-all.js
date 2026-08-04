/*
 * Runs every reader test in turn. `npm i jsdom` in this directory first.
 *
 *   node test/run-all.js
 */
const { execFileSync } = require('child_process');
const path = require('path');

const SUITES = ['test-reader.js', 'test-guards.js', 'test-edges.js', 'test-scroll-modes.js'];
let failed = 0;

for (const suite of SUITES) {
  console.log(`\n──────── ${suite}`);
  try {
    execFileSync(process.execPath, [path.join(__dirname, suite)], { stdio: 'inherit' });
  } catch {
    failed++;
  }
}

console.log(failed ? `\n${failed} suite(s) failed\n` : '\nall suites passed\n');
process.exit(failed ? 1 : 0);
