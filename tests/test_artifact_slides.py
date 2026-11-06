"""Slides artifacts: a deck is data the model writes, and DGC lays it out.

What matters: a deck that can't be laid out is refused with words a small model can act on (the slide, the field,
what to change); every edit lands where it says or not at all; the page loads nothing from anywhere and runs no
script unless it's presenting; the PowerPoint file is a real one (every part parses, every relationship resolves,
one slide per slide, the notes on the notes pages, charts that keep their numbers); and a chart spec draws.
"""
from __future__ import annotations

import base64
import io
import json
import re
import struct
import sys
import tempfile
import unittest
import zipfile
import zlib
from pathlib import Path
from unittest.mock import patch
from xml.dom import minidom

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dgc import artifact_slides as slides
from dgc import documents
from dgc.artifact_slides import SlidesError
from dgc.artifact_store import Store
from dgc.chatdgc import made


class ImageSniff(unittest.TestCase):
    def test_svg_prologue_and_repeated_comments_are_bounded(self):
        valid = b'<?xml version="1.0"?>\n' + b'<!--ok-->\n' * 200 + b'<!DOCTYPE svg>\n<svg xmlns="http://www.w3.org/2000/svg"/>'
        self.assertEqual(slides._sniff(valid), "image/svg+xml")
        self.assertIsNone(slides._sniff(b'<!--ok-->' * 400 + b'<script>alert(1)</script>'))
        self.assertIsNone(slides._sniff(b'<!--broken' + b'--><!----' * 400 + b'<svg/>'))


def _png(width: int = 40, height: int = 20, rgb=(200, 80, 40)) -> bytes:
    raw = b"".join(b"\x00" + bytes(rgb) * width for _ in range(height))

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


BAR = {"type": "bar", "title": "Weekly active users", "x": ["Jul", "Aug", "Sep"],
       "series": [{"name": "2025", "values": [2150, 2380, 2610]}, {"name": "2026", "values": [3420, 4010, 4860]}]}


def _deck(folder: Path) -> dict:
    (folder / "panel.png").write_bytes(_png())
    return {"size": "16:9", "theme": "paper", "slides": [
        {"layout": "title", "title": "Editor team: Q3 review", "subtitle": "What shipped and what's next",
         "notes": "Ten minutes, then questions."},
        {"layout": "section", "title": "Results"},
        {"layout": "bullets", "title": "The quarter", "bullets": [
            "Shipped the panel on 22 July", {"text": "Weekly users up 38%", "sub": ["Retention 41% to 52%"]}],
         "notes": "Lead with retention.\n\nThen installs."},
        {"layout": "chart", "title": "Users by month", "chart": BAR},
        {"layout": "image", "title": "What shipped", "image": {"src": "panel.png", "alt": "The panel",
                                                                "caption": "Docked in Cursor"},
         "bullets": ["Cards for every tool call"]},
        {"layout": "two_columns", "title": "Worked, and didn't", "left": {"heading": "Worked", "bullets": ["Releases"]},
         "right": {"heading": "Didn't", "bullets": ["Settings page"]}},
        {"layout": "table", "title": "Hours", "table": {"columns": ["Workstream", "Planned", "Actual"],
                                                        "rows": [["Panel", 420, 465], ["Windows", 180, 260]]}},
        {"layout": "quote", "quote": {"text": "I stopped switching windows.", "by": "A staff engineer"}},
        {"layout": "closing", "title": "Questions?", "subtitle": "Team channel"},
    ]}


def _package(raw: bytes) -> dict[str, bytes]:
    """An OOXML package checked the way Office opens one: every XML part parses, every relationship's target is
    there, and every part has a content type."""
    archive = zipfile.ZipFile(io.BytesIO(raw))
    parts = {name: archive.read(name) for name in archive.namelist()}
    assert archive.namelist()[0] == "[Content_Types].xml"
    for name, data in parts.items():
        if name.endswith((".xml", ".rels")):
            minidom.parseString(data)
    types = parts["[Content_Types].xml"].decode()
    defaults = set(re.findall(r'Default Extension="([^"]+)"', types))
    overrides = set(re.findall(r'Override PartName="([^"]+)"', types))
    for name in parts:
        if name != "[Content_Types].xml":
            assert "/" + name in overrides or name.rsplit(".", 1)[-1] in defaults, f"{name} has no content type"
    for name, data in parts.items():
        if not name.endswith(".rels"):
            continue
        base = name.replace("_rels/", "").removesuffix(".rels")
        folder = base.rsplit("/", 1)[0] if "/" in base else ""
        for target, mode in re.findall(r'Target="([^"]+)"(?: TargetMode="([^"]+)")?', data.decode()):
            if mode == "External":
                continue
            path = target.lstrip("/") if target.startswith("/") else "/".join(p for p in (folder, target) if p)
            while "/../" in "/" + path:
                path = re.sub(r"(^|/)[^/]+/\.\./", r"\1", path, count=1)
            assert path in parts, f"{name} points at {path}, which isn't there"
    return parts


class Normalize(unittest.TestCase):
    def setUp(self):
        self.folder = Path(tempfile.mkdtemp(prefix="dgc-slides-"))
        self.deck = _deck(self.folder)

    def test_defaults_are_filled_and_a_normalized_deck_comes_back_unchanged(self):
        d = slides.normalize({"slides": [{"title": "Hello"}, {"title": "Plan", "bullets": ["one"]},
                                         {"title": "Later"}]})
        self.assertEqual((d["size"], d["theme"]), ("16:9", "paper"))
        self.assertEqual([s["layout"] for s in d["slides"]], ["title", "bullets", "section"],
                         "a first slide with only a title is the title slide; content picks its layout")
        full = slides.normalize(self.deck, base=self.folder)
        self.assertEqual(slides.normalize(full), full)
        self.assertEqual(slides.normalize(json.dumps(full)), full, "deck.json as text reads the same")

    def test_an_image_path_is_embedded_and_a_web_address_is_refused(self):
        d = slides.normalize(self.deck, base=self.folder)
        src = d["slides"][4]["image"]["src"]
        self.assertTrue(src.startswith("data:image/png;base64,"))
        self.assertEqual(base64.b64decode(src.split(",", 1)[1]), _png())
        for remote in ("https://example.com/a.png", "http://example.com/a.png", "//cdn.example.com/a.png"):
            bad = json.loads(json.dumps(self.deck))
            bad["slides"][4]["image"]["src"] = remote
            with self.assertRaisesRegex(SlidesError, r"Slide 5's image is on the web .*loads nothing remote"):
                slides.normalize(bad, base=self.folder)

    def test_an_image_must_be_a_real_picture_of_a_kind_slides_show_and_not_too_big(self):
        def deck_with(src):
            return {"slides": [{"layout": "image", "image": {"src": src}}]}
        with self.assertRaisesRegex(SlidesError, r"Slide 1's image: there's no picture at"):
            slides.normalize(deck_with("missing.png"), base=self.folder)
        (self.folder / "a.bmp").write_bytes(b"BM")
        with self.assertRaisesRegex(SlidesError, "PNG, JPEG, GIF, WebP or SVG"):
            slides.normalize(deck_with("a.bmp"), base=self.folder)
        (self.folder / "fake.png").write_text("not a picture")
        with self.assertRaisesRegex(SlidesError, "isn't the PNG picture its name says"):
            slides.normalize(deck_with("fake.png"), base=self.folder)
        big = self.folder / "big.png"
        with open(big, "wb") as handle:
            handle.write(_png())
            handle.truncate(slides.MAX_IMAGE_BYTES + 1)
        with self.assertRaisesRegex(SlidesError, r"at most 10 MB"):
            slides.normalize(deck_with("big.png"), base=self.folder)
        svg = b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60"><rect width="120" height="60"/></svg>'
        d = slides.normalize(deck_with("data:image/svg+xml;base64," + base64.b64encode(svg).decode()))
        self.assertTrue(d["slides"][0]["image"]["src"].startswith("data:image/svg+xml;base64,"))
        for active in (
            b'<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
            b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
            b'<svg xmlns="http://www.w3.org/2000/svg"><use href="https://example.com/icon.svg#x"/></svg>',
        ):
            with self.subTest(active=active):
                with self.assertRaisesRegex(SlidesError, "active or external SVG content"):
                    slides.normalize(deck_with("data:image/svg+xml;base64," + base64.b64encode(active).decode()))
        with self.assertRaisesRegex(SlidesError, "says it's image/png but its bytes aren't"):
            slides.normalize(deck_with("data:image/png;base64," + base64.b64encode(svg).decode()))

    def test_common_passive_svgs_are_kept_and_active_or_external_ones_refused(self):
        def deck_with(svg):
            return {"slides": [{"layout": "image", "image": {"src": "data:image/svg+xml;base64,"
                                                                    + base64.b64encode(svg).decode()}}]}
        ns = b'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"'
        for passive in (
            # Illustrator-style class rules, the standard SVG 1.1 doctype, and a quoted local gradient.
            b"<svg " + ns + b'><style>.a{fill:#c00}</style><rect class="a" width="10" height="10"/></svg>',
            b'<?xml version="1.0"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" '
            b'"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg ' + ns + b'><rect width="10" height="10"/></svg>',
            b"<svg " + ns + b'><defs><linearGradient id="g"/></defs><rect fill="url(\'#g\')" width="10" height="10"/>'
            b'<style>rect{fill:url("#g")}</style></svg>',
        ):
            with self.subTest(passive=passive):
                d = slides.normalize(deck_with(passive))
                self.assertEqual(slides.normalize(d), d)
        for declares in (
            b'<!DOCTYPE svg [<!ENTITY a "aaaa">]><svg ' + ns + b"><text>&a;</text></svg>",
            b'<!DOCTYPE svg SYSTEM "https://example.com/x.dtd" [<!ENTITY a "a">]><svg ' + ns + b"/>",
        ):
            with self.subTest(declares=declares), self.assertRaises(SlidesError):
                slides.normalize(deck_with(declares))
        for active in (
            b"<!DOCTYPE svg [ ]><svg " + ns + b"/>",
            b"<svg " + ns + b"><style>@import url(https://example.com/a.css);</style></svg>",
            b"<svg " + ns + b"><style>rect{fill:url(https://example.com/p.svg#a)}</style><rect/></svg>",
            b"<svg " + ns + b"><style>rect{fill:u\\72l(https://example.com/p.svg#a)}</style><rect/></svg>",
            b"<svg " + ns + b'><rect style="fill:url(\'https://example.com/p.svg#a\')"/></svg>',
        ):
            with self.subTest(active=active):
                with self.assertRaisesRegex(SlidesError, "active or external SVG content"):
                    slides.normalize(deck_with(active))

    def test_errors_name_the_slide_and_the_field_and_say_what_to_change(self):
        cases = [
            ({"slides": [{"title": "x", "body": "y"}]}, r'Slide 1 has "body".*fields are: layout, title'),
            ({"slides": [{"layout": "grid", "title": "x"}]}, r"Slide 1's layout is one of title, section, bullets"),
            ({"slides": [{"layout": "title", "title": "x", "bullets": ["a"]}]},
             r"Slide 1 is a title slide, which doesn't show \"bullets\".*Change its layout, or remove bullets"),
            ({"slides": [{"title": "x"}, {"layout": "bullets", "title": "y", "bullets": ["b"] * 13}]},
             r"Slide 2 has 13 bullets; keep it to 12 or split it across two slides"),
            ({"slides": [{"layout": "bullets", "title": "y"}]}, r"Slide 1 is a bullets slide with no bullets"),
            ({"slides": [{"layout": "section"}]}, r"Slide 1 is a section slide with no title"),
            ({"slides": [{"layout": "closing"}]}, r"Slide 1 is a closing slide with nothing on it"),
            ({"slides": [{"layout": "bullets", "title": "t" * 200, "bullets": ["a"]}]},
             r"Slide 1's title is 200 characters; keep it to 160"),
            ({"slides": [{"title": "x"}] * 61}, r"61 slides; a deck holds at most 60"),
            ({"slides": [{"layout": "table", "table": {"columns": ["a", "b"], "rows": [[1, 2, 3]]}}]},
             r"Slide 1's table's row 1 has 3 cells but the table has 2 columns"),
            ({"slides": [{"layout": "chart", "chart": {"type": "radar", "series": [{"values": [1]}]}}]},
             r"Slide 1's chart's type is one of bar, line, area, pie, scatter"),
            ({"slides": [{"layout": "chart", "chart": {"type": "bar", "series": [{"values": ["n/a"]}]}}]},
             r"Slide 1's chart has no numbers"),
            ({"slides": [{"layout": "chart", "chart": {"type": "bar", "series": [{"values": [1e308]}]}}]},
             r"too large for a readable chart"),
            ({"slides": [{"layout": "two_columns", "title": "x", "left": {"bullets": ["a"]}}]},
             r'Slide 1 is a two_columns slide: give it both "left" and "right"'),
            ({"slides": [{"layout": "bullets", "title": "x", "bullets": ["w" * 300] * 4}]},
             r"Slide 1 has 1,200 characters of bullets; a slide holds about 1,000"),
            ({"theme": "neon", "slides": [{"title": "x"}]}, r"theme is one of paper, dusk, bold, plain"),
            ({"theme": {"bg": "#ffffff", "fg": "#eeeeee", "accent": "#2563eb"}, "slides": [{"title": "x"}]},
             r"contrast of 1\.2:1; text needs at least 4\.5:1"),
            ({"size": "21:9", "slides": [{"title": "x"}]}, r'size is "16:9" or "4:3"'),
            ({"title": "Deck", "slides": [{"title": "x"}]}, r'A deck has "size", "theme" and "slides"'),
        ]
        for deck, pattern in cases:
            with self.subTest(pattern=pattern):
                with self.assertRaisesRegex(SlidesError, pattern):
                    slides.normalize(deck)

    def test_a_theme_of_your_own_is_checked_and_kept(self):
        d = slides.normalize({"theme": {"bg": "#0b1020", "fg": "#F8FAFC", "accent": "#22d3ee", "font": "Inter"},
                              "slides": [{"title": "x"}]})
        self.assertEqual(d["theme"], {"bg": "#0b1020", "fg": "#f8fafc", "accent": "#22d3ee", "font": "Inter"})
        with self.assertRaisesRegex(SlidesError, "one font family's name"):
            slides.normalize({"theme": {"bg": "#fff", "fg": "#000", "accent": "#00f", "font": "x;}body{"},
                              "slides": [{"title": "x"}]})

    def test_chatdgcs_own_table_rows_and_chart_labels_are_understood(self):
        d = slides.normalize({"slides": [
            {"layout": "table", "title": "t", "table": [["Route", "Cap"], ["LRS", 250000]]},
            {"layout": "chart", "chart": {"type": "line", "labels": ["a", "b"], "series": [{"values": ["1,200", 3]}]}}]})
        self.assertEqual(d["slides"][0]["table"], {"columns": ["Route", "Cap"], "rows": [["LRS", 250000]]})
        self.assertEqual(d["slides"][1]["chart"]["x"], ["a", "b"])
        self.assertEqual(d["slides"][1]["chart"]["series"][0]["values"], [1200, 3])

    def test_what_cant_fit_even_in_small_type_is_refused_not_clipped(self):
        rows = [[f"Experiment {i}: guided second session, variant {i}", "Ana", "6 Oct", "27 Oct", 1200 + i, "20%",
                 "52.1%", "Needs a privacy review before launch"] for i in range(15)]
        table = {"columns": ["Experiment", "Owner", "Start", "End", "Users", "Holdout", "Retention", "Notes"],
                 "rows": rows}
        wide = slides.normalize({"slides": [{"layout": "table", "title": "Experiments", "table": table}]})
        self.assertEqual(len(wide["slides"][0]["table"]["rows"]), 15, "a 16:9 slide holds it, in small type")
        with self.assertRaisesRegex(SlidesError, r"Slide 1's table doesn't fit on a 4:3 slide even in small type\. "
                                                 r"It has 15 rows and 8 columns: shorten the longest cells"):
            slides.normalize({"size": "4:3", "slides": [{"layout": "table", "title": "Experiments", "table": table}]})

    def test_the_tool_decides_which_picture_paths_may_be_read(self):
        (self.folder / "inside.png").write_bytes(_png())

        def resolve(path):
            target = (self.folder / path).resolve()
            if self.folder.resolve() not in target.parents:
                raise PermissionError(f"{path} is outside the project; ask the user before using it")
            return target
        ok = slides.normalize({"slides": [{"layout": "image", "image": "inside.png"}]}, resolve=resolve)
        self.assertTrue(ok["slides"][0]["image"]["src"].startswith("data:image/png;base64,"))
        with self.assertRaisesRegex(SlidesError, r"Slide 1's image: \.\./secret\.png is outside the project"):
            slides.normalize({"slides": [{"layout": "image", "image": "../secret.png"}]}, resolve=resolve)
        with self.assertRaisesRegex(SlidesError, r"Edit 1 \(insert\): Slide 2's image: /etc/x\.png is outside"):
            slides.apply_edits(ok, [{"op": "insert", "at": 2, "slide": {"layout": "image", "image": "/etc/x.png"}}],
                               resolve=resolve)

    def test_picture_parent_swapped_after_resolution_is_refused(self):
        folder = self.folder / "pictures"
        folder.mkdir()
        (folder / "inside.png").write_bytes(_png())
        outside = Path(tempfile.mkdtemp(prefix="dgc-slides-outside-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(outside, ignore_errors=True))
        (outside / "inside.png").write_bytes(_png(rgb=(10, 20, 30)))
        original = slides.read_regular_bytes

        def swap(path, *, maximum):
            folder.rename(self.folder / "old-pictures")
            folder.symlink_to(outside)
            return original(path, maximum=maximum)

        with patch.object(slides, "read_regular_bytes", side_effect=swap):
            with self.assertRaisesRegex(SlidesError, "can't be read"):
                slides.normalize({"slides": [{"layout": "image", "image": "pictures/inside.png"}]},
                                 base=self.folder)

    def test_a_theme_of_your_own_gets_series_colours_that_stand_apart_from_its_accent(self):
        palette = slides._palette_for("2DD4BF")
        self.assertEqual((palette[0], len(palette)), ("2DD4BF", 8))
        self.assertNotIn("14B8A6", palette)
        self.assertNotIn("10B981", palette)


class Edits(unittest.TestCase):
    def setUp(self):
        self.folder = Path(tempfile.mkdtemp(prefix="dgc-slides-"))
        self.deck = slides.normalize(_deck(self.folder), base=self.folder)

    def titles(self, deck):
        return [s.get("title") for s in deck["slides"]]

    def test_every_op_lands_where_it_says(self):
        d = slides.apply_edits(self.deck, [{"op": "replace", "slide": 2, "with": {"layout": "section",
                                                                                   "title": "Numbers"}}])
        self.assertEqual(d["slides"][1], {"layout": "section", "title": "Numbers"})
        d = slides.apply_edits(self.deck, {"op": "insert", "at": 3, "slide": {"title": "New", "bullets": ["x"]}})
        self.assertEqual(self.titles(d)[2], "New")
        self.assertEqual(d["slides"][2]["layout"], "bullets")
        d = slides.apply_edits(self.deck, {"op": "insert", "at": 10, "slide": {"layout": "closing", "title": "End"}})
        self.assertEqual(self.titles(d)[-1], "End")
        d = slides.apply_edits(self.deck, [{"op": "delete", "slide": 2}])
        self.assertEqual(len(d["slides"]), 8)
        self.assertNotIn("Results", self.titles(d))
        d = slides.apply_edits(self.deck, [{"op": "move", "slide": 9, "to": 2}])
        self.assertEqual(self.titles(d)[:3], ["Editor team: Q3 review", "Questions?", "Results"])
        d = slides.apply_edits(self.deck, [{"op": "set", "slide": 3, "field": "title", "value": "The quarter, briefly"},
                                           {"op": "set", "slide": 1, "field": "notes", "value": None}])
        self.assertEqual(self.titles(d)[2], "The quarter, briefly")
        self.assertNotIn("notes", d["slides"][0])
        d = slides.apply_edits(self.deck, [{"op": "theme", "value": "dusk"}])
        self.assertEqual(d["theme"], "dusk")
        self.assertEqual(self.titles(self.deck)[1], "Results", "the deck given is never changed")

    def test_edits_apply_in_order_and_each_sees_the_deck_the_last_one_left(self):
        d = slides.apply_edits(self.deck, [{"op": "delete", "slide": 1}, {"op": "set", "slide": 1, "field": "title",
                                                                          "value": "Results, July to September"}])
        self.assertEqual(self.titles(d)[0], "Results, July to September")

    def test_a_bad_edit_says_which_and_why_and_changes_nothing(self):
        cases = [
            ([{"op": "delete", "slide": 12}], r"Edit 1 \(delete\): there's no slide 12; the deck has 9 slides"),
            ([{"op": "set", "slide": 1, "field": "title", "value": "ok"}, {"op": "move", "slide": 1, "to": 0}],
             r"Edit 2 \(move\): there's no slide 0"),
            ([{"op": "insert", "at": 11, "slide": {"title": "x"}}], r"insert at 1 to 10"),
            ([{"op": "rename", "slide": 1}], r"Edit 1's op is one of replace, insert, delete, move, set, theme"),
            ([{"op": "set", "slide": 1, "field": "colour", "value": "red"}], r"Edit 1 \(set\)'s field is one of"),
            ([{"op": "set", "slide": 1, "field": "bullets", "value": ["a"]}],
             r"Edit 1 \(set\): Slide 1 is a title slide, which doesn't show \"bullets\""),
            ([{"op": "replace", "slide": 4, "with": {"layout": "chart", "chart": {"type": "pie"}}}],
             r"Edit 1 \(replace\): Slide 4's chart needs its numbers"),
            ([{"op": "theme", "value": "neon"}], r"Edit 1 \(theme\): theme is one of"),
            ([{"op": "delete", "slide": 1, "to": 2}], r'Edit 1 \(delete\) has "to"'),
            ([{"op": "delete"}], r'Edit 1 \(delete\) needs "slide": a slide number from 1 to 9'),
        ]
        before = json.dumps(self.deck)
        for edits, pattern in cases:
            with self.subTest(pattern=pattern):
                with self.assertRaisesRegex(SlidesError, pattern):
                    slides.apply_edits(self.deck, edits)
        self.assertEqual(json.dumps(self.deck), before)
        with self.assertRaisesRegex(SlidesError, "a deck keeps at least one"):
            slides.apply_edits({"slides": [{"title": "only"}]}, [{"op": "delete", "slide": 1}])

    def test_a_deck_round_trips_through_the_artifact_store(self):
        store = Store(self.folder / "artifacts")
        art = store.create("slides", "Q3 review", self.deck, origin={"surface": "chat"})
        self.assertEqual(store.source(art.id), self.deck)
        edited = slides.apply_edits(store.source(art.id), [{"op": "theme", "value": "bold"}])
        store.update(art.id, edited, base_version=1, summary="Bold theme")
        self.assertEqual(store.source(art.id)["theme"], "bold")
        self.assertEqual(store.source(art.id, 1)["theme"], "paper")


class Page(unittest.TestCase):
    def setUp(self):
        self.folder = Path(tempfile.mkdtemp(prefix="dgc-slides-"))
        self.deck = slides.normalize(_deck(self.folder), base=self.folder)

    def remote_loads(self, page: str) -> list:
        found = re.findall(r'(?:src|href|action|poster|srcset)\s*=\s*"([^"]*)"', page, re.I)
        found += re.findall(r"url\(\s*['\"]?([^'\")]+)", page, re.I)
        found += re.findall(r"@import\s+['\"]?([^'\";]+)", page, re.I)
        return [u for u in found if not u.startswith(("data:", "#"))]

    def test_the_page_loads_nothing_and_runs_nothing_when_viewing(self):
        page = slides.render_html(self.deck)
        self.assertEqual(self.remote_loads(page), [])
        self.assertNotIn("<script", page)
        self.assertNotRegex(page, r"<(link|iframe|object|embed|base)\b")
        self.assertNotRegex(page, r"\son[a-z]+\s*=", "no inline event handlers")
        self.assertIn("default-src 'none'; img-src data:; style-src 'unsafe-inline'", page)
        self.assertEqual(page.count('<section class="slide '), 9)
        self.assertEqual(page.count("<svg "), 1, "the chart is drawn here, as SVG")
        self.assertIn('<details class="notes"><summary>Speaker notes</summary><p>Lead with retention.', page)
        self.assertIn("aspect-ratio:1280/720", page)
        self.assertIn("@page{size:1280px 720px;margin:0}", page)

    def test_presenting_runs_one_script_under_its_nonce(self):
        page = slides.render_html(self.deck, mode="present", nonce="r4nd0mN0nce")
        self.assertEqual(self.remote_loads(page), [])
        self.assertEqual(len(re.findall(r"<script\b", page)), 1)
        self.assertIn('<script nonce="r4nd0mN0nce">', page)
        self.assertIn("script-src 'nonce-r4nd0mN0nce'", page)
        self.assertIn('<style nonce="r4nd0mN0nce">', page)
        self.assertIn('class="slide on L-title', page, "the first slide shows before the script runs")
        for key in ("ArrowRight", "ArrowLeft", "Escape", "requestFullscreen"):
            self.assertIn(key, page)
        self.assertNotRegex(page, r"\son[a-z]+\s*=")
        made_up = slides.render_html(self.deck, mode="present")
        nonce = re.search(r'<script nonce="([^"]+)"', made_up).group(1)
        self.assertIn(f"'nonce-{nonce}'", made_up, "a nonce is made when none is given")
        with self.assertRaises(SlidesError):
            slides.render_html(self.deck, mode="present", nonce="bad nonce'>")

    def test_nothing_the_model_writes_becomes_markup(self):
        evil = '<img src=x onerror=alert(1)></style><script>alert(2)</script>'
        page = slides.render_html({"slides": [{"title": evil, "subtitle": evil}, {"title": evil, "bullets": [evil]},
                                              {"layout": "chart", "chart": dict(BAR, title=evil, x=[evil, "b", "c"])},
                                              {"layout": "quote", "quote": {"text": evil, "by": evil}},
                                              {"layout": "table", "table": {"columns": ["<b>x</b>"], "rows": [[evil]]}}]})
        self.assertNotIn("<script>alert", page)
        self.assertNotIn("<img src=x", page)
        self.assertIn("&lt;script&gt;alert(2)&lt;/script&gt;", page)
        self.assertIn("&lt;b&gt;x&lt;/b&gt;", page)

    def test_text_too_long_for_its_box_is_set_smaller(self):
        short = slides._plan({"layout": "bullets", "title": "Plan", "bullets": ["One", "Two"]}, 1,
                             slides._look("plain"), slides.SIZES["16:9"], 0)
        long = slides._plan({"layout": "bullets", "title": "A considerably longer title, one that would need three "
                             "lines at the largest size on a slide of this width, so it is set smaller to fit in two",
                             "bullets": ["A bullet with a lot to say " * 5] * 6}, 1,
                            slides._look("plain"), slides.SIZES["16:9"], 0)
        self.assertGreater(short["vars"]["bs"], long["vars"]["bs"])
        self.assertGreater(short["vars"]["ts"], long["vars"]["ts"])
        width = 400
        for line in slides._wrap("averyveryverylongwordwithoutanyspaces" * 4 + " and more", width, 30):
            self.assertLessEqual(slides._measure(line, 30), width, "a word longer than the line breaks")

    def test_a_picture_alone_fills_the_slide_with_no_number_over_it(self):
        deck = {"slides": [{"layout": "image", "image": "panel.png"}, {"layout": "image", "title": "With a title",
                                                                       "image": "panel.png"}]}
        page = slides.render_html(slides.normalize(deck, base=self.folder))
        self.assertIn('class="slide L-image full"', page)
        self.assertNotIn('<div class="no" aria-hidden="true">1</div>', page)
        self.assertIn('<div class="no" aria-hidden="true">2</div>', page)
        parts = _package(slides.export_pptx(slides.normalize(deck, base=self.folder)))
        self.assertNotIn("<a:t>1</a:t>", parts["ppt/slides/slide1.xml"].decode())
        self.assertIn("<a:t>2</a:t>", parts["ppt/slides/slide2.xml"].decode())

    def test_a_four_by_three_deck_and_every_theme_render(self):
        for theme in (*slides.THEMES, {"bg": "#101418", "fg": "#f5f5f5", "accent": "#ff7a59", "font": "serif"}):
            page = slides.render_html(dict(self.deck, theme=theme, size="4:3"))
            self.assertIn("aspect-ratio:960/720", page)
            self.assertIn("--u:calc(100cqw/960)", page)


class Charts(unittest.TestCase):
    def test_every_chart_type_draws_as_svg(self):
        specs = [BAR, dict(BAR, stacked=True), dict(BAR, horizontal=True, unit="$"),
                 {"type": "line", "x": ["Mon", "Tue", "Wed"], "series": [{"name": "p95", "values": [120, None, 140]}],
                  "unit": "ms", "y_label": "Latency"},
                 {"type": "area", "x": ["Q1", "Q2"], "series": [{"name": "A", "values": [1, 2]},
                                                                {"name": "B", "values": [2, 3]}], "stacked": True},
                 {"type": "pie", "x": ["Rent", "Food", "Travel"], "series": [{"name": "Spend", "values": [45, 30, 25]}],
                  "unit": "%"},
                 {"type": "scatter", "series": [{"name": "Runs", "points": [[1, 2], [3, 5], ["4", "7"]]}]}]
        for raw in specs:
            with self.subTest(type=raw["type"]):
                spec = slides._chart(raw, "chart")
                svg = slides.chart_svg(spec, 1104, 460, "paper")
                minidom.parseString(svg)
                self.assertTrue(re.search(r"<(rect|path|circle) ", svg))
                self.assertNotIn("NaN", svg)
        bar = slides.chart_svg(slides._chart(BAR, "chart"), 1104, 460, "plain")
        for words in ("Jul", "Sep", "2026", "4,860", "6,000"):
            self.assertIn(f">{words}<", bar, "categories, legend, values and ticks are text")
        pie = slides.chart_svg(slides._chart(specs[5], "chart"), 1104, 460, "dusk")
        self.assertIn(">45%  45%<", pie)

    def test_numbers_read_the_way_chatdgcs_charts_write_them(self):
        self.assertEqual(slides._fmt(1234), "1,234")
        self.assertEqual(slides._fmt(1500000, "$"), "$1.5M")
        self.assertEqual(slides._fmt(-1200, "₹"), "-₹1,200")
        self.assertEqual(slides._fmt(12.5, "%"), "12.5%")
        self.assertEqual(slides._fmt(0.125, "kg"), "0.125 kg")
        self.assertEqual(slides._ticks(0, 4860)[0], [0, 1000, 2000, 3000, 4000, 5000])


class PowerPoint(unittest.TestCase):
    def setUp(self):
        self.folder = Path(tempfile.mkdtemp(prefix="dgc-slides-"))
        self.deck = slides.normalize(_deck(self.folder), base=self.folder)

    def test_a_real_presentation_with_every_slide_and_its_notes(self):
        parts = _package(slides.export_pptx(self.deck))
        self.assertEqual(len([p for p in parts if re.fullmatch(r"ppt/slides/slide\d+\.xml", p)]), 9)
        notes = sorted(p for p in parts if re.fullmatch(r"ppt/notesSlides/notesSlide\d+\.xml", p))
        self.assertEqual(notes, ["ppt/notesSlides/notesSlide1.xml", "ppt/notesSlides/notesSlide3.xml"])
        self.assertIn("Lead with retention.", parts["ppt/notesSlides/notesSlide3.xml"].decode())
        self.assertIn("../notesSlides/notesSlide3.xml", parts["ppt/slides/_rels/slide3.xml.rels"].decode())
        presentation = parts["ppt/presentation.xml"].decode()
        self.assertIn('<p:sldSz cx="12192000" cy="6858000"/>', presentation)
        self.assertIn("<p:notesMasterIdLst>", presentation)
        self.assertLess(presentation.index("<p:notesMasterIdLst>"), presentation.index("<p:sldIdLst>"),
                        "PowerPoint reads the parts of a presentation in the schema's order")
        self.assertIn('type="ctrTitle"', parts["ppt/slides/slide1.xml"].decode())
        self.assertIn("<a:tbl>", parts["ppt/slides/slide7.xml"].decode())
        self.assertIn('lvl="1"', parts["ppt/slides/slide3.xml"].decode(), "a sub-point is a second-level bullet")
        self.assertIn('<a:srgbClr val="F5F0E6"/>', parts["ppt/slides/slide3.xml"].decode(), "the theme's background")
        self.assertIn('<a:latin typeface="Georgia"/>', parts["ppt/theme/theme1.xml"].decode())
        self.assertIn("ppt/media/image1.png", parts)
        text = documents.extract_text(slides.export_pptx(self.deck), "deck.pptx").text
        for words in ("Editor team", "Retention 41% to 52%", "Windows", "I stopped switching windows."):
            self.assertIn(words, text)

    def test_a_chart_is_a_native_chart_that_keeps_its_numbers(self):
        parts = _package(slides.export_pptx(self.deck))
        chart = parts["ppt/charts/chart1.xml"].decode()
        self.assertIn('<c:barDir val="col"/>', chart)
        values = re.search(r"<c:numCache>(.*?)</c:numCache>", chart).group(1)
        self.assertEqual(re.findall(r"<c:v>(\d+)</c:v>", values), ["2150", "2380", "2610"])
        self.assertIn('r:id="rId1"', chart)
        workbook = zipfile.ZipFile(io.BytesIO(parts["ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx"]))
        sheet = workbook.read("xl/worksheets/sheet1.xml").decode()
        self.assertIn("<v>4860</v>", sheet, "Edit Data opens the numbers the chart shows")
        self.assertIn("http://schemas.openxmlformats.org/drawingml/2006/chart", parts["ppt/slides/slide4.xml"].decode())
        for spec in (dict(BAR, horizontal=True), {"type": "pie", "x": ["a", "b"], "series": [{"values": [1, 2]}]},
                     {"type": "line", "x": ["a", "b"], "series": [{"values": [1, 2]}]},
                     {"type": "area", "x": ["a", "b"], "series": [{"values": [1, 2]}], "stacked": True},
                     {"type": "scatter", "series": [{"name": "s", "points": [[1, 2], [2, 3]]}]}):
            with self.subTest(type=spec["type"]):
                one = _package(slides.export_pptx({"slides": [{"layout": "chart", "title": "c", "chart": spec}]}))
                minidom.parseString(one["ppt/charts/chart1.xml"])

    def test_four_by_three_svg_pictures_and_no_notes(self):
        svg = b'<svg xmlns="http://www.w3.org/2000/svg" width="300" height="100"><rect width="300" height="100"/></svg>'
        deck = {"size": "4:3", "theme": "bold", "slides": [
            {"layout": "image", "image": {"src": "data:image/svg+xml;base64," + base64.b64encode(svg).decode()}}]}
        parts = _package(slides.export_pptx(deck))
        self.assertIn('<p:sldSz cx="9144000" cy="6858000"/>', parts["ppt/presentation.xml"].decode())
        self.assertNotIn("notesMasterIdLst", parts["ppt/presentation.xml"].decode())
        self.assertIn("svgBlip", parts["ppt/slides/slide1.xml"].decode(), "PowerPoint draws the SVG itself")
        self.assertTrue(any(p.endswith(".svg") for p in parts) and any(p.endswith(".png") for p in parts))

    def test_chatdgcs_plain_deck_is_unchanged_by_the_theme_options(self):
        self.assertIn('<a:srgbClr val="4F46E5"/>', made._theme())
        self.assertIn('<a:srgbClr val="FFFFFF"/>', made._master())
        themed = made._theme({"accent1": "b4472a", "dk2": "nothex"}, ("Georgia", "Arial"))
        self.assertIn('<a:accent1><a:srgbClr val="B4472A"/></a:accent1>', themed)
        self.assertIn('<a:dk2><a:srgbClr val="1F2937"/></a:dk2>', themed, "a value that isn't a colour is ignored")
        self.assertIn('<a:majorFont><a:latin typeface="Georgia"/>', themed)
        self.assertIn('<a:minorFont><a:latin typeface="Arial"/>', themed)


class Pdf(unittest.TestCase):
    def setUp(self):
        self.folder = Path(tempfile.mkdtemp(prefix="dgc-slides-"))
        self.deck = slides.normalize(_deck(self.folder), base=self.folder)

    def test_the_users_browser_prints_one_slide_a_page(self):
        seen = {}

        class Browser:
            def navigate(self, url):
                with open(url.removeprefix("file://"), encoding="utf-8") as handle:
                    seen["page"] = handle.read()

            def command(self, method, params, timeout=0):
                seen["print"] = (method, params)
                return {"data": base64.b64encode(b"%PDF-1.7\n" + b"<< /Type /Page >>\n" * 9 + b"%%EOF").decode()}
        out = slides.export_pdf(self.deck, self.folder / "out" / "deck.pdf", browser=Browser())
        self.assertEqual((out.pages, out.note), (9, ""))
        self.assertTrue((self.folder / "out" / "deck.pdf").read_bytes().startswith(b"%PDF"))
        method, params = seen["print"]
        self.assertEqual(method, "Page.printToPDF")
        self.assertAlmostEqual(params["paperWidth"], 1280 / 96)
        self.assertAlmostEqual(params["paperHeight"], 7.5)
        self.assertTrue(params["printBackground"] and params["preferCSSPageSize"])
        self.assertFalse(params["displayHeaderFooter"])
        self.assertIn("break-after:page", seen["page"])
        self.assertNotIn("<script", seen["page"])

    def test_without_a_browser_the_plain_writer_makes_one_page_a_slide_and_says_so(self):
        class NoBrowser:
            def navigate(self, url):
                raise RuntimeError("No Chrome or Chromium found. Install one")
        out = slides.export_pdf(self.deck, self.folder / "deck.pdf", browser=NoBrowser())
        self.assertIn("no Chrome or Edge was found", out.note)
        raw = (self.folder / "deck.pdf").read_bytes()
        self.assertEqual(out.pages, 9)
        self.assertEqual(len(re.findall(rb"/Type /Page /Parent", raw)), 9)
        self.assertIn(b"/MediaBox [0 0 960.00 540.00]", raw, "a 16:9 slide's page")
        for offset in re.findall(rb"(\d{10}) 00000 n", raw):
            self.assertRegex(raw[int(offset):int(offset) + 12], rb"^\d+ 0 obj", "the cross-reference table is exact")
        self.assertIn(b"(Weekly users up 38%)", raw)
        self.assertIn(b"(Panel)", raw)
        try:
            from pypdf import PdfReader
        except ImportError:               # DGC's venv has it; a bare system Python may not
            return
        reader = PdfReader(str(self.folder / "deck.pdf"))
        self.assertEqual(len(reader.pages), 9)
        self.assertIn("Weekly users up 38%", reader.pages[2].extract_text())


if __name__ == "__main__":
    unittest.main()
