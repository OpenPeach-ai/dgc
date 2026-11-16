// What a file's menu asks for, done by the host, the same for every surface (media/shared/filemenu.js is the menu: a
// Library row's and a file card's in Work, ChatDGC and a Pip's chat). Six things: Open · Open in editor · Save a copy… ·
// Copy · Copy path · Reveal in file manager. A page names which file (by a reference its host gave it) and which of the
// six; the surface's own host finds the file and checks it, and then one of the two below does the rest:
//
//   keptFileAct     a file DGC keeps for a chat (what a Pip sent, what you attached, what a reply made), stored by its
//                   digest. It is never opened, edited or pointed at where it is kept: Open and Open in editor show a
//                   private copy under the file's own name, and Copy path and Reveal are not done at all.
//   projectFileAct  a file in your project (one you named with @, one a turn made): its real place, so all six.
//
// Copy puts a text file's text on the clipboard; a picture goes to the page as bytes, because only a page can write a
// picture to the clipboard. Any other kind is not copied (the menu shows that row off, with why).
import * as vscode from "vscode";
import { homedir } from "os";

export type FileAct = "open" | "editor" | "save" | "copy" | "path" | "reveal";
export const FILE_ACTS: ReadonlySet<string> = new Set(["open", "editor", "save", "copy", "path", "reveal"]);
const PICTURE = /\.(png|jpe?g|gif|webp|bmp)$/i;
// (media/shared/filemenu.js keeps the same list: what the menu offers is what this does.)
const TEXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|ya?ml|toml|ini|cfg|conf|env|log|xml|html?|css|scss|less|js|jsx|mjs|cjs|ts|tsx|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|fish|ps1|sql|r|lua|pl|tex|rst|srt|vtt|svg|diff|patch|gitignore|dockerfile|makefile)$/i;
/** What a file is, by its name: a picture, text, or anything else. */
export const fileKind = (name: string): "picture" | "text" | "other" =>
  (PICTURE.test(name) ? "picture" : TEXT.test(name) || /(^|[\\/])(Makefile|Dockerfile|LICENSE|README)$/.test(name) ? "text" : "other");
export const MAX_COPY_TEXT = 1024 * 1024, MAX_COPY_PICTURE = 20 * 1024 * 1024;

export interface FileActHost {
  /** A few words for the person ("Path copied"). */
  say(words: string): void;
  /** A picture to copy, as a data: URI, for the page's clipboard. */
  picture(data: string): void;
  /** A private folder (0700) for a copy that is opened; the same file opened again replaces its copy. */
  copyFolder(): Promise<string>;
}

const mimeOf = (name: string) => { const e = (PICTURE.exec(name)?.[1] || "png").toLowerCase(); return e === "jpg" || e === "jpeg" ? "image/jpeg" : `image/${e}`; };
/** A name a person gave a file, safe as one path part (no folders, no control characters). */
const ownName = (name: string) => String(name || "").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").trim().slice(0, 200) || "file";
async function copyOut(path: string, name: string, host: FileActHost): Promise<boolean> {
  const kind = fileKind(name), fs = await import("node:fs/promises");
  if (kind === "other") return false;
  const info = await fs.stat(path);
  if (kind === "picture") {
    if (info.size > MAX_COPY_PICTURE) { void vscode.window.showWarningMessage(`${name} is too large to copy. Use Save a copy… instead.`); return false; }
    host.picture(`data:${mimeOf(name)};base64,${(await fs.readFile(path)).toString("base64")}`);
    return true;
  }
  if (info.size > MAX_COPY_TEXT) { void vscode.window.showWarningMessage(`${name} is too long to copy. Use Save a copy… instead.`); return false; }
  // (Bytes that are not text are not put on the clipboard as if they were: it must read as UTF-8, with no control bytes.)
  let text = "";
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(await fs.readFile(path)); } catch { text = "\u0000"; }
  if (/[\u0000-\u0008\u000e-\u001a]/.test(text)) { void vscode.window.showWarningMessage(`${name} isn't text. Use Save a copy… instead.`); return false; }
  await vscode.env.clipboard.writeText(text);
  host.say("Text copied");
  return true;
}
async function saveCopy(path: string, name: string): Promise<boolean> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(homedir());
  const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(folder, name), saveLabel: "Save a copy" });
  if (!target) return false;
  await vscode.workspace.fs.copy(vscode.Uri.file(path), target, { overwrite: true });
  void vscode.window.showInformationMessage(`Saved ${target.path.split("/").pop()}.`);
  return true;
}

/** One of the six on a file DGC keeps for a chat. `kept.path` is where DGC keeps it (the caller asked DGC and checked
 *  it); `kept.name` is the name a person gave it. True when it was done. */
export async function keptFileAct(act: string, kept: { path: string; name: string }, host: FileActHost): Promise<boolean> {
  if (!FILE_ACTS.has(act)) return false;
  const name = ownName(kept.name);
  // Where it is kept is DGC's own: no path to hand out, nothing to reveal (the menu shows both off, and says why).
  if (act === "path" || act === "reveal") return false;
  if (act === "save") return saveCopy(kept.path, name);
  if (act === "copy") return copyOut(kept.path, name, host);
  if (act === "editor" && fileKind(name) !== "text") return false;
  // Open, Open in editor: a private copy under its own name (an edit to the kept file would break its digest).
  const fs = await import("node:fs/promises"), nodePath = await import("node:path");
  const folder = await host.copyFolder();
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  const target = nodePath.join(folder, name);
  await fs.copyFile(kept.path, target);
  await fs.chmod(target, 0o600);
  if (act === "editor") await vscode.window.showTextDocument(vscode.Uri.file(target), { preview: false });
  else await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(target), { preview: true });
  return true;
}

/** One of the six on a file in the project. `path` is the file itself, found inside the project by the caller. */
export async function projectFileAct(act: string, path: string, host: FileActHost): Promise<boolean> {
  if (!FILE_ACTS.has(act)) return false;
  const uri = vscode.Uri.file(path), name = path.split(/[\\/]/).pop() || "file";
  switch (act) {
    case "open": await vscode.commands.executeCommand("vscode.open", uri, { preview: true }); return true;
    case "editor":
      // Text opens as text, to stay; what an editor can't show as text opens in the editor that owns its kind.
      try { await vscode.window.showTextDocument(uri, { preview: false }); } catch { await vscode.commands.executeCommand("vscode.open", uri); }
      return true;
    case "save": return saveCopy(path, name);
    case "copy": return copyOut(path, name, host);
    case "path": await vscode.env.clipboard.writeText(path); host.say("Path copied"); return true;
    case "reveal": await vscode.commands.executeCommand("revealFileInOS", uri); return true;
  }
  return false;
}
