// Pictures of one kind of Pip on screen (0.52), in real Chromium on the stand-in DGC of test/support/one-pips-scene.mjs:
// a Pip with a folder's chat and page (Reply, the context meter, its computers' menu, the "/" menu, the model menu, a
// new conversation's computer step, its page with Links and Files, its ⋯ menu), a Pip with no folder's page, New Pip,
// and the "@" list in Work, ChatDGC and a Pip's chat, in a project that has a .env, keys, __pycache__ and node_modules
// beside its source (the list is what the real src/mentionsHost.ts gives for that folder). Dark and light, at 300, 440
// and 700 px. With DGC_PIPS_SRC set to another tree's src folder the same pictures are of that tree: the page as it was.
// Not a test.
//   PLAYWRIGHT_BROWSERS_PATH=~/.cache/ms-playwright node test/render-one-kind.mjs <folder to write into> [only: a name's start]
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { chromium } from "@playwright/test";
import { GST, MORNINGS, openOnePips } from "./support/one-pips-scene.mjs";
import { THEMES, panelHtml } from "./support/options-scene.mjs";
import { readStylesheet } from "./support/stylesheet.mjs";
import { mentionsHost, project } from "./support/mention-files-host.mjs";

const out = process.argv[2], only = process.argv[3] || "";
if (!out) throw new Error("say where the pictures go");
mkdirSync(out, { recursive: true });
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] });
const want = (name) => !only || name.startsWith(only);
const hex = (c) => c.repeat(32), now = new Date().toISOString(), SAID = "msg_" + hex("2");
const SCENE = { fix: "none", posts: false, waiting: false, attention: false, computers: 2, convs: true, context: 2048, look: { [GST]: "lock" },
  chat: { [GST]: { messages: [{ id: "msg_" + hex("1"), role: "user", text: "How did tonight's check go?", run_id: "run_" + hex("8"), status: "succeeded" },
    { id: SAID, role: "assistant", text: "All green tonight. Nothing new in the GST code, and the e-way bill tests pass.", run_id: "run_" + hex("8"), status: "succeeded" }] } },
  models: [{ id: "m", name: "m" }, { id: "qwen3-coder:480b", name: "qwen3-coder:480b" }, { id: "deepseek-v4.1-flash:cloud", name: "deepseek-v4.1-flash:cloud" }],
  shared: { links: [{ from: "pip", at: now, message_id: SAID, url: "https://example.com/gst/e-way-bill-rules", host: "example.com" }, { from: "you", at: now, message_id: "msg_" + hex("1"), url: "https://example.org/portal/status", host: "example.org" }], media: [], files: [] },
  apps: [{ id: "gmail", name: "Gmail", kind: "app", on: true, accounts: ["me@example.com"] }, { id: "github", name: "GitHub", kind: "plugin", on: false }],
  skills: [{ name: "tidy-notes", description: "Tidy a page of notes into headings and short lines", source: "yours", on: true }, { name: "evening-report", description: "How the evening report is laid out", source: "yours", on: true }],
  logins: [{ id: "login_" + hex("1"), site: "portal.example.com", hosts: ["portal.example.com"], username: "accounts@example.com", has_code: true, pips: "all", source: "page", created_at: now, last_used_at: null, usable: true }] };

// ---- the project the "@" lists are of, and what the host gives each box for it
const made = project([".env", ".env.local", ".env.example", ".gitignore", "README.md", "app/main.py", "app/billing/eway.py", "app/billing/__pycache__/eway.cpython-312.pyc", "app/__pycache__/main.cpython-312.pyc",
  "certs/server.pem", "certs/server.key", "id_rsa", "node_modules/left-pad/index.js", "venv/lib/site.py", "build/lib/app/main.py", "tests/test_eway.py", ".git/config", ".pytest_cache/v/cache/lastfailed", "coverage/index.html", "package-lock.json"]);
const FILES = await (await mentionsHost(made.root)).module.workspaceFiles();
made.remove();
console.log(`@ offers: ${FILES.map((f) => f.label).join(", ")}`);

const settle = (page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
const shot = async (x, name, full = false) => {
  await x.page.mouse.move(2, 2); await settle(x.page);
  if (full) {
    const scroller = (root) => { for (let e = root.querySelector(".pip-page") || root.querySelector(".conversation-log") || root.querySelector(".simple-content"); e; e = e.parentElement) if (e.scrollHeight > e.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(e).overflowY)) return e; return null; };
    const need = await x.inPips((r, find) => { const e = (0, eval)(`(${find})`)(r); return e ? Math.ceil(e.scrollHeight - e.clientHeight) : 0; }, scroller.toString());
    if (need > 0) { const size = x.page.viewportSize(); await x.page.setViewportSize({ width: size.width, height: Math.min(4200, size.height + need + 8) }); await settle(x.page);
      await x.inPips((r, find) => { const e = (0, eval)(`(${find})`)(r); if (e) e.scrollTop = 0; }, scroller.toString()); await settle(x.page); }
  }
  await x.page.screenshot({ path: `${out}/${name}.png` }); console.log(name);
};
const toPage = async (x) => { await x.inPips((r) => [...r.querySelectorAll(".pip-topbar .pip-menu [data-tab]")].find((b) => b.dataset.tab === "job").click()); await x.waitIn(".pip-page"); await x.page.waitForTimeout(500); };
const type = async (x, words) => { await x.inPips((r) => r.querySelector("#chatText").focus()); await x.page.keyboard.type(words); await x.page.waitForTimeout(300); };
const attempt = async (name, run) => { try { await run(); } catch (error) { console.log(`${name}: not drawn here (${String(error.message || error).split("\n")[0]})`); } };

// ---- ChatDGC's own page, as test/mentions-boxes.test.mjs builds it
function chatHtml() {
  const read = (name) => readFileSync(join(root, name), "utf8");
  const source = read("src/chatdgc.ts"), doc = source.match(/return `(<!doctype html>[\s\S]*?<\/html>)`;/)[1];
  const page = doc.replace(/<link [^>]*>/g, "").replace(/<script [^>]*><\/script>/g, "").replace(/\$\{[^}]*\}/g, "").replace("font-src ;", "font-src data:;");
  const codicon = read("media/codicon.css").replace(/url\([^)]*codicon\.ttf[^)]*\)/, `url("data:font/ttf;base64,${readFileSync(join(root, "media/codicon.ttf")).toString("base64")}")`);
  const css = [readStylesheet(join(root, "media/main.css")), read("media/mentions.css"), read("media/chatdgc.css"), read("media/voicebar.css")];
  const js = [...doc.matchAll(/asset\("media\/([\w/-]+\.js)"\)/g)].map((m) => read(`media/${m[1]}`)).join("\n");
  const markdownJs = buildSync({ entryPoints: [join(root, "src/markdown.ts")], bundle: true, format: "iife", globalName: "DgcMarkdown", write: false, platform: "browser" }).outputFiles[0].text;
  return { html: page.replace("</head>", `<style>${codicon}</style>${css.map((c) => `<style>${c}</style>`).join("")}</head>`), js, markdownJs };
}
const chat = chatHtml();
const themed = async (page, theme) => { await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; --vscode-font-size: 13px; --vscode-editor-font-family: ui-monospace, monospace; ${THEMES[theme]} }` });
  await page.evaluate((t) => document.body.classList.add(t.startsWith("light") ? "vscode-light" : "vscode-dark"), theme); };

for (const theme of ["dark", "light"]) for (const width of [700, 440, 300]) {
  const tag = `${theme}-${width}`, opts = { theme: `${theme}-modern`, width, height: 760, scale: 2, api: 97, faces: true, scene: SCENE };
  let x;
  if (want("chat")) {
    x = await openOnePips(browser, opts); await x.openPip(GST); await x.page.waitForTimeout(700);
    await shot(x, `chat-${tag}`);
    await attempt("reply", async () => { await x.click('[data-chat-action="reply"]'); await x.waitIn(".chat-reply-text", 3000); await shot(x, `chat-reply-${tag}`); await x.click("[data-reply-remove]"); });
    await attempt("computers", async () => { await x.click("#pip-computer-open"); await x.waitIn("#computer-menu", 3000); await x.page.waitForTimeout(300); await shot(x, `chat-computers-menu-${tag}`); await x.page.keyboard.press("Escape"); await x.page.waitForTimeout(200); });
    await x.inPips((r) => r.querySelector(".pip-topbar .pip-menu summary").click()); await x.page.waitForTimeout(250); await shot(x, `chat-more-menu-${tag}`);
    await x.inPips((r) => r.querySelector(".pip-topbar .pip-menu").removeAttribute("open"));
    await attempt("conversation", async () => { await x.waitIn("#pip-convs", 3000); await x.click("#pip-convs"); await x.waitIn("#conv-menu [data-conv-new]", 3000); await x.click("#conv-menu [data-conv-new]"); await x.page.waitForTimeout(500); await shot(x, `chat-new-conversation-${tag}`); });
    await x.close();
    x = await openOnePips(browser, opts); await x.openPip(GST); await x.page.waitForTimeout(500);
    await type(x, "/"); await x.page.waitForTimeout(300); await shot(x, `slash-menu-${tag}`);
    await x.close();
    x = await openOnePips(browser, opts); await x.openPip(GST); await x.page.waitForTimeout(500);
    await attempt("model", async () => { await x.click("#chat-model"); await x.waitIn(".composer-model-menu", 3000); if (await x.inPips((r) => !r.querySelector("[data-chat-model]"))) { await x.click("#chat-model-summary"); await x.waitIn("[data-chat-model]", 3000); } await x.page.waitForTimeout(300); await shot(x, `model-menu-${tag}`); });
    await x.close();
  }
  if (want("page")) {
    x = await openOnePips(browser, opts); await x.openPip(GST); await x.page.waitForTimeout(500); await toPage(x); await x.page.waitForTimeout(600);
    await shot(x, `page-${tag}`, true);
    await x.close();
    x = await openOnePips(browser, opts); await x.openPip(GST); await x.page.waitForTimeout(500); await toPage(x);
    for (const tab of ["links", "files"]) { await x.click(`[data-pip-page-tab="${tab}"]`); await x.page.waitForTimeout(700); await shot(x, `page-${tab}-${tag}`); }
    await x.close();
    x = await openOnePips(browser, { ...opts, scene: { ...SCENE, mine: true } }); await x.openPip(MORNINGS); await x.page.waitForTimeout(500); await toPage(x); await x.page.waitForTimeout(500);
    await shot(x, `page-no-folder-${tag}`, true);
    await x.close();
  }
  if (want("new")) {
    x = await openOnePips(browser, opts);
    await shot(x, `list-${tag}`);
    await x.click("#simple-new"); await x.waitIn("#review-root .dialog"); await x.page.waitForTimeout(300); await shot(x, `new-pip-${tag}`);
    await x.close();
  }
  if (want("at")) {
    // A Pip's chat: the host answers its pipsFiles with the folder's files.
    x = await openOnePips(browser, opts); await x.openPip(GST); await x.page.waitForTimeout(500);
    await type(x, "@"); await x.send({ type: "pipsFiles", files: FILES.map((f) => ({ label: f.relative_path })) }); await x.page.waitForTimeout(200);
    await x.page.keyboard.press("Backspace"); await x.page.keyboard.type("@"); await x.page.waitForTimeout(400); await shot(x, `at-pips-${tag}`);
    await x.close();
    // Work's box.
    { const { html, mainJs, markdownJs } = panelHtml();
      const page = await (await browser.newContext({ viewport: { width, height: 760 }, deviceScaleFactor: 2, reducedMotion: "reduce" })).newPage();
      await page.setContent(html, { waitUntil: "load" }); await themed(page, `${theme}-modern`);
      // (The panel links these two beside main.css: the list's own sheet, and the file marks' font.)
      await page.addStyleTag({ content: readFileSync(join(root, "media/mentions.css"), "utf8") + `@font-face { font-family: seti; src: url("data:font/woff;base64,${readFileSync(join(root, "media/seti.woff")).toString("base64")}") format("woff"); }` });
      await page.evaluate(([mjs, mdjs, files]) => { window.acquireVsCodeApi = () => ({ getState: () => undefined, setState() {}, postMessage(m) { if (m?.type === "reqFiles") setTimeout(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "files", files } })), 5); } });
        eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;"); eval(mjs); }, [mainJs, markdownJs, FILES]);
      const send = (event) => page.evaluate((e) => window.dispatchEvent(new MessageEvent("message", { data: { type: "event", event: e } })), event);
      await send({ type: "ready", version: "0.52.0", protocol_version: 14, capabilities: { live_steering: true }, model: "qwen3.8:27b", mode: "default", think: "off", base_url: "http://localhost:11434/v1", workspace_trusted: true, commands: [], custom_commands: [], goal: { text: "", status: "none" }, context_size: 65536, session_id: "s1" });
      await attempt("work", async () => { await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "sessions_list", items: [], error: "" } })));
        const box = page.locator("#input"); if (!(await box.isVisible())) { await page.evaluate(() => document.querySelector('#side-tabs [data-tab="work"], #side-tabs [data-side="work"]')?.click()); await page.waitForTimeout(300); }
        if (!(await box.isVisible())) await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => /New session/i.test(b.textContent || b.title || "") && b.checkVisibility())?.click());
        await page.waitForTimeout(300); await box.click({ timeout: 4000 }); await page.keyboard.type("Look at @"); await page.waitForTimeout(600);
        await page.screenshot({ path: `${out}/at-work-${tag}.png` }); console.log(`at-work-${tag}`); });
      await page.context().close(); }
    // ChatDGC's box.
    { const page = await (await browser.newContext({ viewport: { width, height: 760 }, deviceScaleFactor: 2, reducedMotion: "reduce" })).newPage();
      await page.setContent(chat.html, { waitUntil: "load" }); await themed(page, `${theme}-modern`);
      await page.evaluate(([code, md]) => { window.acquireVsCodeApi = () => ({ postMessage() {}, getState: () => undefined, setState() {} }); eval(md + "\nglobalThis.DgcMarkdown = DgcMarkdown;"); eval(code); }, [chat.js, chat.markdownJs]);
      const send = (data) => page.evaluate((d) => window.dispatchEvent(new MessageEvent("message", { data: d })), data);
      await send({ type: "opened", conversation: { id: `chat_${hex("c")}`, title: "New chat", model: null, thinking: null, pinned: false, archived: false, temporary: false }, messages: [], models: ["deepseek-v4.1-flash:cloud"], defaultModel: "deepseek-v4.1-flash:cloud", thinking: "off" });
      await send({ type: "mentionSources", offered: true, plugins: [], pips: [], error: "" });
      await send({ type: "files", files: FILES });
      await attempt("chatdgc", async () => { await page.locator("#cd-input").click({ timeout: 4000 }); await page.keyboard.type("Read @"); await page.waitForTimeout(500);
        await page.screenshot({ path: `${out}/at-chatdgc-${tag}.png` }); console.log(`at-chatdgc-${tag}`); });
      await page.context().close(); }
  }
}
await browser.close();
