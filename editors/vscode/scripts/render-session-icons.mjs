// The still pictures of the marks, for editor tabs: each mark at rest, drawn by Chromium from the same CSS the pages
// load (media/shared/mote.css, voxel.css, folio.css, portal.css) and saved as a 64 px PNG with nothing around it, in
// media/session-icons/<set>-<palette>.png. An editor tab's icon is a picture, not a page, so it cannot use the CSS
// itself (src/dock.ts `markIcon` reads these files).
//
//   node scripts/render-session-icons.mjs            every set whose stylesheet is here
//   node scripts/render-session-icons.mjs mote voxel only these sets
//   node scripts/render-session-icons.mjs --check    writes nothing; fails when a picture is missing or isn't 64 px
//
// Run it again whenever one of those stylesheets changes. It needs Playwright's Chromium (the tests' own:
// PLAYWRIGHT_BROWSERS_PATH says where). Citron and Lime are in the sheets and are never drawn.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const root = new URL("..", import.meta.url).pathname;
const marks = createRequire(import.meta.url)(root + "media/shared/marks.js");
export const SIZE = 64;
export const iconFile = (set, palette) => `${root}media/session-icons/${set}-${palette}.png`;
/** The sets whose stylesheet is in this tree. */
export const setsHere = () => Object.keys(marks.SETS).filter((set) => existsSync(`${root}media/shared/${set}.css`));

/** One mark at rest as PNG bytes: `size` px square, clear around it. */
export async function renderMark(page, set, palette, size = SIZE) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<!doctype html><html><head><style>${readFileSync(`${root}media/shared/${set}.css`, "utf8")}</style>`
    + `<style>html,body{margin:0;background:transparent}body{width:${size}px;height:${size}px;line-height:0}</style></head>`
    + `<body>${marks.html(set, palette, { size })}</body></html>`);
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}

async function main() {
  const args = process.argv.slice(2), check = args.includes("--check");
  const sets = args.filter((a) => !a.startsWith("--"));
  const wanted = sets.length ? sets : setsHere();
  for (const set of wanted) if (!setsHere().includes(set)) throw new Error(`No such set here: ${set}`);
  if (check) {
    const bad = [];
    for (const set of wanted) for (const palette of marks.PALETTES) {
      const file = iconFile(set, palette);
      if (!existsSync(file)) { bad.push(`${file}: missing`); continue; }
      const png = readFileSync(file);
      if (png.readUInt32BE(16) !== SIZE || png.readUInt32BE(20) !== SIZE) bad.push(`${file}: not ${SIZE} px`);
    }
    if (bad.length) { console.error(bad.join("\n")); process.exit(1); }
    console.log(`${wanted.length * marks.PALETTES.length} pictures, each ${SIZE} px`);
    return;
  }
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] });
  try {
    const page = await (await browser.newContext({ deviceScaleFactor: 1, reducedMotion: "no-preference" })).newPage();
    mkdirSync(`${root}media/session-icons`, { recursive: true });
    for (const set of wanted) for (const palette of marks.PALETTES) {
      writeFileSync(iconFile(set, palette), await renderMark(page, set, palette));
      console.log(`media/session-icons/${set}-${palette}.png`);
    }
  } finally { await browser.close(); }
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main();
