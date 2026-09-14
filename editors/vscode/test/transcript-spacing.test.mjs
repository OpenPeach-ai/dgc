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
const here = dirname(fileURLToPath(import.meta.url));
let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser, html, mainJs, markdownJs;
const skipReason = () => (!chromium ? "playwright is not installed" : !browser ? "Chromium could not start" : "");
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
  const drawn = (n) => { const r = box(n); return r.width > 0 && r.height > 0; };
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
    const wantAbove = b.steered ? BETWEEN_BLOCKS : ABOVE_PROMPT;
    if (b.above !== null) assert.ok(b.above >= wantAbove, `${label}: "${b.text}" is ${b.above}px below what precedes it, want ${wantAbove}px`);
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
      if (skipReason()) return t.skip(skipReason());
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
    if (skipReason()) return t.skip(skipReason());
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
    if (skipReason()) return t.skip(skipReason());
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
