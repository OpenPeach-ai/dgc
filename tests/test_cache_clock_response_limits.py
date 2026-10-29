"""Ollama's cache probe must not load an unbounded JSON body."""

import unittest
from unittest.mock import patch


class ResponseLimitsTests(unittest.TestCase):
    def test_oversized_response_is_ignored_and_closed(self):
        from dgc import cache_clock
        class Response:
            status_code = 200
            closed = False

            def iter_content(self, chunk_size):
                yield b"x" * 1_048_577

            def close(self):
                self.closed = True

        response = Response()
        with patch("requests.get", return_value=response) as get:
            self.assertIsNone(cache_clock.ollama_listed("http://localhost:11434", "model"))
        self.assertTrue(response.closed)
        self.assertTrue(get.call_args.kwargs["stream"])


if __name__ == "__main__":
    unittest.main()
