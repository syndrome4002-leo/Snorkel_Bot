/* Sentinel Submission Helper - the on page controls.
 * Everything lives in a shadow root and is built with DOM calls rather than
 * innerHTML, so the page's own styles and any Trusted Types policy stay out
 * of the way.
 */
(function () {
  "use strict";
  const STN = window.__STN__ || (window.__STN__ = {});
  if (STN.ui) return;
  const U = STN.util;
  const h = U.h;

  // Where the bar is allowed to show, matched against location.pathname.
  // Equivalent to https://experts.snorkel-ai.com/projects/<id>/*
  const SHOW_ON = /^\/projects\/1230ae8f-afc6-4705-abc7-fbe1c94250ff(\/|$)/;

  const POS_KEY = "stn-ext-bar-pos-v3";

  // How long a toast stays up. Something gone wrong is worth reading, so it
  // gets longer than a plain confirmation. Both are dismissible with the x.
  const TOAST_MS = { normal: 1200, alert: 2500 };

  const BUTTONS = [
    {
      key: "MOVE",
      icon: "grip",
      drag: true,
      name: "Move the bar",
      hint: "Drag this to put the bar somewhere else. Nothing else moves it.",
    },
    {
      key: "D",
      name: "Detail Copy",
      hint: "Copy the task detail panel as text",
      run: () => STN.actions.detailCopy(),
    },
    {
      key: "F",
      name: "Feedback Copy",
      hint: "Copy Difficulty Check, Agentic Judge, Oracle Check and Quality Check",
      run: () => STN.actions.feedbackCopy(),
    },
    // copying out, then putting things in
    { divider: true },
    {
      key: "A",
      name: "Answer Upload",
      hint: "Autofill the form from submission_answers json, verdict first",
      run: () => STN.actions.answerUpload(),
    },
    {
      key: "T",
      name: "Task Upload",
      hint: "Open the task zip uploader on this page",
      run: () => STN.actions.taskUpload(),
    },
    {
      key: "C",
      name: "Check Feedback",
      hint: "Press the page's own Check feedback button",
      run: () => STN.actions.checkFeedback(),
    },
    {
      key: "S",
      name: "Send to Reviewer",
      hint: "Scroll to Send to Reviewer and tick the checkbox",
      run: () => STN.actions.sendToReviewer(),
    },
    {
      key: "TOP",
      icon: "up",
      name: "Scroll to Top",
      hint: "Jump the form back to the first question",
      run: () => STN.actions.scrollToTop(),
    },
    {
      key: "END",
      icon: "down",
      name: "Scroll to Bottom",
      hint: "Jump the form down to the end of the form",
      run: () => STN.actions.scrollToBottom(),
    },
  ];

  const CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: ui-sans-serif, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
.root { position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;
  --ink: #34322c; --ink-dim: #6f6c64; --line: rgba(32,29,21,.14);
  --face: #f4f2ec; --face-hi: #e7e3d8; --surface: #fdfcfa; }

/* centred along the bottom, no offset and no padding around the group */
.layer { position: absolute; left: 50%; bottom: 0; transform: translateX(-50%);
  display: flex; flex-direction: column; align-items: center; }
.layer.free { transform: none; }
/* Toasts hang off the bar rather than sharing its column, so appearing and
   expiring can never shift the buttons out from under the pointer. */
.panels { position: absolute; left: 50%; transform: translateX(-50%);
  bottom: calc(100% + 8px);
  display: flex; flex-direction: column; align-items: center; gap: 8px;
  width: min(540px, calc(100vw - 24px)); }
.panels:empty { display: none; }
/* below the bar instead, once the bar itself is near the top of the window */
.layer.below .panels { bottom: auto; top: calc(100% + 8px); }

/* the big cards ignore where the bar is and sit in the middle of the view */
.centre { position: fixed; inset: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 10px; padding: 16px;
  pointer-events: none; }
.centre:empty { display: none; }
.centre > .card { pointer-events: auto; width: min(560px, calc(100vw - 32px));
  max-height: calc(100vh - 32px); display: flex; flex-direction: column; }
.centre > .card .body { max-height: none; flex: 1 1 auto; min-height: 0; }

.bar { pointer-events: auto; display: flex; flex-direction: row; align-items: center; gap: 10px;
  padding: 0; border-radius: 999px; background: rgba(253,252,250,.88);
  box-shadow: 0 1px 6px rgba(32,29,21,.10), 0 0 0 1px var(--line);
  backdrop-filter: blur(6px); user-select: none;
  opacity: .5; transition: opacity .15s ease; }
/* the whole group, buttons and their letters, lifts to solid on approach */
.bar:hover, .bar:focus-within, .bar.dragging { opacity: 1; }

.btn { pointer-events: auto; position: relative; width: 28px; height: 28px; flex: 0 0 28px;
  border-radius: 50%; border: 1px solid var(--line); background: var(--face);
  color: #45423a; font-size: 12px; font-weight: 650; line-height: 1; letter-spacing: .2px;
  display: inline-flex; align-items: center; justify-content: center; cursor: pointer;
  transition: background .12s ease, border-color .12s ease, color .12s ease; padding: 0; }
/* colour only on hover, no lift, so nothing shifts under the pointer */
.btn:hover { background: var(--face-hi); border-color: rgba(32,29,21,.26); color: #1f1d18; }
.btn:active { background: #ddd8cb; }
.btn:focus-visible { outline: 2px solid #8ab4f8; outline-offset: 1px; }
.btn.busy { background: #f7e0a8; border-color: #dfbc66; color: #5c4611; }
/* the two arrows carry the same face as the letters so they read as buttons */
.btn.nav { color: #3f3d36; }
.btn.nav svg { display: block; }
/* a hairline splitting what reads out of the page from what writes into it */
.sep { flex: 0 0 1px; width: 1px; height: 16px; border-radius: 1px;
  background: rgba(32,29,21,.22); }
/* the only handle that moves the bar, and as legible as the letters */
.btn.grip { cursor: grab; color: #45423a; }
.btn.grip:hover { color: #1f1d18; }
.btn.grip.dragging { cursor: grabbing; background: #ddd8cb; color: #1f1d18; }
.btn.grip svg { display: block; }

.tip { position: fixed; left: 0; top: 0; width: max-content;
  max-width: min(280px, calc(100vw - 20px)); text-align: left; line-height: 1.35;
  background: var(--surface); color: var(--ink-dim); border: 1px solid var(--line);
  padding: 5px 8px; border-radius: 7px; font-size: 10.5px;
  box-shadow: 0 4px 14px rgba(32,29,21,.16);
  opacity: 0; visibility: hidden; pointer-events: none;
  transform: translateY(2px); transition: opacity .12s ease, transform .12s ease; }
.tip.on { opacity: 1; visibility: visible; transform: translateY(0); }
.tip b { display: block; font-size: 11.5px; color: var(--ink); font-weight: 650; margin-bottom: 1px; }

.card { pointer-events: auto; background: var(--surface); color: var(--ink); border: 1px solid var(--line);
  border-radius: 10px; box-shadow: 0 6px 22px rgba(32,29,21,.16); font-size: 12px; overflow: hidden; width: 100%; }
.card .head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; background: rgba(32,29,21,.035);
  border-bottom: 1px solid var(--line); font-weight: 650; font-size: 12px; }
.card .head .grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card .body { padding: 9px 10px; max-height: 46vh; overflow: auto; }
.card .foot { display: flex; justify-content: flex-end; gap: 7px; padding: 8px 10px; border-top: 1px solid var(--line); }

.x { border: 0; background: transparent; color: var(--ink-dim); cursor: pointer; font-size: 14px; line-height: 1; padding: 2px 4px; border-radius: 5px; }
.x:hover { color: var(--ink); background: rgba(32,29,21,.07); }

.mini { border: 1px solid var(--line); background: var(--face); color: #45423a;
  border-radius: 6px; padding: 4px 10px; font-size: 11.5px; cursor: pointer; }
.mini:hover { background: var(--face-hi); }
.mini.primary { background: #2f6fd0; border-color: #2f6fd0; color: #fff; }
.mini.primary:hover { background: #2960b8; }

.toast { display: flex; gap: 7px; align-items: flex-start; padding: 8px 10px; line-height: 1.45; }
.toast .dot { width: 7px; height: 7px; border-radius: 50%; margin-top: 5px; flex: 0 0 7px; background: #9b978d; }
.toast.ok .dot { background: #2f9e5e; }
.toast.warn .dot { background: #d08700; }
.toast.error .dot { background: #d1453b; }
.toast.info .dot { background: #2f6fd0; }
.toast .msg { flex: 1; min-width: 0; word-break: break-word; }

.rows { display: flex; flex-direction: column; gap: 5px; }
.row { display: grid; grid-template-columns: 52px 1fr; gap: 8px; align-items: start;
  padding: 5px 6px; border-radius: 6px; background: rgba(32,29,21,.035); }
.pill { font-size: 9px; font-weight: 700; letter-spacing: .4px; text-transform: uppercase;
  padding: 3px 0; border-radius: 4px; text-align: center; color: #fff; }
.pill.ok { background: #2f9e5e; }
.pill.warn { background: #c07d00; }
.pill.fail { background: #d1453b; }
.pill.miss { background: #8a8780; }
.pill.manual { background: #2f6fd0; }
.row .q { font-weight: 600; color: var(--ink); line-height: 1.35; }
.row .d { color: var(--ink-dim); line-height: 1.4; margin-top: 2px; }

.summary { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 8px; }
.chip { font-size: 10.5px; padding: 3px 8px; border-radius: 999px; background: var(--face); border: 1px solid var(--line); }

textarea.dump { width: 100%; min-height: 210px; resize: vertical; background: #fbfaf7; color: #3a382f;
  border: 1px solid var(--line); border-radius: 7px; padding: 8px;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11px; line-height: 1.5; }

@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`;

  let host = null;
  let shadow = null;
  let panels = null;
  let centre = null;
  let layer = null;
  let root = null;
  let tipEl = null;
  let tipName = null;
  let tipHint = null;
  let moved = false;

  // Toasts hang off the bar, so once the bar is dragged into the top half of
  // the window they have to stack downwards or they leave the screen.
  function reflowToasts() {
    if (!layer) return;
    const bar = layer.querySelector(".bar");
    if (!bar) return;
    const rect = bar.getBoundingClientRect();
    const nearTop = rect.top + rect.height / 2 < window.innerHeight / 2;
    layer.classList.toggle("below", nearTop);
  }

  // One floating tooltip for all seven buttons, positioned against the
  // viewport rather than nested in the button, so nothing can clip it and a
  // long hint on the leftmost button cannot run off the edge of the screen.
  function showTip(btn, spec) {
    if (!tipEl) return;
    tipName.textContent = spec.name;
    tipHint.textContent = spec.hint;
    tipEl.classList.remove("on");
    // laid out but invisible, so it can be measured before it is placed
    const b = btn.getBoundingClientRect();
    const t = tipEl.getBoundingClientRect();
    const left = Math.max(
      8,
      Math.min(
        b.left + b.width / 2 - t.width / 2,
        window.innerWidth - t.width - 8,
      ),
    );
    const above = b.top - t.height - 8;
    tipEl.style.left = Math.round(left) + "px";
    tipEl.style.top = Math.round(above >= 8 ? above : b.bottom + 8) + "px";
    tipEl.classList.add("on");
  }

  function hideTip() {
    if (tipEl) tipEl.classList.remove("on");
  }

  function mount() {
    if (host && host.isConnected) return;
    host = document.createElement("div");
    host.id = "stn-ext-root";
    host.setAttribute("data-stn-ext", "1");
    shadow = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = CSS;
    shadow.appendChild(style);

    root = h("div", { class: "root" });
    layer = h("div", { class: "layer" });
    panels = h("div", { class: "panels" });
    const bar = h("div", { class: "bar" });

    tipName = h("b");
    tipHint = h("span");
    tipEl = h("div", { class: "tip", role: "tooltip" }, [tipName, tipHint]);

    BUTTONS.forEach((spec) => {
      if (spec.divider) {
        bar.appendChild(h("span", { class: "sep", "aria-hidden": "true" }));
        return;
      }
      const btn = h(
        "button",
        {
          type: "button",
          class: spec.drag ? "btn grip" : spec.icon ? "btn nav" : "btn",
          "data-key": spec.key,
          "aria-label": spec.name + ". " + spec.hint,
        },
        [
          spec.icon
            ? U.svgIcon(U.ICONS[spec.icon], spec.drag ? 16 : 12)
            : document.createTextNode(spec.key),
        ],
      );
      btn.addEventListener("pointerenter", () => showTip(btn, spec));
      btn.addEventListener("focus", () => showTip(btn, spec));
      btn.addEventListener("pointerleave", hideTip);
      btn.addEventListener("blur", hideTip);

      // The grip only moves the bar, so it gets no click behaviour at all.
      if (spec.drag) {
        makeDraggable(btn, bar);
        bar.appendChild(btn);
        return;
      }

      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        hideTip();
        btn.classList.add("busy");
        let done;
        try {
          done = spec.run();
        } catch (err) {
          toast(spec.name + " failed: " + err.message, "error");
        }
        Promise.resolve(done)
          .catch((err) =>
            toast(
              spec.name +
                " failed: " +
                (err && err.message ? err.message : err),
              "error",
            ),
          )
          .then(() => btn.classList.remove("busy"));
      });
      bar.appendChild(btn);
    });

    layer.appendChild(panels);
    layer.appendChild(bar);
    centre = h("div", { class: "centre" });
    root.appendChild(layer);
    root.appendChild(centre);
    root.appendChild(tipEl);
    shadow.appendChild(root);
    document.body.appendChild(host);
    restorePosition();
    keepOnScreen();

    // the tooltip is placed against the viewport, so anything that moves the
    // bar or the page invalidates it
    window.addEventListener("scroll", hideTip, true);
    window.addEventListener("resize", hideTip);
    window.addEventListener("resize", reflowToasts);
    window.addEventListener("resize", keepOnScreen);
    reflowToasts();
  }

  /* ----------------------------------------------------------- dragging */

  function savePosition(left, bottom) {
    try {
      localStorage.setItem(POS_KEY, JSON.stringify({ left: left, bottom: bottom }));
    } catch (e) { /* storage disabled */ }
  }

  // Put the bar back where it was left, then let keepOnScreen decide whether
  // that place still exists. A window that has since narrowed, or DevTools
  // opening, can leave a remembered position well outside the viewport.
  function restorePosition() {
    try {
      const raw = localStorage.getItem(POS_KEY);
      if (!raw) return;
      const p = JSON.parse(raw);
      if (typeof p.left === "number" && typeof p.bottom === "number") {
        // an explicit position replaces the centring transform
        layer.classList.add("free");
        layer.style.left = Math.max(0, p.left) + "px";
        layer.style.bottom = Math.max(0, p.bottom) + "px";
      }
    } catch (e) {
      /* first run */
    }
  }

  // The bar is no use where it cannot be seen, so drag it back into the
  // window whenever the window changes shape under it.
  function keepOnScreen() {
    if (!layer || !layer.classList.contains("free")) return;
    if (layer.querySelector(".dragging")) return;
    const rect = layer.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    const left = parseFloat(layer.style.left);
    const bottom = parseFloat(layer.style.bottom);
    const maxLeft = Math.max(0, window.innerWidth - rect.width);
    const maxBottom = Math.max(0, window.innerHeight - rect.height);
    const wantLeft = Math.min(maxLeft, Math.max(0, isNaN(left) ? 0 : left));
    const wantBottom = Math.min(maxBottom, Math.max(0, isNaN(bottom) ? 0 : bottom));

    if (wantLeft === left && wantBottom === bottom) return;
    layer.style.left = wantLeft + "px";
    layer.style.bottom = wantBottom + "px";
    savePosition(wantLeft, wantBottom);
  }

  // Forget the remembered spot and go back to centred along the bottom.
  function resetPosition() {
    mount();
    layer.classList.remove("free");
    layer.style.left = "";
    layer.style.bottom = "";
    try { localStorage.removeItem(POS_KEY); } catch (e) { /* storage disabled */ }
  }

  // Only the grip moves the bar. Every other button is a plain click target,
  // so nothing can be dragged out from under a press by accident.
  function makeDraggable(grip, bar) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let baseLeft = 0;
    let baseBottom = 0;

    grip.addEventListener("pointerdown", (e) => {
      hideTip();
      dragging = true;
      moved = false;
      grip.classList.add("dragging");
      bar.classList.add("dragging");
      try { grip.setPointerCapture(e.pointerId); } catch (err) { /* no capture */ }
      startX = e.clientX;
      startY = e.clientY;
      const rect = layer.getBoundingClientRect();
      baseLeft = rect.left;
      baseBottom = window.innerHeight - rect.bottom;
      e.preventDefault();
    });
    grip.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      // Nothing is repositioned until the pointer really travels, so a press
      // that turns out to be a click leaves the bar exactly where it was.
      if (Math.abs(dx) <= 3 && Math.abs(dy) <= 3) return;
      if (!moved) {
        moved = true;
        layer.classList.add("free");
        layer.style.left = baseLeft + "px";
        layer.style.bottom = baseBottom + "px";
      }
      const width = layer.getBoundingClientRect().width;
      const left = Math.min(
        Math.max(0, window.innerWidth - width),
        Math.max(0, baseLeft + dx),
      );
      const bottom = Math.min(
        window.innerHeight - 34,
        Math.max(0, baseBottom - dy),
      );
      layer.style.left = left + "px";
      layer.style.bottom = bottom + "px";
    });
    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      grip.classList.remove("dragging");
      bar.classList.remove("dragging");
      try {
        grip.releasePointerCapture(e.pointerId);
      } catch (err) {
        /* already gone */
      }
      // A press that never travelled leaves the bar untouched
      if (!moved) return;
      reflowToasts();
      savePosition(
        parseFloat(layer.style.left) || 0,
        parseFloat(layer.style.bottom) || 0,
      );
    };
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
  }

  /* ------------------------------------------------------------- toasts */

  function toast(message, kind, ttl) {
    mount();
    const k = kind || "info";
    const card = h("div", { class: "card" }, [
      h("div", { class: "toast " + k }, [
        h("span", { class: "dot" }),
        h("div", { class: "msg", text: String(message) }),
        h("button", {
          class: "x",
          type: "button",
          "aria-label": "Dismiss",
          text: "×",
          onClick: () => card.remove(),
        }),
      ]),
    ]);
    reflowToasts();
    panels.appendChild(card);
    const life =
      ttl != null
        ? ttl
        : TOAST_MS[k === "error" || k === "warn" ? "alert" : "normal"];
    let timer = null;
    if (life > 0) timer = setTimeout(() => card.remove(), life);
    return {
      close: () => {
        if (timer) clearTimeout(timer);
        card.remove();
      },
      node: card,
    };
  }

  function progress(message) {
    const t = toast(message, "info", 0);
    const msg = t.node.querySelector(".msg");
    return {
      update: (m) => {
        if (msg) msg.textContent = String(m);
      },
      close: t.close,
    };
  }

  /* ---------------------------------------------------------- text dump */

  function showText(title, text, note) {
    mount();
    const area = h("textarea", {
      class: "dump",
      readonly: "readonly",
      spellcheck: "false",
    });
    area.value = String(text == null ? "" : text);
    const card = h("div", { class: "card" }, [
      h("div", { class: "head" }, [
        h("span", { class: "grow", text: title }),
        h("button", {
          class: "x",
          type: "button",
          text: "×",
          onClick: () => card.remove(),
        }),
      ]),
      h("div", { class: "body" }, [
        note
          ? h("div", {
              style: { marginBottom: "8px", color: "#6f6c64" },
              text: note,
            })
          : null,
        area,
      ]),
      h("div", { class: "foot" }, [
        h("button", {
          class: "mini primary",
          type: "button",
          text: "Copy",
          onClick: async () => {
            area.select();
            const ok = await U.copyToClipboard(area.value);
            toast(
              ok
                ? "Copied."
                : "Still blocked. Select the text and press Ctrl+C.",
              ok ? "ok" : "warn",
            );
          },
        }),
        h("button", {
          class: "mini",
          type: "button",
          text: "Close",
          onClick: () => card.remove(),
        }),
      ]),
    ]);
    centre.appendChild(card);
    area.focus();
    area.select();
    return card;
  }

  /* ------------------------------------------------------ autofill report */

  function reportToText(res, filename) {
    const lines = ["Autofill report for " + filename];
    if (res.verdict) lines.push("Verdict: " + res.verdict);
    lines.push("");
    res.report.forEach((r) => {
      lines.push(
        "[" +
          r.status.toUpperCase() +
          "] " +
          r.label +
          (r.detail ? " - " + r.detail : ""),
      );
    });
    lines.push("");
    lines.push(
      "filled " +
        (res.counts.ok || 0) +
        ", warnings " +
        (res.counts.warn || 0) +
        ", failed " +
        (res.counts.fail || 0) +
        ", not on page " +
        (res.counts.miss || 0) +
        ", by hand " +
        (res.counts.manual || 0),
    );
    return lines.join("\n");
  }

  function showReport(res, filename) {
    mount();
    const c = res.counts;
    const chips = h("div", { class: "summary" }, [
      h("span", { class: "chip", text: "filled " + (c.ok || 0) }),
      c.warn ? h("span", { class: "chip", text: "warnings " + c.warn }) : null,
      c.fail ? h("span", { class: "chip", text: "failed " + c.fail }) : null,
      c.miss
        ? h("span", { class: "chip", text: "not on page " + c.miss })
        : null,
      c.manual
        ? h("span", { class: "chip", text: "by hand " + c.manual })
        : null,
    ]);

    const rows = h(
      "div",
      { class: "rows" },
      res.report.map((r) =>
        h("div", { class: "row" }, [
          h("div", { class: "pill " + r.status, text: r.status }),
          h("div", {}, [
            h("div", { class: "q", text: r.label }),
            r.detail ? h("div", { class: "d", text: r.detail }) : null,
          ]),
        ]),
      ),
    );

    const card = h("div", { class: "card" }, [
      h("div", { class: "head" }, [
        h("span", { class: "grow", text: "Autofill: " + filename }),
        h("button", {
          class: "x",
          type: "button",
          text: "×",
          onClick: () => card.remove(),
        }),
      ]),
      h("div", { class: "body" }, [chips, rows]),
      h("div", { class: "foot" }, [
        h("button", {
          class: "mini",
          type: "button",
          text: "Copy report",
          onClick: async () => {
            const ok = await U.copyToClipboard(reportToText(res, filename));
            toast(ok ? "Report copied." : "Copy blocked.", ok ? "ok" : "warn");
          },
        }),
        h("button", {
          class: "mini primary",
          type: "button",
          text: "Close",
          onClick: () => card.remove(),
        }),
      ]),
    ]);
    centre.appendChild(card);
    return card;
  }

  /* ----------------------------------------------------------- file pick */

  // Called straight from a click handler so the picker keeps the user gesture.
  function pickFile(accept, onFile) {
    const input = document.createElement("input");
    input.type = "file";
    if (accept) input.accept = accept;
    input.style.cssText =
      "position:fixed;top:-100px;left:-100px;width:1px;height:1px;opacity:0;";
    document.body.appendChild(input);
    input.addEventListener("change", () => {
      const file = input.files && input.files[0];
      input.remove();
      if (file) onFile(file);
    });
    input.addEventListener("cancel", () => input.remove());
    if (typeof input.showPicker === "function") {
      try {
        input.showPicker();
        return;
      } catch (e) {
        /* fall back */
      }
    }
    input.click();
  }

  /* ---------------------------------------------------------------- boot */

  // On the platform the bar steps aside where there is no submission form,
  // since a project listing has nothing for it to do. Anywhere else it stays
  // put, which is what makes it possible to check the panel on a test page.
  // The script is injected across the whole host, because Chrome only injects
  // on a real page load and the app routes client side. This is the one place
  // that decides where the bar is allowed to appear: change the project id
  // here, not in the manifest.
  function shouldShow() {
    if (!/(^|\.)experts\.snorkel-ai\.com$/i.test(location.hostname)) return true;
    return SHOW_ON.test(location.pathname);
  }

  function apply() {
    if (!host || !host.isConnected) mount();
    if (layer) layer.style.display = shouldShow() ? "" : "none";
    keepOnScreen();
  }

  function init() {
    mount();

    // A single page router changes the URL without a navigation, and the form
    // arrives well after load, so watch for both rather than poll slowly.
    let pending = 0;
    const bump = () => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = 0;
        apply();
      }, 200);
    };

    try {
      new MutationObserver(bump).observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
    } catch (e) { /* fall back to the interval below */ }

    window.addEventListener("popstate", bump);
    window.addEventListener("hashchange", bump);
    ["pushState", "replaceState"].forEach((name) => {
      const original = history[name];
      if (typeof original !== "function" || original.__stn) return;
      const wrapped = function () {
        const result = original.apply(this, arguments);
        bump();
        return result;
      };
      wrapped.__stn = true;
      history[name] = wrapped;
    });

    // backstop, in case the page swaps something the observer cannot see
    setInterval(apply, 2000);
    apply();
  }

  STN.ui = {
    init,
    mount,
    toast,
    progress,
    showText,
    showReport,
    pickFile,
    resetPosition,
    BUTTONS,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
