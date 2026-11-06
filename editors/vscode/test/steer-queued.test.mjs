// Steer now / Steer all (reported 2026-10-19): a queued message ("you · queued") could only wait for the
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
  assert.equal(row.hidden, true, "queued message does not appear in the transcript");
  const now = p.doc.querySelector("#queue-list .dgc-queue-steer");
  assert.ok(now, "Steer now is above the composer");
  now.click();
  assert.deepEqual([...steers(p).at(-1).request_ids], [id]);
  assert.equal(p.doc.querySelector("#queue-list .dgc-queue-steer"), null, "pressed once");
  p.event({ type: "prompt_accepted", request_id: id, state: "steered" });
  assert.equal(row.dataset.steer, "pending", "it is steering now, as Enter-while-working is");
  p.event({ type: "steering_update", request_id: id, state: "applied" });
  assert.equal(row.dataset.steer, "applied");
  assert.equal(row.hidden, false, "steered prompt now appears in the transcript");
  assert.equal(row.querySelector(".steer-now"), null, "no Steer now once it is steered");
  assert.deepEqual(p.errors, []);
});

test("Steer all moves every queued message at once", () => {
  const p = panel();
  const a = queue(p, "one"), b = queue(p, "two");
  p.event({ type: "queued", count: 2, text: "" });
  const all = p.doc.querySelector("#queue-steer-all");
  assert.ok(all, "Steer all is in the composer queue");
  all.click();
  assert.deepEqual([...steers(p).at(-1).request_ids], [a, b]);
});

test("a Steer now the backend refuses leaves the message queued, says why, and can be pressed again", () => {
  const p = panel();
  queue(p, "one");
  p.event({ type: "queued", count: 1, text: "" });
  const now = p.doc.querySelector("#queue-list .dgc-queue-steer");
  now.click();
  p.event({ type: "command_rejected", command: "steer_queued", reason: "not_steerable",
            message: "No turn is running, so a queued message starts as the next one." });
  assert.ok(p.doc.querySelector("#queue-list .dgc-queue-steer"));
  assert.match(p.doc.getElementById("log").textContent, /starts as the next one/);
  p.doc.querySelector("#queue-list .dgc-queue-steer").click();
  assert.equal(steers(p).length, 2);
});

test("an older CLI without steer_queued shows no Steer now", () => {
  const p = panel({ live_steering: true });
  queue(p, "one");
  assert.equal(p.doc.querySelector("#queue-list .dgc-queue-steer"), null);
});

test("the queue joins the composer chip rail when changes are also present", () => {
  const p = panel();
  queue(p, "check the mobile view");
  p.send({ type: "chat_changes", total: 1, additions: 2, deletions: 1, files: [{ path: "src/view.ts" }] });
  const rail = p.doc.getElementById("composer-rail");
  assert.ok(rail.classList.contains("as-chips"));
  const chip = [...p.doc.querySelectorAll("#rail-chips button")].find((button) => /Queue/.test(button.textContent));
  assert.ok(chip, "queued messages have a chip beside changed files");
  chip.click();
  assert.match(p.doc.getElementById("rail-pop").textContent, /check the mobile view/);
  assert.deepEqual(p.errors, []);
});

test("a queued message can be removed: gone only once the backend says so, and never reaches the transcript", () => {
  const p = panel();
  p.send({ type: "event", event: { type: "ready", protocol_version: 14, model: "m", capabilities: { live_steering: true, steer_queued: true, queue_edit: true } } });
  queue(p, "first"); queue(p, "second");
  const removes = () => p.posted.filter((m) => m.type === "queueRemove");
  const ids = [...p.doc.querySelectorAll("#queue-list .dgc-queue-row")].map((row) => row.dataset.queueId);
  assert.equal(ids.length, 2);
  p.doc.querySelector(`#queue-list [data-queue-id="${ids[0]}"] [data-queue-role="remove"]`).click();
  assert.equal(removes().at(-1).id, ids[0]);
  assert.equal(p.doc.querySelectorAll("#queue-list .dgc-queue-row").length, 1, "the row leaves at once");
  p.send({ type: "event", event: { type: "queue_changed", removed: ids[0], order: [ids[1]], count: 1 } });
  assert.match(p.doc.getElementById("queue-title").textContent, /^1 queued message$/);
  assert.equal([...p.doc.querySelectorAll(".msg.user")].filter((row) => /first/.test(row.textContent)).length, 0);
  // Refused: it is still waiting (a refusal can only mean it started or was never there), so the row comes back.
  p.doc.querySelector(`#queue-list [data-queue-id="${ids[1]}"] [data-queue-role="remove"]`).click();
  assert.equal(p.doc.querySelectorAll("#queue-list .dgc-queue-row").length, 0);
  p.send({ type: "event", event: { type: "command_rejected", command: "queue_remove", reason: "not_queued", message: "That message is no longer waiting in the queue." } });
  assert.equal(p.doc.querySelectorAll("#queue-list .dgc-queue-row").length, 1);
  assert.deepEqual(p.errors, []);
});

test("queued messages reorder by keyboard and from the menu, and copy gives the plain words", () => {
  const p = panel();
  p.send({ type: "event", event: { type: "ready", protocol_version: 14, model: "m", capabilities: { live_steering: true, steer_queued: true, queue_edit: true } } });
  queue(p, "one"); queue(p, "two"); queue(p, "three");
  const words = () => [...p.doc.querySelectorAll("#queue-list .dgc-queue-text")].map((n) => n.textContent);
  assert.deepEqual(words(), ["one", "two", "three"]);
  const handle = p.doc.querySelector("#queue-list .dgc-queue-row:nth-child(1) .dgc-queue-handle");
  handle.dispatchEvent(new p.dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  assert.deepEqual(words(), ["two", "one", "three"]);
  const sent = p.posted.filter((m) => m.type === "queueReorder").at(-1).order;
  assert.equal(sent.length, 3);
  const row = p.doc.querySelector("#queue-list .dgc-queue-row:nth-child(3)");
  row.querySelector(".dgc-queue-more").click();
  const [copy, top] = row.querySelectorAll(".dgc-queue-choice");
  assert.equal(copy.textContent, "Copy message");
  assert.equal(top.textContent, "Move to top");
  top.click();
  assert.deepEqual(words(), ["three", "two", "one"]);
  p.doc.querySelector("#queue-list .dgc-queue-row:nth-child(2) .dgc-queue-more").click();
  p.doc.querySelector("#queue-list .dgc-queue-row:nth-child(2) .dgc-queue-choice").click();
  assert.equal(p.posted.filter((m) => m.type === "copy").at(-1).text, "two");
  assert.deepEqual(p.errors, []);
});

test("a CLI without queue_edit keeps the queue but offers neither remove nor reorder", () => {
  const p = panel();
  queue(p, "older backend");
  assert.equal(p.doc.querySelector("#queue-list .dgc-queue-row [data-queue-role='remove']"), null);
  assert.equal(p.doc.querySelector("#queue-list .dgc-queue-handle"), null);
  assert.deepEqual(p.errors, []);
});
