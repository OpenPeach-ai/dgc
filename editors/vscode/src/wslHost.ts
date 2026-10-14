// Hidden WSL: on native Windows, DGC runs inside a Linux distro of its own (WSL), and the editor never shows it.
//
// DGC has no Windows build: it is a Linux (and macOS) program. A Windows editor that opens C:\ folders therefore
// starts `dgc serve` through wsl.exe in a distro DGC set up and owns (named "DGC" unless dgc.windows.wslDistro says
// otherwise), as a user of its own, and translates every path that crosses (src/wslPaths.ts). The user's own
// distros are never touched. Setting it up takes three steps, each said in words: Windows' WSL feature (needs an
// administrator and a restart; Windows asks), the distro (Ubuntu 24.04, from Microsoft's list), and DGC in it.
import { spawn } from "child_process";
import { win32 } from "path";

const join = win32.join;            // Windows paths, whichever system builds them (tests run on Linux)

export const DEFAULT_DISTRO = "DGC";
export const LINUX_USER = "dgc";
export const LAUNCHER = `/home/${LINUX_USER}/.local/bin/dgc`;
export const BASE_IMAGE = "Ubuntu-24.04";
/** Variables the extension sets that DGC must see inside the distro (WSLENV: /u = from Windows to Linux only). */
const PASSED = ["DGC_SKIP_EXTENSION", "DGC_INSTALL_VERSION", "DGC_BASE_URL"];

export function wslExe(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.SystemRoot || env.windir || "C:\\Windows", "System32", "wsl.exe");
}

/** Valid as a WSL distro name and safe on a command line: letters, digits, dot, dash, underscore. */
export function distroName(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value.trim()) ? value.trim() : DEFAULT_DISTRO;
}

/** WSLENV with the variables DGC needs added once, keeping what the user's own WSLENV passes. */
export function wslenv(current: string | undefined, env: NodeJS.ProcessEnv): string {
  const parts = (current || "").split(":").filter(Boolean);
  const names = new Set(parts.map((part) => part.split("/")[0]));
  for (const name of PASSED) {
    if (env[name] !== undefined && !names.has(name)) { parts.push(`${name}/u`); }
  }
  return parts.join(":");
}

export type Launch = { command: string; args: string[]; cwd: string | undefined; env: NodeJS.ProcessEnv };

/** `dgc <args>` in the distro, started in the Windows folder `cwd` (wsl.exe --cd takes a Windows path as it is).
 *  No shell: --exec runs DGC's launcher with exactly these arguments, so nothing in a path or argument is parsed. */
export function launch(distro: string, cwd: string | undefined, args: string[], env: NodeJS.ProcessEnv = process.env): Launch {
  const merged: NodeJS.ProcessEnv = { ...env, WSL_UTF8: "1" };
  merged.WSLENV = wslenv(env.WSLENV, merged);
  return {
    command: wslExe(env),
    args: ["-d", distro, ...(cwd ? ["--cd", cwd] : []), "--exec", LAUNCHER, ...args],
    // wsl.exe's own folder is irrelevant (--cd sets DGC's); a Windows folder that no longer exists must not stop it.
    cwd: undefined,
    env: merged,
  };
}

/** wsl.exe writes UTF-16LE unless WSL_UTF8=1 is honoured (older WSL ignores it): read either. */
export function wslText(data: Buffer): string {
  const bom = data.length >= 2 && data[0] === 0xff && data[1] === 0xfe;
  const looksUtf16 = bom || (data.length >= 2 && data.length % 2 === 0 && data[1] === 0 && data[0] !== 0);
  const text = looksUtf16 ? data.toString("utf16le") : data.toString("utf8");
  return text.replace(/^\uFEFF/u, "").replace(/\0/g, "").replace(/\r/g, "");
}

export type WslState = "no-wsl" | "no-distro" | "no-dgc" | "ready";

/** wsl.exe's words (on stdout or stderr, NULs of UTF-16 dropped) when WSL, DGC's distro, or DGC in it isn't there. */
export function notSetUp(said: string): boolean {
  return /WSL_E_DISTRO_NOT_FOUND|no distribution with the supplied name|execvpe?\(.*\) failed|WSL_E_WSL_OPTIONAL_COMPONENT_REQUIRED|WSL_E_DEFAULT_DISTRO_NOT_FOUND|Subsystem for Linux (?:is not installed|has no installed distributions)|wsl\.exe --install/iu
    .test(said.replace(/\0/g, ""));
}

export type Runner = (args: string[], options?: { input?: string; timeoutMs?: number }) =>
  Promise<{ code: number | null; out: string; err: string; missing?: boolean }>;

/** wsl.exe with ARGS, its output read either way. `missing` when there is no wsl.exe at all. */
export function runWsl(env: NodeJS.ProcessEnv = process.env): Runner {
  return (args, options = {}) => new Promise((resolve) => {
    let child;
    try {
      const merged: NodeJS.ProcessEnv = { ...env, WSL_UTF8: "1" };
      merged.WSLENV = wslenv(env.WSLENV, merged);     // the installer's own variables, as `dgc serve` gets them
      child = spawn(wslExe(env), args, { env: merged, windowsHide: true });
    } catch {
      resolve({ code: null, out: "", err: "", missing: true });
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, options.timeoutMs ?? 60_000);
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ code: null, out: "", err: String(error.message), missing: error.code === "ENOENT" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out: wslText(Buffer.concat(out)), err: wslText(Buffer.concat(err)) });
    });
    if (options.input !== undefined) { child.stdin.end(options.input); } else { child.stdin.end(); }
  });
}

/** Where this computer is: WSL missing, WSL without DGC's distro, the distro without DGC, or ready. */
export async function state(run: Runner, distro: string): Promise<WslState> {
  const listed = await run(["--list", "--quiet"], { timeoutMs: 30_000 });
  if (listed.missing) { return "no-wsl"; }
  if (listed.code !== 0) {
    // "The Windows Subsystem for Linux is not installed" (exit 1), or the optional component is off.
    return /no installed distributions|has no installed distributions/iu.test(listed.out + listed.err) ? "no-distro" : "no-wsl";
  }
  const names = listed.out.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!names.some((name) => name.toLowerCase() === distro.toLowerCase())) { return "no-distro"; }
  const probe = await run(["-d", distro, "--exec", "/bin/test", "-x", LAUNCHER], { timeoutMs: 60_000 });
  return probe.code === 0 ? "ready" : "no-dgc";
}

/** As root in the distro, once: DGC's user (the default from now on), what DGC's installer needs, and
 *  Pip computers' sandbox. Fixed text, run by `sh -s` from stdin: nothing configurable reaches it. */
export const PREPARE_SCRIPT = [
  "set -eu",
  "export DEBIAN_FRONTEND=noninteractive",
  `id -u ${LINUX_USER} >/dev/null 2>&1 || useradd -m -s /bin/bash ${LINUX_USER}`,
  "if ! grep -q '^default=" + LINUX_USER + "$' /etc/wsl.conf 2>/dev/null; then",
  `  printf '\\n[user]\\ndefault=${LINUX_USER}\\n' >> /etc/wsl.conf`,
  "fi",
  "apt-get update -q",
  "apt-get install -y -q python3-venv bubblewrap curl ca-certificates",
  // DGC's own distro (dgc/wsl.py OWN_DISTRO_MARK): only here does DGC bridge a model on Windows' localhost.
  "touch /etc/dgc-distro",
].join("\n");

/** As DGC's user: the published installer, which never touches the editor's extension here. */
export const INSTALL_SCRIPT = [
  "set -eu",
  "cd \"$HOME\"",
  // DGC_BASE_URL (a mirror, or a local build being tested) reaches the distro through WSLENV, as on Linux.
  "curl -fsSL \"${DGC_BASE_URL:-https://vibedgc.com}/install.sh\" | DGC_SKIP_EXTENSION=1 bash",
].join("\n");

export type Step = { title: string; args: string[]; input?: string; timeoutMs: number };

/** What setting it up from STATE still takes, in order. "no-wsl" has none here: it needs an administrator. */
export function setupSteps(from: WslState, distro: string): Step[] {
  const steps: Step[] = [];
  if (from === "no-distro") {
    // --web-download: straight from the distribution's own site. Through the Store (the default), a fresh Windows 11
    // (26300, WSL 3.0.3) sat at 0% CPU for 15 minutes from an editor; this took a minute.
    steps.push({ title: "Getting Ubuntu for DGC", args: ["--install", BASE_IMAGE, "--name", distro, "--no-launch", "--web-download"],
      timeoutMs: 20 * 60_000 });
  }
  if (from === "no-distro" || from === "no-dgc") {
    steps.push({ title: "Preparing it", args: ["-d", distro, "-u", "root", "--exec", "/bin/sh", "-s"], input: PREPARE_SCRIPT, timeoutMs: 20 * 60_000 });
    steps.push({ title: "Restarting it", args: ["--terminate", distro], timeoutMs: 60_000 });
    steps.push({ title: "Installing DGC", args: ["-d", distro, "-u", LINUX_USER, "--exec", "/bin/sh", "-s"], input: INSTALL_SCRIPT, timeoutMs: 20 * 60_000 });
  }
  return steps;
}

/** Turning on WSL itself: Windows asks for an administrator (UAC) and wants a restart afterwards. */
export function enableWslCommand(env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } {
  const powershell = join(env.SystemRoot || env.windir || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return { command: powershell, args: ["-NoProfile", "-NonInteractive", "-Command",
    "Start-Process -FilePath wsl.exe -ArgumentList '--install','--no-distribution' -Verb RunAs -Wait"] };
}
