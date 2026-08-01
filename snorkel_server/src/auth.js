/*
 * auth.js — shared-secret gate for the API.
 *
 * Off entirely when BOT_TOKEN is empty, which is fine while the server only
 * listens on localhost. The moment you open the dashboard to another machine,
 * set BOT_TOKEN: these endpoints can start tasks, read every stored task, and
 * write credentials into .env.
 *
 * The dashboard's HTML and JS are NOT behind this — they contain no secrets and
 * simply prompt for the token, which the browser then sends on every call.
 */

import { timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

/** Dropbox redirects a browser here and cannot be made to carry our token. */
const OPEN_PATHS = new Set(['/api/dropbox/callback']);

function sameSecret(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  // timingSafeEqual throws on length mismatch, and the length itself is not
  // worth hiding here.
  return left.length === right.length && timingSafeEqual(left, right);
}

function suppliedToken(req) {
  const header = req.get('x-bot-token');
  if (header) return header;
  // EventSource cannot set headers, so the SSE stream passes it on the query.
  if (req.query && req.query.token) return String(req.query.token);
  return '';
}

/*
 * Guessing protection. On a LAN this barely matters; reachable from the
 * internet it does, because otherwise an attacker gets unlimited tries at the
 * token. Failures are counted per client address and the door shuts for a while
 * once there are too many.
 *
 * The lockout deliberately rejects the CORRECT token too while it lasts. Any
 * scheme that validates first would hand an attacker unlimited guesses, which
 * is the thing being prevented. Tune with AUTH_MAX_FAILURES and
 * AUTH_LOCKOUT_SECONDS if 10 tries per 5 minutes is the wrong shape for you.
 */
const MAX_FAILURES = Number(process.env.AUTH_MAX_FAILURES || 10);
const WINDOW_MS = Number(process.env.AUTH_LOCKOUT_SECONDS || 300) * 1000;
const failures = new Map(); // ip -> { count, first }

function recordFailure(ip) {
  const now = Date.now();
  const entry = failures.get(ip);
  if (!entry || now - entry.first > WINDOW_MS) {
    failures.set(ip, { count: 1, first: now });
    return 1;
  }
  entry.count += 1;
  return entry.count;
}

function lockedOut(ip) {
  const entry = failures.get(ip);
  if (!entry) return 0;
  if (Date.now() - entry.first > WINDOW_MS) {
    failures.delete(ip);
    return 0;
  }
  if (entry.count < MAX_FAILURES) return 0;
  return Math.ceil((entry.first + WINDOW_MS - Date.now()) / 1000);
}

// Keeps the map from growing without bound on a long-lived server.
setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [ip, entry] of failures) if (entry.first < cutoff) failures.delete(ip);
}, WINDOW_MS).unref();

export function requireToken(req, res, next) {
  if (!config.botToken) return next();

  // This middleware is mounted on path prefixes, which makes req.path relative
  // to the mount point ("/dropbox/callback", not "/api/dropbox/callback").
  // originalUrl is the only reliable full path here.
  const fullPath = req.originalUrl.split('?')[0];
  if (OPEN_PATHS.has(fullPath)) return next();

  const ip = req.ip || req.socket.remoteAddress || 'unknown';

  const retryAfter = lockedOut(ip);
  if (retryAfter) {
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({
      ok: false,
      error: `Too many bad tokens. Try again in ${retryAfter}s.`,
    });
  }

  if (sameSecret(suppliedToken(req), config.botToken)) {
    failures.delete(ip);
    return next();
  }

  const count = recordFailure(ip);
  if (count >= MAX_FAILURES) console.warn(`[auth] locking out ${ip} after ${count} bad tokens`);

  res.status(401).json({
    ok: false,
    error: 'Missing or wrong token. Send it as the X-Bot-Token header (or ?token= for the event stream).',
  });
}

export function authEnabled() {
  return !!config.botToken;
}
