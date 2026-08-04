# Reader tests

These cover the page-reading code: `content/homepage.js`, which finds tasks on
the redesigned home page, and `content/feedback-main.js`, the MAIN-world code
that reads the four check panes and the build-log panel. Every bug it has had has been the same
shape: the capture looks fine, is stored, and is quietly missing most of the
text. Reading the code does not catch that; running it against a virtualised
editor does.

    cd snorkel_extension/test
    npm install jsdom
    node run-all.js

`monaco-harness.js` builds a fake pane with the properties that actually matter:
only the lines on screen exist in the DOM, `.view-line` tops are absolute
offsets into the document, `.view-lines` is as tall as the whole document (not
the viewport), and the thing moves on wheel events.

| suite | what it holds to |
| --- | --- |
| `test-homepage.js` | the home page and project-page handlers, run against the saved `snorkel_homepage.html` and `snrokel_project_start_UI.html`. The failure it guards against is silent: a selector that stops matching reports "nothing to revise" rather than an error. |
| `test-reader.js` | four panes, one of them long, captured character for character. Takes a git revision as an argument (`node test-reader.js HEAD`) to check an older version. |
| `test-guards.js` | the shortcuts — Monaco's model registry, a React prop, a Copy button — are used when they belong to the pane and refused when they belong to its neighbour. |
| `test-edges.js` | an overshooting scroll, a report too long for the time allowed, the pane left where it was found, and a plain non-Monaco panel. |
| `test-scroll-modes.js` | nine ways a synthetic wheel fails to move a pane by deltaY: sensitivity, clamping, smooth scrolling, jitter, and starting part-way down. |
