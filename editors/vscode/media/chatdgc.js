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

  const log = $("cd-log"), scroller = $("cd-scroll"), input = $("cd-input"), send = $("cd-send"), stop = $("cd-stop");
  const modelPick = $("cd-model"), thinkingPick = $("cd-thinking"), searchPick = $("cd-search"), notice = $("cd-notice");
  const state = { conversation: null, messages: [], earlier: 0, busy: false, replyId: "", models: [], defaultModel: "",
                  model: "", thinking: "", opened: false, unavailable: "", searching: {}, pending: [] };
  const PASTE_AS_FILE = 5000;          // characters: a longer paste becomes an attachment, as in the coding chat
  const IMAGE_SIDE = 2048;             // a pasted image is scaled to this, so it fits one frame
  const KIND_ICON = { image: "file-media", document: "file-text", text: "file-text", file: "file" };
  const LABEL = { off: "Thinking off", low: "Think: low", medium: "Think: medium", high: "Think: high", xhigh: "Think: extra high" };

  // ---- scrolling: follow the reply while the reader is at the bottom
  let pinned = true;
  scroller.addEventListener("scroll", () => { pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48; });
  const follow = () => { if (pinned) scroller.scrollTop = scroller.scrollHeight; };

  // ---- messages
  const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } };
  /** [n] in a reply that names one of its sources becomes a small mark that opens that page. Text nodes only,
   *  outside code: a model's "[1]" in a code block is code. */
  function cite(node, sources) {
    if (!Array.isArray(sources) || !sources.length) return;
    const byN = new Map(sources.map((x) => [String(x.n), x]));
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, { acceptNode: (t) =>
      t.parentElement?.closest("pre, code, .md-link") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
    const texts = [];
    for (let t = walker.nextNode(); t; t = walker.nextNode()) if (/\[\d{1,2}\]/.test(t.nodeValue)) texts.push(t);
    for (const t of texts) {
      const parts = t.nodeValue.split(/(\[\d{1,2}\])/);
      const frag = document.createDocumentFragment();
      for (const part of parts) {
        const source = /^\[(\d{1,2})\]$/.test(part) ? byN.get(part.slice(1, -1)) : null;
        if (!source) { if (part) frag.append(part); continue; }
        const mark = el("button", "cd-cite", String(source.n));
        mark.type = "button"; mark.dataset.url = source.url;
        mark.title = `${source.title} (${hostOf(source.url)})`;
        mark.setAttribute("aria-label", `Source ${source.n}: ${source.title}`);
        frag.append(mark);
      }
      t.replaceWith(frag);
    }
  }
  function body(message) {
    const node = el("div", "text cd-body");
    const html = md(message.text);
    if (html === null) node.textContent = message.text || ""; else node.innerHTML = html;
    cite(node, message.sources);
    return node;
  }
  /** What a reply looked up: the queries, and the pages it may cite, numbered as it cites them. */
  function sourcesBlock(message) {
    const sources = Array.isArray(message.sources) ? message.sources : [];
    const searches = Array.isArray(message.searches) ? message.searches : [];
    if (!sources.length && !searches.length) return null;
    const box = el("details", "cd-sources");
    const label = sources.length ? `Sources · ${sources.length}` : `Searched the web`;
    box.append(el("summary", "cd-sources-label", label));
    if (searches.length) box.append(el("p", "cd-searched", `Searched for ${searches.map((q) => `“${q}”`).join(", ")}`));
    const list = el("ol", "cd-source-list");
    for (const source of sources) {
      const item = el("li", "cd-source");
      item.value = Number(source.n) || 0;
      const open = el("button", "cd-source-open");
      open.type = "button"; open.dataset.url = source.url; open.title = source.url;
      open.append(el("span", "cd-source-title", source.title || source.url), el("span", "cd-source-host", hostOf(source.url)));
      item.append(open);
      list.append(item);
    }
    if (sources.length) box.append(list);
    return box;
  }
  function thinkingBlock(message, live) {
    const box = el("details", "cd-thinking");
    const summary = el("summary", "cd-thinking-label", live ? "Thinking…" : "Thought");
    const text = el("div", "cd-thought");
    text.textContent = message.thinking || "";
    box.append(summary, text);
    if (live && !message.text) box.open = true;
    return box;
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
    const kind = item.kind === "file" ? (/\.(png|jpe?g|gif|webp)$/i.test(item.name || "") ? "image" : "file") : item.kind;
    const glyph = el("span", `codicon codicon-${KIND_ICON[kind] || "file"}`); glyph.setAttribute("aria-hidden", "true");
    const name = el("span", "cd-chip-name", item.name || "Attachment");
    const about = item.kind === "text" && typeof item.text === "string" ? `${item.text.length.toLocaleString()} characters`
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
    box.replaceChildren(...state.pending.map((item, i) => chip(item, () => { state.pending.splice(i, 1); chips(); controls(); input.focus(); })));
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
  function messageNode(message) {
    const live = state.busy && message.id === state.replyId;
    const node = el("article", `cd-msg cd-${message.role === "user" ? "user" : "assistant"}`);
    node.dataset.id = message.id || "";
    if (message.role === "user") {
      const sent = Array.isArray(message.attachments) ? message.attachments : [];
      const pictures = sent.filter((item) => item.kind === "image" && /^att_[a-f0-9]{32}$/.test(item.id || ""));
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
      if (message.text) {
        const bubble = el("div", "cd-bubble");
        bubble.textContent = message.text;
        node.append(bubble);
      }
      const actions = el("div", "cd-actions");
      actions.append(action("copy", "Copy", () => vscode.postMessage({ type: "copy", text: message.text || "" })));
      node.append(actions);
      return node;
    }
    if (message.thinking) node.append(thinkingBlock(message, live));
    if (message.text || !live) node.append(body(message));
    const doing = live && state.searching[message.id];
    if (doing) node.append(el("div", "cd-working cd-activity", doing.kind === "looking"
      ? `Looking at the image with ${doing.text}…` : `Searching the web for “${doing.text}”…`));
    else if (live && !message.text && !message.thinking) node.append(el("div", "cd-working", "Thinking…"));
    if (message.partial) node.append(el("p", "cd-end", "This reply is too long to show in full here."));
    if (!live) { const found = sourcesBlock(message); if (found) node.append(found); }
    const end = endNote(message);
    if (end) node.append(end);
    if (!live && message.text) {
      const actions = el("div", "cd-actions");
      actions.append(action("copy", "Copy", () => vscode.postMessage({ type: "copy", text: message.text || "" })));
      if (message.model) actions.append(el("span", "cd-meta", String(message.model)));
      node.append(actions);
    }
    return node;
  }
  function render() {
    const nodes = state.messages.map(messageNode);
    log.replaceChildren(...nodes);
    $("cd-earlier").hidden = !(state.earlier > 0);
    document.body.classList.toggle("cd-blank", state.opened && !state.messages.length && !state.earlier);
    $("cd-empty").hidden = !(state.opened && !state.messages.length && !state.earlier);
    controls();
    follow();
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
        // Keep an open thinking box open, and a closed one closed, across redraws.
        const was = old?.querySelector("details.cd-thinking"), now = fresh.querySelector("details.cd-thinking");
        if (was && now && was.dataset.touched) { now.open = was.open; now.dataset.touched = "1"; }
        if (old) old.replaceWith(fresh); else log.append(fresh);
      }
      redraw.clear();
      document.body.classList.remove("cd-blank");
      $("cd-empty").hidden = true;
      follow();
    });
  }
  log.addEventListener("toggle", (e) => { if (e.target.matches?.("details.cd-thinking")) e.target.dataset.touched = "1"; }, true);

  // ---- the composer
  function controls() {
    const text = input.value;
    send.hidden = state.busy;
    stop.hidden = !state.busy;
    send.disabled = (!text.trim() && !state.pending.length) || !state.conversation || !!state.unavailable;
    input.disabled = !!state.unavailable;
    const fresh = !state.conversation || (!state.messages.length && !state.earlier);
    $("cd-temp-toggle").hidden = !fresh;
    $("cd-temporary").checked = !!state.conversation?.temporary;
    $("cd-temp-badge").hidden = !state.conversation?.temporary;
    $("cd-menu").hidden = !state.conversation || !!state.conversation.temporary || fresh;
  }
  function grow() {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
  }
  input.addEventListener("input", () => { grow(); controls(); saveDraft(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
    else if (e.key === "Escape" && state.busy) { e.preventDefault(); vscode.postMessage({ type: "stop" }); }
  });
  $("cd-box").addEventListener("submit", (e) => { e.preventDefault(); submit(); });
  stop.addEventListener("click", () => vscode.postMessage({ type: "stop" }));
  function submit() {
    const text = input.value;
    if ((!text.trim() && !state.pending.length) || state.busy || !state.conversation || state.unavailable) return;
    vscode.postMessage({ type: "send", text, model: modelPick.value || "", thinking: thinkingPick.value || "",
                         search: searchPick.value || "auto",
                         ...(state.pending.length ? { attachments: state.pending.map(({ kind, path, name, data, text: pasted }) =>
                           ({ kind, name, ...(path ? { path } : {}), ...(data ? { data } : {}), ...(pasted ? { text: pasted } : {}) })) } : {}) });
    input.value = ""; grow(); saveDraft();
    state.pending = []; chips();
    state.busy = true;        // until the turn says otherwise: no second send in the meantime
    hideNotice();
    controls();
  }
  modelPick.addEventListener("change", () => { state.model = modelPick.value; });
  thinkingPick.addEventListener("change", () => { state.thinking = thinkingPick.value; });
  // Web search is the user's standing choice in this tab, not a chat's: it stays as set across chats.
  searchPick.value = ["auto", "on", "off"].includes((vscode.getState() || {}).search) ? vscode.getState().search : "auto";
  searchPick.addEventListener("change", () => { try { vscode.setState({ ...(vscode.getState() || {}), search: searchPick.value }); } catch {} });
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
        if (data) state.pending.push({ kind: "image", name: file.name && file.name !== "image.png" ? file.name : "Pasted image", data,
                                       size: Math.round(data.length * 0.75) });
        else showNotice("That image couldn't be read.");
      }
      chips(); controls();
    } else if (words.length > PASTE_AS_FILE && state.pending.length < 10) {
      e.preventDefault();
      state.pending.push({ kind: "text", name: "Pasted text", text: words });
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
  }

  // ---- links and copy buttons inside rendered Markdown
  log.addEventListener("click", (e) => {
    const copy = e.target.closest?.(".copy[data-c]");
    if (copy) { vscode.postMessage({ type: "copy", text: decodeURIComponent(copy.dataset.c || "") }); return; }
    const source = e.target.closest?.(".cd-cite[data-url], .cd-source-open[data-url]");
    if (source) { vscode.postMessage({ type: "openLink", target: source.dataset.url || "" }); return; }
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
      case "opened": {
        state.conversation = msg.conversation || null;
        state.messages = Array.isArray(msg.messages) ? msg.messages : [];
        state.earlier = Number(msg.earlier) || 0;
        state.busy = msg.busy === true;
        state.replyId = msg.replyId || "";
        state.opened = true;
        state.model = ""; state.thinking = "";
        state.unavailable = "";
        $("cd-title").textContent = state.conversation?.title || "New chat";
        vscode.setState({ ...(vscode.getState() || {}), conversation: state.conversation?.id || "",
                          temporary: !!state.conversation?.temporary });
        restoreDraft();
        hideNotice();
        fillModels();
        pinned = true;
        render();
        input.focus();
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
        return;
      }
      case "turn":
        if (msg.state === "started") {
          state.busy = true; state.replyId = msg.replyId || "";
          if (!state.messages.some((m) => m.id === state.replyId)) {
            // A continued reply already exists; a new one appears now, empty, and fills in.
          }
        } else {
          state.busy = false;
          state.searching = {};
          announce("Reply finished.");
          render();
        }
        controls();
        return;
      case "activity":
        if ((msg.kind === "searching" || msg.kind === "looking") && msg.messageId) {
          state.searching[msg.messageId] = { kind: msg.kind, text: String(msg.text || "") };
          if (!state.messages.some((m) => m.id === msg.messageId)) state.messages.push({ id: msg.messageId, role: "assistant", text: "", thinking: "" });
          update(msg.messageId);
        }
        return;
      case "message": {
        const message = msg.message;
        if (!message?.id) return;
        delete state.searching[message.id];
        const at = state.messages.findIndex((m) => m.id === message.id);
        if (at >= 0) state.messages[at] = message; else state.messages.push(message);
        if (message.role === "user") { pinned = true; render(); } else update(message.id);
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
          controls();
        }
        return;
      case "error":
        if (msg.opening && /doesn't exist/i.test(msg.message || "")) {
          vscode.postMessage({ type: "reopenNew" });             // gone (a temporary chat after a restart)
          return;
        }
        state.busy = state.busy && !!state.replyId;           // a send that never started isn't running
        showNotice(msg.message || "ChatDGC hit an error.");
        controls();
        return;
      case "lost":
        if (state.busy) { state.busy = false; showNotice(msg.message || "The reply stopped."); render(); }
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
      case "copied":
        announce("Copied.");
        return;
      case "image": {
        if (!/^att_[a-f0-9]{32}$/.test(String(msg.id || ""))) return;
        const ok = typeof msg.data === "string" && /^data:image\/(png|jpeg|gif|webp);base64,/.test(msg.data);
        images.set(msg.id, ok ? { data: msg.data } : { error: String(msg.error || "") });
        for (const picture of document.querySelectorAll(`img[data-att="${CSS.escape(msg.id)}"]`)) {
          if (ok) picture.src = msg.data;
          else picture.closest(".cd-thumb")?.replaceChildren(el("span", "cd-thumb-missing", picture.alt || "Image"));
        }
        while (images.size > 200) images.delete(images.keys().next().value);
        return;
      }
      case "attached":
        for (const item of Array.isArray(msg.items) ? msg.items : []) {
          if (state.pending.length >= 10) { showNotice("Attach up to 10 things to one message.", "info"); break; }
          if (!state.pending.some((p) => p.path && p.path === item.path)) state.pending.push(item);
        }
        chips(); controls(); input.focus();
        return;
    }
  });

  // ---- a draft survives a reload, per chat
  function draftKey() { return `draft:${state.conversation?.id || "new"}`; }
  function saveDraft() { try { vscode.setState({ ...(vscode.getState() || {}), [draftKey()]: input.value.slice(0, 100000) }); } catch {} }
  function restoreDraft() { const saved = (vscode.getState() || {})[draftKey()]; input.value = typeof saved === "string" ? saved : ""; grow(); }

  for (const [value, label] of Object.entries(LABEL)) { const option = thinkingPick.querySelector(`option[value="${value}"]`); if (option) option.textContent = label; }
  controls();
  vscode.postMessage({ type: "ready" });
})();
