/*
 * prompts.js — the text handed to Claude, kept in files rather than in code.
 *
 * The wording matters more than anything else here and it is the thing most
 * likely to be tweaked. Editing prompts/*.txt takes effect on the next task with
 * no restart and no code change, so trying a different phrasing does not mean
 * touching a source file.
 */

import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

/** Anything else in a docs folder is noise; these are the readable formats. */
const DOC_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.json', '.toml', '.yaml', '.yml']);

const cache = new Map();

async function template(name) {
  if (cache.has(name)) return cache.get(name);
  const file = path.join(config.promptsDir, `${name}.txt`);
  try {
    const text = await readFile(file, 'utf8');
    cache.set(name, text);
    return text;
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`Prompt template not found: ${file}. It ships with the worker — restore it from git.`);
    }
    throw err;
  }
}

/** `{{key}}` -> value. An unknown placeholder is left alone rather than blanked. */
function fill(text, values) {
  return text.replace(/\{\{(\w+)\}\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key] ?? '') : match
  );
}

/**
 * The reference documents, as a list of absolute paths.
 *
 * Paths, not contents: Claude Code reads files itself, and pasting seven guides
 * inline would spend most of the context window before the task is mentioned.
 */
export async function documentPaths() {
  if (!config.docsDir) return [];

  if (config.docFiles.length) {
    return config.docFiles.map((name) =>
      path.isAbsolute(name) ? name : path.join(config.docsDir, name)
    );
  }

  try {
    const entries = await readdir(config.docsDir);
    const files = [];
    for (const name of entries.sort()) {
      if (!DOC_EXTENSIONS.has(path.extname(name).toLowerCase())) continue;
      const full = path.join(config.docsDir, name);
      if ((await stat(full)).isFile()) files.push(full);
    }
    return files;
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.warn(`[prompts] DOCS_DIR does not exist: ${config.docsDir} — no documents will be attached`);
      return [];
    }
    throw err;
  }
}

/** Turn one: the documents, before anything about the task is said. */
export async function introPrompt(docs) {
  return fill(await template('intro'), {
    docs: docs.length
      ? docs.map((file) => `- ${file}`).join('\n')
      : '(no documents were configured — DOCS_DIR is unset)',
  });
}

/**
 * Turn two, for a task that has just been downloaded.
 *
 * `initial_infos` goes in raw. The template already introduces it, and a second
 * heading in the middle of a block the reviewer's form quotes verbatim would be
 * one more thing for Claude to echo back.
 */
export async function buildPrompt({ uid, taskDir, initialInfos }) {
  return fill(await template('build'), {
    uid,
    task_dir: taskDir,
    initial_infos: initialInfos || '(the platform showed no task info)',
  });
}

let schemaCache = null;

/**
 * The answer keys, from prompts/answers.schema.json.
 *
 * Kept in a file rather than in code so the set of fields, the wording of the
 * allowed values, and the prompt that asks for them all move together. Adding a
 * key there is enough; nothing here needs to know about it.
 */
export async function answerSchema() {
  if (schemaCache) return schemaCache;
  const file = path.join(config.promptsDir, 'answers.schema.json');
  const parsed = JSON.parse(await readFile(file, 'utf8'));
  delete parsed['//'];
  schemaCache = parsed;
  return schemaCache;
}

/** Only the keys a given run is allowed to produce. */
export async function schemaForStage(stage) {
  const schema = await answerSchema();
  if (!stage) return schema;
  return Object.fromEntries(
    Object.entries(schema).filter(([, spec]) => !spec.stages || spec.stages.includes(stage))
  );
}

/** The schema written out as something readable in a prompt. */
function describeFields(schema) {
  return Object.entries(schema)
    .map(([key, spec]) => {
      const bits = [];
      if (spec.enum && spec.list) bits.push(`array, any of: ${spec.enum.map((v) => `"${v}"`).join(', ')}`);
      else if (spec.enum) bits.push(`one of: ${spec.enum.map((v) => `"${v}"`).join(', ')}`);
      else if (spec.number) bits.push('a number of minutes');
      else if (spec.list) bits.push('array of strings');
      else bits.push('text');

      if (spec.question) bits.push(`question ${spec.question}`);
      if (spec.when) bits.push(`only when ${spec.when}`);
      return `  "${key}": ${bits.join('; ')}`;
    })
    .join('\n');
}

/**
 * The last turn: the same answers, as JSON.
 *
 * A separate turn rather than asking for JSON up front, because the answers
 * themselves have to read as prose a person wrote, and "reply in JSON" would
 * pull against every instruction about tone in the question sheet. Reformatting
 * something already written is a much smaller ask than writing it twice.
 */
export async function extractPrompt(stage = null) {
  return fill(await template('extract'), { fields: describeFields(await schemaForStage(stage)) });
}

/**
 * Turn two of a first build: is this task worth fixing at all?
 *
 * Asked on its own, before any work, because the answer decides whether there is
 * any work to do. A task that is invalid or already valid needs no corrections,
 * no zip and no form answers, and asking for them in the same breath would get
 * them written anyway.
 */
export async function triagePrompt({ uid, taskDir, initialInfos }) {
  return fill(await template('triage'), {
    uid,
    task_dir: taskDir,
    initial_infos: initialInfos || '(the platform showed no task info)',
  });
}

/** Turn three, only when triage said fixable: do the work and answer the form. */
export async function fixPrompt({ uid, taskDir, lessons = '' }) {
  return fill(await template('fix'), { uid, task_dir: taskDir, lessons: lessons ? `${lessons}\n` : '' });
}

/** After the platform's own checks failed: here is what it said, fix it. */
export async function staticFixPrompt({ uid, taskDir, logs, lessons = '' }) {
  return fill(await template('staticfix'), { uid, task_dir: taskDir, logs, lessons });
}

/** Asked once a fix is done: what should the next task have known? */
export async function lessonPrompt() {
  return template('lesson');
}

/**
 * Turn two, for a task the reviewer sent back.
 *
 * Built from the newest round only. Earlier rounds appear as a list of notes
 * already dealt with, not as more work: their corrections are already in the
 * folder, and putting the text back in front of the model invites it to redo
 * them, which is how a revision undoes the round before it.
 */
export async function revisionPrompt({ uid, taskDir, feedbacks, applied = [] }) {
  const rounds = Array.isArray(feedbacks) ? feedbacks : [];
  const latest = rounds[rounds.length - 1] || null;
  const notes = reviewerNotes(latest);
  const seen = noteAlreadyApplied(notes, applied);

  return fill(await template('revision'), {
    uid,
    task_dir: taskDir,
    note_status: noteStatusLine(notes, seen),
    // Empty when there is no note: the status line above already says so, and
    // saying it twice reads like two different pieces of information.
    reviewer_notes: notes,
    automated_checks: automatedChecks(latest),
    history: roundHistory(rounds, applied),
  });
}

/** A reviewer's note reduced to something two rounds can be compared on. */
export function noteFingerprint(text) {
  const flat = String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat) return '';
  return createHash('sha1').update(flat).digest('hex').slice(0, 16);
}

const REVIEWER_NOTE = /reviewer/i;

/** The human's note out of a round, without the platform's own note cards. */
export function reviewerNotes(round) {
  const notes = Array.isArray(round?.notes) ? round.notes : [];
  return notes
    .filter((note) => REVIEWER_NOTE.test(String(note?.title || '')))
    .map((note) => String(note.body || '').trim())
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

const noteAlreadyApplied = (notes, applied) =>
  !!notes && applied.some((entry) => entry?.hash === noteFingerprint(notes));

/**
 * Whether this note is new, said plainly.
 *
 * The alternative is the instruction "ignore this if you have seen it before",
 * which asks the model to remember across sessions that were never the same
 * conversation. The worker knows the answer — it recorded it last time — so it
 * says which case this is instead of asking.
 */
function noteStatusLine(notes, seen) {
  if (!notes) return '( the reviewer left no note this round — the checks below are all there is )';
  if (seen) {
    return (
      '( YOU HAVE ALREADY WORKED ON THIS EXACT NOTE in an earlier round, and those\n' +
      '  changes are in the folder now. Do not do that work again. Read it as context,\n' +
      '  check it really was applied, and otherwise fix only what the Automated Checks\n' +
      '  below say. )'
    );
  }
  return '( this note is new — it has not been worked on before )';
}

/**
 * The automated side of a round: the platform's own note card and the check
 * panes, in the order the page shows them.
 */
function automatedChecks(round) {
  if (!round) return '(no automated checks were recorded for this round)';

  const parts = [];

  for (const note of Array.isArray(round.notes) ? round.notes : []) {
    if (REVIEWER_NOTE.test(String(note?.title || ''))) continue;
    const body = String(note?.body || '').trim();
    if (body) parts.push(`## ${note.title || 'Automated feedback'}\n${body}`);
  }

  for (const check of Array.isArray(round.checks) ? round.checks : []) {
    const body = String(check?.text || '').trim();
    if (body) parts.push(`## ${check.title || check.testid || 'check'}\n${body}`);
  }

  /*
   * Falls back to the flattened round rather than saying nothing. `notes` and
   * `checks` are what the extension stores today; a round written by an older
   * version, or by hand, still has to reach the model.
   */
  if (!parts.length) {
    const flat = sectionsOf(round);
    return flat || '(no automated checks were recorded for this round)';
  }
  return parts.join('\n\n');
}

/** The rounds before this one, as a reminder of what is already done. */
function roundHistory(rounds, applied) {
  if (rounds.length < 2) return '';

  const lines = rounds.slice(0, -1).map((round, index) => {
    const notes = reviewerNotes(round);
    const when = round.collected_at || round.at || '';
    const done = notes && applied.some((entry) => entry?.hash === noteFingerprint(notes));
    const first = notes ? notes.split('\n').find((l) => l.trim()) || '' : '';
    return (
      `  - round ${index + 1}${when ? ` (${when.slice(0, 10)})` : ''}: ` +
      (notes ? `"${first.slice(0, 120)}"${done ? ' — worked on' : ''}` : 'automated checks only')
    );
  });

  return `\nEarlier rounds on this task, already dealt with:\n${lines.join('\n')}\n`;
}

/**
 * One round flattened into text — the fallback for a round in an older shape.
 *
 * Anything string-shaped is included rather than only a known list, so a round
 * stored before `notes` and `checks` existed, or one written by hand, still
 * reaches the model instead of vanishing silently from the prompt.
 */
function sectionsOf(round) {
  if (typeof round === 'string') return round.trim();
  if (!round || typeof round !== 'object') return String(round ?? '').trim();

  const skip = new Set(['collected_at', 'at', 'created_at', 'uid', 'UID', 'url', 'round']);
  const parts = [];

  for (const [key, value] of Object.entries(round)) {
    if (skip.has(key)) continue;
    const text = flatten(value);
    if (text) parts.push(`## ${key}\n${text}`);
  }

  return parts.length ? parts.join('\n\n') : JSON.stringify(round, null, 2);
}

function flatten(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(flatten).filter(Boolean).join('\n\n');
  if (typeof value === 'object') {
    return Object.entries(value)
      .map(([key, inner]) => {
        const text = flatten(inner);
        return text ? `### ${key}\n${text}` : '';
      })
      .filter(Boolean)
      .join('\n\n');
  }
  return String(value);
}
