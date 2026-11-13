// "What's new in 0.52" (pips-flow-design §3.3, item 1), the extension's half: when the side bar shows it by itself, and
// that it never does again. The dialog is the page's (media/shared/whatsnew.js).
//
// It shows once, the first time this release's side bar is up. Skip, Done or Esc is remembered in the editor's global
// state, which every window of this editor shares, and read again each time the side bar comes up: a window that was
// already open doesn't show it after another one answered. The mark names the release, so a later release shows its
// own. "DGC: What's New" (the DGC view's ⋯ menu) opens it again whenever asked, and changes nothing that was kept.
import type * as vscode from "vscode";

/** The release whose news this build carries. */
export const WHATS_NEW_RELEASE = "0.52";
/** The release whose news was last answered (Skip, Done or Esc), in the editor's global state. */
export const WHATS_NEW_KEY = "dgc.whatsNewSeen";

type Kept = { globalState?: Pick<vscode.Memento, "get" | "update"> };

/** Whether this release's news has not been answered in this editor yet. */
export function whatsNewDue(context: Kept): boolean {
  try { return context?.globalState?.get?.(WHATS_NEW_KEY) !== WHATS_NEW_RELEASE; } catch { return false; }
}

/** Skip, Done or Esc: never by itself again, in any window of this editor. */
export async function whatsNewAnswered(context: Kept): Promise<void> {
  try { await context?.globalState?.update?.(WHATS_NEW_KEY, WHATS_NEW_RELEASE); } catch { /* kept for this window's page still */ }
}

/** What the page is told: open the dialog. `auto`: by itself, the first time; false from the menu. */
export function whatsNewMessage(auto: boolean): { type: "whatsNew"; auto: boolean; release: string } {
  return { type: "whatsNew", auto, release: WHATS_NEW_RELEASE };
}
