// The Project Folder dropdown's shape and motion (0.52, asked 13 Nov), in real Chromium with the real pages, at 700 and
// 300 px, dark and light: the button has the shared button's corner and height; the open menu and its button are one
// shape (the menu starts at the button's edge and shares its side, the button's corners next to it are square, one line
// runs round both with no break at the join, both stand on one ground, and where the menu is wider it reaches away from
// the side the button is on, the inner corner filled); the chevron is an × while it is open; rows arrive in order and
// end at rest in their slots, and leave in reverse; with reduced motion nothing moves; the keyboard and Escape are as
// they were; words read at 4.5:1; nothing overflows the view. Read from the DOM, computed style, geometry, the page's
// own animations held at a time, and the painted pixels.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openHome } from "./support/home-scene.mjs";
import { openPips } from "./support/project-folder-pips-scene.mjs";
import { listOf } from "./support/folder-row-scene.mjs";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser, decoder;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "";
  if (!reason) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); decoder = await browser.newPage(); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

const settle = (page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
const GARDEN = "/home/me/code/garden";

/** The page as painted: a function from a point (CSS px) to its colour. */
async function painted(page) {
  const shot = (await page.screenshot()).toString("base64");
  const size = page.viewportSize();
  const data = await decoder.evaluate(async (png) => {
    const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
    const canvas = new OffscreenCanvas(image.width, image.height), ctx = canvas.getContext("2d"); ctx.drawImage(image, 0, 0);
    const raw = ctx.getImageData(0, 0, image.width, image.height).data; let text = "";
    for (let i = 0; i < raw.length; i += 32768) text += String.fromCharCode(...raw.subarray(i, i + 32768));
    return { width: image.width, raw: btoa(text) };
  }, shot);
  const px = Buffer.from(data.raw, "base64"), scale = data.width / size.width;
  return (x, y) => { const i = (Math.floor(y * scale) * data.width + Math.floor(x * scale)) * 4; return [px[i], px[i + 1], px[i + 2]]; };
}
const apart = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);

/** The dropdown as it is now. `where`: "library" (Work's Library row), "dialog" (New Session's), "pips" (the Pips view's
 *  Needs attention line, in its own root). */
const lookNow = (page, where) => page.evaluate((w) => {
  const root = w === "pips" ? document.getElementById("pips-host").shadowRoot : document;
  const pick = root.querySelector(w === "pips" ? "#pips-folder-pick" : w === "dialog" ? "dialog.new-session-dialog .dgc-folder" : "#sessions-folder-pick");
  const menu = root.querySelector(".dgc-folder-menu:not([data-leaving])"), list = menu?.querySelector(".dgc-folder-list") || menu;
  const box = (e) => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
  const style = getComputedStyle(pick), alpha = (c) => { const m = c.match(/-?[\d.]+(e-?\d+)?/g)?.map(Number) || []; return c === "transparent" ? 0 : m.length > 3 ? m[3] : 1; };
  const marks = [...pick.querySelectorAll(".dgc-folder-chevron path")].map((p) => getComputedStyle(p).d);
  const active = root.activeElement;
  return { pick: box(pick), expanded: pick.getAttribute("aria-expanded"), joined: pick.getAttribute("data-folder-open"), popup: pick.getAttribute("aria-haspopup"),
    corners: [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius], line: [style.borderTopWidth, alpha(style.borderTopColor)], ground: style.backgroundColor,
    height: box(pick).height, chevron: marks, chevronRight: box(pick).right - box(pick.querySelector(".dgc-folder-chevron")).right, valueLeft: box(pick.querySelector(".dgc-folder-k").checkVisibility() ? pick.querySelector(".dgc-folder-k") : pick.querySelector(".dgc-folder-v")).left - box(pick).left,
    focus: active === pick ? "button" : active && menu?.contains(active) ? active.dataset.folder ?? (active === menu ? "menu" : "add") : active?.id || active?.tagName || "",
    menu: menu ? { ...box(menu), role: menu.getAttribute("role"), label: menu.getAttribute("aria-label"), listGround: getComputedStyle(list).backgroundColor,
      listCorners: [getComputedStyle(list).borderTopLeftRadius, getComputedStyle(list).borderTopRightRadius, getComputedStyle(list).borderBottomRightRadius, getComputedStyle(list).borderBottomLeftRadius],
      rows: [...menu.querySelectorAll(".dgc-menu-row")].map((r) => { const b = box(r), s = getComputedStyle(r); return { folder: r.dataset.folder ?? "add", role: r.getAttribute("role"), checked: r.getAttribute("aria-checked"), top: b.top, bottom: b.bottom, left: b.left, right: b.right,
        radius: s.borderTopLeftRadius, opacity: Number(s.opacity), transform: s.transform, mark: !!r.querySelector(".dgc-menu-icon")?.checkVisibility(), markLeft: r.querySelector(".dgc-menu-icon") ? box(r.querySelector(".dgc-menu-icon")).left - b.left : -1,
        markBeforeName: r.querySelector(".dgc-menu-icon") ? box(r.querySelector(".dgc-menu-icon")).right <= box(r.querySelector(".dgc-menu-label")).left + 0.5 : false,
        markColour: r.querySelector(".dgc-menu-icon") ? getComputedStyle(r.querySelector(".dgc-menu-icon")).color : "", checkColour: r.querySelector(".dgc-menu-check") ? getComputedStyle(r.querySelector(".dgc-menu-check")).color : "", colour: s.color,
        inside: [...r.querySelectorAll(".dgc-menu-label, .dgc-folder-note, .dgc-path, .dgc-menu-check, .dgc-menu-icon")].every((e) => box(e).left >= b.left - 0.5 && box(e).right <= b.right + 0.5) }; }),
      scrollsSideways: list.scrollWidth > list.clientWidth + 1, scrolls: list.scrollHeight > list.clientHeight + 1 } : null,
    all: root.querySelectorAll(".dgc-folder-menu").length, view: [innerWidth, innerHeight], sideways: document.scrollingElement.scrollWidth > innerWidth + 1 };
}, where);
/** Every word in the menu and on its button with its contrast against the ground it is on. */
const contrast = (page, where) => page.evaluate((w) => {
  const root = w === "pips" ? document.getElementById("pips-host").shadowRoot : document;
  const parse = (c) => { const m = c.match(/-?[\d.]+(e-?\d+)?/g)?.map(Number) || [0, 0, 0, 0]; return c.startsWith("color(srgb") ? [m[0] * 255, m[1] * 255, m[2] * 255, m[3] ?? 1] : [m[0], m[1], m[2], m[3] ?? 1]; };
  const over = (top, under) => top.slice(0, 3).map((v, i) => v * top[3] + under[i] * (1 - top[3])).concat(1);
  const up = (n) => n.parentElement || (n.parentNode instanceof ShadowRoot ? n.parentNode.host : null);
  const ground = (e) => { const layers = []; for (let n = e; n; n = up(n)) { const c = parse(getComputedStyle(n).backgroundColor); if (c[3] > 0) layers.push(c); if (c[3] >= 1) break; }
    return layers.reduceRight((under, top) => over(top, under), [255, 255, 255, 1]); };
  const lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const out = [];
  for (const host of [root.querySelector(".dgc-folder-menu"), root.querySelector('.dgc-folder[aria-expanded="true"]')]) {
    if (!host) { out.push({ text: "nothing to read", ratio: 0 }); continue; }
    const walk = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    for (let t = walk.nextNode(); t; t = walk.nextNode()) {
      const e = t.parentElement;
      if (!t.textContent.trim() || !e.checkVisibility({ visibilityProperty: true, opacityProperty: true }) || e.closest(":disabled")) continue;
      const g = ground(e), c = over(parse(getComputedStyle(e).color), g), [a, b] = [lum(c), lum(g)].sort((p, q) => q - p);
      out.push({ text: t.textContent.trim().slice(0, 40), ratio: Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100 });
    }
  }
  return out;
}, where);

/** One shape: read from the geometry, the styles and the pixels. `before`: the page painted with the menu closed. */
async function assertOneShape(page, where, before, { sameWidth = false, tag }) {
  const m = await lookNow(page, where), menu = m.menu, pick = m.pick;
  assert.ok(menu, `${tag}: the menu is open`);
  assert.deepEqual([m.expanded, m.joined], ["true", "down"], `${tag}: the button says it is open, and joined to a menu under it`);
  // Geometry: the menu starts at the button's lower edge and shares the side the button is on.
  assert.ok(Math.abs(menu.top - pick.bottom) <= 0.5, `${tag}: no gap under the button: the menu's top ${menu.top} is the button's bottom ${pick.bottom}`);
  const toLeft = pick.right - 6 > m.view[0] - 6 - pick.left;
  if (sameWidth) assert.ok(Math.abs(menu.left - pick.left) <= 0.5 && Math.abs(menu.right - pick.right) <= 0.5, `${tag}: a field's menu is the field's width: ${menu.left}..${menu.right} against ${pick.left}..${pick.right}`);
  else {
    assert.ok(Math.abs(toLeft ? menu.right - pick.right : menu.left - pick.left) <= 0.5, `${tag}: the menu keeps the button's ${toLeft ? "right" : "left"} edge: ${JSON.stringify([menu.left, menu.right, pick.left, pick.right])}`);
    assert.ok(menu.width >= pick.width + 16, `${tag}: wider than its button by a real step: ${menu.width} against ${pick.width}`);
    assert.ok(toLeft ? menu.left < pick.left : menu.right > pick.right, `${tag}: it reaches away from the side the button is on`);
  }
  assert.ok(menu.left >= 0 && menu.right <= m.view[0] + 0.5 && menu.bottom <= m.view[1] + 0.5 && !m.sideways && !menu.scrollsSideways, `${tag}: inside the view, nothing sideways: ${JSON.stringify([menu.left, menu.right, menu.bottom, m.view])}`);
  // Styles: square where the menu joins, the button's own line put down, one ground.
  assert.deepEqual(m.corners, ["6px", "6px", "0px", "0px"], `${tag}: the button's lower corners are square while it is open`);
  assert.deepEqual(m.line, ["1px", 0], `${tag}: the button's own line is put down (the one outline is drawn round both)`);
  assert.equal(m.ground, menu.listGround, `${tag}: the button and the menu stand on one ground`);
  assert.deepEqual(menu.listCorners.slice(2), ["6px", "6px"], `${tag}: the menu's lower corners are round`);
  // Pixels.
  const px = await painted(page), L = Math.round(pick.left), R = Math.round(pick.right), T = Math.round(pick.top), B = Math.round(pick.bottom), ML = Math.round(menu.left), MR = Math.round(menu.right), MB = Math.round(menu.bottom);
  const edge = toLeft || sameWidth ? R - 0.5 : L + 0.5, line = px(edge, T + 14), ground = px(L + 3.5, T + 14);
  assert.ok(apart(line, ground) > 8, `${tag}: a line is drawn on the ground: ${line} on ${ground}`);
  // (Over a page whose own ground is the raised grey's colour, a light dialog's or the light Pips view's, the line and the shade alone part them.)
  if (where === "library") assert.ok(apart(ground, before(L + 3.5, T + 14)) > 8, `${tag}: the open button is on the raised ground, not the page's: ${ground}`);
  // One line down the shared side, from the button's upper corner to the menu's lower one, with no break at the join.
  const broken = [];
  for (let y = T + 8; y <= MB - 8; y++) if (apart(px(edge, y + 0.5), line) > 8) broken.push(y - B);
  assert.deepEqual(broken, [], `${tag}: the line runs unbroken down the side of the button and the menu (breaks at these px from the join)`);
  if (sameWidth) { const other = []; for (let y = T + 8; y <= MB - 8; y++) if (apart(px(L + 0.5, y + 0.5), line) > 8) other.push(y - B); assert.deepEqual(other, [], `${tag}: and down the other side`); }
  // One ground: inside the button, inside the menu's edge, and at the join.
  for (const [name, x, y] of [["inside the menu's side", toLeft || sameWidth ? MR - 3.5 : ML + 3.5, MB - 20.5], ["just under the join", toLeft || sameWidth ? R - 3.5 : L + 3.5, B + 1.5], ["inside the menu's lower edge", (ML + MR) / 2, MB - 2.5]])
    assert.ok(apart(px(x, y), ground) <= 8, `${tag}: one ground ${name}: ${px(x, y)} against ${ground}`);
  // Round outer corners: the page shows through them, as it did.
  for (const [name, x, y] of [["the button's upper left", L + 0.5, T + 0.5], ["the button's upper right", R - 0.5, T + 0.5]])
    assert.ok(apart(px(x, y), before(x, y)) <= 12, `${tag}: ${name} corner is round: ${px(x, y)} against the page's ${before(x, y)}`);
  for (const [name, x] of [["left", ML + 0.5], ["right", MR - 0.5]]) assert.ok(apart(px(x, MB - 0.5), ground) > 8, `${tag}: the menu's lower ${name} corner is round (not ground): ${px(x, MB - 0.5)}`);
  if (!sameWidth) {
    // The part that reaches out: its top is the same line, level with the button's lower edge; its own outer corner is
    // round; nothing is drawn above it; and the inner corner where it meets the button is filled, not a notch.
    const from = toLeft ? ML + 8 : R + 8, to = toLeft ? L - 8 : MR - 8, gaps = [];
    for (let x = from; x <= to; x++) if (apart(px(x + 0.5, B - 0.5), line) > 8) gaps.push(x);
    assert.deepEqual(gaps, [], `${tag}: the line runs along the top of the part that reaches out, level with the button's lower edge`);
    const outer = toLeft ? ML + 0.5 : MR - 0.5, beside = toLeft ? L - 9.5 : R + 9.5, inner = toLeft ? L - 0.5 : R + 0.5;
    assert.ok(apart(px(outer, B - 0.5), before(outer, B - 0.5)) <= 12, `${tag}: its outer corner is round: ${px(outer, B - 0.5)} against the page's ${before(outer, B - 0.5)}`);
    assert.ok(apart(px(beside, B - 5.5), before(beside, B - 5.5)) <= 12, `${tag}: nothing is drawn above it, beside the button: ${px(beside, B - 5.5)} against ${before(beside, B - 5.5)}`);
    assert.ok(apart(px(inner, B - 1.5), ground) <= 8, `${tag}: the inner corner at the join is filled with the ground: ${px(inner, B - 1.5)} against ${ground}`);
    assert.ok(apart(px(toLeft ? L - 6.5 : R + 6.5, B - 6.5), before(toLeft ? L - 6.5 : R + 6.5, B - 6.5)) <= 12, `${tag}: and rounded, the page showing in its hollow`);
  }
  return m;
}

for (const theme of ["dark-modern", "light-modern"]) for (const width of [700, 300]) {
  const tag = `${theme}, ${width}px`;
  test(`the Library row: the button in the shared button's shape; open, it and its menu are one shape, the chevron an × (${tag})`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openHome(browser, { theme, width, tab: "work", motion: "reduce" });
    try {
      await x.send(listOf(""));
      await settle(x.page);
      // Closed: the New button's corner and height, a 1 px line, the folder at the left and the chevron at the right.
      const closed = await lookNow(x.page, "library");
      const fresh = await x.page.evaluate(() => { const s = getComputedStyle(document.getElementById("sessions-new")); return { radius: s.borderTopLeftRadius, height: document.getElementById("sessions-new").getBoundingClientRect().height }; });
      assert.deepEqual(closed.corners, Array(4).fill(fresh.radius), "the New button's corner on all four");
      assert.equal(fresh.radius, "6px");
      assert.equal(closed.height, fresh.height, "the New button's height");
      assert.deepEqual(closed.line, ["1px", closed.line[1]]); assert.ok(closed.line[1] > 0, "a 1 px line");
      assert.ok(closed.valueLeft >= 8 && closed.valueLeft <= 12 && closed.chevronRight >= 6 && closed.chevronRight <= 10, `the words at the left, the chevron at the right: ${closed.valueLeft}, ${closed.chevronRight}`);
      assert.deepEqual(closed.chevron, ['path("M 4.5 6.5 L 8 10")', 'path("M 8 10 L 11.5 6.5")'], "a chevron at rest");
      assert.deepEqual([closed.expanded, closed.joined, closed.popup, closed.all], ["false", null, "menu", 0]);
      const before = await painted(x.page);
      await x.page.click("#sessions-folder-pick");
      await x.page.mouse.move(2, 2);
      await settle(x.page);
      const m = await assertOneShape(x.page, "library", before, { tag });
      assert.deepEqual(m.chevron, ['path("M 4.5 4.5 L 11.5 11.5")', 'path("M 4.5 11.5 L 11.5 4.5")'], "the chevron is an × while it is open");
      // Rows: rounded like the button, a mark before each name, the chosen one checked; only the check is in the accent.
      assert.deepEqual(m.menu.rows.map((r) => [r.folder, r.role, r.checked]).slice(0, 3), [["", "menuitemradio", "true"], ["/home/me/code/shop", "menuitemradio", "false"], [GARDEN, "menuitemradio", "false"]]);
      assert.deepEqual([m.menu.role, m.menu.label], ["menu", "Project Folder"]);
      for (const r of m.menu.rows) {
        assert.equal(r.radius, "6px", "a row has the button's corner");
        assert.ok(r.mark && r.markBeforeName && r.markLeft >= 6 && r.markLeft <= 10, `a mark before the name: ${JSON.stringify(r)}`);
        assert.ok(r.inside && r.left >= m.menu.left + 4 && r.right <= m.menu.right - 4, `a row and all it holds is inside the menu: ${JSON.stringify(r)}`);
        assert.notEqual(r.markColour, r.checkColour, "the mark is grey; only the check is in the accent");
      }
      const low = (await contrast(x.page, "library")).filter((c) => c.ratio < 4.5);
      assert.deepEqual(low, [], "every word at 4.5:1");
      // A row pointed at: a rounded fill.
      await x.page.hover(`.dgc-folder-menu [data-folder="${GARDEN}"]`);
      await settle(x.page);
      const hover = await x.page.evaluate((f) => { const s = getComputedStyle(document.querySelector(`.dgc-folder-menu [data-folder="${f}"]`)); return [s.backgroundColor !== "rgba(0, 0, 0, 0)", s.borderTopLeftRadius]; }, GARDEN);
      assert.deepEqual(hover, [true, "6px"]);
      // Closed again: the button is whole, a chevron, and nothing is left behind.
      await x.page.keyboard.press("Escape");
      const again = await lookNow(x.page, "library");
      assert.deepEqual([again.all, again.expanded, again.joined, again.corners, again.chevron, again.focus], [0, "false", null, Array(4).fill("6px"), closed.chevron, "button"]);
      assert.ok(again.line[1] > 0, "its own line is back");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`the Pips view's Needs attention line: the same one shape, in the view's own root (${tag})`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openPips(browser, { theme, width });
    try {
      const closed = await lookNow(x.page, "pips");
      assert.deepEqual([closed.corners, closed.height, closed.chevron], [Array(4).fill("6px"), 28, ['path("M 4.5 6.5 L 8 10")', 'path("M 8 10 L 11.5 6.5")']]);
      const before = await painted(x.page);
      await x.inPips((root) => root.querySelector("#pips-folder-pick").click());
      await x.page.mouse.move(2, 2);
      await settle(x.page);
      const m = await assertOneShape(x.page, "pips", before, { tag });
      assert.deepEqual(m.chevron, ['path("M 4.5 4.5 L 11.5 11.5")', 'path("M 4.5 11.5 L 11.5 4.5")']);
      for (const r of m.menu.rows) assert.ok(r.mark && r.markBeforeName && r.inside && r.radius === "6px", `a rounded row with its mark, drawn in this root too: ${JSON.stringify(r)}`);
      // (The mark is drawn, not a letter of a font this root has not got: it has ink.)
      const ink = await x.inPips((root) => [...root.querySelectorAll(".dgc-folder-menu .dgc-menu-icon")].every((e) => { const folder = e.querySelector(".folder-icon");      // (a folder's own icon since 13 Nov, drawn by folders.css in this root too; All projects keeps its drawn stack)
        return (folder ? folder.getBoundingClientRect().width >= 14 && getComputedStyle(folder).backgroundImage !== "none" : !!e.querySelector("svg path")) && e.getBoundingClientRect().width >= 14; }));
      assert.equal(ink, true);
      assert.deepEqual((await contrast(x.page, "pips")).filter((c) => c.ratio < 4.5), []);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`the dock's "+" → New work asks for the folder in New Session's dialog, as New does (${tag})`, async (t) => {
    // 25 Nov (reported): the dock's New work started a session at once in this window's folder, with no folder choice.
    if (skipOrFail(t)) return;
    const x = await openHome(browser, { theme, width, tab: "work", motion: "reduce" });
    try {
      await x.send(listOf(""));
      await x.page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "dockState", pins: [], offers: { work: true, chat: true, pip: true } } })));
      await settle(x.page);
      const plus = x.page.locator("#dgc-dock .dgc-dock-add");
      if (!(await plus.count())) { t.skip("this scene draws no dock"); return; }
      await plus.click(); await settle(x.page);
      await x.page.click('.dgc-pop [data-id="work"]');
      await x.page.waitForSelector("dialog.new-session-dialog[open]", { timeout: 3000 });
      assert.equal(await x.page.locator("dialog.new-session-dialog .dgc-folder").count(), 1, "its folder dropdown");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`New Session's dialog: the dropdown is the field, as wide as it, and its menu opens under it at the same width, one shape (${tag})`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openHome(browser, { theme, width, tab: "work", motion: "reduce" });
    try {
      await x.send(listOf(""));
      await x.page.click("#sessions-new");
      await x.page.waitForSelector("dialog.new-session-dialog[open]");
      await settle(x.page);
      const closed = await lookNow(x.page, "dialog");
      const field = await x.page.evaluate(() => { const b = document.querySelector(".new-session-body"), s = getComputedStyle(b), r = b.getBoundingClientRect(); return [r.left + parseFloat(s.paddingLeft), r.right - parseFloat(s.paddingRight)]; });
      assert.ok(Math.abs(closed.pick.left - field[0]) <= 0.5 && Math.abs(closed.pick.right - field[1]) <= 0.5, `as wide as the dialog's body: ${closed.pick.left}..${closed.pick.right} in ${field}`);
      assert.ok(closed.valueLeft >= 8 && closed.valueLeft <= 12 && closed.chevronRight >= 6 && closed.chevronRight <= 10, "the words at the left, the chevron at the right end");
      const before = await painted(x.page);
      await x.page.click("dialog.new-session-dialog .dgc-folder");
      await x.page.mouse.move(2, 2);
      await settle(x.page);
      const m = await assertOneShape(x.page, "dialog", before, { sameWidth: true, tag });
      assert.equal(m.menu.rows.at(-1).folder, "add");
      assert.ok(m.menu.rows.at(-1).mark && m.menu.rows.at(-1).markBeforeName, "Add a folder… has its mark");
      assert.deepEqual((await contrast(x.page, "dialog")).filter((c) => c.ratio < 4.5), []);
      // Escape closes the menu back to the button, and the dialog stays; again, and the dialog goes.
      await x.page.keyboard.press("Escape");
      const again = await lookNow(x.page, "dialog");
      assert.deepEqual([again.all, again.focus, await x.page.locator("dialog.new-session-dialog[open]").count()], [0, "button", 1]);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

/** The dropdown's own animations (the menu's and its button's), each held at `ms`; with no `ms`, how many there are. */
const hold = (page, ms) => page.evaluate((t) => {
  const mine = document.getAnimations().filter((a) => a.effect?.target?.closest?.(".dgc-folder-menu, .dgc-folder"));
  if (t === undefined) return mine.length;
  for (const a of mine) { a.pause(); a.currentTime = t; }
  return mine.length;
}, ms);
const finishAll = (page) => page.evaluate(() => { for (const a of document.getAnimations()) if (a.effect?.target?.closest?.(".dgc-folder-menu, .dgc-folder")) a.finish(); });
const shapeNow = (page) => page.evaluate(() => { const menu = document.querySelector(".dgc-folder-menu"), line = menu.querySelector(".dgc-folder-line").getBoundingClientRect(), list = menu.querySelector(".dgc-folder-list");
  return { height: line.height, width: line.width, rows: [...list.querySelectorAll(".dgc-menu-row")].map((r) => { const s = getComputedStyle(r.closest(".dgc-folder-item") || r), m = new DOMMatrix(s.transform === "none" ? "" : s.transform); return { opacity: Number(s.opacity), y: m.f, scale: m.a, top: r.getBoundingClientRect().top }; }) }; });
// (Since 14 Nov a folder's row and its pin are one item, .dgc-folder-item, and move as one: a row's motion is its item's.)

for (const [theme, width] of [["dark-modern", 700], ["light-modern", 300]]) {
  test(`it grows out of the button; rows arrive in order and end at rest in their slots; they leave in reverse (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    // Where each row rests: the same page with reduced motion.
    const still = await openHome(browser, { theme, width, tab: "work", motion: "reduce" });
    let slots, full;
    try { await still.send(listOf("")); await settle(still.page); await still.page.click("#sessions-folder-pick"); await settle(still.page); slots = (await lookNow(still.page, "library")).menu.rows.map((r) => r.top); full = await shapeNow(still.page).catch(() => null); } finally { await still.close(); }
    const x = await openHome(browser, { theme, width, tab: "work" });
    try {
      await x.send(listOf(""));
      await settle(x.page);
      const pick = (await lookNow(x.page, "library")).pick;
      await x.page.click("#sessions-folder-pick");
      assert.ok(await hold(x.page, 0) >= 8, "it moves: the shape and each row have their own animation");
      const at = {};
      for (const ms of [0, 60, 120, 180, 240, 320, 480]) { await hold(x.page, ms); at[ms] = await shapeNow(x.page); }
      // The shape: from the button alone, to the whole menu, never past it by more than a breath.
      assert.ok(at[0].height <= pick.height + 2 && at[0].width <= pick.width + 2, `it starts as the button alone: ${at[0].width} x ${at[0].height} against ${pick.width} x ${pick.height}`);
      for (const [a, b] of [[0, 60], [60, 120], [120, 180]]) assert.ok(at[b].height > at[a].height && at[b].width >= at[a].width, `it grows from ${a} to ${b} ms: ${at[a].height} to ${at[b].height}`);
      assert.ok(at[60].height < full.height * 0.6 && at[120].height < full.height * 0.95, `still growing at 60 and 120 ms: a soft spring, not a jump (${at[60].height}, ${at[120].height} of ${full.height})`);
      for (const ms of [240, 320, 480]) assert.ok(at[ms].height <= full.height + 4 && at[ms].width <= full.width + 4, `never past its size by more than a breath (${ms} ms: ${at[ms].height} against ${full.height})`);
      // Rows: none shows at the start; each starts toward the button, small; an earlier row is never behind a later one.
      const n = at[0].rows.length;
      assert.ok(n >= 6);
      assert.deepEqual(at[0].rows.map((r) => r.opacity), Array(n).fill(0), "no row shows at the start");
      for (const r of at[0].rows) assert.ok(r.y < -4 && r.scale < 1 && r.scale >= 0.9, `a row starts up toward the button, a little small: ${JSON.stringify(r)}`);
      for (const ms of [60, 120, 180, 240, 320]) for (let i = 1; i < n; i++) {
        assert.ok(at[ms].rows[i - 1].opacity >= at[ms].rows[i].opacity - 0.001, `${ms} ms: row ${i - 1} is at least as far in as row ${i}: ${at[ms].rows.map((r) => r.opacity)}`);
        assert.ok(at[ms].rows[i - 1].scale >= at[ms].rows[i].scale - 0.001, `${ms} ms: and at least as near its size`);
      }
      const arrived = (ms) => at[ms].rows.filter((r) => r.opacity >= 0.99).length;
      assert.ok(arrived(60) === 0 && arrived(180) >= 1 && arrived(180) < n && arrived(240) > arrived(180) && arrived(320) > arrived(240) && arrived(480) === n, `one after another: ${[60, 120, 180, 240, 320, 480].map(arrived)} of ${n}`);
      assert.ok(at[120].rows[0].opacity > at[120].rows[3].opacity + 0.3, `the first is well ahead of the fourth at 120 ms: ${at[120].rows.map((r) => r.opacity)}`);
      // At rest: every row in its slot, nothing left moving, nothing left on the rows.
      await finishAll(x.page);
      await settle(x.page);
      const rest = await shapeNow(x.page);
      assert.equal(await hold(x.page), 0, "nothing still moving");
      assert.deepEqual(rest.rows.map((r) => [r.opacity, r.y, r.scale]), Array(n).fill([1, 0, 1]), "every row whole, unmoved");
      rest.rows.forEach((r, i) => assert.ok(Math.abs(r.top - slots[i]) <= 0.5, `row ${i} rests in its slot: ${r.top} against ${slots[i]}`));
      assert.ok(Math.abs(rest.height - full.height) <= 0.5 && Math.abs(rest.width - full.width) <= 0.5, "the shape at its size");

      // Closing: the keyboard is back on the button at once and the menu can't be reached; the rows leave from the last.
      await x.page.keyboard.press("Escape");
      const going = await x.page.evaluate(() => { const menu = document.querySelector(".dgc-folder-menu"), pick = document.getElementById("sessions-folder-pick");
        return { there: !!menu, inert: menu?.inert, hidden: menu?.getAttribute("aria-hidden"), focus: document.activeElement === pick, expanded: pick.getAttribute("aria-expanded"), joined: pick.getAttribute("data-folder-open"), chevron: getComputedStyle(pick.querySelector("path")).transitionDuration }; });
      assert.deepEqual(going, { there: true, inert: true, hidden: "true", focus: true, expanded: "false", joined: "down", chevron: "0.28s" }, "leaving: unreachable, the keyboard on the button, the button still part of the shape");
      await hold(x.page, 70);
      const leaving = await shapeNow(x.page);
      for (let i = 1; i < n; i++) assert.ok(leaving.rows[i].opacity <= leaving.rows[i - 1].opacity + 0.001, `the later row is further gone: ${leaving.rows.map((r) => r.opacity)}`);
      assert.ok(leaving.rows[n - 1].opacity < leaving.rows[0].opacity - 0.2, "the last leaves first");
      await hold(x.page, 200);
      assert.ok((await shapeNow(x.page)).height < full.height * 0.6, "and the shape draws back into the button");
      await finishAll(x.page);
      await x.page.waitForFunction(() => !document.querySelector(".dgc-folder-menu"));
      const after = await lookNow(x.page, "library");
      assert.deepEqual([after.joined, after.corners, after.focus], [null, Array(4).fill("6px"), "button"], "gone: the button is whole again");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("reduced motion: it opens and closes at once, nothing moves", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openHome(browser, { width: 700, tab: "work", motion: "reduce" });
  try {
    await x.send(listOf(""));
    await settle(x.page);
    const before = await painted(x.page);
    await x.page.click("#sessions-folder-pick");
    // In the same turn as the click: whole, at rest, with nothing running.
    const m = await x.page.evaluate(() => { const menu = document.querySelector(".dgc-folder-menu"), pick = document.getElementById("sessions-folder-pick");
      return { moving: document.getAnimations().filter((a) => a.effect?.target?.closest?.(".dgc-folder-menu, .dgc-folder")).length, rows: [...menu.querySelectorAll(".dgc-menu-row")].map((r) => [getComputedStyle(r).opacity, getComputedStyle(r).transform]),
        clip: getComputedStyle(menu.querySelector(".dgc-folder-list")).clipPath, chevron: getComputedStyle(pick.querySelector("path")).transitionDuration, press: getComputedStyle(pick).transitionDuration, d: getComputedStyle(pick.querySelector("path")).d }; });
    assert.equal(m.moving, 0, "no animation at all");
    assert.ok(m.rows.length >= 6 && m.rows.every((r) => r[0] === "1" && r[1] === "none"), "every row whole in its slot");
    assert.deepEqual([m.clip, m.chevron, m.d], ["none", "0s", 'path("M 4.5 4.5 L 11.5 11.5")'], "the whole list shows; the chevron is an × at once");
    assert.ok(m.press.split(", ").every((d) => d === "0s"), `the button's own changes take no time: ${m.press}`);
    await assertOneShape(x.page, "library", before, { tag: "reduced motion" });
    await x.page.keyboard.press("Escape");
    const gone = await x.page.evaluate(() => [document.querySelectorAll(".dgc-folder-menu").length, document.getElementById("sessions-folder-pick").getAttribute("data-folder-open"), document.activeElement.id]);
    assert.deepEqual(gone, [0, null, "sessions-folder-pick"], "gone in the same turn");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

for (const motion of ["reduce", "no-preference"]) {
  test(`the keyboard is as it was: Down opens on the chosen row, arrows move, Enter chooses, Escape closes back to the button (motion: ${motion})`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openHome(browser, { width: 300, tab: "work", motion });
    try {
      await x.send(listOf(GARDEN));
      await settle(x.page);
      await x.page.focus("#sessions-folder-pick");
      await x.page.keyboard.press("ArrowDown");
      let m = await lookNow(x.page, "library");
      assert.deepEqual([m.expanded, m.focus, m.menu.role, m.popup], ["true", GARDEN, "menu", "menu"], "Down opens it with the keyboard on the chosen row");
      await x.page.keyboard.press("ArrowDown"); assert.equal((await lookNow(x.page, "library")).focus, "/home/me/clients/northwind-traders/2026/storefront-redesign/packages/checkout-service");
      await x.page.keyboard.press("ArrowUp"); await x.page.keyboard.press("ArrowUp"); assert.equal((await lookNow(x.page, "library")).focus, "/home/me/code/shop");
      // (For a few hours on 14 Nov the menu's first line was "Pin <folder> to the dock"; it was asked out the same
      // day: All projects is the first row again, and no line pins the chosen folder.)
      assert.equal(await x.page.locator(".dgc-folder-menu [data-folder-pin-line]").count(), 0, "no line that pins the chosen folder");
      await x.page.keyboard.press("Home"); assert.equal((await lookNow(x.page, "library")).focus, "", "Home: the first row, All projects");
      await x.page.keyboard.press("ArrowUp"); assert.equal((await lookNow(x.page, "library")).focus, "/home/me/code/storefront-redesign-checkout-service-next-generation", "Up from the first wraps to the last");
      await x.page.keyboard.press("End"); await x.page.keyboard.press("ArrowDown"); assert.equal((await lookNow(x.page, "library")).focus, "", "Down from the last wraps to the first");
      // A row the keyboard is on: a rounded fill.
      const focused = await x.page.evaluate(() => { const s = getComputedStyle(document.activeElement); return [document.activeElement.matches(":focus-visible"), s.backgroundColor !== "rgba(0, 0, 0, 0)", s.borderTopLeftRadius]; });
      assert.deepEqual(focused, [true, true, "6px"]);
      await x.page.keyboard.press("Escape");
      m = await lookNow(x.page, "library");
      assert.deepEqual([m.expanded, m.focus, m.menu], ["false", "button", null], "Escape closes it back to the button");
      assert.deepEqual(await x.posted("projectFolderChoose"), [], "and chooses nothing");
      // Open again at once (the last one may still be leaving), move, Enter.
      await x.page.keyboard.press("ArrowDown");
      await x.page.keyboard.press("ArrowUp");
      await x.page.keyboard.press("Enter");
      assert.deepEqual(await x.posted("projectFolderChoose"), [{ type: "projectFolderChoose", folder: "/home/me/code/shop" }], "Enter chooses the row the keyboard is on");
      m = await lookNow(x.page, "library");
      assert.deepEqual([m.expanded, m.focus, m.menu], ["false", "button", null]);
      // A click on the button while it is open closes it; a click outside closes it and leaves the keyboard alone.
      await x.page.click("#sessions-folder-pick"); assert.equal((await lookNow(x.page, "library")).expanded, "true");
      await x.page.click("#sessions-folder-pick"); assert.deepEqual([(await lookNow(x.page, "library")).expanded, (await lookNow(x.page, "library")).menu], ["false", null]);
      await x.page.click("#sessions-folder-pick");
      await x.page.mouse.click(8, 500);
      assert.deepEqual([(await lookNow(x.page, "library")).expanded, (await lookNow(x.page, "library")).menu], ["false", null], "a click outside closes it");
      if (motion !== "reduce") { await finishAll(x.page); await x.page.waitForFunction(() => !document.querySelector(".dgc-folder-menu")); }
      assert.equal((await lookNow(x.page, "library")).all, 0, "nothing left behind");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("the page draws its button again while the menu is open: the new button is still open, in one shape with it", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openHome(browser, { width: 700, tab: "work", motion: "reduce" });
  try {
    await x.send(listOf(""));
    await settle(x.page);
    const before = await painted(x.page);
    await x.page.click("#sessions-folder-pick");
    await x.page.evaluate(() => { document.getElementById("sessions-folder-pick").dataset.first = "1"; });
    const list = listOf(""); list.folders.rows = list.folders.rows.map((r) => ({ ...r, sessions: r.sessions + 1 }));
    await x.send(list);
    await x.page.mouse.move(2, 2);
    await settle(x.page);
    assert.equal(await x.page.evaluate(() => document.getElementById("sessions-folder-pick").dataset.first || ""), "", "the button was drawn again");
    await assertOneShape(x.page, "library", before, { tag: "drawn again" });
    await x.page.click("#sessions-folder-pick");
    const m = await lookNow(x.page, "library");
    assert.deepEqual([m.expanded, m.joined, m.all], ["false", null, 0], "and a click on it closes the menu");
  } finally { await x.close(); }
});

test("with no room under it the menu opens over its button, the same one shape turned over", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openHome(browser, { width: 700, height: 520, tab: "work", motion: "reduce" });
  try {
    await x.send(listOf(""));
    await x.page.addStyleTag({ content: "#sessions-folder-slot { position: fixed; right: 40px; bottom: 110px; }" });
    await settle(x.page);
    await x.page.click("#sessions-folder-pick");
    await x.page.mouse.move(2, 2);
    await settle(x.page);
    const m = await lookNow(x.page, "library"), px = await painted(x.page);
    assert.equal(m.joined, "up");
    assert.ok(Math.abs(m.menu.bottom - m.pick.top) <= 0.5 && Math.abs(m.menu.right - m.pick.right) <= 0.5 && m.menu.top >= 0, `over the button, on its edge: ${JSON.stringify([m.menu.top, m.menu.bottom, m.pick.top])}`);
    assert.deepEqual(m.corners, ["0px", "0px", "6px", "6px"], "the button's upper corners are square");
    assert.deepEqual(m.menu.listCorners.slice(0, 2), ["6px", "6px"], "the menu's upper corners are round");
    const edge = Math.round(m.pick.right) - 0.5, line = px(edge, m.pick.top + 14), broken = [];
    for (let y = Math.round(m.menu.top) + 8; y <= Math.round(m.pick.bottom) - 8; y++) if (apart(px(edge, y + 0.5), line) > 8) broken.push(y);
    assert.deepEqual(broken, [], "one line down the side of the menu and the button");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});
