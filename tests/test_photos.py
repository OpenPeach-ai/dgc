"""Photos for the model: an iPhone photo (HEIC) becomes a JPEG, and a very large photo is shrunk for
the model to 2,500 pixels on its long side, with whatever converter this computer has.

DGC carries no imaging library, so most of these tests stand a converter in for the real ones and
check what DGC asks of each. One test runs the real converter this computer has, if any.
"""
from __future__ import annotations

import base64
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dgc import photos  # noqa: E402
from dgc.image_views import parse_dimensions  # noqa: E402


def png(width, height, body=b""):
    """A PNG header that says width x height (enough for every check before a converter runs)."""
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 13) + b"IHDR" + ihdr + b"\0\0\0\0" + body


def jpeg(width, height, orientation=None, body=b"\0" * 64):
    """A JPEG's markers: an optional EXIF orientation, then a SOF0 that says width x height."""
    out = b"\xff\xd8"
    if orientation is not None:
        tiff = b"MM\0*" + struct.pack(">I", 8) + struct.pack(">H", 1) + struct.pack(">HHIHH", 0x0112, 3, 1, orientation, 0) + b"\0\0\0\0"
        app1 = b"Exif\0\0" + tiff
        out += b"\xff\xe1" + struct.pack(">H", len(app1) + 2) + app1
    sof = struct.pack(">BHHB", 8, height, width, 3) + b"\x01\x22\x00\x02\x11\x01\x03\x11\x01"
    return out + b"\xff\xc0" + struct.pack(">H", len(sof) + 2) + sof + body + b"\xff\xd9"


def heic(width=4032, height=3024, tiles=True):
    """A HEIF file as an iPhone writes one: ftyp heic, a meta box declaring the grid and its 512-pixel tiles."""
    ftyp = b"ftypheic" + b"\0\0\0\0" + b"mif1heicmiaf"
    ftyp = struct.pack(">I", len(ftyp) + 4) + ftyp
    def ispe(w, h):
        return struct.pack(">I", 20) + b"ispe" + b"\0\0\0\0" + struct.pack(">II", w, h)
    meta = (ispe(512, 512) if tiles else b"") + ispe(width, height)
    meta = struct.pack(">I", len(meta) + 12) + b"meta" + b"\0\0\0\0" + meta
    return ftyp + meta + struct.pack(">I", 16) + b"mdat" + b"\0" * 8


def uri(raw, mime="image/jpeg"):
    return f"data:{mime};base64," + base64.b64encode(raw).decode()


class Fake:
    """A converter that writes a real-looking image of the size it was asked for, and remembers the call."""

    def __init__(self, fails=False):
        self.calls, self.fails = [], fails

    def __call__(self, source, target, kind, side, quality):
        self.calls.append((Path(source).suffix, kind, side, quality))
        if self.fails:
            raise OSError("cannot read this")
        made = parse_dimensions(Path(source).read_bytes()) or (4032, 3024)
        if side and max(made) > side:
            scale = side / max(made)
            made = (round(made[0] * scale), round(made[1] * scale))
        Path(target).write_bytes(jpeg(*made) if kind == "jpeg" else png(*made))


class HeaderTests(unittest.TestCase):
    def test_heic_is_known_by_its_ftyp_box_not_its_name(self):
        self.assertTrue(photos.is_heif(heic()))
        self.assertFalse(photos.is_heif(jpeg(10, 10)))
        self.assertFalse(photos.is_heif(png(10, 10)))
        self.assertFalse(photos.is_heif(b"\0\0\0\x18ftypisom\0\0\0\0isomiso2"), "an MP4 is not a photo")

    def test_an_iphone_photo_says_its_size_as_its_largest_extent(self):
        self.assertEqual(photos.heif_size(heic(4032, 3024)), (4032, 3024))
        self.assertEqual(photos.heif_size(heic(8064, 6048)), (8064, 6048))

    def test_a_jpeg_says_which_way_up_it_is(self):
        self.assertEqual(photos.jpeg_orientation(jpeg(10, 10, orientation=6)), 6)
        self.assertEqual(photos.jpeg_orientation(jpeg(10, 10)), 1)
        self.assertEqual(photos.jpeg_orientation(png(10, 10)), 1)


class ForModelTests(unittest.TestCase):
    def tools(self, *converters):
        return patch.object(photos, "_tools", lambda heic: [(f"tool{i}", c) for i, c in enumerate(converters)])

    def test_a_very_large_photo_goes_to_the_model_at_2500_pixels_as_a_high_quality_jpeg(self):
        fake = Fake()
        with self.tools(fake):
            out = photos.for_model(uri(jpeg(3024, 4032)))
        raw = base64.b64decode(out.split(",", 1)[1])
        self.assertTrue(out.startswith("data:image/jpeg;base64,"))
        self.assertEqual(parse_dimensions(raw), (1875, 2500))
        self.assertEqual(fake.calls, [(".jpg", "jpeg", 2500, 90)])

    def test_a_png_stays_a_png_and_a_small_photo_or_a_gif_is_not_touched(self):
        fake = Fake()
        with self.tools(fake):
            shot = photos.for_model(uri(png(5120, 2880), "image/png"))
            small = uri(jpeg(2500, 1800))
            gif = "data:image/gif;base64," + base64.b64encode(b"GIF89a" + struct.pack("<HH", 6000, 4000) + b"\0" * 8).decode()
            self.assertEqual(photos.for_model(small), small, "never upscaled, never re-encoded")
            self.assertEqual(photos.for_model(gif), gif, "a GIF may move")
        self.assertTrue(shot.startswith("data:image/png;base64,"))
        self.assertEqual(parse_dimensions(base64.b64decode(shot.split(",", 1)[1])), (2500, 1406))
        self.assertEqual(len(fake.calls), 1)

    def test_with_no_converter_or_a_failing_one_the_model_gets_the_original(self):
        big = uri(jpeg(4032, 3024))
        with self.tools():
            self.assertEqual(photos.for_model(big), big)
        with self.tools(Fake(fails=True)):
            self.assertEqual(photos.for_model(big), big)
        self.assertEqual(photos.for_model("not a data uri"), "not a data uri")

    def test_a_converter_that_did_not_shrink_is_not_trusted(self):
        def lazy(source, target, kind, side, quality):
            Path(target).write_bytes(jpeg(4032, 3024))
        with self.tools(lazy, Fake()):
            out = photos.for_model(uri(jpeg(4032, 3024)))
        self.assertEqual(parse_dimensions(base64.b64decode(out.split(",", 1)[1])), (2500, 1875))

    def test_each_of_a_prompts_images_in_order(self):
        big, fake = uri(jpeg(4032, 3024)), Fake()
        with self.tools(fake):
            sent = photos.for_model_all([big, uri(png(1, 1), "image/png")])
        self.assertEqual(parse_dimensions(base64.b64decode(sent[0].split(",", 1)[1])), (2500, 1875))
        self.assertEqual(sent[1], uri(png(1, 1), "image/png"))
        source = Path(photos.__file__).with_name("agent.py").read_text(encoding="utf-8")
        at = source.index("images = self._pending_images")
        self.assertIn("images = for_model_all(images)", source[at:at + 600],
                      "the prompt's images are shrunk where the agent builds the model's message")


class HeicTests(unittest.TestCase):
    def tools(self, *named):
        return patch.object(photos, "_tools", lambda heic: list(named))

    def test_an_iphone_photo_becomes_a_jpeg(self):
        fake = Fake()
        with self.tools(("gdk-pixbuf", fake)):
            made = photos.heic_to_jpeg(heic(4032, 3024))
        self.assertTrue(made.startswith(b"\xff\xd8\xff"))
        self.assertEqual(fake.calls, [(".heic", "jpeg", None, 92)], "a 12 MP photo is kept at full size")

    def test_a_48_megapixel_photo_is_kept_at_4096(self):
        fake = Fake()
        with self.tools(("sips", fake)):
            photos.heic_to_jpeg(heic(8064, 6048))
        self.assertEqual(fake.calls[0][2], 4096)

    def test_with_no_converter_it_says_what_to_install_in_one_sentence(self):
        with self.tools(), self.assertRaises(photos.PhotoError) as raised:
            photos.heic_to_jpeg(heic())
        self.assertEqual(str(raised.exception), photos.HEIC_MISSING)
        self.assertEqual(str(raised.exception).count(". "), 0, "one sentence")
        self.assertNotRegex(str(raised.exception), r"\bAI\b")
        # A converter that may not read HEIC at all (ffmpeg without libheif) failing is the same as none.
        with self.tools(("ffmpeg", Fake(fails=True))), self.assertRaises(photos.PhotoError) as raised:
            photos.heic_to_jpeg(heic())
        self.assertEqual(str(raised.exception), photos.HEIC_MISSING)

    def test_a_photo_a_real_converter_cannot_read_says_so(self):
        with self.tools(("gdk-pixbuf", Fake(fails=True))), self.assertRaises(photos.PhotoError) as raised:
            photos.heic_to_jpeg(heic())
        self.assertEqual(str(raised.exception), photos.HEIC_FAILED)
        with self.assertRaises(photos.PhotoError):
            photos.heic_to_jpeg(jpeg(10, 10))


class CommandLineTests(unittest.TestCase):
    """What each real converter is asked, exactly: no shell, a private folder, and the right options."""

    def run_tool(self, tool, source_bytes, suffix, kind, side, quality=90):
        seen = []
        folder = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, folder, True)
        source, target = folder / ("photo" + suffix), folder / ("out." + ("jpg" if kind == "jpeg" else "png"))
        source.write_bytes(source_bytes)

        def run(argv, **kwargs):
            seen.append((argv, kwargs))
            return subprocess.CompletedProcess(argv, 0)
        with patch.object(photos.subprocess, "run", run), patch.object(photos.shutil, "which", lambda name: "/usr/bin/" + name):
            tool(source, target, kind, side, quality)
        [(argv, kwargs)] = seen
        self.assertNotIn("shell", kwargs)
        self.assertEqual(kwargs["cwd"], str(folder))
        return [str(a).replace(str(folder) + os.sep, "") for a in argv]

    def test_sips(self):
        self.assertEqual(self.run_tool(photos._sips, b"", ".heic", "jpeg", None, 92),
                         ["sips", "-s", "format", "jpeg", "-s", "formatOptions", "92", "photo.heic", "--out", "out.jpg"])
        self.assertEqual(self.run_tool(photos._sips, b"", ".png", "png", 2500),
                         ["sips", "-s", "format", "png", "-Z", "2500", "photo.png", "--out", "out.png"])

    def test_imagemagick_vips_and_libheif(self):
        self.assertEqual(self.run_tool(photos._magick, b"", ".jpg", "jpeg", 2500),
                         ["magick", "photo.jpg", "-auto-orient", "-resize", "2500x2500>", "-unsharp", "0x1.2+0.6+0.008",
                          "-background", "white", "-flatten", "-quality", "90", "jpeg:out.jpg"])
        self.assertEqual(self.run_tool(photos._magick, b"", ".heic", "jpeg", None, 92),
                         ["magick", "photo.heic", "-auto-orient", "-background", "white", "-flatten", "-quality", "92",
                          "jpeg:out.jpg"], "a conversion at full size is not sharpened")
        self.assertEqual(self.run_tool(photos._vips, b"", ".jpg", "jpeg", 2500),
                         ["vipsthumbnail", "photo.jpg", "--size", "2500x2500>", "-o", "out.jpg[Q=90]"])
        self.assertEqual(self.run_tool(photos._libheif, b"", ".heic", "jpeg", None, 92),
                         ["heif-dec", "-q", "92", "photo.heic", "out.jpg"])

    def test_ffmpeg_turns_the_photo_upright_once_and_shrinks_it(self):
        argv = self.run_tool(photos._ffmpeg, jpeg(4032, 3024, orientation=6), ".jpg", "jpeg", 2500)
        self.assertEqual(argv, ["ffmpeg", "-v", "error", "-nostdin", "-y", "-noautorotate", "-i", "photo.jpg",
                                "-vf", "transpose=1,scale=1875:2500:flags=lanczos,unsharp=5:5:0.6:5:5:0.0", "-frames:v", "1",
                                "-q:v", "2", "out.jpg"])

    def test_shrinking_prefers_the_converters_that_sharpen(self):
        # Measured: GdkPixbuf's plain shrink lost a 6.5-point claim reference in up to 10 of 24 reads;
        # ffmpeg's Lanczos with a light unsharp mask lost none. For HEIC, GdkPixbuf reads what ffmpeg can't.
        with patch.object(photos.shutil, "which", lambda name: "/usr/bin/" + name if name == "ffmpeg" else None), \
                patch.object(photos, "_gdk_python", return_value=("/usr/bin/python3", frozenset({"jpeg", "heif/avif"}))), \
                patch.dict(sys.modules, {"PIL": None}):
            self.assertEqual([name for name, _ in photos._tools(False)], ["ffmpeg", "gdk-pixbuf"])
            self.assertEqual([name for name, _ in photos._tools(True)], ["gdk-pixbuf", "ffmpeg"])

    def test_gdk_pixbuf_runs_in_the_systems_own_python_isolated(self):
        with patch.object(photos, "_gdk_python", return_value=("/usr/bin/python3", frozenset({"jpeg", "heif/avif"}))):
            argv = self.run_tool(photos._gdk, b"", ".heic", "jpeg", None, 92)
        self.assertEqual(argv[:3], ["/usr/bin/python3", "-I", "-c"])
        self.assertEqual(argv[4:], ["photo.heic", "out.jpg", "jpeg", "0", "92"])
        self.assertIn("apply_embedded_orientation", argv[3])


class RealConverterTests(unittest.TestCase):
    def test_this_computers_converter_really_shrinks_a_photo(self):
        tools = photos._tools(False)
        if not tools or not shutil.which("ffmpeg"):
            self.skipTest("no converter on this computer to make a fixture with")
        folder = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, folder, True)
        subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-f", "lavfi", "-i", "testsrc=size=3024x4032",
                        "-frames:v", "1", "-q:v", "3", str(folder / "photo.jpg")], check=True, timeout=60)
        raw = (folder / "photo.jpg").read_bytes()
        out = photos.for_model(uri(raw))
        made = base64.b64decode(out.split(",", 1)[1])
        self.assertEqual(parse_dimensions(made), (1875, 2500), [name for name, _ in tools])
        self.assertTrue(made.startswith(b"\xff\xd8\xff"))


if __name__ == "__main__":
    unittest.main()
