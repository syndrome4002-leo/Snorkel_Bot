'use client';

import { useState } from 'react';

/*
 * The machine list, split in two because its halves belong in different places.
 *
 * `MachineAdd` is an action and lives in the top bar with the other actions.
 * `MachineList` is state — which machines exist, which is selected, which are
 * online — and lives in the bottom bar alongside the Claude gauges, where it can
 * be read at a glance without taking a card's worth of the page.
 *
 * This list is more than a filter: snorkel_worker reads it to decide whose tasks
 * to work on. Removing a machine here stops the worker picking up its tasks,
 * which is why the button says so rather than something that sounds cosmetic.
 */

/** The add form, for the top bar. */
export function MachineAdd({ onAdd, note }) {
  const [value, setValue] = useState('');

  function submit(event) {
    event.preventDefault();
    const id = value.trim();
    if (!id) return;
    onAdd(id);
    setValue('');
  }

  return (
    <form
      className="machine-add"
      onSubmit={submit}
      title={note || 'Add a machine for the worker to work on'}
    >
      <input
        type="text"
        placeholder="add machine id…"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        aria-label="Machine id to add"
      />
      <button type="submit" disabled={!value.trim()}>
        Add
      </button>
      {note ? <span className="machine-add-note error">{note}</span> : null}
    </form>
  );
}

/**
 * The machines themselves, for the bottom bar.
 *
 * "All machines" is a read-only view: tasks from everywhere, but nothing to
 * start, because a command has to go to one specific machine.
 */
export function MachineList({ machines, selected, statuses, onSelect, onRemove }) {
  if (!machines.length) {
    return (
      <span
        className="muted machine-empty"
        title="Start the server; it prints its id as [server] machine id: …"
      >
        no machines yet
      </span>
    );
  }

  return (
    <div className="machines">
      <button
        className={`machine ${selected === '' ? 'active' : ''}`}
        onClick={() => onSelect('')}
        title="Tasks from every machine; no controls"
      >
        <span className="dot" />
        All
      </button>

      {machines.map((id) => {
        const status = statuses[id];
        const online = Boolean(status?.online);
        return (
          <span key={id} className={`machine ${selected === id ? 'active' : ''}`}>
            <button className="machine-main" onClick={() => onSelect(id)} title={id}>
              <span className={`dot ${status ? (online ? 'ok' : 'bad') : ''}`} />
              <span className="machine-name">{status?.hostname || id}</span>
            </button>
            <button
              className="link machine-remove"
              title="Stop working this machine — the worker will no longer pick up its tasks"
              onClick={() => onRemove(id)}
            >
              ×
            </button>
          </span>
        );
      })}
    </div>
  );
}
