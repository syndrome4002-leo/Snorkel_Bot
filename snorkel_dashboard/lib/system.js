/*
 * system.js — the master switch.
 *
 * One node for this whole deployment rather than one per machine: "stop
 * everything" is what you want in a single place when something is going wrong,
 * not a checklist to work through while it carries on going wrong. It stops at
 * the workspace boundary, though — another set-up in the same Firebase project
 * has a switch of its own.
 *
 * Every server and worker watches it, so a change reaches all of them within a
 * second or two without anything being restarted.
 */

import { onValue, ref, update } from 'firebase/database';
import { rtdb } from './firebase';
import { scoped } from './workspace';

/* Per deployment: "stop everything" means this set-up, not somebody else's. */
export const systemPath = () => scoped('system');

/** Live on/off. Absent counts as on — nobody having set it is not a decision to stop. */
export function watchSystem(onUpdate) {
  return onValue(ref(rtdb(), systemPath()), (snapshot) => {
    onUpdate((snapshot.val() || {}).enabled !== false);
  });
}

export function setSystemEnabled(enabled) {
  return update(ref(rtdb(), systemPath()), {
    enabled: Boolean(enabled),
    changed_at: new Date().toISOString(),
  });
}
