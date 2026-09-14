// The 0.40 foundation seams in the webview: marked lane sections in main.js and main.css, the hook
// dispatchers the shared handlers call, the tool card DOM contract, and the docked-question rules in
// the activity row and composer. Each lane replaces its own stubs; these tests pin where they run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mainCss, mainJs, makeDom } from "./support/webview-dom.mjs";

const LANES = ["agents", "images", "reconnecting", "options", "thinking"];
const STUBS = {
  agentsOnSessionReset: "kind", agentsOnBackendExit: "msg", agentsOnToolCard: "card, ev", hideAgentsMenu: "event",
  imagesOnSessionReset: "kind", imagesOnBackendExit: "msg", imagesOnReady: "ev", imageViewerAttention: "kind",
  retryOnSessionReset: "kind", retryOnBackendExit: "msg", retryOnReady: "ev", settleRetryLines: "t, reason",
  askOnSessionReset: "kind", askOnBackendExit: "msg", undockAskCard: "reason",
};

// main.js with every stub recording its call into window.__hooks, askCardDocked() driven by
// window.__docked, and endToolGroup reachable from the test.
function instrumented() {
  let script = mainJs;
  for (const [name, params] of Object.entries(STUBS)) {
    // A stub or the lane's implementation of it: the recording goes first in the body either way.
    const stub = `function ${name}(${params}) {`;
    assert.equal(script.split(stub).length, 2, `exactly one hook ${stub}`);
    const first = params.split(",")[0].trim();
    const detail = name === "agentsOnToolCard" ? "{ inGroup: !!card.closest('.tool-group'), callId: card.dataset.callId, name: ev.name }"
      : name === "settleRetryLines" ? "{ turn: !!t, reason }"
        : name === "hideAgentsMenu" ? "event ? event.type : null"
          : name.endsWith("OnBackendExit") ? "msg.code" : name.endsWith("OnReady") ? "ev.type" : first;
    script = script.replace(stub, `function ${name}(${params}) { (window.__hooks ||= []).push([${JSON.stringify(name)}, ${detail}]);`);
  }
  const docked = "function askCardDocked() { return false; }";
  assert.equal(script.split(docked).length, 2);
  script = script.replace(docked, "function askCardDocked() { return window.__docked === true; }");
  const shared = "function endToolGroup() { if (turn) turn.toolGroup = null; }";
  assert.equal(script.split(shared).length, 2);
  return script.replace(shared, `${shared}\n  window.__endToolGroup = endToolGroup;`);
}

function dom() {
  const view = makeDom({ script: instrumented() });
  // Plain copies: arrays built inside the jsdom realm are not deepStrictEqual to this realm's.
  const hooks = () => JSON.parse(JSON.stringify(view.dom.window.__hooks || []));
  const clear = () => { view.dom.window.__hooks = []; };
  const event = (data) => view.send({ type: "event", event: data });
  return { ...view, hooks, clear, event };
}

test("main.js and main.css carry one marked section per lane, in order, at the end", () => {
  for (const [source, open, close] of [
    [mainJs, (lane) => `// ---- 0.40 ${lane} -`, (lane) => `// ---- end 0.40 ${lane} -`],
    [mainCss, (lane) => `/* ---- 0.40 ${lane} -`, (lane) => `/* ---- end 0.40 ${lane} -`],
  ]) {
    let at = -1;
    for (const lane of LANES) {
      assert.equal(source.split(open(lane)).length, 2, `one ${lane} section`);
      const start = source.indexOf(open(lane)), end = source.indexOf(close(lane));
      assert.ok(start > at && end > start, `${lane} follows the previous section`);
      at = end;
    }
  }
  const agents = mainJs.indexOf("// ---- 0.40 agents -");
  assert.ok(mainJs.lastIndexOf("window.addEventListener(\"message\"") < agents, "sections sit after the message listener");
  assert.ok(mainJs.indexOf("loadDraftState();", agents) > mainJs.indexOf("// ---- end 0.40 thinking -"),
    "and before loadDraftState");
  assert.match(mainCss.slice(mainCss.indexOf("/* ---- 0.40 agents -")), /^\/\* ---- 0\.40 agents[\s\S]*end 0\.40 thinking -+ \*\/\n$/,
    "nothing follows the thinking section");
});

test("REPLAYABLE is the backend's replayable fragment list", () => {
  const list = mainJs.match(/const REPLAYABLE = new Set\(\[([\s\S]*?)\]\);/)[1].split(",").map((part) => part.trim().replace(/"/g, ""));
  assert.deepEqual(list, ["turn_start", "text_delta", "thinking_delta", "thinking_end", "stream_end", "tool_call",
    "tool_result", "tool_denied", "tool_images", "options_resolved", "model_retry", "monitor_event", "turn_end"]);
});

test("a tool card follows the DOM contract and is offered to the agents lane once it is in its group", () => {
  const { doc, event, hooks, errors } = dom();
  event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  event({ type: "tool_call", call_id: "sub-0123456789ab:call_0", name: "task", args: { description: "d" }, summary: "d" });
  event({ type: "tool_call", call_id: null, name: "bash", args: { command: "ls" }, summary: "ls" });
  const cards = [...doc.querySelectorAll(".tool-group > .tool[data-tool-name][data-call-id]")];
  assert.deepEqual(cards.map((card) => [card.dataset.toolName, card.dataset.callId]),
    [["task", "sub-0123456789ab:call_0"], ["bash", ""]]);
  for (const card of cards) {
    const toggle = card.querySelector(":scope > .head > button.tool-toggle");
    assert.ok(toggle, "head > button.tool-toggle");
    assert.deepEqual([...toggle.children].slice(0, 4).map((node) => node.className), ["chev", "glyph", "verb", "arg"]);
    assert.ok(card.querySelector(":scope > .body > pre"), "body > pre");
  }
  assert.deepEqual(hooks().filter(([name]) => name === "agentsOnToolCard").map(([, detail]) => detail), [
    { inGroup: true, callId: "sub-0123456789ab:call_0", name: "task" },
    { inGroup: true, callId: "", name: "bash" },
  ]);
  assert.deepEqual(errors, []);
});

test("a chat reset reaches every lane in order; a fork or a failed rewind does not", () => {
  const { event, hooks, clear, errors } = dom();
  const resets = () => hooks().filter(([name]) => name.endsWith("OnSessionReset"));
  for (const kind of ["new", "cleared", "resumed"]) {
    clear();
    event({ type: "session", kind, message_count: 0, session_id: "s" });
    assert.deepEqual(resets(), [["agentsOnSessionReset", kind], ["imagesOnSessionReset", kind],
      ["retryOnSessionReset", kind], ["askOnSessionReset", kind]]);
  }
  clear();
  event({ type: "session", kind: "forked", message_count: 3, session_id: "s2" });
  event({ type: "rewound", ok: false, files_restored: 0 });
  assert.deepEqual(resets(), []);
  event({ type: "rewound", ok: true, files_restored: 1 });
  assert.deepEqual(resets().map(([, kind]) => kind), ["rewound", "rewound", "rewound", "rewound"]);
  assert.deepEqual(errors, []);
});

test("ready, backend_exit and request cards reach their hooks", () => {
  const { doc, send, event, hooks, clear, errors } = dom();
  event({ type: "ready", version: "x", protocol_version: 14, capabilities: {}, model: "m", mode: "default",
    think: "off", base_url: "http://127.0.0.1:1/v1", workspace_trusted: true, commands: [], custom_commands: [],
    goal: { text: "", status: "none" }, context_size: 1 });
  assert.deepEqual(hooks().filter(([name]) => name.endsWith("OnReady")), [["imagesOnReady", "ready"], ["retryOnReady", "ready"]]);

  clear();
  event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  event({ type: "permission_request", id: "p1", call_id: "c1", name: "bash", args: { command: "ls" }, command: "ls",
    suggested_rule: "Bash(ls)", choices: ["once", "always", "deny"] });
  event({ type: "plan_proposal", id: "p2", plan: "1. x", choices: ["auto", "acceptEdits", "default", "reject"] });
  event({ type: "options_request", id: "p3", question: "Pick", options: ["A", "B"] });
  event({ type: "mcp_input_request", id: "p4", server: "srv", kind: "sampling_request", payload: {} });
  send({ type: "continue_offer", cause: "", sessionId: "someone-else" });
  send({ type: "continue_offer", cause: "" });
  send({ type: "goal_resume_held", cause: "", exits: 3 });
  assert.deepEqual(hooks().filter(([name]) => name === "imageViewerAttention").map(([, kind]) => kind),
    ["permission_request", "plan_proposal", "options_request", "mcp_input_request", "continue_offer", "goal_resume_held"]);

  clear();
  send({ type: "backend_exit", code: 3, recovering: false, resumes: "none" });
  assert.deepEqual(hooks().slice(0, 4), [["agentsOnBackendExit", 3], ["imagesOnBackendExit", 3],
    ["retryOnBackendExit", 3], ["askOnBackendExit", 3]], "the exit hooks run first, before the turn ends");
  assert.deepEqual(hooks().slice(4).filter(([name]) => name === "settleRetryLines"), [["settleRetryLines", { turn: true, reason: "error" }]]);
  assert.ok(doc.querySelector(".sys"), "the exit line still renders");
  assert.deepEqual(errors, []);
});

test("ending a live turn settles retry lines and undocks a question; a replayed turn never undocks", () => {
  const { event, hooks, clear, errors } = dom();
  event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  event({ type: "turn_end", turn_id: "t1", reason: "cancelled", token_estimate: 0 });
  assert.deepEqual(hooks().filter(([name]) => ["settleRetryLines", "undockAskCard"].includes(name)),
    [["settleRetryLines", { turn: true, reason: "cancelled" }], ["undockAskCard", "turn_end"]]);
  clear();
  event({ type: "history", items: [
    { type: "turn_start", turn_id: "h1", prompt: "earlier", kind: "prompt" },
    { type: "text_delta", text: "answer" }, { type: "stream_end", message_id: "h1:1", phase: "answer" },
    { type: "turn_end", turn_id: "h1", reason: "completed", token_estimate: 0, final_message_id: "h1:1" },
    { type: "turn_start", turn_id: "h2", prompt: "cut off", kind: "prompt" },
  ] });
  const settled = hooks().filter(([name]) => name === "settleRetryLines");
  assert.equal(settled.length, 2, "both replayed turns settle, including the one a page ended mid-turn");
  assert.deepEqual(hooks().filter(([name]) => name === "undockAskCard"), []);
  assert.deepEqual(errors, []);
});

test("every other menu closes the agents menu, and so does a click anywhere", () => {
  const { doc, dom: view, hooks, clear, errors } = dom();
  const closes = () => hooks().filter(([name]) => name === "hideAgentsMenu").map(([, detail]) => detail);
  for (const id of ["btn-mode", "btn-model", "btn-ctx", "btn-add"]) {
    clear();
    doc.getElementById(id).click();
    assert.ok(closes().includes(null), `${id} hides the agents menu with its siblings`);
  }
  clear();
  doc.getElementById("log").dispatchEvent(new view.window.MouseEvent("click", { bubbles: true }));
  assert.deepEqual(closes(), ["click"], "an outside click hands the event over");
  assert.deepEqual(errors, []);
});

test("a docked question makes the turn wait on the user and turns Send into Stop", () => {
  const { doc, dom: view, event, posted, errors } = dom();
  event({ type: "ready", version: "x", protocol_version: 14, capabilities: { live_steering: true }, model: "m",
    mode: "default", think: "off", base_url: "http://127.0.0.1:1/v1", workspace_trusted: true, commands: [],
    custom_commands: [], goal: { text: "", status: "none" }, context_size: 1 });
  event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  const input = doc.getElementById("input"), sendButton = doc.getElementById("send");
  input.value = "a follow-up I was typing";
  input.dispatchEvent(new view.window.Event("input", { bubbles: true }));
  assert.equal(sendButton.getAttribute("aria-label"), "Steer current run");
  assert.equal(doc.getElementById("queue-send").hidden, false);
  assert.equal(doc.getElementById("followup-hint").hidden, false);

  view.window.__docked = true;
  event({ type: "turn_activity", turn_id: "t1", state: "tool", label: "Asking" });
  assert.equal(doc.querySelector(".thinking .verb, .act .verb")?.textContent, "waiting for your input");
  input.dispatchEvent(new view.window.Event("input", { bubbles: true }));
  assert.equal(sendButton.getAttribute("aria-label"), "Stop generation");
  assert.equal(doc.getElementById("queue-send").hidden, true);
  assert.equal(doc.getElementById("followup-hint").hidden, true);
  assert.equal(doc.getElementById("stop-run").hidden, true, "one Stop, on the Send button");
  assert.equal(doc.getElementById("cfooter").hidden, false);
  const before = posted.length;
  sendButton.click();
  assert.deepEqual(posted.slice(before).map((message) => message.type), ["cancel"]);
  assert.equal(input.value, "a follow-up I was typing", "the draft is kept, never sent");
  assert.deepEqual(errors, []);
});

test("endToolGroup makes the next tool card open a new group", () => {
  const { doc, dom: view, event, errors } = dom();
  event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  event({ type: "tool_call", call_id: "c1", name: "bash", args: { command: "ls" }, summary: "ls" });
  event({ type: "tool_call", call_id: "c2", name: "bash", args: { command: "pwd" }, summary: "pwd" });
  assert.equal(doc.querySelectorAll(".tool-group").length, 1);
  view.window.__endToolGroup();
  event({ type: "tool_call", call_id: "c3", name: "bash", args: { command: "id" }, summary: "id" });
  assert.deepEqual([...doc.querySelectorAll(".tool-group")].map((group) => group.querySelectorAll(".tool").length), [2, 1]);
  assert.deepEqual(errors, []);
});
