// Live round 1 (14 Nov), findings 1 and 8, in Work's chat (media/main.js). The task tool's card and its receipt say
// "sub-agent", never "helper". dgc_settings asks in plain words, like a Pip tool's card: "Change a setting?" with what
// (its label), from → to, and why; never "Run dgc_settings {json}".
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom } from "./support/webview-dom.mjs";

const ask = (h, name, args, more = {}) => {
  const event = (frame) => h.send({ type: "event", event: frame });
  event({ type: "ready", capabilities: { agents: true, settings_undo: 1 } });
  event({ type: "turn_start", turn_id: "t1", prompt: "Go on" });
  event({ type: "permission_request", id: "p1", call_id: "c1", name, args, choices: ["once", "always", "deny"], suggested_rule: name === "task" ? "Task" : "dgc_settings", ...more });
  return [...h.doc.querySelectorAll(".card")].find((c) => c.querySelector(".q"));
};
const words = (n) => (n?.textContent || "").replace(/\s+/g, " ").trim();

test("one sub-agent: the card asks “Start a sub-agent?”, its button says Start sub-agent, and nothing says helper", () => {
  const h = makeDom();
  const card = ask(h, "task", { description: "Read billing/totals.py", prompt: "Read it and say what order_total returns." }, { summary: "Read billing/totals.py" });
  assert.equal(words(card.querySelector(".q")), "Start a sub-agent?");
  assert.ok([...card.querySelectorAll(".btns button")].some((b) => words(b) === "Start sub-agent"), words(card.querySelector(".btns")));
  assert.doesNotMatch(words(card), /helper/i);
  [...card.querySelectorAll(".btns button")].find((b) => words(b) === "Start sub-agent").click();
  const receipt = words(h.doc.querySelector(".deny-note, .perm-receipt, .card .receipt") || h.doc.body);
  assert.match(words(h.doc.body), /Sub-agent · Read billing\/totals\.py · Allowed once/);
  assert.doesNotMatch(receipt, /Helper ·/);
  assert.deepEqual(h.errors, []);
});

test("several: “Start 3 sub-agents?” and Start sub-agents; one with no description is “A sub-agent”", () => {
  const h = makeDom();
  const card = ask(h, "task", { tasks: [{ description: "Describe plants.py", prompt: "a" }, { description: "Describe rota.py", prompt: "b" }, { prompt: "c" }] });
  assert.equal(words(card.querySelector(".q")), "Start 3 sub-agents?");
  assert.ok([...card.querySelectorAll(".btns button")].some((b) => words(b) === "Start sub-agents"));
  assert.match(words(card), /A sub-agent/);
  assert.doesNotMatch(words(card), /helper/i);
});

test("a sub-agent's own approval is headed “Sub-agent: …”", () => {
  const h = makeDom();
  const event = (frame) => h.send({ type: "event", event: frame });
  const id = "sub-123456789abc";
  event({ type: "ready", capabilities: { agents: true } });
  event({ type: "turn_start", turn_id: "t1", prompt: "Check invoices" });
  event({ type: "agent_started", id, call_id: "task-1", description: "Count invoice TODOs", state: "running", depth: 1, parallel: true, isolated: true });
  event({ type: "permission_request", id: "p1", call_id: `${id}:cmd-1`, name: "bash", args: { command: "rg TODO invoices" }, command: "rg TODO invoices", choices: ["once", "always", "deny"], suggested_rule: "Bash" });
  const card = h.doc.querySelector(".card:has(.deny-note)");
  assert.match(card.textContent, /Sub-agent: Count invoice TODOs/); assert.doesNotMatch(card.textContent, /Helper/);
});

test("dgc_settings asks in plain words: the setting by its label, from → to, and why; never the raw call", () => {
  const h = makeDom();
  const card = ask(h, "dgc_settings", { action: "setting", key: "pips_parallel_runs", value: 8, reason: "You asked for more Pips at once.", setting_label: "Pip runs at once (all Pips)", before: 4 });
  assert.equal(words(card.querySelector(".q")), "Change a setting?");
  const rows = [...card.querySelectorAll("dl.pip-permission dt")].map((dt) => [words(dt), words(dt.nextElementSibling)]);
  assert.deepEqual(rows, [["Setting", "Pip runs at once (all Pips)"], ["Change", "4 → 8"], ["Why", "You asked for more Pips at once."]]);
  assert.doesNotMatch(words(card), /dgc_settings|\{|pips_parallel_runs|"action"/);
  assert.deepEqual(h.errors, []);
});

test("without the backend's label and old value it still reads plainly: the setting's name in words, and what it becomes", () => {
  const h = makeDom();
  const card = ask(h, "dgc_settings", { action: "setting", key: "show_reasoning", value: true });
  assert.equal(words(card.querySelector(".q")), "Change a setting?");
  const rows = [...card.querySelectorAll("dl.pip-permission dt")].map((dt) => [words(dt), words(dt.nextElementSibling)]);
  assert.deepEqual(rows, [["Setting", "Show reasoning"], ["Change", "to On"]]);
  assert.doesNotMatch(words(card), /dgc_settings|\{/);
});

test("a permission rule, a Dev Mode limit and an undo each ask their own plain question", () => {
  let h = makeDom();
  let card = ask(h, "dgc_settings", { action: "rule", rule: "Bash(npm test:*)", rule_action: "allow", reason: "So tests run without asking." });
  assert.equal(words(card.querySelector(".q")), "Add a permission rule?");
  assert.deepEqual([...card.querySelectorAll("dl.pip-permission dt")].map((dt) => [words(dt), words(dt.nextElementSibling)]), [["Rule", "Bash(npm test:*)"], ["It will", "Always allow"], ["Why", "So tests run without asking."]]);
  h = makeDom();
  card = ask(h, "dgc_settings", { action: "rule", rule: "Bash(rm:*)", rule_action: "deny", remove: true });
  assert.equal(words(card.querySelector(".q")), "Remove a permission rule?");
  h = makeDom();
  card = ask(h, "dgc_settings", { action: "dev_limit", key: "pips_parallel_runs", value: 40, before: 32, setting_label: "Pip runs at once (all Pips)" });
  assert.equal(words(card.querySelector(".q")), "Change a Dev Mode limit?");
  assert.match(words(card), /32 → 40/);
  h = makeDom();
  card = ask(h, "dgc_settings", { action: "undo", change_id: "setchg_0123456789abcdef" });
  assert.equal(words(card.querySelector(".q")), "Put a setting back?");
  assert.doesNotMatch(words(card), /setchg_|dgc_settings|\{/);
});
