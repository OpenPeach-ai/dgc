// Settings › Dev Mode › "Work on a subscription uses DGC's tools" (config key dev_subscription_tools, off by default), on
// the real Settings page in Chromium (test/support/settings-scene.mjs). With it on, Work on Claude Code or Codex runs
// with the CLI as its model only and DGC's tools doing the work (dgc/work_cli.py). It shows only while Dev Mode is on
// and only with a DGC that says it takes the key (ready.capabilities.dev_subscription_tools); turning it on shows a
// plain warning once, with Got it; Save all writes it; it is never sent to a DGC that would refuse the whole save.
// (The host's half, what set_config is sent and the warning remembered, is in panel-settings.test.mjs.)
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

const DEV = { dev_limits_table: DEV_TABLE, dev_sub_capable: true, dev_mode_warned: true };
const NAME = "Work on a subscription uses DGC's tools";
const LINE = "Claude Code or Codex is Work's model only: its own tools stay off, and DGC's tools, permissions and helpers do the work.";
const row = (page) => page.evaluate(() => { const s = document.getElementById("dev_subscription_tools"), f = s?.closest(".field");
  return s && { name: f.querySelector(".name").textContent, hint: f.querySelector(".hint").textContent, role: s.getAttribute("role"), on: s.getAttribute("aria-checked"),
    label: s.getAttribute("aria-label") || "", afterDevMode: !!(f.compareDocumentPosition(document.getElementById("dev_mode")) & Node.DOCUMENT_POSITION_PRECEDING) }; });
const warning = (page) => page.evaluate(() => { const w = document.getElementById("dev-sub-warning");
  return w && { title: w.querySelector(".dev-warning-title")?.textContent || "", words: w.querySelector(".dev-warning-words")?.textContent || "",
    role: w.getAttribute("role"), button: w.querySelector("#dev-sub-warning-ok")?.textContent || "" }; });
const save = async (x) => { await x.page.click("#save"); await x.page.waitForFunction(() => document.getElementById("save-status")?.textContent === "Saved"); return x.saved(); };

test("the switch: under Dev Mode while it is on, off by default, with its one line; Save all writes dev_subscription_tools", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openSettings(browser, { extra: { ...DEV, dev_mode: true, dev_sub_warned: true }, section: "dev" });
  try {
    await x.page.waitForSelector("#dev_subscription_tools");
    assert.deepEqual(await row(x.page), { name: NAME, hint: LINE, role: "switch", on: "false", label: NAME, afterDevMode: true });
    assert.equal((await save(x)).dev_subscription_tools, false, "untouched, a save says it is off");
    await x.page.click("#dev_subscription_tools");
    assert.equal((await row(x.page)).on, "true");
    assert.equal(await warning(x.page), null, "the warning was read in this editor already");
    const values = await save(x);
    assert.equal(values.dev_subscription_tools, true, "the key, as DGC names it");
    assert.equal(values.dev_mode, true);
    await x.page.click("#dev_subscription_tools");
    assert.equal((await save(x)).dev_subscription_tools, false);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("turning it on the first time shows the warning once, in plain words; Got it puts it away for good", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openSettings(browser, { extra: { ...DEV, dev_mode: true }, section: "dev" });
  try {
    await x.page.waitForSelector("#dev_subscription_tools");
    assert.equal(await warning(x.page), null, "nothing until it is turned on");
    await x.page.click("#dev_subscription_tools");
    await x.page.waitForSelector("#dev-sub-warning");
    const said = await warning(x.page);
    assert.equal(said.role, "alert");
    assert.equal(said.button, "Got it");
    assert.match(said.title, /Claude Code or Codex/);
    assert.match(said.words, /terms may not allow/, "the providers' terms, said plainly");
    assert.match(said.words, /never reads, copies or refreshes/, "DGC never touches the CLI's login");
    assert.doesNotMatch(said.title + said.words, /\bAI\b/);
    assert.equal((await row(x.page)).on, "true", "the switch stays as it was turned");
    await x.page.click("#dev-sub-warning-ok");
    await x.page.waitForFunction(() => !document.getElementById("dev-sub-warning"));
    assert.equal((await x.posted("devSubscriptionWarned")).length, 1, "the host is told, so it never shows again here");
    // Off and on again: not shown a second time.
    await x.page.click("#dev_subscription_tools");
    await x.page.click("#dev_subscription_tools");
    await x.rest();
    assert.equal(await warning(x.page), null);
    assert.equal((await save(x)).dev_subscription_tools, true);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("what DGC already has is what the switch shows; it hides with Dev Mode off", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openSettings(browser, { extra: { ...DEV, dev_mode: false, dev_sub_warned: true, dev_subscription_tools: true }, section: "dev" });
  try {
    await x.page.waitForSelector("#dev_mode");
    assert.equal(await row(x.page), null, "Dev Mode is off: no switch");
    await x.page.click("#dev_mode"); await x.page.waitForSelector("#dev_subscription_tools");
    assert.equal((await row(x.page)).on, "true", "as it was left");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("a DGC that doesn't take the key: no switch, and the key is never sent (it would refuse the whole save)", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openSettings(browser, { extra: { dev_limits_table: DEV_TABLE, dev_mode: true, dev_mode_warned: true }, section: "dev" });
  try {
    await x.page.waitForSelector("#settings-dev-limits");
    assert.equal(await row(x.page), null);
    const values = await save(x);
    assert.equal("dev_subscription_tools" in values, false);
    assert.equal(values.dev_mode, true);
  } finally { await x.close(); }
});

test("300 px and 700 px, dark and light: the row and the warning fit, in the page's own shapes", async (t) => {
  if (skipOrFail(t)) return;
  for (const theme of ["dark", "light"]) for (const width of [300, 700]) {
    const x = await openSettings(browser, { extra: { ...DEV, dev_mode: true }, section: "dev", theme, width });
    try {
      await x.page.waitForSelector("#dev_subscription_tools");
      await x.page.click("#dev_subscription_tools"); await x.page.waitForSelector("#dev-sub-warning");
      const seen = await x.page.evaluate(() => { const w = document.getElementById("dev-sub-warning"), ok = document.getElementById("dev-sub-warning-ok"),
        s = document.getElementById("dev_subscription_tools"), other = document.getElementById("dev_mode"), r = (n) => n.getBoundingClientRect();
        return { overflow: document.documentElement.scrollWidth > innerWidth, okRadius: getComputedStyle(ok).borderTopLeftRadius,
          okInside: r(ok).right <= r(w).right + 0.5, warningInside: r(w).right <= innerWidth + 0.5, background: getComputedStyle(w).backgroundColor,
          same: [r(s).width, r(s).height, getComputedStyle(s).borderTopLeftRadius].join() === [r(other).width, r(other).height, getComputedStyle(other).borderTopLeftRadius].join() }; });
      assert.equal(seen.overflow, false, `${theme} ${width}: nothing runs off the page`);
      assert.equal(seen.okRadius, "6px");
      assert.ok(seen.okInside && seen.warningInside, `${theme} ${width}: the warning and its button stay inside`);
      assert.notEqual(seen.background, "rgba(0, 0, 0, 0)", `${theme} ${width}: the warning has its own solid ground`);
      assert.equal(seen.same, true, `${theme} ${width}: the same switch as Dev Mode's own`);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  }
});
