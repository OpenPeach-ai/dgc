// Pictures and videos in a reply fold away (0.51: "they always remain opened, and can disturb the user"), the same in
// Work, ChatDGC and a Pip's chat (media/pictureFold.js). Each block has one header row, "1 picture · a fox barista",
// with a chevron: a click, Enter or Space folds it to that line, with a visible focus ring; folded, the header still
// offers Open; the choice goes to the host (which keeps it), comes back after a reload, and Settings -> General ->
// Pictures in replies (Folded) sets where a block nobody chose for starts. In real Chromium, both themes, 300, 460 and
// 900 px.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { THEMES, panelHtml } from "./support/options-scene.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let chromium, browser;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });
const skipOrFail = (t) => {
  if (browser) return false;
  const reason = chromium ? "Chromium could not start" : "playwright is not installed (npm ci at the repository root)";
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};
const foldJs = readFileSync(join(root, "media/pictureFold.js"), "utf8");
const videoJs = readFileSync(join(root, "media/videoPlayer.js"), "utf8");
const REF = "img_" + "a".repeat(32);

async function work(width, theme, folds = null) {
  const { html, mainJs, markdownJs } = panelHtml();
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.setContent(html, { waitUntil: "load" });
  await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; ${THEMES[theme]} } body { background: var(--bg); color: var(--text); }` });
  await page.evaluate(([fold, video, mjs, mdjs, cls]) => {
    window.__posts = [];
    window.acquireVsCodeApi = () => ({ postMessage(m) { window.__posts.push(m); }, getState: () => undefined, setState() {} });
    document.body.classList.add(cls);
    eval(fold); eval(video);
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(mjs);
  }, [foldJs, videoJs, mainJs, markdownJs, theme.startsWith("light") ? "vscode-light" : "vscode-dark"]);
  const post = (data) => page.evaluate((d) => window.dispatchEvent(new MessageEvent("message", { data: d })), data);
  const events = (list) => page.evaluate(async (items) => {
    for (const event of items) { window.dispatchEvent(new MessageEvent("message", { data: { type: "event", event } })); await new Promise((r) => setTimeout(r, 2)); }
  }, list);
  await events([{ type: "ready", capabilities: { image_views: true }, model: "m", mode: "default", think: "off", commands: [],
    custom_commands: [], goal: { text: "", status: "none" }, context_size: 65536, session_id: "s1" }]);
  if (folds) await post({ type: "pictureFolds", ...folds });
  const data = await page.evaluate(() => { const c = document.createElement("canvas"); c.width = 96; c.height = 48;
    const g = c.getContext("2d"); g.fillStyle = "#7c3aed"; g.fillRect(0, 0, 96, 48); return c.toDataURL("image/png"); });
  await events([
    { type: "turn_start", turn_id: "t1", prompt: "Make a fox barista", kind: "prompt" },
    { type: "tool_call", call_id: "g1", name: "generate_image", args: { prompt: "a fox barista" }, summary: "fal · 1 × 512x512 · about $0.003" },
    { type: "tool_images", call_id: "g1", caption: "generated image", images: [data],
      items: [{ ref: REF, name: "a-fox-barista.png", mime: "image/png", width: 96, height: 48, bytes: 4000, source: "view_image", host: "" }] },
    { type: "tool_result", call_id: "g1", name: "generate_image", output: "Made 1 image", is_error: false, is_diff: false },
    { type: "text_delta", text: "Here is the fox barista." },
    { type: "stream_end", message_id: "t1:2", phase: "answer" },
    { type: "turn_end", turn_id: "t1", reason: "completed", token_estimate: 0, final_message_id: "t1:2" }]);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 80)))));
  return { page, post, errors };
}
const facts = (page) => page.evaluate(() => {
  const block = document.querySelector(".answer .pic-fold");
  if (!block) return null;
  const head = block.querySelector(".pic-fold-head").getBoundingClientRect();
  const toggle = block.querySelector(".pic-fold-toggle");
  const body = block.querySelector(".pic-fold-body");
  return { key: block.dataset.picFold, folded: block.dataset.folded, title: block.querySelector(".pic-fold-title").textContent,
    expanded: toggle.getAttribute("aria-expanded"), bodyShown: body.checkVisibility(), headH: Math.round(head.height),
    blockH: Math.round(block.getBoundingClientRect().height), open: block.querySelector(".pic-fold-open")?.checkVisibility() ?? false,
    pictureShown: !!block.querySelector(".made-image img")?.checkVisibility() };
});

for (const theme of ["dark-modern", "light-modern"]) {
  for (const width of [300, 460, 900]) {
    test(`Work, ${theme} at ${width}px: the picture under a reply folds to one line, with Open, and opens again`, async (t) => {
      if (skipOrFail(t)) return;
      const s = await work(width, theme);
      try {
        const shown = await facts(s.page);
        assert.ok(shown, "the picture is in a block that folds");
        assert.equal(shown.title, "1 picture · a fox barista");
        assert.deepEqual([shown.folded, shown.expanded, shown.bodyShown, shown.pictureShown, shown.open], ["false", "true", true, true, false]);
        await s.page.click(".answer .pic-fold-toggle");
        const shut = await facts(s.page);
        assert.deepEqual([shut.folded, shut.expanded, shut.bodyShown, shut.open], ["true", "false", false, true]);
        assert.ok(shut.blockH <= 30 && shut.headH <= 30, `one line folded (${shut.blockH}px)`);
        if (process.env.DGC_SHOTS) await s.page.screenshot({ path: `${process.env.DGC_SHOTS}/work-folded-${theme}-${width}.png` });
        const posted = await s.page.evaluate(() => window.__posts.filter((m) => m.type === "pictureFold"));
        assert.deepEqual(posted, [{ type: "pictureFold", key: shown.key, folded: true }], "the host keeps the choice");
        // Folded, Open still opens the picture in the viewer.
        await s.page.click(".answer .pic-fold-open");
        await s.page.waitForTimeout(150);
        assert.equal(await s.page.locator("#image-viewer").count(), 1, "Open opens the viewer");
        await s.page.keyboard.press("Escape");
        // The keyboard: Enter and Space on the header, with a visible focus ring.
        await s.page.focus(".answer .pic-fold-toggle");
        await s.page.keyboard.press("Enter");
        assert.equal((await facts(s.page)).folded, "false");
        await s.page.keyboard.press(" ");
        assert.equal((await facts(s.page)).folded, "true");
        await s.page.keyboard.press("Tab"); await s.page.keyboard.press("Shift+Tab");
        const ring = await s.page.evaluate(() => { const b = document.activeElement; const st = getComputedStyle(b);
          return { cls: b.className, style: st.outlineStyle, width: parseFloat(st.outlineWidth) }; });
        assert.equal(ring.cls, "pic-fold-toggle");
        assert.ok(ring.style !== "none" && ring.width >= 1, `a focus ring (${JSON.stringify(ring)})`);
        await s.page.keyboard.press("Enter");
        const again = await facts(s.page);
        assert.deepEqual([again.folded, again.pictureShown], ["false", true]);
        assert.deepEqual(s.errors, []);
      } finally { await s.page.close(); }
    });
  }
}

test("Work: a fold holds after a reload (the host's kept choice), and Folded in Settings starts new blocks folded", async (t) => {
  if (skipOrFail(t)) return;
  const first = await work(460, "dark-modern");
  const key = (await facts(first.page)).key;
  await first.page.close();
  const reloaded = await work(460, "dark-modern", { folds: { [key]: true }, folded: false });
  try {
    assert.equal((await facts(reloaded.page)).folded, "true", "folded as it was left");
  } finally { await reloaded.page.close(); }
  const setting = await work(460, "dark-modern", { folds: {}, folded: true });
  try {
    assert.equal((await facts(setting.page)).folded, "true", "Settings → Pictures in replies: Folded");
    await setting.page.click(".answer .pic-fold-toggle");
    await setting.post({ type: "pictureFolds", folded: true });
    assert.equal((await facts(setting.page)).folded, "false", "a person's own choice wins for that reply");
    await setting.post({ type: "pictureFolds", folded: false });
    assert.equal((await facts(setting.page)).folded, "false");
  } finally { await setting.page.close(); }
  const unchosen = await work(460, "dark-modern", { folds: {}, folded: false });
  try {
    await unchosen.post({ type: "pictureFolds", folded: true });
    assert.equal((await facts(unchosen.page)).folded, "true", "a block nobody chose for follows the setting");
  } finally { await unchosen.page.close(); }
});

// ChatDGC: the pictures a reply made (and its pictures from the web) fold the same way.
function chatHtml() {
  const source = readFileSync(join(root, "src/chatdgc.ts"), "utf8");
  const doc = source.match(/return `(<!doctype html>[\s\S]*?<\/html>)`;/)[1];
  const js = [...doc.matchAll(/asset\("media\/([\w-]+\.js)"\)/g)].map((m) => readFileSync(join(root, "media", m[1]), "utf8")).join("\n");
  assert.match(doc, /media\/pictureFold\.js/, "the ChatDGC page loads the fold");
  const clean = doc.replace(/<link [^>]*>/g, "").replace(/<script\b[^>]*><\/script\s*>/gi, "").replace(/\$\{[^}]*\}/g, "");
  const css = readFileSync(join(root, "media/main.css"), "utf8").replace(/@import[^;]*;/, "") + readFileSync(join(root, "media/chatdgc.css"), "utf8");
  const markdownJs = buildSync({ entryPoints: [join(root, "src/markdown.ts")], bundle: true, format: "iife", globalName: "DgcMarkdown", write: false, platform: "browser" }).outputFiles[0].text;
  return { html: clean.replace("</head>", `<style>${css}</style></head>`), js, markdownJs };
}
const ID = `chat_${"a".repeat(32)}`, M = (n) => `msg_${String(n).repeat(32).slice(0, 32)}`, ATT = `att_${"b".repeat(32)}`, WEB = `att_${"c".repeat(32)}`;
for (const theme of ["dark-modern", "light-modern"]) {
  for (const width of [300, 460, 900]) {
    test(`ChatDGC, ${theme} at ${width}px: a reply's pictures fold, and its pictures from the web`, async (t) => {
      if (skipOrFail(t)) return;
      const { html, js, markdownJs } = chatHtml();
      const page = await browser.newPage({ viewport: { width, height: 760 } });
      const errors = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      try {
        await page.setContent(html, { waitUntil: "load" });
        await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; ${THEMES[theme]} }` });
        await page.evaluate(([code, md]) => {
          window.__posted = [];
          window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState: () => undefined, setState() {} });
          eval(md + "\nglobalThis.DgcMarkdown = DgcMarkdown;"); eval(code);
        }, [js, markdownJs]);
        const send = (d) => page.evaluate((x) => window.dispatchEvent(new MessageEvent("message", { data: x })), d);
        await send({ type: "pictureFolds", folds: {}, folded: false });
        await send({ type: "opened", conversation: { id: ID, title: "Ball", model: null, thinking: null, pinned: false, archived: false, temporary: false },
          earlier: 0, busy: false, messages: [{ id: M(1), role: "user", text: "Make a felt purple ball" },
            { id: M(2), role: "assistant", text: "Here it is.", finish: "stop",
              images: { query: "felt balls", items: [{ id: WEB, kind: "image", title: "Felt", url: "https://felt.example/a", site: "felt.example" }] },
              files: [{ id: ATT, kind: "image", name: "felt-purple-ball.png", format: "png", mime: "image/png", size: 4000, made: true }] }] });
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        const titles = await page.locator(".cd-assistant .pic-fold-title").allTextContents();
        assert.deepEqual(titles, ["1 picture · felt balls", "1 picture · felt purple ball"], "a file's name, as words");
        const made = page.locator(".cd-assistant .pic-fold").nth(1);
        await made.locator(".pic-fold-toggle").click();
        assert.equal(await made.getAttribute("data-folded"), "true");
        assert.equal(await made.locator(".cd-file").first().isVisible(), false, "folded: the picture's card is away");
        const box = await made.boundingBox();
        assert.ok(box.height <= 30, `one line (${box.height}px)`);
        await made.locator(".pic-fold-open").click();
        const opened = await page.evaluate(() => window.__posted.filter((m) => m.type === "fileOpen"));
        assert.equal(opened.length, 1, "Open, folded, opens the picture as its card's Open does");
        const posted = await page.evaluate(() => window.__posted.filter((m) => m.type === "pictureFold"));
        assert.deepEqual(posted, [{ type: "pictureFold", key: `chat:${M(2)}:made`, folded: true }]);
        // A redraw (the reply comes again) keeps it folded.
        await send({ type: "message", message: { id: M(2), role: "assistant", text: "Here it is!", finish: "stop",
          files: [{ id: ATT, kind: "image", name: "felt-purple-ball.png", format: "png", mime: "image/png", size: 4000, made: true }] } });
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        assert.equal(await page.locator(`.cd-assistant .pic-fold[data-pic-fold="chat:${M(2)}:made"]`).getAttribute("data-folded"), "true");
        if (process.env.DGC_SHOTS) await page.screenshot({ path: `${process.env.DGC_SHOTS}/chatdgc-folded-${theme}-${width}.png` });
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });
  }
}

// A Pip's chat: its reply's pictures and videos are drawn as markup (src/pipsTranscript.js) with the same header.
test("a Pip's reply: its pictures and its video fold under one header row each, as the page last left them", async () => {
  const bundle = buildSync({ entryPoints: [join(root, "src/pipsTranscript.js")], bundle: true, format: "esm", write: false, platform: "neutral" }).outputFiles[0].text;
  const { messageMarkup } = await import("data:text/javascript;base64," + Buffer.from(bundle).toString("base64"));
  const options = { name: "Studio", formatDate: () => "", renderMarkdown: (t) => `<p>${t}</p>`, prompt: "", canSend: false, imageSrc: () => "" };
  const reply = { id: "message_a", role: "assistant", text: "Two takes and a clip.", images: [{ index: 0 }, { index: 1 }],
    videos: [{ id: "vid_" + "1".repeat(12), prompt: "a drone over the sea" }] };
  const html = messageMarkup(reply, options);
  assert.match(html, /data-pic-fold="pip:message_a:images"/);
  assert.match(html, /<span class="pic-fold-title">2 pictures<\/span>/);
  assert.match(html, /data-pic-fold="pip:message_a:videos"/);
  assert.match(html, /<span class="pic-fold-title">1 video · a drone over the sea<\/span>/);
  assert.equal(globalThis.DgcPictureFold.summary({ pictures: 1, label: "a-small-handmade-felt-fox-toy-20261103-022626.png" }),
    "1 picture · a small handmade felt fox toy", "a made picture's file name, as words");
  assert.match(html, /data-message-image="message_a:0" data-pic-open/);
  assert.ok(html.indexOf("Two takes") < html.indexOf("pic-fold"), "after its words");
  globalThis.DgcPictureFold.message({ type: "pictureFolds", folds: { "pip:message_a:images": true }, folded: false });
  const again = messageMarkup(reply, options);
  assert.match(again, /data-pic-fold="pip:message_a:images" data-folded="true"/);
  assert.match(again, /data-pic-fold="pip:message_a:videos" data-folded="false"/);
  assert.doesNotMatch(messageMarkup({ id: "message_u", role: "user", text: "(sent an image)", images: [{ index: 0 }] }, options), /pic-fold/,
    "a photo you sent isn't folded");
});

// Work: the video a turn started (media/videoPlayer.js) folds as a picture does, under its own header row.
test("Work: a turn's video folds under one header row, its player inside", async (t) => {
  if (skipOrFail(t)) return;
  const { html, mainJs, markdownJs } = panelHtml();
  const page = await browser.newPage({ viewport: { width: 460, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  try {
    await page.setContent(html, { waitUntil: "load" });
    await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; ${THEMES["dark-modern"]} }` });
    await page.evaluate(([fold, video, mjs, mdjs]) => {
      window.__posts = [];
      window.acquireVsCodeApi = () => ({ postMessage(m) { window.__posts.push(m); }, getState: () => undefined, setState() {} });
      eval(fold); eval(video); eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;"); eval(mjs);
    }, [foldJs, videoJs, mainJs, markdownJs]);
    const events = (list) => page.evaluate(async (items) => {
      for (const event of items) { window.dispatchEvent(new MessageEvent("message", { data: { type: "event", event } })); await new Promise((r) => setTimeout(r, 2)); }
    }, list);
    const JOB = "vid_" + "a".repeat(12);
    await events([{ type: "ready", capabilities: {}, model: "m", mode: "default", think: "off", commands: [], custom_commands: [],
      goal: { text: "", status: "none" }, context_size: 65536, session_id: "s1" },
      { type: "turn_start", turn_id: "t1", prompt: "Animate the felt ball", kind: "prompt" },
      { type: "tool_call", call_id: "v1", name: "generate_video", args: { prompt: "a felt ball rolls across a desk" }, summary: "fal Wan 2.2" },
      { type: "tool_result", call_id: "v1", name: "generate_video", is_error: false, is_diff: false,
        output: `Started a 5 s video with fal Wan 2.2 5B (720p, about $0.15), about 1–2 min (job ${JOB}).` },
      { type: "text_delta", text: "It's on its way." },
      { type: "stream_end", message_id: "t1:2", phase: "answer" },
      { type: "turn_end", turn_id: "t1", reason: "completed", token_estimate: 0, final_message_id: "t1:2" }]);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 80)))));
    const block = page.locator(".answer .pic-fold");
    assert.equal(await block.locator(".pic-fold-title").textContent(), "1 video · a felt ball rolls across a desk");
    assert.equal(await block.locator(".pic-fold-body figure.made-video").count(), 1, "its player inside");
    assert.equal(await block.locator(".pic-fold-open").count(), 0, "no Open for a video-only block: its header shows it");
    await block.locator(".pic-fold-toggle").click();
    assert.equal(await block.getAttribute("data-folded"), "true");
    assert.equal(await block.locator("figure.made-video").isVisible(), false);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("standalone Pip bootstrap persists picture and video folds across reload", async () => {
  const { JSDOM } = await import("jsdom");
  const client = buildSync({ entryPoints: [join(root, "src/pipsClient.js")], bundle: true, write: false,
    loader: { ".css": "empty" }, format: "iife" }).outputFiles[0].text;
  const folds = {}, sent = [];
  function boot() {
    const w = new JSDOM('<body><main id="app"></main><div id="review-root"></div></body>',
      { runScripts: "outside-only", pretendToBeVisual: true }).window;
    w.HTMLCanvasElement.prototype.getContext = () => null;
    w.TextEncoder = TextEncoder;
    w.acquireVsCodeApi = () => ({ getState() {}, setState() {}, postMessage(m) {
      sent.push(m);
      if (m.type === "pictureFold") folds[m.key] = m.folded;
    } });
    w.eval(client);
    w.dispatchEvent(new w.MessageEvent("message", { data: { type: "pictureFolds", folds } }));
    for (const kind of ["pictures", "videos"]) {
      w.document.body.insertAdjacentHTML("beforeend", w.DgcPictureFold.markup(`pip:test:${kind}`,
        kind === "pictures" ? "<img>" : "<video></video>", { [kind]: 1 }));
    }
    return w;
  }
  const first = boot();
  try {
    first.document.querySelectorAll(".pic-fold-toggle").forEach((button) => button.click());
    assert.equal(sent.filter((m) => m.type === "pictureFold").length, 2);
    assert.deepEqual(folds, { "pip:test:pictures": true, "pip:test:videos": true });
  } finally { first.close(); }
  const reloaded = boot();
  try {
    assert.equal(reloaded.document.querySelectorAll('.pic-fold[data-folded="true"]').length, 2);
    assert.equal(reloaded.document.querySelectorAll('.pic-fold-body[hidden]').length, 2);
  } finally { reloaded.close(); }
});
