// The visual polish pass's sweep (0.52, 14 Nov; not a test): every screen of the side bar and the editor tabs, at 300,
// 440 and 700 px, dark and light, with a mouse and as a touch screen, each walked by test/support/polish-audit.mjs and
// pictured. Writes <out>/sweep.json (what was measured, by screen) and <out>/sweep/<screen>.png.
//   PLAYWRIGHT_BROWSERS_PATH=~/.cache/ms-playwright node test/render-polish-sweep.mjs <out> [only: the start of a scene's name] [widths: 300,440,700] [themes: dark,light] [inputs: mouse,touch]
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { audit, focusAudit, markHoverHolders, markHot } from "./support/polish-audit.mjs";
import { SCENES } from "./support/polish-scenes.mjs";

const out = process.argv[2]; if (!out) throw new Error("say where the sweep goes");
const only = (process.argv[3] || "").split(",").filter(Boolean), widths = (process.argv[4] || "300,440,700").split(",").map(Number), themes = (process.argv[5] || "dark,light").split(","), inputs = (process.argv[6] || "mouse,touch").split(",");
mkdirSync(`${out}/sweep`, { recursive: true });
const hotWidth = widths.includes(440) ? 440 : widths[0];
const real = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] });
/** A browser whose every page is a touch screen (no pointer to hover with). */
const touchBrowser = new Proxy(real, { get(target, key) {
  if (key === "newContext") return (o = {}) => target.newContext({ ...o, hasTouch: true });
  if (key === "newPage") return (o = {}) => target.newPage({ ...o, hasTouch: true });
  const v = target[key]; return typeof v === "function" ? v.bind(target) : v; } });
const file = `${out}/sweep.json`, results = existsSync(file) && only.length ? JSON.parse(readFileSync(file, "utf8")) : {};
const save = () => writeFileSync(file, JSON.stringify(results, null, 1));
const rest = (page, ms = 120) => page.evaluate((n) => new Promise((d) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(d, n)))), ms);

for (const [scene, run] of Object.entries(SCENES)) {
  if (only.length && !only.some((o) => scene.startsWith(o))) continue;
  for (const theme of themes) for (const width of widths) for (const input of inputs) {
    const browser = input === "touch" ? touchBrowser : real, tag = `${width}-${theme}-${input}`, started = Date.now();
    /** One state of the scene, on screen: pictured and measured. `o`: { scope, hover: false to skip pointing, focus: false to skip the keyboard walk }. */
    const visit = async (state, page, o = {}) => {
      const key = `${scene}/${state}/${tag}`, pic = `${scene}--${state}--${tag}`.replace(/[^\w.-]+/g, "_");
      try {
        if (input === "mouse") await page.mouse.move(1, 1); await rest(page);
        await page.screenshot({ path: `${out}/sweep/${pic}.png` });
        const found = await page.evaluate(audit, { scope: o.scope || "", touch: input === "touch" });
        if (input === "mouse") {
          if (o.focus !== false) { await page.keyboard.press("Shift"); found.focus = await page.evaluate(focusAudit, { scope: o.scope || "" }); await rest(page, 30); }
          if (o.hover !== false) {
            const n = await page.evaluate(markHoverHolders); found.hover = [];
            for (let k = 0; k < Math.min(n, 14); k++) {
              const sel = `[data-polish-hover="${k}"]`, holder = page.locator(sel).first();
              try { await holder.hover({ timeout: 1500 }); await rest(page, 220);
                const h = await page.evaluate(audit, { scope: sel }); const box = await holder.boundingBox();
                const bad = h.overlap.filter((x) => !x.floating || true).length + h.covered.length + h.contrast.length + h.level.length + h.cut.length;
                if (bad && box) { const clip = { x: Math.max(0, box.x - 8), y: Math.max(0, box.y - 8), width: Math.min(width - Math.max(0, box.x - 8), box.width + 16), height: Math.min(box.height + 16, 400) };
                  await page.screenshot({ path: `${out}/sweep/${pic}--hover${k}.png`, clip }).catch(() => {}); }
                found.hover.push({ k, what: await holder.evaluate((e) => `${e.tagName.toLowerCase()}.${String(e.className).split(/\s+/).slice(0, 3).join(".")}`), overlap: h.overlap, covered: h.covered, contrast: h.contrast, level: h.level, cut: h.cut });
              } catch (error) { found.hover.push({ k, error: String(error).slice(0, 120) }); }
            }
            // Pointed at, what a control, a row or a card lights up as: its words must still read (once a theme, at the middle width).
            if (width === hotWidth && o.hot !== false) { found.hot = [];
              for (const h of await page.evaluate(markHot)) { try { await page.mouse.move(h.x, h.y); await rest(page, 200);
                const q = await page.evaluate(audit, { scope: `[data-polish-hot="${h.n}"]`, quick: true });
                if (q.contrast.length) { found.hot.push({ what: h.what, contrast: q.contrast }); const clip = { x: Math.max(0, h.x - 150), y: Math.max(0, h.y - 40), width: Math.min(width - Math.max(0, h.x - 150), 300), height: 80 }; await page.screenshot({ path: `${out}/sweep/${pic}--hot${h.n}.png`, clip }).catch(() => {}); }
              } catch { /* it went away */ } }
              await page.evaluate(() => { const walk = (root) => { for (const n of root.querySelectorAll("*")) { if (n.dataset?.polishHot) delete n.dataset.polishHot; if (n.shadowRoot) walk(n.shadowRoot); } }; walk(document); }); }
            await page.mouse.move(1, 1); await page.evaluate(() => { const walk = (root) => { for (const n of root.querySelectorAll("*")) { if (n.dataset?.polishHover) delete n.dataset.polishHover; if (n.shadowRoot) walk(n.shadowRoot); } }; walk(document); });
          }
        }
        results[key] = found;
      } catch (error) { results[key] = { error: String(error).slice(0, 300) }; }
    };
    try { await run(browser, { width, theme, touch: input === "touch" }, visit); }
    catch (error) { results[`${scene}/!/${tag}`] = { error: String(error?.stack || error).slice(0, 600) }; console.log(`  ! ${scene} ${tag}: ${String(error).slice(0, 200)}`); }
    console.log(`${scene} ${tag} ${Date.now() - started} ms`);
    save();
  }
}
await real.close();
