'use client';

import { useEffect } from 'react';

function when(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/**
 * What the platform's own checks said about a task.
 *
 * Both are shown, passing one included. A failure is rarely self-explanatory
 * from its own logs alone, and the check that passed is often what tells you
 * whether the problem is the task or the environment it ran in.
 */
export default function StaticCheckDrawer({ task, onClose }) {
  const check = task.static_check_result;

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

  if (!check) return null;
  const results = check.results || [];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h3>Platform checks</h3>
            <p className="muted mono">{task.UID}</p>
          </div>
          <button onClick={onClose}>Close</button>
        </header>

        <div className="modal-body">
          <p className={check.passed ? 'state-on' : 'error'}>
            {check.passed ? 'Both checks passed.' : 'A check failed.'}{' '}
            <span className="muted">{when(check.checked_at)}</span>
          </p>

          {results.map((result) => (
            <section key={result.key} className="check-result">
              <div className="row space">
                <h4 className="group-title">{result.label}</h4>
                <span className={`badge ${result.verdict === 'pass' ? 'kind-new' : 'in-build'}`}>
                  {(result.verdict || 'unknown').toUpperCase()}
                </span>
              </div>

              {result.summary ? <p className="muted">{result.summary}</p> : null}

              {result.logs ? (
                <pre className="check-logs">{result.logs}</pre>
              ) : (
                <p className="muted">No build logs were captured for this check.</p>
              )}
            </section>
          ))}

          {check.page_url ? (
            <p className="muted">
              <a href={check.page_url} target="_blank" rel="noreferrer">
                Open the task on the platform
              </a>
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
