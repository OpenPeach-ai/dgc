// The pictures of Home as cards (not a test): the default Home, every card in each form, Arrange Home, the card library
// and a Small card opened, dark and light at 300, 460 and 700 px, and two short films (the side bar's edge dragged, and
// Home arranged). Usage: node test/render-home-cards.mjs <out folder>
import { mkdirSync, renameSync, readdirSync } from "node:fs";
import { chromium } from "@playwright/test";
import { tmpdir } from "node:os";
import { openGrid, EVERY, LISBON, NOTES } from "./support/home-grid-scene.mjs";
import { DOCK_SESSIONS } from "./support/dock-scene.mjs";

const out = process.argv[2] || `${tmpdir()}/home-cards-pictures`;
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] });
const SETTINGS = { weather: { place: LISBON, unit: "c" }, clock: { zone: "Asia/Tokyo" } };
const NEWS = [{ id: DOCK_SESSIONS[3].id, at: Date.now() - 60000, preview: "The totals now round half up, and the three tests that held the old way are changed." }];
const shot = (x, name) => x.page.screenshot({ path: `${out}/${name}.png` });
for (const theme of ["dark-modern", "light-modern", "hc"]) {
  const t = theme === "hc" ? "hc" : theme.split("-")[0];
  for (const width of [300, 460, 700]) {
    if (theme === "hc" && width !== 460) continue;
    let x = await openGrid(browser, { width, theme, news: NEWS, height: 900, scale: 2 });
    await x.page.mouse.move(2, 500); await x.rest(300); await shot(x, `home-default-${width}-${t}`);
    if (theme !== "hc") {
      await x.page.click(".hc-cards-btn"); await x.rest(400); await shot(x, `library-${width}-${t}`);
      await x.page.click(".hc-library .hc-arrange"); await x.rest(700);
      await x.page.focus('.hc-card[data-card="token"]'); await x.page.keyboard.press("Space"); await x.rest(300); await shot(x, `arrange-${width}-${t}`);
      await x.page.keyboard.press("Space"); await x.page.click(".hc-cards-btn"); await x.rest(400); await shot(x, `arrange-library-${width}-${t}`);
    }
    await x.close();
    x = await openGrid(browser, { width, theme, layout: EVERY, settings: SETTINGS, notes: NOTES, news: NEWS, height: width === 300 ? 1100 : width === 460 ? 2500 : 1300, scale: 2 });
    await x.page.mouse.move(2, 500); await x.rest(300); await shot(x, `every-card-${width}-${t}`);
    if (width === 700 && theme !== "hc") { const b = await x.page.locator('.hc-card[data-card="token"] .hc-col >> nth=24').boundingBox(); await x.page.mouse.move(b.x + 2, b.y + 40); await x.rest(300); await shot(x, `token-inked-${width}-${t}`); }
    await x.close();
  }
  if (theme === "hc") continue;
  for (const id of ["token", "needs", "recent", "weather", "folders", "note"]) {
    const x = await openGrid(browser, { width: 300, theme, layout: EVERY, settings: SETTINGS, notes: NOTES, news: NEWS, height: 900, scale: 2 });
    await x.page.click(`.hc-grid .hc-card[data-card="${id}"]`, { position: { x: 60, y: 12 } }); await x.rest(500);
    if (id === "token") { const b = await x.page.locator(".hc-open .hc-col >> nth=22").boundingBox(); await x.page.mouse.move(b.x + 2, b.y + 40); await x.rest(300); } else await x.page.mouse.move(2, 500);
    await shot(x, `opened-${id}-300-${t}`); await x.close();
  }
}
// Films: the edge dragged from wide to narrow and back; Home arranged by pointer and a card added.
const film = async (name, run) => { const dir = `${out}/film-${name}`; mkdirSync(dir, { recursive: true });
  const x = await openGrid(browser, { width: 700, height: 900, news: NEWS, video: dir }); await run(x); await x.close();
  const made = readdirSync(dir).find((f) => f.endsWith(".webm")); if (made) renameSync(`${dir}/${made}`, `${out}/${name}.webm`); };
await film("resizing", async (x) => { await x.rest(600); for (const w of [640, 560, 460, 400, 340, 300, 300, 380, 460, 600, 700]) { await x.page.setViewportSize({ width: w, height: 900 }); await x.rest(650); } });
await film("arranging", async (x) => { const p = x.page; await x.resize(460); await p.click(".hc-cards-btn"); await x.rest(900); await p.click('.hc-lib-item[data-card="work"] .hc-add'); await x.rest(700); await p.click(".hc-library .hc-arrange"); await x.rest(900);
  const g = await x.grid(), a = g.cards.at(-1), b = g.cards[1]; await p.mouse.move(a.left + 60, a.top + 28); await p.mouse.down(); await p.mouse.move(b.left + 60, b.top + 10, { steps: 30 }); await x.rest(500); await p.mouse.up(); await x.rest(900);
  await p.click('.hc-card[data-card="running"] .hc-x'); await x.rest(800); await p.click(".hc-done"); await x.rest(1200); });
await browser.close();
console.log(out);
