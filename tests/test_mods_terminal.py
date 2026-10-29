"""Mods in the terminal (dgc/mods/terminal.py, dgc/tui.py) and `dgc mods` (dgc/mods/cli.py): the band and status line
above the prompt under each mod's name, a mod's panel in the focus pane with its buttons, a mod's command run at
once and shown under its name, and the tools for writing one (validate, test)."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from dgc.mods import terminal, ui


class FakeHost:
    def __init__(self):
        self.ui_state = {"tally": {"status": ui.clean({"type": "Text", "text": "3 steps"}),
                                   "band": ui.clean({"type": "Text", "text": "watching"}),
                                   "pane": ui.clean({"type": "Column", "children": [
                                       {"type": "Text", "text": "Steps"},
                                       {"type": "Button", "id": "reset", "label": "Reset"},
                                       {"type": "Button", "id": "save", "label": "Save"}]})},
                         "context": {"status": ui.clean({"type": "Text", "text": "ctx 41%"})}}
        self.running = {"tally": SimpleNamespace(manifest=SimpleNamespace(title="Tally")),
                        "context": SimpleNamespace(manifest=SimpleNamespace(title="Context"))}
        self.actions = []

    def action(self, name, ident, value=None):
        self.actions.append((name, ident))

    def commands(self):
        return [{"name": "tally", "description": "Steps this session", "mod": "tally", "title": "Tally"}]


class Terminal(unittest.TestCase):
    def test_the_band_and_one_status_line_under_each_mods_name(self):
        lines = ["".join(s.text for s in line) for line in terminal.band_lines(FakeHost(), 80)]
        self.assertEqual(lines[0], "Tally  watching")
        self.assertEqual(lines[-1], "Tally 3 steps  ·  Context ctx 41%")
        self.assertEqual(terminal.band_lines(None, 80), [])

    def test_a_panel_is_drawn_under_its_name_and_its_buttons_are_pressed(self):
        host = FakeHost()
        pane = terminal.ModPane(host, "tally", "Tally")
        frame = pane.snapshot(60, 10)
        self.assertEqual(frame.title, "From Tally")
        self.assertIn("[ Reset ]", ["".join(s.text for s in line) for line in frame.lines])
        self.assertEqual(pane.handle_key("tab"), "changed")
        self.assertEqual(pane.handle_key("enter"), "changed")
        self.assertEqual(host.actions, [("tally", "save")])
        self.assertEqual(pane.handle_key("q"), "exit")

    def test_the_palette_offers_a_mods_commands_under_its_name(self):
        rows = terminal.command_rows(FakeHost())
        self.assertEqual(rows, [{"label": "/tally", "desc": "Steps this session · from Tally", "kind": "mod",
                                 "value": "tally"}])

    def test_the_tui_runs_a_mods_command_at_once_and_shows_it_under_its_name(self):
        from dgc.tui import TUI
        tui = object.__new__(TUI)
        appended = []
        tui._append = appended.append
        tui._invalidate = lambda *a, **k: None
        tui._rich = lambda value, **kw: value.plain if hasattr(value, "plain") else str(value)
        tui._width = 80
        host = FakeHost()
        tui.agent = SimpleNamespace(mods=host)
        self.assertTrue(tui._is_mod_command("tally"))
        self.assertFalse(tui._is_mod_command("model"))
        tui._show_mod_result("Tally", {"type": "Text", "text": "3 steps"}, "", 0.01)
        tui._show_mod_result("Tally", "", "It didn't answer command within 10 s.", 10.0)
        self.assertEqual(appended[0], "From Tally\n3 steps")
        self.assertIn("didn't answer", appended[1])


    def test_the_tui_asks_about_a_mod_dgc_wrote_on_a_card_and_answers_with_the_choice(self):
        from dgc.tui import TUI
        tui = object.__new__(TUI)
        asked, flashes, answers = [], [], []
        tui._ask = lambda req, **kw: (asked.append(req), 1)[1]          # Not now
        tui._flash = lambda text, *a: flashes.append(text)
        tui._invalidate = lambda *a, **k: None
        tui.agent = SimpleNamespace(mods=SimpleNamespace(answer_offer=lambda i, allow: answers.append((i, allow))))
        offer = {"id": "mo_1", "name": "counter", "title": "Counter", "version": "1.0.0", "folder": "mods/counter",
                 "asks": ["It can show a line in the status bar.", "It can never approve anything for you."],
                 "more": True}
        tui._mod_ui("offer", offer)
        [card] = asked
        self.assertEqual((card["title"], card["options"]), ("Turn on the mods DGC writes in this session?",
                                                            ["Allow", "Not now"]))
        lines = [t.plain for t in card["header"]]
        self.assertEqual(lines[0], "Counter 1.0.0 · mods/counter")
        self.assertIn("· It can show a line in the status bar.", lines)
        self.assertIn("It asks for more than you allowed for the mods DGC wrote earlier.", lines)
        self.assertEqual(answers, [("mo_1", False)])
        self.assertIn("Not now", flashes[-1])

    def test_mods_says_where_each_came_from(self):
        from dgc.tui import TUI
        tui = object.__new__(TUI)
        opened = []
        tui._open_overlay = lambda rows, **kw: opened.append(rows)
        base = {"version": "1.0.0", "description": "", "error": "", "asks": [], "missing": [], "commands": [],
                "draws": [], "builtin": False, "dev": False, "state": "stopped"}
        host = SimpleNamespace(on=True, mods=lambda: [
            {**base, "name": "a", "title": "A", "plugin": "kit", "plugin_title": "Kit"},
            {**base, "name": "b", "title": "B", "written": True, "dev": True, "state": "needs_allow"}])
        tui.agent = SimpleNamespace(mods=host)
        tui._open_mods()
        [rows] = opened
        self.assertEqual(rows[0]["desc"], "stopped · from the plugin Kit")
        self.assertEqual(rows[1]["desc"], "needs your Allow · written this session")


class DevTools(unittest.TestCase):
    def run_cli(self, *args):
        env = {**os.environ, "PYTHONPATH": str(ROOT), "DGC_HOME": tempfile.mkdtemp(prefix="dgc-modcli-")}
        return subprocess.run([sys.executable, "-m", "dgc.mods.cli", *args], capture_output=True, text=True,
                              env=env, timeout=120)

    def test_validate_and_test_pass_the_builtins(self):
        for name in ("guard", "tally", "context"):
            done = self.run_cli("validate", str(ROOT / "dgc/mods/builtin" / name))
            self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
            self.assertIn("✓ valid", done.stdout)
            done = self.run_cli("test", str(ROOT / "dgc/mods/builtin" / name))
            self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
            self.assertIn("✓ all passed", done.stdout)

    def test_validate_names_what_the_manifest_and_the_code_disagree_on(self):
        folder = Path(tempfile.mkdtemp(prefix="dgc-badmod-")) / "sloppy"
        folder.mkdir()
        (folder / "dgc-mod.json").write_text(json.dumps({"name": "sloppy", "version": "1.0.0", "entry": "main.py",
                                                         "capabilities": {"events": ["turn.complete"],
                                                                          "commands": [{"name": "hi"}]}}))
        (folder / "main.py").write_text(textwrap.dedent("""
            import dgc_mod as dm
            mod = dm.Mod()
            @mod.on("tool.call")
            def c(e):
                return {"decision": "allow"}
            @mod.on("turn.complete")
            def t(e):
                pass
            mod.run()
        """))
        done = self.run_cli("validate", str(folder))
        self.assertEqual(done.returncode, 1)
        self.assertIn("handles tool.call, which its manifest doesn't declare", done.stdout)
        self.assertIn("declares /hi but handles none", done.stdout)
        broken = self.run_cli("validate", str(folder.parent))
        self.assertIn("There's no dgc-mod.json", broken.stdout)


if __name__ == "__main__":
    unittest.main()
