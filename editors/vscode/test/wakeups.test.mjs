// A Work chat wakes itself up later (0.52, asked 8 Nov). The chat's waiting wake-ups (the `wakeups` event) are one pill
// on the bar above the prompt box: "Wakes 10:30" for one, "2 wake-ups" for more. It opens to their rows (when and why)
// with Cancel, which asks DGC to take one back (cancel_wakeup). A wake-up's own turn reads "Woke up as planned · why".
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom } from "./support/webview-dom.mjs";

const READY = { type: "ready", model: "qwen3.8:27b", mode: "default", think: "off", base_url: "http://127.0.0.1:1/v1",
  workspace_trusted: true, commands: [], custom_commands: [], goal: { text: "", status: "none" }, context_size: 1,
  capabilities: { agents: true, wakeups: true } };
const at = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.toISOString(); };

function chat() {
  const v = makeDom({});
  const event = (data) => v.send({ type: "event", event: data });
  event(READY);
  v.send({ type: "session_ready", sessionId: "s1" });
  const chip = () => v.doc.querySelector('#rail-chips .rail-chip[data-kind="wakeups"]');
  const face = () => [...chip().querySelectorAll(".chip-word, .chip-num, .chip-extra")].map((n) => n.textContent).join(" ").trim();
  return { v, event, chip, face };
}

test("a waiting wake-up is a pill on the bar; it opens to its row with Cancel, and goes when it is gone", () => {
  const { v, event, chip, face } = chat();
  assert.equal(chip(), null, "none waiting: no pill");
  event({ type: "wakeups", items: [{ id: "wake1", at: at(10, 30), why: "Check the tests" }] });
  assert.ok(chip(), "one pill");
  assert.match(face(), /^Wakes 10:30$/);
  chip().click();
  const pop = v.doc.getElementById("rail-pop");
  assert.equal(pop.hidden, false);
  const rows = [...pop.querySelectorAll(".wakeup-row")];
  assert.equal(rows.length, 1);
  assert.match(rows[0].textContent, /10:30.*Check the tests/);
  rows[0].querySelector("button.wakeup-cancel").click();
  assert.deepEqual(v.posted.filter((m) => m.type === "cancelWakeup").map((m) => m.id), ["wake1"]);
  event({ type: "wakeups", items: [{ id: "wake1", at: at(10, 30), why: "Check the tests" },
    { id: "wake2", at: at(11, 0), why: "Look at CI" }] });
  assert.match(face(), /^2 wake-ups$/);
  event({ type: "wakeups", items: [] });
  assert.equal(chip(), null, "all gone: the pill goes");
});

test("a wake-up's turn reads as one it planned, never as a message the user typed", () => {
  const { v, event } = chat();
  event({ type: "turn_start", turn_id: "t1", prompt: "wake-up: Check the tests", kind: "monitor" });
  const note = v.doc.querySelector(".monitor-note");
  assert.ok(note);
  assert.match(note.textContent, /^Woke up as planned · Check the tests$/);
  assert.equal(note.querySelector(".note-icon").dataset.icon, "history", "its own mark, not the fallback");
  assert.equal(v.doc.querySelector(".msg.user"), null);
  event({ type: "turn_start", turn_id: "t2", prompt: "video: tide.mp4 · ended", kind: "monitor" });
  assert.match([...v.doc.querySelectorAll(".monitor-note")].at(-1).textContent, /Woke as a video ended/, "others keep their words");
});
