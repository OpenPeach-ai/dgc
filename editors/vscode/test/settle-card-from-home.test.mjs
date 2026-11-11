// A command answered on Home (0.52): the session's own tab settles its card, saying on the card where it was answered,
// with no second line under it saying the same.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom } from "./support/webview-dom.mjs";

const READY = { type: "ready", model: "qwen3.8:27b", mode: "default", think: "off", base_url: "http://127.0.0.1:1/v1",
  workspace_trusted: true, commands: [], custom_commands: [], goal: { text: "", status: "none" }, context_size: 32768, capabilities: {} };

test("Home's answer settles the tab's card in one place", () => {
  const v = makeDom({});
  const event = (data) => v.send({ type: "event", event: data });
  event(READY);
  v.send({ type: "session_ready", sessionId: "s1" });
  event({ type: "turn_start", turn_id: "t1", kind: "prompt", prompt: "run it" });
  event({ type: "permission_request", id: "perm-1", call_id: "c1", name: "bash", args: { command: "echo hi" }, command: "echo hi",
          summary: "echo hi", diff: null, suggested_rule: "bash(echo:*)", choices: ["once", "always", "deny"] });
  const card = v.doc.querySelector('.card[data-request-id="perm-1"]');
  assert.ok(card, "the tab asks");
  const lines = () => [...v.doc.querySelectorAll(".sys")].map((n) => n.textContent).filter((t) => /Home/.test(t));
  v.send({ type: "settleCard", id: "perm-1", label: "Allowed once, on Home" });
  assert.equal(card.classList.contains("resolved"), true);
  assert.match(card.textContent, /Allowed once, on Home/);
  assert.equal([...card.querySelectorAll("button")].filter((b) => !b.disabled).length, 0, "nothing left to press");
  assert.deepEqual(lines(), [], "no second line saying the same");
  v.send({ type: "settleCard", id: "perm-other", label: "Denied, on Home" });
  assert.match(card.textContent, /Allowed once, on Home/, "another request's answer leaves it alone");
});
