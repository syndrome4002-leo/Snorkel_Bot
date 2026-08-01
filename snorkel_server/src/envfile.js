/*
 * envfile.js — updates snorkel_server/.env in place.
 *
 * Shared by the CLI auth script and the server's own OAuth callback, so a token
 * obtained either way is stored the same way: existing keys are replaced where
 * they sit (commented-out ones included), new keys are appended.
 */

import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { serverRoot } from './config.js';

export const ENV_PATH = path.join(serverRoot, '.env');

export async function updateEnvFile(settings, envPath = ENV_PATH) {
  let current = '';
  try {
    current = await readFile(envPath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  let next = current;
  const appended = [];

  for (const [key, value] of Object.entries(settings)) {
    const line = `${key}=${value}`;
    // Matches "KEY=..." and "# KEY=..." so a commented placeholder is filled in
    // rather than duplicated below it.
    const re = new RegExp(`^#?\\s*${key}=.*$`, 'm');
    if (re.test(next)) next = next.replace(re, line);
    else appended.push(line);
  }

  if (appended.length) {
    next = next.replace(/\s*$/, '\n') + '\n' + appended.join('\n') + '\n';
  }

  await writeFile(envPath, next, 'utf8');
  return { path: envPath, updated: Object.keys(settings), appended: appended.length };
}
