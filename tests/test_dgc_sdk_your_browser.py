"""Pips API 105 in the Python SDK: Your Browser (get_your_browser; set_your_browser_site, sign_out_your_browser_site,
open_your_browser, use_your_browser_view), known with the runtime's own fields, refused before API 105, then sent.
API 107 (106 is the question card in a Pip's chat): get_your_browser_recent, open_your_browser's editor_bounds and the view's op frame, refused before 107; and
(18 Nov) install_google_chrome and the view of your own tab (own, seq, events, tab, width, height), refused before 107."""
import unittest

from test_dgc_sdk_pips import CAPS, Wire, session
from dgc_sdk import DGCUnsupportedError
from dgc_sdk.pips import COMMAND_FIELDS, MUTATION_COMMANDS, READ_COMMANDS

READS = {"get_your_browser": {}, "get_your_browser_recent": {}}
MUTATIONS = {"set_your_browser_site": {"site": "example.com", "mode": "chosen", "pips": ["pip_" + "b" * 32]},
             "sign_out_your_browser_site": {"site": "example.com"},
             "open_your_browser": {"url": "example.com"},
             "use_your_browser_view": {"op": "click", "x": 10, "y": 20},
             "install_google_chrome": {}}


class YourBrowserSDKTests(unittest.TestCase):
    def test_the_sdk_knows_the_runtimes_fields(self):
        from dgc.pips import _COMMAND_ARGS
        for command in (*READS, *MUTATIONS):
            with self.subTest(command=command):
                self.assertEqual(COMMAND_FIELDS[command], _COMMAND_ARGS[command])
        self.assertLessEqual(set(READS), READ_COMMANDS)
        self.assertLessEqual(set(MUTATIONS), MUTATION_COMMANDS)

    def test_refused_before_api105_then_sent(self):
        wire = Wire(); old = session(wire, caps={**CAPS, "pips_api_version": 104})
        with self.assertRaisesRegex(DGCUnsupportedError, "API 105"):
            old.pips.read("get_your_browser", {})
        for command, fields in MUTATIONS.items():
            with self.assertRaisesRegex(DGCUnsupportedError, "API 10[57]"):
                old.pips.mutate(command, fields, approved=True)
        self.assertFalse(wire.calls)
        wire = Wire(); current = session(wire, caps={**CAPS, "pips_api_version": 107})
        for command in READS:
            self.assertEqual(current.pips.read(command, {})["request"]["type"], command)
        for command, fields in MUTATIONS.items():
            with self.subTest(command=command):
                self.assertEqual(current.pips.mutate(command, fields, approved=True)["request"]["type"], command)


    def test_api107_the_recent_links_the_editors_bounds_and_frames_are_refused_before_107(self):
        bounds = {"x": 0, "y": 0, "width": 1200, "height": 800, "screen": {"x": 0, "y": 0, "width": 2560, "height": 1440}}
        wire = Wire(); older = session(wire, caps={**CAPS, "pips_api_version": 106})
        with self.assertRaisesRegex(DGCUnsupportedError, "API 107"):
            older.pips.read("get_your_browser_recent", {})
        with self.assertRaisesRegex(DGCUnsupportedError, "API 107"):
            older.pips.mutate("install_google_chrome", {}, approved=True)
        with self.assertRaisesRegex(DGCUnsupportedError, "API 107"):
            older.pips.mutate("use_your_browser_view", {"op": "input", "own": True,
                                                        "events": [{"t": "text", "text": "hi"}]}, approved=True)
        with self.assertRaisesRegex(DGCUnsupportedError, "API 107"):
            older.pips.mutate("open_your_browser", {"url": "example.com", "editor_bounds": bounds}, approved=True)
        with self.assertRaisesRegex(DGCUnsupportedError, "API 107"):
            older.pips.mutate("use_your_browser_view", {"op": "frame", "pip_id": "pip_" + "a" * 32}, approved=True)
        self.assertFalse(wire.calls)
        wire = Wire(); current = session(wire, caps={**CAPS, "pips_api_version": 107})
        sent = current.pips.mutate("open_your_browser", {"url": "example.com", "editor_bounds": bounds}, approved=True)
        self.assertEqual(sent["request"]["editor_bounds"], bounds)
        self.assertEqual(current.pips.mutate("use_your_browser_view", {"op": "frame", "pip_id": "pip_" + "a" * 32},
                                             approved=True)["request"]["op"], "frame")
        own = current.pips.mutate("use_your_browser_view", {"op": "frame", "own": True, "seq": 3}, approved=True)
        self.assertEqual((own["request"]["own"], own["request"]["seq"]), (True, 3))
        self.assertEqual(current.pips.mutate("install_google_chrome", {}, approved=True)["request"]["type"],
                         "install_google_chrome")

    def test_api112_clear_browsing_data_is_refused_before_112_then_sent(self):
        from dgc.pips import _COMMAND_ARGS
        self.assertEqual(COMMAND_FIELDS["clear_your_browser"], _COMMAND_ARGS["clear_your_browser"])
        self.assertIn("clear_your_browser", MUTATION_COMMANDS)
        wire = Wire(); older = session(wire, caps={**CAPS, "pips_api_version": 111})
        with self.assertRaisesRegex(DGCUnsupportedError, "API 112"):
            older.pips.mutate("clear_your_browser", {"history": True}, approved=True)
        self.assertFalse(wire.calls)
        wire = Wire(); current = session(wire, caps={**CAPS, "pips_api_version": 112})
        sent = current.pips.mutate("clear_your_browser", {"history": True, "sign_ins": False, "passwords": True}, approved=True)
        self.assertEqual({k: sent["request"][k] for k in ("type", "history", "sign_ins", "passwords")},
                         {"type": "clear_your_browser", "history": True, "sign_ins": False, "passwords": True})


if __name__ == "__main__":
    unittest.main()
