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
 * When the revise list is next due to be read, as a timestamp, or null if there
 * is nothing to be due — the extension has not reported at all yet, which is a
 * different problem with its own message.
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
export function revisionCheckDueAt(report, everyMinutes) {
  if (!report) return null;

  const next = report.next_check_at ? new Date(report.next_check_at).getTime() : NaN;
  const last = report.checked_at ? new Date(report.checked_at).getTime() : NaN;
  const interval = Math.max(1, Number(everyMinutes) || 5) * 60000;

  /*
   * The later of the two, not the first one available.
   *
   * A check the server asked for reports when it happened and nothing about the
   * browser's alarm — so `next_check_at` stays as it was, in the past, and on
   * its own it says the check is still overdue the moment after one finished.
   * That is a check a minute, every minute, forever.
   *
   * A check that has just happened is not late no matter what any schedule says,
   * which is the whole rule: once done, not again until the interval is up.
   */
  const fromSchedule = Number.isFinite(next) ? next : NaN;
  const fromLastCheck = Number.isFinite(last) ? last + interval : NaN;

  const due = Number.isFinite(fromSchedule)
    ? Number.isFinite(fromLastCheck)
      ? Math.max(fromSchedule, fromLastCheck)
      : fromSchedule
    : fromLastCheck;

  return Number.isFinite(due) ? due : null;
}

/**
 * How late that check is, in milliseconds, or 0 if it is not late.
 *
 * The same due time the ticker shows, so what the dashboard says and what the
 * server does cannot disagree — a ticker reading "due now" beside a server that
 * has decided otherwise is how this looked while it was wrong.
 */
export function revisionCheckLateBy(report, everyMinutes, now = Date.now()) {
  const due = revisionCheckDueAt(report, everyMinutes);
  if (due === null) return 0;
  const late = now - (due + REVISION_CHECK_GRACE_MS);
  return late > 0 ? late : 0;
}
