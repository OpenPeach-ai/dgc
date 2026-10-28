// When each prompt was sent and each reply written, in DGC's chat (Work), ChatDGC and Pips (reported 2026-10-17:
// "there is no timestamp or date for user sent prompts and model's responses"). One formatter, media/msgtime.js,
// draws all three. Work's saved turns carry their times as {role: "time"} history markers (dgc/headless.py):
// a field on turn_start would be a field on an existing event, which the SDK refuses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom } from "./support/webview-dom.mjs";
import { messageMarkup } from "../src/pipsTranscript.js";   // imports media/msgtime.js: globalThis.DgcTime

const { label, title, markup } = globalThis.DgcTime;
const clock = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

test("the label: the time today, Yesterday, the weekday this week, then the date, with a year once it isn't this one", () => {
  const now = new Date(2026, 9, 17, 21, 5).getTime();           // Saturday 17 October 2026, 9:05 pm
  const at = (...a) => new Date(...a).getTime();
  assert.equal(label(at(2026, 9, 17, 9, 41), now), clock(at(2026, 9, 17, 9, 41)));
  assert.equal(label(at(2026, 9, 16, 23, 59), now), `Yesterday ${clock(at(2026, 9, 16, 23, 59))}`);
  const tuesday = at(2026, 9, 13, 8, 0);
  assert.equal(label(tuesday, now), `${new Date(tuesday).toLocaleDateString(undefined, { weekday: "short" })} ${clock(tuesday)}`);
  const august = at(2026, 7, 2, 14, 30);
  assert.equal(label(august, now), `${new Date(august).toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${clock(august)}`);
  assert.ok(label(at(2025, 11, 31, 10, 0), now).includes("2025"), "another year says which");
  assert.ok(!label(august, now).includes("2026"), "this year doesn't");
  assert.ok(title(august).includes("2026"), "the tooltip is the whole date");
  for (const bad of [NaN, Infinity, 0, -1, "1760000000000", null, undefined]) {
    assert.equal(label(bad, now), "", String(bad));
    assert.equal(markup(bad), "", String(bad));
  }
  assert.equal(markup(august), `<time class="msg-time" datetime="${new Date(august).toISOString()}" title="${title(august)}">${label(august)}</time>`);
});

// ---- Work (media/main.js) ----
const READY = { type: "ready", capabilities: { history_snapshot: true }, model: "m", mode: "auto", think: "off",
  base_url: "http://127.0.0.1:1/v1", workspace_trusted: true, commands: [], custom_commands: [],
  goal: { text: "", status: "none" }, context_size: 1 };
const SENT = 1_760_715_000, WRITTEN = SENT + 95;       // seconds since 1970, as the session file keeps them
const turn = (id, prompt, answer, times = true) => [
  { type: "turn_start", turn_id: id, prompt, kind: "prompt" },
  ...(times ? [{ role: "time", of: "prompt", at: SENT }] : []),
  { type: "text_delta", text: answer }, { type: "stream_end", message_id: `${id}:1`, phase: "answer" },
  ...(times ? [{ role: "time", of: "reply", at: WRITTEN }] : []),
  { type: "turn_end", turn_id: id, reason: "completed", final_message_id: `${id}:1` }];
function work(items) {
  const v = makeDom();
  v.send({ type: "event", event: READY });
  if (items) v.send({ type: "event", event: { type: "history", items, complete: true } });
  return v;
}

test("Work: a reopened chat says when each prompt was sent and each reply written, and how long it worked", () => {
  const v = work(turn("h1", "what changed?", "Two files."));
  const sent = v.doc.querySelector(".msg.user > .bubble + time.msg-time");
  assert.ok(sent, "under the prompt's bubble");
  assert.equal(sent.dateTime, new Date(SENT * 1000).toISOString());
  assert.equal(sent.textContent, label(SENT * 1000));
  assert.ok(sent.title.length > 10, "the whole date is the tooltip");
  const written = v.doc.querySelector(".answer > .response-actions > time.msg-time:first-child");
  assert.ok(written, "first in the reply's row");
  assert.equal(written.dateTime, new Date(WRITTEN * 1000).toISOString());
  assert.equal(v.doc.querySelector(".msg.dgc .thinking.done").textContent, "Worked for 95s");
  assert.deepEqual(v.errors, []);
});

test("Work: a stopped turn's reply keeps its time, but no duration: when it stopped isn't saved", () => {
  const items = turn("h1", "what changed?", "Two fi");
  items.at(-1).reason = "cancelled";
  const v = work(items);
  assert.ok(v.doc.querySelector(".answer > .response-actions > time.msg-time"));
  assert.equal(v.doc.querySelector(".msg.dgc .thinking.done").textContent, "Stopped");
});

test("Work: a chat saved before DGC kept times shows none, and still no made-up duration", () => {
  const v = work(turn("h1", "what changed?", "Two files.", false));
  assert.equal(v.doc.querySelectorAll("time.msg-time").length, 0);
  assert.equal(v.doc.querySelector(".msg.dgc .thinking.done").textContent, "Worked");
});

test("Work: a time marker outside any turn, or with no time in it, is passed over", () => {
  const v = work([{ role: "time", of: "prompt", at: SENT }, ...turn("h1", "q", "a", false).slice(0, 1),
    { role: "time", of: "prompt", at: "soon" }, { role: "time", of: "reply", at: -4 }, ...turn("h1", "q", "a", false).slice(1)]);
  assert.equal(v.doc.querySelectorAll("time.msg-time").length, 0);
  assert.deepEqual(v.errors, []);
});

test("Work: live, the prompt is stamped when its turn starts and the reply when it ends", () => {
  const v = work();
  const before = Date.now();
  v.send({ type: "event", event: { type: "turn_start", turn_id: "t1", prompt: "hello", kind: "prompt" } });
  const sent = v.doc.querySelector(".msg.user > time.msg-time");
  assert.ok(sent);
  assert.ok(Date.parse(sent.dateTime) >= before - 1000 && Date.parse(sent.dateTime) <= Date.now() + 1000);
  v.send({ type: "event", event: { type: "text_delta", text: "Hi." } });
  v.send({ type: "event", event: { type: "stream_end", message_id: "t1:1", phase: "answer" } });
  v.send({ type: "event", event: { type: "turn_end", turn_id: "t1", reason: "completed", final_message_id: "t1:1" } });
  const written = v.doc.querySelector(".answer > .response-actions > time.msg-time:first-child");
  assert.ok(written);
  assert.ok(Date.parse(written.dateTime) >= Date.parse(sent.dateTime) - 1000);
  assert.deepEqual(v.errors, []);
});

// ---- Pips (src/pipsTranscript.js) ----
const options = { name: "Core", formatDate: String, renderMarkdown: (t) => `<p>${t}</p>`, canSend: true };
const row = (html) => html.match(/<div class="response-actions">([\s\S]*?)<\/div><\/article>$/)[1];

test("Pips: a prompt's time is last in its row (under the bubble's edge), a reply's first", () => {
  const at = "2026-10-17T09:00:00.000Z";
  const mine = row(messageMarkup({ id: "u1", role: "user", text: "hi", status: "succeeded", created_at: at }, options));
  const reply = row(messageMarkup({ id: "a1", role: "assistant", text: "hello", status: "succeeded", run_id: "r", created_at: at }, options));
  const time = markup(Date.parse(at));
  assert.ok(mine.replace(/<span class="copy-feedback[^>]*><\/span>$/, "").endsWith(time), mine);
  assert.ok(reply.startsWith(time), reply);
  assert.ok(!messageMarkup({ id: "u2", role: "user", text: "hi", status: "succeeded" }, options).includes("msg-time"),
    "no saved time, no time");
});

// Reported 25 Oct: "the mid-turn sent prompts do not get the timestamp like usual prompts". A message sent while a
// turn runs is folded into that turn, so no turn start ever stamped it.
function typed(v, text, { queue = false } = {}) {
  const input = v.doc.getElementById("input"), win = v.dom.window;
  input.value = text;
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
  input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", altKey: queue, bubbles: true, cancelable: true }));
  return v.posted.filter((m) => m?.type === "prompt").at(-1)?.requestId;
}
test("Work: a message steered into a running turn gets its time under its bubble, as every prompt does", () => {
  const v = makeDom();
  v.send({ type: "event", event: { ...READY, capabilities: { live_steering: true, steering_native: true } } });
  v.send({ type: "event", event: { type: "turn_start", turn_id: "t1", prompt: "deploy it", kind: "prompt" } });
  const before = Date.now();
  const id = typed(v, "use staging-2");
  v.send({ type: "event", event: { type: "prompt_accepted", request_id: id, state: "steered" } });
  v.send({ type: "event", event: { type: "steering_update", request_id: id, state: "applied" } });
  const steered = v.doc.querySelector("#log .msg.dgc > .msg.user");
  assert.ok(steered, "the steer is inside the running turn");
  const time = steered.querySelector(":scope > .msg-time");
  assert.ok(time, "it has a time");
  assert.ok(Date.parse(time.getAttribute("datetime")) >= before - 1000, "the time it was sent");
  assert.equal(steered.querySelectorAll(":scope > .msg-time").length, 1, "one time, not two");
  assert.deepEqual(v.errors, []);
});
test("Work: a queued message steered in later gets the time it was sent, once", () => {
  const v = makeDom();
  v.send({ type: "event", event: { ...READY, capabilities: { live_steering: true, steering_native: true, steer_queued: true } } });
  v.send({ type: "event", event: { type: "turn_start", turn_id: "t1", prompt: "deploy it", kind: "prompt" } });
  const id = typed(v, "then run the tests", { queue: true });
  v.send({ type: "event", event: { type: "prompt_accepted", request_id: id, state: "queued" } });
  const queued = [...v.doc.querySelectorAll("#log .msg.user")].find((n) => n.textContent.includes("then run the tests"));
  assert.equal(queued.querySelector(":scope > .msg-time"), null, "a queued message waits for its turn, or a steer, for its time");
  queued.querySelector(".steer-now").click();                  // the person presses Steer now
  v.send({ type: "event", event: { type: "prompt_accepted", request_id: id, state: "steered" } });
  v.send({ type: "event", event: { type: "steering_update", request_id: id, state: "applied" } });
  const steered = [...v.doc.querySelectorAll("#log .msg.user")].find((n) => n.textContent.includes("then run the tests"));
  assert.ok(steered?.querySelector(":scope > .msg-time"), "stamped when it was steered in");
  assert.equal(steered.querySelectorAll(":scope > .msg-time").length, 1);
  assert.deepEqual(v.errors, []);
});
test("Work: a reopened chat shows each steered message's own time", () => {
  const v = work([
    { type: "turn_start", turn_id: "t1", prompt: "deploy it", kind: "prompt" }, { role: "time", of: "prompt", at: SENT },
    { type: "text_delta", text: "Deploying." },
    { role: "time", of: "steering", at: SENT + 30 }, { role: "steering", text: "use staging-2" },
    { role: "steering", text: "an older save keeps no time" },
    { type: "stream_end", message_id: "t1:1", phase: "answer" },
    { type: "turn_end", turn_id: "t1", reason: "completed", final_message_id: "t1:1" }]);
  const steers = [...v.doc.querySelectorAll("#log .msg.dgc > .msg.user")];
  assert.equal(steers.length, 2);
  assert.equal(steers[0].querySelector(":scope > .msg-time")?.getAttribute("datetime"), new Date((SENT + 30) * 1000).toISOString());
  assert.equal(steers[1].querySelector(":scope > .msg-time"), null, "a steer saved without a time shows none, never the previous one's");
  assert.deepEqual(v.errors, []);
});
