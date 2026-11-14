// Pictures of the Pip page batch of 14 Nov (0.52; Pips API 96), in real Chromium on the stand-in DGC of
// test/support/one-pips-scene.mjs: the side bar's real page at 700 and 300 px, dark and light. Not a test.
//   PLAYWRIGHT_BROWSERS_PATH=~/.cache/ms-playwright node test/render-pip-page-batch.mjs <folder to write into> [only: a name's start]
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";
import { GST, MORNINGS, openOnePips } from "./support/one-pips-scene.mjs";
import { PAYING, openPage } from "./support/pip-page-batch-scene.mjs";

const out = process.argv[2], only = process.argv[3] || "";
if (!out) throw new Error("say where the pictures go");
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] });
const settle = (page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
/** A picture of the view; `whole`: the view made as tall as its page, so a long page is pictured whole. */
const shot = async (x, name, whole = false) => {
  await x.page.mouse.move(2, 2); await settle(x.page);
  if (whole) {
    const need = await x.inPips((root) => { for (let e = root.querySelector(".pip-page"); e; e = e.parentElement) if (e.scrollHeight > e.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(e).overflowY)) return Math.ceil(e.scrollHeight - e.clientHeight); return 0; });
    if (need > 0) { const size = x.page.viewportSize(); await x.page.setViewportSize({ width: size.width, height: Math.min(4200, size.height + need + 8) }); await settle(x.page); }
  }
  await x.page.screenshot({ path: `${out}/${name}.png` }); console.log(name);
};
/** A picture of one part of the page, with a little of what is around it. */
const part = async (x, selector, name, pad = 14) => {
  await x.page.mouse.move(2, 2);
  // (A scripted click leaves the keyboard's focus ring on what it clicked; a pointer's click would not.)
  await x.inPips((root, s) => { root.activeElement?.blur?.(); root.querySelector(s).scrollIntoView({ block: "center" }); }, selector); await settle(x.page);
  const box = await x.inPips((root, s) => { const r = root.querySelector(s).getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; }, selector);
  const size = x.page.viewportSize();
  const clip = { x: 0, y: Math.max(0, box.y - pad), width: size.width, height: Math.min(size.height - Math.max(0, box.y - pad), box.height + 2 * pad) };
  await x.page.screenshot({ path: `${out}/${name}.png`, clip }); console.log(name);
};
const type = (x, selector, value) => x.inPips((root, [s, v]) => { const i = root.querySelector(s); if (i.type === "checkbox") i.checked = v; else i.value = v; i.dispatchEvent(new Event("input", { bubbles: true, composed: true })); i.dispatchEvent(new Event("change", { bubbles: true, composed: true })); }, [selector, value]);
const want = (name) => !only || name.startsWith(only);

for (const theme of ["dark", "light"]) for (const width of [700, 300]) {
  const tag = `${theme}-${width}`, opts = { theme: `${theme}-modern`, width, height: 820, scale: 2 };
  let x;
  if (want("pay")) {
    // Let it pay, no limit set yet: the line that says one is needed.
    x = await openOnePips(browser, { ...opts, scene: { level: "full", paying: "allow" } });
    await openPage(x, MORNINGS); await part(x, '[aria-label="How much it asks"]', `pay-1-not-set-${tag}`);
    // What was typed is wrong: the reason, beside the boxes.
    await type(x, "#payUsd", "0"); await x.inPips((root) => root.querySelector("#pip-pay-form").requestSubmit()); await x.page.waitForTimeout(200);
    await part(x, '[aria-label="How much it asks"]', `pay-2-refused-${tag}`);
    await x.close();
    // A limit, a count and two sites, with what it used today.
    x = await openOnePips(browser, { ...opts, scene: PAYING });
    await openPage(x, MORNINGS); await part(x, '[aria-label="How much it asks"]', `pay-3-set-${tag}`);
    await type(x, "#payNoLimit", true); await settle(x.page); await part(x, '[aria-label="How much it asks"]', `pay-4-no-limit-ticked-${tag}`);
    await x.close();
    // A DGC that doesn't say a Pip's limits.
    x = await openOnePips(browser, { ...opts, scene: { level: "full", paying: "allow", limits: false } });
    await openPage(x, MORNINGS); await part(x, '[aria-label="How much it asks"]', `pay-5-not-said-${tag}`);
    await x.close();
    // Ask me each time: the rule alone.
    x = await openOnePips(browser, { ...opts, scene: { level: "full", paying: "ask" } });
    await openPage(x, MORNINGS); await part(x, '[aria-label="How much it asks"]', `pay-6-ask-each-time-${tag}`);
    await x.close();
  }
  if (want("total")) {
    x = await openOnePips(browser, { ...opts, scene: { total: { usd_per_day: 200, spent_today: 31.4 } } });
    await x.click("#pips-settings-open"); await x.waitIn('[data-pips-settings="apps"]'); await x.click('[data-pips-settings="apps"]'); await x.waitIn("#pips-pay-total-form"); await x.page.waitForTimeout(250);
    await shot(x, `total-settings-${tag}`);
    await x.close();
    x = await openOnePips(browser, { ...opts });
    await x.click("#pips-settings-open"); await x.waitIn('[data-pips-settings="apps"]'); await x.click('[data-pips-settings="apps"]'); await x.waitIn("#pips-pay-total-form"); await x.page.waitForTimeout(250);
    await part(x, '[aria-label="Payments"]', `total-empty-${tag}`);
    await x.close();
  }
  if (want("knows")) {
    x = await openOnePips(browser, { ...opts, scene: PAYING });
    await openPage(x, GST); await part(x, '.pip-page [aria-label="What it remembers"]', `knows-on-folder-pip-${tag}`);
    await x.inPips((root) => { const s = root.querySelector("#pipKnowsYou"); s.checked = false; s.dispatchEvent(new Event("change", { bubbles: true, composed: true })); }); await x.page.waitForTimeout(250);
    await part(x, '.pip-page [aria-label="What it remembers"]', `knows-off-folder-pip-${tag}`);
    await x.close();
  }
  if (want("sent")) {
    x = await openOnePips(browser, { ...opts, scene: PAYING });
    await openPage(x, GST); await part(x, ".pip-sent", `sent-closed-${tag}`);
    await x.click("#pip-sent-toggle"); await x.waitIn("#pip-sent-list"); await x.page.waitForTimeout(250); await part(x, ".pip-sent", `sent-open-${tag}`);
    await x.close();
    x = await openOnePips(browser, { ...opts });
    await openPage(x, GST); await x.click("#pip-sent-toggle"); await x.waitIn(".pip-sent-empty"); await x.page.waitForTimeout(200); await part(x, ".pip-sent", `sent-nothing-${tag}`);
    await x.close();
  }
  if (want("page")) {
    // The whole page of a Pip with a folder (every Pip keeps routines, notes and a goal now) and of a Personal Pip.
    x = await openOnePips(browser, { ...opts, scene: PAYING });
    await openPage(x, GST); await shot(x, `page-folder-pip-${tag}`, true);
    await x.close();
    x = await openOnePips(browser, { ...opts, scene: PAYING });
    await openPage(x, MORNINGS); await shot(x, `page-personal-pip-${tag}`, true);
    await x.close();
  }
  if (want("mac")) {
    x = await openOnePips(browser, { ...opts, height: 760, scene: { boxes: { available: false, why: "Needs macOS 26." } } });
    await x.send({ type: "pipsMacNote" }); await x.page.waitForSelector("#pips-mac-note:not([hidden])"); await x.page.waitForTimeout(350);
    await shot(x, `mac-dialog-${tag}`);
    await x.close();
  }
}
await browser.close();
