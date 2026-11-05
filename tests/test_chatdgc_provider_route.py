"""A saved ChatDGC model host is scoped to its turn and never saved with the chat."""
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from dgc.chatdgc.engine import ChatEngine, ChatEngineError
from dgc.chatdgc.service import _provider_route
from dgc.chatdgc.store import ChatStore
from dgc.shared_memory import SharedMemory


PROFILE = "provider_" + "a" * 32
ROUTE = {"id": PROFILE, "base_url": "http://127.0.0.1:11434/v1",
         "api_key": "test-secret", "api_mode": "ollama"}


class ProviderRouteTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        folder = Path(temporary.name)
        config = SimpleNamespace(base_url="", api_key="", model="", get=lambda key, default=None: default)
        self.engine = ChatEngine(config, ChatStore(folder / "chat"), memory=SharedMemory(folder / "memory"),
                                 projects=lambda hidden: [])

    def test_native_route_uses_its_own_host_and_model_without_exposing_the_key_in_chat(self):
        chat = self.engine.open()
        model = f"provider:{PROFILE}:deepseek-v4.1-flash:cloud"
        with patch("dgc.llm.LLMClient") as factory:
            with self.engine.provider_turn(ROUTE):
                self.engine.client(model)
            args = factory.call_args.args
        self.assertEqual(args[:3], (ROUTE["base_url"], ROUTE["api_key"], "deepseek-v4.1-flash:cloud"))
        self.assertNotIn(ROUTE["api_key"], str(self.engine.open(chat["id"])))
        # Follow-ups and the context meter use separate threads after the turn.
        with patch("dgc.llm.LLMClient") as factory:
            self.engine.client(model)
            self.assertEqual(factory.call_args.args[:3], args[:3])
        with patch("dgc.chatdgc.engine.time.monotonic", return_value=10_000_000_000):
            with self.assertRaisesRegex(ChatEngineError, "unavailable"):
                self.engine.client(model)

    def test_wrong_provider_id_and_bad_url_fail_closed(self):
        with self.engine.provider_turn(ROUTE):
            with self.assertRaisesRegex(ChatEngineError, "unavailable"):
                self.engine.client("provider:provider_" + "b" * 32 + ":model")
        with self.assertRaisesRegex(ChatEngineError, "plain HTTP or HTTPS"):
            _provider_route({**ROUTE, "base_url": "https://key@example.com/v1"})
        with self.assertRaisesRegex(ChatEngineError, "invalid"):
            _provider_route({**ROUTE, "api_mode": "unsafe"})


if __name__ == "__main__":
    unittest.main()
