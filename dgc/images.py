"""Image generation: the user's generators, which one a request uses, and what a generation leaves behind.

- **Generators** live in config (``images.generators``); each one's key in secrets.json, bound to its address
  (Config.image_key), or a provider's own environment variable for its official address. The model never sees a
  key.
- **Which one**: the one the call names, else the chat's or the project's remembered choice (``.dgc/images.json``),
  else the default; with several that fit and none chosen yet, an interactive surface asks the user once and the
  answer is remembered.
- **Money**: a paid generator asks before each image unless the user allowed it (Always allow turns its "asks"
  off); an optional monthly limit stops automatic spending once this month's estimate reaches it.
- **Files**: each image is saved as the provider sent it (watermarks and C2PA/SynthID metadata kept) with a sidecar
  ``<name>.json`` (prompt, provider, model, seed, cost), into DGC's own folder (``~/.dgc/images/sessions/<session>/``,
  ``chats/<chat>/``, ``pips/<pip>/``) unless the call names a place in the project (``save_to``) or the Images setting
  has a save folder, and is listed in ``~/.dgc/images/library.jsonl``.

DGC Router: a generator may name a Router system (``system``); while the Router is on, a generation holds one of
that system's workers (job ``images``) for as long as it runs.
"""
from __future__ import annotations

import contextlib
import json
import os
import re
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from . import image_providers as P
from .config import (IMAGE_PAID_PROVIDERS, IMAGE_PROVIDER_URLS, IMAGE_PROVIDERS, dgc_home, image_save_dir, image_size,
                     router_base_url, router_slug, validate_images)

MAX_COUNT = 4
MAX_PROMPT = 8000
MAX_INPUT_IMAGES = 8
MAX_INPUT_BYTES = 20 * 1024 * 1024
LIBRARY_MAX = 5000
CHECK_FRESH_S = 6 * 3600
PROVIDER_LABELS = {"comfyui": "ComfyUI", "a1111": "Automatic1111-compatible", "openai": "OpenAI", "xai": "xAI",
                   "together": "Together", "localai": "LocalAI", "ollama": "Ollama", "openai_compatible":
                   "OpenAI-compatible", "gemini": "Google Gemini", "bfl": "Black Forest Labs", "fal": "fal.ai",
                   "replicate": "Replicate"}
DEFAULT_MODELS = {"openai": "gpt-image-1", "xai": "grok-2-image", "together": "black-forest-labs/FLUX.1-schnell",
                  "ollama": "x/z-image-turbo", "gemini": "gemini-3.1-flash-image", "bfl": "flux-pro-1.1",
                  "fal": "fal-ai/flux/schnell", "replicate": "black-forest-labs/flux-schnell"}
# What a generator is good for, filled in from the provider and model; the user can edit it.
_GOOD_FOR = (
    (r"schnell|turbo|lightning|klein|flash-lite", "fast drafts"),
    (r"gpt-image|dall-e-3", "text in the image, edits, following a detailed brief"),
    (r"gemini-.*image|nano", "edits, and keeping a person or product the same across images"),
    (r"imagen", "photoreal images"),
    (r"kontext|edit", "editing an image with words"),
    (r"recraft", "logos, icons and vector-style art"),
    (r"ideogram", "text and typography"),
    (r"flux.*pro|flux-2|flux\.2|ultra", "high-quality photos and art"),
    (r"grok", "images from a plain description"),
    (r"seedream|qwen-image", "high-quality images, text in the image"),
)
# Published prices, in US dollars, as DGC's estimate ("about"): per image, or per megapixel ("mp"). Checked
# 2026-11; a provider's own bill is what counts.
PRICES = {
    ("fal", "fal-ai/flux/schnell"): ("mp", 0.003), ("fal", "fal-ai/flux/dev"): ("mp", 0.025),
    ("fal", "fal-ai/flux/dev/image-to-image"): ("mp", 0.03), ("fal", "fal-ai/flux-pro/v1.1"): ("mp", 0.04),
    ("fal", "fal-ai/flux-pro/v1.1-ultra"): ("image", 0.06), ("fal", "fal-ai/flux-pro/kontext"): ("image", 0.04),
    ("fal", "fal-ai/recraft-v3"): ("image", 0.04), ("fal", "fal-ai/ideogram/v2"): ("image", 0.08),
    ("fal", "fal-ai/imagen4/preview"): ("image", 0.05), ("fal", "fal-ai/qwen-image"): ("mp", 0.02),
    ("openai", "gpt-image-1"): ("image", 0.042), ("openai", "gpt-image-1-mini"): ("image", 0.011),
    ("openai", "dall-e-3"): ("image", 0.04), ("openai", "dall-e-2"): ("image", 0.02),
    ("gemini", "gemini-3.1-flash-image"): ("image", 0.067),
    ("gemini", "gemini-2.5-flash-image"): ("image", 0.039), ("gemini", "gemini-2.5-flash-image-preview"): ("image", 0.039),
    ("gemini", "gemini-3-pro-image-preview"): ("image", 0.134), ("gemini", "gemini-3-pro-image"): ("image", 0.134),
    ("gemini", "imagen-4.0-generate-001"): ("image", 0.04), ("gemini", "imagen-4.0-fast-generate-001"): ("image", 0.02),
    ("gemini", "imagen-4.0-ultra-generate-001"): ("image", 0.06),
    ("bfl", "flux-pro-1.1"): ("image", 0.04), ("bfl", "flux-pro-1.1-ultra"): ("image", 0.06),
    ("bfl", "flux-dev"): ("image", 0.025), ("bfl", "flux-kontext-pro"): ("image", 0.04),
    ("bfl", "flux-kontext-max"): ("image", 0.08), ("bfl", "flux-2-pro"): ("mp", 0.03),
    ("replicate", "black-forest-labs/flux-schnell"): ("image", 0.003),
    ("replicate", "black-forest-labs/flux-dev"): ("image", 0.025),
    ("replicate", "black-forest-labs/flux-1.1-pro"): ("image", 0.04),
    ("xai", "grok-2-image"): ("image", 0.07), ("xai", "grok-2-image-1212"): ("image", 0.07),
    ("together", "black-forest-labs/FLUX.1-schnell"): ("mp", 0.0027),
    ("together", "black-forest-labs/FLUX.1-schnell-Free"): ("mp", 0.0),
}
# What each provider can do through DGC (the model reads these in list_image_generators).
CAPABILITIES = {
    "comfyui": {"edit": True, "mask": True, "text": False, "max_side": 2048, "seed": True},
    "a1111": {"edit": True, "mask": True, "text": False, "max_side": 2048, "seed": True},
    "openai": {"edit": True, "mask": True, "text": True, "max_side": 1536, "seed": False},
    "xai": {"edit": False, "mask": False, "text": True, "max_side": 1024, "seed": False},
    "together": {"edit": False, "mask": False, "text": False, "max_side": 1792, "seed": True},
    "localai": {"edit": True, "mask": False, "text": False, "max_side": 1024, "seed": True},
    "ollama": {"edit": False, "mask": False, "text": True, "max_side": 1024, "seed": True},
    "openai_compatible": {"edit": True, "mask": True, "text": False, "max_side": 1024, "seed": True},
    "gemini": {"edit": True, "mask": False, "text": True, "max_side": 2048, "seed": False},
    "bfl": {"edit": True, "mask": False, "text": True, "max_side": 2048, "seed": True},
    "fal": {"edit": True, "mask": True, "text": True, "max_side": 2048, "seed": True},
    "replicate": {"edit": True, "mask": True, "text": True, "max_side": 2048, "seed": True},
}
# Through a plugin, not a generator: the model uses the plugin's own tools for these.
THROUGH_PLUGINS = ("Runway", "Higgsfield")
_LOCK = threading.Lock()


# ---- reading the settings ------------------------------------------------------------------------------------------
def settings(config) -> dict:
    reader = getattr(config, "images_block", None)
    if callable(reader):
        try:
            value = reader()
        except Exception:                       # noqa: BLE001 -- a stub config: no generators
            value = None
        if isinstance(value, dict) and isinstance(value.get("generators"), list):
            return value
        return validate_images(None)[0]
    try:
        raw = config.get("images")
    except Exception:                           # noqa: BLE001
        raw = None
    return validate_images(raw)[0]


def find(block: dict, name: str) -> dict | None:
    """A generator by its id, its name (any case), or its provider when only one has that provider."""
    wanted = " ".join(str(name or "").split()).lower()
    if not wanted:
        return None
    rows = block.get("generators") or []
    for generator in rows:
        if generator["id"] == wanted or generator["name"].lower() == wanted:
            return generator
    by_provider = [g for g in rows if g["provider"] == wanted or PROVIDER_LABELS.get(g["provider"], "").lower() == wanted]
    if len(by_provider) == 1:
        return by_provider[0]
    loose = [g for g in rows if wanted in g["name"].lower() or wanted in g["id"]]
    return loose[0] if len(loose) == 1 else None


def is_paid(generator: dict) -> bool:
    if generator["provider"] in IMAGE_PAID_PROVIDERS:
        price = price_for(generator, 1024, 1024)
        return price is None or price > 0
    if generator["provider"] == "openai_compatible":
        from .router import _private_host
        return not _private_host(generator["base_url"])
    return False


def is_local(generator: dict) -> bool:
    from .router import _private_host
    return not is_paid(generator) and _private_host(generator["base_url"])


def good_for(generator: dict) -> str:
    if generator.get("good_for"):
        return generator["good_for"]
    model = (generator.get("model") or "").lower()
    for pattern, words in _GOOD_FOR:
        if re.search(pattern, model):
            return words
    if generator["provider"] in ("comfyui", "a1111"):
        return "free, on your own computer: whatever model it runs"
    return ""


def capabilities(generator: dict) -> dict:
    caps = dict(CAPABILITIES.get(generator["provider"], {}))
    model = (generator.get("model") or "").lower()
    if generator["provider"] == "gemini" and model.startswith("imagen"):
        caps.update(edit=False)
    if generator["provider"] == "comfyui" and generator.get("workflow"):
        caps.update(edit="image" in (generator.get("mapping") or {}), mask="mask" in (generator.get("mapping") or {}))
    if generator["provider"] == "fal" and not re.search(r"edit|kontext|image-to-image|img2img|inpaint|redux", model):
        caps.update(edit=False, mask=False)
    if generator["provider"] == "bfl" and not re.search(r"kontext|flux-2|fill|expand", model):
        caps.update(edit=False)
    if re.search(r"schnell|turbo|sd-?1|sdxl|stable-diffusion", model) and generator["provider"] not in ("openai",):
        caps["text"] = False
    return caps


def price_for(generator: dict, width: int, height: int) -> float | None:
    """DGC's estimate of one image, in US dollars; 0 for a local server; None when DGC doesn't know."""
    provider = generator["provider"]
    if provider not in IMAGE_PAID_PROVIDERS:
        return None if provider == "openai_compatible" and _public(generator) else 0.0
    model = generator.get("model") or DEFAULT_MODELS.get(provider, "")
    row = PRICES.get((provider, model))
    if row is None:
        return None
    unit, amount = row
    if unit == "mp":
        return round(amount * max(1.0, (width * height) / 1_000_000), 4)
    return amount


def _public(generator) -> bool:
    from .router import _private_host
    return not _private_host(generator["base_url"])


def money(value: float | None) -> str:
    if value is None:
        return "price unknown"
    if value == 0:
        return "free"
    return f"about ${value:.3f}".rstrip("0").rstrip(".") if value < 0.1 else f"about ${value:.2f}"


def dollars(value) -> str:
    """$0.006, $0.25, $5.00: small amounts keep the cents they have."""
    value = float(value or 0)
    return f"${value:.3f}" if 0 < value < 0.1 else f"${value:.2f}"


def makes(generator: dict) -> str:
    """What a generator makes: "images" (every generator before video), "videos" or "both"."""
    return str(generator.get("makes") or "images")


def makes_images(generator: dict) -> bool:
    return makes(generator) in ("images", "both")


def makes_videos(generator: dict) -> bool:
    return makes(generator) in ("videos", "both")


def same_key(block: dict, generator: dict) -> list[dict]:
    """The generators that share this one's key: the same provider at the same address (a fal picture model and a
    fal video model are two generators on one fal key). The generator itself comes first."""
    rows = [g for g in block.get("generators") or [] if g["id"] != generator["id"]
            and g["provider"] == generator["provider"] and g["base_url"] == generator["base_url"]]
    return [generator, *rows]


def _saved_key(config, generator: dict) -> tuple[str, str]:
    """(the key saved for this generator, or else for one that shares its key, the id it was saved under)."""
    reader = getattr(config, "image_key", None)
    if not callable(reader):
        return "", ""
    try:
        siblings = same_key(settings(config), generator)
    except Exception:                           # noqa: BLE001 -- a stub config
        siblings = [generator]
    if not any(g["id"] == generator["id"] for g in siblings):
        siblings = [generator]
    for row in siblings:
        try:
            saved = str(reader(row["id"]) or "")
        except Exception:                       # noqa: BLE001
            saved = ""
        if saved:
            return saved, row["id"]
    return "", ""


def key_for(config, generator: dict) -> str:
    """The generator's own saved key (or the one saved for a generator on the same provider and address), else its
    provider's environment variable when it uses the official address."""
    saved = _saved_key(config, generator)[0]
    if saved:
        return saved
    official = IMAGE_PROVIDER_URLS.get(generator["provider"])
    if official and router_base_url(official)[0] == generator["base_url"]:
        for name in P.ENV_KEYS.get(generator["provider"], ()):
            if os.environ.get(name):
                return os.environ[name]
    return ""


def key_source(config, generator: dict) -> str:
    """Where its key comes from: "saved", "env:NAME" or "" (never the key). A key saved for another generator on the
    same provider and address counts as saved: it is the same key."""
    if _saved_key(config, generator)[0]:
        return "saved"
    official = IMAGE_PROVIDER_URLS.get(generator["provider"])
    if official and router_base_url(official)[0] == generator["base_url"]:
        for name in P.ENV_KEYS.get(generator["provider"], ()):
            if os.environ.get(name):
                return f"env:{name}"
    return ""


def needs_key(generator: dict) -> bool:
    return generator["provider"] in IMAGE_PAID_PROVIDERS


# ---- state under ~/.dgc/images ---------------------------------------------------------------------------------------
def directory() -> Path:
    return dgc_home() / "images"


def session_folder(session: str) -> Path:
    """DGC's own folder for a Work session's pictures (or the CLI's and the SDK's, by name)."""
    safe = re.sub(r"[^A-Za-z0-9._-]+", "-", str(session or "")).strip("-.")[:80] or "work"
    return directory() / "sessions" / safe


def _ensure_dir() -> Path:
    folder = directory()
    folder.mkdir(parents=True, exist_ok=True)
    try:
        folder.chmod(0o700)
    except OSError:
        pass
    return folder


@contextlib.contextmanager
def _locked(name: str):
    folder = _ensure_dir()
    try:
        import fcntl
    except ImportError:
        with _LOCK:
            yield
        return
    fd = os.open(str(folder / f"{name}.lock"), os.O_CREAT | os.O_RDWR | getattr(os, "O_CLOEXEC", 0), 0o600)
    try:
        with _LOCK:
            fcntl.flock(fd, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)


def _read(name: str) -> dict:
    path = directory() / f"{name}.json"
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def _write(name: str, value: dict) -> None:
    folder = _ensure_dir()
    path = folder / f"{name}.json"
    tmp = folder / f".{name}.{os.getpid()}.{uuid.uuid4().hex[:6]}.tmp"
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=1), encoding="utf-8")
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def workflow_path(name: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,95}\.json", str(name or "")):
        raise ValueError("not a workflow name")
    return directory() / "workflows" / name


def read_workflow(name: str) -> str:
    return workflow_path(name).read_text(encoding="utf-8")


def save_workflow(generator_id: str, workflow: dict) -> str:
    name = f"{router_slug(generator_id) or 'comfyui'}.json"
    path = workflow_path(name)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(workflow, ensure_ascii=False, indent=1), encoding="utf-8")
    return name


def month() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m")


def key_spent(config, generator: dict, *, when: str | None = None) -> float:
    """This month's spend on the generator's key: its own and every generator's that shares the key (pictures and
    videos alike). A generator's monthly limit is read against this."""
    try:
        rows = same_key(settings(config), generator)
    except Exception:                           # noqa: BLE001
        rows = [generator]
    return round(sum(spent(row["id"], when=when) for row in rows), 4)


def spent(generator_id: str, *, when: str | None = None) -> float:
    value = _read("spend").get(when or month()) or {}
    try:
        return round(float(value.get(generator_id) or 0.0), 4)
    except (TypeError, ValueError):
        return 0.0


def add_spend(generator_id: str, amount: float | None) -> None:
    if not amount:
        return
    with _locked("spend"):
        _add_spend(generator_id, amount)


def _add_spend(generator_id: str, amount: float, when: str | None = None) -> None:
    """add_spend with the spend lock already held."""
    value = _read("spend")
    row = value.setdefault(when or month(), {})
    row[generator_id] = round(float(row.get(generator_id) or 0.0) + float(amount), 4)
    for old in sorted(value)[:-24]:
        value.pop(old, None)
    _write("spend", value)


# ---- this month's limit, held across every DGC -------------------------------------------------------------------------
# What a key has used this month is its spend (spend.json) and what is on its way: pictures being made right now by any
# DGC (reserved.json, one row a generation) and videos still running (their job records, dgc/videos.py). The final
# check before anything is sent reads all three and writes its own row under the one spend lock, so two windows, or two
# plans made before either started, can never both use the same room under the limit.
RESERVE_S = 3600            # a picture takes minutes at most: a row older than this belongs to a DGC that went away


def _alive(pid) -> bool:
    try:
        os.kill(int(pid), 0)
    except (OSError, ValueError, TypeError) as exc:
        return isinstance(exc, PermissionError)
    return True


def _reservations() -> dict:
    """The rows of pictures being made now (the spend lock held). A row whose DGC went away mid-generation is settled
    as charged: the provider may have made it."""
    rows = _read("reserved")
    gone = [token for token, row in rows.items() if not isinstance(row, dict) or not _alive(row.get("pid"))
            or time.time() - float(row.get("at") or 0) > RESERVE_S]
    for token in gone:
        row = rows.pop(token)
        if isinstance(row, dict) and row.get("amount"):
            _add_spend(str(row.get("generator") or ""), float(row["amount"]), str(row.get("month") or month()))
    if gone:
        _write("reserved", rows)
    return rows


def _committed(config, generator: dict, rows: dict | None = None) -> float:
    """This month's spend on the generator's key, with what is on its way (the spend lock held, or a reading)."""
    from . import videos
    try:
        ids = {g["id"] for g in same_key(settings(config), generator)}
    except Exception:                           # noqa: BLE001 -- a stub config
        ids = {generator["id"]}
    rows = _read("reserved") if rows is None else rows
    making = sum(float(row.get("amount") or 0) for row in rows.values()
                 if isinstance(row, dict) and row.get("generator") in ids and row.get("month") == month())
    return round(key_spent(config, generator) + making + videos.pending_spend(config, generator), 4)


def committed(config, generator: dict) -> float:
    """This month's spend on the generator's key, pictures and videos alike, with the pictures being made and the
    videos still running: what its monthly limit is read against."""
    return _committed(config, generator)


@contextlib.contextmanager
def budget():
    """The spend lock, for a final check and the record it writes (dgc/video_tools.start)."""
    with _locked("spend"):
        yield


def room_left(config, generator: dict) -> float | None:
    """What the monthly limit leaves on this key now (the spend lock held); None with no limit."""
    cap = generator.get("monthly_limit_usd")
    return None if cap is None else round(float(cap) - _committed(config, generator, _reservations()), 4)


def over_limit_error(generator: dict, *, unknown: bool = False) -> P.ImageError:
    cap = dollars(generator.get("monthly_limit_usd"))
    if unknown:
        return P.ImageError("over_limit", f"DGC doesn't know what {generator['name']} charges, so it can't keep this "
                            f"within the {cap} monthly limit; it makes one only after the user says yes to that",
                            provider=generator["provider"])
    return P.ImageError("over_limit", f"this would pass the {cap} monthly limit on {generator['name']}'s key (another "
                        "picture or video on it was made or started meanwhile)", provider=generator["provider"])


def reserve(config, generator: dict, amount: float | None, *, may_pass: bool = False) -> str:
    """The final check before a picture is sent: its estimate is held against the generator's monthly limit for as
    long as it is made (settle ends it). ``may_pass``: the user said yes to a card that said it passes the limit (or
    that its price is unknown). Raises ImageError "over_limit" otherwise."""
    with _locked("spend"):
        rows = _reservations()
        cap = generator.get("monthly_limit_usd")
        if cap is not None and not may_pass:
            if amount is None:                     # a price DGC doesn't know can't be held to the limit
                raise over_limit_error(generator, unknown=True)
            if _committed(config, generator, rows) + float(amount) > float(cap) + 1e-9:
                raise over_limit_error(generator)
        token = uuid.uuid4().hex
        rows[token] = {"generator": generator["id"], "amount": round(float(amount or 0), 4), "month": month(),
                       "pid": os.getpid(), "at": time.time()}
        _write("reserved", rows)
        return token


def charge(token: str, generator_id: str, amount: float | None) -> bool:
    """Count what one job charged, or may have, once (a Stop and the download racing to end it count it once). False
    when it was counted before."""
    with _locked("spend"):
        return _charge(token, generator_id, amount)


def _charge(token: str, generator_id: str, amount: float | None) -> bool:
    """charge with the spend lock already held."""
    done = _read("settled")
    if token in done:
        return False
    done[token] = {"generator": generator_id, "amount": round(float(amount or 0), 4), "at": time.time()}
    for old in sorted(done, key=lambda key: float((done[key] or {}).get("at") or 0))[:-4000]:
        done.pop(old, None)
    _write("settled", done)
    if amount:
        _add_spend(generator_id, float(amount))
    return True


def charged_jobs() -> set:
    """The jobs whose charge is already in this month's spend (charge)."""
    return set(_read("settled"))


def settle(token: str, generator_id: str, charged: float | None) -> None:
    """A generation ended: its held estimate goes, and what the provider charged (or may have) is spent."""
    with _locked("spend"):
        rows = _read("reserved")
        if rows.pop(token, None) is not None:
            _write("reserved", rows)
        if charged:
            _add_spend(generator_id, charged)


def checks() -> dict:
    return _read("checks")


def record_check(generator_id: str, outcome: dict) -> None:
    with _locked("checks"):
        value = _read("checks")
        value[generator_id] = {**{k: outcome[k] for k in ("ok", "kind", "detail") if k in outcome}, "at": time.time()}
        _write("checks", value)


def forget(generator_id: str) -> None:
    with _locked("checks"):
        value = _read("checks")
        if value.pop(generator_id, None) is not None:
            _write("checks", value)


# ---- the remembered choice: a project's (.dgc/images.json) and a ChatDGC chat's (its own record) -------------------
def project_choice(project_root) -> str:
    if not project_root:
        return ""
    try:
        value = json.loads((Path(project_root) / ".dgc" / "images.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return ""
    return str(value.get("generator") or "") if isinstance(value, dict) else ""


def remember_project_choice(project_root, generator_id: str) -> None:
    folder = Path(project_root) / ".dgc"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / "images.json"
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        value = value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        value = {}
    if generator_id:
        value.update(generator=generator_id, chosen_at=datetime.now(timezone.utc).isoformat(timespec="seconds"))
    else:
        value.pop("generator", None)
        value.pop("chosen_at", None)
    path.write_text(json.dumps(value, indent=1) + "\n", encoding="utf-8")


# ---- which generators fit, and which one a call uses ---------------------------------------------------------------
def problem_for(generator: dict, *, edit: bool, mask: bool, count: int, width: int, height: int) -> str:
    """Why this generator can't take the request ("" when it can)."""
    if not generator.get("enabled", True):
        return "turned off"
    if not makes_images(generator):
        return "makes videos only"
    caps = capabilities(generator)
    if edit and not caps.get("edit"):
        return "can't edit an image"
    if mask and not caps.get("mask"):
        return "takes no mask"
    return ""


def last_state(generator: dict) -> dict:
    """What DGC last saw of it: {"ok", "kind"?, "detail", "at"} or {}."""
    found = checks().get(generator["id"])
    return found if isinstance(found, dict) else {}


def fitting(block: dict, *, edit: bool = False, mask: bool = False, count: int = 1, width: int = 1024,
            height: int = 1024, exclude=()) -> list[dict]:
    """Generators that could take this request, local and free first, then the default, then in order. One whose
    last try said it needs credit or has a bad key goes last."""
    rows = [g for g in block.get("generators") or [] if g["id"] not in exclude
            and not problem_for(g, edit=edit, mask=mask, count=count, width=width, height=height)]

    def rank(item):
        index, generator = item
        state = last_state(generator)
        broken = 1 if state.get("kind") in ("needs_credit", "bad_key") and not state.get("ok") else 0
        return (broken, 0 if not is_paid(generator) else 1, 0 if generator["id"] == block.get("default") else 1, index)
    return [g for _i, g in sorted(enumerate(rows), key=rank)]


@dataclass
class Choice:
    generator: dict | None
    why: str = ""                    # named | chat | project | default | only | first
    ask: list = field(default_factory=list)   # several fit and nothing is chosen: these, to ask the user
    problem: str = ""


def choose(config, block: dict, *, named: str = "", chat_choice: str = "", project_root=None, edit=False, mask=False,
           count=1, width=1024, height=1024, interactive: bool = False) -> Choice:
    """Which generator a request uses. ``interactive``: someone can be asked, so several that fit with nothing
    chosen yet come back in ``ask`` instead of a guess."""
    if not block.get("generators"):
        return Choice(None, problem="no image generator is set up yet")
    want = dict(edit=edit, mask=mask, count=count, width=width, height=height)
    if named:
        generator = find(block, named)
        if generator is None:
            names = ", ".join(f"{g['id']} ({g['name']})" for g in block["generators"])
            return Choice(None, problem=f"there is no image generator {named!r}; there are: {names}")
        problem = problem_for(generator, **want)
        if problem:
            return Choice(None, problem=f"{generator['name']} {problem}")
        return Choice(generator, "named")
    for why, wanted in (("chat", chat_choice), ("project", project_choice(project_root))):
        generator = find(block, wanted) if wanted else None
        if generator is not None and not problem_for(generator, **want):
            return Choice(generator, why)
    rows = fitting(block, **want)
    if not rows:
        reasons = "; ".join(f"{g['name']} {problem_for(g, **want)}" for g in block["generators"])
        return Choice(None, problem=f"no generator can take this ({reasons})")
    if len(rows) == 1:
        return Choice(rows[0], "only")
    if interactive:
        return Choice(None, ask=rows[:4])
    default = find(block, block.get("default") or "")
    if default is not None and default in rows:
        return Choice(default, "default")
    return Choice(rows[0], "first")


def option_label(generator: dict, width: int = 1024, height: int = 1024) -> str:
    return generator["name"]


def option_description(generator: dict, width: int = 1024, height: int = 1024) -> str:
    price = price_for(generator, width, height)
    bits = ["free, local" if is_local(generator) else "free" if price == 0 else f"{money(price)} an image"]
    if generator.get("model"):
        bits.append(generator["model"])
    if good_for(generator):
        bits.append(good_for(generator))
    return " · ".join(bits)[:200]


# ---- one generation ------------------------------------------------------------------------------------------------
@dataclass
class Saved:
    path: Path
    rel: str
    sidecar: Path
    mime: str
    width: int
    height: int
    bytes: int
    seed: int | None
    data: bytes = field(repr=False, default=b"")


@dataclass
class Result:
    generator: dict
    model: str
    saved: list
    cost: float | None
    took_s: float
    notes: list = field(default_factory=list)
    revised_prompt: str = ""


def _slug(prompt: str) -> str:
    words = re.sub(r"[^a-z0-9]+", "-", prompt.lower()).strip("-")
    return "-".join(words.split("-")[:6])[:48].strip("-") or "image"


def _dimensions(data: bytes) -> tuple[int, int]:
    from .image_views import parse_dimensions
    found = parse_dimensions(data)
    return found if found else (0, 0)


def save(pictures, *, folder: Path, root: Path | None, prompt: str, generator: dict, model: str, cost: float | None,
         surface: str, request: P.Request, where: dict | None = None, name: str = "", replace: bool = False) -> list[Saved]:
    """Write each picture as the provider sent it, with a sidecar beside it, and list it in the Library index. A file
    already there is never written over unless ``replace`` (the user said to, for the one file save_to named)."""
    folder.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    stem = (re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-.")[:60] if name else "") or f"{_slug(prompt)}-{stamp}"
    out = []
    each = None if cost is None else round(cost / max(1, len(pictures)), 4)
    for index, picture in enumerate(pictures):
        mime = picture.mime or P.sniff(picture.data) or "image/png"
        ext = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif"}.get(mime, "png")
        base = stem if len(pictures) == 1 else f"{stem}-{index + 1}"
        path = folder / f"{base}.{ext}"
        serial = 2
        while (path.exists() or path.with_suffix(".json").exists()) and not (replace and len(pictures) == 1 and name):
            path = folder / f"{base}-{serial}.{ext}"
            serial += 1
        path.write_bytes(picture.data)
        width, height = _dimensions(picture.data)
        sidecar = path.with_suffix(".json")
        record = {"prompt": prompt, **({"negative_prompt": request.negative} if request.negative else {}),
                  "provider": generator["provider"], "provider_name": PROVIDER_LABELS.get(generator["provider"], ""),
                  "generator": generator["id"], "generator_name": generator["name"], "model": model,
                  "seed": picture.seed, "width": width, "height": height,
                  "requested_size": f"{request.width}x{request.height}", "cost_usd": each,
                  "cost_note": "DGC's estimate from the provider's published price" if each else
                               ("free" if each == 0 else "price unknown"),
                  **({"revised_prompt": picture.revised_prompt} if picture.revised_prompt else {}),
                  **({"inputs": [i.name for i in request.images]} if request.images else {}),
                  "file": path.name, "bytes": len(picture.data), "mime": mime,
                  "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "surface": surface,
                  "made_by": "DGC"}
        sidecar.write_text(json.dumps(record, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        rel = ""
        if root is not None:
            try:
                rel = path.resolve().relative_to(Path(root).resolve()).as_posix()
            except ValueError:
                rel = ""
        out.append(Saved(path, rel, sidecar, mime, width, height, len(picture.data), picture.seed, picture.data))
        _index({"path": str(path), "rel": rel, "surface": surface, "generator": generator["id"],
                "generator_name": generator["name"], "provider": generator["provider"], "model": model,
                "prompt": prompt[:500], "seed": picture.seed, "width": width, "height": height,
                "bytes": len(picture.data), "cost_usd": each, "created_at": record["created_at"],
                **(where or {})})
    return out


def _index(row: dict, *, folder: Path | None = None) -> None:
    """One line in a Library index: the images one, or another kind's (videos) when ``folder`` names its directory."""
    try:
        with _locked("library" if folder is None else f"library-{folder.name}"):
            if folder is not None:
                folder.mkdir(parents=True, exist_ok=True)
            path = (_ensure_dir() if folder is None else folder) / "library.jsonl"
            with path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(row, ensure_ascii=False) + "\n")
            if path.stat().st_size > 4 * 1024 * 1024:
                lines = path.read_text(encoding="utf-8").splitlines()[-LIBRARY_MAX:]
                path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    except OSError:
        pass


def library(*, query: str = "", project: str = "", surface: str = "", limit: int = 60, offset: int = 0,
            folder: Path | None = None, key: str = "images") -> dict:
    """Every image DGC made (or, with ``folder``, every video), newest first: the ones whose file is still there."""
    path = (directory() if folder is None else folder) / "library.jsonl"
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        lines = []
    rows = []
    for line in reversed(lines):
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if not isinstance(row, dict) or not row.get("path") or not Path(row["path"]).is_file():
            continue
        if query and query.lower() not in str(row.get("prompt", "")).lower() and query.lower() not in Path(
                row["path"]).name.lower():
            continue
        if project and row.get("project") != project:
            continue
        if surface and row.get("surface") != surface:
            continue
        rows.append(row)
    limit = max(1, min(int(limit or 60), 200))
    page = rows[offset:offset + limit]
    return {key: page, "total": len(rows), "next_offset": offset + limit if offset + limit < len(rows) else None}


def lease_router(config, generator: dict, owner: str, cancel=None):
    """While DGC Router is on and the generator names a system with the images job: one of its workers, held for
    this generation (None when there is nothing to hold). Raises ImageError when that system can't be used."""
    system_id = generator.get("system")
    if not system_id:
        return None
    from . import router as router_mod
    block = router_mod.settings(config)
    if not block.get("enabled"):
        return None
    system = router_mod.find_system(block, system_id)
    if system is None:
        raise P.ImageError("bad_request", f"DGC Router has no system {system_id!r} for {generator['name']}")
    if "images" not in (system.get("jobs") or []):
        raise P.ImageError("bad_request", f"DGC Router's {system['name']} doesn't have the images job")
    lease, why = router_mod.ROUTER.lease_system(config, system["id"], owner=owner, job="images", cancel=cancel)
    if lease is None:
        raise P.ImageError("server_down" if why == "offline" else "cancelled" if why == "cancelled" else "rate_limited",
                           f"DGC Router: {system['name']} is {why}")
    return lease


def generate(config, generator: dict, request: P.Request, *, folder: Path, root: Path | None, surface: str,
             where: dict | None = None, progress=None, cancel=None, owner: str = "", name: str = "",
             replace: bool = False, may_pass: bool = False) -> Result:
    """Make the images, save them with their sidecars, add the estimate to this month's spend, and remember how the
    generator answered. Its estimate is held against the monthly limit from just before it is sent (``may_pass``:
    the user said yes to passing it). Raises ImageError with its kind ("over_limit" when the limit has no room)."""
    if cancel is not None and cancel.is_set():
        raise P.ImageError("cancelled", "stopped before the image was made")
    model = request.model or generator.get("model") or DEFAULT_MODELS.get(generator["provider"], "")
    request.model = model
    adapter = P.adapter_for(generator["provider"], workflow_reader=read_workflow)
    key = key_for(config, generator)
    if needs_key(generator) and not key:
        error = P.ImageError("bad_key", f"{generator['name']} has no key yet (paste it in Settings → Models → Images & video, or "
                             f"/images key {generator['id']})", provider=generator["provider"])
        record_check(generator["id"], {"ok": False, "kind": "bad_key", "detail": error.message})
        raise error
    each = price_for({**generator, "model": model}, request.width, request.height)   # the model it is made with
    held = None if each is None else round(each * request.count, 4)
    started = time.monotonic()
    lease = lease_router(config, generator, owner or f"images {generator['id']}", cancel=cancel)
    try:
        token = reserve(config, generator, held, may_pass=may_pass)
    except P.ImageError:
        if lease is not None:
            from . import router as router_mod
            router_mod.ROUTER.release(lease)
        raise
    try:
        with P.charge_watch() as watch:
            pictures = adapter.generate(generator, key, request, progress=progress, cancel=cancel)
    except BaseException as exc:
        # Not made: the estimate stays spent when the provider may have charged (it took the job, or never
        # answered), and goes only when every request was refused or never reached it.
        settle(token, generator["id"], held if watch.maybe else None)
        if isinstance(exc, P.ImageError) and exc.kind != "cancelled":
            record_check(generator["id"], {"ok": False, "kind": exc.kind, "detail": exc.message})
        raise
    finally:
        if lease is not None:
            from . import router as router_mod
            router_mod.ROUTER.release(lease)
    took = round(time.monotonic() - started, 1)
    cost = None if each is None else round(each * len(pictures), 4)
    settle(token, generator["id"], cost)
    if cancel is not None and cancel.is_set():
        # The provider may have charged, but a stopped Pip run must not publish a late image.
        raise P.ImageError("cancelled", "stopped before the image was saved")
    saved = save(pictures, folder=folder, root=root, prompt=request.prompt, generator=generator, model=model,
                 cost=cost, surface=surface, request=request, where=where, name=name, replace=replace)
    record_check(generator["id"], {"ok": True, "detail": f"made {len(saved)} image{'s' if len(saved) != 1 else ''}"})
    return Result(generator, model, saved, cost, took,
                  revised_prompt=next((p.revised_prompt for p in pictures if p.revised_prompt), ""))


def check(config, generator: dict) -> dict:
    adapter = P.adapter_for(generator["provider"], workflow_reader=read_workflow)
    key = key_for(config, generator)
    if needs_key(generator) and not key:
        outcome = {"ok": False, "kind": "bad_key", "detail": "no key yet"}
    else:
        try:
            outcome = adapter.check(generator, key)
        except Exception as exc:                # noqa: BLE001 -- a check never raises
            outcome = {"ok": False, "kind": "failed", "detail": f"{type(exc).__name__}: {exc}"[:300]}
    # A key that lists models fine can still be one that can't pay for an image (Gemini without billing): keep the
    # last generation's "needs credit" until an image is made again.
    last = last_state(generator)
    if outcome.get("ok") and last.get("kind") == "needs_credit" and not last.get("ok"):
        said = str(last.get("detail") or "needs credit")
        outcome = {"ok": False, "kind": "needs_credit",
                   "detail": said if said.startswith("the key works, but its last image: ") else
                   f"the key works, but its last image: {said}"}
    record_check(generator["id"], outcome)
    return outcome


def check_all(config, ids=None) -> dict:
    block = settings(config)
    rows = [g for g in block["generators"] if ids is None or g["id"] in ids]
    out: dict = {}
    threads = []
    for generator in rows:
        def run(item=generator):
            out[item["id"]] = check(config, item)
        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        threads.append(thread)
    for thread in threads:
        thread.join(15)
    return out


# ---- what the model and the user read ------------------------------------------------------------------------------
def describe(config, generator: dict, *, block: dict | None = None) -> dict:
    """One generator as list_image_generators and the protocol show it (never its key)."""
    block = block or settings(config)
    width, height = image_size(generator["size"]) or (1024, 1024)
    price = price_for(generator, width, height)
    state = last_state(generator)
    cap = generator.get("monthly_limit_usd")
    row = {"id": generator["id"], "name": generator["name"], "provider": generator["provider"],
           "provider_name": PROVIDER_LABELS.get(generator["provider"], generator["provider"]),
           "base_url": generator["base_url"], "model": generator.get("model") or DEFAULT_MODELS.get(
               generator["provider"], ""), "size": generator["size"], "enabled": generator.get("enabled", True),
           "asks": generator.get("asks", False), "paid": is_paid(generator), "local": is_local(generator),
           "price_usd": price, "price": money(price), "good_for": good_for(generator),
           "can": capabilities(generator), "default": generator["id"] == block.get("default"),
           "has_key": bool(key_source(config, generator)), "key_from": key_source(config, generator),
           "spent_this_month_usd": spent(generator["id"]), "makes": makes(generator),
           "key_spent_this_month_usd": key_spent(config, generator)}
    if makes_videos(generator):
        from . import videos
        row["video"] = videos.describe_video(generator)
        if row["makes"] == "videos" and price is None:
            # It makes no pictures, so it has no picture price (price_usd stays None): its price is its video's, as
            # Settings and `dgc videos list` say it. Release check, 2026-11-03: the SDK read fal Wan as "price
            # unknown", though DGC knows about $0.15 a clip.
            row["price"] = row["video"]["price_per_s"]
    if cap is not None:
        row["monthly_limit_usd"] = cap
    if generator.get("workflow"):
        row["workflow"] = generator["workflow"]
    if generator.get("mapping"):
        row["mapping"] = generator["mapping"]
    if generator.get("system"):
        row["system"] = generator["system"]
    if state:
        row["state"] = {"ok": bool(state.get("ok")), **({"kind": state["kind"]} if state.get("kind") else {}),
                        "detail": state.get("detail", ""), "at": state.get("at")}
    return row


def state_words(row: dict) -> str:
    state = row.get("state")
    if not state:
        return "not tested yet"
    when = state.get("at")
    age = ""
    if isinstance(when, (int, float)):
        minutes = int((time.time() - when) // 60)
        age = " (just now)" if minutes < 2 else f" ({minutes} min ago)" if minutes < 120 else f" ({minutes // 60} h ago)"
    if state.get("ok"):
        return "works" + age
    return f"{P.KIND_WORDS.get(state.get('kind'), state.get('kind') or 'failed')}: {state.get('detail', '')}"[:200] + age


def listing(config, *, project_root=None, chat_choice: str = "", refresh: bool = False) -> dict:
    block = settings(config)
    if refresh and block["generators"]:
        check_all(config)
    rows = [describe(config, g, block=block) for g in block["generators"]]
    chosen = chat_choice or project_choice(project_root)
    return {"generators": rows, "default": block.get("default", ""), "auto_fallback": block.get("auto_fallback"),
            "save_dir": block.get("save_dir"), "project_choice": project_choice(project_root),
            **({"chat_choice": chat_choice} if chat_choice else {}), "chosen": chosen,
            "through_plugins": list(THROUGH_PLUGINS)}


def listing_text(listing_value: dict) -> str:
    every = listing_value["generators"]
    rows = [row for row in every if row.get("makes", "images") in ("images", "both")]
    videos_only = len(every) - len(rows)
    if not rows and videos_only:
        return (f"No image generator is set up ({videos_only} video generator{'s' if videos_only != 1 else ''}: "
                "list_video_generators shows them). The user adds one in Settings → Models → Images & video.")
    if not rows:
        return ("No image generator is set up. The user adds one in Settings → Models → Images & video, with /images add, or "
                "`dgc images add` (ComfyUI or Automatic1111 on their own computer, or a key for OpenAI, Gemini, "
                "Black Forest Labs, fal.ai, Replicate, xAI or Together). Runway and Higgsfield work through their "
                "plugins, if added.")
    chosen = listing_value.get("chosen") or ""
    lines = [f"Image generators ({len(rows)}). "
             + (f"This {'chat' if listing_value.get('chat_choice') else 'project'} uses {chosen}. " if chosen else
                "This project has no choice yet: with several that fit, the user is asked once. ")
             + (f"Default: {listing_value['default']}. " if listing_value.get("default") else "")
             + ("Automatic fallback is on." if listing_value.get("auto_fallback") else
                "On 'needs credit' DGC switches only to a free one by itself.")]
    for row in rows:
        can = [word for word, on in (("edit", row["can"].get("edit")), ("mask", row["can"].get("mask")),
                                     ("text in the image", row["can"].get("text")), ("seed", row["can"].get("seed")))
               if on]
        # Its key, as this DGC has it: saved, or a provider's environment variable. Without one here, an earlier
        # "works" (another DGC's test, with its own key) says nothing about this one: the key line says what to do.
        keyed = needs_key(row) or row.get("has_key")
        key_from = str(row.get("key_from") or "")
        key = ("key saved" if key_from == "saved" else f"key from {key_from[4:]}" if key_from.startswith("env:")
               else "no key yet (the user adds it in Settings → Models → Images & video, or with /images key " + row["id"] + ")"
               if needs_key(row) else "")
        bits = [row["provider_name"] + (f" · {row['model']}" if row.get("model") else ""),
                "free, local" if row["local"] else row["price"] + (" an image" if row["price_usd"] else ""),
                "asks before each image" if row["asks"] else "doesn't ask",
                ("can " + ", ".join(can)) if can else "makes new images only",
                f"up to {row['can'].get('max_side', 1024)} px", f"default size {row['size']}",
                *([state_words(row)] if row.get("has_key") or not needs_key(row) else []),
                *([key] if keyed and key else [])]
        if row.get("good_for"):
            bits.append(f"good for: {row['good_for']}")
        if not row["enabled"]:
            bits.insert(0, "TURNED OFF")
        if row.get("monthly_limit_usd") is not None:
            bits.append(f"this month {dollars(row.get('key_spent_this_month_usd', row['spent_this_month_usd']))} of "
                        f"{dollars(row['monthly_limit_usd'])}")
        lines.append(f"- {row['id']} \"{row['name']}\": " + " · ".join(bits))
    if videos_only:
        lines.append(f"{videos_only} more make videos only (list_video_generators).")
    lines.append("Runway and Higgsfield make images through their plugins (if the user added them), not here.")
    return "\n".join(lines)


def model_words(model: str) -> str:
    """A model id as a name: "fal-ai/flux/schnell" -> "FLUX Schnell", "gemini-3.1-flash-image" -> "Gemini 3.1 Flash Image"."""
    parts = [p for p in str(model or "").split("/") if p and p not in ("fal-ai", "black-forest-labs")]
    words = " ".join(parts[-2:]).replace("-", " ").replace("_", " ").split()
    out = []
    for word in words:
        low = word.lower()
        out.append("FLUX" if low == "flux" else word.upper() if low in ("gpt", "sdxl", "sd", "xl") else
                   word.capitalize() if word.isalpha() else word)
    return " ".join(out)[:48]


def describe_new(provider: str, base_url: str = "", model: str = "", name: str = "") -> dict:
    """A new generator's settings, with DGC's defaults filled in."""
    if provider not in IMAGE_PROVIDERS:
        raise ValueError(f"provider must be one of {', '.join(IMAGE_PROVIDERS)}")
    model = model or DEFAULT_MODELS.get(provider, "")
    label = PROVIDER_LABELS[provider]
    host = urlsplit(router_base_url(base_url)[0]).hostname if base_url else ""
    pretty = model_words(model)
    title = name or (f"{label} on {host}" if host and provider in ("comfyui", "a1111", "localai", "ollama",
                                                                    "openai_compatible") else
                     pretty if pretty.split(" ")[0].lower() in label.lower().split() else
                     f"{label} {pretty}" if pretty else label)
    return {"provider": provider, "name": " ".join(title.split())[:64],
            **({"base_url": base_url} if base_url else {}), **({"model": model} if model else {})}
