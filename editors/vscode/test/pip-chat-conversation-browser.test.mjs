// A Pip's chat as a conversation, in real Chromium: the side bar's real page with the real Pips view in its shadow
// root, on the stand-in DGC with Pips API 97's shapes (test/support/one-pips-scene.mjs, `sub: true`), at 300, 440 and
// 700 px, dark and light, with a mouse and on touch. Read from the DOM, computed style and geometry: the Pip's words
// are Work's prose (the same size, line and colour as Work's own reply in the same page); the permission card, the
// sub-agent's row and the changed-files card sit inside the chat with their answers in the button family's shape
// (6 px corners, the button heights: never a pill); a Pip's sub-agent wears its face in black and white; the prompt
// box stays one line with the sub-agents pill before the model; the agent map opens over the chat, the Pip in colour
// at its root and its sub-agents under it in black and white, and one click opens a sub-agent's card.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { GST, openOnePips } from "./support/one-pips-scene.mjs";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "";
  if (!reason) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

const look = (x, selector) => x.inPips((root, s) => {
  const n = root.querySelector(s); if (!n) return null;
  const r = n.getBoundingClientRect(), c = getComputedStyle(n);
  return { left: Math.round(r.left * 10) / 10, right: Math.round(r.right * 10) / 10, top: Math.round(r.top), bottom: Math.round(r.bottom), width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10,
    radius: c.borderTopLeftRadius, display: c.display, filter: c.filter, shown: n.checkVisibility({ visibilityProperty: true }), text: n.textContent.trim(), cut: n.scrollWidth > n.clientWidth + 1,
    font: c.fontSize, line: c.lineHeight, color: c.color, bg: c.backgroundColor };
}, selector);
const sideways = (x) => x.page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
const open = async (o, scene) => { const x = await openOnePips(browser, { api: 97, height: 900, faces: true, ...o, scene: { sub: true, waiting: false, ...scene } }); await x.openPip(GST); return x; };
const inside = (b, log, what) => assert.ok(b && b.shown && b.left >= log.left - 1 && b.right <= log.right + 1, `${what} is inside the chat (${JSON.stringify(b)})`);
const button = (b, what, heights = [28]) => { assert.ok(b && b.shown, `${what} shows`); assert.equal(b.radius, "6px", `${what}: the family's corner`); assert.ok(heights.includes(b.height), `${what}: a button height (${b.height})`); assert.equal(b.cut, false, `${what} says its word whole`); };

for (const theme of ["dark-modern", "light-modern"]) for (const width of [300, 440, 700]) for (const touch of width === 440 ? [false, true] : [false]) {
  const at = `${theme} at ${width}px${touch ? " on touch" : ""}`;
  test(`${at}: it asks in Work's prose above the permission card, and what it found is a list in its message`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open({ width, theme, touch }, { fix: "ask" });
    try {
      await x.waitIn(".pip-ask-card");
      const log = await look(x, ".conversation-log");
      // Work's own reply, in the same page: the Pip's words read the same.
      const work = await x.page.evaluate(() => { const m = document.createElement("div"); m.className = "msg dgc"; m.innerHTML = '<div class="text final"><p>x</p></div>'; document.getElementById("log").append(m);
        const c = getComputedStyle(m.querySelector("p")); const v = { font: c.fontSize, line: c.lineHeight, color: c.color }; m.remove(); return v; });
      const said = await look(x, ".pip-said p");
      assert.deepEqual({ font: said.font, line: said.line, color: said.color }, work, "the Pip's words are Work's prose");
      assert.equal((await look(x, ".pip-said")).bg, "rgba(0, 0, 0, 0)", "no bubble behind the Pip's words");
      inside(await look(x, ".pip-said-found"), log, "what it found");
      const rows = await x.inPips((root) => [...root.querySelectorAll(".pip-said-found > li")].map((li) => ({ cut: li.scrollWidth > li.clientWidth + 1, link: getComputedStyle(li.querySelector(".md-link")).color, file: li.querySelector(".md-link").getBoundingClientRect().width > 20 })));
      assert.equal(rows.length, 3); assert.ok(rows.every((r) => !r.cut && r.file), JSON.stringify(rows));
      assert.equal(await x.inPips((root) => root.querySelectorAll(".pip-said [data-post-open]").length), 0, "no Open report (25 Nov)");
      const card = await look(x, ".pip-ask-card"); inside(card, log, "the permission card");
      const no = await look(x, ".pip-ask-card [data-flow-no]"), allow = await look(x, ".pip-ask-card [data-flow-allow]");
      button(no, "Not now"); button(allow, "Allow");
      assert.equal(no.top, allow.top, "Not now and Allow on one line"); assert.ok(allow.left > no.right, "Work's order: Allow last");
      assert.ok(allow.right <= card.right - 8 && no.left >= card.left + 8, "inside the card");
      assert.equal((await look(x, ".pip-ask-title")).cut, false);
      assert.equal(await x.inPips((root) => root.querySelector("#chat-agents")), null, "no pill before it has had a sub-agent");
      assert.equal(await sideways(x), false);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`${at}: its sub-agent's row wears its face in black and white; the pill sits before the model on one line; the agent map opens for this Pip`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open({ width, theme, touch }, { fix: "running", talk: true, earlier: 2 });
    try {
      await x.waitIn(".pip-agent-row"); await x.page.waitForTimeout(150);
      const log = await look(x, ".conversation-log");
      inside(await look(x, ".pip-agent-row"), log, "the sub-agent's row");
      const face = await look(x, ".pip-agent-row .pip-agent-face");
      assert.match(face.filter, /grayscale\(1\)/, "black and white"); assert.ok(face.width >= 16 && face.width <= 20);
      const acts = await x.inPips((root) => [...root.querySelectorAll(".pip-agent-actions button")].map((b) => { const r = b.getBoundingClientRect(); return { top: Math.round(r.top), h: r.height, cut: b.scrollWidth > b.clientWidth + 1, text: b.textContent }; }));
      assert.deepEqual(acts.map((a) => a.text), ["Steps", "Watch its computer", "Stop"]);
      assert.ok(acts.every((a) => a.top === acts[0].top && !a.cut), `the row's actions on one line (${JSON.stringify(acts)})`);
      if (touch) assert.ok(acts.every((a) => a.h >= 24), "on touch each is tall enough to press");
      assert.equal((await look(x, ".pip-agent-name")).shown, true);
      // the prompt box: one line, the pill before the model
      const pill = await look(x, "#chat-agents"), model = await look(x, "#chat-model");
      assert.ok(pill.shown); assert.equal(pill.radius, "6px", "never a pill shape");
      assert.ok(Math.abs((pill.top + pill.bottom) / 2 - (model.top + model.bottom) / 2) <= 2, "on the model's line"); assert.ok(pill.right <= model.left + 1, "before the model");
      const textShown = (await look(x, "#chat-agents .agents-text")).shown, shortShown = (await look(x, "#chat-agents .agents-short")).shown;
      assert.equal(textShown, width >= 640, "its words where there is room"); assert.equal(shortShown, width < 640, "the count alone in a narrow box");
      const controls = await x.inPips((root) => { const kids = [...root.querySelectorAll(".composer-controls button")].filter((b) => b.checkVisibility()); const tops = kids.map((b) => { const r = b.getBoundingClientRect(); return Math.round((r.top + r.bottom) / 2); }); return Math.max(...tops) - Math.min(...tops); });
      assert.ok(controls <= 3, `the prompt box's controls stay on one line (${controls})`);
      // the agent map
      await x.click("#chat-agents"); await x.waitIn(".pip-agent-map"); await x.page.waitForTimeout(120);
      const box = await look(x, ".pip-agent-map .agent-map");
      assert.ok(box.left >= 0 && box.right <= width && box.top >= 0 && box.bottom <= 900, `the map is inside the view (${JSON.stringify(box)})`);
      const root = await look(x, ".pip-agent-map .am-root"), agent = await look(x, ".pip-agent-map .am-agent");
      for (const [b, what] of [[root, "the Pip's row"], [agent, "its sub-agent's row"]]) { assert.ok(b.left >= box.left && b.right <= box.right, `${what} is inside the map`); assert.notEqual(b.radius, "999px"); assert.ok(parseFloat(b.radius) <= 10, `${what}: a rounded rectangle`); }
      assert.ok(agent.left > root.left, "its sub-agents under it, indented");
      assert.equal((await look(x, ".pip-agent-map .am-root .am-pip-face")).filter, "none", "the Pip in colour");
      assert.match((await look(x, ".pip-agent-map .am-agent .am-pip-face")).filter, /grayscale\(1\)/, "its sub-agent in black and white");
      assert.equal((await look(x, ".pip-agent-map .am-agent .am-desc")).cut && width >= 440, false);
      await x.click(".pip-agent-map .am-agent"); await x.waitIn(".pip-agent-card"); await x.page.waitForTimeout(80);
      const card = await look(x, ".pip-agent-card .agent-map");
      assert.ok(card.left >= 0 && card.right <= width, "the card is inside the view");
      button(await look(x, ".pip-agent-card [data-agent-stop]"), "Stop", [28, 24]);
      await x.page.keyboard.press("Escape"); await x.page.waitForTimeout(60);
      assert.equal(await x.inPips((r) => !!r.querySelector(".pip-agent-card")), false);
      await x.page.keyboard.press("Escape"); await x.page.waitForTimeout(60);
      assert.equal(await x.inPips((r) => !!r.querySelector(".pip-agent-map")), false);
      assert.equal(await sideways(x), false);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`${at}: when it ends the change is Work's changed-files card: Review and Apply in the family's shape`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open({ width, theme, touch }, { fix: "ready", tries: 2 });
    try {
      await x.waitIn(".pip-change");
      const log = await look(x, ".conversation-log"), card = await look(x, ".pip-change");
      inside(card, log, "the changed-files card");
      const review = await look(x, ".pip-change [data-project-review]"), apply = await look(x, ".pip-change [data-project-apply]");
      button(review, "Review"); button(apply, "Apply");
      assert.equal(review.top, apply.top, "Review and Apply on one line"); assert.ok(apply.left > review.right, "Apply last"); assert.ok(apply.right <= card.right - 4);
      assert.equal((await look(x, ".pip-change-title")).cut, false);
      // Its files start folded, as Work's Edited card's do (24 Nov); the chevron opens them.
      assert.equal(await x.inPips((root) => root.querySelector(".pip-change .pip-project-files").hidden), true, "folded to start");
      await x.click(".pip-change [data-change-fold]"); await x.waitIn(".pip-change .pip-project-files:not([hidden])");
      const files = await x.inPips((root) => [...root.querySelectorAll(".pip-change .pip-project-file")].map((f) => { const r = f.getBoundingClientRect(), c = root.querySelector(".pip-change").getBoundingClientRect(); return r.left >= c.left && r.right <= c.right + 1; }));
      assert.equal(files.length, 2); assert.ok(files.every(Boolean), "each file's row inside the card");
      await x.click(".pip-change [data-change-menu]"); await x.waitIn(".pip-change-menu");
      const menu = await look(x, ".pip-change-menu");
      assert.ok(menu.left >= 0 && menu.right <= width, "its menu is inside the view");
      assert.equal(await sideways(x), false);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

// 25 Nov (reported from a test machine): a Pip whose sub-agents are done shows the pill idle; in a narrow box its words can't
// show, and a lone hollow dot said nothing: it gives way there, and says "Agent map" where there is room.
for (const width of [300, 700]) {
  test(`at ${width}px a Pip's idle sub-agents pill ${width < 640 ? "gives way" : "says Agent map"}`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open({ width, theme: "dark-modern" }, { fix: "applied" });
    try {
      await x.waitIn("#chat-agents");
      const pill = await look(x, "#chat-agents");
      assert.equal(await x.inPips((root) => root.querySelector("#chat-agents").dataset.state), "idle");
      if (width < 640) assert.equal(pill.shown, false, "no hollow dot alone in a narrow box");
      else assert.deepEqual([pill.shown, pill.text.replace(/\s+/g, " ")], [true, "Agent map"]);
    } finally { await x.close(); }
  });
}
