'use client';

import { useEffect, useState } from 'react';
import { refreshWorkerUsage, watchWorkers } from '@/lib/commands';

function when(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/**
 * "in 3 days", falling back to hours and minutes as it gets close.
 *
 * A window an hour away is not "in 0 days", and one that has already rolled is
 * not "in -2 days" — both are worth saying properly rather than rounding into
 * something wrong.
 */
function until(iso) {
  if (!iso) return '';
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return 'already passed';

  const hours = ms / 3600000;
  if (hours < 1) return `in ${Math.max(1, Math.round(ms / 60000))} min`;
  if (hours < 48) return `in ${Math.round(hours)} hours`;
  const days = Math.round(hours / 24);
  return `in ${days} day${days === 1 ? '' : 's'}`;
}

/**
 * One window as a compact meter: label, bar, figure, reset.
 *
 * Laid out in a fixed-width grid rather than by flow, so the two windows of one
 * worker — and the same window across several workers — line up in a column
 * instead of shifting with the length of "resets in 3 days".
 */
function Window({ label, pct, reset, rolled }) {
  const value = Number.isFinite(pct) ? pct : null;
  // Colour only once it matters; a quiet bar for most of its life.
  const tone = value === null ? '' : value >= 90 ? ' bad' : value >= 70 ? ' warn' : '';

  return (
    <div
      className={`usage-window${rolled ? ' rolled' : ''}`}
      title={
        rolled
          ? `${label}: this window reset ${until(reset)}, so the last figure is about a window that has ended. ` +
            'The worker could not reach the usage endpoint to replace it, so this is from the local cache.'
          : reset
            ? `${label} resets ${until(reset)}`
            : label
      }
    >
      <span className="usage-window-label">{label}</span>
      <span className="meter-track">
        <span className={`meter-fill${tone}`} style={{ width: `${value ?? 0}%` }} />
      </span>
      <span className="usage-figure">{value === null ? (rolled ? 'rolled' : '—') : `${value}%`}</span>
      {reset && !rolled ? <span className="usage-reset muted">{until(reset)}</span> : null}
    </div>
  );
}

/**
 * Asks the worker for the current figures.
 *
 * The worker asks Anthropic directly — the same endpoint Claude Code uses — and
 * caches the answer for fifteen minutes, so this button is for wanting it sooner
 * than that. The endpoint is rate limited, which the tooltip says, because a
 * refused click otherwise looks like a broken button.
 *
 * "Asking" clears itself when the worker publishes a newer timestamp rather
 * than after a fixed wait, so it reflects what happened rather than a guess.
 */
function RefreshButton({ worker, usage }) {
  const [asked, setAsked] = useState(null);
  const [error, setError] = useState('');
  const writtenAt = usage?.written_at || null;

  useEffect(() => {
    if (asked && writtenAt && writtenAt > asked) setAsked(null);
  }, [asked, writtenAt]);

  // A worker that is not running cannot answer, and the request would sit in
  // the database until it next started.
  if (!worker.online) return null;

  const ask = async () => {
    setError('');
    setAsked(new Date().toISOString());
    try {
      await refreshWorkerUsage(worker.id);
    } catch (err) {
      setAsked(null);
      setError(err.message);
    }
  };

  return (
    <button
      className={`usage-refresh${asked ? ' asking' : ''}`}
      onClick={ask}
      disabled={Boolean(asked)}
      title={
        error ||
        'Ask this worker for its current Claude usage.\n\n' +
          'It asks Anthropic directly, the same way Claude Code does. That ' +
          'endpoint is rate limited, so a second click straight after the first ' +
          'will be turned away — give it a minute.'
      }
    >
      {asked ? '…' : '⟳'}
    </button>
  );
}

function WorkerRow({ worker }) {
  const usage = worker.claude_usage;
  const running = worker.tasks || [];

  // Written hours ago but still drawn at full strength reads as current, so a
  // stale set of figures is faded and its timestamp marked.
  const stale = Boolean(usage?.stale);

  return (
    <div className={`usage-worker${stale ? ' stale' : ''}`}>
      <span className="usage-name" title={worker.id}>
        <span className={`dot ${worker.online ? 'ok' : 'bad'}`} />
        <strong>{worker.hostname || worker.id}</strong>
        <span className="muted">
          {worker.online ? `${worker.running ?? 0}/${worker.max_concurrent ?? '?'}` : 'offline'}
        </span>
      </span>

      {usage?.available ? (
        <span className="usage-windows">
          <Window label="5h" pct={usage.session_5h_pct} reset={usage.reset_5h} rolled={usage.rolled_5h} />
          <Window label="7d" pct={usage.weekly_7d_pct} reset={usage.reset_7d} rolled={usage.rolled_7d} />
        </span>
      ) : (
        <span className="muted usage-none">{usage?.reason || 'no usage figures yet'}</span>
      )}

      {/* Real and live, unlike the percentages: this is what the worker is doing
          right now, refreshed every ten seconds. */}
      {running.length ? (
        <span className="usage-running muted" title={running.map((t) => t.uid).join(', ')}>
          {running.map((t) => String(t.uid).slice(0, 8)).join(' ')}
        </span>
      ) : null}

      <RefreshButton worker={worker} usage={usage} />

      {usage?.written_at ? (
        <span
          className="usage-when muted"
          title={
            `Updated ${when(usage.written_at)}` +
            (stale ? ` — ${Math.round(usage.age_hours ?? 0)}h old, the worker has not reported since` : '')
          }
        >
          {stale ? '⚠' : '⟳'}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Every worker that has registered, and what is left of the Claude subscription.
 *
 * The left-hand half of the bar pinned along the bottom of the window; page.js
 * owns the bar itself and puts the machine list on the other side. It lives
 * there rather than in the flow because it is a gauge, not a record: it answers
 * "how much is left" at a glance and should not have to be scrolled to.
 *
 * Not scoped to the machine selected above. A worker is told which machines to
 * work for and normally runs on none of them, so there is no machine branch it
 * belongs under — looking for it there showed nothing while a worker was running
 * perfectly well.
 */
export default function ClaudeUsage() {
  const [workers, setWorkers] = useState(null);

  useEffect(() => watchWorkers(setWorkers), []);

  return (
    <div className="usage-group" aria-label="Claude usage">
      <span className="usage-title">Claude</span>
      <div className="usage-workers">
        {workers === null ? (
          <span className="muted">Loading…</span>
        ) : workers.length ? (
          workers.map((worker) => <WorkerRow key={worker.id} worker={worker} />)
        ) : (
          <span className="muted">
            No worker registered — start snorkel_worker on any machine.
          </span>
        )}
      </div>
    </div>
  );
}
