"""The model client on a ChatGPT plan (dgc.llm with dgc.chatgpt_plan, 17 Nov): what DGC sends on the plan route and
what it does with the plan's answers.

The route carries a marker where a key would be (chatgpt_plan.PLAN_KEY); each request asks chatgpt_plan for a live
access token. The request follows the plan's rules: store off, streaming on, system guidance as `instructions`, no
sampling, no output cap, no server-kept state; DGC's own function tools go as usual. The plan's errors are said in
words (the usage page for a used-up limit) and a used-up limit isn't retried. A stand-in Responses API runs here.
"""
from __future__ import annotations

import http.server
import json
import threading
import unittest
from unittest import mock

from dgc import chatgpt_plan as plan
from dgc.llm import LLMClient, LLMError


def sse(obj) -> bytes:
    return f"data: {json.dumps(obj)}\n\n".encode()


class StandIn:
    def __init__(self):
        self.requests = []
        self.answer = "ok"          # ok | limit429 | failed_midstream | not_eligible
        stand = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def do_GET(self):
                stand.requests.append(("GET", self.path, dict(self.headers), None))
                body = json.dumps({"models": [{"slug": "gpt-6.1-sol", "display_name": "GPT-6.1 Sol", "visibility": "list"}]}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self):
                payload = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                stand.requests.append(("POST", self.path, dict(self.headers), payload))
                if stand.answer in ("limit429", "not_eligible"):
                    code = "subscription_sharing_usage_limit_exceeded" if stand.answer == "limit429" else "subscription_sharing_user_not_eligible"
                    body = json.dumps({"error": {"code": code, "message": code}}).encode()
                    self.send_response(429 if stand.answer == "limit429" else 403)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Transfer-Encoding", "chunked")
                self.end_headers()

                def chunk(data: bytes):
                    self.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")
                    self.wfile.flush()
                if stand.answer == "failed_midstream":
                    chunk(sse({"type": "response.output_text.delta", "item_id": "i", "output_index": 0, "content_index": 0, "delta": "par"}))
                    chunk(sse({"type": "response.failed", "response": {"error": {"code": "subscription_sharing_usage_limit_exceeded",
                                                                                 "message": "limit"}}}))
                else:
                    chunk(sse({"type": "response.output_text.delta", "item_id": "i", "output_index": 0, "content_index": 0, "delta": "Hello"}))
                    chunk(sse({"type": "response.completed", "response": {"id": "r1", "status": "completed", "usage": {},
                               "output": [{"type": "message", "id": "i", "role": "assistant",
                                           "content": [{"type": "output_text", "text": "Hello"}]}]}}))
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}/v1"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


TOOL = {"type": "function", "function": {"name": "read_file", "description": "Read a file",
                                         "parameters": {"type": "object", "properties": {"path": {"type": "string"}}}}}
MESSAGES = [{"role": "system", "content": "You are DGC."}, {"role": "user", "content": "Say hello."}]


class PlanClientTest(unittest.TestCase):
    def setUp(self):
        self.stand = StandIn()
        self.addCleanup(self.stand.close)
        token = mock.patch.object(plan, "access_token", return_value="live-access-token")
        token.start()
        self.addCleanup(token.stop)

    def client(self, **extra):
        return LLMClient(self.stand.base, plan.PLAN_KEY, "gpt-6.1-sol", api_mode="responses", max_tokens=4096,
                         sampling={"temperature": 0.2, "top_p": 0.9}, provider_state="server", **extra)

    def test_the_request_follows_the_plans_rules_with_a_live_token(self):
        result = self.client().chat(MESSAGES, tools=[TOOL])
        self.assertIn("Hello", result.text if hasattr(result, "text") else str(result))
        method, path, headers, payload = [r for r in self.stand.requests if r[0] == "POST"][-1]
        self.assertEqual(path, "/v1/responses")
        self.assertEqual(headers.get("Authorization"), "Bearer live-access-token", "the plan's token, never the marker")
        self.assertIs(payload["store"], False)
        self.assertIs(payload["stream"], True)
        self.assertEqual(payload["instructions"], "You are DGC.")
        self.assertFalse(any(item.get("role") == "system" for item in payload["input"] if isinstance(item, dict)))
        for refused in ("temperature", "top_p", "max_output_tokens", "previous_response_id"):
            self.assertNotIn(refused, payload)
        self.assertEqual([t.get("name") for t in payload.get("tools", [])], ["read_file"], "DGC's own tools go as usual")
        self.assertNotIn("OpenAI-Organization", headers)

    def test_a_used_up_limit_says_where_to_look_and_is_not_retried(self):
        self.stand.answer = "limit429"
        with self.assertRaises(LLMError) as caught:
            self.client().chat(MESSAGES)
        self.assertIn("chatgpt.com/settings/usage", str(caught.exception))
        self.assertEqual(len([r for r in self.stand.requests if r[0] == "POST"]), 1)

    def test_a_limit_mid_stream_says_the_same(self):
        self.stand.answer = "failed_midstream"
        with self.assertRaises(LLMError) as caught:
            self.client().chat(MESSAGES)
        self.assertIn("chatgpt.com/settings/usage", str(caught.exception))

    def test_an_account_that_cant_share_its_plan_says_why(self):
        self.stand.answer = "not_eligible"
        with self.assertRaises(LLMError) as caught:
            self.client().chat(MESSAGES)
        self.assertIn("Plus or Pro", str(caught.exception))

    def test_no_sign_in_says_connect_in_settings(self):
        with mock.patch.object(plan, "access_token", side_effect=plan.PlanError("not_connected", "DGC isn't signed in to your ChatGPT plan. Connect again in Settings › Models.")):
            with self.assertRaises(LLMError) as caught:
                self.client().chat(MESSAGES)
        self.assertIn("Connect again", str(caught.exception))
        self.assertEqual([r for r in self.stand.requests if r[0] == "POST"], [], "nothing is sent without a sign-in")

    def test_the_model_list_is_the_plans(self):
        with mock.patch.object(plan, "models", return_value=[{"slug": "gpt-6.1-sol", "name": "GPT-6.1 Sol"}]) as listed:
            self.assertEqual(self.client().list_models(), ["gpt-6.1-sol"])
        listed.assert_called_once()

    def test_an_ordinary_openai_key_is_untouched(self):
        client = LLMClient(self.stand.base, "sk-ordinary", "gpt-6.1-sol", api_mode="responses", max_tokens=4096)
        client.chat(MESSAGES)
        headers = [r for r in self.stand.requests if r[0] == "POST"][-1][2]
        self.assertEqual(headers.get("Authorization"), "Bearer sk-ordinary")


if __name__ == "__main__":
    unittest.main()
