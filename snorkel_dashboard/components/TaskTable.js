'use client';

import { useMemo, useState } from 'react';
import FeedbackModal from './FeedbackModal';
import TaskLogsDrawer from './TaskLogsDrawer';
import StaticCheckDrawer from './StaticCheckDrawer';

function when(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/** "in build" would otherwise become two class names. */
const statusClass = (status) => String(status).trim().toLowerCase().replace(/\s+/g, '-');

/*
 * The one status that means something is happening right now: Claude has the
 * folder open. Everything else is a task waiting its turn, and a row that
 * animates while nothing is being done to it is a lie told cheerfully.
 */
const isWorking = (status) => /^working/i.test(String(status).trim());

function TaskRow({ task, showMachine, onOpenFeedback, onOpenLogs, onOpenCheck, onDelete }) {
  const [open, setOpen] = useState(false);
  const status = task.task_status || '—';
  const rounds = Array.isArray(task.feedbacks) ? task.feedbacks.length : 0;
  const check = task.static_check_result || null;
  // Tasks written before this field existed have neither true nor false, and
  // guessing would be worse than saying nothing.
  const known = typeof task.is_new_task === 'boolean';

  return (
    <>
      <tr
        className={
          [task.is_new_task === true ? 'pinned' : '', isWorking(status) ? 'working-row' : '']
            .filter(Boolean)
            .join(' ') || undefined
        }
        title={isWorking(status) ? 'Claude has this task open' : undefined}
      >
        <td className="mono">{task.UID}</td>
        {showMachine ? <td className="mono">{task.machine_id || '—'}</td> : null}
        <td className="mono">{task.file_name || '—'}</td>
        <td>
          <span className={`badge ${statusClass(status)}`}>{status}</span>
        </td>
        <td>
          {known ? (
            <span
              className={`badge ${task.is_new_task ? 'kind-new' : 'kind-revision'}`}
              title={
                task.is_new_task
                  ? 'Started fresh by the bot and never reviewed'
                  : 'A reviewer has sent this back at least once'
              }
            >
              {task.is_new_task ? 'new' : 'revision'}
            </span>
          ) : (
            <span className="muted">—</span>
          )}
        </td>
        <td>{task.file_uploaded ? 'yes' : 'no'}</td>
        <td>{when(task.updated_at)}</td>
        <td className="row-actions">
          {onDelete ? (
            <button
              className="link danger"
              title={
                'Throw this task away: its folder on the worker machine, its record here, ' +
                'and its zip in Dropbox.\n\nThe tracking sheet is left alone — a row there ' +
                'is the history of what was submitted, and this does not un-submit it.'
              }
              onClick={() => onDelete(task)}
            >
              delete
            </button>
          ) : null}

          {check ? (
            <button
              className={`link${check.passed ? '' : ' danger'}`}
              title={
                check.passed
                  ? 'Both platform checks passed'
                  : 'A platform check failed — open for the build logs'
              }
              onClick={() => onOpenCheck(task)}
            >
              {check.passed ? 'checks ✓' : 'checks ✗'}
            </button>
          ) : null}

          <button
            className="link"
            title="What happened to this task, from download to submission"
            onClick={() => onOpenLogs(task)}
          >
            build log
          </button>

          <button
            className="link"
            disabled={!rounds}
            title={rounds ? 'Reviewer notes and automated checks' : 'No feedback collected yet'}
            onClick={() => onOpenFeedback(task)}
          >
            feedback{rounds ? ` (${rounds})` : ''}
          </button>

          <button className="link" onClick={() => setOpen((value) => !value)}>
            {open ? 'hide' : 'details'}
          </button>
        </td>
      </tr>
      {open ? (
        <tr className="details">
          <td colSpan={showMachine ? 8 : 7}>
            {/* The task's own info, and nothing else — every other field is
                already a column, and the feedback has its own drawer. */}
            <pre>{task.initial_infos || '(no infos captured)'}</pre>
          </td>
        </tr>
      ) : null}
    </>
  );
}

const KINDS = [
  { key: '', label: 'All' },
  { key: 'new', label: 'New' },
  { key: 'revision', label: 'Revisions' },
];

export default function TaskTable({ tasks, note, onRefresh, showMachine = false, onDelete }) {
  const [filter, setFilter] = useState('');
  const [kind, setKind] = useState('');
  const [feedbackTask, setFeedbackTask] = useState(null);
  const [logsTask, setLogsTask] = useState(null);
  const [checkTask, setCheckTask] = useState(null);

  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const matched = tasks.filter((task) => {
      if (kind === 'new' && task.is_new_task !== true) return false;
      if (kind === 'revision' && task.is_new_task !== false) return false;
      if (!needle) return true;
      return [task.UID, task.file_name, task.task_status, task.dropbox_path, task.machine_id].some(
        (value) => String(value || '').toLowerCase().includes(needle)
      );
    });

    /*
     * New tasks first, everything else in the order it arrived (newest updated).
     * A new task is the one being worked right now and the one you are waiting
     * on; a long tail of finished revisions should not push it off the screen.
     *
     * Two passes rather than a comparator so the existing order is preserved
     * exactly within each group.
     */
    return [
      ...matched.filter((task) => task.is_new_task === true),
      ...matched.filter((task) => task.is_new_task !== true),
    ];
  }, [tasks, filter, kind]);

  const newCount = useMemo(() => tasks.filter((t) => t.is_new_task === true).length, [tasks]);

  return (
    <section className="card">
      <div className="row space">
        <h2>
          Tasks{' '}
          {newCount ? <span className="muted">{newCount} new</span> : null}
        </h2>
        <div className="row">
          {KINDS.map((k) => (
            <button
              key={k.key}
              className={`chip${kind === k.key ? ' active' : ''}`}
              onClick={() => setKind(k.key)}
            >
              {k.label}
            </button>
          ))}
          <input
            type="search"
            placeholder="filter by UID, file, status…"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          {/* Firestore pushes changes, so a refresh button is only useful when
              a caller passes one in. */}
          {onRefresh ? <button onClick={onRefresh}>Refresh</button> : null}
        </div>
      </div>

      <p className="muted">{note}</p>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>UID</th>
              {showMachine ? <th>Machine</th> : null}
              <th>File</th>
              <th>Status</th>
              <th>Kind</th>
              <th>Uploaded</th>
              <th>Updated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.length ? (
              rows.map((task) => (
                <TaskRow
                  key={task.UID}
                  task={task}
                  showMachine={showMachine}
                  onOpenFeedback={setFeedbackTask}
                  onOpenLogs={setLogsTask}
                  onOpenCheck={setCheckTask}
                  onDelete={onDelete}
                />
              ))
            ) : (
              <tr>
                <td colSpan={showMachine ? 8 : 7} className="muted">
                  {tasks.length ? 'Nothing matches that filter.' : 'No tasks yet.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {feedbackTask ? (
        // Keyed on the live row, so a round arriving while it is open shows up.
        <FeedbackModal
          task={tasks.find((t) => t.UID === feedbackTask.UID) || feedbackTask}
          onClose={() => setFeedbackTask(null)}
        />
      ) : null}

      {logsTask ? (
        <TaskLogsDrawer
          task={tasks.find((t) => t.UID === logsTask.UID) || logsTask}
          onClose={() => setLogsTask(null)}
        />
      ) : null}

      {checkTask ? (
        <StaticCheckDrawer
          task={tasks.find((t) => t.UID === checkTask.UID) || checkTask}
          onClose={() => setCheckTask(null)}
        />
      ) : null}
    </section>
  );
}
