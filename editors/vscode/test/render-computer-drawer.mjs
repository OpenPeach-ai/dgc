// Pictures of a Pip computer's notification drawer: node test/render-computer-drawer.mjs <out dir>.
// Dark and light, at 1100, 700 and 300 px of tab: the drawer open with three cards, the folded stack, the bell with its
// count (the drawer collapsed), a banner arriving while it is collapsed, and an answered card. The real client and CSS,
// the real noVNC viewer on a fake screen (test/support/pip-computer-scene.mjs).
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";
import { openComputer, PIP } from "./support/pip-computer-scene.mjs";

const [out] = process.argv.slice(2);
if (!out) { console.error("usage: node test/render-computer-drawer.mjs <out dir>"); process.exit(2); }
mkdirSync(out, { recursive: true });
const action = (letter, ago, summary = {}) => ({ id: "compact_" + letter.repeat(32), pip_id: PIP.id, workspace_id: "ws", run_id: "run_" + "b".repeat(32),
  summary: { method: "POST", host: "shop.example", path: "/order", page: "https://shop.example/cart", fields: [], more_fields: 0, body_bytes: 14, ...summary },
  digest: letter.repeat(64), frame: null, status: "pending", created_at: new Date(Date.now() - ago * 1000).toISOString(), expires_at: "2099-11-13T09:00:00.000Z", resolved_at: null, resolved_by: null, continuation_run_id: null });
const PAY = action("d", 20, { host: "pay.example", payment: true, fields: [{ name: "billno", value: "INV-2026-1187" }, { name: "amount", value: "53.50" }] });
const TEXT = action("f", 250, { kind: "text", host: "forum.example", text: "Dear team,\nthe figures are attached." });
const FORM = action("c", 760, { host: "shop.example" });
const SITE = action("e", 2, { kind: "site", site: "news.example", shown: "news.example", method: "GET", host: "news.example", path: "/", page: "https://news.example/", body_bytes: 0 });
const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] });
// (Its own motion is over in half a second; the Pip's face never stops moving.)
const still = (p) => p.waitForTimeout(800);
for (const theme of ["dark", "light"]) for (const width of [1100, 700, 300]) {
  const x = await openComputer(browser, { width, height: 700, theme, actions: [PAY, TEXT, FORM], motion: "no-preference" });
  const shot = async (name) => { await still(x.p); await x.p.screenshot({ path: `${out}/drawer-${name}-${theme}-${width}.png` }); };
  await x.p.waitForSelector("#pc-drawer.pc-fan");
  await shot("open");
  const box = await x.p.locator("#pc-drawer").boundingBox();
  await x.p.mouse.move(box.x + box.width / 2, box.y + 20); await x.p.mouse.move(20, 680); await x.p.waitForSelector("#pc-drawer:not(.pc-fan)");
  await shot("stack");
  await x.p.click("#pc-bell"); await x.p.waitForSelector("#pc-drawer", { state: "hidden" }); await x.p.mouse.move(20, 680);
  await shot("bell");
  await x.scene({ actions: [SITE, PAY, TEXT, FORM] });
  await x.p.waitForSelector("#pc-drawer.pc-drawer-banner", { timeout: 15000 });
  await shot("banner");
  await x.p.click("#pc-bell"); await x.p.waitForSelector("#pc-drawer.pc-fan");
  await x.p.click(`[data-send="${PAY.id}"]`); await x.p.waitForSelector(".pc-card-done"); await x.p.mouse.move(box.x + box.width / 2, box.y + 30);
  await x.p.waitForTimeout(250); await x.p.screenshot({ path: `${out}/drawer-answered-${theme}-${width}.png` });
  if (x.errors.length) console.error(theme, width, x.errors);
  await x.close();
}
await browser.close();
