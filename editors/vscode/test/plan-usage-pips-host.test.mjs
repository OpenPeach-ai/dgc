// ChatGPT · your plan and the usage meter in a Pip's chat (0.52), through the editor's real Pips bridge (src/pipsView.ts):
// the page's Connect, Cancel, meter and usage-page messages are the panel's (usePlan), never Pips controls, and none of
// them reaches DGC's Pips. list_pip_models' answer carries the plan's offer when no saved provider is the plan.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pipsViewModule } from "./support/pip-chat-scene.mjs";

const viewModule = await pipsViewModule();
const vscode = { ViewColumn: { Active: -1, Beside: -2 }, Uri: { joinPath: (...p) => ({ path: p.map((x) => x.path || x).join("/") }), file: (p) => ({ path: p }) },
  workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (k, f) => f }) }, window: { state: { focused: true }, onDidChangeWindowState: () => ({ dispose() {} }) } };
const PIP = "pip_" + "a".repeat(32), PLAN = "provider_" + "e".repeat(32);
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function bridge({ offer = "none" } = {}) {
  const { PipsEditor } = viewModule(vscode);
  const page = [], sent = [], calls = [];
  const editor = new PipsEditor({ path: "ext" }, (m) => { sent.push(m); return true; }, () => {}, true);
  editor.attach((m) => page.push(m));
  editor.ready({ pips_supported: true, pips_enabled: true, pips_api_version: 111 }, {});
  editor.receive({ type: "pipsReady" });
  editor.useSavedProviders(async () => [{ id: "provider_" + "a".repeat(32), name: "Ollama", default: true, models: ["m"], mark: "ollama", badge: "" }], async () => {});
  editor.usePlan({
    offer: async () => offer,
    connect: async (say, id) => { calls.push(["connect", id]); say({ type: "planConnecting", waiting: true }); say({ type: "planConnecting", waiting: false }); return true; },
    cancel: () => calls.push(["cancel"]),
    usage: async (choice, fresh) => { calls.push(["usage", choice, fresh]); return { type: "usageMeter", meter: { source: "chatgpt_plan", windows: [], at: 1, limited: true }, plan: true }; },
    openUsage: (source, page) => calls.push(["open", source, page]),
  });
  const generation = page.filter((m) => m.type === "pipsConnection").at(-1).generation;
  return { editor, page, sent, calls, generation };
}

test("a Pip's chat: Connect, Cancel, its meter and Manage usage go to the panel, never to DGC's Pips", async () => {
  const b = bridge();
  b.editor.receive({ type: "pipPlanConnect", id: "" });
  b.editor.receive({ type: "pipPlanConnect", id: "../etc" });
  b.editor.receive({ type: "pipPlanCancel" });
  b.editor.receive({ type: "pipUsageMeter", pip_id: PIP, model_choice: { mode: "provider", provider: PLAN, model: "gpt-6-luna" }, fresh: true });
  b.editor.receive({ type: "pipUsageMeter", pip_id: "pip_x", model_choice: { mode: "default" } });
  b.editor.receive({ type: "pipOpenUsagePage", source: "chatgpt_plan", page: "usage" });
  await tick();
  assert.deepEqual(b.calls, [["connect", ""], ["connect", ""], ["cancel"], ["usage", { mode: "provider", provider: PLAN, model: "gpt-6-luna" }, true], ["open", "chatgpt_plan", "usage"]],
    "a made-up provider id is never passed on; a made-up Pip gets no meter");
  assert.deepEqual(b.page.filter((m) => m.type === "pipPlanConnecting").map((m) => m.waiting), [true, false, true, false]);
  assert.deepEqual(b.page.filter((m) => m.type === "pipUsageMeter"), [{ type: "pipUsageMeter", meter: { source: "chatgpt_plan", windows: [], at: 1, limited: true }, plan: true, pip_id: PIP }]);
  assert.ok(b.page.some((m) => m.type === "pipsModelsChanged"), "connected: the Pip pages read their model list again");
  assert.deepEqual(b.sent.filter((m) => m.type === "pips_control"), [], "nothing went to DGC's Pips");
  b.editor.usageChanged();
  assert.ok(b.page.some((m) => m.type === "pipUsageChanged"));
});

test("list_pip_models' answer carries the plan's offer when no saved provider is the plan, and none when one is", async () => {
  for (const [offer, want] of [["none", "none"], ["signed_out", "signed_out"], ["", undefined]]) {
    const b = bridge({ offer });
    b.editor.receive({ type: "pipsRequest", id: "m1", generation: b.generation, request: { type: "list_pip_models" } });
    const control = b.sent.find((m) => m.type === "pips_control" && m.request.type === "list_pip_models");
    assert.ok(control, "the model list itself is DGC's");
    b.editor.event({ type: "pips_result", request_id: control.request.request_id, command: "list_pip_models", ok: true, result: { default_model: "m", models: [] } });
    await tick();
    const reply = b.page.find((m) => m.type === "pipsReply" && m.id === "m1");
    assert.equal(reply?.result?.plan_offer, want, `offer ${offer || "(none)"}`);
    assert.equal(reply.result.providers.length, 1);
  }
});
