// A Pip's chat header (live round 1, finding 19; his calls of 14 and 15 Nov). LEFT, fixed: back, the Pip's face and its
// name. The Pip's NAME NEVER DISAPPEARS: at every width it is there, and where the line is tight it ends in "…" (the
// whole name is its tooltip, and what a screen reader hears). The thread selector gives way instead: under 560 px it is
// its chevron (with the unread dot on it, if any) right beside the name, the look of a Pip with one conversation
// ("Tile checker ⌄"); from 560 px, where the whole selector fits beside a 14-letter name, it is in the middle, always
// centred, in a capped width, a long conversation name ending in "…". RIGHT: the switch, its computer, ⋯; the switch
// gives way at 240 px and under. Nothing moves when the thread changes.
// Measured on the real page, in real Chromium, in the side bar and in a tab, dark and light.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openChat } from "./support/pip-chat-scene.mjs";

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

const cid = (c) => "conv_" + c.repeat(32);
const GOA = cid("a"), FIRST = cid("f"), MA = cid("d");
const LONG = "Everything we still have to book for the week in Goa in March, with the trains";
const LONG_PIP = "The morning desk that reads every paper and writes the five lines worth knowing.";   // 80 letters
const CAP = 220;     // the selector's most, in px (--thread-cap)
const FULL = 560;    // from this width the whole selector shows, centred; under it, its chevron beside the name
const NAME_ROOM = 96;   // what the name is sure of beside the whole selector: 14 letters ("Nightly review" is 95 px)
const SWITCH_GOES = 240;

/** The header as it is drawn: each part's box, in the root the chat lives in. */
const header = (p) => p.evaluate(() => {
  const root = window.__pipsRoot || document, bar = root.querySelector(".pip-topbar"); if (!bar) return null;
  const r = (n) => { if (!n || !n.checkVisibility()) return null; const b = n.getBoundingClientRect(); return b.width ? { left: Math.round(b.left * 10) / 10, right: Math.round(b.right * 10) / 10, top: Math.round(b.top * 10) / 10, width: Math.round(b.width * 10) / 10, mid: Math.round((b.left + b.right) * 5) / 10 } : null; };
  const pick = bar.querySelector("#pip-convs"), title = bar.querySelector(".pip-conv-title"), name = bar.querySelector(".pip-name"), face = bar.querySelector(".pip-pill .avatar");
  const acts = bar.querySelector(".topbar-actions"), dot = pick?.querySelector(".conv-mark.unread");
  const order = [...bar.querySelectorAll("#simple-back, .pip-pill .avatar, .pip-name, #pip-convs, .topbar-actions [role=switch], .topbar-actions .computer-icon, .topbar-actions .pip-menu > summary")].filter((n) => n.checkVisibility() && n.getBoundingClientRect().width > 0)
    .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left).map((n) => n.id === "simple-back" ? "back" : n.id === "pip-convs" ? "threads" : n.matches(".avatar") ? "face" : n.matches(".pip-name") ? "name" : n.matches("[role=switch]") ? "switch" : n.matches(".computer-icon") ? "computer" : "more");
  const dots = (n) => { const s = getComputedStyle(n); return s.textOverflow === "ellipsis" && s.overflowX !== "visible" && s.whiteSpace === "nowrap"; };
  const drawn = (n) => !!n && n.checkVisibility() && n.getBoundingClientRect().width > 0;
  return { bar: r(bar), back: r(bar.querySelector("#simple-back")), face: r(face), name: r(name), nameText: name?.textContent || "", faceTitle: face?.closest("[title]")?.getAttribute("title") || "",
    nameIs: name ? { drawn: drawn(name), cut: name.scrollWidth > name.clientWidth, dots: dots(name), title: name.getAttribute("title") || "", lines: name.getClientRects().length, hidden: name.closest("[aria-hidden=true]") !== null } : null,
    pick: r(pick), pickLabel: pick?.getAttribute("aria-label") || "", pickTitle: pick?.getAttribute("title") || "",
    title: title ? { text: title.textContent, drawn: drawn(title), cut: title.scrollWidth > title.clientWidth + 1, dots: dots(title), shown: Math.round(title.getBoundingClientRect().width) } : null,
    chevron: r(pick?.querySelector(".pip-convs-chevron")), dot: r(dot),
    sw: r(acts?.querySelector("[role=switch]")), computer: r(acts?.querySelector(".computer-icon")), more: r(acts?.querySelector(".pip-menu > summary")), acts: r(acts), order,
    pad: [parseFloat(getComputedStyle(bar).paddingLeft), parseFloat(getComputedStyle(bar).paddingRight)],
    sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth || bar.scrollWidth > bar.clientWidth + 1 };
});
const open = (o) => openChat(browser, { height: 700, api: 97, convs: true, switches: true, ...o });
// (From 900 px the conversations stand beside the chat as a column: the row is clicked there, and the selector is its name.)
const show = async (p, id, title) => { const column = await p.evaluate(() => !!(window.__pipsRoot || document).querySelector("#conv-column .conv-row")?.checkVisibility());
  if (column) await p.click(`#conv-column [data-conv="${id}"]`); else { await p.click("#pip-convs"); await p.click(`#conv-menu [data-conv="${id}"]`); } await p.waitForFunction(([t]) => ((window.__pipsRoot || document).querySelector(".pip-conv-title")?.textContent || "") === t, [title]); await p.waitForTimeout(120); };
/** One conversation gets another name (as a rename would leave it), before the list is next read. */
const nameIt = (p, id, title = LONG) => p.evaluate(([i, t]) => { window.__convs.list.find((c) => c.id === i).title = t; }, [id, title]);
/** Every other conversation is archived: one is left. */
const leaveOne = async (p) => { await p.evaluate(() => { for (const c of window.__convs.list) if (!c.first) c.archived = true; });
  await p.click("#pip-convs"); await p.waitForSelector("#conv-menu"); await p.keyboard.press("Escape"); await p.waitForTimeout(300); };
/** Under 560 px: the selector is its chevron, right beside the name. */
const chevronBesideName = (h, why) => {
  assert.equal(h.title.drawn, false, `${why}: the conversation's name is not drawn in the bar`);
  assert.ok(h.pick.width >= 16 && h.pick.width <= 30, `${why}: the selector is its chevron (${h.pick.width}px)`);
  assert.ok(h.chevron && h.chevron.left >= h.pick.left && h.chevron.right <= h.pick.right, `${why}: the chevron is drawn in it`);
  assert.ok(h.pick.left >= h.name.right - 0.5 && h.chevron.left - h.name.right <= 12, `${why}: the chevron is right beside the name (${h.chevron.left - h.name.right}px on)`);
};
const noneOnAnother = (h, width, why) => {
  const parts = [h.back, h.face, h.name, h.pick, h.sw, h.computer, h.more].filter(Boolean);
  for (let i = 1; i < parts.length; i++) assert.ok(parts[i].left >= parts[i - 1].right - 0.5, `${why}: part ${i + 1} starts after part ${i} ends: ${parts[i].left} against ${parts[i - 1].right}`);
  assert.ok(h.back.left >= 0 && h.more.right <= width, `${why}: all of it is on the page`);
  assert.equal(h.sideways, false, `${why}: nothing runs off sideways`);
};

const PLACES = [["side", 300], ["side", 440], ["tab", 700], ["tab", 1100]];
for (const theme of ["dark", "light"]) for (const [where, width] of PLACES) {
  test(`back, face and name at the left; the thread selector ${width < FULL ? "as a chevron beside the name" : "in the middle"}; the switch, its computer and ⋯ at the right (${where === "side" ? "side bar" : "tab"}, ${width} px, ${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open({ where, width, theme });
    try {
      await x.p.waitForSelector("#pip-convs"); await x.p.waitForTimeout(250);
      const h = await header(x.p);
      assert.deepEqual(h.order, ["back", "face", "name", "threads", "switch", "computer", "more"], "the order, left to right");
      // The left: against the bar's own edge, back then the face then the name, whole.
      assert.ok(Math.abs(h.back.left - (h.bar.left + h.pad[0])) <= 1, `Back starts the bar: ${h.back.left}`);
      assert.ok(h.face.left - h.back.right <= 14, `the face follows Back (${h.face.left - h.back.right}px on)`);
      assert.equal(h.nameText, "Mornings");
      assert.ok(h.name.left - h.face.right <= 10, `its name follows its face (${JSON.stringify(h.name)})`);
      assert.equal(h.nameIs.cut, false, "a short name is whole");
      // The right: against the bar's other edge.
      assert.ok(Math.abs(h.more.right - (h.bar.right - h.pad[1])) <= 1, `⋯ ends the bar: ${h.more.right} of ${h.bar.right}`);
      // The selector: the conversation shown, by its name, never the Pip's name again.
      assert.equal(h.title.text, "Chat", "the selector names the conversation shown");
      assert.match(h.pickLabel, /^Chat: conversations with Mornings/, "and says so to a screen reader");
      assert.ok(h.pick.left >= h.name.right - 0.5 && h.pick.right <= h.acts.left - 4, "it lies between the two sides, on neither");
      if (width < FULL) chevronBesideName(h, `${width}px`);
      else { const centre = (h.bar.left + h.bar.right) / 2; assert.equal(h.title.drawn, true, "the conversation's name is drawn");
        assert.ok(Math.abs(h.pick.mid - centre) <= 1, `it is centred in the bar: its middle ${h.pick.mid}, the bar's ${centre}`); }
      assert.equal(h.sideways, false, "nothing runs off sideways");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

// His call of 15 Nov. One page, made narrower and wider: the header is read at each width.
const WIDTHS = [170, 200, 220, 240, 241, 260, 300, 340, 380, 440, 559, 560, 620, 700];
for (const [pipName, long] of [["Mornings", false], [LONG_PIP, true]]) for (const one of [false, true]) {
  test(`the Pip's name never disappears: ${long ? "an 80-letter name ends in “…”" : "a short name"}, ${one ? "one conversation" : "several conversations"}, from 170 px to 700 px`, async (t) => {
    if (skipOrFail(t)) return;
    assert.equal(LONG_PIP.length, 80);
    const x = await open({ where: "side", width: 700, pipName });
    try {
      await x.p.waitForSelector("#pip-convs");
      if (one) await leaveOne(x.p);
      for (const width of WIDTHS) {
        await x.p.setViewportSize({ width, height: 700 }); await x.p.waitForTimeout(150);
        const h = await header(x.p), why = `${width}px`;
        assert.ok(h.name && h.nameIs.drawn, `${why}: the name is drawn`);
        assert.equal(h.nameText, pipName, `${why}: the whole name is in the page (what a screen reader hears)`);
        assert.equal(h.nameIs.hidden, false, `${why}: and is not hidden from one`);
        assert.equal(h.nameIs.title, pipName, `${why}: pointed at, it says the whole name`);
        assert.equal(h.nameIs.lines, 1, `${why}: on one line, never broken inside a word`);
        assert.equal(h.nameIs.dots, true, `${why}: a name that does not fit ends in “…”, never cut mid-letter`);
        assert.ok(h.name.width >= (width > 200 ? 36 : 24), `${why}: enough of it to read (${h.name.width}px)`);
        if (long) assert.equal(h.nameIs.cut, true, `${why}: the long name is cut`);
        else if (width >= 300) assert.equal(h.nameIs.cut, false, `${why}: the short name is whole`);
        assert.deepEqual(h.order, ["back", "face", "name", "threads", ...(width > SWITCH_GOES ? ["switch"] : []), "computer", "more"], `${why}: the order, left to right`);
        noneOnAnother(h, width, why);
        if (width < FULL) { chevronBesideName(h, why);
          if (long) assert.ok(h.acts.left - h.pick.right <= 12, `${why}: the long name takes the room there is (${h.acts.left - h.pick.right}px left over)`); }
        else { assert.equal(h.title.drawn, true, `${why}: the whole selector shows`);
          assert.ok(Math.abs(h.pick.mid - (h.bar.left + h.bar.right) / 2) <= 1, `${why}: centred`);
          if (long) assert.ok(h.name.width >= NAME_ROOM, `${why}: beside the whole selector the name keeps ${NAME_ROOM}px (${h.name.width})`); }
      }
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test(`the whole selector shows from ${FULL} px, where it fits beside a 14-letter name; a pixel under, it is the chevron`, async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ where: "side", width: FULL, pipName: "Nightly review" });
  try {
    await x.p.waitForSelector("#pip-convs"); await nameIt(x.p, GOA, "New conversation"); await show(x.p, GOA, "New conversation");
    const full = await header(x.p);
    assert.equal(full.title.drawn, true);
    assert.deepEqual([full.nameIs.cut, full.title.cut], [false, false], "“Nightly review” and “New conversation” are both whole");
    assert.ok(full.dot, "with the dot for something new in another conversation");
    assert.ok(Math.abs(full.pick.mid - (full.bar.left + full.bar.right) / 2) <= 1, "and the selector is centred");
    await x.p.setViewportSize({ width: FULL - 1, height: 700 }); await x.p.waitForTimeout(150);
    const under = await header(x.p);
    chevronBesideName(under, `${FULL - 1}px`);
    assert.equal(under.nameIs.cut, false);
    assert.match(under.pickLabel, /^New conversation: conversations with Nightly review/, "the chevron still says which conversation");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("as a chevron the selector carries the unread dot on itself, and is the same size with it and without", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ where: "side", width: 300 });
  try {
    await x.p.waitForSelector("#pip-convs"); await x.p.waitForTimeout(250);
    const h = await header(x.p);   // (another conversation holds something unread)
    assert.ok(h.dot && h.dot.width >= 6, "the dot is drawn");
    assert.ok(h.dot.left >= h.pick.left - 0.5 && h.dot.right <= h.pick.right + 0.5 && h.dot.top >= h.bar.top, `on the chevron's own button (${JSON.stringify([h.dot, h.pick])})`);
    assert.ok(h.dot.left >= h.chevron.left, "at the chevron's corner, not on the name");
    // Everything is read: the dot goes, and the button is where it was, and as wide.
    await x.p.evaluate(() => { for (const c of window.__convs.list) c.unread = 0; });
    await x.p.click("#pip-convs"); await x.p.waitForSelector("#conv-menu"); await x.p.keyboard.press("Escape"); await x.p.waitForTimeout(300);
    const read = await header(x.p);
    assert.equal(read.dot, null, "nothing new elsewhere: no dot");
    assert.deepEqual([read.pick, read.chevron, read.name], [h.pick, h.chevron, h.name], "the chevron and the name are where they were");
    chevronBesideName(h, "300px");
  } finally { await x.close(); }
});

for (const [where, width] of [...PLACES, ["side", 620]]) {
  test(`nothing moves when the thread changes${width < FULL ? ", the chevron neither" : ", and a long conversation name ends in “…” inside the cap"} (${where === "side" ? "side bar" : "tab"}, ${width} px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open({ where, width });
    try {
      await x.p.waitForSelector("#pip-convs"); await x.p.waitForTimeout(250);
      await nameIt(x.p, MA);
      // (Under 560 px the selector is the chevron: its whole box stays, with the unread dot and without.)
      const still = (h) => ({ back: h.back, face: h.face, name: h.name, sw: h.sw, computer: h.computer, more: h.more, mid: h.pick.mid, ...(width < FULL ? { pick: h.pick, chevron: h.chevron } : {}) });
      const first = await header(x.p);
      await show(x.p, GOA, "Trip to Goa");
      const goa = await header(x.p);
      await show(x.p, MA, LONG);
      const long = await header(x.p);
      assert.deepEqual(still(goa), still(first), "Chat → Trip to Goa: every part is where it was, and the selector's middle too");
      assert.deepEqual(still(long), still(first), "→ a very long name: every part is where it was");
      assert.equal(long.nameIs.cut, false, "the Pip's name is whole whatever the conversation is called");
      if (width < FULL) { chevronBesideName(long, `${width}px`);
        assert.ok(long.pickLabel.startsWith(`${LONG}: conversations with Mornings`), "the chevron says the conversation shown to a screen reader");
        assert.ok(long.pickTitle.includes(LONG), "and when pointed at"); }
      else {
        assert.ok(long.pick.width <= CAP + 0.5, `the selector is capped: ${long.pick.width}px of ${CAP}`);
        assert.deepEqual([long.title.cut, long.title.dots], [true, true], "the long name is cut with “…”");
        assert.ok(long.title.shown >= 100, `and still reads: ${long.title.shown}px of its name show`);
        assert.ok(goa.pick.width <= long.pick.width, "a short name takes less"); }
      assert.ok(long.pick.left >= long.name.right - 0.5 && long.pick.right <= long.acts.left - 4, "it still lies on neither side");
      assert.equal(long.sideways, false);
      // The selector still opens the list, and the list fits.
      if (width < 900) { await x.p.click("#pip-convs"); await x.p.waitForSelector("#conv-menu");
        const menu = await x.p.evaluate(() => { const m = (window.__pipsRoot || document).querySelector("#conv-menu").getBoundingClientRect(); return m.left >= 0 && m.right <= innerWidth; });
        assert.equal(menu, true, "its list opens inside the page"); }
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

for (const width of [170, 220]) test(`at ${width} px nothing lies on anything else: back, face, the name ending in “…”, the chevron, its computer and ⋯ (the switch has given way)`, async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ where: "side", width });
  try {
    await x.p.waitForSelector("#pip-convs"); await x.p.waitForTimeout(250);
    const h = await header(x.p);
    assert.deepEqual(h.order, ["back", "face", "name", "threads", "computer", "more"]);
    noneOnAnother(h, width, `${width}px`);
    assert.ok(h.name.width >= (width > 200 ? 36 : 24), `the name is there to read: ${h.name.width}px`);
    assert.deepEqual([h.nameIs.cut, h.nameIs.dots, h.nameIs.title], [true, true, "Mornings"], "cut with “…”, whole when pointed at");
    assert.ok(h.pick.width >= 16, "the chevron is there to press");
    await x.p.click("#pip-convs"); await x.p.waitForSelector("#conv-menu");
    const menu = await x.p.evaluate(() => { const m = (window.__pipsRoot || document).querySelector("#conv-menu").getBoundingClientRect(); return m.left >= 0 && m.right <= innerWidth; });
    assert.equal(menu, true, "its list opens inside the page");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("several conversations look as one does in the side bar: the name, then the chevron, part for part in the same place", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ where: "side", width: 300 });
  try {
    await x.p.waitForSelector("#pip-convs"); await x.p.waitForTimeout(250);
    const several = await header(x.p);
    await leaveOne(x.p);
    const one = await header(x.p);
    assert.equal(one.title.text, "Chat");
    assert.deepEqual(one.order.slice(0, 4), ["back", "face", "name", "threads"]);
    chevronBesideName(one, "one conversation");
    const boxes = (h) => ({ back: h.back, face: h.face, name: h.name, pick: h.pick, chevron: h.chevron, sw: h.sw, computer: h.computer, more: h.more });
    assert.deepEqual(boxes(several), boxes(one));
    assert.equal(one.sideways, false);
  } finally { await x.close(); }
});

test("a DGC without conversations (before Pips API 79): back, face and name at the left, nothing in the middle", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openChat(browser, { where: "side", width: 300, height: 700, api: 78 });
  try {
    await x.p.waitForSelector(".pip-topbar .pip-pill"); await x.p.waitForTimeout(200);
    const h = await header(x.p);
    assert.equal(h.pick, null);
    assert.equal(h.nameText, "Mornings");
    assert.ok(Math.abs(h.back.left - (h.bar.left + h.pad[0])) <= 1 && h.face.left - h.back.right <= 14 && h.name.left - h.face.right <= 10, "the left side is the same");
  } finally { await x.close(); }
});
