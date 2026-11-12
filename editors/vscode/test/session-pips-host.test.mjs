// Deleting a Work session that owns Project Pips, the host's side (src/panel.ts deleteSessionFromHome, with the real
// panel code): it asks DGC which Project Pips the session owns before anything else. None: the delete goes on as it
// always did. Some: the page's dialog is asked (sessionPipsAsk), and its answer decides: each Pip moved to another
// session, or each deleted, and only then the session; Cancel, or anything that fails, leaves the session where it is.
// Archiving asks the same question (sessionPipsBeforeArchive), where "Keep them here" changes nothing.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { cleanup, makeProvider, notices } from "./support/panel-bundle.mjs";

after(cleanup);

const hex = (c) => c.repeat(32);
const ID = "20261104-180000-d4", TITLE = "Invoice totals round the wrong way";
const OWNED = [{ id: "pip_" + hex("a"), name: "Billing audit", pip_type: "rook", status: "active" }, { id: "pip_" + hex("b"), name: "Docs writer", pip_type: "quill", status: "active" }];
const ITEMS = [{ path: "/s/20261106-091200-b2.json", name: "Visits page alignment", preview: "", when: "2026-11-06 09:12", count: 12 },
  { path: `/s/${ID}.json`, name: TITLE, preview: "", when: "2026-11-04 18:00", count: 31 },
  { path: "/s/20261105-221000-c3.json", name: "", preview: "What does nextWatering return?", when: "2026-11-05 22:10", count: 7 }];
const tick = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };

function home({ owned = OWNED, fail = {} } = {}) {
  const made = makeProvider({ capabilities: { pips_enabled: true, pips_supported: true, pips_api_version: 89 } });
  const { provider, posted } = made;
  const calls = [], requested = [];
  provider.home = true;
  provider.places = { openSessions: () => new Set(), open() {} };
  provider.ensurePipsBridge = () => ({
    sessionPips: async (id) => { calls.push(["sessionPips", id]); if (fail.list) throw new Error(fail.list); return owned; },
    moveSessionPips: async (pips, to) => { calls.push(["move", pips.map((p) => p.id), to]); if (fail.move) throw new Error(fail.move); },
    deleteSessionPips: async (pips) => { calls.push(["delete", pips.map((p) => p.id)]); if (fail.delete) throw new Error(fail.delete); },
  });
  provider.requestState = async (_be, _prefix, command) => { requested.push(command);
    return { type: "sessions", items: command.type === "delete_session" ? ITEMS.filter((item) => !item.path.includes(ID)) : ITEMS }; };
  notices.warnings.length = 0; notices.errors.length = 0; notices.info.length = 0;
  const asks = () => posted.filter((m) => m.type === "sessionPipsAsk");
  const deleted = () => requested.filter((c) => c.type === "delete_session");
  return { ...made, calls, requested, asks, deleted };
}

test("a session that owns no Project Pips is deleted as it always was: the one confirmation, no dialog of Pips", async () => {
  const x = home({ owned: [] });
  await x.provider.onMessage({ type: "deleteSession", id: ID, title: TITLE });
  assert.deepEqual(x.calls, [["sessionPips", ID]], "DGC is asked first");
  assert.deepEqual(x.asks(), []);
  assert.equal(notices.warnings.length, 1);
  assert.match(notices.warnings[0], /^Delete the session “Invoice totals round the wrong way”\?/);
});

test("it owns Project Pips: the page is asked, with the Pips and the project's other sessions by their titles", async () => {
  const x = home();
  const going = x.provider.onMessage({ type: "deleteSession", id: ID, title: TITLE });
  await tick();
  assert.equal(x.asks().length, 1);
  const ask = x.asks()[0];
  assert.match(ask.requestId, /^[a-f0-9]{32}$/);
  assert.deepEqual({ ...ask, requestId: "" }, { type: "sessionPipsAsk", requestId: "", mode: "delete", title: TITLE,
    pips: OWNED.map(({ id, name, pip_type }) => ({ id, name, pip_type })),
    sessions: [{ id: "20261106-091200-b2", title: "Visits page alignment" }, { id: "20261105-221000-c3", title: "What does nextWatering return?" }] });
  assert.deepEqual(notices.warnings, [], "its dialog is the confirmation: no second one");
  assert.deepEqual(x.deleted(), [], "nothing is deleted while it waits");
  await x.provider.onMessage({ type: "sessionPipsAnswer", requestId: ask.requestId, choice: "cancel" });
  await going;
  assert.deepEqual(x.calls, [["sessionPips", ID]], "Cancel: no Pip is touched");
  assert.deepEqual(x.deleted(), []);
});

test("Move them to another session: each Pip is moved, then the session is deleted", async () => {
  const x = home();
  const going = x.provider.onMessage({ type: "deleteSession", id: ID, title: TITLE });
  await tick();
  await x.provider.onMessage({ type: "sessionPipsAnswer", requestId: x.asks()[0].requestId, choice: "move", to: "20261106-091200-b2" });
  await going;
  assert.deepEqual(x.calls.slice(1), [["move", OWNED.map((p) => p.id), "20261106-091200-b2"]]);
  assert.deepEqual(x.deleted(), [{ type: "delete_session", path: `${ID}.json` }]);
  const none = home();
  const second = none.provider.onMessage({ type: "deleteSession", id: ID, title: TITLE });
  await tick();
  await none.provider.onMessage({ type: "sessionPipsAnswer", requestId: none.asks()[0].requestId, choice: "move", to: "" });
  await second;
  assert.deepEqual(none.calls.slice(1), [["move", OWNED.map((p) => p.id), null]], "No session is a null owner");
  const stray = home();
  const third = stray.provider.onMessage({ type: "deleteSession", id: ID, title: TITLE });
  await tick();
  await stray.provider.onMessage({ type: "sessionPipsAnswer", requestId: stray.asks()[0].requestId, choice: "move", to: "not-one-of-them" });
  await third;
  assert.deepEqual(stray.calls.slice(1), [], "a session the question never offered is no answer");
  assert.deepEqual(stray.deleted(), []);
});

test("Delete them too: each Pip is deleted, then the session", async () => {
  const x = home();
  const going = x.provider.onMessage({ type: "deleteSession", id: ID, title: TITLE });
  await tick();
  await x.provider.onMessage({ type: "sessionPipsAnswer", requestId: x.asks()[0].requestId, choice: "delete" });
  await going;
  assert.deepEqual(x.calls.slice(1), [["delete", OWNED.map((p) => p.id)]]);
  assert.deepEqual(x.deleted(), [{ type: "delete_session", path: `${ID}.json` }]);
});

test("a Pip that can't be moved or deleted keeps the session: DGC's words are shown and nothing is deleted", async () => {
  for (const [choice, fail] of [["move", { move: "Billing audit: Choose one of this project's sessions: that session isn't one." }],
    ["delete", { delete: "Billing audit: A run is still going. Stop it or let it finish first." }]]) {
    const x = home({ fail });
    const going = x.provider.onMessage({ type: "deleteSession", id: ID, title: TITLE });
    await tick();
    await x.provider.onMessage({ type: "sessionPipsAnswer", requestId: x.asks()[0].requestId, choice, to: "20261106-091200-b2" });
    await going;
    assert.deepEqual(x.deleted(), [], choice);
    assert.equal(notices.warnings.length, 1, choice);
    assert.match(notices.warnings[0], new RegExp("^The session was not deleted\\. " + Object.values(fail)[0].replace(/[.?']/g, (c) => "\\" + c)));
  }
});

test("when Pips can't be read, the delete goes on as it always did", async () => {
  const x = home({ fail: { list: "Pips are unavailable." } });
  await x.provider.onMessage({ type: "deleteSession", id: ID, title: TITLE });
  assert.deepEqual(x.calls, [["sessionPips", ID]], "it tried");
  assert.deepEqual(x.asks(), []);
  assert.match(notices.warnings[0], /^Delete the session “Invoice totals round the wrong way”\?/);
});

test("the session menu's delete (a tab's list of sessions) asks too, in the editor's own dialogs", async () => {
  const vs = globalThis.__DGC_TEST_VSCODE.window, kept = { warn: vs.showWarningMessage, quick: vs.createQuickPick, pick: vs.showQuickPick };
  try {
    const run = async (first, second) => {
      const x = home();
      x.provider.home = false;
      const said = [], picks = [];
      let onButton;
      vs.createQuickPick = () => ({ items: [], selectedItems: [], onDidTriggerItemButton(fn) { onButton = fn; }, onDidAccept() {}, onDidHide() {}, show() {}, hide() {}, dispose() {} });
      vs.showWarningMessage = async (message, options, ...buttons) => { said.push([String(message), options?.modal === true, buttons]); return said.length === 1 ? first : second; };
      vs.showQuickPick = async (items) => { picks.push(items.map((item) => item.label)); return items[0]; };
      void x.provider.resume();
      await tick();
      assert.equal(typeof onButton, "function", "the list is up");
      await onButton({ item: { path: `/s/${ID}.json`, label: TITLE } });
      await tick();
      return { x, said, picks };
    };
    const moved = await run("Move them to another session");
    assert.deepEqual(moved.said[0], ["“Invoice totals round the wrong way” is the owner of 2 Project Pips: Billing audit, Docs writer. Their reports come to it. What becomes of them when it is deleted?", true,
      ["Move them to another session", "Delete them too"]]);
    assert.deepEqual(moved.picks, [["Visits page alignment", "What does nextWatering return?", "No session"]], "then which session");
    assert.deepEqual(moved.x.calls.slice(1), [["move", OWNED.map((p) => p.id), "20261106-091200-b2"]]);
    assert.deepEqual(moved.x.deleted(), [{ type: "delete_session", path: `/s/${ID}.json` }]);
    const gone = await run("Delete them too", "Delete permanently");
    assert.match(gone.said[1][0], /^Delete 2 Pips permanently\? This erases each one’s chat, runs, computer files/);
    assert.deepEqual(gone.x.calls.slice(1), [["delete", OWNED.map((p) => p.id)]]);
    assert.equal(gone.x.deleted().length, 1);
    const cancelled = await run(undefined);
    assert.deepEqual(cancelled.x.calls.slice(1), []);
    assert.deepEqual(cancelled.x.deleted(), [], "Cancel keeps the session");
    const unsure = await run("Delete them too", undefined);
    assert.deepEqual(unsure.x.calls.slice(1), []);
    assert.deepEqual(unsure.x.deleted(), []);
  } finally { vs.showWarningMessage = kept.warn; vs.createQuickPick = kept.quick; vs.showQuickPick = kept.pick; }
});

test("archiving asks the same question: Keep them here changes nothing, Move moves them, Cancel stops the archive", async () => {
  const run = async (answer) => {
    const x = home();
    assert.equal(typeof x.provider.sessionPipsBeforeArchive, "function", "the host has the archive question");
    const going = x.provider.sessionPipsBeforeArchive(ID, TITLE);
    await tick();
    assert.equal(x.asks()[0]?.mode, "archive");
    await x.provider.onMessage({ type: "sessionPipsAnswer", requestId: x.asks()[0].requestId, ...answer });
    return { x, go: await going };
  };
  const keep = await run({ choice: "keep" });
  assert.equal(keep.go, true, "the archive goes on");
  assert.deepEqual(keep.x.calls.slice(1), [], "and its Pips stay its own");
  const move = await run({ choice: "move", to: "20261105-221000-c3" });
  assert.equal(move.go, true);
  assert.deepEqual(move.x.calls.slice(1), [["move", OWNED.map((p) => p.id), "20261105-221000-c3"]]);
  const cancel = await run({ choice: "cancel" });
  assert.equal(cancel.go, false);
  const never = await run({ choice: "delete" });
  assert.equal(never.go, false, "archiving never deletes a Pip");
  assert.deepEqual(never.x.calls.slice(1), []);
});
