// Notes: the notes app on Home (approved 14 Nov: "a full notes app"). The Notes card of media/shared/homecards.js is this
// file's. On Home, at every size, the card is only a field that saves as it is typed, a new-note icon (a fresh note:
// the typed one stays in Notes) and "Open Notes" (his call, 14 Nov night); opened, it is the whole app: one thing at a
// time in a narrow side bar (the list, then the note with Back), three columns from 560 px (folders, the list, the
// note). Nothing here says Save or Done: typing saves.
//
// The host keeps the notes (src/notes.ts): files in DGC's own storage folder on this computer. This page holds the list
// (titles, row lines, folders) and the words of the one note that is open; it asks for those words when a note is
// opened, and sends them back as they are typed (saved as you type: no Save button). A locked note's words are never
// here while notes are locked. This file never touches a network.
//
// media/shared/notes.css is how it looks. A classic script, loaded before homecards.js: window.DgcNotes.
(function () {
  "use strict";
  const root = typeof window !== "undefined" ? window : globalThis;
  if (root.DgcNotes) return;

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // (New, Back, More and Delete are the one glyph each has on every surface, media/shared/icons.js: { shared: action }.)
  const svg = (d, s = 13, w = 1.8) => (d && d.shared ? (root.DgcIcons ? root.DgcIcons.html(d.shared, { size: s }) : "") : svgOwn(d, s, w));
  const svgOwn = (d, s = 13, w = 1.8) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const I = { lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>', unlocked: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>', all: '<path d="M4 6h16M4 12h16M4 18h10"/>', bin: { shared: "delete" },
    plus: { shared: "add" }, back: { shared: "back" }, more: { shared: "more" },
    find: '<circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/>', compose: '<path d="M11 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-5"/><path d="M17.6 3.6a1.9 1.9 0 0 1 2.8 2.8L12 14.8l-3.6.8.8-3.6z"/>', chev: '<path d="M6 9l6 6 6-6"/>', sort: '<path d="M7 5v14M4 16l3 3 3-3M14 7h6M14 12h4M14 17h2"/>',
    move: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM10 13h5M13 10.5l2.5 2.5-2.5 2.5"/>', pen: '<path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4"/>',
    del: '<path d="M21 5H9l-6 7 6 7h12zM12 9l6 6M18 9l-6 6"/>', tab: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18M9 5v4"/>', dup: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
    down: '<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>', copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>', bold: '<path d="M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z"/>', ital: '<path d="M10 5h7M7 19h7M14 5l-4 14"/>', head: '<path d="M5 5v14M13 5v14M5 12h8M17 10l2-1v10"/>',
    ul: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1" fill="currentColor"/><circle cx="4.5" cy="12" r="1" fill="currentColor"/><circle cx="4.5" cy="18" r="1" fill="currentColor"/>',
    ol: '<path d="M10 6h10M10 12h10M10 18h10M4 5l1.5-1v4M4 16h2.5l-2.5 3h2.5"/>', check: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8 12 3 3 5-6"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>', undo: '<path d="M9 7 4 12l5 5M4 12h10a5 5 0 0 1 0 10h-2"/>' };
  const PIN_D = "M10.2 1.8l4 4-2.2.9-2.4 2.4.3 3.1-1.1 1.1-2.6-2.6L2.8 14l-.8-.8 3.3-3.4-2.6-2.6 1.1-1.1 3.1.3 2.4-2.4z";
  const pinSvg = (on, size = 12) => `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="${on ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true"><path d="${PIN_D}"/></svg>`;
  const plural = (n, word, many) => `${n} ${n === 1 ? word : many || word + "s"}`;
  const DAY = 86400000;
  const day = (at) => { const d = new Date(Number(at)); return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }) }).format(d); };
  /** When something was last changed or made, in a word or two. */
  function ago(at) {
    const ms = Date.now() - Number(at), min = Math.floor(ms / 60000);
    if (!Number.isFinite(ms) || !(Number(at) > 0)) return "";
    return min < 1 ? "Just now" : min < 60 ? `${min} min ago` : min < 1440 ? `${Math.floor(min / 60)} h ago` : min < 2880 ? "Yesterday" : min < 10080 ? `${Math.floor(min / 1440)} days ago` : day(at);
  }
  /** A line without its Markdown marks, and a note's title and row line from its words: as the host makes them (src/notes.ts). */
  const plain = (line) => line.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+\[[ xX]\]\s*|[-*+]\s+|\d{1,9}[.)]\s+)/, "").replace(/\[([^\]\n]*)\]\(([^)\s]+)\)/g, "$1").replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, "$1")
    .replace(/(?<![\\*])\*(?=[^\s*])([^*\n]*?[^\s*\\])\*(?!\*)/g, "$1").replace(/(?<![\\\w])_(?=[^\s_])([^_\n]*?[^\s_\\])_(?!\w)/g, "$1").replace(/\\([\\*_[\]#.+-])/g, "$1").replace(/\s+/g, " ").trim();
  const titleOf = (text) => { for (const line of String(text).split("\n", 400)) { const said = plain(line); if (said) return said.slice(0, 120); } return "New note"; };
  function lineOf(text) {
    const out = []; let titled = false, size = 0;
    for (const line of String(text).split("\n", 400)) { const said = plain(line); if (!said) continue; if (!titled) { titled = true; continue; } out.push(said); size += said.length; if (size > 160 || out.length >= 4) break; }
    return out.join(" · ").slice(0, 160);
  }
  /** Words with what was searched for marked in them. */
  function mark(text, q) {
    const find = String(q || "").trim().toLowerCase(), said = String(text ?? ""); if (!find) return esc(said);
    let out = "", at = 0; const low = said.toLowerCase();
    for (let hit = low.indexOf(find); hit >= 0; hit = low.indexOf(find, at)) { out += `${esc(said.slice(at, hit))}<mark class="nt-hit">${esc(said.slice(hit, hit + find.length))}</mark>`; at = hit + find.length; }
    return out + esc(said.slice(at));
  }
  const newId = () => `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7).padEnd(5, "0")}`;

  // ---- Markdown, a line at a time ----------------------------------------------------------------------------------------
  // Underneath, a note is Markdown text (that is what is saved, exported and searched). On screen each line of it is one
  // block: plain words, a heading (#, ##, ###), a bullet, a numbered line or a tick box, indented up to four deep, with
  // bold, italic and links inside. Nothing else of Markdown is read: any other mark stays the words it is.
  const LINE = /^([ \t]*)(?:(#{1,6})[ \t]+|[-*+][ \t]+\[([ xX])\](?:[ \t]|$)|([-*+])[ \t]+|(\d{1,9})[.)][ \t]+)?(.*)$/;
  const LISTS = ["ul", "ol", "ck"], isList = (k) => LISTS.includes(k);
  function parseLine(raw) {
    const m = LINE.exec(raw), lead = m[1].replace(/\t/g, "  ").length, deep = Math.min(4, lead >> 1);
    if (m[2] && !lead) return { k: `h${Math.min(3, m[2].length)}`, in: 0, body: m[6] };
    if (m[3] !== undefined) return { k: "ck", in: deep, done: m[3] !== " ", body: m[6] };
    if (m[4]) return { k: "ul", in: deep, body: m[6] };
    if (m[5]) return { k: "ol", in: deep, body: m[6] };
    return { k: "p", in: 0, body: raw };
  }
  const ESCAPABLE = /[\\*_[\]#.+\-()`>!]/, URL_AT = /^(?:https?:\/\/|mailto:)[^\s<>"'`]+/i;
  const safeUrl = (u) => /^(?:https?:\/\/|mailto:)[^\s<>"'`]+$/i.test(String(u || "")) && String(u).length <= 2000;
  const trimUrl = (u) => u.replace(/[.,;:!?)\]]+$/, "");
  /** Where the mark that closes one opened just before `from` is (never after a space, never escaped); -1: nowhere. */
  function closer(s, from, m) {
    for (let j = from; j < s.length; j++) {
      if (s[j] === "\\") { j++; continue; }
      if (!s.startsWith(m, j) || j === from || /\s/.test(s[j - 1])) continue;
      if (m === "*" && s[j + 1] === "*") { j++; continue; }
      if (m === "_" && /\w/.test(s[j + 1] || "")) continue;
      return j;
    }
    return -1;
  }
  /** A line's words as HTML: bold, italic, links (written, or a bare address), and escaped marks as the marks they are. */
  function inline(s) {
    let out = "", i = 0;
    while (i < s.length) {
      const c = s[i], prev = s[i - 1] || "", next = s[i + 1] || "";
      if (c === "\\" && ESCAPABLE.test(next)) { out += esc(next); i += 2; continue; }
      if (c === "*" && next === "*" && s[i + 2] && !/[\s*]/.test(s[i + 2])) { const end = closer(s, i + 2, "**"); if (end > 0) { out += `<b>${inline(s.slice(i + 2, end))}</b>`; i = end + 2; continue; } }
      if ((c === "*" || c === "_") && next && !/\s/.test(next) && next !== c && prev !== c && (c === "*" || !/\w/.test(prev))) { const end = closer(s, i + 1, c); if (end > 0) { out += `<i>${inline(s.slice(i + 1, end))}</i>`; i = end + 1; continue; } }
      if (c === "[") { const m = /^\[([^\]\n]*)\]\(([^)\s]+)\)/.exec(s.slice(i)); if (m && safeUrl(m[2])) { out += `<a href="${esc(m[2])}">${inline(m[1])}</a>`; i += m[0].length; continue; } }
      if ((c === "h" || c === "H" || c === "m" || c === "M") && !/\w/.test(prev)) { const m = URL_AT.exec(s.slice(i)), url = m ? trimUrl(m[0]) : ""; if (url.length > 9 && safeUrl(url)) { out += `<a href="${esc(url)}" data-bare="1">${esc(url)}</a>`; i += url.length; continue; } }
      out += esc(c); i++;
    }
    return out;
  }
  const blank = (c) => !c || /\s/.test(c);
  /** Words as Markdown: a mark that would be read as formatting is escaped; one that would not is left as it is. */
  const escText = (t) => t.replace(/ /g, " ").replace(/\\/g, "\\\\").replace(/\*/g, (m, at, all) => (blank(all[at - 1]) && blank(all[at + 1]) ? "*" : "\\*"))
    .replace(/_/g, (m, at, all) => { const a = all[at - 1] || "", b = all[at + 1] || ""; return (/\w/.test(a) && /\w/.test(b)) || (blank(a) && blank(b)) ? "_" : "\\_"; }).replace(/\[(?=[^\]\n]*\]\()/g, "\\[");
  const wrap = (t, m) => { const core = t.trim(); if (!core) return t; const a = t.length - t.trimStart().length, b = t.length - t.trimEnd().length; return `${t.slice(0, a)}${m}${core}${m}${b ? t.slice(-b) : ""}`; };
  function runsOf(node, f, out) {
    for (const n of node.childNodes) {
      if (n.nodeType === 3) { if (n.nodeValue) out.push({ t: n.nodeValue, b: f.b, i: f.i, a: f.a }); }
      else if (n.nodeType === 1 && n.tagName !== "BR") { const tag = n.tagName; runsOf(n, { b: f.b || tag === "B" || tag === "STRONG", i: f.i || tag === "I" || tag === "EM", a: tag === "A" ? n.getAttribute("href") || "" : f.a }, out); }
    }
    return out;
  }
  const groups = (rs, same, each) => { let out = ""; for (let i = 0; i < rs.length;) { let j = i; while (j < rs.length && same(rs[j], rs[i])) j++; out += each(rs.slice(i, j)); i = j; } return out; };
  const marksMd = (rs) => groups(rs, (x, y) => x.b === y.b, (bold) => { const inner = groups(bold, (x, y) => x.i === y.i, (it) => { const t = escText(it.map((r) => r.t).join("")); return it[0].i ? wrap(t, bold[0].b ? "_" : "*") : t; }); return bold[0].b ? wrap(inner, "**") : inner; });
  /** A line's inside as Markdown. */
  const bodyMd = (line) => groups(runsOf(line, { b: false, i: false, a: "" }, []), (x, y) => x.a === y.a, (g) => { const href = g[0].a, text = g.map((r) => r.t).join(""); return href && safeUrl(href) ? (text === href ? href : `[${marksMd(g)}](${href})`) : marksMd(g); });
  function lineMd(line) {
    const k = line.dataset.k || "p", pad = "  ".repeat(Number(line.dataset.in) || 0), body = bodyMd(line);
    if (k === "ul") return `${pad}- ${body}`;
    if (k === "ol") return `${pad}${line.dataset.n || 1}. ${body}`;
    if (k === "ck") return `${pad}- [${line.dataset.done === "1" ? "x" : " "}] ${body}`;
    if (k[0] === "h") return `${"#".repeat(Number(k[1]) || 2)} ${body}`;
    return body.replace(/^(\s*)(#{1,6}[ \t]|[-*+][ \t])/, "$1\\$2").replace(/^(\s*\d{1,9})([.)][ \t])/, "$1\\$2");
  }
  const lineHtml = (l) => `<div class="nt-l" data-k="${l.k}"${l.in ? ` data-in="${l.in}"` : ""}${l.k === "ck" ? ` data-done="${l.done ? 1 : 0}" role="checkbox" aria-checked="${l.done ? "true" : "false"}"` : ""}>${inline(l.body) || "<br>"}</div>`;
  /** A tick box says what it is and whether it is ticked (the box itself is drawn by the stylesheet, which a screen
   *  reader does not read): a checkbox by role, checked or not; a line that is no tick box says neither. */
  function sayBox(line) {
    if (!line || line.nodeType !== 1) return;
    if (line.dataset.k === "ck") { const on = line.dataset.done === "1" ? "true" : "false"; if (line.getAttribute("role") !== "checkbox") line.setAttribute("role", "checkbox"); if (line.getAttribute("aria-checked") !== on) line.setAttribute("aria-checked", on); }
    else { if (line.getAttribute("role") === "checkbox") line.removeAttribute("role"); if (line.hasAttribute("aria-checked")) line.removeAttribute("aria-checked"); }
  }
  /** Numbered lines keep themselves in order: each run counts from 1, a deeper one inside it on its own. */
  function renumber(el) {
    const c = [0, 0, 0, 0, 0];
    for (const l of el.children) {
      const k = l.dataset.k, lv = Number(l.dataset.in) || 0;
      if (k === "ol") { c[lv]++; c.fill(0, lv + 1); if (l.dataset.n !== String(c[lv])) l.dataset.n = String(c[lv]); continue; }
      if (l.dataset.n) delete l.dataset.n;
      if (k === "ul" || k === "ck") c.fill(0, lv); else c.fill(0);
    }
  }

  // ---- the editor: a note's words, formatted as they are typed --------------------------------------------------------------
  /**
   * A note's words in a box that is typed in, formatted as you type. set(text) shows a note; text() is its Markdown now.
   *   onInput(note, text)  on every change      onState()     the caret moved (the format bar follows it)
   *   onLink(href)         a link Ctrl+clicked  onTick(done)  a tick box ticked     onLimit()  more than a note holds
   * cmd(name, value): bold · italic · heading · h2 · h3 · ul · ol · ck · tick · undo · redo · link (an address) · unlink.
   */
  function createEditor({ doc, onInput, longest = () => 100000, onState = () => {}, onLink = () => {}, onTick = () => {}, onLimit = () => {} }) {
    const el = doc.createElement("div");
    el.className = "nt-doc"; el.contentEditable = "true"; el.spellcheck = true; el.dataset.fk = "note-doc";
    el.setAttribute("role", "textbox"); el.setAttribute("aria-multiline", "true"); el.setAttribute("aria-label", "Note: its first line is its name");
    let hist = [], at = -1, cur = "", composing = false, held = null;
    // However a line becomes a tick box, is ticked, or stops being one (typed, the format bar, a paste, undo, Enter):
    // its checked state follows what the line itself says.
    if (typeof root.MutationObserver === "function") new root.MutationObserver((changes) => { for (const c of changes) { if (c.type === "attributes") { if (c.target.parentNode === el) sayBox(c.target); } else for (const n of c.addedNodes) if (n.parentNode === el) sayBox(n); } })
      .observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-k", "data-done"] });
    const lineAt = (node) => { while (node && node.parentNode !== el) node = node.parentNode; return node && node.nodeType === 1 ? node : null; };
    /** A place in the note as [line, how many characters into it]. */
    function where(node, off) {
      if (node === el) { const line = el.children[Math.min(off, el.children.length - 1)]; return line ? [line, off >= el.children.length ? line.textContent.length : 0] : null; }
      const line = lineAt(node); if (!line) return null;
      const r = doc.createRange(); r.selectNodeContents(line); try { r.setEnd(node, off); } catch { return [line, 0]; }
      return [line, r.toString().length];
    }
    function point(line, off) {
      const walk = doc.createTreeWalker(line, 4); let n, left = off, last = null;
      while ((n = walk.nextNode())) { if (left <= n.nodeValue.length) return [n, left]; left -= n.nodeValue.length; last = n; }
      return last ? [last, last.nodeValue.length] : [line, 0];
    }
    function selNow() {
      const s = doc.getSelection(); if (!s || !s.rangeCount || !el.contains(s.anchorNode)) return null;
      const a = where(s.anchorNode, s.anchorOffset), f = where(s.focusNode, s.focusOffset); if (!a || !f) return null;
      const idx = (line) => Array.prototype.indexOf.call(el.children, line);
      return { a: [idx(a[0]), a[1]], f: [idx(f[0]), f[1]] };
    }
    function place(sel) {
      const s = doc.getSelection(), spot = ([k, off]) => { const line = el.children[Math.max(0, Math.min(k, el.children.length - 1))]; return line ? point(line, off) : [el, 0]; };
      if (!sel) return; const a = spot(sel.a), f = spot(sel.f);
      try { s.setBaseAndExtent(a[0], a[1], f[0], f[1]); } catch { /* the note changed under it */ }
    }
    const caret = (line, off) => { const [n, o] = point(line, off); doc.getSelection().collapse(n, o); };
    /** The lines the selection touches, first to last. */
    function chosen() {
      const s = selNow(); if (!s) return [];
      const from = Math.min(s.a[0], s.f[0]), to = Math.max(s.a[0], s.f[0]);
      return [...el.children].slice(from, to + 1);
    }
    function setKind(line, k) {
      line.dataset.k = k;
      if (!isList(k)) delete line.dataset.in;
      if (k === "ck") line.dataset.done = line.dataset.done === "1" ? "1" : "0"; else delete line.dataset.done;
    }
    const newLine = (k = "p", deep = "") => { const line = doc.createElement("div"); line.className = "nt-l"; setKind(line, k); if (deep && isList(k)) line.dataset.in = deep; return line; };
    /** A line left tidy: no empty bold or link, and a line with no words still has a height. */
    function tidy(line) {
      for (const n of [...line.querySelectorAll("b, i, a, strong, em")]) if (!n.textContent) n.remove();
      for (const br of [...line.querySelectorAll("br")]) if (line.textContent || br !== line.lastChild) br.remove();
      if (!line.textContent && !line.querySelector("br")) line.append(doc.createElement("br"));
    }
    /** What the browser left after an edit of its own, made lines again: every child a line, no styles of its own. */
    function normalize() {
      for (const n of [...el.childNodes]) {
        if (n.nodeType === 1 && n.tagName === "DIV") { if (!n.classList.contains("nt-l")) { n.className = "nt-l"; setKind(n, "p"); } continue; }
        if (n.nodeType === 3 && !n.nodeValue) { n.remove(); continue; }
        const prev = n.previousSibling, into = prev && prev.__wrapped ? prev : newLine();
        if (into !== prev) { into.__wrapped = true; n.before(into); }
        into.append(n);
      }
      for (const line of [...el.children]) {
        delete line.__wrapped;
        for (const inner of [...line.querySelectorAll("div")]) { const made = newLine(); while (inner.firstChild) made.append(inner.firstChild); inner.remove(); line.after(made); }
        for (const n of [...line.querySelectorAll("span, font, u, s, strike, sub, sup, code, mark, small, big")]) n.replaceWith(...n.childNodes);
        for (const n of [...line.querySelectorAll("[style], [class], [id], [color]")]) { n.removeAttribute("style"); n.removeAttribute("class"); n.removeAttribute("id"); n.removeAttribute("color"); }
        for (const a of [...line.querySelectorAll("a")]) { const href = a.getAttribute("href") || ""; if (a.dataset.bare) { const t = a.textContent; if (safeUrl(t)) { if (href !== t) a.setAttribute("href", t); } else a.replaceWith(...a.childNodes); } else if (!safeUrl(href)) a.replaceWith(...a.childNodes); }
        for (const n of [...line.querySelectorAll("img, svg, video, audio, iframe, object, table, script, style, input, button")]) n.remove();
        if (!["p", "h1", "h2", "h3", "ul", "ol", "ck"].includes(line.dataset.k)) setKind(line, "p");
        if (line.hasAttribute("style")) line.removeAttribute("style");
        tidy(line);
      }
      if (!el.firstElementChild) { const line = newLine(); line.append(doc.createElement("br")); el.append(line); }
      renumber(el);
    }
    const serialize = () => [...el.children].map(lineMd).join("\n");
    function render(text) { el.innerHTML = String(text).split("\n").map((raw) => lineHtml(parseLine(raw))).join(""); renumber(el); }
    function restore(state) { render(state.md); cur = state.md; if (state.sel && doc.activeElement === el) place(state.sel); }
    /** After any change: tidied, and when its Markdown differs, kept for Undo and told. Typing in one go is one step back. */
    function changed(kind) {
      normalize();
      const md = serialize();
      if (md === cur) { onState(); return; }
      if (md.length > longest()) { restore(hist[at]); onLimit(); onState(); return; }
      const now = Date.now(), top = hist[at];
      hist.length = at + 1;
      if (kind === "type" && top && top.kind === "type" && now - top.t < 900 && now - top.t0 < 4000) Object.assign(top, { md, sel: selNow(), t: now });
      else { hist.push({ md, sel: selNow(), kind, t: now, t0: now }); if (hist.length > 200) hist.shift(); at = hist.length - 1; }
      cur = md; onInput(api.note, md); onState();
    }
    function step(by) { const to = hist[at + by]; if (!to) return; if (by < 0 && hist[at]) hist[at].kind = "done"; at += by; restore(to); to.kind = "done"; onInput(api.note, cur); onState(); }
    /** The selection, when it spans words, is taken out (its two ends' lines become one). */
    function removeChosen() {
      const s = doc.getSelection(), r = s.getRangeAt(0), a = lineAt(r.startContainer), b = lineAt(r.endContainer);
      r.deleteContents();
      if (a && b && a !== b && b.parentNode === el) { while (b.firstChild) a.append(b.firstChild); b.remove(); }
      for (const line of [...el.children]) if (line !== a && !line.firstChild) line.remove();
      s.collapse(r.startContainer, r.startOffset);
      if (a) { const spot = where(r.startContainer, r.startOffset); tidy(a); if (spot) caret(spot[0], spot[1]); }
    }
    /** An address just typed (the words before the caret end with one) becomes a link. */
    function linkBefore(node, end) {
      if (!node || node.nodeType !== 3 || node.parentNode.closest?.("a")) return;
      const m = /(?:^|[\s(])((?:https?:\/\/|mailto:)[^\s<>"'`]+)$/i.exec(node.nodeValue.slice(0, end)); if (!m) return;
      const url = trimUrl(m[1]); if (url.length < 10 || !safeUrl(url)) return;
      const from = end - m[1].length, r = doc.createRange(); r.setStart(node, from); r.setEnd(node, from + url.length);
      const a = doc.createElement("a"); a.setAttribute("href", url); a.dataset.bare = "1"; r.surroundContents(a);
    }
    /** Enter: the line is split at the caret. A list goes on; an empty item ends it (or steps out one level). */
    function split() {
      const s = doc.getSelection(); if (!s.rangeCount || !el.contains(s.anchorNode)) return;
      if (!s.isCollapsed) removeChosen();
      const r = s.getRangeAt(0), spot = where(r.startContainer, r.startOffset), line = spot?.[0]; if (!line) return;
      const k = line.dataset.k;
      if (!line.textContent && k !== "p") { if (isList(k) && Number(line.dataset.in)) line.dataset.in = String(Number(line.dataset.in) - 1); else setKind(line, "p"); if (!Number(line.dataset.in)) delete line.dataset.in; caret(line, 0); return; }
      if (r.startContainer.nodeType === 3) linkBefore(r.startContainer, r.startOffset);
      const [node, off] = point(line, spot[1]), tail = doc.createRange(); tail.selectNodeContents(line); tail.setStart(node, off);
      const next = newLine(isList(k) ? k : "p", line.dataset.in); next.append(tail.extractContents());
      line.after(next); tidy(line); tidy(next); caret(next, 0);
    }
    /** What typing a space or a closing mark turns into: "- " a bullet, "1. " a number, "[] " a tick box, "## " a heading, **bold**, *italic*. */
    function auto(data) {
      const s = doc.getSelection(); if (!s.isCollapsed || !el.contains(s.anchorNode)) return;
      const spot = where(s.anchorNode, s.anchorOffset), line = spot?.[0]; if (!line) return;
      const before = line.textContent.slice(0, spot[1]), k = line.dataset.k, node = s.anchorNode, off = s.anchorOffset;
      if (/\s/.test(data)) {
        let to = "", done = false, m;
        if (k === "p" && (m = /^(?:([-*+])|(\d{1,9})[.)]|(#{1,3})|(?:[-*+] ?)?\[([ xX]?)\])\s$/.exec(before))) { to = m[1] ? "ul" : m[2] ? "ol" : m[3] ? `h${m[3].length}` : "ck"; done = /x/i.test(m[4] || ""); }
        else if (k === "ul" && (m = /^\[([ xX]?)\]\s$/.exec(before))) { to = "ck"; done = /x/i.test(m[1]); }
        if (to) { const [n1, o1] = point(line, 0), [n2, o2] = point(line, before.length), r = doc.createRange(); r.setStart(n1, o1); r.setEnd(n2, o2); r.deleteContents(); setKind(line, to); if (to === "ck") line.dataset.done = done ? "1" : "0"; tidy(line); caret(line, 0); return; }
        if (node.nodeType === 3) linkBefore(node, off - 1);
        return;
      }
      if ((data !== "*" && data !== "_") || node.nodeType !== 3 || node.parentNode.closest?.("a")) return;
      const t = node.nodeValue.slice(0, off);
      const m = data === "*" ? /\*\*([^\s*](?:[^*]*[^\s*])?)\*\*$/.exec(t) || /(?<![*\\])\*([^\s*](?:[^*]*[^\s*])?)\*$/.exec(t) : /(?<![\w\\])_([^\s_](?:[^_]*[^\s_])?)_$/.exec(t);
      if (!m) return;
      const bold = m[0].startsWith("**"), tag = bold ? "b" : "i", r = doc.createRange(); r.setStart(node, m.index); r.setEnd(node, off); r.deleteContents();
      const made = doc.createElement(tag); made.textContent = m[1]; r.insertNode(made);
      const after = doc.createRange(); after.setStartAfter(made); after.collapse(true); s.removeAllRanges(); s.addRange(after);
      // (What is typed next is not bold: the typing style is switched off where the caret now is.)
      try { if (doc.queryCommandState(bold ? "bold" : "italic")) doc.execCommand(bold ? "bold" : "italic"); } catch { /* the next words follow the browser */ }
    }
    /** Pasted (or dropped) words: read as Markdown lines, never as the page they came from. */
    function insert(text) {
      const s = doc.getSelection(); if (!s.rangeCount || !el.contains(s.anchorNode)) return;
      if (!s.isCollapsed) removeChosen();
      const rows = String(text).replace(/\r\n?/g, "\n").replace(/\u0000/g, "").split("\n"), r = s.getRangeAt(0), spot = where(r.startContainer, r.startOffset), line = spot?.[0]; if (!line) return;
      const [node, off] = point(line, spot[1]), tail = doc.createRange(); tail.selectNodeContents(line); tail.setStart(node, off);
      const rest = tail.extractContents(), holder = doc.createElement("div");
      const put = (into, raw, whole) => { const l = parseLine(raw); if (whole && !into.textContent) { setKind(into, l.k); if (l.in) into.dataset.in = String(l.in); if (l.k === "ck") into.dataset.done = l.done ? "1" : "0"; holder.innerHTML = inline(l.body); } else holder.innerHTML = inline(raw); for (const br of [...into.querySelectorAll("br")]) br.remove(); into.append(...holder.childNodes); };
      put(line, rows[0], true);
      let last = line;
      for (const raw of rows.slice(1)) { holder.innerHTML = lineHtml(parseLine(raw)); const made = holder.firstElementChild; last.after(made); last = made; }
      const endAt = last.textContent.length; last.append(rest);
      for (const l of [line, last]) tidy(l);
      caret(last, endAt);
    }
    function kinds(k) {
      const lines = chosen(); if (!lines.length) return;
      const sel = selNow(), all = lines.every((l) => l.dataset.k === k);
      for (const l of lines) setKind(l, all ? "p" : k);
      place(sel);
    }
    function tick(line) { if (!line || line.dataset.k !== "ck") return; line.dataset.done = line.dataset.done === "1" ? "0" : "1"; changed("tick"); onTick(line.dataset.done === "1"); }
    /** The keyboard and the caret are in the note again (a button on the format bar took them, or nothing had them). */
    function back() {
      const s = doc.getSelection();
      if (doc.activeElement === el && s.rangeCount && el.contains(s.anchorNode)) return;
      el.focus({ preventScroll: true });
      if (held) place(held); else if (!(s.rangeCount && el.contains(s.anchorNode)) && el.lastElementChild) caret(el.lastElementChild, el.lastElementChild.textContent.length);
    }
    const linkNow = () => { const s = doc.getSelection(); return s.rangeCount && el.contains(s.anchorNode) ? (s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentNode).closest("a") : null; };
    function cmd(name, value) {
      back();
      if (name === "undo") { step(-1); return; }
      if (name === "redo") { step(1); return; }
      if (name === "bold" || name === "italic") { try { doc.execCommand(name); } catch { /* not here */ } changed("format"); return; }
      if (name === "heading") { const line = chosen()[0], k = line?.dataset.k; if (line) { const sel = selNow(); setKind(line, k === "h2" ? "h3" : k === "h3" ? "p" : "h2"); place(sel); } changed("format"); return; }
      if (["h2", "h3", "ul", "ol", "ck"].includes(name)) { kinds(name); changed("format"); return; }
      if (name === "tick") { tick(chosen()[0]); return; }
      if (name === "unlink") { const a = linkNow(); if (a) { const sel = selNow(); a.replaceWith(...a.childNodes); place(sel); } changed("format"); return; }
      if (name === "link") {
        let url = String(value || "").trim(); if (!url) return;
        if (!/^(?:https?:\/\/|mailto:)/i.test(url)) url = /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(url) ? `mailto:${url}` : `https://${url}`;
        if (!safeUrl(url)) return;
        const a = linkNow(), s = doc.getSelection();
        if (a) { if (a.dataset.bare) a.textContent = url; a.setAttribute("href", url); }
        else if (s.isCollapsed) { const made = doc.createElement("a"); made.setAttribute("href", url); made.dataset.bare = "1"; made.textContent = url; const r = s.getRangeAt(0); r.insertNode(made); const after = doc.createRange(); after.setStartAfter(made); after.collapse(true); s.removeAllRanges(); s.addRange(after); }
        else { try { doc.execCommand("createLink", false, url); } catch { /* not here */ } }
        changed("format");
      }
    }
    const api = { el, note: "", cmd,
      text: () => cur,
      /** A note is shown. `keep`: the same note, changed elsewhere: Undo's steps and the caret stay as near as they can. */
      set(text, keep = false) { const sel = keep ? selNow() : null; render(String(text ?? "")); cur = String(text ?? ""); if (keep && hist[at]) { hist.length = at + 1; hist.push({ md: cur, sel, kind: "done", t: 0, t0: 0 }); at = hist.length - 1; if (sel) place(sel); } else { hist = [{ md: cur, sel: null, kind: "done", t: 0, t0: 0 }]; at = 0; held = null; } },
      focus(end = true) { el.focus({ preventScroll: true }); if (end && el.lastElementChild) caret(el.lastElementChild, el.lastElementChild.textContent.length); },
      /** Where the caret is: bold, italic, the kind of its line, the link it is in (and the words chosen). */
      state() {
        const s = doc.getSelection(), inside = !!s && s.rangeCount > 0 && el.contains(s.anchorNode), line = inside ? where(s.anchorNode, s.anchorOffset)?.[0] : null; let bold = false, italic = false;
        if (inside) { try { bold = doc.queryCommandState("bold"); italic = doc.queryCommandState("italic"); } catch { /* neither */ } }
        return { inside, bold, italic, k: line?.dataset.k || "", link: inside ? linkNow()?.getAttribute("href") || "" : "", words: inside && !s.isCollapsed, undo: at > 0, redo: at < hist.length - 1 };
      },
      /** The caret is remembered (a field outside the note is about to take the keyboard). */
      hold() { held = selNow() || held; }, resume: back };
    el.addEventListener("beforeinput", (e) => {
      const type = e.inputType;
      if (type === "historyUndo" || type === "historyRedo") { e.preventDefault(); step(type === "historyUndo" ? -1 : 1); }
      else if (type === "insertParagraph" || type === "insertLineBreak") { e.preventDefault(); split(); changed("edit"); }
      else if (type === "formatBold" || type === "formatItalic") { e.preventDefault(); cmd(type === "formatBold" ? "bold" : "italic"); }
      else if (type.startsWith("format") || type === "insertFromDrop" || type === "insertHorizontalRule" || type === "insertOrderedList" || type === "insertUnorderedList") e.preventDefault();
    });
    el.addEventListener("keydown", (e) => {
      const mod = e.ctrlKey || e.metaKey, s = doc.getSelection(), key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (e.isComposing || composing) return;
      if (mod && !e.altKey && key === "z") { e.preventDefault(); step(e.shiftKey ? 1 : -1); return; }
      if (mod && !e.altKey && !e.shiftKey && key === "y") { e.preventDefault(); step(1); return; }
      if (mod && !e.altKey && !e.shiftKey && (key === "b" || key === "i")) { e.preventDefault(); cmd(key === "b" ? "bold" : "italic"); return; }
      if (mod && e.altKey && !e.shiftKey && (e.code === "Digit1" || e.code === "Digit2")) { e.preventDefault(); kinds(e.code === "Digit1" ? "h2" : "h3"); changed("format"); return; }
      if (mod && e.shiftKey && !e.altKey && ["Digit7", "Digit8", "Digit9"].includes(e.code)) { e.preventDefault(); kinds({ Digit7: "ol", Digit8: "ul", Digit9: "ck" }[e.code]); changed("format"); return; }
      if (mod && e.key === "Enter") { e.preventDefault(); tick(chosen()[0]); return; }
      if (e.key === "Enter") { e.preventDefault(); split(); changed("edit"); return; }
      if (e.key === "Tab" && !mod && !e.altKey) { const lists = chosen().filter((l) => isList(l.dataset.k)); if (!lists.length) return; e.preventDefault(); const sel = selNow(); for (const l of lists) { const to = Math.max(0, Math.min(4, (Number(l.dataset.in) || 0) + (e.shiftKey ? -1 : 1))); if (to) l.dataset.in = String(to); else delete l.dataset.in; } place(sel); changed("format"); return; }
      if ((e.key === "Backspace" || e.key === "Delete") && !mod && !e.altKey && s.isCollapsed && el.contains(s.anchorNode)) {
        const spot = where(s.anchorNode, s.anchorOffset), line = spot?.[0]; if (!line) return;
        if (e.key === "Backspace" && spot[1] === 0) {
          e.preventDefault();
          const prev = line.previousElementSibling;
          if (line.dataset.k !== "p") { if (isList(line.dataset.k) && Number(line.dataset.in)) { const to = Number(line.dataset.in) - 1; if (to) line.dataset.in = String(to); else delete line.dataset.in; } else setKind(line, "p"); caret(line, 0); }
          else if (prev) { const end = prev.textContent.length; for (const br of [...prev.querySelectorAll("br")]) br.remove(); while (line.firstChild) prev.append(line.firstChild); line.remove(); tidy(prev); caret(prev, end); }
          changed("edit");
        } else if (e.key === "Delete" && spot[1] === line.textContent.length && line.nextElementSibling) {
          e.preventDefault();
          const next = line.nextElementSibling, end = line.textContent.length; for (const br of [...line.querySelectorAll("br")]) br.remove(); while (next.firstChild) line.append(next.firstChild); next.remove(); tidy(line); caret(line, end);
          changed("edit");
        }
      }
    });
    el.addEventListener("compositionstart", () => { composing = true; });
    el.addEventListener("compositionend", () => { composing = false; changed("type"); });
    el.addEventListener("input", (e) => { if (composing || e.isComposing) return; if (e.inputType === "insertText" && e.data) auto(e.data); changed(e.inputType === "insertText" ? "type" : "edit"); });
    el.addEventListener("paste", (e) => { e.preventDefault(); const text = e.clipboardData?.getData("text/plain") || ""; if (!text) return; back(); insert(text); changed("paste"); });
    el.addEventListener("drop", (e) => { e.preventDefault(); });
    // A tick box is drawn before its line (media/shared/notes.css): a press there ticks it and leaves the caret where it was.
    el.addEventListener("mousedown", (e) => { const line = lineAt(e.target); if (!line || line.dataset.k !== "ck" || e.button) return; const r = line.getBoundingClientRect(), from = r.left + (Number(line.dataset.in) || 0) * 16; if (e.clientX < from - 2 || e.clientX > from + 18) return; e.preventDefault(); tick(line); });
    el.addEventListener("click", (e) => { const a = e.target.closest?.("a"); if (!a || !el.contains(a)) return; e.preventDefault(); if (e.ctrlKey || e.metaKey) onLink(a.getAttribute("href") || ""); });
    el.addEventListener("blur", () => { held = selNow() || held; });
    doc.addEventListener("selectionchange", () => { if (el.isConnected && doc.activeElement === el) onState(); });
    render("");
    return api;
  }

  /**
   * Notes for Home.
   *   post(message)   to the host ({ type: "homeNotesDo", op, ... })
   *   say(text)       said aloud to a screen reader
   *   width()         how wide Home is
   *   redraw()        Home draws again (it calls fill for each Notes card it shows)
   *   openCard()      the Notes card opens whole; isOpen() whether it is
   *   tab             the one note a note's own editor tab shows (media/shared/notestab.js); "" on Home
   * fill(section, form) draws the card on Home ("s", "m", "l": the same field at every size) or the opened app ("full") in
   * place; heard(message) takes the host's messages.
   */
  function create({ doc = root.document, post, say = () => {}, width = () => 0, redraw = () => {}, openCard = () => {}, isOpen = () => false, tab = "" } = {}) {
    const view = doc.defaultView, me = newId();
    let S = { notes: [], folders: [], sort: "edited", shown: "", most: 2000, longest: 100000, binDays: 30, lock: { state: "none", left: 5, until: 0, digits: 0 } }, heard = false;
    // What is open, what is searched for (and what the host found for it), the menu and the question that are showing,
    // the note just deleted (for Undo), the new note not yet kept.
    const ui = { open: "", q: "", all: false, found: null, seq: 0, menu: null, ask: null, undo: "", fresh: "", listTop: 0, card: "", cardBlank: false };
    // The locked notes that are open on this page now: each was opened with the PIN here, and is shut again by its own
    // lock button, by Lock now, or when the host drops the key (ten minutes with nothing done, another window's Lock now).
    const opened = new Set();
    // The words of the notes opened here; the ones asked for and not yet answered; the ones that could not be read (why).
    const texts = new Map(), asked = new Set(), unread = new Map();
    // One editor for the card on Home and one for the opened card (a card drawn afresh takes its own again).
    const editors = {}, owners = {};
    let saveTimer = 0, dirty = "", undoTimer = 0, findTimer = 0, focusNext = "", lastTouch = 0, waitTick = 0;
    const send = (op, more = {}) => post?.({ type: "homeNotesDo", op, ...more });
    const draw = () => redraw();

    // ---- what there is ------------------------------------------------------------------------------------------------
    // (The card on Home's fresh note is no note until it has words: it is in no list and no count.)
    const blankCard = (n) => !!n.fresh && n.id === ui.card && n.id !== ui.fresh && !texts.get(n.id)?.text.trim();
    const live = () => S.notes.filter((n) => !n.deleted && !blankCard(n)), binned = () => S.notes.filter((n) => n.deleted).sort((a, b) => b.deleted - a.deleted);
    const noteOf = (id) => S.notes.find((n) => n.id === id) || null, folderOf = (id) => S.folders.find((f) => f.id === id) || null;
    /** The folder shown: "" (All notes), a folder, or "bin" (Recently deleted; a card on Home shows All notes then). */
    const shownNow = (grid) => (S.shown === "bin" ? (grid ? "" : "bin") : folderOf(S.shown) ? S.shown : "");
    const folderLabel = (id) => (id === "bin" ? "Recently deleted" : folderOf(id)?.name || "All notes");
    const countIn = (id) => live().filter((n) => !id || n.folder === id).length;
    const ordered = (rows) => [...rows].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)
      || (S.sort === "title" ? a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) || b.edited - a.edited : S.sort === "created" ? b.created - a.created : b.edited - a.edited));
    /** The list as it is shown: the folder's notes, or the ones found, pinned first, in the order chosen. */
    function listNow(grid) {
      const folder = shownNow(grid) === "bin" ? "" : shownNow(grid), searching = !!ui.q.trim(), found = ui.found;
      let rows = live().filter((n) => ui.all || !folder || n.folder === folder);
      if (searching) rows = found ? rows.filter((n) => found.rows.has(n.id)) : [];
      return { rows: ordered(rows), folder, searching, waiting: searching && !found };
    }
    /** A locked note whose words are out of sight here: notes are locked, or this one was not opened on this page. */
    const shut = (n) => !!n?.locked && !(S.lock.state === "unlocked" && opened.has(n.id));
    const need = (id) => { if (texts.has(id) || asked.has(id) || unread.has(id)) return; asked.add(id); send("open", { id }); };
    const full = () => live().length >= S.most;

    // ---- what each part draws ---------------------------------------------------------------------------------------------
    const headOf = (title, cap = "", right = "") => `<div class="hc-ch"><span class="hc-ct">${esc(title)}</span>${cap ? `<span class="hc-cap hc-cut">${cap}</span>` : ""}<span class="hc-sp"></span>${right}</div>`;
    /** Lock now: there while notes are unlocked (words in the opened app, the lock alone on a card). */
    const lockNowBtn = (words) => (S.lock.state !== "unlocked" ? "" : words ? '<button type="button" class="hc-lnk nt-locknow" data-fk="locknow" title="Lock every locked note now (Ctrl+Alt+L)">Lock now</button>'
      : `<button type="button" class="hc-btn hc-icon nt-locknow" data-fk="locknow" title="Lock every locked note now (Ctrl+Alt+L)" aria-label="Lock now">${svg(I.lock, 12)}</button>`);
    const newBtn = (words) => `<button type="button" class="hc-btn hc-solid hc-note-new" data-fk="new"${full() ? ` disabled title="${S.most} notes is the most. Delete one to add another."` : ' title="Start a new note"'}>${svg(I.plus, 11, 2.6)}${words}</button>`;
    const folderBtn = (folder) => `<button type="button" class="hc-btn nt-folder" data-fk="folder" aria-haspopup="menu" aria-expanded="${ui.menu?.kind === "folders"}" title="Folders: choose one, make one, or see Recently deleted">${svg(folder ? (folder === "bin" ? I.bin : I.folder) : I.all, 12)}<span>${esc(folderLabel(folder))}</span>${svg(I.chev, 10, 2.4)}</button>`;
    const searchBox = () => `<span class="nt-find">${svg(I.find, 12)}<input class="hc-field hc-note-find" type="search" data-fk="find" placeholder="Search notes" aria-label="Search notes" maxlength="200" autocomplete="off" spellcheck="false"></span>`;
    const SORT = { edited: "Last edited", created: "Created", title: "Title" };
    const sortBtn = () => `<button type="button" class="hc-btn hc-icon nt-sort" data-fk="sort" aria-haspopup="menu" aria-expanded="${ui.menu?.kind === "sort"}" title="Sort: ${SORT[S.sort].toLowerCase()}" aria-label="Sort: ${SORT[S.sort].toLowerCase()}">${svg(I.sort, 13)}</button>`;
    const whenOf = (n) => (S.sort === "created" ? day(n.created) : ago(n.edited));
    function row(n, on, o = {}) {
      const hit = o.q ? ui.found?.rows.get(n.id) : null, isOpen = n.locked && !shut(n); let line = n.locked ? (isOpen ? "Locked · open now" : hit?.inside ? "Locked · found inside" : "Locked") : hit?.line || n.line;
      // (The line the words were found in starts near them, so they show in a narrow column too.)
      if (hit?.line && !n.locked) { const at = line.toLowerCase().indexOf(String(o.q).trim().toLowerCase()); if (at > 14) line = `…${line.slice(at - 10)}`; }
      return `<button type="button" class="hc-li hc-note-row${on ? " on" : ""}" data-note="${esc(n.id)}" draggable="true" title="Open this note"${on ? ' aria-current="true"' : ""}><span class="hc-tx"><span class="hc-nm">${mark(n.title, o.q)}</span>`
        + `${o.bare ? "" : `<span class="hc-meta">${esc(whenOf(n))}${line ? ` · ${n.locked ? esc(line) : mark(line, o.q)}` : ""}</span>`}</span>`
        + `${n.locked ? `<span class="hc-note-pinmark nt-lockmark-row" data-open="${isOpen ? 1 : 0}" title="${isOpen ? "Locked · open now" : "Locked"}">${svg(isOpen ? I.unlocked : I.lock, 11)}</span>` : ""}${n.pinned ? `<span class="hc-note-pinmark" title="Pinned to the top">${pinSvg(true, 10)}</span>` : ""}</button>`;
    }
    const SHOWN_MOST = 300;
    function listHtml(l, on, o = {}) {
      if (l.waiting) return "";
      if (!l.rows.length) {
        if (!l.searching) return `<p class="hc-quiet">${l.folder ? `No notes in ${esc(folderLabel(l.folder))} yet.` : "No notes yet. New note starts one: its first line is its name."}</p>`;
        return `<p class="hc-quiet">No note${l.folder && !ui.all ? ` in ${esc(folderLabel(l.folder))}` : ""} has “${esc(ui.q.trim())}”.</p>${l.folder && !ui.all ? '<button type="button" class="hc-btn nt-searchall" data-fk="searchall">Search all notes</button>' : ""}`;
      }
      const shown = l.rows.slice(0, SHOWN_MOST), q = l.searching ? ui.q : "", pinned = shown.filter((n) => n.pinned), rest = shown.filter((n) => !n.pinned), groups = !l.searching && !o.bare && pinned.length > 0;
      const rows = (list) => list.map((n) => row(n, n.id === on, { q, bare: o.bare })).join("");
      return `<div class="hc-list">${groups ? `<span class="nt-grp">Pinned</span>${rows(pinned)}${rest.length ? '<span class="nt-grp">Notes</span>' : ""}${rows(rest)}` : rows(shown)}</div>`
        + (l.rows.length > shown.length ? `<p class="hc-fine nt-morenotes">The first ${SHOWN_MOST} of ${l.rows.length}. Search finds the rest.</p>` : "");
    }
    const fold = (id, name, icon, n, on) => `<button type="button" class="nt-fold${on ? " on" : ""}" data-folder="${esc(id)}" data-fk="fold:${esc(id)}"${on ? ' aria-current="true"' : ""} title="${esc(name)}">${svg(icon, 13)}<span class="nt-fn">${esc(name)}</span><span class="nt-n">${n}</span></button>`;
    function railHtml(folder) {
      return fold("", "All notes", I.all, countIn(""), folder === "")
        + S.folders.map((f) => `<span class="nt-foldrow">${fold(f.id, f.name, I.folder, countIn(f.id), folder === f.id)}${folder === f.id ? `<button type="button" class="hc-btn hc-icon nt-fold-more" data-fk="foldmore" aria-haspopup="menu" aria-expanded="${ui.menu?.kind === "foldmore"}" title="Rename or delete this folder" aria-label="Rename or delete ${esc(f.name)}">${svg(I.more, 12)}</button>` : ""}</span>`).join("")
        + `<button type="button" class="nt-fold nt-newfold" data-fk="newfold" title="Make a folder">${svg(I.plus, 12, 2.2)}<span class="nt-fn">New folder</span></button><span class="hc-sp"></span>`
        + `<button type="button" class="nt-fold nt-binfold${folder === "bin" ? " on" : ""}" data-folder="bin" data-fk="fold:bin"${folder === "bin" ? ' aria-current="true"' : ""} title="Deleted notes wait here for ${S.binDays} days">${svg(I.bin, 13)}<span class="nt-fn">Recently deleted</span><span class="nt-n">${binned().length}</span></button>`;
    }
    const left = (n) => { const days = Math.ceil((n.deleted + S.binDays * DAY - Date.now()) / DAY); return days > 1 ? `${days} days left` : days === 1 ? "1 day left" : "Deleted for good today"; };
    function binHtml(wide) {
      const rows = binned(), cap = rows.length ? `${plural(rows.length, "note")} · kept ${S.binDays} days, then gone for good` : "";
      const empty = `<button type="button" class="hc-btn nt-empty" data-fk="empty"${rows.length ? "" : " disabled"} title="Delete every note here for good">Empty now…</button>`;
      return `<div class="nt-deleted">${wide ? headOf("Recently deleted", cap, empty) : `${headOf("Recently deleted", "", empty)}${cap ? `<p class="hc-fine">${cap}</p>` : ""}`}`
        + (rows.length ? `<div class="hc-list">${rows.map((n) => `<div class="hc-li nt-drow" data-note="${esc(n.id)}"><span class="hc-tx"><span class="hc-nm">${esc(n.title)}</span><span class="hc-meta">${wide ? `Deleted ${esc(ago(n.deleted).toLowerCase())} · ` : ""}${left(n)}</span></span>`
          + `${n.locked ? `<span class="hc-note-pinmark" title="Locked">${svg(I.lock, 11)}</span>` : ""}<button type="button" class="hc-btn nt-restore" data-note="${esc(n.id)}" data-fk="restore:${esc(n.id)}" title="Put it back in ${esc(folderLabel(folderOf(n.was) ? n.was : ""))}">Restore</button>`
          + `<button type="button" class="hc-btn hc-icon nt-purge" data-note="${esc(n.id)}" data-fk="purge:${esc(n.id)}" title="Delete now, for good" aria-label="Delete ${esc(n.title)} now, for good">${svg(I.bin, 13)}</button></div>`).join("")}</div>` : '<p class="hc-quiet">Nothing here. A note you delete waits here before it is gone.</p>')
        + `<p class="hc-fine">A deleted note waits here for ${S.binDays} days and can be restored to the folder it was in. A locked note stays locked here.</p></div>`;
    }
    /** The question that is showing, in the card: a folder's name, what to do with a folder's notes, emptying the bin. */
    function askHtml() {
      const a = ui.ask; if (!a) return "";
      const cancel = '<button type="button" class="hc-btn" data-ask="cancel">Cancel</button>', err = a.error ? `<p class="nt-warn" role="alert">${esc(a.error)}</p>` : "";
      if (a.kind === "folderNew" || a.kind === "folderRename") return `<form class="nt-ask" data-kind="${a.kind}"><label class="nt-asklbl" for="nt-name">${a.kind === "folderNew" ? "New folder" : `Rename ${esc(folderLabel(a.id))}`}</label><div class="nt-askrow"><input id="nt-name" class="hc-field nt-name" data-fk="ask-name" maxlength="60" placeholder="Folder name" autocomplete="off"><button type="submit" class="hc-btn hc-solid" data-fk="ask-ok">${a.kind === "folderNew" ? "Create" : "Rename"}</button>${cancel}</div>${err}</form>`;
      if (a.kind === "folders") return `<div class="nt-ask" data-kind="folders"><span class="nt-asklbl">Folders</span>${S.folders.map((f) => `<div class="nt-askrow"><span class="hc-cut nt-askname">${esc(f.name)}</span><span class="hc-sp"></span><button type="button" class="hc-btn" data-ask="rename" data-id="${esc(f.id)}" data-fk="ren:${esc(f.id)}">Rename</button><button type="button" class="hc-btn" data-ask="delete" data-id="${esc(f.id)}" data-fk="del:${esc(f.id)}">Delete…</button></div>`).join("")}<div class="nt-askrow"><span class="hc-sp"></span><button type="button" class="hc-btn" data-ask="cancel" data-fk="ask-done">Close</button></div></div>`;
      if (a.kind === "folderDelete") { const n = countIn(a.id);
        return `<div class="nt-ask" data-kind="folderDelete" role="group" aria-label="Delete this folder"><span class="nt-asklbl">Delete the folder ${esc(folderLabel(a.id))}?</span>${n ? `<p class="hc-fine">It has ${plural(n, "note")}. They can stay with you in All notes, or go to Recently deleted.</p>` : ""}<div class="nt-askrow nt-wrap">`
          + (n ? `<button type="button" class="hc-btn hc-solid" data-ask="folder-keep" data-fk="ask-ok">Move ${n === 1 ? "its note" : "its notes"} to All notes</button><button type="button" class="hc-btn nt-danger" data-ask="folder-bin">Delete ${n === 1 ? "it" : "them"} too</button>` : '<button type="button" class="hc-btn hc-solid" data-ask="folder-keep" data-fk="ask-ok">Delete folder</button>') + `${cancel}</div></div>`; }
      if (a.kind === "empty") { const n = binned().length; return `<div class="nt-ask" data-kind="empty" role="group" aria-label="Empty Recently deleted"><span class="nt-asklbl">Delete ${n === 1 ? "this note" : `these ${n} notes`} for good?</span><p class="hc-fine">This cannot be undone.</p><div class="nt-askrow nt-wrap"><button type="button" class="hc-btn nt-danger" data-ask="empty-yes" data-fk="ask-ok">Delete ${plural(n, "note")}</button>${cancel}</div></div>`; }
      if (a.kind === "purge") return `<div class="nt-ask" data-kind="purge" role="group" aria-label="Delete this note for good"><span class="nt-asklbl">Delete “${esc(noteOf(a.id)?.title || "")}” for good?</span><p class="hc-fine">This cannot be undone.</p><div class="nt-askrow nt-wrap"><button type="button" class="hc-btn nt-danger" data-ask="purge-yes" data-fk="ask-ok">Delete now</button>${cancel}</div></div>`;
      return "";
    }
    const undoHtml = () => (ui.undo ? `<div class="hc-note-undo" role="status"><span>Note deleted. It waits in Recently deleted.</span><button type="button" class="hc-lnk hc-undo" data-fk="undo" title="Bring the note back">Undo</button></div>` : "");
    const mrow = (act, icon, label, o = {}) => `<button type="button" class="dgc-menu-row${o.on ? " is-selected" : ""}${o.danger ? " nt-danger" : ""}" role="${o.radio ? "menuitemradio" : "menuitem"}"${o.radio ? ` aria-checked="${!!o.on}"` : ""}${o.off ? " disabled" : ""} data-act="${act}"${o.id !== undefined ? ` data-id="${esc(o.id)}"` : ""}><span class="dgc-menu-icon">${icon ? svg(icon, 14) : ""}</span><span class="dgc-menu-label">${esc(label)}</span>${o.hint !== undefined ? `<span class="dgc-menu-hint">${esc(o.hint)}</span>` : ""}</button>`;
    const DIV = '<div class="dgc-menu-div" role="separator"></div>';
    function menuHtml(m, grid) {
      const folder = shownNow(grid), note = noteOf(m.note);
      if (m.kind === "folders") return mrow("folder", I.all, "All notes", { radio: true, on: folder === "", id: "", hint: countIn("") }) + S.folders.map((f) => mrow("folder", I.folder, f.name, { radio: true, on: folder === f.id, id: f.id, hint: countIn(f.id) })).join("")
        + DIV + mrow("folder-new", I.plus, "New folder…") + (S.folders.length ? mrow("folders-edit", I.pen, "Rename or delete a folder…") : "") + (folder === "bin" ? "" : mrow("folder-export", I.down, `Export ${folderLabel(folder)}…`, { id: folder, off: !countIn(folder) }))
        + DIV + mrow("folder", I.bin, "Recently deleted", { radio: true, on: folder === "bin", id: "bin", hint: binned().length });
      if (m.kind === "sort") return Object.keys(SORT).map((by) => mrow("sort", "", SORT[by], { radio: true, on: S.sort === by, id: by })).join("");
      if (m.kind === "foldmore") return mrow("folder-rename", I.pen, "Rename…", { id: m.id }) + mrow("folder-export", I.down, "Export…", { id: m.id, off: !countIn(m.id) }) + mrow("folder-delete", I.bin, "Delete…", { id: m.id, danger: true });
      if (m.kind === "move" && note) return mrow("move-to", I.all, "All notes", { radio: true, on: !note.folder, id: "" }) + S.folders.map((f) => mrow("move-to", I.folder, f.name, { radio: true, on: note.folder === f.id, id: f.id })).join("") + DIV + mrow("folder-new", I.plus, "New folder…");
      if (m.kind === "more" && note) return moreRows(note);
      return "";
    }
    /** A note's ⋯ menu. */
    function moreRows(note) {
      const lk = S.lock.state, lock = (lk === "unlocked" ? mrow("lock-now", I.lock, "Lock now", { hint: "Ctrl+Alt+L" }) : "") + (note.locked && (lk === "unlocked" || lk === "locked") ? mrow("lock-remove", I.unlocked, "Remove lock…") : "") + (lk === "unlocked" || lk === "locked" ? mrow("pin-change", I.pen, "Change PIN…") : "");
      return mrow("move", I.move, "Move to a folder…") + moreOpen(note) + (lock ? DIV + lock : "") + DIV + mrow("delete", I.bin, "Delete", { danger: true, hint: `kept ${S.binDays} days` });
    }
    /** Out of the card: a copy, the note's own editor tab, a .md file, the clipboard. A locked note must be open for them. */
    function moreOpen(note) {
      const off = note.fresh || shut(note), o = (more = {}) => ({ off, ...(off && !note.fresh ? { hint: "locked" } : more) });
      return mrow("duplicate", I.dup, "Duplicate", o({ hint: "Ctrl+D" })) + (tab ? "" : mrow("tab", I.tab, "Open in an editor tab", o())) + mrow("export", I.down, "Export as Markdown…", o()) + mrow("copy-plain", I.copy, "Copy text", o()) + mrow("copy-md", I.copy, "Copy as Markdown", o());
    }
    /** The open note's tools: Back (in a narrow side bar), when it was edited, pin, its lock, ⋯. (No Done: typing saves.) */
    function toolsHtml(note, o) {
      return `<div class="hc-note-tools">${o.back !== undefined ? `<button type="button" class="hc-lnk hc-note-all" data-fk="back" title="Back to ${esc(o.back)}">${svg(I.back, 12, 2.4)}${esc(o.back)}</button>` : ""}<span class="hc-cap hc-cut">${o.cap ? `Edited ${esc(ago(note.edited).toLowerCase())}` : ""}</span><span class="hc-sp"></span>`
        + `<button type="button" class="hc-btn hc-icon hc-note-pin" data-fk="pin" aria-pressed="${note.pinned}" title="${note.pinned ? "Unpin: let it fall back among the others" : "Pin to the top of your notes"}" aria-label="${note.pinned ? "Unpin this note" : "Pin this note to the top"}">${pinSvg(note.pinned)}</button>`
        + toolsMore(note)
        + `<button type="button" class="hc-btn hc-icon nt-more" data-fk="more" aria-haspopup="menu" aria-expanded="${ui.menu?.kind === "more"}" title="More: move, delete" aria-label="More for this note">${svg(I.more, 13)}</button></div>`;
    }
    /** The lock on the open note. A note with no lock: lock it. A locked note that is open: lock it again (its words go
     *  out of sight at once). A locked note that is shut: pressed, its pad is what opens it. (Remove lock is in ⋯.) A new
     *  note with no words yet has none. */
    function toolsMore(note) {
      if (note.fresh) return "";
      const closed = shut(note);
      const words = closed ? "Locked. Type your PIN to open it" : note.locked ? "Lock it again: its words go out of sight until your PIN opens it" : S.lock.state === "nokeychain" ? "This computer has no keychain, so notes cannot be locked here" : "Lock this note with your PIN";
      return `<button type="button" class="hc-btn hc-icon nt-lock" data-fk="lock" aria-pressed="${closed}" title="${words}" aria-label="${words}">${svg(closed || !note.locked ? I.lock : I.unlocked, 13)}</button>`;
    }
    // The format bar over a note: each button says whether it is on where the caret is. A Large card has the four used most.
    const FMT = { bold: [I.bold, "Bold (Ctrl+B)"], italic: [I.ital, "Italic (Ctrl+I)"], heading: [I.head, "Heading (Ctrl+Alt+1; a smaller one, Ctrl+Alt+2)"], ul: [I.ul, "Bulleted list (Ctrl+Shift+8)"], ol: [I.ol, "Numbered list (Ctrl+Shift+7)"],
      ck: [I.check, "Checklist (Ctrl+Shift+9; Ctrl+Enter ticks a line)"], link: [I.link, "Link (Ctrl+K)"], undo: [I.undo, "Undo (Ctrl+Z; redo, Ctrl+Shift+Z)"] };
    function fmtHtml(ed, compact) {
      const s = ed.state(), on = { bold: s.bold, italic: s.italic, heading: /^h/.test(s.k), ul: s.k === "ul", ol: s.k === "ol", ck: s.k === "ck", link: !!s.link };
      const b = (cmd) => `<button type="button" class="hc-btn hc-icon" data-cmd="${cmd}" data-fk="fmt:${cmd}"${cmd === "undo" ? (s.undo ? "" : " disabled") : ` aria-pressed="${!!on[cmd]}"`} title="${FMT[cmd][1]}" aria-label="${FMT[cmd][1]}">${svg(FMT[cmd][0], 13)}</button>`;
      return compact ? `<div class="nt-format nt-format-s" role="toolbar" aria-label="Formatting">${["bold", "italic", "ul", "ck"].map(b).join("")}</div>`
        : `<div class="nt-format" role="toolbar" aria-label="Formatting">${b("bold")}${b("italic")}${b("heading")}<i class="nt-sep"></i>${b("ul")}${b("ol")}${b("ck")}<i class="nt-sep"></i>${b("link")}<span class="hc-sp"></span>${b("undo")}</div>`;
    }
    const linkHtml = () => { const k = ui.link; return `<form class="nt-ask nt-linkform"><label class="nt-asklbl" for="nt-url">${k.had ? "Change the link" : k.words ? "Link the chosen words to" : "Add a link"}</label><div class="nt-askrow nt-wrap"><input id="nt-url" class="hc-field nt-url" data-fk="url" maxlength="2000" placeholder="An address, like example.org/page" autocomplete="off" spellcheck="false"><button type="submit" class="hc-btn hc-solid" data-fk="url-ok">${k.had ? "Change" : "Add"}</button>${k.had ? '<button type="button" class="hc-btn" data-link="remove">Remove link</button>' : ""}<button type="button" class="hc-btn" data-link="cancel">Cancel</button></div></form>`; };
    /** The format bar (or, while a link is being added, its address field) of a card's open note. */
    function fmtDraw(st) { if (!st.r.fmt) return; set(st.r.fmt, st.body !== "doc" ? "" : ui.link?.st === st ? linkHtml() : st.mode === "card" ? "" : fmtHtml(st.editor, st.compact)); }
    function linkOpen(st) { const s = st.editor.state(); st.editor.hold(); ui.link = { st, had: s.link, words: s.words }; ui.menu = null; focusNext = "input.nt-url"; draw(); }
    function linkEnd(st, how, url) { ui.link = null; if (how === "add") st.editor.cmd("link", url); else if (how === "remove") st.editor.cmd("unlink"); else st.editor.resume(); draw(); }
    const limitHtml = () => (ui.limit ? `<p class="hc-fine nt-limit" role="status">A note holds ${S.longest.toLocaleString("en-US")} characters at most. What did not fit was not put in.</p>` : "");
    const underHtml = (note) => `<p class="hc-fine nt-meta">Created ${esc(day(note.created))} · Edited ${esc(ago(note.edited).toLowerCase())}${note.folder ? ` · in ${esc(folderLabel(note.folder))}` : ""}</p>`;

    // ---- drawing a card in place ------------------------------------------------------------------------------------------
    /** A part's inside, drawn again only when it changed; the keyboard, a field's words and where it was scrolled stay. */
    function set(el, html) {
      if (!el || el.__html === html) return;
      const a = doc.activeElement, inside = a && el.contains(a) ? a : null, fk = inside ? (inside.dataset.fk || (inside.classList.contains("hc-note-row") ? `row:${inside.dataset.note}` : "")) : "";
      const held = inside && inside.matches("input") ? { v: inside.value, s: inside.selectionStart, e: inside.selectionEnd } : null, top = el.scrollTop;
      el.__html = html; el.innerHTML = html;
      if (top) el.scrollTop = top;
      if (!fk) return;
      const again = fk.startsWith("row:") ? el.querySelector(`.hc-note-row[data-note="${fk.slice(4)}"]`) : el.querySelector(`[data-fk="${view.CSS.escape(fk)}"]`);
      if (!again) return;
      if (held) again.value = held.v;
      again.focus({ preventScroll: true });
      if (held) { try { again.setSelectionRange(held.s, held.e); } catch { /* a field with no caret to place */ } }
    }
    const PARTS = { tab: "ask pane", card: "top pane foot", m: "top ask undo list foot", l: "top ask undo main:list,pane foot", wide: "top ask undo main:rail,list,pane", list: "top ask undo list", note: "top undo pane", wbin: "top ask main:rail,bin", nbin: "top ask bin" };
    const PART = { top: '<div class="nt-top"></div>', ask: '<div class="nt-askbox"></div>', undo: '<div class="nt-undobox"></div>', list: '<div class="nt-listbox hc-notes-list"></div>', foot: '<div class="nt-footbox"></div>', bin: '<div class="nt-binbox"></div>', rail: '<nav class="nt-rail" aria-label="Folders"></nav>',
      pane: '<div class="hc-note-pane nt-pane"><div class="nt-toolsbox"></div><div class="nt-fmtbox"></div><div class="nt-body"></div><div class="nt-under"></div></div>' };
    function build(section, st, mode) {
      if (st.mode === "list") ui.listTop = st.r.list?.scrollTop || 0;
      // (A note being typed in keeps the keyboard and its caret when the layout changes under it: the side bar's edge dragged.)
      st.resume = !!st.editor && doc.activeElement === st.editor.el; if (st.resume) st.editor.hold();
      // (And so does whatever else of the card had the keyboard: the PIN pad, the search field, a row.)
      const had = doc.activeElement; st.refocus = !focusNext && !st.resume && had && section.contains(had) ? (had.dataset.fk ? `[data-fk="${had.dataset.fk}"]` : had.classList.contains("hc-note-row") ? `.hc-note-row[data-note="${had.dataset.note}"]` : "") : "";
      st.mode = mode; st.body = "";
      section.innerHTML = PARTS[mode].split(" ").map((part) => (part.startsWith("main:") ? `<div class="nt-main nt-main-${mode}">${part.slice(5).split(",").map((p) => PART[p]).join("")}</div>` : PART[part])).join("") + '<div class="nt-pop"></div>';
      const q = (sel) => section.querySelector(sel);
      st.r = { top: q(".nt-top"), ask: q(".nt-askbox"), undo: q(".nt-undobox"), list: q(".nt-listbox"), foot: q(".nt-footbox"), bin: q(".nt-binbox"), rail: q(".nt-rail"), pane: q(".nt-pane"), tools: q(".nt-toolsbox"), fmt: q(".nt-fmtbox"), body: q(".nt-body"), under: q(".nt-under"), pop: q(".nt-pop") };
      section.dataset.notes = mode;
    }
    /** The open note's own part: its tools, its words (typed in place), what is under them. */
    function pane(st, note, o) {
      const r = st.r;
      if (!note) { set(r.tools, ""); set(r.under, ""); if (o.card) { st.body = "none"; set(r.fmt, ""); r.body.__html = null; set(r.body, ""); return; } st.body = st.body === "doc" ? "" : st.body; set(r.fmt, ""); if (st.body !== "none") { st.body = "none"; r.body.__html = null; } set(r.body, `<p class="hc-quiet">${live().length ? "No note is open. Choose one, or start a new one." : ""}</p>`); return; }
      set(r.tools, o.card ? "" : toolsHtml(note, o));
      set(r.under, limitHtml() + (o.under ? underHtml(note) : ""));
      st.compact = !!o.compact;
      if (!bodyFor(st, note, o)) { fmtDraw(st); return; }
      const text = texts.get(note.id);
      if (!text) {
        need(note.id);
        const lost = unread.has(note.id) ? '<p class="hc-quiet" role="status">This note’s words cannot be read: its file is missing or damaged. Its title is all that is left here.</p>' : "";
        if (st.body !== "wait" || r.body.__html !== lost) { st.body = "wait"; r.body.__html = null; set(r.body, lost); }
        fmtDraw(st); return;
      }
      const key = st.key; owners[key] = st;
      const ed = st.editor = editors[key] || (editors[key] = createEditor({ doc, onInput: typed, longest: () => S.longest, onState: () => fmtDraw(owners[key]), onLink: (href) => send("link", { url: href }),
        onTick: (done) => say(done ? "Done." : "Not done."), onLimit: () => { ui.limit = true; say(`A note holds ${S.longest.toLocaleString("en-US")} characters at most.`); draw(); } }));
      if (st.body !== "doc") { st.body = "doc"; r.body.__html = null; r.body.replaceChildren(ed.el); if (st.resume && ed.note === note.id) ed.resume(); }
      st.resume = false;
      if (ed.note !== note.id) { ed.note = note.id; ed.set(text.text); }
      else if (dirty !== note.id && ed.text() !== text.text) ed.set(text.text, true);
      fmtDraw(st);
    }
    /** What stands in place of a note's words (a locked note's PIN pad). True: nothing does, its words are shown. */
    function bodyFor(st, note) {
      const k = pinFor(note); if (!k) return true;
      if (st.body === "doc") { st.editor.set(""); st.editor.note = ""; }
      st.body = "lock"; set(st.r.body, k.mode === "msg" ? lockMsgHtml(k) : pinHtml(note, k));
      return false;
    }

    // ---- the lock: a PIN pad in place of a note's words ----------------------------------------------------------------
    // The digits typed are held here (never drawn: the dots only count them) and sent with the lock's own messages.
    const pinNew = (mode, note, more = {}) => ({ mode, note, typed: "", first: "", old: "", long: false, msg: "", ...more });
    /** The PIN screen that stands in for this note: the one being answered, or (a locked note while notes are locked) the pad that opens it. */
    function pinFor(note) {
      const lk = S.lock.state;
      if (ui.pin && ui.pin.note === note.id) { if (ui.pin.mode === "open" && !shut(note)) ui.pin = null; else return ui.pin; }
      if (shut(note)) return (ui.pin = pinNew(lk === "locked" || lk === "unlocked" ? "open" : "nokey", note.id));
      return null;
    }
    const waitLeft = () => Math.max(0, Math.ceil((S.lock.until - Date.now()) / 1000));
    const lockedAll = () => S.notes.filter((n) => n.locked);
    const LOCKMARK = `<span class="nt-lockmark">${svg(I.lock, 22, 1.6)}</span>`;
    const lockMsgHtml = (k) => `<div class="nt-lockbox" role="group" aria-label="Locking notes">${LOCKMARK}<h3>Notes cannot be locked here</h3><p>${k.why === "nokey" ? "The key for your locked notes is not on this computer, so no more can be locked here." : "This computer has no keychain, so notes cannot be locked here."}</p><p class="hc-fine">A lock keeps its key in the system keychain. Without one DGC would only pretend to lock a note, so it locks nothing.</p><div class="nt-row"><button type="button" class="hc-btn" data-pin="cancel" data-fk="pin-cancel">Back to the note</button></div></div>`;
    function pinHtml(note, k) {
      const lk = S.lock, n = lockedAll().length, others = live().filter((x) => !x.locked).length, title = esc(note.title);
      const forgot = `<button type="button" class="hc-btn nt-danger" data-pin="forgot-next" data-fk="pin-forgot">Delete ${plural(n, "locked note")}…</button>`;
      if (k.mode === "nokey") return `<div class="nt-lockbox" role="group" aria-label="Locked note">${LOCKMARK}<h3>${title}</h3><p>The key for your locked notes is not on this computer. It is kept in the system keychain of the computer where they were locked, so they cannot be opened here.</p><div class="nt-row">${forgot}</div><p class="hc-fine">Deleting them cannot be undone: they do not go to Recently deleted.</p></div>`;
      if (k.mode === "forgot") return `<div class="nt-lockbox" role="group" aria-label="Forgot PIN">${LOCKMARK}<h3>Forgot your PIN?</h3><p>DGC cannot open a locked note without its PIN, and neither can anyone else: there is no reset and no back door.</p><p>You can delete your <b>${plural(n, "locked note")}</b> and start over with a new PIN. Your other ${plural(others, "note")} ${others === 1 ? "stays as it is" : "stay as they are"}.</p>`
        + `<div class="nt-row"><button type="button" class="hc-btn hc-solid" data-pin="retry" data-fk="pin-retry">Try the PIN again</button>${forgot}</div><p class="hc-fine">Deleting them cannot be undone: they do not go to Recently deleted.</p></div>`;
      if (k.mode === "forgot2") { const all = lockedAll(); return `<div class="nt-lockbox" role="group" aria-label="Delete the locked notes">${LOCKMARK}<h3>Delete ${n === 1 ? "this locked note" : `these ${n} locked notes`} for good?</h3><ul class="nt-names">${all.slice(0, 8).map((x) => `<li>${esc(x.title)}</li>`).join("")}${all.length > 8 ? `<li>and ${all.length - 8} more</li>` : ""}</ul><p>They do not go to Recently deleted, and nobody can bring them back.</p>`
        + `<div class="nt-row"><button type="button" class="hc-btn nt-danger" data-pin="forgot-sure" data-fk="pin-sure">Delete ${plural(n, "locked note")}</button><button type="button" class="hc-btn" data-pin="${note.locked && lk.state === "nokey" ? "nokey" : "retry"}" data-fk="pin-retry">Cancel</button></div></div>`; }
      const asks = k.mode === "open" || k.mode === "lockfirst" || k.mode === "remove" || k.mode === "old", wait = asks ? waitLeft() : 0, setting = k.mode === "set1" || k.mode === "new1";
      const total = asks ? lk.digits || 4 : setting ? (k.long ? 8 : 4) : k.first.length, range = k.long ? "4 to 8 digits" : "4 digits";
      const T = { open: [title, `Type your ${lk.digits}-digit PIN to open it.`], lockfirst: ["Lock this note", `Type your ${lk.digits}-digit PIN to lock “${title}”.`], remove: ["Remove lock", `Type your PIN to remove the lock from “${title}”. It will be an ordinary note again, kept unencrypted.`],
        old: ["Change your PIN", "Type the PIN you have now."], new1: ["Change your PIN", `Choose a new PIN: ${range}.`], new2: ["Change your PIN", "Type the new PIN again."], set1: ["Choose a PIN", `One PIN locks every note you lock: ${range}.`], set2: ["Choose a PIN", "Type it again."] }[k.mode];
      const warn = wait ? `<p class="nt-warn" role="alert">Too many wrong tries. Try again in <b>${Math.floor(wait / 60)}:${String(wait % 60).padStart(2, "0")}</b>.</p>` : k.msg ? `<p class="nt-warn" role="alert">${esc(k.msg)}</p>` : "";
      const dots = `<div class="nt-dots${k.msg && !k.typed ? " nt-bad" : ""}" role="img" aria-label="${k.typed.length} of ${setting && k.long ? "up to 8" : total} digits typed">${Array.from({ length: total }, (_, i) => `<i${i < k.typed.length ? ' class="on"' : ""}></i>`).join("")}</div>`;
      const off = wait ? " disabled" : "", key = (d) => `<button type="button" class="hc-btn" data-digit="${d}" tabindex="-1"${off}>${d}</button>`;
      const pad = `<div class="nt-pad" tabindex="0" role="group" data-fk="pad" aria-label="PIN pad. The number keys type, Backspace takes one back."${wait ? ' data-off="1"' : ""}>${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(key).join("")}<span></span>${key(0)}<button type="button" class="hc-btn" data-digit="back" tabindex="-1" aria-label="Take the last digit back"${off}>${svg(I.del, 15)}</button></div>`;
      const next = setting && k.long ? `<div class="nt-row"><button type="button" class="hc-btn hc-solid" data-pin="next" data-fk="pin-next"${k.typed.length >= 4 ? "" : " disabled"}>Next</button></div>` : "";
      const cancel = '<button type="button" class="hc-btn" data-pin="cancel" data-fk="pin-cancel">Cancel</button>';
      const under = k.mode === "open" ? '<button type="button" class="hc-lnk" data-pin="forgot" data-fk="pin-forgot">Forgot PIN?</button><p class="hc-fine">Locked notes are encrypted on this computer. An opened note stays open until you lock it again, or ten minutes pass with nothing done in Notes.</p>'
        : setting ? `<div class="nt-row"><button type="button" class="hc-lnk" data-pin="longer" data-fk="pin-longer">${k.long ? "Use a 4-digit PIN" : "Use a longer PIN"}</button>${cancel}</div>`
          + (k.mode === "set1" ? '<p class="hc-fine">A forgotten PIN cannot be reset: DGC cannot open a locked note without it, and neither can anyone else.</p><p class="hc-fine">A locked note’s title stays readable: don’t put the secret in the first line.</p><details class="nt-help"><summary>What a PIN holds against</summary><p class="hc-fine">A locked note is encrypted on this computer, and its key is kept in the system keychain, wrapped by your PIN. That keeps the note from people near you and from files that leave this computer (a backup, a copied folder): they get ciphertext.</p><p class="hc-fine">It is not a safe against someone signed in as you on this computer: a program with your keychain could try every short PIN quickly. A longer PIN is slower to try.</p></details>' : "")
        : `<div class="nt-row">${k.mode === "remove" || k.mode === "lockfirst" ? '<button type="button" class="hc-lnk" data-pin="forgot" data-fk="pin-forgot">Forgot PIN?</button>' : ""}${cancel}</div>`;
      return `<div class="nt-lockbox${k.mode === "open" ? " nt-lock-open" : ""}" role="group" aria-label="${k.mode === "open" ? `Locked note: ${title}` : "PIN"}">${LOCKMARK}<h3>${T[0]}</h3>${warn || `<p>${T[1]}</p>`}${dots}${pad}${next}${under}</div>`;
    }
    /** A digit pressed (or "back"); a PIN of the length asked for goes on by itself. */
    function pinPress(d) {
      const k = ui.pin; if (!k || !["open", "lockfirst", "remove", "old", "new1", "new2", "set1", "set2"].includes(k.mode) || k.busy) return;
      const asks = k.mode === "open" || k.mode === "lockfirst" || k.mode === "remove" || k.mode === "old", setting = k.mode === "set1" || k.mode === "new1";
      if (asks && waitLeft()) return;
      if (d === "back") { k.typed = k.typed.slice(0, -1); draw(); return; }
      const total = asks ? S.lock.digits || 4 : setting ? (k.long ? 8 : 4) : k.first.length;
      if (k.typed.length >= total) return;
      k.typed += d; k.msg = "";
      if (k.typed.length === total && !(setting && k.long)) pinGo(); else draw();
    }
    /** What was typed goes on: to the host (to be tried, or kept), or to "type it again". */
    function pinGo() {
      const k = ui.pin, pin = k.typed; if (!k || pin.length < 4) return;
      k.typed = "";
      if (k.mode === "open" || k.mode === "lockfirst") { k.busy = true; send("unlock", { pin }); }
      else if (k.mode === "remove") { k.busy = true; send("unlockNote", { id: k.note, pin, by: me }); }
      else if (k.mode === "old") { k.old = pin; k.mode = "new1"; }
      else if (k.mode === "set1" || k.mode === "new1") { k.first = pin; k.mode = k.mode === "set1" ? "set2" : "new2"; }
      else if (pin !== k.first) { k.first = ""; k.mode = k.mode === "set2" ? "set1" : "new1"; k.msg = "Those two were not the same. Choose a PIN again."; say(k.msg); }
      else if (k.mode === "set2") { k.busy = true; k.first = ""; send("lockSet", { pin, id: k.note, by: me }); }
      else { k.busy = true; k.first = ""; const old = k.old; k.old = ""; send("lockChange", { old, pin }); }
      focusNext = ".nt-pad"; draw();
    }
    function pinDo(what) {
      const k = ui.pin; if (!k) return;
      if (what === "cancel") { ui.pin = null; focusNext = '[data-fk="lock"]'; }
      else if (what === "forgot") { k.mode = "forgot"; k.typed = ""; focusNext = '[data-fk="pin-retry"]'; }
      else if (what === "forgot-next") { k.mode = "forgot2"; focusNext = '[data-fk="pin-retry"]'; }
      else if (what === "retry") { if (shut(noteOf(k.note))) { k.mode = "open"; focusNext = ".nt-pad"; } else ui.pin = null; }
      else if (what === "nokey") k.mode = "nokey";
      else if (what === "forgot-sure") { k.busy = true; send("lockForgot", { sure: true }); }
      else if (what === "longer") { k.long = !k.long; k.typed = ""; focusNext = ".nt-pad"; }
      else if (what === "next") { pinGo(); return; }
      draw();
    }
    /** A locked note that is open here is shut: its words leave this page; with none left open, the host drops the key. */
    function relock(id) {
      opened.delete(id); texts.delete(id); asked.delete(id);
      if (!opened.size) send("lockNow");
    }
    /** The lock button on a note: lock it (choosing a PIN the first time); an open locked note is locked again, at once. */
    function lockPress(note) {
      const lk = S.lock.state; flush();
      if (note.locked) { if (!shut(note)) { relock(note.id); say("Locked."); } ui.menu = null; ui.link = null; focusNext = ".nt-pad, [data-fk='pin-cancel']"; draw(); return; }
      else if (lk === "nokeychain" || lk === "nokey") ui.pin = pinNew("msg", note.id, { why: lk });
      else if (lk === "none") ui.pin = pinNew("set1", note.id);
      else if (lk === "unlocked") { send("lockNote", { id: note.id, by: me }); say("Locked."); focusNext = ".nt-pad"; return; }
      else ui.pin = pinNew("lockfirst", note.id);
      ui.menu = null; ui.link = null; focusNext = ".nt-pad, [data-fk='pin-cancel']"; draw();
    }
    /** Out of the card: Duplicate, Open in an editor tab, Export, Copy. What was typed is kept first. */
    function out(act, note) {
      if (note.fresh || shut(note)) return;
      flush();
      if (act === "duplicate") { if (full()) { say(`${S.most} notes is the most. Delete one to add another.`); return; } send("duplicate", { id: note.id, newId: newId(), by: me }); }
      else if (act === "tab") send("tab", { id: note.id });
      else if (act === "export") send("export", { id: note.id });
      else send("copy", { id: note.id, as: act === "copy-md" ? "md" : "plain" });
    }
    function lockNow() { if (S.lock.state !== "unlocked") return; flush(); if (noteOf(ui.open)?.locked) focusNext = ".nt-pad"; for (const id of [...opened]) { texts.delete(id); asked.delete(id); } opened.clear(); send("lockNow"); say("Locked."); draw(); }
    function fill(section, form) {
      const st = section.__nt || (section.__nt = { mode: "", r: {}, editor: null, body: "", key: form === "tab" ? "tab" : form === "full" ? "open" : "grid" });
      wire(section);
      if (form === "tab") { fillTab(section, st); return; }
      if (form !== "full") { fillCard(section, st); return; }
      const grid = false, wide = width() >= 560, folder = shownNow(grid), l = listNow(grid);
      const cur = noteOf(ui.open), open = cur && !cur.deleted ? cur : wide && folder !== "bin" ? l.rows[0] || null : null;
      const mode = folder === "bin" ? (wide ? "wbin" : "nbin") : wide ? "wide" : open ? "note" : "list";
      if (st.mode !== mode) build(section, st, mode);
      const r = st.r, count = live().length;
      // The top: the card's name, the folder button, New, search and sort (which of them, and where, is the layout's).
      const top = mode === "wide" || mode === "wbin" ? `${headOf("Notes", `${plural(count, "note")} · kept on this computer`, lockNowBtn(true))}<div class="hc-notes-bar">${searchBox()}${sortBtn()}${newBtn("New note")}</div>`
        : mode === "list" ? `${headOf("Notes", S.lock.state === "unlocked" ? plural(count, "note") : `${plural(count, "note")} · kept on this computer`, lockNowBtn(true))}<div class="hc-notes-bar">${folderBtn(folder)}<span class="hc-sp"></span>${newBtn("New note")}</div><div class="hc-notes-bar">${searchBox()}${sortBtn()}</div>`
        : mode === "note" ? headOf("Notes", esc(folderLabel(open.folder)), lockNowBtn(true))
        : headOf("Notes", "", `<button type="button" class="hc-lnk hc-note-all" data-fk="back" title="Back to all your notes">${svg(I.back, 12, 2.4)}All notes</button>`);
      set(r.top, top);
      const find = r.top.querySelector("input.hc-note-find"); if (find && doc.activeElement !== find && find.value !== ui.q) find.value = ui.q;
      set(r.ask, askHtml()); set(r.undo, undoHtml());
      if (r.rail) set(r.rail, railHtml(folder));
      if (r.list) { set(r.list, listHtml(l, open?.id || "")); if (mode === "list" && ui.listTop) { r.list.scrollTop = ui.listTop; ui.listTop = 0; } }
      if (r.bin) set(r.bin, binHtml(wide));
      if (r.pane) pane(st, open, { back: mode === "note" ? folderLabel(folder) : undefined, cap: mode === "wide", under: true });
      menuDraw(section, st, grid);
      if (ui.ask && !r.ask) ui.ask = null;
      focusAfter(section, st);
    }
    // ---- the card on Home: only a field, a new-note icon and Open Notes ----------------------------------------------------
    /** The note the card's field holds: the one last typed there; at first, the note edited last (never a locked one,
     *  whose words stay behind its PIN in the app); a fresh one when there is none, or after the new-note icon. */
    function cardNote() {
      const cur = noteOf(ui.card);
      if (cur && !cur.deleted && !cur.locked) return cur;
      if (!heard) return null;
      ui.card = "";
      const last = ui.cardBlank ? null : live().filter((n) => !n.locked && !n.fresh).sort((a, b) => b.edited - a.edited)[0];
      if (last) { ui.card = last.id; return last; }
      if (full()) return null;
      const id = newId(), now = Date.now(), made = { id, title: "New note", line: "", folder: "", created: now, edited: now, pinned: false, locked: false, deleted: 0, fresh: true };
      S.notes.unshift(made); texts.set(id, { text: "" }); ui.card = id; ui.cardBlank = false;
      return made;
    }
    /** The new-note icon: what was typed is kept, and the field is a fresh note's. */
    function cardStart() {
      flush();
      const cur = noteOf(ui.card);
      if (!(cur && cur.fresh && !texts.get(cur.id)?.text.trim())) {
        if (full()) { say(`${S.most} notes is the most. Delete one to add another.`); return; }
        ui.card = ""; ui.cardBlank = true; say("A new note.");
      }
      focusNext = "doc"; draw();
    }
    function fillCard(section, st) {
      if (st.mode !== "card") build(section, st, "card");
      const r = st.r, note = cardNote();
      set(r.top, headOf("Notes", "", `<button type="button" class="hc-btn hc-icon hc-note-new" data-fk="new"${full() ? ` disabled title="${S.most} notes is the most. Delete one to add another."` : ' title="New note: what you typed stays in Notes"'} aria-label="New note">${svg(I.plus, 13)}</button>`));
      set(r.foot, '<span class="hc-sp"></span><button type="button" class="hc-lnk nt-openapp" data-fk="openapp" title="Open Notes: every note, folders, search and locks">Open Notes</button>');
      pane(st, note, { card: true });
      const empty = !!note && st.body === "doc" && !st.editor.text();
      if (r.body.dataset.empty !== (empty ? "1" : "0")) r.body.dataset.empty = empty ? "1" : "0";
      if (st.body === "doc" && st.editor.el.getAttribute("aria-label") !== "Note: saved as you type") st.editor.el.setAttribute("aria-label", "Note: saved as you type");
      menuDraw(section, st, true);
      focusAfter(section, st);
    }
    /** A note's own editor tab: the note alone, at the tab's width. Deleted meanwhile, it says so and offers it back. */
    function fillTab(section, st) {
      if (st.mode !== "tab") build(section, st, "tab");
      const r = st.r, note = noteOf(tab);
      set(r.ask, askHtml());
      if (note && !note.deleted) { ui.open = note.id; if (doc.title !== note.title) doc.title = note.title; pane(st, note, { cap: true, under: true }); }
      else {
        if (st.body === "doc") { st.editor.set(""); st.editor.note = ""; }
        st.body = "gone"; set(r.tools, ""); set(r.fmt, ""); set(r.under, "");
        set(r.body, !heard ? "" : note ? `<div class="nt-lockbox" role="group" aria-label="Deleted note"><h3>This note is in Recently deleted</h3><p>“${esc(note.title)}” waits there for ${S.binDays} days, then it is deleted for good.</p><div class="nt-row"><button type="button" class="hc-btn hc-solid nt-tab-restore" data-fk="restore">Restore</button></div></div>`
          : '<div class="nt-lockbox" role="group" aria-label="Note"><h3>This note is gone</h3><p>It was deleted for good. This tab can be closed.</p></div>');
      }
      menuDraw(section, st, false);
      focusAfter(section, st);
    }
    function focusAfter(section, st) {
      // (What had the keyboard before the layout changed takes it again, if it is still there; once.)
      if (st.refocus) { const again = focusNext ? null : section.querySelector(st.refocus); st.refocus = ""; again?.focus({ preventScroll: true }); }
      if (focusNext && section.checkVisibility?.() !== false) {
        const target = focusNext === "doc" ? null : section.querySelector(focusNext);
        if (focusNext === "doc" && st.body === "doc") { focusNext = ""; st.editor.focus(); }
        else if (target) { focusNext = ""; target.focus({ preventScroll: true }); if (target.matches("input.nt-url")) target.value = ui.link?.had || ""; if (target.matches("input.nt-name, input.nt-url")) target.select(); }
      }
    }
    /** The menu that is open, under the button that opened it, inside the card. */
    function menuDraw(section, st, grid) {
      const m = ui.menu, pop = st.r.pop;
      if (!m || m.section !== section) { if (pop.__html) { pop.__html = ""; pop.innerHTML = ""; } return; }
      const html = `<div class="dgc-menu nt-menu" role="menu" aria-label="${esc(m.label)}">${menuHtml(m, grid)}</div>`;
      if (pop.__html !== html) { pop.__html = html; pop.innerHTML = html; }
      const menu = pop.firstElementChild, by = section.querySelector(`[data-fk="${m.by}"]`);
      if (!by) { ui.menu = null; pop.__html = ""; pop.innerHTML = ""; return; }
      const box = section.getBoundingClientRect(), b = by.getBoundingClientRect(), w = Math.min(232, box.width - 16);
      menu.style.width = `${w}px`; menu.style.top = `${b.bottom - box.top + 4}px`;
      menu.style.left = `${Math.max(8, Math.min(m.right ? b.right - box.left - w : b.left - box.left, box.width - w - 8))}px`;
      if (m.fresh) { m.fresh = false; (menu.querySelector('[aria-checked="true"]') || menu.querySelector(".dgc-menu-row"))?.focus({ preventScroll: true }); }
    }
    function menuOpen(section, kind, by, more = {}) {
      if (ui.menu?.kind === kind && ui.menu.section === section) { menuClose(true); return; }
      ui.menu = { kind, section, by, fresh: true, label: { folders: "Folders", sort: "Sort", more: "This note", move: "Move to a folder", foldmore: "This folder" }[kind] || "Menu", right: kind !== "folders", ...more };
      draw();
    }
    function menuClose(focus) { const m = ui.menu; if (!m) return; ui.menu = null; if (focus) focusNext = `[data-fk="${m.by}"]`; draw(); }
    const onDown = (e) => { if (ui.menu && !e.target.closest?.(".nt-menu, [aria-haspopup='menu']")) menuClose(false); };
    doc.addEventListener("pointerdown", onDown, true);

    // ---- what is done ------------------------------------------------------------------------------------------------------
    /** A note's words as typed: here at once, and to the host once the typing rests. */
    function typed(id, text) {
      const n = noteOf(id); if (!n || n.deleted) return;
      ui.limit = false; texts.set(id, { text }); n.title = titleOf(text); n.line = n.locked ? "" : lineOf(text); n.edited = Date.now(); dirty = id;
      view.clearTimeout(saveTimer); saveTimer = view.setTimeout(flush, 500);
      draw();
    }
    /** What was typed goes to the host now. A new note with no words yet is not kept. */
    function flush() {
      view.clearTimeout(saveTimer); saveTimer = 0;
      const id = dirty, n = noteOf(id), t = texts.get(id); dirty = "";
      if (!n || !t) return;
      if (n.fresh) { if (!t.text.trim()) return; if (ui.fresh === id) ui.fresh = ""; delete n.fresh; send("save", { id, text: t.text, by: me, folder: n.folder }); }
      else send("save", { id, text: t.text, by: me });
    }
    /** A new note left with no words is not a note. */
    function dropFresh() {
      const id = ui.fresh; if (!id) return;
      if (texts.get(id)?.text.trim()) { flush(); return; }
      ui.fresh = ""; S.notes = S.notes.filter((n) => n.id !== id); texts.delete(id); if (dirty === id) { dirty = ""; view.clearTimeout(saveTimer); saveTimer = 0; } if (ui.open === id) ui.open = "";
    }
    function start(section) {
      if (full()) { say(`${S.most} notes is the most. Delete one to add another.`); return; }
      flush(); dropFresh();
      if (S.shown === "bin") { S.shown = ""; send("shown", { folder: "" }); }
      const id = newId(), now = Date.now();
      S.notes.unshift({ id, title: "New note", line: "", folder: shownNow(false), created: now, edited: now, pinned: false, locked: false, deleted: 0, fresh: true });
      texts.set(id, { text: "" });
      Object.assign(ui, { fresh: id, open: id, q: "", found: null, all: false, menu: null, ask: null }); focusNext = "doc";
      // (Opening the card puts the keyboard on Back: the new note takes it again, to be typed in at once.)
      if (isOpen()) draw(); else { openCard(); focusNext = "doc"; draw(); }
    }
    function show(id, section) {
      if (ui.open !== id) { flush(); dropFresh(); }
      ui.open = id; if (!shut(noteOf(id))) need(id);
      draw();
    }
    function remove(id) {
      const n = noteOf(id); if (!n || n.deleted) return;
      if (dirty === id) { view.clearTimeout(saveTimer); saveTimer = 0; dirty = ""; }
      if (ui.open === id) ui.open = "";
      if (ui.fresh === id) { ui.fresh = ""; S.notes = S.notes.filter((x) => x.id !== id); texts.delete(id); draw(); return; }
      n.deleted = Date.now(); n.was = n.folder; n.folder = ""; n.pinned = false;
      send("delete", { id, by: me });
      ui.undo = id; view.clearTimeout(undoTimer); undoTimer = view.setTimeout(() => { ui.undo = ""; draw(); }, 8000);
      say(`Note deleted. It waits in Recently deleted for ${S.binDays} days. Undo brings it back.`);
      focusNext = '[data-fk="undo"]'; draw();
    }
    function undo() { const id = ui.undo; if (!id) return; ui.undo = ""; view.clearTimeout(undoTimer); { const n = noteOf(id); if (n) { n.deleted = 0; n.folder = folderOf(n.was) ? n.was : ""; } } send("restore", { id }); say("The note is back."); focusNext = `.hc-note-row[data-note="${id}"]`; draw(); }
    function setShown(folder) {
      if (folder !== "bin" && folder && !folderOf(folder)) return;
      flush(); dropFresh();
      if (S.shown !== folder) { S.shown = folder; send("shown", { folder }); }
      const cur = noteOf(ui.open); if (cur && folder && cur.folder !== folder) ui.open = "";
      ui.all = false; ui.ask = null; if (ui.q.trim()) search(true);
    }
    /** What is searched for is asked of the host (it reads the notes' words; this page holds one note's only). */
    function search(now) {
      view.clearTimeout(findTimer);
      const go = () => { findTimer = 0; if (!ui.q.trim()) return; const f = shownNow(false); send("search", { q: ui.q, folder: ui.all ? "" : f === "bin" ? "" : f, seq: ++ui.seq }); };
      if (!ui.q.trim()) { ui.found = null; ui.all = false; return; }
      if (now) go(); else findTimer = view.setTimeout(go, 120);
    }
    function done(section) {
      const st = section.__nt, id = st.body === "doc" && st.editor?.note ? st.editor.note : ui.open;
      flush(); if (tab) return;
      dropFresh();
      if (section.__nt.mode === "note") ui.open = "";
      focusNext = id && noteOf(id) ? `.hc-note-row[data-note="${id}"]` : '[data-fk="new"]'; draw();
    }
    function askFolder(kind, id = "") { ui.menu = null; ui.ask = { kind, id, error: "" }; focusNext = kind === "folderNew" || kind === "folderRename" ? "input.nt-name" : '[data-fk="ask-ok"], [data-fk="ask-done"]'; if (!isOpen() && kind !== "folderNew") { openCard(); return; } draw(); }
    function chosen(act, id, section) {
      const m = ui.menu, note = noteOf(m?.note);
      if (act === "folder") { menuClose(true); setShown(id); if (id === "bin" && !isOpen()) openCard(); else draw(); return; }
      if (act === "folder-new") { ui.moving = m?.kind === "move" ? m.note : ""; askFolder("folderNew"); return; }
      if (act === "folders-edit") { askFolder("folders"); return; }
      if (act === "folder-rename") { askFolder("folderRename", id); return; }
      if (act === "folder-delete") { askFolder("folderDelete", id); return; }
      if (act === "sort") { if (S.sort !== id) { S.sort = id; send("sort", { by: id }); } menuClose(true); return; }
      if (act === "move" && note) { ui.menu = { ...m, kind: "move", label: "Move to a folder", fresh: true }; draw(); return; }
      if (act === "move-to" && note) { if (note.folder !== id) { note.folder = id; send("move", { id: note.id, folder: id }); say(`Moved to ${folderLabel(id)}.`); } menuClose(true); return; }
      if (act === "delete" && note) { ui.menu = null; remove(note.id); return; }
      choose(act, id, note, section);
    }
    function choose(act, id, note) {
      if (act === "lock-now") { ui.menu = null; lockNow(); draw(); return; }
      if (act === "lock-remove" && note?.locked) { ui.menu = null; flush(); ui.pin = pinNew("remove", note.id); focusNext = ".nt-pad"; draw(); return; }
      if (act === "folder-export") { send("exportFolder", { folder: id }); menuClose(true); return; }
      if (note && ["duplicate", "tab", "export", "copy-plain", "copy-md"].includes(act)) { out(act, note); menuClose(true); return; }
      if (act === "pin-change" && note) { ui.menu = null; flush(); ui.pin = pinNew("old", note.id); focusNext = ".nt-pad"; draw(); return; }
      menuClose(true);
    }
    function answered(what, id, section) {
      const a = ui.ask; if (!a) return;
      if (what === "cancel") { ui.ask = null; focusNext = '[data-fk="folder"], [data-fk="newfold"], [data-fk="empty"]'; draw(); return; }
      if (what === "rename") { askFolder("folderRename", id); return; }
      if (what === "delete") { askFolder("folderDelete", id); return; }
      if (what === "folder-keep" || what === "folder-bin") { const name = folderLabel(a.id); send("folderDelete", { id: a.id, ...(what === "folder-bin" ? { notes: "delete" } : {}) }); if (S.shown === a.id) S.shown = ""; S.folders = S.folders.filter((f) => f.id !== a.id); ui.ask = null; say(`The folder ${name} is deleted.`); focusNext = '[data-fk="folder"], [data-fk="fold:"]'; draw(); return; }
      if (what === "empty-yes") { send("empty"); ui.ask = null; say("Recently deleted is empty."); draw(); return; }
      if (what === "purge-yes") { send("purge", { id: a.id }); ui.ask = null; say("Deleted for good."); draw(); }
    }
    function named(form) {
      const a = ui.ask, name = form.querySelector("input.nt-name").value.replace(/\s+/g, " ").trim().slice(0, 60); if (!a) return;
      if (!name) { a.error = "Give the folder a name."; draw(); return; }
      if (S.folders.some((f) => f.id !== a.id && f.name.toLowerCase() === name.toLowerCase())) { a.error = "There is a folder with that name already."; draw(); return; }
      if (a.kind === "folderNew") {
        const id = newId(); S.folders = [...S.folders, { id, name }]; send("folderNew", { id, name });
        // Made from a note's Move menu: the note goes in it. Otherwise it is the folder shown.
        const moving = noteOf(ui.moving); ui.moving = "";
        if (moving) { moving.folder = id; send("move", { id: moving.id, folder: id }); say(`Moved to ${name}.`); } else { S.shown = id; send("shown", { folder: id }); ui.open = ""; say(`The folder ${name} is made.`); }
      } else { const f = folderOf(a.id); if (f) f.name = name; send("folderRename", { id: a.id, name }); say(`Renamed to ${name}.`); }
      ui.ask = null; focusNext = '[data-fk="folder"], [data-fk="newfold"]'; draw();
    }

    // ---- a card's own listeners -------------------------------------------------------------------------------------------
    function wire(section) {
      if (section.__ntWired) return; section.__ntWired = true;
      section.addEventListener("click", (e) => {
        const t = e.target, st = section.__nt; if (!st?.mode || !t.closest) return;
        const mrow = t.closest(".nt-menu .dgc-menu-row"), rowEl = t.closest(".hc-note-row"), ask = t.closest("[data-ask]"), paneNote = noteOf(st.editor && st.body === "doc" ? st.editor.note : ui.open);
        if (mrow) { chosen(mrow.dataset.act, mrow.dataset.id ?? "", section); return; }
        if (ask) { answered(ask.dataset.ask, ask.dataset.id || "", section); return; }
        if (t.closest(".hc-note-new")) { if (st.mode === "card") cardStart(); else start(section); return; }
        if (rowEl) { show(rowEl.dataset.note, section); return; }
        if (t.closest(".nt-folder")) { menuOpen(section, "folders", "folder"); return; }
        if (t.closest(".nt-sort")) { menuOpen(section, "sort", "sort"); return; }
        if (t.closest(".nt-fold-more")) { menuOpen(section, "foldmore", "foldmore", { id: shownNow(false) }); return; }
        if (t.closest(".nt-newfold")) { askFolder("folderNew"); return; }
        if (t.closest(".nt-fold")) { setShown(t.closest(".nt-fold").dataset.folder); draw(); return; }
        if (t.closest(".nt-openapp")) { openCard(); return; }
        if (t.closest(".hc-undo")) { undo(); return; }
        if (t.closest(".nt-searchall")) { ui.all = true; search(true); focusNext = "input.hc-note-find"; draw(); return; }
        if (t.closest(".nt-restore")) { const id = t.closest(".nt-restore").dataset.note; if (full()) { say(`${S.most} notes is the most. Delete one to restore this.`); return; } const n = noteOf(id); if (n) { n.deleted = 0; n.folder = folderOf(n.was) ? n.was : ""; } send("restore", { id }); say("Restored."); focusNext = '[data-fk^="restore:"], [data-fk="back"], [data-fk="fold:bin"]'; draw(); return; }
        if (t.closest(".nt-purge")) { ui.ask = { kind: "purge", id: t.closest(".nt-purge").dataset.note }; focusNext = '[data-fk="ask-ok"]'; draw(); return; }
        if (t.closest(".nt-empty")) { ui.ask = { kind: "empty" }; focusNext = '[data-fk="ask-ok"]'; draw(); return; }
        if (t.closest(".nt-locknow")) { lockNow(); return; }
        if (t.closest(".nt-tab-restore")) { if (full()) { say(`${S.most} notes is the most. Delete one to restore this.`); return; } const n = noteOf(tab); if (n) { n.deleted = 0; n.folder = folderOf(n.was) ? n.was : ""; } send("restore", { id: tab }); say("Restored."); focusNext = "doc"; draw(); return; }
        if (t.closest(".hc-note-all")) { if (st.mode === "nbin") { setShown(""); focusNext = '[data-fk="folder"]'; draw(); } else done(section); return; }
        if (!paneNote) return;
        if (t.closest(".hc-note-pin")) { paneNote.pinned = !paneNote.pinned; if (!paneNote.fresh) send("pin", { id: paneNote.id, on: paneNote.pinned }); say(paneNote.pinned ? "Pinned to the top." : "Unpinned."); draw(); return; }
        if (t.closest(".nt-more")) { menuOpen(section, "more", "more", { note: paneNote.id }); return; }
        clicked(t, paneNote, section, e);
      });
      section.addEventListener("submit", (e) => { const form = e.target.closest("form.nt-ask"); if (!form) return; e.preventDefault(); if (form.classList.contains("nt-linkform")) linkEnd(section.__nt, "add", form.querySelector("input.nt-url").value); else named(form); });
      // A press on the format bar leaves the caret, and what is chosen, in the note.
      section.addEventListener("mousedown", (e) => { if (e.target.closest?.(".nt-format button")) e.preventDefault(); });
      section.addEventListener("input", (e) => { const t = e.target; if (t.matches?.("input.hc-note-find")) { ui.q = t.value.slice(0, 200); if (!ui.q.trim()) { ui.found = null; ui.all = false; } search(false); draw(); } });
      // Anything done in Notes keeps unlocked notes open (the host locks them after ten minutes with nothing done).
      const touch = () => { if (S.lock.state !== "unlocked" || Date.now() - lastTouch < 30000) return; lastTouch = Date.now(); send("touch"); };
      section.addEventListener("pointerdown", touch, true); section.addEventListener("keydown", touch, true);
      section.addEventListener("focusout", (e) => { if (e.target.classList?.contains("nt-doc") && !section.contains(e.relatedTarget)) flush(); });
      section.addEventListener("keydown", (e) => {
        const t = e.target, st = section.__nt; if (!st?.mode || e.defaultPrevented) return;
        const menu = t.closest?.(".nt-menu");
        if (menu) { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); menuClose(true); return; } root.DgcMenu?.handle(menu, e, { close: (viaEscape) => menuClose(!!viaEscape), trigger: () => section.querySelector(`[data-fk="${ui.menu?.by}"]`) }); return; }
        if (e.key === "Escape") {
          if (ui.menu) { e.preventDefault(); e.stopPropagation(); menuClose(true); }
          else if (ui.pin && ui.pin.mode !== "open" && ui.pin.mode !== "nokey" && t.closest(".nt-lockbox")) { e.preventDefault(); e.stopPropagation(); pinDo(ui.pin.mode === "forgot" || ui.pin.mode === "forgot2" ? "retry" : "cancel"); }
          else if (ui.link && t.closest(".nt-linkform")) { e.preventDefault(); e.stopPropagation(); linkEnd(st); }
          else if (ui.ask && t.closest(".nt-ask")) { e.preventDefault(); e.stopPropagation(); answered("cancel"); }
          else if (t.matches?.("input.hc-note-find") && t.value) { e.preventDefault(); e.stopPropagation(); t.value = ""; ui.q = ""; ui.found = null; ui.all = false; draw(); }
          else if (st.mode === "card") { if (t.classList?.contains("nt-doc")) { e.preventDefault(); e.stopPropagation(); flush(); t.blur(); } }
          else if (t.classList?.contains("nt-doc") || st.mode === "note") { e.preventDefault(); e.stopPropagation(); done(section); }
          else if (st.mode === "nbin") { e.preventDefault(); e.stopPropagation(); setShown(""); focusNext = '[data-fk="folder"]'; draw(); }
          return;
        }
        if (keyed(e, t, section)) return;
        if (t.matches?.("input, textarea") || t.isContentEditable) { if (e.key === "ArrowDown" && t.matches("input.hc-note-find")) { const first = section.querySelector(".hc-note-row"); if (first) { e.preventDefault(); first.focus(); } } return; }
        if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey) { const find = section.querySelector("input.hc-note-find"); if (find) { e.preventDefault(); find.focus(); find.select(); } return; }
        const rowEl = t.closest?.(".hc-note-row"); if (!rowEl) return;
        if (e.key === "ArrowDown" || e.key === "ArrowUp") { const rows = [...section.querySelectorAll(".hc-note-row")], to = rows[rows.indexOf(rowEl) + (e.key === "ArrowDown" ? 1 : -1)]; e.preventDefault(); if (to) { to.focus(); to.scrollIntoView?.({ block: "nearest" }); } else if (e.key === "ArrowUp") section.querySelector("input.hc-note-find")?.focus(); }
        else if (e.key === "Delete") { e.preventDefault(); const rows = [...section.querySelectorAll(".hc-note-row")], next = rows[rows.indexOf(rowEl) + 1] || rows[rows.indexOf(rowEl) - 1]; remove(rowEl.dataset.note); if (next) focusNext = `.hc-note-row[data-note="${next.dataset.note}"]`; draw(); }
      });
      // A row dragged onto a folder (the wide layout's rail) moves the note there.
      section.addEventListener("dragstart", (e) => { const rowEl = e.target.closest?.(".hc-note-row"); if (!rowEl) return; section.__nt.drag = rowEl.dataset.note; try { e.dataTransfer.setData("text/plain", noteOf(rowEl.dataset.note)?.title || ""); e.dataTransfer.effectAllowed = "move"; } catch { /* the drag still names its note here */ } });
      const over = (e) => { const f = e.target.closest?.(".nt-fold[data-folder]"); return f && section.__nt.drag && f.dataset.folder !== "bin" ? f : null; };
      section.addEventListener("dragover", (e) => { const f = over(e); for (const x of section.querySelectorAll(".nt-drop")) if (x !== f) x.classList.remove("nt-drop"); if (!f) return; e.preventDefault(); f.classList.add("nt-drop"); });
      section.addEventListener("dragend", () => { section.__nt.drag = ""; for (const x of section.querySelectorAll(".nt-drop")) x.classList.remove("nt-drop"); });
      section.addEventListener("drop", (e) => { const f = over(e), n = noteOf(section.__nt.drag); section.__nt.drag = ""; if (!f || !n) return; e.preventDefault(); f.classList.remove("nt-drop"); if (n.folder !== f.dataset.folder) { n.folder = f.dataset.folder; send("move", { id: n.id, folder: n.folder }); say(`Moved to ${folderLabel(n.folder)}.`); draw(); } });
    }
    /** A click in the open note's part that is none of the above; a key that is the note's. (More of both below.) */
    function clicked(t, note, section) {
      const st = section.__nt, cmd = t.closest(".nt-format [data-cmd]"), link = t.closest("[data-link]"), digit = t.closest(".nt-pad [data-digit]"), pin = t.closest("[data-pin]");
      if (digit) { pinPress(digit.dataset.digit); section.querySelector(".nt-pad")?.focus({ preventScroll: true }); return; }
      if (pin) { pinDo(pin.dataset.pin); return; }
      if (t.closest(".nt-lock")) { lockPress(note); return; }
      if (cmd && st.editor) { if (cmd.dataset.cmd === "link") linkOpen(st); else st.editor.cmd(cmd.dataset.cmd); return; }
      if (link && ui.link) linkEnd(st, link.dataset.link);
    }
    function keyed(e, t, section) {
      const st = section.__nt, mod = e.ctrlKey || e.metaKey, key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (mod && e.altKey && e.code === "KeyL") { e.preventDefault(); lockNow(); return true; }
      if (ui.pin && t.closest?.(".nt-lockbox") && !mod && !e.altKey) {
        if (/^[0-9]$/.test(e.key)) { e.preventDefault(); pinPress(e.key); return true; }
        if (e.key === "Backspace") { e.preventDefault(); pinPress("back"); return true; }
        if (e.key === "Enter" && t.closest(".nt-pad")) { e.preventDefault(); pinGo(); return true; }
      }
      if (t.classList?.contains("nt-doc") && mod && !e.altKey && !e.shiftKey && key === "k") { e.preventDefault(); linkOpen(st); return true; }
      if (t.classList?.contains("nt-doc") && mod && !e.altKey && !e.shiftKey && key === "d" && st.mode !== "card") { e.preventDefault(); const n = noteOf(st.editor.note); if (n) out("duplicate", n); return true; }
      return false;
    }

    return {
      fill,
      /** The host's messages: the list, one note's words, what a search found, a note changed elsewhere. */
      heard(m) {
        if (m?.type === "homeNotes") {
          const mine = S.notes.filter((n) => n.fresh), typing = dirty && saveTimer ? noteOf(dirty) : null;
          const notes = (Array.isArray(m.notes) ? m.notes : []).filter((n) => n && typeof n.id === "string").map((n) => ({ id: n.id, title: String(n.title || "New note"), line: String(n.line || ""), folder: String(n.folder || ""), created: Number(n.created) || 0, edited: Number(n.edited) || 0, pinned: n.pinned === true, locked: n.locked === true, deleted: Number(n.deleted) || 0, was: String(n.was || "") }));
          S = { notes, folders: (Array.isArray(m.folders) ? m.folders : []).filter((f) => f && typeof f.id === "string").map((f) => ({ id: f.id, name: String(f.name || "") })), sort: SORT[m.sort] ? m.sort : "edited", shown: typeof m.shown === "string" ? m.shown : "", most: Number(m.most) || 2000, longest: Number(m.longest) || 100000, binDays: Number(m.binDays) || 30,
            lock: { state: ["none", "locked", "unlocked", "nokey", "nokeychain"].includes(m.lock?.state) ? m.lock.state : "none", left: Number(m.lock?.left) || 0, until: Number(m.lock?.until) || 0, digits: Number(m.lock?.digits) || 4 } };
          for (const n of mine) if (!noteOf(n.id)) S.notes.unshift(n);
          // (A note's own tab was opened from the open note: it is open here too, the first time the host says so.)
          if (tab && !heard && S.lock.state === "unlocked" && noteOf(tab)?.locked) opened.add(tab);
          for (const id of [...opened]) if (!noteOf(id)?.locked) opened.delete(id);
          if (typing) { const n = noteOf(typing.id); if (n) Object.assign(n, { title: typing.title, line: typing.line, edited: typing.edited }); }
          heard = true;
          if (ui.open && (!noteOf(ui.open) || noteOf(ui.open).deleted)) ui.open = "";
          if (ui.undo && !noteOf(ui.undo)?.deleted) ui.undo = "";
          for (const id of [...texts.keys()]) if (!noteOf(id)) texts.delete(id);
          for (const id of [...unread.keys()]) if (!noteOf(id)) unread.delete(id);
          lockHeard(m);
          if (ui.q.trim()) search(true);
          draw();
        } else if (m?.type === "homeNoteText") {
          asked.delete(m.id);
          if (m.ok && typeof m.text === "string") { unread.delete(m.id); if (dirty !== m.id) texts.set(m.id, { text: m.text }); }
          else if (m.why !== "locked") unread.set(m.id, String(m.why || "gone"));      // (asked once: not again on every draw)
          draw();
        } else if (m?.type === "homeNotesFound") {
          if (m.seq !== ui.seq || !ui.q.trim()) return;
          ui.found = { q: m.q, rows: new Map((Array.isArray(m.rows) ? m.rows : []).map((r) => [r.id, { line: String(r.line || ""), inside: r.inside === true }])) };
          draw();
        } else if (m?.type === "homeNoteChanged") {
          // Changed in another page (a note's own tab, another window): its words are asked for again when it is open here.
          if (m.by === me || dirty === m.id) return;
          texts.delete(m.id); asked.delete(m.id); unread.delete(m.id);
          if (ui.open === m.id || tab === m.id) need(m.id);
          draw();
        } else if (m?.type === "homeNotesSaid") said(m);
      },
      /** Escape with the keyboard nowhere in the card: a menu or a question closes, an open note (or the bin) in a
       *  narrow side bar goes back to the list. False: there was nothing of Notes' to step back from. */
      back() {
        const section = [...doc.querySelectorAll(".hc-card.hc-note")].find((c) => c.__nt?.mode && c.checkVisibility?.()), mode = section?.__nt.mode;
        if (ui.menu) { menuClose(true); return true; }
        if (ui.ask) { answered("cancel"); return true; }
        if (mode === "note") { done(section); return true; }
        if (mode === "nbin") { setShown(""); focusNext = '[data-fk="folder"]'; draw(); return true; }
        return false;
      },
      start, closed() { flush(); dropFresh(); Object.assign(ui, { open: "", q: "", found: null, all: false, menu: null, ask: null, pin: null, link: null }); },
      count: () => live().length, top: () => ordered(live())[0] || null, heardYet: () => heard,
      flush, dispose() { flush(); view.clearTimeout(undoTimer); view.clearTimeout(findTimer); view.clearInterval(waitTick); doc.removeEventListener("pointerdown", onDown, true); },
    };
    /** How something the host was asked went. */
    function said(m) {
      if (m.op === "save" && m.ok === false && m.why === "full") { say(`${S.most} notes is the most. Delete one to add another.`); return; }
      if (m.op === "duplicate" || m.op === "export" || m.op === "exportFolder" || m.op === "copy" || m.op === "tab") {
        const no = m.why === "locked" ? "Unlock the note first." : m.why === "full" ? `${S.most} notes is the most. Delete one to add another.` : m.why === "empty" ? "There is nothing here to export." : "That did not work.";
        if (!m.ok) say(no);
        else if (m.op === "duplicate") { if (tab) say("Duplicated. The copy is in Notes."); else { ui.open = m.id; focusNext = "doc"; say("Duplicated. This is the copy."); } }
        else if (m.op === "export") { if (m.saved) say("Exported. The file is not locked."); }
        else if (m.op === "exportFolder") { if (m.saved) say(`${plural(m.saved, "note")} exported in ${m.where}.${m.skipped ? ` ${plural(m.skipped, "locked note")} left out: unlock them to export them.` : ""}`); }
        else if (m.op === "copy") say("Copied.");
        draw(); return;
      }
      // A note locked (with the PIN already set): locked at once. Its words leave this page; the key is dropped when no
      // locked note is open here.
      if (m.op === "lockNote") {
        if (!m.ok) { say("That did not work."); return; }
        const id = String(m.id || ""); opened.delete(id); texts.delete(id); asked.delete(id);
        if (!opened.size) send("lockNow");
        if (ui.open === id || tab === id) focusNext = ".nt-pad";
        draw(); return;
      }
      const k = ui.pin; if (!k || !["unlock", "unlockNote", "lockSet", "lockChange", "lockForgot"].includes(m.op)) return;
      k.busy = false;
      if (m.ok) {
        const mode = k.mode; ui.pin = null; texts.delete(k.note); asked.delete(k.note);
        if (m.op === "unlock" && mode === "lockfirst") send("lockNote", { id: k.note, by: me });
        else if (m.op === "unlock") opened.add(k.note);                 // this note is open here now, and only this one
        if (m.op === "unlockNote") opened.delete(k.note);               // (no longer a locked note)
        // A PIN just set (or changed), a lock removed: the host holds the key for it; with nothing open here, it lets go.
        if (m.op !== "unlock" && m.op !== "lockForgot" && !opened.size) send("lockNow");
        say(m.op === "lockForgot" ? `${plural(Number(m.deleted) || 0, "locked note")} deleted.` : m.op === "lockChange" ? "Your PIN is changed." : m.op === "unlockNote" ? "The lock is removed from this note." : m.op === "lockSet" ? "Locked." : m.op === "unlock" && mode === "lockfirst" ? "Locked." : "Open.");
        focusNext = m.op === "lockSet" || (m.op === "unlock" && mode === "lockfirst") || (noteOf(k.note)?.locked && !opened.has(k.note)) ? ".nt-pad" : '[data-fk="lock"]';
      } else if (m.why === "nokeychain" || m.why === "nokey") { ui.pin = pinNew(k.mode === "open" ? "nokey" : "msg", k.note, { why: m.why }); focusNext = "[data-fk='pin-cancel']"; }
      else {
        // A wrong PIN (the wait, when there is one, is the state's): the pad is ready for another try.
        if (k.mode === "new2" || k.mode === "new1") k.mode = "old";
        const left = Number(m.left) || 0; k.typed = ""; k.msg = m.why === "wrong" && !(Number(m.until) > Date.now()) ? `Wrong PIN. ${left} ${left === 1 ? "try" : "tries"} left, then a 30 second wait.` : m.why === "wrong" || m.why === "wait" ? "" : "That did not work. Try again.";
        if (k.msg) say(k.msg); focusNext = ".nt-pad";
      }
      draw();
    }
    /** The lock as the host says it is now: locked notes' words leave this page when notes lock; a wait counts down. */
    function lockHeard() {
      if (S.lock.state !== "unlocked") opened.clear();
      for (const id of [...texts.keys()]) if (shut(noteOf(id))) { texts.delete(id); asked.delete(id); }
      if (S.lock.state !== "unlocked") {
        for (const id of [...texts.keys()]) if (noteOf(id)?.locked) { texts.delete(id); asked.delete(id); if (dirty === id) { dirty = ""; view.clearTimeout(saveTimer); saveTimer = 0; } }
        for (const card of doc.querySelectorAll(".hc-card.hc-note")) { const st = card.__nt; if (st?.editor && noteOf(st.editor.note)?.locked) { if (doc.activeElement === st.editor.el) focusNext = ".nt-pad"; st.editor.set(""); st.editor.note = ""; if (st.body === "doc") st.body = ""; } }
      }
      if (ui.pin && !noteOf(ui.pin.note)) ui.pin = null;
      view.clearInterval(waitTick); waitTick = 0;
      if (waitLeft()) waitTick = view.setInterval(() => { if (!waitLeft()) { view.clearInterval(waitTick); waitTick = 0; } if (ui.pin) draw(); }, 1000);
    }
  }

  root.DgcNotes = Object.freeze({ create, createEditor, titleOf, lineOf, plain, mark });
})();
