import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

// The space between transcript blocks is a layout fact, so only a real browser can check it. It
// held in a freshly streamed chat and vanished in every chat drawn from a history snapshot: a
// backend restart, a webview reload, a resume or a rewind put the restored blocks in a wrapper
// that was an ordinary box, and the prompt bubble sat 0px from the answer above it and from the
// turn below it. A prompt steered into a running turn got the turn's own 4px instead. These render
// the real panel in Chromium and measure the visible gaps around every prompt and between blocks.
// The same pages also hold the layout facts found next to that bug: the page under the reader must
// not jump when the panel's width or fonts change, when screenshots arrived while it was hidden, or
// after it collapsed; a queued prompt is drawn once and after whatever the log said before its turn;
// a turn nobody just asked for does not pull a reader back to the end; and markers and steered
// prompts keep the one rhythm beside anything a turn draws.
const here = dirname(fileURLToPath(import.meta.url));
let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser, html, mainJs, markdownJs;
// @playwright/test is a devDependency of the repository root (package.json there), so an
// editors/vscode checkout without the root's node_modules has no browser, and every test here
// skips -- visibly in the summary, but it still exits 0. DGC_REQUIRE_CHROMIUM=1 makes that a
// failure, for any run that must prove the layout rather than step around it.
const skipReason = () => (!chromium ? "playwright is not installed (npm ci at the repository root)"
  : !browser ? "Chromium could not start" : "");
const skipOrFail = (t) => {
  if (!skipReason()) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${skipReason()}`);
  t.skip(skipReason());
  return true;
};
const WIDTHS = [320, 988];
const BETWEEN_BLOCKS = 16;          // --sp-4: #log's gap, the space between any two transcript blocks
const ABOVE_PROMPT = 24;            // a prompt starts a new exchange: --sp-4 plus --sp-2

before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }); } catch { browser = null; return; }
  const panelSrc = readFileSync(here + "/../src/panel.ts", "utf8");
  const css = readFileSync(here + "/../media/main.css", "utf8");
  mainJs = readFileSync(here + "/../media/main.js", "utf8");
  markdownJs = buildSync({ entryPoints: [here + "/../src/markdown.ts"], bundle: true,
    format: "iife", globalName: "DgcMarkdown", write: false, platform: "browser" }).outputFiles[0].text;
  const skeleton = [...panelSrc.matchAll(/<!doctype html>[\s\S]*?<\/body><\/html>/gi)].map(m => m[0])
    .find(c => c.includes('id="input"')).replace(/\$\{[^}]*\}/g, "");
  html = skeleton.replace("</head>", `<style>${css}</style></head>`);
});
after(async () => { await browser?.close(); });

// ---- the conversation from the report: an answered turn, the next prompt, a turn running a command
const PROMPT1 = "Sign-in fails with \"Turnstile verification failed\" on the login page. What is wrong?";
const PROMPT2 = "ok, in .env, i have put up the new corrected turnstile keys , so check now";
const ANSWER = "The secret key in `.env` does not belong to the site key the login page renders.\n\n"
  + "1. Copy the **site key** and **secret key** for this hostname.\n2. Put them in `.env`.\n3. Restart the API.\n\n"
  + "## If you need to sign in before that\n\nSet `TURNSTILE_BYPASS=1` in `.env` for local development only.\n";
const COMMAND = "cd api && npm run api:restart && curl -s localhost:4000/health";
const answeredTurn = (id, prompt = PROMPT1, answer = ANSWER) => [
  { type: "turn_start", turn_id: id, prompt, kind: "prompt" },
  { type: "text_delta", text: "Let me look at how the API reads the Turnstile keys." },
  { type: "stream_end", message_id: `${id}:1`, phase: "commentary" },
  { type: "tool_call", call_id: `${id}c1`, name: "bash", args: { command: "grep -n TURNSTILE .env" }, summary: "grep -n TURNSTILE .env" },
  { type: "tool_result", call_id: `${id}c1`, name: "bash", output: ".env:14:TURNSTILE_SITE_KEY=0x4AAA" },
  { type: "text_delta", text: answer },
  { type: "stream_end", message_id: `${id}:2`, phase: "answer" },
  { type: "turn_end", turn_id: id, reason: "completed", token_estimate: 0, final_message_id: `${id}:2` },
];
const runningTurn = (id, requestId) => [
  { type: "turn_start", turn_id: id, prompt: PROMPT2, kind: "prompt", ...(requestId ? { request_id: requestId } : {}) },
  { type: "text_delta", text: "Checking the new keys and restarting the API to pick them up:" },
  { type: "stream_end", message_id: `${id}:1`, phase: "commentary" },
  { type: "tool_call", call_id: `${id}c1`, name: "bash", args: { command: COMMAND }, summary: COMMAND },
];
// What a snapshot holds after the backend closed the unfinished turn.
const interruptedSnapshot = (older = []) => [...older, ...answeredTurn("h1"), ...runningTurn("h2"),
  { type: "turn_end", turn_id: "h2", reason: "cancelled", token_estimate: 0, final_message_id: null }];

// ---- panel driver --------------------------------------------------------------------------------
async function openPanel(width, { steering = false } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 2 });
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(([mjs, mdjs]) => {
    window.__posts = [];
    window.acquireVsCodeApi = () => ({ postMessage(m) { window.__posts.push(m); }, getState: () => undefined, setState() {} });
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(mjs);
  }, [mainJs, markdownJs]);
  const panel = {
    page,
    // Delivered one at a time with a tick between, the way a stream arrives.
    send: (...messages) => page.evaluate(async (list) => {
      for (const data of list) {
        window.dispatchEvent(new MessageEvent("message", { data }));
        await new Promise((done) => setTimeout(done, 4));
      }
    }, messages),
    events: (list) => panel.send(...list.map((event) => ({ type: "event", event }))),
    settle: () => page.evaluate(() => new Promise((done) =>
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 120))))),
    // Enter in the composer. A hidden panel takes no real key presses, so the same keydown is
    // dispatched on the textarea itself.
    prompt: (text = PROMPT2) => page.evaluate((value) => {
      const input = document.getElementById("input");
      input.value = value; input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      return window.__posts.filter((m) => m.type === "prompt").at(-1)?.requestId;
    }, text),
  };
  await panel.send({ type: "session_ready", sessionId: "s1" }, { type: "event", event: { type: "ready",
    capabilities: { history_snapshot: true, ...(steering ? { live_steering: true, steering_native: true } : {}) },
    model: "qwen3.8:27b", mode: "default", think: "off", commands: [], custom_commands: [],
    goal: { text: "", status: "none" }, context_size: 65536, session_id: "s1" } });
  return panel;
}
async function answeredThenPrompted(panel) {
  await panel.events(answeredTurn("t1"));
  await panel.settle();
  const requestId = await panel.prompt();
  await panel.events([{ type: "prompt_accepted", request_id: requestId, state: "started" }, ...runningTurn("t2", requestId)]);
}

// The backend exits mid-turn, the session is resumed and repainted from its snapshot, and the
// interrupted turn continues live below it.
async function restartAndRepaint(panel) {
  await panel.send({ type: "event", event: { type: "error", message: "dgc backend exited" } },
    { type: "session_ready", sessionId: "s1" });
  await panel.events([{ type: "session", kind: "resumed", session_id: "s1", message_count: 6 },
    { type: "history", items: interruptedSnapshot(), todos: [] },
    { type: "turn_start", turn_id: "t3", prompt: "Continue the interrupted turn", kind: "continue" },
    { type: "tool_call", call_id: "t3c1", name: "bash", args: { command: COMMAND }, summary: COMMAND }]);
}

// ---- measurement (runs in the page) --------------------------------------------------------------
// Around each prompt bubble: the distance to the nearest thing drawn above and below it that is not
// the bubble's own block or a block containing it. Between blocks: every consecutive pair of
// transcript blocks, wherever in the DOM the panel put them.
function measureSpacing() {
  const log = document.getElementById("log");
  const box = (n) => n.getBoundingClientRect();
  // A closed <details> still lays its body out; checkVisibility() is what knows it is not drawn.
  const drawn = (n) => { const r = box(n); return r.width > 0 && r.height > 0 && n.checkVisibility?.() !== false; };
  const ink = [...log.querySelectorAll("*")].filter((n) => !n.closest(".role") && drawn(n));
  const bubbles = [...log.querySelectorAll(".msg.user > .bubble")].filter(drawn).map((bubble) => {
    const b = box(bubble);
    let above = null, below = null;
    for (const n of ink) {
      if (n.contains(bubble) || bubble.contains(n)) continue;
      const r = box(n);
      if (r.top < b.top) above = Math.max(above ?? -Infinity, r.bottom);
      else below = Math.min(below ?? Infinity, r.top);
    }
    return { text: bubble.textContent.slice(0, 40), steered: !!bubble.parentElement.parentElement.closest(".msg"),
      above: above === null ? null : Math.round(b.top - above), below: below === null ? null : Math.round(below - b.bottom) };
  });
  const blocks = [...log.querySelectorAll(".msg, .resume-note, .sys, .compaction")]
    .filter((n) => !n.parentElement.closest(".msg") && drawn(n));
  const pairs = blocks.slice(1).map((next, i) => ({ gap: Math.round(box(next).top - box(blocks[i]).bottom),
    between: `${blocks[i].className} -> ${next.className}` }));
  const older = log.querySelector(".history-older");
  const pad = getComputedStyle(log);
  const columnWidth = log.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight);
  return { bubbles, pairs, blockCount: blocks.length, columnWidth,
    olderWidth: older && drawn(older) ? Math.round(box(older).width) : null };
}
const measure = (panel) => panel.page.evaluate(measureSpacing);
const toBottom = (panel) => panel.page.evaluate(() => { const log = document.getElementById("log"); log.scrollTop = log.scrollHeight; });

function assertSpacing(m, label) {
  assert.ok(m.blockCount >= 2, `${label}: a real transcript was rendered (${m.blockCount} blocks)`);
  for (const pair of m.pairs) {
    assert.ok(pair.gap >= BETWEEN_BLOCKS, `${label}: ${pair.gap}px between ${pair.between}, want at least ${BETWEEN_BLOCKS}px`);
  }
  assert.ok(m.bubbles.length > 0, `${label}: a prompt bubble is on screen`);
  for (const b of m.bubbles) {
    // A steered prompt too: it is the user speaking, inside the turn or not.
    if (b.above !== null) assert.ok(b.above >= ABOVE_PROMPT, `${label}: "${b.text}" is ${b.above}px below what precedes it, want ${ABOVE_PROMPT}px`);
    if (b.below !== null) assert.ok(b.below >= BETWEEN_BLOCKS, `${label}: "${b.text}" is ${b.below}px above what follows it, want ${BETWEEN_BLOCKS}px`);
  }
}
const around = (m, text = PROMPT2) => {
  const hit = m.bubbles.filter((b) => text.startsWith(b.text)).at(-1);
  assert.ok(hit, `the bubble for "${text.slice(0, 30)}" was measured`);
  return { above: hit.above, below: hit.below };
};

// ---- scenarios -----------------------------------------------------------------------------------
const hideWays = {
  "display:none": [(p) => p.page.evaluate(() => { document.body.style.display = "none"; }),
    (p) => p.page.evaluate(() => { document.body.style.display = ""; })],
  "collapsed to zero width": [(p) => p.page.setViewportSize({ width: 1, height: 900 }),
    (p, width) => p.page.setViewportSize({ width, height: 900 })],
};
const scenarios = {
  "streamed live": async (panel) => { await answeredThenPrompted(panel); },
  "replayed from a history snapshot": async (panel) => {
    await panel.events([{ type: "session", kind: "resumed", session_id: "s1" },
      { type: "history", items: interruptedSnapshot(), todos: [] }]);
  },
  // The report's chain.
  "repainted after a backend restart mid-turn": async (panel) => {
    await answeredThenPrompted(panel);
    await panel.settle();
    await restartAndRepaint(panel);
  },
  // The same, while the founder was on another view: the restored blocks are measured for skipping
  // with nothing laid out, and only get a size once the panel is shown again.
  "repainted after a backend restart while hidden": async (panel) => {
    await answeredThenPrompted(panel);
    await panel.settle();
    const [hide, show] = hideWays["display:none"];
    await hide(panel);
    await restartAndRepaint(panel);
    await panel.settle();
    await show(panel);
  },
  "restored across history pages and the archive": async (panel) => {
    const older = [];
    for (let i = 0; i < 12; i += 1) older.push(...answeredTurn(`o${i}`, `Earlier question ${i}`, `Answer ${i}. ` + "Some prose. ".repeat(12)));
    await panel.events([{ type: "session", kind: "resumed", session_id: "s1" },
      { type: "history", items: interruptedSnapshot(older), todos: [] }]);
    await panel.settle();
    await panel.page.evaluate(() => document.querySelector(".history-older").click());
    await panel.settle();
    await panel.page.evaluate(() => document.querySelector(".history-older").click());
    await panel.events([{ type: "recall", items: [{ role: "user", text: "An archived question" },
      { role: "assistant", text: "An archived answer" }], before: 3, more: true }]);
  },
  ...Object.fromEntries(Object.entries(hideWays).map(([way, [hide, show]]) => [
    `hidden (${way}) while the turn ended and the next prompt was sent`, async (panel, width) => {
      const turn = answeredTurn("t1");
      await panel.events(turn.slice(0, -1));
      await panel.settle();
      await hide(panel, width);
      await panel.events([turn.at(-1)]);
      await panel.settle();
      const requestId = await panel.prompt();
      await panel.events([{ type: "prompt_accepted", request_id: requestId, state: "started" }, ...runningTurn("t2", requestId)]);
      await panel.settle();
      await show(panel, width);
    }])),
  "scrolled away so blocks were skipped, then back": async (panel) => {
    for (let i = 0; i < 10; i += 1) await panel.events(answeredTurn(`p${i}`, `Earlier question ${i}`, `Answer ${i}. ` + "The bounds hold. ".repeat(10)));
    await answeredThenPrompted(panel);
    await panel.settle();
    await panel.page.evaluate(() => { const log = document.getElementById("log"); log.dispatchEvent(new WheelEvent("wheel")); log.scrollTop = 0; });
    await panel.settle();
    await panel.page.evaluate(() => { const log = document.getElementById("log"); log.dispatchEvent(new WheelEvent("wheel")); log.scrollTop = log.scrollHeight; });
  },
};

for (const width of WIDTHS) {
  for (const [name, run] of Object.entries(scenarios)) {
    test(`prompts and turns keep their spacing when ${name} (${width}px)`, async (t) => {
      if (skipOrFail(t)) return;
      const panel = await openPanel(width);
      try {
        await run(panel, width);
        await panel.settle(); await toBottom(panel); await panel.settle();
        const m = await measure(panel);
        assertSpacing(m, `${name} at ${width}px`);
        if (m.olderWidth !== null) {
          assert.ok(m.olderWidth < m.columnWidth - 1,
            `"Show earlier messages" keeps its own width instead of spanning the column (${m.olderWidth}px of ${m.columnWidth}px)`);
        }
      } finally { await panel.page.close(); }
    });
  }

  // However the screen was built, the same conversation is spaced the same way.
  test(`a replayed conversation is spaced exactly like the live one (${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const live = await openPanel(width), replayed = await openPanel(width);
    try {
      await scenarios["streamed live"](live);
      await scenarios["replayed from a history snapshot"](replayed);
      for (const panel of [live, replayed]) { await panel.settle(); await toBottom(panel); await panel.settle(); }
      assert.deepEqual(around(await measure(replayed)), around(await measure(live)));
    } finally { await live.page.close(); await replayed.page.close(); }
  });

  // Steering applies a prompt inside the running turn, whose own blocks sit 4px apart.
  test(`a prompt steered into a running turn keeps the space between blocks (${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const panel = await openPanel(width, { steering: true });
    try {
      await panel.events(answeredTurn("t1").slice(0, 5));          // commentary and a finished command
      await panel.settle();
      const requestId = await panel.prompt();
      await panel.events([{ type: "prompt_accepted", request_id: requestId, state: "steered" },
        { type: "steering_update", request_id: requestId, state: "applied" },
        { type: "text_delta", text: "Checking the new keys and restarting the API to pick them up:" },
        { type: "stream_end", message_id: "t1:3", phase: "commentary" },
        { type: "tool_call", call_id: "t1c9", name: "bash", args: { command: COMMAND }, summary: COMMAND }]);
      await panel.settle(); await toBottom(panel); await panel.settle();
      const m = await measure(panel);
      const steered = m.bubbles.find((b) => b.steered);
      assert.ok(steered, "the prompt was applied inside the running turn");
      assertSpacing(m, `steered at ${width}px`);
    } finally { await panel.page.close(); }
  });
}

// ---- the page under the reader -------------------------------------------------------------------
// Off-screen blocks are skipped at a pinned height. A pin is a height at one width, and a skipped
// block is never laid out again, so after the panel's width changed and stayed changed, scrolling
// back met blocks growing or shrinking as they came into view: the page jumped 100-200px, and a run
// that went on while the panel was collapsed to nothing left 20,000px of phantom transcript.
const LONG_ANSWER = (i) => `Answer ${i}. ` + "The bounds hold across every page of the transcript, and the parser reads them back. ".repeat(6);
async function longChat(panel, turns = 12) {
  for (let i = 0; i < turns; i += 1) await panel.events(answeredTurn(`p${i}`, `Earlier question ${i}: does the bound hold here?`, LONG_ANSWER(i)));
}
const wait = (panel, ms) => panel.page.evaluate((t) => new Promise((done) => setTimeout(done, t)), ms);
// Scroll to points through the transcript and watch the block under the viewport for a few frames.
function probeScrolling() {
  return (async () => {
    const log = document.getElementById("log");
    const frames = (n) => new Promise((done) => { const f = () => (--n <= 0 ? done() : requestAnimationFrame(f)); requestAnimationFrame(f); });
    const out = [];
    for (const fraction of [0.75, 0.5, 0.25, 0.1]) {
      const height = log.scrollHeight;
      log.dispatchEvent(new WheelEvent("wheel")); log.scrollTop = Math.round(height * fraction);
      await frames(2);
      const box = log.getBoundingClientRect();
      const anchor = document.elementFromPoint(box.left + box.width / 2, box.top + box.height * 0.4)?.closest(".msg, .resume-note, .sys");
      const top = anchor?.getBoundingClientRect().top;
      await frames(6); await new Promise((done) => setTimeout(done, 60));
      out.push({ fraction, moved: anchor ? Math.round(anchor.getBoundingClientRect().top - top) : 0,
        heightChange: log.scrollHeight - height });
    }
    return out;
  })();
}
const scrollHeightOf = (panel) => panel.page.evaluate(() => document.getElementById("log").scrollHeight);
async function freshScrollHeight(width, build) {
  const fresh = await openPanel(width);
  try { await build(fresh); await fresh.settle(); await wait(fresh, 250); return await scrollHeightOf(fresh); }
  finally { await fresh.page.close(); }
}
function assertStill(probe, label) {
  for (const step of probe) {
    assert.ok(Math.abs(step.moved) <= 1, `${label}: at ${step.fraction * 100}% of the transcript the block being read moved ${step.moved}px`);
    assert.ok(Math.abs(step.heightChange) <= 1, `${label}: at ${step.fraction * 100}% the transcript's length changed by ${step.heightChange}px`);
  }
}
const resizes = [["narrower", 988, 320], ["wider", 320, 988]];
for (const [way, from, to] of resizes) {
  test(`the page does not jump after the panel is made ${way} and stays that way (${from}px to ${to}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const panel = await openPanel(from);
    try {
      await longChat(panel);
      await panel.settle(); await toBottom(panel); await wait(panel, 250);
      await panel.page.setViewportSize({ width: to, height: 900 });
      await panel.settle(); await wait(panel, 400);
      assertStill(await panel.page.evaluate(probeScrolling), `made ${way}`);
      assert.ok(Math.abs(await scrollHeightOf(panel) - await freshScrollHeight(to, longChat)) <= 2,
        `made ${way}: the transcript is as long as the same chat drawn at ${to}px`);
    } finally { await panel.page.close(); }
  });
}
for (const width of WIDTHS) {
  test(`a run that went on while the panel was collapsed leaves no phantom length (${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const panel = await openPanel(width);
    try {
      await panel.page.setViewportSize({ width: 1, height: 900 });
      await longChat(panel);
      await panel.settle(); await wait(panel, 250);
      await panel.page.setViewportSize({ width, height: 900 });
      await panel.settle(); await wait(panel, 400); await toBottom(panel); await panel.settle();
      assert.ok(Math.abs(await scrollHeightOf(panel) - await freshScrollHeight(width, longChat)) <= 2,
        "the transcript is as long as the same chat drawn at this width all along");
      assertStill(await panel.page.evaluate(probeScrolling), "after being collapsed");
    } finally { await panel.page.close(); }
  });
}
test("re-measuring after a width change keeps the block being read where it was", async (t) => {
  if (skipOrFail(t)) return;
  const panel = await openPanel(988);
  try {
    await longChat(panel);
    await panel.settle(); await wait(panel, 250);
    await panel.page.evaluate(() => { const log = document.getElementById("log"); log.dispatchEvent(new WheelEvent("wheel")); log.scrollTop = log.scrollHeight * 0.4; });
    await panel.settle();
    await panel.page.setViewportSize({ width: 320, height: 900 });
    await panel.page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    const before = await panel.page.evaluate(() => {
      const log = document.getElementById("log"), top = log.getBoundingClientRect().top;
      const blocks = [...log.querySelectorAll(".msg")].filter((n) => !n.parentElement.closest(".msg"));
      const index = blocks.findIndex((n) => n.getBoundingClientRect().bottom > top);
      return { index, top: blocks[index].getBoundingClientRect().top };
    });
    await wait(panel, 400);
    const after = await panel.page.evaluate((index) => {
      const log = document.getElementById("log");
      return [...log.querySelectorAll(".msg")].filter((n) => !n.parentElement.closest(".msg"))[index].getBoundingClientRect().top;
    }, before.index);
    assert.ok(Math.abs(after - before.top) <= 1, `the block at the top of the view moved ${Math.round(after - before.top)}px when the heights were re-measured`);
  } finally { await panel.page.close(); }
});

// "Show earlier messages" goes away when the archive runs out. It is above the reader, like the
// rows that arrive with it, so its going must not move the page either.
test("the archive running out while reading the top of history does not move the page", async (t) => {
  if (skipOrFail(t)) return;
  const panel = await openPanel(988);
  try {
    const items = [];
    for (let i = 0; i < 30; i += 1) items.push(...answeredTurn(`h${i}`, `Question ${i}`, `Answer ${i}. ` + "Prose. ".repeat(20)));
    await panel.events([{ type: "session", kind: "resumed", session_id: "s1" }, { type: "history", items, todos: [] }]);
    await panel.settle();
    for (let i = 0; i < 8; i += 1) {
      const asked = await panel.page.evaluate(() => window.__posts.some((m) => m.type === "getRecall"));
      if (asked) break;
      await panel.page.evaluate(() => { const older = document.querySelector(".history-older"); if (!older.disabled) older.click(); });
      await panel.settle();
    }
    const shift = await panel.page.evaluate(async () => {
      const log = document.getElementById("log");
      const raf = () => new Promise((done) => requestAnimationFrame(() => done()));
      log.dispatchEvent(new WheelEvent("wheel")); log.scrollTop = 0; await raf();
      const anchor = log.querySelector(".msg");
      const top = anchor.getBoundingClientRect().top;
      window.dispatchEvent(new MessageEvent("message", { data: { type: "event", event: { type: "recall",
        items: [{ role: "user", text: "An archived question" }, { role: "assistant", text: "An archived answer" }], before: 0, more: false } } }));
      await raf(); await raf();
      return { hidden: document.querySelector(".history-older").hidden, moved: Math.round(anchor.getBoundingClientRect().top - top) };
    });
    assert.equal(shift.hidden, true, "the archive said there is nothing more, so the button is gone");
    assert.ok(Math.abs(shift.moved) <= 1, `the block being read moved ${shift.moved}px`);
  } finally { await panel.page.close(); }
});

// ---- queued prompts ------------------------------------------------------------------------------
// A prompt queued behind a running turn is drawn when it is sent. Its turn's start used to echo it
// again, below the prompts still waiting: two queued prompts read P2, P3, P2, reply, P3.
const QUEUED = ["Also check the rate limiter while you are there", "And then run the auth tests"];
const topLevel = (panel) => panel.page.evaluate(() => [...document.getElementById("log").querySelectorAll(".msg")]
  .filter((n) => !n.parentElement.closest(".msg"))
  .map((n) => (n.classList.contains("user") ? `you: ${n.querySelector(".bubble").textContent}` : "dgc")));
for (const width of WIDTHS) {
  test(`prompts queued behind a running turn are drawn once, each above its own reply (${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const panel = await openPanel(width), replayed = await openPanel(width);
    try {
      await panel.events(runningTurn("t1"));
      const first = await panel.prompt(QUEUED[0]);
      await panel.events([{ type: "prompt_accepted", request_id: first, state: "queued" }, { type: "queued", count: 1 }]);
      const second = await panel.prompt(QUEUED[1]);
      await panel.events([{ type: "prompt_accepted", request_id: second, state: "queued" }, { type: "queued", count: 2 },
        { type: "tool_result", call_id: "t1c1", name: "bash", output: "ok" },
        { type: "text_delta", text: ANSWER }, { type: "stream_end", message_id: "t1:2", phase: "answer" },
        { type: "turn_end", turn_id: "t1", reason: "completed", token_estimate: 0, final_message_id: "t1:2" },
        ...answeredTurn("t2", QUEUED[0]).slice(0, 5).map((e, i) => (i === 0 ? { ...e, request_id: first } : e))]);
      await panel.settle();
      // The first queued prompt's turn is running; the second is still waiting at the bottom.
      assert.deepEqual(await topLevel(panel), [`you: ${PROMPT2}`, "dgc", `you: ${QUEUED[0]}`, "dgc", `you: ${QUEUED[1]}`]);
      await panel.events([...answeredTurn("t2", QUEUED[0]).slice(5),
        { type: "turn_start", turn_id: "t3", prompt: QUEUED[1], kind: "prompt", request_id: second },
        { type: "text_delta", text: "Running the auth tests." }, { type: "stream_end", message_id: "t3:1", phase: "commentary" }]);
      await panel.settle(); await toBottom(panel); await panel.settle();
      const order = [`you: ${PROMPT2}`, "dgc", `you: ${QUEUED[0]}`, "dgc", `you: ${QUEUED[1]}`, "dgc"];
      assert.deepEqual(await topLevel(panel), order);
      const live = await measure(panel);
      assertSpacing(live, `queued at ${width}px`);
      // The same chat drawn from its snapshot reads the same, spaced the same.
      await replayed.events([{ type: "session", kind: "resumed", session_id: "s1" }, { type: "history", todos: [], items: [
        ...runningTurn("h1"), { type: "tool_result", call_id: "h1c1", name: "bash", output: "ok" },
        { type: "text_delta", text: ANSWER }, { type: "stream_end", message_id: "h1:2", phase: "answer" },
        { type: "turn_end", turn_id: "h1", reason: "completed", token_estimate: 0, final_message_id: "h1:2" },
        ...answeredTurn("h2", QUEUED[0]),
        { type: "turn_start", turn_id: "h3", prompt: QUEUED[1], kind: "prompt" },
        { type: "text_delta", text: "Running the auth tests." }, { type: "stream_end", message_id: "h3:1", phase: "commentary" }] }]);
      await replayed.settle(); await toBottom(replayed); await replayed.settle();
      assert.deepEqual(await topLevel(replayed), order);
      const restored = await measure(replayed);
      for (const text of QUEUED) assert.deepEqual(around(restored, text), around(live, text), `"${text}" is spaced the same live and restored`);
    } finally { await panel.page.close(); await replayed.page.close(); }
  });
}

// ---- where the first prompt starts ---------------------------------------------------------------
// A reloaded or cleared chat with nothing to restore still inserts its empty history wrapper first.
test("the first prompt of an empty restored chat starts where a fresh chat's does", async (t) => {
  if (skipOrFail(t)) return;
  const fresh = await openPanel(988), restored = await openPanel(988);
  try {
    await restored.events([{ type: "session", kind: "resumed", session_id: "s1" }, { type: "history", items: [], todos: [] },
      { type: "recall", items: [], before: 0, more: false }]);
    for (const panel of [fresh, restored]) { await panel.prompt(PROMPT1); await panel.settle(); }
    const offset = (panel) => panel.page.evaluate(() => {
      const log = document.getElementById("log"), prompt = log.querySelector(".msg.user");
      return Math.round(prompt.getBoundingClientRect().top - log.getBoundingClientRect().top - parseFloat(getComputedStyle(log).paddingTop));
    });
    assert.equal(await offset(fresh), 0, "a fresh chat's first prompt sits on the log's padding");
    assert.equal(await offset(restored), 0, "so does the first prompt of an empty restored chat");
  } finally { await fresh.page.close(); await restored.page.close(); }
});

// ---- markers -------------------------------------------------------------------------------------
// A compaction marker and a notice in restored history, and the note a continued turn leaves, sit in
// the log's column like every other block: its gap spaces them, with nothing of their own on top.
test("markers in the transcript take the space between blocks and add none of their own", async (t) => {
  if (skipOrFail(t)) return;
  const panel = await openPanel(460), restarted = await openPanel(460);
  try {
    await panel.events([{ type: "session", kind: "resumed", session_id: "s1" }, { type: "history", todos: [], items: [
      ...answeredTurn("h1"), { role: "compaction", text: "Summary of the earlier turns." },
      { role: "notice", text: "Model switched to qwen3.8:27b" }, ...answeredTurn("h2", PROMPT2)] },
      { type: "recall", items: [], before: 0, more: false }]);
    await panel.settle(); await toBottom(panel); await panel.settle();
    const m = await measure(panel);
    assertSpacing(m, "compaction and notice");
    // The answer, the marker, the notice, then the next prompt a step further as always.
    const markers = m.pairs.filter((pair) => /compaction|sys/.test(pair.between))
      .map((pair) => [pair.between.replace(/ hist| settled/g, ""), pair.gap]);
    assert.deepEqual(markers, [["msg dgc -> compaction", BETWEEN_BLOCKS], ["compaction -> sys", BETWEEN_BLOCKS],
      ["sys -> msg user", ABOVE_PROMPT]]);

    await answeredThenPrompted(restarted); await restarted.settle(); await restartAndRepaint(restarted);
    await restarted.settle(); await toBottom(restarted); await restarted.settle();
    const note = await restarted.page.evaluate(() => {
      const node = document.querySelector(".resume-note.continue-note");
      const text = node.querySelector("span:last-child").getBoundingClientRect(), box = node.getBoundingClientRect();
      return { above: Math.round(text.top - box.top), below: Math.round(box.bottom - text.bottom) };
    });
    assert.ok(note.above <= 1 && note.below <= 1, `the continue note carries ${note.above}px above and ${note.below}px below its text`);
    assertSpacing(await measure(restarted), "after a continued turn");
  } finally { await panel.page.close(); await restarted.page.close(); }
});

// ---- steering, in every position -----------------------------------------------------------------
// A steered prompt stands 24px below whatever it follows inside the turn -- a tool group, prose, the
// answer -- and when it is the turn's last word, the next prompt is 24px below it, not 36.
for (const width of WIDTHS) {
  test(`steered prompts are spaced like prompts wherever they land in the turn (${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const panel = await openPanel(width, { steering: true });
    const steer = async (text, events = []) => {
      const id = await panel.prompt(text);
      await panel.events([{ type: "prompt_accepted", request_id: id, state: "steered" },
        { type: "steering_update", request_id: id, state: "applied" }, ...events]);
    };
    try {
      await panel.events(answeredTurn("t1").slice(0, 5));                            // prose, then a finished command
      await steer("S1 after a tool group", [{ type: "text_delta", text: "Some prose after the first steer that runs on for a line or two so it wraps." }]);
      await steer("S2 after prose", [{ type: "tool_call", call_id: "t1c2", name: "bash", args: { command: "pwd" }, summary: "pwd" },
        { type: "tool_result", call_id: "t1c2", name: "bash", output: "/x" },
        { type: "text_delta", text: ANSWER }, { type: "stream_end", message_id: "t1:3", phase: "answer" }]);
      await steer("S3 right before the turn ended", [{ type: "turn_end", turn_id: "t1", reason: "completed", token_estimate: 0, final_message_id: "t1:3" }]);
      await panel.settle();
      const next = await panel.prompt("S4 an ordinary prompt after the steered turn");
      await panel.events([{ type: "prompt_accepted", request_id: next, state: "started" },
        ...answeredTurn("t2", "S4 an ordinary prompt after the steered turn").map((e, i) => (i === 0 ? { ...e, request_id: next } : e))]);
      await panel.settle(); await toBottom(panel); await panel.settle();
      const m = await measure(panel);
      assertSpacing(m, `steered at ${width}px`);
      const steered = m.bubbles.filter((b) => b.steered);
      assert.equal(steered.length, 3, "three prompts were applied inside the turn");
      for (const b of steered) assert.equal(b.above, ABOVE_PROMPT, `"${b.text}" is ${b.above}px below what precedes it`);
      assert.equal(around(m, "S3 right before the turn ended").below, ABOVE_PROMPT, "the next prompt stands 24px below the last steered one");
      assert.equal(around(m, "S1 after a tool group").below, BETWEEN_BLOCKS, "prose follows a steered prompt at 16px");
    } finally { await panel.page.close(); }
  });
}
// Steered, and the turn ends at once: spaced like a prompt above, and the turn's closing line
// ("Worked for 2s") follows it at 16px, like any reply.
test("a steer applied as the turn ends is spaced like a prompt, and the turn's closing line follows at 16px", async (t) => {
  if (skipOrFail(t)) return;
  const panel = await openPanel(460, { steering: true });
  try {
    await panel.events(answeredTurn("t1").slice(0, 3));
    const id = await panel.prompt("steer this");
    await panel.events([{ type: "prompt_accepted", request_id: id, state: "steered" }, { type: "steering_update", request_id: id, state: "applied" },
      { type: "turn_end", turn_id: "t1", reason: "completed", token_estimate: 0, final_message_id: null }]);
    await panel.settle();
    await panel.events(answeredTurn("t2", PROMPT2));
    await panel.settle(); await toBottom(panel); await panel.settle();
    const m = await measure(panel);
    assertSpacing(m, "steered then ended");
    assert.equal(around(m, "steer this").below, BETWEEN_BLOCKS);
  } finally { await panel.page.close(); }
});

// ---- the page under the reader, part two ---------------------------------------------------------
// Walk up from the end of the transcript a step at a time, the way a reader scrolls back, and report
// every step where the thing under the middle of the view moved by more than the scroll itself.
function walkUp(step) {
  return (async () => {
    const log = document.getElementById("log");
    const frames = (n) => new Promise((done) => { const f = () => (--n <= 0 ? done() : requestAnimationFrame(f)); requestAnimationFrame(f); });
    log.dispatchEvent(new WheelEvent("wheel")); log.scrollTop = log.scrollHeight; await frames(3);
    const jumps = [];
    let steps = 0;
    for (let i = 0; i < 400 && log.scrollTop > 0; i += 1) {
      const view = log.getBoundingClientRect();
      const anchor = document.elementFromPoint(view.left + view.width / 2, view.top + view.height / 2)
        ?.closest("p, li, pre, h2, .bubble, .tool-images, .tool, .text, .thinking, .sys, .resume-note, .msg");
      if (!anchor || !log.contains(anchor)) { log.scrollTop -= 40; await frames(2); continue; }
      const top = anchor.getBoundingClientRect().top, from = log.scrollTop;
      log.dispatchEvent(new WheelEvent("wheel")); log.scrollTop = from - (step === "half" ? Math.round(log.clientHeight / 2) : step);
      const applied = log.scrollTop - from;
      await frames(2); await new Promise((done) => setTimeout(done, 40)); await frames(2);
      steps += 1;
      const moved = Math.round(anchor.getBoundingClientRect().top - (top - applied));
      if (Math.abs(moved) > 1) jumps.push({ at: Math.round(from), moved, under: String(anchor.className || anchor.tagName).slice(0, 30) });
    }
    return { steps, jumps };
  })();
}
async function assertWalkIsSteady(panel, label, step = 120) {
  const walk = await panel.page.evaluate(walkUp, step);
  assert.ok(walk.steps >= 5, `${label}: the walk covered the transcript (${walk.steps} steps)`);
  assert.deepEqual(walk.jumps, [], `${label}: scrolling back moved the page under the reader`);
}

// A 200x100 screenshot, as a tool sends it. It lands inside the step that took it: a count on the
// collapsed card, chips once the card is open (a failed step opens itself, so its chips are drawn at once).
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMgAAABkCAIAAABM5OhcAAAA0klEQVR42u3SMQ0AAAjAMOZf9DDBwUcrYVlTwIJfYGAsGAvGgrFgLBgLxoKxYCwYC8aCsWAsGAvGgrFgLBgLxoKxYCwYC8aCsWAsGAvGgrFgLBgLxoKxYCwYC8aCsWAsGAvGgrFgLBgLxoKxYCwYC8aCsWAsGAvGgrFgLBgLxoKxYCwYC8aCsWAsGAvGgrFgLBgLxoKxYCwYC8aCsWAsGAvGgrFgLBgLxoKxYCwYC8aCsWAsGAvGgrFgLBgLxoKxYCwYC8aCsWAsGAvGgrFgLBgLbw1wAa3mAWHtHrAAAAAASUVORK5CYII=";
const screenshotTurn = (id, prompt = "Show me the login page", expanded = false) => [
  { type: "turn_start", turn_id: id, prompt, kind: "prompt" },
  { type: "tool_call", call_id: `${id}c1`, name: "screenshot", args: { url: "http://localhost:3000/login" }, summary: "localhost:3000/login" },
  { type: "tool_result", call_id: `${id}c1`, name: "screenshot", output: expanded ? "error: captured with 2 console errors" : "captured",
    ...(expanded ? { is_error: true } : {}) },
  { type: "tool_images", call_id: `${id}c1`, images: [PNG, PNG], caption: "Login page" },
  { type: "text_delta", text: "That is the login page with the Turnstile widget." }, { type: "stream_end", message_id: `${id}:1`, phase: "answer" },
  { type: "turn_end", turn_id: id, reason: "completed", token_estimate: 0, final_message_id: `${id}:1` },
];
// Screenshots that arrive while the panel is on another view: a lazily loaded image has no height,
// so its block was pinned (and skipped) without it and grew by the strip's height when a scroll
// finally reached it -- 74px at 460 and 988, 148px at 300. Collapsed, the card only gains a count;
// expanded (a failed step opens itself), its fixed-size chips are drawn while the panel is hidden.
for (const width of WIDTHS) {
  for (const [way, [hide, show]] of Object.entries(hideWays)) {
    for (const expanded of [false, true]) {
      test(`screenshots that arrived while the panel was hidden (${way}${expanded ? ", card expanded" : ""}) do not move the page when scrolled back to (${width}px)`, async (t) => {
        if (skipOrFail(t)) return;
        const panel = await openPanel(width);
        try {
          await hide(panel, width);
          await longChat(panel, 3);
          await panel.events(screenshotTurn("s1", undefined, expanded));
          await longChat(panel, 8);
          await wait(panel, 300);
          await show(panel, width);
          await panel.settle(); await wait(panel, 600);
          const strip = await panel.page.evaluate((open) => {
            const card = document.querySelector('.tool[data-call-id="s1c1"]');
            if (!card.querySelector(".tool-image-count")) return { missing: "the count pill" };
            if (open && card.querySelectorAll(".tool-images .image-chip img").length !== 2) return { missing: "two chips" };
            if (!open && card.querySelector(".tool-images")) return { missing: "no chips while collapsed" };
            const block = card.closest(".msg");
            block.classList.remove("settled"); const real = block.offsetHeight; block.classList.add("settled");
            return { pinned: block._pinnedHeight, real };
          }, expanded);
          assert.equal(strip.missing, undefined, strip.missing);
          assert.ok(Math.abs(strip.pinned - strip.real) <= 1, `the screenshot turn is pinned at ${strip.pinned}px but is ${strip.real}px tall`);
          await assertWalkIsSteady(panel, `screenshots while ${way}`);
        } finally { await panel.page.close(); }
      });
    }
  }
}
// Scrolling straight after dragging the sidebar: the re-measure waits for the width to hold still,
// and a scroll inside that wait met blocks at their old width's height -- one jump of ~200px.
for (const [way, from, to] of resizes) {
  test(`scrolling straight after the panel is made ${way} does not jump (${from}px to ${to}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const panel = await openPanel(from);
    try {
      await longChat(panel, 16);
      await panel.settle(); await wait(panel, 300);
      await panel.page.evaluate(() => { const log = document.getElementById("log"); log.dispatchEvent(new WheelEvent("wheel")); log.scrollTop = Math.round(log.scrollHeight * 0.6); });
      await panel.settle();
      for (let k = 1; k <= 12; k += 1) {                      // a drag: a dozen widths ~20ms apart
        await panel.page.setViewportSize({ width: Math.round(from + (to - from) * k / 12), height: 900 });
        await wait(panel, 20);
      }
      const moved = await panel.page.evaluate(async () => {
        const log = document.getElementById("log");
        const frames = (n) => new Promise((done) => { const f = () => (--n <= 0 ? done() : requestAnimationFrame(f)); requestAnimationFrame(f); });
        const out = [];
        for (let s = 0; s < 8; s += 1) {
          const view = log.getBoundingClientRect();
          const anchor = document.elementFromPoint(view.left + view.width / 2, view.top + view.height / 2)?.closest("p, li, .bubble, .text, .thinking, .msg");
          if (!anchor) { log.scrollTop -= 40; await frames(1); continue; }
          const top = anchor.getBoundingClientRect().top, start = log.scrollTop;
          log.dispatchEvent(new WheelEvent("wheel")); log.scrollTop = start - 100;
          const applied = log.scrollTop - start;
          await frames(3);
          out.push(Math.round(anchor.getBoundingClientRect().top - (top - applied)));
        }
        return out;
      });
      assert.ok(moved.length >= 6, "the scroll steps found something to read");
      assert.ok(moved.every((m) => Math.abs(m) <= 1), `made ${way}, the steps straight after moved the page ${JSON.stringify(moved)}`);
    } finally { await panel.page.close(); }
  });
}

// The host changes the transcript's fonts (VS Code rewrites its --vscode-* variables on the root
// element) without changing the width: every pin measured in the old fonts is wrong.
// Both the old and the new fonts are faces this repository ships (test/fonts, DejaVu 2.37),
// added to the page as loaded FontFaces before the chat is drawn. Named system families are not:
// a stock CI runner resolves 'DejaVu Serif' and the default sans to the same face, nothing
// re-wraps, and the test could neither fail nor pass on what it is meant to prove.
const BUNDLED_FONTS = [["DGC Test Sans", "DejaVuSans.ttf"], ["DGC Test Mono", "DejaVuSansMono.ttf"]];
test("the page does not jump after the fonts change at the same width", async (t) => {
  if (skipOrFail(t)) return;
  const faces = BUNDLED_FONTS.map(([family, file]) =>
    [family, readFileSync(here + "/fonts/" + file).toString("base64")]);
  for (const settleFirst of [true, false]) {
    const panel = await openPanel(320);
    try {
      await panel.page.evaluate(async (list) => {
        for (const [family, base64] of list) {
          const face = new FontFace(family, Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
          document.fonts.add(await face.load());
        }
        const root = document.documentElement.style;
        root.setProperty("--vscode-font-family", '"DGC Test Sans"');
        root.setProperty("--vscode-editor-font-family", '"DGC Test Mono"');
      }, faces);
      await panel.settle(); await wait(panel, 300);
      await longChat(panel, 16);
      await panel.settle(); await wait(panel, 300);
      const before = await scrollHeightOf(panel);
      await panel.page.evaluate(() => {
        // Prose in the monospace face and code in the proportional one: every line re-wraps.
        const root = document.documentElement.style;
        root.setProperty("--vscode-font-family", '"DGC Test Mono"');
        root.setProperty("--vscode-editor-font-family", '"DGC Test Sans"');
      });
      if (settleFirst) await wait(panel, 600);
      await assertWalkIsSteady(panel, `fonts changed${settleFirst ? "" : ", walked at once"}`, "half");
      assert.ok(Math.abs(await scrollHeightOf(panel) - before) > 50, "the new fonts really re-wrapped the transcript");
    } finally { await panel.page.close(); }
  }
});

// Blocks that were on screen when the panel collapsed to a sliver were measured there by the
// size observer, thousands of px tall, while still claiming the width they had been pinned at.
// Back at that same width nothing re-measured them: 12,000px of phantom transcript and a
// 10,800px jump on the first scroll up.
for (const width of WIDTHS) {
  test(`blocks on screen when the panel collapsed are measured again when it comes back at the same width (${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const panel = await openPanel(width);
    const build = async (p) => { await p.events(answeredTurn("t0")); await longChat(p, 5); };
    try {
      await panel.events(answeredTurn("t0"));
      await panel.settle(); await wait(panel, 300);
      await panel.page.setViewportSize({ width: 1, height: 900 });
      await wait(panel, 300);
      await longChat(panel, 5);
      await wait(panel, 300);
      await panel.page.setViewportSize({ width, height: 900 });
      await panel.settle(); await wait(panel, 600);
      assert.ok(Math.abs(await scrollHeightOf(panel) - await freshScrollHeight(width, build)) <= 2,
        "the transcript is as long as the same chat drawn at this width all along");
      await assertWalkIsSteady(panel, "after collapsing with blocks on screen", 250);
    } finally { await panel.page.close(); }
  });
}

// ---- turns nobody just asked for -----------------------------------------------------------------
// A monitor waking DGC, or a prompt queued minutes ago starting, is news for a reader who scrolled
// back: the "New" pill, not a jump to the bottom. A prompt typed now still goes to the bottom.
test("a turn nobody just asked for leaves a reader who scrolled back where they are", async (t) => {
  if (skipOrFail(t)) return;
  const readBack = (panel) => panel.page.evaluate(async () => {
    const log = document.getElementById("log");
    log.dispatchEvent(new WheelEvent("wheel")); log.scrollTop = Math.round(log.scrollHeight * 0.3);
    await new Promise((done) => setTimeout(done, 50));
    return log.scrollTop;
  });
  const view = (panel) => panel.page.evaluate(() => {
    const log = document.getElementById("log");
    return { top: log.scrollTop, atEnd: log.scrollHeight - log.scrollTop - log.clientHeight < 60, pill: !document.getElementById("to-latest").hidden };
  });
  const monitor = await openPanel(460), queued = await openPanel(460), typed = await openPanel(460);
  try {
    await longChat(monitor, 8); await monitor.settle();
    const top = await readBack(monitor); await wait(monitor, 800);
    await monitor.events([{ type: "turn_start", turn_id: "w1", prompt: "npm run dev printed 2 lines", kind: "monitor" },
      { type: "monitor_event", id: "m1", description: "npm run dev", event_index: 3, lines: ["ready on :3000"], omitted_lines: 0, kind: "output", delivery: "wake", turn_id: "w1" },
      { type: "text_delta", text: "The dev server recompiled cleanly." }]);
    await monitor.settle();
    const afterWake = await view(monitor);
    assert.ok(Math.abs(afterWake.top - top) <= 1 && afterWake.pill, `a monitor wake moved the reader from ${top} to ${afterWake.top}`);

    await longChat(queued, 8);
    await queued.events(runningTurn("r1"));
    const id = await queued.prompt(QUEUED[0]);
    await queued.events([{ type: "prompt_accepted", request_id: id, state: "queued" }, { type: "queued", count: 1 }]);
    await queued.settle();
    const queuedTop = await readBack(queued); await wait(queued, 800);
    await queued.events([{ type: "turn_end", turn_id: "r1", reason: "completed", token_estimate: 0, final_message_id: null },
      { type: "turn_start", turn_id: "q1", prompt: QUEUED[0], kind: "prompt", request_id: id }, { type: "text_delta", text: "Checking the limiter." }]);
    await queued.settle();
    const afterQueued = await view(queued);
    assert.ok(Math.abs(afterQueued.top - queuedTop) <= 1 && afterQueued.pill, `a queued prompt's turn moved the reader from ${queuedTop} to ${afterQueued.top}`);

    await longChat(typed, 8); await typed.settle();
    await readBack(typed); await wait(typed, 800);
    const typedId = await typed.prompt(PROMPT2);
    await typed.events([{ type: "prompt_accepted", request_id: typedId, state: "started" }, ...runningTurn("t9", typedId)]);
    await typed.settle();
    assert.equal((await view(typed)).atEnd, true, "a prompt typed now still shows its turn");
  } finally { await monitor.page.close(); await queued.page.close(); await typed.page.close(); }
});

// ---- what happened between a queued prompt and its turn ------------------------------------------
// A line the log wrote after the previous turn ended and before the queued prompt's turn began (a
// manual compaction, a notice, a non-fatal error) happened before that turn, so it stays above it.
const orderOf = (panel) => panel.page.evaluate(() => [...document.getElementById("log").querySelectorAll(".msg, .sys, .compaction")]
  .filter((n) => !n.parentElement.closest(".msg"))
  .map((n) => (n.classList.contains("user") ? `you: ${n.querySelector(".bubble").textContent}` : n.classList.contains("dgc") ? "dgc" : "line")));
for (const [what, between] of [
  ["a compaction", { type: "compacted", before_tokens: 60000, after_tokens: 20000, context_size: 65536, strategy: "summary" }],
  ["a non-fatal error", { type: "error", message: "Provider hiccup, retrying" }],
]) {
  test(`${what} logged between a turn's end and a queued prompt's turn stays above that turn`, async (t) => {
    if (skipOrFail(t)) return;
    const panel = await openPanel(460);
    try {
      await panel.events(runningTurn("t1"));
      const first = await panel.prompt(QUEUED[0]);
      await panel.events([{ type: "prompt_accepted", request_id: first, state: "queued" }, { type: "queued", count: 1 }]);
      const second = await panel.prompt(QUEUED[1]);
      await panel.events([{ type: "prompt_accepted", request_id: second, state: "queued" }, { type: "queued", count: 2 },
        { type: "turn_end", turn_id: "t1", reason: "completed", token_estimate: 0, final_message_id: null },
        between,
        { type: "turn_start", turn_id: "t2", prompt: QUEUED[0], kind: "prompt", request_id: first },
        { type: "text_delta", text: "Checking the rate limiter." }]);
      await panel.settle();
      assert.deepEqual(await orderOf(panel), [`you: ${PROMPT2}`, "dgc", `you: ${QUEUED[0]}`, "line", "dgc", `you: ${QUEUED[1]}`]);
      assertSpacing(await measure(panel), `${what} before a queued turn`);
    } finally { await panel.page.close(); }
  });
}

// ---- steering, beside everything a turn can draw ---------------------------------------------------
// Only the steered prompt's own margins may decide its space: a screenshot strip's 12px, a monitor
// card's 8px, a tool group's 4px, or the turn's own prompt just above used to add to it (36px above,
// 20-24px below). The screenshot step is checked collapsed and with its chips open.
for (const width of WIDTHS) {
  for (const expanded of [false, true]) {
  test(`a steered prompt is 24px below and 16px above whatever it sits beside in the turn (${width}px${expanded ? ", screenshot step expanded" : ""})`, async (t) => {
    if (skipOrFail(t)) return;
    const panel = await openPanel(width, { steering: true });
    const steer = async (text, events = []) => {
      const id = await panel.prompt(text);
      await panel.events([{ type: "prompt_accepted", request_id: id, state: "steered" },
        { type: "steering_update", request_id: id, state: "applied" }, ...events]);
    };
    try {
      const base = await panel.prompt("S0 the turn's own prompt");
      await panel.events([{ type: "prompt_accepted", request_id: base, state: "started" },
        { type: "turn_start", turn_id: "t1", prompt: "S0 the turn's own prompt", kind: "prompt", request_id: base }]);
      await steer("S1 before the turn drew anything", [{ type: "text_delta", text: "Prose after the first steer." }, { type: "stream_end", message_id: "t1:1", phase: "commentary" }]);
      await steer("S2 after prose", [{ type: "tool_call", call_id: "c1", name: "bash", args: { command: "ls" }, summary: "ls" }, { type: "tool_result", call_id: "c1", name: "bash", output: "a\nb" }]);
      await steer("S3 after a tool group", [{ type: "permission_request", id: "p1", name: "bash", command: "rm -rf x", args: {}, summary: "rm -rf x" }]);
      await steer("S4 after a permission card", [{ type: "permission_resolved", id: "p1", decision: "yes", message: "Allowed once" },
        { type: "tool_call", call_id: "c2", name: "screenshot", args: {}, summary: "shot" },
        { type: "tool_result", call_id: "c2", name: "screenshot", output: expanded ? "error: shot with errors" : "ok", ...(expanded ? { is_error: true } : {}) },
        { type: "tool_images", call_id: "c2", images: [PNG], caption: "Shot" }]);
      if (expanded) assert.equal(await panel.page.evaluate(() => document.querySelectorAll('.tool[data-call-id="c2"].open .tool-images .image-chip').length), 1);
      await steer("S5 after a screenshot step", [{ type: "monitor_event", id: "m1", description: "npm run dev", event_index: 1, lines: ["ready"], omitted_lines: 0, kind: "output", delivery: "inline", turn_id: "t1" }]);
      await steer("S6 after a monitor card", [{ type: "error", message: "transient: rate limited, retrying" }]);
      await steer("S7 after an error line");
      await steer("S8 straight after S7", [{ type: "text_delta", text: ANSWER }, { type: "stream_end", message_id: "t1:9", phase: "answer" },
        { type: "turn_end", turn_id: "t1", reason: "completed", token_estimate: 0, final_message_id: "t1:9" }]);
      const next = await panel.prompt("S9 the next prompt");
      await panel.events([{ type: "prompt_accepted", request_id: next, state: "started" },
        ...answeredTurn("t2", "S9 the next prompt").map((e, i) => (i === 0 ? { ...e, request_id: next } : e))]);
      await panel.settle(); await wait(panel, 200); await toBottom(panel); await panel.settle();
      const m = await measure(panel);
      assertSpacing(m, `steered beside everything at ${width}px`);
      const got = Object.fromEntries(["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9"].map((key) => {
        const hit = m.bubbles.find((b) => b.text.startsWith(key));
        return [key, hit ? [hit.above, hit.below] : null];
      }));
      assert.deepEqual(got, { S1: [24, 16], S2: [24, 16], S3: [24, 16], S4: [24, 16], S5: [24, 16], S6: [24, 16],
        S7: [24, 24], S8: [24, 16], S9: [24, 16] }, "above/below each steered prompt (S7 is followed by a prompt, so 24)");
    } finally { await panel.page.close(); }
  });
  }
}
