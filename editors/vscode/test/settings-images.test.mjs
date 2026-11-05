// Settings -> Models -> Images (0.51, src/settingsImages.js): each image generator's row (name, provider · model, price,
// "Asks before each image", its state in words, the Default badge, its key, this month's spend), + Add generator with the
// key sent in a command of its own, a ComfyUI workflow's inputs confirmed on one screen, Edit, Remove, Make default,
// Test and Test all, this project's choice, the automatic fallback and the folder. Every change is one images_update
// sent at once; a CLI without ready.capabilities.images shows no Images at all.
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
const helpers = await import(src + "settingsImages.js");
const windows = [];
after(() => windows.forEach((w) => w.close()));

const NOW = Date.now() / 1000;
const comfy = { id: "comfy", name: "ComfyUI on gpu-box", provider: "comfyui", provider_name: "ComfyUI", base_url: "http://gpu-box.local:8188",
  model: "sd_xl_turbo_1.0_fp16.safetensors", size: "512x512", enabled: true, asks: false, paid: false, local: true, price_usd: 0, price: "free",
  good_for: "free, on your own computer: whatever model it runs", default: true, has_key: false, key_from: "", spent_this_month_usd: 0,
  system: "gpu", state: { ok: true, detail: "3 checkpoints", at: NOW } };
const fal = { id: "fal", name: "fal FLUX schnell", provider: "fal", provider_name: "fal.ai", base_url: "https://fal.run", model: "fal-ai/flux/schnell",
  size: "1024x1024", enabled: true, asks: true, paid: true, local: false, price_usd: 0.003, price: "about $0.003", good_for: "", default: false,
  has_key: true, key_from: "env:FAL_KEY", spent_this_month_usd: 0.012, monthly_limit_usd: 5, state: { ok: true, detail: "", at: NOW } };
const gemini = { id: "gemini", name: "Gemini 3.1 Flash Image", provider: "gemini", provider_name: "Google Gemini",
  base_url: "https://generativelanguage.googleapis.com", model: "gemini-3.1-flash-image", size: "1024x1024", enabled: true, asks: true, paid: true,
  local: false, price_usd: 0.067, price: "about $0.067", good_for: "", default: false, has_key: true, key_from: "saved", spent_this_month_usd: 0,
  state: { ok: false, kind: "needs_credit", detail: "The Gemini API free tier is not available for this project.", at: NOW } };
function status(over = {}) {
  return { generators: [comfy, fal, gemini].map((g) => structuredClone(g)), default: "comfy", auto_fallback: false, save_dir: "assets/generated",
    project_choice: "", chosen: "", through_plugins: ["Runway", "Higgsfield"], ...over };
}

function setup({ capable = true, imagesStatus = status(), answers = {} } = {}) {
  const dom = new JSDOM(viewModule.exports.settingsDocument(), { runScripts: "outside-only", pretendToBeVisual: true });
  const { window: w } = dom;
  windows.push(w);
  const sent = [];
  let current = imagesStatus;
  const message = (m) => w.dispatchEvent(new w.MessageEvent("message", { data: m }));
  w.acquireVsCodeApi = () => ({ getState() {}, setState() {}, postMessage: (m) => {
    sent.push(m);
    if (m.type === "imagesPickWorkflow") {
      const answer = answers.pick;
      queueMicrotask(() => message({ type: "imagesWorkflow", token: m.token, ...(answer || { cancelled: true }) }));
      return;
    }
    if (m.type === "routerCommand") {
      queueMicrotask(() => message({ type: "routerReply", token: m.token, ok: true, status: { enabled: true, systems: [
        { id: "gpu", name: "GPU box", enabled: true, jobs: ["images"], models: [], health: { state: "online" } }] } }));
      return;
    }
    if (m.type !== "imagesCommand") return;
    const name = m.command.type + (m.command.action ? ":" + m.command.action : "");
    const answer = answers[name];
    const reply = typeof answer === "function" ? answer(m.command, current) : answer;
    if (reply?.status) current = reply.status;
    queueMicrotask(() => message({ type: "imagesReply", token: m.token, ok: true, status: current, ...(reply || {}) }));
  } });
  w.CSS = w.CSS || { escape: (s) => String(s).replace(/["\\]/g, "\\$&") };
  w.eval(code);
  const config = { type: "config", base_url: "https://model.example/v1", model: "main-model", mode: "default", pips_settable: true,
    router_capable: true, ...(capable ? { images_capable: true } : {}) };
  message({ type: "event", event: config });
  message({ type: "show", section: "models" });
  const settle = () => new Promise((r) => setTimeout(r, 10));
  const $ = (s) => w.document.querySelector(s);
  return { w, d: w.document, sent, message, settle, $,
    commands: () => JSON.parse(JSON.stringify(sent.filter((m) => m.type === "imagesCommand").map((m) => m.command))),
    click: (s) => $(s).click(),
    card: (id) => $(`[data-images-gen="${id}"]`),
    type(selector, value) { const box = $(selector); box.value = value; box.dispatchEvent(new w.Event("input", { bubbles: true })); } };
}

test("an older CLI shows no Images; one that makes them lists each generator with what matters, in words", async () => {
  const older = setup({ capable: false });
  await older.settle();
  assert.equal(older.$("#models-images"), null, "no Images section without ready.capabilities.images");
  assert.deepEqual(older.commands(), [], "and nothing asked of it");

  const x = setup();
  await x.settle();
  assert.deepEqual(x.commands()[0], { type: "images_list" }, "the list, read once");
  const names = [...x.d.querySelectorAll("#models-images .router-name")].map((n) => n.textContent);
  assert.deepEqual(names, ["ComfyUI on gpu-box", "fal FLUX schnell", "Gemini 3.1 Flash Image"]);
  const comfyCard = x.card("comfy"), falCard = x.card("fal"), geminiCard = x.card("gemini");
  assert.equal(comfyCard.querySelector(".images-badge").textContent, "Default");
  assert.equal(falCard.querySelector(".images-badge"), null, "one default");
  assert.equal(comfyCard.querySelector(".router-where").textContent, "ComfyUI · sd_xl_turbo_1.0_fp16.safetensors");
  assert.equal(comfyCard.querySelector("[data-images-state]").textContent, "Works");
  assert.match(comfyCard.textContent, /free · on your computer · 512x512 by default/);
  assert.match(comfyCard.textContent, /On DGC Router: GPU box/, "its Router system, by name");
  assert.doesNotMatch(comfyCard.textContent, /whatever model it runs/, "what it's good for is one click away, under Edit");
  assert.ok(comfyCard.querySelector("[data-images-router]"), "with a link to the systems");
  assert.match(falCard.textContent, /about \$0\.003 an image/);
  assert.match(falCard.textContent, /Key from FAL_KEY · This month: \$0\.012 of \$5\.00/);
  assert.equal(geminiCard.querySelector("[data-images-state]").textContent, "Needs credit");
  assert.match(geminiCard.querySelector(".images-detail").textContent, /free tier is not available/);
  assert.match(geminiCard.textContent, /Key saved · This month: \$0\.00/);
  // Asks before each image: off for the free one, on for the paid ones, as DGC said.
  assert.deepEqual(["comfy", "fal", "gemini"].map((id) => x.card(id).querySelector("[data-images-asks]").getAttribute("aria-checked")),
    ["false", "true", "true"]);
  assert.equal(comfyCard.querySelector("[data-images-default]"), null, "the default isn't offered as default again");
  assert.ok(falCard.querySelector("[data-images-default]"));
  assert.match(x.$("#models-images .images-plugins").textContent, /^Runway and Higgsfield work through their plugins\./);
  assert.equal(x.$("#images-project").value, "");
  assert.deepEqual([...x.$("#images-project").options].map((o) => o.textContent),
    ["Ask me when several fit", "ComfyUI on gpu-box", "fal FLUX schnell", "Gemini 3.1 Flash Image"]);
  assert.equal(x.$("#images-fallback").getAttribute("aria-checked"), "false");
  assert.equal(x.$("#images-save-dir").value, "assets/generated");
});

test("the row's helpers say it as the CLI does", () => {
  assert.equal(helpers.dollars(0.006), "$0.006");
  assert.equal(helpers.dollars(5), "$5.00");
  assert.deepEqual(helpers.stateWords({ enabled: false }), { cls: "off", words: "Turned off", detail: "" });
  assert.deepEqual(helpers.stateWords({}), { cls: "unknown", words: "Not tested yet", detail: "" });
  assert.equal(helpers.stateWords({ state: { ok: false, kind: "bad_key", detail: "401" } }).words, "Bad key");
  assert.equal(helpers.keyWords({ provider: "fal", key_from: "" }), "No key yet");
  assert.equal(helpers.stateWords({ provider: "fal", has_key: false, state: { ok: true } }).words, "Needs a key",
    "a test that worked elsewhere, with another key, isn't this one working");
  assert.equal(helpers.keyWords({ provider: "comfyui", key_from: "" }), "", "a local one needs none");
  assert.equal(helpers.spendWords({ paid: false }), "", "nothing to spend on a free one");
  assert.equal(helpers.priceWords({ paid: true, price: "price unknown", price_usd: null }), "price unknown");
});

test("Asks before each image switches at once, and the row shows what DGC saved", async () => {
  const x = setup({ answers: { "images_update:edit_generator": (cmd, s) => {
    const next = structuredClone(s); next.generators.find((g) => g.id === cmd.generator).asks = cmd.asks; return { status: next, change: "Changed fal FLUX schnell: asks" };
  } } });
  await x.settle();
  x.card("fal").querySelector("[data-images-asks]").click();
  await x.settle();
  assert.deepEqual(x.commands().at(-1), { type: "images_update", action: "edit_generator", generator: "fal", asks: false });
  assert.equal(x.card("fal").querySelector("[data-images-asks]").getAttribute("aria-checked"), "false");
  assert.match(x.card("fal").textContent, /Makes it without asking\./);
});

test("+ Add generator: the provider first, the key in a command of its own after the add, then one test", async () => {
  const added = { ...structuredClone(fal), id: "fal-2", name: "fal FLUX dev", model: "fal-ai/flux/dev", has_key: false, key_from: "", state: undefined };
  let keyed = false;
  const x = setup({ answers: {
    "images_update:add_generator": (cmd, s) => ({ status: { ...s, generators: [...s.generators, added] }, change: "Added fal FLUX dev",
      tested: { "fal-2": { ok: false, kind: "bad_key", detail: "no key yet" } }, notes: ["It needs a key: paste it in Settings → Models → Images & video, or /images key fal-2."] }),
    "images_update:set_key": (cmd, s) => { keyed = true; return { status: { ...s, generators: s.generators.map((g) => g.id === "fal-2" ? { ...g, has_key: true, key_from: "saved" } : g) } }; },
    "images_update:test": (cmd, s) => ({ tested: { "fal-2": keyed ? { ok: true, detail: "" } : { ok: false, kind: "bad_key" } },
      status: { ...s, generators: s.generators.map((g) => g.id === "fal-2" ? { ...g, state: { ok: true, detail: "", at: NOW } } : g) } }),
  } });
  await x.settle();
  x.click("[data-images-add]");
  await x.settle();
  assert.equal(x.$("#images-add-provider").value, "comfyui", "ComfyUI first: the one this audience runs");
  assert.ok(x.$("#images-add-address"), "an address for a server on your computer");
  assert.equal(x.$("#images-add-key"), null, "and no key");
  const provider = x.$("#images-add-provider");
  provider.value = "fal";
  provider.dispatchEvent(new x.w.Event("change", { bubbles: true }));
  await x.settle();
  assert.equal(x.$("#images-add-address"), null, "a cloud one needs no address");
  assert.ok(x.$("#images-add-key"), "but a key");
  x.type("#images-add-model", "fal-ai/flux/dev");
  x.type("#images-add-key", "fal-id:fal-secret-123");
  x.click("[data-images-add-go]");
  await x.settle(); await x.settle();
  const sent = x.commands().slice(1);
  assert.deepEqual(sent[0], { type: "images_update", action: "add_generator", provider: "fal", model: "fal-ai/flux/dev" });
  assert.deepEqual(sent[1], { type: "images_update", action: "set_key", generator: "fal-2", key: "fal-id:fal-secret-123" }, "the key, on its own");
  assert.deepEqual(sent[2], { type: "images_update", action: "test", generator: "fal-2" });
  assert.equal(x.$("[data-images-adding]"), null, "the form closes");
  assert.equal(x.card("fal-2").querySelector(".router-note").textContent, "Added. It works.");
  assert.doesNotMatch(x.$("#models-images").innerHTML, /fal-id:fal-secret-123/, "the key is never drawn again");
  assert.match(x.card("fal-2").textContent, /Key saved/);
});

test("what is typed in an open form stays when the page is drawn again under it", async () => {
  const x = setup();
  await x.settle();
  x.click("[data-images-add]");
  await x.settle();
  x.type("#images-add-address", "gpu-box.local:8188");
  x.$(".images-paste").open = true;
  x.$(".images-paste").dispatchEvent(new x.w.Event("toggle"));
  x.type("#images-add-workflow", '{"6": {}}');
  x.card("gemini").querySelector("[data-images-edit]").click();
  await x.settle();
  x.type('[data-images-gen="gemini"] [data-edit="good_for"]', "logos");
  // DGC says something new (a config): Settings draws Models again.
  x.message({ type: "event", event: { type: "config", base_url: "https://model.example/v1", model: "main-model", mode: "default", router_capable: true, images_capable: true } });
  await x.settle();
  assert.equal(x.$("#images-add-address").value, "gpu-box.local:8188");
  assert.equal(x.$(".images-paste").open, true);
  assert.equal(x.$("#images-add-workflow").value, '{"6": {}}');
  assert.equal(x.$('[data-images-gen="gemini"] [data-edit="good_for"]').value, "logos");
});

test("adding an OpenAI-style server asks for its address; a refusal is said in the form", async () => {
  const x = setup({ answers: { "images_update:add_generator": () => ({ ok: false, error: "the address answers nothing" }) } });
  await x.settle();
  x.click("[data-images-add]");
  await x.settle();
  const provider = x.$("#images-add-provider");
  provider.value = "openai_compatible";
  provider.dispatchEvent(new x.w.Event("change", { bubbles: true }));
  await x.settle();
  x.click("[data-images-add-go]");
  await x.settle();
  assert.equal(x.$("[data-images-adding] [role=alert]").textContent, "Type its address first.");
  assert.equal(x.commands().length, 1, "nothing sent without one");
  x.type("#images-add-address", "http://gpu-box.local:8000/v1");
  x.click("[data-images-add-go]");
  await x.settle();
  assert.equal(x.$("[data-images-adding] [role=alert]").textContent, "the address answers nothing");
});

test("a fal key pasted in part is said before anything is saved; Add again saves it anyway", async () => {
  // Seen in testing, 2026-11-02: 40 characters of a fal key, no ':', saved; every picture then failed.
  const x = setup({ answers: { "images_update:add_generator": () => ({ ok: false, error: "stop here" }) } });
  await x.settle();
  x.click("[data-images-add]");
  await x.settle();
  const provider = x.$("#images-add-provider");
  provider.value = "fal";
  provider.dispatchEvent(new x.w.Event("change", { bubbles: true }));
  await x.settle();
  x.type("#images-add-key", "0123456789abcdef0123456789abcdef01234567");
  x.click("[data-images-add-go]");
  await x.settle();
  assert.match(x.$("[data-images-adding] [role=alert]").textContent,
    /^This doesn't look like a whole fal key: fal keys have two parts with a ':' between them .* Choose Add again to save it anyway\.$/);
  assert.ok(!x.$("[data-images-adding] [role=alert]").textContent.includes("0123456789abcdef"), "never says the key");
  assert.equal(x.commands().length, 1, "nothing sent yet");
  x.click("[data-images-add-go]");
  await x.settle();
  assert.equal(x.commands().at(-1).action, "add_generator", "the second Add goes ahead");
});

test("key shapes, as DGC checks them", () => {
  assert.equal(helpers.keyShapeNote("fal", "id:secret"), "");
  assert.match(helpers.keyShapeNote("fal", "nocolon"), /whole fal key/);
  assert.match(helpers.keyShapeNote("replicate", "abc"), /r8_/);
  assert.equal(helpers.keyShapeNote("gemini", "AIza" + "x".repeat(35)), "");
  assert.equal(helpers.keyShapeNote("openai_compatible", "anything"), "");
  assert.equal(helpers.stateWords({ key_from: "saved", state: { ok: false, kind: "bad_key", detail: "401" } }).words,
    "Key not accepted: choose Edit and paste the whole key again");
});

test("a key that doesn't work: the card says so once, on its state line, and the note doesn't repeat it", async () => {
  const added = { ...structuredClone(fal), id: "replicate", name: "Replicate FLUX Schnell", provider: "replicate", provider_name: "Replicate",
    key_from: "saved", state: { ok: false, kind: "bad_key", detail: "You did not pass a valid authentication token", at: NOW } };
  const x = setup({ answers: {
    "images_update:add_generator": (cmd, s) => ({ status: { ...s, generators: [...s.generators, { ...added, key_from: "", has_key: false, state: undefined }] } }),
    "images_update:set_key": (cmd, s) => ({ status: { ...s, generators: s.generators.map((g) => g.id === "replicate" ? added : g) } }),
    "images_update:test": () => ({ tested: { replicate: { ok: false, kind: "bad_key", detail: "You did not pass a valid authentication token" } } }),
  } });
  await x.settle();
  x.click("[data-images-add]");
  await x.settle();
  const provider = x.$("#images-add-provider");
  provider.value = "replicate";
  provider.dispatchEvent(new x.w.Event("change", { bubbles: true }));
  await x.settle();
  x.type("#images-add-key", "r8_wrong");
  x.click("[data-images-add-go]");
  await x.settle(); await x.settle();
  const card = x.card("replicate");
  assert.equal(card.querySelector("[data-images-state]").textContent, "Key not accepted: choose Edit and paste the whole key again");
  assert.equal(card.querySelector(".router-note").textContent, "Added, but it doesn't work yet.");
  assert.equal(card.textContent.split("You did not pass a valid authentication token").length - 1, 1, "said once");
});

test("a ComfyUI workflow: DGC's mapping on one screen, nothing added until confirmed, with the user's change", async () => {
  const workflow = { 3: { class_type: "KSampler", inputs: { seed: 1 } }, 6: { class_type: "CLIPTextEncode", inputs: { text: "a" } } };
  const pending = { generator: { name: "ComfyUI on gpu-box" }, mapping: { prompt: "6.text", seed: "3.seed" },
    mapping_lines: ['Prompt → node 6 (CLIPTextEncode, "Positive").text', "Seed → node 3 (KSampler).seed"], notes: ["no SaveImage node: DGC adds one"] };
  const fresh = { ...structuredClone(comfy), id: "comfyui-on-gpu-box", default: false, model: "", workflow: "comfyui-on-gpu-box.json", mapping: { prompt: "6.text", seed: "3.seed" } };
  const x = setup({ answers: {
    pick: { text: JSON.stringify(workflow), name: "portrait_api.json" },
    "images_update:add_generator": (cmd, s) => cmd.mapping
      ? { status: { ...s, generators: [...s.generators, fresh] }, tested: { [fresh.id]: { ok: true, detail: "" } } }
      : { pending, status: s } } });
  await x.settle();
  x.click("[data-images-add]");
  await x.settle();
  x.type("#images-add-address", "gpu-box.local:8188");
  x.click("[data-images-workflow-pick]");
  await x.settle();
  assert.match(x.$("[data-images-adding] .images-workflow").textContent, /portrait_api\.json/);
  assert.equal(x.$("[data-images-add-go]").textContent, "Next", "a workflow is checked before it is added");
  x.click("[data-images-add-go]");
  await x.settle();
  const first = x.commands().at(-1);
  assert.equal(first.action, "add_generator");
  assert.deepEqual(first.workflow, workflow);
  assert.equal(first.mapping, undefined, "first without a mapping: DGC finds it and saves nothing");
  assert.equal(first.base_url, "gpu-box.local:8188");
  const screen = x.$("[data-images-mapping]");
  assert.ok(screen, "the one screen to confirm");
  assert.match(screen.textContent, /DGC found these in portrait_api\.json/);
  assert.deepEqual([...screen.querySelectorAll("[data-map-key]")].map((b) => [b.dataset.mapKey, b.value]), [["prompt", "6.text"], ["seed", "3.seed"]]);
  assert.match(screen.textContent, /node 6 \(CLIPTextEncode, "Positive"\)\.text/);
  assert.match(screen.querySelector(".images-notes").textContent, /no SaveImage node/);
  assert.equal(x.d.querySelectorAll("[data-images-gen]").length, 3, "nothing added yet");
  const seed = screen.querySelector('[data-map-key="seed"]');
  seed.value = "nonsense";
  x.click("[data-images-mapping-yes]");
  await x.settle();
  assert.match(x.$("[data-images-mapping] [role=alert]").textContent, /Seed: write it as a node and its field/);
  x.$('[data-images-mapping] [data-map-key="seed"]').value = "4.noise_seed";
  x.click("[data-images-mapping-yes]");
  await x.settle(); await x.settle();
  const second = x.commands().at(-1);
  assert.deepEqual(second.mapping, { prompt: "6.text", seed: "4.noise_seed" }, "the user's change goes with it");
  assert.deepEqual(second.workflow, workflow);
  assert.ok(x.card(fresh.id), "added");
  assert.equal(x.card(fresh.id).querySelector(".router-note").textContent, "Added. It works.");
  assert.match(x.card(fresh.id).querySelector(".router-where").textContent, /ComfyUI · your workflow/);
});

test("Edit says a new address drops the key; Remove asks first; Default, Test and Test all go at once", async () => {
  const x = setup({ answers: {
    "images_update:edit_generator": (cmd, s) => ({ status: { ...s, generators: s.generators.map((g) => g.id === cmd.generator ? { ...g, ...cmd, key_from: cmd.base_url ? "" : g.key_from, has_key: cmd.base_url ? false : g.has_key } : g) } }),
    "images_update:remove_generator": (cmd, s) => ({ status: { ...s, generators: s.generators.filter((g) => g.id !== cmd.generator) } }),
    "images_update:set_default": (cmd, s) => ({ status: { ...s, default: cmd.generator, generators: s.generators.map((g) => ({ ...g, default: g.id === cmd.generator })) } }),
    "images_update:test": (cmd) => ({ tested: { [cmd.generator]: { ok: true } } }),
    "images_list": (cmd, s) => (cmd.refresh ? { status: s } : {}),
  } });
  await x.settle();
  x.card("gemini").querySelector("[data-images-edit]").click();
  await x.settle();
  const form = x.card("gemini");
  assert.equal(form.querySelector('[data-edit="key"]').getAttribute("placeholder"), "Saved", "never the key itself");
  assert.equal(form.querySelector("[data-images-moved]").hidden, true);
  const address = form.querySelector('[data-edit="base_url"]');
  address.value = "https://gemini-proxy.example";
  address.dispatchEvent(new x.w.Event("input", { bubbles: true }));
  assert.equal(form.querySelector("[data-images-moved]").hidden, false, "Changing the address removes its saved key.");
  form.querySelector('[data-edit="limit"]').value = "2.5";
  x.card("gemini").querySelector("[data-images-edit-save]").click();
  await x.settle(); await x.settle();
  const edits = x.commands().filter((c) => c.action === "edit_generator");
  assert.deepEqual(edits[0], { type: "images_update", action: "edit_generator", generator: "gemini", base_url: "https://gemini-proxy.example", monthly_limit_usd: 2.5 });
  assert.match(x.card("gemini").textContent, /Its saved key was removed with the old address\./);
  assert.equal(x.commands().at(-1).action, "test", "a new address is tested at once");

  x.card("fal").querySelector("[data-images-default]").click();
  await x.settle();
  assert.deepEqual(x.commands().at(-1), { type: "images_update", action: "set_default", generator: "fal" });
  assert.equal(x.card("fal").querySelector(".images-badge").textContent, "Default");

  x.card("comfy").querySelector("[data-images-test]").click();
  await x.settle();
  assert.deepEqual(x.commands().at(-1), { type: "images_update", action: "test", generator: "comfy" });
  assert.equal(x.card("comfy").querySelector(".router-note").textContent, "Tested: it works.");

  x.click("[data-images-test-all]");
  await x.settle();
  assert.deepEqual(x.commands().at(-1), { type: "images_list", refresh: true });

  x.card("comfy").querySelector("[data-images-remove]").click();
  await x.settle();
  assert.match(x.card("comfy").querySelector(".router-confirm").textContent, /^Remove ComfyUI on gpu-box\?/);
  assert.deepEqual([...x.card("comfy").querySelectorAll("button")].filter((b) => !b.matches("[data-images-asks], .link")).map((b) => b.textContent),
    ["Remove", "Keep it"], "one Remove, in the question");
  assert.notEqual(x.commands().at(-1).action, "remove_generator", "asked first");
  x.card("comfy").querySelector("[data-images-remove-yes]").click();
  await x.settle();
  assert.deepEqual(x.commands().at(-1), { type: "images_update", action: "remove_generator", generator: "comfy" });
  assert.equal(x.card("comfy"), null);
});

test("the project's choice, the automatic fallback and the folder each save at once", async () => {
  const x = setup({ answers: {
    "images_update:set_project_choice": (cmd, s) => ({ status: { ...s, project_choice: cmd.generator, chosen: cmd.generator } }),
    "images_update:set_auto_fallback": (cmd, s) => ({ status: { ...s, auto_fallback: cmd.auto_fallback } }),
    "images_update:set_save_dir": (cmd, s) => ({ status: { ...s, save_dir: cmd.save_dir }, change: `Images are saved in ${cmd.save_dir}/` }),
  } });
  await x.settle();
  const choice = x.$("#images-project");
  choice.value = "fal";
  choice.dispatchEvent(new x.w.Event("change", { bubbles: true }));
  await x.settle();
  assert.deepEqual(x.commands().at(-1), { type: "images_update", action: "set_project_choice", generator: "fal" });
  assert.equal(x.$("#images-project").value, "fal");
  x.click("#images-fallback");
  await x.settle();
  assert.deepEqual(x.commands().at(-1), { type: "images_update", action: "set_auto_fallback", auto_fallback: true });
  assert.equal(x.$("#images-fallback").getAttribute("aria-checked"), "true");
  x.$("#images-save-dir").value = "art/made";
  x.click("[data-images-save-dir]");
  await x.settle();
  assert.deepEqual(x.commands().at(-1), { type: "images_update", action: "set_save_dir", save_dir: "art/made" });
  assert.equal(x.$("#images-save-dir").value, "art/made");
  assert.match(x.$("#models-images").textContent, /Images are saved in art\/made\//);
  assert.equal(x.sent.filter((m) => m.type === "saveSettings").length, 0, "never through Save all");
});

test("a picture made in a chat reads the list again: an Always allow shows its switch off", async () => {
  const x = setup();
  await x.settle();
  const before = x.commands().length;
  x.message({ type: "imagesMade" });
  await x.settle();
  assert.deepEqual(x.commands().slice(before), [{ type: "images_list" }]);
});

test("switching providers clears the previous model and provider inputs before rendering", async () => {
  const x = setup();
  await x.settle();
  x.click("[data-images-add]");
  x.type("#images-add-model", "checkpoint.safetensors");
  x.type("#images-add-address", "http://example.invalid:8188");
  const provider = x.$("#images-add-provider");
  provider.value = "fal";
  provider.dispatchEvent(new x.w.Event("input", { bubbles: true }));
  provider.dispatchEvent(new x.w.Event("change", { bubbles: true }));
  assert.equal(x.$("#images-add-model").value, "");
  x.click("[data-images-add-go]");
  await x.settle();
  const command = x.commands().find((cmd) => cmd.action === "add_generator");
  assert.deepEqual(command, { type: "images_update", action: "add_generator", provider: "fal" });
});
