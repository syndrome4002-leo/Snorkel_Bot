/*
 * monaco-bridge.js — runs in the page's MAIN world, at document_start.
 *
 * The four check panes are Monaco editors, and Monaco only renders the lines
 * currently scrolled into view. Reading their DOM gives whatever fits the
 * viewport, silently cut off.
 *
 * This is a port of stn_ext/src/extract.js (readCodeField and friends), which
 * runs its whole content script in the MAIN world. Ours cannot — the rest of
 * the extension needs chrome.* APIs, which only exist in the isolated world —
 * so the parts that genuinely need page-world access live here and answer
 * over shared DOM state.
 *
 * The four things a first attempt gets wrong, all of them learned from that
 * extension:
 *
 *   1. ANCHOR ON THE EDITOR, NOT THE FIELD. `.monaco-editor[data-uri]` is the
 *      thing Monaco knows about; the field container is a wrapper it has never
 *      heard of.
 *   2. MATCH EDITORS BOTH WAYS. getDomNode() may return the element, an
 *      ancestor of it, or a descendant — so containment is tested in both
 *      directions, with the model's `uri` against `data-uri` as a second route.
 *   3. WALK THE FIBER *UP*. React keeps the value on an ancestor component, not
 *      on the host node. Reading __reactProps$ off the element and its children
 *      — which is what I did before — looks in exactly the wrong direction.
 *   4. window.monaco IS NOT ALWAYS window.monaco. If the app never exported it,
 *      the window is scanned for something that quacks like the API.
 */

(function () {
  const REQUEST_ATTR = 'data-snorkelbot-monaco-request';
  const RESULT_ID = '__snorkelbot_monaco_result';

  const CONTENT_KEYS = ['value', 'defaultValue', 'code', 'content', 'text', 'summary', 'body'];
  const NOT_CONTENT =
    /^(class|className|id|key|style|theme|language|defaultLanguage|path|defaultPath|uri|type|name|label|title|placeholder|role|href|src|width|height|dir|lang|testid|data-testid)$/;

  // ------------------------------------------------------- monaco api ----

  let monacoCache;

  function quacks(m) {
    return !!(
      m &&
      m.editor &&
      (typeof m.editor.getModels === 'function' || typeof m.editor.getEditors === 'function')
    );
  }

  function monacoApi() {
    if (monacoCache !== undefined) return monacoCache;
    monacoCache = null;

    if (quacks(window.monaco)) {
      monacoCache = window.monaco;
      return monacoCache;
    }
    // Bundlers sometimes attach it under another name, or not at all.
    try {
      for (const key of Object.getOwnPropertyNames(window)) {
        if (/^\d+$/.test(key)) continue;
        if (['monaco', 'window', 'self', 'top', 'parent', 'frames', 'document'].includes(key)) continue;
        let value = null;
        try {
          value = window[key];
        } catch {
          continue;
        }
        if (value && typeof value === 'object' && quacks(value)) {
          monacoCache = value;
          break;
        }
      }
    } catch {
      // nothing that looks like Monaco
    }
    return monacoCache;
  }

  function valueFromMonacoApi(edEl) {
    const monaco = monacoApi();
    if (!monaco || !monaco.editor) return null;

    try {
      if (typeof monaco.editor.getEditors === 'function') {
        for (const editor of monaco.editor.getEditors()) {
          const dom = typeof editor.getDomNode === 'function' ? editor.getDomNode() : null;
          // Either direction: the editor's node may be the element, inside it,
          // or the thing that contains it.
          if (dom && (dom === edEl || edEl.contains(dom) || dom.contains(edEl))) {
            const model = typeof editor.getModel === 'function' ? editor.getModel() : null;
            if (model && typeof model.getValue === 'function') return model.getValue();
          }
        }
      }
    } catch {
      // fall through to the uri route
    }

    try {
      const uri = edEl.getAttribute('data-uri');
      if (uri && typeof monaco.editor.getModels === 'function') {
        for (const model of monaco.editor.getModels()) {
          if (String(model.uri) === uri) return model.getValue();
        }
      }
    } catch {
      // fall through
    }
    return null;
  }

  // ------------------------------------------------------ react fibers ----

  function reactFiber(node) {
    if (!node) return null;
    for (const key in node) {
      if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
        return node[key];
      }
    }
    return null;
  }

  /** Walks from the node towards the root, asking `pick` about each fiber's props. */
  function fiberFindUp(node, pick, maxUp = 30) {
    let fiber = reactFiber(node);
    let left = maxUp;
    while (fiber && left-- > 0) {
      const props = fiber.memoizedProps || fiber.pendingProps;
      if (props) {
        let got = null;
        try {
          got = pick(props);
        } catch {
          got = null;
        }
        if (got != null) return got;
      }
      fiber = fiber.return;
    }
    return null;
  }

  function looksLikeDocument(key, value) {
    if (typeof value !== 'string' || !value.trim()) return false;
    if (NOT_CONTENT.test(key)) return false;
    return value.indexOf('\n') >= 0 || value.length >= 40;
  }

  function valueFromReact(edEl) {
    const named = fiberFindUp(edEl, (props) => {
      for (const key of CONTENT_KEYS) {
        const value = props[key];
        if (typeof value === 'string' && value.trim()) return value;
      }
      return null;
    });
    if (named) return named;

    // Nothing under a familiar name: take anything that reads like a document.
    return fiberFindUp(edEl, (props) => {
      for (const key of Object.keys(props)) {
        if (looksLikeDocument(key, props[key])) return props[key];
      }
      return null;
    });
  }

  // ---------------------------------------------------------- fallbacks ----

  function realTextarea(container) {
    for (const ta of container.querySelectorAll('textarea')) {
      if (ta.classList.contains('ime-text-area')) continue;
      if (ta.getAttribute('aria-hidden') === 'true') continue;
      if (ta.readOnly) continue;
      return ta;
    }
    return null;
  }

  function read(testid) {
    const container = document.querySelector(`[data-testid="${testid}"]`);
    if (!container) return { text: null, via: 'not-found' };

    const edEl =
      container.querySelector('.monaco-editor[data-uri]') || container.querySelector('.monaco-editor');

    if (!edEl) {
      const ta = realTextarea(container);
      if (ta) return { text: ta.value, via: 'textarea' };
      const pre = container.querySelector('pre, code');
      if (pre) return { text: pre.innerText || pre.textContent || '', via: 'pre' };
      return { text: null, via: 'no-editor' };
    }

    const fromApi = valueFromMonacoApi(edEl);
    if (fromApi != null && fromApi.trim()) return { text: fromApi, via: 'monaco-model' };

    const fromReact = valueFromReact(edEl);
    if (fromReact != null && fromReact.trim()) return { text: fromReact, via: 'react-props' };

    // The isolated side will stitch the rendered lines instead.
    return { text: null, via: 'unavailable', monaco: Boolean(monacoApi()) };
  }

  // ------------------------------------------------------------ channel ----

  function publish(payload) {
    let node = document.getElementById(RESULT_ID);
    if (!node) {
      node = document.createElement('script');
      node.type = 'application/json';
      node.id = RESULT_ID;
      (document.documentElement || document).appendChild(node);
    }
    node.textContent = JSON.stringify(payload);
    window.dispatchEvent(new Event('snorkelbot:monaco-ready'));
  }

  window.addEventListener('snorkelbot:read-monaco', () => {
    const testid = document.documentElement.getAttribute(REQUEST_ATTR);
    if (!testid) return;
    try {
      publish({ testid, ...read(testid) });
    } catch (err) {
      publish({ testid, text: null, via: 'error', error: String(err && err.message) });
    }
  });
})();
