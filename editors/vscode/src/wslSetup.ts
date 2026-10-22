// Hidden WSL in the editor: whether it is on, the route `dgc serve` takes, where DGC's own files are as Windows sees
// them, and setting it up when it isn't (src/wslHost.ts has the steps, src/wslBridge.ts the paths).
import * as vscode from "vscode";
import { spawn } from "child_process";
import { homedir } from "os";
import { join } from "path";
import type { HostRoute } from "./backend";
import { bridge } from "./wslBridge";
import { DEFAULT_DISTRO, LINUX_USER, distroName, enableWslCommand, launch, notSetUp, runWsl, setupSteps, state } from "./wslHost";
import { pathMap } from "./wslPaths";

/** On native Windows, unless the user turned it off or chose a DGC executable themselves: DGC's distro name. */
export function hiddenWslDistro(platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform !== "win32") { return undefined; }
  const config = vscode.workspace.getConfiguration("dgc");
  const inspect = <T>(name: string) => config.inspect<T>(name);
  // Machine settings only: a repository's .vscode/settings.json never chooses how DGC starts.
  const use = inspect<boolean>("windows.useWsl");
  if ((use?.globalValue ?? use?.defaultValue ?? true) === false) { return undefined; }
  const command = inspect<string>("command")?.globalValue;
  if (typeof command === "string" && command.trim() && command.trim() !== "dgc") { return undefined; }
  const distro = inspect<string>("windows.wslDistro");
  return distroName(distro?.globalValue ?? distro?.defaultValue ?? DEFAULT_DISTRO);
}

export function wslRoute(distro: string): HostRoute {
  return {
    launch: (cwd, args, env) => launch(distro, cwd, args, { ...process.env, ...(env || {}) }),
    bridge: bridge(pathMap(distro)),
    notSetUp,
  };
}

/** DGC's own folder (~/.dgc) as this editor reaches it: in the distro under hidden WSL. */
export function dgcHome(): string {
  const distro = hiddenWslDistro();
  return distro ? `\\\\wsl.localhost\\${distro}\\home\\${LINUX_USER}\\.dgc` : join(homedir(), ".dgc");
}

/** A path on this side, as `dgc serve` names it (unchanged unless hidden WSL is on). */
export function backendPath(path: string): string {
  const distro = hiddenWslDistro();
  return distro ? pathMap(distro).toLinux(path) : path;
}

/** A path `dgc serve` named, as this side opens it (unchanged unless hidden WSL is on). Also a model's `~/x`. */
export function editorPath(path: string): string {
  const distro = hiddenWslDistro();
  if (!distro) { return path; }
  const home = `/home/${LINUX_USER}`;
  const posix = path === "~" ? home : path.startsWith("~/") ? home + path.slice(1) : path;
  return pathMap(distro).toWindows(posix);
}

/** A terminal's `dgc <args>` under hidden WSL: wsl.exe with DGC's launcher, in the folder (undefined elsewhere). */
export function wslCli(args: string[], cwd?: string): { executable: string; args: string[] } | undefined {
  const distro = hiddenWslDistro();
  if (!distro) { return undefined; }
  const spec = launch(distro, cwd, args);
  return { executable: spec.command, args: spec.args };
}

let running: Promise<boolean> | undefined;

/** Set DGC up in its distro, saying each step; true when DGC is ready to start. One at a time per window. */
export function setUpWsl(distro: string, log: vscode.OutputChannel): Promise<boolean> {
  running ??= setUp(distro, log).finally(() => { running = undefined; });
  return running;
}

async function setUp(distro: string, log: vscode.OutputChannel): Promise<boolean> {
  const run = runWsl();
  const where = await state(run, distro);
  log.appendLine(`[DGC on Windows] ${distro}: ${where}`);
  if (where === "ready") { return true; }
  if (where === "no-wsl") {
    // A dialog, not a toast: nothing in DGC works until this is answered, and a toast hides itself unread.
    const TURN_ON = "Turn on WSL", LEARN = "Learn more";
    const choice = await vscode.window.showWarningMessage("Turn on WSL for DGC?", { modal: true,
      detail: "DGC runs on Windows inside a small Linux system of its own (Windows Subsystem for Linux), and WSL isn't "
        + "turned on. Windows asks for administrator permission, then needs a restart." }, TURN_ON, LEARN);
    if (choice === LEARN) {
      void vscode.env.openExternal(vscode.Uri.parse("https://learn.microsoft.com/windows/wsl/install"));
      return false;
    }
    if (choice !== TURN_ON) { return false; }
    const { command, args } = enableWslCommand();
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn(command, args, { windowsHide: true });
      child.on("error", () => resolve(null));
      child.on("close", resolve);
    });
    log.appendLine(`[DGC on Windows] turning on WSL ended with ${code}`);
    void vscode.window.showInformationMessage(code === 0
      ? "Restart Windows to finish turning on WSL, then open DGC again: it sets itself up from there."
      : "WSL was not turned on. You can turn it on yourself with `wsl --install` in an administrator terminal.");
    return false;
  }
  const SET_UP = "Set up DGC";
  const choice = await vscode.window.showInformationMessage(where === "no-distro" ? "Set up DGC on Windows?" : "Install DGC?",
    { modal: true, detail: where === "no-distro"
      ? "DGC runs on Windows inside a small Linux system of its own (WSL). Setting it up downloads Ubuntu and DGC "
        + "(a few hundred MB) and takes a few minutes. Your own WSL distros are not touched."
      : "DGC's Linux system on Windows is there, but DGC isn't installed in it." },
    SET_UP);
  if (choice !== SET_UP) { return false; }
  const steps = setupSteps(where, distro);
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Setting up DGC on Windows",
    cancellable: false }, async (progress) => {
    for (const [index, step] of steps.entries()) {
      progress.report({ message: `${step.title} (${index + 1} of ${steps.length})…` });
      log.appendLine(`[DGC on Windows] ${step.title}: wsl.exe ${step.args.join(" ")}`);
      const result = await run(step.args, { input: step.input, timeoutMs: step.timeoutMs });
      // The installer colours its lines for a terminal; the log shows them plain.
      const plain = (text: string) => text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").trim().slice(-20000);
      if (plain(result.out)) { log.appendLine(plain(result.out)); }
      if (plain(result.err)) { log.appendLine(plain(result.err)); }
      if (result.code !== 0) {
        log.show(true);
        void vscode.window.showErrorMessage(`Setting up DGC on Windows stopped at "${step.title}". The DGC log (Output) says why.`);
        return false;
      }
    }
    return (await state(run, distro)) === "ready";
  });
}
