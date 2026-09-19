/**
 * Hermetic per-OS proof of the Node SDK, installed from its packed tarball into a scratch project.
 *
 *   DGC_PYTHON=<venv python with the CLI> node tests/sdk_platform_smoke.mjs <path/to/package.tgz>
 *
 * Covers a run, a custom tool (typed DGCUnsupportedError on Windows), a policy denial, a cancel,
 * and cleanup (no dgc serve / bridge process outlives close()). Loopback mock model, no network.
 * Portable on purpose: no `mkdir -p`, no `#!/bin/sh` fixtures, npm spawned through a shell on
 * Windows (Node >= 18.20.2 refuses to spawn .cmd files without one: CVE-2024-27980).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const WIN = process.platform === "win32";
const tarball = resolve(process.argv[2] || "");
if (!existsSync(tarball)) throw new Error(`usage: node sdk_platform_smoke.mjs <package.tgz> (got ${tarball})`);
const PY = process.env.DGC_PYTHON;
if (!PY) throw new Error("set DGC_PYTHON to the venv python that has the dgc CLI installed");

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? `  -- ${detail}` : ""}`);
}

// ---- mock model -----------------------------------------------------------------------------
const sse = (delta, finish = null) => "data: " + JSON.stringify({ id: "mock", object: "chat.completion.chunk",
  choices: [{ index: 0, delta, finish_reason: finish }] }) + "\n\n";
const answer = (text) => sse({ content: text }) + sse({}, "stop") + "data: [DONE]\n\n";
const call = (name, args) => sse({ tool_calls: [{ index: 0, id: "call_1", type: "function",
  function: { name, arguments: JSON.stringify(args) } }] }) + sse({}, "tool_calls") + "data: [DONE]\n\n";
let behavior = "text";
const server = createServer((req, res) => {
  if (req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "sdk-model" }] }));
    return;
  }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const messages = (JSON.parse(Buffer.concat(chunks).toString() || "{}").messages) || [];
    const last = messages.at(-1) || {};
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (behavior === "stall") {
      for (let i = 0; i < 60 && !res.destroyed; i++) {
        res.write(": keepalive\n\n");
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!res.destroyed) res.end(answer("late"));
      return;
    }
    if (last.role === "tool") return res.end(answer(behavior === "tool" ? "Widget is in stock." : "Done."));
    if (behavior === "tool") return res.end(call("mcp__app__sku_lookup", { sku: "A-1" }));
    if (behavior === "edit") return res.end(call("write_file", { path: "guard.py", content: "ok\n" }));
    res.end(answer("The checkout flow creates an empty cart and then redirects."));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;

// ---- process table (no dependencies) ---------------------------------------------------------
function processTable() {
  const table = new Map();
  if (WIN) {
    const out = execFileSync("powershell", ["-NoProfile", "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress"],
      { encoding: "utf8" });
    for (const row of JSON.parse(out || "[]")) table.set(Number(row.ProcessId), Number(row.ParentProcessId));
  } else {
    for (const line of execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" }).split("\n")) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      if (pid) table.set(pid, ppid);
    }
  }
  return table;
}
function descendants(root) {
  const table = processTable();
  const found = new Set();
  let frontier = new Set([root]);
  while (frontier.size) {
    const next = new Set();
    for (const [pid, ppid] of table) if (frontier.has(ppid) && !found.has(pid)) { found.add(pid); next.add(pid); }
    frontier = next;
  }
  return found;
}

// ---- install the tarball the way a user does -------------------------------------------------
const scratch = mkdtempSync(join(tmpdir(), "dgc-sdk-smoke-"));
const app = join(scratch, "app");
mkdirSync(app);
writeFileSync(join(app, "package.json"), JSON.stringify({ name: "sdk-consumer", private: true, type: "module" }));
const npm = spawnSync(WIN ? "npm.cmd" : "npm", ["install", "--offline", "--no-save", "--no-audit", "--no-fund", tarball],
  { cwd: app, encoding: "utf8", shell: WIN });
check("npm install <tarball> into a scratch project", npm.status === 0, npm.stderr);
// Find the installed package name without shelling out to `tar` (bsdtar on Windows chokes on the
// backslash tarball path). npm >= 7 writes node_modules/.package-lock.json; the one non-nested
// node_modules/* entry is the package we just installed.
function installedPackageName(appDir) {
  const lock = JSON.parse(readFileSync(join(appDir, "node_modules", ".package-lock.json"), "utf8"));
  const key = Object.keys(lock.packages || {}).find((k) =>
    k.startsWith("node_modules/") && !k.slice("node_modules/".length).includes("node_modules/"));
  if (!key) throw new Error("no installed package found in node_modules/.package-lock.json");
  return key.slice("node_modules/".length);
}
const pkgName = installedPackageName(app);
const pkg = JSON.parse(readFileSync(join(app, "node_modules", ...pkgName.split("/"), "package.json"), "utf8"));
const sdk = await import(pathToFileURL(join(app, "node_modules", ...pkg.name.split("/"), pkg.exports["."].import)).href);
const { DGC, defineTool } = sdk;

const work = mkdtempSync(join(tmpdir(), "dgc-sdk-smoke-work-"));
writeFileSync(join(work, "README.md"), "empty cart checkout\n");
const perms = { mode: "auto", unhandled: "deny" };
const tracked = new Set();
const client = (extra = {}) => new DGC({
  stateDir: mkdtempSync(join(tmpdir(), "dgc-sdk-smoke-state-")), model: "sdk-model", baseUrl,
  apiKey: "sk-local", runtime: [PY, "-m", "dgc", "serve"], ...extra,
});
const track = (session) => {
  const pid = session.transport?.pid;
  if (pid) { tracked.add(pid); for (const d of descendants(pid)) tracked.add(d); }
};

// Each section is guarded: an exception is recorded as a FAIL and the next section still runs,
// so one early crash (e.g. on Windows) cannot hide what the later sections would have shown.
async function section(name, body) {
  try {
    await body();
  } catch (error) {
    console.log(String(error?.stack || error).split("\n").slice(0, 6).join("\n"));
    check(`${name}: raised`, false, `${error?.name || "Error"}: ${String(error?.message || error).slice(0, 400)}`);
  }
}
async function closeQuietly(dgc) {
  try { await dgc.close(); } catch (error) { check("close() raised", false, String(error)); }
}

try {
  await section("1 run", async () => {
    behavior = "text";
    const dgc = client();
    try {
      const session = await dgc.session({ cwd: work, permissions: perms });
      check("session handshake (ready) completes", true);
      track(session);
      const result = await session.run("Summarize README. Do not edit files.", { timeoutMs: 120_000 });
      check("run completes", result.status === "completed", result.status);
      check("run returns the model text", /checkout/i.test(result.finalText), result.finalText);
    } finally { await closeQuietly(dgc); }
  });

  await section("2 custom tool", async () => {
    behavior = "tool";
    const seen = [];
    const tool = defineTool("sku_lookup", "Look up a SKU", { type: "object", properties: { sku: { type: "string" } } },
      (args) => { seen.push(args.sku); return { name: "Widget" }; });
    const dgc = client();
    try {
      const session = await dgc.session({ cwd: work, permissions: perms, tools: [tool] });
      track(session);
      const result = await session.run("look up sku A-1", { timeoutMs: 120_000 });
      track(session);
      check("custom tool handler ran", seen[0] === "A-1", JSON.stringify(seen));
      check("custom tool result reached the model", /widget/i.test(result.finalText), result.finalText);
    } catch (error) {
      check("custom tools refuse with DGCUnsupportedError on this platform",
        WIN && error?.name === "DGCUnsupportedError", String(error));
    } finally { await closeQuietly(dgc); }
  });

  await section("3 policy denial", async () => {
    behavior = "edit";
    const dgc = client({ sandbox: "preferred", policy: { denyTools: ["write_file", "edit_file", "apply_patch"] } });
    try {
      const session = await dgc.session({ cwd: work, permissions: { mode: "default", unhandled: "deny" },
        onPermission: async () => "once" });
      track(session);
      const result = await session.run("edit the checkout guard", { timeoutMs: 120_000 });
      check("policy denial leaves the workspace untouched", !existsSync(join(work, "guard.py")));
      check("policy denial is reported, run still completes", result.status === "completed", result.status);
    } finally { await closeQuietly(dgc); }
  });

  await section("4 cancel", async () => {
    behavior = "stall";
    const dgc = client();
    try {
      const session = await dgc.session({ cwd: work, permissions: perms });
      track(session);
      const handle = session.stream("Summarize README.", { timeoutMs: 30_000 });
      const drained = handle.result();
      await new Promise((r) => setTimeout(r, 1000));
      const started = Date.now();
      session.cancel();
      const result = await drained;
      check("cancel ends the run", ["cancelled", "failed"].includes(result.status), result.status);
      check("cancel settles within 10s", Date.now() - started < 10_000, `${Date.now() - started}ms`);
      behavior = "text";
      const again = await session.run("Summarize README. Do not edit files.", { timeoutMs: 120_000 });
      check("session is reusable after cancel", again.status === "completed", again.status);
    } finally { await closeQuietly(dgc); }
  });

  await section("5 cleanup", async () => {
    const deadline = Date.now() + 10_000;
    let survivors = [...tracked].filter((pid) => processTable().has(pid));
    while (survivors.length && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      const table = processTable();
      survivors = survivors.filter((pid) => table.has(pid));
    }
    check("no dgc serve / bridge process outlives close()", tracked.size > 0 && survivors.length === 0,
      `tracked=${[...tracked]} survivors=${survivors}`);
  });
} finally {
  server.close();
}
const failed = results.filter((r) => !r.ok).map((r) => r.name);
console.log(`M0-RESULT node-smoke platform=${process.platform} node=${process.version} ` +
  `passed=${results.length - failed.length} failed=${failed.length}`);
console.log(JSON.stringify({ platform: process.platform, node: process.version, package: pkg.name,
  version: pkg.version, passed: results.length - failed.length, failed }));
process.exit(failed.length ? 1 : 0);
