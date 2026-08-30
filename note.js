/* One sticky note, running inside an extension-origin iframe.
 *
 * The page hosting this frame cannot read anything below: not the text, not the
 * DOM, not the keystrokes. All writes go through the service worker so two
 * windows editing the same note can't overwrite each other. */

const ID = decodeURIComponent(location.hash.slice(1));

const el = {
  body: document.body,
  note: document.getElementById("note"),
  bar: document.getElementById("barMain"),
  confirmBar: document.getElementById("barConfirm"),
  scope: document.getElementById("scope"),
  peek: document.getElementById("peek"),
  color: document.getElementById("color"),
  swatches: document.getElementById("swatches"),
  ghost: document.getElementById("ghost"),
  fold: document.getElementById("fold"),
  del: document.getElementById("del"),
  cancel: document.getElementById("cancel"),
  confirm: document.getElementById("confirm"),
  text: document.getElementById("text"),
  rendered: document.getElementById("rendered"),
  grip: document.getElementById("grip")
};

let note = null;
let parentToken = null;
let here = null;          // the host/page this frame is currently displayed on
let editing = true;       // read view shows rendered markdown, edit view the source
let saveTimer = 0;
let pending = {};         // fields waiting to be written, so a fast second edit
                          // never cancels the first one's save
let mine = null;          // signature of our last write, so our own echo is ignored

const send = (msg) =>
  new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => { void chrome.runtime.lastError; resolve(res || null); });
    } catch { resolve(null); }
  });

const tell = (msg) => {
  try { parent.postMessage(msg, "*"); } catch { /* detached */ }
};

/* --------------------------------------------------------------- rendering */

function applyColor(name) {
  const c = PALETTE[name] || PALETTE.yellow;
  const root = document.documentElement.style;
  root.setProperty("--paper", c.paper);
  root.setProperty("--bar", c.bar);
  root.setProperty("--edge", c.edge);
  root.setProperty("--ink", c.ink);
  for (const b of el.swatches.children) {
    b.setAttribute("aria-pressed", String(b.dataset.color === name));
  }
}

function render() {
  if (!note) return;
  applyColor(note.color);
  el.body.classList.toggle("collapsed", !!note.collapsed);
  el.fold.textContent = note.collapsed ? "+" : "–";
  el.fold.setAttribute("aria-label", note.collapsed ? "Expand note" : "Collapse note");
  el.scope.textContent = note.scope === "page" ? "page" : "site";
  el.scope.title = note.scope === "page"
    ? "On this page only. Click to show it on every page of " + note.host
    : "On every page of " + note.host + ", click to pin it to this page only";
  el.peek.textContent = note.collapsed ? (firstLine(note.text, 48) || "Empty note") : "";
  el.ghost.setAttribute("aria-pressed", String(!!note.ghost));
  el.ghost.title = note.ghost
    ? "Click-through is on. Wake this note from the toolbar popup"
    : "Let clicks pass through to the page (wake it again from the popup)";
  if (document.activeElement !== el.text && el.text.value !== note.text) {
    el.text.value = note.text;
  }
  paintBody();
}

/* An empty note has nothing to render, so it always opens ready to type. */
function paintBody() {
  const showSource = editing || !note.text.trim();
  el.text.hidden = !showSource;
  el.rendered.hidden = showSource;
  if (!showSource) {
    el.rendered.textContent = "";
    el.rendered.append(renderMarkdown(note.text));
  }
}

function setEditing(on, caretAt) {
  editing = !!on;
  paintBody();
  if (!editing) return;
  el.text.focus();
  if (typeof caretAt === "number") el.text.setSelectionRange(caretAt, caretAt);
}

/* Where in the source does the block you clicked start? */
function caretForClick(target) {
  const block = target.closest?.("[data-line]");
  if (!block) return el.text.value.length;
  const index = Number(block.dataset.line);
  const lines = note.text.split("\n");
  if (!isFinite(index) || index < 0 || index >= lines.length) return el.text.value.length;
  let offset = 0;
  for (let i = 0; i < index; i++) offset += lines[i].length + 1;
  return offset + lines[index].length;
}

function buildSwatches() {
  for (const name of COLOR_NAMES) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "swatch";
    b.dataset.color = name;
    b.style.background = PALETTE[name].paper;
    b.title = PALETTE[name].label;
    b.setAttribute("aria-label", PALETTE[name].label);
    b.addEventListener("click", () => {
      patch({ color: name });
      note.color = name;
      render();
      toggleSwatches(false);
      if (editing) el.text.focus();
    });
    el.swatches.append(b);
  }
}

function toggleSwatches(open) {
  const show = open === undefined ? el.swatches.hidden : open;
  el.swatches.hidden = !show;
  el.color.setAttribute("aria-expanded", String(show));
}

/* ----------------------------------------------------------------- storage */

/* Only the fields a note can actually differ by - updatedAt always changes, so
   comparing whole records would never recognise our own write coming back. */
const signature = (n) =>
  JSON.stringify([n.text, n.color, !!n.collapsed, n.scope, n.page, n.host]);

function patch(fields, immediate) {
  if (!note) return;
  Object.assign(note, fields);
  Object.assign(pending, fields);
  mine = signature(note);
  clearTimeout(saveTimer);
  if (immediate) write();
  else saveTimer = setTimeout(write, 300);
}

function write() {
  clearTimeout(saveTimer);
  const fields = pending;
  pending = {};
  if (Object.keys(fields).length) send({ k: "patch", id: ID, fields });
}

function flush() {
  if (!note) return;
  if (el.text.value !== note.text) {
    note.text = el.text.value;
    pending.text = note.text;
    mine = signature(note);
  }
  write();
}

async function load() {
  const key = "n:" + ID;
  const data = await new Promise((r) => chrome.storage.local.get([key, "settings"], r));
  note = data[key];
  const settings = data.settings || {};
  document.documentElement.style.setProperty("--tsize", TEXT_SIZES[settings.textSize] || TEXT_SIZES.m);
  if (!note) { tell({ t: "closed" }); return; }
  editing = !note.text.trim();
  render();
  tell({ t: "ready" });
  tell({ t: "collapsed", value: !!note.collapsed });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.settings) {
    const s = changes.settings.newValue || {};
    document.documentElement.style.setProperty("--tsize", TEXT_SIZES[s.textSize] || TEXT_SIZES.m);
  }
  const change = changes["n:" + ID];
  if (!change) return;
  if (!change.newValue) { tell({ t: "closed" }); return; }
  if (signature(change.newValue) === mine) return;            // our own write coming back
  const typing = document.activeElement === el.text;
  note = change.newValue;
  if (typing) note.text = el.text.value;                      // never yank the caret's text
  render();
});

/* ------------------------------------------------------------ interactions */

el.text.addEventListener("input", () => patch({ text: el.text.value }));
el.text.addEventListener("blur", () => {
  flush();
  setEditing(false);          // stepping away renders what you wrote
});

el.text.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { e.preventDefault(); flush(); el.text.blur(); return; }

  if (e.key === "Enter" && !e.shiftKey && continueList(el.text)) {
    e.preventDefault();
    return;
  }
  /* Tab only belongs to the note while you are inside a list; everywhere else
     it has to keep moving focus for keyboard users. */
  if (e.key === "Tab" && indentList(el.text, e.shiftKey)) {
    e.preventDefault();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    const token = e.key === "b" ? "**" : e.key === "i" ? "*" : null;
    if (token && wrapSelection(el.text, token)) e.preventDefault();
  }
});

el.note.addEventListener("mousedown", (e) => {
  tell({ t: "front" });
  if (!el.swatches.hidden && !e.target.closest(".swatches, #color")) toggleSwatches(false);
});

/* Ticking a box in the read view edits the source line behind it, without
   dropping you into the editor. */
el.rendered.addEventListener("change", (e) => {
  const box = e.target;
  if (!box.matches?.('input[type="checkbox"]')) return;
  const next = toggleTask(note.text, Number(box.dataset.line));
  el.text.value = next;
  patch({ text: next }, true);
  render();
});

/* Clicking the paper starts typing, with the caret on the line you clicked.
   Links and checkboxes keep their own behaviour. */
el.rendered.addEventListener("click", (e) => {
  if (e.target.closest('a, input[type="checkbox"]')) return;
  setEditing(true, caretForClick(e.target));
});

el.rendered.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target === el.rendered) {
    e.preventDefault();
    setEditing(true);
  }
});

el.note.addEventListener("click", (e) => {
  if (note && !note.collapsed && e.target === el.note) setEditing(true);
});

addEventListener("focus", () => tell({ t: "focus" }), true);
addEventListener("blur", () => tell({ t: "blur" }), true);

el.scope.addEventListener("click", () => {
  const next = note.scope === "page" ? "site" : "page";
  /* Re-anchor to wherever you are now: switching to page scope should pin the
     note to the page in front of you, not the one it was first created on. */
  patch({
    scope: next,
    page: here?.page || note.page,
    host: here?.host || note.host
  }, true);
  render();
});

el.color.addEventListener("click", () => toggleSwatches());

/* Ghosting hands the pointer back to the page, so this note can no longer be
   clicked at all. The popup is the way back, which the title says out loud. */
el.ghost.addEventListener("click", () => {
  const on = !note.ghost;
  flush();
  patch({ ghost: on }, true);
  if (on) setEditing(false);
  render();
  tell({ t: "ghost", value: on });
});

el.fold.addEventListener("click", () => {
  const collapsed = !note.collapsed;
  toggleSwatches(false);
  patch({ collapsed }, true);
  render();
  tell({ t: "collapsed", value: collapsed });
});

el.del.addEventListener("click", () => {
  if (!el.text.value.trim()) return remove(true); // nothing to lose, just go
  el.body.classList.add("confirming");
  el.confirmBar.hidden = false;
  el.confirm.focus();
});

el.cancel.addEventListener("click", closeConfirm);
el.confirm.addEventListener("click", () => remove(false));

addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !el.confirmBar.hidden) closeConfirm();
});

function closeConfirm() {
  el.body.classList.remove("confirming");
  el.confirmBar.hidden = true;
  (editing ? el.text : el.rendered).focus();
}

async function remove(quiet) {
  clearTimeout(saveTimer);
  pending = {};
  await send({ k: "trash", id: ID });
  tell({ t: "closed", trashed: !quiet });   // an empty note doesn't need an undo prompt
}

/* Dragging and resizing happen out here in the frame, but the note is
   positioned by the content script, so we report screen-space deltas: they are
   unaffected by the frame moving underneath the pointer. */
function dragSource(handle, mode) {
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest("button")) return;
    e.preventDefault();
    try { handle.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    tell({ t: "grab", mode, sx: e.screenX, sy: e.screenY });

    const move = (ev) => tell({ t: "drag", mode, sx: ev.screenX, sy: ev.screenY });
    const up = () => {
      removeEventListener("pointermove", move, true);
      removeEventListener("pointerup", up, true);
      removeEventListener("pointercancel", up, true);
      tell({ t: "drop" });
    };
    addEventListener("pointermove", move, true);
    addEventListener("pointerup", up, true);
    addEventListener("pointercancel", up, true);
  });
}

dragSource(el.bar, "move");
dragSource(el.grip, "size");

el.bar.addEventListener("dblclick", (e) => {
  if (!e.target.closest("button")) el.fold.click();
});

/* Messages from the content script. The nonce is handed over on the first
   message and never appears anywhere the page can read. */
addEventListener("message", (e) => {
  const d = e.data;
  if (!d || typeof d !== "object") return;
  if (d.t === "hello") {
    parentToken = parentToken || d.token;
    here = { host: d.host, page: d.page };
    return;
  }
  if (!parentToken || d.token !== parentToken) return;
  if (d.t === "where") { here = { host: d.host, page: d.page }; return; }
  if (d.t === "unghost") {
    if (note) { note.ghost = false; render(); }
    return;
  }
  if (d.t === "focus") {
    if (note?.collapsed) el.fold.click();
    setEditing(true, el.text.value.length);
  }
});

addEventListener("pagehide", flush);
document.addEventListener("visibilitychange", () => { if (document.hidden) flush(); });

buildSwatches();
load();
