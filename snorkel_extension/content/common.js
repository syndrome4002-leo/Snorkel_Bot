/*
 * common.js — shared plumbing for every content script in this extension.
 *
 * All three content-script files share one isolated world, so a top-level `var`
 * here is visible to homepage.js and sentinel.js. They register handlers on
 * SnorkelBot.handlers; this file owns the single onMessage listener.
 *
 * The site is a single-page app: navigating from /home to the review page is a
 * client-side route change, so content scripts are NOT re-injected. That is why
 * every script matches https://experts.snorkel-ai.com/* rather than a specific
 * path, and why handlers must re-query the DOM each time they run.
 */

var SnorkelBot = {
  handlers: Object.create(null),

  on(type, fn) {
    this.handlers[type] = fn;
  },

  /**
   * Tells the background something happened, without waiting for the handler to
   * finish.
   *
   * A handler's return value is the only thing that normally leaves this page,
   * and it leaves at the end. That is fine for describing what happened — and
   * wrong for anything that has already happened and cannot be undone, because
   * everything after it is a chance for the report to be lost. Submitting the
   * form is the one action of that kind: the click lands, the page navigates,
   * this script is torn down mid-sentence, and the server is still waiting for a
   * reply that will never come — with the task submitted and nothing recording
   * it.
   *
   * Fire and forget on purpose. If nobody is listening, the run carries on.
   */
  report(step, detail) {
    try {
      chrome.runtime.sendMessage({ type: 'BOT_REPORT', step, detail: detail ?? null }, () => {
        // Reading lastError is what stops Chrome logging "no receiver" noise.
        void chrome.runtime.lastError;
      });
    } catch {
      /* the page is going away, which is exactly when this is called */
    }
  },

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },

  /** Poll `fn` until it returns something truthy, or give up after timeoutMs. */
  async waitFor(fn, { timeout = 30000, interval = 300, label = 'condition' } = {}) {
    const deadline = Date.now() + timeout;
    let lastErr = null;
    while (Date.now() < deadline) {
      try {
        const value = await fn();
        if (value) return value;
      } catch (err) {
        lastErr = err;
      }
      await this.sleep(interval);
    }
    throw new Error(
      `Timed out after ${timeout}ms waiting for ${label}` +
        (lastErr ? ` (last error: ${lastErr.message})` : '')
    );
  },

  /** One line, whitespace collapsed, curly quotes and dashes folded. */
  normText(value) {
    return String(value == null ? '' : value)
      .replace(/\u00a0/g, ' ')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/[\u2013\u2014]/g, '-')
      .replace(/\s+/g, ' ')
      .trim();
  },

  /** Loose comparison for a label: case, trailing punctuation and "(optional)". */
  normLabel(value) {
    return this.normText(value)
      .toLowerCase()
      .replace(/^\[[^\]]*\]\s*/, '')
      .replace(/^\([^)]*\)\s*/, '')
      .replace(/\s*\(optional\)\s*$/, '')
      .replace(/[\s:;.,]+$/, '')
      .trim();
  },

  /** Keeps paragraph breaks but tidies trailing space and runs of blank lines. */
  cleanBlock(value) {
    return String(value == null ? '' : value)
      .replace(/\r\n?/g, '\n')
      .replace(/\u00a0/g, ' ')
      .split('\n')
      .map((line) => line.replace(/[ \t]+$/, ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\n+/, '')
      .replace(/\s+$/, '');
  },

  text(el) {
    if (!el) return '';
    // innerText (not textContent) so the DOM's own line breaks survive and the
    // pretty-printed whitespace of <span style="white-space: pre-wrap"> stays sane.
    return (el.innerText || el.textContent || '').trim();
  },

  /**
   * Clicks an element the way the browser does.
   *
   * Default is the element's native .click() — a single event, which is what a
   * real press ultimately produces. The synthetic pointer/mouse sequence is
   * available via {sequence: true} for handlers that genuinely need it, but it
   * is NOT the default: firing five events can make an app run its handler more
   * than once (say a mouseup handler and a click handler both acting), and
   * fabricating 'pointerdown' as a MouseEvent rather than a PointerEvent can
   * push a component down a different code path than a real click would.
   */
  click(el, { sequence = false } = {}) {
    el.scrollIntoView({ block: 'center', behavior: 'instant' });

    if (!sequence && typeof el.click === 'function') {
      if (typeof el.focus === 'function') el.focus();
      el.click();
      return;
    }

    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const Ctor = type.startsWith('pointer') && typeof PointerEvent === 'function'
        ? PointerEvent
        : MouseEvent;
      el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, view: window }));
    }
  },

  UUID_RE: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
};

/*
 * The review form guards against losing unsaved answers, so navigating away
 * from it raises Chrome's "Leave site?" dialog — which is native, and which no
 * extension can click. It has to be prevented instead.
 *
 * unload-guard.js does the preventing, in the page's own world. These two
 * handlers are what reach it, and they live here rather than in sentinel.js so
 * any page can be asked, not just the review page.
 */
SnorkelBot.on('SUPPRESS_UNLOAD', () => {
  window.dispatchEvent(new CustomEvent('snorkelbot:suppress-unload'));
  // If the navigation does not happen after all, the site's own guard comes
  // back rather than staying off for the rest of the session.
  setTimeout(() => window.dispatchEvent(new CustomEvent('snorkelbot:restore-unload')), 30000);
  return { suppressed: true };
});

SnorkelBot.on('RESTORE_UNLOAD', () => {
  window.dispatchEvent(new CustomEvent('snorkelbot:restore-unload'));
  return { restored: true };
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;

  if (msg.type === 'PING') {
    sendResponse({ ok: true, url: location.href, ready: true });
    return false;
  }

  const handler = SnorkelBot.handlers[msg.type];
  if (!handler) return false;

  Promise.resolve()
    .then(() => handler(msg))
    .then((data) => sendResponse({ ok: true, url: location.href, ...data }))
    .catch((err) =>
      sendResponse({
        ok: false,
        url: location.href,
        error: String((err && err.message) || err),
        // What kind of failure it was, where the handler said. Without this the
        // caller gets a sentence and has to match on its wording to tell "the
        // page is not offering this task" apart from "something broke".
        code: (err && err.code) || null,
      })
    );

  return true; // keep the message channel open for the async response
});
