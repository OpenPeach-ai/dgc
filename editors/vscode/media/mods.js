// window.DgcMods: the user's mods (dgc/mods), drawn the same way in the Work chat (main.js) and ChatDGC (chatdgc.js),
// and their list in Settings -> Plugins -> Mods (src/settingsClient.js). It matches what the terminal shows
// (dgc/mods/terminal.py, dgc/tui.py): every mod's status as one short item under its title in one line above the
// prompt box, each band as a thin strip above that under its title, a mod's panel ("From Tally") in a drawer beside
// the chat, its notices in the page's own notice style, its commands in the slash menu (run at once: never a prompt,
// never a steering message mid-turn), what a command answers as a small card under the mod's name, /mods, and the
// one question about the mods DGC writes in a session.
//
// A mod's tree (dgc/mods/ui.py: Box, Row, Column, Text, Markdown, Button, Input, Select, Bar, Table, Sparkline) is
// drawn safely by construction: every piece of its text goes in with textContent, Markdown goes through the
// panel's own renderer (DgcMarkdown: no HTML, links as words), and the tones are the theme's tokens (main.css .mod-*).
//
// DgcMods.create(options) for a chat page:
//   surface      "work" or "chat" (ChatDGC's own mods)
//   post(msg)    send {type: "mods", op: list|watch|set|command|action|offer, ...} to the extension host
//   strip        the element above the prompt box the bands and the status line are drawn in
//   notice(title, text, tone)   show a mod's notice the page's way
//   transcript(node)            put a card in the transcript (a command's answer, the question about written mods)
//   announce(text)              say something to a screen reader
//   changed()                   the commands changed (the page's slash menu reads commands() again)
// and it returns {ready, event, commands, isCommand, run, intercept, openList, openPane, close, menu}.
(function () {
  "use strict";
  if (window.DgcMods) return;
  const TONES = ["muted", "strong", "accent", "ok", "warn", "bad"];
  const SLOTS = ["pane", "band", "status"];
  const ID = /^[A-Za-z0-9_.:-]{1,64}$/;
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  };
  const glyph = (name) => { const g = el("span", `codicon codicon-${name}`); g.setAttribute("aria-hidden", "true"); return g; };
  const str = (value, limit = 2000) => String(value ?? "").slice(0, limit);
  const tone = (node, value) => { if (TONES.includes(value)) node.dataset.tone = value; return node; };
  const num = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return "";
    if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
    if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
    return String(Math.round(n * 100) / 100);
  };
  const kids = (node) => (Array.isArray(node?.children) ? node.children : []);

  // ---- a tree in words: a status item's hover text, a Bar's or a Sparkline's label for a screen reader ----------
  function plain(node, depth = 0) {
    if (!node || typeof node !== "object" || depth > 9) return "";
    switch (node.type) {
      case "Box": return [node.title ? str(node.title, 80) : "", ...kids(node).map((k) => plain(k, depth + 1))].filter(Boolean).join(" ");
      case "Row": case "Column": return kids(node).map((k) => plain(k, depth + 1)).filter(Boolean).join(" ");
      case "Text": case "Markdown": return str(node.text).replace(/\s+/g, " ").trim();
      case "Button": return str(node.label || "OK", 40);
      case "Input": return str(node.value || node.placeholder, 400);
      case "Select": {
        const options = Array.isArray(node.options) ? node.options : [];
        const chosen = options.find((o) => o && o.value === node.value) || options[0];
        return chosen ? str(chosen.label || chosen.value, 80) : "";
      }
      case "Bar": return (Array.isArray(node.segments) ? node.segments : []).map((s) => `${str(s?.label, 40)} ${num(s?.value)}`.trim()).join(", ");
      case "Table": {
        const rows = Array.isArray(node.rows) ? node.rows.length : 0;
        return `${(Array.isArray(node.columns) ? node.columns : []).map((c) => str(c, 40)).join(", ")} (${rows} row${rows === 1 ? "" : "s"})`;
      }
      case "Sparkline": {
        const values = (Array.isArray(node.values) ? node.values : []).filter((v) => Number.isFinite(Number(v))).map(Number);
        const label = node.label ? `${str(node.label, 40)} ` : "";
        return values.length ? `${label}${num(Math.min(...values))} to ${num(Math.max(...values))}, last ${num(values[values.length - 1])}` : label.trim();
      }
      default: return "";
    }
  }

  // ---- drawing a tree -----------------------------------------------------------------------------------------
  // ctx: {act(id, value) for Buttons, Inputs and Selects (absent: they are drawn but do nothing), inline (one line,
  // for the status line), depth}. Anything not an element DGC draws is skipped.
  function draw(node, ctx = {}, depth = 0) {
    if (!node || typeof node !== "object" || depth > 9) return document.createTextNode("");
    const inline = !!ctx.inline;
    const act = typeof ctx.act === "function" ? ctx.act : null;
    const id = typeof node.id === "string" && ID.test(node.id) ? node.id : "";
    switch (node.type) {
      case "Box": {
        const box = el(inline ? "span" : "section", "mod-box");
        if (node.title && !inline) box.append(el("div", "mod-box-title", str(node.title, 80)));
        else if (node.title) box.append(el("span", "mod-box-title", str(node.title, 80)));
        for (const kid of kids(node)) box.append(draw(kid, ctx, depth + 1));
        return tone(box, node.tone);
      }
      case "Row": case "Column": {
        const group = el(inline ? "span" : "div", node.type === "Row" ? "mod-row" : "mod-col");
        for (const kid of kids(node)) group.append(draw(kid, ctx, depth + 1));
        return tone(group, node.tone);
      }
      case "Text": return tone(el("span", "mod-text", str(node.text)), node.tone);
      case "Markdown": {
        if (inline) return tone(el("span", "mod-text", plain(node)), node.tone);
        const box = el("div", "mod-md text");
        const render = window.DgcMarkdown && typeof window.DgcMarkdown.render === "function" ? window.DgcMarkdown.render : null;
        // The panel's own renderer: it writes no HTML of its own from the source (markdown-it, html off), so this is
        // the one way a mod's words become markup. Without it, the words as they are.
        if (render) box.append(wordsOnly(render(str(node.text)))); else box.textContent = str(node.text);
        return tone(box, node.tone);
      }
      case "Button": {
        const button = el("button", "mod-button", str(node.label || "OK", 40));
        button.type = "button";
        if (id) button.dataset.id = id;
        if (act && id && !inline) button.addEventListener("click", () => act(id));
        else button.disabled = true;
        return tone(button, node.tone);
      }
      case "Input": {
        const input = el("input", "mod-input");
        input.type = "text";
        input.value = str(node.value, 400);
        input.placeholder = str(node.placeholder, 80);
        input.setAttribute("aria-label", str(node.placeholder, 80) || "Text for the mod");
        input.maxLength = 400;
        if (id) input.dataset.id = id;
        if (act && id && !inline) {
          // What was typed goes to the mod on Enter, or when the field is left changed.
          let sent = input.value;
          const send = () => { if (input.value !== sent) { sent = input.value; act(id, input.value); } };
          input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); send(); } });
          input.addEventListener("change", send);
        } else input.disabled = true;
        return input;
      }
      case "Select": {
        const select = el("select", "mod-select");
        for (const o of (Array.isArray(node.options) ? node.options : []).slice(0, 30)) {
          if (!o || typeof o !== "object") continue;
          const option = el("option", "", str(o.label || o.value, 80));
          option.value = str(o.value, 80);
          select.append(option);
        }
        if (node.value !== undefined) select.value = str(node.value, 80);
        select.setAttribute("aria-label", "Choice for the mod");
        if (id) select.dataset.id = id;
        if (act && id && !inline) select.addEventListener("change", () => act(id, select.value));
        else select.disabled = true;
        return select;
      }
      case "Bar": {
        const segments = (Array.isArray(node.segments) ? node.segments : []).slice(0, 12)
          .filter((s) => s && Number.isFinite(Number(s.value)) && Number(s.value) >= 0);
        const declared = Number.isFinite(Number(node.total)) && Number(node.total) > 0 ? Number(node.total) : 0;
        const scale = Math.max(declared, ...segments.map((s) => Number(s.value))) || 1;
        const sum = segments.reduce((total, s) => total + Number(s.value) / scale, 0);
        const total = Math.max(sum, declared / scale, Number.MIN_VALUE);
        const wrap = el(inline ? "span" : "div", "mod-bar-wrap");
        const bar = el("span", "mod-bar");
        bar.setAttribute("role", "img");
        bar.setAttribute("aria-label", plain(node) || "A bar");
        let used = 0;
        for (const s of segments) {
          const part = el("span", "mod-bar-part");
          const width = Math.max(0, Math.min(100 - used,
            Math.round(Number(s.value) / scale * 100 / total * 1_000_000) / 1_000_000));
          used += width;
          part.style.width = `${width}%`;
          bar.append(tone(part, s.tone || "accent"));
        }
        wrap.append(bar);
        if (!inline) {
          const legend = el("div", "mod-bar-legend");
          for (const s of segments) {
            if (!s.label) continue;
            const item = el("span", "mod-bar-key");
            item.append(tone(el("span", "mod-bar-dot"), s.tone || "accent"), el("span", "", `${str(s.label, 40)} ${num(s.value)}`));
            legend.append(item);
          }
          if (legend.childNodes.length) wrap.append(legend);
        }
        return wrap;
      }
      case "Table": {
        const columns = (Array.isArray(node.columns) ? node.columns : []).slice(0, 8).map((c) => str(c, 40));
        if (inline) return el("span", "mod-text", plain(node));
        const scroller = el("div", "mod-table-wrap");
        const table = el("table", "mod-table");
        const head = el("thead"), row = el("tr");
        for (const c of columns) { const th = el("th", "", c); th.scope = "col"; row.append(th); }
        head.append(row); table.append(head);
        const body = el("tbody");
        for (const r of (Array.isArray(node.rows) ? node.rows : []).slice(0, 60)) {
          const tr = el("tr");
          columns.forEach((_, i) => {
            const cell = Array.isArray(r) ? r[i] : "";
            const numeric = typeof cell === "number" && Number.isFinite(cell);
            const td = el("td", numeric ? "mod-num" : "", numeric ? num(cell) : str(cell, 80));
            tr.append(td);
          });
          body.append(tr);
        }
        table.append(body);
        scroller.append(table);
        return tone(scroller, node.tone);
      }
      case "Sparkline": {
        const values = (Array.isArray(node.values) ? node.values : []).slice(-120).map(Number).filter(Number.isFinite);
        const wrap = el("span", "mod-spark-wrap");
        if (node.label) wrap.append(el("span", "mod-spark-label", str(node.label, 40)));
        const ns = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(ns, "svg");
        svg.setAttribute("class", "mod-spark");
        svg.setAttribute("viewBox", "0 0 100 20");
        svg.setAttribute("preserveAspectRatio", "none");
        svg.setAttribute("role", "img");
        svg.setAttribute("aria-label", plain(node) || "A sparkline");
        if (values.length) {
          const lo = Math.min(...values), hi = Math.max(...values);
          const scale = Math.max(Math.abs(lo), Math.abs(hi)) || 1;
          const low = lo / scale, span = hi / scale - low;
          const points = values.map((v, i) => `${values.length === 1 ? 50 : (i * 100 / (values.length - 1)).toFixed(2)},${(18 - (hi === lo ? 8 : ((v / scale - low) / span) * 16)).toFixed(2)}`);
          const line = document.createElementNS(ns, "polyline");
          line.setAttribute("points", points.join(" "));
          line.setAttribute("fill", "none");
          line.setAttribute("vector-effect", "non-scaling-stroke");
          svg.append(line);
        }
        wrap.append(svg);
        return tone(wrap, node.tone);
      }
      default: return document.createTextNode("");
    }
  }

  // A mod's Markdown is its words only. It is laid out in a template, where nothing loads (a link's favicon would
  // fetch the mod's address), and each link or picture becomes its words: a mod with no network has no way out
  // through the user's click. A choice card in it can't be pressed; a code block's Copy still works.
  function wordsOnly(html) {
    const t = document.createElement("template");
    t.innerHTML = html;
    for (const link of t.content.querySelectorAll("a, .md-link")) link.replaceWith(el("span", "mod-link", link.textContent || ""));
    for (const button of t.content.querySelectorAll("button:not(.copy)")) button.disabled = true;
    return document.importNode(t.content, true);
  }

  // Nothing a mod draws acts for it through the page: a click on a link or a button in its Markdown is stopped here,
  // before the page's own link and card handlers hear it. Its own Buttons, Inputs and Selects talk only to the mod.
  function inert(root) {
    root.addEventListener("click", (e) => {
      const hit = e.target?.closest?.("a, .md-link, .mod-md button");
      if (!hit || !root.contains(hit) || hit.classList.contains("copy")) return;
      e.preventDefault();
      e.stopPropagation();
    });
    return root;
  }

  // ---- the list of mods (/mods in a chat, Settings -> Plugins -> Mods) ----------------------------------------
  const SAID = { running: "On", starting: "Starting", stopped: "Not running", off: "Off", needs_allow: "Needs your Allow",
                 crashed: "Stopped with an error" };
  function where(m) {
    if (m.builtin) return "DGC's own";
    if (m.plugin_title || m.plugin) return `From the plugin ${str(m.plugin_title || m.plugin, 80)}`;
    if (m.written) return "Written by DGC in this session";
    if (m.dev) return "A folder you're writing (dgc mods dev)";
    return "Installed by you";
  }
  // opts: {act(name, op), open(name) for a panel, busy: Set of names with an action on its way}
  function listView(mods, on, opts = {}) {
    const box = el("div", "mod-list");
    if (on === false) {
      const off = el("p", "mod-off", "Mods are off here (safe mode, or the mods_enabled setting), so none of these runs.");
      off.setAttribute("role", "status");
      box.append(off);
    }
    const rows = Array.isArray(mods) ? mods.filter((m) => m && typeof m.name === "string") : [];
    if (!rows.length) box.append(el("p", "mod-empty", "No mods yet. DGC's own come with it; yours appear here once you install or write one."));
    for (const m of rows) {
      const item = el("article", "mod-item");
      item.dataset.mod = m.name;
      item.dataset.state = String(m.state || "");
      const head = el("div", "mod-item-head");
      const name = el("strong", "mod-item-title", str(m.title || m.name, 60));
      name.id = `mod-item-${m.name}-${Math.random().toString(36).slice(2, 7)}`;
      item.setAttribute("aria-labelledby", name.id);
      head.append(name, el("span", "mod-item-version", str(m.version, 40)),
                  tone(el("span", "mod-state", SAID[m.state] || str(m.state, 30)),
                       m.state === "running" ? "ok" : m.state === "needs_allow" ? "warn" : m.state === "crashed" ? "bad" : "muted"));
      item.append(head, el("p", "mod-item-where", where(m)));
      if (m.description) item.append(el("p", "mod-item-desc", str(m.description, 300)));
      if (m.error) { const error = tone(el("p", "mod-item-error", str(m.error, 300)), "bad"); error.setAttribute("role", "alert"); item.append(error); }
      const asks = (Array.isArray(m.asks) ? m.asks : []).map((line) => str(line, 300));
      if (asks.length) {
        // What it asks for, in the words the terminal's /mods and its Allow card use. Before an Allow it is shown in
        // full, above the button; otherwise one click away.
        const list = el("ul", "mod-asks");
        for (const line of asks) list.append(el("li", "", line));
        if (m.state === "needs_allow") {
          item.append(el("p", "mod-asks-head", m.written ? "Allowed, it runs for this session only. It can:" : "If you allow it:"), list);
        } else {
          const more = el("details", "mod-asks-more");
          more.append(el("summary", "", "What it can do"), list);
          item.append(more);
        }
      }
      const actions = el("div", "mod-item-actions");
      const button = (label, op, primary) => {
        const b = el("button", `act${primary ? " primary" : ""}`, label);
        b.type = "button";
        b.dataset.op = op;
        b.setAttribute("aria-label", `${label}: ${str(m.title || m.name, 60)}`);
        if (opts.busy?.has?.(m.name)) b.disabled = true;
        b.addEventListener("click", () => (op === "pane" ? opts.open?.(m.name, b) : opts.act?.(m.name, op, b, str(m.review, 64))));
        actions.append(b);
        return b;
      };
      if (typeof opts.act === "function") {
        if (m.state === "needs_allow") button(m.written ? "Allow for this session" : "Allow", "allow", true);
        else if (m.state === "running" || m.state === "starting") {
          if (Array.isArray(m.draws) && m.draws.includes("pane") && typeof opts.open === "function") button("Show its panel", "pane", true);
          button("Reload", "reload");
          button("Turn off", "off");
        } else if (m.state === "crashed") { button("Reload", "reload", true); button("Turn off", "off"); }
        else button("Turn on", "on", true);
      }
      if (actions.childNodes.length) item.append(actions);
      box.append(item);
    }
    return box;
  }

  // The words under the list: how to get out of a broken mod, and how to make one.
  function aboutLines() {
    const box = el("div", "mod-about");
    const safe = el("p", "");
    safe.append(document.createTextNode("Starting DGC with "), el("code", "", "dgc --safe-mode"), document.createTextNode(" runs no mods at all."));
    const make = el("p", "");
    make.append(document.createTextNode("To make one, ask DGC with "), el("code", "", "$mod-author"),
                document.createTextNode(", or run "), el("code", "", "dgc mods dev FOLDER"), document.createTextNode(" on a folder of your own."));
    box.append(safe, make);
    return box;
  }

  // ---- a chat page's mods -----------------------------------------------------------------------------------
  function create(o) {
    const surface = o.surface === "chat" ? "chat" : "work";
    const prefix = surface === "chat" ? "chatdgc-mods-" : "wmods-";
    let seq = 0;
    const nextId = () => `${prefix}${Date.now().toString(36)}-${++seq}`;
    const post = (msg) => { try { o.post({ type: "mods", ...msg }); } catch { /* the host is going */ } };
    let offered = false, on = true, mods = [];
    const slots = new Map();                 // name -> {pane, band, status, title}
    const pending = new Map();               // request id -> {kind, card?, name}
    const offers = new Map();                // offer id -> card
    const busy = new Set();
    const folded = new Set();
    const titleOf = (name) => str(slots.get(name)?.title || mods.find((m) => m.name === name)?.title || name, 60);
    const running = (name) => mods.some((m) => m.name === name && (m.state === "running" || m.state === "starting"));
    const draws = (name, slot) => !!mods.find((m) => m.name === name)?.draws?.includes?.(slot);

    // The drawer: a mod's panel, or /mods. Beside the chat when the page is wide (the page makes room), over it when
    // narrow. Not modal: the chat stays usable beside it. Esc or the close button puts the focus back where it was.
    const drawer = el("aside", "mod-drawer");
    drawer.hidden = true;
    drawer.dataset.surface = surface;
    drawer.setAttribute("role", "dialog");
    drawer.setAttribute("aria-modal", "false");
    const head = el("div", "mod-drawer-head");
    const back = el("button", "mod-drawer-icon mod-drawer-back");
    back.type = "button"; back.title = "Back to your mods"; back.setAttribute("aria-label", "Back to your mods");
    back.append(glyph("arrow-left")); back.hidden = true;
    const title = el("h2", "mod-drawer-title", "Mods");
    title.id = `mod-drawer-title-${surface}`;
    drawer.setAttribute("aria-labelledby", title.id);
    const close = el("button", "mod-drawer-icon mod-drawer-close");
    close.type = "button"; close.title = "Close"; close.setAttribute("aria-label", "Close");
    close.append(glyph("close"));
    head.append(back, title, close);
    const body = inert(el("div", "mod-drawer-body"));
    body.tabIndex = -1;
    drawer.append(head, body);
    (o.drawerHost || document.body).append(drawer);
    let showing = null, opener = null, fromList = false;
    close.addEventListener("click", () => closeDrawer());
    back.addEventListener("click", () => openList(opener, true));
    drawer.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeDrawer(); } });

    function openDrawer(kind, from) {
      if (from !== undefined) opener = from || document.activeElement;
      showing = kind;
      drawer.hidden = false;
      document.body.classList.add("mods-drawer-open");
      paintDrawer();
      body.focus({ preventScroll: true });
    }
    function closeDrawer() {
      if (drawer.hidden) return;
      drawer.hidden = true; showing = null; fromList = false;
      document.body.classList.remove("mods-drawer-open");
      const to = opener; opener = null;
      if (to && to.isConnected && typeof to.focus === "function") to.focus();
    }
    function openList(from, keep) {
      if (!offered) return false;
      fromList = false;
      openDrawer("list", keep ? undefined : from);
      post({ op: "list", request_id: nextId(), surface });
      return true;
    }
    function openPane(name, from) {
      if (!offered || !draws(name, "pane")) return false;
      if (showing === "list") fromList = true;
      openDrawer(`pane:${name}`, showing === "list" ? undefined : from);
      return true;
    }

    // Redrawn as the mod draws again: the field being typed in keeps its words and the focus.
    function keepTyping(root, paint) {
      const active = document.activeElement;
      const held = active && root.contains(active) && active.dataset?.id
        ? { id: active.dataset.id, tag: active.tagName, value: active.value, start: active.selectionStart, end: active.selectionEnd } : null;
      paint();
      if (!held) return;
      const again = [...root.querySelectorAll("[data-id]")].find((n) => n.dataset.id === held.id && n.tagName === held.tag);
      if (!again) return;
      if (held.tag === "INPUT") { again.value = held.value; try { again.setSelectionRange(held.start, held.end); } catch { /* not a text field */ } }
      again.focus({ preventScroll: true });
    }
    function paintDrawer() {
      if (drawer.hidden || !showing) return;
      if (showing === "list") {
        title.textContent = "Mods"; back.hidden = true;
        keepTyping(body, () => {
          body.replaceChildren(listView(mods, on, { act: setMod, open: (name, b) => openPane(name, b), busy }), aboutLines());
        });
        return;
      }
      const name = showing.slice(5);
      title.textContent = `From ${titleOf(name)}`;
      back.hidden = !fromList;
      const tree = slots.get(name)?.pane;
      keepTyping(body, () => {
        if (!running(name)) body.replaceChildren(el("p", "mod-empty", `${titleOf(name)} isn't running, so its panel is empty.`));
        else if (!tree) body.replaceChildren(el("p", "mod-empty", "Nothing to show yet."));
        else body.replaceChildren(draw(tree, { act: (id, value) => action(name, id, value) }));
      });
    }

    function action(name, id, value) {
      if (!ID.test(id)) return;
      post({ op: "action", name, id, ...(value !== undefined ? { value: str(value, 400) } : {}), surface });
    }
    function setMod(name, op, button, review) {
      if (!["allow", "on", "off", "reload"].includes(op)) return;
      const id = nextId();
      pending.set(id, { kind: "set", name });
      busy.add(name);
      paintDrawer();
      post({ op: "set", request_id: id, name, action: op, surface, ...(op === "allow" && review ? { review } : {}) });
    }

    // ---- above the prompt box: each band, then one status line ----------------------------------------------
    const strip = o.strip;
    function paintStrip() {
      if (!strip) return;
      const bands = el("div", "mod-bands");
      const line = el("div", "mod-status");
      line.setAttribute("role", "group");
      line.setAttribute("aria-label", "Your mods");
      for (const [name, s] of slots) {
        if (!running(name)) continue;
        const shown = titleOf(name);
        if (s.band) {
          const band = inert(el("section", "mod-band"));
          band.dataset.mod = name;
          band.setAttribute("aria-label", `From ${shown}`);
          const toggle = el("button", "mod-band-toggle");
          toggle.type = "button";
          const open = !folded.has(name);
          toggle.setAttribute("aria-expanded", String(open));
          toggle.title = open ? `Fold ${shown}'s band` : `Show ${shown}'s band`;
          toggle.append(glyph(open ? "chevron-down" : "chevron-right"), el("span", "mod-band-title", shown));
          const bodyId = `mod-band-${surface}-${name}`;
          toggle.setAttribute("aria-controls", bodyId);
          const content = el("div", "mod-band-body");
          content.id = bodyId;
          if (open) content.append(draw(s.band, { act: (id, value) => action(name, id, value) }));
          else { content.append(el("span", "mod-band-folded", plain(s.band))); }
          content.dataset.folded = String(!open);
          toggle.addEventListener("click", () => {
            if (folded.has(name)) folded.delete(name); else folded.add(name);
            paintStrip();
            strip.querySelector(`.mod-band[data-mod="${name}"] .mod-band-toggle`)?.focus();
          });
          band.append(toggle, content);
          bands.append(band);
        }
        if (s.status) {
          const words = plain(s.status);
          const hasPane = draws(name, "pane");
          const item = el(hasPane ? "button" : "span", "mod-status-item");
          item.dataset.mod = name;
          item.title = `${shown} ${words}`.trim() + (hasPane ? " · open its panel" : "");
          if (hasPane) {
            item.type = "button";
            item.setAttribute("aria-label", `${shown}: ${words}. Open its panel`);
            item.addEventListener("click", () => openPane(name, item));
          } else {
            item.tabIndex = 0;
            item.setAttribute("aria-label", `${shown}: ${words}`);
          }
          const bodyNode = el("span", "mod-status-body");
          bodyNode.append(draw(s.status, { inline: true }));
          item.append(el("span", "mod-status-title", shown), bodyNode);
          line.append(item);
        }
      }
      const focused = document.activeElement && strip.contains(document.activeElement)
        ? (document.activeElement.closest("[data-mod]")?.dataset.mod || "") + "|" + document.activeElement.className : "";
      strip.replaceChildren(...(bands.childNodes.length ? [bands] : []), ...(line.childNodes.length ? [line] : []));
      strip.hidden = !strip.childNodes.length;
      if (focused) {
        const [mod, cls] = focused.split("|");
        const again = [...strip.querySelectorAll(`[data-mod="${mod}"] *, [data-mod="${mod}"]`)].find((n) => n.className === cls);
        again?.focus?.({ preventScroll: true });
      }
    }

    // ---- a command's answer, and the question about written mods: cards in the transcript ---------------------
    function resultCard(name, args) {
      const mod = commandOwner(name);
      const card = inert(el("div", "mod-result"));
      card.setAttribute("role", "group");
      const head = el("div", "mod-result-head");
      head.append(glyph("extensions"), el("span", "mod-result-from", `From ${mod ? mod.title : "a mod"}`),
                  el("span", "mod-result-command", `/${name}${args ? " " + str(args, 200) : ""}`));
      card.setAttribute("aria-label", `From ${mod ? mod.title : "a mod"}: /${name}`);
      const content = el("div", "mod-result-body");
      content.append(el("span", "mod-result-wait", "Running…"));
      card.append(head, content);
      card.dataset.state = "running";
      return card;
    }
    function fillResult(card, ev) {
      const content = card.querySelector(".mod-result-body");
      if (!content) return;
      if (ev.mod) card.querySelector(".mod-result-from").textContent = `From ${str(ev.mod, 60)}`;
      if (ev.error) {
        const error = tone(el("p", "mod-result-error", str(ev.error || "It didn't answer.", 300)), "bad");
        error.setAttribute("role", "alert");
        content.replaceChildren(error);
        card.dataset.state = "error";
        return;
      }
      if (ev.tree && typeof ev.tree === "object") content.replaceChildren(draw(ev.tree, {}));
      else if (typeof ev.text === "string" && ev.text) content.replaceChildren(el("div", "mod-result-text", str(ev.text, 20000)));
      else content.replaceChildren(tone(el("span", "mod-result-none", "(It answered nothing.)"), "muted"));
      card.dataset.state = "done";
    }

    function offerCard(ev) {
      const card = el("div", "card mod-offer");
      card.dataset.offer = str(ev.id, 64);
      card.dataset.mod = str(ev.name, 40);
      card.setAttribute("role", "group");
      const q = el("div", "q");
      q.append(glyph("extensions"), el("span", "", "Turn on the mods DGC writes in this session?"));
      q.id = `mod-offer-${str(ev.id, 64)}`;
      card.setAttribute("aria-labelledby", q.id);
      const who = el("p", "mod-offer-who");
      who.append(el("strong", "", str(ev.mod || ev.name, 60)), document.createTextNode(` ${str(ev.version, 40)}`),
                 el("span", "mod-offer-folder", ` · ${str(ev.folder, 200)}`));
      card.append(q, who);
      if (ev.more) card.append(tone(el("p", "mod-offer-more", "It asks for more than you allowed for the mods DGC wrote earlier."), "warn"));
      const list = el("ul", "mod-asks");
      for (const line of (Array.isArray(ev.asks) ? ev.asks : []).slice(0, 40)) list.append(el("li", "", str(line, 300)));
      card.append(el("p", "mod-asks-head", "It can:"), list,
                  tone(el("p", "mod-offer-note", "For this session only: it runs while this chat is open, and is reloaded as DGC changes it."), "muted"));
      const buttons = el("div", "btns");
      const answer = (allow) => {
        if (card.classList.contains("resolved")) return;
        const id = nextId();
        pending.set(id, { kind: "offer", card, allow });
        card.classList.add("resolved");
        card.setAttribute("aria-disabled", "true");
        buttons.querySelectorAll("button").forEach((b) => { b.disabled = true; });
        settle(card, allow ? `Allowed: ${str(ev.mod || ev.name, 60)} runs for this session.` : "Not now: nothing runs, and DGC won't ask again in this session. /mods lists what it writes, with an Allow.");
        post({ op: "offer", request_id: id, id: str(ev.id, 64), allow, surface });
      };
      const allow = el("button", "act primary", "Allow"); allow.type = "button";
      const notNow = el("button", "act", "Not now"); notNow.type = "button";
      allow.addEventListener("click", () => answer(true));
      notNow.addEventListener("click", () => answer(false));
      buttons.append(allow, notNow);
      card.append(buttons);
      return card;
    }
    function settle(card, words) {
      card.querySelector(".decision")?.remove();
      const line = el("div", "decision", words);
      line.setAttribute("role", "status");
      card.append(line);
    }

    // ---- commands ---------------------------------------------------------------------------------------------
    function commands() {
      if (!offered || !on) return [];
      const out = [];
      for (const m of mods) {
        if (m.state !== "running") continue;
        for (const c of Array.isArray(m.commands) ? m.commands : []) {
          if (c && typeof c.name === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(c.name) && !out.some((x) => x.name === c.name)) {
            out.push({ name: c.name, description: str(c.description, 120), title: str(m.title || m.name, 60), mod: m.name });
          }
        }
      }
      return out;
    }
    function commandOwner(name) { const c = commands().find((x) => x.name === name); return c ? { name: c.mod, title: c.title } : null; }
    const isCommand = (name) => commands().some((c) => c.name === name);
    function run(name, args = "") {
      if (!isCommand(name)) return false;
      const id = nextId();
      const card = resultCard(name, args);
      pending.set(id, { kind: "command", card, name });
      o.transcript(card);
      post({ op: "command", request_id: id, name, ...(args ? { args: str(args, 2000) } : {}), surface });
      return true;
    }
    // Typed into the message box and sent: "/mods" opens the list, a running mod's "/name args" runs at once. True
    // when it was one of those, so the page sends nothing (never a prompt, never a steering message).
    function intercept(text, reserved = () => false) {
      const typed = String(text || "").trim();
      const m = /^\/([a-z][a-z0-9-]{0,31})(?:\s+([\s\S]*))?$/.exec(typed);
      if (!m || !offered) return false;
      if (m[1] === "mods" && !m[2]) { openList(document.activeElement); return true; }
      if (reserved(m[1]) || !isCommand(m[1])) return false;
      return run(m[1], (m[2] || "").trim());
    }

    // ---- events from DGC --------------------------------------------------------------------------------------
    function ready(capabilities) {
      offered = !!(capabilities && capabilities.mods && Number(capabilities.mods.version) >= 1);
      mods = []; slots.clear(); pending.clear(); busy.clear();
      paintStrip();
      if (!offered) { closeDrawer(); o.changed?.(); return; }
      post({ op: "list", request_id: nextId(), surface });
      if (Number(capabilities.mods.offers) >= 1) post({ op: "watch", surface });
      o.changed?.();
    }
    function event(ev) {
      if (!ev || typeof ev !== "object") return false;
      const mine = (ev.surface === "chat") === (surface === "chat");
      const request = typeof ev.request_id === "string" ? ev.request_id : "";
      if (ev.type === "command_rejected" && request.startsWith(prefix)) {
        const was = pending.get(request);
        pending.delete(request);
        if (was?.kind === "command") fillResult(was.card, { error: str(ev.message || "It couldn't run.", 300) });
        else if (was?.kind === "offer") settle(was.card, str(ev.message || "That answer didn't reach DGC.", 300));
        else if (was?.kind === "set") { busy.delete(was.name); o.notice?.(titleOf(was.name), str(ev.message, 300), "bad"); paintDrawer(); }
        return true;
      }
      if (ev.type === "mod_result") {
        if (!request.startsWith(prefix)) return false;
        const was = pending.get(request);
        pending.delete(request);
        if (was?.kind === "command") fillResult(was.card, ev);
        return true;
      }
      if (!mine || !["mods", "mod_ui", "mod_toast", "mod_offer"].includes(ev.type)) return false;
      if (!offered) return true;
      if (ev.type === "mods") {
        mods = (Array.isArray(ev.mods) ? ev.mods : []).filter((m) => m && typeof m.name === "string");
        on = ev.on !== false;
        for (const name of [...slots.keys()]) if (!running(name)) slots.delete(name);
        for (const m of mods) if (slots.has(m.name)) slots.get(m.name).title = str(m.title, 60);
        const was = request && pending.get(request);
        if (was?.kind === "set") { pending.delete(request); busy.delete(was.name); }
        if (was?.kind === "offer") pending.delete(request);
        // A question answered elsewhere (its mod allowed from /mods) is settled here too.
        for (const [id, card] of offers) {
          const m = mods.find((x) => x.name === card.dataset.mod);
          if (m && m.state !== "needs_allow" && !card.classList.contains("resolved")) {
            card.classList.add("resolved"); card.querySelectorAll("button").forEach((b) => { b.disabled = true; });
            settle(card, `Allowed: ${str(m.title, 60)} runs for this session.`);
            offers.delete(id);
          }
        }
        paintStrip(); paintDrawer(); o.changed?.();
        return true;
      }
      if (ev.type === "mod_ui") {
        const name = str(ev.name, 40);
        if (!SLOTS.includes(ev.slot) || !name) return true;
        const s = slots.get(name) || {};
        s.title = str(ev.mod || s.title || name, 60);
        if (ev.tree && typeof ev.tree === "object") s[ev.slot] = ev.tree; else delete s[ev.slot];
        slots.set(name, s);
        if (ev.slot === "pane") { if (showing === `pane:${name}`) paintDrawer(); }
        else paintStrip();
        return true;
      }
      if (ev.type === "mod_toast") {
        o.notice?.(str(ev.mod || "A mod", 60), str(ev.text, 300), TONES.includes(ev.tone) ? ev.tone : "");
        return true;
      }
      if (ev.type === "mod_offer") {
        if (offers.has(ev.id)) return true;                  // said again (a page that came back asks): drawn once
        // The same mod asked about again (it changed what it asks for while asked): the newer question replaces it.
        for (const [id, card] of offers) {
          if (card.dataset.mod === ev.name && !card.classList.contains("resolved")) {
            card.classList.add("resolved"); card.querySelectorAll("button").forEach((b) => { b.disabled = true; });
            settle(card, "It changed what it asks for, so DGC asks again below.");
            offers.delete(id);
          }
        }
        const card = offerCard(ev);
        offers.set(ev.id, card);
        o.transcript(card);
        o.announce?.(`DGC wrote a mod, ${str(ev.mod || ev.name, 60)}. Turn on the mods DGC writes in this session?`);
        return true;
      }
      return false;
    }

    // ---- a slash menu for a page that has none (ChatDGC): /mods, and each running mod's commands ----------------
    // menu(input, {submit}) attaches to a <textarea>. It opens on a "/" at the start of the box, lists what matches
    // (↑↓ to move, Enter or Tab to choose, Esc to close), and puts the chosen command in the box.
    function menu(input, opts = {}) {
      const list = el("div", "mod-slash");
      list.setAttribute("role", "listbox");
      list.id = `mod-slash-${surface}`;
      list.setAttribute("aria-label", "Commands");
      list.hidden = true;
      (opts.host || input.parentElement || document.body).append(list);
      input.setAttribute("aria-controls", list.id);
      let items = [], at = 0;
      const hide = () => { list.hidden = true; items = []; input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant"); };
      const paint = () => {
        list.replaceChildren(...items.map((it, i) => {
          const row = el("div", "mod-slash-row");
          row.id = `${list.id}-${i}`;
          row.setAttribute("role", "option");
          row.setAttribute("aria-selected", String(i === at));
          row.append(el("span", "mod-slash-name", `/${it.name}`), el("span", "mod-slash-desc", it.desc));
          row.addEventListener("pointerdown", (e) => { e.preventDefault(); at = i; choose(); });
          return row;
        }));
        list.hidden = !items.length;
        input.setAttribute("aria-expanded", String(!!items.length));
        if (items.length) input.setAttribute("aria-activedescendant", `${list.id}-${at}`);
      };
      const refresh = () => {
        const value = input.value;
        const token = /^\/([a-z0-9-]*)$/.exec(value);
        if (!offered || !token) { hide(); return; }
        const query = token[1];
        const all = [{ name: "mods", desc: "Your mods: allow one, show its panel, turn one off or reload it" },
                     ...commands().map((c) => ({ name: c.name, desc: `${c.description || "A command"} · from ${c.title}` }))];
        items = all.filter((it) => it.name.includes(query) || it.desc.toLowerCase().includes(query));
        items.sort((a, b) => Number(!a.name.startsWith(query)) - Number(!b.name.startsWith(query)));
        at = Math.min(at, Math.max(0, items.length - 1));
        paint();
      };
      const choose = () => {
        const it = items[at];
        if (!it) return;
        hide();
        // Chosen from the menu, it runs at once, as the terminal's palette does; arguments can be typed after it.
        input.value = "";
        opts.cleared?.();
        if (it.name === "mods") openList(input); else run(it.name, "");
      };
      input.addEventListener("input", () => { at = 0; refresh(); });
      input.addEventListener("keydown", (e) => {
        if (list.hidden || !items.length) return;
        if (e.key === "ArrowDown") { e.preventDefault(); e.stopImmediatePropagation(); at = (at + 1) % items.length; paint(); }
        else if (e.key === "ArrowUp") { e.preventDefault(); e.stopImmediatePropagation(); at = (at + items.length - 1) % items.length; paint(); }
        else if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") { e.preventDefault(); e.stopImmediatePropagation(); choose(); }
        else if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); hide(); }
      }, true);
      input.addEventListener("blur", () => setTimeout(hide, 0));
      return { refresh, hide, list };
    }

    return { ready, event, commands, isCommand, run, intercept, openList, openPane, close: closeDrawer, menu,
             get offered() { return offered; }, get drawer() { return drawer; } };
  }

  window.DgcMods = { draw, plain, listView, aboutLines, create, TONES };
})();
