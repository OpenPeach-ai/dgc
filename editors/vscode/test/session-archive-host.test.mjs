// Archive for Work sessions, the host's side (src/panel.ts, with the real panel code): Archive from a row's menu goes
// to DGC at once (archive_session, never with Pips: a session owns none any more), and the page is told so it can
// offer Undo; Undo and Restore are archive_session {archived: false}, the session only; the archived ones are listed
// with the list (list_sessions {archived: true}, searched with it, 200 at a time); Delete of an archived one asks in
// the editor's own dialog. Only on a DGC that says it can (ready.capabilities.session_archive).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { cleanup, makeProvider, notices } from "./support/panel-bundle.mjs";

after(cleanup);

const ID = "20261104-180000-d4", TITLE = "Checkout", GONE = "20261101-120000-e5";
const ITEMS = [{ path: "/s/20261106-091200-b2.json", name: "Visits page alignment", preview: "", when: "2026-11-06 09:12", count: 12 },
  { path: `/s/${ID}.json`, name: TITLE, preview: "", when: "2026-11-04 18:00", count: 31 }];
const ARCHIVED = [{ path: `/s/archived/${GONE}.json`, name: "Old cart", preview: "", when: "2026-11-01 12:00", count: 14, archived: true }];
const tick = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };

function home({ can = true, open = [], refuse = "", archived = ARCHIVED, answer = {} } = {}) {
  const made = makeProvider({ capabilities: { session_paging: true, ...(can ? { session_archive: true } : {}), pips_enabled: true, pips_supported: true, pips_api_version: 95 } });
  const { provider, posted } = made;
  const requested = [], bridge = [];
  provider.home = true;
  provider.places = { openSessions: () => new Set(open), open() {} };
  provider.ensurePipsBridge = () => { bridge.push("asked"); return new Proxy({}, { get: (_t, name) => async () => { bridge.push(String(name)); return []; } }); };
  provider.requestState = async (_be, _prefix, command, responseType) => {
    requested.push([command, responseType]);
    if (command.type === "archive_session") {
      if (refuse) throw new Error(refuse);
      return { type: "session_archived", path: command.path, archived: command.archived !== false, ...answer };
    }
    if (command.type === "delete_session") return { type: "sessions", items: ITEMS, deleted: true };
    return { type: "sessions", items: command.archived ? archived : ITEMS };
  };
  notices.warnings.length = 0; notices.errors.length = 0; notices.info.length = 0;
  const of = (type) => requested.filter(([c]) => c.type === type).map(([c]) => c);
  const lists = () => posted.filter((m) => m.type === "sessions_list");
  return { ...made, requested, bridge, of, lists };
}

test("Archive: DGC is asked at once, with no Pips and no question; the page is told, and the list read again", async () => {
  const x = home();
  await x.provider.onMessage({ type: "archiveSession", id: ID, title: TITLE });
  await tick();
  assert.deepEqual(x.of("archive_session"), [{ type: "archive_session", path: `${ID}.json` }], "the session only: no `pips`");
  assert.equal(x.requested.find(([c]) => c.type === "archive_session")[1], "session_archived");
  assert.deepEqual(x.bridge, [], "Pips are never asked about");
  assert.deepEqual([notices.warnings, notices.info, notices.errors], [[], [], []], "no confirmation: it can be undone");
  assert.deepEqual(x.posted.filter((m) => m.type === "sessions_note"), [{ type: "sessions_note", kind: "archived", id: ID, title: TITLE }]);
  assert.ok(x.of("list_sessions").length >= 1, "the list is read again");
  assert.deepEqual(x.posted.filter((m) => m.type === "sessionPipsAsk"), []);
});

test("Archive is for this window's folder's sessions that are closed, on a DGC that can", async () => {
  const old = home({ can: false });
  await old.provider.onMessage({ type: "archiveSession", id: ID, title: TITLE });
  assert.deepEqual(old.of("archive_session"), [], "an older DGC is never sent it");
  const open = home({ open: [ID] });
  await open.provider.onMessage({ type: "archiveSession", id: ID, title: TITLE });
  assert.deepEqual(open.of("archive_session"), []);
  assert.deepEqual(notices.info, ["That session is open in a tab. Close its tab first, then archive it."]);
  const elsewhere = home();
  elsewhere.provider.sessionsElsewhere.set(ID, { project: "/home/me/garden", name: "garden", exists: true });
  await elsewhere.provider.onMessage({ type: "archiveSession", id: ID, title: TITLE });
  assert.deepEqual([elsewhere.of("archive_session"), notices.info.length], [[], 0], "another folder's: nothing, and nothing said");
  const bad = home();
  await bad.provider.onMessage({ type: "archiveSession", id: "../../etc/passwd", title: TITLE });
  assert.deepEqual(bad.of("archive_session"), []);
});

test("a refusal from DGC is said in its own words, and nothing is offered to undo", async () => {
  const x = home({ refuse: "That session is running a turn. Wait for it to finish, then archive it." });
  await x.provider.onMessage({ type: "archiveSession", id: ID, title: TITLE });
  await tick();
  assert.deepEqual(notices.warnings, ["That session is running a turn. Wait for it to finish, then archive it."]);
  assert.deepEqual(x.posted.filter((m) => m.type === "sessions_note"), []);
});

test("the list says it can archive, and carries the archived sessions: asked for with the list, searched with it, 200 at a time", async () => {
  const x = home();
  await x.provider.onMessage({ type: "sessionsList" });
  await tick();
  assert.deepEqual(x.of("list_sessions").filter((c) => c.archived), [{ type: "list_sessions", archived: true, limit: 201 }]);
  const said = x.lists().at(-1);
  assert.equal(said.archive, true);
  assert.deepEqual(said.archived, { items: [{ id: GONE, name: "Old cart", preview: "", when: "2026-11-01 12:00", count: 14 }], more: false });
  assert.deepEqual(said.items.map((i) => i.id), ["20261106-091200-b2", ID], "the list itself is as it was");
  await x.provider.onMessage({ type: "sessionsSearch", query: "cart" });
  await tick();
  assert.deepEqual(x.of("list_sessions").filter((c) => c.archived).at(-1), { type: "list_sessions", archived: true, limit: 201, query: "cart" });
  await x.provider.onMessage({ type: "sessionsArchivedMore" });
  await tick();
  assert.equal(x.of("list_sessions").filter((c) => c.archived).at(-1).limit, 401);
  const many = home({ archived: Array.from({ length: 201 }, (_, k) => ({ path: `/s/archived/2026-a${k}.json`, name: `Old ${k}`, preview: "", when: "2026-11-01 12:00", count: 1, archived: true })) });
  await many.provider.onMessage({ type: "sessionsList" });
  await tick();
  assert.deepEqual([many.lists().at(-1).archived.items.length, many.lists().at(-1).archived.more], [200, true], "one more than shown says there are more");
  const old = home({ can: false });
  await old.provider.onMessage({ type: "sessionsList" });
  await tick();
  assert.deepEqual([old.of("list_sessions").filter((c) => "archived" in c), old.lists().at(-1).archive, old.lists().at(-1).archived], [[], undefined, undefined], "an older DGC: asked nothing new, offered nothing new");
});

test("Undo and Restore: the session comes back, and only the session", async () => {
  const x = home({ answer: { pips: ["pip_" + "c".repeat(32)] } });
  await x.provider.onMessage({ type: "sessionsList" });
  await tick();
  await x.provider.onMessage({ type: "restoreSession", id: GONE, title: "Old cart" });
  await tick();
  assert.deepEqual(x.of("archive_session"), [{ type: "archive_session", path: `${GONE}.json`, archived: false }]);
  assert.deepEqual(x.bridge, [], "no Pip is restored with it: sessions own none");
  assert.ok(x.of("list_sessions").length >= 3, "it then shows in the list again");
  // Undo, straight after an archive: the one just archived can be restored before the list is read again.
  const undo = home({ archived: [] });
  await undo.provider.onMessage({ type: "archiveSession", id: ID, title: TITLE });
  await undo.provider.onMessage({ type: "restoreSession", id: ID, title: TITLE });
  await tick();
  assert.deepEqual(undo.of("archive_session").map((c) => c.archived), [undefined, false]);
  // On the dock meanwhile, it opens nothing and says where it is.
  const pinned = home({ archived: [] });
  const opened = [];
  pinned.provider.openSessionInEditor = (id) => opened.push(id);
  pinned.provider.context.globalState.get = (key) => (key === "dgc.dock.pins" ? [{ key: `work:${ID}`, kind: "work", id: ID, title: TITLE }] : undefined);
  pinned.provider.openFromDock(`work:${ID}`);
  assert.deepEqual(opened, [ID], "pinned and in the list: it opens");
  await pinned.provider.onMessage({ type: "archiveSession", id: ID, title: TITLE });
  pinned.provider.openFromDock(`work:${ID}`);
  assert.deepEqual([opened, notices.info], [[ID], ["That session is archived. Restore it from Archived, at the end of the Work list, to open it."]]);
  // Never an id the page made up.
  const stray = home();
  await stray.provider.onMessage({ type: "sessionsList" });
  await tick();
  await stray.provider.onMessage({ type: "restoreSession", id: "20260101-000000-zz", title: "?" });
  assert.deepEqual(stray.of("archive_session"), []);
  const refused = home({ refuse: "A session with that name is already here." });
  await refused.provider.onMessage({ type: "sessionsList" });
  await tick();
  await refused.provider.onMessage({ type: "restoreSession", id: GONE, title: "Old cart" });
  await tick();
  assert.deepEqual(notices.warnings, ["A session with that name is already here."]);
});

test("Delete of an archived session: the editor's own dialog first, then for good", async () => {
  const vs = globalThis.__DGC_TEST_VSCODE.window, kept = vs.showWarningMessage;
  try {
    const said = [];
    let answer;
    vs.showWarningMessage = async (message, options, ...buttons) => { said.push([String(message), options?.modal === true, buttons]); return answer; };
    const x = home();
    await x.provider.onMessage({ type: "sessionsList" });
    await tick();
    await x.provider.onMessage({ type: "deleteArchivedSession", id: GONE, title: "Old cart" });
    assert.deepEqual(said, [["Delete the archived session “Old cart”? Its conversation is removed, and this can't be undone.", true, ["Delete"]]]);
    assert.deepEqual(x.of("delete_session"), [], "not without a yes");
    answer = "Delete";
    await x.provider.onMessage({ type: "deleteArchivedSession", id: GONE, title: "Old cart" });
    await tick();
    assert.deepEqual(x.of("delete_session"), [{ type: "delete_session", path: `${GONE}.json`, archived: true }]);
    assert.deepEqual(x.bridge, []);
    await x.provider.onMessage({ type: "deleteArchivedSession", id: ID, title: TITLE });
    assert.equal(x.of("delete_session").length, 1, "only one DGC listed as archived");
  } finally { vs.showWarningMessage = kept; }
});

test("a session with a name and nothing in it yet is a session like any other; an untitled empty one is still said to be empty", async () => {
  const x = home();
  x.provider.requestState = async () => ({ type: "sessions", items: [
    { path: "/s/2026-new.json", name: "Pips from Checkout", preview: "(empty)", when: "2026-11-13 10:00", count: 0 },
    { path: "/s/2026-blank.json", name: "", preview: "(empty)", when: "2026-11-13 10:01", count: 0 },
    { path: "/s/2026-full.json", name: "", preview: "Fix the cart", when: "2026-11-13 10:02", count: 4 }] });
  const sessions = await x.provider.sessionsForPip();
  assert.deepEqual(sessions.map((s) => [s.id, s.title, s.empty === true]), [["2026-new", "Pips from Checkout", false], ["2026-blank", "", true], ["2026-full", "Fix the cart", false]]);
});
