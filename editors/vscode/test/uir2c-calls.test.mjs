// His 16 Nov calls after the second pass, in real Chromium on the real pages:
// Home's number counts only what needs you (things that are only new are a quiet dot, never in the number); a Pip's
// reply bubble has the sent bubble's 10 px on every corner, with no tail; Home says "New work", not "New session".
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromiumOrNull } from "./support/look-probe.mjs";
import { launchArgs, openHomeCards, grid } from "./support/uir2b-scene.mjs";
import { openPip } from "./support/uir2a-scene.mjs";
import { DOCK_SESSIONS } from "./support/dock-scene.mjs";
import { cleanup } from "./support/panel-bundle.mjs";

const chromium = await chromiumOrNull();
let browser;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "";
  if (!reason) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};
before(async () => { if (!chromium) return; try { browser = await chromium.launch({ args: launchArgs }); } catch { browser = null; } });
after(async () => { await browser?.close(); cleanup(); });
const CALM = DOCK_SESSIONS.map((s) => ({ ...s, waiting: false, running: false, ask: undefined }));
const shape = (x) => x.page.evaluate(() => { const b = document.getElementById("side-tab-home-count"), r = b.getBoundingClientRect(), s = getComputedStyle(b);
  return { shown: !b.hidden && r.width > 0, w: Math.round(r.width), h: Math.round(r.height), ground: s.backgroundColor }; });

for (const width of [300, 440, 700]) {
  test(`Home's number counts only what needs you; the things that are only new are in its words (${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const busy = await openHomeCards(browser, { width });
    try {
      const b = await busy.badge();
      const m = /^Home: (\d+) needs? you, (\d+) new$/.exec(b.label);
      assert.ok(m, `its spoken name says both (${b.label})`);
      assert.ok(Number(m[2]) > 0, "premise: there are new things too");
      assert.equal(b.text, m[1], "the number is what needs you, never with the new things added");
      assert.equal(b.title, b.label.replace(/^Home: /, ""), "and its tooltip says both");
      assert.equal(b.newsOnly, false);
    } finally { await busy.page.close(); }
  });
  test(`Home with only new things shows a quiet dot and no number (${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const news = await openHomeCards(browser, { width, quiet: true, sessions: CALM });
    try {
      const b = await news.badge(), s = await shape(news);
      assert.equal(b.label, "Home: 4 new"); assert.equal(b.title, "4 new");
      assert.equal(b.text, "", "no number: nothing needs you");
      assert.equal(b.newsOnly, true);
      assert.equal(s.shown, true, "a dot says there is something new");
      assert.ok(s.w <= 8 && s.h <= 8 && s.w === s.h, `it is a small dot (${s.w}x${s.h})`);
    } finally { await news.page.close(); }
    const none = await openHomeCards(browser, { width, quiet: true, sessions: CALM, made: false });
    try { const s = await shape(none); assert.equal(s.shown, false, "nothing new and nothing waiting: no dot"); assert.equal((await none.badge()).label, "Home"); }
    finally { await none.page.close(); }
  });
}

const DEEP = "const all = (root, s, out = []) => { out.push(...root.querySelectorAll(s)); for (const n of root.querySelectorAll('*')) if (n.shadowRoot) all(n.shadowRoot, s, out); return out; };";
const corners = (page, selector) => page.evaluate(([sel, deep]) => { const all = new Function(`${deep} return all;`)();
  return all(document, sel).filter((n) => n.getClientRects().length).map((n) => { const s = getComputedStyle(n); return [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomRightRadius, s.borderBottomLeftRadius].join(" "); }); }, [selector, DEEP]);
const TEN = "10px 10px 10px 10px";
for (const theme of ["dark-modern", "light-modern"]) for (const width of [300, 440, 700]) {
  test(`a Pip's reply bubble has 10 px on every corner and no tail (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const pip = await openPip(browser, { theme, width, said: [{ role: "user", text: "Which sources did you use?" }, { role: "assistant", text: "Two: the tide tables and the harbour log." },
      { role: "user", text: "And the weather?" }, { role: "assistant", text: "The forecast for Baga, read this morning.\n\nIt says light rain after four." }] });
    try {
      const got = await corners(pip.page, ".pip-message.assistant .answer:not(.split), .pip-message.assistant .answer.split .reply-part");
      assert.ok(got.length >= 2, `the replies are drawn as bubbles (${got.length})`);
      for (const c of got) assert.equal(c, TEN);
      const more = await pip.page.evaluate((deep) => { const all = new Function(`${deep} return all;`)(), last = all(document, ".pip-message.assistant").at(-1);
        const n = document.createElement("div"); n.className = "pip-message typing"; n.innerHTML = '<span class="typing-dots"><i></i><i></i><i></i></span>'; last.parentElement.append(n);
        const s = getComputedStyle(n), typing = [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomRightRadius, s.borderBottomLeftRadius].join(" "); n.remove();
        const top = last.getBoundingClientRect().top, head = all(document, "h1, h2, h3, strong, .pip-name, [class*=name]").filter((n) => n.getClientRects().length && /Mornings/.test(n.textContent) && n.getBoundingClientRect().bottom <= top + 1);
        return { typing, who: head.length }; }, DEEP);
      assert.equal(more.typing, TEN, "the writing dots");
      assert.ok(more.who > 0, "its face and name above still say who is talking");
      assert.deepEqual(pip.errors, []);
    } finally { await pip.close(); }
  });
}

test("Home says New work, not New session: Quick start, the Folders card, the Work card and the dock's menu", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openHomeCards(browser, { width: 440, layout: grid.EVERY });
  try {
    const said = await x.page.evaluate(() => { const text = (n) => (n?.textContent || "").replace(/\s+/g, " ").trim(), q = document.querySelector('.hc-card[data-card="quick"]');
      const here = document.querySelector('.hc-card[data-card="folders"] .hc-here'), work = document.querySelector('.hc-card[data-card="work"] .hc-new-btn');
      const all = [...document.querySelectorAll("#home-hub *")].flatMap((n) => [n.getAttribute("title"), n.getAttribute("aria-label"), n.children.length ? "" : n.textContent]).filter((s) => /new session/i.test(s || ""));
      return { quick: text(q), quickTitles: [...q.querySelectorAll("button")].map((b) => b.getAttribute("title") || b.getAttribute("aria-label") || text(b)), here: [here?.title, here?.getAttribute("aria-label")], work: work?.title, all }; });
    assert.match(said.quick, /New work|Work/); assert.doesNotMatch(said.quick, /Session/i, "the tile is named by its tab");
    assert.equal(said.quickTitles[0], "New work");
    assert.deepEqual(said.here, ["New work here", "New work in shop"]);
    assert.match(said.work, /^New work/);
    assert.deepEqual(said.all, [], "nowhere on Home says New session");
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../media/shared/homecards.js", import.meta.url), "utf8") + readFileSync(new URL("../media/shared/dock.js", import.meta.url), "utf8");
    assert.doesNotMatch(src, /New session|New Work session/, "nor any form of the cards or the dock's New menu");
    assert.match(src, /\["work", "Work", "New work"/, "the Small tile says Work");
    assert.match(src, /label: "New work"/, "the dock's New menu");
  } finally { await x.page.close(); }
});
