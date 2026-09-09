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
