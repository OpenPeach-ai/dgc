// @ a Pip (Pips API 111) in a Pip's own chat, in real Chromium: the side bar's real page with the real Pips view on the
// stand-in DGC (test/support/one-pips-scene.mjs), at 300, 440 and 700 px, dark and light. GST watchdog was handed a job
// from a Work session: its chat shows the job as DGC's "From <where it was asked>: <the words>" line above its answer
// (never a bubble of yours), with a link back there; its @ menu says where each other Pip works; a second job, from a ChatDGC chat, waits at Ask me first as a card
// with Start and Not now. Mornings handed GST watchdog a job from its own chat: the card under the reply that handed it
// is the same shared card Work and ChatDGC draw (media/shared/pipjob.js). Read from the DOM and geometry; with
// DGC_PICTURES_DIR set, each width and theme is also a picture.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { GST, LIME, MORNINGS, P, openOnePips } from "./support/one-pips-scene.mjs";

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

const hex = (c) => c.repeat(32);
const JOB = "pipjob_" + hex("a"), ASKING = "pipjob_" + hex("b"), HANDED = "pipjob_" + hex("c"), CHANGE = "pchange_" + hex("9");
const at = new Date(Date.now() - 6 * 60000).toISOString();
const view = (id, over = {}) => ({ id, pip: { id: GST, name: "GST watchdog", pip_type: "rook", status: "active" }, words: "check the credit-note code before I commit", about: "",
  asked_from: { kind: "work", id: "sess-tidy", title: "Tidy the October invoices" }, state: "done", state_words: "Answered",
  answer: "The credit-note code is fine but for one thing: the GST on a partial return is worked out on the full invoice. I fixed that in my copy.",
  folder: { name: "lime_tiles", own: true }, change: null, created_at: at, updated_at: at, ended_at: at, ...over });
const chat = {
  [GST]: { messages: [
    { id: "msg_" + hex("1"), role: "user", intro: true, text: "This message is from DGC, not the user. A job for you came from the user's Work session.", run_id: "run_" + hex("1"), status: "succeeded",
      job: view(JOB, { change_id: CHANGE }) },
    { id: "msg_" + hex("2"), role: "assistant", text: "The credit-note code is fine but for one thing: the GST on a partial return is worked out on the full invoice. I fixed that in my copy; tests pass.", run_id: "run_" + hex("1"), status: "succeeded" }],
    asking_jobs: [view(ASKING, { state: "asking", state_words: "Waiting for you in GST watchdog's chat", words: "what changed in the GST rules this month?", answer: undefined,
      asked_from: { kind: "chatdgc", id: "c_" + "1".repeat(24), title: "GST questions" }, folder: null })] },
  [MORNINGS]: { messages: [
    { id: "msg_" + hex("3"), role: "user", text: "Ask GST watchdog to check the credit-note code", run_id: "run_" + hex("3"), status: "succeeded" },
    { id: "msg_" + hex("4"), role: "assistant", text: "GST watchdog has it.", run_id: "run_" + hex("3"), status: "succeeded",
      pip_jobs: [view(HANDED, { state: "working", state_words: "Working in its own copy", answer: undefined, asked_from: { kind: "pip", id: MORNINGS, title: "Mornings" } })] }] },
};

async function scene(width, theme) {
  return openOnePips(browser, { width, theme, api: 111, height: 900, faces: true, scene: { chat, answers: {
    get_pip_job: { job: view(HANDED, { asked_from: { kind: "pip", id: MORNINGS, title: "Mornings" },
      change: { id: CHANGE, status: "pending", name: "lime_tiles", digest: "d".repeat(64), files: [{ path: "billing/credit_note.py", change: "modified", plus: 6, minus: 2 }], more: 0, plus: 6, minus: 2, result: null } }) },
    start_pip_job: { job: view(ASKING, { state: "queued", state_words: "Starts after its current reply" }) },
  } } });
}
const look = (x, selector) => x.inPips((root, s) => {
  const n = root.querySelector(s); if (!n) return null;
  const r = n.getBoundingClientRect(), c = getComputedStyle(n);
  return { left: r.left, right: r.right, height: Math.round(r.height), radius: c.borderTopLeftRadius, cut: n.scrollWidth > n.clientWidth + 1,
           shown: n.checkVisibility({ visibilityProperty: true }), text: n.textContent.replace(/\s+/g, " ").trim() };
}, selector);
const sideways = (x) => x.page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);

for (const theme of ["dark-modern", "light-modern"]) for (const width of [300, 440, 700]) {
  test(`${theme} at ${width}px: the job's From line, the Ask me first card, and the card under the reply that handed one`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await scene(width, theme);
    try {
      await x.openPip(GST);
      await x.waitIn(".pipjob-from");
      const from = await look(x, ".pipjob-from");
      assert.equal(from.text, "From your Work session Tidy the October invoices: check the credit-note code before I commit");
      assert.ok(from.shown);
      assert.equal(await x.inPips((root) => root.querySelector(".pipjob-from").closest(".pip-message.user")), null, "DGC's line, never a bubble of yours");
      assert.match((await look(x, ".pip-message.assistant")).text, /partial return is worked out on the full invoice/);
      const asking = await look(x, ".pipjob-asking");
      assert.match(asking.text, /A job from “GST questions”/);
      assert.match(asking.text, /It waits for your Start/);
      for (const [selector, what] of [['.pipjob-asking [data-pipjob-act="start"]', "Start"], ['.pipjob-asking [data-pipjob-act="decline"]', "Not now"]]) {
        const b = await look(x, selector);
        assert.ok(b?.shown, `${what} shows`); assert.equal(b.radius, "6px", `${what}: the family's corner`);
        assert.ok([26, 28].includes(b.height), `${what}: a button height (${b.height})`); assert.equal(b.cut, false, `${what} whole`);
      }
      assert.equal(await sideways(x), false, "nothing scrolls sideways");
      // Its @ menu: every other Pip, each saying where it works in plain words (never a version or an id).
      await x.inPips((root) => root.querySelector("#chatText")?.focus()); await x.page.keyboard.type("@Mor");
      await x.waitIn("#chat-pop .pi");
      assert.deepEqual(await x.inPips((root) => [...root.querySelectorAll("#chat-pop .pi")].map((n) => [n.querySelector(".pi-label")?.textContent.trim(), n.querySelector(".pd")?.textContent.trim()])),
        [["Mornings", "No folder"]]);
      await x.page.keyboard.press("Escape"); for (let i = 0; i < 4; i++) await x.page.keyboard.press("Backspace");
      if (PICTURES) {
        await x.inPips((root) => root.querySelector(".pipjob-from").scrollIntoView({ block: "start" }));
        await x.page.waitForTimeout(150);
        await x.page.screenshot({ path: join(PICTURES, `pipchat-${theme.split("-")[0]}-${width}.png`) });
      }
      // Start: the person's press, the job's own command.
      await x.click('.pipjob-asking [data-pipjob-act="start"]');
      await x.page.waitForTimeout(400);
      const sent = await x.page.evaluate(() => window.__posted.filter((m) => m.type === "pipsRequest" && m.request?.type === "start_pip_job").map((m) => m.request));
      assert.deepEqual(sent.map((r) => [r.pip_id, r.job_id]), [[GST, ASKING]]);
      // The link back: where it was asked.
      await x.click('.pipjob-from [data-pipjob-act="asker"]');
      await x.page.waitForTimeout(150);
      const opened = await x.posted("pipsOpenAsker");
      assert.deepEqual(opened.map((m) => [m.kind, m.id]), [["work", "sess-tidy"]]);
      // Mornings handed GST watchdog a job: its card under that reply, read with get_pip_job.
      await x.click(".pip-topbar button[aria-label^='Your Pips'], .pip-topbar .pip-back").catch(() => {});
      await x.openPip(MORNINGS);
      await x.waitIn('.pipjob[data-state="done"] .pipjob-change', 25000);
      const card = await look(x, ".pipjob");
      assert.match(card.text, /GST watchdog answered/);
      assert.match((await look(x, ".pipjob .pipjob-change")).text, /1 file · \+6 −2 · not in your folder yet/);
      const apply = await look(x, '.pipjob [data-pipjob-act="apply"]');
      assert.ok(apply.shown && apply.radius === "6px" && !apply.cut, "Apply, the one filled answer");
      assert.equal(await sideways(x), false);
      if (PICTURES) await x.inPips((root) => root.querySelector(".pipjob").scrollIntoView({ block: "center" }));
      if (PICTURES) { await x.page.waitForTimeout(150); await x.page.screenshot({ path: join(PICTURES, `pipchat-handed-${theme.split("-")[0]}-${width}.png`) }); }
    } finally { await x.page.close(); }
  });
}
void P; void LIME;
