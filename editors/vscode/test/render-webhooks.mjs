// Pictures of the webhook screens (pips-22): node test/render-webhooks.mjs <out dir>. Drawn by the real client in
// Chromium with the scene's stand-in answers (test/support/pip-chat-scene.mjs); no tailscale command is run.
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";
import { openChat } from "./support/pip-chat-scene.mjs";
import { openPanel, openReach } from "./support/pip-webhooks-scene.mjs";

const out = process.argv[2];
if (!out) { console.error("usage: node test/render-webhooks.mjs <out dir>"); process.exit(2); }
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] });
const shot = async (x, name, sel) => {
  await x.p.waitForTimeout(250);
  if (sel) await x.p.evaluate((s) => (window.__pipsRoot || document).querySelector(s)?.scrollIntoView({ block: "start" }), sel);
  await x.p.waitForTimeout(150);
  await x.p.screenshot({ path: `${out}/${name}.png` });
};
for (const theme of ["dark", "light"]) for (const width of [700, 300]) {
  const tag = `${theme}-${width}`;
  // The routine form with the new choice.
  let x = await openChat(browser, { width, height: width === 300 ? 760 : 640, theme, api: 90, settings: true, webhooks: true, scale: 2 });
  await x.p.evaluate(() => (window.__pipsRoot || document).querySelector('[data-tab="job"]').click());
  await x.p.click("[data-routine-new]");
  await x.p.fill("#routineTitle", "New payments");
  await x.p.fill("#routinePrompt", "Say who paid and how much, and add it to the sales sheet.");
  await x.p.selectOption("#routineKind", "webhook");
  await shot(x, `form-${tag}`, ".pip-page-group:has(#routine-form), #routine-form");
  await x.close();
  // A routine's panel with a few calls listed (one refused ×3).
  x = await openPanel(browser, { width, theme, height: width === 300 ? 1500 : 1180, scale: 2, webhooks: { network: true, tunnel: "tailscale", signing: true } });
  await shot(x, `panel-${tag}`, ".routine-form-row");
  await x.close();
  // The Settings section: Tailscale off, its confirm dialog, and on.
  x = await openReach(browser, { width, theme, height: width === 300 ? 1000 : 820, scale: 2, webhooks: { refused: true, cloudflared: true, slow: 2500 } });
  await shot(x, `settings-off-${tag}`);
  await x.p.click("[data-reach-tailscale]");
  await x.p.waitForSelector("#review-root .dialog");
  await shot(x, `settings-dialog-${tag}`);
  await x.p.click("#review-confirm");
  await x.p.waitForTimeout(200);
  await shot(x, `settings-turning-on-${tag}`);
  await x.p.waitForSelector(".webhook-on");
  await shot(x, `settings-on-${tag}`);
  await x.close();
}
await browser.close();
