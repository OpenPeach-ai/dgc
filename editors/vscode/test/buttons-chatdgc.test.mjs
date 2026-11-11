// ChatDGC wears DGC's one button (media/shared/tokens.css; media/chatdgc.css, "DGC's one button, in ChatDGC"). Its
// own buttons: Continue, Save, Send and Open page on a question, a form, a widget and a page card (.cd-continue: the
// one filled button of each), a card's answers (.cd-card-actions button), Retry under a message that did not send
// (.cd-retry) and a wake-up's own buttons (.cd-wbtn). The cards it shares with Work (a question, an artifact, the
// shared card) come with Work's stylesheet, which this page loads: buttons-work.test.mjs.
// Drawn in real Chromium on ChatDGC's real page (support/chat-scene.mjs), dark, light and high contrast, at 300, 700 and
// 1,000 px. The buttons are set on the page with the very classes media/chatdgc.js gives them (its live states need a
// running chat), so this checks the stylesheet's cascade on the real page, not the script that draws them.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openChat } from "./support/chat-scene.mjs";
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

export const SAMPLE = `<div id="cd-buttons" style="position:fixed;inset:60px 0 auto 0;z-index:9999;display:grid;gap:10px;padding:12px;background:var(--bg)">
  <div class="cd-card set"><div class="cd-card-actions"><button type="button" class="primary">Allow</button><button type="button">Always allow</button><button type="button">Not now</button></div></div>
  <div class="cd-question set"><button type="button" class="cd-continue cd-question-go">Continue</button></div>
  <div class="cd-send-failed set"><span>Not sent.</span> <button type="button" class="cd-retry">Retry</button></div>
  <div class="cd-wrow set"><button type="button" class="cd-wbtn">Run now</button><button type="button" class="cd-wbtn">Cancel</button></div></div>`;
const FAMILIES = ".cd-card-actions button, .cd-continue, .cd-retry, .cd-wbtn";
async function open(options) {
  const x = await openChat(browser, options);
  await x.page.evaluate((html) => document.body.insertAdjacentHTML("beforeend", html), SAMPLE);
  await x.page.waitForTimeout(150);
  return x;
}

for (const theme of ["dark-modern", "light-modern", "hc"]) for (const width of [300, 700, 1000]) {
  test(`${theme} ${width}px: ChatDGC's own buttons are the shared one: its corner, its two boxes, its fill and hairline`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open({ theme, width });
    try {
      const found = await x.page.evaluate(probe, { root: "#cd-buttons", buttons: FAMILIES, cards: ".set" });
      if (process.env.SHOTS && theme !== "hc" && width !== 1000) await x.page.screenshot({ path: `${process.env.SHOTS}/chatdgc-${theme.replace("-modern", "")}-${width}.png` });   // SHOTS=<folder> saves what was painted
      check(assert, found, { where: `${theme} ${width}`, min: 7 });
      assert.deepEqual(found.buttons.map((b) => `${b.word}:${b.kind}:${b.width}x${Math.round(b.height)}`),
        ["Allow:filled:104x28", "Always allow:outline:104x28", "Not now:outline:104x28", "Continue:filled:104x28", "Retry:outline:76x22", "Run now:outline:76x22", "Cancel:outline:76x22"]);
      assert.deepEqual(x.errors, []);
    } finally { await x.page.close(); }
  });
}

test("in ChatDGC a button steps up 1 px when pointed at and sinks 1 px when pressed", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ width: 700 });
  try {
    for (const sel of ["#cd-buttons .cd-continue", "#cd-buttons .cd-card-actions button:not(.primary) >> nth=0", "#cd-buttons .cd-wbtn >> nth=0", "#cd-buttons .cd-retry"]) {
      const a = await answers(x.page, x.page.locator(sel));
      assert.deepEqual([a.rest.y, a.pointed.y, a.pointed.ms, a.pressed.y, a.pressed.scale, a.pressed.ms], [0, -1, "0.15s", 1, 0.985, "0.09s"], sel);
      assert.notEqual(a.pointed.fill, a.rest.fill, `${sel}: its fill answers`);
    }
    const rings = await x.page.evaluate(async (sel) => { const out = []; for (const b of document.querySelectorAll(`#cd-buttons :is(${sel})`)) { b.focus({ focusVisible: true }); await new Promise((r) => requestAnimationFrame(r)); const s = getComputedStyle(b); out.push(s.outlineStyle !== "none" && parseFloat(s.outlineWidth) >= 1); } return out; }, FAMILIES);
    assert.deepEqual(rings, Array(7).fill(true), "each shows a ring");
  } finally { await x.page.close(); }
});

test("every button family in ChatDGC's stylesheet reads the shared tokens", () => {
  const css = readFileSync(new URL("../media/chatdgc.css", import.meta.url), "utf8");
  const at = css.indexOf("DGC's one button, in ChatDGC"), section = css.slice(css.lastIndexOf("/*", at));
  assert.ok(at > 0, "the section is in media/chatdgc.css");
  for (const family of [".cd-continue", ".cd-card-actions button", ".cd-retry", ".cd-wbtn"]) assert.ok(section.includes(family), `${family} is put on the shared button`);
  for (const token of ["--btn-r", "--btn-h", "--btn-h-sm", "--btn-w", "--btn-w-sm", "--btn-fill", "--btn-line", "--btn-move", "--btn-up", "--btn-down"]) assert.ok(section.includes(`var(${token})`), `the section reads ${token}`);
  assert.doesNotMatch(section.replace(/\/\*[\s\S]*?\*\//g, ""), /border-radius:(?!\s*var\(--btn-r\))[^;]*;|#[0-9a-fA-F]{3,8}\b|rgba?\(/, "no corner or colour of its own");
});
