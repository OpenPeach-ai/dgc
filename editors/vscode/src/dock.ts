// The dock at the foot of DGC's side bar (media/shared/dock.js): what is pinned to it, and each session's colour.
//
// Pins are kept on this computer, in the extension's global state, so they hold across reloads and windows. A Work
// session and a project's Pip belong to a project: each is kept with the folder it was pinned in and shows only in that
// folder's windows. A Personal Pip, a ChatDGC chat, an artifact, a Library file and a widget show in every window.
// Deleting a pinned session, chat, artifact, file or widget takes it off the dock (forget); a pinned Pip that is gone
// is taken off by the side bar once its list no longer has it.
//
// A session's colour is one of seven (media/shared/blob.js); the one it gets from its id is not kept, only a choice.
// Its editor tab's icon is its blob as a still picture, drawn here (blobIcon) with nothing but zlib.
import * as vscode from "vscode";
import { readFileSync } from "fs";
import { deflateSync } from "zlib";

const PINS = "dgc.dock.pins";
const COLOURS = "dgc.sessionColours";
const KEEP_PINS = 200, KEEP_COLOURS = 2000;
export const DOCK_MOST = 16, DOCK_MOST_DEFAULT = 8, DOCK_SIZE_MIN = 24, DOCK_SIZE_MAX = 48, DOCK_SIZE_DEFAULT = 34;
const KINDS = ["pip", "work", "chat", "artifact", "file", "widget"] as const;
export type DockKind = typeof KINDS[number];
const ID = /^[A-Za-z0-9_.:|-]{1,200}$/;
const NAMES: Record<DockKind, string> = { pip: "Pip", work: "Work session", chat: "ChatDGC chat", artifact: "Artifact", file: "Library file", widget: "Widget" };

/** One pinned thing. `ref` is what opens it (ids only); `look` is how to draw it when its list isn't loaded (a Pip's
 *  body, a file's kind); `where` is the folder a project's thing was pinned in ("" shows in every window). */
export type DockPin = { key: string; kind: DockKind; id: string; title: string; sub: string; look: Record<string, string>; ref: Record<string, string>; where: string };
export type DockShow = "always" | "hover" | "never";
export type DockState = { type: "dock"; pins: Omit<DockPin, "where">[]; colours: Record<string, number>; show: DockShow; most: number; size: number };

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
const colourOf = (value: unknown) => (Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 7 ? (value as number) : 0);
const COLOUR_KEY = /^(?:work|chat):[A-Za-z0-9_.:|-]{1,200}$/;

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
  colours(): Record<string, number> {
    const saved = this.context?.globalState?.get?.<Record<string, unknown>>(COLOURS), out: Record<string, number> = {};
    if (saved && typeof saved === "object") for (const [key, value] of Object.entries(saved)) if (COLOUR_KEY.test(key) && colourOf(value)) out[key] = colourOf(value);
    return out;
  }
  /** A session's chosen colour, 1 to 7; 0 when it keeps the one from its id. */
  colour(kind: "work" | "chat", id: string): number { return this.colours()[dockKey(kind, id)] || 0; }

  state(): DockState {
    return { type: "dock", pins: this.pins().map(({ where: _where, ...pin }) => pin), colours: this.colours(), ...dockSettings() };
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
    if (had) { delete colours[key]; try { await this.context.globalState.update(COLOURS, colours); } catch { /* next time */ } }
    if (next.length !== all.length) await this.keep(next); else if (had) this.changed();
  }
  /** A session's colour: 1 to 7, or anything else for "Back to its own colour". */
  async setColour(key: string, value: unknown): Promise<void> {
    if (!COLOUR_KEY.test(key)) return;
    const colours = this.colours(), n = colourOf(value);
    delete colours[key];
    if (n) colours[key] = n;
    const keys = Object.keys(colours);
    for (const old of keys.slice(0, Math.max(0, keys.length - KEEP_COLOURS))) delete colours[old];
    try { await this.context.globalState.update(COLOURS, colours); } catch { /* kept for this window still */ }
    this.changed();
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

// ---- a blob as a still picture: a session's editor tab icon --------------------------------------------------------
/** The pair an id gets by itself (media/shared/blob.js, `own`): one of 2 to 7. */
export function ownColour(id: string): number {
  let h = 2166136261;
  for (const ch of String(id || "")) { h ^= ch.codePointAt(0)!; h = Math.imul(h, 16777619); }
  return 2 + ((h >>> 0) % 6);
}
let pairs: Record<string, [number, number, number]> | undefined;
/** The seven pairs' colours, read from the one place they are written (media/shared/tokens.css: --blob-1a ...). */
function blobColours(extensionUri: vscode.Uri): Record<string, [number, number, number]> {
  if (pairs) return pairs;
  const found: Record<string, [number, number, number]> = {};
  try {
    const css = readFileSync(vscode.Uri.joinPath(extensionUri, "media", "shared", "tokens.css").fsPath, "utf8");
    for (const m of css.matchAll(/--blob-([1-7][abg])\s*:\s*#([0-9a-fA-F]{6})/g)) found[m[1]] = [0, 2, 4].map((i) => parseInt(m[2].slice(i, i + 2), 16)) as [number, number, number];
  } catch { /* drawn in grey below */ }
  if (Object.keys(found).length >= 14) pairs = found;
  return found;
}
const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf: Buffer): number { let c = 0xffffffff; for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, "ascii");
  const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}
/** RGBA pixels as a PNG file. */
export function png(width: number, height: number, rgba: Uint8Array): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}
/** A blob at rest, `size` px square: the pair's gradient from bottom to top, the light wave from below, the sheen near
 *  the top and one bubble, inside a circle (Work) or a rounded square (ChatDGC). The same picture media/shared/blob.css
 *  draws, still. */
export function blobPixels(kind: "work" | "chat", from: [number, number, number], to: [number, number, number], size = 64): Uint8Array {
  const out = new Uint8Array(size * size * 4), half = size / 2, inset = size * 0.06, r = half - inset, corner = (size - 2 * inset) * 0.3, SS = 3;
  const inside = (x: number, y: number) => {
    const dx = Math.abs(x - half), dy = Math.abs(y - half);
    if (kind === "work") return dx * dx + dy * dy <= r * r;
    if (dx > r || dy > r) return false;
    const cx = dx - (r - corner), cy = dy - (r - corner);
    return cx <= 0 || cy <= 0 || cx * cx + cy * cy <= corner * corner;
  };
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    let red = 0, green = 0, blue = 0, cover = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const x = px + (sx + 0.5) / SS, y = py + (sy + 0.5) / SS;
      if (!inside(x, y)) continue;
      const t = Math.min(1, Math.max(0, (size - inset - y) / (size - 2 * inset)));      // 0 at the bottom, 1 at the top
      let c = [0, 1, 2].map((i) => from[i] + (to[i] - from[i]) * t);
      const white = (a: number) => { c = c.map((v) => v + (255 - v) * a); };
      white(t < 0.5 ? 0.3 - 0.4 * t : 0.1 * (1 - t) * 2);                               // the wave from below
      const u = (y - inset) / (size - 2 * inset);                                       // the sheen: the top 4% to 32%
      const sx2 = ((x - half) / (half - inset)) ** 2 + ((u - 0.18) / 0.14) ** 2;          // a pill, as the CSS draws it
      if (sx2 <= 1) white(0.4 * (1 - (u - 0.04) / 0.28));
      const bx = (x - size * 0.4) / (size * 0.08), by = (y - size * 0.34) / (size * 0.08);
      if (bx * bx + by * by <= 1) white(0.22);                                          // the bubble
      red += c[0]; green += c[1]; blue += c[2]; cover++;
    }
    const at = (py * size + px) * 4;
    if (!cover) continue;
    out[at] = Math.round(red / cover); out[at + 1] = Math.round(green / cover); out[at + 2] = Math.round(blue / cover); out[at + 3] = Math.round(255 * cover / (SS * SS));
  }
  return out;
}
const icons = new Map<string, vscode.Uri>();
/** A session's tab icon: its blob, still, as a data: URI (nothing to fetch after a reload; see tabIcon.ts). `colour`
 *  is its chosen pair (0: the one from its id). undefined for a session with no id yet: it keeps the plain mark. */
export function blobIcon(extensionUri: vscode.Uri, kind: "work" | "chat", id: string, colour = 0): vscode.Uri | undefined {
  if (!id) return undefined;
  const pair = colourOf(colour) || ownColour(id), key = `${kind}:${pair}`;
  let uri = icons.get(key);
  if (!uri) {
    const colours = blobColours(extensionUri), from = colours[`${pair}a`], to = colours[`${pair}b`];
    if (!from || !to) return undefined;
    try { uri = vscode.Uri.parse(`data:image/png;base64,${png(64, 64, blobPixels(kind, from, to)).toString("base64")}`); } catch { return undefined; }
    icons.set(key, uri);
  }
  return uri;
}
