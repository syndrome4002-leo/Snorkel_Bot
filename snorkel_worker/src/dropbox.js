/*
 * dropbox.js — download, delete, upload, over HTTPS.
 *
 * Dropbox is being used as a handover point, not as storage: snorkel_server puts
 * a task zip there, the worker takes it back out and removes it, and puts the
 * finished one back. Deleting on download is what keeps the two halves honest —
 * a file present in Dropbox always means "nobody is working on this".
 *
 * Auth is the same as snorkel_server's: app key + secret + refresh token, minting
 * a ~4h access token as needed. The two processes hold their own tokens; there
 * is nothing to share between them.
 */

import { readFile, open, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

const SINGLE_SHOT_LIMIT = 150 * 1024 * 1024;
const CHUNK = 8 * 1024 * 1024;

let cachedToken = null;
let warnedAboutStaticToken = false;

export function dropboxConfigured() {
  const { appKey, appSecret, refreshToken, accessToken } = config.dropbox;
  return !!accessToken || !!(appKey && appSecret && refreshToken);
}

function missingCredentialsError() {
  const missing = [
    !config.dropbox.appKey && 'DROPBOX_APP_KEY',
    !config.dropbox.appSecret && 'DROPBOX_APP_SECRET',
    !config.dropbox.refreshToken && 'DROPBOX_REFRESH_TOKEN',
  ].filter(Boolean);
  const hasApp = config.dropbox.appKey && config.dropbox.appSecret;
  return new Error(
    `Dropbox is not configured: ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} not set. ` +
      (hasApp
        ? `Open http://${config.connect.host}:${config.connect.port}/api/dropbox/connect and approve once — ` +
          `the token is written to .env and used straight away.`
        : `Copy DROPBOX_APP_KEY and DROPBOX_APP_SECRET from snorkel_server/.env — the worker uses the same ` +
          `app — then open http://${config.connect.host}:${config.connect.port}/ to connect.`)
  );
}

async function getAccessToken() {
  if (!dropboxConfigured()) throw missingCredentialsError();

  if (config.dropbox.accessToken) {
    if (!warnedAboutStaticToken) {
      warnedAboutStaticToken = true;
      console.warn(
        '[dropbox] using DROPBOX_ACCESS_TOKEN directly. App Console tokens expire after about ' +
          '4 hours and cannot be renewed — an unattended worker needs the refresh token.'
      );
    }
    return config.dropbox.accessToken;
  }

  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;

  const basic = Buffer.from(`${config.dropbox.appKey}:${config.dropbox.appSecret}`).toString('base64');
  const res = await fetch(`${config.dropbox.apiBase}/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: config.dropbox.refreshToken,
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Could not refresh the Dropbox access token (HTTP ${res.status}): ${text.slice(0, 300)}. ` +
        `If this says "invalid_grant", the refresh token was revoked — run ` +
        `"npm run dropbox:auth" in snorkel_server and copy the new one across.`
    );
  }

  const body = JSON.parse(text);
  cachedToken = { value: body.access_token, expiresAt: Date.now() + (body.expires_in || 14400) * 1000 };
  return cachedToken.value;
}

/**
 * Dropbox-API-Arg travels in an HTTP header, which may only carry ASCII, so any
 * non-ASCII character in a filename has to go as a \uXXXX escape.
 */
function apiArg(value) {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (ch) =>
    '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0')
  );
}

export function dropboxPath(folder, fileName) {
  const clean = (s) => String(s || '').replace(/^\/+|\/+$/g, '');
  const dir = clean(folder);
  return '/' + (dir ? `${dir}/` : '') + path.basename(fileName);
}

async function readError(res) {
  const text = await res.text().catch(() => '');
  try {
    return JSON.parse(text).error_summary || text;
  } catch {
    return text;
  }
}

/**
 * Pulls one file down to `destPath`.
 *
 * `remotePath` is what the task record stored at upload time; a bare filename is
 * resolved against DROPBOX_FOLDER for the case where that field was never set.
 */
export async function downloadFile(remotePath, destPath) {
  const token = await getAccessToken();
  const target = remotePath.startsWith('/') ? remotePath : dropboxPath(config.dropbox.folder, remotePath);

  const res = await fetch(`${config.dropbox.contentBase}/2/files/download`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Dropbox-API-Arg': apiArg({ path: target }) },
  });

  if (!res.ok) {
    const detail = await readError(res);
    const hint = /not_found/.test(detail)
      ? ` Nothing is stored at ${target} — it may already have been taken by an earlier run.`
      : '';
    throw new Error(`Dropbox download failed (HTTP ${res.status}): ${detail}.${hint}`);
  }

  const bytes = Buffer.from(await res.arrayBuffer());
  await writeFile(destPath, bytes);
  console.log(`[dropbox] downloaded ${target} -> ${destPath} (${bytes.length} bytes)`);
  return { path: target, localPath: destPath, bytes: bytes.length };
}

/**
 * Removes a file. A missing file is treated as success: the point is that it is
 * gone, and failing on "it was already gone" would strand tasks whose download
 * succeeded but whose delete was interrupted.
 */
export async function deleteFile(remotePath) {
  const token = await getAccessToken();
  const target = remotePath.startsWith('/') ? remotePath : dropboxPath(config.dropbox.folder, remotePath);

  const res = await fetch(`${config.dropbox.apiBase}/2/files/delete_v2`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: target }),
  });

  if (res.ok) {
    console.log(`[dropbox] deleted ${target}`);
    return { deleted: true, path: target };
  }

  const detail = await readError(res);
  if (/not_found/.test(detail)) {
    console.log(`[dropbox] ${target} was already gone`);
    return { deleted: false, path: target, reason: 'not found' };
  }
  throw new Error(`Dropbox delete failed (HTTP ${res.status}): ${detail}`);
}

async function uploadSmall(filePath, target, mode) {
  const token = await getAccessToken();
  const body = await readFile(filePath);

  const res = await fetch(`${config.dropbox.contentBase}/2/files/upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': apiArg({ path: target, mode, autorename: mode === 'add', mute: true }),
    },
    body,
  });

  if (!res.ok) throw new Error(`Dropbox upload failed (HTTP ${res.status}): ${await readError(res)}`);
  return res.json();
}

async function uploadLarge(filePath, target, size, mode) {
  const token = await getAccessToken();
  const handle = await open(filePath, 'r');

  try {
    const first = Buffer.alloc(Math.min(CHUNK, size));
    await handle.read(first, 0, first.length, 0);

    let res = await fetch(`${config.dropbox.contentBase}/2/files/upload_session/start`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': apiArg({ close: false }),
      },
      body: first,
    });
    if (!res.ok) {
      throw new Error(`Dropbox upload_session/start failed (HTTP ${res.status}): ${await readError(res)}`);
    }
    const { session_id } = await res.json();

    let offset = first.length;
    while (offset < size) {
      const chunk = Buffer.alloc(Math.min(CHUNK, size - offset));
      await handle.read(chunk, 0, chunk.length, offset);
      res = await fetch(`${config.dropbox.contentBase}/2/files/upload_session/append_v2`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/octet-stream',
          'Dropbox-API-Arg': apiArg({ cursor: { session_id, offset }, close: false }),
        },
        body: chunk,
      });
      if (!res.ok) {
        throw new Error(`Dropbox upload_session/append failed (HTTP ${res.status}): ${await readError(res)}`);
      }
      offset += chunk.length;
    }

    res = await fetch(`${config.dropbox.contentBase}/2/files/upload_session/finish`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': apiArg({
          cursor: { session_id, offset },
          commit: { path: target, mode, autorename: mode === 'add', mute: true },
        }),
      },
      body: Buffer.alloc(0),
    });
    if (!res.ok) {
      throw new Error(`Dropbox upload_session/finish failed (HTTP ${res.status}): ${await readError(res)}`);
    }
    return res.json();
  } finally {
    await handle.close();
  }
}

/**
 * Puts the finished zip back.
 *
 * Defaults to overwrite rather than autorename: this file is a replacement for
 * the one the worker took away, and letting Dropbox park it as "name (1).zip"
 * would leave you guessing which copy is the current one.
 */
export async function uploadFile(filePath, { folder = null, fileName = null, mode = 'overwrite' } = {}) {
  const name = fileName || path.basename(filePath);
  const target = dropboxPath(folder === null ? config.dropbox.folder : folder, name);
  const bytes = (await readFile(filePath)).length;

  const result =
    bytes > SINGLE_SHOT_LIMIT
      ? await uploadLarge(filePath, target, bytes, mode)
      : await uploadSmall(filePath, target, mode);

  console.log(`[dropbox] uploaded ${result.path_display} (${result.size} bytes)`);
  return {
    uploaded: true,
    file_name: name,
    dropbox_name: result.name,
    dropbox_path: result.path_display,
    bytes: result.size,
    id: result.id,
  };
}

// ------------------------------------------------------- OAuth handshake ----

/*
 * The one thing that cannot be automated: a refresh token is proof that a human
 * approved this app for their account, so somebody has to click "Allow" once.
 * What the worker CAN do is host both ends of that click, so there is no code to
 * copy and no file to edit by hand.
 *
 * The worker hosts its own flow rather than borrowing the server's because the
 * two now run on different machines — and a refresh token is not transferable
 * paperwork, it is just a credential each process needs its own copy of.
 */

export function buildAuthUrl(redirectUri, state) {
  const params = new URLSearchParams({
    client_id: config.dropbox.appKey,
    response_type: 'code',
    // Without this Dropbox returns only a 4-hour access token, no refresh token.
    token_access_type: 'offline',
    redirect_uri: redirectUri,
    state,
  });
  return `https://www.dropbox.com/oauth2/authorize?${params}`;
}

/** Trades the one-time code for a refresh token. */
export async function exchangeCode(code, redirectUri) {
  if (!config.dropbox.appKey || !config.dropbox.appSecret) {
    throw new Error('DROPBOX_APP_KEY and DROPBOX_APP_SECRET must be set before connecting.');
  }

  const basic = Buffer.from(`${config.dropbox.appKey}:${config.dropbox.appSecret}`).toString('base64');
  const res = await fetch(`${config.dropbox.apiBase}/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, grant_type: 'authorization_code', redirect_uri: redirectUri }),
  });

  const text = await res.text();
  if (!res.ok) {
    const hint = /invalid_grant/.test(text)
      ? ' Authorization codes are single-use and expire quickly — start again.'
      : /redirect_uri/.test(text)
        ? ' The redirect URI must be listed on the app\'s Settings page in the Dropbox App Console, character for character.'
        : '';
    throw new Error(`Dropbox rejected the exchange (HTTP ${res.status}): ${text.slice(0, 300)}.${hint}`);
  }

  const body = JSON.parse(text);
  if (!body.refresh_token) {
    throw new Error('No refresh_token came back — the authorize URL needs token_access_type=offline.');
  }
  return body;
}

/**
 * Starts using a refresh token immediately, without a restart. The cached access
 * token is dropped so the next call mints one from the new credentials.
 */
export function applyRefreshToken(refreshToken) {
  config.dropbox.refreshToken = refreshToken;
  config.dropbox.accessToken = ''; // a stored short-lived token would shadow this
  cachedToken = null;
  warnedAboutStaticToken = false;
}

/** Confirms the credentials work, without moving any data. */
export async function checkAccount() {
  const token = await getAccessToken();
  const res = await fetch(`${config.dropbox.apiBase}/2/users/get_current_account`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Dropbox rejected the token (HTTP ${res.status}): ${await readError(res)}`);
  const account = await res.json();
  return { email: account.email, name: account.name && account.name.display_name };
}
