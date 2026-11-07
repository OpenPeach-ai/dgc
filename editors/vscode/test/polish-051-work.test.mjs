// The morning live check's fixes on the Work side of 0.51.0, the parts that are the page's and the renderer's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { buildSync } from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { makeDom } from "./support/webview-dom.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const bundled = buildSync({ entryPoints: [here + "../src/markdown.ts"], bundle: true,
  format: "cjs", write: false, platform: "node" }).outputFiles[0].text;
const md = (() => {
  const module = { exports: {} };
  new Function("module", "exports", "require", bundled)(module, module.exports, createRequire(import.meta.url));
  return module.exports;
})();
md.setFavicons?.(false);
const button = (html) => /<button[^>]*class="md-link"[^>]*>/.exec(html)?.[0] || "";

// ---- item 4: a file link with a line range ---------------------------------------------------------------------------
test("a file link with a range is a link, in every form a model writes one", () => {
  for (const [source, target, line, end] of [
    ["[billing.py](billing.py:9-12)", "billing.py", "9", "12"],
    ["[b](src/billing.py:9)", "src/billing.py", "9", undefined],
    ["[b](billing.py:3:7)", "billing.py", "3", undefined],
    ["[b](billing.py#L40)", "billing.py", "40", undefined],
    ["[b](billing.py#L9-L12)", "billing.py", "9", "12"],
    ["[b](billing.py#L9-12)", "billing.py", "9", "12"],
    ["[notes](my notes.md:9-12)", "my notes.md", "9", "12"],
    ["[notes](my%20notes.md:4)", "my notes.md", "4", undefined],
    ["[plain](README.md)", "README.md", undefined, undefined],
  ]) {
    const tag = button(md.render(source));
    assert.ok(tag.includes('data-link-kind="file"'), `${source}: ${tag}`);
    assert.ok(tag.includes(`data-target="${target}"`), `${source}: ${tag}`);
    assert.equal(/data-line="(\d+)"/.exec(tag)?.[1], line, source);
    assert.equal(/data-end-line="(\d+)"/.exec(tag)?.[1], end, source);
  }
});

test("what a link carries reads back as what it was drawn from", () => {
  assert.deepEqual(md.linkOf({ target: "billing.py", line: "9", endLine: "12" }), { kind: "file", target: "billing.py", line: 9, endLine: 12 });
  assert.deepEqual(md.linkOf({ target: "my notes.md", line: "4" }), { kind: "file", target: "my notes.md", line: 4 });
  assert.deepEqual(md.linkOf({ target: "README.md" }), { kind: "file", target: "README.md" });
  assert.equal(md.linkTarget("a.py:12-9").endLine, undefined, "a backward range is its first line");
});

test("a scheme or a URL never becomes a file, spaces or no spaces", () => {
  for (const source of ["[a](javascript:alert(1))", "[a](javascript: alert(1))", "[a](JAVASCRIPT:alert(1):3)", "[a](data:text/html,x)",
    "[a](data: text/html,x:3)", "[a](vbscript:x)", "[a](file:///etc/passwd:1)", "[a](command:workbench.action.reloadWindow)",
    "[a](vscode://x/y:1-2)", "[a](foo: bar.py:1)"]) {
    const html = md.render(source);
    assert.equal(button(html), "", `${source}: ${html}`);
    assert.ok(html.includes("["), `stays the text it was: ${html}`);
  }
  const web = md.render("[site](https://example.com/a:9-12)");
  assert.ok(button(web).includes('data-link-kind="external"'), web);
  assert.equal(button(md.render("[note](see the docs)")), "", "words with spaces aren't a file");
  assert.equal(button(md.render('[t](a.md "a title")')).includes('data-target="a.md"'), true, "a title stays the ordinary rule's");
});

// ---- item 15: a numbered run under a line of text ---------------------------------------------------------------------
const olOf = (html) => [...html.matchAll(/<ol( start="(\d+)")?>([\s\S]*?)<\/ol>/g)]
  .map((m) => ({ start: m[2] || "1", values: [...m[3].matchAll(/<li value="(\d+)"/g)].map((v) => v[1]) }));

test("a numbered run right under a bold line is a list, with its own numbers", () => {
  const html = md.render("**Heading**\n1. **a**\n2. b\n\n**Second heading**\n5. **e**\n6. f\n7. g\n8. h\n9. i\n10. j");
  assert.deepEqual(olOf(html), [{ start: "1", values: ["1", "2"] }, { start: "5", values: ["5", "6", "7", "8", "9", "10"] }]);
  assert.match(html, /<p><strong>Second heading<\/strong><\/p>/, "the heading is its own paragraph");
});

test("a list keeps its numbers: one starting at 7, one that skips", () => {
  assert.deepEqual(olOf(md.render("7. a\n8. b")), [{ start: "7", values: ["7", "8"] }]);
  assert.deepEqual(olOf(md.render("1. a\n2. b\n4. c")), [{ start: "1", values: ["1", "2", "4"] }]);
  assert.deepEqual(olOf(md.render("Text\n3) a\n4) b")), [{ start: "3", values: ["3", "4"] }]);
});

test("the run may have an item that runs on, or a blank line between", () => {
  assert.deepEqual(olOf(md.render("**H**\n5. e\n   more of e\n6. f")), [{ start: "5", values: ["5", "6"] }]);
  assert.deepEqual(olOf(md.render("**H**\n5. e\n\n6. f")), [{ start: "5", values: ["5", "6"] }]);
});

test("one numbered line in a paragraph stays a sentence; descending numbers too", () => {
  for (const text of ["Intro\n2026. was a good year", "Intro\n2026. was a good year\nAnd more", "Intro\n5. first\n3. second"]) {
    assert.deepEqual(olOf(md.render(text)), [], text);
    assert.match(md.render(text), /^<p>/, text);
  }
});

test("never inside code", () => {
  const fenced = md.render("```\nHeading\n5. a\n6. b\n```");
  assert.deepEqual(olOf(fenced), []);
  assert.match(fenced, /5\. a\n6\. b/);
  const indented = md.render("Text\n\n    Heading\n    5. a\n    6. b");
  assert.deepEqual(olOf(indented), []);
});

test("inside a quote and a list item it works the same", () => {
  assert.deepEqual(olOf(md.render("> **H**\n> 5. a\n> 6. b")), [{ start: "5", values: ["5", "6"] }]);
  assert.deepEqual(olOf(md.render("- item\n  5. a\n  6. b")), [{ start: "5", values: ["5", "6"] }]);
});

// ---- item 2: a failed model request in a person's words -----------------------------------------------------------------
const RAW = "The model didn't answer: HTTP 404 from http://localhost:11434/v1/chat/completions: {\"error\":{\"message\":\"model 'qwen3:8b' not found\",\"type\":\"not_found_error\"}}";
test("no raw JSON and no URL in the words; the detail keeps them", () => {
  const f = md.modelFailure(RAW);
  assert.equal(f.kind, "model_not_found");
  assert.equal(f.headline, "The model qwen3:8b isn't available.");
  assert.equal(f.fix, true);
  assert.equal(f.detail, RAW);
  for (const text of [f.headline, f.next]) { assert.doesNotMatch(text, /http|\{|404/); }
});
test("each failure has its words, and only a model's failure is touched", () => {
  const kind = (text) => md.modelFailure(text)?.kind ?? null;
  assert.equal(kind("HTTP 401 from http://h/v1: nope"), "auth");
  assert.equal(kind("HTTP 403 from Anthropic Messages: {}"), "auth");
  assert.equal(kind("HTTP 429 from http://h/v1: slow down"), "rate_limited");
  assert.equal(kind("HTTP 503 from http://h/v1 after 3 tries: busy"), "overloaded");
  assert.equal(kind("HTTP 500 from http://h/v1: boom"), "http");
  assert.equal(kind("HTTP 400 from http://h/v1: bad"), "other");
  assert.equal(kind("The model didn't answer: connection refused by 127.0.0.1:1"), "connect");
  assert.equal(kind("cannot connect to http://127.0.0.1:18890/v1 — is your local LLM server running? (/connect <url> to change it) HTTPConnectionPool(host='127.0.0.1', port=18890): Max retries"), "connect");
  assert.equal(kind("The model didn't answer: something odd"), "other");
  assert.equal(kind("Not run: this Pip follows DGC's default model"), null);
  assert.equal(kind("The plugin said HTTP 404 from https://x.y"), null, "someone else's sentence");
  assert.equal(kind("It stopped after 12 steps without finishing."), null);
  assert.equal(md.modelWords("no_provider").fix, true);
  for (const name of ["connect", "dns", "tls", "proxy", "reset", "connect_timeout"]) assert.equal(md.modelWords(name).fix, true, name);
  assert.equal(md.modelWords("rate_limited").fix, false);
});

// ---- item 2, the page: Work with no provider --------------------------------------------------------------------------
function work() {
  const x = makeDom();
  x.send({ type: "event", event: { type: "ready", capabilities: {} } });
  return x;
}
const stateOf = (extra) => ({ type: "state", state: { model: "qwen3:8b", mode: "default", think: "off", goal: { text: "", status: "none" }, ...extra } });

test("no provider: the button says so, goes to Settings, and a send stays in the box", () => {
  const x = work();
  x.send(stateOf({ noProvider: true }));
  const name = x.doc.getElementById("modelname");
  assert.equal(name.textContent, "No provider");
  assert.equal(x.doc.getElementById("pmodel")?.textContent ?? "No provider", "No provider");
  x.posted.length = 0;
  x.doc.getElementById("btn-model").click();
  assert.deepEqual(JSON.parse(JSON.stringify(x.posted)), [{ type: "openSettings", section: "models" }]);
  assert.ok(x.doc.getElementById("modelmenu").hidden, "no menu of models that may not exist");
});

test("a saved provider sees what it saw", () => {
  const x = work();
  x.send(stateOf({ noProvider: false, model: "deepseek-v4.1-flash:cloud" }));
  assert.equal(x.doc.getElementById("modelname").textContent, "deepseek-v4.1-flash:cloud");
  assert.equal(x.doc.getElementById("btn-model").classList.contains("no-provider"), false);
  x.posted.length = 0;
  x.doc.getElementById("btn-model").click();
  assert.ok(x.posted.some((m) => m.type === "listModels"));
});

// ---- item 1: a refusal in the chat never names a method ----------------------------------------------------------------
test("a command refused mid-turn says so in plain words, whatever an older CLI wrote", () => {
  const x = work();
  x.send({ type: "event", event: { type: "command_rejected", command: "reload_skills", reason: "turn_in_progress",
    message: "'reload_skills' is unavailable while a turn is running; cancel or wait" } });
  const line = [...x.doc.querySelectorAll(".sys.err")].at(-1);
  assert.equal(line.textContent, "That can't be done while a reply is running. Stop it or wait for it to finish.");
});


// ---- item 13: VS Code's paste is an execCommand, and Chromium refuses and logs one inside another --------------------------
let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
test("an editing command inside another returns false, with nothing in the console", async (t) => {
  let browser = null;
  try { browser = chromium ? await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }) : null; } catch { browser = null; }
  if (!browser) {
    if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail("DGC_REQUIRE_CHROMIUM=1: Chromium could not start");
    t.skip("Chromium could not start");
    return;
  }
  try {
    const { openPanel } = await import("./support/reconnect-scene.mjs");
    const panel = await openPanel(browser, { width: 460, theme: "dark" });
    const warned = [];
    panel.page.on("console", (message) => { if (/called recursively/.test(message.text())) warned.push(message.text()); });
    const nested = await panel.page.evaluate(async () => {
      const box = document.getElementById("input");
      box.focus();
      let inner = "never";
      const once = () => { box.removeEventListener("input", once, true); inner = document.execCommand("insertText", false, "y"); };
      box.addEventListener("input", once, true);
      const outer = document.execCommand("insertText", false, "x");
      await new Promise((r) => setTimeout(r, 50));
      return { outer, inner, text: box.textContent };
    });
    await panel.page.waitForTimeout(100);
    assert.equal(nested.outer, true, "the outer command runs");
    assert.equal(nested.inner, false, "the inner one is refused, as Chromium would");
    assert.equal(nested.text, "x");
    assert.deepEqual(warned, [], "no warning for every paste");
    await panel.page.close();
  } finally { await browser.close(); }
});

// ---- item 9: a steered turn keeps its Worked for line, with steps or without ------------------------------------------------
const READY = { type: "ready", version: "1", protocol_version: 14, model: "m", mode: "default", think: "off", session_id: "s", commands: [], custom_commands: [], goal: { text: "", status: "none" }, capabilities: { live_steering: true, steering_native: true } };
function steered(withSteps) {
  const v = makeDom();
  const event = (e) => v.send({ type: "event", event: e });
  event(READY);
  event({ type: "turn_start", turn_id: "t1", prompt: "write", kind: "prompt" });
  if (withSteps) { event({ type: "tool_call", call_id: "c1", name: "read_file", args: { path: "a" }, summary: "a" }); event({ type: "tool_result", call_id: "c1", name: "read_file", output: "x", is_error: false, is_diff: false, diff: "" }); }
  event({ type: "text_delta", text: "Peas are good. ".repeat(300) });
  const win = v.doc.defaultView, input = v.doc.getElementById("input");
  input.value = "Also beans"; input.dispatchEvent(new win.Event("input", { bubbles: true }));
  input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  const id = v.posted.filter((m) => m.type === "prompt").at(-1).requestId;
  event({ type: "prompt_accepted", request_id: id, state: "steered" });
  event({ type: "stream_end", message_id: "m1", phase: "commentary" });
  event({ type: "steering_update", request_id: id, state: "applied" });
  event({ type: "text_delta", text: "Fold it in." });
  event({ type: "stream_end", message_id: "m2", phase: "answer" });
  event({ type: "turn_end", turn_id: "t1", reason: "completed", token_estimate: 1, final_message_id: "m2" });
  return [...v.doc.querySelectorAll("#log .msg.dgc > .thinking.done")].map((n) => n.textContent);
}
test("a steered turn says how long it worked, with no steps and with steps", () => {
  const plain = steered(false);
  assert.equal(plain.length, 1, JSON.stringify(plain));
  assert.match(plain[0], /^Worked for /);
  const stepped = steered(true);
  assert.ok(stepped.length >= 1, JSON.stringify(stepped));
  assert.match(stepped[0], /^Worked/);
});

// ---- item 8: the Trace the turn's end drew is the one a reload draws ----------------------------------------------------------
const SAVED = { v: 1, ms: 4240, id: "t1", model: "deepseek-v4.1-flash:cloud", steps: [
  { kind: "model", label: "model.response", start: 0, end: 1290, tokens: 13722 },
  { kind: "tool", label: "grep", start: 1290, end: 1414, hits: 4, detail: "subtotal" },
  { kind: "tool", label: "read_file", start: 1290, end: 1424, detail: "billing.py" },
  { kind: "tool", label: "read_file", start: 1290, end: 1440, error: true, detail: "no_such_file.py" },
  { kind: "model", label: "model.response", start: 1440, end: 4240, tokens: 14065 }] };
function traceOf(v) {
  v.doc.querySelector(".ract-trace").click();
  const out = { title: v.doc.querySelector(".dgc-trace-head strong")?.textContent, model: v.doc.querySelector(".dgc-trace-model")?.textContent,
    rows: [...v.doc.querySelectorAll(".dgc-trace-row")].map((r) => r.textContent) };
  v.doc.querySelector(".dgc-trace-close")?.click();
  return out;
}
test("Trace reads the same live and after a reload: the saved record, both times", () => {
  const traceJs = readFileSync(here + "../media/trace.js", "utf8");
  const live = makeDom();
  live.dom.window.eval(traceJs);
  const event = (e) => live.send({ type: "event", event: e });
  event(READY);
  event({ type: "turn_start", turn_id: "t1", prompt: "go", kind: "prompt" });
  event({ type: "text_delta", text: "Done." });
  event({ type: "stream_end", message_id: "m1", phase: "answer" });
  event({ type: "reply_trace", turn_id: "t1", trace: SAVED });
  event({ type: "turn_end", turn_id: "t1", reason: "completed", token_estimate: 1, final_message_id: "m1" });
  const before = traceOf(live);
  assert.equal(before.title, "t1");
  assert.match(before.model, /deepseek-v4\.1-flash:cloud · 5 spans/);
  const reloaded = makeDom();
  reloaded.dom.window.eval(traceJs);
  reloaded.send({ type: "event", event: READY });
  reloaded.send({ type: "event", event: { type: "history", request_id: "h", items: [
    { role: "time", of: "prompt", at: 1794000000 },
    { type: "turn_start", turn_id: "h1", prompt: "go", kind: "prompt" },
    { role: "time", of: "prompt", at: 1794000000 },
    { type: "text_delta", text: "Done." },
    { role: "time", of: "trace", at: 1794000001 },
    { type: "stream_end", message_id: "m1", phase: "answer" },
    { role: "time", of: "reply", at: 1794000004 },
    { role: "time", of: "reply_trace", at: 1794000004, trace: SAVED },
    { type: "turn_end", turn_id: "h1", reason: "completed", token_estimate: 0, final_message_id: "m1" },
  ] } });
  reloaded.send({ type: "history", items: [] });
  assert.deepEqual(traceOf(reloaded), before);
});

// ---- item 6: a file @ stays in the sentence the model reads --------------------------------------------------------------------
test("Work: a file you @ stays in the sentence, and still attaches", async (t) => {
  let browser = null;
  try { browser = chromium ? await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }) : null; } catch { browser = null; }
  if (!browser) {
    if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail("DGC_REQUIRE_CHROMIUM=1: Chromium could not start");
    t.skip("Chromium could not start");
    return;
  }
  try {
    const { openPanel } = await import("./support/reconnect-scene.mjs");
    const panel = await openPanel(browser, { width: 700, theme: "dark" });
    const page = panel.page;
    const message = (m) => page.evaluate((data) => window.dispatchEvent(new MessageEvent("message", { data })), m);
    await message({ type: "event", event: { ...READY, capabilities: { ...READY.capabilities, display_mentions: 3, composer_selections: true } } });
    await message({ type: "session_state", ready: true }).catch(() => {});
    await page.locator("#input").click();
    await page.keyboard.type("please read @be");
    await message({ type: "files", files: [{ label: "beds.py", path: "/ws/beds.py", uri: "file:///ws/beds.py", relative_path: "beds.py", workspace: "ws" }] });
    await page.waitForSelector("#pop .pi", { state: "visible", timeout: 5000 });
    await page.keyboard.press("Enter");
    await page.keyboard.type(" ok");
    assert.equal(await page.locator("#input .composer-pill").count(), 1, "the mark");
    const words = await page.evaluate(() => { const box = document.getElementById("input"); return [...box.childNodes].map((n) => n.dataset?.pill ?? n.textContent).join(""); });
    assert.equal(words, "please read beds.py ok", "what the model reads");
  } finally { await browser.close(); }
});
