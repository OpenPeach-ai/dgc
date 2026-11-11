// A ChatDGC chat's wake-ups on its page (media/chatdgc.js, media/chatdgc.css), as Work's has them: the host posts
// {type: "wakeups", items: [{id, at, why}]} to the tab, and a wake-up's own turn is a user message with `wakeup`.
// Measured in real Chromium on ChatDGC's real page (support/chat-scene.mjs). What is held here:
//   - the wake-ups are a pill in the tray above the prompt box ("Wakes 14:30"), soonest first; none hides it
//   - its popover lists each with its time and reason and a Cancel, which posts {type: "cancelWakeup", id}
//   - a wake-up's turn shows as a quiet note, "Woke up as planned · <why>", in place of a user bubble: its long text
//     is the model's, never shown, and it has no Copy or Edit
//   - it reads at 4.5:1 dark and light, and fits at 300 px
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openChat, conversation, M } from "./support/chat-scene.mjs";

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
const settle = (page, ms = 80) => page.evaluate((wait) => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, wait)))), ms);

// Times are said in the reader's own clock, as Work says them.
const at = (h, m) => { const d = new Date(2026, 10, 11, h, m, 0); return d.toISOString(); };
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
const BUILD = { id: "wake1", at: at(14, 30), why: "Check the build" }, MAIL = { id: "wake2", at: at(16, 5), why: "See whether the supplier replied" };
const PROMPT = "[A wake-up you set. Reason: Check the build. Carry on from where you left off; say what you found.] ".repeat(4);
const MESSAGES = [{ id: M(1), role: "user", text: "Start the build and check it in ten minutes.", created_at: at(14, 20) },
  { id: M(2), role: "assistant", text: "Started. I'll look again at 14:30.", created_at: at(14, 20), finish: "stop" }];
async function open({ width = 700, theme = "dark-modern", messages = MESSAGES } = {}) {
  const x = await openChat(browser, { width, height: 760, theme });
  await x.send({ type: "opened", conversation: conversation({ title: "The nightly build" }), earlier: 0, busy: false, messages });
  await x.send({ type: "models", ids: ["qwen3.8:27b"], current: "qwen3.8:27b" });
  await settle(x.page, 150);
  return x;
}
/** The wake-ups pill and its popover, as they are on screen. */
const trayNow = (page) => page.evaluate(() => {
  const pill = document.querySelector('.rail-chip[data-kind="wakeups"]'), pop = document.querySelector(".rail-pop"), shown = (n) => !!n && n.checkVisibility();
  const rows = shown(pop) ? [...pop.querySelectorAll(".cd-wake-row")].map((r) => ({ when: r.querySelector(".cd-wake-when").textContent, why: r.querySelector(".cd-wake-why").textContent,
    cancel: r.querySelector("button")?.textContent || "", label: r.querySelector("button")?.getAttribute("aria-label") || "" })) : null;
  return { pill: shown(pill) ? pill.textContent.replace(/\s+/g, " ").trim() : null, label: shown(pill) ? pill.getAttribute("aria-label") : null, title: shown(pop) ? pop.querySelector(".rail-pop-title")?.textContent : null, rows,
    kinds: [...document.querySelectorAll(".rail-chip:not([hidden])")].map((c) => c.dataset.kind) };
});

test("a chat's wake-ups are a pill in ChatDGC's tray, as Work's are: when the next is, soonest first; none hides it", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open();
  try {
    assert.equal((await trayNow(x.page)).pill, null, "nothing waits: no pill");
    await x.send({ type: "wakeups", items: [BUILD] }); await settle(x.page);
    let tray = await trayNow(x.page);
    assert.ok(tray.pill && tray.pill.includes("Wakes") && tray.pill.includes(clock(BUILD.at)), `the pill says when it wakes (${tray.pill})`);
    assert.equal(tray.label, `Wakes at ${clock(BUILD.at)} to: Check the build`);
    await x.send({ type: "wakeups", items: [MAIL, BUILD, { id: 7, at: "x" }, null] }); await settle(x.page);
    tray = await trayNow(x.page);
    assert.ok(tray.pill.includes("2") && tray.pill.includes("wake-ups"), `two: how many (${tray.pill})`);
    assert.equal(tray.label, `2 wake-ups waiting, the next at ${clock(BUILD.at)}`, "the soonest first, and only what is a wake-up");
    await x.send({ type: "wakeups", items: [] }); await settle(x.page);
    assert.equal((await trayNow(x.page)).pill, null, "none left: the pill is gone");
    assert.deepEqual(x.errors, []);
  } finally { await x.page.close(); }
});

test("the pill opens each wake-up with its time, its reason and Cancel, which asks the host to take it back", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open();
  try {
    await x.send({ type: "wakeups", items: [BUILD, MAIL] }); await settle(x.page);
    await x.page.click('.rail-chip[data-kind="wakeups"]'); await settle(x.page, 150);
    let tray = await trayNow(x.page);
    assert.equal(tray.title, "Wake-ups");
    assert.deepEqual(tray.rows, [{ when: clock(BUILD.at), why: "Check the build", cancel: "Cancel", label: `Cancel the wake-up at ${clock(BUILD.at)}: Check the build` },
      { when: clock(MAIL.at), why: "See whether the supplier replied", cancel: "Cancel", label: `Cancel the wake-up at ${clock(MAIL.at)}: See whether the supplier replied` }]);
    await x.page.click(".rail-pop .cd-wake-row:nth-child(2) button"); await settle(x.page);
    assert.deepEqual(await x.posted("cancelWakeup"), [{ type: "cancelWakeup", id: "wake2" }], "Cancel posts which one");
    assert.equal(await x.page.evaluate(() => document.querySelector(".rail-pop .cd-wake-row:nth-child(2) button").disabled), true, "and waits for the host's word");
    // The host says the row again without it: the list follows, open as it is.
    await x.send({ type: "wakeups", items: [BUILD] }); await settle(x.page);
    tray = await trayNow(x.page);
    assert.deepEqual(tray.rows.map((r) => r.why), ["Check the build"]);
    await x.send({ type: "wakeups", items: [] }); await settle(x.page, 150);
    tray = await trayNow(x.page);
    assert.deepEqual([tray.pill, tray.rows], [null, null], "the last one gone: the popover closes with its pill");
    assert.deepEqual(x.errors, []);
  } finally { await x.page.close(); }
});

test("a wake-up's turn is a quiet note, \"Woke up as planned\", in place of a user bubble: its long text is never shown", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ messages: [...MESSAGES, { id: M(3), role: "user", text: PROMPT, created_at: at(14, 30), wakeup: { id: "wake1", why: "Check the build", at: BUILD.at } },
    { id: M(4), role: "assistant", text: "The build passed: 412 tests, none failed.", created_at: at(14, 31), finish: "stop" }] });
  try {
    const seen = await x.page.evaluate(([id]) => {
      const note = document.querySelector(`.cd-msg[data-id="${id}"]`), bubbles = [...document.querySelectorAll(".cd-msg.cd-user")];
      return { note: note ? { text: note.textContent.replace(/\s+/g, " ").trim(), wake: note.classList.contains("cd-wake"), user: note.classList.contains("cd-user"), icon: !!note.querySelector(".codicon-history"),
        buttons: note.querySelectorAll("button").length, bubble: !!note.querySelector(".cd-bubble") } : null,
        bubbles: bubbles.map((b) => b.dataset.id), page: document.getElementById("cd-log")?.textContent || document.body.textContent, answer: !!document.querySelector(`.cd-msg.cd-assistant`) };
    }, [M(3)]);
    assert.deepEqual(seen.note, { text: "Woke up as planned · Check the build", wake: true, user: false, icon: true, buttons: 0, bubble: false }, "a quiet note with the history mark: no bubble, no Copy, no Edit");
    assert.deepEqual(seen.bubbles, [M(1)], "your own message is still a bubble; the wake-up's is not one");
    assert.ok(!seen.page.includes("Carry on from where you left off"), "the text written for the model is never shown");
    assert.ok(seen.page.includes("The build passed"), "the answer follows the note");
    assert.deepEqual(x.errors, []);
  } finally { await x.page.close(); }
});

test("a wake-up's turn arriving live is a note too, and a message that only looks like one stays a bubble", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open();
  try {
    await x.send({ type: "message", message: { id: M(5), role: "user", text: PROMPT, created_at: at(14, 30), wakeup: { id: "wake1", why: "Check the build", at: BUILD.at } } });
    await x.send({ type: "message", message: { id: M(6), role: "user", text: "Woke up as planned · not really", created_at: at(14, 32), wakeup: "yes" } });
    await settle(x.page, 150);
    const seen = await x.page.evaluate(([a, b]) => [a, b].map((id) => { const n = document.querySelector(`.cd-msg[data-id="${id}"]`); return n ? [n.classList.contains("cd-wake"), n.classList.contains("cd-user")] : null; }), [M(5), M(6)]);
    assert.deepEqual(seen, [[true, false], [false, true]]);
  } finally { await x.page.close(); }
});

for (const theme of ["dark-modern", "light-modern"]) for (const width of [300, 700]) {
  test(`${theme} ${width}px: the pill, its popover and the note fit and read at 4.5:1`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open({ width, theme, messages: [...MESSAGES, { id: M(3), role: "user", text: PROMPT, created_at: at(14, 30), wakeup: { id: "wake1", why: "See whether the supplier replied to the second quote, and chase them if not", at: BUILD.at } }] });
    try {
      await x.send({ type: "wakeups", items: [BUILD, { ...MAIL, why: "See whether the supplier replied to the second quote, and chase them if not" }] }); await settle(x.page);
      await x.page.click('.rail-chip[data-kind="wakeups"]'); await settle(x.page, 200);
      const facts = await x.page.evaluate(() => {
        const parse = (c) => { const m = c.match(/-?[\d.]+(e-?\d+)?/g)?.map(Number) || [0, 0, 0, 0]; return c.startsWith("color(srgb") ? [m[0] * 255, m[1] * 255, m[2] * 255, m[3] ?? 1] : [m[0], m[1], m[2], m[3] ?? 1]; };
        const over = (top, under) => top.slice(0, 3).map((v, i) => v * top[3] + under[i] * (1 - top[3])).concat(1);
        const ground = (e) => { const layers = []; for (let n = e; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c[3] > 0) layers.push(c); if (c[3] >= 1) break; } return layers.reduceRight((u, t) => over(t, u), [255, 255, 255, 1]); };
        const lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
        const ratio = (e) => { const g = ground(e), c = over(parse(getComputedStyle(e).color), g), [a, b] = [lum(c), lum(g)].sort((p, q) => q - p); return Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100; };
        const words = [...document.querySelectorAll(".cd-wake, .cd-wake-when, .cd-wake-why, .cd-wake-row button, .rail-chip[data-kind=wakeups] .chip-word, .rail-chip[data-kind=wakeups] .chip-num, .rail-pop-title")].filter((n) => n.checkVisibility());
        const pop = document.querySelector(".rail-pop").getBoundingClientRect(), note = document.querySelector(".cd-wake").getBoundingClientRect();
        return { low: words.map((n) => [n.className, ratio(n)]).filter(([, r]) => r < 4.5), count: words.length,
          inPop: [...document.querySelectorAll(".cd-wake-row, .cd-wake-row button")].every((n) => { const r = n.getBoundingClientRect(); return r.left >= pop.left - 0.5 && r.right <= pop.right + 0.5; }),
          cancels: [...document.querySelectorAll(".cd-wake-row button")].map((b) => b.scrollWidth <= b.clientWidth + 1 && b.getBoundingClientRect().height >= 22),
          note: note.left >= 0 && note.right <= innerWidth, overflowX: document.documentElement.scrollWidth > innerWidth };
      });
      assert.ok(facts.count >= 7, "the words are on the page");
      assert.deepEqual(facts.low, [], "every word reads at 4.5:1");
      assert.deepEqual([facts.inPop, facts.cancels, facts.note, facts.overflowX], [true, [true, true], true, false], "the rows and Cancel are inside the popover, whole, and nothing runs off the side");
      assert.deepEqual(x.errors, []);
    } finally { await x.page.close(); }
  });
}
