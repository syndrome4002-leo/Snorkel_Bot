/*
 * editor.js — puts the task folder on screen while the worker works on it.
 *
 * The worker still drives Claude itself, through the CLI. This only opens the
 * folder, so there is something to watch and somewhere to step in: the editor's
 * Claude panel and the worker share one conversation per task, so a prompt typed
 * by hand lands in the same session the next round continues from.
 *
 * Nothing here is allowed to fail a task. An editor that is missing, headless or
 * slow is a worse view of the work, not a reason to stop doing it.
 */

import { spawn } from 'node:child_process';
import { config } from './config.js';

/*
 * Opening the same folder twice would stack windows over a task's rounds — eight
 * of them by the end of a long revision history. VS Code focuses an existing
 * window rather than opening a second, but only while it is still running, so
 * this remembers as well and skips the call entirely.
 */
const opened = new Set();

/**
 * Is there a screen to open a window on?
 *
 * A worker on a headless box has no display, and `code` there either fails or —
 * worse — waits. Checked rather than discovered, so the headless case costs
 * nothing and says why.
 */
function displayAvailable() {
  if (process.platform === 'darwin' || process.platform === 'win32') return true;
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

/**
 * Opens `taskDir` in the configured editor.
 *
 * Returns what happened rather than throwing: 'opened', 'already', 'disabled',
 * 'headless', or 'failed'. The caller logs it and carries on regardless.
 */
export async function openInEditor(taskDir, { log, enabled } = {}) {
  const say = log || (() => {});
  const on = enabled === undefined ? config.editor.enabled : enabled;

  if (!on || !taskDir) return 'disabled';
  if (opened.has(taskDir)) return 'already';

  if (!displayAvailable()) {
    /*
     * Once per folder, not once per round: a headless worker would otherwise
     * repeat this for every revision of every task it ever handles.
     */
    opened.add(taskDir);
    say('🖥️', 'editor_skipped', 'no display on this machine — not opening an editor', {
      level: 'warn',
    });
    return 'headless';
  }

  const bin = config.editor.command;
  const args = [...config.editor.args, taskDir];

  try {
    await new Promise((resolve, reject) => {
      /*
       * Detached and with its streams let go: `code` hands off to an existing
       * window and exits, but if this machine's editor ever decides to stay in
       * the foreground instead, the task must not be sitting behind it.
       */
      const child = spawn(bin, args, { detached: true, stdio: 'ignore' });

      // A command that never came back is the same as one that failed, from here.
      const giveUp = setTimeout(() => {
        child.unref();
        reject(new Error(`${bin} did not return within ${config.editor.timeoutSeconds}s`));
      }, config.editor.timeoutSeconds * 1000);
      giveUp.unref?.();

      child.once('error', (err) => {
        clearTimeout(giveUp);
        reject(err);
      });
      child.once('spawn', () => {
        clearTimeout(giveUp);
        child.unref();
        resolve();
      });
    });
  } catch (err) {
    // Remembered anyway: a missing editor will still be missing next round, and
    // retrying it per revision only fills the log.
    opened.add(taskDir);
    say('🖥️', 'editor_failed', `could not open ${bin}: ${err.message}`, { level: 'warn' });
    return 'failed';
  }

  opened.add(taskDir);
  say('🖥️', 'editor_opened', `opened ${taskDir} in ${bin}`);
  return 'opened';
}

/** Test seam: forget what has been opened. */
export function forgetOpened() {
  opened.clear();
}
