import * as vscode from "vscode";
import { execFile } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { promisify } from "util";
import { resolveDgcExecutable } from "./configuration";
import { wslCli } from "./wslSetup";
import { addWorkApp, listWorkApps, removeWorkApp, WorkApp } from "./workAppsRegistry";
import { canEmbedWorkApp, checkWorkApp } from "./workAppsProbe";

const run = promisify(execFile);
const APP_VIEW = "dgc.workApps";
const APP_BROWSER = "dgc.workAppBrowser";
const ID = /^app_[a-f0-9]{16}$/;
const attr = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

type PipSummary = { id: string; name: string; type: string; status: string; pending: number };

async function projectPips(projectRoot: string): Promise<PipSummary[]> {
  const args = ["pips", "--json", "list"];
  const routed = wslCli(args, projectRoot);
  const selected = resolveDgcExecutable().command;
  const local = join(homedir(), ".local", "bin", "dgc");
  const executable = routed?.executable ?? (selected === "dgc" && existsSync(local) ? local : selected);
  const output = await run(executable, routed?.args ?? args,
    { cwd: projectRoot, timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true });
  const parsed = JSON.parse(output.stdout);
  if (!Array.isArray(parsed?.pips)) return [];
  return parsed.pips.slice(0, 20).map((pip: any) => ({
    id: String(pip.id || "").slice(0, 80), name: String(pip.name || "Pip").slice(0, 100),
    type: String(pip.pip_type || "").slice(0, 30), status: String(pip.status || "").slice(0, 30),
    pending: Number.isSafeInteger(pip.pending_review_count) ? Math.max(0, pip.pending_review_count) : 0,
  }));
}

export function workAppsDocument(asset: (name: string) => string, cspSource: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${attr(cspSource)}; style-src ${attr(cspSource)}; script-src ${attr(cspSource)};">
<link rel="stylesheet" href="${attr(asset("media/codicon.css"))}"><link rel="stylesheet" href="${attr(asset("media/apps.css"))}"><title>DGC Apps</title></head>
<body><main class="apps"><header class="apps-head"><div><span class="apps-kicker">Work / Library</span><h1><span class="codicon codicon-layers" aria-hidden="true"></span> Apps</h1><p>Your projects, ready to reopen and care for. Their source and data stay where you keep them.</p></div><div class="apps-actions"><button id="apps-refresh" type="button" class="secondary"><span class="codicon codicon-refresh" aria-hidden="true"></span> Refresh</button><button id="apps-add" type="button" class="primary"><span class="codicon codicon-add" aria-hidden="true"></span> Add an app</button></div></header>
<p id="apps-status" class="apps-status" role="status">Loading apps…</p><div id="apps-list" class="apps-list"></div>
<footer>This is an early Apps experiment. A site that forbids embedding opens in your browser; its health and Pips remain here in DGC.</footer></main>
<script src="${attr(asset("media/apps.js"))}"></script></body></html>`;
}

export class WorkApps implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private readonly browsers = new Map<string, vscode.WebviewPanel>();
  constructor(private readonly context: vscode.ExtensionContext) {}

  register(): vscode.Disposable {
    return vscode.window.registerWebviewPanelSerializer(APP_VIEW, {
      deserializeWebviewPanel: async (panel) => { this.adopt(panel); },
    });
  }

  open(): void {
    if (this.panel) { this.panel.reveal(); void this.refresh(); return; }
    const panel = vscode.window.createWebviewPanel(APP_VIEW, "DGC Apps", vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.context.extensionUri] });
    this.adopt(panel);
  }

  private adopt(panel: vscode.WebviewPanel): void {
    this.panel = panel;
    panel.title = "DGC Apps";
    panel.onDidDispose(() => { if (this.panel === panel) this.panel = undefined; });
    panel.webview.onDidReceiveMessage((message) => { void this.receive(message); });
    const asset = (name: string) => panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, ...name.split("/"))).toString();
    panel.webview.html = workAppsDocument(asset, panel.webview.cspSource);
  }

  private async refresh(): Promise<void> {
    const panel = this.panel;
    if (!panel) return;
    try {
      const apps = await listWorkApps();
      void panel.webview.postMessage({ type: "apps", apps: apps.map(app => ({ ...app, health: null, pips: null })) });
      await Promise.all(apps.map(async app => {
        const [health, pips] = await Promise.allSettled([checkWorkApp(app.healthUrl), projectPips(app.projectRoot)]);
        if (this.panel !== panel) return;
        void panel.webview.postMessage({ type: "appStatus", id: app.id,
          health: health.status === "fulfilled" ? health.value : { state: "offline", detail: "Health check failed." },
          pips: pips.status === "fulfilled" ? pips.value : null });
      }));
    } catch (error: any) {
      if (this.panel === panel) void panel.webview.postMessage({ type: "error", text: String(error?.message || error).slice(0, 200) });
    }
  }

  private async receive(message: any): Promise<void> {
    if (!message || typeof message !== "object") return;
    const id = String(message.id || "");
    try {
      switch (message.type) {
        case "ready": case "refresh": await this.refresh(); break;
        case "add": await this.add(); break;
        case "remove": if (ID.test(id)) await this.remove(id); break;
        case "open": if (ID.test(id)) await this.openApp(id); break;
        case "pips": await vscode.commands.executeCommand("dgc.openPips"); break;
      }
    } catch (error: any) {
      void vscode.window.showErrorMessage(`DGC Apps: ${String(error?.message || error).slice(0, 240)}`);
    }
  }

  private async add(): Promise<void> {
    const selected = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false,
      canSelectMany: false, openLabel: "Use this project", defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri });
    const projectRoot = selected?.[0]?.fsPath;
    if (!projectRoot) return;
    const suggested = selected[0].path.split(/[\\/]/).filter(Boolean).pop() || "My app";
    const name = await vscode.window.showInputBox({ title: "App name", value: suggested, validateInput: v =>
      !v.trim() || v.length > 80 ? "Give a name of at most 80 characters." : undefined });
    if (!name) return;
    const url = await vscode.window.showInputBox({ title: "App address", prompt: "The URL you open to use this app",
      placeHolder: "https://example.com or http://127.0.0.1:3000" });
    if (!url) return;
    const healthUrl = await vscode.window.showInputBox({ title: "Health check (optional)", value: url,
      prompt: "Use a JSON readiness endpoint if the app has one; otherwise keep the app address." });
    if (healthUrl === undefined) return;
    await addWorkApp({ name, projectRoot, url, healthUrl });
    await this.refresh();
  }

  private async remove(id: string): Promise<void> {
    const app = (await listWorkApps()).find(row => row.id === id);
    if (!app) return;
    const decision = await vscode.window.showWarningMessage(
      `Remove ${app.name} from DGC Apps? Its project files and running service will not be touched.`,
      { modal: true }, "Remove from Apps");
    if (decision !== "Remove from Apps") return;
    await removeWorkApp(id);
    await this.refresh();
  }

  private async openApp(id: string): Promise<void> {
    const app = (await listWorkApps()).find(row => row.id === id);
    if (!app) return;
    const policy = await canEmbedWorkApp(app.url);
    if (!policy.embedded) {
      const opened = await vscode.env.openExternal(vscode.Uri.parse(app.url));
      if (opened) void vscode.window.showInformationMessage(`${app.name} opened in the browser. ${policy.reason}`);
      else void vscode.window.showErrorMessage(`Could not open ${app.name}. ${policy.reason}`);
      return;
    }
    const existing = this.browsers.get(id);
    if (existing) { existing.reveal(); return; }
    const original = vscode.Uri.parse(app.url);
    const url = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(app.url).hostname)
      ? await vscode.env.asExternalUri(original) : original;
    const origin = new URL(url.toString()).origin;
    const browser = vscode.window.createWebviewPanel(APP_BROWSER, app.name, vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
    this.browsers.set(id, browser);
    browser.onDidDispose(() => { if (this.browsers.get(id) === browser) this.browsers.delete(id); });
    browser.webview.html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; frame-src ${attr(origin)};"><title>${attr(app.name)}</title><style>html,body,iframe{margin:0;width:100%;height:100%;border:0;background:#141416}</style></head><body><iframe title="${attr(app.name)}" src="${attr(url.toString())}" sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-downloads"></iframe></body></html>`;
  }

  dispose(): void { this.panel?.dispose(); for (const panel of this.browsers.values()) panel.dispose(); this.browsers.clear(); }
}
