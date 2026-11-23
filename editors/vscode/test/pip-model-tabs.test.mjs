// A Pip's model picker has the two tabs of Work's (live round 1, findings 13b and 16; in the one model picker since
// 17 Nov): "Main model | Sub-agents" across its top. Main model is this Pip's connections and their models. Sub-agents
// says what is true of this Pip's sub-agents today: they run on its own model at its thinking, one at a time, or up to
// 4 with Ultra (set_pip_agents, Pips API 97). It offers no model, thinking or context window of their own: DGC cannot
// set those for a Pip's sub-agents yet, and a control that did nothing would be a lie. A DGC before API 97 has no
// tabs. The stand-in DGC is test/support/one-pips-scene.mjs with `sub: true`.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { setup as open } from "./support/one-pips-node.mjs";
import { GST } from "./support/one-pips-scene.mjs";
import { pickerDom } from "./support/picker-dom.mjs";

const windows = [];
after(() => windows.forEach((w) => w.close()));
const chat = async (api = 97, scene = {}) => {
  const x = open({ api, scene: { sub: true, waiting: false, fix: "none", ...scene } });
  windows.push(x.w); await x.drain(); await x.openPip(GST); await x.drain();
  x.$("#chat-model").click(); await x.drain();
  return { ...x, p: pickerDom(x.d) };
};
const press = async (x, node) => { node.click(); await x.drain(); };

test("the tabs Main model and Sub-agents are across the picker's top; Main model is this Pip's connections and their models", async () => {
  const x = await chat();
  assert.deepEqual(x.p.tabs(), [["Main model", "true"], ["Sub-agents", "false"]]);
  const order = [...x.p.box().children].map((n) => n.className.split(" ")[0]);
  assert.ok(order.indexOf("dgc-mp-tabs") >= 0 && order.indexOf("dgc-mp-tabs") < order.indexOf("dgc-mp-main"), `the tabs, then the rail and the card: ${order}`);
  // The reference look (17 Nov): Thinking sits inside the card, under the list.
  const card = x.p.box().querySelector(".dgc-mp-main .dgc-mp-card"), parts = [...card.children].map((n) => n.className.split(" ")[0]);
  assert.ok(parts.indexOf("dgc-mp-list") >= 0 && parts.indexOf("dgc-mp-list") < parts.indexOf("dgc-mp-think"), `in the card, the list, then Thinking: ${parts}`);
  assert.ok(x.p.rows().length > 0, "the Main tab shows the model list");
  assert.ok(x.p.rail().length > 0, "beside its connections");
  assert.equal(x.d.querySelector(".dgc-mp-tabs").getAttribute("role"), "tablist");
  assert.equal(x.$(".composer-model-menu.composer-reasoning"), null, "the Pip's own model menu is gone");
  assert.equal(x.$("#chat-model").getAttribute("aria-expanded"), "true");
});

test("Sub-agents says what they run on and how many at once; nothing there pretends to set what DGC cannot", async () => {
  const x = await chat();
  await press(x, x.p.tab("agents"));
  assert.deepEqual(x.p.tabs(), [["Main model", "false"], ["Sub-agents", "true"]]);
  assert.deepEqual(x.p.names(), ["This Pip’s model"], "the main model's list is gone: one row, what they run on");
  assert.deepEqual(x.p.chosen(), ["This Pip’s model"]);
  assert.match(x.p.desc("This Pip’s model"), /^Now: \S+/, "it names the model they run on now");
  const note = x.d.querySelector(".dgc-mp-under .dgc-mp-note").textContent;
  assert.match(note, /One at a time\./);
  assert.match(note, /Ultra, under Thinking, lets up to 4 work at once\./);
  assert.match(note, /They think as hard as this Pip does\./);
  assert.equal(x.p.box().querySelectorAll("select, .dgc-mp-more, .dgc-mp-action").length, 0, "no dropdown, no ⋯ and no row that DGC could not honour");
  assert.doesNotMatch(x.p.box().textContent, /fallback/i);
  assert.ok(x.p.level("ultra"), "Thinking is still there, with Ultra");
  const before = x.requests("propose_pip_update").length + x.requests("accept_pip_update").length;
  await press(x, x.p.row("This Pip’s model"));
  assert.equal(x.requests("propose_pip_update").length + x.requests("accept_pip_update").length, before, "the row is what it is: pressing it changes nothing");
  assert.equal(x.p.open(), true);
  // Ultra: the tab says so at once.
  x.p.choose("ultra"); await x.drain();
  assert.deepEqual(x.requests("set_pip_agents").map((r) => r.slots), [4]);
  assert.deepEqual(x.p.tabs(), [["Main model", "false"], ["Sub-agents", "true"]], "the tab stays chosen while the level moves");
  assert.match(x.d.querySelector(".dgc-mp-under .dgc-mp-note").textContent, /Up to 4 at once \(Ultra\)\./);
  assert.match(x.p.tab("agents").title, /Up to 4 at once \(Ultra\)/);
  // Back to the main model's list, by the tab.
  await press(x, x.p.tab("main"));
  assert.ok(x.p.rows().length > 0 && !x.p.row("This Pip’s model"));
});

test("the arrow keys move between the two tabs; the picker opens on Main model each time", async () => {
  const x = await chat();
  const key = (node, k) => { node.dispatchEvent(new x.w.KeyboardEvent("keydown", { key: k, bubbles: true, composed: true, cancelable: true })); };
  key(x.p.tab("main"), "ArrowRight"); await x.drain();
  assert.deepEqual(x.p.tabs(), [["Main model", "false"], ["Sub-agents", "true"]]);
  assert.equal(x.d.activeElement.dataset.tab, "agents", "the focus goes with it");
  key(x.p.tab("agents"), "ArrowLeft"); await x.drain();
  assert.deepEqual(x.p.tabs(), [["Main model", "true"], ["Sub-agents", "false"]]);
  await press(x, x.p.tab("agents"));
  x.$("#chat-model").click(); await x.drain();
  assert.equal(x.p.open(), false, "the chip closes it");
  x.$("#chat-model").click(); await x.drain();
  assert.deepEqual(x.p.tabs(), [["Main model", "true"], ["Sub-agents", "false"]]);
});

test("a DGC before Pips API 97 has no sub-agents for a Pip: no tabs, and no Ultra", async () => {
  const x = await chat(96);
  assert.deepEqual(x.p.tabs(), []);
  assert.ok(x.p.rows().length > 0);
  assert.deepEqual(x.p.levels(), ["off", "low", "medium", "high", "xhigh"]);
});
