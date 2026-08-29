/* Sitenoted popup: add notes, find old ones, restore deletions, back up. */

const INJECTABLE = /^(https?|file):/;
const $ = (id) => document.getElementById(id);

let tab = null;
let ctx = null;          // { host, page } for the current tab, if it is a web page
let reachable = false;
let hidden = false;
let notes = [];
let trash = [];

init();

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || "";

  if (INJECTABLE.test(url)) {
    const u = new URL(url);
    ctx = { host: u.hostname, page: u.origin + u.pathname };
    $("host").textContent = u.hostname || u.protocol.replace(":", "");
  } else {
    $("host").textContent = "This page";
    for (const id of ["addSite", "addPage", "hide"]) $(id).disabled = true;
    warn("Notes can't run on browser pages like this one — open a website and try again.");
  }

  if (ctx) {
    const state = await ping();
    reachable = !!state;
    hidden = !!state?.hidden;
    $("hide").textContent = hidden ? "Show" : "Hide";
    if (!reachable) warn("Reload this tab once so Sitenoted can attach to it.");
  }

  $("addSite").addEventListener("click", () => add("site"));
  $("addPage").addEventListener("click", () => add("page"));
  $("hide").addEventListener("click", toggleHide);
  $("q").addEventListener("input", render);
  $("options").addEventListener("click", () => chrome.runtime.openOptionsPage());
  $("export").addEventListener("click", exportNotes);
  $("import").addEventListener("click", () => $("file").click());
  $("file").addEventListener("change", importNotes);

  chrome.storage.onChanged.addListener(load);
  load();
}

function warn(text) {
  $("warn").textContent = text;
  $("warn").classList.remove("hidden");
}

/* ------------------------------------------------------------- tab talking */

async function ping() {
  try {
    return await chrome.tabs.sendMessage(tab.id, { k: "state" });
  } catch {
    if (!INJECTABLE.test(tab?.url || "")) return null;
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      return await chrome.tabs.sendMessage(tab.id, { k: "state" });
    } catch {
      return null;
    }
  }
}

async function send(msg) {
  try { return await chrome.tabs.sendMessage(tab.id, msg); } catch { return null; }
}

async function add(scope) {
  if (!reachable) reachable = !!(await ping());
  await send({ k: "create-here", scope });
  window.close();
}

async function toggleHide() {
  const res = await send({ k: "toggle" });
  if (!res) return;
  hidden = res.hidden;
  $("hide").textContent = hidden ? "Show" : "Hide";
}

/* ------------------------------------------------------------------- data  */

function load() {
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
  });
}

const here = (n) => !!ctx && (n.scope === "page" ? n.page === ctx.page : n.host === ctx.host);

function render() {
  const q = $("q").value.trim().toLowerCase();
  const list = $("list");
  list.textContent = "";

  const hit = (n) =>
    !q || (n.text || "").toLowerCase().includes(q) || (n.host || "").toLowerCase().includes(q);

  const mine = notes.filter((n) => hit(n) && here(n));
  const others = notes.filter((n) => hit(n) && !here(n));
  const gone = trash.filter(hit);

  $("count").textContent = notes.length
    ? `${notes.length} note${notes.length === 1 ? "" : "s"}`
    : "";

  if (!mine.length && !others.length && !gone.length) {
    list.append(emptyState(q));
    return;
  }

  if (mine.length) {
    list.append(group("On this page", mine.length));
    mine.forEach((n) => list.append(item(n, "here")));
  }
  if (others.length) {
    list.append(group(mine.length ? "Elsewhere" : "All notes", others.length));
    others.forEach((n) => list.append(item(n, "away")));
  }
  if (gone.length) {
    list.append(group("Recently deleted", gone.length));
    gone.forEach((n) => list.append(item(n, "trash")));
  }
}

function emptyState(q) {
  const box = document.createElement("div");
  box.className = "empty-state";
  const head = document.createElement("strong");
  const rest = document.createElement("span");
  if (q) {
    head.textContent = "Nothing matches that";
    rest.textContent = "Try a different word, or clear the search.";
  } else {
    head.textContent = "No notes yet";
    rest.textContent = ctx
      ? "Add one to this site and it will be waiting the next time you visit."
      : "Open a website to start leaving notes.";
  }
  box.append(head, rest);
  return box;
}

function group(label, n) {
  const d = document.createElement("div");
  d.className = "group";
  d.setAttribute("role", "presentation");
  const t = document.createElement("span");
  t.textContent = label;
  const c = document.createElement("span");
  c.className = "muted";
  c.textContent = String(n);
  d.append(t, c);
  return d;
}

function item(n, kind) {
  const row = document.createElement("div");
  row.className = "item";
  row.setAttribute("role", "listitem");

  /* The row's main action and its delete/restore action are siblings, not
     nested buttons - nesting them would be invalid and unreachable by keyboard. */
  const open = document.createElement("button");
  open.type = "button";
  open.className = "open";
  open.title =
    kind === "here" ? "Jump to this note"
      : kind === "away" ? "Open " + n.host
        : "Deleted " + when(n.deletedAt) + " — use Restore to bring it back";

  const chip = document.createElement("span");
  chip.className = "chip";
  chip.style.background = (PALETTE[n.color] || PALETTE.yellow).paper;

  const body = document.createElement("span");
  body.className = "body";

  const text = document.createElement("span");
  const line = firstLine(n.text, 70);
  text.className = "text" + (line ? "" : " empty");
  text.textContent = line || "Empty note";

  const meta = document.createElement("span");
  meta.className = "meta";
  const tag = document.createElement("span");
  tag.className = "tag";
  tag.textContent = n.scope === "page" ? "page" : "site";
  meta.append(tag, document.createTextNode(
    (n.scope === "page" ? pagePath(n) : n.host) + " · " +
    (kind === "trash" ? "deleted " + when(n.deletedAt) : when(n.updatedAt))
  ));

  body.append(text, meta);

  const act = document.createElement("button");
  act.type = "button";
  act.className = "act" + (kind === "trash" ? " restore" : "");
  act.textContent = kind === "trash" ? "Restore" : "×";
  act.title = kind === "trash" ? "Restore this note" : "Delete this note";
  act.setAttribute("aria-label", (kind === "trash" ? "Restore note: " : "Delete note: ") +
    (firstLine(n.text, 40) || "empty note"));

  const fire = async (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (kind === "trash") {
      await chrome.runtime.sendMessage({ k: "restore", id: n.id });
    } else {
      await chrome.runtime.sendMessage({ k: "trash", id: n.id });
      notes = notes.filter((x) => x.id !== n.id);
      trash.unshift({ ...n, deletedAt: Date.now() });
      render();
    }
  };
  act.addEventListener("click", fire);

  open.disabled = kind === "trash";
  open.addEventListener("click", async () => {
    if (kind === "here") {
      await send({ k: "focus", id: n.id });
      window.close();
    } else if (kind === "away") {
      const url = n.scope === "page" && n.page ? n.page : "https://" + n.host;
      chrome.tabs.create({ url });
      window.close();
    }
  });

  open.append(chip, body);
  row.append(open, act);
  return row;
}

function pagePath(n) {
  try {
    const u = new URL(n.page);
    return u.hostname + (u.pathname === "/" ? "" : u.pathname);
  } catch {
    return n.host || "";
  }
}

function when(ts) {
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

/* ---------------------------------------------------------- backup/restore */

function exportNotes() {
  const payload = { sitenoted: 1, exportedAt: new Date().toISOString(), notes };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "sitenoted-" + new Date().toISOString().slice(0, 10) + ".json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
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
    if (!Array.isArray(incoming)) return warn("That file isn't a Sitenoted export.");
    const res = await chrome.runtime.sendMessage({ k: "import", notes: incoming });
    warn(`Imported ${res?.count || 0} note${res?.count === 1 ? "" : "s"}.`);
    load();
  };
  reader.readAsText(file);
}
