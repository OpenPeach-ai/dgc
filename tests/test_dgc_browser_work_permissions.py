"""DGC Browser in a Work session asks the way the user's own signed-in Chrome does (26 Nov): opening a site this session
hasn't used asks, in every mode; Always allow saves that one site (DGCBrowser(dgc-browser:https://site)), never a bare
DGCBrowser rule; a site the user allowed this session opens again without asking; steps on its tab don't ask (it opens
nothing else); a deny rule wins. The SDKs name the tool the same way (tests/test_dgc_sdk_policy.py checks the table)."""
import unittest

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


if __name__ == "__main__":
    unittest.main()
