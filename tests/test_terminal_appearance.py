"""A forced light canvas must remain readable and restore the host's actual defaults."""
import io
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from dgc import style, termbg


class Config(dict):
    def set(self, key, value):
        self[key] = value


class TTY(io.StringIO):
    def isatty(self):
        return True


class TerminalAppearanceTests(unittest.TestCase):
    def setUp(self):
        self.previous = (style.theme(), termbg._applied, termbg._inherited_theme)
        self.addCleanup(self.restore)
        termbg._applied, termbg._inherited_theme = False, 'dark'
        style.set_theme('dark')
        self.config = Config(theme='auto', background='inherit')
        self.output, self.input = TTY(), TTY()
        for target, value in [('sys.stdout', self.output), ('sys.stdin', self.input)]:
            mock = patch(target, value)
            mock.start()
            self.addCleanup(mock.stop)

    def restore(self):
        style._current, termbg._applied, termbg._inherited_theme = self.previous

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

    def test_theme_change_keeps_forced_background_readable_and_auto_restores_host(self):
        termbg.switch(self.config, 'light')
        self.assertTrue(termbg.switch_theme(self.config, 'dark'))
        self.assertEqual(self.config['background'], 'dark')
        self.assertEqual(style.theme(), style.DARK)
        self.assertFalse(termbg.switch_theme(self.config, 'invalid'))
        self.assertEqual(self.config['theme'], 'dark')
        self.assertTrue(termbg.switch_theme(self.config, 'auto'))
        self.assertEqual(self.config['background'], 'inherit')
        self.assertFalse(termbg._applied)

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


if __name__ == '__main__':
    unittest.main()
