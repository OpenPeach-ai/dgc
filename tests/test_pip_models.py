"""Offline contract tests for per-Pip model choices and immutable connection pins."""
from __future__ import annotations

import copy
import json
import unittest
from unittest.mock import patch

from dgc import pip_models as models
from dgc.workspace_registry import RegistryError


class PipModelsTests(unittest.TestCase):
    def setUp(self):
        self.config = {"model": "fixture-main", "base_url": "http://model.invalid/v1",
                       "api_mode": "chat_completions", "api_key": "secret-fixture-provider-key",
                       "subscription_engine": "", "provider_capabilities": {}}
        self.network = patch("requests.sessions.Session.request", side_effect=AssertionError("No network in model-choice tests"))
        self.network.start()
        self.addCleanup(self.network.stop)

    def assert_code(self, code, function, *args):
        with self.assertRaises(RegistryError) as caught:
            function(*args)
        self.assertEqual(code, caught.exception.code)
        self.assertNotIn(self.config["api_key"], str(caught.exception))

    def test_default_choice_is_strict_and_detached(self):
        value = {"mode": "default"}
        self.assertEqual(value, models.validate_model_choice(value))
        self.assertIsNot(value, models.validate_model_choice(value))
        for invalid in (None, {}, [], "default", {"mode": None}, {"mode": "unknown"},
                        {"mode": "default", "model": "fixture"}, {"mode": "default", "api_key": "secret"},
                        {"mode": "model"}, {"mode": "model", "model": "fixture", "base_url": "http://other.invalid"}):
            with self.subTest(invalid=invalid):
                self.assert_code("invalid_model_choice", models.validate_model_choice, invalid)

    def test_model_ids_are_bounded_and_not_in_error(self):
        for value in (None, 1, True, "", "has space", " leading", "tail\n", "a\x00b", "foo\u202ebar",
                      "https://other.invalid/v1", "a" * 257, "<script>", "x?api_key=secret"):
            with self.subTest(value=value):
                self.assert_code("invalid_model", models.validate_model_choice, {"mode": "model", "model": value})
        for value in ("a" * 256, "org/model:v2", "qwen3:latest", "gpt-5.4", "org/model@v2", "gemma+quant"):
            self.assertEqual(value, models.validate_model_choice({"mode": "model", "model": value})["model"])

    def test_default_resolves_without_discovery_or_config_write(self):
        before = copy.deepcopy(self.config)
        with patch.object(models.LLMClient, "list_models", side_effect=AssertionError("Default does not discover")):
            self.assertEqual("fixture-main", models.resolve_model_choice(self.config, {"mode": "default"}))
            self.config["model"] = "new-main"
            self.assertEqual("new-main", models.resolve_model_choice(self.config, {"mode": "default"}))
        self.config["model"] = "fixture-main"
        self.assertEqual(before, self.config)

    def test_catalog_uses_configured_native_connection_and_real_ids(self):
        before = copy.deepcopy(self.config)
        with patch.object(models, "LLMClient") as factory:
            factory.return_value.list_models.return_value = ["other", "fixture-main", "other"]
            result = models.list_pip_models(self.config)
        self.assertEqual({"default_model": "fixture-main", "models": [{"id": "fixture-main", "name": "fixture-main"},
                           {"id": "other", "name": "other"}], "connection": "configured"}, result)
        self.assertEqual(self.config["base_url"], factory.call_args.kwargs["base_url"])
        self.assertEqual(self.config["api_key"], factory.call_args.kwargs["api_key"])
        self.assertEqual(self.config["api_mode"], factory.call_args.kwargs["api_mode"])
        self.assertEqual(before, self.config)

    def test_explicit_choice_requires_genuine_catalog_membership(self):
        with patch.object(models.LLMClient, "list_models", return_value=["other"]):
            self.assertEqual("other", models.resolve_model_choice(self.config, {"mode": "model", "model": "other"}))
            self.assert_code("model_not_available", models.resolve_model_choice, self.config,
                             {"mode": "model", "model": "fixture-main"})

    def test_catalog_failure_has_no_fake_rows_or_provider_error_data(self):
        secret = self.config["api_key"]
        with patch.object(models.LLMClient, "list_models", side_effect=RuntimeError("Authorization: " + secret + "\nfull body")):
            result = models.list_pip_models(self.config)
            self.assertEqual([], result["models"])
            self.assertEqual("fixture-main", result["default_model"])
            self.assertEqual("model_catalog_unavailable", result["error"]["code"])
            self.assertNotIn(secret, json.dumps(result))
            self.assertNotIn("full body", json.dumps(result))
            self.assert_code("model_catalog_unavailable", models.resolve_model_choice, self.config,
                             {"mode": "model", "model": "fixture-main"})

    def test_empty_catalog_is_honest(self):
        with patch.object(models.LLMClient, "list_models", return_value=[]):
            self.assertEqual([], models.list_pip_models(self.config)["models"])
            self.assert_code("model_not_available", models.resolve_model_choice, self.config,
                             {"mode": "model", "model": "fixture-main"})

    def test_invalid_catalog_fails_closed(self):
        for catalog in ({"models": ["ok"]}, ("ok",), [None], ["ok", "<script>"], ["x" * 257],
                        [self.config["api_key"]], ["ok", {"id": "model"}]):
            with self.subTest(catalog=catalog), patch.object(models.LLMClient, "list_models", return_value=catalog):
                result = models.list_pip_models(self.config)
                self.assertEqual([], result["models"])
                self.assertEqual("invalid_model_catalog", result["error"]["code"])
                self.assertNotIn(self.config["api_key"], json.dumps(result))

    def test_catalog_input_count_and_bytes_are_bounded(self):
        for catalog in (["m"] * (models.MAX_CATALOG_MODELS + 1), ["m" * 256] * 1025):
            with patch.object(models.LLMClient, "list_models", return_value=catalog):
                result = models.list_pip_models(self.config)
                self.assertEqual("model_catalog_limit", result["error"]["code"])
                self.assertEqual([], result["models"])

    def test_display_count_bound_and_explicit_model_beyond_display_remains_valid(self):
        catalog = [f"model-{i:04d}" for i in range(300)]
        with patch.object(models.LLMClient, "list_models", return_value=catalog):
            result = models.list_pip_models(self.config)
            self.assertEqual(256, len(result["models"]))
            self.assertTrue(result["truncated"])
            self.assertEqual("model-0299", models.resolve_model_choice(self.config, {"mode": "model", "model": "model-0299"}))

    def test_display_byte_bound(self):
        catalog = [f"model-{i:04d}-" + "a" * 245 for i in range(256)]
        with patch.object(models.LLMClient, "list_models", return_value=catalog):
            result = models.list_pip_models(self.config)
        self.assertTrue(result["truncated"])
        self.assertLess(len(result["models"]), 256)
        self.assertLessEqual(len(json.dumps(result, separators=(",", ":")).encode()), models.MAX_LIST_BYTES)

    def test_connections_with_secrets_or_invalid_ports_never_discover(self):
        for endpoint in ("file:///secret", "http://user:secret@host.invalid", "https://host.invalid/?key=secret",
                         "https://host.invalid/#secret", "http://host.invalid:65536", "http://[broken",
                         " http://host.invalid", "http://host.invalid\n", "http://host.invalid/space here", None):
            with self.subTest(endpoint=endpoint), patch.object(models.LLMClient, "list_models") as discover:
                config = {**self.config, "base_url": endpoint}
                result = models.list_pip_models(config)
                self.assertEqual("unsupported_model", result["error"]["code"])
                self.assertNotIn("secret", result["error"]["message"])
                discover.assert_not_called()

    def test_subscription_and_invalid_mode_are_refused(self):
        for change in ({"subscription_engine": "codex"}, {"api_mode": "arbitrary"}, {"api_mode": []}):
            with patch.object(models.LLMClient, "list_models") as discover:
                config = {**self.config, **change}
                self.assert_code("unsupported_model", models.resolve_model_choice, config, {"mode": "default"})
                self.assertEqual("unsupported_model", models.list_pip_models(config)["error"]["code"])
                discover.assert_not_called()

    def test_default_secret_shaped_model_is_never_exposed(self):
        config = {**self.config, "model": self.config["api_key"]}
        result = models.list_pip_models(config)
        self.assertEqual("", result["default_model"])
        self.assertNotIn(self.config["api_key"], json.dumps(result))

    def test_execution_keeps_pinned_model_when_main_selection_changes(self):
        pinned = {"base_url": self.config["base_url"] + "/", "api_mode": self.config["api_mode"], "model": "old-model"}
        before = copy.deepcopy(pinned)
        with patch.object(models.LLMClient, "list_models", side_effect=AssertionError("No rediscovery at execution")):
            models.validate_pinned_connection(self.config, pinned)
            models.validate_pinned_connection({**self.config, "model": "new-model", "api_key": "rotated"}, pinned)
        self.assertEqual(before, pinned)

    def test_connection_change_blocks_execution(self):
        pinned = {"base_url": self.config["base_url"], "api_mode": self.config["api_mode"], "model": "old-model"}
        for changes in ({"base_url": "https://another.invalid/v1"}, {"api_mode": "responses"}):
            self.assert_code("model_changed", models.validate_pinned_connection, {**self.config, **changes}, pinned)

    def test_invalid_pin_blocks_execution(self):
        for pinned in (None, {}, {"base_url": "http://valid.invalid/v1", "api_mode": "auto"},
                       {"base_url": "http://name:secret@host.invalid", "api_mode": "auto", "model": "old"}):
            self.assert_code("model_changed", models.validate_pinned_connection, self.config, pinned)


if __name__ == "__main__":
    unittest.main()
