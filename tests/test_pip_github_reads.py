"""Reviewed GitHub reads for project Pips: fixed repository reads by DGC, never by the model."""
import json
import subprocess
import sys
import unittest
from unittest.mock import patch

from dgc import pip_adaptation, pips, pip_github_reads as github
from dgc.workspace_registry import RegistryError
from tests import test_pips_local as fixtures

PLAN = {"schema_version": 1, "repository": "OpenPeach-ai/dgc",
        "reads": [{"kind": "open_issues", "limit": 5, "labels": ["bug"]}, {"kind": "commit_checks"}]}
REVISION = "a" * 40


class ValidationTests(unittest.TestCase):
    def test_the_canonical_plan_fills_default_limits(self):
        self.assertEqual(github.validate(PLAN), PLAN)
        self.assertIsNone(github.validate(None))
        plan = github.validate({"schema_version": 1, "repository": "a/b", "reads": [{"kind": "open_pulls"}, {"kind": "failed_runs"}]})
        self.assertEqual([r["limit"] for r in plan["reads"]], [20, 10])
        self.assertEqual(github.validate(plan), plan, "canonical plans are stable")

    def test_anything_but_four_fixed_reads_of_one_repository_is_refused(self):
        read = {"kind": "open_pulls"}
        for plan in ({**PLAN, "repository": "not a repo"}, {**PLAN, "repository": "a/b/c"}, {**PLAN, "repository": "a/.."},
                     {**PLAN, "repository": "https://github.com/a/b"}, {**PLAN, "schema_version": 2},
                     {**PLAN, "reads": []}, {**PLAN, "reads": [read, read]}, {**PLAN, "reads": [{"kind": "write_comment"}]},
                     {**PLAN, "reads": [{"kind": "open_pulls", "labels": ["x"]}]}, {**PLAN, "reads": [{"kind": "open_issues", "limit": 21}]},
                     {**PLAN, "reads": [{"kind": "commit_checks", "sha": "b" * 40}]},
                     {**PLAN, "reads": [{"kind": "open_issues", "labels": ["a,b"]}]},
                     {**PLAN, "reads": [{"kind": "open_issues", "labels": [str(i) for i in range(6)]}]},
                     {**PLAN, "token": "ghp_x"}, "OpenPeach-ai/dgc"):
            with self.subTest(plan=plan), self.assertRaises(RegistryError):
                github.validate(plan)

    def test_the_repository_comes_from_a_github_origin_only(self):
        cases = {"https://github.com/OpenPeach-ai/dgc.git": "OpenPeach-ai/dgc", "git@github.com:a/b.git": "a/b",
                 "ssh://git@github.com/a/b": "a/b", "https://gitlab.com/a/b.git": None,
                 "https://github.com.evil.example/a/b": None}
        for url, expected in cases.items():
            with self.subTest(url=url), patch.object(github.subprocess, "run",
                    return_value=subprocess.CompletedProcess([], 0, stdout=url + "\n", stderr="")):
                self.assertEqual(github.repository_from_remote("/tmp"), expected)


class ExecutionTests(unittest.TestCase):
    def setUp(self):
        self.config = type("Config", (), {"get": lambda self, key, default=None: default})()
        self.calls, self.checks = [], []

    def get(self, responses):
        def fake(path, credential, params=None):
            self.calls.append((path, credential, params))
            value = responses[path]
            if isinstance(value, Exception):
                raise value
            return value
        return fake

    def test_reads_use_the_pinned_commit_skip_pull_requests_and_redact_the_credential(self):
        token = "q1w2e3r4t5y6u7i8o9p0asdfghjklzx"         # no token shape: only an exact match redacts it
        responses = {
            "/repos/OpenPeach-ai/dgc/issues": [
                {"number": 7, "title": "Crash on empty input", "labels": [{"name": "bug"}], "user": {"login": "ana"},
                 "body": "Repro with " + token, "updated_at": "2026-10-01T00:00:00Z", "comments": 2},
                {"number": 8, "title": "A pull request", "pull_request": {}}],
            f"/repos/OpenPeach-ai/dgc/commits/{REVISION}/check-runs": {"check_runs": [{"name": "test", "status": "completed", "conclusion": "failure"}]},
            f"/repos/OpenPeach-ai/dgc/commits/{REVISION}/status": {"statuses": []}}
        rows = github.execute(self.config, PLAN, revision=REVISION, authorize=lambda: self.checks.append(1),
                              get=self.get(responses), credential=token)
        self.assertEqual([r["kind"] for r in rows], ["open_issues", "commit_checks"])
        self.assertEqual([i["number"] for i in rows[0]["items"]], [7], "pull requests are not issues")
        self.assertNotIn(token, json.dumps(rows), "the credential never reaches the worker")
        self.assertEqual(rows[1]["items"]["check_runs"][0]["conclusion"], "failure")
        self.assertEqual(self.calls[0][2]["labels"], "bug")
        self.assertTrue(all(r["untrusted"] for r in rows))
        self.assertEqual(len(self.checks), 3, "authorized before every read and once after the last")

    def test_a_refused_read_is_reported_and_large_reads_drop_whole_items(self):
        plan = {"schema_version": 1, "repository": "a/b", "reads": [{"kind": "open_pulls"}, {"kind": "failed_runs"}]}
        pulls = [{"number": n, "title": "x" * 400, "user": {"login": "u" * 39}, "head": {"ref": "h" * 200}, "base": {"ref": "main"}}
                 for n in range(20)]
        responses = {"/repos/a/b/pulls": pulls, "/repos/a/b/actions/runs": ValueError("GitHub refused the read (HTTP 403)")}
        rows = github.execute(self.config, plan, revision=REVISION, authorize=lambda: None, get=self.get(responses), credential="")
        self.assertTrue(rows[0]["truncated"])
        self.assertLessEqual(len(json.dumps(rows[0]["items"])), github.MAX_READ_CHARS + 200)
        self.assertTrue(all(len(p["title"]) <= github.MAX_TITLE + 1 for p in rows[0]["items"]))
        self.assertIn("403", rows[1]["error"])
        self.assertNotIn("items", rows[1])

    def test_checks_without_a_pinned_commit_are_reported_not_guessed(self):
        plan = {"schema_version": 1, "repository": "a/b", "reads": [{"kind": "commit_checks"}]}
        rows = github.execute(self.config, plan, revision=None, authorize=lambda: None, get=self.get({}), credential="")
        self.assertIn("no pinned commit", rows[0]["error"])
        self.assertEqual(self.calls, [])

    def test_the_credential_prefers_the_environment_then_gh(self):
        with patch.dict("os.environ", {"GH_TOKEN": "ghp_env"}, clear=False):
            self.assertEqual(github.token(self.config), "ghp_env")
        with patch.dict("os.environ", {}, clear=True), patch.object(github.subprocess, "run",
                return_value=subprocess.CompletedProcess([], 0, stdout="gho_" + "a" * 36 + "\n", stderr="")):
            self.assertEqual(github.token(self.config), "gho_" + "a" * 36)
        with patch.dict("os.environ", {}, clear=True), patch.object(github.subprocess, "run", side_effect=FileNotFoundError):
            self.assertEqual(github.token(self.config), "", "no gh: public repositories only")


class JobTests(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp
    git = fixtures.LocalPipsTests.git
    commit = fixtures.LocalPipsTests.commit

    def reviewer(self):
        return self.store.create(self.workspace["id"], "Reviewer", "Review the source", "local-console")

    def test_github_reads_are_a_reviewed_job_change_for_project_reviewers_only(self):
        job = self.reviewer()
        proposal = self.store.propose(job["id"], 1, {"github_plan": PLAN}, "local-console")
        self.assertIsNone(self.store.get(job["id"]).get("github_plan"), "a proposal grants nothing")
        self.store.accept(job["id"], proposal["id"], 1, "local-console")
        self.assertEqual(self.store.get(job["id"])["github_plan"], PLAN)
        with self.assertRaises(RegistryError):
            self.store.propose(job["id"], 2, {"github_plan": None}, "main-chat", origin_session_id="chat-one")
        personal = self.store.create(self.registry.personal()["id"], "Brief", "Plan the day", "local-console")
        with self.assertRaises(RegistryError) as raised:
            self.store.propose(personal["id"], 1, {"github_plan": PLAN}, "local-console")
        self.assertEqual(raised.exception.code, "unsupported_github_plan")

    def test_automatic_name_changes_keep_the_reviewed_github_reads(self):
        job = self.reviewer()
        proposal = self.store.propose(job["id"], 1, {"github_plan": PLAN, "adaptation_policy":
                                                     {"mode": "bounded_adaptive", "allowed_fields": ["name"]}}, "local-console")
        self.store.accept(job["id"], proposal["id"], 1, "local-console")
        self.registry.associate_session("chat-one", self.root)
        pip_adaptation.adapt(self.store, job["id"], 2, {"name": "Renamed reviewer"}, "Clearer name",
                             origin_session_id="chat-one", request_key="rename-1", expected_workspace_id=self.workspace["id"])
        changed = self.store.get(job["id"])
        self.assertEqual((changed["name"], changed["github_plan"]), ("Renamed reviewer", PLAN))

    def test_the_controller_reads_github_and_the_real_worker_sees_only_the_result(self):
        self.commit()
        job = self.reviewer()
        proposal = self.store.propose(job["id"], 1, {"github_plan": PLAN}, "local-console")
        self.store.accept(job["id"], proposal["id"], 1, "local-console")
        queued = self.store.enqueue(job["id"], "github-run", "local-console", self.cfg)
        self.assertEqual(queued["manifest"]["github_plan"], PLAN)
        row = self.store.claim_next()
        fixture = r'''
import json
from unittest.mock import patch
from dgc.llm import LLMClient, ChatResult, ToolCall
from dgc.pips import _worker_main
responses = iter([ChatResult(tool_calls=[ToolCall("read1", "read_file", {"path": "source.py"})]),
                  ChatResult(content=json.dumps({"summary": "Checked", "findings": [], "limitations": ["Static only"]}))])
def chat(self, messages, tools=None, on_text=None, **kwargs):
    reference = json.dumps(messages)
    assert 'Untrusted GitHub reference data' in reference, 'GitHub reference envelope missing'
    assert 'ISSUE_SENTINEL' in reference, 'Read text missing'
    assert 'ghp_' not in reference, 'Credential reached the worker'
    result = next(responses)
    if result.content and on_text:
        on_text(result.content)
    return result
with patch.object(LLMClient, 'chat', chat), patch('requests.sessions.Session.request', side_effect=AssertionError('No network in the worker')):
    raise SystemExit(_worker_main())
'''
        popen = subprocess.Popen

        def process(argv, *a, **kw):
            if argv[1:] == ["-m", "dgc.pips", "--worker"]:
                argv = [sys.executable, "-c", fixture]
            return popen(argv, *a, **kw)
        seen = []

        def read(config, plan, *, revision, authorize):
            seen.append((plan, revision))
            authorize()
            return [{"repository": plan["repository"], "kind": "open_issues", "limit": 5, "labels": ["bug"],
                     "untrusted": True, "items": [{"number": 1, "title": "ISSUE_SENTINEL"}]}]
        with patch.object(pips.subprocess, "Popen", side_effect=process), patch("dgc.pip_github_reads.execute", side_effect=read):
            result = pips._execute_run(self.registry, row, self.cfg)
        self.assertEqual(self.store.finish(queued["id"], result=result)["status"], "succeeded")
        self.assertEqual(seen, [(PLAN, queued["manifest"]["source_revision"])], "the pinned commit, read once")
        event = self.registry.db.execute("SELECT payload FROM workspace_events WHERE event_type='pip_run_github_reads'").fetchone()
        self.assertEqual(json.loads(event[0])["reads"], [{"kind": "open_issues", "items": 1}])


class CommandLineTests(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp
    git = fixtures.LocalPipsTests.git
    commit = fixtures.LocalPipsTests.commit

    def cli(self, *argv):
        import contextlib
        import io
        from dgc import pip_cli
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err), patch("sys.stdin", io.StringIO()):
            code = pip_cli.handle_command(self.cfg, list(argv))
        return code, out.getvalue(), err.getvalue()

    def test_propose_names_exact_reads_and_refuses_ambiguous_flags(self):
        self.commit()
        self.cfg.data["pips_enabled"] = True
        code, text, _ = self.cli("create", "Reviewer", "--goal", "Review the source", "--json")
        self.assertEqual(code, 0, text)
        pip = json.loads(text)["pip"]
        code, text, _ = self.cli("propose", pip["id"], "--expected-version", "1", "--github-repo", "OpenPeach-ai/dgc",
                                 "--github-issues", "5", "--github-labels", "bug", "--github-checks", "--reason", "Use CI")
        self.assertEqual(code, 0, text)
        self.assertIn("GitHub reads from OpenPeach-ai/dgc before each run (read-only", text)
        self.assertIn("Up to 5 open issues labelled bug", text)
        for argv in (("--github-labels", "bug"), ("--no-github-reads", "--github-checks"),
                     ("--github-checks", "--github-repo", "not/a/repo")):
            with self.subTest(argv=argv):
                code, _, err = self.cli("propose", pip["id"], "--expected-version", "1", *argv)
                self.assertNotEqual(code, 0)



if __name__ == "__main__":
    unittest.main()
