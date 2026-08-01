'use client';

import { useMemo, useState } from 'react';

function when(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/** "in build" would otherwise become two class names. */
const statusClass = (status) => String(status).trim().toLowerCase().replace(/\s+/g, '-');

function TaskRow({ task, showMachine }) {
  const [open, setOpen] = useState(false);
  const status = task.task_status || '—';

  return (
    <>
      <tr>
        <td className="mono">{task.UID}</td>
        {showMachine ? <td className="mono">{task.machine_id || '—'}</td> : null}
        <td className="mono">{task.file_name || '—'}</td>
        <td>
          <span className={`badge ${statusClass(status)}`}>{status}</span>
        </td>
        <td>{task.file_uploaded ? 'yes' : 'no'}</td>
        <td>{when(task.updated_at)}</td>
        <td>
          <button className="link" onClick={() => setOpen((value) => !value)}>
            {open ? 'hide' : 'details'}
          </button>
        </td>
      </tr>
      {open ? (
        <tr className="details">
          <td colSpan={showMachine ? 7 : 6}>
            <div className="muted">
              {task.dropbox_path || 'not uploaded'} &middot; created {when(task.created_at)}
            </div>
            <pre>{task.initial_infos || '(no infos captured)'}</pre>
          </td>
        </tr>
      ) : null}
    </>
  );
}

export default function TaskTable({ tasks, note, onRefresh, showMachine = false }) {
  const [filter, setFilter] = useState('');

  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return tasks;
    return tasks.filter((task) =>
      [task.UID, task.file_name, task.task_status, task.dropbox_path, task.machine_id].some((value) =>
        String(value || '').toLowerCase().includes(needle)
      )
    );
  }, [tasks, filter]);

  return (
    <section className="card">
      <div className="row space">
        <h2>Tasks</h2>
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
              rows.map((task) => <TaskRow key={task.UID} task={task} showMachine={showMachine} />)
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
    </section>
  );
}
