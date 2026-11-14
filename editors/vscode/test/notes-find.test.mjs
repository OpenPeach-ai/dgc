// Notes, step 2 (src/notes.ts): finding. A search over titles and words, in a folder or in all notes, that answers with
// the line the words are in; the order the list is in, and the folder shown, kept for the next time.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { notesModule, context, cleanup, ask, act, seed } from "./support/notes-host.mjs";

const { Notes } = await notesModule();
after(cleanup);
const NOTES = [
  { id: "note01", text: "Ferry to Porto\nLeaves from the **north quay**, not the old terminal.\n- [ ] Book the 09:40\n- [x] Check the car deck", folder: "fold01", edited: 900, pinned: true },
  { id: "note02", text: "Call the bank about the card\nthen book the ferry", edited: 800 },
  { id: "note03", text: "Tide tables for the bay\nLow water 06:12 on Saturday, by the ferry pier, and a long way round the headland to the north where the seals are on most mornings in the spring", folder: "fold01", edited: 700 },
  { id: "note04", text: "Seeds for spring\nTomatoes, basil, sweet peas", folder: "fold02", edited: 600 },
  { id: "note05", text: "Old ferry times\n07:10 and 09:40", edited: 500, deleted: 400, was: "fold01" }];
const FOLDERS = [{ id: "fold01", name: "Trips" }, { id: "fold02", name: "Home" }];
const find = async (notes, q, more = {}) => (await ask(notes, { type: "homeNotesDo", op: "search", q, seq: 7, ...more })).find((m) => m.type === "homeNotesFound");

test("search: titles and words, whatever their case; each row answers with the line the words are in, without its marks", async () => {
  const notes = new Notes(await seed(context(), { notes: NOTES, folders: FOLDERS }), { now: () => 1000 });
  let f = await find(notes, "FERRY");
  assert.equal(f.seq, 7); assert.equal(f.q, "FERRY");
  assert.deepEqual(f.rows.map((r) => r.id), ["note01", "note02", "note03"], "not the deleted one; in the list's own order of the files");
  assert.equal(f.rows[0].line, "", "found in the title: the row keeps its own line");
  assert.equal(f.rows[1].line, "then book the ferry");
  assert.match(f.rows[2].line, /ferry pier/); assert.ok(f.rows[2].line.length <= 121, "a long line is cut around the words"); assert.match(f.rows[2].line, /…/);
  f = await find(notes, "north quay");
  assert.deepEqual(f.rows.map((r) => [r.id, r.line]), [["note01", "Leaves from the north quay, not the old terminal."]], "the marks of bold are not in the way");
  f = await find(notes, "car deck"); assert.equal(f.rows[0].line, "Check the car deck");
  assert.deepEqual((await find(notes, "nothing like this")).rows, []);
  assert.deepEqual((await find(notes, "   ")).rows, [], "no words: nothing is searched");
});

test("search: in the folder you are in; all notes when asked", async () => {
  const notes = new Notes(await seed(context(), { notes: NOTES, folders: FOLDERS }), { now: () => 1000 });
  assert.deepEqual((await find(notes, "ferry", { folder: "fold01" })).rows.map((r) => r.id), ["note01", "note03"]);
  assert.deepEqual((await find(notes, "ferry", { folder: "fold02" })).rows, []);
  assert.deepEqual((await find(notes, "ferry", { folder: "" })).rows.map((r) => r.id), ["note01", "note02", "note03"]);
  assert.deepEqual((await find(notes, "ferry", { folder: "bin" })).rows.map((r) => r.id), ["note05"], "Recently deleted is searched only from inside it");
});

test("the order of the list and the folder shown are kept for the next time, and only ones there are", async () => {
  const c = await seed(context(), { notes: NOTES, folders: FOLDERS }), notes = new Notes(c, { now: () => 1000 });
  assert.equal(notes.state().sort, "edited"); assert.equal(notes.state().shown, "");
  await act(notes, "sort", { by: "title" }); await act(notes, "sort", { by: "colour" });
  await act(notes, "shown", { folder: "fold02" }); await act(notes, "shown", { folder: "nofold" });
  const again = new Notes(c).state();
  assert.equal(again.sort, "title"); assert.equal(again.shown, "fold02");
  assert.equal((await act(notes, "shown", { folder: "bin" })).shown, "bin");
  assert.equal((await act(notes, "shown", { folder: "" })).shown, "");
});
