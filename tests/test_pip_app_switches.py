"""pips-09: "Apps it can use", a switch per app on each Pip (decision D5: every app on, a switch to turn one off).

An app is a plugin turned on in Settings (Airtable, Composio...) or an app the Pip reaches through Composio (Gmail,
Google Calendar...). Switched off for one Pip, it is gone for that Pip alone: its plugin isn't listed or callable, its
reads, Composio calls and sends are refused in plain words, and it can't be asked for. Only the user, on this computer.
"""
import unittest

from dgc import pip_app_actions as actions, pip_app_links as links, pip_app_switches as switches, pip_plugins, pips
from dgc.headless import PIPS_API_VERSION
from dgc.workspace_registry import RegistryError
from tests import test_pip_plugins as plugin_tests


class AppSwitchTests(plugin_tests.PluginWorld, unittest.TestCase):
    _base = plugin_tests.PluginAccessTests
    RUN = _base.RUN
    setUp, session_for, two_accounts, link_second, use = _base.setUp, _base.session_for, _base.two_accounts, _base.link_second, _base.use
    FETCH, SEND = _base.FETCH, _base.SEND
    EXEC = pip_plugins.COMPOSIO_EXECUTE

    def control(self, command, actor="editor-user", **fields):
        from unittest.mock import patch
        from dgc.workspace_registry import WorkspaceRegistry
        with patch.object(pips, "WorkspaceRegistry", lambda *a, **k: WorkspaceRegistry(self.registry.directory)):
            return pips.handle_control(self.cfg, {"type": command, "request_id": "r1", **fields}, actor, start_worker=False)

    def test_the_api_offers_the_switches(self):
        self.assertGreaterEqual(PIPS_API_VERSION, 88)

    def test_every_app_is_on_until_switched_off_for_one_pip_alone(self):
        listed = self.control("get_pip_apps", pip_id=self.pip["id"])
        self.assertTrue(listed["ok"], listed)
        apps = {a["id"]: a for a in listed["result"]["apps"]}
        self.assertTrue(apps["airtable"]["on"] and apps["aave"]["on"], "D5: every app on")
        self.assertEqual(apps["airtable"]["kind"], "plugin")
        off = self.control("set_pip_app", pip_id=self.pip["id"], app="airtable", on=False)
        self.assertTrue(off["ok"], off)
        self.assertEqual(sorted(pip_plugins.allowed(self.registry, self.pip["id"], self.cfg)), ["aave"])
        other = self.store.create(self.registry.personal()["id"], "Max", "Money", "local-console")
        self.assertEqual(sorted(pip_plugins.allowed(self.registry, other["id"], self.cfg)), ["aave", "airtable"], "only that Pip")
        said = self.use("call_plugin", plugin="airtable", tool="list_records", arguments={"table": "Plans"})
        self.assertIn("error", said.lower()[:40] + said.lower())
        self.assertTrue(self.control("set_pip_app", pip_id=self.pip["id"], app="airtable", on=True)["ok"])
        self.assertEqual(sorted(pip_plugins.allowed(self.registry, self.pip["id"], self.cfg)), ["aave", "airtable"])

    def test_an_app_switched_off_is_refused_on_every_path(self):
        info, tools = self.two_accounts()
        self.link_second()                                  # Gmail: ca_second
        listed = {a["id"]: a for a in self.control("get_pip_apps", pip_id=self.pip["id"])["result"]["apps"]}
        self.assertEqual((listed["gmail"]["kind"], listed["gmail"]["on"]), ("app", True))
        self.assertTrue(self.control("set_pip_app", pip_id=self.pip["id"], app="gmail", on=False)["ok"])
        said = self.session._call(self.registry, info, tools, {"tool": self.EXEC, "arguments": {"tools": [self.FETCH]}})
        self.assertIn("switched off", said)
        self.assertFalse([1 for kind, _ in self.composio_seen if kind == "run"])
        with self.assertRaises(RegistryError):
            pip_plugins.require_pinned(self.registry, self.pip["id"], info,
                                       {"tool": self.EXEC, "arguments": {"tools": [{**self.SEND, "account": "ca_second"}]}})
        with self.assertRaises(RegistryError):
            actions._plugin_allowed(self.store, {"kind": "gmail_send", "server": "composio", "account": "ca_second",
                                                 "source": {"pip_id": self.pip["id"]}}, self.cfg)
        with self.assertRaises(RegistryError):
            switches.require_on(self.registry, self.pip["id"], "gmail")
        self.assertEqual([a for a in links.connected(self.registry, self.pip["id"]) if a["toolkit"] == "gmail"][0]["account"],
                         "ca_second", "its link stays: switching it back on needs no new sign-in")

    def test_add_another_address_from_the_pips_page_raises_its_card(self):
        self.link_second()
        made = self.control("add_pip_app_account", pip_id=self.pip["id"], app="gmail")
        self.assertTrue(made["ok"], made)
        card = made["result"]["link"]
        self.assertEqual((card["toolkit"], card["status"], card.get("another")), ("gmail", "requested", True))
        self.assertFalse(self.control("add_pip_app_account", actor="device_1", pip_id=self.pip["id"], app="gmail")["ok"])
        self.assertFalse(self.control("add_pip_app_account", pip_id=self.pip["id"], app="Gmail!")["ok"])

    def test_only_the_user_on_this_computer_and_only_real_app_names(self):
        self.assertFalse(self.control("set_pip_app", actor="device_1", pip_id=self.pip["id"], app="gmail", on=False)["ok"])
        for bad in ("", "Gmail!", "x" * 80, None):
            with self.subTest(app=bad):
                self.assertFalse(self.control("set_pip_app", pip_id=self.pip["id"], app=bad, on=False)["ok"])
        self.assertFalse(self.control("set_pip_app", pip_id=self.pip["id"], app="gmail", on="no")["ok"])


if __name__ == "__main__":
    unittest.main()
