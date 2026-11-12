// The Project Folder dropdown's choice (0.52, 12 Nov): "All projects", or one folder. One choice shared by the Work
// sessions, Home, the Pips view's Project tab and Needs Attention for Project Pips, kept in the extension's own storage
// so the side bar, its tabs and every window agree, and a restart keeps it. "" is All projects, the default.
// DGC lists the folders (list_project_folders, Pips API 93) and every project's sessions (capability session_scopes):
// an older DGC has neither, and no dropdown.
import type * as vscode from "vscode";
import { homedir } from "os";
import { basename, isAbsolute } from "path";

export const PROJECT_FOLDER_KEY = "dgc.projectFolder.v1";
export const FOLDERS_API = 93;
const WORKSPACE = /^ws_[a-f0-9]{32}$/;

/** A folder DGC lists: one with a Work session or a Project Pip. `shown` has the home folder as ~. */
export interface FolderRow { folder: string; shown: string; name: string; here: boolean; exists: boolean; sessions: number; pips: number; workspace_id: string | null }

/** A folder's own name for a tab's title, at most 18 characters. */
export function folderLabel(folder: string): string {
  const name = basename(folder.replace(/[\\/]+$/, "")) || folder;
  return name.length > 18 ? `${name.slice(0, 17)}…` : name;
}

/** A folder as the lists show it: the home folder as ~ (its whole path is the tooltip). */
export function homeAsTilde(folder: string, home = homedir()): string {
  const base = home.replace(/[\\/]+$/, "");
  if (!base || !folder) { return folder; }
  if (folder === base) { return "~"; }
  return folder.startsWith(base + "/") || folder.startsWith(base + "\\") ? `~${folder.slice(base.length)}` : folder;
}

/** A folder by its full path, as DGC and the editor's folder picker give one: never a relative path. */
export function fullFolder(value: unknown): string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f]/.test(value) && isAbsolute(value) ? value : "";
}

/** Whether this DGC offers the dropdown: it lists every project's sessions, and the folders (Pips API 93). */
export function foldersOffered(capabilities: any): boolean {
  return capabilities?.session_scopes === true && capabilities?.pips_enabled === true && Number(capabilities?.pips_api_version) >= FOLDERS_API;
}

/** list_project_folders' answer, checked: full paths only, each once, 200 at most, in DGC's order (newest first). */
export function folderRows(result: unknown, home = homedir()): FolderRow[] {
  const seen = new Set<string>(), rows: FolderRow[] = [];
  for (const item of Array.isArray((result as any)?.folders) ? (result as any).folders : []) {
    const folder = fullFolder(item?.folder);
    if (!folder || seen.has(folder) || rows.length >= 200) { continue; }
    seen.add(folder);
    rows.push({ folder, shown: homeAsTilde(folder, home), name: String(typeof item.name === "string" && item.name ? item.name : basename(folder) || folder).slice(0, 200),
      here: item.here === true, exists: item.exists !== false, sessions: Number.isSafeInteger(item.sessions) && item.sessions > 0 ? item.sessions : 0,
      pips: Number.isSafeInteger(item.pips) && item.pips > 0 ? item.pips : 0,
      workspace_id: typeof item.workspace_id === "string" && WORKSPACE.test(item.workspace_id) ? item.workspace_id : null });
  }
  return rows;
}

/** The folder chosen, or "" for All projects (the default, and what anything unreadable is taken as). */
export function projectFolder(context: Pick<vscode.ExtensionContext, "globalState">): string {
  try { return fullFolder(context.globalState.get<unknown>(PROJECT_FOLDER_KEY)); } catch { return ""; }
}

/** Keeps the choice: "" (All projects) or a folder's full path. */
export function keepProjectFolder(context: Pick<vscode.ExtensionContext, "globalState">, folder: string): void {
  try { void Promise.resolve(context.globalState.update(PROJECT_FOLDER_KEY, fullFolder(folder) || undefined)).catch(() => { /* the next choice is kept */ }); } catch { /* the same */ }
}
