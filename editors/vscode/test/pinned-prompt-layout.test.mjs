// A pinned prompt is a layout fact, so it is checked in real Chromium: the prompt you sent stays at the
// top of the transcript while you scroll through its answer, resting on the log's top padding over an
// opaque ground; the next prompt pushes it off and scrolling back hands the pin back; turns nobody
// typed keep it pinned; steered, queued and unsent messages never pin; a long prompt pins folded and an
// opened one scrolls away while its own "Show less" stays in reach; a prompt too tall for the window
// does not pin; a click on a prompt goes back to it; keyboard focus never lands under it; and live,
// replayed and re-measured transcripts all agree. Every check reads computed style and geometry --
// a string test cannot see stickiness, and jsdom (pinned-prompt.test.mjs) lays nothing out.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { THEMES, panelHtml } from "./support/options-scene.mjs";

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
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

const PROSE = (i) => `Answer ${i}. ` + "The bounds hold across every page of the transcript, and the parser reads them back. ".repeat(14);
const turn = (id, prompt, answer = PROSE(id), extra = {}) => [
  { type: "turn_start", turn_id: id, prompt, kind: "prompt", ...extra },
  { type: "text_delta", text: answer },
  { type: "stream_end", message_id: `${id}:1`, phase: "answer" },
  { type: "turn_end", turn_id: id, reason: "completed", token_estimate: 0, final_message_id: `${id}:1` },
];

// In the page: where each head is laid out and drawn, and scrolling the way a reader does (a gesture
// first, so the panel stops following the end).
function pageHelpers() {
  const log = document.getElementById("log");
  const frames = (n = 2) => new Promise((done) => { const f = () => (--n <= 0 ? done() : requestAnimationFrame(f)); requestAnimationFrame(f); });
  const laidOut = (head) => head.parentElement.getBoundingClientRect().top + parseFloat(getComputedStyle(head).marginTop || 0);
  const heads = () => [...log.querySelectorAll(".turn > .msg.user.turn-head")];
  window.__pin = {
    log, frames, laidOut, heads,
    rest: () => log.getBoundingClientRect().top + parseFloat(getComputedStyle(log).paddingTop),
    // Drawn below its own place and still over the view (a turn wholly above the view parks its prompt
    // at the end of its box: displaced, but out of sight).
    pinned: () => heads().filter((head) => {
      const drawn = head.getBoundingClientRect();
      return drawn.top - laidOut(head) > 1 && drawn.bottom > log.getBoundingClientRect().top;
    }),
    rel: (node) => node.getBoundingClientRect().top - log.getBoundingClientRect().top,
    async scrollTo(top) { log.dispatchEvent(new WheelEvent("wheel")); log.scrollTop = Math.round(top); await frames(2); },
    async scrollBy(dy) { log.dispatchEvent(new WheelEvent("wheel")); log.scrollTop += Math.round(dy); await frames(2); },
    // Puts `node`'s top `y` px below the log's top edge.
    async bring(node, y) { await window.__pin.scrollBy(window.__pin.rel(node) - y); },
  };
}

// The real panel: the shipped skeleton and stylesheet, a VS Code theme's variables and body class,
// then main.js, a session and a backend that has said hello.
async function openPage({ width = 460, height = 800, theme = "dark-modern", forcedColors = false, steering = false, extraCss = "" } = {}) {
  const { html, mainJs, markdownJs } = panelHtml();
  const page = await browser.newPage({ viewport: { width, height }, forcedColors: forcedColors ? "active" : "none" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.setContent(html, { waitUntil: "load" });
  await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; --vscode-editor-font-family: ui-monospace, monospace; ${THEMES[theme]} } ${extraCss}` });
  await page.evaluate((t) => document.body.classList.add(t.startsWith("light") ? "vscode-light" : t === "hc" ? "vscode-high-contrast" : "vscode-dark"), theme);
  await page.evaluate(([mjs, mdjs]) => {
    window.__posted = [];
    window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState: () => undefined, setState() {} });
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(mjs);
  }, [mainJs, markdownJs]);
  await page.evaluate(pageHelpers);
  const send = (data) => page.evaluate((d) => window.dispatchEvent(new MessageEvent("message", { data: d })), data);
  const events = async (list) => { for (const event of list) await send({ type: "event", event }); };
  await send({ type: "session_ready", sessionId: "s1" });
  await events([{ type: "ready", capabilities: { history_snapshot: true, ...(steering ? { live_steering: true, steering_native: true } : {}) },
    model: "qwen3.8:27b", mode: "default", think: "off", commands: [], custom_commands: [], goal: { text: "", status: "none" },
    context_size: 65536, session_id: "s1" }]);
  const settle = (ms = 160) => page.evaluate((wait) => new Promise((done) =>
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, wait)))), ms);
  // Enter in the composer (Alt+Enter queues); the request id the panel sent it with.
  const type = (text, { queue = false } = {}) => page.evaluate(([value, alt]) => {
    const input = document.getElementById("input");
    input.value = value; input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", altKey: alt, bubbles: true, cancelable: true }));
    return window.__posted.filter((m) => m.type === "prompt").at(-1)?.requestId;
  }, [text, queue]);
  return { page, send, events, settle, type, errors };
}
const chat = async (s, prompts) => { for (const [i, prompt] of prompts.entries()) await s.events(turn(`t${i}`, prompt)); await s.settle(); };
const PROMPTS = ["Question 0: does the bound hold?", "Question 1: and on the second page?", "Question 2: after a resize?", "Question 3: and when replayed?"];

for (const width of [320, 988]) {
  test(`a prompt pins on the log's top padding, over a ground that covers the gutters and takes no clicks (${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const s = await openPage({ width });
    try {
      await chat(s, PROMPTS);
      const m = await s.page.evaluate(async () => {
        const P = window.__pin, block = P.heads()[1].parentElement.querySelector(":scope > .msg.dgc");
        await P.bring(block, -block.offsetHeight / 2);
        const pinned = P.pinned();
        const head = pinned[0];
        const view = P.log.getBoundingClientRect(), h = head.getBoundingClientRect(), b = head.querySelector(".bubble").getBoundingClientRect();
        const style = document.createElement("style");
        style.textContent = "#log .turn > .msg.user.turn-head::before { pointer-events: auto !important; }";
        document.head.appendChild(style);
        const hit = (x, y) => document.elementFromPoint(x, y)?.closest(".turn-head") === head;
        const ground = { top: hit(view.left + 4, view.top + 2), gutter: hit(view.left + 4, (h.top + h.bottom) / 2),
          right: hit(view.right - 14, view.top + 8), fade: hit(view.left + view.width / 2, b.bottom + 6) };
        style.remove();
        return { count: pinned.length, offset: h.top - view.top, pad: parseFloat(getComputedStyle(P.log).paddingTop), ground,
          position: getComputedStyle(head).position, through: document.elementFromPoint(view.left + 4, view.top + 2)?.closest(".turn-head") === head,
          cursor: getComputedStyle(head.querySelector(".prompt-text")).cursor };
      });
      assert.equal(m.count, 1, "mid-answer, exactly one prompt is pinned");
      assert.equal(m.position, "sticky");
      assert.equal(m.cursor, "pointer", "its text shows it can be clicked");
      assert.ok(Math.abs(m.offset - m.pad) <= 1, `it rests on the log's ${m.pad}px top padding (${m.offset}px), where a chat's first prompt sits`);
      assert.deepEqual(m.ground, { top: true, gutter: true, right: true, fade: true }, "its ground runs edge to edge, from the top of the view to its fade");
      assert.equal(m.through, false, "the ground takes no clicks: they reach what is under it");
      assert.deepEqual(s.errors, []);
    } finally { await s.page.close(); }
  });
}

test("the next prompt pushes the pinned one off, and scrolling back up hands the pin back", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openPage();
  try {
    await chat(s, PROMPTS);
    const m = await s.page.evaluate(async () => {
      const P = window.__pin, heads = P.heads(), [one, two] = [heads[1], heads[2]];
      await P.bring(two.parentElement, 10);
      const pushing = { oneBottom: one.getBoundingClientRect().bottom - P.log.getBoundingClientRect().top, box: P.rel(two.parentElement),
        two: P.rel(two), twoOwn: P.laidOut(two) - P.log.getBoundingClientRect().top, pinned: P.pinned().map((h) => heads.indexOf(h)) };
      await P.scrollBy(40);
      const pinnedTwo = { two: P.rel(two), pinned: P.pinned().map((h) => heads.indexOf(h)), oneBottom: one.getBoundingClientRect().bottom - P.log.getBoundingClientRect().top };
      await P.bring(one.parentElement, -one.parentElement.offsetHeight / 2);
      const back = { one: P.rel(one), pinned: P.pinned().map((h) => heads.indexOf(h)), two: P.rel(two), twoOwn: P.laidOut(two) - P.log.getBoundingClientRect().top };
      return { pushing, pinnedTwo, back, pad: parseFloat(getComputedStyle(P.log).paddingTop) };
    });
    assert.ok(m.pushing.oneBottom <= m.pushing.box + 0.5, `the end of its box pushes it off: never over the next box (${m.pushing.oneBottom} > ${m.pushing.box})`);
    assert.ok(Math.abs(m.pushing.two - m.pushing.twoOwn) <= 0.5 && m.pushing.two > m.pad + 0.5, "the next prompt is still in its own place");
    assert.ok(Math.abs(m.pinnedTwo.two - m.pad) <= 1, `40px on, the next one pins (${m.pinnedTwo.two}px)`);
    assert.deepEqual(m.pinnedTwo.pinned, [2]);
    assert.ok(m.pinnedTwo.oneBottom <= 0.5, "and the first is gone above the view");
    assert.ok(Math.abs(m.back.one - m.pad) <= 1, `back in the first answer, the first prompt pins again (${m.back.one}px)`);
    assert.deepEqual(m.back.pinned, [1]);
    assert.ok(Math.abs(m.back.two - m.back.twoOwn) <= 0.5, "and the second is back in its own place");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("turns nobody typed keep the prompt they continue pinned; the next prompt takes over", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openPage();
  try {
    const cont = (id, kind, prompt) => turn(id, prompt, PROSE(id), {}).map((e, i) => (i === 0 ? { ...e, kind } : e));
    await s.events([...turn("p1", "Watch the dev server and fix what breaks"), ...cont("w1", "monitor", "npm run dev printed 2 lines"),
      ...cont("c1", "continue", "Continue the interrupted turn"), ...cont("r1", "resume", "Watch the dev server"),
      ...cont("r2", "resume", "Watch the dev server"), ...turn("p2", "Now fix the warning"), ...turn("p3", "Thanks")]);
    await s.settle();
    const at = await s.page.evaluate(async () => {
      const P = window.__pin, blocks = [...P.log.querySelectorAll(".turn > .msg.dgc")];
      const out = [];
      for (const index of [1, 2, 4, 5]) {                     // the wake, the continuation, the second goal cycle, then p2's turn
        await P.bring(blocks[index], -blocks[index].offsetHeight / 2);
        out.push(P.pinned().map((head) => head.querySelector(".bubble").textContent));
      }
      return { out, boxes: P.log.querySelectorAll(":scope > .turn").length };
    });
    assert.equal(at.boxes, 3, "three prompts, three boxes");
    assert.deepEqual(at.out, [["Watch the dev server and fix what breaks"], ["Watch the dev server and fix what breaks"],
      ["Watch the dev server and fix what breaks"], ["Now fix the warning"]]);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("steered, queued and unsent messages never pin", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openPage({ steering: true });
  try {
    await s.events(turn("t0", "Earlier question"));
    await s.events(turn("t1", "Deploy it", PROSE(1)).slice(0, 2));
    const steer = await s.type("use staging-2, the first one is down");
    await s.events([{ type: "prompt_accepted", request_id: steer, state: "steered" }, { type: "steering_update", request_id: steer, state: "applied" },
      { type: "text_delta", text: ` ${PROSE(2)}` }]);
    const queued = await s.type("Then run the smoke tests", { queue: true });
    await s.events([{ type: "prompt_accepted", request_id: queued, state: "queued" }, { type: "queued", count: 1 }]);
    const unsent = await s.type("And tag the release");
    await s.send({ type: "prompt_rejected", requestId: unsent });
    await s.events([{ type: "text_delta", text: ` ${PROSE(3)}` }]);
    await s.settle();
    const walk = await s.page.evaluate(async () => {
      const P = window.__pin, rows = [...P.log.querySelectorAll(".msg.user:not(.turn-head)")];
      const seen = rows.map(() => new Set());
      const positions = rows.map((row) => getComputedStyle(row).position);
      for (let top = 0; top <= P.log.scrollHeight; top += 90) {
        await P.scrollTo(top);
        rows.forEach((row, i) => seen[i].add(Math.round(row.getBoundingClientRect().top + P.log.scrollTop)));
      }
      return { roles: rows.map((row) => row.querySelector(".role").textContent), positions, drift: seen.map((set) => set.size) };
    });
    assert.deepEqual(walk.roles, ["you · steering", "you · queued", "you · not sent"]);
    assert.deepEqual(walk.positions, ["static", "static", "static"]);
    assert.deepEqual(walk.drift, [1, 1, 1], "each stays where it is laid out at every scroll position");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

// The collapse (long prompts, data-fold) is what keeps a pinned prompt short. Opened, a prompt is read
// in place: it does not pin, and its own sticky "Show less" is the one sticky thing about it -- clear
// of whatever prompt above it is pinned.
test("a long prompt pins folded; opened it scrolls away while Show less stays in reach, clear of the prompt pinned above; folded again it pins", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openPage({ width: 460, height: 640 });
  try {
    const TALL = Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of a long pasted spec`).join("\n");
    await s.events([...turn("t0", "Earlier question", `${PROSE(0)}\n\n${PROSE(1)}`), ...turn("t1", TALL, `${PROSE(2)}\n\n${PROSE(3)}`), ...turn("t2", "Next question")]);
    await s.settle();
    const head = ".turn > .msg.user.turn-head:has(.prompt-fold)";
    const folded = await s.page.evaluate(async (sel) => {
      const P = window.__pin, h = document.querySelector(sel), block = h.parentElement.querySelector(":scope > .msg.dgc");
      await P.bring(block, -block.offsetHeight / 3);
      const text = h.querySelector(".prompt-text");
      return { fold: h.querySelector(".bubble").dataset.fold, pinned: P.pinned().includes(h), at: P.rel(h),
        lines: text.clientHeight / parseFloat(getComputedStyle(text).lineHeight), position: getComputedStyle(h).position };
    }, head);
    assert.equal(folded.fold, "folded");
    assert.ok(folded.pinned && folded.position === "sticky", "pinned, folded");
    assert.ok(Math.abs(folded.lines - 5) < 0.1, `showing its five lines (${folded.lines})`);

    // Show more on the pinned prompt: it goes back to where it was sent, then opens there.
    await s.page.hover(`${head} > .bubble`);
    await s.page.click(`${head} .prompt-fold`);
    const opened = await s.page.evaluate(async (sel) => {
      const P = window.__pin, h = document.querySelector(sel), view = P.log.getBoundingClientRect();
      const toggle = h.querySelector(".prompt-fold").getBoundingClientRect(), bubble = h.querySelector(".bubble").getBoundingClientRect();
      const out = { fold: h.querySelector(".bubble").dataset.fold, position: getComputedStyle(h).position, top: P.rel(h),
        own: P.laidOut(h) - view.top, lessStuck: bubble.bottom > view.bottom && toggle.bottom < view.bottom && toggle.top > view.top };
      await P.scrollBy(300);
      out.after = P.rel(h);
      out.pinnedAfter = P.pinned().includes(h);
      return out;
    }, head);
    assert.equal(opened.fold, "open");
    assert.equal(opened.position, "relative", "an open prompt does not pin");
    assert.ok(Math.abs(opened.top - opened.own) <= 0.5 && Math.abs(opened.top - 16) <= 1, `it opened in its own place, at the top (${opened.top}px)`);
    assert.ok(opened.lessStuck, "running past the bottom of the view, its Show less is stuck in reach above the edge");
    assert.ok(Math.abs(opened.after - (opened.top - 300)) <= 1, "and it scrolls away with the page like any block");
    assert.equal(opened.pinnedAfter, false);

    // The prompt above pinned while this one, open, runs off the bottom: two sticky things, one at each
    // edge, and they never meet.
    const both = await s.page.evaluate(async (sel) => {
      const P = window.__pin, h = document.querySelector(sel), above = h.parentElement.previousElementSibling;
      await P.bring(h, 230);
      const view = P.log.getBoundingClientRect(), pinned = P.pinned();
      const toggle = h.querySelector(".prompt-fold").getBoundingClientRect(), bubble = h.querySelector(".bubble").getBoundingClientRect();
      const strip = pinned[0] ? pinned[0].getBoundingClientRect() : null;
      return { pinnedAbove: pinned.length === 1 && pinned[0] === above.querySelector(":scope > .turn-head"),
        lessStuck: bubble.bottom > view.bottom && toggle.bottom < view.bottom,
        gap: strip ? toggle.top - (strip.bottom + 12) : null, hit: document.elementFromPoint(toggle.left + toggle.width / 2, toggle.top + toggle.height / 2)?.closest(".prompt-fold") === h.querySelector(".prompt-fold") };
    }, head);
    assert.ok(both.pinnedAbove, "the previous prompt is the one pinned");
    assert.ok(both.lessStuck, "this one's Show less is stuck above the bottom edge");
    assert.ok(both.gap > 0, `and the two never meet (${both.gap}px apart)`);
    assert.ok(both.hit, "nothing covers Show less");

    // Read inside it, its top above the view, then Show less: folded, it comes back to where it was sent
    // and pins again.
    await s.page.evaluate(async (sel) => { const P = window.__pin, h = document.querySelector(sel); await P.bring(h, -200); }, head);
    assert.deepEqual(await s.page.evaluate(() => window.__pin.pinned().length), 0, "nothing is pinned over an open prompt");
    await s.page.click(`${head} .prompt-fold`);
    const refolded = await s.page.evaluate(async (sel) => {
      const P = window.__pin, h = document.querySelector(sel);
      const out = { fold: h.querySelector(".bubble").dataset.fold, top: P.rel(h), own: P.laidOut(h) - P.log.getBoundingClientRect().top };
      await P.scrollBy(150);
      out.pinned = P.pinned().includes(h);
      out.after = P.rel(h);
      out.position = getComputedStyle(h).position;
      return out;
    }, head);
    assert.equal(refolded.fold, "folded");
    assert.ok(Math.abs(refolded.own - 16) <= 1, `brought back: its own place is at the top (${refolded.own}px)`);
    assert.ok(refolded.pinned && Math.abs(refolded.after - 16) <= 1 && refolded.position === "sticky", "and reading on, it is pinned again");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

// Opened, a long prompt is usually too tall to pin anyway (the 30% guard). In a tall window an eight-line
// one is not: only being open stops it pinning, and folding it pins it again at once.
test("in a tall window an opened prompt short enough to pin still scrolls away, and Show less brings it back pinned", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openPage({ width: 460, height: 1000 });
  try {
    const EIGHT = Array.from({ length: 8 }, (_, i) => `Step ${i + 1}: check the bounds`).join("\n");
    await s.events([...turn("t0", "Earlier question", `${PROSE(0)}\n\n${PROSE(1)}`), ...turn("t1", EIGHT, `${PROSE(2)}\n\n${PROSE(3)}\n\n${PROSE(4)}`),
      ...turn("t2", "Next question", `${PROSE(5)}\n\n${PROSE(6)}`)]);
    await s.settle();
    const head = ".turn > .msg.user.turn-head:has(.prompt-fold)";
    const pinned = await s.page.evaluate(async (sel) => {
      const P = window.__pin, h = document.querySelector(sel), block = h.parentElement.querySelector(":scope > .msg.dgc");
      await P.bring(block, -block.offsetHeight / 3);
      return { fold: h.querySelector(".bubble").dataset.fold, pinned: P.pinned().includes(h) };
    }, head);
    assert.deepEqual(pinned, { fold: "folded", pinned: true });
    await s.page.hover(`${head} > .bubble`);
    await s.page.click(`${head} .prompt-fold`);
    await s.settle(30);
    const opened = await s.page.evaluate(async (sel) => {
      const P = window.__pin, h = document.querySelector(sel);
      const out = { fold: h.querySelector(".bubble").dataset.fold, off: h.classList.contains("pin-off"), position: getComputedStyle(h).position,
        top: P.rel(h), strip: h.getBoundingClientRect().height + 28, room: innerHeight * 0.3 };
      await P.scrollBy(150);
      out.after = P.rel(h);
      return out;
    }, head);
    assert.equal(opened.fold, "open");
    assert.ok(!opened.off && opened.strip <= opened.room, `short enough to pin (${opened.strip}px of ${opened.room}): the guard is not what stops it`);
    assert.equal(opened.position, "relative", "open, it does not pin");
    assert.ok(Math.abs(opened.after - (opened.top - 150)) <= 1, `it scrolls away with the page (${opened.top} -> ${opened.after})`);

    // Read on with its top above the view, then fold it: it pins again at once, so where it is laid out
    // has to come from its box, not from where it is drawn.
    await s.page.evaluate(async (sel) => { const P = window.__pin; await P.bring(document.querySelector(sel), -100); }, head);
    await s.page.click(`${head} .prompt-fold`);
    const folded = await s.page.evaluate((sel) => {
      const P = window.__pin, h = document.querySelector(sel);
      return { fold: h.querySelector(".bubble").dataset.fold, own: P.laidOut(h) - P.log.getBoundingClientRect().top, position: getComputedStyle(h).position };
    }, head);
    assert.equal(folded.fold, "folded");
    assert.equal(folded.position, "sticky");
    assert.ok(Math.abs(folded.own - 16) <= 1, `brought back to where it was sent, 16px clear of the edge (${folded.own}px)`);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("a prompt whose pinned strip would take more than 30% of the window does not pin, whatever the draft does", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openPage({ width: 900, height: 500 });
  try {
    await s.events([...turn("t0", "Two short lines\nof prompt"), ...turn("t1", "📷 What is wrong with this screenshot?"), ...turn("t2", "Thanks")]);
    await s.settle();
    const state = () => s.page.evaluate(async () => {
      const P = window.__pin, [small, tall] = P.heads();
      const read = async (h) => {
        const block = h.parentElement.querySelector(":scope > .msg.dgc");
        await P.bring(block, -block.offsetHeight / 2);
        return { off: h.classList.contains("pin-off"), position: getComputedStyle(h).position, pinned: P.pinned().includes(h),
          strip: h.getBoundingClientRect().height + 28, room: innerHeight * 0.3 };
      };
      return { small: await read(small), tall: await read(tall) };
    });
    const first = await state();
    assert.ok(first.small.strip <= first.small.room && !first.small.off && first.small.pinned, `a short prompt pins (${JSON.stringify(first.small)})`);
    assert.ok(first.tall.strip > first.tall.room, `the screenshot prompt's strip is ${first.tall.strip}px of ${first.tall.room}`);
    assert.ok(first.tall.off && first.tall.position === "relative" && !first.tall.pinned, "so it scrolls away like any block");
    // An eight-line draft takes height from the transcript, not the window: nothing flips.
    await s.page.evaluate(() => {
      const input = document.getElementById("input");
      input.value = Array.from({ length: 8 }, (_, i) => `draft line ${i + 1}`).join("\n");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await s.settle();
    const drafted = await state();
    assert.deepEqual([drafted.small.off, drafted.tall.off], [false, true], "typing a long draft changes neither");
    await s.page.setViewportSize({ width: 900, height: 900 });
    await s.settle();
    const tall = await state();
    assert.ok(!tall.tall.off && tall.tall.pinned, "in a taller window the same prompt pins");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("a click on a pinned prompt goes back to it; a double-click, a link and a click under the fade do not jump", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openPage({ width: 520, height: 700 });
  try {
    const code = "```js\nconst bound = pages.reduce((sum, page) => sum + page.length, 0);\n```";
    await s.events([...turn("t0", "Earlier question"),
      ...turn("t1", "Read https://example.com/docs and check the bounds", `${PROSE(1)}\n\n${code}\n\n${PROSE(2)}`), ...turn("t2", "Next")]);
    await s.settle();
    const into = () => s.page.evaluate(async () => {
      const P = window.__pin, h = P.heads()[1], block = h.parentElement.querySelector(":scope > .msg.dgc");
      await P.bring(block, -120);
      const text = h.querySelector(".prompt-text").getBoundingClientRect();
      return { pinned: P.pinned().includes(h), top: P.log.scrollTop, x: text.left + 12, y: text.top + text.height / 2 };
    });
    const where = () => s.page.evaluate(() => {
      const P = window.__pin, h = P.heads()[1];
      return { top: P.log.scrollTop, own: P.laidOut(h) - P.rest(), pill: !document.getElementById("to-latest").hidden,
        selected: getSelection().toString() };
    });

    let at = await into();
    assert.ok(at.pinned, "the prompt is pinned over its answer");
    await s.page.mouse.click(at.x, at.y);
    await s.page.waitForTimeout(450);
    let now = await where();
    assert.ok(Math.abs(now.own) <= 1, `a click goes back to where it was sent (${now.own}px from the rest line)`);
    assert.ok(now.pill, "and the Latest pill offers the end again");

    at = await into();
    await s.page.mouse.dblclick(at.x, at.y);
    await s.page.waitForTimeout(450);
    now = await where();
    assert.equal(now.top, at.top, "a double-click selects a word and never jumps");
    assert.ok(now.selected.trim().length > 0, `the word is selected ("${now.selected}")`);
    await s.page.evaluate(() => getSelection().removeAllRanges());

    at = await into();
    await s.page.click(".turn-head .prompt-link");
    await s.page.waitForTimeout(450);
    assert.equal((await where()).top, at.top, "a link opens and the transcript stays put");
    assert.ok(await s.page.evaluate(() => window.__posted.some((m) => m.type === "openExternal" && m.url.startsWith("https://example.com/docs"))));

    // A mouse press on a button under the fade: it is focused, but never moved, so the click lands.
    const press = await s.page.evaluate(async () => {
      const P = window.__pin, h = P.heads()[1], copy = h.parentElement.querySelector("pre.code .copy");
      await P.bring(copy, h.getBoundingClientRect().bottom - P.log.getBoundingClientRect().top + 2);
      const r = copy.getBoundingClientRect();
      window.__downTop = null;
      P.log.addEventListener("mousedown", () => { window.__downTop = P.log.scrollTop; }, { capture: true, once: true });
      return { pinned: P.pinned().includes(h), under: r.top - h.getBoundingClientRect().bottom, x: r.left + r.width / 2, y: r.top + 6, top: P.log.scrollTop };
    });
    assert.ok(press.pinned && press.under >= 0 && press.under < 12, `the copy button's top is under the fade (${press.under}px)`);
    await s.page.mouse.click(press.x, press.y);
    const pressed = await s.page.evaluate(() => ({ down: window.__downTop, top: window.__pin.log.scrollTop,
      copied: window.__posted.some((m) => m.type === "copy"), focused: document.activeElement?.classList.contains("copy") }));
    assert.equal(pressed.down, press.top);
    assert.equal(pressed.top, press.top, "mouse focus did not move it between press and release");
    assert.ok(pressed.copied, "the click landed on the button");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("Tab never leaves focus under a pinned prompt", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openPage({ width: 520, height: 700 });
  try {
    const code = "```js\nconst bound = pages.reduce((sum, page) => sum + page.length, 0);\n```";
    await s.events([...turn("t0", "Earlier question"), ...turn("t1", "Check the bounds", `${PROSE(1)}\n\n${code}\n\n${PROSE(2)}`), ...turn("t2", "Next")]);
    await s.settle();
    const before = await s.page.evaluate(async () => {
      const P = window.__pin, h = P.heads()[1], copy = h.parentElement.querySelector("pre.code .copy");
      await P.bring(copy, h.getBoundingClientRect().bottom - P.log.getBoundingClientRect().top - 20);
      // A focusable stand-in right before the button, so one Tab lands on it.
      const stop = document.createElement("span");
      stop.tabIndex = 0; stop.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
      copy.before(stop);
      stop.focus({ preventScroll: true });
      return { pinned: P.pinned().includes(h), covered: h.getBoundingClientRect().bottom - copy.getBoundingClientRect().top };
    });
    assert.ok(before.pinned && before.covered > 0, `the button starts ${before.covered}px under the pinned prompt`);
    await s.page.keyboard.press("Tab");
    await s.settle(30);
    const after = await s.page.evaluate(() => {
      const P = window.__pin, h = P.heads()[1], copy = document.activeElement;
      return { isCopy: copy.classList.contains("copy"), visible: copy.matches(":focus-visible"), pinned: P.pinned().includes(h),
        gap: copy.getBoundingClientRect().top - h.getBoundingClientRect().bottom };
    });
    assert.ok(after.isCopy && after.visible, "Tab focused the button");
    assert.ok(after.pinned, "the prompt is still pinned");
    assert.ok(after.gap >= 12 - 1, `and the button now sits below it and its fade (${after.gap}px)`);

    // Shift+Tab back to it from further down, with it scrolled away above the view: the browser brings it
    // in (Chromium centres a control it focuses), after focusin has left it alone, and not under the prompt.
    const away = await s.page.evaluate(async () => {
      const P = window.__pin, h = P.heads()[1], copy = h.parentElement.querySelector("pre.code .copy");
      await P.bring(copy, -150);
      const stop = document.createElement("span");
      stop.tabIndex = 0; stop.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
      copy.after(stop);
      stop.focus({ preventScroll: true });
      return { pinned: P.pinned().includes(h), above: copy.getBoundingClientRect().bottom < P.log.getBoundingClientRect().top,
        why: { copy: P.rel(copy), head: P.rel(h), own: P.laidOut(h) - P.log.getBoundingClientRect().top, top: P.log.scrollTop, max: P.log.scrollHeight - P.log.clientHeight } };
    });
    assert.ok(away.pinned && away.above, `the button is above the view, the prompt pinned ${JSON.stringify(away)}`);
    await s.page.keyboard.press("Shift+Tab");
    await s.settle(30);
    const back = await s.page.evaluate(() => {
      const P = window.__pin, h = P.heads()[1], copy = document.activeElement;
      return { isCopy: copy.classList.contains("copy"), pinned: P.pinned().includes(h),
        gap: copy.getBoundingClientRect().top - h.getBoundingClientRect().bottom };
    });
    assert.ok(back.isCopy && back.pinned, "Shift+Tab focused it, the prompt still pinned");
    assert.ok(back.gap >= 12 - 1, `and it was brought in below the prompt, not under it (${back.gap}px)`);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("a request card DGC focuses from the image viewer lands below the pinned prompt", async (t) => {
  if (skipOrFail(t)) return;
  const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const s = await openPage({ width: 520, height: 700 });
  try {
    await s.events([{ type: "ready", capabilities: { image_views: true, history_snapshot: true } }, ...turn("t0", "Earlier question"),
      { type: "turn_start", turn_id: "t1", prompt: "Look at the login page", kind: "prompt" },
      { type: "tool_call", call_id: "c1", name: "browser", args: {}, summary: "browser" },
      { type: "tool_result", call_id: "c1", name: "browser", output: "screenshot saved", is_error: false, is_diff: false },
      { type: "tool_images", call_id: "c1", images: [PNG] }, { type: "text_delta", text: PROSE(1) }]);
    await s.settle();
    await s.page.evaluate(() => {
      const card = document.querySelector('.tool[data-call-id="c1"]');
      card.closest(".tool-group")?.setAttribute("open", "");
      card.querySelector(".tool-toggle").click();
    });
    await s.page.evaluate(() => document.querySelector('.tool[data-call-id="c1"] .image-chip').click());
    await s.page.waitForSelector("#image-viewer");
    await s.events([{ type: "permission_request", id: "p1", call_id: "c2", name: "bash", args: { command: "rm -rf build" }, command: "rm -rf build",
      summary: "rm -rf build", suggested_rule: "Bash(rm -rf build)", choices: ["once", "always", "deny"] },
      { type: "text_delta", text: ` ${PROSE(2)}` }]);                 // the stream went on below the card
    await s.page.waitForSelector("#image-viewer .iv-notice:not([hidden])");
    // Under the viewer, the reader had left the card under the pinned prompt: the control Show will focus
    // (the card's first, as showWaitingRequest picks it) is hidden behind it.
    const before = await s.page.evaluate(async () => {
      const P = window.__pin, h = P.heads()[1], card = document.querySelector('.card[data-request-id="p1"]');
      const control = [...card.querySelectorAll("button, input, select, textarea, [tabindex]")].find((c) => !c.disabled && !c.closest("[hidden]"));
      const block = h.parentElement.querySelector(":scope > .msg.dgc");
      await P.bring(block, -block.offsetHeight / 3);              // into the answer, so the prompt pins
      await P.bring(control, h.getBoundingClientRect().bottom - P.log.getBoundingClientRect().top - 10);
      return { pinned: P.pinned().includes(h), covered: h.getBoundingClientRect().bottom + 12 - control.getBoundingClientRect().top };
    });
    assert.ok(before.pinned && before.covered > 0, `the control starts ${before.covered}px under the prompt and its fade`);
    await s.page.click("#image-viewer .iv-show");
    await s.settle(30);
    const m = await s.page.evaluate(() => {
      const P = window.__pin, h = P.heads()[1], focused = document.activeElement;
      return { inCard: !!focused?.closest('.card[data-request-id="p1"]'), pinned: P.pinned().includes(h), keyboard: focused.matches(":focus-visible"),
        gap: focused.getBoundingClientRect().top - h.getBoundingClientRect().bottom };
    });
    assert.ok(m.inCard, "Show focused the card");
    assert.ok(m.pinned, "with its prompt still pinned");
    assert.ok(m.gap >= 12 - 1, `the focused control is below the prompt and its fade (${m.gap}px)${m.keyboard ? "" : ", though no keyboard was involved"}`);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("live and replayed, the same conversation pins the same prompt in the same place", async (t) => {
  if (skipOrFail(t)) return;
  const live = await openPage(), replay = await openPage();
  try {
    for (const [i, prompt] of PROMPTS.entries()) {
      const id = await live.type(prompt);
      await live.events([{ type: "prompt_accepted", request_id: id, state: "started" }, ...turn(`t${i}`, prompt, PROSE(`t${i}`), { request_id: id })]);
    }
    // The archive answers that there is nothing older, so no "Show earlier messages" sits above the replay.
    await replay.events([{ type: "session", kind: "resumed", session_id: "s1" },
      { type: "history", items: PROMPTS.flatMap((prompt, i) => turn(`t${i}`, prompt)), todos: [] },
      { type: "recall", items: [], before: 0, more: false }]);
    await live.settle(); await replay.settle();
    const height = async (s) => s.page.evaluate(() => window.__pin.log.scrollHeight);
    assert.equal(await height(replay), await height(live), "the same length");
    const at = (s, top) => s.page.evaluate(async (y) => {
      const P = window.__pin;
      await P.scrollTo(y);
      return P.pinned().map((head) => { const r = head.getBoundingClientRect(); return [P.heads().indexOf(head), r.top, r.height, r.left, r.width]; });
    }, top);
    for (const index of [0, 1, 2]) {
      const top = await live.page.evaluate(async (i) => {
        const P = window.__pin, block = P.heads()[i].parentElement.querySelector(":scope > .msg.dgc");
        await P.bring(block, -block.offsetHeight / 2);
        return P.log.scrollTop;
      }, index);
      const [a, b] = [await at(live, top), await at(replay, top)];
      assert.equal(a.length, 1, `live, in answer ${index}: one prompt pinned`);
      assert.deepEqual(b.map((row) => row.map(Math.round)), a.map((row) => row.map(Math.round)), `in answer ${index}, at scrollTop ${top}`);
    }
    assert.deepEqual([...live.errors, ...replay.errors], []);
  } finally { await live.page.close(); await replay.page.close(); }
});

test("deep in a long chat the pinned prompt is drawn while its turns are skipped, and restored pages settle", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openPage();
  try {
    const items = Array.from({ length: 30 }, (_, i) => turn(`h${i}`, `Question ${i}`, PROSE(i))).flat();
    await s.events([{ type: "session", kind: "resumed", session_id: "s1" }, { type: "history", items, todos: [] }]);
    await s.settle();
    const deep = await s.page.evaluate(async () => {
      const P = window.__pin, heads = P.heads(), block = heads[Math.floor(heads.length / 2)].parentElement.querySelector(":scope > .msg.dgc");
      await P.bring(block, -block.offsetHeight / 2);
      await P.frames(3);
      const [head] = P.pinned(), r = head.getBoundingClientRect();
      return { drawn: head.checkVisibility(), size: r.width * r.height, cv: getComputedStyle(head).contentVisibility,
        blocks: [...P.log.querySelectorAll(".turn > .msg.dgc")].map((b) => getComputedStyle(b).contentVisibility) };
    });
    assert.ok(deep.drawn && deep.size > 0, "the pinned prompt is rendered");
    assert.equal(deep.cv, "visible", "never skipped: paint containment would clip its ground");
    assert.ok(deep.blocks.every((cv) => cv === "auto"), "while every turn's block keeps being skipped off screen");
    await s.page.evaluate(() => document.querySelector(".history-older").click());
    await s.settle();
    const landed = await s.page.evaluate(() => [...document.querySelectorAll(".history-pages .msg.dgc.hist")].filter((b) => !b.classList.contains("settled")).length);
    assert.equal(landed, 0, "every restored block is settled, inside its box");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("an archived prompt pins over its answers with an opaque ground: its bubble is dimmed, not its row", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openPage();
  try {
    await s.events([{ type: "session", kind: "resumed", session_id: "s1" }, { type: "history", items: turn("h1", "Live question"), todos: [] },
      { type: "recall", before: 0, more: false, items: [{ role: "user", text: "An archived question" },
        { role: "assistant", text: PROSE("a1") }, { role: "assistant", text: PROSE("a2") }] }]);
    await s.settle();
    const m = await s.page.evaluate(async () => {
      const P = window.__pin, head = document.querySelector(".msg.archived.turn-head"), block = head.parentElement.querySelector(":scope > .msg.dgc");
      await P.bring(block, -block.offsetHeight / 2);
      return { pinned: P.pinned().includes(head), row: getComputedStyle(head).opacity, bubble: getComputedStyle(head.querySelector(".bubble")).opacity,
        answer: getComputedStyle(block).opacity };
    });
    assert.ok(m.pinned, "the archived prompt pins over its archived answers");
    assert.equal(m.row, "1", "the row, and so its ground, is opaque");
    assert.equal(m.bubble, "0.82", "the bubble carries the archive's dimming");
    assert.equal(m.answer, "0.82", "as the answers under it do");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("re-measuring after a width change, with a prompt pinned, keeps the block being read where it was", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openPage({ width: 988, height: 900 });
  try {
    await chat(s, Array.from({ length: 12 }, (_, i) => `Earlier question ${i}: does the bound hold here?`));
    await s.page.waitForTimeout(250);
    const before = await s.page.evaluate(async () => {
      const P = window.__pin, h = P.heads()[6], block = h.parentElement.querySelector(":scope > .msg.dgc");
      await P.bring(block, -block.offsetHeight / 3);
      return { pinned: P.pinned().includes(h) };
    });
    assert.ok(before.pinned, "a prompt is pinned over the block being read");
    await s.page.setViewportSize({ width: 320, height: 900 });
    await s.page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    const pick = () => s.page.evaluate(() => {
      const P = window.__pin, top = P.log.getBoundingClientRect().top;
      const blocks = [...P.log.querySelectorAll(".msg")].filter((n) => !n.parentElement.closest(".msg") && !n.classList.contains("turn-head"));
      const index = blocks.findIndex((n) => n.getBoundingClientRect().bottom > top);
      return { index, top: blocks[index].getBoundingClientRect().top };
    });
    const start = await pick();
    await s.page.waitForTimeout(450);
    const end = await s.page.evaluate((index) => {
      const P = window.__pin;
      return [...P.log.querySelectorAll(".msg")].filter((n) => !n.parentElement.closest(".msg") && !n.classList.contains("turn-head"))[index].getBoundingClientRect().top;
    }, start.index);
    assert.ok(Math.abs(end - start.top) <= 1, `the block being read moved ${Math.round(end - start.top)}px when the heights were re-measured`);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

for (const [theme, forcedColors] of [["dark-modern", false], ["light-modern", false], ["hc", false], ["dark-modern", true]]) {
  test(`the ground and the edge in ${forcedColors ? "forced colours" : theme}`, async (t) => {
    if (skipOrFail(t)) return;
    const s = await openPage({ theme, forcedColors });
    try {
      await chat(s, PROMPTS);
      const m = await s.page.evaluate(async () => {
        const P = window.__pin, block = P.heads()[1].parentElement.querySelector(":scope > .msg.dgc");
        await P.bring(block, -block.offsetHeight / 2);
        const [head] = P.pinned(), ground = getComputedStyle(head, "::before"), bubble = getComputedStyle(head.querySelector(".bubble"));
        const probe = document.createElement("div");
        probe.style.cssText = "background: var(--surface)";
        document.body.appendChild(probe);
        const surface = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return { bg: ground.backgroundColor, image: ground.backgroundImage, mask: ground.maskImage, bottom: ground.bottom, surface,
          outline: bubble.outlineStyle, outlineWidth: bubble.outlineWidth };
      });
      const hard = theme === "hc" || forcedColors;
      if (!forcedColors) {
        assert.equal(m.bg, m.surface, "the ground is painted over --surface");
        assert.match(m.image, /linear-gradient/, "with the panel background over it");
      }
      if (hard) {
        assert.equal(m.mask, "none", "a hard edge, not a fade");
        assert.equal(m.bottom, "-4px", "4px under the bubble");
        assert.equal(m.outline, "solid", "and an edge round the pinned prompt");
      } else {
        assert.match(m.mask, /linear-gradient/, "the answer fades out under it");
        assert.equal(m.bottom, "-12px");
        assert.equal(m.outline, "none", "no outline outside high contrast");
      }
      assert.deepEqual(s.errors, []);
    } finally { await s.page.close(); }
  });
}

test("with a translucent sidebar colour, nothing of the answer shows through the pinned strip", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openPage({ extraCss: ":root { --vscode-sideBar-background: rgba(24, 24, 24, .35); }" });
  try {
    await chat(s, PROMPTS);
    const box = await s.page.evaluate(async () => {
      const P = window.__pin, block = P.heads()[1].parentElement.querySelector(":scope > .msg.dgc");
      await P.bring(block, -block.offsetHeight / 2);
      const [head] = P.pinned(), view = P.log.getBoundingClientRect(), h = head.getBoundingClientRect();
      // The strip's left gutter and the space beside the bubble, where the answer's text runs under it.
      const bubble = head.querySelector(".bubble").getBoundingClientRect();
      return { x: Math.round(view.left + 2), y: Math.round(h.top + 4), width: Math.round(bubble.left - view.left - 6), height: Math.round(h.height - 8) };
    });
    // Distinct colours in that part of a real screenshot, decoded by the page's own canvas.
    const unique = async () => {
      const png = (await s.page.screenshot({ clip: box })).toString("base64");
      return s.page.evaluate(async (data) => {
        const image = new Image();
        image.src = `data:image/png;base64,${data}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width; canvas.height = image.height;
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, image.width, image.height).data, seen = new Set();
        for (let i = 0; i < pixels.length; i += 4) seen.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
        return seen.size;
      }, png);
    };
    const withGround = await unique();
    await s.page.addStyleTag({ content: "#log .turn > .msg.user.turn-head::before { display: none !important; }" });
    const without = await unique();
    assert.ok(without > withGround, `the answer runs under the strip (${without} distinct samples without the ground, ${withGround} with it)`);
    assert.ok(withGround <= 3, `and the ground hides it: the strip is one flat colour (${withGround} distinct samples)`);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});
