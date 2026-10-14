// Hidden WSL through the real DgcBackend: `dgc serve` started by wsl.exe's arguments, every frame's paths translated
// on the wire (never the caller's objects), and a distro that isn't set up said once instead of restarted into.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "dgc-hidden-wsl-backend-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const load = async (name) => {
  const outfile = join(scratch, `${name}.cjs`);
  await build({ entryPoints: [join(here, `../src/${name}.ts`)], bundle: true, format: "cjs", platform: "node",
    target: "node18", outfile, logLevel: "silent" });
  return createRequire(import.meta.url)(outfile);
};
const { DgcBackend, DGC_PROTOCOL_VERSION } = await load("backend");
const { launch } = await load("wslHost");
const { bridge } = await load("wslBridge");
const { pathMap } = await load("wslPaths");

function executable(name, body) {
  const path = join(scratch, name);
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`, "utf8");
  chmodSync(path, 0o700);
  return path;
}

const until = (emitter, name, predicate = () => true, timeout = 4000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { emitter.off(name, handler); reject(new Error(`timed out waiting for ${name}`)); }, timeout);
  const handler = (...values) => {
    if (!predicate(...values)) return;
    clearTimeout(timer);
    emitter.off(name, handler);
    resolve(values);
  };
  emitter.on(name, handler);
});

/** A stand-in for wsl.exe running `dgc serve` in the distro: it records its argv, and names paths as Linux does. */
const fakeWsl = executable("wsl-serve", `
const readline = require("node:readline");
require("node:fs").writeFileSync(${JSON.stringify(join(scratch, "argv.json"))}, JSON.stringify(process.argv.slice(2)));
let seq = 0;
const send = (value) => process.stdout.write(JSON.stringify({ seq: seq++, ...value }) + "\\n");
setTimeout(() => send({ type: "ready", version: "fixture", protocol_version: ${DGC_PROTOCOL_VERSION},
  capabilities: { image_spool_dir: "/home/dgc/.dgc/spool/images" }, model: "fixture", mode: "default", think: "off",
  base_url: "http://127.0.0.1:1/v1", workspace_trusted: true, project_root: "/mnt/c/Users/Me/proj",
  commands: [], custom_commands: [], goal: { text: "", status: "none" }, context_size: 32768 }), 20);
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const cmd = JSON.parse(line);
  if (cmd.type === "shutdown") process.exit(0);
  send({ type: "info", message: "echo:" + JSON.stringify(cmd) });
});`);

const route = (command, notSetUp = () => false) => ({
  launch: (cwd, args) => ({ ...launch("DGC", cwd, args, { SystemRoot: "C:\\Windows", PATH: process.env.PATH }), command }),
  bridge: bridge(pathMap("DGC")),
  notSetUp,
});

test("dgc serve starts through wsl.exe in DGC's distro, and its paths are Windows paths to the editor", async () => {
  const backend = new DgcBackend("C:\\Users\\Me\\proj", "dgc", undefined, route(fakeWsl));
  const events = [];
  backend.on("event", (event) => events.push(event));
  backend.start();
  await until(backend, "event", (event) => event.type === "ready");
  assert.deepEqual(JSON.parse(readFileSync(join(scratch, "argv.json"), "utf8")),
    ["-d", "DGC", "--cd", "C:\\Users\\Me\\proj", "--exec", "/home/dgc/.local/bin/dgc", "serve"]);
  const ready = events.find((event) => event.type === "ready");
  assert.equal(ready.project_root, "C:\\Users\\Me\\proj");
  assert.equal(ready.capabilities.image_spool_dir, "\\\\wsl.localhost\\DGC\\home\\dgc\\.dgc\\spool\\images");

  const command = { type: "set_workspace_roots", roots: [ready.project_root, "D:\\data"] };
  assert.equal(backend.sendSetup(command), true);
  const [echo] = await until(backend, "event", (event) => event.type === "info" && event.message.startsWith("echo:"));
  assert.deepEqual(JSON.parse(echo.message.slice(5)).roots, ["/mnt/c/Users/Me/proj", "/mnt/d/data"], "on the wire");
  assert.deepEqual(command.roots, ["C:\\Users\\Me\\proj", "D:\\data"], "the caller's object is untouched");
  backend.completeHandshake();
  backend.send({ type: "shutdown" });
  await until(backend, "exit");
});

test("a distro that isn't set up is said once, as a missing CLI is, and not restarted into", async () => {
  const missing = executable("wsl-missing", `
process.stderr.write("There is no distribution with the supplied name.\\r\\nError code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND\\r\\n");
process.exit(1);`);
  const seen = [];
  const backend = new DgcBackend("C:\\proj", "dgc", undefined, route(missing, (text) => /WSL_E_DISTRO_NOT_FOUND/.test(text) && (seen.push(text), true)));
  const events = [];
  backend.on("event", (event) => events.push(event));
  backend.start();
  const [, , info] = await until(backend, "exit");
  const error = events.find((event) => event.type === "error");
  assert.ok(error && error.notInstalled === true && error.wsl === true && error.fatal === true, JSON.stringify(events));
  assert.match(error.message, /isn't set up yet/);
  assert.equal(info.cause, "DGC is not set up in WSL", "the panel treats it as handled: no restart loop");
  assert.match(seen[0], /no distribution with the supplied name/);
});

test("any other early exit is an ordinary backend death", async () => {
  const broken = executable("wsl-broken", `process.stderr.write("Traceback: boom\\n"); process.exit(1);`);
  const backend = new DgcBackend("C:\\proj", "dgc", undefined, route(broken, (text) => /WSL_E_/.test(text)));
  const events = [];
  backend.on("event", (event) => events.push(event));
  backend.start();
  const [code, , info] = await until(backend, "exit");
  assert.equal(code, 1);
  assert.equal(info.cause, undefined);
  assert.equal(events.some((event) => event.notInstalled), false);
});

test("WSL 3 says 'no distribution' on stdout, before any protocol: that is 'not set up', not a protocol failure", async () => {
  const said = join(here, "fixtures", "wsl", "no-distro.stdout.utf8.bin");
  const stdoutMissing = executable("wsl-no-distro", `
process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(said)}));
process.exit(255);`);
  const { notSetUp } = await load("wslHost");
  const backend = new DgcBackend("C:\\proj", "dgc", undefined, route(stdoutMissing, notSetUp));
  const events = [];
  const stderr = [];
  backend.on("event", (event) => events.push(event));
  backend.on("stderr", (line) => stderr.push(line));
  backend.start();
  const [, , info] = await until(backend, "exit");
  assert.equal(events.some((event) => /malformed NDJSON/.test(event.message || "")), false, JSON.stringify(events));
  assert.ok(events.some((event) => event.type === "error" && event.notInstalled && event.wsl));
  assert.equal(info.cause, "DGC is not set up in WSL");
  assert.match(stderr.join("\n"), /There is no distribution with the supplied name/, "shown in the backend log");
});

test("after ready, a line that isn't JSON is still a protocol failure", async () => {
  const noisy = executable("wsl-noisy", `
let seq = 0;
const send = (value) => process.stdout.write(JSON.stringify({ seq: seq++, ...value }) + "\\n");
send({ type: "ready", version: "fixture", protocol_version: ${DGC_PROTOCOL_VERSION}, capabilities: {}, model: "m", mode: "default",
  think: "off", base_url: "http://127.0.0.1:1/v1", workspace_trusted: true, commands: [], custom_commands: [],
  goal: { text: "", status: "none" }, context_size: 32768 });
setTimeout(() => process.stdout.write("not json\\n"), 30);
setInterval(() => {}, 1000);`);
  const backend = new DgcBackend("C:\\proj", "dgc", undefined, route(noisy));
  const events = [];
  backend.on("event", (event) => events.push(event));
  backend.start();
  await until(backend, "event", (event) => event.type === "error" && /malformed NDJSON/.test(event.message || ""), 4000).catch(() => {});
  backend.dispose?.();
  try { backend.stop?.(); } catch { /* gone */ }
  assert.ok(events.some((event) => /malformed NDJSON/.test(event.message || "")), JSON.stringify(events.map((e) => e.type)));
});
