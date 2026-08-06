/*
 * One Firebase project, several deployments that have nothing to do with each
 * other. These are the rules for deciding whether a task document is ours —
 * the questions that go wrong when it is answered over the whole collection are
 * "is one of our new tasks already in build" and "how many have we sent today".
 */

process.env.WORKSPACE = 'ours';
process.env.MACHINE_ID = 'our-server';

const { ours } = await import('../src/firebase.js');

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

const assert = (value, message) => {
  if (!value) throw new Error(message);
};

check('a task stamped with our workspace is ours', () => {
  assert(ours({ workspace: 'ours', machine_id: 'our-server' }) === true, 'should be ours');
});

check('another deployment’s task is not ours, whatever machine it names', () => {
  assert(ours({ workspace: 'theirs', machine_id: 'their-server' }) === false, 'should not be ours');
});

check('their task is not ours even before they stamp a workspace on it', () => {
  // The case that caused the bug: their server is not running this code yet, so
  // its documents carry a machine and nothing else. Ours must not wait on them.
  assert(ours({ machine_id: 'their-server' }) === false, 'should not be ours');
});

check('our own documents from before the stamp existed are still ours', () => {
  assert(ours({ machine_id: 'our-server' }) === true, 'should be ours');
});

check('a task on one of our machines but stamped elsewhere is not ours', () => {
  // The stamp is the deliberate answer; the machine is only the fallback for
  // documents written before there was a stamp to read.
  assert(ours({ workspace: 'theirs', machine_id: 'our-server' }) === false, 'stamp should win');
});

check('a document with neither is nobody’s', () => {
  assert(ours({}) === false, 'should not be ours');
  assert(ours(null) === false, 'should not be ours');
});

console.log(failures ? `\n${failures} scoping check(s) failed` : '\nthe deployment scoping holds');
process.exit(failures ? 1 : 0);
