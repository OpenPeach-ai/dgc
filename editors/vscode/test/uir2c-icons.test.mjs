// One action, one icon, on every surface (his call, 16 Nov): Open in editor, More, Back, Settings, New/Add, Close, Copy,
// Delete, Pin, Unpin, Archive, Stop and Save each draw one glyph wherever they are (media/shared/icons.js,
// window.DgcIcons): Work's rows, header and menus, ChatDGC, a Pip's list, chat and page, Home, the Library, the dock.
// In real Chromium on the real pages: every control is read with the action its name says and the glyph it draws.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { JSDOM } from "jsdom";
import { chromiumOrNull } from "./support/look-probe.mjs";
import { launchArgs, ACTION_OF } from "./support/uir2c-scene.mjs";
import { openDock } from "./support/dock-scene.mjs";
import { openOnePips, MORNINGS } from "./support/one-pips-scene.mjs";
import { cleanup } from "./support/panel-bundle.mjs";
import { GLYPH, GLYPH_PLACES, walkGlyphs, glyphFaults, sizeFaults } from "./support/icon-walk.mjs";

const chromium = await chromiumOrNull();
let browser;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "";
  if (!reason) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};
before(async () => { if (!chromium) return; try { browser = await chromium.launch({ args: launchArgs }); } catch { browser = null; } });
after(async () => { await browser?.close(); cleanup(); });
const ICONS = new URL("../media/shared/icons.js", import.meta.url);
const walk = () => walkGlyphs(browser);

test("on every surface, two controls with the same action draw the same glyph, and it is the action's one glyph", async (t) => {
  if (skipOrFail(t)) return;
  const found = await walk();
  const places = new Set(found.map((f) => f.where.replace(/ \(a More menu\)$/, "")));
  for (const need of GLYPH_PLACES) assert.ok(places.has(need), `premise: ${need} draws controls with these actions`);
  const { off, byAction } = glyphFaults(found);
  assert.deepEqual(off, [], "one action, one glyph");
  for (const action of ["open-in-editor", "more", "back", "settings", "add", "close", "copy", "delete", "pin", "stop"]) assert.ok(byAction.has(action), `premise: ${action} is drawn somewhere on these pages`);
  // Open in editor is on Work's rows, the Pips list and a Pip's chat header: the three that differed.
  const open = found.filter((f) => f.action === "open-in-editor").map((f) => f.where.replace(/ \(a More menu\)$/, ""));
  for (const need of ["Work's list", "the Pips list (side)", "a Pip's chat from the list (tab)"]) assert.ok(open.includes(need), `Open in editor is drawn on ${need}`);
});

test("a glyph is 16 px in a header or row button and 15 px in a menu row, on every surface", async (t) => {
  if (skipOrFail(t)) return;
  // (Which controls are held to the two sizes, and why the others are not: support/icon-walk.mjs, sizeFaults.)
  const off = sizeFaults(await walk());
  assert.deepEqual([...new Set(off)], []);
});

test("DgcIcons: one glyph per action, as an inline drawing and by its icon-font name; the drawing is the font's own outline", async (t) => {
  assert.ok(existsSync(ICONS), "media/shared/icons.js is there");
  const dom = new JSDOM("<!doctype html><body></body>", { runScripts: "outside-only" });
  dom.window.eval(readFileSync(new URL("../media/shared/menu.js", import.meta.url), "utf8")); dom.window.eval(readFileSync(ICONS, "utf8"));
  const I = dom.window.DgcIcons;
  for (const [action, glyph] of Object.entries(GLYPH)) {
    const html = I.html(action); dom.window.document.body.innerHTML = html; const svg = dom.window.document.body.querySelector("svg");
    assert.ok(svg, `${action}: a drawing`); assert.equal(svg.dataset.icon, glyph, action); assert.equal(svg.getAttribute("width"), action === "more" ? "14" : "16"); assert.equal(svg.getAttribute("aria-hidden"), "true");
    dom.window.document.body.innerHTML = I.html(action, { size: 15 }); assert.equal(dom.window.document.body.querySelector("svg").getAttribute("width"), "15");
    assert.equal(I.name(action), glyph);
  }
  assert.equal(I.html("no-such-action"), "", "an action it doesn't know draws nothing");
  assert.equal(I.codicon("open-in-editor"), "go-to-file"); assert.equal(I.codicon("more"), "", "More is DGC's own three dots, not a font glyph");
  assert.equal(I.html("more"), dom.window.DgcMenu.DOTS, "More is the menus' own three dots, the same drawing");
  const actionOf = (0, eval)(ACTION_OF);
  for (const [label, action] of [["Open in editor: Fix the login", "open-in-editor"], ["More for Mornings", "more"], ["Save a copy…", "save"], ["Unpin from the dock", "unpin"]]) { assert.equal(actionOf(label), action); assert.equal(I.forLabel(label), action, label); }
  if (skipOrFail(t)) return;
  // The inline drawing against the icon font's glyph of the same name, both painted at 64 px: the same shape.
  const page = await browser.newPage({ viewport: { width: 900, height: 400 } });
  try {
    const font = readFileSync(new URL("../media/codicon.ttf", import.meta.url)).toString("base64"), css = readFileSync(new URL("../media/codicon.css", import.meta.url), "utf8").replace(/url\([^)]*codicon\.ttf[^)]*\)/, `url("data:font/ttf;base64,${font}")`);
    await page.setContent(`<style>${css} body{margin:0;background:#fff;color:#000} .cell{display:inline-block;width:64px;height:64px;line-height:64px;font-size:64px;overflow:hidden;vertical-align:top} .cell .codicon{font-size:64px} .cell svg{display:block}</style><div id="a"></div>`);
    await page.addScriptTag({ content: readFileSync(new URL("../media/shared/menu.js", import.meta.url), "utf8") + "\n" + readFileSync(ICONS, "utf8") });
    const names = Object.entries(GLYPH).filter(([action]) => !["more", "pin", "unpin", "archive"].includes(action));
    await page.evaluate((names) => { document.getElementById("a").innerHTML = names.map(([action, glyph]) => `<span class="cell" data-f="${glyph}"><span class="codicon codicon-${glyph}"></span></span><span class="cell" data-s="${glyph}">${window.DgcIcons.html(action, { size: 64 })}</span>`).join(""); }, names);
    await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(200);
    for (const [, glyph] of names) {
      const a = await page.locator(`[data-f="${glyph}"]`).screenshot(), b = await page.locator(`[data-s="${glyph}"]`).screenshot();
      const differ = await page.evaluate(async ([one, two]) => { const read = async (b64) => { const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob()); const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext("2d"); g.drawImage(bmp, 0, 0); return g.getImageData(0, 0, bmp.width, bmp.height).data; };
        const [p, q] = [await read(one), await read(two)]; let n = 0, ink = 0; for (let i = 0; i < p.length; i += 4) { if (p[i] < 128) ink++; if ((p[i] < 128) !== (q[i] < 128)) n++; } return { n, ink }; }, [a.toString("base64"), b.toString("base64")]);
      assert.ok(differ.ink > 100, `${glyph}: the font's glyph is painted`);
      assert.ok(differ.n <= differ.ink * 0.12, `${glyph}: the drawing is the font's glyph (${differ.n} of ${differ.ink} inked pixels differ)`);
    }
  } finally { await page.close(); }
});

// His complaint (16 Nov): a Pip's Open in editor didn't look like a Work session's. The same rows in a row's ⋯ and a
// chat's ⋯ wear Work's glyphs too, not words alone.
test("Open in editor, Pin and Unpin wear the same glyph in Work's row menu, a Pip's row menu and a Pip chat's menu", async (t) => {
  if (skipOrFail(t)) return;
  const read = (root) => [...root.querySelectorAll('[role="menu"] button, [role="menu"] [role="menuitem"], .dgc-menu button, .dgc-blob button, .dgc-pop button')]
    .filter((b) => b.getClientRects().length).map((b) => { const words = (b.querySelector(".dgc-menu-label")?.textContent || b.textContent || "").replace(/\s+/g, " ").trim();
      const svg = b.querySelector("svg[data-icon]"), font = b.querySelector(".codicon");
      return [words, svg ? svg.dataset.icon : font ? ([...font.classList].find((c) => c.startsWith("codicon-")) || "").slice(8) : ""]; })
    .filter(([w]) => /^(Open in editor|Pin to the dock|Unpin from the dock)$/.test(w));
  const seen = {};
  { const x = await openDock(browser, { tab: "work", width: 440 });
    try { await x.page.hover("#sessions-list .session-row"); await x.page.click("#sessions-list .session-row .session-more"); await x.page.waitForTimeout(200);
      seen["Work's row menu"] = await x.page.evaluate(`(${read})(document)`); } finally { await x.page.close(); } }
  { const x = await openOnePips(browser, { where: "side", width: 300, api: 103 });
    try { await x.inPips((root) => root.querySelector(".job-more")?.click()); await x.page.waitForTimeout(200); seen["a Pip's row menu"] = await x.inPips(read);
      await x.page.keyboard.press("Escape"); await x.openPip(MORNINGS);
      await x.inPips((root) => { const d = root.querySelector('.pip-menu[data-details="pip-menu"]'); if (d) d.open = true; }); await x.page.waitForTimeout(150);
      seen["a Pip chat's menu"] = await x.inPips(read); } finally { await x.close(); } }
  assert.deepEqual(Object.keys(seen).filter((k) => !seen[k].length), [], `premise: each menu has these rows: ${JSON.stringify(seen)}`);
  const off = Object.entries(seen).flatMap(([where, rows]) => rows.filter(([w, g]) => g !== { "Open in editor": "go-to-file", "Pin to the dock": "pin", "Unpin from the dock": "unpin" }[w]).map(([w, g]) => `${where}: “${w}” draws ${g || "no glyph"}`));
  assert.deepEqual(off, []);
});
