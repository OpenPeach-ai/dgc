// Links in ChatDGC, as in Work's box and a Pip's (15 Nov: "same with chat sessions, same URL paste treatment we have in
// work session prompt box"). In ChatDGC's own page, in real Chromium: one pasted link is a pill and the model is sent
// the link itself; a paragraph with a link in it stays text; a sent message's links are links with their site's
// favicon, and the bundled mark when that icon cannot load. Its page lets an icon load only while dgc.linkFavicons is on.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { M, conversation, openChat } from "./support/chat-scene.mjs";

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
before(async () => { if (!chromium) return; try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; } });
after(async () => { await browser?.close(); });

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAHUlEQVR4nGMsC/n2n4ECwESJ5lEDRg0YNWAwGQAAZakC32PgnS0AAAAASUVORK5CYII=", "base64");
const LINK = "https://vibedgc.com/pricing?ref=chat";
const PROSE = "Compare https://vibedgc.com/pricing with what we pay now, then tell me.";
const ICON = (origin) => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(origin)}&sz=32`;
const SAID = [{ id: M(1), role: "user", text: "Read https://vibedgc.com/pricing?ref=chat and https://github.com/openai/codex.", created_at: "2026-11-15T09:20:00Z" },
  { id: M(2), role: "assistant", text: "Both read.", finish: "stop", created_at: "2026-11-15T09:20:05Z" }];

async function chat({ icons = "answer", favicons = true, messages = [], width = 900 } = {}) {
  const s = await openChat(browser, { width, height: 700 });
  const asked = [];
  await s.page.route("https://www.google.com/**", (route) => { asked.push(route.request().url()); return icons === "answer" ? route.fulfill({ contentType: "image/png", body: PNG }) : route.abort(); });
  await s.send({ type: "opened", conversation: conversation(), messages, earlier: 0, busy: false });
  await s.send({ type: "models", ids: ["deepseek-v4.1-flash:cloud"], current: "deepseek-v4.1-flash:cloud" });
  await s.send({ type: "favicons", on: favicons });
  return { s, asked };
}
const paste = (s, text) => s.page.evaluate((words) => {
  const box = document.getElementById("cd-input"); box.focus();
  const data = new DataTransfer(); data.setData("text/plain", words);
  box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
}, text);
const box = (s) => s.page.evaluate(() => { const el = document.getElementById("cd-input");
  return { text: el.value, pills: [...el.querySelectorAll("[data-pill]")].map((n) => ({ kind: n.dataset.kind, wire: n.dataset.pill, shown: n.textContent, title: n.title, imgs: n.querySelectorAll("img").length })) }; });
const sentLinks = (s) => s.page.evaluate(() => [...document.querySelectorAll(".cd-msg.cd-user .cd-bubble .md-link")].map((a) => { const img = a.querySelector("img.link-favicon");
  return { target: a.dataset.target, kind: a.dataset.linkKind, words: a.textContent, prompt: a.classList.contains("prompt-link"), src: img?.getAttribute("src") || null, drew: !!img && img.complete && img.naturalWidth > 0,
    mark: a.dataset.linkSource || null, fallback: a.dataset.linkFallback || null }; }));

test("one pasted link is a pill in ChatDGC's box, and the model is sent the link itself", async (t) => {
  if (skipOrFail(t)) return;
  const { s, asked } = await chat();
  try {
    await paste(s, LINK);
    const held = await box(s);
    assert.deepEqual(held.pills, [{ kind: "link", wire: LINK, shown: "vibedgc.com/pricing", title: LINK, imgs: 0 }], "one pill: its site and path shown, the whole link kept, no icon in the box");
    assert.equal(held.text, LINK);
    assert.deepEqual(asked, [], "pasting asks the icon service nothing");
    await s.page.locator("#cd-send").click();
    const sends = await s.posted("send");
    assert.equal(sends.length, 1);
    assert.equal(sends[0].text, LINK, "what is sent is the link, character for character");
    assert.equal("display_mentions" in sends[0], false, "a link is words, never a display mark");
    // The bubble it leaves is a link with its site's favicon.
    await s.page.waitForFunction(() => document.querySelector(".cd-msg.cd-user .cd-bubble .md-link img.link-favicon")?.naturalWidth > 0, null, { timeout: 5000 });
    const [shown] = await sentLinks(s);
    assert.deepEqual({ target: shown.target, kind: shown.kind, words: shown.words, prompt: shown.prompt, src: shown.src, mark: shown.mark },
      { target: LINK, kind: "external", words: LINK, prompt: true, src: ICON("https://vibedgc.com"), mark: null });
    assert.ok(asked.every((u) => !/pricing|ref=chat/.test(u)), "only the site is asked about");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("a paragraph with a link in it stays text in ChatDGC's box", async (t) => {
  if (skipOrFail(t)) return;
  const { s } = await chat();
  try {
    await paste(s, PROSE);
    const held = await box(s);
    assert.deepEqual(held.pills, []);
    assert.equal(held.text, PROSE);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("a sent message's links are links with their favicons, and open through the host", async (t) => {
  if (skipOrFail(t)) return;
  const { s, asked } = await chat({ messages: SAID });
  try {
    await s.page.waitForFunction(() => { const all = [...document.querySelectorAll(".cd-msg.cd-user .cd-bubble .md-link img.link-favicon")]; return all.length === 2 && all.every((i) => i.naturalWidth > 0); }, null, { timeout: 5000 });
    const shown = await sentLinks(s);
    assert.deepEqual(shown.map((a) => [a.target, a.src, a.mark, a.prompt]), [["https://vibedgc.com/pricing?ref=chat", ICON("https://vibedgc.com"), null, true], ["https://github.com/openai/codex", ICON("https://github.com"), null, true]]);
    assert.equal(await s.page.evaluate(() => document.querySelector(".cd-msg.cd-user .cd-bubble").textContent), SAID[0].text, "the message reads as it was typed");
    const sizes = await s.page.evaluate(() => [...document.querySelectorAll(".cd-bubble .md-link img.link-favicon")].map((i) => Math.round(i.getBoundingClientRect().width)));
    assert.ok(sizes.every((w) => w >= 12 && w <= 18), `each icon is the size of its words: ${sizes}`);
    assert.ok(asked.every((u) => /domain=https%3A%2F%2F(vibedgc\.com|github\.com)&sz=32$/.test(u)));
    await s.page.locator(".cd-msg.cd-user .cd-bubble .md-link").first().click();
    const opened = (await s.posted()).filter((m) => /open/i.test(m.type) && (m.url || m.target) === "https://vibedgc.com/pricing?ref=chat");
    assert.equal(opened.length, 1, "the host is asked to open it, as for a reply's link");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("a sent link's favicon that cannot load is its bundled mark", async (t) => {
  if (skipOrFail(t)) return;
  const { s } = await chat({ messages: SAID, icons: "refuse" });
  try {
    await s.page.waitForFunction(() => { const all = [...document.querySelectorAll(".cd-msg.cd-user .cd-bubble .md-link")]; return all.length === 2 && all.every((a) => !a.querySelector("img") && a.dataset.linkSource); }, null, { timeout: 5000 });
    assert.deepEqual((await sentLinks(s)).map((a) => [a.mark, a.fallback]), [["dgc", null], ["github", null]]);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("with dgc.linkFavicons off a sent message's links ask for nothing", async (t) => {
  if (skipOrFail(t)) return;
  const { s, asked } = await chat({ messages: SAID, favicons: false });
  try {
    await s.page.waitForTimeout(400);
    const shown = await sentLinks(s);
    assert.equal(shown.length, 2, "they are still links");
    assert.ok(shown.every((a) => a.src === null && a.mark), "each its bundled mark");
    assert.equal(await s.page.locator("img.link-favicon").count(), 0);
    assert.deepEqual(asked, []);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

// The page's own policy, as src/chatdgc.ts writes it.
const root = new URL("..", import.meta.url).pathname;
async function documents() {
  const code = (await build({ entryPoints: [root + "src/chatdgc.ts"], bundle: true, write: false, platform: "node", format: "cjs", external: ["vscode"] })).outputFiles[0].text;
  const stub = { workspace: { getConfiguration: () => ({ get: (_k, d) => d }) }, EventEmitter: class { event = () => {}; fire() {} } };
  const out = { exports: {} };
  new Function("module", "exports", "require", code)(out, out.exports, (n) => (n === "vscode" ? stub : createRequire(import.meta.url)(n)));
  return out.exports.chatdgcDocument;
}
const policy = (html) => /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)[1];
const imgSrc = (html) => policy(html).split(";").map((d) => d.trim()).find((d) => d.startsWith("img-src"));

test("ChatDGC's page lets the icon service's images in only while dgc.linkFavicons is on", async (t) => {
  const chatdgcDocument = await documents();
  const asset = (name) => `https://chat.test/${name}`;
  const on = chatdgcDocument(asset, "https://chat.test", true), off = chatdgcDocument(asset, "https://chat.test", false);
  assert.equal(imgSrc(on), "img-src https://chat.test data: https://www.google.com https://*.gstatic.com", "on: the icon service, as before");
  assert.equal(imgSrc(off), "img-src https://chat.test data:", "off: the editor's own origin and data: only");
  assert.doesNotMatch(policy(off), /google|gstatic|https:(\s|;|$)/, "no icon host anywhere in the policy");
  assert.equal(off.replace(policy(off), ""), on.replace(policy(on), ""), "nothing else about the page differs");
  if (skipOrFail(t)) return;
  // In Chromium, that policy stops an icon before it leaves; the other lets it through.
  for (const [html, lets] of [[off, false], [on, true]]) {
    const page = await browser.newPage();
    try {
      const asked = [];
      await page.route("https://www.google.com/**", (route) => { asked.push(route.request().url()); return route.fulfill({ contentType: "image/png", body: PNG }); });
      await page.setContent(`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy(html).replace(/script-src [^;]*;/, "script-src 'unsafe-inline';")}"></head><body></body></html>`);
      const drew = await page.evaluate(() => new Promise((done) => { const img = new Image(); img.onload = () => done(true); img.onerror = () => done(false);
        img.src = "https://www.google.com/s2/favicons?domain=https%3A%2F%2Fvibedgc.com&sz=32"; document.body.append(img); }));
      assert.equal(drew, lets);
      assert.equal(asked.length, lets ? 1 : 0, lets ? "on: asked once" : "off: the request never left");
    } finally { await page.close(); }
  }
});

test("the host gives the page the setting it read when it wrote the policy", async () => {
  const source = (await import("node:fs")).readFileSync(root + "src/chatdgc.ts", "utf8");
  assert.match(source, /chatdgcDocument\(asset, panel\.webview\.cspSource, [A-Za-z.()]*[fF]avicons[A-Za-z.()]*\)/, "the tab's document is written with dgc.linkFavicons");
});
