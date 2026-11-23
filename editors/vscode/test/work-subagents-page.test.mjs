// Work's Sub-agents page (17 Nov, asked: "when user selects a sub agent model, then we further take user to a next
// page to select the context window and thinking effort, and context size only shows options of what that model is
// capable of"; "and what about selecting fallback main model and sub agent model?"). On the picker's Sub-agents tab a
// model is chosen and saved at once, then its page opens in the same dialog: Their thinking, Their context window (only
// the sizes the model takes, asked of DGC once per model: model_window_at through the extension), Custom…, Done. A row's
// ⋯ makes it the sub-agents' own fallback (subagent_fallback). media/main.js on media/shared/modelpicker.js, in jsdom.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom } from "./support/webview-dom.mjs";
import { pickerDom } from "./support/picker-dom.mjs";

const SPARE = `provider_${"c".repeat(32)}`;
const ROUTES = [{ key: "native", label: "Current host · Ollama" },
  { key: SPARE, label: "Spare", kind: "native", base_url: "https://spare.example/v1", model: "gpt-oss:120b" },
  { key: "subscription_claude", label: "Claude Code", kind: "subscription", engine: "claude" }];
const AGENTS = (extra = {}) => ({ offered: true, own: false, model: "qwen3-coder", base_url: "", settings_model: "qwen3-coder", settings_base_url: "", router: false,
  thinking: "", thinking_settable: true, context_size: 0, context_settable: true, window_offered: true, fallback_offered: true,
  fallback_own: false, fallback_model: "", fallback_base_url: "", ...extra });
const IDS = ["deepseek-v4.1-flash:cloud", "glm-5.3:cloud"];
const plain = (value) => JSON.parse(JSON.stringify(value));

function opened(agents = AGENTS()) {
  const v = makeDom({ clock: true });
  v.doc.getElementById("btn-model").click();
  v.send({ type: "models", ids: IDS, current: IDS[0], routes: ROUTES, currentRouteKey: "native", base: "http://localhost:11434/v1", fallback: { offered: false }, agents });
  const p = pickerDom(v.doc);
  const last = (type) => plain(v.posted.filter((m) => m.type === type).at(-1) ?? null);
  const all = (type) => plain(v.posted.filter((m) => m.type === type));
  const $ = (s) => v.doc.querySelector(s), $$ = (s) => [...v.doc.querySelectorAll(s)];
  const page = () => { const n = $(".dgc-mp-page"); return n && !n.hidden ? n : null; };
  const sizes = () => $$(".dgc-mp-size").map((b) => b.textContent);
  const key = (node, k) => node.dispatchEvent(new v.dom.window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  const spare = () => { p.tab("agents").click(); p.conn(SPARE).click(); v.send({ type: "providerModels", id: SPARE, ids: ["gpt-oss:120b", "own-coder"] }); };
  return { ...v, p, last, all, $, $$, page, sizes, key, spare };
}

test("Work: choosing a sub-agents' model saves it, then its page opens: Back, the model, its connection, their thinking and window, Done", () => {
  const a = opened();
  a.spare();
  a.p.row("own-coder").click();
  assert.deepEqual(a.last("setAgentsModel"), { type: "setAgentsModel", provider: SPARE, model: "own-coder" }, "saved at once");
  assert.ok(a.page(), "the page opens in the same dialog");
  assert.equal(a.p.open(), true);
  assert.equal(a.$(".dgc-mp-page-name").textContent, "own-coder");
  assert.equal(a.$(".dgc-mp-page-conn").textContent, "Spare");
  assert.equal(a.page().getAttribute("aria-label"), "own-coder for sub-agents");
  assert.equal(a.doc.activeElement, a.$(".dgc-mp-back"), "the focus is on Back");
  assert.deepEqual(a.$$(".dgc-mp-page [data-pthink]").map((b) => b.dataset.pthink), ["same", "off", "low", "medium", "high", "xhigh"]);
  assert.equal(a.$(".dgc-mp-page [data-pthink='same']").title, "Same as the session");
  // Its largest window is asked of DGC, once; meanwhile every size shows and it says so.
  assert.deepEqual(a.all("agentsWindow"), [{ type: "agentsWindow", provider: SPARE, model: "own-coder" }]);
  assert.equal(a.$(".dgc-mp-window-note").textContent, "Checking this model’s largest window…");
  assert.deepEqual(a.sizes(), ["Same", "4K", "8K", "16K", "32K", "64K", "128K", "256K", "512K", "1M"]);
  a.send({ type: "agentsWindow", provider: SPARE, model: "own-coder", window: 262144 });
  assert.deepEqual(a.sizes(), ["Same", "4K", "8K", "16K", "32K", "64K", "128K", "256K"], "a 256K model: no 512K, no 1M");
  assert.equal(a.$(".dgc-mp-window-note").textContent, "This model takes up to 256K.");
  // The list view no longer carries their thinking or window: they are this page's.
  a.$(".dgc-mp-back").click();
  assert.equal(a.page(), null);
  assert.equal(a.p.setting("context"), null);
  assert.equal(a.p.thinkName(), "", "no Thinking under the sub-agents' list");
  assert.equal(a.doc.activeElement?.dataset.value, "own-coder", "back on the chosen model");
  // The same model again: no second question, and no second save.
  const saves = a.all("setAgentsModel").length;
  a.p.row("own-coder").click();
  assert.equal(a.all("setAgentsModel").length, saves, "the chosen one is chosen already: its page opens");
  assert.equal(a.all("agentsWindow").length, 1, "asked once per model");
  assert.deepEqual(a.sizes().at(-1), "256K");
  assert.deepEqual(a.errors, []);
});

test("Work: the page's choices tell DGC: their thinking, a size, Same, a typed size; Done closes the picker", () => {
  const a = opened(AGENTS({ own: true, model: "own-coder", base_url: "https://spare.example/v1" }));
  a.spare();
  a.p.row("own-coder").click();
  a.send({ type: "agentsWindow", provider: SPARE, model: "own-coder", window: 131072 });
  a.$(".dgc-mp-page [data-pthink='high']").click();
  assert.deepEqual(a.last("setAgentsThinking"), { type: "setAgentsThinking", level: "high" });
  assert.equal(a.$(".dgc-mp-page [data-pthink='high']").getAttribute("aria-checked"), "true", "shown at once");
  a.$(".dgc-mp-page [data-pthink='same']").click();
  assert.deepEqual(a.last("setAgentsThinking"), { type: "setAgentsThinking", level: "" });
  a.$(".dgc-mp-size[data-size='65536']").click();
  assert.deepEqual(a.last("setAgentsContext"), { type: "setAgentsContext", size: 65536 });
  assert.equal(a.$(".dgc-mp-size[data-size='65536']").getAttribute("aria-checked"), "true");
  a.$(".dgc-mp-custom").click();
  const field = a.$(".dgc-mp-custom-input");
  assert.equal(a.doc.activeElement, field);
  field.value = "24,576"; field.dispatchEvent(new a.dom.window.Event("input", { bubbles: true }));
  a.key(field, "Enter");
  assert.deepEqual(a.last("setAgentsContext"), { type: "setAgentsContext", size: 24576 }, "typed right there: no VS Code box");
  assert.equal(a.all("agentsContextTyped").length, 0);
  assert.deepEqual(a.sizes(), ["Same", "4K", "8K", "16K", "24K", "32K", "64K", "128K"]);
  a.$(".dgc-mp-size[data-size='0']").click();
  assert.deepEqual(a.last("setAgentsContext"), { type: "setAgentsContext", size: 0 }, "Same: the session's own");
  // The arrow keys rest before DGC is told: one setting, not one per step.
  const before = a.all("setAgentsThinking").length;
  a.$(".dgc-mp-page [data-pthink='same']").focus();
  a.key(a.$(".dgc-mp-page [data-pthink='same']"), "ArrowRight");
  a.key(a.doc.activeElement, "ArrowRight");
  assert.equal(a.all("setAgentsThinking").length, before, "not yet");
  a.advance(1000);
  assert.deepEqual(a.all("setAgentsThinking").slice(before), [{ type: "setAgentsThinking", level: "low" }]);
  a.$(".dgc-mp-done").click();
  assert.equal(a.p.open(), false, "Done closes the picker");
  assert.deepEqual(a.errors, []);
});

test("Work: Escape on the page is Back; a second Escape closes; a DGC that can't say a window shows every size", () => {
  const a = opened(AGENTS({ window_offered: false }));
  a.spare();
  a.p.row("gpt-oss:120b").click();
  assert.equal(a.all("agentsWindow").length, 0, "nothing to ask: this DGC has no model_window_at");
  assert.equal(a.$(".dgc-mp-window-note").textContent, "DGC couldn’t learn this model’s largest window, so every size shows.");
  assert.equal(a.sizes().length, 10);
  a.key(a.$(".dgc-mp-back"), "Escape");
  assert.equal(a.page(), null, "Escape goes back to the list");
  assert.equal(a.p.open(), true);
  a.key(a.doc.activeElement, "Escape");
  assert.equal(a.p.open(), false);
  assert.deepEqual(a.errors, []);
});

test("Work: Settings' choice opens the page too, for what Settings has now", () => {
  const a = opened(AGENTS({ own: true, model: "own-coder", base_url: "https://spare.example/v1", settings_model: "qwen3-coder" }));
  a.p.tab("agents").click();
  a.p.conn("agents:settings").click();
  a.p.row("Settings’ choice").click();
  assert.deepEqual(a.last("resetAgentsModel"), { type: "resetAgentsModel" });
  assert.ok(a.page());
  assert.equal(a.$(".dgc-mp-page-name").textContent, "Settings’ choice");
  assert.equal(a.$(".dgc-mp-page-conn").textContent, "Now: qwen3-coder");
  assert.deepEqual(a.last("agentsWindow"), { type: "agentsWindow", settings: true, model: "qwen3-coder" });
  a.send({ type: "agentsWindow", settings: true, model: "qwen3-coder", window: 204800 });
  assert.deepEqual(a.sizes().slice(-2), ["128K", "200K"], "its own largest last");
  // With DGC Router on, nothing to ask: the Router picks a worker for each.
  const routed = opened(AGENTS({ router: true }));
  routed.p.tab("agents").click();
  routed.p.row("Settings’ choice").click();
  assert.equal(routed.all("resetAgentsModel").length, 0, "already following Settings: nothing to save");
  assert.equal(routed.all("agentsWindow").length, 0);
  assert.equal(routed.$(".dgc-mp-page-conn").textContent, "Now: DGC Router");
  assert.deepEqual(a.errors, []);
});

test("Work: a row's ⋯ makes it the sub-agents' fallback, and the row says Fallback; never a CLI; only where DGC has it", () => {
  const a = opened();
  a.spare();
  const more = a.p.more("gpt-oss:120b");
  assert.ok(more, "a ⋯ on a model DGC runs itself");
  more.click();
  assert.deepEqual(a.p.choices().map((b) => b.textContent), ["Use as fallback"]);
  a.p.choices()[0].click();
  assert.deepEqual(a.last("setAgentsFallback"), { type: "setAgentsFallback", provider: SPARE, model: "gpt-oss:120b" });
  assert.deepEqual(a.p.pills(), [["gpt-oss:120b", "Fallback"]], "shown at once");
  assert.equal(a.page(), null, "the ⋯ never opens the page");
  // DGC's answer is what it shows from then on; the chosen row says Main once there is a fallback.
  a.send({ type: "agentsModel", ...AGENTS({ own: true, model: "own-coder", base_url: "https://spare.example/v1", fallback_own: true, fallback_model: "gpt-oss:120b", fallback_base_url: "https://spare.example/v1" }) });
  assert.deepEqual(a.p.pills(), [["gpt-oss:120b", "Fallback"], ["own-coder", "Main"]]);
  a.p.more("gpt-oss:120b").click();
  assert.deepEqual(a.p.choices().map((b) => b.textContent), ["Stop using as fallback"]);
  a.p.choices()[0].click();
  assert.deepEqual(a.last("setAgentsFallback"), { type: "setAgentsFallback", provider: SPARE, model: "" });
  assert.deepEqual(a.p.pills(), []);
  // This chat's own host: its fallback is named with no provider.
  a.p.conn("native").click();
  a.p.more("glm-5.3:cloud").click();
  a.p.choices()[0].click();
  assert.deepEqual(a.last("setAgentsFallback"), { type: "setAgentsFallback", provider: "", model: "glm-5.3:cloud" });
  // Claude Code is greyed: nothing of it to choose. Settings' choice has no ⋯.
  assert.equal(a.p.conn("subscription_claude").getAttribute("aria-disabled"), "true");
  a.p.conn("agents:settings").click();
  assert.equal(a.p.more("Settings’ choice"), null);
  // A DGC without the sub-agents' fallback: no ⋯.
  const old = opened(AGENTS({ fallback_offered: false }));
  old.spare();
  assert.equal(old.doc.querySelector(".dgc-mp-more"), null);
  assert.deepEqual(a.errors, []);
  assert.deepEqual(old.errors, []);
});
