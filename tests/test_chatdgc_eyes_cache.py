"""Vision routing follows live model settings rather than a stale route cache."""

import unittest
from unittest.mock import patch

from dgc.chatdgc.eyes import Eyes


class FakeConfig(dict):
    base_url = "http://localhost:11434"
    api_key = "key"
    model = "main"


class FakeEngine:
    def __init__(self):
        self.config = FakeConfig(subagent_model="first")

    def client(self, model, **_kwargs):
        return model


class EyesCacheTests(unittest.TestCase):
    def test_settings_change_invalidates_cached_route(self):
        engine = FakeEngine()
        eyes = Eyes(engine)
        with patch("dgc.vision.has_vision", side_effect=lambda model, _cancel: model != "chat"):
            self.assertEqual(eyes.route("chat")["model"], "first")
            engine.config["subagent_model"] = "second"
            self.assertEqual(eyes.route("chat")["model"], "second")


if __name__ == "__main__":
    unittest.main()
