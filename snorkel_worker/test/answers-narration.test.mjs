/*
 * "Addressed in a previous round" is not an answer.
 *
 *   node test/answers-narration.test.mjs
 *
 * The detector has to be narrow. Flagging too little leaves a useless answer in
 * the form; flagging too much spends a Claude turn rewriting a perfectly good
 * one, and risks the rewrite making it worse.
 */
import {
  processNarration,
  missingVerdicts,
  issueFormatProblems,
  wrappedLines,
} from '../src/answers.js';

let bad = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
};

const flagged = (text) => processNarration({ issues_in_detail: text }).length > 0;

// ---- the real answer that started this ------------------------------------
check(
  'the answer from the form is caught',
  flagged('2) [Instructions / LLM generated]\nAddressed in a previous round. The instruction reads as prose.'),
  'this is the exact text that reached the form'
);

// ---- the shapes it takes ---------------------------------------------------
for (const phrase of [
  'Addressed in a previous round.',
  'Earlier rounds rewrote it as abstract behavioral prose.',
  'This round takes a different approach.',
  'Fixed last time and still correct.',
  'Two rounds ago the oracle was rewritten.',
  'As noted in the feedback, the tests were thin.',
  'The agentic judge rejected this as REMOVE.',
  'The reviewer said the instruction was too prescriptive.',
]) {
  check(`caught: ${JSON.stringify(phrase.slice(0, 42))}`, flagged(phrase), 'went through unflagged');
}

// ---- and what it must NOT catch -------------------------------------------
for (const phrase of [
  'The backoff delay is rounded to the nearest second, which is easy to miss.',
  'A round trip through the dispatcher loses the stop_reason field.',
  'The instruction read like a generated numbered spec, so it is written as prose.',
  'Tests cover the round-robin scheduler and the retry budget.',
  'The oracle rounds partial credit down, the tests round it up.',
  'This is fixable. The instruction now specifies the contract vocabulary.',
]) {
  check(`left alone: ${JSON.stringify(phrase.slice(0, 42))}`, !flagged(phrase), 'a good answer was flagged');
}

// ---- it reports which field, so only that one is rewritten ----------------
{
  const found = processNarration({
    issues_in_detail: 'Addressed in a previous round.',
    files_changed: 'instruction.md, tests/test_retry.py',
    what_makes_difficult: 'The retry budget interacts with the dispatcher.',
  });
  check(
    'only the offending field is named',
    found.length === 1 && found[0].key === 'issues_in_detail' && found[0].match === 'previous round',
    JSON.stringify(found)
  );
}

// ---- arrays are answers too ------------------------------------------------
check(
  'a list answer is checked as well',
  processNarration({ where_task_had_issues: ['instructions', 'addressed in a previous round'] }).length === 1,
  'the array was skipped'
);

// ---- every issue must say whether it is fixable ---------------------------
const REAL = [
  '1) [Instructions / Overly prescriptive, test-unfaithful, and test-leaking]',
  'The original instruction was a 13-point numbered specification. This round keeps',
  'the contract vocabulary but removes the exact test-assertion strings.',
  'This is fixable. The instruction now specifies the contract vocabulary.',
  '',
  '2) [Instructions / LLM generated]',
  'Addressed in a previous round. The instruction reads as prose, not a numbered spec.',
  '',
  '3) [Environment / frozen-requirements.txt]',
  'Addressed in a previous round. Removed the git+ line.',
].join('\n');

{
  const short = missingVerdicts({ issues_in_detail: REAL });
  check(
    'the items with no verdict are named, and only those',
    short.length === 2 && short[0].startsWith('2)') && short[1].startsWith('3)'),
    JSON.stringify(short)
  );
}

check(
  'an item that says "not fixable" counts as a verdict',
  missingVerdicts({
    issues_in_detail: '1) [A]\nSomething.\nThis is fixable, by rewriting it.\n\n2) [B]\nSomething else.\nThis is not fixable because the PR scope cannot change.',
  }).length === 0,
  'a negative verdict was read as a missing one'
);

check(
  'a single prose answer is left alone',
  missingVerdicts({ issues_in_detail: 'The instruction leaks the test assertions and that is fixable by rewording it.' })
    .length === 0,
  'a numbered format was demanded where none was asked for'
);

check(
  'an answer that is complete raises nothing',
  missingVerdicts({
    issues_in_detail: '1) [A]\nDetail.\nThis is fixable, by X.\n\n2) [B]\nDetail.\nThis is fixable, by Y.',
  }).length === 0,
  'a good answer was flagged'
);

// ---- the shape question 3 asks for ---------------------------------------
const SELECTED = {
  where_task_had_issues: ['instructions', 'environment/dockerfile'],
  what_issues_found: ['the instructions are overly-prescriptive', 'the instructions appear LLM generated'],
};
const fmt = (detail) => issueFormatProblems({ ...SELECTED, issues_in_detail: detail });

{
  // Exactly the shape every stored answer is in today.
  const problems = fmt(
    '1) [Instructions / Overly prescriptive]\nDetail.\nThis is fixable.\n\n2) [Environment / task.toml]\nDetail.\nThis is fixable.'
  );
  check(
    'an invented heading is caught, and the missing category with it',
    problems.length === 4 &&
      problems.filter((p) => /not one of the categories/.test(p)).length === 2 &&
      problems.filter((p) => /^no item for the category/.test(p)).length === 2,
    JSON.stringify(problems, null, 1)
  );
}

check(
  'the description on the category line is caught',
  fmt(
    '1) [the instructions are overly-prescriptive] The instruction named exact strings.\nThis is fixable.\n\n2) [the instructions appear LLM generated]\nDetail.\nThis is fixable.'
  ).some((p) => /runs the description onto the category line/.test(p)),
  'a run-on heading went through'
);

check(
  'an environment item headed with the question 1 label is allowed',
  fmt(
    [
      '1) [the instructions are overly-prescriptive]',
      'Detail.',
      'This is fixable.',
      '',
      '2) [the instructions appear LLM generated]',
      'Detail.',
      'This is fixable.',
      '',
      '3) [environment/dockerfile]',
      'task.toml was missing os.',
      'This is fixable.',
    ].join('\n')
  ).length === 0,
  'a legitimate environment item was rejected'
);

check(
  'a category selected but never written about is caught',
  fmt('1) [the instructions are overly-prescriptive]\nDetail.\nThis is fixable.').join() ===
    'no item for the category "the instructions appear LLM generated"',
  JSON.stringify(fmt('1) [the instructions are overly-prescriptive]\nDetail.\nThis is fixable.'))
);

check(
  'an answer with nothing selected to check against is left alone',
  issueFormatProblems({ issues_in_detail: '1) [Whatever]\nDetail.' }).length === 0,
  'it was checked against a list that is not there'
);

// ---- wrapped sentences ----------------------------------------------------
const wrap = (detail) => wrappedLines({ issues_in_detail: detail });

check(
  'a sentence wrapped at eighty columns is caught',
  wrap(
    [
      '1) [the instructions are overly-prescriptive]',
      'The instruction named the exact status strings and field names the tests assert',
      'on, which tells the agent what to write instead of what the code should do.',
      'This is fixable.',
    ].join('\n')
  ).length === 1,
  'the run-on line went through'
);

check(
  'the same text on one line raises nothing',
  wrap(
    [
      '1) [the instructions are overly-prescriptive]',
      'The instruction named the exact status strings and field names the tests assert on, which tells the agent what to write instead of what the code should do.',
      'This is fixable.',
    ].join('\n')
  ).length === 0,
  'an unwrapped answer was flagged'
);

check(
  'the line after a heading is a description, not a wrap',
  wrap('1) [environment/dockerfile]\ntask.toml was missing os and still carried network_mode.\nThis is fixable.').length === 0,
  'a lower-case description was read as the tail of its heading'
);

check(
  'a blank line is always a real break',
  wrap('1) [a]\nSomething with no full stop\n\nthis follows a blank line').length === 0,
  'a break across a blank line was read as a wrap'
);

check(
  'a list answer is not checked for wrapping',
  wrappedLines({ files_changed: 'instruction.md\ntests/test_retry.py\nconfig.json' }).length === 0,
  'files_changed was treated as prose'
);

console.log(bad ? `\n${bad} failed\n` : '\nthe answer checks hold\n');
process.exit(bad ? 1 : 0);
