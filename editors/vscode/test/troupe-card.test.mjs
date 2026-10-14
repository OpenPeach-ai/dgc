// A troupe in the chat (dgc/troupe.py): one card per run with its stages' progress and a Stop, updated by
// troupe_progress and troupe_finished, brought back by a `troupes` snapshot; and the approval card outside auto mode,
// which says what the troupe will do in words, not JSON.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom } from "./support/webview-dom.mjs";

const run = (over = {}) => ({
  run_id: "tr-0123456789", title: "Security review <b>x</b>", state: "running", reason: "", agents_planned: 16,
  reused: 0, journal: "/home/me/.dgc/troupes/tr-0123456789",
  stages: [{ name: "Review", total: 4, done: 0, failed: 0, kept: 0 }, { name: "Verify", total: 0, done: 0, failed: 0, kept: 0 }],
  ...over,
});

test("a troupe's card shows each stage's progress, stops on request, and ends with where its results are", () => {
  const { doc, send, posted, errors } = makeDom();
  const event = (data) => send({ type: "event", event: data });
  event({ type: "turn_start", turn_id: "t1", prompt: "review app/", kind: "prompt" });
  event({ type: "troupe_started", ...run() });
  const turn = [...doc.querySelectorAll(".msg.dgc")].at(-1);
  const card = turn.querySelector(".artifact.troupe");
  assert.ok(card, "the card lands in the turn that started it");
  assert.equal(card.querySelector(".alabel").textContent, "Security review <b>x</b>", "the title is text, never markup");
  assert.equal(card.querySelector(".alabel b"), null);
  assert.equal(card.querySelector(".troupe-state").textContent, "Running");
  const rows = () => [...card.querySelectorAll(".troupe-stages li")].map((li) => [...li.children].map((part) => part.textContent).filter(Boolean).join(" "));
  assert.deepEqual(rows(), ["Review 0 of 4", "Verify waiting"]);
  assert.match(card.querySelector(".troupe-note").textContent, /About 16 agents\. This chat continues when it ends\./);

  event({ type: "troupe_progress", ...run({ stages: [{ name: "Review", total: 4, done: 3, failed: 1, kept: 2 },
                                                    { name: "Verify", total: 6, done: 2, failed: 0, kept: 0 }] }) });
  assert.deepEqual(rows(), ["Review 4 of 4 · 1 failed · 2 kept", "Verify 2 of 6"]);
  const bars = [...card.querySelectorAll(".troupe-bar")];
  assert.equal(bars[0].getAttribute("aria-valuenow"), "4");
  assert.equal(bars[1].querySelector("span").style.width, "33%");
  assert.equal(doc.querySelectorAll(".artifact.troupe").length, 1, "progress updates the one card");

  const stop = card.querySelector("[data-troupe-stop]");
  stop.click();
  stop.click();
  assert.deepEqual(JSON.parse(JSON.stringify(posted.filter((m) => m.type === "stopTroupe"))), [{ type: "stopTroupe", run_id: "tr-0123456789" }]);
  assert.equal(stop.textContent, "Stopping…");

  event({ type: "troupe_finished", ...run({ state: "stopped", reason: "stopped by the user",
                                           stages: [{ name: "Review", total: 4, done: 3, failed: 1, kept: 2 },
                                                    { name: "Verify", total: 6, done: 2, failed: 0, kept: 0 }] }) });
  assert.equal(card.querySelector(".troupe-state").textContent, "Stopped · stopped by the user");
  assert.ok(card.classList.contains("finished"));
  assert.equal(stop.disabled, true);
  assert.equal(card.querySelector(".troupe-note").textContent, "Results: /home/me/.dgc/troupes/tr-0123456789");
  assert.deepEqual(errors, []);
});

test("a reconnect's snapshot brings back a running troupe's card, never a finished one's", () => {
  const { doc, send } = makeDom();
  send({ type: "event", event: { type: "turn_start", turn_id: "t1", prompt: "x", kind: "prompt" } });
  send({ type: "event", event: { type: "troupes", runs: [run({ run_id: "tr-aaaaaaaaaa" }),
                                                         run({ run_id: "tr-bbbbbbbbbb", state: "done" })] } });
  const ids = [...doc.querySelectorAll(".artifact.troupe")].map((card) => card.dataset.troupeId);
  assert.deepEqual(ids, ["tr-aaaaaaaaaa"]);
  send({ type: "event", event: { type: "troupe_progress", ...run({ run_id: "tr-cccccccccc" }) } });
  assert.equal(doc.querySelectorAll(".artifact.troupe").length, 1, "progress for a run with no card makes none");
});

test("outside auto mode the approval card says what the troupe will do", () => {
  const { doc, send, posted } = makeDom();
  send({ type: "event", event: { type: "turn_start", turn_id: "t1", prompt: "review", kind: "prompt" } });
  send({ type: "event", event: { type: "permission_request", id: "p1", call_id: "c1", name: "troupe",
    args: { title: "Security review", template: "review", goal: "security problems",
            items: ["a.py", "b.py", "c.py", "d.py", "e.py", "f.py", "g.py"] },
    command: null, summary: "Security review", diff: null, suggested_rule: "Troupe(review)", choices: ["once", "always", "deny"] } });
  const card = doc.querySelector(".card[data-request-id='p1']");
  assert.ok(card);
  assert.match(card.querySelector(".q").textContent, /Start a troupe\?/);
  const text = card.textContent;
  for (const words of ["Security review", "Review each, then 3 verifiers check every finding", "security problems",
                       "Items (7)", "a.py", "… and 2 more", "one agent per item"]) {
    assert.ok(text.includes(words), words);
  }
  assert.equal(card.querySelector("pre"), null, "no raw JSON");
  card.querySelector("[data-d='always']").click();
  assert.deepEqual(JSON.parse(JSON.stringify(posted.find((m) => m.type === "permission_response"))),
    { type: "permission_response", id: "p1", decision: "always", rule: "Troupe(review)" });
});

test("a troupe on a schedule asks to schedule it, and says when, what each time, and who reports", () => {
  const { doc, send } = makeDom();
  send({ type: "event", event: { type: "turn_start", turn_id: "t1", prompt: "every monday review", kind: "prompt" } });
  send({ type: "event", event: { type: "permission_request", id: "p2", call_id: "c2", name: "troupe",
    args: { title: "Weekly review", template: "review", goal: "correctness bugs", routine: { every: "week", day: "monday", at: "09:00" } },
    command: null, summary: "Weekly review", diff: null, suggested_rule: "Troupe(routine)", choices: ["once", "always", "deny"] } });
  const card = doc.querySelector(".card[data-request-id='p2']");
  assert.match(card.querySelector(".q").textContent, /Schedule a troupe\?/);
  for (const words of ["Weekly review", "Every Monday at 09:00", "The files changed since it last ran",
                       "Your Primary Pip, in its chat", "Allow adds it to the Pip's routines", "only reads this project's committed code"]) {
    assert.ok(card.textContent.includes(words), words);
  }
  assert.ok(!card.textContent.includes("Items ("), "no list of items: they are found each time");
});
