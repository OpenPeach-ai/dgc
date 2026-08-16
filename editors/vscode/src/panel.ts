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

  constructor(private readonly context: vscode.ExtensionContext) {}

  // ---- backend lifecycle ---------------------------------------------------
  private cwd(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
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
    this.post({ type: "event", event: ev });
  }

  private post(msg: any): void {
    this.view?.webview.postMessage(msg);
  }
  private postState(): void {
    this.post({ type: "state", state: this.state });
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
      case "prompt":
        be.send({ type: "prompt", text: msg.text });
        break;
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
      case "pickMode":
        this.setMode();
        break;
      case "pickThink":
        this.setThinking();
        break;
    }
  }

  // ---- native menus (QuickPicks) -------------------------------------------
  async selectModel(): Promise<void> {
    const be = this.ensureBackend();
    const base = this.state.baseUrl || PROVIDERS.ollama.url;
    let ids: string[] = [];
    try {
      const res = await fetch(base.replace(/\/$/, "") + "/models");
      const data: any = await res.json();
      ids = (data?.data ?? []).map((m: any) => m.id).sort();
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
  }

  // ---- html ----------------------------------------------------------------
  private html(webview: vscode.Webview): string {
    const nonce = String(Math.random()).slice(2) + String(Date.now());
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "main.css"));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "main.js"));
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};`;
    return `<!doctype html><html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${css}">
</head><body>
<header id="hdr">
  <button id="pill-model" class="pill" title="Select model">◆ <span id="model">—</span></button>
  <button id="pill-mode" class="pill" title="Permission mode">🛡 <span id="mode">default</span></button>
  <button id="pill-think" class="pill" title="Thinking level">💡 <span id="think">off</span></button>
</header>
<main id="log"></main>
<div id="attachments"></div>
<footer>
  <textarea id="input" rows="1" placeholder="Ask DGC…  @ files · / commands"></textarea>
  <button id="send" title="Send">Send ▸</button>
</footer>
<script nonce="${nonce}" src="${js}"></script>
</body></html>`;
  }
}
