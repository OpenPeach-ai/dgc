"""A Pip can run on any provider saved in Settings -> Models: the Pip keeps its id and a model, the key stays in
secrets.json, and a removed provider refuses in plain words, never falling back to another connection."""
from __future__ import annotations

import json
import stat
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from dgc import config as config_module
from dgc import memory_review, pip_memory_review, pip_models, pips
from dgc.redaction import secret_values
from dgc.workspace_registry import RegistryError

PROVIDER = "provider_" + "a" * 32
SECOND_KEY = "second-host-secret-key"
DEFAULT_KEY = "default-host-secret-key"
RECORD = {"name": "Second host", "base_url": "http://second.example/v1", "api_mode": "chat_completions",
          "model": "second-model", "api_key": SECOND_KEY}


class Home(unittest.TestCase):
    def setUp(self):
        self.folder = Path(tempfile.mkdtemp())
        self.config_path, self.secrets_path = self.folder / "config.json", self.folder / "secrets.json"
        self.config_path.write_text(json.dumps({"base_url": "http://default.example/v1", "model": "default-model",
                                                "api_mode": "auto"}))
        for name, path in (("USER_CONFIG", self.config_path), ("USER_SECRETS", self.secrets_path)):
            patcher = mock.patch.object(config_module, name, path)
            patcher.start()
            self.addCleanup(patcher.stop)

    def fresh(self):
        return config_module.Config(project_root=self.folder)

    def saved(self):
        config = self.fresh()
        config.set("api_key", DEFAULT_KEY)
        config.set_saved_provider(PROVIDER, RECORD)
        return self.fresh()

    def choice(self, model="second-model"):
        return {"mode": "provider", "provider": PROVIDER, "model": model}


class TheChoice(unittest.TestCase):
    def test_it_holds_an_id_and_a_model_and_nothing_else(self):
        choice = {"mode": "provider", "provider": PROVIDER, "model": "m"}
        self.assertEqual(pip_models.validate_model_choice(choice), choice)
        for bad in ({**choice, "api_key": "k"}, {**choice, "base_url": "http://x/v1"}, {"mode": "provider", "provider": PROVIDER},
                    {**choice, "provider": "subscription_codex"}, {**choice, "provider": "../x"}, {**choice, "model": "a b"}):
            with self.assertRaises(RegistryError):
                pip_models.validate_model_choice(bad)


class TheStore(Home):
    def test_the_key_is_in_the_private_secrets_file_and_not_in_settings(self):
        config = self.saved()
        self.assertEqual(config.saved_provider(PROVIDER)["api_key"], SECOND_KEY)
        self.assertNotIn(SECOND_KEY, self.config_path.read_text())
        self.assertNotIn(SECOND_KEY, json.dumps(config.data))
        self.assertEqual(stat.S_IMODE(self.secrets_path.stat().st_mode), 0o600)

    def test_another_process_saving_its_settings_keeps_it(self):
        other = self.fresh()                        # started before the provider was saved
        self.saved()
        other.set("api_key", "changed-by-another-session")
        self.assertEqual(self.fresh().saved_provider(PROVIDER)["api_key"], SECOND_KEY)
        self.assertEqual(self.fresh().api_key, "changed-by-another-session")

    def test_a_private_view_that_outlives_the_removal_sees_it_gone(self):
        view = self.saved().clone_for_root(self.folder)
        self.fresh().set_saved_provider(PROVIDER, None)
        self.assertIsNone(view.saved_provider(PROVIDER))
        self.assertNotIn(SECOND_KEY, self.secrets_path.read_text())
        self.assertEqual(self.fresh().api_key, DEFAULT_KEY, "forgetting it leaves the default key alone")

    def test_its_key_is_redacted(self):
        self.assertIn(SECOND_KEY, secret_values(self.saved()))


class TheRun(Home):
    def test_it_pins_the_provider_address_with_no_key_and_runs_with_that_key(self):
        config = self.saved()
        settings = pips._model_settings(config, self.choice())
        self.assertEqual((settings["base_url"], settings["api_mode"], settings["model"], settings["provider"]),
                         (RECORD["base_url"], RECORD["api_mode"], "second-model", PROVIDER))
        self.assertNotIn(SECOND_KEY, json.dumps(settings))
        self.assertNotIn(DEFAULT_KEY, json.dumps(settings))
        pip_models.validate_pinned_connection(config, settings)
        run = pip_models.run_view(config.clone_for_root(self.folder), settings)
        self.assertEqual(run.get("api_key"), SECOND_KEY)
        self.assertEqual(run.base_url, RECORD["base_url"])
        self.assertEqual(config.base_url, "http://default.example/v1", "the default connection stays as it was")
        self.assertEqual(config.get("api_key"), DEFAULT_KEY)

    def test_a_chat_on_another_provider_does_not_move_it(self):
        config = self.saved()
        chat = config.clone_for_root(self.folder)
        chat.data.update(base_url="http://chat.example/v1", model="chat-model", subscription_engine="claude")
        settings = pips._model_settings(chat, self.choice())
        self.assertEqual((settings["base_url"], settings["provider"]), (RECORD["base_url"], PROVIDER))
        self.assertNotIn("brain", settings)
        pip_models.validate_pinned_connection(self.fresh(), settings)

    def test_a_pip_on_default_stays_on_the_default_connection(self):
        settings = pips._model_settings(self.saved(), {"mode": "default"})
        self.assertEqual(settings["base_url"], "http://default.example/v1")
        self.assertNotIn("provider", settings)

    def test_another_model_is_looked_up_at_that_provider_with_its_key(self):
        config = self.saved()
        with mock.patch.object(pip_models, "LLMClient") as client:
            client.return_value.list_models.return_value = ["other-model"]
            client.return_value.api_mode = "chat_completions"
            self.assertEqual(pips._model_settings(config, self.choice("other-model"))["model"], "other-model")
            self.assertEqual(client.call_args.kwargs["base_url"], RECORD["base_url"])
            self.assertEqual(client.call_args.kwargs["api_key"], SECOND_KEY)
            with self.assertRaises(RegistryError) as refused:
                pips._model_settings(config, self.choice("not-offered"))
        self.assertIn("doesn't offer", str(refused.exception))

    def test_the_saved_model_runs_even_on_a_host_that_lists_nothing(self):
        with mock.patch.object(pip_models, "LLMClient") as client:
            self.assertEqual(pips._model_settings(self.saved(), self.choice())["model"], "second-model")
        client.assert_not_called()

    def test_a_removed_provider_refuses_in_plain_words_and_never_falls_back(self):
        config = self.saved()
        settings = pips._model_settings(config, self.choice())
        self.fresh().set_saved_provider(PROVIDER, None)
        with self.assertRaises(RegistryError) as queued:
            pips._model_settings(config, self.choice())
        with self.assertRaises(RegistryError) as started:
            pip_models.validate_pinned_connection(config, settings)
        for refused in (queued.exception, started.exception):
            self.assertIn("removed from Settings", str(refused))
        self.assertEqual(started.exception.code, "model_changed")

    def test_the_look_back_uses_that_provider_and_key_and_stops_when_it_is_gone(self):
        config = self.saved()
        settings = pips._model_settings(config, self.choice())
        registry = mock.MagicMock()
        registry.db.execute.return_value.fetchone.return_value = {"manifest": json.dumps({"model_settings": settings})}
        with mock.patch.object(memory_review, "client_for", return_value="client") as client_for:
            self.assertEqual(pip_memory_review._client(registry, config, "run"), "client")
        used = client_for.call_args.args[0]
        self.assertEqual((used.base_url, used.api_key), (RECORD["base_url"], SECOND_KEY))
        self.fresh().set_saved_provider(PROVIDER, None)
        self.assertIsNone(pip_memory_review._client(registry, config, "run"))
