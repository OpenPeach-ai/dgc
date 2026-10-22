import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { CONTRAST_SOURCE, openThinkingPage } from "./render-thinking.mjs";
import { founderTurn } from "./support/tool-rows-scene.mjs";

// One line per stretch of work, as Chromium lays it out. The founder's deepseek turn drew twelve rows
// (452px) between two sentences: "Thought for 2s · raw", "Ran 1 command", six times over. The same
// six think-and-run pairs are now one line -- under 80px from the first sentence to what follows the
// stretch, at a side bar's width and an editor tab's -- six steps when opened, each with its thought
// as a small mark on its row, and, while the stretch works, one live row under the line. jsdom checks
// the DOM in tool-rows-one-line.test.mjs. DGC_REQUIRE_CHROMIUM=1 turns a missing browser into a failure.
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

// A finished turn folds its work into its "Worked for" row (work-fold.test.mjs). These read the work
// itself, so a finished turn is opened first, with the row, as a reader would.
const open = async (options) => {
  const page = await openThinkingPage(browser, { theme: "dark-modern", height: 1200, config: { model: "deepseek-v4.1-flash:cloud" }, ...options });
  await page.evaluate(() => document.querySelectorAll("#log .msg.dgc.work-folded > .work-toggle").forEach((row) => row.click()));
  return page;
};
const send = (page, events) => page.evaluate((list) => {
  for (const event of list) window.dispatchEvent(new MessageEvent("message", { data: { type: "event", event } }));
}, events);
// From the bottom of the sentence before the stretch to the top of whatever comes after it (the
// "Worked for" row and the answer, or the next sentence).
const STRETCH_SOURCE = `() => {
  const turn = [...document.querySelectorAll("#log .msg.dgc")].at(-1);
  const first = turn.querySelector(":scope > .text");
  let next = first.nextElementSibling;
  const parts = [];
  while (next && !next.matches(".text, .answer, .thinking")) { parts.push(next); next = next.nextElementSibling; }
  return { span: next.getBoundingClientRect().top - first.getBoundingClientRect().bottom,
    parts: parts.filter((node) => node.checkVisibility()).map((node) => node.className) };
}`;

for (const width of [460, 900]) {
  test(`the founder's six think-and-run pairs are one line at ${width}px, at most 80px between the sentences`, async (t) => {
    if (skipOrFail(t)) return;
    const page = await open({ width, events: founderTurn() });
    try {
      const facts = await page.evaluate(`(${STRETCH_SOURCE})()`);
      assert.deepEqual(facts.parts, ["tool-group"], "nothing on screen between the sentences but the line");
      assert.ok(facts.span <= 80, `the stretch takes ${Math.round(facts.span)}px between the sentences (was 452px)`);
      const line = await page.evaluate(() => {
        const summary = document.querySelector(".tool-group > summary");
        const label = summary.querySelector(".tool-group-label");
        return { text: label.textContent, height: summary.getBoundingClientRect().height,
          clipped: label.scrollWidth > label.clientWidth + 1,
          overflow: Math.max(document.getElementById("log").scrollWidth - document.getElementById("log").clientWidth, 0) };
      });
      assert.equal(line.text, "Ran 6 commands · thought 13s");
      assert.ok(line.height <= 30, `the line is one line (${line.height}px)`);
      assert.equal(line.clipped, false, "and says it whole");
      assert.equal(line.overflow, 0);
    } finally {
      await page.close();
    }
  });
}

for (const width of [300, 460]) {
  test(`opened at ${width}px: six rows, each with its thought mark on the row, readable, the thought one click away`, async (t) => {
    if (skipOrFail(t)) return;
    const page = await open({ width, events: founderTurn() });
    try {
      await page.click(".tool-group > summary");
      const facts = await page.evaluate((contrastSource) => {
        const contrast = eval(contrastSource);
        const cards = [...document.querySelectorAll(".tool-group > .tool")];
        return {
          open: document.querySelector(".tool-group").open,
          rows: cards.map((card) => {
            const head = card.querySelector(".head").getBoundingClientRect();
            const mark = card.querySelector(".thought-mark");
            const box = mark.getBoundingClientRect();
            return { visible: card.checkVisibility() && mark.checkVisibility(), headHeight: head.height,
              onRow: box.top >= head.top - 0.5 && box.bottom <= head.bottom + 0.5 && box.right <= head.right + 0.5,
              text: mark.querySelector(".thought-label").textContent, ratio: contrast(mark.querySelector(".thought-label")) };
          }),
          overflow: Math.max(document.getElementById("log").scrollWidth - document.getElementById("log").clientWidth,
            document.documentElement.scrollWidth - window.innerWidth, 0),
        };
      }, CONTRAST_SOURCE);
      assert.equal(facts.open, true);
      assert.equal(facts.rows.length, 6, "six steps, not twelve rows");
      for (const [i, row] of facts.rows.entries()) {
        assert.ok(row.visible, `step ${i + 1} and its mark are on screen`);
        assert.ok(row.headHeight <= 30, `step ${i + 1} is one row (${row.headHeight}px)`);
        assert.ok(row.onRow, `step ${i + 1}'s mark sits on its row`);
        assert.match(row.text, /^thought \ds$/);
        assert.ok(row.ratio >= 4.5, `mark contrast ${row.ratio.toFixed(2)}`);
      }
      assert.equal(facts.overflow, 0, "no horizontal scroll");
      await page.locator(".tool-group > .tool").nth(2).locator(".thought-mark").click();
      const thought = await page.evaluate(() => {
        const card = document.querySelectorAll(".tool-group > .tool")[2];
        const body = card.querySelector(":scope > .reasoning");
        return { visible: body.checkVisibility(), text: body.textContent,
          below: body.getBoundingClientRect().top >= card.querySelector(".head").getBoundingClientRect().bottom - 0.5,
          stepOpen: card.classList.contains("open") };
      });
      assert.deepEqual(thought, { visible: true, below: true, stepOpen: false,
        text: "Line 88 leaves cess out of the total. Check whether the tests cover a mixed-rate invoice at all." });
    } finally {
      await page.close();
    }
  });
}

test("the line is a button: Enter opens it, Space closes it, and Tab reaches each thought mark", async (t) => {
  if (skipOrFail(t)) return;
  const page = await open({ width: 460, events: founderTurn() });
  try {
    await page.focus(".tool-group > summary");
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => document.querySelector(".tool-group").open), true);
    await page.keyboard.press("Space");
    assert.equal(await page.evaluate(() => document.querySelector(".tool-group").open), false);
    await page.keyboard.press("Enter");
    // Tab from the line: the first step's toggle, then its thought mark.
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => document.activeElement.className);
    assert.match(focused, /thought-mark/);
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute("aria-expanded")), "true");
    const snapshot = await page.locator(".tool-group > .tool").first().locator(".thought-mark").ariaSnapshot();
    assert.match(snapshot, /thought 2s ?, raw/, "a screen reader hears the provenance too");
  } finally {
    await page.close();
  }
});

for (const width of [300, 460]) {
  test(`at ${width}px, while the stretch works, one live row under the line says what runs now, updated in place`, async (t) => {
    if (skipOrFail(t)) return;
    const frames = founderTurn("t1", { answer: false });
    const page = await open({ width, events: frames.slice(0, 6) });
    try {
      const read = () => page.evaluate(() => {
        const live = document.querySelector(".tg-live");
        if (!live) return null;
        live.__seen = (live.__seen || 0) + 1;
        const group = document.querySelector(".tool-group");
        const box = live.getBoundingClientRect(), line = group.querySelector("summary").getBoundingClientRect();
        const label = group.querySelector(".tool-group-label").getBoundingClientRect();
        return { state: live.dataset.state, text: live.textContent.replace(/\s+/g, " ").trim(), seen: live.__seen,
          visible: live.checkVisibility(), height: box.height, gap: box.top - line.bottom,
          wordsAligned: Math.abs(live.querySelector(".tg-live-verb").getBoundingClientRect().left - label.left) <= 2,
          spinning: getComputedStyle(live.querySelector(".tg-live-spin")).animationName,
          overflow: Math.max(document.getElementById("log").scrollWidth - document.getElementById("log").clientWidth, 0) };
      });
      let live = await read();
      assert.equal(live.state, "running");
      assert.match(live.text, /^Running python -m erp\.gst\.export/);
      assert.ok(live.visible && live.height <= 22, `one row (${live.height}px)`);
      assert.ok(live.gap >= -1 && live.gap <= 6, `right under the line (${live.gap}px)`);
      assert.ok(live.wordsAligned, "its words start where the line's do");
      assert.equal(live.spinning, "tg-spin");
      assert.equal(live.overflow, 0);
      await send(page, frames.slice(6, 8));
      live = await read();
      assert.equal(live.state, "thinking");
      assert.equal(live.text, "Thinking…");
      assert.equal(live.seen, 2, "the same row, updated in place");
      await send(page, frames.slice(8, 10));
      live = await read();
      assert.match(live.text, /^Running grep -n "cess"/);
      assert.equal(live.seen, 3, "still the same row");
      // Opened, the group shows the running step itself; the live row steps aside.
      await page.click(".tool-group > summary");
      assert.equal((await read()).visible, false);
      await page.click(".tool-group > summary");
      await send(page, [frames[10], { type: "text_delta", text: "The export drops cess." }]);
      assert.equal(await read(), null, "the stretch is over: its live row goes");
      assert.equal(await page.evaluate(() => document.querySelector(".tool-group").open), false, "and the line stays folded");
    } finally {
      await page.close();
    }
  });
}

test("reduced motion stops the live row's spinner", async (t) => {
  if (skipOrFail(t)) return;
  const page = await open({ width: 460, events: founderTurn("t1", { answer: false }).slice(0, 6) });
  try {
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector(".tg-live-spin")).animationName), "none");
  } finally {
    await page.close();
  }
});

test("an approval inside a working stretch is on screen, below the line and its live row", async (t) => {
  if (skipOrFail(t)) return;
  const frames = founderTurn("t1", { answer: false });
  const page = await open({ width: 460, events: [...frames.slice(0, 6),
    { type: "permission_request", id: "p1", name: "bash", command: frames[5].summary, args: frames[5].args }] });
  try {
    const facts = await page.evaluate(() => {
      const card = document.querySelector(".card[data-request-id]");
      const live = document.querySelector(".tg-live");
      return { visible: card.checkVisibility() && card.getBoundingClientRect().height > 40,
        inGroup: !!card.closest(".tool-group"), below: card.getBoundingClientRect().top >= live.getBoundingClientRect().bottom };
    });
    assert.deepEqual(facts, { visible: true, inGroup: false, below: true });
  } finally {
    await page.close();
  }
});

// Progress lines between stretches (the Work prompt asks for them now). Each line's copy button used to
// sit on an empty row of its own under the line, keeping the paragraph's bottom margin too: 44px above
// every tool line and 8px below it, so the transcript read as uneven gaps. The button now sits at the
// end of the line's last row, in room the line keeps for it, and a line sits nearer the work it
// introduces than the work before it.
function progressTurn(lines) {
  const frames = [{ type: "turn_start", turn_id: "t1", prompt: "go", kind: "prompt" }];
  lines.forEach((text, i) => frames.push(
    { type: "text_delta", text }, { type: "stream_end", message_id: `t1:${i + 1}`, phase: "commentary" },
    { type: "tool_call", call_id: `c${i + 1}`, name: "bash", args: { command: "pytest -q" }, summary: "pytest -q" },
    { type: "tool_result", call_id: `c${i + 1}`, name: "bash", output: "ok", is_error: false }));
  frames.push({ type: "text_delta", text: "All five are done." }, { type: "stream_end", message_id: "t1:9", phase: "answer" },
    { type: "turn_end", turn_id: "t1", reason: "completed", token_estimate: 1, final_message_id: "t1:9" });
  return frames;
}
const PROGRESS = ["Baseline is green (11 tests). Starting change 1.",
  "Change 1 is verified. Now adding Cart.remove(sku) and running the whole suite again, then moving the low-stock threshold into catalog.py.",
  "Change 2 is verified."];

for (const width of [300, 900]) {
  test(`progress lines at ${width}px: no empty row under a line, nearer the work it introduces, its copy beside the words`, async (t) => {
    if (skipOrFail(t)) return;
    const page = await open({ width, events: progressTurn(PROGRESS) });
    try {
      const facts = await page.evaluate(() => {
        const turn = [...document.querySelectorAll("#log .msg.dgc")].at(-1);
        return [...turn.querySelectorAll(":scope > .text.commentary")].map((line) => {
          const box = line.getBoundingClientRect(), words = line.querySelector(":scope > p").getBoundingClientRect();
          const work = line.nextElementSibling, before = line.previousElementSibling;
          return { extra: box.bottom - words.bottom, below: work.getBoundingClientRect().top - box.bottom,
            above: before?.matches(".tool-group") ? box.top - before.getBoundingClientRect().bottom : null };
        });
      });
      assert.equal(facts.length, 3);
      for (const [i, line] of facts.entries()) {
        assert.ok(line.extra <= 0.5, `line ${i + 1} has no empty row under its words (${line.extra}px)`);
        assert.ok(line.below <= 10, `line ${i + 1} sits ${line.below}px above its tool line`);
        if (line.above !== null) {
          assert.ok(line.above >= line.below && line.above <= 16, `line ${i + 1}: ${line.above}px above, ${line.below}px below`);
        }
      }
      // The copy button: revealed on hover, inside the line's box, clear of every word (the long line wraps at 300px).
      const line = page.locator(".msg.dgc .text.commentary").nth(1);
      await line.hover();
      await page.waitForTimeout(200);
      const copy = await line.evaluate((node) => {
        const button = node.querySelector(".commentary-actions button").getBoundingClientRect();
        const range = document.createRange(); range.selectNodeContents(node.querySelector(":scope > p"));
        const rects = [...range.getClientRects()];
        const box = node.getBoundingClientRect();
        return { opacity: Number(getComputedStyle(node.querySelector(".commentary-actions")).opacity),
          inside: button.right <= box.right + 0.5 && button.bottom <= box.bottom + 0.5 && button.top >= box.top - 0.5,
          clear: rects.every((r) => r.right <= button.left + 0.5 || r.bottom <= button.top + 0.5),
          rows: new Set(rects.map((r) => Math.round(r.top))).size };
      });
      assert.ok(copy.opacity > 0.5, `hover shows the copy (${copy.opacity})`);
      assert.ok(copy.inside, "the copy sits inside the line's box");
      assert.ok(copy.clear, "and over none of its words");
      if (width === 300) assert.ok(copy.rows >= 2, "the long line wraps at 300px");
    } finally {
      await page.close();
    }
  });
}
