// The still pictures of the eight Pips' faces, for editor tabs: each character at rest, drawn by Chromium from the same
// renderer the pages load (media/pips/plush.js: its body from the atlas, its eyes over it) and saved as a 64 px PNG with
// nothing around it, in media/pips/tab-faces/<character>.png. An editor tab's icon is a picture, not a page, so it
// cannot use the renderer itself (src/pipTabFace.ts reads these files). A Pip's face is its character's: the renderer
// draws no colour of a Pip's own (its tint layer is switched off), so eight pictures are every face there is.
// A tab draws its icon 16 px wide. There the eyes of the page's face are about a pixel across and are lost, so the
// tab's picture draws them heavier (EYES): the same eyes in the same place, only bolder, and the face is the body
// alone, as large as the square allows.
//
//   node scripts/render-pip-tab-faces.mjs            all eight
//   node scripts/render-pip-tab-faces.mjs --check    writes nothing; fails when a picture is missing or isn't 64 px
//
// Run it again whenever media/pips/plush.js or its atlas changes. It needs Playwright's Chromium (the tests' own:
// PLAYWRIGHT_BROWSERS_PATH says where).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
export const SIZE = 64;
export const CHARACTERS = ["core", "scout", "lens", "patch", "rook", "pulse", "lock", "quill"];
export const EYES = 1.45;      // how much heavier the tab's eyes are drawn than the page's
export const faceFile = (character) => `${root}media/pips/tab-faces/${character}.png`;

/** One character at rest as PNG bytes: `size` px square, clear around it. `eyes`: 1 draws the page's own face. */
export async function renderFace(page, character, size = SIZE, eyes = EYES) {
  const index = CHARACTERS.indexOf(character);
  if (index < 0) throw new Error(`No such character: ${character}`);
  await page.setViewportSize({ width: size, height: size });
  await page.route("https://faces.test/**", (r) => {
    const name = new URL(r.request().url()).pathname.split("/").pop();
    if (name === "plush-bodies.webp") return r.fulfill({ contentType: "image/webp", body: readFileSync(`${root}media/pips/plush-bodies.webp`) });
    if (name === "plush-body-mask.png") return r.fulfill({ contentType: "image/png", body: readFileSync(`${root}media/pips/plush-body-mask.png`) });
    if (name === "plush.js") return r.fulfill({ contentType: "text/javascript", body: readFileSync(`${root}media/pips/plush.js`) });
    return r.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><style>html,body{margin:0;background:transparent}body{width:${size}px;height:${size}px;line-height:0}`
      + `.face{display:block;width:${size}px;height:${size}px}.dgc-plush,.dgc-plush *{animation:none!important;rotate:none!important}.dgc-plush-rig{overflow:visible!important}</style></head>`
      + `<body><span class="face"></span><script src="/media/pips/plush.js"></script></body></html>` });
  });
  await page.goto("https://faces.test/page", { waitUntil: "load" });
  await page.evaluate(async ([i, name, heavier]) => {
    const face = document.querySelector(".face");
    face.innerHTML = window.PipConcepts.plush.markup({ index: i, name }, "idle", "tabface");
    for (const eye of face.querySelectorAll(".dgc-plush-eye")) eye.setAttribute("stroke-width", String(Number(eye.getAttribute("stroke-width")) * heavier));
    await Promise.all([...face.querySelectorAll("image")].map((image) => image.decode?.().catch(() => {})));
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  }, [index, character, eyes]);
  const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  await page.unroute("https://faces.test/**");
  return png;
}

async function main() {
  const check = process.argv.includes("--check");
  if (check) {
    const bad = [];
    for (const character of CHARACTERS) {
      const file = faceFile(character);
      if (!existsSync(file)) { bad.push(`${file}: missing`); continue; }
      const png = readFileSync(file);
      if (png.readUInt32BE(16) !== SIZE || png.readUInt32BE(20) !== SIZE) bad.push(`${file}: not ${SIZE} px`);
    }
    if (bad.length) { console.error(bad.join("\n")); process.exit(1); }
    console.log(`${CHARACTERS.length} pictures, each ${SIZE} px`);
    return;
  }
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] });
  try {
    const page = await (await browser.newContext({ deviceScaleFactor: 1, reducedMotion: "reduce" })).newPage();
    mkdirSync(`${root}media/pips/tab-faces`, { recursive: true });
    for (const character of CHARACTERS) { writeFileSync(faceFile(character), await renderFace(page, character)); console.log(`media/pips/tab-faces/${character}.png`); }
  } finally { await browser.close(); }
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main();
