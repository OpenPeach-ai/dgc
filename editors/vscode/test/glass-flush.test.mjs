// The side bar's two glass bars are flush with the page that scrolls under them (0.52, asked 13 Nov: "it has kind of a
// white thin line at the bottom side of header bar and top side of this bottom dock area, let's make that flush, so it
// doesn't look separate"). The tab bar (#side-tabs) drew a half-pixel hairline under itself and the dock's strip
// (#dgc-dock) one above itself; neither does now, in dark and in light, at 700 and 300 px, on Home, Work, Chat and the
// Pips view. The frosting and the page's room for both bars are as they were. Where there is no glass to tell a bar
// from the page, and the theme is one that asks for lines (a high contrast theme, forced colours), each bar keeps a
// real 1 px line of the theme's own border. Read from computed style and from the painted pixels (two device pixels to
// a CSS pixel, so half a pixel is a whole row), in real Chromium on the side bar's real page (support/dock-scene.mjs).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openDock } from "./support/dock-scene.mjs";
import { manySessions } from "./support/home-scene.mjs";

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

/** The page as painted: a function from a point (CSS px) to its colour. */
async function painted(page) {
  const shot = (await page.screenshot()).toString("base64"), size = page.viewportSize();
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
/** Both bars as they are styled and where they are. */
const bars = (page) => page.evaluate(() => {
  const read = (n) => { const s = getComputedStyle(n), r = n.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height, shadow: s.boxShadow, borders: [s.borderTopWidth, s.borderBottomWidth], outline: s.outlineStyle,
    filter: s.backdropFilter || "none", ground: s.backgroundColor, after: getComputedStyle(n, "::after").content, before: getComputedStyle(n, "::before").content }; };
  const host = document.body.classList.contains("pips-active") ? document.getElementById("pips-host") : document.getElementById("sessions-host");
  return { tabs: read(document.getElementById("side-tabs")), dock: read(document.getElementById("dgc-dock")), width: innerWidth,
    room: [parseFloat(getComputedStyle(host).getPropertyValue("--glass-top")) || 0, parseFloat(getComputedStyle(host).getPropertyValue("--glass-bottom")) || 0] };
});
/** How much of a line is painted along each bar's edge, in the page's left gutter (nothing but the ground is there):
 *  the row just outside the bar against the ground three pixels inside it and three outside. 0 is flush. */
async function edgeLines(page) {
  const b = await bars(page), px = await painted(page), at = (edge, out) => Math.max(...[2.25, 4.25, b.width - 2.25].map((x) => {
    const row = px(x, edge + out * 0.25); return Math.min(apart(row, px(x, edge + out * 3.25)), apart(row, px(x, edge - out * 3.25))); }));
  return { tabs: at(b.tabs.bottom, 1), dock: at(b.dock.top, -1) };
}
const open = async (view, more) => {
  const x = await openDock(browser, { height: 620, tab: view === "pips" ? "work" : view, sessions: manySessions(40), scale: 2, ...more });
  if (view === "pips") { await x.page.click("#side-tab-pips"); await x.page.waitForFunction(() => !!document.getElementById("pips-host").shadowRoot?.querySelector(".pip-app-root")); }
  await x.page.mouse.move(2, 300);
  await x.settle();
  return x;
};

for (const theme of ["dark-modern", "light-modern"]) for (const width of [700, 300]) {
  test(`neither glass bar draws a line along its edge: flush with the page, still frosted, the page's room as it was (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    for (const view of ["work", "pips", "home", "chat"]) {
      const x = await open(view, { theme, width });
      try {
        const b = await bars(x.page);
        for (const [name, bar] of [["the tab bar", b.tabs], ["the dock's strip", b.dock]]) {
          assert.equal(bar.shadow, "none", `${view}: ${name} casts no line`);
          assert.deepEqual(bar.borders, ["0px", "0px"], `${view}: ${name} has no border`);
          assert.match(bar.filter, /blur\((1[2-9]|2\d)(\.\d+)?px\)/, `${view}: ${name} is still frosted (${bar.filter})`);
        }
        assert.ok(Math.abs(b.room[0] - b.tabs.height) < 0.6 && Math.abs(b.room[1] - b.dock.height) < 0.6, `${view}: the page keeps each bar's own height clear (${b.room} against ${b.tabs.height}, ${b.dock.height})`);
        const lines = await edgeLines(x.page);
        assert.ok(lines.tabs <= 6, `${view}: nothing is painted along the tab bar's lower edge (${lines.tabs})`);
        assert.ok(lines.dock <= 6, `${view}: nothing is painted along the strip's upper edge (${lines.dock})`);
        assert.deepEqual(x.errors, []);
      } finally { await x.close(); }
    }
  });
}

test("a high contrast theme and forced colours: no glass there, so each bar keeps a real 1 px line of the theme's own border", async (t) => {
  if (skipOrFail(t)) return;
  for (const view of ["work", "pips"]) {
    const x = await open(view, { theme: "hc", width: 300 });
    try {
      const b = await bars(x.page), lines = await edgeLines(x.page);
      assert.equal(b.tabs.filter, "none"); assert.equal(b.dock.filter, "none");
      assert.match(b.tabs.shadow, /0px 1px 0px 0px$/, `${view}: the tab bar's line is a whole pixel under it (${b.tabs.shadow})`);
      assert.match(b.dock.shadow, /0px -1px 0px 0px$/, `${view}: the strip's line is a whole pixel over it (${b.dock.shadow})`);
      assert.ok(lines.tabs > 60 && lines.dock > 60, `${view}: and both are painted, plain to see (${lines.tabs}, ${lines.dock})`);
      assert.ok(Math.abs(b.room[0] - b.tabs.height) < 0.6 && Math.abs(b.room[1] - b.dock.height) < 0.6, `${view}: the page's room is the bars' own height`);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
    const f = await open(view, { width: 300, forced: true });
    try {
      const b = await bars(f.page);
      assert.deepEqual([b.tabs.borders[1], b.dock.borders[0], b.tabs.shadow, b.dock.shadow], ["1px", "1px", "none", "none"], `${view}, forced colours: a 1 px border on each bar's edge, as before`);
    } finally { await f.close(); }
  }
});

test("\"reduce transparency\" in an ordinary theme: the bars are solid and the page's own colour, and still draw no line", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open("work", { width: 300 });
  try {
    const cdp = await x.page.context().newCDPSession(x.page);
    await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value: "reduce" }] }); await x.settle();
    const b = await bars(x.page), lines = await edgeLines(x.page);
    assert.deepEqual([b.tabs.filter, b.dock.filter, b.tabs.shadow, b.dock.shadow], ["none", "none", "none", "none"]);
    assert.ok(lines.tabs <= 6 && lines.dock <= 6, `flush (${lines.tabs}, ${lines.dock})`);
  } finally { await x.close(); }
});
