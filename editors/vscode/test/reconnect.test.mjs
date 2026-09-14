// The model-reconnect line and the model error row in the webview (jsdom).
//
// A retried model request is one muted `.model-retry` line inside its turn, updated in place by
// `retry_id` and closed in past tense; the final model error keeps its hint visible and opens to the
// exact cause. These tests drive media/main.js with the frames `dgc serve` sends and with history
// items that reach the same handler without schema validation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom } from "./support/webview-dom.mjs";

const HOST = "127.0.0.1:11434";
const ENDPOINT = `http://${HOST}/v1/chat/completions`;

function setup(options = {}) {
  const ctx = makeDom(options);
  const event = (value) => ctx.send({ type: "event", event: value });
  const lines = () => [...ctx.doc.querySelectorAll(".model-retry")];
  const label = (line) => line.querySelector(".model-retry-label").textContent;
  const announcer = () => ctx.doc.getElementById("announcer").textContent;
  return { ...ctx, event, lines, label, announcer };
}

function retry(fields = {}) {
  return { type: "model_retry", retry_id: "t1:retry1", state: "retrying", kind: "connect",
           layer: "request", attempt: 1, max_attempts: 3, summary: `connection refused by ${HOST}`,
           endpoint: ENDPOINT, model: "qwen3-coder:30b", api_mode: "chat_completions",
           detail: "HTTPConnectionPool(host='127.0.0.1', port=11434): Max retries exceeded with url: /v1/chat/completions (Caused by NewConnectionError(\"[Errno 111] Connection refused\"))",
           hint: "start your server (ollama serve / llama-server / LM Studio) or fix the URL; `dgc doctor` checks both",
           delay_ms: 500, origin: "agent", turn_id: "t1", ...fields };
}

test("a reconnect run updates one line in place and ends in past tense", () => {
  const { event, lines, label, doc, errors } = setup();
  event({ type: "turn_start", turn_id: "t1", prompt: "Go" });
  event({ type: "turn_activity", turn_id: "t1", state: "responding", label: "Responding" });
  event(retry());
  event({ type: "turn_activity", turn_id: "t1", state: "waiting", label: "Waiting to reconnect",
          detail: `connection refused · ${HOST} · backoff 0.5s · retry 1/3` });
  assert.equal(lines().length, 1);
  assert.equal(label(lines()[0]), "Reconnecting 1/3");
  assert.match(doc.querySelector(".thinking .verb").textContent, /^Waiting to reconnect/);
  event(retry({ attempt: 2, delay_ms: 1000 }));
  assert.equal(lines().length, 1, "the counter changes in place; no second line");
  assert.equal(label(lines()[0]), "Reconnecting 2/3");
  event(retry({ state: "recovered", attempt: 2, delay_ms: undefined }));
  event({ type: "turn_activity", turn_id: "t1", state: "responding", label: "Responding" });
  const line = lines()[0];
  assert.equal(lines().length, 1);
  assert.equal(label(line), "Reconnected after 2 retries");
  assert.equal(line.dataset.state, "recovered");
  assert.equal(line.querySelector(".model-retry-cause").textContent, HOST);
  assert.ok(line.querySelector(".model-retry-icon").classList.contains("codicon-plug"));
  assert.equal(doc.querySelector(".thinking .verb").textContent, "Responding");
  assert.ok(line.closest(".msg.dgc"), "the line sits inside its turn");
  assert.deepEqual(errors, []);
});

test("the reconnect line opens with the keyboard and shows every attempt's cause", () => {
  const { event, lines, posted, doc, dom, errors } = setup();
  event({ type: "turn_start", turn_id: "t1", prompt: "Go" });
  event(retry());
  event(retry({ attempt: 2, delay_ms: 1000 }));
  const line = lines()[0];
  const toggle = line.querySelector("button.model-retry-toggle");
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  const detail = doc.getElementById(toggle.getAttribute("aria-controls"));
  assert.ok(detail.hidden);
  toggle.focus();
  assert.equal(doc.activeElement, toggle);
  // A native button turns Enter/Space into a click; jsdom does not synthesise it, so click as the
  // browser would after the keydown.
  toggle.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  toggle.click();
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(detail.hidden, false);
  assert.equal(detail.getAttribute("role"), null, "no landmark per detail");
  assert.equal(line.querySelectorAll("[role=region]").length, 0);
  const items = [...detail.querySelectorAll(".model-retry-attempts li")];
  assert.equal(items.length, 2);
  assert.match(items[0].textContent, /^1 connection refused by 127\.0\.0\.1:11434 · retried after 0\.5s$/);
  assert.match(items[1].textContent, /^2 .* · retried after 1s$/);
  assert.equal(detail.querySelector("pre.model-retry-raw").textContent, retry().detail);
  const facts = [...detail.querySelectorAll("dt")].map((dt) => dt.textContent);
  assert.deepEqual(facts, ["Cause", "Model", "Endpoint"]);
  assert.match(detail.querySelector(".model-retry-hint").textContent, /start your server/);
  // An update while open keeps it open.
  event(retry({ state: "recovered", attempt: 2 }));
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(detail.hidden, false);
  detail.querySelector("button.model-retry-copy").click();
  const copy = posted.filter((m) => m.type === "copy").at(-1);
  assert.ok(copy, "Copy details posts copy");
  assert.match(copy.text, /Reconnected after 2 retries/);
  assert.match(copy.text, /Endpoint: http:\/\/127\.0\.0\.1:11434\/v1\/chat\/completions/);
  assert.ok(detail.querySelector("button.model-retry-copy .codicon").classList.contains("codicon-check"));
  assert.deepEqual(errors, []);
});

test("a busy server and a server error say so, and a stall says Retrying", () => {
  const { event, lines, label } = setup();
  event({ type: "turn_start", turn_id: "t1", prompt: "Go" });
  event(retry({ retry_id: "t1:retry1", kind: "rate_limited", http_status: 429, summary: `HTTP 429 from ${HOST}` }));
  event(retry({ retry_id: "t1:retry2", kind: "overloaded", http_status: 503, summary: `HTTP 503 from ${HOST}` }));
  event(retry({ retry_id: "t1:retry3", kind: "http", http_status: 502, summary: `HTTP 502 from ${HOST}` }));
  event(retry({ retry_id: "t1:retry4", kind: "stall", max_attempts: 2, summary: "no tokens from m at h for 300s" }));
  assert.deepEqual(lines().map(label), ["Server is busy, retrying 1/3", "Server is busy, retrying 1/3",
    "Server error, retrying 1/3", "Retrying 1/2"]);
  event(retry({ retry_id: "t1:retry1", kind: "rate_limited", state: "recovered", summary: `HTTP 429 from ${HOST}` }));
  assert.equal(label(lines()[0]), "Recovered after 1 retry");
  event(retry({ retry_id: "t1:retry3", kind: "http", state: "cancelled" }));
  assert.equal(label(lines()[2]), "Stopped while retrying");
});

test("interleaved runs keep separate lines, and a sub-agent's line says whose it is", () => {
  const { event, lines, label } = setup();
  event({ type: "turn_start", turn_id: "t1", prompt: "Go" });
  event(retry({ retry_id: "t1:retry1" }));
  event({ type: "tool_call", call_id: "c1", name: "read_file", args: { path: "a.py" }, summary: "a.py" });
  event(retry({ retry_id: "t1:sub-0123456789ab:retry1", origin: "subagent", agent: "sub-0123456789ab" }));
  event(retry({ retry_id: "t1:retry1", attempt: 2 }));
  event(retry({ retry_id: "t1:sub-0123456789ab:retry1", state: "recovered", origin: "subagent", agent: "sub-0123456789ab" }));
  assert.equal(lines().length, 2);
  assert.equal(label(lines()[0]), "Reconnecting 2/3");
  assert.equal(label(lines()[1]), "Sub-agent · Reconnected after 1 retry");
});

test("tools after a reconnect land in a second tool group below its line", () => {
  const { event, doc, lines } = setup();
  event({ type: "turn_start", turn_id: "t1", prompt: "Go" });
  event({ type: "tool_call", call_id: "c1", name: "read_file", args: { path: "a.py" }, summary: "a.py" });
  event({ type: "tool_result", call_id: "c1", name: "read_file", output: "x", is_error: false, is_diff: false, diff: "" });
  event(retry());
  event(retry({ state: "recovered" }));
  event({ type: "tool_call", call_id: "c2", name: "read_file", args: { path: "b.py" }, summary: "b.py" });
  const groups = [...doc.querySelectorAll(".tool-group")];
  assert.equal(groups.length, 2);
  const line = lines()[0];
  const second = doc.querySelector('.tool[data-call-id="c2"]');
  assert.ok(line.compareDocumentPosition(second) & doc.defaultView.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.equal(second.closest(".tool-group"), groups[1]);
  assert.ok(groups[0].compareDocumentPosition(line) & doc.defaultView.Node.DOCUMENT_POSITION_FOLLOWING);
});

test("a frame from a discarded or other turn never reaches the live chat", () => {
  const { event, send, lines, label } = setup();
  event({ type: "turn_start", turn_id: "t1", prompt: "Go" });
  event(retry());
  event({ type: "session", kind: "new", session_id: "s2" });
  event(retry({ state: "recovered" }));
  assert.equal(lines().length, 0, "the new chat never shows the old turn's line");
  event({ type: "turn_start", turn_id: "t2", prompt: "Again" });
  event(retry({ turn_id: "t1", retry_id: "t1:retry9" }));
  assert.equal(lines().length, 0, "a t1 frame while t2 is live is dropped");
  event(retry({ turn_id: undefined, retry_id: "abcd:retry1" }));
  assert.equal(lines().length, 1, "a turnless frame is drawn");
  send({ type: "backend_exit", code: 1, signal: null, recovering: false });
  event(retry({ turn_id: undefined, retry_id: "abcd:retry1", state: "recovered" }));
  const old = lines()[0];
  assert.notEqual(label(old), "Reconnected after 1 retry", "a restarted backend's id does not update an old line");
});

test("every turn ending settles a live line, and only the backend can say Gave up", () => {
  // (a) turn_end error
  {
    const { event, lines, label } = setup();
    event({ type: "turn_start", turn_id: "t1", prompt: "Go" });
    event(retry());
    event({ type: "turn_end", turn_id: "t1", reason: "error" });
    assert.equal(label(lines()[0]), "Reconnect did not finish");
    assert.equal(lines()[0].dataset.state, "unfinished");
  }
  // (b) backend exit, not recovering
  {
    const { event, send, lines, label } = setup();
    event({ type: "turn_start", turn_id: "t1", prompt: "Go" });
    event(retry());
    send({ type: "backend_exit", code: 1, signal: null, recovering: false });
    assert.equal(label(lines()[0]), "Reconnect did not finish");
  }
  // (c) backend exit while recovering, then the 30 s timer
  {
    const { event, send, lines, label, advance, doc } = setup({ clock: true });
    event({ type: "turn_start", turn_id: "t1", prompt: "Go" });
    event(retry());
    send({ type: "backend_exit", code: null, signal: "SIGKILL", recovering: true });
    assert.equal(label(lines()[0]), "Reconnecting 1/3", "still recovering: nothing is claimed yet");
    assert.equal(doc.querySelector(".thinking .verb").textContent, "Restarting the DGC backend");
    advance(30000);
    assert.equal(label(lines()[0]), "Reconnect did not finish");
  }
  // (d) cancelled
  {
    const { event, lines, label } = setup();
    event({ type: "turn_start", turn_id: "t1", prompt: "Go" });
    event(retry());
    event({ type: "turn_end", turn_id: "t1", reason: "cancelled" });
    assert.equal(label(lines()[0]), "Stopped while reconnecting");
    assert.ok(lines()[0].querySelector(".model-retry-icon").classList.contains("codicon-circle-slash"));
  }
  // (e) a real give-up
  {
    const { event, lines, label } = setup();
    event({ type: "turn_start", turn_id: "t1", prompt: "Go" });
    event(retry());
    event(retry({ attempt: 2 }));
    event(retry({ attempt: 3 }));
    event(retry({ state: "gave_up", attempt: 3 }));
    event({ type: "turn_end", turn_id: "t1", reason: "error" });
    assert.equal(label(lines()[0]), "Gave up after 3 retries");
    assert.equal(lines()[0].dataset.state, "gave_up");
  }
});

test("a model error with a cause keeps its hint visible and opens to the full message", () => {
  const { event, doc, lines, errors, announcer } = setup();
  event({ type: "turn_start", turn_id: "t1", prompt: "Go" });
  event(retry());
  const message = `cannot connect to http://${HOST}/v1 — is your local LLM server running? (/connect <url> to change it)\n`
    + "HTTPConnectionPool(...): Max retries exceeded\n  → the endpoint http://127.0.0.1:11434/v1 is not answering — start your server (ollama serve / llama-server / LM Studio) or fix the URL; `dgc doctor` checks both";
  event({ type: "error", message, cause: { kind: "connect", summary: `connection refused by ${HOST}`,
    endpoint: `http://${HOST}/v1`, model: "qwen3-coder:30b", attempts: 4, retry_id: "t1:retry1",
    hint: "ignored when the message carries one" } });
  const row = doc.querySelector(".sys.err.model-error");
  assert.ok(row);
  assert.equal(row.getAttribute("role"), "alert");
  assert.equal(row.querySelector(".model-error-headline").textContent, `Could not reach the model · connection refused by ${HOST}`);
  const hint = row.querySelector(".model-error-hint");
  assert.equal(hint.hidden, false);
  assert.match(hint.textContent, /^→ the endpoint .* start your server/);
  const toggle = row.querySelector(".model-error-toggle");
  assert.ok(doc.getElementById(toggle.getAttribute("aria-controls")).hidden);
  toggle.click();
  const pre = row.querySelector("pre.model-error-message");
  assert.equal(pre.textContent, message);
  assert.ok(pre.textContent.includes("\n  → "), "the break before the hint is kept");
  assert.equal(lines()[0].dataset.state, "gave_up", "the matching retry line gave up");
  assert.match(announcer(), /^DGC error: Could not reach the model/);
  assert.deepEqual(errors, []);
});

test("an error without a cause, or with a malformed one, is today's plain line", () => {
  const { event, doc } = setup();
  event({ type: "error", message: "plain failure\n  → hint" });
  event({ type: "error", message: "bad cause", cause: { kind: 7, summary: 12 } });
  event({ type: "error", message: "bad field", cause: { kind: "connect", summary: "x", endpoint: 5 } });
  assert.equal(doc.querySelectorAll(".model-error").length, 0);
  const plain = [...doc.querySelectorAll(".sys.err")].map((n) => n.textContent);
  assert.deepEqual(plain, ["plain failure\n  → hint", "bad cause", "bad field"]);
  // A 404 names the model.
  event({ type: "error", message: "HTTP 404", cause: { kind: "model_not_found", summary: `HTTP 404 from ${HOST}`, model: "qwen3-coder:30b" } });
  assert.equal(doc.querySelector(".model-error-headline").textContent,
    `The server has no model named qwen3-coder:30b · HTTP 404 from ${HOST}`);
});

test("replayed stream recoveries render inside their turn, silently, and coerce bad types", () => {
  const { event, lines, label, announcer, errors } = setup();
  event({ type: "history", items: [
    { type: "turn_start", turn_id: "h1", prompt: "Write it", kind: "prompt" },
    { type: "text_delta", text: "The first half" },
    { type: "stream_end", message_id: "h1:1", phase: "commentary" },
    { type: "model_retry", retry_id: "h1:retry1", state: "recovered", kind: "stream_cut", layer: "continuation",
      attempt: 1, max_attempts: 8, summary: `stream from ${HOST} ended before [DONE]`, endpoint: HOST, turn_id: "h1" },
    { type: "text_delta", text: " and the rest" },
    { type: "stream_end", message_id: "h1:2", phase: "answer" },
    { type: "turn_end", turn_id: "h1", reason: "completed", final_message_id: "h1:2" },
    { type: "turn_start", turn_id: "h2", prompt: "Again", kind: "prompt" },
    { type: "text_delta", text: "Partial" },
    { type: "stream_end", message_id: "h2:1", phase: "answer" },
    { type: "model_retry", retry_id: "h2:retry1", state: "retrying", kind: "stream_cut", layer: "continuation",
      attempt: 1, max_attempts: 8, summary: "the stream ended before its terminal event", turn_id: "h2" },
    { type: "turn_end", turn_id: "h2", reason: "cancelled", final_message_id: null },
    { type: "turn_start", turn_id: "h3", prompt: "Odd", kind: "prompt" },
    { type: "model_retry", retry_id: "h3:retry1", state: "bogus", kind: "weird", layer: 4, attempt: "x",
      max_attempts: {}, summary: 5, endpoint: ["x"], turn_id: "h3" },
    { type: "turn_end", turn_id: "h3", reason: "completed", final_message_id: null },
  ] });
  const drawn = lines();
  assert.equal(drawn.length, 3);
  assert.equal(label(drawn[0]), "Reconnected · continued from the partial answer");
  assert.equal(label(drawn[1]), "Reconnect did not finish",
    "a replayed turn's reason is only what the file supports: never Stopped, never Gave up");
  assert.equal(drawn[2].dataset.kind, "other");
  assert.equal(label(drawn[2]), "Reconnect did not finish");
  assert.equal(announcer(), "", "replay speaks nothing");
  assert.deepEqual(errors, []);
});

test("a replayed recovery at the end of a completed turn reads Reconnect did not finish", () => {
  const { event, lines, label } = setup();
  event({ type: "history", items: [
    { type: "turn_start", turn_id: "h1", prompt: "Write it", kind: "prompt" },
    { type: "text_delta", text: "Partial" },
    { type: "stream_end", message_id: "h1:1", phase: "answer" },
    { type: "model_retry", retry_id: "h1:retry1", state: "retrying", kind: "stream_cut", layer: "continuation",
      attempt: 3, max_attempts: 8, summary: "the stream ended before its terminal event", turn_id: "h1" },
    { type: "turn_end", turn_id: "h1", reason: "completed", final_message_id: "h1:1" },
  ] });
  assert.equal(label(lines()[0]), "Reconnect did not finish");
  assert.equal(lines()[0].dataset.state, "unfinished");
});

test("announcements: first loss and first recovery only", () => {
  const { event, announcer, doc, dom } = setup();
  event({ type: "turn_start", turn_id: "t1", prompt: "Go" });
  event(retry());
  assert.equal(announcer(), "Connection to the model lost, reconnecting");
  doc.getElementById("announcer").textContent = "";
  event(retry({ attempt: 2 }));
  event(retry({ retry_id: "t1:sub-0123456789ab:retry1", origin: "subagent", agent: "sub-0123456789ab" }));
  assert.equal(announcer(), "", "attempt 2 and a second concurrent run stay silent");
  event(retry({ state: "recovered", attempt: 2 }));
  assert.equal(announcer(), "Reconnected to the model");
  doc.getElementById("announcer").textContent = "";
  event(retry({ retry_id: "t1:sub-0123456789ab:retry1", state: "recovered", origin: "subagent" }));
  event(retry({ retry_id: "t1:retry2", attempt: 1 }));
  event(retry({ retry_id: "t1:retry2", state: "cancelled" }));
  assert.equal(announcer(), "", "one loss and one recovery per turn; cancel says nothing");
  // A hidden panel announces nothing.
  event({ type: "turn_start", turn_id: "t2", prompt: "Busy" });
  Object.defineProperty(dom.window.document, "visibilityState", { configurable: true, get: () => "hidden" });
  event(retry({ turn_id: "t2", retry_id: "t2:retry1", kind: "overloaded" }));
  assert.equal(announcer(), "DGC is working");
  Object.defineProperty(dom.window.document, "visibilityState", { configurable: true, get: () => "visible" });
  event(retry({ turn_id: "t2", retry_id: "t2:retry2", kind: "overloaded" }));
  assert.equal(announcer(), "The model server is busy, retrying");
});

test("hostile strings stay text", () => {
  const { event, doc, lines } = setup();
  const evil = '<img src=x onerror="window.__pwned=1">';
  event({ type: "turn_start", turn_id: "t1", prompt: "Go" });
  event(retry({ summary: evil, detail: evil, hint: evil, model: evil, endpoint: evil, engine: evil, origin: "engine" }));
  event({ type: "error", message: evil, cause: { kind: "connect", summary: evil, detail: evil, model: evil } });
  assert.equal(doc.querySelectorAll("img").length, 0);
  assert.equal(doc.defaultView.__pwned, undefined);
  assert.ok(lines()[0].textContent.includes(evil));
});

test("an engine's own retry has no endpoint and names the engine", () => {
  const { event, lines, label } = setup();
  event({ type: "turn_start", turn_id: "t1", prompt: "Go" });
  event({ type: "model_retry", retry_id: "t1:retry1", state: "retrying", kind: "connect", layer: "request",
          attempt: 1, summary: "waiting for network · Connection failed: error sending request",
          origin: "engine", engine: "Codex", turn_id: "t1" });
  assert.equal(label(lines()[0]).trim(), "Codex · Reconnecting · waiting for network");
  lines()[0].querySelector(".model-retry-toggle").click();
  const facts = [...lines()[0].querySelectorAll("dt")].map((dt) => dt.textContent);
  assert.ok(!facts.includes("Endpoint"));
  assert.ok(facts.includes("Engine"));
});
