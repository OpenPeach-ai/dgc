// ChatDGC's screen: one conversation, the way a chat app shows one. The extension host (src/chatdgc.ts)
// speaks to dgc serve; this page only draws what it is told and posts what the user does. Everything a
// person or a model wrote is text or rendered Markdown (DgcMarkdown: no HTML, inert links), never markup.
(() => {
  "use strict";
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };
  const md = (text) => (window.DgcMarkdown?.render ? window.DgcMarkdown.render(String(text || "")) : null);
  window.DgcMarkdown?.setFavicons?.(false);      // no image ever loads from a link's site
  // Maths, as ChatGPT draws it: the Markdown leaves each formula as TeX in a placeholder, and KaTeX (loaded the first
  // time one shows) draws it in the conversation. A copied reply is built afresh, so it carries the TeX as written.
  window.DgcMarkdown?.setMath?.(true);
  let katexAsked = false;
  function renderMath(root) {
    const waiting = root.querySelectorAll(".md-math:not([data-drawn])");
    if (!waiting.length) return;
    if (!window.katex) { loadKatex(); return; }
    for (const node of waiting) {
      node.dataset.drawn = "";
      try {
        window.katex.render(node.dataset.tex || "", node, { displayMode: node.classList.contains("md-math-display"), throwOnError: false,
                                                          output: "htmlAndMathml", strict: "ignore", trust: false, maxSize: 20, maxExpand: 500 });
      } catch { /* it stays as written */ }
    }
  }
  function loadKatex() {
    if (katexAsked) return;
    katexAsked = true;
    const js = document.body.dataset.katex, css = document.body.dataset.katexCss;
    if (!js) return;
    if (css) { const link = document.createElement("link"); link.rel = "stylesheet"; link.href = css; document.head.append(link); }
    const script = document.createElement("script");
    script.src = js;
    script.addEventListener("load", () => { const log = document.getElementById("cd-log"); if (log) renderMath(log); });
    document.head.append(script);
  }

  const log = $("cd-log"), scroller = $("cd-scroll"), input = $("cd-input"), send = $("cd-send"), stop = $("cd-stop");
  // A formula drawn as soon as its reply is (or streams) on screen.
  let mathFrame = 0;
  new MutationObserver(() => { if (!mathFrame) mathFrame = requestAnimationFrame(() => { mathFrame = 0; renderMath(log); }); })
    .observe(log, { childList: true, subtree: true });
  const modelPick = $("cd-model"), thinkingPick = $("cd-thinking"), notice = $("cd-notice");
  // Web search is always there, as in ChatGPT: the model looks things up whenever an answer depends on it, so the box
  // has no switch for it (founder, 2026-10-18: "it anyway uses web, so let's not confuse users"). Settings -> Web
  // search -> Search in ChatDGC turns it off for every chat.
  const searchMode = () => "auto";
  const state = { conversation: null, messages: [], earlier: 0, busy: false, replyId: "", models: [], defaultModel: "", windows: [], breakdown: null,
                  model: "", thinking: "", opened: false, unavailable: "", searching: {}, pending: [], editing: "",
                  context: null, compacting: false, editingSummary: false, picks: {},
                  research: false, planAsked: false, countdowns: {}, lastSent: null, forgotten: new Set(), planEditing: "", steerDraft: "", open: new Set(),
                  projects: [], projectChats: null, projectChatsAsked: "", cardBusy: {}, cardEdit: {}, draftEdit: {}, outline: null };
  const PASTE_AS_FILE = 5000;          // characters: a longer paste becomes an attachment, as in the coding chat
  const IMAGE_SIDE = 2048;             // a pasted image is scaled to this, so it fits one frame
  const KIND_ICON = { image: "file-media", document: "file-text", text: "file-text", file: "file" };
  // How much the model thinks first: what each level is called, and what it costs, as the dial says it.
  const LEVELS = [["off", "Off", "Answers right away"], ["low", "Low", "Thinks briefly first"], ["medium", "Medium", "Thinks it through"],
                  ["high", "High", "Thinks hard: slower, more careful"], ["xhigh", "Extra high", "Thinks longest: slowest, most careful"]];

  // ---- scrolling: follow the reply while the reader is at the bottom
  let pinned = true;
  scroller.addEventListener("scroll", () => { pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48; });
  const follow = () => { if (pinned) scroller.scrollTop = scroller.scrollHeight; };
  // An open thinking box scrolls on its own (wheel, trackpad, or the keys once it has focus), and follows its words
  // while it's at its end. Moved off its end by the reader, it stays where they put it, and so does the chat: the
  // reply going on below doesn't pull what they're reading away. At its end, the wheel goes on to the chat as usual.
  const atEnd = (box) => box.scrollHeight - box.clientHeight - box.scrollTop < 4;
  log.addEventListener("scroll", (e) => {
    if (e.target instanceof HTMLElement && e.target.classList.contains("cd-thought") && !atEnd(e.target)) pinned = false;
  }, true);

  // ---- messages
  const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } };
  // ---- sources: only at the end of a reply, as the founder asked (2026-10-18): "mid-response source chips make it
  // difficult to read the responses". The words read as prose; a reply that used the web ends with its sources
  // (favicons and "Sources · N"), which open beside the chat. A favicon comes from Google's icon service, asked about
  // the origin only, as Work's panel does; with dgc.linkFavicons off (or when one fails) it's a globe, and nothing is asked.
  let favicons = false;
  const siteOf = (url) => hostOf(url).replace(/^www\./, "");
  function faviconNode(url) {
    const box = el("span", "cd-fav");
    const src = favicons ? window.DgcMarkdown?.faviconUrl?.(url) : "";
    if (!src) { box.append(icon("globe")); return box; }
    const img = el("img");
    img.alt = ""; img.width = img.height = 16; img.decoding = "async"; img.referrerPolicy = "no-referrer"; img.src = src;
    img.addEventListener("error", () => img.replaceWith(icon("globe")));
    box.append(img);
    return box;
  }
  // The model cites as it writes ("…in 1961 [2]."): the marks stay in the reply as kept, so its sources can say which
  // were cited, but they are taken out of what's read, with the space before them, and out of what's copied. A group
  // ("[1][3]", "[2, 4]") goes when any number in it is one of the reply's sources; a number in brackets in a reply
  // with no sources, or one that names none ("array[0]"), is the reply's own and stays. Never inside code.
  const CITE_MARKS = /([ \t ]*)(\[\d{1,3}(?:\s*,\s*\d{1,3})*\](?:[ \t ]*\[\d{1,3}(?:\s*,\s*\d{1,3})*\])*)([ \t ]*)/g;
  const knownSources = (sources) => new Set((Array.isArray(sources) ? sources : []).map((x) => String(x?.n)));
  const namesSource = (marks, known) => (marks.match(/\d{1,3}/g) || []).some((n) => known.has(n));
  /** What takes a mark's place, from the words on either side of it in its paragraph: nothing at the start or the end,
   *  or before punctuation ("Paris [1]." -> "Paris."); else one space where there was space ("Paris [1] and"). */
  function citeGap(before, after, spaced) {
    if (!before.trim() || !after.trim() || /^[.,;:!?)\]}”’"'…%]/.test(after)) return "";
    return spaced || (/\w$/.test(before) && /^\w/.test(after)) ? " " : "";
  }
  /** The marks out of a rendered reply: text outside code, links and maths, judged within its paragraph. */
  function uncite(node, sources) {
    const known = knownSources(sources);
    if (!known.size) return;
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, { acceptNode: (t) =>
      t.parentElement?.closest("pre, code, .md-link, .md-math") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
    const texts = [];
    for (let t = walker.nextNode(); t; t = walker.nextNode()) if (/\[\d/.test(t.nodeValue)) texts.push(t);
    const range = document.createRange();
    for (const t of texts) {
      const block = t.parentElement.closest("p, li, td, th, h1, h2, h3, h4, h5, h6, blockquote, dt, dd") || node;
      const found = [...t.nodeValue.matchAll(CITE_MARKS)].filter((m) => namesSource(m[2], known));
      for (const m of found.reverse()) {           // from the last, so each one's place is still where it was found
        range.setStart(block, 0); range.setEnd(t, m.index);
        const before = range.toString();
        range.setStart(t, m.index + m[0].length); range.setEnd(block, block.childNodes.length);
        t.replaceData(m.index, m[0].length, citeGap(before, range.toString(), !!(m[1] || m[3])));
      }
    }
  }
  /** The same, for a reply's Markdown as written (a report's Copy): outside code fences and code spans, by the line. */
  function uncitedText(text, sources) {
    const words = String(text || ""), known = knownSources(sources);
    if (!known.size) return words;
    const code = [...words.matchAll(/```[\s\S]*?(?:```|$)|`[^`\n]*`/g)].map((m) => [m.index, m.index + m[0].length]);
    return words.replace(CITE_MARKS, (all, pre, marks, post, at) => {
      if (!namesSource(marks, known) || code.some(([from, to]) => at < to && at + all.length > from)) return all;
      const before = words.slice(words.lastIndexOf("\n", at - 1) + 1, at), after = words.slice(at + all.length).split("\n")[0];
      return citeGap(before, after, !!(pre || post));
    });
  }
  /** One source as a card row: its favicon and site, its title (opens the page), and what the page says. */
  function sourceRow(source, tag = "li") {
    const row = el(tag, "cd-source");
    const top = el("div", "cd-source-site");
    top.append(faviconNode(source.url), el("span", "", siteOf(source.url)));
    const open = el("button", "cd-source-open", source.title || source.url);
    open.type = "button"; open.dataset.url = source.url; open.title = source.url;
    row.append(top, open);
    if (source.snippet) row.append(el("p", "cd-source-snippet", source.snippet));
    return row;
  }
  // Links in the Sources panel and the reader: they live outside the conversation.
  document.addEventListener("click", (e) => {
    const open = e.target.closest?.(".cd-panel [data-url], .cd-reader [data-url]");
    if (open) vscode.postMessage({ type: "openLink", target: open.dataset.url || "" });
  });
  function body(message, drafts) {
    const node = el("div", "text cd-body");
    const html = md(message.text);
    if (html === null) node.textContent = message.text || ""; else node.innerHTML = html;
    uncite(node, message.sources);
    if (drafts) { draftBlocks(node, message, drafts.live); chartBlocks(node, drafts.live); widgetBlocks(node, message, drafts.live); }
    return node;
  }

  /** The queries a reply ran on the chat's spreadsheets (ChatGPT's "View analysis"): each SQL and what it returned. */
  function analysisNode(message) {
    const queries = Array.isArray(message.queries) ? message.queries.filter((q) => q && typeof q.sql === "string") : [];
    if (!queries.length) return null;
    const box = el("details", "cd-analysis");
    if (state.open.has(`analysis:${message.id}`)) box.open = true;
    box.addEventListener("toggle", () => { if (box.open) state.open.add(`analysis:${message.id}`); else state.open.delete(`analysis:${message.id}`); });
    const summary = el("summary", "cd-analysis-summary");
    summary.append(icon("table"), el("span", "", `Analyzed the data \u00b7 ${queries.length} ${queries.length === 1 ? "query" : "queries"}`));
    box.append(summary);
    for (const q of queries) {
      const item = el("div", "cd-analysis-item");
      const code = el("pre", "cd-analysis-sql");
      code.textContent = q.sql;
      item.append(code);
      if (q.error) item.append(el("div", "cd-analysis-error", q.error));
      else if (Array.isArray(q.columns) && Array.isArray(q.rows)) {
        const table = el("table", "cd-analysis-table"), head = el("tr");
        for (const c of q.columns) head.append(el("th", "", String(c)));
        table.append(head);
        for (const row of q.rows.slice(0, 20)) {
          const tr = el("tr");
          for (const v of Array.isArray(row) ? row : []) tr.append(el("td", typeof v === "number" ? "num" : "", v === null ? "" : String(v)));
          table.append(tr);
        }
        item.append(table);
        const count = Number(q.count) || 0;
        if (q.more || count > 20) item.append(el("div", "cd-analysis-more", q.more ? `More than ${count} rows; the first 20 shown.` : `${count} rows; the first 20 shown.`));
      }
      box.append(item);
    }
    return box;
  }

  // ---- interactive answers (ChatGPT's): a widget, one self-contained HTML page, in a tab of its own beside the chat
  // (VS Code runs nothing in a frame inside this page, and this page runs only its own code). The card says what it
  // is, opens it, and shows its page.
  const hashOf = (text) => { let h = 5381; for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0; return h.toString(36); };
  function widgetTitle(html) {
    const m = /<title>([^<]{1,80})<\/title>/i.exec(html) || /<h[1-3][^>]*>([^<]{1,80})</i.exec(html);
    return (m?.[1] || "Interactive").replace(/\s+/g, " ").trim();
  }
  function widgetBlocks(node, message, live) {
    for (const pre of node.querySelectorAll('pre.code[data-language="widget"]')) {
      const html = decodeURIComponent(pre.querySelector(".copy[data-c]")?.dataset.c || "").replace(/\n$/, "");
      pre.replaceWith(live ? el("div", "cd-chart-pending", "Building an interactive answer…")
                           : widgetCard(message, html, { ref: `${message.id}:${hashOf(html)}`, title: widgetTitle(html), code: pre }));
    }
  }
  function widgetCard(message, html, { ref, title, id = "", code: pre, removed = false }) {
    // Laid out as a file or canvas card is: what it is, then Show code and Open; its page below when shown.
    const box = el("div", "cd-widget");
    box.dataset.ref = ref;
    const row = el("div", "cd-file cd-widget-card");
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", `Interactive: ${title}`);
    const mark = el("span", "cd-file-badge cd-widget-badge");
    mark.append(icon("play-circle"));
    if (removed) {
      // Deleted from the Library: its name stays, as a deleted file's does; nothing to open or show.
      row.dataset.removed = "";
      const gone = el("div", "cd-file-words");
      gone.append(el("strong", "cd-file-name cd-widget-title", title), el("small", "cd-file-meta cd-widget-note", "Deleted from your Library"));
      row.append(mark, gone);
      box.append(row);
      return box;
    }
    const words = el("div", "cd-file-words");
    words.append(el("strong", "cd-file-name cd-widget-title", title),
                 el("small", "cd-file-meta cd-widget-note", "Interactive \u00b7 opens in a tab beside the chat, with no network and nothing from your chats or VS Code"));
    const buttons = el("div", "cd-file-actions");
    const codeShown = state.open.has(`widgetcode:${ref}`);
    const show = el("button", "cd-chart-tool", codeShown ? "Hide code" : "Show code");
    show.type = "button";
    show.addEventListener("click", () => {
      if (state.open.has(`widgetcode:${ref}`)) state.open.delete(`widgetcode:${ref}`); else state.open.add(`widgetcode:${ref}`);
      update(message.id);
    });
    const open = el("button", "cd-continue cd-widget-open", "Open");
    open.type = "button";
    open.addEventListener("click", () => vscode.postMessage({ type: "widgetOpen", ...(id ? { id } : {}), html, title }));
    buttons.append(show, open);
    row.append(mark, words, buttons);
    box.append(row);
    if (codeShown) {
      if (pre) box.append(pre.cloneNode(true));
      else { const code = el("pre", "code"); code.append(el("code", "", html)); box.append(code); }
    }
    return box;
  }

  // ---- charts (ChatGPT's interactive charts): a ```chart block of JSON, drawn by chart.js
  function chartBlocks(node, live) {
    if (!window.DgcChart) return;
    for (const pre of node.querySelectorAll('pre.code[data-language="chart"]')) {
      let spec = null;
      try { spec = JSON.parse(decodeURIComponent(pre.querySelector(".copy[data-c]")?.dataset.c || "")); } catch { spec = null; }
      const chart = spec && window.DgcChart.render(spec, {
        copy: (text) => vscode.postMessage({ type: "copy", text }),
        save: (name, data) => (data ? vscode.postMessage({ type: "saveImage", name, data }) : showNotice("The chart couldn't be made into an image.", "info")),
      });
      if (chart) pre.replaceWith(chart);
      else if (live) pre.replaceWith(el("div", "cd-chart-pending", "Drawing a chart…"));   // its JSON is still coming
    }
  }

  // ---- writing blocks (ChatGPT's): a draft the user will send as it is, which the model writes in an ```email or
  // ```draft block. It reads as the email it is, with Copy (plain text), Open in mail app, and Edit in place.
  const DRAFT_KINDS = ["email", "draft"];
  /** A rendered fence that is a draft: its kind and words. The label may sit on the line after the backticks. */
  function draftOf(pre) {
    const words = decodeURIComponent(pre.querySelector(".copy[data-c]")?.dataset.c || "").replace(/\n$/, "");
    const kind = String(pre.dataset.language || "").toLowerCase();
    if (DRAFT_KINDS.includes(kind)) return { kind, words };
    const [first, ...rest] = words.split("\n");
    if (kind === "text" && DRAFT_KINDS.includes(first.trim().toLowerCase())) return { kind: first.trim().toLowerCase(), words: rest.join("\n") };
    return null;
  }
  function parseDraft(kind, words) {
    const lines = String(words || "").replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
    const head = {};
    let i = 0;
    if (kind === "email") {
      for (; i < lines.length; i++) {
        const m = /^(to|cc|bcc|subject)\s*:\s*(.*)$/i.exec(lines[i]);
        if (!m) break;
        head[m[1].toLowerCase()] = m[2].trim();
      }
      while (i < lines.length && !lines[i].trim()) i++;
    }
    return { to: head.to || "", cc: head.cc || "", bcc: head.bcc || "", subject: head.subject || "", body: lines.slice(i).join("\n") };
  }
  /** Back to the block's words, for an edit: an email's headers, a blank line, its body. */
  function draftWords(kind, d) {
    if (kind !== "email") return d.body;
    return [d.to && `To: ${d.to}`, d.cc && `Cc: ${d.cc}`, d.bcc && `Bcc: ${d.bcc}`, `Subject: ${d.subject}`].filter(Boolean).join("\n")
      + "\n\n" + d.body;
  }
  /** What goes on the clipboard or into a mail app: no ** or __ or heading marks, if the model left any. */
  const plainDraft = (text) => String(text || "").replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1").replace(/^#{1,6} +/gm, "");
  function draftBlocks(node, message, live) {
    for (const pre of node.querySelectorAll("pre.code")) {
      const found = draftOf(pre);
      if (found) pre.replaceWith(draftBlock(message, found.kind, found.words, live));
    }
  }
  function draftBlock(message, kind, words, live) {
    const d = parseDraft(kind, words);
    const key = `${message.id}\u0000${words}`;
    const editing = state.draftEdit[key];
    const box = el("div", "cd-draft");
    box.dataset.kind = kind;
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", kind === "email" ? `Email draft${d.subject ? `: ${d.subject}` : ""}` : "Draft");
    const head = el("div", "cd-draft-head");
    head.append(icon(kind === "email" ? "mail" : "edit"), el("span", "cd-draft-kind", kind === "email" ? "Email" : "Draft"));
    const tools = el("div", "cd-draft-tools");
    const tool = (glyph, label, onClick) => {
      const b = el("button", "cd-draft-tool");
      b.type = "button"; b.title = label;
      b.append(icon(glyph), el("span", "", label));
      b.addEventListener("click", onClick);
      return b;
    };
    if (!editing) {
      tools.append(tool("copy", "Copy", () => vscode.postMessage({ type: "copy", text: plainDraft(d.body) })));
      if (kind === "email") {
        tools.append(tool("mail", "Open in mail app", () => vscode.postMessage({ type: "openMail", to: d.to, cc: d.cc, bcc: d.bcc,
                                                                                 subject: plainDraft(d.subject), body: plainDraft(d.body) })));
      }
      if (!live && !message.partial) {
        tools.append(tool("edit", "Edit", () => {
          state.draftEdit[key] = { ...d, subject: plainDraft(d.subject), body: plainDraft(d.body) };   // as it reads
          update(message.id);
        }));
      }
    }
    head.append(tools);
    box.append(head);
    if (kind === "email" && (d.to || d.cc)) box.append(el("div", "cd-draft-to", [d.to && `To: ${d.to}`, d.cc && `Cc: ${d.cc}`].filter(Boolean).join(" \u00b7 ")));
    if (editing) {
      const form = el("div", "cd-draft-form");
      const id = `cd-draft-${message.id}-${box.dataset.kind}-${Math.abs([...words].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7))}`;
      if (kind === "email") {
        const label = el("label", "cd-field-label", "Subject");
        const subject = el("input", "cd-field cd-draft-subject-input");
        subject.id = `${id}-subject`; label.htmlFor = subject.id; subject.value = editing.subject; subject.dataset.keep = subject.id;
        subject.addEventListener("input", () => { editing.subject = subject.value; });
        form.append(label, subject);
      }
      const label = el("label", "cd-field-label", kind === "email" ? "Message" : "Draft");
      const text = el("textarea", "cd-field cd-draft-text");
      text.id = `${id}-body`; label.htmlFor = text.id; text.value = editing.body; text.dataset.keep = text.id;
      text.rows = Math.min(18, Math.max(4, editing.body.split("\n").length + 1));
      text.addEventListener("input", () => { editing.body = text.value; });
      const buttons = el("div", "cd-draft-buttons");
      const save = el("button", "cd-continue", editing.saving ? "Saving…" : "Save");
      save.type = "button"; save.disabled = !!editing.saving;
      save.addEventListener("click", () => {
        if (!editing.body.trim()) { showNotice("A draft can't be empty.", "info"); return; }
        editing.saving = true; update(message.id);
        vscode.postMessage({ type: "draftEdit", messageId: message.id, original: words, text: draftWords(kind, editing) });
      });
      const cancel = el("button", "cd-edit-cancel", "Cancel");
      cancel.type = "button"; cancel.disabled = !!editing.saving;
      cancel.addEventListener("click", () => { delete state.draftEdit[key]; update(message.id); });
      buttons.append(save, cancel);
      form.append(label, text, buttons);
      box.append(form);
    } else {
      if (kind === "email" && d.subject) box.append(el("div", "cd-draft-subject", plainDraft(d.subject)));
      box.append(el("div", "cd-draft-body", plainDraft(d.body)));
    }
    return box;
  }
  /** Plugin logos for "Used [logo] Aave", by plugin id: the host reads each once (a data: URI; "" when it has none). */
  const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
  const pluginLogos = new Map(), pluginLogosAsked = new Set();
  let logosWanted = [];
  function wantLogo(id) {
    if (pluginLogos.has(id) || pluginLogosAsked.has(id)) return;
    pluginLogosAsked.add(id);
    if (!logosWanted.length) setTimeout(() => {
      const plugins = logosWanted; logosWanted = [];
      for (let i = 0; i < plugins.length; i += 16) vscode.postMessage({ type: "pluginLogos", plugins: plugins.slice(i, i + 16) });
    }, 0);
    logosWanted.push(id);
  }
  function logoImage(src) { const img = document.createElement("img"); img.alt = ""; img.src = src; return img; }
  /** The plugins a reply read from ("Used [logo] Aave"), as ChatGPT names the apps it used: what came from a plugin
   *  did. A logo not here yet shows a plug until the host sends it; a bare name (an earlier build's) keeps the plug. */
  function pluginsNote(message) {
    const used = (Array.isArray(message.plugins) ? message.plugins : [])
      .map((p) => typeof p === "string" ? { plugin: "", name: p } : p)
      .filter((p) => p && typeof p.name === "string" && p.name && typeof p.plugin === "string").slice(0, 8);
    if (!used.length) return null;
    const line = el("div", "cd-plugins-used");
    line.append(el("span", "", "Used"));
    used.forEach((p, i) => {
      const mark = el("span", "cd-plugin-mark");
      if (PLUGIN_ID.test(p.plugin)) { mark.dataset.pluginMark = p.plugin; wantLogo(p.plugin); }
      const src = pluginLogos.get(p.plugin);
      mark.append(src ? logoImage(src) : icon("plug"));
      const chip = el("span", "cd-plugin");
      chip.append(mark, el("span", "", p.name + (i < used.length - 1 ? "," : "")));
      line.append(" ", chip);         // a space a flex row doesn't draw, for its words (copied, read aloud)
    });
    line.title = used.length === 1 ? "This reply used this plugin" : "This reply used these plugins";
    return line;
  }
  /** What a reply saved to (or deleted from) the user's memory, each with Forget, and the way to all of it. */
  function memoryNote(message) {
    const ops = Array.isArray(message.memory) ? message.memory.filter((op) => op && typeof op.text === "string") : [];
    if (!ops.length) return null;
    const box = el("div", "cd-memory");
    for (const op of ops) {
      const gone = op.op === "forgot" || state.forgotten.has(op.id);
      const row = el("div", "cd-memory-row");
      row.append(icon(op.op === "forgot" ? "trash" : gone ? "circle-slash" : "bookmark"),
                 el("span", "cd-memory-text", `${op.op === "forgot" ? "Forgot" : gone ? "Forgotten" : "Remembered"}: ${op.text}`));
      if (op.op === "saved" && !gone) {
        const forget = el("button", "cd-memory-forget", "Forget");
        forget.type = "button"; forget.title = "Delete this from what DGC remembers about you";
        forget.addEventListener("click", () => {
          vscode.postMessage({ type: "forgetMemory", id: op.id });
          state.forgotten.add(op.id); update(message.id); announce("Forgotten.");
        });
        row.append(forget);
      }
      box.append(row);
    }
    const manage = el("button", "cd-memory-manage", "Manage memory");
    manage.type = "button"; manage.title = "See, change or delete everything DGC remembers about you";
    manage.addEventListener("click", () => vscode.postMessage({ type: "openMemory" }));
    box.append(manage);
    return box;
  }
  /** A reply's words, with each question it asked as a card where it asked it. */
  function replyParts(message, live) {
    const questions = Array.isArray(message.questions) ? message.questions : [];
    if (!questions.length) return [body(message, { live })];
    const text = message.text || "";
    const parts = [];
    let done = 0;
    questions.map((q, i) => [q, i]).sort((a, b) => (Number(a[0].at) || 0) - (Number(b[0].at) || 0)).forEach(([q, i]) => {
      let at = Math.max(done, Math.min(text.length, Number(q.at) || 0));
      // Asked mid-sentence ("let's do it" [card] "."): the sentence's own punctuation stays with it, above the card.
      while (at < text.length && /[.,;:!?…)\]"'”’]/.test(text[at])) at++;
      if (text.slice(done, at).trim()) parts.push(body({ ...message, text: text.slice(done, at) }, { live }));
      parts.push(questionCard(message, q, i, live));
      done = at;
    });
    if (text.slice(done).trim()) parts.push(body({ ...message, text: text.slice(done) }, { live }));
    return parts;
  }
  const OTHER = "\u0000other";
  /** A question the reply asked: its options and a box for your own answer. Continue sends the message the model
   *  wrote for it, with your choice in. Answerable while the reply is the last thing said; then it shows what you
   *  chose, or that you moved on. What you pick survives the reply re-drawing as it streams. */
  function questionCard(message, q, index, live) {
    if (Array.isArray(q.questions) && q.questions.length > 1) return formCard(message, q, q.questions, index, live);
    const key = `${message.id}:${index}`;
    const at = state.messages.findIndex((m) => m.id === message.id);
    const next = at >= 0 ? state.messages[at + 1] : undefined;
    const said = next?.role === "user" && next.answers?.message === message.id && Number(next.answers.question) === index
      ? String(next.answers.choice || "") : null;
    const open = !next && !live;
    const options = (Array.isArray(q.options) ? q.options : []).map(String);
    const pick = state.picks[key] || (state.picks[key] = { value: "", other: "" });
    const theirs = said !== null && !options.includes(said);
    const card = el("form", "cd-question");
    card.dataset.state = said !== null ? "answered" : next ? "passed" : "open";
    const title = el("p", "cd-question-text", String(q.question || ""));
    title.id = `cd-q-${message.id}-${index}`;
    const list = el("div", "cd-options");
    list.setAttribute("role", "radiogroup");
    list.setAttribute("aria-labelledby", title.id);
    const go = el("button", "cd-continue cd-question-go", "Continue");
    go.type = "submit";
    const other = el("input", "cd-other");
    const choice = () => (pick.value === OTHER ? pick.other.trim() : pick.value);
    const drafted = open ? pick : { value: "", other: "" };       // a pick you didn't send isn't shown after
    const sync = () => {
      other.hidden = !(theirs || drafted.value === OTHER);
      go.disabled = !open || state.busy || state.compacting || !choice();
    };
    const row = (value, label) => {
      const item = el("label", "cd-option");
      const radio = el("input");
      radio.type = "radio"; radio.name = title.id; radio.value = value;
      radio.checked = said !== null ? (value === OTHER ? theirs : value === said) : drafted.value === value;
      radio.disabled = !open;
      radio.addEventListener("change", () => {
        pick.value = value; sync();
        if (value === OTHER) other.focus();
      });
      item.append(radio, el("span", "", label));
      return item;
    };
    for (const option of options) list.append(row(option, option));
    list.append(row(OTHER, "Something else"));
    other.type = "text"; other.maxLength = 500; other.placeholder = "Your answer";
    other.setAttribute("aria-label", "Your own answer");
    other.value = theirs ? said : drafted.other;
    other.disabled = !open;
    other.addEventListener("input", () => { pick.other = other.value; sync(); });
    list.append(other);
    card.append(title, list);
    if (open) card.append(go);
    else card.append(el("p", "cd-question-note", said !== null ? "Answered" : next ? "Not answered" : "Answer when the reply finishes"));
    card.addEventListener("submit", (e) => {
      e.preventDefault();
      const value = choice();
      if (!open || !value || state.busy || state.compacting) return;
      vscode.postMessage({ type: "answer", messageId: message.id, question: index, choice: value, model: modelPick.value || "",
                           thinking: thinkingPick.value || "", search: searchMode() });
      state.busy = true; controls(); sync();
    });
    sync();
    return card;
  }
  /** A card of several questions answered together, as ChatGPT asks them: numbered, each with its options and the
   *  first chosen until you change it, and one button, in the model's words, that sends them all. Answerable while
   *  the reply is the last thing said; then it shows what was sent, or that you moved on. */
  function formCard(message, q, form, index, live) {
    const key = `${message.id}:${index}`;
    const at = state.messages.findIndex((m) => m.id === message.id);
    const next = at >= 0 ? state.messages[at + 1] : undefined;
    const answers = next?.role === "user" && next.answers?.message === message.id && Number(next.answers.question) === index
      ? next.answers : null;
    const sent = answers ? (Array.isArray(answers.choices) ? answers.choices : [answers.choice]).map((c) => String(c ?? "")) : null;
    const open = !next && !live;
    const options = (item) => (Array.isArray(item?.options) ? item.options : []).map(String);
    const pick = state.picks[key] || (state.picks[key] = { values: form.map((item) => options(item)[0] || "") });
    const card = el("form", "cd-question cd-form");
    card.dataset.state = sent ? "answered" : next ? "passed" : "open";
    form.forEach((item, n) => {
      const group = el("div", "cd-form-q");
      const title = el("p", "cd-question-text", `${n + 1}. ${String(item?.question || "")}`);
      title.id = `cd-q-${message.id}-${index}-${n}`;
      group.append(title);
      const list = el("div", "cd-options");
      list.setAttribute("role", "radiogroup");
      list.setAttribute("aria-labelledby", title.id);
      for (const option of options(item)) {
        const row = el("label", "cd-option");
        const radio = el("input");
        radio.type = "radio"; radio.name = `cd-f-${message.id}-${index}-${n}`; radio.value = option;
        radio.checked = sent ? sent[n] === option : open && pick.values[n] === option;
        radio.disabled = !open;
        radio.addEventListener("change", () => { pick.values[n] = option; });
        row.append(radio, el("span", "", option));
        list.append(row);
      }
      group.append(list);
      card.append(group);
    });
    if (open) {
      const go = el("button", "cd-continue cd-question-go", String(q.submit || "") || "Continue");
      go.type = "submit";
      go.disabled = state.busy || state.compacting;
      card.append(go);
    } else card.append(el("p", "cd-question-note", sent ? "Answered" : next ? "Not answered" : "Answer when the reply finishes"));
    card.addEventListener("submit", (e) => {
      e.preventDefault();
      const values = pick.values.map((v) => String(v || "").trim());
      if (!open || values.some((v) => !v) || state.busy || state.compacting) return;
      vscode.postMessage({ type: "answer", messageId: message.id, question: index, choice: values[0], choices: values,
                           model: modelPick.value || "", thinking: thinkingPick.value || "", search: searchMode() });
      state.busy = true; controls();
      for (const control of card.querySelectorAll("input, button")) control.disabled = true;
    });
    return card;
  }
  /** A summary as the model wrote it: models write Markdown even when asked for plain text. */
  function summaryText(text) {
    const node = el("div", "text cd-summary-text");
    const html = md(text);
    if (html === null) node.textContent = text || ""; else node.innerHTML = html;
    return node;
  }
  /** What a reply looked up: the queries, and the pages it may cite, numbered as it cites them. */
  /** The numbers a reply's words cite. */
  const citedIn = (message) => new Set(String(message.text || "").match(/\[(\d{1,2})\]/g)?.map((m) => m.slice(1, -1)) || []);
  /** Every source of a reply: what it searched for, the ones it cited, then the rest it found. */
  function sourcesList(message) {
    const sources = Array.isArray(message.sources) ? message.sources : [];
    const searches = Array.isArray(message.searches) ? message.searches : [];
    const cited = citedIn(message);
    const box = el("div", "cd-sources-list");
    if (searches.length) box.append(el("p", "cd-searched", `Searched for ${searches.map((q) => `“${q}”`).join(", ")}`));
    const used = sources.filter((x) => cited.has(String(x.n))), more = sources.filter((x) => !cited.has(String(x.n)));
    for (const [label, group] of [["Cited", used], ["More results", more]]) {
      if (!group.length) continue;
      box.append(el("h3", "cd-sources-heading", `${label} · ${group.length}`));
      const list = el("ul", "cd-source-cards");
      for (const source of group) list.append(sourceRow(source));
      box.append(list);
    }
    return box;
  }
  /** Under a reply that used the web: its sources' favicons and a count, opening them all beside the chat. */
  function sourcesBlock(message) {
    const sources = Array.isArray(message.sources) ? message.sources : [];
    const searches = Array.isArray(message.searches) ? message.searches : [];
    if (!sources.length && !searches.length) return null;
    const button = el("button", "cd-sources-button");
    button.type = "button";
    const cited = citedIn(message);
    const shown = [...sources.filter((x) => cited.has(String(x.n))), ...sources.filter((x) => !cited.has(String(x.n)))];
    const stack = el("span", "cd-fav-stack");
    const hosts = new Set();
    for (const source of shown) {
      if (hosts.size >= 3) break;
      if (hosts.has(siteOf(source.url))) continue;
      hosts.add(siteOf(source.url)); stack.append(faviconNode(source.url));
    }
    if (hosts.size) button.append(stack);
    button.append(el("span", "", sources.length ? `Sources · ${sources.length}` : "Searched the web"));
    button.setAttribute("aria-haspopup", "dialog");
    button.addEventListener("click", () => openSources(message));
    return button;
  }
  /** The Sources panel, beside the conversation, as ChatGPT opens it. */
  function openSources(message) {
    $("cd-sources-panel")?.remove();
    const panel = el("aside", "cd-panel");
    panel.id = "cd-sources-panel";
    panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", "Sources");
    const top = el("header", "cd-panel-head");
    const close = action("close", "Close", () => { panel.remove(); input.focus(); });
    top.append(el("h2", "cd-panel-title", "Sources"), close);
    panel.append(top, sourcesList(message));
    panel.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); panel.remove(); input.focus(); } });
    document.body.append(panel);
    close.focus();
  }
  // What it's doing while it works, as Work's status row says it (main.js): DGC's three slashes lighting one after
  // another, then the words. The slashes' rules are Work's own (main.css names .cd-wave beside .thinking), still for a
  // reader who asked for less motion. Drawn once per line: a redraw keeps the line, so the wave never restarts.
  const MARK = '<svg class="tmark" viewBox="0 0 90 90" fill="currentColor" aria-hidden="true">'
    + '<path class="s1" d="M32 24 L20 30 L13 72 L25 66 Z"/><path class="s2" d="M54 18 L42 24 L35 72 L47 66 Z"/>'
    + '<path class="s3" d="M76 24 L64 30 L57 66 L69 60 Z"/></svg>';
  function wave(words, tag = "span", cls = "") {
    const line = el(tag, `cd-wave${cls ? ` ${cls}` : ""}`);
    line.innerHTML = MARK;
    line.append(el("span", "verb", words));
    return line;
  }
  // Collapsed, while it thinks and once it has answered: a click opens it, and what the reader chose holds for that
  // reply, as it streams and after.
  const thinkingChosen = new Map();
  function thinkingBlock(message, live) {
    const box = el("details", "cd-thinking");
    const summary = el("summary", "cd-thinking-label");
    if (live) summary.append(wave("Thinking")); else summary.textContent = "Thought";
    const text = el("div", "cd-thought");
    text.textContent = message.thinking || "";
    // Its own scroller, reached by Tab and scrolled by the keys as well as the wheel.
    text.tabIndex = 0; text.setAttribute("role", "region"); text.setAttribute("aria-label", "The model's thinking");
    box.append(summary, text);
    box.dataset.id = message.id || "";
    box.dataset.live = live ? "1" : "";
    box.open = thinkingChosen.get(message.id) === true;
    // It opens and closes on the press, not the click: a reply that streams redraws every delta, and Chromium drops a
    // click whose pressed element was moved in between. Enter and Space still come as a click (detail 0).
    const toggle = () => { box.open = !box.open; thinkingChosen.set(message.id, box.open); };
    summary.addEventListener("pointerdown", (e) => { if (e.button === 0) toggle(); });
    summary.addEventListener("click", (e) => { e.preventDefault(); if (e.detail === 0) toggle(); });
    return box;
  }
  // ---- copying a reply: formatted for a mail app or a document, clean text for everywhere else (no ** or #)
  /** A reply as it reads: its rendered blocks without the screen's own buttons, links as links. */
  function readable(message) {
    const node = body(message, { live: true });
    node.querySelectorAll(".copy, .code-language, .cd-draft-tools, .cd-chart-tools, .cd-chart-legend, .cd-chart-tip").forEach((n) => n.remove());
    node.querySelectorAll(".cd-chart-table").forEach((t) => { t.hidden = false; });      // a chart pastes as its numbers
    node.querySelectorAll("button.md-link").forEach((b) => {
      const a = document.createElement("a");
      a.href = b.dataset.target || ""; a.textContent = b.textContent;
      b.replaceWith(a);
    });
    return node;
  }
  /** Plain text of rendered blocks: paragraphs apart, list items marked, tables by tab, a draft's subject first. */
  function plainOf(node) {
    const out = [];
    const walk = (n, depth) => {
      for (const child of n.children) {
        const tag = child.tagName.toLowerCase();
        if (tag === "p" || /^h[1-6]$/.test(tag) || tag === "blockquote" || child.classList.contains("cd-draft-subject")
            || child.classList.contains("cd-draft-to")) out.push(child.innerText ?? child.textContent, "");
        else if (child.classList.contains("cd-draft-body") || tag === "pre") out.push(child.textContent.replace(/\n$/, ""), "");
        else if (tag === "ul" || tag === "ol") {
          let n2 = Number(child.getAttribute("start")) || 1;
          for (const li of child.children) {
            const own = [...li.childNodes].filter((x) => !(x.nodeType === 1 && /^(UL|OL)$/.test(x.tagName))).map((x) => x.textContent).join("").trim();
            out.push(`${"  ".repeat(depth)}${tag === "ol" ? `${n2++}.` : "-"} ${own}`);
            for (const sub of li.children) if (/^(UL|OL)$/.test(sub.tagName)) walk({ children: [sub] }, depth + 1);
          }
          if (!depth) out.push("");
        } else if (tag === "table") {
          for (const row of child.querySelectorAll("tr")) out.push([...row.children].map((c) => c.textContent.trim()).join("\t"));
          out.push("");
        } else if (tag === "hr") out.push("");
        else walk(child, depth);
      }
    };
    walk(node, 0);
    return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  async function copyReply(message) {
    const node = readable(message);
    const plain = plainOf(node), html = node.innerHTML;
    try {
      await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }),
                                                            "text/plain": new Blob([plain], { type: "text/plain" }) })]);
      announce("Copied.");
    } catch {
      vscode.postMessage({ type: "copy", text: plain });      // no rich clipboard here: the clean text, by the host
    }
  }
  // ---- read aloud (media/readaloud.js): the speaker under a reply plays it in the voice Settings -> Voice chose.
  const reader = window.DgcReadAloud ? window.DgcReadAloud.create({ post: (m) => vscode.postMessage(m) }) : null;
  reader?.onError((text, kind) => showNotice(text, kind));
  // Replies are redrawn as they stream and change: a new speaker shows what's being read.
  if (reader) new MutationObserver(() => reader.sync()).observe(log, { childList: true, subtree: true });
  function readAction(message) {
    const button = el("button", "cd-action cd-read");
    button.type = "button"; button.dataset.readAloud = message.id;
    button.title = "Read aloud"; button.setAttribute("aria-label", "Read aloud"); button.setAttribute("aria-pressed", "false");
    button.innerHTML = '<span class="codicon codicon-unmute ra-play" aria-hidden="true"></span><span class="codicon codicon-debug-stop ra-stop" aria-hidden="true"></span>';
    button.addEventListener("click", () => reader.toggle(message.id, message.text || ""));
    return button;
  }
  function action(icon, label, onClick) {
    const button = el("button", "cd-action");
    button.type = "button"; button.title = label; button.setAttribute("aria-label", label);
    const glyph = el("span", `codicon codicon-${icon}`); glyph.setAttribute("aria-hidden", "true");
    button.append(glyph);
    button.addEventListener("click", onClick);
    return button;
  }
  function endNote(message) {
    const finish = message.finish;
    const last = state.messages[state.messages.length - 1] === message;
    if (finish === "error" && message.error) return el("p", "cd-end cd-end-error", message.error);
    if ((finish === "length" || finish === "cancelled") && last && !state.busy) {
      const note = el("p", "cd-end");
      note.append(el("span", "", finish === "length" ? "The model reached its length limit here." : "Stopped."));
      const go = el("button", "cd-continue", "Continue");
      go.type = "button";
      go.addEventListener("click", () => { go.disabled = true; vscode.postMessage({ type: "continue", messageId: message.id }); });
      note.append(go);
      return note;
    }
    if (finish === "cancelled") return el("p", "cd-end", "Stopped.");
    if (finish === "length") return el("p", "cd-end", "The model reached its length limit here.");
    return null;
  }
  const sizeText = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
  /** One attachment as a chip: an icon for its kind, its name, and its size or length. */
  function chip(item, onRemove) {
    const node = el("li", "cd-chip");
    const kind = item.kind === "library" ? item.fileKind
      : item.kind === "file" ? (/\.(png|jpe?g|gif|webp)$/i.test(item.name || "") ? "image" : "file") : item.kind;
    const glyph = el("span", `codicon codicon-${KIND_ICON[kind] || "file"}`); glyph.setAttribute("aria-hidden", "true");
    const name = el("span", "cd-chip-name", item.name || "Attachment");
    const about = item.removed ? "deleted from your Library"
      : item.kind === "text" && typeof item.text === "string" ? `${item.text.length.toLocaleString()} characters`
      : Number(item.chars) && item.kind !== "image" ? `${Number(item.chars).toLocaleString()} characters`
      : Number(item.size) ? sizeText(Number(item.size)) : "";
    node.append(glyph, name);
    if (about) node.append(el("span", "cd-chip-about", about));
    node.title = item.name || "";
    if (onRemove) {
      const remove = el("button", "cd-chip-remove");
      remove.type = "button"; remove.title = `Remove ${item.name || "attachment"}`; remove.setAttribute("aria-label", remove.title);
      const x = el("span", "codicon codicon-close"); x.setAttribute("aria-hidden", "true");
      remove.append(x); remove.addEventListener("click", onRemove);
      node.append(remove);
    }
    return node;
  }
  function chips() {
    const box = $("cd-chips");
    // Closed by hand is a decision, not an edit: undo does not bring it back.
    box.replaceChildren(...state.pending.map((item, i) => chip(item, () => { history?.dismiss(item); state.pending.splice(i, 1); chips(); controls(); input.focus(); })));
    box.hidden = !state.pending.length;
  }
  // ---- images the chat keeps, shown as thumbnails (asked of the backend once each, then remembered)
  const images = new Map();          // attachment id -> {data} | {error} | "asked"
  function thumb(item) {
    const button = el("button", "cd-thumb");
    button.type = "button"; button.dataset.att = item.id; button.title = `${item.name || "Image"}: click to enlarge`;
    const picture = el("img"); picture.alt = item.name || "Image"; picture.dataset.att = item.id;
    button.append(picture);
    button.addEventListener("click", () => button.classList.toggle("cd-thumb-big"));
    const known = images.get(item.id);
    if (known?.data) picture.src = known.data;
    else if (known?.error) button.replaceChildren(el("span", "cd-thumb-missing", item.name || "Image"));
    else if (!known) { images.set(item.id, "asked"); vscode.postMessage({ type: "image", id: item.id }); }
    return button;
  }
  // ---- pictures from the web above a reply (ChatGPT's image strip). The backend fetched and kept them with the
  // chat, so each is asked for by id like an attached image: the screen never asks an image host itself.
  function webPicture(item) {
    const picture = el("img");
    picture.alt = item.title || `Image from ${item.site || "the web"}`; picture.dataset.att = item.id; picture.decoding = "async";
    const known = images.get(item.id);
    if (known?.data) picture.src = known.data;
    else if (!known) { images.set(item.id, "asked"); vscode.postMessage({ type: "image", id: item.id }); }
    return picture;
  }
  function shownPictures(message) {
    const items = Array.isArray(message.images?.items) ? message.images.items : [];
    return items.filter((x) => x && /^att_[a-f0-9]{32}$/.test(x.id || "") && !images.get(x.id)?.error);
  }
  /** Up to four pictures, each with the site it's from; one opens larger, with the page it's on. */
  function picturesStrip(message) {
    const items = shownPictures(message);
    if (!items.length) return null;
    const strip = el("ul", "cd-pictures");
    strip.dataset.count = String(items.length); strip.dataset.key = items.map((x) => x.id).join(",");
    strip.setAttribute("aria-label", `Images from the web for “${message.images.query || ""}”`);
    for (const item of items) {
      const li = el("li", "cd-picture-item");
      const tile = el("button", "cd-picture");
      tile.type = "button"; tile.title = item.title ? `${item.title} (${item.site || "web"})` : item.site || "Image";
      tile.setAttribute("aria-label", `${item.title || "Image"}, from ${item.site || "the web"}: view larger`);
      tile.append(webPicture(item), el("span", "cd-picture-site", item.site || ""));
      tile.addEventListener("click", () => openPicture(message.id, item.id));
      li.append(tile);
      strip.append(li);
    }
    return strip;
  }
  /** A picture larger, over the chat: what it is, where it's from, the page it's on; arrows for the others. */
  function openPicture(messageId, pictureId) {
    $("cd-picture-view")?.remove();
    const back = document.activeElement;
    const message = state.messages.find((m) => m.id === messageId);
    const items = message ? shownPictures(message) : [];
    let at = items.findIndex((x) => x.id === pictureId);
    if (at < 0) return;
    const view = el("div", "cd-lightbox");
    view.id = "cd-picture-view";
    view.setAttribute("role", "dialog"); view.setAttribute("aria-modal", "true");
    const frame = el("figure", "cd-lightbox-frame");
    const count = el("span", "cd-lightbox-count");
    const done = () => { view.remove(); (back && back.isConnected ? back : input).focus(); };
    const close = action("close", "Close", done);
    const show = (i) => {
      at = (i + items.length) % items.length;
      const item = items[at];
      view.setAttribute("aria-label", item.title || "Image");
      const site = el("div", "cd-source-site");
      site.append(faviconNode(item.url), el("span", "", item.site || siteOf(item.url)));
      const open = el("button", "cd-continue", "Open page");
      open.type = "button"; open.title = item.url;
      open.addEventListener("click", () => vscode.postMessage({ type: "openLink", target: item.url }));
      const row = el("div", "cd-lightbox-row");
      row.append(site, open);
      const caption = el("figcaption", "cd-lightbox-caption");
      if (item.title) caption.append(el("p", "cd-lightbox-title", item.title));
      caption.append(row, el("p", "cd-lightbox-note", `From an image search for “${message.images.query || ""}”: the model hasn't seen it.`));
      frame.replaceChildren(webPicture(item), caption);
      count.textContent = items.length > 1 ? `${at + 1} / ${items.length}` : "";
    };
    const top = el("div", "cd-lightbox-top");
    top.append(count, close);
    const box = el("div", "cd-lightbox-box");
    box.append(top, frame);
    if (items.length > 1) {
      const prev = action("chevron-left", "Previous image", () => show(at - 1));
      const next = action("chevron-right", "Next image", () => show(at + 1));
      prev.classList.add("cd-lightbox-nav"); next.classList.add("cd-lightbox-nav");
      view.append(prev, box, next);
    } else view.append(box);
    view.addEventListener("click", (e) => { if (e.target === view) done(); });
    view.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(); }
      else if (e.key === "ArrowLeft" && items.length > 1) { e.preventDefault(); show(at - 1); }
      else if (e.key === "ArrowRight" && items.length > 1) { e.preventDefault(); show(at + 1); }
      else if (e.key === "Tab") {
        // Focus stays in the view while it's open.
        const stops = [...view.querySelectorAll("button")].filter((b) => !b.disabled);
        const i = stops.indexOf(document.activeElement);
        if (e.shiftKey && i <= 0) { e.preventDefault(); stops[stops.length - 1].focus(); }
        else if (!e.shiftKey && i === stops.length - 1) { e.preventDefault(); stops[0].focus(); }
      }
    });
    show(at);
    document.body.append(view);
    close.focus();
  }
  /** A button that starts or changes a turn: off while one runs (controls() keeps every such button in step). */
  function idleOnly(button) {
    button.dataset.whileIdle = "1";
    button.disabled = state.busy || state.compacting || button.dataset.never === "1";
    return button;
  }
  /** ‹ 2 / 3 ›: which version of the conversation from this point you're looking at. */
  function versionsControl(message) {
    const v = message.versions;
    if (!v || !(Number(v.count) > 1)) return null;
    const box = el("span", "cd-versions");
    const step = (delta, icon, label) => {
      const b = action(icon, label, () => vscode.postMessage({ type: "version", parent: v.parent, index: v.index + delta }));
      if (v.index + delta < 0 || v.index + delta >= v.count) b.dataset.never = "1";
      return idleOnly(b);
    };
    box.append(step(-1, "chevron-left", "Previous version"), el("span", "cd-versions-count", `${v.index + 1} / ${v.count}`),
               step(1, "chevron-right", "Next version"));
    return box;
  }
  /** Your message as a box to change: Send makes a new version from here; the old one stays a click away. */
  function editor(message) {
    const form = el("form", "cd-edit");
    const box = el("textarea", "cd-input cd-edit-input"); box.value = message.text || ""; box.rows = 3;
    box.setAttribute("aria-label", "Edit your message");
    const row = el("div", "cd-edit-actions");
    const cancel = el("button", "cd-edit-cancel", "Cancel"); cancel.type = "button";
    const go = el("button", "cd-continue", "Send"); go.type = "submit";
    row.append(cancel, go);
    form.append(box, row);
    const done = () => { state.editing = ""; render(); input.focus(); };
    cancel.addEventListener("click", done);
    box.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(); }
      else if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!box.value.trim() && !(message.attachments || []).length) return;
      vscode.postMessage({ type: "edit", messageId: message.id, text: box.value, model: modelPick.value || "",
                           thinking: thinkingPick.value || "", search: searchMode() });
      state.editing = ""; state.busy = true; controls();
    });
    return form;
  }
  // ---- deep research: a plan to edit or start, the reading as it happens, then the report
  const icon = (name) => { const glyph = el("span", `codicon codicon-${name}`); glyph.setAttribute("aria-hidden", "true"); return glyph; };
  const RESEARCHING = ["planning", "running", "writing", "checking"];
  const COUNTDOWN = 15;                // seconds a new plan waits for Edit before it starts, as ChatGPT's does
  /** A <details> that stays as you left it across redraws (research redraws often). */
  function kept(key, cls, label, open = false) {
    const box = el("details", cls);
    box.dataset.keep = key;
    box.open = state.open.has(key) || (open && !state.open.has(`!${key}`));
    box.addEventListener("toggle", () => {
      if (box.open) { state.open.add(key); state.open.delete(`!${key}`); } else { state.open.delete(key); state.open.add(`!${key}`); }
    });
    box.append(el("summary", "", label));
    return box;
  }
  function elapsed(r) {
    const from = Date.parse(r.started_at || ""), to = r.finished_at ? Date.parse(r.finished_at) : Date.now();
    // Once it's over, the time it spent (a run stopped and carried on later doesn't count the pause).
    const spent = !RESEARCHING.includes(r.status) && Number(r.seconds) > 0 ? Math.round(Number(r.seconds)) : null;
    if (spent === null && (!from || !(to >= from))) return "";
    const seconds = spent ?? Math.round((to - from) / 1000);
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }
  /** How far it is: the round and pages read out of its budget (when it has one), sources noted and found, the time. */
  function researchStats(r, { round = true } = {}) {
    const b = r.budget || {};
    const reads = Number(r.opened ?? r.reads ?? (r.read || []).length) || 0, notes = (r.notes || []).length;
    const parts = [];
    if (r.round && round) parts.push(b.rounds ? `round ${r.round} of ${b.rounds}` : `round ${r.round}`);
    parts.push(b.pages && RESEARCHING.includes(r.status) ? `${reads} of ${b.pages} pages read` : `${reads} page${reads === 1 ? "" : "s"} read`);
    if (!b.pages) parts.push(`${notes} noted`);                 // research from before budgets said it this way
    if (r.found) parts.push(`${r.found} sources found`);
    const time = elapsed(r);
    if (time) parts.push(time);
    return parts.join(" · ");
  }
  const DEPTHS = { quick: ["Quick", 15, 5], standard: ["Standard", 40, 15], thorough: ["Thorough", 80, 30] };
  /** A depth in words, with the budget the research has for it (a bigger window reads more), else a 32k window's. */
  const depthWords = (depth, budget) => {
    const [name, pages, minutes] = DEPTHS[depth] || DEPTHS.standard;
    const b = budget && Number(budget.pages) > 0 ? budget : { pages, minutes };
    return `${name}: reads up to ${b.pages} pages, in up to ${b.minutes} minutes`;
  };
  /** The plan; while it runs, a tick on each step the sources already cover. */
  function planList(plan, covered = []) {
    const box = el("div", "cd-plan");
    if (plan.title) box.append(el("h3", "cd-plan-title", plan.title));
    const list = el("ol", "cd-plan-steps");
    (plan.steps || []).forEach((step, i) => {
      const item = el("li", "", step);
      if (covered.includes(i + 1)) { item.classList.add("cd-step-covered"); item.title = "Covered by what it has read"; item.append(icon("check")); }
      list.append(item);
    });
    box.append(list);
    if ((plan.sites || []).length) box.append(el("p", "cd-plan-sites", `Only these sites: ${plan.sites.join(", ")}`));
    return box;
  }
  const ACTIVITY = { search: ["search", "Searching"], read: ["globe", "Reading"], note: ["note", "Noted"], skip: ["circle-slash", "Skipped"],
                     round: ["sync", ""], write: ["edit", ""], check: ["checklist", ""], checked: ["pass", ""], steer: ["comment", "You added"],
                     info: ["info", ""], error: ["warning", ""], wait: ["watch", ""], gap: ["question", "Still missing"],
                     conflict: ["git-compare", "To check"], pick: ["filter", ""] };
  function activityList(lines) {
    const list = el("ol", "cd-research-log");
    for (const line of lines) {
      const [glyph, verb] = ACTIVITY[line.kind] || ["circle-small", ""];
      const item = el("li", `cd-research-line cd-line-${line.kind || "info"}`);
      const words = line.kind === "note" && line.n ? `[${line.n}] ${line.text}` : line.text;
      item.append(icon(glyph), el("span", "", verb ? `${verb}: ${words}` : words));
      if (line.url) { item.title = line.url; }
      list.append(item);
    }
    return list;
  }
  function startResearch(message, extra = {}) {
    if (state.busy || state.compacting) return;
    delete state.countdowns[message.id];
    state.planEditing = "";
    vscode.postMessage({ type: "researchStart", messageId: message.id, ...extra });
    state.busy = true;
    controls(); update(message.id);
  }
  let ticking = 0;
  /** A new plan starts by itself after COUNTDOWN seconds unless you edit it (or start it sooner). */
  function tick() {
    clearTimeout(ticking);
    for (const [id, deadline] of Object.entries(state.countdowns)) {
      const message = state.messages.find((m) => m.id === id);
      const last = state.messages[state.messages.length - 1] === message;
      if (!message || message.research?.status !== "planned" || !last || state.planEditing === id) { delete state.countdowns[id]; update(id); continue; }
      const left = Math.ceil((deadline - Date.now()) / 1000);
      if (left <= 0) { startResearch(message); continue; }
      const shown = log.querySelector(`.cd-msg[data-id="${CSS.escape(id)}"] .cd-countdown`);
      if (shown) shown.textContent = `Starting in ${left}s`;
    }
    if (Object.keys(state.countdowns).length) ticking = setTimeout(tick, 250);
  }
  function planEditor(message) {
    const plan = message.research.plan || {};
    const form = el("form", "cd-plan-edit");
    const field = (label, control) => { const row = el("label", "cd-plan-field"); row.append(el("span", "", label), control); return row; };
    const title = el("input", "cd-plan-input"); title.value = plan.title || ""; title.maxLength = 200;
    const steps = el("textarea", "cd-plan-input"); steps.value = (plan.steps || []).join("\n"); steps.rows = Math.max(4, (plan.steps || []).length + 1);
    const sites = el("input", "cd-plan-input"); sites.value = (plan.sites || []).join(", "); sites.placeholder = "Any site (or, for example: rbi.org.in, gov.uk)";
    const was = DEPTHS[message.research.depth] ? message.research.depth : "standard";
    const depth = el("select", "cd-plan-input");
    for (const value of Object.keys(DEPTHS)) {
      const option = el("option", "", depthWords(value, message.research.depths?.[value])); option.value = value; depth.append(option);
    }
    depth.value = was;
    title.dataset.keep = `plan-title-${message.id}`; steps.dataset.keep = `plan-steps-${message.id}`; sites.dataset.keep = `plan-sites-${message.id}`;
    depth.dataset.keep = `plan-depth-${message.id}`;
    const row = el("div", "cd-edit-actions");
    const cancel = el("button", "cd-edit-cancel", "Cancel"); cancel.type = "button";
    const go = el("button", "cd-continue", "Start research"); go.type = "submit";
    row.append(cancel, go);
    form.append(field("Title", title), field("Steps, one a line", steps), field("Only these sites", sites), field("How deep", depth), row);
    cancel.addEventListener("click", () => { state.planEditing = ""; update(message.id); });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const edited = { title: title.value.trim(), steps: steps.value.split("\n").map((x) => x.trim()).filter(Boolean),
                       sites: sites.value.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean),
                       ...(depth.value !== was ? { depth: depth.value } : {}) };
      if (!edited.steps.length) { steps.focus(); return; }
      startResearch(message, { plan: edited });
    });
    return form;
  }
  function steerForm(message) {
    const form = el("form", "cd-steer");
    const box = el("input", "cd-steer-input");
    box.placeholder = "Add to the research: it reads this next"; box.maxLength = 1000; box.value = state.steerDraft;
    box.setAttribute("aria-label", "Add to the research"); box.dataset.keep = `steer-${message.id}`;
    box.addEventListener("input", () => { state.steerDraft = box.value; });
    const add = el("button", "cd-edit-cancel", "Add"); add.type = "submit";
    form.append(box, add);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = box.value.trim();
      if (!text) return;
      vscode.postMessage({ type: "steer", messageId: message.id, text });
      state.steerDraft = ""; box.value = "";
      announce("Added to the research.");
    });
    return form;
  }
  /** A research reply: its card (plan, progress, or how it went), then the report once there is one. */
  function researchMessage(node, message, live) {
    const r = message.research;
    const status = r.status || "";
    const last = state.messages[state.messages.length - 1] === message;
    const interrupted = !live && RESEARCHING.includes(status);       // DGC restarted while it ran
    const card = el("section", "cd-research");
    card.dataset.status = interrupted ? "interrupted" : status;
    const head = (label, sub) => {
      const top = el("header", "cd-research-head");
      top.append(icon("telescope"), el("span", "cd-research-label", label));
      if (sub) top.append(el("span", "cd-research-stats", sub));
      card.append(top);
    };
    if (status === "planning" && live) {
      head("Making a research plan…");
    } else if (status === "planned") {
      head("Research plan");
      if (state.planEditing === message.id) card.append(planEditor(message));
      else {
        card.append(planList(r.plan || {}));
        if (r.depth) card.append(el("p", "cd-plan-sites cd-plan-depth", `${depthWords(r.depth, r.budget)}.`));
        if (last && !state.busy) {
          const row = el("div", "cd-research-actions");
          const deadline = state.countdowns[message.id];
          if (deadline) row.append(el("span", "cd-countdown", `Starting in ${Math.max(1, Math.ceil((deadline - Date.now()) / 1000))}s`));
          const edit = el("button", "cd-edit-cancel", "Edit"); edit.type = "button";
          edit.addEventListener("click", () => { delete state.countdowns[message.id]; state.planEditing = message.id; update(message.id); });
          const go = el("button", "cd-continue", deadline ? "Start now" : "Start research"); go.type = "button";
          go.addEventListener("click", () => startResearch(message));
          row.append(edit, go);
          card.append(row);
        } else if (!last) card.append(el("p", "cd-research-note", "Not started."));
      }
    } else if (live && RESEARCHING.includes(status)) {
      head(status === "writing" ? "Writing the report…" : status === "checking" ? "Checking the citations…" : "Researching…", researchStats(r));
      const steps = (r.plan?.steps || []).length, covered = (r.covered || []).filter((n) => n >= 1 && n <= steps);
      const plan = kept(`plan-${message.id}`, "cd-research-more",
                        `Research plan · ${steps} steps${r.covered ? ` · ${covered.length} covered so far` : ""}`);
      plan.append(planList(r.plan || {}, covered));
      card.append(plan);
      const lines = r.activity || [];
      card.append(activityList(lines.slice(-8)));
      if ((r.steers || []).length) card.append(el("p", "cd-research-note", `You added: ${r.steers.join(" · ")}`));
      if (status === "running") card.append(steerForm(message));
    } else if (status === "done") {
      const check = r.check || {};
      head("Deep research", [researchStats(r, { round: false }),
                             check.checked ? `citations: ${check.supported} of ${check.checked} hold up` : ""].filter(Boolean).join(" · "));
      const row = el("div", "cd-research-actions");
      const open = el("button", "cd-continue", ""); open.type = "button";
      open.append(icon("screen-full"), el("span", "", "Open report"));
      open.addEventListener("click", () => openReader(message));
      row.append(open);
      card.append(row);
      const how = kept(`how-${message.id}`, "cd-research-more", "How it was researched");
      how.append(planList(r.plan || {}), activityList(r.activity || []));
      if ((check.unsupported || []).length) {
        how.append(el("p", "cd-research-note", "These claims lost their citation: the notes they cited don't support them."));
        const list = el("ul", "cd-research-unsupported");
        for (const item of check.unsupported) list.append(el("li", "", item.claim));
        how.append(list);
      }
      card.append(how);
    } else {
      const failed = status === "failed";
      head(interrupted ? "Research was interrupted" : failed ? "Research didn't finish" : "Research stopped", researchStats(r));
      if (failed && r.error) card.append(el("p", "cd-research-note cd-end-error", r.error));
      if (last && !state.busy) {
        const row = el("div", "cd-research-actions");
        if ((r.notes || []).length) {
          const write = el("button", "cd-continue", `Write the report from ${r.notes.length} source${r.notes.length === 1 ? "" : "s"}`);
          write.type = "button"; write.addEventListener("click", () => startResearch(message, { write: true }));
          row.append(write);
        }
        const more = el("button", "cd-edit-cancel", "Keep researching"); more.type = "button";
        more.addEventListener("click", () => startResearch(message));
        row.append(more);
        card.append(row);
      }
      const trail = kept(`log-${message.id}`, "cd-research-more", "What it did");
      trail.append(activityList(r.activity || []));
      card.append(trail);
    }
    node.append(card);
    // The report: as it streams, then checked.
    if (["writing", "checking", "done"].includes(status) && message.text) {
      node.append(body(message));
      // How it was researched: rounds, searches, sources found and read, minutes, the citation check. When the check
      // corrected or removed claims, the line opens on each of them: what it said, what it says now, and why.
      if (status === "done" && r.how) node.append(howLine(r, message.id));
      if (!live) { const found = sourcesBlock(message); if (found) node.append(found); }
    }
    if (status === "done" && !live) {
      const actions = el("div", "cd-actions");
      const versions = versionsControl(message);
      if (versions) actions.append(versions);
      // The report's Markdown as written, without the citation marks (its sources are listed at its end).
      actions.append(action("copy", "Copy", () => vscode.postMessage({ type: "copy", text: uncitedText(message.text, message.sources) })));
      const branch = branchAction(message);
      if (branch) actions.append(branch);
      node.append(actions);
    }
    return node;
  }
  function howLine(r, id) {
    const check = r.check || {}, fixed = check.corrected || [], gone = check.removed || [], judged = check.judgement || [];
    if (!fixed.length && !gone.length && !judged.length) return el("p", "cd-research-how", r.how);
    const box = kept(`how-line-${id}`, "cd-research-how", r.how);
    if (fixed.length) {
      box.append(el("p", "cd-research-note", "Corrected to what the sources say:"));
      const list = el("ul", "cd-research-corrected");
      for (const item of fixed) list.append(el("li", "", `${item.claim} → ${item.now}${item.why ? ` (${item.why})` : ""}`));
      box.append(list);
    }
    if (gone.length) {
      box.append(el("p", "cd-research-note", "Removed: no source backed them."));
      const list = el("ul", "cd-research-removed");
      for (const item of gone) list.append(el("li", "", item.why && item.why !== "No source backed it." ? `${item.claim} (${item.why})` : item.claim));
      box.append(list);
    }
    if (judged.length) {
      box.append(el("p", "cd-research-note", "Kept as the report's own reasoning, without a citation:"));
      const list = el("ul", "cd-research-judgement");
      for (const item of judged) list.append(el("li", "", item.claim));
      box.append(list);
    }
    return box;
  }
  /** The report on its own, as ChatGPT's full-screen view has it: contents, the report, and its sources. */
  function openReader(message) {
    $("cd-reader")?.remove();
    const title = message.research?.plan?.title || "Report";
    const shell = el("div", "cd-reader");
    shell.id = "cd-reader";
    shell.setAttribute("role", "dialog"); shell.setAttribute("aria-modal", "true"); shell.setAttribute("aria-label", title);
    const top = el("header", "cd-reader-head");
    const exporting = el("button", "cd-edit-cancel", "Export…"); exporting.type = "button";
    exporting.addEventListener("click", () => vscode.postMessage({ type: "exportReport", messageId: message.id, title }));
    const close = action("close", "Close", () => { shell.remove(); input.focus(); });
    top.append(el("span", "cd-reader-title", title), exporting, close);
    const article = body(message);
    article.classList.add("cd-reader-text");
    const toc = el("nav", "cd-reader-toc");
    toc.setAttribute("aria-label", "Contents");
    toc.append(el("p", "cd-reader-label", "Contents"));
    article.querySelectorAll("h1, h2, h3").forEach((heading, i) => {
      heading.id = `cd-reader-h${i}`;
      const link = el("button", `cd-reader-link cd-reader-${heading.tagName.toLowerCase()}`, heading.textContent || "");
      link.type = "button";
      link.addEventListener("click", () => heading.scrollIntoView({ block: "start" }));
      toc.append(link);
    });
    const side = el("aside", "cd-reader-sources");
    if ((message.sources || []).length) side.append(el("p", "cd-reader-label", "Sources"), sourcesList(message));
    const page = el("div", "cd-reader-body");
    page.append(toc, article, side);
    shell.append(top, page);
    shell.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); shell.remove(); input.focus(); } });
    document.body.append(shell);
    close.focus();
  }
  function messageNode(message) {
    const live = state.busy && message.id === state.replyId;
    const node = el("article", `cd-msg cd-${message.role === "user" ? "user" : "assistant"}`);
    node.dataset.id = message.id || "";
    if (message.role === "user") {
      const sent = Array.isArray(message.attachments) ? message.attachments : [];
      const pictures = sent.filter((item) => item.kind === "image" && !item.removed && /^att_[a-f0-9]{32}$/.test(item.id || ""));
      if (pictures.length) {
        const row = el("div", "cd-thumbs");
        for (const item of pictures) row.append(thumb(item));
        node.append(row);
      }
      const others = sent.filter((item) => !pictures.includes(item));
      if (others.length) {
        const list = el("ul", "cd-chips cd-sent");
        list.setAttribute("aria-label", "Attached");
        list.append(...others.map((item) => chip(item)));
        node.append(list);
      }
      if (message.vision?.text) {
        const seen = el("details", "cd-seen");
        seen.append(el("summary", "", `Seen by ${message.vision.model || "a vision model"}`), el("div", "cd-seen-text", message.vision.text));
        node.append(seen);
      }
      if (message.research && state.editing !== message.id) {
        const chip = el("span", "cd-research-chip");
        chip.append(icon("telescope"), el("span", "", "Deep research"));
        node.append(chip);
      }
      if (message.canvas && typeof message.canvas === "object") {
        // Asked from a canvas about part of it: which part, above what was asked.
        const c = message.canvas, lines = c.start_line === c.end_line ? `line ${c.start_line}` : `lines ${c.start_line}\u2013${c.end_line}`;
        const about = el("div", "cd-user-canvas");
        about.append(icon("note"), el("span", "", `About ${lines} of ${c.title || "the canvas"}`));
        about.title = String(c.text || "").slice(0, 600);
        node.append(about);
      }
      if (state.editing === message.id) node.append(editor(message));
      else if (message.text) {
        const bubble = el("div", "cd-bubble");
        bubble.textContent = message.text;
        node.append(bubble);
      }
      const actions = el("div", "cd-actions");
      const versions = versionsControl(message);
      if (versions) actions.append(versions);
      if (state.editing !== message.id) {
        actions.append(action("copy", "Copy", () => vscode.postMessage({ type: "copy", text: message.text || "" })));
        actions.append(idleOnly(action("edit", "Edit", () => { state.editing = message.id; state.editingFresh = true; render(); })));
      }
      if (versions) actions.classList.add("cd-actions-shown");
      // When it was sent, at the row's right edge, under the bubble (media/msgtime.js). It stays when the buttons hide.
      const sentAt = window.DgcTime?.node(Date.parse(message.created_at), "cd-time");
      if (sentAt) actions.append(sentAt);
      node.append(actions);
      return node;
    }
    if (message.research && typeof message.research === "object") return researchMessage(node, message, live);
    if (message.thinking) node.append(thinkingBlock(message, live));
    { const strip = picturesStrip(message); if (strip) node.append(strip); }
    if (message.text || !live || message.questions?.length) node.append(...replyParts(message, live));
    { const analysis = analysisNode(message); if (analysis) node.append(analysis); }
    for (const w of Array.isArray(message.widgets) ? message.widgets : []) {
      if (w && /^wg_[a-f0-9]{16}$/.test(String(w.id || "")) && (typeof w.html === "string" || w.removed === true)) {
        node.append(widgetCard(message, w.removed ? "" : w.html, { ref: `${message.id}:${w.id}`, id: w.id, title: String(w.title || "Interactive").slice(0, 80),
                                                                   removed: w.removed === true }));
      }
    }
    for (const file of Array.isArray(message.files) ? message.files : []) node.append(fileCard(message, file));
    for (const canvas of Array.isArray(message.canvases) ? message.canvases : []) node.append(canvasCard(canvas));
    for (const card of Array.isArray(message.actions) ? message.actions : []) node.append(actionCard(message, card, live));
    const doing = live && state.searching[message.id];
    if (doing) node.append(wave(doing.kind === "looking"
      ? `Looking at the image with ${doing.text}…` : doing.kind === "plugin" ? `Using ${doing.text}…` : doing.kind === "making" ? `Making ${doing.text || "the file"}…` : doing.kind === "canvas" ? `Writing in the canvas ${doing.text}…` : doing.kind === "analyzing" ? "Analyzing the data…" : doing.kind === "compacting"
      ? "Summarizing earlier messages to fit the context window…" : `Searching the web for “${doing.text}”…`, "div", "cd-working cd-activity"));
    else if (live && !message.text && !message.thinking) node.append(wave("Thinking", "div", "cd-working"));
    if (message.partial) node.append(el("p", "cd-end", "This reply is too long to show in full here."));
    if (!live) { const found = sourcesBlock(message); if (found) node.append(found); }
    if (!live) { const kept = memoryNote(message); if (kept) node.append(kept); }
    if (!live) { const used = pluginsNote(message); if (used) node.append(used); }
    const end = endNote(message);
    if (end) node.append(end);
    const next = !live ? followupsNode(message) : null;
    if (!live && (message.text || message.versions)) {
      const actions = el("div", "cd-actions");
      const versions = versionsControl(message);
      if (versions) actions.append(versions);
      actions.append(action("copy", "Copy", () => copyReply(message)));
      if (reader && message.text) actions.append(readAction(message));
      const again = action("refresh", "Try again", () => {
        vscode.postMessage({ type: "regenerate", messageId: message.id, model: modelPick.value || "",
                             thinking: thinkingPick.value || "", search: searchMode() });
        state.busy = true; controls();
      });
      actions.append(idleOnly(again));
      const branch = branchAction(message);
      if (branch) actions.append(branch);
      if (message.model) actions.append(el("span", "cd-meta", String(message.model)));
      // When it was written, first in the row, where the reply begins (media/msgtime.js).
      const writtenAt = window.DgcTime?.node(Date.parse(message.created_at), "cd-time");
      if (writtenAt) actions.prepend(writtenAt);
      node.append(actions);
    }
    if (next) node.append(next);
    return node;
  }
  // ---- projects (ChatGPT's): chats, files and instructions together. A chat in one says so in its header; a new
  // chat in one is the project's page (its instructions, files, memory and chats), and what's sent starts a chat.
  function projectOf(conversation) {
    const id = conversation?.project;
    return id ? state.projects.find((p) => p.id === id) || null : null;
  }
  function upsertProject(project) {
    if (!project?.id) return;
    const at = state.projects.findIndex((p) => p.id === project.id);
    if (at >= 0) state.projects[at] = { ...state.projects[at], ...project }; else state.projects.push(project);
  }
  function isProjectPage() {
    return state.opened && !state.messages.length && !state.earlier && !!projectOf(state.conversation);
  }
  function folderIcon(project) {
    const glyph = icon("folder"); glyph.classList.add("project-icon"); glyph.dataset.color = project.color || "purple";
    return glyph;
  }
  function crumb() {
    const button = $("cd-crumb"), project = projectOf(state.conversation);
    button.hidden = !project || isProjectPage();
    if (button.hidden) return;
    button.replaceChildren(folderIcon(project), el("span", "cd-crumb-name", project.name), icon("chevron-right"));
    button.title = `Open the project ${project.name}`;
    button.setAttribute("aria-label", `Project: ${project.name}. Open its page`);
  }
  $("cd-crumb").addEventListener("click", () => {
    const project = projectOf(state.conversation);
    if (project) vscode.postMessage({ type: "openProject", id: project.id });
  });
  const firstWords = (text, n = 220) => { const flat = String(text || "").replace(/\s+/g, " ").trim(); return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat; };
  function projectPage() {
    const project = projectOf(state.conversation);
    const page = el("div", "cd-project");
    const head = el("div", "cd-project-head");
    head.append(folderIcon(project), el("h2", "cd-project-name", project.name),
                action("settings-gear", "Project settings", () => openProjectPanel(project)));
    const instructions = el("button", "cd-project-card");
    instructions.type = "button";
    instructions.append(el("span", "cd-project-card-title", "Instructions"),
      el("span", "cd-project-card-text", project.instructions ? firstWords(project.instructions)
        : "Tell ChatDGC how to answer in this project: a voice, a format, what to keep in mind."));
    instructions.addEventListener("click", () => openProjectPanel(project, "instructions"));
    const files = el("div", "cd-project-card cd-project-files");
    const top = el("div", "cd-project-card-row");
    const count = (project.files || []).length;
    top.append(el("span", "cd-project-card-title", count ? `Files · ${count}` : "Files"));
    const add = el("button", "cd-edit-cancel", "Add files");
    add.type = "button";
    add.addEventListener("click", () => vscode.postMessage({ type: "projectAddFiles", id: project.id }));
    top.append(add);
    files.append(top);
    if (count) {
      const list = el("ul", "cd-chips cd-project-chips");
      list.setAttribute("aria-label", "The project's files");
      for (const file of project.files) list.append(chip(file, () => vscode.postMessage({ type: "projectRemoveFile", id: project.id, fileId: file.id })));
      files.append(list);
    } else files.append(el("span", "cd-project-card-text", "Every chat in this project reads them."));
    const cards = el("div", "cd-project-cards");
    cards.append(instructions, files);
    const memory = el("p", "cd-project-memory", project.memory === "project"
      ? "Memory: this project's only. Its chats don't see your saved memories."
      : "Memory: shared with your other chats, Work and Pips.");
    const chats = el("section", "cd-project-chats");
    chats.setAttribute("aria-label", "Chats in this project");
    chats.append(el("h3", "", "Chats"));
    const known = state.projectChats?.project === project.id ? state.projectChats.items : null;
    if (!known) {
      chats.append(el("p", "cd-project-note", "Loading…"));
      if (state.projectChatsAsked !== project.id) {
        state.projectChatsAsked = project.id;
        vscode.postMessage({ type: "projectChats", id: project.id });
      }
    } else if (!known.length) chats.append(el("p", "cd-project-note", "No chats yet. Write below to start the first one."));
    else {
      const list = el("ul", "cd-project-list");
      for (const chat of known) {
        const row = el("li");
        const open = el("button", "cd-project-chat");
        open.type = "button";
        open.append(el("span", "cd-project-chat-title", chat.title || "New chat"),
                    el("span", "cd-project-chat-preview", firstWords(chat.preview, 140)));
        open.addEventListener("click", () => vscode.postMessage({ type: "openChat", id: chat.id }));
        row.append(open);
        list.append(row);
      }
      chats.append(list);
    }
    page.append(head, cards, memory, chats);
    return page;
  }
  const PROJECT_COLORS = ["purple", "blue", "teal", "green", "yellow", "orange", "red", "pink", "gray"];
  /** Project settings, beside the page as the Sources panel is: name, colour, instructions, memory, Delete. */
  function openProjectPanel(project, focus) {
    $("cd-project-panel")?.remove();
    const panel = el("aside", "cd-panel cd-project-panel");
    panel.id = "cd-project-panel";
    panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", "Project settings");
    const back = document.activeElement;
    const done = () => { panel.remove(); (back && back.isConnected ? back : input).focus(); };
    const top = el("header", "cd-panel-head");
    const close = action("close", "Close", done);
    top.append(el("h2", "cd-panel-title", "Project settings"), close);
    const form = el("form", "cd-project-form");
    const nameLabel = el("label", "cd-field-label", "Name");
    const name = el("input", "cd-field"); name.id = "cd-project-name"; name.value = project.name; name.maxLength = 80;
    nameLabel.htmlFor = name.id;
    const colors = el("fieldset", "cd-project-colors");
    colors.append(el("legend", "cd-field-label", "Colour"));
    for (const color of PROJECT_COLORS) {
      const option = el("label", "cd-swatch");
      const radio = el("input"); radio.type = "radio"; radio.name = "cd-project-color"; radio.value = color;
      radio.checked = (project.color || "purple") === color;
      radio.setAttribute("aria-label", color);
      option.append(radio, folderIcon({ color }));
      option.title = color[0].toUpperCase() + color.slice(1);
      colors.append(option);
    }
    const instLabel = el("label", "cd-field-label", "Instructions");
    const inst = el("textarea", "cd-field cd-project-instructions"); inst.id = "cd-project-instructions"; inst.rows = 8; inst.maxLength = 8000;
    inst.value = project.instructions || ""; inst.placeholder = "How ChatDGC should answer in this project. Your own instructions still apply; these win where they differ.";
    instLabel.htmlFor = inst.id;
    const counter = el("span", "cd-field-note", "");
    const tally = () => { counter.textContent = `${inst.value.length.toLocaleString()} / 8,000`; };
    inst.addEventListener("input", tally); tally();
    const memory = el("fieldset", "cd-project-memory-choice");
    memory.append(el("legend", "cd-field-label", "Memory"));
    for (const [value, label, about] of [
      ["shared", "Shared", "Chats here use the memory you share with your other chats, Work and Pips."],
      ["project", "Project-only", "Chats here don't see your saved memories, and nothing is saved to them. They know this project's other chats."]]) {
      const option = el("label", "cd-radio");
      const radio = el("input"); radio.type = "radio"; radio.name = "cd-project-memory"; radio.value = value;
      radio.checked = (project.memory || "shared") === value;
      option.append(radio, el("span", "cd-radio-label", label), el("span", "cd-radio-about", about));
      memory.append(option);
    }
    const row = el("div", "cd-edit-actions");
    const cancel = el("button", "cd-edit-cancel", "Cancel"); cancel.type = "button"; cancel.addEventListener("click", done);
    const save = el("button", "cd-continue", "Save"); save.type = "submit";
    row.append(cancel, save);
    const remove = el("button", "cd-project-delete", "Delete project…"); remove.type = "button";
    remove.addEventListener("click", () => vscode.postMessage({ type: "projectDelete", id: project.id, name: project.name, chats: Number(project.chats) || 0 }));
    form.append(nameLabel, name, colors, instLabel, inst, counter, memory, row, remove);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!name.value.trim()) { name.focus(); return; }
      panel.dataset.saving = "1"; save.disabled = true;
      vscode.postMessage({ type: "projectSave", id: project.id, name: name.value.trim(),
        color: form.querySelector('input[name="cd-project-color"]:checked')?.value || project.color,
        instructions: inst.value, memory: form.querySelector('input[name="cd-project-memory"]:checked')?.value || "shared" });
    });
    panel.append(top, form);
    panel.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(); } });
    document.body.append(panel);
    (focus === "instructions" ? inst : name).focus();
  }
  // ---- plugins: a card under a reply for what the model would do in one of your plugins (ChatGPT's confirmation).
  // Nothing goes until you choose: Send it now (with your edits), Hand it to a Pip (first for something recurring),
  // or Don't. Its inputs are the model's: text only, and editable here.
  function cardFields(args) {
    const keys = Object.keys(args || {});
    if (keys.length > 20) return [{ key: null, kind: "json", value: JSON.stringify(args, null, 2) }];
    return keys.map((key) => {
      const v = args[key], kind = typeof v === "string" ? "text" : typeof v === "number" ? "number" : typeof v === "boolean" ? "boolean" : "json";
      return { key, kind, value: kind === "text" ? v : kind === "json" ? JSON.stringify(v, null, 2) : String(v) };
    });
  }
  /** The inputs as the user left them; says which one to fix when one won't read. */
  function editedArgs(args, values) {
    const out = [];
    for (const [i, f] of cardFields(args).entries()) {
      const raw = String(values[i] ?? "");
      if (f.kind === "text") { out.push([f.key, raw]); continue; }
      if (f.kind === "number") {
        const t = raw.trim(), n = Number(t);
        if (!/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(t) || !Number.isFinite(n)) throw new Error(`${f.key} needs a number.`);
        out.push([f.key, n]); continue;
      }
      if (f.kind === "boolean") {
        const b = raw.trim().toLowerCase();
        if (b !== "true" && b !== "false") throw new Error(`${f.key} needs true or false.`);
        out.push([f.key, b === "true"]); continue;
      }
      let parsed;
      try { parsed = JSON.parse(raw); } catch { throw new Error(`${f.key === null ? "The inputs" : f.key} aren't valid JSON. Check the brackets and quotes.`); }
      if (f.key === null) {
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("The inputs need to be one JSON object.");
        return parsed;
      }
      out.push([f.key, parsed]);
    }
    return Object.fromEntries(out);
  }
  const shown = (v) => { const t = typeof v === "string" ? v : JSON.stringify(v); return t.length > 400 ? `${t.slice(0, 399)}…` : t; };
  // A file the reply made (made.py), as ChatGPT hands you report.docx: what it is, Open, and Save a copy….
  const MADE = { docx: ["Word document", "DOCX"], pdf: ["PDF", "PDF"], xlsx: ["Excel workbook", "XLSX"],
                 pptx: ["PowerPoint presentation", "PPTX"], csv: ["CSV", "CSV"], md: ["Markdown", "MD"] };
  function fileCard(message, file) {
    const [label, badge] = MADE[file.format] || ["File", "FILE"];
    const box = el("div", "cd-file");
    box.dataset.format = String(file.format || "");
    if (file.removed) box.dataset.removed = "true";
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", `${file.name || "file"}, ${label}`);
    box.append(el("span", "cd-file-badge", badge));
    const words = el("div", "cd-file-words");
    words.append(el("strong", "cd-file-name", file.name || "file"));
    const pages = Number(file.pages) || 0;
    const meta = [label, Number(file.size) ? sizeText(Number(file.size)) : "", pages ? `${pages} page${pages === 1 ? "" : "s"}` : ""];
    words.append(el("small", "cd-file-meta", file.removed ? "Deleted from your Library" : meta.filter(Boolean).join(" · ")));
    if (file.note && !file.removed) words.append(el("small", "cd-file-note", String(file.note)));
    box.append(words);
    if (!file.removed) {
      const buttons = el("div", "cd-file-actions");
      const open = el("button", "cd-continue cd-file-open", "Open");
      open.type = "button";
      open.addEventListener("click", () => vscode.postMessage({ type: "fileOpen", messageId: message.id, fileId: file.id, name: file.name }));
      const save = el("button", "cd-edit-cancel cd-file-save", "Save a copy…");
      save.type = "button";
      save.addEventListener("click", () => vscode.postMessage({ type: "fileSave", messageId: message.id, fileId: file.id, name: file.name }));
      buttons.append(open, save);
      box.append(buttons);
    }
    return box;
  }

  /** A canvas the reply made or changed: it's open in an editor beside the chat; Open brings it back. */
  function canvasCard(canvas) {
    const box = el("div", "cd-file cd-canvas");
    box.dataset.kind = String(canvas.kind || "document");
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", `Canvas: ${canvas.title || "Canvas"}`);
    const mark = el("span", "cd-file-badge cd-canvas-badge");
    mark.append(icon(canvas.kind === "code" ? "code" : "file-text"));
    box.append(mark);
    const words = el("div", "cd-file-words");
    words.append(el("strong", "cd-file-name", canvas.title || "Canvas"));
    const what = canvas.kind === "code" ? `${canvas.language && canvas.language !== "text" ? canvas.language[0].toUpperCase() + canvas.language.slice(1) + " code" : "Code"}` : "Document";
    words.append(el("small", "cd-file-meta", `Canvas \u00b7 ${what} \u00b7 ${canvas.op === "created" ? "made" : "changed"}, version ${Number(canvas.version) || 1}`));
    box.append(words);
    const buttons = el("div", "cd-file-actions");
    const open = el("button", "cd-continue cd-canvas-open", "Open");
    open.type = "button";
    open.addEventListener("click", () => vscode.postMessage({ type: "canvasOpen", canvasId: canvas.id }));
    buttons.append(open);
    box.append(buttons);
    return box;
  }

  function actionCard(message, card, live) {
    const box = el("div", "cd-card");
    box.dataset.action = card.id; box.dataset.status = card.status || "waiting";
    box.setAttribute("role", "group");
    const waiting = card.status === "waiting", plugin = card.plugin_name || card.plugin || "the plugin";
    box.setAttribute("aria-label", `${card.tool} in ${plugin}`);
    const head = el("div", "cd-card-head");
    head.append(el("span", "cd-card-mark", plugin.slice(0, 1).toUpperCase()));
    const words = el("div", "cd-card-words");
    words.append(el("strong", "", waiting ? `Do this in ${plugin}?` : `${card.tool} in ${plugin}`));
    if (waiting) words.append(el("small", "", card.money ? `${card.tool} · ${plugin} can move money, so it always asks.`
                                                         : `${card.tool} · nothing happens until you choose.`));
    head.append(words);
    box.append(head);
    const args = card.sent_arguments || card.arguments || {};
    const editing = waiting ? state.cardEdit[card.id] : null;
    if (editing) {
      const form = el("div", "cd-card-fields");
      cardFields(card.arguments).forEach((f, i) => {
        const label = el("label", "cd-field-label", f.key === null ? "Inputs (JSON)" : f.key + (f.kind === "json" ? " (JSON)" : ""));
        const long = f.kind === "json" || f.kind === "text" && (f.value.length > 80 || f.value.includes("\n"));
        const input = el(long ? "textarea" : "input", "cd-field");
        input.id = `cd-card-${card.id}-${i}`; label.htmlFor = input.id;
        if (long) input.rows = f.kind === "json" ? 4 : 3;
        input.value = editing.values[i] ?? f.value;
        input.dataset.keep = input.id;
        input.addEventListener("input", () => { editing.values[i] = input.value; editing.error = ""; });
        form.append(label, input);
      });
      if (editing.error) form.append(el("p", "cd-card-error", editing.error));
      box.append(form);
    } else {
      const keys = Object.keys(args);
      if (keys.length) {
        const list = el("dl", "cd-card-inputs");
        for (const key of keys.slice(0, 12)) list.append(el("dt", "", key), el("dd", "", shown(args[key])));
        box.append(list);
      }
    }
    if (waiting) {
      const busy = state.cardBusy[card.id], off = live || !!busy;
      const row = el("div", "cd-card-actions");
      const send = el("button", card.recurring ? "cd-edit-cancel" : "cd-continue", busy === "sending" ? "Sending…" : "Send it now");
      send.type = "button"; send.title = `Do it in ${plugin} now`;
      send.addEventListener("click", () => {
        let edited;
        if (state.cardEdit[card.id]) {
          try { edited = editedArgs(card.arguments, state.cardEdit[card.id].values); }
          catch (e) { state.cardEdit[card.id].error = e.message; update(message.id); return; }
        }
        state.cardBusy[card.id] = "sending"; update(message.id);
        vscode.postMessage({ type: "actionRun", messageId: message.id, actionId: card.id, ...(edited ? { arguments: edited } : {}) });
      });
      const pip = el("button", card.recurring ? "cd-continue" : "cd-edit-cancel", busy === "handing" ? "Handing it over…" : "Hand it to a Pip");
      pip.type = "button"; pip.title = "One of your Pips takes it on: best for something recurring, or that has to wait";
      pip.addEventListener("click", () => {
        state.cardBusy[card.id] = "handing"; update(message.id);
        vscode.postMessage({ type: "actionHand", messageId: message.id, actionId: card.id });
      });
      const edit = el("button", "cd-edit-cancel", editing ? "Undo changes" : "Edit");
      edit.type = "button";
      edit.addEventListener("click", () => {
        if (state.cardEdit[card.id]) delete state.cardEdit[card.id];
        else state.cardEdit[card.id] = { values: cardFields(card.arguments).map((f) => f.value), error: "" };
        update(message.id);
      });
      const no = el("button", "cd-edit-cancel", "Don't"); no.type = "button";
      no.addEventListener("click", () => { state.cardBusy[card.id] = "dismissing"; update(message.id);
        vscode.postMessage({ type: "actionDismiss", messageId: message.id, actionId: card.id }); });
      // Something recurring, or that has to wait, is a Pip's: that choice comes first.
      row.append(...(card.recurring ? [pip, send] : [send, pip]), ...(Object.keys(card.arguments || {}).length ? [edit] : []), no);
      for (const b of row.querySelectorAll("button")) b.disabled = off;
      box.append(row);
      if (live) box.append(el("p", "cd-card-note", "You can choose once the reply is finished."));
    } else {
      const said = card.status === "done" ? "Done." + (card.sent_arguments ? " Sent with your changes." : "")
        : card.status === "failed" ? `Didn't go: ${card.error || "no answer."}`
        : card.status === "handed" ? `Handed to ${card.pip?.name || "your Pip"}: it takes it from here.`
        : card.status === "dismissed" ? "Not sent." : "";
      box.append(el("p", `cd-card-status cd-card-${card.status}`, said));
      if (card.status === "done" && card.answer) {
        const more = el("details", "cd-card-answer");
        more.append(el("summary", "", `What ${plugin} answered`), el("pre", "", String(card.answer)));
        box.append(more);
      }
    }
    return box;
  }
  /** Follow-ups (ChatGPT's): a few next messages under the chat's last reply; one click sends it. Not under an older
   *  reply (the conversation moved on), and not while a reply is being written. */
  function followupsNode(message) {
    const list = Array.isArray(message.followups) ? message.followups.filter((f) => typeof f === "string" && f.trim()) : [];
    if (!list.length || state.messages[state.messages.length - 1] !== message || state.busy) return null;
    const box = el("div", "cd-followups");
    box.setAttribute("role", "group"); box.setAttribute("aria-label", "Suggested follow-ups");
    for (const text of list.slice(0, 3)) {
      const button = el("button", "cd-followup");
      button.type = "button"; button.title = "Send this";
      button.append(icon("arrow-right"), el("span", "", text));
      button.addEventListener("click", () => sendText(text));
      box.append(button);
    }
    return box;
  }
  /** Send words that aren't in the box (a follow-up): the box keeps whatever you were typing. */
  function sendText(text) {
    if (!text.trim() || state.busy || !state.conversation || state.unavailable) return;
    vscode.postMessage({ type: "send", text, model: modelPick.value || "", thinking: thinkingPick.value || "", search: searchMode() });
    state.lastSent = { text, research: false, pending: [], followup: true };
    state.busy = true;
    hideNotice(); controls();
  }
  /** Branch in new chat (ChatGPT's): this conversation up to here, in a new chat of its own, opened in a tab. */
  function branchAction(message) {
    if (state.conversation?.temporary || !message.id) return null;
    return idleOnly(action("git-branch", "Branch in new chat", () => vscode.postMessage({ type: "branch", messageId: message.id })));
  }
  // ---- the context window: what earlier was summarized, and what a chat carried over from another
  function summaryNode() {
    const summary = state.conversation?.summary;
    const box = el("details", "cd-summary");
    box.open = state.editingSummary;
    const label = el("summary", "cd-summary-label", "Earlier messages summarized" + (summary.edited ? " (edited by you)" : ""));
    box.append(label);
    if (state.editingSummary) {
      const area = el("textarea", "cd-input cd-edit-input"); area.value = summary.text || ""; area.rows = 6;
      area.setAttribute("aria-label", "Edit the summary");
      const row = el("div", "cd-edit-actions");
      const cancel = el("button", "cd-edit-cancel", "Cancel"); cancel.type = "button";
      const save = el("button", "cd-continue", "Save"); save.type = "button";
      cancel.addEventListener("click", () => { state.editingSummary = false; render(); });
      save.addEventListener("click", () => {
        if (!area.value.trim()) return;
        vscode.postMessage({ type: "summary", text: area.value });
        state.editingSummary = false;
      });
      row.append(cancel, save);
      box.append(area, row);
    } else {
      box.append(summaryText(summary.text));
      const note = el("p", "cd-summary-note", "The model reads this in place of the messages above it. They stay here for you.");
      const edit = idleOnly(el("button", "cd-edit-cancel", "Edit summary"));
      edit.type = "button";
      edit.addEventListener("click", () => { state.editingSummary = true; render(); });
      box.append(note, edit);
    }
    return box;
  }
  /** Where a branch leaves the chat it came from: what's above is that chat's, what's below is this one's. */
  function branchedNode() {
    const branched = state.conversation.branched;
    const line = el("div", "cd-branched");
    line.setAttribute("role", "separator");
    const open = el("button", "cd-branched-from", branched.title || "a chat");
    open.type = "button"; open.title = "Open the chat this branch came from";
    open.addEventListener("click", () => vscode.postMessage({ type: "openChat", id: branched.from }));
    const words = el("span", "cd-branched-words");
    words.append(icon("git-branch"), el("span", "", "Branched from "), open);
    line.append(words);
    return line;
  }
  function carriedNode() {
    const carried = state.conversation.carried;
    const box = el("details", "cd-summary cd-carried");
    box.append(el("summary", "cd-summary-label", `Continued from \u201c${carried.title || "a chat"}\u201d`),
               summaryText(carried.text));
    return box;
  }
  /** The meter: what the chat takes of its window, amber from 70%, red from 85%. */
  function meter() {
    const c = state.context, button = $("cd-context");
    button.hidden = !c || !c.window || !state.conversation;
    if (button.hidden) { $("cd-context-pop").hidden = true; return; }
    const share = Math.min(1, c.used / c.window);
    const percent = Math.round(share * 100);
    $("cd-context-pct").textContent = `${percent}%`;
    button.dataset.level = share >= 0.85 ? "high" : share >= 0.7 ? "mid" : "low";
    button.title = `Context: ${c.used.toLocaleString()} of ${c.window.toLocaleString()} tokens`;
    button.setAttribute("aria-label", `Context window: ${percent}% used. Show details`);
    if (!$("cd-context-pop").hidden) { popover(); vscode.postMessage({ type: "breakdown" }); }
  }
  function popover() {
    const c = state.context, pop = $("cd-context-pop");
    const share = Math.min(1, c.used / c.window);
    const line = (label, value) => { const row = el("div", "cd-pop-row"); row.append(el("span", "", label), el("span", "cd-pop-num", value)); return row; };
    const parts = c.parts || {};
    const names = { instructions: "Instructions", summary: "Summary", files: "Files", conversation: "Conversation" };
    const presets = { "8k": "8k", "32k": "32k", "128k": "128k", max: "the model's maximum" };
    // Compact now keeps the last exchange word for word: with nothing older left to summarize, it says so here
    // rather than failing after the click.
    const compact = el("button", "cd-edit-cancel", state.compacting ? "Summarizing…" : "Compact now");
    compact.type = "button"; compact.dataset.whileIdle = "1";
    if (!c.compactable) compact.dataset.never = "1";
    compact.disabled = state.busy || state.compacting || !c.compactable;
    compact.title = "Summarize everything before the last exchange";
    const why = c.compactable || state.compacting ? null : el("p", "cd-pop-note cd-pop-why", state.conversation?.summary
      ? "Everything before your last exchange is already summarized."
      : "Nothing to compact yet: Compact now keeps your last exchange word for word.");
    compact.addEventListener("click", () => { vscode.postMessage({ type: "compact" }); state.compacting = true; render(); controls(); popover(); });
    const carry = el("button", "cd-edit-cancel", "Continue in a new chat");
    carry.type = "button"; carry.dataset.whileIdle = "1";
    if (!state.messages.length || state.conversation?.temporary) carry.dataset.never = "1";
    carry.disabled = state.busy || state.compacting || !state.messages.length || !!state.conversation?.temporary;
    carry.title = "Start a new chat that carries a summary of this one";
    carry.addEventListener("click", () => { vscode.postMessage({ type: "carry" }); state.compacting = true; render(); controls(); popover(); });
    // As main DGC lays out its own: what's used of the window, a bar, what's left, then what fills it. With the
    // breakdown in, its count is the one shown (the parts add up to it).
    const counted = state.breakdown && state.breakdown.conversation === state.conversation?.id ? state.breakdown.of : null;
    const used = counted ? counted.used : c.used, room = counted ? counted.window : c.window;
    const head = el("div", "context-head"), named = el("div");
    named.append(el("span", "context-kicker", "Context window"), el("strong", "", `${used.toLocaleString()} / ${room.toLocaleString()}`));
    head.append(named, el("span", "cd-pop-pct", `${Math.round(Math.min(1, used / (room || 1)) * 100)}%`));
    // What fills it, part by part (as Claude's Usage sheet), once counted for this chat; until then, the meter's lines.
    const drawn = counted && window.DgcBreakdown ? window.DgcBreakdown.render(counted) : null;
    const track = el("div", "context-track"), fill = el("span");
    fill.style.width = `${(share * 100).toFixed(1)}%`;
    track.append(fill);
    const split = el("div", "context-split");
    split.append(el("span", "", `${Math.max(0, c.window - c.used).toLocaleString()} free`), el("span", "", c.source === "reported" ? "as the model counted them" : "estimated"));
    const rows = el("div", "cd-pop-rows");
    rows.append(...Object.entries(names).filter(([key]) => parts[key]).map(([key, label]) => line(label, Number(parts[key]).toLocaleString())));
    // The window's size, as main DGC's menu sets its own: here, for every chat (a backend that says which it takes).
    const size = el("div", "context-size");
    if (state.windows.length) {
      const label = el("label", "context-kicker", "Window size");
      label.htmlFor = "cd-window-size";
      const pick = el("select", "context-size-select");
      pick.id = "cd-window-size";
      pick.title = "How much of the chat the model is sent, for every chat";
      const names = { "1m": "1M", max: "Model's maximum" };
      for (const preset of state.windows) {
        const option = el("option", "", names[preset] || preset.toUpperCase());
        option.value = preset;
        pick.append(option);
      }
      pick.value = state.windows.includes(c.preset) ? c.preset : "";
      pick.dataset.whileIdle = "1";                  // like Compact now: not while a reply is written
      pick.disabled = state.busy || state.compacting;
      pick.addEventListener("change", () => vscode.postMessage({ type: "window", preset: pick.value }));
      const controls = el("div", "context-size-controls");
      controls.append(pick);
      size.append(label, controls);
    }
    const note = el("div", "context-last");
    note.append(icon("history"), el("span", "", (state.windows.length ? "For every chat" : `Window: ${presets[c.preset] || c.preset} (Settings → ChatDGC)`)
      + (c.limit ? `. This model can take up to ${c.limit.toLocaleString()}.` : ".")
      + " Near the limit, older messages are summarized and the recent ones kept word for word."));
    compact.className = "context-action"; carry.className = "context-action cd-pop-second";
    pop.replaceChildren(head, ...(drawn ? [drawn] : [track, split, rows]), ...(state.windows.length ? [size] : []), note,
                        ...(why ? [why] : []), compact, carry);
  }
  $("cd-context").addEventListener("click", () => {
    const pop = $("cd-context-pop");
    pop.hidden = !pop.hidden;
    $("cd-context").setAttribute("aria-expanded", String(!pop.hidden));
    if (!pop.hidden) { popover(); vscode.postMessage({ type: "breakdown" }); }
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest?.("#cd-context, #cd-context-pop")) { $("cd-context-pop").hidden = true; $("cd-context").setAttribute("aria-expanded", "false"); }
  });
  // ---- the chat's outline: every prompt, when it was sent, and the widgets the replies to it made. What's on screen
  // says it for the pages loaded; for a long chat opened on its latest pages, the backend's outline (chatdgc_outline,
  // asked once the chat opens) says it for the rest. The Widgets list and the prompt rail both read it.
  const reduceMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  const promptWords = (m) => String(m.text || "").replace(/\s+/g, " ").trim()
    || (Array.isArray(m.attachments) ? m.attachments.map((a) => a?.name || "attachment").join(", ") : "");
  const WIDGET_ID = /^wg_[a-f0-9]{16}$/;
  const removedWidgets = new Set();          // deleted from this chat's list (said by the host), its reply maybe not on screen
  function storedWidgets(m) {
    return (Array.isArray(m.widgets) ? m.widgets : []).filter((w) => w && WIDGET_ID.test(String(w.id || "")))
      .map((w) => ({ id: w.id, message_id: m.id, title: String(w.title || "Interactive").slice(0, 80), created_at: w.created_at || m.created_at || "",
                     removed: w.removed === true || removedWidgets.has(w.id), html: typeof w.html === "string" ? w.html : "" }));
  }
  /** A message from before what's on screen: older than the first one shown, or one the outline places earlier. */
  function earlierThanShown(message) {
    const first = Date.parse(state.messages[0]?.created_at || ""), at = Date.parse(message.created_at || "");
    if (Number.isFinite(first) && Number.isFinite(at)) return at < first;
    return (state.outline?.prompts || []).some((p) => (p?.widgets || []).some((w) => w?.message_id === message.id));
  }
  function outlineNow() {
    const loaded = new Set(state.messages.map((m) => m.id));
    const prompts = [];
    const told = state.earlier > 0 && state.outline?.conversation === state.conversation?.id ? state.outline.prompts : [];
    for (const p of told) {
      if (!p || typeof p.id !== "string" || loaded.has(p.id)) break;      // the rest are on screen: read from there
      prompts.push({ id: p.id, text: String(p.text || ""), created_at: String(p.created_at || ""), loaded: false,
                     widgets: (Array.isArray(p.widgets) ? p.widgets : []).filter((w) => w && WIDGET_ID.test(String(w.id || "")) && !loaded.has(w.message_id))
                       .map((w) => ({ id: w.id, message_id: String(w.message_id || ""), title: String(w.title || "Interactive").slice(0, 80),
                                      created_at: String(w.created_at || ""), removed: w.removed === true || removedWidgets.has(w.id), html: "" })) });
    }
    let current = prompts[prompts.length - 1] || null;
    for (const m of state.messages) {
      if (m.role === "user") {
        current = { id: m.id, text: promptWords(m).slice(0, 160), created_at: m.created_at || "", loaded: true, widgets: [] };
        prompts.push(current);
      } else if (current) current.widgets.push(...storedWidgets(m));
    }
    return prompts;
  }
  /** Every widget the chat's replies made, in the order they were made, with the prompt that asked. */
  const chatWidgets = () => outlineNow().flatMap((p) => p.widgets.map((w) => ({ ...w, prompt: p.text })));

  // ---- going to a message: scrolled to (eased, unless the reader asked for less motion) and outlined for a moment.
  // One not on screen yet is reached first: the pages before what's shown are asked for until it's among them.
  let seeking = null;
  function reach(messageId, then) {
    if (state.messages.some((m) => m.id === messageId)) { then(); return; }
    if (!(state.earlier > 0) || !state.messages.length) { showNotice("That part of the chat isn't there any more.", "info"); return; }
    seeking = { id: messageId, then };
    announce("Loading earlier messages…");
    $("cd-earlier").disabled = true;
    vscode.postMessage({ type: "earlier", before: state.messages[0].id });
  }
  function sought() {
    if (!seeking) return;
    const s = seeking;
    if (state.messages.some((m) => m.id === s.id)) { seeking = null; s.then(); }
    else if (state.earlier > 0) { $("cd-earlier").disabled = true; vscode.postMessage({ type: "earlier", before: state.messages[0].id }); }
    else { seeking = null; showNotice("That part of the chat isn't there any more.", "info"); }
  }
  let gliding = 0;
  /** The view moved so `node` sits `at` of the way down it (a little above the middle). */
  function glide(node, at = 0.3) {
    cancelAnimationFrame(gliding);
    const box = scroller.getBoundingClientRect(), r = node.getBoundingClientRect();
    const from = scroller.scrollTop;
    const to = Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, from + r.top - box.top - box.height * at));
    pinned = false;                         // the reader is going somewhere: the reply going on doesn't pull them back
    if (reduceMotion() || Math.abs(to - from) < 2) { scroller.scrollTop = to; return; }
    const t0 = performance.now(), ms = 320;
    const step = (now) => {
      const t = Math.min(1, (now - t0) / ms);
      scroller.scrollTop = from + (to - from) * (1 - (1 - t) ** 3);
      if (t < 1) gliding = requestAnimationFrame(step);
    };
    gliding = requestAnimationFrame(step);
  }
  function flash(node) {
    node.classList.remove("cd-flash");
    void node.offsetWidth;                  // so it plays again on a node that just played it
    node.classList.add("cd-flash");
    setTimeout(() => node.classList.remove("cd-flash"), 1600);
  }

  // ---- widgets in this chat (option C1, the founder's pick): a "Widgets N" button in the header while the chat has
  // any, opening a list of them: each one's name, when it was made and the prompt that asked, with Open, Show it in the
  // chat (its earlier pages loaded first when it isn't on screen) and Delete (asked in the row, then the Library's
  // delete: its card stays, marked deleted). Every chat's widgets are in the Library, a click away.
  const widgetsButton = $("cd-widgets");
  let widgetsPanel = null, widgetConfirm = "";
  const widgetDeleting = new Set();
  function widgetsChrome() {
    const all = chatWidgets(), live = all.filter((w) => !w.removed).length;
    widgetsButton.hidden = !state.conversation || (!live && !widgetsPanel);
    $("cd-widgets-count").textContent = String(live);
    const name = `Widgets in this chat: ${live}`;
    if (widgetsButton.getAttribute("aria-label") !== name) widgetsButton.setAttribute("aria-label", name);
    if (widgetsPanel) fillWidgets(all);
  }
  function widgetRow(w) {
    const row = el("li", "cd-wrow");
    row.dataset.widget = w.id;
    if (w.removed) row.dataset.removed = "";
    const badge = el("span", "cd-wbadge");
    badge.append(icon("play-circle"));
    const words = el("span", "cd-wwords");
    const when = window.DgcTime?.label(Date.parse(w.created_at)) || "";
    const meta = w.removed ? "Deleted" : [when, w.prompt ? `from “${w.prompt}”` : ""].filter(Boolean).join(" · ");
    words.append(el("span", "cd-wname", w.title), el("span", "cd-wmeta", meta));
    if (w.prompt) words.title = `${w.title}\n${when ? `${when} · ` : ""}from “${w.prompt}”`;
    row.append(badge, words);
    if (w.removed) return row;
    const acts = el("span", "cd-wacts");
    const button = (cls, label, text, glyph, onClick) => {
      const b = el("button", cls, text);
      b.type = "button"; b.dataset.w = `${w.id}:${cls.split(" ")[1] || cls}`;
      b.setAttribute("aria-label", label); b.title = label;
      if (glyph) b.append(icon(glyph));
      b.addEventListener("click", onClick);
      return b;
    };
    if (widgetDeleting.has(w.id)) acts.append(el("span", "cd-wconfirm", "Deleting…"));
    else if (widgetConfirm === w.id) {
      const sure = el("span", "cd-wconfirm", "Delete it?");
      acts.append(sure,
        button("cd-wbtn cd-wdanger", `Delete ${w.title}`, "Delete", "", () => {
          widgetConfirm = ""; widgetDeleting.add(w.id);
          vscode.postMessage({ type: "widgetRemove", id: w.id });
          widgetsChrome(); widgetsPanel?.focus();
          announce(`Deleting ${w.title}.`);
        }),
        button("cd-wbtn cd-wcancel", "Keep it", "Cancel", "", () => { widgetConfirm = ""; widgetsChrome(); focusW(`${w.id}:cd-wdel`); }));
    } else {
      acts.append(button("cd-wbtn cd-wopen", `Open ${w.title} beside the chat`, "Open", "", () => openWidget(w)),
                  button("cd-wicon cd-wgo", `Show ${w.title} in the chat`, undefined, "arrow-right", () => showWidgetInChat(w)));
      if (!state.conversation?.temporary) {
        acts.append(button("cd-wicon cd-wdel", `Delete ${w.title}`, undefined, "trash", () => {
          widgetConfirm = w.id; widgetsChrome(); focusW(`${w.id}:cd-wdanger`);
        }));
      }
    }
    row.append(acts);
    return row;
  }
  const focusW = (key) => widgetsPanel?.querySelector(`[data-w="${CSS.escape(key)}"]`)?.focus();
  function fillWidgets(all = chatWidgets()) {
    const had = document.activeElement?.dataset?.w;
    const live = all.filter((w) => !w.removed).length;
    const head = el("div", "cd-whead");
    const title = el("h2", "cd-wtitle", "Widgets in this chat");
    title.id = "cd-widgets-title";
    head.append(title, el("span", "cd-wcount", all.length ? `${live}, in the order they were made` : ""));
    const list = el("ul", "cd-wlist");
    list.setAttribute("aria-labelledby", title.id);
    list.append(...all.map(widgetRow));
    if (!all.length) list.append(el("li", "cd-wempty", "No widgets in this chat."));
    const parts = [head, list];
    if (!state.conversation?.temporary) {
      const foot = el("div", "cd-wfoot");
      const library = el("button", "cd-wlink", "Open the Library");
      library.type = "button"; library.dataset.w = "library";
      library.addEventListener("click", () => { closeWidgets(false); vscode.postMessage({ type: "openLibrary", view: "widgets" }); });
      foot.append(el("span", "", "Every chat's widgets are in the Library."), library);
      parts.push(foot);
    }
    widgetsPanel.replaceChildren(...parts);
    if (had) focusW(had);
    placeWidgets();
  }
  function placeWidgets() {
    if (!widgetsPanel) return;
    const b = widgetsButton.getBoundingClientRect(), width = Math.min(400, window.innerWidth - 24);
    widgetsPanel.style.width = `${width}px`;
    widgetsPanel.style.top = `${Math.round(b.bottom + 6)}px`;
    widgetsPanel.style.left = `${Math.round(Math.max(12, Math.min(window.innerWidth - width - 12, b.right - width)))}px`;
  }
  function openWidgets() {
    if (widgetsPanel) return;
    widgetsPanel = el("div", "cd-wpanel");
    widgetsPanel.id = "cd-widgets-panel";
    widgetsPanel.setAttribute("role", "dialog");
    widgetsPanel.tabIndex = -1;
    widgetsPanel.setAttribute("aria-labelledby", "cd-widgets-title");
    widgetsPanel.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault(); e.stopPropagation();
      if (widgetConfirm) { const id = widgetConfirm; widgetConfirm = ""; widgetsChrome(); focusW(`${id}:cd-wdel`); }
      else closeWidgets(true);
    });
    document.body.append(widgetsPanel);
    widgetsButton.setAttribute("aria-expanded", "true");
    fillWidgets();
    (widgetsPanel.querySelector(".cd-wopen") || widgetsPanel.querySelector("button"))?.focus();
  }
  function closeWidgets(focusButton) {
    if (!widgetsPanel) return;
    widgetsPanel.remove(); widgetsPanel = null; widgetConfirm = "";
    widgetsButton.setAttribute("aria-expanded", "false");
    widgetsChrome();
    if (focusButton && !widgetsButton.hidden) widgetsButton.focus();
  }
  widgetsButton.addEventListener("click", () => (widgetsPanel ? closeWidgets(false) : openWidgets()));
  document.addEventListener("click", (e) => {
    if (widgetsPanel && !e.composedPath().some((n) => n === widgetsPanel || n === widgetsButton)) closeWidgets(false);
  });
  window.addEventListener("resize", placeWidgets);
  function openWidget(w) {
    // Its page from its card when its reply is on screen; else the host asks the backend for it, as the Library does.
    vscode.postMessage({ type: "widgetOpen", id: w.id, title: w.title, ...(w.html ? { html: w.html } : {}) });
  }
  function showWidgetInChat(w) {
    closeWidgets(false);
    reach(w.message_id, () => {
      const card = log.querySelector(`.cd-msg[data-id="${CSS.escape(w.message_id)}"] .cd-widget[data-ref="${CSS.escape(`${w.message_id}:${w.id}`)}"]`);
      if (!card) { showNotice("That widget's card isn't in this version of the chat.", "info"); return; }
      glide(card);
      flash(card.querySelector(".cd-widget-card") || card);
      card.querySelector(".cd-widget-open")?.focus({ preventScroll: true });
    });
  }

  // ---- the prompt rail (ChatGPT's "table of contents", media/promptrail.js, the same as the Work chat's): every prompt
  // from the outline, even those on pages not on screen; going to one of those loads the pages before it first.
  const promptNode = (id) => log.querySelector(`.cd-msg.cd-user[data-id="${CSS.escape(id)}"]`);
  const promptRail = window.DgcPromptRail?.create({
    id: "cd-rail", scroller, input,
    visible: () => state.opened && !!state.conversation && !document.body.classList.contains("cd-blank")
      && !document.body.classList.contains("cd-on-project"),
    prompts: () => outlineNow().map((p) => ({ ...p, at: Date.parse(p.created_at) })),
    top: (p) => promptNode(p.id)?.getBoundingClientRect().top ?? null,
    landing: () => { const box = scroller.getBoundingClientRect(); return box.top + box.height * 0.04; },
    go: (p, then) => reach(p.id, then),
    show: (p) => {
      const node = promptNode(p.id);
      if (!node) return false;
      glide(node, 0.04);
      flash(node.querySelector(".cd-bubble") || node);
      return true;
    },
    // A CLI with no outline: the prompts before what's on screen can't be listed until they're loaded.
    more: (list) => (state.earlier > 0 && !list.some((p) => !p.loaded)
      ? { label: "Earlier messages aren't listed yet: load them", run: () => $("cd-earlier").click() } : null),
    announce: (text) => announce(text),
  });
  const railChrome = () => promptRail?.refresh();

  function render() {
    const nodes = state.messages.map(messageNode);
    const upto = state.conversation?.summary?.upto;
    const at = upto ? state.messages.findIndex((m) => m.id === upto) : -1;
    if (at >= 0) nodes.splice(at + 1, 0, summaryNode());
    const branched = state.conversation?.branched;
    if (branched?.at) {
      const after = nodes.findIndex((n) => n.dataset?.id === branched.at);
      if (after >= 0) nodes.splice(after + 1, 0, branchedNode());
    }
    if (state.conversation?.carried?.text) nodes.unshift(carriedNode());
    if (state.compacting) nodes.push(wave("Summarizing earlier messages to fit the context window…", "div", "cd-working cd-activity"));
    // Each thinking box keeps the reader's place in it, and its focus, through a whole redraw (a reply finishing).
    const places = [...log.querySelectorAll("details.cd-thinking")].map((d) => {
      const words = d.querySelector(".cd-thought");
      return [d.dataset.id, words.scrollTop, words === document.activeElement];
    });
    log.replaceChildren(...nodes);
    for (const [id, top, focused] of places) {
      const words = log.querySelector(`details.cd-thinking[data-id="${CSS.escape(id)}"] .cd-thought`);
      if (words && top) words.scrollTop = top;
      if (words && focused) words.focus({ preventScroll: true });
    }
    if (state.editingFresh) {
      // Just opened: the box takes the keys now, with the caret at the end. Doing it a frame later moved the
      // caret under whatever was typed in that frame, so a select-all-and-type appended instead of replacing.
      state.editingFresh = false;
      const box = log.querySelector(".cd-edit-input");
      if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
    }
    $("cd-earlier").hidden = !(state.earlier > 0);
    const blank = state.opened && !state.messages.length && !state.earlier, page = blank && isProjectPage();
    document.body.classList.toggle("cd-blank", blank && !page);
    document.body.classList.toggle("cd-on-project", page);
    $("cd-empty").hidden = !blank;
    const empty = page ? projectPage() : welcome();
    if (!$("cd-empty").contains(empty)) $("cd-empty").replaceChildren(empty);      // the welcome stays put: no replayed drawing
    $("cd-title").textContent = page ? projectOf(state.conversation).name : state.conversation?.title || "New chat";
    crumb();
    controls();
    widgetsChrome();
    follow();
    railChrome();
  }
  /** One message changed (a streamed part): redraw it alone, at most once a frame. */
  let redraw = new Set(), frame = 0;
  function update(id) {
    redraw.add(id);
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      for (const each of redraw) {
        const message = state.messages.find((m) => m.id === each);
        const old = log.querySelector(`.cd-msg[data-id="${CSS.escape(each)}"]`);
        if (!message) continue;
        const fresh = messageNode(message);
        // A field you're typing in (marked data-keep) keeps the keys and the caret: research redraws as it goes.
        const typing = old && old.contains(document.activeElement) ? document.activeElement : null;
        const key = typing?.dataset?.keep;
        const caret = key && typeof typing.selectionStart === "number" ? [typing.selectionStart, typing.selectionEnd] : null;
        const shown = old ? redrawIn(old, fresh) : (log.append(fresh), fresh);
        const twin = key ? shown.querySelector(`[data-keep="${CSS.escape(key)}"]`) : null;
        if (twin) { if (twin !== document.activeElement) twin.focus(); if (caret) twin.setSelectionRange(caret[0], caret[1]); }
      }
      redraw.clear();
      document.body.classList.remove("cd-blank");
      $("cd-empty").hidden = true;
      widgetsChrome();
      follow();
      railChrome();
    });
  }
  /** A reply drawn again over what's on screen. A streaming reply is drawn again for every part that comes; what
   *  hasn't changed stays the very same nodes, never taken out of the page and put back: the thinking box (open or
   *  closed, the reader's place in it, the pointer over its label), the pictures, and the line saying what it's doing.
   *  A node taken out and put back loses its hover and restarts its animation: "Thinking" flickered with every part. */
  function redrawIn(old, fresh) {
    const keep = new Map();                         // a fresh node -> the one on screen that stands for it
    const was = old.querySelector(":scope > details.cd-thinking"), now = fresh.querySelector(":scope > details.cd-thinking");
    if (was && now) {
      // The same thinking box, its words and label brought up to date.
      if (was.dataset.live !== now.dataset.live) {
        was.dataset.live = now.dataset.live;
        was.querySelector(".cd-thinking-label").replaceChildren(...now.querySelector(".cd-thinking-label").childNodes);
      }
      const words = was.querySelector(".cd-thought"), following = was.open && atEnd(words);
      setText(words, now.querySelector(".cd-thought").textContent);
      if (following) words.scrollTop = words.scrollHeight;     // at its end: it follows the words as they come
      if (was.open !== now.open) was.open = now.open;
      keep.set(now, was);
    }
    // The pictures, unchanged: a picture drawn again would flicker.
    const strip = old.querySelector(":scope > .cd-pictures"), stripNow = fresh.querySelector(":scope > .cd-pictures");
    if (strip && stripNow && strip.dataset.key === stripNow.dataset.key) keep.set(stripNow, strip);
    // What it's doing, unchanged: its wave goes on where it was.
    const doing = old.querySelector(":scope > .cd-working"), doingNow = fresh.querySelector(":scope > .cd-working");
    if (doing && doingNow && doing.className === doingNow.className && doing.textContent === doingNow.textContent) keep.set(doingNow, doing);
    const order = [...fresh.childNodes].map((n) => keep.get(n) || n);
    const kept = order.filter((n) => n.parentNode === old);
    const onScreen = [...old.childNodes].filter((n) => kept.includes(n));
    if (kept.some((n, i) => onScreen[i] !== n)) {
      // Kept nodes in another order (never expected): the reply drawn afresh, the kept ones moved into it.
      for (const [now2, was2] of keep) now2.replaceWith(was2);
      old.replaceWith(fresh);
      return fresh;
    }
    for (const child of [...old.childNodes]) if (!kept.includes(child)) child.remove();
    let after = null;
    for (const node of order) {
      if (node.parentNode === old) { after = node; continue; }      // kept: already where it belongs
      if (after) after.after(node); else old.prepend(node);
      after = node;
    }
    old.className = fresh.className;
    return old;
  }
  /** A node's text set to `text`; words that came at the end are added, not the whole text written again. */
  function setText(node, text) {
    const now = node.textContent;
    if (now === text) return;
    const only = node.childNodes.length === 1 && node.firstChild.nodeType === Node.TEXT_NODE ? node.firstChild : null;
    if (only && now && text.startsWith(now)) only.appendData(text.slice(now.length));
    else node.textContent = text;
  }

  // ---- the composer
  function controls() {
    for (const button of document.querySelectorAll("[data-while-idle]")) {
      button.disabled = state.busy || state.compacting || button.dataset.never === "1";
    }
    const text = input.value;
    // An empty box offers voice mode where Send is, as ChatGPT does; a word typed, and it's Send again.
    const empty = !text.trim() && !state.pending.length;
    const offerVoice = !!voiceMode && empty && !state.busy && !!state.conversation && !state.unavailable && !state.compacting;
    if (voiceModeButton) voiceModeButton.hidden = !offerVoice;
    // While it answers, Send stays beside Stop for what you've typed: it queues it (Codex's queue).
    const queueing = busyNow() && !empty;
    send.hidden = offerVoice || (busyNow() && empty);
    stop.hidden = !state.busy;
    send.disabled = empty || !state.conversation || !!state.unavailable;
    const sendLabel = queueing ? "Queue: sends when the reply finishes" : "Send";
    if (send.title !== sendLabel) { send.title = sendLabel; send.setAttribute("aria-label", queueing ? "Queue message" : "Send"); }
    send.classList.toggle("cd-queueing", queueing);
    input.disabled = !!state.unavailable;
    const fresh = !state.conversation || (!state.messages.length && !state.earlier);
    // A chat carried over isn't thrown away, and a project's chat is kept: neither can be temporary.
    $("cd-temp-toggle").hidden = !fresh || !!state.conversation?.carried || !!state.conversation?.project;
    placeholder();
    $("cd-temporary").checked = !!state.conversation?.temporary;
    $("cd-temp-badge").hidden = !state.conversation?.temporary;
    $("cd-menu").hidden = !state.conversation || !!state.conversation.temporary || fresh;
  }
  function grow() {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
  }
  input.addEventListener("input", () => { grow(); controls(); saveDraft(); });
  // ---- undo and redo (media/texthistory.js): the box's own history, as the coding chat's box and Codex's have one.
  // The textarea's would do for typing, but not for what this page does to the box itself -- a message sent or given
  // back, words dictated, a long paste folded into a chip -- which it either never recorded or lost track of.
  const history = window.DgcTextHistory ? window.DgcTextHistory.create({
    box: () => input,
    list: { get: () => state.pending, set: (items) => { state.pending = items; chips(); } },
    changed: () => { grow(); controls(); saveDraft(); },
  }) : null;
  const edit = (change, kind) => (history ? history.record(change, kind) : change());
  input.addEventListener("keydown", (e) => history?.keydown(e), true);
  input.addEventListener("beforeinput", (e) => history?.beforeinput(e), true);
  input.addEventListener("input", () => history?.input(), true);
  input.addEventListener("compositionstart", () => history?.compositionstart());
  input.addEventListener("compositionend", () => history?.compositionend());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
    else if (e.key === "Escape" && (micState === "recording" || micState === "starting")) { e.preventDefault(); e.stopPropagation(); micCancel(); }
    else if (e.key === "Escape" && state.busy) { e.preventDefault(); stopReply(); }
    else if (e.key === "ArrowUp" && !input.value && !state.pending.length && queued().length && !e.isComposing) {
      e.preventDefault();                       // the last queued message, back to the box to change it
      const taken = queued().pop(); saveQueue(); queueView(); giveBack(taken);
    }
  });
  $("cd-box").addEventListener("submit", (e) => { e.preventDefault(); submit(); });
  /** Stop: the reply ends where it is, and nothing queued goes after it. */
  function stopReply() { state.stopping = true; vscode.postMessage({ type: "stop" }); }
  stop.addEventListener("click", stopReply);

  // ---- dictation: the microphone beside Send records on the computer you're at (DGC Voice). While it records, the
  // box's bottom row is the voice bar (media/voicebar.js): Cancel, the live waveform and time, Stop (what you said
  // goes in the box) and Send (it goes in the box and is sent). The first press with no model opens Settings -> Voice.
  const mic = $("cd-mic"), voiceRow = $("cd-voice"), box = $("cd-box");
  const voice = window.DgcVoiceBar ? window.DgcVoiceBar.create("chatdgc") : null;
  if (voice) voiceRow.innerHTML = voice.markup(); else mic.hidden = true;
  let micState = "idle";
  function micShow(next, action = "") {
    micState = ["starting", "recording", "writing"].includes(next) ? next : "idle";
    voice?.state(micState, action);
    box.classList.toggle("dictating", micState !== "idle");
    if (micState === "recording") announce("Recording. Stop to add it to your message, or press Escape to cancel.");
  }
  function micCancel() {
    micShow("idle");
    vscode.postMessage({ type: "micCancel" });
    announce("Recording cancelled.");
    input.focus();
  }
  mic.addEventListener("click", () => {
    if (micState !== "idle") return;
    hideNotice();
    micShow("starting");
    vscode.postMessage({ type: "micStart" });
  });
  voiceRow.addEventListener("click", (e) => {
    const action = e.target.closest?.("[data-voice-action]")?.dataset.voiceAction;
    if (action === "cancel") micCancel();
    else if ((action === "stop" || action === "send") && micState === "recording") {
      micShow("writing", action);
      vscode.postMessage({ type: "micStop", mode: action === "send" ? "send" : "insert" });
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && voiceMode?.active) { e.preventDefault(); e.stopPropagation(); voiceMode.end(); return; }
    if (e.key === "Escape" && (micState === "recording" || micState === "starting") && e.target !== input) { e.preventDefault(); micCancel(); }
  }, true);

  // ---- voice mode (media/voicemode.js): a spoken conversation. The box's bottom row is its bar: End, the waveform
  // (yours while it listens, the reply's while it speaks) and Done / Stop.
  // (var: controls() may run before these lines do, and reads them as not-yet-made.)
  var voiceModeButton = $("cd-voicemode");
  var voiceTalk = window.DgcVoiceBar ? window.DgcVoiceBar.create("chatdgc-talk") : null;
  var voiceMode = voiceTalk && reader && window.DgcVoiceMode ? window.DgcVoiceMode.create({
    bar: voiceTalk, reader,
    post: (m) => vscode.postMessage(m),
    deliver: (text) => edit(() => { input.value = ""; dictated(text); submit(true); }),
    messages: () => state.messages,
    show: (on) => {
      if (box.classList.contains("talking") === on) return;   // only when voice mode comes or goes
      box.classList.toggle("talking", on);
      voiceRow.innerHTML = on ? voiceTalk.markup("conversation") : (voice ? voice.markup() : "");
      if (on) voiceTalk.refresh();
    },
    notify: (text, kind) => showNotice(text, kind),
  }) : null;
  voiceModeButton.addEventListener("click", () => { hideNotice(); voiceMode?.start(); });
  voiceRow.addEventListener("click", (e) => {
    const action = e.target.closest?.("[data-voice-action]")?.dataset.voiceAction;
    if (voiceMode?.active && (action === "end" || action === "turn")) voiceMode.action(action);
  });
  /** What was said, at the caret (or over the selection), spaced from its neighbours. */
  function dictated(text) {
    const start = input.selectionStart ?? input.value.length, end = input.selectionEnd ?? start;
    const before = input.value.slice(0, start), after = input.value.slice(end);
    const piece = (before && !/\s$/.test(before) ? " " : "") + text + (after && !/^\s/.test(after) ? " " : "");
    input.focus();
    edit(() => input.setRangeText(piece, start, end, "end"));
    grow(); controls(); saveDraft();
    announce("Added what you said.");
  }
  function submit(spoken = false) {
    const text = input.value;
    if ((!text.trim() && !state.pending.length) || !state.conversation || state.unavailable) return;
    if (state.research && state.pending.length) { showNotice("Deep research reads the web: send files without it, or turn it off.", "info"); return; }
    if (state.research && !text.trim()) return;
    const item = { text, research: !!state.research, model: modelPick.value || "", thinking: thinkingPick.value || "",
                   search: searchMode(), study: !!state.study, pending: state.pending };
    // One step, so Cmd+Z right after sending brings the message back, chips and all.
    edit(() => { input.value = ""; state.pending = []; });
    grow(); saveDraft(); chips();
    if (state.research) researchMode(false);
    // While it's answering (or summarizing), the message waits its turn, as Codex queues one: it goes when the
    // reply finishes. Voice mode never gets here busy -- it waits for the reply itself.
    if (busyNow()) { enqueue(item); controls(); return; }
    dispatch(item, spoken);
  }
  /** Sends one message the box held (now, or when its turn came). */
  function dispatch(item, spoken = false) {
    if (item.research) {
      vscode.postMessage({ type: "research", text: item.text, model: item.model, thinking: item.thinking });
      state.lastSent = { text: item.text, research: true, pending: [] };
      state.planAsked = true; state.busy = true;
      hideNotice(); controls();
      return;
    }
    vscode.postMessage({ type: "send", text: item.text, model: item.model, thinking: item.thinking,
                         search: item.search, study: item.study, ...(spoken ? { voice: true } : {}),
                         ...(item.pending.length ? { attachments: item.pending.map(({ kind, path, name, data, text: pasted, conversation_id, project_id, attachment_id }) =>
                           ({ kind, name, ...(path ? { path } : {}), ...(data ? { data } : {}), ...(pasted ? { text: pasted } : {}),
                              ...(kind === "library" ? { ...(conversation_id ? { conversation_id } : { project_id }), attachment_id } : {}) })) } : {}) });
    state.lastSent = { text: item.text, research: false, pending: item.pending };
    state.busy = true;        // until the turn says otherwise: no second send in the meantime
    hideNotice();
    controls();
  }

  // ---- the queue (Codex's): messages sent while it's answering wait above the box, in order. When the reply
  // finishes, the first goes, and the next when that one's reply finishes. Stop, or a reply that failed, sends
  // none of them: they all come back to the box, as Codex gives them back, for you to decide. Kept per chat with
  // the draft, so a reload doesn't lose them (they come back to the box then, never sent on their own).
  const MAX_QUEUED = 10;
  const queueKey = (id) => `queue:${id || "new"}`;
  const busyNow = () => state.busy || state.compacting;
  function queued() {
    const id = state.conversation?.id || "new";
    if (state.queueFor !== id) {
      state.queueFor = id;
      try { const saved = (vscode.getState() || {})[queueKey(id)]; state.queue = Array.isArray(saved) ? saved : []; } catch { state.queue = []; }
    }
    return state.queue;
  }
  function saveQueue() {
    try {
      // Pasted images and long pastes stay in memory only: the state a webview keeps is small.
      const light = queued().map((item) => ({ ...item, pending: item.pending.filter((p) => !p.data) }));
      vscode.setState({ ...(vscode.getState() || {}), [queueKey(state.queueFor)]: light.length ? light : undefined });
    } catch {}
  }
  function enqueue(item) {
    const list = queued();
    if (list.length >= MAX_QUEUED) {
      giveBack(item);
      showNotice(`${MAX_QUEUED} messages are already waiting: send them first, or remove one.`, "info");
      return;
    }
    list.push(item); saveQueue(); queueView();
    announce(`Queued: it goes when the reply finishes${list.length > 1 ? `, after ${list.length - 1} more` : ""}.`);
  }
  /** One queued message back in the box, below anything typed there. */
  function giveBack(item) {
    const typed = input.value.trim();
    edit(() => {
      input.value = typed ? `${typed}\n\n${item.text}` : item.text;
      state.pending = [...state.pending, ...item.pending];
    });
    chips();
    if (item.research && !typed) researchMode(true);
    grow(); saveDraft(); controls();
  }
  /** Every queued message back in the box, in order, after Stop or a reply that failed. */
  function restoreQueue() {
    const list = queued().splice(0);
    if (!list.length) return;
    const typed = input.value.trim();
    edit(() => {
      input.value = [...list.map((item) => item.text.trim()), ...(typed ? [typed] : [])].filter(Boolean).join("\n\n");
      state.pending = [...list.flatMap((item) => item.pending), ...state.pending];
    });
    chips();
    grow(); saveDraft(); saveQueue(); queueView(); controls();
    announce(list.length === 1 ? "The queued message is back in the box." : `The ${list.length} queued messages are back in the box.`);
  }
  /** The reply finished: the next queued message goes. */
  function sendNext() {
    if (busyNow() || state.unavailable || !state.conversation) return;
    const list = queued();
    if (!list.length) return;
    const item = list.shift(); saveQueue(); queueView();
    dispatch(item);
  }
  function queueView() {
    const box = $("cd-queue");
    const list = queued();
    box.hidden = !list.length;
    if (!list.length) { box.replaceChildren(); return; }
    const head = el("p", "cd-queue-head", list.length === 1 ? "Queued: sends when the reply finishes" : `${list.length} queued: each sends when the reply before it finishes`);
    const rows = el("ol", "cd-queue-list");
    list.forEach((item, i) => {
      const row = el("li", "cd-queue-item");
      const words = item.text.trim().replace(/\s+/g, " ") || item.pending.map((p) => p.name).join(", ");
      const text = el("span", "cd-queue-text", (item.research ? "Deep research: " : "") + words);
      text.title = item.text;
      const files = item.pending.length ? el("span", "cd-queue-files", `+${item.pending.length}`) : null;
      if (files) files.title = item.pending.map((p) => p.name).join(", ");
      const edit = el("button", "cd-icon cd-queue-edit");
      edit.type = "button"; edit.title = "Edit: back to the box"; edit.setAttribute("aria-label", `Edit queued message ${i + 1}`);
      edit.append(icon("edit"));
      edit.addEventListener("click", () => { const [taken] = queued().splice(i, 1); saveQueue(); queueView(); giveBack(taken); input.focus(); });
      const remove = el("button", "cd-icon cd-queue-remove");
      remove.type = "button"; remove.title = "Remove"; remove.setAttribute("aria-label", `Remove queued message ${i + 1}`);
      remove.append(icon("close"));
      remove.addEventListener("click", () => { queued().splice(i, 1); saveQueue(); queueView(); input.focus(); });
      row.append(el("span", "cd-queue-mark", "\u21b3"), text, ...(files ? [files] : []), edit, remove);
      rows.append(row);
    });
    box.replaceChildren(head, rows);
  }
  const researchToggle = $("cd-research");
  /** Deep research for the next message: a plan first, then the reading. Off again once it's sent. */
  function researchMode(on) {
    state.research = !!on;
    researchToggle.setAttribute("aria-pressed", String(state.research));
    placeholder();
  }
  const studyToggle = $("cd-study");
  /** Study mode: the chat's, on from the next message until it's turned off (the conversation says which). */
  function studyMode(on) {
    state.study = !!on;
    studyToggle.setAttribute("aria-pressed", String(state.study));
    placeholder();
  }
  /** What the box asks for: research, study, a project's new chat, or anything. (Every redraw asks this.) */
  function placeholder() {
    const project = isProjectPage() ? projectOf(state.conversation) : null;
    input.placeholder = state.research ? "What should I research?" : state.study ? "What do you want to learn?"
      : project ? `New chat in ${project.name}` : "Ask anything";
  }
  researchToggle.addEventListener("click", () => { researchMode(!state.research); input.focus(); });
  studyToggle.addEventListener("click", () => { studyMode(!state.study); input.focus(); });
  modelPick.addEventListener("change", () => { state.model = modelPick.value; });
  thinkingPick.addEventListener("change", () => { state.thinking = thinkingPick.value; });
  $("cd-temporary").addEventListener("change", (e) => vscode.postMessage({ type: "newChat", temporary: e.target.checked }));
  $("cd-new").addEventListener("click", () => vscode.postMessage({ type: "newChat" }));
  $("cd-attach").addEventListener("click", () => vscode.postMessage({ type: "attach" }));
  /** A pasted image, scaled so its longer side is at most IMAGE_SIDE; JPEG when that is smaller. */
  function pastedImage(file) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        const picture = new Image();
        picture.onload = () => {
          const scale = Math.min(1, IMAGE_SIDE / Math.max(picture.naturalWidth, picture.naturalHeight));
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(picture.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(picture.naturalHeight * scale));
          canvas.getContext("2d").drawImage(picture, 0, 0, canvas.width, canvas.height);
          const png = canvas.toDataURL("image/png"), jpeg = canvas.toDataURL("image/jpeg", 0.88);
          resolve(jpeg.length < png.length ? jpeg : png);
        };
        picture.onerror = () => resolve(null);
        picture.src = String(reader.result || "");
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
  }
  // ---- dropping files: from VS Code's Explorer they come as addresses (the extension checks and reads them);
  // from the system's file manager as files, which the page can read only when they're images or text.
  const TEXT_FILE = /\.(txt|md|markdown|csv|tsv|json|log|ya?ml|xml|html?|css|js|ts|py|sh|sql|toml|ini)$/i;
  const carriesFiles = (e) => [...(e.dataTransfer?.types || [])].some((t) => t === "Files" || /uri-list/.test(t));
  document.addEventListener("dragover", (e) => {
    if (!carriesFiles(e) || state.unavailable) return;
    e.preventDefault();
    document.body.classList.add("cd-dropping");
  });
  document.addEventListener("dragleave", (e) => { if (!e.relatedTarget) document.body.classList.remove("cd-dropping"); });
  document.addEventListener("drop", async (e) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    document.body.classList.remove("cd-dropping");
    const listed = e.dataTransfer.getData("application/vnd.code.uri-list") || e.dataTransfer.getData("text/uri-list") || "";
    let uris = [];
    try { uris = listed.trim().startsWith("[") ? JSON.parse(listed) : listed.split(/\r?\n/); } catch { uris = []; }
    uris = uris.map((u) => String(u).trim()).filter((u) => u && !u.startsWith("#") && u.startsWith("file:"));
    if (uris.length) { vscode.postMessage({ type: "dropped", uris }); return; }
    let skipped = 0;
    for (const file of [...(e.dataTransfer.files || [])].slice(0, 10 - state.pending.length)) {
      if (/^image\/(png|jpeg|gif|webp)$/.test(file.type)) {
        const data = await pastedImage(file);
        if (data) state.pending.push({ kind: "image", name: file.name || "Image", data, size: Math.round(data.length * 0.75) });
      } else if ((file.type.startsWith("text/") || TEXT_FILE.test(file.name)) && file.size <= 2 * 1024 * 1024) {
        state.pending.push({ kind: "text", name: file.name, text: await file.text() });
      } else skipped++;
    }
    if (skipped) showNotice("Use the paperclip to attach that kind of file.", "info");
    chips(); controls(); input.focus();
  });
  input.addEventListener("paste", async (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => /^image\/(png|jpeg|gif|webp)$/.test(f.type));
    const words = e.clipboardData?.getData("text/plain") || "";
    if (files.length) {
      e.preventDefault();
      for (const file of files.slice(0, 10 - state.pending.length)) {
        const data = await pastedImage(file);
        if (data) edit(() => state.pending.push({ kind: "image", name: file.name && file.name !== "image.png" ? file.name : "Pasted image", data,
                                                  size: Math.round(data.length * 0.75) }));
        else showNotice("That image couldn't be read.");
      }
      chips(); controls();
    } else if (words.length > PASTE_AS_FILE && state.pending.length < 10) {
      e.preventDefault();
      edit(() => state.pending.push({ kind: "text", name: "Pasted text", text: words }));
      chips(); controls();
    }
  });
  $("cd-menu").addEventListener("click", () => vscode.postMessage({ type: "menu" }));
  $("cd-earlier").addEventListener("click", (e) => {
    const first = state.messages[0];
    if (!first) return;
    e.currentTarget.disabled = true;
    vscode.postMessage({ type: "earlier", before: first.id });
  });
  function fillModels() {
    const current = state.model || state.conversation?.model || state.defaultModel || "";
    const ids = [...new Set([current, ...state.models].filter(Boolean))];
    modelPick.replaceChildren(...ids.map((id) => { const option = el("option", "", id); option.value = id; return option; }));
    modelPick.value = current;
    modelPick.hidden = !ids.length;
    thinkingPick.value = state.thinking || state.conversation?.thinking || "off";
    updatePill();
    if (!modelMenu.hidden) renderModelMenu();
  }

  // ---- the welcome: ChatDGC's mark, its slashes drawn in one after another, and a line for the time of day,
  // chosen once a chat (a render must never change it under you). A temporary chat says it keeps nothing.
  const GREETINGS = {
    morning: ["Good morning. Where should we start?", "Morning. What's first today?", "A fresh page. What's on your mind?"],
    afternoon: ["Good afternoon. What are we figuring out?", "What can we get done this afternoon?", "Afternoon. Bring me a question."],
    evening: ["Good evening. What's on your mind?", "Evening. Let's think something through.", "Winding down, or just getting going?"],
    night: ["Up late? I'm here.", "Quiet hours. What are you thinking about?", "Night owl mode. Ask away."],
  };
  let greeted = { key: null, text: "", node: null };
  function greeting() {
    const key = `${state.conversation?.id || "new"}:${state.conversation?.temporary ? "t" : ""}`;
    if (greeted.key === key) return greeted.text;
    greeted.node = null;
    const hour = new Date().getHours();
    const part = hour >= 5 && hour < 12 ? "morning" : hour >= 12 && hour < 17 ? "afternoon" : hour >= 17 && hour < 22 ? "evening" : "night";
    const lines = state.conversation?.temporary ? ["Off the record. Nothing here is kept."] : GREETINGS[part];
    greeted = { key, text: lines[Math.floor(Math.random() * lines.length)], node: null };
    return greeted.text;
  }
  function welcome() {
    const text = greeting();
    if (greeted.node) return greeted.node;
    const box = el("div", "cd-welcome");
    const ns = "http://www.w3.org/2000/svg";
    const mark = document.createElementNS(ns, "svg");
    mark.setAttribute("viewBox", "0 0 24 24"); mark.setAttribute("class", "cd-welcome-mark"); mark.setAttribute("aria-hidden", "true");
    const bubble = document.createElementNS(ns, "path");
    bubble.setAttribute("class", "cd-welcome-bubble");
    bubble.setAttribute("d", "M5.5 2.5 H18.5 A4 4 0 0 1 22.5 6.5 V13.5 A4 4 0 0 1 18.5 17.5 H11 L6 21.5 V17.5 H5.5 A4 4 0 0 1 1.5 13.5 V6.5 A4 4 0 0 1 5.5 2.5 Z");
    const slashes = document.createElementNS(ns, "g");
    slashes.setAttribute("transform", "translate(6.53 4.53) scale(0.4560)");
    ["M7.63 4.67 L3.44 6.76 L1 21.43 L5.19 19.33 Z", "M15.32 2.57 L11.13 4.67 L8.68 21.43 L12.87 19.33 Z",
     "M23 4.67 L18.81 6.76 L16.37 19.33 L20.56 17.24 Z"].forEach((d, i) => {
      const slash = document.createElementNS(ns, "path");
      slash.setAttribute("d", d); slash.setAttribute("class", `cd-welcome-slash s${i + 1}`);
      slashes.append(slash);
    });
    mark.append(bubble, slashes);
    box.append(mark, el("h2", "", text));
    greeted.node = box;
    return box;
  }

  // ---- the model and its thinking, as main DGC shows them: one pill (the model's name and a small arc for how much it
  // thinks) opening a menu of the models and a dial for thinking. The selects underneath are what a send reads.
  const pill = $("cd-model-pill"), modelMenu = $("cd-model-menu");
  const SVG = "http://www.w3.org/2000/svg";
  const levelOf = (value) => Math.max(0, LEVELS.findIndex(([v]) => v === value));
  const svgEl = (tag, attrs) => { const n = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v)); return n; };
  // The dial: a half circle, Off on the left to Extra high on the right, a mark for each level.
  const DIAL = { cx: 60, cy: 58, r: 42 };
  const angleOf = (level) => -180 + level * 45;
  const at = (angle, r, cx = DIAL.cx, cy = DIAL.cy) => [cx + r * Math.cos(angle * Math.PI / 180), cy + r * Math.sin(angle * Math.PI / 180)];
  const arc = (to, r, cx = DIAL.cx, cy = DIAL.cy) => {
    const [x0, y0] = at(-180, r, cx, cy), [x1, y1] = at(to, r, cx, cy);
    return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  };
  function updatePill() {
    const level = levelOf(thinkingPick.value), name = modelPick.value;
    pill.hidden = modelPick.hidden;
    $("cd-model-name").textContent = name || "Choose a model";
    $("cd-pill-arc-fill").setAttribute("d", level ? arc(angleOf(level), 6, 8, 9) : "");
    pill.dataset.level = LEVELS[level][0];
    pill.title = `${name || "No model"} · thinking: ${LEVELS[level][1]}. Click to change`;
    pill.setAttribute("aria-label", `Model ${name || "not chosen"}, thinking ${LEVELS[level][1]}. Change model and thinking`);
  }
  function setThinking(level) {
    const n = Math.max(0, Math.min(LEVELS.length - 1, level));
    if (levelOf(thinkingPick.value) === n && thinkingPick.value === LEVELS[n][0]) return;
    thinkingPick.value = LEVELS[n][0];
    thinkingPick.dispatchEvent(new Event("change"));
    updatePill();
    showDial();
  }
  function dialNode() {
    const box = el("div", "cd-dial");
    const face = svgEl("svg", { viewBox: "0 0 120 66", class: "cd-dial-face", role: "slider", tabindex: "0", "aria-label": "Thinking",
                                "aria-valuemin": 0, "aria-valuemax": LEVELS.length - 1 });
    face.append(svgEl("path", { class: "cd-dial-track", d: arc(0, DIAL.r) }), svgEl("path", { class: "cd-dial-fill", d: "" }));
    LEVELS.forEach((_, i) => {
      const [x, y] = at(angleOf(i), DIAL.r);
      const mark = svgEl("circle", { class: "cd-dial-mark", cx: x.toFixed(2), cy: y.toFixed(2), r: 2.4, "data-level": i });
      const hit = svgEl("circle", { class: "cd-dial-hit", cx: x.toFixed(2), cy: y.toFixed(2), r: 10, "data-level": i });
      face.append(mark, hit);
    });
    const needle = svgEl("g", { class: "cd-dial-needle" });
    needle.append(svgEl("line", { x1: DIAL.cx, y1: DIAL.cy, x2: DIAL.cx + DIAL.r - 15, y2: DIAL.cy }), svgEl("circle", { cx: DIAL.cx, cy: DIAL.cy, r: 4 }));
    face.append(needle);
    // Click a mark, or drag round the dial: the nearest level. Arrow keys step it, Home and End go to the ends.
    const pick = (e) => {
      const box = face.getBoundingClientRect();
      const x = (e.clientX - box.left) * 120 / box.width, y = (e.clientY - box.top) * 66 / box.height;
      let angle = Math.atan2(y - DIAL.cy, x - DIAL.cx) * 180 / Math.PI;
      if (angle > 0) angle = angle < 90 ? 0 : -180;               // below the dial: the nearer end
      setThinking(Math.round((angle + 180) / 45));
    };
    face.addEventListener("pointerdown", (e) => { face.setPointerCapture?.(e.pointerId); pick(e); });
    face.addEventListener("pointermove", (e) => { if (e.buttons & 1) pick(e); });
    face.addEventListener("keydown", (e) => {
      const n = levelOf(thinkingPick.value);
      const to = { ArrowLeft: n - 1, ArrowDown: n - 1, ArrowRight: n + 1, ArrowUp: n + 1, Home: 0, End: LEVELS.length - 1 }[e.key];
      if (to === undefined) return;
      e.preventDefault(); e.stopPropagation();
      setThinking(to);
    });
    const words = el("div", "cd-dial-words");
    words.append(el("strong", "cd-dial-level", ""), el("span", "cd-dial-desc", ""), el("span", "cd-dial-hint", "Click a mark, drag, or use the arrow keys"));
    box.append(face, words);
    return box;
  }
  function showDial() {
    const box = modelMenu.querySelector(".cd-dial");
    if (!box) return;
    const level = levelOf(thinkingPick.value), face = box.querySelector(".cd-dial-face");
    face.setAttribute("aria-valuenow", level);
    face.setAttribute("aria-valuetext", `${LEVELS[level][1]}: ${LEVELS[level][2]}`);
    face.querySelector(".cd-dial-fill").setAttribute("d", level ? arc(angleOf(level), DIAL.r) : "");
    face.querySelector(".cd-dial-needle").style.transform = `rotate(${angleOf(level)}deg)`;
    for (const mark of face.querySelectorAll(".cd-dial-mark")) {
      mark.classList.toggle("on", Number(mark.dataset.level) <= level && level > 0);
      mark.classList.toggle("now", Number(mark.dataset.level) === level);
    }
    box.querySelector(".cd-dial-level").textContent = LEVELS[level][1];
    box.querySelector(".cd-dial-desc").textContent = LEVELS[level][2];
    box.dataset.level = LEVELS[level][0];
  }
  function renderModelMenu() {
    const rows = [...modelPick.options].map((option) => {
      const on = option.value === modelPick.value;
      const row = el("button", `cd-menu-row${on ? " sel" : ""}`);
      row.type = "button";
      row.setAttribute("role", "menuitemradio"); row.setAttribute("aria-checked", String(on));
      row.append(icon("zap"), el("span", "cd-menu-name", option.value), ...(on ? [icon("check")] : []));
      row.addEventListener("click", () => {
        modelPick.value = option.value;
        modelPick.dispatchEvent(new Event("change"));
        updatePill(); renderModelMenu();
        modelMenu.querySelector(".cd-menu-row.sel")?.focus();
      });
      return row;
    });
    // The models scroll in a list of their own (a provider can list dozens), so the dial is always in view, by the pill.
    const list = el("div", "cd-menu-models");
    list.setAttribute("role", "menu"); list.setAttribute("aria-label", "Model");
    list.append(...rows);
    modelMenu.replaceChildren(el("div", "cd-menu-kicker", "Model"), list, el("div", "cd-menu-sep"), el("div", "cd-menu-kicker", "Thinking"), dialNode());
    showDial();
    list.querySelector(".cd-menu-row.sel")?.scrollIntoView({ block: "nearest" });
  }
  function closeModelMenu(focusPill) {
    if (modelMenu.hidden) return;
    modelMenu.hidden = true;
    pill.setAttribute("aria-expanded", "false");
    if (focusPill) pill.focus();
  }
  pill.addEventListener("click", () => {
    if (!modelMenu.hidden) { closeModelMenu(false); return; }
    renderModelMenu();
    modelMenu.hidden = false;
    pill.setAttribute("aria-expanded", "true");
    (modelMenu.querySelector(".cd-menu-row.sel") || modelMenu.querySelector(".cd-dial-face"))?.focus();
  });
  modelMenu.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeModelMenu(true); } });
  // Where the click was, as it happened: choosing a model draws the menu again, so its row is gone by now.
  document.addEventListener("click", (e) => { if (!e.composedPath().some((n) => n === modelMenu || n === pill)) closeModelMenu(false); });

  // ---- links and copy buttons inside rendered Markdown
  log.addEventListener("click", (e) => {
    const copy = e.target.closest?.(".copy[data-c]");
    if (copy) { vscode.postMessage({ type: "copy", text: decodeURIComponent(copy.dataset.c || "") }); return; }
    const link = e.target.closest?.(".md-link[data-target]");
    if (link) { e.preventDefault(); vscode.postMessage({ type: "openLink", target: link.dataset.target || "" }); }
  });

  // ---- notices
  function showNotice(text, kind = "error") { notice.textContent = text; notice.dataset.kind = kind; notice.hidden = false; }
  function hideNotice() { notice.hidden = true; notice.textContent = ""; }
  const announce = (text) => { $("cd-announce").textContent = text; };

  // ---- what the host says
  window.addEventListener("message", (event) => {
    const msg = event.data || {};
    switch (msg.type) {
      case "voiceReady":
        voiceMode?.receive(msg);
        break;
      case "mic": {
        if (voiceMode?.receive(msg)) break;
        micShow(msg.state, msg.mode === "send" ? "send" : "stop");
        if (msg.error) showNotice(String(msg.error), msg.kind === "info" ? "info" : "error");
        if (typeof msg.text === "string") {
          if (msg.text) {
            dictated(msg.text);
            if (msg.mode === "send") submit();
          } else showNotice("Nothing was heard. Try again, a little closer to the microphone.", "info");
        }
        break;
      }
      case "micLevels":
        if (voiceMode?.receive(msg)) break;
        voice?.push(msg.levels);
        break;
      case "speak":
      case "speakAudio":
        reader?.receive(msg);
        break;
      case "opened": {
        // keep: the same chat shown again (a new version, or another one chosen): what you're typing and the
        // model and thinking you picked stay, and so does where you were reading.
        const keep = msg.keep === true && state.conversation?.id === msg.conversation?.id;
        if (state.conversation?.id !== msg.conversation?.id) { state.picks = {}; removedWidgets.clear(); closeWidgets(false); }
        // A long chat opens on its latest pages: the rest of its prompts and widgets come as its outline.
        state.outline = null; seeking = null;
        if (Number(msg.earlier) > 0 && msg.conversation?.id) vscode.postMessage({ type: "outline" });
        state.conversation = msg.conversation || null;
        state.messages = Array.isArray(msg.messages) ? msg.messages : [];
        state.earlier = Number(msg.earlier) || 0;
        state.busy = msg.busy === true;
        state.replyId = msg.replyId || "";
        state.opened = true;
        state.editing = "";
        state.editingSummary = false;
        if (!keep) { state.compacting = false; state.context = null; meter(); }
        if (!keep) { state.model = ""; state.thinking = ""; studyMode(state.conversation?.study === true); }
        state.unavailable = "";
        if (msg.project && typeof msg.project === "object") upsertProject(msg.project);
        $("cd-title").textContent = state.conversation?.title || "New chat";
        vscode.setState({ ...(vscode.getState() || {}), conversation: state.conversation?.id || "",
                          temporary: !!state.conversation?.temporary });
        if (!keep) {
          restoreDraft();
          // This chat's queue: shown while it answers (it drains when the reply ends); found after a reload with
          // nothing running, it's back in the box rather than sent on its own.
          queueView();
          if (!state.busy && queued().length) restoreQueue();
        }
        hideNotice();
        fillModels();
        if (!keep) pinned = true;
        render();
        if (!keep) input.focus();
        return;
      }
      case "earlier": {
        const older = Array.isArray(msg.messages) ? msg.messages : [];
        const height = scroller.scrollHeight, top = scroller.scrollTop;
        state.messages = [...older, ...state.messages];
        state.earlier = Number(msg.earlier) || 0;
        $("cd-earlier").disabled = false;
        const keep = pinned; pinned = false;
        render();
        scroller.scrollTop = top + (scroller.scrollHeight - height);   // stay on what you were reading
        pinned = keep;
        sought();                                     // a jump to something earlier: there yet, or the next page
        return;
      }
      case "turn":
        if (msg.state === "started") {
          state.busy = true; state.replyId = msg.replyId || ""; state.lastSent = null;
          state.stopping = false; state.failed = false;
          if (!state.messages.some((m) => m.id === state.replyId)) {
            // A continued reply already exists; a new one appears now, empty, and fills in.
          }
        } else {
          state.busy = false; state.replyId = "";      // a later send refused before it starts isn't this turn
          state.searching = {};
          announce("Reply finished.");
          render();
        }
        controls();
        voiceMode?.check(state.busy);
        if (msg.state !== "started") {
          // What waited goes now -- unless you stopped it or it failed: then it's back in the box for you.
          const held = state.stopping || state.failed;
          state.stopping = false; state.failed = false;
          if (held) restoreQueue(); else sendNext();
        }
        return;
      case "activity":
        if (msg.kind === "compacting" && msg.messageId !== state.replyId) {
          state.compacting = true; render(); controls();        // Compact now, or a summary for a new chat
          return;
        }
        if (["searching", "looking", "compacting", "plugin", "making", "canvas", "analyzing"].includes(msg.kind) && msg.messageId) {
          state.searching[msg.messageId] = { kind: msg.kind, text: String(msg.text || "") };
          if (!state.messages.some((m) => m.id === msg.messageId)) state.messages.push({ id: msg.messageId, role: "assistant", text: "", thinking: "" });
          update(msg.messageId);
        }
        return;
      case "message": {
        const message = msg.message;
        if (!message?.id) return;
        delete state.searching[message.id];
        // A picture that couldn't be had while the reply was written is asked for once more now it's kept.
        for (const item of Array.isArray(message.images?.items) ? message.images.items : []) {
          if (images.get(item?.id)?.error) images.delete(item.id);
        }
        const at = state.messages.findIndex((m) => m.id === message.id);
        if (at < 0 && state.earlier > 0 && message.role === "assistant" && earlierThanShown(message)) {
          // A reply on a page not on screen, sent again (a widget of it deleted): not the newest message.
          for (const w of storedWidgets(message)) if (w.removed) removedWidgets.add(w.id);
          widgetsChrome();
          return;
        }
        if (at >= 0) state.messages[at] = message; else state.messages.push(message);
        // A draft edit is saved once the reply comes back with it.
        const saved = Object.keys(state.draftEdit).filter((k) => k.startsWith(`${message.id}\u0000`) && state.draftEdit[k].saving);
        for (const k of saved) delete state.draftEdit[k];
        if (saved.length) announce("Draft saved.");
        if (message.role === "user") { pinned = true; render(); } else update(message.id);
        voiceMode?.check(state.busy);
        return;
      }
      case "research": {
        // Progress names notes (their words come with the finished reply); a run that starts clears the plan's words.
        const r = msg.research && typeof msg.research === "object" ? msg.research : null;
        if (!r || typeof msg.messageId !== "string") return;
        let message = state.messages.find((m) => m.id === msg.messageId);
        if (!message) {
          message = { id: msg.messageId, role: "assistant", text: "", thinking: "" };
          state.messages.push(message);
        }
        const before = message.research?.status;
        if (r.status === "running" && !["running", "writing", "checking"].includes(before)) {
          message.text = ""; delete message.sources; delete message.error; message.finish = undefined;
        }
        message.research = { ...(message.research || {}), ...r };
        if (r.status === "planned" && state.planAsked) {
          state.planAsked = false;                 // the tab that asked counts down; another showing it doesn't
          state.countdowns[message.id] = Date.now() + COUNTDOWN * 1000;
          tick();
        }
        update(message.id);
        return;
      }
      case "question": {
        // Asked mid-reply: the card appears where the reply is now, and the reply goes on below it.
        if (!msg.question || typeof msg.question !== "object") return;
        let message = state.messages.find((m) => m.id === msg.messageId);
        if (!message) {
          message = { id: msg.messageId, role: "assistant", text: "", thinking: "" };
          state.messages.push(message);
        }
        message.questions = [...(Array.isArray(message.questions) ? message.questions : []), msg.question];
        update(message.id);
        return;
      }
      case "outline":
        // Every prompt of the chat on screen, and the widgets its replies made (an older one's is dropped).
        if (msg.conversation && msg.conversation === state.conversation?.id && Array.isArray(msg.prompts)) {
          state.outline = { conversation: msg.conversation, prompts: msg.prompts.slice(0, 5000) };
          widgetsChrome(); railChrome();
        }
        return;
      case "widgetRemoved":
        if (WIDGET_ID.test(String(msg.id || ""))) {
          removedWidgets.add(msg.id); widgetDeleting.delete(msg.id);
          widgetsChrome();
          announce("Widget deleted.");
        }
        return;
      case "widgetShown": {
        const w = msg.widget;
        if (!w || typeof w.html !== "string" || !/^wg_[a-f0-9]{16}$/.test(String(w.id || ""))) return;
        let message = state.messages.find((m) => m.id === msg.messageId);
        if (!message) { message = { id: msg.messageId, role: "assistant", text: "", thinking: "" }; state.messages.push(message); }
        const list = Array.isArray(message.widgets) ? message.widgets.filter((x) => x.id !== w.id) : [];
        message.widgets = [...list, w];
        update(message.id);
        return;
      }
      case "canvas": {
        const card = msg.canvas;
        if (!card || typeof card !== "object" || !/^cv_[a-f0-9]{16}$/.test(String(card.id || ""))) return;
        let message = state.messages.find((m) => m.id === msg.messageId);
        if (!message) {
          message = { id: msg.messageId, role: "assistant", text: "", thinking: "" };
          state.messages.push(message);
        }
        const cards = Array.isArray(message.canvases) ? [...message.canvases] : [];
        const at = cards.findIndex((c) => c.id === card.id);
        if (at >= 0) cards[at] = { ...card, op: cards[at].op === "created" ? "created" : card.op }; else cards.push(card);
        message.canvases = cards;
        if (state.searching[message.id]?.kind === "canvas") delete state.searching[message.id];
        update(message.id);
        return;
      }
      case "sendFromEditor": {
        // Asked from a canvas (Ask ChatDGC, a shortcut): sent as if typed here, with this tab's model and thinking.
        if (typeof msg.text !== "string" || !msg.text.trim()) return;
        if (state.busy || !state.conversation || state.unavailable) { showNotice("Let the reply finish first, then ask again.", "info"); return; }
        const picked = msg.canvasSelection && typeof msg.canvasSelection === "object" ? msg.canvasSelection : null;
        vscode.postMessage({ type: "send", text: msg.text, model: modelPick.value || "", thinking: thinkingPick.value || "", search: searchMode(),
                             study: !!state.study, ...(picked ? { canvas_selection: picked } : {}) });
        state.lastSent = { text: msg.text, research: false, pending: [] };
        state.busy = true;
        hideNotice();
        controls();
        return;
      }
      case "made": {
        const file = msg.file;
        if (!file || typeof file !== "object" || !/^att_[a-f0-9]{32}$/.test(String(file.id || ""))) return;
        let message = state.messages.find((m) => m.id === msg.messageId);
        if (!message) {
          message = { id: msg.messageId, role: "assistant", text: "", thinking: "" };
          state.messages.push(message);
        }
        const files = Array.isArray(message.files) ? [...message.files] : [];
        const at = files.findIndex((f) => f.id === file.id);
        if (at >= 0) files[at] = file; else files.push(file);
        message.files = files;
        if (state.searching[message.id]?.kind === "making") delete state.searching[message.id];
        update(message.id);
        announce(`Made ${file.name || "a file"}.`);
        return;
      }
      case "action": {
        const card = msg.action;
        if (!card || typeof card !== "object" || !/^act_[a-f0-9]{32}$/.test(String(card.id || ""))) return;
        let message = state.messages.find((m) => m.id === msg.messageId);
        if (!message) {
          message = { id: msg.messageId, role: "assistant", text: "", thinking: "" };
          state.messages.push(message);
        }
        const cards = Array.isArray(message.actions) ? [...message.actions] : [];
        const at = cards.findIndex((c) => c.id === card.id);
        if (at >= 0) cards[at] = card; else cards.push(card);
        message.actions = cards;
        delete state.cardBusy[card.id];
        if (card.status !== "waiting") delete state.cardEdit[card.id];
        update(message.id);
        if (card.status === "done") announce(`Sent: ${card.tool} in ${card.plugin_name}.`);
        return;
      }
      case "followups": {
        const message = state.messages.find((m) => m.id === msg.messageId);
        if (!message || !Array.isArray(msg.followups)) return;
        message.followups = msg.followups.filter((f) => typeof f === "string").slice(0, 3);
        update(message.id);
        return;
      }
      case "actionIdle":
        delete state.cardBusy[String(msg.actionId || "")];
        for (const m of state.messages) if ((m.actions || []).some((c) => c.id === msg.actionId)) update(m.id);
        return;
      case "images": {
        // Pictures for the reply, kept while it streams: they show above it.
        if (!msg.images || typeof msg.images !== "object" || !Array.isArray(msg.images.items)) return;
        let message = state.messages.find((m) => m.id === msg.messageId);
        if (!message) {
          message = { id: msg.messageId, role: "assistant", text: "", thinking: "" };
          state.messages.push(message);
        }
        message.images = msg.images;
        update(message.id);
        return;
      }
      case "delta": {
        let message = state.messages.find((m) => m.id === msg.messageId);
        if (!message) {
          message = { id: msg.messageId, role: "assistant", text: "", thinking: "" };
          state.messages.push(message);
        }
        if (message.finish && message.finish !== "stop") message.finish = undefined;   // continuing it
        if (msg.text) delete state.searching[message.id];           // it is writing again
        message.text = (message.text || "") + (msg.text || "");
        message.thinking = (message.thinking || "") + (msg.thinking || "");
        update(message.id);
        return;
      }
      case "changed":
        if (msg.summary && state.conversation) {
          state.conversation = { ...state.conversation, ...msg.summary };
          $("cd-title").textContent = state.conversation.title || "New chat";
          if (state.messages.length) crumb(); else render();      // moved: its page, or no longer one
          controls();
        }
        return;
      case "projects":
        // Every change to any project (and how many chats each holds): the header, the page and its list follow.
        state.projects = Array.isArray(msg.projects) ? msg.projects : [];
        state.projectChats = null; state.projectChatsAsked = "";
        if ($("cd-project-panel") && !projectOf(state.conversation)) $("cd-project-panel").remove();
        if (isProjectPage() || (!state.messages.length && state.conversation?.project)) render(); else crumb();
        return;
      case "projectChats":
        state.projectChats = { project: String(msg.project || ""), items: Array.isArray(msg.items) ? msg.items : [] };
        if (isProjectPage()) render();
        return;
      case "projectSaved": {
        const panel = $("cd-project-panel");
        if (panel?.dataset.saving) panel.remove();
        if (msg.project && typeof msg.project === "object") { upsertProject(msg.project); if (isProjectPage()) render(); else crumb(); }
        return;
      }
      case "error": {
        if (widgetDeleting.size) { widgetDeleting.clear(); widgetsChrome(); }     // a delete refused: its row comes back
        if (seeking) { seeking = null; $("cd-earlier").disabled = false; }
        const summarizing = state.compacting;      // Compact now failed: what you queued meanwhile comes back
        if (state.compacting) { state.compacting = false; render(); }
        if (Object.keys(state.cardBusy).length) {        // a card's choice that was refused: its buttons come back
          const busy = Object.keys(state.cardBusy); state.cardBusy = {};
          for (const m of state.messages) if ((m.actions || []).some((c) => busy.includes(c.id))) update(m.id);
        }
        for (const [k, edit] of Object.entries(state.draftEdit)) {      // a draft's save refused: back to editing it
          if (edit.saving) { edit.saving = false; update(k.split("\u0000")[0]); }
        }
        { const panel = $("cd-project-panel");       // a save that was refused: the panel stays, to fix and save again
          if (panel?.dataset.saving) { delete panel.dataset.saving; const save = panel.querySelector('button[type="submit"]'); if (save) save.disabled = false; } }
        if (msg.opening && /doesn't exist/i.test(msg.message || "")) {
          vscode.postMessage({ type: "reopenNew" });             // gone (a temporary chat after a restart)
          return;
        }
        // A send refused before it started (no model, a window too small for research): not running, and what
        // was typed comes back to the box rather than being lost.
        if (state.busy && !state.replyId && state.lastSent && !input.value.trim()) {
          const sent = state.lastSent;
          edit(() => { input.value = sent.text; state.pending = sent.pending; });
          grow(); saveDraft(); chips();
          researchMode(state.lastSent.research);
        }
        if (state.busy && !state.replyId) state.planAsked = false;
        if (state.busy && state.replyId) state.failed = true;  // its turn ends next: what's queued waits for you
        const refused = state.busy && !state.replyId;
        state.lastSent = null;
        state.busy = state.busy && !!state.replyId;           // a send that never started isn't running
        showNotice(msg.message || "ChatDGC hit an error.");
        controls();
        if (refused || summarizing) restoreQueue();           // a queued send refused: the rest come back too
        return;
      }
      case "lost":
        if (state.busy) { state.busy = false; showNotice(msg.message || "The reply stopped."); render(); }
        state.stopping = false; state.failed = false;
        restoreQueue();
        controls();
        return;
      case "unavailable":
        state.unavailable = msg.message || "ChatDGC isn't available.";
        showNotice(state.unavailable, "info");
        controls();
        return;
      case "models":
        state.models = Array.isArray(msg.ids) ? msg.ids.filter((id) => typeof id === "string").slice(0, 500) : [];
        state.defaultModel = typeof msg.current === "string" ? msg.current : "";
        fillModels();
        return;
      case "breakdown":
        // What fills the window, for the chat on screen (one asked for before a switch is dropped).
        if (msg.conversation && msg.conversation === state.conversation?.id && msg.breakdown && typeof msg.breakdown === "object") {
          state.breakdown = { conversation: msg.conversation, of: msg.breakdown };
          if (!$("cd-context-pop").hidden) popover();
        }
        return;
      case "windows":
        // The window sizes its backend takes (none from an older one: the details then point to Settings).
        state.windows = Array.isArray(msg.presets) ? msg.presets.filter((p) => typeof p === "string") : [];
        if (!$("cd-context-pop").hidden) popover();
        return;
      case "pluginLogos":
        for (const [id, src] of Object.entries(msg.logos && typeof msg.logos === "object" ? msg.logos : {})) {
          if (!PLUGIN_ID.test(id) || typeof src !== "string" || (src && !/^data:image\/(png|svg\+xml|x-icon);base64,/.test(src))) continue;
          pluginLogos.set(id, src);
          if (src) for (const mark of document.querySelectorAll(`.cd-plugin-mark[data-plugin-mark="${id}"]`)) mark.replaceChildren(logoImage(src));
        }
        return;
      case "favicons":
        favicons = msg.on === true;
        render();
        return;
      case "copied":
        announce("Copied.");
        return;
      case "context":
        state.context = { window: Number(msg.window) || 0, limit: Number(msg.limit) || 0, used: Number(msg.used) || 0,
                          preset: String(msg.preset || ""), source: msg.source === "reported" ? "reported" : "estimated",
                          parts: msg.parts && typeof msg.parts === "object" ? msg.parts : {}, compactable: msg.compactable === true };
        meter();
        return;
      case "compacted":
        state.compacting = false;
        if (state.conversation) state.conversation = { ...state.conversation, summary: msg.summary || null };
        { const keep = pinned; pinned = false; render(); pinned = keep; }
        controls();
        announce("Earlier messages summarized.");
        sendNext();                                   // what you sent while it summarized goes now
        return;
      case "image": {
        if (!/^att_[a-f0-9]{32}$/.test(String(msg.id || ""))) return;
        const ok = typeof msg.data === "string" && /^data:image\/(png|jpeg|gif|webp);base64,/.test(msg.data);
        images.set(msg.id, ok ? { data: msg.data } : { error: String(msg.error || "") });
        for (const picture of document.querySelectorAll(`img[data-att="${CSS.escape(msg.id)}"]`)) {
          if (ok) picture.src = msg.data;
          else if (picture.closest(".cd-picture-item")) {
            // Gone from the strip, and the strip says so: the next redraw keeps it rather than drawing it again.
            const strip = picture.closest(".cd-pictures");
            picture.closest(".cd-picture-item").remove();
            const left = [...strip.querySelectorAll("img[data-att]")].map((i) => i.dataset.att);
            strip.dataset.key = left.join(","); strip.dataset.count = String(left.length);
            if (!left.length) strip.remove();
          }
          else if (picture.closest(".cd-lightbox-frame")) picture.replaceWith(el("p", "cd-thumb-missing", "This picture is no longer there."));
          else picture.closest(".cd-thumb")?.replaceChildren(el("span", "cd-thumb-missing", picture.alt || "Image"));
        }
        while (images.size > 200) images.delete(images.keys().next().value);
        return;
      }
      case "attached":
        for (const item of Array.isArray(msg.items) ? msg.items : []) {
          if (state.pending.length >= 10) { showNotice("Attach up to 10 things to one message.", "info"); break; }
          const same = (p) => (p.path && p.path === item.path) || (item.kind === "library" && p.attachment_id === item.attachment_id);
          if (!state.pending.some(same)) state.pending.push(item);
        }
        chips(); controls(); input.focus();
        return;
    }
  });

  // ---- a draft survives a reload, per chat
  function draftKey() { return `draft:${state.conversation?.id || "new"}`; }
  function saveDraft() { try { vscode.setState({ ...(vscode.getState() || {}), [draftKey()]: input.value.slice(0, 100000) }); } catch {} }
  // Another chat's draft starts another history: Cmd+Z in it must not bring back the chat that was left.
  function restoreDraft() { const saved = (vscode.getState() || {})[draftKey()]; input.value = typeof saved === "string" ? saved : ""; history?.reset(); grow(); }

  // ---- keyboard shortcuts (ChatGPT's): Ctrl on Windows and Linux, Cmd on a Mac
  const MAC = /Mac/i.test(navigator.platform || navigator.userAgent || "");
  const MOD = MAC ? "⌘" : "Ctrl";
  const SHORTCUTS = [
    [[MOD, "Shift", "O"], "New chat"],
    [[MOD, "Shift", "C"], "Copy the last reply"],
    [[MOD, "Shift", ";"], "Copy the last code block"],
    [["Shift", "Esc"], "Focus the message box"],
    [["Esc"], "Stop the reply"],
    [["Alt", "↑"], "The prompt before"],
    [["Alt", "↓"], "The next prompt"],
    [[MOD, "/"], "Show these shortcuts"],
  ];
  const keysDialog = $("cd-keys");
  $("cd-keys-list").replaceChildren(...SHORTCUTS.flatMap(([keys, what]) => {
    const term = el("dt");
    keys.forEach((k, i) => { if (i) term.append(" "); term.append(el("kbd", "", k)); });
    return [term, el("dd", "", what)];
  }));
  const toggleKeys = () => { if (keysDialog.open) keysDialog.close(); else keysDialog.showModal(); };
  $("cd-keys-open").addEventListener("click", toggleKeys);
  $("cd-keys-close").addEventListener("click", () => keysDialog.close());
  const lastReply = () => [...state.messages].reverse().find((m) => m.role === "assistant" && m.text);
  document.addEventListener("keydown", (e) => {
    const mod = MAC ? e.metaKey : e.ctrlKey;
    let handled = true;
    if (mod && e.shiftKey && e.code === "KeyO") vscode.postMessage({ type: "newChat" });
    else if (mod && e.shiftKey && e.code === "KeyC") {
      const reply = lastReply();
      if (reply) copyReply(reply);
    } else if (mod && e.shiftKey && e.code === "Semicolon") {
      const blocks = [...log.querySelectorAll(".cd-assistant pre.code .copy[data-c]")];
      const last = blocks[blocks.length - 1];
      if (last) vscode.postMessage({ type: "copy", text: decodeURIComponent(last.dataset.c || "") });
    } else if (e.shiftKey && e.key === "Escape") input.focus();
    else if (mod && !e.shiftKey && (e.code === "Slash" || e.key === "/")) toggleKeys();
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  controls();
  vscode.postMessage({ type: "ready" });
})();
