/*
 * machine.js — a stable identity for this computer.
 *
 * The dashboard can talk to several machines, so every command and every task
 * has to say which one it belongs to. The id must therefore survive restarts,
 * reinstalls of this project, and moving the folder around — it identifies the
 * hardware, not the process.
 *
 * Derived from things that do not change day to day:
 *
 *   /etc/machine-id      Linux's own persistent host id, when present
 *   hostname             what you actually call the box
 *   primary MAC address  survives OS reinstalls
 *   platform + arch      cheap extra entropy
 *
 * The hostname is kept readable at the front so an id is recognisable at a
 * glance: "goran-ubuntu-3f9a1c22". Set MACHINE_ID to override it entirely.
 */

import os from 'node:os';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** Linux keeps a persistent host id here; other platforms simply do not have it. */
function hostIdFile() {
  for (const file of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try {
      const value = readFileSync(file, 'utf8').trim();
      if (value) return value;
    } catch {
      // not this one
    }
  }
  return '';
}

/** MAC of the first real network interface, sorted so the choice is stable. */
function primaryMac() {
  const macs = Object.entries(os.networkInterfaces())
    .flatMap(([name, nics]) => (nics || []).map((nic) => ({ name, ...nic })))
    .filter((nic) => !nic.internal && nic.mac && nic.mac !== '00:00:00:00:00:00')
    // Docker and VM bridges come and go; prefer anything else.
    .filter((nic) => !/^(docker|br-|veth|virbr|vmnet)/.test(nic.name))
    .map((nic) => nic.mac)
    .sort();
  return macs[0] || '';
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
}

let cached = null;

export function machineId() {
  if (cached) return cached;

  if (process.env.MACHINE_ID) {
    cached = process.env.MACHINE_ID.trim();
    return cached;
  }

  const parts = [hostIdFile(), os.hostname(), primaryMac(), os.platform(), os.arch()];
  const digest = createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 8);
  const name = slug(os.hostname()) || 'machine';

  cached = `${name}-${digest}`;
  return cached;
}

/** Shown on the dashboard so a machine is recognisable beyond its id. */
export function machineInfo() {
  return {
    id: machineId(),
    hostname: os.hostname(),
    platform: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    // Handy when you are wondering why a machine cannot find a download.
    user: os.userInfo().username,
  };
}
