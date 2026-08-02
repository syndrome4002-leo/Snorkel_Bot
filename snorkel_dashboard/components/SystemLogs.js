'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { watchLogs } from '@/lib/commands';

function time(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString();
}

const LEVELS = [
  { key: '', label: 'All' },
  { key: 'info', label: 'Info' },
  { key: 'warn', label: 'Warnings' },
  { key: 'error', label: 'Errors' },
];

/**
 * The machine's log stream.
 *
 * The emoji is carried in the data rather than mapped from the event name here,
 * so the server decides how something reads and a new event type shows up
 * correctly without the dashboard needing to know about it.
 */
export default function SystemLogs({ machine }) {
  const [lines, setLines] = useState([]);
  const [level, setLevel] = useState('');
  const [follow, setFollow] = useState(true);
  const boxRef = useRef(null);

  useEffect(() => {
    if (!machine) return undefined;
    setLines([]);
    return watchLogs(machine, setLines);
  }, [machine]);

  const shown = useMemo(
    () => (level ? lines.filter((l) => (l.level || 'info') === level) : lines),
    [lines, level]
  );

  // Stay pinned to the newest line unless the reader has scrolled up to look at
  // something, in which case yanking them back would be rude.
  useEffect(() => {
    if (!follow || !boxRef.current) return;
    boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [shown, follow]);

  const counts = useMemo(() => {
    const out = { warn: 0, error: 0 };
    for (const line of lines) {
      if (line.level === 'warn') out.warn++;
      if (line.level === 'error') out.error++;
    }
    return out;
  }, [lines]);

  return (
    <section className="card">
      <div className="row space">
        <h2>
          System logs{' '}
          <span className="muted">
            {lines.length} line{lines.length === 1 ? '' : 's'}
            {counts.error ? ` · ${counts.error} error${counts.error === 1 ? '' : 's'}` : ''}
            {counts.warn ? ` · ${counts.warn} warning${counts.warn === 1 ? '' : 's'}` : ''}
          </span>
        </h2>
        <div className="row">
          {LEVELS.map((l) => (
            <button
              key={l.key}
              className={`chip${level === l.key ? ' active' : ''}`}
              onClick={() => setLevel(l.key)}
            >
              {l.label}
            </button>
          ))}
          <label className="muted follow">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
            follow
          </label>
        </div>
      </div>

      <div className="logs" ref={boxRef}>
        {shown.length ? (
          shown.map((line) => (
            <div key={line.id} className={`log log-${line.level || 'info'}`}>
              <span className="log-time">{time(line.at)}</span>
              <span className="log-emoji">{line.emoji || 'ℹ️'}</span>
              <span className="log-event">{line.event}</span>
              <span className="log-msg">{line.message}</span>
            </div>
          ))
        ) : (
          <p className="muted">
            {lines.length ? 'Nothing at this level.' : 'No logs yet from this machine.'}
          </p>
        )}
      </div>
    </section>
  );
}
