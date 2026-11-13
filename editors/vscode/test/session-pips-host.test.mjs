// Deleting a Work session never asks about Pips (14 Nov: a session owns none any more; it is "related" to some, worked
// out from what happened). The host's side, with the real panel code (src/panel.ts deleteSessionFromHome and the
// session menu's delete in a tab): the one confirmation it always had, then the delete. DGC is never asked which Pips a
// session owns, no dialog of Pips is posted to the page, and no Pip is moved or deleted with it. (Until 14 Nov this
// file held the owner dialog's host side: Move them / Delete them too, and the archive question.)
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { cleanup, makeProvider, notices } from "./support/panel-bundle.mjs";

after(cleanup);

const ID = "20261104-180000-d4", TITLE = "Invoice totals round the wrong way";
const ITEMS = [{ path: "/s/20261106-091200-b2.json", name: "Visits page alignment", preview: "", when: "2026-11-06 09:12", count: 12 },
  { path: `/s/${ID}.json`, name: TITLE, preview: "", when: "2026-11-04 18:00", count: 31 },
  { path: "/s/20261105-221000-c3.json", name: "", preview: "What does nextWatering return?", when: "2026-11-05 22:10", count: 7 }];
const tick = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };

function home() {
  const made = makeProvider({ capabilities: { pips_enabled: true, pips_supported: true, pips_api_version: 95 } });
  const { provider, posted } = made;
  const bridge = [], requested = [];
  provider.home = true;
  provider.places = { openSessions: () => new Set(), open() {} };
  // Anything asked of Pips is noted: nothing may be.
  provider.ensurePipsBridge = () => { bridge.push("asked"); return new Proxy({}, { get: (_t, name) => async () => { bridge.push(String(name)); return [{ id: "pip_" + "a".repeat(32), name: "Billing audit", pip_type: "rook", status: "active" }]; } }); };
  provider.requestState = async (_be, _prefix, command) => { requested.push(command);
    return { type: "sessions", items: command.type === "delete_session" ? ITEMS.filter((item) => !item.path.includes(ID)) : ITEMS }; };
  notices.warnings.length = 0; notices.errors.length = 0; notices.info.length = 0;
  const deleted = () => requested.filter((c) => c.type === "delete_session");
  return { ...made, bridge, requested, deleted };
}

test("Delete from the Work list: the one confirmation, and nothing about Pips", async () => {
  const vs = globalThis.__DGC_TEST_VSCODE.window, kept = vs.showWarningMessage;
  try {
    const said = [];
    let answer;
    vs.showWarningMessage = async (message, options, ...buttons) => { said.push([String(message), options?.modal === true, buttons]); return answer; };
    const x = home();
    await x.provider.onMessage({ type: "deleteSession", id: ID, title: TITLE });
    assert.deepEqual(said, [["Delete the session “Invoice totals round the wrong way”? Its conversation is removed from this project, and this can't be undone.", true, ["Delete"]]]);
    assert.deepEqual(x.deleted(), [], "not without a yes");
    answer = "Delete";
    await x.provider.onMessage({ type: "deleteSession", id: ID, title: TITLE });
    await tick();
    assert.deepEqual(x.deleted(), [{ type: "delete_session", path: `${ID}.json` }]);
    assert.deepEqual(x.bridge, [], "DGC is never asked which Pips it owns, and none is moved or deleted");
    assert.deepEqual(x.posted.filter((m) => /^sessionPips/.test(m.type)), [], "no dialog of Pips");
  } finally { vs.showWarningMessage = kept; }
});

test("the page can't answer a question about Pips that is never asked", async () => {
  const x = home();
  await x.provider.onMessage({ type: "sessionPipsAnswer", requestId: "f".repeat(32), choice: "delete" });
  assert.deepEqual([x.bridge, x.deleted()], [[], []]);
  assert.equal(typeof x.provider.sessionPipsBeforeArchive, "undefined", "nor is there an archive question");
});

test("the session menu's delete (a tab's list of sessions) deletes as it always did: no question about Pips", async () => {
  const vs = globalThis.__DGC_TEST_VSCODE.window, kept = { warn: vs.showWarningMessage, quick: vs.createQuickPick, pick: vs.showQuickPick };
  try {
    const x = home();
    x.provider.home = false;
    const said = [], picks = [];
    let onButton;
    vs.createQuickPick = () => ({ items: [], selectedItems: [], onDidTriggerItemButton(fn) { onButton = fn; }, onDidAccept() {}, onDidHide() {}, show() {}, hide() {}, dispose() {} });
    vs.showWarningMessage = async (message) => { said.push(String(message)); return undefined; };
    vs.showQuickPick = async (items) => { picks.push(items); return undefined; };
    void x.provider.resume();
    await tick();
    assert.equal(typeof onButton, "function", "the list is up");
    await onButton({ item: { path: `/s/${ID}.json`, label: TITLE } });
    await tick();
    assert.deepEqual(x.deleted(), [{ type: "delete_session", path: `/s/${ID}.json` }]);
    assert.deepEqual([said, picks, x.bridge], [[], [], []]);
  } finally { vs.showWarningMessage = kept.warn; vs.createQuickPick = kept.quick; vs.showQuickPick = kept.pick; }
});
