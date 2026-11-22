// Download: a copy of a file for the person, saved on the computer the editor runs on. The host's half of ONE module
// (media/shared/download.js is the page's): every "Download" and "Save a copy" in DGC comes here.
//
// Where it is saved from depends on the editor:
//   its desktop app   the editor's own Save dialog, on the person's computer (saveWithDialog). A page in the desktop app
//                     can't start a download: the app drops it without a word, no file and no dialog. In a window on this
//                     machine the dialog is this machine's, starting in Downloads; in a remote window (Remote-SSH, WSL, a
//                     container) the editor names the person's own disk "vscode-local", and a dialog started there
//                     browses their computer, never the remote one.
//   in a browser      the page saves it, a Blob and a hidden <a download>: the bytes go to the page the person clicked.
// What a page itself holds (a picture it shows, a chart it drew) comes here too, as a "dgcSave" message (takeSave).
//
// Three ways in, by where the file is:
//   downloadBytes   bytes the host already holds (a picture it read, a note's text, a plugin card's file)
//   downloadFile    a file on this machine (what DGC keeps for a chat, a project file, a video DGC made)
//   downloadMade    a file DGC makes on request (an export, a Library file, a Pip computer's file): DGC writes it into
//                   a private folder made for this one download, the host hands it over, and the folder is removed
// The dialog stays only where the place IS the project or this machine ("Save to project", a team file saved into the
// project): those never come here. A file larger than a page can carry goes to the person's own browser instead
// (downloadThroughBrowser): an address on this machine, forwarded like any other, that answers with it as an attachment.
import * as vscode from "vscode";
import * as http from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** The page's message type (media/shared/download.js listens for it). */
export const DOWNLOAD_MESSAGE = "dgcDownload";
/** A page's own file (a picture it shows, a chart it drew), sent to its host to be saved (takeSave). */
export const SAVE_MESSAGE = "dgcSave";
/** The most one download carries; the page keeps the same number. */
export const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;

/** Where a download goes: a page's webview, or a function that posts to it (a surface with its own routing). */
export type DownloadPage = { postMessage(message: unknown): Thenable<boolean> | Promise<boolean> | boolean } | ((message: unknown) => unknown);

const TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", ogg: "audio/ogg",
  pdf: "application/pdf", zip: "application/zip", json: "application/json", md: "text/markdown", txt: "text/plain", csv: "text/csv",
  html: "text/html", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
/** A file's type by its name ("application/octet-stream" when the name says nothing). */
export function downloadType(name: string): string {
  return TYPES[(/\.([A-Za-z0-9]{1,8})$/.exec(String(name || ""))?.[1] || "").toLowerCase()] || "application/octet-stream";
}
/** A name a person gave a file, safe as one file name: no folders, no control characters, never empty. */
export function downloadName(name: string, fallback = "download"): string {
  const clean = String(name || "").split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f<>:"|?*]+/g, " ").replace(/\s+/g, " ").trim();
  return clean.replace(/^\.+/, "").slice(0, 200) || fallback;
}
const sizeWords = (n: number) => (n >= 1024 * 1024 * 1024 ? `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`
  : n >= 1024 * 1024 ? `${Math.round(n / 1024 / 1024)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
/** Said when a file is too large for the page to carry. */
export function tooLargeWords(name: string, bytes: number): string {
  return `${downloadName(name)} is ${sizeWords(bytes)}: larger than the ${sizeWords(MAX_DOWNLOAD_BYTES)} a download from DGC's pages can carry.`;
}

async function post(page: DownloadPage, message: unknown): Promise<boolean> {
  try {
    const done = typeof page === "function" ? page(message) : page.postMessage(message);
    return (await done) !== false;
  } catch { return false; }
}

/** Hand `bytes` to the page as a file named `name`, for it to save on the person's computer. */
export async function downloadBytes(page: DownloadPage | undefined, name: string, bytes: Uint8Array, mime = ""): Promise<boolean> {
  const file = downloadName(name);
  if (savesWithDialog()) {
    if (bytes.byteLength > MAX_DOWNLOAD_BYTES) return throughBrowserBytes(file, bytes);
    const how = await saveWithDialog(file, bytes);
    if (how === "failed") return throughBrowserBytes(file, bytes);
    // (The page that asked says "Downloaded" beside its control; asked from a command, the editor says it.)
    if (page) await post(page, { type: DOWNLOAD_MESSAGE, name: file, [how]: true });
    else if (how === "saved") void vscode.window.showInformationMessage(`Downloaded “${file}”.`);
    return true;
  }
  if (!page) return downloadMade(undefined, file, async (target) => { await writeFile(target, bytes, { mode: 0o600 }); }, mime);
  if (bytes.byteLength > MAX_DOWNLOAD_BYTES) { void vscode.window.showWarningMessage(tooLargeWords(file, bytes.byteLength)); return false; }
  // (A Uint8Array crosses to the page as bytes, not as text; a view into a larger buffer, such as a pooled Buffer, is
  // copied first, so nothing beside it goes too.)
  const exact = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
  const data = exact ? new Uint8Array(bytes.buffer) : new Uint8Array(bytes);
  return post(page, { type: DOWNLOAD_MESSAGE, name: file, mime: mime || downloadType(file), data });
}

/** Hand a file on this machine to the page. `name` is the name it is saved under (the file's own when not given). One
 *  larger than a page can carry, or asked from a command with no page (`page` undefined), goes to the person's own
 *  browser instead, which saves it on their computer too. */
export async function downloadFile(page: DownloadPage | undefined, path: string, name = "", mime = ""): Promise<boolean> {
  const file = downloadName(name || path.split(/[\\/]/).pop() || "");
  // (Read through the editor's own file system, as every other read of a kept file is.)
  const uri = vscode.Uri.file(path), info = await vscode.workspace.fs.stat(uri);
  if (typeof info.type === "number" && (info.type & (vscode.FileType?.File ?? 1)) === 0) throw new Error(`${file} isn't a file.`);
  if ((!page && !savesWithDialog()) || info.size > MAX_DOWNLOAD_BYTES) {
    const opened = await downloadThroughBrowser(path, file);
    if (opened) void vscode.window.showInformationMessage(`Downloading “${file}” in your browser (${sizeWords(info.size)}).`);
    return opened;
  }
  return downloadBytes(page, file, await vscode.workspace.fs.readFile(uri), mime);
}

/** A file DGC makes for this download: `make(target)` asks DGC to write it at `target`, a path in a private folder made
 *  for this one download (0700, removed after). It may answer with another path it wrote instead. */
export async function downloadMade(page: DownloadPage | undefined, name: string, make: (target: string) => Promise<string | void>, mime = ""): Promise<boolean> {
  const file = downloadName(name);
  const folder = await mkdtemp(join(tmpdir(), "dgc-download-"));
  let later = false;
  try {
    const target = join(folder, file);
    const wrote = await make(target);
    const path = typeof wrote === "string" && wrote ? wrote : target;
    // (A file the browser is given is read for a few minutes: its folder goes after them.)
    later = path.startsWith(folder) && ((!page && !savesWithDialog()) || (await stat(path)).size > MAX_DOWNLOAD_BYTES);
    return await downloadFile(page, path, file, mime);
  } finally {
    const gone = () => rm(folder, { recursive: true, force: true }).catch(() => undefined);
    if (later) setTimeout(() => void gone(), (DOWNLOAD_MINUTES + 1) * 60_000).unref?.(); else await gone();
  }
}

// ---- the editor's desktop app: its own Save dialog, on the person's computer ----------------------------------------
/** Where the last download was saved, per disk ("file" here, "vscode-local" from a remote window): the dialog starts there. */
const FOLDER_KEY = "dgc.downloadFolders";
let memory: vscode.Memento | undefined;
/** The extension's own store, for the folder the dialog starts in (set once, at activation). */
export function rememberDownloadsIn(store: vscode.Memento | undefined): void { memory = store; }

/** Whether this editor saves a download with its own dialog: its desktop app (a page there can't start a download). */
export function savesWithDialog(): boolean {
  const desktop = vscode.UIKind?.Desktop;
  return desktop !== undefined && vscode.env?.uiKind === desktop;
}

/** Where the dialog starts, on the person's own disk: the folder of their last download there, else Downloads (in a
 *  remote window that computer's folders aren't known here until the first save: it starts at the top of the disk). */
export function dialogStart(name: string): vscode.Uri {
  const remote = !!vscode.env?.remoteName, scheme = remote ? "vscode-local" : "file";
  const last = memory?.get<Record<string, string>>(FOLDER_KEY)?.[scheme];
  if (remote) {
    const folder = typeof last === "string" && last.startsWith("/") ? last.replace(/\/+$/, "") : "";
    return vscode.Uri.from({ scheme, path: `${folder}/${name}` });
  }
  const downloads = join(homedir(), "Downloads");
  const folder = typeof last === "string" && last && existsSync(last) ? last : existsSync(downloads) ? downloads : homedir();
  return vscode.Uri.file(join(folder, name));
}

/** Save `bytes` as `name` with the editor's own Save dialog. "failed" when the editor couldn't (the caller then hands it
 *  to the person's browser). */
export async function saveWithDialog(name: string, bytes: Uint8Array): Promise<"saved" | "cancelled" | "failed"> {
  let target: vscode.Uri | undefined;
  try {
    target = await vscode.window.showSaveDialog({ title: `Download “${name}”`, saveLabel: "Download", defaultUri: dialogStart(name) });
  } catch { return "failed"; }
  if (!target) return "cancelled";
  try { await vscode.workspace.fs.writeFile(target, bytes); } catch { return "failed"; }
  try {
    const folder = target.scheme === "file" ? join(target.fsPath, "..") : target.path.replace(/\/[^/]*$/, "") || "/";
    void memory?.update(FOLDER_KEY, { ...(memory.get<Record<string, string>>(FOLDER_KEY) || {}), [target.scheme]: folder });
  } catch { /* the next dialog starts in Downloads again */ }
  return "saved";
}

/** Bytes the editor couldn't save, to the person's browser instead (written to a private folder for a few minutes). */
async function throughBrowserBytes(file: string, bytes: Uint8Array): Promise<boolean> {
  const folder = await mkdtemp(join(tmpdir(), "dgc-download-"));
  const gone = () => void rm(folder, { recursive: true, force: true }).catch(() => undefined);
  try {
    const path = join(folder, file);
    await writeFile(path, bytes, { mode: 0o600 });
    const opened = await downloadThroughBrowser(path, file).catch(() => false);
    if (opened) void vscode.window.showInformationMessage(`Downloading “${file}” in your browser (${sizeWords(bytes.byteLength)}).`);
    else void vscode.window.showWarningMessage(`“${file}” wasn't downloaded: the editor couldn't save it, and no browser opened.`);
    setTimeout(gone, (DOWNLOAD_MINUTES + 1) * 60_000).unref?.();
    return opened;
  } catch (err) { gone(); throw err; }
}

// ---- a page's own file: sent to its host, saved the same way --------------------------------------------------------
/** The bytes of a page's own file, however they crossed: bytes, a list of byte values, or a data: URI. */
export function pageBytes(data: unknown): Uint8Array | undefined {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  const byte = (n: unknown) => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 255;
  const list = Array.isArray(data) ? data : data && typeof data === "object" && Array.isArray((data as any).data) ? (data as any).data : null;
  if (list) return list.length && list.length <= MAX_DOWNLOAD_BYTES && list.every(byte) ? Uint8Array.from(list) : undefined;
  if (data && typeof data === "object" && byte((data as any)[0])) {
    const out: number[] = [];
    for (let i = 0; i in (data as any); i++) { if (!byte((data as any)[i]) || i >= MAX_DOWNLOAD_BYTES) return undefined; out.push((data as any)[i]); }
    return Uint8Array.from(out);
  }
  if (typeof data !== "string") return undefined;
  const m = /^data:([^;,]*)((?:;[^;,]*)*?)(;base64)?,(.*)$/s.exec(data);
  if (!m) return undefined;
  try { return m[3] ? Buffer.from(m[4].replace(/\s+/g, ""), "base64") : Buffer.from(decodeURIComponent(m[4]), "utf8"); } catch { return undefined; }
}

/** A page's "save this" (SAVE_MESSAGE): true when it was one (the host's router stops there). Saved like any download,
 *  and the answer goes back to `page`, which says so beside the control that asked. */
export function takeSave(page: DownloadPage, message: any): boolean {
  if (!message || typeof message !== "object" || message.type !== SAVE_MESSAGE) return false;
  const name = downloadName(String(message.name || ""), "download");
  const bytes = pageBytes(message.data);
  const mime = typeof message.mime === "string" && /^[a-z]+\/[A-Za-z0-9.+-]+$/.test(message.mime) ? message.mime
    : (typeof message.data === "string" ? /^data:([a-z]+\/[A-Za-z0-9.+-]+)/.exec(message.data)?.[1] : "") || "";
  if (!bytes || !bytes.byteLength) { void post(page, { type: DOWNLOAD_MESSAGE, name, failed: true }); return true; }
  void downloadBytes(page, name, bytes, mime).catch((err) => {
    void vscode.window.showWarningMessage(`“${name}” wasn't downloaded: ${String(err?.message || err)}`);
  });
  return true;
}

// ---- a file too large for a page: the person's own browser downloads it ----------------------------------------------
/** How long a download address answers with its file. */
export const DOWNLOAD_MINUTES = 5;
const downloads = new Map<string, { path: string; encoded: string; until: number }>();
let downloadServer: Promise<number> | undefined;
const attr = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const goneWords = (name: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>This download link has ended</title></head><body style="font:15px/1.5 system-ui,sans-serif;max-width:34em;margin:15vh auto;padding:0 20px"><h1 style="font-size:20px">This download link has ended</h1><p>The link for “${attr(name)}” worked for ${DOWNLOAD_MINUTES} minutes. In DGC, choose Download again to get a new one.</p></body></html>`;
/** The one listener every download address is on. It stays for as long as the window does, so an address that has ended
 *  is answered in words: a forwarded port with nothing listening behind it leaves the browser waiting for ever. */
function downloadPort(): Promise<number> {
  return downloadServer ??= new Promise<number>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const now = Date.now();
      // An address that has ended is remembered for a day, to say so; then, and past a few hundred, it is forgotten.
      for (const [key, entry] of downloads) if (entry.until + 24 * 3_600_000 <= now || downloads.size > 400) downloads.delete(key); else break;
      const parts = /^\/([a-f0-9]{48})\/([^/?#]+)$/.exec(req.url || "");
      const plain = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
      if ((req.method !== "GET" && req.method !== "HEAD") || !parts) { res.writeHead(404, plain); res.end(); return; }
      const entry = downloads.get(parts[1]);
      if (!entry || entry.encoded !== parts[2]) { res.writeHead(404, plain); res.end(); return; }      // only with its token
      let size = -1;
      if (entry.until > now) { try { size = statSync(entry.path).size; } catch { size = -1; } }
      if (size < 0) {
        // Past its few minutes, or its file has gone: said in words, with what to do.
        const page = goneWords(decodeURIComponent(entry.encoded).slice(0, 120));
        res.writeHead(410, { ...plain, "Content-Type": "text/html; charset=utf-8", "Content-Length": String(Buffer.byteLength(page)) });
        res.end(req.method === "HEAD" ? undefined : page);
        return;
      }
      res.writeHead(200, { ...plain, "Content-Type": "application/octet-stream", "Content-Length": String(size),
        "Content-Disposition": `attachment; filename*=UTF-8''${entry.encoded}` });
      if (req.method === "HEAD") { res.end(); return; }
      const stream = createReadStream(entry.path);
      stream.on("error", () => res.destroy());
      stream.pipe(res);
    });
    server.once("error", (error) => { downloadServer = undefined; reject(error); });
    server.listen(0, "127.0.0.1", () => { server.unref(); resolve((server.address() as { port: number }).port); });
  });
}

/** One file, to the browser on the person's own computer (a file too large for a page to carry). An address on the
 *  machine that made it, forwarded like any other, answers with an attachment. It holds only this file, behind a token
 *  nobody else has, for a few minutes: a second click in that time downloads it again (a browser may itself ask twice),
 *  and after it the address says in words that it has ended. It never just stops answering. */
export async function downloadThroughBrowser(path: string, name: string, now: () => number = Date.now): Promise<boolean> {
  const token = randomBytes(24).toString("hex");
  const encoded = encodeURIComponent(name);
  statSync(path);                                    // a file that isn't there fails here, where the caller says so
  const port = await downloadPort();
  downloads.set(token, { path, encoded, until: now() + DOWNLOAD_MINUTES * 60_000 });
  const external = await vscode.env.asExternalUri(vscode.Uri.parse(`http://127.0.0.1:${port}/${token}/${encoded}`, true));
  const opened = await vscode.env.openExternal(external);
  if (!opened) downloads.delete(token);
  return opened;
}

/** A data: URI of a picture (or any type) the page itself sent, as bytes; undefined when it isn't one. */
export function dataUriBytes(data: unknown, types = /^[a-z]+\/[A-Za-z0-9.+-]+$/): { mime: string; bytes: Uint8Array } | undefined {
  const m = typeof data === "string" ? /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(data) : null;
  if (!m || !types.test(m[1])) return undefined;
  return { mime: m[1], bytes: Buffer.from(m[2], "base64") };
}

/** Stored files, as one .zip (no compression: notes are small text). Each name is one path part. */
export function zipFiles(files: { name: string; bytes: Uint8Array }[], now = new Date()): Uint8Array {
  const table = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) c = table[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts: Uint8Array[] = [], central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(downloadName(f.name, "file"), "utf8"), sum = crc(f.bytes), size = f.bytes.byteLength;
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(sum, 14); local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28); name.copy(local, 30);
    const entry = Buffer.alloc(46 + name.length);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(0, 10); entry.writeUInt16LE(time, 12); entry.writeUInt16LE(date, 14); entry.writeUInt32LE(sum, 16);
    entry.writeUInt32LE(size, 20); entry.writeUInt32LE(size, 24); entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(offset, 42);
    name.copy(entry, 46);
    parts.push(local, f.bytes); central.push(entry);
    offset += local.length + size;
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}
