/* Markdown for sticky notes: headings, bullets, numbers, checkboxes, emphasis,
 * code, links.
 *
 * Everything is built with createElement/textContent and never innerHTML, so a
 * note cannot inject markup or script no matter what it contains - there is no
 * sanitiser in the loop because nothing is ever parsed as HTML. Links are
 * limited to http, https and mailto.
 */

const SAFE_SCHEME = /^(?:https?:|mailto:)/i;
const INDENT_UNIT = 2;

/* A list line: indent, marker, and the text after it. */
const LIST_LINE = /^(\s*)((?:[-*+]\s+\[[ xX]\]\s?)|(?:[-*+]\s+)|(?:\d{1,9}[.)]\s+))(.*)$/;

const mk = (tag, text) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
};

const indentOf = (line) => {
  const spaces = /^[ \t]*/.exec(line)[0];
  return Math.floor((spaces.replace(/\t/g, "  ")).length / INDENT_UNIT);
};

/* ------------------------------------------------------------------ inline */

const INLINE =
  /(\*\*|__)(\S[\s\S]*?\S|\S)\1|(\*|_)(\S[\s\S]*?\S|\S)\3|~~(\S[\s\S]*?\S|\S)~~|`([^`]+)`|\[([^\]\n]*)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>[\]()]+)/g;

function linkNode(href, label, literal) {
  /* Anything outside http/https/mailto stays inert text, shown exactly as
     written so no part of the note silently disappears. */
  if (!SAFE_SCHEME.test(href)) return document.createTextNode(literal ?? label);
  const a = mk("a", label);
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}

function inline(text, parent, depth) {
  const source = String(text);
  const re = new RegExp(INLINE.source, "g");
  let last = 0;
  let m;

  while ((m = re.exec(source))) {
    /* Underscores inside a word (snake_case, file_name_here) are not emphasis. */
    if (m[3] === "_" || m[1] === "__") {
      const before = source[m.index - 1];
      const after = source[m.index + m[0].length];
      if (/\w/.test(before || "") || /\w/.test(after || "")) continue;
    }

    if (m.index > last) parent.append(source.slice(last, m.index));

    if (m[1]) parent.append(nest("strong", m[2], depth));
    else if (m[3]) parent.append(nest("em", m[4], depth));
    else if (m[5]) parent.append(nest("del", m[5], depth));
    else if (m[6] !== undefined) parent.append(mk("code", m[6]));
    else if (m[8]) parent.append(linkNode(m[8], m[7] || m[8], m[0]));
    else if (m[9]) parent.append(linkNode(m[9], m[9]));

    last = re.lastIndex;
  }
  if (last < source.length) parent.append(source.slice(last));
}

function nest(tag, text, depth) {
  const node = mk(tag);
  if ((depth || 0) < 4) inline(text, node, (depth || 0) + 1);
  else node.textContent = text;
  return node;
}

/* ------------------------------------------------------------------ blocks */

/* Returns a fragment. Every block carries data-line, the index of the source
   line it came from, so a click can put the caret back in the right place. */
function renderMarkdown(text) {
  const frag = document.createDocumentFragment();
  const lines = String(text ?? "").split("\n");
  const stack = [];                     // { list, indent, ordered }

  const closeTo = (indent) => {
    while (stack.length && stack[stack.length - 1].indent > indent) stack.pop();
  };
  const closeAll = () => { stack.length = 0; };

  lines.forEach((raw, i) => {
    const line = raw.replace(/\s+$/, "");

    if (!line.trim()) {
      closeAll();
      const gap = mk("div");
      gap.className = "md-gap";
      gap.dataset.line = i;
      frag.append(gap);
      return;
    }

    const rule = /^(?:---+|\*\*\*+|___+)$/.exec(line.trim());
    if (rule) {
      closeAll();
      const hr = mk("hr");
      hr.dataset.line = i;
      frag.append(hr);
      return;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line.trim());
    if (heading) {
      closeAll();
      const h = mk("h" + heading[1].length);
      h.dataset.line = i;
      inline(heading[2], h, 0);
      frag.append(h);
      return;
    }

    const quote = /^>\s?(.*)$/.exec(line.trim());
    if (quote) {
      closeAll();
      const q = mk("blockquote");
      q.dataset.line = i;
      inline(quote[1], q, 0);
      frag.append(q);
      return;
    }

    const list = LIST_LINE.exec(line);
    if (list) {
      const indent = indentOf(list[1]);
      const marker = list[2];
      const ordered = /^\d/.test(marker.trim());
      const task = /\[[ xX]\]/.test(marker);

      closeTo(indent);
      let top = stack[stack.length - 1];
      /* Switching between bullets and numbers at the same depth starts a new
         list beside the old one, rather than one inside it. */
      if (top && top.indent === indent && top.ordered !== ordered) {
        stack.pop();
        top = stack[stack.length - 1];
      }
      if (!top || top.indent < indent) {
        const listEl = mk(ordered ? "ol" : "ul");
        if (task) listEl.className = "md-tasks";
        const parentItem = top?.list.lastElementChild;
        if (top && parentItem) parentItem.append(listEl);   // nest under the item above
        else if (top) top.list.append(listEl);
        else frag.append(listEl);
        top = { list: listEl, indent, ordered };
        stack.push(top);
      }

      const li = mk("li");
      li.dataset.line = i;

      if (task) {
        li.className = "md-task";
        const box = mk("input");
        box.type = "checkbox";
        box.checked = /\[[xX]\]/.test(marker);
        box.dataset.line = i;
        box.setAttribute("aria-label", list[3] || "Task");
        const span = mk("span");
        span.className = "md-task-text";
        inline(list[3], span, 0);
        if (box.checked) li.classList.add("done");
        li.append(box, span);
      } else {
        inline(list[3], li, 0);
      }

      top.list.append(li);
      return;
    }

    closeAll();
    const p = mk("div");
    p.className = "md-line";
    p.dataset.line = i;
    inline(line, p, 0);
    frag.append(p);
  });

  return frag;
}

/* Flip the checkbox on one source line and hand back the new text. */
function toggleTask(text, lineIndex) {
  const lines = String(text ?? "").split("\n");
  const line = lines[lineIndex];
  if (line === undefined) return text;
  lines[lineIndex] = /\[[xX]\]/.test(line)
    ? line.replace(/\[[xX]\]/, "[ ]")
    : line.replace(/\[\s?\]/, "[x]");
  return lines.join("\n");
}

/* -------------------------------------------------------- editor behaviour */

/* Insert through execCommand where available so the browser's own undo stack
   keeps working; fall back to direct assignment. */
function replaceRange(ta, start, end, insert) {
  ta.focus();
  ta.setSelectionRange(start, end);
  let ok = false;
  try {
    ok = document.execCommand("insertText", false, insert);
  } catch { ok = false; }
  if (!ok) {
    ta.setRangeText(insert, start, end, "end");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

const lineBoundsAt = (value, pos) => {
  const start = value.lastIndexOf("\n", pos - 1) + 1;
  let end = value.indexOf("\n", pos);
  if (end === -1) end = value.length;
  return [start, end];
};

/* Enter inside a list continues it; Enter on an empty item ends it. */
function continueList(ta) {
  const { value, selectionStart: pos, selectionEnd: end } = ta;
  if (pos !== end) return false;
  const [start] = lineBoundsAt(value, pos);
  const line = value.slice(start, pos);
  const m = LIST_LINE.exec(line);
  if (!m) return false;

  const [, spaces, marker, rest] = m;
  if (!rest.trim()) {
    replaceRange(ta, start, pos, "");        // empty item - drop the marker
    return true;
  }

  let next;
  const ordered = /^(\d{1,9})([.)])/.exec(marker.trim());
  if (ordered) next = spaces + (Number(ordered[1]) + 1) + ordered[2] + " ";
  else next = spaces + marker.replace(/\[[xX]\]/, "[ ]");

  replaceRange(ta, pos, pos, "\n" + next);
  return true;
}

/* Tab indents a list item. Anywhere else Tab keeps its normal job of moving
   focus, which matters for keyboard users. */
function indentList(ta, outdent) {
  const { value, selectionStart: pos } = ta;
  const [start] = lineBoundsAt(value, pos);
  const line = value.slice(start, lineBoundsAt(value, pos)[1]);
  if (!LIST_LINE.test(line)) return false;

  if (outdent) {
    const lead = /^[ \t]{1,2}/.exec(line);
    if (!lead) return true;
    replaceRange(ta, start, start + lead[0].length, "");
  } else {
    replaceRange(ta, start, start, " ".repeat(INDENT_UNIT));
  }
  return true;
}

/* Ctrl/Cmd+B and Ctrl/Cmd+I wrap or unwrap the selection. */
function wrapSelection(ta, token) {
  const { value, selectionStart: s, selectionEnd: e } = ta;
  const picked = value.slice(s, e);
  if (!picked) return false;
  const n = token.length;
  const already = value.slice(s - n, s) === token && value.slice(e, e + n) === token;
  if (already) replaceRange(ta, s - n, e + n, picked);
  else replaceRange(ta, s, e, token + picked + token);
  return true;
}
