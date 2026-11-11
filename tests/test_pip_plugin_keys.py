"""pips-10, slice 1 (0.52, D9): a Personal Pip's plugin that needs a key it doesn't have asks for it on a card.

Today a plugin with no key fails in a Pip's chat as "isn't signed in, or it didn't answer". Now the Pip's call raises
one card in its chat for that plugin ("needs its Airtable token"); the user pastes the key on the card and Allow saves it
where DGC keeps a plugin's key (plugin_keys: the keychain, bound to the server), and the Pip carries on. The key goes
only into what DGC runs for the Pip (the plugin's own connection); the Pip never sees it, and it is redacted anywhere it
turns up. A key is refused in plain words if it is empty; nothing is saved then.
"""
import json
import unittest
from unittest.mock import patch

from dgc import pip_plugins, plugin_keys, plugins
from dgc.redaction import secret_values
from dgc.workspace_registry import RegistryError
from tests import test_pip_plugins as base
from tests import test_pips_local as local

KEYED = {**base.AIRTABLE, "env_names": ["AIRTABLE_TOKEN"]}
SECRET = "pat_test_0123456789abcdefSECRET"


class PluginKeyCard(base.PluginWorld, unittest.TestCase):
    RUN = base.PluginAccessTests.RUN

    def setUp(self):
        local.LocalPipsTests.setUp(self)
        self.world()
        self.cfg.data["mcp_servers"]["airtable"] = dict(KEYED)
        rows = base.installed(("airtable", "Airtable", KEYED, False), ("aave", "Aave", base.AAVE, True))
        patcher = patch("dgc.plugins._installed", return_value=rows)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.saved = {}

        def save(server, spec, values):
            self.saved.setdefault(server, {}).update(values)
            plugin_keys._remember(values.values())
            return "keychain"
        for target, fake in (("dgc.plugin_keys.save", save),
                             ("dgc.plugin_keys.saved_names", lambda server, spec=None: list(self.saved.get(server, {})))):
            patcher = patch(target, fake)
            patcher.start()
            self.addCleanup(patcher.stop)
        base.Vendor.signed_in = False              # no key: the vendor's server won't let DGC in
        self.pip = self.store.create(self.registry.personal()["id"], "Ava", "Keep my plans", "local-console")
        self.session = pip_plugins.Session(self.registry.directory, self.cfg, self.pip["id"], self.pip["workspace_id"], self.RUN)
        self.addCleanup(self.session.close)

    def use(self, op, **args):
        """What the Pip is told: the tool's answer, or the words of the error it gets back."""
        try:
            return self.session.call(self.registry, op, args)
        except RegistryError as exc:
            return str(exc)

    def card(self):
        listed = pip_plugins.listing(self.registry, self.pip["id"], self.cfg)
        cards = [c for c in listed.get("key_requests", []) if c.get("plugin") == "airtable"]
        return cards[0] if cards else None

    def test_a_call_with_no_key_raises_one_card_and_tells_the_pip_to_stop(self):
        said = self.use("plugin_tools", plugin="airtable")
        text = json.dumps(said) if not isinstance(said, str) else said
        self.assertIn("needs its key", text)
        self.assertIn("card below your reply", text)
        self.assertNotIn("isn’t signed in", text, "not the vague line any more")
        card = self.card()
        self.assertIsNotNone(card, "a card for Airtable")
        self.assertEqual(card["status"], "requested")
        self.assertEqual([k["name"] for k in card["needs_key"]], ["AIRTABLE_TOKEN"])
        self.use("plugin_tools", plugin="airtable")
        listed = pip_plugins.listing(self.registry, self.pip["id"], self.cfg)
        self.assertEqual(len([c for c in listed.get("key_requests", []) if c.get("plugin") == "airtable"]), 1,
                         "asking again keeps one card")

    def test_allow_with_the_key_saves_it_for_the_plugins_server_and_never_shows_it(self):
        self.use("plugin_tools", plugin="airtable")
        card = self.card()
        with self.assertRaisesRegex(RegistryError, "Paste"):
            pip_plugins.allow(self.registry, self.cfg, card["id"], self.pip["id"], "editor-user", keys={"AIRTABLE_TOKEN": "  "})
        self.assertEqual(self.saved, {}, "an empty key saves nothing")
        with self.assertRaisesRegex(RegistryError, "Paste"):
            pip_plugins.allow(self.registry, self.cfg, card["id"], self.pip["id"], "editor-user")
        answered = pip_plugins.allow(self.registry, self.cfg, card["id"], self.pip["id"], "editor-user", keys={"AIRTABLE_TOKEN": SECRET})
        self.assertEqual(self.saved, {"airtable": {"AIRTABLE_TOKEN": SECRET}}, "kept where DGC keeps a plugin's key, for its server")
        self.assertNotIn(SECRET, json.dumps(answered), "never in the answer")
        self.assertEqual(answered["plugin"]["status"], "allowed")
        self.assertEqual(answered["plugin"]["needs_key"], [], "saved: it needs nothing now")
        self.assertIn(SECRET, secret_values(self.cfg), "redacted anywhere it turns up")
        events = json.dumps([dict(r) for r in self.registry.db.execute("SELECT payload FROM workspace_events")])
        self.assertNotIn(SECRET, events)
        with self.assertRaisesRegex(RegistryError, "Only you"):
            pip_plugins.allow(self.registry, self.cfg, card["id"], self.pip["id"], "device", keys={"AIRTABLE_TOKEN": SECRET})

    def test_the_pips_api_takes_the_key_on_allow_and_the_pip_carries_on(self):
        from dgc import pips
        from dgc.workspace_registry import WorkspaceRegistry
        self.use("plugin_tools", plugin="airtable")
        card = self.card()
        with patch.object(pips, "WorkspaceRegistry", lambda: WorkspaceRegistry(self.registry.directory)), \
             patch("dgc.pip_chat.continue_after_plugin") as carry:
            answered = pips.handle_control(self.cfg, {"type": "allow_pip_plugin", "request_id": "r1", "pip_id": self.pip["id"],
                                                      "grant_id": card["id"], "keys": {"AIRTABLE_TOKEN": SECRET}},
                                           "editor-user", start_worker=False)
        self.assertTrue(answered["ok"], answered)
        self.assertNotIn(SECRET, json.dumps(answered), "never in the answer")
        self.assertEqual(self.saved, {"airtable": {"AIRTABLE_TOKEN": SECRET}})
        carry.assert_called_once()
