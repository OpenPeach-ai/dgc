"""DGC makes a design: a canvas of artboards the model builds one at a time, each change a version.

What the user asked for: the model writes the index first (named frames that say they are being drawn), then each
artboard as its own version, so the canvas fills while they watch; a new frame is placed in a free spot (80 px apart in
a row, 120 between rows, never over another); the user moves, resizes, renames, duplicates and removes artboards, edits
their text, changes their declared tweaks and adds notes, each a version by "you"; an artboard is one self-contained
HTML page (nothing loaded from the web, real copy); comments point at an artboard or part of one, and Ask DGC changes
only that artboard; it exports as a page, pictures and a PDF.
"""
from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dgc import artifact_service as service
from dgc import artifact_store, artifact_tools

ORIGIN = {"surface": "work", "project": "/tmp/coffee", "session": "s1"}
DESKTOP = ("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Bean There</title><style>"
           "body{margin:0;font-family:system-ui;background:#fbf6ef;color:#2b1d14}h1{font-size:64px}"
           ".cta{background:var(--accent,#b5651d);color:#fff;padding:14px 22px;border-radius:8px}</style></head><body>"
           "<header><h1>Coffee worth waking up for</h1><p>Roasted on Mill Street every morning.</p>"
           "<button class=\"cta\">See the menu</button></header></body></html>")
PHONE = ("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><style>body{margin:0;font-family:system-ui}"
         "h1{font-size:34px}</style></head><body><h1>Coffee worth waking up for</h1><p>Open from 7.</p></body></html>")


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(os.path.realpath(tempfile.mkdtemp(prefix="dgc-design-")))
        self._env = os.environ.get("DGC_HOME")
        os.environ["DGC_HOME"] = str(self.tmp / "home")
        self.changes = []

    def tearDown(self):
        if self._env is None:
            os.environ.pop("DGC_HOME", None)
        else:
            os.environ["DGC_HOME"] = self._env

    def run_tool(self, name, args, author="DGC"):
        return artifact_tools.run(name, args, origin=ORIGIN, author=author,
                                  on_change=lambda view, op: self.changes.append((view["version"], op)))

    def make(self, title="Coffee landing", boards=None):
        boards = boards or [{"title": "Desktop", "size": "desktop"}, {"title": "Phone", "size": "phone"}]
        out = self.run_tool("make_artifact", {"type": "design", "title": title, "data": {"artboards": boards}})
        self.assertTrue(out.startswith("Made Design"), out)
        return out.split("(")[1].split(",")[0]

    def edit(self, aid, *ops, **more):
        return self.run_tool("edit_artifact", {"id": aid, "edits": list(ops), **more})

    def index(self, aid, n=None):
        return artifact_store.store().source(aid, n)

    def board(self, aid, bid):
        return next(b for b in self.index(aid)["boards"] if b["id"] == bid)


class Making(Base):
    def test_the_index_comes_first_with_named_frames_waiting_to_be_drawn(self):
        aid = self.make()
        view = service.view(aid)
        self.assertEqual((view["type"], view["label"], view["version"]), ("design", "Design", 1))
        index = self.index(aid)
        self.assertEqual([(b["id"], b["title"], b["w"], b["h"], b["state"]) for b in index["boards"]],
                         [("b1", "Desktop", 1440, 900, "drawing"), ("b2", "Phone", 390, 844, "drawing")])
        # Only the index is kept so far: no artboard has a file.
        self.assertEqual(sorted(artifact_store.store().version(aid).files), ["design.json"])
        self.assertEqual(view["design"], {"boards": 2, "drawing": 2, "pages": 1})
        self.assertEqual(self.changes, [(1, "made")])

    def test_frames_are_placed_80_apart_in_a_row_and_never_over_another(self):
        aid = self.make()
        b1, b2 = self.board(aid, "b1"), self.board(aid, "b2")
        self.assertEqual((b1["x"], b1["y"]), (0, 0))
        self.assertEqual((b2["x"], b2["y"]), (1440 + 80, 0))

    def test_each_artboard_drawn_is_its_own_version_and_every_screen_hears_each(self):
        aid = self.make()
        self.changes.clear()
        out = self.edit(aid, {"op": "change", "board": "b1", "html": DESKTOP})
        self.assertTrue(out.startswith("Changed Design"), out)
        self.assertIn("b2", out)                              # what is still to draw
        self.assertEqual(self.board(aid, "b1")["state"], "ready")
        self.assertEqual(self.board(aid, "b2")["state"], "drawing")
        self.assertEqual(sorted(artifact_store.store().version(aid).files), ["boards/b1.html", "design.json"])
        self.edit(aid, {"op": "change", "board": "b2", "html": PHONE})
        self.assertEqual([c[0] for c in self.changes], [2, 3])
        versions = service.view(aid)["versions"]
        self.assertEqual([v["summary"] for v in versions[1:]], ["Drew “Desktop”", "Drew “Phone”"])
        # An older version still shows the canvas as it was then: the phone not drawn yet.
        self.assertEqual(sorted(artifact_store.store().version(aid, 2).files), ["boards/b1.html", "design.json"])

    def test_several_ops_in_one_call_are_each_a_version(self):
        aid = self.make()
        self.changes.clear()
        self.edit(aid, {"op": "change", "board": "b1", "html": DESKTOP}, {"op": "change", "board": "b2", "html": PHONE})
        self.assertEqual(self.changes, [(2, "changed"), (3, "changed")])

    def test_artboards_given_with_their_html_at_once_still_fill_one_by_one(self):
        aid = self.make(boards=[{"title": "Desktop", "size": "desktop", "html": DESKTOP},
                                {"title": "Phone", "size": "phone", "html": PHONE}])
        self.assertEqual(self.changes, [(1, "made"), (2, "changed"), (3, "changed")])
        self.assertEqual(self.index(aid, 1)["boards"][0]["state"], "drawing")
        self.assertEqual(self.board(aid, "b2")["state"], "ready")

    def test_a_name_written_as_html_reads_as_words(self):
        out = self.run_tool("make_artifact", {"type": "design", "title": "Kettle &amp; Cane Coffee", "data": {
            "artboards": [{"title": "Desktop &amp; wide", "size": "desktop"}]}})
        aid = out.split("(")[1].split(",")[0]
        self.assertEqual(service.view(aid)["title"], "Kettle & Cane Coffee")
        self.assertEqual(self.board(aid, "b1")["title"], "Desktop & wide")
        self.edit(aid, {"op": "note_add", "kind": "sticky", "text": "Milk &amp; sugar &lt;3"}, {"op": "page_add", "name": "Bits &amp; bobs"},
                  {"op": "rename", "board": "b1", "title": "Tom &#38; Co"})
        index = self.index(aid)
        self.assertEqual(index["notes"][0]["text"], "Milk & sugar <3")
        self.assertEqual(index["pages"][1]["name"], "Bits & bobs")
        self.assertEqual(index["boards"][0]["title"], "Tom & Co")
        self.run_tool("edit_artifact", {"id": aid, "title": "Salt &amp; Pepper"})
        self.assertEqual(service.view(aid)["title"], "Salt & Pepper")
        # (An artboard's own HTML is markup and stays as written.)
        self.edit(aid, {"op": "change", "board": "b1", "html": "<html><body><p>Fish &amp; chips</p></body></html>"})
        self.assertIn("Fish &amp; chips", artifact_store.store().read_file(aid, "boards/b1.html").decode())

    def test_the_model_is_told_not_to_check_its_own_design_by_rendering_it(self):
        said = json.dumps(artifact_tools.EDIT_ARTIFACT)
        self.assertIn("don't render, screenshot or open the design", said)
        aid = self.make(boards=[{"title": "One", "size": "phone"}])
        out = self.edit(aid, {"op": "change", "board": "b1", "html": PHONE})
        self.assertIn("don't render, screenshot or open the design", out)

    def test_a_design_needs_an_artboard(self):
        out = self.run_tool("make_artifact", {"type": "design", "title": "Empty", "data": {"artboards": []}})
        self.assertTrue(out.startswith("error"), out)

    def test_the_tools_say_how_to_build_a_good_artboard(self):
        said = artifact_tools.MAKE_ARTIFACT["function"]["description"] + json.dumps(artifact_tools.MAKE_ARTIFACT) \
            + json.dumps(artifact_tools.EDIT_ARTIFACT)
        for words in ("design", "artboard", "self-contained", "real copy", "one artboard per call", "data-goto"):
            self.assertIn(words, said)
        self.assertIn("design", artifact_tools.MAKE_ARTIFACT["function"]["parameters"]["properties"]["type"]["enum"])


class Changing(Base):
    def drawn(self):
        aid = self.make()
        self.edit(aid, {"op": "change", "board": "b1", "html": DESKTOP})
        self.edit(aid, {"op": "change", "board": "b2", "html": PHONE})
        return aid

    def html(self, aid, bid, n=None):
        return artifact_store.store().read_file(aid, f"boards/{bid}.html", n).decode()

    def test_exact_edits_change_only_that_artboard(self):
        aid = self.drawn()
        before = self.html(aid, "b1")
        out = self.edit(aid, {"op": "change", "board": "Phone",
                              "edits": [{"find": "Open from 7.", "replace": "Open from 6."}]})
        self.assertTrue(out.startswith("Changed Design"), out)
        self.assertIn("Open from 6.", self.html(aid, "b2"))
        self.assertEqual(self.html(aid, "b1"), before)
        self.assertEqual(service.view(aid)["versions"][-1]["summary"], "Changed “Phone”")

    def test_one_op_given_without_its_list_is_still_that_change(self):
        # User test round 2, D9: the model sent one op as an object (or beside the id) instead of a list of one; the call
        # failed, the turn showed a red "failed edit artifact", and the model sent it again. The meaning is plain: do it.
        aid = self.make()
        out = self.run_tool("edit_artifact", {"id": aid, "edits": {"op": "change", "board": "b1", "html": DESKTOP}})
        self.assertTrue(out.startswith("Changed Design"), out)
        self.assertIn("Roasted on Mill Street", artifact_store.store().read_file(aid, "boards/b1.html").decode())
        out = self.run_tool("edit_artifact", {"id": aid, "op": "change", "board": "b2", "html": PHONE})
        self.assertTrue(out.startswith("Changed Design"), out)
        self.assertEqual(service.view(aid)["version"], 3, "two changes, two versions; neither was taken for a read")

    def test_an_exact_edit_must_find_its_words_once(self):
        aid = self.drawn()
        out = self.edit(aid, {"op": "change", "board": "b2", "edits": [{"find": "nowhere", "replace": "x"}]})
        self.assertTrue(out.startswith("error"), out)
        self.assertEqual(service.view(aid)["version"], 3)

    def test_reading_an_artboard_changes_nothing(self):
        aid = self.drawn()
        out = self.edit(aid, {"op": "read", "board": "b2"})
        self.assertIn("Open from 7.", out)
        self.assertIn("nothing has changed", out)
        self.assertEqual(service.view(aid)["version"], 3)
        outline = self.run_tool("edit_artifact", {"id": aid})
        for words in ("b1", "Desktop", "1440", "b2", "Phone", "(1520, 0)"):
            self.assertIn(words, outline)

    def test_a_new_artboard_goes_in_a_free_spot_and_a_new_row_is_120_below(self):
        aid = self.drawn()
        self.edit(aid, {"op": "add", "title": "Tablet", "size": "tablet"})
        b3 = self.board(aid, "b3")
        self.assertEqual((b3["x"], b3["y"], b3["state"]), (1520 + 390 + 80, 0, "drawing"))
        for n in range(4):
            self.edit(aid, {"op": "add", "title": f"Wide {n}", "w": 1920, "h": 1080})
        boards = self.index(aid)["boards"]
        rows = sorted({b["y"] for b in boards})
        self.assertEqual(rows[0], 0)
        self.assertGreater(len(rows), 1)
        self.assertEqual(rows[1], max(b["y"] + b["h"] for b in boards if b["y"] == 0) + 120)
        for i, a in enumerate(boards):
            for b in boards[i + 1:]:
                apart = (a["x"] + a["w"] <= b["x"] or b["x"] + b["w"] <= a["x"]
                         or a["y"] + a["h"] <= b["y"] or b["y"] + b["h"] <= a["y"])
                self.assertTrue(apart, (a["id"], b["id"]))

    def test_the_model_never_puts_a_frame_over_another(self):
        aid = self.drawn()
        out = self.edit(aid, {"op": "move", "board": "b2", "x": 100, "y": 100})
        self.assertTrue(out.startswith("Changed Design"), out)
        b1, b2 = self.board(aid, "b1"), self.board(aid, "b2")
        self.assertFalse(b2["x"] < b1["x"] + b1["w"] and b1["x"] < b2["x"] + b2["w"]
                         and b2["y"] < b1["y"] + b1["h"] and b1["y"] < b2["y"] + b2["h"])
        self.assertIn(f"({b2['x']}, {b2['y']})", out)

    def test_move_resize_rename_duplicate_order_and_remove(self):
        aid = self.drawn()
        self.edit(aid, {"op": "move", "board": "b2", "x": 3000, "y": 40})
        self.edit(aid, {"op": "resize", "board": "b2", "w": 430, "h": 932})
        self.edit(aid, {"op": "rename", "board": "b2", "title": "Phone, large"})
        b2 = self.board(aid, "b2")
        self.assertEqual((b2["x"], b2["y"], b2["w"], b2["h"], b2["title"]), (3000, 40, 430, 932, "Phone, large"))
        self.edit(aid, {"op": "duplicate", "board": "b2"})
        b3 = self.board(aid, "b3")
        self.assertEqual((b3["title"], b3["w"], b3["state"]), ("Phone, large 2", 430, "ready"))
        self.assertEqual(self.html(aid, "b3"), self.html(aid, "b2"))
        self.edit(aid, {"op": "order", "board": "b1", "to": "front"})
        self.assertEqual([b["id"] for b in self.index(aid)["boards"]], ["b2", "b3", "b1"])
        self.edit(aid, {"op": "remove", "board": "b3"})
        self.assertEqual([b["id"] for b in self.index(aid)["boards"]], ["b2", "b1"])
        self.assertNotIn("boards/b3.html", artifact_store.store().version(aid).files)
        summaries = [v["summary"] for v in service.view(aid)["versions"][3:]]
        self.assertEqual(summaries, ["Moved “Phone”", "Resized “Phone”", "Renamed “Phone” to “Phone, large”",
                                     "Duplicated “Phone, large” as “Phone, large 2”", "Brought “Desktop” to the front",
                                     "Removed “Phone, large 2”"])
        # An id is never used again.
        self.edit(aid, {"op": "add", "title": "Again", "size": "phone"})
        self.assertEqual(self.index(aid)["boards"][-1]["id"], "b4")

    def test_notes_and_pages(self):
        aid = self.drawn()
        self.edit(aid, {"op": "note_add", "kind": "title", "text": "Landing page", "over": "b1"})
        self.edit(aid, {"op": "note_add", "kind": "sticky", "text": "Check the hero copy", "color": "pink", "near": "b2"})
        notes = self.index(aid)["notes"]
        self.assertEqual([(n["id"], n["kind"], n["text"]) for n in notes],
                         [("n1", "title", "Landing page"), ("n2", "sticky", "Check the hero copy")])
        self.assertLess(notes[0]["y"], 0)                      # a title sits over its row
        self.edit(aid, {"op": "note_change", "note": "n2", "text": "Hero copy is fine", "color": "green"})
        self.assertEqual(self.index(aid)["notes"][1]["color"], "green")
        self.edit(aid, {"op": "note_remove", "note": "n1"})
        self.assertEqual([n["id"] for n in self.index(aid)["notes"]], ["n2"])
        self.edit(aid, {"op": "page_add", "name": "Checkout"})
        self.edit(aid, {"op": "page_rename", "page": "p1", "name": "Landing"})
        self.assertEqual([(p["id"], p["name"]) for p in self.index(aid)["pages"]], [("p1", "Landing"), ("p2", "Checkout")])
        self.edit(aid, {"op": "add", "title": "Cart", "size": "phone", "page": "Checkout"})
        cart = self.index(aid)["boards"][-1]
        self.assertEqual((cart["page"], cart["x"], cart["y"]), ("p2", 0, 0))

    def test_declared_tweaks_are_css_variables_the_person_changes(self):
        aid = self.make()
        self.edit(aid, {"op": "change", "board": "b1", "html": DESKTOP, "tweaks": [
            {"name": "accent", "label": "Accent colour", "type": "color", "value": "#b5651d"},
            {"name": "badge", "label": "Show the badge", "type": "switch", "value": True}]})
        self.edit(aid, {"op": "tweak", "board": "b1", "name": "accent", "value": "#224466"})
        from dgc import artifact_design as design
        board = self.board(aid, "b1")
        self.assertEqual(board["tweaks"][0]["value"], "#224466")
        css, attrs = design.tweak_style(board["tweaks"])
        self.assertIn("--accent:#224466", css)
        self.assertEqual(attrs, {"data-tweak-badge": "on"})
        out = self.edit(aid, {"op": "tweak", "board": "b1", "name": "accent", "value": "url(http://x)"})
        self.assertTrue(out.startswith("error"), out)


class Rules(Base):
    def refused(self, html, words, **more):
        self.made = getattr(self, "made", 0) + 1
        aid = self.make(title=f"Coffee landing {self.made}")
        out = self.edit(aid, {"op": "change", "board": "b1", "html": html, **more})
        self.assertTrue(out.startswith("error"), out)
        self.assertIn(words, out)
        self.assertEqual(service.view(aid)["version"], 1)

    def test_an_artboard_loads_nothing_from_the_web(self):
        self.refused('<html><head><script src="https://cdn.example.com/x.js"></script></head><body>Hi</body></html>',
                     "self-contained")
        self.refused('<html><head><link rel="stylesheet" href="//fonts.example.com/a.css"></head><body>Hi</body></html>',
                     "self-contained")
        self.refused('<html><body><img src="http://example.com/a.png" alt="a"></body></html>', "self-contained")
        self.refused('<html><head><style>@import url("https://x.example/a.css");</style></head><body>Hi</body></html>',
                     "self-contained")
        self.refused('<html><head><meta http-equiv="refresh" content="0;url=https://example.com"></head><body>Hi</body></html>',
                     "isn't allowed")
        self.refused('<html><body><iframe src="about:blank"></iframe></body></html>', "isn't allowed")

    def test_real_copy_not_filler(self):
        self.refused("<html><body><p>Lorem ipsum dolor sit amet</p></body></html>", "real copy")

    def test_an_interactive_artboard_keeps_its_script_in_script_tags(self):
        self.refused('<html><body><button onclick="go()">Go</button><script>function go(){}</script></body></html>',
                     "addEventListener", interactive=True)

    def test_a_link_to_another_place_is_fine_and_a_fragment_is_wrapped(self):
        aid = self.make()
        out = self.edit(aid, {"op": "change", "board": "b1",
                              "html": '<h1>Hello</h1><a href="https://example.com/menu">Menu</a>'})
        self.assertTrue(out.startswith("Changed Design"), out)
        html = artifact_store.store().read_file(aid, "boards/b1.html").decode()
        self.assertTrue(html.lower().startswith("<!doctype html>"))
        self.assertIn("<h1>Hello</h1>", html)

    def test_a_script_makes_it_interactive_and_goto_names_another_artboard(self):
        aid = self.make(boards=[{"title": "Sign in", "size": "phone"}, {"title": "Welcome", "size": "phone"}])
        self.edit(aid, {"op": "change", "board": "b1", "html":
                        '<html><body><button data-goto="Welcome">Sign in</button>'
                        '<script>document.title="x"</script></body></html>'})
        self.assertTrue(self.board(aid, "b1")["interactive"])
        out = self.edit(aid, {"op": "change", "board": "b2", "html": '<html><body><a data-goto="Nowhere">Back</a></body></html>'})
        self.assertIn("Nowhere", out)                          # said, never refused: the target may come later
        self.assertFalse(self.board(aid, "b2")["interactive"])

    def test_the_whole_design_is_never_rewritten(self):
        aid = self.make()
        out = self.run_tool("edit_artifact", {"id": aid, "data": {"artboards": []}})
        self.assertTrue(out.startswith("error"), out)
        self.assertIn("one artboard", out)


class TheUser(Base):
    def drawn(self):
        aid = self.make()
        self.edit(aid, {"op": "change", "board": "b1", "html": DESKTOP})
        self.edit(aid, {"op": "change", "board": "b2", "html": PHONE})
        return aid

    def test_their_changes_are_versions_by_you_and_may_overlap(self):
        aid = self.drawn()
        view = service.edit(aid, edits=[{"op": "move", "board": "b2", "x": 100, "y": 100}], author="you")
        self.assertEqual(view["versions"][-1]["author"], "you")
        b2 = next(b for b in artifact_store.store().source(aid)["boards"] if b["id"] == "b2")
        self.assertEqual((b2["x"], b2["y"]), (100, 100))

    def test_text_edited_in_place_is_saved_unless_the_artboard_moved_on(self):
        aid = self.drawn()
        rev = self.board(aid, "b2")["rev"]
        mine = PHONE.replace("Open from 7.", "Open from 8.")
        service.edit(aid, edits=[{"op": "change", "board": "b2", "html": mine, "rev": rev}], author="you",
                     note="Edited text")
        self.assertIn("Open from 8.", artifact_store.store().read_file(aid, "boards/b2.html").decode())
        self.assertEqual(service.view(aid)["versions"][-1]["summary"], "Edited text in “Phone”")
        with self.assertRaises(service.ArtifactUseError) as caught:
            service.edit(aid, edits=[{"op": "change", "board": "b2", "html": PHONE, "rev": rev}], author="you")
        self.assertIn("changed since version", str(caught.exception))

    def test_restore_brings_back_the_artboards_of_that_version(self):
        aid = self.drawn()
        service.restore(aid, 2)
        self.assertEqual(sorted(artifact_store.store().version(aid).files), ["boards/b1.html", "design.json"])
        self.assertEqual(self.board(aid, "b2")["state"], "drawing")

    def test_a_rename_keeps_every_artboard(self):
        aid = self.drawn()
        out = self.run_tool("edit_artifact", {"id": aid, "title": "Bean There landing"})
        self.assertTrue(out.startswith("Changed Design"), out)
        self.assertEqual(sorted(artifact_store.store().version(aid).files),
                         ["boards/b1.html", "boards/b2.html", "design.json"])

    def test_compare_says_which_artboards_changed(self):
        aid = self.drawn()
        result = service.compare(aid, 1, 3)
        labels = " | ".join(c["label"] for c in result["changes"])
        self.assertIn("Desktop", labels)
        self.assertIn("Phone", labels)


class Comments(Base):
    def drawn(self):
        aid = self.make()
        self.edit(aid, {"op": "change", "board": "b1", "html": DESKTOP})
        self.edit(aid, {"op": "change", "board": "b2", "html": PHONE})
        return aid

    def test_a_comment_points_at_an_artboard_or_part_of_one(self):
        from dgc import artifact_comments as comments
        aid = self.drawn()
        thread = comments.add(aid, {"kind": "artboard", "board": "b1", "path": "header > h1", "tag": "h1",
                                    "quote": "Coffee worth waking up for"}, "Shorter")
        self.assertEqual(thread["anchor"]["title"], "Desktop")
        whole = comments.add(aid, {"kind": "whole"}, "Nice")
        read = {t["id"]: t for t in comments.threads(aid)}
        self.assertEqual(read[thread["id"]]["found"], "here")
        self.assertIn("Desktop", read[thread["id"]]["where"])
        self.assertIn("Coffee worth waking up for", read[thread["id"]]["part"])
        self.assertIn("design", read[whole["id"]]["where"])
        # Its words go: the thread says so. Its artboard goes: it says that.
        self.edit(aid, {"op": "change", "board": "b1", "edits": [{"find": "Coffee worth waking up for", "replace": "Good coffee"}]})
        self.assertEqual(next(t for t in comments.threads(aid) if t["id"] == thread["id"])["found"], "changed")
        self.edit(aid, {"op": "remove", "board": "b1"})
        gone = next(t for t in comments.threads(aid) if t["id"] == thread["id"])
        self.assertEqual(gone["found"], "changed")
        self.assertIn("removed", gone["where"])

    def test_an_anchor_names_a_real_artboard(self):
        from dgc import artifact_comments as comments
        aid = self.drawn()
        with self.assertRaises(comments.CommentError):
            comments.add(aid, {"kind": "artboard", "board": "b9"}, "Hm")
        with self.assertRaises(comments.CommentError):
            comments.add(aid, {"kind": "text", "quote": "Coffee"}, "Hm")

    def test_ask_dgc_changes_exactly_the_artboard_the_comment_is_on(self):
        from dgc import artifact_comment_turn as turn
        from dgc import artifact_comments as comments
        aid = self.drawn()
        thread = comments.add(aid, {"kind": "artboard", "board": "b1", "quote": "Coffee worth waking up for"},
                              "Make this shorter")
        said = turn.prompt(aid, thread["id"])[1]["content"]
        self.assertIn("b1", said)
        self.assertIn("Coffee worth waking up for", said)
        changed = {"version": 0}
        other = turn._run(aid, thread["id"], "edit_artifact", {"edits": [
            {"op": "change", "board": "b2", "edits": [{"find": "Open from 7.", "replace": "Shut"}]}]}, changed)
        self.assertTrue(other.startswith("error"), other)
        self.assertIn("b1", other)
        ok = turn._run(aid, thread["id"], "edit_artifact", {"edits": [
            {"op": "change", "board": "b1", "edits": [{"find": "Coffee worth waking up for", "replace": "Good coffee"}]}]},
            changed)
        self.assertFalse(ok.startswith("error"), ok)
        self.assertIn("Good coffee", artifact_store.store().read_file(aid, "boards/b1.html").decode())
        self.assertIn("Open from 7.", artifact_store.store().read_file(aid, "boards/b2.html").decode())
        self.assertEqual(service.view(aid)["versions"][-1]["summary"], "From a comment: Changed “Desktop”")
        last = comments.get(aid, thread["id"])["messages"][-1]
        self.assertEqual((last["kind"], last["text"]), ("change", f"Changed “Desktop” (version {service.view(aid)['version']})."))


class FakeBrowser:
    """A browser session that records what it was asked and hands back a picture and a one-page PDF."""

    def __init__(self):
        self.calls, self.pages = [], []

    def navigate(self, url):
        self.pages.append(Path(url[len("file://"):]).read_text(encoding="utf-8"))
        return "loaded"

    def evaluate_json(self, expression, timeout=None):
        return 1234 if "scrollHeight" in expression else 1

    def command(self, method, params=None, timeout=None):
        import base64
        self.calls.append((method, dict(params or {})))
        if method == "Page.captureScreenshot":
            return {"data": base64.b64encode(b"\x89PNG\r\n\x1a\n" + bytes([len(self.calls)])).decode()}
        if method == "Page.printToPDF":
            from pypdf import PdfWriter
            writer, out = PdfWriter(), io.BytesIO()
            writer.add_blank_page(width=params["paperWidth"] * 72, height=params["paperHeight"] * 72)
            writer.write(out)
            return {"data": base64.b64encode(out.getvalue()).decode()}
        return {}


class Showing(Base):
    def drawn(self):
        aid = self.make()
        self.edit(aid, {"op": "change", "board": "b1", "html": DESKTOP, "tweaks": [
            {"name": "accent", "label": "Accent", "type": "color", "value": "#224466"}]})
        self.edit(aid, {"op": "change", "board": "b2", "html": PHONE})
        return aid

    def test_the_page_of_it_frames_each_artboard_with_no_script_and_no_network(self):
        aid = self.drawn()
        files, entry = service.render(aid)
        page = files[entry].decode()
        self.assertEqual(page.count("<iframe"), 2)
        self.assertEqual(page.count('sandbox=""'), 2)
        self.assertNotIn("allow-same-origin", page)
        self.assertIn("default-src &#x27;none&#x27;", page)     # each artboard's own policy, inside its srcdoc
        self.assertIn("Desktop", page)

    def test_formats(self):
        aid = self.drawn()
        self.assertEqual(service.view(aid)["exports"], ["pdf", "html", "zip"])
        self.assertEqual(service.EXPORTS["design"], ("png", "pdf", "html", "zip"))

    def test_one_artboard_as_a_page_of_its_own(self):
        aid = self.drawn()
        path = service.export(aid, "html", board="b1")
        page = path.read_text(encoding="utf-8")
        self.assertEqual(path.name, "Coffee landing - Desktop.html")
        self.assertIn("Coffee worth waking up for", page)
        self.assertIn("--accent:#224466", page)                 # its tweaks, as the canvas shows it
        self.assertIn("default-src 'none'", page)
        whole = service.export(aid, "html").read_text(encoding="utf-8")
        self.assertEqual(whole.count("<iframe"), 2)

    def test_one_artboard_as_a_picture_at_its_size(self):
        aid = self.drawn()
        browser = FakeBrowser()
        path = service.export(aid, "png", board="Phone", browser=browser)
        self.assertEqual(path.name, "Coffee landing - Phone.png")
        self.assertTrue(path.read_bytes().startswith(b"\x89PNG"))
        metrics = [p for m, p in browser.calls if m == "Emulation.setDeviceMetricsOverride"]
        self.assertEqual((metrics[0]["width"], metrics[0]["height"]), (390, 844))
        self.assertIn("default-src 'none'", browser.pages[0])   # the page the browser opens reaches nothing either
        with self.assertRaises(service.ArtifactUseError):
            service.export(aid, "png", browser=browser)         # a picture is of one artboard

    def test_every_artboard_as_pictures_and_the_canvas_as_a_pdf(self):
        aid = self.drawn()
        browser = FakeBrowser()
        path = service.export(aid, "zip", browser=browser)
        with zipfile.ZipFile(path) as zf:
            self.assertEqual(sorted(zf.namelist()), ["1 Desktop.png", "2 Phone.png"])
        pdf = service.export(aid, "pdf", browser=FakeBrowser())
        from pypdf import PdfReader
        pages = PdfReader(str(pdf)).pages
        self.assertEqual(len(pages), 2)
        self.assertEqual(round(float(pages[0].mediabox.width)), 1440 * 72 // 96)
        self.assertEqual(round(float(pages[1].mediabox.height)), 844 * 72 // 96)
        one = service.export(aid, "pdf", board="b2", browser=FakeBrowser())
        self.assertEqual(len(PdfReader(str(one)).pages), 1)

    def test_an_artboard_not_drawn_yet_has_nothing_to_export(self):
        aid = self.make()
        with self.assertRaises(service.ArtifactUseError):
            service.export(aid, "html", board="b1")


class Wire(Base):
    def setUp(self):
        super().setUp()
        from dgc.artifact_commands import ArtifactCommands
        self.events = []
        self.commands = ArtifactCommands(lambda kind, **fields: self.events.append((kind, fields)))

    def drawn(self):
        aid = self.make()
        self.edit(aid, {"op": "change", "board": "b1", "html": DESKTOP})
        return aid

    def test_the_process_offers_designs(self):
        from dgc import editor_protocol
        from dgc.artifact_commands import CAPABILITY
        self.assertEqual(CAPABILITY["artifacts"]["designs"], 1)
        self.assertIn("design", CAPABILITY["artifacts"]["types"])
        self.assertIn("design", editor_protocol.ARTIFACT_TYPES)
        self.assertIn("artifact_design_edit", editor_protocol.COMMAND_FIELDS)
        self.assertIn("board", editor_protocol.COMMAND_FIELDS["artifact_export"])

    def test_the_editor_gets_the_index_and_every_drawn_artboard(self):
        aid = self.drawn()
        self.commands.dispatch({"type": "artifact_get", "request_id": "r1", "id": aid, "content": True})
        kind, fields = self.events[-1]
        self.assertEqual(kind, "artifact_detail")
        self.assertEqual([b["id"] for b in fields["content"]["boards"]], ["b1", "b2"])
        self.assertEqual(list(fields["state"]["boards"]), ["b1"])
        self.assertIn("Coffee worth waking up for", fields["state"]["boards"]["b1"])

    def test_the_persons_change_is_one_command_answered_like_a_save(self):
        aid = self.drawn()
        self.commands.dispatch({"type": "artifact_design_edit", "request_id": "r2", "id": aid,
                                "edits": [{"op": "rename", "board": "b1", "title": "Desktop, wide"}]})
        kind, fields = self.events[-1]
        self.assertEqual((kind, fields["op"], fields["request_id"], fields["surface"]),
                         ("artifact_changed", "changed", "r2", "editor"))
        self.assertEqual(fields["artifact"]["versions"][-1]["author"], "you")
        # A change to an artboard that moved on is a conflict, as a save's is.
        self.commands.dispatch({"type": "artifact_design_edit", "request_id": "r3", "id": aid,
                                "edits": [{"op": "change", "board": "b1", "html": DESKTOP, "rev": 99}]})
        kind, fields = self.events[-1]
        self.assertEqual((kind, fields["reason"]), ("command_rejected", "conflict"))

    def test_a_measured_height_is_kept_beside_the_versions(self):
        aid = self.make(boards=[{"title": "Home", "size": "page"}])
        self.edit(aid, {"op": "change", "board": "b1", "html": DESKTOP})
        before = service.view(aid)["version"]
        self.commands.dispatch({"type": "artifact_design_edit", "request_id": "r4", "id": aid,
                                "edits": [{"op": "measured", "board": "b1", "h": 2400}]})
        self.assertEqual(service.view(aid)["version"], before)
        self.edit(aid, {"op": "add", "title": "Beside", "w": 4000, "h": 400})
        self.edit(aid, {"op": "add", "title": "Below", "w": 4000, "h": 400})
        below = self.index(aid)["boards"][-1]
        self.assertEqual(below["title"], "Below")
        self.assertGreaterEqual(below["y"], 2400 + 120)

    def test_a_pip_makes_one_like_its_other_artifacts(self):
        from dgc import pip_library
        self.assertIn("design", pip_library._ARTIFACT_TYPES)
        aid = self.make()
        items = pip_library.reply_artifacts([{"id": aid, "type": "design", "title": "Coffee landing", "op": "made"}])
        self.assertEqual(items[0]["type"], "design")


if __name__ == "__main__":
    unittest.main()
