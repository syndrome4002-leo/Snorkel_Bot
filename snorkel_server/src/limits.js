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

/**
 * A minute of grace before the server steps in, so a catch-up is not a race with
 * the browser's own alarm.
 */
export const REVISION_CHECK_GRACE_MS = 60000;

/**
 * How late the revise check is, in milliseconds, or 0 if it is not late.
 *
 * The schedule lives in the browser — chrome.alarms, in a service worker Chrome
 * suspends whenever it feels like it — so "every five minutes" is a best effort
 * and not a promise. When it slips, nothing else notices: the count of tasks
 * awaiting revision is what triggers a start, and without a fresh one the bot
 * sits still while the ticker says the check is due.
 *
 * `next_check_at` is the browser's own answer and is preferred. A report that
 * arrived without one falls back to when it last checked plus the interval.
 * Neither means there is nothing to be late for — the extension has not reported
 * at all yet, which is a different problem with its own message.
 */
export function revisionCheckLateBy(report, everyMinutes, now = Date.now()) {
  if (!report) return 0;

  const next = report.next_check_at ? new Date(report.next_check_at).getTime() : NaN;
  const last = report.checked_at ? new Date(report.checked_at).getTime() : NaN;

  const due = Number.isFinite(next)
    ? next
    : Number.isFinite(last)
      ? last + Math.max(1, Number(everyMinutes) || 5) * 60000
      : NaN;

  if (!Number.isFinite(due)) return 0;
  const late = now - (due + REVISION_CHECK_GRACE_MS);
  return late > 0 ? late : 0;
}
