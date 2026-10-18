// Undo and redo in ChatDGC's box and a Pip's box (media/texthistory.js), in real Chromium, with the real keys on both
// platforms (Cmd on a Mac, Ctrl elsewhere). Both are textareas, and a textarea's own history did not survive what these
// pages do to them: ChatDGC's dictation (setRangeText) and its send, give-back and long-paste chip were not in it, and a
// Pip's box is redrawn with the page -- a new element, with an empty history, every time a reply streams in.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, buildSync } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipReason = () => (!chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "");
const skipOrFail = (t) => {
  if (!skipReason()) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${skipReason()}`);
  t.skip(skipReason());
  return true;
};
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

const PLATFORMS = [{ name: "Mac", mod: "Meta", platform: "MacIntel" }, { name: "Linux and Windows", mod: "Control", platform: "Linux x86_64" }];
const markdownJs = buildSync({ entryPoints: [join(root, "src/markdown.ts")], bundle: true, format: "iife",
  globalName: "DgcMarkdown", write: false, platform: "browser" }).outputFiles[0].text;

// ChatDGC's page as src/chatdgc.ts serves it, with its own scripts in the order it loads them.
function chatdgcPage() {
  const source = readFileSync(join(root, "src/chatdgc.ts"), "utf8");
  const doc = source.match(/return `(<!doctype html>[\s\S]*?<\/html>)`;/)[1];
  const scripts = [...doc.matchAll(/asset\("media\/([\w-]+\.js)"\)/g)].map((m) => m[1]);
  const html = doc.replace(/<link [^>]*>/g, "").replace(/<script [^>]*><\/script>/g, "").replace(/\$\{[^}]*\}/g, "");
  const css = readFileSync(join(root, "media/main.css"), "utf8").replace(/@import[^;]*;/, "") + readFileSync(join(root, "media/chatdgc.css"), "utf8");
  return { html: html.replace("</head>", `<style>${css}</style></head>`), js: scripts.map((f) => readFileSync(join(root, "media", f), "utf8")).join("\n") };
}
async function openChatdgc(platform) {
  const { html, js } = chatdgcPage();
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(([code, md, platform]) => {
    Object.defineProperty(navigator, "platform", { get: () => platform, configurable: true });
    window.__posted = [];
    window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState: () => window.__state, setState(s) { window.__state = s; } });
    eval(md + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(code);
  }, [js, markdownJs, platform]);
  const send = (data) => page.evaluate((d) => window.dispatchEvent(new MessageEvent("message", { data: d })), data);
  await send({ type: "opened", conversation: { id: `chat_${"a".repeat(32)}`, title: "New chat", model: null, thinking: null,
    pinned: false, archived: false, temporary: false }, messages: [], earlier: 0, busy: false });
  await send({ type: "models", ids: ["m"], current: "m" });
  await page.click("#cd-input");
  return { page, send };
}
const boxValue = (page, id) => page.evaluate((i) => document.getElementById(i).value, id);

test("ChatDGC's page loads the box's history before its own script", () => {
  const source = readFileSync(join(root, "src/chatdgc.ts"), "utf8");
  const scripts = [...source.matchAll(/asset\("media\/([\w-]+\.js)"\)/g)].map((m) => m[1]);
  assert.ok(scripts.includes("texthistory.js") && scripts.indexOf("texthistory.js") < scripts.indexOf("chatdgc.js"));
});

for (const { name, mod, platform } of PLATFORMS) {
  const undo = (page) => page.keyboard.press(`${mod}+Z`);
  const redo = (page) => page.keyboard.press(`${mod}+Shift+Z`);

  test(`ChatDGC, ${name}: dictated words are their own step, and they do not break the history`, async (t) => {
    if (skipOrFail(t)) return;
    const { page, send } = await openChatdgc(platform);
    try {
      await page.keyboard.type("note:");
      await send({ type: "mic", from: "chatdgc", state: "idle", text: "buy milk" });
      await page.waitForFunction(() => document.getElementById("cd-input").value === "note: buy milk");
      await undo(page);
      assert.equal(await boxValue(page, "cd-input"), "note:", "setRangeText was not in the textarea's history at all");
      await undo(page);
      assert.equal(await boxValue(page, "cd-input"), "");
      await redo(page);
      await redo(page);
      assert.equal(await boxValue(page, "cd-input"), "note: buy milk");
    } finally { await page.close(); }
  });

  test(`ChatDGC, ${name}: undo right after sending brings the message back`, async (t) => {
    if (skipOrFail(t)) return;
    const { page } = await openChatdgc(platform);
    try {
      await page.keyboard.type("What is 2+2?");
      await page.keyboard.press("Enter");
      assert.equal(await boxValue(page, "cd-input"), "");
      await undo(page);
      assert.equal(await boxValue(page, "cd-input"), "What is 2+2?", "assigning .value on send dropped the history");
    } finally { await page.close(); }
  });

  test(`ChatDGC, ${name}: a long paste folded into a chip is undone, and a chip closed by hand stays closed`, async (t) => {
    if (skipOrFail(t)) return;
    const { page } = await openChatdgc(platform);
    const chips = () => page.evaluate(() => document.querySelectorAll("#cd-chips li").length);
    const paste = (text) => page.evaluate((t) => {
      const data = new DataTransfer(); data.setData("text/plain", t);
      document.getElementById("cd-input").dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, text);
    try {
      await page.keyboard.type("see:");
      await paste("q".repeat(20000));
      await page.waitForFunction(() => document.querySelectorAll("#cd-chips li").length === 1);
      await undo(page);
      assert.equal(await chips(), 0, "the chip changed no text, so the textarea had nothing to undo");
      assert.equal(await boxValue(page, "cd-input"), "see:");
      await redo(page);
      assert.equal(await chips(), 1);
      await page.locator("#cd-chips li button").first().click();
      assert.equal(await chips(), 0);
      await page.click("#cd-input");
      await undo(page);
      await undo(page);
      assert.equal(await chips(), 0, "closing a chip is a decision, not an edit");
    } finally { await page.close(); }
  });
}

// A Pip's box, mounted as the Work chat mounts it: in a shadow root, with the page redrawing around it.
const pipsClient = (await build({ entryPoints: [join(root, "src/pipsClient.js")], bundle: true, write: false, format: "iife",
  loader: { ".css": "empty" } })).outputFiles[0].text;
async function openPip(platform) {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await page.route("**/*", (route) => route.request().isNavigationRequest()
    ? route.fulfill({ contentType: "text/html", body: '<div id="host" style="width:100%;height:100vh"></div>' }) : route.abort());
  await page.goto("https://pips-history.invalid/");
  await page.evaluate((platform) => Object.defineProperty(navigator, "platform", { get: () => platform, configurable: true }), platform);
  await page.addScriptTag({ content: pipsClient });
  await page.evaluate(() => {
    window.setInterval = (fn) => { window.__pipPoll = fn; return 1; };
    HTMLCanvasElement.prototype.getContext = () => null;
    let receive;
    const ws = { id: "ws", name: "Project" };
    const pip = { id: "a", workspace_id: "ws", pip_type: "rook", name: "Review a", goal: "Inspect source", source_ref: "HEAD",
      status: "active", current_version: 1, lifecycle_revision: 0, policy: "read_only", trigger: "manual", proposals: [], model_choice: { mode: "default" } };
    // The eight Pip types, as test/pips-composer.test.mjs serves them: the client wants the whole set.
    const readers = ["rook", "scout", "lens", "lock"];
    const types = ["core", "scout", "lens", "patch", "rook", "pulse", "lock", "quill"].map((id, character_index) => ({ id, character_index,
      name: id, role: id, description: "Read committed source", available: readers.includes(id),
      unavailable_reason: readers.includes(id) ? null : "Unavailable", default_name: id, default_goal: "Read source",
      engine: readers.includes(id) ? "source_audit" : null }));
    const chatControls = { version: 1, mode: "read_only", options: { context_size: 8192, thinking: "off" }, options_source: "last_message",
      inherited_context_size: 1048576, effective_context_size: 8192, context_min: 2048, context_max: 32768,
      thinking_levels: ["off", "low", "medium", "high", "xhigh"], reasoning_control: "provider_dependent",
      reasoning_note: "The provider may interpret thinking levels differently.", context_note: "The provider can enforce a smaller window." };
    const runner = { runner_id: "runner", status: "running", online: true, paused: false, counts: { queued: 0, running: 0, cancelling: 0 } };
    window.__replies = 0;
    const result = (r) => ({ list_workspaces: { workspaces: [ws], current_workspace_id: "ws" }, list_pip_types: { types }, list_pips: { pips: [pip] },
      list_pip_setups: { setups: [] }, get_workspace_context: { context: { workspace_id: "ws", revision: 0, entries: [] } },
      get_pip_runner: { runner: { ...runner, counts: { ...runner.counts, queued: window.__replies } } }, get_pip: { pip }, list_pip_runs: { runs: [] },
      list_pip_models: { default_model: "m", models: [], connection: "configured" },
      list_pip_messages: { pip_id: "a", workspace_id: "ws", messages: [], next_before_id: null, active_run: null, history_context_omitted_count: 0,
        chat_controls: chatControls } }[r.type]);
    const rootNode = document.getElementById("host").attachShadow({ mode: "open" });
    window.DgcPips.mount({ root: rootNode, onMessage: (fn) => { receive = fn; window.__receive = fn; }, postMessage: (msg) => queueMicrotask(() => {
      if (msg.type === "pipsReady") receive({ type: "pipsConnection", apiVersion: 24, generation: 1, connected: true, supported: true, enabled: true });
      else if (msg.type === "pipsRequest") { const answer = result(msg.request); if (answer !== undefined) receive({ type: "pipsReply", id: msg.id, ok: true, result: answer }); }
    }) });
  });
  await page.locator("[data-job=a]").click();
  await page.locator("#chatText").waitFor({ state: "visible" });
  await page.locator("#chatText").click();
  return page;
}
// The page redraws: the runner's state changes, as it does while a Pip works, and the box is a new element.
async function redraw(page) {
  await page.evaluate(() => { window.__oldBox = document.getElementById("host").shadowRoot.getElementById("chatText"); window.__replies += 1; window.__pipPoll?.(); });
  await page.waitForFunction(() => document.getElementById("host").shadowRoot.getElementById("chatText") !== window.__oldBox);
}

for (const { name, mod, platform } of PLATFORMS) {
  const undo = (page) => page.keyboard.press(`${mod}+Z`);
  const redo = (page) => page.keyboard.press(`${mod}+Shift+Z`);
  const pipValue = (page) => page.evaluate(() => document.getElementById("host").shadowRoot.getElementById("chatText").value);

  test(`A Pip's box, ${name}: what was typed is undone after the page redraws the box`, async (t) => {
    if (skipOrFail(t)) return;
    const page = await openPip(platform);
    try {
      await page.keyboard.type("Check the release notes");
      await page.waitForTimeout(600);
      await page.keyboard.type(" for typos");
      await redraw(page);
      assert.equal(await pipValue(page), "Check the release notes for typos", "the redraw keeps the draft");
      await undo(page);
      assert.equal(await pipValue(page), "Check the release notes",
        "the redrawn textarea's own history was empty, so the key did nothing at all");
      await redo(page);
      assert.equal(await pipValue(page), "Check the release notes for typos");
    } finally { await page.close(); }
  });

  test(`A Pip's box, ${name}: dictated words are their own step`, async (t) => {
    if (skipOrFail(t)) return;
    const page = await openPip(platform);
    try {
      await page.keyboard.type("Ask:");
      await page.evaluate(() => window.__receive({ type: "mic", from: "pips", state: "idle", text: "is it done" }));
      await page.waitForFunction(() => document.getElementById("host").shadowRoot.getElementById("chatText").value === "Ask: is it done");
      await undo(page);
      assert.equal(await pipValue(page), "Ask:");
    } finally { await page.close(); }
  });
}
