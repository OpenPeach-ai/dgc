// Installed-host proof that model reconnects reach the editor as retry runs.
//
// Drives the REAL `dgc serve` from this checkout inside a real VS Code against an in-process model
// server that misbehaves on purpose:
//   1. the first request of prompt one is dropped before any response (the backend retries, then
//      the retry is answered): the webview must receive model_retry "retrying" then "recovered" on
//      one retry id, with no protocol failure or backend exit;
//   2. prompt two's stream is cut after one delta (no [DONE]): a continuation run, recovered;
//   3. the server is closed and a third prompt ends with an error whose cause.kind is "connect".
//
// Needs an installed VS Code (DGC_VSCODE_EXECUTABLE or /usr/share/code/code), the extension built
// (`node esbuild.js`), and a Python that can import this checkout's dgc (DGC_TEST_PYTHON; otherwise
// the interpreter behind `dgc` on PATH, then python3). Everything it writes lives in one scratch dir.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(here, "..");
const repoRoot = resolve(extensionRoot, "..", "..");
const testsPath = join(here, "extension-host", "reconnect.cjs");
const scratch = mkdtempSync(join(tmpdir(), "dgc-vscode-reconnect-"));
const home = join(scratch, "home");
const workspacePath = join(scratch, "workspace");
const userDataDir = join(scratch, "user-data");
const resultPath = join(scratch, "result.json");
const closeFlag = join(scratch, "close-model-server");
const wrapperPath = join(scratch, "dgc-real");
const testToken = randomUUID();
const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

function pickPython() {
  const candidates = [process.env.DGC_TEST_PYTHON];
  for (const dir of String(process.env.PATH || "").split(delimiter)) {
    const launcher = join(dir, "dgc");
    if (!dir || !existsSync(launcher)) continue;
    const first = readFileSync(launcher, "utf8").split("\n", 1)[0];
    if (first.startsWith("#!") && /python/.test(first)) candidates.push(first.slice(2).trim().split(/\s+/)[0]);
    break;
  }
  candidates.push("python3");
  for (const python of candidates.filter(Boolean)) {
    const probe = spawnSync(python, ["-c", "import requests, prompt_toolkit, rich"], { stdio: "ignore" });
    if (probe.status === 0) return python;
  }
  throw new Error("no Python with DGC's dependencies: set DGC_TEST_PYTHON");
}
const python = pickPython();

if (!existsSync(join(extensionRoot, "dist", "extension.js"))) {
  throw new Error("build the extension first (node esbuild.js): dist/extension.js is missing");
}

// ---- the misbehaving model server ----------------------------------------------------------------
const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const delta = (content, finish = null) => sse({ choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finish }] });
const seen = { dropped: 0, cut: 0, answered: 0 };
const server = createServer((req, res) => {
  if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end("{}");
    return;
  }
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = {}; }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const lastUser = [...messages].reverse().find((m) => m && m.role === "user");
    const text = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content || "");
    if (text.includes("reconnect-first") && seen.dropped === 0) {
      seen.dropped += 1;
      req.socket.destroy();                    // dropped before any response: a retried transport failure
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (text.includes("reconnect-second") && seen.cut === 0) {
      seen.cut += 1;
      res.write(delta("The first half "));
      setTimeout(() => res.socket?.end(), 50); // the stream ends without [DONE]
      return;
    }
    seen.answered += 1;
    res.end(delta("answered.") + delta("", "stop") + "data: [DONE]\n\n");
  });
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const port = server.address().port;
const flagWatch = setInterval(() => {
  if (existsSync(closeFlag) && server.listening) {
    server.close();
    server.closeAllConnections?.();
    writeFileSync(closeFlag + ".done", "closed");
  }
}, 100);

try {
  mkdirSync(join(home, ".dgc"), { recursive: true });
  mkdirSync(workspacePath);
  mkdirSync(join(userDataDir, "User"), { recursive: true });
  writeFileSync(join(home, ".dgc", "config.json"), JSON.stringify({
    base_url: `http://127.0.0.1:${port}/v1`, model: "reconnect-model", api_mode: "chat_completions",
    suggest: false, notes: false, artifact_autostart: false,
  }));
  writeFileSync(wrapperPath, [
    "#!/bin/sh",
    `export HOME=${shellQuote(home)} XDG_CONFIG_HOME=${shellQuote(home)} XDG_DATA_HOME=${shellQuote(home)} XDG_STATE_HOME=${shellQuote(home)}`,
    `export PYTHONPATH=${shellQuote(repoRoot)}`,
    `exec ${shellQuote(python)} -m dgc "$@"`,
    "",
  ].join("\n"));
  chmodSync(wrapperPath, 0o700);
  writeFileSync(join(userDataDir, "User", "settings.json"), JSON.stringify({
    "dgc.command": wrapperPath,
    "dgc.checkForUpdates": false,
  }));

  const configured = process.env.DGC_VSCODE_EXECUTABLE;
  const systemExecutable = "/usr/share/code/code";
  const executable = configured || (existsSync(systemExecutable) ? systemExecutable : "code");
  const args = [
    `--extensionDevelopmentPath=${extensionRoot}`,
    `--extensionTestsPath=${testsPath}`,
    `--user-data-dir=${userDataDir}`,
    `--extensions-dir=${join(scratch, "extensions")}`,
    "--disable-gpu", "--disable-dev-shm-usage", "--disable-updates", "--disable-telemetry",
    "--disable-crash-reporter", "--disable-extensions", "--use-inmemory-secretstorage",
    "--no-sandbox", "--disable-chromium-sandbox", "--skip-welcome", "--skip-release-notes",
    "--disable-workspace-trust",
  ];
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    args.push("--ozone-platform=headless");
  }
  args.push(workspacePath);

  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("VSCODE_")) delete env[key];
  }
  delete env.ELECTRON_RUN_AS_NODE;
  env.DGC_SELF_HOSTED = "false";
  env.DGC_EXTENSION_TEST_TOKEN = testToken;
  env.DGC_EXTENSION_TEST_RESULT = resultPath;
  env.DGC_RECONNECT_CLOSE_FLAG = closeFlag;

  // Asynchronous on purpose: the model server above lives on this event loop.
  const status = await new Promise((done, fail) => {
    const child = spawn(executable, args, { cwd: extensionRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => { child.kill("SIGKILL"); fail(new Error("VS Code reconnect test timed out")); }, 240_000);
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("error", (error) => { clearTimeout(timer); fail(error); });
    child.on("exit", (code) => { clearTimeout(timer); done(code); });
  });
  if (status !== 0) throw new Error(`VS Code extension-host reconnect test exited with ${status}`);
  if (!existsSync(resultPath)) throw new Error("VS Code exited without running the reconnect test module");
  const evidence = JSON.parse(readFileSync(resultPath, "utf8"));
  if (evidence.error) throw new Error("reconnect evidence: " + evidence.error);
  if (seen.dropped !== 1 || seen.cut !== 1) throw new Error("the fake server did not misbehave as planned: " + JSON.stringify(seen));
  process.stdout.write(`DGC extension-host reconnect test passed in ${evidence.appName} ${evidence.vscodeVersion}: `
    + `${evidence.summary}\n`);
} finally {
  clearInterval(flagWatch);
  if (server.listening) { server.close(); server.closeAllConnections?.(); }
  if (process.env.DGC_KEEP_EXTENSION_TEST === "true") {
    process.stderr.write(`DGC extension-host reconnect scratch retained at ${scratch}\n`);
  } else {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
