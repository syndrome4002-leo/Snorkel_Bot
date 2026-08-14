'use client';

import { useCallback, useMemo, useState } from 'react';
import { addKnownUid } from '@/lib/tasks';
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

function TaskRow({ task, showMachine, onOpenLogs, onOpenCheck, onDelete }) {
  const [open, setOpen] = useState(false);
  const status = task.task_status || '—';
  const check = task.static_check_result || null;

  return (
    <>
      <tr
        className={
          [isWorking(status) ? 'working-row' : '']
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


          <button className="link" onClick={() => setOpen((value) => !value)}>
            {open ? 'hide' : 'details'}
          </button>
        </td>
      </tr>
      {open ? (
        <tr className="details">
          <td colSpan={showMachine ? 7 : 6}>
            {/* The task's own info, and nothing else — every other field is
                already a column. */}
            <pre>{task.initial_infos || '(no infos captured)'}</pre>
          </td>
        </tr>
      ) : null}
    </>
  );
}

export default function TaskTable({ tasks, note, onRefresh, showMachine = false, onDelete }) {
  const [filter, setFilter] = useState('');
  const [newUid, setNewUid] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState('');

  const addUid = useCallback(
    async (event) => {
      event.preventDefault();
      setAddError('');
      setAdding(true);
      try {
        await addKnownUid(newUid);
        setNewUid('');
      } catch (err) {
        // Shown rather than thrown: the usual cause is a UID already on the
        // list, which is worth saying plainly and is not an error to chase.
        setAddError(String(err?.message || err));
      } finally {
        setAdding(false);
      }
    },
    [newUid]
  );
  const [logsTask, setLogsTask] = useState(null);
  const [checkTask, setCheckTask] = useState(null);

  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const matched = tasks.filter((task) => {
      if (!needle) return true;
      return [task.UID, task.file_name, task.task_status, task.dropbox_path, task.machine_id].some(
        (value) => String(value || '').toLowerCase().includes(needle)
      );
    });

    return matched;
  }, [tasks, filter]);

  return (
    <section className="card">
      <div className="row space">
        <h2>
          Tasks{' '}
          <span className="muted">{rows.length}</span>
        </h2>
        <div className="row">
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

      {/*
        Adding a UID by hand records one the bot must leave alone: a submission
        done before the bot existed, or by somebody else on this account. It is
        the same list either way — the bot skips any UID already in it — so this
        sits with the table rather than in a drawer of its own.
      */}
      <form className="row add-uid" onSubmit={addUid}>
        <input
          type="text"
          placeholder="add a UID the bot should skip…"
          value={newUid}
          onChange={(event) => setNewUid(event.target.value)}
          disabled={adding}
        />
        <button type="submit" disabled={adding || !newUid.trim()}>
          {adding ? 'Adding…' : 'Add UID'}
        </button>
      </form>
      {addError ? <p className="muted error">{addError}</p> : null}

      <p className="muted">{note}</p>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>UID</th>
              {showMachine ? <th>Machine</th> : null}
              <th>File</th>
              <th>Status</th>
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
                  onOpenLogs={setLogsTask}
                  onOpenCheck={setCheckTask}
                  onDelete={onDelete}
                />
              ))
            ) : (
              <tr>
                <td colSpan={showMachine ? 7 : 6} className="muted">
                  {tasks.length ? 'Nothing matches that filter.' : 'No tasks yet.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>


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
