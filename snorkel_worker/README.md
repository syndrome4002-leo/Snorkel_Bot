# snorkel_worker

Picks up tasks from Firestore and works them with the Claude Code agent.

`snorkel_server` + the extension produce tasks. This consumes them. The two never
talk to each other directly — Firestore is the queue.

```
  extension ──► snorkel_server ──► Firestore ──► snorkel_worker ──► Claude
                      │                │                │
                      └──► Dropbox ◄───┴────────────────┘
```

## What it does

It polls for tasks in one of two states and takes them to **`ready to submit`**.

**`in build`** — the zip is on Dropbox and nothing is unpacked yet.

1. Download the zip into the work dir.
2. Set `file_uploaded: false`, then **delete the zip from Dropbox**.
3. Unpack it into `<work dir>/<UID>_submission/`.
4. Two turns with Claude: the reference documents, then the task.
5. Repack, upload, `file_uploaded: true`, answers saved, `task_status: "ready to submit"`.

A build is **the two prompts running successfully**, not a finished piece of
engineering. The second prompt asks Claude to inspect the task and answer the
submitter form, and explicitly tells it not to change anything yet. So "build
done" means both turns returned, and what you get back is the form answers.
Anything more than that is a later, human-driven step.

**`needs revision`** — the folder is already on disk; nothing is downloaded.

1. Find `<UID>_submission/`.
2. Continue the conversation that built the task, by its recorded session id, and
   hand it the newest feedback round: the reviewer's note and the automated check
   panes, kept apart because they carry different weight. Only that round — the
   earlier ones appear as a list of notes already dealt with, because their
   corrections are in the folder and re-reading the text invites redoing them.
3. Save whatever answers changed to `answers`, merged over the ones already
   there; anything Claude leaves out is still correct and stays as it was.
4. Repack, upload, `task_status: "ready to submit"` — from here it is the same
   road as a new task: the server hands the zip to the browser, the extension
   uploads it and runs the two platform checks, and a failure comes back as
   `static check fail` for the worker to answer.

The worker records a fingerprint of the reviewer's note in
`revision_notes_applied` once the round is safely uploaded. A note that comes
back unchanged is then labelled as already worked on rather than presented as new
work, which is the difference between "the reviewer is repeating themselves" and
"do all of that again".

While a task is open its status is **`Working..`**, so the dashboard shows what
Claude has in hand.

Deleting the zip from Dropbox at step 2 is what keeps the two halves honest: a
file present in Dropbox always means nobody is working on that task.

## Setup

```bash
cd snorkel_worker
npm install
cp .env.example .env      # then fill it in
npm run check             # verifies every dependency before you trust it
```

`npm run check` reports the lock, Firestore, the Realtime Database, Dropbox, the
Claude CLI, the documents and the prompt templates in one pass, so you fix
everything at once rather than one restart at a time.

Most of `.env` is the same as `snorkel_server/.env` — the two use the same Firebase
project and the same Dropbox app. Copy the `FIREBASE_*` block and the Dropbox
**app key and secret** across, and copy `serviceAccount.json` too (it is
git-ignored in both folders, so it does not travel with a clone).

### Connecting Dropbox

Do **not** copy the refresh token. Each process gets its own, and the worker hosts
the handshake itself:

1. Add this redirect URI on the app's **Settings** page in the
   [Dropbox App Console](https://www.dropbox.com/developers/apps), character for
   character:

   ```
   http://localhost:8788/api/dropbox/callback
   ```

2. Start the worker and open **<http://localhost:8788/>**.
3. Click **Connect Dropbox** and approve.

The token is written into `.env` and used immediately — no restart, nothing to
copy out of a terminal. That page also shows which machines the worker is working
for and how many slots are busy, so it doubles as a local status page.

It listens on `127.0.0.1` only. The dashboard is on this machine, so you are
already in front of it, and a page that rewrites credentials has no business
listening on the network. `CONNECT_PORT` and `CONNECT_HOST` change that;
`CONNECT_ENABLED=false` turns it off once you are connected.

Approving once is unavoidable — a refresh token *is* the record that a person
approved this app for their account.

## Running it

**In a terminal**, while you watch it:

```bash
npm start                 # Ctrl-C stops it cleanly
```

**As a service**, so it survives logout and comes back after a reboot:

```bash
cp snorkel-worker.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now snorkel-worker
journalctl --user -u snorkel-worker -f
```

Edit `WorkingDirectory` and the node `PATH` in the unit first if your checkout or
node install is elsewhere (`dirname "$(which node)"`).

It is a **user** unit, not a system one, because the worker runs Claude Code,
which reads your login and settings from your home directory. As a system service
it would run as root with none of that.

If the machine is a laptop, stop it suspending — a suspended machine is a worker
that has quietly stopped:

```bash
sudo systemctl mask sleep.target suspend.target
```

### One worker per machine

The second one refuses to start:

```
Another worker is already running on this machine (pid 31402 since 2026-08-02T17:35:34Z).
  stop it:   kill 31402
```

This is enforced, not assumed. Two workers would not corrupt anything — claims go
through a Firestore transaction — but they would each keep their own count of open
tasks, so a cap of three would really be six. Nothing would report an error; it
would just be slow, expensive, and wrong in a way you would only notice from the
bill.

The lock is `worker.lock` in this folder, holding the pid. It is a file rather
than a database entry because "one per machine" is a fact about this computer and
has to hold with no network. A lock left behind by a process that is gone is taken
over automatically, so a crash or a power cut does not need cleaning up by hand —
including after a reboot, where the pid may since have been reused by something
unrelated.

A holder that is *shutting down* is waited for, up to two seconds. `npm run dev`
uses `node --watch`, which starts the replacement as soon as it has signalled the
old process; without that wait, every other save would fail with "another worker
is already running". A holder that is really staying put is still refused — just
two seconds later.

`npm run once` does **not** take the lock: it is a deliberate, one-named-task
command, and the Firestore claim is what stops it colliding with the loop. It
warns if the loop is running, because two Claude sessions at once is a surprise if
you did not mean it.

### Which tasks it works on

The worker can run **anywhere**. It does not have to be the machine that produced
the task, and usually is not — put it next to the dashboard and leave
`snorkel_server` on the machine with the browser.

It works for the machines added on the dashboard. That list lives in the Realtime
Database at `/machines_index`, so it is shared rather than per-browser:

```
dashboard  ──add "sp-b2dd766e"──▶  /machines_index  ──▶  worker picks up
                                                          that machine's tasks
```

Adding or removing one takes effect within seconds — no restart:

```
➕ machines: now also working for sp-b2dd766e
➖ machines: no longer working for old-laptop-1a2b3c4d
```

**With no machines added the worker does nothing**, and says so rather than
looking idle. `ANY_MACHINE=true` ignores the list and takes every task, which is
a debugging switch rather than a normal setting.

This works across machines because the files travel through Dropbox: an `in build`
task arrives as a zip and everything after that is local. The folder it unpacks
stays put, so when that task later comes back for revision the worker finds it
where it left it.

`EXTRA_TASK_DIRS` is searched read-only when looking for an existing folder, which
covers task folders unpacked somewhere else before the worker existed.

**Its own logs** go under its own machine id. Add that id on the dashboard too if
you want to watch the worker there and set its concurrency — it is printed at
startup and by `npm run check`.

## Concurrency

Three at once by default. The dashboard's **Settings → Worker → Max tasks at once**
overrides `MAX_CONCURRENT` live; a task already running is never interrupted.

Each concurrent task is a full Claude session building a repo and running its
tests, so more is not automatically faster.

## Learning from failed checks

Every failed platform check is filed under a **signature** — the log with build
ids, timestamps, durations and paths normalised away, then hashed. That is what
makes the same complaint on a different task the same entry rather than a new
one, so the collection is an index instead of a pile.

```
task A fails  ─┐
task B fails  ─┴─► CheckLessons/<signature>   occurrences: 2
                     ↓ worker fixes it, writes what fixed it
                   lesson: "..."   confirmed: false
                     ↓ the platform then passes the task
                   confirmed: true
                     ↓
                   goes into every later build's prompt
```

A lesson is **written early and trusted late**. The worker records what it thinks
fixed a failure right after fixing it, but nothing is shown to another task until
the platform actually passes the upload. A guess about a failure nobody has
beaten is how a knowledge base starts teaching its own mistakes.

Only confirmed lessons reach a prompt, at most fifteen, most frequent first —
frequency being the closest thing to importance the data has.

Reading them can never fail a build: if the collection is unreachable the run
carries on without them. They are an advantage, not a dependency.

## Prompts

The wording lives in `prompts/*.txt`, not in code. Edits take effect on the next
task — no restart, no rebuild.

| file | when |
| --- | --- |
| `intro.txt` | turn one of any session that is not a resumed one: the reference documents |
| `triage.txt` | turn two for `in build` — fixable, invalid, or valid-as-is |
| `fix.txt` | turn three for `in build`, only when triage said fixable: the corrections and the submitter form |
| `revision.txt` | turn two for `needs revision` — the reviewer's note and the automated checks |
| `staticfix.txt` | after a platform check came back FAIL, with its build logs |
| `lesson.txt` | after a fix worked: what should the next task have known? |
| `extract.txt` | the last turn of every run: the same answers again, as JSON |
| `build.txt` | the old single-turn build, kept for reference; nothing sends it |

`fix.txt` is the submitter form itself, verbatim, ending with the instruction to
keep answers short, human-sounding, and free of markdown. Reword it there rather
than in code.

Placeholders: `{{docs}}`, `{{task_dir}}`, `{{uid}}`, `{{initial_infos}}`,
`{{logs}}`, `{{lessons}}`, `{{fields}}`, and — in `revision.txt` —
`{{note_status}}`, `{{reviewer_notes}}`, `{{automated_checks}}`, `{{history}}`.
An unrecognised one is left alone rather than blanked.

The documents are handed over as **paths**, not contents — Claude Code reads files
itself, and pasting seven guides inline would spend most of the context window
before the task is even mentioned.

`revision.txt` gets the newest round only, split in two: the reviewer's note and
the automated check panes. They are kept apart because they are not equal — a
person looked at the task, the checks did not — and the prompt says to follow the
reviewer where the two disagree.

Earlier rounds appear as a one-line list of notes already dealt with, not as more
work. Their corrections are already in the folder, and putting the text back in
front of the model is how a revision quietly undoes the round before it. Whether
a note is new is decided by the worker from `revision_notes_applied`, not by
asking the model to remember a conversation it may not have had.

## Running one task by hand

```bash
npm run once -- <UID>          # work it now, print everything
npm run once -- <UID> --dry    # print both prompts, run nothing
```

`--dry` is the fastest way to see what a wording change actually produces.

## What it writes

| field | |
| --- | --- |
| `task_status` | `Working..` while open, then `ready to submit` |
| `answers` | an object keyed by form field — see below |
| `answers_history` | one entry per round: the fields it set, plus the prose they came from |
| `file_uploaded` | `false` after the download, `true` after the upload |
| `dropbox_path` | `null` after the download, the new path after the upload |
| `worked_from` | which state it was claimed from, so a failure can put it back |
| `worker_session_id` | resume the session by hand: `claude --resume <id>` |
| `worker_error` | why the last attempt failed, cleared on the next claim |

### The answers object

One key per box on the platform's form:

```json
{
  "validity_required": "fixable",
  "duplicate": "fixable",
  "where_task_had_issues": ["instructions", "tests"],
  "what_issues_found": ["the instructions are overly-prescriptive"],
  "issues_in_detail": "...",
  "senior_estimated_time": "20-40 minutes",
  "review_time_min": 10
}
```

A key that does not apply is left out rather than stored empty, so "not asked"
and "answered with nothing" stay distinguishable.

**This is why it is an object and not a list of rounds.** A reviewer sends back a
few points, and the revision prompt asks for the changed answers *and only those*
so you can replace them. Merging that reply over what is stored leaves every
untouched answer exactly as it was. A list of rounds could not do that without
somebody reading both and working out which one won.

`answers_history` keeps each round anyway, because merging loses the previous
value of an overwritten field, and an answer that got worse is the one you want
to look at. Each entry also carries the prose from turn two, which is both what
you paste into a box the schema does not cover and the only way to tell a bad
answer from a bad extraction of a good one.

The fields live in [prompts/answers.schema.json](prompts/answers.schema.json).
The extraction prompt is generated from it, so adding a key there is enough to
have it asked for and stored, with no code change.

## When things go wrong

A task that fails goes back to the status it came from, with `worker_error` set,
and is retried on a later poll.

**Crashes are recovered.** `Working..` is a claim, and a claim outlives the process
that made it — so on startup the worker puts back anything left claimed by this
machine. Without that, one crash would park a task forever, because nothing else
looks at that status.

This is safe precisely because there is only one worker per machine: recovery runs
before this worker has claimed anything, so a task marked `Working..` by this
machine is necessarily abandoned. There is no second worker whose live work it
could be, which is why no heartbeat or lease timeout is needed.

As a second opinion it also checks the pid that made the claim. A lock file can be
deleted by hand — and the advice for a worker that will not start is to do exactly
that. Do it while the first worker is still alive and recovery would otherwise
reclaim tasks being worked on right now. Instead you get:

```
⚠️ still_live: <UID> is claimed by pid 31402, which is still running — leaving it
   alone. Two workers appear to be running on this machine; stop one.
```

**A retry never re-downloads.** The zip is deleted from Dropbox as soon as it is
safely on disk, so a task that failed after that point would otherwise fail forever
on a file that is no longer there. A `downloaded_at` stamp with no `dropbox_path`
means the folder is already here, and the retry works in place.

**Permissions.** `CLAUDE_PERMISSION_MODE` defaults to `bypassPermissions`. An
unattended run cannot answer a permission prompt, and a task needs to run its own
tests, so anything narrower eventually hangs waiting for a keypress nobody is
there to give. Narrow it to `acceptEdits` if you would rather a run fail than have
the agent execute commands unsupervised.

**Install `zip` and `unzip`.** They are used in preference to the bundled JS
library because a task carries `tests/test.sh` and `solution/solve.sh`, which have
to stay executable, and `environment/repo/.git`, which contains symlinks. The
fallback flattens permissions, and repacking with it would hand back a zip whose
scripts no longer run.
