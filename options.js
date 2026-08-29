/* Sitenoted settings page (also the first-run welcome). */

const $ = (id) => document.getElementById(id);
let settings = {};

init();

async function init() {
  if (location.hash === "#welcome") $("welcome").classList.remove("hidden");
  $("version").textContent = "v" + chrome.runtime.getManifest().version;

  buildColors();
  settings = (await chrome.runtime.sendMessage({ k: "settings" })) || {};
  paint();
  stats();

  bindSegment("scope", "defaultScope");
  bindSegment("size", "textSize");

  $("fade").addEventListener("change", () => save({ fade: $("fade").checked }));

  $("shortcuts").addEventListener("click", () => {
    chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  });

  $("export").addEventListener("click", exportNotes);
  $("import").addEventListener("click", () => $("file").click());
  $("file").addEventListener("change", importNotes);
  $("wipe").addEventListener("click", wipe);

  chrome.storage.onChanged.addListener(stats);
}

function buildColors() {
  for (const name of COLOR_NAMES) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "swatch";
    b.dataset.value = name;
    b.style.background = PALETTE[name].paper;
    b.title = PALETTE[name].label;
    b.setAttribute("aria-label", PALETTE[name].label);
    b.addEventListener("click", () => save({ defaultColor: name }));
    $("colors").append(b);
  }
}

function bindSegment(id, key) {
  for (const b of $(id).children) {
    b.addEventListener("click", () => save({ [key]: b.dataset.value }));
  }
}

async function save(patch) {
  settings = (await chrome.runtime.sendMessage({ k: "settings", value: patch })) || settings;
  paint();
}

function paint() {
  pressed("colors", settings.defaultColor);
  pressed("scope", settings.defaultScope);
  pressed("size", settings.textSize);
  $("fade").checked = settings.fade !== false;
}

function pressed(id, value) {
  for (const b of $(id).children) {
    b.setAttribute("aria-pressed", String(b.dataset.value === value));
  }
}

function say(text) {
  $("say").textContent = text;
}

/* --------------------------------------------------------------------- data */

function readAll() {
  return new Promise((resolve) => {
    chrome.storage.local.get(null, (data) => {
      const notes = [];
      const trash = [];
      for (const [k, v] of Object.entries(data)) {
        if (!v || typeof v !== "object") continue;
        if (k.startsWith("n:")) notes.push(v);
        else if (k.startsWith("t:")) trash.push(v);
      }
      resolve({ notes, trash });
    });
  });
}

async function stats() {
  const { notes, trash } = await readAll();
  const sites = new Set(notes.map((n) => n.host)).size;
  if (!notes.length) {
    $("stats").textContent = trash.length
      ? `No active notes. ${trash.length} in the recently-deleted list.`
      : "No notes yet.";
    return;
  }
  $("stats").textContent =
    `${notes.length} note${notes.length === 1 ? "" : "s"} across ` +
    `${sites} site${sites === 1 ? "" : "s"}` +
    (trash.length ? `, plus ${trash.length} recently deleted.` : ".");
}

async function exportNotes() {
  const { notes } = await readAll();
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
    const res = await chrome.runtime.sendMessage({ k: "import", notes: incoming });
    say(`Imported ${res?.count || 0} note${res?.count === 1 ? "" : "s"}.`);
    stats();
  };
  reader.readAsText(file);
}

async function wipe() {
  const { notes, trash } = await readAll();
  const total = notes.length + trash.length;
  if (!total) return say("There's nothing to delete.");
  const ok = confirm(
    `Delete all ${total} note${total === 1 ? "" : "s"}, including the recently-deleted list?\n\n` +
    "This can't be undone. Export a backup first if you might want them back."
  );
  if (!ok) return;
  await chrome.runtime.sendMessage({ k: "purge-all" });
  say("All notes deleted.");
  stats();
}
