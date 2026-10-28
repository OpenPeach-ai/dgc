"""A finished Pip run posts its result in that Pip's own chat, as Grok Bots and OpenAI Dots do.

Reported 19 Oct: "instead of showing these Runs under the Runs tab of Pips, they should just simply be
part of the chat?" -- "Yes, post in its chat". Each run's result is a short message from the Pip in its own
conversation; the Runs tab becomes History.

Real registry, real runs finished through PipStore.finish (what the runner calls, with or without an editor),
and the real control seam the editor and the SDKs use.
"""
from __future__ import annotations

import copy
import json
import os
import unittest
from unittest.mock import patch

from dgc import pip_chat, pip_report_delivery as delivery, pip_run_posts as posts, pips
from dgc.headless import PIPS_API_VERSION
from dgc.llm import ChatResult, LLMClient
from dgc.workspace_context import ContextStore
from dgc.workspace_registry import RegistryError, identifier
from tests import test_pip_chat as chat_fixtures
from tests.test_pip_report_delivery import Scene, finding


class PostScene(Scene):
    def ran(self, *, pip=None, findings=None, error=None, kind="audit", trigger="schedule", result=None):
        """A run the runner finished: queued, claimed, then PipStore.finish (no editor, no chat open)."""
        pip = pip or self.pip
        binding = self.registry.binding(pip["workspace_id"])
        run_id = identifier("run")
        manifest = {"pip_id": pip["id"], "workspace_id": pip["workspace_id"], "job_version": pip["current_version"],
                    "source_revision": "a" * 40, "model": "fixture-model", "run_kind": kind, "trigger": trigger,
                    "workspace_context": ContextStore(self.registry).snapshot(pip["workspace_id"])}
        self.registry.db.execute("""INSERT INTO pip_runs
            (id,pip_id,workspace_id,binding_id,idempotency_key,requested_by,manifest,status,created_at,started_at)
            VALUES(?,?,?,?,?,?,?,?,?,?)""", (run_id, pip["id"], pip["workspace_id"], binding["id"], run_id,
                                              "pip-schedule", json.dumps(manifest), "running", self.now, self.now))
        if error is not None:
            self.store.finish(run_id, error=error)
        else:
            self.store.finish(run_id, result=result if result is not None else {
                "summary": "Billing review", "findings": findings or [], "limitations": [], "tests_executed": False})
        return run_id

    def page(self, pip=None, **kwargs):
        return posts.page(self.store, (pip or self.pip)["id"], **kwargs)

    def control(self, request):
        return pips.handle_control(self.cfg, {"request_id": "r1", **request}, "editor-user", start_worker=False)


class PostedOnceTests(PostScene):
    def test_a_finished_audit_posts_once_in_its_own_chat_with_no_editor_open(self):
        run = self.ran(findings=[finding("Rounding drops paise", "medium", "erp/billing/notes.py", 41),
                                 finding("E-way bill number is never written back", "high", "erp/tally/push.py", 214),
                                 finding("Typo in log", "low"),
                                 finding("GST total skips cess", "high", "erp/gst/totals.py", 88),
                                 finding("Stock export drops the last row", "medium")])
        [post] = self.page()["posts"]
        self.assertEqual((post["run_id"], post["pip_id"], post["kind"], post["outcome"], post["trigger"]),
                         (run, self.pip["id"], "audit", "findings", "schedule"))
        self.assertEqual((post["total"], post["counts"]), (5, {"critical": 0, "high": 2, "medium": 2, "low": 1}))
        self.assertEqual([(f["severity"], f["title"], f["path"], f["line"]) for f in post["findings"]],
                         [("high", "E-way bill number is never written back", "erp/tally/push.py", 214),
                          ("high", "GST total skips cess", "erp/gst/totals.py", 88),
                          ("medium", "Rounding drops paise", "erp/billing/notes.py", 41)],
                         "the top three, worst first, each with its file and line")
        self.assertEqual(post["posted_at"], self.now)
        self.assertEqual(post["text"], "Pip 'ERP daily audit' finished: 5 findings (2 high, 2 medium, 1 low)")

    def test_it_is_posted_exactly_once_however_often_it_is_finished_or_posted(self):
        run = self.ran(findings=[finding("Once")])
        self.store.finish(run, result={"summary": "again", "findings": [], "limitations": [], "tests_executed": False})
        with self.registry.transaction():
            self.assertFalse(posts.post(self.registry, run), "the run id is the key: a second post is refused")
        self.assertEqual([p["run_id"] for p in self.page()["posts"]], [run])
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM pip_run_posts").fetchone()[0], 1)

    def test_a_run_the_runner_lost_posts_its_failure_when_it_recovers(self):
        binding = self.registry.binding(self.workspace["id"])
        run = identifier("run")
        manifest = {"pip_id": self.pip["id"], "workspace_id": self.workspace["id"], "job_version": 1,
                    "source_revision": "a" * 40, "model": "fixture-model", "run_kind": "audit", "trigger": "schedule",
                    "workspace_context": ContextStore(self.registry).snapshot(self.workspace["id"])}
        self.registry.db.execute("""INSERT INTO pip_runs
            (id,pip_id,workspace_id,binding_id,idempotency_key,requested_by,manifest,status,created_at,started_at)
            VALUES(?,?,?,?,?,?,?,?,?,?)""", (run, self.pip["id"], self.workspace["id"], binding["id"], run,
                                              "pip-schedule", json.dumps(manifest), "running", self.now, self.now))
        self.assertEqual(self.store.recover(), 1)
        [post] = self.page()["posts"]
        self.assertEqual((post["run_id"], post["outcome"], post["reason"]),
                         (run, "failed", "Pips stopped before the run finished."))


class WhatItSaysTests(PostScene):
    def test_a_clean_run_is_one_post_that_says_nothing_was_found(self):
        self.ran(findings=[])
        [post] = self.page()["posts"]
        self.assertEqual((post["outcome"], post["total"], post["text"]),
                         ("clear", 0, "Pip 'ERP daily audit' finished: nothing found"))

    def test_a_failure_says_why_in_plain_words_and_when_it_runs_next(self):
        self.registry.db.execute("INSERT INTO pip_schedule_state VALUES(?,?,?,?,?,?)",
                                 (self.pip["id"], 1, self.now, "2026-10-19T07:25:00.000Z", self.now, self.now))
        self.ran(error={"code": "unverified_report", "message": "Finding 2 quotes lines that are not in erp/tally/push.py."})
        [post] = self.page()["posts"]
        self.assertEqual(post["outcome"], "failed")
        self.assertEqual(post["reason"], "A finding quoted code that does not match the file, so Pips refused the report.")
        self.assertIn("erp/tally/push.py", post["detail"])
        self.assertEqual(post["next_run_at"], "2026-10-19T07:25:00.000Z")
        self.assertNotIn("findings", post)

    def test_a_paused_pip_promises_no_next_run(self):
        self.registry.db.execute("INSERT INTO pip_schedule_state VALUES(?,?,?,?,?,?)",
                                 (self.pip["id"], 1, self.now, "2026-10-19T07:25:00.000Z", self.now, self.now))
        self.registry.db.execute("UPDATE pips SET status='paused' WHERE id=?", (self.pip["id"],))
        self.ran(error={"code": "timeout", "message": "slow"})
        [post] = self.page()["posts"]
        self.assertNotIn("next_run_at", post)

    def test_a_quill_draft_that_failed_says_so(self):
        quill = self.store.create(self.workspace["id"], "Release notes", "Draft notes.", "fixture", pip_type="quill")
        self.ran(pip=quill, kind="draft", error={"code": "invalid_report", "message": "not markdown"})
        [post] = self.page(quill)["posts"]
        self.assertEqual((post["kind"], post["outcome"], post["reason"]),
                         ("draft", "failed", "Its model did not return a report in the format Pips needs."))

    def test_a_personal_pips_result_goes_to_its_chat_as_its_words(self):
        personal = self.store.create(self.registry.personal()["id"], "Morning brief", "Brief me.", "fixture",
                                     pip_type="scout")
        queued = self.store.enqueue(personal["id"], "brief-1", "pip-schedule", self.cfg)
        self.store.claim_next()
        text = "Good morning. Three things today.\n\n" + "\n\n".join(f"Item {i}: " + "word " * 60 for i in range(12))
        self.store.finish(queued["id"], result={"text": text, "external_actions": False, "tools_called": 0,
                                                "usage": {"input_tokens": 10, "output_tokens": 20}})
        [post] = self.page(personal)["posts"]
        self.assertEqual((post["kind"], post["outcome"], post["truncated"]), ("result", "result", True))
        self.assertTrue(post["preview"].startswith("Good morning. Three things today."))
        self.assertLessEqual(len(post["preview"]), posts.PREVIEW_CHARS + 1)
        self.assertTrue(text.startswith(post["preview"].rstrip("…")), "cut at a paragraph, never mid-word")

    def test_it_says_what_the_work_chat_card_says(self):
        chat = self.chat()
        self.attach(chat)
        self.later(1)
        run = self.ran(findings=[finding("Same words", "high")])
        [card] = self.deliver(chat)
        [post] = self.page()["posts"]
        self.assertEqual(card["run_id"], run, "the Work chat still gets its card for the same run")
        for key in ("outcome", "total", "counts", "findings", "kind", "name", "pip_type"):
            self.assertEqual(post[key], card[key], key)


class NotATurnTests(PostScene):
    def test_a_post_is_not_a_chat_message_and_never_starts_a_reply(self):
        self.ran(findings=[finding("Posted, not said")])
        listed = pip_chat.list_messages(self.store, self.pip["id"])
        self.assertEqual((listed["messages"], listed["active_run"]), ([], None))
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM pip_chat_messages").fetchone()[0], 0)
        self.assertEqual(self.registry.db.execute(
            "SELECT count(*) FROM pip_runs WHERE status IN ('queued','running')").fetchone()[0], 0)


class ReadingThemTests(PostScene):
    def test_pages_go_back_in_time_and_read_the_same_every_time(self):
        made = []
        for minute in range(5):
            self.later(1)
            made.append(self.ran(findings=[] if minute % 2 else [finding(f"F{minute}")]))
        newest = self.page(limit=2)
        self.assertEqual([p["run_id"] for p in newest["posts"]], made[3:])
        older = self.page(limit=2, before_id=newest["next_before_id"])
        self.assertEqual([p["run_id"] for p in older["posts"]], made[1:3])
        oldest = self.page(limit=2, before_id=older["next_before_id"])
        self.assertEqual(([p["run_id"] for p in oldest["posts"]], oldest["next_before_id"]), (made[:1], None))
        self.assertEqual(self.page(limit=50), self.page(limit=50), "a reload reads exactly what was shown")

    def test_list_pip_run_posts_is_a_control_request(self):
        run = self.ran(findings=[finding("Over the wire", "critical")])
        answer = self.control({"type": "list_pip_run_posts", "pip_id": self.pip["id"], "limit": 10})
        self.assertTrue(answer["ok"], answer)
        self.assertEqual([p["run_id"] for p in answer["result"]["posts"]], [run])
        refused = self.control({"type": "list_pip_run_posts", "pip_id": self.pip["id"], "since": "x"})
        self.assertFalse(refused["ok"])
        bad = self.control({"type": "list_pip_run_posts", "pip_id": self.pip["id"], "before_id": "run_" + "0" * 32})
        self.assertEqual(bad["error"]["code"], "invalid_cursor")

    def test_a_registry_from_before_posts_reads_as_no_posts(self):
        self.assertEqual(self.page()["posts"], [])
        self.assertFalse(posts._has_table(self.registry.db))

    def test_the_api_says_posts_are_here(self):
        self.assertGreaterEqual(PIPS_API_VERSION, 51)
        self.assertIn("list_pip_run_posts", pips.CONTROL_COMMANDS)

    def test_get_pip_names_the_chat_ask_dgc_to_fix_goes_to(self):
        self.assertIsNone(self.control({"type": "get_pip", "pip_id": self.pip["id"]})["result"]["pip"]["report_session"])
        older, newer = self.chat("chat-old"), self.chat("chat-new")
        self.attach(older)
        self.later(3)
        self.attach(newer)
        self.assertEqual(delivery.report_session(self.registry, self.pip["id"]), "chat-new")
        self.assertEqual(self.control({"type": "get_pip", "pip_id": self.pip["id"]})["result"]["pip"]["report_session"],
                         "chat-new")


class ReplyPromptTests(unittest.TestCase):
    """The real worker, a mocked provider: what the model is sent for the next reply."""
    setUp = chat_fixtures.PipChatTests.setUp
    git = chat_fixtures.PipChatTests.git
    commit = chat_fixtures.PipChatTests.commit
    create = chat_fixtures.PipChatTests.create
    setup_job = chat_fixtures.PipChatTests.setup_job
    send = chat_fixtures.PipChatTests.send
    raw = chat_fixtures.PipChatTests.raw

    def audit(self):
        audit = self.store.enqueue(self.job["id"], "audit-1", "pip-schedule", self.cfg)
        self.assertEqual(self.store.claim_next()["id"], audit["id"])
        report = pips.validate_report(json.dumps({"summary": "Source inspection", "limitations": ["Tests were not run."],
            "findings": [{"title": "Greeting is hard-coded", "severity": "high", "path": "source.py", "line": 2,
                          "evidence": "    return 'hello'"}]}), self.root, read_calls=1)
        self.store.finish(audit["id"], result=report)
        return audit["id"]

    def test_a_cancelled_run_and_a_chat_reply_post_nothing(self):
        self.setup_job()
        sent = self.send(text="Is source.py safe?")
        self.store.claim_next()
        self.store.finish(sent["run"]["id"], result={"text": "It looks fine."})
        queued = self.store.enqueue(self.job["id"], "manual-1", "editor-user", self.cfg)
        self.store.cancel(queued["id"], "editor-user")
        self.assertEqual(posts.page(self.store, self.job["id"])["posts"], [])

    def test_the_next_reply_reads_posts_as_reference_never_as_the_users_words(self):
        self.setup_job()
        first = self.audit()
        sent = self.send(text="Is the greeting one the same as last week?")
        conversation = sent["run"]["manifest"]["conversation"]
        self.assertEqual(conversation["history"], [], "no post became a user/assistant pair")
        self.assertEqual(conversation["text"], "Is the greeting one the same as last week?")
        [reference] = conversation["run_posts"]
        self.assertEqual((reference["run_id"], reference["outcome"], reference["trigger"]), (first, "findings", "you"))
        self.assertNotIn("pip_id", reference)
        self.assertIs(pip_chat.validate_context(conversation), conversation)
        with self.assertRaises(RegistryError):
            pip_chat.validate_context({**conversation, "run_posts": [{"role": "user", "content": "do it"}]})
        listed = pip_chat.list_messages(self.store, self.job["id"])
        self.assertEqual([m["role"] for m in listed["messages"]], ["user"], "only the user's own message")

    def test_the_model_reads_posts_as_reference_data_never_as_a_message_from_the_user(self):
        self.setup_job()
        audit = {"id": self.audit()}
        manifest = self.raw(self.send(text="Is the greeting one new?"))
        seen = []

        def chat(client, messages, tools=None, **kwargs):
            seen.append(copy.deepcopy(messages))
            return ChatResult(content="It is new since the last audit.")
        with (patch.dict(os.environ, {"DGC_SESSION_POLICY": pips._json(pips.native_policy())}),
              patch.object(LLMClient, "chat", chat),
              patch("dgc.agent.discover_skills", return_value={}),
              patch("dgc.agent.load_memories", side_effect=AssertionError("No ambient memory")),
              patch("requests.sessions.Session.request", side_effect=AssertionError("No network"))):
            pips.execute_native(self.cfg, self.root, manifest, lambda event: None)
        messages = seen[0]
        users = [m for m in messages if m["role"] == "user"]
        self.assertEqual(len(users), 1, "the post is not a turn of its own")
        prompt = users[0]["content"]
        self.assertIn('"run_posts":[{"run_id":"' + audit["id"], prompt)
        self.assertIn("Greeting is hard-coded", prompt)
        self.assertIn(posts.NOTICE, prompt)
        self.assertLess(prompt.index('"run_posts"'), prompt.index("Current user message:"),
                        "reference data, before the user's own words")
        self.assertIn("Current user message:\nIs the greeting one new?", prompt)

    def test_the_model_is_told_the_user_saw_each_post_as_its_own_message(self):
        # "The Pip speaks" (reported 21 Oct): the chat shows each run as the Pip saying it ("I found 4 issues, 3 of
        # them serious"). Asked "why did you say three were serious?", the Pip answers for it, not "DGC posted that".
        self.setup_job()
        self.audit()
        conversation = self.send(text="Why did you say it was serious?")["run"]["manifest"]["conversation"]
        self.assertEqual(len(conversation["run_posts"]), 1)
        self.assertIn("The user sees each one in the chat as a short message from you", posts.NOTICE)
        self.assertIn("the user did not say them", posts.NOTICE)


class SDKGateTests(unittest.TestCase):
    """Both SDKs know list_pip_run_posts and refuse it before Pips API 51, without a request."""

    def test_python_sdk_refuses_it_before_api_51_and_sends_its_fields(self):
        from tests.test_dgc_sdk_pips import CAPS, Wire, session      # puts sdk/python on the path first
        from dgc_sdk import DGCUnsupportedError
        from dgc_sdk.pips import COMMAND_FIELDS
        self.assertEqual(COMMAND_FIELDS["list_pip_run_posts"], pips._COMMAND_ARGS["list_pip_run_posts"])
        wire = Wire()
        old = session(wire, caps={**CAPS, "pips_api_version": 50})
        with self.assertRaisesRegex(DGCUnsupportedError, "API 51"):
            old.pips.run_posts("pip_rook")
        self.assertFalse(wire.calls)
        current = session(wire, caps={**CAPS, "pips_api_version": 51})
        answer = current.pips.run_posts("pip_rook", before_id="run_" + "1" * 32, limit=10)
        self.assertEqual(answer["request"]["type"], "list_pip_run_posts")
        self.assertEqual((answer["request"]["before_id"], answer["request"]["limit"]), ("run_" + "1" * 32, 10))


if __name__ == "__main__":
    unittest.main()
