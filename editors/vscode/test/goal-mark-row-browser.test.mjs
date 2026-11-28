// The message that started a goal wears "Goal" first in its time row, in real Chromium, dark and light, at 300 and 700 px.
// Two faults reported on 0.52.0 (28 Nov): a goal sent while a turn ran had no time yet, so "Steering …" took
// a line of its own under "Goal"; and once it said "Goal · Steered · 12:17 AM", the target icon and the word Goal sat
// lower than "Steered · 12:17 AM". Every part of the row (icon, Goal, the steer words, the clock) shares one centre line.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromiumFor, shot } from "./support/ut2b-common.mjs";
import * as S from "./support/uir2a-scene.mjs";
import { readFileSync } from "node:fs";

const C = await chromiumFor();
before(C.start); after(C.stop);
const short = (theme) => theme.split("-")[0];
const MSGTIME = readFileSync(new URL("../media/msgtime.js", import.meta.url), "utf8");
/** A Work session whose prompts get their times, as the real webview's do (the shared scene leaves msgtime.js out). */
async function open(opts) {
  const x = await S.openWork(C.state.browser, opts);
  await x.page.addScriptTag({ content: MSGTIME });
  return x;
}

/** The goal row's parts, measured: their boxes' vertical centres, what the row says, and where the mark is. */
const measure = (page) => page.evaluate(() => {
  const row = [...document.querySelectorAll("#log .msg.user.goal-started")].at(-1);
  const time = row?.querySelector(":scope > .msg-time"), mark = row?.querySelector(".goal-mark");
  const box = (n) => { if (!n) return null; const r = n.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, mid: (r.top + r.bottom) / 2, height: r.height, left: r.left, right: r.right }; };
  const clockNode = time && [...time.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
  let clock = null;
  if (clockNode) { const range = document.createRange(); range.selectNodeContents(clockNode); clock = box(range); }
  const prefix = time?.querySelector(":scope > .steer-time-prefix");
  const words = (n) => { if (!n?.firstChild) return null; const range = document.createRange(); range.selectNodeContents(n.firstChild); return box(range); };
  return {
    first: !!time && time.firstElementChild === mark, inTime: !!mark?.closest(".msg-time"),
    prefix: prefix ? prefix.textContent : "", clockText: clockNode ? clockNode.textContent.trim() : "",
    note: row?.querySelector(":scope > .steer-note")?.textContent || "",
    lines: time ? Math.round(time.getBoundingClientRect().height / parseFloat(getComputedStyle(time).lineHeight)) : 0,
    // (Words are measured as text, by a range, as the clock is: a flex item's own box adds its line's spacing.)
    icon: box(mark?.querySelector("svg")), word: words(mark?.querySelector(":scope > span")), steer: words(prefix), clock,
    bubble: box(row?.querySelector(":scope > .bubble")), row: box(time),
    sizes: { word: mark ? parseFloat(getComputedStyle(mark.querySelector(":scope > span")).fontSize) : 0, clock: time ? parseFloat(getComputedStyle(time).fontSize) : 0 },
    gap: (() => { if (!prefix || !clockNode) return null; const words = prefix.firstChild, seen = document.createRange(); seen.setStart(words, 0); seen.setEnd(words, words.textContent.trimEnd().length);
      const range = document.createRange(); range.selectNodeContents(clockNode); return range.getBoundingClientRect().left - seen.getBoundingClientRect().right; })(),
  };
});

function oneCentreLine(m, label) {
  assert.ok(m.icon && m.word && m.clock, `${label}: icon, Goal and the clock are drawn (${JSON.stringify({ icon: !!m.icon, word: !!m.word, clock: !!m.clock })})`);
  const parts = { icon: m.icon, Goal: m.word, clock: m.clock, ...(m.steer ? { steer: m.steer } : {}) };
  for (const [name, part] of Object.entries(parts)) {
    assert.ok(Math.abs(part.mid - m.clock.mid) <= 0.75, `${label}: ${name}'s centre ${part.mid.toFixed(2)} is on the clock's ${m.clock.mid.toFixed(2)}`);
  }
  assert.ok(Math.abs(m.word.bottom - m.clock.bottom) <= 0.75, `${label}: Goal and the clock share a baseline (${m.word.bottom.toFixed(2)} vs ${m.clock.bottom.toFixed(2)})`);
  assert.equal(m.sizes.word, m.sizes.clock, `${label}: Goal is the clock's size`);
  assert.ok(m.icon.height <= m.row.height + 0.5, `${label}: the icon fits the row's line (${m.icon.height} in ${m.row.height})`);
  assert.equal(m.lines, 1, `${label}: one line`);
  assert.ok(Math.abs(m.row.right - m.bubble.right) <= 3, `${label}: right under the bubble's edge`);
}

for (const theme of ["dark-modern", "light-modern"]) for (const width of [300, 700]) {
  test(`a goal started with nothing running: “Goal · 12:17 AM” on one centre line (${theme}, ${width}px)`, async (t) => {
    if (C.skipOrFail(t)) return;
    const x = await open({ width, theme, turns: 1 });
    try {
      await x.page.fill("#input", "/goal make the billing tests pass, then stop"); await x.page.keyboard.press("Enter"); await x.page.waitForTimeout(80);
      const id = String((await x.posted("startGoal")).pop()?.requestId || "");
      assert.ok(id, "the goal went");
      const m = await measure(x.page);
      await shot(x.page, `goal-row-idle-${short(theme)}-${width}`);
      assert.ok(m.first, "the mark is first in the time row");
      assert.match(m.clockText, /^\d{1,2}:\d{2}/);
      oneCentreLine(m, "idle goal");
      assert.deepEqual(x.errors, []);
    } finally { await x.page.close(); }
  });

  test(`a goal sent while a turn runs: “Goal · Steering · 12:17 AM”, then “Goal · Steered · …”, one line each time (${theme}, ${width}px)`, async (t) => {
    if (C.skipOrFail(t)) return;
    const x = await open({ width, theme, turns: 1, running: true });
    try {
      await x.page.fill("#input", "/goal make the billing tests pass, then stop"); await x.page.keyboard.press("Enter"); await x.page.waitForTimeout(80);
      const id = String((await x.posted("startGoal")).pop()?.requestId || "");
      assert.ok(id, "the goal went");
      await x.event({ type: "prompt_accepted", request_id: id, state: "steered" }); await x.page.waitForTimeout(60);
      const pending = await measure(x.page);
      await shot(x.page, `goal-row-steering-${short(theme)}-${width}`);
      assert.equal(pending.note, "", `no line of its own under the mark (it said “${pending.note}”)`);
      assert.ok(pending.first, "the mark is first in the time row");
      assert.equal(pending.prefix, "Steering · ");
      assert.ok(pending.gap >= 2, `a space after “Steering ·” (${pending.gap})`);
      oneCentreLine(pending, "steering");
      await x.event({ type: "steering_update", request_id: id, state: "applied" }); await x.page.waitForTimeout(60);
      const applied = await measure(x.page);
      await shot(x.page, `goal-row-steered-${short(theme)}-${width}`);
      assert.ok(applied.first, "still first once it is read (the steer words never go before it)");
      assert.equal(applied.prefix, "Steered · ");
      assert.ok(applied.gap >= 2, `a space after “Steered ·” (${applied.gap})`);
      oneCentreLine(applied, "steered");
      assert.deepEqual(x.errors, []);
    } finally { await x.page.close(); }
  });

  test(`a plain steer keeps its row: “Steering · 12:17 AM” with the space, centred (${theme}, ${width}px)`, async (t) => {
    if (C.skipOrFail(t)) return;
    const x = await open({ width, theme, turns: 1, running: true });
    try {
      const id = await x.say("Use the staging database for this.");
      await x.event({ type: "prompt_accepted", request_id: id, state: "steered" }); await x.page.waitForTimeout(60);
      const m = await x.page.evaluate(() => {
        const row = [...document.querySelectorAll("#log .msg.user")].at(-1), time = row.querySelector(":scope > .msg-time"), prefix = time.querySelector(".steer-time-prefix");
        const clock = [...time.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim()), range = document.createRange(); range.selectNodeContents(clock);
        const words = prefix.firstChild, seen = document.createRange(); seen.setStart(words, 0); seen.setEnd(words, words.textContent.trimEnd().length);
        const a = seen.getBoundingClientRect(), b = range.getBoundingClientRect();   // (the dot's own right edge: the space is the gap)
        return { prefix: prefix.textContent, gap: b.left - a.right, mids: [(a.top + a.bottom) / 2, (b.top + b.bottom) / 2], note: row.querySelector(":scope > .steer-note")?.textContent || "" };
      });
      assert.equal(m.prefix, "Steering · "); assert.equal(m.note, "");
      assert.ok(m.gap >= 2, `a space before the clock (${m.gap})`);
      assert.ok(Math.abs(m.mids[0] - m.mids[1]) <= 0.75, `one centre line (${m.mids})`);
      assert.deepEqual(x.errors, []);
    } finally { await x.page.close(); }
  });
}
