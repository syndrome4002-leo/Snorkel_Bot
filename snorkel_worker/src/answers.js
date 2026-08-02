/*
 * answers.js — turning the model's JSON turn into the `answers` object.
 *
 * Two jobs, and the second matters more than the first: parse it, then keep only
 * what the schema recognises. An answer field is going to be pasted into the
 * platform's form, so a key nobody asked for is not a bonus, it is a value with
 * nowhere to go and no way to notice it went missing.
 */

import { answerSchema } from './prompts.js';

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
export async function normaliseAnswers(parsed) {
  const schema = await answerSchema();
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
