// The three chats (a Work session, ChatDGC, a Pip's chat) with enough said in each to scroll, for the 16 Nov pass's
// tests (uir2a-*.test.mjs) and pictures (render-uir2a.mjs). Built on the scenes each surface already has; themes are
// options-scene.mjs's THEMES ("cursor-dark" and "light-cursor" have a see-through input ground). Not a *.test.mjs file.
import { readFileSync } from "node:fs";
import { openWorkTab } from "./work-tab-scene.mjs";
import { READY } from "./codex-look-scene.mjs";
import { THEMES } from "./options-scene.mjs";
import * as chat from "./chat-scene.mjs";
import * as pips from "./pip-chat-scene.mjs";
import { CLIP_WEBM } from "./uir2a-clip.mjs";

const media = (name) => readFileSync(new URL(`../../media/${name}`, import.meta.url), "utf8");
export const LONG = "The upload limit is one number today, and every plan shares it. ".repeat(14).trim();
export const PARAS = Array.from({ length: 12 }, (_, i) => `Paragraph ${i + 1}: the limit is read in three places, and each of them has to take the plan's own number once it moves into settings.`).join("\n\n");

export const launchArgs = ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"];

/** A Work session: `turns` finished turns (a prompt and a long answer each), so the transcript scrolls.
    opts.running: one more turn still going; opts.capabilities: more of what the backend says it can do; opts.ready:
    more of what it says at the start (its skills). */
export async function openWork(browser, { width = 440, height = 760, theme = "dark-modern", turns = 3, prompts = [], running = false, capabilities = {}, ready = {}, queue = true } = {}) {
  const x = await openWorkTab(browser, { width, height, theme });
  x.page.setDefaultTimeout(8000);
  const event = (e) => x.send({ type: "event", event: e });
  await x.send({ type: "session_ready", sessionId: "s1" });
  await event({ ...READY, ...ready, capabilities: { ...READY.capabilities, ...capabilities } });
  if (queue) { await x.page.addScriptTag({ content: media("messagequeue.js") }); await x.page.addStyleTag({ content: media("messagequeue.css") }); }
  let n = 0;
  const say = async (text, alt) => { await x.page.fill("#input", text); await x.page.keyboard.press(alt ? "Alt+Enter" : "Enter"); await x.page.waitForTimeout(40);
    return String((await x.posted("prompt")).pop()?.requestId || ""); };
  const turn = async (prompt, answer = PARAS, done = true) => {
    const id = await say(prompt); n += 1;
    await event({ type: "prompt_accepted", request_id: id, state: "started" }); await event({ type: "turn_start", turn_id: `t${n}`, prompt: "" });
    if (answer) { await event({ type: "text_delta", text: answer }); await event({ type: "stream_end", message_id: `t${n}:1`, phase: done ? "final" : "commentary" }); }
    if (done) await event({ type: "turn_end", turn_id: `t${n}`, status: "completed", usage: {} });
  };
  const list = prompts.length ? prompts : Array.from({ length: turns }, (_, i) => `Question ${i + 1}: where is the upload limit read?`);
  for (const p of list) await turn(p);
  if (running) await turn(typeof running === "string" ? running : "Now move it into settings.", "Reading `src/upload.py` first.", false);
  await x.page.waitForTimeout(120);
  return { ...x, event, say, turn };
}

/** ChatDGC with a conversation of `turns` prompts and long answers. */
export async function openChatDgc(browser, { width = 440, height = 760, theme = "dark-modern", turns = 3, prompts = [], busy = false } = {}) {
  const at = "2026-11-10T09:30:00Z", x = await chat.openChat(browser, { width, height, theme });
  const list = prompts.length ? prompts : Array.from({ length: turns }, (_, i) => `Question ${i + 1}: where should we stay?`);
  const messages = list.flatMap((text, i) => [{ id: chat.M(2 * i + 1), role: "user", text, created_at: at },
    { id: chat.M(2 * i + 2), role: "assistant", text: PARAS, created_at: at, finish: "stop", model: "qwen3.8:27b" }]);
  await x.send({ type: "opened", conversation: chat.conversation({ title: "A week in Goa in March" }), earlier: 0, busy, messages });
  await x.send({ type: "models", ids: ["qwen3.8:27b"], current: "qwen3.8:27b" });
  await x.page.waitForTimeout(200);
  return { ...x, messages };
}

const PIP_THEME = { "dark-modern": "dark", "light-modern": "light" };
/** A Pip's chat: in the side bar under 400 px, an editor tab above. `theme` may be a see-through one: its tokens are
    laid over the Pip scene's own. */
export async function openPip(browser, { width = 440, height = 760, theme = "dark-modern", said, ...opts } = {}) {
  const base = PIP_THEME[theme] || (theme.startsWith("light") ? "light" : "dark");
  const more = said === undefined ? Array.from({ length: 3 }, (_, i) => [{ role: "user", text: `Question ${i + 1}: which sources?` }, { role: "assistant", text: PARAS }]).flat() : said;
  const x = await pips.openChat(browser, { width, height, theme: base, where: width > 400 ? "tab" : "side", said: more, ...opts });
  x.p.setDefaultTimeout(8000);
  if (!PIP_THEME[theme]) await x.p.addStyleTag({ content: `:root { ${THEMES[theme]} }` });
  await x.p.waitForTimeout(150);
  return { ...x, page: x.p, q: (fn, arg) => x.p.evaluate(fn, arg) };
}

/** How far two pictures of one place differ: the largest step in any channel of any pixel (0: the same). */
export async function pixelGap(page, a, b) {
  const blank = await page.context().browser().newPage();   // (a page of its own: ChatDGC's policy lets its page fetch nothing)
  try { return await blank.evaluate(async ([one, two]) => {
    const read = async (b64) => { const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
      const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext("2d"); g.drawImage(bmp, 0, 0); return g.getImageData(0, 0, bmp.width, bmp.height).data; };
    const [p, q] = [await read(one), await read(two)];
    if (p.length !== q.length) return 999;
    let gap = 0; for (let i = 0; i < p.length; i++) { const d = Math.abs(p[i] - q[i]); if (d > gap) gap = d; }
    return gap;
  }, [a.toString("base64"), b.toString("base64")]); } finally { await blank.close(); }
}

/** A Work session whose last step viewed `count` pictures, the step opened (65). */
export async function openViewedImages(browser, { width = 440, height = 760, theme = "dark-modern", count = 8, tail = 0 } = {}) {
  const x = await openWork(browser, { width, height, theme, turns: 0, capabilities: { image_views: true } });
  const png = (hue, label) => x.page.evaluate(([h, text]) => { const c = document.createElement("canvas"); c.width = 640; c.height = 380; const g = c.getContext("2d");
    const grad = g.createLinearGradient(0, 0, 640, 380); grad.addColorStop(0, `hsl(${h} 65% 42%)`); grad.addColorStop(1, `hsl(${h + 50} 70% 58%)`); g.fillStyle = grad; g.fillRect(0, 0, 640, 380);
    g.fillStyle = "#fff"; g.font = "600 44px sans-serif"; g.fillText(text, 40, 120); g.fillRect(40, 190, 120, 34); return c.toDataURL("image/png"); }, [hue, label]);
  const images = []; for (let i = 0; i < count; i++) images.push(await png(220 + i * 35, `Page ${i + 1}`));
  const id = await x.say("Open the pricing pages and check each one renders");
  await x.event({ type: "prompt_accepted", request_id: id, state: "started" }); await x.event({ type: "turn_start", turn_id: "ti", prompt: "" });
  await x.event({ type: "tool_call", call_id: "ci", name: "browser", args: { operation: "screenshot" }, summary: "screenshot" });
  await x.event({ type: "tool_result", call_id: "ci", name: "browser", output: "screenshots saved", is_error: false, is_diff: false, diff: "" });
  await x.event({ type: "tool_images", call_id: "ci", caption: "browser screenshot", images, items: images.map((_, i) => ({ ref: "img_" + (i + 1).toString(16).padStart(32, "0"),
    name: `page-${i + 1}.png`, mime: "image/png", width: 640, height: 380, bytes: 90 * 1024, source: "browser", host: "shop.example" })) });
  await x.event({ type: "text_delta", text: tail ? Array.from({ length: tail }, (_, i) => `Line ${i + 1}: every page renders.`).join("\n\n") : "Every page renders." });
  await x.event({ type: "stream_end", message_id: "ti:1", phase: "final" }); await x.event({ type: "turn_end", turn_id: "ti", status: "completed", usage: {} });
  await x.page.evaluate(() => { const card = document.querySelector('.tool[data-call-id="ci"]');
    card.closest(".msg.dgc").querySelectorAll(':scope > .work-toggle[aria-expanded="false"]').forEach((row) => row.click());   // "Worked for 3s": the turn's steps, opened
    for (let g = card.closest("details"); g; g = g.parentElement?.closest("details")) if (!g.open) g.querySelector("summary").click();
    if (!card.classList.contains("open")) card.querySelector(".tool-toggle").click(); });
  await x.page.waitForSelector(".tool-images img"); await x.page.waitForTimeout(200);
  return x;
}

export const OUTPUTS = { version: 1, types: ["page", "doc", "slides", "sheet", "dashboard"], outputs: ["auto", "document", "slides", "spreadsheet", "page", "dashboard"] };
/** A Work session mid-reply whose backend lets a queued message be taken out (queue_edit), with the Artifact chip and a
    skill to mark. `queue(text, {skill, output})` queues a message as a person does (Alt+Enter) and answers as DGC does. */
export async function openWorkQueue(browser, { width = 440, height = 760, theme = "dark-modern" } = {}) {
  const x = await openWork(browser, { width, height, theme, turns: 1, running: true, capabilities: { queue_edit: true, artifacts: OUTPUTS, display_mentions: 2 }, ready: { skills: ["fixture"] } });
  let count = 0;
  const queue = async (text, { skill = false, output = "" } = {}) => {
    await x.page.click("#input"); await x.page.keyboard.type(text);
    if (skill) { await x.page.keyboard.type(" $fix"); await x.page.keyboard.press("Tab"); }
    if (output) { await x.page.click("#btn-output"); await x.page.click(`#outputmenu [data-output="${output}"]`); await x.page.click("#input"); }
    await x.page.keyboard.press("Alt+Enter"); await x.page.waitForTimeout(60);
    const sent = (await x.posted("prompt")).pop(), id = String(sent.requestId);
    await x.event({ type: "prompt_accepted", request_id: id, state: "queued" }); await x.event({ type: "queued", count: ++count, text: "" });
    return { id, sent };
  };
  const box = () => x.page.evaluate(() => { const input = document.getElementById("input"), out = document.getElementById("btn-output");
    return { text: input.value, pills: [...input.querySelectorAll(".composer-pill")].map((p) => p.textContent.trim()), output: out.getAttribute("aria-pressed") === "true" ? out.textContent.trim() : "",
      focus: document.activeElement === input, rows: [...document.querySelectorAll("#queue-list .dgc-queue-row")].map((r) => r.querySelector(".dgc-queue-text").textContent),
      ask: document.querySelector("#queue-list .dgc-queue-ask")?.textContent.trim() || "" }; });
  // The queue's rows open from its pill on the bar above the box.
  const openRows = async () => { if (await x.page.locator("#queue-list .dgc-queue-row").first().isVisible().catch(() => false)) return;
    await x.page.evaluate(() => (document.querySelector('#rail-chips button[data-kind="queue"]') || [...document.querySelectorAll("#rail-chips button")].find((b) => /queued/.test(b.textContent)) || document.getElementById("queue-toggle"))?.click());
    await x.page.waitForTimeout(120); };
  return { ...x, queue, box, openRows };
}

// A one-second tone as a WAV, for a sound a Pip sent.
const WAV = (() => { const rate = 4000, n = rate, b = Buffer.alloc(44 + n); b.write("RIFF", 0); b.writeUInt32LE(36 + n, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write("data", 36); b.writeUInt32LE(n, 40);
  for (let i = 0; i < n; i++) b[44 + i] = 128 + Math.round(60 * Math.sin(i / 3)); return b.toString("base64"); })();
/** A Pip's chat where the Pip sent files with its reply (59, Pips API 101): a picture, a video and a zip (`sent: "audio"`: a
    voice note too), and you sent a file with your message. `media: false`: the host can't hand over the bytes. */
export async function openPipFiles(browser, { width = 440, height = 820, theme = "dark-modern", api = 101, sent = true, media = true, ...opts } = {}) {
  const x = await openPip(browser, { width, height, theme, said: [], api, convs: true, details: true, sent, sentMedia: media ? { 0: CLIP_WEBM, 2: WAV } : undefined, ...opts });
  const posted = (type) => x.page.evaluate((t) => (window.__posted || []).filter((m) => m && m.type === t), type);
  return { ...x, posted };
}

/** W36: a reply is running with a command waiting for your okay; you sent a message into it (Enter: steered) and
    queued another (Alt+Enter), then pressed Stop. The events are the ones DGC sends for that Stop, in its order. */
export async function openStopped(browser, { width = 700, height = 820, theme = "dark-modern", draft = "" } = {}) {
  const x = await openWork(browser, { width, height, theme, turns: 0, capabilities: { queue_edit: true } });
  const first = await x.say("Write a 300-word story about a tile that wanted to be a roof.");
  await x.event({ type: "prompt_accepted", request_id: first, state: "started" }); await x.event({ type: "turn_start", turn_id: "t1", prompt: "", request_id: first });
  await x.event({ type: "text_delta", text: "I'll write the story as a file in the project." }); await x.event({ type: "stream_end", message_id: "t1:1", phase: "commentary" });
  const steer = await x.say("Actually make it about a brick.");
  await x.event({ type: "prompt_accepted", request_id: steer, state: "steered" }); await x.event({ type: "steering_update", request_id: steer, state: "applied" });
  await x.event({ type: "text_delta", text: "Switching to a brick: I'll rewrite the same file rather than add a second one." }); await x.event({ type: "stream_end", message_id: "t1:2", phase: "commentary" });
  await x.event({ type: "tool_call", call_id: "c1", name: "bash", args: { command: "cd /home/me/projects/lime_tiles && ls" }, summary: "cd /home/me/projects/lime_tiles && ls" });
  await x.event({ type: "permission_request", id: "req-1", call_id: "c1", name: "bash", args: { command: "cd /home/me/projects/lime_tiles && ls" }, command: "cd /home/me/projects/lime_tiles && ls",
    summary: "cd /home/me/projects/lime_tiles && ls", suggested_rule: "Bash(ls:*)" });
  await x.page.fill("#input", "Then translate it to French."); await x.page.keyboard.press("Alt+Enter"); await x.page.waitForTimeout(60);
  const queued = String((await x.posted("prompt")).pop().requestId);
  await x.event({ type: "prompt_accepted", request_id: queued, state: "queued" }); await x.event({ type: "queued", count: 1, text: "" });
  if (draft) { await x.page.click("#input"); await x.page.keyboard.type(draft); }
  // Stop.
  await x.page.evaluate(() => (document.getElementById("stop-run").hidden ? document.getElementById("send") : document.getElementById("stop-run")).click());
  const cancelled = (await x.posted("cancel")).length;
  await x.event({ type: "steering_update", request_id: queued, state: "returned", message: "Stopped before the queued message ran; it was not sent." });
  await x.event({ type: "request_expired", id: "req-1" });
  await x.event({ type: "tool_result", call_id: "c1", name: "bash", output: "cancelled before the command ran", is_error: true, is_diff: false, diff: "" });
  await x.event({ type: "info", message: "turn cancelled" });
  await x.event({ type: "turn_end", turn_id: "t1", reason: "cancelled", usage: {} });
  await x.page.waitForTimeout(200);
  return { ...x, cancelled, ids: { first, steer, queued } };
}

/** W21: Settings › Voice with nothing installed, as it opens beside a session when Read aloud has no voice: two
    dictation models and two voices, each with its Install button and its size. */
export const VOICE_MODELS = [
  { id: "moonshine-base-en", role: "dictation", name: "Moonshine", summary: "Fast. English only.", languages: "English", licence: "MIT", size: 111e6, installed: false, in_use: false },
  { id: "nemotron-3.5", role: "dictation", name: "Nemotron 3.5", summary: "Most accurate. 40 languages, found by itself.", languages: "40 languages", licence: "NVIDIA Open Model (OpenMDW-1.1)", size: 475e6, installed: false, in_use: false },
  { id: "kitten", role: "read_aloud", name: "Kitten", summary: "Small and clear. English.", languages: "English", licence: "Apache-2.0", size: 68e6, installed: false, in_use: false },
  { id: "kokoro", role: "read_aloud", name: "Kokoro", summary: "Natural. English.", languages: "English", licence: "Apache-2.0", size: 98e6, installed: false, in_use: false },
];
export async function openVoiceSettings(browser, { width = 400, height = 820, theme = "dark-modern" } = {}) {
  const { openSettings } = await import("./settings-scene.mjs");
  const x = await openSettings(browser, { width, height, theme: theme.startsWith("light") ? "light" : "dark", section: "voice", scale: 2 });
  await x.page.evaluate((models) => window.postMessage({ type: "event", event: { type: "voice_state", request_id: "settings-voice-1", runtime: { installed: false }, models, dictation: "", read_aloud: "" } }, "*"), VOICE_MODELS);
  await x.page.waitForSelector("[data-voice-install]"); await x.rest(200);
  /** Each Install button: its words, and whether all of them are drawn (their own width against the button's room). */
  const buttons = () => x.page.evaluate(() => [...document.querySelectorAll("[data-voice-install]")].map((b) => { const range = document.createRange(); range.selectNodeContents(b);
    const words = range.getBoundingClientRect(), c = getComputedStyle(b), room = b.clientWidth - parseFloat(c.paddingLeft) - parseFloat(c.paddingRight), box = b.getBoundingClientRect();
    return { text: b.textContent.trim(), words: Math.round(words.width * 10) / 10, room: Math.round(room * 10) / 10, cut: words.width > room + 0.05 && c.textOverflow === "ellipsis" && c.overflow !== "visible", width: Math.round(box.width), right: Math.round(box.right), page: document.documentElement.clientWidth }; }));
  return { ...x, buttons };
}

// ---- user-test round 1 (section A of the triage): one scene for each bug, as the tester met it -------------------
export const DIFF = ["--- a/tests/test_totals.py", "+++ b/tests/test_totals.py", "@@ -1 +1,40 @@", "+from types import SimpleNamespace", "+",
  " from billing.totals import order_total", ...Array.from({ length: 38 }, (_, i) => `+    assert order_total(items_${i}) == ${250 + i}`)].join("\n");
/** W10: an edit with a long diff waits for your okay (its card is docked over the box). */
export async function openDenyNote(browser, { width = 700, height = 760, theme = "dark-modern" } = {}) {
  const x = await openWork(browser, { width, height, theme, turns: 1, running: "Apply the discount in order_total and write a real test for it." });
  await x.event({ type: "tool_call", call_id: "ce", name: "write_file", args: { path: "tests/test_totals.py" }, summary: "tests/test_totals.py" });
  await x.event({ type: "permission_request", id: "req-edit", call_id: "ce", name: "write_file", args: { path: "tests/test_totals.py", content: "x" }, diff: DIFF, summary: "tests/test_totals.py",
    suggested_rule: "Write(tests/test_totals.py)" });
  await x.page.waitForSelector('.approval-dock .card[data-request-id="req-edit"] button[data-d="deny"]'); await x.page.waitForTimeout(450);
  /** Where the note's buttons are against the part of the dock that shows. */
  const note = () => x.page.evaluate(() => { const dock = document.querySelector(".approval-dock"), card = dock.querySelector(".card"), d = dock.getBoundingClientRect(), foot = document.querySelector("footer .composer, #composer, .cbox")?.getBoundingClientRect();
    const buttons = [...card.querySelectorAll(".btns button")].filter((b) => !b.hidden).map((b) => { const r = b.getBoundingClientRect(); return { text: b.textContent.trim(), top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) }; });
    const box = card.querySelector(".deny-note"), n = box.getBoundingClientRect();
    return { dock: { top: Math.round(d.top), bottom: Math.round(d.bottom), left: Math.round(d.left), right: Math.round(d.right) }, buttons, note: { hidden: box.hidden, top: Math.round(n.top), bottom: Math.round(n.bottom), focus: document.activeElement === box },
      box: foot ? Math.round(foot.top) : null }; });
  return { ...x, note };
}
const DOC = { id: "ar_" + "5".repeat(16), type: "doc", label: "Document", title: "Billing in lime_tiles: one-page guide", version: 1, created: "2026-11-15T19:55:00Z", updated: "2026-11-15T19:55:00Z",
  origin: { surface: "work" }, exports: ["docx", "pdf", "md"] };
/** W25: a turn made a document and then said "…is ready as a card under this reply". */
export async function openArtifactTurn(browser, { width = 700, height = 760, theme = "dark-modern" } = {}) {
  const x = await openWork(browser, { width, height, theme, turns: 0, capabilities: { artifacts: OUTPUTS } });
  const id = await x.say("A one-page guide to how billing works in this project, for a new teammate.");
  await x.event({ type: "prompt_accepted", request_id: id, state: "started" }); await x.event({ type: "turn_start", turn_id: "ta", prompt: "" });
  await x.event({ type: "tool_call", call_id: "ca", name: "make_artifact", args: { type: "doc", title: DOC.title }, summary: DOC.title });
  await x.event({ type: "tool_result", call_id: "ca", name: "make_artifact", output: `Made Document “${DOC.title}” (${DOC.id}, version 1). It shows as a card the user opens; don't repeat its content in your reply.`, is_error: false, is_diff: false, diff: "" });
  await x.event({ type: "artifact_changed", artifact: DOC, op: "made", surface: "work" });
  await x.event({ type: "text_delta", text: "The document is ready as a card under this reply.\n\nIt covers the two billing modules and their exact current behaviour, then the gaps a newcomer would otherwise trip on." });
  await x.event({ type: "stream_end", message_id: "ta:1", phase: "final" }); await x.event({ type: "turn_end", turn_id: "ta", reason: "completed", final_message_id: "ta:1", usage: {} });
  await x.page.waitForTimeout(250);
  const where = () => x.page.evaluate(() => { const card = document.querySelector("#log .artifact-card"), words = document.querySelector("#log .answer .text"), acts = document.querySelector("#log .answer .response-actions, #log .answer .actions");
    const box = (n) => { if (!n) return null; const r = n.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) }; };
    return { card: box(card), words: box(words), actions: box(acts), cards: document.querySelectorAll("#log .artifact-card").length, inAnswer: !!card?.closest(".answer"), name: card?.textContent.includes("Billing in lime_tiles") }; });
  return { ...x, where, DOC };
}
/** W27: a turn used two sub-agents, which finished; then the turn ended. */
export async function openAgentsTurn(browser, { width = 700, height = 760, theme = "dark-modern", ended = true, working = false } = {}) {
  const x = await openWork(browser, { width, height, theme, turns: 0, capabilities: { agents: true, agent_control: true } });
  const sid = (n) => `sub-${String(n).padStart(12, "0")}`, id = await x.say("Use two sub-agents in parallel: one reads billing/, one reads shop/.");
  await x.event({ type: "prompt_accepted", request_id: id, state: "started" }); await x.event({ type: "turn_start", turn_id: "tg", prompt: "" });
  for (const n of [1, 2]) { await x.event({ type: "tool_call", call_id: `cg${n}`, name: "task", args: { description: n === 1 ? "Read billing/" : "Read shop/" }, summary: n === 1 ? "Read billing/" : "Read shop/" });
    await x.event({ type: "agent_started", id: sid(n), parent_id: null, call_id: `cg${n}`, description: n === 1 ? "Read billing/" : "Read shop/", depth: 1, state: "running", started_at: Date.now() / 1000, isolated: false, parallel: true }); }
  const pill = () => x.page.evaluate(() => { const picker = document.getElementById("agents-picker"), p = document.getElementById("agents-pill");
    return { hidden: picker.hidden || !picker.checkVisibility(), words: [...p.querySelectorAll(".agents-text")].map((n) => n.textContent.trim()).join(" ") || p.textContent.trim(), state: p.dataset.state }; });
  const during = await pill();
  if (!working) for (const n of [1, 2]) { await x.event({ type: "agent_ended", id: sid(n), state: "finished", duration_ms: 1200, tool_calls: 2 });
    await x.event({ type: "tool_result", call_id: `cg${n}`, name: "task", output: "It reads totals and applies tax.", is_error: false, is_diff: false, diff: "" }); }
  if (ended && !working) { await x.event({ type: "text_delta", text: "billing/ adds the lines and applies tax; shop/ keeps the cart." }); await x.event({ type: "stream_end", message_id: "tg:1", phase: "final" });
    await x.event({ type: "turn_end", turn_id: "tg", reason: "completed", final_message_id: "tg:1", usage: {} }); }
  await x.page.waitForTimeout(200);
  return { ...x, pill, during, sid };
}
/** C10 and W34: the side bar's Chat list with a chat whose last reply is a chart, and Work's list after a search. */
export const CHART_PREVIEW = '```chart {"type": "bar", "title": "Frost rating by tile", "x": ["Porcelain", "Ceramic"], "series": [{"name": "Rating", "data": [5, 2]}]} ``` Porcelain is the safe choice outdoors.';
export const SEARCH_MATCH = "…by [.gitignore](.gitignore), which only lists `.env` and **never** `order_total` or the *.pyc files…";
export async function openSideLists(browser, { width = 300, height = 760, theme = "dark-modern", tab = "chat" } = {}) {
  const home = await import("./home-scene.mjs");
  const x = await home.openHome(browser, { width, height, theme, tab, scale: 2 });
  await x.send({ type: "chatdgc_list", available: true, open: ["chat_9"], items: [
    { id: "chat_9", title: "UK outdoor ceramic tile frost rating", preview: CHART_PREVIEW, updated_at: new Date().toISOString() },
    { id: "chat_8", title: "Only a chart", preview: '```chart {"type": "line", "t', updated_at: "2026-11-05T09:00:00Z" },
    { id: "chat_7", title: "Rent or buy: the numbers", preview: "At **8.5%** the two cross in year nine: see [the table](https://example.com/t).", updated_at: "2026-11-04T09:00:00Z" }] });
  await x.send({ type: "sessions_list", error: "", query: "env", items: [
    { id: "20261115-194400-a1", path: "/s/a1.json", name: "to five lines.", preview: "", when: "2026-11-15 19:44", count: 9, open: false, match: SEARCH_MATCH, project: "~/projects/lime_tiles" },
    { id: "20261114-214400-b2", path: "/s/b2.json", name: "Read the .env file in this project and tell me what is in it", preview: "", when: "2026-11-14 21:44", count: 4, open: false, project: "~/projects/lime_tiles" }] });
  await x.page.waitForTimeout(200);
  const rows = () => x.page.evaluate(() => ({ chats: [...document.querySelectorAll("#chats-list .chat-row")].map((r) => ({ title: r.querySelector(".session-name")?.textContent, preview: r.querySelector(".chat-preview")?.textContent || "" })),
    sessions: [...document.querySelectorAll("#sessions-list .session-row")].map((r) => ({ title: r.querySelector(".session-name")?.textContent, match: r.querySelector(".session-match")?.textContent || "" })) }));
  return { ...x, rows };
}
