// A new session sends your first prompt once it's ready (ui-04-new-session-send-early, found live 10 Nov). Enter in a
// brand-new Work tab before its chat was ready said "DGC is reconnecting to this chat. Your draft is saved.", sent
// nothing until a second Enter, and the line stayed in the chat for good, even after the turn had finished.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom } from "./support/webview-dom.mjs";

const prompts = (x) => x.posted.filter((m) => m.type === "prompt");
const lines = (x) => [...x.doc.querySelectorAll("#log .sys")].map((n) => n.textContent.trim());
const connect = (x, id) => {
  x.send({ type: "session_ready", sessionId: id });
  x.send({ type: "event", event: { type: "ready", capabilities: {} } });
  x.send({ type: "event", event: { type: "history", items: [] } });
};

test("Enter in a new session before it's ready: it says it's starting, sends once by itself, and the line goes", () => {
  const x = makeDom({ scope: "tab-new", clock: true });
  const input = x.doc.getElementById("input");
  input.value = "Write a haiku about rivers";
  x.doc.getElementById("send").click();
  assert.equal(prompts(x).length, 0, "nothing is sent before the chat is ready");
  assert.deepEqual(lines(x), ["Starting this chat. Your message sends as soon as it's ready."]);
  assert.doesNotMatch(x.doc.body.textContent, /reconnecting/i, "a first start is not a reconnect");
  connect(x, "s-new");
  x.advance(2000);
  assert.deepEqual(prompts(x).map((m) => m.text), ["Write a haiku about rivers"], "sent once, with no second Enter");
  assert.deepEqual(lines(x), [], "the line goes once the chat is ready");
  // A later history (a reload) never sends it again.
  x.send({ type: "event", event: { type: "history", items: [] } });
  x.advance(5000);
  assert.equal(prompts(x).length, 1);
  assert.deepEqual(x.errors, []);
});

test("a chat that was ready and is reconnecting says so, and sends when it's back", () => {
  const x = makeDom({ scope: "tab-back", clock: true });
  connect(x, "s-back");
  x.send({ type: "backend_exit", code: 1, signal: null, recovering: true });
  const input = x.doc.getElementById("input");
  input.value = "carry on";
  x.doc.getElementById("send").click();
  assert.equal(prompts(x).length, 0);
  assert.ok(lines(x).includes("DGC is reconnecting to this chat. Your message sends as soon as it's back."), lines(x).join(" | "));
  connect(x, "s-back");
  x.advance(2000);
  assert.deepEqual(prompts(x).map((m) => m.text), ["carry on"]);
  assert.ok(!lines(x).some((l) => /Your message sends as soon/.test(l)), "the waiting line goes");
  assert.deepEqual(x.errors, []);
});

test("the box emptied before the chat is ready: nothing is sent, and the line still goes", () => {
  const x = makeDom({ scope: "tab-empty", clock: true });
  const input = x.doc.getElementById("input");
  input.value = "never mind";
  x.doc.getElementById("send").click();
  input.value = "";
  connect(x, "s-empty");
  x.advance(2000);
  assert.equal(prompts(x).length, 0);
  assert.deepEqual(lines(x), []);
  assert.deepEqual(x.errors, []);
});

test("it waits through a second drop, and a switch to another chat never sends it there", () => {
  const x = makeDom({ scope: "tab-twice", clock: true });
  const input = x.doc.getElementById("input");
  input.value = "first words";
  x.doc.getElementById("send").click();
  x.send({ type: "session_ready", sessionId: "s-twice" });
  x.send({ type: "backend_exit", code: 1, signal: null, recovering: true });   // gone again before it could send
  x.advance(2000);
  assert.equal(prompts(x).length, 0);
  connect(x, "s-twice");
  x.advance(2000);
  assert.deepEqual(prompts(x).map((m) => m.text), ["first words"], "sent when it came back");

  const y = makeDom({ scope: "tab-switch", clock: true });
  y.doc.getElementById("input").value = "meant for the first chat";
  y.doc.getElementById("send").click();
  y.send({ type: "chat_switched", slotId: "slot-2", label: "Other chat" });
  connect(y, "s-other");
  y.advance(2000);
  assert.equal(prompts(y).length, 0, "not sent into the chat switched to");
  assert.ok(!lines(y).some((l) => /Your message sends as soon/.test(l)));
  assert.deepEqual([...x.errors, ...y.errors], []);
});
