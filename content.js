/* Sitenoted content script - the page-side shell.
 *
 * Security model: this script only ever handles note *geometry*. Every note is
 * rendered inside an iframe served from the extension's own origin, so the note
 * text, the keystrokes that produce it, and the DOM around it are all out of
 * reach of the host page - no shadow root to pierce, no composed key events to
 * listen for, no same-origin document to read.
 *
 * Frame -> page messages are authenticated by event.source, which the browser
 * sets and a page cannot forge. Page -> frame messages carry a nonce the page
 * never sees, since it can read neither this isolated world nor the inside of
 * an extension frame.
 */
(() => {
  "use strict";
  if (window.__sitenoted) return;
  window.__sitenoted = true;

  const rand = (n) => {
    const a = new Uint8Array(n);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => b.toString(36).padStart(2, "0")).join("");
  };

  const NOTE_URL = chrome.runtime.getURL("note.html");
  const EXT_ORIGIN = new URL(NOTE_URL).origin;
  const LAYER_TAG = "sn" + rand(4);   // unpredictable, so pages can't target it in CSS
  const CARD_TAG = "sn" + rand(4);
  const COLLAPSED_H = 32;
  const MIN_W = 170;
  const MIN_H = 90;
  const EDGE = 56;                    // keep at least this much of a note on screen

  const cards = new Map();            // id -> card
  let settings = { fade: true };
  let hidden = false;
  let topZ = 0;
  let dragging = null;
  let layer = null;

  const pageUrl = () => location.origin + location.pathname;
  let currentPage = pageUrl();

  const alive = () => {
    try { return !!chrome.runtime?.id; } catch { return false; }
  };

  const ask = (msg) =>
    new Promise((resolve) => {
      if (!alive()) return resolve(null);
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          void chrome.runtime.lastError;
          resolve(res || null);
        });
      } catch { resolve(null); }
    });

  /* Inline !important beats any stylesheet the page can write, so a hostile or
     merely over-eager site cannot hide, shrink or recolour the notes. */
  function style(el, decls) {
    for (const [prop, value] of Object.entries(decls)) {
      if (el.style.getPropertyValue(prop) !== value ||
          el.style.getPropertyPriority(prop) !== "important") {
        el.style.setProperty(prop, value, "important");
      }
    }
  }

  const LAYER_STYLE = {
    position: "fixed", top: "0", left: "0", width: "100%", height: "100%",
    margin: "0", padding: "0", border: "0", "pointer-events": "none",
    "z-index": "2147483647", display: "block", visibility: "visible",
    opacity: "1", transform: "none", filter: "none", "color-scheme": "light",
    "max-width": "none", "max-height": "none"
  };

  function attachLayer() {
    const parent = document.body || document.documentElement;
    if (layer.parentNode !== parent) parent.appendChild(layer);
  }

  /* -------------------------------------------------------------- geometry */

  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));

  function place(geo) {
    const w = Math.max(MIN_W, geo.w);
    const h = geo.collapsed ? COLLAPSED_H : Math.max(MIN_H, geo.h);
    return {
      left: clamp(geo.x, -w + EDGE, innerWidth - EDGE),
      top: clamp(geo.y, 0, Math.max(0, innerHeight - COLLAPSED_H)),
      width: w,
      height: h
    };
  }

  function paint(card) {
    const p = place(card.geo);
    style(card.el, {
      position: "absolute",
      left: p.left + "px", top: p.top + "px",
      width: p.width + "px", height: p.height + "px",
      margin: "0", padding: "0", border: "0",
      "border-radius": "10px", overflow: "hidden",
      "box-shadow": "0 8px 24px rgba(15, 18, 25, .22), 0 1px 3px rgba(15, 18, 25, .18)",
      /* Ghosted notes stay visible but stop catching the pointer, so the page
         underneath behaves as though they are not there. */
      "pointer-events": hidden || card.geo.ghost ? "none" : "auto",
      display: hidden ? "none" : "block",
      visibility: "visible",
      transform: "none", filter: "none",
      "z-index": String(1 + (card.order || 0)),
      opacity: card.geo.ghost ? "0.4"
        : card.lit || card.focused || !settings.fade ? "1" : "0.62",
      transition: "opacity .14s ease"
    });
    style(card.frame, {
      width: "100%", height: "100%", display: "block",
      border: "0", margin: "0", padding: "0",
      background: "transparent", "color-scheme": "light"
    });
  }

  /* ----------------------------------------------------------------- cards */

  function mount(geo, focus) {
    const existing = cards.get(geo.id);
    if (existing) {
      existing.geo = geo;
      paint(existing);
      return existing;
    }

    const el = document.createElement(CARD_TAG);
    const frame = document.createElement("iframe");

    frame.setAttribute("title", "Sitenoted note");
    frame.setAttribute("allow", "");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.src = NOTE_URL + "#" + encodeURIComponent(geo.id);

    el.appendChild(frame);
    layer.appendChild(el);

    const card = {
      el, frame, geo,
      token: rand(16),
      ready: false,
      focusWanted: !!focus,
      focused: false,
      lit: false,
      order: ++topZ
    };
    cards.set(geo.id, card);

    el.addEventListener("pointerenter", () => setLit(card, true));
    el.addEventListener("pointerleave", () => setLit(card, false));

    paint(card);
    return card;
  }

  function unmount(id) {
    cards.get(id)?.el.remove();
    cards.delete(id);
  }

  function setLit(card, lit) {
    card.lit = lit;
    paint(card);
  }

  function toFrame(card, msg) {
    if (!card?.ready) return;
    try {
      card.frame.contentWindow?.postMessage({ ...msg, token: card.token }, EXT_ORIGIN);
    } catch { /* frame went away */ }
  }

  function raise(card) {
    if (card.order !== topZ) {
      card.order = ++topZ;
      paint(card);
      ask({ k: "patch", id: card.geo.id, fields: { z: Date.now() } });
    }
  }

  /* ------------------------------------------------------------- messaging */

  addEventListener("message", (e) => {
    if (e.origin !== EXT_ORIGIN || !e.data || typeof e.data !== "object") return;
    let card = null;
    for (const c of cards.values()) if (c.frame.contentWindow === e.source) { card = c; break; }
    if (!card) return;                // not one of ours - e.source cannot be forged
    const id = card.geo.id;
    const d = e.data;

    switch (d.t) {
      case "ready":
        card.ready = true;
        /* The frame runs on the extension origin and cannot see the page's URL,
           so it needs ours to pin itself here when you switch it to page scope. */
        toFrame(card, { t: "hello", host: location.hostname, page: currentPage });
        if (card.focusWanted) { card.focusWanted = false; toFrame(card, { t: "focus" }); }
        break;

      case "front":
        raise(card);
        break;

      case "focus":
        card.focused = true;
        raise(card);
        paint(card);
        break;

      case "blur":
        card.focused = false;
        paint(card);
        break;

      case "grab":
        raise(card);
        dragging = {
          id,
          mode: d.mode === "size" ? "size" : "move",
          ox: Number(d.sx) || 0,
          oy: Number(d.sy) || 0,
          start: { ...card.geo }
        };
        break;

      case "drag": {
        if (!dragging || dragging.id !== id) break;
        const dx = (Number(d.sx) || 0) - dragging.ox;
        const dy = (Number(d.sy) || 0) - dragging.oy;
        if (dragging.mode === "move") {
          card.geo.x = Math.round(dragging.start.x + dx);
          card.geo.y = Math.round(dragging.start.y + dy);
        } else {
          card.geo.w = Math.max(MIN_W, Math.round(dragging.start.w + dx));
          card.geo.h = Math.max(MIN_H, Math.round(dragging.start.h + dy));
        }
        paint(card);
        break;
      }

      case "drop": {
        if (!dragging || dragging.id !== id) break;
        dragging = null;
        const p = place(card.geo);
        card.geo.x = p.left;
        card.geo.y = p.top;
        paint(card);
        ask({
          k: "patch", id,
          fields: { x: card.geo.x, y: card.geo.y, w: card.geo.w, h: card.geo.h }
        });
        break;
      }

      case "collapsed":
        card.geo.collapsed = !!d.value;
        paint(card);
        break;

      case "ghost":
        card.geo.ghost = !!d.value;
        paint(card);
        break;

      case "closed":
        unmount(id);
        if (d.trashed) toast(id);
        break;
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg?.k) {
      case "create-here":
        create(msg.scope, msg.text);
        sendResponse({ ok: true });
        break;
      case "toggle":
        setHidden(msg.value === undefined ? !hidden : !!msg.value);
        sendResponse({ ok: true, hidden });
        break;
      case "state":
        sendResponse({ ok: true, hidden, count: cards.size });
        break;
      case "focus": {
        const card = cards.get(msg.id);
        if (card) {
          if (hidden) setHidden(false);
          if (card.geo.ghost) {
            card.geo.ghost = false;      // a ghost you cannot click needs a way back
            ask({ k: "patch", id: msg.id, fields: { ghost: false } });
            toFrame(card, { t: "unghost" });
            paint(card);
          }
          raise(card);
          toFrame(card, { t: "focus" });
          pulse(card);
        }
        sendResponse({ ok: !!card });
        break;
      }
      case "sync":
        sync();
        sendResponse({ ok: true });
        break;
      default:
        sendResponse({ ok: false });
    }
    return true;
  });

  /* --------------------------------------------------------------- actions */

  async function create(scope, text) {
    const step = (cards.size % 6) * 26;
    const w = 260;
    const geo = await ask({
      k: "create", scope, text,
      host: location.hostname, page: currentPage,
      x: Math.max(16, innerWidth - w - 28 - step),
      y: 26 + step,
      w, h: 200
    });
    if (!geo) return;
    if (hidden) setHidden(false);
    raise(mount(geo, true));
  }

  function setHidden(v) {
    hidden = v;
    for (const card of cards.values()) paint(card);
    if (hidden) hideToast();
  }

  function pulse(card) {
    card.el.animate?.(
      [{ transform: "scale(1)" }, { transform: "scale(1.04)" }, { transform: "scale(1)" }],
      { duration: 260, easing: "ease-out" }
    );
  }

  async function sync() {
    const res = await ask({ k: "hello", host: location.hostname, page: currentPage });
    if (!res) return;
    settings = res.settings || settings;
    const seen = new Set();
    for (const geo of res.index || []) {
      seen.add(geo.id);
      if (dragging?.id === geo.id) continue;      // don't fight the pointer
      mount(geo, false);
    }
    for (const id of [...cards.keys()]) if (!seen.has(id)) unmount(id);
  }

  /* ----------------------------------------------------------------- toast */

  let toastEl = null;
  let toastTimer = 0;

  function toast(id) {
    clearTimeout(toastTimer);
    if (!toastEl) {
      toastEl = document.createElement(CARD_TAG + "t");
      const label = document.createElement("span");
      label.textContent = "Note deleted";
      const undo = document.createElement("button");
      undo.type = "button";
      undo.textContent = "Undo";
      style(undo, {
        font: "600 12px/1 -apple-system, 'Segoe UI', Roboto, system-ui, sans-serif",
        background: "transparent", color: "#ffd977", border: "0", cursor: "pointer",
        padding: "4px 2px", margin: "0", "text-decoration": "underline"
      });
      undo.addEventListener("click", async () => {
        const noteId = toastEl.dataset.id;
        hideToast();
        const geo = await ask({ k: "restore", id: noteId });
        if (geo) raise(mount(geo, true));
      });
      toastEl.append(label, undo);
      layer.appendChild(toastEl);
    }
    toastEl.dataset.id = id;
    style(toastEl, {
      position: "absolute", right: "22px", bottom: "22px",
      display: "flex", "align-items": "center", gap: "10px",
      padding: "9px 14px", "border-radius": "9px",
      background: "#1f232b", color: "#e9ecf1",
      font: "13px/1.3 -apple-system, 'Segoe UI', Roboto, system-ui, sans-serif",
      "box-shadow": "0 8px 24px rgba(0,0,0,.32)",
      "pointer-events": "auto", "z-index": "2147483647",
      opacity: "1", visibility: "visible", transform: "none"
    });
    toastTimer = setTimeout(hideToast, 6000);
  }

  function hideToast() {
    clearTimeout(toastTimer);
    if (toastEl) style(toastEl, { display: "none" });
  }

  /* ------------------------------------------------------------- integrity */

  let checking = false;
  function check() {
    if (checking) return;
    checking = true;
    queueMicrotask(() => {
      checking = false;
      if (!layer) return;
      attachLayer();
      style(layer, LAYER_STYLE);
      for (const card of cards.values()) {
        if (card.el.parentNode !== layer) layer.appendChild(card.el);
        if (card.frame.parentNode !== card.el) card.el.appendChild(card.frame);
        const want = NOTE_URL + "#" + encodeURIComponent(card.geo.id);
        if (card.frame.getAttribute("src") !== want) card.frame.setAttribute("src", want);
        paint(card);
      }
    });
  }

  /* ---------------------------------------------------------------- wiring */

  layer = document.createElement(LAYER_TAG);
  style(layer, LAYER_STYLE);
  attachLayer();
  sync();

  new MutationObserver(check).observe(document.documentElement, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ["src", "style", "class", "hidden"]
  });

  addEventListener("resize", () => {
    for (const card of cards.values()) paint(card);
  });

  /* Notes are an overlay, not page content - keep them out of printouts. */
  addEventListener("beforeprint", () => layer && style(layer, { display: "none" }));
  addEventListener("afterprint", () => layer && style(layer, { display: "block" }));

  /* Single-page apps swap the URL without reloading. */
  setInterval(() => {
    const now = pageUrl();
    if (now === currentPage) return;
    currentPage = now;
    for (const card of cards.values()) toFrame(card, { t: "where", host: location.hostname, page: currentPage });
    sync();
  }, 700);
})();
