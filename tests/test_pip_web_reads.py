"""Reviewed web reads for Personal Pips: exact pages and searches, read by DGC, never by the model."""
import json
import unittest
from unittest.mock import patch

from dgc import pips, pip_setup, pip_web_reads as web
from dgc.workspace_registry import RegistryError
from tests import test_pips_local as fixtures

PLAN = {"schema_version": 1, "reads": [{"kind": "page", "url": "https://status.example.com/today"},
                                        {"kind": "search", "query": "weather in Pune today"}]}


class ValidationTests(unittest.TestCase):
    def test_exact_pages_and_searches_are_the_canonical_plan(self):
        self.assertEqual(web.validate(PLAN), PLAN)
        self.assertIsNone(web.validate(None))
        # A host made of hex letters is a site, not an address.
        self.assertTrue(web.validate({"schema_version": 1, "reads": [{"kind": "page", "url": "https://face.be/"}]}))

    def test_everything_but_public_https_pages_and_plain_searches_is_refused(self):
        pages = ["http://example.com/", "https://127.0.0.1/", "https://10.0.0.8/x", "https://[::1]/",
                 "https://localhost/", "https://app.localhost/", "https://user:secret@example.com/",
                 "https://example.com/a b", " https://example.com/", "ftp://example.com/", "https://", "x" * 3000]
        for url in pages:
            with self.subTest(url=url), self.assertRaises(RegistryError):
                web.validate({"schema_version": 1, "reads": [{"kind": "page", "url": url}]})
        for query in ["", " padded", "two\nlines", "q" * 301]:
            with self.subTest(query=query), self.assertRaises(RegistryError):
                web.validate({"schema_version": 1, "reads": [{"kind": "search", "query": query}]})
        page = {"kind": "page", "url": "https://example.com/"}
        for plan in ({"schema_version": 2, "reads": [page]}, {"schema_version": 1, "reads": []},
                     {"schema_version": 1, "reads": [page] * 2},
                     {"schema_version": 1, "reads": [{"kind": "page", "url": f"https://e{i}.com/"} for i in range(5)]},
                     {"schema_version": 1, "reads": [{**page, "method": "POST"}]},
                     {"schema_version": 1, "reads": [{"kind": "click", "url": "https://example.com/"}]},
                     {"schema_version": 1, "reads": [page], "extra": True}, [page], "plan"):
            with self.subTest(plan=plan), self.assertRaises(RegistryError):
                web.validate(plan)


class ExecutionTests(unittest.TestCase):
    def setUp(self):
        self.config = type("Config", (), {"get": lambda self, key, default=None: default})()
        self.checks = []

    def authorize(self):
        self.checks.append("check")

    def test_reads_run_in_order_as_untrusted_text_and_a_failed_page_is_reported(self):
        def fetch(url):
            if url.endswith("/down"):
                raise ValueError("response exceeded the 1000000-byte limit")
            return url + "?moved=1", "Status: all systems normal"
        plan = {"schema_version": 1, "reads": [*PLAN["reads"], {"kind": "page", "url": "https://example.com/down"}]}
        with patch("dgc.redaction.secret_values", return_value=["sk-live-SECRET"]):
            rows = web.execute(self.config, plan, authorize=self.authorize, fetch_page=fetch,
                               search=lambda query, config: f"1. Forecast for {query}: sunny sk-live-SECRET")
        self.assertEqual([row["kind"] for row in rows], ["page", "search", "page"])
        self.assertTrue(all(row["untrusted"] for row in rows))
        self.assertEqual(rows[0]["final_url"], "https://status.example.com/today?moved=1")
        self.assertEqual(rows[0]["text"], "Status: all systems normal")
        self.assertIn("sunny", rows[1]["text"])
        self.assertNotIn("sk-live-SECRET", rows[1]["text"], "configured secrets never reach the model")
        self.assertNotIn("text", rows[2])
        self.assertIn("byte limit", rows[2]["error"])
        self.assertEqual(len(self.checks), 4, "authorized before every read and once after the last")

    def test_a_search_provider_error_is_reported_not_raised(self):
        rows = web.execute(self.config, {"schema_version": 1, "reads": [PLAN["reads"][1]]},
                           authorize=self.authorize, search=lambda q, c: "error: web search failed (duckduckgo)")
        self.assertEqual(rows[0]["error"], "web search failed (duckduckgo)")

    def test_revoked_access_stops_before_the_next_read(self):
        calls = []

        def authorize():
            if calls:
                raise RegistryError("permission_denied", "changed")
        with self.assertRaises(RegistryError):
            web.execute(self.config, PLAN, authorize=authorize,
                        fetch_page=lambda url: calls.append(url) or (url, "text"),
                        search=lambda q, c: calls.append(q) or "text")
        self.assertEqual(calls, ["https://status.example.com/today"])

    def test_the_read_budget_is_checked_before_each_read(self):
        clock = iter([0, 0, web.READ_SECONDS + 1])
        with self.assertRaises(RegistryError) as raised:
            web.execute(self.config, PLAN, authorize=self.authorize, clock=lambda: next(clock),
                        fetch_page=lambda url: (url, "text"), search=lambda q, c: "text")
        self.assertEqual(raised.exception.code, "web_read_timeout")

    def test_a_secret_at_the_bound_is_redacted_whole(self):
        # A configured secret with no recognisable token shape: only an exact match redacts it.
        secret = "correct-horse-battery-staple-9431"
        page = "x" * (web.MAX_PAGE_CHARS - 16) + " " + secret
        with patch("dgc.redaction.secret_values", return_value=[secret]):
            rows = web.execute(self.config, {"schema_version": 1, "reads": [PLAN["reads"][0]]},
                               authorize=self.authorize, fetch_page=lambda url: (url, page))
        self.assertNotIn("correct-horse", rows[0]["text"], "no fragment of the secret survives the cut")

    def test_pages_are_bounded(self):
        rows = web.execute(self.config, {"schema_version": 1, "reads": [PLAN["reads"][0]]},
                           authorize=self.authorize, fetch_page=lambda url: (url, "x" * 50_000))
        self.assertLessEqual(len(rows[0]["text"]), web.MAX_PAGE_CHARS + 20)


class RedirectTests(unittest.TestCase):
    def test_a_reviewed_https_page_cannot_redirect_to_plain_http(self):
        class Response:
            is_redirect, is_permanent_redirect = True, False
            headers = {"Location": "http://plain.example.com/"}
            def close(self):
                pass
        with patch("dgc.tools._validate_public_url", side_effect=lambda url: url), \
                patch("requests.Session.get", return_value=Response()):
            with self.assertRaisesRegex(ValueError, "away from https"):
                web._fetch_page("https://status.example.com/")


class PersonalJobTests(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp

    def personal(self):
        return self.store.create(self.registry.personal()["id"], "Morning brief", "Summarize the reviewed pages", "local-console")

    def test_web_reads_are_reviewed_like_any_other_job_change(self):
        job = self.personal()
        proposal = self.store.propose(job["id"], 1, {"web_plan": PLAN}, "local-console")
        self.assertIsNone(self.store.get(job["id"]).get("web_plan"), "a proposal grants nothing")
        self.store.accept(job["id"], proposal["id"], 1, "local-console")
        self.assertEqual(self.store.get(job["id"])["web_plan"], PLAN)
        run = self.store.enqueue(job["id"], "web-one", "local-console", self.cfg)
        self.assertEqual(run["manifest"]["web_plan"], PLAN)
        removal = self.store.propose(job["id"], 2, {"web_plan": None}, "local-console")
        self.store.accept(job["id"], removal["id"], 2, "local-console")
        self.assertIsNone(self.store.get(job["id"]).get("web_plan"))

    def test_project_pips_and_model_proposals_cannot_gain_web_reads(self):
        project = self.store.create(self.workspace["id"], "Reviewer", "Review the source", "local-console")
        with self.assertRaises(RegistryError) as raised:
            self.store.propose(project["id"], 1, {"web_plan": PLAN}, "local-console")
        self.assertEqual(raised.exception.code, "unsupported_web_plan")
        job = self.personal()
        with self.assertRaises(RegistryError):
            self.store.propose(job["id"], 1, {"web_plan": PLAN}, "main-chat", origin_session_id="chat-one")

    def test_conversational_setup_carries_reviewed_web_reads_for_personal_scope_only(self):
        base = {"target_root": str(self.root), "name": "Morning brief", "goal": "Summarize the pages",
                "pip_type": "rook", "work_kind": "personal_task", "scope": "personal", "schedule": None,
                "run_now": False, "reason": "User asked for a morning brief", "request_key": "web-setup",
                "web_plan": PLAN}
        request = pip_setup.validate_request(base)
        self.assertEqual(request["web_plan"], PLAN)
        with self.assertRaises(RegistryError):
            pip_setup.validate_request({**base, "scope": "project", "work_kind": "source_review"})

    def test_controller_reads_the_pages_and_the_real_worker_sees_only_their_text(self):
        import subprocess
        import sys
        job = self.personal()
        proposal = self.store.propose(job["id"], 1, {"web_plan": PLAN}, "local-console")
        self.store.accept(job["id"], proposal["id"], 1, "local-console")
        run = self.store.enqueue(job["id"], "web-run", "local-console", self.cfg)
        row = self.store.claim_next()
        fixture = r'''
from unittest.mock import patch
from dgc.llm import LLMClient, ChatResult
from dgc.pips import _worker_main
import json

def chat(self, messages, tools=None, **kwargs):
    assert {t['function']['name'] for t in (tools or [])} <= {'draft_email', 'draft_calendar_event', 'skill'}, "A Personal task may only draft or load a skill's instructions: no tool reads your data or runs anything"
    reference = json.dumps(messages)
    assert 'Untrusted web reference data' in reference, 'Web reference envelope missing'
    assert 'PAGE_TEXT_SENTINEL' in reference and 'SEARCH_TEXT_SENTINEL' in reference, 'Read text missing'
    return ChatResult(content='All systems are normal and it will be sunny. No messages were sent.')
with patch.object(LLMClient, 'chat', chat), patch('requests.sessions.Session.request', side_effect=AssertionError('No network in the worker')):
    raise SystemExit(_worker_main())
'''
        popen = subprocess.Popen

        def process(argv, *a, **kw):
            if argv[1:] == ["-m", "dgc.pips", "--worker"]:
                argv = [sys.executable, "-c", fixture]
            return popen(argv, *a, **kw)
        fetched = []
        with patch.object(pips.subprocess, "Popen", side_effect=process), \
             patch.object(web, "_fetch_page", side_effect=lambda url: fetched.append(url) or (url, "PAGE_TEXT_SENTINEL")), \
             patch.object(web, "_search", side_effect=lambda query, config: fetched.append(query) or "SEARCH_TEXT_SENTINEL"):
            result = pips._execute_run(self.registry, row, self.cfg)
        self.store.finish(run["id"], result=result)
        self.assertEqual(self.store.run(run["id"])["status"], "succeeded")
        self.assertEqual(fetched, ["https://status.example.com/today", "weather in Pune today"])
        self.assertEqual(result["tools_called"], 0)
        self.assertIs(result["external_actions"], False)
        event = self.registry.db.execute(
            "SELECT payload FROM workspace_events WHERE run_id=? AND event_type='pip_run_web_reads'", (run["id"],)).fetchone()
        reads = json.loads(event[0])["reads"]
        self.assertEqual([r["kind"] for r in reads], ["page", "search"])
        self.assertNotIn("text", reads[0], "activity records what was read, not the page itself")


if __name__ == "__main__":
    unittest.main()
