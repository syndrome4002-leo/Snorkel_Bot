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
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
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
function runTurn(prompt, { cwd, sessionId, resume, addDirs = [], timeoutMs, onLog, model }) {
  const args = ['--print', '--output-format', 'json'];

  if (resume) args.push('--resume', sessionId);
  else args.push('--session-id', sessionId);

  if (config.claude.permissionMode) args.push('--permission-mode', config.claude.permissionMode);
  /*
   * The dashboard's choice, then the env var, then whatever the CLI is set to.
   *
   * Worth having on the dashboard because it is the largest single lever on what
   * a task costs, and it wants trying on one machine before all of them: the
   * cheaper model is only cheaper if it does not need more rounds to get there.
   */
  const wanted = model || config.claude.model;
  if (wanted) args.push('--model', wanted);
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
 * A conversation you can add to a turn at a time.
 *
 * The build has to look at what came back before deciding what to ask next — a
 * task judged invalid gets no further prompts at all — so the turns cannot be
 * queued up in advance.
 *
 * `resume` continues an earlier session by id. Claude Code keeps sessions on
 * disk, so a task coming back hours later with a failed check can be handed the
 * failure inside the conversation that produced it, still holding the documents,
 * the task and the answers it wrote. Starting fresh would mean paying to read all
 * of that again and hoping for the same conclusions.
 */
/**
 * Where Claude Code keeps the conversations for one working directory.
 *
 * Its own layout, reproduced rather than asked for: the CLI has no command that
 * answers "what sessions exist for this folder". The rule is the absolute path
 * with everything that is not a letter or a digit turned into a dash, which is
 * checked against the real directories in the tests.
 */
function sessionDirFor(cwd) {
  return path.join(
    process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude'),
    'projects',
    String(cwd).replace(/[^a-zA-Z0-9]/g, '-')
  );
}

/**
 * The conversation to continue for a task folder, newest first.
 *
 * A task is meant to have exactly one, and the id is on the task record — but a
 * record can lose it (a round that died before it was written, a task built
 * before ids were stored), and starting over is the expensive answer to that.
 * The folder itself knows: whatever conversation was last written there is the
 * one this task has been having.
 *
 * `preferred` wins when it is still on disk, so the record stays authoritative
 * where it can be.
 */
export async function latestSessionFor(cwd, preferred = null) {
  const dir = sessionDirFor(cwd);

  let entries = [];
  try {
    entries = (await readdir(dir)).filter((name) => name.endsWith('.jsonl'));
  } catch {
    return null; // no conversation has ever been had here
  }

  const ids = entries.map((name) => name.replace(/\.jsonl$/, ''));
  if (preferred && ids.includes(preferred)) return preferred;

  const dated = await Promise.all(
    entries.map(async (name) => ({
      id: name.replace(/\.jsonl$/, ''),
      at: await stat(path.join(dir, name)).then((s) => s.mtimeMs).catch(() => 0),
    }))
  );
  dated.sort((a, b) => b.at - a.at);
  return dated.length ? dated[0].id : null;
}

export function openSession({
  cwd,
  addDirs = [],
  timeoutMs,
  onLog,
  label = '',
  resume = null,
  preamble = null,
  model = '',
  onSessionId = null,
} = {}) {
  let sessionId = resume || randomUUID();
  const started = Date.now();
  const turns = [];
  let resumed = Boolean(resume);

  if (onLog) onLog(`session ${sessionId}${resume ? ' (resumed)' : ''}${label ? ` (${label})` : ''}`);

  const left = () => (timeoutMs ? timeoutMs - (Date.now() - started) : 0);
  const run = (prompt) =>
    runTurn(prompt, { cwd, sessionId, resume: resumed, addDirs, timeoutMs: left(), onLog, model });

  /**
   * The first turn, which is the only one that can find the conversation gone.
   *
   * Claude Code keeps sessions on disk per project, so an id recorded days ago
   * may no longer resolve — the store was cleared, or the folder moved. That is
   * a reason to start again, not to fail the task, so a resume that does not
   * take becomes a fresh session with `preamble` (the documents) sent first,
   * which is exactly what a session that was never resumed does.
   *
   * A timeout is excluded: Claude working for an hour and being cut off says
   * nothing about whether the session existed, and re-running the whole thing
   * on that basis would spend another hour to reach the same place.
   */
  async function firstTurn(prompt) {
    if (resumed) {
      try {
        return await run(prompt);
      } catch (err) {
        if (/still working after/i.test(String(err?.message || ''))) throw err;
        if (onLog) onLog(`could not resume ${sessionId} (${err.message}) — starting a fresh session`);
        sessionId = randomUUID();
        resumed = false;
        // The conversation this task was carrying is gone; whoever is keeping
        // track needs the new id before the next round looks for the old one.
        if (onSessionId) onSessionId(sessionId, { lost: true });
      }
    }

    if (preamble) {
      const text = typeof preamble === 'function' ? await preamble() : preamble;
      if (text) {
        turns.push(await run(text));
        resumed = true;
      }
    }
    return run(prompt);
  }

  return {
    get id() {
      return sessionId;
    },
    get resumed() {
      return resumed && Boolean(resume) && sessionId === resume;
    },
    turns,

    async send(prompt) {
      // The budget is for the whole session, so each turn gets what is left.
      if (timeoutMs && left() <= 0) {
        throw new Error(`Ran out of time before turn ${turns.length + 1}.`);
      }

      const first = turns.length === 0;
      const turn = first ? await firstTurn(prompt) : await run(prompt);
      resumed = true;
      turns.push(turn);
      /*
       * Recorded as soon as there is a conversation to record, not when the
       * round finishes. A round that fails after this point still has to leave
       * the next one somewhere to continue from — otherwise every failure
       * silently starts the task over from an empty context.
       */
      if (first && onSessionId) onSessionId(sessionId, { lost: false });
      return turn;
    },

    get costUsd() {
      return turns.reduce((sum, t) => sum + (t.cost || 0), 0);
    },
    get durationMs() {
      return Date.now() - started;
    },
  };
}

/**
 * Runs `prompts` in order against one folder, as a single conversation.
 *
 * The simple case, where every turn is known up front.
 */
export async function runSession(prompts, options = {}) {
  const session = openSession(options);
  for (const prompt of prompts) await session.send(prompt);

  return {
    sessionId: session.id,
    turns: session.turns,
    /** What Claude said last — for a revision, this is the answer to store. */
    finalText: session.turns.length ? session.turns[session.turns.length - 1].text : '',
    costUsd: session.costUsd,
    durationMs: session.durationMs,
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
