// The Pips view's host for a Pip's own sub-agents model (Pips API 104, 17 Nov; src/pipsView.ts): set_pip_agents goes
// to a DGC of 104 with its new fields, well-formed (an older DGC gets only `slots`, as before); a fallback on a saved
// provider is saved for the Pips first, as a Pip's own fallback is; and pip_model_window, the most tokens a model takes,
// is answered by the window's host (model_window_at), never sent to DGC's Pips as a Pips command.
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
const GST = "pip_" + "c".repeat(32), PROV = "provider_" + "b".repeat(32);
const settle = async (predicate) => { for (let i = 0; i < 200 && !predicate(); i++) await new Promise((r) => setTimeout(r, 5)); };

test("set_pip_agents: only slots before Pips API 104; from 104 its model, thinking, window and fallback, each well-formed", () => {
  const no = (request, api) => m.pipAgentsRefusal({ type: "set_pip_agents", pip_id: GST, ...request }, api);
  assert.equal(no({ slots: 4 }, 103), "");
  assert.match(no({ model_choice: { mode: "model", model: "m" } }, 103), /Update DGC/, "an older DGC can't keep a model for them");
  assert.match(no({ slots: 4, thinking: "high" }, 103), /Update DGC/);
  assert.equal(no({ slots: 4 }, 104), "");
  assert.equal(no({ model_choice: { mode: "model", model: "qwen3-coder:480b" } }, 104), "");
  assert.equal(no({ model_choice: { mode: "provider", provider: PROV, model: "claude-opus-5-5" } }, 104), "");
  assert.equal(no({ model_choice: { mode: "default" } }, 104), "");
  assert.equal(no({ thinking: "" }, 104), "");
  assert.equal(no({ thinking: "xhigh" }, 104), "");
  assert.equal(no({ context_size: 0 }, 104), "");
  assert.equal(no({ context_size: 24576 }, 104), "");
  assert.equal(no({ fallback: { provider: "", model: "glm-5.3:cloud" } }, 104), "");
  assert.equal(no({ fallback: { provider: "", model: "" } }, 104), "");
  assert.match(no({}, 104), /\S/, "at least one thing to set");
  assert.match(no({ model_choice: { mode: "subscription", engine: "claude" } }, 104), /It runs its own tools, so it can’t run DGC’s sub-agents/);
  assert.match(no({ model_choice: { mode: "router" } }, 104), /DGC Router/);
  for (const bad of [{ thinking: "ultra" }, { thinking: 3 }, { context_size: 1000 }, { context_size: 2.5 }, { context_size: 99999999 }, { fallback: { provider: "x", model: "m" } },
    { fallback: { engine: "claude", model: "" } }, { model_choice: { mode: "model", model: "" } }, { model_choice: { mode: "provider", provider: "x", model: "m" } }, { slots: 0 }]) assert.match(no(bad, 104), /\S/, JSON.stringify(bad));
});

function editor(api = 104, hook = true) {
  const posted = [], sent = [], saved = [], asked = [];
  const e = new m.PipsEditor({}, (c) => { sent.push(c); return true; }, () => {});
  e.attach((x) => posted.push(x));
  e.ready({ pips_supported: true, pips_enabled: true, pips_api_version: api }, {});
  e.useSavedProviders(async () => [], async (id, model) => { saved.push([id, model]); }, () => false, () => undefined);
  if (hook) e.useModelWindow(async (choice) => { asked.push(choice); return choice.model === "claude-opus-5-5" ? 200000 : 0; });
  const reply = (id) => posted.find((x) => x.type === "pipsReply" && x.id === id);
  return { e, posted, sent, saved, asked, reply };
}

test("pip_model_window: the window's host answers it (model_window_at), only for a model or a saved provider's, only from 104", async () => {
  const x = editor();
  x.e.receive({ type: "pipsRequest", id: "w1", request: { type: "pip_model_window", model_choice: { mode: "provider", provider: PROV, model: "claude-opus-5-5" } } });
  await settle(() => x.reply("w1"));
  assert.deepEqual({ ...x.reply("w1") }, { type: "pipsReply", id: "w1", ok: true, result: { window: 200000 } });
  assert.deepEqual(x.asked, [{ mode: "provider", provider: PROV, model: "claude-opus-5-5" }]);
  assert.equal(x.sent.length, 0, "never a Pips command");
  for (const [id, choice] of [["w2", { mode: "subscription", engine: "claude" }], ["w3", { mode: "model", model: "" }], ["w4", { mode: "provider", provider: "../x", model: "m" }], ["w5", null]]) {
    x.e.receive({ type: "pipsRequest", id, request: { type: "pip_model_window", model_choice: choice } });
    await settle(() => x.reply(id));
    assert.equal(x.reply(id).ok, false, id);
  }
  assert.equal(x.asked.length, 1);
  const old = editor(103);
  old.e.receive({ type: "pipsRequest", id: "o1", request: { type: "pip_model_window", model_choice: { mode: "model", model: "m" } } });
  await settle(() => old.reply("o1"));
  assert.match(old.reply("o1").error.message, /Update DGC/);
  const none = editor(104, false);
  none.e.receive({ type: "pipsRequest", id: "n1", request: { type: "pip_model_window", model_choice: { mode: "model", model: "m" } } });
  await settle(() => none.reply("n1"));
  assert.equal(none.reply("n1").ok, false);
});

test("set_pip_agents with a saved provider's model or fallback: that provider is saved for the Pips first", async () => {
  const x = editor();
  x.e.receive({ type: "pipsRequest", id: "s1", request: { type: "set_pip_agents", pip_id: GST, fallback: { provider: PROV, model: "claude-opus-5-5" } } });
  await settle(() => x.sent.length);
  assert.deepEqual(x.saved, [[PROV, "claude-opus-5-5"]]);
  assert.equal(x.sent[0].request.type, "set_pip_agents");
  assert.deepEqual(x.sent[0].request.fallback, { provider: PROV, model: "claude-opus-5-5" });
  x.e.receive({ type: "pipsRequest", id: "s2", request: { type: "set_pip_agents", pip_id: GST, model_choice: { mode: "provider", provider: PROV, model: "m2" } } });
  await settle(() => x.sent.length > 1);
  assert.deepEqual(x.saved.at(-1), [PROV, "m2"]);
  x.e.receive({ type: "pipsRequest", id: "s3", request: { type: "set_pip_agents", pip_id: GST, fallback: { provider: "", model: "" } } });
  await settle(() => x.sent.length > 2);
  assert.equal(x.saved.length, 2, "none, or a model on DGC's own connection: nothing to save");
});
