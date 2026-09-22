#!/usr/bin/env node
/** TypeScript SDK conformance. Run: node --experimental-strip-types --test tests/test_dgc_sdk_ts.mjs */
import { createServer } from "node:http";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DGC, defineTool, extractJson, validate, assertSupported } from "../sdk/typescript/src/index.ts";
import { engineDenyRules, looksLikeWrite, policyDecision } from "../sdk/typescript/src/policy.ts";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

function sse(delta, finish = null) {
  return "data: " + JSON.stringify({
    id: "mock", object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: finish }],
  }) + "\n\n";
}
function answer(text) { return sse({ content: text }) + sse({}, "stop") + "data: [DONE]\n\n"; }
function call(name, args) {
  return sse({ tool_calls: [{ index: 0, id: "call_1", type: "function",
    function: { name, arguments: JSON.stringify(args) } }] })
    + sse({}, "tool_calls") + "data: [DONE]\n\n";
}

function startModel(behavior = "text") {
  const state = { behavior, posts: 0 };
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url?.endsWith("/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "sdk-model" }] }));
      return;
    }
    if (req.method !== "POST") { res.writeHead(404); res.end(); return; }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      state.posts += 1;
      if (state.behavior === "flaky429" && state.posts <= 2) {
        const body = JSON.stringify({ error: { message: "rate limited" } });
        res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "0", "Content-Length": Buffer.byteLength(body) });
        res.end(body);
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      const messages = body.messages || [];
      let last = "";
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "tool") { last = "TOOL:" + (messages[i].content || ""); break; }
        if (messages[i].role === "user") { last = String(messages[i].content || ""); break; }
      }
      let payload = answer("The checkout flow creates an empty cart and then redirects.");
      if (last.startsWith("TOOL:") && state.behavior === "mcp") payload = answer("SKU Widget is in stock.");
      else if (last.startsWith("TOOL:")) payload = answer("Done.");
      else if (state.behavior === "mcp" || last.toLowerCase().includes("look up sku")) {
        payload = call("mcp__app__sku_lookup", { sku: "A-1" });
      } else if (last.includes("Return only valid JSON") || state.behavior === "json") {
        payload = answer('{"ok": true, "summary": "cart is empty"}');
      } else if (state.behavior === "edit" || last.toLowerCase().startsWith("edit ")) {
        payload = call("write_file", { path: "guard.py", content: "ok\n" });
      }
      res.writeHead(200, { "Content-Type": "text/event-stream", "Content-Length": Buffer.byteLength(payload) });
      res.end(payload);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, state, baseUrl: `http://127.0.0.1:${port}/v1` });
    });
  });
}

test("write deny inspects bash redirects", () => {
  const policy = { denyTools: ["write_file"], network: "allow" };
  assert.equal(policyDecision(policy, { id: "1", name: "bash", args: { command: "echo pwned > escaped.txt" } }), "deny");
  assert.equal(policyDecision(policy, { id: "2", name: "bash", args: { command: "ls" } }), null);
  assert.equal(policyDecision(policy, { id: "3", name: "bash", args: { command: "ls 2>&1" } }), null);
  assert.ok(looksLikeWrite("echo x | tee out.txt"));
  assert.ok(!looksLikeWrite("cat README.md"));
  const rules = engineDenyRules(policy);
  assert.ok(rules.includes("Write"));
  assert.ok(rules.some((row) => row.includes("*>[!&]*")));
  const interactive = engineDenyRules(policy, { inspectBash: false });
  assert.ok(interactive.includes("Write"));
  assert.ok(!interactive.some((row) => row.startsWith("Bash(")));
});

test("schema extract and validate", () => {
  const value = extractJson('Here you go:\n```json\n{"ok": true}\n```');
  assert.deepEqual(value, { ok: true });
  assert.deepEqual(validate(value, { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } }, additionalProperties: false }), []);
  assert.ok(validate({ ok: 1 }, { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } }).length);
  assert.throws(() => assertSupported({ $ref: "#/" }));
});

test("defineTool rejects a blank name", () => {
  assert.throws(() => defineTool("", "n", { type: "object" }, () => "x"));
});

test("custom tool runs in the host process", async () => {
  const { server, baseUrl } = await startModel("mcp");
  const work = mkdtempSync(join(tmpdir(), "dgc-sdk-ts-work-"));
  const stateDir = mkdtempSync(join(tmpdir(), "dgc-sdk-ts-state-"));
  writeFileSync(join(work, "README.md"), "empty cart checkout\n");
  const seen = [];
  const tool = defineTool(
    "sku_lookup",
    "Look up a product SKU in the company catalog",
    { type: "object", properties: { sku: { type: "string" } }, required: ["sku"] },
    (args) => { seen.push({ ...args }); return { name: "Widget", sku: args.sku }; },
  );
  const dgc = new DGC({
    stateDir, model: "sdk-model", baseUrl, apiKey: "sk-local",
    runtime: [process.env.DGC_PYTHON || join(ROOT, ".venv/bin/python"), "-m", "dgc", "serve"],
  });
  try {
    const session = await dgc.session({
      cwd: work, permissions: { mode: "auto", unhandled: "deny" }, tools: [tool],
    });
    const result = await session.run("look up sku A-1", { timeoutMs: 60_000 });
    assert.ok(seen.length, "host tool handler must run");
    assert.equal(seen[0].sku, "A-1");
    assert.equal(result.status, "completed");
    assert.match(result.finalText.toLowerCase(), /widget/);
  } finally {
    await dgc.close();
    server.close();
    rmSync(work, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("outputSchema is validated on the harness", async () => {
  const { server, baseUrl } = await startModel("json");
  const work = mkdtempSync(join(tmpdir(), "dgc-sdk-ts-work-"));
  const stateDir = mkdtempSync(join(tmpdir(), "dgc-sdk-ts-state-"));
  writeFileSync(join(work, "README.md"), "empty cart checkout\n");
  const dgc = new DGC({
    stateDir, model: "sdk-model", baseUrl, apiKey: "sk-local",
    runtime: [process.env.DGC_PYTHON || join(ROOT, ".venv/bin/python"), "-m", "dgc", "serve"],
  });
  try {
    const session = await dgc.session({ cwd: work, permissions: { mode: "auto", unhandled: "deny" } });
    const result = await session.run("Summarize README as JSON.", {
      timeoutMs: 60_000,
      outputSchema: {
        type: "object", required: ["ok", "summary"],
        properties: { ok: { type: "boolean" }, summary: { type: "string" } },
        additionalProperties: false,
      },
      repairAttempts: 0,
    });
    assert.equal(result.status, "completed");
    assert.equal(result.output.ok, true);
    assert.match(String(result.output.summary), /cart/);
  } finally {
    await dgc.close();
    server.close();
    rmSync(work, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

function runtime() {
  return [process.env.DGC_PYTHON || join(ROOT, ".venv/bin/python"), "-m", "dgc", "serve"];
}

test("usage is queryable by department", async () => {
  const { server, baseUrl } = await startModel("text");
  const work = mkdtempSync(join(tmpdir(), "dgc-sdk-ts-work-"));
  const stateDir = mkdtempSync(join(tmpdir(), "dgc-sdk-ts-state-"));
  writeFileSync(join(work, "README.md"), "empty cart checkout\n");
  const dgc = new DGC({ stateDir, model: "sdk-model", baseUrl, apiKey: "sk-local", runtime: runtime(), department: "erp" });
  try {
    const session = await dgc.session({ cwd: work, permissions: { mode: "auto", unhandled: "deny" } });
    const result = await session.run("Summarize README. Do not edit files.", { timeoutMs: 60_000 });
    assert.equal(result.status, "completed");
    const report = dgc.usageReport("erp");
    assert.equal(report.runs, 1);
  } finally {
    await dgc.close();
    server.close();
    rmSync(work, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("policy denyTools blocks a write even if callback would allow", async () => {
  const { server, baseUrl } = await startModel("edit");
  const work = mkdtempSync(join(tmpdir(), "dgc-sdk-ts-work-"));
  const stateDir = mkdtempSync(join(tmpdir(), "dgc-sdk-ts-state-"));
  writeFileSync(join(work, "README.md"), "empty cart checkout\n");
  const dgc = new DGC({
    stateDir, model: "sdk-model", baseUrl, apiKey: "sk-local", runtime: runtime(), sandbox: "preferred",
    policy: { denyTools: ["write_file", "edit_file", "apply_patch"] },
  });
  try {
    const session = await dgc.session({
      cwd: work, permissions: { mode: "default", unhandled: "deny" },
      onPermission: () => "once",
    });
    const result = await session.run("edit the checkout guard", { timeoutMs: 60_000 });
    assert.equal(existsSync(join(work, "guard.py")), false);
    assert.ok(["completed", "failed", "cancelled"].includes(result.status));
  } finally {
    await dgc.close();
    server.close();
    rmSync(work, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("audit export records turn events", async () => {
  const { server, baseUrl } = await startModel("text");
  const work = mkdtempSync(join(tmpdir(), "dgc-sdk-ts-work-"));
  const stateDir = mkdtempSync(join(tmpdir(), "dgc-sdk-ts-state-"));
  writeFileSync(join(work, "README.md"), "empty cart checkout\n");
  const dgc = new DGC({ stateDir, model: "sdk-model", baseUrl, apiKey: "sk-local", runtime: runtime() });
  try {
    const session = await dgc.session({ cwd: work, permissions: { mode: "auto", unhandled: "deny" } });
    await session.run("Summarize README. Do not edit files.", { timeoutMs: 60_000 });
    const rows = dgc.exportAudit();
    const kinds = new Set(rows.map((row) => row.type));
    assert.ok(kinds.has("turn_start") || kinds.has("turn_end"), JSON.stringify([...kinds]));
  } finally {
    await dgc.close();
    server.close();
    rmSync(work, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("cancel during a permission wait settles cancelled", async () => {
  const { server, baseUrl } = await startModel("edit");
  const work = mkdtempSync(join(tmpdir(), "dgc-sdk-ts-work-"));
  const stateDir = mkdtempSync(join(tmpdir(), "dgc-sdk-ts-state-"));
  writeFileSync(join(work, "README.md"), "empty cart checkout\n");
  let waiting;
  const gate = new Promise((resolve) => { waiting = resolve; });
  const dgc = new DGC({ stateDir, model: "sdk-model", baseUrl, apiKey: "sk-local", runtime: runtime() });
  try {
    const session = await dgc.session({
      cwd: work, permissions: { mode: "default", unhandled: "deny" },
      decisionTimeoutMs: 30_000,
      onPermission: async () => {
        waiting();
        await new Promise((r) => setTimeout(r, 30_000));
        return "once";
      },
    });
    const handle = session.stream("edit the checkout guard", { timeoutMs: 25_000 });
    const drained = handle.result();
    await gate;
    session.cancel();
    const result = await drained;
    assert.ok(["cancelled", "failed"].includes(result.status), result.status);
    assert.equal(existsSync(join(work, "guard.py")), false);
  } finally {
    await dgc.close();
    server.close();
    rmSync(work, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("http 429 is retried then completes", async () => {
  const { server, baseUrl, state } = await startModel("flaky429");
  const work = mkdtempSync(join(tmpdir(), "dgc-sdk-ts-work-"));
  const stateDir = mkdtempSync(join(tmpdir(), "dgc-sdk-ts-state-"));
  writeFileSync(join(work, "README.md"), "empty cart checkout\n");
  const dgc = new DGC({ stateDir, model: "sdk-model", baseUrl, apiKey: "sk-local", runtime: runtime() });
  try {
    const session = await dgc.session({ cwd: work, permissions: { mode: "auto", unhandled: "deny" } });
    const result = await session.run("Summarize README. Do not edit files.", { timeoutMs: 60_000 });
    assert.equal(result.status, "completed");
    assert.ok(state.posts >= 3);
  } finally {
    await dgc.close();
    server.close();
    rmSync(work, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// ---- parity with dgc-sdk 0.5.3 (Python): policy, state, sessions, transport, usage, audit ------
// Every test below fails against the 0.5.2 TypeScript sources and passes with the fix it names.
// New symbols come through a namespace import so an old build fails test by test, not at load.

import * as SDK from "../sdk/typescript/src/index.ts";
import { spawnSync } from "node:child_process";
import {
  chmodSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync,
} from "node:fs";
import { basename, delimiter } from "node:path";
import net from "node:net";
import { mock } from "node:test";

const PY = process.env.DGC_PYTHON || join(ROOT, ".venv/bin/python");
const SRC = join(ROOT, "sdk", "typescript", "src");

function named(name) {
  return (error) => {
    assert.equal(error?.name, name, `expected ${name}, got ${error?.name}: ${error?.message}`);
    return true;
  };
}

function mode(path) {
  return statSync(path).mode & 0o777;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function usageChunk(prompt, completion) {
  return "data: " + JSON.stringify({
    id: "mock", object: "chat.completion.chunk", choices: [],
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
  }) + "\n\n";
}
function withUsage(body, prompt = 1200, completion = 300) {
  return body.replace(/data: \[DONE\]\n\n$/, "") + usageChunk(prompt, completion) + "data: [DONE]\n\n";
}
function callN(name, args, index) {
  return sse({ tool_calls: [{ index: 0, id: `call_${index}`, type: "function",
    function: { name, arguments: JSON.stringify(args) } }] })
    + sse({}, "tool_calls") + "data: [DONE]\n\n";
}

/** A mock provider with the scripted behaviours the Python session/policy suites use. */
function startScripted(behavior = "text") {
  const state = { behavior, script: [], posts: 0, pings: 0, auth: [] };
  const server = createServer((req, res) => {
    if (req.method === "GET") {
      if (req.url?.endsWith("/models")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "sdk-model" }] }));
      } else if (req.url?.endsWith("/ping")) {
        state.pings += 1;
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("pong");
      } else {
        res.writeHead(404);
        res.end();
      }
      return;
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      state.posts += 1;
      state.auth.push(req.headers.authorization || "");
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      const messages = body.messages || [];
      const toolsSeen = messages.filter((m) => m.role === "tool").length;
      let last = "";
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "tool") { last = "TOOL:" + (messages[i].content || ""); break; }
        if (messages[i].role === "user") {
          const content = messages[i].content;
          last = typeof content === "string" ? content : JSON.stringify(content);
          break;
        }
      }
      const send = (payload) => {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Content-Length": Buffer.byteLength(payload) });
        res.end(payload);
      };
      const b = state.behavior;
      const tool = last.startsWith("TOOL:");
      if (b === "script") {
        send(toolsSeen < state.script.length ? callN(state.script[toolsSeen][0], state.script[toolsSeen][1], toolsSeen)
          : answer("Finished."));
      } else if (b === "usage") {
        send(withUsage(last.includes("tool please") && !tool ? call("read_file", { path: "README.md" }) : answer("Usage reported.")));
      } else if (b === "two_steps") {
        send(toolsSeen < 2 ? call("read_file", { path: "README.md" }) : answer("both steps done"));
      } else if (b === "http404") {
        const text = JSON.stringify({ error: { message: "model 'nope' not found, try pulling it first" } });
        res.writeHead(404, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
        res.end(text);
      } else if (b === "stall") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        let open = true;
        res.on("close", () => { open = false; });
        for (let i = 0; i < 60 && open; i++) {
          res.write(": keepalive\n\n");
          await sleep(500);
        }
        if (open) res.end(answer("late"));
      } else if (b === "flow") {
        if (last.includes("STEER-MARK")) send(answer("STEERED-ANSWER"));
        else if (tool) send(answer("SECOND-ANSWER"));
        else if (last.includes("second task")) send(call("write_file", { path: "followup_wrote.txt", content: "x\n" }));
        else if (last.includes("first task")) { await sleep(1500); send(answer("FIRST-ANSWER")); }
        else if (last.includes("slow edit")) { await sleep(2000); send(call("write_file", { path: "after_break.txt", content: "x\n" })); }
        else if (last.includes("quiet please")) { await sleep(4000); send(answer("LATE-OK")); }
        else send(answer("The checkout flow creates an empty cart and then redirects."));
      } else if (b === "repair_follow") {
        if (last.includes("Return only valid JSON")) send(answer('{"ok": true}'));
        else if (tool) send(answer("FOLLOW-DONE"));
        else if (last.includes("follow task")) send(call("read_file", { path: "README.md" }));
        else { await sleep(1000); send(answer("not JSON yet")); }
      } else if (b === "bash_echo") {
        send(tool ? answer("done") : call("bash", { command: "echo hi" }));
      } else if (b === "bash_verify") {
        send(tool ? answer("verified") : call("bash", { command: "echo VERIFY-OK" }));
      } else if (b === "edit") {
        send(tool ? answer("Done.") : call("write_file", { path: "guard.py", content: "ok\n" }));
      } else if (b === "json") {
        send(answer('{"ok": true, "summary": "cart is empty"}'));
      } else {
        send(tool ? answer("Done.") : answer("The checkout flow creates an empty cart and then redirects."));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, state, port, baseUrl: `http://127.0.0.1:${port}/v1` });
    });
  });
}

/** A workspace, a private stateDir and a mock model, cleaned up after `fn`. */
async function withEnv(behavior, fn) {
  const model = await startScripted(behavior);
  const tmp = mkdtempSync(join(tmpdir(), "dgc-sdk-ts-par-"));
  const work = join(tmp, "work");
  const stateDir = join(tmp, "state");
  const outside = join(tmp, "outside");
  mkdirSync(work);
  mkdirSync(outside);
  mkdirSync(join(work, "secrets"));
  writeFileSync(join(work, "README.md"), "empty cart checkout\n");
  writeFileSync(join(work, "secrets", "key.pem"), "TOPSECRET-KEY\n");
  writeFileSync(join(outside, "notes.txt"), "OUTSIDE-NOTES\n");
  const clients = [];
  const client = (options = {}) => {
    // A policy's default sandboxed shell fails closed without a working OS sandbox. These tests
    // exercise tool/path/network enforcement, so a policy-bearing client accepts the fallback
    // unless the test says otherwise (the fail-closed path has its own tests).
    const fallback = options.policy && !("sandbox" in options) ? { sandbox: "preferred" } : {};
    const dgc = new DGC({ stateDir, model: "sdk-model", baseUrl: model.baseUrl, apiKey: "sk-local",
      runtime: runtime(), ...fallback, ...options });
    clients.push(dgc);
    return dgc;
  };
  try {
    return await fn({ ...model, tmp, work, stateDir, outside, client });
  } finally {
    for (const dgc of clients) await dgc.close();
    model.server.closeAllConnections?.();
    model.server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

const AUTO = { mode: "auto", unhandled: "deny" };

function outputs(result) {
  const found = {};
  for (const record of result.tools) (found[record.name] ||= []).push(record.output || "");
  return found;
}

async function scripted(env, script, { policy, permissions = { mode: "auto" }, tools = [], onPermission, client = {}, session = {} } = {}) {
  env.state.script = script;
  const asks = [];
  const dgc = env.client({ policy, ...client });
  const opened = await dgc.session({
    cwd: env.work, permissions, tools,
    onPermission: onPermission ? (request) => { asks.push(request.name); return onPermission(request); } : undefined,
    ...session,
  });
  const result = await opened.run("Do the scripted steps.", { timeoutMs: 90_000 });
  const sandbox = opened.sandbox;
  await dgc.close();
  return { result, asks, sandbox };
}

const BWRAP_WORKS = process.platform === "linux"
  && spawnSync("bwrap", ["--unshare-all", "--ro-bind", "/", "/", "/bin/true"], { timeout: 10_000 }).status === 0;

// A stand-in for `dgc serve`: argv[1] picks a behaviour, argv[2] the offered protocol.
const FAKE_SERVE = String.raw`
import hashlib, json, os, sys, time
mode = sys.argv[1]
# Like the real CLI, confirm the session policy the SDK sent (every isolated session sends one).
raw_policy = os.environ.get("DGC_SESSION_POLICY")
caps = {} if raw_policy is None else {"session_policy": {
    "version": 1, "digest": hashlib.sha256(raw_policy.encode()).hexdigest(), "error": "", "sandbox": ""}}
PROTOCOL = int(sys.argv[2]) if len(sys.argv) > 2 else 14
seq = 0
def emit(_type, **fields):
    global seq
    sys.stdout.write(json.dumps({"type": _type, "seq": seq, **fields}) + "\n")
    sys.stdout.flush()
    seq += 1
if mode == "exit3":
    sys.stderr.write("boom-marker: the runtime could not import its settings\n")
    sys.stderr.flush()
    sys.exit(3)
if mode == "silent":
    time.sleep(120)
    sys.exit(0)
if mode == "unknown-first":
    emit("remote_status", state="on")
emit("ready", version="9.9.9", protocol_version=PROTOCOL, capabilities=caps, model="fixture",
     mode="default", think="off", base_url="http://127.0.0.1:1/v1", workspace_trusted=False,
     commands=[], custom_commands=[], goal={"text": "", "status": "none"}, context_size=32768,
     session_id="fixture-session")
for line in sys.stdin:
    cmd = json.loads(line)
    kind, rid = cmd.get("type"), cmd.get("request_id")
    if kind == "shutdown":
        break
    if mode == "reject":
        emit("command_rejected", command=kind, reason="turn_in_progress", message="busy with a turn", request_id=rid)
    elif mode == "error-reply":
        emit("error", message="no session to resume", request_id=rid)
    elif mode == "tools" and kind == "upsert_mcp_server":
        emit("mcp_servers", items=[{"name": "app", "state": "connected", "tool_count": 1}], request_id=rid)
    elif kind == "list_sessions":
        emit("info", message="noise before the reply")
        emit("sessions", items=[], request_id=rid)
`;

// Wraps the real dgc serve and adds event types this SDK has never heard of (as a newer CLI may).
const INJECT_UNKNOWN = String.raw`
import json, subprocess, sys
child = subprocess.Popen([sys.executable, "-m", "dgc", "serve"], stdout=subprocess.PIPE)
seq = 0
def out(event):
    global seq
    event["seq"] = seq
    seq += 1
    sys.stdout.write(json.dumps(event) + "\n")
    sys.stdout.flush()
for raw in child.stdout:
    event = json.loads(raw)
    out(event)
    if event.get("type") in ("ready", "turn_start", "stream_end"):
        out({"type": "remote_status", "state": "on", "url": "https://example.invalid/x"})
sys.exit(child.wait())
`;

function fakeServe(tmp) {
  const path = join(tmp, "fake_serve.py");
  writeFileSync(path, FAKE_SERVE);
  return path;
}

/** Live processes whose command line mentions `marker`, or whose cwd is `marker` (Linux). */
function processesWith(marker) {
  if (process.platform !== "linux") return [];
  const found = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf8");
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      let cwd = "";
      try { cwd = readlinkSync(`/proc/${entry}/cwd`); } catch { /* not ours */ }
      if ((cmdline.includes(marker) || cwd === marker) && stat.split(") ")[1]?.[0] !== "Z") found.push(Number(entry));
    } catch { /* gone */ }
  }
  return found;
}

function onPath(name) {
  return (process.env.PATH || "").split(delimiter).some((dir) => dir && existsSync(join(dir, name)));
}

// ---- RuntimePolicy: enforced by the runtime per session, never saved -------------------------

test("policy: file tools stay inside cwd and off denied paths in auto mode", async () => {
  await withEnv("script", async (env) => {
    const { result, asks } = await scripted(env, [
      ["write_file", { path: join(env.outside, "owned.txt"), content: "owned\n" }],
      ["read_file", { path: join(env.outside, "notes.txt") }],
      ["read_file", { path: "secrets/key.pem" }],
      ["grep", { pattern: "TOPSECRET", path: "secrets" }],
      ["read_file", { path: "README.md" }],
      ["write_file", { path: "inside.txt", content: "inside\n" }],
    ], { policy: { denyPathPrefixes: ["secrets"] } });
    assert.equal(result.status, "completed", result.error);
    assert.equal(existsSync(join(env.outside, "owned.txt")), false, "a write escaped cwd in auto mode");
    const blob = JSON.stringify(outputs(result));
    assert.ok(!blob.includes("OUTSIDE-NOTES"), blob);
    assert.ok(!blob.includes("TOPSECRET-KEY"), blob);
    assert.ok(blob.includes("empty cart checkout"), "reads inside cwd must still work");
    assert.ok(existsSync(join(env.work, "inside.txt")), "writes inside cwd must still work");
    assert.deepEqual(asks, []);
    // The policy travelled in the session's environment; nothing was saved into the config.
    const config = JSON.parse(readFileSync(join(env.stateDir, "home", ".dgc", "config.json"), "utf8"));
    assert.ok(!JSON.stringify(config.permissions || {}).includes("secrets"), JSON.stringify(config.permissions));
  });
});

test("policy: extraReadDirs are readable but not writable", async () => {
  await withEnv("script", async (env) => {
    const { result } = await scripted(env, [
      ["read_file", { path: join(env.outside, "notes.txt") }],
      ["write_file", { path: join(env.outside, "new.txt"), content: "x\n" }],
    ], { policy: { extraReadDirs: [env.outside] } });
    assert.ok(JSON.stringify(outputs(result)).includes("OUTSIDE-NOTES"));
    assert.equal(existsSync(join(env.outside, "new.txt")), false);
  });
});

test("policy: denyTools covers custom tools (MCP routes)", async () => {
  await withEnv("script", async (env) => {
    const refunds = [];
    const lookups = [];
    const tools = [
      defineTool("issue_refund", "Refund an order", { type: "object", properties: {} }, (a) => { refunds.push(a); return "refunded"; }),
      defineTool("sku_lookup", "Look up a SKU", { type: "object", properties: {} }, (a) => { lookups.push(a); return "Widget"; }),
    ];
    const { result } = await scripted(env, [
      ["mcp__app__issue_refund", { order: "A-1" }],
      ["mcp_call", { name: "mcp__app__issue_refund", arguments: {} }],
      ["mcp__app__sku_lookup", { sku: "A-1" }],
    ], { policy: { denyTools: ["mcp__app__issue_refund"], network: "allow" }, tools });
    assert.deepEqual(refunds, [], "a denied custom tool ran");
    assert.equal(lookups.length, 1, JSON.stringify(outputs(result)));
  });
});

test("policy: allowTools refuses every other tool", async () => {
  await withEnv("script", async (env) => {
    const deleted = [];
    const lookups = [];
    const tools = [
      defineTool("delete_customer", "Delete a customer", { type: "object", properties: {} }, (a) => { deleted.push(a); return "deleted"; }),
      defineTool("sku_lookup", "Look up a SKU", { type: "object", properties: {} }, (a) => { lookups.push(a); return "Widget"; }),
    ];
    const { result } = await scripted(env, [
      ["save_memory", { text: "remember this", scope: "project" }],
      ["mcp__app__delete_customer", { id: 7 }],
      ["mcp__app__sku_lookup", { sku: "A-1" }],
      ["read_file", { path: "README.md" }],
    ], { policy: { allowTools: ["read_file", "mcp__app__sku_lookup"], network: "allow" }, tools });
    assert.deepEqual(deleted, []);
    assert.equal(lookups.length, 1);
    const found = outputs(result);
    assert.ok((found.save_memory || ["?"]).every((text) => text.includes("deny rule")), JSON.stringify(found));
    assert.ok(JSON.stringify(found.read_file).includes("empty cart checkout"));
  });
});

test("policy: unknown tool names and settings raise DGCConfigError", async () => {
  await withEnv("text", async (env) => {
    assert.throws(() => env.client({ policy: { denyTools: ["write_fle"] } }), named("DGCConfigError"));
    assert.throws(() => env.client({ policy: { allowTools: "read_file" } }), named("DGCConfigError"));
    assert.throws(() => env.client({ policy: { network: "sometimes" } }), named("DGCConfigError"));
    const tool = defineTool("issue_refund", "Refund", { type: "object" }, () => "ok");
    const dgc = env.client({ policy: { denyTools: ["mcp__app__refnd"] } });
    await assert.rejects(dgc.session({ cwd: env.work, permissions: AUTO, tools: [tool] }), named("DGCConfigError"));
    await assert.rejects(dgc.session({ cwd: env.work, permissions: { mode: "auto", unhandeld: "deny" } }), named("DGCConfigError"));
  });
});

test("policy: screened shell refuses file-writing commands in auto mode", async () => {
  await withEnv("script", async (env) => {
    writeFileSync(join(env.work, "victim.txt"), "keep\n");
    const { result } = await scripted(env, [
      ["bash", { command: "rm victim.txt" }],
      ["bash", { command: "echo pwned > escaped.txt" }],
    ], { policy: { shell: "screened", denyTools: ["write_file"] } });
    assert.ok(existsSync(join(env.work, "victim.txt")), JSON.stringify(outputs(result)));
    assert.equal(existsSync(join(env.work, "escaped.txt")), false);
  });
});

test("policy: auto-mode shell runs inside the OS sandbox", { skip: !BWRAP_WORKS && "needs a working bubblewrap" }, async () => {
  await withEnv("script", async (env) => {
    const ping = `http://127.0.0.1:${env.port}/ping`;
    const { result, sandbox } = await scripted(env, [
      ["bash", { command: `curl -sS -m 3 ${ping} || python3 -c "import urllib.request as u; u.urlopen('${ping}', timeout=3)"` }],
      ["bash", { command: `echo escaped > ${join(env.outside, "escape.txt")}` }],
      ["bash", { command: "echo inside > inside.txt" }],
    ], { policy: {} });
    assert.equal(sandbox.active, true, JSON.stringify(sandbox));
    assert.equal(sandbox.backend, "bwrap");
    assert.equal(env.state.pings, 0, "the sandboxed shell reached the network");
    assert.equal(existsSync(join(env.outside, "escape.txt")), false);
    assert.ok(existsSync(join(env.work, "inside.txt")), JSON.stringify(outputs(result)));
  });
});

test("policy: a required sandbox the runtime cannot provide refuses the session", async () => {
  await withEnv("text", async (env) => {
    if (!onPath(process.platform === "darwin" ? "sandbox-exec" : "bwrap")) {
      assert.throws(() => env.client({ sandbox: { requirement: "required" } }), named("DGCUnsupportedError"));
      return;
    }
    const dgc = env.client({ sandbox: "required", extraEnv: { PATH: "/nonexistent-dgc" } });
    await assert.rejects(dgc.session({ cwd: env.work, permissions: AUTO }), named("DGCUnsupportedError"));
    await sleep(300);
    assert.deepEqual(processesWith(realpathSync(env.work)), [], "the refused session left dgc serve running");
  });
});

test("policy: a workspace's own allow rules do not skip the callback", async () => {
  await withEnv("script", async (env) => {
    mkdirSync(join(env.work, ".dgc"));
    writeFileSync(join(env.work, ".dgc", "permissions.json"), JSON.stringify({
      allow: ["Bash(*)", "Python(*)", "Monitor(*)"], deny: [],
    }));
    const { asks } = await scripted(env, [
      ["bash", { command: "cat secrets/key.pem > leaked.txt" }],
    ], { policy: {}, permissions: { mode: "default" }, onPermission: () => "deny" });
    assert.ok(asks.includes("bash"), JSON.stringify(asks));
    assert.equal(existsSync(join(env.work, "leaked.txt")), false);
  });
});

test("policy: inheritUserState never writes the policy into the user's config", async () => {
  await withEnv("script", async (env) => {
    const hostHome = join(env.tmp, "host-home");
    mkdirSync(join(hostHome, ".dgc"), { recursive: true });
    const config = join(hostHome, ".dgc", "config.json");
    writeFileSync(config, JSON.stringify({ model: "sdk-model", base_url: env.baseUrl }) + "\n");
    const before = readFileSync(config);
    env.state.script = [["write_file", { path: "guard.py", content: "x\n" }]];
    const dgc = new DGC({
      stateDir: env.stateDir, inheritUserState: true, apiKey: "sk-local", runtime: runtime(), sandbox: "preferred",
      extraEnv: { HOME: hostHome }, policy: { denyTools: ["write_file"], network: "deny" },
    });
    try {
      const session = await dgc.session({ cwd: env.work, permissions: { mode: "default" }, onPermission: () => "once" });
      await session.run("Do the scripted steps.", { timeoutMs: 90_000 });
    } finally {
      await dgc.close();
    }
    assert.equal(existsSync(join(env.work, "guard.py")), false, "the policy must still apply");
    assert.deepEqual(readFileSync(config), before, "the user's config.json changed");
  });
});

test("policy: compiles to the same session policy as the Python SDK", async (t) => {
  const probe = spawnSync(PY, ["-c", "import dgc_sdk"], { env: { ...process.env, PYTHONPATH: join(ROOT, "sdk", "python") } });
  if (probe.status !== 0) {
    t.skip("no Python that can import sdk/python");
    return;
  }
  const { Policy, compileSession } = await import(join(SRC, "policy.ts"));
  const tmp = mkdtempSync(join(tmpdir(), "dgc-sdk-ts-cmp-"));
  try {
    mkdirSync(join(tmp, "secrets"));
    const cases = [
      [{}, "auto", "off", [], false, true],
      [{ network: "allow", denyTools: ["write_file", "mcp__app__refund"], denyPathPrefixes: ["secrets", "/etc"] }, "auto", "off", ["refund"], false, true],
      [{ allowTools: ["read_file", "grep", "mcp__app__a*"], extraReadDirs: ["/usr/share"], shell: "screened" }, "default", "preferred", ["a1"], true, true],
      [{ denyPathPrefixes: [join(tmp, "secrets")], shell: "screened", denyTools: ["Write", "WebFetch"] }, "plan", "required", [], false, false],
      [{ shell: "screened", network: "deny", denyTools: ["apply_patch"] }, "auto", "off", [], false, true],
      [null, "default", "off", [], false, true],
      [null, "default", "off", [], true, true],
      [null, "auto", "preferred", [], false, false],
    ];
    for (const [policy, mode, sandbox, tools, trustWorkspace, isolated] of cases) {
      const plan = compileSession(policy === null ? null : new Policy(policy),
        { cwd: tmp, mode, sandbox, tools, trustWorkspace, isolated });
      const ts = plan.env.DGC_SESSION_POLICY;
      const py = spawnSync(PY, ["-c", `
import json, sys
from pathlib import Path
from dgc_sdk.policy import RuntimePolicy, compile_session
spec = json.loads(sys.argv[1])
names = {"denyTools": "deny_tools", "allowTools": "allow_tools", "extraReadDirs": "extra_read_dirs",
         "denyPathPrefixes": "deny_path_prefixes", "network": "network", "shell": "shell"}
policy = None if spec["policy"] is None else RuntimePolicy(
    **{names[k]: (tuple(v) if isinstance(v, list) else v) for k, v in spec["policy"].items()})
plan = compile_session(policy, cwd=Path(spec["cwd"]), mode=spec["mode"], on_permission=None,
                       sandbox=spec["sandbox"], tools=spec["tools"],
                       trust_workspace=spec["trust"], isolated=spec["isolated"])
print(json.dumps({"env": plan.env.get("DGC_SESSION_POLICY"), "strict": plan.strict_shell}))
`, JSON.stringify({ policy, cwd: tmp, mode, sandbox, tools, trust: trustWorkspace, isolated })],
      { encoding: "utf8", env: { ...process.env, PYTHONPATH: join(ROOT, "sdk", "python") } });
      assert.equal(py.status, 0, py.stderr);
      const expected = JSON.parse(py.stdout.trim());
      if (expected.env === null) assert.equal(ts, undefined, JSON.stringify(policy));
      else assert.deepEqual(JSON.parse(ts), JSON.parse(expected.env), JSON.stringify(policy));
      assert.equal(Boolean(plan.strictShell), expected.strict, `strict shell for ${JSON.stringify(policy)} ${mode}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---- private state; nothing a previous session left is merged or run ---------------------------

test("state: a planted config.json in stateDir is ignored and the state is private", async () => {
  await withEnv("text", async (env) => {
    const marker = join(env.work, "planted-gate-ran");
    const verifier = join(env.work, "planted-verifier-ran");
    const folder = join(env.stateDir, "home", ".dgc");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "config.json"), JSON.stringify({
      autonomous_gate: `touch ${marker}`, verify_command: `touch ${verifier}`, verify_before_done: true,
      model: "planted-model", base_url: "http://127.0.0.1:9/v1",
    }));
    chmodSync(env.stateDir, 0o755);
    const dgc = env.client();
    const session = await dgc.session({ cwd: env.work, permissions: AUTO });
    const result = await session.run("Summarize README. Do not edit files.", { timeoutMs: 60_000 });
    const config = JSON.parse(readFileSync(join(folder, "config.json"), "utf8"));
    assert.equal(result.status, "completed", result.error);
    assert.equal(existsSync(marker), false, "a planted autonomous_gate must not run");
    assert.equal(existsSync(verifier), false, "a planted verify_command must not run");
    assert.equal(config.autonomous_gate, undefined);
    assert.equal(config.model, "sdk-model");
    assert.equal(mode(env.stateDir), 0o700);
    assert.equal(mode(join(folder, "config.json")), 0o600);
  });
});

test("state: a writable stateDir is refused and the default one is private", async () => {
  await withEnv("text", async (env) => {
    mkdirSync(env.stateDir);
    chmodSync(env.stateDir, 0o777);
    assert.throws(() => env.client(), named("DGCConfigError"));
    const dgc = new DGC({ model: "sdk-model", baseUrl: env.baseUrl, runtime: runtime() });
    try {
      assert.ok(dgc.stateDir && statSync(dgc.stateDir).isDirectory());
      assert.equal(mode(dgc.stateDir), 0o700);
    } finally {
      await dgc.close();
      if (dgc.stateDir) rmSync(dgc.stateDir, { recursive: true, force: true });
    }
  });
});

// ---- per-run and per-session options stay scoped -----------------------------------------------

test("options: session options do not leak into the next session", async () => {
  await withEnv("text", async (env) => {
    const other = join(env.tmp, "work-b");
    mkdirSync(other);
    const dgc = env.client();
    const first = await dgc.session({
      cwd: env.work, permissions: AUTO, verifyCommand: "echo first-verify", maxTurns: 5, model: "first-model",
    });
    const seen = JSON.parse(readFileSync(join(env.stateDir, "home", ".dgc", "config.json"), "utf8"));
    assert.equal(seen.verify_command, "echo first-verify");
    assert.equal(seen.max_turns, 5);
    assert.equal((await first.getConfig()).model, "first-model");
    await first.close();
    const second = await dgc.session({ cwd: other, permissions: AUTO });
    const config = JSON.parse(readFileSync(join(env.stateDir, "home", ".dgc", "config.json"), "utf8"));
    assert.equal((await second.getConfig()).model, "sdk-model");
    for (const key of ["verify_command", "verify_before_done", "max_turns"]) {
      assert.equal(config[key], undefined, `${key} leaked into the next session`);
    }
    assert.deepEqual(config.trusted_dirs, [realpathSync(other)]);
  });
});

test("options: a run's maxTurns and an outputSchema repair do not cap later runs", async () => {
  await withEnv("two_steps", async (env) => {
    const dgc = env.client();
    const session = await dgc.session({ cwd: env.work, permissions: AUTO });
    const capped = await session.run("Read the README twice.", { timeoutMs: 60_000, maxTurns: 1 });
    const free = await session.run("Read the README twice.", { timeoutMs: 60_000 });
    assert.equal(capped.status, "failed");
    assert.ok(capped.error, "a stopped run must say why");
    assert.equal(free.status, "completed", free.error);
    env.state.behavior = "json";
    const schema = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } };
    const shaped = await session.run("Summarize README as JSON.", { timeoutMs: 60_000, outputSchema: schema });
    assert.equal(shaped.output.ok, true);
    const config = JSON.parse(readFileSync(join(env.stateDir, "home", ".dgc", "config.json"), "utf8"));
    assert.ok([0, undefined].includes(config.max_turns), `max_turns stayed ${config.max_turns}`);
    env.state.behavior = "two_steps";
    const later = await (await dgc.session({ cwd: env.work, permissions: AUTO })).run("Read the README twice.", { timeoutMs: 60_000 });
    assert.equal(later.status, "completed", later.error);
    assert.match(later.finalText, /both steps done/);
  });
});

// ---- identity -----------------------------------------------------------------------------------

test("identity: a new session keeps its own id and binds only its own transcript", async () => {
  await withEnv("text", async (env) => {
    const dgc = env.client();
    const first = await dgc.session({ cwd: env.work, permissions: AUTO });
    await first.run("Summarize README alpha. Do not edit files.", { timeoutMs: 60_000 });
    assert.ok(first.sessionPath.endsWith(`${first.sessionId}.json`), first.sessionPath);
    const second = await dgc.session({ cwd: env.work, permissions: AUTO });
    const own = second.sessionId;
    assert.ok(own && own !== first.sessionId);
    assert.equal(second.sessionPath, "", "no transcript of its own exists yet");
    const result = await second.run("Summarize README beta. Do not edit files.", { timeoutMs: 60_000 });
    assert.equal(result.sessionId, own);
    assert.ok(second.sessionPath.endsWith(`${own}.json`), second.sessionPath);
    const mine = new Set(dgc.exportAudit(own).map((row) => row.run_id));
    const theirs = new Set(dgc.exportAudit(first.sessionId).map((row) => row.run_id));
    assert.ok(mine.has(result.runId));
    assert.ok(!theirs.has(result.runId));
  });
});

// ---- usage: real provider tokens; unknown stays unknown ------------------------------------------

test("usage: provider tokens and cost are counted per run", async () => {
  await withEnv("usage", async (env) => {
    const dgc = env.client({ pricing: { inputPerMillion: 1, outputPerMillion: 10 }, department: "erp" });
    const session = await dgc.session({ cwd: env.work, permissions: AUTO });
    const first = await session.run("tool please: read the README", { timeoutMs: 60_000 });
    const second = await session.run("Summarize README. Do not edit files.", { timeoutMs: 60_000 });
    const report = dgc.usageReport("erp");
    assert.equal(first.status, "completed", first.error);
    assert.deepEqual([first.usage.input_tokens, first.usage.output_tokens], [2400, 600]);
    assert.equal(first.usage.requests, 2);
    assert.ok(Math.abs(first.usage.cost_usd - 0.0084) < 1e-9, String(first.usage.cost_usd));
    assert.ok("token_estimate" in first.usage);
    assert.deepEqual([second.usage.input_tokens, second.usage.output_tokens], [1200, 300]);
    assert.deepEqual([report.inputTokens, report.outputTokens], [3600, 900]);
    assert.ok(Math.abs(report.costUsd - 0.0126) < 1e-9);
    assert.equal(report.unknownUsageRuns, 0);
  });
});

test("usage: unreported usage is unknown, not zero", async () => {
  await withEnv("text", async (env) => {
    const dgc = env.client({ pricing: { inputPerMillion: 1, outputPerMillion: 10 } });
    const result = await (await dgc.session({ cwd: env.work, permissions: AUTO }))
      .run("Summarize README. Do not edit files.", { timeoutMs: 60_000 });
    const report = dgc.usageReport();
    assert.equal(result.usage.input_tokens, null);
    assert.equal(result.usage.output_tokens, null);
    assert.equal(result.usage.cost_usd, null);
    assert.ok(result.usage.requests >= 1);
    assert.equal(report.unknownUsageRuns, 1);
    assert.equal(report.costUsd, null);
  });
});

// ---- errors: surfaced, typed, fast --------------------------------------------------------------

test("errors: a failed run reports the backend's error", async () => {
  await withEnv("http404", async (env) => {
    const result = await (await env.client().session({ cwd: env.work, permissions: AUTO }))
      .run("Summarize README.", { timeoutMs: 60_000 });
    assert.equal(result.status, "failed");
    assert.match(result.error || "", /not found/);
  });
});

test("errors: unknown event types are skipped, not fatal or reported", async () => {
  await withEnv("text", async (env) => {
    const wrapper = join(env.tmp, "inject_unknown.py");
    writeFileSync(wrapper, INJECT_UNKNOWN);
    const dgc = env.client({ runtime: [PY, wrapper] });
    const session = await dgc.session({ cwd: env.work, permissions: AUTO });
    const handle = session.stream("Summarize README. Do not edit files.", { timeoutMs: 60_000 });
    const kinds = [];
    for await (const event of handle) kinds.push(event.type);
    const result = await handle.result();
    assert.equal(result.status, "completed", result.error);
    assert.match(result.finalText.toLowerCase(), /checkout/);
    assert.ok(!kinds.includes("remote_status"));
    assert.ok((session.transport.ignoredEventTypes?.remote_status || 0) >= 2);
  });
});

test("errors: protocol problems are DGCProtocolError and leave no child", async () => {
  await withEnv("text", async (env) => {
    const fake = fakeServe(env.tmp);
    for (const [offered, advice] of [[13, "dgc update"], [15, "Upgrade the SDK"]]) {
      const dgc = env.client({ runtime: [PY, fake, "ok", String(offered)] });
      await assert.rejects(dgc.session({ cwd: env.work }), (error) => {
        named("DGCProtocolError")(error);
        assert.match(error.message, new RegExp(`protocol v${offered}`));
        assert.match(error.message, /9\.9\.9/);
        assert.ok(error.message.includes(advice), error.message);
        return true;
      });
    }
    await assert.rejects(env.client({ runtime: [PY, fake, "unknown-first"] }).session({ cwd: env.work }),
      named("DGCProtocolError"));
    await sleep(300);
    assert.deepEqual(processesWith(fake), []);
  });
});

test("errors: a runtime that fails or never becomes ready is an SDK error and is reaped", async () => {
  await withEnv("text", async (env) => {
    const fake = fakeServe(env.tmp);
    await assert.rejects(env.client({ runtime: [PY, fake, "exit3"] }).session({ cwd: env.work }), (error) => {
      named("DGCRuntimeError")(error);
      assert.match(error.message, /boom-marker/);
      return true;
    });
    const started = Date.now();
    await assert.rejects(env.client({ runtime: [PY, fake, "silent"], startTimeoutMs: 1500 }).session({ cwd: env.work }),
      named("DGCRuntimeError"));
    assert.ok(Date.now() - started < 10_000);
    await sleep(300);
    assert.deepEqual(processesWith(fake), [], "a failed start left dgc serve running");
    await assert.rejects(env.client({ runtime: [join(env.tmp, "no-such-runtime")] }).session({ cwd: env.work }),
      named("DGCRuntimeError"));
  });
});

test("errors: a refused command fails at once with its reason; resume failures are fast", async () => {
  await withEnv("text", async (env) => {
    const fake = fakeServe(env.tmp);
    const session = await env.client({ runtime: [PY, fake, "reject"] }).session({ cwd: env.work });
    let started = Date.now();
    await assert.rejects(session.listSessions(), (error) => {
      named("DGCCommandRejectedError")(error);
      assert.equal(error.reason, "turn_in_progress");
      assert.equal(error.command, "list_sessions");
      assert.match(error.message, /busy with a turn/);
      return true;
    });
    assert.ok(Date.now() - started < 3000);
    const dgc = env.client();
    for (const target of [{ latest: true }, { sessionId: "/etc/nothing.json" }]) {
      started = Date.now();
      await assert.rejects(dgc.resume({ cwd: env.work, permissions: AUTO, ...target }), named("DGCConfigError"));
      assert.ok(Date.now() - started < 8000, JSON.stringify(target));
    }
  });
});

test("errors: control requests during a streaming run keep their replies", async () => {
  await withEnv("stall", async (env) => {
    const session = await env.client().session({ cwd: env.work, permissions: AUTO });
    const handle = session.stream("Summarize README.", { timeoutMs: 60_000 });
    const kinds = [];
    const reader = (async () => { for await (const event of handle) kinds.push(event.type); })();
    const failures = [];
    const started = Date.now();
    for (let i = 0; i < 12; i++) {
      try {
        await Promise.race([session.listPermissions(), sleep(5000).then(() => { throw new Error("no reply in 5 s"); })]);
      } catch (error) {
        failures.push(String(error));
      }
    }
    const elapsed = Date.now() - started;
    handle.cancel();
    await reader;
    const result = await handle.result();
    assert.deepEqual(failures, []);
    assert.ok(elapsed < 10_000);
    assert.ok(!kinds.includes("permissions"), "control replies leaked into the run stream");
    assert.equal(result.status, "cancelled");
  });
});

// ---- timeouts and cancellation ------------------------------------------------------------------

test("timeouts: a run timeout is a timeout, and the session is reusable", async () => {
  await withEnv("stall", async (env) => {
    const session = await env.client().session({ cwd: env.work, permissions: AUTO });
    const started = Date.now();
    const result = await session.run("Summarize README.", { timeoutMs: 2000 });
    assert.ok(Date.now() - started < 15_000);
    assert.deepEqual([result.status, result.reason], ["failed", "timeout"]);
    assert.match(result.error || "", /2000 ms timeout/);
    env.state.behavior = "text";
    const again = await session.run("Summarize README. Do not edit files.", { timeoutMs: 60_000 });
    assert.equal(again.status, "completed", again.error);
  });
});

test("timeouts: null means no limit and long limits work; invalid ones fail before sending", async () => {
  await withEnv("flow", async (env) => {
    const session = await env.client().session({ cwd: env.work, permissions: AUTO });
    const quiet = await session.run("quiet please", { timeoutMs: null });
    assert.equal(quiet.status, "completed", quiet.error);
    assert.match(quiet.finalText, /LATE-OK/);
    // Past Node's 2^31 ms timer limit a plain setTimeout fires at once.
    const huge = await session.run("Summarize README. Do not edit files.", { timeoutMs: 1e12 });
    assert.equal(huge.status, "completed", huge.error);
    const posts = env.state.posts;
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, "60", true]) {
      assert.throws(() => session.stream("Summarize README.", { timeoutMs: bad }), named("DGCConfigError"));
    }
    assert.equal(env.state.posts, posts);
  });
});

test("cancel: an AbortSignal cancels the run", async () => {
  await withEnv("stall", async (env) => {
    const session = await env.client().session({ cwd: env.work, permissions: AUTO });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 1000);
    const started = Date.now();
    const result = await session.run("Summarize README.", { timeoutMs: 60_000, signal: controller.signal });
    assert.equal(result.status, "cancelled");
    assert.ok(Date.now() - started < 15_000);
    const early = new AbortController();
    early.abort();
    const posts = env.state.posts;
    const skipped = await session.run("Summarize README.", { signal: early.signal });
    assert.equal(skipped.status, "cancelled");
    assert.equal(env.state.posts, posts, "an aborted signal must not send the prompt");
    env.state.behavior = "text";
    const again = await session.run("Summarize README. Do not edit files.", { timeoutMs: 60_000 });
    assert.equal(again.status, "completed", again.error);
  });
});

test("cancel: leaving the stream early cancels the run and frees the session", async () => {
  await withEnv("flow", async (env) => {
    const session = await env.client().session({ cwd: env.work, permissions: AUTO });
    const handle = session.stream("slow edit please", { timeoutMs: 30_000 });
    let first;
    for await (const event of handle) {
      first = event;
      break;
    }
    assert.ok(first && first.type !== "ready");
    assert.equal((await handle.result()).status, "cancelled");
    await sleep(3000);
    const again = await session.run("Summarize README. Do not edit files.", { timeoutMs: 60_000 });
    assert.equal(existsSync(join(env.work, "after_break.txt")), false, "the agent kept going after the caller left");
    assert.equal(again.status, "completed", again.error);
  });
});

// ---- follow-ups and steering are observed runs ---------------------------------------------------

test("followup: returns an observed, audited, billed run; steer needs an active run", async () => {
  await withEnv("flow", async (env) => {
    const dgc = env.client();
    const session = await dgc.session({ cwd: env.work, permissions: AUTO });
    assert.throws(() => session.steer("do this instead"), named("DGCConfigError"));
    const handle = session.stream("first task", { timeoutMs: 60_000 });
    const follow = session.followup("second task", { timeoutMs: 60_000 });
    const first = await handle.result();
    const second = await follow.result();
    assert.equal(first.status, "completed", first.error);
    assert.match(first.finalText, /FIRST-ANSWER/);
    assert.ok(!first.finalText.includes("SECOND-ANSWER"));
    assert.equal(second.status, "completed", second.error);
    assert.match(second.finalText, /SECOND-ANSWER/);
    assert.ok(second.changes.map((change) => change.path).includes("followup_wrote.txt"));
    const rows = dgc.exportAudit(session.sessionId);
    assert.ok(rows.some((row) => row.run_id === second.runId && row.type === "tool_call" && row.payload?.name === "write_file"));
    assert.ok(dgc.usageReport().rows.some((row) => row.run_id === second.runId));
  });
});

test("steer: the steered turn is part of the run (regression guard: 0.5.2 already did this)", async () => {
  await withEnv("flow", async (env) => {
    const session = await env.client().session({ cwd: env.work, permissions: AUTO });
    const handle = session.stream("first task", { timeoutMs: 60_000 });
    await sleep(400);
    session.steer("STEER-MARK: answer differently");
    const result = await handle.result();
    const after = await session.run("Summarize README. Do not edit files.", { timeoutMs: 60_000 });
    assert.equal(result.status, "completed", result.error);
    assert.match(result.finalText, /STEERED-ANSWER/);
    assert.ok(!after.finalText.includes("STEERED-ANSWER"));
  });
});

// ---- result.changes and verification ------------------------------------------------------------

test("changes: dot-dirs, home/, locks/ and lockfiles are reported with git-applyable diffs", async () => {
  const { snapshotWorkspace, diffWorkspace } = await import(join(SRC, "changes.ts"));
  const root = mkdtempSync(join(tmpdir(), "dgc-sdk-ts-changes-"));
  const original = mkdtempSync(join(tmpdir(), "dgc-sdk-ts-orig-"));
  try {
    const state = join(root, ".sdk-state");
    const files = {
      "src/home/page.tsx": "export default 1;\n", ".github/workflows/ci.yml": "on: push\n",
      "app/locks/mutex.py": "LOCK = 1\n", "poetry.lock": "[[package]]\n", "gone.txt": "bye\n", "noeol.txt": "a\nb",
      "long.txt": Array.from({ length: 40 }, (_, i) => `line ${i}\n`).join(""),
    };
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    mkdirSync(state);
    spawnSync("cp", ["-a", `${root}/.`, original]);
    const before = snapshotWorkspace(root, [state]);
    await sleep(20);
    writeFileSync(join(root, "src/home/page.tsx"), "export default 2;\n");
    writeFileSync(join(root, ".github/workflows/ci.yml"), "on: [push, pull_request]\n");
    writeFileSync(join(root, "app/locks/mutex.py"), "LOCK = 2\n");
    writeFileSync(join(root, "poetry.lock"), "[[package]]\nname = 'x'\n");
    rmSync(join(root, "gone.txt"));
    writeFileSync(join(root, "noeol.txt"), "a\nc");
    writeFileSync(join(root, "long.txt"), Array.from({ length: 40 }, (_, i) => (i === 3 || i === 30 ? `LINE ${i}\n` : `line ${i}\n`)).join("") + "tail\n");
    mkdirSync(join(root, "new dir"));
    writeFileSync(join(root, "new dir", "added.txt"), "hello\n");
    writeFileSync(join(state, "noise.json"), "{}");
    const changes = Object.fromEntries(diffWorkspace(root, before, [state]).map((change) => [change.path, change]));
    assert.deepEqual(new Set(Object.keys(changes)), new Set([
      "src/home/page.tsx", ".github/workflows/ci.yml", "app/locks/mutex.py", "poetry.lock", "gone.txt",
      "noeol.txt", "long.txt", "new dir/added.txt"]));
    assert.equal(changes["gone.txt"].kind, "deleted");
    assert.equal(changes["gone.txt"].before, "bye\n");
    assert.equal(changes["src/home/page.tsx"].before, "export default 1;\n");
    assert.equal(changes["new dir/added.txt"].kind, "added");
    const patch = Object.values(changes).map((change) => change.diff).join("");
    writeFileSync(join(original, "run.patch"), patch);
    spawnSync("git", ["init", "-q"], { cwd: original });
    const check = spawnSync("git", ["apply", "--check", "run.patch"], { cwd: original, encoding: "utf8" });
    assert.equal(check.status, 0, check.stderr + patch);
    assert.equal(spawnSync("git", ["apply", "run.patch"], { cwd: original }).status, 0);
    for (const rel of ["noeol.txt", "long.txt", "new dir/added.txt", "src/home/page.tsx"]) {
      assert.equal(readFileSync(join(original, rel), "utf8"), readFileSync(join(root, rel), "utf8"), rel);
    }
    assert.equal(existsSync(join(original, "gone.txt")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(original, { recursive: true, force: true });
  }
});

test("changes and verification: a run reports its edits and only the configured verifier", async () => {
  await withEnv("edit", async (env) => {
    const dgc = env.client();
    const result = await (await dgc.session({ cwd: env.work, permissions: AUTO })).run("edit the checkout guard", { timeoutMs: 60_000 });
    const change = (result.changes || []).find((item) => item.path === "guard.py");
    assert.ok(change, JSON.stringify(result.changes));
    assert.equal(change.kind, "added");
    assert.match(change.diff, /\+ok/);
    assert.match(change.diff, /new file mode/);
    env.state.behavior = "bash_echo";
    const command = "echo VERIFIER-RAN; exit 3";
    const unrelated = await (await dgc.session({ cwd: env.work, permissions: AUTO, verifyCommand: command }))
      .run("run something", { timeoutMs: 90_000 });
    assert.ok(unrelated.verification, "a configured verifyCommand must be reported");
    assert.equal(unrelated.verification.command, command);
    assert.notEqual(unrelated.verification.ok, true);
    assert.ok(!(unrelated.verification.output || "").includes("hi"));
    env.state.behavior = "bash_verify";
    const exact = await (await dgc.session({ cwd: env.work, permissions: AUTO, verifyCommand: "echo VERIFY-OK" }))
      .run("verify", { timeoutMs: 90_000 });
    assert.equal(exact.verification.ok, true);
    assert.equal(exact.verification.exitCode, 0);
    assert.match(exact.verification.output, /VERIFY-OK/);
  });
});

// ---- audit and usage files -----------------------------------------------------------------------

test("audit: redaction covers modern secret formats", () => {
  assert.equal(typeof SDK.redact, "function", "redact is not exported");
  const secrets = {
    anthropic: "sk-ant-api03-" + "A1b2C3d4E5f6G7h8I9j0".repeat(2),
    openai: "sk-proj-" + "Zy9Xw8Vu7Ts6Rq5Po4Nm3".repeat(2),
    github: "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8",
    oauth: "gho_" + "Q1w2E3r4T5y6U7i8O9p0A1s2D3f4G5h6J7k8",
    aws: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  };
  const texts = [
    `key=${secrets.anthropic}`, `OPENAI_API_KEY=${secrets.openai}`,
    JSON.stringify({ api_key: "plain-json-secret-value-123" }), `token: ${secrets.github}`,
    `oauth_token: ${secrets.oauth}`, `aws_secret_access_key = ${secrets.aws}`,
    "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAA\n-----END OPENSSH PRIVATE KEY-----",
  ];
  const blob = JSON.stringify(SDK.redact({ output: texts.join("\n"), args: { password: "hunter2hunter2" } }));
  for (const value of [...Object.values(secrets), "plain-json-secret-value-123", "b3BlbnNzaC1rZXktdjEAAAA", "hunter2hunter2"]) {
    assert.ok(!blob.includes(value), value);
  }
  assert.match(SDK.redactText("Authorization: Bearer sk-abc123456789"), /\[redacted\]/);
  assert.deepEqual(SDK.redact({ max_tokens: 4096, token_estimate: 12 }), { max_tokens: 4096, token_estimate: 12 });
  for (const line of ["API_KEY=zq8Lx9Vb7Nm5", "api_key: zq8Lx9Vb7Nm5", "TOKEN=zq8Lx9Vb7Nm5", "password=zq8Lx9Vb7Nm5"]) {
    assert.ok(!SDK.redactText(line).includes("zq8Lx9Vb7Nm5"), line);
  }
  for (const code of ["api_key = config.get('api_key')", 'token = os.environ["TOKEN"]']) {
    assert.equal(SDK.redactText(code), code);
  }
});

test("audit: audit and usage files are owner-only; audit rows are redacted", async () => {
  await withEnv("text", async (env) => {
    const dgc = env.client({ pricing: { inputPerMillion: 1, outputPerMillion: 1 } });
    await (await dgc.session({ cwd: env.work, permissions: AUTO })).run("Summarize README. Do not edit files.", { timeoutMs: 60_000 });
    for (const folder of ["audit", "usage", "home"]) assert.equal(mode(join(env.stateDir, folder)), 0o700, folder);
    const files = readdirSync(join(env.stateDir, "audit")).map((name) => join(env.stateDir, "audit", name));
    files.push(join(env.stateDir, "usage", "usage.jsonl"));
    assert.ok(files.length >= 2);
    for (const path of files) assert.equal(mode(path), 0o600, path);
  });
});

// ---- decisions ----------------------------------------------------------------------------------

function bareSession(options) {
  const sent = [];
  const transport = { send: (command) => sent.push(command), closed: false };
  const session = new SDK.Session(transport, { session_id: "s-test" }, {
    options, unhandled: "deny", instructions: "", toolHub: null, cwd: null, policy: null, department: "",
    usageLog: null, auditLog: null, model: "", permissionMode: "default", isolated: true, verifyCommand: "",
    stateLock: null, excludePaths: [], requestTimeoutMs: 15_000,
    sandbox: { requirement: "off", active: false, backend: "", reason: "" },
  });
  return { session, sent };
}

async function newRun() {
  const { Run } = await import(join(SRC, "session.ts"));
  return new Run({ sessionId: "s", runId: "r", status: "running", reason: "", finalText: "", usage: {},
    tools: [], artifacts: [], documents: [] }, "req");
}

test("decisions: decisionTimeoutMs null has no limit", async () => {
  const slow = () => new Promise((resolve) => setTimeout(() => resolve("once"), 40_000));
  const { session } = bareSession({ onPermission: slow, decisionTimeoutMs: null });
  const run = await newRun();
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const pending = session.decide(run, slow, { id: "p1", name: "bash", args: {} }, "deny", "onPermission",
      (value) => ["once", "always", "deny"].includes(value), true);
    await Promise.resolve();
    mock.timers.tick(31_000);            // a hidden 30 s cap would answer "deny" here
    await Promise.resolve();
    mock.timers.tick(10_000);
    assert.equal(await pending, "once");
  } finally {
    mock.timers.reset();
  }
});

test("decisions: onMcpInput honours decisionTimeoutMs", async () => {
  const slow = () => new Promise((resolve) => setTimeout(() => resolve({ action: "accept", content: { x: 1 } }), 2000));
  const { session, sent } = bareSession({ onMcpInput: slow, decisionTimeoutMs: 200 });
  const run = await newRun();
  const started = Date.now();
  await session.answerMcp(run, { id: "m1", server: "s", kind: "elicitation", payload: {} }, true);
  assert.ok(Date.now() - started < 1500);
  assert.equal(sent.at(-1).action, "cancel");
});

test("decisions: unhandled 'callback' requires the callback and stops the run when it fails", async () => {
  await withEnv("edit", async (env) => {
    const dgc = env.client();
    await assert.rejects(dgc.session({ cwd: env.work, permissions: { mode: "default", unhandled: "callback" } }),
      named("DGCConfigError"));
    const session = await dgc.session({
      cwd: env.work, permissions: { mode: "default", unhandled: "callback" },
      onPermission: () => { throw new Error("approval service down"); },
    });
    const result = await session.run("edit the checkout guard", { timeoutMs: 60_000 });
    assert.equal(existsSync(join(env.work, "guard.py")), false);
    assert.deepEqual([result.status, result.reason], ["failed", "decision_failed"]);
    assert.match(result.error || "", /approval service down/);
  });
});

// ---- custom-tool socket: private, random, authenticated -------------------------------------------

test("tools: the socket is private, random, authenticated and removed", async () => {
  await withEnv("text", async (env) => {
    const tool = defineTool("sku_lookup", "Look up", { type: "object" }, () => "ok");
    const dgc = env.client();
    const session = await dgc.session({ cwd: env.work, permissions: AUTO, tools: [tool] });
    const listed = await session.listMcpServers();
    const hub = session.init?.toolHub;
    assert.ok(hub?.socketPath, "no tool hub");
    const path = hub.socketPath;
    assert.equal(mode(join(path, "..")), 0o700);
    assert.ok(!path.startsWith(env.stateDir));
    assert.notEqual(basename(path), "tools.sock", "the socket name must be random");
    assert.equal(mode(path), 0o600);
    assert.ok(listed.some((item) => item.name === "app" && item.state === "connected"), JSON.stringify(listed));
    // Without the session's secret (or with the wrong one) nothing is served.
    for (const hello of ['{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n',
      JSON.stringify({ dgc_sdk_bridge: 1, token: "guess" }) + '\n{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n']) {
      const reply = await new Promise((resolve) => {
        const sock = net.createConnection(path);
        let data = "";
        sock.on("data", (chunk) => { data += chunk; });
        sock.on("close", () => resolve(data));
        sock.on("error", () => resolve(data));
        sock.on("connect", () => sock.write(hello));
        setTimeout(() => { sock.destroy(); resolve(data); }, 2000);
      });
      assert.equal(reply, "", "an unauthenticated peer got an answer");
    }
    assert.ok(hub.rejected >= 2);
    await session.close();
    assert.equal(existsSync(path), false);
    assert.equal(existsSync(join(path, "..")), false);
  });
});

test("tools: a tool server that never authenticates fails the session and reaps it", async () => {
  await withEnv("text", async (env) => {
    const fake = fakeServe(env.tmp);
    const tool = defineTool("sku_lookup", "Look up", { type: "object" }, () => "ok");
    await assert.rejects(env.client({ runtime: [PY, fake, "tools"] }).session({ cwd: env.work, tools: [tool] }),
      (error) => {
        named("DGCRuntimeError")(error);
        assert.match(error.message, /custom tools failed to start/);
        return true;
      });
    await sleep(300);
    assert.deepEqual(processesWith(fake), []);
  });
});

// ---- runtime --------------------------------------------------------------------------------------

test("runtime: a dgc package in the workspace does not replace the runtime", async (t) => {
  const { supportsSafePath } = await import(join(SRC, "runtime.ts")).catch(() => ({}));
  if (supportsSafePath && !supportsSafePath(PY)) {
    t.skip("the runtime's Python has no -P (older than 3.11)");
    return;
  }
  await withEnv("text", async (env) => {
    mkdirSync(join(env.work, "dgc"));
    writeFileSync(join(env.work, "dgc", "__init__.py"), "raise SystemExit('workspace dgc was imported')\n");
    writeFileSync(join(env.work, "dgc", "__main__.py"), "raise SystemExit('workspace dgc was imported')\n");
    const previous = process.env.DGC_PYTHON;
    process.env.DGC_PYTHON = PY;
    try {
      const dgc = env.client({ runtime: undefined });
      const result = await (await dgc.session({ cwd: env.work, permissions: AUTO })).run("Summarize README. Do not edit files.", { timeoutMs: 60_000 });
      assert.equal(result.status, "completed", result.error);
    } finally {
      if (previous === undefined) delete process.env.DGC_PYTHON;
      else process.env.DGC_PYTHON = previous;
    }
  });
});

test("tables: known event types and tool names match the runtime's", async (t) => {
  const probe = spawnSync(PY, ["-c", `
import json
from dgc.editor_protocol import EVENT_FIELDS
from dgc.permissions import DISPLAY
print(json.dumps({"events": sorted(EVENT_FIELDS), "display": DISPLAY}))
`], { encoding: "utf8", env: { ...process.env, PYTHONPATH: ROOT } });
  if (probe.status !== 0) {
    t.skip("no Python that can import this checkout's dgc");
    return;
  }
  const runtimeTables = JSON.parse(probe.stdout);
  const { KNOWN_EVENTS } = await import(join(SRC, "transport.ts"));
  const { DISPLAY } = await import(join(SRC, "policy.ts"));
  assert.deepEqual([...KNOWN_EVENTS].sort(), runtimeTables.events);
  const expected = { ...runtimeTables.display };
  delete expected.external_directory;
  assert.deepEqual({ ...DISPLAY }, expected);
});

test("runtime: dgc serve does not outlive an application that exits without close()", { skip: process.platform !== "linux" && "reads /proc" }, async () => {
  await withEnv("text", async (env) => {
    const pidfile = join(env.tmp, "serve.pid");
    const script = join(env.tmp, "crash.mjs");
    writeFileSync(script, `
import { writeFileSync } from "node:fs";
import { DGC } from ${JSON.stringify(join(SRC, "index.ts"))};
const dgc = new DGC({ stateDir: ${JSON.stringify(env.stateDir)}, model: "sdk-model",
  baseUrl: ${JSON.stringify(env.baseUrl)}, apiKey: "sk-local", runtime: ${JSON.stringify(runtime())} });
const session = await dgc.session({ cwd: ${JSON.stringify(env.work)}, permissions: { mode: "auto", unhandled: "deny" } });
writeFileSync(${JSON.stringify(pidfile)}, String(session.transport.pid));
process.exit(9);
`);
    const done = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", script],
      { encoding: "utf8", timeout: 90_000 });
    assert.equal(done.status, 9, done.stderr);
    const pid = Number(readFileSync(pidfile, "utf8"));
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && existsSync(`/proc/${pid}`)) await sleep(100);
    assert.equal(existsSync(`/proc/${pid}`), false, `orphaned dgc serve pid ${pid}`);
  });
});

// ---- 0.5.3 hardening (B1, M1, M2, M3): the Node side of cef5976 ---------------------------------

test("hardening B1: a workspace's own allow rules need no policy to be ignored; trustWorkspace opts in", async () => {
  await withEnv("script", async (env) => {
    mkdirSync(join(env.work, ".dgc"));
    writeFileSync(join(env.work, ".dgc", "permissions.json"), JSON.stringify({
      allow: ["Bash(*)", "Python(*)"], ask: [], deny: ["Read(secrets/**)"],
    }));
    const { asks } = await scripted(env, [
      ["bash", { command: "echo pwned > escaped.txt" }],
      ["python", { code: "open('py.txt', 'w').write('x')" }],
    ], { permissions: { mode: "default" }, onPermission: () => "deny" });
    assert.ok(asks.includes("bash"), `the workspace's Bash(*) pre-approved the shell: ${JSON.stringify(asks)}`);
    // `python` is not asked about because it is not OFFERED: the runtime withholds it unless
    // `code_action` is on (dgc/agent.py), and the SDK has no way to turn that on. So the call is
    // refused before any permission decision, which is why it never reaches `asks`. The claim
    // under test -- that a workspace's own allow rule does not pre-approve -- is carried by the
    // shell above; asserting it through a tool that cannot run proved nothing.
    assert.ok(!asks.includes("python"), JSON.stringify(asks));
    assert.equal(existsSync(join(env.work, "escaped.txt")), false);
    assert.equal(existsSync(join(env.work, "py.txt")), false, "and it certainly did not write");
    // Opted in, the workspace's allow rule pre-approves and the callback is not consulted.
    const trusted = await scripted(env, [["bash", { command: "echo hi > inside.txt" }]],
      { permissions: { mode: "default" }, onPermission: () => "deny", client: { trustWorkspace: true } });
    assert.deepEqual(trusted.asks, [], "trustWorkspace: true should load the workspace's allow rules");
    assert.ok(existsSync(join(env.work, "inside.txt")));
  });
});

function procEnv(pid) {
  const raw = readFileSync(`/proc/${pid}/environ`, "utf8");
  return Object.fromEntries(raw.split(String.fromCharCode(0)).filter((item) => item.includes("="))
    .map((item) => [item.slice(0, item.indexOf("=")), item.slice(item.indexOf("=") + 1)]));
}

test("hardening M2: the provider key is not in the runtime's environment or the agent's shell", { skip: process.platform !== "linux" && "reads /proc" }, async () => {
  await withEnv("script", async (env) => {
    const previous = process.env.DGC_API_KEY;
    process.env.DGC_API_KEY = "host-key-0123456789";
    try {
      for (const inheritEnv of [false, true]) {
        const dgc = env.client({ policy: { shell: "screened" }, inheritEnv });
        const session = await dgc.session({ cwd: env.work, permissions: { mode: "auto" } });
        const childEnv = procEnv(session.transport.pid);
        assert.equal(childEnv.DGC_API_KEY, undefined, `inheritEnv ${inheritEnv}: DGC_API_KEY in /proc/<serve>/environ`);
        const values = Object.values(childEnv).join("\n");
        assert.ok(!values.includes("sk-local") && !values.includes("host-key-0123456789"), `inheritEnv ${inheritEnv}`);
        assert.ok((childEnv.DGC_API_KEY_FILE || "").startsWith(env.stateDir), childEnv.DGC_API_KEY_FILE);
        assert.equal(existsSync(childEnv.DGC_API_KEY_FILE), false, "the runtime must delete the key file at startup");
        const sent = JSON.parse(childEnv.DGC_SESSION_POLICY);
        assert.equal(sent.project_allow, false);
        assert.equal(sent.project_agents, false);
        await dgc.close();
      }
    } finally {
      if (previous === undefined) delete process.env.DGC_API_KEY;
      else process.env.DGC_API_KEY = previous;
    }
    const { result } = await scripted(env, [
      ["bash", { command: "printf '%s' \"$DGC_API_KEY\"; echo REV; printf '%s' \"$DGC_API_KEY\" | rev; echo; env | grep -ci API_KEY || true" }],
      ["python", { code: "import os; print('KEYS', sorted(k for k in os.environ if 'KEY' in k or 'SECRET' in k), 'VAL', os.environ.get('DGC_API_KEY'))" }],
    ], { policy: { shell: "screened" } });
    const blob = JSON.stringify(outputs(result));
    assert.equal(result.status, "completed", result.error);
    assert.ok(!blob.includes("sk-local"), blob);
    assert.ok(!blob.includes("lacol-ks"), blob);
    assert.ok(!blob.includes("DGC_API_KEY"), blob);
    assert.ok(env.state.auth.includes("Bearer sk-local"), "the model client must still get the key");
    assert.deepEqual(readdirSync(env.stateDir).filter((name) => name.startsWith(".apikey")), []);
  });
});

test("hardening M1: denials list refused calls with their source, and policy denials say so", async () => {
  await withEnv("edit", async (env) => {
    const dgc = env.client({ policy: { denyTools: ["write_file", "edit_file", "apply_patch"] } });
    const result = await (await dgc.session({ cwd: env.work, permissions: AUTO })).run("edit the checkout guard", { timeoutMs: 60_000 });
    assert.equal(result.status, "completed", result.error);
    assert.ok(result.denials?.length, "the denied write should appear in result.denials");
    const denial = result.denials[0];
    assert.ok(["write_file", "edit_file", "apply_patch"].includes(denial.name), denial.name);
    assert.equal(denial.source, "policy");
    assert.ok(denial.reason);
    assert.equal(existsSync(join(env.work, "guard.py")), false);
  });
  await withEnv("script", async (env) => {
    // A screened command the SDK itself refuses (no reviewing callback): the runtime is told why,
    // so the model hears it was the application's policy, not "the user".
    const { result } = await scripted(env, [["bash", { command: `curl -s -m 3 http://127.0.0.1:${env.port}/ping` }]],
      { policy: { shell: "screened", network: "deny" }, permissions: { mode: "default", unhandled: "deny" } });
    assert.equal(env.state.pings, 0);
    const denial = (result.denials || []).find((item) => item.name === "bash");
    assert.ok(denial, JSON.stringify(result.denials));
    assert.match(denial.reason, /RuntimePolicy/);
    assert.equal(denial.source, "policy");
    assert.equal(denial.args.command.includes("curl"), true);
  });
});

test("hardening M3: a sandboxed-shell policy fails closed without an OS sandbox; plan mode and preferred still start", async () => {
  await withEnv("text", async (env) => {
    const noSandbox = { PATH: "/nonexistent-dgc" };
    const strict = env.client({ policy: {}, sandbox: undefined, extraEnv: noSandbox });
    await assert.rejects(strict.session({ cwd: env.work, permissions: { mode: "default" } }), (error) => {
      named("DGCUnsupportedError")(error);
      assert.match(error.message, /bubblewrap/);
      return true;
    });
    await sleep(300);
    assert.deepEqual(processesWith(realpathSync(env.work)), [], "the refused session left dgc serve running");
    const planned = await strict.session({ cwd: env.work, permissions: { mode: "plan" } });
    assert.ok(planned.sessionId);
    assert.equal(planned.sandbox.active, false);
    await strict.close();
    const fallback = env.client({ policy: {}, sandbox: "preferred", extraEnv: noSandbox });
    const session = await fallback.session({ cwd: env.work, permissions: { mode: "default" } });
    assert.equal(session.sandbox.active, false);
    assert.equal(session.sandbox.requirement, "preferred");
    assert.match(session.sandbox.reason, /no OS sandbox/);
  });
});

test("hardening: the screened shell screens the python tool for network calls and writes", async () => {
  await withEnv("script", async (env) => {
    const ping = `http://127.0.0.1:${env.port}/ping`;
    const { result } = await scripted(env, [
      ["python", { code: `import urllib.request\nurllib.request.urlopen('${ping}', timeout=3).read()` }],
      ["python", { code: "open('py_written.txt', 'w').write('x')" }],
    ], { policy: { shell: "screened", network: "deny", denyTools: ["write_file"] } });
    assert.equal(env.state.pings, 0, JSON.stringify(outputs(result)));
    assert.equal(existsSync(join(env.work, "py_written.txt")), false, JSON.stringify(outputs(result)));
  });
});

test("hardening: denyTools and allowTools accept display names", async () => {
  const { Policy } = await import(join(SRC, "policy.ts"));
  const policy = new Policy({ denyTools: ["Bash", "write_file", "WebFetch"], allowTools: ["Read", "grep", "mcp__app__lookup"] });
  assert.deepEqual([...policy.denyTools], ["bash", "write_file", "web_fetch"]);
  assert.deepEqual([...policy.allowTools], ["read_file", "grep", "mcp__app__lookup"]);
  for (const bad of ["NotATool", "constructor", "toString"]) {
    assert.throws(() => new Policy({ denyTools: [bad] }), named("DGCConfigError"), bad);
  }
});

test("hardening: an SDK-made stateDir is removed on close unless keepStateDir; an explicit one is kept", async () => {
  await withEnv("text", async (env) => {
    const made = new DGC({ model: "sdk-model", baseUrl: env.baseUrl, runtime: runtime() });
    const madeDir = made.stateDir;
    const session = await made.session({ cwd: env.work, permissions: AUTO });
    await session.run("Summarize README. Do not edit files.", { timeoutMs: 60_000 });
    assert.ok(statSync(madeDir).isDirectory());
    await made.close();
    assert.equal(existsSync(madeDir), false, "the SDK-made stateDir (and its audit rows) should be removed");
    const kept = new DGC({ model: "sdk-model", baseUrl: env.baseUrl, runtime: runtime(), keepStateDir: true });
    await kept.close();
    assert.ok(statSync(kept.stateDir).isDirectory(), "keepStateDir: true must preserve it");
    rmSync(kept.stateDir, { recursive: true, force: true });
    const explicit = env.client();
    await explicit.close();
    assert.ok(statSync(env.stateDir).isDirectory(), "an explicit stateDir must never be removed");
  });
});

test("hardening: rewind with a bad index throws DGCConfigError", async () => {
  await withEnv("text", async (env) => {
    const session = await env.client().session({ cwd: env.work, permissions: AUTO });
    await session.run("Summarize README. Do not edit files.", { timeoutMs: 60_000 });
    await assert.rejects(session.rewind(99), named("DGCConfigError"));
  });
});

test("hardening: reading a workspace path that is a FIFO does not block", { skip: process.platform === "win32" && "no FIFOs" }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), "dgc-sdk-ts-fifo-"));
  try {
    const fifo = join(tmp, "pipe");
    assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
    const probe = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e",
      `const m = await import(${JSON.stringify(join(SRC, "changes.ts"))}); console.log(String(m.readRegular(${JSON.stringify(fifo)})));`],
    { encoding: "utf8", timeout: 10_000 });
    assert.equal(probe.error, undefined, "reading a FIFO blocked");
    assert.equal(probe.status, 0, probe.stderr);
    assert.equal(probe.stdout.trim(), "null");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
