// Notes, step 1 (src/notes.ts): where notes are kept. Files in DGC's own storage folder on this computer (never the
// extension's small state, never a project folder), each note with when it was made and last edited, a folder it is in,
// and a bin it waits in for 30 days. The notes kept before (in the extension's state) are carried over once, whole.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { notesModule, context, folder, cleanup, ask, act, OLD_KEY } from "./support/notes-host.mjs";

const { Notes, NOTES_MOST, NOTE_MOST, BIN_DAYS } = await notesModule();
after(cleanup);
const DAY = 86400000;
const OLD = [{ id: "n0003", text: "Ferry to Porto\n- [ ] book the 09:40\n- [x] check the car deck\nAsk about bikes", at: 3000, pinned: false },
  { id: "n0002", text: "Call the bank about the card\nthen book the ferry", at: 2000, pinned: true }, { id: "n0001", text: "Seeds for spring: tomatoes, basil, sweet peas", at: 1000, pinned: false }];
const live = (s) => s.notes.filter((n) => !n.deleted);
const text = async (notes, id) => (await ask(notes, { type: "homeNotesDo", op: "open", id })).find((m) => m.type === "homeNoteText");

test("the limits are the ones agreed: 2,000 notes, 100,000 characters a note, 30 days in the bin", () => {
  assert.equal(NOTES_MOST, 2000); assert.equal(NOTE_MOST, 100000); assert.equal(BIN_DAYS, 30);
});

test("today's notes are carried over once, whole, into files in DGC's own folder; the editor's state no longer holds them", async () => {
  const c = context(folder(), { state: { [OLD_KEY]: { order: ["note", "clock"], settings: { clock: { zones: ["Asia/Tokyo"] } }, notes: OLD } } });
  const notes = new Notes(c, { now: () => 9000 });
  const s = notes.state();
  assert.equal(s.type, "homeNotes");
  assert.deepEqual(live(s).map((n) => [n.id, n.title, n.pinned, n.created, n.edited, n.folder, n.locked]), [["n0003", "Ferry to Porto", false, 3000, 3000, "", false], ["n0002", "Call the bank about the card", true, 2000, 2000, "", false], ["n0001", "Seeds for spring: tomatoes, basil, sweet peas", false, 1000, 1000, "", false]]);
  assert.equal(live(s)[0].line, "book the 09:40 · check the car deck · Ask about bikes", "a row's line: what follows the title, without the marks");
  for (const old of OLD) assert.equal((await text(notes, old.id)).text, old.text, "each note's words, unchanged");
  // Where: files under the storage folder's notes/, one a note; the list beside them holds no note's words.
  const dir = join(c.dir, "notes");
  assert.deepEqual(readdirSync(dir).sort(), ["index.json", "n0001.md", "n0002.md", "n0003.md"]);
  assert.equal(readFileSync(join(dir, "n0002.md"), "utf8"), OLD[1].text);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dir, "index.json"), "utf8")).notes[0]).sort(), ["created", "deleted", "edited", "folder", "id", "line", "locked", "pinned", "title"], "the list: a title and the row's line, never the note");
  if (process.platform !== "win32") { assert.equal(statSync(join(dir, "n0002.md")).mode & 0o077, 0, "only this user reads a note's file"); assert.equal(statSync(dir).mode & 0o077, 0); }
  // The old copy is gone from the state (a locked note's words must not stay there); the rest of Home's state is as it was.
  const kept = c.kept.get(OLD_KEY);
  assert.equal("notes" in kept, false); assert.deepEqual(kept.order, ["note", "clock"]); assert.deepEqual(kept.settings, { clock: { zones: ["Asia/Tokyo"] } });
  // A reload: the same notes, from the files; nothing is carried over twice.
  const again = new Notes(c, { now: () => 99000 });
  assert.deepEqual(live(again.state()).map((n) => [n.id, n.edited]), [["n0003", 3000], ["n0002", 2000], ["n0001", 1000]]);
});

test("the one sticky note from before there were notes is carried over too; someone new starts with none", async () => {
  const c = context(folder(), { state: { [OLD_KEY]: { order: ["note"], settings: { note: { text: "Buy seeds\nthen water" } } } } });
  const notes = new Notes(c, { now: () => 5000 }), s = notes.state();
  assert.deepEqual(live(s).map((n) => [n.title, n.line, n.created]), [["Buy seeds", "then water", 5000]]);
  assert.equal((await text(notes, live(s)[0].id)).text, "Buy seeds\nthen water");
  assert.equal(c.kept.get(OLD_KEY).settings.note, undefined);
  const fresh = new Notes(context());
  assert.deepEqual(fresh.state().notes, []); assert.deepEqual(fresh.state().folders, []);
});

test("a note saved: made once, edited each time, titled by its first line; the limits hold; an id cannot name a file elsewhere", async () => {
  let now = 1000; const c = context(), notes = new Notes(c, { now: () => now });
  let s = await act(notes, "save", { id: "ab12cd", text: "Paint for the fence\ntwo tins, **green**" });
  assert.deepEqual(live(s).map((n) => [n.id, n.title, n.line, n.created, n.edited]), [["ab12cd", "Paint for the fence", "two tins, green", 1000, 1000]]);
  now = 5000; s = await act(notes, "save", { id: "ab12cd", text: "Paint for the fence\nthree tins" });
  assert.deepEqual(live(s).map((n) => [n.created, n.edited, n.line]), [[1000, 5000, "three tins"]]);
  assert.equal(readFileSync(join(c.dir, "notes", "ab12cd.md"), "utf8"), "Paint for the fence\nthree tins");
  assert.equal(readdirSync(join(c.dir, "notes")).some((f) => f.includes(".tmp")), false, "written whole: no half-written file is left");
  s = await act(notes, "save", { id: "long01", text: "x".repeat(NOTE_MOST + 50) });
  assert.equal((await text(notes, "long01")).text.length, NOTE_MOST);
  for (const id of ["../../evil", "a/b", "", "UPPER1", "x".repeat(40)]) await act(notes, "save", { id, text: "no" });
  assert.equal(live(notes.state()).length, 2); assert.deepEqual(readdirSync(c.dir), ["notes"]);
  s = await act(notes, "pin", { id: "ab12cd", on: true });
  assert.equal(live(s).find((n) => n.id === "ab12cd").pinned, true); assert.equal(live(s).find((n) => n.id === "ab12cd").edited, 5000, "pinning is not an edit");
  assert.deepEqual(await text(notes, "nosuch"), { type: "homeNoteText", id: "nosuch", ok: false, why: "gone" });
});

test(`a new note past ${2000} is not kept; the ones there still save`, async () => {
  const c = context(), notes = new Notes(c, { now: () => 7 });
  for (let k = 0; k < NOTES_MOST; k++) notes.handle({ type: "homeNotesDo", op: "save", id: `n${String(k).padStart(5, "0")}`, text: `Note ${k}` });
  await notes.idle();
  assert.equal(live(notes.state()).length, NOTES_MOST);
  const said = await ask(notes, { type: "homeNotesDo", op: "save", id: "onemore", text: "too many" });
  assert.equal(live(notes.state()).length, NOTES_MOST); assert.equal(existsSync(join(c.dir, "notes", "onemore.md")), false);
  assert.ok(said.some((m) => m.type === "homeNotesSaid" && m.op === "save" && m.ok === false && m.why === "full"), "and the page is told why");
  await act(notes, "save", { id: "n00007", text: "Note seven, changed" });
  assert.equal((await text(notes, "n00007")).text, "Note seven, changed");
});

test("folders: made, renamed, a note moved in; one level, each name once; deleting one keeps its notes (the default) or bins them", async () => {
  const notes = new Notes(context(), { now: () => 10 });
  for (const [id, t] of [["note01", "Ferry"], ["note02", "Tides"], ["note03", "Seeds"]]) await act(notes, "save", { id, text: t });
  let s = await act(notes, "folderNew", { id: "fold01", name: "  Trips  " });
  s = await act(notes, "folderNew", { id: "fold02", name: "Home" });
  await act(notes, "folderNew", { id: "fold03", name: "trips" }); await act(notes, "folderNew", { id: "fold04", name: "   " }); await act(notes, "folderNew", { id: "fold05", name: "a/b\nc".padEnd(90, "x") });
  s = notes.state();
  assert.deepEqual(s.folders.map((f) => [f.id, f.name]).slice(0, 2), [["fold01", "Trips"], ["fold02", "Home"]]);
  assert.equal(s.folders.length, 3, "a name already there (whatever its case) and an empty one make no folder"); assert.equal(s.folders[2].name.length, 60); assert.equal(/[\n\r]/.test(s.folders[2].name), false);
  s = await act(notes, "move", { id: "note01", folder: "fold01" }); await act(notes, "move", { id: "note02", folder: "fold01" }); await act(notes, "move", { id: "note03", folder: "fold02" });
  await act(notes, "move", { id: "note03", folder: "nofold" });
  s = notes.state();
  assert.deepEqual(live(s).map((n) => [n.id, n.folder]).sort(), [["note01", "fold01"], ["note02", "fold01"], ["note03", "fold02"]], "a folder that is not one moves nothing");
  s = await act(notes, "folderRename", { id: "fold01", name: "Journeys" }); await act(notes, "folderRename", { id: "fold02", name: "journeys" });
  assert.deepEqual(notes.state().folders.map((f) => f.name).slice(0, 2), ["Journeys", "Home"]);
  // Deleting a folder: its notes go to All notes unless asked to delete them too (then they wait in Recently deleted).
  s = await act(notes, "folderDelete", { id: "fold01" });
  assert.deepEqual(live(s).map((n) => [n.id, n.folder]).sort(), [["note01", ""], ["note02", ""], ["note03", "fold02"]]);
  s = await act(notes, "folderDelete", { id: "fold02", notes: "delete" });
  assert.deepEqual(live(s).map((n) => n.id).sort(), ["note01", "note02"]); assert.equal(s.notes.find((n) => n.id === "note03").deleted, 10);
  assert.deepEqual(s.folders.map((f) => f.id), ["fold05"]);
  s = await act(notes, "save", { id: "note04", text: "In a folder from the start", folder: "fold05" });
  assert.equal(live(s).find((n) => n.id === "note04").folder, "fold05");
});

test("Recently deleted: a deleted note waits 30 days with its words, can be restored to its folder, deleted now, or emptied", async () => {
  let now = 100 * DAY; const c = context(), notes = new Notes(c, { now: () => now });
  await act(notes, "folderNew", { id: "fold01", name: "Trips" });
  for (const id of ["note01", "note02", "note03", "note04"]) await act(notes, "save", { id, text: `Words of ${id}`, folder: "fold01" });
  let s = await act(notes, "delete", { id: "note01" });
  assert.equal(live(s).length, 3); assert.equal(s.notes.find((n) => n.id === "note01").deleted, now);
  assert.equal(readFileSync(join(c.dir, "notes", "note01.md"), "utf8"), "Words of note01", "its words wait with it");
  await act(notes, "save", { id: "note01", text: "changed while deleted" });
  assert.equal((await text(notes, "note01")).text, "Words of note01", "a deleted note is not written to");
  s = await act(notes, "restore", { id: "note01" });
  assert.deepEqual([s.notes.find((n) => n.id === "note01").deleted, s.notes.find((n) => n.id === "note01").folder], [0, "fold01"]);
  // Its folder gone meanwhile: restored to All notes.
  await act(notes, "delete", { id: "note02" }); await act(notes, "folderDelete", { id: "fold01" });
  s = await act(notes, "restore", { id: "note02" });
  assert.equal(s.notes.find((n) => n.id === "note02").folder, "");
  // Delete now, for good; and only from the bin.
  await act(notes, "purge", { id: "note03" });
  assert.equal(notes.state().notes.some((n) => n.id === "note03"), true, "a note that is not deleted is not purged");
  await act(notes, "delete", { id: "note03" }); s = await act(notes, "purge", { id: "note03" });
  assert.equal(s.notes.some((n) => n.id === "note03"), false); assert.equal(existsSync(join(c.dir, "notes", "note03.md")), false);
  // 30 days: on the 29th it waits, after the 30th it is gone, with its file.
  await act(notes, "delete", { id: "note04" }); const at = now;
  now = at + 29 * DAY; assert.equal(new Notes(c, { now: () => now }).state().notes.some((n) => n.id === "note04"), true);
  now = at + 30 * DAY + 1; assert.equal(new Notes(c, { now: () => now }).state().notes.some((n) => n.id === "note04"), false);
  assert.equal(existsSync(join(c.dir, "notes", "note04.md")), false);
  // Empty now.
  await act(notes, "delete", { id: "note01" }); await act(notes, "delete", { id: "note02" });
  s = await act(notes, "empty");
  assert.deepEqual(s.notes, []); assert.deepEqual(readdirSync(join(c.dir, "notes")), ["index.json"]);
});

test("another window on the same computer sees what this one saved (they share the files, not memory)", async () => {
  const c = context(), a = new Notes(c, { now: () => 50 }), b = new Notes(c, { now: () => 60 });
  assert.deepEqual(b.state().notes, []);
  await act(a, "save", { id: "note01", text: "From the first window" });
  assert.deepEqual(live(b.state()).map((n) => n.title), ["From the first window"]);
  assert.equal((await text(b, "note01")).text, "From the first window");
  await act(b, "save", { id: "note01", text: "From the second" });
  assert.equal((await text(a, "note01")).text, "From the second"); assert.equal(live(a.state())[0].edited, 60);
});

test("every page with Home hears a change; the page that made it is not told twice", async () => {
  const notes = new Notes(context(), { now: () => 1 }), heard = { a: [], b: [] };
  const a = (m) => heard.a.push(m.type), b = (m) => heard.b.push(m.type);
  notes.onSaid(a); const off = notes.onSaid(b);
  notes.handle({ type: "homeNotesDo", op: "save", id: "note01", text: "Hello", by: "page-a" }, a); await notes.idle();
  assert.deepEqual(heard.a.filter((t) => t === "homeNotes").length, 1); assert.deepEqual(heard.b.filter((t) => t === "homeNotes").length, 1);
  assert.ok(heard.b.includes("homeNoteChanged"), "the other page hears which note changed (never its words)");
  off.dispose(); notes.handle({ type: "homeNotesDo", op: "pin", id: "note01", on: true }, a); await notes.idle();
  assert.equal(heard.b.filter((t) => t === "homeNotes").length, 1);
  assert.equal(notes.handle({ type: "homeCardsReady" }), false, "not a Notes message");
});

test("an editor that gives the extension no storage folder: no notes are kept, nothing is written, and nothing throws", async () => {
  const notes = new Notes({ globalState: { get: () => undefined, update: async () => {} }, secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} } });
  assert.deepEqual(notes.state().notes, []);
  assert.equal(notes.handle({ type: "homeNotesDo", op: "save", id: "note01", text: "nowhere to keep it" }), false);
});
