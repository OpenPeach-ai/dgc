// DGC's quiet text is a dull mid grey, as Codex's is: on a dark ground the grey Codex's own secondary text comes to
// (--color-text-secondary in an editor: color-mix(in srgb, var(--vscode-foreground) 65%, transparent), #8d8d8d on Dark
// Modern), and on a light one #6c6c6c, the nearest to it that still reads at 4.5:1 there (Codex's 65% of Light
// Modern's text is #7d7d7d, 3.9:1). Body text and code
// stay as bright as they were, and high contrast is untouched. Measured in real Chromium, where each word is drawn: its
// colour over the grounds under it (support/muted-probe.mjs), in a Work session, a ChatDGC chat and a Pip's chat
// (support/muted-scene.mjs). The colour that reaches the eye is what is held, never a token's name.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openWork, openChatDgc, openPips } from "./support/muted-scene.mjs";
import { inks, groundAndText } from "./support/muted-probe.mjs";

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

// The quiet things in each place, and the bright ones, by where they are drawn.
const QUIET = {
  work: [/#phead > span\.pm$/, /tg-label-text/, /div\.thinking\.done/, /> div\.sys$/, /thinking > span\.meta/, /workspace-changes-lab/, /span#ctx/, /span#modelabel/, /span#effortname/, /queue-word/,
    /#followup-hint/, /#pmodel/, /div#input.*::before/, /span\.tg-icon > svg/, /#btn-add.* > span\.codicon/, /#btn-settings.* > span\.codicon/, /span#modeicon/],
  chatdgc: [/time\.cd-time/, /span\.cd-meta/, /p\.cd-fine/, /cd-input.*::before/, /button\.cd-action.* > span\.codicon/, /#cd-attach.* > span\.codicon/, /cd-head > span\.pm$/],
  pips: [/p\.chat-time/, /time\.msg-time/, /own-change-words/, /composer-effort-name/, /composer-ctx/, /chatText.*::before/, /button#simple-back.* > svg/, /button\.ract > svg/],
};
const BRIGHT = { work: [/div\.text(\.commentary)? > p$/, /p > code$/, /span#modelname/, /tg-live-arg/], chatdgc: [/cd-body > p$/, /ul > li$/, /cd-model-name/], pips: [/message-body.* > p$/, /li > code$/, /composer-model-name/] };
const OPEN = { work: openWork, chatdgc: openChatDgc, pips: openPips };
const grey = (c) => Math.max(...c) - Math.min(...c) <= 3;
/** Codex's secondary text on a ground: the text colour at 65% over it. */
const codex = (text, ground) => text.map((v, i) => Math.round(v * 0.65 + ground[i] * 0.35));
const drawn = (rows) => rows.filter((r) => r.ratio > 1.05);      // (a shimmering word is painted by its gradient, not its colour)
/** The rows a quiet thing is drawn as. (A mark in the accent, a running step's, is not a quiet one.) */
const quiet = (rows, what) => rows.filter((r) => what.test(r.what) && (r.kind !== "mark" || grey(r.color)));
const say = (r) => `${r.what} "${r.text}" is ${r.color} on ${r.ground}, ${r.ratio}:1`;

for (const scene of ["work", "chatdgc", "pips"]) for (const width of [700, 300]) {
  test(`${scene}, dark, ${width}px: every quiet word and mark is Codex's dull grey (the text at 65%), and reads at 4.5:1`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await OPEN[scene](browser, { width, theme: "dark-modern" });
    try {
      const rows = drawn(await inks(x.page)), { text } = await groundAndText(x.page);
      for (const what of QUIET[scene]) {
        const hits = quiet(rows, what);
        if (width === 700) assert.ok(hits.length, `${what} is on the page`);
        for (const r of hits) {
          const want = codex(text, r.ground);
          // Codex's grey there, within a shade or two; on a raised ground (a pill, a field) the firmer #9a9a9a.
          assert.ok(grey(r.color) && r.color[0] >= 132 && r.color[0] <= Math.max(want[0] + 9, 157), `${say(r)}; Codex's grey there is ${want}`);
          assert.ok(r.color[0] <= text[0] * 0.76, `${say(r)}: clearly duller than the text (${text})`);
          assert.ok(r.ratio >= (r.kind === "mark" ? 3 : 4.5), say(r));
        }
      }
      for (const what of BRIGHT[scene]) { const hits = rows.filter((r) => what.test(r.what)); if (width === 700) assert.ok(hits.length, `${what} is on the page`);
        for (const r of hits) assert.deepEqual(r.color, text, `${say(r)}: body text and code stay as bright as they were`); }
    } finally { await x.close?.(); await x.page.context().close().catch(() => {}); }
  });
  test(`${scene}, light, ${width}px: every quiet word and mark is a dull grey (#6c6c6c, the nearest to Codex's that reads at 4.5:1)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await OPEN[scene](browser, { width, theme: "light-modern" });
    try {
      const rows = drawn(await inks(x.page)), { text } = await groundAndText(x.page);
      for (const what of QUIET[scene]) {
        const hits = quiet(rows, what);
        if (width === 700) assert.ok(hits.length, `${what} is on the page`);
        for (const r of hits) {
          // #6c6c6c, the lightest grey that reads at 4.5:1 on a light side bar; on a washed ground the firmer #5e5e5e.
          assert.ok(grey(r.color) && r.color[0] >= 88 && r.color[0] <= 118, `${say(r)}; the grey is 108,108,108 (94 on a washed ground)`);
          assert.ok(r.color[0] >= text[0] + 28, `${say(r)}: clearly duller than the text (${text})`);
          assert.ok(r.ratio >= (r.kind === "mark" ? 3 : 4.5), say(r));
        }
      }
      for (const what of BRIGHT[scene]) for (const r of rows.filter((row) => what.test(row.what))) assert.deepEqual(r.color, text, `${say(r)}: body text and code stay as they were`);
    } finally { await x.close?.(); await x.page.context().close().catch(() => {}); }
  });
}

test("no small word in a Work session, a ChatDGC chat or a Pip's chat reads under 4.5:1, dark or light, 700 or 300 px", async (t) => {
  if (skipOrFail(t)) return;
  const low = [];
  for (const scene of ["work", "chatdgc", "pips"]) for (const theme of ["dark-modern", "light-modern"]) for (const width of [700, 300]) {
    const x = await OPEN[scene](browser, { width, theme });
    try { for (const r of drawn(await inks(x.page))) if (r.kind !== "mark" && r.ratio < 4.5 && grey(r.color)) low.push(`${scene} ${theme} ${width}: ${say(r)}`); }
    finally { await x.close?.(); await x.page.context().close().catch(() => {}); }
  }
  assert.deepEqual(low, []);
});

test("high contrast is as it was: quiet words are the theme's own description colour", async (t) => {
  if (skipOrFail(t)) return;
  for (const [scene, open] of [["work", openWork], ["chatdgc", openChatDgc]]) {
    const x = await open(browser, { width: 700, theme: "hc" });
    try {
      const rows = drawn(await inks(x.page));
      for (const what of [/span#modelabel/, /#followup-hint/, /time\.cd-time/, /cd-head > span\.pm$/, /#phead > span\.pm$/]) for (const r of rows.filter((row) => what.test(row.what)))
        assert.deepEqual(r.color, [255, 255, 255], `${scene}: ${say(r)}`);
    } finally { await x.close?.(); await x.page.context().close().catch(() => {}); }
  }
});

test("the token: --muted is #8d8d8d on a dark ground and #6c6c6c on a light one, opaque, and the theme's own in high contrast", async (t) => {
  if (skipOrFail(t)) return;
  const muted = async (theme) => { const x = await openWork(browser, { width: 700, theme });
    try { return await x.page.evaluate(() => { const probe = document.createElement("i"); document.body.append(probe); probe.style.color = "var(--muted)"; const c = getComputedStyle(probe).color; probe.remove();
      const m = c.match(/-?[\d.]+(e-?\d+)?/g).map(Number); return [...(c.startsWith("color(srgb") ? m.slice(0, 3).map((v) => v * 255) : m.slice(0, 3)).map(Math.round), m[3] ?? 1]; }); }
    finally { await x.close?.(); await x.page.context().close().catch(() => {}); } };
  assert.deepEqual(await muted("dark-modern"), [141, 141, 141, 1], "Dark Modern: #8d8d8d, Codex's grey on #181818 (it was #9d9d9d)");
  assert.deepEqual(await muted("light-modern"), [108, 108, 108, 1], "Light Modern: #6c6c6c (it was the text colour itself, #3b3b3b)");
  assert.deepEqual(await muted("hc"), [255, 255, 255, 1], "high contrast: unchanged");
});
