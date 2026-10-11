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
const { VoiceClient, PIECE_BYTES, VOICE_EXTENSION } = createRequire(import.meta.url)(bundle);
after(() => { delete globalThis.__DGC_TEST_VSCODE; rmSync(scratch, { recursive: true, force: true }); });

const MODELS = (installed) => [{ id: "moonshine-base-en", role: "dictation", installed }, { id: "kitten-mini-en", role: "read_aloud", installed: false }];

/** A `dgc serve` that answers voice_* as dgc/voice/service.py does. */
function world({ installed = true, chosen = "moonshine-base-en", hears = "book a table for two", recorder, sendAnswer = "sent" } = {}) {
  const w = { sent: [], settings: [], offered: [], executed: [], uploads: new Map(), client: null };
  const answer = (ev) => setTimeout(() => w.client.onEvent(ev), 5);
  w.client = new VoiceClient({
    send(cmd) {
      w.sent.push(cmd);
      if (sendAnswer !== "sent") return sendAnswer;
      assert.ok(JSON.stringify(cmd).length < 4 * 1024 * 1024, "every command inside the 4 MB a command may be");
      if (cmd.type === "voice_models") answer({ type: "voice_state", request_id: cmd.request_id, runtime: { installed }, models: MODELS(installed), dictation: chosen, read_aloud: "" });
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
    offerInstall: (message) => w.offered.push(message),
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
