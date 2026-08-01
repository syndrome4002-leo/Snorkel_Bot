# Snorkel Bot

Two pieces that work together:

| Folder | What it is |
| --- | --- |
| [extension/](extension/) | Chrome MV3 extension that drives `experts.snorkel-ai.com` |
| [server/](server/) | Node server that commands the extension and writes to Firebase |

The server never touches the browser and the extension never touches Firebase.
They talk over a single WebSocket.

---

## Flow

```
  YOU / cron / another service
        │  POST /api/start
        ▼
  ┌─────────────────┐   ws://localhost:8787/extension    ┌────────────────────┐
  │  node server    │ ────── start_sentinel ──────────▶  │  chrome extension  │
  │                 │ ◀───── progress ×5 ─────────────   │  (service worker)  │
  │                 │ ◀───── result {task, meta} ─────   └─────────┬──────────┘
  └────────┬────────┘                                              │
           │ saveTask()                                            │ 1. open /home
           ▼                                                       │ 2. click "Start"
  Firestore  Tasks/<UID>                                           │ 3. review page:
    UID, file_name, initial_infos                                  │    scrape + download
                                                                   ▼
                                                          experts.snorkel-ai.com
```

Step by step:

1. **Server asks.** `POST /api/start` → the hub sends
   `{type:"start_sentinel", requestId}` down the socket and holds the HTTP
   response open until the extension answers.
2. **Extension goes home.** The service worker opens (or reuses) a tab on
   `https://experts.snorkel-ai.com/home`, then asks the content script to find
   the Sentinel project card and **click its `Start` button**.
3. **Extension works the review page.** The site routes to
   `/projects/<id>/submission-<id>/review`. The content script waits for the page
   to render, scrapes the submission UID and the left-hand info panel, then
   clicks the task's **Download file** button. The service worker had already
   armed a `chrome.downloads.onCreated` listener, so it captures the *real*
   filename Chrome saved to disk. The tab is left open for you to work in.
4. **Server saves.** The extension sends back `{task, meta}`; the server writes
   `Tasks/<UID>` to Firestore and returns the stored record as the HTTP response.

---

## What gets stored

Firestore collection **`Tasks`**, document id = the submission UID (so re-running
the same task updates the record instead of duplicating it):

| Field | Source |
| --- | --- |
| `UID` | the `UID:` badge in the review page top bar |
| `file_name` | the filename Chrome actually saved, falling back to the name shown on the page |
| `initial_infos` | `innerText` of the whole left panel, as plain text |
| `source_url` | the review page URL (extra context) |
| `created_at` / `updated_at` | ISO timestamps written by the server |

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
cd server
npm install
npm start
```

`server/.env` and `server/serviceAccount.json` are already in place for Firebase
project **`snorkel-fe3eb`**. Both are git-ignored, and the key file is `chmod 600`.

### Credentials on another machine

Nothing machine-specific is stored in `.env`. Credentials are resolved in this
order, so the same checkout works anywhere:

1. **`FIREBASE_SERVICE_ACCOUNT_JSON`** — the key itself as one line, raw JSON or
   base64. Use this where you cannot ship a file (Docker, Cloud Run, Heroku, CI):
   ```bash
   FIREBASE_SERVICE_ACCOUNT_JSON=$(base64 -w0 serviceAccount.json)
   ```
2. **`FIREBASE_SERVICE_ACCOUNT`** — a path to the key file. **Relative paths
   resolve from the `server/` folder, not the working directory**, and it
   defaults to `serviceAccount.json`. So copying `server/` anywhere and dropping
   the key next to `package.json` just works — no path to edit, and it does not
   matter whether you start the server from `server/`, from the repo root, or
   from a systemd unit with no working directory.
3. **Application Default Credentials** — `gcloud auth application-default login`,
   or the metadata server on GCE / Cloud Run, where no key file exists at all.

The startup log prints which one it used. A path you set explicitly that turns
out to be missing is reported as an error rather than silently falling through.

**To deploy:** copy `server/`, run `npm install`, and either put
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

### 2. Extension

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select the [extension/](extension/) folder
3. Click the extension icon. The dot should turn green (`connected`). If you set
   `BOT_TOKEN` in `.env`, put the same value in the popup's Token field and hit
   **Save & reconnect**.
4. Sign in to `https://experts.snorkel-ai.com` in that same Chrome profile. The
   extension reuses your session; it never handles your password. If it lands on
   the login page it aborts with a clear error instead of guessing.

### 3. Run it

```bash
curl -X POST http://localhost:8787/api/start
```

Or click **Start now** in the popup to test the browser half on its own.

---

## Server API

| Endpoint | Purpose |
| --- | --- |
| `POST /api/start` | Run the flow, save to Firestore, return the record. Optional body: `{"projectKey":"…","mode":"new\|resume\|any"}` |
| `GET /api/status` | Extension connected? Firebase ready? |
| `GET /api/tasks` | 50 most recent `Tasks` documents |
| `GET /api/tasks/:uid` | One document |
| `GET /api/events` | Server-sent events stream of live progress |

`mode` picks which card to click: `new` (default) takes a fresh task,
`resume` continues one you already claimed, `any` prefers new and falls back.

---

## The selectors it depends on

Derived from your saved `snorkel_homepage.html` and
`snorkel_sentinel_project_UI.html`, and verified against both files with a real
DOM parser.

**Home page** — [extension/content/homepage.js](extension/content/homepage.js)

| Thing | Selector |
| --- | --- |
| Project cards | `[data-testid="project-card"]` |
| Sentinel Start link | `a[data-testid$="-CDG_Sentinel_Ultra_00000"]` |
| New vs. resume | resume cards are prefixed with an assignment UUID (`029c1c0c-…-CDG_Sentinel_Ultra_00000`); the new one is `Submission-CDG_Sentinel_Ultra_00000` |
| Start button | the `<button>` inside that anchor |

**Review page** — [extension/content/sentinel.js](extension/content/sentinel.js)

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
these two files are the only places to update.

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
- **The MV3 worker gets evicted when idle.** A 30-second alarm wakes it to
  re-establish the socket, and reconnects use capped exponential backoff, so the
  extension recovers on its own if you restart the server.
- **One task at a time.** A second `start_sentinel` while one is running is
  rejected rather than queued.

## Not included

The extension stops after the download and reports back. It does not fill in the
review form, upload a result, or click Submit — that stays manual.
