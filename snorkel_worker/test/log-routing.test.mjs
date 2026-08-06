/*
 * Which log lines end up in a task's own history.
 *
 * The machine stream is a running commentary and can carry anything. A task's
 * history is capped, so a line that repeats on a timer spends that cap on itself
 * — a sweep saying "still in build, nothing to start" once a minute is 1,440
 * lines a day, and the task's record ends up holding none of what happened to
 * it. That is not hypothetical: it is why the download failure that prompted
 * this could be reconstructed from the database and not from the logs.
 */

import assert from 'node:assert/strict';

let failures = 0;

function check(what, fn) {
  try {
    fn();
    console.log('PASS ', what);
  } catch (err) {
    failures++;
    console.log('FAIL ', what);
    console.log('      ', err.message);
  }
}

/** The rule in pushLog(), in both the worker and the server. */
const goesToTaskHistory = (entry) => Boolean(entry.uid) && !entry.recurring;

/** The wrapper the worker hands to a running task, as index.js builds it. */
const sayFor = (uid, sink) => (emoji, event, message, extra = {}) =>
  sink({ emoji, event, message, uid, ...extra });

check('a line about a task is kept in that task’s history', () => {
  assert.equal(goesToTaskHistory({ uid: 'abc', event: 'claude_start' }), true);
});

check('a line about no task in particular is not', () => {
  assert.equal(goesToTaskHistory({ event: 'found_work' }), false);
});

check('a line that repeats on a timer stays out of it', () => {
  assert.equal(goesToTaskHistory({ uid: 'abc', event: 'auto_skip', recurring: true }), false);
});

check('the wrapper forwards the flag instead of dropping it', () => {
  // The failure mode this exists for: `say` used to take three arguments, so a
  // fourth marking the line as recurring vanished silently and the line went
  // into the history anyway — with nothing to show it had been marked.
  const written = [];
  const say = sayFor('abc', (line) => written.push(line));
  say('⏳', 'claude_working', 'still working — 15 min so far', { recurring: true });
  assert.equal(written.length, 1);
  assert.equal(written[0].recurring, true, 'the flag should survive the wrapper');
  assert.equal(goesToTaskHistory(written[0]), false);
});

check('and still attaches the uid when nothing extra is passed', () => {
  const written = [];
  const say = sayFor('abc', (line) => written.push(line));
  say('🧠', 'claude_start', 'revising abc');
  assert.equal(written[0].uid, 'abc');
  assert.equal(goesToTaskHistory(written[0]), true);
});

check('level still travels with the line', () => {
  const written = [];
  const say = sayFor('abc', (line) => written.push(line));
  say('⚠️', 'reupload', 'could not rebuild', { level: 'warn' });
  assert.equal(written[0].level, 'warn');
  assert.equal(goesToTaskHistory(written[0]), true, 'a warning is history, not commentary');
});

console.log(failures ? `\n${failures} log-routing check(s) failed` : '\nthe log routing holds');
process.exit(failures ? 1 : 0);
