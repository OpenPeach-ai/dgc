// A Pip's model picker, the host's side (src/pipsView.ts, 24 Nov): once the Pips list their models (list_pip_models),
// what each provider says those models can do (src/modelcaps.ts, through the panel's useModelCaps) goes to the page
// that asked, one pipModelCaps message per connection, by the page's own name for it ("connection", "provider:<id>").
// The list's answer itself is as it was: DGC's Pips answer gets no new field.
import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url), src = fileURLToPath(new URL("../src/", import.meta.url));
const code = (await build({ entryPoints: [src + "pipsView.ts"], bundle: true, write: false, platform: "node", format: "cjs", external: ["vscode"], logLevel: "silent" })).outputFiles[0].text;
const vs = { window: { showInformationMessage() {}, showTextDocument: async () => {} }, workspace: { workspaceFolders: [{ uri: { fsPath: "/w" } }], registerTextDocumentContentProvider: () => ({ dispose() {} }) }, Uri: { parse: (t) => ({ toString: () => t }) }, commands: { executeCommand: async () => {} }, env: {} };
const out = { exports: {} }; new Function("module", "exports", "require", code)(out, out.exports, (name) => (name === "vscode" ? vs : require(name)));
const m = out.exports;
const PROV = "provider_" + "b".repeat(32);
const settle = async (predicate) => { for (let i = 0; i < 200 && !predicate(); i++) await new Promise((r) => setTimeout(r, 5)); };
const SAID = [{ id: "connection", caps: { "qwen3.8:27b": { thinks: true, images: true, tools: true } } }, { id: `provider:${PROV}`, caps: { "codellama:13b": { thinks: false, images: false, tools: false } } }];

function editor(hook = true) {
  const posted = [], sent = [];
  const e = new m.PipsEditor({}, (c) => { sent.push(c); return true; }, () => {});
  e.attach((x) => posted.push(x));
  e.ready({ pips_supported: true, pips_enabled: true, pips_api_version: 104 }, {});
  e.useSavedProviders(async () => [{ id: PROV, name: "Spare", default: false, models: ["codellama:13b"], mark: "", badge: "" }], async () => {}, () => false, () => undefined);
  let asked = 0;
  if (hook) e.useModelCaps(async () => { asked++; return SAID; });
  return { e, posted, sent, asked: () => asked };
}

test("list_pip_models: each connection's marks follow the list, one message each, and the list's answer is as it was", async () => {
  const x = editor();
  x.e.receive({ type: "pipsRequest", id: "list", request: { type: "list_pip_models" } });
  const listed = x.sent.at(-1);
  assert.equal(listed.request.type, "list_pip_models");
  x.e.event({ type: "pips_result", ok: true, command: "list_pip_models", request_id: listed.request.request_id, result: { default_model: "m", models: [{ id: "qwen3.8:27b", name: "qwen3.8:27b" }] } });
  await settle(() => x.posted.filter((p) => p.type === "pipModelCaps").length >= 2);
  const reply = x.posted.find((p) => p.type === "pipsReply" && p.id === "list");
  assert.ok(reply && reply.ok, "the list's answer");
  assert.equal(Object.hasOwn(reply.result, "caps"), false, "with no new field");
  assert.deepEqual(x.posted.filter((p) => p.type === "pipModelCaps").map(({ type, id, caps }) => ({ type, id, caps })),
    SAID.map(({ id, caps }) => ({ type: "pipModelCaps", id, caps })));
  assert.equal(x.asked(), 1);
  assert.ok(x.posted.indexOf(reply) < x.posted.findIndex((p) => p.type === "pipModelCaps"), "after the list: its rows are there to mark");
});

test("without the panel's hook, or when the list failed, nothing more is said", async () => {
  const x = editor(false);
  x.e.receive({ type: "pipsRequest", id: "list", request: { type: "list_pip_models" } });
  x.e.event({ type: "pips_result", ok: true, command: "list_pip_models", request_id: x.sent.at(-1).request.request_id, result: { default_model: "m", models: [] } });
  await settle(() => x.posted.some((p) => p.type === "pipsReply"));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(x.posted.filter((p) => p.type === "pipModelCaps").length, 0);
  const y = editor();
  y.e.receive({ type: "pipsRequest", id: "list", request: { type: "list_pip_models" } });
  y.e.event({ type: "pips_result", ok: false, command: "list_pip_models", request_id: y.sent.at(-1).request.request_id, error: { code: "x", message: "no" } });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(y.asked(), 0);
  assert.equal(y.posted.filter((p) => p.type === "pipModelCaps").length, 0);
});
