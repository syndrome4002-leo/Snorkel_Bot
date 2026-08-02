/* Sentinel Submission Helper - shared utilities.
 * Runs in the page's MAIN world so it can reach Monaco models, React fibers
 * and the TipTap editor instances. Everything hangs off window.__STN__.
 */
(function () {
  'use strict';
  const STN = window.__STN__ || (window.__STN__ = {});
  if (STN.util) return;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const raf = () => new Promise((r) => requestAnimationFrame(() => r()));

  /* ---------------------------------------------------------------- text */

  // Single line, whitespace collapsed, curly quotes and dashes folded.
  function normText(s) {
    return String(s == null ? '' : s)
      .replace(/\u00a0/g, ' ')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/[\u2013\u2014]/g, '-')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Comparison key for question / option labels. Drops the platform's
  // "(SEGMENTS)" and "[Duplicate]" prefixes, a trailing "(optional)" and
  // trailing punctuation, so the JSON label and the rendered label meet.
  function normLabel(s) {
    let t = normText(s).toLowerCase();
    t = t.replace(/^\[[^\]]*\]\s*/, '');
    t = t.replace(/^\([^)]*\)\s*/, '');
    t = t.replace(/\s*\(optional\)\s*$/, '');
    t = t.replace(/\s*\*+\s*$/, '');
    t = t.replace(/[\s:;.,]+$/, '');
    return t.trim();
  }

  // Multi line text kept intact: newlines preserved, trailing spaces dropped.
  function cleanBlock(s) {
    return String(s == null ? '' : s)
      .replace(/\r\n?/g, '\n')
      .replace(/\u00a0/g, ' ')
      .split('\n')
      .map((l) => l.replace(/[ \t]+$/, ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\n+/, '')
      .replace(/\s+$/, '');
  }

  // The platform stores some option labels as HTML inside aria-label.
  function stripTags(s) {
    return String(s == null ? '' : s)
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/p>/gi, ' ')
      .replace(/<[^>]*>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&');
  }

  /* ------------------------------------------------------------- matching */

  // 0 means "no match". Higher is better.
  function score(target, candidate) {
    const a = normLabel(target);
    const b = normLabel(candidate);
    if (!a || !b) return 0;
    if (a === b) return 1000;
    if (b.startsWith(a) || a.startsWith(b)) {
      return 900 - Math.min(89, Math.abs(a.length - b.length) / 4);
    }
    if (b.includes(a) || a.includes(b)) {
      return 800 - Math.min(89, Math.abs(a.length - b.length) / 4);
    }
    const ta = a.split(' ').filter(Boolean);
    const tb = b.split(' ').filter(Boolean);
    const sa = new Set(ta);
    const sb = new Set(tb);
    let inter = 0;
    sa.forEach((w) => { if (sb.has(w)) inter++; });
    const union = new Set([...sa, ...sb]).size;
    const jac = union ? inter / union : 0;
    return jac >= 0.65 ? Math.round(400 + jac * 300) : 0;
  }

  // Best match plus every other candidate that ties an exact hit.
  function bestMatches(target, candidates, getText) {
    const scored = candidates
      .map((c) => ({ item: c, s: score(target, getText(c)) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s);
    if (!scored.length) return [];
    const top = scored[0].s;
    if (top >= 1000) return scored.filter((x) => x.s >= 1000).map((x) => x.item);
    return [scored[0].item];
  }

  // Fixable / Invalid / Valid-as-is, whatever wording the JSON or page used.
  function canonVerdict(s) {
    const t = normText(s).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!t) return null;
    if (t.includes('validasis') || t.includes('validwithoutchanges')) return 'valid-as-is';
    if (t.includes('invalid') || t.includes('notfixable') || t.includes('unfixable')) return 'invalid';
    if (t.includes('fixable')) return 'fixable';
    return null;
  }

  /* ---------------------------------------------------------------- react */

  function reactFiber(node) {
    if (!node) return null;
    for (const k in node) {
      if (k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')) return node[k];
    }
    return null;
  }

  // Walk from a DOM node up the fiber tree, letting `pick` claim a value.
  function fiberFindUp(node, pick, maxUp) {
    let f = reactFiber(node);
    let n = typeof maxUp === 'number' ? maxUp : 30;
    while (f && n-- > 0) {
      const props = f.memoizedProps || f.pendingProps;
      if (props) {
        let got = null;
        try { got = pick(props, f); } catch (e) { got = null; }
        if (got != null) return got;
      }
      f = f.return;
    }
    return null;
  }

  /* ------------------------------------------------------------------ dom */

  function h(tag, attrs, children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v == null) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') {
          el.addEventListener(k.slice(2).toLowerCase(), v);
        } else el.setAttribute(k, String(v));
      }
    }
    if (children != null) {
      for (const c of [].concat(children)) {
        if (c == null || c === false) continue;
        el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      }
    }
    return el;
  }

  // Built node by node rather than through innerHTML, so a Trusted Types
  // policy on the page cannot block it.
  function svgIcon(d, size) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 256 256');
    svg.setAttribute('width', String(size || 14));
    svg.setAttribute('height', String(size || 14));
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
    return svg;
  }

  // Heading rule used by everything that copies a titled block out of the page.
  const MARKER = '#####################';

  // Solid triangles. A thin line arrow all but vanishes at this size.
  const ICONS = {
    up: 'M128,60L216,190H40Z',
    down: 'M128,196L40,66H216Z',
    // Six dots, the usual sign for something you can pick up and move. Drawn
    // fat on purpose: the stock icon's dots vanish at this button size.
    grip: 'M70,56a22,22,0,1,0,44,0a22,22,0,1,0,-44,0Z' +
      'M142,56a22,22,0,1,0,44,0a22,22,0,1,0,-44,0Z' +
      'M70,128a22,22,0,1,0,44,0a22,22,0,1,0,-44,0Z' +
      'M142,128a22,22,0,1,0,44,0a22,22,0,1,0,-44,0Z' +
      'M70,200a22,22,0,1,0,44,0a22,22,0,1,0,-44,0Z' +
      'M142,200a22,22,0,1,0,44,0a22,22,0,1,0,-44,0Z',
  };

  function visibleText(el) {
    if (!el) return '';
    const t = el.innerText != null ? el.innerText : el.textContent;
    return String(t == null ? '' : t);
  }

  function reveal(el) {
    if (!el || typeof el.scrollIntoView !== 'function') return;
    try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    catch (e) { try { el.scrollIntoView(); } catch (e2) { /* not scrollable */ } }
  }

  // Remember where every scroll container around an element is sitting, so an
  // action that has to touch many fields can put the view back afterwards.
  function scrollLock(anchor) {
    const entries = [];
    try {
      entries.push({ el: window, top: window.scrollY, left: window.scrollX });
      const doc = document.documentElement;
      if (doc) entries.push({ el: doc, top: doc.scrollTop, left: doc.scrollLeft });
      let n = anchor && anchor.parentElement;
      while (n && n !== doc) {
        const s = window.getComputedStyle(n);
        if (/(auto|scroll|overlay)/.test(s.overflowY + ' ' + s.overflowX)) {
          entries.push({ el: n, top: n.scrollTop, left: n.scrollLeft });
        }
        n = n.parentElement;
      }
    } catch (e) { /* nothing to remember */ }
    return {
      restore() {
        for (const e of entries) {
          try {
            if (e.el === window) window.scrollTo(e.left, e.top);
            else { e.el.scrollTop = e.top; e.el.scrollLeft = e.left; }
          } catch (err) { /* gone from the page */ }
        }
      },
    };
  }

  async function copyToClipboard(text) {
    const s = String(text == null ? '' : text);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(s);
        return true;
      }
    } catch (e) { /* fall through to the legacy path */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = s;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, s.length);
      const ok = document.execCommand('copy');
      ta.remove();
      return !!ok;
    } catch (e) {
      return false;
    }
  }

  STN.util = {
    sleep, raf,
    normText, normLabel, cleanBlock, stripTags,
    score, bestMatches, canonVerdict,
    reactFiber, fiberFindUp,
    h, visibleText, reveal, scrollLock, svgIcon, ICONS, MARKER, copyToClipboard,
  };
})();
