// Settings -> Models -> DGC Router, fixes from testing:
// + Add system ticks only what the server has loaded now (none loaded: none ticked, and a short hint), Test never
// loads a model unasked (it says so, and "Test NAME (loads it)" tests it by name), Look on my network names exactly
// the ports it looks on, and Apply says what it applied.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { fileURLToPath } from "node:url";

const src = fileURLToPath(new URL("../src/", import.meta.url));
const result = await build({ entryPoints: [src + "settingsClient.js"], bundle: true, write: false,
  loader: { ".css": "empty", ".ico": "dataurl", ".png": "dataurl", ".svg": "dataurl" }, format: "iife" });
const code = result.outputFiles[0].text;
const view = await build({ entryPoints: [src + "settingsView.ts"], bundle: true, write: false, platform: "node", format: "cjs" });
const viewModule = { exports: {} };
new Function("module", "exports", view.outputFiles[0].text)(viewModule, viewModule.exports);
const helpers = await import(src + "settingsRouter.js");
const windows = [];
after(() => windows.forEach((w) => w.close()));

const NOW = Date.now() / 1000;
function status(over = {}) {
  return { enabled: true, when_busy: "wait", workers: { total: 6, free: 5, busy: 1 }, systems: [
    { id: "gpu", name: "GPU box", base_url: "http://gpu-box.local:11434", server: "ollama", enabled: true, jobs: ["subagents", "pips"],
      workers: 4, busy: 1, free: 3, one_model_at_a_time: true, health: { state: "online" }, has_key: false,
      hardware: { source: "node", url: "http://gpu-box.local:8577", line: "GB10 · 92 of 128 GB · 34% · 61°C", has_token: true },
      leases: [{ owner: "agent-7", label: "count bolts", model: "qwen3:8b", job: "subagents" }],
      models: [{ name: "qwen3.8:32b", workers: 3, busy: 0, free: 3, context: 65536, note: "design", params_b: 32, quant: "Q4_K_M",
                 tools: true, tokens_per_s: 41.2, ttft_ms: 320, parallel: 2, speed_at: NOW - 60 },
               { name: "qwen3:8b", workers: 4, busy: 1, free: 3, context: 32768, params_b: 8.2, tools: true }],
      available: [{ name: "qwen3.8:32b" }, { name: "qwen3:8b" }, { name: "llama3.1:8b", params_b: 8 }, { name: "nomic-embed-text", kind: "embedding" }] },
    { id: "nas", name: "NAS", base_url: "http://nas.local:8080", server: "llamacpp", enabled: true, jobs: ["pips"], workers: 2, busy: 0,
      free: 2, one_model_at_a_time: false, health: { state: "online" }, server_slots: 2, server_slot_context: 16384, leases: [],
      models: [{ name: "qwen3:4b", workers: 2, free: 2, context: 16384 }] }], ...over };
}
function setup({ capable = true, routerStatus = status(), answers = {} } = {}) {
  const dom = new JSDOM(viewModule.exports.settingsDocument(), { runScripts: "outside-only", pretendToBeVisual: true });
  const { window: w } = dom;
  windows.push(w);
  const sent = [];
  let current = routerStatus;
  const message = (m) => w.dispatchEvent(new w.MessageEvent("message", { data: m }));
  w.acquireVsCodeApi = () => ({ getState() {}, setState() {}, postMessage: (m) => {
    sent.push(m);
    if (m.type !== "routerCommand") return;
    const answer = answers[m.command.type + (m.command.action ? ":" + m.command.action : "")];
    const reply = typeof answer === "function" ? answer(m.command, current) : answer;
    if (reply?.status) current = reply.status;
    queueMicrotask(() => message({ type: "routerReply", token: m.token, ok: true, status: current, ...(reply || {}) }));
  } });
  w.CSS = w.CSS || { escape: (s) => String(s).replace(/["\\]/g, "\\$&") };
  w.eval(code);
  const config = { type: "config", base_url: "https://model.example/v1", model: "main-model", mode: "default", pips_settable: true,
    pips_model: "", subagent_model: "agent", fallback_model: "backup", max_parallel_tasks: 4,
    ...(capable ? { router_capable: true, router_pips_default: true } : {}) };
  message({ type: "event", event: config });
  message({ type: "show", section: "models" });
  const settle = () => new Promise((r) => setTimeout(r, 5));
  return { w, d: w.document, sent, message, config, settle, // Plain objects: the page's own are of the window's realm.
    routerSent: () => JSON.parse(JSON.stringify(sent.filter((m) => m.type === "routerCommand").map((m) => m.command))),
    click: (s) => w.document.querySelector(s).click() };
}


const ADDED = (models, available, server = "ollama") => {
  const st = status();
  st.systems.push({ id: "mac", name: "Mac", base_url: "http://mac.local:11434", server, enabled: true, jobs: ["subagents", "pips"],
    workers: 1, free: 1, health: { state: "unknown" }, leases: [], models, available });
  return st;
};
async function add(x) {
  await x.settle();
  x.click("[data-router-add]");
  x.d.getElementById("router-add-address").value = "mac.local";
  x.d.getElementById("router-add-name").value = "Mac";
  x.click("[data-router-add-look]");
  for (let i = 0; i < 10; i++) await x.settle();
  return x.d.querySelector("[data-router-system=mac] .router-form");
}
const rows = (form) => [...form.querySelectorAll("[data-model-row]")].map((r) => [r.querySelector(".router-use span").textContent.replace(/ \(.*\)$/, ""), r.querySelector("[data-edit=use]").checked]);

test("+ Add system on a server with nothing loaded: its models offered, none ticked, and a short hint", async () => {
  const available = [{ name: "kimi-k3:cloud", cloud: true, params_b: 2810 }, { name: "qwen3.6:35b-a3b", params_b: 35 },
    { name: "qwen2.5:7b", params_b: 7.6 }, { name: "nomic-embed-text", kind: "embedding" }];
  const x = setup({ answers: { "router_update:add_system": { status: ADDED([], available), change: "Add Mac. Nothing is loaded on Mac now, so DGC chose no model." } } });
  const form = await add(x);
  assert.deepEqual(rows(form), [["qwen2.5:7b", false], ["qwen3.6:35b-a3b", false], ["kimi-k3:cloud", false]], "the smallest first, cloud last, never an embedding model");
  assert.equal(form.querySelector(".router-choose").textContent, "Nothing is loaded on Mac now, so none is ticked. Tick the ones to use: using one loads it there.");
  // Ticked, then Save: only that one is added.
  form.querySelector("[data-model-row='0'] [data-edit=use]").checked = true;
  form.querySelector("[data-router-edit-save=mac]").click();
  for (let i = 0; i < 10; i++) await x.settle();
  const models = x.routerSent().filter((c) => c.action === "set_model");
  assert.deepEqual(models.map((c) => [c.model, c.use]), [["qwen2.5:7b", true]]);
});

test("Test in the form keeps what was ticked ticked, and the rest still offered", async () => {
  const available = [{ name: "qwen2.5:7b", params_b: 7.6 }, { name: "qwen3.6:35b-a3b", params_b: 35 }, { name: "llama3.2:3b", params_b: 3.2 }];
  const saved = ADDED([{ name: "qwen2.5:7b", workers: 1, context: 32768 }], available);
  const x = setup({ answers: { "router_update:add_system": { status: ADDED([], available) },
    "router_update:set_model": { status: saved },
    "router_probe": { probe: { system: "mac", results: { "qwen2.5:7b": { not_loaded: true, error: "not loaded on Mac now: testing it would load it there (about 4 GB)" } } } } } });
  const form = await add(x);
  assert.deepEqual(rows(form), [["llama3.2:3b", false], ["qwen2.5:7b", false], ["qwen3.6:35b-a3b", false]]);
  form.querySelector("[data-model-name='qwen2.5:7b'] [data-edit=use]").checked = true;
  form.querySelector("[data-router-edit-test=mac]").click();
  for (let i = 0; i < 12; i++) await x.settle();
  const after = x.d.querySelector("[data-router-system=mac] .router-form");
  assert.deepEqual(rows(after), [["qwen2.5:7b", true], ["llama3.2:3b", false], ["qwen3.6:35b-a3b", false]],
    "the saved one stays ticked after the redraw; the others are still there to tick");
  assert.equal(after.querySelector(".router-choose"), null, "the hint goes once one is ticked");
  after.querySelector("[data-router-edit-save=mac]").click();
  for (let i = 0; i < 12; i++) await x.settle();
  assert.equal(x.routerSent().some((c) => c.action === "set_model" && c.use === false), false, "Save never unticks it");
});

test("+ Add system on a server with a model loaded: DGC's choice is shown ticked, no hint", async () => {
  const x = setup({ answers: { "router_update:add_system": { status: ADDED([{ name: "qwen2.5:7b", workers: 1, context: 32768 }],
    [{ name: "qwen2.5:7b", loaded: true }, { name: "kimi-k3:cloud", cloud: true }]) } } });
  const form = await add(x);
  assert.deepEqual(rows(form), [["qwen2.5:7b", true]]);
  assert.equal(form.querySelector(".router-choose"), null);
});

test("the rows offered follow DGC's own rule", () => {
  const { offeredRows } = helpers;
  const use = (list, server) => offeredRows(list, server).map((r) => [r.name, r.use]);
  assert.deepEqual(use([{ name: "a" }, { name: "b", loaded: true }, { name: "c:cloud", loaded: true }], "ollama"),
    [["b", true], ["c:cloud", false], ["a", false]], "loaded first; a loaded cloud model is still never ticked");
  assert.deepEqual(use([{ name: "big-model" }], "openai_compatible"), [["big-model", true]], "the one model a plain server serves");
  assert.deepEqual(use([{ name: "big-model" }], "ollama"), [["big-model", false]], "on Ollama, not loaded is not loaded");
  assert.equal(offeredRows(Array.from({ length: 20 }, (_, i) => ({ name: `m${i}` })), "ollama").length, 8);
});

test("Test says when a model isn't loaded, and tests it by name only when asked", async () => {
  const x = setup({ answers: {
    "router_probe": (cmd) => ({ probe: cmd.model
      ? { system: "gpu", results: { [cmd.model]: { speed: { ok: true, tokens_per_s: 30, ttft_ms: 400 } } } }
      : { system: "gpu", results: { "qwen3.8:32b": { not_loaded: true, error: "not loaded on GPU box now: testing it would load it there (about 19 GB)" },
                                    "qwen3:8b": { speed: { ok: true, tokens_per_s: 80, ttft_ms: 90 } } } } }) } });
  await x.settle();
  x.click("[data-router-test=gpu]");
  for (let i = 0; i < 5; i++) await x.settle();
  const result = x.d.querySelector("[data-router-system=gpu] .router-result");
  assert.match(result.textContent, /qwen3\.8:32b: not loaded on GPU box now: testing it would load it there \(about 19 GB\)\. Not tested\./);
  assert.deepEqual(x.routerSent().at(-1), { type: "router_probe", system: "gpu" });
  const load = result.querySelector("[data-router-test-model]");
  assert.equal(load.textContent, "Test qwen3.8:32b (loads it)");
  load.click();
  for (let i = 0; i < 5; i++) await x.settle();
  assert.deepEqual(x.routerSent().at(-1), { type: "router_probe", system: "gpu", model: "qwen3.8:32b" });
  assert.match(x.d.querySelector("[data-router-system=gpu] .router-result").textContent, /qwen3\.8:32b: 30 tok\/s/);
});

test("Look on my network asks about exactly the ports it looks on", async () => {
  const x = setup();
  await x.settle();
  x.click("[data-router-find]");
  assert.match(x.d.querySelector("[data-router-finding]").textContent, /\(11434, 8080, 1234, 8000, 30000, 8188\)/);
});

test("Apply says what it applied", async () => {
  const x = setup({ answers: {
    "router_suggest": { suggestion: { applicable: true, models: [{ name: "qwen3:8b", workers: 2, line: "qwen3:8b: it ran 2 at once (measured) → 2 workers" }] } },
    "router_update:apply_suggestion": { change: "Applied: GPU box · qwen3:8b · 2 workers at 32K." } } });
  await x.settle();
  x.click("[data-router-suggest=gpu]");
  for (let i = 0; i < 5; i++) await x.settle();
  x.click("[data-router-apply=gpu]");
  for (let i = 0; i < 5; i++) await x.settle();
  const card = x.d.querySelector("[data-router-system=gpu]");
  assert.equal(card.querySelector(".router-suggest"), null, "the suggestion closes");
  assert.match(card.textContent, /Applied: GPU box · qwen3:8b · 2 workers at 32K\./);
});
