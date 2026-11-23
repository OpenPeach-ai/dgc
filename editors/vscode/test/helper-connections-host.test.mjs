// A helper on one of the user's saved connections, by their own words (decided 17 Nov: "For the UI work, use the GLM 5
// flash model on my ollama cloud"), on the real src/panel.ts (bundled against a stub vscode). The extension tells DGC
// the names of the user's saved connections, never a key (set_helper_connections), and answers DGC's
// connection_route_request for one of them as a helper starts on it: with no card, only for a provider saved here,
// never a subscription (it runs its own tools). Nothing is sent to a DGC that doesn't say it takes it.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DgcViewProvider, cleanup, extensionRoot, recordingBackend } from "./support/panel-bundle.mjs";

after(cleanup);
const A = `provider_${"a".repeat(32)}`, B = `provider_${"b".repeat(32)}`;
const SAVED = [{ id: A, name: "Ollama Cloud", base_url: "https://ollama.com/v1", model: "glm-5-flash", api_mode: "auto" },
  { id: B, name: "Anthropic", base_url: "https://api.anthropic.com/v1", model: "claude-opus-5-5", api_mode: "anthropic" },
  { id: "subscription_claude", kind: "subscription", engine: "claude", name: "Claude Code", model: "" }];

function world(capabilities = { helper_connections: 1 }) {
  const store = new Map([["dgc.modelProviders.v1", SAVED], ["dgc.defaultModelProvider.v1", A]]);
  const provider = new DgcViewProvider({
    extension: { packageJSON: JSON.parse(readFileSync(join(extensionRoot, "package.json"), "utf8")) },
    secrets: { async get(name) { return String(name).includes(B) ? "sk-anthropic" : String(name).includes(A) ? "ollama-key" : ""; },
      async store() {}, async delete() {} }, subscriptions: [],
    globalState: { get: (key, fallback) => (store.has(key) ? store.get(key) : fallback), async update(key, value) { store.set(key, value); } },
    workspaceState: { get() {}, async update() {} },
  });
  const backend = recordingBackend();
  provider.post = () => {}; provider.webviewReady = true; provider.backend = backend; provider.ensureBackend = () => backend;
  provider.postState = () => {};
  provider.lastReadyEvent = { type: "ready", capabilities };
  return { provider, backend, sent: (type) => backend.sent.filter((c) => c.type === type) };
}

test("the names of the user's saved connections go to DGC, never a key; a subscription is named a CLI", () => {
  const x = world();
  x.provider.sendHelperConnections(x.backend);
  const [sent] = x.sent("set_helper_connections");
  assert.deepEqual(sent.connections, [
    { id: A, name: "Ollama Cloud", host: "ollama.com", kind: "api" },
    { id: B, name: "Anthropic", host: "api.anthropic.com", kind: "api" },
    { id: "subscription_claude", name: "Claude Code", host: "", kind: "cli" }]);
  assert.doesNotMatch(JSON.stringify(x.backend.sent), /sk-anthropic|ollama-key/);
  const old = world({});
  old.provider.sendHelperConnections(old.backend);
  assert.deepEqual(old.sent("set_helper_connections"), [], "an older DGC is sent nothing it can't read");
});

test("a route is answered for a saved provider, with its own key; anything else is an error", async () => {
  const x = world();
  await x.provider.answerConnectionRoute(x.backend, { type: "connection_route_request", id: "r1", connection: B });
  const [one] = x.sent("connection_route_response");
  assert.deepEqual(one, { type: "connection_route_response", id: "r1", base_url: "https://api.anthropic.com/v1",
                          api_mode: "anthropic", api_key: "sk-anthropic", model: "claude-opus-5-5" });
  for (const [id, connection] of [["r2", "subscription_claude"], ["r3", `provider_${"z".repeat(32)}`], ["r4", "../../secrets"]]) {
    await x.provider.answerConnectionRoute(x.backend, { type: "connection_route_request", id, connection });
    const answer = x.sent("connection_route_response").find((c) => c.id === id);
    assert.ok(answer.error && !answer.api_key, `${connection}: an error, no key`);
  }
  const old = world({});
  await old.provider.answerConnectionRoute(old.backend, { type: "connection_route_request", id: "r5", connection: A });
  assert.deepEqual(old.sent("connection_route_response"), []);
});

test("the request is answered as it arrives on the chat's stream", async () => {
  const x = world();
  x.provider.onEvent({ type: "connection_route_request", id: "r6", connection: A });
  for (let i = 0; i < 50 && !x.sent("connection_route_response").length; i++) await new Promise((r) => setTimeout(r, 10));
  const [answer] = x.sent("connection_route_response");
  assert.deepEqual([answer.id, answer.base_url, answer.model, answer.api_key], ["r6", "https://ollama.com/v1", "glm-5-flash", "ollama-key"]);
});
