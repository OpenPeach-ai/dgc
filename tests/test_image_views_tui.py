"""Model-viewed images in the terminal: the image rows inside a tool step, its toggle row, and the
operating-system opener (never a web browser)."""
import hashlib
import os
from pathlib import Path
import tempfile
import threading
import types
import unittest
from unittest.mock import patch

from prompt_toolkit.mouse_events import MouseEvent, MouseEventType


def bare_tui(project_root: Path):
    from dgc.tui import TUI
    tui = object.__new__(TUI)
    tui.app = None
    tui._width = 120
    tui._flash_msg = ""
    tui._flash_until = 0
    tui._follow = True
    tui._scroll_off = 0
    tui._cur_tool = None
    tui._backend_activity = None
    tui._model_wait = None
    tui._tool_count = 0
    tui.blocks = []
    tui.config = types.SimpleNamespace(project_root=project_root, get=lambda key, default=None: default)
    tui._flush_text = lambda: None
    return tui


def text_of(frags) -> str:
    return "".join(part[1] for part in frags)


def mouse_up():
    return MouseEvent(position=None, event_type=MouseEventType.MOUSE_UP, button=None, modifiers=frozenset())


PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


class TuiImageRowTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="dgc-tui-images-")
        self.root = Path(self.tmp.name) / "project"
        (self.root / ".dgc" / "screenshots").mkdir(parents=True)
        self.tui = bare_tui(self.root)

    def tearDown(self):
        self.tmp.cleanup()

    def meta(self, path: Path, data: bytes = PNG, **extra):
        return {"name": path.name, "path": str(path), "sha256": hashlib.sha256(data).hexdigest(),
                "width": 1280, "height": 757, "bytes": 310 * 1024, "mime": "image/png",
                "source": "browser", "host": "vibedgc.com", "ref": "", **extra}

    def shot(self, name="page-20260914-214633-a1b2c3.png", data=PNG) -> Path:
        path = self.root / ".dgc" / "screenshots" / name
        path.write_bytes(data)
        return path

    def step_with_image(self, output="screenshot of the page saved"):
        self.tui.tool_call("browser", {"operation": "screenshot"}, "call_1")
        self.tui.tool_call("bash", {"command": "ls"}, "call_2")
        self.tui.tool_result("browser", output, "call_1")
        self.tui.tool_result("bash", "a.py", "call_2")
        path = self.shot()
        self.tui.tool_images("call_1", ["data:image/png;base64,AAAA"], "browser screenshot",
                             meta=[self.meta(path)])
        return self.tui.blocks[0]

    def test_attaches_by_call_id_after_the_result(self):
        block = self.step_with_image()
        self.assertEqual(block["call_id"], "call_1")
        self.assertEqual([row["name"] for row in block["images"]], ["page-20260914-214633-a1b2c3.png"])
        self.assertNotIn("images", self.tui.blocks[1])
        self.assertEqual(self.tui._tool_outcome(block), "1 line · 1 image")
        self.assertIn("· 1 line · 1 image", text_of(self.tui._tool_frags(block)))

    def test_one_line_result_has_a_clickable_toggle_row_and_expand_finds_it(self):
        block = self.step_with_image()
        self.assertTrue(self.tui._tool_collapsible(block))
        frags = self.tui._tool_frags(block)
        toggles = [part for part in frags if len(part) == 3 and "1 image — click / /expand" in part[1]]
        self.assertEqual(len(toggles), 1)
        self.assertEqual(toggles[0][1], "▸ 1 image — click / /expand")
        toggles[0][2](mouse_up())
        self.assertTrue(block["exp"], "the toggle row carries the expand handler")
        block["exp"] = False
        hits = [b for b in self.tui.blocks if b.get("kind") == "tool" and self.tui._tool_collapsible(b)]
        self.assertEqual(hits, [block], "/expand finds the image step (and not the one-line command)")

    def test_combined_toggle_when_output_is_also_clamped(self):
        block = self.step_with_image("\n".join(f"line {n}" for n in range(40)))
        rows = [part[1] for part in self.tui._tool_frags(block) if len(part) == 3 and "click" in part[1]]
        self.assertEqual(len(rows), 1)
        self.assertRegex(rows[0], r"^▸ … \d+ more lines · 1 image — click / /expand$")

    def test_expanded_rows_show_name_facts_and_an_open_handler(self):
        block = self.step_with_image()
        block["exp"] = True
        with patch.dict(os.environ, {"DISPLAY": ":0"}):
            frags = self.tui._tool_frags(block)
        text = text_of(frags)
        self.assertIn("page-20260914-214633-a1b2c3.png", text)
        self.assertIn("1280×757 · 310 KB", text)
        self.assertTrue(text.rstrip().endswith("▾ show less"))
        opens = [part for part in frags if len(part) == 3 and part[1].strip() == "open"]
        self.assertEqual(len(opens), 1)
        with patch.object(self.tui, "_open_image") as opener:
            opens[0][2](mouse_up())
        opener.assert_called_once_with(block["images"][0])
        self.assertEqual(text.count("show less"), 1)

    def test_no_display_shows_the_path_instead_of_open(self):
        block = self.step_with_image()
        block["exp"] = True
        with patch.dict(os.environ, {}, clear=True), patch("sys.platform", "linux"):
            text = text_of(self.tui._tool_frags(block))
        self.assertIn(str(self.root / ".dgc" / "screenshots"), text)
        self.assertNotIn("   open", text)

    def test_orphan_images_get_a_step_of_their_own(self):
        path = self.shot("orphan.png")
        self.tui.tool_images(None, [""], "", meta=[self.meta(path)], omitted=2)
        block = self.tui.blocks[-1]
        block["exp"] = True
        with patch.dict(os.environ, {"DISPLAY": ":0"}):
            text = text_of(self.tui._tool_frags(block))
        self.assertIn("Viewed image", text)
        self.assertIn("+2 more not kept", text)


class OpenImageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="dgc-tui-open-")
        self.root = Path(self.tmp.name) / "project"
        (self.root / ".dgc" / "screenshots").mkdir(parents=True)
        self.tui = bare_tui(self.root)
        self.path = self.root / ".dgc" / "screenshots" / "page.png"
        self.path.write_bytes(PNG)
        self.record = {"name": "page.png", "path": str(self.path), "sha256": hashlib.sha256(PNG).hexdigest()}

    def tearDown(self):
        self.tmp.cleanup()

    def open(self, record, env):
        import webbrowser
        with patch.dict(os.environ, env, clear=True), patch("sys.platform", "linux"), \
                patch("shutil.which", return_value="/usr/bin/xdg-open"), \
                patch("subprocess.Popen") as popen, \
                patch.object(webbrowser, "open", side_effect=AssertionError("never a web browser")):
            self.tui._open_image(record)
        return popen

    def test_refuses_paths_outside_the_stores(self):
        outside = Path(self.tmp.name) / "elsewhere.png"
        outside.write_bytes(PNG)
        popen = self.open({**self.record, "path": str(outside)}, {"DISPLAY": ":0"})
        popen.assert_not_called()
        self.assertIn("not an image DGC kept", self.tui._flash_msg)

    def test_no_display_starts_nothing_and_shows_the_path(self):
        popen = self.open(self.record, {})
        popen.assert_not_called()
        self.assertIn("no display to open images here", self.tui._flash_msg)
        self.assertIn(str(self.path), self.tui._flash_msg)

    def test_xdg_open_runs_detached_with_a_display(self):
        import subprocess
        popen = self.open(self.record, {"DISPLAY": ":0"})
        popen.assert_called_once()
        args, kwargs = popen.call_args
        self.assertEqual(args[0], ["xdg-open", os.path.realpath(self.path)])
        self.assertEqual((kwargs["stdin"], kwargs["stdout"], kwargs["stderr"]),
                         (subprocess.DEVNULL, subprocess.DEVNULL, subprocess.DEVNULL))
        self.assertTrue(kwargs["start_new_session"])
        self.assertEqual(self.tui._flash_msg, "opened page.png")

    def test_replaced_file_is_named(self):
        self.path.write_bytes(PNG + b"changed")
        popen = self.open(self.record, {"DISPLAY": ":0"})
        popen.assert_not_called()
        self.assertEqual(self.tui._flash_msg, "page.png was replaced on disk")

    def test_missing_and_session_store_paths(self):
        from dgc import sessions
        popen = self.open({**self.record, "path": str(self.path) + ".gone"}, {"DISPLAY": ":0"})
        popen.assert_not_called()
        self.assertEqual(self.tui._flash_msg, "page.png is no longer stored")
        store = Path(sessions.SESSIONS_DIR) / "slug" / "20260915-000000-abcd.images"
        store.mkdir(parents=True, exist_ok=True)
        stored = store / ("a" * 32 + ".png")
        stored.write_bytes(PNG)
        try:
            popen = self.open({**self.record, "path": str(stored)}, {"WAYLAND_DISPLAY": "wayland-0"})
            popen.assert_called_once()
        finally:
            stored.unlink()


if __name__ == "__main__":
    unittest.main()
