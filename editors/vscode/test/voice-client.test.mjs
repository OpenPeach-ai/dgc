// Dictation's host side (src/voice.ts): the first press with no model opens Settings -> Voice; a press records with
// DGC Voice on the computer you're at; Stop sends the recording to `dgc serve` in pieces under a command's limit and
// waits for what it wrote down. The backend here answers as dgc/voice/service.py does, and checks what
// service.py checks: pieces in order, every one valid base64, the last one marked done.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "dgc-voice-client-"));
globalThis.__DGC_TEST_VSCODE = { commands: { executeCommand: () => Promise.reject(new Error("tests pass their own")) } };
const bundle = join(scratch, "voice.cjs");
await build({
  stdin: { contents: 'export * from "./src/voice";', resolveDir: root, loader: "ts" },
  bundle: true, format: "cjs", platform: "node", target: "node18", outfile: bundle, logLevel: "silent",
  plugins: [{ name: "test-vscode", setup(builder) {
    builder.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "test" }));
    builder.onLoad({ filter: /^vscode$/, namespace: "test" }, () => ({ contents: "module.exports = globalThis.__DGC_TEST_VSCODE;", loader: "js" }));
  } }],
});
const { VoiceClient, Dictation, ReadAloud, PIECE_BYTES, VOICE_EXTENSION, VOICE_READY, LEVEL_POLL_MS } = createRequire(import.meta.url)(bundle);
after(() => { delete globalThis.__DGC_TEST_VSCODE; rmSync(scratch, { recursive: true, force: true }); });

const MODELS = (installed) => [{ id: "moonshine-base-en", role: "dictation", installed }, { id: "kitten-mini-en", role: "read_aloud", installed: false }];

/** A `dgc serve` that answers voice_* as dgc/voice/service.py does. */
function world({ installed = true, chosen = "moonshine-base-en", voice = "", voiceInstalled = false, hears = "book a table for two", recorder, sendAnswer = "sent", remote = "", app = "Cursor", offer } = {}) {
  const w = { sent: [], settings: [], offered: [], executed: [], uploads: new Map(), client: null };
  const answer = (ev) => setTimeout(() => w.client.onEvent(ev), 5);
  w.client = new VoiceClient({
    send(cmd) {
      w.sent.push(cmd);
      if (sendAnswer !== "sent") return sendAnswer;
      assert.ok(JSON.stringify(cmd).length < 4 * 1024 * 1024, "every command inside the 4 MB a command may be");
      if (cmd.type === "voice_models") answer({ type: "voice_state", request_id: cmd.request_id, runtime: { installed },
        models: MODELS(installed).map((m) => m.role === "read_aloud" ? { ...m, installed: voiceInstalled } : m), dictation: chosen, read_aloud: voice });
      if (cmd.type === "voice_transcribe") {
        const up = w.uploads.get(cmd.request_id) || { next: 0, bytes: 0 };
        assert.equal(cmd.part, up.next, "pieces in order");
        assert.match(cmd.audio, /^[A-Za-z0-9+/]*={0,2}$/);
        up.next++; up.bytes += Buffer.from(cmd.audio, "base64").length;
        w.uploads.set(cmd.request_id, up);
        if (cmd.done) answer(hears === null ? { type: "voice_error", request_id: cmd.request_id, message: "The model couldn't load.", code: "" }
                                            : { type: "voice_text", request_id: cmd.request_id, text: ` ${hears} ` });
      }
      return "sent";
    },
    openSettings: (section) => w.settings.push(section),
    offerInstall: (message) => { w.offered.push(message); return offer?.(message); },
    where: () => ({ remote, app }),
    execute: async (command) => {
      w.executed.push(command);
      if (!recorder) throw new Error(`command '${command}' not found`);
      return recorder(command);
    },
  });
  return w;
}

const speech = (seconds) => Buffer.alloc(seconds * 16000 * 2, 7);

test("no dictation model yet: the first press opens Settings -> Voice, and records nothing", async () => {
  for (const shape of [{ installed: false }, { chosen: "" }]) {
    const w = world({ ...shape, recorder: () => ({ ok: true }) });
    const result = await w.client.start();
    assert.equal(result.ok, false);
    assert.equal(result.code, "no_model");
    assert.match(result.error, /Settings → Voice/);
    assert.deepEqual(w.settings, ["voice"]);
    assert.deepEqual(w.executed, [], "the microphone isn't touched");
  }
});

test("a press records on the computer you're at; Stop sends it in pieces and gives back what was said", async () => {
  const pcm = speech(200);                 // 6.4 MB: four pieces of 2 MiB at most
  const w = world({ recorder: (command) => command === "dgcVoice.start" ? { ok: true, recorder: "mac" }
                                          : { ok: true, pcm: pcm.toString("base64"), rate: 16000, seconds: 200 } });
  assert.deepEqual(await w.client.start(), { ok: true });
  assert.deepEqual(w.executed, ["dgcVoice.start"]);
  assert.equal((await w.client.start()).code, "busy");
  const said = await w.client.stop("fr");
  assert.deepEqual(said, { ok: true, text: "book a table for two" });
  const pieces = w.sent.filter((c) => c.type === "voice_transcribe");
  assert.equal(pieces.length, 4);
  assert.ok(pieces.every((c) => Buffer.from(c.audio, "base64").length <= PIECE_BYTES));
  assert.deepEqual(pieces.map((c) => c.done), [false, false, false, true]);
  assert.ok(pieces.every((c) => c.request_id === pieces[0].request_id && c.language === "fr"));
  assert.equal(w.uploads.get(pieces[0].request_id).bytes, pcm.length, "every byte arrived");
  assert.equal((await w.client.stop()).code, "idle");
});

test("a short recording goes as one piece", async () => {
  const w = world({ recorder: (c) => c === "dgcVoice.start" ? { ok: true } : { ok: true, pcm: speech(3).toString("base64"), rate: 16000 } });
  await w.client.start();
  assert.equal((await w.client.stop()).text, "book a table for two");
  const pieces = w.sent.filter((c) => c.type === "voice_transcribe");
  assert.deepEqual(pieces.map((c) => [c.part, c.done]), [[0, true]]);
  assert.equal("language" in pieces[0], false, "no language: the model's own default");
});

test("no DGC Voice on this computer: it says so and offers to install it", async () => {
  const w = world({ recorder: null });
  const result = await w.client.start();
  assert.equal(result.code, "no_recorder");
  assert.match(result.error, /DGC Voice/);
  assert.equal(w.offered.length, 1);
  assert.match(w.offered[0], /isn't installed in Cursor yet/);
  assert.match(w.offered[0], /It comes with DGC/, "DGC carries it: no Marketplace needed");
  // The chat points to the notification instead of repeating it.
  assert.notEqual(result.error, w.offered[0]);
  assert.match(result.error, /from the notification/);
  // In a Remote SSH window the notification says the recording happens on this computer, not the host.
  const remote = world({ recorder: null, remote: "ssh-remote" });
  await remote.client.start();
  assert.match(remote.offered[0], /on this computer while DGC runs on the remote host/);
  assert.match(remote.offered[0], /isn't installed in Cursor on this computer/);
  assert.equal(VOICE_EXTENSION, "vibedgc.dgc-voice");
  assert.equal((await w.client.stop()).code, "idle", "nothing was recording");
});

test("what the recorder or the model says went wrong reaches the chat in its own words", async () => {
  const mute = world({ recorder: (c) => c === "dgcVoice.start" ? { ok: false, code: "record_failed", error: "No microphone was found on this computer." } : null });
  assert.deepEqual(await mute.client.start(), { ok: false, code: "record_failed", error: "No microphone was found on this computer." });

  const silent = world({ recorder: (c) => c === "dgcVoice.start" ? { ok: true } : { ok: false, code: "silent", error: "The recording was silent." } });
  await silent.client.start();
  assert.deepEqual(await silent.client.stop(), { ok: false, code: "silent", error: "The recording was silent." });
  assert.equal(silent.sent.filter((c) => c.type === "voice_transcribe").length, 0, "nothing sent for nothing heard");

  const broken = world({ hears: null, recorder: (c) => c === "dgcVoice.start" ? { ok: true } : { ok: true, pcm: speech(1).toString("base64") } });
  await broken.client.start();
  assert.deepEqual(await broken.client.stop(), { ok: false, code: "failed", error: "The model couldn't load." });

  const old = world({ sendAnswer: "old_cli", recorder: () => ({ ok: true }) });
  assert.deepEqual(await old.client.start(), { ok: false, code: "old_cli", error: "Update the DGC CLI to use voice." });
  const starting = world({ sendAnswer: "starting", recorder: () => ({ ok: true }) });
  assert.equal((await starting.client.start()).code, "starting");
});

test("cancel drops the recording: DGC Voice is told, and nothing goes to DGC", async () => {
  const w = world({ recorder: (c) => (c === "dgcVoice.cancel" ? { ok: true } : { ok: true }) });
  await w.client.start();
  await w.client.cancel();
  assert.deepEqual(w.executed, ["dgcVoice.start", "dgcVoice.cancel"]);
  assert.equal(w.sent.filter((c) => c.type === "voice_transcribe").length, 0);
  assert.equal((await w.client.start()).ok, true, "and a new recording can start");
});

test("only its own answers: another request's voice events pass by", () => {
  const w = world();
  assert.equal(w.client.onEvent({ type: "voice_state", request_id: "settings-voice-3" }), false);
  assert.equal(w.client.onEvent({ type: "voice_progress", id: "moonshine-base-en", stage: "download" }), false);
  assert.equal(w.client.onEvent({ type: "voice_text", request_id: "voice-dictate-nope" }), false);
});

// ---- Dictation: every box in the window, one microphone -------------------------------------------------------

/** A box: what dictation tells its page. */
const box = (name) => ({ name, said: [], post(message) { this.said.push(message); } });
const until = async (check, ms = 3000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 10)); } };

test("one box records at a time; another is told so; the one recording hears its levels about every 100 ms", async () => {
  let reading = 0;
  const w = world({ recorder: (command) => command === "dgcVoice.level" ? { ok: true, recording: true, levels: [0.1 + (reading++ % 3) / 100, 0.12] }
                                          : command === "dgcVoice.start" ? { ok: true } : { ok: true, pcm: speech(2).toString("base64") } });
  const dictation = new Dictation(w.client);
  const chat = box("chat"), pips = box("pips");
  await dictation.handle(chat, { type: "micStart" });
  assert.deepEqual(chat.said, [{ type: "mic", state: "recording" }]);
  await dictation.handle(pips, { type: "micStart" });
  assert.deepEqual(pips.said, [{ type: "mic", state: "idle", error: "Another chat is recording: stop it there first." }]);
  await until(() => chat.said.filter((m) => m.type === "micLevels").length >= 3, LEVEL_POLL_MS * 10);
  const levels = chat.said.filter((m) => m.type === "micLevels");
  assert.ok(levels.every((m) => m.levels.length === 2 && m.levels.every((v) => v > 0.09 && v < 0.2)), JSON.stringify(levels));
  assert.equal(pips.said.filter((m) => m.type === "micLevels").length, 0, "only the box that records hears levels");

  // Stop, to send: writing, then the words, with the mode the page asked for.
  await dictation.handle(chat, { type: "micStop", mode: "send" });
  const tail = chat.said.filter((m) => m.type === "mic").slice(-2);
  assert.deepEqual(tail, [{ type: "mic", state: "writing", mode: "send" }, { type: "mic", state: "idle", text: "book a table for two", mode: "send" }]);
  const quiet = chat.said.length;
  await new Promise((r) => setTimeout(r, LEVEL_POLL_MS * 3));
  assert.equal(chat.said.length, quiet, "no levels once it stopped");
  // The microphone is free again.
  await dictation.handle(pips, { type: "micStart" });
  assert.deepEqual(pips.said.at(-1), { type: "mic", state: "recording" });
  await dictation.handle(pips, { type: "micStop" });
  assert.equal(pips.said.at(-1).mode, "insert", "Stop without a mode puts the words in the box");
  dictation.dispose();
});

test("DGC Voice installed from the notification: the box that pressed says it's ready, and the next press records", async () => {
  const NEEDS = { type: "mic", state: "idle", error: "Dictation needs DGC Voice. Install it from the notification, then press the microphone again.", kind: "error" };
  let installed = false, finish;
  const w = world({ recorder: (command) => {
    if (!installed) throw new Error(`command '${command}' not found`);
    return command === "dgcVoice.start" ? { ok: true } : { ok: true, pcm: speech(1).toString("base64") };
  }, offer: () => new Promise((resolve) => { finish = resolve; }) });
  const dictation = new Dictation(w.client);
  const chat = box("chat");
  await dictation.handle(chat, { type: "micStart" });
  assert.deepEqual(chat.said, [NEEDS]);
  assert.equal(w.offered.length, 1, "the notification offers to install it");
  installed = true;
  finish(true);                                   // installed, and dgcVoice.status answered
  await until(() => chat.said.length === 2);
  assert.deepEqual(chat.said[1], { type: "mic", state: "idle", error: VOICE_READY, kind: "info" });
  assert.equal(VOICE_READY, "DGC Voice is installed. Press the microphone to dictate.");
  await dictation.handle(chat, { type: "micStart" });
  assert.deepEqual(chat.said.at(-1), { type: "mic", state: "recording" }, "no reload: the next press records");
  await dictation.handle(chat, { type: "micStop" });
  assert.equal(chat.said.at(-1).text, "book a table for two");

  // Dismissed, or the install failed (its own notification said why): the box says nothing more.
  const dismissed = world({ recorder: null, offer: async () => false }), page = box("page");
  await new Dictation(dismissed.client).handle(page, { type: "micStart" });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(page.said, [NEEDS]);

  // Recording again by the time the install answers: the recording isn't interrupted.
  let ready;
  installed = false;
  const again = world({ recorder: (command) => { if (!installed) throw new Error("not found"); return { ok: true }; },
                        offer: () => new Promise((resolve) => { ready = resolve; }) });
  const d3 = new Dictation(again.client), pips = box("pips");
  await d3.handle(pips, { type: "micStart" });
  installed = true;
  await d3.handle(pips, { type: "micStart" });
  ready(true);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(pips.said.slice(1), [{ type: "mic", state: "recording" }], "no idle note over a recording");
  d3.dispose();
  dictation.dispose();
});

test("cancel, a page that went away, and a DGC Voice too old to say how loud it is", async () => {
  const w = world({ recorder: (command) => { if (command === "dgcVoice.level") throw new Error("command 'dgcVoice.level' not found"); return { ok: true }; } });
  const dictation = new Dictation(w.client);
  const chat = box("chat");
  await dictation.handle(chat, { type: "micStart" });
  await new Promise((r) => setTimeout(r, LEVEL_POLL_MS * 3));
  assert.equal(chat.said.filter((m) => m.type === "micLevels").length, 0, "no levels, and no failure: the waveform just stays flat");
  await dictation.handle(chat, { type: "micCancel" });
  assert.deepEqual(chat.said.at(-1), { type: "mic", state: "idle" });
  assert.ok(w.executed.includes("dgcVoice.cancel"));

  // A page that reloads while it records: its recording is dropped, and the microphone is free.
  await dictation.handle(chat, { type: "micStart" });
  assert.equal(dictation.isRecording(chat), true);
  dictation.release(chat);
  assert.equal(dictation.isRecording(), false);
  await new Promise((r) => setImmediate(r));
  assert.equal(w.executed.filter((c) => c === "dgcVoice.cancel").length, 2);
  dictation.release(box("other"));   // a box that wasn't recording: nothing happens
  assert.equal(w.executed.filter((c) => c === "dgcVoice.cancel").length, 2);

  // No model: the page is told as information (Settings -> Voice opened); nothing records.
  const none = world({ installed: false, recorder: () => ({ ok: true }) });
  const d2 = new Dictation(none.client), page = box("page");
  await d2.handle(page, { type: "micStart" });
  assert.equal(page.said.at(-1).kind, "info");
  assert.equal(d2.isRecording(), false);
  dictation.dispose(); d2.dispose();
});

// ---- ReadAloud: one reply at a time, its audio to the box that asked --------------------------------------------

test("read aloud: the audio goes to the box that asked, piece by piece; another reply stops the first; no voice opens Settings", async () => {
  const w = world();
  const reader = new ReadAloud(w.client);
  const chat = box("chat"), pips = box("pips");
  await reader.handle(chat, { type: "speakStart", id: "m1", text: "## Hello\n\nTwo sentences here." });
  const cmd = w.sent.at(-1);
  assert.equal(cmd.type, "voice_speak");
  assert.equal(cmd.text, "## Hello\n\nTwo sentences here.");
  assert.deepEqual(chat.said, [{ type: "speak", id: "m1", state: "loading" }]);
  w.client.onEvent({ type: "voice_audio", request_id: cmd.request_id, part: 0, audio: "AAAA", sample_rate: 24000, done: false });
  w.client.onEvent({ type: "voice_audio", request_id: cmd.request_id, part: 1, audio: "", sample_rate: 0, done: true });
  assert.deepEqual(chat.said.slice(1), [
    { type: "speakAudio", id: "m1", part: 0, audio: "AAAA", rate: 24000, done: false },
    { type: "speakAudio", id: "m1", part: 1, audio: "", rate: 0, done: true }]);
  assert.equal(reader.isReading(), false, "done: nothing is being read");

  // A second reply, from another box, while the first is still being read: the first stops, and is told.
  await reader.handle(chat, { type: "speakStart", id: "m2", text: "Long reply." });
  const first = w.sent.at(-1).request_id;
  await reader.handle(pips, { type: "speakStart", id: "p1", text: "Pip reply." });
  assert.deepEqual(w.sent.slice(-2).map((c) => [c.type, c.request_id === first]), [["voice_stop", true], ["voice_speak", false]]);
  assert.deepEqual(chat.said.at(-1), { type: "speak", id: "m2", state: "idle" });
  w.client.onEvent({ type: "voice_audio", request_id: first, part: 0, audio: "BBBB", sample_rate: 24000, done: false });
  assert.equal(chat.said.filter((m) => m.type === "speakAudio" && m.id === "m2").length, 0, "the stopped reply's late audio goes nowhere");

  // Stop from the box reading; a stop from another box does nothing.
  await reader.handle(chat, { type: "speakStop" });
  assert.equal(reader.isReading(pips), true);
  await reader.handle(pips, { type: "speakStop" });
  assert.equal(w.sent.at(-1).type, "voice_stop");
  assert.deepEqual(pips.said.at(-1), { type: "speak", id: "p1", state: "idle" });

  // No voice chosen: DGC's process says so; Settings -> Voice opens, and the box is told why, as information.
  await reader.handle(chat, { type: "speakStart", id: "m3", text: "Hello." });
  w.client.onEvent({ type: "voice_error", request_id: w.sent.at(-1).request_id, code: "no_model", message: "No voice model for reading aloud is installed yet." });
  assert.deepEqual(w.settings, ["voice"]);
  assert.equal(chat.said.at(-1).kind, "info");
  assert.match(chat.said.at(-1).error, /Settings → Voice/);

  // Nothing to read; a CLI without voice.
  await reader.handle(chat, { type: "speakStart", id: "m4", text: "   " });
  assert.match(chat.said.at(-1).error, /nothing to read/);
  const old = world({ sendAnswer: "old_cli" }), oldReader = new ReadAloud(old.client), page = box("p");
  await oldReader.handle(page, { type: "speakStart", id: "x", text: "Hi" });
  assert.equal(page.said.at(-1).error, "Update the DGC CLI to use voice.");

  // A box that went away: what it was reading stops, without a word to it.
  await reader.handle(chat, { type: "speakStart", id: "m5", text: "Hello again." });
  const said = chat.said.length;
  reader.release(chat);
  assert.equal(w.sent.at(-1).type, "voice_stop");
  assert.equal(chat.said.length, said);
});

test("voice mode's first question: a model to listen with and a voice to answer in; either missing opens Settings -> Voice", async () => {
  const both = world({ voice: "kitten-mini-en", voiceInstalled: true });
  const page = box("page");
  await new Dictation(both.client).handle(page, { type: "voiceCheck" });
  assert.deepEqual(page.said, [{ type: "voiceReady", dictation: true, readAloud: true }]);
  assert.deepEqual(both.settings, []);

  const noVoice = world({});
  const p2 = box("p2");
  await new Dictation(noVoice.client).handle(p2, { type: "voiceCheck" });
  assert.equal(p2.said[0].readAloud, false);
  assert.match(p2.said[0].message, /needs a voice for reading aloud/);
  assert.deepEqual(noVoice.settings, ["voice"]);

  const neither = world({ installed: false });
  const p3 = box("p3");
  await new Dictation(neither.client).handle(p3, { type: "voiceCheck" });
  assert.match(p3.said[0].message, /needs a dictation model and a voice/);

  const old = world({ sendAnswer: "old_cli" }), p4 = box("p4");
  await new Dictation(old.client).handle(p4, { type: "voiceCheck" });
  assert.deepEqual(p4.said[0], { type: "voiceReady", dictation: false, readAloud: false, message: "Update the DGC CLI to use voice." });
});
