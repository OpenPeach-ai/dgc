// A Pip's settings are short and clean (src/pipsClient.js, pipLevels.js, pipProfile.js and the other sections;
// src/pipInfoTip.js, src/pips.css): every section shows a short title and its control, and the sentence that explains it
// is behind a small "i" beside the title. Drawn by the real client and its CSS in real Chromium, in the side bar (a shadow
// root on Work's page), a Personal Pip's page and a Project Pip's Settings, at 240, 300 and 700 px, dark and light:
//   - no explaining paragraph is in sight until asked for, and every title is one to three words
//   - each "i" shows its sentence when pointed at and when the keyboard reaches it, a click keeps it open and a second
//     click closes it, Escape closes it, only one is open at a time, and it stays inside the panel at 240 px
//   - the sentence is the control's description for a screen reader (aria-describedby), open or not
//   - the one thing left in sight for safety: at Do it all a Personal Pip's risk, in a few words beside the picker
//   - what a Pip holds stays as it was: its goal, what it did on its own, its routines, apps and sites
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openChat } from "./support/pip-chat-scene.mjs";

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

const RISK = "Can be talked into sending things";
const FULL = "Does it all by itself, sends included. Still asks before any payment. A page or email it reads could talk it into sending something.";
/** Opens a Pip's settings: a Personal Pip's page (Info), or a Project Pip's Settings with Advanced open. */
async function open({ project = false, width = 300, theme = "dark", level = "full", height = 900 } = {}) {
  const x = await openChat(browser, { width, height, theme, project, api: 80, settings: true, level });
  await x.p.evaluate(() => (window.__pipsRoot || document).querySelector('[data-tab="job"]').click());
  await x.p.waitForSelector(project ? ".simple-content[data-view=job] #pipLevel" : ".pip-page #pipLevel");
  await x.p.waitForTimeout(300);
  if (project) await x.p.evaluate(() => { (window.__pipsRoot || document).querySelector("details.advanced").open = true; });
  return x;
}
/** What the settings show: every explaining line in sight, every title, every "i" with its sentence, and the floating sentence. */
const look = (p) => p.evaluate(() => {
  const root = window.__pipsRoot || document, page = root.querySelector(".pip-page, .simple-content[data-view=job]");
  const seen = (n) => n.checkVisibility({ visibilityProperty: true, opacityProperty: true }) && n.getBoundingClientRect().width > 1 && !n.closest("[hidden]");
  const words = (t) => t.trim().split(/\s+/).filter(Boolean).length;
  // An explaining line: a muted paragraph, the small line under a section's title, an empty list's paragraph.
  const lines = [...page.querySelectorAll("p.muted, p.goal ~ p.muted, .row-words > strong ~ small:not(.row-preview), .pip-page-empty, .routine-empty")]
    .filter((n) => seen(n) && !n.closest(".pip-tip, .daily-log-day") && n.getAttribute("role") !== "status").map((n) => n.textContent.trim()).filter(Boolean);
  const titles = [...page.querySelectorAll(".section h2, .section h3, .pip-page-label, .pip-page-row:not([data-linked-app]) > .row-words > strong, details.advanced > summary")]
    .filter(seen).map((n) => [...n.childNodes].filter((c) => !(c.nodeType === 1 && c.matches(".pip-tip"))).map((c) => c.textContent).join("").trim());
  const tips = [...page.querySelectorAll("[data-pip-tip]")].filter(seen).map((b) => { const text = root.getElementById(b.dataset.pipTip), r = b.getBoundingClientRect();
    return { id: b.dataset.pipTip, name: b.getAttribute("aria-label"), expanded: b.getAttribute("aria-expanded"), describedby: b.getAttribute("aria-describedby"), text: text?.textContent.trim() || "", role: text?.getAttribute("role"),
      textSeen: !!text && seen(text), size: [Math.round(r.width), Math.round(r.height)], color: getComputedStyle(b).color, tab: b.tabIndex,
      describes: [...page.querySelectorAll(`[aria-describedby~="${b.dataset.pipTip}"]`)].filter((n) => n !== b).map((n) => n.id || n.tagName.toLowerCase()) }; });
  const pop = root.querySelector(".pip-tip-pop"), box = pop?.getBoundingClientRect();
  return { lines, long: lines.filter((t) => words(t) > 6), titles, tips, words: words(page.innerText),
    pop: pop ? { text: pop.textContent.trim(), for: pop.dataset.pipTipFor, left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width } : null, pops: root.querySelectorAll(".pip-tip-pop").length,
    vw: document.documentElement.clientWidth, vh: document.documentElement.clientHeight, sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    muted: (() => { const i = document.createElement("i"); i.style.color = "var(--muted)"; (root.querySelector(".pip-app-root") || document.body).append(i); const c = getComputedStyle(i).color; i.remove(); return c; })() };
});

for (const theme of ["dark", "light"]) for (const width of [240, 300, 700]) for (const project of [false, true]) {
  const who = project ? "a Project Pip's Settings" : "a Personal Pip's page";
  test(`${who}, ${theme} ${width}px: a short title and its control, and no explaining paragraph in sight`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open({ project, width, theme });
    try {
      const v = await look(x.p);
      assert.deepEqual(v.long, [], "no explaining sentence is shown until its “i” is asked");
      assert.deepEqual(v.titles.filter((title) => title.split(/\s+/).length > 3), [], "every title is one to three words");
      assert.ok(v.tips.length >= (project ? 8 : 9), `the sections have their “i” (${v.tips.length})`);
      for (const tip of v.tips) {
        assert.ok(tip.text.split(/\s+/).length >= 3, `${tip.id}: it holds a sentence (${tip.text})`);
        assert.equal(tip.textSeen, false, `${tip.id}: its sentence is out of sight`);
        assert.deepEqual([tip.expanded, tip.role, tip.describedby, tip.tab], ["false", "tooltip", tip.id, 0], `${tip.id}: a button the keyboard reaches, named and described`);
        assert.match(tip.name, /^About \S/, `${tip.id}: it says what it is about (${tip.name})`);
        assert.ok(tip.size[0] >= 16 && tip.size[0] <= 24 && tip.size[1] >= 16 && tip.size[1] <= 24, `${tip.id}: small, and big enough to hit (${tip.size})`);
        assert.equal(tip.color, v.muted, `${tip.id}: the quiet grey`);
      }
      assert.equal(new Set(v.tips.map((tip) => tip.id)).size, v.tips.length, "each has its own id");
      assert.equal(v.sideways, false, "nothing runs off the side");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

for (const project of [false, true]) {
  test(`${project ? "a Project Pip's Settings" : "a Personal Pip's page"}: the sentence is its control's description, and far fewer words are in sight`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open({ project });
    try {
      const v = await look(x.p), by = Object.fromEntries(v.tips.map((tip) => [tip.id, tip]));
      assert.ok(by.pipLevelSays, "How much it asks has its “i”");
      assert.deepEqual(by.pipLevelSays.describes, ["pipLevel"], "the level's line describes its picker");
      assert.equal(by.pipLevelSays.text, project ? "Also writes a fix in its own copy by itself; the diff waits as a card for you. Never changes your files, commits or pushes." : FULL, "DGC's own line, whole");
      if (project) {
        assert.deepEqual(by.pipReportSays?.describes, ["pipReportAs"], "where its reports go");
        assert.equal(by.pipReportSays.text, "Each review’s findings come as a card in its chat.");
        assert.ok(v.tips.some((tip) => tip.text === "It runs when you ask it to."), "when it runs");
      } else assert.deepEqual(by.pipPayingSays?.describes, ["pipPaying"], "its rule for payments");
      // What it holds is still there, as it was.
      const kept = await x.p.evaluate(() => (window.__pipsRoot || document).querySelector(".pip-page, .simple-content[data-view=job]").innerText);
      for (const text of project ? ["Look for billing bugs that charge the wrong amount.", "Reviewed: Discount is accepted but never subtracted", "Sales this week", "Ask me again from now on"]
        : ["Send a short morning news brief.", "Morning brief", "Added to cart on shop.example", "Opened news.example for the first time", "news.example", "Likes the brief short: five bullets.", "Sales this week", "Send email to sam@mail.example"])
        assert.ok(kept.includes(text), `still there: ${text}`);
      assert.ok(v.words <= (project ? 380 : 250), `the page reads short (${v.words} words; it was ${project ? 702 : 416})`);
    } finally { await x.close(); }
  });
}

for (const width of [240, 300, 700]) {
  test(`${width}px: an “i” shows its sentence when pointed at, on focus and on a click; Escape closes it; one at a time; inside the panel`, async (t) => {
    if (skipOrFail(t)) return;
    for (const project of [false, true]) {
      const x = await open({ project, width });
      try {
        const tips = (await look(x.p)).tips, at = (id) => x.p.locator(`[data-pip-tip="${id}"]`);
        const pop = async () => (await look(x.p)).pop;
        const inside = (p, v) => p.left >= 0 && p.right <= v.vw + 0.5 && p.top >= 0 && p.bottom <= v.vh + 0.5;
        // Pointed at: each one, in turn; the sentence is whole, inside the panel, and gone when the pointer leaves.
        for (const tip of tips) {
          await at(tip.id).scrollIntoViewIfNeeded(); await at(tip.id).hover();
          const v = await look(x.p);
          assert.deepEqual([v.pop?.for, v.pop?.text, v.pops], [tip.id, tip.text, 1], `${tip.id}: pointed at, its sentence shows, and only it`);
          assert.ok(inside(v.pop, v), `${tip.id}: inside the panel at ${width}px (${JSON.stringify(v.pop)})`);
          assert.ok(v.pop.width <= 281, `${tip.id}: a small note, not a banner (${v.pop.width})`);
          assert.equal(v.tips.find((b) => b.id === tip.id).expanded, "true");
          const b = await at(tip.id).boundingBox();
          assert.ok(v.pop.bottom <= b.y + 0.5 || v.pop.top >= b.y + b.height - 0.5, `${tip.id}: it never covers its “i”`);
        }
        await x.p.mouse.move(2, 2);
        assert.equal(await pop(), null, "the pointer left: it is gone");
        // The keyboard: focus shows it, Tab to the next shows that one only, Escape closes and the focus stays.
        const [a, b] = tips;
        await at(a.id).focus();
        assert.equal((await pop())?.for, a.id, "focus shows it");
        await x.p.keyboard.press("Escape");
        assert.equal(await pop(), null, "Escape closes it");
        assert.equal(await x.p.evaluate(() => (window.__pipsRoot || document).activeElement?.dataset?.pipTip || ""), a.id, "and the keyboard stays on its “i”");
        assert.ok(await x.p.locator(".pip-page, .simple-content[data-view=job]").first().isVisible(), "Escape closed the sentence, not the page");
        await at(b.id).focus();
        assert.deepEqual([(await pop())?.for, (await look(x.p)).pops], [b.id, 1], "the next one: one at a time");
        await x.p.evaluate(() => (window.__pipsRoot || document).activeElement.blur());
        assert.equal(await pop(), null, "focus left: it is gone");
        // A click (a tap) keeps it open with the pointer away; a second click closes it; a click elsewhere closes it.
        await at(a.id).scrollIntoViewIfNeeded(); await at(a.id).click(); await x.p.mouse.move(2, 2);
        assert.equal((await pop())?.for, a.id, "clicked: it stays");
        await at(b.id).click(); await x.p.mouse.move(2, 2);
        assert.deepEqual([(await pop())?.for, (await look(x.p)).pops], [b.id, 1], "another clicked: the first closes");
        await at(b.id).click(); await x.p.mouse.move(2, 2);
        assert.equal(await pop(), null, "clicked again: closed");
        await at(a.id).click(); await x.p.mouse.move(2, 2);
        await x.p.locator(".pip-page, .simple-content[data-view=job]").first().click({ position: { x: 4, y: 4 } });
        assert.equal(await pop(), null, "a click elsewhere closes it");
        assert.deepEqual(x.errors, []);
      } finally { await x.close(); }
    }
  });
}

test("a touch: a tap on an “i” opens its sentence and a second tap closes it", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ width: 300 });
  try {
    const tap = () => x.p.evaluate(() => { const b = (window.__pipsRoot || document).querySelector('[data-pip-tip="pipLevelSays"]'); b.focus(); b.click(); });
    await tap();
    assert.equal((await look(x.p)).pop?.for, "pipLevelSays", "a tap: open");
    await tap();
    assert.equal((await look(x.p)).pop, null, "a second tap: closed");
  } finally { await x.close(); }
});

for (const theme of ["dark", "light"]) for (const width of [240, 300, 700]) {
  test(`${theme} ${width}px: at Do it all a Personal Pip's risk stays in sight in a few words; the whole line is behind the “i”`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open({ width, theme });
    try {
      const risk = await x.p.evaluate(() => { const root = window.__pipsRoot || document, n = root.querySelector(".pip-level-risk"), pick = root.querySelector("#pipLevel");
        if (!n) return null; const r = n.getBoundingClientRect(), s = pick.getBoundingClientRect(), row = n.closest(".pip-page-row").getBoundingClientRect();
        const lum = (c) => { const m = c.match(/[\d.]+/g).map(Number), f = c.startsWith("color(srgb") ? 255 : 1; const [R, G, B] = m.slice(0, 3).map((v) => { v = v * f / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * R + 0.7152 * G + 0.0722 * B; };
        let ground = "rgb(255, 255, 255)"; for (let a = n; a; a = a.parentElement || a.getRootNode().host) { const c = getComputedStyle(a).backgroundColor; if (c && !/rgba\(.*, 0\)|transparent/.test(c)) { ground = c; break; } }
        const [hi, lo] = [lum(getComputedStyle(n).color), lum(ground)].sort((p, q) => q - p);
        return { text: n.textContent.trim(), seen: n.checkVisibility() && r.width > 10, inRow: r.left >= row.left && r.right <= row.right + 0.5 && r.top >= row.top && r.bottom <= row.bottom + 0.5, near: Math.abs(r.top - s.bottom) < 40 || Math.abs(r.bottom - s.top) < 40 || (r.top < s.bottom && r.bottom > s.top),
          ratio: Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100, describedby: pick.getAttribute("aria-describedby") }; });
      assert.ok(risk, "the risk is on the page");
      assert.deepEqual([risk.text, risk.seen, risk.inRow, risk.near], [RISK, true, true, true], "in a few words, in sight, beside the picker");
      assert.ok(risk.ratio >= 4.5, `it reads at 4.5:1 (${risk.ratio})`);
      assert.match(risk.describedby, /pipLevelSays/, "the picker is described by the whole line");
      assert.equal((await look(x.p)).tips.find((tip) => tip.id === "pipLevelSays").text, FULL, "the whole line, behind the “i”");
    } finally { await x.close(); }
  });
}

test("the risk shows only where it is one: not at Ask me first, and not on a Project Pip (its Do it all sends nothing)", async (t) => {
  if (skipOrFail(t)) return;
  for (const options of [{ level: "ask" }, { level: "approve" }, { project: true, level: "full" }]) {
    const x = await open(options);
    try { assert.equal(await x.p.locator(".pip-level-risk").count(), 0, JSON.stringify(options)); } finally { await x.close(); }
  }
});
