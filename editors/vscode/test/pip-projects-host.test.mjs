// @ a project in a Personal Pip's chat, the extension host's half (src/pipsView.ts, Pips API 91): the six project
// commands go through the Pips control channel only to a DGC that has them; a project mark stays in a message's display
// mentions only for such a DGC; and Continue in Work is answered by the editor itself: it reads the change and its patch
// from DGC, and opens Work only for the project this window has open, with a first message that says what changed.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const scratch = mkdtempSync(join(tmpdir(), "dgc-pip-projects-host-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const outfile = join(scratch, "pipsView.cjs");
await build({ entryPoints: [fileURLToPath(new URL("../src/pipsView.ts", import.meta.url))], bundle: true, outfile, platform: "node", format: "cjs",
  external: ["vscode"], loader: { ".css": "empty" }, logLevel: "silent" });
const require = createRequire(import.meta.url);
const Module = require("node:module");
const load = Module._load;
Module._load = function (request, ...rest) { return request === "vscode" ? {} : load.call(this, request, ...rest); };
const { PipsEditor } = require(outfile);
Module._load = load;

const PIP = "pip_" + "a".repeat(32), CHANGE = "pchange_" + "d".repeat(32), SHOP = "ws_" + "5".repeat(32), OTHER = "ws_" + "6".repeat(32);
const change = { id: CHANGE, workspace_id: SHOP, name: "shop", status: "pending", files: [{ path: "app.py", change: "modified", plus: 1, minus: 1 },
  { path: "tests/test_app.py", change: "added", plus: 4, minus: 0 }, { path: "vendor/tools", change: "link", plus: 0, minus: 0 }], more: 0, digest: "digest-one", result: null,
  created_at: "2026-11-12T08:00:00.000Z", updated_at: "2026-11-12T08:00:00.000Z" };
const PATCH = "--- a/app.py\n+++ b/app.py\n@@ -1,2 +1,2 @@\n def total(items):\n-    return sum(items)\n+    return round(sum(items), 2)\n";
function editor(apiVersion, { work = true, marks = true } = {}) {
  const sent = [], posted = [], opened = [];
  const e = new PipsEditor({ fsPath: "/ext" }, (m) => { sent.push(m); return true; }, () => {});
  e.attach((m) => posted.push(m));
  const state = { answer: true };
  if (work && typeof e.useProjectWork === "function") e.useProjectWork(async (w) => { opened.push(w); return state.answer; });
  e.ready({ pips_supported: true, pips_enabled: true, pips_api_version: apiVersion, ...(marks ? { pip_display_mentions: 1 } : {}) });
  const ask = (request, id = "c1") => e.receive({ type: "pipsRequest", id, request });
  const reply = (id = "c1") => posted.find((m) => m.type === "pipsReply" && m.id === id);
  /** DGC answers the host's own read of `command`. */
  const answer = (command, result, ok = true) => { const m = sent.find((s) => s.type === "pips_control" && s.request.type === command && !s.done); assert.ok(m, `the host asked DGC for ${command}`); m.done = true;
    e.event({ type: "pips_result", request_id: m.request.request_id, command, ok, ...(ok ? { result } : { error: result }) }); };
  return { e, sent, posted, opened, state, ask, reply, answer };
}
const tick = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };
const asked = (x) => x.sent.map((m) => m.request?.type);

test("the six project commands go through the Pips control channel to a DGC that has them, and only to one", () => {
  const calls = [{ type: "list_pip_project_choices", pip_id: PIP }, { type: "list_pip_project_changes", pip_id: PIP },
    { type: "get_pip_project_change", pip_id: PIP, change_id: CHANGE, path: "app.py" },
    { type: "apply_pip_project_change", pip_id: PIP, change_id: CHANGE, expected_digest: "digest-one" },
    { type: "discard_pip_project_change", pip_id: PIP, change_id: CHANGE }, { type: "undo_pip_project_change", pip_id: PIP, change_id: CHANGE }];
  const x = editor(91);
  calls.forEach((request, i) => x.ask({ ...request }, "c" + i));
  assert.deepEqual(x.sent.map((m) => [m.type, { ...m.request, request_id: "" }]), calls.map((request) => ["pips_control", { ...request, request_id: "" }]), "each as the page asked it, nothing added");
  const old = editor(90);
  calls.forEach((request, i) => old.ask({ ...request }, "c" + i));
  assert.deepEqual(old.sent, [], "an older DGC is never asked");
  calls.forEach((_, i) => assert.match(old.reply("c" + i)?.error?.message || "", /^Update DGC to give a Pip a copy of a project\.$/));
});

test("a project mark stays in a message's display mentions for a DGC that copies projects, and is plain words to an older one", () => {
  const message = () => ({ type: "send_pip_message", pip_id: PIP, text: "Fix the totals in shop", idempotency_key: "k1",
    display_mentions: [{ start: 18, kind: "project", label: "shop", identity: SHOP, wired: true }] });
  const x = editor(91);
  x.ask(message());
  assert.deepEqual(x.sent.at(-1)?.request.display_mentions, [{ start: 18, kind: "project", label: "shop", identity: SHOP, wired: true }]);
  const old = editor(90);
  old.ask(message());
  assert.equal(old.sent.length, 1, "(the message itself still goes)");
  assert.equal(Object.hasOwn(old.sent[0].request, "display_mentions"), false, "an older DGC gets the words alone: no copy is asked of it");
});

test("Continue in Work: the editor reads the change and its patch from DGC and opens Work with a first message that says what changed", async () => {
  const x = editor(91);
  x.ask({ type: "open_pip_project_change_in_work", pip_id: PIP, change_id: CHANGE });
  await tick();
  assert.equal(asked(x).includes("open_pip_project_change_in_work"), false, "never a Pip control: the editor answers");
  x.answer("list_workspaces", { workspaces: [{ id: SHOP, name: "shop", kind: "project" }], current_workspace_id: SHOP }); await tick();
  const read = x.sent.find((m) => m.request?.type === "get_pip_project_change");
  assert.deepEqual({ ...read?.request, request_id: "" }, { type: "get_pip_project_change", pip_id: PIP, change_id: CHANGE, request_id: "" }, "the whole patch: no path");
  x.answer("get_pip_project_change", { ...change, patch: PATCH, patch_cut: false }); await tick();
  x.answer("get_pip", { pip: { id: PIP, name: "Ava" } }); await tick();
  assert.equal(x.opened.length, 1, "Work is opened once");
  const [work] = x.opened;
  assert.equal(work.name, "shop");
  assert.equal(work.change_id, CHANGE);
  assert.equal(work.file, "shop-changes.patch");
  assert.equal(work.patch, PATCH, "the patch as DGC gave it");
  assert.match(work.brief, /^Ava worked on a private copy of this project and changed 3 files\. Nothing has been applied here yet\./);
  assert.match(work.brief, /- app\.py \(changed, \+1 −1\)/);
  assert.match(work.brief, /- tests\/test_app\.py \(new, \+4 −0\)/);
  assert.match(work.brief, /- vendor\/tools \(a link it made: not in the patch\)/);
  assert.match(work.brief, /attached patch \(shop-changes\.patch\)/);
  assert.doesNotMatch(work.brief, /\bAI\b/);
  assert.deepEqual(x.reply(), { type: "pipsReply", id: "c1", ok: true, result: { opened: true } });
  assert.deepEqual(asked(x).filter((t) => /^(apply|discard|undo)_/.test(t)), [], "opening Work decides nothing about the change");
});

test("Continue in Work opens only the project this window has open; any other is said in words, and nothing opens", async () => {
  const x = editor(91);
  x.ask({ type: "open_pip_project_change_in_work", pip_id: PIP, change_id: CHANGE });
  await tick();
  x.answer("list_workspaces", { workspaces: [], current_workspace_id: OTHER }); await tick();
  x.answer("get_pip_project_change", { ...change, patch: PATCH, patch_cut: false }); await tick();
  if (x.sent.some((m) => m.request?.type === "get_pip" && !m.done)) { x.answer("get_pip", { pip: { id: PIP, name: "Ava" } }); await tick(); }
  assert.deepEqual(x.opened, [], "no Work chat in a folder that isn't the project's");
  assert.equal(x.reply()?.ok, false);
  assert.equal(x.reply().error.message, "Work opens in the folder this window has open. Open shop in VS Code, then choose Continue in Work there.");
});

test("Continue in Work says why when it can't: a change that is gone, a window that didn't open, an older DGC, a malformed request", async () => {
  const gone = editor(91);
  gone.ask({ type: "open_pip_project_change_in_work", pip_id: PIP, change_id: CHANGE }); await tick();
  gone.answer("list_workspaces", { workspaces: [], current_workspace_id: SHOP }); await tick();
  gone.answer("get_pip_project_change", { code: "not_found", message: "This change is no longer there. Refresh." }, false); await tick();
  assert.equal(gone.reply()?.error?.message, "This change is no longer there. Refresh.", "DGC's own words");
  assert.deepEqual(gone.opened, []);

  const shut = editor(91); shut.state.answer = false;
  shut.ask({ type: "open_pip_project_change_in_work", pip_id: PIP, change_id: CHANGE }); await tick();
  shut.answer("list_workspaces", { workspaces: [], current_workspace_id: SHOP }); await tick();
  shut.answer("get_pip_project_change", { ...change, patch: PATCH, patch_cut: false }); await tick();
  shut.answer("get_pip", { pip: { id: PIP, name: "Ava" } }); await tick();
  assert.equal(shut.opened.length, 1);
  assert.equal(shut.reply()?.error?.message, "Work didn’t open. Choose Continue in Work again when you’re ready.");

  const old = editor(90);
  old.ask({ type: "open_pip_project_change_in_work", pip_id: PIP, change_id: CHANGE }); await tick();
  assert.deepEqual(old.sent, [], "an older DGC is never asked");
  assert.match(old.reply()?.error?.message || "", /^Update DGC to give a Pip a copy of a project\.$/);

  const bad = editor(91);
  bad.ask({ type: "open_pip_project_change_in_work", pip_id: PIP, change_id: "../../etc", folder: "/somewhere" }); await tick();
  assert.deepEqual(bad.sent, [], "a request naming anything but its two ids reads nothing");
  assert.equal(bad.reply()?.ok, false);
  assert.deepEqual(bad.opened, []);
});
