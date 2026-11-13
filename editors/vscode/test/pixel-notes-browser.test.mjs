// Pixel notes (0.52, 12 Nov night), each measured in real Chromium on the real page:
//   - an Allow card in a 300 px side bar: its four buttons read whole (they were shared equally on one row and cut:
//     "Alwa…", "Don't…", "Add e…"); they take two rows, two a row, never cut
//   - the account chooser's "Use another account" reads whole at 420 px (it was "Use another a…")
//   - a Pip chat's @ list is as tall as its rows (one match had a tall empty box under it)
//   - a Pip computer's tab: while the notification drawer shows, the "… is using its computer" banner keeps clear of it
//   - the side bar's Pips tab: the Core Pip's face comes after the word "Pips", not before it
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openChat } from "./support/pip-chat-scene.mjs";
import { openComputer, PIP as COMPUTER_PIP } from "./support/pip-computer-scene.mjs";
import { openDock } from "./support/dock-scene.mjs";

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

const click = (p, sel) => p.evaluate((s) => (window.__pipsRoot || document).querySelector(s).click(), sel);
/** A card's answers as they are on screen: each button's words, whether they are whole, its box; and what is wrong. */
const answers = (p, selector) => p.evaluate((sel) => {
  const root = window.__pipsRoot || document, card = root.querySelector(sel), box = (n) => n.getBoundingClientRect(), c = box(card);
  const buttons = [...card.querySelectorAll(".dgc-card-actions > button")].filter((b) => b.checkVisibility());
  const read = buttons.map((b) => { const r = document.createRange(); r.selectNodeContents(b); const s = getComputedStyle(b), room = box(b).width - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight) - parseFloat(s.borderLeftWidth) - parseFloat(s.borderRightWidth);
    return { text: b.textContent.trim(), whole: r.getBoundingClientRect().width <= room + 0.5, width: Math.round(box(b).width * 10) / 10, height: box(b).height, top: Math.round(box(b).top), left: box(b).left, right: box(b).right,
      inside: box(b).left >= c.left - 0.5 && box(b).right <= c.right + 0.5 && box(b).bottom <= c.bottom + 0.5 }; });
  const over = []; for (let i = 0; i < read.length; i++) for (let j = i + 1; j < read.length; j++) if (read[i].top === read[j].top && read[i].left < read[j].right - 0.5 && read[j].left < read[i].right - 0.5) over.push(`${read[i].text} / ${read[j].text}`);
  return { buttons: read, rows: [...new Set(read.map((b) => b.top))].map((top) => read.filter((b) => b.top === top).map((b) => b.text)), over, card: c.width,
    sideways: (root.querySelector(".pip-app-root") || document.documentElement).scrollWidth > (root.querySelector(".pip-app-root") || document.documentElement).clientWidth + 1 };
}, selector);
const MAIL = `[data-allow-card="maildraft_${"3".repeat(32)}"]`, MEET = `[data-allow-card="caldraft_${"4".repeat(32)}"]`;

for (const theme of ["dark", "light"]) {
  test(`an Allow card at 300 px: its four buttons read whole, on two rows of two (${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openChat(browser, { width: 300, height: 1000, theme, where: "side", api: 88, settings: true, apps: true, convs: true, allow: "event" });
    try {
      await x.p.waitForSelector(`${MAIL} [data-allow-from]`); await x.p.waitForSelector(`${MEET} [data-allow-from]`);
      for (const [card, words] of [[MAIL, ["Send", "Always allow", "Edit", "Don’t send"]], [MEET, ["Add event", "Always allow", "Edit", "Don’t add"]]]) {
        const a = await answers(x.p, card);
        assert.deepEqual(a.buttons.map((b) => b.text), words);
        assert.deepEqual(a.buttons.filter((b) => !b.whole).map((b) => b.text), [], "every button's words are whole");
        assert.deepEqual(a.rows, [words.slice(0, 2), words.slice(2)], "two rows, two a row, in their order");
        assert.deepEqual([a.over, a.buttons.every((b) => b.inside), a.sideways], [[], true, false], "inside the card, none on another");
        assert.equal(new Set(a.buttons.map((b) => `${b.width}x${b.height}`)).size, 1, `one size for all four: ${a.buttons.map((b) => `${b.width}x${b.height}`)}`);
        assert.ok(a.buttons[0].height === 28 && a.buttons[0].width <= 104.5, "the shared button's height, never past its own width");
      }
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("an Allow card in a wide chat keeps its buttons on one row, at the shared size", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openChat(browser, { width: 700, height: 1000, theme: "dark", where: "tab", api: 88, settings: true, apps: true, convs: true, allow: "event" });
  try {
    await x.p.waitForSelector(`${MAIL} [data-allow-from]`);
    const a = await answers(x.p, MAIL);
    assert.deepEqual([a.rows.length, a.buttons.filter((b) => !b.whole).length, a.over.length], [1, 0, 0]);
    assert.deepEqual([...new Set(a.buttons.map((b) => `${b.width}x${b.height}`))], ["104x28"]);
  } finally { await x.close(); }
});

test("a card with two or three answers at 300 px still shares one row, and none is cut", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openChat(browser, { width: 300, height: 1000, theme: "dark", where: "side", api: 88, settings: true, apps: true, convs: true });
  try {
    await click(x.p, '[data-tab="job"]'); await x.p.waitForSelector(".pip-apps [data-pip-app]");
    await click(x.p, '[data-pip-app-add="gmail"]');
    await x.p.waitForSelector('.app-link[data-state="requested"]');
    const a = await answers(x.p, '.app-link[data-state="requested"]');
    assert.deepEqual(a.rows, [["Choose one", "Not now"]]);
    assert.deepEqual([a.buttons.filter((b) => !b.whole).length, a.over.length, a.buttons.every((b) => b.inside)], [0, 0, true]);
  } finally { await x.close(); }
});

for (const width of [420, 300, 700]) {
  test(`the account chooser at ${width} px: "Use another account" reads whole`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openChat(browser, { width, height: 1000, theme: "dark", where: width > 400 ? "tab" : "side", api: 88, settings: true, apps: true, convs: true });
    try {
      await click(x.p, '[data-tab="job"]'); await x.p.waitForSelector(".pip-apps [data-pip-app]");
      await click(x.p, '[data-pip-app-add="gmail"]');
      await x.p.locator('.app-link[data-state="requested"] [data-app-link-start]').click();
      await x.p.waitForSelector("[data-app-link-account]");
      const a = await answers(x.p, ".app-link[data-app-link]");
      assert.deepEqual(a.buttons.map((b) => b.text), ["Use another account", "Not now"]);
      assert.deepEqual(a.buttons.filter((b) => !b.whole).map((b) => b.text), [], "no button's words are cut");
      assert.deepEqual([a.rows.length, a.over, a.buttons.every((b) => b.inside), a.sideways], [1, [], true, false]);
      assert.equal(a.buttons[0].height, 28, "the shared button's height");
      if (width > 380) assert.deepEqual(a.buttons.map((b) => b.width), [152, 104], "the roomy size for the long words, the usual one beside it");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

for (const theme of ["dark", "light"]) {
  test(`a Pip chat's @ list with one match is as tall as its one row (300 px side bar, ${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openChat(browser, { width: 300, height: 800, theme, where: "side", many: true });
    try {
      const read = () => x.p.evaluate(() => { const root = window.__pipsRoot || document, pop = root.querySelector("#chat-pop"), box = pop.getBoundingClientRect(), s = getComputedStyle(pop);
        const rows = [...pop.querySelectorAll(".pi")].map((r) => r.getBoundingClientRect()), form = root.querySelector("#chat-form").getBoundingClientRect();
        return { shown: s.display !== "none", rows: rows.length, height: box.height, need: rows.reduce((sum, r) => sum + r.height, 0) + parseFloat(s.borderTopWidth) + parseFloat(s.borderBottomWidth) + parseFloat(s.paddingTop) + parseFloat(s.paddingBottom),
          aboveBox: box.bottom <= form.top + 0.5 || box.bottom <= root.querySelector("#chatText").getBoundingClientRect().top + 0.5, scrolls: pop.scrollHeight > pop.clientHeight + 1, names: [...pop.querySelectorAll(".pi .pi-label")].map((n) => n.textContent.trim()) }; });
      await x.p.click("#chatText");
      // "@" here offers one thing, the Pips of this Pip's workspace: one row.
      await x.p.keyboard.type("@");
      await x.p.waitForFunction(() => { const pop = (window.__pipsRoot || document).querySelector("#chat-pop"); return getComputedStyle(pop).display !== "none" && pop.querySelectorAll(".pi").length === 1; });
      const one = await read();
      assert.equal(one.rows, 1, `one match: ${one.names}`);
      assert.ok(Math.abs(one.height - one.need) <= 1, `the list is ${one.height}px for ${one.need}px of row`);
      assert.deepEqual([one.aboveBox, one.scrolls], [true, false], "just above the box, nothing to scroll");
      // Into it, every Pip: the list grows with its rows up to its cap (210 px), then scrolls.
      await x.p.keyboard.press("Enter");
      await x.p.waitForFunction(() => (window.__pipsRoot || document).querySelectorAll("#chat-pop .pi").length > 4);
      const many = await read();
      assert.ok(many.height <= 210.5 && many.height > one.height, `more rows, a taller list, never past 210px: ${many.height}`);
      assert.ok(many.need <= 210 ? Math.abs(many.height - many.need) <= 1 : many.scrolls, "as tall as its rows, or at its cap and scrolling");
      assert.equal(many.aboveBox, true);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

// ---- a Pip computer's tab: the banner and the notification drawer -------------------------------------------------------
const action = (letter, summary = {}) => ({ id: "compact_" + letter.repeat(32), pip_id: COMPUTER_PIP.id, workspace_id: "ws", run_id: "run_" + "b".repeat(32),
  summary: { method: "POST", host: "shop.example", path: "/order", page: "https://shop.example/cart", fields: [], more_fields: 0, body_bytes: 14, ...summary },
  digest: letter.repeat(64), frame: null, status: "pending", created_at: new Date(Date.now() - 20000).toISOString(), expires_at: "2099-11-13T09:00:00.000Z", resolved_at: null, resolved_by: null, continuation_run_id: null });
const FORM = action("c"), PAY = action("d", { host: "pay.example", payment: true, fields: [{ name: "amount", value: "53.50" }] }), TEXT = action("f", { kind: "text", host: "forum.example", text: "Dear team,\nthe figures are attached." });
const banner = (p) => p.evaluate(() => {
  const box = (e) => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
  const badge = document.querySelector(".pc-overlay-badge"), drawer = document.getElementById("pc-drawer"), live = document.getElementById("pc-live");
  const seen = (e) => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden";
  const b = badge && box(badge), d = seen(drawer) ? box(drawer) : null, l = box(live);
  const words = badge && (() => { const r = document.createRange(); r.selectNodeContents(badge); return [...r.getClientRects()]; })();
  return { text: badge?.textContent || "", shown: seen(badge), badge: b, drawer: d, live: l, fan: !!drawer?.classList.contains("pc-fan"),
    under: !!(b && d && seen(badge) && b.left < d.right - 0.5 && d.left < b.right - 0.5 && b.top < d.bottom - 0.5 && d.top < b.bottom - 0.5),
    inside: !!b && b.left >= l.left - 0.5 && b.right <= l.right + 0.5 && b.top >= l.top - 0.5 && b.bottom <= l.bottom + 0.5,
    wordsInside: !!b && words.every((w) => w.left >= b.left - 0.5 && w.right <= b.right + 0.5), centred: b ? Math.abs((b.left + b.right) / 2 - (l.left + l.right) / 2) : 99 };
});
const settled = (p) => p.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running")).then(() => p.waitForTimeout(120));

for (const width of [1100, 700, 300]) {
  test(`a Pip computer's tab at ${width} px: the "is using its computer" banner is never under the notification drawer`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openComputer(browser, { width, height: 700, using: true });
    try {
      await x.p.waitForSelector(".pc-overlay-badge");
      const alone = await banner(x.p);
      assert.match(alone.text, /^Mornings is using its computer\./);
      assert.equal(alone.drawer, null, "nothing waits: no drawer");
      assert.ok(alone.shown && alone.inside && alone.centred <= 1, `with no drawer the banner is where it was, top centre: ${JSON.stringify(alone.badge)}`);
      // Three things wait: the drawer shows (fanned as they arrive, then folded).
      await x.scene({ actions: [PAY, TEXT, FORM] });
      await x.p.waitForSelector("#pc-drawer:not([hidden])", { timeout: 15000 }); await settled(x.p);
      const open = await banner(x.p);
      assert.ok(open.drawer, "the drawer shows");
      assert.equal(open.under, false, `the banner is clear of the drawer: ${JSON.stringify([open.badge, open.drawer])}`);
      if (open.shown) assert.ok(open.inside && open.wordsInside, `whole, inside the screen: ${JSON.stringify(open.badge)}`);
      if (width >= 700) assert.ok(open.shown && open.badge.right <= open.drawer.left - 8, `it stands to the drawer's left: ${JSON.stringify([open.badge, open.drawer])}`);
      // Fanned out (the pointer on it) and folded (the pointer away): clear both ways.
      await x.p.mouse.move(open.drawer.left + open.drawer.width / 2, open.drawer.top + 20); await x.p.waitForSelector("#pc-drawer.pc-fan"); await settled(x.p);
      const fanned = await banner(x.p);
      assert.deepEqual([fanned.fan, fanned.under], [true, false], `fanned: ${JSON.stringify([fanned.badge, fanned.drawer])}`);
      await x.p.mouse.move(20, 680); await x.p.waitForSelector("#pc-drawer:not(.pc-fan)"); await settled(x.p);
      const folded = await banner(x.p);
      assert.deepEqual([folded.fan, folded.under], [false, false], `folded: ${JSON.stringify([folded.badge, folded.drawer])}`);
      assert.equal(folded.shown, true, "with the stack folded there is room for the banner at every width");
      assert.ok(folded.inside && folded.wordsInside, `whole, inside the screen: ${JSON.stringify(folded.badge)}`);
      // Collapsed to its bell, the drawer is gone and the banner is back at the top centre.
      await x.p.mouse.move(folded.drawer.left + folded.drawer.width / 2, folded.drawer.top + 20); await x.p.waitForSelector("#pc-drawer.pc-fan");
      await x.p.click("#pc-drawer .pc-drawer-quiet"); await settled(x.p);
      const back = await banner(x.p);
      assert.ok(back.drawer === null && back.shown && back.centred <= 1 && Math.abs(back.badge.top - alone.badge.top) <= 0.5, `collapsed: the banner is where it was: ${JSON.stringify([back.badge, back.drawer])}`);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

// ---- the side bar's Pips tab: the word, then the Core Pip's face --------------------------------------------------------
const pipsTab = (page) => page.evaluate(() => {
  const tab = document.getElementById("side-tab-pips"), box = (n) => { const r = n.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
  const face = tab.querySelector(".dgc-tab-face"), flip = tab.querySelector(".dgc-tab-flip"), word = tab.querySelector(".dgc-tab-front .dgc-tab-word"), r = document.createRange(); r.selectNodeContents(word);
  const said = r.getBoundingClientRect(), other = document.getElementById("side-tab-work"), otherFlip = other.querySelector(".dgc-tab-flip");
  return { tab: box(tab), face: face.querySelector(".dgc-plush") && face.checkVisibility() ? box(face) : null, flip: box(flip), word: { left: said.left, right: said.right, top: said.top, bottom: said.bottom },
    gap: parseFloat(getComputedStyle(tab).columnGap) || 0, selected: tab.getAttribute("aria-selected"), glow: Number(getComputedStyle(tab.querySelector(".dgc-tab-glow")).opacity), colour: getComputedStyle(tab).color,
    // Another tab's name is centred in its tab: so is this pair.
    otherOff: Math.abs((box(otherFlip).left + box(otherFlip).right) / 2 - (box(other).left + box(other).right) / 2),
    order: [...tab.children].map((c) => c.className), name: tab.textContent.trim(), sideways: document.documentElement.scrollWidth > innerWidth };
});
for (const theme of ["dark-modern", "light-modern"]) for (const width of [700, 300, 240]) {
  test(`the Pips tab: the word "Pips", then the Core Pip's face, the pair centred in the tab (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openDock(browser, { tab: "home", width, height: 600, theme });
    try {
      const held = (m, said) => {
        assert.ok(m.face, `${said}: the face is drawn`);
        assert.ok(m.face.left >= m.word.right - 0.5, `${said}: the face's left edge is after the word's right edge (${m.word.right} then ${m.face.left})`);
        assert.ok(Math.abs(m.face.left - m.flip.right - m.gap) <= 0.5, `${said}: the tab's own gap between them, as it was before the word (${m.face.left - m.flip.right} for ${m.gap})`);
        assert.ok(Math.abs((m.face.top + m.face.bottom) / 2 - (m.word.top + m.word.bottom) / 2) <= 1, `${said}: the face is centred on the word (${(m.face.top + m.face.bottom) / 2} against ${(m.word.top + m.word.bottom) / 2})`);
        assert.ok(Math.abs((m.flip.left + m.face.right) / 2 - (m.tab.left + m.tab.right) / 2) <= 1, `${said}: the pair is centred in the tab (${(m.flip.left + m.face.right) / 2} in ${(m.tab.left + m.tab.right) / 2})`);
        assert.ok(m.flip.left >= m.tab.left - 0.5 && m.face.right <= m.tab.right + 0.5, `${said}: neither is cut by the tab`);
        assert.deepEqual([m.name, m.sideways], ["Pips", false], `${said}: the tab is still named Pips (once: the copy that rose under the pointer went on 13 Nov)`);
      };
      const rest = await pipsTab(x.page);
      held(rest, "at rest");
      assert.deepEqual(rest.order, ["dgc-tab-glow", "dgc-tab-flip", "dgc-tab-face"], "in the page too: the word, then the face");
      // Pointed at (no glow since 13 Nov: only the name's colour changes), and chosen (lit): the same order and place.
      await x.page.hover("#side-tab-pips"); await x.page.waitForTimeout(450);
      const hover = await pipsTab(x.page);
      assert.equal(hover.glow, 0, "pointed at, it does not glow");
      assert.ok(Math.abs(hover.face.left - rest.face.left) <= 0.5 && Math.abs(hover.tab.left - rest.tab.left) <= 0.5, "and nothing moves");
      await x.page.click("#side-tab-pips"); await x.page.mouse.move(width / 2, 400); await x.page.waitForTimeout(450);
      const chosen = await pipsTab(x.page);
      held(chosen, "chosen");
      assert.deepEqual([chosen.selected, chosen.glow > 0.9, chosen.colour !== rest.colour], ["true", true, true], "chosen: lit, in the accent's words");
      assert.ok(Math.abs(chosen.face.left - rest.face.left) <= 0.5 && Math.abs(chosen.tab.width - rest.tab.width) <= 0.5, "choosing it moves nothing");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("170 px, the icon-only tab bar: Pips is the face alone, in the middle of its tab", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { tab: "home", width: 170, height: 600 });
  try {
    const m = await pipsTab(x.page);
    assert.ok(m.face && Math.abs((m.face.left + m.face.right) / 2 - (m.tab.left + m.tab.right) / 2) <= 1 && Math.abs((m.face.top + m.face.bottom) / 2 - (m.tab.top + m.tab.bottom) / 2) <= 1, JSON.stringify(m));
  } finally { await x.close(); }
});
