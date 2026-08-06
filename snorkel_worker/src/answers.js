/*
 * answers.js — turning the model's JSON turn into the `answers` object.
 *
 * Two jobs, and the second matters more than the first: parse it, then keep only
 * what the schema recognises. An answer field is going to be pasted into the
 * platform's form, so a key nobody asked for is not a bonus, it is a value with
 * nowhere to go and no way to notice it went missing.
 */

import { answerSchema, schemaForStage } from './prompts.js';

/**
 * Pulls the JSON out of a reply.
 *
 * The prompt asks for JSON and nothing else, and usually that is what comes
 * back. But a fenced block or a sentence in front of it is a formatting slip,
 * not a failure, and throwing the whole run away over one would be a poor
 * trade — so both are handled.
 */
export function parseJsonReply(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('The model replied with nothing.');

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidates = [fenced ? fenced[1] : null, raw, sliceOutermostObject(raw)].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate.trim());
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch {
      // try the next shape
    }
  }

  throw new Error(`Could not read JSON from the reply. It started: ${raw.slice(0, 200)}`);
}

/** From the first `{` to its matching `}`, ignoring braces inside strings. */
function sliceOutermostObject(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === '{') depth++;
    if (ch === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

const clean = (value) => String(value).trim();

/** Case- and spacing-insensitive match against the allowed values. */
function matchEnum(value, allowed) {
  const needle = clean(value).toLowerCase();
  const hit = allowed.find((option) => option.toLowerCase() === needle);
  if (hit) return hit;
  // "Fixable (The task has issues...)" — the model sometimes keeps the gloss
  // from the question sheet. Take it if it starts with an allowed value.
  return allowed.find((option) => needle.startsWith(option.toLowerCase())) || null;
}

/**
 * Keeps what the schema knows about, drops what it does not, and says which was
 * which — a silently discarded answer is worse than a noisy one.
 */
/*
 * Phrases that refer to the process rather than to the task.
 *
 * An answer is read by somebody looking at the finished submission. They cannot
 * see the rounds, the feedback or the judge, so "Addressed in a previous round"
 * is not a short answer — it is no answer. The prompts say so; this is what
 * notices when that instruction does not take, because a stored answer is the
 * thing that ends up in the form.
 *
 * Deliberately narrow. "round" on its own appears in ordinary sentences about
 * rounding and about round trips, so only the process senses are matched.
 */
const PROCESS_NARRATION = [
  /*
   * A determiner is required, so "round-robin", "a round trip" and "rounds the
   * delay down" are left alone — and `rounds?` is plural too, because "earlier
   * rounds rewrote it" is the same sentence in the plural.
   */
  /\b(previous|earlier|last|prior|this)\s+rounds?(?![-\w])/i,
  /\brounds?\s+(ago|earlier|before)\b/i,
  /\baddressed\s+(in|during|by)\b/i,
  /\bin\s+an?\s+earlier\s+(pass|attempt|revision|iteration)\b/i,
  /\b(the|this)\s+(reviewer|judge|feedback|checks?)\s+(said|asked|flagged|rejected|complained)/i,
  /\bagentic judge\b/i,
  /\bas\s+(noted|mentioned|requested)\s+(in|by)\s+the\s+(feedback|review|checks?)\b/i,
  /\b(fixed|changed|done)\s+(last|previous)\s+time\b/i,
];

/**
 * Which text answers talk about the revision process instead of the task.
 *
 * Returns the field names, so the caller can ask for those to be rewritten
 * rather than throwing away a whole run over a turn of phrase.
 */
export function processNarration(answers) {
  const found = [];
  for (const [key, value] of Object.entries(answers || {})) {
    const text = Array.isArray(value) ? value.join(' ') : String(value ?? '');
    if (!text.trim()) continue;
    const hit = PROCESS_NARRATION.find((re) => re.test(text));
    if (hit) found.push({ key, match: (text.match(hit) || [])[0] });
  }
  return found;
}

/*
 * Question 3 asks for four things about every issue, in order: the category, the
 * explanation, whether it is fixable, and how. The third is the one that goes
 * missing — an issue dealt with in an earlier round tends to get a one-line
 * status instead of an item, and the verdict disappears with the rest of it:
 *
 *   1) [Instructions / Overly prescriptive]
 *   ...long explanation...
 *   This is fixable. The instruction now specifies the contract vocabulary.
 *
 *   2) [Instructions / LLM generated]
 *   Addressed in a previous round.          <- no verdict, and no answer either
 *
 * Only `issues_in_detail` is checked, because it is the only answer that has
 * numbered items with a required shape.
 */
const ITEM_START = /^\s*\d+\s*[).]/;
const HAS_VERDICT = /\b(not\s+fixable|unfixable|is\s+fixable|fixable)\b/i;

/** Splits question 3's answer into its numbered items. */
function issueItems(text) {
  const lines = String(text || '').split('\n');
  const items = [];
  let current = null;

  for (const line of lines) {
    if (ITEM_START.test(line)) {
      if (current) items.push(current);
      current = { head: line.trim(), body: [line] };
    } else if (current) {
      current.body.push(line);
    }
  }
  if (current) items.push(current);
  return items.map((i) => ({ head: i.head, text: i.body.join('\n') }));
}

const bracketOf = (head) => ((head.match(/\[([^\]]*)\]/) || [])[1] || '').trim();
const flat = (v) => String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Where question 3's answer departs from the shape the form asks for.
 *
 *   1) [Issue Category 1 - the first category you selected above]
 *   Issue Description/explanation - give specific examples in the code
 *   Is the issue fixable or not fixable?
 *   If it IS fixable, how could this be fixed? If not, explain why not.
 *
 * "The first category you selected above" is the point: the heading is one of
 * the categories ticked in question 2, written as it is written there — not a
 * label invented for the occasion. Every stored answer so far has invented them
 * ("[Instructions / Overly prescriptive]" for "the instructions are
 * overly-prescriptive"), and every one has more items than categories.
 *
 * Checked against `what_issues_found` and nothing else, so an answer written
 * before the categories were recorded is left alone rather than rewritten
 * against a list that is not there.
 */
export function issueFormatProblems(answers) {
  const text = (answers || {}).issues_in_detail;
  if (!text || Array.isArray(text)) return [];

  const asList = (v) => (Array.isArray(v) ? v : v ? [v] : []);
  const found = asList((answers || {}).what_issues_found);
  const where = asList((answers || {}).where_task_had_issues);
  if (!found.length && !where.length) return [];

  const allowed = [...found, ...where];
  const items = issueItems(text);
  if (!items.length) {
    return ['the answer has no numbered items — question 3 asks for one per category selected'];
  }

  const problems = [];
  const used = new Set();

  items.forEach((item, i) => {
    const inner = bracketOf(item.head);

    if (!inner) {
      problems.push(`item ${i + 1} has no [category] in brackets: "${item.head.slice(0, 60)}"`);
    } else {
      const match = allowed.find((c) => flat(c) === flat(inner));
      if (match) used.add(flat(match));
      else {
        problems.push(
          `item ${i + 1} is headed "[${inner.slice(0, 60)}]", which is not one of the categories ` +
            `selected above — use one of them, written exactly as it is written there`
        );
      }
    }

    // "1) [Tests] The tests.patch modified five files…" — the category shares a
    // line with the description, so the four parts become three.
    const trailing = item.head.replace(/^\s*\d+\s*[).]\s*/, '').replace(/\[[^\]]*\]/, '').trim();
    if (trailing) {
      problems.push(`item ${i + 1} runs the description onto the category line — the category is a line of its own`);
    }
  });

  /*
   * "For each issue category selected" — so every issue category needs an item.
   * Only the question 2 ones are required: question 1 says where the problems
   * were, and its labels are here so an environment finding has a heading to
   * use, not because each of them owes an item of its own.
   */
  for (const category of found) {
    if (!used.has(flat(category))) problems.push(`no item for the category "${category}"`);
  }

  return problems;
}

/**
 * Lines that are the tail of a wrapped sentence rather than a part of their own.
 *
 * The item's shape is carried entirely by its line breaks — category, then
 * explanation, then verdict, then fix — so a sentence wrapped at eighty columns
 * turns one part into three and there is nothing left to tell them apart by.
 *
 * A continuation is recognised by starting lower case. In this format nothing
 * else does: an item opens with "1)", and every other part is a sentence, so a
 * line beginning "on, which tells the agent…" can only be the middle of one.
 * Scoped to `issues_in_detail`, because a list answer like `files_changed` has
 * lower-case lines that are genuinely their own.
 */
export function wrappedLines(answers) {
  const text = (answers || {}).issues_in_detail;
  if (!text || Array.isArray(text)) return [];

  const lines = String(text).split('\n');
  const wrapped = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const previous = lines[i - 1].trim();
    if (!line.trim() || !previous) continue; // a blank line is a real break
    // The line after a "1) [category]" heading is always the description, never
    // the tail of the heading, whatever case it starts in.
    if (ITEM_START.test(lines[i - 1])) continue;
    if (!/^\s*[a-z]/.test(line)) continue;
    // A line of its own that happens to start lower case — "task.toml was
    // missing os" — follows a break, not a run-on. Only flag one that continues
    // a line which did not finish.
    if (/[.!?:;]["')\]]?$/.test(previous)) continue;
    wrapped.push(`"…${previous.slice(-32)}" / "${line.trim().slice(0, 32)}…"`);
  }

  return wrapped;
}

/**
 * Items that never say whether the issue is fixable.
 *
 * Returns the item headings, so the rewrite can name exactly which ones are
 * short rather than asking for the whole answer again.
 */
export function missingVerdicts(answers) {
  const text = (answers || {}).issues_in_detail;
  if (!text || Array.isArray(text)) return [];

  const items = issueItems(text);
  // No numbered items at all: a single-issue answer is allowed to be prose, and
  // demanding a format nobody asked for would be worse than the gap.
  if (items.length < 2) return [];

  return items.filter((item) => !HAS_VERDICT.test(item.text)).map((item) => item.head.slice(0, 80));
}

export async function normaliseAnswers(parsed, { stage = null } = {}) {
  // Checked against the stage's own options where they differ from the general
  // ones — otherwise a perfectly good answer to the unfixable form's question is
  // rejected for not being one of the fixable form's categories.
  const schema = stage ? await schemaForStage(stage) : await answerSchema();
  const answers = {};
  const ignored = [];
  const problems = [];

  for (const [key, value] of Object.entries(parsed)) {
    const spec = schema[key];
    if (!spec) {
      ignored.push(key);
      continue;
    }
    // A key left out is the documented way to say "does not apply", so an empty
    // one is the same thing said less clearly.
    if (value === null || value === undefined || clean(value) === '') continue;

    if (spec.number) {
      const n = Number(String(value).replace(/[^\d.]/g, ''));
      if (!Number.isFinite(n)) {
        problems.push(`${key}: "${value}" is not a number`);
        continue;
      }
      answers[key] = n;
      continue;
    }

    if (spec.list) {
      const items = Array.isArray(value) ? value : [value];
      const mapped = [];
      for (const item of items) {
        if (!spec.enum) {
          if (clean(item)) mapped.push(clean(item));
          continue;
        }
        const hit = matchEnum(item, spec.enum);
        if (hit) mapped.push(hit);
        else problems.push(`${key}: "${item}" is not one of the allowed values`);
      }
      if (mapped.length) answers[key] = mapped;
      continue;
    }

    if (spec.enum) {
      const hit = matchEnum(value, spec.enum);
      if (hit) answers[key] = hit;
      else problems.push(`${key}: "${value}" is not one of the allowed values`);
      continue;
    }

    answers[key] = clean(value);
  }

  return { answers, ignored, problems };
}
