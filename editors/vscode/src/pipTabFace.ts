import * as vscode from "vscode";
import { readFileSync } from "fs";

/** The eight characters a Pip can wear (media/pips/plush.js draws them; a Pip's type is one, and so is a character
 *  chosen for it on its page). */
export const PIP_FACES = ["core", "scout", "lens", "patch", "rook", "pulse", "lock", "quill"];

const made = new Map<string, vscode.Uri>();

/** A Pip's face at rest as its chat tab's icon: media/pips/tab-faces/<character>.png (64 px, clear around it; drawn by
 *  scripts/render-pip-tab-faces.mjs from the page's own renderer), carried inside the URI, so there is nothing to
 *  fetch after a reload (see tabIcon.ts). A face is the same on a light tab and a dark one: the picture is the Pip's
 *  body in its own colours, with its eyes on it. undefined when it is not one of the eight, or its picture can't be
 *  read: the tab keeps the editor's plain icon. */
export function pipTabFace(extensionUri: vscode.Uri, character: unknown): { light: vscode.Uri; dark: vscode.Uri } | undefined {
  if (typeof character !== "string" || !PIP_FACES.includes(character)) return undefined;
  let uri = made.get(character);
  if (!uri) {
    try {
      const file = vscode.Uri.joinPath(extensionUri, "media", "pips", "tab-faces", `${character}.png`).fsPath;
      uri = vscode.Uri.parse(`data:image/png;base64,${readFileSync(file).toString("base64")}`);
    } catch { return undefined; }
    made.set(character, uri);
  }
  return { light: uri, dark: uri };
}

/** The character a Pip wears: the one chosen for it (its profile's body) when that is one of the eight, else its type's. */
export function pipFace(pipType: unknown, body: unknown): string {
  if (typeof body === "string" && PIP_FACES.includes(body)) return body;
  return typeof pipType === "string" && PIP_FACES.includes(pipType) ? pipType : "";
}
