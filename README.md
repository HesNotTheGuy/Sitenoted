# Sitenoted

Sticky notes for any website. Leave a note on a page, and it's waiting there the
next time you visit — no account, no server, nothing leaves your browser.

## Install (Chrome, Edge, Brave, Opera)

1. Open `chrome://extensions` (Edge: `edge://extensions`).
2. Turn on **Developer mode**.
3. **Load unpacked** → select this folder.
4. Pin Sitenoted to the toolbar.

## Using it

| Action | How |
| --- | --- |
| New note on this site | Toolbar button, or <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>N</kbd> |
| New note on this URL only | Toolbar → **This page**, or right-click → *Add note to this page only* |
| Note from selected text | Select → right-click → *Add note to this site* |
| Move / resize | Drag the title bar; drag the corner grip |
| Colour | The dot in the title bar opens a swatch strip |
| Collapse | The `–` button, or double-click the title bar |
| Switch site ⇄ page | The `SITE` / `PAGE` chip in the title bar |
| Hide notes on this page | Toolbar → **Hide**, or <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>H</kbd> |
| Let clicks pass through | The `◐` button — the note goes faint and stops catching the pointer |
| Wake a click-through note | Toolbar popup → click it in the list |
| Find an old note | Toolbar → search box (searches every note) |
| Manage everything | Toolbar → **All notes** |
| Undo a delete | The **Undo** toast, or *Recently deleted* (kept 7 days) |
| Defaults, backup, wipe | Toolbar → **Settings** |

Notes save themselves as you type. A *site* note appears on every page of a
hostname; a *page* note only on that path (query strings and `#hashes` are
ignored, so `?page=2` is still the same page). Switching a note to page scope
pins it to the page you are looking at.

## Writing in a note

Notes are plain text with markdown, rendered when you step away and shown as
source when you click back in. Storage stays plain text, so search, export and
previews all keep working on exactly what you typed.

```
# Heading           - bullet            > quote
## Smaller          1. numbered         ---
**bold** *italic*   - [ ] to do         `code`
~~struck~~          - [x] done          [label](https://example.com)
```

Checkboxes are clickable in the rendered view — ticking one edits the line
behind it without opening the editor. While editing: **Enter** continues a list
and ends it on an empty item, **Tab**/**Shift+Tab** indent inside a list (and
move focus everywhere else), **Ctrl/Cmd+B** and **Ctrl/Cmd+I** wrap the
selection, **Esc** stops editing.

Links only become clickable for `http`, `https` and `mailto`. Anything else
stays inert text, shown exactly as written.

## Click-through notes

The `◐` button drops a note to 40% opacity and sets `pointer-events: none`, so
clicks land on the page underneath as though the note were not there. That also
means the note cannot be clicked to bring it back, which is deliberate — the
toolbar popup lists it with a **ghost** tag, and clicking it there wakes it.

## The All notes page

Toolbar → **All notes** opens a full page listing every note grouped by site,
without visiting any of them. Search across all notes, edit text in place, change
colour or scope, delete or restore, delete a whole site's worth at once, and
export or import backups.

## Security model

The threat this design takes seriously: **a website trying to read your notes.**

Each note is rendered inside an `<iframe>` served from the extension's own
origin. The note's text, DOM, and keystrokes therefore live in a different
origin *and* a different process from the page underneath. Specifically:

- **No shadow DOM to pierce.** An open `shadowRoot` is readable with one line of
  page script, and a closed one can be captured by hooking `Element.prototype.attachShadow`
  before the content script runs. Neither applies here.
- **No keystroke leakage.** `keydown`/`input` events are `composed: true`, so a
  note rendered in the page's own DOM would deliver every keystroke to any
  `document`-level listener the site installed. Typing inside the extension
  frame never reaches the page's event path at all.
- **The content script never handles note text.** It receives only geometry
  (`x, y, w, h, collapsed`) from the service worker. Note bodies travel between
  the service worker, note frames and the popup — all extension contexts.
- **Messages are authenticated.** Frame → page messages are checked against
  `event.source`, which the browser sets and a page cannot forge. Page → frame
  messages carry a nonce that only the content script's isolated world holds.
- **Layout is tamper-resistant.** Critical styles are set as inline `!important`
  (which outranks any author stylesheet), the wrapper elements get randomised
  tag names each page load, and a `MutationObserver` re-attaches or repairs
  anything the page removes or rewrites.

Known and accepted limits: a site can tell Sitenoted is installed (the frame's
`chrome-extension://` URL is in the DOM), can see where notes sit on screen, and
can cover them with its own elements — none of which exposes content. Storage is
`chrome.storage.local`, which is unencrypted on disk like all extension storage;
anyone with your unlocked OS profile can read it.

## Store submission notes

**Single purpose:** let a user attach personal notes to websites and see them
again on return.

**Permission justifications**

| Permission | Why |
| --- | --- |
| `storage` | Saves the notes. Local only. |
| `activeTab` | Injecting into the tab the user just invoked the extension on (toolbar, shortcut, context menu) when it was open before install. |
| `scripting` | The injection above, via `chrome.scripting.executeScript`. |
| `contextMenus` | The two right-click entries for creating notes. |
| Host access via `content_scripts: <all_urls>` | A note can be left on any site the user chooses; the extension can't know in advance which. |

Note there is **no `host_permissions` block and no `tabs` permission**. The
badge count works because content scripts report their own hostname, so the
extension never enumerates tab URLs.

**Also relevant to review:** no remote code (MV3 default CSP, everything
bundled), no network requests of any kind, no analytics, `"incognito": "split"`
so private-window notes stay separate. `PRIVACY.md` holds the disclosure text.

## Files

```
manifest.json    permissions, shortcuts, entry points
background.js    service worker: sole writer to storage, badge, menus, commands
content.js       page-side shell: positions note frames, relays drag, repairs tampering
note.html/css/js one note, inside an extension-origin iframe
markdown.js      markdown renderer (DOM nodes, never innerHTML) and editor keys
popup.*          toolbar panel: add, search, wake, restore
manager.*        the All notes page: every note, editable, grouped by site
options.*        settings and first-run welcome
ui.css           tokens shared by the extension pages
palette.js       note colours, text sizes, preview helpers
icons/           generated PNG icons
```

## License

Proprietary, all rights reserved — see [LICENSE](LICENSE). Not open source. This
keeps every option open: the copyright holder can relicense at any time, whereas
an open-source grant, once published, cannot be withdrawn for that version.

## Firefox

Two changes are needed: add `browser_specific_settings.gecko.id`, and swap the
service worker for `"background": { "scripts": ["background.js"] }`. Load it via
`about:debugging` → *This Firefox* → *Load Temporary Add-on*. Untested.
