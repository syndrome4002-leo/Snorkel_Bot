/*
 * dropbox.js — uploads straight to Dropbox over HTTP, no browser involved.
 *
 * Auth: Dropbox retired long-lived access tokens, so the server keeps an app
 * key, app secret and refresh token, and mints a short-lived (~4h) access token
 * as needed. Run `npm run dropbox:auth` once to get the refresh token.
 *
 * Files up to 150 MB go in one request; anything larger uses an upload session.
 */

import { readFile, open } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

/** Dropbox's own cutoff for a single-shot upload. */
const SINGLE_SHOT_LIMIT = 150 * 1024 * 1024;
const CHUNK = 8 * 1024 * 1024;

let cachedToken = null; // { value, expiresAt }
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
  return new Error(
    `Dropbox is not configured: ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} not set. ` +
      `Run "npm run dropbox:auth" to get a refresh token. ` +
      `To try it out right now instead, paste a token from the App Console's ` +
      `"Generate access token" button into DROPBOX_ACCESS_TOKEN — it works for about ` +
      `four hours and cannot be renewed.`
  );
}

/**
 * A valid access token, refreshed when needed. Cached in memory: tokens last
 * about four hours, and a restart just mints a new one.
 */
async function getAccessToken() {
  if (!dropboxConfigured()) throw missingCredentialsError();

  // A token pasted from the App Console is used as-is. There is nothing to
  // refresh it with, so when it expires the upload simply starts failing —
  // which is why this is for trying things out, not for running unattended.
  if (config.dropbox.accessToken) {
    if (!warnedAboutStaticToken) {
      warnedAboutStaticToken = true;
      console.warn(
        '[dropbox] using DROPBOX_ACCESS_TOKEN directly. App Console tokens expire after ' +
          'about 4 hours and cannot be renewed — run "npm run dropbox:auth" for a refresh token.'
      );
    }
    return config.dropbox.accessToken;
  }

  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;

  const basic = Buffer.from(`${config.dropbox.appKey}:${config.dropbox.appSecret}`).toString('base64');
  const res = await fetch(`${config.dropbox.apiBase}/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: config.dropbox.refreshToken,
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Could not refresh the Dropbox access token (HTTP ${res.status}): ${text.slice(0, 300)}. ` +
        `If this says "invalid_grant", the refresh token was revoked — run "npm run dropbox:auth" again.`
    );
  }

  const body = JSON.parse(text);
  cachedToken = {
    value: body.access_token,
    expiresAt: Date.now() + (body.expires_in || 14400) * 1000,
  };
  return cachedToken.value;
}

/**
 * Dropbox-API-Arg travels in an HTTP header, which may only carry ASCII. Any
 * non-ASCII character in a filename has to go as a \uXXXX escape or Dropbox
 * rejects the request.
 */
function apiArg(value) {
  // \u007f-\uffff written as escapes so the source stays plain ASCII.
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (ch) =>
    '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0')
  );
}

/** "folder" + "name.zip" -> "/folder/name.zip", with the slashes tidied up. */
export function dropboxPath(folder, fileName) {
  const clean = (s) => String(s || '').replace(/^\/+|\/+$/g, '');
  const dir = clean(folder);
  return '/' + (dir ? `${dir}/` : '') + path.basename(fileName);
}

async function readError(res) {
  const text = await res.text().catch(() => '');
  try {
    const body = JSON.parse(text);
    return body.error_summary || text;
  } catch {
    return text;
  }
}

async function uploadSmall(filePath, target) {
  const token = await getAccessToken();
  const body = await readFile(filePath);

  const res = await fetch(`${config.dropbox.contentBase}/2/files/upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': apiArg({
        path: target,
        mode: 'add',
        // Dropbox appends " (1)" itself rather than failing on a name clash.
        autorename: true,
        mute: true,
        strict_conflict: false,
      }),
    },
    body,
  });

  if (!res.ok) throw new Error(`Dropbox upload failed (HTTP ${res.status}): ${await readError(res)}`);
  return res.json();
}

/** For files over Dropbox's single-request limit. */
async function uploadLarge(filePath, target, size) {
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
          commit: { path: target, mode: 'add', autorename: true, mute: true },
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
 * Uploads one file. Returns what Dropbox actually stored — the name may differ
 * from the one asked for, because autorename resolves clashes.
 */
export async function uploadFile(filePath, { folder = '', fileName = null, size = null } = {}) {
  const name = fileName || path.basename(filePath);
  const target = dropboxPath(folder || config.dropbox.folder, name);
  const bytes = size !== null ? size : (await readFile(filePath)).length;

  const result =
    bytes > SINGLE_SHOT_LIMIT
      ? await uploadLarge(filePath, target, bytes)
      : await uploadSmall(filePath, target);

  console.log(`[dropbox] uploaded ${result.path_display} (${result.size} bytes)`);
  return {
    uploaded: true,
    file_name: name,
    dropbox_name: result.name,
    dropbox_path: result.path_display,
    renamed: result.name !== name,
    bytes: result.size,
    id: result.id,
  };
}

/**
 * Removes a file from Dropbox.
 *
 * A missing file counts as success. The point is that it is gone, and failing on
 * "it was already gone" would turn a retry into a dead end.
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

/**
 * Opens a download without reading it into memory.
 *
 * Returns the raw response so the caller can pipe it straight on. A task zip is
 * a couple of hundred megabytes, and buffering one per request would make the
 * server's memory use a function of how many uploads happen to overlap.
 */
export async function downloadStream(remotePath) {
  const token = await getAccessToken();
  const target = remotePath.startsWith('/') ? remotePath : dropboxPath(config.dropbox.folder, remotePath);

  const res = await fetch(`${config.dropbox.contentBase}/2/files/download`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Dropbox-API-Arg': apiArg({ path: target }) },
  });

  if (!res.ok) {
    const detail = await readError(res);
    const hint = /not_found/.test(detail)
      ? ` Nothing is stored at ${target} — the worker deletes the zip when it takes it, so this is expected while a task is being built.`
      : '';
    const err = new Error(`Dropbox download failed (HTTP ${res.status}): ${detail}.${hint}`);
    err.code = res.status === 409 ? 'DROPBOX_NOT_FOUND' : 'DROPBOX_ERROR';
    throw err;
  }

  // Dropbox reports the real size in this header; content-length is not always set.
  let size = null;
  try {
    size = JSON.parse(res.headers.get('dropbox-api-result') || '{}').size ?? null;
  } catch {
    // not fatal, it is only used for a Content-Length
  }

  return { body: res.body, size, path: target };
}

// ------------------------------------------------------- OAuth handshake ----

/*
 * The one thing that cannot be automated: a refresh token is proof that a human
 * approved this app for their account, so somebody has to click "Allow" once.
 * What the server CAN do is host both ends of that click, so there is no code to
 * copy and no file to edit by hand.
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
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    const hint = /invalid_grant/.test(text)
      ? ' Authorization codes are single-use and expire quickly — start again.'
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
 * Starts using a refresh token immediately, without a restart. The cached
 * access token is dropped so the next call mints one from the new credentials.
 */
export function applyRefreshToken(refreshToken) {
  config.dropbox.refreshToken = refreshToken;
  config.dropbox.accessToken = ''; // a stored short-lived token would shadow this
  cachedToken = null;
  warnedAboutStaticToken = false;
}

/** Confirms the credentials work, without uploading anything. */
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
