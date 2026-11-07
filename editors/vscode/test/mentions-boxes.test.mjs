// @ marks in ChatDGC's box and a Pip's, in real Chromium with real keystrokes: the same marks as Work's (media/mentions.js),
// listing only what that box can really use. jsdom has no execCommand and no caret, so none of this is tested there.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, buildSync } from "esbuild";
import { THEMES } from "./support/options-scene.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed" : !browser ? "Chromium could not start" : "";
  if (!reason) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

const read = (name) => readFileSync(join(root, name), "utf8");
const LOGO = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PIP_A = "pip_" + "a".repeat(32), PIP_B = "pip_" + "b".repeat(32);

// ---- ChatDGC: its own document, stylesheets inlined, its scripts after a stub host
function chatHtml() {
  const source = read("src/chatdgc.ts");
  const doc = source.match(/return `(<!doctype html>[\s\S]*?<\/html>)`;/)[1];
  const page = doc.replace(/<link [^>]*>/g, "").replace(/<script [^>]*><\/script>/g, "").replace(/\$\{[^}]*\}/g, "")
    .replace("font-src ;", "font-src data:;");
  const codicon = read("media/codicon.css").replace(/url\([^)]*codicon\.ttf[^)]*\)/,
    `url("data:font/ttf;base64,${readFileSync(join(root, "media/codicon.ttf")).toString("base64")}")`);
  const css = [read("media/main.css").replace(/@import[^;]*;/, ""), read("media/mentions.css"), read("media/chatdgc.css"), read("media/voicebar.css")];
  const scripts = [...doc.matchAll(/asset\("media\/([\w/-]+\.js)"\)/g)].map((m) => m[1]);
  const js = scripts.map((f) => read(`media/${f}`)).join("\n");
  const markdownJs = buildSync({ entryPoints: [join(root, "src/markdown.ts")], bundle: true, format: "iife", globalName: "DgcMarkdown", write: false, platform: "browser" }).outputFiles[0].text;
  return { html: page.replace("</head>", `<style>${codicon}</style>${css.map((c) => `<style>${c}</style>`).join("")}</head>`), js, markdownJs };
}
const chat = chatHtml();
const CONVERSATION = { id: `chat_${"c".repeat(32)}`, title: "New chat", model: null, thinking: null, pinned: false, archived: false, temporary: false };
const SOURCES = { type: "mentionSources", offered: true, plugins: [{ id: "composio", name: "Composio" }, { id: "n8n", name: "n8n" }],
  pips: [{ id: PIP_A, name: "Site Traffic", pip_type: "scout", goal: "Watch my sites" }, { id: PIP_B, name: "Core", pip_type: "core", goal: "Help" }], error: "" };

async function openChat({ width = 900, theme = "dark-modern", state } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 700 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.setContent(chat.html, { waitUntil: "load" });
  await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; --vscode-editor-font-family: ui-monospace, monospace; ${THEMES[theme]} }` });
  await page.evaluate((t) => document.body.classList.add(t.startsWith("light") ? "vscode-light" : "vscode-dark"), theme);
  await page.evaluate(([code, md, saved]) => {
    window.__posted = []; window.__state = saved;
    window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState: () => window.__state, setState(s) { window.__state = s; } });
    eval(md + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(code);
  }, [chat.js, chat.markdownJs, state]);
  const send = (data) => page.evaluate((d) => window.dispatchEvent(new MessageEvent("message", { data: d })), data);
  const posted = (type) => page.evaluate((t) => window.__posted.filter((m) => m.type === t), type);
  await send({ type: "opened", conversation: CONVERSATION, messages: [], models: ["deepseek-v4.1-flash:cloud"], defaultModel: "deepseek-v4.1-flash:cloud", thinking: "off" });
  await send({ type: "artifacts", offered: { version: 1, outputs: ["document", "slides", "spreadsheet", "page", "dashboard"] } });
  await send(SOURCES);
  await send({ type: "files", files: [{ label: "src/calc.py", path: "/ws/src/calc.py" }, { label: "README.md", path: "/ws/README.md" }] });
  await send({ type: "pluginLogos", logos: { composio: LOGO } });
  return { page, send, posted, errors, box: () => page.locator("#cd-input") };
}
const value = (page, id = "cd-input") => page.evaluate((i) => document.getElementById(i).value, id);
const rows = (page, id = "cd-pop") => page.evaluate((i) => [...document.getElementById(i).querySelectorAll(".pi")].map((e) => e.querySelector(".pi-label").textContent.trim()), id);
// A synthetic copy reads what the page put on the clipboard. The real clipboard is the live check's (it pastes elsewhere).
const copied = (page, id = "cd-input", kind = "copy") => page.evaluate(([i, k]) => {
  const box = document.getElementById(i), data = new DataTransfer();
  const range = document.createRange(); range.selectNodeContents(box);
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
  box.dispatchEvent(new ClipboardEvent(k, { clipboardData: data, bubbles: true, cancelable: true }));
  return data.getData("text/plain");
}, [id, kind]);

test("ChatDGC: @ lists its Pips, plugins, Outputs and files, and a mark goes in where it was typed", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openChat();
  try {
    await s.box().click();
    await s.page.keyboard.type("Use @");
    assert.deepEqual((await rows(s.page)).slice(0, 8), ["Reference a Pip…", "Composio", "n8n", "Document", "Slides", "Spreadsheet", "Page", "Dashboard"]);
    await s.page.keyboard.type("comp");
    assert.deepEqual(await rows(s.page), ["Composio"], "typing narrows it");
    await s.page.keyboard.press("Enter");
    await s.page.keyboard.type(" for this");
    assert.equal(await value(s.page), "Use Composio for this", "the model's words: the name, no @");
    const order = await s.page.evaluate(() => [...document.getElementById("cd-input").childNodes].map((n) => (n.nodeType === 3 ? n.data : `[${n.dataset.kind}:${n.textContent}]`)).join(""));
    assert.equal(order, "Use [plugin:Composio] for this", "what's typed after a mark lands after it");
    assert.equal(await s.page.evaluate(() => document.querySelector("#cd-input .composer-plugin-mark img")?.getAttribute("src")?.slice(0, 10)), "data:image", "its logo");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("ChatDGC: the first @ in a new tab finds the plugins that arrive after it was typed", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openChat();
  try {
    await s.send({ type: "mentionSources", offered: true, plugins: [], pips: [], error: "" });
    await s.box().click();
    await s.page.keyboard.type("@comp");
    assert.deepEqual(await rows(s.page), [], "nothing to list yet");
    await s.send(SOURCES);
    assert.deepEqual(await rows(s.page), ["Composio"], "it opens by itself when they come");
  } finally { await s.page.close(); }
});

test("ChatDGC: a sent prompt carries clean words and its marks; the bubble keeps logo and icon with the @ text in grey", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openChat();
  try {
    await s.box().click();
    await s.page.keyboard.type("Make @slid");
    await s.page.keyboard.press("Tab");
    await s.page.keyboard.type(" with @comp");
    await s.page.keyboard.press("Tab");
    await s.page.keyboard.press("Enter");
    const sent = (await s.posted("send")).at(-1);
    assert.equal(sent.text, "Make Slides with Composio");
    assert.deepEqual(sent.display_mentions.map((m) => [m.start, m.kind, m.label, m.identity]),
      [[5, "artifact", "Slides", "slides"], [17, "plugin", "Composio", "composio"]]);
    assert.equal(await value(s.page), "", "the box is empty");
    const look = await s.page.evaluate(() => {
      const bubble = document.querySelector(".cd-user .cd-bubble"), plugin = bubble.querySelector(".sent-mention.pill-plugin"), output = bubble.querySelector(".sent-mention.pill-artifact");
      return { text: bubble.textContent, logo: !!plugin.querySelector("img"), icon: output.querySelector(".composer-artifact-mark").className,
        plugin: getComputedStyle(plugin).color, words: getComputedStyle(output.querySelector(".composer-artifact-name")).color,
        moving: getComputedStyle(output.querySelector(".composer-artifact-name")).animationName };
    });
    assert.equal(look.text, "Make Slides with Composio");
    assert.ok(look.logo, "the plugin's logo stays");
    assert.match(look.icon, /codicon-preview/, "the Output's icon, the one its menu has");
    assert.equal(look.plugin, "rgb(216, 214, 223)", "the plugin's name is light grey");
    assert.equal(look.words, "rgb(216, 214, 223)", "the Output's name is light grey");
    assert.equal(look.moving, "composerArtifactWords", "and it still moves");
    // The backend's copy of the message draws the same, so a reload does.
    await s.send({ type: "opened", conversation: CONVERSATION, models: ["m"], messages: [{ id: `msg_${"1".repeat(32)}`, role: "user", text: sent.text, created_at: "2026-11-06T10:00:00Z", display_mentions: sent.display_mentions }] });
    assert.equal(await s.page.locator(".cd-user .sent-mention").count(), 2, "after a reload too");
    // Marks that no longer fit the words leave the words.
    await s.send({ type: "opened", conversation: CONVERSATION, models: ["m"], messages: [{ id: `msg_${"2".repeat(32)}`, role: "user", text: "Something else", created_at: "2026-11-06T10:00:00Z", display_mentions: sent.display_mentions }] });
    assert.equal(await s.page.locator(".cd-user .sent-mention").count(), 0);
    assert.equal(await s.page.locator(".cd-user .cd-bubble").textContent(), "Something else");
  } finally { await s.page.close(); }
});

test("ChatDGC on a light theme: the marks can be read, in the box and in the bubble", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openChat({ theme: "light-modern" });
  try {
    const dark = (rgb) => { const [r, g, b] = rgb.match(/[\d.]+/g).map(Number); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };
    await s.box().click();
    await s.page.keyboard.type("Make @slid");
    await s.page.keyboard.press("Tab");
    assert.ok(dark(await s.page.locator("#cd-input .composer-artifact-name").evaluate((n) => getComputedStyle(n).color)) < 0.45, "a word in the box is no pale lilac on white");
    await s.page.keyboard.press("Enter");
    assert.ok(dark(await s.page.locator(".cd-user .sent-mention .composer-artifact-name").evaluate((n) => getComputedStyle(n).color)) < 0.5, "nor the bubble's grey on its lilac");
  } finally { await s.page.close(); }
});

test("ChatDGC: @pip lists the Pips with faces, and the chosen one is its face and name; a copy is clean text", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openChat();
  try {
    await s.box().click();
    await s.page.keyboard.type("Ask @pip");
    assert.deepEqual(await rows(s.page), ["Site Traffic", "Core"]);
    assert.equal(await s.page.locator("#cd-pop .pi-pip-face .dgc-plush").count(), 2, "each with its face");
    assert.equal(await s.page.locator("#cd-pop style").count(), 0, "no stylesheet in the list");
    await s.page.keyboard.press("Enter");
    await s.page.keyboard.type(" about it");
    assert.equal(await value(s.page), "Ask Site Traffic about it", "the model reads its name");
    const look = await s.page.evaluate(() => {
      const pill = document.querySelector("#cd-input .pill-pip");
      return { face: !!pill.querySelector(".composer-pip-face .dgc-plush"), style: pill.querySelectorAll("style").length, name: getComputedStyle(pill.querySelector(".composer-pip-name")).animationName };
    });
    assert.deepEqual(look, { face: true, style: 0, name: "composerArtifactWords" });
    const text = await copied(s.page);
    assert.equal(text, "Ask @Site Traffic about it", "never a stylesheet");
    await s.page.keyboard.press("End");
    await s.page.keyboard.press("Enter");
    const sent = (await s.posted("send")).at(-1);
    assert.equal(sent.text, "Ask Site Traffic about it");
    assert.deepEqual(sent.display_mentions, [{ start: 4, kind: "pip", label: "Site Traffic", identity: PIP_A, pip_type: "scout", wired: true }]);
    assert.equal(await s.page.locator(".cd-user .sent-mention .composer-pip-face .dgc-plush").count(), 1, "the face stays in the bubble");
  } finally { await s.page.close(); }
});

test("ChatDGC: a file mark attaches the file and shows once; removing the mark takes it away", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openChat();
  try {
    await s.box().click();
    await s.page.keyboard.type("Read @calc");
    assert.deepEqual(await rows(s.page), ["src/calc.py"]);
    await s.page.keyboard.press("Enter");
    assert.equal(await s.page.locator("#cd-input .pill-file").textContent(), "src/calc.py");
    assert.equal(await s.page.locator("#cd-chips .cd-chip").count(), 0, "no second chip under it");
    assert.deepEqual(await s.posted("mentionFile"), [{ type: "mentionFile", path: "/ws/src/calc.py" }], "the host may let it through");
    await s.page.keyboard.press("Backspace");
    assert.equal(await s.page.locator("#cd-input .pill-file").count(), 0, "Backspace takes the whole mark");
    await s.page.keyboard.type("@calc");
    await s.page.keyboard.press("Enter");
    await s.page.keyboard.press("Enter");
    const sent = (await s.posted("send")).at(-1);
    assert.deepEqual(sent.attachments, [{ kind: "file", name: "calc.py", path: "/ws/src/calc.py" }], "one: the mark Backspace took went with what it stood for");
    assert.equal(sent.text, "Read src/calc.py", "the file's name stays in the sentence the model reads");
    assert.equal(await s.page.locator(".cd-user .sent-mention.pill-file").last().textContent(), "src/calc.py");
    assert.equal(await s.page.locator(".cd-user .cd-chip").count(), 0, "in its sentence, not a chip above it");
  } finally { await s.page.close(); }
});

test("ChatDGC: undo brings a mark back, a draft keeps its marks through a reload, a paste is plain, and a copy pastes back as marks", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openChat();
  try {
    await s.box().click();
    await s.page.keyboard.type("Use @comp");
    await s.page.keyboard.press("Tab");
    await s.page.keyboard.press("Control+Z");
    assert.equal(await value(s.page), "Use @comp", "undone: the token as it was typed");
    assert.equal(await s.page.locator("#cd-input .composer-pill").count(), 0);
    await s.page.keyboard.press("Control+Shift+Z");
    assert.equal(await s.page.locator("#cd-input .composer-pill.pill-plugin").count(), 1, "redone: the mark");
    await s.page.keyboard.type(" now");
    const saved = await s.page.evaluate(() => window.__state);
    await s.page.close();
    const back = await openChat({ state: saved });
    try {
      assert.equal(await value(back.page), "Use Composio now");
      assert.equal(await back.page.locator("#cd-input .composer-pill.pill-plugin img").count(), 1, "the draft's mark, with its logo");
      await back.box().click();
      await back.page.keyboard.press("End");
      // A rich paste brings its words only, and no markup into the box.
      await back.page.evaluate(() => {
        const data = new DataTransfer();
        data.setData("text/html", '<img src="https://tracker.invalid/x"><b>bold</b> words');
        document.getElementById("cd-input").dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
      });
      assert.equal(await value(back.page), "Use Composio nowbold words");
      assert.equal(await back.page.locator("#cd-input img[src^=https], #cd-input b").count(), 0, "no markup got in");
      const text = await copied(back.page);
      assert.equal(text, "Use @Composio nowbold words");
      await back.page.keyboard.press("End");
      await back.page.evaluate((words) => {
        const data = new DataTransfer();
        data.setData("text/plain", words);
        document.getElementById("cd-input").dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
      }, text);
      assert.equal(await back.page.locator("#cd-input .composer-pill.pill-plugin").count(), 2, "its own copy pastes back as marks");
    } finally { await back.page.close(); }
  } finally { await s.page.close().catch(() => {}); }
});

test("ChatDGC: a queued message keeps its marks; given back it is marks again; a full box keeps Send working", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openChat();
  try {
    await s.box().click();
    await s.page.keyboard.type("First");
    await s.page.keyboard.press("Enter");
    await s.send({ type: "turnStarted", conversation: CONVERSATION.id, messageId: "x" });
    await s.page.evaluate(() => { document.getElementById("cd-input").focus(); });
    await s.page.keyboard.type("Then @comp");
    await s.page.keyboard.press("Tab");
    await s.page.keyboard.press("Enter");
    const queued = await s.page.locator("#cd-queue .cd-queue-text").allTextContents();
    assert.deepEqual(queued, ["Then Composio"]);
    await s.page.keyboard.press("ArrowUp");
    assert.equal(await value(s.page), "Then Composio", "the last queued message, back in the box");
    assert.equal(await s.page.locator("#cd-input .composer-pill.pill-plugin").count(), 1, "with its mark");
  } finally { await s.page.close(); }
});

// ---- A Pip's chat: the real client, in a shadow root as the side bar mounts it, and in its own tab
const pipBundle = await build({ entryPoints: [join(root, "src/pipsClient.js")], bundle: true, write: false, format: "iife", outdir: "out", platform: "browser",
  loader: { ".png": "dataurl", ".svg": "dataurl", ".webp": "dataurl" } });
const pipJs = pipBundle.outputFiles.find((f) => f.path.endsWith(".js")).text;
const pipCss = pipBundle.outputFiles.filter((f) => f.path.endsWith(".css")).map((f) => f.text).join("\n");

const pipHost = `(${function (PIP_A, PIP_B, LOGO, scope) {
  const W = "ws_" + "p".repeat(32);
  const types = ["core", "scout", "lens", "patch", "rook", "pulse", "lock", "quill"].map((id, character_index) => ({ id, character_index, name: id, role: id,
    description: "Reads", available: true, unavailable_reason: null, default_name: id, default_goal: "Help",
    engine: id === "patch" ? "patch" : id === "pulse" ? "test" : id === "quill" ? "documentation_draft" : "source_audit" }));
  const personal = scope === "personal";
  const job = (id, name, type) => ({ id, workspace_id: W, pip_type: type, name, goal: "Help.", source_policy: personal ? { mode: "personal" } : { mode: "committed_only" }, source_ref: "HEAD",
    status: "active", current_version: 1, lifecycle_revision: 0, policy: "read_only", trigger: "manual", schedule: null, proposals: [], pending_review_count: 0 });
  const mine = job(PIP_A, "Site Traffic", "lens"), other = job(PIP_B, "Core", "core");
  const controls = { version: 1, mode: "read_only", options: { context_size: 8192, thinking: "off" }, options_source: "last_message", inherited_context_size: 1048576,
    effective_context_size: 8192, context_min: 2048, context_max: 32768, thinking_levels: ["off", "low", "medium", "high", "xhigh"], reasoning_control: "provider_dependent", reasoning_note: "n", context_note: "n" };
  window.__sent = []; window.__messages = []; window.__active = null; window.__state = undefined;
  const run = "run_" + "5".repeat(32);
  const answers = {
    list_workspaces: () => ({ workspaces: [{ id: W, name: personal ? "Personal" : "Garden", kind: personal ? "personal" : "project" }], current_workspace_id: W }),
    list_pip_types: () => ({ types }), list_pip_setups: () => ({ setups: [] }), list_pip_starters: () => ({ starters: [] }),
    list_pips: () => ({ pips: [mine, other], total: 2, next_offset: null }),
    get_pip_runner: () => ({ runner: { runner_id: "r", status: "running", online: true, paused: false, counts: { queued: 0, running: 0, cancelling: 0 } } }),
    get_workspace_context: () => ({ context: { workspace_id: W, revision: 0, entries: [] } }),
    list_pip_models: () => ({ default_model: "m", models: [], connection: "configured" }),
    list_pip_messages: () => ({ pip_id: PIP_A, workspace_id: W, messages: window.__messages, next_before_id: null, active_run: window.__active, history_context_omitted_count: 0, chat_controls: controls }),
    list_pip_run_posts: () => ({ pip_id: PIP_A, workspace_id: W, posts: [], next_before_id: null }),
    list_pip_reply_stats: () => ({ pip_id: PIP_A, stats: [] }),
    list_pip_plugins: () => ({ pip_id: PIP_A, plugins: [], installed: personal ? [{ plugin: "composio", name: "Composio", money: false, servers: ["composio"] }] : [] }),
    get_pip: () => ({ pip: mine }), list_pip_runs: () => ({ runs: [] }),
    send_pip_message: (req) => {
      window.__sent.push(req);
      const message = { id: "u" + window.__sent.length, pip_id: PIP_A, workspace_id: W, role: "user", text: req.text, run_id: run, status: "queued", model: "m", created_at: new Date().toISOString(),
        ...(req.display_mentions ? { display_mentions: req.display_mentions } : {}) };
      window.__messages.push(message);
      return { message, run: { id: run, pip_id: PIP_A, status: "queued" } };
    },
  };
  const hear = [];
  window.__mount = (root) => {
    window.DgcPips.mount({ root, getState: () => window.__state, setState: (s) => { window.__state = JSON.parse(JSON.stringify(s)); },
      onMessage: (fn) => { hear.push(fn); return () => {}; },
      postMessage: (m) => {
        const say = (reply) => setTimeout(() => hear.forEach((fn) => fn(reply)), 1);
        if (m?.type === "pipsReady") say({ type: "pipsConnection", apiVersion: 73, generation: 1, connected: true, supported: true, enabled: true, displayMentions: true });
        if (m?.type === "pipsPluginLogos") say({ type: "pipsPluginLogos", logos: Object.fromEntries(m.plugins.map((id) => [id, LOGO])) });
        if (m?.type === "pipsFiles") say({ type: "pipsFiles", files: [{ label: "src/calc.py" }] });
        if (m?.type !== "pipsRequest") return;
        const make = answers[m.request.type];
        say(make ? { type: "pipsReply", id: m.id, ok: true, result: make(m.request) } : { type: "pipsReply", id: m.id, ok: false, error: "not offered here" });
      } });
  };
}})(${JSON.stringify(PIP_A)}, ${JSON.stringify(PIP_B)}, ${JSON.stringify(LOGO)}, "__SCOPE__");`;

async function openPip({ embedded = true, scope = "personal", width = 640 } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  // The page's own tokens: in the side bar a Pip's page inherits main.css's.
  const tokens = read("media/main.css").match(/:root\s*\{[\s\S]*?\n\}/)?.[0] || "";
  // crypto.randomUUID needs a secure context, as a webview's is.
  await page.route("https://pips.invalid/", (route) => route.fulfill({ contentType: "text/html", body: `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${tokens}</style>${embedded ? "" : `<style>${pipCss}</style>`}</head><body>${embedded ? '<section id="host" style="display:block;height:780px"></section>' : '<main id="app"></main><div id="review-root"></div>'}</body></html>` }));
  await page.goto("https://pips.invalid/");
  await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; --vscode-editor-font-family: ui-monospace, monospace; ${THEMES["dark-modern"]} }` });
  await page.addScriptTag({ content: pipHost.replace("__SCOPE__", scope) });
  // The bundle mounts itself only in a page with acquireVsCodeApi; here the test mounts it, as main.js does.
  await page.addScriptTag({ content: pipJs });
  await page.evaluate(([embed, css]) => {
    let root = document;
    if (embed) { root = document.getElementById("host").attachShadow({ mode: "open" }); const style = document.createElement("style"); style.textContent = css; root.append(style); window.__root = root; root = window.__root; }
    window.__box = () => (embed ? window.__root : document).getElementById ? (embed ? window.__root.getElementById("chatText") : document.getElementById("chatText")) : null;
    window.__mount(root);
  }, [embedded, pipCss]);
  const scopeLocator = embedded ? "#host " : "";
  await page.locator(`${scopeLocator}[data-job="${PIP_A}"]`).first().click();
  await page.locator(`${scopeLocator}#chatText`).waitFor({ state: "visible" });
  await page.waitForFunction(() => !window.__box().disabled && window.__box().getAttribute("contenteditable") === "true");
  await page.waitForTimeout(150);
  return { page, errors, box: () => page.locator(`${scopeLocator}#chatText`), $: (s) => page.locator(`${scopeLocator}${s}`), close: () => context.close() };
}
const pipValue = (page) => page.evaluate(() => window.__box().value);
const pipRows = (p) => p.$("#chat-pop .pi .pi-label").allTextContents();

for (const embedded of [true, false]) {
  const where = embedded ? "in the side bar's shadow root" : "in its own tab";
  test(`a Personal Pip's chat ${where}: @ lists what it can reach, a mark goes in, and the bubble keeps it`, async (t) => {
    if (skipOrFail(t)) return;
    const p = await openPip({ embedded });
    try {
      await p.box().click();
      await p.page.keyboard.type("Use @");
      await p.$("#chat-pop .pi").first().waitFor({ state: "visible" });
      const listed = await pipRows(p);
      assert.deepEqual(listed.map((s) => s.trim()), ["Reference a Pip…", "Composio"], "its plugins and its fellow Pips; no Outputs and no project files");
      await p.page.keyboard.type("comp");
      await p.page.keyboard.press("Enter");
      await p.page.keyboard.type(" and ask @pip");
      assert.deepEqual((await pipRows(p)).map((s) => s.trim()), ["Core"], "the others, never itself");
      assert.equal(await p.$("#chat-pop .pi-pip-face .dgc-plush").count(), 1);
      await p.page.keyboard.press("Enter");
      await p.page.keyboard.type(" now");
      assert.equal(await pipValue(p.page), "Use Composio and ask Core now");
      const order = await p.page.evaluate(() => [...window.__box().childNodes].map((n) => (n.nodeType === 3 ? n.data : `[${n.dataset.kind}]`)).join(""));
      assert.equal(order, "Use [plugin] and ask [pip] now", "in the place they were typed, caret after each");
      await p.page.keyboard.press("Enter");
      await p.page.waitForFunction(() => window.__sent.length === 1);
      const sent = await p.page.evaluate(() => window.__sent[0]);
      assert.equal(sent.text, "Use Composio and ask Core now");
      assert.deepEqual(sent.display_mentions.map((m) => [m.start, m.kind, m.label]), [[4, "plugin", "Composio"], [21, "pip", "Core"]]);
      await p.$('.pip-message.user[data-message="u1"] .sent-mention').first().waitFor({ state: "visible" });   // the saved message, not the local one it replaces
      assert.equal(await p.$(".pip-message.user .sent-mention .composer-pip-face .dgc-plush").count(), 1, "its face in the bubble");
      assert.equal(await p.$(".pip-message.user .sent-mention .composer-plugin-mark img").count(), 1, "its logo too");
      assert.equal(await pipValue(p.page), "", "the box is clear");
      const color = await p.$(".pip-message.user .sent-mention .composer-pip-name").evaluate((n) => getComputedStyle(n).color);
      assert.equal(color, "rgb(216, 214, 223)", "the name is light grey");
      assert.deepEqual(p.errors, []);
    } finally { await p.close(); }
  });

  test(`a click on a mark ${where} leaves a caret after it, even with none before`, async (t) => {
    if (skipOrFail(t)) return;
    const p = await openPip({ embedded });
    try {
      await p.box().click();
      await p.page.keyboard.type("Hi @comp");
      await p.$("#chat-pop .pi").first().waitFor({ state: "visible" });
      await p.page.keyboard.press("Tab");
      await p.page.keyboard.type(" there");
      await p.page.evaluate(() => { const box = window.__box(), root = box.getRootNode(); (root.getSelection ? root.getSelection() : window.getSelection()).removeAllRanges(); box.blur(); });
      await p.$("#chatText .composer-plugin-name").click();
      await p.page.keyboard.type("!");
      assert.equal(await pipValue(p.page), "Hi Composio! there");
    } finally { await p.close(); }
  });

  test(`a Pip's box ${where} holds its marks through what the page does around it: a redraw, a reload, Backspace, undo and a copy`, async (t) => {
    if (skipOrFail(t)) return;
    const p = await openPip({ embedded });
    try {
      await p.box().click();
      await p.page.keyboard.type("Hi @comp");
      await p.$("#chat-pop .pi").first().waitFor({ state: "visible" });
      await p.page.keyboard.press("Tab");
      await p.page.keyboard.type(" there");
      await p.page.evaluate(() => { window.__before = window.__box(); });
      // A reply streaming in, a run ending: the page draws itself again. The box stays the box.
      await p.$("#chat-context-toggle").click();
      await p.page.keyboard.press("Escape");
      await p.box().click();
      await p.page.keyboard.press("End");
      assert.equal(await p.page.evaluate(() => window.__before === window.__box()), true, "the same element");
      assert.equal(await p.page.evaluate(() => window.__box().querySelectorAll(".pill-plugin").length), 1);
      await p.page.keyboard.type("!");
      assert.equal(await pipValue(p.page), "Hi Composio there!", "the caret stayed where it was");
      // Copy: clean words, never a stylesheet.
      const text = await p.page.evaluate(() => {
        const box = window.__box(), data = new DataTransfer();
        const range = document.createRange(); range.selectNodeContents(box);
        const root = box.getRootNode(), sel = root.getSelection ? root.getSelection() : window.getSelection();
        sel.removeAllRanges(); sel.addRange(range);
        box.dispatchEvent(new ClipboardEvent("copy", { clipboardData: data, bubbles: true, composed: true, cancelable: true }));
        return data.getData("text/plain");
      });
      assert.equal(text, "Hi @Composio there!");
      // Backspace takes a whole mark; undo brings it back.
      await p.page.evaluate(() => { const box = window.__box(), root = box.getRootNode(), sel = root.getSelection ? root.getSelection() : window.getSelection(); const at = [...box.childNodes].findIndex((n) => n.nodeType === 1); const range = document.createRange(); range.setStart(box, at + 1); range.collapse(true); sel.removeAllRanges(); sel.addRange(range); box.focus(); });
      await p.page.keyboard.press("Backspace");
      assert.equal(await pipValue(p.page), "Hi  there!");
      await p.page.keyboard.press("Control+Z");
      assert.equal(await pipValue(p.page), "Hi Composio there!");
      assert.equal(await p.page.evaluate(() => window.__box().querySelectorAll(".pill-plugin").length), 1, "the mark is back");
    } finally { await p.close(); }
  });
}

test("a Project Pip's chat lists its fellow Pips and the project's files, with the path as its words", async (t) => {
  if (skipOrFail(t)) return;
  const p = await openPip({ scope: "project" });
  try {
    await p.box().click();
    await p.page.keyboard.type("Read @");
    await p.$("#chat-pop .pi").first().waitFor({ state: "visible" });
    await p.page.waitForTimeout(100);
    assert.deepEqual((await pipRows(p)).map((s) => s.trim()), ["Reference a Pip…", "src/calc.py"], "no plugins: only a Personal Pip has them");
    await p.page.keyboard.press("ArrowDown");
    await p.page.keyboard.press("Enter");
    assert.equal(await pipValue(p.page), "Read src/calc.py", "the Pip reads the path");
    await p.page.keyboard.press("Enter");
    await p.page.waitForFunction(() => window.__sent.length === 1);
    assert.deepEqual(await p.page.evaluate(() => window.__sent[0].display_mentions), [{ start: 5, kind: "file", label: "src/calc.py", identity: "file", wired: true }]);
  } finally { await p.close(); }
});

// ---- a paste, as VS Code delivers it ------------------------------------------------------------------------------
// Its Paste runs execCommand("paste") on the page, so the handler is already inside an editing command: Chromium refuses
// insertText there, the text goes in by hand and no input event fires of its own. A test that lets insertText run takes a
// branch that does not ship.
const vscodePaste = (page, boxOf, flavours) => page.evaluate(async ([find, c]) => {
  const box = eval(find)();
  box.focus();
  const saved = document.execCommand;
  document.execCommand = function (cmd, ui, value) { return cmd === "insertText" ? false : saved.call(document, cmd, ui, value); };
  const data = new DataTransfer();
  if (c.plain !== undefined) data.setData("text/plain", c.plain);
  if (c.html !== undefined) data.setData("text/html", c.html);
  box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true, composed: true }));
  await new Promise((r) => setTimeout(r, 60));
  document.execCommand = saved;
}, [boxOf, flavours]);
const CHAT_BOX = "() => document.getElementById('cd-input')", PIP_BOX = "() => window.__box()";
const NOTE5 = "Removed 5 invisible characters from the pasted text";
const hiddenFive = "Pay\u200Bment guide with\u200B some\u200B hidden\u200B text\u200B";
const undoKey = process.platform === "darwin" ? "Meta+Z" : "Control+Z", redoKey = process.platform === "darwin" ? "Meta+Shift+Z" : "Control+Shift+Z";
const LIST_PLAIN = "Steps\nInstall the package\nOpen the settings\nPick a theme\nRestart\n";
const LIST_HTML = '<h2 style="color:red">Steps</h2><ol start="4"><li>Install the <b>package</b></li><li>Open the settings<ul><li>Pick a theme</li></ul></li><li>Restart</li></ol>';
const LIST_SHAPED = "Steps\n4. Install the package\n5. Open the settings\n   - Pick a theme\n6. Restart";
const SHAPED = "    first line is indented\n\tsecond starts with a tab\n\n\n  two   blank   lines   above,  and   spaces\n1. keep\n2. me\n4. and this four";

async function pasteCases(page, boxOf, note, read) {
  // Cleaned before it lands, and the row says how many.
  await vscodePaste(page, boxOf, { plain: hiddenFive });
  assert.equal(await read(), "Payment guide with some hidden text");
  assert.equal(await note.isVisible(), true);
  assert.equal(await note.locator(".paste-note-words").textContent(), NOTE5);
  // One undo: as it came, and nothing to say. Redo: both back. Another undo and the paste is gone.
  await page.keyboard.press(undoKey);
  await page.waitForFunction(([find, want]) => eval(find)().value === want, [boxOf, hiddenFive]);
  assert.equal(await note.isVisible(), false, "after undo nothing has been removed");
  await page.keyboard.press(redoKey);
  await page.waitForFunction(([find]) => eval(find)().value === "Payment guide with some hidden text", [boxOf]);
  assert.equal(await note.locator(".paste-note-words").textContent(), NOTE5);
  assert.equal(await note.isVisible(), true);
  await page.keyboard.press(undoKey); await page.keyboard.press(undoKey);
  await page.waitForFunction(([find]) => eval(find)().value === "", [boxOf]);
  assert.equal(await note.isVisible(), false);
  // A second paste adds to the first; closing changes nothing in the box.
  await vscodePaste(page, boxOf, { plain: "a\u200Bb" });
  await vscodePaste(page, boxOf, { plain: "c\u200Bd\u200B" });
  assert.equal(await note.locator(".paste-note-words").textContent(), "Removed 3 invisible characters from the pasted text");
  await note.locator("button").click();
  assert.equal(await note.isVisible(), false);
  assert.equal(await read(), "abcd");
  // Cleared by hand.
  await vscodePaste(page, boxOf, { plain: "e\u200Bf" });
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.keyboard.press("Backspace");
  assert.equal(await read(), "");
  assert.equal(await note.isVisible(), false, "the draft is gone, and so is what the row was about");
  // What is harmless is untouched and raises nothing.
  for (const text of ["\u{1F468}\u200D\u{1F469}\u200D\u{1F467} family", "مرحبا\u200Fبا", "می\u200Cخواهم"]) {
    await vscodePaste(page, boxOf, { plain: text });
    assert.equal(await read(), text);
    assert.equal(await note.isVisible(), false);
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await page.keyboard.press("Backspace");
  }
  // Typed text stays as typed.
  await page.keyboard.insertText("pass\u200Bword");
  assert.equal(await read(), "pass\u200Bword");
  assert.equal(await note.isVisible(), false);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.keyboard.press("Backspace");
  // The list a browser's plain text lost, as plain text.
  await vscodePaste(page, boxOf, { plain: LIST_PLAIN, html: LIST_HTML });
  assert.equal(await read(), `${LIST_SHAPED}\n`);
}

test("ChatDGC: a paste is cleaned as it lands, in VS Code's route, and keeps the shape it was copied with", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openChat();
  try {
    await pasteCases(s.page, CHAT_BOX, s.page.locator(".paste-note"), () => value(s.page));
    assert.equal(await s.page.evaluate(() => document.querySelectorAll("#cd-input b, #cd-input ol, #cd-input [style]").length), 0, "never as rich formatting");
    assert.equal(await s.page.locator("#cd-send").evaluate((n) => n.disabled), false, "the page heard of the paste");
    // What the model reads and the bubble shows.
    await s.page.keyboard.press("Enter");
    await s.page.waitForFunction(() => document.getElementById("cd-input").value === "");
    assert.equal((await s.posted("send")).at(-1).text, LIST_SHAPED);
    assert.equal(await s.page.locator(".cd-user .cd-bubble").last().textContent(), LIST_SHAPED);
    await s.send({ type: "done" });
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("ChatDGC: a first line's indentation is sent and drawn, the row goes with the send, and a folded paste is cleaned", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openChat();
  try {
    await vscodePaste(s.page, CHAT_BOX, { plain: `\n  \n${SHAPED}\n\n` });
    await s.page.keyboard.press("Enter");
    await s.page.waitForFunction(() => document.getElementById("cd-input").value === "");
    assert.equal((await s.posted("send")).at(-1).text, SHAPED, "only the blank lines around the message go");
    assert.equal(await s.page.locator(".cd-user .cd-bubble").last().textContent(), SHAPED);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
  const f = await openChat();
  try {
    const note = f.page.locator(".paste-note"), chips = f.page.locator("#cd-chips li");
    const big = "A long line of pasted text.\n".repeat(300);
    await vscodePaste(f.page, CHAT_BOX, { plain: "\u200B" + big + "\u{E0048}\u{E0049}\u{E0044}\u{E0045}" });
    assert.equal(await chips.count(), 1, "folded");
    assert.equal(await note.locator(".paste-note-words").textContent(), NOTE5, "and counted: this text used to skip the check");
    await f.page.keyboard.press(undoKey);
    await f.page.waitForFunction(() => document.querySelector(".paste-note").hidden);
    assert.equal(await chips.count(), 1, "one undo: the chip as it was copied");
    await f.page.keyboard.press(redoKey);
    await f.page.waitForFunction(() => !document.querySelector(".paste-note").hidden);
    await f.page.keyboard.press("Enter");
    await f.page.waitForFunction(() => !document.querySelectorAll("#cd-chips li").length);
    const sent = (await f.posted("send")).at(-1);
    assert.equal(sent.attachments[0].text, big, "the model reads the clean text");
    assert.equal(await note.isVisible(), false, "the send took the row");
    await f.send({ type: "done" });
    assert.deepEqual(f.errors, []);
  } finally { await f.page.close(); }
  const c = await openChat();
  try {
    await vscodePaste(c.page, CHAT_BOX, { plain: "\u200B" + "line of text\n".repeat(600) });
    assert.equal(await c.page.locator("#cd-chips li").count(), 1);
    await c.page.locator("#cd-chips li button").last().click();
    assert.equal(await c.page.locator("#cd-chips li").count(), 0);
    assert.equal(await c.page.locator(".paste-note").isVisible(), false, "closing the chip leaves the row nothing to be about");
  } finally { await c.page.close(); }
});

test("ChatDGC: text dragged in is a paste, and a dictated phrase loses what nobody can say, without a word", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openChat();
  try {
    await s.page.evaluate(() => {
      const data = new DataTransfer();
      data.setData("text/plain", "One\u200B\nTwo");
      data.setData("text/html", "<ol><li>One\u200B</li><li>Two</li></ol>");
      const box = document.getElementById("cd-input"); box.focus();
      box.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertFromDrop", dataTransfer: data, bubbles: true, cancelable: true }));
    });
    assert.equal(await value(s.page), "1. One\n2. Two");
    assert.equal(await s.page.locator(".paste-note-words").textContent(), "Removed 1 invisible character from the pasted text");
    await s.page.locator(".paste-note button").click();
    await s.page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await s.page.keyboard.press("Backspace");
    await s.send({ type: "mic", from: "chat", state: "idle", text: "hello\u200B there" });
    await s.page.waitForFunction(() => document.getElementById("cd-input").value !== "");
    assert.equal(await value(s.page), "hello there");
    assert.equal(await s.page.locator(".paste-note").isVisible(), false);
  } finally { await s.page.close(); }
});

test("the row is quiet in both themes, and holds its whole sentence in a narrow box", async (t) => {
  if (skipOrFail(t)) return;
  for (const theme of ["dark-modern", "light-modern"]) {
    const s = await openChat({ theme, width: 300 });
    try {
      await vscodePaste(s.page, CHAT_BOX, { plain: hiddenFive });
      const look = await s.page.locator(".paste-note").evaluate((n) => {
        const words = n.querySelector(".paste-note-words"), css = getComputedStyle(n), hit = n.querySelector("button").getBoundingClientRect();
        const top = document.elementFromPoint(hit.left + hit.width / 2, hit.top + hit.height / 2);
        return { color: css.color, fill: css.backgroundColor, border: css.borderTopWidth, clipped: words.scrollWidth > words.clientWidth || words.scrollHeight > words.clientHeight + 1,
          closes: n.querySelector("button").contains(top), buttons: n.querySelectorAll("button").length };
      });
      assert.match(look.fill, / \/ 0\.05\)$/, `${theme}: a barely-there surface, no fill of its own: ${look.fill}`);
      assert.match(look.color, / \/ 0\.(72|85)\)$/, `${theme}: softer than the muted colour: ${look.color}`);
      assert.equal(look.border, "0px");
      assert.equal(look.clipped, false, `${theme}: the whole sentence shows`);
      assert.equal(look.closes, true, `${theme}: the close control takes its click`);
      assert.equal(look.buttons, 1, "there is nothing else to press");
      assert.deepEqual(s.errors, []);
    } finally { await s.page.close(); }
  }
});

for (const embedded of [true, false]) {
  const where = embedded ? "in Work's page" : "in its own tab";
  test(`a Pip's chat ${where}: a paste is cleaned as it lands, and keeps the shape it was copied with`, async (t) => {
    if (skipOrFail(t)) return;
    const p = await openPip({ embedded });
    try {
      await p.box().click();
      await pasteCases(p.page, PIP_BOX, p.$(".paste-note"), () => pipValue(p.page));
      assert.equal(await p.$(".chat-send").first().evaluate((n) => n.classList.contains("ready")), true, "the page heard of the paste");
      await p.page.keyboard.press("Enter");
      await p.page.waitForFunction(() => window.__sent?.length === 1);
      assert.equal(await p.page.evaluate(() => window.__sent[0].text), LIST_SHAPED, "the model reads the same lines");
      await p.$(".pip-message.user .prompt-text").last().waitFor();
      assert.equal(await p.$(".pip-message.user .prompt-text").last().textContent(), LIST_SHAPED);
      assert.deepEqual(p.errors, []);
    } finally { await p.close(); }
  });

  test(`a Pip's chat ${where}: the first line's indentation is sent and drawn, and the row goes with the send and survives a redraw`, async (t) => {
    if (skipOrFail(t)) return;
    const p = await openPip({ embedded });
    try {
      await p.box().click();
      await vscodePaste(p.page, PIP_BOX, { plain: `\n  \n${SHAPED}\u200B\n\n` });
      assert.equal(await p.$(".paste-note").isVisible(), true);
      // The page draws itself again, as it does when a reply streams in. The row is still the row.
      await p.$("#chat-context-toggle").click();
      await p.page.keyboard.press("Escape");
      assert.equal(await p.$(".paste-note").isVisible(), true);
      await p.box().click();
      await p.page.keyboard.press("Enter");
      await p.page.waitForFunction(() => window.__sent?.length === 1);
      assert.equal(await p.page.evaluate(() => window.__sent[0].text), SHAPED);
      await p.$(".pip-message.user .prompt-text").last().waitFor();
      assert.equal(await p.$(".pip-message.user .prompt-text").last().textContent(), SHAPED);
      assert.equal(await p.$(".paste-note").isVisible(), false, "the send took the row");
      assert.deepEqual(p.errors, []);
    } finally { await p.close(); }
  });
}
