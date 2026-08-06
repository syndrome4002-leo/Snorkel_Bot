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

/*
 * A window whose reset time has passed.
 *
 * This is not staleness, it is a figure about something that no longer exists:
 * "93% of the five-hour window" describes a window that ended six hours ago,
 * and the current one has barely been touched. Showing the old number is worse
 * than showing nothing, because it reads as a warning that nothing is left.
 *
 * The true figure is unknown until Claude Code next talks to the API — it
 * caches these and does not refetch on demand — so the honest answer is that it
 * is unknown, not zero.
 */
const rolled = (reset) => Boolean(reset) && new Date(reset).getTime() <= Date.now();

function shape(source, writtenMs, five, seven) {
  const ageHours = (Date.now() - writtenMs) / 3600000;
  const fiveOver = rolled(five.reset);
  const sevenOver = rolled(seven.reset);

  return {
    available: true,
    stale: ageHours > STALE_AFTER_HOURS,
    age_hours: Math.round(ageHours * 10) / 10,
    written_at: new Date(writtenMs).toISOString(),
    session_5h_pct: fiveOver ? null : five.pct,
    weekly_7d_pct: sevenOver ? null : seven.pct,
    reset_5h: five.reset,
    reset_7d: seven.reset,
    // So the dashboard can say "the window rolled" rather than showing a dash
    // that looks like a worker with nothing to report.
    rolled_5h: fiveOver,
    rolled_7d: sevenOver,
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
/**
 * Re-reads the figures from disk and hands back what is there now.
 *
 * Deliberately NOT an API call. The obvious implementation — run a tiny prompt
 * so the CLI refetches — does not work: `claude --print` answers normally and
 * leaves `cachedUsageUtilization` untouched, verified by watching the file
 * across several calls. Claude Code refetches these on its own schedule, and
 * nothing outside it can ask.
 *
 * So this is worth a button for one thing only: picking up a file that HAS
 * changed without waiting out the heartbeat. When the figures are genuinely old,
 * the honest answer is that they are old, which is what `stale` and the rolled
 * flags are for.
 */
/*
 * Claude Code's own credentials, and the endpoint it asks.
 *
 * Both taken from the installed CLI rather than guessed: it reads the OAuth
 * token from ~/.claude/.credentials.json and GETs /api/oauth/usage with it.
 * Asking the same question the same way is the only route to a current figure —
 * the cache in ~/.claude.json is refreshed on the CLI's own schedule, and no
 * amount of running `claude` forces it.
 *
 * The token is read, used, and never logged. A failure reports its status code
 * and nothing from the response.
 */
const CREDENTIALS = () =>
  config.claude.credentials || path.join(os.homedir(), '.claude', '.credentials.json');

const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';

/*
 * How long a live reading is good for.
 *
 * The endpoint is rate limited — two calls a minute apart already returned 429 —
 * and Claude Code itself caches the answer for an hour, so it is plainly not
 * meant to be polled. Fifteen minutes keeps the gauge honest without leaning on
 * it: the figure it replaces was routinely eight hours old and sometimes
 * described a window that had already reset.
 *
 * The dashboard's button forces a fetch regardless, which is the one time
 * asking sooner is worth a 429.
 */
const LIVE_TTL_MS = 15 * 60 * 1000;

let live = null;
/** When a forced fetch was refused, so the next one waits rather than repeating. */
let liveBlockedUntil = 0;

async function fetchLiveUsage({ timeoutMs = 8000 } = {}) {
  let token;
  try {
    const creds = JSON.parse(await readFile(CREDENTIALS(), 'utf8'));
    const oauth = creds && creds.claudeAiOauth;
    if (!oauth || !oauth.accessToken) throw new Error('no OAuth token in the credentials file');
    // Expired tokens are Claude Code's to refresh, not ours — it does so on its
    // next run. Until then the cached file is the best there is.
    if (oauth.expiresAt && oauth.expiresAt <= Date.now()) {
      throw new Error('the stored token has expired; run claude once to renew it');
    }
    token = oauth.accessToken;
  } catch (err) {
    throw new Error(`could not read ${CREDENTIALS()}: ${err.message}`);
  }

  const response = await fetch(USAGE_ENDPOINT, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status === 429) {
    // Asked too often. Backed off explicitly so a run of clicks does not turn
    // into a run of refusals.
    liveBlockedUntil = Date.now() + 60_000;
    throw new Error('asked too recently — the usage endpoint is rate limited, try again shortly');
  }
  if (!response.ok) throw new Error(`the usage endpoint answered ${response.status}`);

  const body = await response.json();
  const five = body && body.five_hour;
  const seven = body && body.seven_day;
  if (!five && !seven) throw new Error('the usage endpoint returned neither window');

  return shape(
    'api',
    Date.now(),
    { pct: clampPct(five && five.utilization), reset: isoOf(five && five.resets_at) },
    { pct: clampPct(seven && seven.utilization), reset: isoOf(seven && seven.resets_at) }
  );
}

/**
 * The current figures, asked for directly.
 *
 * `force` skips the short cache, which is what the dashboard's button does.
 * Anything that goes wrong falls through to the file: a stale reading clearly
 * marked as stale is worth more than an empty panel.
 */
export async function liveClaudeUsage({ force = false } = {}) {
  if (!force && live && Date.now() - live.at < LIVE_TTL_MS) return live.usage;
  if (Date.now() < liveBlockedUntil) {
    if (live) return live.usage;
    throw new Error('the usage endpoint is rate limited just now');
  }

  const usage = await fetchLiveUsage();
  live = { at: Date.now(), usage };
  liveBlockedUntil = 0;
  return usage;
}

export async function refreshClaudeUsage() {
  const before = await readClaudeUsage();
  try {
    const usage = await liveClaudeUsage({ force: true });
    return { ...usage, refreshed: true };
  } catch (err) {
    console.warn('[usage] could not ask the API:', err.message);
    return { ...before, refreshed: false, reason: err.message };
  }
}

export async function readClaudeUsage() {
  /*
   * Asked directly first, cached for a few minutes. The file underneath is
   * whatever Claude Code last chose to write, which on an idle machine is
   * hours old and can describe a window that has since reset — so it is the
   * fallback, not the source.
   */
  try {
    return await liveClaudeUsage();
  } catch (err) {
    // Not worth a warning on every heartbeat; the fallback below says where the
    // figures came from, and `stale` says how old they are.
  }

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

/**
 * Whether an error from Claude means "there is no usage left", as opposed to
 * something wrong with the particular task it was working on.
 *
 * Deliberately narrow. A task that fails for its own reasons should be tried
 * again; only an exhausted subscription is a reason to stop trying everything,
 * and being too eager here would stall the worker on a fault it could have
 * worked around. The wording comes from the CLI, which says things like
 * "You're out of extra usage · resets 5:10am (Europe/Berlin)".
 */
export function outOfUsage(message) {
  const text = String(message || '');
  if (!text) return false;
  return (
    /\bout of (?:extra )?usage\b/i.test(text) ||
    /usage limit reached/i.test(text) ||
    /reached your usage limit/i.test(text) ||
    /\blimit reached\b[^.]*\bresets\b/i.test(text)
  );
}
