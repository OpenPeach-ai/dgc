// Shared numbered-list continuation for Work, ChatDGC and Pips. The caller inserts
// the result through its own composer history, so one undo removes the whole edit.
(function (root) {
  function continuation(value, start, end) {
    const text = String(value ?? "");
    if (!Number.isInteger(start) || start !== end || start < 0 || start > text.length) return "\n";
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    const lineEnd = text.indexOf("\n", start);
    if (lineEnd >= 0 && text.slice(start, lineEnd).trim()) return "\n";
    const match = text.slice(lineStart, start).match(/^([ \t]{0,8})(\d{1,6})([.)])([ \t]+)(\S[\s\S]*)$/);
    if (!match) return "\n";
    const next = Number(match[2]) + 1;
    return Number.isSafeInteger(next) ? `\n${match[1]}${next}${match[3]} ` : "\n";
  }
  root.DgcNumberedList = { continuation };
})(globalThis);
