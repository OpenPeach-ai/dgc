"""A forced light canvas must remain readable and restore the host's actual defaults."""
import ast
import inspect
import io
import signal
import subprocess
import sys
import textwrap
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from dgc import style, termbg

PROJECT = Path(__file__).resolve().parents[1]


class Config(dict):
    def set(self, key, value):
        self[key] = value


class TTY(io.StringIO):
    def isatty(self):
        return True


class TerminalAppearanceTests(unittest.TestCase):
    def setUp(self):
        self.previous = (style.theme(), termbg._applied, termbg._inherited_theme,
                         termbg._configured, termbg._probed_light)
        self.addCleanup(self.restore)
        termbg._applied, termbg._inherited_theme = False, 'dark'
        termbg._configured, termbg._probed_light = False, None
        style.set_theme('dark')
        self.config = Config(theme='auto', background='inherit')
        self.output, self.input = TTY(), TTY()
        for target, value in [('sys.stdout', self.output), ('sys.stdin', self.input)]:
            mock = patch(target, value)
            mock.start()
            self.addCleanup(mock.stop)

    def restore(self):
        (style._current, termbg._applied, termbg._inherited_theme,
         termbg._configured, termbg._probed_light) = self.previous

    def test_light_sets_matching_canvas_and_foreground_and_restores_inherit(self):
        termbg.switch(self.config, 'light')
        self.assertEqual(style.theme(), style.LIGHT)
        self.assertEqual(self.output.getvalue(), '\x1b]10;#141416\x07\x1b]11;#FFFFFF\x07')
        termbg.switch(self.config, 'inherit')
        self.assertTrue(self.output.getvalue().endswith('\x1b]110\x07\x1b]111\x07'))
        self.assertEqual(style.theme(), style.DARK)
        self.assertFalse(termbg._applied)

    def test_white_alias_and_switching_dark_are_atomic_for_invalid_values(self):
        self.assertTrue(termbg.switch(self.config, 'white'))
        self.assertEqual(self.config['background'], 'light')
        before = self.output.getvalue()
        self.assertFalse(termbg.switch(self.config, 'blurple'))
        self.assertEqual(self.output.getvalue(), before)
        self.assertEqual(self.config['background'], 'light')
        termbg.switch(self.config, 'dark')
        self.assertEqual(style.theme(), style.DARK)
        self.assertTrue(self.output.getvalue().endswith('\x1b]10;#F5F5F5\x07\x1b]11;#0B0B0C\x07'))

    def test_inherit_restores_detected_light_host_without_reading_tui_input(self):
        with patch.object(style, '_detect_theme', return_value='light'):
            termbg.configure(self.config)
        termbg.switch(self.config, 'dark')
        with patch.object(style, '_detect_theme', side_effect=AssertionError('must not read active TUI input')):
            termbg.switch(self.config, 'inherit')
            self.assertEqual(style.theme(), style.LIGHT)
            termbg.switch_theme(self.config, 'auto')
        self.assertEqual(style.theme(), style.LIGHT)

    def test_forced_background_overrides_saved_text_theme_before_first_frame(self):
        self.config.update(theme='dark', background='light')
        termbg.configure(self.config)
        self.assertEqual(style.theme(), style.LIGHT)
        termbg.apply(self.config)
        before = self.output.getvalue()
        termbg.apply(self.config)
        self.assertEqual(self.output.getvalue(), before)

    def test_auto_keeps_legacy_launch_behavior_and_non_tty_emits_no_osc(self):
        self.config.update(background='auto')
        with patch.object(termbg, '_terminal_is_light', return_value=True):
            termbg.apply(self.config)
        self.assertEqual(style.theme(), style.DARK)
        self.assertTrue(termbg._applied)
        termbg.reset()
        with patch('sys.stdout', io.StringIO()) as pipe:
            termbg.switch(self.config, 'light')
            self.assertEqual(pipe.getvalue(), '')
            self.assertFalse(termbg._applied)

    def test_theme_change_keeps_forced_background_readable_and_never_discards_it(self):
        termbg.switch(self.config, 'light')
        # Dark text on the white canvas we painted is unreadable: the canvas has to follow, and
        # the caller reports it by comparing `background` across the call.
        self.assertTrue(termbg.switch_theme(self.config, 'dark'))
        self.assertEqual(self.config['background'], 'dark')
        self.assertEqual(style.theme(), style.DARK)
        self.assertFalse(termbg.switch_theme(self.config, 'invalid'))
        self.assertEqual(self.config['theme'], 'dark')
        # /theme auto means "match the terminal", and the terminal is now the canvas WE painted.
        # It must not quietly throw away the /bg choice the user made on purpose.
        self.assertTrue(termbg.switch_theme(self.config, 'auto'))
        self.assertEqual(self.config['background'], 'dark')
        self.assertEqual(style.theme(), style.DARK)
        self.assertTrue(termbg._applied)
        termbg.switch(self.config, 'light')
        self.assertTrue(termbg.switch_theme(self.config, 'auto'))
        self.assertEqual(self.config['background'], 'light')
        self.assertEqual(style.theme(), style.LIGHT)

    def test_the_terminal_is_asked_what_it_looks_like_exactly_once(self):
        probes = []
        with patch.object(termbg, '_probe_terminal_is_light',
                          side_effect=lambda: probes.append(1) or True):
            self.assertTrue(termbg._terminal_is_light())
            self.assertTrue(termbg._terminal_is_light())
        self.assertEqual(len(probes), 1, 'the OSC 11 round-trip costs ~0.3s and drains stdin')
        # The CLI and the TUI both configure on the way up; the second must not re-detect.
        with patch.object(style, '_detect_theme', return_value='light'):
            termbg.configure(self.config)
        self.assertEqual(termbg._inherited_theme, 'light')
        with patch.object(style, '_detect_theme', side_effect=AssertionError('probed twice')):
            termbg.configure(self.config)

    def classic(self):
        """The classic CLI's slash handler with only what /bg and /theme touch."""
        from dgc.cli import CLI
        cli = object.__new__(CLI)
        cli.config = self.config
        cli.banner = Mock()
        cli.ui = SimpleNamespace(info=Mock(), error=Mock(), refresh_theme=Mock())
        return cli

    def test_classic_bg_and_theme_move_the_console_off_the_old_palette(self):
        cli = self.classic()
        cli.handle_slash('/bg light')
        self.assertEqual(style.theme(), style.LIGHT)
        # The console's rich Theme was resolved when it was built: without this the canvas is
        # white and everything the classic CLI prints onto it is still dark-palette markdown.
        cli.ui.refresh_theme.assert_called()
        cli.ui.refresh_theme.reset_mock()
        cli.handle_slash('/theme dark')
        cli.ui.refresh_theme.assert_called()

    def test_classic_theme_says_so_when_readability_moves_the_canvas(self):
        cli = self.classic()
        cli.handle_slash('/bg light')
        cli.ui.info.reset_mock()
        cli.handle_slash('/theme dark')                 # unreadable on white → the canvas follows
        said = " ".join(str(call.args[0]) for call in cli.ui.info.call_args_list)
        self.assertIn("background → dark", said)
        cli.ui.info.reset_mock()
        cli.handle_slash('/theme auto')                 # no canvas move → nothing to report
        self.assertEqual(self.config['background'], 'dark')
        self.assertNotIn("background →",
                         " ".join(str(call.args[0]) for call in cli.ui.info.call_args_list))

    def test_classic_theme_error_offers_the_values_the_handler_accepts(self):
        cli = self.classic()
        cli.handle_slash('/theme sepia')
        message = str(cli.ui.error.call_args.args[0])
        self.assertIn("auto", message)                  # the handler takes it; the list omitted it
        self.assertIn("dark", message)
        self.assertIn("light", message)

    def test_tui_commands_and_settings_repaint_composer_and_invalidate_old_caches(self):
        from dgc.tui import TUI
        ui = object.__new__(TUI)
        ui.config = self.config
        ui.app = SimpleNamespace(style=None, invalidate=Mock())
        ui._flash = Mock()
        ui._ft_cache = {'old': 'dark'}
        ui._pane_render_cache = ('dark',)
        ui._live_answer_cache = ('dark',)
        ui._handle_slash('/bg light')
        self.assertEqual(ui.app.style.get_attrs_for_style_str('class:composer').color, '141416')
        self.assertEqual(ui._ft_cache, {})
        self.assertIsNone(ui._pane_render_cache)
        self.assertIsNone(ui._live_answer_cache)
        ui._handle_slash('/set background dark')
        self.assertEqual(ui.app.style.get_attrs_for_style_str('class:composer').color.lower(), 'f5f5f5')
        ui.app.invalidate.assert_called()


class ExitRestorationTests(unittest.TestCase):
    """Nothing above notices if every restore call is deleted — these do.

    A repainted terminal that is not handed back outlives DGC: the user's shell keeps DGC's
    canvas until they reset(1) it. Three things restore it, and each one covers an exit the
    others miss — atexit for a normal return, the TUI's own finally for the alt-screen teardown,
    and a signal handler for the one exit that runs neither.
    """

    @staticmethod
    def _tree(func):
        return ast.parse(textwrap.dedent(inspect.getsource(func)))

    @classmethod
    def _calls(cls, node) -> list[str]:
        return [ast.unparse(sub.func) for sub in ast.walk(node) if isinstance(sub, ast.Call)]

    def _finally_restores(self, func) -> bool:
        return any("termbg.reset" in self._calls(statement)
                   for node in ast.walk(self._tree(func))
                   if isinstance(node, ast.Try)
                   for statement in node.finalbody)

    def test_a_normal_exit_restores_the_terminal_from_atexit(self):
        from dgc import cli
        registrations = [
            ast.unparse(node.args[0])
            for node in ast.walk(self._tree(cli.main))
            if isinstance(node, ast.Call) and ast.unparse(node.func) == "atexit.register" and node.args]
        self.assertIn("termbg.reset", registrations,
                      "cli.main must register the restore for an interpreter that exits normally")

    def test_both_session_exits_restore_the_terminal_in_a_finally(self):
        from dgc import cli
        from dgc.tui import TUI
        self.assertTrue(self._finally_restores(cli.main),
                        "cli.main's session must restore the canvas on the way out")
        self.assertTrue(self._finally_restores(TUI.run),
                        "TUI.run must restore the canvas when prompt_toolkit's app returns")

    def test_the_session_installs_a_stop_handler_for_the_exit_atexit_misses(self):
        from dgc import cli
        self.assertIn("termbg.install_stop_handler", self._calls(self._tree(cli.main)))

    def _die_by(self, signame: str) -> subprocess.CompletedProcess:
        script = textwrap.dedent(f"""
            import os, signal, sys
            sys.path.insert(0, {str(PROJECT)!r})
            from dgc import termbg
            termbg._applied = True                     # as if we had repainted the canvas
            handlers = {{}}

            def stop(signum):
                termbg.reset()
                termbg.resend(signum, handlers)

            handlers.update(termbg.install_stop_handler(stop))
            os.kill(os.getpid(), signal.{signame})
            print("survived the signal", flush=True)
        """)
        return subprocess.run([sys.executable, "-c", script], capture_output=True, text=True,
                              timeout=60)

    def test_a_terminating_signal_hands_the_colors_back_and_still_kills_us(self):
        for signame in ("SIGTERM", "SIGHUP"):
            with self.subTest(signal=signame):
                done = self._die_by(signame)
                self.assertIn("\x1b]110\x07\x1b]111\x07", done.stdout,
                              "the host's default fg/bg were never restored")
                self.assertNotIn("survived the signal", done.stdout)
                # Exiting 0 here would tell a supervisor we chose to stop.
                self.assertEqual(done.returncode, -getattr(signal, signame))


if __name__ == '__main__':
    unittest.main()
