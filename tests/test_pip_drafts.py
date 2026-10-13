"""Offline Quill contract, private artifact and native policy integration checks."""
from __future__ import annotations

import copy
import hashlib
import io
import json
import os
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

from dgc import pip_drafts as drafts, pip_types, pips
from dgc.llm import ChatResult, LLMClient, ToolCall
from dgc.workspace_registry import RegistryError
from tests import test_pips_local as fixtures


class DraftTests(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp
    git = fixtures.LocalPipsTests.git
    commit = fixtures.LocalPipsTests.commit

    def body(self):
        return {"title": "Greeting helper", "summary": "Drafted from the committed helper.",
                "markdown": "# Greeting helper\n\n`hello()` returns the greeting.\n\nSource: `source.py:1`.\n",
                "citations": [{"path": "source.py", "line": 1, "excerpt": "def hello():\n    return 'hello'"}]}

    def create(self):
        return self.store.create(self.workspace["id"], "Docs", "Explain the source helper.", "user", pip_type="quill")

    def queued(self):
        job = self.create()
        run = self.store.enqueue(job["id"], "draft-request", "user", self.cfg)
        manifest = json.loads(self.registry.db.execute("SELECT manifest FROM pip_runs WHERE id=?", (run["id"],)).fetchone()[0])
        return job, run, manifest

    def worker_result(self):
        value = drafts.parse_reply(json.dumps(self.body()), self.root, read_calls=1)
        value.update(usage={"requests": 1}, tools_called=1)
        return value

    def complete_result(self):
        value = self.worker_result()
        value["snapshot"] = {"sha256": "a" * 64, "files": 1, "bytes": 32}
        return value

    def run_directory(self):
        path = self.base / "run"
        path.mkdir(mode=0o700)
        return path

    def test_catalog_and_queue_pin_distinct_draft_without_checkpoint(self):
        self.commit()
        job, run, manifest = self.queued()
        self.assertTrue(pip_types.require_type("quill").available)
        self.assertEqual(pip_types.require_type("quill").engine, "documentation_draft")
        self.assertEqual(manifest["run_kind"], "draft")
        self.assertEqual(manifest["tools"], sorted(pips.READ_TOOLS))
        self.assertEqual(manifest["policy"], "read_only")
        self.assertNotIn("audit_checkpoint", manifest)
        self.assertEqual(self.store.get(job["id"])["active_run"]["run_kind"], "draft")
        self.assertEqual(self.store.get(job["id"])["latest_run"]["manifest"]["run_kind"], "draft")
        proposal = self.store.propose(job["id"], 1, {"goal": "Explain all helper inputs."}, "user")
        self.assertEqual(self.store.accept(job["id"], proposal["id"], 1, "user")["pip_type"], "quill")
        self.assertEqual(self.store.run(run["id"])["manifest"]["job"]["goal"], "Explain the source helper.")

    def test_schedule_requires_review_and_handoff_queueing_fails_before_source_or_model(self):
        job = self.create()
        proposal = self.store.propose(job["id"], 1, {"schedule": {"type": "interval", "minutes": 30}}, "user")
        self.assertEqual(proposal['status'], 'proposed')
        self.assertIsNone(self.store.get(job['id'])['schedule'])
        with patch.object(pips, "source_revision", side_effect=AssertionError("no source work")):
            with self.assertRaises(RegistryError) as caught:
                self.store.enqueue(job["id"], "handoff", "user", self.cfg, handoff={"run_id": "run_fake"})
            self.assertEqual(caught.exception.code, "manual_only")
        from dgc.pip_execution import validate_action
        with self.assertRaises(RegistryError):
            validate_action("quill", {"kind": "read_only"})

    def test_wrong_role_run_kind_refused_before_agent(self):
        self.commit(); _, _, manifest = self.queued()
        for kind in ("audit", "patch", "test"):
            invalid = {**manifest, "run_kind": kind}
            with patch("dgc.agent.Agent.__init__", side_effect=AssertionError("no model")), self.assertRaises(RegistryError):
                pips.execute_native(self.cfg, self.root, invalid, lambda event: None)
        invalid = {**manifest, **pip_types.role_pin("rook"), "job": {**manifest["job"], "pip_type": "rook"}}
        with patch("dgc.agent.Agent.__init__", side_effect=AssertionError("no model")), self.assertRaises(RegistryError):
            pips.execute_native(self.cfg, self.root, invalid, lambda event: None)

    def test_exact_citation_and_model_authored_classification(self):
        self.commit()
        result = drafts.parse_reply(json.dumps(self.body()), self.root, read_calls=1)
        self.assertEqual(result["draft"]["citations"][0]["verification"], "source_excerpt_only")
        self.assertFalse(result["tests_executed"])
        self.assertEqual(result["verification"], drafts.VERIFICATION)
        self.assertNotIn("findings", result)
        self.assertNotIn("artifact", result["draft"])

    def test_a_fenced_or_prefaced_draft_is_unwrapped_and_checked_as_strictly(self):
        """A flash model fenced its JSON and the whole Quill run failed (overnight battle, 2026-10-13). parse_reply still
        parses once, strictly; finish() takes the one object out of a fence or a sentence and parses THAT strictly --
        every citation checked again. No model rewrites it, so a citation that doesn't hold can't be dropped to pass."""
        self.commit()
        good = json.dumps(self.body())
        for wrapped in ("```json\n" + good + "\n```", "```\n" + good + "\n```", "Here is the draft:\n" + good,
                        good + "\nThat's all."):
            with self.subTest(start=wrapped[:12]):
                result = drafts.finish(wrapped, self.root, 1)
                self.assertEqual((result["title"], result["draft"]["citations"][0]["path"]), ("Greeting helper", "source.py"))
        bad = self.body()
        bad["citations"][0]["excerpt"] = "def goodbye():"
        with self.assertRaises(RegistryError) as caught:
            drafts.finish("```json\n" + json.dumps(bad) + "\n```", self.root, 1)
        self.assertEqual(caught.exception.code, "unverified_draft", "fenced or not, a citation that doesn't hold is said")
        for broken in (good + good, "PRIVATE no json at all", "\ud800 not json", '{"title": "PRIVATE"'):
            with self.subTest(broken=broken[:10]), self.assertRaises(RegistryError) as caught:
                drafts.finish(broken, self.root, 1)
            self.assertEqual(caught.exception.code, "invalid_draft")
            self.assertNotIn("PRIVATE", str(caught.exception))

    def test_json_bounds_before_decode_and_unicode_invalid(self):
        self.commit()
        for text in ("x" * (drafts.MAX_REPLY_BYTES + 1), "\ud800", "é" * drafts.MAX_REPLY_BYTES):
            with patch.object(drafts.json, "loads", side_effect=AssertionError("must refuse before allocation")), self.assertRaises(RegistryError):
                drafts.parse_reply(text, self.root, read_calls=1)
        for text in ("PRIVATE_BAD_REPLY", "[" * 1200, '{"title":NaN}', '{"title":"a","title":"b"}', 'null', '[]'):
            with self.assertRaises(RegistryError) as caught:
                drafts.parse_reply(text, self.root, read_calls=1)
            self.assertNotIn("PRIVATE_BAD_REPLY", str(caught.exception))
        with self.assertRaises(RegistryError):
            drafts.parse_reply(json.dumps(self.body()), self.root, read_calls=0)

    def test_body_fields_strict_and_sizes_are_utf8_bytes(self):
        self.commit()
        cases = [{"markdown": "x" * (drafts.MAX_MARKDOWN_BYTES + 1)}, {"markdown": "é" * 13000},
                 {"summary": "x" * 2001}, {"title": "x" * 161}, {"title": "two\nlines"},
                 {"markdown": "bad\x1b[31m"}, {"markdown": "\ud800"}, {"citations": []},
                 {"citations": self.body()["citations"] * 17}, {"findings": []}, {"tests_executed": True}]
        for changed in cases:
            with self.subTest(fields=list(changed)), self.assertRaises(RegistryError):
                drafts.parse_reply(json.dumps({**self.body(), **changed}), self.root, read_calls=1)
        okay = self.body(); okay["markdown"] = "x" * drafts.MAX_MARKDOWN_BYTES
        self.assertEqual(len(drafts.parse_reply(json.dumps(okay), self.root, read_calls=1)["draft"]["markdown"]), drafts.MAX_MARKDOWN_BYTES)

    def test_citation_traversal_links_line_count_and_exact_excerpt(self):
        self.commit()
        (self.root / "link.py").symlink_to(self.root / "source.py")
        (self.root / "linked").symlink_to(self.root, target_is_directory=True)
        modifications = [{"path": value} for value in ("../outside", "/etc/passwd", "./source.py", "a//b", "a\\b", ".git/config", "file:x", "source.py\n", "link.py", "linked/source.py")]
        modifications += [{"line": value} for value in (0, True, 100001, 1.5, 3)]
        modifications += [{"excerpt": "PRIVATE_MISMATCH"}, {"excerpt": "1\tdef hello():"}, {"extra": "bad"},
                          {"excerpt": "x" * 1001}, {"excerpt": "\n".join(["x"] * 9)}]
        for changed in modifications:
            value = self.body(); value["citations"] = [{**value["citations"][0], **changed}]
            with self.subTest(changed=changed), self.assertRaises(RegistryError) as caught:
                drafts.parse_reply(json.dumps(value), self.root, read_calls=1)
            self.assertNotIn("PRIVATE_MISMATCH", str(caught.exception))

    def test_oversize_and_overlong_source_lines_refused_before_large_read(self):
        self.commit()
        with (self.root / "source.py").open("wb") as stream:
            stream.truncate(drafts.MAX_SOURCE_BYTES + 1)
        with self.assertRaises(RegistryError):
            drafts.parse_reply(json.dumps(self.body()), self.root, read_calls=1)
        (self.root / "source.py").write_text("x" * (drafts.MAX_SOURCE_LINE_BYTES + 1))
        with self.assertRaises(RegistryError):
            drafts.parse_reply(json.dumps(self.body()), self.root, read_calls=1)
        (self.root / "source.py").unlink(); os.mkfifo(self.root / "source.py", 0o600)
        with self.assertRaises(RegistryError):
            drafts.parse_reply(json.dumps(self.body()), self.root, read_calls=1)

    def test_private_artifact_exact_hash_and_no_workspace_write(self):
        self.commit(); original = (self.root / "source.py").read_bytes()
        root = self.run_directory()
        value = drafts.publish(self.complete_result(), self.root, root)
        artifact = root / drafts.ARTIFACT_PATH
        self.assertEqual(artifact.stat().st_mode & 0o777, 0o600)
        self.assertEqual(value["draft"]["artifact"]["sha256"], hashlib.sha256(artifact.read_bytes()).hexdigest())
        self.assertEqual(value["draft"]["artifact"]["bytes"], len(artifact.read_bytes()))
        self.assertEqual(drafts.validate_saved(value, root), value)
        self.assertEqual((self.root / "source.py").read_bytes(), original)
        self.assertFalse((self.root / "documentation.md").exists())

    def test_unverified_body_and_bad_result_refused_before_artifact_directory(self):
        self.commit(); root = self.run_directory()
        for field, bad in (("verification", "Everything verified"), ("tests_executed", True), ("tools_called", True),
                           ("usage", {"requests": -1}), ("snapshot", {"sha256": "invalid"})):
            value = self.complete_result(); value[field] = bad
            with self.assertRaises(RegistryError): drafts.publish(value, self.root, root)
            self.assertFalse((root / "artifacts").exists())
        value = self.complete_result(); value["draft"]["citations"][0]["excerpt"] = "not source"
        with self.assertRaises(RegistryError): drafts.publish(value, self.root, root)
        self.assertFalse((root / "artifacts").exists())

    def test_existing_artifacts_links_and_public_run_directory_refused(self):
        self.commit(); root = self.run_directory()
        root.chmod(0o755)
        with self.assertRaises(RegistryError): drafts.publish(self.complete_result(), self.root, root)
        root.chmod(0o700)
        (root / "artifacts").symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(RegistryError): drafts.publish(self.complete_result(), self.root, root)
        self.assertFalse((self.root / "documentation.md").exists())
        (root / "artifacts").unlink(); (root / "artifacts").mkdir()
        with self.assertRaises(RegistryError): drafts.publish(self.complete_result(), self.root, root)

    def test_finish_rejects_changed_artifact_hash_link_or_permissions(self):
        self.commit(); root = self.run_directory()
        result = drafts.publish(self.complete_result(), self.root, root)
        path = root / drafts.ARTIFACT_PATH
        path.write_text("altered")
        with self.assertRaises(RegistryError): drafts.validate_saved(result, root)
        path.unlink(); path.symlink_to(self.root / "source.py")
        with self.assertRaises(RegistryError): drafts.validate_saved(result, root)
        path.unlink(); path.write_text(result["draft"]["markdown"]); path.chmod(0o644)
        with self.assertRaises(RegistryError): drafts.validate_saved(result, root)

    def test_redacted_excerpts_validated_against_redacted_source_before_publication(self):
        self.commit()
        (self.root / "source.py").write_text('TOKEN = "local-sensitive-token"\n')
        body = self.body(); body["citations"][0]["excerpt"] = 'TOKEN = "local-sensitive-token"'
        body["markdown"] = "The token is local-sensitive-token."
        result = drafts.parse_reply(json.dumps(body), self.root, read_calls=1)
        result.update(usage={}, tools_called=1, snapshot={"sha256": "a" * 64, "files": 1, "bytes": 32})
        from dgc.redaction import redact_value
        result = redact_value(result, ["local-sensitive-token"])
        root = self.run_directory()
        saved = drafts.publish(result, self.root, root, secrets=["local-sensitive-token"])
        self.assertNotIn("local-sensitive-token", (root / drafts.ARTIFACT_PATH).read_text())
        self.assertNotIn("local-sensitive-token", json.dumps(saved))

    def test_real_agent_uses_draft_prompt_and_read_only_tools_without_network(self):
        self.commit(); _, _, manifest = self.queued()
        replies = iter([ChatResult(tool_calls=[ToolCall("read", "read_file", {"path": "source.py"})]),
                        ChatResult(content=json.dumps(self.body()))])
        seen = []
        def chat(client, messages, tools=None, on_text=None, **kwargs):
            seen.append(copy.deepcopy(messages))
            self.assertTrue({t["function"]["name"] for t in tools} <= pips.READ_TOOLS)
            value = next(replies)
            if value.content and on_text: on_text(value.content)
            return value
        with patch.dict(os.environ, {"DGC_SESSION_POLICY": pips._json(pips.native_policy())}), \
             patch.object(LLMClient, "chat", chat), patch("dgc.agent.discover_skills", return_value={}), \
             patch("dgc.agent.load_memories", side_effect=AssertionError("No ambient instructions")), \
             patch("requests.sessions.Session.request", side_effect=AssertionError("No network")):
            result = pips.execute_native(self.cfg, self.root, manifest, lambda event: None)
        self.assertIn(drafts.SYSTEM, seen[0][0]["content"])
        self.assertNotIn(pips.AUDIT_SYSTEM_INSTRUCTIONS, seen[0][0]["content"])
        self.assertEqual(result["draft"]["markdown"], self.body()["markdown"])
        self.assertEqual(result["tools_called"], 1)

    def test_controller_publishes_and_finishes_only_validated_draft(self):
        self.commit(); job, run, manifest = self.queued()
        row = self.store.claim_next()
        result = self.worker_result()
        events = [{"kind": "policy_ready", "digest": manifest["policy_digest"]}, {"kind": "result", "result": result}]
        process = Mock(stdin=io.BytesIO(), stdout=io.BytesIO(b"".join((json.dumps(e)+"\n").encode() for e in events)))
        process.wait.return_value = 0; process.poll.return_value = 0
        real_popen = pips.subprocess.Popen
        def popen(argv, **kwargs):
            return process if argv[1:3] == ["-m", "dgc.pips"] else real_popen(argv, **kwargs)
        with patch.object(pips.subprocess, "Popen", side_effect=popen), patch.object(pips.threading, "Timer", return_value=Mock()), patch.object(pips.threading, "Thread", return_value=Mock()):
            final = pips._execute_run(self.registry, row, self.cfg)
        finished = self.store.finish(run["id"], result=final)
        self.assertEqual(finished["status"], "succeeded")
        self.assertEqual(finished["manifest"]["run_kind"], "draft")
        self.assertEqual(finished["result"]["draft"]["artifact"]["path"], drafts.ARTIFACT_PATH)
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM pip_checkpoints").fetchone()[0], 0)

    def completed(self, body=None):
        self.commit(); job, run, manifest = self.queued(); self.store.claim_next()
        result = drafts.parse_reply(json.dumps(body or self.body()), self.root, read_calls=1)
        result.update(usage={}, tools_called=1, snapshot={"sha256": "a" * 64, "files": 1, "bytes": 32})
        directory = self.registry.directory / "runs" / run["id"]
        directory.mkdir(mode=0o700, parents=True)
        saved = drafts.publish(result, self.root, directory)
        return job, self.store.finish(run["id"], result=saved)

    def test_main_context_pages_entire_markdown_and_citations_with_identity(self):
        from dgc import pip_context_tool
        from types import SimpleNamespace
        body = self.body(); body["markdown"] = "界\"\n" * 3500
        body["citations"] *= 8
        job, run = self.completed(body)
        pages, citations, cursor = [], [], 0
        with patch.object(pip_context_tool, "WorkspaceRegistry", lambda: type(self.registry)(self.registry.directory)):
            for _ in range(20):
                raw = pip_context_tool.read({"action": "draft", "run_id": run["id"], "offset": cursor},
                                           SimpleNamespace(config=self.cfg, project_root=self.root))
                self.assertLessEqual(len(raw.encode()), pip_context_tool.MAX_OUTPUT_BYTES)
                value = json.loads(raw)
                self.assertEqual(value["run"]["run_kind"], "draft")
                self.assertEqual(value["run"]["source_revision"], run["manifest"]["source_revision"])
                pages.append(value["markdown_page"]); citations += value["citations"]
                cursor = value["next_offset"]
                if cursor is None: break
        self.assertIsNone(cursor)
        self.assertEqual("".join(pages), body["markdown"])
        self.assertEqual(len(citations), 8)
        other = self.base / "other"; other.mkdir(); workspace = self.registry.resolve(other)
        with patch.object(drafts.json, "loads", side_effect=AssertionError("Do not decode foreign data")):
            with self.assertRaises(RegistryError) as caught:
                drafts.stored(self.registry, workspace["id"], run["id"])
        self.assertEqual(caught.exception.code, "not_found")

    def test_stored_draft_corrupt_identity_oversize_and_wrong_kind_refuse(self):
        _, run = self.completed()
        # Corrupt-storage fixture: the production writer correctly makes pins immutable.
        self.registry.db.execute("DROP TRIGGER immutable_run_manifest")
        raw = self.registry.db.execute("SELECT manifest FROM pip_runs WHERE id=?", (run["id"],)).fetchone()[0]
        manifest = json.loads(raw)
        for changes in ({"workspace_id": "other"}, {"pip_id": "other"}, {"run_kind": "audit"}, {"job_version": True}):
            self.registry.db.execute("UPDATE pip_runs SET manifest=? WHERE id=?", (json.dumps({**manifest, **changes}), run["id"]))
            with self.assertRaises(RegistryError): drafts.stored(self.registry, self.workspace["id"], run["id"])
        self.registry.db.execute("UPDATE pip_runs SET manifest=?,result=? WHERE id=?", (raw, "x" * (drafts.MAX_RESULT_BYTES + 1), run["id"]))
        with patch.object(drafts.json, "loads", side_effect=AssertionError("No oversize decode")), self.assertRaises(RegistryError):
            drafts.stored(self.registry, self.workspace["id"], run["id"])

    def test_quill_chat_after_success_has_historical_bounded_draft_not_findings(self):
        from dgc import pip_chat
        body = self.body(); body["markdown"] = "Draft source discussion. " * 800
        job, run = self.completed(body)
        value = pip_chat.send(self.store, job["id"], "Explain your draft", "after-draft", "user", self.cfg)
        manifest = json.loads(self.registry.db.execute("SELECT manifest FROM pip_runs WHERE id=?", (value["run"]["id"],)).fetchone()[0])
        reference = manifest["conversation"]["last_report"]
        self.assertEqual(reference["classification"], "model_authored_draft")
        self.assertEqual(reference["run_id"], run["id"])
        self.assertTrue(reference["markdown_truncated"])
        self.assertLessEqual(len(json.dumps(reference).encode()), 8192)
        self.assertNotIn("findings", reference)
        pip_chat.validate_context(manifest["conversation"])

    def test_model_write_and_shell_attempts_denied_even_auto_with_allow_all(self):
        self.commit(); _, _, manifest = self.queued()
        original = (self.root / "source.py").read_bytes()
        self.cfg.set("mode", "auto", persist=False)
        self.cfg.permissions["allow"] = ["*"]
        replies = iter([
            ChatResult(tool_calls=[ToolCall("badwrite", "write_file", {"path": "source.py", "content": "tampered"}),
                                   ToolCall("badshell", "bash", {"command": "touch forbidden"})]),
            ChatResult(tool_calls=[ToolCall("read", "read_file", {"path": "source.py"})]),
            ChatResult(content=json.dumps(self.body()))])
        def chat(client, messages, tools=None, on_text=None, **kwargs):
            result = next(replies)
            if result.content and on_text: on_text(result.content)
            return result
        events = []
        with patch.dict(os.environ, {"DGC_SESSION_POLICY": pips._json(pips.native_policy())}), \
             patch.object(LLMClient, "chat", chat), patch("dgc.agent.discover_skills", return_value={}), \
             patch("requests.sessions.Session.request", side_effect=AssertionError("No network")):
            result = pips.execute_native(self.cfg, self.root, manifest, events.append)
        self.assertEqual((self.root / "source.py").read_bytes(), original)
        self.assertFalse((self.root / "forbidden").exists())
        self.assertTrue({"write_file", "bash"} <= {event["tool"] for event in events if event["kind"] == "tool_denied"})
        self.assertEqual(result["verification"], drafts.VERIFICATION)

    def test_cancelled_draft_never_persists_successful_result(self):
        self.commit(); _, run, _ = self.queued(); self.store.claim_next()
        self.store.cancel(run["id"], "user")
        cancelled = self.store.finish(run["id"], result={"draft": "fake partial"})
        self.assertEqual(cancelled["status"], "cancelled")
        self.assertIsNone(cancelled["result"])

    def test_quill_conversation_remains_real_chat_while_paused(self):
        self.commit(); job = self.create(); self.store.set_paused(job["id"], True, "user")
        from dgc import pip_chat
        value = pip_chat.send(self.store, job["id"], "Discuss the documentation goal.", "chat-key", "user", self.cfg)
        run = value.get("run", value)
        if "manifest" not in run:
            run = self.store.run(value["run_id"])
        self.assertEqual(run["manifest"]["run_kind"], "conversation")
        self.assertEqual(run["manifest"]["tools"], sorted(pips.READ_TOOLS))


if __name__ == "__main__":
    unittest.main()
