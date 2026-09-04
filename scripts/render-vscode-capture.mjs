#!/usr/bin/env node
/**
 * Record the actual DGC extension in VS Code 1.107.1 using a deterministic protocol fixture.
 *
 * The browser surface is real: a disposable VS Code profile loads the checksum-verified packaged
 * self-hosted VSIX after proving its editor source is unchanged through the current HEAD. The
 * prompt is entered through its webview, and Playwright clicks its real plan approval button.
 * The deterministic fixture backend performs the shown file edit and test. This is not a live
 * model session and the public caption must continue to say so.
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionRoot = join(root, "editors", "vscode");
const backendSource = join(root, "scripts", "fixtures", "vscode-capture-backend.cjs");
const extensionPackage = join(root, "site", "vscode", "dgc.vsix");
const extensionPackageChecksum = join(root, "site", "vscode", "dgc.vsix.sha256");
const extensionVersionMetadata = join(root, "site", "vscode", "version.json");
const defaultCode = "/usr/share/code/code";
const viewport = { width: 1440, height: 900 };
const minimumSeconds = 30;
const targetLongSeconds = 32;
const maximumFlowMs = 45_000;
const prompt = "Fix clamp.py with the smallest safe change and verify every regression test.";

const options = { keepWork: false, code: defaultCode, outputDir: join(root, "site", "assets") };
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index];
  if (arg === "--keep-work") options.keepWork = true;
  else if (arg === "--code") options.code = resolve(process.argv[++index] || "");
  else if (arg === "--output-dir") options.outputDir = resolve(process.argv[++index] || "");
  else throw new Error(`unknown argument: ${arg}`);
}

function run(command, args, settings = {}) {
  const result = spawnSync(command, args, {
    cwd: settings.cwd || root,
    env: settings.env || process.env,
    encoding: "utf8",
    timeout: settings.timeout || 120_000,
    stdio: settings.stdio || "pipe",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited ${result.status}\n${result.stdout || ""}${result.stderr || ""}`);
  }
  return result;
}

function requireInputs() {
  for (const path of [options.code, backendSource, extensionPackage, extensionPackageChecksum,
    extensionVersionMetadata]) {
    if (!existsSync(path)) throw new Error(`missing capture input: ${path}`);
  }
  for (const command of ["Xvfb", "ffmpeg", "ffprobe", "git", "python3", "unzip"]) {
    if (spawnSync("which", [command], { stdio: "ignore" }).status !== 0) {
      throw new Error(`missing capture tool: ${command}`);
    }
  }
  const executable = realpathSync(options.code);
  const roots = [dirname(executable), resolve(dirname(executable), "..")];
  for (const productRoot of roots) {
    const productPath = join(productRoot, "resources", "app", "product.json");
    const cli = join(productRoot, "bin", "code");
    if (!existsSync(productPath) || !existsSync(cli)) continue;
    const version = JSON.parse(readFileSync(productPath, "utf8")).version || "";
    if (version !== "1.107.1") {
      throw new Error(`the reviewed capture requires VS Code 1.107.1, found ${version || "unknown"}`);
    }
    return { cli, version };
  }
  throw new Error("could not verify the supplied VS Code executable from adjacent product metadata");
}

function verifyExtensionPackage() {
  const actualSha256 = createHash("sha256").update(readFileSync(extensionPackage)).digest("hex");
  const declaredSha256 = readFileSync(extensionPackageChecksum, "utf8").trim().split(/\s+/, 1)[0];
  const publicMetadata = JSON.parse(readFileSync(extensionVersionMetadata, "utf8"));
  const buildMetadata = JSON.parse(run("unzip", ["-p", extensionPackage,
    "extension/dist/build.json"]).stdout);
  const packageMetadata = JSON.parse(run("unzip", ["-p", extensionPackage,
    "extension/package.json"]).stdout);
  if (actualSha256 !== declaredSha256 || publicMetadata.version !== packageMetadata.version
      || buildMetadata.version !== packageMetadata.version || buildMetadata.flavor !== "selfhost"
      || !/^[0-9a-f]{40}$/.test(buildMetadata.source_commit || "")) {
    throw new Error("local VSIX provenance does not match its checksum/version metadata");
  }
  run("git", ["diff", "--quiet", `${buildMetadata.source_commit}..HEAD`, "--", "editors/vscode"]);
  run("git", ["diff", "--quiet", "--", "editors/vscode"]);
  run("git", ["diff", "--cached", "--quiet", "--", "editors/vscode"]);
  const untracked = run("git", ["ls-files", "--others", "--exclude-standard", "--",
    "editors/vscode"]).stdout.trim();
  if (untracked) throw new Error("untracked editor-extension source prevents VSIX provenance proof");
  return { actualSha256, buildMetadata, packageMetadata };
}

function userStateSnapshot(rootPath) {
  const hash = createHash("sha256");
  if (!existsSync(rootPath)) return hash.update("missing").digest("hex");
  const visit = (path, relative) => {
    let stat;
    try { stat = lstatSync(path, { bigint: true }); }
    catch { hash.update(`vanished:${relative}\n`); return; }
    hash.update(`${relative}\0${stat.mode}\0${stat.size}\0${stat.mtimeNs}\0`);
    if (stat.isSymbolicLink()) hash.update(readlinkSync(path));
    else if (stat.isFile()) hash.update(readFileSync(path));
    else if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(path, name), `${relative}/${name}`);
    }
  };
  visit(rootPath, ".");
  return hash.digest("hex");
}

function writeFixture(workspace) {
  writeFileSync(join(workspace, "clamp.py"), [
    "def clamp(value, lower, upper):",
    '    """Keep value inside the inclusive lower/upper bounds."""',
    "    return min(lower, max(upper, value))",
    "",
  ].join("\n"));
  writeFileSync(join(workspace, "test_clamp.py"), [
    "import unittest",
    "",
    "from clamp import clamp",
    "",
    "",
    "class ClampTests(unittest.TestCase):",
    "    def test_inside_range_is_unchanged(self):",
    "        self.assertEqual(clamp(4, 0, 10), 4)",
    "",
    "    def test_values_below_lower_bound(self):",
    "        self.assertEqual(clamp(-3, 0, 10), 0)",
    "",
    "    def test_values_above_upper_bound(self):",
    "        self.assertEqual(clamp(18, 0, 10), 10)",
    "",
    "",
    "if __name__ == '__main__':",
    "    unittest.main()",
    "",
  ].join("\n"));
  run("git", ["init", "-q"], { cwd: workspace });
  run("git", ["add", "clamp.py", "test_clamp.py"], { cwd: workspace });
  run("git", ["-c", "user.name=DGC Capture", "-c", "user.email=capture@invalid",
    "commit", "-qm", "fixture"], { cwd: workspace });
}

function extensionSourceFingerprint() {
  const hash = createHash("sha256");
  const visit = (path, relative) => {
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(path, name), `${relative}/${name}`);
      return;
    }
    hash.update(`${relative}\0`);
    if (stat.isSymbolicLink()) hash.update(readlinkSync(path));
    else if (stat.isFile()) hash.update(readFileSync(path));
  };
  for (const name of ["esbuild.js", "media", "package.json", "src"]) {
    visit(join(extensionRoot, name), name);
  }
  return hash.digest("hex");
}

function chooseDisplay() {
  for (let number = 121; number < 150; number += 1) {
    if (!existsSync(`/tmp/.X${number}-lock`) && !existsSync(`/tmp/.X11-unix/X${number}`)) {
      return { display: `:${number}`, socket: `/tmp/.X11-unix/X${number}` };
    }
  }
  throw new Error("no free X display in :121..:149");
}

async function freePort() {
  return await new Promise((accept, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(); reject(new Error("could not allocate a debug port")); return;
      }
      server.close(error => error ? reject(error) : accept(address.port));
    });
  });
}

async function waitFor(check, failure, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) { lastError = error; }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error(`${failure}${lastError ? `: ${lastError.message || lastError}` : ""}`);
}

function safeEnvironment(display, statusPath) {
  const env = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" };
  if (process.env.XDG_RUNTIME_DIR) env.XDG_RUNTIME_DIR = process.env.XDG_RUNTIME_DIR;
  return {
    ...env,
    DISPLAY: display,
    DGC_CAPTURE_STATUS: statusPath,
    DGC_SELF_HOSTED: "false",
  };
}

function stopProcess(child, timeoutMs = 5000) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise(resolveStop => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveStop();
    };
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
      finish();
    }, timeoutMs);
    child.once("exit", finish);
    try { process.kill(-child.pid, "SIGTERM"); }
    catch {
      try { child.kill("SIGTERM"); }
      catch { finish(); }
    }
    if (child.exitCode !== null) finish();
  });
}

function captureState(statusPath) {
  try { return JSON.parse(readFileSync(statusPath, "utf8")); }
  catch { return {}; }
}

async function stopRecorder(recorder) {
  if (!recorder || recorder.exitCode !== null) return;
  recorder.stdin.write("q\n");
  await waitFor(() => recorder.exitCode !== null, "ffmpeg did not stop", 15_000);
  if (recorder.exitCode !== 0) throw new Error("ffmpeg screen recording failed");
}

function probe(path) {
  return JSON.parse(run("ffprobe", ["-v", "error", "-show_entries",
    "format=duration:stream=codec_name,width,height", "-of", "json", path]).stdout);
}

function mediaManifestRecord(outputDir, name) {
  const path = join(outputDir, name);
  const metadata = probe(path);
  const stream = metadata.streams?.[0] || {};
  const record = {
    path: `assets/${name}`,
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
    bytes: Number(lstatSync(path).size),
    codec: String(stream.codec_name || ""),
    width: Number(stream.width || 0),
    height: Number(stream.height || 0),
  };
  if (!name.endsWith(".jpg")) {
    record.duration_seconds = Number(Number(metadata.format?.duration || 0).toFixed(6));
  }
  return record;
}

function updateEditorManifest(outputDir, factor, codeProduct, verifiedPackage) {
  if (resolve(outputDir) !== resolve(root, "site", "assets")) return;
  const manifestPath = join(root, "site-src", "data", "capture-media.json");
  const payload = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (payload.schema_version !== 1 || !payload.captures || typeof payload.captures !== "object") {
    throw new Error("capture media manifest has an unsupported schema");
  }
  const files = {
    webm: mediaManifestRecord(outputDir, "editor-capture.webm"),
    mp4: mediaManifestRecord(outputDir, "editor-capture.mp4"),
    poster: mediaManifestRecord(outputDir, "editor-capture-poster.jpg"),
    preview: mediaManifestRecord(outputDir, "editor-capture-poster-720.jpg"),
  };
  const duration = Number(files.webm.duration_seconds);
  const rounded = Math.floor(duration + 0.5);
  const timing = Math.abs(factor - 1) < 0.0001
    ? "real time, no speed adjustment" : `${factor.toFixed(2)}× time-compressed`;
  payload.captures.editor = {
    kind: "actual_extension_deterministic_fixture",
    live_model: false,
    controlled_fixture: true,
    deterministic_fixture: true,
    real_time: Math.abs(factor - 1) < 0.0001,
    tool_sequence: ["read_file", "edit_file", "bash"],
    real_plan_button_click: true,
    visible_editor_matches_diff: true,
    source_unchanged_through_current_head: true,
    duration_seconds: duration,
    duration_label: `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`,
    provenance: `Actual extension surface · deterministic protocol fixture · real disposable-file edit and unittest run · not a live model session · ${timing}.`,
    vscode_version: codeProduct.version,
    extension_version: verifiedPackage.packageMetadata.version,
    packaged_extension_source_commit: verifiedPackage.buildMetadata.source_commit,
    extension_vsix_sha256: verifiedPackage.actualSha256,
    time_compression: Number(factor.toFixed(6)),
    files,
  };
  const temporary = `${manifestPath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`);
  renameSync(temporary, manifestPath);
}

function validateMedia(staged, publishedSeconds) {
  const expectations = [
    ["editor-capture.webm", "vp9"],
    ["editor-capture.mp4", "h264"],
  ];
  for (const [name, codec] of expectations) {
    const path = join(staged, name);
    const metadata = probe(path);
    const stream = metadata.streams?.[0] || {};
    const duration = Number(metadata.format?.duration);
    if (stream.codec_name !== codec || stream.width !== viewport.width
        || stream.height !== viewport.height || !Number.isFinite(duration)
        || Math.abs(duration - publishedSeconds) > 1.25) {
      throw new Error(`staged ${name} failed its codec, geometry or duration gate`);
    }
    run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", path, "-f", "null", "-"],
      { timeout: 300_000 });
  }
  const poster = probe(join(staged, "editor-capture-poster.jpg")).streams?.[0] || {};
  if (poster.codec_name !== "mjpeg" || poster.width !== viewport.width
      || poster.height !== viewport.height) {
    throw new Error("staged editor poster failed its codec or geometry gate");
  }
  run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i",
    join(staged, "editor-capture-poster.jpg"), "-frames:v", "1", "-f", "null", "-"]);
  const preview = probe(join(staged, "editor-capture-poster-720.jpg")).streams?.[0] || {};
  if (preview.codec_name !== "mjpeg" || preview.width !== 720 || preview.height !== 450
      || lstatSync(join(staged, "editor-capture-poster-720.jpg")).size > 50 * 1024) {
    throw new Error("staged editor preview failed its codec, geometry or 50 KiB gate");
  }
  run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i",
    join(staged, "editor-capture-poster-720.jpg"), "-frames:v", "1", "-f", "null", "-"]);
}

function promoteMedia(staged, outputDir) {
  const names = ["editor-capture.webm", "editor-capture.mp4", "editor-capture-poster.jpg",
    "editor-capture-poster-720.jpg"];
  const backup = join(dirname(staged), "previous-media");
  mkdirSync(outputDir, { recursive: true });
  mkdirSync(backup);
  const previous = [];
  const promoted = [];
  try {
    for (const name of names) {
      const destination = join(outputDir, name);
      if (existsSync(destination)) {
        renameSync(destination, join(backup, name));
        previous.push(name);
      }
    }
    for (const name of names) {
      renameSync(join(staged, name), join(outputDir, name));
      promoted.push(name);
    }
  } catch (error) {
    for (const name of promoted.reverse()) {
      const destination = join(outputDir, name);
      if (existsSync(destination)) renameSync(destination, join(staged, `${name}.rejected`));
    }
    for (const name of previous) {
      const saved = join(backup, name);
      if (existsSync(saved)) renameSync(saved, join(outputDir, name));
    }
    throw error;
  }
}

function rollbackMedia(staged, outputDir) {
  const names = ["editor-capture.webm", "editor-capture.mp4", "editor-capture-poster.jpg",
    "editor-capture-poster-720.jpg"];
  const backup = join(dirname(staged), "previous-media");
  for (const name of names) {
    const destination = join(outputDir, name);
    if (existsSync(destination)) renameSync(destination, join(staged, `${name}.rejected`));
  }
  for (const name of names) {
    const saved = join(backup, name);
    if (existsSync(saved)) renameSync(saved, join(outputDir, name));
  }
}

function encode(raw, outputDir, rawSeconds, manifestUpdate = null) {
  const factor = Math.max(1, rawSeconds / targetLongSeconds);
  mkdirSync(outputDir, { recursive: true });
  const stagingRoot = mkdtempSync(join(outputDir, ".editor-capture-stage-"));
  const staged = join(stagingRoot, "encoded");
  mkdirSync(staged);
  try {
    const common = ["-hide_banner", "-loglevel", "error", "-y", "-i", raw, "-an",
      "-vf", `setpts=PTS/${factor.toFixed(8)}`];
    run("ffmpeg", [...common, "-c:v", "libvpx-vp9", "-crf", "35", "-b:v", "0",
      "-row-mt", "1", join(staged, "editor-capture.webm")], { timeout: 300_000 });
    run("ffmpeg", [...common, "-c:v", "libx264", "-preset", "slow", "-crf", "27",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart",
      join(staged, "editor-capture.mp4")], { timeout: 300_000 });
    const posterAt = Math.min(Math.max(8, rawSeconds * 0.72), Math.max(0, rawSeconds - 0.5));
    run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", posterAt.toFixed(3),
      "-i", raw, "-frames:v", "1", "-q:v", "3",
      join(staged, "editor-capture-poster.jpg")]);
    run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", posterAt.toFixed(3),
      "-i", raw, "-frames:v", "1", "-vf", "scale=720:450:flags=lanczos",
      "-q:v", "2", "-pix_fmt", "yuvj420p",
      join(staged, "editor-capture-poster-720.jpg")]);
    const publishedSeconds = rawSeconds / factor;
    validateMedia(staged, publishedSeconds);
    promoteMedia(staged, outputDir);
    if (manifestUpdate) {
      try {
        // Keep the manifest last: a failed metadata commit restores the prior media set.
        manifestUpdate(factor);
      } catch (error) {
        rollbackMedia(staged, outputDir);
        throw error;
      }
    }
    return factor;
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

async function commandPalette(page, command) {
  await page.keyboard.press("F1");
  const input = page.locator(".quick-input-widget:visible input");
  await input.waitFor({ state: "visible", timeout: 10_000 });
  await input.fill(`>${command}`);
  await page.keyboard.press("Enter");
}

async function dismissNotifications(page) {
  const toasts = page.locator(".notifications-toasts.visible");
  for (let attempt = 0; attempt < 4 && await toasts.count(); attempt += 1) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
  }
  if (await toasts.count()) {
    const text = (await toasts.innerText()).replace(/\s+/g, " ").trim().slice(0, 240);
    throw new Error(`VS Code notification obscures the capture surface: ${text}`);
  }
}

async function webviewFrame(page) {
  return await waitFor(async () => {
    for (const frame of page.frames()) {
      try {
        if (await frame.locator("#input").count()) return frame;
      } catch { /* a provisional webview frame may detach */ }
    }
    return null;
  }, "the real DGC webview did not load", 20_000);
}

async function main() {
  const codeProduct = requireInputs();
  const extensionFingerprint = extensionSourceFingerprint();
  const verifiedPackage = verifyExtensionPackage();
  const expectedCommit = run("git", ["rev-parse", "HEAD"]).stdout.trim();
  const userDgc = join(userInfo().homedir, ".dgc");
  const userDgcBefore = userStateSnapshot(userDgc);

  const work = mkdtempSync(join(tmpdir(), "extension-capture-state-"));
  const workspace = join(tmpdir(), "clamp-extension-demo-worktree");
  const userData = join(work, "user-data");
  const extensions = join(work, "extensions");
  const backend = join(work, "capture-fixture-backend");
  const statusPath = join(work, "status.json");
  const raw = join(work, "capture.mkv");
  const { display, socket } = chooseDisplay();
  const port = await freePort();
  let xvfb, code, recorder, browser;
  let recordingStarted = 0;
  let workspaceCreated = false;
  try {
    if (existsSync(workspace)) {
      throw new Error(`neutral capture workspace already exists: ${workspace}`);
    }
    mkdirSync(workspace);
    workspaceCreated = true;
    writeFixture(workspace);
    mkdirSync(join(userData, "User"), { recursive: true });
    mkdirSync(extensions);
    copyFileSync(backendSource, backend);
    chmodSync(backend, 0o700);
    writeFileSync(join(userData, "User", "settings.json"), JSON.stringify({
      "dgc.command": backend,
      "dgc.checkForUpdates": false,
      "workbench.sideBar.location": "right",
      "workbench.startupEditor": "none",
      "workbench.tips.enabled": false,
      "workbench.enableExperiments": false,
      "workbench.colorTheme": "Default Dark Modern",
      "window.newWindowDimensions": "maximized",
      "editor.fontSize": 15,
      "editor.minimap.enabled": false,
      "breadcrumbs.enabled": false,
      "telemetry.telemetryLevel": "off",
      "update.mode": "none",
      "extensions.autoUpdate": false,
      "extensions.autoCheckUpdates": false,
    }, null, 2) + "\n");
    run(codeProduct.cli, ["--install-extension", extensionPackage, "--force",
      `--user-data-dir=${userData}`, `--extensions-dir=${extensions}`], {
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
      timeout: 120_000,
    });

    xvfb = spawn("Xvfb", [display, "-screen", "0", `${viewport.width}x${viewport.height}x24`,
      "-nolisten", "tcp", "-noreset"], {
      detached: true, stdio: ["ignore", "ignore", "pipe"],
    });
    await waitFor(() => existsSync(socket), "Xvfb did not become ready", 10_000);
    const env = safeEnvironment(display, statusPath);
    for (const name of Object.keys(env)) {
      if (name.startsWith("VSCODE_")) delete env[name];
    }
    delete env.ELECTRON_RUN_AS_NODE;

    code = spawn(options.code, [
      `--user-data-dir=${userData}`,
      `--extensions-dir=${extensions}`,
      `--remote-debugging-port=${port}`,
      "--disable-gpu", "--disable-dev-shm-usage", "--disable-background-networking",
      "--disable-updates", "--disable-telemetry", "--disable-crash-reporter",
      "--disable-extension-gallery", "--use-inmemory-secretstorage",
      "--no-sandbox", "--disable-chromium-sandbox", "--skip-welcome", "--skip-release-notes",
      `--window-size=${viewport.width},${viewport.height}`, "--window-position=0,0",
      "--disable-workspace-trust", "--new-window", workspace,
    ], {
      cwd: workspace, env, detached: true, stdio: "ignore",
    });
    await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`).catch(() => null);
      return response?.ok;
    }, "VS Code did not expose its local debugging target", 25_000);

    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const page = await waitFor(async () => {
      for (const candidate of browser.contexts().flatMap(context => context.pages())) {
        try {
          if (await candidate.locator(".monaco-workbench").count()) return candidate;
        } catch { /* provisional Electron targets can disappear */ }
      }
      return null;
    }, "VS Code workbench target not found", 15_000);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(800);
    const surface = await page.evaluate(() => ({ width: window.outerWidth, height: window.outerHeight }));
    if (surface.width < 1360 || surface.height < 820) {
      throw new Error(`VS Code surface is too small for publication: ${surface.width}x${surface.height}`);
    }

    const auxiliary = page.locator(".part.auxiliarybar:visible");
    if (await auxiliary.count()) {
      await commandPalette(page, "View: Toggle Secondary Side Bar Visibility");
      await auxiliary.waitFor({ state: "hidden", timeout: 10_000 });
    }
    await page.keyboard.press("Control+P");
    const quickOpen = page.locator(".quick-input-widget:visible input");
    await quickOpen.waitFor({ state: "visible", timeout: 10_000 });
    await quickOpen.fill("clamp.py");
    const clampResult = page.locator(".quick-input-widget:visible .monaco-list-row")
      .filter({ hasText: "clamp.py" }).first();
    await clampResult.waitFor({ state: "visible", timeout: 10_000 });
    await clampResult.click();
    await page.locator(".editor-group-container .tab.active").filter({ hasText: "clamp.py" })
      .waitFor({ state: "visible", timeout: 10_000 });
    await page.locator(".editor-group-container .view-line")
      .filter({ hasText: "return min(lower, max(upper, value))" })
      .waitFor({ state: "visible", timeout: 10_000 });
    await commandPalette(page, "DGC: Focus Chat");
    let frame = await webviewFrame(page);
    await frame.locator("#goalbar").waitFor({ state: "visible", timeout: 12_000 });
    await frame.locator("#goal-text").waitFor({ state: "visible" });

    const sidebar = page.locator(".part.sidebar.right");
    if (await sidebar.count()) {
      const box = await sidebar.boundingBox();
      if (box && box.width < 540) {
        const desiredWidth = 560;
        await page.mouse.move(box.x + 1, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(Math.max(640, box.x - (desiredWidth - box.width)), box.y + box.height / 2,
          { steps: 8 });
        await page.mouse.up();
        frame = await webviewFrame(page);
      }
    }
    const finalSidebar = await sidebar.boundingBox();
    if (!finalSidebar || finalSidebar.width < 520 || finalSidebar.width > 620) {
      throw new Error(`DGC capture sidebar width is not publication-safe: ${finalSidebar?.width || 0}`);
    }
    if (await page.locator(".part.auxiliarybar:visible").count()) {
      throw new Error("unrelated secondary sidebar remained visible in the capture surface");
    }
    await page.locator(".editor-group-container .tab.active").filter({ hasText: "clamp.py" })
      .waitFor({ state: "visible", timeout: 10_000 });
    await dismissNotifications(page);

    recorder = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y", "-f", "x11grab", "-draw_mouse", "0",
      "-framerate", "30", "-video_size", `${viewport.width}x${viewport.height}`,
      "-i", `${display}.0`, "-an", "-c:v", "ffv1", raw,
    ], { stdio: ["pipe", "ignore", "pipe"] });
    recordingStarted = Date.now();
    await page.waitForTimeout(800);
    await frame.locator("#input").pressSequentially(prompt, { delay: 9 });
    await frame.locator("#send").click();
    const approve = frame.getByRole("button", { name: "Approve → acceptEdits" });
    await approve.waitFor({ state: "visible", timeout: 15_000 });
    await page.waitForTimeout(1100);
    await approve.click();

    await waitFor(() => {
      const state = captureState(statusPath);
      if (state.state === "failed") throw new Error(state.reason || "fixture backend failed");
      return state.state === "passed";
    }, "the deterministic extension fixture did not complete", maximumFlowMs);
    await frame.locator('.tool[data-tool-name="read_file"] .tool-status')
      .getByText("completed", { exact: true }).waitFor({ state: "attached", timeout: 10_000 });
    await frame.locator('.tool[data-tool-name="edit_file"] .tool-status')
      .getByText("completed", { exact: true }).waitFor({ state: "attached", timeout: 10_000 });
    const renderedDiff = frame.locator(".diff.open").filter({ hasText: "clamp.py" });
    await renderedDiff.waitFor({ state: "visible", timeout: 10_000 });
    await renderedDiff.getByText("+    return max(lower, min(upper, value))", { exact: true })
      .waitFor({ state: "visible", timeout: 10_000 });
    await frame.locator('.tool[data-tool-name="bash"] .tool-status')
      .getByText("completed", { exact: true }).waitFor({ state: "attached", timeout: 10_000 });
    await frame.getByText("Verification:", { exact: false }).last()
      .waitFor({ state: "visible", timeout: 10_000 });
    await frame.locator('#goalbar[data-status="completed"]')
      .waitFor({ state: "visible", timeout: 10_000 });
    // The fixture edits on disk outside VS Code's extension host. Force the real editor to reload
    // that file, then prove the visible Monaco buffer agrees with the rendered diff and test result.
    await commandPalette(page, "File: Revert File");
    const correctedEditorLine = page.locator(".editor-group-container .view-line")
      .filter({ hasText: "return max(lower, min(upper, value))" });
    await correctedEditorLine.waitFor({ state: "visible", timeout: 10_000 });
    if (await page.locator(".editor-group-container .view-line")
      .filter({ hasText: "return min(lower, max(upper, value))" }).count()) {
      throw new Error("visible Monaco buffer still contains the pre-edit clamp expression");
    }
    const remaining = minimumSeconds * 1000 - (Date.now() - recordingStarted);
    if (remaining > 0) await page.waitForTimeout(remaining);
    await page.waitForTimeout(800);
    const rawSeconds = (Date.now() - recordingStarted) / 1000;
    await stopRecorder(recorder);

    const verification = run("python3", ["-m", "unittest", "-v"], { cwd: workspace });
    if (!/Ran 3 tests/.test(verification.stderr + verification.stdout)
        || !/\bOK\b/.test(verification.stderr + verification.stdout)
        || !readFileSync(join(workspace, "clamp.py"), "utf8")
          .includes("return max(lower, min(upper, value))")) {
      throw new Error("the on-screen extension fixture did not leave the verified project state");
    }
    await browser.close().catch(() => undefined);
    browser = undefined;
    await stopProcess(code);
    code = undefined;
    if (userStateSnapshot(userDgc) !== userDgcBefore) {
      throw new Error("capture aborted: the real ~/.dgc tree changed during the run");
    }
    const factor = encode(
      raw, options.outputDir, rawSeconds,
      captureFactor => updateEditorManifest(
        options.outputDir, captureFactor, codeProduct, verifiedPackage));
    process.stdout.write(JSON.stringify({
      vscode_version: codeProduct.version,
      extension_version: verifiedPackage.packageMetadata.version,
      extension_source_commit: expectedCommit,
      packaged_extension_source_commit: verifiedPackage.buildMetadata.source_commit,
      extension_source_fingerprint: extensionFingerprint,
      extension_vsix_sha256: verifiedPackage.actualSha256,
      installed_verified_local_vsix: true,
      real_extension_surface: true,
      deterministic_fixture_backend: true,
      real_plan_button_click: true,
      real_edit_and_tests: true,
      rendered_read_tool: true,
      rendered_edit_tool: true,
      rendered_diff: true,
      rendered_test_tool: true,
      rendered_final: true,
      rendered_completed_goal: true,
      visible_editor_matches_diff: true,
      user_dgc_unchanged: true,
      raw_seconds: Number(rawSeconds.toFixed(3)),
      published_seconds: Number((rawSeconds / factor).toFixed(3)),
      time_compression: Number(factor.toFixed(4)),
    }, null, 2) + "\n");
  } finally {
    if (recorder && recorder.exitCode === null) {
      try { await stopRecorder(recorder); } catch { await stopProcess(recorder); }
    }
    if (browser) await browser.close().catch(() => undefined);
    await stopProcess(code);
    await stopProcess(xvfb);
    if (options.keepWork) {
      process.stderr.write(`capture state retained at ${work}\n`);
      if (workspaceCreated) process.stderr.write(`capture workspace retained at ${workspace}\n`);
    } else {
      if (work.startsWith(resolve(tmpdir()) + sep)) rmSync(work, { recursive: true, force: true });
      if (workspaceCreated && workspace === join(tmpdir(), "clamp-extension-demo-worktree")) {
        rmSync(workspace, { recursive: true, force: true });
      }
    }
    if (userStateSnapshot(userDgc) !== userDgcBefore) {
      throw new Error("capture aborted: the real ~/.dgc tree changed during the run");
    }
  }
}

await main();
