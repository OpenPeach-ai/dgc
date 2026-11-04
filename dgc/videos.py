"""Videos: the user's generators that make them, the long jobs that make them, and what a finished one leaves behind.

The video side of dgc/images.py, on the same generators, keys, spend and Library ideas:

- **Generators**: an ``images.generators`` row whose ``makes`` is "videos" (or "both"). A video model is its own
  generator on the same provider, so a fal video model uses the same saved fal key as a fal picture model
  (images.same_key). Its monthly limit is read against everything made on that key this month, pictures included.
- **Money**: every video asks before anything is sent (its card shows the length, resolution, price and this month's
  spend), unless the user turned that off for the generator in Settings (``video_asks``). Never an automatic fallback.
- **A job** (``~/.dgc/videos/jobs/<id>.json``): submitted, then polled in the background, then fetched. The record is
  on disk from the start, so a job outlives a window reload: the next DGC polls it again. One process polls a job
  at a time (a lock beside its record). Listeners (Work's chat, the editor, ChatDGC, a Pip) hear each change.
- **Files**: in DGC's own folder (``~/.dgc/videos/sessions/<session>/``, ``chats/<chat>/``, ``pips/<pip>/``) with a
  sidecar ``<name>.json`` (prompt, provider, model, seed, length, cost) and a poster frame when ffmpeg is there;
  into the project only with ``save_to`` (or Save to project…). Listed in ``~/.dgc/videos/library.jsonl``.
- **Size**: at most 300 MB a file (video_providers.VIDEO_MAX_BYTES says why).
"""
from __future__ import annotations

import contextlib
import json
import os
import re
import shutil
import struct
import subprocess
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from . import image_providers as P
from . import images
from . import video_providers as V
from .config import dgc_home

MAX_PROMPT = 4000
POLL_S = {"fal": 3.0, "gemini": 10.0, "replicate": 3.0, "comfyui": 2.0}
DEADLINE_S = 45 * 60
TERMINAL = ("done", "failed", "cancelled")
_LOCK = threading.Lock()


# ---- where things go -----------------------------------------------------------------------------------------------
def directory() -> Path:
    return dgc_home() / "videos"


def _safe(name: str, fallback: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "-", str(name or "")).strip("-.")[:80] or fallback


def session_folder(session: str) -> Path:
    return directory() / "sessions" / _safe(session, "work")


def chat_folder(chat_id: str) -> Path:
    return directory() / "chats" / _safe(chat_id, "chat")


def pip_folder(pip_id: str) -> Path:
    return directory() / "pips" / _safe(pip_id, "pip")


def jobs_dir() -> Path:
    folder = directory() / "jobs"
    folder.mkdir(parents=True, exist_ok=True)
    for path in (directory(), folder):
        try:
            path.chmod(0o700)
        except OSError:
            pass
    return folder


def own_video(raw: str) -> Path | None:
    """A video in DGC's own videos folder, by its path (one DGC made)."""
    try:
        path = Path(str(raw).strip()).expanduser().resolve(strict=False)
        path.relative_to(directory().resolve(strict=False))
    except (ValueError, OSError):
        return None
    return path if re.search(r"\.(mp4|webm|mov|webp|gif)\Z", path.name, re.I) else None


# ---- generators that make videos --------------------------------------------------------------------------------------
def generators(block: dict) -> list[dict]:
    return [g for g in block.get("generators") or [] if images.makes_videos(g)]


def model_of(generator: dict, model: str = "") -> str:
    return model or generator.get("model") or V.DEFAULT_MODELS.get(generator["provider"], "")


def info(generator: dict, model: str = "") -> dict:
    return V.model_info(generator["provider"], model_of(generator, model))


def label(generator: dict, model: str = "") -> str:
    """"fal Wan 2.2 5B": the provider's short name and the model's (a ComfyUI workflow: the generator's name)."""
    if generator["provider"] == "comfyui":
        return generator["name"]
    row = info(generator, model)
    short = {"fal": "fal", "gemini": "Gemini", "replicate": "Replicate", "comfyui": "ComfyUI"}.get(
        generator["provider"], generator["provider"])
    name = row.get("label") or images.model_words(model_of(generator, model))
    return f"{short} {name}".strip() if name and not name.lower().startswith(short.lower()) else (name or short)


def defaults(generator: dict, model: str = "") -> dict:
    row = info(generator, model)
    resolutions = row.get("resolutions") or ("720p",)
    return {"duration_s": int(row.get("default_duration") or 5),
            "resolution": "720p" if "720p" in resolutions else resolutions[0],
            "aspect": (row.get("aspects") or ("16:9",))[0]}


def price(generator: dict, *, duration_s: int, resolution: str, audio: bool | None = None, model: str = "") -> float | None:
    """DGC's estimate of one clip, in US dollars; 0 for a local server; None when DGC doesn't know."""
    if generator["provider"] == "comfyui":
        return 0.0
    row = info(generator, model)
    seconds = max(1, int(duration_s or row.get("default_duration") or 5))
    if row.get("per_clip") is not None:
        return round(float(row["per_clip"]), 4)
    if row.get("by_resolution_clip"):
        table = row["by_resolution_clip"]
        return round(float(table.get(resolution, max(table.values()))), 4)
    if row.get("by_resolution"):
        table = row["by_resolution"]
        return round(float(table.get(resolution, max(table.values()))) * seconds, 4)
    if row.get("per_second") is not None:
        return round(float(row["per_second"]) * seconds, 4)
    return None


def per_second_words(generator: dict) -> str:
    """Its price for video, in a line: "about $0.03/s ($0.15 a 5 s clip)", "free, local", "price unknown"."""
    if generator["provider"] == "comfyui":
        return "free, on your own computer"
    row = info(generator)
    base = defaults(generator)
    clip = price(generator, duration_s=base["duration_s"], resolution=base["resolution"])
    if clip is None:
        return "price unknown"
    each = clip / max(1, base["duration_s"])
    return f"about {rate(each)}/s ({images.dollars(clip)} a {base['duration_s']} s clip at {base['resolution']})" \
        if not row.get("by_resolution") else "about " + ", ".join(
            f"{rate(v)}/s at {k}" for k, v in row["by_resolution"].items())


def rate(value: float) -> str:
    """$0.03, $0.045, $0.15: a price per second with the cents it has."""
    text = f"{float(value):.3f}"
    return "$" + (text[:-1] if text.endswith("0") else text)


def minutes_words(generator: dict, model: str = "") -> str:
    low, high = info(generator, model).get("minutes") or (1, 5)
    return f"about {low}–{high} min" if high > low else f"about {low} min"


def describe_video(generator: dict) -> dict:
    """What a video generator can do, as list_video_generators and Settings show it (inside its status row)."""
    row = info(generator)
    base = defaults(generator)
    out = {"model": model_of(generator), "label": label(generator), "durations": list(row.get("durations") or ()),
           "default_duration_s": base["duration_s"], "resolutions": list(row.get("resolutions") or ()),
           "aspects": list(row.get("aspects") or ()), "audio": row.get("audio", "no"),
           "start_image": generator["provider"] != "comfyui" or "image" in (generator.get("mapping") or {}),
           "price_per_s": per_second_words(generator), "minutes": minutes_words(generator),
           "asks": generator.get("video_asks", True), "pips": list(generator.get("video_pips") or ())}
    clip = price(generator, duration_s=base["duration_s"], resolution=base["resolution"])
    out["price_usd_default"] = clip
    if row.get("note"):
        out["note"] = row["note"]
    return out


def money(value: float | None) -> str:
    return images.money(value)


def describe_new(provider: str, base_url: str = "", model: str = "", name: str = "") -> dict:
    """A new video generator's settings, with DGC's defaults filled in: the cheapest good model for a cloud one."""
    from .config import VIDEO_PROVIDERS
    if provider not in VIDEO_PROVIDERS:
        raise ValueError(f"DGC makes videos with {', '.join(VIDEO_PROVIDERS)}")
    model = model or V.DEFAULT_MODELS.get(provider, "")
    row = V.model_info(provider, model)
    short = {"fal": "fal", "gemini": "Gemini", "replicate": "Replicate", "comfyui": "ComfyUI"}[provider]
    title = name or (f"{short} {row['label']}" if row.get("label") and not row["label"].startswith(short) else
                     row.get("label") or f"{short} video")
    if provider == "comfyui" and not name:
        from urllib.parse import urlsplit
        host = urlsplit(base_url).hostname if base_url else "localhost"
        title = f"ComfyUI video on {host}"
    return {"provider": provider, "name": " ".join(title.split())[:64], **({"base_url": base_url} if base_url else {}),
            **({"model": model} if model and provider != "comfyui" else {})}


# ---- the job records ---------------------------------------------------------------------------------------------------
def new_id() -> str:
    return "vid_" + uuid.uuid4().hex[:12]


def _path(job_id: str) -> Path:
    if not re.fullmatch(r"vid_[0-9a-f]{12}", str(job_id or "")):
        raise ValueError("not a video job id")
    return jobs_dir() / f"{job_id}.json"


def load(job_id: str) -> dict | None:
    try:
        value = json.loads(_path(job_id).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def save(job: dict) -> bool:
    """Write a job's record. The first end stands: when the record on disk has already ended (stopped, made or
    failed, perhaps by another DGC) and this one says otherwise, nothing is written, ``job`` takes the ended state
    from disk, and False comes back. A Stop asked for elsewhere, and "told", are never written over."""
    path = _path(job["id"])
    with _LOCK:
        try:
            disk = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            disk = {}
        if disk.get("state") in TERMINAL and job.get("state") != disk.get("state"):
            job.update({k: disk[k] for k in ("state", "status", "finished", "charged", "result", "error", "cost_usd",
                                             "told") if k in disk})
            return False
        if disk.get("cancel_requested"):
            job["cancel_requested"] = True
        if isinstance(disk.get("target"), dict):        # where its reply is, learned after it started (a Pip's)
            job["target"] = {**(job.get("target") or {}), **disk["target"]}
        if disk.get("told") and not job.get("told"):
            job["told"] = True
        job["updated"] = time.time()
        temp = path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex[:6]}.tmp")
        temp.write_text(json.dumps(job, ensure_ascii=False, indent=1), encoding="utf-8")
        os.chmod(temp, 0o600)
        os.replace(temp, path)
        return True


def all_jobs(*, limit: int = 200) -> list[dict]:
    rows = []
    for path in jobs_dir().glob("vid_*.json"):
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(value, dict) and value.get("id"):
            rows.append(value)
    rows.sort(key=lambda row: float(row.get("started") or 0), reverse=True)
    return rows[:limit]


def mark_told(job_id: str) -> None:
    job = load(job_id)
    if job is not None and not job.get("told"):
        job["told"] = True
        save(job)


def untold(*, session: str = "", chat: str = "") -> list[dict]:
    """Finished jobs of a Work session (or a chat) whose model hasn't been told yet."""
    return [job for job in all_jobs() if job.get("state") in TERMINAL and not job.get("told")
            and ((session and (job.get("target") or {}).get("session") == session)
                 or (chat and (job.get("target") or {}).get("chat") == chat))]


def discard(job_id: str) -> None:
    """A job that was never sent (the provider refused it): its record goes, and with it its hold on the limit."""
    for path in (_path(job_id), _path(job_id).with_suffix(".lock")):
        try:
            path.unlink()
        except OSError:
            pass


def pending_spend(config, generator: dict) -> float:
    """What the jobs still running on this generator's key are expected to cost (one being sent included; one whose
    charge is already in the spend, never twice)."""
    ids = {g["id"] for g in images.same_key(images.settings(config), generator)}
    counted = images.charged_jobs()
    return round(sum(float(job.get("estimate_usd") or 0) for job in all_jobs()
                     if job.get("state") not in TERMINAL and job.get("generator") in ids
                     and job.get("id") not in counted), 4)


def view(job: dict) -> dict:
    """A job as the protocol, the SDK and the screens show it (never a key, never the provider's handle)."""
    out = {key: job[key] for key in ("id", "state", "status", "generator", "generator_name", "provider", "model",
                                     "label", "duration_s", "resolution", "aspect", "audio", "estimate_usd",
                                     "surface", "started", "finished", "cost_usd", "charged", "minutes")
           if job.get(key) is not None}
    out["prompt"] = str(job.get("prompt") or "")[:300]
    out["price"] = money(job.get("estimate_usd"))
    out["elapsed_s"] = int((float(job.get("finished") or time.time())) - float(job.get("started") or time.time()))
    target = job.get("target") or {}
    for key in ("session", "call_id", "chat", "message", "action", "pip", "run"):
        if target.get(key):
            out[key] = target[key]
    if job.get("result"):
        out["result"] = {k: v for k, v in job["result"].items() if k in (
            "path", "rel", "sidecar", "poster", "bytes", "mime", "width", "height", "seconds", "file")}
    if job.get("error"):
        out["error"] = dict(job["error"])
    out["can_stop"] = job.get("state") not in TERMINAL
    return out


def line(job: dict) -> str:
    """"Made a 5 s video with fal Wan 2.2 5B · 720p · $0.15": what a finished (or failed) job says, in one line."""
    state = job.get("state")
    who = job.get("label") or job.get("generator_name") or job.get("generator")
    seconds = (job.get("result") or {}).get("seconds") or job.get("duration_s")
    length = f"{round(float(seconds)):g} s" if seconds else "a"
    if state == "done":
        cost = job.get("cost_usd")
        return " · ".join([f"Made a {length} video with {who}", str(job.get("resolution") or ""),
                           "free" if cost == 0 else "price unknown" if cost is None else images.dollars(cost)])
    if state == "failed":
        error = job.get("error") or {}
        return f"The video with {who} wasn't made: {P.KIND_WORDS.get(error.get('kind'), 'failed')}: {error.get('message', '')}"
    if state == "cancelled":
        return f"Stopped the video with {who}." + (f" {job['charged']}" if job.get("charged") else "")
    return f"Making a {length} video with {who}: {job.get('status') or 'working'}"


# ---- what a finished video leaves behind ----------------------------------------------------------------------------
def _boxes(data: bytes, start: int, end: int):
    at = start
    while at + 8 <= end:
        size, kind = struct.unpack(">I4s", data[at:at + 8])
        head = 8
        if size == 1 and at + 16 <= end:
            size, head = struct.unpack(">Q", data[at + 8:at + 16])[0], 16
        elif size == 0:
            size = end - at
        if size < head:
            return
        yield kind, at + head, min(at + size, end)
        at += size


def probe(path: Path) -> dict:
    """Length (seconds), width and height of an MP4/MOV from its own boxes (no ffmpeg needed): {} when unknown."""
    try:
        with path.open("rb") as handle:
            data = handle.read(64 * 1024 * 1024)
    except OSError:
        return {}
    out: dict = {}
    try:
        for kind, start, end in _boxes(data, 0, len(data)):
            if kind != b"moov":
                continue
            for inner, a, b in _boxes(data, start, end):
                # Each box's payload is read only as far as it goes: a cut-off or odd file says less, never fails.
                if inner == b"mvhd" and b - a >= 20:
                    version = data[a]
                    if version == 1 and b - a < 32:
                        continue
                    scale, length = (struct.unpack(">IQ", data[a + 20:a + 32]) if version == 1 else
                                     struct.unpack(">II", data[a + 12:a + 20]))
                    if scale:
                        out["seconds"] = round(length / scale, 2)
                elif inner == b"trak" and "width" not in out:
                    for leaf, c, d in _boxes(data, a, b):
                        if leaf == b"tkhd" and d - c >= 8:
                            width, height = struct.unpack(">II", data[d - 8:d])
                            if width >> 16 and height >> 16:
                                out.update(width=width >> 16, height=height >> 16)
    except (IndexError, struct.error):
        pass
    return out


def poster(path: Path) -> Path | None:
    """A frame half a second in, as <name>.jpg beside the video, when ffmpeg is on this computer."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return None
    target = path.with_suffix(".jpg")
    try:
        subprocess.run([ffmpeg, "-y", "-loglevel", "error", "-ss", "0.5", "-i", str(path), "-frames:v", "1",
                        "-vf", "scale='min(960,iw)':-2", str(target)], timeout=30, check=False,
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError):
        return None
    return target if target.is_file() and target.stat().st_size > 0 else None


def _slug(prompt: str) -> str:
    words = re.sub(r"[^a-z0-9]+", "-", prompt.lower()).strip("-")
    return "-".join(words.split("-")[:6])[:48].strip("-") or "video"


def place_for(job: dict, mime: str) -> Path:
    """Where its file goes: the folder (and the name save_to gave), never over a file that's there."""
    folder = Path(job["folder"])
    folder.mkdir(parents=True, exist_ok=True)
    ext = V.EXTENSIONS.get(mime, "mp4")
    stem = job.get("name") or f"{_slug(job.get('prompt', ''))}-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
    path = folder / f"{stem}.{ext}"
    serial = 2
    while (path.exists() or path.with_suffix(".json").exists()) and not (job.get("replace") and job.get("name")):
        path = folder / f"{stem}-{serial}.{ext}"
        serial += 1
    return path


def keep(job: dict, temp: Path, mime: str, seed) -> dict:
    """Move the downloaded file into place, write its sidecar and poster, and list it in the Library."""
    path = place_for(job, mime)
    os.replace(temp, path)
    facts = probe(path)
    picture = poster(path)
    sidecar = path.with_suffix(".json")
    record = {"prompt": job.get("prompt", ""), **({"negative_prompt": job["negative"]} if job.get("negative") else {}),
              "provider": job["provider"], "provider_name": images.PROVIDER_LABELS.get(job["provider"], ""),
              "generator": job["generator"], "generator_name": job.get("generator_name", ""), "model": job.get("model"),
              "seed": seed, "duration_s": facts.get("seconds") or job.get("duration_s"),
              "requested_duration_s": job.get("duration_s"), "resolution": job.get("resolution"),
              "aspect": job.get("aspect"), "audio": job.get("audio"), "width": facts.get("width"),
              "height": facts.get("height"), "cost_usd": job.get("estimate_usd"),
              "cost_note": "DGC's estimate from the provider's published price" if job.get("estimate_usd") else
                           ("free" if job.get("estimate_usd") == 0 else "price unknown"),
              **({"start_image": job["image"]} if job.get("image") else {}),
              "file": path.name, "bytes": path.stat().st_size, "mime": mime, "job": job["id"],
              **({"poster": picture.name} if picture else {}),
              "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "surface": job.get("surface"),
              "made_by": "DGC"}
    sidecar.write_text(json.dumps(record, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    rel = ""
    if job.get("root"):
        try:
            rel = path.resolve().relative_to(Path(job["root"]).resolve()).as_posix()
        except ValueError:
            rel = ""
    result = {"path": str(path), "rel": rel, "sidecar": str(sidecar), "file": path.name,
              **({"poster": str(picture)} if picture else {}), "bytes": record["bytes"], "mime": mime,
              **{k: facts[k] for k in ("seconds", "width", "height") if k in facts}}
    images._index({"kind": "video", "path": str(path), "rel": rel, "surface": job.get("surface"),
                   "generator": job["generator"], "generator_name": job.get("generator_name", ""),
                   "provider": job["provider"], "model": job.get("model"), "prompt": str(job.get("prompt", ""))[:500],
                   "seed": seed, "seconds": facts.get("seconds") or job.get("duration_s"),
                   "width": facts.get("width"), "height": facts.get("height"), "bytes": record["bytes"],
                   "mime": mime, "cost_usd": job.get("estimate_usd"), "created_at": record["created_at"],
                   **({"poster": str(picture)} if picture else {}), "job": job["id"], **(job.get("where") or {})},
                  folder=directory())
    return result


def library(*, query: str = "", project: str = "", surface: str = "", limit: int = 60, offset: int = 0) -> dict:
    """Every video DGC made, newest first: the ones whose file is still there."""
    return images.library(query=query, project=project, surface=surface, limit=limit, offset=offset,
                          folder=directory(), key="videos")


# ---- running jobs --------------------------------------------------------------------------------------------------------
class Jobs:
    """The video jobs this process polls, and who hears about them. One per process (JOBS)."""

    def __init__(self):
        self._lock = threading.Lock()
        self._running: dict[str, dict] = {}      # id -> {"cancel": Event, "thread", "fd"}
        self._watched: set[str] = set()          # ids another DGC polls, read from their records here
        self._listeners: list = []
        self.config = None

    # -- listeners
    def add_listener(self, fn) -> None:
        with self._lock:
            if fn not in self._listeners:
                self._listeners.append(fn)

    def remove_listener(self, fn) -> None:
        with self._lock:
            if fn in self._listeners:
                self._listeners.remove(fn)

    def _tell(self, job: dict, change: str) -> None:
        with self._lock:
            listeners = list(self._listeners)
        for fn in listeners:
            try:
                fn(dict(job), change)
            except Exception:                      # noqa: BLE001 -- a listener never stops a job
                pass

    # -- starting, resuming, stopping
    def start(self, config, job: dict, fd=None) -> dict:
        """A job just submitted: write it down and poll it in the background. ``fd``: its poll lock, held while it was
        sent (claim); with its handle on disk now, whichever DGC takes the lock next polls it."""
        save(job)
        self._tell(job, "started")
        self.unclaim(fd)
        self._track(config, job)
        return job

    def claim(self, job_id: str):
        """A new job's poll lock, taken before it is sent so no other DGC takes it on meanwhile (start, or unclaim)."""
        return self._claim(job_id)

    def unclaim(self, fd) -> None:
        if isinstance(fd, int) and fd >= 0:
            try:
                os.close(fd)
            except OSError:
                pass

    def polling(self, job_id: str) -> bool:
        with self._lock:
            return job_id in self._running

    def watching(self, job_id: str) -> bool:
        with self._lock:
            return job_id in self._watched

    def resume(self, config, keep=None) -> list[str]:
        """Poll again the unfinished jobs on disk that no running DGC is polling (after a reload or a restart); a job
        another DGC polls is watched instead, so this one hears how it ends. ``keep(job)``: only the jobs it says (a
        chat's own session, say), so one window's backend doesn't take on another's. Returns the ids polled here."""
        resumed = []
        for job in all_jobs():
            if job.get("state") in TERMINAL or self.polling(job["id"]) or (keep is not None and not keep(job)):
                continue
            if self._track(config, job):
                resumed.append(job["id"])
        return resumed

    def follow(self, config, job_id: str) -> bool:
        """Hear one job's changes here: polled here, or watched while another DGC polls it."""
        job = load(job_id)
        if job is None or job.get("state") in TERMINAL:
            return False
        return self._track(config, job) or self.watching(job_id)

    def _claim(self, job_id: str):
        try:
            import fcntl
        except ImportError:
            return -1
        fd = os.open(str(jobs_dir() / f"{job_id}.lock"), os.O_CREAT | os.O_RDWR | getattr(os, "O_CLOEXEC", 0), 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            os.close(fd)
            return None
        return fd

    def _track(self, config, job: dict) -> bool:
        with self._lock:
            if job["id"] in self._running:
                return True
            fd = self._claim(job["id"])
            if fd is None:
                self._watch(config, job["id"])     # another DGC polls it: this one hears it from its record
                return False
            cancel = threading.Event()
            entry = {"cancel": cancel, "fd": fd}
            self._running[job["id"]] = entry
        self.config = config
        thread = threading.Thread(target=self._run, args=(config, job["id"], cancel), daemon=True,
                                  name=f"dgc-video-{job['id'][-6:]}")
        entry["thread"] = thread
        thread.start()
        return True

    def _watch(self, config, job_id: str) -> None:
        """Hold the lock (called under it). A job another DGC polls (two windows, or the backend a reload left behind):
        its record is read every couple of seconds and each change is told here, until it ends or that DGC goes
        (then this one polls it)."""
        if job_id in self._watched:
            return
        self._watched.add(job_id)

        def loop():
            last = None
            try:
                while True:
                    job = load(job_id)
                    if job is None:
                        return
                    seen = (job.get("state"), job.get("status"))
                    if seen != last and last is not None:
                        self._tell(job, job.get("state") if job.get("state") in TERMINAL else "progress")
                    last = seen
                    if job.get("state") in TERMINAL:
                        return
                    with self._lock:
                        if job_id in self._running:
                            return              # this DGC polls it now (it was being sent here): that tells
                        fd = self._claim(job_id)
                        if fd is not None:      # the DGC that polled it is gone: this one takes it on
                            cancel = threading.Event()
                            entry = {"cancel": cancel, "fd": fd}
                            self._running[job_id] = entry
                    if fd is not None:
                        entry["thread"] = threading.current_thread()
                        self._run(config, job_id, cancel)
                        return
                    time.sleep(float(os.environ.get("DGC_VIDEO_WATCH_S") or 2.0))
            finally:
                with self._lock:
                    self._watched.discard(job_id)
        threading.Thread(target=loop, daemon=True, name=f"dgc-video-watch-{job_id[-6:]}").start()

    def _release(self, job_id: str) -> None:
        with self._lock:
            entry = self._running.pop(job_id, None)
        if entry and isinstance(entry.get("fd"), int) and entry["fd"] >= 0:
            try:
                os.close(entry["fd"])
            except OSError:
                pass

    def wait(self, job_id: str, timeout: float | None = None) -> dict | None:
        with self._lock:
            entry = self._running.get(job_id)
        thread = (entry or {}).get("thread")
        if thread is not None:
            thread.join(timeout)
        return load(job_id)

    def stop(self, config, job_id: str) -> dict:
        """Stop a job: at the provider where it can, and say what was charged."""
        job = load(job_id)
        if job is None:
            raise ValueError(f"there is no video job {job_id}")
        if job.get("state") in TERMINAL:
            return job
        generator = _generator(config, job)
        said = "unsupported" if job.get("handle") else "sending"
        if generator is not None and job.get("handle"):
            try:
                said = V.adapter_for(job["provider"], workflow_reader=images.read_workflow).cancel(
                    generator, images.key_for(config, generator), job.get("handle") or {})
            except Exception:                      # noqa: BLE001 -- a Stop always stops DGC's side
                said = "unsupported"
        job["cancel_requested"] = True
        counted = may_be_charged(job, said)
        job.update(state="cancelled", finished=time.time(), status="stopped", charged=charged_words(job, said))
        if not _end(job, counted=counted):
            return job                             # it had just ended: that stands (and counted itself)
        with self._lock:
            entry = self._running.get(job_id)
        if entry:
            entry["cancel"].set()
        self._tell(job, "cancelled")
        return job

    def stopped_while_sending(self, config, job: dict, generator: dict, adapter, key: str) -> None:
        """A Stop that came while the job was being sent (video_tools.start): stopped at the provider now that it has
        the job, and what was charged said again from the provider's answer."""
        try:
            said = adapter.cancel(generator, key, job.get("handle") or {})
        except Exception:                          # noqa: BLE001 -- the Stop stands on DGC's side
            said = "unsupported"
        sent = {**job, "state": "queued"}
        job["charged"] = charged_words(sent, said)
        if _end(job, counted=may_be_charged(sent, said)):
            self._tell(job, "cancelled")

    # -- the poll loop
    def _run(self, config, job_id: str, cancel: threading.Event) -> None:
        lease, job = None, None
        try:
            job = load(job_id)
            if job is None:
                return
            generator = _generator(config, job)
            if not job.get("handle"):
                # Written just before it was sent, and the DGC sending it went away: the provider may have it.
                self._fail(job, P.ImageError("failed", "DGC stopped while it was sending the video, so DGC can't follow "
                                             "it; the provider may still make it"))
                return
            if generator is None:
                self._fail(job, P.ImageError("bad_request", f"the generator {job.get('generator')} isn't set up any more"))
                return
            adapter = V.adapter_for(job["provider"], workflow_reader=images.read_workflow)
            key = images.key_for(config, generator)
            try:
                lease = images.lease_router(config, generator, f"video {job_id}", cancel=cancel)
            except P.ImageError as error:
                self._fail(job, error)
                return
            interval = float(os.environ.get("DGC_VIDEO_POLL_S") or POLL_S.get(job["provider"], 5.0))
            deadline = float(job.get("started") or time.time()) + DEADLINE_S
            errors = 0
            while True:
                if cancel.is_set() or (load(job_id) or {}).get("cancel_requested"):
                    return
                try:
                    status = adapter.poll(generator, key, job.get("handle") or {})
                    errors = 0
                except P.ImageError as error:
                    errors += 1                    # a dropped connection: try again a few times first
                    if errors < 5 and error.kind == "server_down":
                        cancel.wait(interval * 2)
                        continue
                    self._fail(job, error)
                    return
                if status.state == "failed":
                    if cancel.is_set() or (load(job_id) or {}).get("cancel_requested"):
                        return                     # the Stop's own answer from the provider
                    self._fail(job, status.error or P.ImageError("failed", status.words or "the video failed"),
                               counted=not status.nothing_charged)
                    return
                if status.state == "cancelled":
                    counted = may_be_charged(job, "stopped")
                    job.update(state="cancelled", finished=time.time(), status="stopped at the provider",
                               charged=charged_words(job, "stopped"))
                    if _end(job, counted=counted):
                        self._tell(job, "cancelled")
                    return
                if status.state == "done":
                    self._finish(config, job, generator, adapter, key, status, cancel)
                    return
                if status.state != job.get("state") or status.words != job.get("status"):
                    job.update(state=status.state, status=status.words, progress=status.progress)
                    if not save(job):
                        return                     # it ended meanwhile (a Stop from another DGC)
                    self._tell(job, "progress")
                if time.time() > deadline:
                    self._fail(job, P.ImageError("server_down", f"{job.get('label')} didn't finish in "
                                                 f"{DEADLINE_S // 60} minutes"))
                    return
                cancel.wait(interval)
        except Exception as exc:                   # noqa: BLE001 -- an answer DGC couldn't read still ends the job
            if job is not None:
                self._fail(job, P.ImageError("failed", f"DGC couldn't follow the video: {type(exc).__name__}: {exc}"))
        finally:
            if lease is not None:
                from . import router as router_mod
                router_mod.ROUTER.release(lease)
            self._release(job_id)

    def _finish(self, config, job, generator, adapter, key, status, cancel) -> None:
        folder = Path(job["folder"])
        folder.mkdir(parents=True, exist_ok=True)
        temp = folder / f".{job['id']}.download"
        # The provider made it: from here it is charged, whether or not DGC manages to keep the file.
        try:
            mime = adapter.fetch(generator, key, job.get("handle") or {}, status, temp, cancel=cancel)
            result = keep(job, temp, mime, status.seed if status.seed is not None else job.get("seed"))
        except P.ImageError as error:
            if error.kind == "cancelled":
                return                             # a Stop while it downloaded: the Stop counts it
            self._fail(job, error, made=True)
            return
        except OSError as error:
            self._fail(job, P.ImageError("failed", f"DGC couldn't save the video: {error}"), made=True)
            return
        except Exception as error:                 # noqa: BLE001 -- a file DGC couldn't read ends the job as failed
            self._fail(job, P.ImageError("failed", f"DGC couldn't read the video: {type(error).__name__}"), made=True)
            return
        finally:
            try:
                temp.unlink()
            except OSError:
                pass
        cost = job.get("estimate_usd")
        images.record_check(job["generator"], {"ok": True, "detail": "made a video"})
        job.update(state="done", status="made", finished=time.time(), result=result, cost_usd=cost)
        if _end(job, counted=True):
            self._tell(job, "done")

    def _fail(self, job: dict, error: P.ImageError, *, counted: bool = True, made: bool = False) -> None:
        """End a job as failed. ``counted``: the provider may have charged for it (it has the job, and didn't say it
        failed), so its estimate stays in this month's spend; ``made``: it said the video was made."""
        if error.kind != "cancelled":
            images.record_check(job["generator"], {"ok": False, "kind": error.kind, "detail": error.message})
        job.update(state="failed", finished=time.time(), status=P.KIND_WORDS.get(error.kind, "failed"),
                   error=error.as_dict())
        estimate = job.get("estimate_usd")
        if counted and estimate and job.get("provider") != "comfyui":
            job["charged"] = (f"The provider made it, so it is charged ({money(estimate)}); DGC couldn't keep it."
                              if made else f"The provider may still charge for it (up to {money(estimate)}).")
        if _end(job, counted=counted):
            self._tell(job, "failed")


def _end(job: dict, *, counted: bool) -> bool:
    """Write a job's end, and when the provider may have charged for it, count its estimate in this month's spend:
    both under the spend lock (so a final check never sees it neither running nor spent), and once whichever of the
    download, a Stop or a failure ends it. False when it had ended already (that end stands)."""
    with images.budget():
        if not save(job):
            return False
        if counted and job.get("estimate_usd") and job.get("provider") != "comfyui":
            images._charge(job["id"], job["generator"], float(job["estimate_usd"]))
        return True


def may_be_charged(job: dict, said: str) -> bool:
    """Whether a job stopped with the provider's answer ``said`` may have been charged: free ones never; one the
    provider stopped before it started wasn't; one being sent is counted once the provider answers."""
    if not job.get("estimate_usd") or job.get("provider") == "comfyui" or said == "sending":
        return False
    return not (job.get("state") in ("queued", "starting") and said == "stopped")


def charged_words(job: dict, said: str) -> str:
    """What a Stop cost, as plainly as DGC can know it."""
    estimate = job.get("estimate_usd")
    if estimate == 0 or job.get("provider") == "comfyui":
        return "It was free (your own computer)."
    price_words = f" (up to {money(estimate)})" if estimate else ""
    if job.get("state") in ("queued", "starting") and said == "stopped":
        return "It hadn't started, so nothing was charged."
    if said == "stopped":
        return f"It had started, so the provider may still charge for it{price_words}."
    if said == "finished":
        return f"The provider had already finished it, so it is charged{price_words}; DGC didn't keep it."
    if said == "sending":
        return (f"It was being sent; DGC stops it at the provider as soon as it is there, and it may still be "
                f"charged{price_words}.")
    return (f"The provider can't stop a job once it has started: it may still be made and charged{price_words}. "
            "DGC won't download it.")


def _generator(config, job: dict) -> dict | None:
    return next((g for g in images.settings(config)["generators"] if g["id"] == job.get("generator")), None)


JOBS = Jobs()


@contextlib.contextmanager
def fresh_jobs():
    """A Jobs of its own for a test (its listeners and threads apart from the process's)."""
    global JOBS
    old, JOBS = JOBS, Jobs()
    try:
        yield JOBS
    finally:
        JOBS = old
