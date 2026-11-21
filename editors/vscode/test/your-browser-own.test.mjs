// Your Browser, phase 3b (Pips API 107; his calls, 18 Nov), measured in real Chromium:
//   - Install Google Chrome: where Google Chrome is needed, Home's Browser card and the dock's tile offer ONE button.
//     A small dialog first says what it does ("Installs Google Chrome from Google's own package source, as you would
//     yourself. Your computer asks for your password.") with Install and Cancel; Install asks DGC (the computer's own
//     password prompt does the rest), the card says it is installing and asks again until it ends, then is the field and
//     the links by itself. Where no password prompt can open (Remote-SSH) or it was closed, the one terminal line with
//     Copy. Never a command in the reason's words; one design language (6 px corners, button heights, never a pill).
//   - Your own tab (no screen where DGC runs): "Open Your Browser" opens an editor tab that streams your own tab,
//     usable: clicks where they were made, typing, keys, a paste, the address bar, Back, Forward, Reload, your tabs with
//     New tab and Close; one quiet line says what can't work there. Only that tab may ask for your own tab: the host
//     refuses it from every other page, and a Pip's tab can never ask for it.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { openDock, dockNow } from "./support/dock-scene.mjs";
import { openHome, homeState } from "./support/home-scene.mjs";
import { THEMES } from "./support/agent-lines-scene.mjs";

const require = createRequire(import.meta.url), src = fileURLToPath(new URL("../src/", import.meta.url));
const view = (await build({ entryPoints: [src + "pipsView.ts"], bundle: true, write: false, platform: "node", format: "cjs", external: ["vscode"] })).outputFiles[0].text;
const host = (() => { const out = { exports: {} }; new Function("module", "exports", "require", view)(out, out.exports, (name) => (name === "vscode" ? {} : require(name))); return out.exports; })();
const AVA = "pip_" + "a".repeat(32);
const PICTURES = process.env.DGC_YB_PICTURES || "";
const LINE = "Passkeys, security keys and your computer’s password manager don’t work in this tab.";
const DIALOG_WORDS = "Installs Google Chrome from Google’s own package source, as you would yourself. Your computer asks for your password.";
const TERMINAL = "sudo sh -c 'set -eu; export DEBIAN_FRONTEND=noninteractive; t=$(mktemp -d); u=https://dl.google.com/linux/linux_signing_key.pub; apt-get install -y google-chrome-stable'";
const NEEDS = "Your Browser runs in Google Chrome, which isn't on this computer yet.";

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
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

// ---- the host: only your own tab's page asks for your own tab ---------------------------------------------------------
test("the host lets only Your Browser's own tab ask for your own tab", () => {
  const ok = (request) => assert.equal(host.yourOwnTabRefusal(request), "", JSON.stringify(request));
  const no = (request, why) => assert.match(host.yourOwnTabRefusal(request), /only shows your own tabs/, why || JSON.stringify(request));
  for (const op of ["frame", "input", "go", "back", "forward", "reload", "new_tab", "tab", "close_tab", "size", "close", "selection"]) ok({ type: "use_your_browser_view", own: true, op });
  ok({ type: "use_your_browser_view", own: true, op: "input", events: [{ t: "text", text: "hi" }] });
  ok({ type: "use_your_browser_view", own: true, op: "frame", seq: 4 });
  no({ type: "use_your_browser_view", own: true, op: "frame", pip_id: AVA }, "never a Pip's lane from it");
  no({ type: "use_your_browser_view", op: "frame" }, "own, always");
  no({ type: "use_your_browser_view", own: true, op: "explode" });
  no({ type: "use_your_browser_view", own: true, op: "frame", path: "/etc" });
  no({ type: "install_google_chrome" });
  no({ type: "open_your_browser", url: "example.com" });
  no(null);
  // Every other page: a Pip's tab can't, and the side bar or the Pips page never asks for it (asksForYourOwnTab).
  assert.match(host.yourBrowserTabRefusal({ type: "use_your_browser_view", pip_id: AVA, op: "frame", own: true }, AVA), /only shows this Pip/);
  assert.equal(host.asksForYourOwnTab({ type: "use_your_browser_view", own: true, op: "frame" }), true);
  assert.equal(host.asksForYourOwnTab({ type: "use_your_browser_view", own: false, op: "frame" }), true);
  assert.equal(host.asksForYourOwnTab({ type: "use_your_browser_view", pip_id: AVA, op: "frame" }), false);
  assert.equal(host.asksForYourOwnTab({ type: "install_google_chrome" }), false);
  const source = readFileSync(src + "pipsView.ts", "utf8");
  const main = source.slice(source.indexOf("  receive(message: any, surface = 'main'): void {"));
  assert.ok(main.indexOf("if (asksForYourOwnTab(message.request))") > 0 && main.indexOf("if (asksForYourOwnTab(message.request))") < main.indexOf("if (computer) { const refused = computerTabRefusal"),
    "the side bar, the Pips page, a chat or a computer tab: refused before anything else");
  assert.match(source, /const title = pip \? `\$\{pip\.name\} · Your Browser` : 'Your Browser';/);
  assert.match(source, /if \(message\.own === true\) \{ this\.openYourBrowserTab\(null\); return; \}/);
  assert.match(source, /use_your_browser_view', own: true, op: 'close'/, "closing it stops the stream");
  assert.equal(host.YOUR_BROWSER_API, 107);
});

// ---- your own tab, streamed ---------------------------------------------------------------------------------------------
const bundle = await build({ entryPoints: [src + "yourBrowserTab.js"], bundle: true, write: false, format: "iife", platform: "browser", outdir: "out", target: "chrome108" });
const pageJs = bundle.outputFiles.find((f) => f.path.endsWith(".js")).text, pageCss = bundle.outputFiles.find((f) => f.path.endsWith(".css")).text;

/** The own tab's page against a scripted DGC: your tabs, a picture at whatever size the tab asked, a new picture now and then. */
async function openOwn(theme = "dark", { width = 900, height = 600, api = 107, real = "", ownSeq = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme });
  const page = await context.newPage();
  await page.setContent(`<!doctype html><html><head><style>${pageCss}</style><style>body{background:${theme === "dark" ? "#1e1e1e" : "#ffffff"};color:${theme === "dark" ? "#ccc" : "#222"}}</style><style>:root{${THEMES[theme === "dark" ? "dark-modern" : "light-modern"]}}</style></head><body class="${theme === "dark" ? "vscode-dark" : "vscode-light"}"><main id="app"></main></body></html>`);
  await page.evaluate(([api, real, ownSeq]) => {
    window.__sent = []; window.__posted = [];
    const B = window.__b = { seq: 0, size: [640, 400], current: "T1", tabs: [{ id: "T1", title: "Sign in to your account", url: "https://accounts.example.com/signin" }, { id: "T2", title: "Inbox (3)", url: "https://mail.example.net/", icon: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" }], real };
    const picture = () => {
      if (B.real) return B.real;
      const [w, h] = B.size, c = document.createElement("canvas"); c.width = w; c.height = h; const g = c.getContext("2d");
      g.fillStyle = "#f6f8fb"; g.fillRect(0, 0, w, h); g.fillStyle = "#1a5fd0"; g.font = "28px sans-serif"; g.fillText("Sign in", 40, 60);
      g.strokeStyle = "#8899aa"; g.strokeRect(40, 90, 300, 40); g.fillStyle = "#222"; g.font = "16px sans-serif"; g.fillText("Email or phone", 50, 116);
      g.fillStyle = "#1a5fd0"; g.fillRect(40, 150, 90, 34); g.fillStyle = "#fff"; g.fillText("Next", 66, 172); g.fillStyle = "#99a"; g.fillText(`frame ${B.seq}`, 40, h - 20);
      return c.toDataURL("image/jpeg", 0.8);
    };
    const state = () => ({ own: true, current: B.current, url: B.tabs.find((t) => t.id === B.current)?.url || "", title: B.tabs.find((t) => t.id === B.current)?.title || "", tabs: B.tabs.map((t) => ({ ...t, current: t.id === B.current })) });
    const reply = (m, result) => setTimeout(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "pipsReply", id: m.id, ok: true, result } })), 5);
    window.acquireVsCodeApi = () => ({ getState: () => null, setState() {}, postMessage(m) {
      window.__posted.push(JSON.parse(JSON.stringify(m)));
      if (m.type === "pipsReady") setTimeout(() => {
        window.dispatchEvent(new MessageEvent("message", { data: { type: "yourBrowserInit", own: true } }));
        window.dispatchEvent(new MessageEvent("message", { data: { type: "pipsConnection", generation: 1, apiVersion: api, connected: true, supported: true, enabled: true } }));
      }, 5);
      if (m.type !== "pipsRequest") return;
      const r = m.request; window.__sent.push(JSON.parse(JSON.stringify(r)));
      // ownSeq: DGC numbers its frames its own way, close behind the page's own count of requests (as a real stream
      // does, about one frame a request), and an input takes a moment: never may a frame's number become a request id.
      if (ownSeq && r.op === "frame") return setTimeout(() => reply(m, { ok: true, ...state(), seq: Number(String(m.id).split("-").pop()), image: picture(), width: B.size[0], height: B.size[1] }), 10);
      if (ownSeq && r.op === "input") return setTimeout(() => reply(m, { ok: true, ...state() }), 120);
      if (r.op === "frame") {
        // A new picture when asked with an older one (as DGC waits for one), else the same state without a picture.
        if (r.seq < B.seq + 1) { B.seq += 1; return setTimeout(() => reply(m, { ok: true, ...state(), seq: B.seq, image: picture(), width: B.size[0], height: B.size[1] }), 30); }
        return setTimeout(() => reply(m, { ok: true, ...state(), seq: B.seq, width: B.size[0], height: B.size[1] }), 200);
      }
      if (r.op === "size") B.size = [r.width, r.height];
      if (r.op === "new_tab") { B.tabs.push({ id: "T" + (B.tabs.length + 9), title: "New Tab", url: "chrome://newtab/" }); B.current = B.tabs.at(-1).id; }
      if (r.op === "tab") B.current = r.tab;
      if (r.op === "close_tab") { B.tabs = B.tabs.filter((t) => t.id !== r.tab); if (B.current === r.tab) B.current = B.tabs.at(-1)?.id; }
      reply(m, { ok: true, ...state() });
    } });
  }, [api, real, ownSeq]);
  await page.addScriptTag({ content: pageJs });
  const sent = (op) => page.evaluate((o) => window.__sent.filter((r) => !o || r.op === o), op);
  const events = async () => (await sent("input")).flatMap((r) => r.events);
  const shown = () => page.waitForFunction(() => { const f = document.querySelector(".yb-frame"); return f && !f.hidden && f.naturalWidth > 0; }, null, { timeout: 10000 });
  return { page, close: () => context.close(), sent, events, shown };
}

test("your own tab: it streams frame after frame, at the editor tab's size, with your tabs and the quiet line", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openOwn();
  try {
    await x.shown();
    const [size] = await x.sent("size");
    const stage = await x.page.evaluate(() => { const s = document.querySelector(".yb-stage"); return [s.clientWidth, s.clientHeight]; });
    assert.deepEqual([size.width, size.height], [stage[0] - 18, stage[1] - 18], "the page is laid out at the tab's own size");
    await x.page.waitForTimeout(700);
    const frames = await x.sent("frame");
    assert.ok(frames.length >= 6, `one frame asked as the last came (${frames.length} in 0.7 s)`);
    assert.ok(frames.every((r, i) => r.own === true && !("pip_id" in r) && (i === 0 || r.seq >= frames[i - 1].seq)), "your own tab, asked with the last frame it has");
    const seen = await x.page.evaluate(() => ({ title: document.title, url: document.querySelector(".yb-url").value, line: document.querySelector(".yb-line").textContent, lineShown: document.querySelector(".yb-line").checkVisibility(),
      tabs: [...document.querySelectorAll(".yb-own .yb-tab")].map((b) => [b.textContent, b.getAttribute("aria-selected")]), closes: document.querySelectorAll(".yb-own .yb-x").length,
      newTab: !!document.querySelector(".yb-new")?.checkVisibility(), window: document.querySelector(".yb-window").checkVisibility(),
      frame: (() => { const r = document.querySelector(".yb-frame").getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })() }));
    assert.equal(seen.title, "Your Browser");
    assert.equal(seen.url, "https://accounts.example.com/signin");
    assert.deepEqual([seen.line, seen.lineShown], [LINE, true]);
    assert.deepEqual(seen.tabs, [["Sign in to your account", "true"], ["Inbox (3)", "false"]]);
    assert.equal(seen.closes, 2);
    assert.equal(seen.newTab, true);
    // Like Chrome's: each wears its site's icon, a globe until DGC has one (his 20 Nov ask).
    const marks = await x.page.evaluate(() => [...document.querySelectorAll(".yb-own .yb-tab")].map((b) => b.querySelector("img.yb-fav") ? "icon" : b.querySelector(".yb-fav-none") ? "globe" : "none"));
    assert.deepEqual(marks, ["globe", "icon"]);
    if (process.env.DGC_SHOTS_DIR) await x.page.locator(".yb-bar").screenshot({ path: `${process.env.DGC_SHOTS_DIR}/yb-tabs.png` });
    assert.equal(seen.window, false, "no window to show it in: this is Your Browser");
    assert.ok(Math.abs(seen.frame[0] - (size.width + 2)) <= 1 && Math.abs(seen.frame[1] - (size.height + 2)) <= 1, `drawn one to one (${seen.frame} for ${size.width}x${size.height})`);
  } finally { await x.close(); }
});

test("your own tab: a click where it was made, typing, keys and a paste reach it in order", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openOwn();
  try {
    await x.shown();
    const box = await x.page.evaluate(() => { const r = document.querySelector(".yb-frame").getBoundingClientRect(); return { left: r.left + 1, top: r.top + 1, width: r.width - 2, height: r.height - 2 }; });
    const page = await x.page.evaluate(() => window.__b.size);
    await x.page.mouse.click(box.left + box.width * (190 / page[0]), box.top + box.height * (110 / page[1]));
    await x.page.keyboard.type("me@example.com");
    await x.page.keyboard.press("Tab");
    await x.page.keyboard.type("s3cr3t!");
    // A paste of the editor's clipboard: the page's own paste event with its text.
    await x.page.evaluate(() => { const data = new DataTransfer(); data.setData("text/plain", " pässwörd"); document.querySelector(".yb-keys").dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })); });
    await x.page.keyboard.press("Enter");
    await x.page.waitForFunction(() => window.__sent.filter((r) => r.op === "input").flatMap((r) => r.events).some((e) => e.key === "Enter"), null, { timeout: 5000 });
    const events = await x.events();
    const [down, up] = events.filter((e) => e.t === "down" || e.t === "up");
    assert.deepEqual([down.t, up.t, down.button, down.clicks], ["down", "up", "left", 1]);
    assert.ok(Math.abs(down.x - 190) <= 1.5 && Math.abs(down.y - 110) <= 1.5, `in the page's own pixels (${down.x}, ${down.y})`);
    const typed = events.filter((e) => e.t === "key" && e.text).map((e) => e.text).join("");
    assert.equal(typed, "me@example.coms3cr3t!", "every character, passwords included");
    const order = events.filter((e) => e.t !== "move").map((e) => (e.t === "key" ? e.text || `[${e.key}]` : e.t === "text" ? `{${e.text}}` : e.t)).join("");
    assert.equal(order, "downupme@example.com[Tab]s3cr3t!{ pässwörd}[Enter]", "in the order they were made");
    assert.ok((await x.sent("input")).every((r) => r.own === true && r.events.length <= 20));
  } finally { await x.close(); }
});

test("your own tab: Copy asks for the page's selection first, then the key goes (a Cut keeps its text)", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openOwn();
  try {
    await x.shown();
    await x.page.locator(".yb-frame").click();
    await x.page.keyboard.press("Control+c");
    await x.page.waitForFunction(() => window.__sent.filter((r) => r.op === "input").flatMap((r) => r.events).some((e) => e.key === "c"), null, { timeout: 5000 });
    const order = await x.page.evaluate(() => window.__sent.filter((r) => r.op === "selection" || (r.op === "input" && r.events.some((e) => e.key === "c"))).map((r) => r.op));
    assert.deepEqual(order.slice(0, 2), ["selection", "input"], "its text is read before the page gets the key");
  } finally { await x.close(); }
});

test("your own tab: frames numbered by DGC never take an input's place: every key goes, at once", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openOwn("dark", { ownSeq: true });
  try {
    await x.shown();
    const box = await x.page.evaluate(() => { const r = document.querySelector(".yb-frame").getBoundingClientRect(); return [r.left + 50, r.top + 50]; });
    await x.page.mouse.click(...box);
    for (const c of "abcdefghijklmnopqrst") { await x.page.keyboard.type(c); await x.page.waitForTimeout(25); }
    await x.page.waitForFunction(() => window.__sent.filter((r) => r.op === "input").flatMap((r) => r.events).filter((e) => e.t === "key").length === 20, null, { timeout: 3000 });
    assert.equal((await x.events()).filter((e) => e.t === "key").map((e) => e.text).join(""), "abcdefghijklmnopqrst");
    assert.doesNotMatch(await x.page.evaluate(() => document.querySelector(".yb-note").textContent), /didn’t answer/);
  } finally { await x.close(); }
});

test("your own tab: the address bar, Back, Forward, Reload, New tab, a tab of yours and Close", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openOwn("light");
  try {
    await x.shown();
    await x.page.fill(".yb-url", "weather in pune");
    await x.page.keyboard.press("Enter");
    await x.page.waitForFunction(() => window.__sent.some((r) => r.op === "go"));
    assert.equal((await x.sent("go"))[0].url, "weather in pune", "DGC makes it an address or a Google search");
    for (const [cls, op] of [[".yb-back", "back"], [".yb-forward", "forward"], [".yb-reload", "reload"]]) {
      await x.page.click(cls);
      await x.page.waitForFunction((o) => window.__sent.some((r) => r.op === o), op);
    }
    await x.page.click(".yb-new");
    await x.page.waitForFunction(() => document.querySelectorAll(".yb-own").length === 3);
    await x.page.click('.yb-own .yb-tab[data-tab="T2"]');
    await x.page.waitForFunction(() => window.__sent.some((r) => r.op === "tab" && r.tab === "T2"));
    await x.page.click('.yb-own .yb-x[data-close="T1"]');
    await x.page.waitForFunction(() => document.querySelectorAll(".yb-own").length === 2);
    assert.deepEqual((await x.sent("close_tab")).map((r) => r.tab), ["T1"]);
    assert.ok((await x.sent()).every((r) => r.own === true && !("pip_id" in r)));
  } finally { await x.close(); }
});

test("your own tab: an older DGC asks for nothing", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openOwn("dark", { api: 106 });
  try {
    await x.page.waitForFunction(() => /Update DGC/.test(document.querySelector(".yb-note").textContent), null, { timeout: 10000 });
    assert.equal((await x.sent()).length, 0);
  } finally { await x.close(); }
});

const radius = (n) => getComputedStyle(n).borderTopLeftRadius;
for (const theme of ["dark", "light"]) {
  for (const width of [300, 440, 700]) {
    test(`your own tab at ${width}px (${theme}): one design language, its line whole, nothing past its edge`, async (t) => {
      if (skipOrFail(t)) return;
      const x = await openOwn(theme, { width, height: 560, real: process.env.DGC_YB_OWN_FRAME ? readFileSync(process.env.DGC_YB_OWN_FRAME, "utf8").trim() : "" });
      try {
        await x.shown();
        await x.page.waitForTimeout(200);
        const look = await x.page.evaluate((r) => { const radius = new Function("n", `return (${r})(n)`); return { overflow: document.documentElement.scrollWidth > innerWidth,
          line: (() => { const l = document.querySelector(".yb-line"), b = l.getBoundingClientRect(); return { right: b.right, cut: l.scrollWidth > l.clientWidth + 1 }; })(),
          parts: [...document.querySelectorAll(".yb-btn:not([hidden]), .yb-url, .yb-own, .yb-x, .yb-frame")].filter((n) => n.checkVisibility()).map((n) => { const b = n.getBoundingClientRect(); return { what: n.className, right: b.right, radius: radius(n), height: b.height }; }) }; }, radius.toString());
        assert.equal(look.overflow, false);
        assert.ok(look.line.right <= width + 0.5 && !look.line.cut, "the line is whole");
        for (const part of look.parts) {
          assert.ok(part.right <= width + 0.5, `${part.what} stays on the page`);
          assert.equal(part.radius, "6px", `${part.what}: 6 px corners, never a pill`);
          if (/yb-btn|yb-url|yb-own/.test(part.what)) assert.ok(part.height >= 24 && part.height <= 28, `${part.what}: a button's height (${part.height})`);
        }
        if (PICTURES) await x.page.screenshot({ path: `${PICTURES}/own-tab-${width}-${theme}.png` });
      } finally { await x.close(); }
    });
  }
}

// ---- Install Google Chrome, on the side bar --------------------------------------------------------------------------------
const install = (more = {}) => ({ how: "password", state: "", error: "", line: TERMINAL, ...more });
const needing = (more = {}, recent = {}) => ({ ...homeState(), browser: { recent: { links: [], open: false, available: false, reason: NEEDS, install: install(more), ...recent } } });
const waitFor = (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: 15000 });
const requests = (page, type) => page.evaluate((t) => window.__requests.filter((r) => r.type === t), type);
const CARD = '#home-hub .hc-grid .hc-card[data-card="browser"]';
async function homeWithCard(width, theme, state) {
  const x = await openHome(browser, { width, height: 900, theme, api: 107, state, grid: true, tab: "home" });
  await x.send({ type: "homeCards", order: ["browser", "needs", "quick"], settings: {} });
  await waitFor(x.page, (c) => !!document.querySelector(`${c} .hc-browse-why`), CARD);
  return x;
}
const cardNow = (page) => page.evaluate((c) => {
  const card = document.querySelector(c), r = card.getBoundingClientRect();
  return { form: card.dataset.form, words: [...card.querySelectorAll(".hc-browse-why")].map((n) => n.textContent), field: !!card.querySelector(".hc-url"), line: card.querySelector(".hc-cmd")?.textContent || "",
    buttons: [...card.querySelectorAll(".hc-install-row .hc-btn")].map((b) => b.textContent.trim()),
    parts: [...card.querySelectorAll(".hc-install-row .hc-btn, .hc-cmd, .hc-browse-why")].filter((n) => n.checkVisibility()).map((n) => { const b = n.getBoundingClientRect(); return { what: n.className, left: b.left, right: b.right, bottom: b.bottom, radius: getComputedStyle(n).borderTopLeftRadius, height: b.height }; }),
    left: r.left, right: r.right, bottom: r.bottom, overflow: document.documentElement.scrollWidth > innerWidth };
}, CARD);

test("Install Google Chrome: the card's one button, the small dialog first, then it installs and becomes itself", async (t) => {
  if (skipOrFail(t)) return;
  const x = await homeWithCard(440, "dark-modern", needing());
  try {
    let c = await cardNow(x.page);
    assert.deepEqual(c.words, [NEEDS]);
    assert.doesNotMatch(c.words.join(" "), /sudo|apparmor|terminal/i, "no command in its words");
    assert.equal(c.field, false, "nothing to search with yet");
    assert.deepEqual(c.buttons, ["Install Google Chrome"]);
    await x.page.click(`${CARD} .hc-install`);
    await waitFor(x.page, () => !!document.querySelector("dialog.yb-install-dialog[open]"));
    const dialog = await x.page.evaluate(() => { const d = document.querySelector("dialog.yb-install-dialog"); return { title: d.querySelector("h2").textContent, words: d.querySelector(".new-session-intro").textContent,
      buttons: [...d.querySelectorAll("button")].map((b) => b.textContent.trim()), focus: document.activeElement?.textContent.trim(), radius: [...d.querySelectorAll("button")].map((b) => getComputedStyle(b).borderTopLeftRadius) }; });
    assert.deepEqual([dialog.title, dialog.words], ["Install Google Chrome", DIALOG_WORDS]);
    assert.deepEqual(dialog.buttons, ["Cancel", "Install"]);
    assert.equal(dialog.focus, "Install");
    assert.deepEqual(dialog.radius, ["6px", "6px"]);
    if (PICTURES) await x.page.screenshot({ path: `${PICTURES}/install-dialog-440-dark.png` });
    // Cancel: nothing is asked.
    await x.page.click("dialog.yb-install-dialog .yb-install-cancel");
    assert.equal(await x.page.evaluate(() => !!document.querySelector("dialog.yb-install-dialog")), false);
    assert.equal((await requests(x.page, "install_google_chrome")).length, 0);
    // Install: DGC is asked, the card says it is installing and asks again until it ends.
    await x.page.click(`${CARD} .hc-install`);
    await waitFor(x.page, () => !!document.querySelector("dialog.yb-install-dialog[open]"));
    const asked = await x.page.evaluate(() => window.__requests.filter((r) => r.type === "get_your_browser_recent").length);
    await x.page.click("dialog.yb-install-dialog .yb-install-go");
    await waitFor(x.page, () => window.__requests.some((r) => r.type === "install_google_chrome"));
    assert.deepEqual(Object.keys((await requests(x.page, "install_google_chrome"))[0]).sort(), ["type"]);
    await x.page.evaluate(() => { window.__state.browser.recent.install = { ...window.__state.browser.recent.install, state: "running" }; });
    await waitFor(x.page, (c) => /Installing Google Chrome/.test(document.querySelector(`${c} .hc-browse-why`)?.textContent || ""), CARD);
    if (PICTURES) await x.page.screenshot({ path: `${PICTURES}/card-installing-440-dark.png` });
    await waitFor(x.page, (n) => window.__requests.filter((r) => r.type === "get_your_browser_recent").length > n, asked);
    // It ends: Google Chrome is there, and the card is the field and the links by itself.
    await x.page.evaluate(() => { window.__state.browser.recent = { links: [{ url: "https://news.example.org/", title: "News", host: "news.example.org" }], open: false, available: true, reason: "", install: null }; });
    await waitFor(x.page, (c) => !!document.querySelector(`${c} .hc-url`) && !!document.querySelector(`${c} .hc-link`), CARD);
    c = await cardNow(x.page);
    assert.deepEqual([c.field, c.buttons], [true, []]);
  } finally { await x.close(); }
});

test("Install Google Chrome: no password prompt here, or one closed, shows the terminal line with Copy", async (t) => {
  if (skipOrFail(t)) return;
  const x = await homeWithCard(440, "light-modern", needing({ how: "terminal" }));
  try {
    let c = await cardNow(x.page);
    assert.equal(c.line, TERMINAL);
    assert.deepEqual(c.buttons, ["Copy"]);
    assert.match(c.words[0], /Run this line in a terminal on the computer DGC runs on/);
    await x.page.click(`${CARD} .hc-copy-line`);
    assert.deepEqual((await x.posted("copy")).map((m) => m.text), [TERMINAL]);
    if (PICTURES) await x.page.screenshot({ path: `${PICTURES}/card-terminal-440-light.png` });
    // A prompt that was closed: why, the line and Copy, and the button again.
    await x.page.evaluate(() => { window.__state.browser.recent.install = { ...window.__state.browser.recent.install, how: "password", state: "failed", error: "Google Chrome wasn't installed: the password prompt was closed." }; });
    await x.page.waitForTimeout(3100);                 // (the page asks again on the window's focus, at most every 3 s)
    await x.page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await waitFor(x.page, (cc) => /prompt was closed/.test(document.querySelector(`${cc} .hc-browse-why`)?.textContent || ""), CARD);
    c = await cardNow(x.page);
    assert.match(c.words[0], /the password prompt was closed\. You can run this line in a terminal instead:/);
    assert.deepEqual(c.buttons, ["Install Google Chrome", "Copy"]);
    assert.equal(c.line, TERMINAL);
  } finally { await x.close(); }
});

test("Install Google Chrome from the dock: its tile says so, and a click opens the same dialog", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { width: 440, height: 700, api: 107, state: needing() });
  try {
    await waitFor(x.page, () => /Needs Google Chrome/.test(document.querySelector('#dgc-dock .dgc-dock-item[data-key="browser"]')?.getAttribute("aria-label") || ""));
    const tile = (await dockNow(x.page)).items.find((i) => i.key === "browser");
    await x.page.mouse.click(tile.left + tile.width / 2, tile.top + tile.height / 2, { button: "right" });
    await waitFor(x.page, () => document.querySelectorAll(".dgc-pop .dgc-menu-row").length > 0);
    assert.deepEqual((await dockNow(x.page)).menu, ["Install Google Chrome…"]);
    await x.page.keyboard.press("Escape");
    await x.page.mouse.click(tile.left + tile.width / 2, tile.top + tile.height / 2);
    await waitFor(x.page, () => !!document.querySelector("dialog.yb-install-dialog[open]"));
    assert.equal((await requests(x.page, "open_your_browser")).length, 0, "Google Chrome first");
  } finally { await x.close(); }
});

test("with no screen where DGC runs, Open Your Browser opens your own tab in the editor", async (t) => {
  if (skipOrFail(t)) return;
  const state = { ...homeState(), browser: { recent: { links: [], open: false, available: true, reason: "", install: null, view: "tab" } } };
  const x = await openDock(browser, { width: 440, height: 700, api: 107, state });
  try {
    await waitFor(x.page, () => /in a tab here/.test(document.querySelector('#dgc-dock .dgc-dock-item[data-key="browser"]')?.getAttribute("aria-label") || ""));
    const tile = (await dockNow(x.page)).items.find((i) => i.key === "browser");
    await x.page.mouse.click(tile.left + tile.width / 2, tile.top + tile.height / 2);
    await waitFor(x.page, () => window.__posted.some((m) => m.type === "pipsOpenYourBrowser"));
    const [opened] = await x.posted("pipsOpenYourBrowser");
    assert.equal(opened.own, true);
    assert.ok(opened.documentId);
  } finally { await x.close(); }
});

for (const theme of ["dark-modern", "light-modern"]) {
  for (const width of [300, 440, 700]) {
    for (const [name, more] of [["install", {}], ["installing", { state: "running" }], ["terminal", { how: "terminal" }], ["failed", { state: "failed", error: "Google Chrome wasn't installed: the password prompt was closed." }]]) {
      test(`the card's ${name} state at ${width}px (${theme}): its words whole, nothing past the card's edge`, async (t) => {
        if (skipOrFail(t)) return;
        const x = await homeWithCard(width, theme, needing(more));
        try {
          const c = await cardNow(x.page);
          assert.equal(c.overflow, false);
          if (name === "failed") {
            // A Small card says it didn't install (never "Not installed", which reads as never tried), and why on hover.
            const why = await x.page.evaluate((s) => { const p = document.querySelector(`${s} .hc-browse-why`); return { text: p.textContent, title: p.getAttribute("title") || "" }; }, CARD);
            assert.notEqual(why.text, "Not installed");
            if (why.text === "Didn't install") assert.match(why.title, /password prompt was closed/);
            else assert.match(why.text, /password prompt was closed/);
          }
          for (const part of c.parts) {
            assert.ok(part.left >= c.left - 0.5 && part.right <= c.right + 0.5, `${part.what} stays inside the card`);
            assert.ok(part.bottom <= c.bottom + 0.5, `${part.what} isn't cut at the card's foot`);
            if (/hc-btn|hc-cmd/.test(part.what)) assert.equal(part.radius, "6px", `${part.what}: 6 px corners`);
            if (/hc-btn/.test(part.what)) assert.ok(part.height >= 24 && part.height <= 28, `${part.what}: a button's height (${part.height})`);
          }
          if (PICTURES) await x.page.locator(CARD).screenshot({ path: `${PICTURES}/card-${name}-${width}-${theme}.png` });
          if (PICTURES && name === "install") {
            await x.page.click(`${CARD} .hc-install`);
            await waitFor(x.page, () => !!document.querySelector("dialog.yb-install-dialog[open]"));
            await x.page.waitForTimeout(250);
            await x.page.screenshot({ path: `${PICTURES}/dialog-${width}-${theme}.png` });
          }
        } finally { await x.close(); }
      });
    }
  }
}

test("the dialog where no password prompt can open: the line and Copy", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { width: 440, height: 700, api: 107, state: needing({ how: "terminal" }), tab: "home" });
  try {
    await waitFor(x.page, () => /Needs Google Chrome/.test(document.querySelector('#dgc-dock .dgc-dock-item[data-key="browser"]')?.getAttribute("aria-label") || ""));
    const tile = (await dockNow(x.page)).items.find((i) => i.key === "browser");
    await x.page.mouse.click(tile.left + tile.width / 2, tile.top + tile.height / 2);
    await waitFor(x.page, () => !!document.querySelector("dialog.yb-install-dialog[open]"));
    const d = await x.page.evaluate(() => { const n = document.querySelector("dialog.yb-install-dialog"), l = n.querySelector(".yb-install-line"), r = n.getBoundingClientRect(), b = l.getBoundingClientRect();
      return { line: l.textContent, buttons: [...n.querySelectorAll("button")].map((x) => x.textContent.trim()), inside: b.left >= r.left && b.right <= r.right + 0.5 }; });
    assert.equal(d.line, TERMINAL);
    assert.deepEqual(d.buttons, ["Close", "Copy"]);
    assert.ok(d.inside);
    await x.page.click("dialog.yb-install-dialog .yb-install-copy");
    assert.deepEqual((await x.posted("copy")).map((m) => m.text), [TERMINAL]);
    if (PICTURES) await x.page.screenshot({ path: `${PICTURES}/dialog-terminal-440-dark.png` });
  } finally { await x.close(); }
});
