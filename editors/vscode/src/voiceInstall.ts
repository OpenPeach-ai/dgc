// Installing DGC Voice, the small extension (editors/vscode-voice) that records the microphone on the computer you're
// at. It isn't on the Marketplace or Open VSX yet, so DGC carries it: the build packs it into dist/dgc-voice.vsix
// (esbuild.js) and "Install DGC Voice" installs that file, or DGC Voice from the editor's own gallery when the gallery
// has it and it isn't older. Nothing here ends in an empty Extensions search: a failed install says what happened and
// where the file is.
//
// A Remote window installs it on this computer, not on the host DGC runs on. This file's URI reaches the window as
// vscode-remote://, the window installs a "ui" extension on its local side only, and the local side copies a remote
// file over before it installs it (VS Code: extensionManagementService.ts installVSIX / getServersToInstall, and
// nativeExtensionManagementService.ts downloadVsix). An extension installed while the window is open starts without a
// reload, so the next press of the microphone records.
import * as vscode from "vscode";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { newer } from "./extensionupdate";
import { VOICE_EXTENSION } from "./voice";

/** Where the build puts DGC Voice inside this extension. */
export const BUNDLED_VOICE = ["dist", "dgc-voice.vsix"] as const;
/** The version it packed there (esbuild.js writes it in). */
const BUNDLED_VOICE_VERSION = process.env.DGC_VOICE_VERSION || "";
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const INSTALL_VOICE = "Install DGC Voice";
const FROM_VSIX = "Install from VSIX…", RELOAD = "Reload Window", INSTALLING = "Installing DGC Voice…";

export type VoiceSource = "gallery" | "bundled" | "none";
export type VoiceInstallResult = "ready" | "reload" | "failed";

/** Where DGC Voice comes from: the gallery when it has a release no older than the one DGC carries, else DGC's. */
export function voiceSource(gallery: string | null, bundled: { version: string } | null): VoiceSource {
  if (gallery && VERSION.test(gallery) && (!bundled || !VERSION.test(bundled.version) || !newer(bundled.version, gallery))) {
    return "gallery";
  }
  return bundled ? "bundled" : "none";
}

/** DGC Voice's newest release on a gallery (the Marketplace's API, which Open VSX serves as well), or null: it isn't
 *  there, or the gallery didn't answer in time. */
export async function galleryVoiceVersion(serviceUrl: string, fetcher: typeof fetch = fetch, timeoutMs = 5000): Promise<string | null> {
  if (!/^https:\/\/\S+$/i.test(serviceUrl)) return null;
  try {
    const response = await fetcher(`${serviceUrl.replace(/\/+$/, "")}/extensionquery`, {
      method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(timeoutMs),
      headers: { "Content-Type": "application/json", Accept: "application/json;api-version=3.0-preview.1", "User-Agent": "dgc-vscode" },
      body: JSON.stringify({
        filters: [{ criteria: [{ filterType: 7, value: VOICE_EXTENSION }, { filterType: 8, value: "Microsoft.VisualStudio.Code" }],
                    pageNumber: 1, pageSize: 1, sortBy: 0, sortOrder: 0 }],
        assetTypes: [], flags: 0x1 | 0x10,            // its versions, each with the properties that say pre-release
      }),
    });
    if (!response.ok) return null;
    const text = await response.text();
    if (text.length > 4 * 1024 * 1024) return null;
    const found = (JSON.parse(text)?.results?.[0]?.extensions || []).find((e: any) =>
      `${e?.publisher?.publisherName}.${e?.extensionName}`.toLowerCase() === VOICE_EXTENSION);
    const release = (Array.isArray(found?.versions) ? found.versions : []).find((v: any) =>
      typeof v?.version === "string" && VERSION.test(v.version)
      && !(Array.isArray(v.properties) ? v.properties : []).some((p: any) => p?.key === "Microsoft.VisualStudio.Code.PreRelease" && p?.value === "true"));
    return release ? release.version : null;
  } catch {
    return null;
  }
}

/** Whether DGC Voice answers dgcVoice.status yet, asking for up to `ms` while the editor starts it. */
export async function voiceAnswers(execute: (command: string) => PromiseLike<unknown>, ms = 15_000, every = 400): Promise<boolean> {
  const until = Date.now() + ms;
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const status = await Promise.race([Promise.resolve(execute("dgcVoice.status")),
                                         new Promise((resolve) => { timer = setTimeout(resolve, Math.max(every, until - Date.now())); })]);
      if (status && typeof status === "object") return true;
    } catch { /* not started yet */ } finally { clearTimeout(timer); }
    if (Date.now() >= until) return false;
    await new Promise((resolve) => setTimeout(resolve, every));
  }
}

/** What installing needs from the editor (editorVoiceInstaller); tests pass their own. */
export interface VoiceInstaller {
  /** The DGC Voice this extension carries, when the build packed it. */
  bundled(): { path: string; version: string } | null;
  /** DGC Voice's newest release on the editor's gallery, or null. */
  galleryVersion(): Promise<string | null>;
  /** workbench.extensions.installExtension, with DGC Voice's id (from the gallery) or a .vsix file. */
  install(what: { id: string } | { file: string }): Promise<void>;
  /** Whether DGC Voice answers, given a moment to start. */
  answers(): Promise<boolean>;
  progress<T>(title: string, work: () => Promise<T>): Promise<T>;
  info(message: string, ...actions: string[]): Promise<string | undefined>;
  error(message: string, ...actions: string[]): Promise<string | undefined>;
  /** A .vsix the user picks, starting at `near`. */
  pickVsix(near?: string): Promise<string | undefined>;
  reload(): void;
  /** The editor's name, as it's said ("Cursor"). */
  app: string;
}

/** An error's own words, as one sentence of a message. */
function said(error: unknown): string {
  return String(error instanceof Error ? error.message : error || "the editor gave no reason").trim().replace(/\.+$/, "").slice(0, 400);
}

type Attempt = { ready: boolean } | { failures: string[] };
let attempt: Promise<Attempt> | undefined;

/** Installs DGC Voice: "ready" once it answers, "reload" when the editor has to reload first, "failed" after saying
 *  why. One install runs at a time (a second ask waits for it); what's said after it never holds up the next. */
export async function installVoice(io: VoiceInstaller): Promise<VoiceInstallResult> {
  const bundled = io.bundled();
  const tried = await (attempt ??= io.progress(INSTALLING, () => tryInstall(io, bundled)).finally(() => { attempt = undefined; }));
  if ("ready" in tried) return started(io, tried.ready);
  const why = tried.failures.join("; ");
  const missing = `this copy of DGC doesn't carry it (${BUNDLED_VOICE.join("/")} is missing)`;
  const message = bundled
    ? `DGC Voice couldn't be installed: ${why}. DGC carries it as ${bundled.path}; Install from VSIX… opens that file to try again.`
    : why ? `DGC Voice couldn't be installed: ${why}, and ${missing}.`
    : `DGC Voice couldn't be installed: ${missing}, and ${io.app}'s extension gallery doesn't have it.`;
  if (await io.error(message, FROM_VSIX) !== FROM_VSIX) return "failed";
  const file = await io.pickVsix(bundled?.path);
  if (!file) return "failed";
  try {
    return started(io, await io.progress(INSTALLING, async () => { await io.install({ file }); return io.answers(); }));
  } catch (error) {
    await io.error(`DGC Voice couldn't be installed from ${file}: ${said(error)}.`);
    return "failed";
  }
}

/** The gallery's DGC Voice when it isn't older than DGC's own, else (or when that fails) DGC's own file. */
async function tryInstall(io: VoiceInstaller, bundled: { path: string; version: string } | null): Promise<Attempt> {
  const source = voiceSource(await io.galleryVersion(), bundled);
  const failures: string[] = [];
  if (source === "gallery") {
    try { await io.install({ id: VOICE_EXTENSION }); return { ready: await io.answers() }; }
    catch (error) { failures.push(said(error)); }
  }
  if (bundled) {
    try { await io.install({ file: bundled.path }); return { ready: await io.answers() }; }
    catch (error) { failures.push(said(error)); }
  }
  return { failures };
}

async function started(io: VoiceInstaller, ready: boolean): Promise<VoiceInstallResult> {
  if (ready) return "ready";
  if (await io.info(`DGC Voice is installed, but ${io.app} hasn't started it yet. Reload the window, then press the microphone.`, RELOAD) === RELOAD) io.reload();
  return "reload";
}

/** The gallery this editor installs from, as its product.json says (the Marketplace in VS Code, Open VSX in VSCodium). */
function editorGallery(): string {
  try {
    return String(JSON.parse(readFileSync(join(vscode.env.appRoot, "product.json"), "utf8"))?.extensionsGallery?.serviceUrl || "");
  } catch {
    return "";
  }
}

/** Installing through the editor, for the extension at `extensionPath`. */
export function editorVoiceInstaller(extensionPath: string): VoiceInstaller {
  const file = join(extensionPath, ...BUNDLED_VOICE);
  return {
    bundled: () => (existsSync(file) ? { path: file, version: BUNDLED_VOICE_VERSION } : null),
    galleryVersion: () => galleryVoiceVersion(editorGallery()),
    install: async (what) => {
      // A file installs as VS Code's own "Install from VSIX" does (extensionupdate.ts installs DGC's updates so too).
      await vscode.commands.executeCommand("workbench.extensions.installExtension", "id" in what ? what.id : vscode.Uri.file(what.file));
    },
    answers: () => voiceAnswers((command) => vscode.commands.executeCommand(command)),
    progress: (title, work) => Promise.resolve(vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, work)),
    info: (message, ...actions) => Promise.resolve(vscode.window.showInformationMessage(message, ...actions)),
    error: (message, ...actions) => Promise.resolve(vscode.window.showErrorMessage(message, ...actions)),
    pickVsix: async (near) => (await vscode.window.showOpenDialog({
      defaultUri: near ? vscode.Uri.file(near) : undefined, canSelectMany: false, canSelectFolders: false,
      filters: { VSIX: ["vsix"] }, openLabel: "Install",
    }))?.[0]?.fsPath,
    reload: () => { void vscode.commands.executeCommand("workbench.action.reloadWindow"); },
    app: vscode.env.appName || "the editor",
  };
}

/** The notification a press of the microphone without DGC Voice shows: true once DGC Voice is installed and answers. */
export async function offerVoiceInstall(message: string, extensionPath: string): Promise<boolean> {
  if (await vscode.window.showInformationMessage(message, INSTALL_VOICE) !== INSTALL_VOICE) return false;
  return (await installVoice(editorVoiceInstaller(extensionPath))) === "ready";
}
