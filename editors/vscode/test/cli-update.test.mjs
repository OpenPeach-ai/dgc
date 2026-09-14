import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "dgc-cli-update-"));

// The setting lookups go through workspace.getConfiguration(...).inspect(), which is the only part
// of the editor API this module touches besides CancellationToken.
let inspected = {};
globalThis.__DGC_UPDATE_VSCODE = {
  workspace: { getConfiguration: () => ({ inspect: (name) => inspected[name] }) },
};

const outfile = join(scratch, "cliupdate.cjs");
await build({
  entryPoints: [join(here, "../src/cliupdate.ts")], bundle: true, outfile,
  platform: "node", format: "cjs", logLevel: "silent",
  plugins: [{ name: "vscode-fixture", setup(builder) {
    builder.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "fixture" }));
    builder.onLoad({ filter: /^vscode$/, namespace: "fixture" }, () => ({
      contents: "module.exports=globalThis.__DGC_UPDATE_VSCODE", loader: "js" }));
  } }],
});
const { autoUpdateEnabled, failureHeadline, isUserChosenCommand, runCliUpdate } =
  createRequire(import.meta.url)(outfile);

after(() => { delete globalThis.__DGC_UPDATE_VSCODE; rmSync(scratch, { recursive: true, force: true }); });
beforeEach(() => { inspected = {}; });

/** A stand-in for the CLI: it records the argv it was given and exits how the test asks. */
function fakeCli(name, { code = 0, stdout = "", stderr = "", sleepSeconds = 0 } = {}) {
  const path = join(scratch, name);
  writeFileSync(path, [
    "#!/usr/bin/env bash",
    `echo "argv:$*"`,
    stdout ? `echo ${JSON.stringify(stdout)}` : "",
    stderr ? `echo ${JSON.stringify(stderr)} >&2` : "",
    sleepSeconds ? `sleep ${sleepSeconds}` : "",
    `exit ${code}`,
  ].join("\n") + "\n");
  chmodSync(path, 0o700);
  return path;
}

test("an unset or default dgc.command is DGC's own install, not a path the user chose", () => {
  inspected["command"] = undefined;
  assert.equal(isUserChosenCommand(), false);
  inspected["command"] = { defaultValue: "dgc" };
  assert.equal(isUserChosenCommand(), false);
  inspected["command"] = { globalValue: "dgc", defaultValue: "dgc" };
  assert.equal(isUserChosenCommand(), false);
  inspected["command"] = { globalValue: "  dgc  ", defaultValue: "dgc" };
  assert.equal(isUserChosenCommand(), false);
});

test("a dgc.command the user set by hand is theirs to manage", () => {
  inspected["command"] = { globalValue: "/opt/dgc/bin/dgc", defaultValue: "dgc" };
  assert.equal(isUserChosenCommand(), true);
});

test("automatic update is on by default and off only when the user turns it off", () => {
  inspected["autoUpdateCli"] = undefined;
  assert.equal(autoUpdateEnabled(), true);
  inspected["autoUpdateCli"] = { defaultValue: true };
  assert.equal(autoUpdateEnabled(), true);
  inspected["autoUpdateCli"] = { globalValue: false, defaultValue: true };
  assert.equal(autoUpdateEnabled(), false);
});

test("a repository cannot switch automatic reinstalls on through workspace settings", () => {
  // The manifest scopes this setting to the machine; this is the belt to that brace.
  inspected["autoUpdateCli"] = { workspaceValue: true, globalValue: false, defaultValue: true };
  assert.equal(autoUpdateEnabled(), false);
  inspected["autoUpdateCli"] = { workspaceFolderValue: true, globalValue: false, defaultValue: true };
  assert.equal(autoUpdateEnabled(), false);
});

test("the update runs the CLI's own update subcommand and reports success", async () => {
  const cli = fakeCli("ok-cli", { stdout: "DGC update — fetching the latest…" });
  const result = await runCliUpdate(cli);
  assert.equal(result.ok, true);
  assert.match(result.log, /argv:update/);
  assert.match(result.log, /fetching the latest/);
});

test("a refusal is reported with the installer's own last line, not a bare exit code", async () => {
  const refusal = "/home/someone/dgc is a git checkout — refusing to extract a release over it.";
  const cli = fakeCli("refuse-cli", { code: 1, stderr: refusal });
  const result = await runCliUpdate(cli);
  assert.equal(result.ok, false);
  assert.match(result.reason, /git checkout/);
  assert.match(result.reason, /exit 1/);
  assert.match(result.log, /git checkout/);
});

test("a missing executable fails as a result rather than throwing into the caller", async () => {
  const result = await runCliUpdate(join(scratch, "does-not-exist"));
  assert.equal(result.ok, false);
  assert.match(result.reason, /could not run/);
});

test("cancelling stops the installer and says so", async () => {
  const cli = fakeCli("slow-cli", { sleepSeconds: 30 });
  const listeners = [];
  const token = { onCancellationRequested: (fn) => { listeners.push(fn); return { dispose() {} }; } };
  const pending = runCliUpdate(cli, token);
  await new Promise((r) => setTimeout(r, 120));
  listeners.forEach((fn) => fn());
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.reason, "cancelled");
});

test("the executable is spawned directly, so shell metacharacters in its path are just characters", async () => {
  // A shell would read this name as a command, a comment and a redirect. spawn() without a shell
  // treats the whole string as one path, so the only thing that can run is that file.
  const cli = fakeCli("weird; echo pwned > pwned.txt #cli", { stdout: "ran" });
  const result = await runCliUpdate(cli);
  assert.equal(result.ok, true);
  assert.match(result.log, /ran/);
  assert.equal(existsSync(join(scratch, "pwned.txt")), false);
  assert.equal(existsSync(join(process.cwd(), "pwned.txt")), false);
});

test("cancelling stops the installer's children too, not just the process it spawned", async () => {
  // The real installer forks curl, bash, python and pip. A child that outlives the signal would
  // keep the pipes open, so the caller would wait for an update it had already given up on.
  const marker = join(scratch, "grandchild-kept-running");
  const path = join(scratch, "forking-cli");
  writeFileSync(path, ["#!/usr/bin/env bash",
    `( sleep 5; echo late > ${JSON.stringify(marker)} ) &`,
    "wait"].join("\n") + "\n");
  chmodSync(path, 0o700);
  const listeners = [];
  const token = { onCancellationRequested: (fn) => { listeners.push(fn); return { dispose() {} }; } };
  const started = Date.now();
  const pending = runCliUpdate(path, token);
  await new Promise((r) => setTimeout(r, 150));
  listeners.forEach((fn) => fn());
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.reason, "cancelled");
  assert.ok(Date.now() - started < 3000, "cancelling must answer at once, not wait for the child");
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(existsSync(marker), false, "the grandchild kept running after cancellation");
});

test("the installer's refusal headline is reported, not its last line of advice", () => {
  // The real shape of install.sh's die(): a marked headline, then the two ways forward.
  const log = [
    "\u001B[1;36m▸\u001B[0m DGC installer",
    "\u001B[1;31m✗ /home/someone/dgc is a git checkout — refusing to extract a release over it.",
    "    Install elsewhere:  DGC_DIR=$HOME/.dgc-cli bash install.sh",
    "    Or overwrite it anyway (uncommitted work in /home/someone/dgc will be lost):  DGC_FORCE_OVERWRITE=1\u001B[0m",
  ].join("\n");
  const headline = failureHeadline(log);
  assert.match(headline, /is a git checkout/);
  assert.doesNotMatch(headline, /Or overwrite it anyway/);
  assert.doesNotMatch(headline, /\u001B/);
});

test("a failure with no marked refusal still reports something specific", () => {
  assert.equal(failureHeadline("downloading\ncurl: (7) Failed to connect\n"), "curl: (7) Failed to connect");
  assert.equal(failureHeadline("   \n  \n"), "");
});

test("the update never lets the installer reinstall the editor extension", async () => {
  // install.sh also force-installs the published .vsix. Run from inside the editor that is mid
  // update, that would replace the extension that asked for the update, with an older build.
  const path = join(scratch, "env-cli");
  writeFileSync(path, "#!/usr/bin/env bash\necho \"skip:${DGC_SKIP_EXTENSION:-unset}\"\n", { mode: 0o700 });
  chmodSync(path, 0o700);
  const result = await runCliUpdate(path);
  assert.equal(result.ok, true);
  assert.match(result.log, /skip:1/);
});
