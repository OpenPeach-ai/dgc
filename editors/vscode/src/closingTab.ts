import * as vscode from "vscode";

/** What the question says: its title, and what each answer does. */
export interface ClosingWords { title: string; keep: string; stop: string }

/**
 * Q3 (reported 19 Oct 2026): a tab closed while it works is asked about once, "keep it running in the background,
 * or stop it", and the answer is remembered if ticked (dgc.closingAWorkingTab). A Work session's tab and a ChatDGC
 * chat's tab ask the same question and share the setting. Until it is answered the work goes on; dismissed, it keeps
 * running. Resolves true to keep it running.
 */
export async function keepRunningAfterClose(words: ClosingWords): Promise<boolean> {
  const setting = String(vscode.workspace.getConfiguration("dgc").get<string>("closingAWorkingTab", "ask") || "ask");
  if (setting !== "ask") { return setting !== "stop"; }
  const answer = await askKeepRunning(words);
  if (answer.remember) {
    try {
      await vscode.workspace.getConfiguration("dgc").update("closingAWorkingTab", answer.keep ? "keepRunning" : "stop",
        vscode.ConfigurationTarget.Global);
    } catch { /* the choice still applies this time */ }
  }
  return answer.keep;
}

/** The one question: a quick pick with Keep running, Stop, and a Remember my choice tick. */
function askKeepRunning(words: ClosingWords): Promise<{ keep: boolean; remember: boolean }> {
  return new Promise((resolve) => {
    type Item = vscode.QuickPickItem & { id: string };
    const pick = vscode.window.createQuickPick<Item>();
    let remember = false;
    let done = false;
    const items = (): Item[] => [
      { id: "keep", label: "$(play) Keep it running in the background", detail: words.keep },
      { id: "stop", label: "$(debug-stop) Stop it", detail: words.stop },
      { id: "remember", label: `${remember ? "$(pass-filled)" : "$(circle-large-outline)"} Remember my choice`,
        alwaysShow: true },
    ];
    const finish = (keep: boolean) => {
      if (done) { return; }
      done = true;
      pick.hide();
      pick.dispose();
      resolve({ keep, remember });
    };
    pick.title = words.title;
    pick.placeholder = "Keep it running, or stop it?";
    pick.ignoreFocusOut = true;
    pick.items = items();
    pick.onDidAccept(() => {
      const chosen = pick.selectedItems[0];
      if (!chosen) { return; }
      if (chosen.id === "remember") {
        remember = !remember;
        pick.items = items();
        pick.activeItems = [pick.items[2]];
        return;
      }
      finish(chosen.id === "keep");
    });
    pick.onDidHide(() => finish(true));           // dismissed: it keeps running
    pick.show();
  });
}
