// Stop computer (user test P12): the stop works, and the tab then printed the closing stream's own words, a raw
// "[Errno 2] No such file or directory", over "Open the screen again", with "Stopped. Its sign-ins are kept." in a line
// at the bottom. In real Chromium, on the real client and viewer (test/support/pip-computer-scene.mjs): after Stop the
// tab shows the stopped state and nothing else, whichever comes first (DGC's answer or the stream's close); a screen
// that closes on its own still says why; and Open the screen again opens it.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openComputer } from "./support/pip-computer-scene.mjs";

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
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

const RAW = "[Errno 2] No such file or directory";
const stop = async (x) => { await x.p.evaluate(() => { const b = [document.getElementById("pc-stop"), ...document.querySelectorAll('[data-action="pc-stop"], [data-id="pc-stop"]')].find((e) => e && e.checkVisibility()); if (b) b.click(); else { document.getElementById("pc-more")?.click(); } });
  if (await x.p.evaluate(() => !window.__sent.some((r) => r.type === "stop_pip_computer"))) { await x.p.waitForTimeout(100); await x.p.evaluate(() => [...document.querySelectorAll("button")].find((b) => /Stop computer/.test(b.textContent) && b.checkVisibility())?.click()); }
  await x.p.waitForFunction(() => window.__sent.some((r) => r.type === "stop_pip_computer")); await x.p.waitForFunction(() => !!document.querySelector("#pc-overlay .pc-overlay-card")); await x.p.waitForTimeout(250); };
const shown = (x) => x.p.evaluate(() => ({ card: document.querySelector("#pc-overlay .pc-overlay-card p")?.textContent || "", again: !!document.querySelector("#pc-reconnect")?.checkVisibility(),
  all: document.getElementById("app").innerText, errors: [...document.querySelectorAll(".pc-error, [role=alert]")].map((e) => e.textContent).filter(Boolean),
  notices: [...document.querySelectorAll(".pc-notice[role=status]")].filter((e) => e.checkVisibility()).map((e) => e.textContent) }));

for (const stopFirst of [false, true]) for (const theme of ["dark", "light"]) {
  test(`${theme}: after Stop computer the tab shows the stopped state alone${stopFirst ? " (the stream closes before DGC answers)" : ""}`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openComputer(browser, { theme, stopReason: RAW, stopFirst });
    try {
      await stop(x);
      const s = await shown(x);
      assert.doesNotMatch(s.all, /Errno|No such file/, "no raw system line anywhere on the tab");
      assert.equal(s.card, "Stopped. Its sign-ins are kept.", "the stopped state, where the screen was");
      assert.equal(s.again, true, "with the way back");
      assert.deepEqual(s.errors, []);
      assert.deepEqual(s.notices, [], "said once: no second line under it");
      // It stays stopped: the tab's own looks (every few seconds) never open the screen of a computer the user stopped.
      if (!stopFirst && theme === "dark") { await x.p.waitForTimeout(3600); assert.equal((await shown(x)).card, "Stopped. Its sign-ins are kept.", "still stopped"); assert.equal(x.servers.length, 1, "no new stream by itself"); }
      // The way back opens the screen, and what follows is an ordinary screen again.
      await x.p.click("#pc-reconnect");
      await x.p.waitForFunction(() => !document.querySelector("#pc-overlay .pc-overlay-card") && !document.querySelector("#pc-overlay .pc-overlay-note"));
      assert.equal(x.servers.length, 2, "a new stream");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("a screen that closes on its own still says why, and never in the system's own words", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openComputer(browser, {});
  try {
    await x.p.evaluate(() => window.postMessage({ type: "pipDesktopClosed", reason: "Its computer was restarted from Settings." }, "*"));
    await x.p.waitForFunction(() => !!document.querySelector("#pc-overlay .pc-overlay-card"));
    assert.equal((await shown(x)).card, "Its computer was restarted from Settings.", "DGC's own words are kept");
    await x.p.click("#pc-reconnect"); await x.p.waitForFunction(() => !document.querySelector("#pc-overlay .pc-overlay-card") && !document.querySelector("#pc-overlay .pc-overlay-note"));
    // After a stop long past and a new screen, a close is no longer "Stopped".
    await x.p.evaluate((raw) => window.postMessage({ type: "pipDesktopClosed", reason: raw }, "*"), RAW);
    await x.p.waitForFunction(() => !!document.querySelector("#pc-overlay .pc-overlay-card"));
    const s = await shown(x);
    assert.equal(s.card, "The screen closed.", "a system error line is not shown to the user as it is");
    assert.doesNotMatch(s.all, /Errno/);
  } finally { await x.close(); }
});
