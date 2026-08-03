/*
 * system.js — the master switch.
 *
 * One node for the whole system rather than one per machine: "stop everything"
 * is what you want in a single place when something is going wrong, not a
 * checklist to work through while it carries on going wrong.
 *
 * Every server and worker watches it, so a change reaches all of them within a
 * second or two without anything being restarted.
 */

import { onValue, ref, update } from 'firebase/database';
import { rtdb } from './firebase';

export const systemPath = () => 'system';

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
