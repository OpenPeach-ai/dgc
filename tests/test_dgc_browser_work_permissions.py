"""DGC Browser in a Work session asks the way the user's own signed-in Chrome does (26 Nov): opening a site this session
hasn't used asks, in every mode; Always allow saves that one site (DGCBrowser(dgc-browser:https://site)), never a bare
DGCBrowser rule; a site the user allowed this session opens again without asking; steps on its tab don't ask (it opens
nothing else); a deny rule wins. The SDKs name the tool the same way (tests/test_dgc_sdk_policy.py checks the table)."""
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from dgc import dgc_browser_work, tools
from dgc.llm import ToolCall
from dgc.permissions import ALLOW, ASK, DENY, PermissionEngine, rule_for

OPEN = {"op": "open", "url": "https://www.tiles-shop.com/orders"}


def engine(mode="default", allow=(), deny=()):
    return PermissionEngine(mode, {"allow": list(allow), "ask": [], "deny": list(deny)})


class DgcBrowserAsks(unittest.TestCase):
    def test_a_new_site_asks_in_every_mode_auto_included(self):
        for mode in ("default", "accept_edits", "auto"):
            with self.subTest(mode=mode):
                self.assertEqual(engine(mode).decide("dgc_browser", OPEN)[0], ASK)
        self.assertEqual(engine().decide("dgc_browser", {"op": "tabs", "action": "open", "url": "https://bank-of-tiles.com/"})[0], ASK)

    def test_a_site_allowed_this_session_opens_again_without_asking(self):
        self.assertEqual(engine().decide("dgc_browser", {**OPEN, "_session_sites": ["tiles-shop.com"]})[0], ALLOW)
        self.assertEqual(engine().decide("dgc_browser", {"op": "open", "url": "https://other.com/", "_session_sites": ["tiles-shop.com"]})[0], ASK)

    def test_steps_on_its_tab_dont_ask(self):
        for op in ("read", "click", "type", "press", "scroll", "look", "status"):
            with self.subTest(op=op):
                self.assertEqual(engine().decide("dgc_browser", {"op": op, "ref": "e1"})[0], ALLOW)

    def test_always_allow_saves_one_site_never_the_whole_browser(self):
        rule = rule_for("dgc_browser", OPEN)
        self.assertEqual(rule, "DGCBrowser(dgc-browser:https://www.tiles-shop.com)")
        self.assertEqual(rule_for("dgc_browser", {"op": "read"}), "DGCBrowser(dgc-browser:)")
        saved = engine(allow=[rule])
        self.assertEqual(saved.decide("dgc_browser", {"op": "open", "url": "https://www.tiles-shop.com/cart"})[0], ALLOW)
        self.assertEqual(saved.decide("dgc_browser", {"op": "open", "url": "https://bank-of-tiles.com/"})[0], ASK)

    def test_a_deny_rule_wins(self):
        self.assertEqual(engine(deny=["DGCBrowser(dgc-browser:https://www.tiles-shop.com*)"]).decide("dgc_browser", OPEN)[0], DENY)

    def test_an_address_that_isnt_one_site_asks(self):
        self.assertEqual(engine().decide("dgc_browser", {"op": "open", "url": "https://bank.com\\\\@ok.com/"})[0], ASK)


class NothingToAsk(unittest.TestCase):
    """Live, 26 Nov: with Pips off, "Use example.com in DGC Browser?" was asked, the user allowed it, and the step then
    said Pips aren't running. Where DGC Browser can't open anything now (dgc_browser_work.closed), opening a site asks
    nothing: the call says why, the tool opens nothing, and the site never becomes one the user allowed this session."""

    def harness(self, mode):
        from test_subagents import Harness
        directory = tempfile.TemporaryDirectory(prefix="dgc-browser-closed-")
        self.addCleanup(directory.cleanup)
        harness = Harness(Path(directory.name), mode=mode)
        self.addCleanup(harness.close)
        return harness

    def asked(self, harness):
        return [f for f in harness.stream.frames() if f["type"] in ("permission_request", "ask_request", "options_request")]

    def test_pips_off_asks_nothing_in_any_mode_and_the_site_never_joins(self):
        for mode in ("default", "acceptEdits", "auto"):
            with self.subTest(mode=mode):
                harness = self.harness(mode)
                with patch.object(dgc_browser_work, "closed", return_value=dgc_browser_work.PIPS_OFF), \
                        patch.object(dgc_browser_work, "step") as step:
                    out = harness.agent._handle_call(ToolCall("b1", "dgc_browser", dict(OPEN)))
                self.assertIn(dgc_browser_work.PIPS_OFF, out)
                self.assertEqual(self.asked(harness), [], "no card, no question")
                step.assert_not_called()
                self.assertEqual(tools.dgc_browser_sites(harness.agent.ctx), set())

    def test_where_it_can_open_the_site_a_new_site_still_asks(self):
        harness = self.harness("default")
        harness.answer("permission_request", {"decision": "deny"})
        with patch.object(dgc_browser_work, "closed", return_value=""), patch.object(dgc_browser_work, "step") as step:
            out = harness.agent._handle_call(ToolCall("b1", "dgc_browser", dict(OPEN)))
        self.assertEqual(len([f for f in harness.stream.frames() if f["type"] == "permission_request"]), 1)
        self.assertIn("The user DENIED this action", out)
        step.assert_not_called()

    def test_the_model_cant_skip_the_card_by_sending_the_marker(self):
        harness = self.harness("default")
        harness.answer("permission_request", {"decision": "deny"})
        with patch.object(dgc_browser_work, "closed", return_value=""), patch.object(dgc_browser_work, "step") as step:
            out = harness.agent._handle_call(ToolCall("b1", "dgc_browser", {**OPEN, "_dgc_browser_closed": "nothing to see"}))
        self.assertEqual(len([f for f in harness.stream.frames() if f["type"] == "permission_request"]), 1, "it still asks")
        self.assertNotIn("nothing to see", out)


if __name__ == "__main__":
    unittest.main()
