import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const bool = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
};

/**
 * The snorkel_server/ directory, wherever this checkout happens to live.
 * Everything path-shaped is resolved against this rather than process.cwd(), so
 * the server behaves the same whether it is started from snorkel_server/, from
 * the repo root, or by a systemd unit with no working directory at all.
 */
export const serverRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/** Absolute paths pass through; relative ones are anchored to snorkel_server/. */
const resolveFromServerRoot = (p) => (p ? (path.isAbsolute(p) ? p : path.resolve(serverRoot, p)) : '');

export const config = {
  port: Number(process.env.PORT || 8787),

  /*
   * Which deployment this server belongs to.
   *
   * One Firebase project can carry several independent set-ups. They share a
   * database, but not a master switch — otherwise turning one off stops the
   * other. Must match NEXT_PUBLIC_WORKSPACE in its dashboard and WORKSPACE in
   * its worker; "default" is what an existing deployment already is.
   */
  workspace: (process.env.WORKSPACE || 'default').trim() || 'default',

  /** Shared secret the extension must present as ?token= on the WS URL. Empty = no auth. */
  botToken: process.env.BOT_TOKEN || '',

  /** Set when the server sits behind a tunnel/reverse proxy, so client IPs are real. */
  trustProxy: bool(process.env.TRUST_PROXY, false),

  /** How long POST /api/start waits for the extension to finish the whole flow. */
  commandTimeoutMs: Number(process.env.COMMAND_TIMEOUT_MS || 240000),

  /**
   * How long to wait for a zip to be uploaded and both platform checks to run.
   * Much longer than a normal command: the upload is a couple of hundred
   * megabytes and each check queues a real build on their side.
   */
  submitTimeoutMs: Number(process.env.SUBMIT_TIMEOUT_MS || 1_500_000),

  /**
   * Where Chrome saves downloads. The server reads the task zip from here to
   * upload it, and deletes it once Dropbox has it, so the server must run on the
   * same machine as the browser.
   */
  downloadsDir: process.env.DOWNLOADS_DIR
    ? path.resolve(process.env.DOWNLOADS_DIR)
    : path.join(os.homedir(), 'Downloads'),

  /**
   * The built dashboard (Next.js `output: 'export'` writes it here). Serving it
   * from this server means the page and the API share an origin, so there is no
   * CORS to configure and only one process to run.
   *
   * Missing until `npm run build` has been run in snorkel_dashboard/; during
   * development you would use `npm run dev` there instead, on port 3000.
   */
  dashboardDir: resolveFromServerRoot(process.env.DASHBOARD_DIR || '../snorkel_dashboard/out'),

  dropbox: {
    appKey: process.env.DROPBOX_APP_KEY || '',
    appSecret: process.env.DROPBOX_APP_SECRET || '',
    refreshToken: process.env.DROPBOX_REFRESH_TOKEN || '',

    /**
     * A token pasted straight from the App Console's "Generate access token"
     * button. Handy to prove the upload works without doing the OAuth dance,
     * but it dies after about four hours and cannot be renewed — the refresh
     * token is what makes this run unattended.
     */
    accessToken: process.env.DROPBOX_ACCESS_TOKEN || '',

    /** Destination folder; '' means the root of the app folder / Dropbox. */
    folder: process.env.DROPBOX_FOLDER || '',

    // Overridable so the upload path can be pointed at a stub in tests.
    apiBase: process.env.DROPBOX_API_BASE || 'https://api.dropboxapi.com',
    contentBase: process.env.DROPBOX_CONTENT_BASE || 'https://content.dropboxapi.com',
  },

  firebase: {
    /** Set FIREBASE_ENABLED=false to run the server without credentials (logs instead of writing). */
    enabled: bool(process.env.FIREBASE_ENABLED, true),

    /**
     * Credentials, in order of preference:
     *   1. FIREBASE_SERVICE_ACCOUNT_JSON — the key itself, as raw JSON or base64.
     *      Use this on hosts where you cannot ship a file (containers, PaaS, CI).
     *   2. FIREBASE_SERVICE_ACCOUNT / GOOGLE_APPLICATION_CREDENTIALS — a path,
     *      relative to snorkel_server/ unless absolute. Defaults to serviceAccount.json.
     *   3. Application Default Credentials (gcloud login, GCE/Cloud Run metadata).
     */
    credentialsJson: process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '',
    credentialsPath: resolveFromServerRoot(
      process.env.FIREBASE_SERVICE_ACCOUNT ||
        process.env.GOOGLE_APPLICATION_CREDENTIALS ||
        'serviceAccount.json'
    ),
    /** True when the path is just the default rather than something you asked for. */
    credentialsPathIsDefault: !(
      process.env.FIREBASE_SERVICE_ACCOUNT || process.env.GOOGLE_APPLICATION_CREDENTIALS
    ),

    projectId: process.env.FIREBASE_PROJECT_ID || '',
    collection: process.env.FIREBASE_COLLECTION || 'Tasks',

    /**
     * What the platform's checks keep rejecting, and what fixed it. One document
     * per distinct failure, shared by every machine — the point is that a task
     * benefits from failures it never had itself.
     */

    /**
     * Realtime Database URL — the channel the dashboard talks to this server
     * through. Separate product from Firestore and created separately; the
     * console shows the URL once the database exists. Empty turns the channel
     * off and the server is then only reachable over HTTP.
     */
    databaseUrl: process.env.FIREBASE_DATABASE_URL || '',
  },
};
