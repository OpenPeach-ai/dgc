// A chat in another folder comes back on its OWN session after Restart Backend or a crash.
//
// The window remembers one chat -- its own -- and a chat opened in another folder is never that chat
// (rememberSession skips it; its sessions live in its own project). Restart Backend and automatic
// recovery re-read the window's remembered id for whatever chat was on screen, so an other-folder
// chat asked its own project for a session that was never there: "no such session", then a new
// empty chat saying the previous one was unavailable. These drive the real panel and backend against
// a fake `dgc serve`.
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "dgc-vscode-chat-restore-"));
const bundle = join(scratch, "panel.cjs");

/** `dgc.command` (the user-scope value the panel reads) and `dgc.shareBackend`. */
let command = "dgc";
const share = { value: true };
globalThis.__DGC_TEST_VSCODE = {
  Uri: { joinPath: (...parts) => ({ toString: () => parts.join("/"), fsPath: parts.join("/") }) },
  env: {},
  commands: { executeCommand: async () => undefined },
  languages: { getDiagnostics: () => [] },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  StatusBarAlignment: { Left: 1 },
  ConfigurationTarget: { WorkspaceFolder: 1, Workspace: 2, Global: 3 },
  window: {
    activeTextEditor: undefined,
    tabGroups: { all: [] },
    createStatusBarItem: () => ({ text: "", tooltip: "", command: "", show() {}, hide() {}, dispose() {} }),
    createOutputChannel: () => ({ appendLine() {}, append() {}, show() {}, dispose() {} }),
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showInformationMessage: async () => undefined,
  },
  workspace: {
    isTrusted: true,
    workspaceFolders: [{ uri: { fsPath: scratch, toString: () => `file://${scratch}` } }],
    getConfiguration: () => ({
      get: (key, fallback) => (key === "shareBackend" ? share.value : fallback),
      inspect: (key) => (key === "command" ? { defaultValue: "dgc", globalValue: command } : undefined),
      async update() {},
    }),
  },
};

await build({
  stdin: {
    contents: `export { DgcViewProvider } from "./panel"; export { DGC_PROTOCOL_VERSION } from "./backend";`,
    resolveDir: join(here, "../src"), loader: "ts",
  },
  bundle: true, format: "cjs", platform: "node", target: "node18", outfile: bundle, logLevel: "silent",
  plugins: [{
    name: "test-vscode",
    setup(builder) {
      builder.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "test" }));
      builder.onLoad({ filter: /^vscode$/, namespace: "test" }, () => ({
        contents: "module.exports = globalThis.__DGC_TEST_VSCODE;", loader: "js",
      }));
    },
  }],
});

const { DgcViewProvider, DGC_PROTOCOL_VERSION } = createRequire(import.meta.url)(bundle);
const providers = [];
after(() => {
  for (const provider of providers) { try { provider.dispose(); } catch { /* already gone */ } }
  delete globalThis.__DGC_TEST_VSCODE;
  rmSync(scratch, { recursive: true, force: true });
});
beforeEach(() => { share.value = true; });

/** A `dgc serve` that can hold chats. A prompt "stderr <text>" writes <text> to its stderr; a prompt
 *  "crash" says its last word and exits 3; `emit <json>` sends that event verbatim. */
function chatsServe(name, { refuse = false } = {}) {
  const path = join(scratch, name);
  writeFileSync(path, `#!/usr/bin/env node
let sequence = 0, chats = 0;
const send = (value) => process.stdout.write(JSON.stringify({ seq: sequence++, ...value }) + "\\n");
const perChat = { model: "fixture", mode: "default", think: "off", base_url: "http://127.0.0.1:1/v1",
  workspace_trusted: true, commands: [], custom_commands: [], goal: { text: "", status: "none" },
  context_size: 32768 };
send({ type: "ready", version: "fixture", protocol_version: ${DGC_PROTOCOL_VERSION},
       capabilities: { chats: { version: 1, max: 8, default: "c0" } }, ...perChat });
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\\n")) !== -1) {
    const cmd = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);
    if (cmd.type === "shutdown") { process.exit(0); }
    if (cmd.type === "open_chat") {
      if (${refuse}) {
        send({ type: "command_rejected", command: "open_chat", reason: "invalid_cwd",
               message: "cwd must be an existing absolute directory", request_id: cmd.request_id });
        continue;
      }
      send({ type: "chat_opened", chat_id: "c" + (++chats), request_id: cmd.request_id, ...perChat, project_root: cmd.cwd });
      continue;
    }
    if (cmd.type === "close_chat") {
      send({ type: "chat_closed", chat_id: cmd.chat_id, reason: "closed", request_id: cmd.request_id });
      continue;
    }
    const text = cmd.type === "prompt" ? String(cmd.text || "") : "";
    if (text.startsWith("stderr ")) { process.stderr.write(text.slice(7) + "\\n"); continue; }
    if (text === "crash") {
      process.stderr.write("[dgc serve] serve loop ended: the fixture crashed; up 1s\\n");
      setTimeout(() => process.exit(3), 50);
      continue;
    }
    if (text.startsWith("emit ")) { send(JSON.parse(text.slice(5))); continue; }
    send({ type: "info", message: "got " + cmd.type, ...(cmd.chat_id ? { chat_id: cmd.chat_id } : {}) });
  }
});
`, "utf8");
  chmodSync(path, 0o700);
  return path;
}

async function until(predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}
/** Long enough for any duplicate of a line already seen to have been written too. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 250));

/** The real panel, writing its real backend.log. No view: a recovery the panel schedules never
 *  starts another process behind the test's back. */
function panel() {
  const logDir = mkdtempSync(join(scratch, "log-"));
  const provider = new DgcViewProvider({
    extension: { packageJSON: { version: "0.32.0", dgcCliVersion: "0.47.0" } },
    extensionUri: { fsPath: "/ext" }, subscriptions: [], logUri: { fsPath: logDir },
    secrets: { async get() {}, async store() {}, async delete() {} },
    globalState: { get() {}, async update() {} },
    workspaceState: { get() {}, async update() {} },
  });
  provider.post = () => {};
  providers.push(provider);
  const log = () => { try { return readFileSync(join(logDir, "backend.log"), "utf8"); } catch { return ""; } };
  const count = (pattern) => log().split("\n").filter((line) => pattern.test(line)).length;
  return { provider, log, count };
}

/** A real folder for a chat: a chat with a process of its own starts `dgc serve` in it. */
function folder(name) {
  const path = join(scratch, name);
  mkdirSync(path, { recursive: true });
  return path;
}

/** The first chat starts the process; `more` chats open on it, each in a folder of its own. */
async function sharedChats(h, more) {
  const process = h.provider.ensureBackend();
  assert.ok(await until(() => process.ready), "the fixture never became ready");
  process.completeHandshake();                       // as the first chat's own handshake leaves it
  const chats = [];
  for (let i = 1; i <= more; i++) {
    h.provider.openChatSlot(folder(`folder-${i}`));
    const chat = h.provider.backend;
    assert.equal(chat.host, process, "premise: the chat opened on the first chat's process");
    assert.ok(await until(() => chat.ready), `chat ${i} never opened`);
    chats.push(chat);
  }
  return { process, chats };
}


test("Restart Backend brings a chat in another folder back on its own session", async () => {
  const h = panel();
  command = chatsServe("serve-restart-own-session");
  const remembered = { scope: h.provider.draftScope(), id: "20261001-window-chat", saved: true };
  h.provider.context.workspaceState.get = (key) => (key === "dgc.activeSession.v1" ? remembered : undefined);
  await sharedChats(h, 1);                           // the window's chat, and one in another folder
  assert.ok(h.provider.activeSlot().cwd, "premise: the chat on screen is in another folder");
  h.provider.currentSessionId = "20261002-its-own";
  h.provider.currentSessionSaved = true;
  h.provider.restart("test restart");
  assert.equal(h.provider.sessionRestoreCandidate, "20261002-its-own",
    "it asked its own project for the window's remembered chat");
  assert.equal(h.provider.sessionRestoreSuppressed, true, "ready would re-read the window's remembered chat");
  assert.equal(h.provider.sessionRestoreSaved, true);
});

test("a chat in another folder that never saved a message comes back empty, not on the window's chat", async () => {
  const h = panel();
  command = chatsServe("serve-restart-unsaved");
  const remembered = { scope: h.provider.draftScope(), id: "20261001-window-chat", saved: true };
  h.provider.context.workspaceState.get = (key) => (key === "dgc.activeSession.v1" ? remembered : undefined);
  await sharedChats(h, 1);
  h.provider.currentSessionId = "20261002-fresh";
  h.provider.currentSessionSaved = false;
  h.provider.restart("test restart");
  assert.equal(h.provider.sessionRestoreCandidate, "20261002-fresh");
  assert.equal(h.provider.sessionRestoreSaved, false, "an unsaved chat has no file to resume");
});

test("the window's own chat still comes back on the window's remembered chat", async () => {
  const h = panel();
  command = chatsServe("serve-restart-window");
  const remembered = { scope: h.provider.draftScope(), id: "20261001-window-chat", saved: true };
  h.provider.context.workspaceState.get = (key) => (key === "dgc.activeSession.v1" ? remembered : undefined);
  const process = h.provider.ensureBackend();
  assert.ok(await until(() => process.ready));
  assert.equal(h.provider.activeSlot().cwd, undefined, "premise: the window's own chat");
  h.provider.restart("test restart");
  assert.equal(h.provider.sessionRestoreCandidate, "20261001-window-chat");
});
