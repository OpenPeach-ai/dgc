import * as vscode from "vscode";
import { promises as fs } from "fs";
import { basename, dirname, extname, join, resolve, sep } from "path";
import { dgcHome } from "./wslSetup";

/** Videos DGC made (dgc/videos.py), for the three chats' players: the extension host reads a video's bytes and its
 *  poster for a webview (a blob: URL there, as pictures are data: URIs), opens it in the system player, shows it in its
 *  folder, copies it into the project (Save to project…), reads a job's state from its record on disk (a Pip chat's
 *  player, which has no backend wire of its own), and passes a Stop on. A webview never names a file it wasn't told
 *  of: a path is DGC's own videos folder, or one the backend reported (`allow`). */
export const VIDEO_MESSAGES = new Set(["videoData", "videoOpen", "videoReveal", "videoSave", "videoStop", "videoJob"]);
const MIMES: Record<string, string> = { ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".webp": "image/webp", ".gif": "image/gif" };
/** The most a webview is handed to play inline; a larger file opens in the system player. */
export const MAX_INLINE_BYTES = 300 * 1024 * 1024;
const allowed = new Set<string>();

export function videosHome(): string {
  return join(dgcHome(), "videos");
}

/** A path the backend reported (a job's result, the Library's row): it may be shown even outside DGC's folder (save_to). */
export function allowVideoPath(path: unknown): void {
  if (typeof path !== "string" || !path) return;
  allowed.add(resolve(path));
  if (allowed.size > 2000) allowed.delete(allowed.values().next().value as string);
}

/** Every result path in a job (or a list of jobs, a Library page): allowed. */
export function allowFromJobs(value: unknown): void {
  const rows = Array.isArray(value) ? value : [value];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, any>;
    allowVideoPath(r.path);
    allowVideoPath(r.poster);
    if (r.result && typeof r.result === "object") {
      allowVideoPath(r.result.path);
      allowVideoPath(r.result.poster);
    }
  }
}

export function videoPathAllowed(path: unknown): string | null {
  if (typeof path !== "string" || !path || path.includes("\0")) return null;
  const full = resolve(path);
  if (!MIMES[extname(full).toLowerCase()] && extname(full).toLowerCase() !== ".jpg") return null;
  const home = resolve(videosHome());
  return full.startsWith(home + sep) || allowed.has(full) ? full : null;
}

async function poster(path: string): Promise<string> {
  const jpg = path.replace(/\.[^.]+$/, ".jpg");
  try {
    const stat = await fs.stat(jpg);
    if (stat.size > 4 * 1024 * 1024) return "";
    return `data:image/jpeg;base64,${(await fs.readFile(jpg)).toString("base64")}`;
  } catch {
    return "";
  }
}

/** A job's state from its record on disk, without the provider's handle: what a player shows. */
export async function readJob(id: string): Promise<Record<string, unknown> | null> {
  if (!/^vid_[0-9a-f]{12}$/.test(String(id || ""))) return null;
  try {
    const raw = JSON.parse(await fs.readFile(join(videosHome(), "jobs", `${id}.json`), "utf8"));
    if (!raw || typeof raw !== "object") return null;
    const keep = ["id", "state", "status", "generator", "generator_name", "provider", "model", "label", "duration_s",
      "resolution", "aspect", "audio", "estimate_usd", "started", "finished", "cost_usd", "charged", "minutes", "error"];
    const out: Record<string, unknown> = {};
    for (const key of keep) if (raw[key] !== undefined && raw[key] !== null) out[key] = raw[key];
    if (raw.result && typeof raw.result === "object") {
      out.result = Object.fromEntries(["path", "rel", "file", "poster", "bytes", "mime", "seconds", "width", "height"]
        .filter((k) => raw.result[k] !== undefined).map((k) => [k, raw.result[k]]));
      allowFromJobs(out);
    }
    out.can_stop = !["done", "failed", "cancelled"].includes(String(raw.state));
    return out;
  } catch {
    return null;
  }
}

export interface VideoHostOptions {
  /** Stop a job through this webview's backend (videos_stop); without one, the Stop is refused in words. */
  stop?: (job: string) => Promise<Record<string, unknown> | undefined>;
  /** A running job a player reads from disk (a Pip's chat): its backend polls it (or watches it) from now on. */
  follow?: (job: string) => void;
}

/** One message a webview sent about a video: answered with `post`. True when it was a video message. */
export async function handleVideoMessage(msg: any, post: (m: unknown) => void, options: VideoHostOptions = {}): Promise<boolean> {
  if (!msg || !VIDEO_MESSAGES.has(msg.type)) return false;
  const requestId = typeof msg.requestId === "string" ? msg.requestId.slice(0, 64) : "";
  if (msg.type === "videoJob") {
    const job = await readJob(String(msg.job || ""));
    if (job && job.can_stop) options.follow?.(String(job.id));
    post({ type: "videoJob", requestId, job });
    return true;
  }
  if (msg.type === "videoStop") {
    const job = String(msg.job || "");
    let answer: Record<string, unknown> | undefined;
    let error = "";
    try {
      answer = options.stop ? await options.stop(job) : undefined;
      if (!options.stop) error = "This chat can't stop a video from here: use dgc videos stop in a terminal.";
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    post({ type: "videoStopped", requestId, job, answer: answer ?? null, error });
    if (error) void vscode.window.showWarningMessage(`DGC: ${error}`);
    return true;
  }
  const path = videoPathAllowed(msg.path);
  if (!path) {
    if (msg.type === "videoData") post({ type: "videoData", requestId, error: "DGC shows only the videos it made." });
    return true;
  }
  if (msg.type === "videoData") {
    try {
      const stat = await fs.stat(path);
      if (stat.size > MAX_INLINE_BYTES) {
        post({ type: "videoData", requestId, error: "too_large", bytes: stat.size, poster: await poster(path) });
        return true;
      }
      const data = await fs.readFile(path);
      post({ type: "videoData", requestId, mime: MIMES[extname(path).toLowerCase()] || "video/mp4",
        data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), bytes: stat.size,
        poster: await poster(path) });
    } catch {
      post({ type: "videoData", requestId, error: "The video isn't there any more." });
    }
    return true;
  }
  if (msg.type === "videoOpen") {
    const ok = await vscode.env.openExternal(vscode.Uri.file(path));
    if (!ok) void vscode.window.showInformationMessage(`The video is at ${path}`);
    return true;
  }
  if (msg.type === "videoReveal") {
    await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(path));
    return true;
  }
  // Save to project…: a video DGC made lives in its own folder; this puts a copy in the open project, in assets/ unless
  // the user picks another place (the dialog is the choice), with its sidecar beside it.
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!folder) {
    void vscode.window.showInformationMessage("Open a folder first: Save to project… copies the video into it.");
    return true;
  }
  const ext = extname(path).slice(1) || "mp4";
  const target = await vscode.window.showSaveDialog({ title: "Save to project", saveLabel: "Save to project",
    filters: { Videos: [ext] }, defaultUri: vscode.Uri.joinPath(folder, "assets", basename(path)) });
  if (!target) return true;
  try {
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(dirname(target.fsPath)));
    await vscode.workspace.fs.copy(vscode.Uri.file(path), target, { overwrite: false });
    const sidecar = path.replace(/\.[^.]+$/, ".json");
    try {
      await vscode.workspace.fs.copy(vscode.Uri.file(sidecar), vscode.Uri.file(target.fsPath.replace(/\.[^.]+$/, ".json")),
        { overwrite: false });
    } catch { /* no sidecar there, or one already: the video is what was asked for */ }
    void vscode.window.showInformationMessage(`Saved ${vscode.workspace.asRelativePath(target, false)} in the project.`);
  } catch (err) {
    void vscode.window.showErrorMessage(`DGC could not save the video: ${String(err)}`);
  }
  return true;
}
