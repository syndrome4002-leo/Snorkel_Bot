/*
 * The signature reader, on the shapes the four panes actually produce.
 *
 *   node test/checksigns.test.mjs
 *
 * No credentials and no network: these are the exact strings seen in the stored
 * rounds, kept here so a wording change on the platform shows up as a failing
 * test rather than as a pipeline that quietly learns nothing.
 */
import { signaturesOf, diffRounds, describeDiff, madeThingsWorse } from '../src/checksigns.js';

let bad = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
};

const round = (...checks) => ({ checks });
const judge = (text) => ({ title: 'Agentic Judge Quality Report', text });
const quality = (text) => ({ title: 'Quality Check', text });
const oracle = (text) => ({ title: 'Oracle Check', text });
const difficulty = (text) => ({ title: 'Difficulty Check', text });

// ---- a verdict is only a complaint when it is not OK ----------------------
check(
  'an OK verdict yields nothing',
  signaturesOf(round(judge('Status:    ✅  OK\nReason:    n/a\n'))).length === 0,
  JSON.stringify(signaturesOf(round(judge('Status: ✅ OK\nReason: n/a'))))
);
check(
  'DISCUSS and its reason become one key',
  signaturesOf(round(judge('Status:    ⚠️  DISCUSS\nReason:    overreach\n')))[0] === 'judge:discuss/overreach',
  JSON.stringify(signaturesOf(round(judge('Status: ⚠️ DISCUSS\nReason: overreach'))))
);
check(
  'REMOVE is kept apart from DISCUSS',
  signaturesOf(round(judge('Status: ❌ REMOVE\nReason: precreated_artifact_passes')))[0] ===
    'judge:remove/precreated_artifact_passes',
  'the verdict is part of the key, so the two do not collapse together'
);

// ---- per-axis scores -------------------------------------------------------
{
  const sigs = signaturesOf(
    round(judge('Status: ✅ OK\nReason: n/a\n  clarity  —  2.5/5\n  packaging  —  5.0/5\n  test_coverage  —  3.5/5\n'))
  );
  check(
    'only axes below the floor are flagged',
    sigs.length === 1 && sigs[0] === 'judge:axis:clarity',
    `3.5 is the floor and is not below it — got ${JSON.stringify(sigs)}`
  );
}

// ---- a check that did not run is not a check that failed ------------------
check(
  'an oracle that was never run is not a failure',
  signaturesOf(round(oracle('Not run — an earlier stage of the review gate blocked this submission.'))).length === 0,
  'a skipped check read as a failing one'
);
check(
  'an oracle that ran and failed is',
  signaturesOf(round(oracle('Oracle did not pass all runs: 0/3. Task may be flaky or has infra issues.')))[0] ===
    'oracle:runs_failed',
  'the real failure was missed'
);
check(
  'a difficulty screen blocked upstream is not a failure',
  signaturesOf(round(difficulty('Blocked at the agentic judge. Not run: difficulty screen (cheap single-arm rollout).')))
    .length === 0,
  'being blocked by another check is not this check failing'
);
check(
  'a difficulty screen that blocked is',
  signaturesOf(round(difficulty('Blocked at the difficulty screen (cheap single-arm rollout).')))[0] ===
    'difficulty:blocked',
  'the real block was missed'
);

// ---- quality ---------------------------------------------------------------
check(
  'a passing quality bar yields nothing',
  signaturesOf(round(quality('✅ datapoint meets quality bar (15/15 criteria pass)'))).length === 0,
  'the ✅ line read as a failure'
);
check(
  'a failing must-have is one key however many failed',
  signaturesOf(round(quality('❌ 1 must-have quality criteria failed (14/15 criteria pass).')))[0] ===
    'quality:must_have_failed',
  'the count is deliberately not in the key — the complaint is the same one'
);

// ---- the diff, which is the point of the file ------------------------------
{
  const before = round(judge('Status: ⚠️ DISCUSS\nReason: overreach'), quality('❌ 1 must-have quality criteria failed'));
  const after = round(judge('Status: ✅ OK\nReason: n/a'), oracle('Oracle did not pass all runs: 0/3.'));
  const diff = diffRounds(before, after);

  check(
    'a fix, a regression and the difference between them',
    diff.fixed.join() === 'judge:discuss/overreach,quality:must_have_failed' &&
      diff.introduced.join() === 'oracle:runs_failed' &&
      diff.persisted.length === 0,
    JSON.stringify(diff)
  );
  check('a round that caused a new failure is not a success', madeThingsWorse(diff), describeDiff(diff));
}

check(
  'the first round blames nothing on a revision that never happened',
  (() => {
    const d = diffRounds(null, round(judge('Status: ⚠️ DISCUSS\nReason: overreach')));
    return d.first === true && d.introduced.length === 0 && d.open.length === 1;
  })(),
  'a first round reported a regression'
);

check(
  'a repeated complaint is persisted, not introduced',
  (() => {
    const same = () => round(judge('Status: ⚠️ DISCUSS\nReason: overreach'));
    const d = diffRounds(same(), same());
    return d.persisted.length === 1 && !d.introduced.length && !d.fixed.length && !madeThingsWorse(d);
  })(),
  'a fix that did not work was reported as damage'
);

console.log(bad ? `\n${bad} failed\n` : '\nthe signature reader holds\n');
process.exit(bad ? 1 : 0);
