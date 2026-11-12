"""pips-09 stage 2: several accounts of one app on one Pip, each Pip its own. With one account DGC puts it on every
call; with several the call names one and DGC checks it is on that Pip's list; any other account is refused. Nothing
picks a default: a level's send or an app routine waits for the user when it can't tell which."""
import unittest

from dgc import pip_action_grants as grants, pip_app_actions as actions, pip_app_links as links, pip_levels as levels, pip_plugins
from dgc.workspace_registry import RegistryError
from tests import test_pip_app_links as link_tests
from tests import test_pip_plugins as plugin_tests


class SeveralAccountLinkTests(unittest.TestCase):
    setUp, ask = link_tests.AppLinkTests.setUp, link_tests.AppLinkTests.ask
    A = {"id": "ca_pitchAAAAAAAAAA", "status": "ACTIVE", "user_info": {"email": "pitch@example.com"}}
    B = {"id": "ca_devBBBBBBBBBBBB", "status": "ACTIVE", "user_info": {"email": "dev@example.com"}}

    def link(self, account, another=False):
        card = links.request(self.registry, self.pip["id"], self.pip["workspace_id"], "gmail", "To read the inbox.", None,
                             another=another)
        return links.start(self.registry, self.cfg, card["id"], "editor-user", account=account, manager_factory=self.factory)

    def test_a_pip_holds_two_gmail_accounts_and_asks_for_the_second_on_its_own_card(self):
        self.world["accounts"] = [self.A, self.B]
        self.assertTrue(self.link(self.A["id"])["connected"])
        again = links.request(self.registry, self.pip["id"], self.pip["workspace_id"], "gmail", "Another inbox.", None)
        self.assertEqual(again["status"], "connected", "without another, the app it has comes back as it is")
        second = self.link(self.B["id"], another=True)
        self.assertTrue(second["connected"])
        mine = links.connected(self.registry, self.pip["id"])
        self.assertEqual(sorted(a["label"] for a in mine), ["dev@example.com", "pitch@example.com"])
        self.assertEqual(sorted(a["label"] for a in links.composio_links(self.registry, self.pip["id"])["gmail"]),
                         ["dev@example.com", "pitch@example.com"])
        # The list for a third card offers only an account it hasn't got; the same one again is refused.
        card = links.request(self.registry, self.pip["id"], self.pip["workspace_id"], "gmail", "Third.", None, another=True)
        same = links.start(self.registry, self.cfg, card["id"], "editor-user", account=self.A["id"], manager_factory=self.factory)
        self.assertNotIn("connected", same)
        self.assertIn("already uses", same["error"])
        self.assertEqual(len(links.connected(self.registry, self.pip["id"])), 2)

    def test_choose_takes_the_only_one_or_the_one_named_and_refuses_the_rest(self):
        one = [{"toolkit": "gmail", "account": "ca_a", "label": "pitch@example.com"}]
        two = one + [{"toolkit": "gmail", "account": "ca_b", "label": "dev@example.com"}]
        self.assertEqual(links.choose(one, None, "gmail")["account"], "ca_a")
        self.assertEqual(links.choose(two, "DEV@example.com", "gmail")["account"], "ca_b")
        self.assertEqual(links.choose(two, "ca_a", "gmail")["account"], "ca_a")
        with self.assertRaises(RegistryError) as said:
            links.choose(two, None, "gmail")
        self.assertIn("pitch@example.com, dev@example.com", str(said.exception))
        with self.assertRaises(RegistryError):
            links.choose(two, "boss@example.com", "gmail")


class SeveralAccountCallTests(plugin_tests.PluginWorld, unittest.TestCase):
    _base = plugin_tests.PluginAccessTests
    RUN = _base.RUN
    setUp, session_for, two_accounts, link_second = _base.setUp, _base.session_for, _base.two_accounts, _base.link_second
    FETCH, SEND = _base.FETCH, _base.SEND
    EXEC = pip_plugins.COMPOSIO_EXECUTE

    def link_both(self):
        self.link_second()                                # ca_second, dev@example.com
        card = links.request(self.registry, self.pip["id"], self.pip["workspace_id"], "gmail", "The other inbox.", None, another=True)
        with self.registry.transaction():
            self.registry.db.execute("UPDATE pip_app_links SET status='connected',server='composio',connection_digest=?,account='ca_first',label='pitch@example.com' WHERE id=?",
                                     ("d" * 64, card["id"]))

    def test_with_two_accounts_a_call_names_one_of_its_own_and_nothing_else(self):
        info, tools = self.two_accounts()
        self.link_both()
        said = self.session._call(self.registry, info, tools, {"tool": self.EXEC, "arguments": {"tools": [self.FETCH]}})
        self.assertIn("2 Gmail accounts", said)
        self.assertFalse([1 for kind, _ in self.composio_seen if kind == "run"], "nothing picked for it")
        self.session._call(self.registry, info, tools, {"tool": self.EXEC, "arguments": {"tools": [{**self.FETCH, "account": "pitch@example.com"}]}})
        self.assertEqual([a for k, a in self.composio_seen if k == "run"][-1]["tools"][0]["account"], "ca_first")
        said = self.session._call(self.registry, info, tools, {"tool": self.EXEC, "arguments": {"tools": [{**self.FETCH, "account": "ca_third"}]}})
        self.assertIn("isn't one of your Gmail accounts", said)
        # At Allow too.
        pip_plugins.require_pinned(self.registry, self.pip["id"], info, {"tool": self.EXEC, "arguments": {"tools": [{**self.SEND, "account": "ca_second"}]}})
        with self.assertRaises(RegistryError):
            pip_plugins.require_pinned(self.registry, self.pip["id"], info, {"tool": self.EXEC, "arguments": {"tools": [self.SEND]}})

    def test_sends_grants_and_levels_with_two_accounts(self):
        self.link_both()
        payload = {"kind": "gmail_send", "server": "composio", "account": "ca_first", "source": {"pip_id": self.pip["id"]}}
        actions._plugin_allowed(self.store, payload, self.cfg)
        actions._plugin_allowed(self.store, {**payload, "account": "ca_second"}, self.cfg)
        with self.assertRaises(RegistryError):
            actions._plugin_allowed(self.store, {**payload, "account": "ca_third"}, self.cfg)
        g = {"id": "g", "kind": "gmail_send", "account": "ca_first"}
        self.assertIsNotNone(grants._matching([g], "gmail_send", {}, {"gmail": {"ca_first", "ca_second"}}))
        self.assertIsNone(grants._matching([{**g, "account": "ca_third"}], "gmail_send", {}, {"gmail": {"ca_first", "ca_second"}}))
        with self.assertRaises(RegistryError) as said:
            levels._route(self.registry, self.cfg, self.pip["id"], "gmail")
        self.assertIn("which one sends", str(said.exception))


if __name__ == "__main__":
    unittest.main()
