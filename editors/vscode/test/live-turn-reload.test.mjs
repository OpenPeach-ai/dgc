// A webview reloaded while a turn is waiting on the user. The REAL `dgc serve` from this checkout
// (through the extension's own DgcBackend transport) runs against an in-process model that asks a
// question with propose_options; the panel is a real webview in Chromium. The first webview shows
// the docked question; a second, fresh webview then does what panel.ts does on webviewReady
// (ready, session_ready, turn_active, get_history) and must show the SAME running turn: the
// question docked again, Stop in the composer, no "Stopped" turn and no "stopped" step. Answering
// from the reloaded webview finishes the turn.
//
// Needs Chromium (Playwright) and a Python that can import this checkout's dgc (DGC_TEST_PYTHON;
// otherwise the interpreter behind `dgc` on PATH, then python3). DGC_REQUIRE_CHROMIUM=1 turns a
// missing browser or Python into a failure instead of a skip. DGC_LIVE_RELOAD_SHOTS=<dir> saves
// screenshots of both webviews.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { THEMES, panelHtml } from "./support/options-scene.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }

function pickPython() {
  const candidates = [process.env.DGC_TEST_PYTHON];
  for (const dir of String(process.env.PATH || "").split(delimiter)) {
    const launcher = join(dir, "dgc");
    if (!dir || !existsSync(launcher)) continue;
    const first = readFileSync(launcher, "utf8").split("\n", 1)[0];
    if (first.startsWith("#!") && /python/.test(first)) candidates.push(first.slice(2).trim().split(/\s+/)[0]);
    break;
  }
  candidates.push("python3");
  for (const python of candidates.filter(Boolean)) {
    const probe = spawnSync(python, ["-c", "import requests, prompt_toolkit, rich"], { stdio: "ignore" });
    if (probe.status === 0) return python;
  }
  return "";
}

let browser, python = "", scratch = "", DgcBackend = null;
const skipReason = () => (!chromium ? "playwright is not installed (npm ci at the repository root)"
  : !browser ? "Chromium could not start" : !python ? "no Python with DGC's dependencies (set DGC_TEST_PYTHON)" : "");
const skipOrFail = (t) => {
  if (!skipReason()) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${skipReason()}`);
  t.skip(skipReason());
  return true;
};

before(async () => {
  python = pickPython();
  scratch = mkdtempSync(join(tmpdir(), "dgc-live-reload-"));
  const bundle = join(scratch, "backend.cjs");
  await build({ entryPoints: [join(here, "../src/backend.ts")], bundle: true, format: "cjs", platform: "node",
    target: "node18", outfile: bundle, logLevel: "silent" });
  ({ DgcBackend } = createRequire(import.meta.url)(bundle));
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }); } catch { browser = null; }
});
after(async () => {
  await browser?.close();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

// ---- the model: a question for TURN_ASK, then an answer once the question has a result -----------
const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const chunk = (delta, finish = null) => sse({ id: "m", object: "chat.completion.chunk", model: "mock-model",
  choices: [{ index: 0, delta, finish_reason: finish }] });
const QUESTION = { questions: [{ header: "Database", question: "Which database should the cache use?", options: [
  { label: "SQLite (Recommended)", description: "One file, nothing to run." },
  { label: "Postgres", description: "A server to operate." }] }] };

function modelServer() {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => { raw += d; });
    req.on("end", () => {
      if (req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "mock-model" }] }));
        return;
      }
      let body = {};
      try { body = JSON.parse(raw || "{}"); } catch { body = {}; }
      const msgs = Array.isArray(body.messages) ? body.messages : [];
      const prompt = msgs.map((m) => (m.role === "user" && typeof m.content === "string" ? m.content : "")).findLastIndex((c) => c.trimStart().startsWith("TURN_"));
      const answered = prompt >= 0 && msgs.slice(prompt + 1).some((m) => m.role === "tool");
      res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "close" });
      if (!body.tools || prompt < 0) { res.end(chunk({ content: "Title" }) + chunk({}, "stop") + "data: [DONE]\n\n"); return; }
      const text = msgs.filter((m) => m.role === "user" && typeof m.content === "string").at(-1)?.content.trimStart() || "";
      if (text.startsWith("TURN_BATCH")) {
        if (answered && msgs.slice(prompt + 1).filter((m) => m.role === "tool").length >= 2) {
          res.end(chunk({ content: "Checked and ran." }) + chunk({}, "stop") + "data: [DONE]\n\n"); return;
        }
        res.end(chunk({ tool_calls: [
          { index: 0, id: "call_read_1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "README.md" }) } },
          { index: 1, id: "call_bash_2", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "echo verified > proof.txt" }) } }] })
          + chunk({}, "tool_calls") + "data: [DONE]\n\n");
        return;
      }
      if (text.startsWith("TURN_STREAM")) {
        (async () => {
          for (let i = 0; i < 30; i++) { res.write(chunk({ content: `word${i} ` })); await sleep(80); }
          res.end(chunk({}, "stop") + "data: [DONE]\n\n");
        })();
        return;
      }
      if (answered) { res.end(chunk({ content: "SQLite it is." }) + chunk({}, "stop") + "data: [DONE]\n\n"); return; }
      res.end(chunk({ tool_calls: [{ index: 0, id: "call_ask_1", type: "function",
        function: { name: "propose_options", arguments: JSON.stringify(QUESTION) } }] })
        + chunk({}, "tool_calls") + "data: [DONE]\n\n");
    });
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, timeout = 30_000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

async function openWebview(onPost) {
  const { html, mainJs, markdownJs } = panelHtml();
  const page = await browser.newPage({ viewport: { width: 460, height: 760 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.exposeFunction("__hostPost", (m) => onPost(m));
  await page.setContent(html, { waitUntil: "load" });
  await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; --vscode-editor-font-family: ui-monospace, monospace; ${THEMES["dark-modern"]} }` });
  await page.evaluate(() => document.body.classList.add("vscode-dark"));
  await page.evaluate(([mjs, mdjs]) => {
    window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__hostPost(m), getState: () => undefined, setState() {} });
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(mjs);
  }, [mainJs, markdownJs]);
  const post = (data) => page.evaluate((d) => window.dispatchEvent(new MessageEvent("message", { data: d })), data);
  return { page, errors, post };
}

const facts = (page) => page.evaluate(() => {
  const blocks = [...document.querySelectorAll("#log .msg.dgc")];
  const last = blocks.at(-1);
  const ask = document.querySelector("#cbox > .ask");
  const card = last?.querySelector('.tool[data-tool-name="propose_options"]');
  return {
    docked: !!ask, askRequest: ask?.dataset.requestId || "",
    send: document.getElementById("send").getAttribute("aria-label"),
    blocks: blocks.length, users: [...document.querySelectorAll("#log .msg.user .bubble")].map((b) => b.textContent),
    act: last?.querySelector(".thinking")?.textContent.trim() || "",
    done: !!last?.querySelector(".thinking.done"),
    cardStatus: card?.dataset.status || "", cardArg: card?.querySelector(".arg")?.textContent || "",
    stopped: /Stopped|stopped/.test(last?.innerText || ""),
  };
});

test("a webview reloaded while a question is docked shows the running turn, and answering it finishes the turn", async (t) => {
  if (skipOrFail(t)) return;
  const model = await modelServer();
  const home = join(scratch, "home"), work = join(scratch, "work");
  mkdirSync(join(home, ".dgc"), { recursive: true }); mkdirSync(work, { recursive: true });
  writeFileSync(join(work, "README.md"), "fixture\n");
  writeFileSync(join(home, ".dgc", "config.json"), JSON.stringify({
    base_url: `http://127.0.0.1:${model.address().port}/v1`, model: "mock-model", api_key: "sk-fixture-0123456789abcdef",
    api_mode: "chat_completions", suggest: false, notes: false, mode: "default", artifact_autostart: false, eta: false }));
  const wrapper = join(scratch, "dgc-real");
  const q = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
  writeFileSync(wrapper, ["#!/bin/sh", `export HOME=${q(home)} XDG_CONFIG_HOME=${q(home)} XDG_DATA_HOME=${q(home)} XDG_STATE_HOME=${q(home)} XDG_CACHE_HOME=${q(home)}`,
    `export PYTHONPATH=${q(repoRoot)} PYTHONDONTWRITEBYTECODE=1 NO_COLOR=1`, "unset OPENAI_API_KEY ANTHROPIC_API_KEY",
    `exec ${q(python)} -m dgc "$@"`].join("\n") + "\n");
  chmodSync(wrapper, 0o700);

  const backend = new DgcBackend(work, wrapper);
  const events = [], failures = [];
  let views = [], ready = null, liveTurn = null, sessionName = "";
  backend.on("event", (ev) => {
    events.push(ev);
    if (ev.type === "ready") ready = ev;
    if (ev.type === "session_named") sessionName = ev.name;
    if (ev.type === "turn_start") liveTurn = { turnId: ev.turn_id, kind: ev.kind || "prompt", prompt: ev.prompt || "", startedAt: Date.now(), handoff: false };
    if (ev.type === "turn_end") liveTurn = null;
    // The transport's own verdicts: a protocol failure, or a command it refused to send.
    if ((ev.type === "error" && ev.protocol_error) || (ev.type === "command_rejected" && !ev.command)) failures.push(ev.message);
    for (const view of views) view.post({ type: "event", event: ev }).catch(() => {});
  });
  const host = (msg) => {
    if (msg?.type === "options_response") {
      backend.send({ type: "options_response", id: msg.id, ...(msg.dismissed === true ? { dismissed: true } : { answers: msg.answers }) });
    } else if (msg?.type === "cancel") backend.send({ type: "cancel" });
    else if (msg?.type === "getRecall") backend.send({ type: "get_recall", limit: 50 });
  };
  const shots = process.env.DGC_LIVE_RELOAD_SHOTS;
  if (shots) mkdirSync(shots, { recursive: true });
  let first, second;
  try {
    backend.start();
    await until(() => ready, "ready");
    backend.completeHandshake();
    first = await openWebview(host);
    await first.post({ type: "event", event: ready });
    await first.post({ type: "session_ready", sessionId: ready.session_id });
    views = [first];
    assert.equal(backend.send({ type: "prompt", text: "TURN_ASK pick a database for the cache", request_id: "p1" }), true);
    await until(async () => (await facts(first.page)).docked, "the question docked in the first webview");
    const before = await facts(first.page);
    if (shots) await first.page.screenshot({ path: join(shots, "before-reload.png") });
    const asked = events.find((e) => e.type === "options_request");
    assert.equal(before.askRequest, asked.id);

    // Reload: a fresh webview, driven the way panel.ts drives one on webviewReady.
    views = [];
    await first.page.close(); first = null;
    second = await openWebview(host);
    await second.post({ type: "event", event: { ...ready, session_id: ready.session_id, session_name: sessionName } });
    await second.post({ type: "session_ready", sessionId: ready.session_id });
    views = [second];
    const seen = events.length;
    assert.equal(backend.send({ type: "get_history", request_id: "restore-history-1" }), true);
    assert.ok(liveTurn, "the turn is still running");
    await second.post({ type: "turn_active", ...liveTurn, history: true });
    await until(() => events.slice(seen).some((e) => e.type === "options_request"), "the re-announced question");
    const reloaded = await until(async () => { const f = await facts(second.page); return f.docked ? f : null; },
      "the question docked in the reloaded webview");
    if (shots) await second.page.screenshot({ path: join(shots, "after-reload.png") });
    assert.deepEqual(failures, [], "the transport accepted the re-announced request");
    assert.equal(reloaded.askRequest, asked.id, "the same request is docked again");
    assert.equal(reloaded.send, "Stop generation", "the composer offers Stop, not Send");
    assert.equal(reloaded.done, false, "the turn is not settled");
    assert.equal(reloaded.stopped, false, `nothing reads stopped (${reloaded.act})`);
    assert.equal(reloaded.cardStatus, "running", "the question step is still running");
    assert.equal(reloaded.cardArg, before.cardArg, "the question step reads as it did before the reload");
    assert.deepEqual(reloaded.users, ["TURN_ASK pick a database for the cache"], "the prompt shows once");
    assert.equal(reloaded.blocks, 1);

    // Answer from the reloaded webview: Enter submits the preselected recommendation.
    await sleep(450);                        // the card's key guard
    await second.page.keyboard.press("Enter");
    const ended = await until(() => events.find((e) => e.type === "turn_end"), "turn_end", 30_000);
    assert.equal(ended.reason, "completed");
    const settled = await until(async () => { const f = await facts(second.page); return f.done ? f : null; }, "the turn settles");
    if (shots) await second.page.screenshot({ path: join(shots, "after-answer.png") });
    assert.equal(settled.docked, false);
    assert.equal(settled.send, "Send message");
    assert.match(settled.act, /^Worked for \d+s$/);
    assert.equal(await second.page.locator("#log .msg.dgc .answer.complete").count(), 1, "the answer is the turn's final answer");
    const resolved = events.filter((e) => e.type === "options_resolved");
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].outcome, "answered");
    assert.deepEqual([...second.errors], []);
  } finally {
    views = [];
    await first?.page.close().catch(() => {});
    await second?.page.close().catch(() => {});
    backend.dispose("test finished");
    await sleep(300);
    model.close();
  }
});

// The same reload for a step waiting on its permission card, and for an answer still streaming. Each
// runs a real `dgc serve`; the reloaded webview is sent live events from the moment it opens, before it
// has said it is ready, the way the extension forwards them.
async function liveSession(name, onEvent = () => {}) {
  const model = await modelServer();
  const base = join(scratch, name), home = join(base, "home"), work = join(base, "work");
  mkdirSync(join(home, ".dgc"), { recursive: true }); mkdirSync(work, { recursive: true });
  writeFileSync(join(work, "README.md"), "fixture\n");
  writeFileSync(join(home, ".dgc", "config.json"), JSON.stringify({
    base_url: `http://127.0.0.1:${model.address().port}/v1`, model: "mock-model", api_key: "sk-fixture-0123456789abcdef",
    api_mode: "chat_completions", suggest: false, notes: false, mode: "default", artifact_autostart: false, eta: false }));
  const wrapper = join(base, "dgc-real");
  const q = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
  writeFileSync(wrapper, ["#!/bin/sh", `export HOME=${q(home)} XDG_CONFIG_HOME=${q(home)} XDG_DATA_HOME=${q(home)} XDG_STATE_HOME=${q(home)} XDG_CACHE_HOME=${q(home)}`,
    `export PYTHONPATH=${q(repoRoot)} PYTHONDONTWRITEBYTECODE=1 NO_COLOR=1`, "unset OPENAI_API_KEY ANTHROPIC_API_KEY",
    `exec ${q(python)} -m dgc "$@"`].join("\n") + "\n");
  chmodSync(wrapper, 0o700);
  const backend = new DgcBackend(work, wrapper);
  const s = { backend, work, events: [], failures: [], views: [], ready: null, liveTurn: null, model };
  backend.on("event", (ev) => {
    s.events.push(ev);
    if (ev.type === "ready") s.ready = ev;
    if (ev.type === "turn_start") s.liveTurn = { turnId: ev.turn_id, kind: ev.kind || "prompt", prompt: ev.prompt || "", startedAt: Date.now(), handoff: false };
    if (ev.type === "turn_end") s.liveTurn = null;
    if ((ev.type === "error" && ev.protocol_error) || (ev.type === "command_rejected" && !ev.command)) s.failures.push(ev.message);
    onEvent(ev);
    for (const view of s.views) view.post({ type: "event", event: ev }).catch(() => {});
  });
  s.host = (msg) => {
    if (msg?.type === "permission_response") backend.send({ type: "permission_response", id: msg.id, decision: msg.decision });
    else if (msg?.type === "cancel") backend.send({ type: "cancel" });
    else if (msg?.type === "getRecall") backend.send({ type: "get_recall", limit: 50 });
  };
  backend.start();
  await until(() => s.ready, "ready");
  backend.completeHandshake();
  s.open = async () => {
    const view = await openWebview(s.host);
    await view.post({ type: "event", event: s.ready });
    await view.post({ type: "session_ready", sessionId: s.ready.session_id });
    s.views = [view];
    return view;
  };
  // What panel.ts does for a webview that loads while a turn runs: events flow from the start, then
  // on webviewReady it posts ready and session_ready, asks for the snapshot and says a turn is running.
  s.reload = async (old, beforeReady = 0) => {
    s.views = [];
    await old.page.close();
    const view = await openWebview(s.host);
    s.views = [view];
    if (beforeReady) await sleep(beforeReady);
    await view.post({ type: "event", event: s.ready });
    await view.post({ type: "session_ready", sessionId: s.ready.session_id });
    const seen = s.events.length;
    assert.equal(backend.send({ type: "get_history", request_id: `restore-history-${seen}` }), true);
    if (s.liveTurn) await view.post({ type: "turn_active", ...s.liveTurn, history: true });
    return { view, seen };
  };
  s.close = async () => {
    for (const view of s.views) await view.page.close().catch(() => {});
    s.views = [];
    backend.dispose("test finished");
    await sleep(300);
    model.close();
  };
  return s;
}

const turnFacts = (page) => page.evaluate(() => {
  const blocks = [...document.querySelectorAll("#log .msg.dgc")];
  const last = blocks.at(-1);
  return {
    send: document.getElementById("send").getAttribute("aria-label"),
    blocks: blocks.length, users: [...document.querySelectorAll("#log .msg.user .bubble")].map((b) => b.textContent),
    act: last?.querySelector(".thinking")?.textContent.trim() || "",
    done: !!last?.querySelector(".thinking.done"),
    tools: [...(last?.querySelectorAll(".tool") || [])].map((node) => `${node.dataset.toolName}:${node.dataset.status}`),
    cards: [...document.querySelectorAll(".card[data-request-id]:not(.resolved)")].map((card) => card.dataset.requestId),
    text: (last?.innerText || "").replace(/\s+/g, " "),
  };
});

test("a webview reloaded while a step waits on its permission card draws that step once, and approving it finishes cleanly", async (t) => {
  if (skipOrFail(t)) return;
  const shots = process.env.DGC_LIVE_RELOAD_SHOTS;
  if (shots) mkdirSync(shots, { recursive: true });
  const s = await liveSession("permission");
  try {
    const first = await s.open();
    assert.equal(s.backend.send({ type: "prompt", text: "TURN_BATCH read then write", request_id: "p1" }), true);
    const asked = await until(() => s.events.find((e) => e.type === "permission_request"), "the permission request");
    const before = await until(async () => { const f = await turnFacts(first.page); return f.cards.length ? f : null; }, "the card");
    assert.deepEqual(before.tools, ["read_file:completed"], "live: the waiting step has no row");
    const { view, seen } = await s.reload(first, 150);
    await until(() => s.events.slice(seen).some((e) => e.type === "permission_request"), "the re-announced permission");
    const reloaded = await until(async () => { const f = await turnFacts(view.page); return f.cards.length ? f : null; }, "the card after the reload");
    await sleep(300);
    const settledView = await turnFacts(view.page);
    if (shots) await view.page.screenshot({ path: join(shots, "permission-after-reload.png") });
    assert.deepEqual(s.failures, []);
    assert.deepEqual(reloaded.cards, [String(asked.id)]);
    assert.deepEqual(settledView.tools, before.tools, "the reloaded turn shows the rows the live one did");
    assert.equal(settledView.send, "Stop generation");
    assert.equal(settledView.blocks, 1);
    assert.doesNotMatch(settledView.text, /stopped/i);
    await view.page.locator(`.card[data-request-id="${asked.id}"] button[data-d="once"]`).click();
    const ended = await until(() => s.events.find((e) => e.type === "turn_end"), "turn_end");
    assert.equal(ended.reason, "completed");
    const done = await until(async () => { const f = await turnFacts(view.page); return f.done ? f : null; }, "the turn settles");
    if (shots) await view.page.screenshot({ path: join(shots, "permission-approved.png") });
    assert.deepEqual(done.tools, ["read_file:completed", "bash:completed"], "one row per step, none stopped");
    assert.doesNotMatch(done.text, /stopped|issue/i, done.text);
    assert.match(done.act, /^Worked for \d+s$/);
    assert.equal(done.send, "Send message");
    assert.equal(readFileSync(join(s.work, "proof.txt"), "utf8").trim(), "verified");
    assert.deepEqual([...view.errors], []);
  } finally {
    await s.close();
  }
});

test("a webview reloaded while the answer streams keeps one turn, and the rest of the answer lands in it", async (t) => {
  if (skipOrFail(t)) return;
  const shots = process.env.DGC_LIVE_RELOAD_SHOTS;
  if (shots) mkdirSync(shots, { recursive: true });
  const s = await liveSession("stream");
  try {
    const first = await s.open();
    assert.equal(s.backend.send({ type: "prompt", text: "TURN_STREAM tell me", request_id: "p1" }), true);
    await until(() => s.events.filter((e) => e.type === "text_delta").length >= 4, "the answer streaming");
    // Live events reach the new webview for a moment before it says it is ready.
    const { view } = await s.reload(first, 250);
    await sleep(600);
    const mid = await turnFacts(view.page);
    if (shots) await view.page.screenshot({ path: join(shots, "stream-after-reload.png") });
    assert.equal(mid.blocks, 1, JSON.stringify(mid));
    assert.deepEqual(mid.users, ["TURN_STREAM tell me"]);
    assert.equal(mid.send, "Stop generation");
    assert.equal(mid.done, false);
    const ended = await until(() => s.events.find((e) => e.type === "turn_end"), "turn_end");
    assert.equal(ended.reason, "completed");
    const done = await until(async () => { const f = await turnFacts(view.page); return f.done ? f : null; }, "the turn settles");
    if (shots) await view.page.screenshot({ path: join(shots, "stream-finished.png") });
    assert.equal(done.blocks, 1, JSON.stringify(done));
    assert.match(done.text, /word29/);
    const words = done.text.match(/word\d+/g) || [];
    assert.equal(new Set(words).size, words.length, "no word is shown twice");
    assert.match(done.act, /^Worked for \d+s$/);
    assert.equal(done.send, "Send message");
    assert.deepEqual([...view.errors], []);
  } finally {
    await s.close();
  }
});
