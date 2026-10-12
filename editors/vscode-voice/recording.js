'use strict';
// DGC Voice's recording, apart from VS Code (so it can be tested): which recorder this computer has, starting and
// stopping it, and turning what it wrote into what DGC takes -- 16-bit mono PCM at 16 kHz.
//
// The recorders are ones every system already has, so nothing is compiled or downloaded:
//   macOS    Apple's AVAudioRecorder, from a JavaScript for Automation script (recorders/record-mac.js)
//   Windows  the Windows audio API (winmm), from PowerShell (recorders/record-win.ps1)
//   Linux    arecord (ALSA), else pw-record (PipeWire), else parecord (PulseAudio)
// The two scripts stop when a file named after the recording plus ".stop" appears; the Linux ones on SIGINT.
// While it records, levels() hands over how loud the microphone is, about every 50 ms, for the waveform DGC draws:
// macOS's and Windows's scripts print "L <level>" lines; on Linux the recording file is read as it grows.
// DGC_VOICE_FAKE_RECORDING=<a .wav> makes "recording" return that file: for testing on a machine with no microphone.
// Its levels follow the file as if it were being spoken now.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RATE = 16000;
const MAX_SECONDS = 600;
/** One level reading per this much audio (and at most this many kept between two reads). */
const LEVEL_MS = 50;
const MAX_LEVELS = 200;

function which(command, env = process.env) {
    for (const dir of String(env.PATH || '').split(path.delimiter)) {
        if (!dir) continue;
        const file = path.join(dir, command);
        try { fs.accessSync(file, fs.constants.X_OK); return file; } catch { /* not here */ }
    }
    return null;
}

/** How to record into `out` here, or null when this computer has no recorder DGC can use. */
function recorderFor(out, { platform = process.platform, env = process.env, scripts } = {}) {
    if (env.DGC_VOICE_FAKE_RECORDING) return { kind: 'fake', file: env.DGC_VOICE_FAKE_RECORDING };
    if (platform === 'darwin') {
        return { kind: 'mac', command: '/usr/bin/osascript', args: ['-l', 'JavaScript', path.join(scripts, 'record-mac.js'), out], stopFile: true };
    }
    if (platform === 'win32') {
        return { kind: 'windows', command: 'powershell.exe',
                 args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(scripts, 'record-win.ps1'), out], stopFile: true };
    }
    const arecord = which('arecord', env);
    if (arecord) return { kind: 'arecord', command: arecord, args: ['-q', '-f', 'S16_LE', '-r', String(RATE), '-c', '1', '-t', 'wav', '-d', String(MAX_SECONDS), out] };
    const pw = which('pw-record', env);
    if (pw) return { kind: 'pw-record', command: pw, args: ['--rate', String(RATE), '--channels', '1', '--format', 's16', out] };
    const pa = which('parecord', env);
    if (pa) return { kind: 'parecord', command: pa, args: [`--rate=${RATE}`, '--channels=1', '--format=s16le', '--file-format=wav', out] };
    return null;
}

const NO_RECORDER = {
    linux: 'DGC Voice found no way to record here. Install alsa-utils (for arecord) or PipeWire, then try again.',
    other: 'DGC Voice can\'t record on this computer.',
};

const SILENT = {
    darwin: 'The recording was silent: your Mac didn\'t let the editor use the microphone. If it just asked, allow it and try again; otherwise turn it on in System Settings → Privacy & Security → Microphone.',
    other: 'The recording was silent: check that the microphone is on and not muted, then try again.',
};

function silent(pcm) {
    for (let i = 0; i + 1 < pcm.length; i += 2) if (pcm.readInt16LE(i) !== 0) return false;
    return true;
}

/** What a recorder that stopped at once was saying, in words a person can act on. */
function explain(how, stderr, code) {
    const said = String(stderr || '').trim().split('\n').slice(-2).join(' ').slice(0, 300);
    if (how.kind === 'mac' && /permission|not authorized|denied|-1006|TCC/i.test(said)) {
        return 'Your Mac didn\'t let the editor use the microphone. Allow it in System Settings → Privacy & Security → Microphone, then try again.';
    }
    if (/no such device|cannot find card|no microphone|audio open error|no capture/i.test(said)) {
        return 'No microphone was found on this computer.';
    }
    return `The recorder stopped at once${code !== null && code !== undefined ? ` (${code})` : ''}${said ? `: ${said}` : '.'}`;
}

/** A WAV file's samples as 16-bit mono PCM at 16 kHz (any channel count, rate, 8/16/24/32-bit or float). */
function toPcm16kMono(wav) {
    const buf = Buffer.isBuffer(wav) ? wav : Buffer.from(wav);
    if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
    let fmt = null, data = null;
    for (let at = 12; at + 8 <= buf.length;) {
        const id = buf.toString('ascii', at, at + 4);
        let size = buf.readUInt32LE(at + 4);
        const body = at + 8;
        if (id === 'data' && (size === 0 || size === 0xFFFFFFFF || body + size > buf.length)) size = buf.length - body;   // a recorder stopped before it wrote the size
        if (id === 'fmt ') {
            fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
            if (fmt.format === 0xFFFE && size >= 26) fmt.format = buf.readUInt16LE(body + 24);   // WAVE_FORMAT_EXTENSIBLE: its sub-format
        } else if (id === 'data') {
            data = buf.subarray(body, body + size);
        }
        at = body + size + (size & 1);
    }
    if (!fmt || !data) throw new Error('the WAV file has no audio in it');
    const { format, channels, rate, bits } = fmt;
    const width = bits / 8;
    if (!(channels >= 1) || !(rate > 0) || ![1, 2, 3, 4].includes(width) || ![1, 3].includes(format)) throw new Error(`unsupported WAV (${format}, ${bits}-bit)`);
    const frames = Math.floor(data.length / (width * channels));
    const mono = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < channels; c++) {
            const at = (i * channels + c) * width;
            let v;
            if (format === 3) v = width === 4 ? data.readFloatLE(at) : data.readDoubleLE(at);
            else if (width === 1) v = (data.readUInt8(at) - 128) / 128;
            else if (width === 2) v = data.readInt16LE(at) / 32768;
            else if (width === 3) v = data.readIntLE(at, 3) / 8388608;
            else v = data.readInt32LE(at) / 2147483648;
            sum += v;
        }
        mono[i] = sum / channels;
    }
    const outFrames = rate === RATE ? frames : Math.floor(frames * RATE / rate);
    const pcm = Buffer.alloc(outFrames * 2);
    for (let i = 0; i < outFrames; i++) {
        let v;
        if (rate === RATE) v = mono[i];
        else {
            const pos = i * rate / RATE, lo = Math.floor(pos), hi = Math.min(lo + 1, frames - 1), t = pos - lo;
            v = mono[lo] * (1 - t) + mono[hi] * t;
        }
        pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), i * 2);
    }
    return { pcm, seconds: outFrames / RATE };
}

/** The loudness (root mean square, 0..1) of each LEVEL_MS of 16-bit mono PCM at `rate`. */
function rmsLevels(pcm, rate = RATE) {
    const step = Math.max(2, Math.round(rate * LEVEL_MS / 1000) * 2), out = [];
    for (let at = 0; at + step <= pcm.length; at += step) {
        let sum = 0;
        for (let i = at; i < at + step; i += 2) { const v = pcm.readInt16LE(i) / 32768; sum += v * v; }
        out.push(Math.sqrt(sum / (step / 2)));
    }
    return out;
}

/** Where a WAV file's samples start (after its "data" header), or 44 when it hasn't been written yet. */
function dataOffset(head) {
    for (let at = 12; at + 8 <= head.length;) {
        const id = head.toString('ascii', at, at + 4), size = head.readUInt32LE(at + 4);
        if (id === 'data') return at + 8;
        at += 8 + size + (size & 1);
    }
    return 44;
}

/** One recording at a time. */
class Recorder {
    constructor({ scripts, platform, env } = {}) {
        this.scripts = scripts;
        this.platform = platform || process.platform;
        this.env = env || process.env;
        this.current = null;
    }

    status() {
        const how = recorderFor(path.join(os.tmpdir(), 'probe.wav'), { platform: this.platform, env: this.env, scripts: this.scripts });
        return { ok: Boolean(how), recorder: how ? how.kind : null, platform: this.platform, host: os.hostname(), recording: Boolean(this.current) };
    }

    async start() {
        if (this.current) return { ok: false, code: 'busy', error: 'DGC Voice is already recording.' };
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dgc-voice-'));
        const out = path.join(dir, 'speech.wav');
        const how = recorderFor(out, { platform: this.platform, env: this.env, scripts: this.scripts });
        if (!how) {
            fs.rmSync(dir, { recursive: true, force: true });
            return { ok: false, code: 'no_recorder', error: NO_RECORDER[this.platform] || NO_RECORDER.other };
        }
        const recording = { how, dir, out, started: Date.now(), stderr: '', levels: [], read: 0, pending: '' };
        if (how.kind === 'fake') {
            // Levels as the file would sound if it were being spoken now.
            try { recording.fakeLevels = rmsLevels(toPcm16kMono(fs.readFileSync(how.file)).pcm); } catch { recording.fakeLevels = []; }
        }
        if (how.kind !== 'fake') {
            let child;
            try {
                child = spawn(how.command, how.args, { env: this.env, stdio: ['ignore', how.stopFile ? 'pipe' : 'ignore', 'pipe'], windowsHide: true });
            } catch (error) {
                fs.rmSync(dir, { recursive: true, force: true });
                return { ok: false, code: 'record_failed', error: `The recorder couldn't start: ${error.message}` };
            }
            recording.child = child;
            child.stderr.on('data', (d) => { recording.stderr = (recording.stderr + d).slice(-4000); });
            // The macOS and Windows scripts say how loud it is: "L <level>" a line, 0..1.
            child.stdout?.on('data', (d) => {
                const lines = (recording.pending + d).split('\n');
                recording.pending = lines.pop().slice(-200);
                for (const line of lines) {
                    const m = /^L (\d+(?:\.\d+)?(?:e-?\d+)?)\s*$/.exec(line);
                    if (m) this.keep(recording, [Math.min(1, Number(m[1]))]);
                }
            });
            recording.exited = new Promise((resolve) => {
                child.on('error', (error) => { recording.stderr += String(error.message); resolve(-1); });
                child.on('close', (code) => resolve(code));
            });
            // A recorder that can't record (no microphone, no permission) stops at once: wait a moment for that.
            const early = await Promise.race([recording.exited.then((code) => ({ code })), new Promise((r) => setTimeout(() => r(null), 700))]);
            if (early) {
                fs.rmSync(dir, { recursive: true, force: true });
                return { ok: false, code: 'record_failed', error: explain(how, recording.stderr, early.code) };
            }
        }
        recording.limit = setTimeout(() => { if (this.current === recording) this.signal(recording); }, MAX_SECONDS * 1000);
        this.current = recording;
        return { ok: true, recorder: how.kind };
    }

    keep(recording, levels) {
        recording.levels.push(...levels);
        if (recording.levels.length > MAX_LEVELS) recording.levels.splice(0, recording.levels.length - MAX_LEVELS);
    }

    /** How loud the microphone has been since the last call: one reading (0..1) per ~50 ms. */
    levels() {
        const recording = this.current;
        if (!recording) return { ok: true, recording: false, levels: [] };
        const seconds = (Date.now() - recording.started) / 1000;
        if (recording.how.kind === 'fake') {
            // One reading per 50 ms since it started; past the end of the file it's quiet, as a room is when you stop.
            const due = Math.floor(seconds * 1000 / LEVEL_MS), fresh = [];
            for (let i = Math.max(recording.read, due - MAX_LEVELS); i < due; i++) fresh.push(recording.fakeLevels[i] ?? 0);
            recording.read = Math.max(recording.read, due);
            this.keep(recording, fresh);
        } else if (!recording.how.stopFile) {
            // Linux: the recorder writes as it goes, so what's new in the file is what was just heard.
            try {
                const fd = fs.openSync(recording.out, 'r');
                try {
                    const size = fs.fstatSync(fd).size;
                    if (!recording.read && size >= 44) {
                        const head = Buffer.alloc(Math.min(size, 512));
                        fs.readSync(fd, head, 0, head.length, 0);
                        recording.read = dataOffset(head);
                    }
                    const step = RATE * LEVEL_MS / 1000 * 2;
                    const whole = Math.floor(Math.max(0, size - recording.read) / step) * step;
                    if (whole > 0) {
                        const fresh = Buffer.alloc(Math.min(whole, step * MAX_LEVELS));
                        fs.readSync(fd, fresh, 0, fresh.length, recording.read + whole - fresh.length);
                        recording.read += whole;
                        this.keep(recording, rmsLevels(fresh));
                    }
                } finally { fs.closeSync(fd); }
            } catch { /* not written yet */ }
        }
        const levels = recording.levels.splice(0);
        return { ok: true, recording: true, seconds, levels: levels.map((v) => Math.round(v * 10000) / 10000) };
    }

    signal(recording) {
        if (recording.how.stopFile) fs.writeFileSync(recording.out + '.stop', '');
        else recording.child?.kill('SIGINT');
    }

    async stop() {
        const recording = this.current;
        if (!recording) return { ok: false, code: 'idle', error: 'DGC Voice isn\'t recording.' };
        this.current = null;
        clearTimeout(recording.limit);
        try {
            let wav;
            if (recording.how.kind === 'fake') wav = fs.readFileSync(recording.how.file);
            else {
                this.signal(recording);
                const ended = await Promise.race([recording.exited, new Promise((r) => setTimeout(() => r('timeout'), 8000))]);
                if (ended === 'timeout') recording.child.kill('SIGKILL');
                if (!fs.existsSync(recording.out)) return { ok: false, code: 'record_failed', error: explain(recording.how, recording.stderr, ended) };
                wav = fs.readFileSync(recording.out);
            }
            const { pcm, seconds } = toPcm16kMono(wav);
            // A room is never digitally silent; a microphone the system won't hand over is (macOS records zeros).
            if (seconds >= 0.5 && silent(pcm)) return { ok: false, code: 'silent', error: SILENT[this.platform] || SILENT.other };
            return { ok: true, pcm: pcm.toString('base64'), rate: RATE, seconds };
        } catch (error) {
            return { ok: false, code: 'record_failed', error: `The recording couldn't be read: ${error.message}` };
        } finally {
            fs.rmSync(recording.dir, { recursive: true, force: true });
        }
    }

    cancel() {
        const recording = this.current;
        this.current = null;
        if (!recording) return { ok: true };
        clearTimeout(recording.limit);
        if (recording.child && recording.child.exitCode === null) {
            this.signal(recording);
            setTimeout(() => { try { recording.child.kill('SIGKILL'); } catch { /* gone */ } }, 3000);
        }
        setTimeout(() => fs.rmSync(recording.dir, { recursive: true, force: true }), 3500);
        return { ok: true };
    }
}

module.exports = { Recorder, recorderFor, toPcm16kMono, rmsLevels, explain, RATE };
