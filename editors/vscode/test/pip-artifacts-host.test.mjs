// A Pip's reports and dashboards, the extension host's half (src/pipsView.ts, Pips API 67): get_pip_artifacts and
// set_pip_artifacts go through the Pips control channel only to a runtime that has them; the person's dashboards come
// from the editor's own artifacts list (artifact_list for dashboards), never a Pip control; and Open opens only an
// artifact by its id in the artifact panel.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const scratch = mkdtempSync(join(tmpdir(), "dgc-pip-artifacts-host-"));
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

const PIP = "pip_" + "a".repeat(32);
const DASH = "ar_" + "b".repeat(16);
function editor(apiVersion, hub) {
  const sent = [], posted = [];
  const e = new PipsEditor({ fsPath: "/ext" }, (m) => { sent.push(m); return true; }, () => {});
  e.attach((m) => posted.push(m));
  if (hub !== null) e.useArtifacts(() => hub);
  e.ready({ pips_supported: true, pips_enabled: true, pips_api_version: apiVersion });
  const ask = (request, id = "c1") => e.receive({ type: "pipsRequest", id, request });
  const reply = (id) => posted.find((m) => m.type === "pipsReply" && m.id === id);
  return { e, sent, posted, ask, reply };
}
const hub = () => {
  const calls = { list: [], open: [] };
  return { calls, offered: true, offers() { return this.offered ? { version: 1 } : undefined; },
    list(type) { calls.list.push(type); return Promise.resolve([{ id: DASH, type: "dashboard", title: "Store sales", version: 4, label: "Dashboard", exports: ["html"], file: "/x" },
                                                                { id: "ar_" + "c".repeat(16), type: "doc", title: "Not a dashboard", version: 1 }]); },
    open(id, hint) { calls.open.push([id, hint]); } };
};
const tick = () => new Promise((r) => setTimeout(r, 0));

test("get and set go through the Pips control channel to a runtime that has them, and only to one", () => {
  const x = editor(67, hub());
  x.ask({ type: "get_pip_artifacts", pip_id: PIP });
  x.ask({ type: "set_pip_artifacts", pip_id: PIP, report_as: "doc", dashboards: [DASH] }, "c2");
  assert.deepEqual(x.sent.map((m) => [m.type, m.request.type]), [["pips_control", "get_pip_artifacts"], ["pips_control", "set_pip_artifacts"]]);
  assert.deepEqual({ ...x.sent[1].request, request_id: "" }, { type: "set_pip_artifacts", pip_id: PIP, report_as: "doc", dashboards: [DASH], request_id: "" });
  const old = editor(66, hub());
  old.ask({ type: "get_pip_artifacts", pip_id: PIP });
  assert.deepEqual(old.sent, [], "an older runtime is never asked");
  assert.match(old.reply("c1").error.message, /Update DGC/);
});

test("the person's dashboards come from the editor's artifacts list, dashboards only, and only what the page shows", async () => {
  const h = hub();
  const x = editor(67, h);
  x.ask({ type: "list_artifact_dashboards" });
  await tick();
  assert.deepEqual(x.sent, [], "no Pip control: the editor answers");
  assert.deepEqual(h.calls.list, ["dashboard"]);
  assert.deepEqual(x.reply("c1"), { type: "pipsReply", id: "c1", ok: true, result: { dashboards: [{ id: DASH, title: "Store sales", version: 4 }] } });
  h.offered = false;
  x.ask({ type: "list_artifact_dashboards" }, "c2");
  assert.match(x.reply("c2").error.message, /keeps no dashboards yet/);
  const old = editor(66, hub());
  old.ask({ type: "list_artifact_dashboards" });
  assert.match(old.reply("c1").error.message, /Update DGC/);
});

test("Open opens an artifact by its id, of a kind a Pip's settings show, and nothing else", () => {
  const h = hub();
  const x = editor(67, h);
  x.e.receive({ type: "pipsOpenArtifact", id: DASH, artifactType: "dashboard" });
  x.e.receive({ type: "pipsOpenArtifact", id: "ar_" + "d".repeat(16), artifactType: "doc" });
  x.e.receive({ type: "pipsOpenArtifact", id: "../../etc/passwd", artifactType: "doc" });
  x.e.receive({ type: "pipsOpenArtifact", id: DASH, artifactType: "page" });
  assert.deepEqual(h.calls.open, [[DASH, { type: "dashboard" }], ["ar_" + "d".repeat(16), { type: "doc" }]]);
  const old = editor(66, h);
  old.e.receive({ type: "pipsOpenArtifact", id: DASH, artifactType: "dashboard" });
  assert.equal(h.calls.open.length, 2, "an older runtime's page has nothing to open");
});
