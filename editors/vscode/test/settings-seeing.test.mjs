// Settings -> Models -> "A model that can see" (0.52, src/settingsSeeing.js, dgc/seeing.py): one row that says what
// every chat whose model can't see a picture starts from -- Ask when needed, a model that can see on one of the user's
// connections (DGC's own search, by name), or Work without seeing -- and changes it at once (seeing {op: "set"}),
// apart from Save all. A CLI without ready.capabilities.seeing shows no row and is asked nothing.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = fileURLToPath(new URL("../src/", import.meta.url));
const result = await build({ entryPoints: [src + "settingsClient.js"], bundle: true, write: false,
  loader: { ".css": "empty", ".ico": "dataurl", ".png": "dataurl", ".svg": "dataurl" }, format: "iife" });
const code = result.outputFiles[0].text;
const view = await build({ entryPoints: [src + "settingsView.ts"], bundle: true, write: false, platform: "node", format: "cjs" });
const viewModule = { exports: {} };
new Function("module", "exports", view.outputFiles[0].text)(viewModule, viewModule.exports);
const helpers = await import(src + "settingsSeeing.js");
const windows = [];
after(() => windows.forEach((w) => w.close()));

const CLOUD = { kind: "provider", id: "provider_" + "a".repeat(32), name: "Ollama Cloud" };
const MODELS = [{ model: "qwen3-vl:8b", connection: { kind: "main", name: "this computer" }, tools: true },
  { model: "qwen3-vl:235b-cloud", connection: CLOUD, tools: true }];

function setup({ capable = true, choice = { choice: "ask" }, models = MODELS } = {}) {
  const dom = new JSDOM(viewModule.exports.settingsDocument(), { runScripts: "outside-only", pretendToBeVisual: true });
  const { window: w } = dom;
  windows.push(w);
  const sent = [];
  let current = choice;
  const message = (m) => w.dispatchEvent(new w.MessageEvent("message", { data: m }));
  w.acquireVsCodeApi = () => ({ getState() {}, setState() {}, postMessage: (m) => {
    sent.push(m);
    if (m.type !== "seeingCommand") return;
    if (m.op === "set") current = { choice: m.choice, ...(m.model ? { model: m.model, connection: m.connection } : {}), at: 1 };
    queueMicrotask(() => message({ type: "seeingReply", token: m.token, ok: true, choice: current, models: m.op === "list" ? models : [] }));
  } });
  w.CSS = w.CSS || { escape: (s) => String(s).replace(/["\\]/g, "\\$&") };
  w.eval(code);
  message({ type: "event", event: { type: "config", base_url: "http://127.0.0.1:11434", model: "deepseek-v4.1-flash:cloud",
    mode: "default", ...(capable ? { seeing_capable: true } : {}) } });
  message({ type: "show", section: "models" });
  const settle = () => new Promise((r) => setTimeout(r, 15));
  const $ = (s) => w.document.querySelector(s);
  return { w, sent, settle, $, asked: () => JSON.parse(JSON.stringify(sent.filter((m) => m.type === "seeingCommand").map(({ token, type, ...rest }) => rest))) };
}

test("an older CLI shows no row and is asked nothing", async () => {
  const x = setup({ capable: false });
  await x.settle();
  assert.equal(x.$("#models-seeing"), null);
  assert.deepEqual(x.asked(), []);
});

test("the row lists every model that can see, by its connection, and says Ask when needed by default", async () => {
  const x = setup();
  await x.settle();
  assert.deepEqual(x.asked()[0], { op: "list" }, "the search, asked once");
  const row = x.$("#models-seeing");
  assert.ok(row, "Models has the row");
  assert.equal(row.querySelector("h3").textContent, "A model that can see");
  const select = x.$("#seeing_choice");
  assert.deepEqual([...select.options].map((o) => o.textContent), ["Ask when needed", "Use qwen3-vl:8b to see · this computer",
    "Use qwen3-vl:235b-cloud to see · Ollama Cloud", "Work without seeing"]);
  assert.equal(select.value, "ask");
  assert.equal(select.disabled, false);
  // It sits after Sub-agents and before Pips, where models are chosen.
  const order = [...x.w.document.querySelectorAll("section.group")].map((g) => g.id).filter(Boolean);
  assert.ok(order.indexOf("models-seeing") > order.indexOf("models-subagents"), order.join());
  assert.ok(order.indexOf("models-seeing") < order.indexOf("models-pips"), order.join());
});

test("choosing a model saves it at once, with its connection, and Save all isn't involved", async () => {
  const x = setup();
  await x.settle();
  const select = x.$("#seeing_choice");
  select.value = [...select.options][2].value;
  select.dispatchEvent(new x.w.Event("change", { bubbles: true }));
  await x.settle();
  assert.deepEqual(x.asked()[1], { op: "set", choice: "relay", model: "qwen3-vl:235b-cloud", connection: CLOUD });
  assert.equal(x.$("#seeing_choice").value, helpers.choiceValue({ choice: "relay", model: "qwen3-vl:235b-cloud", connection: CLOUD }));
  assert.match(x.$("#seeing-says").textContent, /qwen3-vl:235b-cloud looks at pictures for every chat whose model can't see/);
  assert.doesNotMatch(x.w.document.body.textContent, /Unsaved changes/, "not a Save all change");
});

test("a remembered model the search didn't find this time stays shown, and none found says so", async () => {
  const kept = { choice: "relay", model: "gemma3:27b", connection: { kind: "main", name: "this computer" }, at: 5 };
  const x = setup({ choice: kept, models: [] });
  await x.settle();
  const select = x.$("#seeing_choice");
  assert.equal(select.options[select.selectedIndex].textContent, "Use gemma3:27b to see · this computer");
  assert.match(x.$("#models-seeing").textContent, /None of your connections has a model that can see\./);
});

test("the helpers read and write the choice as DGC keeps it", () => {
  assert.equal(helpers.choiceValue(null), "ask");
  assert.equal(helpers.choiceValue({ choice: "off" }), "off");
  const value = helpers.choiceValue({ choice: "relay", model: "m", connection: CLOUD });
  assert.deepEqual(helpers.choiceOf(value, [{ model: "m", connection: CLOUD }], null), { choice: "relay", model: "m", connection: CLOUD });
  assert.equal(helpers.choiceOf("relay|provider|x|gone", [], null), null, "a value no model stands for is never sent");
});

test("the extension checks the choice, asks DGC, and copies a saved provider's model for Pips", () => {
  const panel = readFileSync(src + "panel.ts", "utf8");
  const body = panel.slice(panel.indexOf("private async seeingSettingsCommand"), panel.indexOf("/** Settings -> Models -> Images: one images_*"));
  assert.match(body, /seeingCapable\(\)/);
  assert.match(body, /type: "seeing", op/);
  assert.match(body, /savePipProvider\(String\(conn\.id\), String\(cmd\.model\)\)/, "a Pip runs with no window: its provider is copied");
  assert.match(panel, /seeing_capable: this\.seeingCapable\(\)/);
  assert.match(panel, /msg\?\.type === "seeingCommand"/);
});
