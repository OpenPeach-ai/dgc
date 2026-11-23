// Settings › Dev Mode › "Let DGC change Dev Mode settings" (decided 14 Nov), on the real Settings page in Chromium
// (test/support/settings-scene.mjs): the user's own switch for DGC's Dev Mode tools (config key dev_mode_tools, off by
// default). It shows only while Dev Mode is on and only with a DGC that says it takes the key; the one-time warning
// that comes with turning Dev Mode on carries the same choice as a tick box, off by default; Save all writes it with
// the page's other settings; and it is never sent to a DGC that would refuse the whole save for it.
// (The host's half, what set_config is sent, is in panel-settings.test.mjs.)
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openSettings, DEV_TABLE } from "./support/settings-scene.mjs";

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
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

const DEV = { dev_limits_table: DEV_TABLE, dev_tools_capable: true };
const NAME = "Let DGC change Dev Mode settings";
const LINE = "When you ask, DGC can change these limits itself (it says what it changed, with Undo). It can never turn on Dev Mode.";
/** The switch's row as it is on screen, or null. */
const row = (page) => page.evaluate(() => { const s = document.getElementById("dev_mode_tools"), f = s?.closest(".field");
  return s && { name: f.querySelector(".name").textContent, hint: f.querySelector(".hint").textContent, role: s.getAttribute("role"), on: s.getAttribute("aria-checked"),
    label: s.getAttribute("aria-label") || "", afterDevMode: !!(f.compareDocumentPosition(document.getElementById("dev_mode")) & Node.DOCUMENT_POSITION_PRECEDING),
    beforeLimits: !!(f.compareDocumentPosition(document.getElementById("settings-dev-limits")) & Node.DOCUMENT_POSITION_FOLLOWING) }; });
const save = async (x) => { await x.page.click("#save"); await x.page.waitForFunction(() => document.getElementById("save-status")?.textContent === "Saved"); return x.saved(); };

test("the switch: under Dev Mode while it is on, off by default, with its one quiet line; Save all writes dev_mode_tools", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openSettings(browser, { extra: { ...DEV, dev_mode: true, dev_mode_warned: true }, section: "dev" });
  try {
    await x.page.waitForSelector("#settings-dev-limits");
    assert.deepEqual(await row(x.page), { name: NAME, hint: LINE, role: "switch", on: "false", label: NAME, afterDevMode: true, beforeLimits: true });
    // Untouched, a save says it is off: only the user turns it on.
    assert.equal((await save(x)).dev_mode_tools, false);
    await x.page.click("#dev_mode_tools");
    assert.equal((await row(x.page)).on, "true");
    assert.match(await x.page.textContent("#save-status"), /Unsaved changes on Dev Mode/, "it waits for Save all, like the page's other settings");
    const values = await save(x);
    assert.equal(values.dev_mode_tools, true, "the key, as DGC names it");
    assert.equal(values.dev_mode, true);
    assert.equal((await row(x.page)).on, "true", "what DGC has is what the switch shows");
    // And off again.
    await x.page.click("#dev_mode_tools");
    assert.equal((await save(x)).dev_mode_tools, false);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("what DGC already has is what the switch shows", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openSettings(browser, { extra: { ...DEV, dev_mode: true, dev_mode_warned: true, dev_mode_tools: true }, section: "dev" });
  try {
    await x.page.waitForSelector("#dev_mode_tools");
    assert.equal((await row(x.page)).on, "true");
  } finally { await x.close(); }
});

test("it hides with Dev Mode off, and comes back with it", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openSettings(browser, { extra: { ...DEV, dev_mode: false, dev_mode_warned: true, dev_mode_tools: true }, section: "dev" });
  try {
    await x.page.waitForSelector("#dev_mode");
    assert.equal(await row(x.page), null, "Dev Mode is off: no switch");
    assert.doesNotMatch(await x.page.textContent("#page"), /Let DGC change/);
    await x.page.click("#dev_mode"); await x.page.waitForSelector("#dev_mode_tools");
    assert.equal((await row(x.page)).on, "true", "as it was left");
    await x.page.click("#dev_mode"); await x.page.waitForFunction(() => !document.getElementById("dev_mode_tools"));
    assert.equal(await row(x.page), null);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("turning Dev Mode on: the warning carries the same choice as a tick box, off by default", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openSettings(browser, { extra: DEV, section: "dev" });
  try {
    await x.page.waitForSelector("#dev_mode");
    await x.page.click("#dev_mode"); await x.page.waitForSelector("#dev-warning");
    const box = () => x.page.evaluate(() => { const b = document.getElementById("dev-warning-tools"), l = b?.closest("label");
      return b && { type: b.type, checked: b.checked, inWarning: !!b.closest("#dev-warning"), words: l?.textContent.trim() || "", beforeGotIt: !!(b.compareDocumentPosition(document.getElementById("dev-warning-ok")) & Node.DOCUMENT_POSITION_FOLLOWING) }; });
    assert.deepEqual(await box(), { type: "checkbox", checked: false, inWarning: true, words: "Let DGC change Dev Mode settings when you ask", beforeGotIt: true });
    assert.equal(await row(x.page), null, "one control for it at a time: the switch takes over once the warning has been read");
    // Ticked, then Got it: the switch below says so, and Save all writes it.
    await x.page.check("#dev-warning-tools");
    assert.equal((await box()).checked, true);
    await x.page.click("#dev-warning-ok"); await x.page.waitForFunction(() => !document.getElementById("dev-warning"));
    assert.equal((await row(x.page)).on, "true");
    const values = await save(x);
    assert.deepEqual([values.dev_mode, values.dev_mode_tools], [true, true]);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
  // Left unticked: off.
  const y = await openSettings(browser, { extra: DEV, section: "dev" });
  try {
    await y.page.waitForSelector("#dev_mode");
    await y.page.click("#dev_mode"); await y.page.waitForSelector("#dev-warning");
    await y.page.click("#dev-warning-ok"); await y.page.waitForSelector("#dev_mode_tools");
    assert.equal((await row(y.page)).on, "false");
    assert.equal((await save(y)).dev_mode_tools, false);
  } finally { await y.close(); }
});

test("a DGC that doesn't take the key: no switch, no tick box, and the key is never sent (it would refuse the whole save)", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openSettings(browser, { extra: { dev_limits_table: DEV_TABLE }, section: "dev" });
  try {
    await x.page.waitForSelector("#dev_mode");
    await x.page.click("#dev_mode"); await x.page.waitForSelector("#dev-warning");
    assert.equal(await x.page.$("#dev-warning-tools"), null);
    await x.page.click("#dev-warning-ok"); await x.page.waitForSelector("#settings-dev-limits");
    assert.equal(await row(x.page), null);
    const values = await save(x);
    assert.equal("dev_mode_tools" in values, false);
    assert.equal(values.dev_mode, true);
  } finally { await x.close(); }
});

test("300 px and 700 px, dark and light: the row and the tick line fit, in the page's own shapes", async (t) => {
  if (skipOrFail(t)) return;
  for (const theme of ["dark", "light"]) for (const width of [300, 700]) {
    const x = await openSettings(browser, { extra: { ...DEV, dev_mode: true }, section: "dev", theme, width });
    try {
      await x.page.waitForSelector("#dev-warning-tools");
      const seen = await x.page.evaluate(() => { const box = document.getElementById("dev-warning-tools"), label = box.closest("label"), ok = document.getElementById("dev-warning-ok"), r = (n) => n.getBoundingClientRect();
        return { overflow: document.documentElement.scrollWidth > innerWidth, labelRight: r(label).right, okRadius: getComputedStyle(ok).borderTopLeftRadius, boxRadius: parseFloat(getComputedStyle(box).borderTopLeftRadius), width: innerWidth,
          warningRight: r(document.getElementById("dev-warning")).right }; });
      assert.equal(seen.overflow, false, `${theme} ${width}: nothing runs off the page`);
      assert.ok(seen.labelRight <= seen.warningRight + 0.5, `${theme} ${width}: the tick line stays inside the warning`);
      assert.equal(seen.okRadius, "6px");
      assert.ok(seen.boxRadius <= 6, `${theme} ${width}: the tick box is a box, never a pill`);
      await x.page.click("#dev-warning-ok"); await x.page.waitForSelector("#dev_mode_tools");
      const sw = await x.page.evaluate(() => { const s = document.getElementById("dev_mode_tools"), other = document.getElementById("dev_mode"), r = (n) => n.getBoundingClientRect();
        return { same: [r(s).width, r(s).height, getComputedStyle(s).borderTopLeftRadius].join() === [r(other).width, r(other).height, getComputedStyle(other).borderTopLeftRadius].join(),
          overflow: document.documentElement.scrollWidth > innerWidth, right: r(s).right <= innerWidth }; });
      assert.deepEqual(sw, { same: true, overflow: false, right: true }, `${theme} ${width}: the same switch as Dev Mode's own`);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  }
});
