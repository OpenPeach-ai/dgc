// Small things from the 0.51 checks on a Pip's report card in Work's chat (media/main.js pipReportCard, media/main.css),
// in real Chromium on Work's real page with its real icons, dark and light:
//  - "Check sign-in" was cut to "Check sig…" (a 190 px chat with Settings open beside it; and, since every button became
//    one 76 px box, at any width). A button's words are never cut, closed or opened ("Open report" too).
//  - an opened card said its state twice: "nothing found" on its first line and "finished · nothing found" under it.
//    Opened, a card says its state once.
//  - in a 190 px chat a card with Fix pushed Open and ✕ out of the card. Every button, time and chevron sits inside its
//    card, closed and opened, at 190 and 300 px.
//  - at 300 px a card with Fix keeps its chevron inside it, before Fix and as the fix's row after (a guard: the row
//    came with "Fix it on a Pip's card runs as a helper row").
// DGC_SMALL_FIXES_SHOTS=<folder> (and DGC_SMALL_FIXES_TAG=before|after) also writes the pictures.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { openAgentLines, sendEvents, settle } from "./support/agent-lines-scene.mjs";
import { READY, SCENE, FIXING, FIXED } from "./support/pip-fix-row-scene.mjs";

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

const SHOTS = process.env.DGC_SMALL_FIXES_SHOTS || "", TAG = process.env.DGC_SMALL_FIXES_TAG || "after";
const shot = async (page, name) => { if (SHOTS) await page.locator("#log").screenshot({ path: join(SHOTS, `${name}-${TAG}.png`) }); };

const pip = (c) => "pip_" + c.repeat(32), run = (c) => "run_" + c.repeat(32);
const base = (c, name) => ({ pip_id: pip(c), name, pip_type: "scout", kind: "audit", earlier: 0 });
const ago = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
const KEY = { ...base("1", "Docs check"), run_id: run("1"), outcome: "failed", finished_at: ago(9),
  reason: "Its model provider turned down the API key.", detail: "HTTP 401 from Responses API: {}", sign_in: true };
const FOUND = { ...base("2", "Price checker"), run_id: run("2"), outcome: "findings", finished_at: ago(8), total: 5, counts: { critical: 1, high: 2, medium: 2 },
  findings: [{ title: "Discount applied twice", severity: "critical", path: "app/price.py", line: 9 }, { title: "Rounding drops cents", severity: "high", path: "app/price.py", line: 19 }] };
const FAILED = { ...base("4", "Nightly review — data & Tally integrity"), run_id: run("4"), outcome: "failed", finished_at: ago(7),
  reason: "Its worker stopped unexpectedly.", detail: "worker exited with status 1" };
const CLEAR = { ...base("6", "GST watchdog"), run_id: run("6"), outcome: "clear", finished_at: ago(6), total: 0, counts: {}, findings: [] };
const PASSED = { ...base("7", "Docs links"), run_id: run("7"), outcome: "checks_passed", finished_at: ago(5), total: 12, counts: {}, findings: [], checks: { total: 12, failed: 0 } };
// A clean run after one that found something: "fixed · nothing found".
const BROKE = { ...base("8", "Stock sync"), run_id: run("8"), outcome: "findings", finished_at: ago(30), total: 1, counts: { high: 1 }, findings: [{ title: "Stock went negative", severity: "high", path: "stock/sync.py", line: 4 }] };
const MENDED = { ...base("8", "Stock sync"), run_id: run("9"), outcome: "clear", finished_at: ago(4), total: 0, counts: {}, findings: [] };
const CARDS = [KEY, FOUND, FAILED, CLEAR, PASSED, BROKE, MENDED];
// Separate cards (a line of the chat between each), so none fold into a group.
const events = () => CARDS.flatMap((report) => [{ type: "pip_report", report }, ...(report === BROKE ? [] : [{ type: "info", message: "A line of the chat" }])]);

/** Each card as drawn: what sits outside it, whose words are cut, and every place it says its state. */
const look = (page) => page.evaluate(() => [...document.querySelectorAll("#log .pip-report")].map((card) => {
  const c = card.getBoundingClientRect(), log = document.getElementById("log").getBoundingClientRect();
  const seen = (n) => n.checkVisibility({ visibilityProperty: true, opacityProperty: true }) && n.getBoundingClientRect().width > 0;
  const all = (s) => [...card.querySelectorAll(s)].filter(seen);
  const said = (n) => (n.textContent || n.getAttribute("aria-label") || "").trim();
  return { id: card.dataset.run.slice(4, 5), shown: card.dataset.shown,
    outside: all("button, time, .pip-report-chevron, .pip-fix-chevron, .pip-report-line-state, .pip-report-state")
      .filter((n) => { const b = n.getBoundingClientRect(); return b.right > c.right + 0.5 || b.left < c.left - 0.5 || b.right > log.right + 0.5; })
      .map((n) => `${n.className.split(" ").pop()} "${said(n)}" ${Math.round(n.getBoundingClientRect().right - c.right)}px past`),
    cut: all("button").filter((n) => n.scrollWidth > n.clientWidth + 0.5).map((n) => `"${said(n)}" needs ${n.scrollWidth}px, has ${n.clientWidth}px`),
    buttons: all("button").map(said),
    states: all(".pip-report-line-state, .pip-report-head .pip-report-state").map(said),
    chevron: all(".pip-report-chevron").length };
}));
const openAll = async (page) => {
  for (const line of await page.locator("#log .pip-report .pip-report-line1").all()) await line.click({ position: { x: 24, y: 6 } });
  await settle(page);
};

// One page a width and theme, looked at closed, opened and closed again; each test reads what it is about.
const scenes = new Map();
const scene = (width, theme) => {
  const key = `${width}-${theme}`;
  if (!scenes.has(key)) scenes.set(key, (async () => {
    const page = await openAgentLines(browser, { width, height: 1500, theme, events: [READY] });
    try {
      const name = `${width}-${theme.split("-")[0]}`;
      await sendEvents(page, events()); await settle(page);
      const closed = await look(page);
      await shot(page, `cards-closed-${name}`);
      await openAll(page);
      const opened = await look(page);
      await shot(page, `cards-open-${name}`);
      await openAll(page);
      return { closed, opened, again: await look(page) };
    } finally { await page.close(); }
  })());
  return scenes.get(key);
};
const lines = (cards, field) => cards.flatMap((c) => c[field].map((x) => `${c.id}: ${x}`));

// (240 and 280 px: either side of where a card with Fix lets Open go.)
for (const theme of ["dark-modern", "light-modern"]) for (const width of [190, 240, 280, 300]) {
  test(`${theme} ${width}px: no button on a report card has its words cut, "Check sign-in" and "Open report" too`, async (t) => {
    if (skipOrFail(t)) return;
    const { closed, opened } = await scene(width, theme);
    assert.deepEqual(closed.map((c) => c.id), ["1", "2", "4", "6", "7", "9"], "one card a Pip, none folded into a group");
    assert.ok(closed[0].buttons.includes("Check sign-in"), `a refused key offers Check sign-in on the closed card: ${closed[0].buttons}`);
    assert.deepEqual(lines(closed, "cut"), [], "closed");
    assert.ok(opened[0].buttons.includes("Check sign-in") && opened[3].buttons.includes("Open report"), "opened, they are offered again");
    assert.deepEqual(lines(opened, "cut"), [], "opened");
  });

  test(`${theme} ${width}px: every button, time and chevron of a report card sits inside it, closed and opened`, async (t) => {
    if (skipOrFail(t)) return;
    const { closed, opened } = await scene(width, theme);
    assert.deepEqual(lines(closed, "outside"), [], "closed");
    assert.deepEqual(lines(opened, "outside"), [], "opened");
    assert.ok(closed.every((c) => c.chevron === 1) && opened.every((c) => c.chevron === 1), "every card has its chevron in sight");
    for (const c of closed) assert.ok(c.buttons.includes("Dismiss"), `card ${c.id} can be dismissed where it is: ${c.buttons}`);
    assert.ok(closed[1].buttons.includes("Fix") && closed[2].buttons.includes("Fix"), "Fix stays on the closed card");
    for (const c of opened) assert.ok(c.buttons.some((b) => /^Open/.test(b)) && c.buttons.includes("Dismiss"), `opened, card ${c.id} keeps Open and Dismiss: ${c.buttons}`);
  });

  test(`${theme} ${width}px: an opened report card says its state once, a clean one too`, async (t) => {
    if (skipOrFail(t)) return;
    const { opened, again } = await scene(width, theme);
    assert.ok(opened.every((c) => c.shown === "open"));
    // Once: the first line's short word and the fuller sentence under it are never both in sight.
    assert.deepEqual(opened.filter((c) => c.states.length !== 1).map((c) => `${c.id}: ${JSON.stringify(c.states)}`), [], "opened, a card says its state once");
    const state = Object.fromEntries(opened.map((c) => [c.id, c.states[0]]));
    assert.match(state["1"], /^failed: its model provider turned down the API key\.$/, "a failure keeps its reason");
    assert.match(state["2"], /^finished · 5 findings \(1 critical, 2 high, 2 medium\)$/, "findings keep their count by kind");
    assert.match(state["6"], /nothing found$/);
    assert.match(state["7"], /all 12 checks passed$/);
    assert.match(state["9"], /^fixed · nothing found$/, "a clean run after a bad one still says it is fixed");
    // Closed again, the first line says it again.
    assert.ok(again.every((c) => c.shown === "closed"));
    if (width >= 300) assert.deepEqual(again.filter((c) => c.states.length !== 1).map((c) => c.id), [], "closed, the first line says the state");
  });
}

for (const theme of ["dark-modern", "light-modern"]) {
  test(`${theme} 300px: a card with Fix keeps its chevron inside it, and so does the fix's row after`, async (t) => {
    if (skipOrFail(t)) return;
    const page = await openAgentLines(browser, { width: 300, height: 900, theme, events: SCENE });
    t.after(() => page.close());
    const name = `300-${theme.split("-")[0]}`;
    const inside = () => page.evaluate(() => { const log = document.getElementById("log").getBoundingClientRect();
      return [...document.querySelectorAll("#log .pip-report")].flatMap((card) => { const c = card.getBoundingClientRect();
        return [...card.querySelectorAll(".pip-report-chevron, .pip-fix-chevron, button")].filter((n) => n.checkVisibility() && n.getBoundingClientRect().width > 0)
          .map((n) => { const b = n.getBoundingClientRect(); return { what: n.className.split(" ")[0], ok: b.right <= c.right + 0.5 && b.left >= c.left - 0.5 && b.right <= log.right + 0.5 }; }); }); });
    let marks = await inside();
    await shot(page, `fix-card-${name}`);
    assert.equal(marks.filter((m) => m.what === "pip-report-chevron").length, 1, "the card's chevron is in sight");
    assert.deepEqual(marks.filter((m) => !m.ok), [], "before Fix: the chevron and the buttons are inside the card");
    await page.click("#log .pip-report .pip-report-line1", { position: { x: 24, y: 6 } }); await settle(page);
    assert.deepEqual((await inside()).filter((m) => !m.ok), [], "opened: still inside");
    await page.click("#log .pip-report .pip-report-line1", { position: { x: 24, y: 6 } }); await settle(page);
    await page.click("#log .pip-report .pip-report-fix-slim"); await settle(page);
    await sendEvents(page, FIXING); await sendEvents(page, FIXED); await settle(page);
    marks = await inside();
    await shot(page, `fix-row-${name}`);
    assert.equal(marks.filter((m) => m.what === "pip-fix-chevron").length, 1, "the fix's row has a chevron of its own");
    assert.deepEqual(marks.filter((m) => !m.ok), [], "after Fix: the row's chevron and answers are inside the panel");
  });
}
