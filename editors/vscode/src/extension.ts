import * as vscode from "vscode";
import { DgcViewProvider } from "./panel";
import { resolveDgcExecutable } from "./configuration";

export function activate(context: vscode.ExtensionContext): void | object {
  if (vscode.workspace.isTrusted === false) {
    void vscode.window.showWarningMessage(
      "DGC is disabled in Restricted Mode. Trust this workspace before starting the coding agent.");
    return;
  }
  const provider = new DgcViewProvider(context);

  const runCliInTerminal = (subcommand: "update" | "export-training"): boolean => {
    if (vscode.workspace.isTrusted === false) {
      void vscode.window.showWarningMessage(
        "DGC is disabled in Restricted Mode. Trust this workspace before running the CLI.");
      return false;
    }
    const executable = resolveDgcExecutable();
    if (executable.ignoredWorkspaceOverride) {
      void vscode.window.showWarningMessage(
        "DGC ignored a workspace-level dgc.command override. Configure the executable in User Settings.");
    }
    // Launch an exact executable/argv pair. Interpolating a configurable path into shell text would
    // allow metacharacters in that setting to execute an unrelated command.
    const term = vscode.window.createTerminal({
      name: subcommand === "update" ? "DGC update" : "DGC export-training",
      shellPath: executable.command,
      shellArgs: [subcommand],
    });
    term.show();
    return true;
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("dgc.chat", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    provider,
    vscode.commands.registerCommand("dgc.focus", () => provider.focus()),
    vscode.commands.registerCommand("dgc.openCommandMenu", () => provider.openCommandMenu()),
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
    vscode.commands.registerCommand("dgc.nameSession", () => provider.nameSession()),
    vscode.commands.registerCommand("dgc.openSkills", () => provider.openSkills()),
    vscode.commands.registerCommand("dgc.openMcp", () => provider.openMcp()),
    vscode.commands.registerCommand("dgc.openDocs", () => provider.openDocs()),
    vscode.commands.registerCommand("dgc.openPermissions", () => provider.openPermissions()),
    vscode.commands.registerCommand("dgc.openMemory", () => provider.openMemory()),
    vscode.commands.registerCommand("dgc.openHooks", () => provider.openHooks()),
    vscode.commands.registerCommand("dgc.viewPlan", () => provider.runEditorAction("viewPlan")),
    vscode.commands.registerCommand("dgc.artifacts", () => provider.runEditorAction("artifacts")),
    vscode.commands.registerCommand("dgc.goal", () => provider.runEditorAction("goal")),
    vscode.commands.registerCommand("dgc.handoff", () => provider.runEditorAction("handoff")),
    vscode.commands.registerCommand("dgc.retainedTasks", () => provider.runEditorAction("retainedTasks")),
    vscode.commands.registerCommand("dgc.compact", () => provider.runEditorAction("compact")),
    vscode.commands.registerCommand("dgc.updateCli", () => {
      // parity with the CLI's /update: run the installer in a terminal (curl | bash),
      // then remind the user to restart the backend so the panel picks up the new version.
      if (runCliInTerminal("update")) {
        vscode.window.showInformationMessage(
          "Updating the DGC CLI — run “DGC: Restart Backend” when it finishes.");
      }
    }),
    vscode.commands.registerCommand("dgc.exportTraining", () => {
      // parity with the CLI's /export-training: run the read-only exporter in a terminal so its
      // full scrubbed-JSONL summary is visible; the subcommand writes ./dgc-training.jsonl.
      if (runCliInTerminal("export-training")) {
        vscode.window.showInformationMessage(
          "Exporting your DGC sessions as scrubbed fine-tuning JSONL — see the terminal.");
      }
    }),
    vscode.commands.registerCommand("dgc.settings", () => provider.openSettings()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("dgc")) { provider.applyNativeSettings(); }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => provider.workspaceRootsChanged()),
  );

  checkForUpdates(context).catch(() => { /* never raise into activate */ });
  const testToken = process.env.DGC_EXTENSION_TEST_TOKEN;
  if (testToken) {
    return Object.freeze({
      testOnlyWebviewMessage: (token: string, message: any) =>
        provider.testOnlyWebviewMessage(token, message),
      testOnlyPostedMessages: (token: string) => provider.testOnlyPostedMessages(token),
    });
  }
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
