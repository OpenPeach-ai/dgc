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
    stateDir, model: "sdk-model", baseUrl, apiKey: "sk-local", runtime: runtime(),
    policy: { denyTools: ["write_file", "edit_file", "apply_patch"] },
  });
  try {
    const session = await dgc.session({
      cwd: work, permissions: { mode: "default", unhandled: "deny" },
      onPermission: () => "once",
    });
    const result = await session.run("edit the checkout guard", { timeoutMs: 60_000 });
    assert.equal(existsSync(join(work, "guard.py")), false);
    assert.ok(["blocked", "completed", "failed", "cancelled"].includes(result.status));
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
    assert.ok(["cancelled", "failed", "blocked"].includes(result.status), result.status);
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
