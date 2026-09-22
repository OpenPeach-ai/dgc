// Two chats, each with its own `dgc serve`.
//
// The panel keeps ONE set of per-chat fields and swaps them wholesale, so the invariant worth
// testing is that nothing leaks across a switch: not transcript events, not the session id, not
// the running-turn flags. These tests drive the real panel bundle with fake backends, because the
// interesting failures are all in the bookkeeping rather than in the pipe.
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "dgc-vscode-chat-slots-"));
const bundle = join(scratch, "panel.cjs");

const notices = { info: [], warnings: [], errors: [], quickPick: [] };
/** `dgc.maxLiveChats`; 0 is the shipped default and means no limit. */
const configuredMaxChats = { value: 0 };
let quickPickAnswer;
const statusBar = { text: "", tooltip: "", command: "", show() {}, hide() {}, dispose() {} };
globalThis.__DGC_TEST_VSCODE = {
  Uri: { joinPath: (...parts) => ({ toString: () => parts.join("/"), fsPath: parts.join("/") }) },
  env: {},
  commands: { executeCommand: async () => undefined },
  languages: { getDiagnostics: () => [] },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  StatusBarAlignment: { Left: 1 },
  ConfigurationTarget: { WorkspaceFolder: 1, Workspace: 2, Global: 3 },
  window: {
    activeTextEditor: undefined,
    tabGroups: { all: [] },
    createStatusBarItem: () => statusBar,
    createOutputChannel: () => ({ appendLine() {}, append() {}, show() {}, dispose() {} }),
    showWarningMessage: async (message) => { notices.warnings.push(String(message)); },
    showErrorMessage: async (message) => { notices.errors.push(String(message)); },
    showInformationMessage: async (message) => { notices.info.push(String(message)); },
    showQuickPick: async (items) => { notices.quickPick.push(items); return quickPickAnswer; },
  },
  workspace: {
    isTrusted: true,
    workspaceFile: undefined,
    workspaceFolders: [{ uri: { fsPath: scratch, toString: () => `file://${scratch}` } }],
    getConfiguration: () => ({
      get: (key, fallback) => (key === "maxLiveChats" ? configuredMaxChats.value : fallback),
      inspect: () => undefined,
      async update() {},
    }),
  },
};

await build({
  entryPoints: [join(here, "../src/panel.ts")],
  bundle: true, format: "cjs", platform: "node", target: "node18",
  outfile: bundle, logLevel: "silent",
  plugins: [{
    name: "test-vscode",
    setup(builder) {
      builder.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "test" }));
      builder.onLoad({ filter: /^vscode$/, namespace: "test" }, () => ({
        contents: "module.exports = globalThis.__DGC_TEST_VSCODE;", loader: "js",
      }));
    },
  }],
});

const { DgcViewProvider } = createRequire(import.meta.url)(bundle);
after(() => { delete globalThis.__DGC_TEST_VSCODE; rmSync(scratch, { recursive: true, force: true }); });
beforeEach(() => {
  notices.info.length = 0; notices.quickPick.length = 0; quickPickAnswer = undefined;
  configuredMaxChats.value = 0;                    // shipped default: unlimited
});

/** A backend that records what it was sent and never spawns anything. */
function fakeBackend(name) {
  return {
    name, ready: true, sent: [], disposed: "",
    send(command) { this.sent.push(command); return true; },
    sendSetup(command) { this.sent.push(command); return true; },
    request(command) { this.sent.push(command); return Promise.resolve({ type: "ok" }); },
    completeHandshake() {}, start() {},
    dispose(cause) { this.disposed = cause || "disposed"; },
  };
}

function harness() {
  const posted = [];
  const spawned = [];
  // What the workspace remembers as "the chat this window was on".
  const remembered = { id: "", scope: "" };
  const provider = new DgcViewProvider({
    extension: { packageJSON: { version: "0.27.0", dgcCliVersion: "0.42.0" } },
    secrets: { async get() {}, async store() {}, async delete() {} },
    subscriptions: [],
    globalState: { get() {}, async update() {} },
    // The window's memory of "the chat this window was on" — the key the real ready handler and
    // ensureBackend both read. An empty stub made these tests pass against the broken code.
    workspaceState: {
      get(key) {
        if (key !== "dgc.activeSession.v1" || !remembered.id) return undefined;
        return { scope: remembered.scope, id: remembered.id, saved: true };
      },
      async update(key, value) {
        if (key === "dgc.activeSession.v1" && value) {
          remembered.id = value.id; remembered.scope = value.scope;
        }
      },
    },
  });
  provider.post = (message) => { posted.push(message); };
  provider.webviewReady = true;
  // Every chat this harness opens gets a fake child instead of a real `dgc serve`.
  const realEnsure = provider.ensureBackend.bind(provider);
  void realEnsure;
  provider.ensureBackend = function () {
    if (this.backend) { this.activeSlot().backend = this.backend; return this.backend; }
    if (!this.sessionRestoreSuppressed) {
      const saved = this.context.workspaceState.get("dgc.activeSession.v1");
      this.sessionRestoreCandidate =
        saved && saved.scope === this.draftScope() ? String(saved.id || "") : "";
    }
    const be = fakeBackend(`serve-${spawned.length + 1}`);
    spawned.push(be);
    this.backend = be;
    this.activeSlot().backend = be;
    return be;
  };
  provider.scheduleWorkspaceChanges = () => {};
  provider.postState = () => {};
  provider.backendNote = () => {};
  provider.surfaceUnsentPrompts = () => {};
  return { provider, posted, spawned, remembered };
}

/** Put a chat into the state a live, named, ready session would be in. */
function makeLive(provider, { sessionId, name, ready = true }) {
  provider.ensureBackend();
  provider.currentSessionId = sessionId;
  provider.currentSessionName = name;
  provider.currentSessionSaved = true;
  provider.sessionReady = ready;
  provider.lastReadyEvent = { type: "ready", capabilities: { history_snapshot: true, monitors: true, agents: true } };
}

const slotsPost = (posted) => posted.filter((m) => m.type === "chat_slots").at(-1);
/** Let the rail's coalescing timer fire (CHAT_SLOTS_COALESCE_MS in panel.ts). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

test("a second chat gets its own backend and both keep running", () => {
  const { provider, spawned } = harness();
  makeLive(provider, { sessionId: "alpha", name: "First" });
  provider.openChatSlot();
  makeLive(provider, { sessionId: "beta", name: "Second" });

  assert.equal(spawned.length, 2, "each chat spawns its own dgc serve");
  assert.notEqual(spawned[0], spawned[1]);
  assert.equal(spawned[0].disposed, "", "opening a second chat must not stop the first");
  assert.equal(provider.slots.length, 2);
});

test("a new chat starts from the field initializers, not from the chat it was opened beside", () => {
  const { provider } = harness();
  makeLive(provider, { sessionId: "alpha", name: "First" });
  provider.turnActive = provider.confirmedTurnActive = true;
  provider.unstartedPrompts.set("r1", { requestId: "r1", text: "hello", queued: true });
  provider.mcpUrls.set("u1", {});

  provider.openChatSlot();

  assert.equal(provider.currentSessionId, "", "the new chat has no session id yet");
  assert.equal(provider.currentSessionName, "");
  assert.equal(provider.confirmedTurnActive, false, "the other chat's running turn is not this one's");
  assert.equal(provider.unstartedPrompts.size, 0, "queued prompts belong to the chat they were typed in");
  assert.equal(provider.mcpUrls.size, 0);
  // …and the chat it was opened beside kept all of it.
  const parked = provider.slots[0].saved;
  assert.equal(parked.currentSessionId, "alpha");
  assert.equal(parked.confirmedTurnActive, true);
  assert.equal(parked.unstartedPrompts.size, 1);
});

test("switching back restores the first chat's state exactly and repaints from its own backend", () => {
  const { provider, posted, spawned } = harness();
  makeLive(provider, { sessionId: "alpha", name: "First" });
  const first = provider.slots[0].id;
  provider.openChatSlot();
  makeLive(provider, { sessionId: "beta", name: "Second" });

  posted.length = 0;
  spawned[0].sent.length = 0;
  provider.switchToSlot(first);

  assert.equal(provider.currentSessionId, "alpha");
  assert.equal(provider.currentSessionName, "First");
  assert.equal(provider.backend, spawned[0], "the panel now drives the first chat's backend");
  const cleared = posted.find((m) => m.type === "chat_switched");
  assert.ok(cleared, "the webview is told to drop the transcript it is showing");
  assert.equal(cleared.slotId, first);
  const asked = spawned[0].sent.map((c) => c.type);
  assert.ok(asked.includes("get_history"), `the incoming backend is asked for its own history: ${asked}`);
  assert.equal(spawned[1].disposed, "", "the chat we left keeps running");
});

test("a background chat's stream never reaches the transcript, only its chip", async () => {
  const { provider, posted } = harness();
  makeLive(provider, { sessionId: "alpha", name: "First" });
  provider.openChatSlot();
  makeLive(provider, { sessionId: "beta", name: "Second" });
  const background = provider.slots[0];

  posted.length = 0;
  provider.routeEvent(background, { type: "turn_start", turn_id: "t1" });
  provider.routeEvent(background, { type: "text_delta", text: "secret from the other chat" });
  provider.routeEvent(background, { type: "text_delta", text: " and more" });

  const painted = posted.filter((m) => m.type === "event");
  assert.deepEqual(painted, [], "a chat you are not looking at must not write into the one you are");
  await settle();                       // the unread count is coalesced, not posted per token
  const chips = slotsPost(posted);
  const chip = chips.items.find((item) => item.id === background.id);
  assert.equal(chip.busy, true, "its chip says it is working");
  assert.equal(chip.unread, 2);
  assert.equal(chip.active, false);
});

test("a streaming background chat does not rebuild the rail once per token", async () => {
  // The webview rebuilds every tab on each chat_slots message, and the CLI emits one text_delta
  // per stream chunk — so a 2,000-token answer in a chat you are not looking at meant 2,000 full
  // rail rebuilds, and dropped keyboard focus if it was on a tab.
  const { provider, posted } = harness();
  makeLive(provider, { sessionId: "alpha", name: "First" });
  provider.openChatSlot();
  makeLive(provider, { sessionId: "beta", name: "Second" });
  const background = provider.slots[0];

  posted.length = 0;
  for (let i = 0; i < 200; i++) {
    provider.routeEvent(background, { type: "text_delta", text: `chunk ${i}` });
  }
  const during = posted.filter((m) => m.type === "chat_slots").length;
  assert.equal(during, 0, "no rail post while the tokens are still arriving");
  await settle();
  const after = posted.filter((m) => m.type === "chat_slots").length;
  assert.equal(after, 1, "one post carries the whole burst");
  assert.equal(slotsPost(posted).items.find((i) => i.id === background.id).unread, 200,
    "and it carries the true count");
});

test("something the user must answer still reaches the rail at once", async () => {
  // Coalescing is for a count that ticks up. A chat stopping dead on a decision is not that.
  const { provider, posted } = harness();
  makeLive(provider, { sessionId: "alpha", name: "First" });
  provider.openChatSlot();
  makeLive(provider, { sessionId: "beta", name: "Second" });
  const background = provider.slots[0];

  posted.length = 0;
  provider.routeEvent(background, { type: "permission_request", request_id: "p1" });
  const chip = slotsPost(posted).items.find((item) => item.id === background.id);
  assert.equal(chip.needsYou, true, "posted immediately, not a frame later");
});

test("a background chat blocked on a decision is flagged, and cleared when it settles", () => {
  const { provider, posted } = harness();
  makeLive(provider, { sessionId: "alpha", name: "First" });
  provider.openChatSlot();
  makeLive(provider, { sessionId: "beta", name: "Second" });
  const background = provider.slots[0];

  provider.routeEvent(background, { type: "permission_request", id: "p1" });
  let chip = slotsPost(posted).items.find((item) => item.id === background.id);
  assert.equal(chip.needsYou, true);

  provider.routeEvent(background, { type: "permission_resolved", id: "p1", decision: "once" });
  chip = slotsPost(posted).items.find((item) => item.id === background.id);
  assert.equal(chip.needsYou, false);
});

test("the active chat's own events still paint normally", () => {
  const { provider, posted } = harness();
  makeLive(provider, { sessionId: "alpha", name: "First" });
  const active = provider.activeSlot();
  let seen = 0;
  provider.onEvent = () => { seen++; };
  provider.routeEvent(active, { type: "text_delta", text: "hi" });
  assert.equal(seen, 1, "the chat on screen takes the ordinary path");
});

test("a background backend that dies is armed to resume its session, not silently lost", () => {
  const { provider, posted } = harness();
  makeLive(provider, { sessionId: "alpha", name: "First" });
  const first = provider.slots[0];
  provider.openChatSlot();
  makeLive(provider, { sessionId: "beta", name: "Second" });

  provider.backgroundBackendLost(first, "killed by SIGKILL");

  assert.equal(first.lost, "killed by SIGKILL");
  assert.equal(first.saved.backend, undefined);
  assert.equal(first.saved.sessionReady, false);
  assert.equal(first.saved.sessionRestoreCandidate, "alpha",
    "switching back must resume the chat it was on, not open an empty one");
  const chip = slotsPost(posted).items.find((item) => item.id === first.id);
  assert.equal(chip.busy, false);
});

test("switching to a chat whose backend died starts a fresh one", () => {
  const { provider, spawned } = harness();
  makeLive(provider, { sessionId: "alpha", name: "First" });
  const first = provider.slots[0];
  provider.openChatSlot();
  makeLive(provider, { sessionId: "beta", name: "Second" });
  provider.backgroundBackendLost(first, "exited with code 1");

  provider.switchToSlot(first.id);

  assert.equal(spawned.length, 3, "a replacement child is started for the chat we came back to");
  assert.equal(provider.backend, spawned[2]);
  assert.equal(provider.sessionRestoreCandidate, "alpha");
  assert.equal(first.lost, undefined, "the chat is no longer marked lost once it is being restarted");
});

test("there is no built-in ceiling on how many chats you can run", () => {
  // DGC does not pick a number: a backend is ~9 MB and cross-chat writes are already serialised by
  // the workspace write lease, so the limit is the machine and the model budget, which is the
  // user's call. A ceiling only exists if they set one.
  const { provider, spawned } = harness();
  makeLive(provider, { sessionId: "s0", name: "First" });
  for (let i = 1; i < 6; i++) {
    provider.openChatSlot();
    makeLive(provider, { sessionId: `s${i}`, name: `Chat ${i}` });
  }
  assert.equal(provider.slots.length, 6, "six chats, none refused");
  assert.equal(spawned.length, 6, "each one got its own backend");
  assert.deepEqual(notices.info, [], "nothing was refused, so nothing was announced");
});

test("a ceiling the user sets is honoured", () => {
  const { provider, spawned } = harness();
  configuredMaxChats.value = 2;
  makeLive(provider, { sessionId: "alpha", name: "First" });
  provider.openChatSlot();
  makeLive(provider, { sessionId: "beta", name: "Second" });
  provider.openChatSlot();

  assert.equal(provider.slots.length, 2, "the user's own ceiling holds");
  assert.equal(spawned.length, 2);
  assert.match(notices.info.join(" "), /dgc\.maxLiveChats/,
    "and it points at the setting they chose, not an invented product limit");
});

test("closing the chat on screen moves to the other one and stops only the closed backend", () => {
  const { provider, spawned } = harness();
  makeLive(provider, { sessionId: "alpha", name: "First" });
  const first = provider.slots[0].id;
  provider.openChatSlot();
  makeLive(provider, { sessionId: "beta", name: "Second" });
  const second = provider.activeSlotId;

  provider.closeChatSlot(second);

  assert.equal(provider.slots.length, 1);
  assert.equal(provider.activeSlotId, first);
  assert.equal(provider.currentSessionId, "alpha", "the surviving chat is the one on screen");
  assert.ok(spawned[1].disposed, "the closed chat's backend is stopped");
  assert.equal(spawned[0].disposed, "", "the surviving chat's is not");
});

test("the last chat cannot be closed", () => {
  const { provider, spawned } = harness();
  makeLive(provider, { sessionId: "alpha", name: "First" });
  provider.closeChatSlot(provider.activeSlotId);
  assert.equal(provider.slots.length, 1);
  assert.equal(spawned[0].disposed, "");
});

test("disposing the panel stops every chat's backend, not just the visible one", () => {
  const { provider, spawned } = harness();
  makeLive(provider, { sessionId: "alpha", name: "First" });
  provider.openChatSlot();
  makeLive(provider, { sessionId: "beta", name: "Second" });

  provider.dispose();

  assert.ok(spawned[0].disposed, "the parked chat's child must not outlive the editor");
  assert.ok(spawned[1].disposed);
});

test("the chip rail carries every per-chat field, so none can be captured without being restored", () => {
  const { provider } = harness();
  makeLive(provider, { sessionId: "alpha", name: "First" });
  const before = provider.captureChatFields();
  provider.openChatSlot();
  const fresh = provider.captureChatFields();
  assert.deepEqual(Object.keys(before).sort(), Object.keys(fresh).sort(),
    "capture and restore move the same named set");
  // Every field the panel declares as per-chat really was reset for the new chat: a field that is
  // captured but never restored would still hold the first chat's value here.
  assert.equal(fresh.currentSessionId, "");
  assert.notEqual(fresh.backend, before.backend, "the new chat is driving its own child");
});

test("a second chat does not resume the first chat's session", async () => {
  // Found by recording the feature in real VS Code: the second chat opened, its rail tab appeared,
  // and its first turn died immediately on "this session has an active turn in another DGC
  // process". ensureBackend restores the workspace's remembered chat every time it starts a
  // backend — right for the first chat, wrong for a second, because a session is held by whichever
  // DGC is running a turn in it. Both chats pointed at the same one and the backend refused.
  const { provider, remembered } = harness();
  remembered.id = "alpha";                           // this window was last on chat "alpha"
  remembered.scope = provider.draftScope();
  makeLive(provider, { sessionId: "alpha", name: "First" });
  assert.equal(provider.sessionRestoreCandidate, "alpha", "the first chat does resume it");

  provider.openChatSlot();
  assert.equal(provider.sessionRestoreCandidate, "",
    "a deliberately-new chat must not be pointed at the session another chat is holding");

  // …and it must STAY empty through the handshake. The first version of this fix only guarded
  // ensureBackend, and the `ready` event then re-read the same workspace key and put the first
  // chat's session back — so the bug survived a green test and only showed up on film.
  provider.onEvent({ type: "ready", session_id: "", session_name: "",
                     capabilities: { history_snapshot: true } });
  assert.equal(provider.sessionRestoreCandidate, "",
    "the ready handshake must not re-adopt the window's remembered session either");
  assert.notEqual(provider.currentSessionId, "alpha");
});

test("a chat whose backend died resumes its OWN session, not the window's", async () => {
  const { provider, remembered } = harness();
  remembered.id = "beta";                            // the window's memory has moved on
  remembered.scope = provider.draftScope();
  makeLive(provider, { sessionId: "alpha", name: "First" });
  const first = provider.slots[0];
  provider.openChatSlot();
  makeLive(provider, { sessionId: "beta", name: "Second" });
  provider.backgroundBackendLost(first, "killed by SIGKILL");

  provider.switchToSlot(first.id);
  assert.equal(provider.sessionRestoreCandidate, "alpha",
    "it must come back on the chat it was on, not on whatever the window last remembered");

  provider.onEvent({ type: "ready", session_id: "", session_name: "",
                     capabilities: { history_snapshot: true } });
  assert.equal(provider.sessionRestoreCandidate, "alpha",
    "and the handshake must not swap it for the window's remembered one");
});

test("a chat that became ready in the background is not left wedged", () => {
  // The handshake a `ready` starts writes the panel's own fields and calls completeHandshake() on
  // the backend. It can only run for the chat on screen — and until it runs, that backend accepts
  // nothing: every prompt is enqueued and never sent. Dropping a background `ready` outright left
  // the chat permanently mute, with no error anywhere.
  const { provider } = harness();
  makeLive(provider, { sessionId: "alpha", name: "First" });
  provider.openChatSlot();
  const second = provider.activeSlot();
  provider.switchToSlot(provider.slots[0].id);          // leave the new chat mid-handshake

  const ready = { type: "ready", session_id: "beta", session_name: "Second",
                  capabilities: { history_snapshot: true } };
  provider.routeEvent(second, ready);
  assert.ok(second.pendingReady, "a background ready must be held, not discarded");

  let handled = null;
  const realOnEvent = provider.onEvent.bind(provider);
  provider.onEvent = (ev) => { if (ev.type === "ready") handled = ev; return realOnEvent(ev); };
  provider.switchToSlot(second.id);

  assert.ok(handled, "the held ready must run once the chat is on screen");
  assert.equal(second.pendingReady, undefined, "and must not run twice");
});

test("switching chats updates what the window remembers as current", () => {
  // The remembered id is read whenever a backend starts unsuppressed — including the replacement
  // after a crash. Leaving it on the chat we left meant a foreground restart resumed THAT chat's
  // session here, and died on "this session has an active turn in another DGC process".
  const { provider, remembered } = harness();
  remembered.scope = "";
  makeLive(provider, { sessionId: "alpha", name: "First" });
  const first = provider.slots[0].id;
  provider.openChatSlot();
  makeLive(provider, { sessionId: "beta", name: "Second" });

  provider.switchToSlot(first);

  assert.equal(remembered.id, "alpha",
    "the window still pointed at the chat we switched away from");
});

test("Switch Chat lists what each chat is doing", async () => {
  const { provider } = harness();
  makeLive(provider, { sessionId: "alpha", name: "First" });
  provider.openChatSlot();
  makeLive(provider, { sessionId: "beta", name: "Second" });
  provider.slots[0].busy = true;
  provider.focus = () => {};
  provider.inVisiblePanel = (action) => action();

  quickPickAnswer = undefined;
  await provider.pickChat();

  const items = notices.quickPick.at(-1);
  assert.equal(items.length, 2);
  assert.equal(items[0].label, "First");
  assert.equal(items[0].description, "working");
  assert.match(items[1].description, /showing/);
});

test("a chat parked mid-handshake finishes it when you come back", () => {
  const { provider, spawned } = harness();
  makeLive(provider, { sessionId: "alpha", name: "First" });

  // Open a second chat and put it in the state a cold-starting backend leaves behind: `ready`
  // arrived and the handshake began, but neither the native settings promise nor the roots
  // acknowledgement has landed.
  provider.openChatSlot();
  const be = provider.ensureBackend();
  provider.initializingBackend = be;
  provider.nativeSettingsReady = false;
  provider.workspaceRootsInFlight = { revision: 1 };
  provider.workspaceRootsDirty = false;
  provider.lastReadyEvent = { type: "ready", capabilities: {} };
  const second = provider.activeSlotId;

  // Switch away and back. Nothing can complete the handshake while this chat is parked: every
  // door out of maybeCompleteHandshake is guarded on `this.backend === be`, and the roots
  // acknowledgement is dropped as a background event.
  provider.switchToSlot(provider.slots[0].id);
  provider.switchToSlot(second);

  const asked = be.sent.filter((c) => c && c.type === "set_workspace_roots");
  assert.ok(asked.length >= 1, "the roots command must actually go out again");
  assert.notDeepEqual(provider.workspaceRootsInFlight, { revision: 1 },
    "the stale acknowledgement must not hold the handshake for ever");
  assert.ok(provider.workspaceRootsInFlight !== undefined,
    "and the re-ask waits for THIS backend's acknowledgement, as the setup barrier requires");
  assert.equal(spawned.length, 2, "coming back must not spawn a third backend");
});

test("coming back to a chat that finished its handshake changes nothing", () => {
  const { provider } = harness();
  makeLive(provider, { sessionId: "alpha", name: "First" });
  provider.openChatSlot();
  makeLive(provider, { sessionId: "beta", name: "Second" });
  const second = provider.activeSlotId;
  provider.initializingBackend = undefined;      // its handshake completed
  provider.workspaceRootsInFlight = undefined;
  provider.workspaceRootsDirty = false;

  provider.switchToSlot(provider.slots[0].id);
  provider.switchToSlot(second);

  assert.equal(provider.workspaceRootsDirty, false,
    "a settled chat must not be dragged back through its handshake");
});

test("a chat blocked on two decisions keeps its dot until both settle", () => {
  // The active path keeps a Set because a chat can be stopped on several things at once, and a
  // prompt can carry up to four open asks. A boolean cleared by the first resolve put the dot out
  // while the chat was still waiting — and nothing else would ever light it again.
  const { provider, posted } = harness();
  makeLive(provider, { sessionId: "alpha", name: "First" });
  provider.openChatSlot();
  makeLive(provider, { sessionId: "beta", name: "Second" });
  const background = provider.slots[0];
  const dot = () => slotsPost(posted).items.find((item) => item.id === background.id).needsYou;

  provider.routeEvent(background, { type: "ask_request", request_id: "a1" });
  provider.routeEvent(background, { type: "permission_request", request_id: "p1" });
  assert.equal(dot(), true);

  provider.routeEvent(background, { type: "request_expired", request_id: "a1" });
  assert.equal(dot(), true, "still stopped on the permission request");

  provider.routeEvent(background, { type: "permission_resolved", request_id: "p1" });
  assert.equal(dot(), false, "now nothing is waiting on the user");
});

test("a background backend's death does not touch the foreground chat's records", () => {
  const { provider } = harness();
  makeLive(provider, { sessionId: "alpha", name: "First" });
  provider.openChatSlot();
  makeLive(provider, { sessionId: "beta", name: "Second" });
  provider.confirmedTurnActive = provider.turnActive = true;   // the chat ON SCREEN is mid-turn
  const wrote = [];
  provider.markInterruptedWork = (...a) => { wrote.push(["marked", ...a]); return "session"; };
  provider.recordUnassistedExit = (...a) => { wrote.push(["recorded", ...a]); return 1; };
  provider.backgroundBackendLost = () => { wrote.push(["backgrounded"]); };

  const background = provider.slots[0];
  const resumes = provider.recordExitAgainstActiveChat(background, "killed by SIGKILL", "prompt");

  assert.equal(resumes, undefined, "a background death is not the active chat's to resume");
  assert.deepEqual(wrote, [["backgrounded"]],
    "the foreground chat's interrupted-turn record belongs to its own turn");
});

test("the active chat's own death is still recorded", () => {
  const { provider } = harness();
  makeLive(provider, { sessionId: "alpha", name: "First" });
  const wrote = [];
  provider.markInterruptedWork = () => { wrote.push("marked"); return "session"; };
  provider.recordUnassistedExit = () => { wrote.push("recorded"); return 1; };

  const resumes = provider.recordExitAgainstActiveChat(
    provider.activeSlot(), "killed by SIGKILL", "prompt");

  assert.equal(resumes, "session");
  assert.deepEqual(wrote, ["recorded", "marked"]);
});

test("a stop we asked for is not treated as a crash", () => {
  const { provider, spawned } = harness();
  makeLive(provider, { sessionId: "alpha", name: "First" });
  provider.openChatSlot();
  makeLive(provider, { sessionId: "beta", name: "Second" });
  const victim = provider.slots[0];
  provider.closeChatSlot(victim.id);

  const cause = spawned[0].disposed;
  assert.match(cause, /^chat closed: /, "the cause says plainly that the user closed it");
  assert.equal(provider.isDeliberateStop(cause), true,
    "so the teardown handler must not log it as a crash, nor arm the slot to resume");
  assert.equal(provider.isDeliberateStop("killed by SIGKILL"), false, "a real crash still is one");
  assert.equal(provider.isDeliberateStop("restart: new dgc.command"), true);
});

test("capability flags do not leak from one chat's CLI to another's", () => {
  // `dgc.command` restarts only the ACTIVE backend, so two chats really can run different builds.
  const { provider } = harness();
  makeLive(provider, { sessionId: "alpha", name: "First" });
  provider.mcpManagement = false;                 // chat 1 is on a CLI without it
  provider.skillManagement = false;
  const first = provider.activeSlotId;

  provider.openChatSlot();
  makeLive(provider, { sessionId: "beta", name: "Second" });
  provider.mcpManagement = true;                  // chat 2's CLI has it
  provider.skillManagement = true;

  provider.switchToSlot(first);
  assert.equal(provider.mcpManagement, false,
    "the older CLI must not be offered commands it rejects");
  assert.equal(provider.skillManagement, false);
});

test("a chat waiting on an open ask is not parked as idle", () => {
  // `ask_request` carries `ask_id`; every other decision event carries `id`. The add side read
  // only `id`, so an ask was never recorded — and the chat you switched away from showed the idle
  // dot while it was in fact stopped, waiting for you. The delete side already read `ask_id`,
  // which is what hid the asymmetry.
  const { provider, posted } = harness();
  makeLive(provider, { sessionId: "alpha", name: "First" });
  const first = provider.activeSlotId;
  provider.onEvent({ type: "ask_request", ask_id: "q1", question: "Which database?" });
  assert.equal(provider.openDecisions.size, 1, "the ask must be recorded");

  provider.openChatSlot();
  makeLive(provider, { sessionId: "beta", name: "Second" });
  const chip = slotsPost(posted).items.find((item) => item.id === first);
  assert.equal(chip.needsYou, true, "the chat you left is waiting on you, and must say so");
});

test("answering an ask clears it", () => {
  const { provider } = harness();
  makeLive(provider, { sessionId: "alpha", name: "First" });
  provider.onEvent({ type: "ask_request", ask_id: "q1", question: "Which database?" });
  provider.onEvent({ type: "ask_resolved", ask_id: "q1", outcome: "answered" });
  assert.equal(provider.openDecisions.size, 0);
});

test("accepting a plan stops the chat claiming it is still waiting on you", async () => {
  // `plan_response` is a command; the CLI emits no matching event, so nothing else clears the id.
  // The chat stayed flagged for the whole rest of a turn that was already executing the plan.
  const { provider } = harness();
  makeLive(provider, { sessionId: "alpha", name: "First" });
  provider.onEvent({ type: "plan_proposal", id: "plan1", plan: "do the thing", choices: [] });
  assert.equal(provider.openDecisions.size, 1);

  await provider.onMessage({ type: "plan_response", id: "plan1", decision: "acceptEdits" });

  assert.equal(provider.openDecisions.size, 0,
    "the plan was answered; the turn carries on working, not waiting");
});

test("a rejected plan clears it too", async () => {
  const { provider } = harness();
  makeLive(provider, { sessionId: "alpha", name: "First" });
  provider.onEvent({ type: "plan_proposal", id: "plan2", plan: "do it", choices: [] });
  await provider.onMessage({ type: "plan_response", id: "plan2", decision: "reject" });
  assert.equal(provider.openDecisions.size, 0);
});
