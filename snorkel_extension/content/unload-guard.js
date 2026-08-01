/*
 * unload-guard.js — runs in the page's MAIN world at document_start.
 *
 * Why this exists
 * ---------------
 * The Sentinel review form registers a `beforeunload` handler so you cannot
 * wander off with unsaved answers. The task download button does not use an
 * <a href download> link — it navigates the top-level page to a signed file URL.
 * Chrome fires `beforeunload` *before* it has seen the response, so at that
 * moment it cannot know the URL is a download rather than a page: it shows
 * "Leave site?" and stops there. Answering "Leave" lets Chrome fetch, see
 * Content-Disposition: attachment, turn the navigation into a download and keep
 * you on the page — which is why the download only starts after you click.
 *
 * A native dialog cannot be dismissed by an extension, so the prompt has to be
 * prevented rather than answered. This script silences the handler *only* for
 * the few seconds around our download click; the rest of the time the form's
 * unsaved-changes guard behaves exactly as the site intends.
 *
 * It must run in the MAIN world (content scripts live in an isolated world and
 * cannot see the page's own listeners) and at document_start, so that our
 * listener is registered before the app's. For an event targeted at `window`,
 * listeners fire in registration order, so being first is what lets
 * stopImmediatePropagation() suppress the ones registered later.
 */

(function () {
  let suppressing = false;
  let savedOnBeforeUnload = null;

  window.addEventListener(
    'beforeunload',
    (event) => {
      if (!suppressing) return;
      // Stopping propagation is the whole mechanism: the app's handlers never
      // run, so nothing ever asks for the dialog.
      //
      // Deliberately NOT touching event.returnValue. On BeforeUnloadEvent it is
      // a string where '' means "no dialog", but on the legacy Event interface
      // it is a boolean where any falsy assignment CANCELS the event — which is
      // how you request the dialog. Writing to it could cause the very prompt
      // this code exists to prevent, and it buys nothing once the later
      // handlers are suppressed.
      event.stopImmediatePropagation();
    },
    true
  );

  window.addEventListener('snorkelbot:suppress-unload', () => {
    if (suppressing) return;
    suppressing = true;
    // addEventListener handlers are covered above; this covers the
    // window.onbeforeunload = fn style, which we can put back afterwards.
    savedOnBeforeUnload = window.onbeforeunload;
    window.onbeforeunload = null;
  });

  window.addEventListener('snorkelbot:restore-unload', () => {
    if (!suppressing) return;
    suppressing = false;
    window.onbeforeunload = savedOnBeforeUnload;
    savedOnBeforeUnload = null;
  });
})();
