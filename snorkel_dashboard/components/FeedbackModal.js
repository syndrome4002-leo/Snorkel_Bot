'use client';

import { useEffect } from 'react';

function when(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/**
 * How a check pane's text was obtained. Only the scrolled path can come up
 * short, so it is the only one worth calling out.
 */
function viaNote(via) {
  if (!via) return null;
  if (via.startsWith('scrolled') || via.startsWith('rendered')) {
    return { label: via, warn: via.includes('out of time') };
  }
  return { label: via, warn: false };
}

/**
 * What one round says about the revision before it.
 *
 * Computed here from the stored signatures rather than read from
 * `check_progress`, so it works on rounds recorded before that field existed —
 * and so the panel never disagrees with the prompt, which derives it the same
 * way.
 */
function Scorecard({ previous, entry }) {
  const before = new Set(Array.isArray(previous?.check_signatures) ? previous.check_signatures : []);
  const after = Array.isArray(entry.check_signatures) ? entry.check_signatures : [];
  if (!previous || (!before.size && !after.length)) return null;

  const afterSet = new Set(after);
  const fixed = [...before].filter((s) => !afterSet.has(s));
  const persisted = [...before].filter((s) => afterSet.has(s));
  const introduced = after.filter((s) => !before.has(s));
  if (!fixed.length && !persisted.length && !introduced.length) return null;

  const row = (label, items, tone) =>
    items.length ? (
      <div className={`score-row ${tone}`}>
        <span className="score-label">{label}</span>
        <span className="score-items mono">{items.join(', ')}</span>
      </div>
    ) : null;

  return (
    <div className={`scorecard${introduced.length ? ' regressed' : ''}`}>
      {row('fixed', fixed, 'good')}
      {row('still open', persisted, 'warn')}
      {row('caused by the last round', introduced, 'bad')}
    </div>
  );
}

function Round({ entry, index, total, previous }) {
  const notes = Array.isArray(entry.notes) ? entry.notes : [];
  const checks = Array.isArray(entry.checks) ? entry.checks : [];
  const withText = checks.filter((c) => c.text);

  return (
    <section className="round">
      <header className="round-head">
        <span className="round-no">
          Round {index + 1} <span className="muted">of {total}</span>
        </span>
        <span className="muted">{when(entry.collected_at)}</span>
      </header>

      <Scorecard previous={previous} entry={entry} />

      <h4 className="group-title">Reviewer notes</h4>
      {notes.length ? (
        notes.map((note, i) => (
          <article key={i} className="note-card">
            <h5>{note.title}</h5>
            <pre>{note.body}</pre>
          </article>
        ))
      ) : (
        // Older rounds were stored before notes were split out; the combined
        // text is all there is for those.
        <article className="note-card">
          <pre className="muted">{entry.text || '(nothing recorded)'}</pre>
        </article>
      )}

      <h4 className="group-title">
        Automated checks{' '}
        <span className="muted">
          {checks.length ? `${withText.length} of ${checks.length} with content` : 'none captured'}
        </span>
      </h4>
      {checks.length ? (
        <div className="check-grid">
          {checks.map((check) => {
            const note = viaNote(check.via);
            const empty = !check.text;
            return (
              <article key={check.testid || check.title} className={`check-card${empty ? ' is-empty' : ''}`}>
                <h5>
                  {check.title}
                  {note ? (
                    <span className={`via${note.warn ? ' via-warn' : ''}`} title="how this text was read">
                      {note.label}
                    </span>
                  ) : null}
                </h5>
                {empty ? (
                  <p className="muted">(no result yet)</p>
                ) : (
                  <>
                    <pre>{check.text}</pre>
                    <p className="muted">{check.chars ?? check.text.length} characters</p>
                  </>
                )}
              </article>
            );
          })}
        </div>
      ) : (
        <p className="muted">No check panes were on the page for this round.</p>
      )}
    </section>
  );
}

/**
 * A drawer down the right-hand side rather than a centred box: these logs are
 * tall and narrow — rounds stacked vertically — so the shape of the window
 * should match. It also leaves the task table visible behind it.
 */
export default function FeedbackModal({ task, onClose }) {
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

  const feedbacks = Array.isArray(task.feedbacks) ? task.feedbacks : [];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h3>Feedback log</h3>
            <p className="muted mono">{task.UID}</p>
          </div>
          <button onClick={onClose}>Close</button>
        </header>

        <div className="modal-body">
          {feedbacks.length ? (
            // Newest last: reading top to bottom follows the conversation.
            feedbacks.map((entry, index) => (
              <Round
                key={index}
                entry={entry}
                index={index}
                total={feedbacks.length}
                previous={index ? feedbacks[index - 1] : null}
              />
            ))
          ) : (
            <p className="muted">No feedback has been collected for this task.</p>
          )}
        </div>
      </div>
    </div>
  );
}
