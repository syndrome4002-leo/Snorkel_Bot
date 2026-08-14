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

/**
 * Only the keys a given run is allowed to produce, with the options that stage
 * actually offers.
 *
 * The same question can be asked by two different forms with two different sets
 * of answers. "What issue did you find with the task/components?" is one: the
 * fixable form lists seven categories about the instructions and the tests, and
 * the unfixable form lists two about scope and the environment. They share a
 * name and a meaning and nothing else.
 *
 * Handing the fixable list to a run that will fill the unfixable form is how a
 * task ends up with answers that match none of the boxes on the page, which the
 * form filler then — correctly — refuses to guess at, leaving the question
 * blank.
 */
export async function schemaForStage(stage) {
  const schema = await answerSchema();
  if (!stage) return schema;
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([, spec]) => !spec.stages || spec.stages.includes(stage))
      .map(([key, spec]) => {
        const forStage = spec.enum_by_stage && spec.enum_by_stage[stage];
        return [key, forStage ? { ...spec, enum: forStage } : spec];
      })
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
 * Asked when the extraction came back without a question the form requires.
 *
 * Deliberately narrow: the keys named and nothing else. A broad "check your
 * answers" turn invites rewriting the ones that were fine, and those have
 * already been through the narration and formatting checks.
 */
export async function gapPrompt(stage, keys) {
  const schema = await schemaForStage(stage);
  const wanted = Object.fromEntries(keys.filter((key) => schema[key]).map((key) => [key, schema[key]]));

  return [
    'These questions on the submission form have no answer yet:',
    '',
    describeFields(wanted),
    '',
    'Answer them now, from the task you have just been working on. Same wording and',
    'tone as the answers above — plain language, no markdown, nothing about rounds or',
    'feedback or checks, and for a key with allowed values use one of them exactly as',
    'written.',
    '',
    'Reply with a JSON object holding only those keys and nothing else around it. If',
    'one genuinely does not apply to this task, leave it out rather than inventing',
    'something for it.',
  ].join('\n');
}

/**
 * The answers asked for in the same breath as the work, not in a second turn.
 *
 * Every prompt the worker sends is a separate `claude --print` process, and each
 * one arrives with a cold cache: the conversation is re-written at full input
 * price before anything happens. Measured on one task, that was 52 rebuilds
 * totalling 14.1M tokens — more than the reads. A person working in one editor
 * session sends one message and the cache stays warm between them.
 *
 * So the work and the answers are asked for together and come back
 * in one reply. `parseJsonReply` already reads a fenced block out of prose, so
 * the prose stays readable and the JSON is still machine-readable.
 */
export async function answersBlock(stage = null) {
  const schema = await schemaForStage(stage);
  return [
    '',
    '---',
    '',
    'When the work is done, and in this same reply, write the answers to the',
    'submission questions twice over.',
    '',
    'First in prose, the way a person fills in a form.',
    '',
    'Then the same answers as JSON in a ```json fenced block, and nothing after it:',
    '',
    describeFields(schema),
    '',
    'Rules for the JSON: leave out any key that does not apply, use the allowed',
    'values exactly as written, and keep the wording you used above — it is a',
    'change of format, not a second attempt at the answer.',
  ].join('\n');
}

/**
 * The answers section for a build, which does not yet know its own verdict.
 *
 * A build used to be two prompts: judge the task, then — knowing the judgement —
 * ask for the work and the matching form. That is two cold starts to do one
 * job, and the first produced a single word.
 *
 * Asking for both in one reply means the form has to be described before the
 * judgement exists, so all three are laid out and Claude fills the one its own
 * judgement calls for. The alternative — describing only the fixable form and
 * letting a non-fixable verdict fall through to the gap-fill turn — would put
 * the prompt we just saved straight back, on exactly the tasks that need it
 * least.
 */
export async function buildAnswersBlock() {
  const forVerdict = async (verdict, label) =>
    [`If your judgement is ${label}, answer these:`, '', describeFields(await schemaForStage(verdict))].join('\n');

  return [
    '',
    '---',
    '',
    'When the work is done, and in this same reply, write the answers to the',
    'submission questions twice over.',
    '',
    'First in prose, the way a person fills in a form.',
    '',
    'Then the same answers as JSON in a ```json fenced block, and nothing after it.',
    'Which questions apply depends on the judgement you gave at the top:',
    '',
    await forVerdict('build', 'FIXABLE'),
    '',
    await forVerdict('invalid', 'INVALID'),
    '',
    await forVerdict('valid-as-is', 'VALID-AS-IS'),
    '',
    'Rules for the JSON: answer only the set that matches your judgement, leave',
    'out any key that does not apply, use the allowed values exactly as written,',
    'and keep the wording you used above — it is a change of format, not a second',
    'attempt at the answer.',
  ].join('\n');
}

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
export async function fixPrompt({ uid, taskDir }) {
  return fill(await template('fix'), { uid, task_dir: taskDir });
}

/** After the platform's own checks failed: here is what it said, fix it. */
export async function staticFixPrompt({ uid, taskDir, logs }) {
  return fill(await template('staticfix'), { uid, task_dir: taskDir, logs });
}

/**
 * Asked only when an answer talks about rounds instead of about the task.
 *
 * A separate turn rather than a stricter extraction prompt, because it is worth
 * showing the model the actual sentence it wrote. Costs a turn, and only on the
 * runs that need it.
 */
export async function rewritePrompt(offenders) {
  const list = offenders
    .map((o) => {
      if (o.kind === 'verdict') return `  ${o.key}: this item never says whether it is fixable — ${o.match}`;
      if (o.kind === 'format') return `  ${o.key}: ${o.match}`;
      return `  ${o.key}: talks about the revision process — contains "${o.match}"`;
    })
    .join('\n');
  return fill(await template('rewrite'), { offenders: list });
}

/** Asked once a fix is done: what should the next task have known? */
/**
 * The answers this task has never had.
 *
 * A revision is asked for what CHANGED, because everything else is already
 * stored and merging over it leaves the rest untouched. That assumes there is a
 * "rest" — and for a submission somebody made by hand, which this system only
 * took on when it came back for revision, there is not. Nothing was ever
 * recorded, so a round that writes only its changes produces a form with three
 * answers on it and the other nine blank.
 *
 * So the round is told which ones are missing, by name. Not "write everything
 * out again": most of the form is about the task rather than about this round,
 * and a question already answered correctly should not be re-answered for the
 * sake of it.
 */
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
