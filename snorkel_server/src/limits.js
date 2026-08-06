/*
 * limits.js — reading the numbers the dashboard sets.
 *
 * Small enough to look obvious, and it was not: the daily cap treated 0 as "no
 * limit", so the one value with an unmistakable meaning did the opposite of what
 * it says. Kept here so the rule can be checked without starting a server.
 */

/**
 * How many new tasks may be submitted today, or null for no limit.
 *
 * Empty, absent or unreadable means no limit — the field has never been set, and
 * a system that stopped working because nobody filled in a box would be a poor
 * default. Zero means zero.
 *
 * Only new tasks are counted either way. A revision is work already accepted by
 * the platform and waiting to be finished; refusing to finish it because of a
 * limit on starting things would be the wrong limit applied to the wrong thing.
 */
export function dailySubmitLimit(raw) {
  if (raw === null || raw === undefined || raw === '') return null;

  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}
