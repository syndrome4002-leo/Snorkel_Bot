import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const bool = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
};

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Comma-separated list of paths -> absolute paths, empties dropped.
 *
 * Comma only, not the PATH-style colon: a Windows path starts `C:\`, and
 * splitting on the colon would turn one folder into two nonexistent ones.
 */
const pathList = (value) =>
  String(value || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => path.resolve(p.replace(/^~(?=$|\/)/, os.homedir())));

/**
 * The snorkel_worker/ directory. Everything path-shaped resolves against this
 * rather than process.cwd(), so the worker behaves the same started from here,
 * from the repo root, or by a systemd unit with no working directory.
 */
export const workerRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const resolveFromWorkerRoot = (p) => (p ? (path.isAbsolute(p) ? p : path.resolve(workerRoot, p)) : '');

export const config = {
  /**
   * Where zips are downloaded to and task folders live. The same folder the
   * browser downloads into, so a task the extension just fetched and a task the
   * worker fetches back from Dropbox end up in the same place.
   */
  workDir: process.env.WORK_DIR
    ? path.resolve(process.env.WORK_DIR.replace(/^~(?=$|\/)/, os.homedir()))
    : path.join(os.homedir(), 'Downloads'),

  /**
   * Also searched — read-only — when looking for an existing task folder.
   * A "needs revision" task is never downloaded, so its folder has to be found
   * where it already is; this covers folders unpacked before the worker existed.
   */
  extraTaskDirs: pathList(process.env.EXTRA_TASK_DIRS),

  /** Reference material handed to Claude in the first turn of every session. */
  docsDir: process.env.DOCS_DIR
    ? path.resolve(process.env.DOCS_DIR.replace(/^~(?=$|\/)/, os.homedir()))
    : '',

  /**
   * Which of those files to attach, in order. Empty = every readable file in
   * docsDir, sorted by name.
   */
  docFiles: String(process.env.DOC_FILES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  /** Prompt templates. Editable text files, so wording changes need no code change. */
  promptsDir: resolveFromWorkerRoot(process.env.PROMPTS_DIR || 'prompts'),

  worker: {
    /** How many tasks Claude may work on at once. The dashboard can override this. */
    maxConcurrent: num(process.env.MAX_CONCURRENT, 3),

    /** How often Firestore is polled for work, in seconds. */
    pollSeconds: num(process.env.POLL_SECONDS, 30),

    /** Give up on a single task after this long, so one stuck run cannot hold a slot forever. */
    taskTimeoutMinutes: num(process.env.TASK_TIMEOUT_MINUTES, 90),

    /**
     * How many times to answer a failed platform check before leaving the task
     * alone.
     *
     * The loop is meant to run until both checks pass, but "until it passes" and
     * "forever" are the same thing when the fix is not working — and every round
     * is a full Claude session plus two platform builds. After this many the task
     * stays at "static check fail" for a person to look at.
     */
    maxStaticFixAttempts: num(process.env.MAX_STATIC_FIX_ATTEMPTS, 5),

    /**
     * Whether to pick up tasks a reviewer sent back.
     *
     * Off while the first-build path is the one being watched. Turning it on is
     * the only change needed — nothing about revisions has been removed.
     */
    handleRevisions: bool(process.env.HANDLE_REVISIONS, false),

    /**
     * Take work belonging to any machine rather than only this one. Off by
     * default: the machine that built a task is the one whose download folder
     * holds its files.
     */
    anyMachine: bool(process.env.ANY_MACHINE, false),

    /**
     * Overrides the dashboard's list entirely — this worker works these machines
     * and no others, whatever `/machines_index` says.
     *
     * The list is shared, so a worker started to try something out will happily
     * pick up production work the moment somebody adds a real machine to it.
     * This is how you run one without that being possible. Also useful for
     * splitting machines between two workers deliberately.
     */
    onlyMachines: String(process.env.ONLY_MACHINES || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },

  /**
   * The little web page that hosts the Dropbox handshake and shows what the
   * worker can see. Not an API — the worker takes no commands over HTTP.
   */
  connect: {
    enabled: bool(process.env.CONNECT_ENABLED, true),
    port: num(process.env.CONNECT_PORT, 8788),

    /**
     * Loopback by default. The dashboard is on this machine, so you are already
     * in front of it, and a page that rewrites credentials has no business
     * listening on the network. Set 0.0.0.0 only if you must reach it remotely.
     */
    host: process.env.CONNECT_HOST || '127.0.0.1',
  },

  claude: {
    /** The Claude Code executable. On PATH by default. */
    bin: process.env.CLAUDE_BIN || 'claude',

    /** Empty = whatever the CLI is configured to use. */
    model: process.env.CLAUDE_MODEL || '',

    /**
     * Unattended runs cannot answer a permission prompt, and a task needs to run
     * its own tests — so anything short of bypassPermissions eventually hangs
     * waiting for a keypress nobody is there to give. Narrow it if you would
     * rather a run fail than have the agent execute commands unsupervised.
     */
    permissionMode: process.env.CLAUDE_PERMISSION_MODE || 'bypassPermissions',

    /**
     * Where Claude Code caches what the API said about rate limits. Empty means
     * the usual place under the Claude config directory.
     */
    usageCache: process.env.CLAUDE_USAGE_CACHE || '',

    /** Extra CLI arguments, split on spaces. Escape hatch for anything not modelled here. */
    extraArgs: String(process.env.CLAUDE_ARGS || '').split(/\s+/).filter(Boolean),
  },

  dropbox: {
    appKey: process.env.DROPBOX_APP_KEY || '',
    appSecret: process.env.DROPBOX_APP_SECRET || '',
    refreshToken: process.env.DROPBOX_REFRESH_TOKEN || '',
    accessToken: process.env.DROPBOX_ACCESS_TOKEN || '',
    folder: process.env.DROPBOX_FOLDER || '',
    apiBase: process.env.DROPBOX_API_BASE || 'https://api.dropboxapi.com',
    contentBase: process.env.DROPBOX_CONTENT_BASE || 'https://content.dropboxapi.com',
  },

  firebase: {
    enabled: bool(process.env.FIREBASE_ENABLED, true),
    credentialsJson: process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '',
    credentialsPath: resolveFromWorkerRoot(
      process.env.FIREBASE_SERVICE_ACCOUNT ||
        process.env.GOOGLE_APPLICATION_CREDENTIALS ||
        'serviceAccount.json'
    ),
    credentialsPathIsDefault: !(
      process.env.FIREBASE_SERVICE_ACCOUNT || process.env.GOOGLE_APPLICATION_CREDENTIALS
    ),
    projectId: process.env.FIREBASE_PROJECT_ID || '',
    collection: process.env.FIREBASE_COLLECTION || 'Tasks',
    /** Shared with snorkel_server: what the platform's checks keep rejecting. */
    lessonsCollection: process.env.FIREBASE_LESSONS_COLLECTION || 'CheckLessons',
    databaseUrl: process.env.FIREBASE_DATABASE_URL || '',
  },
};
