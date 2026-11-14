// The Notes host (src/notes.ts) for tests: the real module, bundled against a stub `vscode`, on a folder of its own
// under the system's temp folder, with a stand-in for the editor's state and its keychain. Nothing here touches a real
// home, a real keychain or a network. Not a *.test.mjs file.
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const root = new URL("../..", import.meta.url).pathname;
let loaded;
export async function notesModule() {
  if (loaded) return loaded;
  globalThis.__NOTES_VSCODE = {};
  const out = await build({ entryPoints: [root + "src/notes.ts"], bundle: true, write: false, format: "cjs", platform: "node",
    plugins: [{ name: "vscode", setup(b) { b.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "stub" }));
      b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "module.exports = globalThis.__NOTES_VSCODE;" })); } }] });
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, createRequire(import.meta.url));
  return (loaded = mod.exports);
}
export const OLD_KEY = "dgc.homeCards.v1";
const made = [];
/** A folder of its own; every one made is removed by `cleanup()`. */
export const folder = () => { const dir = mkdtempSync(join(tmpdir(), "dgc-notes-test-")); made.push(dir); return dir; };
export const cleanup = () => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }); };
/** The editor as the host sees it: its state, its storage folder, its keychain (`keychain: false`: one that refuses). */
export function context(dir = folder(), { state = {}, keychain = true } = {}) {
  const kept = new Map(Object.entries(JSON.parse(JSON.stringify(state)))), secrets = new Map();
  const refuse = async () => { throw new Error("no keychain"); };
  return { dir, kept, secretsKept: secrets,
    globalState: { get: (k) => kept.get(k), update: async (k, v) => { if (v === undefined) kept.delete(k); else kept.set(k, JSON.parse(JSON.stringify(v))); } },
    globalStorageUri: { fsPath: dir },
    secrets: keychain ? { get: async (k) => secrets.get(k), store: async (k, v) => { secrets.set(k, String(v)); }, delete: async (k) => { secrets.delete(k); } } : { get: refuse, store: refuse, delete: refuse } };
}
/** One message to the host, and everything it answered with once it rested. */
export async function ask(notes, message) { const said = []; notes.handle(message, (m) => said.push(JSON.parse(JSON.stringify(m)))); await notes.idle(); return said; }
/** One thing done; the notes as the host has them afterwards. */
export async function act(notes, op, more = {}) { await ask(notes, { type: "homeNotesDo", op, ...more }); return notes.state(); }
/** Notes and folders put straight into a folder's files, as the host keeps them (for a scene that starts with some).
 *  notes: [{ id, text, folder?, pinned?, created?, edited?, deleted?, was? }]; folders: [{ id, name }]. */
export async function seed(c, { notes = [], folders = [], sort = "edited", shown = "" } = {}) {
  const { mkdirSync, writeFileSync } = await import("node:fs"), { noteTitle, noteLine } = await notesModule(), dir = join(c.dir, "notes");
  mkdirSync(dir, { recursive: true });
  for (const n of notes) writeFileSync(join(dir, `${n.id}.md`), n.text);
  writeFileSync(join(dir, "index.json"), JSON.stringify({ v: 1, folders, sort, shown, notes: notes.map((n) => ({ id: n.id, title: noteTitle(n.text), line: noteLine(n.text), folder: n.folder || "", created: n.created || n.edited || 1, edited: n.edited || n.created || 1,
    pinned: !!n.pinned, locked: false, deleted: n.deleted || 0, ...(n.deleted ? { was: n.was || "" } : {}) })) }));
  return c;
}
