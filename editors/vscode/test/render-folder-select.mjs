// Captures the Project Folder dropdown in its one-shape look (0.52, 13 Nov): dark and light, at 700 and 300 px, from the
// real pages with a stub host: the closed button on the Library row, the menu open there and a frame mid-opening, on the
// Pips view's Needs attention line, and in New Session's dialog; and a short film of it opening and closing (700 px,
// dark). Not a test: run it with
//   PLAYWRIGHT_BROWSERS_PATH=… node test/render-folder-select.mjs [out-dir]
import { mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { openHome } from "./support/home-scene.mjs";
import { openPips } from "./support/project-folder-pips-scene.mjs";
import { listOf } from "./support/folder-row-scene.mjs";

const out = process.argv[2] || join(tmpdir(), "dgc-folder-select-screens");
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] });
const settle = (page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
const shots = [], problems = [];
const shoot = async (x, name, clip) => { const path = join(out, `${name}.png`); await x.page.screenshot({ path, ...(clip ? { clip } : {}) }); shots.push(path); if (x.errors.length) problems.push(`${name}: ${x.errors.join("; ")}`); };
/** The dropdown's own animations held at `ms` after they began (the Pips view's are in its own root). */
const holdAt = (page, ms) => page.evaluate((t) => { const all = [...document.getAnimations(), ...(document.getElementById("pips-host")?.shadowRoot?.getAnimations?.() || [])];
  for (const a of new Set(all)) if (a.effect?.target?.closest?.(".dgc-folder-menu, .dgc-folder")) { a.pause(); a.currentTime = t; } }, ms);
/** Everything that moves once has arrived. */
const rest = (page) => page.evaluate(() => { const all = [...document.getAnimations(), ...(document.getElementById("pips-host")?.shadowRoot?.getAnimations?.() || [])];
  for (const a of new Set(all)) if (Number.isFinite(a.effect?.getComputedTiming?.().endTime)) a.finish(); });

for (const [tone, theme] of [["dark", "dark-modern"], ["light", "light-modern"]]) for (const width of [700, 300]) {
  const tag = `${width}-${tone}`;
  // The Library row: closed, open (All projects, then one folder chosen), and a frame mid-opening.
  let x = await openHome(browser, { theme, width, height: 620, tab: "work", scale: 2 });
  await x.send(listOf(""));
  await settle(x.page);
  await shoot(x, `library-closed-${tag}`);
  await x.page.click("#sessions-folder-pick");
  await holdAt(x.page, 110);
  await shoot(x, `library-opening-${tag}`);
  await rest(x.page);
  await x.page.mouse.move(2, 2);
  await settle(x.page);
  await shoot(x, `library-open-${tag}`);
  // The join, large: the button's corner and the menu's edge.
  const join_ = await x.page.evaluate(() => { const b = document.getElementById("sessions-folder-pick").getBoundingClientRect(); return { x: Math.max(0, b.left - 60), y: b.top - 10, width: Math.min(innerWidth, b.right + 12) - Math.max(0, b.left - 60), height: b.height + 60 }; });
  await shoot(x, `library-join-${tag}`, join_);
  await x.page.keyboard.press("Escape");
  await x.send(listOf("/home/me/code/garden"));
  await settle(x.page);
  await x.page.focus("#sessions-folder-pick");
  await x.page.keyboard.press("ArrowDown");
  await rest(x.page);
  await x.page.keyboard.press("ArrowDown");
  await settle(x.page);
  await shoot(x, `library-open-one-folder-keyboard-${tag}`);
  await x.close();

  // New Session's dialog: the field as wide as the dialog, its menu under it at the same width.
  x = await openHome(browser, { theme, width, height: 620, tab: "work", scale: 2 });
  await x.send(listOf(""));
  await x.page.click("#sessions-new");
  await x.page.waitForSelector("dialog.new-session-dialog[open]");
  await rest(x.page);
  await shoot(x, `new-session-closed-${tag}`);
  await x.page.click("dialog.new-session-dialog .dgc-folder");
  await holdAt(x.page, 110);
  await shoot(x, `new-session-opening-${tag}`);
  await rest(x.page);
  await x.page.mouse.move(2, 2);
  await settle(x.page);
  await shoot(x, `new-session-open-${tag}`);
  await x.close();

  // The Pips view's Project tab: on the Needs attention line.
  x = await openPips(browser, { theme, width, height: 620, scale: 2, motion: "no-preference" });
  await shoot(x, `pips-attention-closed-${tag}`);
  await x.inPips((root) => root.querySelector("#pips-folder-pick").click());
  await holdAt(x.page, 110);
  await shoot(x, `pips-attention-opening-${tag}`);
  await rest(x.page);
  await x.page.mouse.move(2, 2);
  await settle(x.page);
  await shoot(x, `pips-attention-open-${tag}`);
  await x.close();
}

// A short film: it opens, the pointer goes down the rows, it closes; then by the keyboard, and a choice.
{
  const dir = join(out, "film");
  rmSync(dir, { recursive: true, force: true });
  const x = await openHome(browser, { theme: "dark-modern", width: 700, height: 520, tab: "work", video: dir });
  await x.send(listOf(""));
  await x.page.waitForTimeout(500);
  await x.page.hover("#sessions-folder-pick");
  await x.page.waitForTimeout(300);
  await x.page.click("#sessions-folder-pick");
  await x.page.waitForTimeout(900);
  for (const row of await x.page.locator(".dgc-folder-menu .dgc-menu-row").all()) { await row.hover(); await x.page.waitForTimeout(170); }
  await x.page.waitForTimeout(300);
  await x.page.keyboard.press("Escape");
  await x.page.waitForTimeout(800);
  await x.page.keyboard.press("ArrowDown");
  await x.page.waitForTimeout(900);
  await x.page.keyboard.press("ArrowDown"); await x.page.waitForTimeout(200);
  await x.page.keyboard.press("ArrowDown"); await x.page.waitForTimeout(400);
  await x.page.keyboard.press("Enter");
  await x.send(listOf("/home/me/code/garden"));
  await x.page.waitForTimeout(900);
  await x.close();
  const made = readdirSync(dir).find((f) => f.endsWith(".webm"));
  if (made) { renameSync(join(dir, made), join(out, "folder-select-700-dark.webm")); shots.push(join(out, "folder-select-700-dark.webm")); }
  rmSync(dir, { recursive: true, force: true });
}
await browser.close();
console.log(shots.join("\n"));
if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
