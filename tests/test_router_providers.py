"""DGC Router offers your saved providers too (0.52, asked 4 Nov): "an option so user could enable all our other
providers as well, like we have for main model."

A Router system can be one of the providers saved for the main model (Settings → Models → + Add provider: OpenRouter,
Groq, Together, Ollama Cloud...). It is added from the provider (its address and API come from it), it uses the
provider's own key (never copied into the Router: read from the saved provider each time, and only while the provider
still has the address the system was added with), and its workers say how many helpers may use it at once."""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
import unittest.mock
from unittest.mock import patch

from dgc import config as config_module
from dgc import router as R
from dgc import router_tools as T

PROVIDER = "provider_" + "a" * 32
KEY = "gsk_live_0123456789abcdefROUTER"


class ProviderSystems(unittest.TestCase):
    def setUp(self):
        home = Path(tempfile.mkdtemp(prefix="dgc-router-providers-")).resolve()
        (home / "dgc").mkdir()
        for name, value in (("USER_HOME", home / "dgc"), ("USER_CONFIG", home / "dgc" / "config.json"),
                            ("USER_SECRETS", home / "dgc" / "secrets.json")):
            patcher = patch.object(config_module, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.project = home / "project"
        self.project.mkdir()
        self.config = config_module.Config(project_root=self.project)
        self.config.set_saved_provider(PROVIDER, {"name": "Groq", "base_url": "https://api.groq.com/openai/v1",
                                                  "api_mode": "chat_completions", "model": "llama-3.3-70b-versatile",
                                                  "api_key": KEY})
        self.real_home = Path.home() / ".dgc" / "secrets.json"

    def add(self, **args):
        plan = T.plan_update(self.config, {"action": "add_system", "provider": PROVIDER, **args}, detect=False, pick_later=True)
        T.apply_plan(self.config, plan)
        return R.find_system(R.settings(self.config), plan.system_id if hasattr(plan, "system_id") else "groq")

    def test_a_saved_provider_becomes_a_system_with_its_address_and_its_key(self):
        system = self.add(workers=3)
        self.assertIsNotNone(system)
        self.assertEqual(system["provider"], PROVIDER)
        self.assertEqual(system["base_url"], config_module.router_base_url("https://api.groq.com/openai/v1")[0],
                         "as the Router keeps an address (it adds /v1 itself)")
        self.assertEqual(system["name"], "Groq")
        self.assertEqual(system["workers"], 3, "how many at once")
        self.assertEqual(R._key(self.config, system["id"]), KEY, "the provider's own key")
        self.assertNotIn(KEY, (self.project / ".dgc" / "config.json").read_text() if (self.project / ".dgc" / "config.json").exists() else "")
        self.assertNotIn(KEY, config_module.USER_CONFIG.read_text(), "never copied into the Router's settings")

    def test_the_key_follows_the_provider_and_stops_if_it_moves_or_goes(self):
        system = self.add()
        self.config.set_saved_provider(PROVIDER, {"name": "Groq", "base_url": "https://evil.example/v1",
                                                  "api_mode": "chat_completions", "model": "m", "api_key": KEY})
        self.assertEqual(R._key(self.config, system["id"]), "", "a provider that now points elsewhere: no key here")
        self.config.set_saved_provider(PROVIDER, None)
        self.assertEqual(R._key(self.config, system["id"]), "", "a provider removed: no key")

    def test_an_unknown_provider_is_refused_in_plain_words(self):
        with self.assertRaisesRegex(T.UpdateError, "saved provider"):
            T.plan_update(self.config, {"action": "add_system", "provider": "provider_" + "b" * 32}, detect=False,
                          pick_later=True)

    def test_the_settings_accept_the_field_and_check_its_shape(self):
        block, problems = config_module.validate_router({"enabled": True, "systems": [
            {"id": "groq", "name": "Groq", "base_url": "https://api.groq.com/openai/v1", "provider": PROVIDER}]})
        self.assertEqual(problems, [])
        self.assertEqual(block["systems"][0]["provider"], PROVIDER)
        _block, problems = config_module.validate_router({"enabled": True, "systems": [
            {"id": "groq", "base_url": "https://api.groq.com/openai/v1", "provider": "not-a-provider"}]})
        self.assertTrue(problems)

    def test_the_status_row_names_its_provider_and_says_it_has_a_key_never_showing_it(self):
        self.add()
        status = R.status(self.config)
        row = next(item for item in status["systems"] if item.get("provider") == PROVIDER)
        self.assertTrue(row["has_key"])
        self.assertNotIn(KEY, repr(status))


class ProviderProtocol(unittest.TestCase):
    def test_the_editor_may_send_provider_with_router_update(self):
        from dgc import editor_protocol as ep
        self.assertIn("provider", ep.COMMAND_FIELDS["router_update"])
        self.assertIsNone(ep.command_error({"type": "router_update", "request_id": "r1", "action": "add_system",
                                            "provider": PROVIDER}))

    def test_the_backend_says_it_understands_it(self):
        from dgc.headless import Backend
        self.assertEqual(Backend._router_capability(unittest.mock.MagicMock(config=None))["providers"], 1)


if __name__ == "__main__":
    unittest.main()
