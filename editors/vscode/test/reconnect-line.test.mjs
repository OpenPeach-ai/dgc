import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { errorScene, liveScene, measureInPage, openPanel, replayScene } from "./support/reconnect-scene.mjs";

// The reconnect line is a layout fact as much as a behaviour: at 300 px the longest label a
// sub-agent can show must wrap rather than widen the panel or clip, every toggle must stay a 22 px
// target, and the muted text must stay readable in every theme once translucent tokens are
// composited. Only a real browser can measure that.
let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipReason = () => (!chromium ? "playwright is not installed (npm ci at the repository root)"
  : !browser ? "Chromium could not start" : "");
const skipOrFail = (t) => {
  if (!skipReason()) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${skipReason()}`);
  t.skip(skipReason());
  return true;
};

before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); }
  catch { browser = null; }
});
after(async () => { await browser?.close(); });

for (const theme of ["dark", "light", "light-modern", "hc"]) {
  test(`at 300 px in ${theme}, reconnect lines fit, stay 22 px targets, never clip, and read at 4.5:1`, async (t) => {
    if (skipOrFail(t)) return;
    const panel = await openPanel(browser, { width: 300, theme });
    try {
      await liveScene(panel);
      // Open one line so the detail's text is measured too.
      await panel.page.locator(".model-retry-toggle").first().click();
      await panel.settle();
      const facts = await panel.page.evaluate(measureInPage);
      assert.ok(facts.page.scrollWidth <= facts.page.clientWidth, `page scrolls sideways: ${JSON.stringify(facts.page)}`);
      assert.ok(facts.page.logScroll <= facts.page.logClient, `the log scrolls sideways: ${JSON.stringify(facts.page)}`);
      assert.equal(facts.toggles.length, 4);
      assert.ok(facts.toggles.some((toggle) => toggle.label === "Sub-agent · Server is busy, retrying 10/10"
        || toggle.label === "Sub · Server is busy, retrying 10/10"), JSON.stringify(facts.toggles.map((x) => x.label)));
      for (const toggle of facts.toggles) {
        assert.ok(toggle.scrollWidth <= toggle.clientWidth, `toggle overflows: ${JSON.stringify(toggle)}`);
        assert.ok(toggle.height >= 22, `toggle is ${toggle.height}px tall`);
        assert.equal(toggle.causeDisplay, "none", "the cause hides at 300 px (the open detail keeps it)");
        assert.ok(toggle.labelScroll <= toggle.labelClient + 1 && toggle.labelRight <= toggle.toggleRight + 0.5,
          `label clipped: ${JSON.stringify(toggle)}`);
      }
      assert.ok(facts.texts.length > 10, "the scene has text to measure");
      for (const entry of facts.texts) {
        assert.ok(entry.ratio >= 4.5, `${theme}: "${entry.text}" is ${entry.ratio.toFixed(2)}:1`);
      }
    } finally {
      await panel.page.close();
    }
  });
}

test("the longest label wraps inside the toggle at 300 px instead of pushing the chevron out", async (t) => {
  if (skipOrFail(t)) return;
  const panel = await openPanel(browser, { width: 300, theme: "dark" });
  try {
    await liveScene(panel);
    const geometry = await panel.page.evaluate(() => {
      const line = document.querySelector('.model-retry[data-retry-id="t1:sub-0123456789ab:retry1"]');
      const toggle = line.querySelector(".model-retry-toggle"), chev = line.querySelector(".model-retry-chev");
      return { toggle: toggle.getBoundingClientRect().toJSON(), chev: chev.getBoundingClientRect().toJSON(),
        label: line.querySelector(".model-retry-label").textContent };
    });
    assert.equal(geometry.label, "Sub · Server is busy, retrying 10/10", "a narrow panel shortens the sub-agent prefix");
    assert.ok(geometry.chev.right <= geometry.toggle.right + 0.5, JSON.stringify(geometry));
  } finally {
    await panel.page.close();
  }
});

test("the error row keeps its hint visible and its message pre-wrapped, without widening the panel", async (t) => {
  if (skipOrFail(t)) return;
  for (const width of [300, 460]) {
    const panel = await openPanel(browser, { width, theme: "light" });
    try {
      await errorScene(panel);
      const facts = await panel.page.evaluate(() => {
        const row = document.querySelector(".model-error");
        const hint = row.querySelector(".model-error-hint");
        row.querySelector(".model-error-toggle").click();
        const pre = row.querySelector(".model-error-message");
        return { hintVisible: hint.getBoundingClientRect().height > 0 && getComputedStyle(hint).display !== "none",
          hint: hint.textContent, whiteSpace: getComputedStyle(pre).whiteSpace,
          scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth,
          preScroll: pre.scrollWidth, preClient: pre.clientWidth };
      });
      assert.ok(facts.hintVisible && facts.hint.startsWith("→ the endpoint"), JSON.stringify(facts));
      assert.equal(facts.whiteSpace, "pre-wrap");
      assert.ok(facts.scrollWidth <= facts.clientWidth, JSON.stringify(facts));
      assert.ok(facts.preScroll <= facts.preClient + 1, JSON.stringify(facts));
    } finally {
      await panel.page.close();
    }
  }
});

for (const theme of ["dark", "light", "light-modern", "hc"]) {
  test(`in ${theme}, the open model error row reads at 4.5:1, its headline included`, async (t) => {
    if (skipOrFail(t)) return;
    const panel = await openPanel(browser, { width: 460, theme });
    try {
      await errorScene(panel);
      await panel.page.locator(".model-error-toggle").first().click();
      await panel.settle();
      const facts = await panel.page.evaluate(measureInPage);
      const rows = facts.texts.filter((entry) => entry.row === "error");
      assert.ok(rows.some((entry) => entry.text.startsWith("Could not reach the model")), JSON.stringify(rows));
      assert.ok(rows.length > 8, "the open row has text to measure");
      for (const entry of rows) {
        assert.ok(entry.ratio >= 4.5, `${theme}: "${entry.text}" is ${entry.ratio.toFixed(2)}:1`);
      }
      const icon = await panel.page.evaluate(() => {
        const row = document.querySelector(".model-error");
        return { icon: getComputedStyle(row.querySelector(".model-error-icon")).color,
          headline: getComputedStyle(row.querySelector(".model-error-headline")).color };
      });
      if (theme !== "hc") assert.notEqual(icon.icon, icon.headline, "the icon alone carries the error colour");
    } finally {
      await panel.page.close();
    }
  });
}

test("a replayed turn draws its recoveries in place and settles the one that never finished", async (t) => {
  if (skipOrFail(t)) return;
  const panel = await openPanel(browser, { width: 460, theme: "dark" });
  try {
    await replayScene(panel);
    const labels = await panel.page.evaluate(() => [...document.querySelectorAll(".model-retry")]
      .map((line) => [line.dataset.state, line.querySelector(".model-retry-label").textContent]));
    assert.deepEqual(labels, [["recovered", "Reconnected · continued from the partial answer"],
      ["unfinished", "Reconnect did not finish"], ["unfinished", "Reconnect did not finish"]]);
  } finally {
    await panel.page.close();
  }
});
