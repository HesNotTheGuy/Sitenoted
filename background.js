/* Sitenoted service worker.
 *
 * This is the only writer to storage. Note frames, the popup and the options
 * page all send patches here, so two edits can never interleave into a
 * half-written note, and note text never has to travel through the renderer
 * process that hosts the web page.
 */

const NOTE = "n:";
const TRASH = "t:";
const SETTINGS = "settings";
const TRASH_TTL = 7 * 24 * 60 * 60 * 1000; // deleted notes stay recoverable for a week

const COLORS = ["yellow", "pink", "green", "blue", "purple", "orange", "slate"];
const DEFAULTS = {
  defaultColor: "yellow",
  defaultScope: "site",
  textSize: "m",
  fade: true
};

/* tabId -> { host, page } as reported by the content script. Collecting it this
   way means the extension never has to ask Chrome for anybody's tab URLs. */
const tabContext = new Map();

/* Serialise every read-modify-write so concurrent patches cannot clobber. */
let chain = Promise.resolve();
const serial = (fn) => (chain = chain.then(fn, fn));

const local = chrome.storage.local;
const get = (keys) => new Promise((r) => local.get(keys, r));
const set = (obj) => new Promise((r) => local.set(obj, r));
const del = (keys) => new Promise((r) => local.remove(keys, r));

const isColor = (c) => COLORS.includes(c);
const num = (v, fallback) => (typeof v === "number" && isFinite(v) ? Math.round(v) : fallback);

const matches = (n, ctx) =>
  !!n && !!ctx && (n.scope === "page" ? n.page === ctx.page : n.host === ctx.host);

/* What the content script is allowed to know: where a note sits, never its text. */
const geometryOf = (n) => ({
  id: n.id, x: n.x, y: n.y, w: n.w, h: n.h, collapsed: !!n.collapsed, z: n.z || 0
});

async function settings() {
  const data = await get(SETTINGS);
  return { ...DEFAULTS, ...(data[SETTINGS] || {}) };
}

async function allNotes() {
  const data = await get(null);
  const notes = [];
  for (const [k, v] of Object.entries(data)) {
    if (k.startsWith(NOTE) && v && typeof v === "object") notes.push(v);
  }
  return notes;
}

/* ------------------------------------------------------------------ writes */

async function createNote(ctx, opts) {
  const s = await settings();
  const now = Date.now();
  const note = {
    id: crypto.randomUUID(),
    host: ctx.host,
    page: ctx.page,
    scope: opts.scope === "page" || opts.scope === "site" ? opts.scope : s.defaultScope,
    text: typeof opts.text === "string" ? opts.text.slice(0, 20000) : "",
    color: isColor(opts.color) ? opts.color : s.defaultColor,
    x: num(opts.x, 24), y: num(opts.y, 24),
    w: num(opts.w, 260), h: num(opts.h, 200),
    collapsed: false,
    z: now,
    createdAt: now,
    updatedAt: now
  };
  await set({ [NOTE + note.id]: note });
  return note;
}

/* Only these fields may ever be written by a client. */
const WRITABLE = new Set(["text", "color", "collapsed", "scope", "page", "host", "x", "y", "w", "h", "z"]);

async function patchNote(id, fields) {
  const key = NOTE + id;
  const cur = (await get(key))[key];
  if (!cur) return null;
  const next = { ...cur };
  for (const [k, v] of Object.entries(fields || {})) {
    if (!WRITABLE.has(k)) continue;
    if (k === "text") next.text = String(v).slice(0, 20000);
    else if (k === "color") { if (isColor(v)) next.color = v; }
    else if (k === "scope") { if (v === "site" || v === "page") next.scope = v; }
    else if (k === "collapsed") next.collapsed = !!v;
    else if (k === "x" || k === "y" || k === "w" || k === "h" || k === "z") next[k] = num(v, next[k]);
    else next[k] = String(v);
  }
  next.updatedAt = Date.now();
  await set({ [key]: next });
  return next;
}

async function trashNote(id) {
  const key = NOTE + id;
  const note = (await get(key))[key];
  if (!note) return false;
  await set({ [TRASH + id]: { ...note, deletedAt: Date.now() } });
  await del(key);
  return true;
}

async function restoreNote(id) {
  const key = TRASH + id;
  const note = (await get(key))[key];
  if (!note) return null;
  delete note.deletedAt;
  note.updatedAt = Date.now();
  await set({ [NOTE + id]: note });
  await del(key);
  return note;
}

async function purgeTrash(id) {
  if (id) return del(TRASH + id);
  const data = await get(null);
  const stale = Object.entries(data)
    .filter(([k, v]) => k.startsWith(TRASH) && (!v?.deletedAt || Date.now() - v.deletedAt > TRASH_TTL))
    .map(([k]) => k);
  if (stale.length) await del(stale);
}

async function importNotes(list) {
  const payload = {};
  let n = 0;
  for (const note of Array.isArray(list) ? list : []) {
    if (!note || typeof note !== "object") continue;
    if (typeof note.text !== "string" || typeof note.host !== "string") continue;
    const id = typeof note.id === "string" && note.id ? note.id : crypto.randomUUID();
    payload[NOTE + id] = {
      id,
      host: String(note.host),
      page: String(note.page || ""),
      scope: note.scope === "page" ? "page" : "site",
      text: note.text.slice(0, 20000),
      color: isColor(note.color) ? note.color : "yellow",
      x: num(note.x, 24), y: num(note.y, 24),
      w: num(note.w, 260), h: num(note.h, 200),
      collapsed: !!note.collapsed,
      z: num(note.z, Date.now()),
      createdAt: num(note.createdAt, Date.now()),
      updatedAt: num(note.updatedAt, Date.now())
    };
    n++;
  }
  if (n) await set(payload);
  return n;
}

/* ------------------------------------------------------------------- badge */

async function updateBadge(tabId) {
  const ctx = tabContext.get(tabId);
  let count = 0;
  if (ctx) count = (await allNotes()).filter((n) => matches(n, ctx)).length;
  chrome.action.setBadgeBackgroundColor({ color: "#d9b400" }).catch(() => {});
  chrome.action.setBadgeTextColor?.({ color: "#3a2f00" })?.catch?.(() => {});
  chrome.action.setBadgeText({ tabId, text: count ? String(count) : "" }).catch(() => {});
}

/* ------------------------------------------------------------------ events */

chrome.runtime.onInstalled.addListener((details) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "sn-site", title: "Add note to this site", contexts: ["page", "selection"]
    });
    chrome.contextMenus.create({
      id: "sn-page", title: "Add note to this page only", contexts: ["page", "selection"]
    });
  });
  purgeTrash();
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("options.html#welcome") }).catch(() => {});
  }
});

chrome.runtime.onStartup.addListener(() => purgeTrash());

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  relay(tab.id, {
    k: "create-here",
    scope: info.menuItemId === "sn-page" ? "page" : "site",
    text: info.selectionText || ""
  });
});

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  if (command === "new-note") relay(tab.id, { k: "create-here" });
  if (command === "toggle-notes") relay(tab.id, { k: "toggle" });
});

chrome.tabs.onRemoved.addListener((tabId) => tabContext.delete(tabId));

/* Keep every open tab and the badge in step with whatever changed. */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const notesChanged = "settings" in changes || Object.keys(changes).some((k) => k.startsWith(NOTE));
  for (const tabId of tabContext.keys()) {
    updateBadge(tabId);
    if (notesChanged) relay(tabId, { k: "sync" });
  }
});

/* Messages arrive from the content script, note frames, the popup and options. */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  const reply = (work) => serial(() => work().then(sendResponse, () => sendResponse(null)));

  switch (msg?.k) {
    case "hello": {
      if (tabId) {
        tabContext.set(tabId, { host: String(msg.host || ""), page: String(msg.page || "") });
        updateBadge(tabId);
      }
      reply(async () => ({
        settings: await settings(),
        index: (await allNotes())
          .filter((n) => matches(n, tabContext.get(tabId)))
          .sort((a, b) => (a.z || 0) - (b.z || 0))
          .map(geometryOf)
      }));
      return true;
    }
    case "create": {
      /* The worker may have been restarted since the tab said hello, so trust
         the host/page the content script sends with the request. */
      const ctx = (tabId && tabContext.get(tabId)) ||
        (msg.host ? { host: String(msg.host), page: String(msg.page || "") } : null);
      if (!ctx) return false;
      if (tabId) tabContext.set(tabId, ctx);
      reply(async () => geometryOf(await createNote(ctx, msg)));
      return true;
    }
    case "patch":
      reply(async () => {
        const n = await patchNote(String(msg.id), msg.fields);
        return n ? geometryOf(n) : null;
      });
      return true;
    case "trash":
      reply(async () => ({ ok: await trashNote(String(msg.id)) }));
      return true;
    case "restore":
      reply(async () => {
        const n = await restoreNote(String(msg.id));
        return n ? geometryOf(n) : null;
      });
      return true;
    case "purge":
      reply(async () => {
        await purgeTrash(msg.id ? String(msg.id) : null);
        return { ok: true };
      });
      return true;
    case "purge-all":
      reply(async () => {
        const data = await get(null);
        await del(Object.keys(data).filter((k) => k.startsWith(NOTE) || k.startsWith(TRASH)));
        return { ok: true };
      });
      return true;
    case "import":
      reply(async () => ({ count: await importNotes(msg.notes) }));
      return true;
    case "settings":
      reply(async () => {
        if (msg.value) await set({ [SETTINGS]: { ...(await settings()), ...msg.value } });
        return settings();
      });
      return true;
    default:
      return false;
  }
});

/* A restarted service worker has forgotten which tab is on which site. Ask the
   content scripts to say hello again so badges and sync keep working. */
async function reconnect() {
  const tabs = await chrome.tabs.query({}).catch(() => []);
  for (const t of tabs) {
    if (t.id) chrome.tabs.sendMessage(t.id, { k: "sync" }).catch(() => {});
  }
}
reconnect();

/* Talk to a tab's content script, injecting it first if the tab predates us. */
async function relay(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      await chrome.tabs.sendMessage(tabId, message);
    } catch {
      /* restricted page (chrome://, Web Store, PDF viewer) - nothing to do */
    }
  }
}
