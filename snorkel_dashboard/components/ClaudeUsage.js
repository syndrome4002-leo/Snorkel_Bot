'use client';

import { useEffect, useMemo, useState } from 'react';
import { watchWorker } from '@/lib/commands';

function when(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** "in 3 days", "in 4 hours", or "passed" for a window that has already rolled. */
function until(iso) {
  if (!iso) return '';
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return 'passed';
  const hours = ms / 3600000;
  if (hours < 1) return `in ${Math.max(1, Math.round(ms / 60000))} min`;
  if (hours < 48) return `in ${Math.round(hours)} h`;
  return `in ${Math.round(hours / 24)} days`;
}

function Meter({ label, pct, reset }) {
  const value = Number.isFinite(pct) ? pct : null;
  const tone = value === null ? '' : value >= 90 ? ' bad' : value >= 70 ? ' warn' : '';

  return (
    <div className="meter">
      <div className="row space">
        <span>{label}</span>
        <span className="muted">{value === null ? '—' : `${value}%`}</span>
      </div>
      <div className="meter-track">
        <div className={`meter-fill${tone}`} style={{ width: `${value ?? 0}%` }} />
      </div>
      {reset ? (
        <p className="muted">
          resets {until(reset)} <span title={when(reset)}>({when(reset)})</span>
        </p>
      ) : null}
    </div>
  );
}

/**
 * What is left of the Claude subscription, and what this machine has spent.
 *
 * Two different kinds of number, kept apart on purpose. The percentages come
 * from Claude Code's own cache of what the API told it, which only changes when
 * a run comes back carrying limit headers — so it can be badly out of date, and
 * says so rather than being shown as current. The spend underneath is measured
 * by the worker on every task it runs, so it is always true, but it is money
 * rather than quota.
 */
export default function ClaudeUsage({ machine, tasks }) {
  const [worker, setWorker] = useState(null);

  useEffect(() => {
    if (!machine) return undefined;
    setWorker(null);
    return watchWorker(machine, setWorker);
  }, [machine]);

  const spend = useMemo(() => {
    const now = Date.now();
    const day = 24 * 3600 * 1000;
    let today = 0;
    let week = 0;
    let total = 0;
    let runs = 0;

    for (const task of tasks || []) {
      const cost = Number(task.worker_cost_usd);
      if (!Number.isFinite(cost) || cost <= 0) continue;
      runs++;
      total += cost;
      const at = new Date(task.worker_finished_at || task.updated_at || 0).getTime();
      if (!Number.isFinite(at)) continue;
      if (now - at < day) today += cost;
      if (now - at < 7 * day) week += cost;
    }
    return { today, week, total, runs };
  }, [tasks]);

  const usage = worker?.claude_usage;
  const money = (n) => `$${n.toFixed(2)}`;

  return (
    <section className="card">
      <div className="row space">
        <h2>Claude usage</h2>
        {worker ? (
          <span className={`pill${worker.online ? '' : ' muted'}`}>
            <span className={`dot ${worker.online ? 'ok' : 'bad'}`} />
            worker {worker.online ? 'online' : 'offline'}
          </span>
        ) : (
          <span className="muted">no worker on this machine</span>
        )}
      </div>

      {usage?.available ? (
        <>
          <Meter label="5-hour window" pct={usage.session_5h_pct} reset={usage.reset_5h} />
          <Meter label="7-day window" pct={usage.weekly_7d_pct} reset={usage.reset_7d} />
          {usage.stale ? (
            <p className="error">
              These figures are {Math.round(usage.age_hours / 24)} days old. Claude Code only
              rewrites them when a run comes back carrying limit information, so treat them as the
              last thing it heard rather than as the position now.
            </p>
          ) : (
            <p className="muted">Last updated {when(usage.written_at)}.</p>
          )}
        </>
      ) : (
        <p className="muted">
          {worker
            ? usage?.reason || 'The worker has not reported any usage figures yet.'
            : 'Start the worker on this machine to see the subscription windows.'}
        </p>
      )}

      {/* Measured by the worker itself, so unlike the percentages above this is
          always current — it just answers a different question. */}
      <h4 className="group-title">Spent by this bot</h4>
      <div className="pills">
        <span className="pill">last 24 h {money(spend.today)}</span>
        <span className="pill">last 7 days {money(spend.week)}</span>
        <span className="pill">all time {money(spend.total)}</span>
        <span className="pill muted">
          {spend.runs} run{spend.runs === 1 ? '' : 's'}
        </span>
      </div>
    </section>
  );
}
