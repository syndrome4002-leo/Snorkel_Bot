/*
 * check.mjs — everything the worker needs, verified before you trust it with a task.
 *
 * Run it after setting up .env:  npm run check
 *
 * Reports rather than throws, so one missing credential does not hide the other
 * three problems you would otherwise find one restart at a time.
 */

import { access, readdir } from 'node:fs/promises';
import { config } from '../src/config.js';
import { machineId } from '../src/machine.js';
import { initFirebase, firebaseStatus, findWorkableTasks, WORKABLE } from '../src/firebase.js';
import { initRtdb, rtdbStatus, readMachineIndex } from '../src/rtdb.js';
import { checkAccount, dropboxConfigured } from '../src/dropbox.js';
import { checkClaude } from '../src/claude.js';
import { documentPaths } from '../src/prompts.js';
import { lockHolder } from '../src/lock.js';

const ok = (what, detail) => console.log(`  ok    ${what}${detail ? ` — ${detail}` : ''}`);
const bad = (what, detail) => {
  console.log(`  FAIL  ${what}${detail ? ` — ${detail}` : ''}`);
  failures++;
};
const warn = (what, detail) => console.log(`  warn  ${what}${detail ? ` — ${detail}` : ''}`);

let failures = 0;

console.log(`\nsnorkel_worker check — machine ${machineId()}\n`);

// ------------------------------------------------------------- instance ----
console.log('instance');
const holder = await lockHolder();
if (holder) {
  // Not a failure — everything below is still worth checking. It just means
  // "npm start" would refuse, which is the point of the lock.
  warn('already running', `pid ${holder.pid}, started ${holder.started_at}`);
} else {
  ok('no worker running', 'this machine is free to start one');
}

// ---------------------------------------------------------------- folders --
console.log('folders');
try {
  await access(config.workDir);
  ok('work dir', config.workDir);
} catch {
  warn('work dir', `${config.workDir} does not exist yet — it will be created on start`);
}

for (const dir of config.extraTaskDirs) {
  try {
    await access(dir);
    ok('extra task dir', dir);
  } catch {
    warn('extra task dir', `${dir} does not exist`);
  }
}

// ------------------------------------------------------------------ docs --
console.log('\ndocuments');
if (!config.docsDir) {
  warn('DOCS_DIR', 'not set — Claude will get the task with no reference material');
} else {
  const docs = await documentPaths();
  if (!docs.length) bad('documents', `nothing readable in ${config.docsDir}`);
  else {
    ok('documents', `${docs.length} file(s) from ${config.docsDir}`);
    for (const doc of docs) {
      try {
        await access(doc);
        console.log(`          ${doc.replace(config.docsDir + '/', '')}`);
      } catch {
        bad('document', `${doc} is listed but missing`);
      }
    }
  }
}

// ---------------------------------------------------------------- prompts --
console.log('\nprompts');
try {
  const files = (await readdir(config.promptsDir)).filter((f) => f.endsWith('.txt')).sort();
  const required = ['intro.txt', 'build.txt', 'revision.txt'];
  const missing = required.filter((f) => !files.includes(f));
  if (missing.length) bad('templates', `missing ${missing.join(', ')} in ${config.promptsDir}`);
  else ok('templates', files.join(', '));
} catch (err) {
  bad('templates', `${config.promptsDir}: ${err.message}`);
}

// ----------------------------------------------------------------- Claude --
console.log('\nClaude');
try {
  ok('cli', await checkClaude());
  ok('permission mode', config.claude.permissionMode);
  if (config.claude.model) ok('model', config.claude.model);
} catch (err) {
  bad('cli', err.message);
}

// ---------------------------------------------------------------- Dropbox --
console.log('\nDropbox');
if (!dropboxConfigured()) {
  bad(
    'credentials',
    config.dropbox.appKey && config.dropbox.appSecret
      ? `app key and secret are set but there is no refresh token — start the worker and open ` +
          `http://${config.connect.host}:${config.connect.port}/api/dropbox/connect`
      : 'DROPBOX_APP_KEY and DROPBOX_APP_SECRET are not set — copy them from snorkel_server/.env'
  );
} else {
  try {
    const account = await checkAccount();
    ok('account', `${account.name || ''} <${account.email}>`);
    ok('folder', config.dropbox.folder || '(root of the app folder)');
  } catch (err) {
    bad('account', err.message);
  }
}

// --------------------------------------------------------------- Firebase --
console.log('\nFirebase');
await initFirebase();
const fb = firebaseStatus();
if (fb.ready) ok('firestore', `${fb.collection} in ${fb.projectId}`);
else bad('firestore', fb.reason);

await initRtdb();
const rt = rtdbStatus();
if (rt.ready) ok('realtime database', rt.url);
else if (!rt.enabled) warn('realtime database', rt.reason + ' — logs will stay on the console');
else bad('realtime database', rt.reason);

// --------------------------------------------------------------- machines --
console.log('\nworking for');
let machines = [];
if (rt.ready) {
  machines = await readMachineIndex();
  if (machines.length) {
    ok('machines', `${machines.length} added on the dashboard`);
    for (const id of machines) console.log(`          ${id}`);
  } else if (config.worker.anyMachine) {
    warn('machines', 'none added, but ANY_MACHINE=true so every task is fair game');
  } else {
    bad('machines', 'none added on the dashboard — the worker would sit idle with nothing to do');
  }
} else {
  warn('machines', 'cannot read the list without the Realtime Database');
}

if (fb.ready) {
  const tasks = await findWorkableTasks(machines, 20);
  if (tasks.length) {
    ok('work waiting', `${tasks.length} task(s)`);
    for (const task of tasks) {
      console.log(`          ${task.UID}  ${task.task_status}  (${task.machine_id})`);
    }
  } else {
    ok('work waiting', `none in ${WORKABLE.map((s) => `"${s}"`).join(' or ')}`);
  }
}

// -------------------------------------------------------------- Dropbox UI --
console.log('\nconnect page');
if (config.connect.enabled) {
  ok('address', `http://${config.connect.host}:${config.connect.port}/`);
  console.log(`          register this redirect URI in the Dropbox App Console:`);
  console.log(`          http://localhost:${config.connect.port}/api/dropbox/callback`);
} else {
  warn('disabled', 'CONNECT_ENABLED=false — there is no way to connect Dropbox from a browser');
}

console.log(
  failures
    ? `\n${failures} problem(s) — fix these before starting the worker.\n`
    : '\nAll good. Start it with: npm start\n'
);
process.exit(failures ? 1 : 0);
