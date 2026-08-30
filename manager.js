/* Every note in one place: search, edit, recolour, rescope, delete, restore -
 * without visiting the sites they live on. All writes go through the service
 * worker, the same as the notes themselves. */

const $ = (id) => document.getElementById(id);

let notes = [];
let trash = [];
let filter = { kind: "all", host: null };   // all | site | trash
let editingId = null;
let paletteFor = null;

init();

async function init() {
  $("q").addEventListener("input", render);
  $("options").addEventListener("click", () => chrome.runtime.openOptionsPage());
  $("export").addEventListener("click", exportNotes);
  $("import").addEventListener("click", () => $("file").click());
  $("file").addEventListener("change", importNotes);
  $("wipeSite").addEventListener("click", wipeSite);

  chrome.storage.onChanged.addListener(() => load());
  await load();
}

const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);

/* Mutations refresh the page themselves rather than waiting on the storage
   event, so the view never lags behind a click. */
const apply = async (msg) => { const res = await send(msg); await load(); return res; };
const say = (text) => { $("say").textContent = text || ""; };

function load() {
  return new Promise((resolve) => {
    chrome.storage.local.get(null, (data) => {
      notes = [];
      trash = [];
      for (const [k, v] of Object.entries(data)) {
        if (!v || typeof v !== "object") continue;
        if (k.startsWith("n:")) notes.push(v);
        else if (k.startsWith("t:")) trash.push(v);
      }
      notes.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      trash.sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
      render();
      resolve();
    });
  });
}

/* ------------------------------------------------------------------ layout */

function render() {
  renderSites();
  renderNotes();
}

function hostCounts() {
  const counts = new Map();
  for (const n of notes) counts.set(n.host, (counts.get(n.host) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function renderSites() {
  const nav = $("sites");
  nav.textContent = "";

  nav.append(siteButton("Everything", notes.length, filter.kind === "all",
    () => { filter = { kind: "all", host: null }; render(); }));

  const counts = hostCounts();
  if (counts.length) nav.append(document.createElement("hr"));
  for (const [host, n] of counts) {
    nav.append(siteButton(host, n, filter.kind === "site" && filter.host === host,
      () => { filter = { kind: "site", host }; render(); }));
  }

  if (trash.length) {
    nav.append(document.createElement("hr"));
    nav.append(siteButton("Recently deleted", trash.length, filter.kind === "trash",
      () => { filter = { kind: "trash", host: null }; render(); }));
  }
}

function siteButton(label, count, current, onClick) {
  const b = document.createElement("button");
  b.className = "site-btn";
  b.type = "button";
  b.setAttribute("aria-current", String(!!current));
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = label;
  const n = document.createElement("span");
  n.className = "n";
  n.textContent = String(count);
  b.append(name, n);
  b.addEventListener("click", onClick);
  return b;
}

function visible() {
  const q = $("q").value.trim().toLowerCase();
  const pool = filter.kind === "trash" ? trash : notes;
  return pool.filter((n) => {
    if (filter.kind === "site" && n.host !== filter.host) return false;
    if (!q) return true;
    return (n.text || "").toLowerCase().includes(q) || (n.host || "").toLowerCase().includes(q);
  });
}

function renderNotes() {
  const list = $("list");
  list.textContent = "";

  const rows = visible();
  const trashed = filter.kind === "trash";

  $("heading").textContent =
    filter.kind === "site" ? filter.host : trashed ? "Recently deleted" : "Everything";
  $("summary").textContent = rows.length
    ? `${rows.length} note${rows.length === 1 ? "" : "s"}`
    : "";
  $("wipeSite").classList.toggle("hidden", filter.kind !== "site" || !rows.length);

  if (!rows.length) {
    list.append(emptyState());
    return;
  }
  for (const n of rows) list.append(card(n, trashed));
}

function emptyState() {
  const box = document.createElement("div");
  box.className = "empty-state";
  const head = document.createElement("strong");
  const rest = document.createElement("span");
  if ($("q").value.trim()) {
    head.textContent = "Nothing matches that";
    rest.textContent = "Try another word, or clear the search.";
  } else if (filter.kind === "trash") {
    head.textContent = "Nothing deleted recently";
    rest.textContent = "Deleted notes wait here for seven days.";
  } else {
    head.textContent = "No notes yet";
    rest.textContent = "Open a site, press Alt+Shift+N, and it will show up here.";
  }
  box.append(head, rest);
  return box;
}

/* ------------------------------------------------------------------- cards */

function card(n, trashed) {
  const colour = PALETTE[n.color] || PALETTE.yellow;
  const wrap = document.createElement("article");
  wrap.className = "card" + (trashed ? " trashed" : "");
  wrap.style.setProperty("--paper", colour.paper);
  wrap.style.setProperty("--bar", colour.bar);
  wrap.style.setProperty("--edge", colour.edge);
  wrap.style.setProperty("--ink", colour.ink);

  wrap.append(cardBar(n, trashed), cardBody(n, trashed), cardFoot(n, trashed));
  if (paletteFor === n.id && !trashed) wrap.insertBefore(swatchStrip(n), wrap.children[1]);
  return wrap;
}

function cardBar(n, trashed) {
  const bar = document.createElement("div");
  bar.className = "card-bar";

  const scope = document.createElement("button");
  scope.type = "button";
  scope.className = "tag" + (trashed ? " flat" : "");
  scope.textContent = n.scope === "page" ? "page" : "site";
  scope.disabled = trashed;
  scope.title = trashed ? "" : "Switch between this page only and the whole site";
  scope.addEventListener("click", () => {
    apply({ k: "patch", id: n.id, fields: { scope: n.scope === "page" ? "site" : "page" } });
  });

  const where = document.createElement("span");
  where.className = "where";
  where.textContent = n.scope === "page" ? pagePath(n) : n.host;
  where.title = n.page || n.host;

  bar.append(scope, where);

  if (trashed) {
    bar.append(
      mini("Restore", "↺", () => apply({ k: "restore", id: n.id })),
      mini("Delete forever", "×", async () => {
        await apply({ k: "purge", id: n.id });
        say("Deleted for good.");
      }, true)
    );
    return bar;
  }

  bar.append(
    mini("Open " + n.host, "↗", () => {
      chrome.tabs.create({ url: n.scope === "page" && n.page ? n.page : "https://" + n.host });
    }),
    mini("Change colour", "●", () => {
      paletteFor = paletteFor === n.id ? null : n.id;
      renderNotes();
    }),
    mini("Delete note", "×", async () => {
      await apply({ k: "trash", id: n.id });
      say("Moved to Recently deleted. Restore it from the left.");
    }, true)
  );
  return bar;
}

function mini(title, glyph, onClick, danger) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "mini" + (danger ? " danger" : "");
  b.textContent = glyph;
  b.title = title;
  b.setAttribute("aria-label", title);
  b.addEventListener("click", onClick);
  return b;
}

function swatchStrip(n) {
  const strip = document.createElement("div");
  strip.className = "swatch-strip";
  for (const name of COLOR_NAMES) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "swatch";
    b.style.background = PALETTE[name].paper;
    b.title = PALETTE[name].label;
    b.setAttribute("aria-label", PALETTE[name].label);
    b.setAttribute("aria-pressed", String(n.color === name));
    b.addEventListener("click", () => {
      paletteFor = null;
      apply({ k: "patch", id: n.id, fields: { color: name } });
    });
    strip.append(b);
  }
  return strip;
}

function cardBody(n, trashed) {
  const body = document.createElement("div");
  body.className = "card-body";

  if (editingId === n.id && !trashed) {
    const ta = document.createElement("textarea");
    ta.value = n.text;
    ta.setAttribute("aria-label", "Note text");
    ta.addEventListener("blur", () => {
      editingId = null;
      if (ta.value !== n.text) apply({ k: "patch", id: n.id, fields: { text: ta.value } });
      else renderNotes();
    });
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); editingId = null; renderNotes(); return; }
      if (e.key === "Enter" && !e.shiftKey && continueList(ta)) e.preventDefault();
      else if (e.key === "Tab" && indentList(ta, e.shiftKey)) e.preventDefault();
    });
    body.append(ta);
    queueMicrotask(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); });
    return body;
  }

  if (!n.text.trim()) {
    body.classList.add("empty");
    body.textContent = "Empty note";
  } else {
    body.append(renderMarkdown(n.text));
  }

  if (trashed) {
    body.style.cursor = "default";
    for (const box of body.querySelectorAll('input[type="checkbox"]')) box.disabled = true;
    return body;
  }

  /* Ticking a box here edits the note without opening the editor. */
  body.addEventListener("change", (e) => {
    if (!e.target.matches?.('input[type="checkbox"]')) return;
    apply({ k: "patch", id: n.id, fields: { text: toggleTask(n.text, Number(e.target.dataset.line)) } });
  });
  body.addEventListener("click", (e) => {
    if (e.target.closest('a, input[type="checkbox"]')) return;
    editingId = n.id;
    renderNotes();
  });
  return body;
}

function cardFoot(n, trashed) {
  const foot = document.createElement("div");
  foot.className = "card-foot";
  const when = document.createElement("span");
  when.textContent = trashed
    ? "deleted " + ago(n.deletedAt)
    : "edited " + ago(n.updatedAt);
  foot.append(when);
  if (!trashed && n.ghost) {
    const tag = document.createElement("span");
    tag.className = "tag flat";
    tag.textContent = "click-through";
    foot.append(tag);
  }
  return foot;
}

function pagePath(n) {
  try {
    const u = new URL(n.page);
    return u.hostname + (u.pathname === "/" ? "" : u.pathname);
  } catch {
    return n.host || "";
  }
}

function ago(ts) {
  if (!ts) return "";
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + "m ago";
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs + "h ago";
  const days = Math.round(hrs / 24);
  if (days < 30) return days + "d ago";
  return new Date(ts).toLocaleDateString();
}

/* -------------------------------------------------------------- bulk, data */

async function wipeSite() {
  const rows = visible();
  if (!rows.length) return;
  const ok = confirm(
    `Delete ${rows.length} note${rows.length === 1 ? "" : "s"} on ${filter.host}?\n\n` +
    "They go to Recently deleted and can be restored for seven days."
  );
  if (!ok) return;
  for (const n of rows) await apply({ k: "trash", id: n.id });
  say(`Moved ${rows.length} note${rows.length === 1 ? "" : "s"} to Recently deleted.`);
}

function exportNotes() {
  const blob = new Blob(
    [JSON.stringify({ sitenoted: 1, exportedAt: new Date().toISOString(), notes }, null, 2)],
    { type: "application/json" }
  );
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "sitenoted-" + new Date().toISOString().slice(0, 10) + ".json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  say(`Exported ${notes.length} note${notes.length === 1 ? "" : "s"}.`);
}

function importNotes(e) {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    let incoming = null;
    try {
      const parsed = JSON.parse(String(reader.result));
      incoming = Array.isArray(parsed) ? parsed : parsed?.notes;
    } catch { /* handled below */ }
    if (!Array.isArray(incoming)) return say("That file isn't a Sitenoted export.");
    const res = await apply({ k: "import", notes: incoming });
    say(`Imported ${res?.count || 0} note${res?.count === 1 ? "" : "s"}.`);
  };
  reader.readAsText(file);
}
