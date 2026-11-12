// The preview line and the preview tab in real Chromium (0.52). In Work, ChatDGC and a Pip's chat, at 700 and 300 px,
// dark and light: one line of link text sits right under a reply's HTML block, looks as the reply's image link does
// (same ink, same type, no box), stays inside the chat, and a click or Enter posts the page with the reply's CSS.
// The tab's page: the reply's HTML drawn with its CSS on the ground the editor's theme gives, a Light / Dark switch in
// its corner that works with no script, CSS animations playing, and nothing run and nothing asked for from anywhere.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromiumOrNull, isPurple } from "./support/look-probe.mjs";
import { CHATS, ICONS_CSS, ICONS_HTML, openTab } from "./support/code-preview-scene.mjs";

const chromium = await chromiumOrNull();
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

// Read in the page: the line, the code block over it and the reply's image link, wherever the chat is drawn.
const facts = () => {
  const find = (root, s) => { const hit = root.querySelector(s); if (hit) return hit; for (const n of root.querySelectorAll("*")) { const inner = n.shadowRoot && find(n.shadowRoot, s); if (inner) return inner; } return null; };
  const link = find(document, ".code-preview"), image = find(document, '.md-link[data-file-kind="image"]');
  if (!link || !image) return { link: !!link, image: !!image };
  const line = link.parentElement, pre = line.previousElementSibling;
  const look = (n) => { const s = getComputedStyle(n); return { color: s.color, size: s.fontSize, weight: s.fontWeight, family: s.fontFamily, fill: s.backgroundColor, border: s.borderTopWidth, shadow: s.boxShadow,
    decoration: s.textDecorationLine, cursor: s.cursor, display: s.display, mark: getComputedStyle(n, "::before").content !== "none" }; };
  const r = (n) => { const b = n.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height }; };
  let scroller = line.parentElement; while (scroller && !(scroller.scrollHeight > scroller.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement || scroller.getRootNode()?.host;
  const lineFill = getComputedStyle(line);
  return { text: link.textContent, look: look(link), imageLook: look(image), link: r(link), line: r(line), pre: r(pre), preIsCode: pre.matches("pre.code"), lang: pre.dataset.language,
    lineBox: { fill: lineFill.backgroundColor, border: lineFill.borderTopWidth, shadow: lineFill.boxShadow }, lines: link.getClientRects().length, pictures: line.querySelectorAll("img, svg, iframe, canvas").length,
    inner: innerWidth, pageWide: document.documentElement.scrollWidth, next: line.nextElementSibling?.textContent || "" };
};

for (const [name, open] of Object.entries(CHATS)) for (const theme of ["dark-modern", "light-modern"]) for (const width of [700, 300]) {
  test(`${name}: one line of link text under the HTML block, as an image link looks, and a press opens the preview (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open(browser, { theme, width });
    try {
      await x.page.locator(".code-preview").first().scrollIntoViewIfNeeded();
      const f = await x.page.evaluate(facts);
      assert.equal(f.text, "Preview: Cube icon set");
      assert.deepEqual([f.preIsCode, f.lang], [true, "html"], "it sits right under the HTML block");
      assert.equal(await x.page.locator(".code-preview").count(), 1, "one line a page: the CSS block has none of its own");
      // As the reply's image link looks.
      const { mark: _m, ...ink } = f.look, { mark: _i, ...imageInk } = f.imageLook;
      assert.deepEqual(ink, imageInk, "the same ink, type and weight as an image link, with no fill and no box");
      assert.equal(f.look.cursor, "pointer");
      assert.deepEqual(f.lineBox, { fill: "rgba(0, 0, 0, 0)", border: "0px", shadow: "none" }, "a line of text: not a card");
      assert.equal(f.pictures, 0, "no thumbnail");
      // Where it is.
      const gap = f.line.top - f.pre.bottom;
      assert.ok(f.link.top >= f.pre.bottom - 0.5 && f.link.top - f.pre.bottom <= 14, `close under its block (${(f.link.top - f.pre.bottom).toFixed(1)}px, the line ${gap.toFixed(1)}px)`);
      assert.ok(Math.abs(f.link.left - f.pre.left) <= 2, "at the block's left edge");
      assert.ok(f.link.right <= f.pre.right + 0.5 && f.link.right <= f.inner, "inside the chat");
      assert.equal(f.lines, 1, "on one line");
      assert.ok(f.link.height <= 26, `a line's height (${f.link.height}px)`);
      assert.ok(f.pageWide <= f.inner, "the page doesn't scroll sideways");
      // A click, and Enter on it.
      await x.page.locator(".code-preview").first().click();
      await x.page.locator(".code-preview").first().focus();
      await x.page.keyboard.press("Enter");
      const posted = await x.posted();
      assert.equal(posted.length, 2);
      assert.deepEqual(posted[0], { type: "codePreview", kind: "html", title: "Cube icon set", html: ICONS_HTML + "\n", css: [ICONS_CSS + "\n"] });
      assert.deepEqual(posted[1], posted[0], "Enter does what a click does");
      const ring = await x.page.evaluate(() => { const find = (root, s) => { const hit = root.querySelector(s); if (hit) return hit; for (const n of root.querySelectorAll("*")) { const inner = n.shadowRoot && find(n.shadowRoot, s); if (inner) return inner; } return null; };
        const n = find(document, ".code-preview"), s = getComputedStyle(n); return n.matches(":focus-visible") && (s.outlineStyle !== "none" || s.textDecorationLine.includes("underline") || s.boxShadow !== "none"); });
      assert.equal(ring, true, "the keyboard's place on it can be seen");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

const frames = (page) => page.evaluate(() => [...document.querySelectorAll("iframe")].map((f) => { const r = f.getBoundingClientRect(), s = getComputedStyle(f);
  return { ground: f.dataset.ground, shown: f.checkVisibility(), width: r.width, height: r.height, bottom: r.bottom, border: s.borderTopWidth }; }));

for (const theme of ["dark", "light"]) for (const width of [700, 300]) {
  test(`the tab: the page with its CSS on the ${theme} editor's ground, a Light / Dark switch in the corner, nothing run or fetched (${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openTab(browser, { theme, width });
    try {
      const other = theme === "dark" ? "light" : "dark";
      let shown = await frames(x.page);
      assert.deepEqual(shown.map((f) => [f.ground, f.shown]), [["light", theme === "light"], ["dark", theme === "dark"]], "the ground the editor's theme gives");
      const mine = shown.find((f) => f.shown);
      assert.equal(mine.width, width, "at the tab's width");
      assert.ok(mine.bottom <= 620 + 0.5 && mine.height >= 620 - 48, "the page has the tab but for a thin strip");
      assert.equal(mine.border, "0px");
      // The page inside: the reply's HTML with the reply's stylesheet applied, its animation running, scrolling in itself.
      const handle = await x.page.locator(`iframe[data-ground="${theme}"]`).elementHandle(), frame = await handle.contentFrame();
      const inside = await frame.evaluate(() => { const cube = document.querySelector(".cube-ruby"), big = document.querySelector(".cube.big"), grid = document.querySelector(".grid");
        return { title: document.title, cube: getComputedStyle(cube).backgroundColor, grid: getComputedStyle(grid).display, columns: getComputedStyle(grid).gridTemplateColumns.split(" ").length,
          animations: document.getAnimations().filter((a) => a.playState === "running").length, bob: getComputedStyle(big).animationName, scheme: getComputedStyle(document.documentElement).colorScheme,
          ground: getComputedStyle(document.documentElement).backgroundColor, ink: getComputedStyle(document.body).color, wide: document.documentElement.scrollWidth <= innerWidth, mode: document.compatMode }; });
      assert.equal(inside.title, "Cube icon set");
      assert.deepEqual([inside.cube, inside.grid, inside.bob], ["rgb(229, 72, 77)", "grid", "bob"], "the reply's CSS block is applied to its HTML");
      assert.ok(inside.columns >= (width === 700 ? 5 : 2), `laid out at the tab's width (${inside.columns} columns)`);
      assert.ok(inside.animations >= 1, "CSS animations play");
      assert.equal(inside.scheme, theme);
      assert.equal(inside.ground, theme === "dark" ? "rgb(31, 31, 31)" : "rgb(255, 255, 255)", "a neutral ground");
      assert.equal(inside.ink, theme === "dark" ? "rgb(255, 255, 255)" : "rgb(0, 0, 0)", "the page's own default ink for that ground");
      assert.deepEqual([inside.wide, inside.mode], [true, "CSS1Compat"]);
      // The switch, in the corner, by pointer and by keyboard.
      const corner = await x.page.evaluate(() => { const g = document.querySelector('[role="group"]').getBoundingClientRect(); return { right: innerWidth - g.right, top: g.top, height: g.height, width: g.width }; });
      assert.ok(corner.right >= 0 && corner.right <= 16 && corner.top >= 0 && corner.top <= 12, `in the top right corner (${JSON.stringify(corner)})`);
      await x.page.locator(`label[for="ground-${other}"]`).click();
      shown = await frames(x.page);
      assert.deepEqual(shown.filter((f) => f.shown).map((f) => f.ground), [other], "the other ground");
      const otherFrame = await (await x.page.locator(`iframe[data-ground="${other}"]`).elementHandle()).contentFrame();
      assert.equal(await otherFrame.evaluate(() => getComputedStyle(document.documentElement).backgroundColor), other === "dark" ? "rgb(31, 31, 31)" : "rgb(255, 255, 255)");
      assert.equal(await otherFrame.evaluate(() => getComputedStyle(document.querySelector(".cube-ruby")).backgroundColor), "rgb(229, 72, 77)", "the same page on it");
      await x.page.locator(`#ground-${other}`).focus();
      await x.page.keyboard.press(other === "dark" ? "ArrowLeft" : "ArrowRight");
      assert.deepEqual((await frames(x.page)).filter((f) => f.shown).map((f) => f.ground), [theme], "the arrow keys move between the two");
      const focus = await x.page.evaluate(() => { const l = document.querySelector(`label[for="${document.activeElement.id}"]`), s = getComputedStyle(l); return s.outlineStyle !== "none" && parseFloat(s.outlineWidth) >= 1; });
      assert.equal(focus, true, "the keyboard's place on the switch can be seen");
      // Purple at most 10%: the tab's own page has none.
      const purple = await x.page.evaluate(() => [...document.querySelectorAll("body, body *:not(iframe)")].flatMap((n) => { const s = getComputedStyle(n); return [s.color, s.backgroundColor, s.borderTopColor]; }));
      assert.deepEqual(purple.filter(isPurple), []);
      assert.deepEqual(x.requests, [], "nothing was asked for from anywhere (the page's own stylesheet link too)");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("the tab runs no scripts and reaches nothing, whatever the page holds; links and forms do nothing", async (t) => {
  if (skipOrFail(t)) return;
  const hostile = `<!doctype html><html><head><title>Hostile</title><meta http-equiv="refresh" content="0;url=http://192.0.2.7/refresh"><base href="http://192.0.2.7/base/">
<link rel="stylesheet" href="http://192.0.2.7/a.css"><style>@import url("http://192.0.2.7/b.css"); @font-face { font-family: x; src: url("http://192.0.2.7/f.woff2"); } body { font-family: x, sans-serif; background: url("http://192.0.2.7/bg.png"); }</style>
<script src="http://192.0.2.7/s.js"></script><script>document.title = "ran"; fetch("http://192.0.2.7/fetch");</script></head>
<body onload="document.title='onload'"><p id="p">still here</p><img src="http://192.0.2.7/i.png" onerror="document.title='onerror'"><img id="ok" alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==">
<a id="out" href="http://192.0.2.7/link" target="_blank">out</a> <a id="js" href="javascript:document.title='js'">js</a> <a id="same" href="http://192.0.2.7/same">same</a> <a id="in" href="#p">in</a>
<form id="form" action="http://192.0.2.7/form" method="post"><input name="q" value="1"><button id="send">Send</button></form>
<iframe src="http://192.0.2.7/frame"></iframe><object data="http://192.0.2.7/o"></object><embed src="http://192.0.2.7/e"><video src="http://192.0.2.7/v.mp4" autoplay></video>
<svg width="10" height="10"><image href="http://192.0.2.7/svg.png" width="10" height="10"/><a href="http://192.0.2.7/svglink"><rect id="svgout" width="10" height="10"/></a></svg></body></html>`;
  const x = await openTab(browser, { theme: "light", view: { kind: "html", title: "Hostile", html: hostile, css: ['@import url("http://192.0.2.7/c.css"); p { background: url("http://192.0.2.7/p.png"); color: rgb(1, 2, 3); }'] } });
  try {
    const popups = [];
    x.page.context().on("page", (p) => popups.push(p.url()));
    const frame = await (await x.page.locator('iframe[data-ground="light"]').elementHandle()).contentFrame();
    const state = () => frame.evaluate(() => ({ title: document.title, text: document.getElementById("p")?.textContent, ink: getComputedStyle(document.getElementById("p")).color,
      ok: document.getElementById("ok").naturalWidth, url: location.href.replace(/#.*$/, "") })).catch((error) => ({ gone: String(error) }));
    const first = await state();
    assert.deepEqual(first, { title: "Hostile", text: "still here", ink: "rgb(1, 2, 3)", ok: 1, url: "about:srcdoc" }, "no script ran; a data: image and the reply's CSS still draw");
    for (const id of ["out", "js", "same", "in", "send", "svgout"]) {
      await frame.locator(`#${id}`).click({ timeout: 3000 });
      await x.page.waitForTimeout(120);
    }
    await frame.locator("#out").focus(); await x.page.keyboard.press("Enter");
    await frame.locator('input[name="q"]').focus(); await x.page.keyboard.press("Enter");
    await x.page.waitForTimeout(1300);          // past the refresh the page asked for
    assert.deepEqual(await state(), first, "after every link, the form and the refresh: the same page, still there");
    assert.equal(await frame.evaluate(() => location.hash), "", "the last link pressed went nowhere");
    await frame.locator("#in").click();
    assert.equal(await frame.evaluate(() => location.href), "about:srcdoc#p", "a link within the page still moves within it");
    assert.deepEqual(popups, [], "nothing opened");
    assert.deepEqual(x.requests, [], "no request left the tab");
    assert.deepEqual([...new Set(x.refused.map((r) => r.split(" ")[0]))], ["csp"], "what the page asked for was turned away by the tab's policy");
    assert.ok(["a.css", "b.css", "c.css", "i.png", "f.woff2", "bg.png", "p.png", "svg.png"].every((name) => x.refused.some((r) => r.endsWith("/" + name))), `each of them: ${x.refused}`);
    assert.deepEqual([...new Set(x.page.frames().map((f) => f.url().replace(/#.*$/, "")))].sort(), ["about:blank", "about:srcdoc", "chrome-error://chromewebdata/"].sort(),
      "the tab's page, its two grounds, and the page's own frame, which the browser refused to load");
    assert.equal(x.page.url(), "about:blank", "the tab itself went nowhere");
  } finally { await x.close(); }
});

test("an SVG is drawn in the middle of the tab, and a page too large says so", async (t) => {
  if (skipOrFail(t)) return;
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 8 8"><title>Dot</title><circle id="dot" cx="4" cy="4" r="3" fill="#3b9eff"/></svg>';
  const x = await openTab(browser, { theme: "dark", width: 700, view: { kind: "svg", title: "Dot", html: svg, css: [] } });
  try {
    const frame = await (await x.page.locator('iframe[data-ground="dark"]').elementHandle()).contentFrame();
    const at = await frame.evaluate(() => { const r = document.querySelector("svg").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: innerWidth, h: innerHeight, width: r.width }; });
    assert.ok(Math.abs(at.x - at.w / 2) <= 1 && Math.abs(at.y - at.h / 2) <= 1, `centred (${JSON.stringify(at)})`);
    assert.equal(at.width, 120, "at its own size");
    assert.deepEqual(x.requests, []);
  } finally { await x.close(); }
  const big = await openTab(browser, { theme: "dark", width: 300, view: { kind: "html", title: "Big", html: "<p>" + "x".repeat(600 * 1024) + "</p>", css: [] } });
  try {
    const said = await big.page.evaluate(() => { const n = document.querySelector(".too-large"), r = n.getBoundingClientRect(), s = getComputedStyle(n);
      return { text: document.body.innerText.trim(), inside: r.left >= 0 && r.right <= innerWidth, ink: s.color, frames: document.querySelectorAll("iframe").length }; });
    assert.deepEqual([said.text, said.inside, said.frames], ["Too large to preview", true, 0]);
    assert.equal(isPurple(said.ink), false);
  } finally { await big.close(); }
});
