// The 16 Nov pass's pictures: node test/render-uir2a.mjs <out dir> [section ...]. Each section draws the real pages in
// Chromium (test/support/uir2a-scene.mjs) and writes PNGs named <section>-<what>-<theme>-<width>.png. Not a test.
import { mkdirSync } from "node:fs";
import { chromiumOrNull } from "./support/look-probe.mjs";
import * as S from "./support/uir2a-scene.mjs";

const [out = "/tmp/uir2a", ...only] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const chromium = await chromiumOrNull();
const browser = await chromium.launch({ args: S.launchArgs });
const WIDTHS = [300, 440, 700], PAIR = ["dark-modern", "light-modern"];
const shot = (page, name, clip) => page.screenshot({ path: `${out}/${name}.png`, ...(clip ? { clip } : {}) });
const deep = (page, fn, arg) => page.evaluate(fn, arg);
const scrollUp = (page, sel, by = 400) => page.evaluate(([s, d]) => { const find = (root) => root.querySelector(s) || [...root.querySelectorAll("*")].map((n) => n.shadowRoot && find(n.shadowRoot)).find(Boolean);
  const box = find(document); box.dispatchEvent(new WheelEvent("wheel", { deltaY: -d, bubbles: true })); box.scrollTop -= d; }, [sel, by]).then(() => page.waitForTimeout(150));
const sections = {};

// 67: Latest over the transcript's words, in a theme whose input ground is see-through (and an ordinary one).
sections.latest = async () => {
  for (const theme of ["cursor-dark", "light-cursor"]) for (const width of WIDTHS) {
    const w = await S.openWork(browser, { theme, width }); await scrollUp(w.page, "#log", 380); await shot(w.page, `latest-work-${theme}-${width}`); await w.page.close();
    const c = await S.openChatDgc(browser, { theme, width }); await scrollUp(c.page, "#cd-scroll", 380); await shot(c.page, `latest-chat-${theme}-${width}`); await c.page.close();
    const p = await S.openPip(browser, { theme, width, scale: 2 }); await scrollUp(p.page, ".conversation-log", 380); await shot(p.page, `latest-pip-${theme}-${width}`); await p.close();
  }
};

// 68: sent bubbles on the three surfaces: one line, a long one (folded and opened in Work, whole in ChatDGC and a Pip's chat).
sections.bubbles = async () => {
  for (const theme of PAIR) for (const width of WIDTHS) {
    const w = await S.openWork(browser, { theme, width, prompts: ["Where is the upload limit read?", S.LONG], running: true });
    await w.say("And keep 20 as the default");
    // The short prompt's answer is cut to a few lines, so the one-line bubble and the long one are in one picture.
    const toLong = () => w.page.evaluate(() => { const log = document.getElementById("log"), turn = document.querySelector("#log .bubble[data-fold]");
      log.scrollTop += turn.getBoundingClientRect().top - log.getBoundingClientRect().top - 150; });
    await toLong(); await w.page.waitForTimeout(150);
    await w.page.hover("#log .bubble[data-fold]"); await w.page.waitForTimeout(200);
    await shot(w.page, `bubbles-work-folded-${theme}-${width}`);
    await w.page.evaluate(() => document.querySelector("#log .prompt-fold")?.click()); await w.page.waitForTimeout(200);
    await toLong(); await w.page.waitForTimeout(100);
    await shot(w.page, `bubbles-work-open-${theme}-${width}`);
    await w.page.evaluate(() => { const log = document.getElementById("log"); log.scrollTop = log.scrollHeight; }); await w.page.waitForTimeout(150);
    await shot(w.page, `bubbles-work-steer-${theme}-${width}`); await w.page.close();
    const c = await S.openChatDgc(browser, { theme, width, prompts: ["Where should we stay in the south?", S.LONG] });
    await c.page.evaluate(() => { document.getElementById("cd-scroll").scrollTop = 0; }); await c.page.waitForTimeout(150);
    await shot(c.page, `bubbles-chat-${theme}-${width}`);
    await c.page.evaluate(() => { const b = document.querySelectorAll(".cd-bubble")[1]; b.scrollIntoView({ block: "start" }); }); await c.page.waitForTimeout(150);
    await shot(c.page, `bubbles-chat-long-${theme}-${width}`); await c.page.close();
    const p = await S.openPip(browser, { theme, width, scale: 2, said: [{ role: "user", text: S.LONG }, { role: "assistant", text: "Noted: one number per plan, 20 by default." }] });
    await shot(p.page, `bubbles-pip-${theme}-${width}`);
    await p.page.evaluate(() => { const root = window.__pipsRoot || document, log = root.querySelector(".conversation-log"), all = root.querySelectorAll(".pip-message.user"), long = all[all.length - 1];
      log.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true })); log.scrollTop += long.getBoundingClientRect().top - log.getBoundingClientRect().top - 120; }); await p.page.waitForTimeout(200);
    await shot(p.page, `bubbles-pip-long-${theme}-${width}`); await p.close();
  }
};

// 66: a queued message, its Edit, the question when the box has a draft, and the message back in the box (Work, a Pip).
sections.queue = async () => {
  for (const theme of PAIR) for (const width of WIDTHS) {
    const w = await S.openWorkQueue(browser, { theme, width });
    const { id } = await w.queue("Also add a note to the changelog", { skill: true, output: "slides" }); await w.queue("And run the whole suite at the end");
    await w.openRows(); await w.page.hover('#queue-list .dgc-queue-row:nth-child(1) [data-queue-role="edit"]'); await w.page.waitForTimeout(150);
    await shot(w.page, `queue-work-rows-${theme}-${width}`);
    await w.page.click("#input"); await w.page.keyboard.type("half a thought"); await w.openRows();
    await w.page.click('#queue-list .dgc-queue-row:nth-child(1) [data-queue-role="edit"]'); await w.page.waitForTimeout(150);
    await shot(w.page, `queue-work-ask-${theme}-${width}`);
    await w.page.click('#queue-list [data-queue-role="ask-replace"]'); await w.event({ type: "queue_changed", removed: id, order: [], count: 1 }); await w.page.waitForTimeout(200);
    await shot(w.page, `queue-work-edited-${theme}-${width}`); await w.page.close();
    const p = await S.openPip(browser, { theme, width, scale: 2, said: [], running: true }), q = p.page;
    await q.waitForFunction(() => /mid-turn/.test((window.__pipsRoot || document).querySelector(".chat-send")?.getAttribute("aria-label") || ""));
    for (const text of ["Add the weather too", "And keep it under five lines"]) { await q.click("#chatText"); await q.keyboard.type(text); await q.keyboard.press("Alt+Enter"); await q.waitForTimeout(80); }
    await q.click('#chat-tray .rail-chip[data-kind="queue"]'); await q.hover('#chat-queue .dgc-queue-row:nth-child(1) [data-queue-role="edit"]'); await q.waitForTimeout(150);
    await shot(q, `queue-pip-rows-${theme}-${width}`);
    await q.click('#chat-queue .dgc-queue-row:nth-child(1) [data-queue-role="edit"]'); await q.waitForTimeout(200);
    await shot(q, `queue-pip-edited-${theme}-${width}`);
    if (!(await q.locator("#chat-queue .dgc-queue-row").first().isVisible())) await q.click('#chat-tray .rail-chip[data-kind="queue"]');
    await q.click('#chat-queue .dgc-queue-row:nth-child(1) [data-queue-role="edit"]'); await q.waitForTimeout(200);
    await shot(q, `queue-pip-ask-${theme}-${width}`); await p.close();
  }
};

// 65: the strip of 8 pictures, part-way along (a fade on both edges), and at its start.
sections.strip = async () => {
  for (const theme of PAIR) for (const width of WIDTHS) {
    const x = await S.openViewedImages(browser, { theme, width, count: 8, tail: 2 });
    await shot(x.page, `strip-start-${theme}-${width}`);
    const box = await x.page.locator(".tool-images").boundingBox(); await x.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await x.page.mouse.wheel(0, 420); await x.page.waitForTimeout(350);
    await shot(x.page, `strip-mid-${theme}-${width}`); await x.page.close();
  }
};

// 59: a Pip's reply with a picture, a video and a zip it sent; your own file on your message.
sections.pipfiles = async () => {
  for (const theme of PAIR) for (const width of WIDTHS) {
    const x = await S.openPipFiles(browser, { theme, width, height: 900, scale: 2 });
    await x.page.waitForFunction(() => { const v = (window.__pipsRoot || document).querySelector(".pip-message.assistant video"); return v && v.readyState >= 2; }, null, { timeout: 8000 }).catch(() => {});
    // (A frame from the middle of the clip, once the player has it; then the reply from its first line.)
    await x.page.evaluate(() => new Promise((done) => { const v = (window.__pipsRoot || document).querySelector(".pip-message.assistant video"); if (!v) return done();
      v.addEventListener("seeked", () => setTimeout(done, 900), { once: true }); v.currentTime = 1; setTimeout(done, 3000); }));
    await x.page.evaluate(() => { const root = window.__pipsRoot || document, log = root.querySelector(".conversation-log"), reply = [...root.querySelectorAll(".pip-message.assistant")].at(-1);
      log.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true })); log.scrollTop += reply.getBoundingClientRect().top - log.getBoundingClientRect().top - 140; }); await x.page.waitForTimeout(300);
    await shot(x.page, `pipfiles-reply-${theme}-${width}`);
    await x.page.evaluate(() => { const log = (window.__pipsRoot || document).querySelector(".conversation-log"); log.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, bubbles: true })); log.scrollTop = log.scrollHeight; }); await x.page.waitForTimeout(200);
    await shot(x.page, `pipfiles-reply-end-${theme}-${width}`); await x.close();
  }
  for (const theme of PAIR) {
    const a = await S.openPipFiles(browser, { theme, width: 440, height: 900, scale: 2, sent: "audio" }); await a.page.waitForTimeout(600);
    await a.page.evaluate(() => { const log = (window.__pipsRoot || document).querySelector(".conversation-log"); log.scrollTop = log.scrollHeight; }); await a.page.waitForTimeout(200);
    await shot(a.page, `pipfiles-audio-${theme}-440`); await a.close();
    const b = await S.openPipFiles(browser, { theme, width: 440, height: 900, scale: 2, sent: "big" }); await b.page.waitForTimeout(400);
    await shot(b.page, `pipfiles-large-video-${theme}-440`); await b.close();
    const n = await S.openPipFiles(browser, { theme, width: 440, height: 900, scale: 2, media: false }); await n.page.waitForTimeout(500);
    await shot(n.page, `pipfiles-cannot-play-${theme}-440`); await n.close();
  }
};

// The user-test fixes (section A of the triage), each as the tester met it. Run on the tree before the fixes for the
// "before" pictures (the scenes drive both).
sections.usertest = async () => {
  const each = async (name, widths, open, act) => { for (const theme of PAIR) for (const width of widths) { const x = await open({ theme, width }); try { if (act) await act(x); await (x.page).waitForTimeout(250); await shot(x.page, `usertest-${name}-${theme}-${width}`); }
    catch (error) { console.log(`  ${name} ${theme} ${width}: ${String(error).split("\n")[0]}`); } finally { await (x.close ? x.close() : x.page.close()); } } };
  await each("W3-commands-escape", [700], (o) => S.openWork(browser, { ...o, turns: 1, ready: { commands: [{ name: "compact", description: "Make room in the context" }] } }), async (x) => { await x.page.click("#btn-cmd"); await x.page.keyboard.press("Escape"); });
  await each("W10-deny-note", [300, 700], (o) => S.openDenyNote(browser, { ...o, height: o.width === 300 ? 640 : 760 }), async (x) => { await x.page.click('.approval-dock .card button[data-d="deny"]'); await x.page.waitForTimeout(400); });
  await each("W25-card-under-reply", [300, 700], (o) => S.openArtifactTurn(browser, o));
  await each("W27-sub-agents-chip", [700], (o) => S.openAgentsTurn(browser, o));
  await each("W28-long-prompt", [300, 700], (o) => S.openWork(browser, { ...o, prompts: [S.LONG], turns: 0 }), async (x) => { await x.page.mouse.move(2, 2); await x.page.evaluate(() => { document.getElementById("log").scrollTop = 0; }); });
  await each("W30-rewind-note", [700], (o) => S.openWork(browser, { ...o, turns: 2 }), async (x) => { await x.event({ type: "rewound", ok: true, files_restored: 2 });
    await x.event({ type: "history", items: [{ type: "turn_start", turn_id: "h1", prompt: "Question 1: where is the upload limit read?" }, { type: "text_delta", text: "In three places: the route, the worker and the nightly export." },
      { type: "stream_end", message_id: "h1:1", phase: "final" }, { type: "turn_end", turn_id: "h1", reason: "completed", final_message_id: "h1:1" }], complete: true, seq: 1 }); });
  await each("W36-stop", [300, 700], (o) => S.openStopped(browser, o));
  await each("W36-stop-with-a-draft", [700], (o) => S.openStopped(browser, { ...o, draft: "half a thought" }));
  await each("W21-voice-install", [400], (o) => S.openVoiceSettings(browser, o));
  await each("C10-chat-preview", [300], (o) => S.openSideLists(browser, { ...o, tab: "chat" }));
  await each("W34-search-snippet", [300], (o) => S.openSideLists(browser, { ...o, tab: "work" }));
};

for (const [name, run] of Object.entries(sections)) { if (only.length && !only.includes(name)) continue; console.log("section", name); await run(); }
await browser.close();
