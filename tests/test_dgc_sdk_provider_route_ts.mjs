#!/usr/bin/env node
/** SDK 0.9.0 against what CLI 0.51.0 added, in TypeScript: one session's provider and model, a follow-up taken out of the
 *  queue, Trace, ChatDGC's @ list and marks, a Router model's thinking, cards per surface, and Pips API 74. A real
 *  `dgc serve` and a local mock model where the behaviour is the CLI's; an offline wire where it is the SDK's own check.
 *  Run: node --experimental-strip-types --test tests/test_dgc_sdk_provider_route_ts.mjs */
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DGC, Session, DGCConfigError, DGCUnsupportedError } from "../sdk/typescript/src/index.ts";
import { KNOWN_EVENTS } from "../sdk/typescript/src/transport.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const runtime = () => [process.env.DGC_TEST_PYTHON || process.env.DGC_PYTHON || join(ROOT, ".venv/bin/python"), "-m", "dgc", "serve"];
const sse = (delta, finish = null) => "data: " + JSON.stringify({ id: "mock", object: "chat.completion.chunk",
  choices: [{ index: 0, delta, finish_reason: finish }] }) + "\n\n";
const answer = (words) => sse({ content: words }) + sse({}, "stop") + "data: [DONE]\n\n";
const PROVIDER = "provider_" + "a".repeat(32);

/** A model. `hold` is a word: a request saying it waits for release(). */
function model(words, hold = "") {
  const seen = { auth: [], models: [], said: [] };
  let free = () => {};
  const held = new Promise((done) => { free = done; });
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url?.endsWith("/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "sdk-model" }] }));
      return;
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      const users = (body.messages || []).filter((m) => m.role === "user");
      const raw = users.length ? users[users.length - 1].content : "";
      const said = Array.isArray(raw) ? raw.map((p) => p.text || "").join(" ") : String(raw || "");
      seen.auth.push(req.headers.authorization || "");
      seen.models.push(String(body.model || ""));
      seen.said.push(said);
      if (hold && said.includes(hold)) await held;
      const payload = answer(words);
      res.writeHead(200, { "Content-Type": "text/event-stream", "Content-Length": Buffer.byteLength(payload) });
      res.end(payload);
    });
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done({
    seen, release: free, url: `http://127.0.0.1:${server.address().port}/v1`, close: () => { free(); server.close(); server.closeAllConnections(); },
  })));
}

async function live(words, hold, fn) {
  const first = await model(words, hold);
  const tmp = mkdtempSync(join(tmpdir(), "dgc-sdk-ts-route-"));
  const work = join(tmp, "work");
  const stateDir = join(tmp, "state");
  mkdirSync(work);
  writeFileSync(join(work, "README.md"), "empty cart checkout\n");
  const home = process.env.HOME;
  process.env.HOME = tmp;
  const dgc = new DGC({ stateDir, model: "sdk-model", baseUrl: first.url, apiKey: "sk-local", runtime: runtime() });
  try {
    await fn({ dgc, first, work, stateDir });
  } finally {
    await dgc.close();
    first.close();
    process.env.HOME = home;
    rmSync(tmp, { recursive: true, force: true });
  }
}

const AUTO = { mode: "auto", unhandled: "deny" };

function configs(dir, out = {}) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) configs(path, out);
    else if (name === "config.json") out[path] = readFileSync(path, "utf8");
  }
  return out;
}

test("setModel moves this session only, with the new key at the new address", async () => {
  await live("FIRST answered.", "", async ({ dgc, work, stateDir }) => {
    const second = await model("SECOND-PROVIDER answered.");
    try {
      const session = await dgc.session({ cwd: work, permissions: AUTO });
      assert.equal(session.capabilities.session_model_route, true);
      const before = await session.run("Summarize README. Do not edit files.", { timeoutMs: 60_000 });
      assert.equal(before.status, "completed", before.error);
      const saved = configs(stateDir);
      const moved = await session.setModel("second-model", { baseUrl: second.url, apiKey: "sk-second", apiMode: "chat_completions" });
      assert.deepEqual(moved, { model: "second-model", baseUrl: second.url });
      assert.equal(await session.setThinking("low"), "low");
      const result = await session.run("Say who you are.", { timeoutMs: 60_000 });
      assert.equal(result.status, "completed", result.error);
      assert.match(result.finalText, /SECOND-PROVIDER/);
      assert.ok(second.seen.models.includes("second-model"));
      assert.deepEqual([...new Set(second.seen.auth)], ["Bearer sk-second"]);
      assert.deepEqual(configs(stateDir), saved, "nothing went into the client's settings");
      const other = await dgc.session({ cwd: work, permissions: AUTO });
      assert.equal((await other.getConfig()).model, "sdk-model", "another session keeps its own");
    } finally {
      second.close();
    }
  });
});

test("moving without a key sends the old key nowhere", async () => {
  await live("FIRST answered.", "", async ({ dgc, work }) => {
    const second = await model("SECOND-PROVIDER answered.");
    try {
      const session = await dgc.session({ cwd: work, permissions: AUTO });
      await session.setModel("second-model", { baseUrl: second.url });
      const result = await session.run("Say who you are.", { timeoutMs: 60_000 });
      assert.equal(result.status, "completed", result.error);
      assert.ok(second.seen.auth.length);
      assert.deepEqual(second.seen.auth.filter((value) => value.includes("sk-local")), []);
    } finally {
      second.close();
    }
  });
});

test("cancelling a waiting follow-up takes it out, so it never starts", async () => {
  await live("ANSWERED.", "first task", async ({ dgc, first, work }) => {
    const session = await dgc.session({ cwd: work, permissions: AUTO });
    assert.equal(session.capabilities.queue_edit, true);
    const running = session.stream("first task", { timeoutMs: 60_000 });
    const taken = session.followup("taken out", { timeoutMs: 60_000 });
    const kept = session.followup("kept", { timeoutMs: 60_000 });
    const seen = [];
    for await (const event of running) {
      seen.push(event.type);
      if (event.type === "turn_start") taken.cancel();
      if (event.type === "queue_changed") {
        assert.equal(event.data.count, 1);
        assert.equal(event.data.order.length, 1);
        first.release();
      }
    }
    const gone = await taken.result(60_000);
    const done = await kept.result(60_000);
    const after = await session.run("Summarize README. Do not edit files.", { timeoutMs: 60_000 });
    assert.ok(seen.includes("queue_changed"));
    assert.equal(gone.status, "cancelled");
    assert.ok(!gone.error, "the app asked for it: no failure to report");
    assert.deepEqual(gone.tools, []);
    assert.equal(done.status, "completed", done.error);
    assert.equal(after.status, "completed", after.error);
    assert.deepEqual(first.seen.said.filter((text) => text.includes("taken out")), [], "the model never saw it");
    assert.ok(first.seen.said.some((text) => text.includes("kept")), "the one behind it still ran");
  });
});

test("Trace reaches history and a chat reply", async () => {
  await live("ANSWERED.", "", async ({ dgc, work }) => {
    const session = await dgc.session({ cwd: work, permissions: AUTO });
    const result = await session.run("Summarize README. Do not edit files.", { timeoutMs: 60_000 });
    assert.equal(result.status, "completed", result.error);
    const history = await session.history();
    assert.ok(history.items.some((item) => item.role === "time" && item.of === "trace"), "a saved turn carries its Trace marks");
    const chats = await dgc.chat();
    const reply = await chats.ask("What does the checkout do?", { search: "off" });
    assert.equal(reply.trace.v, 1);
    assert.equal(reply.trace.steps[0].kind, "model");
    await chats.close();
  });
});

test("ChatDGC's @ list, and marks come back with the sent message", async () => {
  await live("ANSWERED.", "", async ({ dgc }) => {
    const chats = await dgc.chat();
    const named = await chats.mentions();
    assert.ok(Array.isArray(named.plugins));
    assert.ok(Array.isArray(named.pips));
    const mark = { start: 0, kind: "file", label: "app.py", identity: "app.py" };
    const chat = await chats.new();
    let last;
    for await (const event of chat.stream("what does it do?", { search: "off", displayMentions: [mark] })) last = event;
    assert.equal(last.kind, "reply");
    const sent = chat.messages.find((message) => message.role === "user");
    assert.deepEqual(sent.display_mentions, [mark]);
    await chats.close();
  });
});

const init = { options: {}, unhandled: "deny", instructions: "", toolHub: null, cwd: null, policy: null,
  department: "", usageLog: null, auditLog: null, model: "", permissionMode: "default", isolated: false,
  verifyCommand: "", stateLock: null, excludePaths: [], requestTimeoutMs: 1000,
  sandbox: { requirement: "off", active: false, backend: "", reason: "" } };

function offline(capabilities) {
  const calls = [], sent = [];
  const wire = {
    send: (payload) => { sent.push(payload); },
    request: async (payload, response, opts) => {
      calls.push(payload);
      if (payload.type === "pips_control") {
        return { type: "pips_result", request_id: opts.requestId, command: payload.request.type, ok: true, result: {} };
      }
      return { type: response, request_id: payload.request_id, status: { systems: [] }, change: "NAS thinks low." };
    },
  };
  return { calls, sent, session: new Session(wire, { capabilities }, init) };
}

test("the events an app may see are known", () => {
  for (const name of ["model_provider_saved", "queue_changed", "trace_usage", "chatdgc_waiting", "chatdgc_mentions"]) {
    assert.ok(KNOWN_EVENTS.has(name), name);
  }
});

test("an older CLI is told before anything is sent", async () => {
  const { calls, session } = offline({});
  await assert.rejects(session.setModel("m"), DGCUnsupportedError);
  await assert.rejects(session.setThinking("low"), DGCUnsupportedError);
  assert.deepEqual(calls, []);
});

test("setModel and setThinking refuse what they cannot do", async () => {
  const { calls, session } = offline({ session_model_route: true });
  await assert.rejects(session.setModel(), /needs a model or a baseUrl/);
  await assert.rejects(session.setModel("m", { apiMode: "smoke" }), /apiMode must be/);
  await assert.rejects(session.setThinking("huge"), /thinking must be/);
  assert.deepEqual(calls, []);
});

test("a Router model's thinking", async () => {
  const { calls, session } = offline({ router: { commands: ["router_status", "router_thinking"] } });
  assert.equal((await session.router.setThinking("nas", "qwen", "low")).change, "NAS thinks low.");
  assert.equal(calls[0].thinking, "low");
  await assert.rejects(session.router.setThinking("nas", "qwen", "xhigh"), DGCConfigError);
  const older = offline({ router: { commands: ["router_status"] } });
  await assert.rejects(older.session.router.setThinking("nas", "qwen", "low"), DGCUnsupportedError);
});

test("cards.watch says whose", () => {
  const { sent, session } = offline({ mcp_apps: { version: 1 } });
  session.cards.watch();
  session.cards.watch("pip");
  assert.deepEqual(sent, [{ type: "watch_mcp_apps" }, { type: "watch_mcp_apps", surface: "pip" }]);
  assert.throws(() => session.cards.watch("home"), DGCConfigError);
});

const PIPS = { pips_supported: true, pips_enabled: true };

test("a Pip on a saved provider needs API 74 and the whole choice", async () => {
  const choice = { mode: "provider", provider: PROVIDER, model: "m" };
  const create = { workspace_id: "personal", name: "A", goal: "b", model_choice: choice };
  const old = offline({ ...PIPS, pips_api_version: 73 });
  await assert.rejects(old.session.pips.mutate("create_pip", create, { approved: true }), /API 74/);
  assert.deepEqual(old.calls, []);
  const now = offline({ ...PIPS, pips_api_version: 74 });
  await now.session.pips.mutate("create_pip", create, { approved: true });
  assert.deepEqual(now.calls[0].request.model_choice, choice);
  for (const bad of [{ ...choice, provider: "openai" }, { mode: "provider", provider: PROVIDER }, { ...choice, api_key: "sk" }]) {
    await assert.rejects(now.session.pips.mutate("create_pip", { ...create, model_choice: bad }, { approved: true }), /saved provider/);
  }
});

test("marks in a Pip's chat need the CLI that keeps them", async () => {
  const message = { pip_id: "pip_rook", text: "hello", idempotency_key: "one",
    display_mentions: [{ start: 0, kind: "file", label: "a.py", identity: "a.py" }] };
  const old = offline({ ...PIPS, pips_api_version: 74 });
  await assert.rejects(old.session.pips.mutate("send_pip_message", message, { approved: true }), /pip_display_mentions/);
  assert.deepEqual(old.calls, []);
  const now = offline({ ...PIPS, pips_api_version: 74, pip_display_mentions: 1 });
  await now.session.pips.mutate("send_pip_message", message, { approved: true });
  assert.equal(now.calls.length, 1);
});
