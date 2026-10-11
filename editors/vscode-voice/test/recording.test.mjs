// DGC Voice records on the computer you're at. These run the real recording.js against stand-in recorders --
// small node programs put on PATH under the names DGC looks for -- so starting one, stopping it (SIGINT on Linux,
// a ".stop" file on macOS and Windows), a recorder that can't record, and reading what it wrote are all real.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { Recorder, recorderFor, toPcm16kMono, RATE } = require("../recording.js");
const scratch = mkdtempSync(join(tmpdir(), "dgc-voice-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** A WAV file: `samples(i, channel)` in -1..1 for `seconds`, as integer PCM of `bits` or 32-bit float. */
function wav({ rate = RATE, channels = 1, bits = 16, float = false, seconds = 1, extensible = false, samples = (i) => Math.sin(i / 8) * 0.5, sizes = true }) {
  const frames = Math.round(rate * seconds), width = bits / 8;
  const data = Buffer.alloc(frames * channels * width);
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) {
    const v = samples(i, c), at = (i * channels + c) * width;
    if (float) data.writeFloatLE(v, at);
    else if (bits === 8) data.writeUInt8(Math.round(v * 127) + 128, at);
    else if (bits === 16) data.writeInt16LE(Math.round(v * 32767), at);
    else if (bits === 24) data.writeIntLE(Math.round(v * 8388607), at, 3);
    else data.writeInt32LE(Math.round(v * 2147483647), at);
  }
  const fmt = Buffer.alloc(extensible ? 40 : 16);
  fmt.writeUInt16LE(extensible ? 0xFFFE : float ? 3 : 1, 0);
  fmt.writeUInt16LE(channels, 2);
  fmt.writeUInt32LE(rate, 4);
  fmt.writeUInt32LE(rate * channels * width, 8);
  fmt.writeUInt16LE(channels * width, 12);
  fmt.writeUInt16LE(bits, 14);
  if (extensible) { fmt.writeUInt16LE(22, 16); fmt.writeUInt16LE(bits, 18); fmt.writeUInt16LE(float ? 3 : 1, 24); }
  const chunk = (id, body, size = body.length) => { const head = Buffer.alloc(8); head.write(id, 0, "ascii"); head.writeUInt32LE(size >>> 0, 4); return Buffer.concat([head, body]); };
  const list = chunk("LIST", Buffer.from("INFOxxxx"));   // a chunk a reader has to step over
  const body = Buffer.concat([Buffer.from("WAVE"), chunk("fmt ", fmt), list, chunk("data", data, sizes ? data.length : 0xFFFFFFFF)]);
  return Buffer.concat([chunk("RIFF", Buffer.alloc(0), sizes ? body.length : 0xFFFFFFFF).subarray(0, 8), body]);
}

const pcmOf = (result) => Buffer.from(result.pcm, "base64");

test("a 16 kHz mono 16-bit recording comes through sample for sample", () => {
  const file = wav({ seconds: 0.5 });
  const { pcm, seconds } = toPcm16kMono(file);
  assert.equal(seconds, 0.5);
  assert.equal(pcm.length, 16000);
  assert.deepEqual(pcm, file.subarray(file.length - 16000));
});

test("other rates, channel counts and sample formats become 16 kHz mono", () => {
  const tone = (rate) => (i) => Math.sin(2 * Math.PI * 440 * i / rate) * 0.5;
  for (const shape of [
    { rate: 48000, channels: 2, float: true, bits: 32 },
    { rate: 44100, channels: 2, bits: 16 },
    { rate: 44100, channels: 1, bits: 24, extensible: true },
    { rate: 22050, channels: 1, bits: 8 },
    { rate: 8000, channels: 1, bits: 32 },
  ]) {
    const { pcm, seconds } = toPcm16kMono(wav({ ...shape, seconds: 1, samples: tone(shape.rate) }));
    assert.ok(Math.abs(seconds - 1) < 0.001, `${JSON.stringify(shape)}: ${seconds}s`);
    // The same 440 Hz tone at half scale, at 16 kHz: compare a stretch of it with the exact one.
    let worst = 0;
    for (let i = 100; i < 15000; i++) worst = Math.max(worst, Math.abs(pcm.readInt16LE(i * 2) / 32767 - Math.sin(2 * Math.PI * 440 * i / 16000) * 0.5));
    assert.ok(worst < (shape.bits === 8 ? 0.03 : 0.02), `${JSON.stringify(shape)} is off by ${worst}`);
  }
});

test("stereo is averaged, not one side kept", () => {
  const { pcm } = toPcm16kMono(wav({ channels: 2, seconds: 0.1, samples: (_i, c) => (c ? 0.5 : -0.1) }));
  assert.ok(Math.abs(pcm.readInt16LE(200) / 32767 - 0.2) < 0.001);
});

test("a recorder stopped before it wrote the sizes still gives its audio", () => {
  const { seconds } = toPcm16kMono(wav({ seconds: 0.75, sizes: false }));
  assert.equal(seconds, 0.75);
});

test("what isn't a WAV is refused, plainly", () => {
  assert.throws(() => toPcm16kMono(Buffer.from("ID3 an mp3")), /not a WAV/);
  assert.throws(() => toPcm16kMono(Buffer.concat([Buffer.from("RIFF\0\0\0\0WAVE")])), /no audio/);
});

test("each system records with what it already has", () => {
  const scripts = "/ext/recorders";
  const mac = recorderFor("/t/a.wav", { platform: "darwin", env: {}, scripts });
  assert.equal(mac.command, "/usr/bin/osascript");
  assert.deepEqual(mac.args, ["-l", "JavaScript", "/ext/recorders/record-mac.js", "/t/a.wav"]);
  assert.equal(mac.stopFile, true);
  const win = recorderFor("C:\\t\\a.wav", { platform: "win32", env: {}, scripts });
  assert.equal(win.command, "powershell.exe");
  assert.ok(win.args.includes("/ext/recorders/record-win.ps1") && win.args.at(-1) === "C:\\t\\a.wav" && win.stopFile);
  for (const file of ["recorders/record-mac.js", "recorders/record-win.ps1"]) assert.ok(existsSync(join(root, file)), file);

  const bins = mkdtempSync(join(scratch, "bin-"));
  const only = (...names) => {
    const dir = mkdtempSync(join(bins, "p-"));
    for (const name of names) { writeFileSync(join(dir, name), "#!/bin/sh\n"); chmodSync(join(dir, name), 0o755); }
    return { PATH: dir };
  };
  assert.equal(recorderFor("/t/a.wav", { platform: "linux", env: only("arecord", "pw-record") }).kind, "arecord");
  const pw = recorderFor("/t/a.wav", { platform: "linux", env: only("pw-record", "parecord") });
  assert.equal(pw.kind, "pw-record");
  assert.ok(pw.args.includes("--rate") && pw.args.at(-1) === "/t/a.wav");
  assert.equal(recorderFor("/t/a.wav", { platform: "linux", env: only("parecord") }).kind, "parecord");
  assert.equal(recorderFor("/t/a.wav", { platform: "linux", env: only() }), null);
  assert.equal(recorderFor("/t/a.wav", { platform: "linux", env: { ...only(), DGC_VOICE_FAKE_RECORDING: "/x.wav" } }).kind, "fake");
});

// ---- real processes -------------------------------------------------------------------------------------------

/** A directory on PATH holding stand-ins named `names`, each running `program` (a node script) with the same args. */
function standIn(names, program) {
  const dir = mkdtempSync(join(scratch, "fake-"));
  writeFileSync(join(dir, "program.cjs"), program);
  for (const name of names) {
    writeFileSync(join(dir, name), `#!/bin/sh\nexec "${process.execPath}" "${join(dir, "program.cjs")}" "$@"\n`);
    chmodSync(join(dir, name), 0o755);
  }
  return { ...process.env, PATH: [dir, dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter), DGC_VOICE_FAKE_RECORDING: "" };
}

const WAV_HEADER = `
function header(rate, channels, bits) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(0xFFFFFFFF, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * channels * bits / 8, 28);
  h.writeUInt16LE(channels * bits / 8, 32); h.writeUInt16LE(bits, 34); h.write('data', 36); h.writeUInt32LE(0xFFFFFFFF, 40);
  return h;
}
function tone(rate, channels, seconds, level) {
  const frames = Math.round(rate * seconds), b = Buffer.alloc(frames * channels * 2);
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) b.writeInt16LE(Math.round(Math.sin(i / 6) * level), (i * channels + c) * 2);
  return b;
}
`;

// arecord on Linux: writes as it goes, sizes unknown, until SIGINT.
const ARECORD = `${WAV_HEADER}
const fs = require('fs');
const out = process.argv.at(-1), level = Number(process.env.FAKE_LEVEL ?? 8000);
fs.writeFileSync(out, header(16000, 1, 16));
const timer = setInterval(() => fs.appendFileSync(out, tone(16000, 1, 0.05, level)), 50);
fs.writeFileSync(out + '.args', JSON.stringify(process.argv.slice(2)));
process.on('SIGINT', () => { clearInterval(timer); process.exit(0); });
`;

test("Linux: arecord runs until DGC stops it, and the recording comes back as 16 kHz PCM", async () => {
  const env = standIn(["arecord"], ARECORD);
  const recorder = new Recorder({ platform: "linux", env });
  assert.deepEqual(await recorder.start(), { ok: true, recorder: "arecord" });
  assert.equal(recorder.status().recording, true);
  assert.equal((await recorder.start()).code, "busy");
  await new Promise((r) => setTimeout(r, 600));
  const dir = recorder.current.dir;
  const args = JSON.parse(readFileSync(recorder.current.out + ".args", "utf8"));
  assert.deepEqual(args.slice(0, 8), ["-q", "-f", "S16_LE", "-r", "16000", "-c", "1", "-t"]);
  const result = await recorder.stop();
  assert.equal(result.ok, true, result.error);
  assert.equal(result.rate, 16000);
  assert.ok(result.seconds > 0.9 && result.seconds < 3, `${result.seconds}s`);
  assert.equal(pcmOf(result).length, Math.round(result.seconds * 16000) * 2);
  assert.ok(pcmOf(result).some((byte) => byte !== 0));
  assert.equal(existsSync(dir), false, "nothing is kept once the recording is handed over");
  assert.equal((await recorder.stop()).code, "idle");
});

test("a recorder that can't record says why at once, in words a person can act on", async () => {
  const env = standIn(["arecord"], `process.stderr.write('arecord: main:831: audio open error: No such file or directory\\n'); process.exit(1);`);
  const recorder = new Recorder({ platform: "linux", env });
  const result = await recorder.start();
  assert.deepEqual(result, { ok: false, code: "record_failed", error: "No microphone was found on this computer." });
  assert.equal(recorder.current, null);

  const nothing = new Recorder({ platform: "linux", env: { PATH: mkdtempSync(join(scratch, "empty-")) } });
  const none = await nothing.start();
  assert.equal(none.code, "no_recorder");
  assert.match(none.error, /alsa-utils|PipeWire/);
  assert.equal(nothing.status().ok, false);
});

test("a digitally silent recording is the system withholding the microphone, not speech", async () => {
  const env = { ...standIn(["arecord"], ARECORD), FAKE_LEVEL: "0" };
  const recorder = new Recorder({ platform: "linux", env });
  assert.equal((await recorder.start()).ok, true);
  await new Promise((r) => setTimeout(r, 600));
  const result = await recorder.stop();
  assert.equal(result.code, "silent");
  assert.match(result.error, /muted/);

  // On a Mac that's what a refused microphone gives: say where to allow it.
  const zeros = join(scratch, "zeros.wav");
  writeFileSync(zeros, wav({ seconds: 1, samples: () => 0 }));
  const mac = new Recorder({ platform: "darwin", env: { DGC_VOICE_FAKE_RECORDING: zeros } });
  await mac.start();
  const refused = await mac.stop();
  assert.equal(refused.code, "silent");
  assert.match(refused.error, /Privacy & Security → Microphone/);

  // A short tap is not judged: too little to tell.
  writeFileSync(zeros, wav({ seconds: 0.3, samples: () => 0 }));
  await mac.start();
  assert.equal((await mac.stop()).ok, true);
});

// macOS and Windows: the script records until a file named after the recording plus ".stop" appears, then saves.
const STOP_FILE = `${WAV_HEADER}
const fs = require('fs');
const out = process.argv.at(-1);
const wait = setInterval(() => {
  if (!fs.existsSync(out + '.stop')) return;
  clearInterval(wait);
  const audio = tone(44100, 2, 1.5, 6000), h = header(44100, 2, 16);
  h.writeUInt32LE(36 + audio.length, 4); h.writeUInt32LE(audio.length, 40);
  fs.writeFileSync(out, Buffer.concat([h, audio]));
}, 20);
`;

test("Windows-style: the recorder stops on the .stop file, and 44.1 kHz stereo comes back as 16 kHz mono", async () => {
  const env = standIn(["powershell.exe"], STOP_FILE);
  const recorder = new Recorder({ platform: "win32", env, scripts: join(root, "recorders") });
  assert.deepEqual(await recorder.start(), { ok: true, recorder: "windows" });
  const result = await recorder.stop();
  assert.equal(result.ok, true, result.error);
  assert.ok(Math.abs(result.seconds - 1.5) < 0.001, `${result.seconds}s`);
});

test("cancel stops the recorder and keeps nothing", async () => {
  const env = standIn(["arecord"], ARECORD);
  const recorder = new Recorder({ platform: "linux", env });
  assert.equal((await recorder.start()).ok, true);
  const { child, dir } = recorder.current;
  assert.deepEqual(recorder.cancel(), { ok: true });
  assert.equal(recorder.current, null);
  await new Promise((r) => child.exitCode !== null ? r() : child.on("close", r));
  await new Promise((r) => setTimeout(r, 3700));
  assert.equal(existsSync(dir), false);
  assert.equal((await recorder.start()).ok, true, "a new recording can start after a cancel");
  recorder.cancel();
});

test("DGC_VOICE_FAKE_RECORDING stands in for a microphone", async () => {
  const file = join(scratch, "speech.wav");
  writeFileSync(file, wav({ rate: 48000, seconds: 2 }));
  const recorder = new Recorder({ platform: "linux", env: { DGC_VOICE_FAKE_RECORDING: file } });
  assert.equal(recorder.status().recorder, "fake");
  assert.deepEqual(await recorder.start(), { ok: true, recorder: "fake" });
  const result = await recorder.stop();
  assert.equal(result.seconds, 2);
  assert.equal(existsSync(file), true, "the stand-in file is the tester's: it's left alone");
});

test("the extension runs on the computer you're at, offers its four commands, and hides them from the palette", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.deepEqual(pkg.extensionKind, ["ui"]);
  const names = ["dgcVoice.start", "dgcVoice.stop", "dgcVoice.cancel", "dgcVoice.status"];
  assert.deepEqual(pkg.contributes.commands.map((c) => c.command).sort(), [...names].sort());
  assert.deepEqual(pkg.activationEvents.sort(), names.map((n) => `onCommand:${n}`).sort());
  assert.deepEqual(pkg.contributes.menus.commandPalette.map((m) => [m.command, m.when]).sort(), names.map((n) => [n, "false"]).sort());
  assert.ok(existsSync(join(root, pkg.main)) && existsSync(join(root, pkg.icon)));

  const registered = new Map();
  const vscode = { commands: { registerCommand: (name, run) => { registered.set(name, run); return { dispose() {} }; } } };
  const load = Module._load;
  Module._load = function (request, ...rest) { return request === "vscode" ? vscode : load.call(this, request, ...rest); };
  try {
    const context = { subscriptions: [], asAbsolutePath: (p) => join(root, p) };
    require("../extension.js").activate(context);
    assert.deepEqual([...registered.keys()].sort(), [...names].sort());
    assert.equal(registered.get("dgcVoice.status")().ok !== undefined, true);
    for (const item of context.subscriptions) item.dispose();
  } finally {
    Module._load = load;
  }
});
