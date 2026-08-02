/*
 * monaco-bridge.js — runs in the page's MAIN world, at document_start.
 *
 * The four check panes (Difficulty Check, Agentic Judge Quality Report, Oracle
 * Check, Quality Check) are Monaco editors, and Monaco only renders the lines
 * currently scrolled into view. Reading their DOM gives you whatever fits the
 * viewport, silently cut off — a long report comes back looking complete.
 *
 * The full text does exist, but only in the page's own JavaScript:
 *
 *   1. the Monaco model    editor.getModel().getValue()  — the real value
 *   2. the React props     the string the wrapper was handed
 *
 * Neither is reachable from a content script: isolated worlds get their own
 * view of JS objects, so window.monaco and the __reactProps$ expandos on the
 * DOM nodes simply are not there. Hence this file.
 *
 * Communication deliberately avoids passing objects between worlds, which is
 * where cross-world messaging gets fiddly. The request goes in an attribute and
 * the answer comes back as the text of a <script type="application/json">
 * element — both are DOM state, which the two worlds genuinely share.
 */

(function () {
  const REQUEST_ATTR = 'data-snorkelbot-monaco-request';
  const RESULT_ID = '__snorkelbot_monaco_result';

  function container(testid) {
    return document.querySelector(`[data-testid="${testid}"]`);
  }

  /** The value Monaco itself holds — complete regardless of what is on screen. */
  function fromMonacoModel(host) {
    const monaco = window.monaco;
    if (!monaco || !monaco.editor) return null;

    const editors =
      (typeof monaco.editor.getEditors === 'function' && monaco.editor.getEditors()) || [];
    for (const editor of editors) {
      try {
        const node =
          typeof editor.getContainerDomNode === 'function' ? editor.getContainerDomNode() : null;
        if (node && host.contains(node) && editor.getModel()) {
          return editor.getModel().getValue();
        }
      } catch {
        // a disposed editor; keep looking
      }
    }

    // No editor matched by container. Only fall back to a lone model — with
    // several panes on the page, guessing which one belongs here would be
    // worse than admitting defeat.
    const models = (typeof monaco.editor.getModels === 'function' && monaco.editor.getModels()) || [];
    if (models.length === 1) {
      try {
        return models[0].getValue();
      } catch {
        return null;
      }
    }
    return null;
  }

  /** The string React was handed, found by walking the fiber's props. */
  function fromReactProps(host) {
    const nodes = [host, ...host.querySelectorAll('*')];
    for (const node of nodes) {
      const key = Object.keys(node).find((k) => k.startsWith('__reactProps$'));
      if (!key) continue;
      const props = node[key];
      if (!props) continue;
      for (const name of ['value', 'defaultValue', 'code', 'text', 'content']) {
        const candidate = props[name];
        // Multi-line is the tell: a one-line string here is far more likely to
        // be a label or a placeholder than the pane's contents.
        if (typeof candidate === 'string' && candidate.includes('\n')) return candidate;
      }
    }
    return null;
  }

  function read(testid) {
    const host = container(testid);
    if (!host) return { text: null, via: 'not-found' };

    try {
      const model = fromMonacoModel(host);
      if (model != null && model !== '') return { text: model, via: 'monaco-model' };
    } catch (err) {
      // fall through to the next path
    }

    try {
      const props = fromReactProps(host);
      if (props) return { text: props, via: 'react-props' };
    } catch (err) {
      // fall through
    }

    // The content script will stitch the viewport instead.
    return { text: null, via: 'unavailable' };
  }

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
