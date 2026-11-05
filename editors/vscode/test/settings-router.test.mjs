// Settings -> Models, reorganised for DGC Router (0.51): Main model, Fallback, Sub-agents, Pips, Images and DGC Router
// as blocks of one page; with the Router on, Sub-agents says the Router chooses, Pips can run on any Pip system, and
// the Systems list draws each system from router_status / router_changed, live. Every Router change goes to DGC at
// once as a router_* command (never with Save all), a key goes once and is never shown again, and a look on the
// network asks first.
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
                 tools: true, tokens_per_s: 41.2, ttft_ms: 320, parallel: 2, speed_at: NOW - 20 },
               { name: "qwen3:8b", workers: 4, busy: 1, free: 3, context: 32768, params_b: 8.2, tools: true }],
      available: [{ name: "qwen3.8:32b" }, { name: "qwen3:8b" }, { name: "llama3.1:8b", params_b: 8 }, { name: "nomic-embed-text", kind: "embedding" }] },
    { id: "nas", name: "NAS", base_url: "http://nas.local:8080", server: "llamacpp", enabled: true, jobs: ["pips"], workers: 2, busy: 0,
      free: 2, one_model_at_a_time: false, health: { state: "online" }, server_slots: 2, server_slot_context: 16384, leases: [],
      models: [{ name: "qwen3:4b", workers: 2, free: 2, context: 16384 }] }], ...over };
}
function setup({ capable = true, routerStatus = status(), answers = {}, images = false, place = "models", showFirst = false, scrolled = null, extra = {}, beforeEval = null } = {}) {
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
  if (scrolled) w.Element.prototype.scrollIntoView = function () { scrolled.push(this.id || this.className); };
  beforeEval?.(w);
  w.eval(code);
  const config = { type: "config", base_url: "https://model.example/v1", model: "main-model", mode: "default", pips_settable: true,
    pips_model: "", subagent_model: "agent", fallback_model: "backup", max_parallel_tasks: 4,
    ...(capable ? { router_capable: true, router_pips_default: true } : {}), ...(images ? { images_capable: true } : {}), ...extra };
  if (showFirst) message({ type: "show", section: place });       // a tab opened at a place, before DGC's settings
  message({ type: "event", event: config });
  if (!showFirst) message({ type: "show", section: place });
  const settle = () => new Promise((r) => setTimeout(r, 5));
  return { w, d: w.document, sent, message, config, settle, // Plain objects: the page's own are of the window's realm.
    routerSent: () => JSON.parse(JSON.stringify(sent.filter((m) => m.type === "routerCommand").map((m) => m.command))),
    click: (s) => w.document.querySelector(s).click() };
}

test("Models holds one provider list, fallback, sub-agents, Pips, images and DGC Router", async () => {
  const x = setup({ images: true });
  await x.settle();
  const titles = [...x.d.querySelectorAll("#page section.group > h3")].map((h) => h.textContent);
  assert.deepEqual(titles.filter((t) => ["Providers", "Fallback", "Sub-agents", "Pips", "Images", "DGC Router"].includes(t)),
    ["Providers", "Fallback", "Sub-agents", "Pips", "Images", "DGC Router"]);
  assert.equal(x.d.querySelector("[data-nav=agents]"), null, "one page for every model choice");
  assert.ok(x.d.querySelector("#models-images"), "Images, from a CLI that makes them");
  const older = setup();
  await older.settle();
  assert.equal(older.d.querySelector("#models-images"), null, "an older CLI has no Images");
  // An old link to Agents opens Models.
  x.message({ type: "show", section: "agents" });
  assert.equal(x.d.querySelector("[data-nav=models]").getAttribute("aria-current"), "page");
});

test("providers show the chosen subscription with no unrelated API model, and Add filters saved routes", async () => {
  const x = setup({ extra: { subscription_engine: "claude", subscription_model: "sonnet" } });
  await x.settle();
  x.message({ type: "providers", providers: [
    { id: "ollama", label: "Ollama", url: "http://localhost:11434/v1" },
    { id: "deepseek", label: "DeepSeek", url: "https://api.deepseek.com/v1" },
  ] });
  x.message({ type: "providerProfiles", profiles: [{ id: "provider_" + "a".repeat(32), name: "Ollama",
    base_url: "http://localhost:11434/v1", model: "deepseek-v4.1-flash:cloud", api_mode: "auto" },
    { id: "subscription_claude", kind: "subscription", engine: "claude", name: "Claude Code", model: "sonnet" }],
    defaultId: "subscription_claude" });
  assert.match(x.d.querySelector("#page").textContent, /Claude Code/);
  assert.match(x.d.querySelector("#page").textContent, /sonnet/);
  const options = [...x.d.querySelector("#saved_provider_preset").options].map(option => option.value);
  assert.equal(options.includes("ollama"), false);
  assert.equal(options.includes("deepseek"), true);
  assert.equal(options.includes("custom"), true);
  assert.equal(options.includes("claude"), false);
  assert.equal(options.includes("codex"), true);
});

test("with the Router off, Sub-agents and Pips are today's fields, and the switch says what it does", async () => {
  const x = setup({ routerStatus: status({ enabled: false }) });
  await x.settle();
  assert.deepEqual(x.routerSent()[0], { type: "router_status" }, "the page asks once for the Router's status");
  for (const id of ["subagent_model", "max_parallel_tasks", "subagent_context_size", "subagent_base_url", "pips_model"]) {
    assert.ok(x.d.getElementById(id), `${id} is on Models`);
  }
  assert.equal(x.d.getElementById("pips_model").tagName, "INPUT", "today's model box");
  const sw = x.d.getElementById("router-on");
  assert.equal(sw.getAttribute("aria-checked"), "false");
  assert.match(sw.closest(".field").textContent, /Use my other computers/);
  assert.equal(sw.closest(".field").querySelector(".hint").textContent, "Sub-agents and Pips on other computers.");
  assert.match(sw.closest(".field").querySelector(".detail").textContent, /Spread sub-agents and Pips across the computers on your network that run models/);
  assert.equal(x.d.querySelector(".router-systems"), null, "no Systems list while it is off");
  sw.click();
  await x.settle();
  assert.deepEqual(x.routerSent().at(-1), { type: "router_update", action: "turn_on" }, "saved at once, not with Save all");
});

test("an older CLI: the Router block says to update, and nothing is asked", async () => {
  const x = setup({ capable: false });
  await x.settle();
  assert.deepEqual(x.routerSent(), []);
  assert.match(x.d.getElementById("models-router").textContent, /Update the DGC CLI to use DGC Router/);
});

test("with the Router on: the Sub-agents line, Pips run on any Pip system, and one card per system", async () => {
  const x = setup();
  await x.settle();
  assert.equal(x.d.getElementById("router-subagents-line").textContent, "Chosen by DGC Router · 1 system · 3 workers free");
  assert.ok(x.d.querySelector("[data-more='subagent-usual'] #subagent_model"), "the usual sub-agent model is one click away");
  const pips = x.d.getElementById("pips_model");
  assert.equal(pips.tagName, "SELECT");
  assert.deepEqual([...pips.options].map((o) => [o.value, o.textContent]), [
    ["router", "Any Pip system"], ["router:gpu/qwen3.8:32b", "GPU box · qwen3.8:32b"], ["router:gpu/qwen3:8b", "GPU box · qwen3:8b"],
    ["router:nas/qwen3:4b", "NAS · qwen3:4b"], ["", "Not the Router: Same as DGC (main-model)"]]);
  const card = x.d.querySelector("[data-router-system=gpu]");
  const lines = [...card.querySelectorAll(".router-card-head > span, .router-line, .router-model-name")].map((el) => el.textContent);
  for (const line of ["GPU box", "Ollama · gpu-box.local:11434", "3 of 4 workers free", "Jobs: Sub-agents · Pips", "qwen3.8:32b (32B Q4)",
    "One model at a time · Total: 3 × 64K = 192K context", "Last test (just now): 41.2 tok/s · first token 320 ms · 2 at once · tool calls ✓",
    "Hardware: GB10 · 92 of 128 GB · 34% · 61°C", "Working: qwen3:8b for count bolts"]) assert.ok(lines.includes(line), `${line} in ${JSON.stringify(lines)}`);
  for (const b of ["Test", "Suggest", "Edit", "Remove"]) assert.ok([...card.querySelectorAll("button")].some((el) => el.textContent === b), b);
  // A model it serves but doesn't use stays under Edit; the card counts it.
  const unused = status();
  unused.systems[0].models.push({ name: "kimi-k3:cloud", workers: 1, context: 32768, use: false, subagents: "not for sub-agents: not used" });
  x.message({ type: "routerStatus", status: unused });
  const gpu = x.d.querySelector("[data-router-system=gpu]");
  assert.equal([...gpu.querySelectorAll(".router-model-name")].some((el) => /kimi/.test(el.textContent)), false);
  assert.ok([...gpu.querySelectorAll(".router-line")].some((el) => el.textContent === "1 more model not used (Edit to choose)."));
  const nas = [...x.d.querySelectorAll("[data-router-system=nas] .router-line")].map((el) => el.textContent);
  assert.ok(nas.includes("Total: 2 × 16K = 32K context · server: 2 slots of 16K ✓"), `the server's own room check: ${nas}`);
});

test("the list follows router_changed live, and a form being typed in keeps what was typed", async () => {
  const x = setup();
  await x.settle();
  x.click("[data-router-edit=gpu]");
  const name = x.d.querySelector("[data-router-system=gpu] [data-edit=name]");
  name.value = "Spark";
  const busy = status();
  busy.systems[1].free = 0; busy.systems[1].leases = [{ owner: "Pip run r1", label: "Pip Inbox", model: "qwen3:4b" }];
  busy.systems[0].free = 1;
  x.message({ type: "routerStatus", status: busy });
  assert.match(x.d.querySelector("[data-router-system=nas]").textContent, /0 of 2 workers free/);
  assert.match(x.d.querySelector("[data-router-system=nas]").textContent, /Working: qwen3:4b for Pip Inbox/);
  assert.equal(x.d.querySelector("[data-router-system=gpu] [data-edit=name]").value, "Spark", "the draft survives the redraw");
  assert.equal(x.d.getElementById("router-subagents-line").textContent, "Chosen by DGC Router · 1 system · 1 worker free");
});

test("Edit sends exactly the changes, a key once, and a hardware address with its token", async () => {
  const x = setup();
  await x.settle();
  x.click("[data-router-edit=gpu]");
  const form = () => x.d.querySelector("[data-router-system=gpu]");
  const set = (sel, value) => { const el = form().querySelector(sel); if (typeof value === "boolean") el.checked = value; else el.value = value; };
  set("[data-edit=name]", "Spark");
  set("[data-edit=job][value=pips]", false);
  set("[data-model-row='1'] [data-edit=workers]", "2");
  set("[data-model-row='0'] [data-edit=note]", "design, debugging");
  set("[data-edit=key]", "sk-local-1");
  set("[data-edit=hw-url]", "http://gpu-box.local:9100/metrics");
  // Another model it serves, added from the list (embedding models are never offered).
  const offer = form().querySelector("[data-edit=offer]");
  assert.deepEqual([...offer.options].map((o) => o.value), ["", "llama3.1:8b"]);
  offer.value = "llama3.1:8b";
  offer.dispatchEvent(new x.w.Event("change"));
  form().querySelector("[data-router-edit-save=gpu]").click();
  for (let i = 0; i < 10; i++) await x.settle();
  assert.deepEqual(x.routerSent().slice(1), [
    { type: "router_update", action: "edit_system", system: "gpu", name: "Spark" },
    { type: "router_update", action: "set_jobs", system: "gpu", jobs: ["subagents"] },
    { type: "router_update", action: "set_model", system: "gpu", model: "qwen3.8:32b", note: "design, debugging" },
    { type: "router_update", action: "set_model", system: "gpu", model: "qwen3:8b", workers: 2 },
    { type: "router_update", action: "set_model", system: "gpu", model: "llama3.1:8b", use: true, workers: 1, context: 32768 },
    { type: "router_update", action: "set_key", system: "gpu", key: "sk-local-1" },
    { type: "router_hardware", system: "gpu", url: "http://gpu-box.local:9100/metrics" }]);
  assert.equal(x.d.querySelector("[data-router-system=gpu] .router-form"), null, "Save closes the form");
  assert.doesNotMatch(x.d.body.innerHTML, /sk-local-1/, "the key is never drawn again");
});

test("a model's Thinking: a choice only for a model that can think, its own command, and nothing from an older CLI", async () => {
  const thinking = status();
  thinking.systems[0].models[0] = { ...thinking.systems[0].models[0], thinks: true, thinking: "low" };
  thinking.systems[0].models[1] = { ...thinking.systems[0].models[1], thinks: false };
  const x = setup({ routerStatus: thinking, extra: { router_thinking: true } });
  await x.settle();
  const card = () => x.d.querySelector("[data-router-system=gpu]");
  const cells = [...card().querySelectorAll(".router-model:not(.head) [data-label=Thinking]")].map((c) => c.textContent);
  assert.deepEqual(cells, ["Low", "doesn't think"], "the card says each model's choice");
  x.click("[data-router-edit=gpu]");
  const form = () => x.d.querySelector("[data-router-system=gpu]");
  const pick = form().querySelector("[data-model-row='0'] [data-edit=thinking]");
  assert.deepEqual([...pick.options].map((o) => o.textContent), ["Same as the helper", "Off", "Low", "Medium", "High"]);
  assert.equal(pick.value, "low");
  assert.equal(form().querySelector("[data-model-row='1'] [data-edit=thinking]"), null, "nothing to choose for a model that can't think");
  assert.equal(form().querySelector("[data-model-row='1'] .router-no-think").textContent, "doesn't think");
  pick.value = "off";
  form().querySelector("[data-router-edit-save=gpu]").click();
  for (let i = 0; i < 10; i++) await x.settle();
  assert.deepEqual(x.routerSent().slice(1), [{ type: "router_thinking", system: "gpu", model: "qwen3.8:32b", thinking: "off" }]);
  // An older CLI: no column, nothing sent for it.
  const older = setup({ routerStatus: thinking });
  await older.settle();
  assert.equal(older.d.querySelector("[data-label=Thinking]"), null);
  assert.ok(helpers.thinkingWords({ thinks: true }) === "Same as the helper" && helpers.thinkingWords({}) === "Not known yet");
});

test("Sub-agents → Thinking: Same as the main chat by default, saved with Save all, and only from a CLI that answers it", async () => {
  for (const routed of [false, true]) {
    const x = setup({ routerStatus: status({ enabled: routed }), extra: { subagent_thinking_settable: true, subagent_thinking: "" } });
    await x.settle();
    const pick = x.d.querySelector("#subagent_thinking");
    assert.ok(pick, `the field is there (Router ${routed ? "on" : "off"})`);
    assert.deepEqual([...pick.options].map((o) => o.textContent), ["Same as the main chat", "Off", "Low", "Medium", "High", "Extra high"]);
    assert.equal(pick.value, "");
    assert.ok(pick.closest("#models-subagents"), "under Sub-agents");
  }
  const older = setup();
  await older.settle();
  assert.equal(older.d.querySelector("#subagent_thinking"), null, "an older CLI: no field");
});

test("+ Add system: find its models, not used until Save; Cancel takes it back out", async () => {
  const added = status();
  added.systems.push({ id: "mac", name: "Mac", base_url: "http://mac.local:1234", server: "lmstudio", enabled: true, jobs: ["subagents", "pips"],
    workers: 1, free: 1, health: { state: "unknown" }, leases: [], models: [{ name: "qwen3.6:35b-a3b", workers: 1, context: 32768 }],
    available: [{ name: "qwen3.6:35b-a3b" }] });
  const x = setup({ answers: { "router_update:add_system": { status: added, change: "Add Mac (lmstudio at http://mac.local:1234)" } } });
  await x.settle();
  x.click("[data-router-add]");
  x.d.getElementById("router-add-address").value = "mac.local:1234";
  x.d.getElementById("router-add-name").value = "Mac";
  x.click("[data-router-add-look]");
  for (let i = 0; i < 10; i++) await x.settle();
  assert.deepEqual(x.routerSent().slice(1, 3), [
    { type: "router_update", action: "add_system", base_url: "mac.local:1234", jobs: [], name: "Mac" },
    { type: "router_update", action: "disable_system", system: "mac" }]);
  const form = x.d.querySelector("[data-router-system=mac] .router-form");
  assert.ok(form, "the new system opens in its form");
  assert.match(form.textContent, /Found LM Studio at mac\.local:1234\. Choose its models and jobs, then Test and Save\./);
  form.querySelector("[data-router-edit-cancel=mac]").click();
  for (let i = 0; i < 10; i++) await x.settle();
  assert.deepEqual(x.routerSent().at(-1), { type: "router_update", action: "remove_system", system: "mac" });
});

test("a server that wants a key: the form asks for it first, then lists its models", async () => {
  const added = status();
  added.systems.push({ id: "box", name: "box", base_url: "https://box.example/v1", server: "openai_compatible", enabled: true, jobs: ["subagents"],
    workers: 1, free: 1, health: { state: "unknown" }, leases: [], models: [], has_key: false });
  const read = JSON.parse(JSON.stringify(added));
  read.systems.at(-1).available = [{ name: "big-model", context_max: 131072 }];
  const x = setup({ answers: {
    "router_update:add_system": { status: added, change: "Add box. It wants a key: ask the user to paste it in Settings." },
    "router_probe": { status: read, probe: { system: "box", models: 1, results: {} } } } });
  await x.settle();
  x.click("[data-router-add]");
  x.d.getElementById("router-add-address").value = "https://box.example/v1";
  x.click("[data-router-add-look]");
  for (let i = 0; i < 10; i++) await x.settle();
  const form = () => x.d.querySelector("[data-router-system=box] .router-form");
  assert.match(form().querySelector(".router-field.wants").textContent, /this server wants one/);
  form().querySelector("[data-edit=key]").value = "sk-box";
  form().querySelector("[data-router-key=box]").click();
  for (let i = 0; i < 10; i++) await x.settle();
  assert.deepEqual(x.routerSent().slice(-2), [
    { type: "router_update", action: "set_key", system: "box", key: "sk-box" },
    { type: "router_probe", system: "box", checks: ["models"] }]);
  assert.equal(form().querySelector("[data-model-row='0'] [data-edit=use]").checked, true, "its chat model, ready to use");
  assert.match(form().textContent, /Key saved\. It serves 1 model\./);
});

test("Test shows what was measured; Suggest shows the arithmetic and Apply uses it", async () => {
  const x = setup({ answers: {
    "router_probe": { probe: { system: "gpu", results: { "qwen3.8:32b": { speed: { ok: true, tokens_per_s: 40, ttft_ms: 300 }, parallel: { ok: true, runs: 2 }, tools: { ok: false } } } } },
    "router_suggest": { suggestion: { applicable: true, models: [{ name: "qwen3:8b", workers: 4, line: "qwen3:8b: 8.2B Q4 ≈ 4.9 GB + 4 × 32K context ≈ 9 GB → 4 workers fit in 128 GB" }] } },
    "router_update:apply_suggestion": { change: "Use the suggestion for GPU box: qwen3:8b 4 workers." } } });
  await x.settle();
  x.click("[data-router-test=gpu]");
  for (let i = 0; i < 5; i++) await x.settle();
  assert.match(x.d.querySelector("[data-router-system=gpu] .router-result").textContent,
    /qwen3\.8:32b: 40 tok\/s, first token in 300 ms · runs 2 at once · tool calls ✗ \(kept away from sub-agents\)/);
  x.click("[data-router-suggest=gpu]");
  for (let i = 0; i < 5; i++) await x.settle();
  assert.match(x.d.querySelector("[data-router-system=gpu] .router-suggest").textContent, /4 × 32K context ≈ 9 GB → 4 workers fit in 128 GB/);
  x.click("[data-router-apply=gpu]");
  for (let i = 0; i < 5; i++) await x.settle();
  assert.deepEqual(x.routerSent().slice(-3), [{ type: "router_probe", system: "gpu" }, { type: "router_suggest", system: "gpu" },
    { type: "router_update", action: "apply_suggestion", system: "gpu" }]);
  assert.match(x.d.querySelector("[data-router-system=gpu]").textContent, /Use the suggestion for GPU box/);
});

// The card said "Last test (just now)" 2.5 minutes after the test: its words were drawn once and nothing redrew them.
test("Last test says how long ago, and keeps saying it while Settings is open", async () => {
  const ticks = [];
  let shift = 0;
  const x = setup({ beforeEval: (w) => {
    w.setInterval = (fn, ms) => { ticks.push([fn, ms]); return ticks.length; };
    w.clearInterval = () => {};
    const now = w.Date.now.bind(w.Date);
    w.Date.now = () => now() + shift;
  } });
  await x.settle();
  const line = () => [...x.d.querySelectorAll("[data-router-system=gpu] .router-line")].map((el) => el.textContent).find((t) => t.startsWith("Last test"));
  assert.match(line(), /^Last test \(just now\): 41\.2 tok\/s/);
  assert.equal(ticks.length, 1, "one clock for the page");
  assert.ok(ticks[0][1] <= 30000);
  const name = x.d.querySelector("[data-router-system=gpu] .router-name");
  shift = 130_000;                                     // 20 s after the test, then 2 min 10 s later
  ticks[0][0]();
  assert.match(line(), /^Last test \(2 min ago\): /);
  assert.equal(x.d.querySelector("[data-router-system=gpu] .router-name"), name, "only the words changed: nothing was redrawn");
  shift = 3 * 3600_000;
  ticks[0][0]();
  assert.match(line(), /^Last test \(3 h ago\): /);
  assert.deepEqual([60, 119, 120].map((s) => { shift = 0; return helpers.ago(Date.now() / 1000 - s); }), ["1 min ago", "1 min ago", "2 min ago"]);
  assert.equal(helpers.ago(Date.now() / 1000 - 59), "just now");
});

test("Look on my network asks first and looks only when told; what it finds can be added", async () => {
  const x = setup({ answers: { "router_find": { found: { network: "10.0.0.0/24", ports: [11434], found: [
    { base_url: "http://10.0.0.7:11434", server: "ollama", version: "0.30.6" }, { base_url: "http://gpu-box.local:11434", server: "ollama" }] } } } });
  await x.settle();
  x.click("[data-router-find]");
  assert.equal(x.routerSent().some((c) => c.type === "router_find"), false, "nothing is looked at yet");
  assert.match(x.d.querySelector("[data-router-finding]").textContent, /Look for model servers on this computer's network\?/);
  x.click("[data-router-find-yes]");
  for (let i = 0; i < 5; i++) await x.settle();
  const found = [...x.d.querySelectorAll("[data-router-finding] li")].map((li) => li.textContent);
  assert.deepEqual(found, ["Ollama 0.30.6 · 10.0.0.7:11434Add", "Ollama · gpu-box.local:11434Added as GPU box"]);
  x.click("[data-router-found='http://10.0.0.7:11434']");
  assert.equal(x.d.getElementById("router-add-address").value, "http://10.0.0.7:11434", "Add starts with its address");
});

test("When all are busy and Remove each make one change, Remove only after it is confirmed", async () => {
  const x = setup();
  await x.settle();
  const other = x.d.querySelector("input[name=router-when-busy][value=default]");
  other.checked = true;
  other.dispatchEvent(new x.w.Event("change"));
  await x.settle();
  assert.deepEqual(x.routerSent().at(-1), { type: "router_update", action: "set_when_busy", when_busy: "default" });
  x.click("[data-router-remove=nas]");
  assert.match(x.d.querySelector("[data-router-system=nas] .router-confirm").textContent, /Remove NAS\? Its saved key goes too\./);
  assert.deepEqual([...x.d.querySelectorAll("[data-router-system=nas] button")].map((b) => b.textContent), ["Remove", "Keep it"],
    "one Remove, in the question");
  assert.notEqual(x.routerSent().at(-1).action, "remove_system");
  x.click("[data-router-remove-yes=nas]");
  await x.settle();
  assert.deepEqual(x.routerSent().at(-1), { type: "router_update", action: "remove_system", system: "nas" });
});

test("DGC Router Settings (the palette, the status line) shows the Router block on a fresh tab, and keeps it there while Models fills in", async () => {
  const scrolled = [];
  const x = setup({ place: "router", showFirst: true, images: true, scrolled });
  await x.settle();
  assert.ok(scrolled.includes("models-router"), "drawn once DGC's settings arrived: scrolled to DGC Router");
  const before = scrolled.length;
  // The Images list arrives after: the Router block moves down, and is brought back to the top.
  x.message({ type: "imagesReply", token: "images-1", ok: true, status: { generators: [], default: "", auto_fallback: false, save_dir: "assets/generated", project_choice: "", chosen: "", through_plugins: [] } });
  await x.settle();
  assert.ok(scrolled.length > before && scrolled.at(-1) === "models-router");
  // Once the person scrolls, it stays where they put it.
  x.d.dispatchEvent(new x.w.Event("wheel"));
  const settled = scrolled.length;
  x.message({ type: "routerStatus", status: status() });
  await x.settle();
  assert.equal(scrolled.length, settled);
  // From another page of an open tab, too.
  x.message({ type: "show", section: "general" });
  x.message({ type: "show", section: "router" });
  await x.settle();
  assert.equal(scrolled.at(-1), "models-router");
});

test("the Pips default on the Router is saved with Save all, and kept while the Router is off", async () => {
  const x = setup();
  await x.settle();
  const pips = x.d.getElementById("pips_model");
  pips.value = "router:nas/qwen3:4b";
  pips.dispatchEvent(new x.w.Event("input", { bubbles: true }));
  x.click("#save");
  assert.equal(x.sent.filter((m) => m.type === "saveSettings").pop().values.pips_model, "router:nas/qwen3:4b");
  x.message({ type: "settingsSaved", ok: true });
  // The Router goes off: the box shows DGC's own and keeps the Router choice unless something else is typed.
  x.message({ type: "event", event: { ...x.config, pips_model: "router:nas/qwen3:4b" } });
  x.message({ type: "routerStatus", status: status({ enabled: false }) });
  const box = x.d.getElementById("pips_model");
  assert.equal(box.tagName, "INPUT");
  assert.equal(box.value, "");
  x.d.getElementById("max_parallel_tasks").value = "6";
  x.d.getElementById("max_parallel_tasks").dispatchEvent(new x.w.Event("input", { bubbles: true }));
  x.click("#save");
  const saved = x.sent.filter((m) => m.type === "saveSettings").pop().values;
  assert.equal(saved.pips_model, "router:nas/qwen3:4b");
});

test("the arithmetic helpers", () => {
  const { totalContext, totalLine, roomCheck, sizeWords, testWords } = helpers;
  const sys = { workers: 4, one_model_at_a_time: false, models: [{ name: "a", workers: 3, context: 65536 }, { name: "b", workers: 4, context: 32768 }] };
  assert.equal(totalLine(totalContext(sys)), "Total: 3 × 64K + 1 × 32K = 224K context", "the system's 4 workers, largest contexts first");
  assert.equal(totalLine(totalContext({ ...sys, one_model_at_a_time: true })), "Total: 3 × 64K = 192K context", "one model at a time: the most any one model holds");
  assert.equal(totalLine(totalContext({ workers: 1, models: [{ workers: 1, context: 8192 }] })), "Total: 1 × 8K context");
  assert.deepEqual(roomCheck({ server_kv_tokens: 200000 }, totalContext(sys)), { ok: false, text: "server holds 195K of context ✗" });
  assert.deepEqual(roomCheck({ server_slots: 4, server_slot_context: 65536 }, totalContext(sys)), { ok: true, text: "server: 4 slots of 64K ✓" });
  assert.equal(roomCheck({}, totalContext(sys)), null, "Ollama says nothing: Test measures it");
  assert.equal(sizeWords({ params_b: 9.7, quant: "Q4_K_M" }), "9.7B Q4");
  assert.equal(sizeWords({ params_b: 32.4, cloud: true }), "32B cloud");
  assert.equal(testWords({ tools: true }), "", "a server that says a model calls tools is no test");
  assert.equal(testWords({ tokens_per_s: 12.34, parallel: 1, tools: false, speed_at: 1 }), "12.3 tok/s · 1 at once · tool calls ✗");
});


test("adding a discovered thinking model keeps its capability and selected level", async () => {
  const discovered = status();
  discovered.systems[0].available.push({ name: "reasoner", thinks: true, thinking: "high", tools: true });
  const x = setup({ routerStatus: discovered, extra: { router_thinking: true } });
  await x.settle();
  x.click("[data-router-edit=gpu]");
  const offer = x.d.querySelector('[data-router-system="gpu"] [data-edit="offer"]');
  offer.value = "reasoner";
  offer.dispatchEvent(new x.w.Event("change", { bubbles: true }));
  const row = x.d.querySelector('[data-model-name="reasoner"]');
  const thinking = row.querySelector('[data-edit="thinking"]');
  assert.ok(thinking, "a discovered thinking model offers the selector immediately");
  assert.equal(thinking.value, "high");
  thinking.value = "low";
  thinking.dispatchEvent(new x.w.Event("input", { bubbles: true }));
  x.click("[data-router-edit-save=gpu]");
  for (let i = 0; i < 10; i++) await x.settle();
  assert.ok(x.routerSent().some((c) => c.type === "router_thinking" && c.model === "reasoner" && c.thinking === "low"));
});

test("offered model drafts preserve true, false and unknown thinking capability", () => {
  const rows = helpers.offeredRows([{ name: "yes", thinks: true, thinking: "medium" },
    { name: "no", thinks: false }, { name: "unknown" }], "ollama");
  assert.deepEqual(rows.map((m) => [m.thinks, m.thinking]), [[true, "medium"], [false, ""], [undefined, ""]]);
  assert.equal(helpers.thinkingWords(rows[0]), "Medium");
  assert.equal(helpers.thinkingWords(rows[1]), "doesn't think");
  assert.equal(helpers.thinkingWords(rows[2]), "Not known yet");
});
