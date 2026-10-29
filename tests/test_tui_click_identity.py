"""Identical terminal cards must keep their own click handlers after fragment caching."""
import unittest
from types import SimpleNamespace

from prompt_toolkit.mouse_events import MouseEventType

from dgc.tui import TUI


class ClickIdentityTests(unittest.TestCase):
    def test_identical_tool_cards_expand_independently(self):
        tui = object.__new__(TUI)
        tui._width, tui._height, tui._scroll_off = 100, 40, 0
        tui._think, tui._buf, tui._follow = "", "", True
        tui.app = None
        tui._ft_cache = {}
        first = {"kind": "tool", "name": "bash", "summary": "same command",
                 "running": False, "error": False, "exp": False,
                 "out": "\n".join(str(i) for i in range(20))}
        second = first.copy()
        tui.blocks = [first, second]

        tui._transcript()
        cards = [(key, fragments) for key, (fragments, _lines) in tui._ft_cache.items()
                 if key[0] == "tool"]
        self.assertEqual(len(cards), 2)
        second_fragments = next(frags for key, frags in cards if key[-1] == id(second))
        click = next(fragment[2] for fragment in second_fragments
                     if len(fragment) == 3 and "more line" in fragment[1])
        click(SimpleNamespace(event_type=MouseEventType.MOUSE_UP))
        self.assertFalse(first["exp"])
        self.assertTrue(second["exp"])

    def test_custom_host_picker_leaves_subscription_route(self):
        tui = object.__new__(TUI)
        values = {"subscription_engine": "claude", "api_mode": "anthropic"}
        tui.config = SimpleNamespace(set=lambda key, value: values.__setitem__(key, value),
                                     get=lambda key: values.get(key))
        refreshed = []
        tui.agent = SimpleNamespace(refresh_client=lambda: refreshed.append(True))
        tui._flash = lambda message: None
        tui._set_host("http://127.0.0.1:11434/v1", subagent=False)
        self.assertEqual(values["subscription_engine"], "")
        self.assertEqual(values["api_mode"], "auto")
        self.assertEqual(values["base_url"], "http://127.0.0.1:11434/v1")
        self.assertEqual(refreshed, [True])


if __name__ == "__main__":
    unittest.main()
