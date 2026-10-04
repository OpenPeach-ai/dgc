"""Local product commands, with deterministic offline CLI/worker subprocess coverage."""
from __future__ import annotations

import contextlib
import io
import json
import os
import selectors
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from dgc import pip_cli, pip_daemon, pips
from dgc.scheduler import named_process_lock
from dgc.workspace_registry import WorkspaceRegistry, state_directory
from tests.test_pips_local import config


CLI_BOOTSTRAP = '''
import sys
from unittest.mock import patch
from dgc.cli import main
from dgc.workspace_registry import WorkspaceRegistry
original_init = WorkspaceRegistry.__init__
def registry_init(self, *args, **kwargs):
    kwargs.setdefault("clock", lambda: "2026-10-01T10:00:00.000Z")
    original_init(self, *args, **kwargs)
with patch.object(WorkspaceRegistry, "__init__", registry_init), \\
     patch("requests.sessions.Session.request", side_effect=AssertionError("No network in CLI fixture")):
    raise SystemExit(main(sys.argv[1:]))
'''

WORKER_FIXTURE = '''
import json
from unittest.mock import patch
from dgc.llm import LLMClient, ChatResult, ToolCall
from dgc.pips import _worker_main
responses = iter([
    ChatResult(tool_calls=[ToolCall("read1", "read_file", {"path":"source.py"})]),
    ChatResult(content=json.dumps({"summary":"Inspected committed source through the CLI", "findings":[],
                                 "limitations":["Static inspection only"]}))
])
def chat(self, messages, tools=None, on_text=None, **kwargs):
    result = next(responses)
    if result.content and on_text:
        on_text(result.content)
    return result
with patch.object(LLMClient,"chat",chat), patch("requests.sessions.Session.request",side_effect=AssertionError("No network")):
    raise SystemExit(_worker_main())
'''


class PipCliTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="dgc-pip-cli-")
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.root = self.base / "repo"
        self.root.mkdir()
        self.home = self.base / "home"
        self.home.mkdir()
        env = patch.dict(os.environ, {"HOME": str(self.home), "DGC_HOME": str(self.home)})
        env.start(); self.addCleanup(env.stop)
        network = patch("requests.sessions.Session.request", side_effect=AssertionError("No network in CLI tests"))
        network.start(); self.addCleanup(network.stop)
        original_init = WorkspaceRegistry.__init__
        def registry_init(registry, *args, **kwargs):
            kwargs.setdefault("clock", lambda: "2026-10-01T10:00:00.000Z")
            original_init(registry, *args, **kwargs)
        clock = patch.object(WorkspaceRegistry, "__init__", registry_init)
        clock.start(); self.addCleanup(clock.stop)
        self.cfg = config(self.root)
        self.registry = WorkspaceRegistry()
        self.addCleanup(self.registry.close)
        self.store = pips.PipStore(self.registry)
        self.workspace = self.registry.resolve(self.root)

    def invoke(self, *args, expected=0, **kwargs):
        with contextlib.redirect_stdout(io.StringIO()) as output, contextlib.redirect_stderr(io.StringIO()) as error:
            code = pip_cli.handle_command(self.cfg, list(args), **kwargs)
        self.assertEqual(code, expected, output.getvalue() + error.getvalue())
        return output.getvalue(), error.getvalue()

    def value(self, *args, expected=0):
        output, error = self.invoke(*args, "--json", expected=expected)
        return json.loads(output if expected == 0 else error)

    def create(self, name="Auditor"):
        return self.value("create", name, "--goal", "Inspect committed source")['pip']

    def git(self, *args):
        return subprocess.run(["git", "-c", "user.name=DGC Fixture", "-c", "user.email=fixture@invalid",
                               "-c", "core.hooksPath=" + os.devnull, *args], cwd=self.root,
                              env={**pips._git_env(), "GIT_AUTHOR_DATE": "2020-01-01T00:00:00+0000",
                                   "GIT_COMMITTER_DATE": "2020-01-01T00:00:00+0000"},
                              check=True, capture_output=True, text=True).stdout.strip()

    def commit(self):
        self.git("init", "-q")
        (self.root / "source.py").write_text("def hello():\n    return 'hello'\n", encoding="utf-8")
        self.git("add", "source.py")
        self.git("commit", "-qm", "fixture")
        return self.git("rev-parse", "HEAD")

    def heartbeat(self):
        pip_daemon._write(self.registry, pip_daemon.SUPERVISOR_KEY,
                         {"schema_version": 1, "status": "running", "instance_id": "fixture",
                          "heartbeat_at": self.registry.clock(), "started_at": self.registry.clock()})

    def hold_supervisor(self):
        self.heartbeat()
        lease = named_process_lock("pips-supervisor", str(state_directory()))
        self.assertTrue(lease.acquire(blocking=False))
        self.addCleanup(lease.release)
        return lease

    def test_disabled_explains_local_opt_in_without_opening_registry(self):
        self.cfg.set("pips_enabled", False, persist=False)
        with patch.object(pips, "WorkspaceRegistry", side_effect=AssertionError("Disabled must not open state")):
            error = self.value("list", expected=1)["error"]
        self.assertEqual(error["code"], "disabled")
        self.assertIn("dgc pips enable", error["message"])

    def test_enable_uses_existing_save_path_and_does_not_clear_stop(self):
        pip_daemon.stop_all(self.cfg, "fixture")
        with patch.object(self.cfg, "set", wraps=self.cfg.set) as save, patch.object(pips, "start_queued") as start:
            self.assertTrue(self.value("enable")["enabled"])
        save.assert_called_once_with("pips_enabled", True)
        start.assert_not_called()
        self.assertTrue(pip_daemon.is_runtime_paused(self.registry))

    def test_create_list_show_workspace_scope_and_no_worker(self):
        with patch.object(pips, "start_queued", side_effect=AssertionError("CLI must not launch transient workers")):
            job = self.create()
            self.assertEqual(self.value("list")["pips"][0]["id"], job["id"])
            self.assertEqual(self.value("show", job["id"])["pip"]["goal"], "Inspect committed source")
            other = self.base / "other"; other.mkdir()
            self.cfg.project_root = other
            self.assertEqual(self.value("list")["pips"], [])
            self.assertEqual(self.value("list", "--workspace", self.workspace["id"])["pips"][0]["id"], job["id"])

    def test_type_directory_and_explicit_creation_are_available_in_cli(self):
        directory = self.value("types")["types"]
        self.assertEqual(len(directory), 8)
        self.assertEqual({item["id"] for item in directory if item["available"]}, {"scout", "lens", "rook", "lock", "patch", "pulse", "quill"})
        job = self.value("create", "Researcher", "--type", "lens", "--goal", "Trace configuration")['pip']
        self.assertEqual(job["pip_type"], "lens")
        self.assertIn("Type: lens", self.invoke("show", job["id"])[0])
        denied = self.value("create", "Fixer", "--type", "patch", "--goal", "Write files", expected=1)
        self.assertEqual(denied["error"]["code"], "confirmation_required")
        fixer = self.value("create", "Fixer", "--type", "patch", "--goal", "Review fixes", "--reviewed-execution")["pip"]
        self.assertEqual(fixer["policy"], "review_required")
        self.assertEqual(self.create()["pip_type"], "rook")

    def test_run_refuses_offline_or_unheld_fresh_heartbeat_before_enqueue(self):
        job = self.create()
        with patch.object(pips.PipStore, "enqueue", side_effect=AssertionError("Do not enqueue without supervisor")):
            self.assertEqual(self.value("run", job["id"], expected=1)["error"]["code"], "runner_offline")
            self.heartbeat()
            self.assertEqual(self.value("run", job["id"], expected=1)["error"]["code"], "runner_offline")
        self.assertEqual(self.store.runs(job["id"]), [])

    def test_run_fails_closed_if_lease_backend_errors(self):
        self.heartbeat()
        lease = Mock(last_error="PermissionError fixture")
        lease.acquire.return_value = False
        with patch("dgc.scheduler.named_process_lock", return_value=lease):
            self.assertEqual(self.value("run", "missing", expected=1)["error"]["code"], "runner_unavailable")

    def test_queue_is_idempotent_and_never_launches_a_transient_worker(self):
        self.commit(); self.hold_supervisor(); job = self.create()
        with patch.object(pips, "start_queued", side_effect=AssertionError("A CLI process must not own a transient thread")):
            first = self.value("run", job["id"], "--idempotency-key", "same-request")["run"]
            second = self.value("run", job["id"], "--idempotency-key", "same-request")["run"]
            self.assertEqual(first["id"], second["id"])
            self.assertEqual(first["status"], "queued")
            self.assertEqual(len(self.value("runs", job["id"])["runs"]), 1)
            self.assertEqual(self.value("cancel", first["id"])["run"]["status"], "cancelled")

    def test_proposals_require_explicit_review_and_cas_versions(self):
        job = self.create()
        proposal = self.value("propose", job["id"], "--goal", "Review permissions", "--expected-version", "1")["proposal"]
        self.assertEqual(self.value("show", job["id"])["pip"]["goal"], job["goal"])
        shown, _ = self.invoke("show", job["id"])
        self.assertIn(proposal["id"], shown)
        changed = self.value("accept", job["id"], proposal["id"], "--expected-version", "1")["pip"]
        self.assertEqual(changed["current_version"], 2)
        stale = self.value("propose", job["id"], "--goal", "Stale", "--expected-version", "1", expected=1)
        self.assertEqual(stale["error"]["code"], "conflict")
        next_proposal = self.value("propose", job["id"], "--name", "Rejected", "--expected-version", "2")["proposal"]
        self.value("reject", job["id"], next_proposal["id"], "--expected-version", "2")
        self.assertEqual(self.value("show", job["id"])["pip"]["name"], "Auditor")
        self.assertEqual(len(self.value("versions", job["id"])["versions"]), 2)
        self.value("propose", job["id"], "--expected-version", "2", expected=1)

    def test_schedule_cli_saves_review_then_requires_accept_to_arm(self):
        job = self.value("create", "Scheduled auditor", "--goal", "Inspect source")["pip"]
        proposal = self.value("schedule", job["id"], "--daily", "09:00", "--timezone", "Asia/Kolkata", "--expected-version", "1")["proposal"]
        self.assertIsNone(self.value("show", job["id"])["pip"]["schedule"])
        history = self.value("approvals", job["id"])["approvals"]
        self.assertEqual(history[0]["status"], "pending")
        self.assertEqual(history[0]["action_type"], "schedule_update")
        accepted = self.value("accept", job["id"], proposal["id"], "--expected-version", "1")["pip"]
        self.assertEqual(accepted["schedule_state"]["next_due_at"], "2026-10-02T03:30:00.000Z")
        disabled = self.value("schedule", job["id"], "--manual", "--expected-version", "2")["proposal"]
        self.value("accept", job["id"], disabled["id"], "--expected-version", "2")
        self.assertIsNone(self.value("show", job["id"])["pip"]["schedule_state"])

    def test_schedule_cli_rejects_ambiguous_zone_and_invalid_interval(self):
        job = self.value("create", "Schedule inputs", "--goal", "Inspect source")["pip"]
        for args in (("--daily", "09:00"), ("--every", "60", "--timezone", "UTC"), ("--every", "0")):
            with self.subTest(args=args):
                result = self.value("schedule", job["id"], *args, "--expected-version", "1", expected=1)
                self.assertEqual(result["error"]["code"], "invalid_schedule")

    def test_context_records_are_explicit_and_revision_checked(self):
        self.assertEqual(self.value("context", "list")["context"]["revision"], 0)
        result = self.value("context", "record", "decision", "--title", "Source policy", "--content",
                            "Use committed source", "--expected-revision", "0")["context"]
        entry = result["entries"][0]
        self.assertEqual(result["revision"], 1)
        self.assertEqual(entry["kind"], "decision")
        error = self.value("context", "archive", entry["id"], "--expected-revision", "0", expected=1)
        self.assertEqual(error["error"]["code"], "context_conflict")
        archived = self.value("context", "archive", entry["id"], "--expected-revision", "1")["context"]
        self.assertEqual(archived["revision"], 2)
        self.assertEqual(archived["entries"], [])
        self.assertTrue(self.value("activity")["events"])

    def test_accept_finding_preserves_model_assessment_provenance(self):
        self.commit(); job = self.create()
        run = self.store.enqueue(job["id"], "fixture", "local-console", self.cfg)
        self.store.claim_next()
        finding = {"title": "Review return", "severity": "low", "path": "source.py", "line": 2,
                   "evidence": "return 'hello'", "verification": "source_excerpt_only"}
        self.store.finish(run["id"], result={"summary": "Review", "findings": [finding], "limitations": [], "tests_executed": False, "verification": 'Source excerpts checked against the pinned snapshot; findings are model assessments.'})
        output, _ = self.invoke("report", run["id"])
        self.assertIn("Finding 0", output)
        self.assertIn("Tests were not executed", output)
        accepted = self.value("context", "accept-finding", run["id"], "0", "--expected-revision", "0")["context"]
        provenance = accepted["entries"][0]["provenance"]
        self.assertEqual(provenance["classification"], "model_assessment")
        self.assertEqual(provenance["run_id"], run["id"])
        self.assertEqual(provenance["source_revision"], run["manifest"]["source_revision"])

    def handoff_fixture(self):
        self.commit()
        source = self.create("Source reviewer")
        target = self.create("Recipient reviewer")
        run = self.store.enqueue(source["id"], "handoff-fixture", "local-console", self.cfg)
        self.store.claim_next()
        finding = {"title": "Review return", "severity": "low", "path": "source.py", "line": 2,
                   "evidence": "return 'hello'", "verification": "source_excerpt_only"}
        self.store.finish(run["id"], result={"summary": "Review", "findings": [finding], "limitations": [],
                         "tests_executed": False, "verification": "Source excerpts checked against the pinned snapshot; findings are model assessments."})
        return source, target, run

    def propose_handoff(self, run, target, *flags):
        return self.value("handoff", "propose", run["id"], "0", target["id"],
                          "--task", "Inspect the return boundary", "--action-json", '{"kind":"read_only"}',
                          "--idempotency-key", "cli-handoff-fixture", *flags)["handoff"]

    def test_handoff_proposal_review_and_history_do_not_dispatch(self):
        source, target, run = self.handoff_fixture()
        with patch.object(pips, "start_queued", side_effect=AssertionError("No transient worker")):
            first = self.propose_handoff(run, target)
            second = self.propose_handoff(run, target)
        self.assertEqual(first["id"], second["id"])
        self.assertEqual(first["status"], "pending")
        self.assertEqual(self.store.runs(target["id"]), [])
        shown, _ = self.invoke("handoff", "review", first["id"])
        self.assertIn(first["payload_digest"], shown)
        self.assertIn(first["payload"]["source"]["source_revision"], shown)
        self.assertIn('"kind": "read_only"', shown)
        self.assertIn("--expected-revision 0", shown)
        self.assertEqual(self.value("handoff", "list", source["id"])["handoffs"][0]["id"], first["id"])
        self.assertEqual(self.value("handoff", "list", target["id"])["handoffs"][0]["id"], first["id"])

    def test_handoff_accept_requires_live_supervisor_and_exact_revision(self):
        _, target, run = self.handoff_fixture()
        h = self.propose_handoff(run, target)
        self.assertEqual(self.value("handoff", "accept", h["id"], "--expected-revision", "0", "--yes", expected=1)["error"]["code"], "runner_offline")
        self.hold_supervisor()
        self.assertEqual(self.value("handoff", "accept", h["id"], "--expected-revision", "9", "--yes", expected=1)["error"]["code"], "handoff_conflict")
        with patch("sys.stdin.isatty", return_value=False):
            _, err = self.invoke("handoff", "accept", h["id"], "--expected-revision", "0", "--json", expected=1)
        self.assertEqual(json.loads(err.splitlines()[-1])["error"]["code"], "confirmation_required")
        self.assertIn(h["payload_digest"], err)
        self.assertEqual(self.store.runs(target["id"]), [])
        with patch.object(pips, "start_queued", side_effect=AssertionError("Use the existing supervisor")):
            output, err = self.invoke("handoff", "accept", h["id"], "--expected-revision", "0", "--yes", "--json")
        accepted = json.loads(output)
        self.assertIn(h["payload_digest"], err)
        self.assertEqual(accepted["handoff"]["status"], "accepted")
        self.assertEqual(accepted["run"]["status"], "queued")
        self.assertEqual(accepted["run"]["pip_id"], target["id"])
        self.assertEqual(len(self.store.runs(target["id"])), 1)
        repeated = self.value("handoff", "accept", h["id"], "--expected-revision", "0", "--yes")
        self.assertEqual(repeated["run"]["id"], accepted["run"]["id"])
        self.assertEqual(len(self.store.runs(target["id"])), 1)

    def test_execution_outcome_cli_routes_exact_local_decision_without_supervisor(self):
        review = {"run_id": "run-fixture", "status": "accepted", "revision": 1,
                  "result_digest": "a" * 64, "actor": "local-console", "reason": "Reviewed bounded diff",
                  "updated_at": "2026-10-01T12:00:00.000Z"}
        with patch.object(pips, "handle_control", return_value={"ok": True, "result": {"review": review}}) as control, patch.object(pip_cli, "_require_supervisor", side_effect=AssertionError("Outcome review queues no work")):
            self.assertEqual(self.value("review-execution", "run-fixture", "--status", "accepted", "--expected-revision", "0", "--reason", "Reviewed bounded diff")["review"], review)
        request = dict(control.call_args.args[1]); request.pop("request_id")
        self.assertEqual(request, {"type": "review_pip_execution", "run_id": "run-fixture", "status": "accepted", "expected_revision": 0, "reason": "Reviewed bounded diff"})

    def test_handoff_rejection_records_reason_without_supervisor_or_run(self):
        _, target, run = self.handoff_fixture()
        h = self.propose_handoff(run, target)
        result = self.value("handoff", "reject", h["id"], "--expected-revision", "0", "--reason", "Need a narrower scope")
        self.assertEqual(result["handoff"]["status"], "rejected")
        self.assertEqual(result["handoff"]["resolution_reason"], "Need a narrower scope")
        self.assertEqual(self.store.runs(target["id"]), [])

    def test_exact_action_file_and_json_never_split_shell_arguments(self):
        value = {"kind": "test", "tests": [{"argv": ["python3", "-c", 'print("two words")'], "cwd": "."}]}
        path = self.base / "action.json"
        path.write_text(json.dumps(value), encoding="utf-8")
        args = pip_cli.parser().parse_args(["handoff", "propose", "run-x", "0", "pip-y", "--task", "Test", "--action-file", str(path)])
        request = pip_cli._request(args)
        self.assertEqual(request["action"], value)
        self.assertEqual(request["action"]["tests"][0]["argv"][2], 'print("two words")')
        self.assertNotIn("shell", request["action"])
        self.assertEqual(request["type"], "propose_pip_handoff")

    def test_action_json_bounds_precede_read_decode_and_parse(self):
        path = self.base / "oversize.json"
        with path.open("wb") as f:
            f.truncate(pip_cli.MAX_ACTION_JSON_BYTES + 1)
        args = pip_cli.parser().parse_args(["handoff", "propose", "r", "0", "p", "--task", "Test", "--action-file", str(path)])
        with patch.object(pip_cli.os, "open", side_effect=AssertionError("Oversize must fail before open")), patch.object(pip_cli.json, "loads", side_effect=AssertionError("Never parse")):
            with self.assertRaises(pips.RegistryError) as caught:
                pip_cli._read_action_json(args)
        self.assertEqual(caught.exception.code, "action_limit")
        args.action_file = None; args.action_json = "é" * (pip_cli.MAX_ACTION_JSON_BYTES // 2 + 1)
        with patch.object(pip_cli.json, "loads", side_effect=AssertionError("Never parse")):
            with self.assertRaises(pips.RegistryError) as caught:
                pip_cli._read_action_json(args)
        self.assertEqual(caught.exception.code, "action_limit")

    def test_action_json_rejects_duplicates_nonfinite_truncated_and_nonobject(self):
        args = pip_cli.parser().parse_args(["handoff", "propose", "r", "0", "p", "--task", "Test", "--action-json", '{}'])
        for payload in ('{"kind":"patch","kind":"test"}', '{"kind":NaN}', '{"kind":Infinity}', '{"kind":', '[]', '"python -m unittest"', '[' * 2000 + ']' * 2000):
            with self.subTest(payload=payload[:40]):
                args.action_json = payload
                with self.assertRaises(pips.RegistryError):
                    pip_cli._read_action_json(args)

    def test_action_file_rejects_special_inputs_without_opening_them(self):
        path = self.base / "action.json"
        path.write_text('{"kind":"read_only"}', encoding="utf-8")
        candidates = [self.base]
        link = self.base / "action-link"
        try:
            link.symlink_to(path)
            candidates.append(link)
        except (OSError, NotImplementedError):
            pass
        if hasattr(os, "mkfifo"):
            fifo = self.base / "action-pipe"
            os.mkfifo(fifo); candidates.append(fifo)
        for candidate in candidates:
            args = pip_cli.parser().parse_args(["handoff", "propose", "r", "0", "p", "--task", "Test", "--action-file", str(candidate)])
            with self.subTest(path=candidate), patch.object(pip_cli.os, "open", side_effect=AssertionError("Do not open a special input")):
                with self.assertRaises(pips.RegistryError):
                    pip_cli._read_action_json(args)

    def test_execution_capability_and_report_do_not_invent_audit_or_test_success(self):
        capability = {"available": False, "platform": "Darwin", "backend": None,
                      "reason": "Required sandbox unavailable", "network": False, "test_workspace": "read_only",
                      "limits": {"wall_seconds": 60, "cpu_seconds": 30, "memory_bytes": 536870912, "output_bytes": 65536, "processes": 32}}
        with patch.object(pips, "handle_control", return_value={"ok": True, "result": capability}) as control:
            self.assertEqual(self.value("execution"), capability)
        self.assertEqual(control.call_args.args[1]["type"], "get_pip_execution")
        result = {"run": {"id": "run", "pip_id": "patch", "status": "failed", "manifest": {"run_kind": "patch", "job_version": 1, "model": "m", "source_revision": "a" * 40}, "result": None}}
        formatted = pip_cli._format(result)
        self.assertIn("No completed execution evidence", formatted)
        self.assertNotIn("Tests were not executed by this read-only audit", formatted)
        self.assertNotIn("tests passed", formatted)

    def test_global_stop_needs_confirmation_and_resume_leaves_jobs_paused(self):
        job = self.create()
        with patch("sys.stdin.isatty", return_value=False):
            self.assertEqual(self.value("stop", expected=1)["error"]["code"], "confirmation_required")
        self.assertFalse(pip_daemon.is_runtime_paused(self.registry))
        with patch("sys.stdin.isatty", return_value=True), patch("builtins.input", return_value="n"):
            self.invoke("stop")
        self.assertFalse(pip_daemon.is_runtime_paused(self.registry))
        self.assertTrue(self.value("stop", "--yes")["paused"])
        with patch.object(pips, "start_queued", side_effect=AssertionError("Resume is not run")):
            self.assertFalse(self.value("resume")["paused"])
            self.assertEqual(self.store.get(job["id"])["status"], "paused")
            self.assertEqual(self.value("resume-job", job["id"])["pip"]["status"], "active")
            self.assertEqual(self.value("pause", job["id"])["pip"]["status"], "paused")

    def test_global_stop_cannot_be_bypassed_by_fresh_heartbeat(self):
        job = self.create(); self.heartbeat()
        self.value("stop", "--yes")
        self.assertEqual(self.value("run", job["id"], expected=1)["error"]["code"], "runner_stopped")

    def test_chat_never_blocks_inside_foreground_serve(self):
        with patch.object(pip_daemon, "serve", side_effect=AssertionError("Chat must not block")):
            _, error = self.invoke("serve", expected=1, in_chat=True)
        self.assertIn("another terminal", error)

    def test_help_is_command_specific_without_config_or_agent(self):
        from dgc import cli
        with patch.object(cli, "Config", side_effect=AssertionError("No config for help")), \
             patch.object(cli, "Agent", side_effect=AssertionError("No Agent for help")), \
             contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(cli.main(["pips", "context", "record", "--help"]), 0)
        self.assertIn("--expected-revision", output.getvalue())
        self.assertIn("--content", output.getvalue())

    def test_json_flag_works_before_and_after_nested_command(self):
        for args in (("--json", "context", "list"), ("context", "--json", "list"), ("context", "list", "--json")):
            output, _ = self.invoke(*args)
            self.assertEqual(json.loads(output)["context"]["revision"], 0)

    def test_output_redacts_secrets_and_terminal_controls(self):
        self.cfg.set("api_key", "test-provider-secret", persist=False)
        response = {"ok": True, "result": {"message": "test-provider-secret\x1b]0;bad\x07"}}
        with patch.object(pips, "handle_control", return_value=response):
            output, _ = self.invoke("list")
        self.assertNotIn("test-provider-secret", output)
        self.assertNotIn("\x1b", output)

    def child_env(self):
        return {"PATH": os.environ.get("PATH", ""), "HOME": str(self.home), "DGC_HOME": str(self.home),
                "PYTHONPATH": str(Path(__file__).resolve().parents[1]), "PYTHONDONTWRITEBYTECODE": "1",
                "LANG": "C.UTF-8", "PYTHONUNBUFFERED": "1"}

    def child_cli(self, *args):
        result = subprocess.run([sys.executable, "-c", CLI_BOOTSTRAP, "pips", *args, "--json"],
                                cwd=self.root, env=self.child_env(), capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        return json.loads(result.stdout)

    def test_real_cli_supervisor_native_worker_report_roundtrip(self):
        """Only the provider adapter and supervisor wait are scripted; real Agent/tools execute."""
        revision = self.commit()
        state = self.home / ".dgc"; state.mkdir(exist_ok=True)
        (state / "config.json").write_text(json.dumps(self.cfg.data), encoding="utf-8")
        # Queue drain completion, not elapsed time, advances the fixture. stdin controls
        # each heartbeat; the production worker/controller and OS leases are unchanged.
        supervisor_fixture = '''
import subprocess, sys
from unittest.mock import patch
from dgc import cli, pip_daemon, pips
from dgc.workspace_registry import state_directory, WorkspaceRegistry
original_init = WorkspaceRegistry.__init__
def registry_init(self, *args, **kwargs):
    kwargs.setdefault("clock", lambda: "2026-10-01T10:00:00.000Z")
    original_init(self, *args, **kwargs)
class InputEvent:
    stopped = False
    def is_set(self): return self.stopped
    def set(self): self.stopped = True
    def wait(self, seconds):
        thread = pip_daemon._controller(state_directory())
        if thread is not None:
            thread.join(25)
            if thread.is_alive(): raise RuntimeError("Fixture worker failed to finish")
        print("READY", flush=True)
        if sys.stdin.readline().strip() != "tick": self.set()
        return self.stopped
original_process, original_serve = subprocess.Popen, pip_daemon.serve
def process(argv, *args, **kwargs):
    if argv[1:] == ["-m", "dgc.pips", "--worker"]:
        argv = [sys.executable, "-c", WORKER]
    return original_process(argv, *args, **kwargs)
def serve(config, **kwargs):
    return original_serve(config, stop_event=InputEvent(), clock=lambda: "2026-10-01T10:00:00.000Z", **kwargs)
with patch.object(pips.subprocess,"Popen",side_effect=process), patch.object(pip_daemon,"serve",serve), \\
     patch.object(WorkspaceRegistry,"__init__",registry_init), \\
     patch("requests.sessions.Session.request",side_effect=AssertionError("No network")):
    raise SystemExit(cli.main(["pips","serve","--json"]))
'''
        process = subprocess.Popen([sys.executable, "-c", "WORKER=" + repr(WORKER_FIXTURE) + "\n" + supervisor_fixture],
                                   cwd=self.root, env=self.child_env(), stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        def cleanup():
            if process.poll() is None:
                process.kill()
            process.communicate(timeout=30)
        self.addCleanup(cleanup)
        def ready():
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                self.assertTrue(selector.select(timeout=30), "Supervisor fixture did not reach the next state")
                line = process.stdout.readline()
                if line != "READY\n":
                    process.kill()
                    _, error = process.communicate(timeout=30)
                    self.fail("Unexpected supervisor output: " + line + error)
        ready()
        job = self.child_cli("create", "CLI Auditor", "--goal", "Inspect committed source")["pip"]
        queued = self.child_cli("run", job["id"], "--idempotency-key", "cli-roundtrip")["run"]
        self.assertEqual(queued["status"], "queued")
        process.stdin.write("tick\n"); process.stdin.flush()
        ready()
        report = self.child_cli("report", queued["id"])["run"]
        self.assertEqual(report["status"], "succeeded", report)
        self.assertEqual(report["manifest"]["source_revision"], revision)
        self.assertEqual(report["result"]["summary"], "Inspected committed source through the CLI")
        self.assertEqual(report["result"]["tools_called"], 1)
        self.assertFalse(report["result"]["tests_executed"])
        output, error = process.communicate("stop\n", timeout=30)
        self.assertEqual(process.returncode, 0, error + output)
        self.assertEqual(json.loads(output)["status"], "stopped")
        self.assertFalse(self.child_cli("status")["paused"])



class PipCliWebReadTests(unittest.TestCase):
    setUp = PipCliTests.setUp
    invoke = PipCliTests.invoke
    value = PipCliTests.value

    def test_web_reads_are_proposed_from_the_terminal_and_granted_only_on_accept(self):
        self.cfg.data["pips_enabled"] = True
        pip = self.value("create", "Morning status", "--goal", "Say whether anything is degraded", "--personal")["pip"]
        proposal = self.value("propose", pip["id"], "--expected-version", "1",
                              "--web-page", "https://www.githubstatus.com/",
                              "--web-search", "GitHub incident today")["proposal"]
        self.assertEqual(proposal["definition"]["web_plan"], {"schema_version": 1, "reads": [
            {"kind": "page", "url": "https://www.githubstatus.com/"},
            {"kind": "search", "query": "GitHub incident today"}]})
        self.assertIsNone(self.store.get(pip["id"]).get("web_plan"), "a proposal grants nothing")
        self.value("accept", pip["id"], proposal["id"], "--expected-version", "1")
        self.assertEqual(len(self.store.get(pip["id"])["web_plan"]["reads"]), 2)
        removal = self.value("propose", pip["id"], "--expected-version", "2", "--no-web-reads")["proposal"]
        self.assertIsNone(removal["definition"].get("web_plan"))
        refused = self.value("propose", pip["id"], "--expected-version", "2",
                             "--web-page", "http://plain.example.com/", expected=1)
        self.assertEqual(refused["error"]["code"], "invalid_web_plan")

if __name__ == "__main__":
    unittest.main()
