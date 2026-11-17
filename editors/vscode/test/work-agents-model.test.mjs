// A Work session's own agents model (0.52, 14 Nov; in the one model picker since 17 Nov): the picker's Sub-agents tab
// says what this session's agents use ("Same as settings · qwen3-coder", or its own "own-coder · Spare"), and lists the
// same connections the main model has, to choose for agents: Settings' choice first, every provider and its models, a
// subscription CLI greyed with its reason (never hidden). An override is visible: the model button's tooltip names it,
// and every agent row in the agent map names its model, always.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom } from "./support/webview-dom.mjs";
import { pickerDom } from "./support/picker-dom.mjs";

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
  v.send({ type: "models", ids: IDS, current: IDS[0], routes: ROUTES, currentRouteKey: "native", base: "http://localhost:11434/v1",
    fallback: { offered: false }, agents, ...more });
  const p = pickerDom(v.doc);
  const row = () => p.tab("agents");
  const says = () => row().title.replace(/^Sub-agents: /, "");
  const last = (type) => plain(v.posted.filter((m) => m.type === type).at(-1) ?? null);
  return { ...v, p, row, says, last };
}

test("Work: the Sub-agents tab says what this session's agents use; an older CLI has none", () => {
  const a = opened(AGENTS());
  assert.ok(a.row(), "the tab is in the picker, over the model and thinking choices");
  assert.equal(a.row().textContent, "Sub-agents", "as Settings › Sub-agents names them");
  assert.equal(a.says(), "Same as settings · qwen3-coder");
  assert.deepEqual(a.p.tabs(), [["Main model", "true"], ["Sub-agents", "false"]]);
  assert.ok(a.p.level("off"), "thinking stays where it was");
  assert.deepEqual(a.p.names(), IDS, "and so do the session's models");
  assert.deepEqual(a.errors, []);

  const none = opened(AGENTS({ model: "", settings_model: "" }));
  assert.equal(none.says(), "Same as this session’s model");

  const own = opened(AGENTS({ own: true, model: "own-coder", base_url: "https://spare.example/v1" }));
  assert.equal(own.says(), "own-coder · Spare");
  const here = opened(AGENTS({ own: true, model: "glm-5.3:cloud", base_url: "" }));
  assert.equal(here.says(), "glm-5.3:cloud · Ollama", "a model of this chat's own host");
  const elsewhere = opened(AGENTS({ own: true, model: "m1", base_url: "https://agents.example:8443/v1" }));
  assert.equal(elsewhere.says(), "m1 · agents.example:8443", "an address no provider lists: its host");

  const routed = opened(AGENTS({ router: true }));
  assert.equal(routed.says(), "Same as settings · DGC Router");

  const old = opened({ offered: false });
  assert.equal(old.row(), null, "a CLI that doesn't offer it: no tab");
  assert.deepEqual(old.p.tabs(), []);
  const older = opened(undefined);
  assert.equal(older.row(), null);
  assert.deepEqual(older.errors, []);
});

test("Work: Sub-agents lists the same connections to choose for agents: Settings' choice first, every provider, a subscription greyed with its reason", () => {
  const a = opened(AGENTS());
  a.row().click();
  assert.deepEqual(a.p.tabs(), [["Main model", "false"], ["Sub-agents", "true"]]);
  assert.deepEqual(a.last("getAgentsModel"), { type: "getAgentsModel" }, "as the tab opens: what DGC has now");
  assert.deepEqual(a.p.connNames(), ["Settings’ choice", "Ollama", "Spare · your key", "Open host · your key", "Claude Code · your subscription", "Codex · your subscription"],
    "a provider by its own name (\"Current host · \" is never said)");
  assert.equal(a.p.conn("agents:settings").getAttribute("aria-selected"), "true", "Settings' choice is the first, and shown while the session follows Settings");
  assert.deepEqual(a.p.names(), ["Settings’ choice"]);
  assert.equal(a.p.desc("Settings’ choice"), "Now: qwen3-coder", "what that is, on its own line");
  assert.deepEqual(a.p.chosen(), ["Settings’ choice"], "checked while the session follows Settings");
  // Claude Code and Codex: shown, greyed, with the reason; never hidden, and never chosen.
  for (const id of ["subscription_claude", "codex"]) {
    const button = a.p.conn(id);
    assert.equal(button.getAttribute("aria-disabled"), "true");
    assert.match(button.getAttribute("aria-label"), /Runs its own tools, so it can’t run DGC’s agents/);
    const before = a.posted.length;
    button.click();
    assert.equal(a.p.list().textContent, "Runs its own tools, so it can’t run DGC’s agents.");
    assert.equal(a.p.rows().length, 0, "nothing of it to choose");
    assert.equal(a.posted.length, before, "nothing is sent");
  }
  assert.equal(a.doc.querySelector(".dgc-mp-more"), null, "no fallback ⋯ in this tab");
  // Back to the main tab.
  a.p.tab("main").click();
  assert.deepEqual(a.p.names(), IDS, "the session's models again");
  assert.deepEqual(a.p.tabs(), [["Main model", "true"], ["Sub-agents", "false"]]);
  assert.deepEqual(a.errors, []);
});

test("Work: a provider's models for agents; choosing one is this session's own, and Settings' choice goes back", () => {
  const a = opened(AGENTS());
  a.row().click();
  a.p.conn(SPARE).click();
  assert.deepEqual(a.last("providerModels"), { type: "providerModels", id: SPARE }, "its host is asked what it offers");
  assert.match(a.p.list().textContent, /Listing its models…/);
  a.send({ type: "providerModels", id: SPARE, ids: ["gpt-oss:120b", "own-coder"] });
  assert.deepEqual(a.p.names(), ["gpt-oss:120b", "own-coder"]);
  assert.deepEqual(a.p.chosen(), []);
  assert.ok(a.p.foot("agentsTyped"), "a model its host doesn't list can be named");
  a.p.row("own-coder").click();
  assert.deepEqual(a.last("setAgentsModel"), { type: "setAgentsModel", provider: SPARE, model: "own-coder" });
  assert.equal(a.posted.filter((m) => m.type === "setSubscription" || m.type === "setModel").length, 0, "the session's own model never moves");
  assert.equal(a.p.open(), true, "the picker stays, and says what was chosen");
  assert.equal(a.says(), "own-coder · Spare");
  assert.deepEqual(a.p.chosen(), ["own-coder"], "shown at once");
  // DGC's answer is what it shows from then on.
  a.send({ type: "agentsModel", ...AGENTS({ own: true, model: "own-coder", base_url: "https://spare.example/v1" }) });
  assert.equal(a.says(), "own-coder · Spare");
  assert.deepEqual(a.p.chosen(), ["own-coder"], "still on its models, the chosen one checked");
  assert.ok(a.p.conn(SPARE).classList.contains("is-current"), "its provider is the marked one");
  assert.ok(!a.p.conn("agents:settings").classList.contains("is-current"));
  a.p.conn("agents:settings").click();
  assert.deepEqual(a.p.chosen(), [], "Settings' choice is no longer the chosen one");
  a.p.row("Settings’ choice").click();
  assert.deepEqual(a.last("resetAgentsModel"), { type: "resetAgentsModel" });
  assert.equal(a.says(), "Same as settings · qwen3-coder");
  assert.deepEqual(a.p.chosen(), ["Settings’ choice"]);
  assert.deepEqual(a.errors, []);
});

test("Work: this chat's own host lists its models for agents without asking again; a host that lists none takes a typed name", () => {
  const a = opened(AGENTS());
  a.row().click();
  a.p.conn("native").click();
  assert.equal(a.last("providerModels"), null, "the picker already has this host's models");
  assert.deepEqual(a.p.names(), IDS);
  a.p.row("glm-5.3:cloud").click();
  assert.deepEqual(a.last("setAgentsModel"), { type: "setAgentsModel", provider: "", model: "glm-5.3:cloud" });
  assert.equal(a.says(), "glm-5.3:cloud · Ollama");
  a.p.conn(LISTS).click();
  a.send({ type: "providerModels", id: LISTS, ids: [] });
  assert.match(a.p.list().textContent, /It lists no models/);
  a.p.foot("agentsTyped").click();
  assert.deepEqual(a.last("agentsModelTyped"), { type: "agentsModelTyped", id: LISTS });
  assert.equal(a.p.open(), false, "the editor's own box takes the name");
  assert.deepEqual(a.errors, []);
});

test("Work: with DGC Router on, Settings' choice is the Router; a session's own choice still shows as its own", () => {
  const a = opened(AGENTS({ router: true }));
  a.row().click();
  assert.equal(a.p.desc("Settings’ choice"), "Now: DGC Router, which picks a free worker for each sub-agent");
  assert.deepEqual(a.p.chosen(), ["Settings’ choice"]);
  const own = opened(AGENTS({ router: true, own: true, model: "own-coder", base_url: "https://spare.example/v1" }));
  assert.equal(own.says(), "own-coder · Spare", "its own wins over the Router");
  own.row().click();
  assert.equal(own.p.conn(SPARE).getAttribute("aria-selected"), "true", "the tab opens on where its own model runs");
  assert.deepEqual(own.last("providerModels"), { type: "providerModels", id: SPARE });
  own.p.conn("agents:settings").click();
  assert.deepEqual(own.p.chosen(), []);
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
