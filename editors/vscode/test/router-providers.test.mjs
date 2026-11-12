// Settings -> Models -> DGC Router, 0.52: one of your saved providers as a Router system, and what a model costs.
// + Add system offers "A computer on your network" (as before) and "One of your providers" when the CLI takes one
// (ready.capabilities.router.providers, with saved_model_providers) and a provider is saved; a provider's models are
// listed to tick (its own ticked), with Workers and jobs; Add sends add_system {provider, models, jobs: []} and the new
// system stays unused until Save. Its card says "Your provider · Groq", has no key field, and says whose key it uses.
// A model row says its price quietly; its edit row takes the person's own (router.prices). Without the capabilities:
// nothing of this is shown and nothing is sent. No key is ever in the page.
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

const GROQ = "provider_" + "a".repeat(32), OPENROUTER = "provider_" + "b".repeat(32);
const PROFILES = [
  { id: GROQ, name: "Groq", base_url: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile", api_mode: "chat_completions" },
  { id: OPENROUTER, name: "OpenRouter", base_url: "https://openrouter.ai/api/v1", model: "", api_mode: "chat_completions" },
  { id: "subscription_claude", kind: "subscription", engine: "claude", name: "Claude Code", model: "sonnet" }];
const gpu = () => ({ id: "gpu", name: "GPU box", base_url: "http://gpu-box.local:11434", server: "ollama", enabled: true, jobs: ["subagents", "pips"],
  workers: 2, busy: 0, free: 2, one_model_at_a_time: false, health: { state: "online" }, has_key: false, leases: [],
  models: [{ name: "qwen3:8b", workers: 2, free: 2, context: 32768 }], available: [{ name: "qwen3:8b" }] });
const groq = (over = {}) => ({ id: "groq", name: "Groq", base_url: "https://api.groq.com/openai", server: "openai_compatible", provider: GROQ,
  enabled: true, jobs: ["subagents", "pips"], workers: 3, busy: 0, free: 3, one_model_at_a_time: false, health: { state: "online" },
  has_key: true, leases: [], models: [
    { name: "llama-3.3-70b-versatile", workers: 1, free: 1, context: 32768, price_in: 0.59, price_out: 0.79, price_from: "provider" },
    { name: "qwen/qwen3-32b", workers: 1, free: 1, context: 32768, price_in: 0.5, price_out: 0.6, price_from: "you" },
    { name: "free/model", workers: 1, free: 1, context: 32768, price_in: 0, price_out: 0, price_from: "provider" },
    { name: "plain-model", workers: 1, free: 1, context: 32768 }],
  available: [{ name: "llama-3.3-70b-versatile", price_in: 0.59, price_out: 0.79 }, { name: "qwen/qwen3-32b", price_in: 0.29, price_out: 0.59 },
    { name: "free/model", price_in: 0, price_out: 0 }, { name: "plain-model" }, { name: "tiny/model", price_in: 0.005, price_out: 0.02 }], ...over });
const status = (...systems) => ({ enabled: true, when_busy: "wait", workers: { total: 2, free: 2, busy: 0 }, systems: systems.length ? systems : [gpu()] });

function setup({ routerStatus = status(), answers = {}, providers = true, prices = true, profiles = PROFILES } = {}) {
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
  message({ type: "event", event: { type: "config", base_url: "https://model.example/v1", model: "main-model", mode: "default", pips_settable: true,
    pips_model: "", subagent_model: "agent", max_parallel_tasks: 4, router_capable: true, router_pips_default: true,
    ...(providers ? { router_providers: true } : {}), ...(prices ? { router_prices: true } : {}) } });
  message({ type: "show", section: "models" });
  message({ type: "providerProfiles", profiles, defaultId: profiles[0]?.id || "" });
  const settle = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 5)); };
  return { w, d: w.document, sent, message, settle,
    routerSent: () => JSON.parse(JSON.stringify(sent.filter((m) => m.type === "routerCommand").map((m) => m.command))),
    click: (s) => w.document.querySelector(s).click(), q: (s) => w.document.querySelector(s), all: (s) => [...w.document.querySelectorAll(s)] };
}
const type = (x, el, value) => { el.value = value; el.dispatchEvent(new x.w.Event("input", { bubbles: true })); };

test("the words a price is said in: dollars per million tokens, Free for 0, nothing when unknown", () => {
  assert.equal(helpers.priceWords({ price_in: 0.59, price_out: 0.79 }), "$0.59 in · $0.79 out per million tokens");
  assert.equal(helpers.priceWords({ price_in: 0, price_out: 0 }), "Free", "0 is a price");
  assert.equal(helpers.priceWords({ price_in: 0.005, price_out: 0.02 }), "$0.005 in · $0.02 out per million tokens", "a tiny price keeps its digits");
  assert.equal(helpers.priceWords({ price_in: 12, price_out: 1500 }), "$12.00 in · $1,500.00 out per million tokens");
  assert.equal(helpers.priceWords({ price_in: 0.5 }), "$0.50 in per million tokens", "only one side known");
  for (const none of [{}, null, { price_in: "0.5" }, { price_in: -1, price_out: -1 }, { price_in: NaN }]) assert.equal(helpers.priceWords(none), "");
});

test("+ Add system asks which: a computer on your network, or one of your providers", async () => {
  const x = setup();
  await x.settle();
  x.click("[data-router-add]");
  assert.deepEqual(x.all("[data-router-add-way] .router-way-name").map((b) => b.textContent), ["A computer on your network", "One of your providers"]);
  assert.equal(x.q("#router-add-address"), null, "the address is asked after the choice");
  x.click("[data-router-add-way=computer]");
  assert.ok(x.q("#router-add-address"), "today's form");
  assert.ok(x.q("[data-router-add-look]"));
  x.click("[data-router-add-back]");
  x.click("[data-router-add-way=providers]");
  const rows = x.all(".router-providers li");
  assert.deepEqual(rows.map((li) => li.querySelector("b").textContent), ["Groq", "OpenRouter"], "the saved providers by name, never a subscription");
  assert.doesNotMatch(x.q("[data-router-adding]").textContent, /Claude Code/);
  x.click("[data-router-add-cancel]");
  assert.equal(x.q("[data-router-adding]"), null);
  assert.equal(x.routerSent().length, 1, "nothing was sent but the first status read");
});

test("without the capability, or with no provider saved, Add is today's form and nothing more", async () => {
  for (const [why, opts] of [["an older CLI", { providers: false }], ["no provider saved", { profiles: [] }],
    ["only a subscription saved", { profiles: [PROFILES[2]] }]]) {
    const x = setup(opts);
    await x.settle();
    x.click("[data-router-add]");
    assert.equal(x.q("[data-router-add-way]"), null, why);
    assert.ok(x.q("#router-add-address"), why);
    assert.equal(x.q("[data-router-add-back]"), null, `${why}: nothing to go back to`);
  }
  // From Look on my network the address is known: that is a computer, no question.
  const x = setup({ answers: { router_find: { found: { network: "10.0.0.0/24", found: [{ base_url: "http://10.0.0.9:11434", server: "ollama" }] } } } });
  await x.settle();
  x.click("[data-router-find]"); x.click("[data-router-find-yes]");
  await x.settle();
  x.click("[data-router-found]");
  assert.equal(x.q("[data-router-add-way]"), null);
  assert.equal(x.q("#router-add-address").value, "http://10.0.0.9:11434");
});

test("a provider: its models to tick (its own ticked), Workers 2, its jobs; Add sends the provider's id, never used until Save", async () => {
  const added = status(gpu(), groq({ jobs: [], workers: 4, models: [
    { name: "llama-3.3-70b-versatile", workers: 1, context: 32768 }, { name: "qwen/qwen3-32b", workers: 1, context: 32768 }] }));
  const x = setup({ answers: {
    router_provider_models: { models: ["qwen/qwen3-32b", "llama-3.3-70b-versatile", "whisper-large-v3"] },
    "router_update:add_system": { status: added, change: "Add Groq" },
    "router_update:disable_system": (_c, now) => ({ status: { ...now, systems: now.systems.map((s) => (s.id === "groq" ? { ...s, enabled: false } : s)) } }) } });
  await x.settle();
  x.click("[data-router-add]"); x.click("[data-router-add-way=providers]");
  x.click(`[data-router-add-provider="${GROQ}"]`);
  assert.match(x.q("[data-router-adding]").textContent, /Listing its models…/);
  assert.equal(x.q("[data-router-add-provider-go]").disabled, true, "nothing to add until its models are listed");
  await x.settle();
  assert.deepEqual(x.routerSent().at(-1), { type: "router_provider_models", provider: GROQ });
  const picks = () => x.all("[data-router-adding] .router-pick").map((l) => [l.textContent.trim(), l.querySelector("input").checked]);
  assert.deepEqual(picks(), [["llama-3.3-70b-versatile", true], ["qwen/qwen3-32b", false], ["whisper-large-v3", false]],
    "the provider's own model first and ticked, the rest unticked");
  assert.equal(x.q("#router-add-workers").value, "2");
  assert.deepEqual(x.all("[data-add-job]").map((b) => [b.value, b.checked]), [["subagents", true], ["pips", true]]);
  assert.match(x.q("[data-router-adding]").textContent, /Uses the key saved with Groq in Settings → Models/);
  assert.equal(x.q("[data-router-adding] input[type=password]"), null, "no key is asked for");
  // Untick everything: said, nothing sent.
  x.q("[data-pick='0']").checked = false;
  x.click("[data-router-add-provider-go]");
  assert.match(x.q("[data-router-adding] .router-note.error").textContent, /Tick at least one model/);
  x.q("[data-pick='0']").checked = true; x.q("[data-pick='1']").checked = true;
  x.q("#router-add-workers").value = "4";
  x.q("[data-add-job][value=pips]").checked = false;
  x.click("[data-router-add-provider-go]");
  await x.settle();
  assert.deepEqual(x.routerSent().slice(-3), [
    { type: "router_update", action: "add_system", provider: GROQ, models: ["llama-3.3-70b-versatile", "qwen/qwen3-32b"], jobs: [], workers: 4 },
    { type: "router_update", action: "disable_system", system: "groq" },
    { type: "router_probe", system: "groq", checks: ["models"] }], "added with no jobs, not used, then its own model list read (prices)");
  const form = x.q("[data-router-system=groq] .router-form");
  assert.ok(form, "the new system opens in its form");
  assert.match(form.textContent, /Added from Groq\. Check its models and jobs, then Test and Save\./);
  assert.deepEqual([...form.querySelectorAll("[data-edit=job]")].map((b) => [b.value, b.checked]), [["subagents", true], ["pips", false]],
    "the jobs ticked while adding are ticked here");
  assert.match(form.querySelector("[data-model-row='0'] [data-price-row]").textContent, /Its list says: \$0\.59 in · \$0\.79 out per million tokens/,
    "what the provider's list says each chosen model costs");
  assert.match([...form.querySelector("[data-edit=offer]").options].map((o) => o.textContent).join("|"), /tiny\/model · \$0\.005 in · \$0\.02 out per million tokens/,
    "and each model still to choose");
  form.querySelector("[data-router-edit-save=groq]").click();
  await x.settle();
  assert.deepEqual(x.routerSent().slice(-2), [
    { type: "router_update", action: "set_jobs", system: "groq", jobs: ["subagents"] },
    { type: "router_update", action: "enable_system", system: "groq" }], "Save gives it its jobs and puts it to use");
  assert.doesNotMatch(JSON.stringify(x.sent), /api_key|"key"/, "no key leaves the page: it has none");
});

test("a provider that fails to add says why and stays; one already added isn't offered twice", async () => {
  const x = setup({ routerStatus: status(gpu(), groq()), answers: {
    router_provider_models: { models: ["a/model"], error: "the host refused the key" },
    "router_update:add_system": { ok: false, error: "Choose a model for this provider." } } });
  await x.settle();
  x.click("[data-router-add]"); x.click("[data-router-add-way=providers]");
  const rows = x.all(".router-providers li");
  assert.match(rows[0].textContent, /Groq.*Added as Groq/);
  assert.equal(rows[0].querySelector("button"), null);
  x.click(`[data-router-add-provider="${OPENROUTER}"]`);
  await x.settle();
  assert.match(x.q("[data-router-adding]").textContent, /DGC couldn't list all its models: the host refused the key/);
  assert.equal(x.q("[data-pick='0']").checked, false, "an All models provider has no model of its own: none is ticked");
  x.q("[data-pick='0']").checked = true;
  x.click("[data-router-add-provider-go]");
  await x.settle();
  assert.equal(x.q("[data-router-adding] .router-note.error").textContent, "Choose a model for this provider.");
  assert.equal(x.q("[data-pick='0']").checked, true, "what was ticked is kept");
});

test("a provider's card: Your provider · Groq, whose key it uses, what Test costs, and no key field in its form", async () => {
  const x = setup({ routerStatus: status(gpu(), groq(), { ...groq({ has_key: false }), id: "openrouter", name: "OR", provider: OPENROUTER }) });
  await x.settle();
  const card = (id) => x.q(`[data-router-system=${id}]`);
  assert.equal(card("groq").querySelector(".router-where").textContent, "Your provider · Groq");
  assert.doesNotMatch(card("groq").querySelector(".router-card-head").textContent, /api\.groq\.com/, "no address");
  assert.equal(card("groq").querySelector("[data-router-key-line]").textContent, "Uses the key saved with Groq in Settings → Models.");
  assert.equal(card("groq").querySelector("[data-router-test-line]").textContent, "Test sends a few short requests to Groq (billed by them).");
  assert.ok(card("groq").querySelector("[data-router-test=groq]"), "Test stays");
  assert.equal(card("groq").querySelector("[data-router-suggest]"), null, "nothing to fit into a memory");
  assert.equal(card("openrouter").querySelector(".router-where").textContent, "Your provider · OpenRouter", "the provider's saved name");
  assert.equal(card("openrouter").querySelector("[data-router-key-line=missing]").textContent, "OpenRouter has no key saved: add it in Settings → Models.");
  assert.equal(card("gpu").querySelector(".router-where").textContent, "Ollama · gpu-box.local:11434", "a computer's card is as before");
  assert.equal(card("gpu").querySelector("[data-router-key-line]"), null);
  assert.ok(card("gpu").querySelector("[data-router-suggest]"));
  x.click("[data-router-edit=groq]");
  const form = card("groq").querySelector(".router-form");
  for (const gone of ["[data-edit=key]", "[data-edit=base_url]", "[data-edit=hw-url]", "[data-edit=hw-token]", "[data-edit=memory]", "[data-edit=one]"]) {
    assert.equal(form.querySelector(gone), null, `${gone}: a computer's field, not a provider's`);
  }
  assert.match(form.textContent, /Uses the key saved with Groq in Settings → Models\./);
  assert.match(form.textContent, /Test sends a few short requests to Groq \(billed by them\)\./);
  form.querySelector("[data-edit=name]").value = "Groq fast";
  form.querySelector("[data-router-edit-save=groq]").click();
  await x.settle();
  assert.deepEqual(x.routerSent().at(-1), { type: "router_update", action: "edit_system", system: "groq", name: "Groq fast" });
  x.click("[data-router-remove=groq]");
  assert.match(card("groq").querySelector(".router-confirm").textContent, /Remove Groq from DGC Router\? Groq and its key stay in Settings → Models\./);
  x.click("[data-router-edit=gpu]");
  assert.ok(card("gpu").querySelector("[data-edit=key]"), "a computer keeps its key field");
});

test("each model row says its price quietly: the provider's, the person's own, Free, or nothing", async () => {
  const x = setup({ routerStatus: status(gpu(), groq()) });
  await x.settle();
  const rows = x.all("[data-router-system=groq] .router-models > .router-model:not(.head)");
  assert.deepEqual(rows.map((r) => r.querySelector(".router-price")?.textContent ?? null), [
    "$0.59 in · $0.79 out per million tokens", "$0.50 in · $0.60 out per million tokens", "Free", null]);
  assert.equal(x.q("[data-router-system=gpu] .router-price"), null, "a model with no price says nothing");
});

test("a model's edit row takes the person's own price; the provider's is its placeholder; both emptied goes back to it", async () => {
  const x = setup({ routerStatus: status(gpu(), groq()) });
  await x.settle();
  x.click("[data-router-edit=groq]");
  const row = (i) => x.q(`[data-router-system=groq] [data-model-row='${i}']`);
  const box = (i, side) => row(i).querySelector(`[data-edit=price-${side}]`);
  assert.match(row(0).querySelector("[data-price-row]").textContent, /Price \(per million tokens\):\s*In\s*Out/);
  assert.deepEqual([box(0, "in").value, box(0, "in").placeholder, box(0, "out").value, box(0, "out").placeholder], ["", "0.59", "", "0.79"],
    "the provider's price is the placeholder, never the value");
  assert.deepEqual([box(1, "in").value, box(1, "in").placeholder, box(1, "out").value, box(1, "out").placeholder], ["0.5", "0.29", "0.6", "0.59"],
    "the person's own price in the boxes, the provider's behind it");
  assert.deepEqual([box(3, "in").placeholder, box(3, "out").placeholder], ["", ""], "no listed price: no placeholder");
  // A word instead of a price: said, nothing sent.
  const before = x.routerSent().length;
  box(0, "in").value = "cheap";
  x.click("[data-router-edit-save=groq]");
  await x.settle();
  assert.match(x.q("[data-router-system=groq] .router-note.error").textContent, /Price for llama-3\.3-70b-versatile takes US dollars per million tokens/);
  assert.equal(x.routerSent().length, before);
  box(0, "in").value = "0.4"; box(0, "out").value = "$0.7";      // a price of the person's own
  box(1, "in").value = ""; box(1, "out").value = "";             // both emptied: back to the provider's
  box(2, "in").value = ""; box(2, "out").value = "";             // was never theirs: nothing to say
  box(3, "in").value = "0"; box(3, "out").value = "0";           // free is a price
  x.click("[data-router-edit-save=groq]");
  await x.settle();
  assert.deepEqual(x.routerSent().slice(before), [
    { type: "router_update", action: "set_model", system: "groq", model: "llama-3.3-70b-versatile", price_in: 0.4, price_out: 0.7 },
    { type: "router_update", action: "set_model", system: "groq", model: "qwen/qwen3-32b", price_in: -1, price_out: -1 },
    { type: "router_update", action: "set_model", system: "groq", model: "plain-model", price_in: 0, price_out: 0 }]);
});

test("one side of the person's own price changed or emptied sends only that side", async () => {
  const x = setup({ routerStatus: status(groq()) });
  await x.settle();
  x.click("[data-router-edit=groq]");
  const box = (side) => x.q(`[data-router-system=groq] [data-model-row='1'] [data-edit=price-${side}]`);
  box("in").value = "0.45"; box("out").value = "";
  x.click("[data-router-edit-save=groq]");
  await x.settle();
  assert.deepEqual(x.routerSent().at(-1), { type: "router_update", action: "set_model", system: "groq", model: "qwen/qwen3-32b", price_in: 0.45, price_out: -1 });
});

test("a CLI that says no prices: none shown, no boxes, nothing sent", async () => {
  const x = setup({ routerStatus: status(gpu(), groq()), prices: false });
  await x.settle();
  assert.equal(x.q(".router-price"), null);
  x.click("[data-router-edit=groq]");
  assert.equal(x.q("[data-price-row]"), null);
  assert.equal(x.q("[data-edit=price-in]"), null);
  x.q("[data-router-system=groq] [data-model-row='0'] [data-edit=note]").value = "fast";
  x.click("[data-router-edit-save=groq]");
  await x.settle();
  assert.deepEqual(x.routerSent().at(-1), { type: "router_update", action: "set_model", system: "groq", model: "llama-3.3-70b-versatile", note: "fast" });
});

test("a long model list can be filtered, and a redraw keeps what was ticked and typed", async () => {
  const many = Array.from({ length: 30 }, (_, i) => `vendor-${i % 3}/model-${i}`);
  const x = setup({ answers: { router_provider_models: { models: many } } });
  await x.settle();
  x.click("[data-router-add]"); x.click("[data-router-add-way=providers]");
  x.click(`[data-router-add-provider="${OPENROUTER}"]`);
  await x.settle();
  const filter = x.q("[data-pick-filter]");
  assert.ok(filter, "a filter over a long list");
  type(x, filter, "model-2");
  const shown = () => x.all(".router-pick").filter((l) => !l.hidden).map((l) => l.textContent.trim());
  assert.deepEqual(shown(), ["vendor-2/model-2", ...Array.from({ length: 10 }, (_, i) => `vendor-${(20 + i) % 3}/model-${20 + i}`)]);
  x.q("[data-pick='2']").checked = true;
  x.q("#router-add-workers").value = "5";
  x.message({ type: "routerStatus", status: status(gpu()) });      // the list moves on while the form is open
  assert.equal(x.q("[data-pick='2']").checked, true);
  assert.equal(x.q("#router-add-workers").value, "5");
  assert.equal(x.q("[data-pick-filter]").value, "model-2");
  assert.equal(shown().length, 11, "and the filter still holds");
});
