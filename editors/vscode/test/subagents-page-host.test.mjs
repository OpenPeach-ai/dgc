// What the extension's host does for the picker's Sub-agents page (17 Nov), on the real src/panel.ts (bundled against
// a stub vscode): the sub-agents' own fallback for this session (set_config scope session, subagent_fallback_*, a saved
// provider's key only for its own address, never a CLI), the key a reopened session lacks, and the model's largest
// window (model_window_at, asked once per address and model for the panel's life). No key ever reaches the page.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DgcViewProvider, cleanup, extensionRoot, notices, recordingBackend } from "./support/panel-bundle.mjs";

after(cleanup);
const A = `provider_${"a".repeat(32)}`, B = `provider_${"b".repeat(32)}`;
const SAVED = [{ id: A, name: "Ollama", base_url: "http://localhost:11434/v1", model: "qwen3.8:27b", api_mode: "auto" },
  { id: B, name: "Anthropic", base_url: "https://api.anthropic.com/v1", model: "claude-opus-5-5", api_mode: "anthropic" },
  { id: "subscription_claude", kind: "subscription", engine: "claude", name: "Claude Code", model: "" }];
const CAPS = { agents_model: 1, subagent_fallback: 1, model_window_at: 1, subagent_thinking: 1 };

function world(capabilities = CAPS, windows = { "claude-opus-5-5": 200000, "qwen3-coder": 262144 }) {
  const posted = [], store = new Map([["dgc.modelProviders.v1", SAVED], ["dgc.defaultModelProvider.v1", A]]);
  const provider = new DgcViewProvider({
    extension: { packageJSON: JSON.parse(readFileSync(join(extensionRoot, "package.json"), "utf8")) },
    secrets: { async get(name) { return String(name).includes(B) ? "sk-anthropic" : String(name).includes(A) ? "ollama-key" : ""; }, async store() {}, async delete() {} }, subscriptions: [],
    globalState: { get: (key, fallback) => (store.has(key) ? store.get(key) : fallback), async update(key, value) { store.set(key, value); } },
    workspaceState: { get() {}, async update() {} },
  });
  const backend = recordingBackend();
  backend.request = function (command) { this.requested.push(command);
    if (command.type === "model_window_at") return Promise.resolve({ type: "model_window", request_id: command.request_id, role: command.role, model: command.model, window: windows[command.model] ?? 0 });
    return Promise.resolve({ type: "ok" }); };
  provider.post = (message) => { posted.push(message); };
  provider.webviewReady = true; provider.backend = backend; provider.ensureBackend = () => backend;
  provider.scheduleWorkspaceChanges = () => {}; provider.postState = () => {}; provider.backendNote = () => {}; provider.surfaceUnsentPrompts = () => {};
  provider.lastReadyEvent = { type: "ready", capabilities: { session_model_route: true, ...capabilities } };
  provider.state.baseUrl = "http://localhost:11434/v1"; provider.state.model = "qwen3.8:27b";
  provider.sessionReady = true;
  const asked = [];
  provider.requestState = async (_be, _kind, command) => { asked.push(command);
    if (command.type === "set_config" && command.scope === "session") {
      const v = command.values;
      return { type: "agents_model", own: false, model: "", base_url: "", fallback_own: true, fallback_model: v.subagent_fallback_model ?? "", fallback_base_url: v.subagent_fallback_base_url ?? "",
        fallback_api_key_set: !!v.subagent_fallback_api_key };
    }
    return { type: "config" }; };
  provider.readAgentsModel = async () => {};
  const agentsPosts = () => posted.filter((m) => m.type === "agentsModel");
  return { provider, posted, asked, backend, agentsPosts, windowsPosted: () => posted.filter((m) => m.type === "agentsWindow") };
}

test("the page hears what DGC can do and which fallback the sub-agents have; never a key", async () => {
  const x = world();
  x.provider.noteAgentsModel({ type: "agents_model", own: true, model: "own-coder", base_url: "https://api.anthropic.com/v1", api_key_set: true,
    fallback_own: true, fallback_model: "qwen3-coder", fallback_base_url: "http://localhost:11434/v1", fallback_api_key_set: true, settings_fallback_model: "x" });
  const view = x.agentsPosts().at(-1);
  assert.equal(view.window_offered, true);
  assert.equal(view.fallback_offered, true);
  assert.deepEqual([view.fallback_own, view.fallback_model, view.fallback_base_url], [true, "qwen3-coder", "http://localhost:11434/v1"]);
  assert.doesNotMatch(JSON.stringify(view), /api_key|sk-anthropic|ollama-key/);
  const old = world({ agents_model: 1 });
  old.provider.noteAgentsModel({ type: "agents_model", own: false });
  assert.deepEqual([old.agentsPosts().at(-1).window_offered, old.agentsPosts().at(-1).fallback_offered], [false, false], "an older DGC: neither");
});

test("Use as fallback: this session's sub-agents' own fallback, a saved provider's address, API and key; this host's with none; Stop clears it", async () => {
  const x = world();
  await x.provider.onMessage({ type: "setAgentsFallback", provider: B, model: "claude-opus-5-5" });
  assert.deepEqual(x.asked.at(-1), { type: "set_config", scope: "session", values: { subagent_fallback_model: "claude-opus-5-5", subagent_fallback_base_url: "https://api.anthropic.com/v1",
    subagent_fallback_api_mode: "anthropic", subagent_fallback_api_key: "sk-anthropic" } });
  assert.equal(x.agentsPosts().at(-1).fallback_model, "claude-opus-5-5", "DGC's answer goes to the page");
  assert.doesNotMatch(JSON.stringify(x.posted), /sk-anthropic/, "the key never reaches the page");
  await x.provider.onMessage({ type: "setAgentsFallback", provider: "", model: "glm-5.3:cloud" });
  assert.deepEqual(x.asked.at(-1).values, { subagent_fallback_model: "glm-5.3:cloud", subagent_fallback_base_url: "", subagent_fallback_api_mode: "", subagent_fallback_api_key: "" }, "this chat's own host: its own address and key");
  await x.provider.onMessage({ type: "setAgentsFallback", provider: B, model: "" });
  assert.deepEqual(x.asked.at(-1).values, { subagent_fallback_model: "", subagent_fallback_base_url: "", subagent_fallback_api_mode: "", subagent_fallback_api_key: "" }, "Stop: none for this session");
  // Never a CLI, never an unknown provider, never without the capability.
  const before = x.asked.length;
  for (const provider of ["subscription_claude", "claude", "codex"]) await x.provider.onMessage({ type: "setAgentsFallback", provider, model: "opus" });
  assert.equal(x.asked.length, before, "nothing sent for a CLI");
  assert.match(notices.warnings.at(-1), /It runs its own tools, so it can’t run DGC’s sub-agents/);
  const old = world({ agents_model: 1 });
  await old.provider.onMessage({ type: "setAgentsFallback", provider: B, model: "claude-opus-5-5" });
  assert.equal(old.asked.length, 0);
});

test("a reopened session with its own sub-agents' fallback and no key gets the one saved for that address, once", async () => {
  const x = world();
  x.provider.noteAgentsModel({ type: "agents_model", own: false, fallback_own: true, fallback_model: "claude-opus-5-5", fallback_base_url: "https://api.anthropic.com/v1", fallback_api_key_set: false });
  await new Promise((r) => setTimeout(r, 20));
  const sent = x.backend.sent.filter((c) => c.type === "set_config");
  assert.deepEqual(sent.map((c) => c.values), [{ subagent_fallback_api_key: "sk-anthropic" }]);
  assert.equal(sent[0].scope, "session");
  x.provider.noteAgentsModel({ type: "agents_model", own: false, fallback_own: true, fallback_model: "claude-opus-5-5", fallback_base_url: "https://api.anthropic.com/v1", fallback_api_key_set: false });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(x.backend.sent.filter((c) => c.type === "set_config").length, 1, "never sent in a loop");
  // An address no provider is saved for gets no key.
  const y = world();
  y.provider.noteAgentsModel({ type: "agents_model", own: false, fallback_own: true, fallback_model: "m", fallback_base_url: "https://other.example/v1", fallback_api_key_set: false });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(y.backend.sent.filter((c) => c.type === "set_config").length, 0);
});

test("the model's largest window: model_window_at for the row's connection, with its key only for its own address; once per address and model", async () => {
  const x = world();
  await x.provider.onMessage({ type: "agentsWindow", provider: B, model: "claude-opus-5-5" });
  const asked = x.backend.requested.filter((c) => c.type === "model_window_at");
  assert.equal(asked.length, 1);
  const { request_id, ...rest } = asked[0];
  assert.match(request_id, /\S/);
  assert.deepEqual(rest, { type: "model_window_at", role: "subagent", base_url: "https://api.anthropic.com/v1", model: "claude-opus-5-5", api_mode: "anthropic", api_key: "sk-anthropic" });
  assert.deepEqual(x.windowsPosted().at(-1), { type: "agentsWindow", provider: B, model: "claude-opus-5-5", window: 200000 });
  await x.provider.onMessage({ type: "agentsWindow", provider: B, model: "claude-opus-5-5" });
  assert.equal(x.backend.requested.filter((c) => c.type === "model_window_at").length, 1, "asked once for the panel's life");
  assert.deepEqual(x.windowsPosted().at(-1), { type: "agentsWindow", provider: B, model: "claude-opus-5-5", window: 200000 });
  // This chat's own host: the address DGC already has, no key from here.
  await x.provider.onMessage({ type: "agentsWindow", provider: "", model: "qwen3-coder" });
  const own = x.backend.requested.filter((c) => c.type === "model_window_at").at(-1);
  assert.deepEqual([own.base_url, own.api_key, own.model], ["", undefined, "qwen3-coder"]);
  assert.equal(x.windowsPosted().at(-1).window, 262144);
  // Settings' choice: what Settings has now.
  x.provider.noteAgentsModel({ type: "agents_model", own: false, model: "claude-opus-5-5", base_url: "https://api.anthropic.com/v1", settings_model: "claude-opus-5-5", settings_base_url: "https://api.anthropic.com/v1" });
  await x.provider.onMessage({ type: "agentsWindow", settings: true, model: "claude-opus-5-5" });
  assert.deepEqual(x.windowsPosted().at(-1), { type: "agentsWindow", settings: true, provider: "", model: "claude-opus-5-5", window: 200000 }, "the same address and model: from the panel's memory");
  // A CLI, or a DGC without model_window_at: 0, nothing asked.
  await x.provider.onMessage({ type: "agentsWindow", provider: "subscription_claude", model: "opus" });
  assert.equal(x.windowsPosted().at(-1).window, 0);
  const old = world({ agents_model: 1 });
  await old.provider.onMessage({ type: "agentsWindow", provider: B, model: "claude-opus-5-5" });
  assert.deepEqual(old.windowsPosted().at(-1), { type: "agentsWindow", provider: B, model: "claude-opus-5-5", window: 0 });
  assert.equal(old.backend.requested.length, 0);
  assert.doesNotMatch(JSON.stringify(x.posted), /sk-anthropic|ollama-key/);
});

test("a Pip's Sub-agents page asks the same way: a saved provider's address and key, or DGC's own connection; remembered", async () => {
  const x = world();
  assert.equal(await x.provider.pipModelWindow({ mode: "provider", provider: B, model: "claude-opus-5-5" }), 200000);
  const asked = x.backend.requested.filter((c) => c.type === "model_window_at");
  assert.deepEqual(asked.map(({ request_id, ...r }) => r), [{ type: "model_window_at", role: "subagent", base_url: "https://api.anthropic.com/v1", model: "claude-opus-5-5", api_mode: "anthropic", api_key: "sk-anthropic" }]);
  assert.equal(await x.provider.pipModelWindow({ mode: "provider", provider: B, model: "claude-opus-5-5" }), 200000);
  assert.equal(x.backend.requested.filter((c) => c.type === "model_window_at").length, 1, "remembered for the panel's life");
  assert.equal(await x.provider.pipModelWindow({ mode: "model", model: "qwen3-coder" }), 262144);
  const own = x.backend.requested.filter((c) => c.type === "model_window_at").at(-1);
  assert.deepEqual([own.base_url, own.api_key], ["", undefined], "DGC's own connection: its own address and key");
  assert.equal(await x.provider.pipModelWindow({ mode: "provider", provider: "subscription_claude", model: "opus" }), 0);
  assert.equal(await x.provider.pipModelWindow({ mode: "router", model: "x" }), 0);
  assert.equal(await world({ agents_model: 1 }).provider.pipModelWindow({ mode: "model", model: "qwen3-coder" }), 0, "a DGC without model_window_at");
});
