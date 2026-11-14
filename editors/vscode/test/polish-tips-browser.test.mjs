// A hover label that stays inside the window (the visual polish pass, 0.52, 14 Nov). The Pips view used the browser's
// own `title` tooltip, which the system draws outside the page and the window's edge cuts ("Mark as read, w…" beside
// a Pip's row). Now the Pips view (in the side bar and in its tab), ChatDGC, the Library, Settings and a note's tab
// use DGC's own label (media/shared/tip.js): drawn in the page, whole, inside it, with the control's `title` lifted
// while it shows so the system's tooltip stays away. Also here: a shared document card's quiet line still reads at
// 4.5:1 while the card is pointed at, and a focus ring in a Pip's chat and on its page is not cut by the box it is in.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openChat as openPipChat } from "./support/pip-chat-scene.mjs";
import { openOnePips, GST } from "./support/one-pips-scene.mjs";
import { openChatDgc } from "./support/codex-look-scene.mjs";
import { openSettings } from "./support/settings-scene.mjs";
import { eachSurface } from "./support/marks-centred-scene.mjs";
import { focusAudit } from "./support/polish-audit.mjs";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "";
  if (!reason) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};
before(async () => { if (!chromium) return; try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; } });
after(async () => { await browser?.close(); });

/** The label on screen (in the page or the Pips view's shadow root) and the control it is for. */
const tipNow = (page, selector) => page.evaluate((sel) => {
  const roots = [document]; for (const n of document.querySelectorAll("*")) if (n.shadowRoot) roots.push(n.shadowRoot);
  const tip = roots.map((r) => r.querySelector(".dgc-tip:not([hidden]), .tip[role=tooltip]:not([hidden])")).find(Boolean), control = roots.map((r) => r.querySelector(sel)).find(Boolean);
  if (!tip) return { shown: false, title: control?.getAttribute("title") ?? null };
  const r = tip.getBoundingClientRect(), c = control.getBoundingClientRect();
  return { shown: true, words: tip.textContent, left: r.left, right: r.right, top: r.top, bottom: r.bottom, wide: innerWidth, tall: innerHeight, cut: tip.scrollWidth > tip.clientWidth + 1, title: control.getAttribute("title"), role: tip.getAttribute("role"),
    onControl: Math.min(r.right, c.right) - Math.max(r.left, c.left) > 1 && Math.min(r.bottom, c.bottom) - Math.max(r.top, c.top) > 1 };
}, selector);
const inside = (tip, what) => {
  assert.ok(tip.shown, `${what}: DGC's own label shows`);
  assert.ok(tip.left >= 0 && tip.right <= tip.wide && tip.top >= 0 && tip.bottom <= tip.tall, `${what}: all of it is inside the window (${Math.round(tip.left)} to ${Math.round(tip.right)} of ${tip.wide})`);
  assert.equal(tip.cut, false, `${what}: its words are whole`);
  assert.equal(tip.title, null, `${what}: the control's own title is lifted while it shows, so the system's tooltip stays away`);
  assert.equal(tip.onControl, false, `${what}: it does not lie on its control`);
};

const INBOX = "pip_" + "3".repeat(32);
for (const theme of ["dark", "light"]) for (const width of [300, 700]) {
  test(`a Pip row's “Mark as read” says so in a label that stays inside the window (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const { p, close } = await openPipChat(browser, { width, height: 700, theme, where: width > 400 ? "tab" : "side", many: true, home: true });
    try {
      const read = `[data-pip-read="${INBOX}"]`;
      await p.waitForSelector(read);
      assert.equal(await p.evaluate((s) => (window.__pipsRoot || document).querySelector(s).getAttribute("title"), read), "Mark as read, without opening its chat");
      await p.hover(read); await p.waitForTimeout(1100);
      const tip = await tipNow(p, read);
      inside(tip, "Mark as read"); assert.equal(tip.words, "Mark as read, without opening its chat"); assert.equal(tip.role, "tooltip");
      // The pointer goes: the label goes and the title is back for a screen reader.
      await p.mouse.move(2, 400); await p.waitForTimeout(250);
      const gone = await tipNow(p, read);
      assert.equal(gone.shown, false); assert.equal(gone.title, "Mark as read, without opening its chat");
      // The keyboard reaches a control at the right edge: labelled at once, inside.
      await p.keyboard.press("Tab"); await p.evaluate((s) => (window.__pipsRoot || document).querySelector(s).focus(), read); await p.waitForTimeout(250);
      const byKey = await tipNow(p, read);
      inside({ ...byKey, title: null }, "Mark as read, by the Tab key"); assert.equal(byKey.title, "Mark as read, without opening its chat", "the keyboard's label leaves the title where it is");
      await p.keyboard.press("Escape"); await p.waitForTimeout(150);
      assert.equal((await tipNow(p, read)).shown, false, "Escape puts it away");
    } finally { await close(); }
  });
}

test("the Pips view draws itself again while a label is up: the title stays lifted, and the label stays", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openOnePips(browser, { width: 300, theme: "dark-modern" });
  try {
    const sel = "#pips-settings-open", said = await x.inPips((root, q) => root.querySelector(q).getAttribute("title"), sel);
    assert.ok(said, "Pips settings says what it is with a title");
    await x.page.hover(`#pips-host ${sel}`); await x.page.waitForTimeout(1100);
    const up = await tipNow(x.page, sel); inside(up, "Pips settings"); assert.equal(up.words, said);
    // As a render does: the page's markup says the title again.
    await x.inPips((root, [q, t]) => root.querySelector(q).setAttribute("title", t), [sel, said]);
    await x.page.waitForTimeout(150);
    inside(await tipNow(x.page, sel), "Pips settings, after a render");
  } finally { await x.close(); }
});

test("ChatDGC and Settings use the same label: inside the window at the right edge", async (t) => {
  if (skipOrFail(t)) return;
  const c = await openChatDgc(browser, { width: 300, theme: "dark-modern" });
  try {
    const sel = await c.page.evaluate(() => { const all = [...document.querySelectorAll("[title]")].filter((n) => n.checkVisibility() && n.getAttribute("title").trim().length > 8 && n.getBoundingClientRect().width > 4); all.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right); const n = all[0]; n.dataset.polishTip = "1"; return n ? '[data-polish-tip="1"]' : ""; });
    assert.ok(sel, "ChatDGC has a control with a title near its right edge");
    await c.page.hover(sel); await c.page.waitForTimeout(1100);
    inside(await tipNow(c.page, sel), "ChatDGC");
  } finally { await c.page.close(); }
  const s = await openSettings(browser, { width: 440, theme: "dark" });
  try {
    const sel = await s.page.evaluate(() => { const all = [...document.querySelectorAll("[title]")].filter((n) => n.checkVisibility() && n.getAttribute("title").trim().length > 8 && n.getBoundingClientRect().width > 4 && n.getBoundingClientRect().bottom < innerHeight); all.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right); const n = all[0]; if (n) n.dataset.polishTip = "1"; return n ? '[data-polish-tip="1"]' : ""; });
    if (!sel) { t.diagnostic("Settings › General shows no control with a title"); return; }
    await s.page.hover(sel); await s.page.waitForTimeout(1100);
    inside(await tipNow(s.page, sel), "Settings");
  } finally { await s.close(); }
});

// ---- the shared document card, pointed at ------------------------------------------------------------------------------
for (const theme of ["dark", "light"]) {
  test(`a document card's quiet line reads at 4.5:1 while the card is pointed at (${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const seen = [];
    await eachSurface(browser, { width: 460, theme }, async (name, page, scope) => {
      if (!/card in (a Work chat|ChatDGC|a Pip's chat)/.test(name)) return;
      const card = page.locator(".dgc-doc-card").first(); await card.hover({ position: { x: 30, y: 8 } }); await page.waitForTimeout(350);
      seen.push([name, await page.evaluate(() => { const up = (n) => n.parentElement || (n.getRootNode() instanceof ShadowRoot ? n.getRootNode().host : null);
        const roots = [document]; for (const n of document.querySelectorAll("*")) if (n.shadowRoot) roots.push(n.shadowRoot);
        const meta = roots.map((r) => r.querySelector(".dgc-doc-card .dgc-doc-meta")).find(Boolean), card = meta.closest(".dgc-doc-card");
        const parse = (c) => { const m = String(c).match(/-?[\d.]+(e-?\d+)?/g).map(Number); return String(c).startsWith("color(srgb") ? [m[0] * 255, m[1] * 255, m[2] * 255, m[3] ?? 1] : [m[0], m[1], m[2], m[3] ?? 1]; };
        const over = (top, under) => top.slice(0, 3).map((v, i) => v * top[3] + under[i] * (1 - top[3]));
        const layers = []; for (let n = meta; n; n = up(n)) { const c = parse(getComputedStyle(n).backgroundColor); if (c[3] > 0) layers.unshift(c); if (c[3] >= 1) break; }
        let ground = [255, 255, 255]; for (const l of layers) ground = over(l, ground);
        const ink = over(parse(getComputedStyle(meta).color), ground), lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
        const [hi, lo] = [lum(ink), lum(ground)].sort((a, b) => b - a);
        return { lit: card.matches(":hover"), ratio: Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100 }; })]);
    });
    assert.ok(seen.length >= 3, `the cards were pointed at (${seen.map((s) => s[0])})`);
    for (const [name, m] of seen) { assert.ok(m.lit, `${name}: the card is lit`); assert.ok(m.ratio >= 4.5, `${name}: its quiet line reads at ${m.ratio}:1`); }
  });
}

// ---- a focus ring is not cut by the box it stands in ---------------------------------------------------------------------
for (const theme of ["dark", "light"]) for (const width of [300, 700]) {
  test(`a Pip's chat and its page: no focus ring is cut (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const where = width > 400 ? "tab" : "side";
    const p = await openPipChat(browser, { settings: true, width, height: 900, where, theme, api: 96 });
    try {
      await p.p.waitForTimeout(300); await p.p.keyboard.press("Shift");
      const chat = await p.p.evaluate(focusAudit, {});
      await p.p.evaluate(() => { const root = window.__pipsRoot || document; (root.querySelector('.pip-topbar .pip-menu [data-tab="job"]') || root.querySelector('[data-tab="job"]')).click(); }); await p.p.waitForTimeout(450);
      await p.p.keyboard.press("Shift");
      const page = await p.p.evaluate(focusAudit, {});
      assert.ok(chat.walked > 5 && page.walked > 5, "the controls were walked");
      assert.deepEqual([...chat.cut, ...page.cut].map((c) => `${c.what} “${c.text}”: ${c.lost}px of its ring is cut by ${c.by}`), []);
    } finally { await p.close(); }
  });
}
