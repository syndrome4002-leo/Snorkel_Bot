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
export default function StartTask({ machine, serverOnline, inBuildTask, taskInFlight, onOpenSettings }) {
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
    // Only one task at a time: a second one would download over the first
    // machine's work before it has been finished and uploaded. Checked here so
    // nothing is written to the database at all.
    // taskInFlight covers the window the Firestore check cannot: a run that has
    // started but whose task document is not written until the download ends.
    if (inBuildTask || taskInFlight) {
      window.alert('A task is in building');
      return;
    }

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
          // Snorkel handed out no task — a normal outcome (daily limit, empty
          // queue), so it is called out rather than buried in the error line.
          if (value.error_code === 'DAILY_LIMIT') {
            window.alert(value.error || "Today's limit for new tasks has been reached.");
          } else if (value.error_code === 'START_UNAVAILABLE') {
            window.alert('currently not able to start a new task');
          }
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

        <button onClick={onOpenSettings} title="Auto-start and other machine settings">
          Settings
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

      {inBuildTask ? (
        <p className="muted">
          <strong>{inBuildTask.UID}</strong> is still in build. Finish and upload it before starting
          another.
        </p>
      ) : taskInFlight ? (
        <p className="muted">A task is being started on this machine.</p>
      ) : null}

      {command?.error_code === 'START_UNAVAILABLE' ? (
        <p className="muted">
          Snorkel did not hand out a task. That usually means a daily limit, an empty queue, or
          somebody else took the assignment — try again later.
        </p>
      ) : null}

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
