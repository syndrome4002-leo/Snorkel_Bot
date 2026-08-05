/*
 * workspace.js — which deployment this dashboard belongs to.
 *
 * One Firebase project can carry several independent set-ups: a Snorkel server
 * and its worker here, another pair somewhere else. They share a database
 * because they share a project, but they must not share a *view* — the second
 * dashboard should not list the first one's machines, and neither worker should
 * pick up the other's tasks.
 *
 * Three nodes decide that, and all three are scoped by this key:
 *
 *   machines_index/<workspace>/<machineId>   which machines are worked
 *   system/<workspace>                       the master switch
 *   workers/<workspace>/<workerId>           which workers are registered
 *
 * Everything else is already keyed by machine id, which is unique across the
 * lot, and is only ever reached through the machine list above.
 *
 * `default` is deliberately the fallback: an existing deployment that sets
 * nothing keeps working, and a second one is a matter of setting this to
 * something else in all three components.
 */

export const DEFAULT_WORKSPACE = 'default';

const KEY = 'snorkelbot.workspace';

/** Realtime Database keys cannot contain these. */
const ILLEGAL = /[.$#[\]/]/;

export function validateWorkspace(name) {
  const clean = String(name || '').trim();
  if (!clean) return { ok: true, name: DEFAULT_WORKSPACE };
  if (ILLEGAL.test(clean)) return { ok: false, error: 'A name cannot contain . $ # [ ] or /' };
  if (clean.length > 64) return { ok: false, error: 'That is too long.' };
  return { ok: true, name: clean };
}

/*
 * Read from the browser, not from the build.
 *
 * It started as NEXT_PUBLIC_WORKSPACE, which meant changing it was a rebuild and
 * a redeploy of a static site — far too much ceremony for naming your own
 * dashboard. It is a setting you type in, and the env var survives only as the
 * default for a fresh browser, which is useful when you ship the dashboard
 * already pointed at the right place.
 *
 * Cached because it is on the path of every database read, and localStorage is
 * synchronous.
 */
let cached = null;

export function workspace() {
  if (cached) return cached;

  const fallback = validateWorkspace(process.env.NEXT_PUBLIC_WORKSPACE);
  let saved = null;
  try {
    saved = localStorage.getItem(KEY);
  } catch {
    // Server render, private browsing, or storage turned off.
  }

  const chosen = validateWorkspace(saved);
  cached = saved && chosen.ok ? chosen.name : fallback.ok ? fallback.name : DEFAULT_WORKSPACE;
  return cached;
}

/**
 * Changes it and reloads.
 *
 * A reload rather than re-subscribing everything: every live listener on the
 * page is bound to a path built from this, and unpicking them by hand is a lot
 * of moving parts for something you do once when you set a machine up.
 */
export function setWorkspace(name) {
  const check = validateWorkspace(name);
  if (!check.ok) throw new Error(check.error);
  try {
    localStorage.setItem(KEY, check.name);
  } catch {
    throw new Error('This browser will not let the dashboard remember settings.');
  }
  cached = null;
  window.location.reload();
}

/** Where the workspace's own copy of a shared node lives. */
export const scoped = (node) => `${node}/${workspace()}`;
