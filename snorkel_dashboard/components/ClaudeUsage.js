'use client';

import { useEffect, useState } from 'react';
import { watchWorkers } from '@/lib/commands';

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
function Window({ label, pct, reset }) {
  const value = Number.isFinite(pct) ? pct : null;
  // Colour only once it matters; a quiet bar for most of its life.
  const tone = value === null ? '' : value >= 90 ? ' bad' : value >= 70 ? ' warn' : '';

  return (
    <div className="usage-window" title={reset ? `${label} resets ${until(reset)}` : label}>
      <span className="usage-window-label">{label}</span>
      <span className="meter-track">
        <span className={`meter-fill${tone}`} style={{ width: `${value ?? 0}%` }} />
      </span>
      <span className="usage-figure">{value === null ? '—' : `${value}%`}</span>
      {reset ? <span className="usage-reset muted">{until(reset)}</span> : null}
    </div>
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
          <Window label="5h" pct={usage.session_5h_pct} reset={usage.reset_5h} />
          <Window label="7d" pct={usage.weekly_7d_pct} reset={usage.reset_7d} />
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
