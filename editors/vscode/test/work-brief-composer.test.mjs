// Continue in Work, the Work side (media/main.js), in real Chromium: the brief a ChatDGC chat wrote arrives in a new
// session tab's prompt box before its session is ready (composer_text), stays there through session_ready (a new tab's
// draft moves to its session), is never sent by itself, and the tab keeps its folder in its state for a reload.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { BRIEF, openWorkTab } from "./support/work-tab-scene.mjs";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipReason = () => (!chromium ? "playwright is not installed" : !browser ? "Chromium could not start" : "");
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

test("the brief lands in a new session's prompt box, stays through the session's start, and isn't sent", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openWorkTab(browser);
  try {
    assert.deepEqual((await s.page.evaluate(() => window.__state?.chatTab)), { key: "0123456789abcdef", session: "", cwd: "/home/me/projects/uploads-service" },
      "the tab keeps its folder for a reload");
    await s.send({ type: "composer_text", text: BRIEF });        // the tab's page is ready before its backend is
    assert.equal(await s.value(), BRIEF);
    await s.send({ type: "session_ready", sessionId: "20261028-101500-ab" });
    assert.equal(await s.value(), BRIEF, "the new session takes the box as it was");
    await s.send({ type: "session_ready", sessionId: "20261028-101500-ab" });
    assert.equal(await s.value(), BRIEF, "announced again, still there");
    await s.page.waitForTimeout(250);                            // a draft save is 150 ms behind the box
    const saved = await s.page.evaluate(() => window.__state);
    assert.equal(saved.entries.find(([session]) => session === "20261028-101500-ab")?.[1].text, BRIEF, "kept as the session's draft for a reload");
    assert.deepEqual(await s.posted("prompt"), [], "nothing is sent until the person sends it");
    // The person edits it, then sends it themselves.
    await s.page.focus("#input");
    await s.page.keyboard.press("End");
    await s.page.keyboard.type(" Start with the tests.");
    await s.page.keyboard.press("Enter");
    const [prompt] = await s.posted("prompt");
    assert.ok(prompt.text.startsWith("Continuing from the chat “Uploads”") && prompt.text.endsWith("Carry on from here. Start with the tests."));
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("a tab in the window's own folder keeps no folder in its state", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openWorkTab(browser, { cwd: "" });
  try {
    assert.deepEqual(await s.page.evaluate(() => window.__state?.chatTab), { key: "0123456789abcdef", session: "" });
  } finally { await s.page.close(); }
});
