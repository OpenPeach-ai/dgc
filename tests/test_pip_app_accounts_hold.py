"""pips-09 stage 1: a Pip's app calls stay on its own account, closing 0.51's known gap and its neighbours.

- An app the Pip isn't linked to, with one account in Composio: the card names that account, so a second account added
  before Allow can't take the action (Composio's own default is the newest account). At Allow, a call for an unlinked
  app that names no account is refused.
- A Pip with its own app account never gets Composio's proxy, workbench or remote shell (they can't be held to an
  account), not when it asks and not at Allow.
- An email or invitation the user allows runs only on the account linked to that Pip for that app.
- Always allow covers only the account the Pip is still linked to; disconnecting the app ends its grants.
"""
import unittest

from dgc import pip_action_grants as grants, pip_app_actions as actions, pip_app_links as links, pip_plugins
from dgc.workspace_registry import RegistryError
from tests import test_pip_plugins as plugin_tests


class AccountHoldTests(plugin_tests.PluginWorld, unittest.TestCase):
    _base = plugin_tests.PluginAccessTests
    RUN = _base.RUN
    setUp, session_for, two_accounts, link_second = _base.setUp, _base.session_for, _base.two_accounts, _base.link_second
    FETCH, SEND = _base.FETCH, _base.SEND
    EXEC = pip_plugins.COMPOSIO_EXECUTE

    def one_account(self):
        info, tools = self.two_accounts()
        self.composio_accounts.pop()            # only ca_first
        return info, tools

    def test_an_unlinked_app_with_one_account_names_it_so_a_second_account_cant_take_the_card(self):
        info, tools = self.one_account()
        pending = self.session._call(self.registry, info, tools, {"tool": self.EXEC, "arguments": {"tools": [self.SEND]}})
        self.assertIsInstance(pending, dict, "a send waits for the Allow")
        call = pending["draft"]["call"]
        self.assertEqual(call["arguments"]["tools"][0]["account"], "ca_first", "the one account there is, by name")
        # A second account is added before the Allow: the card still names the first, and that is what runs.
        self.composio_accounts.append({"id": "ca_second", "status": "active", "user_info": {"email": "dev@example.com"}})
        pip_plugins.require_pinned(self.registry, self.pip["id"], info, call)
        # A card that names no account for an app the Pip isn't linked to (written before this, or edited) is refused.
        with self.assertRaises(RegistryError):
            pip_plugins.require_pinned(self.registry, self.pip["id"], info, {"tool": self.EXEC, "arguments": {"tools": [self.SEND]}})
        # A read with one account runs at once, on that account by name.
        said = self.session._call(self.registry, info, tools, {"tool": self.EXEC, "arguments": {"tools": [self.FETCH]}})
        self.assertIn("Untrusted data", said)
        ran = [args for kind, args in self.composio_seen if kind == "run"]
        self.assertEqual(ran[-1]["tools"][0]["account"], "ca_first")

    def test_a_pip_with_its_own_account_never_gets_composios_proxy_workbench_or_shell(self):
        info, tools = self.one_account()
        self.link_second()
        for name in sorted(pip_plugins.COMPOSIO_UNPINNABLE):
            with self.subTest(tool=name):
                said = self.session._call(self.registry, info, tools, {"tool": name, "arguments": {"code_to_execute": "1"}})
                self.assertIsInstance(said, str)
                self.assertIn("its own", said)
                with self.assertRaises(RegistryError):
                    pip_plugins.require_pinned(self.registry, self.pip["id"], info, {"tool": name, "arguments": {"code_to_execute": "1"}})
        self.assertFalse([1 for kind, _ in self.composio_seen if kind == "run"])

    def test_an_email_the_user_allows_runs_only_on_the_account_linked_to_that_pip(self):
        self.link_second()                      # this Pip's Gmail is ca_second
        payload = {"kind": "gmail_send", "server": "composio", "account": "ca_first", "source": {"pip_id": self.pip["id"]}}
        with self.assertRaises(RegistryError) as said:
            actions._plugin_allowed(self.store, payload, self.cfg)
        self.assertIn("dev@example.com", str(said.exception))
        actions._plugin_allowed(self.store, {**payload, "account": "ca_second"}, self.cfg)
        # An app this Pip isn't linked to: the account the user chose in the review, as before.
        actions._plugin_allowed(self.store, {**payload, "kind": "calendar_create", "account": "ca_cal"}, self.cfg)

    def test_always_allow_covers_only_the_account_the_pip_is_still_linked_to(self):
        self.link_second()
        mine = {"id": "g1", "kind": "gmail_send", "account": "ca_second", "server": "composio", "tool": "GMAIL_SEND_EMAIL"}
        other = {**mine, "id": "g2", "account": "ca_first"}
        linked = {"gmail": "ca_second"}
        self.assertEqual(grants._matching([other, mine], "gmail_send", {}, linked)["id"], "g1", "the linked account's grant")
        self.assertIsNone(grants._matching([other], "gmail_send", {}, linked), "never another account's")
        # Disconnecting the app ends this Pip's grants on that account.
        with self.registry.transaction():
            self.registry.db.execute("INSERT INTO metadata VALUES(?,?)", (grants._key(self.pip["id"], "grant_" + "e" * 32),
                                     '{"kind":"gmail_send","server":"composio","connection_digest":"' + "d" * 64 + '","account":"ca_second",'
                                     '"schema_digest":"' + "a" * 64 + '","tool":"GMAIL_SEND_EMAIL","created_at":"now","label":"Gmail"}'))
        self.assertEqual(len(grants.list_grants(self.registry, self.pip["id"])), 1)
        link = next(item for item in links.listing(self.registry, self.pip["id"]) if item["status"] == "connected")
        links.disconnect(self.registry, link["id"], "editor-user")
        self.assertEqual(grants.list_grants(self.registry, self.pip["id"]), [])


if __name__ == "__main__":
    unittest.main()
