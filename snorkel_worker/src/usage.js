/*
 * usage.js — how much of the Claude subscription is spent, and when it resets.
 *
 * Claude Code caches what the API tells it about rate limits in
 * ~/.claude/rate-limit-cache.json:
 *
 *   session5h  0..1   share of the 5-hour window used
 *   weekly7d   0..1   share of the 7-day window used
 *   reset5h    unix seconds
 *   reset7d    unix seconds
 *   timestamp  unix ms, when this was written
 *
 * The catch is that it only changes when a run comes back carrying limit
 * headers, so it can sit untouched for weeks. Reporting a stale figure as if it
 * were current is worse than reporting nothing, so the age travels with it and
 * anything past a day is marked stale rather than quietly shown.
 */

import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';

/** Past this the numbers describe a window that has almost certainly rolled. */
const STALE_AFTER_HOURS = 24;

export function usageCachePath() {
  return (
    config.claude.usageCache ||
    path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'rate-limit-cache.json')
  );
}

const pct = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n * 1000) / 10)) : null;
};

const iso = (seconds) => {
  const n = Number(seconds);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null;
};

/**
 * Reads the cache, or explains why it could not.
 *
 * Never throws. This is a status readout on a dashboard; it must not be able to
 * take the worker down with it.
 */
export async function readClaudeUsage() {
  const file = usageCachePath();

  try {
    const [raw, info] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
    const data = JSON.parse(raw);

    const writtenMs = Number(data.timestamp) || info.mtimeMs;
    const ageHours = (Date.now() - writtenMs) / 3600000;

    return {
      available: true,
      stale: ageHours > STALE_AFTER_HOURS,
      age_hours: Math.round(ageHours * 10) / 10,
      written_at: new Date(writtenMs).toISOString(),
      session_5h_pct: pct(data.session5h),
      weekly_7d_pct: pct(data.weekly7d),
      reset_5h: iso(data.reset5h),
      reset_7d: iso(data.reset7d),
      source: file,
    };
  } catch (err) {
    return {
      available: false,
      reason:
        err.code === 'ENOENT'
          ? `No usage cache at ${file}. Claude Code writes it when a run comes back with limit information.`
          : `Could not read ${file}: ${err.message}`,
      source: file,
    };
  }
}
