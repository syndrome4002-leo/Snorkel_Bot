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

function Window({ label, pct, reset }) {
  const value = Number.isFinite(pct) ? pct : null;
  // Colour only once it matters; a quiet bar for most of its life.
  const tone = value === null ? '' : value >= 90 ? ' bad' : value >= 70 ? ' warn' : '';

  return (
    <div className="meter">
      <div className="row space">
        <span>{label}</span>
        <span className="usage-figure">
          {value === null ? '—' : `${value}%`}
          {reset ? <span className="muted">, resets {until(reset)}</span> : null}
        </span>
      </div>
      <div className="meter-track">
        <div className={`meter-fill${tone}`} style={{ width: `${value ?? 0}%` }} />
      </div>
    </div>
  );
}

function WorkerCard({ worker }) {
  const usage = worker.claude_usage;
  const running = worker.tasks || [];

  return (
    <div className="worker-card">
      <div className="row space">
        <span className="row">
          <span className={`dot ${worker.online ? 'ok' : 'bad'}`} />
          <strong>{worker.hostname || worker.id}</strong>
          <span className="machine-id">{worker.id}</span>
        </span>
        <span className="muted">
          {worker.online
            ? `${worker.running ?? 0} of ${worker.max_concurrent ?? '?'} busy`
            : 'offline'}
        </span>
      </div>

      {usage?.available ? (
        <>
          <Window label="5-hour window" pct={usage.session_5h_pct} reset={usage.reset_5h} />
          <Window label="7-day window" pct={usage.weekly_7d_pct} reset={usage.reset_7d} />
          <p className="muted">Updated {when(usage.written_at)}.</p>
        </>
      ) : (
        <p className="muted">{usage?.reason || 'No usage figures reported yet.'}</p>
      )}

      {/* Real and live, unlike the percentages: this is what the worker is
          doing right now, refreshed every ten seconds. */}
      {running.length ? (
        <p className="muted">
          Working on {running.map((t) => String(t.uid).slice(0, 8)).join(', ')}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Every worker that has registered, and what is left of the Claude subscription.
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
    <section className="card">
      <div className="row space">
        <h2>
          Claude usage{' '}
          {workers?.length ? (
            <span className="muted">
              {workers.length} worker{workers.length === 1 ? '' : 's'}
            </span>
          ) : null}
        </h2>
      </div>

      {workers === null ? (
        <p className="muted">Loading…</p>
      ) : workers.length ? (
        workers.map((worker) => <WorkerCard key={worker.id} worker={worker} />)
      ) : (
        <p className="muted">
          No worker has registered yet. Start snorkel_worker on any machine — it does not have to be
          one of the machines above.
        </p>
      )}
    </section>
  );
}
