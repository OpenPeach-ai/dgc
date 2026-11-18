// A picture in a chat opens in a pop-up inside the chat (his ask, 18 Nov: "clicking it opens up in the editor, maybe chat
// can open that image as a image pop up inside chat itself? where user can download from there too"). The ONE module,
// media/shared/picturepop.js, in real Chromium: the picture large over a dim backdrop, its name and size, its actions as
// icons (Download, Save to Library, Open in editor, Close: one action, one icon, the 6px corner, never a pill); Escape,
// a click outside and Close close it; the arrows step through the message's pictures; focus goes in and comes back;
// both themes from 300 to 1200 px; and no motion for those who asked for none. Pictures of it are kept for the report.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { chromiumOrNull } from "./support/look-probe.mjs";
import { THEMES } from "./support/pip-chat-scene.mjs";

const here = new URL(".", import.meta.url).pathname;
const read = (p) => readFileSync(here + "../media/" + p, "utf8");
const chromium = await chromiumOrNull();
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
const PICTURES = process.env.DGC_PICTURES_DIR || `${homedir()}/dgc-work/052-plan/image-popup-build/pictures`;

/** A picture of `w`×`h` drawn by the page (a gradient with a mark), as a PNG data URI. */
const drawn = (w, h, hue) => `(() => { const c = document.createElement("canvas"); c.width = ${w}; c.height = ${h}; const g = c.getContext("2d");
  const grad = g.createLinearGradient(0, 0, ${w}, ${h}); grad.addColorStop(0, "hsl(${hue},70%,55%)"); grad.addColorStop(1, "hsl(${hue + 60},70%,35%)");
  g.fillStyle = grad; g.fillRect(0, 0, ${w}, ${h}); g.fillStyle = "rgba(255,255,255,.85)"; g.beginPath(); g.arc(${w / 2}, ${h / 2}, ${Math.min(w, h) / 5}, 0, 7); g.fill();
  return c.toDataURL("image/png"); })()`;

async function open(width, { theme = "dark", height = 760, reduced = false, pictures = 3, library = "can", load = false } = {}) {
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: reduced ? "reduce" : "no-preference" });
  const page = await context.newPage();
  await page.setContent(`<!doctype html><html><head><style>${THEMES[theme].css}</style><style>${read("shared/tokens.css")}</style><style>${read("shared/picturepop.css")}</style>
    <style>body{margin:0;background:var(--vscode-sideBar-background);color:var(--vscode-foreground);font-family:var(--vscode-font-family)} .chat{padding:16px} .chat img{width:120px;height:80px;object-fit:cover;border-radius:8px;cursor:zoom-in}</style></head>
    <body class="${THEMES[theme].kind}"><div class="chat"><p>Here are the café's three fronts.</p><button id="before">Before</button><img id="thumb" alt="Picture 1" tabindex="0"><button id="after">After</button></div></body></html>`);
  for (const script of ["shared/menu.js", "shared/icons.js", "shared/download.js", "shared/picturepop.js"]) await page.addScriptTag({ content: read(script) });
  await page.evaluate(([n, library, load, sources]) => {
    window.__asked = []; window.__kept = []; window.__editor = [];
    const srcs = sources.map((s) => (0, eval)(s));
    document.getElementById("thumb").src = srcs[0];
    window.__pictures = srcs.slice(0, n).map((src, i) => ({ key: `m:${i}`, src, name: `Picture ${i + 1}.png`, bytes: 48_213 * (i + 1), width: [1600, 900, 1200][i], height: [900, 1200, 1200][i], mime: "image/png", library: i === 1 && library === "can" ? "in" : library }));
    window.__open = () => window.DgcPicturePop.open({ pictures: window.__pictures, index: 0, opener: document.getElementById("thumb"),
      onLibrary: (p) => { window.__kept.push(p.key); return new Promise((done) => setTimeout(() => done({ in_library: true, kept: true }), 50)); },
      onEditor: (p) => window.__editor.push(p.key),
      ...(load ? { load: (p) => { window.__asked.push(p.key); return Promise.resolve(p.src); } } : {}) });
    document.getElementById("thumb").addEventListener("click", () => window.__open());
  }, [pictures, library, load, [drawn(1600, 900, 210), drawn(900, 1200, 20), drawn(1200, 1200, 120)]]);
  return { page, context, close: () => context.close() };
}
const box = (page, sel) => page.locator(sel).first().boundingBox();

test("a picture opens large over a dim backdrop, with its name, its size and four actions as icons", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open(700);
  try {
    await x.page.click("#thumb");
    const dialog = x.page.locator(".dgc-picpop");
    assert.equal(await dialog.getAttribute("role"), "dialog");
    assert.equal(await dialog.getAttribute("aria-modal"), "true");
    assert.equal(await dialog.getAttribute("aria-label"), "Picture: Picture 1.png");
    assert.equal(await x.page.textContent(".dgc-picpop-name"), "Picture 1.png");
    assert.equal(await x.page.textContent(".dgc-picpop-meta"), "1600 × 900 · 47 KB · 1 of 3");
    const look = await x.page.evaluate(() => {
      const bg = getComputedStyle(document.querySelector(".dgc-picpop")).backgroundColor;
      return { bg, acts: [...document.querySelectorAll(".dgc-picpop-acts button")].map((b) => ({ label: b.getAttribute("aria-label"), radius: getComputedStyle(b).borderTopLeftRadius,
        w: b.getBoundingClientRect().width, h: b.getBoundingClientRect().height, icon: b.querySelector("svg")?.dataset.icon || "", words: b.textContent.trim() })) };
    });
    assert.match(look.bg, /^(rgba\(0, 0, 0, 0\.6\d*\)|color\(srgb 0 0 0 \/ 0\.6\d*\))$/, "a dim backdrop");
    assert.deepEqual(look.acts.map((a) => [a.label, a.icon]), [["Download", "download"], ["Save to Library", "library"], ["Open in editor", "go-to-file"], ["Close", "close"]],
      "one action, one icon: Download draws Save's, Save to Library the Library's");
    for (const a of look.acts) {
      assert.equal(a.radius, "6px", `${a.label}: the button family's corner, never a pill`);
      assert.deepEqual([a.w, a.h], [28, 28], `${a.label}: the button height`);
      assert.equal(a.words, "", `${a.label}: an icon, its words for a tip and a screen reader`);
    }
    const [img, view] = [await box(x.page, ".dgc-picpop-img"), x.page.viewportSize()];
    assert.ok(Math.abs(img.x + img.width / 2 - view.width / 2) < 2, "centred across");
    assert.ok(img.width > 500, "large: most of the window");
  } finally { await x.close(); }
});

test("Escape, a click outside and Close close it, and focus goes in and comes back; Tab stays inside", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open(700);
  try {
    const focused = () => x.page.evaluate(() => document.activeElement?.getAttribute("aria-label") || document.activeElement?.id || "");
    await x.page.focus("#thumb");
    await x.page.keyboard.press("Enter");
    await x.page.evaluate(() => window.__open());
    assert.equal(await focused(), "Close", "focus moves into it");
    const stops = [];
    for (let i = 0; i < 7; i++) { await x.page.keyboard.press("Tab"); stops.push(await focused()); }
    assert.ok(stops.every((s) => ["Download", "Save to Library", "Open in editor", "Close", "Previous picture", "Next picture"].includes(s)), `Tab stays inside: ${stops}`);
    await x.page.keyboard.press("Shift+Tab");
    assert.ok(await x.page.evaluate(() => !!document.activeElement.closest(".dgc-picpop")), "Shift+Tab too");
    await x.page.keyboard.press("Escape");
    assert.equal(await x.page.locator(".dgc-picpop").count(), 0, "Escape closes it");
    assert.equal(await focused(), "thumb", "and focus is back on the picture it opened from");
    await x.page.click("#thumb");
    await x.page.mouse.click(4, 4);
    assert.equal(await x.page.locator(".dgc-picpop").count(), 0, "a click outside closes it");
    await x.page.click("#thumb");
    await x.page.click('.dgc-picpop [data-act="close"]');
    assert.equal(await x.page.locator(".dgc-picpop").count(), 0, "Close closes it");
  } finally { await x.close(); }
});

test("the arrows step through the message's pictures, both ways, round", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open(700);
  try {
    await x.page.click("#thumb");
    const meta = () => x.page.textContent(".dgc-picpop-meta");
    await x.page.keyboard.press("ArrowRight");
    assert.equal(await meta(), "900 × 1200 · 94 KB · 2 of 3");
    assert.equal(await x.page.textContent(".dgc-picpop-name"), "Picture 2.png");
    await x.page.click('[data-act="next"]');
    assert.match(await meta(), /3 of 3$/);
    await x.page.keyboard.press("ArrowRight");
    assert.match(await meta(), /1 of 3$/, "round to the first");
    await x.page.keyboard.press("ArrowLeft");
    assert.match(await meta(), /3 of 3$/);
    const one = await open(700, { pictures: 1 });
    try {
      await one.page.click("#thumb");
      assert.equal(await one.page.locator('[data-act="prev"], [data-act="next"]').count(), 0, "one picture: no arrows");
      assert.equal(await one.page.textContent(".dgc-picpop-meta"), "1600 × 900 · 47 KB");
    } finally { await one.close(); }
  } finally { await x.close(); }
});

test("Download saves the picture on this computer from the page; Open in editor is the old way", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open(700, { load: true });
  try {
    await x.page.click("#thumb");
    const caught = x.page.waitForEvent("download");
    await x.page.click('[data-act="download"]');
    const download = await caught;
    assert.equal(download.suggestedFilename(), "Picture 1.png");
    const bytes = readFileSync(await download.path());
    assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "the picture itself, a PNG");
    assert.equal(await (await x.page.waitForSelector(".dgc-download-said")).textContent(), "Downloaded");
    assert.ok((await x.page.evaluate(() => window.__asked)).includes("m:0"), "the original asked for, not the chat's small copy");
    await x.page.click('[data-act="editor"]');
    assert.deepEqual(await x.page.evaluate(() => window.__editor), ["m:0"]);
  } finally { await x.close(); }
});

test("Save to Library keeps it once: then In Library, off; one already there says so from the start; none offered, none shown", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open(700);
  try {
    await x.page.click("#thumb");
    const lib = x.page.locator('.dgc-picpop [data-act="library"]');
    assert.equal(await lib.getAttribute("aria-label"), "Save to Library");
    await lib.click();
    await x.page.waitForFunction(() => document.querySelector('.dgc-picpop [data-act="library"]').getAttribute("aria-label") === "In Library");
    assert.equal(await lib.isDisabled(), true, "off: nothing is kept twice");
    assert.deepEqual(await x.page.evaluate(() => window.__kept), ["m:0"]);
    await lib.click({ force: true });
    assert.deepEqual(await x.page.evaluate(() => window.__kept), ["m:0"], "a second press keeps nothing");
    await x.page.keyboard.press("ArrowRight");
    assert.equal(await lib.getAttribute("aria-label"), "In Library", "the generated one is in the Library already");
    assert.equal(await lib.isDisabled(), true);
    const none = await open(700, { library: "" });
    try {
      await none.page.click("#thumb");
      assert.equal(await none.page.locator('.dgc-picpop [data-act="library"]').isHidden(), true, "an older DGC: no Save to Library");
    } finally { await none.close(); }
  } finally { await x.close(); }
});

test("it fits from 300 to 1200 px in both themes, and is kept as pictures for the report", async (t) => {
  if (skipOrFail(t)) return;
  try { mkdirSync(PICTURES, { recursive: true }); } catch { /* no pictures, still checked */ }
  for (const theme of ["dark", "light"]) {
    for (const width of [300, 440, 700, 1200]) {
      const x = await open(width, { theme, height: width < 500 ? 640 : 760 });
      try {
        await x.page.click("#thumb");
        await x.page.waitForTimeout(220);
        const fit = await x.page.evaluate(() => {
          const r = (s) => document.querySelector(s).getBoundingClientRect();
          const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
          const inside = (a, b) => a.left >= b.left - 0.5 && a.right <= b.right + 0.5 && a.top >= b.top - 0.5 && a.bottom <= b.bottom + 0.5;
          const boxR = r(".dgc-picpop-box"), img = r(".dgc-picpop-img");
          return { scroll: document.documentElement.scrollWidth > vw, box: inside(boxR, { left: 0, right: vw, top: 0, bottom: vh }),
                   img: inside(img, boxR), acts: [...document.querySelectorAll(".dgc-picpop-acts button")].every((b) => inside(b.getBoundingClientRect(), boxR)),
                   name: getComputedStyle(document.querySelector(".dgc-picpop-name")).textOverflow, ink: getComputedStyle(document.querySelector(".dgc-picpop-box")).color };
        });
        assert.equal(fit.scroll, false, `${theme} ${width}: no sideways scroll`);
        assert.ok(fit.box && fit.img && fit.acts, `${theme} ${width}: the box, the picture and every action inside the window: ${JSON.stringify(fit)}`);
        assert.equal(fit.name, "ellipsis", "a long name is cut, never pushed out");
        await x.page.screenshot({ path: `${PICTURES}/popup-${theme}-${width}.png` }).catch(() => {});
      } finally { await x.close(); }
    }
  }
});

// One action, one icon (his standing rule, 16 Nov): Download is the arrow into a tray a file's card wears, the icon
// module's own entry, in the pop-up as on a row.
test("the pop-up's Download is the one Download glyph, the very drawing a file's row wears", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open(700);
  try {
    await x.page.addScriptTag({ content: read("shared/filesheet.js") });
    await x.page.click("#thumb");
    const seen = await x.page.evaluate(() => {
      const glyph = (svg) => svg ? [svg.dataset.icon || "", [...svg.querySelectorAll("path")].map((p) => p.getAttribute("d")).join("|")] : null;
      const box = document.createElement("div"); box.innerHTML = window.DgcFileSheet.DOWNLOAD;
      return { pop: glyph(document.querySelector('.dgc-picpop [data-act="download"] svg')), row: glyph(box.querySelector("svg")),
               save: glyph(new DOMParser().parseFromString(window.DgcIcons.html("save"), "text/html").querySelector("svg")) };
    });
    assert.deepEqual(seen.pop, ["download", "M8 2.5v8M4.8 7.5 8 10.7l3.2-3.2M3 13h10"], "the arrow into a tray");
    assert.deepEqual(seen.row, seen.pop, "a file's row (Download, Save a copy…) draws the same one");
    assert.deepEqual(seen.save, seen.pop, "Save a copy… is the same action: the same glyph");
  } finally { await x.close(); }
});

test("a note saying what happened takes the hover label's place: never both at once", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open(700);
  try {
    await x.page.addScriptTag({ content: read("shared/tip.js") });
    await x.page.addStyleTag({ content: ".tip { position: fixed; z-index: 1001; padding: 2px 6px; background: #333; color: #fff; }" });
    await x.page.evaluate(() => window.DgcTip.install({ look: "tip" }));
    await x.page.click("#thumb");
    await x.page.hover('.dgc-picpop [data-act="download"]');
    await x.page.waitForSelector(".tip:not([hidden])", { timeout: 3000 });
    // Save to Library pressed from the keyboard while the pointer rests on Download: "Saved to Library" shows.
    await x.page.evaluate(() => document.querySelector('.dgc-picpop [data-act="library"]').click());
    await x.page.waitForSelector(".dgc-download-said", { timeout: 3000 });
    assert.equal(await x.page.locator(".tip:not([hidden])").count(), 0, "the label hides while the note stands");
    await x.page.mouse.move(10, 10); await x.page.hover('.dgc-picpop [data-act="editor"]'); await x.page.waitForTimeout(900);
    assert.equal(await x.page.locator(".tip:not([hidden])").count(), 0, "and no label comes back over it while it stands");
    await x.page.waitForTimeout(1200);
    await x.page.mouse.move(10, 10); await x.page.hover('.dgc-picpop [data-act="close"]');
    await x.page.waitForSelector(".tip:not([hidden])", { timeout: 3000 });
  } finally { await x.close(); }
});

test("one note at a time: Saved to Library takes Downloaded's place, never over it", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open(700);
  try {
    await x.page.click("#thumb");
    const caught = x.page.waitForEvent("download");
    await x.page.click('.dgc-picpop [data-act="download"]');
    await caught;
    assert.deepEqual(await x.page.locator(".dgc-file-said").allTextContents(), ["Downloaded"]);
    await x.page.click('.dgc-picpop [data-act="library"]');
    await x.page.waitForFunction(() => [...document.querySelectorAll(".dgc-file-said")].some((n) => n.textContent === "Saved to Library"));
    assert.deepEqual(await x.page.locator(".dgc-file-said").allTextContents(), ["Saved to Library"]);
  } finally { await x.close(); }
});

test("no motion for those who asked for none", async (t) => {
  if (skipOrFail(t)) return;
  const moving = await open(700), still = await open(700, { reduced: true });
  try {
    await moving.page.click("#thumb"); await still.page.click("#thumb");
    assert.equal(await moving.page.evaluate(() => getComputedStyle(document.querySelector(".dgc-picpop")).animationName), "dgc-picpop-in");
    assert.equal(await still.page.evaluate(() => getComputedStyle(document.querySelector(".dgc-picpop")).animationName), "none");
  } finally { await moving.close(); await still.close(); }
});
