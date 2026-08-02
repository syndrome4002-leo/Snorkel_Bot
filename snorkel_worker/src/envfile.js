/*
 * envfile.js — updates snorkel_worker/.env in place.
 *
 * The Dropbox callback writes the refresh token here, so connecting once is the
 * whole setup: no copying a token out of a terminal and no editing a file by
 * hand. Existing keys are replaced where they sit — commented-out ones included,
 * so a placeholder is filled in rather than duplicated below it.
 */

import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { workerRoot } from './config.js';

export const ENV_PATH = path.join(workerRoot, '.env');

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
