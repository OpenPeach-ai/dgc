import * as vscode from "vscode";
import { createHash } from "crypto";
import { mkdtemp, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

const ORIGIN = "https://vibedgc.com";
const MANIFEST = `${ORIGIN}/vscode/version.json`;
const DAY = 86_400_000;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export type ExtensionRelease = { version: string; url: string; sha256?: string };

export function newer(a: string, b: string): boolean {
  if (!VERSION.test(a) || !VERSION.test(b)) return false;
  const left = a.split(".").map(Number), right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] > right[i];
  }
  return false;
}

/** Never follow a URL supplied by a manifest. Use the immutable versioned release on our origin. */
export function extensionRelease(value: unknown): ExtensionRelease {
  const version = (value as { version?: unknown })?.version;
  if (typeof version !== "string" || version.length > 40 || !VERSION.test(version)) {
    throw new Error("DGC's extension release metadata has an invalid version.");
  }
  const sha256 = (value as { sha256?: unknown }).sha256;
  if (sha256 !== undefined && (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(sha256))) {
    throw new Error("DGC's extension release metadata has an invalid checksum.");
  }
  return { version, url: `${ORIGIN}/vscode/dgc-${version}.vsix`, ...(sha256 ? { sha256: String(sha256) } : {}) };
}

export async function downloadBounded(url: string, limit: number): Promise<Buffer> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(60_000), redirect: "error", cache: "no-store",
    headers: { "User-Agent": "dgc-vscode", "Cache-Control": "no-cache" },
  });
  if (!response.ok || !response.body) throw new Error(`DGC download failed (HTTP ${response.status}).`);
  const reader = response.body.getReader();
  let length = 0;
  const chunks: Buffer[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error("DGC's update download exceeds its size limit.");
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}

export function verifyExtensionDownload(data: Buffer, checksum: string): void {
  const expected = /^([a-f0-9]{64})(?:\s+\*?dgc\.vsix)?\s*$/i.exec(checksum.trim())?.[1];
  if (!expected || createHash("sha256").update(data).digest("hex") !== expected.toLowerCase()) {
    throw new Error("DGC extension checksum verification failed. Your installed extension was not changed; try the update again.");
  }
}

let installing: Promise<void> | undefined;
export function installExtensionRelease(release: ExtensionRelease): Promise<void> {
  if (installing) return installing;
  // Reconstruct it here too: callers cannot select a different executable download origin.
  const approved = extensionRelease(release);
  installing = Promise.resolve(vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
    title: `DGC: installing extension ${approved.version}…` }, async () => {
    const data = await downloadBounded(approved.url, 32 * 1024 * 1024);
    const checksum = approved.sha256
      || (await downloadBounded(`${ORIGIN}/vscode/dgc.vsix.sha256`, 512)).toString("utf8");
    verifyExtensionDownload(data, checksum);
    const directory = await mkdtemp(join(tmpdir(), "dgc-extension-update-"));
    try {
      const file = join(directory, `dgc-${approved.version}.vsix`);
      await writeFile(file, data, { mode: 0o600, flag: "wx" });
      // The editor performs installation and enforces its own policy. Never write into its
      // extension directories or force a reload while the user may have work in flight.
      await vscode.commands.executeCommand("workbench.extensions.installExtension", vscode.Uri.file(file));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    const action = await vscode.window.showInformationMessage(
      `DGC extension ${approved.version} installed. Reload the window to activate it.`, "Reload Window");
    if (action === "Reload Window") await vscode.commands.executeCommand("workbench.action.reloadWindow");
  })).then(() => undefined).finally(() => { installing = undefined; });
  return installing;
}

/** Registry proxies can lag, and sideloaded packages may not auto-update. Check every channel. */
export async function checkForExtensionUpdates(ctx: vscode.ExtensionContext, force = false): Promise<void> {
  if (!force) {
    const setting = vscode.workspace.getConfiguration("dgc").inspect<boolean>("checkForUpdates");
    if ((setting?.globalValue ?? setting?.defaultValue) === false) return;
    if (Date.now() - ctx.globalState.get<number>("dgc.updateCheckedAt", 0) < DAY) return;
  }
  let selectedInstall = false;
  try {
    const release = extensionRelease(JSON.parse((await downloadBounded(MANIFEST, 16 * 1024)).toString("utf8")));
    await ctx.globalState.update("dgc.updateCheckedAt", Date.now());
    const current = String(ctx.extension.packageJSON.version);
    if (!newer(release.version, current)) {
      if (force) await vscode.window.showInformationMessage(
        `DGC extension ${current} is the latest published build. If the CLI is newer, select its matching installed version or wait for the matching extension release.`);
      return;
    }
    const action = await vscode.window.showInformationMessage(
      `DGC extension ${release.version} is available (installed: ${current}). Install the verified release directly if your editor's marketplace has not caught up.`,
      "Install Update", "Later");
    if (action === "Install Update") { selectedInstall = true; await installExtensionRelease(release); }
  } catch (error) {
    if (force || selectedInstall) await vscode.window.showErrorMessage(`DGC extension update failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
