'use client';

import { useEffect, useState } from 'react';
import { saveSettings, watchSettings } from '@/lib/commands';

/**
 * Machine settings, in the same right-hand drawer the feedback log uses.
 *
 * Kept out of the page body on purpose: these are set once and then left alone,
 * so a permanent panel would be taking up room for something you rarely touch.
 */
const FIELDS = [
  {
    group: 'Auto-start',
    key: 'revise_limit',
    label: 'Revise tasks limit',
    help: 'While fewer than this many tasks are awaiting revision, this machine starts new ones on its own. Empty or 0 turns auto-start off.',
    min: 0,
    placeholder: 'off',
  },
  {
    group: 'Auto-start',
    key: 'try_new_task_every_min',
    label: 'Try new task in (minutes)',
    help: 'How often the machine checks the limit and, if it is under, starts a task. Defaults to 5.',
    min: 1,
    placeholder: '5',
  },
  {
    group: 'Auto-start',
    key: 'check_revise_every_min',
    label: 'Check revise list in (minutes)',
    help: 'How often the extension reloads the home page and re-counts the tasks awaiting revision. Defaults to 5.',
    min: 1,
    placeholder: '5',
  },
  {
    group: 'Auto-start',
    key: 'submit_check_every_min',
    label: 'Look for tasks to upload in (minutes)',
    help: 'How often the machine looks for a finished task, puts its zip back into the platform and runs the two checks. Defaults to 3.',
    min: 1,
    placeholder: '3',
  },
  {
    group: 'Worker',
    key: 'worker_max_concurrent',
    label: 'Max tasks at once',
    help: 'How many tasks Claude works on at the same time. Each one builds a repo and runs its tests, so more is not always faster. Defaults to 3.',
    min: 1,
    placeholder: '3',
  },
  {
    group: 'Worker',
    key: 'static_fix_limit',
    label: 'Static check fix attempts',
    help: 'How many times to answer a failed platform check before leaving the task alone. Each attempt is a full Claude session plus two platform builds. Defaults to 5.',
    min: 1,
    placeholder: '5',
  },
];

/** Field order is fixed, so the groups render in the order they first appear. */
const GROUPS = [...new Set(FIELDS.map((f) => f.group))];

export default function SettingsDrawer({ machine, onClose }) {
  const [values, setValues] = useState({});
  const [saved, setSaved] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Escape closes it, and the page behind must not scroll while it is open.
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
    if (!machine) return undefined;
    return watchSettings(machine, (value) => {
      setSaved(value || {});
      // Do not overwrite a field while it is being typed into.
      setValues((current) => {
        const next = { ...current };
        for (const field of FIELDS) {
          if (document.activeElement?.id === field.key) continue;
          next[field.key] = value?.[field.key] ?? '';
        }
        return next;
      });
    });
  }, [machine]);

  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const patch = {};
      for (const field of FIELDS) {
        const raw = String(values[field.key] ?? '').trim();
        if (raw === '') {
          patch[field.key] = null;
          continue;
        }
        const n = Number(raw);
        if (!Number.isFinite(n) || n < field.min) {
          throw new Error(`${field.label}: enter a number of ${field.min} or more, or leave it empty.`);
        }
        patch[field.key] = n;
      }
      await saveSettings(machine, patch);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const active = Number(saved.revise_limit) > 0;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h3>Settings</h3>
            <p className="muted mono">{machine}</p>
          </div>
          <button onClick={onClose}>Close</button>
        </header>

        <div className="modal-body">
          <form onSubmit={save}>
            {GROUPS.map((group) => (
              <div key={group}>
                <h4 className="group-title">{group}</h4>
                {FIELDS.filter((field) => field.group === group).map((field) => (
                  <div key={field.key} className="setting">
                    <label htmlFor={field.key}>{field.label}</label>
                    <p className="muted">{field.help}</p>
                    <input
                      id={field.key}
                      type="number"
                      min={field.min}
                      step="1"
                      style={{ width: '8rem' }}
                      value={values[field.key] ?? ''}
                      onChange={(event) =>
                        setValues((current) => ({ ...current, [field.key]: event.target.value }))
                      }
                      placeholder={field.placeholder}
                    />
                  </div>
                ))}
              </div>
            ))}

            <button type="submit" className="primary" disabled={busy}>
              {busy ? 'Saving…' : 'Save settings'}
            </button>
          </form>

          <p className={active ? 'state-on' : 'muted'}>
            {active ? (
              <>
                Auto-start is <strong>on</strong> — limit {saved.revise_limit}, trying every{' '}
                {saved.try_new_task_every_min ?? 5} min, revise list checked every{' '}
                {saved.check_revise_every_min ?? 5} min.
              </>
            ) : (
              <>Auto-start is <strong>off</strong>. Set a revise tasks limit to turn it on.</>
            )}
          </p>

          <p className="muted">
            Claude works up to <strong>{saved.worker_max_concurrent ?? 3}</strong> task
            {(saved.worker_max_concurrent ?? 3) === 1 ? '' : 's'} at once. Takes effect on the
            worker straight away — a task already running is never interrupted.
          </p>

          {error ? <p className="error">{error}</p> : null}
        </div>
      </div>
    </div>
  );
}
