"""A provider that fails after answering 200, and image data a provider cannot read.

Both were found running DGC on Terminal-Bench against Ollama Cloud (2026-10):

* Ollama answered 200 and then sent ``{"error": "Internal Server Error"}`` as the first line of the
  stream. A 5xx before streaming was retried; this one ended the turn at once, so a whole task died on
  one provider hiccup. Until anything has been shown, it is retried like that 5xx, from the same budget.
  Once text, thinking or a tool call has reached the caller, it still stops: sending the request again
  would show that output twice.
* A screenshot the model asked to see came back from Ollama as HTTP 400 "illegal base64 data at input
  byte N". The model reads images; the provider could not read this one. The turn now goes on without
  the image and tells the model why, and the model stays marked as able to read images.
"""
from __future__ import annotations

import base64
import copy
import http.server
import json
import threading
import unittest
from unittest.mock import patch

from dgc.llm import LLMClient, LLMError

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 24
IMAGE_MESSAGES = [{"role": "user", "content": [
    {"type": "text", "text": "what does the screenshot show?"},
    {"type": "image_url", "image_url": {"url": "data:image/png;base64," + base64.b64encode(PNG).decode()}}]}]
TEXT_MESSAGES = [{"role": "user", "content": "say ok"}]


def ndjson(*objects) -> bytes:
    return b"".join(json.dumps(obj).encode() + b"\n" for obj in objects)


DONE = {"message": {"role": "assistant", "content": ""}, "done": True, "done_reason": "stop"}


def answer(text: str) -> tuple[int, str, bytes]:
    return 200, "application/x-ndjson", ndjson({"message": {"role": "assistant", "content": text}, "done": False}, DONE)


class FakeOllama:
    """Native Ollama (/api/chat, /api/show) and OpenAI-compatible (/v1/chat/completions), one scripted
    answer per chat request."""

    def __init__(self, script):
        self.script = script
        self.chats: list[dict] = []
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length) or b"{}")
                if self.path.endswith("/api/show"):
                    status, kind, raw = 200, "application/json", json.dumps(
                        {"capabilities": ["completion", "tools", "vision"], "model_info": {}}).encode()
                elif self.path.endswith("/api/chat") or self.path.endswith("/chat/completions"):
                    owner.chats.append(body)
                    status, kind, raw = owner.script(self.path, body, len(owner.chats))
                else:
                    status, kind, raw = 404, "application/json", b"{}"
                self.send_response(status)
                self.send_header("Content-Type", kind)
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()

    def images_in(self, index: int) -> int:
        count = 0
        for message in self.chats[index].get("messages") or []:
            count += len(message.get("images") or [])
            content = message.get("content")
            if isinstance(content, list):
                count += sum(1 for part in content if isinstance(part, dict) and part.get("type") == "image_url")
        return count


class _Case(unittest.TestCase):
    def serve(self, script) -> FakeOllama:
        server = FakeOllama(script)
        self.addCleanup(server.close)
        return server

    def native(self, server: FakeOllama) -> LLMClient:
        return LLMClient(server.url, "", "stream-model", api_mode="ollama", read_timeout=10)


@patch("dgc.llm._wait_for_retry", return_value=True)       # no real backoff sleeps
class InStreamErrorTests(_Case):
    def test_an_error_before_any_output_is_sent_again(self, _wait):
        def script(path, body, n):
            if n == 1:
                return 200, "application/x-ndjson", ndjson({"error": "Internal Server Error"})
            return answer("ok")
        server = self.serve(script)
        result = self.native(server).chat(copy.deepcopy(TEXT_MESSAGES))
        self.assertEqual(result.content, "ok")
        self.assertEqual(len(server.chats), 2, "one failed stream, one retry")
        self.assertEqual(server.chats[0], server.chats[1], "the same request went again")

    def test_the_retry_is_announced_like_any_other(self, _wait):
        def script(path, body, n):
            return (200, "application/x-ndjson", ndjson({"error": "Internal Server Error"})) if n == 1 else answer("ok")
        server = self.serve(script)
        client = self.native(server)
        with patch.object(client, "_retry_transport", wraps=client._retry_transport) as retried:
            self.assertEqual(client.chat(copy.deepcopy(TEXT_MESSAGES)).content, "ok")
        self.assertEqual(retried.call_count, 1)
        cause, attempt = retried.call_args.args[0], retried.call_args.args[1]
        self.assertEqual(attempt, 1)
        self.assertEqual(cause.http_status, 500)

    def test_an_error_after_text_was_shown_is_not_sent_again(self, _wait):
        def script(path, body, n):
            return 200, "application/x-ndjson", ndjson(
                {"message": {"role": "assistant", "content": "Half an ans"}, "done": False},
                {"error": "Internal Server Error"})
        server = self.serve(script)
        shown: list[str] = []
        with self.assertRaises(LLMError) as raised:
            self.native(server).chat(copy.deepcopy(TEXT_MESSAGES), on_text=shown.append)
        self.assertIn("Ollama stream error: Internal Server Error", str(raised.exception))
        self.assertEqual(len(server.chats), 1, "repeating it would show the half answer twice")
        self.assertEqual("".join(shown), "Half an ans")

    def test_an_error_after_thinking_was_shown_is_not_sent_again(self, _wait):
        def script(path, body, n):
            return 200, "application/x-ndjson", ndjson(
                {"message": {"role": "assistant", "thinking": "Let me look"}, "done": False},
                {"error": "Internal Server Error"})
        server = self.serve(script)
        with self.assertRaises(LLMError):
            self.native(server).chat(copy.deepcopy(TEXT_MESSAGES), on_thinking=lambda *a: None)
        self.assertEqual(len(server.chats), 1)

    def test_a_provider_that_keeps_failing_ends_the_turn_after_four_tries(self, _wait):
        server = self.serve(lambda path, body, n: (200, "application/x-ndjson",
                                                   ndjson({"error": "Internal Server Error"})))
        with self.assertRaises(LLMError) as raised:
            self.native(server).chat(copy.deepcopy(TEXT_MESSAGES))
        self.assertIn("failed repeatedly", str(raised.exception))
        self.assertIn("Internal Server Error", str(raised.exception))
        self.assertEqual(len(server.chats), 4, "the same budget as a 5xx before streaming")

    def test_a_cancel_during_the_backoff_stops_quietly(self, wait):
        wait.return_value = False                           # Esc while waiting to retry
        server = self.serve(lambda path, body, n: (200, "application/x-ndjson",
                                                   ndjson({"error": "Internal Server Error"})))
        result = self.native(server).chat(copy.deepcopy(TEXT_MESSAGES))
        self.assertEqual(result.finish_reason, "cancelled")
        self.assertEqual(len(server.chats), 1)


class UnreadableImageTests(_Case):
    BASE64_400 = (400, "application/json",
                  json.dumps({"error": "illegal base64 data at input byte 4"}).encode())

    def script(self):
        def script(path, body, n):
            if n == 1:
                return self.BASE64_400
            if path.endswith("/chat/completions"):
                return 200, "application/json", json.dumps({"choices": [{"index": 0, "finish_reason": "stop",
                    "message": {"role": "assistant", "content": "ok"}}]}).encode()
            return answer("ok")
        return script

    def assert_went_on_without_the_image(self, server, client, result):
        self.assertEqual(result.content, "ok")
        self.assertEqual(len(server.chats), 2)
        self.assertEqual((server.images_in(0), server.images_in(1)), (1, 0))
        retried = json.dumps(server.chats[1])
        self.assertIn("could not read the image data", retried)
        self.assertNotIn("cannot read images", retried, "the model reads images; this image was the problem")
        self.assertTrue(client.vision_supported, "one bad image does not switch vision off")
        self.assertEqual(client.dropped_images, 1)

    def test_native_ollama(self):
        server = self.serve(self.script())
        client = self.native(server)
        self.assertTrue(client.vision_supported)
        result = client.chat(copy.deepcopy(IMAGE_MESSAGES))
        self.assert_went_on_without_the_image(server, client, result)

    def test_chat_completions(self):
        server = self.serve(self.script())
        client = LLMClient(server.url + "/v1", "", "stream-model", api_mode="chat_completions", read_timeout=10)
        result = client.chat(copy.deepcopy(IMAGE_MESSAGES))
        self.assert_went_on_without_the_image(server, client, result)

    def test_the_next_image_is_still_sent(self):
        server = self.serve(self.script())
        client = self.native(server)
        client.chat(copy.deepcopy(IMAGE_MESSAGES))
        client.chat(copy.deepcopy(IMAGE_MESSAGES))
        self.assertEqual(server.images_in(2), 1, "a later request carries its image")

    def test_a_base64_error_without_images_is_an_error(self):
        server = self.serve(lambda path, body, n: self.BASE64_400)
        with self.assertRaises(LLMError):
            self.native(server).chat(copy.deepcopy(TEXT_MESSAGES))
        self.assertEqual(len(server.chats), 1, "nothing to drop, so nothing to retry")


if __name__ == "__main__":
    unittest.main()
