// window.DgcMcpApps: a plugin's own card in the chat (MCP Apps, the open MCP extension io.modelcontextprotocol/ui,
// stable revision 2026-01-26), drawn the same way in a Work chat (main.js), a ChatDGC chat (chatdgc.js), a Pip's chat
// (src/pipsClient.js) and a card's own editor tab (src/mcpApps.ts).
//
// The card is the plugin's page, in a sandboxed frame at the address DGC's backend serves it from (one loopback origin
// per plugin, behind the card's own token, with a CSP built only from the domains the page declared). It has no way to
// this page's scripts, state or the editor's API: it talks to DGC only in MCP Apps' JSON-RPC over postMessage, checked
// by event.source and by the origin of the address it was given (a frame that navigates elsewhere keeps its window, so
// the page it went to hears nothing and asks nothing in the card's name), and every request goes through the page to
// the extension host and on to the backend, which decides it (dgc/mcp_apps.py). A message any child frame sends never
// reaches the page's own handlers.
//
// DgcMcpApps.setup({post, surface}) once per page: post(msg) sends {type: "mcpApp", op, ...} to the extension host.
// DgcMcpApps.card(event, {sendMessage, display}) is the card's element (`mcp_app_card` fields); sendMessage(text) sends
// the user's message (a card's ui/message, already labelled with its plugin).
// DgcMcpApps.event(ev) takes mcp_app_reply / mcp_app_resource; DgcMcpApps.host(msg) the extension host's
// own answers (mcpAppDone, mcpAppSend, mcpAppUrl); DgcMcpApps.park() / adopt(root) keep live frames across a redraw.
(function () {
  "use strict";
  if (window.DgcMcpApps) return;
  const PROTOCOL = "2026-01-26";
  const CARD_ID = /^app_[0-9a-f]{24}$/;
  const MIN_HEIGHT = 80, MAX_INLINE = 720, START_HEIGHT = 220, START_WAIT_MS = 15000, LOAD_WAIT_MS = 20000;
  const MAX_REQUEST_CHARS = 256 * 1024;
  let post = () => {};
  let pageSurface = "work";
  let seq = 0;
  const views = new Set();                  // every card frame drawn on this page
  const byWindow = new Map();               // a frame's window -> its view
  const waiting = new Map();                // our request id -> {view, rpc}
  const hostWaits = new Map();              // a host round trip's id -> resolve
  const resources = new Map();              // card id -> mcp_app_resource (a replayed card's page and whole result)
  const resourceWaits = new Map();          // card id -> [resolve]
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  };
  // Inline, so they draw wherever a card is (a Pip's chat is in a shadow root that the editor's icon font rules can't
  // reach): a card's window, a tab of its own, DGC's shield.
  const ICONS = {
    window: "M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12.5v-9zM3 6v6.5a.5.5 0 0 0 .5.5h9a.5.5 0 0 0 .5-.5V6H3zm0-1h10V3.5a.5.5 0 0 0-.5-.5h-9a.5.5 0 0 0-.5.5V5z",
    "link-external": "M9 2h5v5h-1V3.7L7.4 9.3l-.7-.7L12.3 3H9V2zM3.5 4H7v1H3.5a.5.5 0 0 0-.5.5v7a.5.5 0 0 0 .5.5h7a.5.5 0 0 0 .5-.5V9h1v3.5a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 2 12.5v-7A1.5 1.5 0 0 1 3.5 4z",
    shield: "M8 1l5.5 2v4.6c0 3.2-2.3 6-5.5 7.4C4.8 13.6 2.5 10.8 2.5 7.6V3L8 1zm0 1.1L3.5 3.7v3.9c0 2.7 1.9 5.1 4.5 6.3 2.6-1.2 4.5-3.6 4.5-6.3V3.7L8 2.1z",
  };
  const glyph = (name) => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", `mcp-app-icon mcp-app-icon-${name}`);
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", ICONS[name] || ICONS.window);
    path.setAttribute("fill", "currentColor");
    path.setAttribute("fill-rule", "evenodd");
    svg.append(path);
    return svg;
  };
  const words = (value, limit = 200) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
  const nextId = (kind) => `mcpapp-${kind}-${Date.now().toString(36)}-${(++seq).toString(36)}`;
  const plain = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};

  // ---- no child frame speaks for the extension host ------------------------------------------------------------
  // Capture runs before every page handler at the window. A card (or anything a card frames) can post this window a
  // message shaped like the host's ({type: "event", ...}): a message from any frame inside this page never reaches the
  // page's own handlers. (A webview's window.parent is the page itself, so the host can't be told apart by it: what
  // comes from inside the page is.)
  function fromInside(source) {
    let w = source;
    for (let depth = 0; depth < 12 && w && w !== window; depth++) {
      // A card's frame (wherever it is drawn: a Pip's chat is inside a shadow root), or any other frame of this page.
      for (const view of views) if (view.frame.contentWindow === w) return true;
      for (const frame of document.getElementsByTagName("iframe")) if (frame.contentWindow === w) return true;
      let up = null;
      try { up = w.parent; } catch { return false; }
      if (!up || up === w) return false;
      w = up;
    }
    return false;
  }
  window.addEventListener("message", (event) => {
    const source = event.source;
    if (!source || source === window || !fromInside(source)) return;
    event.stopImmediatePropagation();
    let view = byWindow.get(source);
    if (!view) {
      // A frame moved in the page (an engine without moveBefore) is a new window, before its load event.
      view = [...views].find((v) => v.frame.contentWindow === source);
      if (view) byWindow.set(source, view);
    }
    // Only the card's own page: a frame keeps its window when it navigates, so another page in it has another origin.
    if (view && view.origin && event.origin === view.origin) view.receive(event.data);
  }, true);

  // ---- the editor's look, for the card ---------------------------------------------------------------------------
  function theme() {
    const c = document.body.classList;
    return c.contains("vscode-light") || c.contains("vscode-high-contrast-light") ? "light" : "dark";
  }
  const STYLE_MAP = {
    "--color-background-primary": ["--vscode-editor-background", "--vscode-sideBar-background"],
    "--color-background-secondary": ["--vscode-sideBar-background", "--vscode-editorWidget-background"],
    "--color-background-tertiary": ["--vscode-input-background", "--vscode-editorWidget-background"],
    "--color-background-inverse": ["--vscode-editor-foreground"],
    "--color-background-ghost": ["--vscode-toolbar-hoverBackground"],
    "--color-background-info": ["--vscode-inputValidation-infoBackground"],
    "--color-background-danger": ["--vscode-inputValidation-errorBackground"],
    "--color-background-success": ["--vscode-diffEditor-insertedTextBackground"],
    "--color-background-warning": ["--vscode-inputValidation-warningBackground"],
    "--color-background-disabled": ["--vscode-input-background"],
    "--color-text-primary": ["--vscode-foreground", "--vscode-editor-foreground"],
    "--color-text-secondary": ["--vscode-descriptionForeground"],
    "--color-text-tertiary": ["--vscode-disabledForeground", "--vscode-descriptionForeground"],
    "--color-text-inverse": ["--vscode-editor-background"],
    "--color-text-info": ["--vscode-textLink-foreground"],
    "--color-text-danger": ["--vscode-errorForeground"],
    "--color-text-success": ["--vscode-testing-iconPassed"],
    "--color-text-warning": ["--vscode-editorWarning-foreground"],
    "--color-text-disabled": ["--vscode-disabledForeground"],
    "--color-text-ghost": ["--vscode-descriptionForeground"],
    "--color-border-primary": ["--vscode-panel-border", "--vscode-widget-border"],
    "--color-border-secondary": ["--vscode-widget-border", "--vscode-panel-border"],
    "--color-border-tertiary": ["--vscode-input-border", "--vscode-panel-border"],
    "--color-border-inverse": ["--vscode-editor-foreground"],
    "--color-border-info": ["--vscode-inputValidation-infoBorder"],
    "--color-border-danger": ["--vscode-inputValidation-errorBorder"],
    "--color-border-success": ["--vscode-testing-iconPassed"],
    "--color-border-warning": ["--vscode-inputValidation-warningBorder"],
    "--color-ring-primary": ["--vscode-focusBorder"],
    "--color-ring-secondary": ["--vscode-focusBorder"],
    "--color-ring-info": ["--vscode-focusBorder"],
    "--color-ring-danger": ["--vscode-inputValidation-errorBorder"],
    "--color-ring-success": ["--vscode-testing-iconPassed"],
    "--color-ring-warning": ["--vscode-inputValidation-warningBorder"],
    "--font-sans": ["--vscode-font-family"],
    "--font-mono": ["--vscode-editor-font-family"],
    "--font-weight-normal": ["--vscode-font-weight"],
    "--font-text-md-size": ["--vscode-font-size"],
  };
  function styles() {
    const css = getComputedStyle(document.documentElement);
    const variables = {};
    for (const [name, sources] of Object.entries(STYLE_MAP)) {
      for (const source of sources) {
        const value = css.getPropertyValue(source).trim();
        if (value && value.length < 200 && !/[;{}<>]/.test(value)) { variables[name] = value; break; }
      }
    }
    Object.assign(variables, {
      "--font-weight-medium": "500", "--font-weight-semibold": "600", "--font-weight-bold": "700",
      "--font-text-xs-size": "11px", "--font-text-sm-size": "12px", "--font-text-lg-size": "15px",
      "--font-text-sm-line-height": "1.4", "--font-text-md-line-height": "1.5",
      "--border-radius-xs": "2px", "--border-radius-sm": "4px", "--border-radius-md": "6px", "--border-radius-lg": "8px",
      "--border-radius-xl": "12px", "--border-radius-full": "9999px", "--border-width-regular": "1px",
    });
    return { variables };
  }

  // ---- one card, one frame ---------------------------------------------------------------------------------------
  class View {
    constructor(card, options) {
      this.card = card;
      this.options = options || {};
      this.display = this.options.display === "fullscreen" ? "fullscreen" : "inline";
      this.ready = false;
      this.origin = "";                     // the origin of the address the frame was given: the only one it speaks for
      this.data = card.html !== undefined ? { tool_input: card.tool_input, tool_result: card.tool_result } : null;
      this.node = el("section", "mcp-app");
      this.node.dataset.cardId = card.card_id;
      this.node.dataset.display = this.display;
      if (card.prefers_border === false) this.node.dataset.border = "none";
      this.node.setAttribute("aria-label", `${card.plugin || card.server}'s card`);
      const head = el("div", "mcp-app-head");
      const name = el("span", "mcp-app-name");
      name.append(glyph("window"), el("strong", "", card.plugin || card.server),
                  el("span", "mcp-app-tool", words(card.tool_info?.title || card.tool_info?.annotations?.title || card.tool, 80)));
      head.append(name);
      if (this.display === "inline") {
        this.collapse = el("button", "mcp-app-btn mcp-app-collapse");
        this.collapse.type = "button";
        this.collapse.textContent = "Collapse";
        this.collapse.setAttribute("aria-label", `Collapse ${card.plugin || card.server}'s card`);
        this.collapse.setAttribute("aria-expanded", "true");
        this.collapse.addEventListener("click", () => this.setCollapsed(this.collapse.getAttribute("aria-expanded") === "true"));
        head.append(this.collapse);
      }
      if (this.display === "inline") {
        const open = el("button", "mcp-app-btn");
        open.type = "button";
        open.title = "Open this card in a tab";
        open.setAttribute("aria-label", `Open ${card.plugin || card.server}'s card in a tab`);
        open.append(glyph("link-external"));
        open.addEventListener("click", () => this.openTab());
        head.append(open);
      }
      this.asks = el("div", "mcp-app-asks");
      this.box = el("div", "mcp-app-frame");
      this.loading = el("div", "mcp-app-loading", `Opening ${card.plugin || card.server}'s card…`);
      this.frame = el("iframe");
      this.frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
      this.frame.setAttribute("referrerpolicy", "no-referrer");
      this.frame.setAttribute("title", `${card.plugin || card.server}: ${card.tool}`);
      const allow = [];
      const perms = plain(card.permissions);
      if (perms.clipboardWrite) allow.push("clipboard-write");
      if (perms.camera) allow.push("camera");
      if (perms.microphone) allow.push("microphone");
      if (perms.geolocation) allow.push("geolocation");
      if (allow.length) this.frame.setAttribute("allow", allow.join("; "));
      this.frame.style.height = this.display === "inline" ? `${START_HEIGHT}px` : "100%";
      this.box.append(this.loading, this.frame);
      // Said under the card (never over it) when its page loaded but never started: a blank box otherwise says nothing.
      this.note = el("p", "mcp-app-note");
      this.note.hidden = true;
      this.node.append(head, this.asks, this.box, this.note);
      this.node._mcpAppView = this;
      views.add(this);
      this.load();
    }

    setCollapsed(collapsed) {
      if (!this.collapse) return;
      this.node.dataset.collapsed = collapsed ? "true" : "false";
      this.collapse.textContent = collapsed ? "Expand" : "Collapse";
      this.collapse.setAttribute("aria-expanded", collapsed ? "false" : "true");
      this.collapse.setAttribute("aria-label", `${collapsed ? "Expand" : "Collapse"} ${this.card.plugin || this.card.server}'s card`);
    }

    load() {
      if (this.card.tool_result?.isError === true) {
        this.loading.hidden = true;
        this.frame.hidden = true;
        this.node.dataset.failed = "true";
        this.note.textContent = `${this.card.plugin || this.card.server} couldn't show this card because its request failed.`;
        this.note.hidden = false;
        return;
      }
      const url = String(this.card.url || "");
      if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+\/card\/app_[0-9a-f]{24}\?t=[A-Za-z0-9_-]+$/.test(url)) {
        this.loading.textContent = "This card can't be shown here.";
        return;
      }
      // The host gives the address this window reaches (a remote window's is forwarded to the backend's machine).
      hostRound("url", { card_id: this.card.card_id, url }).then((answer) => {
        const shown = typeof answer?.url === "string" && answer.url ? answer.url : url;
        try { this.origin = new URL(shown).origin; } catch { this.origin = ""; }
        this.frame.src = shown;
        this.watchWindow();
        // A vendor page may keep the navigation pending indefinitely. The load event never fires in that case,
        // so the normal "didn't start" timer cannot replace the spinner.
        this.loadTimer = setTimeout(() => this.notLoaded(), LOAD_WAIT_MS);
      });
      if (!this.data) fetchResource(this.card.card_id).then((res) => {
        this.data = res ? { tool_input: res.tool_input, tool_result: res.tool_result } :
          { tool_input: this.card.tool_input, tool_result: this.card.tool_result };
        if (this.ready) this.sendTool();
      });
    }

    watchWindow() {
      // A frame's window exists once it is in the document; it is the same object across its navigations.
      this.retake();
      this.frame.addEventListener("load", () => {
        clearTimeout(this.loadTimer);
        this.retake();
        this.loading.hidden = true;
        clearTimeout(this.startTimer);
        this.startTimer = setTimeout(() => this.notStarted(), START_WAIT_MS);
      });
    }
    notStarted() {
      if (this.started || !this.node.isConnected) return;
      const who = this.card.plugin || this.card.server;
      this.node.dataset.failed = "true";
      this.note.textContent = `${who}'s card didn't start. Its page may need a site it didn't list, or ${who} may be down.`;
      this.note.hidden = false;
    }
    notLoaded() {
      if (this.started || !this.node.isConnected) return;
      this.loading.hidden = true;
      this.node.dataset.failed = "true";
      this.note.textContent = `${this.card.plugin || this.card.server}'s card took too long to open. Its server may be busy.`;
      this.note.hidden = false;
    }
    retake() { if (this.frame.contentWindow) byWindow.set(this.frame.contentWindow, this); }

    send(message) {
      // To the card's origin only: a page the frame navigated to elsewhere never hears the card's input or result.
      if (!this.origin) return;
      try { this.frame.contentWindow?.postMessage(message, this.origin); } catch { /* a closed frame */ }
    }
    reply(id, result) { if (id !== undefined && id !== null) this.send({ jsonrpc: "2.0", id, result: result || {} }); }
    fail(id, error) {
      if (id !== undefined && id !== null)
        this.send({ jsonrpc: "2.0", id, error: { code: Number(error?.code) || -32000, message: words(error?.message || "DGC refused it", 400) } });
    }
    notify(method, params) { this.send({ jsonrpc: "2.0", method, params: params || {} }); }

    context() {
      const width = Math.max(200, Math.round(this.box.clientWidth || 600));
      const dimensions = this.display === "inline" ? { width, maxHeight: MAX_INLINE }
        : { width, height: Math.max(200, Math.round(this.box.clientHeight || 600)) };
      let timeZone = "UTC";
      try { timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { /* the default */ }
      return {
        theme: theme(), styles: styles(), displayMode: this.display, availableDisplayModes: ["inline", "fullscreen"],
        locale: navigator.language || "en-US", timeZone, platform: "desktop", userAgent: "DGC",
        containerDimensions: dimensions, deviceCapabilities: { touch: false, hover: true },
        toolInfo: { ...(this.card.call_id ? { id: this.card.call_id } : {}), tool: plain(this.card.tool_info) },
      };
    }

    sendTool() {
      if (this.toolSent || !this.data) return;
      this.toolSent = true;
      this.notify("ui/notifications/tool-input", { arguments: plain(this.data.tool_input) });
      this.notify("ui/notifications/tool-result", plain(this.data.tool_result));
    }

    receive(m) {
      if (!m || typeof m !== "object" || m.jsonrpc !== "2.0" || typeof m.method !== "string" || m.method.length > 100) return;
      const params = plain(m.params);
      switch (m.method) {
        case "ui/initialize":
          this.started = true;
          clearTimeout(this.loadTimer);
          delete this.node.dataset.failed;
          clearTimeout(this.startTimer);
          if (this.note) this.note.hidden = true;
          this.toolSent = false;            // a page that (re)started hears its tool again
          this.reply(m.id, {
            protocolVersion: PROTOCOL, hostInfo: { name: "DGC", version: "0.51" },
            hostCapabilities: {
              openLinks: {}, downloadFile: {}, serverTools: {}, serverResources: {}, logging: {},
              updateModelContext: { text: {}, structuredContent: {} }, message: { text: {} },
              sandbox: { csp: plain(this.card.csp), permissions: plain(this.card.permissions) },
            },
            hostContext: this.context(),
          });
          this.loading.hidden = true;
          return;
        case "ui/notifications/initialized":
          this.ready = true;
          this.sendTool();
          return;
        case "ui/notifications/size-changed": {
          const height = Number(params.height);
          if (this.display === "inline" && Number.isFinite(height) && height > 0)
            this.frame.style.height = `${Math.min(MAX_INLINE, Math.max(MIN_HEIGHT, Math.ceil(height)))}px`;
          return;
        }
        case "tools/call": case "resources/read": {
          let size = 0;
          try { size = JSON.stringify(params).length; } catch { size = Infinity; }
          if (size > MAX_REQUEST_CHARS) return this.fail(m.id, { code: -32602, message: "That request is too large." });
          const id = nextId("call");
          if (m.id !== undefined && m.id !== null) waiting.set(id, { view: this, rpc: m.id, at: Date.now() });
          post({ type: "mcpApp", op: "call", card_id: this.card.card_id, request_id: id, method: m.method, params });
          return;
        }
        case "ui/open-link": {
          const url = String(params.url || "");
          hostRound("link", { card_id: this.card.card_id, url, plugin: this.card.plugin, hosts: this.card.link_hosts || [] })
            .then((answer) => this.reply(m.id, answer?.ok ? {} : { isError: true }));
          return;
        }
        case "ui/download-file":
          hostRound("download", { card_id: this.card.card_id, plugin: this.card.plugin, contents: Array.isArray(params.contents) ? params.contents.slice(0, 4) : [] })
            .then((answer) => this.reply(m.id, answer?.ok ? {} : { isError: true }));
          return;
        case "ui/message": {
          const content = Array.isArray(params.content) ? params.content : [params.content];
          const text = content.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n").trim();
          if (!text || typeof this.options.sendMessage !== "function") return this.reply(m.id, { isError: true });
          const labelled = `From ${this.card.plugin || this.card.server}'s card: ${text.slice(0, 8000)}`;
          Promise.resolve(this.options.sendMessage(labelled, this.card)).then((ok) => this.reply(m.id, ok === false ? { isError: true } : {}),
                                                                          () => this.reply(m.id, { isError: true }));
          return;
        }
        case "ui/update-model-context":
          post({ type: "mcpApp", op: "context", card_id: this.card.card_id,
                 content: Array.isArray(params.content) ? params.content.slice(0, 32) : [],
                 structured_content: plain(params.structuredContent) });
          this.reply(m.id, {});
          return;
        case "ui/request-display-mode": {
          const mode = String(params.mode || "");
          if (mode === "fullscreen" && this.display === "inline") this.openTab();
          if (mode === "inline" && this.display === "fullscreen") {
            // The card in its own tab asks to go back into the chat: the tab closes, the chat's card stays.
            this.reply(m.id, { mode: "inline" });
            post({ type: "mcpApp", op: "closeTab", card_id: this.card.card_id });
            return;
          }
          this.reply(m.id, { mode: this.display });
          return;
        }
        case "ping": this.reply(m.id, {}); return;
        case "notifications/message": case "ui/notifications/request-teardown": return;
        default:
          if (m.id !== undefined) this.fail(m.id, { code: -32601, message: `DGC doesn't handle ${m.method}` });
      }
    }

    openTab() {
      post({ type: "mcpApp", op: "tab", card_id: this.card.card_id, card: this.card });
    }

    themeChanged() {
      if (this.ready) this.notify("ui/notifications/host-context-changed", { theme: theme(), styles: styles() });
    }

    ask(ev) {
      if (this.asks.querySelector(`[data-ask-id="${ev.ask_id}"]`)) return;
      const box = el("div", "mcp-app-ask");
      box.dataset.askId = ev.ask_id;
      box.setAttribute("role", "group");
      box.setAttribute("aria-label", `${ev.plugin}'s card asks to run ${ev.title}`);
      const line = el("p", "mcp-app-ask-line");
      line.append(glyph("shield"), el("span", "", `${ev.plugin}'s card wants to run `), el("strong", "", ev.title || ev.tool));
      const args = plain(ev.arguments);
      const detail = el("details", "mcp-app-ask-args");
      if (Object.keys(args).length) {
        detail.append(el("summary", "", "What it sends"), el("pre", "", JSON.stringify(args, null, 1).slice(0, 4000)));
      }
      const row = el("div", "mcp-app-ask-actions");
      const choose = (choice) => {
        box.remove();
        post({ type: "mcpApp", op: "answer", card_id: this.card.card_id, ask_id: ev.ask_id, choice, request_id: ev.request_id });
      };
      const button = (label, choice, primary) => {
        const b = el("button", primary ? "mcp-app-ask-btn primary" : "mcp-app-ask-btn", label);
        b.type = "button";
        b.addEventListener("click", () => choose(choice));
        return b;
      };
      row.append(button("Allow", "once", true));
      if (ev.always) row.append(button("Always allow", "always", false));
      row.append(button("Don't", "deny", false));
      box.append(line);
      if (Object.keys(args).length) box.append(detail);
      if (ev.money) box.append(el("p", "mcp-app-ask-note", "This plugin can move money, so it asks every time."));
      box.append(row);
      this.asks.append(box);
    }

    gone() {
      clearTimeout(this.loadTimer);
      clearTimeout(this.startTimer);
      views.delete(this);
      for (const [win, view] of byWindow) if (view === this) byWindow.delete(win);
    }
  }

  function fetchResource(cardId) {
    if (resources.has(cardId)) return Promise.resolve(resources.get(cardId));
    return new Promise((resolve) => {
      const list = resourceWaits.get(cardId);
      if (list) { list.push(resolve); return; }
      resourceWaits.set(cardId, [resolve]);
      post({ type: "mcpApp", op: "get", card_id: cardId, request_id: nextId("get") });
      setTimeout(() => { const late = resourceWaits.get(cardId); if (late) { resourceWaits.delete(cardId); late.forEach((r) => r(null)); } }, 20000);
    });
  }

  function hostRound(op, fields) {
    return new Promise((resolve) => {
      const id = nextId(op);
      hostWaits.set(id, resolve);
      post({ type: "mcpApp", op, id, ...fields });
      setTimeout(() => { if (hostWaits.delete(id)) resolve(null); }, op === "url" ? 8000 : 300000);
    });
  }

  // The editor's theme changed: every card hears it.
  new MutationObserver(() => { for (const view of views) view.themeChanged(); })
    .observe(document.body, { attributes: true, attributeFilter: ["class"] });
  // A frame that never answers is not waited on forever.
  setInterval(() => {
    const now = Date.now();
    for (const [id, wait] of waiting) {
      if (now - wait.at > 600000) { waiting.delete(id); wait.view.fail(wait.rpc, { message: "DGC didn't answer in time." }); }
    }
    for (const view of views) if (!view.node.isConnected && !parked.has(view)) view.gone();
  }, 30000);

  // ---- a redraw keeps a live frame: parked in a holder that stays in the document, then moved into its new slot ----
  // (moveBefore keeps a frame's page as it is; an older engine reloads it, and the card starts over from its result).
  const parked = new Set();
  let holder = null;
  const move = (parent, node, before = null) => {
    if (typeof parent.moveBefore === "function" && node.isConnected && parent.isConnected) {
      try { parent.moveBefore(node, before); return; } catch { /* moved the old way below */ }
    }
    parent.insertBefore(node, before);
  };
  function park() {
    if (!holder) { holder = el("div", "mcp-app-parking"); holder.hidden = true; document.body.append(holder); }
    for (const view of views) {
      if (view.node.isConnected && view.node.parentNode !== holder) { parked.add(view); move(holder, view.node); }
    }
  }
  const seen = new Map();                   // card id -> its mcp_app_card, as this page heard it
  /** Every empty card slot under `root` gets its card: the live frame it had (parked or taken out by a redraw), or a
   *  new one from the card this page heard, or from the card's own record (mcp_app_get) for one it only has the id of. */
  function fill(root, options) {
    for (const slot of (root || document).querySelectorAll(".mcp-app-slot[data-card-id]")) {
      if (slot.firstElementChild) continue;
      const id = slot.dataset.cardId;
      if (!CARD_ID.test(id)) continue;
      const inline = [...views].filter((v) => v.card.card_id === id && v.display === "inline");
      const free = inline.find((v) => parked.has(v) || !v.node.isConnected);
      if (free) { parked.delete(free); move(slot, free.node); free.retake(); continue; }
      if (inline.some((v) => v.node.isConnected)) continue;           // drawn elsewhere on this page already
      const known = seen.get(id);
      if (known) { slot.append(new View(known, options).node); continue; }
      fetchResource(id).then((res) => {
        if (res && slot.isConnected && !slot.firstElementChild && ![...views].some((v) => v.card.card_id === id && v.node.isConnected))
          slot.append(new View(res, options).node);
      });
    }
  }
  function adopt(root, options) { fill(root, options); }

  window.DgcMcpApps = {
    setup(options) {
      if (typeof options?.post === "function") post = options.post;
      if (options?.surface) pageSurface = options.surface;
    },
    /** The card's element, for `mcp_app_card` (live or replayed). The same card drawn twice is one frame. */
    card(event, options) {
      if (!event || !CARD_ID.test(String(event.card_id || ""))) return el("div");
      const shown = [...views].find((v) => v.card.card_id === event.card_id && v.display === "inline" && (options?.display || "inline") === "inline");
      if (shown && !shown.node.isConnected) return shown.node;
      if (shown && shown.node.isConnected && !options?.again) return el("div", "mcp-app-dup");
      return new View(event, options).node;
    },
    /** A placeholder a page that redraws its markup can put where a card goes; adopt() fills it. */
    slot(cardId) { const s = el("div", "mcp-app-slot"); s.dataset.cardId = String(cardId || ""); return s; },
    has(cardId) { return [...views].some((v) => v.card.card_id === cardId); },
    /** A card this page heard of live (mcp_app_card), kept for the slot a redraw puts it in. */
    remember(event) { if (event && CARD_ID.test(String(event.card_id || ""))) { seen.set(event.card_id, event); if (seen.size > 256) seen.delete(seen.keys().next().value); } },
    park, adopt, fill,
    event(ev) {
      if (!ev || typeof ev !== "object") return false;
      if (ev.type === "mcp_app_reply") {
        const wait = waiting.get(ev.request_id);
        if (ev.ask && typeof ev.ask === "object") {
          // DGC's Allow card first: the request waits for the user's choice, then its outcome comes as another reply.
          const view = wait?.view || [...views].find((v) => v.card.card_id === ev.card_id && v.node.isConnected);
          if (view) view.ask({ ...ev.ask, request_id: ev.request_id });
          if (wait) wait.at = Date.now();
          return true;
        }
        if (!wait) return true;
        waiting.delete(ev.request_id);
        if (ev.error) wait.view.fail(wait.rpc, ev.error); else wait.view.reply(wait.rpc, ev.result || {});
        return true;
      }
      if (ev.type === "mcp_app_resource") {
        resources.set(ev.card_id, ev);
        const list = resourceWaits.get(ev.card_id) || [];
        resourceWaits.delete(ev.card_id);
        list.forEach((resolve) => resolve(ev));
        return true;
      }
      return false;
    },
    /** What the extension host answers on its own (a link, a download, a forwarded address, a message to send). */
    host(msg) {
      if (!msg || typeof msg !== "object") return false;
      if (msg.type === "mcpAppDone") {
        const resolve = hostWaits.get(msg.id);
        if (typeof resolve === "function") { hostWaits.delete(msg.id); resolve(msg); }
        return true;
      }
      if (msg.type === "mcpAppSend") {
        // A card in its own tab asked to send a message: this page's chat sends it.
        const view = [...views].find((v) => v.card.card_id === msg.card_id && typeof v.options.sendMessage === "function");
        if (view && typeof msg.text === "string") view.options.sendMessage(msg.text, view.card);
        return true;
      }
      return false;
    },
    surface() { return pageSurface; },
  };
})();
