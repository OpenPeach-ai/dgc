import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom } from "./support/webview-dom.mjs";

test("a helper's live approval names it and the exact command", () => {
  const h = makeDom();
  const event = (frame) => h.send({ type: "event", event: frame });
  const id = "sub-123456789abc";
  event({ type: "ready", capabilities: { agents: true } });
  event({ type: "turn_start", turn_id: "t1", prompt: "Check invoices" });
  event({ type: "agent_started", id, call_id: "task-1", description: "Count invoice TODOs",
    state: "running", depth: 1, parallel: true, isolated: true });
  event({ type: "permission_request", id: "p1", call_id: `${id}:cmd-1`, name: "bash",
    args: { command: "rg TODO invoices" }, command: "rg TODO invoices",
    choices: ["once", "always", "deny"], suggested_rule: "Bash" });
  const card = h.doc.querySelector(".card:has(.deny-note)");
  assert.ok(card);
  assert.match(card.textContent, /Helper: Count invoice TODOs/);
  assert.match(card.textContent, /rg TODO invoices/);
  assert.deepEqual(h.errors, []);
});
