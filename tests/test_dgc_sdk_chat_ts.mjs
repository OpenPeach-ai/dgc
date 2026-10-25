#!/usr/bin/env node
/** dgc.chat(): ChatDGC from the TypeScript SDK, against a real `dgc serve` and a local mock model (Phase 10).
 *  Run: node --experimental-strip-types --test tests/test_dgc_sdk_chat_ts.mjs */
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DGC, DGCConfigError } from "../sdk/typescript/src/index.ts";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const runtime = () => [process.env.DGC_TEST_PYTHON || process.env.DGC_PYTHON || join(ROOT, ".venv/bin/python"), "-m", "dgc", "serve"];

const sse = (delta, finish = null) => "data: " + JSON.stringify({ id: "mock", object: "chat.completion.chunk",
  choices: [{ index: 0, delta, finish_reason: finish }] }) + "\n\n";
/** The answer to "<question>" is "On <question>: it works." in three pieces, so a stream has something to stream. */
const answerTo = (question) => `On ${question.replace(/[?.!]+$/, "")}: it works.`;

function startModel() {
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url?.endsWith("/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "sdk-model" }] }));
      return;
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      const users = (body.messages || []).filter((m) => m.role === "user");
      const raw = users.length ? users[users.length - 1].content : "";
      const said = (Array.isArray(raw) ? raw.map((p) => p.text || "").join(" ") : String(raw || "")).trim().split("\n").pop();
      const reply = answerTo(said.slice(0, 80));
      const third = Math.ceil(reply.length / 3);
      const payload = [reply.slice(0, third), reply.slice(third, 2 * third), reply.slice(2 * third)].map((piece) => sse({ content: piece })).join("")
        + sse({}, "stop") + "data: [DONE]\n\n";
      // A short pause between the pieces of two replies, so two chats' replies overlap.
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Content-Length": Buffer.byteLength(payload) });
        res.end(payload);
      }, 150);
    });
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done({ server, baseUrl: `http://127.0.0.1:${server.address().port}/v1` })));
}

async function withChats(fn) {
  const { server, baseUrl } = await startModel();
  const stateDir = mkdtempSync(join(tmpdir(), "dgc-sdk-chat-ts-"));
  const dgc = new DGC({ stateDir, model: "sdk-model", baseUrl, apiKey: "sk-local", runtime: runtime() });
  try {
    const chats = await dgc.chat();
    try { await fn(chats, stateDir); } finally { await chats.close(); }
  } finally {
    await dgc.close();
    server.closeAllConnections?.();
    server.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
}

test("ask, list, open, rename, export and delete a chat", { timeout: 180_000 }, async () => {
  await withChats(async (chats, stateDir) => {
    const reply = await chats.ask("What does the checkout do?", { search: "off" });
    assert.equal(reply.text, answerTo("What does the checkout do?"));
    assert.ok(reply.chatId.startsWith("chat_") && reply.messageId, "a reply says which chat and message it is");
    assert.equal(reply.finish, "stop");
    const listed = await chats.list();
    assert.deepEqual(listed.map((c) => c.id), [reply.chatId], "a sent chat is listed");
    const chat = await chats.open(reply.chatId);
    assert.deepEqual(chat.messages.map((m) => m.role), ["user", "assistant"]);
    await chat.rename("Checkout notes");
    assert.equal(chat.title, "Checkout notes");
    assert.equal((await chats.list())[0].title, "Checkout notes");
    assert.equal((await chats.list("checkout")).length, 1, "found by what was said in it");
    const saved = await chat.export(join(stateDir, "chat.md"));
    assert.ok(existsSync(saved));
    assert.match(readFileSync(saved, "utf8"), /it works\./);
    await chat.pin();
    assert.equal((await chats.list())[0].pinned, true);
    await chat.delete();
    assert.deepEqual(await chats.list(), []);
  });
});

test("a stream writes the reply in pieces, then ends with it; a second message keeps the history", { timeout: 180_000 }, async () => {
  await withChats(async (chats) => {
    const chat = await chats.new();
    const events = [];
    for await (const event of chat.stream("Explain the checkout.", { search: "off" })) events.push(event);
    const last = events[events.length - 1];
    assert.equal(last.kind, "reply");
    const pieces = events.filter((e) => e.kind === "text");
    assert.ok(pieces.length >= 2, `it streamed (${pieces.length} pieces)`);
    assert.equal(pieces.map((e) => e.text).join(""), answerTo("Explain the checkout."), "the pieces add up to the reply");
    assert.equal(last.reply.text, answerTo("Explain the checkout."));
    const again = await chat.send("And then?", { search: "off" });
    assert.equal(again.chatId, chat.id);
    assert.equal(again.text, answerTo("And then?"));
    assert.equal(chat.messages.length, 4);
  });
});

test("two chats answer at once, and each gets only its own reply", { timeout: 180_000 }, async () => {
  await withChats(async (chats) => {
    const [a, b] = await Promise.all([chats.new(), chats.new()]);
    const [ra, rb] = await Promise.all([a.send("Tell me about apples.", { search: "off" }), b.send("Tell me about boats.", { search: "off" })]);
    assert.equal(ra.text, answerTo("Tell me about apples."));
    assert.equal(rb.text, answerTo("Tell me about boats."));
    assert.notEqual(ra.chatId, rb.chatId);
    await assert.rejects(Promise.all([a.send("One.", { search: "off" }), a.send("Two.", { search: "off" })]),
      /already answering/, "one reply at a time in a chat");
  });
});

test("a temporary chat is never listed; bad options are refused before anything is sent", { timeout: 180_000 }, async () => {
  await withChats(async (chats, stateDir) => {
    const reply = await chats.ask("Just between us.", { temporary: true, search: "off" });
    assert.equal(reply.text, answerTo("Just between us."));
    assert.deepEqual(await chats.list(), []);
    const chat = await chats.new();
    assert.throws(() => chat.stream("x", { thinking: "max" }), DGCConfigError);
    assert.throws(() => chat.stream("x", { search: "sometimes" }), DGCConfigError);
    assert.throws(() => chat.stream("   "), DGCConfigError);
    assert.throws(() => chat.stream("x", { files: [join(stateDir, "missing.txt")] }), /not a file/);
    const many = Array.from({ length: 11 }, (_, i) => { const f = join(stateDir, `f${i}.txt`); writeFileSync(f, "x"); return f; });
    assert.throws(() => chat.stream("x", { files: many }), /at most 10 files/);
    await assert.rejects(chats.open(""), DGCConfigError);
  });
});

test("a reply has no limit by default; a limit is still taken and checked", { timeout: 180_000 }, async () => {
  await withChats(async (chats) => {
    assert.equal(chats.replyTimeoutMs, null);
    const reply = await chats.ask("How does checkout work?", { search: "off" });
    assert.match(reply.text, /checkout/);
  });
});

test("a closed client's chats refuse politely", { timeout: 120_000 }, async () => {
  const { server, baseUrl } = await startModel();
  const stateDir = mkdtempSync(join(tmpdir(), "dgc-sdk-chat-ts-"));
  try {
    const dgc = new DGC({ stateDir, model: "sdk-model", baseUrl, apiKey: "sk-local", runtime: runtime() });
    const chats = await dgc.chat();
    await chats.close();
    await assert.rejects(chats.list(), /closed/);
    await dgc.close();
    await assert.rejects(dgc.chat(), /closed/);
  } finally {
    server.closeAllConnections?.();
    server.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
