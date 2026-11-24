// "What's new in 0.52" (pips-flow-design §3.3, item 1), the extension's half: when the side bar shows it by itself, and
// that it never does again. The dialog is the page's (media/shared/whatsnew.js).
//
// It shows once, the first time this release's side bar is up. ×, Done, Esc or a slide's own action is remembered in
// the editor's global state, which every window of this editor shares, and read again each time the side bar comes
// up: a window that was already open doesn't show it after another one answered. The mark names the release, so a
// later release shows its own. "DGC: What's New" (the DGC view's ⋯ menu) opens it again whenever asked, and changes
// nothing that was kept.
import type * as vscode from "vscode";

/** The release whose news this build carries. */
export const WHATS_NEW_RELEASE = "0.52";
/** The release whose news was last answered (×, Done, Esc or a slide's own action), in the editor's global state. */
export const WHATS_NEW_KEY = "dgc.whatsNewSeen";

type Kept = { globalState?: Pick<vscode.Memento, "get" | "update"> };

/** Whether this release's news has not been answered in this editor yet. */
export function whatsNewDue(context: Kept): boolean {
  try { return context?.globalState?.get?.(WHATS_NEW_KEY) !== WHATS_NEW_RELEASE; } catch { return false; }
}

/** ×, Done, Esc or a slide's own action: never by itself again, in any window of this editor. */
export async function whatsNewAnswered(context: Kept): Promise<void> {
  try { await context?.globalState?.update?.(WHATS_NEW_KEY, WHATS_NEW_RELEASE); } catch { /* kept for this window's page still */ }
}

/** What the page is told: open the dialog. `auto`: by itself, the first time; false from the menu. */
export function whatsNewMessage(auto: boolean): { type: "whatsNew"; auto: boolean; release: string } {
  return { type: "whatsNew", auto, release: WHATS_NEW_RELEASE };
}

/** Where a slide's own action goes (Open Pips, Open Your Browser, Open Library, Open Work, Open Settings): the side bar's
 *  own tabs, as Home's buttons open them; Your Browser, as the dock's tile opens it (and Home's Cards library, for a
 *  page that asks for it); DGC's Settings tab. What the page or the host is told, or null for a place it doesn't know
 *  (the news is still answered: the page has closed it). */
const WHATS_NEW_PLACES: Record<string, { tab: string; open?: string }> = {
  pips: { tab: "pips" }, "home-cards": { tab: "home", open: "cards" }, browser: { tab: "home", open: "browser" }, library: { tab: "library" }, work: { tab: "work" },
};
export function whatsNewGoMessage(to: unknown): { type: "sideTab"; tab: string; open?: string } | { type: "openSettings" } | null {
  if (to === "settings") return { type: "openSettings" };
  const place = typeof to === "string" && Object.prototype.hasOwnProperty.call(WHATS_NEW_PLACES, to) ? WHATS_NEW_PLACES[to] : null;
  return place ? { type: "sideTab", ...place } : null;
}
