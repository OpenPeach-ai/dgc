"""`dgc serve`'s voice commands (voice_*): Settings -> Voice models, dictation and reading aloud.

The process's, as ChatDGC is: the same models in every folder. Installing, listening and speaking run on threads of
their own, so a 475 MB download never holds up a chat. Dictation arrives as 16-bit mono PCM at 16 kHz, base64, in
numbered chunks (one command frame holds at most 4 MB); reading aloud goes back the same way, a sentence or two at a
time, so it starts playing before the whole reply is spoken.
"""

from __future__ import annotations

import base64
import binascii
import threading

from . import catalog
from .manager import PCM_RATE, VoiceError, VoiceManager

MAX_DICTATION_BYTES = 10 * 60 * PCM_RATE * 2     # ten minutes of speech
MAX_PENDING = 8                                  # dictations being uploaded at once


class VoiceService:
    def __init__(self, emit, config=None, manager: VoiceManager | None = None):
        self.emit = emit
        self.config = config
        self.manager = manager or VoiceManager()
        self._uploads: dict[str, dict] = {}       # request_id -> {next, chunks, size, language}
        self._speaking: dict[str, threading.Event] = {}
        self._lock = threading.Lock()

    def dispatch(self, cmd: dict) -> None:
        kind = cmd.get("type")
        rid = cmd.get("request_id") if isinstance(cmd.get("request_id"), str) else None
        try:
            handler = {"voice_models": self._models, "voice_install": self._install, "voice_cancel": self._cancel,
                       "voice_remove": self._remove, "voice_use": self._use, "voice_transcribe": self._transcribe,
                       "voice_speak": self._speak, "voice_stop": self._stop}.get(kind)
            if handler is None:
                return self._error(rid, f"unknown voice command: {kind}")
            handler(cmd)
        except VoiceError as exc:
            self._error(rid, str(exc), exc.code, cmd.get("id") if isinstance(cmd.get("id"), str) else "")

    def _error(self, rid, message: str, code: str = "", model_id: str = "") -> None:
        fields = {"message": message[:1000]}
        if rid:
            fields["request_id"] = rid
        if code:
            fields["code"] = code
        if model_id:
            fields["id"] = model_id
        self.emit("voice_error", **fields)

    def _state(self, rid: str | None = None) -> None:
        fields = self.manager.state()
        if rid:
            fields["request_id"] = rid
        self.emit("voice_state", **fields)

    # -- Settings -> Voice models

    def _models(self, cmd: dict) -> None:
        self._state(cmd["request_id"])

    def _install(self, cmd: dict) -> None:
        model_id, rid = cmd["id"], cmd["request_id"]
        if catalog.model(model_id) is None:
            raise VoiceError("There's no voice model by that name.")

        def progress(stage: str, done: int, total: int) -> None:
            self.emit("voice_progress", id=model_id, stage=stage, done=int(done), total=int(total))

        def run() -> None:
            try:
                self.manager.install(model_id, progress)
            except VoiceError as exc:
                self._error(rid, str(exc), exc.code or "install_failed", model_id)
            except Exception as exc:                  # noqa: BLE001 -- a thread that dies must say so
                self._error(rid, f"Installing failed: {exc}", "install_failed", model_id)
            self._state(rid)

        threading.Thread(target=run, daemon=True, name=f"dgc-voice-install-{model_id}").start()
        self._state(rid)

    def _cancel(self, cmd: dict) -> None:
        self.manager.cancel(cmd["id"])
        self._state(cmd["request_id"])

    def _remove(self, cmd: dict) -> None:
        self.manager.remove(cmd["id"])
        self._state(cmd["request_id"])

    def _use(self, cmd: dict) -> None:
        self.manager.use(cmd["role"], cmd["id"])
        self._state(cmd["request_id"])

    # -- dictation

    def _transcribe(self, cmd: dict) -> None:
        rid, seq = cmd["request_id"], int(cmd["part"])
        try:
            piece = base64.b64decode(cmd["audio"], validate=True) if cmd["audio"] else b""
        except (binascii.Error, ValueError):
            raise VoiceError("That recording couldn't be read.")
        with self._lock:
            upload = self._uploads.get(rid)
            if upload is None:
                if seq != 0:
                    raise VoiceError("That recording arrived out of order; record it again.")
                if len(self._uploads) >= MAX_PENDING:
                    raise VoiceError("Too many recordings at once.")
                upload = self._uploads[rid] = {"next": 0, "chunks": [], "size": 0,
                                               "language": str(cmd.get("language") or "auto")[:16]}
            if seq != upload["next"]:
                self._uploads.pop(rid, None)
                raise VoiceError("That recording arrived out of order; record it again.")
            upload["next"] += 1
            upload["size"] += len(piece)
            if upload["size"] > MAX_DICTATION_BYTES:
                self._uploads.pop(rid, None)
                raise VoiceError("That recording is longer than ten minutes; record a shorter one.")
            upload["chunks"].append(piece)
            if not cmd["done"]:
                return
            self._uploads.pop(rid, None)
        pcm = b"".join(upload["chunks"])

        def run() -> None:
            try:
                text = self.manager.transcribe(pcm, language=upload["language"])
                self.emit("voice_text", request_id=rid, text=text)
            except VoiceError as exc:
                self._error(rid, str(exc), exc.code)
            except Exception as exc:                  # noqa: BLE001
                self._error(rid, f"Dictation failed: {exc}")

        if not self.manager.choices()["dictation"]:     # nothing installed: said now, not on the thread
            raise VoiceError("No voice model for dictation is installed yet. Install one in Settings → Voice models.",
                             "no_model")
        threading.Thread(target=run, daemon=True, name=f"dgc-voice-listen-{rid}").start()

    # -- reading aloud

    def _speak(self, cmd: dict) -> None:
        rid = cmd["request_id"]
        if not self.manager.choices()["read_aloud"]:
            raise VoiceError("No voice model for reading aloud is installed yet. Install one in Settings → Voice "
                             "models.", "no_model")
        stop = threading.Event()
        with self._lock:
            self._speaking[rid] = stop

        def run() -> None:
            seq = 0
            try:
                for pcm, rate in self.manager.speak(cmd["text"], stop):
                    if stop.is_set():
                        break
                    # A sentence or two can be long: sent in pieces each well under a frame.
                    for at in range(0, len(pcm), 1 << 20):
                        self.emit("voice_audio", request_id=rid, part=seq, audio=base64.b64encode(pcm[at:at + (1 << 20)]).decode(),
                                  sample_rate=int(rate), done=False)
                        seq += 1
                self.emit("voice_audio", request_id=rid, part=seq, audio="", sample_rate=0, done=True)
            except VoiceError as exc:
                self._error(rid, str(exc), exc.code)
            except Exception as exc:                  # noqa: BLE001
                self._error(rid, f"Reading aloud failed: {exc}")
            finally:
                with self._lock:
                    self._speaking.pop(rid, None)

        threading.Thread(target=run, daemon=True, name=f"dgc-voice-speak-{rid}").start()

    def _stop(self, cmd: dict) -> None:
        with self._lock:
            stop = self._speaking.get(cmd["request_id"])
        if stop is not None:
            stop.set()

    def close(self) -> None:
        with self._lock:
            for stop in self._speaking.values():
                stop.set()
        self.manager.stop_worker()
