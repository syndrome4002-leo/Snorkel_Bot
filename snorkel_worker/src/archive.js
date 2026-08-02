/*
 * archive.js — unpacking and repacking task zips.
 *
 * Prefers the system `unzip`/`zip` and falls back to adm-zip. That is not
 * belt-and-braces for its own sake: a task carries `tests/test.sh` and
 * `solution/solve.sh`, which have to stay executable, and `environment/repo/.git`,
 * which contains symlinks. The command-line tools preserve both; a pure-JS
 * implementation flattens permissions and follows links. Repacking with the
 * fallback would hand back a zip whose scripts no longer run.
 */

import { spawn } from 'node:child_process';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';

/** Extension of the file that must never end up inside its own replacement. */
const ZIP_EXT = '.zip';

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      // zip(1) uses 12 for "nothing to do", which is not a failure here.
      if (code === 0 || code === 12) resolve({ code, out, err });
      else reject(new Error(`${command} exited ${code}: ${(err || out).slice(0, 500)}`));
    });
  });
}

async function hasBinary(name) {
  try {
    await run(name, ['-v']);
    return true;
  } catch (err) {
    // `zip -v` and `unzip -v` both print a banner and exit 0. A missing binary
    // surfaces as ENOENT; any other failure means it is there but grumpy, which
    // is still better than the fallback.
    return err.code !== 'ENOENT' && !/ENOENT/.test(String(err.message));
  }
}

let systemTools = null;
async function toolsAvailable() {
  if (systemTools === null) {
    systemTools = { unzip: await hasBinary('unzip'), zip: await hasBinary('zip') };
    if (!systemTools.unzip || !systemTools.zip) {
      console.warn(
        `[archive] ${!systemTools.zip ? 'zip' : 'unzip'} is not installed — falling back to adm-zip, ` +
          `which does not preserve file permissions. Install it (apt install zip unzip) so ` +
          `test.sh and solve.sh stay executable.`
      );
    }
  }
  return systemTools;
}

/**
 * Unpacks `zipPath` into `destDir`, replacing whatever was there.
 *
 * The task zips hold their contents at the root (instruction.md, tests/,
 * solution/, environment/) rather than inside a folder, so the destination has
 * to be created here.
 */
export async function unzipTo(zipPath, destDir) {
  await rm(destDir, { recursive: true, force: true });
  await mkdir(destDir, { recursive: true });

  const tools = await toolsAvailable();
  if (tools.unzip) {
    await run('unzip', ['-q', '-o', zipPath, '-d', destDir]);
  } else {
    new AdmZip(zipPath).extractAllTo(destDir, true);
  }

  const entries = await readdir(destDir);
  if (!entries.length) throw new Error(`${zipPath} unpacked to nothing.`);

  // Some exports wrap everything in a single folder. Working one level too high
  // would leave Claude looking at an empty directory, so flatten that case.
  if (entries.length === 1) {
    const only = path.join(destDir, entries[0]);
    if ((await stat(only)).isDirectory()) {
      const inner = await readdir(only);
      if (inner.includes('instruction.md') || inner.includes('task.toml')) {
        for (const name of inner) {
          await rename(path.join(only, name), path.join(destDir, name));
        }
        await rm(only, { recursive: true, force: true });
        console.log(`[archive] flattened the wrapper folder "${entries[0]}"`);
      }
    }
  }

  console.log(`[archive] unpacked ${path.basename(zipPath)} -> ${destDir}`);
  return destDir;
}

/**
 * Zips sitting at the top of a task folder — copies of the download, or of an
 * earlier round. Including one would double the size of every submission and
 * grow it again each time round.
 *
 * Only the top level. A zip inside `environment/repo` is part of the repository
 * being worked on, and dropping it would quietly corrupt the task; excluding
 * `*.zip` outright would do exactly that, because zip's patterns match across
 * directory separators.
 */
async function topLevelZips(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && path.extname(e.name).toLowerCase() === ZIP_EXT)
    .map((e) => e.name);
}

/**
 * Packs the contents of `dir` into `outPath`, contents at the root so the result
 * matches the shape that came down.
 */
export async function zipFolder(dir, outPath) {
  await rm(outPath, { force: true });

  const excluded = await topLevelZips(dir);
  if (excluded.length) console.log(`[archive] leaving out ${excluded.join(', ')}`);

  const tools = await toolsAvailable();
  if (tools.zip) {
    // -r recurse, -q quiet, -y store symlinks as links, -x exclude by name.
    const args = ['-r', '-q', '-y', outPath, '.'];
    if (excluded.length) args.push('-x', ...excluded.map((name) => `./${name}`));
    await run('zip', args, { cwd: dir });
  } else {
    const zip = new AdmZip();
    await addFolder(zip, dir, '', new Set(excluded));
    zip.writeZip(outPath);
  }

  const { size } = await stat(outPath);
  console.log(`[archive] packed ${dir} -> ${path.basename(outPath)} (${size} bytes)`);
  return { path: outPath, bytes: size };
}

async function addFolder(zip, dir, prefix, excluded) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await addFolder(zip, full, prefix ? `${prefix}/${entry.name}` : entry.name, excluded);
    } else if (entry.isFile() && !(prefix === '' && excluded.has(entry.name))) {
      zip.addLocalFile(full, prefix);
    }
  }
}
