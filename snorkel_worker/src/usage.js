/*
 * usage.js — how much of the Claude subscription is spent, and when it resets.
 *
 * The figures come from ~/.claude.json, under `cachedUsageUtilization`:
 *
 *   fetchedAtMs                          when Claude Code last asked the API
 *   utilization.five_hour.utilization    percent of the 5-hour window used
 *   utilization.five_hour.resets_at      ISO timestamp
 *   utilization.seven_day.{...}          the same for the 7-day window
 *
 * This is the same place Claude Code itself reads, so the dashboard shows what
 * you would see in the editor rather than a second opinion.
 *
 * There is an older file, ~/.claude/rate-limit-cache.json, with the same idea in
 * a different shape (0..1 rather than percent). It is kept as a fallback because
 * it costs nothing, but it is written far less often — on this machine it had
 * not been touched in four months while the file above was minutes old. Anything
 * reading only that would confidently report a window that reset in April.
 */

import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';

/** Past this the numbers describe a window that has probably rolled. */
const STALE_AFTER_HOURS = 6;

const configDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

export function usagePaths() {
  return {
    primary: config.claude.usageCache || path.join(os.homedir(), '.claude.json'),
    fallback: path.join(configDir(), 'rate-limit-cache.json'),
  };
}

const clampPct = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n * 10) / 10)) : null;
};

const isoOf = (value) => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

function shape(source, writtenMs, five, seven) {
  const ageHours = (Date.now() - writtenMs) / 3600000;
  return {
    available: true,
    stale: ageHours > STALE_AFTER_HOURS,
    age_hours: Math.round(ageHours * 10) / 10,
    written_at: new Date(writtenMs).toISOString(),
    session_5h_pct: five.pct,
    weekly_7d_pct: seven.pct,
    reset_5h: five.reset,
    reset_7d: seven.reset,
    source,
  };
}

/** The current shape: ~/.claude.json -> cachedUsageUtilization. */
async function fromClaudeJson(file) {
  const data = JSON.parse(await readFile(file, 'utf8'));
  const cached = data && data.cachedUsageUtilization;
  const util = cached && cached.utilization;
  if (!util) return null;

  const writtenMs = Number(cached.fetchedAtMs) || Date.now();
  return shape(
    file,
    writtenMs,
    { pct: clampPct(util.five_hour?.utilization), reset: isoOf(util.five_hour?.resets_at) },
    { pct: clampPct(util.seven_day?.utilization), reset: isoOf(util.seven_day?.resets_at) }
  );
}

/** The older shape, where the numbers are fractions and the resets are unix seconds. */
async function fromRateLimitCache(file) {
  const [raw, info] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
  const data = JSON.parse(raw);
  const writtenMs = Number(data.timestamp) || info.mtimeMs;

  const asIso = (seconds) => {
    const n = Number(seconds);
    return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null;
  };

  return shape(
    file,
    writtenMs,
    { pct: clampPct(Number(data.session5h) * 100), reset: asIso(data.reset5h) },
    { pct: clampPct(Number(data.weekly7d) * 100), reset: asIso(data.reset7d) }
  );
}

/**
 * Reads whichever source has something to say, newest first.
 *
 * Never throws. This is a status readout on a dashboard; it must not be able to
 * take the worker down with it.
 */
export async function readClaudeUsage() {
  const { primary, fallback } = usagePaths();
  const problems = [];

  for (const [file, parse] of [
    [primary, fromClaudeJson],
    [fallback, fromRateLimitCache],
  ]) {
    try {
      const result = await parse(file);
      if (result && (result.session_5h_pct !== null || result.weekly_7d_pct !== null)) return result;
      problems.push(`${file}: no usage figures in it`);
    } catch (err) {
      problems.push(err.code === 'ENOENT' ? `${file}: not there` : `${file}: ${err.message}`);
    }
  }

  return {
    available: false,
    reason: `Could not read Claude's usage figures. ${problems.join('; ')}`,
    source: primary,
  };
}
