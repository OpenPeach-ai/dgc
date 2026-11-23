// The Pips view's Project tab (0.52, decided 13 Nov): the Project Folder dropdown has a line of its own, at the
// left, straight under the Personal | Project tabs and above Needs attention, whether or not anything waits. It is the
// tab's one control: Needs attention, its count, the tab's number and the list of Project Pips follow it, and a folder
// with no Pips workspace yet has no project cards at all. The Needs attention heading (both tabs) is words and a count,
// with no chevron: its fold is a quiet word at the line's right end, "Hide" while the cards show and "Show" while they
// are folded, a real button that keeps the keyboard where it was.
// In real Chromium, both copies of the view (the side bar's shadow root and an editor tab:
// test/support/project-folder-pips-scene.mjs), at 700 and 300 px, dark and light. Read from the DOM, computed style
// and geometry.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { GARDEN, HERE, LONG, NOTES, openPips, pipsContrast } from "./support/project-folder-pips-scene.mjs";

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
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

const low = (marks) => marks.filter((m) => m.ratio < 4.5);
const settle = (page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
const until = (x, fn, arg) => x.page.waitForFunction(([f, a]) => (0, eval)(`(${f})`)(document.getElementById("pips-host")?.shadowRoot || document, a), [fn.toString(), arg], { timeout: 15000 });
const choose = async (x, folder, name) => { await x.send({ type: "pipsProjectFolder", folder });
  await until(x, (root, n) => root.querySelector("#pips-folder-pick")?.getAttribute("aria-label") === `Project Folder: ${n}`, name); await x.page.waitForTimeout(120); await settle(x.page); };

/** The top of the tab as it is on screen: the tabs, the dropdown's line, the heading line, what comes under. */
const read = (x) => x.inPips((root) => {
  const box = (e) => e.getBoundingClientRect(), mid = (e) => (box(e).top + box(e).bottom) / 2, seen = (e) => !!e && e.checkVisibility();
  const panel = root.querySelector("#pips-tabpanel"), tabs = root.querySelector(".pips-tabs"), pick = root.querySelector("#pips-folder-pick"), line = pick?.closest(".pips-folder-line") || null;
  const section = root.querySelector("section.attention"), head = section?.querySelector(".attention-head") || null, title = section?.querySelector(".attention-title") || null, toggle = root.querySelector("#attention-toggle");
  const style = getComputedStyle(panel), left = box(panel).left + parseFloat(style.paddingLeft), right = box(panel).right - parseFloat(style.paddingRight);
  const value = pick?.querySelector(".dgc-folder-v"), r = document.createRange(); if (value) r.selectNodeContents(value);
  const probe = document.createElement("span"); probe.style.color = "var(--muted)"; panel.append(probe); const muted = getComputedStyle(probe).color; probe.remove();
  const shell = root.querySelector(".pip-app-root") || document.body, list = root.querySelector("#attention-list");
  const under = [...panel.children].find((e) => e !== line && seen(e));
  return {
    pick: pick && { first: panel.firstElementChild === line, ownLine: !!line && line.children.length === 1, inHeading: !!pick.closest(".attention, .attention-head"), underTabs: box(line || pick).top - box(tabs).bottom,
      top: box(pick).top - box(panel).top, left: box(pick).left - left, right: right - box(pick).right, height: box(pick).height, lineWidth: line ? box(line).width - (right - left) : -99,
      word: seen(pick.querySelector(".dgc-folder-k")), value: value.textContent, valueWhole: r.getBoundingClientRect().width <= box(value).width + 0.01, label: pick.getAttribute("aria-label"), title: pick.title,
      nextUnder: under ? box(under).top - box(pick).bottom : -99 },
    standIn: root.querySelectorAll(".attention-none, .attention-toggle-none, .pips-folder-row, .attention-head-end, .attention-head-gap").length,
    heading: seen(section) ? { tag: title?.tagName || "", words: (title?.textContent || "").replace(/\s+/g, " ").trim(), left: title ? box(title).left - left : -99, button: !!title?.closest("button") || !!title?.querySelector("button"),
      marks: head.querySelectorAll("svg, .codicon, .attention-fold, [class*=chevron]").length, drawn: [title, toggle].map((e) => e && [getComputedStyle(e, "::before").content, getComputedStyle(e, "::after").content].join()).join(),
      underPick: pick ? box(head).top - box(pick).bottom : 0, count: section.querySelector(".attention-count")?.textContent || "",
      countAfterWords: (() => { const w = document.createRange(); w.selectNodeContents(title.firstChild); return box(section.querySelector(".attention-count")).left - w.getBoundingClientRect().right; })() } : null,
    fold: seen(toggle) ? { tag: toggle.tagName, type: toggle.type, words: toggle.textContent, label: toggle.getAttribute("aria-label"), expanded: toggle.getAttribute("aria-expanded"), controls: toggle.getAttribute("aria-controls"),
      right: right - box(toggle).right, sameLine: Math.abs(mid(toggle) - mid(title)), afterTitle: box(toggle).left - box(title.querySelector(".attention-count")).right, colour: getComputedStyle(toggle).color === muted,
      weight: getComputedStyle(toggle).fontWeight, ground: getComputedStyle(toggle).backgroundColor, border: getComputedStyle(toggle).borderTopWidth,
      list: !!list && !list.hasAttribute("hidden") && box(list).height > 0, cards: root.querySelectorAll(".attention-list > li").length,
      viewAll: root.querySelector("#attention-view-all") ? box(toggle).left - box(root.querySelector("#attention-view-all")).right : null } : null,
    tabCount: root.querySelector("#pips-tab-project .pip-tab-count")?.textContent || "", cardTitles: [...root.querySelectorAll(".attention-list > li strong")].map((e) => e.textContent.trim()),
    rows: [...root.querySelectorAll("#pips-tabpanel .pip-row-name")].map((e) => e.textContent.trim()), empty: root.querySelector(".pips-tab-empty")?.textContent.trim() || "",
    sideways: shell.scrollWidth > shell.clientWidth + 1 };
});
const focusAt = (x) => x.inPips((root) => { const a = root.activeElement; return a ? { id: a.id, expanded: a.getAttribute("aria-expanded"), ring: a.matches(":focus-visible") && getComputedStyle(a).outlineStyle !== "none" && parseFloat(getComputedStyle(a).outlineWidth) > 0 } : null; });

for (const where of ["side", "tab"]) for (const theme of ["dark-modern", "light-modern"]) for (const width of [700, 300]) {
  test(`the Project tab: the dropdown is on its own line under the tabs, at the left, apart from the Needs attention heading; with cards and with none (${where}, ${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    // All projects: a Project Pip's card waits.
    let x = await openPips(browser, { theme, width, where });
    let withCards;
    try {
      const m = withCards = await read(x);
      assert.ok(m.pick, "the dropdown is on the Project tab");
      assert.deepEqual([m.pick.first, m.pick.ownLine, m.pick.inHeading], [true, true, false], "the first thing in the tab's panel, alone on its line, no part of the Needs attention heading");
      assert.ok(m.pick.underTabs >= 0 && m.pick.underTabs <= 24, `straight under the tabs: ${m.pick.underTabs}`);
      assert.ok(Math.abs(m.pick.left) <= 0.5, `at the left edge: ${m.pick.left}`);
      assert.ok(m.pick.right >= 0, `inside the line: ${m.pick.right}`);
      assert.ok(m.pick.height <= 30, "one line");
      assert.deepEqual([m.pick.word, m.pick.value, m.pick.valueWhole, m.pick.label, m.pick.title], [true, "All projects", true, "Project Folder: All projects", "Project Folder: All projects"], "alone on its line it has room for its word, at 300 px too");
      assert.equal(m.standIn, 0, "no stand-in heading line");
      // The heading comes under it: words and the count, at the left, no button and no mark.
      assert.ok(m.heading, "Needs attention is drawn");
      assert.deepEqual([m.heading.tag, m.heading.words, m.heading.button, m.heading.marks, m.heading.drawn], ["H2", "Needs attention 1", false, 0, "none,none,none,none"], "a heading in words, with no chevron anywhere on its line");
      assert.ok(m.heading.underPick >= 6, `under the dropdown's line, clear of it: ${m.heading.underPick}`);
      assert.ok(Math.abs(m.heading.left) <= 0.5 && m.heading.countAfterWords >= 0 && m.heading.countAfterWords <= 12, `the heading and its count at the left: ${JSON.stringify(m.heading)}`);
      // The fold: a quiet word at the line's right end.
      assert.deepEqual([m.fold.tag, m.fold.type, m.fold.words, m.fold.label, m.fold.expanded, m.fold.controls, m.fold.list, m.fold.cards],
        ["BUTTON", "button", "Hide", "Hide the cards that need your attention", "true", "attention-list", true, 1]);
      assert.ok(m.fold.right >= -0.5 && m.fold.right <= 0.5 && m.fold.sameLine <= 1.5 && m.fold.afterTitle >= 6, `at the right end of the heading's line: ${JSON.stringify(m.fold)}`);
      assert.deepEqual([m.fold.colour, m.fold.weight, m.fold.ground, m.fold.border], [true, "400", "rgba(0, 0, 0, 0)", "0px"], "quiet: the muted text colour, no fill, no border");
      assert.equal(m.sideways, false);
      assert.deepEqual(low(await pipsContrast(x.page)), []);
      // Its menu opens from the button, from the left, and stays inside the view.
      await x.inPips((root) => root.querySelector("#pips-folder-pick").click());
      await until(x, (root) => !!root.querySelector(".dgc-folder-menu"));
      await x.page.waitForTimeout(350);
      const menu = await x.inPips((root) => { const m = root.querySelector(".dgc-folder-menu").getBoundingClientRect(), p = root.querySelector("#pips-folder-pick").getBoundingClientRect();
        return { fits: m.left >= 0 && m.right <= innerWidth + 0.5 && m.bottom <= innerHeight + 0.5, fromLeft: Math.abs(m.left - p.left), under: m.top - p.bottom, reaches: m.right - p.right, rows: root.querySelectorAll(".dgc-folder-menu [data-folder]").length }; });
      assert.ok(menu.fits && menu.fromLeft <= 1.5 && menu.reaches >= -0.5 && Math.abs(menu.under) <= 2.5 && menu.rows === 5, `one shape with the button, from its left edge, as wide or wider: ${JSON.stringify(menu)}`);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
    // This window's folder: nothing of it waits. The dropdown has not moved, and there is no heading and no stand-in for one.
    x = await openPips(browser, { theme, width, where, choice: HERE });
    try {
      const alone = await read(x);
      assert.deepEqual([alone.heading, alone.fold, alone.standIn], [null, null, 0], "nothing needs attention: no heading, no line standing in for it");
      assert.deepEqual([alone.pick.first, alone.pick.ownLine], [true, true]);
      assert.ok(Math.abs(alone.pick.top - withCards.pick.top) <= 0.5 && Math.abs(alone.pick.left) <= 0.5, `at the same place: ${alone.pick.top} against ${withCards.pick.top}`);
      assert.deepEqual([alone.pick.word, alone.pick.value, alone.pick.valueWhole, alone.pick.title], [true, "shop", true, `Project Folder: shop\n${HERE}`]);
      assert.ok(alone.pick.nextUnder >= 6, `the list comes under the line: ${alone.pick.nextUnder}`);
      assert.deepEqual(alone.rows.slice(0, 2), ["Checkout reviewer", "Docs keeper"], "that folder's Pips");
      assert.deepEqual(low(await pipsContrast(x.page)), []);
      // A folder whose Pip waits: the heading comes in under the dropdown, which stays where it was.
      await choose(x, GARDEN, "garden");
      await until(x, (root) => !!root.querySelector("#attention-toggle"));
      const garden = await read(x);
      assert.ok(garden.heading && Math.abs(garden.pick.top - alone.pick.top) <= 0.5 && Math.abs(garden.pick.left) <= 0.5 && garden.heading.underPick >= 6, `it never moves as cards come and go: ${JSON.stringify(garden.pick)}`);
      // A long path, nothing waiting: the word goes before the name is ever cut, and the line never wraps or scrolls.
      await choose(x, LONG, "checkout-service");
      const long = await read(x);
      assert.ok(long.pick.valueWhole || !long.pick.word, "the name is never cut while the word still shows");
      assert.deepEqual([long.pick.valueWhole, long.pick.title, long.sideways, long.standIn], [true, `Project Folder: checkout-service\n${LONG}`, false, 0]);
      assert.ok(Math.abs(long.pick.top - alone.pick.top) <= 0.5 && Math.abs(long.pick.left) <= 0.5 && long.pick.right >= -0.5 && long.pick.height <= 30, JSON.stringify(long.pick));
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

for (const where of ["side", "tab"]) for (const [theme, width] of [["dark-modern", 300], ["light-modern", 700]]) {
  test(`Needs attention: the Hide / Show word folds and unfolds, by the pointer and by the keyboard, and the keyboard stays on it (${where}, ${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openPips(browser, { theme, width, where });
    try {
      const said = (v) => until(x, (root, v) => root.querySelector("#attention-toggle")?.getAttribute("aria-expanded") === v, v);
      const before = await read(x);
      // The pointer.
      await x.page.mouse.move(2, 2);
      await x.inPips((root) => root.querySelector("#attention-toggle").click()); await said("false"); await settle(x.page);
      let m = await read(x);
      assert.deepEqual([m.fold.words, m.fold.label, m.fold.expanded, m.fold.controls, m.fold.list, m.fold.cards], ["Show", "Show the cards that need your attention", "false", "attention-list", false, 0], "folded: the word says Show");
      assert.deepEqual([m.heading.words, m.heading.marks, m.heading.drawn], ["Needs attention 1", 0, "none,none,none,none"], "the heading and its count stay, with no mark");
      assert.ok(m.fold.right >= -0.5 && m.fold.right <= 0.5 && m.fold.sameLine <= 1.5 && m.fold.colour, `the word is where it was: ${JSON.stringify(m.fold)}`);
      assert.ok(Math.abs(m.pick.top - before.pick.top) <= 0.5 && Math.abs(m.pick.left) <= 0.5, "the dropdown has not moved");
      assert.deepEqual(low(await pipsContrast(x.page)), []);
      await x.inPips((root) => root.querySelector("#attention-toggle").click()); await said("true"); await settle(x.page);
      m = await read(x);
      assert.deepEqual([m.fold.words, m.fold.label, m.fold.list, m.fold.cards], ["Hide", "Hide the cards that need your attention", true, 1]);
      // The keyboard: Tab reaches it after the dropdown; Enter folds, Space opens, and each leaves the focus on it, ring showing.
      await x.inPips((root) => root.querySelector("#pips-folder-pick").focus());
      await x.page.keyboard.press("Tab");
      assert.equal((await focusAt(x))?.id, "attention-toggle", "the next stop after the dropdown is the fold");
      await x.page.keyboard.press("Enter"); await said("false"); await settle(x.page);
      assert.deepEqual(await focusAt(x), { id: "attention-toggle", expanded: "false", ring: true }, "Enter folds; the keyboard is still on the fold, which says its new state");
      await x.page.keyboard.press("Space"); await said("true"); await settle(x.page);
      assert.deepEqual(await focusAt(x), { id: "attention-toggle", expanded: "true", ring: true }, "Space opens it again, focus kept");
      assert.equal((await read(x)).fold.cards, 1);
      // Under the pointer the word answers as the other quiet words do: the text colour, underlined.
      const box = await x.inPips((root) => { const b = root.querySelector("#attention-toggle").getBoundingClientRect(); return { x: b.left + b.width / 2 + 2, y: b.top + b.height / 2 }; });
      await x.page.mouse.move(box.x, box.y); await settle(x.page);
      const hover = await x.inPips((root) => { const s = getComputedStyle(root.querySelector("#attention-toggle")), probe = document.createElement("span"); probe.style.color = "var(--vscode-foreground)"; root.querySelector("#pips-tabpanel").append(probe);
        const text = getComputedStyle(probe).color; probe.remove(); return [s.color === text, s.textDecorationLine, s.backgroundColor]; });
      assert.deepEqual(hover, [true, "underline", "rgba(0, 0, 0, 0)"]);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

for (const theme of ["dark-modern", "light-modern"]) for (const width of [700, 300]) {
  test(`the Personal tab: no dropdown; its heading has no chevron and the same Hide word (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openPips(browser, { theme, width, tab: "personal" });
    try {
      const m = await read(x);
      assert.equal(m.pick, null, "Personal Pips are never filtered");
      assert.deepEqual([m.heading.tag, m.heading.words, m.heading.button, m.heading.marks, m.heading.drawn], ["H2", "Needs attention 1", false, 0, "none,none,none,none"]);
      assert.deepEqual([m.fold.words, m.fold.label, m.fold.expanded, m.fold.colour], ["Hide", "Hide the cards that need your attention", "true", true]);
      assert.ok(m.fold.right >= -0.5 && m.fold.right <= 0.5 && m.fold.sameLine <= 1.5, JSON.stringify(m.fold));
      assert.deepEqual(m.cardTitles, ["Send this morning's brief to the team?"]);
      assert.deepEqual(low(await pipsContrast(x.page)), []);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

for (const where of ["side", "tab"]) {
  test(`the cards follow the dropdown: All projects, one folder, and a folder with no Pips yet, which has none whatever DGC answers (${where})`, async (t) => {
    if (skipOrFail(t)) return;
    // (stray: this window's project has a card too, and the DGC answers a request naming no project with that project's cards.)
    const x = await openPips(browser, { theme: "dark-modern", width: 300, where, stray: true });
    try {
      const asked = () => x.page.evaluate(() => window.__requests.filter((r) => r.type === "list_pip_attention").at(-1).projects ?? null);
      const cards = async () => { const seen = []; const m = await read(x); if (!m.fold) return { m, seen };
        const n = Number(m.heading.count); for (let i = 0; i < n; i++) { seen.push((await read(x)).cardTitles[0]); if (i < n - 1) { await x.inPips((root) => root.querySelector("#attention-next").click()); await settle(x.page); } }
        return { m, seen: seen.sort() }; };
      let c = await cards();
      assert.equal(await asked(), "all");
      assert.deepEqual([c.m.heading.words, c.m.tabCount, c.seen], ["Needs attention 2", "2", ["Email the planting plan to the allotment group?", "Send the checkout review to the shop team?"]], "All projects: every project's cards");
      assert.ok(c.m.fold.viewAll >= 0, "View all, then the fold's word at the very end");
      await choose(x, GARDEN, "garden"); await until(x, (root) => root.querySelector(".attention-count")?.textContent === "1");
      c = await cards();
      assert.deepEqual([c.m.heading.words, c.m.tabCount, c.seen, c.m.rows], ["Needs attention 1", "1", ["Email the planting plan to the allotment group?"], ["Bed planner"]], "one folder: its own card, its own Pips");
      await choose(x, HERE, "shop"); await until(x, (root) => /checkout review/.test(root.querySelector(".attention-list")?.textContent || ""));
      c = await cards();
      assert.deepEqual([c.m.heading.words, c.m.tabCount, c.seen], ["Needs attention 1", "1", ["Send the checkout review to the shop team?"]]);
      // A folder with no Pips workspace: this DGC answers with this window's project's card. None of it shows here.
      await choose(x, NOTES, "notes"); await x.page.waitForTimeout(250); await settle(x.page);
      c = await cards();
      assert.equal(await asked(), null, "nothing is asked for a folder that is no project yet");
      assert.deepEqual([c.m.heading, c.m.fold, c.m.tabCount, c.seen, c.m.empty], [null, null, "", [], "No Project Pips in notes yet."], "no project cards, no number on the tab");
      assert.deepEqual([c.m.pick.first, c.m.pick.value, Math.abs(c.m.pick.left) <= 0.5], [true, "notes", true], "the dropdown is where it was");
      // The Personal tab's own card and number are untouched by any of it.
      await x.inPips((root) => root.querySelector("#pips-tab-personal").click());
      await until(x, (root) => root.querySelector("#pips-tab-personal")?.getAttribute("aria-selected") === "true" && !!root.querySelector("#attention-toggle"));
      const personal = await read(x);
      assert.deepEqual([personal.heading.words, personal.cardTitles, personal.tabCount], ["Needs attention 1", ["Send this morning's brief to the team?"], ""]);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}
