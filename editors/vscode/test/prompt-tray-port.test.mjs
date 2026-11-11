// The bar for what is going on (the tray, media/shared/tray.js and tray.css) in ChatDGC and in a Pip's chat, measured
// in real Chromium on each one's real page. It is the same bar as Work's (prompt-tray-layout.test.mjs), under the same
// rules: ONE line at ONE height, whatever the width (220, 300, 700, 1200 px) and however many kinds show; narrow, the
// pills are icons with counts; what does not fit goes behind "+N", which lists the rest, each row opening its own
// detail; one kind alone is the same line, said in full; a pill opens its detail in a popover just above, by keyboard
// too, and Esc puts the focus back on the pill; nothing going on means no bar; the box never moves; and the shell's
// sides run straight from the bar into the ring round the box (read from the pixels), with the box itself never
// covered, not even while a popover is open.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { contrastRatio } from "./support/webview-dom.mjs";
import { M, conversation, openChat } from "./support/chat-scene.mjs";
import * as pips from "./support/pip-chat-scene.mjs";
import { openRailScene } from "./support/rail-scene.mjs";

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

const TRAY = 36;   // --tray: the bar's one height
const settle = (page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 80)))));

// What the bar is on screen, wherever it is (a Pip's chat in the side bar lives in a shadow root).
const bar = (page, ids) => page.evaluate(({ line: lineId, box: boxSel, log: logSel }) => {
  const root = window.__pipsRoot || document;
  const rect = (node) => node.getBoundingClientRect();
  const shown = (node) => !!node && node.checkVisibility() && rect(node).width > 0;
  const line = root.querySelector(`#${lineId}`), boxNode = root.querySelector(boxSel), box = rect(boxNode);
  const chips = line.querySelector(".rail-chips"), more = line.querySelector(".rail-more"), pop = line.querySelector(".rail-pop");
  const pills = [...chips.children].filter(shown).map((pill) => {
    const r = rect(pill);
    return { kind: pill.dataset.kind, top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height,
      cut: pill.scrollWidth > pill.clientWidth + 1, label: pill.getAttribute("aria-label") || "",
      words: [...pill.querySelectorAll(".chip-word")].filter(shown).map((n) => n.textContent) };
  });
  const r = shown(line) ? rect(line) : { height: 0, top: 0, bottom: 0, left: 0, right: 0 };
  const round = (n) => Math.round(n * 10) / 10, active = root.activeElement;
  return { on: line.classList.contains("has-chips") && shown(line), height: r.height, top: r.top, bottom: r.bottom, left: r.left, right: r.right,
    pills, lines: new Set(pills.map((p) => Math.round(p.top))).size, more: shown(more) ? more.textContent : "",
    hiddenKinds: [...chips.querySelectorAll(".rail-chip[hidden]")].map((n) => n.dataset.kind),
    fit: line.dataset.fit || "", solo: line.dataset.solo || "", ring: getComputedStyle(boxNode).boxShadow,
    boxTop: round(box.top), boxLeft: round(box.left), boxWidth: round(box.width), boxHeight: round(box.height),
    log: logSel ? rect(root.querySelector(logSel)).height : 0,
    overflowX: document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth,
    text: chips.innerText.replace(/\s+/g, " ").trim(),
    pop: { open: !pop.hidden, kind: pop.dataset.kind || "", inside: pop.contains(active), title: pop.querySelector(".rail-pop-title").textContent,
      top: rect(pop).top, bottom: rect(pop).bottom, left: round(rect(pop).left), right: round(rect(pop).right),
      rows: [...pop.querySelectorAll(".rail-more-row")].map((row) => row.dataset.kind), text: pop.innerText.replace(/\s+/g, " ").trim() },
    focus: active?.id || active?.dataset?.kind || active?.className || "" };
}, ids);

// ---- the two pages, each with a way to make one more kind of thing go on -------------------------------------------
const REPLY = M(8), FALLBACK = "deepseek-v4.1-flash:cloud";
const CHAT = { name: "ChatDGC", ids: { line: "cd-tray", box: "#cd-box", log: "#cd-scroll" }, kinds: ["queue", "making", "summarizing", "fallback"] };
async function openChatDgc({ width, theme = "dark-modern", height = 760 }) {
  const x = await openChat(browser, { width, height, theme });
  await x.send({ type: "opened", conversation: conversation({ title: "A week in Goa in March", fallback: FALLBACK }), earlier: 0, busy: false, messages: [
    { id: M(1), role: "user", text: "Plan a week in Goa in March for two, not too packed.", created_at: "2026-11-10T09:30:00Z" },
    { id: M(2), role: "assistant", text: "Here is a calm week: three days in the north, one in Panjim, three in the south.", created_at: "2026-11-10T09:30:00Z", model: "qwen3.8:27b" },
    { id: M(3), role: "user", text: "Make me a budget sheet for it.", created_at: "2026-11-10T09:31:00Z" }] });
  await x.send({ type: "models", ids: ["qwen3.8:27b", FALLBACK], current: "qwen3.8:27b" });
  await x.send({ type: "fallbackOffered", on: true });
  await x.page.evaluate(() => { document.documentElement.style.setProperty("scroll-behavior", "auto"); });
  let turn = false;
  const start = async () => { if (!turn) { turn = true; await x.send({ type: "turn", state: "started", replyId: REPLY }); } };
  const show = {
    queue: async () => { await start(); for (const text of ["And somewhere quiet near Palolem?", "What does a scooter cost for a week?"]) { await x.page.locator("#cd-input").fill(text); await x.page.locator("#cd-input").press("Enter"); } },
    making: async () => { await start(); await x.send({ type: "activity", kind: "making", messageId: REPLY, text: "Goa budget.xlsx" }); },
    summarizing: async () => { await start(); await x.send({ type: "activity", kind: "compacting", messageId: M(9), text: "" }); },
    fallback: async () => { await start(); await x.send({ type: "waiting", messageId: REPLY, model: FALLBACK }); },
  };
  return { page: x.page, errors: x.errors, show, ids: CHAT.ids, scale: 2, close: () => x.page.close() };
}
const PIP = { name: "a Pip's chat", ids: { line: "chat-tray", box: "#chat-form", log: ".conversation-log" }, kinds: ["queue", "computer", "fix"] };
const BUSY = "Waiting for its computer: it's finishing 'Book the 9 am train'";
// A Project Pip mid-reply. `start`: what is going on as the chat opens (its computer busy, a fix DGC is making).
async function openPip({ width, theme = "dark", height = 760, start = [] }) {
  const x = await pips.openChat(browser, { width, height, theme, where: width > 400 ? "tab" : "side", project: true, running: true, api: 78,
    doing: start.includes("computer") ? BUSY : "", fixing: start.includes("fix") });
  const show = { queue: async () => { for (const text of ["Then check the refunds module too", "Keep it to five findings"]) { await x.p.fill("#chatText", text); await x.p.press("#chatText", "Alt+Enter"); } } };
  if (start.length) await x.p.waitForFunction((n) => (window.__pipsRoot || document).querySelectorAll("#chat-tray .rail-chip").length >= n, start.length);
  return { page: x.p, errors: x.errors, show, ids: PIP.ids, scale: 1, close: () => x.close() };
}

// One line, one height, pills inside it, on the box, the box where it was.
// `own`: the box's own bottom row changed too (the model's name gave way to its fallback's, which is longer and may
// wrap in a narrow box, as it did before there was a bar): then the box's sides and its bottom edge are what must hold.
function oneLine(g, idle, said, kinds, own = false) {
  assert.equal(g.on, true, `${said}: the bar is there`);
  assert.equal(g.height, TRAY, `${said}: the bar is ${g.height}px high`);
  assert.equal(g.lines, 1, `${said}: ${g.lines} lines of pills`);
  assert.match(g.ring, /0px 0px 0px 6px/, `${said}: the shell goes round the box`);
  assert.equal(Math.round(g.bottom * 10) / 10, g.boxTop, `${said}: the bar sits on the box`);
  for (const pill of g.pills) {
    assert.ok(pill.top >= g.top - 0.5 && pill.bottom <= g.bottom + 0.5, `${said}: ${pill.kind} inside the bar's height`);
    assert.ok(pill.left >= g.left - 0.5 && pill.right <= g.right + 0.5, `${said}: ${pill.kind} inside the bar (${pill.left}–${pill.right} of ${g.left}–${g.right})`);
    assert.equal(pill.height, 24, `${said}: ${pill.kind} is a 24px pill`);
    assert.ok(pill.label.length > 3, `${said}: ${pill.kind} has a name for a screen reader`);
  }
  for (let i = 1; i < g.pills.length; i++) assert.ok(g.pills[i].left >= g.pills[i - 1].right - 0.5, `${said}: ${g.pills[i].kind} overlaps ${g.pills[i - 1].kind}`);
  assert.equal(g.overflowX, false, `${said}: nothing scrolls sideways`);
  const onBar = g.pills.filter((p) => p.kind !== "more").map((p) => p.kind);
  assert.deepEqual([...onBar, ...g.hiddenKinds].sort(), [...kinds].sort(), `${said}: every kind accounted for`);
  assert.equal(g.more, g.hiddenKinds.length ? `+${g.hiddenKinds.length}` : "", `${said}: "+N" counts what is behind it`);
  if (!g.hiddenKinds.length) for (const pill of g.pills) assert.equal(pill.cut, false, `${said}: ${pill.kind} shows all it says`);
  assert.equal(g.solo, kinds.length === 1 ? kinds[0] : "", `${said}: one kind alone has the line, more share it`);
  if (idle && own) assert.deepEqual([g.boxLeft, g.boxWidth, Math.round((g.boxTop + g.boxHeight) * 10) / 10], [idle.boxLeft, idle.boxWidth, Math.round((idle.boxTop + idle.boxHeight) * 10) / 10], `${said}: the box moved`);
  else if (idle) assert.deepEqual([g.boxTop, g.boxLeft, g.boxWidth, g.boxHeight], [idle.boxTop, idle.boxLeft, idle.boxWidth, idle.boxHeight], `${said}: the box moved`);
}

for (const width of [220, 300, 700, 1200]) {
  test(`ChatDGC, ${width}px, one kind to four: the bar is one line, ${TRAY}px high every time, and the box never moves`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openChatDgc({ width });
    try {
      await settle(x.page);
      const idle = await bar(x.page, x.ids);
      assert.equal(idle.on, false, "nothing going on: no bar");
      assert.doesNotMatch(idle.ring, /0px 0px 0px 6px/, "and no shell around the box");
      assert.deepEqual(idle.pills, []);
      const seen = [];
      for (const [index, kind] of CHAT.kinds.entries()) {
        await x.show[kind]();
        await settle(x.page);
        const g = await bar(x.page, x.ids), n = index + 1;
        seen.push(`${n}:${g.pills.length}${g.more}/${g.fit}`);
        oneLine(g, idle, `${width}px, ${n} ${n === 1 ? "kind" : "kinds"}`, CHAT.kinds.slice(0, n), kind === "fallback");
        if (n === 1) { assert.ok(g.log < idle.log, "the transcript gave up the room"); if (width >= 300) assert.match(g.text, /^2 queued messages/, "one kind alone is said in full"); }
        if (n === 4) {
          if (width <= 300) { assert.deepEqual(g.pills.flatMap((p) => p.words), [], `${width}px: no words, icons with counts`); assert.ok(g.hiddenKinds.length > 0, `${width}px: four kinds do not fit, some are behind +N`); }
          if (width >= 700) { assert.deepEqual(g.hiddenKinds, [], `${width}px: all four fit`); assert.match(g.text, /2 queued/); }
        }
      }
      t.diagnostic(`ChatDGC ${width}px kinds:pills+more/fit ${seen.join("  ")}`);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`a Pip's chat, ${width}px, one kind to three: the bar is one line, ${TRAY}px high every time, and the box never moves`, async (t) => {
    if (skipOrFail(t)) return;
    // Nothing, then the queue alone.
    const a = await openPip({ width });
    let idle;
    try {
      await settle(a.page);
      idle = await bar(a.page, a.ids);
      assert.equal(idle.on, false, "nothing going on: no bar");
      assert.doesNotMatch(idle.ring, /0px 0px 0px 6px/, "and no shell around the box");
      await a.show.queue();
      await settle(a.page);
      const one = await bar(a.page, a.ids);
      oneLine(one, idle, `${width}px, 1 kind`, ["queue"]);
      assert.ok(one.log < idle.log, "the transcript gave up the room");
      if (width >= 300) assert.match(one.text, /^2 queued messages/, "one kind alone is said in full");
      assert.deepEqual(a.errors, []);
    } finally { await a.close(); }
    // Its computer busy and a fix running, then the queue as well.
    const b = await openPip({ width, start: ["computer", "fix"] });
    try {
      await settle(b.page);
      const two = await bar(b.page, b.ids);
      oneLine(two, null, `${width}px, 2 kinds`, ["computer", "fix"]);
      await b.show.queue();
      await settle(b.page);
      const three = await bar(b.page, b.ids);
      oneLine(three, two, `${width}px, 3 kinds`, PIP.kinds);
      assert.equal(three.pills[0].kind, "queue", "the queue comes first");
      if (width <= 220) assert.deepEqual(three.pills.flatMap((p) => p.words), [], "220px: no words, icons with counts");
      if (width >= 700) { assert.deepEqual(three.hiddenKinds, []); assert.match(three.text, /2 queued.*Computer busy.*Fixing/); }
      assert.doesNotMatch(three.text, /(^|\s)running/, "one fix says Fixing at every width, never a bare 'running'");
      t.diagnostic(`a Pip's chat ${width}px: ${three.pills.length} pills ${three.more} (${three.fit})`);
      assert.deepEqual(b.errors, []);
    } finally { await b.close(); }
  });
}

test("ChatDGC: \"+N\" lists the rest and each row opens its own detail; by keyboard, and Esc lands back on \"+N\"", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openChatDgc({ width: 300 });
  try {
    for (const kind of CHAT.kinds) await x.show[kind]();
    await settle(x.page);
    const g = await bar(x.page, x.ids);
    assert.ok(g.hiddenKinds.length >= 1, `some kinds are behind +N (${g.hiddenKinds})`);
    assert.equal(g.pills.at(-1).kind, "more", "+N comes after the pills");
    const first = g.pills[0].kind;
    await x.page.focus(`#cd-tray .rail-chip[data-kind="${first}"]`);
    assert.equal(await x.page.evaluate(() => [...document.querySelectorAll("#cd-tray .rail-chips > *")].filter((n) => n.tabIndex === 0).length), 1, "one Tab stop for the whole bar");
    await x.page.keyboard.press("End");
    assert.equal((await bar(x.page, x.ids)).focus, "cd-tray-more");
    await x.page.keyboard.press("ArrowRight");
    assert.equal((await bar(x.page, x.ids)).focus, first, "the arrows wrap over what shows only");
    await x.page.keyboard.press("ArrowLeft");
    await x.page.keyboard.press("Enter");
    // (ui-08: the popover arrives in 150 ms, growing its last 2%; its place is measured once it is at rest.)
    await x.page.evaluate(() => Promise.all(document.querySelector("#cd-tray .rail-pop").getAnimations().map((a) => a.finished.catch(() => {}))));
    let s = await bar(x.page, x.ids);
    assert.deepEqual({ open: s.pop.open, kind: s.pop.kind, inside: s.pop.inside, title: s.pop.title, rows: s.pop.rows },
      { open: true, kind: "more", inside: true, title: `${g.hiddenKinds.length} more`, rows: g.hiddenKinds });
    assert.ok(s.pop.bottom <= s.top + 0.5, "the list floats just above the bar");
    assert.ok(Math.abs(s.pop.left - s.boxLeft) < 1 && Math.abs(s.pop.right - (s.boxLeft + s.boxWidth)) < 1, "as wide as the box");
    assert.deepEqual([s.boxTop, s.height], [g.boxTop, g.height], "the list floats: nothing moved");
    await x.page.keyboard.press("Escape");
    s = await bar(x.page, x.ids);
    assert.deepEqual({ open: s.pop.open, focus: s.focus }, { open: false, focus: "cd-tray-more" });
    await x.page.keyboard.press(" ");
    await x.page.keyboard.press("Enter");
    s = await bar(x.page, x.ids);
    assert.deepEqual({ open: s.pop.open, kind: s.pop.kind, inside: s.pop.inside }, { open: true, kind: g.hiddenKinds[0], inside: true }, "Enter on a row opens that kind's detail");
    await x.page.keyboard.press("Escape");
    s = await bar(x.page, x.ids);
    assert.deepEqual({ open: s.pop.open, focus: s.focus }, { open: false, focus: "cd-tray-more" });
    assert.deepEqual(await x.page.evaluate(() => window.__posted.filter((m) => m.type === "stop")), [], "Esc never stopped the reply");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("ChatDGC: each pill opens its detail just above by keyboard; the queue's rows, the fallback's words, and Stop for a file being made", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openChatDgc({ width: 700 });
  try {
    for (const kind of CHAT.kinds) await x.show[kind]();
    await settle(x.page);
    const g = await bar(x.page, x.ids);
    const chip = (kind) => `#cd-tray .rail-chip[data-kind="${kind}"]`;
    // The queue: its own rows, which you can still change.
    await x.page.focus(chip("queue"));
    await x.page.keyboard.press("Enter");
    let s = await bar(x.page, x.ids);
    assert.deepEqual({ open: s.pop.open, kind: s.pop.kind, inside: s.pop.inside, title: s.pop.title }, { open: true, kind: "queue", inside: true, title: "Queued messages" });
    assert.ok(s.pop.bottom <= s.top + 0.5 && s.pop.top >= 0, "above the bar");
    assert.equal(await x.page.locator("#cd-tray .rail-pop #cd-queue").isVisible(), true, "the queue itself, not a copy");
    assert.deepEqual(await x.page.locator("#cd-queue .cd-queue-text").allTextContents(), ["And somewhere quiet near Palolem?", "What does a scooter cost for a week?"]);
    assert.deepEqual([s.boxTop, s.height], [g.boxTop, g.height], "it floats: nothing moved");
    await x.page.locator("#cd-queue [data-queue-role='remove']").first().click();
    assert.deepEqual(await x.page.locator("#cd-queue .cd-queue-text").allTextContents(), ["What does a scooter cost for a week?"]);
    assert.match((await bar(x.page, x.ids)).text, /1 queued/, "the pill counts what is left");
    await x.page.focus(chip("queue"));
    await x.page.keyboard.press("Escape");
    s = await bar(x.page, x.ids);
    assert.deepEqual({ open: s.pop.open, focus: s.focus }, { open: false, focus: "queue" }, "Esc: closed, back on the pill");
    assert.equal(await x.page.locator("#cd-queue").isVisible(), false, "and the rows are folded into the pill again");
    // The fallback: why, and the way to change it.
    await x.page.keyboard.press("End");
    await x.page.keyboard.press("Enter");
    s = await bar(x.page, x.ids);
    assert.deepEqual({ kind: s.pop.kind, inside: s.pop.inside, title: s.pop.title }, { kind: "fallback", inside: true, title: "Fallback model" });
    assert.match(s.pop.text, /qwen3\.8:27b didn’t answer, so its fallback deepseek-v4\.1-flash:cloud is answering\. It tries qwen3\.8:27b again with your next message\./);
    await x.page.keyboard.press("Escape");
    assert.equal((await bar(x.page, x.ids)).focus, "fallback");
    // A file being made: Stop is in its detail.
    await x.page.click(chip("making"));
    s = await bar(x.page, x.ids);
    assert.match(s.pop.text, /Making Goa budget\.xlsx/);
    await x.page.locator("#cd-tray .rail-pop .tray-note-act", { hasText: "Stop" }).click();
    assert.equal((await x.page.evaluate(() => window.__posted.filter((m) => m.type === "stop"))).length, 1, "Stop stops the reply");
    assert.equal((await bar(x.page, x.ids)).pop.open, false);
    // A click elsewhere closes a popover.
    await x.page.click(chip("summarizing"));
    assert.equal((await bar(x.page, x.ids)).pop.kind, "summarizing");
    await x.page.mouse.click(350, 120);
    assert.equal((await bar(x.page, x.ids)).pop.open, false);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("ChatDGC: the queue emptied, the file made, the summary done and its own model back: the bar goes, and the box is where it was", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openChatDgc({ width: 700 });
  try {
    await settle(x.page);
    const idle = await bar(x.page, x.ids);
    await x.show.queue();
    await settle(x.page);
    const on = await bar(x.page, x.ids);
    assert.deepEqual([on.on, on.boxTop, on.boxHeight], [true, idle.boxTop, idle.boxHeight], "the queue is on the bar, not in the box: the box is as it was");
    assert.equal(await x.page.locator("#cd-box #cd-queue").count(), 0, "nothing of the queue is inside the box");
    // Up in the empty box takes the last one back, then the other: the bar goes with the last of them.
    await x.page.locator("#cd-input").press("ArrowUp");
    assert.match((await bar(x.page, x.ids)).text, /^1 queued message\b/);
    await x.page.locator("#cd-input").fill("");
    await x.page.locator("#cd-input").press("ArrowUp");
    await settle(x.page);
    const off = await bar(x.page, x.ids);
    assert.deepEqual([off.on, off.pills.length], [false, 0], "nothing going on: no bar");
    assert.doesNotMatch(off.ring, /0px 0px 0px 6px/);
    assert.equal(off.log, idle.log, "and the transcript has its room back");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("a Pip's chat: \"+N\" lists the rest by keyboard, and each row opens its own detail", async (t) => {
  if (skipOrFail(t)) return;
  // Narrower than any side bar DGC opens in: the width at which three kinds no longer fit as icons.
  for (const width of [150, 220]) {
    const x = await openPip({ width, start: ["computer", "fix"] });
    try {
      await x.show.queue();
      await settle(x.page);
      const g = await bar(x.page, x.ids);
      assert.equal(g.height, TRAY); assert.equal(g.lines, 1); assert.equal(g.overflowX, false);
      if (width === 220 && !g.hiddenKinds.length) continue;        // all three fit as icons there: nothing behind "+N"
      assert.ok(g.hiddenKinds.length >= 1, `${width}px: some kinds are behind +N`);
      assert.equal(g.pills.at(-1).kind, "more");
      await x.page.focus("#chat-tray .rail-more");
      await x.page.keyboard.press("Enter");
      let s = await bar(x.page, x.ids);
      assert.deepEqual({ open: s.pop.open, kind: s.pop.kind, inside: s.pop.inside, rows: s.pop.rows }, { open: true, kind: "more", inside: true, rows: g.hiddenKinds });
      await x.page.keyboard.press("ArrowDown"); await x.page.keyboard.press("Home");
      await x.page.keyboard.press("Enter");
      s = await bar(x.page, x.ids);
      assert.deepEqual({ open: s.pop.open, kind: s.pop.kind, inside: s.pop.inside }, { open: true, kind: g.hiddenKinds[0], inside: true });
      await x.page.keyboard.press("Escape");
      s = await bar(x.page, x.ids);
      assert.deepEqual({ open: s.pop.open, focus: s.focus }, { open: false, focus: "chat-tray-more" });
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  }
});

for (const width of [300, 700]) {
  test(`a Pip's chat, ${width}px: each pill opens its detail just above by keyboard; the queue's rows are its pill's detail`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openPip({ width, start: ["computer", "fix"] });
    try {
      await x.show.queue();
      await settle(x.page);
      const g = await bar(x.page, x.ids);
      const chip = (kind) => `#chat-tray .rail-chip[data-kind="${kind}"]`;
      await x.page.focus(chip("queue"));
      await x.page.keyboard.press("Enter");
      let s = await bar(x.page, x.ids);
      assert.deepEqual({ open: s.pop.open, kind: s.pop.kind, inside: s.pop.inside, title: s.pop.title }, { open: true, kind: "queue", inside: true, title: "Queued messages" });
      assert.ok(s.pop.bottom <= s.top + 0.5 && s.pop.top >= 0, "above the bar");
      assert.ok(Math.abs(s.pop.left - s.boxLeft) < 1 && Math.abs(s.pop.right - (s.boxLeft + s.boxWidth)) < 1, "as wide as the box");
      assert.deepEqual([s.boxTop, s.height], [g.boxTop, g.height], "it floats: nothing moved");
      assert.equal(await x.page.locator("#chat-tray .rail-pop #chat-queue").isVisible(), true, "the queue itself");
      assert.deepEqual(await x.page.locator("#chat-queue .dgc-queue-text").allTextContents(), ["Then check the refunds module too", "Keep it to five findings"]);
      // A refresh of the page (every few seconds while a chat is open) leaves the open popover alone.
      await x.page.waitForTimeout(700);
      assert.equal((await bar(x.page, x.ids)).pop.kind, "queue");
      await x.page.keyboard.press("Escape");
      s = await bar(x.page, x.ids);
      assert.deepEqual({ open: s.pop.open, focus: s.focus }, { open: false, focus: "queue" }, "Esc: closed, back on the pill");
      assert.equal(await x.page.locator("#chat-queue").isVisible(), false, "the rows are folded into the pill again");
      // Its computer: the line the run itself says, in full.
      await x.page.keyboard.press("ArrowRight");
      await x.page.keyboard.press("Enter");
      s = await bar(x.page, x.ids);
      assert.deepEqual({ kind: s.pop.kind, title: s.pop.title }, { kind: "computer", title: "Its computer" });
      assert.match(s.pop.text, /Waiting for its computer: it's finishing 'Book the 9 am train'\. It carries on with this by itself as soon as its computer is free\./);
      await x.page.keyboard.press("Escape");
      assert.equal((await bar(x.page, x.ids)).focus, "computer");
      // A fix: what DGC is doing about what this Pip found.
      await x.page.click(chip("fix"));
      s = await bar(x.page, x.ids);
      assert.deepEqual({ kind: s.pop.kind, title: s.pop.title }, { kind: "fix", title: "Fixes" });
      assert.match(s.pop.text, /DGC is fixing what this Pip found/);
      await x.page.locator(".pip-topbar").click({ position: { x: 100, y: 10 } });
      assert.equal((await bar(x.page, x.ids)).pop.open, false, "a click elsewhere closes it");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

// ---- colour: read from what is painted -----------------------------------------------------------------------------
async function pixels(page, points, scale = 1) {
  const shot = await page.screenshot({ type: "png" });
  const scratch = await browser.newPage();
  try {
    return await scratch.evaluate(async ([b64, at]) => {
      const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
      const canvas = document.createElement("canvas"); canvas.width = img.width; canvas.height = img.height;
      const g = canvas.getContext("2d"); g.drawImage(img, 0, 0);
      return at.map(([x, y]) => [...g.getImageData(Math.round(x), Math.round(y), 1, 1).data.slice(0, 3)]);
    }, [shot.toString("base64"), points.map(([x, y]) => [x * scale, y * scale])]);
  } finally { await scratch.close(); }
}
const near = (a, b, by = 2) => a.every((v, i) => Math.abs(v - b[i]) <= by);
const hex = (rgb) => "#" + rgb.map((n) => n.toString(16).padStart(2, "0")).join("");

// The shell is one shape: its sides run straight from the bar into the ring round the box, with no bite just outside
// the box's top corners. And the box is drawn over the shell, also while a popover is open (the bar's ground once
// covered the top of the box, and what was typed there, for as long as a popover was open).
const SURFACES = [
  ["ChatDGC", (o) => openChatDgc({ ...o, theme: `${o.theme}-modern` }), (x) => x.show.queue(), '#cd-tray .rail-chip[data-kind="queue"]'],
  ["a Pip's chat", (o) => openPip({ ...o, start: ["computer", "fix"] }), (x) => x.show.queue(), '#chat-tray .rail-chip[data-kind="queue"]'],
];
for (const [name, openIt, fill, queuePill] of SURFACES) for (const theme of ["dark", "light"]) for (const width of [300, 700]) {
  test(`${name}, ${theme}, ${width}px: the shell's sides run straight from the bar into the ring, and the box is never covered`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openIt({ width, theme, height: 600 });
    try {
      await settle(x.page);
      const boxWas = await bar(x.page, x.ids);
      const inBox = [[boxWas.boxLeft + boxWas.boxWidth / 2, boxWas.boxTop + 5]];      // the box's own ground, just under its top edge
      const [ground0] = await pixels(x.page, inBox, x.scale);
      await fill(x);
      await settle(x.page);
      const g = await bar(x.page, x.ids);
      assert.equal(g.on, true);
      const boxRight = g.boxLeft + g.boxWidth;
      const [ground, box1, ...corners] = await pixels(x.page, [
        [g.left + 3, g.top + g.height / 2],          // the bar's own ground, clear of its pills
        inBox[0],
        [g.boxLeft - 3, g.boxTop + 3], [g.boxLeft + 1, g.boxTop + 1],
        [boxRight + 2, g.boxTop + 3], [boxRight - 2, g.boxTop + 1]], x.scale);
      for (const [i, colour] of corners.entries())
        assert.ok(near(colour, ground), `${["left, outside", "left, the corner", "right, outside", "right, the corner"][i]}: rgb(${colour}) is not the shell's rgb(${ground})`);
      assert.ok(near(box1, ground0), `the box's ground is its own with the bar on it: rgb(${box1}), was rgb(${ground0})`);
      assert.ok(!near(ground, ground0, 0) || theme === "dark", "the shell is a step off the box");
      await x.page.click(queuePill);
      await settle(x.page);
      assert.equal((await bar(x.page, x.ids)).pop.open, true);
      const [box2] = await pixels(x.page, inBox, x.scale);
      assert.ok(near(box2, ground0), `with a popover open the box is still drawn over the shell: rgb(${box2}), was rgb(${ground0})`);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}
for (const theme of ["dark-modern", "light-modern"]) {
  test(`Work, ${theme}: with a popover open the box is still drawn over the shell`, async (t) => {
    if (skipOrFail(t)) return;
    const { page, errors } = await openRailScene(browser, { width: 500, height: 600, theme, kinds: ["tasks", "changes"], queued: 2, reducedMotion: true });
    try {
      await settle(page);
      const at = await page.evaluate(() => { const r = document.getElementById("cbox").getBoundingClientRect(); return [[r.left + r.width / 2, r.top + 5]]; });
      const [closed] = await pixels(page, at);
      await page.click('#rail-chips .rail-chip[data-kind="tasks"]');
      await settle(page);
      assert.equal(await page.evaluate(() => document.getElementById("rail-pop").hidden), false);
      const [open] = await pixels(page, at);
      assert.ok(near(open, closed), `the top of the box is rgb(${open}) with the popover open, rgb(${closed}) without`);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

// Words clear 4.5:1 and marks 3:1, on the pills, on the line said in full and in a detail, in both themes. Each ink is
// resolved by painting it over its ground (color-mix and translucent inks come out as real pixels).
const inks = (page, ids) => page.evaluate(({ line: lineId }) => {
  const root = window.__pipsRoot || document, line = root.querySelector(`#${lineId}`);
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const over = (colours) => { ctx.clearRect(0, 0, 1, 1); for (const c of colours) { ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); }
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data; return "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join(""); };
  // Every background from the page down to the node, one over the other.
  const groundOf = (node) => { const stack = []; for (let n = node; n; n = n.parentElement || n.getRootNode()?.host) stack.unshift(getComputedStyle(n).backgroundColor); return ["#000", ...stack]; };
  const out = [];
  const add = (what, node, floor) => { if (!node || !node.checkVisibility()) return; const ground = groundOf(node); out.push({ what, floor, ground: over(ground), ink: over([...ground, getComputedStyle(node).color]) }); };
  for (const pill of line.querySelectorAll(".rail-chip:not([hidden]), .rail-more")) {
    const kind = pill.dataset.kind;
    add(`${kind} pill`, pill, 4.5);
    for (const cls of ["chip-word", "chip-num", "chip-need", "chip-detail", "chip-extra"]) for (const n of pill.querySelectorAll(`.${cls}`)) add(`${kind} ${cls}`, n, 4.5);
    add(`${kind} icon`, pill.querySelector(".codicon:first-child"), 3);
    add(`${kind} caret`, pill.querySelector(".chip-caret"), 3);
  }
  const pop = line.querySelector(".rail-pop");
  if (!pop.hidden) {
    add("detail title", pop.querySelector(".rail-pop-title"), 4.5); add("detail close", pop.querySelector(".rail-pop-head button"), 3);
    for (const n of pop.querySelectorAll(".tray-note p, .tray-note-act, .rail-more-row, .rail-more-row .chip-word, .rail-more-row .chip-detail, .rail-more-row .row-open, .dgc-queue-text, .cd-queue-head")) add(`detail ${n.className || n.tagName}`, n, 4.5);
    for (const n of pop.querySelectorAll(".rail-more-row > .codicon:first-child")) add("row icon", n, 3);
  }
  return out;
}, ids);
for (const [name, openIt, , ] of [["ChatDGC", (o) => openChatDgc({ ...o, theme: `${o.theme}-modern` })], ["a Pip's chat", (o) => openPip({ ...o, start: ["computer", "fix"] })]]) for (const theme of ["dark", "light"]) {
  test(`${name}, ${theme}: words on the bar and in a detail clear 4.5:1, and the marks 3:1`, async (t) => {
    if (skipOrFail(t)) return;
    const lowest = { words: 99, marks: 99 };
    const check = (list, where) => { for (const { what, floor, ground, ink } of list) { const ratio = contrastRatio(ink, ground);
      lowest[floor === 3 ? "marks" : "words"] = Math.min(lowest[floor === 3 ? "marks" : "words"], ratio);
      assert.ok(ratio >= floor, `${where}, ${what}: ${ink} on ${ground} is ${ratio.toFixed(2)}:1 (needs ${floor}:1)`); } };
    for (const width of [700, 300]) {
      const x = await openIt({ width, theme });
      try {
        // One kind alone (its words sit on the shell), then every kind (on pills), then a detail and the "+N" list.
        const isChat = name === "ChatDGC";
        if (isChat) { await x.show.fallback(); await settle(x.page); check(await inks(x.page, x.ids), `${width}px alone`); }
        for (const kind of isChat ? CHAT.kinds : ["queue"]) await x.show[kind]();
        await settle(x.page);
        const all = await inks(x.page, x.ids);
        assert.ok(all.length >= 6, "the pills were read");
        check(all, `${width}px`);
        const g = await bar(x.page, x.ids), line = `#${x.ids.line}`;
        for (const kind of g.pills.map((p) => p.kind)) {
          await x.page.click(kind === "more" ? `${line} .rail-more` : `${line} .rail-chip[data-kind="${kind}"]`);
          await settle(x.page);
          check(await inks(x.page, x.ids), `${width}px, ${kind} open`);
          await x.page.keyboard.press("Escape");
        }
        assert.deepEqual(x.errors, []);
      } finally { await x.close(); }
    }
    t.diagnostic(`${name} ${theme}: lowest words ${lowest.words.toFixed(2)}:1, lowest marks ${lowest.marks.toFixed(2)}:1`);
  });
}

// Purple is for what is live (a live pill's icon), never the bar's ground or its words: at most a tenth of what the
// bar and its box paint. Counted from the pixels of the shell (the bar, the ring and the box).
const purple = ([r, g, b]) => b > 120 && b - g > 40 && r > g + 10 && r < b + 30;
for (const [name, openIt] of [["ChatDGC", (o) => openChatDgc({ ...o, theme: `${o.theme}-modern` })], ["a Pip's chat", (o) => openPip({ ...o, start: ["computer", "fix"] })]]) {
  test(`${name}: purple is under a tenth of the bar and its box, dark and light`, async (t) => {
    if (skipOrFail(t)) return;
    for (const theme of ["dark", "light"]) for (const width of [300, 700]) {
      const x = await openIt({ width, theme });
      try {
        for (const kind of name === "ChatDGC" ? CHAT.kinds : ["queue"]) await x.show[kind]();
        await settle(x.page);
        const g = await bar(x.page, x.ids);
        const clip = { x: Math.max(0, g.left), y: g.top, width: Math.min(width, g.right) - Math.max(0, g.left), height: g.boxTop + g.boxHeight + 6 - g.top };
        const shot = await x.page.screenshot({ type: "png", clip });
        const scratch = await browser.newPage();
        const share = await scratch.evaluate(async ([b64, fn]) => {
          const isPurple = new Function(`return ${fn}`)();
          const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
          const canvas = document.createElement("canvas"); canvas.width = img.width; canvas.height = img.height;
          const c = canvas.getContext("2d"); c.drawImage(img, 0, 0);
          const d = c.getImageData(0, 0, img.width, img.height).data; let n = 0;
          for (let i = 0; i < d.length; i += 4) if (isPurple([d[i], d[i + 1], d[i + 2]])) n++;
          return n / (d.length / 4);
        }, [shot.toString("base64"), purple.toString()]);
        await scratch.close();
        t.diagnostic(`${name} ${theme} ${width}px: purple is ${(share * 100).toFixed(2)}% of the bar and its box`);
        assert.ok(share <= 0.10, `${theme} ${width}px: purple is ${(share * 100).toFixed(1)}% of the bar and its box`);
        assert.deepEqual(x.errors, []);
      } finally { await x.close(); }
    }
  });
}

test("one implementation: Work, ChatDGC and a Pip's chat all load media/shared/tray.js and its stylesheet, and none keeps a copy", () => {
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const tray = read("media/shared/tray.js"), css = read("media/shared/tray.css");
  assert.match(tray, /globalThis\.DgcTray = \{ create, build/);
  assert.match(read("src/panel.ts"), /"media", "shared", "tray\.js"/, "Work loads it");
  assert.match(read("src/chatdgc.ts"), /asset\("media\/shared\/tray\.js"\)/, "ChatDGC loads it");
  assert.match(read("src/pipsClient.js"), /import '\.\.\/media\/shared\/tray\.js';/, "a Pip's chat bundles it");
  assert.match(read("media/main.css"), /@import url\("\.\/shared\/tray\.css"\);/, "Work and ChatDGC get its look through main.css");
  assert.match(read("src/pipsClient.js"), /import '\.\.\/media\/shared\/tray\.css';/, "a Pip's chat bundles its look");
  for (const [name, source] of [["Work", read("media/main.js")], ["ChatDGC", read("media/chatdgc.js")], ["a Pip's chat", read("src/pipsClient.js")]]) {
    assert.match(source, /DgcTray\.create\(/, `${name} asks the shared piece for its bar`);
    assert.doesNotMatch(source, /scrollWidth <= \w+\.clientWidth \+ 1/, `${name} has no fitting of its own`);
  }
  // The rules of the bar are in the shared stylesheet only.
  for (const rule of [".rail-chip, .rail-more {", ".rail-line.has-chips::after", ".rail-pop {"]) {
    assert.ok(css.includes(rule), `tray.css has ${rule}`);
    for (const other of ["media/main.css", "media/chatdgc.css", "src/pips.css"]) assert.ok(!read(other).includes(rule), `${other} does not repeat ${rule}`);
  }
});
