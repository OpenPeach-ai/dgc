// A code block's Copy (and a table's) stays in the block's top-right corner when the block is scrolled sideways (his
// report, 25 Nov: in a session, scrolling a long command sideways carried the Copy icon along into the middle of it). In
// real Chromium, in Work, ChatDGC and a Pip's chat: the block scrolls its content, never its corner. The scroller is the
// code (or the table's own box), and the language label and Copy stay where they are.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromiumOrNull } from "./support/look-probe.mjs";

const chromium = await chromiumOrNull();
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

const LONG = "/make design Create a Canvas design named “Rustire Landing Page” with Desktop and Phone artboards, using rustire-web-dashboard/src/pages/landing.tsx and landing.css as the reference.";
// (Cells wrap anywhere, so it is many columns that make a table wider than the chat: a month of daily numbers.)
const COLS = Array.from({ length: 18 }, (_, i) => `Nov ${i + 1}`);
const TABLE = `| Shop | ${COLS.join(" | ")} |\n|---|${COLS.map(() => "---").join("|")}|\n` + ["Lime", "Birch", "Cedar"].map((s, k) => `| ${s} | ${COLS.map((_, i) => String(1000 + 37 * i + k)).join(" | ")} |`).join("\n");
const REPLY = `Send this:\n\n\`\`\`text\n${LONG}\n\`\`\`\n\nThe files:\n\n${TABLE}\n`;
const PROMPT = "Show me here in the Canvas";

async function openWork(width) {
  const { openWorkTab } = await import("./support/work-tab-scene.mjs");
  const { READY } = await import("./support/dgc-look-scene.mjs");
  const x = await openWorkTab(browser, { width, height: 760, theme: "dark-modern" });
  const event = (e) => x.send({ type: "event", event: e });
  await x.send({ type: "session_ready", sessionId: "s1" }); await event(READY);
  await x.page.fill("#input", PROMPT); await x.page.keyboard.press("Enter"); await x.page.waitForTimeout(60);
  const id = String((await x.posted("prompt")).pop()?.requestId || "");
  await event({ type: "prompt_accepted", request_id: id, state: "started" }); await event({ type: "turn_start", turn_id: "t1", prompt: "" });
  await event({ type: "text_delta", text: REPLY }); await event({ type: "stream_end", message_id: "t1:1", phase: "final_answer" });
  await event({ type: "turn_end", turn_id: "t1", reason: "completed", final_message_id: "t1:1", elapsed_seconds: 12 });
  await x.page.waitForTimeout(200);
  return { page: x.page, close: () => x.page.close() };
}
async function openChatDgc(width) {
  const chat = await import("./support/chat-scene.mjs"), at = "2026-11-25T09:30:00Z";
  const x = await chat.openChat(browser, { width, height: 760, theme: "dark-modern" });
  await x.send({ type: "opened", conversation: chat.conversation({ title: "Canvas" }), earlier: 0, busy: false, messages: [
    { id: chat.M(1), role: "user", text: PROMPT, created_at: at },
    { id: chat.M(2), role: "assistant", text: REPLY, created_at: at, finish: "stop", model: "qwen3.8:27b" }] });
  await x.page.waitForTimeout(200);
  return { page: x.page, close: () => x.page.close() };
}
async function openPip(width) {
  const pips = await import("./support/pip-chat-scene.mjs");
  const x = await pips.openChat(browser, { width, height: 760, theme: "dark", where: width > 400 ? "tab" : "side", reply: REPLY, replyTo: PROMPT, scale: 1 });
  await x.p.waitForSelector("pre.code"); await x.p.waitForTimeout(200);
  return { page: x.p, close: x.close };
}

// Scroll each block all the way sideways and read where its Copy is, against the block, before and after.
const measure = (page, block) => page.evaluate((sel) => {
  const find = (root, s) => { const hit = root.querySelector(s); if (hit) return hit; for (const n of root.querySelectorAll("*")) { const inner = n.shadowRoot && find(n.shadowRoot, s); if (inner) return inner; } return null; };
  const box = find(document, sel); if (!box) return null;
  const copy = box.querySelector(":scope > .copy"); if (!copy) return { copy: false };
  const scroller = [box, ...box.querySelectorAll(":scope > code, :scope > .md-table-scroll")].find((n) => n.scrollWidth > n.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(n).overflowX));
  const at = () => { const b = box.getBoundingClientRect(), c = copy.getBoundingClientRect(); return { right: Math.round(b.right - c.right), top: Math.round(c.top - b.top) }; };
  const before = at();
  if (!scroller) return { copy: true, scrolls: false, before };
  scroller.scrollLeft = scroller.scrollWidth;
  const after = at();
  return { copy: true, scrolls: true, moved: scroller.scrollLeft, before, after, scroller: scroller === box ? "the block itself" : scroller.className || scroller.tagName };
}, block);

for (const [name, open] of [["Work", openWork], ["ChatDGC", openChatDgc], ["a Pip's chat", openPip]]) for (const width of [700, 360]) {
  test(`${name} at ${width}px: scrolled sideways, a code block's and a table's Copy stay in the corner`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open(width);
    try {
      for (const block of ["pre.code", ".md-table-wrap"]) {
        const m = await measure(x.page, block);
        assert.ok(m && m.copy, `${block} has its Copy (${JSON.stringify(m)})`);
        if (block === ".md-table-wrap" && !m.scrolls) { assert.ok(width >= 640, `the wide table scrolls in a narrow chat (${JSON.stringify(m)})`); continue; }   // (it fits at 700)
        assert.ok(m.scrolls && m.moved > 40, `${block} is wider than the chat and scrolls (${JSON.stringify(m)})`);
        assert.deepEqual(m.after, m.before, `${block}: its Copy stays where it was (${JSON.stringify(m)})`);
        assert.notEqual(m.scroller, "the block itself", `${block}: its content scrolls, not its corner`);
      }
    } finally { await x.close(); }
  });
}
