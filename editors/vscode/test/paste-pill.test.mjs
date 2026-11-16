// ui-09: nothing draws a row of its own between the bar for what is going on (the tray, media/shared/tray.js) and the
// prompt box. The last one that did was the notice that a paste was cleaned of invisible characters: a strip above the
// box in Work, ChatDGC and a Pip's chat. It is a pill on the bar now, the same in all three (media/pasteclean.js says
// what it says): "Removed 5" beside the other pills; alone, the whole sentence with Dismiss at the end of the line. It
// opens what was taken, kind by kind, with Dismiss. The box never moves. Real Chromium, dark and light, 700 and 300 px.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openRailScene } from "./support/rail-scene.mjs";
import { openChatDgc } from "./support/dgc-look-scene.mjs";
import { openChat as openPip } from "./support/pip-chat-scene.mjs";

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

const DIRTY = "Ship​ the​ settings‮ migration​ today⁠";   // four zero-width characters and one direction control
const SENTENCE = "Removed 5 invisible characters from the pasted text";
const TAKEN = "4 zero-width characters, 1 text direction control. Undo brings them back.";
/** A paste into a prompt box, the way the editor delivers it to Work (inside its own editing command, so the text is
    put in by hand) and the plain way to the other two. */
const paste = async (page, sel, text = DIRTY) => { await page.evaluate(([s, t]) => { const box = (window.__pipsRoot || document).querySelector(s); box.focus();
  const data = new DataTransfer(); data.setData("text/plain", t);
  const saved = document.execCommand; if (s === "#input") document.execCommand = function (cmd, ui, value) { return cmd === "insertText" ? false : saved.call(document, cmd, ui, value); };
  box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true, composed: true }));
  setTimeout(() => { document.execCommand = saved; }, 60); }, [sel, text]); await page.waitForTimeout(200); };
/** What is above the box now: the pill, the bar, any strip that is not the bar, the popover, and where the box is. */
const now = (page, box, input) => page.evaluate(([boxSel, inputSel]) => {
  const root = window.__pipsRoot || document, rect = (n) => { const r = n.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), height: Math.round(r.height) }; };
  const seen = (n) => !!n && n.getClientRects().length > 0 && getComputedStyle(n).visibility !== "hidden";
  const pill = root.querySelector('.rail-chip[data-kind="paste"]'), line = pill?.closest(".rail-line") || root.querySelector(".rail-line"), pop = root.querySelector(".rail-pop:not([hidden])");
  const boxNode = root.querySelector(boxSel), words = [...root.querySelectorAll("#pastebar, .paste-note")];
  const act = line?.querySelector(".rail-solo-act");
  const focus = root.activeElement || document.activeElement;
  return { pill: pill && !pill.hidden && seen(pill) ? { said: [...pill.children].filter((c) => seen(c) && c.textContent.trim()).map((c) => c.textContent.trim()).join(" "), label: pill.getAttribute("aria-label"), box: rect(pill), cut: [...pill.children].some((c) => c.scrollWidth > c.clientWidth + 1) } : null,
    behindMore: !!pill && pill.hidden, more: line?.querySelector(".rail-more")?.textContent || "",
    line: line && seen(line) ? rect(line) : null, solo: line?.dataset.solo || "", act: act && seen(act) ? act.textContent : "",
    // A strip of its own: the notice's words on screen anywhere but inside the bar's popover.
    strip: words.filter((n) => seen(n) && !n.closest(".rail-pop")).length,
    pop: pop ? { title: pop.querySelector(".rail-pop-title")?.textContent || "", said: [...pop.querySelectorAll(".rail-pop-body p")].filter(seen).map((p) => p.textContent), buttons: [...pop.querySelectorAll(".rail-pop-body button")].filter(seen).map((b) => b.textContent.trim()),
      box: rect(pop), kind: pop.dataset.kind || "" } : null,
    box: rect(boxNode), wide: document.documentElement.clientWidth, sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    focusIn: focus === root.querySelector(inputSel) ? "box" : focus?.closest?.(".rail-pop") ? "popover" : focus?.classList?.contains("rail-chip") ? "pill" : "elsewhere" };
}, [box, input]);
const click = (page, sel) => page.evaluate((s) => (window.__pipsRoot || document).querySelector(s).click(), sel);

const CHATS = {
  Work: { box: "#cbox", input: "#input", open: async ({ theme, width, kinds = [], queued = 0 }) => { const x = await openRailScene(browser, { width, height: 620, theme: theme === "dark" ? "dark-modern" : "light-modern", kinds, queued }); return { page: x.page, errors: x.errors, close: () => x.page.close() }; } },
  ChatDGC: { box: "#cd-box", input: "#cd-input", open: async ({ theme, width }) => { const x = await openChatDgc(browser, { width, height: 620, theme: theme === "dark" ? "dark-modern" : "light-modern" }); return { page: x.page, errors: x.errors, close: () => x.page.close() }; } },
  "a Pip's chat": { box: "#chat-form", input: "#chatText", open: async ({ theme, width }) => { const x = await openPip(browser, { width, height: 620, theme, where: width > 400 ? "tab" : "side" }); return { page: x.p, errors: x.errors, close: () => x.close() }; } },
};

for (const [name, chat] of Object.entries(CHATS)) for (const theme of ["dark", "light"]) for (const width of [700, 300]) {
  test(`${name}, ${theme} ${width}px: a cleaned paste is a pill on the bar, never a strip of its own; it opens what was taken, and Dismiss takes it away`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await chat.open({ theme, width });
    try {
      const before = await now(x.page, chat.box, chat.input);
      assert.equal(before.pill, null, "nothing pasted: no pill");
      await paste(x.page, chat.input);
      let s = await now(x.page, chat.box, chat.input);
      assert.equal(s.strip, 0, "no strip of its own between the bar and the box");
      assert.ok(s.pill, "the pill is on the bar");
      assert.equal(s.solo, "paste", "alone on the bar");
      assert.equal(s.pill.label, SENTENCE, "its spoken name is the whole sentence");
      if (width >= 700) { assert.equal(s.pill.said, SENTENCE, "alone, it says the whole sentence"); assert.equal(s.pill.cut, false, "none of it cut"); }
      else assert.match(s.pill.said, /^Removed 5 invisible/, "alone on a narrow bar it starts the sentence (the rest is one click away)");
      assert.equal(s.act, "Dismiss", "with its one action at the end of the line");
      assert.equal(s.line.height, 36, "the bar is its one line");
      assert.ok(s.line.bottom <= s.box.top + 6 && s.line.bottom >= s.box.top - 6, "and sits on the box");
      assert.deepEqual([s.box.bottom, s.box.left, s.box.right], [before.box.bottom, before.box.left, before.box.right], "the box has not moved");
      assert.equal(s.sideways, false, "nothing runs off the side");
      assert.equal(s.focusIn, "box", "typing carries on in the box");

      await click(x.page, '.rail-chip[data-kind="paste"]');
      await x.page.waitForTimeout(250);
      s = await now(x.page, chat.box, chat.input);
      assert.ok(s.pop, "the pill opens its popover");
      assert.equal(s.pop.title, "Pasted text");
      assert.deepEqual(s.pop.said, [SENTENCE, TAKEN], "the sentence, and what was taken kind by kind");
      assert.deepEqual(s.pop.buttons, ["Dismiss"], "and one thing to press");
      assert.ok(s.pop.box.bottom <= s.line.top + 1 && s.pop.box.left >= 0 && s.pop.box.right <= s.wide, "just above the bar, inside the window");
      assert.equal(s.focusIn, "popover", "the focus goes into it");
      await x.page.keyboard.press("Escape");
      s = await now(x.page, chat.box, chat.input);
      assert.equal(s.pop, null, "Esc closes it"); assert.equal(s.focusIn, "pill", "and the focus is back on the pill"); assert.ok(s.pill, "which is still there");

      await click(x.page, '.rail-chip[data-kind="paste"]');
      await x.page.waitForTimeout(150);
      await x.page.evaluate(() => (window.__pipsRoot || document).querySelector(".rail-pop:not([hidden]) .rail-pop-body button").click());
      await x.page.waitForTimeout(250);
      s = await now(x.page, chat.box, chat.input);
      assert.equal(s.pill, null, "Dismiss takes the pill away"); assert.equal(s.pop, null, "and its popover"); assert.equal(s.strip, 0);
      assert.equal(s.focusIn, "box", "and the focus is in the box again");
      assert.deepEqual([s.box.bottom, s.box.left, s.box.right], [before.box.bottom, before.box.left, before.box.right], "the box has still not moved");

      // The line's own Dismiss does the same, without opening anything.
      await paste(x.page, chat.input, "a​b");
      s = await now(x.page, chat.box, chat.input);
      assert.equal(s.pill?.label, "Removed 1 invisible character from the pasted text", "one character is said in the singular");
      await x.page.evaluate(() => (window.__pipsRoot || document).querySelector(".rail-solo-act").click());
      await x.page.waitForTimeout(200);
      assert.equal((await now(x.page, chat.box, chat.input)).pill, null);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

for (const theme of ["dark", "light"]) for (const width of [700, 300]) {
  test(`Work, ${theme} ${width}px: beside other pills the paste pill is "Removed 5" on the same one line, and goes behind "+N" first when the bar is short`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await CHATS.Work.open({ theme, width, kinds: ["goal", "tasks", "changes"], queued: 2 });
    try {
      const before = await now(x.page, "#cbox", "#input");
      await paste(x.page, "#input");
      const s = await now(x.page, "#cbox", "#input");
      assert.equal(s.strip, 0, "no strip of its own");
      assert.equal(s.line.height, 36, "one line, as before the paste"); assert.equal(s.line.height, before.line.height);
      assert.deepEqual([s.box.top, s.box.bottom], [before.box.top, before.box.bottom], "the box has not moved");
      if (width >= 700) { assert.equal(s.pill?.said, "Removed 5", "its short form"); assert.equal(s.act, "", "no line action while it shares the bar"); }
      else { assert.equal(s.behindMore, true, "it is the first to go behind +N"); assert.equal(s.more, "+1"); }
      assert.equal(s.sideways, false);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}
