import * as vscode from "vscode";
import { DgcViewProvider } from "./panel";
import { checkForExtensionUpdates } from "./extensionupdate";
import { resolveDgcExecutable } from "./configuration";
import { heldCliTerminalOptions, openUpdateTerminal } from "./cliupdate";

export function activate(context: vscode.ExtensionContext): void | object {
  if (vscode.workspace.isTrusted === false) {
    void vscode.window.showWarningMessage(
      "DGC is disabled in Restricted Mode. Trust this workspace before starting the coding agent.");
    return;
  }
  const provider = new DgcViewProvider(context);
  let commandPath = resolveDgcExecutable().command;

  const runCliInTerminal = (subcommand: "update" | "export-training" | "notes"): boolean => {
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
    // `update` also carries the install's own location and DGC_SKIP_EXTENSION (see
    // updateTerminalOptions): without the latter, the installer run from this terminal would
    // reinstall the published .vsix over the extension that is running it.
    // Every one of these prints its result and exits, and a terminal whose process has exited is
    // closed at once: the output has to be held on screen until it has been read.
    if (subcommand === "update") {
      // It reports its own progress and outcome, in step with the terminal.
      void openUpdateTerminal(executable.command, "DGC update", () => provider.restart("manual CLI update"));
      return true;
    }
    const term = vscode.window.createTerminal(subcommand === "notes"
        ? heldCliTerminalOptions(executable.command, ["notes"], "DGC notes",
          "Those are this project's context notes.", "DGC notes failed")
        : heldCliTerminalOptions(executable.command, ["export-training"], "DGC export-training",
          "Export finished.", "DGC export-training failed"));
    term.show();
    return true;
  };

  context.subscriptions.push(
    // The same chat, offered in the activity bar and in the secondary sidebar. VS Code binds a
    // container to exactly one location, so a second container is how a view can live in both;
    // the provider keeps a single conversation and follows whichever one the user opens.
    vscode.window.registerWebviewViewProvider("dgc.chat", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider("dgc.chatSecondary", provider, {
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
    vscode.commands.registerCommand("dgc.addFile",
      (uri?: vscode.Uri, uris?: vscode.Uri[]) => provider.addFiles(uri, uris)),
    vscode.commands.registerCommand("dgc.restart", () => provider.restart("command DGC: Restart Backend")),
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
    vscode.commands.registerCommand("dgc.updateExtension", () => checkForExtensionUpdates(context, true)),
    vscode.commands.registerCommand("dgc.updateCli", () => {
      // parity with the CLI's /update: run `dgc update` in a terminal, then remind the user to
      // restart the backend so the panel picks up the new version.
      runCliInTerminal("update");
    }),
    vscode.commands.registerCommand("dgc.openNotes", () => {
      // The trace is a CLI surface, so the editor shows it by running the CLI — the same shape as
      // Update CLI and Export Training. A dedicated panel browser would need a protocol event, and
      // a second lockstep upgrade so soon after v7 costs users more than the browser is worth.
      if (runCliInTerminal("notes")) {
        void vscode.window.showInformationMessage(
          "Showing this project's context notes — see the terminal. The agent can also search them itself.");
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
      if (e.affectsConfiguration("dgc.command")) {
        // The backend is the configured executable; a new path used to take effect only on the
        // next window reload. Restart only when the path DGC resolves actually changed: the event
        // also fires for a workspace-scope edit DGC ignores (an agent or a checkout rewriting
        // .vscode/settings.json), and restarting on that killed the turn for nothing.
        const next = resolveDgcExecutable().command;
        if (next !== commandPath) {
          commandPath = next;
          provider.commandPathChanged();
          return;
        }
      }
      if (e.affectsConfiguration("dgc")) { provider.applyNativeSettings(); }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => provider.workspaceRootsChanged()),
  );

  checkForExtensionUpdates(context).catch(() => { /* never raise into activate */ });
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
