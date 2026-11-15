// The Pip's model menu has the two tabs of Work's (live round 1, findings 13b and 16): the model row and the thinking
// slider stay on top; under them "Main model | Sub-agents". Main model is the list as before. Sub-agents says what is
// true of this Pip's sub-agents today: they run on its own model at its thinking, one at a time, or up to 4 with Ultra
// on the slider (set_pip_agents, Pips API 97). It offers no model, thinking or context window of their own: DGC cannot
// set those for a Pip's sub-agents yet, and a control that did nothing would be a lie. A DGC before API 97 has no
// tabs. The stand-in DGC is test/support/one-pips-scene.mjs with `sub: true`.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { setup as open } from "./support/one-pips-node.mjs";
import { GST } from "./support/one-pips-scene.mjs";

const windows = [];
after(() => windows.forEach((w) => w.close()));
const chat = async (api = 97, scene = {}) => {
  const x = open({ api, scene: { sub: true, waiting: false, fix: "none", ...scene } });
  windows.push(x.w); await x.drain(); await x.openPip(GST); await x.drain();
  x.$("#chat-model").click(); await x.drain();
  return x;
};
const tabs = (x) => [...x.$$(".composer-model-menu .model-tabs [role=tab]")].map((t) => [t.textContent, t.getAttribute("aria-selected")]);
const press = async (x, sel) => { x.$(sel).click(); await x.drain(); };
const slide = async (x, step) => {
  const s = x.$("#chat-thinking"); s.value = String(step);
  s.dispatchEvent(new x.w.Event("input", { bubbles: true, composed: true }));
  s.dispatchEvent(new x.w.Event("change", { bubbles: true, composed: true }));
  await x.drain();
};

test("the model row and the slider stay on top; under them the tabs Main model and Sub-agents; Main model is the list", async () => {
  const x = await chat();
  const menu = x.$(".composer-model-menu");
  assert.deepEqual(tabs(x), [["Main model", "true"], ["Sub-agents", "false"]]);
  const order = [...menu.children].map((n) => n.id || n.className.split(" ")[0]);
  assert.ok(order.indexOf("chat-model-summary") < order.indexOf("composer-effort-control") && order.indexOf("composer-effort-control") < order.indexOf("model-tabs"), `the row, the slider, then the tabs: ${order}`);
  assert.ok(order.indexOf("model-tabs") < order.indexOf("composer-model-list"), "the list is under the tabs");
  assert.ok(x.$(".composer-model-list"), "the Main tab shows the model list");
  assert.equal(x.$(".composer-agents"), null);
  assert.equal(x.$(".model-tabs").getAttribute("role"), "tablist");
});

test("Sub-agents says what they run on and how many at once; nothing there pretends to set what DGC cannot", async () => {
  const x = await chat();
  await press(x, '[data-model-tab="agents"]');
  assert.deepEqual(tabs(x), [["Main model", "false"], ["Sub-agents", "true"]]);
  assert.equal(x.$(".composer-model-list"), null, "the main model's list is gone");
  const panel = x.$(".composer-agents");
  assert.ok(panel, "the Sub-agents tab");
  assert.equal(panel.getAttribute("role"), "tabpanel");
  const row = panel.querySelector("[role=option]");
  assert.match(row.textContent, /This Pip’s model/);
  assert.equal(row.getAttribute("aria-selected"), "true");
  assert.match(row.querySelector("small").textContent, /^Now: \S+/, "it names the model they run on now");
  assert.match(panel.textContent, /One at a time\./);
  assert.match(panel.textContent, /Ultra on the slider lets up to 4 work at once\./);
  assert.equal(panel.querySelectorAll("select, input, [data-agents-drop]").length, 0, "no dropdown that DGC could not honour");
  assert.doesNotMatch(panel.textContent, /fallback/i);
  assert.equal(x.$("#chat-thinking") !== null && x.$("#chat-model-summary") !== null, true, "the row and the slider are still on top");
  // Ultra on the slider: the tab says so at once.
  await slide(x, 5);
  assert.deepEqual(x.requests("set_pip_agents").map((r) => r.slots), [4]);
  assert.deepEqual(tabs(x), [["Main model", "false"], ["Sub-agents", "true"]], "the tab stays chosen while the slider moves");
  assert.match(x.$(".composer-agents").textContent, /Up to 4 at once \(Ultra\)\./);
  // Back to the main model's list, by the tab and by the model row.
  await press(x, '[data-model-tab="main"]');
  assert.ok(x.$(".composer-model-list")); assert.equal(x.$(".composer-agents"), null);
  await press(x, '[data-model-tab="agents"]');
  await press(x, "#chat-model-summary");
  assert.deepEqual(tabs(x), [["Main model", "true"], ["Sub-agents", "false"]], "the model row is the main model's: it shows its list");
  assert.ok(x.$(".composer-model-list"));
});

test("the arrow keys move between the two tabs; the menu opens on Main model each time", async () => {
  const x = await chat();
  const key = (node, k) => { node.dispatchEvent(new x.w.KeyboardEvent("keydown", { key: k, bubbles: true, composed: true, cancelable: true })); };
  key(x.$('[data-model-tab="main"]'), "ArrowRight"); await x.drain();
  assert.deepEqual(tabs(x), [["Main model", "false"], ["Sub-agents", "true"]]);
  key(x.$('[data-model-tab="agents"]'), "ArrowLeft"); await x.drain();
  assert.deepEqual(tabs(x), [["Main model", "true"], ["Sub-agents", "false"]]);
  await press(x, '[data-model-tab="agents"]');
  x.$("#chat-model").click(); await x.drain(); x.$("#chat-model").click(); await x.drain();
  assert.deepEqual(tabs(x), [["Main model", "true"], ["Sub-agents", "false"]]);
});

test("a DGC before Pips API 97 has no sub-agents for a Pip: no tabs, the menu as it was", async () => {
  const x = await chat(96);
  assert.equal(x.$(".composer-model-menu .model-tabs"), null);
  assert.ok(x.$(".composer-model-list"));
});
