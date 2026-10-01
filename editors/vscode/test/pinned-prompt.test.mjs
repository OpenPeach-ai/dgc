// Each turn's prompt stays at the top of the transcript while its answer scrolls under it, the way the
// Claude Code extension does it (main.css, "0.47 pinned prompt"): the prompt is `position: sticky`
// inside its own box, so the end of that box pushes it off and the next prompt takes over.
//
// jsdom lays nothing out, so these hold what the boxes ARE -- which rows each one gathers, live and
// replayed, across history pages, reloads, chat switches and every way a turn starts -- and the script
// around the pin: the turn's prompt found by its request id (turn_start can beat prompt_accepted), the
// click that goes back to a prompt, the guard that keeps a prompt too tall for the window from pinning,
// and focus kept out from under a pinned prompt. Geometry is stood in for with stubbed rects. The real
// thing -- sticky, pushed off, handed back, the ground, the rest line -- is checked in Chromium by
// pinned-prompt-layout.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom, mainCss, mainJs } from "./support/webview-dom.mjs";

const turn = (id, prompt, extra = {}) => [
  { type: "turn_start", turn_id: id, prompt, kind: "prompt", ...extra },
  { type: "text_delta", text: `Answer ${id}.` },
  { type: "stream_end", message_id: `${id}:1`, phase: "answer" },
  { type: "turn_end", turn_id: id, reason: "completed", token_estimate: 0, final_message_id: `${id}:1` },
];
const ended = (id) => ({ type: "turn_end", turn_id: id, reason: "completed", token_estimate: 0, final_message_id: null });
const LONG = Array.from({ length: 12 }, (_, i) => `line ${i + 1}: keep it short`).join("\n");

// The transcript as a person scans it, top level first: a box is the list of what it holds, its
// pinned prompt as HEAD; any other prompt shows its role label; a DGC block that holds a steered
// message says so. Restored history is read through its container, which draws nothing itself.
function shape(log) {
  const row = (n) => n.matches(".msg.user")
    ? `${n.classList.contains("turn-head") ? "HEAD" : n.querySelector(":scope > .role")?.textContent}:${n.querySelector(":scope > .bubble").textContent}`
    : n.matches(".msg.dgc") ? (n.querySelector(".msg.user") ? "dgc+steer" : "dgc")
      : n.matches(".resume-note") ? "note" : n.matches(".sys") ? "sys" : n.matches(".compaction") ? "compaction" : n.className;
  const top = (n) => (n.classList.contains("turn") ? [...n.children].map(row) : row(n));
  return [...log.children].flatMap((n) => (n.classList.contains("history-pages")
    ? [...n.children].filter((m) => !m.matches(".history-older")).map(top) : [top(n)]));
}

function panel(options = {}) {
  const h = makeDom(options);
  const win = h.dom.window, doc = h.doc;
  const log = doc.getElementById("log"), input = doc.getElementById("input");
  const event = (data) => h.send({ type: "event", event: data });
  const events = (list) => { for (const data of list) event(data); };
  // Enter in the composer, the way a person sends; Alt+Enter queues behind a running turn.
  const type = (text, { queue = false } = {}) => {
    input.value = text;
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", altKey: queue, bubbles: true, cancelable: true }));
    return h.posted.filter((m) => m?.type === "prompt" || m?.type === "startGoal").at(-1)?.requestId;
  };
  const heads = () => [...log.querySelectorAll(".turn-head")];
  return { ...h, win, log, input, event, events, type, heads, shape: () => shape(log) };
}
// A running turn with live steering, and a prompt queued behind it (webview.test.mjs, queuedPromptDom).
function queuedPanel() {
  const p = panel({ scope: "workspace" });
  p.send({ type: "session_ready", sessionId: "alpha" });
  p.event({ type: "ready", capabilities: { live_steering: true, steering_native: true, resume_turn: true } });
  p.event({ type: "turn_start", turn_id: "t1", prompt: "Install the dependencies", kind: "prompt" });
  const queue = (text) => {
    const id = p.type(text, { queue: true });
    p.event({ type: "prompt_accepted", request_id: id, state: "queued" });
    return id;
  };
  return { ...p, queue, first: queue("Then run the tests") };
}

// ---- geometry stand-ins -----------------------------------------------------------------------------
const rect = (top, height) => ({ top, bottom: top + height, left: 0, right: 300, width: 300, height, x: 0, y: top });
// #log as a 500px view onto 4000px of transcript, at the end. `at` places laid-out content, which moves
// up as the log scrolls down; `fixed` places what does not move with it -- the log itself, and a prompt
// while it is pinned.
function scroller(p, { height = 4000, view = 500 } = {}) {
  let top = height - view;
  Object.defineProperty(p.log, "clientHeight", { configurable: true, get: () => view });
  Object.defineProperty(p.log, "scrollHeight", { configurable: true, get: () => height });
  Object.defineProperty(p.log, "scrollTop", { configurable: true, get: () => top,
    set: (value) => { top = Math.max(0, Math.min(value, height - view)); } });
  return {
    get top() { return top; },
    set top(value) { top = value; },
    at(node, y, size = 40) { const origin = top; node.getBoundingClientRect = () => rect(y - (top - origin), size); },
    fixed(node, y, size = 40) { node.getBoundingClientRect = () => rect(y, size); },
  };
}
// The head pinned: drawn on the rest line (the log's top, 100 -- jsdom has no padding), its box (and so
// its own place) beginning 500px above that.
function pin(p, view, head, { boxTop = -400, height = 80 } = {}) {
  view.fixed(p.log, 100, 500);
  view.at(head.parentElement, boxTop, 3000);
  view.fixed(head, 100, height);
}
// How a focus arrived. jsdom matches :focus-visible on every focus; a browser only after a key press.
const focusBy = (how, node) => {
  const real = node.matches.bind(node);
  node.matches = (selector) => (selector === ":focus-visible" ? how === "keyboard" : real(selector));
};
const click = (p, target, init = {}) => target.dispatchEvent(new p.win.MouseEvent("click",
  { bubbles: true, cancelable: true, detail: 1, button: 0, ...init }));
const pointerdown = (p, target) => target.dispatchEvent(new p.win.MouseEvent("pointerdown", { bubbles: true, button: 0 }));

// ---- what a box holds -------------------------------------------------------------------------------

test("a turn is one box, headed by the very row the composer drew", () => {
  const p = panel();
  const id = p.type("Fix the login bug");
  const row = p.log.lastElementChild;
  assert.equal(row.dataset.promptId, id, "the row knows which request it is");
  p.events([{ type: "prompt_accepted", request_id: id, state: "started" }, ...turn("t1", "Fix the login bug", { request_id: id })]);
  const box = p.log.querySelector(":scope > .turn");
  assert.equal(box.firstElementChild, row, "the row the composer drew heads the box: never a second bubble");
  assert.ok(row.classList.contains("turn-head"));
  assert.ok(box.lastElementChild.matches(".msg.dgc"));
  assert.deepEqual(p.shape(), [["HEAD:Fix the login bug", "dgc"]]);
  assert.deepEqual(p.errors, []);
});

test("turn_start can beat prompt_accepted: the prompt still heads its own turn, once, and is no longer a draft in doubt", () => {
  const p = panel();
  const id = p.type("Fix the login bug");
  assert.ok(p.savedState().pending.some((row) => row.id === id), "unacknowledged, it is kept as a draft in doubt");
  // The backend's worker thread emits turn_start; the command thread acknowledges after it.
  p.event({ type: "turn_start", turn_id: "t1", prompt: "Fix the login bug", kind: "prompt", request_id: id });
  assert.deepEqual(p.shape(), [["HEAD:Fix the login bug", "dgc"]],
    "not counted as a prompt still waiting and moved below its own answer, and not drawn twice");
  assert.equal(p.savedState().pending.some((row) => row.id === id), false, "a turn that started was delivered");
  const before = p.log.innerHTML;
  p.event({ type: "prompt_accepted", request_id: id, state: "started" });
  assert.equal(p.log.innerHTML, before, "the late acknowledgement changes nothing");
  p.events(turn("t1", "").slice(1));

  // Two sent before either starts: the first heads its box, the second waits below it, then queues.
  const a = p.type("Prompt A"), b = p.type("Prompt B");
  p.event({ type: "turn_start", turn_id: "t2", prompt: "Prompt A", kind: "prompt", request_id: a });
  assert.deepEqual(p.shape().slice(1), [["HEAD:Prompt A", "dgc"], "you:Prompt B"]);
  p.event({ type: "prompt_accepted", request_id: a, state: "started" });
  p.event({ type: "prompt_accepted", request_id: b, state: "queued" });
  assert.deepEqual(p.shape().slice(1), [["HEAD:Prompt A", "dgc"], "you · queued:Prompt B"]);
  // A rejection or a steering update for the request that started can no longer touch its prompt.
  p.event({ type: "steering_update", request_id: a, state: "queued" });
  p.send({ type: "prompt_rejected", requestId: a });
  assert.deepEqual(p.shape().slice(1, 2), [["HEAD:Prompt A", "dgc"]]);
  assert.deepEqual(p.errors, []);
});

test("the same words sent twice: each turn is headed by the row drawn for its own request", () => {
  const p = panel();
  const first = p.type("continue"), second = p.type("continue");
  const [one, two] = p.log.querySelectorAll(":scope > .msg.user");
  p.event({ type: "turn_start", turn_id: "t1", prompt: "continue", kind: "prompt", request_id: first });
  assert.equal(p.heads()[0], one, "the first turn is headed by the first row, not the last one with those words");
  assert.equal(p.log.lastElementChild, two, "the second waits below it");
  p.events([{ type: "prompt_accepted", request_id: first, state: "started" }, { type: "prompt_accepted", request_id: second, state: "queued" },
    ended("t1"), { type: "turn_start", turn_id: "t2", prompt: "continue", kind: "prompt", request_id: second }]);
  assert.deepEqual(p.heads(), [one, two]);
  assert.deepEqual(p.errors, []);
});

test("a goal's first turn, which carries no id, is headed by its goal row in either order, and its cycles join it", () => {
  for (const acceptFirst of [true, false]) {
    const p = panel();
    p.type("/goal Ship the release");
    const goal = p.posted.findLast((m) => m.type === "startGoal");
    const row = p.log.querySelector(".msg.user.goal-prompt");
    assert.equal(row.dataset.promptId, goal.requestId);
    if (acceptFirst) p.event({ type: "prompt_accepted", request_id: goal.requestId, state: "started" });
    p.event({ type: "turn_start", turn_id: "g1", prompt: "Ship the release", kind: "prompt" });
    if (!acceptFirst) p.event({ type: "prompt_accepted", request_id: goal.requestId, state: "started" });
    p.event(ended("g1"));
    assert.equal(p.log.querySelector(".turn").firstElementChild, row, `${acceptFirst ? "accepted" : "started"} first: the goal row heads it`);
    assert.equal(row.querySelector(".role").textContent, "goal", "with its own label");
    assert.equal(p.savedState().pending.some((entry) => entry.id === goal.requestId), false);
    // Every "Resumed the standing goal" cycle continues it: the goal stays pinned until the next prompt.
    p.events([{ type: "turn_start", turn_id: "g2", prompt: "Ship the release", kind: "resume" }, ended("g2"),
      { type: "turn_start", turn_id: "g3", prompt: "Ship the release", kind: "resume" }, ended("g3")]);
    assert.deepEqual(p.shape(), [["HEAD:Ship the release", "dgc", "note", "dgc", "note", "dgc"]]);
    assert.deepEqual(p.errors, []);
  }
});

test("/plan, whose turn carries no id, is drawn once and heads its turn in either order", () => {
  for (const acceptFirst of [true, false]) {
    const p = panel();
    const id = p.type("/plan add caching");
    if (acceptFirst) p.event({ type: "prompt_accepted", request_id: id, state: "started" });
    p.event({ type: "turn_start", turn_id: "w1", prompt: "/plan add caching", kind: "prompt" });
    if (!acceptFirst) p.event({ type: "prompt_accepted", request_id: id, state: "started" });
    assert.deepEqual(p.shape(), [["HEAD:/plan add caching", "dgc"]], acceptFirst ? "accepted first" : "started first");
    assert.deepEqual(p.errors, []);
  }
});

test("a turn with no id finds its prompt past a box that stray events drew before it started", () => {
  const p = panel();
  const id = p.type("/goal Ship the release");
  // Accepted, so no longer waiting: a turn begun by events that came first is drawn after it, not
  // above it as a waiting row would be...
  p.event({ type: "prompt_accepted", request_id: id, state: "started" });
  p.event({ type: "text_delta", text: "A line from a turn this panel never saw begin." });   // ensureTurn
  p.event(ended("x"));
  assert.deepEqual(p.shape(), ["goal:Ship the release", ["dgc"]]);
  // ...and the goal's own turn, which carries no id, still finds its row behind that box. The box drawn
  // first stays above the row: never a box inside a box.
  p.event({ type: "turn_start", turn_id: "g1", prompt: "Ship the release", kind: "prompt" });
  assert.deepEqual(p.shape(), [["dgc"], ["HEAD:Ship the release", "dgc"]], "one goal row, heading its own answer");
  assert.equal(p.log.querySelectorAll(".turn .turn").length, 0);
  assert.deepEqual(p.errors, []);
});

test("a queued prompt heads its own turn, loses its waiting note, and what was logged meanwhile stays between it and its answer", () => {
  const p = queuedPanel();
  p.queue("Then update the changelog");
  p.event(ended("t1"));
  p.event({ type: "compacted", before_tokens: 60000, after_tokens: 20000, context_size: 65536, strategy: "summary" });
  p.event({ type: "turn_start", turn_id: "t2", prompt: "Then run the tests", kind: "prompt", request_id: p.first });
  assert.deepEqual(p.shape(), [["HEAD:Install the dependencies", "dgc"], ["HEAD:Then run the tests", "sys", "dgc"],
    "you · queued:Then update the changelog"]);
  const head = p.heads()[1];
  assert.equal(head.querySelector(".steer-note"), null, "no longer waiting: '↳ queued for the next turn' goes");
  assert.equal(head.dataset.steer, undefined);
  assert.equal(head.querySelector(".role").textContent, "you");
  const waiting = p.log.lastElementChild;
  assert.equal(waiting.dataset.steer, "queued", "the one still waiting keeps saying so");
  assert.match(waiting.querySelector(".steer-note").textContent, /queued for the next turn/);
  assert.deepEqual(p.errors, []);
});

test("a turn with no id never adopts a queued prompt, even one with the same words", () => {
  const p = queuedPanel();
  p.queue("Then update the changelog");
  p.event(ended("t1"));
  // A custom command or a turn begun elsewhere, whose words happen to be a queued prompt's.
  p.event({ type: "turn_start", turn_id: "t2", prompt: "Then run the tests", kind: "prompt" });
  assert.deepEqual(p.shape(), [["HEAD:Install the dependencies", "dgc"], ["HEAD:Then run the tests", "dgc"],
    "you · queued:Then run the tests", "you · queued:Then update the changelog"],
  "its own prompt is drawn; both queued prompts keep waiting below it, in order");
  assert.deepEqual(p.errors, []);
});

test("a steered message never heads a turn", () => {
  const p = panel();
  p.event({ type: "ready", capabilities: { live_steering: true } });
  p.event({ type: "turn_start", turn_id: "t1", prompt: "deploy it", kind: "prompt" });
  const id = p.type("use staging-2");
  p.event({ type: "prompt_accepted", request_id: id, state: "steered" });
  p.event({ type: "steering_update", request_id: id, state: "applied" });
  const steered = p.log.querySelector(".msg.dgc > .msg.user");
  assert.ok(steered, "placed inside the running turn");
  assert.equal(steered.classList.contains("turn-head"), false);
  assert.deepEqual(p.heads().map((n) => n.querySelector(".bubble").textContent), ["deploy it"]);
  assert.deepEqual(p.shape(), [["HEAD:deploy it", "dgc+steer"]]);
  assert.deepEqual(p.errors, []);
});

test("turns nobody typed continue the box of the prompt above them; the next prompt opens a new one", () => {
  const p = panel();
  p.events(turn("t1", "Watch the dev server"));
  p.events([
    { type: "turn_start", turn_id: "w1", prompt: "npm run dev printed 2 lines", kind: "monitor" }, ended("w1"),
    { type: "turn_start", turn_id: "w2", prompt: "reviewer", kind: "wake" }, ended("w2"),
    { type: "turn_start", turn_id: "c1", prompt: "Continue the interrupted turn", kind: "continue" }, ended("c1"),
    { type: "turn_start", turn_id: "r1", prompt: "Watch the dev server", kind: "resume" }, ended("r1"),
  ]);
  p.event({ type: "handoff_started", request_id: "h1" });
  p.event(ended("h"));
  p.event({ type: "text_delta", text: "A line from a turn this panel never saw begin." });
  p.event(ended("x"));
  assert.deepEqual(p.shape(), [["HEAD:Watch the dev server", "dgc", "note", "dgc", "note", "dgc", "note", "dgc", "note", "dgc", "dgc", "dgc"]],
    "one box: the prompt they continue stays pinned through all of them");
  const id = p.type("Now fix the warning");
  p.events(turn("t2", "Now fix the warning", { request_id: id }));
  assert.deepEqual(p.shape().map((box) => box[0]), ["HEAD:Watch the dev server", "HEAD:Now fix the warning"]);
  assert.deepEqual(p.errors, []);
});

test("with no prompt above, a turn nobody typed gets a box of its own, and never one inside the restored history", () => {
  const p = panel();
  p.event({ type: "turn_start", turn_id: "w1", prompt: "npm run dev printed a line", kind: "monitor" });
  const box = p.log.querySelector(":scope > .turn");
  assert.ok(box.firstElementChild.matches(".resume-note.monitor-note"));
  assert.equal(box.querySelector(".turn-head"), null, "nothing to pin");

  const h = panel();
  h.event({ type: "history", items: turn("h1", "Earlier question") });
  h.event({ type: "turn_start", turn_id: "c1", prompt: "Continue the interrupted turn", kind: "continue" });
  const pages = h.log.querySelector(".history-pages");
  assert.ok(pages.nextElementSibling.matches(".turn"), "the live continuation is boxed after the history");
  assert.equal(pages.nextElementSibling.querySelector(".turn-head"), null);
  assert.equal(pages.querySelectorAll(".resume-note").length, 0, "the history container is replaced as a unit: nothing live goes in");
  assert.deepEqual([...h.log.querySelectorAll(".turn .turn")], [], "boxes never nest");
  assert.deepEqual([...p.errors, ...h.errors], []);
});

// ---- replay builds what live built ------------------------------------------------------------------

test("a replayed chat builds the boxes the live one built, and keeps a prompt repeated word for word", () => {
  const live = queuedPanel();
  const sendAndRun = (id, text) => {
    const request = live.type(text);
    live.events([{ type: "prompt_accepted", request_id: request, state: "started" }, ...turn(id, text, { request_id: request })]);
  };
  live.events(turn("t1", "").slice(1));                       // the dependencies turn ends
  live.event({ type: "turn_start", turn_id: "t2", prompt: "Then run the tests", kind: "prompt", request_id: live.first });
  const steer = live.type("use staging-2");                   // steered into the running turn
  live.events([{ type: "prompt_accepted", request_id: steer, state: "steered" }, { type: "steering_update", request_id: steer, state: "applied" },
    { type: "text_delta", text: "Running." }, ended("t2")]);
  sendAndRun("t3", "continue");
  sendAndRun("t4", "continue");
  live.events([{ type: "turn_start", turn_id: "w1", prompt: "npm run dev printed a line", kind: "monitor" }, ended("w1")]);

  const replay = panel();
  replay.event({ type: "history", items: [
    ...turn("h1", "Install the dependencies"),
    { type: "turn_start", turn_id: "h2", prompt: "Then run the tests", kind: "prompt" }, { role: "steering", text: "use staging-2" },
    { type: "text_delta", text: "Running." }, ended("h2"),
    ...turn("h3", "continue"), ...turn("h4", "continue"),
    { type: "turn_start", turn_id: "h5", prompt: "npm run dev printed a line", kind: "monitor" }, ended("h5"),
  ] });
  const want = [["HEAD:Install the dependencies", "dgc"], ["HEAD:Then run the tests", "dgc+steer"],
    ["HEAD:continue", "dgc"], ["HEAD:continue", "dgc", "note", "dgc"]];
  assert.deepEqual(live.shape(), want, "live");
  assert.deepEqual(replay.shape(), want, "replayed: the same boxes, and both of the identical prompts");
  assert.deepEqual([...live.errors, ...replay.errors], []);
});

test("a turn nobody typed at the top of a newer history page joins the older page's last box", () => {
  const p = panel();
  // Twenty whole turns of four events each: the newest page is the last thirteen (52 events), and it
  // begins with the continuation.
  const items = [];
  for (let i = 0; i < 20; i += 1) {
    items.push(...(i === 7 ? turn("c7", "Continue the interrupted turn", { kind: "continue" }) : turn(`h${i}`, `Question ${i}`)));
  }
  p.event({ type: "history", items });
  const pages = p.log.querySelector(".history-pages");
  const first = pages.querySelector(":scope > .turn");
  assert.ok(first.firstElementChild.matches(".resume-note.continue-note"), "the newest page opens with the continuation, in a box of its own");
  p.log.querySelector(".history-older").click();
  const boxes = [...pages.querySelectorAll(":scope > .turn")];
  assert.equal(boxes.length, 19, "twenty turns, one of them a continuation: nineteen boxes");
  const joined = boxes.find((box) => box.querySelector(".continue-note"));
  assert.deepEqual(shape(pages.parentElement).find((box) => Array.isArray(box) && box.includes("note")),
    ["HEAD:Question 6", "dgc", "note", "dgc"], "the continuation joined the box of the prompt it continues");
  assert.ok(joined.children[2].matches(".resume-note.continue-note"));
  assert.ok(boxes.every((box) => box.firstElementChild.classList.contains("turn-head")), "no box without a prompt is left at the seam");
  assert.ok([...pages.querySelectorAll(".msg.dgc")].every((block) => block.parentElement.classList.contains("turn")));
  assert.deepEqual(p.errors, []);
});

test("the archive's prompts are boxed and pinned over their answers", () => {
  const p = panel();
  p.event({ type: "history", items: turn("h1", "Live question") });
  p.event({ type: "recall", before: 0, more: false, items: [{ role: "user", text: "First archived question" },
    { role: "assistant", text: "One." }, { role: "assistant", text: "Two." },
    { role: "user", text: "Second archived question" }, { role: "assistant", text: "Three." }] });
  const boxes = [...p.log.querySelectorAll(".history-pages > .turn")];
  assert.deepEqual(boxes.map((box) => [...box.children].map((n) => [...n.classList].filter((c) => c !== "settled").join("."))), [
    ["msg.user.hist.archived.turn-head", "msg.dgc.hist.archived", "msg.dgc.hist.archived"],
    ["msg.user.hist.archived.turn-head", "msg.dgc.hist.archived"],
    ["msg.user.hist.turn-head", "msg.dgc.hist"],
  ]);
  assert.deepEqual(p.errors, []);
});

// ---- reloads, snapshots, chat switches ----------------------------------------------------------------

test("reloaded mid-turn: the snapshot's open turn is adopted in its box, and the live stream lands there", () => {
  const p = panel({ clock: true });
  p.send({ type: "session_ready", sessionId: "s1" });
  p.send({ type: "turn_active", turnId: "t2", kind: "prompt", prompt: "run the tests", startedAt: Date.now() - 4000, handoff: false, history: true });
  p.event({ type: "history", complete: true, seq: 9, items: [...turn("h1", "hello"),
    { type: "turn_start", turn_id: "t2", prompt: "run the tests", kind: "prompt" }, { type: "text_delta", text: "Running " }] });
  p.event({ type: "text_delta", text: "the suite now.", seq: 10 });
  p.advance(200);                                              // the streamed text renders on a timer
  const boxes = [...p.log.querySelectorAll(".turn")];
  assert.ok(boxes.every((box) => box.querySelector(":scope > .msg.dgc")), "every box holds a turn");
  assert.deepEqual(p.heads().map((n) => n.querySelector(".bubble").textContent), ["hello", "run the tests"], "one prompt per turn");
  assert.match(boxes.at(-1).querySelector(":scope > .msg.dgc").textContent, /Running the suite now\./, "the stream lands in the adopted turn");
  assert.deepEqual(p.errors, []);
});

test("no stale boxes: a provisional block leaves its box as it was; a complete snapshot unwraps the live boxes and keeps their lines", () => {
  // Events forwarded while the webview loaded drew a provisional block, which joined the box above.
  const p = panel();
  p.events(turn("t1", "hello"));
  p.event({ type: "text_delta", text: "early words " });
  assert.deepEqual(p.shape(), [["HEAD:hello", "dgc", "dgc"]]);
  p.send({ type: "session_ready", sessionId: "s1" });
  p.send({ type: "turn_active", turnId: "t2", kind: "prompt", prompt: "go", startedAt: Date.now(), handoff: false, history: true });
  assert.deepEqual(p.shape(), [["HEAD:hello", "dgc"]], "the provisional block goes; the box and its prompt stay");

  // A queued prompt's live turn, with a line logged before it started, then the complete snapshot.
  const q = queuedPanel();
  q.event(ended("t1"));
  q.event({ type: "error", message: "Provider hiccup, retrying" });
  q.event({ type: "turn_start", turn_id: "t2", prompt: "Then run the tests", kind: "prompt", request_id: q.first });
  assert.deepEqual(q.shape().at(-1), ["HEAD:Then run the tests", "sys", "dgc"]);
  q.send({ type: "turn_active", turnId: "t2", kind: "prompt", prompt: "Then run the tests", startedAt: Date.now(), handoff: false, history: true });
  q.event({ type: "history", complete: true, seq: 20, items: [...turn("h1", "Install the dependencies"),
    { type: "turn_start", turn_id: "t2", prompt: "Then run the tests", kind: "prompt" }] });
  assert.deepEqual([...q.log.querySelectorAll(":scope > .turn")], [], "no live box survives the snapshot");
  assert.equal(q.log.querySelectorAll(":scope > .sys").length, 1, "the line it logged is kept, as it always was");
  assert.deepEqual(q.heads().map((n) => n.querySelector(".bubble").textContent), ["Install the dependencies", "Then run the tests"]);

  // A provisional block with nothing above it had a box of its own: the box goes with it, or an empty
  // box would still take a gap in the column.
  const alone = panel();
  alone.event({ type: "text_delta", text: "early words " });
  assert.equal(alone.log.querySelectorAll(".turn").length, 1);
  alone.send({ type: "session_ready", sessionId: "s1" });
  alone.send({ type: "turn_active", turnId: "t1", kind: "prompt", prompt: "go", startedAt: Date.now(), handoff: false, history: true });
  assert.equal(alone.log.querySelectorAll(".turn").length, 0, "no empty box is left behind");

  // A live turn that already finished, then a complete snapshot that holds it (a reconnect): its box
  // is taken apart like the rest of the live transcript, so the turn is not shown twice.
  const done = panel();
  done.send({ type: "session_ready", sessionId: "s1" });
  const id = done.type("Fix the login bug");
  done.events([{ type: "prompt_accepted", request_id: id, state: "started" }, ...turn("t1", "Fix the login bug", { request_id: id })]);
  done.event({ type: "history", complete: true, seq: 9, items: turn("t1", "Fix the login bug") });
  assert.deepEqual(done.shape(), [["HEAD:Fix the login bug", "dgc"]], "the snapshot's copy, once");
  assert.equal(done.log.querySelectorAll(":scope > .turn").length, 0, "inside the history, nothing live left over");
  assert.deepEqual([...p.errors, ...q.errors, ...alone.errors, ...done.errors], []);
});

test("a turn is found by its request id even when the backend words it differently: an answer to a question, a restored steer", () => {
  // An answer to an open question is sent as a prompt with an `ask-` id; if its turn starts before the
  // acknowledgement, that id is what finds the row.
  const p = panel();
  p.event({ type: "turn_start", turn_id: "t1", prompt: "deploy it", kind: "prompt" });
  p.event({ type: "ask_request", ask_id: "a1", question: "Which staging host should I deploy to?" });
  const card = p.doc.querySelector('.open-ask[data-ask-id="a1"]');
  card.querySelector(".open-ask-input").value = "staging-2";
  card.querySelector(".open-ask-send").click();
  const answer = p.log.lastElementChild;
  assert.equal(answer.dataset.promptId, "ask-a1");
  p.event(ended("t1"));
  p.event({ type: "turn_start", turn_id: "t2", prompt: "The user answered: staging-2", kind: "prompt", request_id: "ask-a1" });
  assert.equal(p.heads().at(-1), answer, "the answer row heads the turn it started");
  assert.ok(answer.querySelector(".answered-q"), "with the question it answers");
  assert.equal(p.log.querySelectorAll(".msg.user").length, 2, "and nothing was drawn twice");

  // A steering message the backend still held when the webview reloaded comes back pending; when the
  // backend turns it into a turn of its own, its id finds the restored row.
  const r = panel();
  r.send({ type: "session_ready", sessionId: "s1" });
  r.send({ type: "prompts_queued", items: [{ requestId: "web-1", text: "use staging-2", steering: true }] });
  const restored = r.log.lastElementChild;
  assert.equal(restored.dataset.promptId, "web-1");
  r.event({ type: "turn_start", turn_id: "t3", prompt: "Steering that arrived after the turn: use staging-2", kind: "prompt", request_id: "web-1" });
  assert.equal(r.heads().at(-1), restored);
  assert.equal(r.log.querySelectorAll(".msg.user").length, 1);
  assert.equal(restored.querySelector(".role").textContent, "you", "it is a turn's prompt now, not a steer still pending");
  assert.equal(restored.querySelector(".steer-note"), null);
  assert.deepEqual([...p.errors, ...r.errors], []);
});

test("a chat switch empties the transcript, boxes and all, and the incoming chat builds its own", () => {
  const p = panel();
  p.events(turn("t1", "From the first chat"));
  p.send({ type: "chat_switched", slotId: "chat-2", label: "" });
  assert.equal(p.log.children.length, 0);
  p.event({ type: "history", items: [...turn("h1", "From the second chat"), ...turn("h2", "And another")] });
  assert.deepEqual(p.shape(), [["HEAD:From the second chat", "dgc"], ["HEAD:And another", "dgc"]]);
  assert.deepEqual(p.errors, []);
});

// ---- going back to a prompt -------------------------------------------------------------------------

test("a click on a turn's prompt goes back to where it was sent, after 300ms, and stops following", () => {
  const p = panel({ clock: true });
  const view = scroller(p);
  p.events(turn("t1", "Fix the login bug").slice(0, 2));        // still answering
  const head = p.heads()[0], text = head.querySelector(".prompt-text");
  pin(p, view, head);
  click(p, text);
  p.advance(299);
  assert.equal(view.top, 3500, "a single click waits 300ms for a second one");
  p.advance(1);
  assert.equal(view.top, 3000, "then the start of the turn is back under its prompt");
  assert.equal(p.doc.getElementById("to-latest").hidden, false, "the Latest pill offers the end again");
  p.event({ type: "text_delta", text: " Still going." });
  p.advance(100);
  assert.equal(view.top, 3000, "following stopped: the stream does not take the reader back down");
  assert.equal(p.doc.getElementById("to-latest-label").textContent, "New");
  // In its own place now: a click on it has nothing to do.
  click(p, text);
  p.advance(400);
  assert.equal(view.top, 3000);
  assert.deepEqual(p.errors, []);
});

test("clicks that never jump: a link, a modifier, another button, a double-click, clearing a selection, focusing the panel", () => {
  const p = panel({ clock: true });
  const view = scroller(p);
  p.events(turn("t1", "Read https://vibedgc.com/docs first").slice(0, 2));
  const head = p.heads()[0], text = head.querySelector(".prompt-text"), link = head.querySelector(".prompt-link");
  pin(p, view, head);
  const selection = p.win.getSelection();
  const select = () => selection.setBaseAndExtent(text.firstChild, 0, text.firstChild, 4);
  const tries = {
    "a link in the prompt": () => click(p, link),
    "Alt": () => click(p, text, { altKey: true }),
    "Ctrl": () => click(p, text, { ctrlKey: true }),
    "Meta": () => click(p, text, { metaKey: true }),
    "Shift": () => click(p, text, { shiftKey: true }),
    "the right button": () => click(p, text, { button: 2 }),
    "a double-click": () => { click(p, text); p.advance(150); click(p, text, { detail: 2 }); },
    "the click that clears a selection": () => { select(); pointerdown(p, text); selection.removeAllRanges(); click(p, text); },
    "a selection made before it lands": () => { click(p, text); select(); },
    "the click that focused the panel": () => { p.doc.hasFocus = () => false; pointerdown(p, text); delete p.doc.hasFocus; click(p, text); },
  };
  for (const [what, act] of Object.entries(tries)) {
    act();
    p.advance(400);
    assert.equal(view.top, 3500, `no jump: ${what}`);
    selection.removeAllRanges();
  }
  assert.ok(p.posted.some((m) => m.type === "openExternal"), "the link still opens");
  click(p, text);
  p.advance(300);
  assert.equal(view.top, 3000, "and a plain click still goes back");
  assert.deepEqual(p.errors, []);
});

// ---- the fold, pinned -------------------------------------------------------------------------------

test("Show more on a pinned prompt opens it in its own place; Show less brings its top back where it pins", () => {
  const p = panel({ layout: {}, clock: true });
  const view = scroller(p);
  p.events(turn("t1", LONG).slice(0, 2));
  const head = p.heads()[0], bubble = head.querySelector(".bubble");
  assert.equal(bubble.dataset.fold, "folded", "a long prompt pins folded");
  pin(p, view, head);
  bubble.querySelector(".prompt-fold").click();
  assert.equal(bubble.dataset.fold, "open");
  assert.equal(view.top, 3000, "it went back to where it was sent first, then opened there");

  // Read down into it, its top above the view, then fold it: once folded it pins again, drawn on the
  // rest line, so where it is laid out has to come from its box.
  view.at(head.parentElement, -300, 3000);
  view.fixed(head, 100, 80);
  view.fixed(bubble, 100, 80);
  bubble.querySelector(".prompt-fold").click();
  assert.equal(bubble.dataset.fold, "folded");
  assert.equal(view.top, 3000 - 416, "its laid-out top (400px above the view) comes back 16px below the edge");

  // Not pinned, a prompt opens where it is: nothing scrolls.
  view.at(head.parentElement, 200, 3000);
  view.fixed(head, 200, 80);
  bubble.querySelector(".prompt-fold").click();
  assert.equal(bubble.dataset.fold, "open");
  assert.equal(view.top, 3000 - 416);
  assert.deepEqual(p.errors, []);
});

// ---- the guard ----------------------------------------------------------------------------------------

test("a prompt pins only while its strip fits in 30% of the window, decided from the observer's sizes", () => {
  const p = panel({ resizeObservers: true });
  Object.defineProperty(p.win, "innerHeight", { configurable: true, value: 600 });
  p.events(turn("t1", "Fix the login bug"));
  const head = p.heads()[0];
  const sized = (blockSize) => p.resize(head, { borderBoxSize: [{ blockSize }] });
  sized(200);
  assert.ok(head.classList.contains("pin-off"), "200px and its 28px of ground and fade is more than 180");
  sized(150);
  assert.equal(head.classList.contains("pin-off"), false, "150 + 28 fits in 180");
  sized(160);
  assert.ok(head.classList.contains("pin-off"), "160 alone would fit, but not with the strip's 28px");
  sized(150);
  sized(0);
  assert.equal(head.classList.contains("pin-off"), false, "a size of 0 is not rendered: the decision stands");
  Object.defineProperty(p.win, "innerHeight", { configurable: true, value: 400 });
  p.win.dispatchEvent(new p.win.Event("resize"));
  assert.ok(head.classList.contains("pin-off"), "a shorter window decides again from the last real height (178 > 120), not from 0");
  Object.defineProperty(p.win, "innerHeight", { configurable: true, value: 600 });
  p.win.dispatchEvent(new p.win.Event("resize"));
  sized(200); sized(0);
  assert.ok(head.classList.contains("pin-off"), "either way");
  p.resize(head, { contentRect: { height: 150 } });
  assert.equal(head.classList.contains("pin-off"), false, "an observer that only reports contentRect");
  Object.defineProperty(p.win, "innerHeight", { configurable: true, value: 400 });
  p.win.dispatchEvent(new p.win.Event("resize"));
  assert.ok(head.classList.contains("pin-off"), "a shorter window: 178 > 120, decided again with no new measurement");
  Object.defineProperty(p.win, "innerHeight", { configurable: true, value: 900 });
  p.win.dispatchEvent(new p.win.Event("resize"));
  assert.equal(head.classList.contains("pin-off"), false);
  assert.match(mainJs, /const PIN_SHARE = 0\.3;/);
  assert.deepEqual(p.errors, []);
});

// ---- focus --------------------------------------------------------------------------------------------

test("keyboard focus is brought out from under a pinned prompt; mouse focus and the prompt's own controls are left alone", () => {
  const p = panel();
  const view = scroller(p);
  p.events([turn("t1", "Deploy it, see https://vibedgc.com/docs")[0]]);
  p.event({ type: "permission_request", id: "r1", name: "bash", command: "ls", args: {}, summary: "ls", choices: ["once", "always", "deny"] });
  const head = p.heads()[0];
  pin(p, view, head);                                          // its foot at 180, its fade to 192
  const [button, other] = p.log.querySelectorAll('.card[data-request-id="r1"] button');
  view.at(button, 150, 28);
  focusBy("mouse", button);
  button.focus();
  assert.equal(view.top, 3500, "a mouse press focuses a button too, and moving it would lose the click: no scroll");
  button.blur();
  focusBy("keyboard", button);
  button.focus();
  assert.equal(view.top, 3500 - 42, "a Tab to it brings it out: 180 + 12 - 150");
  view.at(other, 205, 28);
  focusBy("keyboard", other);
  other.focus();
  assert.equal(view.top, 3500 - 42, "a control already clear of the fade stays where it is");
  const link = head.querySelector(".prompt-link");
  view.fixed(link, 120, 20);
  focusBy("keyboard", link);
  link.focus();
  assert.equal(view.top, 3500 - 42, "a link in the pinned prompt itself is where it should be");
  // Out of view above (Shift+Tab back into the turn): focusin comes before the browser brings it in,
  // which is the browser's to do -- and a focus asked for without scrolling must stay that way.
  const third = p.log.querySelectorAll('.card[data-request-id="r1"] button')[2];
  view.at(third, 30, 28);
  focusBy("keyboard", third);
  third.focus();
  assert.equal(view.top, 3500 - 42, "above the view, it is left alone");
  // A prompt in its own place covers nothing: a control just under it stays where it is.
  view.at(head.parentElement, 100, 3000);
  view.at(head, 100, 80);
  third.blur();
  view.at(third, 184, 28);
  third.focus();
  assert.equal(view.top, 3500 - 42, "not pinned, nothing to clear");
  assert.deepEqual(p.errors, []);
});

test("a request card DGC focuses, and the chip the image viewer gives focus back to, end up below a pinned prompt", async () => {
  const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const p = panel();
  const view = scroller(p);
  p.event({ type: "ready", capabilities: { image_views: true } });
  p.event({ type: "turn_start", turn_id: "t1", prompt: "look at the page", kind: "prompt" });
  p.event({ type: "tool_call", call_id: "c1", name: "browser", args: {}, summary: "browser" });
  p.event({ type: "tool_result", call_id: "c1", name: "browser", output: "screenshot saved", is_error: false, is_diff: false });
  p.event({ type: "tool_images", call_id: "c1", images: [PNG] });
  const card = p.log.querySelector('.tool[data-call-id="c1"]');
  card.querySelector(".tool-toggle").click();
  const chip = card.querySelector(".image-chip");
  chip.click();
  p.event({ type: "permission_request", id: "p1", name: "bash", command: "rm -rf build", args: {}, summary: "rm -rf build",
    suggested_rule: "Bash", choices: ["once", "always", "deny"] });
  await new Promise((done) => p.win.setTimeout(done, 0));
  const head = p.heads()[0];
  pin(p, view, head);
  // Show is clicked with the mouse, so the focus DGC then moves is not :focus-visible and the focusin
  // nudge stays out of it: what clears the card is the call after its scrollIntoView.
  const request = p.log.querySelector('.card[data-request-id="p1"]');
  for (const control of request.querySelectorAll("button, input, select, textarea, [tabindex]")) {
    view.at(control, 150, 28);
    focusBy("mouse", control);
  }
  p.doc.querySelector("#image-viewer .iv-notice button").click();      // Show
  assert.ok(request.contains(p.doc.activeElement), "focus is on the card");
  assert.equal(view.top, 3500 - 42, "and its control is clear of the prompt: 180 + 12 - 150");

  chip.click();                                                        // the viewer again; Close gives focus back
  view.top = 3500;
  view.at(chip, 160, 40);
  focusBy("mouse", chip);
  p.doc.querySelector("#image-viewer .iv-close").click();
  assert.equal(p.doc.activeElement, chip);
  assert.equal(view.top, 3500 - 32, "the chip it lands on is clear of it too: 180 + 12 - 160");
  assert.deepEqual(p.errors, []);
});

test("moving a row into its box keeps its focus and its selection", () => {
  const p = queuedPanel();
  const id = p.queue("Then read https://vibedgc.com/docs closely");
  p.event(ended("t1"));
  p.event({ type: "turn_start", turn_id: "t2", prompt: "Then run the tests", kind: "prompt", request_id: p.first });
  p.event(ended("t2"));
  const row = p.log.lastElementChild;
  const link = row.querySelector(".prompt-link"), text = row.querySelector(".prompt-text").firstChild;
  link.focus();
  const selection = p.win.getSelection();
  selection.setBaseAndExtent(text, 2, text, 9);
  p.event({ type: "turn_start", turn_id: "t3", prompt: "Then read https://vibedgc.com/docs closely", kind: "prompt", request_id: id });
  assert.ok(row.classList.contains("turn-head") && row.parentElement.classList.contains("turn"), "the row moved into its box");
  assert.equal(p.doc.activeElement, link, "the link it held keeps focus");
  assert.deepEqual([selection.anchorNode, selection.anchorOffset, selection.focusNode, selection.focusOffset], [text, 2, text, 9],
    "and the selection in it is as it was");
  assert.deepEqual(p.errors, []);
});

test("rows a starting turn moves out of its way keep their focus too: one claimed out of order, one still waiting", () => {
  for (const focusIn of ["claimed", "waiting"]) {
    const p = queuedPanel();                                   // "Then run the tests" queued first
    const second = p.queue("Then read https://vibedgc.com/docs closely");
    p.event(ended("t1"));
    const rows = [...p.log.querySelectorAll(":scope > .msg.user")];
    const link = (focusIn === "claimed" ? rows[1] : rows[0]).querySelector(".prompt-link") ?? null;
    const target = link || rows[0].querySelector(".prompt-text");
    if (!link) target.tabIndex = -1;
    target.focus();
    // The backend runs the second one first: its row moves up past the first, which then waits below.
    p.event({ type: "turn_start", turn_id: "t2", prompt: "Then read https://vibedgc.com/docs closely", kind: "prompt", request_id: second });
    assert.deepEqual(p.shape().slice(1), [["HEAD:Then read https://vibedgc.com/docs closely", "dgc"], "you · queued:Then run the tests"]);
    assert.equal(p.doc.activeElement, target, `focus held in the ${focusIn} row through the move`);
    assert.deepEqual(p.errors, []);
  }
});

test("Show less on a steered message under the pinned prompt brings it out below the prompt", () => {
  const p = panel({ layout: {}, clock: true });
  const view = scroller(p);
  p.event({ type: "ready", capabilities: { live_steering: true } });
  p.event({ type: "turn_start", turn_id: "t1", prompt: "deploy it", kind: "prompt" });
  const id = p.type(LONG);
  p.events([{ type: "prompt_accepted", request_id: id, state: "steered" }, { type: "steering_update", request_id: id, state: "applied" },
    { type: "text_delta", text: "Deploying." }]);
  const steer = p.log.querySelector(".msg.dgc > .msg.user"), bubble = steer.querySelector(".bubble");
  assert.equal(bubble.dataset.fold, "folded", "a long steer folds like any prompt");
  bubble.querySelector(".prompt-fold").click();
  assert.equal(bubble.dataset.fold, "open");
  pin(p, view, p.heads()[0]);                                  // the turn's own prompt pinned, its foot at 180
  view.at(steer, 120, 300);
  view.at(bubble, 120, 300);
  const before = view.top;
  bubble.querySelector(".prompt-fold").click();
  assert.equal(bubble.dataset.fold, "folded");
  assert.equal(view.top, before - 72, "its top, hidden under the prompt, comes out 12px below it: 180 + 12 - 120");
  assert.deepEqual(p.errors, []);
});

// ---- the stylesheet -----------------------------------------------------------------------------------

// Every ruleset in source order as { selector, body }: a brace-depth scan, @media bodies recursed and
// comma groups split at the top level only (file-kind-cascade.test.mjs has the reasons).
function rules(css, top = true) {
  if (top) css = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = [];
  let depth = 0, start = 0, selector = "";
  for (let i = 0; i < css.length; i += 1) {
    if (css[i] === "{") { if (depth === 0) { selector = css.slice(start, i).trim(); start = i + 1; } depth += 1; }
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        const body = css.slice(start, i);
        if (selector.startsWith("@")) out.push(...rules(body, false).map((rule) => ({ ...rule, media: selector })));
        else for (const one of splitGroup(selector)) out.push({ selector: one, body });
        start = i + 1;
      }
    }
  }
  return out;
}
function splitGroup(selector) {
  const out = [];
  let depth = 0, start = 0;
  for (let i = 0; i < selector.length; i += 1) {
    const ch = selector[i];
    if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") depth -= 1;
    else if (ch === "," && depth === 0) { out.push(selector.slice(start, i).trim()); start = i + 1; }
  }
  out.push(selector.slice(start).trim());
  return out.filter(Boolean);
}
// [ids, classes + attributes + pseudo-classes, types + pseudo-elements]. :is/:not/:has take their most
// specific argument; :where counts nothing (Selectors 4).
function specificity(selector) {
  let a = 0, b = 0, c = 0;
  const rest = selector.replace(/:(is|not|has|where)\(((?:[^()]|\((?:[^()]|\([^()]*\))*\))*)\)/g, (_, name, args) => {
    if (name !== "where") {
      const best = splitGroup(args).map((arg) => specificity(arg.replace(/^[>+~]\s*/, ""))).sort(compare).at(-1);
      a += best[0]; b += best[1]; c += best[2];
    }
    return " ";
  }).replace(/\[[^\]]*\]/g, () => { b += 1; return " "; });
  a += (rest.match(/#[\w-]+/g) || []).length;
  b += (rest.match(/\.[\w-]+/g) || []).length + (rest.match(/(?<!:):[\w-]+/g) || []).length;
  c += (rest.match(/::[\w-]+/g) || []).length + (rest.match(/(?:^|[\s>+~])[a-z][\w-]*/gi) || []).length;
  return [a, b, c];
}
function compare(x, y) { return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; }
// The compound a selector styles: what follows its last combinator outside any brackets.
function subject(selector) {
  let depth = 0, cut = 0;
  for (let i = 0; i < selector.length; i += 1) {
    const ch = selector[i];
    if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") depth -= 1;
    else if (depth === 0 && /[\s>+~]/.test(ch)) cut = i + 1;
  }
  return selector.slice(cut).trim();
}
const declares = (rule, property) => new RegExp(`(?:^|[;{\\s])${property}\\s*:`).test(rule.body);

test("the stylesheet: one box, one sticky prompt, every override winning on specificity", () => {
  const open = mainCss.indexOf("/* ---- 0.47 pinned prompt -"), close = mainCss.indexOf("/* ---- end 0.47 pinned prompt -");
  assert.equal(mainCss.split("/* ---- 0.47 pinned prompt -").length, 2, "one section");
  assert.ok(open > mainCss.indexOf("/* ---- end long prompts -") && close > open && close < mainCss.indexOf("0.40.0 lane sections"),
    "after the long prompts it pins folded, before the lane sections (nothing may follow them)");
  const section = mainCss.slice(open, close), mine = rules(section), all = rules(mainCss);
  const find = (selector) => {
    const hit = mine.find((rule) => rule.selector === selector && !rule.media);
    assert.ok(hit, `rule ${selector}`);
    return hit;
  };

  assert.match(find("#log").body, /isolation:\s*isolate/, "the transcript's z-indices stay inside it");
  assert.match(find(".turn").body, /^\s*flex: none; display: flex; flex-direction: column; gap: var\(--sp-4\);\s*$/,
    "a box is a column with #log's own gap and nothing else");
  // NEVER overflow, contain, content-visibility, a transform or display: contents on a box: each stops
  // the pin with no error. `.turn(?![\w-])` leaves .turn-head and .turn-summary out.
  for (const rule of all.filter((r) => /\.turn(?![\w-])/.test(subject(r.selector)))) {
    assert.doesNotMatch(rule.body, /(?:^|[;\s])(?:overflow(?:-[xy])?|contain|content-visibility|transform)\s*:|display:\s*contents/,
      `${rule.selector} must not make the box a scroller, a container or no box at all`);
  }

  const sticky = find(".turn > .msg.user.turn-head");
  for (const want of [/position:\s*sticky/, /top:\s*0/, /z-index:\s*2/, /content-visibility:\s*visible/]) assert.match(sticky.body, want);
  const positioned = all.filter((rule) => /\.turn-head/.test(subject(rule.selector)) && !/::/.test(rule.selector) && declares(rule, "position"));
  assert.deepEqual(positioned.map((rule) => rule.selector), [".turn > .msg.user.turn-head", ".turn > .msg.user.turn-head.pin-off",
    '.turn > .msg.user.turn-head:has(> .bubble[data-fold="open"])'], "only the pin and the two ways out of it place a turn's prompt");

  const ground = find(".turn > .msg.user.turn-head::before");
  for (const want of [/var\(--bg\)/, /var\(--surface\)/, /pointer-events:\s*none/, /z-index:\s*-1/, /mask-image:\s*linear-gradient/,
    /inset:\s*calc\(-1 \* var\(--sp-4\)\) calc\(-1 \* var\(--sp-4\)\) calc\(-1 \* var\(--sp-3\)\)/]) assert.match(ground.body, want);
  assert.match(mainJs, /const PIN_FADE_PX = 12;/, "the script's fade is the stylesheet's --sp-3");
  assert.match(mainJs, /const PIN_GROUND_PX = 28;/, "and its strip the ground's 16px above plus that fade");

  // The fold is only read, to let an open prompt scroll away; it is never styled from here.
  for (const rule of mine.filter((r) => /data-fold/.test(r.selector))) {
    assert.match(rule.selector, /^\.turn > \.msg\.user\.turn-head:has\(> \.bubble\[data-fold="open"\]\)(::before)?$/, rule.selector);
  }
  assert.doesNotMatch(section, /prompt-fold|prompt-text/, "nothing here touches the fold's own parts");
  // The outlines are only for the turn's prompt: steered and queued bubbles look as they always have.
  for (const rule of mine.filter((r) => declares(r, "outline"))) {
    assert.match(rule.selector, /\.turn > \.msg\.user\.turn-head > \.bubble$/, `${rule.selector}: an outline on turn prompts only`);
  }
  assert.ok(mine.some((r) => r.media === "@media (forced-colors: active)" && declares(r, "outline")), "forced colours get the edge too");
  assert.doesNotMatch(section, /\.bubble::after/, "never a pseudo-element on the bubble (steering-visible)");

  // Every override wins on specificity, never on where it sits.
  const wins = (mineSel, theirsSel, why) => assert.ok(compare(specificity(mineSel), specificity(theirsSel)) > 0,
    `${mineSel} ${JSON.stringify(specificity(mineSel))} must outrank ${theirsSel} ${JSON.stringify(specificity(theirsSel))}: ${why}`);
  wins(".turn > .msg.user.turn-head", ".msg.settled", "always rendered, or paint containment clips the ground");
  wins(".turn > .msg.user.turn-head.pin-off", ".turn > .msg.user.turn-head", "too tall: not pinned");
  wins('.turn > .msg.user.turn-head:has(> .bubble[data-fold="open"])', ".turn > .msg.user.turn-head", "open: not pinned");
  wins(".turn > .msg.user.turn-head.pin-off::before", ".turn > .msg.user.turn-head::before", "no ground when not pinned");
  wins('.turn > .msg.user.turn-head:has(> .bubble[data-fold="open"])::before', ".turn > .msg.user.turn-head::before", "no ground open");
  wins("body:is(.vscode-high-contrast, .vscode-high-contrast-light) .turn > .msg.user.turn-head::before", ".turn > .msg.user.turn-head::before", "a hard edge");
  wins("#log .turn > .msg.user.turn-head::before", "body:is(.vscode-high-contrast, .vscode-high-contrast-light) .turn > .msg.user.turn-head::before", "forced colours");
  for (const first of ["#log > .turn:first-child > .msg.user.turn-head", ".history-older[hidden] + .turn > .msg.user.turn-head",
    "#log > .history-pages:first-child:not(:has(> :not(.history-older[hidden]))) + .turn > .msg.user.turn-head"]) {
    find(first);
    wins(first, ".msg.user", "the first prompt sits on the log's padding");
  }
  assert.match(find(".msg.archived.turn-head").body, /opacity:\s*1\b/);
  assert.match(find(".msg.archived.turn-head > .bubble").body, /opacity:\s*\.82/, "the bubble is dimmed instead of the row");
  wins(".msg.archived.turn-head", ".msg.archived", "an archived prompt's ground stays opaque");
  assert.match(find(".turn > .msg.user.turn-head > .bubble").body, /cursor:\s*pointer/, "a turn's prompt shows it can be clicked");
  // link-contrast.test.mjs reads forced-colors blocks up to the first "\n  }": @media rules here stay on one line.
  assert.equal(section.includes("\n  }"), false);
  for (const line of section.split("\n").filter((row) => row.startsWith("@media"))) assert.match(line, /\} \}$/);

  // And the Latest pill keeps its own height (it was squeezed, and Latest stopped ~15px short).
  assert.ok(all.some((rule) => rule.selector === "#to-latest" && /(?:^|[;\s])flex:\s*none/.test(rule.body)), "#to-latest { flex: none }");
});
