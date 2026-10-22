// The Work chat's prompt rail (the founder, 2026-10-18: Work chats get the rail ChatDGC has), in real Chromium: the
// shared module (media/promptrail.js) over the real panel. From five prompts a tick per prompt in the log's right
// padding, the one being read bright; a card on hover with every prompt and its time; a click, Alt+Up/Down and the
// card's keys go there. A session opens on its latest pages: the rest of its prompts come from its outline
// (get_outline), and going to one loads the pages before it first, the archive's too. An older CLI lists what is on
// screen. After a reload or a reattach (a history snapshot again) the rail reads the new snapshot and outline.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { THEMES, panelHtml } from "./support/options-scene.mjs";

const msgTimeJs = readFileSync(fileURLToPath(new URL("../media/msgtime.js", import.meta.url)), "utf8");
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

const PROSE = (n) => `Answer ${n}. ` + "The bounds hold across every page of the transcript, and the parser reads them back. ".repeat(12);
const NOW = Math.floor(Date.now() / 1000);
const AT = (n, count) => NOW - (count - n) * 2 * 3600;       // two hours apart: the earliest are yesterday's
const PROMPT = (n) => `Prompt ${n}: ${"check the flat's lease ".repeat(1 + (n % 3))}`.trim();
// A saved turn as the history snapshot carries it: its prompt, when it was sent, its answer.
const turn = (n, count, id = `h${n}`) => [
  { type: "turn_start", turn_id: id, prompt: PROMPT(n), kind: "prompt" },
  { role: "time", of: "prompt", at: AT(n, count) },
  { type: "text_delta", text: PROSE(n) },
  { type: "stream_end", message_id: `${id}:1`, phase: "answer" },
  { type: "turn_end", turn_id: id, reason: "completed", token_estimate: 0, final_message_id: `${id}:1` },
];
const history = (count, from = 1) => Array.from({ length: count - from + 1 }, (_, k) => turn(from + k, count)).flat();
const outlineOf = (count, { archived = [], from = 1 } = {}) => [
  ...archived.map((text, n) => ({ id: `a${n}`, text, archived: true })),
  ...Array.from({ length: count - from + 1 }, (_, k) => ({ id: `h${from + k}`, text: PROMPT(from + k), at: AT(from + k, count) })),
];

async function openPage({ width = 460, height = 760, theme = "dark-modern", reducedMotion = false, outline = true } = {}) {
  const { html, mainJs, markdownJs } = panelHtml();
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: reducedMotion ? "reduce" : "no-preference" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.setContent(html, { waitUntil: "load" });
  await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; --vscode-editor-font-family: ui-monospace, monospace; ${THEMES[theme]} }` });
  await page.evaluate((t) => document.body.classList.add(t.startsWith("light") ? "vscode-light" : "vscode-dark"), theme);
  await page.evaluate(([mjs, mdjs, tjs]) => {
    window.__posted = [];
    window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState: () => undefined, setState() {} });
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(tjs);                                    // the panel loads msgtime.js first: each prompt's time
    eval(mjs);
    const log = document.getElementById("log");
    window.__rail = {
      log,
      frames: (n = 2) => new Promise((done) => { const f = () => (--n <= 0 ? done() : requestAnimationFrame(f)); requestAnimationFrame(f); }),
      heads: () => [...log.querySelectorAll(".turn > .msg.user.turn-head")],
      laidOut: (head) => head.parentElement.getBoundingClientRect().top + parseFloat(getComputedStyle(head).marginTop || 0),
      rest: () => log.getBoundingClientRect().top + parseFloat(getComputedStyle(log).paddingTop),
      head: (text) => [...log.querySelectorAll(".turn > .msg.user.turn-head")].find((h) => h.querySelector(".prompt-text")?.textContent === text),
      state: () => {
        const rail = document.getElementById("prompt-rail"), ticks = rail ? [...rail.querySelectorAll(".prompt-tick")] : [];
        return { shown: !!rail && !rail.hidden && rail.getClientRects().length > 0, ticks: ticks.length, now: ticks.findIndex((t) => t.classList.contains("now")) };
      },
    };
  }, [mainJs, markdownJs, msgTimeJs]);
  const send = (data) => page.evaluate((d) => window.dispatchEvent(new MessageEvent("message", { data: d })), data);
  const events = async (list) => { for (const event of list) await send({ type: "event", event }); };
  const ready = () => events([{ type: "ready", capabilities: { history_snapshot: true, ...(outline ? { outline: 1 } : {}) },
    model: "qwen3.8:27b", mode: "default", think: "off", commands: [], custom_commands: [], goal: { text: "", status: "none" },
    context_size: 65536, session_id: "s1" }]);
  await send({ type: "session_ready", sessionId: "s1" });
  await ready();
  const settle = (ms = 200) => page.evaluate((wait) => new Promise((done) =>
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, wait)))), ms);
  const state = () => page.evaluate(() => window.__rail.state());
  const posted = (type) => page.evaluate((t) => window.__posted.filter((m) => m.type === t), type);
  const hover = async () => { const b = await page.locator("#prompt-rail").boundingBox(); await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); };
  // Where prompt `text`'s own place is, against where a prompt gone to rests (0: there).
  const offset = (text) => page.evaluate((x) => { const R = window.__rail, h = R.head(x); return h ? R.laidOut(h) - R.rest() : null; }, text);
  return { page, send, events, ready, settle, state, posted, hover, offset, errors };
}

test("the Work chat's rail: from five prompts a tick each in the transcript's right padding, the one being read bright; hover lists every prompt with its time; a click, Alt+Up/Down and the card's keys go there", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openPage({ width: 460 });
  try {
    await s.events([{ type: "history", items: history(4) }]);
    await s.settle();
    assert.equal((await s.state()).shown, false, "four prompts: no rail");
    // A fifth, sent here.
    await s.events([{ type: "turn_start", turn_id: "t1", prompt: PROMPT(5), kind: "prompt" }, { type: "text_delta", text: PROSE(5) },
      { type: "stream_end", message_id: "t1:1", phase: "answer" }, { type: "turn_end", turn_id: "t1", reason: "completed", token_estimate: 0, final_message_id: "t1:1" }]);
    await s.settle();
    assert.deepEqual(await s.state(), { shown: true, ticks: 5, now: 4 }, "the fifth prompt brings it, the newest bright at the end");
    // A session of 23.
    await s.events([{ type: "session", kind: "resumed", message_count: 46, session_id: "s1" }, { type: "history", items: history(23) }]);
    await s.send({ type: "event", event: { type: "outline", request_id: `outline-${(await s.posted("getOutline")).at(-1).token}`, session_id: "s1", prompts: outlineOf(23) } });
    await s.settle();
    // Only its latest pages are on screen; the outline lists the rest.
    assert.ok(await s.page.evaluate(() => window.__rail.heads().length) < 23, "opened on its latest pages");
    assert.equal((await s.state()).ticks, 23);
    // Where it sits: in the log's right padding, left of its scroll bar, clear of every bubble and line; centred.
    const box = await s.page.evaluate(() => {
      const R = window.__rail, rail = document.getElementById("prompt-rail").getBoundingClientRect(), log = R.log.getBoundingClientRect();
      const gutter = R.log.offsetWidth - R.log.clientWidth, pad = parseFloat(getComputedStyle(R.log).paddingRight);
      const words = [...R.log.querySelectorAll(".bubble, .msg.dgc .text")].map((n) => n.getBoundingClientRect()).filter((r) => r.width > 0);
      const tick = document.querySelector("#prompt-rail .prompt-tick").getBoundingClientRect();
      return { left: rail.left, right: rail.right, edge: log.right - gutter, content: log.right - gutter - pad, words: Math.max(...words.map((r) => r.right)),
               middle: rail.top + rail.height / 2, logMiddle: log.top + log.height / 2, tick: [tick.width, tick.height],
               z: getComputedStyle(document.getElementById("prompt-rail")).zIndex };
    });
    assert.ok(box.right <= box.edge && box.left >= box.content - 0.5, `inside the right padding (${box.left}..${box.right} in ${box.content}..${box.edge})`);
    assert.ok(box.words <= box.left + 0.5, "clear of the words");
    assert.ok(Math.abs(box.middle - box.logMiddle) <= 2, "centred on the transcript");
    assert.deepEqual(box.tick, [10, 2], "the short ticks");
    assert.equal(box.z, "15", "under the message box's menus and the panels that cover the chat");
    // The one being read is bright: the second of the prompts on screen, with its answer under it.
    const second = await s.page.evaluate(async () => {
      const R = window.__rail, head = R.heads()[1];
      R.log.dispatchEvent(new WheelEvent("wheel")); R.log.scrollTop += R.laidOut(head) - R.rest() + 20; await R.frames(3);
      return head.querySelector(".prompt-text").textContent;
    });
    const at = Number(/^Prompt (\d+)/.exec(second)[1]) - 1;
    assert.equal((await s.state()).now, at);
    // Hover: every prompt with its time under day headings, the one being read marked.
    await s.hover();
    const card = s.page.locator("#prompt-rail-card");
    await card.waitFor({ state: "visible" });
    assert.equal(await s.page.locator("#prompt-rail").getAttribute("aria-expanded"), "true");
    assert.match(await card.locator(".prompt-rail-head").innerText(), /^23 prompts/);
    assert.equal(await card.locator(".prompt-rail-row").count(), 23);
    const days = (await card.locator(".prompt-rail-day").allInnerTexts()).map((d) => d.toLowerCase());
    assert.ok(days.length >= 2 && days.at(-1) === "today", `day headings (${days})`);
    assert.equal(await card.locator(".prompt-rail-row.now").getAttribute("data-i"), String(at));
    assert.match(await card.locator(".prompt-rail-row").nth(0).locator(".prompt-rail-time").innerText(), /^\d{1,2}:\d{2}/, "a prompt not on screen has its time too");
    assert.equal(await card.locator(".prompt-rail-row").nth(at).locator(".prompt-rail-text").innerText(), second);
    const c = await card.boundingBox();
    assert.ok(c.x >= 0 && c.x + c.width <= 460, "inside the panel");
    // A click on one on screen: the card closes, the view eases to it, outlined for a moment.
    const target = at + 2;
    await card.locator(".prompt-rail-row").nth(target).click();
    assert.equal(await card.isHidden(), true);
    await s.page.waitForTimeout(500);
    const off = await s.offset(PROMPT(target + 1));
    assert.ok(off !== null && Math.abs(off) <= 2, `there, where a pinned prompt rests (${off})`);
    assert.equal(await s.page.evaluate((x) => window.__rail.head(x).querySelector(".bubble").classList.contains("prompt-flash"), PROMPT(target + 1)), true);
    assert.equal((await s.state()).now, target, "and its tick is the bright one");
    // Alt+Down and Alt+Up from the message box.
    await s.page.locator("#input").focus();
    await s.page.keyboard.press("Alt+ArrowDown");
    await s.page.waitForTimeout(500);
    assert.equal((await s.state()).now, target + 1);
    assert.ok(Math.abs(await s.offset(PROMPT(target + 2))) <= 2);
    await s.page.keyboard.press("Alt+ArrowUp");
    await s.page.waitForTimeout(500);
    assert.equal((await s.state()).now, target);
    assert.equal(await s.page.evaluate(() => document.getElementById("input").value), "", "nothing typed into the box");
    // The keys: on the rail, Down goes into the list at the one being read; Enter goes there; Esc closes it.
    await s.page.locator("#prompt-rail").focus();
    await s.page.keyboard.press("ArrowDown");
    assert.equal(await s.page.evaluate(() => document.activeElement?.dataset.i), String(target), "into the list, at the one being read");
    await s.page.keyboard.press("ArrowDown");
    await s.page.keyboard.press("Enter");
    await s.page.waitForTimeout(500);
    assert.equal((await s.state()).now, target + 1);
    await s.page.locator("#prompt-rail").focus();
    await s.page.keyboard.press("ArrowDown");
    await s.page.keyboard.press("Escape");
    assert.equal(await card.isHidden(), true);
    assert.equal(await s.page.evaluate(() => document.activeElement?.id), "prompt-rail");
    assert.match(await s.page.locator("#prompt-rail").getAttribute("aria-label"), /^Prompts in this chat: 23\./);
    assert.equal(await s.page.evaluate(() => document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth), 0, "no sideways scroll");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("a long session opened on its latest pages: every prompt from its outline, and going to an early one loads the pages before it, the archive's too", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openPage({ width: 460 });
  try {
    // A long session: its snapshot holds turns 6..30 (the oldest five were left out of it), and compaction archived two.
    await s.events([{ type: "history", items: [{ role: "notice", text: "Showing the most recent saved context. Earlier messages remain in the session file." }, ...history(30, 6)] }]);
    await s.settle();
    const asked = await s.posted("getOutline");
    assert.equal(asked.length, 1, "the outline is asked for once the snapshot is drawn");
    const onScreen = await s.page.evaluate(() => window.__rail.heads().length);
    assert.deepEqual(await s.state(), { shown: true, ticks: onScreen, now: onScreen - 1 }, "what's on screen, until the outline comes");
    await s.hover();
    assert.match(await s.page.locator("#prompt-rail-card .prompt-rail-more").innerText(), /Earlier messages aren't listed yet/);
    await s.page.mouse.move(40, 40);
    await s.page.waitForTimeout(260);
    // An answer to an older ask is not this one.
    await s.events([{ type: "outline", request_id: "outline-0", session_id: "s1", prompts: outlineOf(3) }]);
    await s.settle();
    assert.equal((await s.state()).ticks, onScreen, "a stale outline is dropped");
    await s.events([{ type: "outline", request_id: `outline-${asked[0].token}`, session_id: "s1",
                      prompts: outlineOf(30, { archived: ["Set up the repo", "Add the parser"] }) }]);
    await s.settle();
    // The archive's two, and 6..30; 1..5 are not in what this window holds, so they are not offered.
    assert.deepEqual(await s.state(), { shown: true, ticks: 27, now: 26 });
    await s.hover();
    const card = s.page.locator("#prompt-rail-card");
    assert.equal(await card.locator(".prompt-rail-row").count(), 27);
    assert.equal(await card.locator(".prompt-rail-more").count(), 0);
    assert.deepEqual((await card.locator(".prompt-rail-text").allInnerTexts()).slice(0, 3), ["Set up the repo", "Add the parser", PROMPT(6)]);
    // To prompt 8, on a page not drawn yet: the pages before what's shown are drawn first, then the view goes there.
    await card.locator(".prompt-rail-row").nth(4).click();
    await s.page.waitForTimeout(500);
    let off = await s.offset(PROMPT(8));
    assert.ok(off !== null && Math.abs(off) <= 2, `there (${off})`);
    assert.equal((await s.state()).now, 4);
    // To the archive's first: every page drawn, then the archive asked for, and the view goes there when it comes.
    await s.page.keyboard.press("Alt+ArrowUp");      // prompt 7
    await s.page.waitForTimeout(450);
    await s.hover();
    await card.locator(".prompt-rail-row").nth(0).click();
    await s.settle();
    const recall = await s.posted("getRecall");
    assert.equal(recall.length, 1, "the archive's newest page asked for");
    await s.events([{ type: "recall", items: [{ role: "user", text: "Set up the repo", archived: true }, { role: "assistant", text: PROSE(-1), archived: true },
                                              { role: "user", text: "Add the parser", archived: true }, { role: "assistant", text: PROSE(-2), archived: true }],
                      before: 0, more: false, total: 4 }]);
    await s.page.waitForTimeout(500);
    off = await s.page.evaluate(() => { const R = window.__rail, h = R.heads()[0]; return R.laidOut(h) - R.rest(); });
    assert.ok(Math.abs(off) <= 2, `the archive's first prompt, there (${off})`);
    assert.equal(await s.page.evaluate(() => window.__rail.heads()[0].querySelector(".prompt-text").textContent), "Set up the repo");
    assert.deepEqual(await s.state(), { shown: true, ticks: 27, now: 0 }, "the same 27, the first bright");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("an older CLI: no outline asked for; the rail lists the prompts on screen and its card loads the earlier messages", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openPage({ width: 460, outline: false });
  try {
    await s.events([{ type: "history", items: history(30) }]);
    await s.settle();
    assert.equal((await s.posted("getOutline")).length, 0, "never asked of a CLI that doesn't offer it");
    const onScreen = await s.page.evaluate(() => window.__rail.heads().length);
    assert.equal((await s.state()).ticks, onScreen);
    await s.hover();
    await s.page.locator("#prompt-rail-card .prompt-rail-more").click();
    await s.settle();
    const more = await s.page.evaluate(() => window.__rail.heads().length);
    assert.ok(more > onScreen, "the page before was drawn");
    assert.equal((await s.state()).ticks, more, "and its prompts are on the rail");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("after a reload or a reattach the rail reads the new snapshot: a prompt sent since is on it, and a new session starts it again", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openPage({ width: 460 });
  try {
    await s.events([{ type: "history", items: history(12) }]);
    await s.events([{ type: "outline", request_id: "outline-1", session_id: "s1", prompts: outlineOf(12) }]);
    await s.settle();
    assert.deepEqual(await s.state(), { shown: true, ticks: 12, now: 11 });
    // A turn sent here, still running.
    await s.events([{ type: "turn_start", turn_id: "t1", prompt: PROMPT(13), kind: "prompt" }, { type: "text_delta", text: PROSE(13) }]);
    await s.settle();
    assert.deepEqual(await s.state(), { shown: true, ticks: 13, now: 12 }, "the prompt just sent, at the end");
    // A new session: no prompts, no rail.
    await s.events([{ type: "session", kind: "new", message_count: 0, session_id: "s2" }]);
    await s.settle();
    assert.equal((await s.state()).shown, false);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
  // The window reloads: a fresh page, the backend's ready again, its running turn, then its snapshot with that turn
  // under its own id, as a reattach repaints.
  const r = await openPage({ width: 460 });
  try {
    await r.send({ type: "turn_active", id: "t1", history: true });
    await r.events([{ type: "history", items: [...history(12), { type: "turn_start", turn_id: "t1", prompt: PROMPT(13), kind: "prompt" },
                                             { type: "text_delta", text: PROSE(13) }] }]);
    const asked = await r.posted("getOutline");
    assert.equal(asked.length, 1);
    await r.settle();
    const shown = await r.page.evaluate(() => window.__rail.heads().length);
    assert.equal((await r.state()).ticks, shown, "what's on screen until the outline comes");
    // The backend's outline names the running turn by its own id: listed once.
    await r.events([{ type: "outline", request_id: `outline-${asked[0].token}`, session_id: "s1",
                      prompts: [...outlineOf(12), { id: "t1", text: PROMPT(13), at: NOW }] }]);
    await r.settle();
    assert.deepEqual(await r.state(), { shown: true, ticks: 13, now: 12 });
    await r.hover();
    assert.equal(await r.page.locator("#prompt-rail-card .prompt-rail-row").count(), 13, "each prompt once");
    // The turn goes on and ends here; another prompt is sent: on the rail at once.
    await r.events([{ type: "stream_end", message_id: "t1:1", phase: "answer" },
      { type: "turn_end", turn_id: "t1", reason: "completed", token_estimate: 0, final_message_id: "t1:1" },
      { type: "turn_start", turn_id: "t2", prompt: PROMPT(14), kind: "prompt" }]);
    await r.settle();
    assert.equal((await r.state()).ticks, 14);
    assert.deepEqual(r.errors, []);
  } finally { await r.page.close(); }
});

test("the rail stays with this chat's own transcript: hidden while Pips or an agent's page is shown, back after; at once for less motion", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openPage({ width: 320, reducedMotion: true });
  try {
    await s.events([{ type: "history", items: history(8) }, { type: "outline", request_id: "outline-1", session_id: "s1", prompts: outlineOf(8) }]);
    await s.settle();
    assert.equal((await s.state()).shown, true);
    for (const [on, off] of [["document.body.classList.add('pips-active')", "document.body.classList.remove('pips-active')"],
                             ["document.body.setAttribute('data-agent-page', '')", "document.body.removeAttribute('data-agent-page')"]]) {
      await s.page.evaluate(on);
      await s.settle();
      assert.equal((await s.state()).shown, false, on);
      await s.page.evaluate(off);
      await s.settle();
      assert.equal((await s.state()).shown, true, off);
    }
    // Less motion: a jump is there at once.
    await s.page.locator("#input").focus();
    await s.page.keyboard.press("Alt+ArrowUp");
    await s.settle(50);
    const first = (await s.state()).now;
    for (let i = 0; i < 2; i++) await s.page.keyboard.press("Alt+ArrowUp");
    await s.settle(50);
    const off = await s.offset(PROMPT(first - 1));
    assert.ok(off !== null && Math.abs(off) <= 2, `two prompts up, there without easing (${off})`);
    assert.equal((await s.state()).now, first - 2);
    assert.equal(await s.page.evaluate(() => document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth), 0);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});
