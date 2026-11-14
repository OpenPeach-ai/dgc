// Notes, step 5 (src/notes.ts): out of the card. Duplicate; copy a note's text (plain, or as Markdown); export a note as
// a .md file where the user chooses, and a folder as a folder of .md files; open a note in an editor tab. A locked note
// must be unlocked for all of them. The Save dialog, the clipboard and the tab are the editor's: stand-ins here.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { notesModule, context, cleanup, ask, act, seed } from "./support/notes-host.mjs";
import { FERRY } from "./support/notes-sample.mjs";

const { Notes } = await notesModule();
after(cleanup);
const NOTES = [{ id: "ferry1", text: FERRY, folder: "trips1", edited: 900, created: 100, pinned: true }, { id: "tide01", text: "Tide tables: the bay / north\nLow water 06:12", folder: "trips1", edited: 800 },
  { id: "tide02", text: "Tide tables: the bay / north\nA second note with the same name", folder: "trips1", edited: 700 }, { id: "seeds1", text: "Seeds for spring\nTomatoes, basil", edited: 600 }, { id: "gone01", text: "Deleted one\nnot exported", folder: "trips1", edited: 500, deleted: 400, was: "trips1" }];
const made = async (more = {}) => { const calls = { clip: [], save: [], folder: [], tab: [] }, c = await seed(context(), { notes: NOTES, folders: [{ id: "trips1", name: "Trips" }] });
  const env = { clipboard: (text) => { calls.clip.push(text); }, saveFile: async (file) => { calls.save.push(file); return more.cancel ? false : true; }, saveFolder: async (out) => { calls.folder.push(out); return more.cancel ? undefined : out.name; }, openTab: (id) => { calls.tab.push(id); } };
  return { c, calls, notes: new Notes(c, { now: () => 5000, iterations: 1500, env }) }; };
const said = async (notes, op, more = {}) => (await ask(notes, { type: "homeNotesDo", op, ...more })).find((m) => m.type === "homeNotesSaid" && m.op === op);
const text = async (notes, id) => (await ask(notes, { type: "homeNotesDo", op: "open", id })).find((m) => m.type === "homeNoteText");

test("Duplicate: a second note with the same words, in the same folder, made now and not pinned; the first is untouched", async () => {
  const { c, notes } = await made();
  assert.deepEqual(await said(notes, "duplicate", { id: "ferry1", newId: "copy01" }), { type: "homeNotesSaid", op: "duplicate", ok: true, id: "copy01" });
  const s = notes.state(), copy = s.notes.find((n) => n.id === "copy01"), first = s.notes.find((n) => n.id === "ferry1");
  assert.deepEqual([copy.title, copy.folder, copy.pinned, copy.created, copy.edited, copy.locked], ["Ferry to Porto", "trips1", false, 5000, 5000, false]);
  assert.deepEqual([first.pinned, first.edited, first.created], [true, 900, 100]);
  assert.equal(readFileSync(join(c.dir, "notes", "copy01.md"), "utf8"), FERRY);
  assert.equal(s.notes.indexOf(copy), s.notes.indexOf(first) + 1 || s.notes.indexOf(copy), s.notes.indexOf(copy));
  for (const bad of [{ id: "ferry1", newId: "../x" }, { id: "ferry1", newId: "copy01" }, { id: "nosuch", newId: "copy02" }, { id: "gone01", newId: "copy03" }]) await said(notes, "duplicate", bad);
  assert.equal(notes.state().notes.length, 6, "an id that is taken or is not one, and a note that is deleted or not there, make no copy");
});

test("Copy: the note's words to the clipboard, as Markdown or as plain words with the marks taken out", async () => {
  const { calls, notes } = await made();
  assert.equal((await said(notes, "copy", { id: "ferry1", as: "md" })).ok, true);
  assert.equal(calls.clip[0], FERRY);
  await said(notes, "copy", { id: "ferry1", as: "plain" });
  assert.equal(calls.clip[1], "Ferry to Porto\nLeaves from the north quay, not the old terminal. Be there 40 minutes early with the car.\nBefore we go\n[x] Book the 09:40\n[x] Check the car deck height\n[ ] Ask about bikes\n[ ] Print the tickets\nOn the day\n1. Fuel the evening before\n2. Leave by 07:30\n3. Coffee at the quay\n\n• Timetable: ferries.example/porto (https://ferries.example/porto)\n• Cabin 214, deck 5");
  await said(notes, "copy", { id: "nosuch" });
  assert.equal(calls.clip.length, 2);
});

test("Export a note: a .md file named by its title, where the user chooses in the system's Save dialog; cancelling writes nothing", async () => {
  const { calls, notes } = await made();
  assert.deepEqual(await said(notes, "export", { id: "tide01" }), { type: "homeNotesSaid", op: "export", ok: true, saved: true });
  assert.deepEqual(calls.save, [{ name: "Tide tables the bay north.md", text: NOTES[1].text, locked: false }], "a name a file can have: no slashes or colons");
  const cancelled = await made({ cancel: true });
  assert.deepEqual(await said(cancelled.notes, "export", { id: "tide01" }), { type: "homeNotesSaid", op: "export", ok: true, saved: false });
});

test("Export a folder: a folder of .md files, one a note, each name once; deleted notes are not in it; All notes exports every note", async () => {
  const { calls, notes } = await made();
  assert.deepEqual(await said(notes, "exportFolder", { folder: "trips1" }), { type: "homeNotesSaid", op: "exportFolder", ok: true, saved: 3, skipped: 0, where: "Trips" });
  assert.equal(calls.folder[0].name, "Trips"); assert.equal(calls.folder[0].locked, false);
  assert.deepEqual(calls.folder[0].files.map((f) => f.name), ["Ferry to Porto.md", "Tide tables the bay north.md", "Tide tables the bay north 2.md"]);
  assert.equal(calls.folder[0].files[0].text, FERRY);
  await said(notes, "exportFolder", { folder: "" });
  assert.deepEqual([calls.folder[1].name, calls.folder[1].files.length], ["All notes", 4]);
  await said(notes, "exportFolder", { folder: "nofold" }); assert.equal(calls.folder.length, 2);
});

test("a locked note is duplicated, copied and exported only while notes are unlocked; its copy is locked too, and its exported file is said not to be", async () => {
  const { c, calls, notes } = await made();
  await said(notes, "lockSet", { pin: "4821", id: "tide01" });
  assert.equal((await said(notes, "duplicate", { id: "tide01", newId: "copy01" })).ok, true);
  assert.equal(notes.state().notes.find((n) => n.id === "copy01").locked, true); assert.equal(existsSync(join(c.dir, "notes", "copy01.md")), false, "the copy's words are never written unencrypted");
  assert.equal((await text(notes, "copy01")).text, NOTES[1].text);
  await said(notes, "export", { id: "tide01" });
  assert.equal(calls.save[0].locked, true, "the Save dialog says the file will not be locked");
  await said(notes, "exportFolder", { folder: "trips1" });
  assert.deepEqual([calls.folder[0].files.length, calls.folder[0].locked], [4, true]);
  await act(notes, "lockNow");
  for (const [op, more] of [["duplicate", { id: "tide01", newId: "copy02" }], ["copy", { id: "tide01", as: "md" }], ["export", { id: "tide01" }], ["tab", { id: "tide01" }]]) assert.deepEqual([(await said(notes, op, more)).ok, (await said(notes, op, more)).why], [false, "locked"], op);
  assert.equal(calls.clip.length, 0); assert.equal(calls.save.length, 1); assert.deepEqual(calls.tab, []);
  assert.deepEqual(await said(notes, "exportFolder", { folder: "trips1" }), { type: "homeNotesSaid", op: "exportFolder", ok: true, saved: 2, skipped: 2, where: "Trips" }, "a folder exports what can be read, and says how many it left");
});

test("Open in an editor tab: the editor is asked for the note's tab (and only for a note there is)", async () => {
  const { calls, notes } = await made();
  await ask(notes, { type: "homeNotesDo", op: "tab", id: "ferry1" }); await ask(notes, { type: "homeNotesDo", op: "tab", id: "nosuch" }); await ask(notes, { type: "homeNotesDo", op: "tab", id: "gone01" });
  assert.deepEqual(calls.tab, ["ferry1"]);
});
