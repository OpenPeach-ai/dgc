// The backend log, with several chats on one `dgc serve`.
//
// One process, many chats. What the process says about itself -- a traceback on stderr, being
// stopped, its exit -- is one fact, and backend.log, the file the user is told to open when a chat
// disappears, must say it once: every chat on the process used to write it, so three chats meant
// three copies of every line. What happens to a chat -- opened, could not open, closed -- is said
// once too, in the chat's own words: closing one chat was logged as "dgc serve exited" while the
// process kept serving the others. These drive the real panel, backend and chat channel against a
// fake `dgc serve` that speaks the chats protocol, and read the log file the panel writes.
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "dgc-vscode-backend-log-"));
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

const slotOf = (provider, be) => provider.slots.find((slot) => slot.backend === be || slot.saved?.backend === be);

test("a traceback from a process three chats share is logged once", async () => {
  const h = panel();
  command = chatsServe("serve-traceback");
  const { process } = await sharedChats(h, 2);
  process.send({ type: "prompt", text: "stderr Traceback: boom-once" });
  assert.ok(await until(() => /boom-once/.test(h.log())));
  await settle();
  assert.equal(h.count(/boom-once/), 1, `written once per chat:\n${h.log()}`);
  assert.equal(h.count(/\[dgc serve started: pid \d+/), 1);
  assert.equal(h.count(/\[extension: chat c\d opened in .*folder-\d on dgc serve pid \d+\]/), 2,
    "each chat that opened on the process says so, once");
});

test("closing one chat is logged as that chat closing, not as the process exiting", async () => {
  const h = panel();
  command = chatsServe("serve-close-one");
  const { process, chats } = await sharedChats(h, 2);
  h.provider.closeChatSlot(slotOf(h.provider, chats[0]).id);
  await settle();
  assert.ok(process.childPid !== undefined, "premise: the process keeps serving the other chats");
  assert.equal(h.count(/\[dgc serve exited/), 0, `a running process was logged as exited:\n${h.log()}`);
  assert.equal(h.count(/\[extension: stopping the backend/), 0, "or as stopped");
  assert.equal(h.count(new RegExp(`^\\S+ \\[extension: closed chat c1 in .*folder-1 on dgc serve pid ${process.childPid} — chat closed: `)), 1);
});

test("the process's own exit is logged once, however many chats were on it", async () => {
  const h = panel();
  command = chatsServe("serve-crash");
  const { process } = await sharedChats(h, 2);
  const pid = process.childPid;
  process.send({ type: "prompt", text: "crash" });
  assert.ok(await until(() => /\[dgc serve exited/.test(h.log())));
  await settle();
  assert.equal(h.count(new RegExp(`\\[dgc serve exited: code 3 · extension asked for it: no · up \\d+s · pid ${pid} `)), 1,
    `the exit was written once per chat:\n${h.log()}`);
  assert.equal(h.count(/serve loop ended: the fixture crashed/), 1, "and so was the process's last word");
  assert.equal(h.count(/\[extension: the background chat .* lost its backend — the fixture crashed\]/), 2,
    "each chat that was not on screen still says, once, that it lost its backend");
});

test("a chat that could not open says so once, and never that a process failed or exited", async () => {
  const h = panel();
  command = chatsServe("serve-refuses", { refuse: true });
  const process = h.provider.ensureBackend();
  assert.ok(await until(() => process.ready));
  process.completeHandshake();
  h.provider.openChatSlot(join(scratch, "refused-folder"));
  assert.ok(await until(() => /could not open a chat/.test(h.log())));
  await settle();
  assert.equal(h.count(new RegExp(`\\[extension: could not open a chat in .*refused-folder on dgc serve pid ${process.childPid}`
    + " — cwd must be an existing absolute directory\\]")), 1, h.log());
  assert.equal(h.count(/dgc serve failed to start/), 0, "a running process was logged as failing to start");
  assert.equal(h.count(/\[dgc serve exited/), 0, "and as exiting");
});

test("after the chat that started the process closes, the process's lines are still written, once", async () => {
  const h = panel();
  command = chatsServe("serve-owner-closes");
  const { process } = await sharedChats(h, 2);
  h.provider.closeChatSlot(h.provider.slots[0].id);
  assert.equal(h.count(new RegExp(`\\[extension: closed the chat in .* — chat closed: .*; dgc serve pid ${process.childPid}`
    + " stays up for 2 other chats\\]")), 1, h.log());
  assert.equal(h.count(/\[dgc serve exited|\[extension: stopping the backend/), 0);
  process.send({ type: "prompt", text: "stderr Traceback: boom-after-owner" });
  assert.ok(await until(() => /boom-after-owner/.test(h.log())), "the process's lines went with the first chat's tab");
  await settle();
  assert.equal(h.count(/boom-after-owner/), 1, h.log());

  h.provider.dispose();                               // the last chats go, and the process with them
  assert.ok(await until(() => /\[dgc serve exited: code 0 · extension asked for it: yes \(panel disposed/.test(h.log())));
  await settle();
  assert.equal(h.count(/\[extension: stopping the backend — panel disposed/), 1, h.log());
  assert.equal(h.count(/\[dgc serve exited/), 1, h.log());
});

test("restarting a shared process logs its stop and exit once", async () => {
  const h = panel();
  command = chatsServe("serve-restart");
  const { process } = await sharedChats(h, 2);
  const pid = process.childPid;
  h.provider.restart("test restart");
  assert.ok(await until(() => new RegExp(`\\[dgc serve exited: [^\\]]*restart: test restart[^\\]]*pid ${pid} `).test(h.log())));
  await settle();
  assert.equal(h.count(/\[extension: restarting the backend — test restart\]/), 1);
  assert.equal(h.count(new RegExp(`\\[extension: stopping the backend — restart: test restart \\(pid ${pid}\\)\\]`)), 1, h.log());
  assert.equal(h.count(/\[dgc serve exited/), 1, h.log());
  assert.ok(await until(() => h.count(/\[dgc serve started: pid \d+/) === 2), "the restart's new process announces itself");
});

test("with sharing off, each chat's own process logs its own lines, once each", async () => {
  share.value = false;
  const h = panel();
  command = chatsServe("serve-unshared");
  const first = h.provider.ensureBackend();
  assert.ok(await until(() => first.ready));
  first.completeHandshake();
  h.provider.openChatSlot(folder("unshared-folder"));
  const second = h.provider.backend;
  assert.equal(second.host, undefined, "premise: the second chat has a process of its own");
  assert.ok(await until(() => second.ready));
  second.completeHandshake();
  first.send({ type: "prompt", text: "stderr line-from-first" });
  second.send({ type: "prompt", text: "stderr line-from-second" });
  assert.ok(await until(() => /line-from-first/.test(h.log()) && /line-from-second/.test(h.log())));
  await settle();
  assert.equal(h.count(/line-from-first/), 1, h.log());
  assert.equal(h.count(/line-from-second/), 1, h.log());
  assert.equal(h.count(/\[dgc serve started: pid \d+/), 2);
});
