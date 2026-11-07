import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openThinkingPage } from "./render-thinking.mjs";

// The real clock (msgtime.js), as the panel loads it: every card's first line then carries its time, as in VS Code. The
// first version of this test had no clock, so it missed the time crowding "failed again" at 300 px (recheck, 7 Nov).
const MSGTIME = readFileSync(new URL("../media/msgtime.js", import.meta.url), "utf8");
async function openCards(browser, options) {
  const page = await openThinkingPage(browser, { ...options, events: [events[0]] });
  await page.evaluate(([clock, list]) => {
    eval(clock);
    for (const event of list) window.dispatchEvent(new MessageEvent("message", { data: { type: "event", event } }));
  }, [MSGTIME, events.slice(1)]);
  await page.waitForTimeout(120);
  return page;
}

// A Pip report card fits a 300 px side bar (live check, 7 Nov): "Check sign-in" is wider than Fix and pushed the ✕ past
// the card's edge, and a clean run's one line ("fixed · nothing found", its time, Open, ✕ and the chevron) ran off the
// chat, so it could be neither opened in Pips nor dismissed. Every button, time and chevron sits inside its card, closed
// and opened. jsdom computes no layout: this is Chromium. DGC_REQUIRE_CHROMIUM=1 turns a missing browser into a failure.
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
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

const pip = (c) => "pip_" + c.repeat(32), run = (c) => "run_" + c.repeat(32);
const base = (c, name) => ({ pip_id: pip(c), name, pip_type: "scout", kind: "audit", earlier: 0 });
const KEY = { ...base("1", "Docs check"), run_id: run("1"), outcome: "failed", finished_at: "2026-11-07T16:18:00.000Z",
  reason: "Its model provider turned down the API key.", detail: "HTTP 401 from Responses API: {}", sign_in: true };
const FOUND = { ...base("2", "Price checker"), run_id: run("2"), outcome: "findings", finished_at: "2026-11-07T16:10:00.000Z",
  total: 1, counts: { high: 1 }, findings: [{ title: "Discount applied twice", severity: "high", path: "app/price.py", line: 9 }] };
const FIXED = { ...base("2", "Price checker"), run_id: run("3"), outcome: "clear", finished_at: "2026-11-07T16:19:00.000Z",
  total: 0, counts: {}, findings: [] };
const AGAIN_1 = { ...base("4", "Nightly review — data & Tally integrity"), run_id: run("4"), outcome: "failed",
  finished_at: "2026-11-07T16:00:00.000Z", reason: "Its worker stopped unexpectedly.", detail: "worker exited with status 1" };
const AGAIN_2 = { ...AGAIN_1, run_id: run("5"), finished_at: "2026-11-07T16:20:00.000Z", reason: "It ran out of time.", detail: "" };
const CLEAR = { ...base("6", "GST watchdog — e-invoice & e-way"), run_id: run("6"), outcome: "clear",
  finished_at: "2026-11-07T16:21:00.000Z", total: 0, counts: {}, findings: [] };

// Separate cards (a message between each), so none fold into a group.
const events = [{ type: "ready", capabilities: { pip_reports: 1 }, model: "m", mode: "default", think: "off" }];
for (const r of [KEY, FOUND, FIXED, AGAIN_1, AGAIN_2, CLEAR]) {
  events.push({ type: "pip_report", report: r });
  if (r !== FOUND && r !== AGAIN_1) events.push({ type: "info", message: `between ${r.run_id.slice(4, 8)}` });
}

const OUTSIDE = `(() => [...document.querySelectorAll("#log .pip-report")].flatMap((card) => {
  const c = card.getBoundingClientRect();
  const log = document.getElementById("log").getBoundingClientRect();
  return [...card.querySelectorAll("button, .pip-report-line-when, .pip-report-chevron, .pip-report-line-state")]
    .filter((n) => n.checkVisibility() && n.getBoundingClientRect().width > 0)
    .filter((n) => { const b = n.getBoundingClientRect();
      return b.right > c.right + 0.5 || b.left < c.left - 0.5 || b.right > log.right + 0.5; })
    .map((n) => \`\${card.dataset.run.slice(4, 8)} \${card.dataset.shown}: \${n.className || n.tagName} "\${(n.textContent || n.getAttribute("aria-label") || "").trim()}"\`);
}))()`;

for (const width of [300, 360, 900]) {
  test(`at ${width} px every card's buttons, time and chevron sit inside it, closed and opened`, async (t) => {
    if (skipOrFail(t)) return;
    const page = await openCards(browser, { width, height: 1400 });
    try {
      const ids = await page.evaluate(() => [...document.querySelectorAll("#log .pip-report")].map((c) => c.dataset.run.slice(4, 8)));
      assert.deepEqual(ids, ["1111", "3333", "5555", "6666"], "one card per Pip, none folded");
      assert.deepEqual(await page.evaluate(OUTSIDE), [], "closed");
      assert.ok(await page.evaluate(() => document.querySelectorAll("#log .pip-report time").length >= 4), "the cards carry their times");
      // What happened reads whole on a card with a second line ("failed again", "failed"): the name gives way first.
      const cut = await page.evaluate(() => [...document.querySelectorAll("#log .pip-report:not(.quiet) .pip-report-line-state")]
        .filter((n) => n.scrollWidth > n.clientWidth + 0.5).map((n) => n.textContent));
      assert.deepEqual(cut, [], "what happened is never cut on a card with a second line");
      // A refused key still offers Check sign-in somewhere a click reaches, and a clean card keeps Open and Dismiss.
      const reach = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll("#log .pip-report")].map((c) =>
        [c.dataset.run.slice(4, 8), [...c.querySelectorAll("button")].filter((b) => b.checkVisibility())
          .map((b) => (b.textContent || b.getAttribute("aria-label")).trim())])));
      assert.ok(reach["1111"].includes("Check sign-in"), JSON.stringify(reach));
      // Closed, a clean run keeps ✕; in a narrow card its Open moves into the opened card (checked below).
      assert.ok(reach["3333"].includes("Dismiss") && (width < 400 || reach["3333"].includes("Open")), JSON.stringify(reach));
      for (const id of ["1111", "3333", "5555", "6666"]) await page.click(`#log .pip-report[data-run="run_${id.repeat(8)}"] .pip-report-line1`);
      assert.deepEqual(await page.evaluate(OUTSIDE), [], "opened");
      const opened = await page.evaluate(() => [...document.querySelectorAll("#log .pip-report")].map((c) =>
        [c.dataset.shown, [...c.querySelectorAll("button")].filter((b) => b.checkVisibility())
          .map((b) => (b.textContent || b.getAttribute("aria-label")).trim())]));
      // Opened, a card says when its run finished.
      const timeless = await page.evaluate(() => [...document.querySelectorAll("#log .pip-report")]
        .filter((c) => ![...c.querySelectorAll("time")].some((t) => t.checkVisibility() && t.getBoundingClientRect().width > 0))
        .map((c) => c.dataset.run.slice(4, 8)));
      assert.deepEqual(timeless, [], "opened, every card shows its time");
      for (const [shown, buttons] of opened) {
        assert.equal(shown, "open");
        assert.ok(buttons.some((b) => /^Open/.test(b)) && buttons.includes("Dismiss"), `opened, Open and Dismiss are reachable: ${buttons}`);
      }
    } finally { await page.close(); }
  });
}
