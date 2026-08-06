/*
 * The worker's settings come from the machines it works for, because that is
 * where the dashboard writes them — the worker's own branch is one nobody has on
 * screen. These are the rules for turning several branches into one answer.
 */

import assert from 'node:assert/strict';
import { mergeBranches } from '../src/rtdb.js';

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

check('the machine being worked for supplies the settings', () => {
  const { merged } = mergeBranches({}, [{ worker_max_concurrent: 5, static_fix_limit: 10 }]);
  assert.equal(merged.worker_max_concurrent, 5);
  assert.equal(merged.static_fix_limit, 10);
});

check('an empty own branch does not blank what that machine asked for', () => {
  // The bug this whole thing exists for: the worker read its own branch, which
  // is empty, and used the env default while the dashboard showed 5.
  const { merged } = mergeBranches(undefined, [{ worker_max_concurrent: 5 }]);
  assert.equal(merged.worker_max_concurrent, 5);
});

check('the worker’s own branch overrides the machine it works for', () => {
  const { merged } = mergeBranches({ worker_max_concurrent: 2 }, [{ worker_max_concurrent: 5 }]);
  assert.equal(merged.worker_max_concurrent, 2);
});

check('two machines wanting different numbers get the lower one', () => {
  const { merged, clashes } = mergeBranches({}, [
    { worker_max_concurrent: 5 },
    { worker_max_concurrent: 3 },
  ]);
  assert.equal(merged.worker_max_concurrent, 3);
  assert.deepEqual(clashes, ['worker_max_concurrent']);
});

check('the lower one wins whichever order they arrive in', () => {
  const { merged } = mergeBranches({}, [{ worker_max_concurrent: 3 }, { worker_max_concurrent: 5 }]);
  assert.equal(merged.worker_max_concurrent, 3);
});

check('agreeing on a number is not a clash', () => {
  const { clashes } = mergeBranches({}, [{ worker_max_concurrent: 4 }, { worker_max_concurrent: 4 }]);
  assert.deepEqual(clashes, []);
});

check('a setting only one machine has is still used', () => {
  const { merged } = mergeBranches({}, [{ static_fix_limit: 10 }, { worker_max_concurrent: 5 }]);
  assert.equal(merged.static_fix_limit, 10);
  assert.equal(merged.worker_max_concurrent, 5);
});

check('null is an unset setting, not a value that wins', () => {
  // Clearing a text field writes null rather than removing the key, so a null
  // arriving from anywhere must not erase a real number from somewhere else.
  const { merged } = mergeBranches({ worker_max_concurrent: null }, [{ worker_max_concurrent: 5 }]);
  assert.equal(merged.worker_max_concurrent, 5);
});

check('two machines disagreeing about text keeps the first and says so', () => {
  const { merged, clashes } = mergeBranches({}, [{ sheet_owner: 'ann' }, { sheet_owner: 'bo' }]);
  assert.equal(merged.sheet_owner, 'ann');
  assert.deepEqual(clashes, ['sheet_owner']);
});

check('no machines at all is an empty answer, not a crash', () => {
  const { merged, clashes } = mergeBranches(undefined, []);
  assert.deepEqual(merged, {});
  assert.deepEqual(clashes, []);
});

console.log(failures ? `\n${failures} settings-merge check(s) failed` : '\nthe settings merge holds');
process.exit(failures ? 1 : 0);
