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

  text(el) {
    if (!el) return '';
    // innerText (not textContent) so the DOM's own line breaks survive and the
    // pretty-printed whitespace of <span style="white-space: pre-wrap"> stays sane.
    return (el.innerText || el.textContent || '').trim();
  },

  /** Real user-ish click: some React handlers need the pointer events too. */
  click(el) {
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      el.dispatchEvent(
        new MouseEvent(type, { bubbles: true, cancelable: true, view: window })
      );
    }
  },

  UUID_RE: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
};

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
    .catch((err) => sendResponse({ ok: false, url: location.href, error: String(err && err.message || err) }));

  return true; // keep the message channel open for the async response
});
