"""Work: a picture for a model that can't see (dgc/seeing.py through dgc/vision.py and the agent).

The session's model can't see; another model on one of the user's connections can. Auto mode just uses it and says
so in one line; the other modes ask once with three choices (Work's own question card), and the answer is the
session's from then on. One fake Ollama-shaped host answers every connection by URL prefix.
"""
import base64
import copy
import http.server
import json
import os
import sys
import tempfile
import threading
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
        raise RuntimeError("tests/test_seeing_work.py needs HOME redirected before dgc is imported")
else:
    _ISOLATED_HOME = tempfile.TemporaryDirectory(prefix="dgc-seeing-work-home-")
    os.environ["HOME"] = os.path.realpath(_ISOLATED_HOME.name)
    os.environ["USERPROFILE"] = os.environ["HOME"]
    os.environ.pop("XDG_CONFIG_HOME", None)
    os.environ.pop("XDG_DATA_HOME", None)

from dgc import seeing, sessions  # noqa: E402
from dgc.agent import Agent  # noqa: E402
from dgc.config import Config, DEFAULTS  # noqa: E402

PNG = (b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\rIHDR" + (40).to_bytes(4, "big") + (30).to_bytes(4, "big")
       + b"\x08\x06\x00\x00\x00" + b"\x00" * 16)
PNG_URI = "data:image/png;base64," + base64.b64encode(PNG).decode("ascii")
REPORT = "VISION REPORT: the button reads 'Place order' and is cut off on the right."
SEES = ["completion", "vision", "tools"]
TEXT = ["completion", "tools"]


class Hosts:
    """Ollama-shaped hosts by URL prefix: {prefix: {model: capabilities}}; every request's key is recorded."""

    def __init__(self):
        self.catalogs: dict = {}
        self.requests: list = []            # (prefix, path, model, authorization)
        self.chats: list = []               # (prefix, body)
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _json(self, status, payload, kind="application/json"):
                raw = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", kind)
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def _prefix(self):
                return self.path.strip("/").split("/", 1)[0]

            def do_GET(self):
                prefix = self._prefix()
                owner.requests.append((prefix, self.path, "", self.headers.get("Authorization") or ""))
                catalog = owner.catalogs.get(prefix)
                if self.path.endswith("/api/tags") and catalog is not None:
                    return self._json(200, {"models": [{"name": m, "model": m, "details": {"family": "fixture"}}
                                                       for m in catalog]})
                self._json(404, {"error": "no route"})

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                prefix = self._prefix()
                model = str(body.get("model") or body.get("name") or "")
                owner.requests.append((prefix, self.path, model, self.headers.get("Authorization") or ""))
                catalog = owner.catalogs.get(prefix) or {}
                if self.path.endswith("/api/show"):
                    if model in catalog:
                        return self._json(200, {"capabilities": catalog[model], "details": {"family": "fixture"}})
                    return self._json(404, {"error": f"model '{model}' not found"})
                if self.path.endswith("/api/chat"):
                    owner.chats.append((prefix, body))
                    content = (f"{REPORT} ({model})" if "vision" in catalog.get(model, [])
                               else "done")
                    event = {"message": {"role": "assistant", "content": content}, "done": True,
                             "done_reason": "stop", "prompt_eval_count": 12, "eval_count": 6}
                    return self._json(200, (json.dumps(event) + "\n").encode(), "application/x-ndjson")
                self._json(404, {"error": "no route"})

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def url(self, prefix):
        return f"http://127.0.0.1:{self.server.server_address[1]}/{prefix}"

    def chats_by(self, model):
        return [body for _, body in self.chats if body.get("model") == model]

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class UI:
    """The parts of the editor's UI a turn uses here: a scripted question card, the saved connections."""
    non_interactive = False

    def __init__(self, answer=None, connections=None, routes=None):
        self.calls: list = []
        self.answer = answer                      # index of the option chosen, or "dismissed"
        self.asked: list = []
        self.helper_connections = list(connections or [])
        self.routes = dict(routes or {})
        self.routes_asked: list = []

    def ask_questions(self, questions, call_id=None):
        self.asked.append(questions)
        if self.answer is None or self.answer == "dismissed":
            return {"outcome": "dismissed", "answers": {}}
        return {"outcome": "answered", "answers": {questions[0]["id"]: {"selected": [self.answer], "other": ""}}}

    def connection_route(self, connection_id):
        self.routes_asked.append(connection_id)
        return self.routes.get(connection_id) or {"error": "not one of your saved connections"}

    def tool_images(self, call_id, images, caption="", *, items=None, omitted=0, meta=None):
        self.calls.append(("tool_images", (call_id, len(images), caption), {}))

    def __getattr__(self, name):
        if name.startswith("_") or name == "console":
            raise AttributeError(name)

        def record(*args, **kwargs):
            self.calls.append((name, args, kwargs))
            return "once" if name == "approve" else None
        return record

    def named(self, name):
        return [call for call in self.calls if call[0] == name]

    def infos(self):
        return [call[1][0] for call in self.named("info")]


PROVIDER = "provider_" + "b" * 32


class SeeingWorkTests(unittest.TestCase):
    _n = 0

    @classmethod
    def setUpClass(cls):
        cls.hosts = Hosts()

    @classmethod
    def tearDownClass(cls):
        cls.hosts.close()

    def setUp(self):
        seeing.forget()
        directory = tempfile.TemporaryDirectory(prefix="dgc-seeing-work-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        scoped = patch.object(sessions, "SESSIONS_DIR", self.root / "sessions")
        scoped.start()
        self.addCleanup(scoped.stop)
        self.hosts.requests.clear()
        self.hosts.chats.clear()

    def prefix(self, catalog):
        SeeingWorkTests._n += 1
        name = f"w{SeeingWorkTests._n}"
        self.hosts.catalogs[name] = catalog
        return name

    def agent(self, prefix, model="txt-main", *, mode="default", ui=None, **data):
        cfg = object.__new__(Config)
        cfg.project_root, cfg.project_dir, cfg._persist = self.root, self.root / ".dgc", False
        cfg.data = copy.deepcopy(DEFAULTS)
        cfg.data.update(base_url=self.hosts.url(prefix), model=model, mode=mode, api_mode="ollama", hooks={},
                        mcp_servers={}, suggest=False, artifact_autostart=False, max_turns=6, thinking="off",
                        notes=False, api_key="key-main")
        cfg.data.update(data)
        cfg._stored_secrets, cfg._env_secret_keys, cfg._explicit_keys = {}, set(), set()
        cfg.credential_warnings = ()
        cfg.permissions = {"allow": [], "ask": [], "deny": []}
        self.ui = ui or UI()
        agent = Agent(cfg, self.ui)
        agent.session_file = sessions.new_path(self.root)
        self.addCleanup(agent.mcp.stop_all)
        return agent

    def turn(self, agent, text="What is wrong with this order button?"):
        agent._pending_images = [PNG_URI]
        self.assertTrue(agent.run_turn(text))

    def assert_main_read_the_report(self, model="txt-main"):
        main = self.hosts.chats_by(model)
        self.assertTrue(main)
        self.assertFalse(any(m.get("images") for m in main[-1]["messages"]), "the text-only model gets no pixels")
        self.assertIn("Place order", json.dumps(main[-1]["messages"]))

    def test_auto_mode_uses_a_model_that_sees_on_the_same_connection_and_says_so_in_one_line(self):
        agent = self.agent(self.prefix({"txt-main": TEXT, "vis-here": SEES}), mode="auto")
        self.turn(agent)
        self.assertEqual(self.ui.asked, [], "auto mode asks nothing")
        self.assertIn("vis-here looked at the picture.", self.ui.infos())
        looked = self.hosts.chats_by("vis-here")
        self.assertEqual(len(looked), 1)
        self.assertTrue(any(m.get("images") for m in looked[0]["messages"]), "the model that sees got the picture")
        self.assert_main_read_the_report()
        # The view_image card names the model that looked, as every look does.
        name, args, _ = self.ui.named("tool_call")[0][1]
        self.assertEqual(name, "view_image")
        self.assertIn("vis-here", args["via"])

    def test_the_card_asks_once_and_use_it_to_see_is_the_sessions_from_then_on(self):
        here = self.prefix({"txt-main": TEXT, "vis-here": SEES})
        agent = self.agent(here, ui=UI(answer=0))
        self.turn(agent)
        self.assertEqual(len(self.ui.asked), 1)
        card = self.ui.asked[0][0]
        self.assertEqual([o["label"] for o in card["options"]],
                         ["Use vis-here to see, keep txt-main for the rest", "Switch to vis-here", "Not now"])
        self.assertTrue(card["options"][0]["recommended"])
        self.assertEqual(len(self.hosts.chats_by("vis-here")), 1)
        self.assert_main_read_the_report()
        saved = json.loads(agent.session_file.read_text())
        kept = saved["seeing"]
        self.assertEqual((kept["choice"], kept["model"], kept["connection"]["kind"]), ("relay", "vis-here", "main"))
        # The card is kept with the prompt, so a reopened session shows it as it was answered.
        from dgc.headless import _history_seeing_items
        prompt = next(m for m in saved["messages"] if m.get("_dgc_seeing_asked"))
        replay = _history_seeing_items(prompt["_dgc_seeing_asked"])
        self.assertEqual([item["type"] for item in replay], ["tool_call", "options_resolved", "tool_result"])
        self.assertEqual(replay[0]["name"], "propose_options")
        self.assertEqual(replay[1]["outcome"], "answered")
        self.assertIn("Use vis-here to see", replay[2]["output"])
        # Next picture: no card, the same model looks.
        self.turn(agent, "And this one?")
        self.assertEqual(len(self.ui.asked), 1, "asked once per session")
        self.assertEqual(len(self.hosts.chats_by("vis-here")), 2)
        # A resumed session keeps the answer.
        again = self.agent(here, ui=UI(answer=2))
        again.load_session(agent.session_file)
        self.assertEqual(again._seeing["choice"], "relay")
        self.turn(again, "A third?")
        self.assertEqual(self.ui.asked, [], "the resumed session already chose")
        self.assertEqual(len(self.hosts.chats_by("vis-here")), 3)

    def test_not_now_is_kept_for_the_session_and_said_in_one_line(self):
        agent = self.agent(self.prefix({"txt-main": TEXT, "vis-here": SEES}), ui=UI(answer=2))
        self.turn(agent)
        self.assertEqual(self.hosts.chats_by("vis-here"), [], "nobody looked")
        self.assertTrue(any("No model looked at the picture" in line for line in self.ui.infos()), self.ui.infos())
        self.assertEqual(json.loads(agent.session_file.read_text())["seeing"]["choice"], "off")
        self.turn(agent, "This one?")
        self.assertEqual(len(self.ui.asked), 1, "not asked again in this session")
        self.assertEqual(self.hosts.chats_by("vis-here"), [])

    def test_closing_the_card_lets_nothing_look_and_asks_again_next_time(self):
        agent = self.agent(self.prefix({"txt-main": TEXT, "vis-here": SEES}), ui=UI(answer="dismissed"))
        self.turn(agent)
        self.assertEqual(self.hosts.chats_by("vis-here"), [])
        self.assertNotIn("seeing", json.loads(agent.session_file.read_text()))
        self.turn(agent, "This one?")
        self.assertEqual(len(self.ui.asked), 2)

    def test_switch_moves_the_session_to_the_model_that_sees_and_it_gets_the_picture(self):
        agent = self.agent(self.prefix({"txt-main": TEXT, "vis-here": SEES}), ui=UI(answer=1))
        self.turn(agent)
        self.assertEqual(agent.config.model, "vis-here")
        replies = self.hosts.chats_by("vis-here")
        self.assertEqual(len(replies), 1, "one request: the session's own, now on the model that sees")
        self.assertTrue(any(m.get("images") for m in replies[0]["messages"]), "it sees the picture itself")
        self.assertEqual(self.hosts.chats_by("txt-main"), [])

    def test_a_model_on_a_saved_provider_is_found_and_its_key_goes_only_to_it(self):
        cloud = self.prefix({"vis-cloud": SEES})
        ui = UI(answer=0, connections=[{"id": PROVIDER, "name": "Ollama Cloud", "host": "cloud.invalid", "kind": "api"},
                                       {"id": "provider_" + "c" * 32, "name": "Claude Code", "host": "", "kind": "cli"}],
                routes={PROVIDER: {"base_url": self.hosts.url(cloud), "api_mode": "ollama", "api_key": "key-cloud",
                                   "model": ""}})
        main = self.prefix({"txt-main": TEXT})
        agent = self.agent(main, ui=ui)
        self.turn(agent)
        card = ui.asked[0][0]
        self.assertIn("on Ollama Cloud", card["question"])
        self.assertEqual(ui.routes_asked, [PROVIDER], "only the saved provider is asked for its route, never the CLI")
        self.assertEqual(len(self.hosts.chats_by("vis-cloud")), 1)
        self.assert_main_read_the_report()
        for prefix, path, model, auth in self.hosts.requests:
            if "key-cloud" in auth:
                self.assertEqual(prefix, cloud, (path, model))
            if prefix == cloud:
                self.assertNotIn("key-main", auth)
        kept = json.loads(agent.session_file.read_text())["seeing"]
        self.assertEqual(kept["connection"], {"kind": "provider", "id": PROVIDER, "name": "Ollama Cloud"})
        self.assertNotIn("key-cloud", agent.session_file.read_text(), "a key is never session data")

    def test_settings_choice_is_used_without_a_card_and_a_newer_session_answer_wins(self):
        here = self.prefix({"txt-main": TEXT, "vis-here": SEES})
        settings = {"choice": "relay", "model": "vis-here", "connection": {"kind": "main", "name": "this computer"},
                    "at": 100.0}
        agent = self.agent(here, ui=UI(answer=2), seeing=settings)
        self.turn(agent)
        self.assertEqual(self.ui.asked, [], "Settings already chose")
        self.assertEqual(len(self.hosts.chats_by("vis-here")), 1)
        # The session says otherwise later (a card it answered, or a remembered Not now): the newer word wins.
        agent._seeing = {"choice": "off", "at": 200.0}
        self.turn(agent, "Again?")
        self.assertEqual(len(self.hosts.chats_by("vis-here")), 1)
        agent.config.data["seeing"] = {**settings, "at": 300.0}
        self.turn(agent, "And now?")
        self.assertEqual(len(self.hosts.chats_by("vis-here")), 2)

    def test_nothing_that_sees_anywhere_says_so_and_asks_nothing(self):
        agent = self.agent(self.prefix({"txt-main": TEXT, "txt-other": TEXT}), ui=UI(answer=0))
        self.turn(agent)
        self.assertEqual(self.ui.asked, [])
        self.assertTrue(any("txt-main can't read images, and none of your connections has a model that can" in line
                            for line in self.ui.infos()), self.ui.infos())

    def test_a_configured_sub_agents_model_that_sees_looks_without_a_card_as_before(self):
        agent = self.agent(self.prefix({"txt-main": TEXT, "vis-sub": SEES, "vis-here": SEES}), ui=UI(answer=2),
                           subagent_model="vis-sub")
        self.turn(agent)
        self.assertEqual(self.ui.asked, [])
        self.assertEqual(len(self.hosts.chats_by("vis-sub")), 1)
        self.assertEqual(self.hosts.chats_by("vis-here"), [])

    def test_view_image_in_the_turn_uses_the_sessions_chosen_model(self):
        (self.root / "shot.png").write_bytes(PNG)
        agent = self.agent(self.prefix({"txt-main": TEXT, "vis-here": SEES}), ui=UI(answer=0))
        agent._seeing = {"choice": "relay", "model": "vis-here", "connection": {"kind": "main", "name": "here"},
                         "at": 1.0}
        route = agent._vision_route(probe=True)
        self.assertIsNotNone(route)
        self.assertEqual(route.model, "vis-here")
        self.assertIn("view_image", [t["function"]["name"] for t in agent._tool_schemas()])
        label, ok, answer = agent._vision_look([(PNG_URI, "shot.png")], "What does the button say?")
        self.assertTrue(ok, answer)
        self.assertIn("Place order", answer)


if __name__ == "__main__":
    unittest.main()
