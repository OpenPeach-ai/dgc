// Thinking provenance in the webview (0.40.0, editor protocol v14): labels per source, grouping,
// inline notes, withheld rows, tool-group order, replay parity and the settings select. jsdom only;
// the rendered checks (widths, contrast, clipping, forced colours) are in thinking-provenance.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDom, mainCss } from "./support/webview-dom.mjs";

const ev = (event) => ({ type: "event", event });
const start = (id = "t1") => ev({ type: "turn_start", turn_id: id, prompt: "Why is the gate failing?", kind: "prompt" });
const delta = (block, source, text, extra = {}) => ev({ type: "thinking_delta", block, source, text, ...extra });
const end = (block, source, extra = {}) => ev({ type: "thinking_end", block, source, placement: "collapsed", ...extra });

// The accessible name a screen reader computes for a button: its text without aria-hidden parts.
function accessibleName(node) {
  let out = "";
  for (const child of node.childNodes) {
    if (child.nodeType === 3) out += child.data;
    else if (child.nodeType === 1 && child.getAttribute("aria-hidden") !== "true") out += accessibleName(child);
  }
  return out;
}
const squash = (value) => value.replace(/\s+/g, " ").trim();

test("each source gets its label while streaming, finished, and on replay", () => {
  const { send, doc, errors } = makeDom();
  send(start());
  send(delta("t1:think1", "raw", "Okay, the user wants the gate fixed."));
  const header = () => doc.querySelectorAll(".disclosure")[0];
  assert.equal(squash(accessibleName(header())), "Thinking…, raw");
  send(end("t1:think1", "raw", { seconds: 14.2 }));
  send(ev({ type: "text_delta", text: "The gate compares with >." }));
  assert.equal(squash(accessibleName(header())), "Thought for 14s, raw");
  send(ev({ type: "stream_end", message_id: "t1:1", phase: "commentary" }));
  send(delta("t1:think2", "summarized", "A longer summary that is collapsed.", { provider: "anthropic" }));
  send(end("t1:think2", "summarized", { provider: "anthropic", seconds: 9 }));
  send(ev({ type: "text_delta", text: "Next." }));
  send(delta("t1:think3", "unknown", "Proxy thinking."));
  send(end("t1:think3", "unknown", { seconds: 3.4 }));
  send(ev({ type: "stream_end" }));
  const headers = [...doc.querySelectorAll(".disclosure")];
  assert.deepEqual(headers.map((h) => squash(accessibleName(h))),
    ["Thought for 14s, raw", "Thought for 9s, summarized by Anthropic", "Thought for 3s"]);
  assert.deepEqual(headers.map((h) => squash(h.textContent)),
    ["▸ Thought for 14s · , raw", "▸ Thought for 9s · , summarized by Anthropic", "▸ Thought for 3s"]);
  assert.match(headers[1].title, /Anthropic returned a summary of the model’s reasoning/);
  assert.match(headers[0].title, /Raw reasoning from the model/);
  assert.match(headers[2].title, /can’t tell/);
  assert.equal(headers[1].querySelector(".thought-by").textContent, " by Anthropic");
  assert.equal(headers[1].querySelector(".thought-chev").getAttribute("aria-hidden"), "true");

  // Replay: the same labels, and a block that kept no seconds reads "Thought".
  const restored = makeDom();
  restored.send(ev({ type: "history", items: [
    { type: "turn_start", turn_id: "h1", prompt: "q", kind: "prompt" },
    { type: "thinking_delta", block: "h1:think1", source: "summarized", provider: "openai", text: "Short plan." },
    { type: "thinking_end", block: "h1:think1", source: "summarized", provider: "openai", placement: "collapsed", seconds: 2 },
    { type: "thinking_delta", block: "h1:think2", source: "raw", text: "No timing kept." },
    { type: "thinking_end", block: "h1:think2", source: "raw", placement: "collapsed" },
    { type: "text_delta", text: "Answer." }, { type: "stream_end", message_id: "h1:1", phase: "answer" },
    { type: "turn_end", turn_id: "h1", reason: "completed", token_estimate: 0, final_message_id: "h1:1" }] }));
  assert.deepEqual([...restored.doc.querySelectorAll(".disclosure")].map((h) => squash(accessibleName(h))),
    ["Thought for 2s, summarized by OpenAI", "Thought, raw"]);
  assert.deepEqual(errors, []);
  assert.deepEqual(restored.errors, []);
});

test("groups follow (source, provider, agent) and a raw block after a summarized one splits", () => {
  const { send, doc } = makeDom();
  send(start());
  send(delta("t1:think1", "summarized", "First part.", { provider: "anthropic" }));
  send(delta("t1:think2", "summarized", "Second part.", { provider: "anthropic" }));
  send(delta("t1:think3", "raw", "Now raw."));
  send(delta("t1:think4", "raw", "Child raw.", { agent: "sub-0123456789ab" }));
  send(delta("t1:think5", "raw", "Child again.", { agent: "sub-0123456789ab" }));
  const bodies = [...doc.querySelectorAll(".reasoning")];
  assert.equal(bodies.length, 3);
  assert.equal(bodies[0].textContent, "First part.\n\nSecond part.");
  assert.equal(bodies[0].querySelectorAll(".thought-part").length, 2);
  assert.equal(bodies[1].dataset.source, "raw");
  assert.equal(bodies[2].dataset.agent, "sub-0123456789ab");
  assert.equal(bodies[2].textContent, "Child raw.\n\nChild again.");
});

test("a sub-agent's thinking says so: a visible prefix, the accessible name and the tooltip", () => {
  const { send, doc, errors } = makeDom();
  send(start());
  send(delta("t1:think1", "summarized", "Parent plan.", { provider: "anthropic" }));
  send(end("t1:think1", "summarized", { provider: "anthropic", seconds: 3 }));
  send(delta("t1:think2", "raw", "Child reads the files.", { agent: "sub-e051bf6ba1c3" }));
  send(end("t1:think2", "raw", { agent: "sub-e051bf6ba1c3", seconds: 2.3 }));
  send(end("t1:think3", "withheld", { provider: "anthropic", agent: "sub-e051bf6ba1c3", seconds: 4 }));
  const [parent, child] = [...doc.querySelectorAll(".disclosure")];
  assert.equal(parent.querySelector(".thought-agent"), null, "the chat's own thinking has no prefix");
  assert.equal(squash(accessibleName(parent)), "Thought for 3s, summarized by Anthropic");
  assert.equal(squash(accessibleName(child)), "Sub-agent, Thought for 2s, raw");
  assert.equal(squash(child.textContent), "▸ Sub-agent ·, Thought for 2s · , raw");
  assert.equal(child.title, "Raw reasoning from a sub-agent’s model, as it streamed.");
  assert.equal(parent.title.includes("sub-agent"), false);
  const row = doc.querySelector(".thought-static");
  assert.equal(squash(accessibleName(row)), "Sub-agent, Thought for 4s, hidden by Anthropic");
  assert.match(row.title, /Anthropic kept a sub-agent’s reasoning hidden/);
  assert.deepEqual(errors, []);
});

test("an end with no text never becomes an empty note, and a cut or missing text says so", () => {
  const { send, doc, errors } = makeDom();
  send(start());
  send(ev({ type: "tool_call", call_id: "c1", name: "bash", args: { command: "ls" }, summary: "ls" }));
  // Live, after the view was re-resolved: the block's deltas went to the old view.
  send(end("t1:think9", "summarized", { provider: "anthropic", placement: "inline", seconds: 2 }));
  assert.equal(doc.querySelectorAll(".thought-note").length, 0, "no note made of just the hint");
  const header = doc.querySelector(".disclosure");
  assert.equal(squash(accessibleName(header)), "Thought for 2s, summarized by Anthropic");
  assert.equal(header.nextElementSibling.querySelector(".thought-cut").textContent,
    "The text of this reasoning is not in this view.");
  assert.deepEqual(errors, []);

  // Replay past the history budget: a header only, and a stub with the rest cut.
  const restored = makeDom();
  restored.send(ev({ type: "history", items: [
    { type: "turn_start", turn_id: "h1", prompt: "q", kind: "prompt" },
    { type: "thinking_end", block: "h1:think1", source: "raw", placement: "collapsed", seconds: 12, truncated: true },
    { type: "text_delta", text: "Between." }, { type: "stream_end", message_id: "h1:1", phase: "commentary" },
    { type: "thinking_delta", block: "h1:think2", source: "summarized", provider: "openai", text: "A first slice" },
    { type: "thinking_end", block: "h1:think2", source: "summarized", provider: "openai", placement: "inline", seconds: 3, truncated: true },
    { type: "text_delta", text: "Answer." }, { type: "stream_end", message_id: "h1:2", phase: "answer" },
    { type: "turn_end", turn_id: "h1", reason: "completed", token_estimate: 0, final_message_id: "h1:2" }] }));
  const bodies = [...restored.doc.querySelectorAll(".reasoning")];
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].querySelector(".thought-cut").textContent, "The text of this reasoning was not kept.");
  assert.equal(bodies[1].firstElementChild.firstChild.data, "A first slice");
  assert.equal(bodies[1].querySelector(".thought-cut").textContent, "… the rest of this reasoning was not kept.");
  assert.equal(restored.doc.querySelectorAll(".thought-note").length, 0, "a cut summary is never inline");
  assert.deepEqual([...restored.doc.querySelectorAll(".disclosure")].map((h) => squash(accessibleName(h))),
    ["Thought for 12s, raw", "Thought for 3s, summarized by OpenAI"]);
  assert.deepEqual(restored.errors, []);
});

test("under half a second reads Thought, not Thought for 0s, and a static row keeps the chevron slot", () => {
  const { send, doc } = makeDom();
  send(start());
  send(delta("t1:think1", "raw", "Quick."));
  send(end("t1:think1", "raw", { seconds: 0.2 }));
  send(ev({ type: "text_delta", text: "Done." }));
  send(ev({ type: "stream_end", phase: "commentary" }));
  send(end("t1:think2", "withheld", { provider: "anthropic", seconds: 0 }));
  send(ev({ type: "text_delta", text: "Next." }));
  send(ev({ type: "stream_end", phase: "commentary" }));
  send(end("t1:think3", "withheld", { provider: "anthropic", seconds: 0.6 }));
  assert.equal(squash(accessibleName(doc.querySelector(".disclosure"))), "Thought, raw");
  const rows = [...doc.querySelectorAll(".thought-static")];
  assert.deepEqual(rows.map((row) => squash(accessibleName(row))),
    ["Thought, hidden by Anthropic", "Thought for 1s, hidden by Anthropic"]);
  const slot = rows[0].firstElementChild;
  assert.ok(slot.classList.contains("thought-chev"));
  assert.equal(slot.getAttribute("aria-hidden"), "true");
  assert.equal(slot.textContent, "");
  assert.match(mainCss, /\.thought-static \.thought-chev[^{]*\{[^}]*width: 1\.1em/);
});

test("an inline summary becomes a muted note in place: whole group, and partial with focus moved", () => {
  const { send, doc, dom } = makeDom();
  send(start());
  send(delta("t1:think1", "summarized", "The first run fails on the boundary.", { provider: "anthropic" }));
  send(end("t1:think1", "summarized", { provider: "anthropic", placement: "inline", seconds: 2.1 }));
  assert.equal(doc.querySelectorAll(".disclosure").length, 0, "the emptied group is replaced");
  const note = doc.querySelector(".thought-note");
  assert.equal(note.querySelector("p").textContent, "The first run fails on the boundary.");
  const hint = note.querySelector(".thought-hint");
  assert.equal(hint.textContent, " · summarized by Anthropic");
  assert.equal(hint.querySelector(".sr-only").textContent, " by Anthropic");
  assert.equal(note.lastElementChild, hint);

  // Partial: [short (inline), long (collapsed)] in one group; the short one leaves in place and focus
  // follows it when the header had focus.
  send(ev({ type: "stream_end", phase: "commentary" }));
  send(ev({ type: "tool_call", call_id: "c1", name: "bash", args: { command: "npm test" }, summary: "npm test" }));
  send(delta("t1:think2", "summarized", "Check the test first.", { provider: "openai" }));
  send(delta("t1:think3", "summarized", "x".repeat(400), { provider: "openai" }));
  send(end("t1:think3", "summarized", { provider: "openai", seconds: 2.5 }));
  const header = [...doc.querySelectorAll(".disclosure")].at(-1);
  header.focus();
  assert.equal(doc.activeElement, header);
  send(end("t1:think2", "summarized", { provider: "openai", placement: "inline", seconds: 1.5 }));
  const notes = [...doc.querySelectorAll(".thought-note")];
  assert.equal(notes.length, 2);
  const moved = notes[1];
  assert.equal(doc.activeElement, moved, "focus moves to the note");
  assert.equal(moved.getAttribute("tabindex"), "-1");
  assert.equal(moved.nextElementSibling, header, "the note keeps the block's own position, before the rest");
  assert.equal(header.nextElementSibling.textContent, "x".repeat(400), "the remaining part loses its separator");
  assert.equal(squash(accessibleName(header)), "Thought for 3s, summarized by OpenAI");
  assert.ok(dom);
});

test("narration streams inline from its first delta, but a sub-agent or inline off streams collapsed", () => {
  const { send, doc } = makeDom();
  send(start());
  send(delta("t1:think1", "narration", "Checked the tests; ", { provider: "anthropic" }));
  const note = doc.querySelector(".thought-note");
  assert.ok(note, "a progress note is visible immediately");
  assert.equal(doc.querySelectorAll(".disclosure").length, 0);
  send(delta("t1:think1", "narration", "now editing.", { provider: "anthropic" }));
  send(end("t1:think1", "narration", { provider: "anthropic", placement: "inline", seconds: 1 }));
  assert.equal(doc.querySelector(".thought-note p").textContent, "Checked the tests; now editing.");

  send(delta("t1:think2", "narration", "Child note.", { provider: "anthropic", agent: "sub-0123456789ab" }));
  assert.equal(doc.querySelectorAll(".disclosure").length, 1, "a sub-agent's note is collapsed");
  send(end("t1:think2", "narration", { provider: "anthropic", agent: "sub-0123456789ab", seconds: 1 }));

  const off = makeDom();
  off.send(ev({ type: "config", model: "m", mode: "default", think: "off", base_url: "http://h", show_reasoning: true,
    thinking_inline: false }));
  off.send(start());
  off.send(delta("t1:think1", "narration", "Hidden behind a header.", { provider: "anthropic" }));
  assert.equal(off.doc.querySelectorAll(".thought-note").length, 0);
  assert.equal(off.doc.querySelectorAll(".disclosure").length, 1);

  // Over the cap the backend says collapsed: the streaming note turns into a group.
  send(delta("t1:think3", "narration", "Long.", { provider: "anthropic" }));
  send(end("t1:think3", "narration", { provider: "anthropic", seconds: 4 }));
  const last = [...doc.querySelectorAll(".disclosure")].at(-1);
  assert.equal(squash(accessibleName(last)), "Thought for 4s, summarized by Anthropic");
  assert.equal(last.nextElementSibling.textContent, "Long.");
});

test("a withheld block is a static row, merged with a directly preceding one, placed before the text", () => {
  const { send, doc } = makeDom();
  send(start());
  send(end("t1:think1", "withheld", { provider: "anthropic", seconds: 6.0 }));
  send(end("t1:think2", "withheld", { provider: "anthropic", seconds: 2.0 }));
  send(ev({ type: "text_delta", text: "Here is the plan." }));
  const rows = doc.querySelectorAll(".thought-static");
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].tagName, "BUTTON");
  assert.equal(rows[0].querySelector("button"), null);
  assert.equal(squash(rows[0].textContent), "Thought for 8s · , hidden by Anthropic");
  assert.equal(rows[0].nextElementSibling, doc.querySelector(".text"), "the row precedes the prose");
  send(ev({ type: "stream_end", phase: "answer" }));
  send(end("t1:think3", "withheld", { provider: "openai" }));
  assert.equal(doc.querySelectorAll(".thought-static").length, 2, "prose between rows keeps them apart");
});

test("tool order: a note or a collapsed group between two tool calls opens a new tool group (D7)", () => {
  const { send, doc } = makeDom();
  send(start());
  send(ev({ type: "tool_call", call_id: "a", name: "bash", args: { command: "ls" }, summary: "ls" }));
  send(ev({ type: "tool_result", call_id: "a", name: "bash", output: "ok" }));
  send(delta("t1:think1", "summarized", "Now the tests.", { provider: "anthropic" }));
  send(end("t1:think1", "summarized", { provider: "anthropic", placement: "inline", seconds: 1 }));
  send(ev({ type: "tool_call", call_id: "b", name: "bash", args: { command: "npm test" }, summary: "npm test" }));
  let groups = [...doc.querySelectorAll(".tool-group")];
  assert.equal(groups.length, 2);
  const note = doc.querySelector(".thought-note");
  assert.equal(groups[0].nextElementSibling, note);
  assert.equal(note.nextElementSibling, groups[1]);
  assert.equal(groups[1].querySelector(".tool").dataset.callId, "b");

  send(ev({ type: "tool_result", call_id: "b", name: "bash", output: "ok" }));
  send(delta("t1:think2", "raw", "Thinking between tools."));
  send(end("t1:think2", "raw", { seconds: 1 }));
  send(ev({ type: "tool_call", call_id: "c", name: "bash", args: { command: "git status" }, summary: "git status" }));
  groups = [...doc.querySelectorAll(".tool-group")];
  assert.equal(groups.length, 3, "a collapsed reasoning group splits the tool group too");
  assert.equal(groups[2].previousElementSibling.classList.contains("reasoning"), true);
});

test("hide-reasoning hides groups, bodies, notes and static rows", () => {
  for (const selector of [".disclosure", ".reasoning", ".thought-note", ".thought-static"]) {
    const escaped = selector.replace(".", "\\.");
    assert.match(mainCss, new RegExp(`body\\.hide-reasoning [^{]*${escaped}[^{]*\\{[^}]*display: none !important`),
      selector);
  }
  const { send, doc } = makeDom();
  send(ev({ type: "config", model: "m", mode: "default", think: "off", base_url: "http://h", show_reasoning: false }));
  assert.ok(doc.body.classList.contains("hide-reasoning"));
});

test("block ids are Map keys: quotes, brackets and backslashes neither throw nor cross-match", () => {
  const { send, doc, errors } = makeDom();
  send(start());
  const weird = ['t1:"]', 't1:\\', "t1:\"] .x", "t1:think1"];
  weird.forEach((id, index) => send(delta(id, index % 2 ? "raw" : "unknown", `text ${index}`)));
  send(end('t1:"]', "unknown", { seconds: 1 }));
  send(end("t1:\\", "raw", { seconds: 2 }));
  send(end("t1:\"] .x", "unknown", { seconds: 3 }));
  send(end("t1:think1", "raw", { seconds: 4 }));
  const bodies = [...doc.querySelectorAll(".reasoning")].map((b) => b.textContent);
  assert.deepEqual(bodies, ["text 0", "text 1", "text 2", "text 3"]);
  assert.deepEqual([...doc.querySelectorAll(".disclosure")].map((h) => squash(accessibleName(h))),
    ["Thought for 1s", "Thought for 2s, raw", "Thought for 3s", "Thought for 4s, raw"]);
  assert.deepEqual(errors, []);
});

test("live and replayed reasoning render the same DOM", () => {
  const live = [
    { type: "turn_start", turn_id: "t1", prompt: "Fix the gate", kind: "prompt" },
    { type: "thinking_end", block: "t1:think1", source: "withheld", provider: "anthropic", placement: "collapsed", seconds: 6 },
    { type: "thinking_delta", block: "t1:think2", source: "summarized", provider: "openai", text: "Check the failing test." },
    { type: "thinking_delta", block: "t1:think3", source: "summarized", provider: "openai", text: "y".repeat(320) },
    { type: "thinking_end", block: "t1:think3", source: "summarized", provider: "openai", placement: "collapsed", seconds: 2.5 },
    { type: "thinking_end", block: "t1:think2", source: "summarized", provider: "openai", placement: "inline", seconds: 1.5 },
    { type: "stream_end", phase: "commentary" },
    { type: "tool_call", call_id: "c1", name: "bash", args: { command: "npm test" }, summary: "npm test" },
    { type: "tool_result", call_id: "c1", name: "bash", output: "1 failing", is_error: true },
    { type: "thinking_delta", block: "t1:think4", source: "raw", text: "The comparison is off by one." },
    { type: "thinking_end", block: "t1:think4", source: "raw", placement: "collapsed", seconds: 14.2 },
    { type: "text_delta", text: "Fixed the comparison." },
    { type: "stream_end", message_id: "t1:1", phase: "answer" },
    { type: "turn_end", turn_id: "t1", reason: "completed", token_estimate: 10, final_message_id: "t1:1" },
  ];
  // What _history hands back: per-block order, every end right after its deltas, h-prefixed ids.
  const replay = [
    { type: "turn_start", turn_id: "h1", prompt: "Fix the gate", kind: "prompt" },
    { type: "thinking_end", block: "h1:think1", source: "withheld", provider: "anthropic", placement: "collapsed", seconds: 6 },
    { type: "thinking_delta", block: "h1:think2", source: "summarized", provider: "openai", text: "Check the failing test." },
    { type: "thinking_end", block: "h1:think2", source: "summarized", provider: "openai", placement: "inline", seconds: 1.5 },
    { type: "thinking_delta", block: "h1:think3", source: "summarized", provider: "openai", text: "y".repeat(320) },
    { type: "thinking_end", block: "h1:think3", source: "summarized", provider: "openai", placement: "collapsed", seconds: 2.5 },
    { type: "tool_call", call_id: "c1", name: "bash", args: { command: "npm test" }, summary: "npm test" },
    { type: "tool_result", call_id: "c1", name: "bash", output: "1 failing", is_error: true },
    { type: "thinking_delta", block: "h1:think4", source: "raw", text: "The comparison is off by one." },
    { type: "thinking_end", block: "h1:think4", source: "raw", placement: "collapsed", seconds: 14.2 },
    { type: "text_delta", text: "Fixed the comparison." },
    { type: "stream_end", message_id: "h1:1", phase: "answer" },
    { type: "turn_end", turn_id: "h1", reason: "completed", token_estimate: 0, final_message_id: "h1:1" },
  ];
  const a = makeDom();
  for (const event of live) a.send(ev(event));
  const b = makeDom();
  b.send(ev({ type: "history", items: replay }));
  const normalise = (html) => html
    .replace(/tool-output-\d+/g, "tool-output-N").replace(/reasoning-\d+/g, "reasoning-N")
    .replace(/\b[a-z]\d+:(\d+)\b/g, "m:$1").replace(/Worked for \d+s/g, "Worked")
    .replace(/ hist\b/g, "").replace(/\s+/g, " ").trim();
  const pages = b.doc.querySelector(".history-pages").cloneNode(true);
  pages.querySelector(".history-older")?.remove();
  const livePart = normalise(a.doc.getElementById("log").innerHTML);
  assert.ok(livePart.includes("thought-note") && livePart.includes("thought-static"));
  assert.equal(normalise(pages.innerHTML), livePart);
  assert.deepEqual(a.errors, []);
  assert.deepEqual(b.errors, []);
});

test("20,000 one-token deltas into one block stay linear", () => {
  const { send, doc } = makeDom();
  send(start());
  const began = performance.now();
  for (let index = 0; index < 20000; index += 1) send(delta("t1:think1", "raw", "a"));
  const took = performance.now() - began;
  assert.equal(doc.querySelector(".reasoning").textContent.length, 20000);
  assert.ok(took < 1000, `took ${Math.round(took)}ms`);
});

test("the Show model thinking select carries show_reasoning and thinking_inline together", () => {
  const { send, doc, posted } = makeDom();
  const select = doc.getElementById("s-show_reasoning");
  assert.deepEqual([...select.options].map((option) => [option.value, option.textContent]), [
    ["inline", "inline"], ["collapsed", "collapsed"], ["hidden", "hidden"]]);
  assert.match(select.closest("label").textContent,
    /Short provider summaries show inline; raw thinking stays collapsed\. Labels say where thinking came from: raw from the model, or summarized by the provider\./);
  send({ type: "settings_open", providers: [], models: [] });
  const config = { type: "config", base_url: "http://h", model: "m", mode: "default", think: "off" };
  for (const [values, expected] of [[{ show_reasoning: true }, "inline"],
    [{ show_reasoning: true, thinking_inline: false }, "collapsed"],
    [{ show_reasoning: false, thinking_inline: false }, "hidden"]]) {
    send(ev({ ...config, ...values }));
    assert.equal(select.value, expected, JSON.stringify(values));
  }
  for (const [choice, show, inline] of [["inline", true, true], ["collapsed", true, false], ["hidden", false, false]]) {
    select.value = choice;
    doc.getElementById("set-save").click();
    const saved = posted.filter((m) => m.type === "saveSettings").pop();
    assert.equal(saved.values.show_reasoning, show, choice);
    assert.equal(saved.values.thinking_inline, inline, choice);
    send({ type: "settings_open", providers: [], models: [] });
  }
});
