import { chromium } from "playwright";
const port = process.argv[2];
const OUT = "/tmp/claude-1000/cap";
const PROMPT = "Do exactly this: call show_file on out/screenshot.png with caption 'the shot', "
  + "then reply with one sentence naming [the clamp helper](src/clamp.py), [the app entry](src/app.ts), "
  + "[the go server](src/main.go), [the rust lib](src/lib.rs), [the stylesheet](src/site.css), "
  + "[the run script](run.sh) and [the Codex repo](https://github.com/openai/codex).";
const wait = async (c, m, ms = 200000) => { const e = Date.now() + ms;
  for (;;) { const v = await c().catch(() => null); if (v) return v;
    if (Date.now() > e) throw new Error(m); await new Promise(r => setTimeout(r, 400)); } };
await wait(async () => (await fetch(`http://127.0.0.1:${port}/json/version`).catch(() => null))?.ok, "no port");
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const page = await wait(async () => { for (const p of browser.contexts().flatMap(c => c.pages()))
  if (await p.locator(".monaco-workbench").count().catch(() => 0)) return p; return null; }, "no workbench");
await page.waitForTimeout(12000);
await page.keyboard.press("Control+Shift+P");
const box = page.locator(".quick-input-widget:visible input");
await box.waitFor({ state: "visible", timeout: 20000 });
await box.fill(">DGC: Focus on DGC View"); await page.waitForTimeout(600);
await page.keyboard.press("Enter");
const frame = await wait(async () => { for (const f of page.frames())
  if (await f.locator("#input").count().catch(() => 0)) return f; return null; }, "no panel");
await page.waitForTimeout(3000);
const side = await page.locator(".part.sidebar").boundingBox().catch(() => null);
if (side) { const edge = side.x + side.width; let best = null, dx = Infinity;
  for (const s of await page.locator(".monaco-sash.vertical").all()) { const b = await s.boundingBox().catch(() => null);
    if (!b) continue; const d = Math.abs(b.x + b.width / 2 - edge); if (d < dx) { dx = d; best = b; } }
  if (best && dx < 24) { const y = best.y + best.height / 2; await page.mouse.move(best.x + best.width / 2, y);
    await page.mouse.down(); await page.mouse.move(940, y, { steps: 20 }); await page.mouse.up(); } }
await page.waitForTimeout(1500);
await frame.locator("#input").click();
await frame.locator("#input").type(PROMPT, { delay: 5 });
await page.keyboard.press("Enter");
await wait(async () => await frame.locator(".response-actions").count().catch(() => 0), "turn never ended", 300000).catch(() => 0);
await page.waitForTimeout(8000);
const report = await frame.evaluate(() => {
  const marks = [...document.querySelectorAll("[data-file-kind]")].map(n => ({
    kind: n.dataset.fileKind, text: n.textContent.trim().slice(0, 28),
    font: getComputedStyle(n, "::before").fontFamily,
    glyph: [...getComputedStyle(n, "::before").content.replace(/"/g, "")].map(c => "U+" + c.codePointAt(0).toString(16).toUpperCase()).join(""),
    color: getComputedStyle(n, "::before").color }));
  const chip = document.querySelector(".chip.made-file");
  return { marks, chip: chip && { text: chip.textContent.trim(), bg: getComputedStyle(chip).backgroundColor,
    border: getComputedStyle(chip).borderTopWidth, kind: chip.dataset.fileKind } };
});
console.log(JSON.stringify(report, null, 2));
await page.screenshot({ path: `${OUT}/40-full.png` });
for (const [n, s] of [["41-answer", ".text"], ["42-chip", ".made-files"]]) {
  const t = frame.locator(s).last();
  if (await t.count().catch(() => 0)) { await t.scrollIntoViewIfNeeded().catch(() => {});
    await t.screenshot({ path: `${OUT}/${n}.png` }).catch(() => {}); } }
console.log("done");
await browser.close().catch(() => {});
