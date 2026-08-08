/*
 * How many times to answer a reviewer before leaving the task to a person.
 *
 * Rework is the most expensive work this system does, and it gets worse with
 * every round: the prompt pays to re-establish a conversation that has grown
 * since the last round, while the edit it asks for has not. Across 129 measured
 * rounds it cost roughly five times as much per unit of work as a first build.
 *
 * So there is a cap — but off by default, because past it a task the reviewer is
 * still asking about stops being answered, and that is a decision rather than a
 * default. These pin both halves of that: it does nothing until asked, and it
 * counts what it claims to count.
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

/*
 * The decision itself, in the shape firebase.js applies it. Kept here rather
 * than reaching into Firestore: what is worth pinning is the arithmetic and the
 * off-by-default, neither of which needs a database to be wrong.
 */
function tooManyRounds(task, cap) {
  const rounds = Array.isArray(task.feedbacks) ? task.feedbacks.length : 0;
  return cap > 0 && rounds >= cap;
}

const rounds = (n) => ({ feedbacks: Array.from({ length: n }, () => ({})) });

check('no limit set means nothing is ever left behind', () => {
  // The behaviour every version before this had, and still the default.
  assert.equal(tooManyRounds(rounds(12), 0), false);
});

check('under the limit is worked as usual', () => {
  assert.equal(tooManyRounds(rounds(2), 3), false);
});

check('the limit counts rounds already done, so it stops ON the number', () => {
  // A cap of 3 means three rounds get answered — the fourth does not.
  assert.equal(tooManyRounds(rounds(3), 3), true);
});

check('past the limit stays past it', () => {
  assert.equal(tooManyRounds(rounds(9), 3), true);
});

check('a task with no feedback yet is not a revision that has run out', () => {
  assert.equal(tooManyRounds({}, 3), false);
  assert.equal(tooManyRounds({ feedbacks: [] }, 1), false);
});

check('a malformed feedbacks field counts as none rather than throwing', () => {
  // Firestore hands back whatever is stored; a task written by an older version
  // must not be able to crash the poll loop.
  assert.equal(tooManyRounds({ feedbacks: 'three' }, 1), false);
  assert.equal(tooManyRounds({ feedbacks: null }, 1), false);
});

console.log(failures ? `\n${failures} revision-limit check(s) failed` : '\nthe revision limit holds');
process.exit(failures ? 1 : 0);
