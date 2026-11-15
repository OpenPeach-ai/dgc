import * as vscode from "vscode";

const PIP_TYPES = ["core", "scout", "lens", "patch", "rook", "pulse", "lock", "quill"];
const MARK_KINDS = ["plugin", "artifact", "pip", "skill", "template", "file", "command"];
const IDENTITY = /^[A-Za-z0-9._:-]{1,128}$/;

/** The display-only marks a prompt box sent (media/mentions.js), or undefined. Cosmetic data: the backend checks them
 *  against the text once more, and anything off leaves the plain words in the bubble. `more`: kinds only this surface
 *  sends (a Personal Pip's chat names a project, Pips API 91). */
export function displayMentions(value: unknown, more: string[] = []): unknown[] | undefined {
  if (!Array.isArray(value) || !value.length || value.length > 24) return undefined;
  const fine = value.every((m: any) => m && typeof m === "object" && Number.isInteger(m.start) && m.start >= 0
    && (MARK_KINDS.includes(m.kind) || more.includes(m.kind)) && typeof m.label === "string" && m.label.length > 0 && m.label.length <= 120
    && typeof m.identity === "string" && IDENTITY.test(m.identity)
    && (m.kind !== "pip" || PIP_TYPES.includes(m.pip_type)) && (m.wired === undefined || m.wired === true));
  return fine ? value : undefined;
}

// ---- what "@" offers: ONE filter for Work, ChatDGC and Pips (user test W16/C8) ---------------------------------------
// A box's @ list is for the files someone would hand to a model. It never offers a secret (.env and its variants, a
// private key) or what a tool wrote beside the source (caches, a virtual environment, build output, dependencies).
// .env.example and .env.sample are fine: they are written to be read.
const NEVER_FOLDERS = ["node_modules", ".git", "dist", "out", ".next", "venv", ".venv", "__pycache__", "build", "target", ".mypy_cache", ".pytest_cache", ".tox", "coverage"];
const NEVER_ENDINGS = [".pem", ".key", ".pyc", ".pyo"];
const NEVER_NAMES = [".env", ".ds_store"];
const KEY_STARTS = ["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"];     // an SSH key, and its .pub beside it
const ENV_FINE = [".env.example", ".env.sample"];
/** What findFiles leaves out itself, so none of it counts against the list's size. (.env.* is not here: a glob can't
 *  keep .env.example while dropping the rest; mentionOffered does.) */
const NEVER_GLOBS = [...NEVER_FOLDERS.map((f) => `**/${f}/**`), ...NEVER_ENDINGS.map((e) => `**/*${e}`), "**/.env", "**/.DS_Store", ...KEY_STARTS.map((k) => `**/${k}*`)];

/** Whether a box's @ list may offer this file. `path`: relative to its folder, with either separator. */
export function mentionOffered(path: string): boolean {
  const parts = String(path).toLowerCase().split(/[\\/]+/).filter(Boolean), name = parts.pop() || "";
  if (!name || parts.some((folder) => NEVER_FOLDERS.includes(folder))) return false;
  if (NEVER_NAMES.includes(name) || NEVER_ENDINGS.some((e) => name.endsWith(e)) || KEY_STARTS.some((k) => name.startsWith(k))) return false;
  if (name.startsWith(".env.") && !ENV_FINE.includes(name)) return false;
  return true;
}

/** Real source first: 0 for a file someone wrote; 1 for one in a hidden folder or hidden itself (.github/, .vscode/,
 *  .env.example), a lock file, a built bundle or its map. Each group is listed by name. */
function mentionRank(path: string): number {
  const parts = path.toLowerCase().split(/[\\/]+/), name = parts[parts.length - 1] || "";
  if (parts.some((part) => part.startsWith("."))) return 1;
  return /(^|[-.])lock(\.json|\.yaml|\.yml|b)?$|\.lock$|\.min\.(js|css)$|\.map$/.test(name) ? 1 : 0;
}

/** One files.exclude pattern as a test of a relative path: VS Code's glob (** across folders, * and ? within a name,
 *  {a,b}, [..]). A pattern that hides a folder hides what is in it. undefined for one this can't read. */
function excludeTest(pattern: string): ((path: string) => boolean) | undefined {
  let source = "", depth = 0;
  const glob = pattern.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!glob || glob.length > 400) return undefined;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") { const whole = (i === 0 || glob[i - 1] === "/") && (glob[i + 2] === "/" || i + 2 >= glob.length);
        if (whole && glob[i + 2] === "/") { source += "(?:.*/)?"; i += 2; } else { source += ".*"; i += 1; } }
      else source += "[^/]*";
    } else if (c === "?") source += "[^/]";
    else if (c === "{") { source += "(?:"; depth++; }
    else if (c === "}" && depth) { source += ")"; depth--; }
    else if (c === "," && depth) source += "|";
    else if (c === "[") { const end = glob.indexOf("]", i + 1); if (end < 0) return undefined; source += "[" + glob.slice(i + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\") + "]"; i = end; }
    else source += c.replace(/[.+^$()|\\\]]/g, "\\$&");
  }
  if (depth) return undefined;
  let test: RegExp;
  try { test = new RegExp(`^${source}(?:/.*)?$`); } catch { return undefined; }
  return (path) => test.test(path);
}

/** The user's own files.exclude, as it stands for the window and each of its folders: the patterns switched on (one
 *  with a condition hides nothing by itself). findFiles drops this setting as soon as a caller names an exclude, so
 *  the list keeps it itself. */
function userExcludes(): string[] {
  const found = new Set<string>();
  const read = (scope?: vscode.Uri) => {
    let value: unknown;
    try { value = vscode.workspace.getConfiguration("files", scope).get("exclude"); } catch { value = undefined; }
    if (value && typeof value === "object") for (const [pattern, on] of Object.entries(value as Record<string, unknown>)) if (on === true && typeof pattern === "string" && pattern.trim()) found.add(pattern.trim());
  };
  read();
  for (const folder of vscode.workspace.workspaceFolders || []) read(folder.uri);
  return [...found].slice(0, 200);
}

/** The files of this window's folders, as a box's @ list offers them: Work's, ChatDGC's and a Pip's alike. */
export async function workspaceFiles(): Promise<{ label: string; uri: string; path: string; relative_path: string; workspace: string }[]> {
  const mine = userExcludes();
  // (A user's pattern goes into the glob only where it can't break it: no braces or commas of its own. Every one of
  //  them is applied again below, so one that stayed out of the glob still hides its files.)
  const plain = mine.filter((p) => !/[{},]/.test(p)).map((p) => p.replace(/\\/g, "/").replace(/\/+$/, "")).filter(Boolean);
  const exclude = `{${[...NEVER_GLOBS, ...plain.flatMap((p) => [p, `${p}/**`])].join(",")}}`;
  const hidden = mine.map(excludeTest).filter((t): t is (path: string) => boolean => !!t);
  const uris = await vscode.workspace.findFiles("**/*", exclude, 600);
  const multiRoot = (vscode.workspace.workspaceFolders?.length || 0) > 1;
  return uris.map((uri) => {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    return {
      label: vscode.workspace.asRelativePath(uri, multiRoot),
      uri: uri.toString(),
      path: uri.fsPath,
      relative_path: folder ? vscode.workspace.asRelativePath(uri, false) : uri.fsPath,
      workspace: folder?.name || "",
    };
  }).filter((file) => { const inFolder = file.relative_path.replace(/\\/g, "/"); return mentionOffered(inFolder) && !hidden.some((hides) => hides(inFolder)); })
    .sort((a, b) => mentionRank(a.relative_path) - mentionRank(b.relative_path) || a.label.localeCompare(b.label));
}
