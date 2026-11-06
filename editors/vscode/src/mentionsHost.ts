import * as vscode from "vscode";

const PIP_TYPES = ["core", "scout", "lens", "patch", "rook", "pulse", "lock", "quill"];
const MARK_KINDS = ["plugin", "artifact", "pip", "skill", "template", "file", "command"];
const IDENTITY = /^[A-Za-z0-9._:-]{1,128}$/;

/** The display-only marks a prompt box sent (media/mentions.js), or undefined. Cosmetic data: the backend checks them
 *  against the text once more, and anything off leaves the plain words in the bubble. */
export function displayMentions(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value) || !value.length || value.length > 24) return undefined;
  const fine = value.every((m: any) => m && typeof m === "object" && Number.isInteger(m.start) && m.start >= 0
    && MARK_KINDS.includes(m.kind) && typeof m.label === "string" && m.label.length > 0 && m.label.length <= 120
    && typeof m.identity === "string" && IDENTITY.test(m.identity)
    && (m.kind !== "pip" || PIP_TYPES.includes(m.pip_type)) && (m.wired === undefined || m.wired === true));
  return fine ? value : undefined;
}

/** The files of this window's folders, as a box's @ list offers them. */
export async function workspaceFiles(): Promise<{ label: string; uri: string; path: string; relative_path: string; workspace: string }[]> {
  const uris = await vscode.workspace.findFiles("**/*", "**/{node_modules,.git,dist,out,.venv,.next}/**", 600);
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
  }).sort((a, b) => a.label.localeCompare(b.label));
}
