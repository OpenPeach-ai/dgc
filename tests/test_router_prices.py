"""DGC Router: what a model costs (0.52, the Router's cloud providers: "the cost per token shown").

A provider's own model list may say what each model costs (OpenRouter: dollars per token as text; Together: dollars per
million). DGC reads it with the model list it already reads, and the person may set their own price on any model
(set_model price_in / price_out, US dollars per million tokens), which wins. Status, Settings and the main model's
router_status then show it; 0 is a price too (a free model)."""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import config as config_module
from dgc import router as R
from dgc import router_probe as probe
from dgc import router_state
from dgc import router_tools as T


class ListedPrices(unittest.TestCase):
    def test_openrouter_lists_dollars_per_token_as_text(self):
        self.assertEqual(probe.listed_price({"pricing": {"prompt": "0.0000003", "completion": "0.0000012"}}),
                         {"price_in": 0.3, "price_out": 1.2})

    def test_together_lists_dollars_per_million(self):
        self.assertEqual(probe.listed_price({"pricing": {"hourly": 0, "input": 0.88, "output": 0.88}}),
                         {"price_in": 0.88, "price_out": 0.88})

    def test_free_is_a_price_and_nonsense_is_left_out(self):
        self.assertEqual(probe.listed_price({"pricing": {"prompt": "0", "completion": "0"}}),
                         {"price_in": 0.0, "price_out": 0.0})
        for row in ({"pricing": {"prompt": "-1", "completion": "-1"}}, {"pricing": {"prompt": "x", "completion": "1"}},
                    {"pricing": "cheap"}, {"pricing": {"input": 1}}, {}, {"pricing": {"input": float("nan"), "output": 1}}):
            self.assertEqual(probe.listed_price(row), {}, row)

    def test_the_model_list_carries_them_with_its_context(self):
        listing = {"data": [{"id": "meta-llama/llama-3.3-70b-instruct", "context_length": 131072,
                             "pricing": {"prompt": "0.00000059", "completion": "0.00000079"}},
                            {"id": "plain-model"}]}
        with patch.object(probe, "http_get", return_value=(200, listing)):
            models = probe.discover("https://openrouter.ai/api", "openai_compatible", "k")["models"]
        self.assertEqual(models[0]["price_in"], 0.59)
        self.assertEqual(models[0]["price_out"], 0.79)
        self.assertEqual(models[0]["context_max"], 131072)
        self.assertNotIn("price_in", models[1])


class RouterPrices(unittest.TestCase):
    def setUp(self):
        home = Path(tempfile.mkdtemp(prefix="dgc-router-prices-")).resolve()
        (home / "dgc").mkdir()
        for name, value in (("USER_HOME", home / "dgc"), ("USER_CONFIG", home / "dgc" / "config.json"),
                            ("USER_SECRETS", home / "dgc" / "secrets.json")):
            patcher = patch.object(config_module, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        state = patch.object(router_state, "directory", lambda: home / "router-state")
        state.start()
        self.addCleanup(state.stop)
        self.project = home / "project"
        self.project.mkdir()
        self.config = config_module.Config(project_root=self.project)
        plan = T.plan_update(self.config, {"action": "add_system", "base_url": "https://openrouter.ai/api/v1",
                                           "name": "OpenRouter", "models": ["meta-llama/llama-3.3-70b-instruct",
                                                                            "free/model"]},
                             detect=False, pick_later=True)
        T.apply_plan(self.config, plan)
        self.system_id = plan.system_id

    def row(self, name):
        status = R.status(self.config)
        system = next(s for s in status["systems"] if s["id"] == self.system_id)
        return next(m for m in system["models"] if m["name"] == name), status

    def set_model(self, **args):
        T.apply_plan(self.config, T.plan_update(self.config, {"action": "set_model", "system": self.system_id, **args}))

    def test_a_listed_price_shows_and_the_persons_own_wins_and_can_be_removed(self):
        router_state.save_discovery(self.system_id, {"server": "openai_compatible", "models": [
            {"name": "meta-llama/llama-3.3-70b-instruct", "price_in": 0.59, "price_out": 0.79}]})
        row, status = self.row("meta-llama/llama-3.3-70b-instruct")
        self.assertEqual((row["price_in"], row["price_out"], row["price_from"]), (0.59, 0.79, "provider"))
        self.assertIn("$0.59 in, $0.79 out per million tokens", T.status_text(status))
        self.set_model(model="meta-llama/llama-3.3-70b-instruct", price_in=0.5, price_out=0.6)
        row, _ = self.row("meta-llama/llama-3.3-70b-instruct")
        self.assertEqual((row["price_in"], row["price_out"], row["price_from"]), (0.5, 0.6, "you"))
        self.set_model(model="meta-llama/llama-3.3-70b-instruct", price_in=-1, price_out=-1)
        row, _ = self.row("meta-llama/llama-3.3-70b-instruct")
        self.assertEqual(row["price_from"], "provider", "back to the provider's own")

    def test_free_is_shown_as_free(self):
        self.set_model(model="free/model", price_in=0, price_out=0)
        row, status = self.row("free/model")
        self.assertEqual((row["price_in"], row["price_out"]), (0, 0))
        self.assertIn("free/model: ", T.status_text(status))
        self.assertIn("free", T.status_text(status).split("free/model: ")[1].splitlines()[0])

    def test_no_price_says_nothing(self):
        row, _ = self.row("free/model")
        self.assertNotIn("price_in", row)

    def test_a_price_must_be_dollars_per_million(self):
        for bad in ("cheap", True, 20_000):
            _block, problems = config_module.validate_router({"enabled": True, "systems": [
                {"id": "x", "base_url": "http://a:1", "models": [{"name": "m", "price_in": bad}]}]})
            self.assertTrue(problems, bad)

    def test_tiny_prices_keep_their_digits(self):
        self.assertEqual(T.price_words(0.005, 0.02), "$0.005 in, $0.02 out per million tokens")


class PriceProtocol(unittest.TestCase):
    def test_the_editor_may_send_prices_and_the_backend_says_it_takes_them(self):
        from unittest.mock import MagicMock
        from dgc import editor_protocol as ep
        from dgc.headless import Backend
        self.assertIsNone(ep.command_error({"type": "router_update", "request_id": "r", "action": "set_model",
                                            "system": "x", "model": "m", "price_in": 0.5, "price_out": 1}))
        self.assertEqual(Backend._router_capability(MagicMock(config=None))["prices"], 1)


if __name__ == "__main__":
    unittest.main()
