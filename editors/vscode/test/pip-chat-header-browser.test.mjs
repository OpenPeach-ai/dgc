// A Pip's chat header (live round 1, finding 19, his call of 14 Nov): LEFT, fixed: back, the Pip's face and its name.
// CENTRE, always centred: the thread selector (the conversation shown, with the chevron that opens the list), in a
// capped width; a long name ends in "…", also when narrow. RIGHT: the switch, its computer, ⋯. Nothing moves when the
// thread changes (the face used to ride beside the thread's name, so it moved with every thread). In the narrow side
// bar the selector keeps the middle and the Pip's name gives way to its face (the name is the face's tooltip there).
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
const CAP = 220;   // the selector's most, in px (--thread-cap)

/** The header as it is drawn: each part's box, in the root the chat lives in. */
const header = (p) => p.evaluate(() => {
  const root = window.__pipsRoot || document, bar = root.querySelector(".pip-topbar"); if (!bar) return null;
  const r = (n) => { if (!n || !n.checkVisibility()) return null; const b = n.getBoundingClientRect(); return b.width ? { left: Math.round(b.left * 10) / 10, right: Math.round(b.right * 10) / 10, top: Math.round(b.top * 10) / 10, width: Math.round(b.width * 10) / 10, mid: Math.round((b.left + b.right) * 5) / 10 } : null; };
  const pick = bar.querySelector("#pip-convs"), title = bar.querySelector(".pip-conv-title"), name = bar.querySelector(".pip-name"), face = bar.querySelector(".pip-pill .avatar");
  const acts = bar.querySelector(".topbar-actions");
  const order = [...bar.querySelectorAll("#simple-back, .pip-pill .avatar, .pip-name, #pip-convs, .topbar-actions [role=switch], .topbar-actions .computer-icon, .topbar-actions .pip-menu > summary")].filter((n) => n.checkVisibility() && n.getBoundingClientRect().width > 0)
    .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left).map((n) => n.id === "simple-back" ? "back" : n.id === "pip-convs" ? "threads" : n.matches(".avatar") ? "face" : n.matches(".pip-name") ? "name" : n.matches("[role=switch]") ? "switch" : n.matches(".computer-icon") ? "computer" : "more");
  const ts = title ? getComputedStyle(title) : null;
  return { bar: r(bar), back: r(bar.querySelector("#simple-back")), face: r(face), name: r(name), nameText: name?.textContent || "", faceTitle: face?.closest("[title]")?.getAttribute("title") || "",
    pick: r(pick), title: title ? { text: title.textContent, cut: title.scrollWidth > title.clientWidth + 1, dots: ts.textOverflow === "ellipsis" && ts.overflowX !== "visible" && ts.whiteSpace === "nowrap", shown: Math.round(title.getBoundingClientRect().width) } : null,
    sw: r(acts?.querySelector("[role=switch]")), computer: r(acts?.querySelector(".computer-icon")), more: r(acts?.querySelector(".pip-menu > summary")), acts: r(acts), order,
    pad: [parseFloat(getComputedStyle(bar).paddingLeft), parseFloat(getComputedStyle(bar).paddingRight)],
    sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth || bar.scrollWidth > bar.clientWidth + 1 };
});
const open = (o) => openChat(browser, { height: 700, api: 97, convs: true, switches: true, ...o });
// (From 900 px the conversations stand beside the chat as a column: the row is clicked there, and the selector is its name.)
const show = async (p, id, title) => { const column = await p.evaluate(() => !!(window.__pipsRoot || document).querySelector("#conv-column .conv-row")?.checkVisibility());
  if (column) await p.click(`#conv-column [data-conv="${id}"]`); else { await p.click("#pip-convs"); await p.click(`#conv-menu [data-conv="${id}"]`); } await p.waitForFunction(([t]) => ((window.__pipsRoot || document).querySelector(".pip-conv-title")?.textContent || "") === t, [title]); await p.waitForTimeout(120); };
/** One conversation gets a very long name (as a rename would leave it), before the list is next read. */
const nameLong = (p, id) => p.evaluate(([i, t]) => { window.__convs.list.find((c) => c.id === i).title = t; }, [id, LONG]);

const PLACES = [["side", 300], ["side", 440], ["tab", 700], ["tab", 1100]];
for (const theme of ["dark", "light"]) for (const [where, width] of PLACES) {
  test(`back, face and name at the left; the thread selector in the middle; the switch, its computer and ⋯ at the right (${where === "side" ? "side bar" : "tab"}, ${width} px, ${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open({ where, width, theme });
    try {
      await x.p.waitForSelector("#pip-convs"); await x.p.waitForTimeout(250);
      const h = await header(x.p);
      const narrow = width <= 340;
      assert.deepEqual(h.order, narrow ? ["back", "face", "threads", "switch", "computer", "more"] : ["back", "face", "name", "threads", "switch", "computer", "more"], "the order, left to right");
      // The left: against the bar's own edge, back then the face then the name.
      assert.ok(Math.abs(h.back.left - (h.bar.left + h.pad[0])) <= 1, `Back starts the bar: ${h.back.left}`);
      assert.ok(h.face.left - h.back.right <= 14, `the face follows Back (${h.face.left - h.back.right}px on)`);
      if (!narrow) { assert.equal(h.nameText, "Mornings"); assert.ok(h.name.left - h.face.right <= 10 && h.name.width >= 40, `its name follows its face (${JSON.stringify(h.name)})`); }
      else assert.match(h.faceTitle, /Mornings/, "narrow, the face says the Pip's name when pointed at");
      // The right: against the bar's other edge.
      assert.ok(Math.abs(h.more.right - (h.bar.right - h.pad[1])) <= 1, `⋯ ends the bar: ${h.more.right} of ${h.bar.right}`);
      // The middle: the conversation shown, by its name, never the Pip's name again.
      assert.equal(h.title.text, "Chat", "the selector names the conversation shown");
      assert.ok(h.pick.left >= (h.name || h.face).right + 4 && h.pick.right <= h.acts.left - 4, "it lies between the two sides, on neither");
      const centre = (h.bar.left + h.bar.right) / 2;
      if (!narrow) assert.ok(Math.abs(h.pick.mid - centre) <= 1, `it is centred in the bar: its middle ${h.pick.mid}, the bar's ${centre}`);
      else { const room = ((h.face.right + h.acts.left) / 2); assert.ok(Math.abs(h.pick.mid - room) <= 1, `narrow, it is centred in the room between the two sides: ${h.pick.mid} of ${room}`); }
      assert.equal(h.sideways, false, "nothing runs off sideways");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

for (const [where, width] of PLACES) {
  test(`nothing moves when the thread changes, and a long name ends in “…” inside the cap (${where === "side" ? "side bar" : "tab"}, ${width} px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open({ where, width });
    try {
      await x.p.waitForSelector("#pip-convs"); await x.p.waitForTimeout(250);
      await nameLong(x.p, MA);
      const still = (h) => ({ back: h.back, face: h.face, name: h.name, sw: h.sw, computer: h.computer, more: h.more, mid: h.pick.mid });
      const first = await header(x.p);
      await show(x.p, GOA, "Trip to Goa");
      const goa = await header(x.p);
      await show(x.p, MA, LONG);
      const long = await header(x.p);
      assert.deepEqual(still(goa), still(first), "Chat → Trip to Goa: every part is where it was, and the selector's middle too");
      assert.deepEqual(still(long), still(first), "→ a very long name: every part is where it was");
      assert.ok(long.pick.width <= CAP + 0.5, `the selector is capped: ${long.pick.width}px of ${CAP}`);
      assert.deepEqual([long.title.cut, long.title.dots], [true, true], "the long name is cut with “…”");
      assert.ok(long.title.shown >= 40, `and still reads: ${long.title.shown}px of its name show`);
      assert.ok(long.pick.left >= (long.name || long.face).right + 4 && long.pick.right <= long.acts.left - 4, "it still lies on neither side");
      assert.ok(goa.pick.width <= long.pick.width, "a short name takes less");
      assert.equal(long.sideways, false);
      // The selector still opens the list, and the list fits.
      if (width < 900) { await x.p.click("#pip-convs"); await x.p.waitForSelector("#conv-menu");
        const menu = await x.p.evaluate(() => { const m = (window.__pipsRoot || document).querySelector("#conv-menu").getBoundingClientRect(); return m.left >= 0 && m.right <= innerWidth; });
        assert.equal(menu, true, "its list opens inside the page"); }
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

for (const width of [170, 220]) test(`at ${width} px nothing lies on anything else: the selector is its chevron${width < 200 ? ", and the switch gives way" : ""}`, async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ where: "side", width });
  try {
    await x.p.waitForSelector("#pip-convs"); await x.p.waitForTimeout(250);
    const h = await header(x.p);
    assert.deepEqual(h.order, width < 200 ? ["back", "face", "threads", "computer", "more"] : ["back", "face", "threads", "switch", "computer", "more"]);
    const parts = [h.back, h.face, h.pick, h.sw, h.computer, h.more].filter(Boolean);
    for (let i = 1; i < parts.length; i++) assert.ok(parts[i].left >= parts[i - 1].right - 0.5, `part ${i + 1} starts after part ${i} ends: ${parts[i].left} against ${parts[i - 1].right}`);
    assert.ok(h.back.left >= 0 && h.more.right <= width, "all of it is on the page");
    assert.ok(h.pick.width >= 18, "the chevron is there to press");
    assert.equal(h.sideways, false);
    await x.p.click("#pip-convs"); await x.p.waitForSelector("#conv-menu");
    const menu = await x.p.evaluate(() => { const m = (window.__pipsRoot || document).querySelector("#conv-menu").getBoundingClientRect(); return m.left >= 0 && m.right <= innerWidth; });
    assert.equal(menu, true, "its list opens inside the page");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("a Pip with one conversation keeps the same header: its name at the left also in the narrow side bar, the selector in the middle", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ where: "side", width: 300 });
  try {
    await x.p.waitForSelector("#pip-convs");
    // Every other conversation is archived: one is left.
    await x.p.evaluate(() => { for (const c of window.__convs.list) if (!c.first) c.archived = true; });
    await x.p.click("#pip-convs"); await x.p.waitForSelector("#conv-menu"); await x.p.keyboard.press("Escape"); await x.p.waitForTimeout(300);
    const h = await header(x.p);
    assert.equal(h.title.text, "Chat");
    assert.deepEqual(h.order.slice(0, 4), ["back", "face", "name", "threads"], "with one short thread there is room: the name stays");
    assert.equal(h.sideways, false);
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
