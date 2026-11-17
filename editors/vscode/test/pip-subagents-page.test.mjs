// A Pip's own sub-agents model (Pips API 104, 17 Nov): its picker's Sub-agents tab is Work's. "This Pip's model" (the
// dgc mark) first, then the connections its Main tab lists (a subscription app and DGC Router greyed with their reason);
// a pick is saved at once (set_pip_agents model_choice), then its page: their thinking, their window (only the sizes the
// model takes, asked of DGC through the host: pip_model_window), Custom…, Done; a row's ⋯ makes it their fallback.
// A DGC before 104: the tab as it was, read-only. The stand-in DGC is test/support/one-pips-scene.mjs.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { setup as open } from "./support/one-pips-node.mjs";
import { GST } from "./support/one-pips-scene.mjs";
import { PIP_CATALOG, PIP_MODELS, PIP_KEYED } from "./support/model-menu-scene.mjs";
import { pickerDom } from "./support/picker-dom.mjs";

const windows = [];
after(() => windows.forEach((w) => w.close()));
const chat = async (api = 104, scene = {}) => {
  const x = open({ api, scene: { sub: true, waiting: false, fix: "none", models: PIP_MODELS, catalog: PIP_CATALOG, windows: { "qwen3-coder:480b": 262144, "claude-opus-5-5": 200000 }, ...scene } });
  windows.push(x.w); await x.drain(); await x.openPip(GST); await x.drain();
  x.$("#chat-model").click(); await x.drain();
  const p = pickerDom(x.d);
  await press(x, p.tab("agents"));
  const page = () => { const n = x.d.querySelector(".dgc-mp-page"); return n && !n.hidden ? n : null; };
  const sizes = () => [...x.d.querySelectorAll(".dgc-mp-size")].map((b) => b.textContent);
  const agents = () => x.requests("set_pip_agents").map(({ type, request_id, ...r }) => r);
  return { ...x, p, page, sizes, agents };
};
const press = async (x, node) => { node.click(); await x.drain(); };
const key = async (x, node, k) => { node.dispatchEvent(new x.w.KeyboardEvent("keydown", { key: k, bubbles: true, composed: true, cancelable: true })); await x.drain(); };

test("Pips API 104: the Sub-agents tab is Work's: This Pip's model first, then the Main tab's connections; a CLI and the Router greyed with why", async () => {
  const x = await chat();
  assert.deepEqual(x.p.tabs(), [["Main model", "false"], ["Sub-agents", "true"]]);
  const names = x.p.connNames();
  assert.equal(names[0], "This Pip’s model");
  assert.equal(x.p.conn("pip").querySelector(".dgc-mp-mark").dataset.mark, "dgc", "the dgc mark");
  assert.deepEqual(names.slice(1), ["Ollama", "Ollama Cloud · cloud", "Anthropic API · your key", "DGC Router", "Claude Code · your subscription", "Codex · your subscription"], "the connections its Main tab lists");
  assert.deepEqual(x.p.names(), ["This Pip’s model"]);
  assert.deepEqual(x.p.chosen(), ["This Pip’s model"], "chosen until a model of their own is");
  assert.match(x.p.desc("This Pip’s model"), /^Now: \S+/);
  assert.match(x.d.querySelector(".dgc-mp-under .dgc-mp-note").textContent, /One at a time\./, "the slots line stays");
  for (const [id, why] of [["router", /^DGC Router can’t run a Pip’s sub-agents/], ["subscription:claude", /^It runs its own tools, so it can’t run DGC’s sub-agents\.$/], ["subscription:codex", /^It runs its own tools/]]) {
    assert.equal(x.p.conn(id).getAttribute("aria-disabled"), "true", id);
    await press(x, x.p.conn(id));
    assert.equal(x.p.rows().length, 0, `${id}: nothing to choose`);
    assert.match(x.p.list().textContent, why, `${id} says why (DGC's own words)`);
  }
  assert.equal(x.p.thinkName(), "", "their thinking is on the page, not under the list");
  assert.deepEqual(x.agents(), [], "looking changes nothing");
});

test("Pips API 104: a model is saved at once, then its page: their thinking, only the sizes it takes, Custom…, Back, Done", async () => {
  const x = await chat();
  await press(x, x.p.conn("connection"));
  await press(x, x.p.row("qwen3-coder:480b"));
  assert.deepEqual(x.agents(), [{ pip_id: GST, model_choice: { mode: "model", model: "qwen3-coder:480b" } }]);
  assert.ok(x.page(), "its page opens");
  assert.equal(x.d.querySelector(".dgc-mp-page-name").textContent, "qwen3-coder:480b");
  assert.equal(x.d.querySelector(".dgc-mp-page-conn").textContent, "Ollama");
  assert.equal(x.page().getAttribute("aria-label"), "qwen3-coder:480b for sub-agents");
  assert.deepEqual([...x.d.querySelectorAll("[data-pthink]")].map((b) => b.dataset.pthink), ["same", "off", "low", "medium", "high", "xhigh"]);
  assert.equal(x.d.querySelector("[data-pthink='same']").title, "Same as this Pip");
  assert.deepEqual(x.requests("pip_model_window").map((r) => r.model_choice), [{ mode: "model", model: "qwen3-coder:480b" }]);
  assert.deepEqual(x.sizes(), ["Same", "4K", "8K", "16K", "32K", "64K", "128K", "256K"], "a 256K model: no 512K, no 1M");
  assert.equal(x.d.querySelector(".dgc-mp-window-note").textContent, "This model takes up to 256K.");
  await press(x, x.d.querySelector("[data-pthink='high']"));
  await press(x, x.d.querySelector(".dgc-mp-size[data-size='65536']"));
  await press(x, x.d.querySelector(".dgc-mp-custom"));
  const field = x.d.querySelector(".dgc-mp-custom-input");
  field.value = "24k"; field.dispatchEvent(new x.w.Event("input", { bubbles: true, composed: true }));
  await key(x, field, "Enter");
  await press(x, x.d.querySelector(".dgc-mp-size[data-size='0']"));
  assert.deepEqual(x.agents().slice(1), [{ pip_id: GST, thinking: "high" }, { pip_id: GST, context_size: 65536 }, { pip_id: GST, context_size: 24576 }, { pip_id: GST, context_size: 0 }]);
  assert.equal(x.d.querySelector("[data-pthink='high']").getAttribute("aria-checked"), "true", "DGC's answer shows");
  await press(x, x.d.querySelector(".dgc-mp-back"));
  assert.equal(x.page(), null);
  assert.deepEqual(x.p.chosen(), ["qwen3-coder:480b"], "the list, on their own model");
  assert.ok(x.p.conn("connection").classList.contains("is-current"));
  // The chosen one again: its page, nothing saved, the window remembered.
  await press(x, x.p.row("qwen3-coder:480b"));
  assert.equal(x.agents().length, 5);
  assert.equal(x.requests("pip_model_window").length, 1, "asked once per model");
  await key(x, x.d.querySelector(".dgc-mp-back"), "Escape");
  assert.equal(x.page(), null, "Escape on the page is Back");
  await press(x, x.p.row("qwen3-coder:480b"));
  await press(x, x.d.querySelector(".dgc-mp-done"));
  assert.equal(x.p.open(), false, "Done closes the picker");
});

test("Pips API 104: a saved provider's model, its own window; This Pip's model goes back; ⋯ makes a model their fallback", async () => {
  const x = await chat();
  await press(x, x.p.conn(`provider:${PIP_KEYED}`));
  await press(x, x.p.row("claude-opus-5-5"));
  assert.deepEqual(x.agents().at(-1), { pip_id: GST, model_choice: { mode: "provider", provider: PIP_KEYED, model: "claude-opus-5-5" } });
  assert.equal(x.d.querySelector(".dgc-mp-page-conn").textContent, "Anthropic API");
  assert.deepEqual(x.sizes().slice(-2), ["128K", "200K"], "its own largest last");
  await press(x, x.d.querySelector(".dgc-mp-back"));
  // This Pip's model: back to today's behaviour, and its page too.
  await press(x, x.p.conn("pip"));
  await press(x, x.p.row("This Pip’s model"));
  assert.deepEqual(x.agents().at(-1), { pip_id: GST, model_choice: { mode: "default" } });
  assert.equal(x.d.querySelector(".dgc-mp-page-name").textContent, "This Pip’s model");
  await press(x, x.d.querySelector(".dgc-mp-back"));
  // Their fallback, from a row's ⋯.
  await press(x, x.p.conn(`provider:${PIP_KEYED}`));
  await press(x, x.p.more("claude-opus-5-5"));
  assert.deepEqual(x.p.choices().map((b) => b.textContent), ["Use as fallback"]);
  await press(x, x.p.choices()[0]);
  assert.deepEqual(x.agents().at(-1), { pip_id: GST, fallback: { provider: PIP_KEYED, model: "claude-opus-5-5" } });
  assert.equal(x.page(), null, "the ⋯ never opens the page");
  assert.deepEqual(x.p.pills(), [["claude-opus-5-5", "Fallback"]]);
  await press(x, x.p.more("claude-opus-5-5"));
  assert.deepEqual(x.p.choices().map((b) => b.textContent), ["Stop using as fallback"]);
  await press(x, x.p.choices()[0]);
  assert.deepEqual(x.agents().at(-1), { pip_id: GST, fallback: { provider: "", model: "" } });
  assert.deepEqual(x.p.pills(), []);
  // A model on its own connection as the fallback: no provider.
  await press(x, x.p.conn("connection"));
  await press(x, x.p.more("glm-5.3:cloud"));
  await press(x, x.p.choices()[0]);
  assert.deepEqual(x.agents().at(-1), { pip_id: GST, fallback: { provider: "", model: "glm-5.3:cloud" } });
});

test("Pips API 104: what DGC keeps shows when the tab opens: their own model chosen, its connection marked, their fallback said", async () => {
  const x = await chat(104, { agentsOwn: { model_choice: { mode: "provider", provider: PIP_KEYED, model: "claude-opus-5-5" }, thinking: "low", context_size: 32768, fallback: { provider: "", model: "glm-5.3:cloud" } } });
  assert.equal(x.p.conn(`provider:${PIP_KEYED}`).getAttribute("aria-selected"), "true", "the tab opens on where their own model runs");
  assert.deepEqual(x.p.chosen(), ["claude-opus-5-5"]);
  assert.match(x.p.tab("agents").title, /claude-opus-5-5/);
  await press(x, x.p.row("claude-opus-5-5"));
  assert.equal(x.d.querySelector("[data-pthink][aria-checked='true']").dataset.pthink, "low");
  assert.equal(x.d.querySelector(".dgc-mp-size[aria-checked='true']").textContent, "32K");
  await press(x, x.d.querySelector(".dgc-mp-back"));
  await press(x, x.p.conn("connection"));
  assert.deepEqual(x.p.pills(), [["glm-5.3:cloud", "Fallback"]]);
});

test("a DGC before Pips API 104: the Sub-agents tab as it was, read-only", async () => {
  const x = await chat(103);
  assert.deepEqual(x.p.names(), ["This Pip’s model"]);
  assert.deepEqual(x.p.connNames(), ["This Pip’s model"], "no connections to choose from");
  assert.equal(x.p.box().querySelectorAll(".dgc-mp-more, .dgc-mp-action").length, 0);
  await press(x, x.p.row("This Pip’s model"));
  assert.equal(x.page(), null, "no page");
  assert.deepEqual(x.agents(), []);
  assert.deepEqual(x.requests("pip_model_window"), []);
});
