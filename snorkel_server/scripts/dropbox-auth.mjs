/*
 * dropbox-auth.mjs — run once to get a Dropbox refresh token.
 *
 *   npm run dropbox:auth
 *
 * Dropbox no longer issues long-lived access tokens. The server holds an app
 * key, an app secret and a refresh token, and mints a ~4h access token when it
 * needs one. Only this script needs a browser, and only this once.
 *
 * It uses the "no redirect URI" flow: Dropbox shows you a code on screen and
 * you paste it back here, so nothing has to listen on a callback URL.
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { config } from '../src/config.js';
import { updateEnvFile } from '../src/envfile.js';

const rl = createInterface({ input: stdin, output: stdout });

let closed = false;
rl.on('close', () => {
  closed = true;
});

/**
 * Prompts, unless the value was supplied up front.
 *
 * Values may come from the environment so the whole thing can be scripted:
 * DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_AUTH_CODE. That also matters
 * because node:readline/promises never settles a second question() once stdin
 * has ended — piping answers in would hang forever, so prompting is only safe
 * on a real terminal.
 */
async function ask(question, preset) {
  if (preset) {
    console.log(`${question}${preset.length > 12 ? preset.slice(0, 6) + '…' : preset}  (from environment)`);
    return preset.trim();
  }
  if (closed || !stdin.isTTY) {
    // A stack trace helps nobody here, and hanging would be worse: readline
    // never settles a second question() once stdin has ended.
    console.error(
      `\nCannot prompt for "${question.trim()}" — stdin is not a terminal.\n\n` +
        `Run this in a terminal, or supply the answers as environment variables:\n` +
        `  DROPBOX_APP_KEY=... DROPBOX_APP_SECRET=... DROPBOX_AUTH_CODE=... \\\n` +
        `  DROPBOX_WRITE_ENV=y npm run dropbox:auth\n`
    );
    rl.close();
    process.exit(1);
  }
  const answer = await rl.question(question);
  return answer.trim();
}

console.log(`
Dropbox setup
=============

1. Open  https://www.dropbox.com/developers/apps  and click "Create app".
     - Choose an API:     Scoped access
     - Type of access:    App folder  (safer — confined to its own folder)
                          or Full Dropbox (if you want to upload anywhere)
     - Name:              anything, e.g. snorkel-bot

2. On the app's "Permissions" tab, tick:
     files.content.write     (upload files)
     files.content.read      (lets this script verify the token)
     account_info.read       (used to confirm which account you connected)
   Click "Submit". Do this BEFORE generating the token, or the token will not
   carry the scopes.

3. Back on the "Settings" tab, copy the App key and App secret.
`);

const appKey = await ask('App key:    ', process.env.DROPBOX_APP_KEY);
const appSecret = await ask('App secret: ', process.env.DROPBOX_APP_SECRET);
if (!appKey || !appSecret) {
  console.error('\nBoth values are required.');
  rl.close();
  process.exit(1);
}

// token_access_type=offline is what makes Dropbox return a refresh token.
const authUrl =
  'https://www.dropbox.com/oauth2/authorize' +
  `?client_id=${encodeURIComponent(appKey)}` +
  '&response_type=code' +
  '&token_access_type=offline';

console.log(`
4. Open this URL, click "Allow", and copy the code it shows you:

${authUrl}
`);

const code = await ask('Authorization code: ', process.env.DROPBOX_AUTH_CODE);
if (!code) {
  console.error('\nNo code entered.');
  rl.close();
  process.exit(1);
}

const basic = Buffer.from(`${appKey}:${appSecret}`).toString('base64');
const res = await fetch(`${config.dropbox.apiBase}/oauth2/token`, {
  method: 'POST',
  headers: {
    Authorization: `Basic ${basic}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  },
  body: new URLSearchParams({ code, grant_type: 'authorization_code' }),
});

const text = await res.text();
if (!res.ok) {
  console.error(`\nDropbox rejected the exchange (HTTP ${res.status}):\n${text}`);
  if (/invalid_grant/.test(text)) {
    console.error('\nAuthorization codes are single-use and expire quickly — start again from step 4.');
  }
  rl.close();
  process.exit(1);
}

const token = JSON.parse(text);
if (!token.refresh_token) {
  console.error('\nNo refresh_token came back. The authorize URL must include token_access_type=offline.');
  rl.close();
  process.exit(1);
}

// Confirm the credentials actually work before telling anyone they do.
const who = await fetch(`${config.dropbox.apiBase}/2/users/get_current_account`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token.access_token}` },
});
const account = who.ok ? await who.json() : null;

console.log(`
Done.${account ? `  Connected as ${account.name.display_name} <${account.email}>` : ''}

Add these to snorkel_server/.env:

DROPBOX_APP_KEY=${appKey}
DROPBOX_APP_SECRET=${appSecret}
DROPBOX_REFRESH_TOKEN=${token.refresh_token}
`);

const write = (
  await ask('Write them into .env for you? [y/N] ', process.env.DROPBOX_WRITE_ENV)
).toLowerCase();
if (write === 'y' || write === 'yes') {
  const { path: written } = await updateEnvFile({
    DROPBOX_APP_KEY: appKey,
    DROPBOX_APP_SECRET: appSecret,
    DROPBOX_REFRESH_TOKEN: token.refresh_token,
  });
  console.log(`\nWritten to ${written}. Restart the server.`);
} else {
  console.log('\nNothing written — copy the lines above into .env yourself.');
}

rl.close();
