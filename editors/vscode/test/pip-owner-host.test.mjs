// A Project Pip's owner session, the extension host's half (src/pipsView.ts, Pips API 89): the page's two commands go
// through the Pips control channel only to a DGC that has them; the Work list's titles are the editor's own answer,
// never a Pip control; and what deleting or archiving a Work session asks first: the Project Pips it owns
// (list_session_pips), then each moved to another session (set_pip_owner), or each deleted as the Pips view deletes
// one (archive_pip, then delete_archived_pip with its name).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const scratch = mkdtempSync(join(tmpdir(), "dgc-pip-owner-host-"));
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

const hex = (c) => c.repeat(32);
const A = "pip_" + hex("a"), B = "pip_" + hex("b"), SESSION = "20261106-101500-a1", OTHER = "20261106-091200-b2";
const OWNED = [{ id: A, name: "Billing audit", pip_type: "rook", status: "active" }, { id: B, name: "Docs writer", pip_type: "quill", status: "paused" }];
function editor(apiVersion, { titles } = {}) {
  const sent = [], posted = [];
  const e = new PipsEditor({ fsPath: "/ext" }, (m) => { sent.push(m); return true; }, () => {});
  e.attach((m) => posted.push(m));
  if (titles && typeof e.useWorkSessions === "function") e.useWorkSessions(async () => titles);
  e.ready({ pips_supported: true, pips_enabled: true, pips_api_version: apiVersion });
  const ask = (request, id = "c1") => e.receive({ type: "pipsRequest", id, request });
  const reply = (id = "c1") => posted.find((m) => m.type === "pipsReply" && m.id === id);
  /** DGC answers the host's own `command`. */
  const answer = (command, result, ok = true) => { const m = sent.find((s) => s.type === "pips_control" && s.request.type === command && !s.done); assert.ok(m, `the host asked DGC for ${command}`); m.done = true;
    e.event({ type: "pips_result", request_id: m.request.request_id, command, ok, ...(ok ? { result } : { error: result }) }); return m.request; };
  return { e, sent, posted, ask, reply, answer };
}
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };
const asked = (x) => x.sent.map((m) => m.request?.type);
const has = (x, name) => { assert.equal(typeof x.e[name], "function", `the host has ${name}`); return x.e[name].bind(x.e); };

test("the owner commands go through the Pips control channel to a DGC that has them, and only to one", () => {
  const calls = [{ type: "get_pip_owner", pip_id: A }, { type: "set_pip_owner", pip_id: A, session_id: SESSION }, { type: "set_pip_owner", pip_id: A, session_id: null },
    { type: "list_session_pips", session_id: SESSION }];
  const x = editor(89);
  calls.forEach((request, i) => x.ask({ ...request }, "c" + i));
  assert.deepEqual(x.sent.map((m) => [m.type, { ...m.request, request_id: "" }]), calls.map((request) => ["pips_control", { ...request, request_id: "" }]), "each as the page asked it, nothing added");
  const old = editor(88);
  calls.forEach((request, i) => old.ask({ ...request }, "c" + i));
  assert.deepEqual(old.sent, [], "an older DGC is never asked");
  calls.forEach((_, i) => assert.match(old.reply("c" + i)?.error?.message || "", /^Update DGC to choose a Project Pip’s owner session\.$/));
});

test("the Work list's titles are the editor's own answer, never a Pip control", async () => {
  const titles = [{ id: SESSION, title: "Run the shell command" }, { id: OTHER, title: "Visits page alignment" }, { id: "not an id", title: "x" }, { id: "s3", title: "y".repeat(400) }];
  const x = editor(89, { titles });
  x.ask({ type: "list_work_session_titles" });
  await tick();
  assert.deepEqual(x.sent, [], "DGC is not asked");
  assert.deepEqual(x.reply()?.result, { sessions: [{ id: SESSION, title: "Run the shell command" }, { id: OTHER, title: "Visits page alignment" }, { id: "s3", title: "y".repeat(200) }] },
    "the titles as the editor shows them: only real session ids, a title cut at 200");
  // A session with nothing in it is said to be empty, and the backend's "(empty)" preview is never a title (12 Nov).
  const empties = editor(89, { titles: [{ id: SESSION, title: "", empty: true }, { id: OTHER, title: "(empty)", empty: true }] });
  empties.ask({ type: "list_work_session_titles" });
  await tick();
  assert.deepEqual(empties.reply()?.result, { sessions: [{ id: SESSION, title: "", empty: true }, { id: OTHER, title: "", empty: true }] });
  const none = editor(89);
  none.ask({ type: "list_work_session_titles" });
  await tick();
  assert.deepEqual(none.reply()?.result, { sessions: [] }, "a view with no Work list still answers: sessions then say when they are from");
  const old = editor(88, { titles });
  old.ask({ type: "list_work_session_titles" });
  await tick();
  assert.match(old.reply()?.error?.message || "", /^Update DGC to choose a Project Pip’s owner session\.$/);
});

test("before a session is deleted or archived: the Project Pips it owns", async () => {
  const x = editor(89);
  const found = has(x, "sessionPips")(SESSION);
  assert.deepEqual(asked(x), ["list_session_pips"]);
  assert.equal(x.sent[0].request.session_id, SESSION);
  x.answer("list_session_pips", { session_id: SESSION, pips: [...OWNED, { id: "nope", name: "x", pip_type: "rook", status: "active" }] });
  assert.deepEqual(await found, OWNED, "its Pips, each checked");
  const old = editor(88);
  assert.deepEqual(await has(old, "sessionPips")(SESSION), [], "a DGC without owner sessions: none, and nothing asked");
  assert.deepEqual(old.sent, []);
  const refused = editor(89);
  const failed = has(refused, "sessionPips")(SESSION);
  refused.answer("list_session_pips", { code: "local_only", message: "Only you choose a Pip's owner session, on this computer." }, false);
  await assert.rejects(failed, /Only you choose a Pip's owner session, on this computer\./, "DGC's own words when it refuses");
});

test("Move them to another session: one set_pip_owner each, and a refusal names the Pip", async () => {
  const x = editor(89);
  const moved = has(x, "moveSessionPips")(OWNED, OTHER);
  await tick();
  assert.deepEqual(x.answer("set_pip_owner", { pip_id: A, session_id: OTHER }), { type: "set_pip_owner", pip_id: A, session_id: OTHER, request_id: x.sent[0].request.request_id });
  await tick();
  assert.equal(x.answer("set_pip_owner", { pip_id: B, session_id: OTHER }).pip_id, B);
  await moved;
  assert.deepEqual(asked(x), ["set_pip_owner", "set_pip_owner"], "one each, one at a time");
  const bad = editor(89);
  const failing = has(bad, "moveSessionPips")(OWNED, OTHER);
  await tick();
  bad.answer("set_pip_owner", { code: "invalid_request", message: "Choose one of this project's sessions: that session isn't one." }, false);
  await assert.rejects(failing, /^Error: Billing audit: Choose one of this project's sessions: that session isn't one\.$/);
  assert.deepEqual(asked(bad), ["set_pip_owner"], "it stops at the first that fails");
});

test("Delete them too: each archived, then deleted with its own name, as the Pips view does", async () => {
  const x = editor(89);
  const deleted = has(x, "deleteSessionPips")(OWNED.slice(0, 1));
  await tick();
  x.answer("get_pip", { pip: { id: A, name: "Billing audit", status: "active", current_version: 3, lifecycle_revision: 1 } });
  await tick();
  const archive = x.answer("archive_pip", { pip: { id: A, name: "Billing audit", status: "archived", current_version: 3, lifecycle_revision: 2 }, receipt: { operation: "archive" }, replayed: false });
  assert.deepEqual({ ...archive, request_id: "", request_key: "" }, { type: "archive_pip", pip_id: A, expected_version: 3, expected_lifecycle_revision: 1, request_key: "", reason: "Deleted with its owner session.", request_id: "" });
  assert.match(archive.request_key, /^[A-Za-z0-9_-]{16,128}$/);
  await tick();
  const purge = x.answer("delete_archived_pip", { deleted: true, pip_id: A });
  assert.deepEqual({ ...purge, request_id: "" }, { type: "delete_archived_pip", pip_id: A, expected_name: "Billing audit", expected_version: 3, expected_lifecycle_revision: 2, request_id: "" });
  await deleted;
  assert.deepEqual(asked(x), ["get_pip", "archive_pip", "delete_archived_pip"]);

  // One archived already (by another window) is deleted without archiving it again.
  const y = editor(89);
  const again = has(y, "deleteSessionPips")(OWNED.slice(0, 1));
  await tick();
  y.answer("get_pip", { pip: { id: A, name: "Billing audit", status: "archived", current_version: 3, lifecycle_revision: 2 } });
  await tick();
  y.answer("delete_archived_pip", { deleted: true, pip_id: A });
  await again;
  assert.deepEqual(asked(y), ["get_pip", "delete_archived_pip"]);

  // A Pip with work still running can't be archived: DGC's words, with its name, and nothing after it is touched.
  const z = editor(89);
  const failing = has(z, "deleteSessionPips")(OWNED);
  await tick();
  z.answer("get_pip", { pip: { id: A, name: "Billing audit", status: "active", current_version: 1, lifecycle_revision: 0 } });
  await tick();
  z.answer("archive_pip", { code: "busy", message: "A run is still going. Stop it or let it finish first." }, false);
  await assert.rejects(failing, /^Error: Billing audit: A run is still going\. Stop it or let it finish first\.$/);
  assert.deepEqual(asked(z), ["get_pip", "archive_pip"]);
});
