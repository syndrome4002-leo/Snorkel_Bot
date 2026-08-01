/*
 * localfile.js — everything the server does with the zip Chrome downloaded.
 *
 * This is the piece that requires the server and the browser to share a
 * machine: the Dropbox extension cannot read ~/Downloads itself (extensions
 * have no filesystem API for arbitrary paths), so the server reads the file and
 * serves it over HTTP for the extension to fetch.
 */

import path from 'node:path';
import { stat, rm } from 'node:fs/promises';
import { config } from './config.js';

/**
 * Resolves a task to a file on disk.
 *
 * `local_path` recorded at download time is tried first; the downloads folder
 * plus `file_name` is the fallback for records that predate it. Both are
 * required to stay inside downloadsDir, so a bad or hostile record cannot make
 * the server read or delete something elsewhere on the disk.
 */
export async function locateTaskFile(task) {
  const candidates = [];
  if (task.local_path) candidates.push(path.resolve(task.local_path));
  if (task.file_name) candidates.push(path.resolve(config.downloadsDir, path.basename(task.file_name)));

  const root = path.resolve(config.downloadsDir);
  const problems = [];

  // Windows paths are case-insensitive, and Chrome does not always report the
  // same casing as os.homedir() ("C:\Users\Goran\Downloads" vs
  // "C:\Users\goran\Downloads"). Comparing raw strings there would reject the
  // server's own downloads folder as "outside" itself.
  const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const foldedRoot = fold(root);

  for (const candidate of candidates) {
    const folded = fold(candidate);
    if (folded !== foldedRoot && !folded.startsWith(foldedRoot + path.sep)) {
      problems.push(`${candidate} is outside the downloads folder (${root})`);
      continue;
    }
    try {
      const info = await stat(candidate);
      if (info.isFile()) return { path: candidate, size: info.size };
      problems.push(`${candidate} is not a file`);
    } catch (err) {
      problems.push(err.code === 'ENOENT' ? `${candidate} does not exist` : `${candidate}: ${err.message}`);
    }
  }

  const error = new Error(
    `Could not find the downloaded file for task ${task.UID}. Tried: ${problems.join('; ') || 'nothing to try'}.`
  );
  error.code = 'FILE_NOT_FOUND';
  throw error;
}

/** Deletes the downloaded file. Never throws — a failed cleanup must not undo a good upload. */
export async function deleteTaskFile(filePath) {
  try {
    await rm(filePath, { force: true });
    console.log(`[file] deleted ${filePath}`);
    return { deleted: true, path: filePath };
  } catch (err) {
    console.error(`[file] could not delete ${filePath}: ${err.message}`);
    return { deleted: false, path: filePath, error: err.message };
  }
}
