'use client';

import { useState } from 'react';

/**
 * Chooses which machine the page is looking at. "All machines" is a read-only
 * view: tasks from everywhere, but nothing to start, because a command has to
 * go to one specific machine.
 */
export default function MachinePicker({ machines, selected, statuses, onSelect, onAdd, onRemove }) {
  const [value, setValue] = useState('');

  function submit(event) {
    event.preventDefault();
    const id = value.trim();
    if (!id) return;
    onAdd(id);
    setValue('');
  }

  return (
    <section className="card">
      <div className="row space">
        <h2>Machines</h2>
        <form className="row" onSubmit={submit}>
          <input
            type="text"
            placeholder="machine id, e.g. goran-virtual-machine-70e3eec3"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            size={38}
          />
          <button type="submit">Add</button>
        </form>
      </div>

      {machines.length === 0 ? (
        <p className="muted">
          No machines yet. Start the server and it prints its id:
          <br />
          <code>[server] machine id: …</code> — paste that above.
        </p>
      ) : (
        <div className="machines">
          <button
            className={`machine ${selected === '' ? 'active' : ''}`}
            onClick={() => onSelect('')}
            title="Tasks from every machine; no controls"
          >
            <span className="dot" />
            All machines
          </button>

          {machines.map((id) => {
            const status = statuses[id];
            const online = Boolean(status?.online);
            return (
              <span key={id} className={`machine ${selected === id ? 'active' : ''}`}>
                <button className="machine-main" onClick={() => onSelect(id)}>
                  <span className={`dot ${status ? (online ? 'ok' : 'bad') : ''}`} />
                  <span className="machine-name">{status?.hostname || id}</span>
                  <span className="machine-id">{id}</span>
                </button>
                <button
                  className="link"
                  title="Forget this machine"
                  onClick={() => onRemove(id)}
                >
                  ×
                </button>
              </span>
            );
          })}
        </div>
      )}
    </section>
  );
}
