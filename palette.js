/* Shared note palette + text sizes. Loaded by note.html, popup.html, options.html. */
const PALETTE = {
  yellow: { label: "Yellow", paper: "#fdf3b0", bar: "#f6e785", edge: "#d9c24a", ink: "#453b12" },
  pink:   { label: "Pink",   paper: "#ffd8e4", bar: "#ffc3d5", edge: "#e79bb6", ink: "#4b1f31" },
  green:  { label: "Green",  paper: "#ccf3d4", bar: "#b2e9be", edge: "#7fca92", ink: "#14401f" },
  blue:   { label: "Blue",   paper: "#d3e7ff", bar: "#bcdaff", edge: "#8bbdee", ink: "#10314f" },
  purple: { label: "Purple", paper: "#e5dbff", bar: "#d6c8ff", edge: "#ab97e6", ink: "#291a4a" },
  orange: { label: "Orange", paper: "#ffdfc6", bar: "#ffceab", edge: "#f0ac7c", ink: "#4a2810" },
  slate:  { label: "Slate",  paper: "#e5ebf2", bar: "#d6dee7", edge: "#adbaca", ink: "#1e2733" }
};
const COLOR_NAMES = Object.keys(PALETTE);
const TEXT_SIZES = { s: "12px", m: "13.5px", l: "15.5px" };

/* Markdown markers read as noise in a one-line preview, so drop them. */
function stripMarks(text) {
  return String(text || "")
    .replace(/^\s*#{1,3}\s+/, "")
    .replace(/^\s*>\s?/, "")
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s*/, "")
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/^\s*\d{1,9}[.)]\s+/, "")
    .replace(/\[([^\]\n]*)\]\(([^)\s]+)\)/g, "$1")
    .replace(/(\*\*|__|~~|`)/g, "")
    .trim();
}

/* First non-blank line of a note, for previews. */
function firstLine(text, max) {
  const raw = (text || "").split("\n").find((s) => s.trim()) || "";
  const line = stripMarks(raw);
  if (!line) return "";
  return line.length > (max || 60) ? line.slice(0, max || 60) + "…" : line;
}
