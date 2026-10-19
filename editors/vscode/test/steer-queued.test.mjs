// Steer now / Steer all (the founder, 2026-10-19): a queued message ("you · queued") could only wait for the
// running turn to end. With ready.capabilities.steer_queued it offers Steer now, and Steer all when several wait;
// the backend moves them into the turn and answers each with prompt_accepted "steered", or refuses with a reason.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom } from "./support/webview-dom.mjs";

function panel(capabilities = { live_steering: true, steer_queued: true }) {
  const view = makeDom();
  const p = { ...view, event: (data) => view.send({ type: "event", event: data }) };
  p.event({ type: "ready", capabilities, model: "m", mode: "default", think: "off", base_url: "http://127.0.0.1:1/v1",
            workspace_trusted: true, commands: [], custom_commands: [], goal: { text: "", status: "none" }, context_size: 1 });
  p.event({ type: "turn_start", turn_id: "t1", prompt: "deploy it", kind: "prompt" });
  return p;
}
// Queue one message the way a user does: type, then Alt+Enter (delivery "queue"); the backend says it is queued.
function queue(p, text) {
  const input = p.doc.getElementById("input");
  input.value = text;
  input.dispatchEvent(new p.dom.window.Event("input", { bubbles: true }));
  input.dispatchEvent(new p.dom.window.KeyboardEvent("keydown", { key: "Enter", altKey: true, bubbles: true }));
  const sent = [...p.posted].reverse().find((m) => m?.type === "prompt");
  const id = String(sent?.requestId || "");
  p.event({ type: "prompt_accepted", request_id: id, state: "queued" });
  return id;
}
const rows = (p) => [...p.doc.querySelectorAll(".msg.user")].filter((n) => n.dataset.steer);
const steers = (p) => p.posted.filter((m) => m?.type === "steerQueued");

test("a queued message offers Steer now, which asks the backend to move it into the running turn", () => {
  const p = panel();
  const id = queue(p, "also check the totals");
  p.event({ type: "queued", count: 1, text: "" });
  const [row] = rows(p);
  assert.equal(row.dataset.steer, "queued");
  const now = row.querySelector(".steer-now");
  assert.ok(now, "Steer now is on the queued message");
  now.click();
  assert.deepEqual([...steers(p).at(-1).request_ids], [id]);
  assert.ok(now.disabled, "pressed once");
  p.event({ type: "prompt_accepted", request_id: id, state: "steered" });
  assert.equal(row.dataset.steer, "pending", "it is steering now, as Enter-while-working is");
  p.event({ type: "steering_update", request_id: id, state: "applied" });
  assert.equal(row.dataset.steer, "applied");
  assert.equal(row.querySelector(".steer-now"), null, "no Steer now once it is steered");
  assert.deepEqual(p.errors, []);
});

test("Steer all moves every queued message at once", () => {
  const p = panel();
  const a = queue(p, "one"), b = queue(p, "two");
  p.event({ type: "queued", count: 2, text: "" });
  const all = p.doc.querySelector("#queued .steer-all");
  assert.ok(all, "Steer all beside the count when two or more wait");
  all.click();
  assert.deepEqual([...steers(p).at(-1).request_ids], [a, b]);
});

test("a Steer now the backend refuses leaves the message queued, says why, and can be pressed again", () => {
  const p = panel();
  queue(p, "one");
  p.event({ type: "queued", count: 1, text: "" });
  const now = rows(p)[0].querySelector(".steer-now");
  now.click();
  p.event({ type: "command_rejected", command: "steer_queued", reason: "not_steerable",
            message: "No turn is running, so a queued message starts as the next one." });
  assert.equal(now.disabled, false);
  assert.equal(now.textContent, "Steer now");
  assert.match(p.doc.getElementById("log").textContent, /starts as the next one/);
  now.click();
  assert.equal(steers(p).length, 2);
});

test("an older CLI without steer_queued shows no Steer now", () => {
  const p = panel({ live_steering: true });
  queue(p, "one");
  assert.equal(rows(p)[0].querySelector(".steer-now"), null);
});
