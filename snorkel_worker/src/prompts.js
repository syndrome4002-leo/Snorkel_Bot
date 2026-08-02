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
