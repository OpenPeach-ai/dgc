import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "dgc-vscode-backend-"));
const bundle = join(scratch, "backend.cjs");
await build({
  entryPoints: [join(here, "../src/backend.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  outfile: bundle,
  logLevel: "silent",
});
const { DgcBackend, DGC_PROTOCOL_VERSION, MAX_COMMAND_BYTES } = createRequire(import.meta.url)(bundle);
after(() => rmSync(scratch, { recursive: true, force: true }));

function executable(name, body) {
  const path = join(scratch, name);
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`, "utf8");
  chmodSync(path, 0o700);
  return path;
}

function waitFor(emitter, name, predicate = () => true, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(name, handler);
      reject(new Error(`timed out waiting for ${name}`));
    }, timeout);
    const handler = (value) => {
      if (!predicate(value)) return;
      clearTimeout(timer);
      emitter.off(name, handler);
      resolve(value);
    };
    emitter.on(name, handler);
  });
}

function protocolFixture(version = DGC_PROTOCOL_VERSION) {
  return `
let sequence = 0;
const send = (value) => process.stdout.write(JSON.stringify({ seq: sequence++, ...value }) + "\\n");
const ready = { type: "ready", version: "fixture", protocol_version: ${version},
  capabilities: {}, model: "fixture", mode: "default", think: "off",
  base_url: "http://127.0.0.1:1/v1", workspace_trusted: true,
  commands: [], custom_commands: [], goal: { text: "", status: "none" }, context_size: 32768 };
`;
}

function echoBackend(name, version = DGC_PROTOCOL_VERSION) {
  return executable(name, `
const readline = require("node:readline");
${protocolFixture(version)}
setTimeout(() => send(ready), 30);
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const cmd = JSON.parse(line);
  if (cmd.type === "shutdown") process.exit(0);
  if (cmd.type === "compact") process.exit(7);
  if (cmd.type === "get_goal") {
    send({ type: "error", message: "synthetic backend error" });
    return;
  }
  send({ type: "info", message: "echo:" + JSON.stringify(cmd) });
});`);
}

function echoedCommand(event) {
  if (!event.message?.startsWith("echo:")) return undefined;
  return JSON.parse(event.message.slice(5));
}

test("backend gates startup, survives error events, and restarts on the next command", async () => {
  const backend = new DgcBackend(scratch, echoBackend("healthy-backend"));
  const echoes = [];
  backend.on("info", (event) => {
    const command = echoedCommand(event);
    if (command) echoes.push(command);
  });
  backend.on("ready", () => {
    assert.equal(backend.sendSetup({ type: "set_workspace_roots", roots: [scratch] }), true);
    backend.completeHandshake();
  });

  assert.equal(backend.send({ type: "prompt", text: "queued before ready" }), true);
  await waitFor(backend, "info", (event) => echoedCommand(event)?.type === "prompt");
  assert.deepEqual(echoes.map((command) => command.type), ["set_workspace_roots", "prompt"],
    "handshake configuration must run before a startup-queued prompt");

  // Node EventEmitter treats the name "error" specially. A backend error must stay a normal
  // protocol event and must not crash the extension host when no dedicated error listener exists.
  const backendError = waitFor(backend, "event",
    (event) => event.type === "error" && event.message === "synthetic backend error");
  backend.send({ type: "get_goal" });
  await backendError;
  const stillAlive = waitFor(backend, "info", (event) => echoedCommand(event)?.type === "status");
  backend.send({ type: "status" });
  await stillAlive;

  const optionalFields = waitFor(backend, "info",
    (event) => echoedCommand(event)?.type === "set_model");
  assert.equal(backend.send({ type: "set_model", base_url: "https://provider.invalid/v1",
    api_key: "sentinel", model: undefined }), true);
  const optionalCommand = echoedCommand(await optionalFields);
  assert.deepEqual(optionalCommand, { type: "set_model",
    base_url: "https://provider.invalid/v1", api_key: "sentinel" },
    "optional undefined properties must be omitted before validating the JSON wire object");

  const exited = waitFor(backend, "exit", (code) => code === 7);
  backend.send({ type: "compact" });
  await exited;
  const restarted = waitFor(backend, "info",
    (event) => echoedCommand(event)?.type === "prompt"
      && echoedCommand(event)?.text === "after restart");
  assert.equal(backend.send({ type: "prompt", text: "after restart" }), true);
  await restarted;
  assert.equal(backend.ready, true);
  backend.dispose();
});

test("backend correlates decision types, rejects stale replies, and never restarts for control frames", async () => {
  const command = echoBackend("decision-backend");
  const dormant = new DgcBackend(scratch, command);
  const dormantEvents = [];
  dormant.on("event", (event) => dormantEvents.push(event));
  assert.equal(dormant.send({ type: "permission_response", id: "r1", decision: "once" }), false);
  assert.equal(dormant.send({ type: "cancel" }), false);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(dormant.ready, false, "a stale decision must not launch a fresh backend generation");
  assert.ok(dormantEvents.every((event) => event.type === "command_rejected"));

  const activeCommand = executable("active-decision-backend", `
const readline = require("node:readline");
${protocolFixture()}
send(ready);
send({ type: "permission_request", id: "r1", name: "bash", args: { command: "npm test" },
  command: "npm test", suggested_rule: "bash(npm test)", choices: ["once", "always", "deny"] });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const cmd = JSON.parse(line);
  if (cmd.type === "shutdown") process.exit(0);
  send({ type: "info", message: "echo:" + JSON.stringify(cmd) });
});`);
  const active = new DgcBackend(scratch, activeCommand);
  active.on("ready", () => active.completeHandshake());
  active.start();
  await waitFor(active, "permission_request");
  assert.equal(active.send({ type: "options_response", id: "r1", choice: 1 }), false,
    "a response of the wrong lifecycle type must fail closed");
  const echoed = waitFor(active, "info",
    (event) => echoedCommand(event)?.type === "permission_response");
  assert.equal(active.send({ type: "permission_response", id: "r1", decision: "once" }), true);
  assert.equal(active.send({ type: "permission_response", id: "r1", decision: "once" }), false,
    "the same decision must not be delivered twice");
  assert.equal((await echoed).message.includes('"id":"r1"'), true);
  active.dispose();
});

test("backend query requests ignore crossed replies and release listeners on every terminal path", async () => {
  const command = executable("correlated-query-backend", `
const readline = require("node:readline");
${protocolFixture()}
ready.capabilities.correlated_state_requests = true;
send(ready);
const goals = [];
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const cmd = JSON.parse(line);
  if (cmd.type === "shutdown") process.exit(0);
  if (cmd.type === "get_goal") {
    goals.push(cmd);
    if (goals.length === 2) {
      send({ type: "goal_changed", request_id: "forged-request", goal: "forged", status: "active" });
      send({ type: "goal_changed", request_id: goals[1].request_id, goal: "second", status: "active" });
      setTimeout(() => send({ type: "goal_changed", request_id: goals[0].request_id,
        goal: "first", status: "blocked" }), 20);
    }
    return;
  }
  if (cmd.type === "compact") {
    send({ type: "command_rejected", request_id: "another-request", command: "compact",
      reason: "turn_in_progress", message: "unrelated rejection" });
    send({ type: "command_rejected", request_id: cmd.request_id, command: "compact",
      reason: "turn_in_progress", message: "synthetic busy" });
  }
  // status deliberately receives no response so the caller exercises timeout cleanup.
});`);
  const backend = new DgcBackend(scratch, command);
  backend.on("ready", () => backend.completeHandshake());
  backend.start();
  await waitFor(backend, "ready");

  const first = backend.request(
    { type: "get_goal", request_id: "goal-first" }, "goal_changed", 1000);
  const second = backend.request(
    { type: "get_goal", request_id: "goal-second" }, "goal_changed", 1000);
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.deepEqual(
    [firstResult.request_id, firstResult.goal, firstResult.status],
    ["goal-first", "first", "blocked"],
  );
  assert.deepEqual(
    [secondResult.request_id, secondResult.goal, secondResult.status],
    ["goal-second", "second", "active"],
  );

  await assert.rejects(
    backend.request({ type: "compact", request_id: "compact-exact" }, "compacted", 1000),
    /synthetic busy/,
    "only the rejection carrying the exact request ID may settle the command",
  );
  const eventListeners = backend.listenerCount("event");
  const exitListeners = backend.listenerCount("exit");
  const fatal = backend.request(
    { type: "status", request_id: "status-fatal" }, "status", 1000);
  backend.emit("event", {
    type: "error", message: "synthetic fatal transport failure", fatal: true,
  });
  await assert.rejects(fatal, /synthetic fatal transport failure/);
  assert.equal(backend.listenerCount("event"), eventListeners);
  assert.equal(backend.listenerCount("exit"), exitListeners);
  await assert.rejects(
    backend.request({ type: "status", request_id: "status-timeout" }, "status", 40),
    /timed out waiting for status/,
  );
  assert.equal(backend.listenerCount("event"), eventListeners);
  assert.equal(backend.listenerCount("exit"), exitListeners);
  const longCompactionWindow = backend.request(
    { type: "status", request_id: "long-compaction-window" }, "status", 130_000);
  backend.emit("event", { type: "status", request_id: "long-compaction-window" });
  assert.equal((await longCompactionWindow).request_id, "long-compaction-window",
    "manual compaction may wait through the backend's 120-second summary deadline");
  await assert.rejects(
    backend.request({ type: "status", request_id: "unbounded-timeout" }, "status", 180_001),
    /between 1 and 180000ms/,
  );
  backend.dispose();
});

test("backend prioritizes correlated decisions over queued prompts under stdin backpressure", async () => {
  const delayed = executable("decision-backpressure-backend", `
const readline = require("node:readline");
${protocolFixture()}
send(ready);
send({ type: "permission_request", id: "r-control", name: "bash", args: { command: "test" },
  command: "test", suggested_rule: "bash(test)", choices: ["once", "always", "deny"] });
process.stdin.pause();
setTimeout(() => {
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const cmd = JSON.parse(line);
    if (cmd.type === "shutdown") process.exit(0);
    send({ type: "info", message: cmd.type === "prompt"
      ? "prompt:" + cmd.text.slice(0, cmd.text.indexOf(":")) : "control:" + cmd.type });
  });
}, 150);`);
  const backend = new DgcBackend(scratch, delayed);
  const order = [];
  backend.on("ready", () => backend.completeHandshake());
  backend.on("info", (event) => order.push(event.message));
  backend.start();
  await waitFor(backend, "permission_request");
  const payload = "x".repeat(32 * 1024);
  for (let sequence = 0; sequence < 180; sequence += 1) {
    backend.send({ type: "prompt", text: `${sequence}:${payload}` });
  }
  assert.equal(backend.send({ type: "permission_response", id: "r-control", decision: "deny" }), true,
    "a bounded full prompt queue must reserve delivery for its active decision");
  await waitFor(backend, "info", (event) => event.message === "control:permission_response", 5000);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const controlIndex = order.indexOf("control:permission_response");
  assert.ok(controlIndex >= 0 && order.slice(controlIndex + 1).some((value) => value.startsWith("prompt:")),
    `expected queued prompts after priority control frame, got ${order.slice(0, 12).join(", ")}`);
  backend.dispose();
});

test("backend drops a queued control frame when its originating turn ends", async () => {
  const delayed = executable("expired-control-backend", `
const readline = require("node:readline");
${protocolFixture()}
send(ready);
send({ type: "turn_start", turn_id: "t1", prompt: "fixture" });
send({ type: "permission_request", id: "r-expire", name: "bash", args: { command: "test" },
  command: "test", suggested_rule: "bash(test)", choices: ["once", "always", "deny"] });
process.stdin.pause();
setTimeout(() => send({ type: "turn_end", turn_id: "t1", reason: "error", token_estimate: 0 }), 60);
setTimeout(() => {
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const cmd = JSON.parse(line);
    if (cmd.type === "shutdown") process.exit(0);
    send({ type: "info", message: "echo:" + cmd.type });
  });
}, 180);`);
  const backend = new DgcBackend(scratch, delayed);
  const echoed = [];
  backend.on("ready", () => backend.completeHandshake());
  backend.on("info", (event) => echoed.push(event.message));
  backend.start();
  await waitFor(backend, "permission_request");
  const turnEnded = waitFor(backend, "turn_end");
  const payload = "x".repeat(32 * 1024);
  for (let sequence = 0; sequence < 180; sequence += 1) {
    backend.send({ type: "prompt", text: `${sequence}:${payload}` });
  }
  assert.equal(backend.send({ type: "permission_response", id: "r-expire", decision: "deny" }), true);
  await turnEnded;
  await waitFor(backend, "info", (event) => event.message === "echo:prompt", 5000);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(echoed.includes("echo:permission_response"), false,
    "a decision queued for an ended turn must never reach a later turn");
  backend.dispose();
});

test("backend preserves FIFO under real stdin backpressure and bounds its queue", async () => {
  const delayed = executable("delayed-reader-backend", `
const readline = require("node:readline");
${protocolFixture()}
send(ready);
setTimeout(() => {
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const cmd = JSON.parse(line);
    if (cmd.type === "shutdown") process.exit(0);
    send({ type: "info", message: "echo:" + cmd.text.slice(0, cmd.text.indexOf(":")) });
  });
}, 150);`);
  const backend = new DgcBackend(scratch, delayed);
  const echoes = [];
  backend.on("ready", () => backend.completeHandshake());
  backend.on("info", (event) => echoes.push(Number(event.message.slice(5))));
  backend.start();
  await waitFor(backend, "ready");
  const payload = "x".repeat(32 * 1024);
  for (let commandSequence = 0; commandSequence < 48; commandSequence += 1) {
    assert.equal(backend.send({ type: "prompt", text: `${commandSequence}:${payload}` }), true);
  }
  await waitFor(backend, "info", (event) => event.message === "echo:47", 5000);
  assert.deepEqual(echoes, Array.from({ length: 48 }, (_, index) => index));
  backend.dispose();

  const blocked = executable("blocked-reader-backend", `
${protocolFixture()}
send(ready);
process.stdin.pause();
setInterval(() => {}, 1000);`);
  const bounded = new DgcBackend(scratch, blocked);
  const rejected = [];
  bounded.on("ready", () => bounded.completeHandshake());
  bounded.on("event", (event) => {
    if (event.type === "command_rejected") rejected.push(event);
  });
  bounded.start();
  await waitFor(bounded, "ready");
  const accepted = [];
  for (let commandSequence = 0; commandSequence < 180; commandSequence += 1) {
    accepted.push(bounded.send({ type: "prompt", text: `${commandSequence}:${payload}` }));
  }
  assert.ok(accepted.includes(false), "a stalled backend must not create an unbounded queue");
  assert.ok(rejected.some((event) => /queue is full/.test(event.message)));
  bounded.dispose();
});

test("backend rejects incompatible protocol versions and never releases queued commands", async () => {
  const backend = new DgcBackend(scratch, echoBackend("future-backend", 999));
  const seen = [];
  backend.on("event", (event) => seen.push(event));
  assert.equal(backend.send({ type: "prompt", text: "must not run" }), true);
  const failure = await waitFor(backend, "event",
    (event) => event.type === "error" && event.protocol_error === true);
  assert.match(failure.message, /protocol mismatch/i);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(backend.ready, false);
  assert.equal(seen.some((event) => event.type === "echo"), false);
  assert.equal(seen.some((event) => event.type === "command_rejected" && event.count === 1), true);
  backend.dispose();
});

test("backend fails closed on malformed events and oversized or invalid commands", async () => {
  const malformed = executable("malformed-backend",
    `setTimeout(() => process.stdout.write("not-json\\n"), 20); setInterval(() => {}, 1000);`);
  const backend = new DgcBackend(scratch, malformed);
  const failure = waitFor(backend, "event",
    (event) => event.type === "error" && event.protocol_error === true);
  backend.start();
  assert.match((await failure).message, /malformed NDJSON/);
  assert.equal(backend.ready, false);

  const rejected = [];
  const validator = new DgcBackend(scratch, malformed);
  validator.on("event", (event) => rejected.push(event));
  assert.equal(validator.send({ nope: true }), false);
  assert.equal(validator.send({ type: "set_mode", mode: "unsafe-surprise" }), false);
  assert.equal(validator.send({ type: "prompt", text: 7 }), false);
  assert.equal(validator.send({ type: "prompt", text: "x".repeat(MAX_COMMAND_BYTES) }), false);
  assert.deepEqual(rejected.map((event) => event.type),
    ["command_rejected", "command_rejected", "command_rejected", "command_rejected"]);

  const invalidShape = executable("invalid-shape-backend", `
${protocolFixture()}
send(ready);
send({ type: "text_delta" });
setInterval(() => {}, 1000);`);
  const shaped = new DgcBackend(scratch, invalidShape);
  const shapeFailure = waitFor(shaped, "event",
    (event) => event.type === "error" && event.protocol_error === true);
  shaped.start();
  assert.match((await shapeFailure).message, /text_delta\.text is required/);

  const reordered = executable("reordered-backend", `
${protocolFixture()}
send(ready);
sequence = 0;
send({ type: "info", message: "out of order" });
setInterval(() => {}, 1000);`);
  const sequenced = new DgcBackend(scratch, reordered);
  const sequenceFailure = waitFor(sequenced, "event",
    (event) => event.type === "error" && event.protocol_error === true);
  sequenced.start();
  assert.match((await sequenceFailure).message, /out-of-order event sequence/);
  backend.dispose();
  validator.dispose();
  shaped.dispose();
  sequenced.dispose();
});
