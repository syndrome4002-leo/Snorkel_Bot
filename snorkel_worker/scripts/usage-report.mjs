/*
 * usage-report.mjs — what Claude actually cost, read back from its own logs.
 *
 * Run it whenever you want the figure:  npm run usage
 * Compare two periods:                  npm run usage -- --since 2026-08-07T20:41Z
 *
 * Claude Code writes one JSONL per conversation under CLAUDE_CONFIG_DIR, and
 * every assistant line carries the usage the API reported for that call. So the
 * spend is already on disk; nothing here asks Anthropic anything.
 *
 * A "prompt" below is one thing the worker asked for and everything Claude did
 * about it — the turn boundary the worker controls, and the only unit where
 * "this prompt kind costs too much" is a statement you can act on.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';

const MILLION = 1_000_000;

/*
 * Opus 4.6 list rates. Cache reads bill at a tenth of input and writes at
 * 1.25x, which is the whole reason a one-call bookkeeping prompt can cost more
 * than an hour of real work: it arrives cold and rewrites the conversation.
 */
const RATES = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };

const sessionRoot = () =>
  path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude'), 'projects');

/*
 * Which prompt this was. Matched on the opening words because that is what the
 * worker's own prompt files start with — see prompts/. Anything unrecognised is
 * reported as "other" rather than dropped, so the total stays honest.
 */
function promptKind(text) {
  const t = text.replace(/\s+/g, ' ').trim().toLowerCase();
  if (t.startsWith('now put those same answers into json')) return 'extract-json';
  // Deleted in Aug 2026; kept here so old logs still read back correctly.
  if (t.startsWith('one more thing, and keep it to a couple of sentences')) return 'lesson';
  if (t.startsWith('please check these attached documents')) return 'doc-priming';
  if (t.startsWith('below is task infos') || t.startsWith('here are the sentinel')) return 'build';
  if (t.startsWith('got following feedback')) return 'static-fix';
  if (t.startsWith('make the corrections')) return 'fix';
  if (t.startsWith('the task folder is your current working directory')) return 'revision';
  if (t.startsWith('these questions on the submission form')) return 'gap-fill';
  if (t.startsWith('some of those answers need')) return 'gap-fill';
  /*
   * Not the worker: Claude Code's own context compaction, and prompts typed by
   * hand into a task folder. Both cost real money and both belong in the total,
   * but neither is something the worker's prompts can be blamed for — so they
   * are named rather than pooled into "other".
   */
  if (t.startsWith('<command-name>') || t.startsWith('<local-command-stdout>')) return 'compaction';
  if (t.startsWith('this session is being continued from a previous')) return 'compaction';
  if (t.startsWith('[request interrupted by user]')) return 'interrupted';
  return 'typed by hand';
}

const blank = () => ({ prompts: 0, calls: 0, read: 0, write: 0, input: 0, output: 0 });

function add(into, from) {
  for (const k of Object.keys(from)) into[k] += from[k];
}

const dollars = (t) =>
  (t.read * RATES.cacheRead + t.write * RATES.cacheWrite +
   t.input * RATES.input + t.output * RATES.output) / MILLION;

/* One conversation file, split at the prompts the worker sent. */
async function readSession(file) {
  const segments = [];
  let open = null;
  let body;
  try {
    body = await readFile(file, 'utf8');
  } catch {
    return segments;
  }

  for (const line of body.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a half-written last line while a session is live
    }
    const message = entry.message || {};

    if (entry.type === 'user') {
      const content = message.content;
      let text = '';
      if (Array.isArray(content)) {
        // A tool result is Claude talking to itself, not a new instruction.
        if (content.some((b) => b && b.type === 'tool_result')) continue;
        text = content.map((b) => (b && b.text) || '').join(' ');
      } else if (typeof content === 'string') {
        text = content;
      }
      if (entry.isMeta || !text.trim()) continue;
      open = { at: entry.timestamp, kind: promptKind(text), totals: blank() };
      open.totals.prompts = 1;
      segments.push(open);
    } else if (entry.type === 'assistant' && open) {
      const u = message.usage;
      if (!u) continue;
      open.totals.calls += 1;
      open.totals.read += u.cache_read_input_tokens || 0;
      open.totals.write += u.cache_creation_input_tokens || 0;
      open.totals.input += u.input_tokens || 0;
      open.totals.output += u.output_tokens || 0;
    }
  }
  return segments.filter((s) => s.totals.calls);
}

async function collect(since) {
  const root = sessionRoot();
  let projects;
  try {
    projects = await readdir(root);
  } catch {
    console.log(`no sessions where they were expected — ${root}`);
    return [];
  }

  const segments = [];
  for (const project of projects) {
    // Task folders only; this machine's other Claude work is not the worker's.
    if (!project.includes('_submission') && !project.includes('-submission')) continue;
    const dir = path.join(root, project);
    if (!(await stat(dir).catch(() => null))?.isDirectory()) continue;
    for (const name of await readdir(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      for (const seg of await readSession(path.join(dir, name))) {
        if (since && (!seg.at || seg.at < since)) continue;
        segments.push({ ...seg, task: project, session: name.slice(0, -6) });
      }
    }
  }
  return segments;
}

function table(title, segments) {
  console.log(`\n${title}`);
  if (!segments.length) {
    console.log('  nothing in this period');
    return null;
  }

  const byKind = new Map();
  const total = blank();
  const tasks = new Set();
  const sessions = new Set();
  for (const s of segments) {
    if (!byKind.has(s.kind)) byKind.set(s.kind, blank());
    add(byKind.get(s.kind), s.totals);
    add(total, s.totals);
    tasks.add(s.task);
    sessions.add(`${s.task}/${s.session}`);
  }

  const spend = dollars(total);
  const pad = (v, w) => String(v).padStart(w);
  console.log(
    `  ${'prompt kind'.padEnd(14)}${pad('runs', 6)}${pad('calls', 7)}` +
    `${pad('read M', 9)}${pad('write M', 9)}${pad('out k', 8)}${pad('$', 9)}${pad('share', 8)}`
  );
  const rows = [...byKind.entries()].sort((a, b) => dollars(b[1]) - dollars(a[1]));
  for (const [kind, t] of rows) {
    const d = dollars(t);
    console.log(
      `  ${kind.padEnd(14)}${pad(t.prompts, 6)}${pad(t.calls, 7)}` +
      `${pad((t.read / MILLION).toFixed(1), 9)}${pad((t.write / MILLION).toFixed(2), 9)}` +
      `${pad((t.output / 1000).toFixed(0), 8)}${pad(d.toFixed(2), 9)}` +
      `${pad(`${((100 * d) / spend).toFixed(1)}%`, 8)}`
    );
  }
  console.log(
    `  ${'total'.padEnd(14)}${pad(total.prompts, 6)}${pad(total.calls, 7)}` +
    `${pad((total.read / MILLION).toFixed(1), 9)}${pad((total.write / MILLION).toFixed(2), 9)}` +
    `${pad((total.output / 1000).toFixed(0), 8)}${pad(spend.toFixed(2), 9)}`
  );

  const perTask = spend / tasks.size;
  console.log(
    `  ${tasks.size} task(s), ${sessions.size} conversation(s) ` +
    `(${(sessions.size / tasks.size).toFixed(1)} per task), $${perTask.toFixed(2)} per task`
  );
  return { spend, tasks: tasks.size, perTask };
}

const args = process.argv.slice(2);
const sinceAt = args.indexOf('--since');
const since = sinceAt === -1 ? null : args[sinceAt + 1];

const all = await collect(null);
if (since) {
  const before = table(`before ${since}`, all.filter((s) => s.at && s.at < since));
  const after = table(`since ${since}`, all.filter((s) => s.at && s.at >= since));
  if (before && after) {
    const change = (100 * (after.perTask - before.perTask)) / before.perTask;
    console.log(
      `\nper task: $${before.perTask.toFixed(2)} → $${after.perTask.toFixed(2)} ` +
      `(${change >= 0 ? '+' : ''}${change.toFixed(0)}%)`
    );
    if (after.tasks < 3) {
      console.log('too few tasks since the cutover to read much into that yet.');
    }
  }
} else {
  table('all recorded task work', all);
  console.log('\npass --since <ISO timestamp> to split it either side of a change.');
}
console.log();
