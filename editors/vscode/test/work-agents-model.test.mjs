// A Work session's own agents model (0.52, 14 Nov): the Agents row in Work's model menu says what this session's agents
// use ("Same as settings · qwen3-coder", or its own "own-coder · Spare"), and opens the same list the main model uses,
// to choose for agents: Same as settings first, every provider and its models, a subscription CLI greyed with its reason
// (never hidden). An override is visible: the model button's tooltip names it, and every agent row in the agent map
// names its model, always.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom } from "./support/webview-dom.mjs";

const SPARE = `provider_${"c".repeat(32)}`;
const LISTS = `provider_${"d".repeat(32)}`;
const ROUTES = [{ key: "native", label: "Current host · Ollama" },
  { key: SPARE, label: "Spare", kind: "native", base_url: "https://spare.example/v1", model: "gpt-oss:120b" },
  { key: LISTS, label: "Open host", kind: "native", base_url: "https://open.example/v1", model: "", allModels: true },
  { key: "subscription_claude", label: "Claude Code", kind: "subscription", engine: "claude" },
  { key: "codex", label: "Codex", kind: "subscription", engine: "codex" }];
const AGENTS = (extra = {}) => ({ offered: true, own: false, model: "qwen3-coder", base_url: "", settings_model: "qwen3-coder",
  settings_base_url: "", router: false, ...extra });
const IDS = ["deepseek-v4.1-flash:cloud", "glm-5.3:cloud"];
const plain = (value) => JSON.parse(JSON.stringify(value));

function opened(agents, more = {}) {
  const v = makeDom();
  v.doc.getElementById("btn-model").click();
  v.send({ type: "models", ids: IDS, current: IDS[0], routes: ROUTES, currentRouteKey: "native",
    fallback: { offered: false }, agents, ...more });
  const menu = v.doc.getElementById("modelmenu");
  const row = () => menu.querySelector('.model-tabs [data-model-tab="agents"]');
  const last = (type) => plain(v.posted.filter((m) => m.type === type).at(-1) ?? null);
  return { ...v, menu, row, last };
}

test("Work: the Agents row says what this session's agents use; an older CLI has none", () => {
  const a = opened(AGENTS());
  assert.ok(a.row(), "the row is in the menu, beside the model and thinking choices");
  assert.equal(a.row().textContent, "Sub-agents", "as Settings › Sub-agents names them");
  assert.equal(a.row().title.replace(/^Sub-agents: /, ""), "Same as settings · qwen3-coder");
  assert.equal(a.row().getAttribute("aria-selected"), "false");
  assert.ok(a.menu.querySelector(".effort-slider"), "thinking stays where it was");
  assert.ok(a.menu.querySelector('[data-i="0"]'), "and so do the session's models");
  assert.deepEqual(a.errors, []);

  const none = opened(AGENTS({ model: "", settings_model: "" }));
  assert.equal(none.row().title.replace(/^Sub-agents: /, ""), "Same as this session’s model");

  const own = opened(AGENTS({ own: true, model: "own-coder", base_url: "https://spare.example/v1" }));
  assert.equal(own.row().title.replace(/^Sub-agents: /, ""), "own-coder · Spare");
  const here = opened(AGENTS({ own: true, model: "glm-5.3:cloud", base_url: "" }));
  assert.equal(here.row().title.replace(/^Sub-agents: /, ""), "glm-5.3:cloud · Ollama", "a model of this chat's own host");
  const elsewhere = opened(AGENTS({ own: true, model: "m1", base_url: "https://agents.example:8443/v1" }));
  assert.equal(elsewhere.row().title.replace(/^Sub-agents: /, ""), "m1 · agents.example:8443", "an address no provider lists: its host");

  const routed = opened(AGENTS({ router: true }));
  assert.equal(routed.row().title.replace(/^Sub-agents: /, ""), "Same as settings · DGC Router");

  const old = opened({ offered: false });
  assert.equal(old.row(), null, "a CLI that doesn't offer it: no row");
  const older = opened(undefined);
  assert.equal(older.row(), null);
  assert.deepEqual(older.errors, []);
});

test("Work: Agents opens the same list to choose for agents: Same as settings first, every provider, a subscription greyed with its reason", () => {
  const a = opened(AGENTS());
  a.row().click();
  assert.equal(a.row().getAttribute("aria-selected"), "true");
  assert.ok(a.menu.querySelector(".effort-slider"), "the model and thinking card stays mounted");
  assert.equal(a.menu.querySelector("[data-i]"), null, "the session's own model rows are away while agents are chosen");
  const rows = [...a.menu.querySelectorAll(".model-options .model-list-scroll > *")];
  const same = rows[0];
  assert.ok(same.matches("[data-agents-same]"), "Same as settings is the first row");
  assert.equal(same.querySelector(".dgc-menu-label").textContent, "Settings’ choice");
  assert.equal(same.querySelector(".agents-same-what").textContent, "Now: qwen3-coder", "what that is, on its own line, never cut");
  assert.equal(same.getAttribute("aria-checked"), "true", "checked while the session follows Settings");
  assert.deepEqual([...a.menu.querySelectorAll("[data-agents-provider]")].map((b) => b.querySelector(".dgc-menu-label").textContent),
    ["Ollama", "Spare", "Open host"], "a provider by its own name (\"Current host · \" is the main list's)");
  // Claude Code and Codex: shown, greyed, with the reason; never hidden, and never chosen.
  const off = [...a.menu.querySelectorAll("[data-agents-no]")];
  assert.deepEqual(off.map((b) => b.querySelector(".dgc-menu-label").textContent), ["Claude Code", "Codex"]);
  for (const button of off) {
    assert.equal(button.getAttribute("aria-disabled"), "true");
    assert.equal(button.querySelector(".dgc-menu-sub").textContent, "Runs its own tools, so it can’t run DGC’s agents");
    const before = a.posted.length;
    button.click();
    assert.equal(a.posted.length, before, "nothing is sent");
  }
  assert.equal(a.menu.querySelector("[data-fb-more]"), null, "no fallback ⋯ in this list");
  assert.equal(a.menu.querySelector(".model-options [data-agents-typed]"), null);
  // Back returns to the menu.
  a.menu.querySelector('.model-tabs [data-model-tab="main"]').click();
  assert.ok(a.menu.querySelector('[data-i="0"]'), "the session's models again");
  assert.equal(a.row().getAttribute("aria-selected"), "false");
  assert.deepEqual(a.errors, []);
});

test("Work: a provider's models in the agents list; choosing one is this session's own, and Same as settings goes back", () => {
  const a = opened(AGENTS());
  a.row().click();
  a.menu.querySelector('[data-agents-provider="1"]').click();
  assert.deepEqual(a.last("providerModels"), { type: "providerModels", id: SPARE }, "its host is asked what it offers");
  assert.match(a.menu.querySelector(".model-options").textContent, /Listing its models…/);
  a.send({ type: "providerModels", id: SPARE, ids: ["gpt-oss:120b", "own-coder"] });
  const models = () => [...a.menu.querySelectorAll("[data-agents-model]")];
  assert.deepEqual(models().map((b) => b.querySelector(".dgc-menu-label").textContent), ["gpt-oss:120b", "own-coder"]);
  assert.ok(models().every((b) => b.getAttribute("aria-checked") === "false"));
  assert.ok(a.menu.querySelector("[data-agents-typed]"), "a model its host doesn't list can be named");
  models()[1].click();
  assert.deepEqual(a.last("setAgentsModel"), { type: "setAgentsModel", provider: SPARE, model: "own-coder" });
  assert.equal(a.posted.filter((m) => m.type === "setSubscription" || m.type === "setModel").length, 0, "the session's own model never moves");
  assert.equal(a.menu.hidden, false, "the menu stays, and says what was chosen");
  assert.equal(a.row().title.replace(/^Sub-agents: /, ""), "own-coder · Spare");
  // DGC's answer is what it shows from then on.
  a.send({ type: "agentsModel", ...AGENTS({ own: true, model: "own-coder", base_url: "https://spare.example/v1" }) });
  assert.equal(a.row().title.replace(/^Sub-agents: /, ""), "own-coder · Spare");
  assert.deepEqual(models().map((b) => b.getAttribute("aria-checked")), ["false", "true"], "still on its models, the chosen one checked");
  a.menu.querySelector("[data-agents-providers]").click();          // back to the agents list
  assert.equal(a.menu.querySelector("[data-agents-same]").getAttribute("aria-checked"), "false");
  assert.equal(a.menu.querySelector('[data-agents-provider="1"]').getAttribute("aria-checked"), "true", "its provider is the checked one");
  a.menu.querySelector('[data-agents-provider="1"]').click();
  a.send({ type: "providerModels", id: SPARE, ids: ["gpt-oss:120b", "own-coder"] });
  assert.deepEqual(models().map((b) => b.getAttribute("aria-checked")), ["false", "true"], "the chosen model is checked");
  a.menu.querySelector("[data-agents-providers]").click();
  a.menu.querySelector("[data-agents-same]").click();
  assert.deepEqual(a.last("resetAgentsModel"), { type: "resetAgentsModel" });
  assert.equal(a.row().title.replace(/^Sub-agents: /, ""), "Same as settings · qwen3-coder");
  assert.deepEqual(a.errors, []);
});

test("Work: this chat's own host lists its models for agents without asking again; a host that lists none takes a typed name", () => {
  const a = opened(AGENTS());
  a.row().click();
  a.menu.querySelector('[data-agents-provider="0"]').click();
  assert.equal(a.last("providerModels"), null, "the menu already has this host's models");
  const models = [...a.menu.querySelectorAll("[data-agents-model]")];
  assert.deepEqual(models.map((b) => b.querySelector(".dgc-menu-label").textContent), IDS);
  models[1].click();
  assert.deepEqual(a.last("setAgentsModel"), { type: "setAgentsModel", provider: "", model: "glm-5.3:cloud" });
  assert.equal(a.row().title.replace(/^Sub-agents: /, ""), "glm-5.3:cloud · Ollama");
  a.menu.querySelector("[data-agents-providers]").click();
  a.menu.querySelector('[data-agents-provider="2"]').click();
  a.send({ type: "providerModels", id: LISTS, ids: [] });
  assert.match(a.menu.querySelector(".model-options").textContent, /It lists no models/);
  a.menu.querySelector("[data-agents-typed]").click();
  assert.deepEqual(a.last("agentsModelTyped"), { type: "agentsModelTyped", id: LISTS });
  assert.deepEqual(a.errors, []);
});

test("Work: with DGC Router on, Same as settings is the Router's row; a session's own choice still shows as its own", () => {
  const a = opened(AGENTS({ router: true }));
  a.row().click();
  const same = a.menu.querySelector("[data-agents-same]");
  assert.equal(same.querySelector(".dgc-menu-label").textContent, "Settings’ choice");
  assert.equal(same.querySelector(".dgc-menu-sub").textContent, "Now: DGC Router, which picks a free worker for each sub-agent");
  assert.equal(same.getAttribute("aria-checked"), "true");
  const own = opened(AGENTS({ router: true, own: true, model: "own-coder", base_url: "https://spare.example/v1" }));
  assert.equal(own.row().title.replace(/^Sub-agents: /, ""), "own-coder · Spare", "its own wins over the Router");
  own.row().click();
  assert.equal(own.menu.querySelector("[data-agents-same]").getAttribute("aria-checked"), "false");
  assert.deepEqual(own.errors, []);
});

test("Work: a session's own agents model is on the model button's tooltip and its label; following Settings adds nothing", () => {
  const v = makeDom();
  v.send({ type: "state", state: { model: "qwen3.8:27b", mode: "default", think: "off" } });
  const button = v.doc.getElementById("btn-model");
  assert.doesNotMatch(button.title, /Agents/);
  v.send({ type: "agentsModel", ...AGENTS() });
  assert.doesNotMatch(button.title, /Agents/, "following Settings: nothing to say");
  assert.equal(button.dataset.agentsOwn, undefined);
  v.send({ type: "agentsModel", ...AGENTS({ own: true, model: "own-coder", base_url: "https://spare.example/v1" }) });
  assert.match(button.title, /Sub-agents: own-coder \(this session’s own\)/);
  assert.match(button.getAttribute("aria-label"), /Sub-agents: own-coder/);
  assert.equal(button.dataset.agentsOwn, "1");
  v.send({ type: "state", state: { model: "qwen3.8:27b", mode: "default", think: "low" } });
  assert.match(button.title, /Sub-agents: own-coder/, "kept when the button is drawn again");
  v.send({ type: "agentsModel", ...AGENTS() });
  assert.doesNotMatch(button.title, /Agents/);
  assert.deepEqual(v.errors, []);
});

test("the agent map: every agent row names its model, always", () => {
  const v = makeDom();
  const event = (data) => v.send({ type: "event", event: data });
  event({ type: "ready", model: "qwen3.8:27b", mode: "default", think: "off", base_url: "http://127.0.0.1:1/v1", workspace_trusted: true,
    commands: [], custom_commands: [], goal: { text: "", status: "none" }, context_size: 1, capabilities: { agents: true, agent_control: true } });
  v.send({ type: "state", state: { model: "qwen3.8:27b", mode: "default", think: "off" } });
  v.send({ type: "session_ready", sessionId: "s1" });
  const sid = (n) => `sub-${String(n).padStart(12, "0")}`;
  const start = (n, fields = {}) => event({ type: "agent_started", id: sid(n), parent_id: null, call_id: `call_${n}`, description: `agent ${n}`,
    depth: 1, state: "running", started_at: 1000 + n, isolated: false, parallel: false, ...fields });
  start(1, { model: "qwen3.8:27b" });                 // the chat's own model: it was left out before
  start(2, { model: "deepseek-v4.1-flash" });
  start(3);                                           // DGC named none: this session's agents model, as DGC said it
  v.doc.getElementById("agents-pill").click();
  const meta = (n) => v.doc.querySelector(`#agent-map .am-row[data-am-key="agent:${sid(n)}"] .am-meta`).textContent;
  assert.match(meta(1), /qwen3\.8:27b/, "an agent on the chat's own model says so");
  assert.match(meta(2), /deepseek-v4\.1-flash/);
  assert.match(meta(3), /qwen3\.8:27b/, "with no agents model anywhere, the chat's");
  v.send({ type: "agentsModel", ...AGENTS({ own: true, model: "own-coder", base_url: "https://spare.example/v1" }) });
  assert.match(meta(3), /own-coder/, "the session's own agents model");
  assert.match(meta(1), /qwen3\.8:27b/, "what DGC named for an agent is never replaced");
  assert.deepEqual(v.errors, []);
});
