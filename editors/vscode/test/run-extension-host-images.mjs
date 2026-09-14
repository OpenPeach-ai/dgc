// Installed-host proof that a model-viewed image reaches the panel on a default setup.
//
// Drives the REAL `dgc serve` from this checkout in a real VS Code, with no dgc.* model settings: the
// backend reads its own config from a throwaway HOME. A scripted model asks the browser tool to open
// a local page and screenshot it; the screenshot must reach the webview as `tool_images`, its stored
// copy must come back through getImage, and Open file must open it. Two cases:
//   vision     the endpoint accepts images (the pixels reach the model after the batch)
//   text-only  the endpoint answers 400 "does not support image input": the turn still completes,
//              the chip still reaches the panel, and no later request carries an image.
//
// Needs an installed VS Code (DGC_VSCODE_EXECUTABLE or /usr/share/code/code), the extension built
// (`node esbuild.js`), a Python that can import this checkout's dgc (DGC_TEST_PYTHON, default
// python3) and a Chromium for the browser tool (DGC_TEST_BROWSER, else Playwright's cache).
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(here, "..");
const repoRoot = resolve(extensionRoot, "..", "..");
const testsPath = join(here, "extension-host", "images.cjs");
const python = process.env.DGC_TEST_PYTHON || "python3";
const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

if (!existsSync(join(extensionRoot, "dist", "extension.js"))) {
  throw new Error("build the extension first (node esbuild.js): dist/extension.js is missing");
}

function findBrowser() {
  if (process.env.DGC_TEST_BROWSER) return process.env.DGC_TEST_BROWSER;
  // Documented runs override HOME with a throwaway directory, so Playwright's cache is also looked
  // for under the invoking user's real home (what the operating system says, not $HOME).
  let realHome = "";
  try { realHome = userInfo().homedir; } catch { /* no passwd entry */ }
  const caches = [process.env.PLAYWRIGHT_BROWSERS_PATH, join(homedir(), ".cache", "ms-playwright"),
    realHome && join(realHome, ".cache", "ms-playwright")].filter(Boolean);
  for (const cache of [...new Set(caches)]) {
    const builds = existsSync(cache) ? readdirSync(cache).filter((name) => /^chromium-\d+$/.test(name))
      .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1])) : [];
    for (const build of builds) {
      for (const binary of ["chrome-linux/chrome", "chrome-linux64/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"]) {
        if (existsSync(join(cache, build, binary))) return join(cache, build, binary);
      }
    }
  }
  throw new Error("no Chromium for the browser tool: set DGC_TEST_BROWSER or install Playwright's chromium");
}
const browserPath = findBrowser();

// The page the browser tool screenshots.
const page = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(`<!doctype html><html><head><title>Images host page</title></head><body style="margin:0;font-family:sans-serif;
    background:linear-gradient(135deg,#6d28d9,#db2777);color:white"><h1 style="font-size:56px;margin:48px">Vibe DGC host page</h1></body></html>`);
});
await new Promise((ready) => page.listen(0, "127.0.0.1", ready));
const pageUrl = `http://127.0.0.1:${page.address().port}/`;

// One scripted model per route: /vision/v1 accepts images, /text-only/v1 refuses them.
const requests = [];
const imageParts = (body) => (body.messages || []).reduce((n, message) => n + (Array.isArray(message.content)
  ? message.content.filter((part) => part && (part.type === "image_url" || part.type === "input_image")).length : 0), 0);
const model = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => { raw += chunk; });
  req.on("end", () => {
    const json = (status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    const route = req.url.startsWith("/text-only/") ? "text-only" : "vision";
    if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) return json(404, { error: { message: "no route" } });
    const body = JSON.parse(raw || "{}");
    const record = { route, images: imageParts(body), tools: Array.isArray(body.tools),
      last: JSON.stringify(body.messages?.at(-1)?.content ?? "").slice(0, 120) };
    requests.push(record);
    if (route === "text-only" && record.images) {
      return json(400, { error: { message: "this model does not support image input (image_url is not allowed)" } });
    }
    const toolResults = (body.messages || []).filter((message) => message.role === "tool").length;
    const call = (id, args) => json(200, { choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: "",
      tool_calls: [{ id, type: "function", function: { name: "browser", arguments: JSON.stringify(args) } }] } }] });
    if (toolResults === 0) return call("call_open", { operation: "open", url: pageUrl });
    if (toolResults === 1) return call("call_shot", { operation: "screenshot" });
    return json(200, { choices: [{ index: 0, finish_reason: "stop",
      message: { role: "assistant", content: `The page shows the host banner (${record.images} image part${record.images === 1 ? "" : "s"} seen).` } }] });
  });
});
await new Promise((ready) => model.listen(0, "127.0.0.1", ready));
const modelPort = model.address().port;

async function runCase(name) {
  const scratch = mkdtempSync(join(tmpdir(), `dgc-vscode-images-${name}-`));
  const home = join(scratch, "home");
  const workspacePath = join(scratch, "workspace");
  const userDataDir = join(scratch, "user-data");
  const resultPath = join(scratch, "result.json");
  const wrapperPath = join(scratch, "dgc-real");
  const testToken = randomUUID();
  const before = requests.length;
  try {
    mkdirSync(join(home, ".dgc"), { recursive: true });
    mkdirSync(workspacePath);
    mkdirSync(join(userDataDir, "User"), { recursive: true });
    writeFileSync(join(home, ".dgc", "config.json"), JSON.stringify({
      base_url: `http://127.0.0.1:${modelPort}/${name}/v1`, model: `${name}-fixture`, api_mode: "chat_completions",
      mode: "auto", trusted_dirs: [workspacePath], browser_path: browserPath, browser_allow_unsandboxed: true,
      suggest: false, notes: false, artifact_autostart: false, setup_done: true,
    }));
    writeFileSync(wrapperPath, [
      "#!/bin/sh",
      `export HOME=${shellQuote(home)} XDG_CONFIG_HOME=${shellQuote(home)} XDG_DATA_HOME=${shellQuote(home)} XDG_STATE_HOME=${shellQuote(home)}`,
      `export PYTHONPATH=${shellQuote(repoRoot)} DGC_NO_UPDATE_CHECK=1`,
      `exec ${shellQuote(python)} -m dgc "$@"`,
      "",
    ].join("\n"));
    chmodSync(wrapperPath, 0o700);
    // No dgc.* model settings: the backend's own config is the whole setup.
    writeFileSync(join(userDataDir, "User", "settings.json"), JSON.stringify({
      "dgc.command": wrapperPath, "dgc.checkForUpdates": false,
    }));

    const executable = process.env.DGC_VSCODE_EXECUTABLE || (existsSync("/usr/share/code/code") ? "/usr/share/code/code" : "code");
    const args = [
      `--extensionDevelopmentPath=${extensionRoot}`, `--extensionTestsPath=${testsPath}`,
      `--user-data-dir=${userDataDir}`, `--extensions-dir=${join(scratch, "extensions")}`,
      "--disable-gpu", "--disable-dev-shm-usage", "--disable-updates", "--disable-telemetry",
      "--disable-crash-reporter", "--disable-extensions", "--use-inmemory-secretstorage",
      "--no-sandbox", "--disable-chromium-sandbox", "--skip-welcome", "--skip-release-notes",
      "--disable-workspace-trust",
    ];
    if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) args.push("--ozone-platform=headless");
    args.push(workspacePath);
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith("VSCODE_")) delete env[key];
    delete env.ELECTRON_RUN_AS_NODE;
    // The editor host and the backend share this HOME, so Open file sees the same ~/.dgc/sessions.
    env.HOME = home;
    env.DGC_SELF_HOSTED = "false";
    env.DGC_EXTENSION_TEST_TOKEN = testToken;
    env.DGC_EXTENSION_TEST_RESULT = resultPath;
    env.DGC_IMAGES_CASE = name;
    env.DGC_IMAGES_PAGE = pageUrl;
    env.DGC_IMAGES_HOME = home;
    const status = await new Promise((done, fail) => {
      const child = spawn(executable, args, { cwd: extensionRoot, env, stdio: ["ignore", "pipe", "pipe"] });
      const timer = setTimeout(() => { child.kill("SIGKILL"); fail(new Error(`VS Code images test (${name}) timed out`)); }, 240_000);
      child.stdout.on("data", (chunk) => process.stdout.write(chunk));
      child.stderr.on("data", (chunk) => process.stderr.write(chunk));
      child.on("error", (error) => { clearTimeout(timer); fail(error); });
      child.on("exit", (code) => { clearTimeout(timer); done(code); });
    });
    if (status !== 0) throw new Error(`VS Code extension-host images test (${name}) exited with ${status}`);
    if (!existsSync(resultPath)) throw new Error(`VS Code exited without running the images test module (${name})`);
    const evidence = JSON.parse(readFileSync(resultPath, "utf8"));
    const seen = requests.slice(before);
    const withImages = seen.filter((request) => request.images > 0).length;
    const lastImage = seen.map((request) => request.images > 0).lastIndexOf(true);
    const secondTurn = seen.findIndex((request) => request.last.includes("thanks, anything else"));
    const problems = [];
    if (evidence.activated !== true) problems.push("the extension did not activate");
    if (!(evidence.toolImages >= 1)) problems.push("tool_images never reached the webview");
    if (evidence.turnEnds < 2) problems.push("both turns must end");
    if (evidence.imageAnswered !== true) problems.push("getImage was not answered with bytes");
    if (evidence.opened !== true) problems.push("Open file did not open the stored screenshot");
    if (!seen.every((request) => request.tools)) problems.push("a request lost its native tools");
    if (secondTurn < 0) problems.push("the second turn never reached the model");
    if (name === "vision") {
      if (withImages < 1) problems.push("the vision model never received the screenshot");
    } else {
      if (withImages !== 1) problems.push(`exactly one request may carry the image, saw ${withImages}`);
      if (secondTurn >= 0 && secondTurn < lastImage) problems.push("the next turn still sent the image");
      if (secondTurn >= 0 && seen[secondTurn].images !== 0) problems.push("the next turn's request carries an image");
    }
    if (problems.length) throw new Error(`images evidence (${name}) failed: ${problems.join("; ")}\n${JSON.stringify({ evidence, seen }, null, 1)}`);
    process.stdout.write(`DGC extension-host images test (${name}) passed in ${evidence.appName} ${evidence.vscodeVersion}: `
      + `${evidence.toolImages} tool_images frame(s) reached the panel, ${seen.length} model requests, ${withImages} with an image\n`);
  } finally {
    if (process.env.DGC_KEEP_EXTENSION_TEST === "true") process.stderr.write(`DGC images scratch (${name}) retained at ${scratch}\n`);
    else rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

try {
  await runCase("vision");
  await runCase("text-only");
} finally {
  page.close(); page.closeAllConnections?.();
  model.close(); model.closeAllConnections?.();
}
