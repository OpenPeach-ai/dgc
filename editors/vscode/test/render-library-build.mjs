// The pictures of the Library pass (0.52, 15 Nov; not a test): each thing it built, on the
// real page, dark and light, at the widths asked for. Run in a tree; it pictures that tree.
//   PLAYWRIGHT_BROWSERS_PATH=~/.cache/ms-playwright node test/render-library-build.mjs <out folder> [which, ...]
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";
import { cleanup } from "./support/notes-host.mjs";

const out = process.argv[2], only = process.argv.slice(3);
if (!out) throw new Error("say where the pictures go");
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] });
const touch = new Proxy(browser, { get(target, key) {
  if (key === "newContext") return (o = {}) => target.newContext({ ...o, hasTouch: true });
  if (key === "newPage") return (o = {}) => target.newPage({ ...o, hasTouch: true });
  const v = target[key]; return typeof v === "function" ? v.bind(target) : v; } });
const ctx = { browser, touch, out,
  shot: async (page, name, clip) => { await page.screenshot({ path: `${out}/${name}.png`, ...(clip ? { clip } : {}) }); console.log(name); },
  boxOf: async (page, selector, pad = 10) => { const b = await page.locator(selector).first().boundingBox(); const v = page.viewportSize(); const x = Math.max(0, b.x - pad), y = Math.max(0, b.y - pad); return { x, y, width: Math.min(v.width - x, b.width + 2 * pad), height: Math.min(v.height - y, b.height + 2 * pad) }; },
  step: async (name, fn) => { try { await fn(); } catch (error) { console.log(`! ${name}: ${String(error.stack || error).slice(0, 400)}`); } } };
const { PICTURES } = await import("./support/library-build-pictures.mjs");
for (const [name, draw] of Object.entries(PICTURES)) { if (only.length && !only.includes(name)) continue; await ctx.step(name, () => draw(ctx)); }
await browser.close(); cleanup();
