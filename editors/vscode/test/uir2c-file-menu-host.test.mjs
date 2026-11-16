// 2b, the extension host's side: what a file's menu asks for is done by the host (src/fileActs.ts, one module for every
// surface). A Pip's chat names a message and a file's number (src/pipsView.ts asks DGC where it is kept and checks it);
// Work names a file as the session named it (src/panel.ts finds it inside the project again). Nothing takes a path the
// page made up, and a file DGC keeps is never pointed at. (ChatDGC's side is in chatdgc-tabs.test.mjs: "uir2c 2b".)
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url), src = fileURLToPath(new URL("../src/", import.meta.url));
const bundle = async (file) => (await build({ entryPoints: [src + file], bundle: true, write: false, platform: "node", format: "cjs", external: ["vscode"] })).outputFiles[0].text;
const load = (code, vscode) => { const out = { exports: {} }; new Function("module", "exports", "require", code)(out, out.exports, (name) => (name === "vscode" ? vscode : require(name))); return out.exports; };
const settle = async (predicate) => { for (let i = 0; i < 400 && !predicate(); i++) await new Promise((r) => setTimeout(r, 5)); };
const stubs = () => {
  const s = { ran: [], shown: [], info: [], warn: [], asked: [], copied: [], clip: [], choice: undefined };
  s.vscode = { commands: { executeCommand: async (...a) => { s.ran.push(a); } },
    Uri: { file: (p) => ({ fsPath: p, path: p, scheme: "file" }), joinPath: (base, name) => ({ fsPath: join(base.fsPath, name), path: join(base.fsPath, name), scheme: "file" }) },
    env: { clipboard: { writeText: async (t) => { s.clip.push(t); } } },
    workspace: { workspaceFolders: undefined, fs: { copy: async (from, to, o) => { s.copied.push([from.fsPath, to.fsPath, o]); writeFileSync(to.fsPath, readFileSync(from.fsPath)); } } },
    window: { showInformationMessage: (m) => { s.info.push(m); }, showWarningMessage: (m) => { s.warn.push(m); }, showSaveDialog: async (o) => { s.asked.push(o); return s.choice; },
      showTextDocument: async (uri, o) => { s.shown.push([uri.fsPath, o]); }, setStatusBarMessage: (m) => { s.info.push(`status: ${m}`); } } };
  return s;
};
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const acts = await bundle("fileActs.ts");
function actsHost(s) { const said = [], pictures = [], folder = mkdtempSync(join(tmpdir(), "dgc-acts-")); return { said, pictures, folder, host: { say: (w) => said.push(w), picture: (d) => pictures.push(d), copyFolder: async () => join(folder, "copy") } }; }

test("a file DGC keeps for a chat: Open and Open in editor show a private copy under its own name; Copy path and Reveal are never done", async () => {
  const s = stubs(), m = load(acts, s.vscode), h = actsHost(s), keptAt = join(mkdtempSync(join(tmpdir(), "dgc-kept-")), "c".repeat(64));
  writeFileSync(keptAt, "# Notes\n\nCheck the totals.\n");
  const kept = { path: keptAt, name: "checkout-notes.md" };
  assert.equal(await m.keptFileAct("open", kept, h.host), true);
  const [[command, target]] = s.ran;
  assert.equal(command, "vscode.open"); assert.match(target.fsPath, /copy[\\/]checkout-notes\.md$/); assert.notEqual(target.fsPath, keptAt, "the kept file itself is never the one opened");
  assert.equal(statSync(target.fsPath).mode & 0o777, 0o600); assert.equal(statSync(dirname(target.fsPath)).mode & 0o777, 0o700, "a private copy in a private folder");
  assert.equal(await m.keptFileAct("editor", kept, h.host), true);
  assert.match(s.shown[0][0], /checkout-notes\.md$/); assert.notEqual(s.shown[0][0], keptAt); assert.deepEqual(s.shown[0][1], { preview: false }, "Open in editor: an editor tab that stays");
  assert.equal(await m.keptFileAct("copy", kept, h.host), true);
  assert.deepEqual([s.clip, h.said], [["# Notes\n\nCheck the totals.\n"], ["Text copied"]], "Copy: a text file's text");
  for (const act of ["path", "reveal"]) assert.equal(await m.keptFileAct(act, kept, h.host), false, act);
  assert.equal(s.clip.length, 1, "where DGC keeps it is never put on the clipboard"); assert.equal(s.ran.filter((r) => r[0] === "revealFileInOS").length, 0);
  assert.equal(await m.keptFileAct("remove", kept, h.host), false, "nothing but the six"); assert.equal(await m.keptFileAct("cut", kept, h.host), false);
  // A name with folders in it is one name, inside the private folder.
  await m.keptFileAct("open", { path: keptAt, name: "../../escape.md" }, h.host);
  assert.equal(dirname(s.ran.at(-1)[1].fsPath), join(h.folder, "copy"));
});

test("a kept picture is handed to the page for its clipboard; a kept zip is neither copied nor opened in an editor; Save a copy… asks where", async () => {
  const s = stubs(), m = load(acts, s.vscode), h = actsHost(s), dir = mkdtempSync(join(tmpdir(), "dgc-kept-")), pic = join(dir, "a".repeat(64)), zip = join(dir, "b".repeat(64));
  writeFileSync(pic, PNG); writeFileSync(zip, Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.alloc(500, 3)]));
  assert.equal(await m.keptFileAct("copy", { path: pic, name: "last-step.png" }, h.host), true);
  assert.deepEqual(h.pictures, [`data:image/png;base64,${PNG.toString("base64")}`]); assert.deepEqual(s.clip, []);
  assert.equal(await m.keptFileAct("copy", { path: zip, name: "logs.zip" }, h.host), false); assert.equal(await m.keptFileAct("editor", { path: zip, name: "logs.zip" }, h.host), false);
  assert.deepEqual([s.clip, s.shown, h.pictures.length], [[], [], 1]);
  // A file named as text that isn't: nothing reaches the clipboard.
  assert.equal(await m.keptFileAct("copy", { path: zip, name: "not-text.txt" }, h.host), false); assert.deepEqual(s.clip, []); assert.match(s.warn.at(-1), /isn't text/);
  s.choice = { fsPath: join(dir, "out.zip"), path: join(dir, "out.zip"), scheme: "file" };
  assert.equal(await m.keptFileAct("save", { path: zip, name: "logs.zip" }, h.host), true);
  assert.match(s.asked[0].defaultUri.fsPath, /logs\.zip$/); assert.equal(s.asked[0].saveLabel, "Save a copy"); assert.deepEqual(readFileSync(join(dir, "out.zip")), readFileSync(zip)); assert.deepEqual(s.info, ["Saved out.zip."]);
  s.choice = undefined; assert.equal(await m.keptFileAct("save", { path: zip, name: "logs.zip" }, h.host), false, "Cancel saves nothing");
});

test("a file in the project does all six: its real path is copied and revealed, its text copied, a copy saved", async () => {
  const s = stubs(), m = load(acts, s.vscode), h = actsHost(s), dir = mkdtempSync(join(tmpdir(), "dgc-proj-")), file = join(dir, "totals.py");
  writeFileSync(file, "def total(xs):\n    return sum(xs)\n");
  assert.equal(await m.projectFileAct("path", file, h.host), true); assert.deepEqual([s.clip, h.said], [[file], ["Path copied"]]);
  assert.equal(await m.projectFileAct("reveal", file, h.host), true); assert.deepEqual([s.ran.at(-1)[0], s.ran.at(-1)[1].fsPath], ["revealFileInOS", file]);
  assert.equal(await m.projectFileAct("copy", file, h.host), true); assert.equal(s.clip.at(-1), "def total(xs):\n    return sum(xs)\n");
  assert.equal(await m.projectFileAct("editor", file, h.host), true); assert.deepEqual(s.shown.at(-1), [file, { preview: false }]);
  assert.equal(await m.projectFileAct("open", file, h.host), true); assert.deepEqual([s.ran.at(-1)[0], s.ran.at(-1)[1].fsPath], ["vscode.open", file]);
  assert.equal(await m.projectFileAct("remove", file, h.host), false);
});

// ---- a Pip's chat (src/pipsView.ts) ------------------------------------------------------------------------------------
const view = await bundle("pipsView.ts");
const PIP = "pip_" + "b".repeat(32);
function pipsHost(api, vscode) {
  const posted = [], sent = [], m = load(view, vscode);
  const editor = new m.PipsEditor({}, (c) => { sent.push(c); return true; }, () => {});
  editor.attach((x) => posted.push(x));
  editor.ready({ pips_supported: true, pips_enabled: true, pips_api_version: api, image_spool: true, image_spool_dir: mkdtempSync(join(tmpdir(), "dgc-spool-")) }, {});
  return { editor, posted, sent };
}
function keptFile(bytes, digest = "c".repeat(64)) {
  const state = mkdtempSync(join(tmpdir(), "dgc-pips-")), folder = join(state, "chat_files", PIP);
  mkdirSync(folder, { recursive: true }); const path = join(folder, digest); writeFileSync(path, bytes);
  return { state, folder, path };
}
const answer = (h, request, result) => h.editor.event({ type: "pips_result", request_id: request.request_id, command: "get_pip_message_file", ok: true, result });

test("a Pip's chat host: each of the menu's picks asks DGC for the file by its message and number, checks it, and does it; the page never learns where it is kept", async () => {
  const s = stubs(), h = pipsHost(101, s.vscode), text = Buffer.from("# Checkout notes\n\nCard first, then address.\n"), k = keptFile(text);
  const pick = async (act, more = {}) => { const before = h.sent.length; h.editor.receive({ type: "pipsFileAct", act, pip_id: PIP, message_id: "message_4", index: 0, ...more }); await settle(() => h.sent.length > before);
    if (h.sent.length === before) return false;
    assert.deepEqual({ ...h.sent.at(-1).request, request_id: undefined }, { type: "get_pip_message_file", pip_id: PIP, message_id: "message_4", index: 0, request_id: undefined });
    answer(h, h.sent.at(-1).request, { pip_id: PIP, message_id: "message_4", index: 0, name: "checkout-notes.md", mime: "text/markdown", bytes: text.length, path: k.path }); return true; };
  assert.equal(await pick("open"), true); await settle(() => s.ran.length);
  assert.equal(s.ran[0][0], "vscode.open"); assert.match(s.ran[0][1].fsPath, /checkout-notes\.md$/); assert.notEqual(s.ran[0][1].fsPath, k.path);
  assert.equal(await pick("editor"), true); await settle(() => s.shown.length);
  assert.match(s.shown[0][0], /checkout-notes\.md$/); assert.notEqual(s.shown[0][0], k.path);
  assert.equal(await pick("copy"), true); await settle(() => s.clip.length);
  assert.deepEqual(s.clip, [text.toString()]);
  await settle(() => h.posted.some((m) => m.type === "pipsFileSaid"));
  assert.equal(h.posted.find((m) => m.type === "pipsFileSaid").words, "Text copied");
  s.choice = { fsPath: join(k.state, "notes.md"), path: join(k.state, "notes.md"), scheme: "file" };
  assert.equal(await pick("save"), true); await settle(() => s.info.length);
  assert.deepEqual(readFileSync(join(k.state, "notes.md")), text);
  // Copy path and Reveal: DGC keeps this copy for the chat. Nothing is asked, copied or revealed.
  const clips = s.clip.length, ran = s.ran.length;
  for (const act of ["path", "reveal"]) { await pick(act); await new Promise((r) => setTimeout(r, 30)); }
  assert.deepEqual([s.clip.length, s.ran.length], [clips, ran]);
  assert.equal(h.posted.some((m) => JSON.stringify(m).includes(k.path)), false, "the page is never told where it is kept");
});

test("a Pip's chat host refuses what isn't the menu's: another act, a path from the page, a file that isn't the kept one, an older DGC", async () => {
  const s = stubs(), h = pipsHost(101, s.vscode), k = keptFile(Buffer.from("hello"));
  const before = h.sent.length;
  h.editor.receive({ type: "pipsFileAct", act: "remove", pip_id: PIP, message_id: "message_4", index: 0 });
  h.editor.receive({ type: "pipsFileAct", act: "open", pip_id: "../etc", message_id: "message_4", index: 0 });
  h.editor.receive({ type: "pipsFileAct", act: "open", pip_id: PIP, message_id: "message_4", index: 99 });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.sent.length, before, "none of them is asked of DGC");
  // A path the page sends is not looked at: the file is DGC's answer, checked.
  const outside = join(k.state, "outside.txt"); writeFileSync(outside, "secret");
  h.editor.receive({ type: "pipsFileAct", act: "open", pip_id: PIP, message_id: "message_4", index: 0, path: outside, file_path: outside });
  await settle(() => h.sent.length > before);
  assert.equal(JSON.stringify(h.sent.at(-1)).includes(outside), false);
  // DGC's answer names a file that is a link out of the kept folder: refused.
  const link = join(k.folder, "d".repeat(64)); symlinkSync(outside, link);
  answer(h, h.sent.at(-1).request, { pip_id: PIP, message_id: "message_4", index: 0, name: "hello.txt", mime: "text/plain", bytes: 6, path: link });
  await settle(() => s.info.length);
  assert.deepEqual(s.ran, []); assert.match(s.info.at(-1), /no longer available/);
  const old = pipsHost(100, stubs().vscode), sentBefore = old.sent.length;
  old.editor.receive({ type: "pipsFileAct", act: "open", pip_id: PIP, message_id: "message_4", index: 0 }); await new Promise((r) => setTimeout(r, 30));
  assert.equal(old.sent.length, sentBefore, "a DGC that sends no files is asked for none");
});

// ---- Work (src/panel.ts) -----------------------------------------------------------------------------------------------
const { makeProvider, cleanup, workspaceFolders } = await import("./support/panel-bundle.mjs");
after(() => cleanup());
test("Work's host: a file is found inside the project again before any of the six is done; one outside it, or a link out of it, is refused", async () => {
  const { provider, posted } = makeProvider(), V = globalThis.__DGC_TEST_VSCODE, root = workspaceFolders[0].uri.fsPath;
  mkdirSync(join(root, "billing"), { recursive: true }); writeFileSync(join(root, "billing", "totals.py"), "TOTAL = 3\n");
  const outside = join(mkdtempSync(join(tmpdir(), "dgc-out-")), "secret.txt"); writeFileSync(outside, "secret");
  symlinkSync(outside, join(root, "billing", "link.txt"));
  const seen = { clip: [], ran: [], shown: [], info: [] }, was = { clip: V.env.clipboard.writeText, run: V.commands.executeCommand, shown: V.window.showTextDocument, info: V.window.showInformationMessage, status: V.window.setStatusBarMessage };
  V.env.clipboard.writeText = async (t) => { seen.clip.push(t); }; V.commands.executeCommand = async (...a) => { seen.ran.push(a); };
  V.window.showTextDocument = async (uri, o) => { seen.shown.push([uri.fsPath, o]); }; V.window.showInformationMessage = (m) => { seen.info.push(m); }; V.window.setStatusBarMessage = () => ({ dispose() {} });
  try {
    const pick = async (act, path) => { await provider.onMessage({ type: "fileAct", act, file: { kind: "project", path } }); await new Promise((r) => setTimeout(r, 20)); };
    const real = readFileSync(join(root, "billing", "totals.py")) && require("node:fs").realpathSync(join(root, "billing", "totals.py"));
    await pick("path", "billing/totals.py"); assert.deepEqual(seen.clip, [real], "Copy path: the file's real place");
    await pick("reveal", "billing/totals.py"); assert.deepEqual([seen.ran.at(-1)[0], seen.ran.at(-1)[1].fsPath], ["revealFileInOS", real]);
    await pick("copy", "billing/totals.py"); assert.equal(seen.clip.at(-1), "TOTAL = 3\n");
    await pick("editor", "billing/totals.py"); assert.equal(seen.shown.at(-1)[0], real);
    const counts = () => [seen.clip.length, seen.ran.length, seen.shown.length];
    const before = counts();
    for (const bad of [outside, "../../etc/passwd", "billing/link.txt", "billing/missing.py", ""]) for (const act of ["open", "editor", "copy", "path", "reveal", "save"]) await pick(act, bad);
    await pick("remove", "billing/totals.py"); await provider.onMessage({ type: "fileAct", act: "path", file: { kind: "kept", path: join(root, "billing", "totals.py") } });
    assert.deepEqual(counts(), before, "nothing outside the project, and nothing but the six");
    assert.equal(posted.some((m) => JSON.stringify(m).includes("secret")), false);
  } finally { V.env.clipboard.writeText = was.clip; V.commands.executeCommand = was.run; V.window.showTextDocument = was.shown; V.window.showInformationMessage = was.info; V.window.setStatusBarMessage = was.status; }
});
