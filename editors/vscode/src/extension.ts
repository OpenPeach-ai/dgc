import * as vscode from "vscode";
import { DgcViewProvider } from "./panel";

export function activate(context: vscode.ExtensionContext): void {
  const provider = new DgcViewProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("dgc.chat", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    provider,
    vscode.commands.registerCommand("dgc.focus", () => provider.focus()),
    vscode.commands.registerCommand("dgc.newSession", () => provider.newSession()),
    vscode.commands.registerCommand("dgc.selectModel", () => provider.selectModel()),
    vscode.commands.registerCommand("dgc.connect", () => provider.connect()),
    vscode.commands.registerCommand("dgc.setMode", () => provider.setMode()),
    vscode.commands.registerCommand("dgc.cycleMode", () => provider.cycleMode()),
    vscode.commands.registerCommand("dgc.setThinking", () => provider.setThinking()),
    vscode.commands.registerCommand("dgc.addSelection", () => provider.addSelection()),
    vscode.commands.registerCommand("dgc.restart", () => provider.restart()),
    vscode.commands.registerCommand("dgc.resume", () => provider.resume()),
    vscode.commands.registerCommand("dgc.rewind", () => provider.rewind()),
    vscode.commands.registerCommand("dgc.updateCli", () => {
      // parity with the CLI's /update: run the installer in a terminal (curl | bash),
      // then remind the user to restart the backend so the panel picks up the new version.
      const cmd = vscode.workspace.getConfiguration("dgc").get<string>("command", "dgc") || "dgc";
      const term = vscode.window.createTerminal({ name: "DGC update" });
      term.show();
      term.sendText(`${cmd} update`);
      vscode.window.showInformationMessage("Updating the DGC CLI — run “DGC: Restart Backend” when it finishes.");
    }),
    vscode.commands.registerCommand("dgc.settings", () => provider.openSettings()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("dgc")) { provider.applyNativeSettings(); }
    }),
  );

  checkForUpdates(context).catch(() => { /* never raise into activate */ });
}

export function deactivate(): void { /* provider disposal handled by subscriptions */ }

// --- self-hosted update nudge (mirrors the CLI's version.json pattern) --------
const MANIFEST = "https://vibedgc.com/vscode/version.json";
const DAY = 86_400_000;

function newer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) {
      return (pa[i] || 0) > (pb[i] || 0);
    }
  }
  return false;
}

async function checkForUpdates(ctx: vscode.ExtensionContext): Promise<void> {
  // Marketplace / Open VSX builds auto-update — only the self-hosted .vsix nags.
  if (process.env.DGC_SELF_HOSTED !== "true") {
    return;
  }
  if (!vscode.workspace.getConfiguration("dgc").get("checkForUpdates", true)) {
    return;
  }
  const last = ctx.globalState.get<number>("dgc.updateCheckedAt", 0);
  if (Date.now() - last < DAY) {
    return;
  }
  await ctx.globalState.update("dgc.updateCheckedAt", Date.now());

  // a real User-Agent is required — Cloudflare 403s the default fetch UA
  const res = await fetch(MANIFEST, { signal: AbortSignal.timeout(4000), headers: { "User-Agent": "dgc-vscode" } });
  const m: any = await res.json();
  const current = ctx.extension.packageJSON.version as string;
  if (!m?.version || !newer(m.version, current)) {
    return;
  }
  if (ctx.globalState.get("dgc.skip") === m.version) {
    return;
  }
  const pick = await vscode.window.showInformationMessage(
    `DGC ${m.version} is available (you have ${current}).`,
    "Get it", "Skip this version");
  if (pick === "Get it") {
    vscode.env.openExternal(vscode.Uri.parse(m.page || "https://vibedgc.com/vscode/"));
  } else if (pick === "Skip this version") {
    ctx.globalState.update("dgc.skip", m.version);
  }
}
