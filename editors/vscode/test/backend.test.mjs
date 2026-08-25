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
const { DgcBackend, DGC_PROTOCOL_VERSION } = createRequire(import.meta.url)(bundle);
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

function echoBackend(name, version = DGC_PROTOCOL_VERSION) {
  return executable(name, `
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
setTimeout(() => send({ type: "ready", protocol_version: ${version}, model: "fixture" }), 30);
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const cmd = JSON.parse(line);
  if (cmd.type === "shutdown") process.exit(0);
  if (cmd.type === "crash") process.exit(7);
  if (cmd.type === "backend_error") {
    send({ type: "error", message: "synthetic backend error" });
    return;
  }
  if (cmd.type === "reserved_event") {
    send({ type: "event", message: "must use the universal channel once" });
    send({ type: "newListener", message: "must not reach EventEmitter internals" });
    return;
  }
  send({ type: "echo", command: cmd });
});`);
}

test("backend gates startup, survives error events, and restarts on the next command", async () => {
  const backend = new DgcBackend(scratch, echoBackend("healthy-backend"));
  const echoes = [];
  backend.on("echo", (event) => echoes.push(event.command));
  backend.on("ready", () => {
    assert.equal(backend.sendSetup({ type: "set_workspace_roots", roots: [scratch] }), true);
    backend.completeHandshake();
  });

  assert.equal(backend.send({ type: "prompt", text: "queued before ready" }), true);
  await waitFor(backend, "echo", (event) => event.command.type === "prompt");
  assert.deepEqual(echoes.map((command) => command.type), ["set_workspace_roots", "prompt"],
    "handshake configuration must run before a startup-queued prompt");

  // Node EventEmitter treats the name "error" specially. A backend error must stay a normal
  // protocol event and must not crash the extension host when no dedicated error listener exists.
  const backendError = waitFor(backend, "event",
    (event) => event.type === "error" && event.message === "synthetic backend error");
  backend.send({ type: "backend_error" });
  await backendError;
  const reserved = [];
  const onUniversal = (event) => {
    if (event.message?.startsWith("must ")) reserved.push(event.type);
  };
  backend.on("event", onUniversal);
  backend.send({ type: "reserved_event" });
  await waitFor(backend, "event", (event) => event.type === "newListener"
    && event.message === "must not reach EventEmitter internals");
  backend.off("event", onUniversal);
  assert.deepEqual(reserved, ["event", "newListener"],
    "reserved protocol names must each use the universal channel exactly once");
  const stillAlive = waitFor(backend, "echo", (event) => event.command.type === "ping");
  backend.send({ type: "ping" });
  await stillAlive;

  const exited = waitFor(backend, "exit", (code) => code === 7);
  backend.send({ type: "crash" });
  await exited;
  const restarted = waitFor(backend, "echo",
    (event) => event.command.type === "prompt" && event.command.text === "after restart");
  assert.equal(backend.send({ type: "prompt", text: "after restart" }), true);
  await restarted;
  assert.equal(backend.ready, true);
  backend.dispose();
});

test("backend preserves FIFO under real stdin backpressure and bounds its queue", async () => {
  const delayed = executable("delayed-reader-backend", `
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
send({ type: "ready", protocol_version: ${DGC_PROTOCOL_VERSION}, model: "fixture" });
setTimeout(() => {
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const cmd = JSON.parse(line);
    if (cmd.type === "shutdown") process.exit(0);
    send({ type: "echo", sequence: cmd.sequence });
  });
}, 150);`);
  const backend = new DgcBackend(scratch, delayed);
  const echoes = [];
  backend.on("ready", () => backend.completeHandshake());
  backend.on("echo", (event) => echoes.push(event.sequence));
  backend.start();
  await waitFor(backend, "ready");
  const payload = "x".repeat(32 * 1024);
  for (let sequence = 0; sequence < 48; sequence += 1) {
    assert.equal(backend.send({ type: "bulk", sequence, payload }), true);
  }
  await waitFor(backend, "echo", (event) => event.sequence === 47, 5000);
  assert.deepEqual(echoes, Array.from({ length: 48 }, (_, index) => index));
  backend.dispose();

  const blocked = executable("blocked-reader-backend", `
process.stdout.write(JSON.stringify({ type: "ready", protocol_version: ${DGC_PROTOCOL_VERSION} }) + "\\n");
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
  for (let sequence = 0; sequence < 180; sequence += 1) {
    accepted.push(bounded.send({ type: "bulk", sequence, payload }));
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
  assert.equal(validator.send({ type: "prompt", text: "x".repeat(1024 * 1024) }), false);
  assert.deepEqual(rejected.map((event) => event.type), ["command_rejected", "command_rejected"]);
  backend.dispose();
  validator.dispose();
});
