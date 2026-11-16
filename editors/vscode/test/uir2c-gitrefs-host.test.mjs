// 2d, the extension host's side of commits and issues as links (src/gitRefs.ts, one module for Work and a Pip's chat):
// the host alone runs git, read-only, in the project's folder: a hash is a link only once `git cat-file -e` says it is
// a commit, a commit opens as a read-only document of `git show`, and GitHub is named only when the remote is GitHub.
// A real repository made here, with its own HOME and no global config; nothing touches a network.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url), src = fileURLToPath(new URL("../src/", import.meta.url));
const bundle = async (file) => (await build({ entryPoints: [src + file], bundle: true, write: false, platform: "node", format: "cjs", external: ["vscode"], logLevel: "silent" })).outputFiles[0].text;
const load = (code, vscode) => { const out = { exports: {} }; new Function("module", "exports", "require", code)(out, out.exports, (name) => (name === "vscode" ? vscode : require(name))); return out.exports; };
const settle = async (predicate) => { for (let i = 0; i < 600 && !predicate(); i++) await new Promise((r) => setTimeout(r, 5)); };

const home = mkdtempSync(join(tmpdir(), "dgc-git-home-"));
const ENV = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.invalid",
  GIT_AUTHOR_DATE: "2026-11-16T08:00:00Z", GIT_COMMITTER_DATE: "2026-11-16T08:00:00Z", GIT_TERMINAL_PROMPT: "0" };
Object.assign(process.env, { HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });       // (what the host's own git sees in this test)
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();
/** A project with two commits. `remote`: its origin's address ("" for none). */
function repo(remote = "git@github.com:acme/shop.git", at = mkdtempSync(join(tmpdir(), "dgc-git-"))) {
  mkdirSync(at, { recursive: true }); git(at, "init", "-q", "-b", "main");
  writeFileSync(join(at, "totals.py"), "TOTAL = 1\n"); git(at, "add", "."); git(at, "commit", "-q", "-m", "Add totals");
  writeFileSync(join(at, "totals.py"), "TOTAL = 2\n"); git(at, "commit", "-q", "-am", "Totals count twice");
  if (remote) git(at, "remote", "add", "origin", remote);
  const head = git(at, "rev-parse", "HEAD"), tree = git(at, "rev-parse", "HEAD^{tree}"), blob = git(at, "rev-parse", "HEAD:totals.py");
  return { at, head, short: head.slice(0, 7), first: git(at, "rev-parse", "HEAD~1"), tree, blob };
}
const refs = load(await bundle("gitRefs.ts"), {});

test("a hash is known only when git says it is a commit: a tree, a blob, a hash that isn't there and anything that isn't a hash are not", async () => {
  const r = repo(), G = new refs.GitRefs();
  const got = await G.answer(r.at, [r.short, r.head, r.first.slice(0, 12), r.tree.slice(0, 10), r.blob.slice(0, 10), "deadbee", "DEADBEEF", "--help", "HEAD", "a1b2c3d; touch x", "abc", r.short + "^{tree}", "-" + r.short]);
  assert.deepEqual(got.known, { [r.short]: true, [r.head]: true, [r.first.slice(0, 12)]: true, [r.tree.slice(0, 10)]: false, [r.blob.slice(0, 10)]: false, deadbee: false }, "only well-formed hashes are answered at all");
  assert.deepEqual([got.remote, got.github], [true, "acme/shop"]);
  assert.equal(existsSync(join(r.at, "x")), false);
});

test("the remote: GitHub by ssh or https is named; another host is a remote but not GitHub; none is none; no repository is nothing", async () => {
  const G = new refs.GitRefs();
  for (const [remote, want] of [["https://github.com/acme/shop.git", [true, "acme/shop"]], ["https://github.com/acme/shop", [true, "acme/shop"]], ["ssh://git@github.com/acme/shop-2.git", [true, "acme/shop-2"]],
    ["https://token:secret@github.com/acme/shop.git", [true, "acme/shop"]], ["https://gitlab.example/acme/shop.git", [true, ""]], ["https://github.com.evil.example/acme/shop.git", [true, ""]], ["", [false, ""]]]) {
    const r = repo(remote), got = await G.answer(r.at, [r.short]);
    assert.deepEqual([got.remote, got.github], want, remote || "no remote");
    assert.deepEqual(got.known, remote ? { [r.short]: true } : {}, "a project with no remote links nothing");
    assert.equal(JSON.stringify(got).includes("secret"), false);
  }
  const plain = mkdtempSync(join(tmpdir(), "dgc-nogit-")), got = await G.answer(plain, ["a1b2c3d"]);
  assert.deepEqual(got, { remote: false, github: "", known: {} });
  assert.deepEqual(await G.answer("", ["a1b2c3d"]), { remote: false, github: "", known: {} });
});

test("a commit's text is `git show`, read-only, with its GitHub address first when the remote is GitHub; a hash that isn't a commit shows nothing", async () => {
  const r = repo(), G = new refs.GitRefs();
  const text = await G.show(r.at, r.short);
  assert.match(text.split("\n")[0], new RegExp(`^View on GitHub: https://github\\.com/acme/shop/commit/${r.head}$`));
  assert.match(text, /Totals count twice/); assert.match(text, /-TOTAL = 1\n\+TOTAL = 2/);
  assert.equal(await G.show(r.at, r.tree.slice(0, 10)), ""); assert.equal(await G.show(r.at, "--output=/tmp/x"), ""); assert.equal(await G.show(r.at, "deadbee"), "");
  const other = repo("https://gitlab.example/acme/shop.git");
  assert.doesNotMatch(await G.show(other.at, other.short), /GitHub/);
  assert.equal(git(r.at, "status", "--porcelain"), "", "nothing in the project changed");
});

test("answers are kept: the same hash is not asked of git twice", async () => {
  const r = repo(), G = new refs.GitRefs();
  await G.answer(r.at, [r.short, "deadbee"]); const ran = G.ran;
  const again = await G.answer(r.at, [r.short, "deadbee"]);
  assert.deepEqual(again.known, { [r.short]: true, deadbee: false }); assert.equal(G.ran, ran, "from what it already knows");
  assert.ok((await G.answer(r.at, Array.from({ length: 500 }, (_, i) => (0xabc0000 + i).toString(16)))).known && Object.keys((await G.answer(r.at, Array.from({ length: 500 }, (_, i) => (0xabc0000 + i).toString(16)))).known).length <= 64, "and never more than a page of them at once");
});

// ---- Work (src/panel.ts) ---------------------------------------------------------------------------------------------
const { makeProvider, cleanup, workspaceFolders } = await import("./support/panel-bundle.mjs");
after(() => cleanup());
test("Work's host: the page's question is answered from this window's project, and a commit opens as a read-only document", async () => {
  const { provider, posted } = makeProvider(), V = globalThis.__DGC_TEST_VSCODE, root = workspaceFolders[0].uri.fsPath;
  const r = repo("git@github.com:acme/shop.git", root);
  const opened = [], was = { open: V.workspace.openTextDocument, show: V.window.showTextDocument, reg: V.workspace.registerTextDocumentContentProvider, parse: V.Uri.parse };
  let source = null;
  V.workspace.registerTextDocumentContentProvider = (scheme, p) => { source = { scheme, p }; return { dispose() {} }; };
  V.Uri.parse = V.Uri.parse || ((text) => ({ toString: () => text, scheme: text.split(":")[0], path: text.replace(/^[^:]+:/, "").split("?")[0], query: text.split("?")[1] || "" }));
  V.workspace.openTextDocument = async (uri) => ({ uri, getText: async () => source.p.provideTextDocumentContent(uri) });
  V.window.showTextDocument = async (doc, o) => { opened.push([doc.uri, o, await doc.getText()]); };
  try {
    await provider.onMessage({ type: "gitRefs", hashes: [r.short, "deadbee", "--help"], folder: "/etc", cwd: "/etc" });
    await settle(() => posted.some((m) => m.type === "gitRefs"));
    const said = posted.filter((m) => m.type === "gitRefs").at(-1);
    assert.deepEqual({ ...said }, { type: "gitRefs", remote: true, github: "acme/shop", known: { [r.short]: true, deadbee: false } });
    await provider.onMessage({ type: "gitCommitOpen", hash: r.short }); await settle(() => opened.length > 0);
    assert.equal(opened.length, 1); assert.match(opened[0][2], /Totals count twice/); assert.match(String(opened[0][0].scheme || opened[0][0]), /dgc-commit/);
    assert.equal(opened[0][1]?.preview, true);
    for (const bad of ["deadbee", "--help", r.tree.slice(0, 10), "", null, r.short + " --output=x"]) await provider.onMessage({ type: "gitCommitOpen", hash: bad });
    await new Promise((res) => setTimeout(res, 150));
    assert.equal(opened.length, 1, "only a commit that is there opens");
  } finally { V.workspace.openTextDocument = was.open; V.window.showTextDocument = was.show; V.workspace.registerTextDocumentContentProvider = was.reg; if (was.parse) V.Uri.parse = was.parse; }
});

// ---- a Pip's chat (src/pipsView.ts) ------------------------------------------------------------------------------------
test("a Pip's host: the Pip's folder is read from DGC (never from the page); a Personal Pip, or a folder DGC doesn't list, links nothing", async () => {
  const r = repo(), PIP = "pip_" + "b".repeat(32), WS = "ws_" + "4".repeat(32);
  const vs = { window: { showInformationMessage() {}, showTextDocument: async () => {} }, workspace: { registerTextDocumentContentProvider: () => ({ dispose() {} }), openTextDocument: async (u) => ({ uri: u }) }, Uri: { parse: (t) => ({ toString: () => t }) }, commands: { executeCommand: async () => {} }, env: {} };
  const m = load(await bundle("pipsView.ts"), vs);
  const open = (pip, folders) => { const posted = [], sent = [], editor = new m.PipsEditor({}, (c) => { sent.push(c); return true; }, () => {});
    editor.attach((x) => posted.push(x)); editor.ready({ pips_supported: true, pips_enabled: true, pips_api_version: 103 }, {});
    const pump = async () => { for (let i = 0; i < 300; i++) { const c = sent.shift(); if (c?.request?.type === "get_pip") editor.event({ type: "pips_result", request_id: c.request.request_id, command: "get_pip", ok: true, result: { pip } });
      else if (c?.request?.type === "list_project_folders") editor.event({ type: "pips_result", request_id: c.request.request_id, command: "list_project_folders", ok: true, result: { folders } });
      if (posted.some((x) => x.type === "pipsGitRefs")) return; await new Promise((res) => setTimeout(res, 5)); } };
    return { editor, posted, sent, pump }; };
  const folderPip = { id: PIP, workspace_id: WS, source_policy: { mode: "committed_only" } };
  const h = open(folderPip, [{ folder: r.at, workspace_id: WS, exists: true }]);
  h.editor.receive({ type: "pipsGitRefs", pip_id: PIP, hashes: [r.short, "deadbee"], folder: "/etc" }); await h.pump();
  assert.deepEqual({ ...h.posted.filter((x) => x.type === "pipsGitRefs").at(-1) }, { type: "pipsGitRefs", pip_id: PIP, remote: true, github: "acme/shop", known: { [r.short]: true, deadbee: false } });
  for (const [name, pip, folders] of [["a Personal Pip", { id: PIP, workspace_id: WS, source_policy: { mode: "personal" } }, [{ folder: r.at, workspace_id: WS, exists: true }]], ["a folder DGC doesn't list", folderPip, [{ folder: r.at, workspace_id: "ws_" + "9".repeat(32), exists: true }]]]) {
    const x = open(pip, folders); x.editor.receive({ type: "pipsGitRefs", pip_id: PIP, hashes: [r.short] }); await x.pump();
    assert.deepEqual({ ...x.posted.filter((y) => y.type === "pipsGitRefs").at(-1) }, { type: "pipsGitRefs", pip_id: PIP, remote: false, github: "", known: {} }, name);
  }
  const bad = open(folderPip, []); bad.editor.receive({ type: "pipsGitRefs", pip_id: "../etc", hashes: [r.short] }); await new Promise((res) => setTimeout(res, 60));
  assert.equal(bad.sent.length, 0, "a Pip id that isn't one asks DGC nothing");
});
