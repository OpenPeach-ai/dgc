// Notes, step 4 (src/notes.ts): the lock. A locked note is encrypted when it is saved (AES-256-GCM, a fresh nonce every
// save) with a random key; that key is kept in the system keychain (the editor's SecretStorage), itself wrapped with a
// key made from the PIN (PBKDF2, many rounds). 5 wrong tries, then waits that double up to an hour, counted across
// reloads; nothing is ever erased on its own. The keychain here is a stand-in; nothing touches a real one.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { notesModule, context, cleanup, ask, act, seed } from "./support/notes-host.mjs";

const { Notes, PBKDF2_ROUNDS } = await notesModule();
after(cleanup);
const SECRET = "The alarm code is on the blue card", NOTES = [{ id: "wifi01", text: `House Wi-Fi and the alarm\n${SECRET}\nGuest network: the one ending in 5G`, edited: 900 }, { id: "seeds1", text: "Seeds for spring\nTomatoes, basil, sweet peas", edited: 800 }, { id: "pass01", text: "Passport numbers\nKept in the blue folder", edited: 700 }];
const FAST = { iterations: 1500 };
const made = async (more = {}, c) => { c = c || await seed(context(undefined, more.context), { notes: NOTES }); return { c, notes: new Notes(c, { now: () => 1000, ...FAST, ...more }) }; };
const said = async (notes, op, more = {}) => (await ask(notes, { type: "homeNotesDo", op, ...more })).find((m) => m.type === "homeNotesSaid" && m.op === op);
const text = async (notes, id) => (await ask(notes, { type: "homeNotesDo", op: "open", id })).find((m) => m.type === "homeNoteText");
const lock = async (notes) => { await ask(notes, { type: "homeNotesDo", op: "get" }); return notes.state().lock; };

test("a PIN is 4 to 8 digits; the first lock makes a random key, kept in the keychain wrapped by the PIN, never the PIN itself", async () => {
  assert.ok(PBKDF2_ROUNDS >= 600000, "a high cost for each guess");
  const { c, notes } = await made();
  assert.deepEqual(await lock(notes), { state: "none", left: 5, until: 0, digits: 0 });
  for (const pin of ["123", "12a4", "123456789", "", 1234, null]) assert.equal((await said(notes, "lockSet", { pin, id: "wifi01" })).ok, false, `not a PIN: ${pin}`);
  assert.equal(c.secretsKept.size, 0);
  assert.equal((await said(notes, "lockSet", { pin: "4821", id: "wifi01" })).ok, true);
  assert.deepEqual(await lock(notes), { state: "unlocked", left: 5, until: 0, digits: 4 });
  const [name, kept] = [...c.secretsKept.entries()][0], record = JSON.parse(kept);
  assert.match(name, /^dgc\.notes\.lock/);
  assert.deepEqual(Object.keys(record).sort(), ["digits", "iter", "iv", "key", "salt", "v"]); assert.equal(record.iter, 1500);
  assert.equal(kept.includes("4821"), false, "the PIN is not kept");
  assert.equal(Buffer.from(record.key, "base64").length, 32 + 16, "the 256-bit key, encrypted with its tag");
  assert.equal(JSON.stringify([...c.kept.entries()]).includes("4821"), false);
  assert.equal((await said(notes, "lockSet", { pin: "9999" })).ok, false, "a PIN is chosen once; changing it asks for the old one");
});

test("a locked note is never on disk unencrypted: its file is ciphertext with a fresh nonce on every save; its title stays in the list, its row line does not", async () => {
  const { c, notes } = await made(), dir = join(c.dir, "notes");
  await said(notes, "lockSet", { pin: "4821", id: "wifi01" });
  assert.deepEqual(readdirSync(dir).sort(), ["index.json", "pass01.md", "seeds1.md", "wifi01.lock"], "the plain file is gone");
  const first = JSON.parse(readFileSync(join(dir, "wifi01.lock"), "utf8"));
  assert.deepEqual(Object.keys(first).sort(), ["ct", "iv", "v"]); assert.equal(Buffer.from(first.iv, "base64").length, 12);
  const everything = () => readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
  assert.equal(everything().includes("alarm code"), false); assert.equal(everything().includes("Guest network"), false);
  const row = notes.state().notes.find((n) => n.id === "wifi01");
  assert.deepEqual([row.locked, row.title, row.line], [true, "House Wi-Fi and the alarm", ""]);
  assert.equal((await text(notes, "wifi01")).text, NOTES[0].text, "while notes are unlocked it reads as it was");
  // Saved again with the same words: another nonce, another ciphertext.
  await act(notes, "save", { id: "wifi01", text: NOTES[0].text });
  const second = JSON.parse(readFileSync(join(dir, "wifi01.lock"), "utf8"));
  assert.notEqual(second.iv, first.iv); assert.notEqual(second.ct, first.ct);
  await act(notes, "save", { id: "wifi01", text: "New title for it\nand a new secret line" });
  assert.deepEqual([notes.state().notes.find((n) => n.id === "wifi01").title, notes.state().notes.find((n) => n.id === "wifi01").line], ["New title for it", ""]);
  assert.equal(everything().includes("new secret line"), false);
  // Another note locks with the same PIN (one PIN for all); a note's file cannot stand in for another's.
  assert.equal((await said(notes, "lockNote", { id: "pass01" })).ok, true);
  renameSync(join(dir, "pass01.lock"), join(dir, "swap")); renameSync(join(dir, "wifi01.lock"), join(dir, "pass01.lock")); renameSync(join(dir, "swap"), join(dir, "wifi01.lock"));
  assert.equal((await text(notes, "pass01")).ok, false, "a file moved under another note's name does not open");
});

test("locked again after a reload: its words are refused until the PIN is typed; a right PIN opens every locked note; Lock now closes them", async () => {
  const { c, notes } = await made();
  await said(notes, "lockSet", { pin: "482193", id: "wifi01" }); await said(notes, "lockNote", { id: "pass01" });
  const again = new Notes(c, { now: () => 2000, ...FAST }), heard = []; again.onSaid((m) => heard.push(JSON.stringify(m)));
  assert.deepEqual(await lock(again), { state: "locked", left: 5, until: 0, digits: 6 });
  assert.deepEqual(await text(again, "wifi01"), { type: "homeNoteText", id: "wifi01", ok: false, why: "locked" });
  assert.equal((await said(again, "save", { id: "wifi01", text: "overwritten?" })).why, "locked", "and it cannot be written over");
  assert.equal((await said(again, "lockNote", { id: "seeds1" })).why, "locked", "locking another note needs the PIN first");
  assert.equal((await said(again, "unlock", { pin: "482193" })).ok, true);
  assert.equal((await lock(again)).state, "unlocked");
  assert.equal((await text(again, "wifi01")).text, NOTES[0].text); assert.equal((await text(again, "pass01")).text, NOTES[2].text);
  await act(again, "lockNow");
  assert.equal((await lock(again)).state, "locked"); assert.equal((await text(again, "pass01")).ok, false);
  assert.equal(heard.some((m) => m.includes("alarm code") || m.includes("blue folder") || m.includes("482193")), false, "no other page ever hears a locked note's words, or a PIN");
});

test("wrong tries: 5, then a 30 second wait that doubles with each wrong try up to an hour; the count survives a reload; a right PIN clears it; nothing is erased", async () => {
  let now = 100000; const { c, notes } = await made({ now: () => now });
  await said(notes, "lockSet", { pin: "4821", id: "wifi01" }); await act(notes, "lockNow");
  const wrong = (n = notes) => said(n, "unlock", { pin: "0000" });
  for (const left of [4, 3, 2, 1]) assert.deepEqual(await wrong(), { type: "homeNotesSaid", op: "unlock", ok: false, why: "wrong", left, until: 0 });
  assert.deepEqual(await wrong(), { type: "homeNotesSaid", op: "unlock", ok: false, why: "wrong", left: 0, until: now + 30000 }, "the fifth: a 30 second wait");
  // While waiting: nothing is tried, right or wrong, and nothing is counted.
  assert.deepEqual(await said(notes, "unlock", { pin: "4821" }), { type: "homeNotesSaid", op: "unlock", ok: false, why: "wait", left: 0, until: now + 30000 });
  // A reload does not buy fresh tries.
  const reloaded = new Notes(c, { now: () => now, ...FAST });
  assert.deepEqual(await lock(reloaded), { state: "locked", left: 0, until: now + 30000, digits: 4 });
  assert.equal((await wrong(reloaded)).why, "wait");
  for (const wait of [60, 120, 240, 480, 960, 1920, 3600, 3600]) { now += 4000000; assert.equal((await wrong(reloaded)).until, now + wait * 1000, `then ${wait} s`); }
  // Thirteen wrong tries later every note is still there.
  assert.equal(existsSync(join(c.dir, "notes", "wifi01.lock")), true); assert.equal(reloaded.state().notes.length, 3);
  now += 4000000;
  assert.equal((await said(reloaded, "unlock", { pin: "4821" })).ok, true);
  assert.deepEqual(await lock(reloaded), { state: "unlocked", left: 5, until: 0, digits: 4 }, "a right PIN clears the count");
});

test("the lock taken off a note asks for the PIN; the PIN is changed with the old one; both keep every locked note readable", async () => {
  const { c, notes } = await made(), dir = join(c.dir, "notes");
  await said(notes, "lockSet", { pin: "4821", id: "wifi01" }); await said(notes, "lockNote", { id: "pass01" });
  assert.equal((await said(notes, "unlockNote", { id: "wifi01", pin: "1111" })).why, "wrong", "even while notes are unlocked");
  assert.equal(existsSync(join(dir, "wifi01.lock")), true);
  assert.equal((await said(notes, "unlockNote", { id: "wifi01", pin: "4821" })).ok, true);
  assert.equal(readFileSync(join(dir, "wifi01.md"), "utf8"), NOTES[0].text); assert.equal(existsSync(join(dir, "wifi01.lock")), false);
  const row = notes.state().notes.find((n) => n.id === "wifi01"); assert.deepEqual([row.locked, row.line], [false, `${SECRET} · Guest network: the one ending in 5G`]);
  // Change the PIN.
  assert.equal((await said(notes, "lockChange", { old: "0000", pin: "777777" })).why, "wrong");
  assert.equal((await said(notes, "lockChange", { old: "4821", pin: "77" })).ok, false);
  assert.equal((await said(notes, "lockChange", { old: "4821", pin: "777777" })).ok, true);
  const again = new Notes(c, { now: () => 5000, ...FAST });
  assert.equal((await lock(again)).digits, 6);
  assert.equal((await said(again, "unlock", { pin: "4821" })).why, "wrong"); assert.equal((await said(again, "unlock", { pin: "777777" })).ok, true);
  assert.equal((await text(again, "pass01")).text, NOTES[2].text, "the notes locked under the old PIN open with the new one");
});

test("Forgot PIN deletes the locked notes for good (they skip Recently deleted, and the ones waiting there go too), keeps every other note, and the next lock asks for a new PIN", async () => {
  const { c, notes } = await made(), dir = join(c.dir, "notes");
  await said(notes, "lockSet", { pin: "4821", id: "wifi01" }); await said(notes, "lockNote", { id: "pass01" });
  await act(notes, "delete", { id: "pass01" });
  assert.equal(notes.state().notes.find((n) => n.id === "pass01").locked, true, "a locked note stays locked while it waits in Recently deleted"); assert.equal(existsSync(join(dir, "pass01.lock")), true);
  await act(notes, "lockNow");
  assert.equal((await said(notes, "lockForgot", {})).ok, false, "only when it is asked for in so many words");
  assert.equal(notes.state().notes.length, 3);
  assert.deepEqual(await said(notes, "lockForgot", { sure: true }), { type: "homeNotesSaid", op: "lockForgot", ok: true, deleted: 2 });
  assert.deepEqual(notes.state().notes.map((n) => n.id), ["seeds1"]); assert.deepEqual(readdirSync(dir).sort(), ["index.json", "seeds1.md"]);
  assert.equal(c.secretsKept.size, 0); assert.deepEqual(await lock(notes), { state: "none", left: 5, until: 0, digits: 0 });
  assert.equal((await said(notes, "lockSet", { pin: "55555", id: "seeds1" })).ok, true);
  assert.equal((await lock(notes)).digits, 5);
});

test("a computer with no keychain locks nothing and says so; a copied folder without its key says the key is not here", async () => {
  const { c, notes } = await made({ context: { keychain: false } });
  assert.equal((await lock(notes)).state, "nokeychain");
  assert.deepEqual(await said(notes, "lockSet", { pin: "4821", id: "wifi01" }), { type: "homeNotesSaid", op: "lockSet", ok: false, why: "nokeychain" });
  assert.equal(existsSync(join(c.dir, "notes", "wifi01.md")), true); assert.equal(notes.state().notes.some((n) => n.locked), false);
  const weak = await made({ env: { weakKeychain: () => true } });
  assert.equal((await lock(weak.notes)).state, "nokeychain", "the editor's own weak fallback is no keychain either");
  // The notes folder copied to another computer: ciphertext, and no key.
  const here = await made(); await said(here.notes, "lockSet", { pin: "4821", id: "wifi01" });
  here.c.secretsKept.clear();
  const there = new Notes(here.c, { now: () => 1, ...FAST });
  assert.equal((await lock(there)).state, "nokey");
  assert.deepEqual(await said(there, "unlock", { pin: "4821" }), { type: "homeNotesSaid", op: "unlock", ok: false, why: "nokey" });
  assert.equal((await text(there, "wifi01")).ok, false);
});

test("notes lock again after 10 minutes without touching Notes; anything done in Notes keeps them open", async () => {
  const { Notes: N, IDLE_LOCK_MS } = await notesModule(); assert.equal(IDLE_LOCK_MS, 10 * 60000);
  const { notes } = await made({ idleMs: 120 });
  await said(notes, "lockSet", { pin: "4821", id: "wifi01" });
  for (let k = 0; k < 4; k++) { await new Promise((d) => setTimeout(d, 60)); await ask(notes, { type: "homeNotesDo", op: "touch" }); }
  assert.equal(notes.state().lock.state, "unlocked", "touched every 60 ms: still open after 240");
  const heard = []; notes.onSaid((m) => heard.push(m));
  await new Promise((d) => setTimeout(d, 220));
  assert.equal(notes.state().lock.state, "locked");
  assert.ok(heard.some((m) => m.type === "homeNotes" && m.lock.state === "locked"), "every page hears it");
  assert.equal((await text(notes, "wifi01")).ok, false);
  assert.ok(N);
});

test("search finds a locked note by its title; by its words only while notes are unlocked, and then says only that they are inside", async () => {
  const { notes } = await made();
  await said(notes, "lockSet", { pin: "4821", id: "wifi01" });
  const find = async (q) => (await ask(notes, { type: "homeNotesDo", op: "search", q, seq: 1 })).find((m) => m.type === "homeNotesFound").rows;
  assert.deepEqual(await find("alarm code"), [{ id: "wifi01", line: "", inside: true }]);
  await act(notes, "lockNow");
  assert.deepEqual(await find("alarm code"), []);
  assert.deepEqual(await find("wi-fi"), [{ id: "wifi01", line: "" }]);
});

test("Lock now in one window locks the others too, the next time anything is done in them; a note whose file is gone says so once", async () => {
  let now = 1000; const { c, notes } = await made({ now: () => now });
  await said(notes, "lockSet", { pin: "4821", id: "wifi01" });
  const other = new Notes(c, { now: () => now, ...FAST });
  now = 2000; assert.equal((await said(other, "unlock", { pin: "4821" })).ok, true);
  now = 3000; await act(notes, "lockNow");
  assert.deepEqual(await text(other, "wifi01"), { type: "homeNoteText", id: "wifi01", ok: false, why: "locked" }, "the other window does not go on reading");
  assert.equal(other.state().lock.state, "locked");
  now = 4000; assert.equal((await said(other, "unlock", { pin: "4821" })).ok, true); assert.equal((await text(other, "wifi01")).ok, true, "and opens again with the PIN");
  const { rmSync } = await import("node:fs"); rmSync(join(c.dir, "notes", "seeds1.md"));
  assert.deepEqual(await text(other, "seeds1"), { type: "homeNoteText", id: "seeds1", ok: false, why: "gone" });
});
