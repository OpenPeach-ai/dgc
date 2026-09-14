import * as vscode from "vscode";
import { spawn, ChildProcessWithoutNullStreams } from "child_process";

/** How long the installer may run before we stop waiting. It creates a virtualenv and installs
 *  pinned wheels, which is slow on a cold pip cache but is not an hour's work. */
const UPDATE_TIMEOUT_MS = 10 * 60 * 1000;

/** Cap what we keep from the child's output. It goes to an output channel the user can open;
 *  the tail is what explains a failure, so keep the end rather than the beginning. */
const MAX_LOG_BYTES = 64 * 1024;

export type UpdateResult =
  | { ok: true; log: string }
  | { ok: false; reason: string; log: string };

/** True when the user chose the executable themselves. DGC manages the CLI it installed; a path
 *  someone set by hand belongs to them, and reinstalling over it would be a surprise — the
 *  installer writes to $HOME/dgc, which may not be where their binary lives at all. */
export function isUserChosenCommand(): boolean {
  const inspected = vscode.workspace.getConfiguration("dgc").inspect<string>("command");
  const chosen = inspected?.globalValue;
  if (typeof chosen !== "string") { return false; }
  const trimmed = chosen.trim();
  return trimmed.length > 0 && trimmed !== "dgc";
}

export function autoUpdateEnabled(): boolean {
  const inspected = vscode.workspace.getConfiguration("dgc").inspect<boolean>("autoUpdateCli");
  // User/machine scope only, like every other setting that decides what gets executed: a
  // repository must not be able to turn an automatic reinstall on by shipping settings.
  const selected = inspected?.globalValue ?? inspected?.defaultValue;
  return selected !== false;
}

/** Run `dgc update` — the CLI's own supported reinstall — as a child process rather than in a
 *  terminal, so the editor can report progress and restart the backend when it lands.
 *
 *  The subcommand is a fixed argument next to an exact executable path; nothing the user typed is
 *  ever interpolated into shell text. The installer it runs refuses to extract a release over a
 *  git checkout, so a contributor's working tree cannot be reverted by an automatic update. */
export function runCliUpdate(
  executable: string,
  token?: vscode.CancellationToken,
): Promise<UpdateResult> {
  return new Promise<UpdateResult>((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      // Its own process group. The installer is a shell pipeline that forks curl, bash, python and
      // pip; signalling only the process we spawned would leave those running, still holding the
      // pipes, so a cancelled update would keep installing and the editor would never see the end
      // of it. A group leader can be signalled as a whole.
      child = spawn(executable, ["update"], {
        // DGC_SKIP_EXTENSION: the installer also reinstalls the editor extension from the published
        // .vsix. Run from inside the editor, that would replace the extension that asked for this
        // update — with an OLDER build for as long as the site has not caught up. The editor owns
        // its own extensions; this update is only ever about the CLI.
        env: { ...process.env, DGC_SKIP_EXTENSION: "1" },
        detached: process.platform !== "win32",
      });
    } catch (err: any) {
      resolve({ ok: false, reason: `could not run ${executable}: ${err?.message ?? err}`, log: "" });
      return;
    }
    let log = "";
    let settled = false;
    const append = (chunk: string) => {
      log += chunk;
      if (log.length > MAX_LOG_BYTES) { log = log.slice(log.length - MAX_LOG_BYTES); }
    };
    const finish = (result: UpdateResult) => {
      if (settled) { return; }
      settled = true;
      clearTimeout(timer);
      subscription?.dispose();
      resolve(result);
    };
    /** Stop the installer and everything it started, then answer without waiting for the pipes:
     *  a descendant that ignores the signal must not be able to hold the caller open. */
    const stop = (reason: string) => {
      signalTree("SIGTERM");
      const hard = setTimeout(() => signalTree("SIGKILL"), 2000);
      hard.unref?.();
      child.stdout.destroy();
      child.stderr.destroy();
      finish({ ok: false, reason, log });
    };
    const signalTree = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid) { process.kill(-child.pid, signal); }
        else { child.kill(signal); }
      } catch { /* the group is already gone */ }
    };

    const timer = setTimeout(() => stop("the update took longer than 10 minutes"), UPDATE_TIMEOUT_MS);
    const subscription = token?.onCancellationRequested(() => stop("cancelled"));

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (err: any) => {
      finish({ ok: false, reason: `could not run ${executable}: ${err?.message ?? err}`, log });
    });
    child.on("close", (code, signal) => {
      if (code === 0) { finish({ ok: true, log }); return; }
      const how = signal ? `stopped by ${signal}` : `exit ${code}`;
      finish({ ok: false, reason: `${failureHeadline(log) || "the installer failed"} (${how})`, log });
    });
  });
}

/** The one line worth putting in a notification. The installer marks its own refusal with ✗ and
 *  then spends two more lines on the ways forward, so the last line is the least useful one —
 *  reporting it said "Or overwrite it anyway…" as though that were the problem. */
export function failureHeadline(log: string): string {
  const lines = log
    .replace(/\u001B\[[0-9;]*m/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const refusal = lines.find((line) => line.startsWith("\u2717"));
  if (refusal) { return refusal.replace(/^\u2717\s*/, ""); }
  return lines[lines.length - 1] || "";
}
