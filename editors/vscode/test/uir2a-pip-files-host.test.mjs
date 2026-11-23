// 15 Nov ask 59, the extension host's side (src/pipsView.ts): a file in a Pip's chat is opened, saved or handed to a
// player by the host, which asks DGC where it is kept (get_pip_message_file, Pips API 101, local only) and checks the
// answer before touching it. The page never gets the path, and may not ask for it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url), src = fileURLToPath(new URL("../src/", import.meta.url));
const view = (await build({ entryPoints: [src + "pipsView.ts"], bundle: true, write: false, platform: "node", format: "cjs", external: ["vscode"] })).outputFiles[0].text;
const PIP = "pip_" + "b".repeat(32);
function host(api, vscode = {}) {
  const posted = [], sent = [], out = { exports: {} };
  new Function("module", "exports", "require", view)(out, out.exports, (name) => (name === "vscode" ? vscode : require(name)));
  const editor = new out.exports.PipsEditor({}, (m) => { sent.push(m); return true; }, () => {});
  editor.attach((m) => posted.push(m));
  editor.ready({ pips_supported: true, pips_enabled: true, pips_api_version: api, image_spool: true, image_spool_dir: mkdtempSync(join(tmpdir(), "dgc-spool-")) }, {});
  return { editor, posted, sent };
}
const settle = async (predicate) => { for (let i = 0; i < 400 && !predicate(); i++) await new Promise((r) => setTimeout(r, 5)); };
/** A Pip chat's kept file, as DGC keeps one: <state>/chat_files/<pip>/<sha256>, no ending. */
function kept(bytes, digest = "c".repeat(64)) {
  const state = mkdtempSync(join(tmpdir(), "dgc-pips-")), folder = join(state, "chat_files", PIP);
  mkdirSync(folder, { recursive: true }); const path = join(folder, digest); writeFileSync(path, bytes);
  return { state, folder, path };
}
const stubs = () => {
  const s = { opened: [], info: [], asked: [], copied: [], choice: undefined };
  s.vscode = { commands: { executeCommand: async (...a) => { s.opened.push(a); } },
    Uri: { file: (p) => ({ fsPath: p, path: p, scheme: "file" }), joinPath: (base, name) => ({ fsPath: join(base.fsPath, name), path: join(base.fsPath, name), scheme: "file" }) },
    workspace: { workspaceFolders: undefined, fs: { copy: async (from, to, o) => { s.copied.push([from.fsPath, to.fsPath, o]); writeFileSync(to.fsPath, readFileSync(from.fsPath)); },
      // (What a download reads, to hand the page: the kept file itself.)
      stat: async (u) => ({ type: 1, size: readFileSync(u.fsPath).length }), readFile: async (u) => readFileSync(u.fsPath) } },
    window: { showInformationMessage: (m) => { s.info.push(m); }, showSaveDialog: async (o) => { s.asked.push(o); return s.choice; } } };
  return s;
};
const answer = (h, request, result) => h.editor.event({ type: "pips_result", request_id: request.request_id, command: "get_pip_message_file", ok: true, result });

test("59 host: Open asks DGC for the file, checks it, and opens a copy under its own name", async () => {
  const s = stubs(), h = host(101, s.vscode), zip = Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.alloc(5000, 3)]), k = kept(zip);
  h.editor.receive({ type: "pipsOpenFile", pip_id: PIP, message_id: "message_4", index: 1 });
  await settle(() => h.sent.length);
  const request = h.sent[0].request;
  assert.deepEqual({ ...request, request_id: undefined }, { type: "get_pip_message_file", pip_id: PIP, message_id: "message_4", index: 1, request_id: undefined });
  answer(h, request, { pip_id: PIP, message_id: "message_4", index: 1, name: "checkout-logs.zip", mime: "application/zip", bytes: zip.length, path: k.path });
  await settle(() => s.opened.length || s.info.length);
  assert.deepEqual(s.info, []);
  const [[command, target]] = s.opened;
  assert.equal(command, "vscode.open");
  assert.match(target.fsPath, /message_4[\\/]1[\\/]checkout-logs\.zip$/, "under the name a person gave it, not its digest");
  assert.deepEqual(readFileSync(target.fsPath), zip);
  assert.notEqual(target.fsPath, k.path, "the kept file itself is never the one opened (an edit would break its digest)");
  assert.equal(h.posted.some((m) => JSON.stringify(m).includes(k.path)), false, "the page is never told where it is kept");
});

// Asked 18 Nov: Save a copy… saves on the computer the editor runs on: the kept file goes to the page, which saves it
// there (media/shared/download.js). Never a save dialog, which over a remote connection browses the remote machine.
test("59 host: Save a copy… hands the kept file to the page, under its own name, to save on this computer; no save dialog", async () => {
  const s = stubs(), h = host(101, s.vscode), bytes = Buffer.alloc(9000, 9), k = kept(bytes);
  const before = h.sent.length; h.editor.receive({ type: "pipsOpenFile", pip_id: PIP, message_id: "message_4", index: 0, save: true }); await settle(() => h.sent.length > before);
  answer(h, h.sent.at(-1).request, { pip_id: PIP, message_id: "message_4", index: 0, name: "checkout-flow.webm", mime: "video/webm", bytes: bytes.length, path: k.path });
  await settle(() => h.posted.some((m) => m.type === "dgcDownload"));
  const handed = h.posted.find((m) => m.type === "dgcDownload");
  assert.deepEqual([handed.name, handed.mime], ["checkout-flow.webm", "video/webm"]);
  assert.deepEqual(Buffer.from(handed.data), bytes);
  assert.deepEqual([s.asked, s.copied, s.info, s.opened], [[], [], [], []], "no dialog, nothing written here, nothing opens in a tab");
});

test("59 host: a video's or a sound's bytes are handed to its player; anything else, or a file that isn't the kept one, is not", async () => {
  const s = stubs(), h = host(101, s.vscode), clip = Buffer.alloc(40000, 5), k = kept(clip);
  const ask = async (id, result, message = {}) => { const before = h.sent.length; h.editor.receive({ type: "pipsFileData", requestId: id, pip_id: PIP, message_id: "message_4", index: 0, ...message });
    await settle(() => h.sent.length > before || h.posted.some((m) => m.requestId === id));
    if (h.sent.length > before) answer(h, h.sent.at(-1).request, { pip_id: PIP, message_id: "message_4", index: 0, name: "checkout-flow.webm", mime: "video/webm", bytes: clip.length, path: k.path, ...result });
    await settle(() => h.posted.some((m) => m.requestId === id)); return h.posted.find((m) => m.requestId === id); };
  const good = await ask("v1", {});
  assert.equal(good.type, "pipsFileData"); assert.equal(good.mime, "video/webm"); assert.equal(good.error, undefined);
  assert.deepEqual(Buffer.from(good.data), clip); assert.equal(good.path, undefined);
  assert.equal((await ask("v2", { mime: "audio/mpeg", name: "note.mp3" })).mime, "audio/mpeg");
  // Not a video or a sound: never read into the page.
  assert.match((await ask("z1", { mime: "application/zip", name: "logs.zip" })).error, /can't be played here/);
  // Not where a Pip chat's files are kept, a link, another Pip's folder, another size, another message: never read.
  const stray = join(k.state, "c".repeat(64)); writeFileSync(stray, clip);
  assert.match((await ask("o1", { path: stray })).error, /no longer available/);
  const link = join(k.folder, "d".repeat(64)); symlinkSync(stray, link);
  assert.match((await ask("o2", { path: link })).error, /no longer available/);
  const other = join(k.state, "chat_files", "pip_" + "e".repeat(32)); mkdirSync(other); writeFileSync(join(other, "c".repeat(64)), clip);
  assert.match((await ask("o3", { path: join(other, "c".repeat(64)) })).error, /no longer available/);
  assert.match((await ask("o4", { bytes: clip.length + 1 })).error, /no longer available/);
  assert.match((await ask("o5", { message_id: "message_5" })).error, /no longer available/);
  assert.match((await ask("o6", { path: join(k.folder, "notes.txt") })).error, /no longer available/);
  // What the page sends is checked before DGC is asked anything.
  const before = h.sent.length;
  assert.match((await ask("b1", {}, { pip_id: "../x" })).error, /no longer available/);
  assert.match((await ask("b2", {}, { index: -1 })).error, /no longer available/);
  assert.equal(h.sent.length, before);
});

test("59 host: before Pips API 101 nothing is asked, and the page may never ask DGC for a file's place itself", async () => {
  const s = stubs(), old = host(100, s.vscode);
  old.editor.receive({ type: "pipsOpenFile", pip_id: PIP, message_id: "m", index: 0 });
  old.editor.receive({ type: "pipsFileData", requestId: "q", pip_id: PIP, message_id: "m", index: 0 });
  await settle(() => s.info.length && old.posted.some((m) => m.requestId === "q"));
  assert.deepEqual(s.info, ["That file is no longer available."]); assert.equal(old.sent.length, 0);
  const h = host(101, s.vscode);
  h.editor.receive({ type: "pipsRequest", id: "direct", request: { type: "get_pip_message_file", pip_id: PIP, message_id: "m", index: 0 } });
  await settle(() => h.posted.some((m) => m.id === "direct"));
  assert.equal(h.posted.find((m) => m.id === "direct").ok, false, "refused");
  assert.equal(h.sent.length, 0, "and never sent on");
  assert.ok(existsSync(src + "pipsView.ts"));
});
