// The prompt cache's clock in the real Work panel, in Chromium (0.48.3): where DGC can't time the cache it stays in
// the footer, dimmed, with no minutes, in the same box a cold clock takes, so the footer doesn't move as you change
// models; it can still be seen in the dark and light themes, and comes up to full strength when pointed at; warm and
// cold are drawn as in 0.48.0; and a click opens the clock's own popup. jsdom has no layout or
// cascade, so cache-clock.test.mjs can't say any of this.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { THEMES, panelHtml } from "./support/options-scene.mjs";
import { IDLE_LINE, openIdle } from "./support/idle-cache-scene.mjs";

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

const NOW = Date.UTC(2026, 9, 27, 9, 0, 0);
// Each model a user uses, as the panel learns it, and what its backend says of the cache.
const ROUTES = {
  "ollama-cloud": { model: "deepseek-v4.1-flash:cloud", base_url: "http://127.0.0.1:11434/v1", clock: { state: "unknown" } },
  openai: { model: "gpt-5.2", base_url: "https://api.openai.com/v1", clock: { state: "unknown" } },
  deepseek: { model: "deepseek-chat", base_url: "https://api.deepseek.com/v1", clock: { state: "unknown" } },
  "local-ollama": { model: "qwen3:32b", base_url: "http://127.0.0.1:11434/v1", clock: { state: "unknown" } },
  "anthropic-cold": { model: "claude-sonnet-4-5", base_url: "https://api.anthropic.com/v1",
                      clock: { state: "cold", reason: "expired", source: "anthropic", anchor_ms: NOW - 12 * 60000, ttl_s: 300, tokens: 41000 } },
  "anthropic-warm": { model: "claude-sonnet-4-5", base_url: "https://api.anthropic.com/v1",
                      clock: { state: "warm", source: "anthropic", anchor_ms: NOW - 30000, expires_ms: NOW + 270000, ttl_s: 300, tokens: 41000 } },
};

async function openPanel({ width = 520, theme = "dark-modern" } = {}) {
  const { html, mainJs, markdownJs } = panelHtml();
  const page = await browser.newPage({ viewport: { width, height: 640 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.setContent(html, { waitUntil: "load" });
  await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; --vscode-editor-font-family: ui-monospace, monospace; ${THEMES[theme]} }` });
  await page.evaluate(([t, mjs, mdjs, now]) => {
    document.body.classList.add(t.startsWith("light") ? "vscode-light" : t === "hc" ? "vscode-high-contrast" : "vscode-dark");
    Date.now = () => now;
    window.acquireVsCodeApi = () => ({ postMessage() {}, getState: () => undefined, setState() {} });
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(mjs);
  }, [theme, mainJs, markdownJs, NOW]);
  const send = (data) => page.evaluate((d) => window.dispatchEvent(new MessageEvent("message", { data: d })), data);
  const event = (ev) => send({ type: "event", event: ev });
  const go = async (name) => {
    const r = ROUTES[name];
    await event({ type: "config", model: r.model, mode: "default", think: "off", base_url: r.base_url, api_mode: "auto", prompt_cache: true, project_root: "/p", goal: {} });
    await send({ type: "state", state: { model: r.model, mode: "default", think: "off", baseUrl: r.base_url, goal: { text: "", status: "none", elapsed_seconds: 0 } } });
    await event({ type: "cache_clock", ...r.clock });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  };
  await event({ type: "ready", capabilities: {} });
  return { page, send, event, go, errors };
}

// The strongest contrast any pixel of the clock's icon makes with the box behind it, as drawn (anti-aliasing, the
// theme's half-transparent --faint, the dimming): what an eye can find, not what a style says.
const luminance = ([r, g, b]) => { const [R, G, B] = [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * R + 0.7152 * G + 0.0722 * B; };
const ratio = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
async function iconContrast(page) {
  await page.evaluate(() => document.getAnimations().filter((a) => a instanceof CSSTransition).forEach((a) => a.finish()));   // mid-transition is not the colour
  const box = await page.locator("#cache-clock svg").boundingBox();
  const png = await page.screenshot({ clip: { x: box.x, y: box.y, width: box.width, height: box.height } });
  // The box's ground is a mix now (--box), which computes to color(srgb r g b) in 0..1 rather than rgb().
  const ground = await page.evaluate(() => { const c = getComputedStyle(document.getElementById("cbox")).backgroundColor, m = c.match(/-?[\d.]+(e-?\d+)?/g).slice(0, 3).map(Number);
    return c.startsWith("color(srgb") ? m.map((v) => Math.round(v * 255)) : m; });
  const pixels = await page.evaluate(async (b64) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    return [...ctx.getImageData(0, 0, bitmap.width, bitmap.height).data];
  }, png.toString("base64"));
  let best = 1;
  for (let i = 0; i < pixels.length; i += 4) best = Math.max(best, ratio(pixels.slice(i, i + 3), ground));
  return best;
}

const finishTransitions = (page) => page.evaluate(() => document.getAnimations().filter((a) => a instanceof CSSTransition).forEach((a) => a.finish()));

for (const theme of ["dark-modern", "light-modern", "hc"]) {
  test(`${theme}: the dimmed clock can be found, is dimmer than a warm one, comes up when pointed at; warm is 0.48.0's and cold is a mild notice`, async (t) => {
    if (skipOrFail(t)) return;
    const s = await openPanel({ theme });
    try {
      const look = async () => { await finishTransitions(s.page); return s.page.evaluate(() => {
        const n = document.getElementById("cache-clock"), cs = getComputedStyle(n);
        return { opacity: Number(cs.opacity), color: cs.color, shown: n.checkVisibility(), left: document.getElementById("cache-clock-left").textContent };
      }); };
      await s.go("anthropic-warm");
      const warm = { ...(await look()), contrast: await iconContrast(s.page) };
      assert.deepEqual([warm.opacity, warm.left], [1, "5m"], "warm: full strength, the minutes beside it");
      const faint = await s.page.evaluate(() => { const probe = document.createElement("span"); probe.style.color = "var(--faint)"; document.body.append(probe);
        const c = getComputedStyle(probe).color; probe.remove(); return c; });
      assert.equal(warm.color, faint, "in --faint, as in 0.48.0");
      await s.go("anthropic-cold");
      const cold = await look();
      assert.equal(cold.opacity, 1, "cold: full strength");
      const mild = await s.page.evaluate(() => { const probe = document.createElement("span"); probe.style.color = "var(--need-text)"; document.body.append(probe);
        const c = getComputedStyle(probe).color; probe.remove(); return c; });
      assert.equal(cold.color, mild, "the product's mild notice: expired is normal, never the error colour");
      for (const name of ["ollama-cloud", "openai", "deepseek", "local-ollama"]) {
        await s.go(name);
        const unknown = await look();
        assert.equal(unknown.shown, true, `${name}: in the footer`);
        assert.equal(unknown.left, "", `${name}: no minutes`);
        assert.ok(unknown.opacity < 1, `${name}: dimmed (opacity ${unknown.opacity})`);
        const contrast = await iconContrast(s.page);
        assert.ok(contrast >= 1.4, `${name}: still there to find, ${contrast.toFixed(2)}:1 against the box`);
        assert.ok(contrast < warm.contrast - 0.3, `${name}: dimmer than a warm clock (${contrast.toFixed(2)}:1 against ${warm.contrast.toFixed(2)}:1)`);
      }
      const box = await s.page.locator("#cache-clock").boundingBox();
      await s.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      assert.equal((await look()).opacity, 1, "pointed at, it comes up to full strength");
      assert.ok(await iconContrast(s.page) >= warm.contrast, "at least as clear as a warm clock");
      assert.deepEqual(s.errors, []);
    } finally { await s.page.close(); }
  });
}

// "The footer doesn't move between models": the clock used to vanish for a provider DGC can't time, and everything
// after it moved left by its width as you switched to that model and back.
test("changing models never moves the footer: an untimed clock takes a cold clock's box, at every width", async (t) => {
  if (skipOrFail(t)) return;
  for (const width of [320, 420, 520, 900]) {
    const s = await openPanel({ width });
    try {
      const where = () => s.page.evaluate(() => {
        const at = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 2) / 2).join(","); };
        const footer = document.getElementById("cfooter");
        return { meter: at("btn-ctx"), clock: at("cache-clock"), settings: at("btn-settings"), mode: at("btn-mode"),
                 footer: Math.round(footer.getBoundingClientRect().height), fits: footer.scrollWidth <= footer.clientWidth,
                 shown: document.getElementById("cache-clock").checkVisibility() };
      });
      const first = await where();
      assert.equal(first.shown, true, `${width}px: there before any model is known`);
      for (const name of ["ollama-cloud", "anthropic-cold", "openai", "local-ollama", "deepseek", "anthropic-cold", "ollama-cloud"]) {
        await s.go(name);
        const now = await where();
        assert.deepEqual(now, first, `${width}px, ${name}: the meter, the clock, Settings and the mode where they were, the footer as tall`);
        assert.equal(now.fits, true, `${width}px: the footer doesn't overflow`);
      }
      assert.deepEqual(s.errors, []);
    } finally { await s.page.close(); }
  }
});

test("a click on the clock opens its own popup inside the panel, at every width, and never the context details", async (t) => {
  if (skipOrFail(t)) return;
  for (const width of [300, 420, 900]) {
    const s = await openPanel({ width });
    try {
      await s.go("ollama-cloud");
      await s.event({ type: "context", used: 9000, size: 65536, compact_threshold: .85, input_tokens: 1234567, output_tokens: 98765,
                      cached_input_tokens: 1100000, reasoning_tokens: 0, requests: 1234 });
      await s.page.locator("#cache-clock").click();
      const menu = s.page.locator("#cachemenu");
      assert.equal(await menu.isVisible(), true, "its popup opens");
      assert.equal(await s.page.locator("#ctxmenu").isVisible(), false, "the context details stay shut");
      assert.equal(await s.page.locator("#cache-usage").textContent(), "1,100,000 cached · 1,234,567 in");
      const fit = await s.page.evaluate(() => { const m = document.getElementById("cachemenu").getBoundingClientRect(), u = document.getElementById("cache-usage");
        return { inside: m.left >= 0 && m.right <= innerWidth && m.top >= 0, usage: u.scrollWidth <= u.clientWidth,
                 split: [...u.querySelectorAll(".context-usage-part")].filter((p) => p.getClientRects().length > 1).map((p) => p.textContent) }; });
      assert.deepEqual(fit, { inside: true, usage: true, split: [] }, `${width}px: inside the panel, numbers not cut off, each figure on one line with its word`);
      if (process.env.CACHE_POPUP_SHOT) await s.page.screenshot({ path: `${process.env.CACHE_POPUP_SHOT}-${width}.png` });
      await s.page.locator("#cache-clock").click();
      assert.equal(await menu.isVisible(), false, "and a second click closes it");
      assert.deepEqual(s.errors, []);
    } finally { await s.page.close(); }
  }
});

test("pointed at, the dimmed clock's label names the provider, in the panel's own hover label, and keeps up as the model changes", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openPanel({ width: 520 });
  try {
    await s.go("ollama-cloud");
    await s.page.hover("#cache-clock");
    await s.page.waitForSelector("#hover-tip:not([hidden])", { timeout: 10000 });
    const tip = () => s.page.evaluate(() => ({ text: document.getElementById("hover-tip").textContent, shown: !document.getElementById("hover-tip").hidden,
      title: document.getElementById("cache-clock").getAttribute("title") }));
    assert.deepEqual(await tip(), { text: "Ollama Cloud may cache your prompt, but it doesn't say for how long, so DGC can't show a timer.", shown: true, title: null },
      "one label, the panel's: the title is lifted while it shows, so the browser's own tooltip never joins it");
    await s.go("ollama-cloud");                  // the panel's state and config arriving again, as they do
    assert.equal((await tip()).title, null, "a repaint under the label doesn't put the title back");
    await s.go("openai");
    assert.deepEqual(await tip(), { text: "OpenAI may cache your prompt, but it doesn't say for how long, so DGC can't show a timer.", shown: true, title: null });
    await s.page.mouse.move(2, 2);
    assert.equal(await s.page.evaluate(() => document.getElementById("cache-clock").getAttribute("title")),
                 "OpenAI may cache your prompt, but it doesn't say for how long, so DGC can't show a timer.", "and the title is back once it goes");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

// ---- 0.52: the idle line at the end of an open chat ---------------------------------------------------------
// jsdom says when it is written (cache-clock.test.mjs); only a browser says where it lands and how it reads.
for (const theme of ["dark-modern", "light-modern"]) for (const width of [700, 300]) {
  test(`an idle chat's line sits under its long last reply, above the prompt box, as a quiet note (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const s = await openIdle(browser, { theme, width });
    try {
      // A quiet note of the transcript's own, to compare with: the reopen note has always been one.
      const f = await s.page.evaluate(() => {
        const log = document.getElementById("log"), lines = [...log.querySelectorAll(".sys.cache-idle")], line = lines[0];
        if (!line) return { lines: 0 };
        const atEnd = log.scrollTop + log.clientHeight >= log.scrollHeight - 2;
        const plain = document.createElement("div"); plain.className = "sys"; plain.textContent = "A quiet note"; log.append(plain);
        const probe = document.createElement("span"); probe.style.color = "var(--faint)"; document.body.append(probe);
        const cs = getComputedStyle(line), ps = getComputedStyle(plain), r = line.getBoundingClientRect(), l = log.getBoundingClientRect();
        const reply = [...log.querySelectorAll(".text")].at(-1).getBoundingClientRect(), box = document.getElementById("cbox").getBoundingClientRect();
        const out = { lines: lines.length, text: line.textContent, last: plain.previousElementSibling === line, color: cs.color, faint: getComputedStyle(probe).color,
          same: [cs.color, cs.fontSize, cs.fontWeight, cs.fontFamily, cs.fontStyle, cs.lineHeight].join("|") === [ps.color, ps.fontSize, ps.fontWeight, ps.fontFamily, ps.fontStyle, ps.lineHeight].join("|"),
          fill: cs.backgroundColor, border: cs.borderTopWidth, size: parseFloat(cs.fontSize), replySize: parseFloat(getComputedStyle(log.querySelector(".text")).fontSize),
          top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height, turnBottom: line.previousElementSibling.getBoundingClientRect().bottom, lineHeight: parseFloat(cs.lineHeight), replyBottom: reply.bottom, replyLeft: reply.left, boxTop: box.top,
          logRight: l.right, logLeft: l.left, wide: log.scrollWidth <= log.clientWidth, pageWide: document.documentElement.scrollWidth <= innerWidth, atEnd };
        plain.remove(); probe.remove();
        return out;
      });
      assert.equal(f.lines, 1, "one line");
      assert.equal(f.text, IDLE_LINE);
      assert.equal(f.last, true, "at the end of the chat");
      assert.ok(f.top >= f.replyBottom - 0.5, `under the last reply (${f.top} after ${f.replyBottom})`);
      assert.ok(f.top >= f.turnBottom - 0.5 && f.top - f.turnBottom <= 24 && f.top - f.replyBottom <= 64,
        `close under it: after the reply's own row of buttons (${(f.top - f.turnBottom).toFixed(1)}px under the turn, ${(f.top - f.replyBottom).toFixed(1)}px under its words)`);
      assert.ok(f.bottom <= f.boxTop + 0.5, `above the prompt box, in view (${f.bottom} over ${f.boxTop})`);
      assert.equal(f.atEnd, true, "a chat that was at its end still is: the line is in view");
      assert.ok(Math.abs(f.left - f.replyLeft) <= 1, "on the reply's left edge");
      assert.ok(f.right <= f.logRight + 0.5 && f.wide && f.pageWide, "inside the chat, nothing scrolls sideways");
      assert.equal(f.same, true, "the look of the transcript's quiet note");
      assert.equal(f.color, f.faint, "muted");
      assert.deepEqual([f.fill, f.border], ["rgba(0, 0, 0, 0)", "0px"], "a line of text: no box");
      assert.ok(f.size < f.replySize, "smaller than the reply it follows");
      const rows = Math.round(f.height / f.lineHeight);
      assert.ok(width === 700 ? rows === 1 : rows >= 2 && rows <= 4, `${width}px: ${rows} row(s)`);
      const purple = (c) => { const m = c.match(/-?[\d.]+/g).map(Number), [r, g, b] = c.startsWith("color(srgb") ? m.map((v) => v * 255) : m, mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        if (mx - mn < 18) return false; const h = mx === b ? 240 + 60 * (r - g) / (mx - mn) : mx === r ? (360 + 60 * (g - b) / (mx - mn)) % 360 : 120 + 60 * (b - r) / (mx - mn); return h > 235 && h < 290; };
      assert.equal(purple(f.color), false, "no purple in it");
      // The footer's clock agrees, and coming back later brings the line's time up to date in place.
      assert.equal(await s.page.evaluate(() => document.getElementById("cache-clock").dataset.cacheWindow), "cold");
      await s.advance(7 * 3600000);
      await s.shown(); await s.settle();
      assert.deepEqual(await s.page.evaluate(() => [...document.querySelectorAll("#log .sys.cache-idle")].map((n) => n.textContent)),
        [IDLE_LINE.replace("1d 17h", "2d 0h")], "still one line, with the time it is now");
      assert.deepEqual(s.errors, []);
    } finally { await s.close(); }
  });
}

test("a chat still warm, or mid-turn, shows no idle line in the real panel", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openIdle(browser, { idle: false });
  try {
    await s.advance(60000); await s.shown(); await s.settle();
    assert.equal(await s.page.locator("#log .sys.cache-idle").count(), 0, "warm: nothing to say");
    await s.event({ type: "turn_start", turn_id: "t2", prompt: "And the changelog?" });
    await s.advance(3600000); await s.shown(); await s.settle();
    assert.equal(await s.page.locator("#log .sys.cache-idle").count(), 0, "a turn is running");
    assert.deepEqual(s.errors, []);
  } finally { await s.close(); }
});
