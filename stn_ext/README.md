# Sentinel Submission Helper

A Chrome extension that adds nine small buttons along the bottom edge of the Sentinel
submission page, so the copying, the answer autofill and the navigation all take one click
each. Submitting is left to the page, deliberately.

Shows only on `https://experts.snorkel-ai.com/projects/1230ae8f-afc6-4705-abc7-fbe1c94250ff/*`.
That scoping lives in `SHOW_ON` at the top of `src/ui.js`, not in the manifest: change the
project id there. The manifest deliberately matches the whole host, because Chrome injects a
content script only on a real page load, and a narrower pattern misses every task you reach by
clicking through the app rather than landing on its URL.

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode**, top right.
3. **Load unpacked**, and pick this `stn_ext` folder.
4. Reload the submission tab. Nine round buttons appear along the bottom edge.

Needs Chrome 111 or newer, because the content script asks for `"world": "MAIN"`. It
declares no permissions and talks to nothing outside the page.

The bar sits centred along the bottom edge with no padding of its own, and rests at half
opacity so it does not compete with the page. Hovering it, or tabbing into it, brings the whole
group to solid. The leftmost button is a grip: drag that to put the bar somewhere else, and
nothing else moves it. The position is remembered.

## The buttons

| | Name | What it does |
| --- | --- | --- |
| **D** | Detail Copy | Copies the whole task detail panel on the left as plain text: heading, value, blank line, next heading. Task Tags and Languages come out numbered, and the metadata block keeps its TOML line breaks and indentation. |
| **F** | Feedback Copy | Copies the whole feedback picture in one go: **Reviewer Feedback** and **Automated Feedback** from the Task Notes sidebar, then the four check panes. Each sits under a marker heading, one blank line below it, five blank lines before the next. A note that is not on the page is left out entirely, heading included. Panes that have not run yet say `(no result yet)`. |
| **A** | Answer Upload | Asks for `submission_answers_<repo>_<pr>.json`, then fills every field it describes and shows a report saying what went in, what was left alone and what it could not find. The verdict goes first, on **both** copies of the question, since the platform asks it twice and the two have to agree. |
| **T** | Task Upload | Opens the file picker for the task zip field on the current path: the Fixable re-upload, or the Not Fixable attempt upload. If that field already holds a file the platform hides its dropzone, so T scrolls to it and names the file instead, since it has to be removed before another can go on. |
| **C** | Check Feedback | Scrolls to **Static Checks** and presses its button. It always scrolls, even when there is nothing to press: a disabled button gets the page's own reason repeated back, and once the check has run the platform removes the button, so C just says so and leaves you looking at the results. |
| **S** | Send to Reviewer | Scrolls to **Send to Reviewer (optional)** and ticks `Send to reviewer?`. Pressing it again leaves it ticked rather than toggling it back off. Fixable path only, since the field lives in Submission Feedback. |
| ▲ ▼ | Scroll to Top / Bottom | Jump the form's own scroll container to the first question or to the end. |
| ⠿ | Move the bar | Drag to reposition the group. The only thing that moves it. |

A hairline between **F** and **A** separates what reads out of the page from what writes into
it. Hover any button, or Tab to it, and a tooltip gives its full name and what it does.
There is one tooltip shared by all of them, placed against the viewport rather than inside the
button, so it cannot be clipped and never runs off the left edge.

**F** lays the four panes out like this:

```
##################### Difficulty Check #####################

Difficulty: FAIL EASY - Requires at least MEDIUM
...




##################### Agentic Judge Quality Report #####################

...
```

Nothing is silent. Short confirmations appear as toasts beside the bar, which stack downwards
once the bar is dragged into the top half of the window. The two big cards, the autofill report
and the fallback text panel, are centred in the viewport instead, so where the bar sits never
hides them. Neither blocks the page behind it, and if the browser refuses a clipboard write the
text is shown with its own Copy button rather than being lost.

## The answer JSON

Part three of `Submission Answers Guide.txt` is the contract, and this extension is the
consumer it describes. Three worked examples are in `examples/`, one per verdict path.

```json
{
  "schema": "sentinel-submission-answers/v1",
  "verdict": "Fixable",
  "fields": [
    { "id": "verdict", "label": "What is your analysis of the Sentinel task you downloaded above?",
      "type": "radio", "options": ["Fixable", "Invalid/Not Fixable", "Valid as-is"], "value": "Fixable" },
    { "id": "issue_areas", "label": "Select where the task had issues (check all that apply)",
      "type": "checkbox_group", "options": [{ "label": "Instructions", "checked": true }] },
    { "id": "time_review", "label": "How long (in minutes) did it take you to review the initial task and determine its validity?",
      "type": "number", "value": 55 }
  ]
}
```

What matters:

**`label` is how a field is found.** The page has no stable ids, so the question text is the
key. Copy it as the platform renders it. Matching is forgiving about case, a trailing colon
or full stop, a trailing `(optional)`, the `(SEGMENTS)` and `[Duplicate]` prefixes, and en or
em dashes where the page has a hyphen. It will not guess between two different questions: if
nothing matches, the report says so and names the question the page came closest to.

**Order matters.** Fields are filled top to bottom, and the verdict is hoisted to the front
whatever position it holds, because the platform only renders the rest of the form once the
verdict is chosen.

**`checked` is set on every option, true and false alike.** List them all. Any option the
JSON does not mention is left exactly as it was, and the report says which ones those were.

**`type` is a hint, not an instruction.** The control is detected from the page. The answers
guide types `files_changed` and `unfixable_explanation` as richtext while the platform
renders both as plain textareas, and that resolves itself.

**File fields cannot be filled.** Browsers do not let a script set a file input, for good
reasons. Those entries come back as `MANUAL` with the path from the JSON, and the **T**
button opens the right picker.

Values are plain text with real newlines. No markdown, no HTML. Rich text fields get their
blank line separated blocks turned into paragraphs, which is what the editor would have done
with a paste. If the editor auto-links something that looks like a domain, which it does for
`.py`, `.sh`, `.md`, `.io` and `.ai`, the extension unlinks it and warns you if any survive.

## What the report means

| | |
| --- | --- |
| `OK` | written and read back with the value the JSON asked for |
| `WARN` | written, but worth a look: a number outside the field's own min or max, options left untouched because the JSON did not list them, links the editor made |
| `FAIL` | the field was found but would not take the value, with what it kept instead |
| `MISS` | no question on the page matched that label |
| `FAIL` on **Verdict** | the JSON carries no verdict and none is chosen on the page, so the platform never rendered the questions that depend on one. Nothing else is filled |
| `MANUAL` | a file field, attach it yourself |

Every write is read back off the page before it is called done, so `OK` means the control
actually holds the value, not that a click was sent.

## How the awkward parts work

**Collapsed sections.** The form is a Radix accordion and it unmounts the contents of a
closed section, so nothing in it can be filled or read. Every section is opened first, and
opened again after the verdict is set, since that is when new sections appear.

**The feedback panes are Monaco editors,** which only render the lines you can see. The value
is taken from the Monaco model when the app exposes its API, otherwise from the string the
React wrapper was handed, and failing both the viewport is walked down and the rendered lines
are stitched back together by their absolute position. That last path is the slow one and is
only used when the pane is genuinely scrollable.

**Clicks are verified, not assumed.** A checkbox whose row and inner control both handle the
click would toggle twice and land back where it started. Each toggle is checked, and if a
click had no net effect the next one aims one level up. Radios get the same treatment against
the wrapping label.

**Rich text** is set through the TipTap editor instance when it can be reached through the
React tree, otherwise by a paste event, otherwise by `execCommand`. Whichever lands, the text
is read back and compared.

## Layout

```
manifest.json
src/util.js        text normalisation, label scoring, React fiber walk, clipboard
src/page.js        every selector this page needs, in one place
src/setters.js     the verified writes: radio, checkbox, textarea, number, rich text
src/extract.js     task detail panel, and reading Monaco back out
src/autofill.js    walking the answers JSON into the form
src/notes.js       reading the Reviewer and Automated feedback cards
src/actions.js     the button behaviours
src/ui.js          the shadow DOM panel, toasts, chooser and report
examples/          one answers JSON per verdict path
```

`src/page.js` is the file to edit when the platform changes its markup. Everything else
works through it.
