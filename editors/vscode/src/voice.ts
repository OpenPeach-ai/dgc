// Dictation for DGC's chats: record on the computer you're at, transcribe on DGC's own process.
//
// A webview can't use the microphone, and in a Remote window this extension doesn't even run on the computer the
// microphone is on. So the recording is DGC Voice's (editors/vscode-voice), a small extension that runs beside the
// editor's window and answers dgcVoice.start / stop / cancel. What it hands back goes to `dgc serve` in pieces
// (voice_transcribe), and the model the user chose in Settings -> Voice writes it down (voice_text).
import * as vscode from "vscode";

/** DGC Voice's id on the Marketplace and Open VSX, and its commands. */
export const VOICE_EXTENSION = "vibedgc.dgc-voice";
const START = "dgcVoice.start", STOP = "dgcVoice.stop", CANCEL = "dgcVoice.cancel";
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
  private recording = false;

  constructor(private readonly deps: VoiceDeps) {}

  private nextId(kind: string): string { return `voice-${kind}-${Date.now().toString(36)}-${++this.seq}`; }

  private execute(command: string): Thenable<any> {
    return (this.deps.execute ?? vscode.commands.executeCommand)(command);
  }

  /** Every voice_* event with a request id this client sent; true when it was one. */
  onEvent(ev: any): boolean {
    const id = typeof ev?.request_id === "string" ? ev.request_id : "";
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
