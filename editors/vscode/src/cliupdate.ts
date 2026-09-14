import * as vscode from "vscode";
import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { accessSync, constants as fsConstants, existsSync, lstatSync, realpathSync, statSync } from "fs";
import { basename, delimiter, dirname, isAbsolute, join, resolve as resolvePath, sep } from "path";

/** How long the installer may run before we stop waiting. It creates a virtualenv and installs
 *  pinned wheels, which is slow on a cold pip cache but is not an hour's work. */
const UPDATE_TIMEOUT_MS = 10 * 60 * 1000;

/** Cap what we keep from the child's output. It goes to an output channel the user can open;
 *  the tail is what explains a failure, so keep the end rather than the beginning. */
const MAX_LOG_BYTES = 64 * 1024;

/** `dgc update` exits 3 when another update (another editor window, a terminal) holds the lock. */
export const LOCK_HELD_EXIT = 3;
const LOCK_RETRY_MS = 5000;
const MAX_LOCK_RETRIES = 36;

export type UpdateResult =
  | { ok: true; log: string }
  | { ok: false; reason: string; log: string };

export type UpdateOptions = { lockRetryMs?: number; maxLockRetries?: number };

/** The file `command` names the way spawn() finds it: a path as given, or the first executable
 *  of that name on PATH. Undefined when there is none. */
export function resolveCommandPath(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const executable = (candidate: string): boolean => {
    try {
      if (!statSync(candidate).isFile()) { return false; }
      accessSync(candidate, fsConstants.X_OK);
      return true;
    } catch { return false; }
  };
  if (!command) { return undefined; }
  if (command.includes("/") || command.includes(sep)) {
    const absolute = isAbsolute(command) ? command : resolvePath(command);
    return executable(absolute) ? absolute : undefined;
  }
  for (const folder of (env.PATH || "").split(delimiter)) {
    if (!folder) { continue; }
    const candidate = join(folder, command);
    if (executable(candidate)) { return candidate; }
  }
  return undefined;
}

type InstallTree = { tree: string; dataDir: string; versioned: boolean };

/** The install behind an executable, when its real path is <dir>/.venv/bin/dgc: either a
 *  versioned install (<data>/versions/<v>, finished with .complete) or an older single tree. */
function installTreeOf(realExecutable: string): InstallTree | undefined {
  const bin = dirname(realExecutable);
  const venv = dirname(bin);
  if (basename(realExecutable) !== "dgc" || basename(bin) !== "bin" || basename(venv) !== ".venv") {
    return undefined;
  }
  const tree = dirname(venv);
  const versioned = basename(dirname(tree)) === "versions" && existsSync(join(tree, ".complete"));
  return { tree, dataDir: versioned ? dirname(dirname(tree)) : tree, versioned };
}

/** DGC_DIR and DGC_BIN for the install the editor actually runs.
 *
 *  An update is often run by an OLD CLI, whose `dgc update` pipes the published installer into
 *  bash without saying where it was installed; the installer then falls back to its defaults and a
 *  custom location is orphaned. Its child inherits our environment, and the installer honours both
 *  variables, so derive them from realpath(dgc.command) whenever that is <dir>/.venv/bin/dgc:
 *  DGC_DIR is the old tree (or the data directory of a versioned install) and DGC_BIN is the
 *  directory of the launcher symlink that led there. A dgc.command that points straight at the
 *  venv script has no launcher to switch, so only DGC_DIR is passed for it. */
export function cliUpdateEnvironment(command: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (process.platform === "win32") { return {}; }
  const found = resolveCommandPath(command, env);
  if (!found) { return {}; }
  let real: string;
  try { real = realpathSync(found); } catch { return {}; }
  const install = installTreeOf(real);
  if (!install) { return {}; }
  const result: Record<string, string> = { DGC_DIR: install.dataDir };
  try {
    if (lstatSync(found).isSymbolicLink()) { result.DGC_BIN = dirname(found); }
  } catch { /* the launcher vanished between the two looks: pass the directory only */ }
  return result;
}

/** The terminal behind every manual "update the CLI" action: the exact executable with a fixed
 *  `update` argument (never `curl | bash` typed into a shell), the install's own location, and
 *  DGC_SKIP_EXTENSION so the installer cannot replace the running extension with the published one. */
export function updateTerminalOptions(executable: string, name = "DGC update"): vscode.TerminalOptions {
  return {
    name,
    shellPath: executable,
    shellArgs: ["update"],
    env: { DGC_SKIP_EXTENSION: "1", ...cliUpdateEnvironment(executable) },
  };
}

/** True when the user chose the executable themselves. DGC manages the CLI it installed; a path
 *  someone set by hand belongs to them, and reinstalling over it would be a surprise. A path whose
 *  real location is a DGC versioned install is still DGC's: `dgc update` there finds its own data
 *  directory and launcher, so it updates exactly the install the path runs. */
export function isUserChosenCommand(): boolean {
  const inspected = vscode.workspace.getConfiguration("dgc").inspect<string>("command");
  const chosen = inspected?.globalValue;
  if (typeof chosen !== "string") { return false; }
  const trimmed = chosen.trim();
  if (trimmed.length === 0 || trimmed === "dgc") { return false; }
  try {
    const found = resolveCommandPath(trimmed);
    if (found && installTreeOf(realpathSync(found))?.versioned) { return false; }
  } catch { /* unresolvable: the user's to manage */ }
  return true;
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
 *  ever interpolated into shell text. The installer refuses to repoint a launcher that runs a git
 *  checkout, so a contributor's working tree cannot be displaced by an automatic update. When
 *  another update holds the lock (exit 3 — another window got there first), wait and try again:
 *  the second run then finds the version already built and only switches to it. */
export function runCliUpdate(
  executable: string,
  token?: vscode.CancellationToken,
  options: UpdateOptions = {},
): Promise<UpdateResult> {
  const lockRetryMs = options.lockRetryMs ?? LOCK_RETRY_MS;
  const maxLockRetries = options.maxLockRetries ?? MAX_LOCK_RETRIES;
  // DGC_SKIP_EXTENSION: the installer also reinstalls the editor extension from the published
  // .vsix. Run from inside the editor, that would replace the extension that asked for this
  // update — with an OLDER build for as long as the site has not caught up. The editor owns
  // its own extensions; this update is only ever about the CLI.
  const env = { ...process.env, DGC_SKIP_EXTENSION: "1", ...cliUpdateEnvironment(executable) };
  return new Promise<UpdateResult>((resolve) => {
    let child: ChildProcessWithoutNullStreams | undefined;
    let log = "";
    let settled = false;
    let lockRetries = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const append = (chunk: string) => {
      log += chunk;
      if (log.length > MAX_LOG_BYTES) { log = log.slice(log.length - MAX_LOG_BYTES); }
    };
    const finish = (result: UpdateResult) => {
      if (settled) { return; }
      settled = true;
      clearTimeout(timer);
      if (retryTimer) { clearTimeout(retryTimer); }
      subscription?.dispose();
      resolve(result);
    };
    const signalTree = (signal: NodeJS.Signals) => {
      const current = child;
      if (!current) { return; }
      try {
        if (process.platform !== "win32" && current.pid) { process.kill(-current.pid, signal); }
        else { current.kill(signal); }
      } catch { /* the group is already gone */ }
    };
    /** Stop the installer and everything it started, then answer without waiting for the pipes:
     *  a descendant that ignores the signal must not be able to hold the caller open. */
    const stop = (reason: string) => {
      if (settled) { return; }
      signalTree("SIGTERM");
      const hard = setTimeout(() => signalTree("SIGKILL"), 2000);
      hard.unref?.();
      child?.stdout.destroy();
      child?.stderr.destroy();
      finish({ ok: false, reason, log });
    };

    const timer = setTimeout(() => stop("the update took longer than 10 minutes"), UPDATE_TIMEOUT_MS);
    const subscription = token?.onCancellationRequested(() => stop("cancelled"));

    const attempt = () => {
      if (settled) { return; }
      let current: ChildProcessWithoutNullStreams;
      try {
        // Its own process group. The installer forks bash, curl, python and pip; signalling only
        // the process we spawned would leave those running, still holding the pipes, so a
        // cancelled update would keep installing and the editor would never see the end of it.
        current = spawn(executable, ["update"], { env, detached: process.platform !== "win32" });
      } catch (err: any) {
        finish({ ok: false, reason: `could not run ${executable}: ${err?.message ?? err}`, log });
        return;
      }
      child = current;
      current.stdout.setEncoding("utf8");
      current.stderr.setEncoding("utf8");
      current.stdout.on("data", append);
      current.stderr.on("data", append);
      current.on("error", (err: any) => {
        finish({ ok: false, reason: `could not run ${executable}: ${err?.message ?? err}`, log });
      });
      current.on("close", (code, signal) => {
        if (settled) { return; }
        if (code === 0) { finish({ ok: true, log }); return; }
        if (code === LOCK_HELD_EXIT && lockRetries < maxLockRetries) {
          lockRetries += 1;
          append(`\n[DGC: another update is running; trying again in ${Math.ceil(lockRetryMs / 1000)} s]\n`);
          retryTimer = setTimeout(attempt, lockRetryMs);
          return;
        }
        const how = signal ? `stopped by ${signal}` : `exit ${code}`;
        finish({ ok: false, reason: `${failureHeadline(log) || "the installer failed"} (${how})`, log });
      });
    };
    attempt();
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
