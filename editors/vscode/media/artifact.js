// An artifact's panel (src/artifacts.ts hosts it): its header (title, type, version, Versions, Download, Open in browser)
// and, by type, what edits or shows it. A deck, a sheet, a checklist and a design have editors of their own
// (artifactSlides.js, artifactSheet.js, artifactChecklist.js, artifactDesign.js); a dashboard shows DGC's page of it with its sources to allow; a page is framed at its own address.
// Everything a model or a person wrote is put in as text, never as markup. DGC's own page of an artifact is shown in a
// frame with no script and an origin of its own (srcdoc + sandbox).
(() => {
  "use strict";
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const icon = (name, cls = "") => { const g = el("span", `codicon codicon-${name}${cls ? " " + cls : ""}`); g.setAttribute("aria-hidden", "true"); return g; };
  const TYPE_ICON = { doc: "file-text", slides: "preview", sheet: "table", dashboard: "dashboard", page: "browser", checklist: "checklist", design: "symbol-color" };
  const TYPE_LABEL = { doc: "Document", slides: "Slides", sheet: "Spreadsheet", dashboard: "Dashboard", page: "Page", checklist: "Checklist", design: "Design" };
  const FORMATS = { docx: "Word document (.docx)", pdf: "PDF", md: "Markdown (.md)", pptx: "PowerPoint (.pptx)", html: "Web page (.html)",
                    xlsx: "Excel workbook (.xlsx)", csv: "CSV (first sheet)", zip: "Zip of its files (.zip)", png: "Picture (.png)" };
  const SURFACE = { chat: "Chat", work: "Work", pip: "a Pip", sdk: "an app", cli: "the terminal", editor: "the editor" };
  const state = { id: "", view: null, content: null, contentVersion: null, dstate: null, offer: null, editor: null, removed: false, conflict: false };

  function when(stamp) {
    const at = Date.parse(String(stamp || ""));
    if (!Number.isFinite(at)) return "";
    const d = new Date(at), now = new Date();
    const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    if (d.toDateString() === now.toDateString()) return time;
    const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return `yesterday ${time}`;
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" }) + ` ${time}`;
  }
  const author = (a) => (String(a || "").toLowerCase() === "you" ? "You" : String(a || "DGC"));
  function announce(text) { const n = $("art-announce"); n.textContent = ""; setTimeout(() => { n.textContent = text; }, 30); }

  // ---- the theme: DGC's pages take data-theme, so they follow VS Code's theme rather than the system's
  function dark() {
    const c = document.body.classList;
    return !(c.contains("vscode-light") || c.contains("vscode-high-contrast-light"));
  }
  /** DGC's page of the artifact, in a frame with no script and an origin of its own. */
  function frameHtml(frame, html) {
    const theme = dark() ? "dark" : "light";
    const themed = String(html).replace(/<html\b([^>]*)>/i, (m, attrs) => `<html${attrs.replace(/\sdata-theme="[^"]*"/, "")} data-theme="${theme}">`);
    frame.dataset.html = "1";
    frame._source = html;
    frame.srcdoc = themed;
  }
  function copyHtml(html) {
    const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
    doc.querySelectorAll("script,style,noscript,template,svg").forEach((node) => node.remove());
    doc.querySelectorAll("br").forEach((node) => node.replaceWith(doc.createTextNode("\n")));
    doc.querySelectorAll("p,div,section,article,header,footer,li,tr,h1,h2,h3,h4,h5,h6").forEach((node) => node.append(doc.createTextNode("\n")));
    const text = String(doc.body?.textContent || "").replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n").trim().slice(0, 200000);
    if (!text) { announce("There is no text to copy in this view."); return; }
    vscode.postMessage({ type: "copyText", text });
  }
  function viewFrame(title) {
    const frame = el("iframe", "art-frame");
    frame.setAttribute("sandbox", "");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.title = title;
    frame.style.colorScheme = dark() ? "dark" : "light";
    return frame;
  }
  new MutationObserver(() => {
    for (const frame of document.querySelectorAll("iframe.art-frame[data-html]")) {
      frame.style.colorScheme = dark() ? "dark" : "light";
      if (frame._source) frameHtml(frame, frame._source);
    }
    for (const frame of document.querySelectorAll("iframe.art-page")) frame.style.colorScheme = dark() ? "dark" : "light";
  }).observe(document.body, { attributes: true, attributeFilter: ["class"] });

  // ---- menus: a list of choices under a button, keyboard and all
  let openMenu = null;
  function closeMenu(focus) {
    if (!openMenu) return;
    const { menu, button } = openMenu;
    menu.hidden = true; button.setAttribute("aria-expanded", "false");
    openMenu = null;
    if (focus) button.focus();
  }
  function showMenu(button, menu, items) {
    if (openMenu && openMenu.menu === menu) { closeMenu(true); return; }
    closeMenu(false);
    menu.replaceChildren(...items.map(([label, run]) => {
      const item = el("button", "art-menu-item", label);
      item.type = "button"; item.setAttribute("role", "menuitem");
      item.addEventListener("click", () => { closeMenu(true); run(); });
      return item;
    }));
    menu.hidden = false; button.setAttribute("aria-expanded", "true");
    openMenu = { menu, button };
    menu.querySelector("button")?.focus();
  }
  document.addEventListener("keydown", (e) => {
    if (!openMenu) return;
    const items = [...openMenu.menu.querySelectorAll("button")];
    const at = items.indexOf(document.activeElement);
    if (e.key === "Escape") { e.preventDefault(); closeMenu(true); }
    else if (e.key === "ArrowDown") { e.preventDefault(); items[(at + 1) % items.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); items[(at - 1 + items.length) % items.length]?.focus(); }
    else if (e.key === "Home") { e.preventDefault(); items[0]?.focus(); }
    else if (e.key === "End") { e.preventDefault(); items.at(-1)?.focus(); }
    else if (e.key === "Tab") closeMenu(false);
  }, true);
  document.addEventListener("click", (e) => {
    if (openMenu && !openMenu.menu.contains(e.target) && !openMenu.button.contains(e.target)) closeMenu(false);
  });
  /** The artifact's own formats, as the process says (a card, the Library and here say the same). */
  function formats() {
    const view = state.view;
    if (!view) return [];
    return view.exports?.length ? view.exports : state.offer?.exports?.[view.type] || [];
  }
  // Download: the host makes the file and hands it to this page, which saves it on the person's computer
  // (media/shared/download.js), "Downloaded" beside the button it was asked from.
  function exportItems(version, from = $("art-export")) {
    // (A design names its own: one artboard, or the whole canvas.)
    if (!version && state.editor?.exportItems) return state.editor.exportItems(from);
    if (state.view?.type === "design") {
      const words = { zip: "Every artboard as pictures (.zip)", pdf: "PDF, an artboard a page", html: "The canvas as a web page (.html)" };
      return formats().map((f) => [words[f] || f.toUpperCase(), () => { window.DgcDownload?.ask(from); vscode.postMessage({ type: "export", format: f, version }); }]);
    }
    return formats().map((f) => [FORMATS[f] || f.toUpperCase(), () => { window.DgcDownload?.ask(from); vscode.postMessage({ type: "export", format: f, ...(version ? { version } : {}) }); }]);
  }

  // ---- the header
  function header() {
    const view = state.view;
    const mark = $("art-mark");
    mark.replaceChildren(icon(TYPE_ICON[view.type] || "file"));
    mark.dataset.type = view.type;
    $("art-title").textContent = view.title;
    document.title = view.title;
    const origin = view.origin || {};
    const made = SURFACE[origin.surface] ? `made in ${SURFACE[origin.surface]}` : "";
    const latest = (view.versions || []).at(-1);
    const changed = latest && latest.n === view.version && latest.n > 1 ? `changed ${when(latest.at)} by ${author(latest.author).replace(/^You$/, "you")}` : "";
    $("art-meta").replaceChildren(...[TYPE_LABEL[view.type] || view.label, `version ${view.version}`, changed || made]
      .filter(Boolean).flatMap((part, i) => (i ? [el("span", "art-dot", "·"), el("span", "", part)] : [el("span", "", part)])));
    $("art-versions").disabled = state.removed || !(view.versions || []).length;
    $("art-export").disabled = state.removed || !formats().length;
    $("art-browser").disabled = state.removed;
    if (!$("art-versions-panel").hidden) versionsList();
  }
  $("art-export").addEventListener("click", (e) => { e.stopPropagation(); showMenu($("art-export"), $("art-export-menu"), exportItems()); });
  $("art-browser").addEventListener("click", () => vscode.postMessage({ type: "browser" }));
  $("art-versions").addEventListener("click", () => {
    const panel = $("art-versions-panel");
    if (!panel.hidden) { closeVersions(); return; }
    panel.hidden = false; $("art-versions").setAttribute("aria-expanded", "true");
    versionsList();
    panel.querySelector("button")?.focus();
  });
  function closeVersions() {
    $("art-versions-panel").hidden = true; $("art-versions").setAttribute("aria-expanded", "false");
    $("art-versions").focus();
  }
  $("art-versions-close").addEventListener("click", closeVersions);
  $("art-versions-panel").addEventListener("keydown", (e) => { if (e.key === "Escape" && !openMenu) { e.preventDefault(); closeVersions(); } });
  function versionsList() {
    const view = state.view;
    const list = $("art-version-list");
    list.replaceChildren(...[...(view.versions || [])].reverse().map((v) => {
      const row = el("li", "art-version");
      row.dataset.version = String(v.n);
      const words = el("div", "art-version-words");
      const top = el("div", "art-version-top");
      top.append(el("strong", "", `Version ${v.n}`));
      if (v.n === view.version) top.append(el("span", "art-now", "Now"));
      words.append(top, el("span", "art-version-meta", [author(v.author), when(v.at)].filter(Boolean).join(" · ")));
      if (v.summary) words.append(el("span", "art-version-summary", v.summary));
      const actions = el("div", "art-version-actions");
      if (v.n !== view.version) {
        if (state.offer?.compare) {
          const compare = el("button", "art-btn art-btn-quiet", "Compare");
          compare.type = "button";
          compare.setAttribute("aria-label", `Compare version ${v.n} with version ${view.version}`);
          compare.addEventListener("click", () => {
            vscode.postMessage({ type: "compare", version: v.n });
            announce(`Comparing version ${v.n} with version ${view.version}…`);
          });
          actions.append(compare);
        }
        const restore = el("button", "art-btn art-btn-quiet", "Restore");
        restore.type = "button";
        restore.title = `Make version ${v.n} the current one again (a new version: nothing is lost)`;
        restore.addEventListener("click", () => {
          if (state.editor?.dirty?.() && !confirmInPage(`Restoring version ${v.n} replaces your unsaved changes here.`, "Restore", () => restoreTo(v.n))) return;
          restoreTo(v.n);
        });
        actions.append(restore);
      }
      if (formats().length) {
        const wrap = el("div", "art-menu-wrap");
        const button = el("button", "art-btn art-btn-quiet");
        button.type = "button"; button.setAttribute("aria-haspopup", "menu"); button.setAttribute("aria-expanded", "false");
        button.append(el("span", "", "Download"), icon("chevron-down", "art-caret"));
        button.setAttribute("aria-label", `Download version ${v.n}`);
        const menu = el("div", "art-menu dgc-popover"); menu.setAttribute("role", "menu"); menu.hidden = true;
        button.addEventListener("click", (e) => { e.stopPropagation(); showMenu(button, menu, exportItems(v.n === view.version ? 0 : v.n, button)); });
        wrap.append(button, menu);
        actions.append(wrap);
      }
      row.append(words, actions);
      return row;
    }));
  }
  function restoreTo(n) {
    vscode.postMessage({ type: "restore", version: n });
    announce(`Restoring version ${n}…`);
  }
  function showComparison(data) {
    if (!data || data.id !== state.id) return;
    document.getElementById("art-compare")?.remove();
    const dialog = el("dialog", "art-compare dgc-dialog"); dialog.id = "art-compare";
    dialog.setAttribute("aria-labelledby", "art-compare-title");
    const title = el("h2", "", `Version ${data.before} → ${data.after}`); title.id = "art-compare-title";
    const close = el("button", "art-btn", "Close comparison"); close.type = "button";
    close.addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", () => { dialog.remove(); $("art-versions").focus(); });
    dialog.append(title, el("p", "", data.truncated
      ? "Partial comparison. Large values or extra changes were shortened; export the versions for their full content."
      : data.total ? `${data.total} changed ${data.total === 1 ? "item" : "items"}. Saved versions are unchanged.` : "No content changes."));
    if (typeof data.diff === "string" && data.diff) dialog.append(el("pre", "art-compare-diff", data.diff));
    for (const change of (Array.isArray(data.changes) ? data.changes : []).slice(0, 200)) {
      const section = el("section", "art-compare-change");
      section.append(el("h3", "", String(change.label || "Change")),
        el("small", "", `Version ${data.before}`), el("pre", "", String(change.before ?? "")),
        el("small", "", `Version ${data.after}`), el("pre", "", String(change.after ?? "")));
      dialog.append(section);
    }
    dialog.append(close); document.body.append(dialog); dialog.showModal(); close.focus();
  }
  /** A question in the page itself (a modal from the host would be heavy for this): returns false and asks. */
  function confirmInPage(text, yes, then) {
    banner("warn", text, [[yes, () => { hideBanner(); then(); }, true], ["Cancel", hideBanner]]);
    return false;
  }

  // ---- the banner: a conflict, a refusal, a removal
  function banner(kind, text, actions = []) {
    const box = $("art-banner");
    box.dataset.kind = kind;
    const words = el("span", "art-banner-text", text);
    box.replaceChildren(icon(kind === "error" ? "error" : kind === "info" ? "info" : "warning"), words);
    if (actions.length) {
      const row = el("span", "art-banner-actions");
      for (const [label, run, primary] of actions) {
        const b = el("button", `art-btn${primary ? " art-btn-primary" : ""}`, label);
        b.type = "button"; b.addEventListener("click", run);
        row.append(b);
      }
      box.append(row);
    }
    box.hidden = false;
  }
  function hideBanner() { $("art-banner").hidden = true; state.conflict = false; }
  // A banner that only says something (a refusal, a removal) can be closed; one that asks (Reload, Keep editing) is answered.
  window.DgcDismiss?.watch({ lines: [{ sel: "#art-banner", when: (box) => !box.querySelector(".art-banner-actions") }] });
  function conflict(version) {
    state.conflict = true;
    banner("warn", `This changed somewhere else${version ? ` (now version ${version})` : ""} since you opened it, so your changes weren't saved. `
      + "Reload to see that version. Reloading drops your unsaved changes here.",
      [["Reload", () => { hideBanner(); vscode.postMessage({ type: "reload" }); }, true], ["Keep editing", hideBanner]]);
  }

  // ---- comments: offered by the process (offer.comments), drawn by media/shared/comments.js in the rail beside the
  // artifact (under it in a narrow panel); each editor says what is picked (util.offerComment) and shows where a thread
  // points (its reveal). The rail shows when there are threads, until the Comments button hides it.
  let comments = null, railChoice = null, railCount = { open: 0, all: 0 };
  const HINT = { sheet: "Pick cells to comment on them, or comment on the whole sheet.", slides: "Pick words in a slide, or use Comment on this slide.",
                 checklist: "Comment on an item with its comment button, or pick words in it.", page: "Pick words on the page to comment on them.",
                 dashboard: "Comment on the whole dashboard.", doc: "Pick words to comment on them.",
                 design: "Select an artboard, or open it and pick a part, then comment on it." };
  function startComments() {
    if (comments || !state.offer?.comments || !window.DgcComments || !state.view) return;
    const kind = (TYPE_LABEL[state.view.type] || "artifact").toLowerCase();
    comments = window.DgcComments.make({ rail: $("art-comments"), kind, hint: HINT[state.view.type], post: (m) => vscode.postMessage(m),
      reveal: (anchor, thread) => state.editor?.reveal?.(anchor, thread), current: () => state.editor?.commentAnchor?.(),
      changed: (n) => { railCount = n; paintRail(); } });
    $("art-comments-btn").hidden = false;
    vscode.postMessage({ type: "comments", op: "list" });
  }
  function paintRail() {
    const show = !!comments && (railChoice ?? railCount.all > 0);
    $("art-comments").hidden = !show;
    document.body.dataset.rail = show ? (window.matchMedia?.("(min-width: 960px)").matches ? "side" : "under") : "";
    const btn = $("art-comments-btn");
    btn.setAttribute("aria-pressed", String(show));
    $("art-comments-count").textContent = railCount.open ? String(railCount.open) : "";
    btn.setAttribute("aria-label", `Comments${railCount.open ? `: ${railCount.open} open` : ""}. ${show ? "Hide" : "Show"} them`);
  }
  window.matchMedia?.("(min-width: 960px)").addEventListener?.("change", paintRail);
  $("art-comments-btn").addEventListener("click", () => { railChoice = $("art-comments").hidden; paintRail(); if (railChoice) $("art-comments").querySelector("button")?.focus(); });

  // ---- the bodies
  const util = { el, icon, when, author, announce, banner, hideBanner, conflict, viewFrame, frameHtml, dark,
                 post: (m) => vscode.postMessage(m), showMenu, closeMenu,
                 // Comments (media/shared/comments.js): an editor says what is picked and where (null: nothing), or opens
                 // the box for a comment on one part at once (an item's own Comment button).
                 offerComment: (anchor, rect, how) => comments?.offer(anchor, rect, how), askComment: (anchor, rect) => comments?.compose(anchor, rect),
                 commentsOn: () => !!comments };
  window.DgcArtifact = window.DgcArtifact || { editors: {} };
  window.DgcArtifact.util = util;
  const editors = window.DgcArtifact.editors;

  /** A page: framed at its own address (its own origin, so it can't reach this panel). */
  editors.page = () => {
    let frame, note, origin = "";
    /** The page's frame: Comments on (it then says what is picked), or a thread's place to show. */
    const tell = (message) => { try { if (origin) frame.contentWindow?.postMessage({ type: "dgc-comments", ...message }, origin); } catch { /* not loaded yet */ } };
    return {
      mount(main) {
        const bar = el("div", "art-toolbar");
        const copy = el("button", "art-btn", "Copy text"); copy.type = "button";
        copy.title = "Copy the page's text to your clipboard";
        copy.addEventListener("click", () => vscode.postMessage({ type: "copyPageText" }));
        const reload = el("button", "art-btn", ""); reload.type = "button";
        reload.append(icon("refresh"), el("span", "art-btn-label", "Reload"));
        reload.addEventListener("click", () => vscode.postMessage({ type: "preview" }));
        note = el("span", "art-toolbar-note", "Loading the page…");
        bar.append(note, el("span", "art-spacer"), copy, reload);
        frame = el("iframe", "art-frame art-page");
        // The editor's colour scheme on the frame, as DGC's own frames have it: a page with no colours of its own then
        // gets a browser's white page with dark words (without it Chrome left the page see-through over the dark panel,
        // black words on it), and a page that says it does dark (color-scheme: light dark) follows the editor.
        frame.style.colorScheme = dark() ? "dark" : "light";
        frame.setAttribute("sandbox", "allow-scripts allow-forms allow-same-origin");
        frame.setAttribute("referrerpolicy", "no-referrer");
        frame.title = state.view.title;
        frame.addEventListener("load", () => { if (util.commentsOn()) tell({ on: true }); });
        main.append(bar, frame);
      },
      frame(msg) {
        try { origin = new URL(msg.url).origin; } catch { origin = ""; }
        frame.src = msg.url; note.textContent = `Version ${msg.version || state.view.version}, at its own address`;
      },
      /** What the page's frame said is picked: its place and words, where it is in the frame. */
      picked(data) {
        const a = data && typeof data.anchor === "object" ? data.anchor : null, r = data?.rect, box = frame.getBoundingClientRect();
        if (!a || !r || ![r.left, r.top, r.right, r.bottom].every(Number.isFinite)) { util.offerComment(null); return; }
        const anchor = { kind: "element", quote: String(a.quote || "").slice(0, 2000), path: String(a.path || "").slice(0, 600),
                         near: String(a.near || "").slice(0, 200), tag: String(a.tag || "").slice(0, 20) };
        if (!anchor.quote.trim()) { util.offerComment(null); return; }
        const rect = { left: box.left + r.left, right: box.left + r.right, top: box.top + r.top, bottom: box.top + r.bottom };
        if (rect.bottom < box.top || rect.top > box.bottom) { util.offerComment(null); return; }
        util.offerComment(anchor, rect);
      },
      reveal(anchor) { tell({ reveal: anchor }); },
      render(msg) { if (msg.error) note.textContent = msg.error; },
      update() {},                        // a reload serves it again (artifacts.ts load)
      dirty: () => false,
    };
  };

  /** A document opens in the editor over its file; a panel restored for one says so. */
  editors.doc = () => ({
    mount(main) {
      const box = el("div", "art-empty-box");
      box.append(icon("file-text"), el("p", "", "This document opens in the editor, over its own file. Your saves there are its versions."));
      const open = el("button", "art-btn art-btn-primary", "Open in the editor"); open.type = "button";
      open.addEventListener("click", () => vscode.postMessage({ type: "openDoc" }));
      box.append(open);
      main.append(box);
    },
    update() {}, dirty: () => false,
  });

  /** A dashboard: its sources (what each reads, and whether you allowed it), Refresh, and DGC's page of its numbers. */
  editors.dashboard = () => {
    let frame, sourcesBox, stamp, refreshing = false, refreshBtn, renderedHtml = "";
    // Live: it refreshes by itself every few minutes, or when its files change, only while it shows. The editor keeps
    // the choice per dashboard (it's not a change to the dashboard). A failure keeps the numbers it has, and the next
    // try waits twice as long (at most an hour).
    const EVERY = { "": ["By hand", "By hand", ""], "1m": ["Every minute", "Every minute", "every minute"],
      "5m": ["Every 5 minutes", "Every 5 min", "every 5 min"], "15m": ["Every 15 minutes", "Every 15 min", "every 15 min"],
      "60m": ["Every hour", "Every hour", "every hour"], files: ["When its files change", "When files change", "when its files change"] };
    const MS = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "60m": 3_600_000 };
    let every = Object.hasOwn(EVERY, state.refreshEvery || "") ? state.refreshEvery || "" : "";
    let everyBtn, everyMenu, timer = 0, failures = 0, failedAt = 0, lastRun = Date.now(), dueWhileHidden = false, byItself = false;
    const clock = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    /** The files it reads (a table file, a SQLite database): the editor watches them when it refreshes on their change. */
    function fileSources() {
      return (data().sources || []).filter((s) => (s.kind === "file" || s.kind === "sqlite") && typeof s.path === "string" && s.path).map((s) => s.path).slice(0, 20);
    }
    function waitMs() { const base = MS[every]; return base ? Math.min(3_600_000, base * 2 ** failures) : 0; }
    function plan() {
      clearTimeout(timer); timer = 0;
      const ms = waitMs();
      if (!ms || state.removed) return;
      timer = setTimeout(due, Math.max(500, (failures ? failedAt : lastRun) + ms - Date.now()));
    }
    function due() { timer = 0; if (document.hidden) { dueWhileHidden = true; return; } run(); }
    function run() {
      if (refreshing || state.removed) return;
      byItself = true; refreshing = true; paintStamp(); vscode.postMessage({ type: "refresh" });
    }
    document.addEventListener("visibilitychange", () => { if (!document.hidden && dueWhileHidden) { dueWhileHidden = false; run(); } });
    function paintEvery() {
      if (!everyBtn) return;
      everyBtn.replaceChildren(icon("history"), el("span", "art-btn-label", EVERY[every][1]), icon("chevron-down", "art-caret"));
      everyBtn.setAttribute("aria-label", `Refreshes by itself: ${EVERY[every][0]}`);
      everyBtn.disabled = state.removed;
    }
    function choose(next) {
      every = next; state.refreshEvery = next; failures = 0; lastRun = Date.now();
      paintEvery(); paintStamp(); plan();
      vscode.postMessage({ type: "refreshEvery", every: next, files: fileSources() });
    }
    const local = new Map();              // source id -> allowed, as this panel last set it
    const asking = new Set();
    function data() { return state.content && typeof state.content === "object" ? state.content : { sources: [], widgets: [] }; }
    /** Whether each source is allowed: as the process says (allowed_sources), else as this panel set it, else as the
     *  last refresh found it (a widget over a source that isn't allowed comes back "blocked"). */
    function allowed(id) {
      if (Array.isArray(state.view.allowed_sources)) return state.view.allowed_sources.includes(id);
      if (local.has(id)) return local.get(id);
      const results = state.dstate?.results || {};
      const over = (data().widgets || []).filter((w) => w.source === id).map((w) => results[w.id]).filter(Boolean);
      if (over.some((r) => r.blocked === id)) return false;
      return over.length > 0;
    }
    function reads(s) {
      const what = { file: "Table file", sqlite: "SQLite database", postgres: "The project's read-only database", plugin: "Plugin" }[s.kind] || s.kind;
      const where = s.kind === "plugin" ? s.server : s.kind === "postgres" ? "" : s.path;
      return [what, where].filter(Boolean).join(" · ");
    }
    function renderSources() {
      const d = data();
      const version = state.contentVersion;
      const sources = Array.isArray(d.sources) ? d.sources : [];
      const waiting = sources.filter((s) => !allowed(s.id));
      sourcesBox.replaceChildren();
      const head = el("div", "art-sources-head");
      head.append(el("h2", "", "Sources"),
        el("span", "art-sources-sum", waiting.length ? `${waiting.length} of ${sources.length} not allowed: their widgets stay empty` : `${sources.length} allowed · read-only`));
      sourcesBox.append(head);
      const list = el("ul", "art-source-list");
      for (const s of sources) {
        const ok = allowed(s.id);
        const row = el("li", "art-source");
        row.dataset.source = s.id; row.dataset.allowed = String(ok);
        const kindIcon = { file: "file", sqlite: "database", postgres: "database", plugin: "plug" }[s.kind] || "database";
        row.append(el("span", "art-source-mark"));
        row.firstChild.append(icon(ok ? kindIcon : "lock"));
        const words = el("div", "art-source-words");
        words.append(el("strong", "", s.label || s.id), el("span", "art-source-reads", reads(s)));
        const used = (d.widgets || []).filter((w) => w.source === s.id).length;
        const widgets = `${used} widget${used === 1 ? "" : "s"}`;
        words.append(el("span", "art-source-state", ok ? `Allowed · ${widgets} ${used === 1 ? "reads" : "read"} it` : `Not allowed · ${widgets} ${used === 1 ? "waits" : "wait"} for it`));
        row.append(words);
        const button = el("button", `art-btn ${ok ? "art-btn-quiet" : "art-btn-primary"}`, ok ? "Stop allowing" : "Allow");
        button.type = "button";
        button.disabled = asking.has(s.id) || state.removed;
        button.setAttribute("aria-label", `${ok ? "Stop allowing" : "Allow"} ${s.label || s.id}`);
        button.title = ok ? "Its widgets stop reading it; nothing is deleted" : "Let this dashboard read it (read-only, on this computer, no model)";
        button.addEventListener("click", () => {
          asking.add(s.id); renderSources();
          vscode.postMessage({ type: "allow", source: s.id, allowed: !ok, base_version: version });
        });
        row.append(button);
        list.append(row);
      }
      if (!sources.length) list.append(el("li", "art-source-none", "This dashboard reads no sources."));
      sourcesBox.append(list);
    }
    function refreshedAt() {
      const results = Object.values(state.dstate?.results || {});
      const stamps = results.filter((r) => r && r.refreshed_at && !r.blocked).map((r) => r.refreshed_at).sort();
      return stamps.at(-1) || "";
    }
    function paintStamp() {
      const at = refreshedAt(), live = EVERY[every][2] ? ` · ${EVERY[every][2]}` : "";
      stamp.textContent = refreshing ? "Refreshing…"
        : failures && MS[every] ? `Couldn’t refresh at ${clock(failedAt)} · trying again at ${clock(failedAt + waitMs())}`
        : failures ? `Couldn’t refresh at ${clock(failedAt)}${live}`
        : `${at ? `Refreshed ${when(at)}` : "Not refreshed yet"}${live}`;
      refreshBtn.disabled = refreshing || state.removed;
    }
    return {
      mount(main) {
        const bar = el("div", "art-toolbar");
        const copy = el("button", "art-btn", "Copy text"); copy.type = "button";
        copy.title = "Copy the dashboard's text to your clipboard";
        copy.addEventListener("click", () => copyHtml(renderedHtml));
        refreshBtn = el("button", "art-btn art-btn-primary"); refreshBtn.type = "button";
        refreshBtn.append(icon("refresh"), el("span", "art-btn-label", "Refresh"));
        refreshBtn.title = "Run its queries again now, on this computer, with no model";
        refreshBtn.addEventListener("click", () => { byItself = false; refreshing = true; paintStamp(); vscode.postMessage({ type: "refresh" }); });
        const everyWrap = el("div", "art-menu-wrap");
        everyBtn = el("button", "art-btn"); everyBtn.type = "button"; everyBtn.id = "art-refresh-every";
        everyBtn.setAttribute("aria-haspopup", "menu"); everyBtn.setAttribute("aria-expanded", "false");
        everyBtn.title = "How often it refreshes by itself, while it shows";
        everyMenu = el("div", "art-menu art-menu-left dgc-popover"); everyMenu.id = "art-refresh-menu";
        everyMenu.setAttribute("role", "menu"); everyMenu.setAttribute("aria-label", "Refreshes by itself"); everyMenu.hidden = true;
        everyBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          const keys = Object.keys(EVERY).filter((k) => k !== "files" || fileSources().length);
          showMenu(everyBtn, everyMenu, keys.map((k) => [EVERY[k][0], () => choose(k)]));
        });
        everyWrap.append(everyBtn, everyMenu);
        stamp = el("span", "art-toolbar-note");
        bar.append(refreshBtn, everyWrap, stamp, el("span", "art-spacer"), copy);
        sourcesBox = el("section", "art-sources"); sourcesBox.setAttribute("aria-label", "Sources");
        frame = viewFrame(`${state.view.title}: the dashboard`);
        const wrap = el("div", "art-dash");
        wrap.append(sourcesBox, frame);
        main.append(bar, wrap);
        renderSources(); paintEvery(); paintStamp(); plan();
        // (Watching its files again, for a dashboard opened with that choice.)
        if (every === "files") vscode.postMessage({ type: "refreshEvery", every, files: fileSources() });
      },
      update() { asking.clear(); renderSources(); paintEvery(); paintStamp(); },
      render(msg) {
        if (msg.error) { banner("error", msg.error); return; }
        renderedHtml = msg.html;
        frameHtml(frame, msg.html);
      },
      refreshed(msg) {
        refreshing = false; byItself = false; failures = 0; lastRun = Date.now();
        if (msg.state) state.dstate = msg.state;
        paintStamp(); renderSources(); plan();
      },
      /** The editor saw one of its files change (when it refreshes on that). */
      filesChanged() {
        if (every !== "files") return;
        if (document.hidden) { dueWhileHidden = true; return; }
        run();
      },
      /** A refresh it started by itself: its failure is said on the stamp, not in a banner. */
      quiet: () => byItself,
      allowed(msg) {
        asking.delete(msg.source);
        local.set(msg.source, msg.allowed);
        if (msg.artifact) state.view = msg.artifact;
        renderSources();
        announce(msg.allowed ? `${msg.source} is allowed. Refreshing…` : `${msg.source} is no longer allowed.`);
        // What allowing it is for: its widgets' numbers, now.
        refreshing = true; paintStamp(); vscode.postMessage({ type: "refresh" });
      },
      rejected(msg) {
        if (msg.what === "allow") { asking.delete(msg.source); renderSources(); }
        if (msg.what === "refresh") {
          refreshing = false; byItself = false; failedAt = Date.now();
          if (every) failures = Math.min(failures + 1, 12);
          paintStamp(); plan();
        }
      },
      dirty: () => false,
    };
  };

  function mountBody() {
    const main = $("art-main");
    main.replaceChildren();
    main.dataset.type = state.view.type;
    const make = Object.hasOwn(editors, state.view.type) ? editors[state.view.type] : null;
    state.editor = make ? make() : null;
    if (!state.editor) { main.append(el("p", "art-empty", `DGC can't show a ${state.view.type} here yet.`)); return; }
    state.editor.mount(main, { state, util });
  }

  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") {
      if (state.editor?.save) { e.preventDefault(); state.editor.save(); }
    }
  });

  window.addEventListener("message", (event) => {
    // VS Code relays host messages from another Window with this webview's origin.
    // A Page or dashboard frame has a different origin; it must not drive editor actions.
    // Local previews dispatch source-less messages, which are safe within the test page.
    const pageFrame = document.querySelector("iframe.art-page");
    if (pageFrame && event.source && event.source === pageFrame.contentWindow) {
      // DGC's helper in a framed page says only what is picked there; it never drives anything else.
      const data = event.data;
      if (data && typeof data === "object" && data.type === "dgc-comment-pick" && comments) state.editor?.picked?.(data);
      return;
    }
    if (event.source && event.source !== window && event.origin !== location.origin) return;
    const msg = event.data;
    if (!msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "comparison": showComparison(msg.comparison); return;
      case "comments":
        if (msg.id && msg.id !== state.id) return;
        startComments();
        comments?.set(msg.threads, msg.version);
        return;
      // (Said in the panel's banner, which has the shared Dismiss ×; read aloud by the rail.)
      case "commentsRejected": comments?.rejected(msg.message); banner("error", String(msg.message || "DGC couldn't do that.")); return;
      case "init":
        state.id = String(msg.id || "");
        try { vscode.setState({ ...(vscode.getState() || {}), id: state.id }); } catch {}
        return;
      case "detail": {
        const first = !state.view || state.view.type !== msg.artifact.type;
        const wasRemoved = state.removed;
        state.view = msg.artifact; state.content = msg.content; state.contentVersion = msg.artifact.version;
        state.dstate = msg.state; state.offer = msg.offer || state.offer;
        if (typeof msg.refreshEvery === "string") state.refreshEvery = msg.refreshEvery;
        state.removed = false;
        if (!state.conflict) hideBanner();
        header();
        startComments();                          // (before the body: an editor draws its comment buttons from the start)
        if (first || !state.editor) mountBody(); else state.editor.update?.(true);
        if (wasRemoved) state.editor?.lock?.(false);
        if (wasRemoved) comments?.lock(false);
        return;
      }
      case "changed": {
        if (!state.view) return;
        if (msg.op === "removed") {
          state.removed = true; header();
          banner("info", "This was removed. It's in DGC's trash with every version, where it can be recovered.");
          state.editor?.lock?.(true);
          comments?.lock(true);
          return;
        }
        const was = state.view.version;
        state.view = msg.artifact; header();
        if (msg.artifact.version === was && msg.op === "changed" && state.view.type === "dashboard") {
          state.editor?.update?.(false);          // a source allowed elsewhere: same version
          return;
        }
        if (state.editor?.dirty?.()) {
          banner("warn", `${author((msg.artifact.versions || []).at(-1)?.author)} changed this (now version ${msg.artifact.version}) while you were editing. `
            + "Reload to see it; that drops your unsaved changes here. Or keep editing: saving then says it moved on.",
            [["Reload", () => { hideBanner(); vscode.postMessage({ type: "reload" }); }, true], ["Keep editing", hideBanner]]);
          return;
        }
        vscode.postMessage({ type: "reload" });
        return;
      }
      case "saved":
        state.view = msg.artifact; header(); hideBanner();
        state.editor?.saved?.(msg.artifact);
        announce(`Saved as version ${msg.artifact.version}.`);
        return;
      case "rejected":
        if (msg.what === "load") {
          $("art-title").textContent = "Not found";
          $("art-main").replaceChildren(el("p", "art-empty", `This artifact couldn't be opened: ${msg.message}`));
          return;
        }
        // (A checklist makes your one change again on the newer list by itself, once, before anything is asked.)
        if (msg.what === "save" && msg.reason === "conflict" && state.editor?.retries?.(msg)) return;
        if (msg.what === "save" && msg.reason === "conflict") { conflict(); state.editor?.rejected?.(msg); return; }
        if (msg.what === "refresh" && state.editor?.quiet?.()) { state.editor.rejected?.(msg); return; }
        banner("error", msg.what === "save" ? `Not saved: ${msg.message}` : msg.message);
        state.editor?.rejected?.(msg);
        return;
      case "render": state.editor?.render?.(msg); return;
      case "frame": state.editor?.frame?.(msg); return;
      case "copySource": copyHtml(msg.html); return;
      case "copyFailed": banner("error", msg.message); return;
      case "copied": announce("Text copied to clipboard."); return;
      case "refreshed": state.editor?.refreshed?.(msg); return;
      case "filesChanged": state.editor?.filesChanged?.(); return;
      case "allowed": state.editor?.allowed?.(msg); return;
    }
  });
  vscode.postMessage({ type: "ready" });
})();
