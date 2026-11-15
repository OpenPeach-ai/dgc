// One corner shape (live round 1, finding 24): the prompt box on every surface (Work, Chat, a Pip's chat) has the
// corner of the header tabs and the buttons, the 6 px family, not the big round corner; and the pill tray that sits on
// Work's box (and on the other two) follows it. Measured on the real pages, in real Chromium, dark and light.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openRunningTurn, openChatDgc } from "./support/codex-look-scene.mjs";
import { openChat as openPipChat } from "./support/pip-chat-scene.mjs";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "";
  if (!reason) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};
before(async () => { if (!chromium) return; try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; } });
after(async () => { await browser?.close(); });

/** The box's four corners, and the tray's two top corners when a tray is showing over it. */
const corners = (page, box) => page.evaluate((sel) => {
  const root = window.__pipsRoot || document, n = root.querySelector(sel); if (!n) return null;
  const s = getComputedStyle(n), four = [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomRightRadius, s.borderBottomLeftRadius].map(parseFloat);
  const tray = [...root.querySelectorAll(".rail-line.has-chips")].find((t) => t.checkVisibility()), ts = tray ? getComputedStyle(tray) : null;
  const button = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--btn-r")) || 6;
  return { box: four, tray: ts ? [ts.borderTopLeftRadius, ts.borderTopRightRadius].map(parseFloat) : null, pad: tray ? parseFloat(getComputedStyle(tray).getPropertyValue("--shell-pad")) || 6 : 0, button };
}, box);

for (const theme of ["dark", "light"]) {
  test(`Work's prompt box and its pill tray have the 6 px family's corner (${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openRunningTurn(browser, { width: 440, theme: `${theme}-modern`, approval: false });
    try {
      const c = await corners(x.page, "#cbox");
      assert.deepEqual(c.box, [6, 6, 6, 6], "the box");
      assert.ok(c.tray, "the tray is showing (a queued message)");
      // The tray is the shell round the box: its corner is the box's, a shell's width further out, never the big round one.
      assert.deepEqual(c.tray, [c.button + c.pad, c.button + c.pad], "the tray's top corners follow the box");
    } finally { await x.page.close(); }
  });
  test(`ChatDGC's prompt box has the 6 px family's corner (${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openChatDgc(browser, { width: 440, theme: `${theme}-modern` });
    try { assert.deepEqual((await corners(x.page, ".cd-box")).box, [6, 6, 6, 6]); } finally { await x.page.close(); }
  });
  for (const where of ["side", "tab"]) test(`a Pip's prompt box has the 6 px family's corner (${theme}, in the ${where === "side" ? "side bar" : "editor"})`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openPipChat(browser, { width: where === "side" ? 300 : 700, theme, where, project: true, running: true, api: 97, doing: "Waiting for its computer: it's finishing 'Book the 9 am train'" });
    try {
      const c = await corners(x.p, ".pip-composer");
      assert.deepEqual(c.box, [6, 6, 6, 6]);
      if (c.tray) assert.deepEqual(c.tray, [c.button + c.pad, c.button + c.pad]);
    } finally { await x.close(); }
  });
}
