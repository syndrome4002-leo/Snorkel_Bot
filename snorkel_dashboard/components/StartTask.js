'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { startNewTask, watchCommand } from '@/lib/commands';

const STEPS = [
  ['snorkel', 'Snorkel — start, scrape, download'],
  ['dropbox', 'Dropbox — upload, clean up, update Firestore'],
  ['done', 'done'],
];

/**
 * Writes a command to the Realtime Database and watches it.
 *
 * There is no request to the server here — it is listening on /commands and
 * updates the same node as it goes, so progress arrives as a live update. The
 * work is the server's once the command is written: closing this tab, or losing
 * the network, does not cancel anything.
 */
export default function StartTask({ machine, serverOnline }) {
  const [command, setCommand] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const unsubscribe = useRef(null);

  const detach = useCallback(() => {
    if (unsubscribe.current) {
      unsubscribe.current();
      unsubscribe.current = null;
    }
  }, []);

  useEffect(() => detach, [detach]);

  async function start() {
    setBusy(true);
    setError('');
    setCommand(null);
    detach();

    try {
      const id = await startNewTask(machine);
      unsubscribe.current = watchCommand(machine, id, (value) => {
        if (!value) return;
        setCommand(value);
        if (['succeeded', 'failed', 'expired'].includes(value.status)) {
          setBusy(false);
          detach();
        }
      });
    } catch (err) {
      setBusy(false);
      setError(err.message);
    }
  }

  const reached = command ? STEPS.findIndex(([key]) => key === command.step) : -1;

  return (
    <section className="card">
      <div className="row">
        <button className="primary" onClick={start} disabled={busy}>
          {busy ? 'Running…' : 'Start new task'}
        </button>

        <span className="muted">
          {command?.status === 'succeeded'
            ? `done — ${command.file_name} (${command.uid})`
            : command?.status === 'failed'
              ? 'failed'
              : command?.status === 'expired'
                ? 'expired — the server was not running'
                : command?.status === 'pending'
                  ? 'queued — waiting for the server to pick it up'
                  : command
                    ? `running — ${STEPS.find(([key]) => key === command.step)?.[1] || command.step}`
                    : ''}
        </span>
      </div>

      {!serverOnline ? (
        <p className="muted">
          The server is offline. You can still queue a task — it will be picked up when the server
          comes back, as long as that is within 10 minutes.
        </p>
      ) : null}

      {command ? (
        <ol className="steps">
          {STEPS.map(([key, label], index) => (
            <li key={key} className={reached >= index ? 'done' : ''}>
              {label}
            </li>
          ))}
        </ol>
      ) : null}

      {command?.error ? <p className="error">{command.error}</p> : null}
      {error ? <p className="error">{error}</p> : null}
    </section>
  );
}
