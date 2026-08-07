/*
 * Opening the folder must never cost a task.
 *
 * The editor is a convenience — somewhere to watch the work and step into it.
 * Everything here is about what happens when that convenience is unavailable:
 * no screen, no `code` on PATH, a launcher that hangs. In each case the task has
 * to carry on, because the folder and the conversation are what actually matter
 * and both exist regardless of whether a window opened.
 */

import assert from 'node:assert/strict';

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

// A display, so the headless path is something the tests choose rather than
// inherit from whatever machine this runs on.
process.env.DISPLAY = process.env.DISPLAY || ':0';
process.env.OPEN_IN_EDITOR = 'true';
// `true` exits 0 and does nothing, which is exactly a launcher that worked.
process.env.EDITOR_COMMAND = 'true';

const { openInEditor, forgetOpened } = await import('../src/editor.js');

const lines = [];
const log = (emoji, event, message, extra = {}) => lines.push({ event, message, ...extra });
const reset = () => {
  forgetOpened();
  lines.length = 0;
};

await check('a folder is opened once and then left alone', async () => {
  reset();
  assert.equal(await openInEditor('/tmp/task-a'), 'opened');
  // A task with eight rounds of revision would otherwise stack eight windows.
  assert.equal(await openInEditor('/tmp/task-a'), 'already');
  assert.equal(await openInEditor('/tmp/task-b'), 'opened');
});

await check('turning it off means nothing is launched', async () => {
  reset();
  assert.equal(await openInEditor('/tmp/task-c', { enabled: false }), 'disabled');
});

await check('the dashboard switch beats the machine’s own setting', async () => {
  reset();
  // config says on (OPEN_IN_EDITOR above); the caller passes off, and wins.
  assert.equal(await openInEditor('/tmp/task-d', { enabled: false }), 'disabled');
  assert.equal(await openInEditor('/tmp/task-d', { enabled: true }), 'opened');
});

await check('a machine with no screen skips it and says why', async () => {
  reset();
  const display = process.env.DISPLAY;
  const wayland = process.env.WAYLAND_DISPLAY;
  delete process.env.DISPLAY;
  delete process.env.WAYLAND_DISPLAY;
  try {
    if (process.platform === 'linux') {
      assert.equal(await openInEditor('/tmp/task-e', { log }), 'headless');
      assert.equal(lines.at(-1).event, 'editor_skipped');
      assert.equal(lines.at(-1).level, 'warn');
      // Said once. A headless worker handles every task there is.
      assert.equal(await openInEditor('/tmp/task-e', { log }), 'already');
    }
  } finally {
    if (display) process.env.DISPLAY = display;
    if (wayland) process.env.WAYLAND_DISPLAY = wayland;
  }
});

await check('a missing editor is a warning, not a failure', async () => {
  /*
   * In a child process, because config.js reads the environment once at import
   * and re-importing this module will not re-read it. Worth the process: this
   * is the case that decides whether a machine without VS Code can still work
   * tasks at all.
   */
  const { execFileSync } = await import('node:child_process');
  const script = `
    const { openInEditor } = await import('${new URL('../src/editor.js', import.meta.url).href}');
    const lines = [];
    const result = await openInEditor('/tmp/task-f', {
      log: (emoji, event, message, extra = {}) => lines.push({ event, ...extra }),
    });
    console.log(JSON.stringify({ result, last: lines.at(-1) }));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: {
      ...process.env,
      OPEN_IN_EDITOR: 'true',
      EDITOR_COMMAND: 'definitely-not-an-editor-9f3a',
      DISPLAY: ':0',
    },
    encoding: 'utf8',
  });
  const { result, last } = JSON.parse(out);
  assert.equal(result, 'failed', 'a launcher that is not there has failed');
  assert.equal(last.event, 'editor_failed');
  assert.equal(last.level, 'warn', 'warn, so the task carries on');
});

await check('opening is reported so the log says where to look', async () => {
  reset();
  await openInEditor('/tmp/task-g', { log });
  const line = lines.at(-1);
  assert.equal(line.event, 'editor_opened');
  assert.match(line.message, /\/tmp\/task-g/);
  assert.ok(!line.level, 'a window opening is not a warning');
});

console.log(failures ? `\n${failures} editor check(s) failed` : '\nthe editor stays out of the way');
process.exit(failures ? 1 : 0);
