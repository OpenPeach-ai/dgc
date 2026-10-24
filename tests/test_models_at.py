"""Settings lists the models at a host as it is typed (`list_models_at`, answered by `models_at`).

Each Model box in the editor's Settings lists its own card's host before anything is saved: the main
connection, the sub-agents' and the fallback's. The hard rule pinned here: a saved API key only ever goes
to the host it is bound to. Every host is a local stub that records the headers of every request, and the
saved keys are real Config bindings (each key handed to the launch for the endpoint configured then).

- a host other than the bound one (another port, the same host on another path) never receives a saved key;
- a key typed beside the host goes to that host, and only there;
- a redirect is never followed, so even Anthropic's x-api-key (which requests does not drop on a redirect)
  stays with the host it was sent to;
- nothing a frame carries holds a key; a failure is a few words, never the URL or the host's body;
- a newer request for the same box replaces one still waiting, so typing never piles requests up.
"""
from __future__ import annotations

import http.server
import io
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch


def _real_account_home() -> Path:
    try:
        import pwd
        return Path(pwd.getpwuid(os.getuid()).pw_dir).resolve(strict=False)
    except (ImportError, KeyError, AttributeError):
        return Path(os.path.expanduser("~")).resolve(strict=False)


if "dgc.config" in sys.modules:
    _user_home = Path(sys.modules["dgc.config"].USER_HOME).resolve(strict=False)
    _account_home = _real_account_home()
    if _user_home == _account_home or _account_home in _user_home.parents:
        raise RuntimeError("tests/test_models_at.py needs HOME redirected before dgc is imported")
else:
    _ISOLATED_HOME = tempfile.TemporaryDirectory(prefix="dgc-models-at-home-")
    os.environ["HOME"] = os.path.realpath(_ISOLATED_HOME.name)
    os.environ["USERPROFILE"] = os.environ["HOME"]

from dgc import config as config_module  # noqa: E402
from dgc import editor_protocol as ep  # noqa: E402
from dgc import headless, sessions  # noqa: E402
from dgc.config import Config, bound_provider_key  # noqa: E402

MAIN_KEY = "sk-main-saved-0123456789"
SUB_KEY = "sk-subagent-saved-0123456789"
FALLBACK_KEY = "sk-fallback-saved-0123456789"
SAVED = (MAIN_KEY, SUB_KEY, FALLBACK_KEY)


class StubHost:
    """A model host on 127.0.0.1 that keeps every request's path and headers. Ollama's /api/tags, an
    OpenAI-compatible /v1/models, Anthropic's /v1/models?limit=1000; or a redirect, a status, or a hold."""

    def __init__(self):
        self.seen: list[tuple[str, dict]] = []
        self.redirect_to = ""
        self.status = 200
        self.hold: threading.Event | None = None
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def do_GET(self):
                owner.seen.append((self.path, {k.lower(): v for k, v in self.headers.items()}))
                if owner.hold is not None:
                    owner.hold.wait(15)
                if owner.redirect_to:
                    self.send_response(307)
                    self.send_header("Location", owner.redirect_to + self.path)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                status = owner.status
                if status != 200:        # a refusal that quotes a key: it must never reach a frame
                    body = {"error": f"bad key {MAIN_KEY}"}
                elif self.path.endswith("/api/tags"):
                    body = {"models": [{"name": "qwen3:8b"}, {"name": "glm-5.3:cloud"}]}
                elif "/models" in self.path:
                    body = {"object": "list", "data": [{"id": "served-a", "type": "model"},
                                                       {"id": "served-b", "type": "model"}]}
                else:
                    status, body = 404, {"error": "not found"}
                raw = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def keys_received(self) -> set[str]:
        """Every credential this host was sent, from any header that could carry one."""
        got = set()
        for _path, headers in self.seen:
            for name in ("authorization", "x-api-key", "api-key"):
                value = headers.get(name, "")
                value = value[len("Bearer "):] if value.startswith("Bearer ") else value
                if value.strip():
                    got.add(value.strip())
        return got

    def close(self):
        if self.hold is not None:
            self.hold.set()
        self.server.shutdown()
        self.server.server_close()


class ListModelsAt(unittest.TestCase):
    def setUp(self):
        tmp = Path(tempfile.mkdtemp(prefix="dgc-models-at-")).resolve()
        self.user = tmp / "user-dgc"
        self.user.mkdir()
        for name, value in (("USER_HOME", self.user), ("USER_CONFIG", self.user / "config.json"),
                            ("USER_SECRETS", self.user / "secrets.json")):
            patcher = patch.object(config_module, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.root = tmp / "project"
        (self.root / ".git").mkdir(parents=True)
        self.main, self.sub, self.other = StubHost(), StubHost(), StubHost()
        for host in (self.main, self.sub, self.other):
            self.addCleanup(host.close)

    def host(self, keys=None, **values):
        (self.user / "config.json").write_text(json.dumps({
            "suggest": False, "artifact_autostart": False, "mcp_servers": {}, "model": "fixture",
            "base_url": self.main.url + "/v1", "api_mode": "ollama",
            "subagent_base_url": self.sub.url + "/v1", **values}))
        # Each key is handed to this launch, as the editor hands its stored keys: bound to the endpoint configured now.
        keys = {"DGC_API_KEY": MAIN_KEY, "DGC_SUBAGENT_API_KEY": SUB_KEY, "DGC_FALLBACK_API_KEY": FALLBACK_KEY,
                **(keys or {})}
        with patch.dict(os.environ, keys):
            config = Config(project_root=self.root)
        self.wire = io.StringIO()
        sessions_dir = patch.object(sessions, "SESSIONS_DIR", self.user / "sessions")
        sessions_dir.start()
        self.addCleanup(sessions_dir.stop)
        host = headless.Host(config)
        host.core.fp = self.wire
        self.addCleanup(lambda: [chat.agent.mcp.stop_all() for chat in list(host.chats.values())])
        return host

    def frames(self, kind=""):
        frames = [json.loads(line) for line in self.wire.getvalue().splitlines()]
        for frame in frames:
            self.assertIsNone(ep.event_error(frame), frame)
        return [f for f in frames if not kind or f["type"] == kind]

    def ask(self, host, request_id, role, base_url, api_mode="", api_key=None, timeout=15):
        cmd = {"type": "list_models_at", "request_id": request_id, "role": role, "base_url": base_url,
               **({"api_mode": api_mode} if api_mode is not None else {}),
               **({"api_key": api_key} if api_key is not None else {})}
        self.assertIsNone(ep.command_error(cmd), cmd)
        host.dispatch(cmd)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            for frame in self.frames("models_at"):
                if frame["request_id"] == request_id:
                    return frame
            time.sleep(0.02)
        self.fail(f"no models_at for {request_id}")

    def assertNoSavedKeyOnTheWire(self):
        raw = self.wire.getvalue()
        for key in SAVED:
            self.assertNotIn(key, raw, "a frame carried a saved key")

    # ------------------------------------------------------------------------------------------------
    def test_ready_offers_it(self):
        host = self.host()
        self.assertEqual(host.default._ready_payload()["capabilities"]["list_models_at"], 1)

    def test_the_bound_host_gets_its_own_key_and_lists(self):
        # The positive control: the recorder does see a key when one is allowed to go.
        host = self.host()
        main = self.ask(host, "m1", "main", self.main.url + "/v1", "ollama")
        self.assertEqual(main["ids"], ["glm-5.3:cloud", "qwen3:8b"], main)
        self.assertEqual(main["api_mode"], "ollama")
        self.assertEqual(self.main.keys_received(), {MAIN_KEY})
        sub = self.ask(host, "s1", "subagent", self.sub.url + "/v1", "chat_completions")
        self.assertEqual(sub["ids"], ["served-a", "served-b"], sub)
        self.assertEqual(self.sub.keys_received(), {SUB_KEY}, "the sub-agents' own key, never the main one")
        self.assertNoSavedKeyOnTheWire()

    def test_a_different_host_never_receives_a_saved_key(self):
        host = self.host()
        for request_id, role, url in (
                ("a", "main", self.other.url + "/v1"),                 # another host entirely
                ("b", "main", self.sub.url + "/v1"),                   # the sub-agents' host, for the main box
                ("c", "main", self.main.url + "/elsewhere/v1"),        # the bound host, another path
                ("d", "subagent", self.other.url + "/v1"),
                ("e", "subagent", self.main.url + "/elsewhere/v1"),
                ("f", "fallback", self.other.url + "/v1")):
            with self.subTest(role=role, url=url):
                frame = self.ask(host, request_id, role, url, "chat_completions")
                self.assertEqual(frame["ids"], ["served-a", "served-b"], frame)
        self.assertEqual(self.other.keys_received(), set(), "the other host was asked with no key")
        self.assertEqual(self.sub.keys_received(), set(), "the main box never sends the main key to the sub-agents' host")
        self.assertEqual(self.main.keys_received(), set(), "another path on the main host is another endpoint")
        self.assertTrue(self.other.seen and self.sub.seen and self.main.seen, "every host was really asked")
        self.assertNoSavedKeyOnTheWire()

    def test_a_route_with_no_key_of_its_own_sends_the_main_key_only_to_the_main_host(self):
        # As Agent._route_api_key: the fallback has no host of its own here, so it is the main host's route.
        host = self.host(fallback_base_url="")
        self.ask(host, "f1", "fallback", "", "ollama")          # blank: the main host, as the route inherits it
        self.assertEqual(self.main.keys_received(), {FALLBACK_KEY},
                         "a fallback key with no host of its own is bound to the main host")
        bare = self.host(keys={"DGC_SUBAGENT_API_KEY": ""}, subagent_base_url="")
        self.main.seen.clear()
        self.ask(bare, "s2", "subagent", self.main.url + "/v1", "ollama")
        self.assertEqual(self.main.keys_received(), {MAIN_KEY}, "no sub-agent key: the main key, to the main host")
        self.other.seen.clear()
        self.ask(bare, "s3", "subagent", self.other.url + "/v1", "ollama")
        self.assertEqual(self.other.keys_received(), set(), "and never to another host")

    def test_a_typed_key_goes_to_the_host_typed_beside_it_and_nowhere_else(self):
        host = self.host()
        frame = self.ask(host, "t1", "main", self.other.url + "/v1", "chat_completions", api_key="typed-key-xyz")
        self.assertEqual(frame["ids"], ["served-a", "served-b"])
        self.assertEqual(self.other.keys_received(), {"typed-key-xyz"})
        self.assertEqual(self.main.seen, [], "the saved host was not asked")
        self.assertNotIn("typed-key-xyz", self.wire.getvalue())

    def test_a_redirect_is_not_followed_so_a_key_stays_with_its_host(self):
        # The bound host redirects to another. requests drops Authorization on a cross-host redirect, but not
        # Anthropic's x-api-key: following it would hand the saved key to whatever the Location names.
        host = self.host(api_mode="anthropic")
        self.main.redirect_to = self.other.url
        for request_id, mode in (("r1", "anthropic"), ("r2", "chat_completions"), ("r3", "ollama")):
            frame = self.ask(host, request_id, "main", self.main.url + "/v1", mode)
            self.assertEqual(frame["ids"], [], frame)
            self.assertIn("redirect", frame["error"])
        self.assertEqual(self.other.seen, [], "the redirect's target was never asked")
        self.assertEqual(self.main.keys_received(), {MAIN_KEY})
        self.assertNoSavedKeyOnTheWire()

    def test_a_failure_says_why_in_a_few_words_and_never_what_the_host_said(self):
        host = self.host()
        self.other.status = 401
        frame = self.ask(host, "x1", "main", self.other.url + "/v1", "chat_completions")
        self.assertEqual(frame["error"], "it needs an API key (HTTP 401)")
        frame = self.ask(host, "x2", "main", self.other.url + "/v1", "chat_completions", api_key="typed-wrong")
        self.assertEqual(frame["error"], "it refused the API key (HTTP 401)")
        dead = StubHost()
        url = dead.url
        dead.close()
        frame = self.ask(host, "x3", "main", url + "/v1", "chat_completions")
        self.assertEqual(frame["error"], "nothing answered at that address")
        for bad in ("", "ftp://example.com", "127.0.0.1:11434"):
            frame = self.ask(host, "x4" + bad[:3], "main", bad, "auto")
            self.assertEqual(frame["error"], "enter a host URL that starts with http:// or https://")
        frame = self.ask(host, "x5", "main", f"http://user:{MAIN_KEY}@127.0.0.1:1/v1", "auto")
        self.assertEqual(frame["error"], "take the user name and password out of the host URL")
        for frame in self.frames("models_at"):
            self.assertNotIn("127.0.0.1", json.dumps(frame), "never the URL")
        self.assertNoSavedKeyOnTheWire()

    def test_a_newer_request_for_the_same_box_replaces_one_still_waiting(self):
        host = self.host()
        self.other.hold = threading.Event()
        cmd = lambda rid: {"type": "list_models_at", "request_id": rid, "role": "subagent",
                           "base_url": self.other.url + "/v1", "api_mode": "chat_completions"}
        for rid in ("q1", "q2", "q3"):
            host.dispatch(cmd(rid))
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and not any(f["request_id"] == "q2" for f in self.frames("models_at")):
            time.sleep(0.02)
        replaced = [f for f in self.frames("models_at") if f["request_id"] == "q2"]
        self.assertEqual(replaced[0]["error"], "a newer request replaced this one")
        self.other.hold.set()
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and len(self.frames("models_at")) < 3:
            time.sleep(0.02)
        answered = {f["request_id"]: f for f in self.frames("models_at")}
        self.assertEqual(answered["q1"]["ids"], ["served-a", "served-b"])
        self.assertEqual(answered["q3"]["ids"], ["served-a", "served-b"])
        self.assertEqual(len([p for p, _ in self.other.seen]), 2, "q2 never reached the host")

    def test_the_binding_helper(self):
        config = Config.__new__(Config)
        config.data = {"base_url": "http://a.example:11434/v1", "subagent_base_url": "", "api_key": MAIN_KEY,
                       "subagent_api_key": SUB_KEY, "fallback_base_url": "https://f.example/v1",
                       "fallback_api_key": FALLBACK_KEY}
        self.assertEqual(bound_provider_key(config, "api_key", "http://A.example:11434/v1/"), MAIN_KEY,
                         "the binding's own spelling rules: case and a trailing slash")
        self.assertEqual(bound_provider_key(config, "api_key", "http://a.example:11435/v1"), "")
        self.assertEqual(bound_provider_key(config, "api_key", "http://a.example:11434/v2"), "")
        self.assertEqual(bound_provider_key(config, "api_key", ""), "")
        self.assertEqual(bound_provider_key(config, "subagent_api_key", ""), SUB_KEY, "blank is the main host")
        self.assertEqual(bound_provider_key(config, "subagent_api_key", "http://a.example:11434/v1"), SUB_KEY)
        self.assertEqual(bound_provider_key(config, "subagent_api_key", "https://f.example/v1"), "")
        self.assertEqual(bound_provider_key(config, "fallback_api_key", "https://f.example/v1"), FALLBACK_KEY)
        self.assertEqual(bound_provider_key(config, "fallback_api_key", ""), "", "blank is the main host, not its own")
        self.assertEqual(bound_provider_key(config, "search_api_key", "https://f.example/v1"), "")


if __name__ == "__main__":
    unittest.main()
