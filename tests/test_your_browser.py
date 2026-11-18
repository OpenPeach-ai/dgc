"""Your Browser, phase 1 (0.52, Pips API 105; his answers 17 Nov): the model and the API.

One shared browser on this computer where the person signs in once; each Pip works in its own tab (lane) of it, only on
the sites the person lets that Pip use. Sites are noticed from the person's own sign-ins; a new bank or payment site
starts at "Ask me which Pips" (chosen, no Pips), every other at All Pips. get_your_browser says what it is here
(host_profile, weaker: true), set_your_browser_site and sign_out_your_browser_site change a site, open_your_browser and
use_your_browser_view are its window and its streamed tab (phase 3, tests/test_your_browser_window.py). Every command is local only, and a Pip
deleted for good takes its rows with it."""
from __future__ import annotations

import json
import re
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import pips, your_browser
from tests import test_pips_local as fixtures

REPO = Path(__file__).resolve().parents[1]
COMMANDS = ("get_your_browser", "set_your_browser_site", "sign_out_your_browser_site", "open_your_browser",
            "use_your_browser_view")


class Base(unittest.TestCase):
    def setUp(self):
        fixtures.LocalPipsTests.setUp(self)
        personal = self.registry.personal()["id"]
        self.ava = self.store.create(personal, "Ava", None, "editor-user", pip_type="lens", computer_plan={"schema_version": 1})
        self.ben = self.store.create(personal, "Ben", None, "editor-user", pip_type="lens", computer_plan={"schema_version": 1})

    def control(self, command, actor="editor-user", **fields):
        with patch("dgc.pips.WorkspaceRegistry", return_value=self.registry), patch.object(self.registry, "close"):
            return pips.handle_control(self.cfg, {"type": command, "request_id": "r", **fields}, actor, start_worker=False)

    def ok(self, command, **fields):
        out = self.control(command, **fields)
        self.assertTrue(out["ok"], out)
        return out["result"]


class MoneySites(unittest.TestCase):
    """The one bank-or-payment decision, in one place (his answer 3)."""

    def test_banks_and_payment_services_are_money_sites(self):
        for host in ("www.paypal.com", "secure.chase.com", "netbanking.hdfcbank.com", "retail.onlinesbi.sbi",
                     "login.northwind-bank.com", "app.mywallet.io", "razorpay.com", "paytm.com", "home.mybank.bank",
                     "www.barclays.co.uk", "accounts.zerodha.com"):
            with self.subTest(host=host):
                self.assertTrue(your_browser.money_site(host), host)

    def test_other_sites_are_not(self):
        for host in ("mail.google.com", "www.notion.so", "github.com", "www.amazon.in", "docs.python.org",
                     "news.ycombinator.com", "www.display-works.com", "papaya.example.org"):
            with self.subTest(host=host):
                self.assertFalse(your_browser.money_site(host), host)

    def test_payment_flow_signals_from_the_sign_in_count(self):
        self.assertTrue(your_browser.money_site("shop.example-store.com", card_fields=True))
        self.assertTrue(your_browser.money_site("shop.example-store.com", paths=["https://shop.example-store.com/checkout/pay"]))
        self.assertTrue(your_browser.money_site("acme-coop.org", titles=["Acme Co-op Net Banking - Sign in"]))
        self.assertFalse(your_browser.money_site("shop.example-store.com", paths=["/orders"], titles=["Your orders"]))

    def test_nothing_on_this_computer_or_the_lan_is_a_site(self):
        for host in ("localhost", "192.168.1.10", "10.0.0.2", "[::1]", "router.local", "nas.lan", "printer",
                     "intranet.corp", "files.internal", ""):
            with self.subTest(host=host):
                self.assertEqual(your_browser.site_key(host), "")


class NoticedSites(Base):
    def test_a_new_site_is_all_pips_and_a_new_bank_asks_which_pips(self):
        mail = your_browser.notice_site(self.registry, "mail.example-mail.com")
        bank = your_browser.notice_site(self.registry, "login.northwind-bank.com")
        self.assertEqual((mail["site"], mail["mode"], mail["pips"]), ("example-mail.com", "all", []))
        self.assertEqual((bank["site"], bank["mode"], bank["pips"], bank["money"]), ("northwind-bank.com", "chosen", [], True))
        self.assertEqual(mail["added_by"], "noticed")

    def test_noticed_again_keeps_the_persons_choice_and_adds_exact_sign_in_hosts(self):
        your_browser.notice_site(self.registry, "app.example-notes.com", sso_hosts=["accounts.example-idp.com"])
        self.ok("set_your_browser_site", site="example-notes.com", mode="chosen", pips=[self.ava["id"]])
        again = your_browser.notice_site(self.registry, "www.example-notes.com",
                                         sso_hosts=["login.example-idp.com", "192.168.0.2"])
        self.assertEqual(again["mode"], "chosen")
        self.assertEqual([p["pip_id"] for p in again["pips"]], [self.ava["id"]])
        self.assertEqual(again["sso_hosts"], ["accounts.example-idp.com", "login.example-idp.com"],
                         "exact hosts only, never an address on the network")

    def test_an_address_on_this_computer_is_never_noticed(self):
        self.assertIsNone(your_browser.notice_site(self.registry, "localhost"))
        self.assertIsNone(your_browser.notice_site(self.registry, "192.168.1.1"))
        self.assertEqual(your_browser.sites(self.registry), [])


class Commands(Base):
    def test_get_says_what_it_is_here_and_lists_sites_with_their_pips(self):
        your_browser.notice_site(self.registry, "mail.example-mail.com")
        your_browser.notice_site(self.registry, "www.paypal.com")
        self.ok("set_your_browser_site", site="paypal.com", mode="chosen", pips=[self.ben["id"]])
        got = self.ok("get_your_browser")
        self.assertEqual((got["kind"], got["weaker"]), ("host_profile", True))
        self.assertIn(got["chrome"], ("installed", "dgc_copy", ""))
        self.assertIsInstance(got["available"], bool)
        self.assertEqual(got["available"], got["reason"] == "", got)
        self.assertEqual(got["yours"], {"open": False, "tabs": [], "error": ""})
        self.assertEqual(got["lanes"], [])
        by_site = {s["site"]: s for s in got["sites"]}
        self.assertEqual(set(by_site), {"example-mail.com", "paypal.com"})
        self.assertEqual(by_site["paypal.com"]["pips"], [{"pip_id": self.ben["id"], "name": "Ben"}])
        self.assertEqual(by_site["example-mail.com"]["mode"], "all")

    def test_get_on_a_fresh_profile_lists_nothing(self):
        got = self.ok("get_your_browser")
        self.assertEqual((got["sites"], got["signing_out"]), ([], []))

    def test_set_chooses_pips_or_all_and_refuses_what_it_cant_keep(self):
        your_browser.notice_site(self.registry, "app.example-notes.com")
        site = self.ok("set_your_browser_site", site="example-notes.com", mode="chosen",
                       pips=[self.ava["id"], self.ben["id"]])["site"]
        self.assertEqual([p["name"] for p in site["pips"]], ["Ava", "Ben"])
        asking = self.ok("set_your_browser_site", site="example-notes.com", mode="chosen", pips=[])["site"]
        self.assertEqual((asking["mode"], asking["pips"]), ("chosen", []), "none chosen: Ask me which Pips")
        back = self.ok("set_your_browser_site", site="www.example-notes.com", mode="all")["site"]
        self.assertEqual((back["mode"], back["pips"]), ("all", []))
        for fields, code in (({"site": "example-notes.com", "mode": "some"}, "invalid_request"),
                             ({"site": "example-notes.com", "mode": "all", "pips": [self.ava["id"]]}, "invalid_request"),
                             ({"site": "example-notes.com", "mode": "chosen", "pips": ["pip_" + "0" * 32]}, "not_found"),
                             ({"site": "never-signed-in.com", "mode": "all"}, "not_found"),
                             ({"site": "localhost", "mode": "all"}, "invalid_request")):
            with self.subTest(fields=fields):
                out = self.control("set_your_browser_site", **fields)
                self.assertFalse(out["ok"])
                self.assertEqual(out["error"]["code"], code, out)

    def test_sign_out_takes_the_site_away_from_every_pip_and_waits_for_the_browser_to_clear_it(self):
        your_browser.notice_site(self.registry, "app.example-notes.com", sso_hosts=["accounts.example-idp.com"])
        self.ok("set_your_browser_site", site="example-notes.com", mode="chosen", pips=[self.ava["id"]])
        out = self.ok("sign_out_your_browser_site", site="example-notes.com")
        self.assertEqual(out, {"site": "example-notes.com", "sign_out": "waiting"})
        got = self.ok("get_your_browser")
        self.assertEqual((got["sites"], got["signing_out"]), ([], ["example-notes.com"]))
        self.assertEqual(self.registry.db.execute("SELECT COUNT(*) FROM your_browser_site_pips").fetchone()[0], 0)
        self.assertFalse(your_browser.grants_for(self.registry, self.ava["id"]).admits("app.example-notes.com"))
        self.assertEqual(self.control("sign_out_your_browser_site", site="example-notes.com")["error"]["code"], "not_found")
        # Signed in again: nothing waits to be cleared any more.
        your_browser.notice_site(self.registry, "app.example-notes.com")
        self.assertEqual(self.ok("get_your_browser")["signing_out"], [])

    def test_the_window_commands_check_what_they_are_given(self):
        # (Phase 3 made them real: tests/test_your_browser_window.py.)
        self.assertEqual(self.control("use_your_browser_view", op="explode")["error"]["code"], "invalid_request")
        self.assertEqual(self.control("open_your_browser", path="/etc")["error"]["code"], "invalid_request",
                         "fields outside the command's own are refused, as every Pip command's are")

    def test_every_command_is_local_only(self):
        your_browser.notice_site(self.registry, "app.example-notes.com")
        for command, fields in (("get_your_browser", {}), ("set_your_browser_site", {"site": "example-notes.com", "mode": "all"}),
                                ("sign_out_your_browser_site", {"site": "example-notes.com"}),
                                ("open_your_browser", {}), ("use_your_browser_view", {"op": "click"})):
            with self.subTest(command=command):
                out = self.control(command, actor="device_paired_phone", **fields)
                self.assertFalse(out["ok"])
                self.assertEqual(out["error"]["code"], "local_only", out)
        self.assertEqual(len(your_browser.sites(self.registry)), 1, "nothing changed")


class Grants(Base):
    def test_a_lane_may_use_all_pips_sites_its_chosen_sites_and_their_exact_sign_in_hosts(self):
        your_browser.notice_site(self.registry, "mail.example-mail.com", sso_hosts=["accounts.example-idp.com"])
        your_browser.notice_site(self.registry, "www.paypal.com")
        your_browser.notice_site(self.registry, "app.example-notes.com")
        self.ok("set_your_browser_site", site="example-notes.com", mode="chosen", pips=[self.ben["id"]])
        ava, ben = (your_browser.grants_for(self.registry, p["id"]) for p in (self.ava, self.ben))
        self.assertTrue(ava.admits("inbox.example-mail.com"))
        self.assertTrue(ava.admits("accounts.example-idp.com"))
        self.assertFalse(ava.admits("other.example-idp.com"), "a sign-in host by its exact name, never its domain")
        self.assertFalse(ava.admits("www.paypal.com"), "a new payment site waits for the person to choose")
        self.assertFalse(ava.admits("app.example-notes.com"))
        self.assertTrue(ben.admits("app.example-notes.com"))
        self.assertFalse(ben.admits("localhost") or ben.admits("127.0.0.1") or ben.admits(""))


class DeletedForGood(Base):
    def test_a_pip_deleted_for_good_takes_its_rows_with_it(self):
        from dgc import pip_archive
        your_browser.notice_site(self.registry, "app.example-notes.com")
        self.ok("set_your_browser_site", site="example-notes.com", mode="chosen", pips=[self.ava["id"], self.ben["id"]])
        pip = self.store.get(self.ava["id"])
        pip_archive.transition(self.store, pip["id"], archived=True, expected_version=pip["current_version"],
                               expected_lifecycle_revision=pip["lifecycle_revision"], request_key="k1", reason="done",
                               actor="editor-user")
        pip = self.store.get(self.ava["id"])
        self.ok("delete_archived_pip", pip_id=pip["id"], expected_name=pip["name"],
                expected_version=pip["current_version"], expected_lifecycle_revision=pip["lifecycle_revision"])
        rows = self.registry.db.execute("SELECT pip_id FROM your_browser_site_pips").fetchall()
        self.assertEqual([r[0] for r in rows], [self.ben["id"]])
        self.assertEqual([p["name"] for p in your_browser.sites(self.registry)[0]["pips"]], ["Ben"], "the site stays")


class ThirdPartyCookiesOff(unittest.TestCase):
    """His answer 2: third-party cookies off in Your Browser's profile; the person's own settings otherwise untouched."""

    def setUp(self):
        import tempfile
        temp = tempfile.TemporaryDirectory(prefix="yb-profile-")
        self.addCleanup(temp.cleanup)
        self.profile = Path(temp.name) / "profile"

    def prefs(self):
        return json.loads((self.profile / "Default" / "Preferences").read_text())

    def test_a_new_profile_starts_with_third_party_cookies_off(self):
        self.assertTrue(your_browser.profile_prefs(self.profile))
        self.assertEqual(self.prefs()["profile"]["cookie_controls_mode"], 1)
        self.assertIs(self.prefs()["profile"]["block_third_party_cookies"], True)

    def test_the_persons_own_settings_stay_and_passwords_are_not_turned_off(self):
        (self.profile / "Default").mkdir(parents=True)
        (self.profile / "Default" / "Preferences").write_text(json.dumps(
            {"profile": {"cookie_controls_mode": 0, "name": "Me", "password_manager_enabled": True},
             "credentials_enable_service": True, "sync": {"requested": True}}))
        self.assertTrue(your_browser.profile_prefs(self.profile))
        prefs = self.prefs()
        self.assertEqual(prefs["profile"]["cookie_controls_mode"], 1, "set again at every start")
        self.assertEqual((prefs["profile"]["name"], prefs["profile"]["password_manager_enabled"]), ("Me", True))
        self.assertIs(prefs["credentials_enable_service"], True)
        self.assertEqual(prefs["sync"], {"requested": True})

    def test_a_link_in_place_of_the_file_is_never_followed(self):
        (self.profile / "Default").mkdir(parents=True)
        (self.profile.parent / "elsewhere").mkdir()
        elsewhere = self.profile.parent / "elsewhere" / "Preferences"     # inside the test's own folder, removed with it
        elsewhere.write_text("{}")
        (self.profile / "Default" / "Preferences").symlink_to(elsewhere)
        self.assertFalse(your_browser.profile_prefs(self.profile))
        self.assertEqual(elsewhere.read_text(), "{}")


class Api105(unittest.TestCase):
    def test_the_api_is_105_and_its_commands_are_known_to_the_runtime(self):
        from dgc.headless import PIPS_API_VERSION
        self.assertGreaterEqual(PIPS_API_VERSION, 105)
        for command in COMMANDS:
            with self.subTest(command=command):
                self.assertIn(command, pips.CONTROL_COMMANDS)
                self.assertEqual(pips._COMMAND_ARGS[command], your_browser.COMMAND_ARGS[command])

    def test_pips_md_row_105_names_each_command(self):
        text = (REPO / "sdk" / "PIPS.md").read_text(encoding="utf-8")
        row = next((line for line in text.splitlines() if line.startswith("| 105 |")), "")
        for command in COMMANDS:
            with self.subTest(command=command):
                self.assertRegex(row, r"`" + re.escape(command) + r"[` ]")

    def test_the_code_never_copies_another_browsers_cookies_or_passwords(self):
        # (apt's own folder for a package source's signing key, where Install Google Chrome keeps Google's: not a password
        # store.)
        source = (REPO / "dgc" / "your_browser.py").read_text(encoding="utf-8").replace("/etc/apt/keyrings/", "/etc/apt/")
        for word in ("Login Data", "\"Cookies\"", "Local State", "os_crypt", "Safe Storage", "keyring", "secretstorage"):
            with self.subTest(word=word):
                self.assertNotIn(word, source)


if __name__ == "__main__":
    unittest.main()
