// What a paste becomes, for every prompt box in the editor (Work, ChatDGC, Pips). Two jobs:
//
//   1. It keeps the shape the text was copied with. A browser's plain text drops every list marker
//      (Chromium writes "Install the package", not "1. Install the package"), while the same copy's
//      HTML still has them. The plain text stays the source of every character; the HTML only adds
//      the markers and nesting it lost, as plain text, never as rich formatting.
//   2. It takes out the invisible characters, and says how many.
//
// The invisible-character rules mirror dgc/textsafety.py, deliberately: the panel, the terminal and
// the backend must give one answer. tests/test_invisible_characters.py and
// test/paste-clean.test.mjs both hold them to tests/fixtures/invisible_characters.json, and the
// Python test also runs this file against random text. Change a rule in both, in the same commit.
(function (root) {
  const OVERRIDES = new Set([0x202A, 0x202B, 0x202C, 0x202D, 0x202E, 0x2066, 0x2067, 0x2068, 0x2069]);
  const MARKS = new Set([0x200E, 0x200F, 0x061C]);
  const ZERO_WIDTH = new Set([0x200B, 0x2060, 0xFEFF, 0x00AD, 0x180E, 0x034F, 0x115F, 0x1160, 0x3164, 0xFFA0]);
  // Legal inside emoji and in Indic, Persian and Arabic shaping, where they follow a character of
  // those scripts, all of which stand at U+0590 or later. After anything earlier they only hide something.
  const JOINERS = new Set([0x200C, 0x200D]);
  const JOINER_USERS_FROM = 0x0590;
  // The only tag sequences Unicode defines. Checking the SHAPE of a subdivision flag -- a leading
  // U+1F3F4 and a trailing U+E007F -- accepts any hidden string wearing one character as a costume.
  const RGI_TAGS = new Set(["gbeng", "gbsct", "gbwls"]);
  // U+061C and U+FEFF sit inside the naive Arabic ranges, so a class written the obvious way lets
  // each of them declare the text RTL and thereby excuse itself. Split around both.
  const STRONG_RTL = /[\u0590-\u05FF\u0600-\u061B\u061D-\u06FF\u0700-\u074F\u0780-\u07BF\u0860-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFE]|[\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;
  const isTag = (n) => n >= 0xE0000 && n <= 0xE007F;
  const isHiddenMark = (n) => n >= 0xE0100 && n <= 0xE01EF;
  const isControl = (n) => (n < 0x20 || n === 0x7F || (n >= 0x80 && n <= 0x9F))
    && n !== 0x09 && n !== 0x0A && n !== 0x0D;

  /** `{counts, clean}`: one walk, so the number said and the characters taken cannot disagree. The
   *  count is in codepoints, and the result is a fixed point: cleaning clean text changes nothing. */
  function classify(text) {
    const source = String(text ?? "");
    const cps = [...source];
    const rtl = STRONG_RTL.test(source);
    const counts = {};
    const keep = [];
    const bump = (kind, n = 1) => { counts[kind] = (counts[kind] || 0) + n; };
    const tagLetters = (run) => {
      let out = "";
      for (const ch of run) {
        const n = ch.codePointAt(0);
        if (n < 0xE0020 || n > 0xE007E) return "";
        out += String.fromCharCode(n - 0xE0000);
      }
      return out;
    };
    for (let i = 0; i < cps.length; ) {
      const n = cps[i].codePointAt(0);
      if (isTag(n)) {
        let j = i;
        while (j < cps.length && isTag(cps[j].codePointAt(0))) j++;
        const run = cps.slice(i, j);
        const spelled = run[run.length - 1].codePointAt(0) === 0xE007F ? tagLetters(run.slice(0, -1)) : "";
        if (i > 0 && cps[i - 1].codePointAt(0) === 0x1F3F4 && RGI_TAGS.has(spelled)) keep.push(...run);
        else bump("hidden", run.length);
        i = j; continue;
      }
      if (OVERRIDES.has(n)) { bump("bidi"); i++; continue; }
      if (MARKS.has(n)) { if (rtl) keep.push(cps[i]); else bump("bidi"); i++; continue; }
      if (JOINERS.has(n)) {
        // The character before it that SURVIVES, so a second pass cannot give another verdict.
        if (keep.length && keep[keep.length - 1].codePointAt(0) >= JOINER_USERS_FROM) keep.push(cps[i]);
        else bump("zero-width");                   // emoji, Indic and Persian shaping keep theirs, above
        i++; continue;
      }
      if (ZERO_WIDTH.has(n)) { bump("zero-width"); i++; continue; }
      if (isHiddenMark(n)) { bump("hidden"); i++; continue; }
      if (isControl(n)) { bump("control"); i++; continue; }
      keep.push(cps[i]); i++;
    }
    return { counts, clean: keep.join("") };
  }
  const total = (counts) => Object.values(counts || {}).reduce((sum, n) => sum + n, 0);

  /** The line above the box. It reads as information: what was going to matter is already gone. */
  function notice(removed) {
    const n = Number(removed) || 0;
    return n > 0 ? `Removed ${n} invisible character${n === 1 ? "" : "s"} from the pasted text` : "";
  }
  /** The same fact in more detail, one hover away. */
  function detail(counts) {
    const names = { "zero-width": ["zero-width character", "zero-width characters"],
      bidi: ["text direction control", "text direction controls"],
      hidden: ["hidden tag character", "hidden tag characters"],
      control: ["control character", "control characters"] };
    const parts = Object.keys(names).filter((kind) => counts?.[kind])
      .map((kind) => `${counts[kind]} ${names[kind][counts[kind] === 1 ? 0 : 1]}`);
    return parts.length ? `${parts.join(", ")}. Undo brings them back.` : "";
  }

  /** Every way a line can end, as a newline. Blank lines stay what they are. */
  const lineBreaks = (text) => String(text ?? "").replace(/\r\n?|[\u2028\u2029]/g, "\n");

  /** The draft as a message: no blank lines around it and no trailing space, and the first line's
   *  indentation kept, because a pasted block's first line is as indented as the rest. */
  const trimDraft = (text) => String(text ?? "").replace(/^(?:[^\S\n]*\n)+/, "").trimEnd();

  // ---- what the HTML knows -----------------------------------------------------------------
  const SKIPPED = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "HEAD", "TITLE", "META", "LINK", "SVG", "MATH",
    "IFRAME", "OBJECT", "EMBED", "CANVAS", "AUDIO", "VIDEO", "SELECT", "DATALIST", "IMG"]);
  const BLOCKS = new Set(["ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "CAPTION", "CENTER", "DD", "DETAILS", "DIV", "DL", "DT",
    "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "MENU",
    "NAV", "OL", "P", "PRE", "SECTION", "SUMMARY", "TABLE", "TBODY", "TFOOT", "THEAD", "TR", "UL"]);
  // These have space around them on the page, so text made from the HTML alone has a blank line.
  const SPACED = new Set(["BLOCKQUOTE", "H1", "H2", "H3", "H4", "H5", "H6", "P", "PRE", "TABLE"]);
  const LISTS = new Set(["OL", "UL", "MENU"]);
  const MAX_HTML = 4_000_000, MAX_LINES = 40_000;
  const tagOf = (el) => String(el.tagName || "").toUpperCase();
  // An inline style is what the browser's copy writes for rules that matter (it inlines them).
  const styleOf = (el, name) => {
    const found = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, "i").exec(el.getAttribute?.("style") || "");
    return found ? found[1].trim().toLowerCase() : "";
  };
  const listStyle = (el) => {
    const long = styleOf(el, "list-style-type");
    if (long) return long;
    const short = styleOf(el, "list-style");
    return short ? (/\bnone\b/.test(short) ? "none"
      : /[a-z-]+/.exec(short.replace(/\b(inside|outside|url\([^)]*\))\b/g, " "))?.[0] || "") : "";
  };
  const hidden = (el) => el.hasAttribute?.("hidden") || styleOf(el, "display") === "none" || styleOf(el, "visibility") === "hidden";
  const ROMAN = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
  function roman(n) {
    let out = "", left = n;
    for (const [value, word] of ROMAN) while (left >= value) { out += word; left -= value; }
    return out;
  }
  function alpha(n) {
    let out = "", left = n;
    while (left > 0) { left -= 1; out = String.fromCharCode(97 + (left % 26)) + out; left = Math.floor(left / 26); }
    return out;
  }
  function number(n, style) {
    if (n > 0) {
      if (/^(lower-alpha|lower-latin|a)$/.test(style)) return alpha(n);
      if (/^(upper-alpha|upper-latin|A)$/.test(style)) return alpha(n).toUpperCase();
      if (/^(lower-roman|i)$/.test(style)) return roman(n);
      if (/^(upper-roman|I)$/.test(style)) return roman(n).toUpperCase();
    }
    return String(n);
  }
  // The `type` attribute is case-sensitive (a and A differ) and a style wins over it.
  const orderedStyle = (el, inherited) => listStyle(el) || el.getAttribute?.("type") || inherited;

  const normal = (text) => String(text).replace(/\s+/g, " ").trim().toLowerCase();
  // A browser that keeps markers writes them in its plain text: Firefox " 1. x", Safari "1.\tx", " * x".
  const carriedMarker = /^(?:[-*+\u2022\u25E6\u25AA\u2023\u00B7]|\d{1,6}[.)]|[a-z]{1,4}[.)]) +/;

  /** The page's lines as `{text, norm, prefix, item, blanks}`. `prefix` is what the line needs in
   *  front of it to read as it did on the page; `item` says it is a list item's first line; `blanks`
   *  is how many empty lines stand above it. */
  function htmlLines(html) {
    const source = String(html ?? "");
    if (!source || source.length > MAX_HTML || typeof root.DOMParser !== "function") return null;
    let doc;
    try { doc = new root.DOMParser().parseFromString(source, "text/html"); } catch { return null; }
    const lines = [];
    let buffer = "", item = null, preDepth = 0, blanks = 0, group = 0, tooMany = false;
    const gap = () => { if (lines.length) blanks = Math.max(blanks, 1); };
    const push = (text, keepSpace) => {
      if (lines.length >= MAX_LINES) { tooMany = true; return; }
      const shown = keepSpace ? text : text.replace(/ {2,}/g, " ").replace(/^ +| +$/g, "");
      const norm = normal(shown);
      if (!norm) { if (keepSpace && lines.length) blanks += 1; return; }
      const entry = { text: shown, norm, prefix: "", item: false, blanks, group: item ? group : 0 };
      blanks = 0;
      if (item) {
        entry.prefix = item.pending === null ? item.indent : item.pending;
        entry.item = item.pending !== null;
        item.pending = null;
      }
      lines.push(entry);
    };
    const flush = () => { if (buffer || preDepth) { push(buffer, preDepth > 0); buffer = ""; } };
    const isBlock = (el, tag) => {
      const display = styleOf(el, "display");
      if (/^(inline|inline-block|inline-flex|contents)$/.test(display)) return false;
      return BLOCKS.has(tag) || /^(block|flex|grid|list-item|table|flow-root)$/.test(display);
    };
    const visitList = (list, base) => {
      const tag = tagOf(list), ordered = tag === "OL";
      const inherited = ordered ? orderedStyle(list, "") : listStyle(list);
      const kids = [...list.children];
      const reversed = ordered && list.hasAttribute("reversed");
      const declared = Number.parseInt(list.getAttribute?.("start") ?? "", 10);
      const count = kids.filter((kid) => tagOf(kid) === "LI").length;
      let n = ordered && Number.isFinite(declared) ? declared : reversed ? count : 1;
      let childBase = base;
      for (const kid of kids) {
        const kidTag = tagOf(kid);
        if (LISTS.has(kidTag)) { visitList(kid, childBase); continue; }   // a list right inside a list: Google Docs
        if (kidTag !== "LI") { walk(kid); continue; }
        if (hidden(kid)) continue;
        // A list drawn as a row of words (a site's menu, Wikipedia's navigation boxes) is not a list on the page.
        if (/^inline/.test(styleOf(kid, "display"))) { walkKids(kid); buffer += " "; continue; }
        const value = Number.parseInt(kid.getAttribute("value") ?? "", 10);
        if (ordered && Number.isFinite(value)) n = value;
        const own = ordered ? orderedStyle(kid, inherited) : listStyle(kid) || inherited;
        // A bullet list drawn with none shows none (a menu, a row of links). An ordered list keeps its
        // numbers either way: sites draw them with counters, which leave `none` behind in the HTML.
        const marker = ordered ? `${number(n, own)}.` : own === "none" ? "" : "-";
        if (ordered) n += reversed ? -1 : 1;
        const lead = " ".repeat(base);
        childBase = marker ? base + marker.length + 1 : base;
        const outer = item;
        flush();
        item = { indent: " ".repeat(childBase), pending: marker ? `${lead}${marker} ` : null, base: childBase };
        walkKids(kid);
        flush();
        item = outer;
      }
    };
    const walkKids = (node) => { for (const kid of node.childNodes) walk(kid); };
    const walk = (node) => {
      if (tooMany) return;
      if (node.nodeType === 3) {
        const value = node.nodeValue || "";
        if (preDepth) {
          const parts = value.split(/\r\n?|\n/);
          parts.forEach((part, i) => { if (i) flush(); buffer += part; });
        } else buffer += value.replace(/[ \t\r\n\f]+/g, " ");
        return;
      }
      if (node.nodeType !== 1) return;
      const tag = tagOf(node);
      if (SKIPPED.has(tag) || hidden(node)) return;
      if (tag === "BR") {
        // The first ends the line; each one after it is a blank line.
        if (buffer) flush(); else if (lines.length) blanks += 1;
        return;
      }
      if (LISTS.has(tag)) {
        flush();
        const nested = !!item;
        if (!nested) { gap(); group += 1; }
        visitList(node, item ? item.base : 0);
        flush();
        if (!nested) gap();
        return;
      }
      if (tag === "TD" || tag === "TH") {
        walkKids(node);
        if (node.nextElementSibling) buffer += "\t";
        return;
      }
      const block = isBlock(node, tag);
      const spaced = block && SPACED.has(tag);
      const pre = tag === "PRE" || /^pre/.test(styleOf(node, "white-space"));
      if (block) flush();
      if (spaced) gap();
      if (pre) preDepth += 1;
      walkKids(node);
      if (pre) {
        // A <pre>'s text ends in a newline that closes its last line rather than opening another.
        if (buffer) flush();
        preDepth -= 1;
      } else if (block) flush();
      if (spaced) gap();
    };
    walkKids(doc.body || doc);
    flush();
    return tooMany ? null : lines;
  }

  /** Put back the list markers plain text lost. Everything else in `plain` stays character for
   *  character. The two flavours have to agree: every item of a list must be found, in order, as a
   *  line of its own in the plain text, or that list stays as the plain text has it. */
  function restoreLists(plain, html) {
    if (!plain || !html || !/<(?:ol|ul|menu)[\s>]/i.test(html)) return plain;
    const entries = htmlLines(html);
    if (!entries || !entries.some((entry) => entry.prefix)) return plain;
    // Words selected inside one item come wrapped in that item's list. Nobody selected a list there.
    if (entries.every((entry) => entry.group === entries[0].group) && entries.filter((entry) => entry.item).length === 1) return plain;
    const lines = plain.split("\n");
    if (lines.length > MAX_LINES) return plain;
    // Where each text stands in the plain lines, so the walk below stays quick on a long page.
    const seen = new Map();
    const note = (key, at, carried) => {
      if (!key) return;
      if (!seen.has(key)) seen.set(key, []);
      seen.get(key).push({ at, carried });
    };
    lines.forEach((line, at) => {
      const norm = normal(line);
      note(norm, at, false);
      const stripped = norm.replace(carriedMarker, "");
      if (stripped !== norm) note(stripped, at, true);
    });
    const spotFrom = (key, from) => {
      const spots = seen.get(key);
      if (!spots) return null;
      let low = 0, high = spots.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (spots[middle].at < from) low = middle + 1; else high = middle;
      }
      return spots[low] || null;
    };
    const out = lines.slice();
    let cursor = 0, group = 0, groupStart = 0, marks = [], failed = false;
    const closeGroup = () => {
      if (failed) cursor = groupStart;
      else for (const [at, line] of marks) out[at] = line;
      marks = []; failed = false;
    };
    for (const entry of entries) {
      if (entry.group !== group) { closeGroup(); group = entry.group; groupStart = cursor; }
      if (failed) continue;
      const spot = spotFrom(entry.norm, cursor);
      if (!spot) {
        if (entry.item) failed = true;
        continue;
      }
      cursor = spot.at + 1;
      if (!spot.carried && entry.prefix) marks.push([spot.at, entry.prefix + lines[spot.at].replace(/^[ \t]+/, "")]);
    }
    closeGroup();
    return out.join("\n");
  }

  /** Text from the HTML alone, for applications that put nothing else on the clipboard. Never
   *  inserted as markup: it is parsed, and only its words and shape are taken. */
  function htmlToText(html) {
    const entries = htmlLines(html);
    if (!entries) return "";
    const out = [];
    for (const entry of entries) {
      for (let i = 0; i < entry.blanks && out.length; i++) out.push("");
      out.push(entry.prefix + entry.text);
    }
    return out.join("\n");
  }

  /** The clipboard's text, from whichever flavour carries it, in the shape it was copied with. */
  function clipboardText(data) {
    if (!data || typeof data.getData !== "function") return "";
    const read = (type) => { try { return String(data.getData(type) || ""); } catch { return ""; } };
    const plain = lineBreaks(read("text/plain"));
    const html = read("text/html");
    if (!plain) return html ? lineBreaks(htmlToText(html)) : "";
    return restoreLists(plain, html);
  }

  /** What a paste is: as copied (`raw`), as it should land (`clean`), and what was taken. */
  function fromText(raw) {
    const text = String(raw ?? "");
    const { counts, clean } = classify(text);
    return { raw: text, clean, counts, removed: total(counts) };
  }
  const fromClipboard = (data) => fromText(clipboardText(data));

  /** The quiet row above a box that isn't Work's (Work's is a row of its rail, in the panel's markup): words, a way to
   *  close it, nothing else. Its look is in media/mentions.css. */
  function noticeRow(doc, onClose) {
    const row = doc.createElement("div");
    row.className = "paste-note";
    row.setAttribute("role", "status");
    row.hidden = true;
    row.innerHTML = '<svg class="paste-note-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M1.8 8S4 4.2 8 4.2 14.2 8 14.2 8 12 11.8 8 11.8 1.8 8 1.8 8Z"/><circle cx="8" cy="8" r="1.7"/><path d="M3 13 13 3"/></svg>'
      + '<span class="paste-note-words"></span>'
      + '<button type="button" class="paste-note-close" title="Close" aria-label="Close this notice">'
      + '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>';
    row.querySelector("button").addEventListener("click", onClose);
    const words = row.querySelector(".paste-note-words");
    return {
      el: row,
      show(n, counts) { words.textContent = notice(n); row.title = detail(counts); row.hidden = !n; },
      hide() { row.hidden = true; },
    };
  }

  root.DgcPasteClean = { classify, total, notice, detail, lineBreaks, trimDraft, restoreLists, htmlToText,
    clipboardText, fromText, fromClipboard, noticeRow };
})(globalThis);
