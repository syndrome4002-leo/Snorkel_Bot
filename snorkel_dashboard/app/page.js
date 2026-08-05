'use client';

import { useCallback, useEffect, useState } from 'react';
import { firebaseConfigured, missingConfigKeys } from '@/lib/firebase';
import { watchServerStatus } from '@/lib/commands';
import { findInBuild, watchTasks } from '@/lib/tasks';
import {
  addMachine,
  getSelected,
  migrateLocalMachines,
  removeMachine,
  setSelected,
  watchMachines,
} from '@/lib/machines';
import { MachineAdd, MachineList } from '@/components/MachinePicker';
import StatusPills from '@/components/StatusPills';
import StartTask from '@/components/StartTask';
import SettingsDrawer from '@/components/SettingsDrawer';
import SystemLogs from '@/components/SystemLogs';
import ClaudeUsage from '@/components/ClaudeUsage';
import SystemSwitch from '@/components/SystemSwitch';
import ThemeToggle from '../components/ThemeToggle';
import TaskTable from '@/components/TaskTable';

/** Shown only when .env.local has not been filled in — a setup problem, not a login. */
function NotConfigured() {
  return (
    <div className="gate">
      <div className="card">
        <h1>🤿 Bot</h1>
        <p className="muted">This dashboard is not connected to Firebase yet.</p>
        <p className="error">Missing: {missingConfigKeys().join(', ')}</p>
        <p className="muted">
          Copy <code>.env.local.example</code> to <code>.env.local</code>, fill in the values from
          Firebase console → Project settings → Your apps, then rebuild.
        </p>
      </div>
    </div>
  );
}

export default function Page() {
  const [ready, setReady] = useState(false);
  const [machines, setMachines] = useState([]);
  const [selected, setSelectedState] = useState('');
  const [statuses, setStatuses] = useState({}); // machine id -> status
  const [tasks, setTasks] = useState([]);
  const [tasksNote, setTasksNote] = useState('Loading…');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [machineNote, setMachineNote] = useState('');

  // localStorage and Firebase are both browser-only.
  useEffect(() => {
    setSelectedState(getSelected());
    setReady(true);
  }, []);

  // The list is shared now: the worker reads it to decide whose tasks to pick
  // up, so it has to come from the database rather than this browser.
  useEffect(() => {
    if (!ready || !firebaseConfigured) return undefined;
    migrateLocalMachines().catch((err) => setMachineNote(`Could not migrate the old list: ${err.message}`));
    return watchMachines(setMachines);
  }, [ready]);

  // One status subscription per known machine, so the picker can show which
  // ones are up without you having to select each in turn.
  useEffect(() => {
    if (!ready || !firebaseConfigured || machines.length === 0) return undefined;
    const stops = machines.map((id) =>
      watchServerStatus(id, (value) => setStatuses((current) => ({ ...current, [id]: value })))
    );
    return () => stops.forEach((stop) => stop());
  }, [ready, machines]);

  useEffect(() => {
    if (!ready || !firebaseConfigured) return undefined;
    setTasksNote('Loading…');

    return watchTasks(
      selected,
      (list) => {
        setTasks(list);
        setTasksNote(
          `${list.length} task${list.length === 1 ? '' : 's'}${selected ? ' on this machine' : ' across all machines'}`
        );
      },
      (err) => {
        setTasksNote(
          err.code === 'permission-denied'
            ? 'Firestore rules are blocking this read — deploy firestore.rules.'
            : `Could not read tasks: ${err.message}`
        );
      }
    );
  }, [ready, selected]);

  const select = useCallback((id) => {
    setSelected(id);
    setSelectedState(id);
  }, []);

  const add = useCallback(
    async (id) => {
      setMachineNote('');
      try {
        // watchMachines updates the list; no need to set it here.
        select(await addMachine(id));
      } catch (err) {
        setMachineNote(err.message);
      }
    },
    [select]
  );

  const remove = useCallback(
    async (id) => {
      setMachineNote('');
      try {
        await removeMachine(id);
        if (getSelected() === id) select('');
      } catch (err) {
        setMachineNote(err.message);
      }
    },
    [select]
  );

  if (!ready) return null;
  if (!firebaseConfigured) return <NotConfigured />;

  const status = selected ? statuses[selected] : null;
  // `tasks` is already scoped to the selected machine, so this is that
  // machine's unfinished task rather than anyone else's.
  const inBuildTask = selected ? findInBuild(tasks) : null;

  return (
    <>
      {/*
        Everything you DO is in the top bar; everything that is merely true is in
        the bottom one. Starting a task, opening settings and adding a machine
        are actions, so they live up here beside the master switch.
      */}
      <header>
        <h1>🤿 Bot</h1>
        {selected ? <StatusPills status={status} /> : <span className="muted">All machines</span>}

        <span className="header-actions">
          {selected ? (
            <StartTask
              machine={selected}
              serverOnline={Boolean(status?.online)}
              inBuildTask={inBuildTask}
              taskInFlight={Boolean(status?.task_in_flight)}
              onOpenSettings={() => setSettingsOpen(true)}
            />
          ) : (
            <span className="muted header-hint">
              {machines.length ? 'Pick a machine below to start a task' : 'Add a machine to start tasks'}
            </span>
          )}
          <MachineAdd onAdd={add} note={machineNote} />
        </span>

        <SystemSwitch />
        <ThemeToggle />
      </header>

      {/* Logs on the left, tasks on the right: the logs are a narrow running
          column, the table needs the width. */}
      <div className={selected ? 'workspace' : ''}>
        {selected ? <SystemLogs machine={selected} /> : null}
        <TaskTable tasks={tasks} note={tasksNote} showMachine={!selected} />
      </div>

      {settingsOpen && selected ? (
        <SettingsDrawer machine={selected} onClose={() => setSettingsOpen(false)} />
      ) : null}

      {/*
        The bottom bar: what is true rather than what you can do. Fixed, so where
        it sits in the tree does not affect the layout — but last is where it
        belongs in reading and tab order. `body` carries matching bottom padding
        so the last card is never underneath it.
      */}
      <footer className="usage-bar">
        <ClaudeUsage />
        <div className="bar-machines">
          <span className="usage-title">Machines</span>
          <MachineList
            machines={machines}
            selected={selected}
            statuses={statuses}
            onSelect={select}
            onRemove={remove}
          />
        </div>
      </footer>
    </>
  );
}
