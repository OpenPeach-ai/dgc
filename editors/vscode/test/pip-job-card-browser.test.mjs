// @ a Pip (Pips API 111) in real Chromium: the job's card in a ChatDGC reply (the page src/chatdgc.ts serves, with its
// own scripts and media/main.css, so the same shared card Work and a Pip's chat draw: media/shared/pipjob.js) at 300,
// 440 and 700 px, dark and light. Read from the DOM, computed style and geometry: the Pip's face and "answered", its
// answer, the change line, Apply as the one filled button and Review beside it in the family's 6 px corner and a button
// height, words whole, Discard and Open its chat as links, nothing sideways; Review opens the file and its diff in
// place; Apply sends the change's own command with the digest DGC showed; the turn that told the chat is the Pip's own
// quiet note. With DGC_PICTURES_DIR set, each width and theme is also a picture.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openChat } from "./support/chat-scene.mjs";

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
before(async () => { if (!chromium) return; try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; } });
after(async () => { await browser?.close(); });
const PICTURES = process.env.DGC_PICTURES_DIR || "";
if (PICTURES) mkdirSync(PICTURES, { recursive: true });

const CONV = "c_" + "1".repeat(24), JOB = "pipjob_" + "a".repeat(32), PIP = "pip_" + "b".repeat(32), CHANGE = "pchange_" + "c".repeat(32);
const M = (n) => "m_" + String(n).padStart(24, "0");
const at = new Date(Date.now() - 4 * 60 * 1000).toISOString();
const job = (over = {}) => ({ id: JOB, pip: { id: PIP, name: "Tax check", pip_type: "lens", status: "active" },
  words: "check billing/tax.py's rounding and fix it if it's wrong", about: "", asked_from: { kind: "chatdgc", id: CONV, title: "GST questions" },
  state: "done", state_words: "Answered", folder: { name: "lime_tiles", own: true },
  answer: "The rounding was half-down, so 2.345 came out as 2.34. I changed it to round half up with Decimal in my copy; the tax tests pass.",
  change: { id: CHANGE, status: "pending", name: "lime_tiles", digest: "d".repeat(64), files: [{ path: "billing/tax.py", change: "modified", plus: 6, minus: 2 }],
            more: 0, plus: 6, minus: 2, result: null },
  created_at: at, updated_at: at, ended_at: at, ...over });

async function scene(width, theme, first = job()) {
  const s = await openChat(browser, { width, height: 900, theme, scale: 1 });
  const answered = new Set();
  let now = first;
  const serve = async () => {
    for (const m of await s.posted("pipJob")) {
      if (answered.has(m.id)) continue;
      answered.add(m.id);
      const type = m.request?.type;
      if (type === "apply_pip_project_change") now = job({ change: { ...job().change, status: "applied", result: { applied: ["billing/tax.py"], held_back: [] } } });
      const result = type === "get_pip_job" ? { job: now } : type === "get_pip_project_change"
        ? { diff: "--- a/billing/tax.py\n+++ b/billing/tax.py\n@@ -10,3 +10,4 @@\n-    return round(amount * rate, 2)\n+    from decimal import Decimal, ROUND_HALF_UP\n+    return float(Decimal(amount * rate).quantize(Decimal('0.01'), ROUND_HALF_UP))\n" } : {};
      await s.send({ type: "pipJobReply", id: m.id, ok: true, result });
    }
  };
  await s.send({ type: "opened", conversation: { id: CONV, title: "GST questions", model: null, thinking: null, pinned: false, archived: false, temporary: false },
    earlier: 0, busy: false, messages: [
      { id: M(1), role: "user", text: "Tax check check billing/tax.py's rounding and fix it if it's wrong", created_at: at },
      { id: M(2), role: "assistant", text: "Tax check has it: it's working in its own copy of lime_tiles.", created_at: at, finish: "stop", model: "m",
        actions: [{ kind: "pip_job", id: "act_" + "e".repeat(32), job: JOB, pip: { id: PIP, name: "Tax check", pip_type: "lens" },
                    words: "check billing/tax.py's rounding", status: "working", created_at: at }] },
      { id: M(3), role: "user", text: "A Pip answered a job this chat handed it.", created_at: at, wakeup: { id: JOB, why: "Tax check · answered", at } },
      { id: M(4), role: "assistant", text: "Tax check fixed the rounding in its copy: Apply on its card puts it in your folder.", created_at: at, finish: "stop", model: "m" }] });
  for (let i = 0; i < 40; i++) {
    await serve();
    if (await s.page.locator(`.pipjob[data-state="${first.state}"]`).count() && (first.state !== "done" || await s.page.locator(".pipjob .pipjob-change").count())) break;
    await s.page.waitForTimeout(50);
  }
  return { s, serve, set: (value) => { now = value; } };
}

const look = (page, selector) => page.evaluate((sel) => {
  const n = document.querySelector(sel); if (!n) return null;
  const r = n.getBoundingClientRect(), c = getComputedStyle(n);
  return { left: r.left, right: r.right, width: r.width, height: Math.round(r.height), radius: c.borderTopLeftRadius,
           cut: n.scrollWidth > n.clientWidth + 1, shown: n.checkVisibility({ visibilityProperty: true }), text: n.textContent.replace(/\s+/g, " ").trim() };
}, selector);

for (const theme of ["dark-modern", "light-modern"]) for (const width of [300, 440, 700]) {
  test(`${theme} at ${width}px: the job's card, its answer, its change and Apply, Review and Discard`, async (t) => {
    if (skipOrFail(t)) return;
    const { s, serve } = await scene(width, theme);
    try {
      assert.deepEqual(s.errors, [], "no page errors");
      const title = await look(s.page, ".pipjob .dgc-card-title");
      assert.equal(title?.text, "Tax check answered");
      assert.match((await look(s.page, ".pipjob .dgc-card-sub")).text, /^4m · for this chat · Open its chat$/);
      assert.ok(await s.page.locator(".pipjob .dgc-card-face svg, .pipjob .dgc-card-face .pipjob-letter").count(), "the Pip's face");
      assert.match((await look(s.page, ".pipjob .pipjob-answer")).text, /round half up with Decimal/);
      assert.equal((await look(s.page, ".pipjob .pipjob-change")).text, "1 file · +6 −2 · not in your folder yet");
      for (const [selector, what] of [['.pipjob [data-pipjob-act="apply"]', "Apply"], ['.pipjob [data-pipjob-act="review"]', "Review"]]) {
        const b = await look(s.page, selector);
        assert.ok(b?.shown, `${what} shows`);
        assert.equal(b.radius, "6px", `${what}: the family's corner, never a pill`);
        assert.ok([26, 28].includes(b.height), `${what}: a button height (${b.height})`);
        assert.equal(b.cut, false, `${what} says its words whole`);
        assert.equal(b.text, what);
      }
      const card = await look(s.page, ".pipjob");
      for (const selector of ['.pipjob [data-pipjob-act="discard"]', '.pipjob [data-pipjob-act="open"]']) {
        const b = await look(s.page, selector);
        assert.ok(b.shown && !b.cut && b.left >= card.left - 1 && b.right <= card.right + 1, `${selector} inside the card, whole`);
      }
      assert.equal(await s.page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, "nothing scrolls sideways");
      const note = await look(s.page, ".cd-pip-job .cd-wake-words");
      assert.equal(note?.text, "Tax check answered", "the turn that told the chat is the Pip's note, never a bubble");
      if (PICTURES) await s.page.locator(".pipjob").first().screenshot({ path: join(PICTURES, `chatdgc-${theme.split("-")[0]}-${width}.png`) });
      // Review: the file and its diff, in place.
      await s.page.click('.pipjob [data-pipjob-act="review"]');
      await s.page.click('.pipjob [data-pipjob-act="file"]');
      for (let i = 0; i < 20 && !(await s.page.locator(".pipjob .pipjob-diff").count()); i++) { await serve(); await s.page.waitForTimeout(40); }
      assert.match((await look(s.page, ".pipjob .pipjob-diff")).text, /ROUND_HALF_UP/);
      assert.equal(await s.page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, "the diff scrolls inside its box");
      if (PICTURES && width === 440) await s.page.locator(".pipjob").first().screenshot({ path: join(PICTURES, `chatdgc-review-${theme.split("-")[0]}-${width}.png`) });
      // Apply: the change's own command, with the digest DGC showed; then the card says it's in the folder, with Undo.
      await s.page.click('.pipjob [data-pipjob-act="apply"]');
      for (let i = 0; i < 40 && !(await s.page.locator('.pipjob [data-pipjob-act="undo"]').count()); i++) { await serve(); await s.page.waitForTimeout(40); }
      const sent = (await s.posted("pipJob")).find((m) => m.request?.type === "apply_pip_project_change");
      assert.deepEqual(sent.request, { type: "apply_pip_project_change", pip_id: PIP, change_id: CHANGE, expected_digest: "d".repeat(64) });
      assert.equal((await look(s.page, ".pipjob .pipjob-change")).text, "1 file · +6 −2 · applied to your folder");
      assert.ok((await look(s.page, '.pipjob [data-pipjob-act="undo"]')).shown);
    } finally { await s.page.close(); }
  });
}

test("a job still working, waiting for you, or queued says so in words", async (t) => {
  if (skipOrFail(t)) return;
  for (const [value, words] of [[job({ state: "working", state_words: "Working in its own copy", answer: undefined, change: null }), "Tax check is on it"],
                                [job({ state: "asking", state_words: "Waiting for you in Tax check's chat", answer: undefined, change: null }), "Waiting for you in Tax check's chat"],
                                [job({ state: "queued", state_words: "Starts after its current reply", answer: undefined, change: null }), "Tax check has the job"]]) {
    const { s } = await scene(440, "dark-modern", value);
    try {
      assert.equal((await look(s.page, ".pipjob .dgc-card-title")).text, words);
      assert.ok((await look(s.page, '.pipjob [data-pipjob-act="open"]')).shown, "with a way to open its chat");
      if (PICTURES) await s.page.locator(".pipjob").first().screenshot({ path: join(PICTURES, `chatdgc-${value.state}-dark-440.png`) });
    } finally { await s.page.close(); }
  }
});
