# Snorkel Bot

Three pieces that work together:

| Folder | What it is |
| --- | --- |
| [snorkel_extension/](snorkel_extension/) | Chrome MV3 extension that drives `experts.snorkel-ai.com` |
| [dropbox_extension/](dropbox_extension/) | Chrome MV3 extension that drives `dropbox.com` |
| [snorkel_server/](snorkel_server/) | Node server that commands both extensions and writes to Firebase |

Neither extension touches Firebase, and the server never touches the browser.
Both extensions connect to the same WebSocket and identify themselves by role.

---

## Flow

```
  YOU / cron / another service
        │  POST /api/run
        ▼
  ┌─────────────────┐  ws /extension?role=snorkel   ┌──────────────────────┐
  │                 │ ──── start_sentinel ───────▶  │  snorkel extension   │
  │                 │ ◀─── result {task, meta} ───  └──────────┬───────────┘
  │                 │                                          │ 1. open /home
  │                 │  saveTask()                              │ 2. click "Start"
  │   node server   │ ──▶ Tasks/<UID>                          │ 3. scrape + download
  │                 │      file_uploaded: false                ▼
  │                 │      task_status: "downloaded"   experts.snorkel-ai.com
  │                 │                                          │
  │                 │  ws /extension?role=dropbox     ~/Downloads/<file>.zip
  │                 │ ──── upload_to_dropbox ────▶  ┌──────────┴───────────┐
  │                 │ ◀─── GET /tasks/:uid/file ──  │  dropbox extension   │
  │                 │ ◀─── result {uploaded} ─────  └──────────┬───────────┘
  └────────┬────────┘                                          │ 4. inject into
           │ delete the local file                             │    the hidden
           ▼ markUploaded()                                    │    file input
  Tasks/<UID>  file_uploaded: true, task_status: "new"          ▼
                                                          dropbox.com
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
   `task_status: "downloaded"`.

**Step 2 — Dropbox** (`POST /api/upload`)

5. The server finds the zip in `~/Downloads`, then sends
   `{type:"upload_to_dropbox", task, fileUrl}` to the Dropbox extension.
6. That extension's **service worker** fetches the bytes from
   `GET /api/tasks/:uid/file` — the worker, not the content script, because it
   holds the host permission and is not subject to the page's CORS or
   private-network rules — and base64-encodes them.
7. It opens `dropbox.com`, and the content script turns the bytes back into a
   `File`, puts it into Dropbox's **hidden upload input** via `DataTransfer`, and
   fires `change`. Dropbox's own uploader takes over. Completion is detected by
   watching the file grid for the new `data-filename` row.
8. The server **deletes the local file** and sets `file_uploaded: true` and
   `task_status: "new"`.

`POST /api/run` does both steps back to back.

---

## What gets stored

Firestore collection **`Tasks`**, document id = the submission UID (so re-running
the same task updates the record instead of duplicating it):

| Field | Source |
| --- | --- |
| `UID` | the `UID:` badge in the review page top bar |
| `file_name` | the filename Chrome actually saved, falling back to the name shown on the page |
| `initial_infos` | `innerText` of the whole left panel, as plain text |
| `file_uploaded` | `false` on download, `true` once Dropbox has the file |
| `task_status` | `"downloaded"` on download, `"new"` once uploaded |
| `source_url` | the review page URL (extra context) |
| `local_path` | where the zip sits until it is uploaded, then `null` |
| `dropbox_path` | where it landed in Dropbox |
| `created_at` / `updated_at` / `uploaded_at` | ISO timestamps written by the server |

`file_uploaded` and `task_status` are written up front rather than only after the
upload, so the fields always exist and can be queried.

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

> **One manual step is still outstanding.** The service account authenticates
> fine, but the project has no Firestore database yet, so writes fail with
> `5 NOT_FOUND`. Open
> <https://console.firebase.google.com/project/snorkel-fe3eb/firestore>, click
> **Create database**, pick a region (permanent) and a rules mode, then restart
> the server. `GET /api/status` will flip `firebase.ready` to `true`.
>
> Until then the server still runs the full browser flow and logs each record to
> the console; `POST /api/start` responds with `saved: false` and a `warning`.

Set `FIREBASE_ENABLED=false` to skip Firestore deliberately (dry run).

### 2. Both extensions

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → [snorkel_extension/](snorkel_extension/)
3. **Load unpacked** again → [dropbox_extension/](dropbox_extension/)
4. Click each icon. Both dots should turn green (`connected`). If you set
   `BOT_TOKEN` in `.env`, put the same value in each popup's Token field and hit
   **Save & reconnect**.
5. Sign in to `https://experts.snorkel-ai.com` **and** `https://www.dropbox.com`
   in that same Chrome profile. The extensions reuse your sessions and never
   handle your passwords; if either lands on a login page it aborts with a clear
   error instead of guessing.

`GET /api/status` shows both roles:

```json
{ "extensions": { "snorkel": {"connected": true}, "dropbox": {"connected": true} } }
```

### 3. Run it

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
  "file_uploaded": true, "task_status": "new" }
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

| Endpoint | Purpose |
| --- | --- |
| `GET`/`POST` `/start_new_task` | **The whole workflow.** Returns a job id at once. Also at `/api/start_new_task` |
| `POST /api/run` | Same pipeline, blocking unless you pass `{"async":true}` |
| `GET /api/jobs` | The last 50 runs |
| `GET /api/jobs/:id` | One run: status, step, and the full result |
| `POST /api/start` | Snorkel step only. Optional body: `{"projectKey":"…","mode":"new\|resume\|any"}` |
| `POST /api/upload` | Dropbox step only. Optional body: `{"uid":"…","folder":"…","force":true}` |
| `GET /api/status` | Extensions connected? Firebase ready? Queue depth? |
| `GET /api/tasks` | 50 most recent `Tasks` documents |
| `GET /api/tasks/:uid` | One document |
| `GET /api/tasks/:uid/file` | The downloaded zip — what the Dropbox extension fetches |
| `POST /api/flush` | Replay queued tasks into Firestore (see below) |
| `GET /api/events` | Server-sent events stream of live progress |

`mode` picks which card to click: `new` (default) takes a fresh task,
`resume` continues one you already claimed, `any` prefers new and falls back.

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

**Dropbox** — [dropbox_extension/content/dropbox.js](dropbox_extension/content/dropbox.js),
derived from your saved `dropbox_ui.html` and verified the same way.

| Thing | Selector |
| --- | --- |
| Upload input | `input[data-testid="uploader-file-field"]` (hidden, `multiple`) |
| File listing | `[role="grid"]` with `[role="row"][aria-label^="File, "]` rows |
| File names | `[data-filename]` on each gridcell |
| Current folder | `[data-testid="browse-renamable-title"]` |

⚠️ There is also `input[data-testid="uploader-folder-field"]` (a
`webkitdirectory` picker). The selector targets the file field only.

⚠️ The folder heading renders its name **twice**, so a plain `.trim()` yields
`"All files\n   \n  All files"`. The code takes the first non-empty line.

Each selector has a fallback (text scan, body regex, URL parsing), so a cosmetic
class change won't break the run — but if Snorkel or Dropbox restructures these
panels, these files are the only places to update.

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
- **Uploads are confirmed, not assumed.** After injecting, the content script
  watches the file grid until the new `data-filename` row appears. If a file of
  the same name already existed, it accepts Dropbox's renamed version
  (`… (1).zip`) and reports `renamed: true`.
- **The local file is deleted only after the extension confirms.** A failed
  delete does not undo the upload — it comes back as a `warning` alongside
  `ok: true`.
- **Jobs live in memory.** Restarting the server loses the job *list*, never the
  *work*: every durable effect is already in Firestore or on disk by then. A job
  that was mid-flight when the server died leaves the task at
  `task_status: "downloaded"`, and `POST /api/upload` picks it up again.

## Not included

The Snorkel extension stops after the download. It does not fill in the review
form, upload a result, or click Submit — that stays manual. The Dropbox
extension only uploads; it does not organise, rename, or share.
