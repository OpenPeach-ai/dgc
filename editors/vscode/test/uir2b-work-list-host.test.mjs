// User test W1 (15 Nov), the host's side with the real src/panel.ts: a fresh window's Work list said "No sessions in
// this project yet" over nine sessions until New was pressed. The list was asked for before DGC had said what it
// offers (so: this folder's sessions only), DGC's ready arrived while that answer was on its way, and nothing read the
// list again with the Project Folder dropdown (every project's sessions). Now the ready reads it again, and the late
// answer to the first question is dropped.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { cleanup, makeProvider } from "./support/panel-bundle.mjs";

after(cleanup);
const tick = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0)); };
const NINE = Array.from({ length: 9 }, (_, i) => ({ path: `/s/20261115-19${String(10 + i)}00-a${i}.json`, name: `Session ${i + 1}`, preview: "", when: "2026-11-15 19:10", count: 4, cwd: "/home/me/usertest/lime_tiles" }));
const OFFERS = { session_paging: true, session_scopes: true, pips_enabled: true, pips_supported: true, pips_api_version: 95 };

test("W1 host: a list asked for before DGC said what it offers is read again when it does; the first answer never empties it", async () => {
  const { provider, backend, posted } = makeProvider();
  provider.home = true;
  provider.places = { openSessions: () => new Set(), open() {} };
  provider.lastReadyEvent = undefined;                       // a fresh window: DGC has not said anything yet
  provider.ensurePipsBridge = () => ({ projectFolders: async () => ({ folders: [{ folder: "/home/me/usertest/lime_tiles", sessions: 9, pips: 0, exists: true }] }), ready() {}, projectFolderChanged() {} });
  const asked = []; let answerFirst;
  provider.requestState = (_be, _prefix, command) => {
    asked.push(command);
    if (command.type !== "list_sessions") return Promise.resolve({ type: "sessions", items: [] });
    // The first question (this folder's sessions) is answered late; the one that names every project's at once.
    return command.scope === "all" ? Promise.resolve({ type: "sessions", items: NINE }) : new Promise((resolve) => { answerFirst = () => resolve({ type: "sessions", items: [] }); });
  };
  const first = provider.postSessions();
  await tick();
  assert.deepEqual(asked.map((c) => [c.type, c.scope || ""]), [["list_sessions", ""]], "asked before the handshake: this folder's only");
  // DGC's ready arrives while that answer is on its way.
  provider.lastReadyEvent = { type: "ready", capabilities: OFFERS, model: "m" };
  provider.finishSessionHandshake(backend);
  await tick();
  assert.ok(asked.some((c) => c.type === "list_sessions" && c.scope === "all"), "the list is read again, every project's");
  answerFirst(); await first; await tick();
  const lists = posted.filter((m) => m.type === "sessions_list");
  assert.ok(lists.length >= 1, "a list was drawn");
  assert.equal(lists.at(-1).items.length, 9, "the nine sessions, not the first question's empty answer");
  assert.ok(lists.every((m) => m.items.length === 9), "and the empty answer was never drawn");
});
