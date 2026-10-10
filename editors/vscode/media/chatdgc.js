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
  const modelPick = $("cd-model"), thinkingPick = $("cd-thinking"), notice = $("cd-notice");
  // Web search is always there, as in ChatGPT: the model looks things up whenever an answer depends on it. The
  // box's Search makes it search first, for the next message only; Settings -> Web search can turn it off.
  const searchMode = () => (state.searchFirst ? "on" : "auto");
  const state = { conversation: null, messages: [], earlier: 0, busy: false, replyId: "", models: [], defaultModel: "",
                  model: "", thinking: "", opened: false, unavailable: "", searching: {}, pending: [], editing: "",
                  context: null, compacting: false, editingSummary: false, picks: {},
                  research: false, planAsked: false, countdowns: {}, lastSent: null, forgotten: new Set(), searchFirst: false, planEditing: "", steerDraft: "", open: new Set(),
                  projects: [], projectChats: null, projectChatsAsked: "", cardBusy: {}, cardEdit: {} };
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
  // ---- sources, as ChatGPT shows them: a pill with the site where a fact is cited, a card on hover, and a
  // Sources button that opens them all. A favicon comes from Google's icon service, asked about the origin only,
  // as Work's panel does; with dgc.linkFavicons off (or when one fails) it's a globe, and nothing is asked.
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
  /** [3][4] in a reply becomes one pill: the first source's site, and how many more. */
  function cite(node, sources) {
    if (!Array.isArray(sources) || !sources.length) return;
    const byN = new Map(sources.map((x) => [String(x.n), x]));
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, { acceptNode: (t) =>
      t.parentElement?.closest("pre, code, .md-link") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
    const texts = [];
    for (let t = walker.nextNode(); t; t = walker.nextNode()) if (/\[\d{1,2}\]/.test(t.nodeValue)) texts.push(t);
    for (const t of texts) {
      const parts = t.nodeValue.split(/(\[\d{1,2}\](?:\s*\[\d{1,2}\])*)/);
      const frag = document.createDocumentFragment();
      for (const part of parts) {
        const numbers = /^\[\d{1,2}\]/.test(part) ? [...new Set(part.match(/\d{1,2}/g))] : [];
        const group = numbers.map((n) => byN.get(n)).filter(Boolean);
        if (!group.length) { if (part) frag.append(part); continue; }
        // A number the reply wasn't given stays as text after the pill: the model's mistake, not hidden.
        const stray = numbers.filter((n) => !byN.has(n)).map((n) => `[${n}]`).join("");
        const pill = el("button", "cd-cite");
        pill.type = "button"; pill.dataset.url = group[0].url; pill.dataset.cites = group.map((x) => x.n).join(",");
        pill.append(faviconNode(group[0].url), el("span", "cd-cite-site", siteOf(group[0].url)));
        if (group.length > 1) pill.append(el("span", "cd-cite-more", `+${group.length - 1}`));
        pill.setAttribute("aria-label", `Source${group.length > 1 ? "s" : ""}: ${group.map((x) => `${x.title} (${siteOf(x.url)})`).join("; ")}`);
        frag.append(pill);
        if (stray) frag.append(stray);
      }
      t.replaceWith(frag);
    }
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
  // The card a pill shows on hover or focus; it stays while the pointer is on it, so its links can be used.
  const citeCard = el("div", "cd-cite-card");
  citeCard.hidden = true; citeCard.setAttribute("role", "dialog"); citeCard.setAttribute("aria-label", "Source");
  document.body.append(citeCard);
  let cardTimer = 0;
  function showCard(pill) {
    clearTimeout(cardTimer);
    const message = state.messages.find((m) => m.id === pill.closest(".cd-msg")?.dataset.id) || readerMessage;
    const byN = new Map((message?.sources || []).map((x) => [String(x.n), x]));
    const group = String(pill.dataset.cites || "").split(",").map((n) => byN.get(n)).filter(Boolean);
    if (!group.length) return;
    const list = el("ul", "cd-card-list");
    for (const source of group) list.append(sourceRow(source));
    citeCard.replaceChildren(list);
    citeCard.hidden = false;
    const at = pill.getBoundingClientRect(), width = Math.min(340, window.innerWidth - 24);
    citeCard.style.width = `${width}px`;
    citeCard.style.left = `${Math.max(12, Math.min(at.left, window.innerWidth - width - 12))}px`;
    // Above the pill, as ChatGPT's source preview opens: below it, a card held open by the pointer covered the
    // Sources button and the reply's actions under a short answer (a live run couldn't reach them). Below only
    // when there's no room above.
    const height = citeCard.offsetHeight, above = at.top - height - 6;
    citeCard.style.top = `${above >= 8 ? above : Math.min(at.bottom + 6, window.innerHeight - height - 8)}px`;
  }
  const hideCard = (soon = true) => { clearTimeout(cardTimer); cardTimer = setTimeout(() => { citeCard.hidden = true; }, soon ? 180 : 0); };
  document.addEventListener("mouseover", (e) => {
    const pill = e.target.closest?.(".cd-cite");
    if (pill) showCard(pill);
    else if (e.target.closest?.(".cd-cite-card")) clearTimeout(cardTimer);
  });
  document.addEventListener("mouseout", (e) => {
    if (e.target.closest?.(".cd-cite, .cd-cite-card") && !e.relatedTarget?.closest?.(".cd-cite, .cd-cite-card")) hideCard();
  });
  document.addEventListener("focusin", (e) => { const pill = e.target.closest?.(".cd-cite"); if (pill) showCard(pill); });
  document.addEventListener("focusout", (e) => { if (e.target.closest?.(".cd-cite") && !e.relatedTarget?.closest?.(".cd-cite-card")) hideCard(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !citeCard.hidden) { citeCard.hidden = true; } });
  // Links in the card, the Sources panel and the reader: they live outside the conversation.
  document.addEventListener("click", (e) => {
    const open = e.target.closest?.(".cd-cite-card [data-url], .cd-panel [data-url], .cd-reader [data-url]");
    if (open) vscode.postMessage({ type: "openLink", target: open.dataset.url || "" });
  });
  let readerMessage = null;
  function body(message) {
    const node = el("div", "text cd-body");
    const html = md(message.text);
    if (html === null) node.textContent = message.text || ""; else node.innerHTML = html;
    cite(node, message.sources);
    return node;
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
    if (!questions.length) return [body(message)];
    const text = message.text || "";
    const parts = [];
    let done = 0;
    questions.map((q, i) => [q, i]).sort((a, b) => (Number(a[0].at) || 0) - (Number(b[0].at) || 0)).forEach(([q, i]) => {
      const at = Math.max(done, Math.min(text.length, Number(q.at) || 0));
      if (text.slice(done, at).trim()) parts.push(body({ ...message, text: text.slice(done, at) }));
      parts.push(questionCard(message, q, i, live));
      done = at;
    });
    if (text.slice(done).trim()) parts.push(body({ ...message, text: text.slice(done) }));
    return parts;
  }
  const OTHER = "\u0000other";
  /** A question the reply asked: its options and a box for your own answer. Continue sends the message the model
   *  wrote for it, with your choice in. Answerable while the reply is the last thing said; then it shows what you
   *  chose, or that you moved on. What you pick survives the reply re-drawing as it streams. */
  function questionCard(message, q, index, live) {
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
    citeCard.hidden = true;
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
    if (!from || !(to >= from)) return "";
    const seconds = Math.round((to - from) / 1000);
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }
  function researchStats(r) {
    const reads = Number(r.reads ?? (r.read || []).length) || 0, notes = (r.notes || []).length;
    const parts = [];
    if (r.round) parts.push(`round ${r.round}`);
    parts.push(`${reads} page${reads === 1 ? "" : "s"} read`, `${notes} noted`);
    const time = elapsed(r);
    if (time) parts.push(time);
    return parts.join(" · ");
  }
  function planList(plan) {
    const box = el("div", "cd-plan");
    if (plan.title) box.append(el("h3", "cd-plan-title", plan.title));
    const list = el("ol", "cd-plan-steps");
    for (const step of plan.steps || []) list.append(el("li", "", step));
    box.append(list);
    if ((plan.sites || []).length) box.append(el("p", "cd-plan-sites", `Only these sites: ${plan.sites.join(", ")}`));
    return box;
  }
  const ACTIVITY = { search: ["search", "Searching"], read: ["globe", "Reading"], note: ["note", "Noted"], skip: ["circle-slash", "Skipped"],
                     round: ["sync", ""], write: ["edit", ""], check: ["checklist", ""], checked: ["pass", ""], steer: ["comment", "You added"],
                     info: ["info", ""], error: ["warning", ""], wait: ["watch", ""] };
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
    title.dataset.keep = `plan-title-${message.id}`; steps.dataset.keep = `plan-steps-${message.id}`; sites.dataset.keep = `plan-sites-${message.id}`;
    const row = el("div", "cd-edit-actions");
    const cancel = el("button", "cd-edit-cancel", "Cancel"); cancel.type = "button";
    const go = el("button", "cd-continue", "Start research"); go.type = "submit";
    row.append(cancel, go);
    form.append(field("Title", title), field("Steps, one a line", steps), field("Only these sites", sites), row);
    cancel.addEventListener("click", () => { state.planEditing = ""; update(message.id); });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const edited = { title: title.value.trim(), steps: steps.value.split("\n").map((x) => x.trim()).filter(Boolean),
                       sites: sites.value.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean) };
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
      const plan = kept(`plan-${message.id}`, "cd-research-more", `Research plan · ${(r.plan?.steps || []).length} steps`);
      plan.append(planList(r.plan || {}));
      card.append(plan);
      const lines = r.activity || [];
      card.append(activityList(lines.slice(-8)));
      if ((r.steers || []).length) card.append(el("p", "cd-research-note", `You added: ${r.steers.join(" · ")}`));
      if (status === "running") card.append(steerForm(message));
    } else if (status === "done") {
      const check = r.check || {};
      head("Deep research", [researchStats(r).replace(/^round \d+ · /, ""),
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
      if (!live) { const found = sourcesBlock(message); if (found) node.append(found); }
    }
    if (status === "done" && !live) {
      const actions = el("div", "cd-actions");
      const versions = versionsControl(message);
      if (versions) actions.append(versions);
      actions.append(action("copy", "Copy", () => vscode.postMessage({ type: "copy", text: message.text || "" })));
      const branch = branchAction(message);
      if (branch) actions.append(branch);
      node.append(actions);
    }
    return node;
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
    readerMessage = message;
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
      node.append(actions);
      return node;
    }
    if (message.research && typeof message.research === "object") return researchMessage(node, message, live);
    if (message.thinking) node.append(thinkingBlock(message, live));
    { const strip = picturesStrip(message); if (strip) node.append(strip); }
    if (message.text || !live || message.questions?.length) node.append(...replyParts(message, live));
    for (const file of Array.isArray(message.files) ? message.files : []) node.append(fileCard(message, file));
    for (const card of Array.isArray(message.actions) ? message.actions : []) node.append(actionCard(message, card, live));
    const doing = live && state.searching[message.id];
    if (doing) node.append(el("div", "cd-working cd-activity", doing.kind === "looking"
      ? `Looking at the image with ${doing.text}…` : doing.kind === "plugin" ? `Using ${doing.text}…` : doing.kind === "making" ? `Making ${doing.text || "the file"}…` : doing.kind === "compacting"
      ? "Summarizing earlier messages to fit the context window…" : `Searching the web for “${doing.text}”…`));
    else if (live && !message.text && !message.thinking) node.append(el("div", "cd-working", "Thinking…"));
    if (message.partial) node.append(el("p", "cd-end", "This reply is too long to show in full here."));
    if (!live) { const found = sourcesBlock(message); if (found) node.append(found); }
    if (!live) { const kept = memoryNote(message); if (kept) node.append(kept); }
    const end = endNote(message);
    if (end) node.append(end);
    const next = !live ? followupsNode(message) : null;
    if (!live && (message.text || message.versions)) {
      const actions = el("div", "cd-actions");
      const versions = versionsControl(message);
      if (versions) actions.append(versions);
      actions.append(action("copy", "Copy", () => vscode.postMessage({ type: "copy", text: message.text || "" })));
      const again = action("refresh", "Try again", () => {
        vscode.postMessage({ type: "regenerate", messageId: message.id, model: modelPick.value || "",
                             thinking: thinkingPick.value || "", search: searchMode() });
        state.busy = true; controls();
      });
      actions.append(idleOnly(again));
      const branch = branchAction(message);
      if (branch) actions.append(branch);
      if (message.model) actions.append(el("span", "cd-meta", String(message.model)));
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
    state.lastSent = { text, research: false, pending: [], searchFirst: state.searchFirst, followup: true };
    searchFirst(false);
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
    $("cd-ring-fill").style.strokeDasharray = `${(share * 50.27).toFixed(2)} 50.27`;
    button.dataset.level = share >= 0.85 ? "high" : share >= 0.7 ? "mid" : "low";
    button.title = `Context: ${c.used.toLocaleString()} of ${c.window.toLocaleString()} tokens`;
    button.setAttribute("aria-label", `Context window: ${percent}% used. Show details`);
    if (!$("cd-context-pop").hidden) popover();
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
    const actions = el("div", "cd-edit-actions"); actions.append(compact, carry);
    pop.replaceChildren(
      el("h3", "", `${Math.round(share * 100)}% of the context window`),
      el("p", "cd-pop-lead", `${c.used.toLocaleString()} of ${c.window.toLocaleString()} tokens, ${c.source === "reported" ? "as the model counted them" : "estimated"}.`),
      ...Object.entries(names).filter(([key]) => parts[key]).map(([key, label]) => line(label, Number(parts[key]).toLocaleString())),
      el("p", "cd-pop-note", `Window: ${presets[c.preset] || c.preset} (Settings → ChatDGC)` + (c.limit ? `. This model can take up to ${c.limit.toLocaleString()}.` : ".")
        + " Near the limit, older messages are summarized and the recent ones kept word for word."),
      ...(why ? [why] : []), actions);
  }
  $("cd-context").addEventListener("click", () => {
    const pop = $("cd-context-pop");
    pop.hidden = !pop.hidden;
    $("cd-context").setAttribute("aria-expanded", String(!pop.hidden));
    if (!pop.hidden) popover();
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest?.("#cd-context, #cd-context-pop")) { $("cd-context-pop").hidden = true; $("cd-context").setAttribute("aria-expanded", "false"); }
  });
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
    if (state.compacting) nodes.push(el("div", "cd-working cd-activity", "Summarizing earlier messages to fit the context window…"));
    log.replaceChildren(...nodes);
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
    $("cd-empty").replaceChildren(page ? projectPage() : el("h2", "", "What can I help with?"));
    $("cd-title").textContent = page ? projectOf(state.conversation).name : state.conversation?.title || "New chat";
    crumb();
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
        // A field you're typing in (marked data-keep) keeps the keys and the caret: research redraws as it goes.
        const typing = old && old.contains(document.activeElement) ? document.activeElement : null;
        const key = typing?.dataset?.keep;
        const caret = key && typeof typing.selectionStart === "number" ? [typing.selectionStart, typing.selectionEnd] : null;
        // The pictures, unchanged, stay the same nodes: a streaming reply redraws every frame, and a picture
        // drawn again would flicker.
        const strip = old?.querySelector(".cd-pictures"), stripNow = fresh.querySelector(".cd-pictures");
        if (strip && stripNow && strip.dataset.key === stripNow.dataset.key) stripNow.replaceWith(strip);
        if (old) old.replaceWith(fresh); else log.append(fresh);
        const twin = key ? fresh.querySelector(`[data-keep="${CSS.escape(key)}"]`) : null;
        if (twin) { twin.focus(); if (caret) twin.setSelectionRange(caret[0], caret[1]); }
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
    for (const button of document.querySelectorAll("[data-while-idle]")) {
      button.disabled = state.busy || state.compacting || button.dataset.never === "1";
    }
    const text = input.value;
    send.hidden = state.busy;
    stop.hidden = !state.busy;
    send.disabled = (!text.trim() && !state.pending.length) || !state.conversation || !!state.unavailable || state.compacting;
    input.disabled = !!state.unavailable;
    const fresh = !state.conversation || (!state.messages.length && !state.earlier);
    // A chat carried over isn't thrown away, and a project's chat is kept: neither can be temporary.
    $("cd-temp-toggle").hidden = !fresh || !!state.conversation?.carried || !!state.conversation?.project;
    const project = isProjectPage() ? projectOf(state.conversation) : null;
    input.placeholder = project ? `New chat in ${project.name}` : "Ask anything";
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
    if (state.research) {
      if (state.pending.length) { showNotice("Deep research reads the web: send files without it, or turn it off.", "info"); return; }
      if (!text.trim()) return;
      vscode.postMessage({ type: "research", text, model: modelPick.value || "", thinking: thinkingPick.value || "" });
      state.lastSent = { text, research: true, pending: [] };
      input.value = ""; grow(); saveDraft();
      researchMode(false);
      state.planAsked = true; state.busy = true;
      hideNotice(); controls();
      return;
    }
    vscode.postMessage({ type: "send", text, model: modelPick.value || "", thinking: thinkingPick.value || "",
                         search: searchMode(),
                         ...(state.pending.length ? { attachments: state.pending.map(({ kind, path, name, data, text: pasted, conversation_id, project_id, attachment_id }) =>
                           ({ kind, name, ...(path ? { path } : {}), ...(data ? { data } : {}), ...(pasted ? { text: pasted } : {}),
                              ...(kind === "library" ? { ...(conversation_id ? { conversation_id } : { project_id }), attachment_id } : {}) })) } : {}) });
    state.lastSent = { text, research: false, pending: state.pending, searchFirst: state.searchFirst };
    searchFirst(false);
    input.value = ""; grow(); saveDraft();
    state.pending = []; chips();
    state.busy = true;        // until the turn says otherwise: no second send in the meantime
    hideNotice();
    controls();
  }
  const researchToggle = $("cd-research");
  /** Deep research for the next message: a plan first, then the reading. Off again once it's sent. */
  function researchMode(on) {
    state.research = !!on;
    researchToggle.setAttribute("aria-pressed", String(state.research));
    input.placeholder = state.research ? "What should I research?" : "Ask anything";
    webToggle.hidden = state.research;                 // research always reads the web
  }
  const webToggle = $("cd-websearch");
  /** Search the web first, for the next message. */
  function searchFirst(on) {
    state.searchFirst = !!on;
    webToggle.setAttribute("aria-pressed", String(state.searchFirst));
  }
  webToggle.addEventListener("click", () => { searchFirst(!state.searchFirst); input.focus(); });
  researchToggle.addEventListener("click", () => { researchMode(!state.research); input.focus(); });
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
    const source = e.target.closest?.(".cd-cite[data-url]");
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
        // keep: the same chat shown again (a new version, or another one chosen): what you're typing and the
        // model and thinking you picked stay, and so does where you were reading.
        const keep = msg.keep === true && state.conversation?.id === msg.conversation?.id;
        if (state.conversation?.id !== msg.conversation?.id) state.picks = {};
        state.conversation = msg.conversation || null;
        state.messages = Array.isArray(msg.messages) ? msg.messages : [];
        state.earlier = Number(msg.earlier) || 0;
        state.busy = msg.busy === true;
        state.replyId = msg.replyId || "";
        state.opened = true;
        state.editing = "";
        state.editingSummary = false;
        if (!keep) { state.compacting = false; state.context = null; meter(); }
        if (!keep) { state.model = ""; state.thinking = ""; }
        state.unavailable = "";
        if (msg.project && typeof msg.project === "object") upsertProject(msg.project);
        $("cd-title").textContent = state.conversation?.title || "New chat";
        vscode.setState({ ...(vscode.getState() || {}), conversation: state.conversation?.id || "",
                          temporary: !!state.conversation?.temporary });
        if (!keep) restoreDraft();
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
        return;
      }
      case "turn":
        if (msg.state === "started") {
          state.busy = true; state.replyId = msg.replyId || ""; state.lastSent = null;
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
        return;
      case "activity":
        if (msg.kind === "compacting" && msg.messageId !== state.replyId) {
          state.compacting = true; render(); controls();        // Compact now, or a summary for a new chat
          return;
        }
        if (["searching", "looking", "compacting", "plugin", "making"].includes(msg.kind) && msg.messageId) {
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
        if (at >= 0) state.messages[at] = message; else state.messages.push(message);
        if (message.role === "user") { pinned = true; render(); } else update(message.id);
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
      case "error":
        if (state.compacting) { state.compacting = false; render(); }
        if (Object.keys(state.cardBusy).length) {        // a card's choice that was refused: its buttons come back
          const busy = Object.keys(state.cardBusy); state.cardBusy = {};
          for (const m of state.messages) if ((m.actions || []).some((c) => busy.includes(c.id))) update(m.id);
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
          input.value = state.lastSent.text; grow(); saveDraft();
          state.pending = state.lastSent.pending; chips();
          researchMode(state.lastSent.research);
          searchFirst(!!state.lastSent.searchFirst);
        }
        if (state.busy && !state.replyId) state.planAsked = false;
        state.lastSent = null;
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
  function restoreDraft() { const saved = (vscode.getState() || {})[draftKey()]; input.value = typeof saved === "string" ? saved : ""; grow(); }

  // ---- keyboard shortcuts (ChatGPT's): Ctrl on Windows and Linux, Cmd on a Mac
  const MAC = /Mac/i.test(navigator.platform || navigator.userAgent || "");
  const MOD = MAC ? "⌘" : "Ctrl";
  const SHORTCUTS = [
    [[MOD, "Shift", "O"], "New chat"],
    [[MOD, "Shift", "C"], "Copy the last reply"],
    [[MOD, "Shift", ";"], "Copy the last code block"],
    [["Shift", "Esc"], "Focus the message box"],
    [["Esc"], "Stop the reply"],
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
      if (reply) vscode.postMessage({ type: "copy", text: reply.text });
    } else if (mod && e.shiftKey && e.code === "Semicolon") {
      const blocks = [...log.querySelectorAll(".cd-assistant pre.code .copy[data-c]")];
      const last = blocks[blocks.length - 1];
      if (last) vscode.postMessage({ type: "copy", text: decodeURIComponent(last.dataset.c || "") });
    } else if (e.shiftKey && e.key === "Escape") input.focus();
    else if (mod && !e.shiftKey && (e.code === "Slash" || e.key === "/")) toggleKeys();
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  for (const [value, label] of Object.entries(LABEL)) { const option = thinkingPick.querySelector(`option[value="${value}"]`); if (option) option.textContent = label; }
  controls();
  vscode.postMessage({ type: "ready" });
})();
