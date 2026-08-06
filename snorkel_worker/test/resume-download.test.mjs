/*
 * What to do when Dropbox says the task's zip is not there.
 *
 * Dropbox is a handover point, not storage: whoever takes a file deletes it. So
 * "not found" nearly always means somebody already took it, and when that
 * somebody was an earlier run of this worker, the unpacked folder is on this
 * disk and the download was never needed.
 *
 * The rule these check is the decision that sits in front of the download, and
 * the fallback that sits behind it.
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

let failures = 0;

async function check(what, fn) {
  try {
    await fn();
    console.log('PASS ', what);
  } catch (err) {
    failures++;
    console.log('FAIL ', what);
    console.log('      ', err.message);
  }
}

/*
 * The quiet path: the record itself says the download already happened, so
 * Dropbox is never asked. Both fields have to agree — a stamp with a path still
 * on it is the contradiction that started all this.
 */
const takesQuietPath = (task) => Boolean(task.downloaded_at && !task.dropbox_path);

/*
 * The fallback, once Dropbox has answered "not there": the folder decides, and
 * only a folder with something in it counts.
 */
const canResumeFromDisk = (err, dir, entries) =>
  err.code === 'DROPBOX_NOT_FOUND' && Boolean(dir) && entries.length > 0;

const NOT_FOUND = Object.assign(new Error('path/not_found'), { code: 'DROPBOX_NOT_FOUND' });
const OTHER = Object.assign(new Error('HTTP 500 from Dropbox'), {});

await check('a task that has never been fetched goes to Dropbox', () => {
  assert.equal(takesQuietPath({ dropbox_path: '/x.zip' }), false);
});

await check('a task the worker already fetched does not', () => {
  assert.equal(takesQuietPath({ downloaded_at: '2026-08-06T16:06:58Z', dropbox_path: null }), true);
});

await check('the contradictory record is what the fallback exists for', () => {
  // Stamped as downloaded, and still pointing at the file that download deleted.
  // The quiet path misses this, which is how the task ends up asking Dropbox for
  // a file nobody has while its folder sits on disk.
  const task = { downloaded_at: '2026-08-06T16:06:58Z', dropbox_path: '/7c7220b0_submission.zip' };
  assert.equal(takesQuietPath(task), false);
  assert.equal(canResumeFromDisk(NOT_FOUND, '/downloads/41fd93c0_submission', ['repo', 'x.zip']), true);
});

await check('a Dropbox failure that is not "not there" still fails', () => {
  // A 500, a bad token, a network drop — the file may be perfectly fine, and
  // working from a stale folder instead would be worse than stopping.
  assert.equal(canResumeFromDisk(OTHER, '/downloads/41fd93c0_submission', ['repo']), false);
});

await check('no folder means there is nothing to fall back to', () => {
  assert.equal(canResumeFromDisk(NOT_FOUND, null, []), false);
});

await check('an empty folder does not count as a downloaded task', async () => {
  // What a half-finished unpack leaves behind. Resuming into it would hand
  // Claude an empty working directory and call it a resume.
  const root = await mkdtemp(path.join(tmpdir(), 'resume-'));
  try {
    const empty = path.join(root, 'empty_submission');
    await mkdir(empty);
    const { readdir } = await import('node:fs/promises');
    assert.equal(canResumeFromDisk(NOT_FOUND, empty, await readdir(empty)), false);

    const full = path.join(root, 'full_submission');
    await mkdir(full);
    await writeFile(path.join(full, 'instruction.md'), '# task');
    assert.equal(canResumeFromDisk(NOT_FOUND, full, await readdir(full)), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

console.log(failures ? `\n${failures} resume check(s) failed` : '\nthe download resume holds');
process.exit(failures ? 1 : 0);
