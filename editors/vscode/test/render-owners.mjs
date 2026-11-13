// Pictures of a Project Pip's owner session (0.52), dark and light, at 700 and 300 px: the "Reports to" row on its
// Settings page and the picker Change opens. (The dialog a Work session's delete and archive opened is gone, 14 Nov.)
//   node test/render-owners.mjs [OUT_DIR]
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";
import { openChat, PIP } from "./support/pip-chat-scene.mjs";

const out = process.argv[2] || "owners-shots";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] });
const settle = (page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 250)))));
for (const theme of ["dark", "light"]) for (const width of [700, 300]) {
  // The row, then its picker, on the Pip's Settings.
  const x = await openChat(browser, { width, height: 760, theme, project: true, api: 89, owner: true, settings: true });
  await x.p.evaluate(() => { const root = window.__pipsRoot || document; const item = root.querySelector('.pip-topbar .pip-menu [data-tab="job"]') || root.querySelector('[data-tab="job"]'); item.click(); });
  await x.p.waitForSelector(".pip-owner .pip-owner-now");
  await x.p.evaluate(() => (window.__pipsRoot || document).querySelector(".pip-owner").scrollIntoView({ block: "center" }));
  await settle(x.p);
  await x.p.screenshot({ path: `${out}/reports-to-${theme}-${width}.png` });
  await x.p.click("#pip-owner-change");
  await x.p.waitForSelector(".pip-owner [data-owner-session]");
  await x.p.evaluate(() => (window.__pipsRoot || document).querySelector(".pip-owner").scrollIntoView({ block: "center" }));
  await settle(x.p);
  await x.p.screenshot({ path: `${out}/reports-to-picker-${theme}-${width}.png` });
  console.log(`${out}/reports-to-${theme}-${width}.png`, x.errors.length ? x.errors : "");
  await x.close();
}
await browser.close();
