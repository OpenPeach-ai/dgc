// Lines of a chat that the user closed with their × (asked 24 Nov: a background command a restart stopped, with Run again,
// had no way out for someone who doesn't want it run). Kept by the extension so the line stays away after a reload, in
// another tab, and when the chat is opened again: one small list in the extension's global state, the newest kept.
// A line is named by what the page already names it by (its record's key, its state and its moment: media/main.js,
// restartNoteId), so the same line replayed from history is the same id.
import * as vscode from "vscode";

const STORE = "dgc.dismissedNotes";
const KEEP = 500;
const ID = /^[A-Za-z0-9_.-]{1,80}:[a-z_]{1,24}:\d{1,16}$/;

/** The message a page takes: every line closed so far. */
export function dismissedNotesMessage(context: vscode.ExtensionContext): { type: "dismissedNotes"; ids: string[] } {
  const saved = context?.globalState?.get?.<string[]>(STORE);
  return { type: "dismissedNotes", ids: Array.isArray(saved) ? saved.filter((id) => typeof id === "string" && ID.test(id)) : [] };
}

/** A page's {type: "dismissNote", id}: kept (the oldest go past KEEP). False when it isn't one. */
export function rememberDismissedNote(context: vscode.ExtensionContext, message: any): boolean {
  if (!message || message.type !== "dismissNote") return false;
  const id = String(message.id || "");
  if (!ID.test(id) || typeof context?.globalState?.update !== "function") return true;
  const saved = (context.globalState.get<string[]>(STORE) || []).filter((x) => typeof x === "string" && x !== id);
  saved.push(id);
  void context.globalState.update(STORE, saved.slice(-KEEP));
  return true;
}
