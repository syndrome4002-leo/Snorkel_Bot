/*
 * claude.js — runs the Claude Code agent over a task folder.
 *
 * A session is a real conversation, not a single shot. The first turn hands over
 * the reference documents; the second gives the task. That order is the point —
 * asking Claude to read the guidelines *and* do the work in one message means it
 * starts forming an answer before it has read anything.
 *
 * Turn one fixes the session id, turn two resumes it. Generating the id here
 * rather than parsing it back out means a crash between the two turns still
 * leaves a session that can be resumed by hand:
 *
 *   claude --resume <the id printed in the logs>
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';

/** Turned into the CLI's own error message when it is not installed. */
function notInstalled(err) {
  return new Error(
    `Could not run "${config.claude.bin}": ${err.message}. Install Claude Code ` +
      `(npm i -g @anthropic-ai/claude-code) or point CLAUDE_BIN at the executable.`
  );
}

/**
 * One turn. Resolves with the assistant's final text plus what it cost.
 *
 * `--output-format json` is what makes this usable unattended: the wrapper
 * carries an explicit is_error flag, so a run that failed halfway is not
 * mistaken for a short answer.
 *
 * The prompt goes in on stdin rather than as an argument. `--add-dir` takes a
 * variadic list, so a trailing prompt is read as one more directory and the CLI
 * then complains that no prompt was given. stdin sidesteps that, and along with
 * it any limit on how long a feedback round can be.
 */
function runTurn(prompt, { cwd, sessionId, resume, addDirs = [], timeoutMs, onLog }) {
  const args = ['--print', '--output-format', 'json'];

  if (resume) args.push('--resume', sessionId);
  else args.push('--session-id', sessionId);

  if (config.claude.permissionMode) args.push('--permission-mode', config.claude.permissionMode);
  if (config.claude.model) args.push('--model', config.claude.model);
  for (const dir of addDirs) args.push('--add-dir', dir);
  args.push(...config.claude.extraArgs);

  return new Promise((resolve, reject) => {
    const child = spawn(config.claude.bin, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    // A child that dies before reading everything would otherwise take the
    // parent down with an unhandled EPIPE.
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);

    let out = '';
    let err = '';
    let timedOut = false;

    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          // SIGTERM first so the CLI can tidy up; SIGKILL only if it will not go.
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), 15_000).unref?.();
        }, timeoutMs)
      : null;

    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => {
      err += chunk;
      // The CLI reports progress on stderr; surface it rather than swallowing
      // it, so a long run does not look like a hang.
      if (onLog) String(chunk).split('\n').filter(Boolean).forEach(onLog);
    });

    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(e.code === 'ENOENT' ? notInstalled(e) : e);
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);

      if (timedOut) {
        return reject(new Error(`Claude was still working after ${Math.round(timeoutMs / 60000)} minutes.`));
      }

      let payload = null;
      try {
        payload = JSON.parse(out);
      } catch {
        // Fall through: an unparseable body with a non-zero exit is reported below.
      }

      if (code !== 0 && !payload) {
        return reject(
          new Error(`Claude exited ${code}: ${(err || out).trim().slice(0, 800) || 'no output'}`)
        );
      }
      if (payload?.is_error) {
        return reject(new Error(`Claude reported an error: ${String(payload.result || '').slice(0, 800)}`));
      }

      resolve({
        text: String(payload?.result ?? out).trim(),
        sessionId: payload?.session_id || sessionId,
        turns: payload?.num_turns ?? null,
        cost: payload?.total_cost_usd ?? null,
        durationMs: payload?.duration_ms ?? null,
      });
    });
  });
}

/**
 * Runs `prompts` in order against one folder, as a single conversation.
 *
 * Returns every turn, because the *last* one is the answer worth storing but the
 * earlier ones are what you read when the answer looks wrong.
 */
export async function runSession(prompts, { cwd, addDirs = [], timeoutMs, onLog, label = '' } = {}) {
  const sessionId = randomUUID();
  const started = Date.now();
  const turns = [];

  if (onLog) onLog(`session ${sessionId}${label ? ` (${label})` : ''}`);

  for (const [index, prompt] of prompts.entries()) {
    // The budget is for the whole session, so each turn gets what is left.
    const remaining = timeoutMs ? timeoutMs - (Date.now() - started) : 0;
    if (timeoutMs && remaining <= 0) {
      throw new Error(`Ran out of time before turn ${index + 1} of ${prompts.length}.`);
    }

    const turn = await runTurn(prompt, {
      cwd,
      sessionId,
      resume: index > 0,
      addDirs,
      timeoutMs: remaining,
      onLog,
    });
    turns.push(turn);
  }

  return {
    sessionId,
    turns,
    /** What Claude said last — for a revision, this is the answer to store. */
    finalText: turns.length ? turns[turns.length - 1].text : '',
    costUsd: turns.reduce((sum, t) => sum + (t.cost || 0), 0),
    durationMs: Date.now() - started,
  };
}

/** Confirms the CLI is there and runnable, without starting a task. */
export async function checkClaude() {
  return new Promise((resolve, reject) => {
    const child = spawn(config.claude.bin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.on('error', (err) => reject(err.code === 'ENOENT' ? notInstalled(err) : err));
    child.on('close', (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Error(`${config.claude.bin} --version exited ${code}`))
    );
  });
}
