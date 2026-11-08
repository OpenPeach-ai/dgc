import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openThinkingPage } from "./render-thinking.mjs";

// Two or more Pip reports fold into one line ("2 Pip reports · 2 clear"); opened, each report is a row under it. The
// a user's screenshot (25 Oct): opened, the second row sat on top of the first. A standalone slim card after another
// is pulled up 12px so their borders meet (`.pip-report.slim + .pip-report.slim`), and that rule outranked the group's
// own `margin: 0`. jsdom computes no layout, so pip-report-card.test.mjs could not see it: this is Chromium.
// DGC_REQUIRE_CHROMIUM=1 turns a missing browser into a failure.
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

const PIP = "pip_" + "b".repeat(32);
const report = (n, name, outcome, extra = {}) => ({
  run_id: "run_" + String(n).repeat(32), pip_id: "pip_" + String(n).repeat(32), name, pip_type: "scout", kind: "audit", outcome,
  finished_at: `2026-10-25T14:3${n}:00.000Z`, earlier: 0, total: 0, counts: {}, findings: [], ...extra });
const CLEAR_A = report(1, "ERP daily audit — data & Tally integrity", "clear");
const CLEAR_B = report(2, "GST watchdog — e-invoice & e-way", "clear");
const FINDINGS = report(3, "Lock review", "findings", { total: 2, counts: { high: 1, low: 1 },
  findings: [{ title: "Session lock never expires", severity: "high", path: "app/lock.py", line: 9 }] });

const ROWS = `(() => {
  const group = document.querySelector("#log .pip-report-group");
  const box = (n) => n.getBoundingClientRect();
  const head = box(group.querySelector(":scope > .pip-report-group-head"));
  const rows = [...group.querySelectorAll(":scope > .pip-report")].map((n) => {
    const b = box(n); return { top: b.top, bottom: b.bottom, drawn: n.checkVisibility() && b.height > 0 };
  });
  return { shown: group.dataset.shown, head: { top: head.top, bottom: head.bottom }, rows };
})()`;

for (const [what, reports] of [["two clear reports", [CLEAR_A, CLEAR_B]], ["three, one with findings", [CLEAR_A, CLEAR_B, FINDINGS]]]) {
  test(`opened, ${what} are rows one under another, never on top of each other`, async (t) => {
    if (skipOrFail(t)) return;
    const page = await openThinkingPage(browser, { width: 900, height: 900, events: [
      { type: "ready", capabilities: { pip_reports: 1 }, model: "m", mode: "default", think: "off" },
      ...reports.map((r) => ({ type: "pip_report", report: r }))] });
    try {
      const folded = await page.evaluate(ROWS);
      assert.equal(folded.shown, "closed");
      assert.ok(folded.rows.every((r) => !r.drawn), "folded, no row is drawn");
      await page.click("#log .pip-report-group-head");
      const open = await page.evaluate(ROWS);
      assert.equal(open.shown, "open");
      assert.equal(open.rows.length, reports.length);
      assert.ok(open.rows.every((r) => r.drawn), "opened, every row is drawn");
      assert.ok(open.rows[0].top >= open.head.bottom - 0.5, "the first row is under the head");
      for (let i = 1; i < open.rows.length; i++) {
        assert.ok(open.rows[i].top >= open.rows[i - 1].bottom - 0.5,
          `row ${i + 1} starts at ${open.rows[i].top}, inside row ${i} (which ends at ${open.rows[i - 1].bottom})`);
      }
    } finally {
      await page.close();
    }
  });
}

// One size for a Pip's face (reported 8 Nov, with a screenshot): opened, a clean run's row ("fixed · nothing found") drew
// its face smaller than the rows with findings, and a card alone drew it larger. Every face is the size of the faces
// stacked on the group's line.
const FACES = `(() => {
  const size = (n) => { const b = n.getBoundingClientRect(); return [Math.round(b.width * 10) / 10, Math.round(b.height * 10) / 10]; };
  return { stacked: [...document.querySelectorAll("#log .pip-report-group-faces > span")].map(size),
           rows: [...document.querySelectorAll("#log .pip-report .pip-report-face")].filter((n) => n.checkVisibility()).map(size) };
})()`;
test("every Pip face in reports is one size: the size stacked on the group's line", async (t) => {
  if (skipOrFail(t)) return;
  const second = report(4, "Morning business review — all units", "findings", { total: 1, counts: { medium: 1 },
    findings: [{ title: "Snapshot JSON carries extra fields", severity: "medium", path: "app/snap.py", line: 3 }] });
  const page = await openThinkingPage(browser, { width: 900, height: 900, events: [
    { type: "ready", capabilities: { pip_reports: 1 }, model: "m", mode: "default", think: "off" },
    ...[FINDINGS, second, CLEAR_A].map((r) => ({ type: "pip_report", report: r }))] });
  try {
    await page.click("#log .pip-report-group-head");
    const { stacked, rows } = await page.evaluate(FACES);
    assert.equal(stacked.length, 3);
    assert.equal(rows.length, 3, "a face on each row, the clean one too");
    const one = stacked[0];
    assert.ok(stacked.every((s) => s[0] === one[0] && s[1] === one[1]), JSON.stringify(stacked));
    assert.deepEqual(rows, [one, one, one], `rows ${JSON.stringify(rows)} against the line's ${JSON.stringify(one)}`);
  } finally {
    await page.close();
  }
  const alone = await openThinkingPage(browser, { width: 900, height: 900, events: [
    { type: "ready", capabilities: { pip_reports: 1 }, model: "m", mode: "default", think: "off" },
    { type: "pip_report", report: FINDINGS }] });
  try {
    const { rows } = await alone.evaluate(FACES);
    assert.deepEqual(rows, [[20, 20]], "a card on its own: the same size");
  } finally {
    await alone.close();
  }
});
