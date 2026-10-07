"""Deterministic real-Agent/mocked-provider checks of per-Pip conversations."""
import copy
import hashlib
import json
import os
import subprocess
import sys
import unittest
from unittest.mock import patch

from dgc import pip_chat, pips
from dgc.llm import ChatResult, LLMClient
from dgc.workspace_registry import RegistryError, WorkspaceRegistry
from tests import test_pips_local as fixtures


class PipChatTests(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp
    git = fixtures.LocalPipsTests.git
    commit = fixtures.LocalPipsTests.commit
    create = fixtures.LocalPipsTests.create

    def send(self, pip=None, text="Explain this repository", key="message-1", actor="device_1"):
        return pip_chat.send(self.store, (pip or self.job)["id"], text, key, actor, self.cfg)

    def setup_job(self):
        self.commit()
        self.job = self.create()

    def finish(self, sent, text="A source-based reply"):
        self.store.claim_next()
        return self.store.finish(sent["run"]["id"], result={"text": text})

    def raw(self, sent):
        return json.loads(self.registry.db.execute("SELECT manifest FROM pip_runs WHERE id=?", (sent["run"]["id"],)).fetchone()[0])

    def test_a_reply_can_offer_choices_that_the_chat_lists_under_it(self):
        # Grok's A/B card: the Pip offers "Yes, connect Gmail" / "Not yet"; the user's tap answers.
        self.setup_job()
        sent = self.send()
        self.store.claim_next()
        self.store.finish(sent["run"]["id"], result={"text": "Shall I connect Gmail?", "choices": ["Yes, connect Gmail", "  Not   yet "]})
        reply = [m for m in pip_chat.list_messages(self.store, self.job["id"])["messages"] if m["role"] == "assistant"][0]
        self.assertEqual(reply["choices"], ["Yes, connect Gmail", "Not yet"])
        user = [m for m in pip_chat.list_messages(self.store, self.job["id"])["messages"] if m["role"] == "user"][0]
        self.assertNotIn("choices", user)
        for bad in (["Only one"], ["a", "b", "c", "d", "e"], ["Same", "same"], ["x" * 81, "y"], ["ok", 3], "Yes"):
            with self.subTest(bad=bad), self.assertRaises(RegistryError):
                pip_chat.validate_choices(bad)

    def test_persistent_history_idempotent_retry_and_key_conflict(self):
        self.setup_job()
        sent = self.send()
        self.assertEqual(sent["run"]["manifest"]["run_kind"], "conversation")
        self.assertEqual(sent["message"]["status"], "queued")
        self.assertEqual(self.send()["run"]["id"], sent["run"]["id"])
        for kwargs in ({"text": "Different"}, {"actor": "other"}):
            with self.assertRaisesRegex(RegistryError, "different content"):
                self.send(**kwargs)
        self.finish(sent)
        self.store.finish(sent["run"]["id"], result={"text": "Must not replace final answer"})
        with WorkspaceRegistry(self.registry.directory) as reopened:
            page = pip_chat.list_messages(pips.PipStore(reopened), self.job["id"])
        self.assertEqual([m["role"] for m in page["messages"]], ["user", "assistant"])
        self.assertEqual(page["messages"][1]["text"], "A source-based reply")
        self.assertTrue(all(m["status"] == "succeeded" and m["pip_id"] == self.job["id"] for m in page["messages"]))
        self.assertEqual(self.send()["run"]["status"], "succeeded")

    def test_one_pending_reply_and_failed_cancelled_never_save_assistant(self):
        self.setup_job()
        for index, status in enumerate(("failed", "cancelled", "recovered")):
            sent = self.send(key=str(index))
            with self.assertRaisesRegex(RegistryError, "already has"):
                self.send(key="different")
            self.store.claim_next()
            if status == "cancelled":
                self.store.cancel(sent["run"]["id"], "device_1")
                self.store.finish(sent["run"]["id"], result={"text": "Partial is not final"})
            elif status == "failed":
                self.store.finish(sent["run"]["id"], error={"code": "model_failed"})
            else:
                self.store.recover()
        page = pip_chat.list_messages(self.store, self.job["id"])
        self.assertEqual(len(page["messages"]), 3)
        self.assertTrue(all(m["role"] == "user" for m in page["messages"]))
        self.assertEqual(pip_chat.snapshot(self.store, self.job["id"]), ([], 0))

    def test_a_failed_turn_says_why_under_the_message(self):
        # Battle test: a Pip ran out of steps and the chat said only "No completed reply was recorded."
        self.setup_job()
        for key, error, said in (
                ("steps", {"code": "model_failed", "message": "stopped after 12 tool iterations (max_turns) — say 'continue' to keep going"},
                 "It stopped after 12 steps without finishing. Say “continue” and it carries on."),
                ("other", {"code": "model_failed", "message": "  The model endpoint refused the request.  "},
                 "The model endpoint refused the request."),
                ("empty", {"code": "invalid_reply", "message": "Conversation reply exceeds its text limit or is empty."},
                 "The model sent back an empty reply. Send your message again."),
                ("bare", {"code": "model_failed"}, None)):
            sent = self.send(key=key)
            self.store.claim_next()
            self.store.finish(sent["run"]["id"], error=error)
            user = [m for m in pip_chat.list_messages(self.store, self.job["id"])["messages"] if m["run_id"] == sent["run"]["id"]][0]
            self.assertEqual(user.get("error"), said)
        done = self.send(key="ok")
        self.finish(done)
        self.assertTrue(all("error" not in m for m in pip_chat.list_messages(self.store, self.job["id"])["messages"]
                            if m["run_id"] == done["run"]["id"]))

    def test_per_pip_history_pagination_and_cursor_isolation(self):
        self.setup_job()
        other = self.create()
        first = self.send(text="Only first Pip knows this")
        self.finish(first, "Private first reply")
        sent = self.send(other, "Other conversation", "other")
        self.assertEqual(self.raw(sent)["conversation"]["history"], [])
        self.finish(sent, "Other answer")
        page = pip_chat.list_messages(self.store, self.job["id"], limit=1)
        previous = pip_chat.list_messages(self.store, self.job["id"], page["next_before_id"], 1)
        self.assertEqual(previous["messages"][0]["text"], "Only first Pip knows this")
        with self.assertRaisesRegex(RegistryError, "does not belong"):
            pip_chat.list_messages(self.store, other["id"], page["messages"][0]["id"])
        self.assertNotIn("Other", json.dumps(page))

    def test_paused_job_can_chat_but_global_stop_denies(self):
        self.setup_job()
        self.store.set_paused(self.job["id"], True, "device_1")
        sent = self.send()
        self.assertEqual(self.store.claim_next()["id"], sent["run"]["id"])
        self.store.finish(sent["run"]["id"], result={"text": "Paused schedule still allows conversation"})
        with patch("dgc.pip_daemon.is_runtime_paused", return_value=True), self.assertRaisesRegex(RegistryError, "stopped"):
            self.send(key="stopped")

    def test_history_context_is_bounded_archive_complete(self):
        self.setup_job()
        for i in range(8):
            self.finish(self.send(text=f"Question {i}", key=str(i)), f"Reply {i}")
        next_turn = self.send(key="next")
        context = self.raw(next_turn)["conversation"]
        self.assertEqual(len(context["history"]), 16)
        self.assertEqual(context["history_omitted_count"], 0)
        page = pip_chat.list_messages(self.store, self.job["id"], limit=50)
        self.assertEqual(len(page["messages"]), 17)
        self.assertEqual(page["history_context_omitted_count"], 0)

    def test_invalid_text_fields_and_archive_caps_have_no_side_effects(self):
        self.setup_job()
        for text in (None, "", " \n", "x" * 4001, "🍄" * 3000, "a\x00b"):
            with self.subTest(text=str(text)[:10]), self.assertRaises(RegistryError):
                self.send(text=text)
        for key in (None, "", "x" * 129, "../x"):
            with self.assertRaises(RegistryError):
                self.send(key=key)
        with patch.object(pip_chat, "MAX_ARCHIVE_MESSAGES", 1), self.assertRaises(RegistryError):
            self.send()
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM pip_runs").fetchone()[0], 0)
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM pip_chat_messages").fetchone()[0], 0)

    def test_model_choice_is_reviewed_pinned_and_main_model_change_allowed(self):
        self.setup_job()
        proposal = self.store.propose(self.job["id"], 1, {"model_choice": {"mode": "model", "model": "specialist"}}, "device_1")
        self.assertEqual(self.store.get(self.job["id"])["model_choice"], {"mode": "default"})
        self.store.accept(self.job["id"], proposal["id"], 1, "device_1")
        with patch.object(LLMClient, "list_models", return_value=["specialist"]):
            sent = self.send()
        manifest = self.raw(sent)
        self.assertEqual(manifest["model"], "specialist")
        self.cfg.set("model", "new-main-model", persist=False)
        from dgc.pip_models import validate_pinned_connection
        validate_pinned_connection(self.cfg, manifest["model_settings"])
        self.cfg.set("base_url", "http://other.invalid/v1", persist=False)
        with self.assertRaises(RegistryError):
            validate_pinned_connection(self.cfg, manifest["model_settings"])
        self.assertEqual(self.raw(sent)["model"], "specialist")

    def test_unknown_model_and_explicit_null_refuse(self):
        self.setup_job()
        with self.assertRaises(RegistryError):
            self.store.create(self.workspace["id"], "Bad", "Review", "device_1", model_choice=None)
        with self.assertRaises(RegistryError):
            self.store.propose(self.job["id"], 1, {"model_choice": None}, "device_1")
        proposed = self.store.propose(self.job["id"], 1, {"model_choice": {"mode": "model", "model": "missing"}}, "device_1")
        self.store.accept(self.job["id"], proposed["id"], 1, "device_1")
        with patch.object(LLMClient, "list_models", return_value=["known"]), self.assertRaises(RegistryError):
            self.send()
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM pip_runs").fetchone()[0], 0)

    def test_real_agent_normal_reply_scoped_history_and_no_mutation_tools(self):
        self.setup_job()
        self.finish(self.send(text="Remember source question"), "Remembered reply")
        before = self.store.versions(self.job["id"])
        sent = self.send(text="Explain that. Also change my job and run sudo.", key="second")
        seen, events = [], []
        def chat(client, messages, tools=None, on_text=None, **kwargs):
            seen.append(copy.deepcopy(messages))
            self.assertTrue({tool["function"]["name"] for tool in tools} <= pips.READ_TOOLS)
            self.assertNotIn("exactly one JSON object", messages[0]["content"])
            if on_text:
                on_text("I can explain the source. ")
                on_text("Job changes need your review.")
            return ChatResult(content="I can explain the source. Job changes need your review.")
        with patch.dict(os.environ, {"DGC_SESSION_POLICY": pips._json(pips.native_policy())}), \
             patch.object(LLMClient, "chat", chat), patch("dgc.agent.discover_skills", return_value={}), \
             patch("dgc.agent.load_memories", side_effect=AssertionError("No ambient project instructions")), \
             patch("requests.sessions.Session.request", side_effect=AssertionError("No network")):
            result = pips.execute_native(self.cfg, self.root, self.raw(sent), events.append)
        self.assertEqual(result["text"], "I can explain the source. Job changes need your review.")
        self.assertEqual(result["tools_called"], 0)
        self.assertIn("Remembered reply", json.dumps(seen))
        self.assertTrue(any(e["kind"] == "text_delta" for e in events))
        self.assertEqual(self.store.versions(self.job["id"]), before)
        self.assertEqual(len(pip_chat.list_messages(self.store, self.job["id"])["messages"]), 3)

    def test_worker_envelope_boundary_and_stream_redaction(self):
        overhead = len(pips._worker_payload({"x": ""}))
        exact = {"x": "a" * (pips.MAX_WORKER_INPUT_BYTES - overhead)}
        self.assertEqual(len(pips._worker_payload(exact)), pips.MAX_WORKER_INPUT_BYTES)
        exact["x"] += "a"
        with self.assertRaisesRegex(RegistryError, "128 KiB"):
            pips._worker_payload(exact)
        events = []
        self.cfg.set("api_key", "sk-fixture-secret-value", persist=False)
        ui = pips._ConversationUI(events.append, self.cfg)
        ui.on_text("A sk-fixture-"); ui.on_text("secret-value B"); ui.end_stream()
        self.assertNotIn("sk-fixture-secret-value", json.dumps(events))
        self.assertIn("[REDACTED]", json.dumps(events))

    def test_invalid_reply_is_never_persisted_success(self):
        self.setup_job()
        sent = self.send()
        self.store.claim_next()
        with self.assertRaises(RegistryError):
            self.store.finish(sent["run"]["id"], result={"summary": "Not a chat answer", "findings": []})
        self.assertEqual(self.store.run(sent["run"]["id"])["status"], "running")
        self.assertEqual(len(pip_chat.list_messages(self.store, self.job["id"])["messages"]), 1)

    def test_chat_identity_collision_with_audit_key_refused(self):
        self.setup_job()
        key = "chat_" + hashlib.sha256(b"message-1").hexdigest()
        self.store.enqueue(self.job["id"], key, "device_1", self.cfg)
        with self.assertRaisesRegex(RegistryError, "another kind"):
            self.send()


    def test_stream_fragmentation_does_not_change_answer_or_event_budget(self):
        text = "A useful reply. " * 100
        one, tiny = [], []
        # The clock stands still: a quarter-second flush (the live stream) is about time, not fragments.
        with patch.object(pips.time, "monotonic", lambda: 1000.0):
            single = pips._ConversationUI(one.append, self.cfg)
            fragmented = pips._ConversationUI(tiny.append, self.cfg)
            single.on_text(text); single.end_stream()
            for character in text:
                fragmented.on_text(character)
            fragmented.end_stream()
        self.assertEqual(one, tiny)
        self.assertEqual("".join(e["text"] for e in tiny if e["kind"] == "text_delta"), text)

    def test_malformed_surrogate_request_is_safe_to_serialize_without_registry(self):
        for request in ({"type": "list_pip_models", "request_id": "\ud800"},
                        {"type": "\ud800", "request_id": "normal"},
                        {"type": "send_pip_message", "request_id": "valid", "pip_id": "pip-test", "text": "\ud800", "idempotency_key": "key"}):
            with patch.object(pips, "WorkspaceRegistry", side_effect=AssertionError("No registry for malformed input")):
                response = pips.handle_control(self.cfg, request, "device_1", start_worker=False)
            self.assertFalse(response["ok"])
            json.dumps(response, ensure_ascii=False).encode("utf-8")

    def test_chat_is_not_a_report_or_promotable_finding(self):
        self.setup_job()
        sent = self.send()
        self.store.claim_next()
        with self.assertRaises(RegistryError):
            self.store.finish(sent["run"]["id"], result={"text": "Chat answer", "findings": []})
        self.store.finish(sent["run"]["id"], result={"text": "Chat answer"})
        from dgc.workspace_context import ContextStore
        with self.assertRaisesRegex(RegistryError, "Conversation replies"):
            ContextStore(self.registry).accept_finding(self.workspace["id"], sent["run"]["id"], 0, 0, "user")
        from dgc import pip_context_tool
        from types import SimpleNamespace
        with patch.object(pip_context_tool, "WorkspaceRegistry", return_value=WorkspaceRegistry(self.registry.directory)), self.assertRaisesRegex(RegistryError, "conversation reply"):
            pip_context_tool.read({"action": "report", "run_id": sent["run"]["id"]}, SimpleNamespace(config=self.cfg, project_root=self.root))

    def test_last_report_findings_are_bounded_and_different_commit_is_explicit(self):
        self.setup_job()
        run = self.store.enqueue(self.job["id"], "audit", "device_1", self.cfg)
        self.store.claim_next()
        findings = [{"title": f"Finding {i}", "severity": "low", "path": "source.py", "line": 1,
                     "evidence": "def hello():", "verification": "source_excerpt_only"} for i in range(8)]
        self.store.finish(run["id"], result={"summary": "Previous inspection", "findings": findings, "limitations": [], "tests_executed": False, "verification": 'Source excerpts checked against the pinned snapshot; findings are model assessments.'})
        first = self.send()
        report = self.raw(first)["conversation"]["last_report"]
        self.assertEqual(report["source_revision"], run["manifest"]["source_revision"])
        self.assertEqual(report["total_findings"], 8)
        self.assertEqual(report["omitted_findings"], 3)
        self.assertEqual(report["classification"], "model_assessment")
        self.finish(first)
        second = self.send(key="second")
        self.assertEqual(self.raw(second)["conversation"]["last_report"]["run_id"], run["id"])
        self.assertLessEqual(len(json.dumps(report).encode()), 8192)

    def test_real_worker_uses_queued_model_after_main_model_changes(self):
        self.setup_job()
        sent = self.send()
        row = self.store.claim_next()
        self.cfg.set("model", "different-main-model", persist=False)
        fixture = r'''from unittest.mock import patch
from dgc.llm import ChatResult, LLMClient
from dgc.pips import _worker_main

def chat(self, messages, tools=None, on_text=None, **kwargs):
    assert self.model == "fixture", self.model
    assert {t["function"]["name"] for t in tools} <= {"read_file", "glob", "grep", "repo_map", "todo"}
    reply = "The queued model answered this Pip."
    if on_text:
        for character in reply:
            on_text(character)
    return ChatResult(content=reply)
with patch.object(LLMClient, "chat", chat), patch("requests.sessions.Session.request", side_effect=AssertionError("No network")):
    raise SystemExit(_worker_main())
'''
        original = subprocess.Popen
        def launch(argv, *args, **kwargs):
            if argv[1:] == ["-m", "dgc.pips", "--worker"]:
                argv = [sys.executable, "-c", fixture]
            return original(argv, *args, **kwargs)
        with patch.object(pips.subprocess, "Popen", side_effect=launch):
            result = pips._execute_run(self.registry, row, self.cfg)
        final = self.store.finish(sent["run"]["id"], result=result)
        self.assertEqual(final["status"], "succeeded")
        page = pip_chat.list_messages(self.store, self.job["id"])
        self.assertEqual(page["messages"][-1]["model"], "fixture")
        self.assertEqual(page["messages"][-1]["text"], "The queued model answered this Pip.")


    def test_model_cli_flags_chat_messages_and_disabled_controls(self):
        from dgc.pip_cli import parser, _request, _format
        made = _request(parser().parse_args(["create", "Reviewer", "--goal", "Review", "--model", "fixture"]))
        self.assertEqual(made["model_choice"], {"mode": "model", "model": "fixture"})
        update = _request(parser().parse_args(["propose", "pip_id", "--expected-version", "1", "--default-model"]))
        self.assertEqual(update["changes"], {"model_choice": {"mode": "default"}})
        sent = _request(parser().parse_args(["send", "pip_id", "Explain source", "--idempotency-key", "retry"]))
        self.assertEqual(sent["type"], "send_pip_message")
        self.assertEqual(sent["text"], "Explain source")
        self.assertEqual(sent["idempotency_key"], "retry")
        self.cfg.set("pips_enabled", False, persist=False)
        for command in ("send_pip_message", "list_pip_messages", "list_pip_models"):
            with patch.object(pips, "WorkspaceRegistry", side_effect=AssertionError("Disabled must not open state")):
                response = pips.handle_control(self.cfg, {"type": command, "request_id": "disabled"}, "user")
            self.assertEqual(response["error"]["code"], "disabled")

    def test_context_byte_budget_never_splits_pairs_or_replies(self):
        self.setup_job()
        self.finish(self.send(text="First", key="first"), "a" * 24000)
        self.finish(self.send(text="Second", key="second"), "b" * 24000)
        self.finish(self.send(text="Third", key="third"), "c" * 24000)
        sent = self.send(key="fourth")
        context = self.raw(sent)["conversation"]
        self.assertEqual(len(context["history"]), 2)
        self.assertEqual(context["history"][1]["content"], "c" * 24000)
        self.assertEqual(context["history_omitted_count"], 0)
        self.assertEqual(context["continuity"]["state"]["messages"], 6)
        self.assertEqual(context["continuity"]["state"]["strategy"], "mechanical")
        self.assertEqual(len(pip_chat.list_messages(self.store, self.job["id"], limit=50)["messages"]), 7)

    def test_corrupt_stored_message_is_refused_before_text_fetch(self):
        self.setup_job()
        self.send()
        self.registry.db.execute("UPDATE pip_chat_messages SET text=?", ("x" * (pip_chat.MAX_REPLY_BYTES + 1),))
        with self.assertRaisesRegex(RegistryError, "bounded archive"):
            pip_chat.list_messages(self.store, self.job["id"])


if __name__ == "__main__":
    unittest.main()
