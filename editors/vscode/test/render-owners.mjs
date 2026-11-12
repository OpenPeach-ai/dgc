// Pictures of a Project Pip's owner session (0.52), dark and light, at 700 and 300 px: the "Reports to" row on its
// Settings page, the picker Change opens, and the dialog a Work session's delete (four Pips) and archive open.
//   node test/render-owners.mjs [OUT_DIR]
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";
import { openChat, PIP } from "./support/pip-chat-scene.mjs";
import { openHome } from "./support/home-scene.mjs";
import { SESSION_PIPS_ASK, askSessionPips } from "./support/session-pips-scene.mjs";

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
  for (const mode of ["delete", "archive"]) {
    const home = await openHome(browser, { width, height: 760, theme: `${theme}-modern`, tab: "work" });
    await askSessionPips(home.page, { ...SESSION_PIPS_ASK, mode });
    await home.page.screenshot({ path: `${out}/${mode}-dialog-${theme}-${width}.png` });
    if (mode === "delete") {
      await home.page.click('.session-pips-dialog input[value="delete"]');
      await home.page.click(".session-pips-dialog .session-pips-confirm");
      await settle(home.page);
      await home.page.screenshot({ path: `${out}/delete-dialog-sure-${theme}-${width}.png` });
    }
    console.log(`${out}/${mode}-dialog-${theme}-${width}.png`, home.errors.length ? home.errors : "");
    await home.close();
  }
}
await browser.close();
