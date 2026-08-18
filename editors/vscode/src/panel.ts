import * as vscode from "vscode";
import { DgcBackend, DgcEvent } from "./backend";

const MODES = [
  { id: "default", label: "$(shield) default", detail: "ask before writes and shell commands" },
  { id: "acceptEdits", label: "$(edit) acceptEdits", detail: "auto-approve file edits, ask before shell commands" },
  { id: "plan", label: "$(book) plan", detail: "read-only — research and propose a plan you approve" },
  { id: "auto", label: "$(zap) auto", detail: "full auto — approve everything (deny rules still apply)" },
];
const THINK = [
  { id: "off", detail: "no extra reasoning" },
  { id: "low", detail: "think briefly before acting" },
  { id: "medium", detail: "reason step by step; consider edge cases" },
  { id: "high", detail: "maximum depth (ultrathink)" },
];
const PROVIDERS: Record<string, { url: string; needsKey: boolean; label: string }> = {
  ollama: { url: "http://localhost:11434/v1", needsKey: false, label: "Ollama (local)" },
  llamacpp: { url: "http://localhost:8080/v1", needsKey: false, label: "llama.cpp (local)" },
  lmstudio: { url: "http://localhost:1234/v1", needsKey: false, label: "LM Studio (local)" },
  vllm: { url: "http://localhost:8000/v1", needsKey: false, label: "vLLM (local)" },
  openai: { url: "https://api.openai.com/v1", needsKey: true, label: "OpenAI" },
  openrouter: { url: "https://openrouter.ai/api/v1", needsKey: true, label: "OpenRouter" },
  groq: { url: "https://api.groq.com/openai/v1", needsKey: true, label: "Groq" },
  deepseek: { url: "https://api.deepseek.com/v1", needsKey: true, label: "DeepSeek" },
  together: { url: "https://api.together.xyz/v1", needsKey: true, label: "Together AI" },
  mistral: { url: "https://api.mistral.ai/v1", needsKey: true, label: "Mistral" },
};

export class DgcViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private backend?: DgcBackend;
  private state = { model: "", mode: "default", think: "off", baseUrl: "" };
  private _installPrompted = false;
  private sb: vscode.StatusBarItem;

  constructor(private readonly context: vscode.ExtensionContext) {
    // one status-bar item: `model · mode` (click to change model)
    this.sb = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.sb.command = "dgc.selectModel";
  }

  // ---- backend lifecycle ---------------------------------------------------
  private cwd(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  }

  /**
   * A compact `<editor-context>` block describing what the user is looking at:
   * the focused file (path + language), the open file tabs, and the current
   * selection (truncated to ~2KB). Prepended to each prompt on the host side, so
   * the DGC backend needs no change. Returns "" when there's nothing to say.
   */
  private editorContext(): string {
    try {
      const lines: string[] = [];
      const ed = vscode.window.activeTextEditor;
      const active = ed && ed.document.uri.scheme === "file"
        ? vscode.workspace.asRelativePath(ed.document.uri) : "";
      if (active && ed) { lines.push(`active file: ${active} (${ed.document.languageId})`); }

      const open: string[] = [];
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          const input: any = tab.input;
          const uri: vscode.Uri | undefined = input && input.uri;
          if (uri && uri.scheme === "file") {
            const rel = vscode.workspace.asRelativePath(uri);
            if (!open.includes(rel)) { open.push(rel); }
          }
        }
      }
      if (open.length) { lines.push(`open tabs: ${open.slice(0, 12).join(", ")}`); }

      if (ed && !ed.selection.isEmpty && ed.document.uri.scheme === "file") {
        const a = ed.selection.start.line + 1, b = ed.selection.end.line + 1;
        const CAP = 2048;
        let sel = ed.document.getText(ed.selection);
        const cut = sel.length > CAP;
        if (cut) { sel = sel.slice(0, CAP); }
        lines.push(`selection (${active || "file"}:${a}-${b})${cut ? " [truncated]" : ""}:`);
        lines.push("```" + (ed.document.languageId || ""));
        lines.push(sel);
        lines.push("```");
      }

      if (!lines.length) { return ""; }
      return `<editor-context>\n${lines.join("\n")}\n</editor-context>\n\n`;
    } catch {
      return "";
    }
  }

  private ensureBackend(): DgcBackend {
    if (this.backend) {
      return this.backend;
    }
    const cmd = vscode.workspace.getConfiguration("dgc").get<string>("command", "dgc");
    const be = new DgcBackend(this.cwd(), cmd);
    be.on("event", (ev: DgcEvent) => this.onEvent(ev));
    be.on("stderr", (line: string) => this.post({ type: "stderr", line }));
    be.on("exit", (code: number | null) => {
      this.post({ type: "backend_exit", code });
    });
    be.start();
    this.backend = be;
    return be;
  }

  restart(): void {
    this.backend?.dispose();
    this.backend = undefined;
    this.ensureBackend();
    this.post({ type: "cleared" });
  }

  private onEvent(ev: DgcEvent): void {
    switch (ev.type) {
      case "ready":
        this.state = { model: ev.model, mode: ev.mode, think: ev.think, baseUrl: ev.base_url };
        this.postState();
        this.applyNativeSettings();   // let explicitly-set VS Code settings override the CLI config
        break;
      case "model_changed":
        this.state.model = ev.model;
        this.state.baseUrl = ev.base_url ?? this.state.baseUrl;
        this.postState();
        break;
      case "mode_changed":
        this.state.mode = ev.mode;
        this.postState();
        break;
      case "think_changed":
        this.state.think = ev.think;
        this.postState();
        break;
    }
    if (ev.type === "error" && (ev as any).notInstalled) {
      this.promptInstallCli();
    }
    this.post({ type: "event", event: ev });
  }

  /** The CLI ('dgc') is missing — offer to install it (the extension drives the CLI). */
  private promptInstallCli(): void {
    if (this._installPrompted) { return; }
    this._installPrompted = true;
    const INSTALL = "Install DGC CLI", SETPATH = "Set dgc.command…";
    vscode.window.showErrorMessage(
      "DGC needs the `dgc` command-line tool, which isn't installed or on PATH.",
      INSTALL, SETPATH,
    ).then((choice) => {
      if (choice === INSTALL) {
        const term = vscode.window.createTerminal("Install DGC");
        term.show();
        term.sendText("curl -fsSL https://vibedgc.com/install.sh | bash");
        vscode.window.showInformationMessage(
          "Installing the DGC CLI in the terminal. When it finishes, reload the window to connect.");
      } else if (choice === SETPATH) {
        vscode.commands.executeCommand("workbench.action.openSettings", "dgc.command");
      }
    });
  }

  private post(msg: any): void {
    this.view?.webview.postMessage(msg);
  }
  private postState(): void {
    this.post({ type: "state", state: this.state });
    this.sb.text = `$(circuit-board) ${this.state.model || "dgc"} · ${this.state.mode}`;
    this.sb.tooltip = `DGC — ${this.state.model || "no model"} · ${this.state.mode} mode · click to change model`;
    this.sb.show();
  }

  // ---- webview -------------------------------------------------------------
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    this.ensureBackend();
    if (this.state.model) {
      this.postState();
    }
  }

  focus(): void {
    vscode.commands.executeCommand("dgc.chat.focus");
    this.view?.show?.(true);
  }

  private onMessage(msg: any): void {
    const be = this.ensureBackend();
    switch (msg.type) {
      case "prompt": {
        let text = String(msg.text ?? "");
        // Prepend the editor's context (focused file, open tabs, selection) so the
        // agent grounds on what you're looking at. Skip for `/command` prompts — the
        // backend keys custom slash-commands off a leading "/". No DGC-Python change.
        if (text && !text.startsWith("/")) {
          const ctx = this.editorContext();
          if (ctx) { text = ctx + text; }
        }
        be.send({ type: "prompt", text, images: msg.images });
        break;
      }
      case "permission_response":
        be.send({ type: "permission_response", id: msg.id, decision: msg.decision, rule: msg.rule });
        break;
      case "plan_response":
        be.send({ type: "plan_response", id: msg.id, decision: msg.decision });
        break;
      case "options_response":
        be.send({ type: "options_response", id: msg.id, choice: msg.choice });
        break;
      case "cancel":
        be.send({ type: "cancel" });
        break;
      case "pickModel":
        this.selectModel();
        break;
      case "listModels":
        this.listModels();
        break;
      case "setModel":
        this.ensureBackend().send({ type: "set_model", model: msg.model });
        break;
      case "connect":
        this.connect();
        break;
      case "setMode":
        this.ensureBackend().send({ type: "set_mode", mode: msg.mode });
        break;
      case "setThink":
        this.ensureBackend().send({ type: "set_think", level: msg.level });
        break;
      case "compact":
        this.ensureBackend().send({ type: "compact" });
        break;
      case "openSettings":
        this.openSettings();
        break;
      case "saveSettings":
        this.saveSettings(msg.values || {});
        break;
      case "pickMode":
        this.setMode();
        break;
      case "pickThink":
        this.setThinking();
        break;
      case "reqFiles":
        this.sendFiles();
        break;
      case "openFile":
        this.openFile(msg.path, msg.line);
        break;
      case "copy":
        vscode.env.clipboard.writeText(String(msg.text || ""));
        break;
      case "slash":
        this.slash(msg.action);
        break;
    }
  }

  private async sendFiles(): Promise<void> {
    const uris = await vscode.workspace.findFiles("**/*", "**/{node_modules,.git,dist,out,.venv,.next}/**", 600);
    this.post({ type: "files", files: uris.map((u) => vscode.workspace.asRelativePath(u)).sort() });
  }

  private async openFile(path: string, line?: number): Promise<void> {
    const uri = vscode.Uri.file(path.startsWith("/") ? path : this.cwd() + "/" + path);
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const ed = await vscode.window.showTextDocument(doc, { preview: true });
      if (line) {
        const pos = new vscode.Position(Math.max(0, line - 1), 0);
        ed.selection = new vscode.Selection(pos, pos);
        ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
    } catch {
      /* file may not exist on disk */
    }
  }

  private slash(action: string): void {
    switch (action) {
      case "pickModel": this.selectModel(); break;
      case "connect": this.connect(); break;
      case "pickMode": this.setMode(); break;
      case "pickThink": this.setThinking(); break;
      case "resume": this.resume(); break;
      case "new": this.newSession(); break;
      case "compact": this.ensureBackend().send({ type: "compact" }); break;
      case "clear": this.post({ type: "cleared" }); break;
      case "rewind": this.rewind(); break;
      case "subagent": vscode.commands.executeCommand("workbench.action.openSettings", "dgc.subagent"); break;
      case "settings": vscode.commands.executeCommand("workbench.action.openSettings", "@ext:daguccicode.dgc"); break;
      case "bug": vscode.env.openExternal(vscode.Uri.parse("https://github.com/OpenPeach-ai/dgc/issues")); break;
    }
  }

  async resume(): Promise<void> {
    const be = this.ensureBackend();
    const listSessions = (cmd: any): Promise<any[]> => new Promise((resolve) => {
      const h = (ev: DgcEvent) => { if (ev.type === "sessions") { be.off("sessions", h); resolve(ev.items || []); } };
      be.on("sessions", h);
      be.send(cmd);
      setTimeout(() => { be.off("sessions", h); resolve([]); }, 3000);
    });
    let items = await listSessions({ type: "list_sessions" });
    if (!items.length) { vscode.window.showInformationMessage("No past DGC sessions in this project."); return; }

    const trash = new vscode.ThemeIcon("trash");
    const qp = vscode.window.createQuickPick<any>();
    qp.placeholder = "Resume a session — trash icon deletes";
    const render = () => {
      qp.items = items.map((s) => ({
        label: s.name ? `${s.name} · ${s.preview}` : (s.preview || s.path),
        description: `${s.when} · ${s.count} msgs`,
        path: s.path,
        buttons: [{ iconPath: trash, tooltip: "Delete this session" }],
      }));
    };
    render();
    return new Promise<void>((resolve) => {
      qp.onDidTriggerItemButton(async (e) => {           // trash icon → delete + refresh the list
        items = await listSessions({ type: "delete_session", path: (e.item as any).path });
        if (!items.length) { qp.hide(); resolve(); return; }
        render();
      });
      qp.onDidAccept(() => {
        const pick = qp.selectedItems[0] as any;
        if (pick) { be.send({ type: "resume_session", path: pick.path }); this.post({ type: "cleared" }); }
        qp.hide();
      });
      qp.onDidHide(() => { qp.dispose(); resolve(); });
      qp.show();
    });
  }

  async rewind(): Promise<void> {
    const be = this.ensureBackend();
    const items: any[] = await new Promise((resolve) => {
      const h = (ev: DgcEvent) => { if (ev.type === "checkpoints") { be.off("checkpoints", h); resolve(ev.items || []); } };
      be.on("checkpoints", h);
      be.send({ type: "list_checkpoints" });
      setTimeout(() => { be.off("checkpoints", h); resolve([]); }, 2500);
    });
    if (!items.length) { vscode.window.showInformationMessage("No checkpoints yet — run a turn first."); return; }
    const pick = await vscode.window.showQuickPick(
      items.map((c) => ({ label: c.preview, description: `${c.files} file(s)`, index: c.index })),
      { placeHolder: "Rewind code + conversation to…" });
    if (pick) {
      be.send({ type: "rewind", index: (pick as any).index });
      this.post({ type: "cleared" });
      vscode.window.showInformationMessage("↩ DGC rewound code + conversation.");
    }
  }

  // ---- model listing --------------------------------------------------------
  private async fetchModels(): Promise<string[]> {
    const base = this.state.baseUrl || PROVIDERS.ollama.url;
    const res = await fetch(base.replace(/\/$/, "") + "/models");
    const data: any = await res.json();
    return (data?.data ?? []).map((m: any) => m.id).sort();
  }

  // in-composer model menu (Claude-Code style — rendered inside the webview)
  async listModels(): Promise<void> {
    const base = this.state.baseUrl || PROVIDERS.ollama.url;
    try {
      const ids = await this.fetchModels();
      this.post({ type: "models", ids, current: this.state.model, base });
    } catch {
      this.post({ type: "models", ids: [], base, err: true });
    }
  }

  // ---- native VS Code settings → backend (only explicitly-set values override the CLI config) ---
  applyNativeSettings(): void {
    const be = this.backend;
    if (!be) { return; }
    const c = vscode.workspace.getConfiguration("dgc");
    const baseUrl = c.get<string>("baseUrl", ""), apiKey = c.get<string>("apiKey", ""), model = c.get<string>("model", "");
    if (baseUrl || apiKey || model) {
      be.send({ type: "set_model", base_url: baseUrl || undefined, api_key: apiKey || undefined, model: model || undefined });
    }
    const values: any = {};
    const put = (key: string, cfgKey: string) => { const v = c.get<string>(cfgKey, ""); if (v) { values[key] = v; } };
    put("subagent_model", "subagentModel");
    put("subagent_base_url", "subagentBaseUrl");
    put("subagent_api_key", "subagentApiKey");
    put("fallback_model", "fallbackModel");
    put("fallback_base_url", "fallbackBaseUrl");
    const cs = c.get<number>("contextSize", 0); if (cs) { values.context_size = cs; }
    if (Object.keys(values).length) { be.send({ type: "set_config", values }); }
  }

  // ---- in-webview settings page --------------------------------------------
  async openSettings(): Promise<void> {
    const be = this.ensureBackend();
    be.send({ type: "get_config" });          // backend replies with a `config` event → fills the form
    const providers = Object.entries(PROVIDERS).map(([id, p]) =>
      ({ id, label: p.label, url: p.url, needsKey: p.needsKey }));
    let models: string[] = [];
    try { models = await this.fetchModels(); } catch { /* endpoint may be down */ }
    this.post({ type: "settings_open", providers, models });
  }

  async saveSettings(v: any): Promise<void> {
    const be = this.ensureBackend();
    if (v.base_url || v.api_key || v.model) {
      be.send({ type: "set_model", base_url: v.base_url || undefined,
                api_key: v.api_key || undefined, model: v.model || undefined });
    }
    if (v.mode) { be.send({ type: "set_mode", mode: v.mode }); }
    if (v.think) { be.send({ type: "set_think", level: v.think }); }
    const values: any = {
      subagent_model: v.subagent_model || "", subagent_base_url: v.subagent_base_url || "",
      subagent_api_key: v.subagent_api_key || "", fallback_model: v.fallback_model || "",
      fallback_base_url: v.fallback_base_url || "",
    };
    if (v.context_size) { values.context_size = Number(v.context_size); }
    be.send({ type: "set_config", values });
    vscode.window.showInformationMessage("DGC settings saved.");
  }

  async selectModel(): Promise<void> {
    const be = this.ensureBackend();
    const base = this.state.baseUrl || PROVIDERS.ollama.url;
    let ids: string[] = [];
    try {
      ids = await this.fetchModels();
    } catch (e: any) {
      const go = await vscode.window.showWarningMessage(
        `Can't reach ${base} — connect a provider?`, "Connect Provider");
      if (go) {
        this.connect();
      }
      return;
    }
    if (!ids.length) {
      vscode.window.showInformationMessage("The endpoint offered no models.");
      return;
    }
    const pick = await vscode.window.showQuickPick(
      ids.map((id) => ({ label: id, description: id === this.state.model ? "$(check) current" : "" })),
      { placeHolder: `Model (${base})`, matchOnDescription: true });
    if (pick) {
      be.send({ type: "set_model", model: pick.label });
    }
  }

  async connect(): Promise<void> {
    const be = this.ensureBackend();
    const items = Object.entries(PROVIDERS).map(([id, p]) => ({ label: id, description: p.label, detail: p.url }));
    items.push({ label: "custom", description: "Custom OpenAI-compatible URL…", detail: "" });
    const pick = await vscode.window.showQuickPick(items, { placeHolder: "Connect a provider" });
    if (!pick) {
      return;
    }
    let url: string;
    let needsKey = false;
    if (pick.label === "custom") {
      const input = await vscode.window.showInputBox({ prompt: "OpenAI-compatible base URL", value: "http://localhost:11434/v1", validateInput: (v) => (/^https?:\/\/.+/.test(v) ? undefined : "must be a http(s):// URL") });
      if (!input) {
        return;
      }
      url = input;
      needsKey = true;
    } else {
      url = PROVIDERS[pick.label].url;
      needsKey = PROVIDERS[pick.label].needsKey;
    }
    let key: string | undefined;
    if (needsKey) {
      key = await vscode.window.showInputBox({ prompt: `API key for ${pick.label}`, password: true });
    }
    be.send({ type: "set_model", base_url: url, api_key: key });
    setTimeout(() => this.selectModel(), 400);
  }

  async setMode(): Promise<void> {
    const be = this.ensureBackend();
    const pick = await vscode.window.showQuickPick(
      MODES.map((m) => ({ label: m.label, detail: m.detail, description: m.id === this.state.mode ? "current" : "", id: m.id })),
      { placeHolder: "Permission mode" });
    if (!pick) {
      return;
    }
    if (pick.id === "auto") {
      const ok = await vscode.window.showWarningMessage(
        "Full-auto approves every file write and shell command with no prompts. Continue?",
        { modal: true }, "Enable auto");
      if (ok !== "Enable auto") {
        return;
      }
    }
    be.send({ type: "set_mode", mode: pick.id });
  }

  cycleMode(): void {
    const be = this.ensureBackend();
    const order = ["default", "acceptEdits", "plan", "auto"];
    const next = order[(order.indexOf(this.state.mode) + 1) % order.length];
    be.send({ type: "set_mode", mode: next });
    vscode.window.setStatusBarMessage(`DGC mode → ${next}`, 1500);
  }

  async setThinking(): Promise<void> {
    const be = this.ensureBackend();
    const pick = await vscode.window.showQuickPick(
      THINK.map((t) => ({ label: t.id, detail: t.detail, description: t.id === this.state.think ? "current" : "" })),
      { placeHolder: "Thinking level" });
    if (pick) {
      be.send({ type: "set_think", level: pick.label });
    }
  }

  newSession(): void {
    this.ensureBackend().send({ type: "new_session" });
    this.post({ type: "cleared" });
  }

  addSelection(): void {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.selection.isEmpty) {
      return;
    }
    const rel = vscode.workspace.asRelativePath(ed.document.uri);
    const a = ed.selection.start.line + 1;
    const b = ed.selection.end.line + 1;
    this.focus();
    this.post({ type: "attach", label: `${rel}:${a}-${b}`, text: `<selection path="${rel}" lines="${a}-${b}">\n${ed.document.getText(ed.selection)}\n</selection>` });
  }

  dispose(): void {
    this.backend?.dispose();
    this.sb.dispose();
  }

  // ---- html ----------------------------------------------------------------
  private html(webview: vscode.Webview): string {
    const nonce = String(Math.random()).slice(2) + String(Date.now());
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "main.css"));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "main.js"));
    const codicons = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "codicon.css"));
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};`;
    return `<!doctype html><html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${codicons}">
<link rel="stylesheet" href="${css}">
</head><body>
<header id="phead"><span class="pm"><svg class="mk" viewBox="0 0 90 90" fill="currentColor" aria-hidden="true"><path d="M32 24 L20 30 L13 72 L25 66 Z"/><path d="M54 18 L42 24 L35 72 L47 66 Z"/><path d="M76 24 L64 30 L57 66 L69 60 Z"/></svg>DGC<span class="cur"></span></span><span class="pd" id="pmodel" title="Model — click to change">dgc</span></header>
<main id="log"></main>
<div id="settings" hidden>
  <div class="set-head">
    <span class="set-title"><span class="codicon codicon-settings-gear"></span> DGC Settings</span>
    <button id="set-close" class="fbtn" title="Close"><span class="codicon codicon-close"></span></button>
  </div>
  <div class="set-body">
    <div class="set-group">Connection</div>
    <label>Provider preset
      <select id="s-provider"></select></label>
    <label>Host URL
      <input id="s-base_url" type="text" spellcheck="false" placeholder="http://localhost:11434/v1"></label>
    <label>API key
      <input id="s-api_key" type="password" spellcheck="false" placeholder="(dummy for local)"></label>
    <label>Model
      <span class="set-row"><input id="s-model" type="text" spellcheck="false" placeholder="model id" list="s-models"><datalist id="s-models"></datalist></span></label>

    <div class="set-group">Sub-agents <span class="set-hint">run <code>task</code> sub-agents on a different model / host — blank = inherit main</span></div>
    <label>Sub-agent model
      <input id="s-subagent_model" type="text" spellcheck="false" placeholder="inherit main"></label>
    <label>Sub-agent host URL
      <input id="s-subagent_base_url" type="text" spellcheck="false" placeholder="inherit main host"></label>
    <label>Sub-agent API key
      <input id="s-subagent_api_key" type="password" spellcheck="false" placeholder="inherit main key"></label>

    <div class="set-group">Fallback <span class="set-hint">retried if the primary model errors</span></div>
    <label>Fallback model
      <input id="s-fallback_model" type="text" spellcheck="false" placeholder="none"></label>
    <label>Fallback host URL
      <input id="s-fallback_base_url" type="text" spellcheck="false" placeholder="same as main"></label>

    <div class="set-group">Behavior</div>
    <label>Permission mode
      <select id="s-mode"><option value="default">default</option><option value="acceptEdits">acceptEdits</option><option value="plan">plan</option><option value="auto">auto</option></select></label>
    <label>Thinking
      <select id="s-think"><option value="off">off</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option></select></label>
    <label>Context size (tokens)
      <input id="s-context_size" type="number" min="2048" step="1024" placeholder="32768"></label>
  </div>
  <div class="set-foot">
    <button id="set-save" class="csend set-save">Save</button>
    <button id="set-cancel" class="fbtn">Close</button>
  </div>
</div>
<div id="pop" class="pop"></div>
<div id="queued"></div>
<footer>
  <div id="attachments"></div>
  <div id="cbox" data-mode="default">
    <div class="cinput"><span class="pmark">❯</span><textarea id="input" rows="1" placeholder="Ask DGC to build, fix or explain…"></textarea></div>
    <div id="cfooter">
      <button id="btn-add" class="fbtn" title="Attach a file (@-mention)"><span class="codicon codicon-add"></span></button>
      <button id="btn-cmd" class="fbtn" title="Commands (/)"><span class="codicon codicon-terminal"></span></button>
      <button id="btn-ctx" class="fbtn" title="Context used — click to compact"><span class="codicon codicon-pie-chart"></span> <span id="ctx">0%</span></button>
      <button id="btn-settings" class="fbtn" title="Settings"><span class="codicon codicon-settings-gear"></span></button>
      <span class="cspacer"></span>
      <div class="picker">
        <button id="btn-model" class="fbtn mode" title="Model — click to change"><span class="codicon codicon-chip"></span> <span id="modelname">dgc</span></button>
        <div id="modelmenu" class="cmenu" hidden></div>
      </div>
      <div class="picker">
        <button id="btn-mode" class="fbtn mode" title="Permission mode — Shift+Tab to cycle"><span id="modeicon" class="codicon codicon-shield"></span> <span id="modelabel">default</span></button>
        <div id="modemenu" class="cmenu" hidden></div>
      </div>
      <button id="send" class="csend" data-mode="default" title="Send"><span class="codicon codicon-arrow-up"></span></button>
    </div>
  </div>
</footer>
<script nonce="${nonce}" src="${js}"></script>
</body></html>`;
  }
}
