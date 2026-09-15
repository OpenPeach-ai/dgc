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

test("a correlated session restore crosses setup while queued prompts wait for its exact reply", async () => {
  const command = executable("restore-handshake-backend", `
const readline = require("node:readline");
${protocolFixture()}
ready.capabilities.correlated_state_requests = true;
send(ready);
let restored = false;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const cmd = JSON.parse(line);
  if (cmd.type === "shutdown") process.exit(0);
  if (cmd.type === "resume_session") {
    send({ type: "session", kind: "resumed", session_id: "wrong", message_count: 0, request_id: "stale" });
    setTimeout(() => {
      restored = true;
      send({ type: "session", kind: "resumed", session_id: "saved", message_count: 0, request_id: cmd.request_id });
    }, 70);
  }
  if (cmd.type === "prompt") send({ type: "info", message: restored ? "restored:" + cmd.text : "WRONG SESSION" });
});`);
  const backend = new DgcBackend(scratch, command);
  let restore;
  backend.on("ready", () => {
    restore = backend.request({ type: "resume_session", path: "saved.json", request_id: "restore-1" }, "session", 1000, true);
    restore.then(() => backend.completeHandshake());
  });
  const response = waitFor(backend, "info");
  backend.send({ type: "prompt", text: "queued" });
  try {
    assert.equal((await response).message, "restored:queued");
    assert.equal((await restore).session_id, "saved");
  } finally { backend.dispose(); }
});

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
  assert.equal(active.send({ type: "options_response", id: "r1", answers: { q1: { selected: [0], other: "" } } }), false,
    "a response of the wrong lifecycle type must fail closed");
  const echoed = waitFor(active, "info",
    (event) => echoedCommand(event)?.type === "permission_response");
  assert.equal(active.send({ type: "permission_response", id: "r1", decision: "once" }), true);
  assert.equal(active.send({ type: "permission_response", id: "r1", decision: "once" }), false,
    "the same decision must not be delivered twice");
  assert.equal((await echoed).message.includes('"id":"r1"'), true);
  active.dispose();
});

// A history snapshot taken for a reloaded webview is followed by the decisions the turn still waits
// on, with their original ids. The transport shows such a request again until it is answered, and
// still fails closed when an active id comes back as a different kind of request.
test("backend forwards a re-announced open decision until it is answered, and fails closed on a changed kind", async () => {
  const command = executable("reannounce-backend", `
const readline = require("node:readline");
${protocolFixture()}
const request = { type: "permission_request", id: "r1", name: "bash", args: { command: "npm test" },
  command: "npm test", suggested_rule: "bash(npm test)", choices: ["once", "always", "deny"] };
send(ready);
send(request);
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const cmd = JSON.parse(line);
  if (cmd.type === "shutdown") process.exit(0);
  if (cmd.type === "get_history") { send({ type: "history", items: [], request_id: cmd.request_id }); send(request); }
  if (cmd.type === "permission_response") { send(request); send({ type: "info", message: "after-response" }); }
  if (cmd.type === "status") send({ type: "plan_proposal", id: "r1", plan: "x", choices: ["auto", "acceptEdits", "default", "reject"] });
});`);
  const backend = new DgcBackend(scratch, command);
  const requests = [];
  backend.on("event", (event) => { if (event.type === "permission_request") requests.push(event.id); });
  backend.on("ready", () => backend.completeHandshake());
  const first = waitFor(backend, "permission_request");
  backend.start();
  await first;
  const again = waitFor(backend, "event", (event) => event.type === "permission_request" && requests.length === 2);
  assert.equal(backend.send({ type: "get_history", request_id: "h1" }), true);
  await again;
  const after = waitFor(backend, "info", (event) => event.message === "after-response");
  assert.equal(backend.send({ type: "permission_response", id: "r1", decision: "once" }), true);
  await after;
  assert.deepEqual(requests, ["r1", "r1"], "an answered request is not shown a third time");
  const failure = waitFor(backend, "event", (event) => event.type === "error" && event.protocol_error === true);
  backend.send({ type: "status", request_id: "s1" });
  assert.match((await failure).message, /reused an active approval request ID/);
  backend.dispose();
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
  const disposedListeners = backend.listenerCount("disposed");
  const duringRestart = backend.request(
    { type: "get_workspace_changes", request_id: "restart-inspection" }, "workspace_changes", 30000);
  const rejected = assert.rejects(duringRestart, /restarted or closed/);
  backend.dispose();
  await rejected;
  assert.equal(backend.listenerCount("event"), eventListeners);
  assert.equal(backend.listenerCount("exit"), exitListeners);
  assert.equal(backend.listenerCount("disposed"), disposedListeners);
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
  // Equality is deliberate, so the message must name the side to update: a newer CLI than the
  // extension means the EXTENSION is behind. "protocol mismatch" alone strands whoever updated
  // one half first, which is everyone for a while after a protocol bump.
  assert.match(failure.message, /vibedgc\.com\/vscode\/dgc\.vsix/);
  assert.match(failure.message, new RegExp(`v${DGC_PROTOCOL_VERSION}\\b`));
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(backend.ready, false);
  assert.equal(seen.some((event) => event.type === "echo"), false);
  assert.equal(seen.some((event) => event.type === "command_rejected" && event.count === 1), true);
  backend.dispose();
});

test("an older CLI is told to update itself, with the command that does it", async () => {
  const backend = new DgcBackend(scratch, echoBackend("old-backend", 6));
  const failure = waitFor(backend, "event",
    (event) => event.type === "error" && event.protocol_error === true);
  backend.start();
  const message = (await failure).message;
  assert.match(message, /DGC CLI is too old/);
  assert.match(message, /dgc update/);
  assert.match(message, /Restart Backend/);
  assert.match(message, /speaks v6/);
  backend.dispose();
});

test("a backend that reports no version is refused by the schema, before any version advice", async () => {
  // The mismatch message can name a version because the schema has already guaranteed one.
  const backend = new DgcBackend(scratch, echoBackend("versionless-backend", null));
  const failure = waitFor(backend, "event",
    (event) => event.type === "error" && event.protocol_error === true);
  backend.start();
  const message = (await failure).message;
  assert.match(message, new RegExp(`violated protocol v${DGC_PROTOCOL_VERSION}: ready\\.protocol_version has the wrong type`));
  assert.doesNotMatch(message, /speaks vnull|speaks vundefined|speaks vNaN/);
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

test("monitor frames pass the v14 contract, and a stray field or a reused seq still fails closed", async () => {
  const valid = executable("monitor-backend", `
${protocolFixture()}
send(ready);
send({ type: "turn_start", turn_id: "t2", prompt: "deploy log · 2 events", kind: "monitor" });
send({ type: "monitor_event", id: "mon1", description: "deploy log", event_index: 1, lines: ["READY"],
       omitted_lines: 0, kind: "output", delivery: "wake", turn_id: "t2" });
send({ type: "turn_end", turn_id: "t2", reason: "completed", token_estimate: 0, final_message_id: null });
send({ type: "monitors", items: [{ id: "mon1", state: "running" }], wake_paused: false, pending_events: 0 });
setInterval(() => {}, 1000);`);
  const accepted = new DgcBackend(scratch, valid);
  const seen = [];
  accepted.on("event", (event) => seen.push(event.type));
  const listed = waitFor(accepted, "event", (event) => event.type === "monitors");
  accepted.start();
  await listed;
  assert.deepEqual(seen.filter((type) => type !== "ready"), ["turn_start", "monitor_event", "turn_end", "monitors"]);
  assert.equal(accepted.ready, true);
  accepted.dispose();

  // Undeclared fields fail closed: the webview must never receive data the contract does not name.
  const stray = executable("monitor-stray-backend", `
${protocolFixture()}
send(ready);
send({ type: "monitor_event", id: "mon1", description: "d", event_index: 1, lines: [], kind: "output",
       delivery: "inline", pid: 4242 });
setInterval(() => {}, 1000);`);
  const strayBackend = new DgcBackend(scratch, stray);
  const strayFailure = waitFor(strayBackend, "event",
    (event) => event.type === "error" && event.protocol_error === true);
  strayBackend.start();
  assert.match((await strayFailure).message,
    new RegExp(`violated protocol v${DGC_PROTOCOL_VERSION}: monitor_event has undeclared field "pid"`));
  strayBackend.dispose();

  // The bug the event_index name exists to prevent: a per-monitor counter written into the frame's
  // own seq (it restarts at 1) reads as a duplicate frame, and the backend is shut down for it.
  const clash = executable("monitor-seq-clash-backend", `
${protocolFixture()}
send(ready);
send({ type: "info", message: "one" });
send({ type: "info", message: "two" });
process.stdout.write(JSON.stringify({ type: "monitor_event", seq: 1, id: "mon1", description: "d",
  event_index: 1, lines: [], kind: "output", delivery: "inline" }) + "\\n");
setInterval(() => {}, 1000);`);
  const clashBackend = new DgcBackend(scratch, clash);
  const clashFailure = waitFor(clashBackend, "event",
    (event) => event.type === "error" && event.protocol_error === true);
  clashBackend.start();
  assert.match((await clashFailure).message, /out-of-order event sequence/);
  clashBackend.dispose();
});

// ---- per-child lifecycle: every exit is reported once, with who asked for it and why ----------

function collectExits(backend) {
  const exits = [];
  backend.on("exit", (code, signal, info) => exits.push({ code, signal, info }));
  return exits;
}

test("a child that closes its stdin and lingers still reports its exit", async () => {
  // The stdin 'error' handler used to null the process before the exit guard ran, so the exit was
  // swallowed: no backend.log line, no recovery, a turn spinning forever (measured 22 of 30).
  const command = executable("close-stdin-and-linger", `
${protocolFixture()}
send(ready);
setTimeout(() => { process.stdin.destroy(); require("node:fs").closeSync(0); }, 20);
setTimeout(() => process.exit(0), 400);`);
  const backend = new DgcBackend(scratch, command);
  let writer;
  backend.on("event", (event) => { if (event.transport_error) clearInterval(writer); });
  const exits = collectExits(backend);
  const exited = waitFor(backend, "exit", () => true, 5000);
  backend.start();
  await waitFor(backend, "ready");
  backend.completeHandshake();
  writer = setInterval(() => backend.send({ type: "status" }), 5);
  try {
    await exited;
  } finally { clearInterval(writer); }
  await new Promise((resolve) => setTimeout(resolve, 150));
  backend.dispose();
  const own = exits.filter((row) => row.info && row.info.cause === undefined);
  assert.equal(own.length >= 1, true, JSON.stringify(exits));
  assert.equal(own[0].code === 0 || own[0].code === null, true);
  assert.ok(own[0].info.framesWritten > 0, "the frames sent to the child are counted");
  assert.equal(own[0].info.lastFrame, "status");
  assert.match(String(own[0].info.transport), /EPIPE|ERR_STREAM|write/i,
    "the failed write is recorded on the exit it preceded");
  const pids = exits.map((row) => row.info.pid);
  assert.equal(new Set(pids).size, pids.length, "each child reports its exit exactly once");
});

test("an EPIPE on a dying child is recorded on its exit instead of hiding it", async () => {
  const command = executable("exit-without-reading", `
${protocolFixture()}
send(ready);
setTimeout(() => process.exit(0), 60);`);
  const backend = new DgcBackend(scratch, command);
  const seen = [];
  backend.on("event", (event) => seen.push(event));
  const exits = collectExits(backend);
  backend.start();
  await waitFor(backend, "ready");
  backend.completeHandshake();
  const big = "x".repeat(256 * 1024);
  const writer = setInterval(() => backend.send({ type: "prompt", text: big }), 2);
  const exited = waitFor(backend, "exit", () => true, 5000);
  try { await exited; } finally { clearInterval(writer); }
  await new Promise((resolve) => setTimeout(resolve, 200));
  const first = exits.find((row) => row.info.cause === undefined);
  assert.ok(first, "the child's own death is reported");
  if (seen.some((event) => event.transport_error === true)) {
    assert.match(String(first.info.transport), /EPIPE|ERR_STREAM|write/i,
      "a failed write is carried on the exit it preceded");
  }
  backend.dispose();
});

test("a respawn after a protocol failure is not reported as asked-for", async () => {
  // An instance-wide `intentional` flag set by the protocol failure stayed set for the next child
  // this instance started, so that child's own exit(0) logged "asked for it: yes" and was never
  // recovered.
  const counter = join(scratch, "generation-count");
  writeFileSync(counter, "0");
  const command = executable("malformed-then-ok", `
const fs = require("node:fs");
${protocolFixture()}
const generation = Number(fs.readFileSync(${JSON.stringify(counter)}, "utf8")) + 1;
fs.writeFileSync(${JSON.stringify(counter)}, String(generation));
if (generation === 1) {
  process.stdout.write("{not json\\n");
  setTimeout(() => {}, 5000);
} else {
  send(ready);
  setTimeout(() => process.exit(0), 150);
}`);
  const backend = new DgcBackend(scratch, command);
  backend.on("event", () => {});
  const exits = collectExits(backend);
  const teardowns = [];
  backend.on("teardown", (cause, pid) => teardowns.push({ cause, pid }));
  backend.start();
  await waitFor(backend, "exit", () => true, 5000);
  assert.equal(teardowns.length, 1);
  assert.match(teardowns[0].cause, /^protocol: dgc backend emitted malformed NDJSON/);
  assert.match(String(exits[0].info.cause), /^protocol: dgc backend emitted malformed NDJSON/);
  backend.send({ type: "status" });                // the next command starts generation 2
  await waitFor(backend, "exit", (code) => code === 0, 5000);
  assert.equal(exits.length, 2);
  assert.equal(exits[1].info.cause, undefined, "generation 2 died on its own and must say so");
  backend.dispose();
});

test("every teardown names its cause, and the exit carries it", async () => {
  const backend = new DgcBackend(scratch, echoBackend("teardown-cause-backend"));
  backend.on("event", () => {});
  const exits = collectExits(backend);
  const teardowns = [];
  backend.on("teardown", (cause, pid) => teardowns.push({ cause, pid }));
  backend.start();
  await waitFor(backend, "ready");
  backend.completeHandshake();
  const pid = backend.childPid;
  assert.equal(backend.send({ type: "status" }), true);
  await waitFor(backend, "info");
  const exited = waitFor(backend, "exit", () => true, 5000);
  backend.dispose("chat restoration timed out");
  await exited;
  assert.deepEqual(teardowns, [{ cause: "chat restoration timed out", pid }]);
  assert.equal(exits.length, 1);
  assert.equal(exits[0].info.cause, "chat restoration timed out");
  assert.equal(exits[0].info.pid, pid);
  assert.equal(exits[0].info.framesWritten, 2, "the status command and the shutdown frame");
  assert.equal(exits[0].info.lastFrame, "shutdown");
  assert.ok(exits[0].info.uptimeMs >= 0);
});

test("a child that never launched reports launch_failed, not a backend death", async () => {
  const backend = new DgcBackend(scratch, join(scratch, "no-such-dgc-binary"));
  const events = [];
  backend.on("event", (event) => events.push(event));
  const exits = collectExits(backend);
  const failed = waitFor(backend, "launch_failed", () => true, 3000);
  backend.start();
  assert.match(String(await failed), /ENOENT/);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(exits.length, 0, "recovery must not respawn a CLI that is not there");
  assert.ok(events.some((event) => event.notInstalled === true));
});


// ---- 0.40 options ----------------------------------------------------------------------------------
const protocolBundle = join(scratch, "protocol.cjs");
await build({ entryPoints: [join(here, "../src/protocol.generated.ts")], bundle: true, format: "cjs",
  platform: "node", target: "node18", outfile: protocolBundle, logLevel: "silent" });
const { dgcCommandError, dgcEventError } = createRequire(import.meta.url)(protocolBundle);
const V14_QUESTION = { id: "q1", header: "Storage", question: "Where?", multi_select: false, options: [
  { label: "Local", description: "On this machine", recommended: true },
  { label: "Cloud", description: "", recommended: false }] };

test("v14 question frames validate and the v13 shapes fail closed", async () => {
  assert.equal(dgcEventError({ type: "options_request", seq: 0, id: "r1", call_id: "c1", questions: [V14_QUESTION] }), undefined);
  assert.equal(dgcEventError({ type: "options_request", seq: 0, id: "r1", questions: [V14_QUESTION] }), undefined);
  assert.notEqual(dgcEventError({ type: "options_request", seq: 0, id: "r1", call_id: "c1" }), undefined, "questions is required");
  for (const outcome of ["answered", "dismissed", "cancelled", "unavailable"]) {
    assert.equal(dgcEventError({ type: "options_resolved", seq: 0, id: null, call_id: null, outcome, questions: [V14_QUESTION],
      answers: { q1: { selected: [0], other: "" } } }), undefined, outcome);
  }
  assert.notEqual(dgcEventError({ type: "options_resolved", seq: 0, id: null, outcome: "skipped", questions: [] }), undefined);
  assert.notEqual(dgcCommandError({ type: "options_response", id: "r1", choice: 1 }), undefined, "choice (v6) is gone");
  assert.equal(dgcCommandError({ type: "options_response", id: "r1", answers: { q1: { selected: [0], other: "" } } }), undefined);
  assert.equal(dgcCommandError({ type: "options_response", id: "r1", dismissed: true }), undefined);

  const accepted = executable("options-v14-backend", `
const readline = require("node:readline");
${protocolFixture()}
send(ready);
send({ type: "options_request", id: "r1", call_id: "c1", questions: [${JSON.stringify(V14_QUESTION)}] });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const cmd = JSON.parse(line);
  if (cmd.type === "shutdown") process.exit(0);
  if (cmd.type === "options_response") {
    send({ type: "info", message: "echo:" + JSON.stringify(cmd) });
    send({ type: "options_resolved", id: "r1", call_id: "c1", outcome: "answered", questions: [], answers: cmd.answers });
  }
});`);
  const backend = new DgcBackend(scratch, accepted);
  backend.on("ready", () => backend.completeHandshake());
  const request = waitFor(backend, "event", (event) => event.type === "options_request");
  backend.start();
  await request;
  const resolved = waitFor(backend, "event", (event) => event.type === "options_resolved");
  assert.equal(backend.send({ type: "options_response", id: "r1", choice: 1 }), false, "choice fails closed");
  assert.equal(backend.send({ type: "options_response", id: "r1", answers: { q1: { selected: [0], other: "" } } }), true);
  assert.equal(backend.send({ type: "options_response", id: "r1", dismissed: true }), false, "one response per request");
  assert.deepEqual((await resolved).answers, { q1: { selected: [0], other: "" } });
  backend.dispose();

  const stray = executable("options-stray-backend", `
${protocolFixture()}
send(ready);
send({ type: "options_request", id: "r1", questions: [${JSON.stringify(V14_QUESTION)}], options: ["Local", "Cloud"] });
setInterval(() => {}, 1000);`);
  const strayBackend = new DgcBackend(scratch, stray);
  const failure = waitFor(strayBackend, "event", (event) => event.type === "error" && event.protocol_error === true);
  strayBackend.start();
  assert.match((await failure).message,
    new RegExp(`violated protocol v${DGC_PROTOCOL_VERSION}: options_request has undeclared field "options"`));
  strayBackend.dispose();
});
// ---- end 0.40 options ------------------------------------------------------------------------------


// ---- 0.40 thinking ---------------------------------------------------------------------------------
// v14 thinking provenance: the generated validator every backend frame passes through requires a block
// and a source on thinking_delta, closes the enums, and rejects undeclared fields.
test("v14 thinking frames: block and source required, enums closed, undeclared fields rejected", async () => {
  const protocolBundle = join(scratch, "protocol-thinking.cjs");
  await build({ entryPoints: [join(here, "../src/protocol.generated.ts")], bundle: true, format: "cjs",
    platform: "node", target: "node18", outfile: protocolBundle, logLevel: "silent" });
  const { dgcEventError } = createRequire(import.meta.url)(protocolBundle);
  const delta = { type: "thinking_delta", seq: 1, text: "The first run fails on the boundary", block: "t3:think1",
    source: "summarized", provider: "anthropic" };
  const examples = [
    delta,
    { type: "thinking_end", seq: 2, block: "t3:think1", source: "summarized", provider: "anthropic",
      placement: "inline", seconds: 2.1 },
    { type: "thinking_delta", seq: 3, text: "Okay, the user wants…", block: "t4:think1", source: "raw" },
    { type: "thinking_end", seq: 4, block: "t4:think1", source: "raw", placement: "collapsed", seconds: 14.2 },
    { type: "thinking_end", seq: 5, block: "t5:think2", source: "withheld", provider: "anthropic",
      placement: "collapsed", seconds: 6.0 },
    { type: "thinking_delta", seq: 6, text: "Look at gate.py…", block: "t6:think3", source: "raw",
      agent: "sub-1a2b3c4d5e6f" },
    { type: "thinking_end", seq: 7, block: "t6:think3", source: "raw", agent: "sub-1a2b3c4d5e6f",
      placement: "collapsed", seconds: 8.4 },
  ];
  for (const frame of examples) assert.equal(dgcEventError(frame), undefined, JSON.stringify(frame));
  const without = (key) => Object.fromEntries(Object.entries(delta).filter(([name]) => name !== key));
  const rejected = [
    without("block"), without("source"),
    { ...delta, source: "summary" }, { ...delta, provider: "ollama" }, { ...delta, agent: 5 },
    { ...delta, signature: "EqQBCkYIARgC" },
    { type: "thinking_end", seq: 8, block: "t3:think1", source: "raw" },
  ];
  for (const frame of rejected) assert.equal(typeof dgcEventError(frame), "string", JSON.stringify(frame));
});
// ---- end 0.40 thinking -----------------------------------------------------------------------------


// ---- 0.40 agents -----------------------------------------------------------------------------------
test("agent frames and snapshots pass the v14 contract; a stray field, a null waiting_for or an ended state in an update fails closed", async () => {
  const valid = executable("agents-backend", `
${protocolFixture()}
send(ready);
send({ type: "turn_start", turn_id: "t1", prompt: "split", kind: "prompt" });
send({ type: "agent_started", id: "sub-aaaaaaaaaaaa", parent_id: null, call_id: "call_0", description: "part",
       depth: 1, state: "queued", started_at: 1789000000.5, isolated: true, parallel: true, agent_type: "reviewer",
       model: "qwen3.8:27b", turn_id: "t1" });
send({ type: "agent_updated", id: "sub-aaaaaaaaaaaa", state: "waiting", waiting_for: "permission", tool_calls: 1 });
send({ type: "agent_updated", id: "sub-aaaaaaaaaaaa", state: "running", activity: "", tokens: 20 });
send({ type: "agent_ended", id: "sub-aaaaaaaaaaaa", state: "failed", duration_ms: 1200, tool_calls: 2,
       message: "the sub-agent stopped without a final summary" });
send({ type: "agents", request_id: "agents-restore-1", total: 1, active: 0, items: [{ id: "sub-aaaaaaaaaaaa",
       parent_id: null, call_id: "call_0", description: "part", depth: 1, state: "failed", tool_calls: 2,
       isolated: true, parallel: true, restored: false, duration_ms: 1200 }] });
setInterval(() => {}, 1000);`);
  const accepted = new DgcBackend(scratch, valid);
  const seen = [];
  accepted.on("event", (event) => seen.push(event.type));
  const listed = waitFor(accepted, "event", (event) => event.type === "agents");
  accepted.start();
  await listed;
  assert.deepEqual(seen.filter((type) => type !== "ready"),
    ["turn_start", "agent_started", "agent_updated", "agent_updated", "agent_ended", "agents"]);
  accepted.dispose();

  for (const [name, frame, pattern] of [
    ["agents-stray", `{ type: "agent_started", id: "sub-aaaaaaaaaaaa", parent_id: null, call_id: "c", description: "d",
       depth: 1, state: "running", started_at: 1, isolated: false, parallel: false, foo: 1 }`,
     /agent_started has undeclared field "foo"/],
    ["agents-null-waiting", `{ type: "agent_updated", id: "sub-aaaaaaaaaaaa", state: "running", waiting_for: null }`,
     /agent_updated/],
    ["agents-ended-update", `{ type: "agent_updated", id: "sub-aaaaaaaaaaaa", state: "finished" }`, /agent_updated/],
  ]) {
    const broken = executable(name, `
${protocolFixture()}
send(ready);
send(${frame});
setInterval(() => {}, 1000);`);
    const backend = new DgcBackend(scratch, broken);
    const failure = waitFor(backend, "event", (event) => event.type === "error" && event.protocol_error === true);
    backend.start();
    assert.match((await failure).message, new RegExp(`violated protocol v${DGC_PROTOCOL_VERSION}: `));
    assert.match((await failure).message, pattern);
    backend.dispose();
  }
});
// ---- end 0.40 agents -------------------------------------------------------------------------------
