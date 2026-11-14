"""A Pip's deep_research (0.52): the ONE engine (dgc.deep_research) runs in the Pip's worker with the Pip's own model;
the worker has no web, so each search and each page goes through the run's socket to the controller, which reads it
under careful mode and DGC's leak guard exactly as the Pip's web_search and web_fetch do."""
from __future__ import annotations

import json
import sys
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dgc import deep_research, pip_app_links, pip_research


class Taint:
    def __init__(self, carried=False):
        self.value = carried

    def carried(self, text, said=None):
        return ["x"] if self.value else []


def socket_with(taint=None, config=None):
    """A RunSocket with only what the research ops read (no server, no registry)."""
    run = pip_app_links.RunSocket.__new__(pip_app_links.RunSocket)
    run.taint, run.said, run.config = taint, [], config or {}
    return run


class ControllerOps(unittest.TestCase):
    def test_a_search_returns_its_results_as_data(self):
        found = [{"title": "Rates", "url": "https://bank.example/r", "snippet": "7.5%"}]
        with mock.patch("dgc.search.results", return_value=found) as results:
            said = socket_with(Taint())._research("research_search", {"query": "home loan rates"})
        self.assertEqual(said["data"], found)
        self.assertEqual(results.call_args.kwargs["n"], deep_research.RESULTS_PER_QUERY)

    def test_careful_mode_refuses_a_search_or_a_page_that_carries_what_it_read(self):
        run = socket_with(Taint(carried=True))
        with mock.patch("dgc.search.results") as results, mock.patch("dgc.deep_research.fetch_page") as fetch:
            searched = run._research("research_search", {"query": "Asha's invoice 4471"})
            read = run._research("research_page", {"url": "https://x.example/?q=4471"})
        results.assert_not_called()
        fetch.assert_not_called()
        self.assertTrue(str(searched).startswith("error"), searched)
        self.assertTrue(str(read).startswith("error"), read)

    def test_the_leak_guard_refuses_a_saved_secret(self):
        run = socket_with(Taint())
        with mock.patch("dgc.leak_guard.carries_secret", return_value=True), \
                mock.patch("dgc.search.results") as results, mock.patch("dgc.deep_research.fetch_page") as fetch:
            self.assertTrue(str(run._research("research_search", {"query": "q"})).startswith("error"))
            self.assertTrue(str(run._research("research_page", {"url": "https://a.example/"})).startswith("error"))
        results.assert_not_called()
        fetch.assert_not_called()

    def test_a_page_is_read_whole_with_the_shared_reader(self):
        with mock.patch("dgc.deep_research.fetch_page", return_value=("https://a.example/final", "words " * 9000)):
            said = socket_with(Taint())._research("research_page", {"url": "https://a.example/"})
        self.assertEqual(said["data"]["url"], "https://a.example/final")
        self.assertGreater(len(said["data"]["text"]), pip_app_links.MAX_TEXT, "whole, not cut to a tool reply's size")

    def test_the_socket_accepts_the_research_ops(self):
        self.assertTrue(set(pip_app_links.RESEARCH_OPS) == {"research_search", "research_page"})

    def test_worker_reply_passes_the_data_on(self):
        import socket as socketlib
        import tempfile
        import os
        path = os.path.join(tempfile.mkdtemp(prefix="dgc-rs-"), "s")
        server = socketlib.socket(socketlib.AF_UNIX)
        server.bind(path)
        server.listen(1)

        def answer():
            conn, _ = server.accept()
            with conn:
                conn.recv(65536)
                conn.sendall(json.dumps({"text": "ok", "data": {"url": "u", "text": "t" * 60000}}).encode() + b"\n")
        threading.Thread(target=answer, daemon=True).start()
        reply = pip_app_links.worker_reply({"socket": path, "token": "t"}, "research_page", {"url": "u"})
        server.close()
        self.assertEqual(len(reply["data"]["text"]), 60000)


class WorkerSide(unittest.TestCase):
    def test_the_schema_is_the_shared_one_with_what_a_pip_is_told(self):
        [schema] = pip_research.schemas()
        self.assertEqual(schema["function"]["name"], "deep_research")
        self.assertEqual(schema["function"]["parameters"], deep_research.TOOL_SCHEMA["function"]["parameters"])
        self.assertIn("As a Pip", schema["function"]["description"])

    def test_it_runs_the_shared_engine_with_the_pips_model_and_reads_through_the_controller(self):
        client = SimpleNamespace(base_url="http://m", api_key="k", model="pip-model", api_mode="ollama", context_size=32768,
                                 model_context_limit=lambda: 131072)
        made = []

        def new_client(base, key, model, api_mode=None, source="main"):
            made.append((base, model, api_mode, source))
            return SimpleNamespace(model=model, context_size=0)
        agent = SimpleNamespace(client=client, _new_client=new_client, cancelled=threading.Event(), config={})
        calls = []

        def reply(pin, op, args, timeout=120):
            calls.append((op, args))
            if op == "research_search":
                return {"text": "ok", "data": [{"title": "T", "url": "https://a.example/", "snippet": "s"}]}
            return {"text": "ok", "data": {"url": "https://a.example/", "text": "page"}}
        seen = {}

        def fake(question, **kwargs):
            seen.update(kwargs, question=question)
            seen["found"] = kwargs["search"]("rates")
            seen["page"] = kwargs["fetch"]("https://a.example/")
            seen["client"] = kwargs["client_for"]()
            return {"report": "Report [1].", "sources": [{"n": 1, "title": "T", "url": "https://a.example/"}], "how": ""}
        with mock.patch("dgc.pip_app_links.worker_reply", side_effect=reply), \
                mock.patch("dgc.deep_research.run_report", side_effect=fake):
            out = pip_research.run(agent, {"socket": "s", "token": "t"}, {"question": "Home loan rates", "depth": "quick"})
        self.assertEqual(seen["question"], "Home loan rates")
        self.assertEqual(seen["found"], [{"title": "T", "url": "https://a.example/", "snippet": "s"}])
        self.assertEqual(seen["page"], ("https://a.example/", "page"))
        self.assertEqual(made, [("http://m", "pip-model", "ollama", "research")], "the Pip's own model")
        self.assertEqual(seen["client"].context_size, 32768, "in the Pip's window")
        self.assertIs(seen["cancel"], agent.cancelled)
        self.assertEqual([op for op, _ in calls], ["research_search", "research_page"])
        self.assertIn("Report [1].", out)

    def test_a_refused_read_is_an_error_the_engine_logs_not_a_crash(self):
        agent = SimpleNamespace(client=SimpleNamespace(base_url="", api_key="", model="m", context_size=32768),
                                _new_client=lambda *a, **k: SimpleNamespace(context_size=0),
                                cancelled=threading.Event(), config={})
        seen = {}

        def fake(question, **kwargs):
            for name, call in (("search", lambda: kwargs["search"]("q")), ("fetch", lambda: kwargs["fetch"]("https://a/"))):
                try:
                    call()
                except Exception as exc:          # noqa: BLE001
                    seen[name] = str(exc)
            return {"report": "r", "sources": [], "how": ""}
        with mock.patch("dgc.pip_app_links.worker_reply", return_value={"text": "error: not searched: careful mode"}), \
                mock.patch("dgc.deep_research.run_report", side_effect=fake):
            pip_research.run(agent, {"socket": "s", "token": "t"}, {"question": "q"})
        self.assertIn("careful mode", seen["search"])
        self.assertIn("careful mode", seen["fetch"])

    def test_a_failure_is_said_as_an_error(self):
        agent = SimpleNamespace(client=SimpleNamespace(base_url="", api_key="", model="m", context_size=32768),
                                _new_client=lambda *a, **k: SimpleNamespace(context_size=0),
                                cancelled=threading.Event(), config={})
        with mock.patch("dgc.deep_research.run_report", side_effect=deep_research.ResearchError("No page gave anything")):
            out = pip_research.run(agent, {"socket": "s", "token": "t"}, {"question": "q"})
        self.assertTrue(out.startswith("error:"), out)


class Offered(unittest.TestCase):
    def test_a_pip_run_with_its_tools_offers_deep_research(self):
        source = (Path(__file__).resolve().parent.parent / "dgc" / "pips.py").read_text(encoding="utf-8")
        self.assertIn("pip_research.schemas()", source)
        self.assertIn("pip_research.TOOLS", source)


if __name__ == "__main__":
    unittest.main()
