// What the extension's host tells the model picker (17 Nov), on the real src/panel.ts (bundled against a stub vscode):
// Work's `models` answer carries, for a subscription app, its model names and, for Claude Code, the version each
// nickname last ran as and the versions that can be pinned (dgc/subscriptions.py status()); choosing one of another
// app's models moves the session to that app on that model in one step; ChatDGC's and a Pip's lists carry each
// connection's mark and badge, decided here, so no address ever has to reach a page.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DgcViewProvider, cleanup, extensionRoot, recordingBackend } from "./support/panel-bundle.mjs";

after(cleanup);
const A = `provider_${"a".repeat(32)}`, B = `provider_${"b".repeat(32)}`, C = `provider_${"c".repeat(32)}`;
const SAVED = [{ id: A, name: "Ollama", base_url: "http://localhost:11434/v1", model: "qwen3.8:27b", api_mode: "auto" },
  { id: B, name: "Anthropic", base_url: "https://api.anthropic.com/v1", model: "claude-opus-5-5", api_mode: "anthropic" },
  { id: C, name: "NAS workstation", base_url: "http://10.0.0.40:9000/v1", model: "", api_mode: "auto" },
  { id: "subscription_claude", kind: "subscription", engine: "claude", name: "Claude Code", model: "" },
  { id: "subscription_codex", kind: "subscription", engine: "codex", name: "Codex", model: "" }];
const ENGINES = [{ key: "claude", label: "Claude Code (Pro / Max subscription)", installed: true, logged_in: true, auth_state: "signed_in", model_hints: ["fable", "opus", "sonnet", "haiku"],
    model_versions: { opus: "claude-opus-5-5", "": "claude-sonnet-5-5" }, fixed_models: ["claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-4-9"], cli_default_model: "", cli_default_listed: null, supports_effort: true },
  { key: "codex", label: "Codex (ChatGPT Plus / Pro subscription)", installed: true, logged_in: true, auth_state: "signed_in", model_hints: ["gpt-5.6-sol", "gpt-5.6-luna"], cli_default_model: "gpt-5.6-sol", cli_default_listed: true, supports_effort: true }];

function world({ config = {}, capabilities = {} } = {}) {
  const posted = [], store = new Map([["dgc.modelProviders.v1", SAVED], ["dgc.defaultModelProvider.v1", A]]);
  const provider = new DgcViewProvider({
    extension: { packageJSON: JSON.parse(readFileSync(join(extensionRoot, "package.json"), "utf8")) },
    secrets: { async get() { return "key"; }, async store() {}, async delete() {} }, subscriptions: [],
    globalState: { get: (key, fallback) => (store.has(key) ? store.get(key) : fallback), async update(key, value) { store.set(key, value); } },
    workspaceState: { get() {}, async update() {} },
  });
  const backend = recordingBackend();
  backend.request = function (command) { this.requested.push(command); this.sent.push(command);
    if (command.type === "list_models") return Promise.resolve({ type: "models", ids: ["qwen3.8:27b", "glm-5.3:cloud"] });
    return Promise.resolve({ type: "ok" }); };
  provider.post = (message) => { posted.push(message); };
  provider.webviewReady = true; provider.backend = backend; provider.ensureBackend = () => backend;
  provider.scheduleWorkspaceChanges = () => {}; provider.postState = () => {}; provider.backendNote = () => {}; provider.surfaceUnsentPrompts = () => {};
  provider.lastReadyEvent = { type: "ready", capabilities: { session_model_route: true, ...capabilities } };
  provider.state.baseUrl = "http://localhost:11434/v1"; provider.state.model = "qwen3.8:27b";
  const asked = [];
  provider.requestState = async (_be, _kind, command) => { asked.push(command);
    if (command.type === "get_config") return { type: "config", model: "qwen3.8:27b", think: "off", subscription_engine: "", subscription_model: "", subscription_effort: "", subscription_engines: ENGINES, ...config };
    if (command.type === "list_models_at") return { type: "models_at", ids: ["one", "two"] };
    return { type: "config" }; };
  provider.readAgentsModel = async () => {};
  provider.verifySubscription = async () => {};
  return { provider, posted, asked, backend, models: () => posted.filter((m) => m.type === "models").at(-1) };
}

test("Work's models answer: a subscription app's row carries its names, and Claude Code's the versions and the fixed list", async () => {
  const x = world();
  await x.provider.listModels();
  const m = x.models();
  assert.equal(m.currentRouteKey, A);
  assert.equal(m.base, "http://localhost:11434/v1", "the host the session is on, for its mark when it is no saved provider");
  const claude = m.routes.find((row) => row.key === "subscription_claude"), codex = m.routes.find((row) => row.key === "subscription_codex");
  assert.deepEqual({ kind: claude.kind, engine: claude.engine, hints: claude.hints, versions: claude.versions, fixed: claude.fixed },
    { kind: "subscription", engine: "claude", hints: ["fable", "opus", "sonnet", "haiku"], versions: { opus: "claude-opus-5-5", "": "claude-sonnet-5-5" },
      fixed: ["claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-4-9"] });
  assert.deepEqual({ hints: codex.hints, versions: codex.versions, fixed: codex.fixed, cli: codex.cli_default_model }, { hints: ["gpt-5.6-sol", "gpt-5.6-luna"], versions: {}, fixed: [], cli: "gpt-5.6-sol" });
  assert.equal(m.routes.find((row) => row.key === A).hints, undefined, "a host's row carries no names: its host lists them");
  assert.equal(JSON.stringify(m).includes("\"key\""), true);
  assert.doesNotMatch(JSON.stringify(m.routes.map((row) => Object.keys(row))), /api_key|secret/i, "no key reaches the page");
});

test("a session on Claude Code: its own row carries the same facts, and what it reports is bounded", async () => {
  const noisy = [{ ...ENGINES[0], model_versions: { opus: "x".repeat(400), haiku: 7, sonnet: "claude-sonnet-5-5" }, fixed_models: ["ok-1", 3, "", ...Array.from({ length: 100 }, (_, i) => `m-${i}`)] }];
  const x = world({ config: { subscription_engine: "claude", subscription_model: "opus", subscription_engines: noisy } });
  await x.provider.listModels();
  const m = x.models(), row = m.routes.find((r) => r.key === "subscription_claude");
  assert.deepEqual([m.subscription, m.current, m.currentRouteKey, m.ids], [true, "opus", "subscription_claude", ["fable", "opus", "sonnet", "haiku"]]);
  assert.deepEqual(row.versions, { sonnet: "claude-sonnet-5-5" }, "only a model's name is a version");
  assert.equal(row.fixed.length, 64);
  assert.deepEqual(row.fixed.slice(0, 2), ["ok-1", "m-0"]);
});

test("choosing a model of another subscription app moves the session to that app on that model in one step", async () => {
  const x = world();
  await x.provider.onMessage({ type: "setSubscription", engine: "subscription_claude", model: "claude-opus-5-5" });
  const set = x.asked.filter((c) => c.type === "set_config").at(-1);
  assert.deepEqual(set, { type: "set_config", scope: "session", values: { subscription_engine: "claude", subscription_model: "claude-opus-5-5" } }, "a fixed version goes to DGC by its full name");
  // The app's own default is a choice too ("" is said, not left as it was).
  await x.provider.onMessage({ type: "setSubscription", engine: "subscription_codex", model: "" });
  assert.deepEqual(x.asked.filter((c) => c.type === "set_config").at(-1).values, { subscription_engine: "codex", subscription_model: "" });
  // Without a model (the Settings page's "use this app"): the app keeps the model it last had.
  await x.provider.onMessage({ type: "setSubscription", engine: "subscription_codex" });
  assert.deepEqual(x.asked.filter((c) => c.type === "set_config").at(-1).values, { subscription_engine: "codex" });
});

test("ChatDGC's list: every connection with its mark and badge and no address; Claude Code's versions come with its names", async () => {
  const x = world({ config: { subscription_engines: ENGINES } });
  x.provider.routeState.subscriptionEngines = ENGINES;
  const first = await x.provider.chatdgcModels("");
  assert.deepEqual(first.profiles.map((p) => [p.name, p.kind, p.mark, p.badge]), [["Ollama", "native", "ollama", ""], ["Anthropic", "native", "anthropic", "key"], ["NAS workstation", "native", "", ""],
    ["Claude Code", "subscription", "claudecode", "cli"], ["Codex", "subscription", "openai", "cli"]]);
  assert.doesNotMatch(JSON.stringify(first.profiles), /https?:\/\/|base_url/, "no address reaches ChatDGC's page");
  const claude = await x.provider.chatdgcModels("subscription_claude");
  assert.deepEqual(claude.ids, ["", "fable", "opus", "sonnet", "haiku"]);
  assert.deepEqual(claude.cli, { versions: { opus: "claude-opus-5-5", "": "claude-sonnet-5-5" }, fixed: ["claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-4-9"] });
  const codex = await x.provider.chatdgcModels("subscription_codex");
  assert.deepEqual(codex.cli, { versions: {}, fixed: [] });
  const host = await x.provider.chatdgcModels(A);
  assert.equal(host.cli, undefined, "a host has none");
});

test("a Pip's list: each saved provider with its mark and badge, and the host DGC is on by its name and mark", async () => {
  const x = world({ capabilities: { saved_model_providers: 1 } });
  const rows = await x.provider.pipSavedProviders();
  assert.deepEqual(rows.map((r) => [r.name, r.default, r.mark, r.badge]), [["Ollama", true, "ollama", ""], ["Anthropic", false, "anthropic", "key"], ["NAS workstation", false, "", ""]]);
  assert.doesNotMatch(JSON.stringify(rows), /https?:\/\/|base_url|api_key/);
  assert.deepEqual(x.provider.pipHostMark(), { name: "Ollama (local)", mark: "ollama", badge: "" });
  x.provider.state.baseUrl = "https://llm.example.com/v1";
  assert.deepEqual(x.provider.pipHostMark(), { name: "Custom host", mark: "", badge: "key" });
});

// ChatGPT · your plan (0.52): Work's routes say a saved plan row's sign-in state (its key is the plan's marker); with
// none saved and a DGC that has the plan, the rail offers it; a DGC without the plan offers nothing.
test("Work's models answer: the plan's saved row says its state, and with none saved the rail offers ChatGPT · your plan", async () => {
  const PLAN = `provider_${"e".repeat(32)}`;
  const x = world({ capabilities: { chatgpt_plan: { version: 1, state: "signed_out" } } });
  x.provider.constructor.planSaid = "";
  await x.provider.listModels();
  assert.deepEqual(x.models().routes.filter((r) => r.kind === "plan_offer").map((r) => [r.key, r.label, r.plan]), [["chatgpt_plan", "ChatGPT · your plan", "signed_out"]]);
  const saved = [...SAVED, { id: PLAN, name: "ChatGPT · your plan", base_url: "https://api.openai.com/v1", model: "", api_mode: "responses" }];
  x.provider.context.globalState.update("dgc.modelProviders.v1", saved);
  x.provider.context.secrets.get = async (key) => (String(key).includes(PLAN) ? "dgc-chatgpt-plan" : "key");
  await x.provider.listModels();
  const routes = x.models().routes;
  assert.equal(routes.find((r) => r.key === PLAN).plan, "signed_out");
  assert.equal(routes.filter((r) => r.kind === "plan_offer").length, 0);
  assert.equal(routes.filter((r) => r.plan).length, 1, "only the plan's row: OpenAI's own key at the same address would not be it");
  const old = world();
  await old.provider.listModels();
  assert.equal(old.models().routes.filter((r) => r.plan || r.kind === "plan_offer").length, 0, "a DGC without the plan offers nothing");
});

// A Pip's chat in the side bar (0.52): its usage meter's and its picker's ChatGPT plan messages are passed to the Pips
// bridge (which answers them through the panel's usePlan), only from this page's own document.
test("the side bar's Pip page: its meter and plan messages reach the Pips bridge, only from its own document", async () => {
  const x = world();
  x.provider.pipsDocumentId = "doc1";
  const bridge = x.provider.ensurePipsBridge();
  const got = [];
  bridge.receive = (message) => got.push(message.type);
  for (const type of ["pipUsageMeter", "pipOpenUsagePage", "pipPlanConnect", "pipPlanCancel"]) await x.provider.onMessage({ type, documentId: "doc1", pip_id: `pip_${"a".repeat(32)}` });
  await x.provider.onMessage({ type: "pipUsageMeter", documentId: "someone-else", pip_id: `pip_${"a".repeat(32)}` });
  assert.deepEqual(got, ["pipUsageMeter", "pipOpenUsagePage", "pipPlanConnect", "pipPlanCancel"]);
});
