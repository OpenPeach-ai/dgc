// A Work session on a model DGC can't reach showed a context percentage before the first message (left from the 0.51
// checks): a number about a window nobody has used. Until the model has answered once in this chat (DGC's `requests`
// is 0), the meter shows no percentage, and its tooltip says why; after the first answer it is the usual number.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom } from "./support/webview-dom.mjs";

const READY = { type: "ready", model: "qwen3.8:27b", mode: "default", think: "off", base_url: "http://127.0.0.1:1/v1",
  workspace_trusted: true, commands: [], custom_commands: [], goal: { text: "", status: "none" }, context_size: 32768, capabilities: {} };

test("no percentage until the model has answered once; then the usual one", () => {
  const v = makeDom({});
  const event = (data) => v.send({ type: "event", event: data });
  event(READY);
  v.send({ type: "session_ready", sessionId: "s1" });
  event({ type: "context", used: 4900, size: 32768, requests: 0 });
  const ctx = v.doc.getElementById("ctx"), button = v.doc.getElementById("btn-ctx");
  assert.equal(ctx.textContent, "", "nothing measured yet");
  assert.match(button.title, /once the model answers/);
  event({ type: "context", used: 5200, size: 32768, requests: 1 });
  assert.equal(ctx.textContent, "16%");
});

test("an event that doesn't say how many requests keeps its percentage, as before", () => {
  const v = makeDom({});
  const event = (data) => v.send({ type: "event", event: data });
  event(READY);
  v.send({ type: "session_ready", sessionId: "s1" });
  event({ type: "context", used: 4900, size: 32768 });
  assert.equal(v.doc.getElementById("ctx").textContent, "15%");
  event({ type: "context", used: 4900, size: 32768, requests: 0 });
  assert.equal(v.doc.getElementById("ctx").textContent, "", "DGC said none yet");
});
