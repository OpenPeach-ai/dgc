// The Pips pages wear DGC's one button (media/shared/tokens.css; src/pips.css, "DGC's one button, on the Pips pages"):
// a Pip's page and its Settings, the cards in its chat, the Pips home. The main action of a form, a dialog or a card
// (button.primary) is the one filled button; every other button is the hairline outline; button.link is the text link.
// Measured in real Chromium with the real client and its CSS, in the side bar (a shadow root on Work's page), dark and
// light, at 300, 700 and 1,000 px, against the shared tokens: corner, the one box a size (or the one wide size), fill,
// hairline, 4.5:1 labels, nothing cut or wrapped, one filled button a card; and the step, the press and the ring.
// Not buttons in this sense, and left as they were: a row that is itself a button (a Pip in the list, a settings row,
// a routine), the tabs, the top bar's round marks, the prompt box's tools and Send, a reply's choices, the "i".
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openChat } from "./support/pip-chat-scene.mjs";
import { probe, answers, check } from "./support/buttons-probe.mjs";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipReason = () => (!chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "");
const skipOrFail = (t) => {
  if (!skipReason()) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${skipReason()}`);
  t.skip(skipReason());
  return true;
};
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

export const PIP_BUTTONS = 'button:is(.primary, .quiet, .danger, .pill, .link, .pip-face-edit, :not([class]), [class=""]):not([data-tab]):not(.pip-tip-btn):not([aria-label^="Close"])';
const HOLDS = ".section, .pip-page-row, .pip-page-group, .dgc-card, form, .dialog, .simple-setup";
export const VIEWS = { "a Personal Pip's page": [{ settings: true }, true, 8], "a Project Pip's Settings": [{ settings: true, project: true }, true, 12], "a Pip's chat with its cards": [{ keys: true, hold: true }, false, 4], "the Pips home": [{ home: true, setups: 2 }, false, 4] };
export async function openView(name, { width = 460, theme = "dark" } = {}) {
  const [opts, page] = VIEWS[name];
  const x = await openChat(browser, { width, height: 900, theme, api: 81, motion: "no-preference", ...opts });
  if (page) { await x.p.evaluate(() => (window.__pipsRoot || document).querySelector('[data-tab="job"]').click()); await x.p.waitForTimeout(700);
    await x.p.evaluate(() => { const d = (window.__pipsRoot || document).querySelector("details.advanced"); if (d) d.open = true; }); }
  await x.p.waitForTimeout(350);
  return x;
}

for (const theme of ["dark", "light"]) for (const width of [300, 700, 1000]) for (const name of Object.keys(VIEWS)) {
  test(`${name}, ${theme} ${width}px: every button is the shared one`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openView(name, { width, theme });
    try {
      const found = await x.p.evaluate(probe, { root: "body", buttons: PIP_BUTTONS, cards: HOLDS, shadow: "#pips-host" });
      if (process.env.SHOTS && width !== 1000) await x.p.screenshot({ path: `${process.env.SHOTS}/pips-${name.replace(/[^a-z]+/gi, "-").toLowerCase()}-${theme}-${width}.png`, fullPage: false });   // SHOTS=<folder> saves what was painted
      check(assert, found, { where: name, sizes: ["h", "hSm"], min: VIEWS[name][2], free: /\blink\b/ });
      assert.equal(await x.p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, "nothing runs off the side");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("on the Pips pages a button steps up 1 px when pointed at and sinks 1 px when pressed, and shows a ring", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openView("a Project Pip's Settings", { width: 700 });
  try {
    for (const sel of ["#toggle-pip", "#archive-pip"]) {
      await x.p.locator(sel).scrollIntoViewIfNeeded();
      const a = await answers(x.p, x.p.locator(sel));
      assert.deepEqual([a.rest.y, a.pointed.y, a.pointed.ms, a.pressed.y, a.pressed.scale, a.pressed.ms], [0, -1, "0.15s", 1, 0.985, "0.09s"], sel);
    }
    const ring = await x.p.evaluate(async () => { const b = (window.__pipsRoot || document).querySelector("#toggle-pip"); b.focus({ focusVisible: true }); await new Promise((r) => requestAnimationFrame(r)); const s = getComputedStyle(b); return [s.outlineStyle !== "none", parseFloat(s.outlineWidth) >= 1]; });
    assert.deepEqual(ring, [true, true]);
  } finally { await x.close(); }
});

test("the Pips stylesheet puts its buttons on the shared tokens", () => {
  const css = readFileSync(new URL("../src/pips.css", import.meta.url), "utf8");
  const at = css.indexOf("DGC's one button, on the Pips pages"), end = css.indexOf("/* ==== Pip chat design pass"), section = css.slice(css.lastIndexOf("/*", at), end);
  assert.ok(at > 0 && end > at, "the section is in src/pips.css");
  for (const family of ["button.primary", "button.quiet", "button.danger", "button.link", "button.pill", ".pip-face-edit"]) assert.ok(section.includes(family), `${family} is put on the shared button`);
  for (const token of ["--btn-r", "--btn-h", "--btn-w", "--btn-w-wide", "--btn-fill", "--btn-line", "--btn-move", "--btn-up", "--btn-down"]) assert.ok(section.includes(`var(${token})`), `the section reads ${token}`);
  assert.doesNotMatch(section.replace(/\/\*[\s\S]*?\*\//g, ""), /border-radius:(?!\s*var\(--btn-r\))[^;]*;|#[0-9a-fA-F]{3,8}\b|rgba?\(/, "no corner or colour of its own");
});
