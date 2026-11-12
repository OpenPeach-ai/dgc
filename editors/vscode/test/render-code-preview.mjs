// Pictures of the preview line and the preview tab (0.52), dark and light, at 700 and 300 px: a reply with an icon
// set's HTML and CSS and its "Preview: ..." line in Work, ChatDGC and a Pip's chat, and the tab on its light and dark
// grounds.
//   node test/render-code-preview.mjs [OUT_DIR]
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";
import { CHATS, openTab } from "./support/code-preview-scene.mjs";

const out = process.argv[2] || "code-preview-shots";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] });
const shot = async (page, name) => { await page.screenshot({ path: `${out}/${name}.png` }); console.log(`${out}/${name}.png`); };

for (const [label, theme] of [["dark", "dark-modern"], ["light", "light-modern"]]) for (const width of [700, 300]) {
  for (const [chat, open] of Object.entries(CHATS)) {
    const x = await open(browser, { theme, width, height: 760 });
    // The end of the HTML block, its line, and the CSS block after it, in the middle of the picture.
    await x.page.evaluate(() => { const find = (root, s) => { const hit = root.querySelector(s); if (hit) return hit; for (const n of root.querySelectorAll("*")) { const inner = n.shadowRoot && find(n.shadowRoot, s); if (inner) return inner; } return null; };
      find(document, ".code-preview").scrollIntoView({ block: "center" }); });
    await x.page.waitForTimeout(250);
    await shot(x.page, `${chat}-${label}-${width}-line`);
    await x.close();
  }
  for (const ground of ["light", "dark"]) {
    const x = await openTab(browser, { theme: label, width, height: 620 });
    if (ground !== label) await x.page.locator(`label[for="ground-${ground}"]`).click();
    await x.page.waitForTimeout(200);
    await shot(x.page, `tab-${label}-editor-${width}-${ground}-ground`);
    await x.close();
  }
}
const big = await openTab(browser, { theme: "dark", width: 700, height: 300, view: { kind: "html", title: "Big", html: "<p>" + "x".repeat(600 * 1024) + "</p>", css: [] } });
await shot(big.page, "tab-dark-editor-700-too-large");
await big.close();
await browser.close();
