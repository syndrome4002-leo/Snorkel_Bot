'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { watchTaskLogs } from '@/lib/taskLogs';

function time(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** Gap since the previous line, so a slow step is obvious at a glance. */
function gap(previous, current) {
  if (!previous) return '';
  const ms = new Date(current).getTime() - new Date(previous).getTime();
  if (!Number.isFinite(ms) || ms < 30_000) return '';
  const minutes = Math.round(ms / 60_000);
  return minutes >= 1 ? `+${minutes}m` : `+${Math.round(ms / 1000)}s`;
}

/**
 * What happened to one task, from download to submission.
 *
 * Two processes write here — the server that fetched it and the worker that
 * built it — and they usually run on different computers, so each line says
 * which one it came from. Without that the sequence reads as one confusing
 * narrative rather than two cooperating ones.
 */
export default function TaskLogsDrawer({ task, onClose }) {
  const [lines, setLines] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const boxRef = useRef(null);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  useEffect(() => {
    if (!task?.UID) return undefined;
    setLines([]);
    setLoaded(false);
    return watchTaskLogs(task.UID, (rows) => {
      setLines(rows);
      setLoaded(true);
    });
  }, [task?.UID]);

  // A build in progress appends as you watch, so stay at the newest line.
  useEffect(() => {
    if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [lines]);

  const elapsed = useMemo(() => {
    if (lines.length < 2) return '';
    const ms = new Date(lines[lines.length - 1].at).getTime() - new Date(lines[0].at).getTime();
    if (!Number.isFinite(ms) || ms <= 0) return '';
    const minutes = Math.round(ms / 60_000);
    return minutes >= 1 ? `${minutes} min` : `${Math.round(ms / 1000)}s`;
  }, [lines]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h3>Build log</h3>
            <p className="muted mono">{task.UID}</p>
          </div>
          <button onClick={onClose}>Close</button>
        </header>

        <div className="modal-body">
          <p className="muted">
            {lines.length
              ? `${lines.length} line${lines.length === 1 ? '' : 's'}${elapsed ? ` over ${elapsed}` : ''}`
              : loaded
                ? ''
                : 'Loading…'}
          </p>

          <div className="logs task-logs" ref={boxRef}>
            {lines.length ? (
              lines.map((line, index) => (
                <div key={line.id} className={`log log-${line.level || 'info'}`}>
                  <span className="log-time">{time(line.at)}</span>
                  <span className="log-emoji">{line.emoji || 'ℹ️'}</span>
                  <span className={`log-source src-${line.source || 'worker'}`}>
                    {line.source || 'worker'}
                  </span>
                  <span className="log-event">{line.event}</span>
                  <span className="log-msg">{line.message}</span>
                  {/* Only shown when there was a real wait, so it reads as a
                      signal rather than as noise on every line. */}
                  {gap(lines[index - 1]?.at, line.at) ? (
                    <span className="log-gap">{gap(lines[index - 1].at, line.at)}</span>
                  ) : null}
                </div>
              ))
            ) : loaded ? (
              <p className="muted">
                Nothing logged for this task yet. Lines appear here as the server downloads it and
                the worker builds it.
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
