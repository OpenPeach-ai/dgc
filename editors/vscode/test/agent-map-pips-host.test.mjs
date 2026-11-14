// The agent map's Pips section, the extension host's half (src/panel.ts and src/pipsView.ts; Pips API 96,
// pips-flow-design Q2). The page asks with no session id of its own: the host reads the Pips related to the session
// this panel shows (list_related_pips), counts the Pips that are not related ("elsewhere": list_pips scope all, the
// archived ones left out), and answers with what the editor remembers of Hide / Show. Stop is the existing
// cancel_pip_run for one run. A DGC before API 96, or with Pips off, is never asked. Relation never routes anything:
// nothing here sets, moves or decides for a Pip.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { cleanup, makeProvider } from "./support/panel-bundle.mjs";

const scratch = mkdtempSync(join(tmpdir(), "dgc-agent-map-pips-host-"));
after(() => { rmSync(scratch, { recursive: true, force: true }); cleanup(); });
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
const TAX = "pip_" + hex("a"), BILLING = "pip_" + hex("b"), DOCS = "pip_" + hex("d"), FAR = "pip_" + hex("e"), OLD = "pip_" + hex("f");
const RUN = "run_" + hex("1"), SESSION = "20261114-090000-a1";
const RELATED = [
  { id: TAX, name: "Tax watchdog", pip_type: "rook", workspace_id: "w1", why: ["asked", "folder"], running: true, needs_you: 0 },
  { id: BILLING, name: "Billing audit", pip_type: "lens", workspace_id: "w1", why: ["folder"], running: false, needs_you: 2 },
];
const tick = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };

// ---- the bridge (src/pipsView.ts), against what DGC answers ----
function editor(apiVersion, capabilities = {}) {
  const sent = [];
  const e = new PipsEditor({ fsPath: "/ext" }, (m) => { sent.push(m); return true; }, () => {});
  e.attach(() => {});
  e.ready({ pips_supported: true, pips_enabled: true, pips_api_version: apiVersion, ...capabilities });
  const answer = (command, result, ok = true) => { const m = sent.find((s) => s.type === "pips_control" && s.request.type === command && !s.done); assert.ok(m, `the host asked DGC for ${command}`); m.done = true;
    e.event({ type: "pips_result", request_id: m.request.request_id, command, ok, ...(ok ? { result } : { error: result }) }); return m.request; };
  return { e, sent, answer, asked: () => sent.map((m) => m.request?.type) };
}

test("the Pips related to a session, and how many Pips are elsewhere: archived ones and the related ones are not counted", async () => {
  const x = editor(96);
  assert.equal(typeof x.e.relatedPips, "function", "the host has relatedPips");
  const got = x.e.relatedPips(SESSION);
  await tick();
  const asked = x.answer("list_related_pips", { session_id: SESSION, pips: [...RELATED, { id: "nope", name: "x" }, { ...RELATED[1], id: DOCS, name: "", why: ["folder", "owner"], needs_you: 2.5, running: "yes" }] });
  assert.deepEqual({ type: asked.type, session_id: asked.session_id }, { type: "list_related_pips", session_id: SESSION });
  await tick();
  const listed = x.answer("list_pips", { pips: [{ id: TAX, status: "active" }, { id: FAR, status: "active" }, { id: OLD, status: "archived" }, { id: "pip_" + hex("9"), status: "paused" }, { id: DOCS, status: "active" }],
    total: 5, next_offset: null });
  assert.deepEqual({ scope: listed.scope, limit: listed.limit, offset: listed.offset }, { scope: "all", limit: 100, offset: 0 });
  assert.deepEqual(await got, { pips: [
    { id: TAX, name: "Tax watchdog", pip_type: "rook", why: ["asked", "folder"], running: true, needs_you: 0 },
    { id: BILLING, name: "Billing audit", pip_type: "lens", why: ["folder"], running: false, needs_you: 2 },
    { id: DOCS, name: "Pip", pip_type: "lens", why: ["folder"], running: false, needs_you: 0 },
  ], elsewhere: 2 }, "what the page is told: no workspace ids, only the three reasons, whole counts");
  assert.deepEqual(x.asked(), ["list_related_pips", "list_pips"], "two reads, nothing else");
});

test("a long list of Pips is read a page at a time, and the count of Pips elsewhere is none when it can't be read", async () => {
  const x = editor(96);
  const got = x.e.relatedPips(SESSION);
  await tick();
  x.answer("list_related_pips", { session_id: SESSION, pips: RELATED });
  await tick();
  x.answer("list_pips", { pips: Array.from({ length: 100 }, (_, i) => ({ id: "pip_" + String(i).padStart(32, "0"), status: "active" })), total: 130, next_offset: 100 });
  await tick();
  const second = x.answer("list_pips", { pips: Array.from({ length: 30 }, (_, i) => ({ id: "pip_" + String(100 + i).padStart(32, "0"), status: i < 4 ? "archived" : "active" })), total: 130, next_offset: null });
  assert.equal(second.offset, 100);
  assert.equal((await got).elsewhere, 126);
  const y = editor(96);
  const lost = y.e.relatedPips(SESSION);
  await tick();
  y.answer("list_related_pips", { session_id: SESSION, pips: RELATED });
  await tick();
  y.answer("list_pips", { code: "unavailable", message: "Not now." }, false);
  assert.deepEqual((await lost).elsewhere, 0);
  assert.equal((await lost).pips.length, 2, "the related ones are still said");
});

test("an answer about another session is refused, and DGC's own refusal is passed on", async () => {
  const x = editor(96);
  const got = x.e.relatedPips(SESSION);
  await tick();
  x.answer("list_related_pips", { session_id: "another", pips: RELATED });
  await assert.rejects(got, /another session/);
  const y = editor(96);
  const refused = y.e.relatedPips(SESSION);
  await tick();
  y.answer("list_related_pips", { code: "local_only", message: "See a session's Pips on this computer." }, false);
  await assert.rejects(refused, /See a session's Pips on this computer\./);
});

test("a DGC before Pips API 96 is never asked which Pips a session is related to", async () => {
  for (const x of [editor(95), editor(96, { pips_enabled: false })]) {
    assert.equal(await x.e.relatedPips(SESSION), null);
    assert.deepEqual(x.asked(), []);
  }
  const x = editor(96);
  assert.equal(await x.e.relatedPips("not a session id"), null);
  assert.deepEqual(x.asked(), []);
});

test("Stop is cancel_pip_run for that one run", async () => {
  const x = editor(96);
  const done = x.e.stopPipRun(RUN);
  await tick();
  const asked = x.answer("cancel_pip_run", { run: { id: RUN, status: "cancelling" } });
  assert.deepEqual({ type: asked.type, run_id: asked.run_id }, { type: "cancel_pip_run", run_id: RUN });
  await done;
  await assert.rejects(x.e.stopPipRun("run_../x"), /run/i);
  assert.deepEqual(x.asked(), ["cancel_pip_run"], "a run id that is not one is never sent");
  const y = editor(96);
  const refused = y.e.stopPipRun(RUN);
  await tick();
  y.answer("cancel_pip_run", { code: "conflict", message: "That run already ended." }, false);
  await assert.rejects(refused, /That run already ended\./);
});

// ---- the panel (src/panel.ts): the page's three messages ----
function panel(apiVersion = 96, { related = { pips: RELATED.map(({ workspace_id, ...rest }) => rest), elsewhere: 5 }, enabled = true } = {}) {
  const made = makeProvider({ capabilities: { pips_supported: true, pips_enabled: enabled, pips_api_version: apiVersion } });
  const { provider } = made;
  const bridge = [], kept = new Map();
  provider.sessionReady = true;
  provider.currentSessionId = SESSION;
  provider.context.globalState = { get: (key) => kept.get(key), update: async (key, value) => { kept.set(key, value); } };
  provider.ensurePipsBridge = () => ({
    relatedPips: async (id) => { bridge.push(["relatedPips", id]); if (related instanceof Error) throw related; return related; },
    stopPipRun: async (id) => { bridge.push(["stopPipRun", id]); if (id === "run_" + hex("2")) throw new Error("That run already ended."); },
  });
  const said = (type) => made.posted.filter((m) => m.type === type);
  return { ...made, bridge, kept, said };
}

test("the page asks; the host reads this panel's session and answers with what it remembers of Hide / Show", async () => {
  const x = panel();
  await x.provider.onMessage({ type: "agentMapPips", seq: 3 });
  await tick();
  assert.deepEqual(x.bridge, [["relatedPips", SESSION]], "the session is the panel's own, never the page's word");
  assert.deepEqual(x.said("agentMapPips"), [{ type: "agentMapPips", seq: 3, pips: RELATED.map(({ workspace_id, ...rest }) => rest), elsewhere: 5, hidden: false }]);
  await x.provider.onMessage({ type: "agentMapPipsHidden", hidden: true });
  assert.deepEqual([...x.kept], [["dgc.agentMapPipsHidden.v1", true]], "remembered for the editor, not for one chat");
  await x.provider.onMessage({ type: "agentMapPips", seq: 4 });
  await tick();
  assert.equal(x.said("agentMapPips").at(-1).hidden, true);
  await x.provider.onMessage({ type: "agentMapPipsHidden", hidden: "yes" });
  assert.equal(x.kept.get("dgc.agentMapPipsHidden.v1"), true, "only true or false is kept");
  await x.provider.onMessage({ type: "agentMapPipsHidden", hidden: false });
  assert.equal(x.kept.get("dgc.agentMapPipsHidden.v1"), false);
});

test("an older DGC, Pips off, a chat with no session yet or a read that failed: the page is told there is nothing to draw", async () => {
  for (const x of [panel(95), panel(96, { enabled: false })]) {
    await x.provider.onMessage({ type: "agentMapPips", seq: 1 });
    await tick();
    assert.deepEqual(x.bridge, [], "never asked");
    assert.deepEqual(x.said("agentMapPips"), [{ type: "agentMapPips", seq: 1, failed: true, hidden: false }]);
  }
  const none = panel();
  none.provider.currentSessionId = "";
  await none.provider.onMessage({ type: "agentMapPips", seq: 1 });
  await tick();
  assert.deepEqual([none.bridge, none.said("agentMapPips")], [[], [{ type: "agentMapPips", seq: 1, failed: true, hidden: false }]]);
  const failed = panel(96, { related: new Error("DGC didn’t answer in time. Try again.") });
  await failed.provider.onMessage({ type: "agentMapPips", seq: 2 });
  await tick();
  assert.deepEqual(failed.said("agentMapPips"), [{ type: "agentMapPips", seq: 2, failed: true, hidden: false }]);
  const off = panel(96, { related: null });
  await off.provider.onMessage({ type: "agentMapPips", seq: 2 });
  await tick();
  assert.deepEqual(off.said("agentMapPips"), [{ type: "agentMapPips", seq: 2, failed: true, hidden: false }]);
});

test("an answer for a chat the panel has left is not sent to the one it shows now", async () => {
  let release;
  const x = panel();
  x.provider.ensurePipsBridge = () => ({ relatedPips: (id) => new Promise((resolve) => { release = () => resolve({ pips: [], elsewhere: 1 }); }) });
  const asked = x.provider.onMessage({ type: "agentMapPips", seq: 1 });
  await tick();
  x.provider.currentSessionId = "20261114-100000-b2";
  release();
  await asked; await tick();
  assert.deepEqual(x.said("agentMapPips"), []);
});

test("Stop: the run is stopped through the bridge, and the page hears how it went", async () => {
  const x = panel();
  await x.provider.onMessage({ type: "agentMapPipStop", run_id: RUN });
  await tick();
  assert.deepEqual(x.bridge, [["stopPipRun", RUN]]);
  assert.deepEqual(x.said("agentMapPipStopped"), [{ type: "agentMapPipStopped", run_id: RUN, ok: true }]);
  await x.provider.onMessage({ type: "agentMapPipStop", run_id: "run_" + hex("2") });
  await tick();
  assert.deepEqual(x.said("agentMapPipStopped").at(-1), { type: "agentMapPipStopped", run_id: "run_" + hex("2"), ok: false, message: "That run already ended." });
  await x.provider.onMessage({ type: "agentMapPipStop", run_id: "../x" });
  await tick();
  assert.equal(x.bridge.length, 2, "what is not a run id is never passed on");
  const old = panel(95);
  await old.provider.onMessage({ type: "agentMapPipStop", run_id: RUN });
  await tick();
  assert.deepEqual(old.bridge, []);
});
