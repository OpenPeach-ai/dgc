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



class NamedGoesThere(unittest.TestCase):
    """Live, 26 Nov (packaged 230f7048): "Use the DGC browser: open https://example.com ..." was opened with the browser
    tool, the model saying "as instructed" (the order rule for "my browser"), about 1 in 700 times on the editor's own
    request; no tool wording changed that without sending "check my browser" to DGC Browser first more often.
    Now a turn whose message names DGC Browser answers its first browser open "use dgc_browser",
    once, without asking anything; the next browser call runs; a message that doesn't name it is untouched."""

    def harness(self, mode="default"):
        from test_subagents import Harness
        directory = tempfile.TemporaryDirectory(prefix="dgc-browser-named-")
        self.addCleanup(directory.cleanup)
        harness = Harness(Path(directory.name), mode=mode)
        self.addCleanup(harness.close)
        return harness

    def turn(self, harness, text):
        # What _run_turn_now sets for a top-level turn the user typed (the turn itself isn't run here).
        from dgc.agent import names_dgc_browser
        harness.agent._named_dgc_browser, harness.agent._dgc_browser_steered = names_dgc_browser(text), False

    def test_only_the_users_own_words_name_it(self):
        from dgc.agent import names_dgc_browser
        for said in ("Use the DGC browser: open https://example.com", "open it in dgc-browser", "DGC Browser, please",
                     "check it in the dgcbrowser"):
            with self.subTest(said=said):
                self.assertTrue(names_dgc_browser(said))
        for said in ("Check my browser: how many unread GitHub notifications?", "open example.com in a browser",
                     '<editor-context-json version="1">{"file": "dgc/dgc_browser.py", "text": "DGC Browser"}</editor-context-json>\n\nfix the test',
                     "what time is it\n\n<dgc-now>DGC Browser</dgc-now>", "the dgc_browser_work module"):
            with self.subTest(said=said):
                self.assertFalse(names_dgc_browser(said), "an open file, DGC's own notes or a module name don't count")

    def test_named_the_first_browser_open_is_sent_to_dgc_browser_once_and_asks_nothing(self):
        harness = self.harness("default")
        self.turn(harness, "Use the DGC browser: open https://example.com and tell me its heading")
        from dgc import agent as agent_module
        with patch.object(agent_module, "execute") as ran:
            out = harness.agent._handle_call(ToolCall("b1", "browser", {"operation": "open", "url": "https://example.com"}))
        self.assertIn("open this page with the dgc_browser tool instead", out)
        self.assertEqual([f for f in harness.stream.frames() if f["type"] == "permission_request"], [], "nothing asked")
        denied = [f for f in harness.stream.frames() if f["type"] == "tool_denied"]
        self.assertEqual([f.get("reason") for f in denied], ["you asked for DGC Browser"], "a row says why it didn't run")
        ran.assert_not_called()
        # Once: the next browser call is decided and run as any other (here it asks, as browser does in default mode).
        harness.answer("permission_request", {"decision": "deny"})
        again = harness.agent._handle_call(ToolCall("b2", "browser", {"operation": "open", "url": "https://example.com"}))
        self.assertNotIn("dgc_browser tool instead", again)
        self.assertEqual(len([f for f in harness.stream.frames() if f["type"] == "permission_request"]), 1)

    def test_not_named_not_an_open_their_own_chrome_or_not_offered_runs_as_before(self):
        cases = (("Check my browser: how many unread GitHub notifications?", {"operation": "open", "url": "https://github.com/notifications"}, None),
                 ("Use the DGC browser to check it", {"operation": "snapshot"}, None),
                 ("Use the DGC browser to check it", {"operation": "open", "url": "https://example.com", "signed_in": True}, None),
                 ("Use the DGC browser to check it", {"operation": "open", "url": "https://example.com"}, {"browser", "read_file"}))
        for text, args, offered in cases:
            with self.subTest(text=text, args=args, offered=offered):
                harness = self.harness("default")
                self.turn(harness, text)
                if offered is not None:
                    harness.agent._offered_tool_names = offered
                self.assertEqual(harness.agent._steer_to_dgc_browser("browser", args), "")
                self.assertFalse(harness.agent._dgc_browser_steered)

    def test_a_sub_agent_and_dgc_browser_itself_are_never_redirected(self):
        harness = self.harness("default")
        self.turn(harness, "Use the DGC browser: open https://example.com")
        self.assertEqual(harness.agent._steer_to_dgc_browser("dgc_browser", dict(OPEN)), "")
        harness.agent.depth = 1
        self.assertEqual(harness.agent._steer_to_dgc_browser("browser", {"operation": "open", "url": "https://example.com"}), "")


if __name__ == "__main__":
    unittest.main()
