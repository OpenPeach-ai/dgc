// No Pips in a Work session's agent map (his call, 14 Nov night; live round 1, finding 14). No session owns a Pip:
// they run their own chats in the background. The map is this session's own sub-agents and its background tasks, and
// nothing else: there is no Pips section, the page asks DGC for no related Pips, a Pip working on a job this chat
// gave it is not a row of the map (it is the chip above the box, as before) and does not light the map's button.
// (This replaces the 0.52 Pips section's tests: agent-map-pips-layout, agent-map-pips-host.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeDom } from "./support/webview-dom.mjs";

const READY = { type: "ready", model: "qwen3.8:27b", mode: "default", think: "off", base_url: "http://127.0.0.1:1/v1",
  workspace_trusted: true, commands: [], custom_commands: [], goal: { text: "", status: "none" }, context_size: 1 };
const PIPS96 = { agents: true, agent_control: true, pips_supported: true, pips_enabled: true, pips_api_version: 96, pip_runs_running: 1 };
const hex = (c) => c.repeat(32);
const RUN = "run_" + hex("1"), TAX = "pip_" + hex("a");
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function view() {
  const v = makeDom();
  v.dom.window.DgcPips = { mount: () => ({ navigate() {}, setVisible() {} }) };
  const event = (data) => v.send({ type: "event", event: data });
  const $ = (id) => v.doc.getElementById(id);
  event({ ...READY, capabilities: PIPS96 });
  v.send({ type: "state", state: { model: "qwen3.8:27b", mode: "default", think: "off" } });
  v.send({ type: "session_ready", sessionId: "s1" });
  const open = () => { const input = $("input"); input.focus(); input.value = "/agents";
    input.dispatchEvent(new v.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); };
  return { v, event, $, open, posts: (type) => v.posted.filter((m) => m.type === type) };
}

test("the map has no Pips section, and the page asks DGC for no related Pips when it opens", () => {
  const { v, $, open, posts, event } = view();
  event({ type: "pip_runs_running", runs: [{ run_id: RUN, pip_id: TAX, name: "Tax watchdog", pip_type: "rook", started_at: new Date(Date.now() - 60000).toISOString(), trigger: "chat" }] });
  open();
  assert.equal($("agent-map").hidden, false, "the map is open");
  assert.equal($("agent-map-pips"), null, "no Pips section in the map");
  assert.equal(v.doc.querySelector("#agent-map .am-pip, #agent-map .am-pips"), null);
  assert.doesNotMatch($("agent-map").textContent, /Tax watchdog|for this session|All Pips|Pips elsewhere/);
  assert.deepEqual(posts("agentMapPips"), [], "nothing is asked about Pips");
  assert.deepEqual(v.errors, []);
});

test("a Pip working on a job from this chat does not show or light the map's button: with no sub-agent and no task there is no button", () => {
  const { $, event, v } = view();
  event({ type: "pip_runs_running", runs: [{ run_id: RUN, pip_id: TAX, name: "Tax watchdog", pip_type: "rook", started_at: new Date(Date.now() - 60000).toISOString(), trigger: "chat" }] });
  assert.equal($("agents-picker").hidden, true);
  assert.deepEqual(v.errors, []);
});

test("nothing of the section is left in the page, the panel or the stylesheet", () => {
  assert.doesNotMatch(read("src/panel.ts"), /agent-map-pips|agentMapPips|agentMapPipStop|AGENT_MAP_PIPS_HIDDEN_KEY/);
  assert.doesNotMatch(read("media/main.js"), /agentMapPips|agent-map-pips|amPipsPlan|paintAmPips/);
  assert.doesNotMatch(read("media/main.css"), /\.am-pips\b|\.am-pip(?![\w-])/);
});
