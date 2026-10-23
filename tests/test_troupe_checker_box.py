"""A Troupe checker's read-only boxed shell and the project's read-only database account.

The founder (2026-10-18): "Troupe checker agents get a sandboxed read-only shell, together with a read-only database
account, so a checker can't change data." In the ERP review, shell-less verifiers voted findings "not real" because
they couldn't re-run a query. Boxed commands here really run in this machine's bubblewrap (skipped where it can't);
the database is a stand-in TCP server on 127.0.0.1 (the live check used a real Postgres).
"""
from __future__ import annotations

import json
import os
import socket
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import checker_box, plugin_credentials, readonly_database, sandbox, troupe, troupe_agent
from dgc.agent import Agent
from dgc.llm import ChatResult, ToolCall
from dgc.permissions import PermissionEngine
from test_troupe_agent import AgentCase, Recorder, fake_child, REVIEW

BOX = sandbox.available() == "bwrap" and Path(checker_box.PYTHON).is_file()


class Echo:
    """A stand-in database on 127.0.0.1: answers each line with "db:" and the line."""

    def __init__(self):
        self.server = socket.socket()
        self.server.bind(("127.0.0.1", 0))
        self.server.listen(4)
        self.port = self.server.getsockname()[1]
        threading.Thread(target=self.serve, daemon=True).start()

    def serve(self):
        while True:
            try:
                client, _ = self.server.accept()
            except OSError:
                return
            with client:
                data = client.recv(1024)
                client.sendall(b"db:" + data)

    def close(self):
        self.server.close()


class Project(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="dgc-checker-project-")).resolve()
        import shutil
        self.addCleanup(shutil.rmtree, self.root, True)
        (self.root / "app.py").write_text("print('erp')\n")
        (self.root / ".env").write_text("POSTGRES_PASSWORD=superuser-secret\n")
        (self.root / "config").mkdir()
        (self.root / "config" / "server.pem").write_text("-----BEGIN PRIVATE KEY-----\n")
        (self.root / ".git").mkdir()
        (self.root / ".git" / "config").write_text("[remote]\nurl=https://token@example.com\n")
        plugin_credentials.configure("file")              # never the user's keychain from a test
        self.addCleanup(plugin_credentials.configure, "auto")

    def box(self, database=None):
        settings, relay, note = checker_box.prepare(self.root, database)
        if relay is not None:
            self.addCleanup(relay.close)
        return settings, note

    def run_boxed(self, command, settings):
        argv = checker_box.wrap(command, self.root, settings)
        # The environment the bash tool gives a checker's child: its config carries the box (agent.py).
        env = sandbox.process_env(type("C", (), {"get": lambda self, k, d=None: settings if k == "_checker_box" else d})())
        return subprocess.run(argv, capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL, env=env)


class ReadOnlyDatabaseTests(Project):
    def test_only_a_local_postgres_and_never_echoed(self):
        parsed = readonly_database.parse("postgresql://dgc_readonly:p%40ss@localhost:5433/erp?sslmode=disable")
        self.assertEqual((parsed["user"], parsed["password"], parsed["host"], parsed["port"], parsed["database"]),
                         ("dgc_readonly", "p@ss", "localhost", 5433, "erp"))
        self.assertEqual(readonly_database.url_for(parsed, host="127.0.0.1"),
                         "postgresql://dgc_readonly:p%40ss@127.0.0.1:5433/erp?sslmode=disable")
        for bad, words in (("mysql://u:p@localhost/x", "Postgres"), ("postgresql://u:p@db.example.com/x", "this computer"),
                           ("postgresql://u:p@localhost:5432/", "database name"), ("postgresql://localhost/x", "user"),
                           ("postgresql://u:p@localhost/x?host=10.0.0.1", "not as query options"), ("", "one")):
            with self.subTest(bad=bad), self.assertRaises(readonly_database.ReadOnlyDatabaseError) as raised:
                readonly_database.parse(bad)
            self.assertIn(words, str(raised.exception))
            self.assertNotIn(":p@", str(raised.exception))

    def test_set_keeps_the_secret_apart_and_show_never_prints_it(self):
        said = []
        self.assertEqual(readonly_database.command(self.root, ["set", "postgresql://u:pw@localhost/x"], out=said.append), 2)
        self.assertIn("Don't put the connection string on the command line", said[-1])
        self.assertEqual(readonly_database.command(self.root, ["set"], read=lambda: "postgresql://ro:hunter2@localhost:5432/erp",
                                                   out=said.append), 0)
        self.assertTrue(readonly_database.configured(self.root))
        self.assertEqual(readonly_database.load(self.root)["password"], "hunter2")
        readonly_database.command(self.root, ["show"], out=said.append)
        self.assertIn("ro@localhost:5432/erp", said[-1])
        self.assertFalse(any("hunter2" in line for line in said))
        index = json.loads((readonly_database._index()).read_text())
        self.assertNotIn("hunter2", json.dumps(index), "the index holds no secret")
        self.assertEqual(oct(readonly_database._index().stat().st_mode & 0o777), "0o600")
        readonly_database.command(self.root, ["clear"], out=said.append)
        self.assertIsNone(readonly_database.load(self.root))
        readonly_database.command(self.root, ["guide"], out=said.append)
        self.assertIn("CREATE ROLE dgc_readonly LOGIN", said[-1])
        self.assertIn("default_transaction_read_only = on", said[-1])
        self.assertIn("DGC never creates or changes a role", said[-1])


class CommandLineTests(Project):
    def dgc(self, *argv, stdin="", extra=None):
        home = tempfile.mkdtemp(prefix="dgc-readonly-cli-home-")
        import shutil
        self.addCleanup(shutil.rmtree, home, True)
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": home, "DGC_HOME": home,
               "PYTHONPATH": str(Path(__file__).resolve().parents[1]), **(extra or {})}
        import sys
        return subprocess.run([sys.executable, "-m", "dgc", "readonly-db", *argv], cwd=self.root, env=env, input=stdin,
                              capture_output=True, text=True, timeout=120)

    def test_dgc_readonly_db_reads_the_secret_from_a_pipe_never_argv(self):
        guide = self.dgc("guide")
        self.assertEqual(guide.returncode, 0, guide.stderr)
        self.assertIn("CREATE ROLE dgc_readonly LOGIN", guide.stdout)
        argv = self.dgc("set", "postgresql://ro:hunter2@localhost/erp")
        self.assertEqual(argv.returncode, 2)
        self.assertIn("Don't put the connection string on the command line", argv.stdout)
        shell = self.dgc("set", stdin="postgresql://ro:hunter2@localhost/erp\n", extra={"DGC_AGENT_SHELL": "1"})
        self.assertEqual(shell.returncode, 2, "the model's shell can't set it")
        self.assertIn("your own terminal", shell.stderr)


class BoxTests(Project):
    def test_the_projects_credentials_are_hidden_as_from_a_pip_snapshot(self):
        (self.root / "node_modules" / "pkg").mkdir(parents=True)
        (self.root / "node_modules" / "pkg" / "index.js").write_text("x")
        (self.root / ".venv").mkdir()
        self.assertEqual(checker_box.hidden_paths(self.root), [(".env", False), (".git", True), ("config/server.pem", False)],
                         "credentials only: dependency and build folders stay, read only, so tests can run")
        self.assertIsNone(checker_box.hidden_paths(self.root, limit=3), "too many to check: no shell (fail closed)")

    @unittest.skipUnless(BOX, "this computer's bubblewrap box")
    def test_a_boxed_command_reads_but_never_writes_and_has_no_network(self):
        settings, note = self.box()
        self.assertEqual(note, "")
        listening = socket.socket()
        listening.bind(("127.0.0.1", 0))
        listening.listen(1)
        self.addCleanup(listening.close)
        port = listening.getsockname()[1]
        result = self.run_boxed(
            "echo read=$(cat app.py);"
            " (echo x > /mnt/app.py) 2>&1 | sed 's/^/write project: /';"
            " (echo y > /mnt/new.txt) 2>&1 | sed 's/^/new file: /';"
            f" (echo z > {self.root}/new.txt) 2>&1 | sed 's/^/its own path: /';"
            " echo ok > /tmp/scratch && echo tmp=$(cat /tmp/scratch);"
            " echo env=$(wc -c < /mnt/.env) git=$(ls -A /mnt/.git | wc -l) pem=$(wc -c < /mnt/config/server.pem)"
            f" own_env=$(wc -c < {self.root}/.env) run=$(ls -A /run | wc -l) home=$(ls -A {Path.home()} 2>/dev/null | wc -l);"
            f" python3 -c \"import socket; socket.create_connection(('127.0.0.1', {port}), 2)\" 2>&1 | tail -1;"
            " echo DB=${DGC_READONLY_DATABASE_URL:-none}", settings)
        lines = result.stdout.splitlines()
        self.assertEqual(lines[0], "read=print('erp')", result.stderr)
        for line, label in zip(lines[1:4], ("write project: ", "new file: ", "its own path: ")):
            self.assertTrue(line.startswith(label) and line.endswith("Read-only file system"), lines)
        self.assertEqual(lines[4], "tmp=ok", "a private /tmp is the one writable place")
        self.assertEqual(lines[5], "env=0 git=0 pem=0 own_env=0 run=0 home=0",
                         "credentials, .git, /run and the home are empty, at /mnt and at the project's own path")
        self.assertIn("Connection refused", lines[6], "the host's loopback is not reachable from the box")
        self.assertEqual(lines[7], "DB=none")
        self.assertFalse((self.root / "new.txt").exists())
        self.assertEqual((self.root / "app.py").read_text(), "print('erp')\n")

    @unittest.skipUnless(BOX and os.access("/var/tmp", os.W_OK), "this computer's bubblewrap box")
    def test_a_project_the_host_shows_at_its_own_path_is_hidden_there_too(self):
        # Outside a home and /tmp, the read-only / shows the project at its own path as well as at /mnt.
        import shutil
        outside = Path(tempfile.mkdtemp(prefix="dgc-checker-outside-", dir="/var/tmp")).resolve()
        self.addCleanup(shutil.rmtree, outside, True)
        (outside / ".env").write_text("POSTGRES_PASSWORD=superuser-secret\n")
        (outside / "app.py").write_text("ok\n")
        self.root = outside
        settings, _ = self.box()
        result = self.run_boxed(f"wc -c < {outside}/.env; wc -c < /mnt/.env; cat {outside}/app.py;"
                                f" (echo x > {outside}/app.py) 2>&1", settings)
        self.assertEqual(result.stdout.splitlines()[:3], ["0", "0", "ok"], result.stderr)
        self.assertIn("Read-only file system", result.stdout)

    @unittest.skipUnless(BOX, "this computer's bubblewrap box")
    def test_the_read_only_database_is_the_one_place_the_box_reaches(self):
        echo = Echo()
        self.addCleanup(echo.close)
        database = readonly_database.parse(f"postgresql://ro:hunter2@localhost:{echo.port}/erp")
        settings, note = self.box(database)
        self.assertEqual(note, "")
        self.assertEqual(settings["env"], {readonly_database.ENV: f"postgresql://ro:hunter2@127.0.0.1:{echo.port}/erp"})
        self.assertIn("hunter2", settings["secrets"], "the password is redacted from what the checker's tools return")
        result = self.run_boxed(
            "python3 - <<'EOF'\n"
            "import os, socket\nfrom urllib.parse import urlsplit\n"
            "url = urlsplit(os.environ['DGC_READONLY_DATABASE_URL'])\n"
            "s = socket.create_connection((url.hostname, url.port), 5); s.sendall(b'select 1'); print(s.recv(100).decode())\n"
            "try:\n    socket.create_connection(('1.1.1.1', 53), 2); print('internet: yes')\n"
            "except OSError as e:\n    print('internet: no')\n"
            "EOF", settings)
        self.assertEqual(result.stdout.splitlines(), ["db:select 1", "internet: no"], result.stderr)

    def test_no_box_here_means_no_shell_and_says_why(self):
        # Linux's case (a Mac builds its box with Seatbelt: tests/test_checker_box_seatbelt.py).
        with patch.object(checker_box.sys, "platform", "linux"), patch.object(sandbox, "available", return_value=None), \
                patch("dgc.browser_setup.userns_restricted", return_value=True), \
                patch("dgc.pip_execution.Path.exists", return_value=True):
            settings, note = self.box()
        self.assertIsNone(settings)
        self.assertIn("AppArmor", note)


class TroupeCheckerTests(AgentCase):
    def setUp(self):
        plugin_credentials.configure("file")
        self.addCleanup(plugin_credentials.configure, "auto")

    def checker_call(self, agent):
        run, calls = fake_child(lambda prompt, workspace: '```json\n{"real": true, "why": "ran it"}\n```'
                                if "Review this" not in prompt else
                                '```json\n{"findings": [{"title": "Stuck invoice", "where": "db", "why": "x"}]}\n```')
        with patch.object(Agent, "_execute_prepared_subagent", run):
            out = troupe_agent.start(agent, REVIEW, "c1")
        self.assertIn("State: done", out)
        return calls, calls

    def test_a_verifier_gets_its_boxed_shell_and_is_told_what_it_is(self):
        agent = self.make_agent(ultra=True)
        if not BOX:
            self.skipTest("this computer's bubblewrap box")
        calls, kwargs = self.checker_call(agent)
        verifiers = [(c, k) for c, k in zip(calls, kwargs) if c["prompt"].startswith("You are a verifier")]
        self.assertTrue(verifiers)
        for call, kw in verifiers:
            self.assertEqual(call["tools"], troupe.READ_TOOLS | {"bash"})
            self.assertIsInstance(kw["checker_box"], dict)
            self.assertIn("read-only shell (bash) in a sealed box", call["prompt"])
            self.assertIn("No read-only database account is set for this project", call["prompt"])
        explorers = [k for c, k in zip(calls, kwargs) if c["prompt"].startswith("You are a read-only explorer")]
        self.assertTrue(all(k.get("checker_box") is None for k in explorers), "only verifiers get the box")

    def test_with_the_database_set_checkers_and_workers_get_it(self):
        agent = self.make_agent(ultra=True)
        if not BOX:
            self.skipTest("this computer's bubblewrap box")
        echo = Echo()
        self.addCleanup(echo.close)
        readonly_database.set_url(agent.config.project_root, f"postgresql://ro:hunter2@localhost:{echo.port}/erp")
        calls, kwargs = self.checker_call(agent)
        verifier = next(k for c, k in zip(calls, kwargs) if c["prompt"].startswith("You are a verifier"))
        self.assertEqual(verifier["checker_box"]["forward"]["port"], echo.port)
        self.assertIn("hunter2", verifier["secrets"])
        prompt = next(c["prompt"] for c in calls if c["prompt"].startswith("You are a verifier"))
        self.assertIn("$DGC_READONLY_DATABASE_URL", prompt)
        self.assertNotIn("hunter2", prompt, "the prompt names the variable, never the password")

    def test_without_a_box_the_verifier_has_no_shell_and_answers_unsure(self):
        agent = self.make_agent(ultra=True)
        with patch.object(checker_box, "unavailable_reason",
                          return_value="bubblewrap can't build its box on this computer: Ubuntu's AppArmor"):
            calls, kwargs = self.checker_call(agent)
        verifier = next((c, k) for c, k in zip(calls, kwargs) if c["prompt"].startswith("You are a verifier"))
        self.assertEqual(verifier[0]["tools"], troupe.READ_TOOLS)
        self.assertIsNone(verifier[1]["checker_box"])
        self.assertIn("You have no shell (bubblewrap can't build its box on this computer", verifier[0]["prompt"])
        self.assertIn("say you are unsure, never that it is not real", verifier[0]["prompt"])

    def test_the_tool_says_what_each_kind_can_do_here(self):
        agent = self.make_agent(ultra=True)
        tool = next(t for t in agent._tool_schemas() if t["function"]["name"] == "troupe")
        said = tool["function"]["parameters"]["properties"]["stages"]["items"]["properties"]["agent"]["description"]
        if BOX:
            self.assertIn("verifier: a read-only shell in a sealed box", said)
            self.assertIn("no read-only database account is set for this project", said)
        with patch.object(checker_box, "unavailable_reason", return_value="bubblewrap can't build its box on this computer"):
            tool = next(t for t in agent._tool_schemas() if t["function"]["name"] == "troupe")
        said = tool["function"]["parameters"]["properties"]["stages"]["items"]["properties"]["agent"]["description"]
        self.assertIn("verifier: reads files and the web; no shell on this computer", said)
        self.assertIn("explorer: reads and searches the project's files and the web; no shell", said)
        self.assertIn("worker: has a shell and writes", said)

    @unittest.skipUnless(BOX, "this computer's bubblewrap box")
    def test_a_checker_child_runs_bash_in_its_box_in_default_mode_and_a_deny_rule_still_wins(self):
        from test_monitors import FrontendUI, make_config
        directory = tempfile.TemporaryDirectory(prefix="dgc-checker-agent-")
        self.addCleanup(directory.cleanup)
        agent = Agent(make_config(Path(directory.name).resolve(), mode="default"), FrontendUI())
        self.addCleanup(agent.mcp.stop_all)
        (agent.config.project_root / ".env").write_text("SECRET=1\n")
        echo = Echo()
        self.addCleanup(echo.close)
        settings, relay, _ = checker_box.prepare(agent.config.project_root,
                                                 readonly_database.parse(f"postgresql://ro:hunter2@localhost:{echo.port}/erp"))
        self.addCleanup(relay.close)
        steps = iter([ChatResult(content="", tool_calls=[ToolCall("c1", "bash", {
                          "command": "(echo x > /mnt/file) 2>&1 | tail -1; echo url=$DGC_READONLY_DATABASE_URL;"
                                     " wc -c < /mnt/.env; exit 1"})], finish_reason="tool_calls"),
                      ChatResult(content='```json\n{"real": false, "why": "checked"}\n```')])
        seen = []

        def chat(self_agent, tools, effort, **kwargs):
            if self_agent.depth:
                seen.append([m for m in self_agent.messages if m.get("role") == "tool"])
            result = next(steps)
            if result.content:
                self_agent.ui.on_text(result.content)
                self_agent.ui.end_stream()
            return result
        from dgc.agent import _SubUI
        with patch.object(Agent, "_chat", chat):
            failure, text, start_error = agent._execute_prepared_subagent(
                "troupe · Verify 1", "check it", "", None, _SubUI(agent.ui, "check", buffered=True),
                None, tools=troupe.READ_TOOLS | {"bash"}, unattended=True, checker_box=settings,
                secrets=settings["secrets"])
        self.assertEqual((failure, start_error), ("", ""))
        tool_output = str(seen[-1][-1]["content"])
        self.assertIn("Read-only file system", tool_output)
        self.assertIn("That was your read-only box working", tool_output)
        self.assertIn(f"url=postgresql://[REDACTED]@127.0.0.1:{echo.port}/erp", tool_output,
                      "the box's own database address, its password redacted from what the checker reads")
        self.assertNotIn("hunter2", tool_output)
        self.assertIn("\n0\n", tool_output)
        self.assertFalse((agent.config.project_root / "file").exists())
        # The user's deny rule for Bash is never overridden by the checker's own allow.
        agent.config.permissions["deny"] = ["Bash"]
        self.addCleanup(agent.config.permissions["deny"].clear)
        rules = {"allow": ["Bash"], "ask": [], "deny": ["Bash"]}
        self.assertEqual(PermissionEngine("default", rules, agent.config.project_root).decide("bash", {"command": "ls"})[0],
                         "deny")


if __name__ == "__main__":
    unittest.main()
