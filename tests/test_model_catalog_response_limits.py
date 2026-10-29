"""Model discovery bounds provider responses before decoding JSON."""
import unittest
from unittest.mock import patch

from dgc import llm


class ModelCatalogResponseLimits(unittest.TestCase):
    def test_ollama_and_compatible_catalogs_stop_oversize_streams(self):
        for mode in ("ollama", "chat_completions"):
            with self.subTest(mode=mode):
                class Response:
                    status_code = 200
                    headers = {}
                    closed = False
                    def iter_content(self, chunk_size):
                        yield b" " * llm._MAX_MODEL_METADATA_BYTES
                        yield b"x"
                    def close(self):
                        self.closed = True

                response = Response()
                with patch.object(llm.requests, "get", return_value=response) as get:
                    client = llm.LLMClient("http://127.0.0.1:11434/v1", "key", "model", api_mode=mode)
                    with self.assertRaisesRegex(llm.LLMError, "exceeded"):
                        client.list_models()
                self.assertTrue(get.call_args.kwargs["stream"])
                self.assertTrue(response.closed)
