# Prescriptiveness Check — Failure Summary & Task-Authoring Checklist

Source: `issues.md` (10 CodeBuild runs, 2026-07-30 → 2026-07-31)

## Bottom line

All 10 runs failed on the **same** check: `python3 -m scripts.harbor.checks.cdg_sentinel_ultra.prescriptiveness`.
Never on tests, Docker, or solution correctness — always on the wording of the task instruction.

| Run | Time | Score | Findings (high / med / low) |
|---|---|---|---|
| 1 | 07-30 18:14 | 0.45 | 0 / 2 / 0 |
| 2 | 07-30 19:52 | 0.20 | 3 / 1 / 1 |
| 3 | 07-30 20:14 | 0.50 | 0 / 3 / 1 |
| 4 | 07-30 20:14 | 0.45 | 0 / 2 / 1 |
| 5 | 07-30 20:28 | 0.50 | 0 / 2 / 0 |
| 6 | 07-30 23:12 | 0.20 | 4 / 2 / 0 |
| 7 | 07-31 12:17 | 0.45 | 0 / 2 / 1 |
| 8 | 07-31 14:47 | 0.35 | 1 / 2 / 2 |
| 9 | 07-31 14:47 | 0.35 | 1 / 2 / 2 (identical resubmission of run 8) |
| 10 | 07-31 16:38 | 0.10 | 6 / 3 / 2 |
| 11 | 07-31 16:51 | 0.50 | 0 / 2 / 0 |
| 12 | 07-31 17:16 | 0.25 | 2 / 1 / 1 |

Two operational notes:

- The check prints *"optional and does not block submission"* but **exits 1 and fails the BUILD phase**. Treat it as blocking.
- Runs 8 and 9 are byte-identical. Re-uploading without rewriting the prose scores exactly the same — the fix has to be in the wording.

## The single failure mode

The instruction tells the agent **HOW** instead of **WHAT**. Findings are mapped to numbered rules (R2–R6).

### R3 / R5 — Prescribing the algorithm or revealing the internal causal chain
The biggest source of `high` findings. Matching priority, traversal order, null-handling, conjunction-vs-disjunction, provenance rules, fallback chains.

> "The first mode that is set decides the answer, in the order exact, prefix, regex, empty, noempty…"
> "Headers are the odd one out: they are an alternative rather than a conjunction…"
> "events arriving before initialization completes are held and replayed rather than dropped, and if initialization never comes they eventually time out"
> "A traffic router in the group applies when its `hosts` list is empty or names that provider… The first route detail that matches wins…"
> "The helper has to hand the argv it received to the spawn unchanged. And every call site has to supply an argv that the module fixes for itself…"

Fix: state the end-to-end observable behaviour only — "events must not be silently dropped", "a matched request must be narrowed to its subset".

### R5 — Pre-answering edge cases the agent is meant to discover

> "The key has to come back up once the block finishes, including when the block raises"
> "Three outcomes follow from that: … A rule claims the request but the subset resolves to nothing. Return an empty list."
> "does it effectively straight away when that delay is zero"
> "sub-pixel jitter that doesn't change the pixel the pointer is on is not a move"
> "Sliding straight from one corner into another counts as leaving the first and entering the second, in that order"
> "the missing key has to be merged in so it turns up under storage.local.preferences"
> "keep whatever was already there, append name=value on the end, separate entries with a semicolon and a space"

Fix: state the invariant, not the corners. The corners belong in the hidden tests.

### R5 — Naming the broken symbols / describing the existing bug

> "its keydown and keyup lines still carry `which` and `charCode`"
> "anything with a space, a colon, base64 padding or another separator gets dropped halfway through"
> "`.exec` on a regular expression is not command execution"
> "A file that never actually invokes a child process must not be flagged, even when it imports one."

Fix: describe the required output going forward. Let the agent find the delta.

### R2 — Naming files, symbols, or struct members to create/modify

> "Put the component in a new module, `src/corner.h` and `src/corner.c`"
> "`wlmaker_cursor_t` gains `struct wl_signal position_updated`"
> "an `output_layout_changed_event` signal on `wlmaker_server_t`"
> "exports them as `wlmaker_corner_test_cases`"
> "Bump `MODERATION_ENGINE_VERSION` as usual."

Fix: "implement as a self-contained module"; "update the engine version constant per project convention".

### R4 — Pseudo-code, signatures, skeletons

> A complete compilable C signature block: `wlmaker_corner_t *wlmaker_corner_create(wlmcfg_dict_t *…, struct wl_event_loop *…, …);`
> "`page.keyboard { press('Shift') { ... } }` … `textarea.press('Shift') { ... }`"

Fix: describe the public contract in prose. Even illustrative syntax gets flagged.

### R6 — Dictating values/formats derivable from upstream

> "five rows by twenty columns"
> "its data, its input type and its composing flag, in that order"
> "the repo needs a tsconfig.json at its root with baseUrl of `.` and paths mapping `~/*` to `src/*`"
> "Evidence must never repeat the value."

Fix: "must match what upstream's suite expects"; "imports using the `~` prefix must resolve to `src/`".

### R3 — Characterizing the current implementation, or forbidding an approach

> "SerializerMutation stops being metaclass-driven and becomes something you subclass"
> "it should read the request context off the resolver info rather than take it as its own argument"
> "Do not try to build a nested input type"
> "it is safe because of what it does, not because of what it is called. Rename it and the answer must not change."

Fix: drop the history, drop the negative directive, drop the explanatory aside. Keep only the observable contract.

## Checklist — apply before submitting any task

1. State the **observable contract** only: given X, the system must do Y. Never the internal steps producing Y.
2. **No new symbol names.** Don't name modules, files, functions, structs, fields, signals, constants, or test-export arrays the agent must create — nor the existing type/file it must modify.
3. **No signatures, no pseudo-code, no syntax samples.** Describe the API surface in prose. Don't lock parameter order.
4. **Don't diagnose.** Never say what's currently broken, which fields are stale, or why a false positive happens.
5. **Don't enumerate edge cases.** Zero-delay, empty-vs-null, exception paths, boundary pixels, jitter, ordering-on-transition, generated-vs-handwritten — each enumeration is a finding.
6. **Don't distinguish "no match" from "matched but empty"** in prose. That belongs in the tests.
7. **Don't specify carrier/payload types** or which resource drives a mechanism ("the event loop to run the countdown on"). Say what must be conveyed.
8. **Don't restate values readable from upstream/fixtures** — dimensions, field order, config keys, header formatting.
9. **Don't say "do not do X."** Negative implementation directives count as prescribing approach.
10. **Drop explanatory asides** that reveal the design insight.

**Rule of thumb:** if a sentence would still be true and useful to someone who has never seen the diff, it's a requirement — keep it. If it only makes sense because you've already read the solution, delete it and put it in the tests instead.
