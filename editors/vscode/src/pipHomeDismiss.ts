// Dismiss all on the home's Pips row (src/pipHomeStrip.js): what was unread when it was dismissed, per Pip, kept in the
// extension's global state so a reload doesn't bring the old count back. Nothing here marks a message read: the Pips page
// still shows every one until its chat is opened. The home drops a Pip's entry once it is read, or its Pip is gone.
import type * as vscode from "vscode";

const STORE = "dgc.pipHomeDismissed";
const KEEP = 500;
const PIP = /^pip_[a-f0-9]{32}$/;
const WORKSPACE = /^ws_[a-f0-9]{32}$/;
const ID = /^[A-Za-z0-9_|-]{1,260}$/;

/** A Pip's unread when it was dismissed: its project, and each feed's count and newest id (messages, run posts). */
export type PipHomeSnapshot = { w: string; m: number; mid: string | null; p: number; pid: string | null };

const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 1_000_000;
const id = (value: unknown) => value === null || (typeof value === "string" && ID.test(value));

/** One entry, checked: anything malformed is left out, never half-kept. */
export function pipHomeSnapshot(value: any): PipHomeSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.w !== "string" || !WORKSPACE.test(value.w) || !count(value.m) || !count(value.p) || !id(value.mid) || !id(value.pid)) return null;
  return { w: value.w, m: value.m, mid: value.mid, p: value.p, pid: value.pid };
}

function kept(context: vscode.ExtensionContext): Record<string, PipHomeSnapshot> {
  const saved = context?.globalState?.get?.<Record<string, unknown>>(STORE);
  const out: Record<string, PipHomeSnapshot> = {};
  if (saved && typeof saved === "object") {
    for (const [pip, value] of Object.entries(saved)) {
      const snapshot = PIP.test(pip) ? pipHomeSnapshot(value) : null;
      if (snapshot) out[pip] = snapshot;
    }
  }
  return out;
}

/** The home page's attribute: every Pip dismissed there, read when the page is built (a reload builds it again). */
export function pipHomeDismissedAttr(context: vscode.ExtensionContext): string {
  const value = kept(context);
  if (!Object.keys(value).length) return "";
  const json = JSON.stringify(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return ` data-pip-home-dismissed="${json}"`;
}

/** The home's {type: "pipHomeDismissed", set, drop}: entries kept or dropped (the oldest go past KEEP). False when it isn't one. */
export function rememberPipHomeDismissed(context: vscode.ExtensionContext, message: any): boolean {
  if (!message || message.type !== "pipHomeDismissed") return false;
  if (typeof context?.globalState?.update !== "function") return true;
  const value = kept(context);
  for (const pip of Array.isArray(message.drop) ? message.drop.slice(0, KEEP) : []) if (typeof pip === "string") delete value[pip];
  const set = message.set && typeof message.set === "object" && !Array.isArray(message.set) ? message.set : {};
  for (const [pip, entry] of Object.entries(set).slice(0, KEEP)) {
    const snapshot = PIP.test(pip) ? pipHomeSnapshot(entry) : null;
    if (snapshot) { delete value[pip]; value[pip] = snapshot; }
  }
  const keys = Object.keys(value);
  for (const old of keys.slice(0, Math.max(0, keys.length - KEEP))) delete value[old];
  void Promise.resolve(context.globalState.update(STORE, value)).catch(() => { /* kept for this window still */ });
  return true;
}

// What Home shows (its Show filter: All, Work, Chat, Personal Pips, Project Pips): one word in the same global state, so
// the choice holds over a reload and in every window and folder on this computer until it is changed. It is not in the
// keys an editor syncs between computers. "all" is the default and is not kept.
const SHOW = "dgc.homeShow";
const SHOWS = ["work", "chat", "personal", "project"];

/** The home page's attribute when Home shows one source; nothing when it shows all. */
export function homeShowAttr(context: vscode.ExtensionContext): string {
  const kept = context?.globalState?.get?.<string>(SHOW);
  return typeof kept === "string" && SHOWS.includes(kept) ? ` data-home-show="${kept}"` : "";
}

/** The home's {type: "homeShow", show}: kept when it is one source, forgotten for "all". False when it isn't one. */
export function rememberHomeShow(context: vscode.ExtensionContext, message: any): boolean {
  if (!message || message.type !== "homeShow") return false;
  if (typeof context?.globalState?.update !== "function") return true;
  void Promise.resolve(context.globalState.update(SHOW, SHOWS.includes(message.show) ? message.show : undefined)).catch(() => { /* kept for this window still */ });
  return true;
}

// "A page made" on Home: what a Work session or a ChatDGC chat made (a page, a document, slides, a spreadsheet, a
// dashboard) and has not been opened or dismissed there, the newest first, in the same global state, so the cards are
// there after a reload of the side bar. A new version of one changes its entry; removed, opened or dismissed, the entry
// goes, and a later change to it does not bring it back. At most PAGES are kept; older ones drop off.
const MADE = "dgc.homePages";
const PAGES = 20;
const ARTIFACT = /^ar_[a-f0-9]{16}$/;
const KINDS = ["page", "doc", "slides", "sheet", "dashboard"];
const OPS = ["made", "changed", "restored"];
const WHERE = /^[A-Za-z0-9_.:-]{1,128}$/;

/** One thing made: its artifact, how it stands now, and where it was made ("" when nothing says). */
export type HomePage = { id: string; type: string; title: string; version: number; op: string; surface: "work" | "chat" | ""; where: string; at: number };

function homePage(value: any): HomePage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.id !== "string" || !ARTIFACT.test(value.id) || !KINDS.includes(value.type) || !OPS.includes(value.op)) return null;
  if (typeof value.title !== "string" || !Number.isSafeInteger(value.version) || value.version < 1 || !Number.isFinite(value.at)) return null;
  const surface = value.surface === "work" || value.surface === "chat" ? value.surface : "";
  return { id: value.id, type: value.type, title: value.title.slice(0, 200), version: value.version, op: value.op, surface,
    where: surface && typeof value.where === "string" && WHERE.test(value.where) ? value.where : "", at: value.at };
}

/** What Home holds of the things made, checked, the newest first. */
export function homePages(context: vscode.ExtensionContext): HomePage[] {
  const saved = context?.globalState?.get?.<unknown>(MADE);
  const out: HomePage[] = [], seen = new Set<string>();
  for (const value of Array.isArray(saved) ? saved : []) {
    const page = homePage(value);
    if (page && !seen.has(page.id)) { seen.add(page.id); out.push(page); }
  }
  return out.sort((a, b) => b.at - a.at).slice(0, PAGES);
}

function keepHomePages(context: vscode.ExtensionContext, pages: HomePage[]): void {
  if (typeof context?.globalState?.update !== "function") return;
  void Promise.resolve(context.globalState.update(MADE, pages)).catch(() => { /* kept for this window still */ });
}

/** The home page's attribute: the things made that are still on Home, read when the page is built. */
export function homePagesAttr(context: vscode.ExtensionContext): string {
  const value = homePages(context);
  if (!value.length) return "";
  const json = JSON.stringify(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return ` data-home-pages="${json}"`;
}

/**
 * An artifact changed (artifacts.ts's {type: "artifactChanged", artifact, op, surface, conversation_id}). Made in Work
 * or in a chat, or with nothing saying where: it is on Home, the newest. A new version or name of one already there:
 * its entry says so. Removed: its entry goes. Returns what Home holds now, or null when that is as it was (a Pip's, an
 * app's or the terminal's own; a change to one that has no card).
 */
export function noteHomePage(context: vscode.ExtensionContext, message: any, now = Date.now()): HomePage[] | null {
  const a = message?.artifact, op = String(message?.op || "");
  if (!a || typeof a !== "object" || typeof a.id !== "string" || !ARTIFACT.test(a.id) || !KINDS.includes(a.type)) return null;
  const pages = homePages(context), at = pages.findIndex((page) => page.id === a.id), old = at >= 0 ? pages[at] : null;
  if (op === "removed") {
    if (!old) return null;
    pages.splice(at, 1);
    keepHomePages(context, pages);
    return pages;
  }
  const version = Number.isSafeInteger(a.version) && a.version > 0 ? a.version : 1;
  const title = typeof a.title === "string" ? a.title.slice(0, 200) : "";
  // Where it was made, as the Library reads it (the artifact's own origin), else what the event itself says.
  const origin = a.origin && typeof a.origin === "object" ? a.origin : {};
  const said = typeof origin.surface === "string" && origin.surface ? origin.surface : typeof message.surface === "string" ? message.surface : "";
  let next: HomePage;
  if (op === "made") {
    if (said && said !== "work" && said !== "chat") return null;
    const where = said === "work" ? origin.session : said === "chat" ? origin.chat ?? message.conversation_id : "";
    next = { id: a.id, type: a.type, title, version, op, surface: said as HomePage["surface"], where: typeof where === "string" && WHERE.test(where) ? where : "", at: now };
  } else {
    if (!old || (old.version === version && old.title === title)) return null;
    next = { ...old, title, version, ...(version !== old.version ? { op: OPS.includes(op) ? op : "changed", at: now } : {}) };
  }
  if (old) pages.splice(at, 1);
  // The newest is first, and stays first of two made in the same instant.
  if (next.at !== old?.at || op === "made") next.at = Math.max(next.at, (pages[0]?.at ?? -1) + 1);
  pages.push(next);
  pages.sort((x, y) => y.at - x.at);
  pages.length = Math.min(pages.length, PAGES);
  keepHomePages(context, pages);
  return pages;
}

/** The home's {type: "homePagesDismissed", ids}: opened or dismissed there, so no longer on Home. False when it isn't one. */
export function rememberHomePagesDismissed(context: vscode.ExtensionContext, message: any): boolean {
  if (!message || message.type !== "homePagesDismissed") return false;
  const ids = new Set((Array.isArray(message.ids) ? message.ids.slice(0, 200) : []).filter((id: unknown) => typeof id === "string"));
  const pages = homePages(context), left = pages.filter((page) => !ids.has(page.id));
  if (left.length !== pages.length) keepHomePages(context, left);
  return true;
}
