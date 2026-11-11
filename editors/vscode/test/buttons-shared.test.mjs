// DGC's one button, defined once (media/shared/tokens.css, "The button"; asked 11 Nov: "make this button style standard
// on our DGC, on all surfaces"): the filled main action in the text's own colour, the hairline-outline secondary, the
// text link for the least; a 6 px corner; 28 px high, and 22 px where a surface is dense (a card's answers); a 1 px
// step up when pointed at and a 1 px press (150 ms in, 120 ms out, 90 ms the press); a focus ring; disabled; high
// contrast; rest under reduced motion. Every surface's buttons read these tokens (buttons-<surface>.test.mjs); this
// file checks the definition itself, drawn with its own class (.dgc-btn) on Work's page, and the shared card, which
// was the first to wear it.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openHome } from "./support/home-scene.mjs";
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

const SAMPLE = `<div id="btn-sample" style="position:fixed;inset:0 0 auto 0;z-index:99999;display:flex;flex-wrap:wrap;gap:8px;padding:12px;background:var(--vscode-sideBar-background)">
  <div class="set" data-set="roomy" style="display:flex;gap:8px"><button type="button" class="dgc-btn primary">Save</button><button type="button" class="dgc-btn">Cancel</button><button type="button" class="dgc-btn link">Learn more</button><button type="button" class="dgc-btn" disabled>Off</button></div>
  <div class="set" data-set="small" style="display:flex;gap:8px"><button type="button" class="dgc-btn small primary">Open</button><button type="button" class="dgc-btn small">Dismiss</button><button type="button" class="dgc-btn small link">Review</button></div></div>`;
async function sample(options) {
  const x = await openHome(browser, { tab: "work", width: 460, ...options });
  await x.page.evaluate((html) => { document.getElementById("sessions-host").insertAdjacentHTML("afterbegin", html); }, SAMPLE);
  return x;
}

test("the definition is written once, in the tokens every page loads", () => {
  const css = readFileSync(new URL("../media/shared/tokens.css", import.meta.url), "utf8");
  for (const name of ["--btn-r", "--btn-h", "--btn-h-sm", "--btn-pad", "--btn-pad-sm", "--btn-fill", "--btn-fill-hover", "--btn-on-fill", "--btn-line", "--btn-line-hover", "--btn-wash", "--btn-text", "--btn-move", "--btn-up", "--btn-down", "--btn-in", "--btn-press"])
    assert.equal((css.match(new RegExp(`${name}\\s*:`, "g")) || []).length >= 1, true, `${name} is defined`);
  assert.match(css, /--btn-r:\s*6px/); assert.match(css, /--btn-h-sm:\s*22px/); assert.match(css, /--btn-in:\s*150ms/); assert.match(css, /--btn-press:\s*90ms/);
  // No other stylesheet writes the button's corner or its heights as numbers of its own for a shared button.
  for (const file of ["media/shared/card.css", "media/shared/hub.css"]) {
    const own = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.match(own, /var\(--btn-r\)|var\(--btn-h/, `${file} reads the shared button`);
  }
});

for (const theme of ["dark-modern", "light-modern", "hc"]) {
  test(`${theme}: filled, outline and link; 28 px and 22 px; the 6 px corner; labels at 4.5:1; one filled a set`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await sample({ theme });
    try {
      const found = await x.page.evaluate(probe, { root: "#btn-sample", buttons: ".dgc-btn", cards: ".set" });
      assert.deepEqual([found.tokens.r, found.tokens.h, found.tokens.hSm], ["6px", 28, 22], "the corner and the two heights");
      check(assert, found, { where: theme, min: 7 });
      assert.deepEqual(found.buttons.map((b) => `${b.word}:${b.kind}:${Math.round(b.height)}`), ["Save:filled:28", "Cancel:outline:28", "Learn more:link:28", "Off:outline:28", "Open:filled:22", "Dismiss:outline:22", "Review:link:22"]);
      assert.deepEqual(found.buttons.filter((b) => b.kind !== "link").map((b) => b.padding[0]), ["14px", "14px", "14px", "9px", "9px"], "one side padding a size");
      if (theme === "hc") assert.deepEqual(found.buttons.filter((b) => b.kind === "outline" && b.edge < 3).map((b) => b.word), [], "an outline's line is 3:1 in high contrast");
    } finally { await x.close(); }
  });
}

test("pointed at, a button steps up 1 px in 150 ms (an outline gains a faint fill and a firmer line); pressed, 1 px down in 90 ms; a link stays put", async (t) => {
  if (skipOrFail(t)) return;
  const x = await sample();
  try {
    for (const [name, sel] of [["filled", "#btn-sample .dgc-btn.primary >> nth=0"], ["outline", "#btn-sample .dgc-btn:not(.primary):not(.link) >> nth=0"]]) {
      const a = await answers(x.page, x.page.locator(sel));
      assert.deepEqual([a.rest.y, a.rest.ms, a.pointed.y, a.pointed.ms, a.pressed.y, a.pressed.scale, a.pressed.ms, a.after.y], [0, "0.12s", -1, "0.15s", 1, 0.985, "0.09s", 0], name);
      assert.notEqual(a.pointed.fill, a.rest.fill, `${name}: its fill answers`);
      if (name === "outline") assert.notEqual(a.pointed.line, a.rest.line, "its line firms up");
    }
    const link = await answers(x.page, x.page.locator("#btn-sample .dgc-btn.link >> nth=0"));
    assert.deepEqual([link.pointed.y, link.pressed.y], [0, 0], "a link is words: it does not step");
    const off = await answers(x.page, x.page.locator("#btn-sample .dgc-btn[disabled]"));
    assert.deepEqual([off.pointed.y, off.pointed.fill], [0, off.rest.fill], "a disabled button does not answer");
  } finally { await x.close(); }
});

test("reduced motion: no step, no press move; the colours still answer", async (t) => {
  if (skipOrFail(t)) return;
  const x = await sample({ motion: "reduce" });
  try {
    const a = await answers(x.page, x.page.locator("#btn-sample .dgc-btn:not(.primary):not(.link) >> nth=0"));
    assert.deepEqual([a.pointed.y, a.pressed.y, a.pressed.scale], [0, 0, 1]);
    assert.notEqual(a.pointed.fill, a.rest.fill);
  } finally { await x.close(); }
});

test("the keyboard shows a ring on each, and a disabled button is dimmed and skipped", async (t) => {
  if (skipOrFail(t)) return;
  const x = await sample();
  try {
    await x.page.evaluate(() => { document.querySelector("#btn-sample .dgc-btn").focus(); });
    await x.page.keyboard.press("Tab"); await x.page.keyboard.press("Shift+Tab");
    const stops = [];
    for (let i = 0; i < 6; i++) { stops.push(await x.page.evaluate(() => { const a = document.activeElement, s = getComputedStyle(a); return [a.textContent, s.outlineStyle !== "none" && parseFloat(s.outlineWidth) >= 1]; })); await x.page.keyboard.press("Tab"); }
    assert.deepEqual(stops, [["Save", true], ["Cancel", true], ["Learn more", true], ["Open", true], ["Dismiss", true], ["Review", true]]);
    assert.equal(await x.page.evaluate(() => getComputedStyle(document.querySelector("#btn-sample .dgc-btn[disabled]")).opacity), "0.55");
  } finally { await x.close(); }
});

test("the shared card's answers are this button: they read its corner, heights, fill and line", async (t) => {
  if (skipOrFail(t)) return;
  const x = await sample();
  try {
    await x.page.evaluate(() => { const host = document.getElementById("btn-sample"); host.append(window.DgcCard.node({ id: "sample", icon: "app", title: "Connect Google Calendar?", actions: [{ label: "Allow", primary: true }, { label: "Not now" }] })); });
    const found = await x.page.evaluate(probe, { root: "#btn-sample", buttons: ".dgc-card-btn", cards: ".dgc-card" });
    check(assert, found, { where: "the shared card", sizes: ["h"], min: 2 });
    assert.deepEqual(found.buttons.map((b) => `${b.word}:${b.kind}`), ["Allow:filled", "Not now:outline"]);
  } finally { await x.close(); }
});
