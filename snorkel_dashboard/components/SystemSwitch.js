'use client';

import { useEffect, useState } from 'react';
import { setSystemEnabled, watchSystem } from '@/lib/system';

/**
 * The master switch for every server and worker at once.
 *
 * Deliberately not per machine: "stop everything" is a thing you want in one
 * place when something is going wrong, not a checklist to work through while it
 * carries on going wrong.
 *
 * Turning it off stops new work being taken. It does not interrupt anything
 * already running — a Claude session killed halfway is wasted, and a browser
 * abandoned mid-upload leaves a task in a state nobody chose. The label says so,
 * because "disabled" that leaves something running would otherwise look broken.
 */
export default function SystemSwitch() {
  const [enabled, setEnabled] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => watchSystem(setEnabled), []);

  async function toggle() {
    if (enabled === null) return;
    setBusy(true);
    setError('');
    try {
      await setSystemEnabled(!enabled);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (enabled === null) return <span className="muted">…</span>;

  return (
    <span className="row">
      {error ? <span className="error">{error}</span> : null}
      <button
        className={`sys-switch${enabled ? ' on' : ' off'}`}
        onClick={toggle}
        disabled={busy}
        title={
          enabled
            ? 'Stop every server and worker taking new work. Anything running finishes.'
            : 'Let servers and workers take work again'
        }
      >
        <span className={`dot ${enabled ? 'ok' : 'bad'}`} />
        {busy ? 'saving…' : enabled ? 'System on' : 'System off'}
      </button>
    </span>
  );
}
