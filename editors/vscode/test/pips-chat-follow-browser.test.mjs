// A Pip's chat moves as Work's does (reported on the 0.51.0 morning check), in real Chromium with the real client and CSS:
// away from the bottom, a send left your message and the reply off screen with no Latest control, and a long first message
// left the view high up. Sending brings your message into view, the reply is followed unless you scrolled away, the pill
// appears when new content is below, your message pins by Work's rule, and a long first message opens at its start.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import * as follow from "../src/pipsFollow.js";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed" : !browser ? "Chromium could not start" : "";
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

const bundled = await build({ entryPoints: [new URL("../src/pipsClient.js", import.meta.url).pathname], bundle: true, write: false,
  format: "iife", outdir: "out", platform: "browser", loader: { ".png": "dataurl", ".svg": "dataurl", ".webp": "dataurl" } });
const js = bundled.outputFiles.find((f) => f.path.endsWith(".js")).text;
const css = bundled.outputFiles.filter((f) => f.path.endsWith(".css")).map((f) => f.text).join("\n");
const PIP = "pip_" + "g".repeat(32);
const LONG = Array.from({ length: 40 }, (_, i) => `Point ${i + 1}: something worth knowing about your week, in a line of its own.`).join("\n\n");

const hostFor = (opts) => `(${function (PIP, LONG, opts) {
  const W = "ws_" + "p".repeat(32);
  const types = ["core", "scout", "lens", "patch", "rook", "pulse", "lock", "quill"].map((id, character_index) => ({ id, character_index, name: id, role: id,
    description: "Reads", available: true, unavailable_reason: null, default_name: id, default_goal: "Help",
    engine: id === "patch" ? "patch" : id === "pulse" ? "test" : id === "quill" ? "documentation_draft" : "source_audit" }));
  const pip = { id: PIP, workspace_id: W, pip_type: "lens", name: "Planner", goal: "Help.", source_policy: { mode: "personal" }, source_ref: "HEAD",
    status: "active", current_version: 1, lifecycle_revision: 0, policy: "read_only", trigger: "manual", schedule: null, proposals: [], pending_review_count: 0 };
  const controls = { version: 1, mode: "read_only", options: { context_size: 8192, thinking: "off" }, options_source: "last_message", inherited_context_size: 1048576,
    effective_context_size: 8192, context_min: 2048, context_max: 32768, thinking_levels: ["off", "low", "medium", "high", "xhigh"], reasoning_control: "provider_dependent", reasoning_note: "n", context_note: "n" };
  const at = (i) => new Date(Date.UTC(2026, 10, 7, 4, i)).toISOString();
  let seq = 0;
  const msg = (role, text, extra = {}) => ({ id: (role === "user" ? "u" : "a") + (++seq), pip_id: PIP, workspace_id: W, role, text, run_id: "run_" + String(seq).padStart(32, "0"), status: "succeeded", model: "m", created_at: at(seq), ...extra });
  window.__messages = (opts.start || []).map(([role, text, extra]) => {
    // [..., {same_run: true}]: this reply belongs to the hidden turn just before it.
    const made = msg(role, text === "LONG" ? LONG : text, extra?.intro ? { intro: true } : {});
    if (extra?.same_run) made.run_id = window.__lastRun;
    window.__lastRun = made.run_id;
    return made;
  });
  window.__active = null; window.__sent = [];
  window.__reply = (text) => { window.__messages.push(msg("assistant", text === "LONG" ? LONG : text)); window.__active = null; window.__pipPoll(); };
  const nativeInterval = window.setInterval.bind(window);
  window.setInterval = (fn, ms, ...args) => { if (ms === 4000) window.__pipPoll = fn; return nativeInterval(fn, ms, ...args); };
  const answers = {
    list_workspaces: () => ({ workspaces: [{ id: W, name: "Personal", kind: "personal" }], current_workspace_id: W }),
    list_pip_types: () => ({ types }), list_pip_setups: () => ({ setups: [] }), list_pip_starters: () => ({ starters: [] }),
    list_pips: () => ({ pips: [pip], total: 1, next_offset: null }),
    get_pip_runner: () => ({ runner: { runner_id: "r", status: "running", online: true, paused: false, counts: { queued: 0, running: 0, cancelling: 0 } } }),
    get_workspace_context: () => ({ context: { workspace_id: W, revision: 0, entries: [] } }),
    list_pip_models: () => ({ default_model: "m", models: [], connection: "configured" }),
    list_pip_messages: () => ({ pip_id: PIP, workspace_id: W, messages: window.__messages, next_before_id: null, active_run: window.__active, history_context_omitted_count: 0, chat_controls: controls }),
    list_pip_run_posts: () => ({ pip_id: PIP, workspace_id: W, posts: [], next_before_id: null }),
    list_pip_reply_stats: () => ({ pip_id: PIP, stats: [] }),
    list_pip_apps: () => ({ apps: [] }), get_pips_limit: () => ({ max_pips: 100, default: 100, maximum: 100000 }),
    get_pip: () => ({ pip }), list_pip_runs: () => ({ runs: [] }),
    get_pip_chat_stream: () => ({ run_id: window.__active?.id, cursor: 0, text: "", done: false, events: [] }),
    send_pip_message: (req) => { const sent = msg("user", req.text); window.__sent.push(req.text); window.__messages.push(sent); window.__active = { id: sent.run_id, pip_id: PIP, workspace_id: W, status: "running" }; return { message: sent, run: window.__active }; },
  };
  window.acquireVsCodeApi = () => ({ getState: () => undefined, setState() {}, postMessage(m) {
    if (m?.type !== "pipsRequest") return;
    const make = answers[m.request.type];
    if (!make) (window.__missing ||= new Set()).add(m.request.type);
    setTimeout(() => window.postMessage(make ? { type: "pipsReply", id: m.id, ok: true, result: make(m.request) }
      : { type: "pipsReply", id: m.id, ok: false, error: "not offered here" }, "*"), 1);
  } });
  setTimeout(() => window.postMessage({ type: "pipsConnection", apiVersion: 73, generation: 1, connected: true, supported: true, enabled: true }, "*"), 5);
}})(${JSON.stringify(PIP)}, ${JSON.stringify(LONG)}, ${JSON.stringify(opts)});`;
const theme = ":root{--vscode-editor-background:#181818;--vscode-foreground:#e2e2e2;--vscode-descriptionForeground:#a3a3a3;--vscode-input-background:#242424;--vscode-font-family:sans-serif}";

async function open(opts = {}) {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${theme}${css}</style></head><body><main id="app"></main><div id="review-root"></div>`
    + `<script>${hostFor(opts)}</script><script>${js.replace(/<\/script/g, "<\\/script")}</script></body></html>`;
  const context = await browser.newContext({ viewport: { width: opts.width || 320, height: opts.height || 800 }, reducedMotion: "reduce" });
  const p = await context.newPage();
  const errors = [];
  p.on("pageerror", (error) => errors.push(String(error)));
  await p.route("https://pips.test/**", (r) => r.fulfill({ body: html, contentType: "text/html" }));
  await p.goto("https://pips.test/view");
  await p.waitForSelector(`[data-job="${PIP}"]`);
  await p.click(`[data-job="${PIP}"]`);
  await p.waitForSelector("#chatText");
  await p.waitForTimeout(60);
  if (process.env.DGC_MISSING) console.error(await p.evaluate(() => [...(window.__missing || [])]));
  return { p, errors, close: () => context.close() };
}
const view = (p) => p.evaluate(() => {
  const log = document.querySelector(".conversation-log"), box = log.getBoundingClientRect(), pill = document.querySelector("#pip-to-latest");
  const inView = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.top >= box.top - 1 && r.top < box.bottom; };
  const users = [...log.querySelectorAll(".pip-message.user")], last = users.at(-1), replies = log.querySelectorAll(".pip-message.assistant");
  const reply = replies[replies.length - 1];
  return { top: log.scrollTop, max: log.scrollHeight - log.clientHeight, atEnd: log.scrollHeight - log.scrollTop - log.clientHeight < 2,
    pill: pill && !pill.hidden ? pill.textContent.trim() : "", unread: !!pill?.classList.contains("unread"),
    lastUserInView: inView(last?.querySelector(".bubble")), replyEndInView: reply ? reply.getBoundingClientRect().bottom <= box.bottom + 1 : false,
    pinned: last ? getComputedStyle(last).position : "", pinOff: !!last?.classList.contains("pin-off"), logHeight: log.clientHeight };
});
const send = async (p, words) => { await p.fill("#chatText", words); await p.press("#chatText", "Enter"); await p.waitForFunction((w) => window.__sent.at(-1) === w, words); await p.waitForTimeout(40); };
const wheelUp = async (p) => {
  const box = await p.locator(".conversation-log").boundingBox();
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const start = await p.evaluate(() => document.querySelector(".conversation-log").scrollTop);
  await p.mouse.wheel(0, -600);
  // Until the wheel has landed and the view holds still, however busy the machine is.
  await p.waitForFunction((from) => document.querySelector(".conversation-log").scrollTop < from - 100, start);
  let last = -1, top = await p.evaluate(() => document.querySelector(".conversation-log").scrollTop);
  while (top !== last) { last = top; await p.waitForTimeout(80); top = await p.evaluate(() => document.querySelector(".conversation-log").scrollTop); }
};
const CHAT = [["assistant", "Hi, I'm Planner."], ["user", "Plan my week"], ["assistant", "LONG"], ["user", "And the next one?"], ["assistant", "LONG"]];

test("the rules are Work's: the same numbers as media/main.js, and the same words on the pill", () => {
  const main = readFileSync(new URL("../media/main.js", import.meta.url), "utf8");
  const number = (name) => Number(new RegExp(`const ${name} = ([0-9.]+);`).exec(main)?.[1]);
  for (const name of ["PIN_GROUND_PX", "PIN_FADE_PX", "PIN_SHARE", "PIN_LOG_SHARE", "PIN_JUMP_DELAY_MS"]) assert.equal(follow[name], number(name), name);
  assert.match(main, /function atBottom\(\) \{ return log\.scrollHeight - log\.scrollTop - log\.clientHeight < 60; \}/);
  assert.equal(follow.AT_BOTTOM_PX, 60);
  assert.match(main, /function atEnd\(\) \{ return log\.scrollHeight - log\.scrollTop - log\.clientHeight < 2; \}/);
  assert.equal(follow.AT_END_PX, 2);
  assert.match(main, /if \(Date\.now\(\) - userScrolledAt < 700\) following = up \? false : atEnd\(\) \|\| \(following && atBottom\(\)\);/);
  assert.equal(follow.GESTURE_MS, 700);
  assert.match(main, /away && unread \? "New" : "Latest"/);
});

test("scrolled up, a send brings your message into view and the reply is followed", async (t) => {
  if (skipOrFail(t)) return;
  const { p, errors, close } = await open({ start: CHAT });
  try {
    assert.equal((await view(p)).atEnd, true, "an ongoing chat opens at its end");
    await wheelUp(p);
    const up = await view(p);
    assert.equal(up.atEnd, false);
    assert.equal(up.pill, "Latest", "away from the end, the pill offers it");
    await send(p, "And after that?");
    const sent = await view(p);
    assert.equal(sent.lastUserInView, true, `your message is in view: ${JSON.stringify(sent)}`);
    assert.equal(sent.atEnd, true);
    assert.equal(sent.pill, "");
    await p.evaluate(() => window.__reply("LONG"));
    await p.waitForFunction(() => document.querySelectorAll(".conversation-log .pip-message.assistant").length === 3);
    await p.waitForTimeout(80);
    const after = await view(p);
    assert.equal(after.atEnd, true, "the reply is followed to its end");
    assert.equal(after.replyEndInView, true);
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("a reader who scrolled away is left there: the pill says New when more arrives, and takes them to the end", async (t) => {
  if (skipOrFail(t)) return;
  const { p, errors, close } = await open({ start: CHAT });
  try {
    await send(p, "And after that?");
    await wheelUp(p);
    const before = await view(p);
    assert.equal(before.atEnd, false);
    await p.evaluate(() => window.__reply("LONG"));
    await p.waitForFunction(() => document.querySelectorAll(".conversation-log .pip-message.assistant").length === 3);
    await p.waitForTimeout(80);
    const after = await view(p);
    assert.equal(after.top, before.top, "the reply didn't take them away from what they read");
    assert.equal(after.pill, "New");
    assert.equal(after.unread, true);
    await p.click("#pip-to-latest");
    await p.waitForTimeout(40);
    const back = await view(p);
    assert.equal(back.atEnd, true);
    assert.equal(back.pill, "");
    assert.equal(await p.evaluate(() => document.activeElement?.id), "chatText", "the keyboard goes back to the box, as in Work");
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("the model menu opens over the Latest pill, so its last rows can be read and clicked", async (t) => {
  if (skipOrFail(t)) return;
  const { p, errors, close } = await open({ start: CHAT });
  try {
    await send(p, "And after that?");
    await wheelUp(p);
    assert.notEqual((await view(p)).pill, "", "the pill is showing");
    const box = await p.locator("#pip-to-latest").boundingBox();
    await p.click("#chat-model");
    await p.waitForFunction(() => { const m = document.querySelector(".composer-menu, .composer-model-menu, [data-composer-panel]"); return m && m.getBoundingClientRect().height > 0; });
    const onTop = await p.evaluate(({ x, y }) => {
      const hit = document.elementFromPoint(x, y);
      const menu = document.querySelector(".composer-menu, .composer-model-menu, [data-composer-panel]");
      return { pill: !!hit?.closest("#pip-to-latest"), menuBottom: menu.getBoundingClientRect().bottom, menuTop: menu.getBoundingClientRect().top };
    }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
    if (onTop.menuTop <= box.y && box.y <= onTop.menuBottom) assert.equal(onTop.pill, false, `the pill paints over the menu: ${JSON.stringify(onTop)}`);
    const stacks = await p.evaluate(() => [getComputedStyle(document.querySelector("#pip-to-latest")).zIndex, getComputedStyle(document.querySelector(".pip-composer")).zIndex].map(Number));
    assert.ok(stacks[0] < stacks[1], `the box and its menus stack above the pill: ${stacks}`);
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("a Pip that opens with a long first message opens at its start, and your answer lands in view", async (t) => {
  if (skipOrFail(t)) return;
  const { p, errors, close } = await open({ start: [["assistant", "LONG"]] });
  try {
    const opened = await p.evaluate(() => {
      const log = document.querySelector(".conversation-log"), first = log.querySelector(".pip-message.assistant .message-body");
      return { lineAtTop: first.getBoundingClientRect().top - log.getBoundingClientRect().top, top: log.scrollTop };
    });
    assert.ok(opened.lineAtTop >= 0 && opened.lineAtTop < 60, `its first line is at the top of the view: ${JSON.stringify(opened)}`);
    assert.equal((await view(p)).pill, "Latest", "the rest is below, and the pill says so");
    await send(p, "Thanks, start with Monday");
    const sent = await view(p);
    assert.equal(sent.lastUserInView, true, `the answer is in view: ${JSON.stringify(sent)}`);
    assert.equal(sent.atEnd, true);
    await p.evaluate(() => window.__reply("Monday it is."));
    await p.waitForFunction(() => document.querySelectorAll(".conversation-log .pip-message.assistant").length === 2);
    await p.waitForTimeout(80);
    const after = await view(p);
    assert.equal(after.replyEndInView, true, `the reply is in view: ${JSON.stringify(after)}`);
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("a short first message that fits needs no scrolling and no pill", async (t) => {
  if (skipOrFail(t)) return;
  const { p, close } = await open({ start: [["assistant", "Hi, I'm Planner. What's first?"]] });
  try {
    const v = await view(p);
    assert.equal(v.top, 0);
    assert.equal(v.pill, "");
  } finally { await close(); }
});

test("your message pins while you read its answer, the next one pushes it off, and one too tall for the view doesn't pin", async (t) => {
  if (skipOrFail(t)) return;
  const { p, errors, close } = await open({ start: CHAT });
  try {
    await p.waitForTimeout(60);
    const pin = await p.evaluate(() => {
      const log = document.querySelector(".conversation-log"), box = log.getBoundingClientRect(), heads = [...log.querySelectorAll(".pip-message.user")];
      const rest = box.top + parseFloat(getComputedStyle(log).paddingTop);
      return { last: heads.at(-1).getBoundingClientRect().top - rest, earlier: heads[0].getBoundingClientRect().bottom - box.top };
    });
    assert.ok(Math.abs(pin.last) <= 1, `the latest prompt rests at the top: ${JSON.stringify(pin)}`);
    assert.ok(pin.earlier <= 0, `the earlier prompt was pushed off: ${JSON.stringify(pin)}`);
    await send(p, Array.from({ length: 30 }, (_, i) => `A long line of my prompt, number ${i + 1}.`).join("\n"));
    await p.waitForTimeout(120);
    const tall = await view(p);
    assert.equal(tall.pinOff, true, "taller than the rule allows: read in place");
    assert.equal(tall.pinned, "relative");
    // A redraw draws the row afresh: the decision stays.
    await p.evaluate(() => window.__reply("A short answer."));
    await p.waitForFunction(() => document.querySelectorAll(".conversation-log .pip-message.assistant").length === 3);
    await p.waitForTimeout(80);
    assert.equal((await view(p)).pinOff, true);
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("the boxes change no spacing: one message to the next is the same inside a turn and across turns", async (t) => {
  if (skipOrFail(t)) return;
  const { p, close } = await open({ start: CHAT });
  try {
    const gaps = await p.evaluate(() => { const unpin = document.createElement("style"); unpin.textContent = ".pip-turn>.pip-message.user{position:static!important}"; document.head.append(unpin);   // where each is laid out
      const all = [...document.querySelectorAll(".conversation-log .pip-message")]; return all.map((m, i) => {
      const next = all[i + 1];
      return next ? [m.className.includes("user") ? "user" : "reply", next.className.includes("user") ? "user" : "reply", Math.round(next.getBoundingClientRect().top - m.getBoundingClientRect().bottom)] : null; }).filter(Boolean); });
    // A reply's bottom margin (20) and the next prompt's top margin (7) meet as one, as they did before the boxes (27 if they don't).
    for (const [from, to, gap] of gaps) if (from === "reply" && to === "user") assert.equal(gap, 20, JSON.stringify(gaps));
    assert.ok(gaps.some(([from, to]) => from === "reply" && to === "user"));
  } finally { await close(); }
});

test("a routine's reply isn't an answer to the last prompt: the pin ends where it starts", async (t) => {
  if (skipOrFail(t)) return;
  const due = 'This message is from DGC, not the user. Your routine "Morning brief" is due (2026-11-07 08:00). Do it now: say the news.';
  const { p, close } = await open({ start: [["user", "Plan my week"], ["assistant", "LONG"], ["user", due, { intro: true }], ["assistant", "LONG", { same_run: true }]] });
  try {
    await p.waitForTimeout(60);
    const seen = await p.evaluate(() => {
      const log = document.querySelector(".conversation-log"), replies = [...log.querySelectorAll(".pip-message.assistant")], head = log.querySelector(".pip-message.user");
      return { inBox: !!replies.at(-1).closest(".pip-turn"), answerInBox: !!replies[0].closest(".pip-turn"), boxEndsAbove: head.closest(".pip-turn").getBoundingClientRect().bottom <= replies.at(-1).getBoundingClientRect().top };
    });
    assert.equal(seen.answerInBox, true, "its answer is in the prompt's box");
    assert.equal(seen.inBox, false, "the routine's reply isn't");
    assert.equal(seen.boxEndsAbove, true, "so the prompt can pin no further than its own answer");
  } finally { await close(); }
});

test("a short window: the strip takes at most 40% of the transcript, Work's PIN_LOG_SHARE", async (t) => {
  if (skipOrFail(t)) return;
  const { p, close } = await open({ start: CHAT, height: 420 });
  try {
    await send(p, Array.from({ length: 5 }, (_, i) => `Line ${i + 1} of a prompt.`).join("\n"));
    await p.waitForTimeout(120);
    const fit = await p.evaluate(() => {
      const log = document.querySelector(".conversation-log"), last = [...log.querySelectorAll(".pip-message.user")].at(-1);
      return { head: last.getBoundingClientRect().height, log: log.clientHeight, off: last.classList.contains("pin-off") };
    });
    assert.equal(fit.off, fit.head + follow.PIN_GROUND_PX > Math.min(420 * follow.PIN_SHARE, fit.log * follow.PIN_LOG_SHARE), JSON.stringify(fit));
  } finally { await close(); }
});

test("a click on a pinned prompt goes back to where it was sent, and following stops", async (t) => {
  if (skipOrFail(t)) return;
  const { p, close } = await open({ start: CHAT });
  try {
    await p.waitForTimeout(60);
    await p.locator(".pip-turn:last-of-type > .pip-message.user .bubble").click();
    await p.waitForTimeout(follow.PIN_JUMP_DELAY_MS + 80);
    const back = await p.evaluate(() => {
      const log = document.querySelector(".conversation-log"), heads = [...log.querySelectorAll(".pip-message.user")], turn = heads.at(-1).parentElement;
      const answer = turn.querySelector(".pip-message.assistant .message-body");
      return { answerBelowPrompt: answer.getBoundingClientRect().top >= heads.at(-1).getBoundingClientRect().bottom - 1, atEnd: log.scrollHeight - log.scrollTop - log.clientHeight < 2 };
    });
    assert.equal(back.answerBelowPrompt, true, "the answer starts right under the prompt");
    assert.equal(back.atEnd, false);
    assert.equal((await view(p)).pill, "Latest");
  } finally { await close(); }
});
