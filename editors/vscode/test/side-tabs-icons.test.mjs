// A narrow side bar shows its tabs as icons (src/panel.ts, media/shared/tabs.css), measured in real Chromium on the
// side bar's real page (support/dock-scene.mjs). What is held here:
//   - from 280 px up the five tabs are words: Home, Work, Chat, Library, Pips (700 and 300 px), and no icon is drawn
//     (240 px with four tabs; Library, the fifth since 15 Nov, needs the room)
//   - under 280 px each tab is an icon alone: a house, a briefcase, two speech bubbles, the Core Pip's face on Pips, books
//   - the switch is on the tab bar's own width (a container query), a little before the words would be cut
//   - nothing is cut at any width from 170 px (the narrowest side bar) to 700 px, with one waiting thing or with "99+"
//   - each icon tab keeps its name for a screen reader (the word is still there, unseen) and its tooltip
//   - Home's number stays a number, small, on its icon's upper right corner, never near Work's icon
//   - the bar is the same height in both forms, so the room the page keeps under the glass (--glass-top) is the same,
//     and nothing moves up or down across the switch; the tab you are on is still lit
//   - pointing at an icon only changes its colour (13 Nov: it lit and turned over); Left, Right, Home and End work as before
//   - forced colours: the icons are in the system's colours, the tab you are on in Highlight
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openDock } from "./support/dock-scene.mjs";

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

/** The first width that shows words; one pixel less shows icons. */
const WORDS_FROM = 280;      // (240 with four tabs; 280 with Library, the fifth; 292 while Library wore his books before its word; 280 again now it does not. Measured: the names fit from 258.)
// (Decided 15 Nov, later the same day: "the header tabs don't need to show icon for library, only Pips tab shows
// Core's face, not any other tab." Library is a word like Home, Work and Chat, and in icon mode a plain line icon of
// their family, the codicon "library": never his coloured Iris books, which stay on Home's Library button and the
// editor Library panel's tab: library-iris-browser.test.mjs.)
const ICONS = { home: "codicon-home", work: "codicon-briefcase", chat: "codicon-comment-discussion", library: "codicon-library" };
const IDS = ["home", "work", "chat", "library", "pips"], WORDS = ["Home", "Work", "Chat", "Library", "Pips"];
const settle = (page, ms = 60) => page.evaluate((wait) => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, wait)))), ms);
const centre = (r) => [r.left + r.width / 2, r.top + r.height / 2];
const by = (bar, id) => bar.tabs.find((t) => t.id === id);

/** The tab bar as it is drawn: for each tab its box, its word (seen or not), its icon when one is drawn, its face, its number. */
const barNow = (page) => page.evaluate(() => {
  const rect = (n) => { const r = n.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
  const nav = document.getElementById("side-tabs"), bar = nav.querySelector(".dgc-tabs-bar");
  const drawn = (n) => !!n && n.checkVisibility({ visibilityProperty: true, opacityProperty: true }) && n.getBoundingClientRect().width > 1.5 && n.getBoundingClientRect().height > 1.5;
  const tabs = [...nav.querySelectorAll('[role="tab"]')].filter((t) => t.checkVisibility()).map((t) => {
    const front = t.querySelector(".dgc-tab-front"), flip = t.querySelector(".dgc-tab-flip");
    const word = front.querySelector(".dgc-tab-word") || front, icon = front.querySelector(".codicon, .library-iris"), coloured = t.querySelectorAll(".library-iris, svg, img").length;
    const face = t.querySelector(".dgc-tab-face"), count = t.querySelector(".dgc-tab-count"), glyph = icon ? getComputedStyle(icon, "::before") : null;
    return { id: t.dataset.tab, box: rect(t), selected: t.getAttribute("aria-selected") === "true", tabIndex: t.tabIndex, title: t.getAttribute("title") || "", label: t.getAttribute("aria-label") || "",
      color: getComputedStyle(t).color, ground: getComputedStyle(t).backgroundColor, glow: ((g) => g ? Number(getComputedStyle(g).opacity) : 0)(t.querySelector(".dgc-tab-glow")),
      // The word: its text is always in the page; it is "seen" when it has a box of its own to be read in.
      word: { text: word.textContent, seen: drawn(word), ...rect(word), inTree: word.checkVisibility() && getComputedStyle(word).visibility === "visible" && !word.closest('[aria-hidden="true"]'),
        fontSize: parseFloat(getComputedStyle(word).fontSize) },
      flip: rect(flip),
      icon: icon ? { seen: drawn(icon), cls: [...icon.classList].filter((c) => c.startsWith("codicon-") || c === "library-iris").join(" "), hidden: icon.getAttribute("aria-hidden"), ...rect(icon),
        font: getComputedStyle(icon).fontFamily, glyph: glyph.content, color: getComputedStyle(icon).color, opacity: Number(getComputedStyle(front).opacity), turn: getComputedStyle(front).transform } : null,
      copies: t.querySelectorAll(".codicon").length, coloured,
      face: face && drawn(face) && face.querySelector(".dgc-plush") ? rect(face) : null,
      count: count && !count.hidden ? { text: count.textContent, ...rect(count), fontSize: parseFloat(getComputedStyle(count).fontSize), color: getComputedStyle(count).color, ground: getComputedStyle(count).backgroundColor,
        textFits: count.scrollWidth <= count.clientWidth + 0.5 } : null };
  });
  return { nav: rect(nav), bar: rect(bar), border: getComputedStyle(bar).borderTopWidth, tabs, width: innerWidth, overflowX: document.documentElement.scrollWidth > innerWidth,
    glassTop: getComputedStyle(document.documentElement).getPropertyValue("--glass-top").trim(), focus: document.activeElement?.dataset?.tab || "" };
});
/** "words" when every tab shows its word and no icon; "icons" when no word is seen and Home, Work and Chat show an icon; else what is wrong. */
const form = (bar) => {
  const words = bar.tabs.every((t) => t.word.seen && !(t.icon && t.icon.seen)), icons = bar.tabs.every((t) => !t.word.seen && (t.id === "pips" ? !!t.face : !!t.icon?.seen));
  return words ? "words" : icons ? "icons" : `mixed (${bar.tabs.map((t) => `${t.id}: word ${t.word.seen}, icon ${!!t.icon?.seen}`).join("; ")})`;
};
/** Everything that is cut, or touches its neighbour, in the bar as drawn. [] when all is well. slack: how far, in px, a
 *  tab's word or number may reach past its own tab's edge (never past the bar's, which is what cuts). */
function cuts(bar, slack = 0.5) {
  const out = [], inside = (a, b) => a.left >= b.left - slack && a.right <= b.right + slack && a.top >= b.top - slack && a.bottom <= b.bottom + slack;
  if (bar.overflowX) out.push("the page scrolls sideways");
  if (bar.bar.left < 0 || bar.bar.right > bar.width) out.push(`the bar leaves the side bar (${bar.bar.left} to ${bar.bar.right} of ${bar.width})`);
  const shown = [];
  for (const t of bar.tabs) {
    if (!inside(t.box, bar.bar)) out.push(`${t.id}: the tab leaves the bar`);
    const parts = [];
    if (t.word.seen) parts.push(["word", t.flip]);
    if (t.icon?.seen) parts.push(["icon", t.icon]);
    if (t.face) parts.push(["face", t.face]);
    if (t.count) parts.push(["number", t.count]);
    if (!t.word.seen && !t.icon?.seen && !t.face) out.push(`${t.id}: the tab shows nothing`);
    // (On an icon, Home's number may reach past its tab towards Work: it is held to the bar, and to Work's icon, below.)
    for (const [what, r] of parts) if (!inside(r, what === "number" && !t.word.seen ? { ...bar.bar, left: t.box.left, top: t.box.top, bottom: t.box.bottom } : t.box)) out.push(`${t.id}: its ${what} is cut (${r.left.toFixed(1)} to ${r.right.toFixed(1)} in ${t.box.left.toFixed(1)} to ${t.box.right.toFixed(1)})`);
    if (t.count && !t.count.textFits) out.push(`${t.id}: its number's text is cut`);
    // What a tab shows, from its left edge to its right one (Home's number is to the right of its word or icon).
    const main = parts.filter(([what]) => what !== "number").map(([, r]) => r);
    if (main.length) shown.push({ id: t.id, left: Math.min(...main.map((r) => r.left)), right: Math.max(...[...main, ...(t.count ? [t.count] : [])].map((r) => r.right)) });
  }
  for (let i = 1; i < shown.length; i++) if (shown[i].left < shown[i - 1].right + 3) out.push(`${shown[i].id} touches ${shown[i - 1].id} (${shown[i - 1].right.toFixed(1)} then ${shown[i].left.toFixed(1)})`);
  return out;
}
const sized = async (x, width, height = 600) => { await x.page.setViewportSize({ width, height }); await settle(x.page, 30); };

for (const width of [700, 300]) {
  test(`${width}px: the tabs are words, as before, and no icon is drawn`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openDock(browser, { tab: "home", width, height: 600 });
    try {
      const bar = await barNow(x.page);
      assert.equal(form(bar), "words");
      assert.deepEqual(bar.tabs.map((tab) => tab.word.text), WORDS);
      assert.deepEqual(bar.tabs.map((tab) => !!tab.icon?.seen), [false, false, false, false, false], "no icon beside any word: Library is the word alone");
      assert.deepEqual(bar.tabs.filter((tab) => tab.id !== "pips").map((tab) => tab.coloured), [0, 0, 0, 0], "and none of them holds a coloured mark or a picture (his Iris books are not on the tab); the Pip's face is the one exception, below");
      assert.ok(by(bar, "pips").face, "Pips still wears the Core Pip's face beside its word");
      assert.ok(by(bar, "home").count && by(bar, "home").count.left >= by(bar, "home").flip.right, "Home's number is beside its word");
      assert.deepEqual(cuts(bar), []);
      // The icons are in the page, ready for a narrow side bar, and hidden from a screen reader.
      assert.deepEqual(bar.tabs.map((tab) => tab.icon?.cls || ""), [ICONS.home, ICONS.work, ICONS.chat, ICONS.library, ""], "Home, Work, Chat and Library each hold their icon; Pips has its face");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

for (const width of [279, 200, 170]) {
  test(`${width}px, a narrow side bar: each tab is an icon alone: a house, a briefcase, speech bubbles, Core's face, and books`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openDock(browser, { tab: "home", width, height: 600 });
    try {
      const bar = await barNow(x.page);
      assert.equal(form(bar), "icons");
      for (const id of ["home", "work", "chat", "library"]) {
        const tab = by(bar, id), icon = tab.icon;
        assert.equal(icon.cls, ICONS[id], `${id}: its icon`);
        assert.equal(icon.hidden, "true", `${id}: the icon is decoration`);
        assert.match(icon.font, /codicon/, `${id}: drawn with the editor's icon font`);
        assert.ok(icon.glyph && icon.glyph !== "none" && icon.glyph !== "normal", `${id}: the icon has its glyph (${icon.glyph})`);
        assert.equal(tab.coloured, 0, `${id}: a plain line icon, no coloured mark or picture`);
        assert.ok(Math.abs(icon.width - 16) <= 0.6 && Math.abs(icon.height - 16) <= 0.6, `${id}: 16 px (${icon.width} x ${icon.height})`);
        assert.ok(Math.abs(centre(icon)[0] - centre(tab.box)[0]) <= 1 && Math.abs(centre(icon)[1] - centre(tab.box)[1]) <= 1, `${id}: in the middle of its tab`);
        assert.equal(icon.opacity, 1, `${id}: facing you`);
        assert.equal(tab.face, null, `${id}: no face`);
      }
      // Library's is one of the family: the size and the colour of Work's and Chat's (Home is the tab you are on, lit).
      assert.equal(by(bar, "library").icon.color, by(bar, "work").icon.color, "Library's icon is the colour of Work's");
      assert.equal(by(bar, "library").icon.color, by(bar, "chat").icon.color, "and of Chat's");
      assert.deepEqual([by(bar, "library").icon.width, by(bar, "library").icon.height], [by(bar, "work").icon.width, by(bar, "work").icon.height], "and their size");
      const pips = by(bar, "pips");
      assert.ok(pips.face && !pips.icon, "Pips is Core's face, no other icon");
      assert.ok(Math.abs(pips.face.width - 16) <= 0.6 && Math.abs(pips.face.height - 16) <= 0.6, `the face is the icons' size (${pips.face.width})`);
      assert.ok(Math.abs(centre(pips.face)[0] - centre(pips.box)[0]) <= 1 && Math.abs(centre(pips.face)[1] - centre(pips.box)[1]) <= 1, "in the middle of its tab");
      const widths = bar.tabs.map((tab) => Math.round(tab.box.width));
      assert.ok(Math.max(...widths) - Math.min(...widths) <= 1, `the five tabs are one width (${widths})`);
      assert.ok(Math.abs((bar.bar.left + bar.bar.right) / 2 - width / 2) < 0.6, "the bar is centred");
      assert.deepEqual(cuts(bar), []);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("the switch is on the tab bar's own width, not the window's", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { tab: "home", width: 700, height: 600 });
  try {
    assert.equal(form(await barNow(x.page)), "words");
    // The window stays 700 px wide; only the tab bar's own box is made narrow.
    await x.page.evaluate(() => { document.getElementById("side-tabs").style.width = "220px"; });
    await settle(x.page);
    assert.equal(form(await barNow(x.page)), "icons", "a 220 px tab bar in a 700 px window shows icons");
    await x.page.evaluate(() => { document.getElementById("side-tabs").style.width = ""; });
    await settle(x.page);
    assert.equal(form(await barNow(x.page)), "words");
  } finally { await x.close(); }
});

test("170 to 700 px, every pixel: nothing is cut, words from 280 px up and icons under it, with one digit and with \"99+\"", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { tab: "home", width: 700, height: 600 });
  try {
    const wrong = [];
    for (const number of ["", "12", "99+"]) {
      // ("" is the number the page itself shows: one digit.)
      if (number) await x.page.evaluate((text) => { document.getElementById("side-tab-home-count").textContent = text; }, number);
      for (let width = 700; width >= 170; width--) {
        await x.page.setViewportSize({ width, height: 600 });
        const bar = await barNow(x.page), want = width >= WORDS_FROM ? "words" : "icons";
        if (form(bar) !== want) wrong.push(`${width}px (${number || "one digit"}): ${form(bar)}, not ${want}`);
        // ("99+" in a word tab reaches 1.1 px past Home's own tab from 300 to 304 px, into the bar's 3 px of padding,
        // as it did before the icons: it is whole, inside the bar, and 3 px or more from Work.)
        for (const cut of cuts(bar, number === "99+" && want === "words" ? 1.5 : 0.5)) wrong.push(`${width}px (${number || "one digit"}): ${cut}`);
        if (wrong.length > 12) break;
      }
    }
    assert.deepEqual(wrong, []);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("an icon tab keeps its name for a screen reader and its tooltip: Home, Work, Chat, Library, Pips", async (t) => {
  if (skipOrFail(t)) return;
  for (const width of [700, 200]) {
    const x = await openDock(browser, { tab: "home", width, height: 600 });
    try {
      const bar = await barNow(x.page);
      assert.equal(form(bar), width === 700 ? "words" : "icons");
      // The words are in the page in both forms, and nothing hides them from a screen reader.
      assert.deepEqual(bar.tabs.map((tab) => [tab.word.text, tab.word.inTree]), WORDS.map((w) => [w, true]), `${width}px: each word is in the page`);
      // What Chromium itself tells a screen reader: its accessibility tree.
      const cdp = await x.page.context().newCDPSession(x.page);
      await cdp.send("Accessibility.enable");
      const { nodes } = await cdp.send("Accessibility.getFullAXTree");
      const heard = nodes.filter((n) => n.role?.value === "tab" && !n.ignored).map((n) => n.name?.value);
      assert.equal(heard.length, 5, `${width}px: five tabs are heard (${heard})`);
      assert.match(heard[0], /^Home: (\d+ needs? you(, \d+ new)?|\d+ new)$/, `${width}px: Home, with what waits and what is new`);
      assert.deepEqual(heard.slice(1), ["Work", "Chat", "Library", "Pips"], `${width}px: the names a screen reader hears`);
      for (const name of ["Work", "Chat", "Pips", "Library"]) assert.equal(await x.page.getByRole("tab", { name, exact: true }).count(), 1, `${width}px: one tab named ${name}`);
      // The tooltip begins with the tab's name.
      assert.deepEqual(bar.tabs.map((tab) => tab.title.split(":")[0]), WORDS, `${width}px: each tooltip names its tab`);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  }
});

test("Home's number stays a number, small, on its icon's upper right corner", async (t) => {
  if (skipOrFail(t)) return;
  for (const width of [279, 200, 170]) {
    const x = await openDock(browser, { tab: "home", width, height: 600 });
    try {
      for (const number of ["", "12", "99+"]) {
        if (number) { await x.page.evaluate((text) => { document.getElementById("side-tab-home-count").textContent = text; }, number); await settle(x.page, 20); }
        const bar = await barNow(x.page), home = by(bar, "home"), n = home.count, icon = home.icon, at = `${width}px, ${number || "one digit"}`;
        assert.ok(icon?.seen, `${at}: Home is an icon`);
        assert.ok(n, `${at}: Home shows its number`);
        assert.match(n.text, number ? new RegExp(`^${number.replace("+", "\\+")}$`) : /^\d$/, `${at}: a number, not a dot`);
        assert.ok(n.fontSize >= 9 && n.height >= 12 && n.height <= 15 && n.width >= 12, `${at}: small and readable (${n.width} x ${n.height}, ${n.fontSize}px)`);
        assert.ok(n.textFits, `${at}: its text is whole`);
        // On the corner: it overlaps the icon's upper right, its middle up and to the right of the icon's middle.
        assert.ok(centre(n)[0] > centre(icon)[0] && centre(n)[1] < centre(icon)[1], `${at}: up and to the right of the icon's middle`);
        assert.ok(n.left < icon.right && n.right > icon.right - 1 && n.bottom > icon.top && n.top < icon.top, `${at}: on the icon's corner (${JSON.stringify([n.left, n.right, n.top, n.bottom])} on ${JSON.stringify([icon.left, icon.right, icon.top, icon.bottom])})`);
        // It grows to the right: a long number may pass the edge of Home's tab, and never comes near Work's icon.
        assert.ok(n.left >= home.box.left && n.top >= home.box.top - 0.5 && n.bottom <= home.box.bottom, `${at}: inside Home's tab, top and left`);
        assert.ok(n.right <= by(bar, "work").icon.left - 3, `${at}: 3 px or more before Work's icon (${n.right} then ${by(bar, "work").icon.left})`);
        if (n.text.length === 1) assert.ok(n.right <= home.box.right + 0.5, `${at}: one digit is inside Home's tab`);
        assert.deepEqual(await x.page.evaluate(() => { const c = document.getElementById("side-tab-home-count").getBoundingClientRect(), top = document.elementFromPoint(c.right - 2, c.top + c.height / 2); return top?.id || top?.className; }), "side-tab-home-count", `${at}: nothing lies over it`);
        // The icon stays where it is with a number on it: in the middle of its tab.
        assert.ok(Math.abs(centre(icon)[0] - centre(home.box)[0]) <= 1, `${at}: the icon is still in the middle`);
        // The text colour on the page's ground, never the accent (as when wide).
        assert.notEqual(n.ground, "rgba(0, 0, 0, 0)", `${at}: a filled badge`);
      }
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  }
  // Nothing waits: no number, and the icon alone.
  const quiet = await openDock(browser, { tab: "home", width: 200, height: 600, state: (await import("./support/home-scene.mjs")).homeState("quiet"), sessions: [], pins: [] });
  try {
    const bar = await barNow(quiet.page);
    assert.equal(form(bar), "icons");
    assert.equal(by(bar, "home").count, null, "nothing waits: no number");
  } finally { await quiet.close(); }
});

test("the bar is the same height in both forms, the page keeps the same room under it, and nothing moves at the switch", async (t) => {
  if (skipOrFail(t)) return;
  for (const view of ["home", "pips"]) {
    const x = await openDock(browser, { tab: view, width: 700, height: 600 });
    try {
      const seen = [];
      for (const width of [700, 300, WORDS_FROM, WORDS_FROM - 1, 200, 170, WORDS_FROM - 1, WORDS_FROM]) {
        await sized(x, width); await settle(x.page, 80);
        const bar = await barNow(x.page);
        seen.push({ width, form: form(bar), nav: bar.nav.height, navTop: bar.nav.top, bar: bar.bar.height, barTop: bar.bar.top, tabs: [...new Set(bar.tabs.map((tab) => tab.box.height))], tabTop: [...new Set(bar.tabs.map((tab) => tab.box.top))], glass: bar.glassTop,
          lit: bar.tabs.filter((tab) => tab.glow > 0 || tab.ground !== "rgba(0, 0, 0, 0)").map((tab) => tab.id), chosen: bar.tabs.filter((tab) => tab.selected).map((tab) => tab.id) });
      }
      assert.deepEqual(seen.map((s) => s.form), ["words", "words", "words", "icons", "icons", "icons", "icons", "words"], `${view}: the forms`);
      const first = seen[0];
      assert.ok(first.nav > 30 && first.bar === 36 && first.tabs.length === 1 && first.tabs[0] === 30, `${view}: a 36 px bar of 30 px tabs (${first.bar}, ${first.tabs})`);
      for (const s of seen) {
        const at = `${view}, ${s.width}px (${s.form})`;
        assert.equal(s.nav, first.nav, `${at}: the tab bar's strip is the same height`);
        assert.equal(s.bar, first.bar, `${at}: the bar is the same height`);
        assert.deepEqual(s.tabs, first.tabs, `${at}: every tab is the same height`);
        assert.deepEqual([s.navTop, s.barTop, s.tabTop], [first.navTop, first.barTop, first.tabTop], `${at}: nothing moved up or down`);
        // The room the page keeps under the glass is the strip's own height, as measured by the page (glassRoom).
        assert.equal(s.glass, `${Math.round(first.nav * 100) / 100}px`, `${at}: the page keeps the same room under the glass`);
        assert.deepEqual([s.chosen, s.lit], [[view], []], `${at}: the tab you are on is still chosen, with nothing behind any tab (18 Nov)`);
      }
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  }
});

test("an icon tab: the one you are on has its icon in the accent and nothing behind it (18 Nov); pointing at another only changes its icon's colour (no glow, no turn: 13 Nov)", async (t) => {
  if (skipOrFail(t)) return;
  for (const theme of ["dark-modern", "light-modern"]) {
    const x = await openDock(browser, { tab: "home", theme, width: 200, height: 500 });
    try {
      const tone = (token) => x.page.evaluate((name) => { const probe = document.createElement("span"); probe.style.color = `var(${name})`; document.body.append(probe); const c = getComputedStyle(probe).color; probe.remove(); return c; }, token);
      const accent = await tone("--accent-text"), quiet = await tone("--text-2"), text = await tone("--text");
      let bar = await barNow(x.page);
      assert.equal(form(bar), "icons");
      assert.deepEqual([by(bar, "home").icon.color, by(bar, "home").glow, by(bar, "home").ground], [accent, 0, "rgba(0, 0, 0, 0)"], `${theme}: Home's icon is in the accent's text tone, with nothing behind it`);
      for (const id of ["work", "chat"]) assert.deepEqual([by(bar, id).icon.color, by(bar, id).glow, by(bar, id).icon.opacity, by(bar, id).copies], [quiet, 0, 1, 1], `${theme}: ${id} is quiet at rest, its icon in it once`);
      for (const id of ["work", "chat"]) {
        await x.page.mouse.move(...centre(by(bar, id).box), { steps: 3 });
        await x.page.waitForTimeout(900);
        const now = by(await barNow(x.page), id);
        assert.equal(now.icon.color, text, `${theme}: ${id} pointed at is in the text colour, not the accent`);
        assert.equal(now.glow, 0, `${theme}: with no glow`);
        assert.deepEqual([now.icon.opacity, now.icon.turn], [1, "none"], `${theme}: and its icon stays as it is`);
        assert.equal(now.selected, false, "pointing chooses nothing");
      }
      // Pips: its face stays, with no glow behind it.
      await x.page.mouse.move(...centre(by(bar, "pips").box), { steps: 3 });
      await x.page.waitForTimeout(900);
      const pips = by(await barNow(x.page), "pips");
      assert.ok(pips.glow === 0 && pips.face, `${theme}: Pips pointed at has its face and no glow (${pips.glow})`);
      await x.page.mouse.move(100, 300); await x.page.waitForTimeout(900);
      bar = await barNow(x.page);
      assert.deepEqual([by(bar, "work").icon.color, by(bar, "work").icon.opacity], [quiet, 1], `${theme}: the pointer gone, it is as it was`);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  }
});

test("icon tabs and the keyboard: Left and Right move and choose, wrapping; Home and End jump; one tab stop", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { tab: "home", width: 200, height: 600 });
  try {
    const chosen = async () => { await settle(x.page, 200); const bar = await barNow(x.page); return [form(bar), bar.tabs.filter((tab) => tab.selected).map((tab) => tab.id).join(), bar.focus, bar.tabs.filter((tab) => tab.tabIndex === 0).map((tab) => tab.id).join()]; };
    await x.page.focus("#side-tab-home");
    assert.deepEqual(await chosen(), ["icons", "home", "home", "home"]);
    await x.page.keyboard.press("ArrowRight");
    assert.deepEqual(await chosen(), ["icons", "work", "work", "work"], "Right: Work");
    await x.page.keyboard.press("ArrowRight");
    assert.deepEqual(await chosen(), ["icons", "chat", "chat", "chat"], "Right: Chat");
    await x.page.keyboard.press("ArrowLeft");
    assert.deepEqual(await chosen(), ["icons", "work", "work", "work"], "Left: Work");
    await x.page.keyboard.press("Home");
    assert.deepEqual(await chosen(), ["icons", "home", "home", "home"], "Home: the first");
    await x.page.keyboard.press("ArrowLeft");
    assert.deepEqual((await chosen()).slice(0, 2), ["icons", "pips"], "Left from the first wraps to Pips, the last");
    await x.page.focus("#side-tab-pips");
    await x.page.keyboard.press("ArrowLeft");
    assert.deepEqual(await chosen(), ["icons", "library", "library", "library"], "then Library");
    await x.page.keyboard.press("ArrowRight");
    assert.deepEqual((await chosen()).slice(0, 2), ["icons", "pips"], "Right of Library is Pips");
    await x.page.focus("#side-tab-pips");
    await x.page.keyboard.press("ArrowRight");
    assert.deepEqual(await chosen(), ["icons", "home", "home", "home"], "Right from the last wraps to Home");
    await x.page.keyboard.press("End");
    assert.deepEqual((await chosen()).slice(0, 2), ["icons", "pips"], "End: the last");
    // A click chooses as before.
    await x.page.click("#side-tab-chat");
    await x.page.mouse.move(100, 400); await x.page.waitForTimeout(700);   // (the pointer away, so the icon faces you again)
    assert.deepEqual((await chosen()).slice(0, 2), ["icons", "chat"], "a click on an icon chooses its tab");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("forced colours: the icons are in the system's colours, the tab you are on in Highlight, the bar the same height in both forms", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { tab: "home", width: 200, height: 600, forced: true });
  try {
    const sys = (name) => x.page.evaluate((c) => { const probe = document.createElement("span"); probe.style.cssText = `forced-color-adjust: none; color: ${c}`; document.body.append(probe); const out = getComputedStyle(probe).color; probe.remove(); return out; }, name);
    const [highlight, highlightText, canvas, canvasText] = [await sys("Highlight"), await sys("HighlightText"), await sys("Canvas"), await sys("CanvasText")];
    const lum = (c) => { const [r, g, b] = c.match(/[\d.]+/g).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
    const narrow = await barNow(x.page);
    assert.equal(form(narrow), "icons");
    assert.deepEqual(cuts(narrow), []);
    const home = by(narrow, "home");
    assert.deepEqual([home.ground, home.icon.color], [highlight, highlightText], "the tab you are on: HighlightText on Highlight");
    for (const id of ["work", "chat"]) {
      const tab = by(narrow, id);
      assert.ok(tab.icon.seen, `${id}: its icon is drawn`);
      assert.ok(ratio(tab.icon.color, canvas) >= 4.5, `${id}: its icon is read on the system's ground (${tab.icon.color} on ${canvas})`);
    }
    assert.ok(by(narrow, "pips").face, "Pips keeps its face");
    assert.deepEqual([home.count.ground, home.count.color], [canvasText, canvas], "Home's number: Canvas on CanvasText");
    assert.equal(narrow.border, "1px", "the bar has a line around it");
    // Both forms, one height.
    await sized(x, 700); await settle(x.page, 80);
    const wide = await barNow(x.page);
    assert.equal(form(wide), "words");
    assert.deepEqual([narrow.nav.height, narrow.bar.height, narrow.glassTop], [wide.nav.height, wide.bar.height, wide.glassTop], "the same height, and the same room under it");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});
