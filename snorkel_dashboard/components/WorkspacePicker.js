'use client';

import { useEffect, useState } from 'react';
import { DEFAULT_WORKSPACE, setWorkspace, workspace } from '@/lib/workspace';

/**
 * Which deployment this dashboard is looking at.
 *
 * One Firebase project can carry several independent set-ups. They share a
 * database, so something has to say which of them this browser belongs to —
 * a dashboard is a static page with no identity of its own, and there is
 * nothing else to tell two of them apart by.
 *
 * Shown as plain text until clicked, because it is set once when a machine is
 * put together and never again. A dropdown or a permanent input would give it a
 * prominence it does not deserve.
 */
export default function WorkspacePicker() {
  const [name, setName] = useState('');
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState('');

  // After mount: the value comes from localStorage, which the server render
  // cannot see.
  useEffect(() => setName(workspace()), []);

  if (!name) return null;

  function save(event) {
    event.preventDefault();
    try {
      setWorkspace(value); // reloads the page
    } catch (err) {
      setError(err.message);
    }
  }

  if (!editing) {
    return (
      <button
        className="workspace-chip"
        title={
          `This dashboard is showing the "${name}" deployment.\n\n` +
          'Its machines, its master switch and its workers are its own. Click to ' +
          'change it — the worker and server on this machine need the same name ' +
          'in their .env as WORKSPACE.'
        }
        onClick={() => {
          setValue(name === DEFAULT_WORKSPACE ? '' : name);
          setEditing(true);
        }}
      >
        <span className="workspace-dot" />
        {name}
      </button>
    );
  }

  return (
    <form className="workspace-edit" onSubmit={save}>
      <input
        autoFocus
        value={value}
        placeholder={DEFAULT_WORKSPACE}
        onChange={(event) => {
          setValue(event.target.value);
          setError('');
        }}
        aria-label="Deployment name"
        title="Must match WORKSPACE in this machine's snorkel_worker and snorkel_server"
      />
      <button type="submit">Use</button>
      <button type="button" className="link" onClick={() => setEditing(false)}>
        cancel
      </button>
      {error ? <span className="error">{error}</span> : null}
    </form>
  );
}
