// Pictures of Work's plan from Work's real page in real Chromium: the Tasks pill, the section it opens and the turn's plan
// card, dark and light, at 300, 440 and 700 px (alone on the bar, and beside other pills); and a contact sheet of a plan
// changing (a step done and the next in progress, then a step added and one removed, then settled).
//   node test/support/agent-todos-pictures.mjs <out-dir>
// Not a *.test.mjs file.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { openTodosScene, PLAN } from "./todos-scene.mjs";

const out = process.argv[2];
if (!out) { console.error("usage: node test/support/agent-todos-pictures.mjs <out-dir>"); process.exit(2); }
mkdirSync(join(out, "sheets"), { recursive: true });
const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] });
const shot = (page, name) => page.screenshot({ path: join(out, `${name}.png`) });
const errors = [];

for (const theme of ["dark-modern", "light-modern"]) {
  const short = theme.startsWith("light") ? "light" : "dark";
  for (const width of [300, 440, 700]) {
    const x = await openTodosScene(browser, { width, height: 820, theme, scale: 2 });
    await x.page.waitForTimeout(1300);           // the plan's clock reads 1s
    await shot(x.page, `card-and-pill-${width}-${short}`);
    await x.openPill();
    await shot(x.page, `pill-open-${width}-${short}`);
    errors.push(...x.errors);
    await x.page.close();
    if (width === 440) continue;
    const y = await openTodosScene(browser, { width, height: 820, theme, scale: 2, kinds: ["goal", "changes"] });
    await shot(y.page, `bar-shared-${width}-${short}`);
    await y.openPill();
    await shot(y.page, `bar-shared-open-${width}-${short}`);
    errors.push(...y.errors);
    await y.page.close();
  }
  // A blocked step and a cancelled one, and a finished plan while the turn still runs.
  const z = await openTodosScene(browser, { width: 440, height: 820, theme, scale: 2, running: false });
  await z.update([{ content: "Read the settings store", status: "done" }, { content: "Write the v2 to v3 migration", status: "done" },
    { content: "Tests for both directions", status: "in_progress" }, { content: "Publish to the marketplace (needs your token)", status: "blocked" },
    { content: "Translate the release notes", status: "cancelled" }, { content: "Update the changelog", status: "pending" }]);
  await z.page.waitForTimeout(3000);
  await z.openPill();
  await shot(z.page, `states-blocked-cancelled-440-${short}`);
  await z.page.keyboard.press("Escape");
  await z.page.evaluate(() => document.activeElement?.blur());
  await z.update(PLAN.map((step) => ({ ...step, status: "done" })));
  await z.page.waitForTimeout(400);
  await shot(z.page, `states-all-done-440-${short}`);
  errors.push(...z.errors);
  await z.page.close();

  // The contact sheet: one plan changing, frame by frame, the card and the pill in each.
  const c = await openTodosScene(browser, { width: 440, height: 820, theme, scale: 2, running: false });
  const frames = [];
  const frame = async (caption) => {
    const card = await c.page.evaluate(() => {
      const r = document.querySelector("#log .todos-card").getBoundingClientRect();
      const line = document.getElementById("rail-line").getBoundingClientRect();
      return { x: 0, y: Math.max(0, r.top - 12), width: innerWidth, height: Math.min(innerHeight, line.bottom + 8) - Math.max(0, r.top - 12) };
    });
    const file = `sheet-${short}-${frames.length + 1}.png`;
    await c.page.screenshot({ path: join(out, "sheets", file), clip: card });
    frames.push({ file, caption });
  };
  await c.page.waitForTimeout(1200);
  await frame("1 · the plan: step 2 in progress");
  // A moment of a change, held still: every animation and transition stopped `ms` into its run.
  const held = async (ms) => {
    await c.page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    await c.page.evaluate((at) => document.getAnimations().forEach((a) => { if (a.playState === "running" && Number.isFinite(a.effect?.getComputedTiming?.().activeDuration)) { a.pause(); a.currentTime = at; } }), ms);
  };
  const go = () => c.page.evaluate(() => document.getAnimations().forEach((a) => { if (a.playState === "paused") a.play(); }));
  await c.update([PLAN[0], { ...PLAN[1], status: "done" }, { ...PLAN[2], status: "in_progress" }, PLAN[3], PLAN[4]]);
  await held(150);
  await frame("2 · step 2 done (its check drawing), step 3 starts");
  await go();
  await c.page.waitForTimeout(1500);
  await c.update([PLAN[0], { ...PLAN[1], status: "done" }, { ...PLAN[2], status: "in_progress" },
    { content: "Cancel stale requests", status: "pending" }, PLAN[4]]);
  await held(25);
  await frame("3 · plan changed: one removed (struck, folding away), one added (lit, sliding in)");
  await go();
  await c.page.waitForTimeout(600);
  await frame("4 · the struck step gone; the note still says it");
  await c.page.waitForTimeout(2600);
  await frame("5 · settled");
  errors.push(...c.errors);
  await c.page.close();
  const sheet = await browser.newPage({ viewport: { width: 1500, height: 100 }, deviceScaleFactor: 1 });
  const ground = short === "light" ? "#ffffff" : "#111111", ink = short === "light" ? "#222" : "#ddd";
  await sheet.setContent(`<body style="margin:0;padding:16px;background:${ground};color:${ink};font:13px system-ui">
    <div style="display:grid;grid-template-columns:repeat(3, 1fr);gap:16px;align-items:start">${frames.map((f) =>
      `<figure style="margin:0"><img style="width:100%;border:1px solid #8884" src="data:image/png;base64,${readFileSync(join(out, "sheets", f.file)).toString("base64")}"><figcaption style="padding-top:6px">${f.caption}</figcaption></figure>`).join("")}</div></body>`);
  await sheet.screenshot({ path: join(out, `contact-sheet-plan-changing-${short}.png`), fullPage: true });
  await sheet.close();
}
await browser.close();
console.log(errors.length ? `page errors: ${errors.join("\n")}` : "no page errors");
