"""A model that can see, for every chat (dgc/seeing.py): one search over every connection the user added.

One fake Ollama-shaped host on 127.0.0.1 answers several "connections" by URL prefix: /api/tags lists that prefix's
models and /api/show answers their capabilities. Each test uses fresh prefixes, so the process-wide metadata caches
never carry over between tests.
"""
import http.server
import json
import re
import threading
import unittest
from pathlib import Path

from dgc import seeing

ROOT = Path(__file__).resolve().parents[1]


class FakeHosts:
    """Model catalogs by URL prefix: {prefix: {model: [capabilities]}}; a prefix not listed answers 404."""

    def __init__(self):
        self.catalogs: dict[str, dict[str, list]] = {}
        self.shows: list[tuple[str, str]] = []
        self.tags: list[str] = []
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _json(self, status, payload):
                raw = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def _catalog(self):
                prefix = self.path.strip("/").split("/", 1)[0]
                return prefix, owner.catalogs.get(prefix)

            def do_GET(self):
                prefix, catalog = self._catalog()
                if self.path.endswith("/api/tags") and catalog is not None:
                    owner.tags.append(prefix)
                    return self._json(200, {"models": [{"name": name, "model": name, "size": 1000 + i,
                                                        "details": {"family": "fixture"}}
                                                       for i, name in enumerate(catalog)]})
                if self.path.endswith("/api/ps"):
                    return self._json(200, {"models": []})
                self._json(404, {"error": "no route"})

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                prefix, catalog = self._catalog()
                model = str(body.get("model") or body.get("name") or "")
                if self.path.endswith("/api/show") and catalog is not None and model in catalog:
                    owner.shows.append((prefix, model))
                    return self._json(200, {"capabilities": catalog[model], "details": {"family": "fixture"}})
                self._json(404, {"error": f"model '{model}' not found"})

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def url(self, prefix: str) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}/{prefix}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()


SEES = ["completion", "vision", "tools"]
SEES_NO_TOOLS = ["completion", "vision"]
TEXT = ["completion", "tools"]


class SeeingTests(unittest.TestCase):
    _n = 0

    @classmethod
    def setUpClass(cls):
        cls.hosts = FakeHosts()

    @classmethod
    def tearDownClass(cls):
        cls.hosts.close()

    def setUp(self):
        seeing.forget()
        self.hosts.shows.clear()
        self.hosts.tags.clear()

    def prefix(self, catalog: dict) -> str:
        SeeingTests._n += 1
        name = f"h{SeeingTests._n}"
        self.hosts.catalogs[name] = catalog
        return name

    def conn(self, key, kind, prefix, *, name=None, model="", only=False, **extra):
        return seeing.Connection(key=key, kind=kind, name=name or key, base_url=self.hosts.url(prefix),
                                 api_mode="ollama", model=model, only=only, **extra)

    # --- which models see -----------------------------------------------------------------------

    def test_names_that_say_they_see_match_the_model_pickers_takes_images_mark(self):
        # The picker's family table (media/shared/modelpicker.js) is the one list of names; seeing.py reads the same
        # families. Every "images" family there must be one here, with the same answer for the same names.
        source = (ROOT / "editors/vscode/media/shared/modelpicker.js").read_text(encoding="utf-8")
        table = source[source.index("const FAMILY_FACTS = ["):source.index("];", source.index("const FAMILY_FACTS = ["))]
        rows = re.findall(r"\[/(.+?)/i, \[([^\]]*)\]\]", table)
        self.assertGreater(len(rows), 8)
        js = [re.compile(pattern, re.I) for pattern, caps in rows if '"images"' in caps]

        def picker_says(name):
            short = name.split("/")[-1]
            return any(rx.search(short) for rx in js)
        names = ["qwen3-vl:8b", "qwen2.5vl:7b", "qwen3-vl:235b-cloud", "gemma3:27b", "gemma3n:e4b", "llava:13b",
                 "llama3.2-vision:11b", "minicpm-v:8b", "moondream:latest", "pixtral-large", "claude-sonnet-5-5",
                 "gpt-5.1", "gpt-4o-mini", "gemini-3-pro", "deepseek-v4.1-flash:cloud", "glm-5.3:cloud",
                 "gpt-oss:120b", "qwen3.8:27b", "kimi-k3.1-pro:cloud", "openai/gpt-4o", "qvq-72b", "mistral-small3.2"]
        for name in names:
            with self.subTest(name=name):
                self.assertEqual(seeing.named_sees(name), picker_says(name))

    def test_ollama_says_which_models_see_and_its_word_wins_over_the_name(self):
        prefix = self.prefix({"qwen3-vl:8b": TEXT, "plain:7b": SEES})
        conn = self.conn("main", "main", prefix)
        self.assertFalse(seeing.sees(conn, "qwen3-vl:8b"), "Ollama said no vision: the name doesn't override it")
        self.assertTrue(seeing.sees(conn, "plain:7b"))
        self.assertIsNone(seeing.sees(conn, "missing:1b"), "a model the host doesn't know is unknown, never yes")
        # Asked once: the answer is kept.
        self.assertTrue(seeing.sees(conn, "plain:7b"))
        self.assertEqual(self.hosts.shows.count((prefix, "plain:7b")), 1)

    def test_a_host_that_lists_no_capabilities_is_read_by_the_models_name(self):
        conn = seeing.Connection(key="provider:p", kind="provider", name="OpenRouter", base_url="https://example.invalid/v1",
                                 api_mode="chat_completions")
        self.assertTrue(seeing.sees(conn, "openai/gpt-4o"))
        self.assertIsNone(seeing.sees(conn, "deepseek/deepseek-v4"), "a name that doesn't say is unknown")
        # The user's own word about the host wins.
        told = seeing.Connection(key="main", kind="main", name="x", base_url="https://example.invalid/v1",
                                 api_mode="chat_completions", provider_capabilities={"vision": False})
        self.assertFalse(seeing.sees(told, "openai/gpt-4o"))

    # --- the search ------------------------------------------------------------------------------

    def test_the_same_connection_comes_first_then_the_sub_agents_model_then_saved_providers(self):
        same = self.prefix({"txt-chat": TEXT, "vis-here": SEES, "nomic-embed-text": ["embedding"]})
        other = self.prefix({"vis-there": SEES})
        sub = self.prefix({"vis-sub": SEES})
        connections = [self.conn("provider:p1", "provider", other, name="My cloud"),
                       self.conn("subagent", "subagent", sub, model="vis-sub", only=True),
                       self.conn("main", "main", same, name="This computer")]
        order = [(c.key, m) for c, m in seeing.candidates(connections, "main", "txt-chat")]
        self.assertEqual(order, [("main", "vis-here"), ("subagent", "vis-sub"), ("provider:p1", "vis-there")],
                         "the chat's own model and an embedding model are never candidates")
        found = seeing.find(connections, "main", "txt-chat")
        self.assertEqual((found.model, found.connection.key), ("vis-here", "main"))
        self.assertEqual(found.record(), {"model": "vis-here", "connection": {"kind": "main", "name": "This computer"}})
        # Without one on the same connection: the Sub-agents model.
        self.hosts.catalogs[same] = {"txt-chat": TEXT}
        seeing.forget()
        found = seeing.find(connections, "main", "txt-chat")
        self.assertEqual((found.model, found.connection.key), ("vis-sub", "subagent"))

    def test_a_chat_on_a_saved_provider_searches_that_provider_first(self):
        main = self.prefix({"vis-main": SEES})
        cloud = self.prefix({"txt-cloud": TEXT, "vis-cloud": SEES})
        connections = [self.conn("main", "main", main), self.conn("provider:p1", "provider", cloud)]
        found = seeing.find(connections, "provider:p1", "txt-cloud")
        self.assertEqual((found.model, found.connection.key), ("vis-cloud", "provider:p1"))

    def test_a_model_that_sees_and_uses_tools_wins_over_one_that_only_sees(self):
        prefix = self.prefix({"txt-chat": TEXT, "a-vis-only": SEES_NO_TOOLS, "b-vis": SEES})
        connections = [self.conn("main", "main", prefix)]
        found = seeing.find(connections, "main", "txt-chat")
        self.assertEqual(found.model, "b-vis")
        self.assertTrue(found.tools)
        self.hosts.catalogs[prefix] = {"txt-chat": TEXT, "a-vis-only": SEES_NO_TOOLS}
        seeing.forget()
        found = seeing.find(connections, "main", "txt-chat")
        self.assertEqual(found.model, "a-vis-only", "one that only sees still looks")
        self.assertFalse(found.tools)

    def test_nothing_that_sees_is_none_and_the_search_is_bounded(self):
        prefix = self.prefix({f"txt-{i:02}": TEXT for i in range(60)})
        connections = [self.conn("main", "main", prefix)]
        self.assertIsNone(seeing.find(connections, "main", "txt-00"))
        self.assertLessEqual(len(self.hosts.shows), seeing.MAX_PROBES)
        # The answer is kept a while: asking again asks no host.
        before = (len(self.hosts.shows), len(self.hosts.tags))
        self.assertIsNone(seeing.find(connections, "main", "txt-00"))
        self.assertEqual((len(self.hosts.shows), len(self.hosts.tags)), before)

    def test_a_connection_that_cannot_be_reached_or_runs_its_own_tools_is_skipped(self):
        prefix = self.prefix({"vis-ok": SEES})
        broken = seeing.Connection(key="provider:gone", kind="provider", name="Gone",
                                   resolve=lambda: (_ for _ in ()).throw(RuntimeError("the editor didn't answer")))
        cli = seeing.Connection(key="provider:cli", kind="cli", name="Claude Code")
        connections = [broken, cli, self.conn("provider:p2", "provider", prefix)]
        found = seeing.find(connections, "main", "txt-chat")
        self.assertEqual((found.model, found.connection.key), ("vis-ok", "provider:p2"))

    def test_a_saved_providers_route_is_asked_for_only_when_it_is_searched(self):
        prefix = self.prefix({"vis-p": SEES})
        asked = []

        def resolve():
            asked.append(1)
            return {"base_url": self.hosts.url(prefix), "api_mode": "ollama", "api_key": "k-123", "model": ""}
        lazy = seeing.Connection(key="provider:p3", kind="provider", name="Lazy", resolve=resolve)
        here = self.prefix({"vis-main": SEES})
        found = seeing.find([self.conn("main", "main", here), lazy], "main", "txt-chat")
        self.assertEqual(found.model, "vis-main")
        self.assertEqual(asked, [], "a model on the chat's own connection was found first: no other key was asked for")
        found = seeing.find([lazy], "main", "txt-chat")
        self.assertEqual((found.model, asked), ("vis-p", [1]))
        self.assertNotIn("k-123", repr(found), "a key never shows in a record or its repr")
        self.assertNotIn("k-123", json.dumps(found.record()))

    def test_every_model_that_sees_for_the_settings_list(self):
        same = self.prefix({"txt-chat": TEXT, "vis-a": SEES, "vis-b": SEES_NO_TOOLS})
        cloud = self.prefix({"vis-c": SEES})
        found = seeing.every([self.conn("main", "main", same, name="This computer"),
                              self.conn("provider:p9", "provider", cloud, name="Cloud")], "main", "txt-chat")
        self.assertEqual([(f.model, f.connection.name) for f in found],
                         [("vis-a", "This computer"), ("vis-b", "This computer"), ("vis-c", "Cloud")])

    # --- the choice ------------------------------------------------------------------------------

    def test_a_choice_is_kept_clean_and_the_newest_word_wins(self):
        self.assertEqual(seeing.clean_choice(None), None)
        self.assertEqual(seeing.clean_choice({"choice": "relay"}), None, "Use a model needs the model")
        relay = seeing.clean_choice({"choice": "relay", "model": "vis-a", "at": 10,
                                     "connection": {"kind": "provider", "id": "provider_" + "a" * 32, "name": "Cloud",
                                                    "api_key": "never"}})
        self.assertEqual(relay, {"choice": "relay", "model": "vis-a", "at": 10.0,
                                 "connection": {"kind": "provider", "id": "provider_" + "a" * 32, "name": "Cloud"}})
        off = seeing.clean_choice({"choice": "off", "at": 20})
        self.assertEqual(seeing.effective(relay, off)["choice"], "off")
        self.assertEqual(seeing.effective(off, relay)["choice"], "off", "the order given never matters, the time does")
        self.assertEqual(seeing.effective(None, None), {"choice": "ask"})
        # An ISO time (a Pip's saved choice) compares with a number.
        older = seeing.clean_choice({"choice": "off", "at": "1970-01-01T00:00:05Z"})
        self.assertEqual(seeing.effective(older, relay)["choice"], "relay")

    def test_the_card_offers_three_choices_and_reads_its_answer(self):
        found = seeing.Found(model="qwen3-vl:8b", connection=seeing.Connection(key="main", kind="main", name="Ollama"),
                             tools=True)
        card = seeing.question("deepseek-v4.1-flash:cloud", found)
        options = [o["label"] for o in card["options"]]
        self.assertEqual(options, ["Use qwen3-vl:8b to see, keep deepseek-v4.1-flash:cloud for the rest",
                                   "Switch to qwen3-vl:8b", "Not now"])
        self.assertTrue(card["options"][0]["recommended"])
        self.assertIn("deepseek-v4.1-flash:cloud can't see images", card["question"])
        self.assertTrue(all(len(o) <= 80 for o in options))
        from dgc import questions
        normal = questions.normalize_questions({"questions": [card]})
        for index, want in enumerate(("relay", "switch", "off")):
            self.assertEqual(seeing.answer_of(normal, {"outcome": "answered",
                                                       "answers": {normal[0]["id"]: {"selected": [index]}}}), want)
        self.assertIsNone(seeing.answer_of(normal, {"outcome": "dismissed", "answers": {}}))
        # A model that sees but can't use tools can look, not take over the chat.
        only = seeing.Found(model="moondream", connection=found.connection, tools=False)
        self.assertEqual([o["label"] for o in seeing.question("glm-5.3:cloud", only)["options"]],
                         ["Use moondream to see, keep glm-5.3:cloud for the rest", "Not now"])
        self.assertEqual(seeing.looked_line("qwen3-vl:8b", count=1), "qwen3-vl:8b looked at the picture.")
        self.assertEqual(seeing.looked_line("qwen3-vl:8b", count=2), "qwen3-vl:8b looked at the 2 pictures.")

    def test_a_remembered_choice_finds_its_connection_again(self):
        prefix = self.prefix({"vis-a": SEES})
        connections = [self.conn("main", "main", prefix, name="Here"),
                       self.conn("provider:provider_" + "b" * 32, "provider", prefix, name="Cloud")]
        record = {"choice": "relay", "model": "vis-a", "connection": {"kind": "provider", "id": "provider_" + "b" * 32,
                                                                      "name": "Cloud"}}
        conn = seeing.connection_of(record, connections)
        self.assertEqual(conn.key, "provider:provider_" + "b" * 32)
        self.assertIsNone(seeing.connection_of({**record, "connection": {"kind": "provider", "id": "provider_" + "c" * 32,
                                                                         "name": "Removed"}}, connections),
                          "a provider the user removed is never used again")
        self.assertEqual(seeing.connection_of({**record, "connection": {"kind": "main", "name": "Here"}}, connections).key,
                         "main")


if __name__ == "__main__":
    unittest.main()
