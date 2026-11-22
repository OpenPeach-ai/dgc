// Hover labels stand on a solid ground on every surface, also where the editor's theme gives its input background a
// see-through colour (Cursor's dark themes: #ffffff0d). A label that let the page show through it could not be read
// (22 Nov: "the background of that helper text is transparent"). Menus have stood on one opaque colour since 13 Nov
// (--raised, media/shared/menu.js); the labels take the same: Work's and ChatDGC's .tip, every other page's .dgc-tip
// (media/shared/tip.js), the dock's name label (media/shared/dock.js) and a link's preview card.
// The editor sets its colours on the page's root style, so the test does the same (that is what menu.js watches).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openDock } from "./support/dock-scene.mjs";
import { openHome } from "./support/home-scene.mjs";
import { openChat } from "./support/chat-scene.mjs";
import { openSettings } from "./support/settings-scene.mjs";

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

const CURSOR_INPUT = "#ffffff0d";
const seeThrough = async (page) => {
  await page.evaluate((c) => document.documentElement.style.setProperty("--vscode-input-background", c), CURSOR_INPUT);
  await page.waitForTimeout(200);
};
/** Alpha of a computed colour: "rgb(…)" is 1; "rgba(…, a)" and "color(srgb r g b / a)" carry theirs. */
const alpha = (c) => {
  const s = String(c || "");
  if (/transparent/.test(s)) return 0;
  const slash = s.match(/\/\s*([\d.]+)\s*\)/);
  if (slash) return Number(slash[1]);
  const n = s.match(/-?[\d.]+/g)?.map(Number) || [];
  return s.startsWith("rgba") && n.length >= 4 ? n[3] : 1;
};
/** Point at `target`, wait out the label's delay, and read the shown label's ground (and its arrow's). */
const labelGround = async (page, target, label) => {
  await page.mouse.move(2, 2);
  await page.waitForTimeout(200);
  await page.locator(target).first().hover();
  await page.waitForTimeout(1300);
  return page.evaluate((sel) => {
    const n = [...document.querySelectorAll(sel)].find((el) => !el.hidden && el.getBoundingClientRect().width > 0);
    if (!n) return null;
    const own = getComputedStyle(n), arrow = getComputedStyle(n, "::after");
    return { words: n.textContent.trim().slice(0, 60), ground: own.backgroundColor, image: own.backgroundImage, arrow: arrow.content && arrow.content !== "none" ? arrow.backgroundColor : null };
  }, label);
};
const assertSolid = (where, got) => {
  assert.ok(got, `${where}: a label shows`);
  assert.ok(alpha(got.ground) >= 0.999, `${where}: the label's ground is solid (${JSON.stringify(got)})`);
  if (got.arrow !== null) assert.ok(alpha(got.arrow) >= 0.999, `${where}: its arrow too (${JSON.stringify(got)})`);
};

test("hover labels are solid where the theme's input background is see-through: Home, Work and the dock", async (t) => {
  if (skipOrFail(t)) return;
  const home = await openHome(browser, { width: 320, height: 700 });
  try {
    await seeThrough(home.page);
    assertSolid("Home: a tab's label", await labelGround(home.page, "#side-tab-library", ".tip"));
    assert.deepEqual(home.errors || [], []);
  } finally { await home.close(); }
  const work = await openDock(browser, { tab: "work", width: 420, height: 700 });
  try {
    await seeThrough(work.page);
    assertSolid("the dock: a pin's name", await labelGround(work.page, ".dgc-dock-bar button[data-key]", ".dgc-dock-tip"));
    assertSolid("Work: a button's label", await labelGround(work.page, "button[title]:visible", ".tip"));
  } finally { await work.close(); }
});

test("hover labels are solid where the theme's input background is see-through: ChatDGC and Settings", async (t) => {
  if (skipOrFail(t)) return;
  const chat = await openChat(browser, { width: 700, height: 700 });
  try {
    await seeThrough(chat.page);
    assertSolid("ChatDGC: a button's label", await labelGround(chat.page, "button[title]:visible", ".tip"));
  } finally { await (chat.close ? chat.close() : chat.page.close()); }
  const settings = await openSettings(browser, { width: 900, height: 800, theme: "dark" });
  try {
    await seeThrough(settings.page);
    assertSolid("Settings: a button's label", await labelGround(settings.page, "button[title]:visible", ".dgc-tip"));
  } finally { await settings.close(); }
});

test("a link's preview card and every label's stylesheet take the menus' solid colour, never the bare input grey", async () => {
  const { readFileSync } = await import("node:fs");
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
  const rule = (css, sel) => { const at = css.indexOf(`${sel} {`); assert.ok(at >= 0, `${sel} is styled`); return css.slice(at, css.indexOf("}", at)); };
  for (const [file, sel] of [["media/shared/tip.css", ".dgc-tip"], ["media/shared/tip.css", ".dgc-tip::after"], ["media/main.css", ".tip"], ["media/main.css", ".tip::after"],
    ["media/shared/dock.css", ".dgc-dock-tip"], ["media/shared/linkpreview.css", ".dgc-linkcard"]]) {
    const body = rule(read(file), sel);
    assert.match(body, /background:\s*var\(--raised,\s*var\(--surface2\)\)/, `${file} ${sel}: background var(--raised, var(--surface2))`);
  }
  // Settings shows labels and so keeps --raised up to date too (menu.js reads the theme's colours).
  assert.match(read("src/settingsClient.js"), /import '\.\.\/media\/shared\/menu\.js';/);
});
