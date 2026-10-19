import * as vscode from "vscode";
import { readFileSync } from "fs";

/** The editor-tab marks: DGC's three slashes (Work sessions) and ChatDGC's speech bubble. */
export type TabMark = "dgc-tab" | "chatdgc-tab";

const made = new Map<string, vscode.Uri>();

/** One of media/'s SVGs as a data: URI: the picture itself, not a link to the extension's file. */
function inline(extensionUri: vscode.Uri, name: string): vscode.Uri {
  const file = vscode.Uri.joinPath(extensionUri, "media", name);
  const key = String(file);
  let uri = made.get(key);
  if (!uri) {
    try {
      uri = vscode.Uri.parse(`data:image/svg+xml;base64,${readFileSync(file.fsPath).toString("base64")}`);
    } catch {
      uri = file;                                    // unreadable: the file, as before
    }
    made.set(key, uri);
  }
  return uri;
}

/** A tab's icon, light and dark, carried inside the URI. VS Code saves a tab's icon with the tab and, after a reload,
 *  draws it before the extension has revived the tab (a tab behind another is revived only when it is shown). A link
 *  to the extension's file fails then: in a remote window (Remote - SSH, Cursor's too) it is fetched from
 *  vscode-remote-resource://undefined:undefined/... until the connection is up, and after an update it names the old
 *  version's folder, so the tab comes back blank. A data: URI needs nothing fetched. */
export function tabIcon(extensionUri: vscode.Uri, mark: TabMark): { light: vscode.Uri; dark: vscode.Uri } {
  return { light: inline(extensionUri, `${mark}-light.svg`), dark: inline(extensionUri, `${mark}-dark.svg`) };
}
