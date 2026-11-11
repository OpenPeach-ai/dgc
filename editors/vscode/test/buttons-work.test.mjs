// Work's chat wears DGC's one button (media/shared/tokens.css; media/main.css, "DGC's one button, in Work"): a command's
// Allow once / Always allow / Deny, a plan's answers, a question's Send and Skip, the listing cards' buttons, a Pip's
// report (Fix is its one filled answer) and its fix row (Review, Undo and Watch are links), the small outline buttons on
// a tool's row, New on the Work list, and the dialogs' buttons. Measured in real Chromium on Work's real page, dark,
// light and high contrast, at 300 and 700 px, against the shared tokens themselves: the corner, the two heights, the
// fill, the hairline; one filled button a card; labels at 4.5:1; the step, the press and the ring.
// What is not a button here, and stays as it was: the header's title and crumbs, the prompt box's tools and Send (the
// one purple thing), the tray's chips, a question's options (rows to choose from) and a row that opens or folds.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openWork, settle } from "./support/work-buttons-scene.mjs";
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

// Every button in the chat but the things that are not buttons in this sense (see the head of this file).
const NOT = ":not(.oask-opt):not(.ask-opt):not(.agent-name):not(.pip-fix-toggle):not(.pip-fix-dismiss):not(.pip-report-chevron):not(.dgc-card-link):not(.ask-x):not(.ask-page):not(.plan-fold-toggle):not(.copy):not(.tool-head):not(.open-ask-folded):not(.pip-report-dismiss-slim)";
// (A command to allow stands over the prompt box, and an open question under the chat: neither is inside the log.)
export const WORK_BUTTONS = `#log button${NOT}, .card button${NOT}, button.open-ask-send, button.open-ask-skip, button.open-ask-collapse`;
const CARDS = ".card, .pip-report, .artifact, .open-ask, .dgc-card";
const THEMES = [["dark-modern", false], ["light-modern", false], ["hc", true]];

for (const [theme, forcedColors] of THEMES) for (const width of [300, 700, 1000]) for (const part of ["cards", "asks"]) {
  test(`${theme}${forcedColors ? " (forced colours)" : ""} ${width}px, ${part}: every button in the chat is the shared one`, async (t) => {
    if (skipOrFail(t)) return;
    const page = await openWork(browser, { part, width, theme: theme === "hc" ? "hc" : theme, forcedColors });
    try {
      const found = await page.evaluate(probe, { root: "body", buttons: WORK_BUTTONS, cards: CARDS });
      check(assert, found, { where: `${part}`, min: part === "cards" ? 6 : 9, free: /\blink\b/ });
      const by = Object.fromEntries(found.buttons.map((b) => [b.word, b]));
      if (part === "asks") {
        assert.deepEqual(["Allow once", "Always allow", "Deny"].map((w) => [by[w].kind, Math.round(by[w].height), by[w].width]), [["filled", found.tokens.h, found.tokens.w], ["outline", found.tokens.h, found.tokens.w], ["outline", found.tokens.h, found.tokens.w]], "a command: one filled answer, two outlines, each the one roomy box whatever its words");
        assert.equal(found.buttons.find((b) => /^Approve/.test(b.word)).width, found.tokens.wWide, "a plan's Approve is the one wide button");
        assert.deepEqual(["Send", "Skip"].map((w) => by[w].kind), ["filled", "outline"], "a question: Send is its one filled button (the text's colour, not purple), Skip an outline");
        assert.equal(found.buttons.filter((b) => b.kind === "filled" && /^Approve/.test(b.word)).length, 1, "a plan: Approve is its one filled answer");
      } else {
        assert.deepEqual(["Fix", "Open"].map((w) => [by[w]?.kind, Math.round(by[w]?.height), by[w]?.width]), [["filled", found.tokens.hSm, found.tokens.wSm], ["outline", found.tokens.hSm, found.tokens.wSm]], "a Pip's report: Fix is its one filled answer; Fix and Open are one small box");
        assert.deepEqual(["Review", "Undo"].map((w) => [by[w].kind, Math.round(by[w].height)]), [["link", found.tokens.hSm], ["link", found.tokens.hSm]], "its fix row: links, 22 px to hit");
        assert.deepEqual([by["preview · open"].kind, by.Stop.kind], ["filled", "outline"], "the listing cards");
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "nothing runs off the side");
    } finally { await page.close(); }
  });
}

test("in Work a button steps up 1 px when pointed at and sinks 1 px when pressed; under reduced motion it rests", async (t) => {
  if (skipOrFail(t)) return;
  for (const reducedMotion of [false, true]) {
    const page = await openWork(browser, { part: "asks", width: 460, reducedMotion });
    try {
      for (const sel of ['#log .card button.act.primary >> nth=0', '#log .card button.act:not(.primary) >> nth=0', "#log .open-ask-skip"]) {
        const a = await answers(page, page.locator(sel));
        if (reducedMotion) assert.deepEqual([a.pointed.y, a.pressed.y, a.pressed.scale], [0, 0, 1], `${sel}: at rest under reduced motion`);
        else assert.deepEqual([a.rest.y, a.pointed.y, a.pointed.ms, a.pressed.y, a.pressed.scale, a.pressed.ms], [0, -1, "0.15s", 1, 0.985, "0.09s"], sel);
        assert.notEqual(a.pointed.fill, a.rest.fill, `${sel}: its fill answers`);
      }
    } finally { await page.close(); }
  }
});

test("the keyboard shows the shared ring on a card's buttons", async (t) => {
  if (skipOrFail(t)) return;
  const page = await openWork(browser, { part: "asks", width: 460 });
  try {
    const rings = await page.evaluate(async (sel) => { const out = []; for (const b of [...document.querySelectorAll(sel)].filter((n) => n.checkVisibility())) { b.focus({ focusVisible: true }); await new Promise((r) => requestAnimationFrame(r)); const s = getComputedStyle(b); out.push([b.textContent.trim().slice(0, 20), s.outlineStyle, parseFloat(s.outlineWidth) >= 1]); } return out; }, WORK_BUTTONS);
    assert.ok(rings.length >= 9);
    assert.deepEqual(rings.filter((r) => r[1] === "none" || !r[2]), [], "each shows a ring");
  } finally { await page.close(); }
});

for (const theme of ["dark-modern", "light-modern", "hc"]) {
  test(`${theme}: New on the Work and Chat lists is the shared filled button`, async (t) => {
    if (skipOrFail(t)) return;
    for (const tab of ["work", "chat"]) {
      const x = await openHome(browser, { tab, theme, width: 300 });
      try {
        const found = await x.page.evaluate(probe, { root: "#sessions-host", buttons: ".home-new" });
        check(assert, found, { where: `${tab} list`, sizes: ["h"], min: 1 });
        assert.deepEqual(found.buttons.map((b) => b.kind), ["filled"]);
      } finally { await x.close(); }
    }
  });
}

test("every button family in Work's stylesheet reads the shared tokens, and none keeps a corner or a fill of its own", () => {
  const css = readFileSync(new URL("../media/main.css", import.meta.url), "utf8");
  const at = css.indexOf("DGC's one button, in Work"), section = css.slice(css.lastIndexOf("/*", at));
  assert.ok(at > 0, "the section is in media/main.css");
  for (const family of ["button.act", "button.link", ".abtn", ".ask-act", ".open-ask-send", ".open-ask-skip", ".pip-report-slim-actions button", ".pip-fix-act", ".mod-button", ".auto-mode-buttons button", ".home-new", ".goal-dialog-actions .act"])
    assert.ok(section.includes(family), `${family} is put on the shared button`);
  for (const token of ["--btn-r", "--btn-h", "--btn-h-sm", "--btn-fill", "--btn-line", "--btn-move", "--btn-up", "--btn-down"]) assert.ok(section.includes(`var(${token})`), `the section reads ${token}`);
  assert.doesNotMatch(section.replace(/\/\*[\s\S]*?\*\//g, ""), /border-radius:(?!\s*var\(--btn-r\))[^;]*;|#[0-9a-fA-F]{3,8}\b|rgba?\(/, "no corner or colour of its own");
});
