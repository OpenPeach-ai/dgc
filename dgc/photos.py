"""Photos for the model, made with what the computer already has.

Two jobs, both for photos people send in a chat:

* An iPhone photo (HEIC or HEIF) becomes a JPEG (``heic_to_jpeg``). Neither a model nor the
  editor's Chromium can read HEIC, so the chat keeps the JPEG as the photo you sent.
* A very large photo is shrunk for the model to ``MODEL_LONG_SIDE`` pixels on its long side
  (``for_model``): a high-quality JPEG, or a PNG for a PNG, so the small print on a bill stays
  readable and the request stays a size every provider takes. Nothing is upscaled, and the chat
  keeps the original: only the copy that goes to the model is smaller.

DGC carries no imaging library, so both use the first converter this computer has, in this order:
macOS's ``sips``; Pillow (with pillow-heif for HEIC) when DGC's own Python has it; libvips
(``vipsthumbnail``); ImageMagick (``magick``, or ``convert`` on Linux); libheif's ``heif-dec`` or
``heif-convert`` (HEIC only, no resizing); then, for an iPhone photo, GdkPixbuf through the system's
``python3`` (GNOME desktops such as Ubuntu and Fedora have it, and it reads HEIC when heif-gdk-pixbuf
is installed, as on Ubuntu's desktop) before ``ffmpeg``, and for shrinking ``ffmpeg`` before GdkPixbuf
(it sharpens; see UNSHARP_*). With none of them, a large photo goes to the model as it is (as before),
and an iPhone photo is refused with one sentence saying what to install.
"""
from __future__ import annotations

import base64
import binascii
import functools
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from .image_views import parse_dimensions

MODEL_LONG_SIDE = 2500          # what the model is sent: the long side, in pixels
MODEL_JPEG_QUALITY = 90         # high enough that 7-point print on a photographed page stays sharp
# Shrinking softens edges, and small print is all edges. Measured with deepseek-v4.1-flash on a phone photo of a
# bill (24 runs each, 5 photos per message): a 6.5-point claim reference read exactly 24/24 at 2,500 px from a
# Lanczos shrink with this light unsharp mask (Pillow or ffmpeg), 23/24 without it, and 14-21/24 from GdkPixbuf's
# plain shrink; 24/24 from the original. So shrinking sharpens a little, and GdkPixbuf, which can't, comes last.
UNSHARP_RADIUS, UNSHARP_AMOUNT = 1.2, 0.6
HEIC_LONG_SIDE = 4096           # an iPhone photo bigger than this (24 or 48 MP) is kept at 4096
HEIC_JPEG_QUALITY = 92
MAX_CONVERTED_BYTES = 8 * 1024 * 1024
TOOL_SECONDS = 60
HEIC_TYPES = ("image/heic", "image/heif")
# A file's ftyp brands that say it is HEIF: HEVC stills and sequences, and the generic image brands.
_HEIF_BRANDS = frozenset({b"heic", b"heix", b"hevc", b"hevx", b"heim", b"heis", b"hevm", b"hevs", b"mif1", b"msf1"})
_DATA_URI = re.compile(r"\Adata:(image/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})\Z", re.IGNORECASE)

HEIC_MISSING = ("To send iPhone photos (HEIC) from this computer, install heif-convert "
                "(the libheif-examples package) or send them as JPEG.")
HEIC_FAILED = "This iPhone photo couldn't be converted; send it as a JPEG instead."


class PhotoError(ValueError):
    """A photo DGC could not prepare. The message is one plain sentence for the person who sent it."""


def is_heif(raw: bytes) -> bool:
    """Whether these bytes are a HEIF file (an iPhone's HEIC among them), by its ftyp box."""
    if len(raw) < 16 or raw[4:8] != b"ftyp":
        return False
    size = int.from_bytes(raw[:4], "big")
    if not 16 <= size <= min(len(raw), 4096):
        return False
    brands = [raw[8:12]] + [raw[i:i + 4] for i in range(16, size - 3, 4)]
    return any(brand in _HEIF_BRANDS for brand in brands)


def heif_size(raw: bytes) -> tuple[int, int] | None:
    """The largest image extent (``ispe``) a HEIF file declares before its pixels, or None.

    An iPhone photo is a grid of 512-pixel tiles plus the grid itself; the grid's extent is the
    photo's size, and the largest of them."""
    end = raw.find(b"mdat", 0, 4 * 1024 * 1024)
    head = raw[:end if end > 0 else 1024 * 1024]
    best = None
    at = head.find(b"ispe")
    while at >= 4 and at + 16 <= len(head):
        width = int.from_bytes(head[at + 8:at + 12], "big")
        height = int.from_bytes(head[at + 12:at + 16], "big")
        if 0 < width <= 65535 and 0 < height <= 65535 and (best is None or width * height > best[0] * best[1]):
            best = (width, height)
        at = head.find(b"ispe", at + 4)
    return best


def jpeg_orientation(raw: bytes) -> int:
    """The EXIF orientation (1-8) a JPEG asks viewers to apply, or 1."""
    if not raw.startswith(b"\xff\xd8"):
        return 1
    offset = 2
    while offset + 4 <= min(len(raw), 256 * 1024):
        if raw[offset] != 0xFF:
            return 1
        marker, length = raw[offset + 1], int.from_bytes(raw[offset + 2:offset + 4], "big")
        if marker == 0xDA or length < 2:
            return 1
        body = raw[offset + 4:offset + 2 + length]
        if marker == 0xE1 and body.startswith(b"Exif\0\0") and len(body) >= 14:
            tiff = body[6:]
            order = {b"II": "little", b"MM": "big"}.get(tiff[:2])
            if order is None:
                return 1
            first = int.from_bytes(tiff[4:8], order)
            if first + 2 > len(tiff):
                return 1
            count = int.from_bytes(tiff[first:first + 2], order)
            for index in range(min(count, 256)):
                entry = first + 2 + 12 * index
                if entry + 12 > len(tiff):
                    break
                if int.from_bytes(tiff[entry:entry + 2], order) == 0x0112:
                    value = int.from_bytes(tiff[entry + 8:entry + 10], order)
                    return value if 1 <= value <= 8 else 1
            return 1
        offset += 2 + length
    return 1


# ---- the converters ---------------------------------------------------------------------------------
# Each takes (source, target, kind, max_side, quality), where kind is "jpeg" or "png" and max_side the
# long side to shrink to (None: keep the size), and raises when it could not make the target.

def _run(argv: list[str], cwd: Path) -> None:
    done = subprocess.run(argv, cwd=str(cwd), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                          stderr=subprocess.DEVNULL, timeout=TOOL_SECONDS, check=False)
    if done.returncode != 0:
        raise OSError(f"{Path(argv[0]).name} exited {done.returncode}")


def _sips(source: Path, target: Path, kind: str, side: int | None, quality: int) -> None:
    argv = ["sips", "-s", "format", kind]
    if kind == "jpeg":
        argv += ["-s", "formatOptions", str(quality)]
    if side:
        argv += ["-Z", str(side)]
    _run(argv + [str(source), "--out", str(target)], target.parent)


def _pillow(source: Path, target: Path, kind: str, side: int | None, quality: int) -> None:
    from PIL import Image, ImageOps
    if source.suffix.lower() in (".heic", ".heif"):
        import pillow_heif
        pillow_heif.register_heif_opener()
    with Image.open(source) as opened:
        image = ImageOps.exif_transpose(opened)
        if side and max(image.size) > side:
            from PIL import ImageFilter
            image.thumbnail((side, side), Image.LANCZOS)
            image = image.filter(ImageFilter.UnsharpMask(radius=UNSHARP_RADIUS, percent=round(UNSHARP_AMOUNT * 100), threshold=2))
        if kind == "jpeg":
            if image.mode not in ("RGB", "L"):
                flat = Image.new("RGB", image.size, (255, 255, 255))
                flat.paste(image.convert("RGBA"), mask=image.convert("RGBA").getchannel("A"))
                image = flat
            image.save(target, "JPEG", quality=quality, optimize=True)
        else:
            image.save(target, "PNG", optimize=True)


def _vips(source: Path, target: Path, kind: str, side: int | None, quality: int) -> None:
    # vipsthumbnail turns the photo upright (its EXIF orientation) and ">" only ever shrinks.
    size = f"{side}x{side}>" if side else "100000x100000>"
    options = f"[Q={quality}]" if kind == "jpeg" else ""
    _run(["vipsthumbnail", str(source), "--size", size, "-o", str(target) + options], target.parent)


def _magick(source: Path, target: Path, kind: str, side: int | None, quality: int) -> None:
    program = "magick" if shutil.which("magick") else "convert"
    argv = [program, str(source), "-auto-orient"]
    if side:
        argv += ["-resize", f"{side}x{side}>", "-unsharp", f"0x{UNSHARP_RADIUS}+{UNSHARP_AMOUNT}+0.008"]
    if kind == "jpeg":
        argv += ["-background", "white", "-flatten", "-quality", str(quality)]
    _run(argv + [f"{kind}:{target}"], target.parent)


def _libheif(source: Path, target: Path, kind: str, side: int | None, quality: int) -> None:
    program = "heif-dec" if shutil.which("heif-dec") else "heif-convert"
    _run([program, "-q", str(quality), str(source), str(target)], target.parent)


_GDK_SCRIPT = r"""
import sys
import gi
gi.require_version("GdkPixbuf", "2.0")
from gi.repository import GdkPixbuf
source, target, kind, side, quality = sys.argv[1:6]
image = GdkPixbuf.Pixbuf.new_from_file(source)
image = image.apply_embedded_orientation() or image
side = int(side)
width, height = image.get_width(), image.get_height()
if side and max(width, height) > side:
    scale = side / max(width, height)
    image = image.scale_simple(max(1, round(width * scale)), max(1, round(height * scale)), GdkPixbuf.InterpType.HYPER)
if kind == "jpeg":
    if image.get_has_alpha():
        image = image.composite_color_simple(image.get_width(), image.get_height(), GdkPixbuf.InterpType.NEAREST,
                                             255, 1, 0xFFFFFF, 0xFFFFFF)
    image.savev(target, "jpeg", ["quality"], [quality])
else:
    image.savev(target, "png", [], [])
"""
_GDK_PROBE = ("import gi\ngi.require_version('GdkPixbuf', '2.0')\nfrom gi.repository import GdkPixbuf\n"
              "print(' '.join(f.get_name() for f in GdkPixbuf.Pixbuf.get_formats()))")


@functools.lru_cache(maxsize=1)
def _gdk_python() -> tuple[str, frozenset]:
    """A python3 with GdkPixbuf, and the formats it reads; ("", {}) when there is none."""
    if sys.platform == "darwin" or os.name == "nt":
        return "", frozenset()
    seen = set()
    for candidate in ("/usr/bin/python3", shutil.which("python3") or ""):
        if not candidate or candidate in seen or not os.path.exists(candidate):
            continue
        seen.add(candidate)
        try:
            done = subprocess.run([candidate, "-I", "-c", _GDK_PROBE], stdin=subprocess.DEVNULL,
                                  capture_output=True, text=True, timeout=20, check=False)
        except (OSError, subprocess.SubprocessError):
            continue
        if done.returncode == 0:
            return candidate, frozenset(done.stdout.split())
    return "", frozenset()


def _gdk(source: Path, target: Path, kind: str, side: int | None, quality: int) -> None:
    python, _formats = _gdk_python()
    _run([python, "-I", "-c", _GDK_SCRIPT, str(source), str(target), kind, str(side or 0), str(quality)],
         target.parent)


_FFMPEG_ORIENT = {2: "hflip", 3: "hflip,vflip", 4: "vflip", 5: "transpose=0", 6: "transpose=1",
                  7: "transpose=3", 8: "transpose=2"}


def _ffmpeg(source: Path, target: Path, kind: str, side: int | None, quality: int) -> None:
    raw = source.read_bytes()
    size = parse_dimensions(raw)
    orientation = jpeg_orientation(raw)
    filters = [_FFMPEG_ORIENT[orientation]] if orientation in _FFMPEG_ORIENT else []
    if size and side:
        width, height = size if orientation < 5 else (size[1], size[0])
        if max(width, height) > side:
            scale = side / max(width, height)
            filters.append(f"scale={max(1, round(width * scale))}:{max(1, round(height * scale))}:flags=lanczos")
            filters.append(f"unsharp=5:5:{UNSHARP_AMOUNT}:5:5:0.0")
    # The orientation is applied here, once: -noautorotate keeps a newer ffmpeg from applying it again.
    argv = ["ffmpeg", "-v", "error", "-nostdin", "-y", "-noautorotate", "-i", str(source)]
    if filters:
        argv += ["-vf", ",".join(filters)]
    argv += ["-frames:v", "1"]
    if kind == "jpeg":
        argv += ["-q:v", "2"]
    _run(argv + [str(target)], target.parent)


def _tools(heic: bool) -> list[tuple[str, object]]:
    """The converters this computer has for the job, best first."""
    found: list[tuple[str, object]] = []
    if sys.platform == "darwin" and shutil.which("sips"):
        found.append(("sips", _sips))
    try:
        import PIL  # noqa: F401
        if heic:
            import pillow_heif  # noqa: F401
        found.append(("pillow", _pillow))
    except ImportError:
        pass
    if shutil.which("vipsthumbnail"):
        found.append(("vips", _vips))
    if shutil.which("magick") or (sys.platform.startswith("linux") and shutil.which("convert")):
        found.append(("imagemagick", _magick))
    if heic and (shutil.which("heif-dec") or shutil.which("heif-convert")):
        found.append(("libheif", _libheif))
    python, formats = _gdk_python()
    gdk = [("gdk-pixbuf", _gdk)] if python and (not heic or any("heif" in name for name in formats)) else []
    ffmpeg = [("ffmpeg", _ffmpeg)] if shutil.which("ffmpeg") else []
    # GdkPixbuf reads HEIC where ffmpeg (before 7.1) can't; for shrinking, ffmpeg's Lanczos and sharpening read better.
    return found + (gdk + ffmpeg if heic else ffmpeg + gdk)


# The converters that always read HEIC when they are here. libvips, ImageMagick and ffmpeg read it only
# when they were built with libheif, so a failure of theirs alone means "no converter", not "a bad photo".
_READS_HEIC = frozenset({"sips", "pillow", "libheif", "gdk-pixbuf"})
_MAGIC = {"jpeg": (b"\xff\xd8\xff",), "png": (b"\x89PNG\r\n\x1a\n",)}


def _convert(raw: bytes, suffix: str, kind: str, side: int | None, quality: int, *, heic: bool) -> bytes | None:
    """The first converter's result, or None when this computer has none for the job.

    Raises PhotoError when converters exist but none could make a readable image of these bytes."""
    tools = _tools(heic)
    if not tools:
        return None
    folder = Path(tempfile.mkdtemp(prefix="dgc-photo-"))
    try:
        os.chmod(folder, 0o700)
        source = folder / ("photo" + suffix)
        source.write_bytes(raw)
        tried_sure = False
        for index, (name, tool) in enumerate(tools):
            target = folder / f"out{index}.{'jpg' if kind == 'jpeg' else 'png'}"
            tried_sure = tried_sure or name in _READS_HEIC
            try:
                tool(source, target, kind, side, quality)
                made = target.read_bytes()
            except Exception:
                continue
            size = parse_dimensions(made[:256 * 1024])
            if not made.startswith(_MAGIC[kind]) or size is None:
                continue
            if side and max(size) > side + 1 and name != "libheif":
                continue                       # it did not shrink: not this tool's result to trust
            return made
        if heic and not tried_sure:
            return None                        # only tools that may not read HEIC were here, and none did
        raise PhotoError(HEIC_FAILED if heic else "This photo could not be resized.")
    finally:
        shutil.rmtree(folder, ignore_errors=True)


def heic_to_jpeg(raw: bytes) -> bytes:
    """An iPhone photo (HEIC/HEIF) as a JPEG, at most HEIC_LONG_SIDE on its long side and 8 MiB.

    Raises PhotoError with one plain sentence when this computer can't convert it."""
    if not is_heif(raw):
        raise PhotoError("This file says it is an iPhone photo (HEIC) but isn't one.")
    size = heif_size(raw)
    side = HEIC_LONG_SIDE if size and max(size) > HEIC_LONG_SIDE else None
    made = _convert(raw, ".heic", "jpeg", side, HEIC_JPEG_QUALITY, heic=True)
    if made is None:
        raise PhotoError(HEIC_MISSING)
    shown = parse_dimensions(made[:256 * 1024])
    if shown and (len(made) > MAX_CONVERTED_BYTES or max(shown) > HEIC_LONG_SIDE + 1):
        # A converter that can't resize (libheif) made it full size; shrink that JPEG if anything can.
        try:
            smaller = _convert(made, ".jpg", "jpeg", HEIC_LONG_SIDE, HEIC_JPEG_QUALITY, heic=False)
        except PhotoError:
            smaller = None
        made = smaller or made
    if len(made) > MAX_CONVERTED_BYTES:
        raise PhotoError("This iPhone photo is too large once converted; send a smaller one.")
    return made


def for_model(uri: str) -> str:
    """The image a model is sent: a very large photo shrunk to MODEL_LONG_SIDE, anything else as it is.

    Never raises: when nothing on this computer can shrink it, the model gets the original."""
    try:
        match = _DATA_URI.fullmatch(uri) if isinstance(uri, str) else None
        if match is None:
            return uri
        mime = match.group(1).lower()
        if mime not in ("image/jpeg", "image/png", "image/webp", "image/bmp"):
            return uri                          # a GIF may move; anything else is not ours to touch
        payload = match.group(2)
        head = base64.b64decode(payload[:4 * 87382], validate=True)   # 256 KiB covers any header
        size = parse_dimensions(head)
        if size is None or max(size) <= MODEL_LONG_SIDE:
            return uri
        raw = base64.b64decode(payload, validate=True)
        kind = "png" if mime == "image/png" else "jpeg"
        suffix = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/bmp": ".bmp"}[mime]
        made = _convert(raw, suffix, kind, MODEL_LONG_SIDE, MODEL_JPEG_QUALITY, heic=False)
        if made is None:
            return uri
        return f"data:image/{kind};base64," + base64.b64encode(made).decode("ascii")
    except (PhotoError, binascii.Error, ValueError, OSError):
        return uri


def for_model_all(images):
    """``for_model`` for each of a prompt's images, in order."""
    return [for_model(uri) for uri in images] if images else images


def converters() -> dict:
    """What this computer can do, for diagnostics: the converters for HEIC and for shrinking."""
    return {"heic": [name for name, _ in _tools(True)], "shrink": [name for name, _ in _tools(False)]}
