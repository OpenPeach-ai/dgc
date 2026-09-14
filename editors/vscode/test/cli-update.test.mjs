import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "dgc-cli-update-")));

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
const { autoUpdateEnabled, cliUpdateEnvironment, failureHeadline, INSTALL_COMMAND, installTerminalOptions,
  isUserChosenCommand, runCliUpdate, swallowedInstallerExit, updateTerminalOptions } = createRequire(import.meta.url)(outfile);

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

/** An install tree on disk: <tree>/.venv/bin/dgc running `body`, plus the marker files the
 *  installer leaves (requirements.lock for any release tree, .complete for a finished version). */
function installTree(tree, { versioned = false, body = "echo dgc" } = {}) {
  mkdirSync(join(tree, ".venv", "bin"), { recursive: true });
  writeFileSync(join(tree, "requirements.lock"), "rich==15.0.0\n");
  if (versioned) { writeFileSync(join(tree, ".complete"), `version=${tree.split("/").at(-1)}\n`); }
  const exe = join(tree, ".venv", "bin", "dgc");
  writeFileSync(exe, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(exe, 0o755);
  return exe;
}

function launcherTo(folder, target) {
  mkdirSync(folder, { recursive: true });
  const link = join(folder, "dgc");
  rmSync(link, { force: true });
  symlinkSync(target, link);
  return link;
}

test("an old single-tree install in a custom place: the update is told that place", () => {
  const tree = join(scratch, "legacy", "custom-dgc");
  const bin = join(scratch, "legacy", "custom-bin");
  const launcher = launcherTo(bin, installTree(tree));
  // By path, and by name through PATH — the way the default dgc.command is found.
  assert.deepEqual(cliUpdateEnvironment(launcher), { DGC_DIR: tree, DGC_BIN: bin });
  assert.deepEqual(cliUpdateEnvironment("dgc", { PATH: `${join(scratch, "nowhere")}:${bin}` }),
    { DGC_DIR: tree, DGC_BIN: bin });
});

test("a versioned install passes its data directory, not the version directory", () => {
  const data = join(scratch, "versioned", "data");
  const exe = installTree(join(data, "versions", "1.2.3"), { versioned: true });
  const bin = join(scratch, "versioned", "bin");
  assert.deepEqual(cliUpdateEnvironment(launcherTo(bin, exe)), { DGC_DIR: data, DGC_BIN: bin });
});

test("a dgc.command pointing straight at the venv script has no launcher to switch", () => {
  const exe = installTree(join(scratch, "direct", "tree"));
  assert.deepEqual(cliUpdateEnvironment(exe), { DGC_DIR: join(scratch, "direct", "tree") });
});

test("anything that is not a DGC install tree adds no location", () => {
  const other = fakeCli("some-other-dgc");
  assert.deepEqual(cliUpdateEnvironment(other), {});
  assert.deepEqual(cliUpdateEnvironment("dgc", { PATH: join(scratch, "empty-path") }), {});
  assert.deepEqual(cliUpdateEnvironment(join(scratch, "missing", "dgc")), {});
});

test("the automatic update hands an OLD CLI the location of the install it belongs to", async () => {
  // An old `dgc update` pipes the published installer into bash with the environment it inherited;
  // this fake old CLI prints what that installer would see.
  const tree = join(scratch, "old-cli", "custom-dgc");
  const bin = join(scratch, "old-cli", "bin");
  const launcher = launcherTo(bin, installTree(tree, {
    body: 'echo "argv:$* dir:${DGC_DIR:-unset} bin:${DGC_BIN:-unset} skip:${DGC_SKIP_EXTENSION:-unset}"',
  }));
  const result = await runCliUpdate(launcher);
  assert.equal(result.ok, true);
  assert.match(result.log, new RegExp(`argv:update dir:${tree} bin:${bin} skip:1`));
});

test("every manual update terminal runs the exact executable with the install's location", () => {
  const tree = join(scratch, "terminal", "custom-dgc");
  const bin = join(scratch, "terminal", "bin");
  const launcher = launcherTo(bin, installTree(tree));
  assert.deepEqual(updateTerminalOptions(launcher, "Update DGC"), {
    name: "Update DGC", shellPath: launcher, shellArgs: ["update"],
    env: { DGC_SKIP_EXTENSION: "1", DGC_DIR: tree, DGC_BIN: bin },
  });
  // Both entry points use it, and neither types an installer pipeline into a shell any more.
  const panel = readFileSync(join(here, "../src/panel.ts"), "utf8");
  const manual = panel.slice(panel.indexOf("private offerManualCliUpdate("));
  const manualBody = manual.slice(0, manual.indexOf("\n  }\n"));
  assert.match(manualBody, /createTerminal\(\s*updateTerminalOptions\(resolveDgcExecutable\(\)\.command, "Update DGC"\)\)/);
  assert.doesNotMatch(manualBody, /sendText\(|curl -fsSL/);
  const extension = readFileSync(join(here, "../src/extension.ts"), "utf8");
  assert.match(extension, /updateTerminalOptions\(executable\.command, "DGC update"\)/);
});

test("a dgc.command set by hand to a versioned install is still DGC's to update", () => {
  const data = join(scratch, "chosen", "data");
  const exe = installTree(join(data, "versions", "2.0.0"), { versioned: true });
  inspected["command"] = { globalValue: launcherTo(join(scratch, "chosen", "bin"), exe), defaultValue: "dgc" };
  assert.equal(isUserChosenCommand(), false);
  const legacy = installTree(join(scratch, "chosen", "legacy-tree"));
  inspected["command"] = { globalValue: launcherTo(join(scratch, "chosen", "legacy-bin"), legacy), defaultValue: "dgc" };
  assert.equal(isUserChosenCommand(), true);
});

test("when another update holds the lock, wait and try again instead of failing", async () => {
  const counter = join(scratch, "lock-attempts");
  const path = join(scratch, "locked-cli");
  writeFileSync(path, [
    "#!/usr/bin/env bash",
    `n=$(cat ${JSON.stringify(counter)} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${JSON.stringify(counter)}`,
    'if [ "$n" -lt 3 ]; then echo "✗ another DGC update is running" >&2; exit 3; fi',
    'echo "updated on attempt $n"',
  ].join("\n") + "\n", { mode: 0o700 });
  const result = await runCliUpdate(path, undefined, { lockRetryMs: 20 });
  assert.equal(result.ok, true, result.reason);
  assert.match(result.log, /updated on attempt 3/);
  assert.match(result.log, /another update is running; trying again/);

  rmSync(counter, { force: true });
  const gaveUp = await runCliUpdate(path, undefined, { lockRetryMs: 20, maxLockRetries: 1 });
  assert.equal(gaveUp.ok, false);
  assert.match(gaveUp.reason, /another DGC update is running \(exit 3\)/);
});

/** A 0.38-style CLI: `curl … | bash` under check=True, the failure caught and printed, exit 0. */
function oldStyleCli(name, installerLines, installerExit) {
  const path = join(scratch, name);
  writeFileSync(path, [
    "#!/usr/bin/env bash",
    'echo "DGC update — fetching the latest…"',
    ...installerLines.map((line) => `echo ${JSON.stringify(line)} >&2`),
    installerExit === 0
      ? 'echo; echo "updated — start dgc again."'
      : `echo; echo "update failed (exit ${installerExit}). Run manually: curl -fsSL https://vibedgc.com/install.sh | bash"`,
    "exit 0",
  ].join("\n") + "\n", { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

test("an OLD CLI that swallows the installer's failure is not reported as updated", async () => {
  // 0.38's run_update caught CalledProcessError and returned, so the process exited 0 with the
  // previous CLI still installed. Treating that as success restarted the old backend and blamed
  // an unpublished release.
  const cli = oldStyleCli("old-cli-failed", ["▸ DGC installer", "✗ download failed from https://vibedgc.com/dgc.tar.gz"], 1);
  const result = await runCliUpdate(cli);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "download failed from https://vibedgc.com/dgc.tar.gz (installer exit 1)");
  assert.match(result.log, /update failed \(exit 1\)/);

  // No marked refusal: the line before the old CLI's own summary, never its curl advice.
  const plain = await runCliUpdate(oldStyleCli("old-cli-plain", ["pip: something broke"], 2));
  assert.equal(plain.ok, false);
  assert.equal(plain.reason, "pip: something broke (installer exit 2)");

  const fine = await runCliUpdate(oldStyleCli("old-cli-ok", ["▸ installed DGC 0.39.0"], 0));
  assert.equal(fine.ok, true, fine.ok ? "" : fine.reason);
});

test("an OLD CLI that swallowed a held lock waits and retries like a new one", async () => {
  const counter = join(scratch, "old-lock-attempts");
  const path = join(scratch, "old-locked-cli");
  writeFileSync(path, [
    "#!/usr/bin/env bash",
    `n=$(cat ${JSON.stringify(counter)} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${JSON.stringify(counter)}`,
    'if [ "$n" -lt 2 ]; then echo "✗ another DGC update is running" >&2; echo "update failed (exit 3). Run manually: x"; exit 0; fi',
    'echo "updated — start dgc again."',
  ].join("\n") + "\n", { mode: 0o700 });
  const result = await runCliUpdate(path, undefined, { lockRetryMs: 20 });
  // The second attempt's success is judged on its own output, not the first attempt's summary.
  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  assert.match(result.log, /another update is running; trying again/);
});

test("only the old CLI's own summary line counts as a swallowed failure", () => {
  assert.equal(swallowedInstallerExit("x\n\u001B[1;31mupdate failed\u001B[0m (exit 1). Run manually: …"), 1);
  assert.equal(swallowedInstallerExit("update failed (exit 3). Run manually"), 3);
  // The 0.39 CLI's wording comes with a non-zero exit of its own; it never matches.
  assert.equal(swallowedInstallerExit("update failed (installer exit 1). The previous version is still active."), undefined);
  assert.equal(swallowedInstallerExit("updated — start dgc again."), undefined);
  assert.equal(swallowedInstallerExit("pip said: the update failed (exit 1) somewhere"), undefined);
});

test("the first-install terminal keeps the installer away from the running extension", () => {
  assert.deepEqual(installTerminalOptions("Install DGC"), { name: "Install DGC", env: { DGC_SKIP_EXTENSION: "1" } });
  const panel = readFileSync(join(here, "../src/panel.ts"), "utf8");
  const prompt = panel.slice(panel.indexOf("private promptInstallCli("));
  const body = prompt.slice(0, prompt.indexOf("\n  }\n"));
  assert.match(body, /createTerminal\(installTerminalOptions\("Install DGC"\)\)/);
  assert.match(body, /sendText\(INSTALL_COMMAND\)/);
  assert.doesNotMatch(body, /createTerminal\("/);
  assert.equal(INSTALL_COMMAND, "curl -fsSL https://vibedgc.com/install.sh | bash");
});
