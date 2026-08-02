'use client';

import { useEffect, useState } from 'react';
import { saveSettings, watchSettings } from '@/lib/commands';

/**
 * The revise-tasks limit.
 *
 * The server checks it on the same five-minute beat the extension already uses
 * to count Revise cards on the home page: if fewer than this many are waiting,
 * it starts a task by itself. Zero or empty turns the whole thing off, which is
 * why "off" is stated in the UI rather than left to be inferred from a blank
 * box.
 */
export default function AutoStart({ machine }) {
  const [limit, setLimit] = useState('');
  const [saved, setSaved] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!machine) return undefined;
    return watchSettings(machine, (value) => {
      const next = value.revise_limit;
      setSaved(next ?? null);
      // Do not fight the user while they are typing.
      setLimit((current) => (document.activeElement?.id === 'revise-limit' ? current : next ?? ''));
    });
  }, [machine]);

  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const trimmed = String(limit).trim();
      const value = trimmed === '' ? null : Number(trimmed);
      if (value !== null && (!Number.isFinite(value) || value < 0)) {
        throw new Error('Enter a whole number, or leave it empty to turn auto-start off.');
      }
      await saveSettings(machine, { revise_limit: value });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const active = Number.isFinite(Number(saved)) && Number(saved) > 0;

  return (
    <section className="card">
      <div className="row space">
        <h2>Auto-start</h2>
        <form className="row" onSubmit={save}>
          <label htmlFor="revise-limit" className="muted">
            Revise tasks limit
          </label>
          <input
            id="revise-limit"
            type="number"
            min="0"
            step="1"
            style={{ width: '6rem' }}
            value={limit}
            onChange={(event) => setLimit(event.target.value)}
            placeholder="off"
          />
          <button type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </form>
      </div>

      <p className="muted">
        {active ? (
          <>
            <strong>On.</strong> Every 5 minutes the machine counts the tasks awaiting revision; if
            there are fewer than <strong>{saved}</strong>, it starts a new one by itself.
          </>
        ) : (
          <>
            <strong>Off.</strong> Set a limit to have this machine start tasks on its own. It will
            keep starting new ones while fewer than that many are awaiting revision.
          </>
        )}
      </p>

      {error ? <p className="error">{error}</p> : null}
    </section>
  );
}
