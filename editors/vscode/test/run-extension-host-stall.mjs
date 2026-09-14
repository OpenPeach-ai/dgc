// Installed-host proof that a silent model request reaches the editor as a waiting notice.
//
// Unlike run-extension-host.mjs (a fixture backend), this drives the REAL `dgc serve` from this
// checkout against a local model server that accepts the request and never answers. It proves the
// whole chain in a real VS Code: the CLI's stall watcher emits `turn_activity` ("No response from
// the model" · "<model> at <host> · no reply for …"), the extension forwards it to the webview, and
// the turn then ends with an error instead of hanging.
//
// Needs an installed VS Code (DGC_VSCODE_EXECUTABLE or /usr/share/code/code), the extension built
// (`npm run compile`), and a Python that can import this checkout's dgc (DGC_TEST_PYTHON, default
// python3). Everything it writes -- HOME, profile, workspace -- lives in one scratch directory.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(here, "..");
const repoRoot = resolve(extensionRoot, "..", "..");
const testsPath = join(here, "extension-host", "stall.cjs");
const scratch = mkdtempSync(join(tmpdir(), "dgc-vscode-stall-"));
const home = join(scratch, "home");
const workspacePath = join(scratch, "workspace");
const userDataDir = join(scratch, "user-data");
const resultPath = join(scratch, "result.json");
const wrapperPath = join(scratch, "dgc-real");
const python = process.env.DGC_TEST_PYTHON || "python3";
const testToken = randomUUID();
const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

if (!existsSync(join(extensionRoot, "dist", "extension.js"))) {
  throw new Error("build the extension first (npm run compile): dist/extension.js is missing");
}

// A model server that accepts every chat request and never sends a byte back.
const requests = [];
const server = createServer((req, res) => {
  if (req.method === "POST" && req.url.endsWith("/chat/completions")) {
    const record = { url: req.url, at: Date.now(), closedAt: 0 };
    requests.push(record);
    req.resume();
    req.socket.on("close", () => { record.closedAt = Date.now(); });
    return;                       // no headers, no body: the llama.cpp-during-prefill shape
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end("{}");
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const port = server.address().port;

try {
  mkdirSync(join(home, ".dgc"), { recursive: true });
  mkdirSync(workspacePath);
  mkdirSync(join(userDataDir, "User"), { recursive: true });
  writeFileSync(join(home, ".dgc", "config.json"), JSON.stringify({
    base_url: `http://127.0.0.1:${port}/v1`, model: "stall-model", suggest: false,
    artifact_autostart: false, model_first_token_timeout_s: 3, model_stall_notice_s: 0.5,
    model_stall_retries: 0,
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

  // Asynchronous on purpose: the silent model server above lives on this event loop.
  const status = await new Promise((done, fail) => {
    const child = spawn(executable, args, { cwd: extensionRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => { child.kill("SIGKILL"); fail(new Error("VS Code stall test timed out")); }, 150_000);
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("error", (error) => { clearTimeout(timer); fail(error); });
    child.on("exit", (code) => { clearTimeout(timer); done(code); });
  });
  if (status !== 0) throw new Error(`VS Code extension-host stall test exited with ${status}`);
  if (!existsSync(resultPath)) throw new Error("VS Code exited without running the stall test module");
  const evidence = JSON.parse(readFileSync(resultPath, "utf8"));
  const notice = evidence.notice || {};
  const expectedDetail = `stall-model at 127.0.0.1:${port} · no reply for 0.5s+`;
  if (evidence.activated !== true || notice.state !== "waiting"
      || notice.label !== "No response from the model" || notice.detail !== expectedDetail
      || evidence.errorAfterNotice !== true || evidence.turnEnded !== true) {
    throw new Error("stall evidence was incomplete: " + JSON.stringify(evidence));
  }
  if (requests.length !== 1 || !requests[0].closedAt) {
    throw new Error(`expected exactly one abandoned-and-closed model request, saw ${JSON.stringify(requests)}`);
  }
  const closedAfter = (requests[0].closedAt - requests[0].at) / 1000;
  process.stdout.write(`DGC extension-host stall test passed in ${evidence.appName} ${evidence.vscodeVersion}: `
    + `"${notice.label} · ${notice.detail}" reached the webview; the silent request was closed after `
    + `${closedAfter.toFixed(1)}s and the turn ended with an error\n`);
} finally {
  server.close();
  server.closeAllConnections?.();
  if (process.env.DGC_KEEP_EXTENSION_TEST === "true") {
    process.stderr.write(`DGC extension-host stall scratch retained at ${scratch}\n`);
  } else {
    // The backend VS Code just stopped can still be flushing its session files into HOME.
    rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
