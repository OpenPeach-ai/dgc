// A Personal Pip's goal, the extension host's half (src/pipsView.ts, Pips API 92): the three goal commands go through
// the Pips control channel only to a DGC that has them.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const scratch = mkdtempSync(join(tmpdir(), "dgc-pip-goal-host-"));
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

const PIP = "pip_" + "a".repeat(32), GOAL = "pipgoal_" + "1".repeat(32), CONV = "conv_" + "2".repeat(32);
function editor(apiVersion) {
  const sent = [], posted = [];
  const e = new PipsEditor({ fsPath: "/ext" }, (m) => { sent.push(m); return true; }, () => {});
  e.attach((m) => posted.push(m));
  e.ready({ pips_supported: true, pips_enabled: true, pips_api_version: apiVersion });
  return { sent, ask: (request, id) => e.receive({ type: "pipsRequest", id, request }), reply: (id) => posted.find((m) => m.type === "pipsReply" && m.id === id) };
}

test("the goal commands go through the Pips control channel to a DGC that has them, and only to one", () => {
  const calls = [{ type: "set_pip_goal", pip_id: PIP, objective: "Plan my week", conversation_id: CONV }, { type: "get_pip_goal", pip_id: PIP, conversation_id: CONV },
    { type: "get_pip_goal", pip_id: PIP }, { type: "stop_pip_goal", pip_id: PIP, goal_id: GOAL }];
  const x = editor(92);
  calls.forEach((request, i) => x.ask({ ...request }, "c" + i));
  assert.deepEqual(x.sent.map((m) => [m.type, { ...m.request, request_id: "" }]), calls.map((request) => ["pips_control", { ...request, request_id: "" }]), "each as the page asked it, nothing added");
  const old = editor(91);
  calls.forEach((request, i) => old.ask({ ...request }, "c" + i));
  assert.deepEqual(old.sent, [], "an older DGC is never asked");
  calls.forEach((_, i) => assert.match(old.reply("c" + i)?.error?.message || "", /^Update DGC to give a Pip a goal\.$/));
});
