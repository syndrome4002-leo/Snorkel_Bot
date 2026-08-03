/*
 * prompts.js — the text handed to Claude, kept in files rather than in code.
 *
 * The wording matters more than anything else here and it is the thing most
 * likely to be tweaked. Editing prompts/*.txt takes effect on the next task with
 * no restart and no code change, so trying a different phrasing does not mean
 * touching a source file.
 */

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

/** Turn two, for a task the reviewer sent back. */
export async function revisionPrompt({ uid, taskDir, feedbacks }) {
  return fill(await template('revision'), {
    uid,
    task_dir: taskDir,
    feedbacks: renderFeedbacks(feedbacks),
  });
}

/**
 * The feedback rounds, newest last, as plain text.
 *
 * Every round goes in, not just the latest. A reviewer's second note routinely
 * assumes you still remember the first, so handing over only the newest one
 * produces answers that fix a symptom and reintroduce whatever the earlier round
 * was about.
 */
export function renderFeedbacks(feedbacks) {
  const rounds = Array.isArray(feedbacks) ? feedbacks : [];
  if (!rounds.length) return '(no feedback was recorded for this task)';

  return rounds
    .map((round, index) => {
      const when = round.collected_at || round.at || round.created_at || '';
      const head = `--- Round ${index + 1}${when ? ` (${when})` : ''}${
        index === rounds.length - 1 ? ' — this is the newest round' : ''
      } ---`;
      return `${head}\n${sectionsOf(round)}`;
    })
    .join('\n\n');
}

/**
 * One round flattened into text.
 *
 * The extension stores reviewer notes and the four automated check panes under
 * whatever keys the page used, so anything string-shaped is included rather than
 * only a known list — a pane renamed on the platform would otherwise vanish
 * silently from the prompt.
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
