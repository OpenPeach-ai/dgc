// The dock at the foot of DGC's side bar (media/shared/dock.js): what is pinned to it, and each session's colour.
//
// Pins are kept on this computer, in the extension's global state, so they hold across reloads and windows. A Work
// session and a project's Pip belong to a project: each is kept with the folder it was pinned in and shows only in that
// folder's windows. A Personal Pip, a ChatDGC chat, an artifact, a Library file and a widget show in every window.
// Deleting a pinned session, chat, artifact, file or widget takes it off the dock (forget); a pinned Pip that is gone
// is taken off by the side bar once its list no longer has it.
//
// A session's mark is the maintainer's own Voxel (a Work session) or Mote (a ChatDGC chat), and a widget's his Folio,
// each in one of twelve palettes (media/shared/marks.js). The palette a thing wears is kept here, with the pins, from
// the moment it is given: a new session or widget gets the first palette not worn by the ones around it, a session from
// before the marks the palette nearest its old colour, and a session's owner may choose another of the twelve. Kept, it
// never changes with a reload or a new order. (DGC keeps nothing about a widget's look, so its palette is kept here, by
// the widget's id.) An editor tab's icon is the mark at rest, a PNG in media/session-icons/
// (scripts/render-session-icons.mjs makes them from the shipped CSS).
import * as vscode from "vscode";
import { readFileSync } from "fs";
import marks from "../media/shared/marks.js";

const PINS = "dgc.dock.pins";
// The palettes ({ "work:<id>": "lagoon" }, the oldest first), when the marks arrived on this computer (ms), and the
// choices from before the marks ({ "work:<id>": 1..7 }, read once more for each session's palette and never written).
const PALETTES = "dgc.sessionPalettes", SINCE = "dgc.sessionPalettesSince", COLOURS = "dgc.sessionColours";
const KEEP_PINS = 200, KEEP_COLOURS = 2000;
export const DOCK_MOST = 16, DOCK_MOST_DEFAULT = 8, DOCK_SIZE_MIN = 24, DOCK_SIZE_MAX = 48, DOCK_SIZE_DEFAULT = 34;
const KINDS = ["pip", "work", "chat", "artifact", "file", "widget", "project"] as const;
export type DockKind = typeof KINDS[number];
const ID = /^[A-Za-z0-9_.:|-]{1,200}$/;
const NAMES: Record<DockKind, string> = { pip: "Pip", work: "Work session", chat: "ChatDGC chat", artifact: "Artifact", file: "Library file", widget: "Widget", project: "Project" };

/** One pinned thing. `ref` is what opens it (ids only); `look` is how to draw it when its list isn't loaded (a Pip's
 *  body, a file's kind); `where` is the folder a project's thing was pinned in ("" shows in every window). */
export type DockPin = { key: string; kind: DockKind; id: string; title: string; sub: string; look: Record<string, string>; ref: Record<string, string>; where: string };
export type DockShow = "always" | "hover" | "never";
/** `colours`: the palette each session's mark wears, by "work:<id>" or "chat:<id>". `since`: when the marks arrived here. */
export type DockState = { type: "dock"; pins: Omit<DockPin, "where">[]; colours: Record<string, string>; since: number; show: DockShow; most: number; size: number };

const text = (value: unknown, most: number) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, most);
/** A flat map of short strings, and nothing else: what a page sent is never kept as it came. */
function strings(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [name, entry] of Object.entries(value as Record<string, unknown>).slice(0, 12)) {
    if (/^[a-z_]{1,24}$/i.test(name) && (typeof entry === "string" || typeof entry === "number")) out[name] = String(entry).slice(0, 300);
  }
  return out;
}
export const dockKey = (kind: string, id: string) => `${kind}:${id}`;
/** A pin as a page named it, checked. undefined: not one. */
export function dockPin(value: any, where = ""): DockPin | undefined {
  const kind = KINDS.find((k) => k === value?.kind), id = String(value?.id ?? "");
  if (!kind || !ID.test(id)) return undefined;
  const scoped = kind === "work" || (kind === "pip" && value?.scope === "project");
  return { key: dockKey(kind, id), kind, id, title: text(value.title, 200) || NAMES[kind], sub: text(value.sub, 200), look: strings(value.look), ref: strings(value.ref),
    where: scoped ? String(typeof value.where === "string" ? value.where : where).slice(0, 1000) : "" };
}
const COLOUR_KEY = /^(?:work|chat|project):[A-Za-z0-9_.:|-]{1,200}$/;
/** What may wear a palette: a session, a chat (their owner may also choose it), and a widget. */
const WORN_KEY = /^(?:work|chat|widget|project|folder):[A-Za-z0-9_.:|-]{1,200}$/;
export type MarkKind = "work" | "chat" | "widget";

/** Settings -> General -> Dock, as the editor keeps them. */
export function dockSettings(): { show: DockShow; most: number; size: number } {
  let show: DockShow = "always", most = DOCK_MOST_DEFAULT, size = DOCK_SIZE_DEFAULT;
  try {
    const config = vscode.workspace.getConfiguration("dgc");
    const said = String(config?.get?.<string>("dock.show", "always") ?? "always");
    show = said === "hover" || said === "never" ? said : "always";
    const m = Number(config?.get?.<number>("dock.mostItems", DOCK_MOST_DEFAULT)), s = Number(config?.get?.<number>("dock.iconSize", DOCK_SIZE_DEFAULT));
    if (Number.isFinite(m)) most = Math.max(1, Math.min(DOCK_MOST, Math.round(m)));
    if (Number.isFinite(s)) size = Math.max(DOCK_SIZE_MIN, Math.min(DOCK_SIZE_MAX, Math.round(s)));
  } catch { /* the defaults */ }
  return { show, most, size };
}
/** Settings' own change: one of the three, for every window. False when it isn't one. */
export async function setDockSetting(message: any): Promise<boolean> {
  if (message?.type !== "dockSetting") return false;
  const config = vscode.workspace.getConfiguration("dgc"), target = vscode.ConfigurationTarget.Global;
  const name = String(message.name || ""), value = message.value;
  if (name === "show" && (value === "always" || value === "hover" || value === "never")) await config.update("dock.show", value, target);
  else if (name === "most" && Number.isInteger(value) && value >= 1 && value <= DOCK_MOST) await config.update("dock.mostItems", value, target);
  else if (name === "size" && Number.isInteger(value) && value >= DOCK_SIZE_MIN && value <= DOCK_SIZE_MAX) await config.update("dock.iconSize", value, target);
  return true;
}

/** The folder this window's project things belong to. */
function folderNow(): string {
  try { return vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || ""; } catch { return ""; }
}

export class Dock {
  private readonly listeners = new Set<() => void>();
  private watching?: vscode.Disposable;
  private sinceNoted = 0;
  constructor(private readonly context: vscode.ExtensionContext, private readonly folder: () => string = folderNow) {}

  private all(): DockPin[] {
    const saved = this.context?.globalState?.get?.<unknown[]>(PINS);
    const out: DockPin[] = [], seen = new Set<string>();
    for (const entry of Array.isArray(saved) ? saved : []) {
      const pin = dockPin({ ...(entry as any), scope: (entry as any)?.where ? "project" : "" });
      if (pin && !seen.has(pin.key)) { seen.add(pin.key); out.push(pin); }
    }
    return out;
  }
  private async keep(pins: DockPin[]): Promise<void> {
    try { await this.context.globalState.update(PINS, pins.slice(-KEEP_PINS)); } catch { /* kept for this window still */ }
    this.changed();
  }
  /** What this window's dock shows: everything that isn't another folder's. */
  pins(): DockPin[] {
    const here = this.folder();
    return this.all().filter((pin) => !pin.where || pin.where === here);
  }
  /** The palette each session, chat and widget wears, the oldest first. A colour chosen before the marks counts as
   *  its session's palette. */
  colours(): Record<string, string> {
    const saved = this.context?.globalState?.get?.<Record<string, unknown>>(PALETTES), out: Record<string, string> = {};
    const before = this.context?.globalState?.get?.<Record<string, unknown>>(COLOURS);
    if (before && typeof before === "object") for (const [key, value] of Object.entries(before)) { const palette = marks.fromOld(value as number); if (COLOUR_KEY.test(key) && palette) out[key] = palette; }
    if (saved && typeof saved === "object") for (const [key, value] of Object.entries(saved)) if (WORN_KEY.test(key) && marks.isPalette(value)) { delete out[key]; out[key] = value; }
    return out;
  }
  /** When the marks arrived on this computer: noted the first time it is asked, and kept. A session made before then
   *  keeps the palette of its old colour; one made after is new. */
  since(): number {
    const saved = Number(this.context?.globalState?.get?.<number>(SINCE));
    if (Number.isFinite(saved) && saved > 0) return saved;
    if (this.sinceNoted) return this.sinceNoted;
    const now = this.sinceNoted = Date.now();
    try { void Promise.resolve(this.context?.globalState?.update?.(SINCE, now)).catch(() => {}); } catch { /* noted again next time */ }
    return now;
  }
  /** The palette a session's mark wears: the one kept, or (none given yet) the one its id alone gives. */
  colour(kind: MarkKind, id: string): string { return this.colours()[dockKey(kind, id)] || marks.fallback(kind, id); }
  private async keepColours(colours: Record<string, string>): Promise<void> {
    const keys = Object.keys(colours);
    for (const old of keys.slice(0, Math.max(0, keys.length - KEEP_COLOURS))) delete colours[old];
    try { await this.context.globalState.update(PALETTES, colours); } catch { /* kept for this window still */ }
    this.changed();
  }
  /** A page drew things with no palette yet (dockPalettes { kind, list: [{ id, born? }] }, its list in order): each is
   *  given one and it is kept. What already has a palette keeps it, whatever the page says. */
  async wear(kind: unknown, list: unknown): Promise<void> {
    if (kind !== "work" && kind !== "chat" && kind !== "widget" && kind !== "project" && kind !== "folder") return;      // (a ChatDGC project's pinwheel and a Work folder's icon, 13 Nov)
    const rows: { id: string; born?: number }[] = [];
    for (const row of Array.isArray(list) ? list.slice(0, 200) : []) {
      const id = String((row as any)?.id ?? ""), born = (row as any)?.born;
      if (WORN_KEY.test(dockKey(kind, id))) rows.push({ id, ...(typeof born === "number" && Number.isFinite(born) ? { born } : {}) });
    }
    const colours = this.colours(), fresh = marks.assign({ kind, list: rows, known: colours, since: this.since() });
    if (Object.keys(fresh).length) await this.keepColours({ ...colours, ...fresh });
  }

  state(): DockState {
    return { type: "dock", pins: this.pins().map(({ where: _where, ...pin }) => pin), colours: this.colours(), since: this.since(), ...dockSettings() };
  }
  /** Calls `listener` whenever the dock, a colour or a Dock setting changes (and when this window is looked at again:
   *  another window may have pinned something meanwhile). */
  onChange(listener: () => void): vscode.Disposable {
    this.listeners.add(listener);
    if (!this.watching) {
      const subs: vscode.Disposable[] = [];
      try { subs.push(vscode.workspace.onDidChangeConfiguration((event) => { if (event.affectsConfiguration("dgc.dock")) this.changed(); })); } catch { /* no settings to watch */ }
      try { subs.push(vscode.window.onDidChangeWindowState((state) => { if (state.focused) this.changed(); })); } catch { /* no window to watch */ }
      this.watching = { dispose: () => { for (const sub of subs) sub.dispose(); } };
    }
    return { dispose: () => { this.listeners.delete(listener); } };
  }
  private changed(): void { for (const listener of [...this.listeners]) { try { listener(); } catch { /* one page's trouble is its own */ } } }

  /** Pin it at the end. With the dock at its most, asks which item to take off; Escape leaves the dock as it was. */
  async pin(value: unknown): Promise<boolean> {
    const pin = dockPin(value, this.folder());
    if (!pin) return false;
    const all = this.all(), shown = this.pins(), most = dockSettings().most;
    if (all.some((old) => old.key === pin.key && (!old.where || old.where === pin.where))) return true;
    let off = "";
    if (shown.length >= most) {
      const picked = await vscode.window.showQuickPick(
        shown.map((old) => ({ label: old.title, description: NAMES[old.kind], key: old.key })),
        { title: `The dock holds ${most}`, placeHolder: `Pick one to take off, to make room for “${pin.title}”. Settings › General › Dock can hold up to ${DOCK_MOST}.` });
      if (!picked) return false;
      off = (picked as any).key;
    }
    await this.keep([...this.all().filter((old) => old.key !== pin.key && old.key !== off), pin]);
    return true;
  }
  async unpin(key: string): Promise<void> {
    const here = this.folder(), all = this.all();
    const next = all.filter((pin) => !(pin.key === key && (!pin.where || pin.where === here)));
    if (next.length !== all.length) await this.keep(next);
  }
  /** One place left (-1) or right (1), among what this window shows. */
  async move(key: string, by: number): Promise<void> {
    const all = this.all(), shown = this.pins(), at = shown.findIndex((pin) => pin.key === key), to = at + (by < 0 ? -1 : 1);
    if (at < 0 || to < 0 || to >= shown.length) return;
    const place = (pin: DockPin) => all.findIndex((old) => old.key === pin.key && old.where === pin.where);
    const a = place(shown[at]), b = place(shown[to]);
    if (a < 0 || b < 0) return;
    [all[a], all[b]] = [all[b], all[a]];
    await this.keep(all);
  }
  /** To place `to` among what this window shows (a drag's drop): the pins it passed each move one place, and what
   *  another window shows keeps its own places. */
  async place(key: string, to: number): Promise<void> {
    const all = this.all(), shown = this.pins(), at = shown.findIndex((pin) => pin.key === key);
    if (at < 0 || !Number.isInteger(to) || to < 0) return;
    const next = [...shown];
    next.splice(Math.min(next.length - 1, to), 0, next.splice(at, 1)[0]);
    if (next.every((pin, i) => pin === shown[i])) return;
    const place = (pin: DockPin) => all.findIndex((old) => old.key === pin.key && old.where === pin.where);
    const slots = shown.map(place), entries = next.map((pin) => all[place(pin)]);
    if (slots.some((slot) => slot < 0) || entries.some((entry) => !entry)) return;
    [...slots].sort((a, b) => a - b).forEach((slot, i) => { all[slot] = entries[i]; });
    await this.keep(all);
  }
  /** A newer name or second line for something pinned (a session renamed, a file's new version). */
  async seen(items: unknown): Promise<void> {
    const all = this.all();
    let changed = false;
    for (const entry of Array.isArray(items) ? items.slice(0, 64) : []) {
      const pin = all.find((old) => old.key === String((entry as any)?.key || ""));
      const title = text((entry as any)?.title, 200);
      if (pin && title && title !== pin.title) { pin.title = title; changed = true; }
    }
    if (changed) await this.keep(all);
  }
  /** It was deleted: off the dock in every window, and its colour goes with it. */
  async forget(kind: DockKind, id: string): Promise<void> {
    const key = dockKey(kind, id), all = this.all(), next = all.filter((pin) => pin.key !== key);
    const colours = this.colours(), had = key in colours;
    if (had) {
      delete colours[key];
      try { await this.context.globalState.update(PALETTES, colours); } catch { /* next time */ }
      // (A colour chosen for it before the marks goes too, or it would come back as its palette.)
      const before = { ...(this.context.globalState.get<Record<string, unknown>>(COLOURS) || {}) };
      if (key in before) { delete before[key]; try { await this.context.globalState.update(COLOURS, before); } catch { /* next time */ } }
    }
    if (next.length !== all.length) await this.keep(next); else if (had) this.changed();
  }
  /** A session's colour, chosen by its owner: one of the twelve palettes. Anything else changes nothing. */
  async setColour(key: string, value: unknown): Promise<void> {
    if (!COLOUR_KEY.test(key) || !marks.isPalette(value)) return;
    const colours = this.colours();
    delete colours[key];
    colours[key] = value;
    await this.keepColours(colours);
  }

  /** A page's dock message. False when it isn't one. `reply` gets the dock's state when the page asked for it. */
  handle(message: any, reply?: (state: DockState) => void): boolean {
    switch (message?.type) {
      case "dockReady": reply?.(this.state()); return true;
      case "dockPin": void this.pin(message.item); return true;
      case "dockUnpin": void this.unpin(String(message.key || "")); return true;
      case "dockToggle": {
        const pin = dockPin(message.item, this.folder());
        if (pin) void (this.pins().some((old) => old.key === pin.key) ? this.unpin(pin.key) : this.pin(message.item));
        return true;
      }
      case "dockMove": void this.move(String(message.key || ""), Number(message.by) < 0 ? -1 : 1); return true;
      case "dockPlace": void this.place(String(message.key || ""), message.to); return true;
      case "dockColour": void this.setColour(String(message.key || ""), message.colour); return true;
      case "dockPalettes": void this.wear(message.kind, message.list); return true;
      case "dockSeen": void this.seen(message.items); return true;
      default: return false;
    }
  }
}

const docks = new WeakMap<object, Dock>();
/** The one dock of this extension (every page of a window shares it). */
export function dockOf(context: vscode.ExtensionContext): Dock {
  let dock = docks.get(context);
  if (!dock) { dock = new Dock(context); docks.set(context, dock); }
  return dock;
}

// ---- a mark as a still picture: an editor tab's icon ----------------------------------------------------------------
const icons = new Map<string, vscode.Uri>();
/** A mark at rest as a tab's icon: media/session-icons/<set>-<palette>.png (64 px, clear around it), carried inside the
 *  URI (nothing to fetch after a reload; see tabIcon.ts). `set`: "mote" | "voxel" | "folio". undefined when it can't be read:
 *  the tab keeps the plain mark. */
export function markIcon(extensionUri: vscode.Uri, set: string, palette: string): vscode.Uri | undefined {
  if (!Object.prototype.hasOwnProperty.call(marks.SETS, set) || !marks.isPalette(palette)) return undefined;
  const file = vscode.Uri.joinPath(extensionUri, "media", "session-icons", `${set}-${palette}.png`).fsPath, key = String(file);
  let uri = icons.get(key);
  if (!uri) {
    try { uri = vscode.Uri.parse(`data:image/png;base64,${readFileSync(file).toString("base64")}`); } catch { return undefined; }
    icons.set(key, uri);
  }
  return uri;
}
/** A session's tab icon: its Voxel (Work) or its Mote (ChatDGC), in the palette it wears; a widget's: its Folio.
 *  undefined for one with no id yet: it keeps the plain mark. */
export function sessionIcon(extensionUri: vscode.Uri, kind: MarkKind, id: string, palette: string): vscode.Uri | undefined {
  return id ? markIcon(extensionUri, marks.SET_OF[kind], marks.isPalette(palette) ? palette : marks.fallback(kind, id)) : undefined;
}
