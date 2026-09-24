// The three things I have NOT seen with my own eyes: a chip that opens when clicked, two agents
// that hold their places, and the Seti hues on a LIGHT panel.
import { chromium } from "playwright";
const port = process.argv[2];
const OUT = "/tmp/claude-1000/cap";
const wait = async (c, m, ms = 200000) => { const e = Date.now() + ms;
  for (;;) { const v = await c().catch(() => null); if (v) return v;
    if (Date.now() > e) throw new Error(m); await new Promise(r => setTimeout(r, 400)); } };
await wait(async () => (await fetch(`http://127.0.0.1:${port}/json/version`).catch(() => null))?.ok, "no port");
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const page = await wait(async () => { for (const p of browser.contexts().flatMap(c => c.pages()))
  if (await p.locator(".monaco-workbench").count().catch(() => 0)) return p; return null; }, "no workbench");
await page.waitForTimeout(12000);
const palette = async (cmd) => { await page.keyboard.press("Control+Shift+P");
  const b = page.locator(".quick-input-widget:visible input");
  await b.waitFor({ state: "visible", timeout: 20000 }); await b.fill(cmd);
  await page.waitForTimeout(700); await page.keyboard.press("Enter"); await page.waitForTimeout(1200); };
await palette(">DGC: Focus on DGC View");
const frame = await wait(async () => { for (const f of page.frames())
  if (await f.locator("#input").count().catch(() => 0)) return f; return null; }, "no panel");
await page.waitForTimeout(3000);

// ---- 1 + 2: a chip that opens, and two agents that stay put --------------------------------
await frame.locator("#input").click();
await frame.locator("#input").type(
  "Do exactly this, nothing else: call show_file on out/screenshot.png. Then use the task tool "
  + "TWICE in one batch to start two sub-agents, one described 'explorer' and one 'reviewer', "
  + "each asked only to read src/clamp.py and reply with its first line.", { delay: 5 });
await page.keyboard.press("Enter");
await wait(async () => await frame.locator(".chip.made-file").count().catch(() => 0), "no chip appeared", 240000).catch(() => 0);

const chipOrderAt = async () => frame.evaluate(() =>
  [...document.querySelectorAll(".agent-chip")].map((c) => c.dataset.agentId));
const orders = [];
for (let i = 0; i < 6; i++) { orders.push(await chipOrderAt()); await page.waitForTimeout(4000); }
const settled = orders.filter((o) => o.length >= 2);
console.log("agent chip orders sampled during the turn:", JSON.stringify(settled));
console.log("STABLE:", settled.length < 2 || settled.every((o) => o.join() === settled[0].join()));

await page.screenshot({ path: `${OUT}/50-agents-dark.png` });

// Click the chip and see whether an editor actually opens.
const before = await page.evaluate(() => document.title);
const tabsBefore = await page.locator(".tabs-container .tab").count().catch(() => 0);
await frame.locator(".chip.made-file").first().click();
await page.waitForTimeout(4000);
const tabsAfter = await page.locator(".tabs-container .tab").count().catch(() => 0);
const opened = await page.locator(".tabs-container .tab", { hasText: "screenshot.png" }).count().catch(() => 0);
console.log(JSON.stringify({ tabsBefore, tabsAfter, screenshotTabOpen: opened, titleBefore: before,
  titleAfter: await page.evaluate(() => document.title) }));
await page.screenshot({ path: `${OUT}/51-chip-clicked.png` });

// ---- 3: the light theme -------------------------------------------------------------------
await palette(">Preferences: Color Theme");
const box = page.locator(".quick-input-widget:visible input");
await box.fill("Light Modern"); await page.waitForTimeout(900);
await page.keyboard.press("Enter"); await page.waitForTimeout(3500);
const light = await frame.evaluate(() => {
  const body = document.body.className;
  const marks = [...document.querySelectorAll("[data-file-kind]")].slice(0, 8).map((n) => ({
    kind: n.dataset.fileKind, color: getComputedStyle(n, "::before").color }));
  const chip = document.querySelector(".chip.made-file");
  return { body, link: getComputedStyle(document.documentElement).getPropertyValue("--link").trim(),
    yellow: getComputedStyle(document.documentElement).getPropertyValue("--fk-yellow").trim(),
    marks, chipBg: chip && getComputedStyle(chip).backgroundColor };
});
console.log("LIGHT:", JSON.stringify(light, null, 1));
await page.screenshot({ path: `${OUT}/52-light-full.png` });
const ans = frame.locator(".text").last();
if (await ans.count().catch(() => 0)) await ans.screenshot({ path: `${OUT}/53-light-answer.png` }).catch(() => {});
console.log("done");
await browser.close().catch(() => {});
