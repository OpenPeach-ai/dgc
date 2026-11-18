// Notes (Home's Notes card, media/shared/notes.js): where notes are kept, and everything done to them.
//
// Kept on this computer, in files in DGC's own storage folder (the editor's global storage for this extension, under
// notes/): one file a note (`<id>.md`, Markdown text; a locked note is `<id>.lock`, encrypted), and index.json beside
// them: each note's title, the line shown on its row, its folder, when it was made and last edited, whether it is
// pinned, locked or deleted, and the folders. The index holds no note's words past its title and row line (a locked
// note: its title only). Never in a project folder, never in the extension's small state. The notes kept there before
// (0.52's first Notes card) are carried over once: written as files, read back, and only then taken out of the state.
//
// A page asks with { type: "homeNotesDo", op, ... } and hears { type: "homeNotes", ... } (the list, never a note's
// words), { type: "homeNoteText" } (one note's words, to the page that opened it and to no other),
// { type: "homeNotesFound" } (a search), { type: "homeNotesSaid" } (how something went) and { type: "homeNoteChanged" }
// (a note another page changed: which one, never its words). Nothing here is sent anywhere else, and nothing a note
// says is written to a log.
//
// The lock (PIN only, one PIN for every locked note). A locked note is encrypted when it is saved: AES-256-GCM, a fresh
// nonce for every save, the note's id bound in. The key is a random 256-bit key; it is kept in the system keychain (the
// editor's SecretStorage), itself encrypted with a key made from the PIN (PBKDF2-SHA-256, a random salt, 600,000
// rounds), so the PIN is needed to use it and a forgotten PIN leaves the notes unreadable: there is no back door. While
// notes are unlocked the key is in this process's memory only; it is dropped on Lock now, when the window closes, and
// after ten minutes with nothing done in Notes. Five wrong tries, then a wait of 30 seconds that doubles with each
// wrong try up to an hour; the count is kept across reloads, and a try is counted before it is tried. Nothing is ever
// erased on its own. A PIN, the key and a locked note's words are never logged, never kept in the state, and never
// said to any page but (the words) the one that opened the note.
// What this holds against: someone at the unlocked editor, and anyone who gets the notes' files. What it does not:
// someone signed in as this user who can read the keychain can try every 4-digit PIN in moments; the waits are this
// file's own rule. Where there is no keychain, nothing is locked, and it says so.
import * as fs from "node:fs";
import * as path from "node:path";
import { webcrypto, randomBytes } from "node:crypto";
import type * as vscode from "vscode";

const OLD_KEY = "dgc.homeCards.v1";
/** At most this many notes (the bin is counted apart), each at most this long; a deleted note waits this many days. */
export const NOTES_MOST = 2000, NOTE_MOST = 100000, BIN_DAYS = 30, FOLDERS_MOST = 100;
/** What each guess at a PIN costs, how long notes stay open with nothing done, and the tries before the first wait. */
export const PBKDF2_ROUNDS = 600000, IDLE_LOCK_MS = 10 * 60000, TRIES_FREE = 5;
const LOCK_SECRET = "dgc.notes.lock.v1", TRIES_KEY = "dgc.notes.lockTries.v1", LOCKED_AT = "dgc.notes.lockedAt.v1", PIN = /^\d{4,8}$/, subtle = webcrypto.subtle;
type LockRecord = { v: 1; salt: string; iter: number; iv: string; key: string; digits: number };
/** "none": no PIN yet. "locked" / "unlocked": a PIN is set. "nokey": locked notes are here, their key is not (a copied
 *  folder). "nokeychain": this computer cannot keep a key. `left`: tries before a wait; `until`: when the wait ends. */
export type NotesLock = { state: "none" | "locked" | "unlocked" | "nokey" | "nokeychain"; left: number; until: number; digits: number };
type Checked = { ok: true; raw: Uint8Array } | { ok: false; why: string; left?: number; until?: number };
const ID = /^[a-z0-9]{4,24}$/, DAY = 86400000, SORTS = ["edited", "created", "title"] as const;
export type NoteSort = typeof SORTS[number];
/** A note as the list has it. `folder`: "" is no folder (All notes only). `deleted`: when it went to the bin (0: it is
 *  not there); `was`: the folder it was in then. `line` is "" for a locked note. */
export type NoteMeta = { id: string; title: string; line: string; folder: string; created: number; edited: number; pinned: boolean; locked: boolean; deleted: number; was?: string };
export type NoteFolder = { id: string; name: string };
export type NotesState = { type: "homeNotes"; notes: NoteMeta[]; folders: NoteFolder[]; sort: NoteSort; shown: string; most: number; longest: number; binDays: number; lock: NotesLock };
type Index = { v: 1; notes: NoteMeta[]; folders: NoteFolder[]; sort: NoteSort; shown: string };
type Reply = (said: any) => void;
type Context = Pick<vscode.ExtensionContext, "globalState" | "globalStorageUri" | "secrets">;
/** What Notes asks of the editor around it (src/notesTab.ts gives the real ones; a test gives its own). */
export type NotesEnv = { openExternal?: (url: string) => void;
  /** A note's words to the clipboard. */
  clipboard?: (text: string) => void | Promise<void>;
  /** One .md file, downloaded to the person's computer by the page that asked (`reply`, src/download.ts; `locked`: the
   *  file will not be locked). True: it was handed to the page. */
  saveFile?: (file: { name: string; text: string; locked: boolean }, reply?: Reply) => Promise<boolean>;
  /** Many .md files, downloaded the same way as one .zip. The .zip's name; undefined: nothing was handed over. */
  saveFolder?: (out: { name: string; files: { name: string; text: string }[]; locked: boolean }, reply?: Reply) => Promise<string | undefined>;
  /** A note opened wide in an editor tab. */
  openTab?: (id: string) => void;
  /** True where the editor keeps secrets in its own weak store, not the system's keychain: nothing is locked there. */
  weakKeychain?: () => boolean };

const stamp = (value: unknown) => { const n = Number(value); return Number.isFinite(n) && n > 0 ? Math.round(n) : 0; };
/** Words without their Markdown marks (bold, italic, a link's brackets; `link`: what a link becomes). */
function plainInline(words: string, link = "$1"): string {
  return words.replace(/\[([^\]\n]*)\]\(([^)\s]+)\)/g, link).replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, "$1")
    .replace(/(?<![\\*])\*(?=[^\s*])([^*\n]*?[^\s*\\])\*(?!\*)/g, "$1").replace(/(?<![\\\w])_(?=[^\s_])([^_\n]*?[^\s_\\])_(?!\w)/g, "$1")
    .replace(/\\([\\*_[\]#.+-])/g, "$1");
}
/** A line without its Markdown marks: what a title or a row shows. */
export function plainLine(line: string): string {
  return plainInline(line.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+\[[ xX]\]\s*|[-*+]\s+|\d{1,9}[.)]\s+)/, "")).replace(/\s+/g, " ").trim();
}
/** A whole note as plain words, for the clipboard: a bullet is "•", a tick box "[ ]" or "[x]", a link its words and its address. */
export function plainNote(text: string): string {
  return text.split("\n").map((raw) => {
    const m = /^([ \t]*)(?:(#{1,6})[ \t]+|[-*+][ \t]+\[([ xX])\](?:[ \t]|$)|([-*+])[ \t]+|(\d{1,9})[.)][ \t]+)?(.*)$/.exec(raw)!, body = plainInline(m[6], "$1 ($2)");
    return m[2] && !m[1] ? body : m[3] !== undefined ? `${m[1]}[${m[3] === " " ? " " : "x"}] ${body}` : m[4] ? `${m[1]}• ${body}` : m[5] ? `${m[1]}${m[5]}. ${body}` : plainInline(raw, "$1 ($2)");
  }).join("\n");
}
/** A name a file can have on any system, from a note's title or a folder's name. */
export function fileName(title: string): string {
  const name = title.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").replace(/^[. ]+|[. ]+$/g, "").slice(0, 80).trim() || "Note";
  return /^(?:con|prn|aux|nul|com\d|lpt\d)$/i.test(name) ? `Note ${name}` : name;
}
/** A note's name: its first line with words in it. */
export function noteTitle(text: string): string { for (const line of text.split("\n", 400)) { const said = plainLine(line); if (said) return said.slice(0, 120); } return "New note"; }
/** A note's row line: what follows its title, on one line. */
export function noteLine(text: string): string {
  const out: string[] = []; let titled = false, size = 0;
  for (const line of text.split("\n", 400)) { const said = plainLine(line); if (!said) continue; if (!titled) { titled = true; continue; } out.push(said); size += said.length; if (size > 160 || out.length >= 4) break; }
  return out.join(" · ").slice(0, 160);
}
const folderName = (value: unknown) => (typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) : "");

export class Notes {
  private readonly dir: string;
  private readonly now: () => number;
  private readonly listeners = new Set<Reply>();
  private index: Index = { v: 1, notes: [], folders: [], sort: "edited", shown: "" };
  private read = "";                       // the index file as last read or written: "<mtime>:<size>"
  private queue: Promise<void> = Promise.resolve();
  env: NotesEnv;
  // The lock: the key while notes are unlocked (in memory only), the keychain's record as last read (undefined: not
  // read yet), whether this computer can keep a key (undefined: not known yet).
  private dk?: webcrypto.CryptoKey;
  private record?: LockRecord | null;
  private keychain?: boolean;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private openedAt = 0;
  private readonly iterations: number;
  private readonly idleMs: number;
  constructor(private readonly context: Context, options: { now?: () => number; env?: NotesEnv; iterations?: number; idleMs?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.env = options.env ?? {};
    this.iterations = Math.max(1000, options.iterations ?? PBKDF2_ROUNDS);
    this.idleMs = options.idleMs ?? IDLE_LOCK_MS;
    // (An editor that gives the extension no storage folder keeps no notes: nothing is read, written or answered.)
    const folder = (context as any)?.globalStorageUri?.fsPath;
    this.dir = typeof folder === "string" && folder ? path.join(folder, "notes") : "";
  }

  // ---- the files ---------------------------------------------------------------------------------------------------------
  private file(id: string, locked = false): string { return path.join(this.dir, `${id}.${locked ? "lock" : "md"}`); }
  /** A file written whole or not at all, for this user only. */
  private write(file: string, data: string): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    try { fs.writeFileSync(tmp, data, { encoding: "utf8", mode: 0o600 }); fs.renameSync(tmp, file); }
    catch (error) { try { fs.rmSync(tmp, { force: true }); } catch { /* nothing was left */ } throw error; }
  }
  private remove(id: string): void { for (const locked of [false, true]) { try { fs.rmSync(this.file(id, locked), { force: true }); } catch { /* it is gone already */ } } }
  private mark(): string { try { const s = fs.statSync(path.join(this.dir, "index.json")); return `${s.mtimeMs}:${s.size}`; } catch { return ""; } }
  private keep(): void { this.write(path.join(this.dir, "index.json"), JSON.stringify(this.index)); this.read = this.mark(); }
  /** The list as the files have it now: read again when another window wrote it; made (and the old notes carried
   *  over) when there is none; a note whose 30 days are over is deleted for good. */
  private ready(): Index {
    if (!this.dir) return this.index;
    const mark = this.mark();
    if (!mark) this.carryOver();
    else if (mark !== this.read) { try { this.index = this.checked(JSON.parse(fs.readFileSync(path.join(this.dir, "index.json"), "utf8"))); this.read = mark; } catch { /* a list that cannot be read is left as it is, and so is what is in memory */ } }
    const due = this.index.notes.filter((n) => n.deleted && this.now() - n.deleted > BIN_DAYS * DAY);
    if (due.length) { for (const n of due) this.remove(n.id); this.index.notes = this.index.notes.filter((n) => !due.includes(n)); try { this.keep(); } catch { /* next time */ } }
    return this.index;
  }
  private checked(value: any): Index {
    const folders: NoteFolder[] = [], notes: NoteMeta[] = [], seen = new Set<string>();
    for (const f of Array.isArray(value?.folders) ? value.folders.slice(0, FOLDERS_MOST) : []) { const name = folderName(f?.name); if (ID.test(String(f?.id)) && name && !folders.some((x) => x.id === f.id)) folders.push({ id: f.id, name }); }
    const inFolder = (id: unknown) => (typeof id === "string" && folders.some((f) => f.id === id) ? id : "");
    for (const n of Array.isArray(value?.notes) ? value.notes : []) {
      const id = String(n?.id ?? ""); if (!ID.test(id) || seen.has(id)) continue; seen.add(id);
      const deleted = stamp(n.deleted), locked = n.locked === true;
      notes.push({ id, title: String(n.title ?? "").slice(0, 120) || "New note", line: locked ? "" : String(n.line ?? "").slice(0, 160), folder: inFolder(n.folder), created: stamp(n.created), edited: stamp(n.edited), pinned: n.pinned === true, locked, deleted, ...(deleted ? { was: inFolder(n.was) } : {}) });
    }
    return { v: 1, notes, folders, sort: SORTS.includes(value?.sort) ? value.sort : "edited", shown: value?.shown === "bin" ? "bin" : inFolder(value?.shown) };
  }
  /** The first time: the notes kept in the extension's state (and, older, the one sticky note) become files. Each is
   *  read back before the state lets go of it. */
  private carryOver(): void {
    let kept: any; try { kept = this.context.globalState.get<any>(OLD_KEY); } catch { kept = undefined; }
    const old: { id: string; text: string; at: number; pinned: boolean }[] = [];
    for (const n of Array.isArray(kept?.notes) ? kept.notes.slice(0, NOTES_MOST) : []) { const id = String(n?.id ?? ""); if (ID.test(id) && typeof n?.text === "string" && !old.some((x) => x.id === id)) old.push({ id, text: n.text.slice(0, NOTE_MOST), at: stamp(n.at) || this.now(), pinned: n.pinned === true }); }
    const sticky = kept?.settings?.note?.text;
    if (!Array.isArray(kept?.notes) && typeof sticky === "string" && sticky.trim()) old.push({ id: "first1", text: sticky.slice(0, NOTE_MOST), at: this.now(), pinned: false });
    this.index = { v: 1, notes: [], folders: [], sort: "edited", shown: "" };
    try {
      for (const n of old) { this.write(this.file(n.id), n.text); this.index.notes.push({ id: n.id, title: noteTitle(n.text), line: noteLine(n.text), folder: "", created: n.at, edited: n.at, pinned: n.pinned, locked: false, deleted: 0 }); }
      if (!old.length) { this.read = ""; return; }      // someone new: nothing is written until there is a note
      this.keep();
      if (!old.every((n) => fs.readFileSync(this.file(n.id), "utf8") === n.text)) return;
    } catch { return; }                                   // the state keeps them; the next start tries again
    const settings = kept.settings && typeof kept.settings === "object" ? { ...kept.settings } : undefined; if (settings) delete settings.note;
    const rest = { ...kept, ...(settings ? { settings } : {}) }; delete rest.notes;
    void Promise.resolve(this.context.globalState.update(OLD_KEY, rest)).then(undefined, () => { /* the files have them */ });
  }

  // ---- what a page hears -------------------------------------------------------------------------------------------------
  state(): NotesState {
    const index = this.ready();
    return { type: "homeNotes", notes: index.notes.map((n) => ({ ...n })), folders: index.folders.map((f) => ({ ...f })), sort: index.sort, shown: index.shown, most: NOTES_MOST, longest: NOTE_MOST, binDays: BIN_DAYS, lock: this.lockState() };
  }
  /** Every page with Home hears a change. */
  onSaid(listener: Reply): { dispose(): void } { this.listeners.add(listener); return { dispose: () => { this.listeners.delete(listener); } }; }
  /** To every page, and to the one that asked (once, when it is one of them). */
  private all(said: any, reply?: Reply): void { for (const l of new Set<Reply>([...this.listeners, ...(reply ? [reply] : [])])) { try { l(said); } catch { /* one page's trouble is its own */ } } }
  private changed(reply?: Reply, note?: { id: string; by?: unknown }): void {
    try { this.keep(); } catch { /* what is in memory is told still; the next change writes it */ }
    this.all(this.state(), reply);
    if (note) this.all({ type: "homeNoteChanged", id: note.id, by: typeof note.by === "string" ? note.by.slice(0, 40) : "" }, reply);
  }
  /** When nothing asked is still being done (tests wait on it). */
  idle(): Promise<void> { return this.queue; }
  /** A page's Notes message. False when it isn't one. Each is done in turn. */
  handle(message: any, reply?: Reply): boolean {
    if (!this.dir || message?.type !== "homeNotesDo" || typeof message.op !== "string") return false;
    this.queue = this.queue.then(() => this.act(message, reply)).then(undefined, () => { reply?.({ type: "homeNotesSaid", op: String(message.op).slice(0, 40), ok: false, why: "failed" }); });
    return true;
  }
  private live(id: unknown): NoteMeta | undefined { return this.index.notes.find((n) => n.id === id && !n.deleted); }
  private folder(id: unknown): string | undefined { return id === "" ? "" : this.index.folders.find((f) => f.id === id)?.id; }

  /** A note's words. undefined: they cannot be read now (locked, or its file is gone). */
  protected async textOf(note: NoteMeta): Promise<string | undefined> {
    try {
      if (!note.locked) return fs.readFileSync(this.file(note.id), "utf8");
      if (!this.dk) return undefined;
      const kept = JSON.parse(fs.readFileSync(this.file(note.id, true), "utf8"));
      const plain = await subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(String(kept.iv), "base64"), additionalData: Buffer.from(`dgc-note:${note.id}`) }, this.dk, Buffer.from(String(kept.ct), "base64"));
      return Buffer.from(plain).toString("utf8");
    } catch { return undefined; }
  }
  /** A note's words written (a locked note's, encrypted with a nonce of its own). False: not written (notes are locked). */
  protected async writeText(note: NoteMeta, text: string): Promise<boolean> {
    if (!note.locked) { this.write(this.file(note.id), text); return true; }
    if (!this.dk) return false;
    const iv = randomBytes(12), ct = await subtle.encrypt({ name: "AES-GCM", iv, additionalData: Buffer.from(`dgc-note:${note.id}`) }, this.dk, Buffer.from(text, "utf8"));
    this.write(this.file(note.id, true), JSON.stringify({ v: 1, iv: iv.toString("base64"), ct: Buffer.from(ct).toString("base64") }));
    return true;
  }

  // ---- the lock ---------------------------------------------------------------------------------------------------------
  private tries(): { wrong: number; until: number } { let kept: any; try { kept = this.context.globalState.get<any>(TRIES_KEY); } catch { kept = undefined; } return { wrong: Math.min(1000, stamp(kept?.wrong)), until: stamp(kept?.until) }; }
  private async setTries(next: { wrong: number; until: number }): Promise<void> { try { await this.context.globalState.update(TRIES_KEY, next.wrong || next.until ? next : undefined); } catch { /* counted in this window still */ } }
  private lockState(): NotesLock {
    const t = this.tries(), state = this.dk ? "unlocked" : this.record ? "locked" : this.index.notes.some((n) => n.locked) ? "nokey" : this.keychain === false ? "nokeychain" : "none";
    return { state, left: Math.max(0, TRIES_FREE - t.wrong), until: t.until > this.now() ? t.until : 0, digits: this.record?.digits ?? 0 };
  }
  /** The keychain's record, read again (another window may have set or changed the PIN, or forgotten it). */
  private async lockLoad(): Promise<void> {
    let raw: string | undefined, reached = true;
    try { raw = await this.context.secrets.get(LOCK_SECRET); } catch { reached = false; }
    let record: LockRecord | null = null;
    if (raw) { try { const r = JSON.parse(raw); if (r?.v === 1 && [r.salt, r.iv, r.key].every((x) => typeof x === "string" && x.length < 200) && Number.isInteger(r.iter) && r.iter >= 1000 && r.iter <= 50000000) record = { v: 1, salt: r.salt, iter: r.iter, iv: r.iv, key: r.key, digits: Math.max(4, Math.min(8, Number(r.digits) || 4)) }; } catch { record = null; } }
    this.record = record;
    if (!record) this.dk = undefined;
    if (!reached || this.env.weakKeychain?.()) this.keychain = false; else if (record) this.keychain = true;
  }
  /** Whether this computer keeps a secret and gives it back: tried once, when the first lock is asked for. */
  private async keychainWorks(): Promise<boolean> {
    if (this.keychain !== undefined) return this.keychain;
    const name = "dgc.notes.probe.v1", value = randomBytes(12).toString("hex");
    try { await this.context.secrets.store(name, value); const back = await this.context.secrets.get(name); await this.context.secrets.delete(name); this.keychain = back === value; } catch { this.keychain = false; }
    return this.keychain;
  }
  private async kek(pin: string, salt: Buffer, iter: number): Promise<webcrypto.CryptoKey> {
    const base = await subtle.importKey("raw", Buffer.from(pin, "utf8"), "PBKDF2", false, ["deriveKey"]);
    return subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  /** The notes' key wrapped under a PIN: a salt and a nonce of its own. */
  private async wrap(pin: string, raw: Uint8Array): Promise<LockRecord> {
    const salt = randomBytes(16), iv = randomBytes(12), key = await subtle.encrypt({ name: "AES-GCM", iv }, await this.kek(pin, salt, this.iterations), raw);
    return { v: 1, salt: salt.toString("base64"), iter: this.iterations, iv: iv.toString("base64"), key: Buffer.from(key).toString("base64"), digits: pin.length };
  }
  private async open(raw: Uint8Array): Promise<void> { this.dk = await subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]); this.openedAt = this.now(); this.arm(); }
  /** Lock now in another window of this editor locks this one too, the next time anything is done here. */
  private lockedElsewhere(): boolean { let at: unknown; try { at = this.context.globalState.get<unknown>(LOCKED_AT); } catch { at = 0; } return !!this.dk && stamp(at) > this.openedAt; }
  /** Notes lock again after a while with nothing done in Notes. */
  private arm(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { this.idleTimer = undefined; if (!this.dk) return; this.dk = undefined; this.all(this.state()); }, this.idleMs);
    (this.idleTimer as any).unref?.();
  }
  /** A PIN tried against the keychain's record. The try is counted before it is made; a wait refuses every try. */
  private async check(pin: unknown): Promise<Checked> {
    const record = this.record;
    if (!record) return { ok: false, why: this.index.notes.some((n) => n.locked) ? "nokey" : "nopin" };
    const t = this.tries(), now = this.now();
    if (t.until > now) return { ok: false, why: "wait", left: 0, until: t.until };
    if (typeof pin !== "string" || !PIN.test(pin)) return { ok: false, why: "wrong", left: Math.max(0, TRIES_FREE - t.wrong), until: 0 };
    const wrong = t.wrong + 1, wait = wrong < TRIES_FREE ? 0 : Math.min(3600, 30 * 2 ** Math.min(20, wrong - TRIES_FREE)) * 1000, until = wait ? now + wait : 0;
    await this.setTries({ wrong, until });
    try {
      const raw = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(record.iv, "base64") }, await this.kek(pin, Buffer.from(record.salt, "base64"), record.iter), Buffer.from(record.key, "base64")));
      await this.setTries({ wrong: 0, until: 0 });
      return { ok: true, raw };
    } catch { return { ok: false, why: "wrong", left: Math.max(0, TRIES_FREE - wrong), until }; }
  }
  /** One note locked: its words encrypted, and the plain file written over and removed. (A disk may keep old blocks.) */
  private async lockOne(note: NoteMeta): Promise<boolean> {
    if (note.locked || !this.dk) return false;
    const plain = this.file(note.id); let text: string;
    try { text = fs.readFileSync(plain, "utf8"); } catch { return false; }
    note.locked = true;
    try { if (!(await this.writeText(note, text))) throw new Error("locked"); } catch { note.locked = false; return false; }
    try { fs.writeFileSync(plain, Buffer.alloc(Buffer.byteLength(text, "utf8"))); } catch { /* removed all the same */ }
    try { fs.rmSync(plain, { force: true }); } catch { /* the next lock removes it */ }
    note.line = "";
    return true;
  }
  private async lockAct(m: any, reply: Reply | undefined, said: (more: object) => void): Promise<boolean> {
    const index = this.index;
    switch (m.op) {
      case "touch": return true;
      case "lockSet": {
        if (this.record) { said({ ok: false, why: "set" }); return true; }
        if (index.notes.some((n) => n.locked)) { said({ ok: false, why: "nokey" }); return true; }
        if (typeof m.pin !== "string" || !PIN.test(m.pin)) { said({ ok: false, why: "pin" }); return true; }
        if (this.env.weakKeychain?.() || !(await this.keychainWorks())) { this.keychain = false; said({ ok: false, why: "nokeychain" }); this.all(this.state(), reply); return true; }
        const raw = randomBytes(32), record = await this.wrap(m.pin, raw);
        try { await this.context.secrets.store(LOCK_SECRET, JSON.stringify(record)); if ((await this.context.secrets.get(LOCK_SECRET)) !== JSON.stringify(record)) throw new Error("not kept"); }
        catch { this.keychain = false; said({ ok: false, why: "nokeychain" }); this.all(this.state(), reply); return true; }
        this.record = record; await this.setTries({ wrong: 0, until: 0 }); await this.open(raw);
        const note = this.live(m.id); if (note) await this.lockOne(note);
        said({ ok: true }); this.changed(reply, note ? { id: note.id, by: m.by } : undefined); return true;
      }
      case "lockNote": {
        const note = this.live(m.id); if (!note || note.locked) return true;
        if (!this.dk) { said({ ok: false, why: this.record ? "locked" : "nopin" }); return true; }
        if (!(await this.lockOne(note))) { said({ ok: false, why: "failed" }); return true; }
        said({ ok: true, id: note.id }); this.changed(reply, { id: note.id, by: m.by }); return true;
      }
      case "unlock": {
        const tried = await this.check(m.pin);
        if (!tried.ok) { said(tried); this.all(this.state(), reply); return true; }
        await this.open(tried.raw); said({ ok: true }); this.all(this.state(), reply); return true;
      }
      case "lockNow": {
        if (!this.dk) return true;
        this.dk = undefined; if (this.idleTimer) clearTimeout(this.idleTimer);
        try { await this.context.globalState.update(LOCKED_AT, Math.max(this.now(), this.openedAt + 1)); } catch { /* this window is locked all the same */ }
        this.all(this.state(), reply); return true;
      }
      case "unlockNote": {
        const note = index.notes.find((n) => n.id === m.id && n.locked && !n.deleted); if (!note) return true;
        const tried = await this.check(m.pin);
        if (!tried.ok) { said(tried); this.all(this.state(), reply); return true; }
        await this.open(tried.raw);
        const text = await this.textOf(note);
        if (text === undefined) { said({ ok: false, why: "damaged" }); this.all(this.state(), reply); return true; }
        this.write(this.file(note.id), text); note.locked = false; note.line = noteLine(text);
        try { fs.rmSync(this.file(note.id, true), { force: true }); } catch { /* the plain file is the note now */ }
        said({ ok: true, id: note.id }); this.changed(reply, { id: note.id, by: m.by }); return true;
      }
      case "lockChange": {
        if (typeof m.pin !== "string" || !PIN.test(m.pin)) { said({ ok: false, why: "pin" }); return true; }
        const tried = await this.check(m.old);
        if (!tried.ok) { said(tried); this.all(this.state(), reply); return true; }
        const record = await this.wrap(m.pin, tried.raw);
        try { await this.context.secrets.store(LOCK_SECRET, JSON.stringify(record)); } catch { said({ ok: false, why: "nokeychain" }); return true; }
        this.record = record; await this.open(tried.raw); said({ ok: true }); this.all(this.state(), reply); return true;
      }
      // Forgot PIN: the locked notes cannot be read by anyone, so they are deleted for good (they skip Recently deleted,
      // and the ones waiting there go too); every other note stays. The next lock asks for a new PIN.
      case "lockForgot": {
        if (m.sure !== true) { said({ ok: false, why: "unsure" }); return true; }
        const gone = index.notes.filter((n) => n.locked);
        for (const n of gone) this.remove(n.id);
        index.notes = index.notes.filter((n) => !n.locked);
        try { await this.context.secrets.delete(LOCK_SECRET); } catch { /* there was none to delete */ }
        this.record = null; this.dk = undefined; if (this.idleTimer) clearTimeout(this.idleTimer); await this.setTries({ wrong: 0, until: 0 });
        said({ ok: true, deleted: gone.length }); this.changed(reply); return true;
      }
      default: return false;
    }
  }

  private async act(m: any, reply?: Reply): Promise<void> {
    const index = this.ready(), said = (more: object) => reply?.({ type: "homeNotesSaid", op: m.op, ...more });
    await this.lockLoad();
    if (this.lockedElsewhere()) { this.dk = undefined; if (this.idleTimer) clearTimeout(this.idleTimer); this.all(this.state(), reply); }
    if (this.dk) this.arm();      // something was done in Notes: they stay open ten minutes more
    if (await this.lockAct(m, reply, said)) return;
    switch (m.op) {
      case "get": reply?.(this.state()); return;
      case "open": {
        const note = index.notes.find((n) => n.id === m.id), id = String(m.id ?? "").slice(0, 24);
        if (!note) { reply?.({ type: "homeNoteText", id, ok: false, why: "gone" }); return; }
        const text = await this.textOf(note);
        reply?.(text === undefined ? { type: "homeNoteText", id, ok: false, why: note.locked ? (this.dk ? "damaged" : "locked") : "gone" } : { type: "homeNoteText", id, ok: true, text, edited: note.edited });
        return;
      }
      case "save": {
        const id = String(m.id ?? ""); if (!ID.test(id) || typeof m.text !== "string") return;
        const text = m.text.slice(0, NOTE_MOST); let note = index.notes.find((n) => n.id === id);
        if (note?.deleted) return;
        if (!note) {
          if (index.notes.filter((n) => !n.deleted).length >= NOTES_MOST) { said({ ok: false, why: "full", id }); return; }
          note = { id, title: "", line: "", folder: this.folder(m.folder) ?? "", created: this.now(), edited: 0, pinned: false, locked: false, deleted: 0 };
          index.notes.unshift(note);
        }
        if (!(await this.writeText(note, text))) { said({ ok: false, why: "locked", id }); return; }
        note.title = noteTitle(text); note.line = note.locked ? "" : noteLine(text); note.edited = this.now();
        this.changed(reply, { id, by: m.by });
        return;
      }
      case "pin": { const note = this.live(m.id); if (!note) return; note.pinned = m.on === true; this.changed(reply); return; }
      case "move": { const note = this.live(m.id), to = this.folder(m.folder); if (!note || to === undefined) return; note.folder = to; this.changed(reply); return; }
      case "delete": { const note = this.live(m.id); if (!note) return; note.deleted = this.now(); note.was = note.folder; note.folder = ""; note.pinned = false; this.changed(reply, { id: note.id, by: m.by }); return; }
      case "restore": {
        const note = index.notes.find((n) => n.id === m.id && n.deleted); if (!note) return;
        if (index.notes.filter((n) => !n.deleted).length >= NOTES_MOST) { said({ ok: false, why: "full", id: note.id }); return; }
        note.folder = this.folder(note.was) ?? ""; note.deleted = 0; delete note.was; this.changed(reply); return;
      }
      case "purge": { const note = index.notes.find((n) => n.id === m.id && n.deleted); if (!note) return; this.remove(note.id); index.notes = index.notes.filter((n) => n !== note); this.changed(reply); return; }
      case "empty": { const gone = index.notes.filter((n) => n.deleted); if (!gone.length) return; for (const n of gone) this.remove(n.id); index.notes = index.notes.filter((n) => !n.deleted); this.changed(reply); return; }
      case "folderNew": case "folderRename": {
        const name = folderName(m.name), id = String(m.id ?? ""), had = index.folders.find((f) => f.id === id);
        if (!name || !ID.test(id) || index.folders.some((f) => f.id !== id && f.name.toLowerCase() === name.toLowerCase())) { said({ ok: false, why: name ? "taken" : "empty" }); return; }
        if (m.op === "folderNew") { if (had || index.folders.length >= FOLDERS_MOST) return; index.folders.push({ id, name }); } else { if (!had) return; had.name = name; }
        this.changed(reply); return;
      }
      case "folderDelete": {
        const had = index.folders.find((f) => f.id === m.id); if (!had) return;
        for (const n of index.notes) { if (n.was === had.id) n.was = ""; if (n.folder !== had.id) continue; n.folder = ""; if (m.notes === "delete") { n.deleted = this.now(); n.was = ""; n.pinned = false; } }
        index.folders = index.folders.filter((f) => f !== had); if (index.shown === had.id) index.shown = "";
        this.changed(reply); return;
      }
      case "sort": { if (!SORTS.includes(m.by) || index.sort === m.by) return; index.sort = m.by; this.changed(reply); return; }
      case "shown": { const to = m.folder === "bin" ? "bin" : this.folder(m.folder); if (to === undefined || index.shown === to) return; index.shown = to; this.changed(reply); return; }
      case "search": { reply?.(await this.search(m)); return; }
      case "duplicate": {
        const note = this.live(m.id), id = String(m.newId ?? "");
        if (!note || !ID.test(id) || index.notes.some((n) => n.id === id)) { said({ ok: false, why: "id" }); return; }
        if (index.notes.filter((n) => !n.deleted).length >= NOTES_MOST) { said({ ok: false, why: "full" }); return; }
        const text = await this.textOf(note);
        if (text === undefined) { said({ ok: false, why: note.locked ? "locked" : "gone" }); return; }
        // (A locked note's copy is locked too: its words are never written unencrypted.)
        const copy: NoteMeta = { id, title: note.title, line: note.line, folder: note.folder, created: this.now(), edited: this.now(), pinned: false, locked: note.locked, deleted: 0 };
        if (!(await this.writeText(copy, text))) { said({ ok: false, why: "locked" }); return; }
        index.notes.splice(index.notes.indexOf(note) + 1, 0, copy);
        said({ ok: true, id }); this.changed(reply, { id, by: m.by }); return;
      }
      case "copy": case "export": case "tab": {
        const note = this.live(m.id); if (!note) return;
        if (m.op === "tab") { if (note.locked && !this.dk) said({ ok: false, why: "locked" }); else this.env.openTab?.(note.id); return; }
        const text = await this.textOf(note);
        if (text === undefined) { said({ ok: false, why: note.locked ? "locked" : "gone" }); return; }
        if (m.op === "copy") { await this.env.clipboard?.(m.as === "md" ? text : plainNote(text)); said({ ok: true }); return; }
        said({ ok: true, saved: (await this.env.saveFile?.({ name: `${fileName(note.title)}.md`, text, locked: note.locked }, reply)) === true }); return;
      }
      case "exportFolder": {
        const folder = this.folder(m.folder); if (folder === undefined) return;
        const files: { name: string; text: string }[] = [], used = new Set<string>(); let skipped = 0, locked = false;
        for (const note of index.notes) {
          if (note.deleted || (folder && note.folder !== folder)) continue;
          const text = await this.textOf(note); if (text === undefined) { skipped++; continue; }
          const base = fileName(note.title); let name = base, k = 1; while (used.has(name.toLowerCase())) name = `${base} ${++k}`;
          used.add(name.toLowerCase()); files.push({ name: `${name}.md`, text }); locked = locked || note.locked;
        }
        if (!files.length) { said({ ok: false, why: "empty", skipped }); return; }
        const where = await this.env.saveFolder?.({ name: fileName(folder ? index.folders.find((f) => f.id === folder)!.name : "All notes"), files, locked }, reply);
        said({ ok: true, saved: where ? files.length : 0, skipped, where: where ?? "" }); return;
      }
      // A link in a note, Ctrl+clicked: opened in the browser, and only an address of the web or of mail.
      case "link": { if (typeof m.url === "string" && m.url.length <= 2000 && /^(?:https?:\/\/|mailto:)[^\s<>"'`]+$/i.test(m.url)) this.env.openExternal?.(m.url); return; }
      default: return;
    }
  }

  /** The notes with those words in their title or their text, in `folder` ("" or none: every note; "bin": Recently
   *  deleted), each with the line the words are in ("" when they are in its title). A locked note is found by its title
   *  (by its words too while notes are unlocked: then it says only that they are inside, never the line). */
  private async search(m: any): Promise<object> {
    const q = typeof m.q === "string" ? m.q.slice(0, 200) : "", find = q.trim().toLowerCase(), folder = typeof m.folder === "string" ? m.folder : "", rows: { id: string; line: string; inside?: boolean }[] = [];
    const said = { type: "homeNotesFound", q, seq: Number.isFinite(Number(m.seq)) ? Number(m.seq) : 0, folder, rows };
    if (!find) return said;
    for (const note of this.index.notes) {
      if (folder === "bin" ? !note.deleted : note.deleted || (folder && note.folder !== folder)) continue;
      if (note.title.toLowerCase().includes(find)) { rows.push({ id: note.id, line: "" }); continue; }
      const text = await this.textOf(note); if (text === undefined || !text.toLowerCase().includes(find.split(" ")[0])) continue;
      for (const raw of text.split("\n")) {
        const line = plainLine(raw), at = line.toLowerCase().indexOf(find); if (at < 0) continue;
        if (note.locked) rows.push({ id: note.id, line: "", inside: true });
        else { const from = line.length <= 120 ? 0 : Math.max(0, Math.min(at - 40, line.length - 118)), cut = line.slice(from, from + (from ? 118 : 119)); rows.push({ id: note.id, line: line.length <= 120 ? line : `${from ? "…" : ""}${cut.trim()}${from + cut.length < line.length ? "…" : ""}` }); }
        break;
      }
      if (rows.length >= 200) break;
    }
    return said;
  }
}

const every = new WeakMap<object, Notes>();
/** The one Notes of this extension (every window's side bar and every note's tab share it). */
export function notesOf(context: vscode.ExtensionContext): Notes {
  let notes = every.get(context);
  if (!notes) { notes = new Notes(context); every.set(context, notes); }
  return notes;
}
