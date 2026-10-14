// A troupe in the chat (dgc/troupe.py) is a row above the prompt box, in the composer rail like the checklist: the
// newest troupe's tiles, title, the stage it is on and Stop; open, every troupe's stages with their progress. It is
// updated by troupe_progress and troupe_finished, brought back by a `troupes` snapshot, and leaves once it has ended
// and you move on. Outside auto mode, the approval card still asks in the chat, in words, not JSON.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom } from "./support/webview-dom.mjs";

const run = (over = {}) => ({
  run_id: "tr-0123456789", title: "Security review <b>x</b>", state: "running", reason: "", agents_planned: 16,
  reused: 0, journal: "/home/me/.dgc/troupes/tr-0123456789",
  stages: [{ name: "Review", total: 4, done: 0, failed: 0, kept: 0 }, { name: "Verify", total: 0, done: 0, failed: 0, kept: 0 }],
  ...over,
});
const later = [{ name: "Review", total: 4, done: 3, failed: 1, kept: 2 }, { name: "Verify", total: 6, done: 2, failed: 0, kept: 0 }];

function chat() {
  const dom = makeDom();
  const event = (data) => dom.send({ type: "event", event: data });
  const $ = (id) => dom.doc.getElementById(id);
  const visible = (id) => !$(id).hidden && !$("composer-rail").hidden;
  const rows = () => [...dom.doc.querySelectorAll("#troupe-panel .troupe-stages li")]
    .map((li) => [...li.children].map((part) => part.textContent).filter(Boolean).join(" "));
  return { ...dom, event, $, visible, rows };
}

test("a troupe is one slim row above the prompt, never a card in the chat, and Stop reaches the backend once", () => {
  const { doc, event, $, visible, rows, posted, errors } = chat();
  event({ type: "turn_start", turn_id: "t1", prompt: "review app/", kind: "prompt" });
  assert.equal(visible("troupebar"), false, "no troupe, no row");
  event({ type: "troupe_started", ...run() });
  assert.equal(doc.querySelector("#log .artifact.troupe, #log .troupe-stages"), null, "nothing in the transcript");
  assert.ok(visible("troupebar"), "the row is in the rail above the prompt");
  assert.ok($("composer-rail").classList.contains("has-troupes"));
  assert.equal($("troupebar").dataset.state, "running");
  assert.equal($("troupe-label").textContent, "Troupe");
  assert.equal($("troupe-title").textContent, "Security review <b>x</b>", "the title is text, never markup");
  assert.equal($("troupebar").querySelector("b"), null);
  assert.equal($("troupe-count").textContent, "Review 0/4");
  assert.equal($("troupe-mini").querySelector("span").style.width, "0%");
  assert.equal($("troupe-mark").querySelectorAll("svg .tm-part").length, 4, "the four tiles");
  assert.equal($("troupe-panel").hidden, true, "collapsed: one line");
  assert.equal($("troupe-stop").hidden, false);
  assert.equal($("troupe-dismiss").hidden, true, "nothing to dismiss while it works");

  event({ type: "troupe_progress", ...run({ stages: later }) });
  assert.equal($("troupe-count").textContent, "Verify 2/6", "the stage at work, not the finished one");
  assert.equal($("troupe-mini").querySelector("span").style.width, "33%");
  assert.equal(doc.querySelectorAll("#troupebar").length, 1);

  $("troupe-main").click();
  assert.equal($("troupe-panel").hidden, false);
  assert.equal($("troupe-main").getAttribute("aria-expanded"), "true");
  assert.equal($("troupe-toggle").getAttribute("aria-label"), "Hide the troupe's stages");
  assert.deepEqual(rows(), ["Review 4 of 4 · 1 failed · 2 kept", "Verify 2 of 6"]);
  const bars = [...doc.querySelectorAll("#troupe-panel .troupe-bar")];
  assert.equal(bars[0].getAttribute("aria-valuenow"), "4");
  assert.equal(bars[1].querySelector("span").style.width, "33%");
  assert.match(doc.querySelector("#troupe-panel .troupe-note").textContent, /About 16 agents\. This chat continues when it ends\./);
  assert.equal(doc.querySelector("#troupe-panel [data-troupe-stop]"), null, "one troupe: its Stop is the row's");

  $("troupe-stop").click();
  $("troupe-stop").click();
  assert.deepEqual(JSON.parse(JSON.stringify(posted.filter((m) => m.type === "stopTroupe"))), [{ type: "stopTroupe", run_id: "tr-0123456789" }]);
  assert.equal($("troupe-stop").disabled, true);
  assert.equal($("troupe-stop").title, "Stopping…");

  event({ type: "troupe_finished", ...run({ state: "stopped", reason: "stopped by the user", stages: later }) });
  assert.equal($("troupebar").dataset.state, "stopped");
  assert.equal($("troupe-count").textContent, "Stopped");
  assert.equal(doc.querySelector("#troupe-panel .troupe-run-state").textContent, "Stopped · stopped by the user");
  assert.equal(doc.querySelector("#troupe-panel .troupe-note").textContent, "Results: /home/me/.dgc/troupes/tr-0123456789");
  assert.equal($("troupe-status").textContent, "Security review <b>x</b>: Stopped · stopped by the user");
  assert.equal($("troupe-stop").hidden, true);
  assert.equal($("troupe-dismiss").hidden, false);

  $("troupe-dismiss").click();
  assert.equal(visible("troupebar"), false, "dismissed");
  assert.equal($("composer-rail").hidden, true, "and the rail closes with nothing else in it");
  assert.deepEqual(errors, []);
});

test("a finished troupe says what it kept, and stays until your next message, not its own wake-up turn", () => {
  const { event, $, visible } = chat();
  event({ type: "turn_start", turn_id: "t1", prompt: "review", kind: "prompt" });
  event({ type: "troupe_started", ...run() });
  event({ type: "turn_end", turn_id: "t1" });
  event({ type: "troupe_finished", ...run({ state: "done", stages: [{ name: "Review", total: 4, done: 4, failed: 0, kept: 7 },
                                                                     { name: "Verify", total: 7, done: 7, failed: 0, kept: 5 }] }) });
  assert.equal($("troupe-count").textContent, "Done · 5 kept", "what the last stage kept");
  assert.equal($("troupebar").dataset.state, "done");
  event({ type: "turn_start", turn_id: "t2", prompt: "Troupe: Security review", kind: "monitor" });
  assert.ok(visible("troupebar"), "the turn its results wake is still about it");
  event({ type: "turn_end", turn_id: "t2" });
  event({ type: "turn_start", turn_id: "t3", prompt: "thanks, fix the first one", kind: "prompt" });
  assert.equal(visible("troupebar"), false, "your next message moves on");
});

test("with several troupes the row leads with the newest at work, and each has its own Stop when open", () => {
  const { doc, event, $, posted } = chat();
  event({ type: "turn_start", turn_id: "t1", prompt: "x", kind: "prompt" });
  event({ type: "troupe_started", ...run({ run_id: "tr-aaaaaaaaaa", title: "First" }) });
  event({ type: "troupe_started", ...run({ run_id: "tr-bbbbbbbbbb", title: "Second" }) });
  assert.equal($("troupe-label").textContent, "2 troupes");
  assert.equal($("troupe-title").textContent, "Second");
  assert.equal($("troupe-stop").dataset.troupeStop, "tr-bbbbbbbbbb");
  $("troupe-toggle").click();
  const runs = () => [...doc.querySelectorAll("#troupe-panel .troupe-run")].map((node) => node.dataset.troupeId);
  assert.deepEqual(runs(), ["tr-bbbbbbbbbb", "tr-aaaaaaaaaa"], "newest first");
  doc.querySelector('#troupe-panel [data-troupe-stop="tr-aaaaaaaaaa"]').click();
  assert.deepEqual(JSON.parse(JSON.stringify(posted.filter((m) => m.type === "stopTroupe"))), [{ type: "stopTroupe", run_id: "tr-aaaaaaaaaa" }]);
  assert.equal(doc.querySelector('#troupe-panel [data-troupe-stop="tr-aaaaaaaaaa"]').textContent, "Stopping…");
  event({ type: "troupe_finished", ...run({ run_id: "tr-bbbbbbbbbb", title: "Second", state: "done" }) });
  assert.equal($("troupe-title").textContent, "First", "the one still at work leads");
  assert.equal($("troupebar").dataset.state, "running");
  assert.equal($("troupe-dismiss").hidden, true, "nothing is dismissed while one still works");
});

test("a reconnect's snapshot brings back a running troupe, never a finished one, and a new chat starts without any", () => {
  const { doc, send, event, $, visible } = chat();
  event({ type: "turn_start", turn_id: "t1", prompt: "x", kind: "prompt" });
  // Newest first on the wire, as dgc/headless.py sends them.
  event({ type: "troupes", runs: [run({ run_id: "tr-dddddddddd", title: "Newest" }), run({ run_id: "tr-bbbbbbbbbb", state: "done" }),
                                  run({ run_id: "tr-aaaaaaaaaa", title: "Back" })] });
  $("troupe-toggle").click();
  assert.deepEqual([...doc.querySelectorAll("#troupe-panel .troupe-run")].map((node) => node.dataset.troupeId),
                   ["tr-dddddddddd", "tr-aaaaaaaaaa"], "the running ones, newest first; the finished one stays gone");
  assert.equal($("troupe-title").textContent, "Newest", "the newest leads, as it would have live");
  event({ type: "troupe_progress", ...run({ run_id: "tr-cccccccccc" }) });
  assert.equal(doc.querySelectorAll("#troupe-panel .troupe-run").length, 2, "progress for a troupe it never saw start adds none");
  event({ type: "session", kind: "new", session_id: "s2" });
  assert.equal(visible("troupebar"), false);
  assert.equal($("troupe-panel").hidden, true);
  send({ type: "event", event: { type: "troupe_progress", ...run({ run_id: "tr-aaaaaaaaaa" }) } });
  assert.equal(visible("troupebar"), false, "the last chat's troupe does not come back on a stray tick");
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
                       "Items (7)", "a.py", "… and 2 more", "one agent per item", "Its progress shows above the message box"]) {
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
