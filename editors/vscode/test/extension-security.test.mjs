import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "dgc-vscode-extension-security-"));
const bundle = join(scratch, "extension.cjs");
const registered = new Map();
const terminals = [];
const warnings = [];
let inspectedCommand;

globalThis.__DGC_EXTENSION_SECURITY_VSCODE = {
  window: {
    registerWebviewViewProvider: () => ({ dispose() {} }),
    showWarningMessage: async (message) => { warnings.push(String(message)); },
    showInformationMessage: async () => undefined,
    createTerminal: (options) => {
      const terminal = { options, show() {} };
      terminals.push(terminal);
      return terminal;
    },
  },
  commands: {
    registerCommand: (name, callback) => {
      registered.set(name, callback);
      return { dispose() {} };
    },
  },
  workspace: {
    isTrusted: true,
    getConfiguration: () => ({
      get: (_key, fallback) => fallback,
      inspect: (key) => key === "command" ? inspectedCommand : undefined,
    }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
  },
};
globalThis.__DGC_PANEL_CONSTRUCTIONS = 0;

await build({
  entryPoints: [join(here, "../src/extension.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  outfile: bundle,
  logLevel: "silent",
  plugins: [{
    name: "extension-security-fixtures",
    setup(builder) {
      builder.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "test" }));
      builder.onLoad({ filter: /^vscode$/, namespace: "test" }, () => ({
        contents: "module.exports = globalThis.__DGC_EXTENSION_SECURITY_VSCODE;",
        loader: "js",
      }));
      builder.onResolve({ filter: /^\.\/panel$/ }, () => ({ path: "panel", namespace: "test" }));
      builder.onLoad({ filter: /^panel$/, namespace: "test" }, () => ({
        contents: `exports.DgcViewProvider = class {
          constructor() { globalThis.__DGC_PANEL_CONSTRUCTIONS += 1; }
        };`,
        loader: "js",
      }));
    },
  }],
});

const extension = createRequire(import.meta.url)(bundle);
const context = {
  subscriptions: { push() {} },
  globalState: { get: (_key, fallback) => fallback, async update() {} },
  extension: { packageJSON: { version: "0.0.0" } },
};

after(() => {
  delete globalThis.__DGC_EXTENSION_SECURITY_VSCODE;
  delete globalThis.__DGC_PANEL_CONSTRUCTIONS;
  rmSync(scratch, { recursive: true, force: true });
});
beforeEach(() => {
  registered.clear();
  terminals.length = 0;
  warnings.length = 0;
  globalThis.__DGC_EXTENSION_SECURITY_VSCODE.workspace.isTrusted = true;
  globalThis.__DGC_PANEL_CONSTRUCTIONS = 0;
  inspectedCommand = {
    defaultValue: "dgc",
    globalValue: "/opt/DGC CLI/dgc;literal",
    workspaceValue: "/tmp/repository-controlled; touch /tmp/unsafe",
  };
});

test("CLI terminal actions ignore workspace executables and pass argv without shell interpolation", () => {
  extension.activate(context);
  registered.get("dgc.updateCli")();
  registered.get("dgc.exportTraining")();

  assert.deepEqual(terminals.map((terminal) => terminal.options), [
    { name: "DGC update", shellPath: "/opt/DGC CLI/dgc;literal", shellArgs: ["update"] },
    { name: "DGC export-training", shellPath: "/opt/DGC CLI/dgc;literal",
      shellArgs: ["export-training"] },
  ]);
  assert.ok(warnings.every((message) => message.includes("workspace-level dgc.command")));

  inspectedCommand = {
    defaultValue: "dgc",
    workspaceFolderValue: "/tmp/folder-controlled",
  };
  registered.get("dgc.updateCli")();
  assert.equal(terminals.at(-1).options.shellPath, "dgc",
    "a workspace-only executable override must fall back to the extension default");
});

test("activation does not construct an agent provider in an untrusted workspace", () => {
  globalThis.__DGC_EXTENSION_SECURITY_VSCODE.workspace.isTrusted = false;
  extension.activate(context);

  assert.equal(globalThis.__DGC_PANEL_CONSTRUCTIONS, 0);
  assert.equal(registered.size, 0);
  assert.equal(terminals.length, 0);
  assert.match(warnings.at(-1) || "", /disabled in Restricted Mode/);
});

test("manifest declares the executable machine-scoped and disables untrusted workspaces", () => {
  const manifest = JSON.parse(readFileSync(join(here, "../package.json"), "utf8"));
  assert.equal(manifest.contributes.configuration.properties["dgc.command"].scope, "machine");
  assert.equal(manifest.capabilities.untrustedWorkspaces.supported, false);
});

test("a repository cannot choose the endpoint or the gate command through workspace settings", () => {
  // A checked-in .vscode/settings.json used to be able to redirect the conversation to another
  // endpoint, or run any command as the autonomous gate, on the first turn. These four are
  // machine-scoped like dgc.command, and the panel reads them from the user scope only.
  const manifest = JSON.parse(readFileSync(join(here, "../package.json"), "utf8"));
  for (const key of ["dgc.autonomousGate", "dgc.baseUrl", "dgc.subagentBaseUrl", "dgc.fallbackBaseUrl"]) {
    assert.equal(manifest.contributes.configuration.properties[key].scope, "machine", key);
  }
  const panel = readFileSync(join(here, "../src/panel.ts"), "utf8");
  for (const key of ["baseUrl", "subagentBaseUrl", "fallbackBaseUrl", "autonomousGate"]) {
    assert.doesNotMatch(panel, new RegExp(`c\\.get<string>\\("${key}"`), `${key} must not be read through the merged scope`);
    assert.match(panel, new RegExp(`userScopedString\\("${key}"\\)`), `${key} must be read from the user scope`);
  }
});

test("keybindings do not collide with the host or with Claude Code", () => {
  const manifest = JSON.parse(readFileSync(join(here, "../package.json"), "utf8"));
  const keys = manifest.contributes.keybindings.map((kb) => [kb.key, kb.mac].filter(Boolean)).flat();
  // ctrl+escape is Claude Code's focus chord, ctrl+shift+m is Toggle Problems, ctrl+i is Cursor's Composer.
  for (const taken of ["ctrl+escape", "cmd+escape", "ctrl+shift+m", "cmd+shift+m", "ctrl+i", "cmd+i"]) {
    assert.ok(!keys.includes(taken), `${taken} is claimed by the host or another harness`);
  }
});

test("protocol v7: the approval card gets a summary and a diff, and a denial can carry a note", () => {
  const generated = readFileSync(join(here, "../src/protocol.generated.ts"), "utf8");
  assert.match(generated, /DGC_PROTOCOL_VERSION = 7 as const/);
  const panel = readFileSync(join(here, "../src/panel.ts"), "utf8");
  assert.match(panel, /type: "permission_response", id: msg\.id, decision: msg\.decision, rule: msg\.rule,\s*\.\.\.\(typeof msg\.reason === "string"/,
    "the panel forwards the denial note to the backend");
  const webview = readFileSync(join(here, "../media/main.js"), "utf8");
  assert.match(webview, /ev\.summary/, "the card shows the step summary");
  assert.match(webview, /renderDiff\(String\(ev\.diff\)\)/, "an edit's diff renders on the card");
  assert.match(webview, /reason: b\.dataset\.d === "deny" && note \? note : undefined/, "Deny sends the note");
});

test("entry points: explorer and tab menus, drag-and-drop, and palette entries that need a backend are gated", () => {
  const manifest = JSON.parse(readFileSync(join(here, "../package.json"), "utf8"));
  const menus = manifest.contributes.menus;
  assert.ok(manifest.contributes.commands.some((c) => c.command === "dgc.addFile"), "DGC: Add File to Chat exists");
  assert.ok(menus["explorer/context"].some((m) => m.command === "dgc.addFile"), "explorer context menu");
  assert.ok(menus["editor/title/context"].some((m) => m.command === "dgc.addFile"), "editor tab context menu");
  const gated = new Map(menus.commandPalette.map((m) => [m.command, m.when]));
  for (const cmd of ["dgc.rewind", "dgc.compact", "dgc.goal", "dgc.handoff", "dgc.selectModel", "dgc.connect"]) {
    assert.equal(gated.get(cmd), "dgc.ready", `${cmd} is hidden from the palette until the backend is ready`);
  }
  assert.equal(gated.get("dgc.addSelection"), "editorHasSelection");
  const panel = readFileSync(join(here, "../src/panel.ts"), "utf8");
  assert.match(panel, /setReadyContext\(true\)/); assert.match(panel, /setReadyContext\(false\)/);
  assert.match(panel, /case "drop_uris"/, "dropped files reach the panel");
  assert.match(panel, /type: "file_mention", uri: u\.toString\(\)/, "dropped and picked files attach as @-mentions");
  const webview = readFileSync(join(here, "../media/main.js"), "utf8");
  assert.match(webview, /addEventListener\("drop"/); assert.match(webview, /type: "drop_uris", uris/);
});

test("first-run dead ends: a queued selection, a restart on a new command path, and no permanent dismissal", () => {
  const panel = readFileSync(join(here, "../src/panel.ts"), "utf8");
  const addSelection = panel.slice(panel.indexOf("addSelection(): void {"), panel.indexOf("addFiles(uri?"));
  assert.match(addSelection, /this\.inVisiblePanel\(\(\) => this\.post\(\{ type: "attach"/,
    "the selection waits for the webview instead of being dropped when the view was never opened");
  assert.match(addSelection, /showInformationMessage\("Select some text first/);
  const restart = panel.slice(panel.indexOf("restart(): void {"), panel.indexOf("restart(): void {") + 400);
  assert.match(restart, /this\._installPrompted = false/, "a restart earns a fresh install prompt");
  assert.match(panel, /RETRY = "Retry"/, "the install prompt offers a retry");
  const extension = readFileSync(join(here, "../src/extension.ts"), "utf8");
  assert.match(extension, /affectsConfiguration\("dgc\.command"\)\) \{\s*\/\/[^\n]*\n[^\n]*\n\s*provider\.restart\(\)/,
    "changing dgc.command restarts the backend");
});

test("the recovery commands are never hidden behind a backend that will not start", () => {
  // Gating the palette on dgc.ready is only safe if the way OUT stays reachable: if the CLI is
  // missing, the user must still be able to open settings, point dgc.command somewhere real,
  // install the CLI and restart. Hiding those would make a failed first run unrecoverable.
  const manifest = JSON.parse(readFileSync(join(here, "../package.json"), "utf8"));
  const gated = new Map((manifest.contributes.menus.commandPalette || []).map((m) => [m.command, m.when]));
  for (const command of ["dgc.settings", "dgc.restart", "dgc.updateCli", "dgc.focus", "dgc.openCommandMenu"]) {
    assert.ok(manifest.contributes.commands.some((c) => c.command === command), `${command} exists`);
    assert.equal(gated.get(command), undefined, `${command} must stay in the palette when the backend is down`);
  }
});

test("the chat is offered in the secondary side bar as well as the activity bar", () => {
  // VS Code binds a container to exactly one location (the 1.107 contribution point takes
  // activitybar | panel | secondarySidebar), so a second container is the only way a view can
  // live in both places — the same shape the Codex extension ships.
  const manifest = JSON.parse(readFileSync(join(here, "../package.json"), "utf8"));
  const containers = manifest.contributes.viewsContainers;
  assert.ok(containers.activitybar.some((c) => c.id === "dgc"), "the activity bar container stays");
  assert.ok(containers.secondarySidebar.some((c) => c.id === "dgcSecondary"), "a secondary side bar container exists");
  assert.deepEqual(Object.keys(containers).filter((k) => !["activitybar", "panel", "secondarySidebar"].includes(k)), [],
    "no container location outside the ones VS Code declares");
  assert.ok(manifest.contributes.views.dgcSecondary.some((v) => v.id === "dgc.chatSecondary" && v.type === "webview"));
  const extension = readFileSync(join(here, "../src/extension.ts"), "utf8");
  for (const id of ["dgc.chat", "dgc.chatSecondary"]) {
    assert.match(extension, new RegExp(`registerWebviewViewProvider\\("${id.replace(".", "\\.")}", provider`),
      `${id} is served by the same provider, so there is one conversation`);
  }
  for (const entry of manifest.contributes.menus["view/title"]) {
    assert.match(entry.when, /view == dgc\.chat \|\| view == dgc\.chatSecondary/,
      `${entry.command} keeps its title-bar action in both locations`);
  }
});

test("an outdated CLI is offered the update, since the extension drives the CLI you installed", () => {
  // Codex ships its binary inside a per-platform VSIX, so updating the extension updates the CLI.
  // DGC drives the CLI on your machine instead, so the mismatch has to be one click to fix.
  const backend = readFileSync(join(here, "../src/backend.ts"), "utf8");
  assert.match(backend, /cli_outdated: true/, "the backend marks an older CLI");
  const panel = readFileSync(join(here, "../src/panel.ts"), "utf8");
  assert.match(panel, /cli_outdated/, "the panel reacts to it");
  assert.match(panel, /install\.sh \| bash/, "the offer runs the installer");
  assert.match(panel, /Restart Backend/, "and then offers the restart that reconnects");
});
