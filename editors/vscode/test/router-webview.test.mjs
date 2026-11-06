// The chat's half of DGC Router (0.51), in Chromium with the real panel: the approval card draws exactly the event's
// `choices` (a Router change or a look on the network: Allow once and Deny, never Always; an older CLI's card with no
// list keeps all three), and the agent map and a helper's own page say where it ran ("on GPU box · qwen3:8b"), from
// router_changed's leases, kept after the helper gives its worker back.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openMapScene, sid } from "./support/agent-map-scene.mjs";

let chromium, browser;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });
const skipOrFail = (t) => {
  if (browser) return false;
  const reason = chromium ? "Chromium could not start" : "playwright is not installed (npm ci at the repository root)";
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};

const buttons = (page, id) => page.evaluate((id) => [...document.querySelectorAll(`.card[data-request-id="${id}"] .btns button`)].map((b) => b.textContent), id);

test("a Router change's card offers Allow once and Deny, never Always; an older CLI's card keeps all three", async (t) => {
  if (skipOrFail(t)) return;
  const { page, send, errors } = await openMapScene(browser, { width: 520, open: false });
  try {
    await send({ type: "permission_request", id: "r1", call_id: "c1", name: "router_update", args: { action: "turn_on" },
      suggested_rule: "RouterUpdate", choices: ["once", "deny"], summary: "Turn DGC Router on" });
    assert.deepEqual(await buttons(page, "r1"), ["Allow once", "Deny"]);
    await send({ type: "permission_request", id: "r2", call_id: "c2", name: "router_find", args: {}, suggested_rule: "RouterFind",
      choices: ["once", "deny"] });
    assert.deepEqual(await buttons(page, "r2"), ["Allow once", "Deny"]);
    // In plain words: what it looks for and where, never "Run router_find {}".
    const look = await page.evaluate(() => document.querySelector('.card[data-request-id="r2"]').innerText);
    assert.match(look, /Look for model servers on your network\?/);
    assert.match(look, /On this computer's network, on the ports 11434, 8080, 1234, 8000, 30000, 8188, once\./);
    assert.doesNotMatch(look, /router_find|\{\}/);
    const ports = readFileSync(new URL("../../../dgc/router_probe.py", import.meta.url), "utf8").match(/KNOWN_PORTS = \(([^)]*)\)/)[1];
    assert.match(look, new RegExp(ports.replace(/\s+/g, " ").trim().replace(/[()]/g, "")), "the backend's own list");
    await send({ type: "permission_request", id: "r3", call_id: "c3", name: "bash", args: { command: "ls" }, command: "ls",
      suggested_rule: "Bash(ls)", choices: ["once", "always", "deny"] });
    assert.deepEqual(await buttons(page, "r3"), ["Allow once", "Always allow", "Deny"]);
    await send({ type: "permission_request", id: "r4", call_id: "c4", name: "bash", args: { command: "pwd" }, command: "pwd",
      suggested_rule: "Bash(pwd)" });
    assert.deepEqual(await buttons(page, "r4"), ["Allow once", "Always allow", "Deny"], "no list: as before");
    // Answering the Router's card sends exactly once.
    await page.evaluate(() => { window.__posted.length = 0; });
    await page.evaluate(() => [...document.querySelectorAll('.card[data-request-id="r1"] .btns button')].find((b) => b.textContent === "Allow once").click());
    const answer = await page.evaluate(() => window.__posted.find((m) => m.type === "permission_response"));
    assert.deepEqual({ id: answer.id, decision: answer.decision, rule: answer.rule }, { id: "r1", decision: "once", rule: undefined });
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("the agent map and a helper's page say where it ran, and keep saying it once it ends", async (t) => {
  if (skipOrFail(t)) return;
  const { page, send, errors } = await openMapScene(browser, { width: 900 });
  try {
    const where = { enabled: true, when_busy: "wait", workers: { total: 6, free: 4, busy: 2 }, systems: [
      { id: "gpu", name: "GPU box", leases: [{ owner: sid(1), label: "Review the auth module", model: "qwen3:8b", job: "subagents" }] },
      { id: "nas", name: "NAS", leases: [{ owner: sid(4), label: "Write the settings migration", model: "qwen3.5:9b" },
        { owner: "Pip run run_1", label: "Pip Inbox", model: "qwen3.5:9b" }] }] };
    await send({ type: "router_changed", status: where, why: "leased" });
    await page.waitForTimeout(60);
    const map = await page.evaluate(() => document.getElementById("agent-map").textContent);
    assert.match(map, /on GPU box · qwen3:8b/);
    assert.match(map, /on NAS · qwen3\.5:9b/);
    assert.doesNotMatch(map, /Pip Inbox/, "a Pip's run is no helper of this chat");
    // Given back: the badge stays.
    await send({ type: "router_changed", status: { ...where, systems: where.systems.map((s) => ({ ...s, leases: [] })) }, why: "released" });
    await page.waitForTimeout(60);
    assert.match(await page.evaluate(() => document.getElementById("agent-map").textContent), /on GPU box · qwen3:8b/);
    // The helper's card says it too.
    await page.evaluate((id) => document.querySelector(`#agent-map .am-row[data-am-key$="${id}"]`)?.click(), sid(1));
    await page.waitForTimeout(80);
    const card = await page.evaluate(() => document.getElementById("agent-card")?.textContent || "");
    assert.match(card, /reviewer · on GPU box · qwen3:8b/);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("a helper only the agents snapshot names a system for still says where it ran", async (t) => {
  if (skipOrFail(t)) return;
  const { page, send } = await openMapScene(browser, { width: 900 });
  try {
    await send({ type: "agents", total: 1, active: 0, items: [{ id: sid(4), parent_id: null, call_id: "call_3", description: "Write the settings migration and its tests",
      depth: 1, state: "finished", tool_calls: 44, isolated: false, parallel: true, restored: false, model: "qwen2.5:7b", system: "Strix box" }] });
    await page.waitForTimeout(60);
    assert.match(await page.evaluate(() => document.getElementById("agent-map").textContent), /on Strix box · qwen2\.5:7b/);
  } finally { await page.close(); }
});

test("the agent map and a helper's card say the thinking level it used: from its lease, and from the agents snapshot", async (t) => {
  if (skipOrFail(t)) return;
  const { page, send, errors } = await openMapScene(browser, { width: 900 });
  try {
    await send({ type: "router_changed", why: "leased", status: { enabled: true, when_busy: "wait", workers: { total: 2, free: 0, busy: 2 }, systems: [
      { id: "nas", name: "NAS", leases: [{ owner: sid(4), label: "Write the settings migration", model: "qwen3.5:9b", thinking: "low" }] },
      { id: "gpu", name: "GPU box", leases: [{ owner: sid(1), label: "Review the auth module", model: "qwen3:8b" }] }] } });
    await page.waitForTimeout(60);
    const map = await page.evaluate(() => document.getElementById("agent-map").textContent);
    assert.match(map, /on NAS · qwen3\.5:9b · thinking low/);
    assert.match(map, /on GPU box · qwen3:8b(?! · thinking)/, "a lease that says none: nothing about thinking");
    // A helper the Router didn't place: its own level from the snapshot, beside its model.
    await send({ type: "agents", total: 1, active: 0, items: [{ id: sid(2), parent_id: null, call_id: "call_9", description: "Count the bolts",
      depth: 1, state: "finished", tool_calls: 3, isolated: false, parallel: false, restored: false, model: "glm-5.3:cloud", thinking: "xhigh" }] });
    await page.waitForTimeout(60);
    assert.match(await page.evaluate(() => document.getElementById("agent-map").textContent), /glm-5\.3:cloud · thinking extra high/);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
