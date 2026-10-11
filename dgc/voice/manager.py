"""Voice models on this computer: installed, chosen, and run (Settings -> Voice models).

Everything lives under ~/.dgc/voice: `runtime/` (a small environment with sherpa-onnx, made the first time a model is
installed), `models/<id>/` (one folder a model), `choices.json` (which model dictates and which reads aloud) and
`worker.log`. A model is downloaded from sherpa-onnx's releases, checked against its published SHA-256, unpacked
with no path that leaves its folder, and only then moved into place, so a half-done install is never used. The
models run in a worker of their own (worker.py on the runtime's Python), which keeps them loaded between requests.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import urllib.request
from pathlib import Path
from typing import Callable, Iterator

from . import catalog

WORKER = Path(__file__).with_name("worker.py")
MAX_SPEAK_CHARS = 6000          # read aloud: the first this many characters of a reply
CHUNK_CHARS = 320               # sentences are joined up to about this length, so speech starts soon
PCM_RATE = 16000                # dictation arrives as 16-bit mono PCM at this rate


class VoiceError(Exception):
    """Something the user can act on; `code` tells the screen what to offer (no_model opens Settings)."""

    def __init__(self, message: str, code: str = ""):
        super().__init__(message)
        self.code = code


def default_root() -> Path:
    from ..config import USER_HOME
    return USER_HOME / "voice"


def _runtime_python(runtime: Path) -> Path:
    return runtime / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def make_runtime(runtime: Path, log) -> None:
    """A fresh environment with the voice engine in it (sherpa-onnx and numpy, pinned, wheels only)."""
    if runtime.exists():
        shutil.rmtree(runtime)
    # stdin: never `dgc serve`'s own, which is the editor's command stream.
    subprocess.run([sys.executable, "-m", "venv", str(runtime)], check=True, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                   timeout=300)
    subprocess.run([str(_runtime_python(runtime)), "-m", "pip", "install", "--disable-pip-version-check", "--no-input",
                    "--only-binary=:all:", *catalog.RUNTIME["packages"]], check=True, stdin=subprocess.DEVNULL, stdout=log,
                   stderr=log, timeout=1800)


def fetch(url: str, target: Path, on_bytes: Callable[[int], None], cancel: threading.Event) -> None:
    """Download `url` to `target`, telling `on_bytes` each chunk's size."""
    request = urllib.request.Request(url, headers={"User-Agent": "dgc-voice"})
    with urllib.request.urlopen(request, timeout=60) as response, open(target, "wb") as out:
        while True:
            if cancel.is_set():
                raise VoiceError("Stopped.", "cancelled")
            chunk = response.read(1 << 20)
            if not chunk:
                return
            out.write(chunk)
            on_bytes(len(chunk))


def _safe_extract(archive: Path, into: Path) -> None:
    """Unpack a model's .tar.bz2, refusing anything that would land outside `into` or isn't a file or folder."""
    with tarfile.open(archive, "r:bz2") as tar:
        root = into.resolve()
        for member in tar.getmembers():
            target = (into / member.name).resolve()
            if not (member.isfile() or member.isdir()) or (target != root and root not in target.parents):
                raise VoiceError(f"The download holds something unsafe ({member.name}); it wasn't installed.")
        if sys.version_info >= (3, 12):
            tar.extractall(into, filter="data")
        else:                                         # pragma: no cover -- checked above, member by member
            tar.extractall(into)


def speakable(text: str) -> list[str]:
    """A reply as sentences to read: no code, links as their words, no citation numbers or Markdown marks."""
    text = str(text or "")[:MAX_SPEAK_CHARS * 2]
    text = re.sub(r"```.*?(```|$)", " ", text, flags=re.S)                 # code blocks aren't read
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", text)                       # pictures
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)                    # links: their words
    text = re.sub(r"\s*\[\d+(?:\s*,\s*\d+)*\]", "", text)                  # citations [1], [2, 3]
    text = re.sub(r"`([^`]*)`", r"\1", text)
    text = re.sub(r"^\s*\|.*\|\s*$", " ", text, flags=re.M)                 # table rows
    lines = []
    for line in text.splitlines():
        # A heading or a list item is a sentence of its own, so it doesn't run into the next.
        mark = re.match(r"^\s{0,3}(#{1,6}|[-*+]|\d+[.)])\s+(.*)$", line)
        body = mark.group(2).strip() if mark else line.strip()
        if mark and body and not re.search(r"[.!?:;]$", body):
            body += "."
        lines.append(body)
    text = "\n".join(lines)
    text = re.sub(r"[*_~>#]+", "", text)
    text = " ".join(text.split())[:MAX_SPEAK_CHARS]
    sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", text) if s.strip()]
    chunks: list[str] = []
    for sentence in sentences:
        if chunks and len(chunks[-1]) + len(sentence) < CHUNK_CHARS and not chunks[-1].endswith(("?", "!")):
            chunks[-1] += " " + sentence
        else:
            chunks.append(sentence)
    return chunks


class VoiceManager:
    def __init__(self, root: Path | None = None, *, runtime_maker=None, fetcher=None, python: str | None = None):
        self.root = Path(root) if root is not None else default_root()
        self._make_runtime = runtime_maker or make_runtime
        self._fetch = fetcher or fetch
        self._python = python                    # tests: run the worker on this Python instead of the runtime's
        self._lock = threading.Lock()            # choices and installs
        self._installs: dict[str, dict] = {}     # id -> {stage, done, total, cancel}
        self._worker: subprocess.Popen | None = None
        self._worker_lock = threading.Lock()     # one request at a time
        self._seq = 0

    # -- where things are

    @property
    def runtime(self) -> Path:
        return self.root / "runtime"

    def _model_dir(self, model_id: str) -> Path:
        return self.root / "models" / model_id

    def runtime_ready(self) -> bool:
        return bool(self._python) or (self.runtime / ".ready").is_file()

    def installed(self, model_id: str) -> bool:
        return (self._model_dir(model_id) / ".installed").is_file()

    def choices(self) -> dict:
        try:
            saved = json.loads((self.root / "choices.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            saved = {}
        chosen = {}
        for role in catalog.ROLES:
            pick = saved.get(role) if isinstance(saved, dict) else None
            if not (isinstance(pick, str) and self.installed(pick) and (catalog.model(pick) or {}).get("role") == role):
                # The one chosen is gone (removed, or never there): the first installed of that role, if any.
                pick = next((m["id"] for m in catalog.MODELS if m["role"] == role and self.installed(m["id"])), "")
            chosen[role] = pick
        return chosen

    def _save_choices(self, chosen: dict) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        tmp = self.root / "choices.json.tmp"
        tmp.write_text(json.dumps(chosen), encoding="utf-8")
        os.replace(tmp, self.root / "choices.json")

    def state(self) -> dict:
        chosen = self.choices()
        with self._lock:
            installing = {k: {"stage": v["stage"], "done": v["done"], "total": v["total"]} for k, v in self._installs.items()}
        models = []
        for m in catalog.MODELS:
            models.append({"id": m["id"], "role": m["role"], "name": m["name"], "summary": m["summary"],
                           "languages": m["languages"], "licence": m["licence"], "size": m["size"],
                           "installed": self.installed(m["id"]), "in_use": chosen[m["role"]] == m["id"],
                           "installing": installing.get(m["id"])})
        return {"runtime": {"installed": self.runtime_ready(), "size_mb": catalog.RUNTIME["size_mb"]},
                "models": models, "dictation": chosen["dictation"], "read_aloud": chosen["read_aloud"]}

    # -- installing

    def install(self, model_id: str, on_progress: Callable[[str, int, int], None]) -> None:
        """Install a model (and the runtime, the first time): downloaded, checked, unpacked, then put in place.
        Blocks; call it on a thread of its own. Raises VoiceError, which says what went wrong."""
        found = catalog.model(model_id)
        if found is None:
            raise VoiceError("There's no voice model by that name.")
        with self._lock:
            if model_id in self._installs:
                raise VoiceError(f"{found['name']} is already being installed.")
            job = self._installs[model_id] = {"stage": "starting", "done": 0, "total": found["size"],
                                              "cancel": threading.Event()}
        try:
            self._install(found, job, on_progress)
        finally:
            with self._lock:
                self._installs.pop(model_id, None)

    def _step(self, job, stage, done, total, on_progress) -> None:
        job.update(stage=stage, done=done, total=total)
        on_progress(stage, done, total)

    def _install(self, found: dict, job: dict, on_progress) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        if not self.runtime_ready():
            self._step(job, "runtime", 0, catalog.RUNTIME["size_mb"] << 20, on_progress)
            with open(self.root / "runtime.log", "w", encoding="utf-8") as log:
                try:
                    self._make_runtime(self.runtime, log)
                except Exception as exc:              # noqa: BLE001 -- said in words, with where to look
                    raise VoiceError(f"The voice engine couldn't be installed ({type(exc).__name__}); see "
                                     f"{self.root / 'runtime.log'}.") from exc
            (self.runtime / ".ready").write_text(" ".join(catalog.RUNTIME["packages"]), encoding="utf-8")
        downloads = self.root / "downloads"
        downloads.mkdir(exist_ok=True)
        archive = downloads / f"{found['id']}.tar.bz2.part"
        digest, got, last = hashlib.sha256(), [0], [0.0]

        def on_bytes(n: int) -> None:
            got[0] += n
            now = time.monotonic()
            if now - last[0] > 0.25 or got[0] >= found["size"]:
                last[0] = now
                self._step(job, "download", got[0], found["size"], on_progress)

        try:
            self._fetch(found["url"], archive, on_bytes, job["cancel"])
            self._step(job, "verify", got[0], found["size"], on_progress)
            with open(archive, "rb") as handle:
                for block in iter(lambda: handle.read(1 << 20), b""):
                    digest.update(block)
            if digest.hexdigest() != found["sha256"]:
                raise VoiceError(f"{found['name']} didn't download correctly (its checksum doesn't match); try again.")
            self._step(job, "unpack", got[0], found["size"], on_progress)
            staging = Path(tempfile.mkdtemp(prefix=f".{found['id']}-", dir=self.root))
            try:
                _safe_extract(archive, staging)
                unpacked = staging / found["folder"]
                missing = [f for f in found["files"].values() if not (unpacked / f).exists()]
                if missing:
                    raise VoiceError(f"{found['name']}'s download is missing {', '.join(missing)}; it wasn't installed.")
                (unpacked / ".installed").write_text(found["sha256"], encoding="utf-8")
                target = self._model_dir(found["id"])
                target.parent.mkdir(parents=True, exist_ok=True)
                if target.exists():
                    shutil.rmtree(target)
                os.replace(unpacked, target)
            finally:
                shutil.rmtree(staging, ignore_errors=True)
        except VoiceError:
            raise
        except Exception as exc:                      # noqa: BLE001 -- the network, the disk: said in words
            raise VoiceError(f"{found['name']} couldn't be installed: {exc}") from exc
        finally:
            archive.unlink(missing_ok=True)
        with self._lock:
            chosen = self.choices()
            if not chosen[found["role"]]:
                chosen[found["role"]] = found["id"]
            self._save_choices(chosen)
        self._step(job, "done", found["size"], found["size"], on_progress)

    def cancel(self, model_id: str) -> bool:
        with self._lock:
            job = self._installs.get(model_id)
        if job:
            job["cancel"].set()
        return bool(job)

    def remove(self, model_id: str) -> None:
        if catalog.model(model_id) is None:
            raise VoiceError("There's no voice model by that name.")
        self.stop_worker()                           # it may have the model loaded
        shutil.rmtree(self._model_dir(model_id), ignore_errors=True)
        with self._lock:
            self._save_choices(self.choices())

    def use(self, role: str, model_id: str) -> None:
        found = catalog.model(model_id)
        if role not in catalog.ROLES or found is None or found["role"] != role:
            raise VoiceError("That model can't do that.")
        if not self.installed(model_id):
            raise VoiceError(f"Install {found['name']} first.", "no_model")
        with self._lock:
            chosen = self.choices()
            chosen[role] = model_id
            self._save_choices(chosen)

    # -- running

    def _chosen(self, role: str) -> dict:
        pick = self.choices()[role]
        if not pick:
            what = "dictation" if role == "dictation" else "reading aloud"
            raise VoiceError(f"No voice model for {what} is installed yet. Install one in Settings → Voice models.",
                             "no_model")
        return catalog.model(pick)

    def _request(self, found: dict, extra: dict) -> dict:
        self._seq += 1
        return {"id": f"v{self._seq}", "engine": found["engine"], "dir": str(self._model_dir(found["id"])),
                "files": found["files"], **extra}

    def _start_worker(self) -> subprocess.Popen:
        if self._worker is not None and self._worker.poll() is None:
            return self._worker
        python = self._python or str(_runtime_python(self.runtime))
        if not Path(python).exists() and not self._python:
            raise VoiceError("The voice engine isn't installed. Install a model in Settings → Voice models.", "no_model")
        self.root.mkdir(parents=True, exist_ok=True)
        log = open(self.root / "worker.log", "a", encoding="utf-8")
        self._worker = subprocess.Popen([python, "-I", str(WORKER)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=log, text=True, bufsize=1, cwd=str(self.root))
        log.close()
        return self._worker

    def _ask(self, request: dict, on_chunk: Callable[[dict], None] | None = None, timeout: float = 300.0) -> dict:
        with self._worker_lock:
            worker = self._start_worker()
            worker.stdin.write(json.dumps(request) + "\n")
            worker.stdin.flush()
            deadline = time.monotonic() + timeout
            while True:
                line = worker.stdout.readline()
                if not line:
                    self._worker = None
                    raise VoiceError("The voice engine stopped; see " + str(self.root / "worker.log") + ".")
                try:
                    answer = json.loads(line)
                except ValueError:
                    continue
                if answer.get("id") != request["id"]:
                    continue
                if "chunk" in answer:
                    if on_chunk is not None:
                        on_chunk(answer)
                    if time.monotonic() > deadline:
                        raise VoiceError("Reading aloud took too long.")
                    continue
                if not answer.get("ok"):
                    raise VoiceError("The voice engine couldn't do that: " + str(answer.get("error") or "unknown"))
                return answer

    def transcribe(self, pcm: bytes, *, rate: int = PCM_RATE, language: str = "auto") -> str:
        """16-bit mono PCM -> the words in it."""
        found = self._chosen("dictation")
        if not pcm:
            return ""
        tmp = self.root / "tmp"
        tmp.mkdir(parents=True, exist_ok=True)
        handle, name = tempfile.mkstemp(suffix=".pcm", dir=tmp)
        try:
            with os.fdopen(handle, "wb") as out:
                out.write(pcm)
            return str(self._ask(self._request(found, {"op": "transcribe", "pcm": name, "rate": int(rate),
                                                       "language": language or "auto"}), timeout=180)["text"])
        finally:
            Path(name).unlink(missing_ok=True)

    def speak(self, text: str, stop: threading.Event | None = None) -> Iterator[tuple[bytes, int]]:
        """A reply, read aloud: (16-bit mono PCM, its rate) a sentence or two at a time, as they're ready."""
        found = self._chosen("read_aloud")
        chunks = speakable(text)
        if not chunks:
            return
        out = Path(tempfile.mkdtemp(prefix="speak-", dir=self._tmp()))
        made: list[tuple[str, int]] = []
        try:
            # One sentence-group a request, so stop is heard between them and the first is played soon.
            for part in chunks:
                if stop is not None and stop.is_set():
                    return
                self._ask(self._request(found, {"op": "speak", "text": [part], "out": str(out)}),
                          on_chunk=lambda answer: made.append((answer["chunk"], int(answer["rate"]))), timeout=120)
                while made:
                    file, rate = made.pop(0)
                    yield Path(file).read_bytes(), rate
                    Path(file).unlink(missing_ok=True)
        finally:
            shutil.rmtree(out, ignore_errors=True)

    def _tmp(self) -> Path:
        tmp = self.root / "tmp"
        tmp.mkdir(parents=True, exist_ok=True)
        return tmp

    def stop_worker(self) -> None:
        with self._worker_lock:
            worker, self._worker = self._worker, None
        if worker is not None and worker.poll() is None:
            try:
                worker.stdin.close()
                worker.wait(timeout=5)
            except Exception:                         # noqa: BLE001 -- it goes either way
                worker.kill()
