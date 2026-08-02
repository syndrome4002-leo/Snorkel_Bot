/*
 * connect.js — a small web page for the one step that needs a human.
 *
 * The worker takes no commands over HTTP; it watches Firestore. This exists for
 * one reason: a Dropbox refresh token is proof that a person approved this app,
 * so somebody has to click "Allow" once. Hosting both ends of that click means
 * there is no code to copy out of a terminal and no file to edit by hand — the
 * token is written into .env and used immediately, with no restart.
 *
 *   http://localhost:8788/                        what the worker can and cannot reach
 *   http://localhost:8788/api/dropbox/connect     start the handshake
 *   http://localhost:8788/api/dropbox/callback    where Dropbox comes back to
 *
 * Bound to 127.0.0.1 by default. The dashboard runs on this machine, so you are
 * already sitting in front of it, and a page that rewrites credentials has no
 * business listening on the network.
 *
 * Node's own http module rather than Express: three routes do not justify a
 * dependency the worker would otherwise never need.
 */

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { machineId } from './machine.js';
import {
  applyRefreshToken,
  buildAuthUrl,
  checkAccount,
  dropboxConfigured,
  exchangeCode,
} from './dropbox.js';
import { updateEnvFile, ENV_PATH } from './envfile.js';

/** Guards against a stray callback being used to plant somebody else's token. */
const pendingStates = new Set();

const escape = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

function page(res, title, body, status = 200) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(
    `<!doctype html><meta charset="utf-8"><title>${escape(title)}</title>` +
      `<body style="font:15px/1.6 system-ui,sans-serif;max-width:44em;margin:3em auto;padding:0 1.5em;color:#111">` +
      `<h2 style="margin-bottom:.2em">${escape(title)}</h2>${body}</body>`
  );
}

function text(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(message);
}

/**
 * The URL Dropbox will be told to come back to.
 *
 * Built from the Host header rather than from config so that reaching the page
 * on 127.0.0.1 and on localhost both work — Dropbox compares the redirect URI
 * character for character against what is registered, and the two spellings are
 * different strings.
 */
function callbackUrl(req) {
  const host = req.headers.host || `127.0.0.1:${config.connect.port}`;
  return `http://${host}/api/dropbox/callback`;
}

async function home(req, res, getState) {
  const state = await getState();
  const connected = dropboxConfigured();

  let account = null;
  if (connected) account = await checkAccount().catch(() => null);

  page(
    res,
    'Snorkel worker',
    `<p style="color:#666;margin-top:0">machine <code>${escape(machineId())}</code></p>

     <h3>Dropbox</h3>
     ${
       account
         ? `<p>✅ Connected as <strong>${escape(account.name || '')}</strong> &lt;${escape(account.email)}&gt;.</p>
            <p style="color:#666">Reconnect only if you revoked the app or changed accounts.</p>`
         : connected
           ? `<p>⚠️ Credentials are set but Dropbox would not confirm them. They may have been revoked.</p>`
           : `<p>❌ Not connected. The worker cannot download or upload task files.</p>`
     }
     <p><a href="/api/dropbox/connect" style="display:inline-block;background:#0061ff;color:#fff;padding:.6em 1.1em;border-radius:6px;text-decoration:none">${
       account ? 'Reconnect Dropbox' : 'Connect Dropbox'
     }</a></p>
     <p style="color:#666">Register this exact redirect URI on the app's <em>Settings</em> page in the
        Dropbox App Console first, or Dropbox will refuse:<br>
        <code>${escape(callbackUrl(req))}</code></p>

     <h3>Working for</h3>
     ${
       state.machines.length
         ? `<ul>${state.machines.map((id) => `<li><code>${escape(id)}</code></li>`).join('')}</ul>`
         : `<p>❌ No machines. Add machine ids on the dashboard — until then there is nothing to pick up.</p>`
     }

     <h3>Right now</h3>
     <p>${state.running} of ${state.max} slot(s) busy.</p>`
  );
}

async function connect(req, res) {
  if (!config.dropbox.appKey || !config.dropbox.appSecret) {
    return text(
      res,
      400,
      'Set DROPBOX_APP_KEY and DROPBOX_APP_SECRET in snorkel_worker/.env first, then reload this page.'
    );
  }
  const state = randomUUID();
  pendingStates.add(state);
  // Nothing to gain from remembering these forever.
  setTimeout(() => pendingStates.delete(state), 10 * 60 * 1000).unref?.();

  res.writeHead(302, { Location: buildAuthUrl(callbackUrl(req), state) });
  res.end();
}

async function callback(req, res, url) {
  const error = url.searchParams.get('error');
  if (error) {
    return page(
      res,
      'Dropbox connection cancelled',
      `<p><code>${escape(url.searchParams.get('error_description') || error)}</code></p>` +
        `<p><a href="/api/dropbox/connect">Try again</a></p>`
    );
  }

  const state = url.searchParams.get('state');
  if (!state || !pendingStates.delete(state)) {
    return text(res, 400, 'Unknown or expired state — start again at /api/dropbox/connect.');
  }

  try {
    const token = await exchangeCode(url.searchParams.get('code'), callbackUrl(req));
    applyRefreshToken(token.refresh_token);
    await updateEnvFile({
      DROPBOX_APP_KEY: config.dropbox.appKey,
      DROPBOX_APP_SECRET: config.dropbox.appSecret,
      DROPBOX_REFRESH_TOKEN: token.refresh_token,
    });

    const account = await checkAccount().catch(() => null);
    console.log(`[dropbox] connected${account ? ` as ${account.email}` : ''}; refresh token saved to ${ENV_PATH}`);

    page(
      res,
      'Dropbox connected',
      `<p>${
        account
          ? `Connected as <strong>${escape(account.name || '')}</strong> &lt;${escape(account.email)}&gt;.`
          : 'Refresh token stored.'
      }</p>` +
        `<p>Saved to <code>${escape(ENV_PATH)}</code>. No restart needed — the worker is already using it.</p>` +
        `<p>You can close this tab.</p>`
    );
  } catch (err) {
    console.error('[dropbox] connect failed:', err.message);
    page(
      res,
      'Dropbox connection failed',
      `<p><code>${escape(err.message)}</code></p><p><a href="/api/dropbox/connect">Try again</a></p>`
    );
  }
}

/**
 * Starts the page. `getState` supplies what the worker is doing, so the status
 * shown is the live one rather than a snapshot from startup.
 */
export function startConnectServer(getState) {
  if (!config.connect.enabled) {
    console.log('[connect] disabled (CONNECT_ENABLED=false)');
    return null;
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (url.pathname === '/') return await home(req, res, getState);
      if (url.pathname === '/api/dropbox/connect') return await connect(req, res);
      if (url.pathname === '/api/dropbox/callback') return await callback(req, res, url);
      return text(res, 404, 'Not found. Try / for status.');
    } catch (err) {
      console.error('[connect]', err);
      text(res, 500, String(err.message || err));
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `[connect] port ${config.connect.port} is already in use — the Dropbox connect page is not available. ` +
          `Set CONNECT_PORT to something else.`
      );
    } else {
      console.error('[connect] could not start:', err.message);
    }
  });

  server.listen(config.connect.port, config.connect.host, () => {
    console.log(`[connect] http://${config.connect.host}:${config.connect.port}/  (Dropbox setup and status)`);
  });

  // Never hold the process open on its own account.
  server.unref?.();
  return server;
}
