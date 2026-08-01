/*
 * machines.js — which machines this browser knows about.
 *
 * The list lives in localStorage rather than in Firebase, so adding a machine
 * on your laptop does not change what anyone else sees. A machine id is printed
 * by the server on startup:
 *
 *   [server] machine id: goran-virtual-machine-70e3eec3
 */

const KEY = 'snorkel-bot-machines';
const SELECTED_KEY = 'snorkel-bot-machine';

export function listMachines() {
  if (typeof window === 'undefined') return [];
  try {
    const value = JSON.parse(window.localStorage.getItem(KEY) || '[]');
    return Array.isArray(value) ? value.filter((id) => typeof id === 'string' && id) : [];
  } catch {
    return [];
  }
}

export function addMachine(id) {
  const clean = String(id || '').trim();
  if (!clean) return listMachines();
  const next = [...new Set([...listMachines(), clean])];
  window.localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}

export function removeMachine(id) {
  const next = listMachines().filter((value) => value !== id);
  window.localStorage.setItem(KEY, JSON.stringify(next));
  if (getSelected() === id) setSelected(next[0] || '');
  return next;
}

export function getSelected() {
  if (typeof window === 'undefined') return '';
  return window.localStorage.getItem(SELECTED_KEY) || '';
}

export function setSelected(id) {
  if (typeof window === 'undefined') return;
  if (id) window.localStorage.setItem(SELECTED_KEY, id);
  else window.localStorage.removeItem(SELECTED_KEY);
}
