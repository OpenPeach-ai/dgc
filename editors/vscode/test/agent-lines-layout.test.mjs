// Sub-agent lines are a layout fact as much as a sentence, so only a real browser can check them:
// the faces centred on the sentence's first line, a name's text on the baseline of the words around
// it, a long name clipped with its underline whole, wrapped text kept in its own column, a focus ring
// on every control, readable words in every theme, system colours in forced-colours mode, and faces
// that stop moving for a reader who asked for less motion. And the reader's place: an agent's line
// changing in a turn above them must neither move the page nor claim there is something "New".
// DGC_REQUIRE_CHROMIUM=1 turns a missing browser into a failure instead of a skip.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { CONTRAST_SOURCE, LINES_EXPECTED, LONG_NAME, linesScene, openAgentLines, sendEvents, settle, sid } from "./support/agent-lines-scene.mjs";

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

// Everything about each line, measured in the page.
function measure(contrastSource) {
  // Rounded to two places, as settings-contrast.test.mjs reads a theme's own 4.4:1.
  const contrast = (node) => Math.round(eval(contrastSource)(node) * 100) / 100;
  const log = document.getElementById("log");
  const colourOf = (value) => { const p = document.createElement("span"); p.style.color = value; document.body.appendChild(p);
    const c = getComputedStyle(p).color; p.remove(); return c; };
  // A zero-size inline block sits on the baseline of the text it is put in.
  const baseline = (into, first = false) => {
    const probe = document.createElement("span");
    probe.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline;margin:0;padding:0;border:0";
    if (first) into.prepend(probe); else into.appendChild(probe);
    const y = probe.getBoundingClientRect().bottom;
    probe.remove();
    return y;
  };
  const shown = (text) => { const copy = text.cloneNode(true); copy.querySelectorAll(".sr-only").forEach((n) => n.remove());
    return copy.textContent.replace(/\u00a0/g, " "); };
  return {
    overflow: Math.max(log.scrollWidth - log.clientWidth, document.documentElement.scrollWidth - window.innerWidth),
    muted: colourOf("var(--muted)"), link: colourOf("LinkText"), canvasText: colourOf("CanvasText"),
    lines: [...log.querySelectorAll(".agent-line")].map((line) => {
      const faces = line.querySelector(".agent-line-faces"), text = line.querySelector(".agent-line-text");
      const lineHeight = parseFloat(getComputedStyle(text).lineHeight);
      const textBox = text.getBoundingClientRect();
      // The boxes of the visible words: every text node, less the screen-reader-only pauses (which
      // are positioned out of the flow and would read as rows of their own).
      const rects = [];
      const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.parentElement.closest(".sr-only") || !node.data.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        rects.push(...[...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5));
      }
      const name = text.querySelector(".agent-name");
      const next = name.nextElementSibling;
      const names = [...text.querySelectorAll(".agent-name")].map((n) => {
        const box = n.getBoundingClientRect();
        const base = baseline(n);
        const style = getComputedStyle(n);
        return { clipped: n.scrollWidth > n.clientWidth, label: n.textContent, bottom: box.bottom, base,
          underline: parseFloat(style.textUnderlineOffset) + parseFloat(style.textDecorationThickness || "1"),
          right: box.right, colour: style.color, contrast: contrast(n) };
      });
      const word = (state) => { const n = line.querySelector(`.agent-state[data-state="${state}"]`);
        return n ? { contrast: contrast(n), colour: getComputedStyle(n).color, weight: getComputedStyle(n).fontWeight } : null; };
      return {
        text: shown(text), colour: getComputedStyle(line).color, contrast: contrast(line),
        firstLineCentre: textBox.top + lineHeight / 2,
        faceCentres: [...faces.querySelectorAll(".agent-mark")].map((m) => { const r = m.getBoundingClientRect(); return r.top + r.height / 2; }),
        facesRight: faces.getBoundingClientRect().right, textLeft: textBox.left, textRight: textBox.right,
        leftmost: Math.min(...rects.map((r) => r.left)), rows: Math.round(textBox.height / lineHeight),
        nameBaseline: baseline(name), nextBaseline: next ? baseline(next, true) : null,
        names, failed: word("failed"), waiting: word("waiting"),
        userSelect: getComputedStyle(line).userSelect,
      };
    }),
  };
}
// Reach a control by keyboard: from a throwaway button just before it (or the control before it),
// one Tab. Programmatic focus alone is not what a keyboard user sees.
async function tabTo(page, selector, fromSelector) {
  await page.evaluate(([target, from]) => {
    const node = document.querySelector(target);
    let start = from ? document.querySelector(from) : null;
    if (!start) {
      start = document.createElement("button");
      start.id = "tab-start"; start.textContent = "start";
      node.closest(".agent-line").before(start);
    }
    start.focus();
  }, [selector, fromSelector || null]);
  await page.keyboard.press("Tab");
  const facts = await page.evaluate((target) => {
    const node = document.querySelector(target);
    const style = getComputedStyle(node);
    const alpha = (style.outlineColor.match(/[\d.]+/g) || []).map(Number)[3] ?? 1;
    document.getElementById("tab-start")?.remove();
    return { focused: document.activeElement === node, visible: node.matches(":focus-visible"),
      style: style.outlineStyle, width: parseFloat(style.outlineWidth), alpha };
  }, selector);
  return facts;
}

const MINIMUM = { "dark-modern": 4.5, "light-modern": 4.5, "light-plus": 4.4, hc: 4.5 };
for (const theme of Object.keys(MINIMUM)) {
  for (const width of [300, 460, 900]) {
    test(`agent lines line up, wrap in their column and read clearly at ${width}px in ${theme}`, async (t) => {
      if (skipOrFail(t)) return;
      const page = await openAgentLines(browser, { width, theme, events: linesScene() });
      try {
        const m = await page.evaluate(measure, CONTRAST_SOURCE);
        assert.deepEqual(m.lines.map((line) => line.text), LINES_EXPECTED);
        assert.ok(m.overflow <= 0, `no horizontal overflow (${m.overflow}px)`);
        for (const line of m.lines) {
          const label = `"${line.text.slice(0, 40)}"`;
          for (const centre of line.faceCentres) {
            assert.ok(Math.abs(centre - line.firstLineCentre) <= 1, `${label}: a face is ${centre - line.firstLineCentre}px off the first text line`);
          }
          if (line.nextBaseline !== null) {
            assert.ok(Math.abs(line.nameBaseline - line.nextBaseline) <= 1,
              `${label}: the name's baseline is ${line.nameBaseline - line.nextBaseline}px off the words after it`);
          }
          assert.ok(line.textLeft >= line.facesRight, `${label}: the text column starts after the faces`);
          assert.ok(line.leftmost >= line.textLeft - 0.5, `${label}: wrapped text starts at the text column, not under the faces`);
          for (const name of line.names) assert.ok(name.right <= line.textRight + 0.5, `${label}: a name runs past its column`);
          assert.equal(line.colour, m.muted, `${label}: the line is drawn in --muted`);
          assert.equal(line.userSelect, "none");
          assert.ok(line.contrast >= MINIMUM[theme], `${label}: ${line.contrast.toFixed(2)}:1 in ${theme}`);
          for (const name of line.names) assert.ok(name.contrast >= MINIMUM[theme], `${label}: a name reads ${name.contrast.toFixed(2)}:1`);
        }
        const [, three, care, six, , long] = m.lines;
        assert.equal(care.failed.weight, "500", "the failed word is heavier");
        assert.equal(care.waiting.weight, "500", "and so is the waiting one");
        assert.ok(care.failed.contrast >= MINIMUM[theme], `failed word ${care.failed.contrast.toFixed(2)}:1 in ${theme}`);
        assert.ok(care.waiting.contrast >= MINIMUM[theme], `waiting word ${care.waiting.contrast.toFixed(2)}:1 in ${theme}`);
        assert.equal(six.faceCentres.length, 4, "four faces on the first row of the six-agent batch");
        const longName = long.names[0];
        assert.equal(longName.label, LONG_NAME, "the whole name is in the button, however it is clipped");
        assert.ok(longName.clipped, "a 120-character name is clipped with an ellipsis");
        assert.ok(longName.bottom - longName.base >= longName.underline - 0.01,
          `its underline is not clipped (${(longName.bottom - longName.base).toFixed(2)}px below the baseline, needs ${longName.underline})`);
        if (width === 300) assert.ok(three.rows > 1, "at 300px a three-agent sentence wraps (so the column check means something)");
        // The keyboard reaches every name and "N more", with a ring that shows.
        for (const facts of [await tabTo(page, "#log .agent-line .agent-name"),
          await tabTo(page, "#log .agent-line .agent-line-more", `#log .agent-name[data-agent-id="${sid(8)}"]`)]) {
          assert.deepEqual({ focused: facts.focused, visible: facts.visible, style: facts.style }, { focused: true, visible: true, style: "solid" });
          assert.ok(facts.width >= 1 && facts.alpha > 0, `a visible ring (${facts.width}px, alpha ${facts.alpha})`);
        }
      } finally { await page.close(); }
    });
  }
}

test("forced colours draw the names as links and the words that need you in the text colour", async (t) => {
  if (skipOrFail(t)) return;
  const page = await openAgentLines(browser, { width: 460, theme: "hc", events: linesScene(), forcedColors: true });
  try {
    assert.equal(await page.evaluate(() => matchMedia("(forced-colors: active)").matches), true);
    const m = await page.evaluate(measure, CONTRAST_SOURCE);
    for (const line of m.lines) for (const name of line.names) assert.equal(name.colour, m.link, "a name is LinkText");
    const care = m.lines[2];
    assert.equal(care.failed.colour, m.canvasText);
    assert.equal(care.waiting.colour, m.canvasText);
    assert.equal(care.failed.weight, "600");
    const ring = await tabTo(page, "#log .agent-line .agent-name");
    assert.equal(ring.width, 2, "a 2px ring in forced colours");
  } finally { await page.close(); }
});

test("a live face breathes, and stops for a reader who asked for less motion; the words still change", async (t) => {
  if (skipOrFail(t)) return;
  const live = (reducedMotion) => openAgentLines(browser, { width: 460, theme: "dark-modern", reducedMotion, events: linesScene() });
  const faces = (page) => page.evaluate(async () => {
    const marks = [...document.querySelectorAll("#log .agent-line .agent-mark.is-live")];
    await Promise.all(marks.map((m) => m.querySelector("img")?.decode?.().catch(() => {})));
    return marks.map((m) => ({ img: !!m.querySelector("img"), animation: getComputedStyle(m).animationName }));
  });
  const moving = await live(false), still = await live(true);
  try {
    const a = await faces(moving), b = await faces(still);
    assert.ok(a.length > 0 && a.every((f) => f.img), "the live faces are the shipped SVGs");
    assert.ok(a.every((f) => f.animation === "agent-mark-breathe"), JSON.stringify(a));
    assert.ok(b.length === a.length && b.every((f) => f.animation === "none"), JSON.stringify(b));
    const m = await still.evaluate(measure, CONTRAST_SOURCE);
    assert.deepEqual(m.lines.map((line) => line.text), LINES_EXPECTED);
  } finally { await moving.close(); await still.close(); }
});

// ---- the reader's place ------------------------------------------------------------------------
const LONG = (i) => `Answer ${i}. ` + "The bounds hold across every page of the transcript, and the parser reads them back. ".repeat(6);
const answered = (id, i) => [{ type: "turn_start", turn_id: id, prompt: `Question ${i}`, kind: "prompt" },
  { type: "text_delta", text: LONG(i) }, { type: "stream_end", message_id: `${id}:1`, phase: "answer" },
  { type: "turn_end", turn_id: id, reason: "completed", final_message_id: `${id}:1` }];
const background = (ids) => [{ type: "turn_start", turn_id: "bg", prompt: "Run the surveys in the background", kind: "prompt" },
  ...ids.flatMap(([n, description]) => [
    { type: "tool_call", call_id: `call_${n}`, name: "task", args: { description, background: true }, summary: "" },
    { type: "agent_started", id: sid(n), parent_id: null, call_id: `call_${n}`, description, depth: 1, state: "running",
      started_at: n, isolated: true, parallel: false, background: true },
    { type: "tool_result", call_id: `call_${n}`, name: "task", output: `Sub-task '${description}' is running in the background (id ${sid(n)}). `, is_error: false }]),
  { type: "text_delta", text: "They are running in the background." }, { type: "stream_end", message_id: "bg:1", phase: "answer" },
  { type: "turn_end", turn_id: "bg", reason: "completed", final_message_id: "bg:1" }];
const readBack = (page, fraction) => page.evaluate((f) => {
  const log = document.getElementById("log");
  log.dispatchEvent(new WheelEvent("wheel")); log.scrollTop = Math.round((log.scrollHeight - log.clientHeight) * f);
}, fraction);
const place = (page) => page.evaluate(() => {
  const log = document.getElementById("log"), top = log.getBoundingClientRect().top;
  const blocks = [...log.querySelectorAll(".msg")].filter((n) => !n.parentElement.closest(".msg"));
  const index = blocks.findIndex((n) => n.getBoundingClientRect().bottom > top);
  const pill = document.getElementById("to-latest");
  return { index, top: blocks[index].getBoundingClientRect().top, scrollTop: log.scrollTop,
    unread: pill.classList.contains("unread"), pillText: document.getElementById("to-latest-label").textContent };
});
const frames = (page, n = 4) => page.evaluate((count) => new Promise((done) => {
  const f = () => (--count <= 0 ? setTimeout(done, 80) : requestAnimationFrame(f)); requestAnimationFrame(f);
}), n);

test("an earlier turn's agent finishing, and its late work, neither move the reader nor raise 'New'", async (t) => {
  if (skipOrFail(t)) return;
  const page = await openAgentLines(browser, { width: 460, height: 700, events: [...background([[1, "Survey the parser"]]),
    ...[0, 1, 2, 3, 4, 5, 6, 7].flatMap((i) => answered(`a${i}`, i))] });
  try {
    await readBack(page, 0.45);
    await frames(page, 6);
    const before = await place(page);
    assert.equal(before.unread, false, "premise: nothing unread yet");
    await sendEvents(page, [
      { type: "agent_ended", id: sid(1), state: "finished", duration_ms: 9000, tool_calls: 4, message: "done" },
      { type: "tool_call", call_id: `${sid(1)}:g1`, name: "grep", args: { pattern: "x" }, summary: "x" },
      { type: "thinking_delta", block: "c:th1", source: "raw", agent: sid(1), text: "late reasoning" },
      { type: "thinking_end", block: "c:th1", source: "raw", agent: sid(1), placement: "collapsed", seconds: 1 },
      { type: "agent_step", agent_id: sid(1), seq_in_agent: 1, step: { type: "tool_call", name: "read_file", call_id: `${sid(1)}:r1`, args: {} } },
    ]);
    await frames(page, 6);
    const afterward = await place(page);
    assert.equal(afterward.unread, false, `"${afterward.pillText}": nothing the reader can see arrived`);
    assert.notEqual(afterward.pillText, "New");
    assert.ok(Math.abs(afterward.scrollTop - before.scrollTop) <= 1, `scrolled ${afterward.scrollTop - before.scrollTop}px`);
    assert.ok(Math.abs(afterward.top - before.top) <= 1, `the block being read moved ${afterward.top - before.top}px`);
    assert.equal(await page.evaluate(() => document.querySelectorAll("#log .msg.dgc").length), 9, "no phantom turn");
    assert.equal(await page.evaluate(() => document.querySelector("#log .agent-line .agent-line-text").textContent), "Survey the parser finished");
  } finally { await page.close(); }
});

test("the snapshot after a long history claims cards in settled blocks above the view without moving it", async (t) => {
  if (skipOrFail(t)) return;
  const turns = [], records = [];
  for (let i = 0; i < 7; i += 1) {
    const a = 2 * i + 1, b = 2 * i + 2;
    turns.push({ type: "turn_start", turn_id: `h${i}`, prompt: `Question ${i}`, kind: "prompt" },
      { type: "tool_call", call_id: `call_${a}`, name: "task", args: { description: `Survey part ${a}` }, summary: "" },
      { type: "tool_call", call_id: `call_${b}`, name: "task", args: { description: `Survey part ${b}` }, summary: "" },
      { type: "tool_result", call_id: `call_${a}`, name: "task", output: "Sub-task done.", is_error: false },
      { type: "tool_result", call_id: `call_${b}`, name: "task", output: "Sub-task done.", is_error: false },
      { type: "text_delta", text: LONG(i) }, { type: "stream_end", message_id: `h${i}:1`, phase: "answer" },
      { type: "turn_end", turn_id: `h${i}`, reason: "completed", final_message_id: `h${i}:1` });
    for (const n of [a, b]) records.push({ id: sid(n), parent_id: null, call_id: `call_${n}`, description: `Survey part ${n}`,
      depth: 1, state: "finished", tool_calls: 2, started_at: n });
  }
  const page = await openAgentLines(browser, { width: 460, height: 700, events: [{ type: "history", items: turns, complete: true }] });
  try {
    await frames(page, 6);
    assert.ok(await page.evaluate(() => document.querySelectorAll("#log .msg.settled").length > 3), "premise: the replayed blocks are settled");
    await readBack(page, 0.6);
    await frames(page, 6);
    const before = await place(page);
    assert.ok(before.index > 1, "premise: settled blocks are above the view");
    await sendEvents(page, [{ type: "agents", items: records, total: records.length, active: 0 }]);
    await frames(page, 8);
    const afterward = await place(page);
    assert.equal(await page.evaluate(() => document.querySelectorAll("#log .agent-line").length), 7, "every turn's pair became a line");
    assert.equal(afterward.index, before.index);
    assert.ok(Math.abs(afterward.top - before.top) <= 1, `the block being read moved ${afterward.top - before.top}px`);
  } finally { await page.close(); }
});

test("a line that wraps when its agents finish, in a settled turn far above, does not jump when scrolled to", async (t) => {
  if (skipOrFail(t)) return;
  // One row while all three run; two once their words differ. The host's system font
  // determines that boundary, so find it before measuring the settled transcript.
  const agents = [[1, "Check the parser"], [2, "Check the lexer"], [3, "Check the printer"]];
  const page = await openAgentLines(browser, { width: 460, height: 700, events: [...background(agents),
    ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((i) => answered(`a${i}`, i))] });
  try {
    const rows = () => page.evaluate(() => {
      const text = document.querySelector("#log .agent-line .agent-line-text");
      return Math.round(text.getBoundingClientRect().height / parseFloat(getComputedStyle(text).lineHeight));
    });
    // Past the agents' "started working" window: its timer turning the words to "running" during the
    // probe would be a real change of length, not a jump.
    await page.waitForTimeout(2100);
    for (let width = 480; await rows() > 1 && width <= 700; width += 20) {
      await page.setViewportSize({ width, height: 700 });
      await settle(page);
    }
    await frames(page, 6);
    const before = await rows();
    await sendEvents(page, [
      { type: "agent_ended", id: sid(2), state: "finished", duration_ms: 9000, tool_calls: 4, message: "done" },
      { type: "agent_ended", id: sid(3), state: "failed", duration_ms: 9000, tool_calls: 4, message: "the sub-agent stopped without a final summary" }]);
    await frames(page, 8);
    // Scroll back up through the transcript, watching the block being read at each stop.
    const probe = await page.evaluate(async () => {
      const log = document.getElementById("log");
      const wait = (n) => new Promise((done) => { const f = () => (--n <= 0 ? done() : requestAnimationFrame(f)); requestAnimationFrame(f); });
      const out = [];
      for (const fraction of [0.6, 0.4, 0.25, 0.12, 0.05, 0]) {
        const height = log.scrollHeight;
        log.dispatchEvent(new WheelEvent("wheel")); log.scrollTop = Math.round((height - log.clientHeight) * fraction);
        await wait(2);
        const box = log.getBoundingClientRect();
        const anchor = document.elementFromPoint(box.left + box.width / 2, box.top + box.height * 0.4)?.closest(".msg, .resume-note, .sys");
        const top = anchor?.getBoundingClientRect().top;
        await wait(6); await new Promise((done) => setTimeout(done, 60));
        out.push({ fraction, moved: anchor ? Math.round(anchor.getBoundingClientRect().top - top) : 0, heightChange: log.scrollHeight - height });
      }
      return out;
    });
    assert.deepEqual([before, await rows()], [1, 2], "premise: the line wraps to a second row once its agents differ");
    for (const step of probe) {
      assert.ok(Math.abs(step.moved) <= 1, `at ${step.fraction * 100}% the block being read moved ${step.moved}px`);
      assert.ok(Math.abs(step.heightChange) <= 1, `at ${step.fraction * 100}% the transcript's length changed by ${step.heightChange}px`);
    }
  } finally { await page.close(); }
});
