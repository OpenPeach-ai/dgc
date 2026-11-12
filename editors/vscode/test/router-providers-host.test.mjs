// The extension host's half of "one of your providers in DGC Router" and of model prices (0.52, src/panel.ts
// routerSettingsCommand and src/routerCommands.ts). Settings sends the provider's id and model names; the host first
// copies that provider to DGC (save_model_provider, its route and key, as for a Pip), then sends add_system with
// `provider`. The key goes to DGC only: no message to the page ever carries it. A provider's models are listed for the
// page by name. Only a CLI that says so hears any of it (router.providers with saved_model_providers; router.prices).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { cleanup, extensionRoot, makeProvider } from "./support/panel-bundle.mjs";
import { addProfile } from "../src/providerProfiles.js";

after(cleanup);

const generated = await build({ entryPoints: [extensionRoot + "/src/protocol.generated.ts"], bundle: true, write: false, format: "cjs", platform: "node" });
const protocol = { exports: {} };
new Function("module", "exports", generated.outputFiles[0].text)(protocol, protocol.exports);
const { dgcCommandError } = protocol.exports;
const commands = await build({ entryPoints: [extensionRoot + "/src/routerCommands.ts"], bundle: true, write: false, format: "cjs", platform: "node" });
const checked = { exports: {} };
new Function("module", "exports", commands.outputFiles[0].text)(checked, checked.exports);
const { routerCommand } = checked.exports;

const KEY = "gsk_live_0123456789abcdefROUTER";
const COMMANDS = ["router_status", "router_update", "router_probe", "router_find", "router_hardware", "router_suggest"];
const caps = (router = {}, rest = { saved_model_providers: 1, list_models_at: 1 }) => ({ router: { version: 1, commands: COMMANDS, enabled: true, ...router }, ...rest });
const STATUS = { enabled: true, when_busy: "wait", workers: { total: 2, free: 2, busy: 0 }, systems: [
  { id: "groq", name: "Groq", provider: "", has_key: true, enabled: true, health: { state: "unknown" }, leases: [], models: [] }] };

/** A provider wired to a backend that answers, with real saved providers (their keys in the secret store). */
async function world(capabilities, { listed = ["llama-3.3-70b-versatile", "qwen/qwen3-32b"], model = "llama-3.3-70b-versatile" } = {}) {
  const { provider, backend } = makeProvider({ capabilities });
  const state = new Map(), secrets = new Map();
  provider.context.globalState = { get: (key, fallback) => (state.has(key) ? state.get(key) : fallback), update: async (key, value) => { state.set(key, value); } };
  provider.context.secrets = { get: async (key) => secrets.get(key), store: async (key, value) => { secrets.set(key, value); }, delete: async (key) => { secrets.delete(key); } };
  const seen = [];
  backend.request = async (command, type) => {
    seen.push(JSON.parse(JSON.stringify(command)));
    if (command.type === "list_models_at") return { type: "models_at", ids: listed };
    if (command.type === "save_model_provider") return { type: "model_provider_saved", id: command.id, removed: false };
    return { type, request_id: command.request_id, status: STATUS, change: "Add Groq" };
  };
  const page = [];
  provider.settingsEditor = { webview: { postMessage: (m) => { page.push(m); return Promise.resolve(true); } } };
  const row = await addProfile(provider.context, { name: "Groq", base_url: "https://api.groq.com/openai/v1", model, api_mode: "chat_completions", api_key: KEY });
  const ask = async (command, token = "t") => { await provider.onSettingsMessage({ type: "routerCommand", token, command }); return page.filter((m) => m.type === "routerReply").at(-1); };
  return { provider, seen, page, row, ask };
}

test("the commands Settings may send: a provider only with add_system and only a saved provider's id; a price only with set_model", () => {
  const id = "provider_" + "a".repeat(32);
  const cases = [
    [{ type: "router_update", action: "add_system", provider: id, models: ["a", "b"], jobs: [], workers: 2 },
     { type: "router_update", action: "add_system", jobs: [], models: ["a", "b"], workers: 2, provider: id }],
    [{ type: "router_update", action: "add_system", base_url: "gpu-box.local", provider: "../../etc" },
     { type: "router_update", action: "add_system", base_url: "gpu-box.local" }],
    [{ type: "router_update", action: "edit_system", system: "gpu", provider: id, price_in: 1 }, { type: "router_update", action: "edit_system", system: "gpu" }],
    [{ type: "router_update", action: "set_model", system: "groq", model: "m", price_in: 0.5, price_out: 0 },
     { type: "router_update", action: "set_model", system: "groq", model: "m", price_in: 0.5, price_out: 0 }],
    [{ type: "router_update", action: "set_model", system: "groq", model: "m", price_in: -1, price_out: -1 },
     { type: "router_update", action: "set_model", system: "groq", model: "m", price_in: -1, price_out: -1 }],
    [{ type: "router_update", action: "set_model", system: "groq", model: "m", price_in: "0.5", price_out: 20000 },
     { type: "router_update", action: "set_model", system: "groq", model: "m" }],
    [{ type: "router_update", action: "set_model", system: "groq", model: "m", price_in: -3, price_out: NaN },
     { type: "router_update", action: "set_model", system: "groq", model: "m" }],
  ];
  for (const [raw, want] of cases) {
    const got = routerCommand(raw);
    assert.deepEqual(got, want, JSON.stringify(raw));
    assert.equal(dgcCommandError({ ...got, request_id: "router-1" }), undefined, JSON.stringify(got));
  }
  for (const bad of [{ type: "router_update", action: "add_system", provider: "groq" }, { type: "router_update", action: "add_system", provider: 7 },
    { type: "router_provider_models", provider: id }]) assert.equal(routerCommand(bad), undefined, JSON.stringify(bad));
});

test("adding a provider: DGC gets its own copy first (route and key), then add_system with its id; the page never sees the key", async () => {
  const w = await world(caps({ providers: 1 }));
  const reply = await w.ask({ type: "router_update", action: "add_system", provider: w.row.id, models: ["qwen/qwen3-32b", "llama-3.3-70b-versatile"], jobs: [], workers: 2,
    key: KEY, base_url: "https://evil.example/v1" });
  assert.deepEqual(w.seen.map((c) => c.type), ["save_model_provider", "router_update"], "the copy, then the system");
  const [copy, add] = w.seen;
  assert.deepEqual([copy.id, copy.name, copy.base_url, copy.api_key], [w.row.id, "Groq", "https://api.groq.com/openai/v1", KEY]);
  assert.equal(copy.model, "llama-3.3-70b-versatile", "the provider's own model");
  assert.equal(add.provider, w.row.id);
  assert.deepEqual(add.models, ["qwen/qwen3-32b", "llama-3.3-70b-versatile"]);
  assert.deepEqual(add.jobs, [], "no work until its form is saved");
  assert.equal(add.workers, 2);
  assert.equal("key" in add, false, "a key never rides on add_system");
  assert.equal("base_url" in add, false, "nor an address: it is the provider's");
  assert.equal(dgcCommandError(add), undefined);
  assert.deepEqual({ ...reply }, { type: "routerReply", token: "t", ok: true, status: STATUS, change: "Add Groq" });
  assert.doesNotMatch(JSON.stringify(w.page), new RegExp(KEY), "the key went to DGC only");
});

test("an All models provider is copied with the first ticked model; with none ticked nothing is sent", async () => {
  const w = await world(caps({ providers: 1 }), { model: "" });
  const none = await w.ask({ type: "router_update", action: "add_system", provider: w.row.id, models: [], jobs: [] });
  assert.deepEqual([none.ok, none.error], [false, "Tick at least one model."]);
  assert.deepEqual(w.seen, []);
  await w.ask({ type: "router_update", action: "add_system", provider: w.row.id, models: ["qwen/qwen3-32b"], jobs: [] });
  assert.equal(w.seen[0].type, "save_model_provider");
  assert.equal(w.seen[0].model, "qwen/qwen3-32b");
});

test("a provider that isn't saved, or a CLI that doesn't take one: said on the page, nothing reaches the Router", async () => {
  const w = await world(caps({ providers: 1 }));
  const gone = await w.ask({ type: "router_update", action: "add_system", provider: "provider_" + "f".repeat(32), models: ["m"], jobs: [] });
  assert.equal(gone.ok, false);
  assert.ok(gone.error, "why, in words");
  assert.deepEqual(w.seen.filter((c) => c.type === "router_update"), []);
  for (const capabilities of [caps({}), caps({ providers: 1 }, {})]) {
    const older = await world(capabilities);
    const reply = await older.ask({ type: "router_update", action: "add_system", provider: older.row.id, models: ["m"], jobs: [] });
    assert.deepEqual([reply.ok, reply.error], [false, "Update the DGC CLI to add one of your providers to DGC Router."]);
    assert.deepEqual(older.seen, []);
    const list = await older.ask({ type: "router_provider_models", provider: older.row.id });
    assert.equal(list.ok, false);
    assert.deepEqual(older.seen, []);
  }
});

test("a provider's models, for the page to tick: names only", async () => {
  const w = await world(caps({ providers: 1 }));
  const reply = await w.ask({ type: "router_provider_models", provider: w.row.id }, "m1");
  assert.deepEqual({ ...reply }, { type: "routerReply", token: "m1", ok: true, models: ["llama-3.3-70b-versatile", "qwen/qwen3-32b"] });
  assert.equal(w.seen.find((c) => c.type === "list_models_at").api_key, KEY, "DGC lists them with the provider's key");
  assert.doesNotMatch(JSON.stringify(w.page), new RegExp(KEY));
  const unknown = await w.ask({ type: "router_provider_models", provider: "subscription_claude" });
  assert.deepEqual([unknown.ok, unknown.error], [false, "That provider isn't saved any more."]);
});

test("a price reaches a CLI that takes prices, and is left out for one that doesn't", async () => {
  const set = { type: "router_update", action: "set_model", system: "groq", model: "m", note: "fast", price_in: 0.5, price_out: -1 };
  const takes = await world(caps({ prices: 1 }));
  await takes.ask(set);
  assert.deepEqual([takes.seen[0].price_in, takes.seen[0].price_out, takes.seen[0].note], [0.5, -1, "fast"]);
  const older = await world(caps({}));
  await older.ask(set);
  assert.equal("price_in" in older.seen[0] || "price_out" in older.seen[0], false);
  assert.equal(older.seen[0].note, "fast", "the rest of the change still goes");
});

test("Settings learns what the CLI takes with its config", async () => {
  for (const [capabilities, want] of [[caps({ providers: 1, prices: 1 }), [true, true]], [caps({}), [false, false]],
    [caps({ providers: 1 }, {}), [false, false]], [{}, [false, false]]]) {
    const { provider } = makeProvider({ capabilities });
    const page = [];
    provider.settingsEditor = { webview: { postMessage: (m) => { page.push(m); return Promise.resolve(true); } } };
    provider.onEvent({ type: "config", base_url: "http://x/v1", model: "m", mode: "auto" });
    const config = page.map((m) => m.event).find((e) => e?.type === "config");
    assert.ok(config, "the config reaches Settings");
    assert.deepEqual([config.router_providers, config.router_prices], want, JSON.stringify(capabilities));
  }
});
