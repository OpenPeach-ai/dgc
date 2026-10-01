// Several chats on one `dgc serve`: Codex's model, every chat in its own folder.
//
// One process, many chats. The backend that started the process keeps its own chat on the plain
// "event" channel; every other chat is an OpenedChat that hears only its own events and stamps its
// id on everything it sends. What must not happen is any of one chat's state reaching another: its
// tokens, its Stop, the end of its turn. These drive the real backend and channel against a fake
// `dgc serve` that speaks the chats protocol.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "dgc-vscode-chat-channel-"));
const bundle = join(scratch, "channel.cjs");
await build({
  stdin: {
    contents: `export { DgcBackend, DGC_PROTOCOL_VERSION } from "./backend"; export { OpenedChat } from "./chatChannel";`,
    resolveDir: join(here, "../src"), loader: "ts",
  },
  bundle: true, format: "cjs", platform: "node", target: "node18", outfile: bundle, logLevel: "silent",
});
const { DgcBackend, OpenedChat, DGC_PROTOCOL_VERSION } = createRequire(import.meta.url)(bundle);
after(() => rmSync(scratch, { recursive: true, force: true }));

/** A `dgc serve` that can hold chats. It answers open_chat and close_chat, and reports every other
 *  command it receives as an `info` event in the chat that sent it, so a test can see what arrived
 *  where. `emit <json>` on a prompt's text makes it send that event verbatim. */
function chatsBackend(name, { refuse = false } = {}) {
  const path = join(scratch, name);
  writeFileSync(path, `#!/usr/bin/env node
let sequence = 0, chats = 0;
const send = (value) => process.stdout.write(JSON.stringify({ seq: sequence++, ...value }) + "\\n");
const perChat = { model: "fixture", mode: "default", think: "off", base_url: "http://127.0.0.1:1/v1",
  workspace_trusted: true, commands: [], custom_commands: [], goal: { text: "", status: "none" },
  context_size: 32768 };
send({ type: "ready", version: "fixture", protocol_version: ${DGC_PROTOCOL_VERSION},
       capabilities: { chats: { version: 1, max: 4, default: "c0" } }, ...perChat });
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\\n")) !== -1) {
    const cmd = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);
    if (cmd.type === "shutdown") { send({ type: "info", message: "shutdown" }); process.exit(0); }
    if (cmd.type === "open_chat") {
      if (${refuse}) {
        send({ type: "command_rejected", command: "open_chat", reason: "invalid_cwd",
               message: "cwd must be an existing absolute directory", request_id: cmd.request_id });
        continue;
      }
      const id = "c" + (++chats);
      send({ type: "chat_opened", chat_id: id, request_id: cmd.request_id, ...perChat, project_root: cmd.cwd });
      continue;
    }
    if (cmd.type === "close_chat") {
      send({ type: "chat_closed", chat_id: cmd.chat_id, reason: "closed", request_id: cmd.request_id });
      continue;
    }
    if (cmd.type === "prompt" && String(cmd.text || "").startsWith("emit ")) {
      send(JSON.parse(cmd.text.slice(5)));
      continue;
    }
    send({ type: "info", message: "got " + JSON.stringify(cmd), ...(cmd.chat_id ? { chat_id: cmd.chat_id } : {}) });
  }
});
`, "utf8");
  chmodSync(path, 0o700);
  return path;
}

function waitFor(emitter, name, predicate = () => true, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { emitter.off(name, handler); reject(new Error(`timed out waiting for ${name}`)); }, timeout);
    const handler = (...args) => {
      if (!predicate(...args)) return;
      clearTimeout(timer);
      emitter.off(name, handler);
      resolve(args.length > 1 ? args : args[0]);
    };
    emitter.on(name, handler);
  });
}

/** The process, ready and released, as a slot that finished its handshake leaves it. */
async function startedBackend(fixture) {
  const be = new DgcBackend(scratch, fixture);
  const ready = waitFor(be, "event", (ev) => ev.type === "ready");
  be.start();
  await ready;
  be.completeHandshake();
  return be;
}

async function openedChat(be, folder = "/srv/other-repo", id = "open-1") {
  const chat = new OpenedChat(be, folder, id);
  const ready = waitFor(chat, "event", (ev) => ev.type === "ready");
  chat.start();
  const event = await ready;
  return { chat, ready: event };
}

test("a chat opened on a shared backend is introduced with the process's own ready", async () => {
  const be = await startedBackend(chatsBackend("ready-backend"));
  try {
    assert.deepEqual(be.chats, { version: 1, max: 4, default: "c0" });
    const { chat, ready } = await openedChat(be, "/srv/other-repo");
    assert.equal(chat.chatId, "c1");
    assert.equal(ready.version, "fixture", "the version a slot checks is the process's");
    assert.deepEqual(ready.capabilities.chats, { version: 1, max: 4, default: "c0" });
    assert.equal(ready.project_root, "/srv/other-repo", "but the folder is the chat's own");
    assert.equal(ready.request_id, undefined);
    assert.ok(be.chatUsers.has(chat));
  } finally {
    be.dispose("test over");
  }
});

test("each chat hears only its own events", async () => {
  const be = await startedBackend(chatsBackend("routing-backend"));
  try {
    const { chat } = await openedChat(be);
    chat.completeHandshake();
    const first = [], second = [];
    be.on("event", (ev) => first.push(ev));
    chat.on("event", (ev) => second.push(ev));
    // Both waits armed before anything is sent: the two events can arrive in one stdout chunk.
    const arrived = waitFor(chat, "event", (ev) => ev.type === "info" && ev.message === "for c1");
    const home = waitFor(be, "event", (ev) => ev.type === "info" && ev.message === "for c0");
    be.send({ type: "prompt", text: `emit ${JSON.stringify({ type: "info", message: "for c1", chat_id: "c1" })}` });
    be.send({ type: "prompt", text: `emit ${JSON.stringify({ type: "info", message: "for c0", chat_id: "c0" })}` });
    await Promise.all([arrived, home]);
    assert.deepEqual(second.filter((ev) => ev.type === "info").map((ev) => ev.message), ["for c1"],
      "a second chat heard the first chat's event");
    assert.ok(!first.some((ev) => ev.message === "for c1"), "the first chat's transcript got another chat's event");
  } finally {
    be.dispose("test over");
  }
});

test("what a chat sends carries its id, and waits for that chat's own handshake", async () => {
  const be = await startedBackend(chatsBackend("stamp-backend"));
  try {
    const { chat } = await openedChat(be);
    const seen = [];
    chat.on("event", (ev) => { if (ev.type === "info") seen.push(ev.message); });
    assert.equal(chat.send({ type: "get_goal", request_id: "g1" }), true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(seen, [], "a user command ran before the chat's roots and settings were configured");
    const got = waitFor(chat, "event", (ev) => ev.type === "info" && ev.message.includes('"g1"'));
    chat.completeHandshake();
    const info = await got;
    assert.match(info.message, /"chat_id":"c1"/);
    const answer = chat.request({ type: "get_goal", request_id: "g2" }, "info", 2000);
    await assert.rejects(answer, /timed out|rejected/, "premise: the fixture answers with info, not a correlated reply");
  } finally {
    be.dispose("test over");
  }
});

test("a Stop in one chat keeps another chat's open approval card", async () => {
  const be = await startedBackend(chatsBackend("approval-backend"));
  try {
    const { chat } = await openedChat(be);
    chat.completeHandshake();
    const asked = waitFor(chat, "event", (ev) => ev.type === "permission_request");
    be.send({ type: "prompt", text: `emit ${JSON.stringify({ type: "permission_request", id: "r1", chat_id: "c1",
      name: "bash", args: { command: "ls" }, suggested_rule: "Bash(ls)", choices: ["once", "always", "deny"] })}` });
    await asked;
    be.send({ type: "cancel" });                     // Stop, in the chat the process started with
    const rejected = [];
    chat.on("event", (ev) => { if (ev.type === "command_rejected") rejected.push(ev.message); });
    be.on("event", (ev) => { if (ev.type === "command_rejected") rejected.push(ev.message); });
    const delivered = waitFor(chat, "event", (ev) => ev.type === "info" && ev.message.includes("permission_response"));
    assert.equal(chat.send({ type: "permission_response", id: "r1", decision: "once" }), true,
      "another chat's Stop made this chat's approval stale");
    await delivered;
    assert.deepEqual(rejected, []);
  } finally {
    be.dispose("test over");
  }
});

test("a backend whose own slot closed lives until the last chat on it closes", async () => {
  const be = await startedBackend(chatsBackend("owner-backend"));
  const { chat } = await openedChat(be);
  chat.completeHandshake();
  be.close("chat closed: First");
  assert.ok(be.childPid !== undefined, "closing the first chat ended the other chats too");
  assert.equal(be.ownerReleased, true);
  const exited = waitFor(be, "exit");
  const closed = waitFor(chat, "exit");
  chat.dispose("chat closed: Second");
  const [, , info] = await closed;
  assert.equal(info.cause, "chat closed: Second", "the chat's own end is reported as asked for");
  await exited;
  assert.equal(be.childPid, undefined, "the last chat closing stopped the process");
});

test("a chat that could not open says why, in its own slot", async () => {
  const be = await startedBackend(chatsBackend("refusing-backend", { refuse: true }));
  try {
    const leaked = [];
    be.on("event", (ev) => { if (ev.type === "command_rejected") leaked.push(ev); });
    const chat = new OpenedChat(be, "relative/dir", "open-bad");
    const failed = waitFor(chat, "launch_failed");
    const exited = waitFor(chat, "exit");
    chat.start();
    assert.match(await failed, /cwd must be an existing absolute directory/);
    await exited;
    assert.equal(chat.ready, false);
    assert.equal(be.chatUsers.size, 0);
    assert.deepEqual(leaked, [], "the refusal landed in the first chat's transcript");
  } finally {
    be.dispose("test over");
  }
});

test("the process ending ends every chat on it", async () => {
  const be = await startedBackend(chatsBackend("dying-backend"));
  const { chat } = await openedChat(be);
  const ended = waitFor(chat, "exit");
  be.dispose("test kills the process");
  await ended;
  assert.equal(chat.ready, false);
  assert.equal(be.chatUsers.size, 0);
});

// ---- closing, restarting and failing to open ---------------------------------------------------

test("closing the first chat ends its conversation and keeps the process for the others", async () => {
  const be = await startedBackend(chatsBackend("retiring-backend"));
  try {
    const { chat } = await openedChat(be);
    chat.completeHandshake();
    const asked = [];
    be.on("event", (ev) => { if (ev.type === "info") asked.push(String(ev.message)); });
    const retired = waitFor(be, "event", (ev) => ev.type === "info" && String(ev.message).includes('"new_session"'));
    be.close("chat closed: First");
    await retired;
    assert.ok(be.childPid !== undefined, "closing the first chat ended the other chats too");
    be.close("chat closed: First");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(asked.filter((line) => line.includes('"new_session"')).length, 1,
      "the first chat was retired more than once");
  } finally {
    be.dispose("test over");
  }
});

test("a chat closed before it opened is closed the moment it opens", async () => {
  const be = await startedBackend(chatsBackend("late-open-backend"));
  try {
    const chat = new OpenedChat(be, "/srv/late", "open-late");
    const closed = waitFor(be, "chat-event", (_chat, ev) => ev.type === "chat_closed");
    chat.start();
    chat.dispose("chat closed: Late");            // before chat_opened can have arrived
    const [chatId] = await closed;
    assert.equal(chatId, "c1", "the chat the backend built for this slot was never closed");
  } finally {
    be.dispose("test over");
  }
});

test("closing a chat on a process that has stopped starts no new process", async () => {
  const be = await startedBackend(chatsBackend("stopped-host-backend"));
  try {
    const { chat } = await openedChat(be);
    chat.completeHandshake();
    be.dispose("test stops the process");
    chat.dispose("chat closed: Second");           // before the process's exit is observed
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(be.childPid, undefined, "closing the chat started a new dgc serve to carry close_chat");
  } finally {
    be.dispose("test over");                       // whatever a failure started
  }
});

test("a chat whose process ended takes no more commands and has no process to wait for", async () => {
  const be = await startedBackend(chatsBackend("ended-host-backend"));
  const { chat } = await openedChat(be);
  chat.completeHandshake();
  const ended = waitFor(chat, "exit");
  be.dispose("test kills the process");
  await ended;
  assert.equal(chat.childPid, undefined);
  assert.equal(chat.send({ type: "prompt", text: "hello" }), false,
    "the prompt was taken and held for a handshake that could never come");
});

test("a chat that could not open has no process to wait for", async () => {
  const be = await startedBackend(chatsBackend("refusing-pid-backend", { refuse: true }));
  try {
    const chat = new OpenedChat(be, "relative/dir", "open-refused");
    const exited = waitFor(chat, "exit");
    chat.start();
    await exited;
    assert.ok(be.childPid !== undefined, "premise: the process itself is still running");
    assert.equal(chat.childPid, undefined, "the slot would wait for it as if it were reconnecting");
  } finally {
    be.dispose("test over");
  }
});

test("a refusal of an opened chat's command reaches that chat, not the first one", async () => {
  const be = await startedBackend(chatsBackend("refusal-routing-backend"));
  try {
    const { chat } = await openedChat(be);
    chat.completeHandshake();
    const first = [], mine = [];
    be.on("event", (ev) => { if (ev.type === "command_rejected") first.push(ev); });
    chat.on("event", (ev) => { if (ev.type === "command_rejected") mine.push(ev); });
    chat.send({ type: "permission_response", id: "settled-long-ago", decision: "once" });
    assert.equal(mine.length, 1, "the chat that answered never heard why");
    chat.send({ type: "permission_response", id: "bad", decision: "maybe" });   // fails the schema
    assert.equal(mine.length, 2, "a malformed command's refusal went elsewhere");
    assert.deepEqual(first, [], "it landed in the first chat's transcript");
  } finally {
    be.dispose("test over");
  }
});
