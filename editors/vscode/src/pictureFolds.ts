// Pictures and videos folded in a reply (media/pictureFold.js), kept by the extension so a choice holds after a reload
// and when a chat or session is opened again: one small map in the extension's global state, the newest choices kept.
// The default for a block nobody chose for is Settings -> General -> Pictures in replies (dgc.picturesInReplies).
import * as vscode from "vscode";

const STORE = "dgc.pictureFolds";
const KEEP = 2000;
const KEY = /^[a-z]{1,8}:[A-Za-z0-9_.:-]{1,280}$/;

/** Settings -> General -> Pictures in replies: Folded. */
export function picturesFolded(): boolean {
  try {
    return vscode.workspace.getConfiguration("dgc")?.get?.<string>("picturesInReplies", "shown") === "folded";
  } catch {
    return false;
  }
}

/** The message a page takes (DgcPictureFold.message): every choice kept, and the setting. */
export function pictureFoldsMessage(context: vscode.ExtensionContext): { type: "pictureFolds"; folds: Record<string, boolean>; folded: boolean } {
  const saved = context?.globalState?.get?.<Record<string, boolean>>(STORE);
  const folds: Record<string, boolean> = {};
  if (saved && typeof saved === "object") {
    for (const [key, value] of Object.entries(saved)) if (KEY.test(key) && typeof value === "boolean") folds[key] = value;
  }
  return { type: "pictureFolds", folds, folded: picturesFolded() };
}

/** A page's {type: "pictureFold", key, folded}: kept (the oldest choices go past KEEP). False when it isn't one. */
export function rememberPictureFold(context: vscode.ExtensionContext, message: any): boolean {
  if (!message || message.type !== "pictureFold") return false;
  const key = String(message.key || "");
  if (!KEY.test(key) || typeof message.folded !== "boolean") return true;
  if (typeof context?.globalState?.update !== "function") return true;
  const saved = { ...(context.globalState.get<Record<string, boolean>>(STORE) || {}) };
  delete saved[key];
  saved[key] = message.folded;
  const keys = Object.keys(saved);
  for (const old of keys.slice(0, Math.max(0, keys.length - KEEP))) delete saved[old];
  void context.globalState.update(STORE, saved);
  return true;
}

/** Calls `send` with the setting whenever Settings change it (each page follows it for the blocks nobody chose). */
export function onPicturesSetting(send: (message: { type: "pictureFolds"; folded: boolean }) => void): vscode.Disposable {
  if (typeof vscode.workspace?.onDidChangeConfiguration !== "function") return { dispose() { /* nothing to stop */ } };
  return vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("dgc.picturesInReplies")) send({ type: "pictureFolds", folded: picturesFolded() });
  });
}

/** Settings -> General's choice: Shown or Folded, for every window. */
export async function setPicturesInReplies(value: unknown): Promise<void> {
  if (value !== "shown" && value !== "folded") return;
  await vscode.workspace.getConfiguration("dgc").update("picturesInReplies", value, vscode.ConfigurationTarget.Global);
}
