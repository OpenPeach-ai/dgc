// The visual polish pass (0.52, 14 Nov), kept: what the sweep of every screen found, measured again on the same real
// pages so none of it comes back. Each test walks a screen (test/support/polish-scenes.mjs) with the pass's own
// measuring stick (test/support/polish-audit.mjs): a control a touch screen cannot see, words under 4.5:1, a label
// cut where it has room, a row's path cut beside empty room. In real Chromium, dark and light.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { audit } from "./support/polish-audit.mjs";
import { SCENES } from "./support/polish-scenes.mjs";
import { cleanup } from "./support/notes-host.mjs";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser, touchBrowser;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "";
  if (!reason) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; return; }
  // A browser whose every page is a touch screen: no pointer rests on anything ((hover: none) is true there).
  touchBrowser = new Proxy(browser, { get(target, key) {
    if (key === "newContext") return (o = {}) => target.newContext({ ...o, hasTouch: true });
    if (key === "newPage") return (o = {}) => target.newPage({ ...o, hasTouch: true });
    const v = target[key]; return typeof v === "function" ? v.bind(target) : v; } });
});
after(async () => { await browser?.close(); cleanup(); });

/** Walks `scene` and measures the states named: { state: audit }. `also(state, page)` runs while a state is up. */
async function walk(scene, { width, theme, touch = false }, states, also) {
  const found = {};
  // (Once the last state asked for is measured the walk stops: the scene closes its page as it unwinds.)
  const DONE = new Error("measured"), left = new Set(states);
  await SCENES[scene](touch ? touchBrowser : browser, { width, theme, touch }, async (state, page, o = {}) => {
    if (!states.includes(state)) return;
    if (!touch) await page.mouse.move(1, 1);
    await page.evaluate(() => new Promise((d) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(d, 150)))));
    found[state] = await page.evaluate(audit, { scope: o.scope || "", touch });
    if (also) found[state].also = await also(state, page);
    left.delete(state); if (!left.size) throw DONE;
  }).catch((error) => { if (error !== DONE) throw error; });
  for (const s of states) assert.ok(found[s], `${scene}: the state “${s}” was on screen`);
  return found;
}
const said = (list) => list.map((x) => `${x.what} “${x.text}” ${x.ratio ?? ""}`.trim());
// (A switch's own input is drawn by its label: it is not a control hidden from a finger.)
const hidden = (a) => said(a.unseen.filter((x) => !/label\.switch > input/.test(x.what)));

// ---- a touch screen: nothing that acts is shown only to a pointer's hover ---------------------------------------------
for (const theme of ["dark", "light"]) {
  test(`touch: Home's folder tiles show New work and the pin without a hover (${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const { top, end } = await walk("home-grid", { width: 700, theme, touch: true }, ["top", "end"]);
    assert.equal(await Promise.resolve(top.width), 700);
    assert.deepEqual([...hidden(top), ...hidden(end)], [], "every control on Home is in sight on a touch screen");
  });
  test(`touch: a Work chat's Copy on a line of commentary is in sight (${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const s = await walk("work-chat", { width: 440, theme, touch: true }, ["running-queue"]);
    assert.deepEqual(hidden(s["running-queue"]), []);
  });
  test(`touch: ChatDGC's Copy and Edit on your own message are in sight (${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const s = await walk("chatdgc", { width: 440, theme, touch: true }, ["a-chat"]);
    assert.deepEqual(hidden(s["a-chat"]), []);
  });
  test(`touch: a Pip's chat shows each message's actions (${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const s = await walk("pips-chat", { width: 440, theme, touch: true }, ["pip-chat"]);
    assert.deepEqual(hidden(s["pip-chat"]), []);
  });
}

// ---- words read at 4.5:1 -------------------------------------------------------------------------------------------------
const low = (a, pattern) => said(a.contrast.filter((x) => pattern.test(x.what)));
for (const theme of ["dark", "light"]) {
  test(`contrast: a menu's quiet second line, and a key's hint, read at 4.5:1 on the menu's own ground (${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const work = await walk("work-model-menu", { width: 440, theme }, ["menu", "sub-agents"]);
    const pips = await walk("pips-chat", { width: 440, theme }, ["level-menu"]);
    const chat = await walk("chatdgc", { width: 440, theme }, ["plus-menu"]);
    assert.deepEqual([work.menu, work["sub-agents"], pips["level-menu"], chat["plus-menu"]].flatMap((a) => low(a, /dgc-menu-sub|agents-part|agents-row-value|dgc-key|dgc-menu-hint/)), []);
  });
  test(`contrast: every field's placeholder reads at 4.5:1 (${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const work = await walk("work-list", { width: 300, theme }, ["folder-menu"]);
    const notes = await walk("home-notes", { width: 300, theme }, ["list"]);
    const grid = await walk("home-grid", { width: 700, theme }, ["top"]);
    const pips = await walk("pips-list", { width: 300, theme }, ["list", "new-pip"]);
    const page = await walk("pips-chat", { width: 440, theme }, ["page"]);
    const lib = await walk("chatdgc", { width: 440, theme }, ["library-artifacts"]);
    assert.deepEqual([work["folder-menu"], notes.list, grid.top, pips.list, pips["new-pip"], page.page, lib["library-artifacts"]].flatMap((a) => low(a, /::placeholder/)), []);
  });
  test(`contrast: a Pip's page (its tabs, a row's second line, “not offered here”) and Home's empty line read at 4.5:1 (${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const page = await walk("pips-chat", { width: 440, theme }, ["page", "page-middle", "page-end"]);
    const home = await walk("home-answers", { width: 440, theme }, ["cards", "cards-end"]);
    const empty = await walk("home-empty", { width: 440, theme }, ["empty"]);
    assert.deepEqual([...Object.values(page), ...Object.values(home), empty.empty].flatMap((a) => low(a, /pip-page-tabs|row-preview|p\.error|dgc-hub-empty/)), []);
  });
  test(`contrast: a command waiting for your okay, and the Library's count on its chosen kind, read at 4.5:1 (${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const work = await walk("work-chat", { width: 440, theme }, ["approval"]);
    const lib = await walk("chatdgc", { width: 440, theme }, ["library-artifacts"]);
    assert.deepEqual([work.approval, lib["library-artifacts"]].flatMap((a) => low(a, /perm-card > pre|lib-kind-count/)), []);
  });
}

// ---- words that have room are not cut --------------------------------------------------------------------------------------
const cutOf = (a, pattern) => a.cut.filter((x) => pattern.test(x.what)).map((x) => `${x.what} “${x.text}” shows ${x.shown} of ${x.needs}px`);
for (const theme of ["dark", "light"]) {
  test(`cut: on a Small Recent card the newest thing's name shows (it was crushed to a sliver by a wrapped line under it) (${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const s = await walk("home-grid", { width: 300, theme }, ["top"], (state, page) => page.evaluate(() => { const c = document.querySelector('.hc-grid .hc-card[data-card="recent"]'), mid = c.querySelector(".hc-mid"), sub = c.querySelector(".hc-sub");
      return { form: c.dataset.form, foot: c.getBoundingClientRect().bottom - sub.getBoundingClientRect().bottom, name: mid.getBoundingClientRect().height, line: parseFloat(getComputedStyle(mid).lineHeight), sub: sub.getBoundingClientRect().height, subLine: parseFloat(getComputedStyle(sub).lineHeight) }; }));
    const m = s.top.also;
    assert.equal(m.form, "s", "the card is Small");
    assert.ok(m.name >= m.line - 0.5, `its name has at least one whole line (${m.name}px of a ${m.line}px line)`);
    assert.ok(m.sub <= m.subLine + 1, `the line under it is one line (${m.sub}px)`);
    assert.ok(m.name <= 2 * m.line + 1, `and two lines at most: no third under the second's ellipsis (${m.name}px)`);
    assert.ok(m.foot <= 12, `the line under it stays at the card's foot (${m.foot}px above its padding)`);
    assert.deepEqual(cutOf(s.top, /hc-recent > span\.hc-mid/), []);
  });
  test(`cut: the Project Folder dropdown at 300px shows “This window”'s path whole while its row has room (${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const s = await walk("work-list", { width: 300, theme }, ["folder-menu"], (state, page) => page.evaluate(() => { const row = [...document.querySelectorAll(".dgc-folder-menu .dgc-folder-row")].find((r) => r.querySelector(".dgc-folder-note")?.textContent === "This window");
      const path = row.querySelector(".dgc-path"), note = row.querySelector(".dgc-folder-note").getBoundingClientRect(), r = row.getBoundingClientRect(), label = row.querySelector(".dgc-menu-label").getBoundingClientRect(), p = path.getBoundingClientRect();
      const range = document.createRange(); range.selectNodeContents(path.querySelector(".dgc-path-head"));
      return { cut: path.classList.contains("is-cut"), dots: !!path.querySelector(".dgc-path-dots")?.checkVisibility(), words: path.textContent, noteInside: note.right <= r.right + 0.5 && note.left >= label.left, onNote: Math.max(0, Math.min(p.right, note.right) - Math.max(p.left, note.left)) > 0.5 && Math.min(p.bottom, note.bottom) - Math.max(p.top, note.top) > 0.5,
        labelCut: (() => { const l = row.querySelector(".dgc-menu-label"); return l.scrollWidth > l.clientWidth + 1; })() }; }));
    const m = s["folder-menu"].also;
    assert.equal(m.cut || m.dots, false, `the path is whole (${m.words})`);
    assert.ok(m.noteInside, "“This window” is still on its row"); assert.equal(m.onNote, false, "and the path does not run under it"); assert.equal(m.labelCut, false, "nor is the folder's name cut for it");
  });
  test(`cut: “Open in browser” on an artifact's card is not cut (${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const s = await walk("work-model-menu", { width: 440, theme }, ["agent-map"]);
    assert.deepEqual(cutOf(s["agent-map"], /abtns > button/), []);
  });
}

// ---- a folder's name on its tile ----------------------------------------------------------------------------------------
for (const theme of ["dark", "light"]) {
  test(`contrast: a folder's name on its tile reads at 4.5:1 whatever the folder's front (${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const s = await walk("home-grid", { width: 700, theme }, ["end"], (state, page) => page.evaluate(() => [...document.querySelectorAll(".hc-folders .folder-label")].filter((l) => l.checkVisibility()).map((l) => {
      const cs = getComputedStyle(l), parse = (c) => { const m = String(c).match(/-?[\d.]+(e-?\d+)?/g).map(Number); return String(c).startsWith("color(srgb") ? [m[0] * 255, m[1] * 255, m[2] * 255, m[3] ?? 1] : [m[0], m[1], m[2], m[3] ?? 1]; };
      const chip = parse(cs.backgroundColor), ink = parse(cs.color), lum = (c) => { const [r, g, b] = c.slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      // The palest front there can be under the chip is white: the chip laid over it is the lightest ground the name can have.
      const ground = chip.slice(0, 3).map((v) => v * chip[3] + 255 * (1 - chip[3])), [hi, lo] = [lum(ink), lum(ground)].sort((a, b) => b - a);
      return { name: l.textContent, ratio: Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100 }; })));
    const labels = s.end.also;
    assert.ok(labels.length >= 4, `the folders' names are on their tiles (${labels.length})`);
    assert.deepEqual(labels.filter((l) => l.ratio < 4.5).map((l) => `${l.name} ${l.ratio}`), []);
  });
}

// ---- pointed at: a lit row's quiet words still read; the numbers of a change read on a light ground ----------------------
/** Points at the first thing matching `selector` (through shadow roots) and measures the words under it. */
const pointed = async (page, selector) => {
  const at = await page.evaluate((sel) => { const roots = [document]; for (const n of document.querySelectorAll("*")) if (n.shadowRoot) roots.push(n.shadowRoot);
    const n = roots.map((r) => r.querySelector(sel)).find(Boolean); if (!n) return null; n.scrollIntoView({ block: "center" }); n.dataset.polishHot = "t"; const r = n.getBoundingClientRect(); return [r.left + Math.min(r.width / 2, 40), r.top + r.height / 2]; }, selector);
  if (!at) return null;
  await page.mouse.move(at[0], at[1]); await page.waitForTimeout(260);
  const found = await page.evaluate(audit, { scope: '[data-polish-hot="t"]', quick: true });
  const lit = await page.evaluate(() => { const roots = [document]; for (const n of document.querySelectorAll("*")) if (n.shadowRoot) roots.push(n.shadowRoot); const n = roots.map((r) => r.querySelector('[data-polish-hot="t"]')).find(Boolean); const yes = n.matches(":hover"); delete n.dataset.polishHot; return yes; });
  await page.mouse.move(1, 1);
  return { lit, low: said(found.contrast) };
};
for (const theme of ["dark", "light"]) {
  test(`pointed at: an agent's row on the map, a Pip's row and a Needs attention row keep their quiet line at 4.5:1 (${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const map = await walk("work-model-menu", { width: 440, theme }, ["agent-map"], (state, page) => pointed(page, ".am-row.am-agent"));
    const pips = await walk("pips-list", { width: 440, theme }, ["list"], async (state, page) => [await pointed(page, ".pips-one-list .pip-row"), await pointed(page, ".attention-row")]);
    const all = [map["agent-map"].also, ...pips.list.also];
    for (const one of all) { assert.ok(one, "the row is on screen"); assert.ok(one.lit, "and is lit by the pointer"); }
    assert.deepEqual(all.flatMap((one) => one.low.filter((l) => !/dgc-sheet-tag/.test(l))), []);
  });
  test(`pointed at: an artifact's address in a Work chat still reads (${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const s = await walk("work-model-menu", { width: 440, theme }, ["agent-map"], async (state, page) => { await page.keyboard.press("Escape"); await page.waitForTimeout(250); return pointed(page, ".artifact .aurl"); });
    const one = s["agent-map"].also; assert.ok(one?.lit, "the address is pointed at");
    assert.deepEqual(one.low, []);
  });
  test(`contrast: the added and removed line counts of a change read at 4.5:1 (${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const s = await walk("pips-chat", { width: 440, theme }, ["chat-ready"], (state, page) => page.evaluate(() => { const root = document.getElementById("pips-host").shadowRoot; root.querySelector(".diff-stat")?.scrollIntoView({ block: "center" }); return !!root.querySelector(".diff-stat"); })
      .then(async (there) => { await page.waitForTimeout(200); return { there, again: await page.evaluate(audit, {}) }; }));
    assert.ok(s["chat-ready"].also.there, "a change's files are listed");
    assert.deepEqual(low(s["chat-ready"].also.again, /diff-stat/), []);
  });
}

test("pointed at: a changed file's row in a Pip's change card keeps its folder's quiet words at 4.5:1 (dark)", async (t) => {
  if (skipOrFail(t)) return;
  const s = await walk("pips-chat", { width: 440, theme: "dark" }, ["chat-ready"], (state, page) => pointed(page, ".pip-project-card .diff-toggle"));
  const one = s["chat-ready"].also; assert.ok(one?.lit, "the row is pointed at");
  assert.deepEqual(one.low, []);
});
