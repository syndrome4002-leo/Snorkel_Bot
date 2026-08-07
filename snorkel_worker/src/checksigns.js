/*
 * checksigns.js — turning a reviewer's automated checks into something you can
 * compare between rounds.
 *
 * The four panes on the review page are prose reports, but they are prose with
 * structure in it:
 *
 *   Status:  DISCUSS      Reason: overreach
 *   clarity 2.5/5   test_coverage 2.0/5   packaging 5.0/5
 *   ❌ 1 must-have quality criteria failed (14/15)
 *   Oracle did not pass all runs: 0/3
 *
 * Reduced to a set of short keys, two rounds of the same task can be subtracted
 * from each other, and that subtraction is the only honest measure of whether a
 * revision worked:
 *
 *   fixed       in the last round, gone from this one
 *   persisted   in both — the fix did not take
 *   introduced  new this round, so the last revision caused it
 *
 * `introduced` is the one that pays for this file. A round that fixes three
 * complaints and breaks the oracle looks, from every other angle in the system,
 * exactly like a round that fixed three complaints.
 *
 * Kept deliberately conservative: a pattern that does not match produces no
 * signature rather than a guessed one, because a wrong signature makes a fix
 * look like a regression and a regression look like progress.
 *
 * This file is duplicated in snorkel_server/src: the two halves run as separate
 * processes, often on different machines, and must read a failure the same way.
 * Keep the two identical.
 */

/** Below this a per-axis score is worth complaining about. */
const AXIS_FLOOR = 3.5;

const paneText = (check) => String((check && check.text) || '');
const titleOf = (check) => String((check && check.title) || '');

function judgeSignatures(text) {
  const out = [];

  /*
   * "Status: ⚠️ DISCUSS" / "Status: ✅ OK". The emoji sits between the label and
   * the word and is not always the same one, so it is skipped rather than
   * matched — and OK is not a complaint, so it yields nothing.
   */
  const status = (text.match(/Status:\s*\S*\s*([A-Z][A-Z_]{1,})/) || [])[1];
  const reason = (text.match(/Reason:\s*(\S+)/) || [])[1];
  if (status && status.toUpperCase() !== 'OK') {
    out.push(`judge:${status.toLowerCase()}/${(reason || 'unknown').toLowerCase()}`);
  }

  // "  clarity  —  2.5/5" — the per-axis block.
  for (const match of text.matchAll(/^\s{2}([a-z_]+)\s+[—-]\s+([\d.]+)\s*\/\s*5/gm)) {
    if (Number(match[2]) < AXIS_FLOOR) out.push(`judge:axis:${match[1]}`);
  }

  return out;
}

function paneSignatures(check) {
  const text = paneText(check);
  if (!text.trim()) return [];
  const title = titleOf(check);

  if (/agentic judge/i.test(title)) return judgeSignatures(text);

  if (/quality/i.test(title)) {
    return /must-have quality criteria failed|❌/i.test(text) ? ['quality:must_have_failed'] : [];
  }

  if (/oracle/i.test(title)) {
    // "Not run — an earlier stage blocked this" is not the oracle's verdict.
    if (/did not pass all runs/i.test(text)) return ['oracle:runs_failed'];
    return [];
  }

  if (/difficulty/i.test(title)) {
    if (/blocked at the difficulty screen/i.test(text)) return ['difficulty:blocked'];
    return [];
  }

  return [];
}

/** Every complaint in one feedback round, deduplicated and ordered. */
export function signaturesOf(round) {
  const checks = Array.isArray(round && round.checks) ? round.checks : [];
  const found = new Set();
  for (const check of checks) for (const sig of paneSignatures(check)) found.add(sig);
  return [...found].sort();
}

/**
 * What changed between two rounds.
 *
 * `previous` may be null — the first round has nothing to be measured against,
 * and calling everything in it "introduced" would blame the build for the state
 * it was asked to fix.
 */
export function diffRounds(previous, next) {
  const after = signaturesOf(next);
  if (!previous) return { fixed: [], persisted: [], introduced: [], first: true, open: after };

  const before = signaturesOf(previous);
  const afterSet = new Set(after);
  const beforeSet = new Set(before);

  return {
    fixed: before.filter((s) => !afterSet.has(s)),
    persisted: before.filter((s) => afterSet.has(s)),
    introduced: after.filter((s) => !beforeSet.has(s)),
    first: false,
    open: after,
  };
}

/** One line for a log or a prompt. */
export function describeDiff(diff) {
  if (!diff) return '';
  if (diff.first) {
    return diff.open.length
      ? `first round — ${diff.open.length} open: ${diff.open.join(', ')}`
      : 'first round — the automated checks are clean';
  }

  const parts = [];
  if (diff.fixed.length) parts.push(`fixed ${diff.fixed.length} (${diff.fixed.join(', ')})`);
  if (diff.persisted.length) parts.push(`${diff.persisted.length} still open (${diff.persisted.join(', ')})`);
  if (diff.introduced.length) {
    parts.push(`INTRODUCED ${diff.introduced.length} (${diff.introduced.join(', ')})`);
  }
  return parts.join('; ') || 'no change in the automated checks';
}

/**
 * Did the last revision leave the task worse than it found it?
 *
 * Not "did anything fail" — a task can come back with the same complaints and
 * that is merely a fix that did not work. This is specifically about damage the
 * revision caused, which is the thing worth refusing to call a success.
 */
export const madeThingsWorse = (diff) => Boolean(diff && !diff.first && diff.introduced.length);
