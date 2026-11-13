// The "Open" pop-up (0.52; his ask, 14 Nov): whenever a Work, Chat or Pip turn makes or updates a page, a document,
// slides, a sheet or a dashboard, one editor notification says so with Open:
//
//   DGC made “Q3 plan”                                                                   [Open]
//
// Open opens it where DGC opens it: a document in its editor tab, everything else in its artifact tab (artifacts.ts).
//
// - Once per artifact and version, also across a reload: what was offered is kept in the editor's global state.
// - Never a stack. The editor can't take a notification back once it is shown, so only one of ours is on screen at a
//   time: while it is unanswered a newer one waits, and only the newest waits (the ones between are on Home and in
//   their chats). It shows when the first is answered or dismissed, or after the time the editor itself keeps a
//   notification on screen.
// - Not for the person's own doing (their edit, a restore, a removal, a refresh, this window's own save), nor for one
//   that is already open in a tab, nor for one that opens by itself beside the chat showing it.
//
// It hears what every screen hears (Artifacts.listen: {type: "artifactChanged", artifact, op, surface, mine}); anything
// else with its own way to open (a chat's widget nobody is looking at) is offered through offer().
import * as vscode from "vscode";

/** What was already offered, by artifact: its version. */
export const ARTIFACT_NOTICED_KEY = "dgc.artifactNoticed.v1";
const REMEMBERED = 200;
/** How long the editor keeps an unanswered notification on screen before it folds into the bell. */
const ON_SCREEN_MS = 15_000;
const MAX_TITLE = 80;

/** One thing made: `key` and `version` say which (once each), `open` opens it. */
export interface MadeNotice { key: string; version: number; title: string; updated: boolean; open: () => void }
/** What the pop-up needs of the artifacts: opening one, and whether one is on screen already. */
export interface NoticeHub { open(id: string, hint?: any): void; showing(id: string): boolean }

type Store = Pick<vscode.Memento, "get" | "update">;

function oneLine(value: unknown): string {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
  return text.length > MAX_TITLE ? `${text.slice(0, MAX_TITLE - 1).trimEnd()}…` : text;
}

/** The notification's words. */
export function madeWords(title: unknown, updated: boolean): string {
  const name = oneLine(title);
  if (!name) { return updated ? "DGC updated something it made" : "DGC made something new"; }
  return `DGC ${updated ? "updated" : "made"} “${name}”`;
}

export class ArtifactNotice {
  /** One that opens by itself (a chat's document beside the chat that shows it): set by whoever knows. */
  opensByItself?: (message: any) => boolean;
  private readonly store?: Store;
  private readonly holdMs: number;
  private noticed: Record<string, number>;
  private onScreen?: { timer: ReturnType<typeof setTimeout> };
  private waiting?: MadeNotice;

  constructor(context: { globalState?: Store }, private readonly hub?: NoticeHub, options: { holdMs?: number } = {}) {
    this.store = context?.globalState;
    this.holdMs = Number(options.holdMs) > 0 ? Number(options.holdMs) : ON_SCREEN_MS;
    this.noticed = this.read();
  }

  private read(): Record<string, number> {
    const out: Record<string, number> = {};
    let saved: unknown;
    try { saved = this.store?.get?.(ARTIFACT_NOTICED_KEY); } catch { saved = undefined; }
    if (saved && typeof saved === "object" && !Array.isArray(saved)) {
      for (const [key, version] of Object.entries(saved as Record<string, unknown>).slice(-REMEMBERED)) {
        if (/^[A-Za-z0-9_:.-]{1,80}$/.test(key) && Number.isSafeInteger(version) && (version as number) > 0) { out[key] = version as number; }
      }
    }
    return out;
  }

  /** True the first time this version of it is seen, in any window of this editor that has read the state since. */
  private fresh(key: string, version: number): boolean {
    // Another window may have offered it meanwhile: its mark is in the shared state.
    for (const [k, v] of Object.entries(this.read())) { if (!(this.noticed[k] >= v)) { this.noticed[k] = v; } }
    if (this.noticed[key] >= version) { return false; }
    delete this.noticed[key];                       // the newest last, so the oldest are the ones forgotten
    this.noticed[key] = version;
    const keys = Object.keys(this.noticed);
    for (const old of keys.slice(0, Math.max(0, keys.length - REMEMBERED))) { delete this.noticed[old]; }
    try { void Promise.resolve(this.store?.update?.(ARTIFACT_NOTICED_KEY, { ...this.noticed })).catch(() => { /* kept for this window still */ }); } catch { /* the same */ }
    return true;
  }

  /** What every screen hears of the artifacts. Only a turn's own making or change is news here. */
  heard(message: any): void {
    if (!message || message.type !== "artifactChanged") { return; }
    const view = message.artifact, op = String(message.op || "");
    if (!view || typeof view.id !== "string" || (op !== "made" && op !== "changed")) { return; }
    if (message.mine === true) { return; }                                   // this window's own save
    const versions = Array.isArray(view.versions) ? view.versions : [];
    const author = String(versions.length ? versions[versions.length - 1]?.author ?? "" : "").trim().toLowerCase();
    if (author === "you") { return; }                                         // the person's own edit, in any window
    const version = Number.isSafeInteger(view.version) && view.version > 0 ? view.version : 1;
    if (!this.fresh(view.id, version)) { return; }
    // On screen already, or about to be without anyone asking: its tab shows it. (Marked as offered all the same.)
    let shown = false;
    try { shown = this.hub?.showing(view.id) === true || this.opensByItself?.(message) === true; } catch { shown = false; }
    if (shown) { return; }
    const hub = this.hub;
    this.show({ key: view.id, version, title: view.title, updated: op === "changed" || version > 1, open: () => hub?.open(view.id, view) });
  }

  /** Anything else a turn made that has its own way to open. */
  offer(item: MadeNotice): void {
    if (!item || typeof item.key !== "string" || typeof item.open !== "function") { return; }
    const version = Number.isSafeInteger(item.version) && item.version > 0 ? item.version : 1;
    if (!this.fresh(item.key, version)) { return; }
    this.show({ ...item, version });
  }

  private show(item: MadeNotice): void {
    if (this.onScreen) { this.waiting = item; return; }           // never a stack: the newest waits, alone
    const mine = { timer: setTimeout(() => this.cleared(mine), this.holdMs) };
    (mine.timer as any).unref?.();
    this.onScreen = mine;
    let asked: Thenable<string | undefined>;
    try { asked = vscode.window.showInformationMessage(madeWords(item.title, item.updated), "Open"); }
    catch { this.cleared(mine); return; }
    void Promise.resolve(asked).then((choice) => {
      if (choice === "Open") { try { item.open(); } catch { /* opening says its own failures */ } }
      this.cleared(mine);
    }, () => this.cleared(mine));
  }

  /** The one on screen was answered, dismissed or folded away by the editor: the one that waited shows now. */
  private cleared(which: { timer: ReturnType<typeof setTimeout> }): void {
    clearTimeout(which.timer);
    if (this.onScreen !== which) { return; }
    this.onScreen = undefined;
    const next = this.waiting;
    this.waiting = undefined;
    if (next) { this.show(next); }
  }
}
