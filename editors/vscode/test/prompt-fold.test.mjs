// A long prompt folds to its first five lines until "Show more".
//
// A sent prompt whose text runs to 7+ lines at the current width shows 5 of them, fading, with a
// "Show more" pill; open, it reads "Show less". Only the prompt's prose folds -- chips, image tiles
// and the question an answer quotes stay whole -- and the decision is made from the text's real
// height, once it is in the transcript and again whenever the width or fonts change. Nothing is
// guessed at build time, so a prompt drawn live and the same prompt replayed from history run the
// same code. Opened prompts stay open per chat (tab + conversation) for the life of the panel.
//
// jsdom lays nothing out, so these use the harness's stand-in for layout (makeDom `layout`: 40
// characters to a 21px line at 300px wide). The real geometry -- the clamp, the fade, the pill, the
// sticky "Show less" -- is checked in Chromium by prompt-fold-layout.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom, mainCss, mainJs } from "./support/webview-dom.mjs";

const LONG = Array.from({ length: 12 }, (_, i) => `line ${i + 1}: keep it short`).join("\n");
const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");
const turnEvents = (id, prompt, answer = "Done.") => [
  { type: "turn_start", turn_id: id, prompt, kind: "prompt" },
  { type: "text_delta", text: answer },
  { type: "stream_end", message_id: `${id}:1`, phase: "answer" },
  { type: "turn_end", turn_id: id, reason: "completed", token_estimate: 0, final_message_id: `${id}:1` },
];

function panel(options = {}) {
  const h = makeDom({ layout: {}, ...options });
  const input = h.doc.getElementById("input");
  return {
    ...h, input,
    event: (data) => h.send({ type: "event", event: data }),
    // Enter in the composer, the path a person takes (prompt-links.test.mjs drives it the same way).
    submit(text) {
      input.value = text;
      h.doc.getElementById("send").click();
      return [...h.doc.querySelectorAll(".msg.user > .bubble")].at(-1);
    },
    bubbles: () => [...h.doc.querySelectorAll(".msg.user > .bubble")],
    lastPrompt: () => h.posted.filter((m) => m?.type === "prompt").at(-1),
  };
}
const frames = (p, n = 2) => new Promise((done) => {
  const next = () => (--n <= 0 ? done() : p.dom.window.requestAnimationFrame(next));
  p.dom.window.requestAnimationFrame(next);
});
const toggleOf = (bubble) => bubble.querySelector(":scope > .prompt-fold");

// ---- what is drawn ------------------------------------------------------------------------------

test("without layout nothing folds, which is why every other webview test sees today's bubble", () => {
  const { doc, errors } = makeDom();
  doc.getElementById("input").value = LONG;
  doc.getElementById("send").click();
  const bubble = doc.querySelector(".msg.user > .bubble");
  assert.equal(bubble.dataset.fold, undefined);
  assert.equal(bubble.querySelector(".prompt-fold"), null);
  assert.equal(bubble.textContent, LONG);
  assert.deepEqual(errors, []);
});

test("a short prompt is drawn exactly as before", () => {
  const p = panel();
  const bubble = p.submit("fix the login bug");
  assert.deepEqual([...bubble.children].map((n) => n.className), ["prompt-text"]);
  assert.equal(bubble.hasAttribute("data-fold"), false);
  assert.deepEqual(p.errors, []);
});

test("seven lines fold, six do not; one unbroken line folds by its wrapped height", () => {
  const p = panel();                                  // 300px: 40 characters to a line
  const fold = (text) => p.submit(text).dataset.fold ?? "none";
  assert.equal(fold(lines(6)), "none", "six lines show whole: a Show more never reveals one line");
  assert.equal(fold(lines(7)), "folded");
  assert.equal(fold("a".repeat(240)), "none", "one 240-character word wraps to six lines");
  assert.equal(fold("a".repeat(280)), "folded", "and at 280 to seven");
  assert.equal(fold("QUJD".repeat(750)), "folded", "base64 has no spaces and folds like any prompt");
  assert.deepEqual(p.errors, []);
});

test("a folded bubble holds every character, and only the prompt's", () => {
  const p = panel();
  const bubble = p.submit(LONG);
  const text = bubble.querySelector(":scope > .prompt-text"), toggle = toggleOf(bubble);
  assert.equal(bubble.dataset.fold, "folded");
  assert.equal(text.textContent, LONG, "the whole prompt is in the DOM, folded or not");
  assert.equal(bubble.textContent, LONG,
    "the control's words are drawn from data-label: never in the text, a copy or the duplicate-echo check");
  assert.equal(toggle.type, "button");
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(toggle.getAttribute("aria-label"), "Show more");
  assert.equal(toggle.dataset.label, "Show more");
  assert.ok(text.id, "the text has an id for the control to name");
  assert.equal(toggle.getAttribute("aria-controls"), text.id);
  assert.equal(bubble.lastElementChild, toggle, "the control is the bubble's last child");
  assert.equal(toggle.textContent, "");
  assert.equal(toggle.hasAttribute("title"), false, "no hover label: the pill says what it does");
  for (const button of p.doc.querySelectorAll("button")) {
    assert.ok(button.getAttribute("aria-label") || button.textContent.trim() || button.title,
      `button #${button.id || "(dynamic)"} needs an accessible name`);
  }
  assert.deepEqual(p.errors, []);
});

test("Show more opens, Show less folds back; a held key does nothing", () => {
  const p = panel();
  const bubble = p.submit(LONG);
  const toggle = toggleOf(bubble);
  toggle.click();
  assert.equal(bubble.dataset.fold, "open");
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(toggle.getAttribute("aria-label"), "Show less");
  assert.equal(toggle.dataset.label, "Show less");
  assert.ok(toggle.querySelector(".codicon-chevron-up"));
  assert.equal(toggleOf(bubble), toggle, "the same control, relabelled");
  toggle.click();
  assert.equal(bubble.dataset.fold, "folded");
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(toggle.getAttribute("aria-label"), "Show more");
  assert.ok(toggle.querySelector(".codicon-chevron-down"));
  const press = (key, repeat) => {
    const event = new p.dom.window.KeyboardEvent("keydown", { key, repeat, bubbles: true, cancelable: true });
    toggle.dispatchEvent(event);
    return event.defaultPrevented;
  };
  assert.equal(press("Enter", true), true, "an auto-repeated Enter does not activate the button again");
  assert.equal(press(" ", true), true, "nor an auto-repeated Space");
  assert.equal(press("Enter", false), false, "one press is one toggle");
  assert.equal(press(" ", false), false);
  assert.equal(press("a", true), false, "other keys are left alone");
  assert.deepEqual(p.errors, []);
});

test("attachments and an answered question stay outside the fold", () => {
  const p = panel({ scope: "workspace" });
  p.send({ type: "session_ready", sessionId: "alpha" });
  p.event({ type: "ready", capabilities: {} });
  const paste = (clipboardData) => {
    const event = new p.dom.window.Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: clipboardData });
    p.input.dispatchEvent(event);
  };
  const pasted = "y".repeat(5000);
  paste({ items: [], getData: () => pasted });                 // a paste this big folds into a chip
  p.dom.window.FileReader = class { readAsDataURL() { this.result = "data:image/png;base64,iVBORw0KGgo="; this.onload(); } };
  paste({ items: [{ type: "image/png",
    getAsFile: () => new p.dom.window.File([new Uint8Array(32)], "shot.png", { type: "image/png" }) }] });
  const bubble = p.submit(LONG);
  const text = bubble.querySelector(":scope > .prompt-text");
  assert.equal(bubble.dataset.fold, "folded");
  const atts = bubble.querySelector(":scope > .prompt-atts");
  assert.ok(atts, "the chips have a row of their own");
  assert.equal(atts.nextElementSibling, text, "above the text, beside it in the bubble, never inside it");
  assert.ok(atts.querySelector(".pasted-chip") && atts.querySelector(".image-chip"));
  assert.equal(text.querySelector(".chip, .prompt-att, .image-chip"), null);
  assert.equal(text.textContent, LONG);
  atts.querySelector(".pasted-chip").click();
  assert.equal(p.doc.querySelector("#att-viewer .att-body")?.textContent, pasted, "the chip still opens what was pasted");
  p.doc.querySelector("#att-viewer .att-close").click();
  atts.querySelector(".image-chip").click();
  assert.ok(p.doc.getElementById("image-viewer"), "and the tile still opens the viewer");

  // An answer to an open question quotes the question above it. The question never folds; only
  // the answer can, and only when the answer itself is long.
  const q = panel();
  q.event({ type: "turn_start", turn_id: "t1", prompt: "deploy it", kind: "prompt" });
  const question = "Which staging host should I deploy to? ".repeat(11).slice(0, 399) + "?";
  const answer = (id, value) => {
    q.event({ type: "ask_request", ask_id: id, question: id === "a1" ? question : "And the region?" });
    const card = q.doc.querySelector(`.open-ask[data-ask-id="${id}"]`);
    card.querySelector(".open-ask-input").value = value;
    card.querySelector(".open-ask-send").click();
    return q.bubbles().at(-1);
  };
  const short = answer("a1", "staging-2");
  assert.equal(question.length, 400, "a 400-character question");
  assert.equal(short.dataset.fold, undefined, "a long question with a short answer does not fold");
  assert.equal(short.querySelector(".answered-q").textContent, question, "and is shown whole");
  const long = answer("a2", "eu-west-1 because ".repeat(27).slice(0, 480));
  assert.equal(long.dataset.fold, "folded", "a 480-character answer on the one-line input folds");
  assert.equal(long.querySelector(".prompt-text .answered-q"), null);
  assert.equal(long.querySelector(":scope > .answered-q").nextElementSibling, long.querySelector(":scope > .prompt-text"));
  assert.deepEqual([...p.errors, ...q.errors], []);
});

// ---- every way a prompt reaches the transcript --------------------------------------------------

test("every builder folds: echoed, replayed, steered in history, recalled, queued, unsent", () => {
  const live = panel();
  live.event({ type: "turn_start", turn_id: "t1", prompt: LONG, kind: "prompt" });
  assert.equal(live.bubbles().at(-1).dataset.fold, "folded", "a turn started elsewhere (echoPrompt)");

  const history = panel();
  history.event({ type: "history", items: [...turnEvents("h1", LONG),
    { type: "turn_start", turn_id: "h2", prompt: "and now the tests", kind: "prompt" },
    { role: "steering", text: LONG },
    { type: "text_delta", text: "Running them." }, { type: "stream_end", message_id: "h2:1", phase: "answer" },
    { type: "turn_end", turn_id: "h2", reason: "completed", token_estimate: 0, final_message_id: "h2:1" }] });
  const [replayed, second, steered] = history.bubbles();
  assert.equal(replayed.dataset.fold, "folded", "a replayed prompt");
  assert.equal(second.dataset.fold, undefined);
  assert.ok(steered.closest(".msg.dgc"), "the steering message sits inside its turn");
  assert.equal(steered.dataset.fold, "folded", "and folds there, decided with its turn's block");
  history.event({ type: "recall", items: [{ role: "user", text: LONG }, { role: "assistant", text: "An archived answer" }],
    before: 0, more: false });
  const recalled = history.doc.querySelector(".msg.user.archived > .bubble");
  assert.equal(recalled.dataset.fold, "folded", "a prompt recalled from the archive");

  const queued = panel();
  queued.send({ type: "prompts_queued", items: [{ requestId: "q-1", text: LONG }] });
  assert.equal(queued.bubbles().at(-1).dataset.fold, "folded", "a queued prompt adopted after a reload");
  queued.send({ type: "prompts_unsent", items: [{ requestId: "u-1", text: LONG }] });
  const unsent = queued.bubbles().at(-1);
  assert.match(unsent.parentElement.querySelector(".role").textContent, /not sent/);
  assert.equal(unsent.dataset.fold, "folded", "an unsent one keeps its fold");
  assert.deepEqual([...live.errors, ...history.errors, ...queued.errors], []);
});

test("a goal prompt is settled and folds; a live steer folds inside its turn and is not a block of its own", () => {
  const goal = panel();
  goal.submit(`/goal ${LONG}`);
  const block = goal.doc.querySelector(".msg.user.goal-prompt");
  assert.ok(block, "the goal prompt was drawn");
  assert.equal(block.querySelector(":scope > .bubble").dataset.fold, "folded");
  assert.ok(block.classList.contains("settled"), "pinned and skippable like every other prompt");

  const p = panel();
  p.event({ type: "ready", capabilities: { live_steering: true } });
  p.event({ type: "turn_start", turn_id: "t1", prompt: "deploy it", kind: "prompt" });
  const bubble = p.submit(LONG);
  const id = p.lastPrompt().requestId;
  assert.ok(bubble.parentElement.classList.contains("settled"), "drawn under the turn and settled there");
  p.event({ type: "prompt_accepted", request_id: id, state: "steered" });
  p.event({ type: "steering_update", request_id: id, state: "applied" });
  const steer = bubble.parentElement;
  assert.ok(steer.parentElement.matches(".msg.dgc"), "placed inside the running turn");
  assert.equal(bubble.dataset.fold, "folded");
  assert.equal(steer.classList.contains("settled"), false,
    "part of the turn now, as a replayed steer always was: the turn is what gets measured and skipped");
  assert.equal(steer.style.containIntrinsicSize, "", "its own pin went with it");
  assert.deepEqual([...goal.errors, ...p.errors], []);
});

test("a custom slash command keeps today's plain bubble and never folds", () => {
  const p = panel();
  p.event({ type: "ready", capabilities: {}, custom_commands: ["review-api"] });
  p.submit(`/review-api ${LONG}`);
  const bubble = p.bubbles().at(-1);
  assert.equal(bubble.textContent, `/review-api ${LONG}`);
  assert.equal(bubble.querySelector(".prompt-text"), null);
  assert.equal(bubble.dataset.fold, undefined);
  assert.equal(bubble.querySelector(".prompt-fold"), null);
  assert.deepEqual(p.errors, []);
});

test("replay folds the way live did", () => {
  const live = panel(), replay = panel();
  live.submit(LONG);
  const id = live.lastPrompt().requestId;
  live.event({ type: "prompt_accepted", request_id: id, state: "started" });
  live.event({ ...turnEvents("t1", LONG)[0], request_id: id });
  for (const event of turnEvents("t1", LONG).slice(1)) live.event(event);
  replay.event({ type: "history", items: turnEvents("t1", LONG) });
  const a = live.bubbles(), b = replay.bubbles();
  assert.equal(a.length, 1, "the live prompt was drawn once");
  assert.equal(b.length, 1);
  assert.equal(a[0].dataset.fold, "folded");
  assert.equal(b[0].dataset.fold, a[0].dataset.fold);
  assert.deepEqual([...b[0].children].map((n) => n.className), [...a[0].children].map((n) => n.className));
  assert.equal(b[0].querySelector(".prompt-text").textContent, a[0].querySelector(".prompt-text").textContent);
  assert.deepEqual([...live.errors, ...replay.errors], []);
});

// ---- what is remembered -------------------------------------------------------------------------

test("opened prompts stay open per chat, across a chat switch, and not across a reload", () => {
  const p = panel();
  const show = (slot, session) => {
    p.send({ type: "chat_switched", slotId: slot, label: "" });
    p.send({ type: "session_ready", sessionId: session });
    p.event({ type: "history", items: turnEvents("h1", LONG) });
    return p.bubbles().at(-1);
  };
  let bubble = show("chat-1", "sa");
  assert.equal(bubble.dataset.fold, "folded");
  toggleOf(bubble).click();
  assert.equal(bubble.dataset.fold, "open");
  assert.equal(show("chat-2", "sb").dataset.fold, "folded", "another chat with the same words starts folded");
  bubble = show("chat-1", "sa");
  assert.equal(bubble.dataset.fold, "open", "back in the first chat, the prompt being read is still open");
  toggleOf(bubble).click();
  assert.equal(show("chat-1", "sa").dataset.fold, "folded", "and folding it again is remembered too");
  toggleOf(p.bubbles().at(-1)).click();
  // A brand-new chat has no session id until its backend says so, and the draft session is still the
  // chat just left: the tab is what keeps the two apart.
  p.send({ type: "chat_switched", slotId: "chat-3", label: "" });
  p.event({ type: "turn_start", turn_id: "n1", prompt: LONG, kind: "prompt" });
  assert.equal(p.bubbles().at(-1).dataset.fold, "folded", "a new tab does not inherit the chat it was opened from");
  show("chat-1", "sa");
  p.event({ type: "session", kind: "new", session_id: "sc" });
  p.event({ type: "history", items: turnEvents("h1", LONG) });
  assert.equal(p.bubbles().at(-1).dataset.fold, "folded", "/new in the same tab starts clean");

  const reloaded = panel();
  reloaded.send({ type: "chat_switched", slotId: "chat-1", label: "" });
  reloaded.send({ type: "session_ready", sessionId: "sa" });
  reloaded.event({ type: "history", items: turnEvents("h1", LONG) });
  assert.equal(reloaded.bubbles().at(-1).dataset.fold, "folded", "a reloaded webview starts folded");
  assert.deepEqual([...p.errors, ...reloaded.errors], []);
});

test("after a reload the tab comes from chat_slots, so a chat switch still finds the prompt it opened", () => {
  const p = panel();
  // A reloaded webview is never sent chat_switched for the chat it shows; chat_slots names it.
  p.send({ type: "chat_slots", max: 0, activeId: "chat-1", items: [
    { id: "chat-1", label: "First", active: true, busy: false, needsYou: false, unread: 0 },
    { id: "chat-2", label: "Second", active: false, busy: false, needsYou: false, unread: 0 }] });
  p.send({ type: "session_ready", sessionId: "sa" });
  p.event({ type: "history", items: turnEvents("h1", LONG) });
  toggleOf(p.bubbles().at(-1)).click();
  for (const [slot, session, want] of [["chat-2", "sb", "folded"], ["chat-1", "sa", "open"]]) {
    p.send({ type: "chat_switched", slotId: slot, label: "" });
    p.send({ type: "session_ready", sessionId: session });
    p.event({ type: "history", items: turnEvents("h1", LONG) });
    assert.equal(p.bubbles().at(-1).dataset.fold, want, `${slot}`);
  }
  assert.deepEqual(p.errors, []);
});

test("a re-sent prompt shares the opened state, as its replay will", () => {
  const p = panel();
  p.event({ type: "history", items: turnEvents("h1", LONG) });
  const first = p.bubbles().at(-1);
  toggleOf(first).click();
  p.doc.querySelector(".ract-retry").click();
  const again = p.bubbles().at(-1);
  assert.notEqual(again, first, "Run again drew a new bubble");
  assert.equal(p.lastPrompt().text, LONG);
  assert.equal(again.dataset.fold, "open", "the same words in the same chat: open, as a replay of it would be");
  assert.deepEqual(p.errors, []);
});

// ---- the actions read stored text, never the folded DOM ----------------------------------------

test("the actions use the whole prompt", () => {
  const p = panel();
  const bubble = p.submit(LONG);
  const id = p.lastPrompt().requestId;
  p.event({ type: "prompt_accepted", request_id: id, state: "started" });
  p.event({ ...turnEvents("t1", LONG)[0], request_id: id });
  for (const event of turnEvents("t1", LONG).slice(1)) p.event(event);
  assert.equal(p.bubbles().length, 1, "no double echo: the turn's start found the bubble already drawn");
  assert.equal(bubble.dataset.fold, "folded");
  p.doc.querySelector(".ract-edit").click();
  assert.equal(p.input.value, LONG, "Edit puts the whole prompt in the composer");
  p.input.value = "";
  p.doc.querySelector(".ract-retry").click();
  assert.equal(p.lastPrompt().text, LONG, "Run again sends the whole prompt");

  const r = panel();
  r.submit(LONG);
  r.send({ type: "prompt_rejected", requestId: r.lastPrompt().requestId });
  assert.equal(r.input.value, LONG, "a refused prompt is restored whole");
  assert.deepEqual([...p.errors, ...r.errors], []);
});

// ---- keyboard ---------------------------------------------------------------------------------

test("a link in the folded tail leaves the tab order until the prompt opens", () => {
  const p = panel();
  // Stand-in geometry for the two links: line 2 is inside the five visible lines, line 11 is not.
  const realRect = p.dom.window.Element.prototype.getBoundingClientRect;
  p.dom.window.Element.prototype.getBoundingClientRect = function () {
    if (!this.classList.contains("prompt-link")) return realRect.call(this);
    const top = this.textContent.includes("later") ? 210 : 21;
    return { top, bottom: top + 21, left: 0, right: 120, width: 120, height: 21, x: 0, y: top };
  };
  const rows = LONG.split("\n");
  rows[1] = "see https://vibedgc.com/docs first";
  rows[10] = "then https://example.com/later";
  const bubble = p.submit(rows.join("\n"));
  const [early, late] = bubble.querySelectorAll(".prompt-link");
  assert.ok(early && late, "both URLs are links");
  assert.equal(bubble.dataset.fold, "folded");
  assert.equal(early.hasAttribute("tabindex"), false, "a link in the visible lines is tabbable as always");
  assert.equal(late.tabIndex, -1, "a link in the folded tail is skipped by Tab");
  toggleOf(bubble).click();
  assert.equal(early.hasAttribute("tabindex"), false);
  assert.equal(late.hasAttribute("tabindex"), false, "open, every link is back in the tab order");
  toggleOf(bubble).click();
  assert.equal(late.tabIndex, -1, "and folded again, out of it");
  assert.equal(early.hasAttribute("tabindex"), false);
  assert.equal(late.getAttribute("aria-hidden"), null, "a screen reader still has every link");
  assert.deepEqual(p.errors, []);
});

// ---- following the run --------------------------------------------------------------------------

test("opening a prompt stops a running turn pulling the reader to the end (follow-5)", () => {
  const p = panel({ clock: true });
  const log = p.doc.getElementById("log");
  let top = 0;
  const opened = () => !!log.querySelector('.bubble[data-fold="open"]');
  Object.defineProperty(log, "clientHeight", { configurable: true, get: () => 500 });
  Object.defineProperty(log, "scrollHeight", { configurable: true, get: () => (opened() ? 4400 : 4000) });
  Object.defineProperty(log, "scrollTop", { configurable: true, get: () => top,
    set: (value) => { top = Math.max(0, Math.min(value, log.scrollHeight - log.clientHeight)); } });
  assert.match(mainJs, /window\.__dgcPanelBuild = "follow-5"/, "the follow contract changed, so its marker did");
  p.event({ type: "turn_start", turn_id: "t1", prompt: LONG, kind: "prompt" });
  p.event({ type: "text_delta", text: "Reading the deploy configuration." });
  assert.equal(top, 3500, "following the run, at the end");
  const bubble = p.bubbles().at(-1), pill = p.doc.getElementById("to-latest");
  toggleOf(bubble).click();
  assert.equal(pill.hidden, false, "the end is out of view: the Latest pill offers the way back");
  p.event({ type: "text_delta", text: " Then the host list." });
  p.advance(60);
  p.event({ type: "text_delta", text: " Then the health check." });
  p.advance(60);
  assert.equal(top, 3500, "what streams in does not drag the reader off the prompt they opened");
  assert.equal(p.doc.getElementById("to-latest-label").textContent, "New");
  bubble.getBoundingClientRect = () => ({ top: -300, bottom: 200, left: 0, right: 300, width: 300, height: 500, x: 0, y: -300 });
  toggleOf(bubble).click();
  assert.equal(bubble.dataset.fold, "folded");
  assert.equal(top, 3500 - 316, "folded while read from inside, its top comes back 16px below the log's top");
  pill.click();
  assert.equal(top, 3500, "Latest goes back to the end");
  p.event({ type: "text_delta", text: " Done." });
  p.advance(60);
  assert.equal(top, 3500, "and following resumes");
  assert.deepEqual(p.errors, []);
});

// ---- width and fonts ----------------------------------------------------------------------------

test("a width change re-decides each fold, even in a block the size observer already re-pinned", async () => {
  const p = panel({ clock: true, resizeObservers: true, layout: { width: 900 } });
  const log = p.doc.getElementById("log");
  const bubble = p.submit("x".repeat(420));            // 4 lines at 900px, 11 at 300px
  const block = bubble.parentElement;
  const resize = (width) => { p.layout.width = width; p.resize(block); p.resize(log); p.advance(150); };
  assert.equal(bubble.dataset.fold, undefined);
  assert.ok(block.classList.contains("settled"));
  p.layout.width = 300;
  p.resize(block);
  assert.equal(block._pinnedWidth, 300,
    "the size observer re-pins a block on screen at the new width before the width settles (the trap)");
  p.resize(log); p.advance(150);
  assert.equal(bubble.dataset.fold, "folded", "narrower: the prompt that no longer fits folds");
  assert.match(block.style.containIntrinsicSize, /^auto 145px$/, "and its block is pinned at the folded height");
  await frames(p);
  toggleOf(bubble).click();
  resize(900);
  assert.equal(bubble.dataset.fold, undefined, "wider: it fits again and the control goes");
  assert.equal(toggleOf(bubble), null);
  await frames(p);
  resize(300);
  assert.equal(bubble.dataset.fold, "open", "narrower again: it comes back open, because it was opened");
  await frames(p);
  const toggle = toggleOf(bubble);
  toggle.focus();
  assert.equal(p.doc.activeElement, toggle);
  resize(900);
  const text = bubble.querySelector(".prompt-text");
  assert.equal(p.doc.activeElement, text, "the focused control went: focus stays in the prompt, not on the page body");
  assert.equal(text.getAttribute("tabindex"), "-1");
  p.input.focus();
  assert.equal(text.hasAttribute("tabindex"), false, "and only until it leaves");
  assert.deepEqual(p.errors, []);
});

test("new fonts re-decide a fold too, whichever observer hears of them first", () => {
  const p = panel({ clock: true, resizeObservers: true });
  // The two probe lines main.js measures to notice the host changing the transcript's fonts.
  const probe = p.doc.querySelector(".font-probe");
  let glyphs = 100;
  for (const line of probe.children) {
    line.getBoundingClientRect = () => ({ width: glyphs, height: 20, top: 0, left: 0, right: glyphs, bottom: 20, x: 0, y: 0 });
  }
  const fontsChanged = () => { for (const line of probe.children) p.resize(line); };
  fontsChanged();                                      // the first fonts seen: nothing to re-measure
  const bubble = p.submit("a".repeat(240));           // six lines: it fits
  assert.equal(bubble.dataset.fold, undefined);
  p.layout.char = 8.5; glyphs = 120;                   // wider glyphs: the same words take seven lines
  fontsChanged();
  // The size observer re-pins the block on screen AFTER the font epoch moved, so its pin claims the
  // new fonts and the pin test offers it no more. The fold must be found by its own record.
  p.resize(bubble.parentElement);
  p.advance(150);
  assert.equal(bubble.dataset.fold, "folded");
  assert.deepEqual(p.errors, []);
});

test("a prompt in no settled block is re-decided too, and a steer placed before it settled stays part of its turn", async () => {
  // Hidden while the steer is sent and applied (width 0: nothing laid out), then shown.
  const p = panel({ clock: true, resizeObservers: true, layout: { width: 0 } });
  const log = p.doc.getElementById("log");
  p.event({ type: "ready", capabilities: { live_steering: true } });
  p.event({ type: "turn_start", turn_id: "t1", prompt: "deploy it", kind: "prompt" });
  const bubble = p.submit(LONG);
  const steer = bubble.parentElement;
  assert.equal(steer.classList.contains("settled"), false, "nothing is laid out, so it waits for a frame to settle");
  const id = p.lastPrompt().requestId;
  p.event({ type: "prompt_accepted", request_id: id, state: "steered" });
  p.event({ type: "steering_update", request_id: id, state: "applied" });
  assert.ok(steer.parentElement.matches(".msg.dgc"));
  p.layout.width = 300;
  await frames(p, 3);                                  // the settle that was waiting comes round
  assert.equal(steer.classList.contains("settled"), false,
    "a block inside another is never settled on its own, even by a settle queued before it moved");
  assert.equal(bubble.dataset.fold, undefined, "not decided while nothing was laid out");
  p.resize(log); p.advance(150);
  assert.equal(bubble.dataset.fold, "folded", "the running turn is not settled, so its steer's fold is found on its own");
  assert.deepEqual(p.errors, []);
});

test("a steer is decided again where it lands, in its turn's column", () => {
  const p = panel({ layout: { width: 0 } });
  p.event({ type: "ready", capabilities: { live_steering: true } });
  p.event({ type: "turn_start", turn_id: "t1", prompt: "deploy it", kind: "prompt" });
  const bubble = p.submit(LONG);                      // sent while the panel was hidden: undecided
  const id = p.lastPrompt().requestId;
  p.event({ type: "prompt_accepted", request_id: id, state: "steered" });
  assert.equal(bubble.dataset.fold, undefined);
  p.layout.width = 300;                                // shown again; the model reads it at once
  p.event({ type: "steering_update", request_id: id, state: "applied" });
  assert.ok(bubble.closest(".msg.dgc"));
  assert.equal(bubble.dataset.fold, "folded", "placed in the turn, it is measured there and then");
  assert.deepEqual(p.errors, []);
});

// ---- the stylesheet and the script agree ---------------------------------------------------------

test("the fold's rules sit in their own section, in the order the cascade relies on", () => {
  const open = mainCss.indexOf("/* ---- long prompts -"), close = mainCss.indexOf("/* ---- end long prompts -");
  assert.equal(mainCss.split("/* ---- long prompts -").length, 2, "one long-prompts section");
  assert.ok(open > mainCss.indexOf(".msg.archived .bubble {"), "after the archived bubble (nothing after it targets bubbles)");
  assert.ok(close > open && close < mainCss.indexOf("0.40.0 lane sections"), "and before the lane sections");
  const section = mainCss.slice(open, close);
  const cssLines = Number(/--prompt-fold-lines:\s*(\d+)/.exec(section)?.[1]);
  assert.equal(cssLines, Number(/const PROMPT_FOLD_LINES = (\d+);/.exec(mainJs)?.[1]), "CSS and script fold to the same line count");
  const lineHeight = /\.user \.bubble \.prompt-text \{[^}]*line-height:\s*([\d.]+);/.exec(mainCss)?.[1];
  assert.ok(lineHeight, "the prompt's line height");
  assert.ok(section.includes(`max-height: calc(${lineHeight}em * var(--prompt-fold-lines))`),
    "the clamp is exactly that many of the prompt's lines");
  assert.match(section, /\.prompt-fold::before \{ content: attr\(data-label\); \}/, "the label is drawn, never text");
  const rest = section.indexOf('.user .bubble[data-fold="folded"] > .prompt-fold { position: absolute;');
  assert.ok(rest > 0 && /opacity: 0;/.test(section.slice(rest, section.indexOf("\n", rest))), "the pill rests at opacity 0");
  for (const reveal of [
    '.user .bubble[data-fold="folded"]:hover > .prompt-fold',
    '.user .bubble[data-fold="folded"]:has(:focus-visible) > .prompt-fold',
    '@media (hover: none) { .user .bubble[data-fold="folded"] > .prompt-fold { opacity: 1; } }',
    'body:is(.vscode-high-contrast, .vscode-high-contrast-light) .user .bubble[data-fold="folded"] > .prompt-fold { opacity: 1;',
    '@media (forced-colors: active) {',
  ]) assert.ok(section.indexOf(reveal) > rest, `revealed, after the rest rule: ${reveal}`);
  for (const bare of [
    '.user .bubble[data-fold="folded"] > .prompt-text:focus-within { -webkit-mask-image: none; mask-image: none; }',
    'body:is(.vscode-high-contrast, .vscode-high-contrast-light) .user .bubble[data-fold="folded"] > .prompt-text { -webkit-mask-image: none; mask-image: none; }',
  ]) assert.ok(section.includes(bare), `no fade: ${bare}`);
  assert.match(section, /@media \(forced-colors: active\) \{ \.user \.bubble\[data-fold="folded"\] > \.prompt-text \{ -webkit-mask-image: none; mask-image: none; \}/);
  // link-contrast.test.mjs reads forced-colors blocks up to the first "\n  }": nothing here may end one.
  assert.equal(section.includes("\n  }"), false);
  for (const line of section.split("\n").filter((row) => row.startsWith("@media"))) {
    assert.match(line, /\} \}$/, `an @media rule on one line: ${line.slice(0, 60)}`);
  }
  assert.equal(/\.bubble::after/.test(section), false, "never a pseudo-element on the bubble (steering-visible)");
  const outside = mainCss.slice(0, open) + mainCss.slice(close);
  assert.doesNotMatch(outside, /prompt-fold|data-fold\b/, "no rule elsewhere can override the fold");
});
