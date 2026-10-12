// Dictation for DGC's chats: record on the computer you're at, transcribe on DGC's own process.
//
// A webview can't use the microphone, and in a Remote window this extension doesn't even run on the computer the
// microphone is on. So the recording is DGC Voice's (editors/vscode-voice), a small extension that runs beside the
// editor's window and answers dgcVoice.start / stop / cancel. What it hands back goes to `dgc serve` in pieces
// (voice_transcribe), and the model the user chose in Settings -> Voice writes it down (voice_text).
import * as vscode from "vscode";

/** DGC Voice's id on the Marketplace and Open VSX, and its commands. */
export const VOICE_EXTENSION = "vibedgc.dgc-voice";
const START = "dgcVoice.start", STOP = "dgcVoice.stop", CANCEL = "dgcVoice.cancel", LEVEL = "dgcVoice.level";
/** How often the waveform asks how loud it is (each answer carries every ~50 ms reading since the last). */
export const LEVEL_POLL_MS = 100;
/** Raw PCM per voice_transcribe: as base64 it stays well inside a command's 4 MB. */
export const PIECE_BYTES = 2 * 1024 * 1024;
const STATE_TIMEOUT_MS = 15_000;
/** Long enough for ten minutes of speech on a slow machine; a dictation that never returns is dropped. */
const TEXT_TIMEOUT_MS = 5 * 60_000;

export type DictationResult =
  | { ok: true; text?: string }
  | { ok: false; code: "no_model" | "no_recorder" | "old_cli" | "starting" | "busy" | "idle" | "record_failed" | "silent" | "failed"; error: string };

export interface VoiceDeps {
  /** Sends a voice_* command on the side bar's `dgc serve`: "sent", "starting" while it comes up, "old_cli" without voice. */
  send(cmd: Record<string, unknown>): "sent" | "starting" | "old_cli";
  /** Settings at a section ("voice"). */
  openSettings(section: string): void;
  /** vscode.commands.executeCommand, and the editor's notifications (tests replace them). */
  execute?: (command: string, ...args: unknown[]) => Thenable<any>;
  offerInstall?: (message: string) => void;
}

interface Waiter { resolve(ev: any): void; timer: ReturnType<typeof setTimeout>; }

export class VoiceClient {
  private seq = 0;
  private readonly waiting = new Map<string, Waiter>();
  /** Reading aloud: each request's audio, as it comes (voice_audio, and a voice_error naming it). */
  private readonly streams = new Map<string, (ev: any) => void>();
  private recording = false;

  constructor(private readonly deps: VoiceDeps) {}

  private nextId(kind: string): string { return `voice-${kind}-${Date.now().toString(36)}-${++this.seq}`; }

  private execute(command: string): Thenable<any> {
    return (this.deps.execute ?? vscode.commands.executeCommand)(command);
  }

  /** Every voice_* event with a request id this client sent; true when it was one. */
  onEvent(ev: any): boolean {
    const id = typeof ev?.request_id === "string" ? ev.request_id : "";
    const stream = id ? this.streams.get(id) : undefined;
    if (stream && (ev?.type === "voice_audio" || ev?.type === "voice_error")) {
      if (ev.type === "voice_error" || ev.done === true) this.streams.delete(id);
      stream(ev);
      return true;
    }
    const waiter = id ? this.waiting.get(id) : undefined;
    if (!waiter || !["voice_state", "voice_text", "voice_error"].includes(ev?.type)) return false;
    this.waiting.delete(id);
    clearTimeout(waiter.timer);
    waiter.resolve(ev);
    return true;
  }

  /** Sends `cmd` and waits for its answer (or a voice_error naming it). */
  private ask(cmd: Record<string, unknown>, timeoutMs: number): Promise<any> | "starting" | "old_cli" {
    const requestId = String(cmd.request_id);
    const promise = new Promise<any>((resolve) => {
      const timer = setTimeout(() => { this.waiting.delete(requestId); resolve({ type: "voice_error", code: "timeout", message: "DGC didn't answer in time; try again." }); }, timeoutMs);
      this.waiting.set(requestId, { resolve, timer });
    });
    const sent = this.deps.send(cmd);
    if (sent !== "sent") {
      const waiter = this.waiting.get(requestId);
      if (waiter) { clearTimeout(waiter.timer); this.waiting.delete(requestId); }
      return sent;
    }
    return promise;
  }

  /** What's installed and chosen (voice_state), or why it can't be asked. */
  async models(): Promise<any> {
    const state = this.ask({ type: "voice_models", request_id: this.nextId("models") }, STATE_TIMEOUT_MS);
    if (state === "old_cli") return { error: "Update the DGC CLI to use voice." };
    if (state === "starting") return { error: "DGC is starting; try again in a moment." };
    const ev = await state;
    return ev?.type === "voice_state" ? ev : { error: String(ev?.message || "Voice isn't available.") };
  }

  /** Starts recording, or says why it can't: no dictation model yet opens Settings -> Voice to choose one. */
  async start(): Promise<DictationResult> {
    if (this.recording) return { ok: false, code: "busy", error: "Already recording." };
    const state = this.ask({ type: "voice_models", request_id: this.nextId("models") }, STATE_TIMEOUT_MS);
    if (state === "old_cli") return { ok: false, code: "old_cli", error: "Update the DGC CLI to use voice." };
    if (state === "starting") return { ok: false, code: "starting", error: "DGC is starting; try again in a moment." };
    const ev = await state;
    if (ev?.type !== "voice_state") return { ok: false, code: "failed", error: String(ev?.message || "Voice isn't available.") };
    const chosen = String(ev.dictation || "");
    const model = Array.isArray(ev.models) ? ev.models.find((m: any) => m?.id === chosen) : undefined;
    if (!chosen || !model?.installed) {
      this.deps.openSettings("voice");
      return { ok: false, code: "no_model", error: "Choose a dictation model in Settings → Voice, then press the microphone again." };
    }
    let started: any;
    try {
      started = await this.execute(START);
    } catch {
      const error = "Dictation records on the computer you're at, with the DGC Voice extension. Install it, then press the microphone again.";
      this.deps.offerInstall?.(error);
      return { ok: false, code: "no_recorder", error };
    }
    if (!started?.ok) return { ok: false, code: started?.code === "busy" ? "busy" : started?.code === "no_recorder" ? "no_recorder" : "record_failed", error: String(started?.error || "Recording didn't start.") };
    this.recording = true;
    return { ok: true };
  }

  /** Stops recording and writes down what was said. */
  async stop(language = ""): Promise<DictationResult> {
    if (!this.recording) return { ok: false, code: "idle", error: "Not recording." };
    this.recording = false;
    let recorded: any;
    try { recorded = await this.execute(STOP); } catch (error: any) { return { ok: false, code: "record_failed", error: String(error?.message || error) }; }
    if (!recorded?.ok) return { ok: false, code: recorded?.code === "silent" ? "silent" : "record_failed", error: String(recorded?.error || "The recording failed.") };
    const pcm = Buffer.from(String(recorded.pcm || ""), "base64");
    if (!pcm.length) return { ok: true, text: "" };
    const requestId = this.nextId("dictate");
    const pieces = Math.max(1, Math.ceil(pcm.length / PIECE_BYTES));
    let answer: Promise<any> | undefined;
    for (let part = 0; part < pieces; part++) {
      const cmd: Record<string, unknown> = { type: "voice_transcribe", request_id: requestId, part,
        audio: pcm.subarray(part * PIECE_BYTES, (part + 1) * PIECE_BYTES).toString("base64"), done: part === pieces - 1 };
      if (language) cmd.language = language;
      if (part < pieces - 1) {
        if (this.deps.send(cmd) !== "sent") return { ok: false, code: "failed", error: "DGC stopped while the recording was sent; record it again." };
        continue;
      }
      const sent = this.ask(cmd, TEXT_TIMEOUT_MS);
      if (typeof sent === "string") return { ok: false, code: "failed", error: "DGC stopped while the recording was sent; record it again." };
      answer = sent;
    }
    const ev = await answer!;
    if (ev?.type === "voice_text") return { ok: true, text: String(ev.text || "").trim() };
    if (ev?.code === "no_model") { this.deps.openSettings("voice"); return { ok: false, code: "no_model", error: String(ev.message || "") }; }
    return { ok: false, code: "failed", error: String(ev?.message || "That couldn't be written down.") };
  }

  /** How loud the microphone has been since the last ask (RMS 0..1, ~50 ms each); none from a DGC Voice without it. */
  async levels(): Promise<number[]> {
    if (!this.recording) return [];
    try {
      const answer = await this.execute(LEVEL);
      return Array.isArray(answer?.levels) ? answer.levels.filter((v: unknown) => typeof v === "number" && Number.isFinite(v)).slice(-200) : [];
    } catch {
      return [];
    }
  }

  /** Reads `text` aloud on DGC's process: `onAudio` hears each voice_audio (16-bit mono PCM, base64) and a
   *  voice_error naming it. Returns the request's id, or why it couldn't start. */
  speak(text: string, onAudio: (ev: any) => void): { requestId: string } | { error: "starting" | "old_cli" } {
    const requestId = this.nextId("speak");
    this.streams.set(requestId, onAudio);
    const sent = this.deps.send({ type: "voice_speak", request_id: requestId, text });
    if (sent !== "sent") { this.streams.delete(requestId); return { error: sent }; }
    return { requestId };
  }

  /** Stops reading `requestId` aloud: nothing more is made. */
  stopSpeaking(requestId: string): void {
    if (!this.streams.delete(requestId)) return;
    this.deps.send({ type: "voice_stop", request_id: requestId });
  }

  openSettings(section: string): void { this.deps.openSettings(section); }

  /** Drops the recording: nothing is kept or sent. */
  async cancel(): Promise<void> {
    if (!this.recording) return;
    this.recording = false;
    try { await this.execute(CANCEL); } catch { /* DGC Voice is gone: nothing is recording */ }
  }

  dispose(): void {
    void this.cancel();
    for (const [id, waiter] of this.waiting) { clearTimeout(waiter.timer); waiter.resolve({ type: "voice_error", code: "closed", message: "DGC closed." }); this.waiting.delete(id); }
  }
}

/** A message box that dictates: its page gets {type: "mic", ...} and {type: "micLevels", levels}. */
export interface DictationOwner {
  post(message: Record<string, unknown>): void;
}

/** What a box's page sends: micStart, micStop {mode: "insert" | "send"}, micCancel. */
export type MicMessage = { type: "micStart" } | { type: "micStop"; mode?: string } | { type: "micCancel" };
export const MIC_MESSAGES = ["micStart", "micStop", "micCancel", "voiceCheck"];

/**
 * Dictation for every message box in the window -- DGC's chats, ChatDGC's and Pips': one microphone, so one box
 * records at a time. While it records, its page hears how loud the microphone is (micLevels) for the waveform; when
 * it stops, what was said (mic idle + text), to put in the box or to send.
 */
export class Dictation {
  private owner?: DictationOwner;
  private poll?: ReturnType<typeof setInterval>;
  private asking = false;

  constructor(readonly client: VoiceClient) {}

  /** One of a page's mic messages, from the box `owner` speaks for. */
  async handle(owner: DictationOwner, message: any): Promise<void> {
    if (message?.type === "voiceCheck") return this.check(owner);
    if (message?.type === "micStart") return this.start(owner);
    if (message?.type === "micStop") return this.stop(owner, message.mode === "send" ? "send" : "insert");
    if (message?.type === "micCancel") return this.cancel(owner);
  }

  isRecording(owner?: DictationOwner): boolean { return owner ? this.owner === owner : !!this.owner; }

  /** Voice mode's first question: is there a model to write down what's said, and a voice to answer in? Either
   *  missing opens Settings -> Voice. */
  async check(owner: DictationOwner): Promise<void> {
    const state = await this.client.models();
    if ("error" in state) { owner.post({ type: "voiceReady", dictation: false, readAloud: false, message: state.error }); return; }
    const installed = (id: string) => !!id && state.models.some((m: any) => m?.id === id && m.installed);
    const dictation = installed(state.dictation), readAloud = installed(state.read_aloud);
    if (!dictation || !readAloud) this.client.openSettings("voice");
    owner.post({ type: "voiceReady", dictation, readAloud,
                 ...(dictation && readAloud ? {} : { message: `Voice mode needs ${!dictation && !readAloud ? "a dictation model and a voice" : !dictation ? "a dictation model" : "a voice for reading aloud"}: choose ${!dictation && !readAloud ? "them" : "one"} in Settings → Voice, then start voice mode again.` }) });
  }

  private async start(owner: DictationOwner): Promise<void> {
    if (this.owner) {
      owner.post({ type: "mic", state: this.owner === owner ? "recording" : "idle",
                   ...(this.owner === owner ? {} : { error: "Another chat is recording: stop it there first." }) });
      return;
    }
    this.owner = owner;
    const started = await this.client.start();
    if (this.owner !== owner) { if (started.ok) await this.client.cancel(); return; }   // cancelled while it started
    if (!started.ok) {
      this.owner = undefined;
      // No model yet: Settings -> Voice is open on the choice; the page says why, as information.
      owner.post({ type: "mic", state: "idle", error: started.error, kind: started.code === "no_model" ? "info" : "error" });
      return;
    }
    owner.post({ type: "mic", state: "recording" });
    this.poll = setInterval(() => { void this.levels(owner); }, LEVEL_POLL_MS);
  }

  private async levels(owner: DictationOwner): Promise<void> {
    if (this.asking || this.owner !== owner) return;
    this.asking = true;
    try {
      const levels = await this.client.levels();
      if (this.owner === owner && levels.length) owner.post({ type: "micLevels", levels });
    } finally {
      this.asking = false;
    }
  }

  private stopPolling(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = undefined;
  }

  private async stop(owner: DictationOwner, mode: "insert" | "send"): Promise<void> {
    if (this.owner !== owner) return;
    this.stopPolling();
    owner.post({ type: "mic", state: "writing", mode });
    const said = await this.client.stop();
    if (this.owner === owner) this.owner = undefined;
    owner.post(said.ok ? { type: "mic", state: "idle", text: said.text || "", mode }
                       : { type: "mic", state: "idle", error: said.error, kind: said.code === "no_model" ? "info" : "error" });
  }

  private async cancel(owner: DictationOwner): Promise<void> {
    if (this.owner === owner) {
      this.owner = undefined;
      this.stopPolling();
      await this.client.cancel();
    }
    owner.post({ type: "mic", state: "idle" });
  }

  /** A box that went away (its tab closed, its page reloaded): its recording goes with it, kept nowhere. */
  release(owner: DictationOwner): void {
    if (this.owner !== owner) return;
    this.owner = undefined;
    this.stopPolling();
    void this.client.cancel();
  }

  dispose(): void {
    this.stopPolling();
    this.owner = undefined;
    this.client.dispose();
  }
}

/** What a box's page sends to read a reply aloud: speakStart {id, text}, speakStop. */
export const SPEAK_MESSAGES = ["speakStart", "speakStop"];
/** The most of a reply read aloud (DGC's process reads the first 6,000 characters of it). */
const MAX_SPEAK_TEXT = 20_000;

/**
 * Reading aloud for every box in the window: one reply at a time, read by the voice Settings -> Voice chose. The
 * box's page gets {type: "speak", id, state} and the audio as it's made ({type: "speakAudio", id, audio, rate, done})
 * to play itself, so the sound comes from the computer you're at, as the waveform's microphone does.
 */
export class ReadAloud {
  private owner?: DictationOwner;
  private id = "";
  private requestId = "";

  constructor(private readonly client: VoiceClient) {}

  async handle(owner: DictationOwner, message: any): Promise<void> {
    if (message?.type === "speakStart") this.start(owner, String(message.id || "").slice(0, 200), String(message.text || ""));
    else if (message?.type === "speakStop") this.stop(owner);
  }

  isReading(owner?: DictationOwner): boolean { return owner ? this.owner === owner : !!this.owner; }

  private start(owner: DictationOwner, id: string, text: string): void {
    this.halt();                                   // one reply at a time: another stops
    if (!text.trim()) { owner.post({ type: "speak", id, state: "idle", error: "There's nothing to read in this reply." }); return; }
    this.owner = owner;
    this.id = id;
    owner.post({ type: "speak", id, state: "loading" });
    const started = this.client.speak(text.slice(0, MAX_SPEAK_TEXT), (ev) => {
      if (this.owner !== owner || this.id !== id) return;
      if (ev.type === "voice_error") {
        this.owner = undefined; this.requestId = "";
        if (ev.code === "no_model") {
          this.client.openSettings("voice");
          owner.post({ type: "speak", id, state: "idle", kind: "info",
                       error: "Choose a voice for reading aloud in Settings → Voice, then press Read aloud again." });
        } else owner.post({ type: "speak", id, state: "idle", error: String(ev.message || "Reading aloud failed.") });
        return;
      }
      owner.post({ type: "speakAudio", id, part: ev.part, audio: String(ev.audio || ""), rate: Number(ev.sample_rate) || 0, done: ev.done === true });
      if (ev.done === true) { this.owner = undefined; this.requestId = ""; }
    });
    if ("error" in started) {
      this.owner = undefined;
      owner.post({ type: "speak", id, state: "idle",
                   error: started.error === "old_cli" ? "Update the DGC CLI to use voice." : "DGC is starting; try again in a moment." });
      return;
    }
    this.requestId = started.requestId;
  }

  /** Stops what's being read, and tells the box that asked for it. */
  private halt(): void {
    const owner = this.owner, id = this.id;
    if (!owner) return;
    this.client.stopSpeaking(this.requestId);
    this.owner = undefined; this.requestId = "";
    owner.post({ type: "speak", id, state: "idle" });
  }

  private stop(owner: DictationOwner): void {
    if (this.owner === owner) this.halt();
  }

  /** A box that went away: what it was reading stops. */
  release(owner: DictationOwner): void {
    if (this.owner !== owner) return;
    this.client.stopSpeaking(this.requestId);
    this.owner = undefined; this.requestId = "";
  }
}
