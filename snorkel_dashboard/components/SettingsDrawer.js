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
    help:
      'While fewer than this many tasks are awaiting revision, this machine starts new ones on its own — as soon as the count drops below it, not on a timer. Empty or 0 turns auto-start off.',
    min: 0,
    placeholder: 'off',
  },
  {
    group: 'Auto-start',
    key: 'try_new_task_every_min',
    label: 'Wait after a failed start (minutes)',
    help:
      'A task is started as soon as the revise list is under the limit above — there is no timer for it. This is only how long to wait after an attempt that did not work, because Snorkel handing out nothing is not something that changes second to second. Defaults to 5.',
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
    group: 'Tracking sheet',
    key: 'sheet_owner',
    type: 'text',
    label: 'Owner ID',
    help: 'Goes in the "Task Owner" column, exactly as the sheet spells it. For example: Syndrome',
    placeholder: 'Syndrome',
  },
  {
    group: 'Tracking sheet',
    key: 'sheet_csv_url',
    type: 'text',
    label: 'Sheet URL (published CSV)',
    help: 'Read only, to check whether a task is already listed before adding it again. File > Share > Publish to web > CSV.',
    placeholder: 'https://docs.google.com/spreadsheets/d/e/.../pub?output=csv',
  },
  {
    group: 'Tracking sheet',
    key: 'sheet_webhook_url',
    type: 'text',
    label: 'Append webhook URL',
    help: 'Where rows are actually written. A published CSV link cannot be written to, so this is the Apps Script web app URL — see SHEET_SETUP.md. Without it nothing is added to the sheet.',
    placeholder: 'https://script.google.com/macros/s/.../exec',
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
    group: 'Submitting',
    key: 'send_to_reviewer',
    type: 'checkbox',
    label: 'Tick "Send to Reviewer"',
    help: 'Ticks the box on the form once both platform checks pass. Nothing is sent by ticking it; it decides where the task goes when the form is finally submitted.',
    fallback: true,
  },
  {
    group: 'Submitting',
    key: 'run_prescriptiveness',
    type: 'checkbox',
    fallback: true,
    label: 'Run the prescriptiveness check',
    help:
      'The platform marks this one optional; Static Checks is not, and always runs. Each run is a full platform build, so turning it off is minutes saved per submission — at the cost of not hearing what it would have said.',
  },
  {
    group: 'Submitting',
    key: 'daily_submit_limit',
    label: 'New tasks to submit per day',
    help: 'Counts new tasks only, not revisions. From midnight, across every machine. At the limit a task is still built, uploaded and checked, and the form filled in for you to submit by hand. Leave it empty for no limit; 0 stops new tasks altogether, and revisions carry on either way.',
    min: 0,
    placeholder: 'no limit',
  },
  {
    group: 'Submitting',
    key: 'auto_submit',
    type: 'checkbox',
    label: 'Submit automatically',
    help: 'Clicks Submit after filling the form. Off means the bot fills everything in and stops, leaving the last click to you. On means a task can reach a reviewer with nobody having read it.',
    fallback: false,
  },
  {
    group: 'Taking on other tasks',
    key: 'adopt_unknown',
    type: 'choice',
    label: 'Tasks in the revise list this system never submitted',
    help:
      'Submissions made by hand under the same owner, that have come back for revision. Taking one on downloads it and builds it like a new task, but it goes back through its own "Revise task" row and gets no new sheet row. Only ever tasks whose owner matches the Owner ID above — a row with no owner on it is left alone.',
    options: [
      { value: 'off', label: 'Leave them alone' },
      { value: 'all', label: 'Take on any of them' },
      { value: 'listed', label: 'Only the UIDs listed below' },
    ],
    placeholder: 'off',
  },
  {
    group: 'Taking on other tasks',
    key: 'adopt_uids',
    type: 'text',
    label: 'UIDs to take on',
    help:
      'One per line, or separated by commas. Only used when "Only the UIDs listed below" is chosen; anything not on the list is left alone.',
    multiline: true,
    placeholder: '0cb4eb47-ea97-4ab8-a541-c4828399407b',
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
          // A checkbox that has never been saved shows its documented default
          // rather than off, so the box matches what the bot will actually do.
          next[field.key] =
            field.type === 'checkbox'
              ? (value?.[field.key] ?? field.fallback ?? false)
              : field.type === 'choice'
                ? (value?.[field.key] ?? field.options[0].value)
                : (value?.[field.key] ?? '');
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
        if (field.type === 'choice') {
          // Written even when it is the first option, so "off" is a decision on
          // the record rather than an absence somebody has to guess a default
          // for — the same reason the checkboxes below are written as booleans.
          const chosen = String(values[field.key] ?? '').trim();
          patch[field.key] = field.options.some((o) => o.value === chosen)
            ? chosen
            : field.options[0].value;
          continue;
        }

        if (field.type === 'text') {
          const raw = String(values[field.key] ?? '').trim();
          patch[field.key] = raw || null;
          continue;
        }

        if (field.type === 'checkbox') {
          // Written as a real boolean rather than left unset, so "off" is a
          // decision on the record instead of an absence the reader has to
          // guess a default for.
          patch[field.key] = Boolean(values[field.key]);
          continue;
        }

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
                {FIELDS.filter((field) => field.group === group).map((field) =>
                  field.type === 'choice' ? (
                    <div key={field.key} className="setting">
                      <label htmlFor={field.key}>{field.label}</label>
                      <p className="muted">{field.help}</p>
                      <select
                        id={field.key}
                        value={values[field.key] ?? field.options[0].value}
                        onChange={(event) =>
                          setValues((current) => ({ ...current, [field.key]: event.target.value }))
                        }
                      >
                        {field.options.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : field.type === 'text' && field.multiline ? (
                    <div key={field.key} className="setting">
                      <label htmlFor={field.key}>{field.label}</label>
                      <p className="muted">{field.help}</p>
                      <textarea
                        id={field.key}
                        rows={4}
                        style={{ width: '100%' }}
                        value={values[field.key] ?? ''}
                        onChange={(event) =>
                          setValues((current) => ({ ...current, [field.key]: event.target.value }))
                        }
                        placeholder={field.placeholder}
                      />
                    </div>
                  ) : field.type === 'text' ? (
                    <div key={field.key} className="setting">
                      <label htmlFor={field.key}>{field.label}</label>
                      <p className="muted">{field.help}</p>
                      <input
                        id={field.key}
                        type="text"
                        style={{ width: '100%' }}
                        value={values[field.key] ?? ''}
                        onChange={(event) =>
                          setValues((current) => ({ ...current, [field.key]: event.target.value }))
                        }
                        placeholder={field.placeholder}
                      />
                    </div>
                  ) : field.type === 'checkbox' ? (
                    <div key={field.key} className="setting">
                      <label className="switch" htmlFor={field.key}>
                        <input
                          id={field.key}
                          type="checkbox"
                          checked={Boolean(values[field.key])}
                          onChange={(event) =>
                            setValues((current) => ({ ...current, [field.key]: event.target.checked }))
                          }
                        />
                        <span>{field.label}</span>
                      </label>
                      <p className="muted">{field.help}</p>
                    </div>
                  ) : (
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
                  )
                )}
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
