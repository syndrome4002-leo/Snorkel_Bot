# Snorkel Bot

Three pieces that work together:

| Folder | What it is |
| --- | --- |
| [snorkel_extension/](snorkel_extension/) | Chrome MV3 extension that drives `experts.snorkel-ai.com` |
| [snorkel_server/](snorkel_server/) | Node server that commands it, uploads to Dropbox, and writes to Firebase |
| [snorkel_dashboard/](snorkel_dashboard/) | Next.js dashboard — see tasks, start new ones, from any machine |

The extension never touches Firebase or Dropbox, and the server never touches the
browser. They talk over a WebSocket. The dashboard is a static Next.js export
that the server hosts, so it shares an origin with the API.

---

## Flow

```
  YOU / cron / another service
        │  POST /start_new_task
        ▼
  ┌─────────────────┐  ws /extension?role=snorkel   ┌──────────────────────┐
  │                 │ ──── start_sentinel ───────▶  │  snorkel extension   │
  │                 │ ◀─── result {task, meta} ───  └──────────┬───────────┘
  │                 │                                          │ 1. open /home
  │                 │  saveTask()                              │ 2. click "Start"
  │   node server   │ ──▶ Tasks/<UID>                          │ 3. scrape + download
  │                 │      file_uploaded: false                ▼
  │                 │      task_status: "in build"     experts.snorkel-ai.com
  │                 │                                          │
  │                 │           reads the zip from     ~/Downloads/<file>.zip
  │                 │ ◀─────────────────────────────────────────┘
  │                 │
  │                 │  HTTPS POST /2/files/upload
  │                 │ ─────────────────────────────────────▶  dropbox.com
  └────────┬────────┘
           │ delete the local file
           ▼ markUploaded()
  Tasks/<UID>  file_uploaded: true  (task_status stays "in build")
```

**Step 1 — Snorkel** (`POST /api/start`)

1. The hub sends `{type:"start_sentinel", requestId}` and holds the HTTP
   response open until the extension answers.
2. The service worker opens (or reuses) a tab on
   `https://experts.snorkel-ai.com/home` and asks the content script to find the
   Sentinel project card and **click its `Start` button**.
3. The site routes to `/projects/<id>/submission-<id>/review`. The content script
   waits for the page to render, scrapes the submission UID and the left-hand
   info panel, then clicks the task's **Download file** button. A
   `chrome.downloads.onCreated` listener armed *before* the click captures the
   real filename Chrome saved. The tab stays open for you to work in.
4. The server writes `Tasks/<UID>` with `file_uploaded: false` and
   `task_status: "in build"`.

**Step 2 — Dropbox** (`POST /api/upload`)

5. The server finds the zip in `~/Downloads` and `POST`s it to
   `https://content.dropboxapi.com/2/files/upload`, using an access token minted
   from the stored refresh token. Files over 150 MB go via an upload session.
   No browser is involved.
6. The server **deletes the local file** and sets `file_uploaded: true`.
   `task_status` stays `"in build"`.

`POST /api/run` does both steps back to back.

---

## What gets stored

Firestore collection **`Tasks`**, document id = the submission UID (so re-running
the same task updates the record instead of duplicating it):

| Field | Source |
| --- | --- |
| `UID` | the `UID:` badge in the review page top bar |
| `machine_id` | which computer ran it, e.g. `goran-virtual-machine-70e3eec3` |
| `file_name` | the filename Chrome actually saved, falling back to the name shown on the page |
| `initial_infos` | `innerText` of the whole left panel, as plain text |
| `file_uploaded` | `false` on download, `true` once Dropbox has the file |
| `task_status` | `"in build"` from the moment the task is started; the upload does not change it |
| `source_url` | the review page URL (extra context) |
| `local_path` | where the zip sits until it is uploaded, then `null` |
| `dropbox_path` | where it landed in Dropbox |
| `created_at` / `updated_at` / `uploaded_at` | ISO timestamps written by the server |

`file_uploaded` and `task_status` are written up front rather than only after the
upload, so the fields always exist and can be queried.

Nothing in the server ever moves `task_status` off `"in build"` — see the note
under **One task at a time** below.

Example `initial_infos`:

```
Original Directory Name
20260720_033755__platformplatform_platformplatform__860
Category
evolution_and_maintenance
Difficulty
hard
Task Tags
postgresql
entity-framework
database-migration
Languages
C#
TypeScript
Metadata
schema_version = "1.3"
[metadata]
...
```

---

## Setup

### 1. Server

```bash
cd snorkel_server
npm install
npm start
```

`snorkel_server/.env` and `snorkel_server/serviceAccount.json` are already in
place for Firebase project **`snorkel-fe3eb`**. Both are git-ignored, and the key
file is `chmod 600`.

### Credentials on another machine

Nothing machine-specific is stored in `.env`. Credentials are resolved in this
order, so the same checkout works anywhere:

1. **`FIREBASE_SERVICE_ACCOUNT_JSON`** — the key itself as one line, raw JSON or
   base64. Use this where you cannot ship a file (Docker, Cloud Run, Heroku, CI):
   ```bash
   FIREBASE_SERVICE_ACCOUNT_JSON=$(base64 -w0 serviceAccount.json)
   ```
2. **`FIREBASE_SERVICE_ACCOUNT`** — a path to the key file. **Relative paths
   resolve from the `snorkel_server/` folder, not the working directory**, and
   it defaults to `serviceAccount.json`. So copying `snorkel_server/` anywhere
   and dropping the key next to `package.json` just works — no path to edit, and
   it does not matter whether you start the server from `snorkel_server/`, from
   the repo root, or from a systemd unit with no working directory.
3. **Application Default Credentials** — `gcloud auth application-default login`,
   or the metadata server on GCE / Cloud Run, where no key file exists at all.

The startup log prints which one it used. A path you set explicitly that turns
out to be missing is reported as an error rather than silently falling through.

**To deploy:** copy `snorkel_server/`, run `npm install`, and either put
`serviceAccount.json` beside `package.json` or set
`FIREBASE_SERVICE_ACCOUNT_JSON`. Then point the extension's popup at that host's
WebSocket URL (`ws://<host>:8787/extension`) and set a `BOT_TOKEN` on both sides,
since the socket will no longer be on localhost.

Firestore is created and the service account has the **Cloud Datastore User**
role, so `GET /api/status` should report `"firebase": {"ready": true}`. If it
ever says `ready: false`, the `reason` field names the exact problem — a missing
key file is reported by path, and a missing IAM role names the role to grant.

Set `FIREBASE_ENABLED=false` to skip Firestore deliberately (dry run).

### 2. Dropbox

The server uploads over HTTPS — no browser, no extension, no DOM to break; real
status codes, and it works headless under cron.

Set it up once. Create the app at
<https://www.dropbox.com/developers/apps> (*Scoped access*, **App folder**), tick
`files.content.write`, `files.content.read` and `account_info.read` on the
**Permissions** tab and **Submit** — scopes are baked into the token at approval
time, so do this first. Put the App key and secret in `.env`, then add this to
**Settings → Redirect URIs**:

```
http://localhost:8787/api/dropbox/callback
```

Start the server and open:

```
http://localhost:8787/api/dropbox/connect
```

Approve once, and the server exchanges the code, writes
`DROPBOX_REFRESH_TOKEN` into `.env`, and starts using it — **no restart, nothing
to copy and paste**.

`npm run dropbox:auth` does the same thing from a terminal if you would rather
not register a redirect URI; it shows a code you paste back.

**Why a refresh token and not just a token from the App Console?** The console's
"Generate access token" button hands out a *short-lived* token — Dropbox retired
long-lived ones in 2021, and it stops working after about four hours with no way
to renew it. A refresh token does not expire, and the server trades it for a
fresh access token whenever it needs one. There is no button for a refresh token
anywhere in the console; the authorize-code exchange with
`token_access_type=offline` is the only way to get one.

**Can the server mint one by itself?** No — and no client can. A refresh token
represents *a person having approved this app for their account*, so the one
click on Dropbox's consent screen is irreducible; an app that could skip it could
read anybody's files. Everything either side of that click is automated: the
server builds the authorize URL, receives the code, exchanges it, stores the
token and starts using it. After that first click nothing is manual again — the
4-hour access tokens are minted and cached automatically, for as long as the
refresh token lives.

To try the upload out immediately, you can paste a console token into
`DROPBOX_ACCESS_TOKEN` and skip the OAuth flow — the server will use it as-is and
warn you on every start. Fine for a smoke test, useless for an unattended bot.

Confirm it works without uploading anything:

```bash
curl -s localhost:8787/api/dropbox/check
# {"ok":true,"mode":"api","account":{"email":"you@example.com",...}}
```

Files up to 150 MB go in one request; larger ones use an upload session
automatically. Name clashes are resolved by Dropbox's own `autorename`, and the
stored name comes back in `dropbox_name` / `dropbox_path`.

### 3. Dashboard

```bash
cd snorkel_dashboard
npm install
npm run build      # writes out/, which the server then hosts
```

Restart the server and open **http://localhost:8787** — or, from another PC on
the same network, the LAN address the server prints at startup:

```
[server] dashboard:  http://localhost:8787
[server]             http://192.168.1.20:8787   <- from another PC
```

It shows the health of the three things a run depends on (extension, Firebase,
Dropbox), a **Start new task** button that follows the job through to the end,
and the task table with every stored field — click *details* for the full
`initial_infos`.

> **Set `BOT_TOKEN` in `.env` before exposing this.** Without it, anyone who can
> reach the port can start tasks and read every stored task. With it, the API
> requires the token and the dashboard asks for it once, then keeps it in the
> browser's localStorage. The server warns loudly at startup when it is unset.

For dashboard development, `npm run dev` serves on :3000 and proxies `/api` and
`/start_new_task` to :8787, so you get hot reload without a CORS setup.

### 4. The extension

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → [snorkel_extension/](snorkel_extension/)
3. Click the icon. The dot should turn green (`connected`). If you set
   `BOT_TOKEN` in `.env`, put the same value in the popup's Token field and hit
   **Save & reconnect**.
4. Sign in to `https://experts.snorkel-ai.com` in that same Chrome profile. The
   extension reuses your session and never handles your password; if it lands on
   a login page it aborts with a clear error instead of guessing.

```json
{ "extension": { "snorkel": {"connected": true} } }
```

### 5. Run it

**One call does everything** — Snorkel start → scrape → download → save →
Dropbox upload → delete the local file → flip the flags:

```bash
curl -X POST http://localhost:8787/start_new_task
```

```json
{ "ok": true,
  "job": { "id": "c2b84522-…", "status": "running", "step": "snorkel" },
  "poll": "/api/jobs/c2b84522-…" }
```

That returns in milliseconds and the workflow carries on by itself. Check on it
whenever you like:

```bash
curl -s localhost:8787/api/jobs/<id> | python3 -m json.tool
```

```json
{ "status": "succeeded", "step": "done",
  "uid": "9e399c85-…", "file_name": "…_submission.zip",
  "file_uploaded": true, "task_status": "in build" }
```

`step` moves `queued → snorkel → dropbox → done`; `status` ends `succeeded` or
`failed` with an `error`. `GET /api/jobs` lists the last 50.

`GET` works too, so a browser or a bare cron line can trigger it:
`curl http://localhost:8787/start_new_task`. `/api/start_new_task` is the same
endpoint if you prefer everything under `/api`.

Pass `{"async": false}` to hold the connection until the whole thing finishes and
get the full result back — simpler to script, but the request can stay open for
minutes, so only use it interactively. (`POST /api/run` is the same pipeline with
the opposite default: blocking unless you pass `{"async": true}`.)

The individual steps stay available if you want to drive them yourself:

```bash
curl -X POST http://localhost:8787/api/start    # Snorkel step only
curl -X POST http://localhost:8787/api/upload   # Dropbox step only
```

---

## Server API

All `/api/*` routes and `/start_new_task` require the `X-Bot-Token` header when
`BOT_TOKEN` is set (`?token=` also works, for `EventSource`). The only exception
is `/api/dropbox/callback`, which Dropbox redirects a browser to and cannot be
made to carry a header — it is protected by its own one-time `state` value.

| Endpoint | Purpose |
| --- | --- |
| `GET`/`POST` `/start_new_task` | **The whole workflow.** Returns a job id at once. Also at `/api/start_new_task` |
| `POST /api/run` | Same pipeline, blocking unless you pass `{"async":true}` |
| `GET /api/jobs` | The last 50 runs |
| `GET /api/jobs/:id` | One run: status, step, and the full result |
| `POST /api/start` | Snorkel step only. Optional body: `{"projectKey":"…","mode":"new\|resume\|any"}` |
| `POST /api/upload` | Dropbox step only. Optional body: `{"uid":"…","folder":"…","force":true}` |
| `GET /api/status` | Extension connected? Firebase ready? Dropbox configured? Queue depth? |
| `GET /api/dropbox/connect` | Approve the app in Dropbox; stores the refresh token and starts using it |
| `GET /api/dropbox/callback` | Where Dropbox sends you back — register this as the app's Redirect URI |
| `GET /api/dropbox/check` | Confirm the Dropbox credentials without uploading |
| `GET /api/tasks` | 50 most recent `Tasks` documents |
| `GET /api/tasks/:uid` | One document |
| `POST /api/flush` | Replay queued tasks into Firestore (see below) |
| `GET /api/events` | Server-sent events stream of live progress |

`mode` picks which card to click: `new` (default) takes a fresh task,
`resume` continues one you already claimed, `any` prefers new and falls back.

**One task at a time.** Starting a task while another is `"in build"` on that
machine is refused with **409** — by the server, so it holds however the task was
started (dashboard, curl, or a Realtime Database command). A run that is under
way but has not written its task document yet is covered too, by an in-memory
lock.

> Nothing currently moves a task off `"in build"`. Uploading to Dropbox no longer
> does it, and there is no "mark done" action yet, so after one task that machine
> stays blocked. Until there is one, clear it with `{"force": true}` on the next
> start, or edit `task_status` on the row in the Firebase console.

`POST /api/upload` with no `uid` picks the most recently updated task that has
not been uploaded yet. An already-uploaded task is skipped unless you pass
`{"force": true}`.

---

## Seeing your rows

Three ways, once Firestore exists:

```bash
curl -s localhost:8787/api/tasks | python3 -m json.tool          # recent rows
curl -s localhost:8787/api/tasks/<submission-uid> | python3 -m json.tool
```

or the console data viewer:
<https://console.firebase.google.com/project/snorkel-fe3eb/firestore/data/~2FTasks>

`GET /api/status` tells you whether writes are landing at all:

```json
{ "firebase": { "ready": true, "collection": "Tasks" }, "pending_tasks": 0 }
```

`ready: false` means nothing is being written — read the `reason` field.

## Nothing is lost when Firestore is down

A task that scrapes fine but cannot be written is appended in full to
`snorkel_server/pending-tasks.jsonl` (git-ignored), and `POST /api/start`
answers with `saved: false` plus a `warning`. **`ok: true` means the browser
half worked — check `saved` to know whether it reached the database.**

Queued tasks are replayed automatically the next time the server starts with a
working Firestore connection, or on demand:

```bash
curl -X POST localhost:8787/api/flush     # -> {"flushed":1,"remaining":0}
```

The file is deleted once everything lands; anything that still fails stays
queued. `pending_tasks` in `/api/status` is the current queue depth.

---

## The selectors it depends on

Derived from your saved `snorkel_homepage.html` and
`snorkel_sentinel_project_UI.html`, and verified against both files with a real
DOM parser.

**Home page** — [snorkel_extension/content/homepage.js](snorkel_extension/content/homepage.js)

| Thing | Selector |
| --- | --- |
| Project cards | `[data-testid="project-card"]` |
| Sentinel Start link | `a[data-testid$="-CDG_Sentinel_Ultra_00000"]` |
| New vs. resume | resume cards are prefixed with an assignment UUID (`029c1c0c-…-CDG_Sentinel_Ultra_00000`); the new one is `Submission-CDG_Sentinel_Ultra_00000` |
| Start button | the `<button>` inside that anchor |

**Review page** — [snorkel_extension/content/sentinel.js](snorkel_extension/content/sentinel.js)

| Thing | Selector |
| --- | --- |
| Submission UID | the leaf element whose text is exactly `UID:`, then the UUID in its parent |
| Left-side infos | `[data-testid="document-review-left-panel"]` → `innerText` |
| Download field | `[data-testid^="field-s3fileuploader-download_sentinel"]` |
| File name | `.text-color-success` inside that field |
| Download button | `button[aria-label="Download file"]` inside that field |

⚠️ The page has a **second** file widget, `[data-testid="field-output_file"]`,
holding your *uploaded* result (e.g. `…_corrected.zip`). Every download selector
is scoped inside the download field so that one is never picked up by mistake.

Each selector has a fallback (text scan, body regex, URL parsing), so a cosmetic
class change won't break the run — but if Snorkel restructures these panels,
these files are the only places to update. Dropbox needs no selectors at all now
that uploads go through its API.

---

## Notes on how it's built

- **One content script set for the whole origin.** The site is a single-page app,
  so navigating from `/home` to the review page does *not* re-inject content
  scripts. All three files match `https://experts.snorkel-ai.com/*` and share one
  isolated world; `common.js` owns the message router.
- **Download name comes from Chrome, not the DOM.** The listener is armed
  *before* the click so the event can't be missed. If no download is observed
  within 45s, it falls back to the name shown on the page and flags
  `download_confirmed: false` in `meta`.
- **Clicks are native, not synthetic.** `SnorkelBot.click()` calls the element's
  own `.click()`. An earlier version fired a five-event pointer/mouse sequence,
  which can make an app run its handler twice (a `mouseup` handler *and* a
  `click` handler both acting) and pushes components down a different path than
  a real press. `{sequence: true}` still fires the full sequence where needed.
- **The "Leave site?" prompt is suppressed around the download click.**
  [content/unload-guard.js](snorkel_extension/content/unload-guard.js) runs in
  the page's MAIN world at `document_start` — early enough that its
  `beforeunload` listener is registered before the app's, so
  `stopImmediatePropagation()` suppresses them. It is off by default and armed
  only for the click, then restored, so the form's unsaved-changes guard keeps
  working the rest of the time. Needs Chrome 111+ for `world: "MAIN"`.
  It deliberately never writes `event.returnValue`: on `BeforeUnloadEvent` that
  is a string where `''` means "no dialog", but on the legacy `Event` interface
  it is a boolean where *any falsy assignment cancels the event* — i.e. asks for
  the very dialog we are trying to prevent.
- **The MV3 worker gets evicted when idle.** A 30-second alarm wakes it to
  re-establish the socket, and reconnects use capped exponential backoff, so the
  extension recovers on its own if you restart the server.
- **One task at a time.** A second `start_sentinel` while one is running is
  rejected rather than queued. Same for `upload_to_dropbox`.
- **The upload bypasses the OS file dialog.** Dropbox's Upload button opens a
  native dialog no extension can drive — but the dialog only exists to fill in a
  hidden `<input type="file">`, so the extension fills that in directly with a
  `DataTransfer` and fires `change`.
- **The bytes travel server → worker → page.** A Chrome extension cannot read
  `~/Downloads`; there is no filesystem API for arbitrary paths. So the server
  serves the file over HTTP, the *service worker* fetches it (it holds the host
  permission and sidesteps the page's CORS and private-network rules, which a
  content script does not), and hands it to the page as base64. This is why the
  server must run on the same machine as the browser.
- **Uploads are confirmed, not assumed.** After injecting, the service worker
  polls the file grid until the new `data-filename` row appears. If a file of
  the same name already existed, it accepts Dropbox's renamed version
  (`… (1).zip`) and reports `renamed: true`.
- **No message channel is held open across the upload.** Every message the
  Dropbox page handles answers promptly; the worker polls with short calls it
  can retry. An earlier version kept one channel open for the whole upload and
  died with *"the message channel closed before a response was received"* —
  Dropbox is an SPA and `dropbox.com/home` redirects, and a navigation destroys
  the content script mid-await. `CHECK_UPLOAD` is stateless (the worker holds
  the before-snapshot and passes it in), so a freshly re-injected content script
  answers just as well as the one that did the injecting.
- **The local file is deleted only after the extension confirms.** A failed
  delete does not undo the upload — it comes back as a `warning` alongside
  `ok: true`.
- **Jobs live in memory.** Restarting the server loses the job *list*, never the
  *work*: every durable effect is already in Firestore or on disk by then. A job
  that was mid-flight when the server died leaves the task at
  `task_status: "in build"`, and `POST /api/upload` picks it up again.

## Not included

The Snorkel extension stops after the download. It does not fill in the review
form, upload a result, or click Submit — that stays manual. The Dropbox
extension only uploads; it does not organise, rename, or share.
