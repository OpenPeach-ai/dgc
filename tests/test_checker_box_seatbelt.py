"""The Mac's read-only box: a live-data Pip's commands and a Troupe checker's shell under Seatbelt (sandbox-exec).

The founder (2026-10-23), on "the live-data Pip needs Linux or WSL": "what about ... Mac?" The Mac gets the same
read-only box, built with Seatbelt, as close to the bubblewrap one as Seatbelt allows, and what is weaker is said once
on the Pip's card. The first group checks the profile and the wiring with the platform stood in for (they run
anywhere); the second really runs sandbox-exec, and runs only on a Mac.
"""
from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

PROJECT = Path(__file__).resolve().parents[1]
for path in (PROJECT, PROJECT / "tests"):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

if "dgc.config" not in sys.modules and "dgc-tests-home-" not in os.environ.get("HOME", ""):
    _HOME = tempfile.mkdtemp(prefix="dgc-tests-home-")
    os.environ["HOME"] = os.environ["USERPROFILE"] = os.path.realpath(_HOME)

from dgc import checker_box, pip_live_data as live, plugin_credentials, readonly_database, sandbox, troupe_agent  # noqa: E402
from test_troupe_agent import AgentCase, REVIEW, fake_child  # noqa: E402

MAC = sys.platform == "darwin" and checker_box.seatbelt_confines()


class Cfg:
    def __init__(self, box):
        self.box = box

    def get(self, key, default=None):
        return self.box if key == "_checker_box" else default


class Project(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="dgc-mbox-")).resolve()
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
        self.assertIsNone(relay, "no relay on a Mac: Seatbelt filters by port")
        self.addCleanup(checker_box.release, settings)
        return settings, note


class On:
    """sys.platform as a Mac's, with a sandbox-exec that confines (the profile and wiring, checked anywhere)."""

    def __enter__(self):
        self.patches = [patch.object(checker_box.sys, "platform", "darwin"),
                        patch.object(checker_box, "seatbelt_confines", return_value=True)]
        for item in self.patches:
            item.start()
        return self

    def __exit__(self, *exc):
        for item in reversed(self.patches):
            item.stop()


class WhereItRunsTests(unittest.TestCase):
    def test_a_mac_has_the_box_and_other_systems_are_told_what_it_needs(self):
        with On():
            self.assertEqual(checker_box.unavailable_reason(), "")
            self.assertIsNone(live.run_here_notice({"live_plan": {"schema_version": 1, "commands": ["df -h ."]}}))
        with patch.object(checker_box.sys, "platform", "darwin"), \
                patch.object(checker_box, "seatbelt_confines", return_value=False):
            self.assertIn("sandbox-exec isn't working on this computer", checker_box.unavailable_reason())
        with patch.object(checker_box.sys, "platform", "win32"):
            said = live.run_here_notice({"live_plan": {"schema_version": 1, "commands": ["df -h ."]}})
        self.assertEqual(said, "Its commands can't run on this computer: a live-data Pip's read-only box needs Linux "
                               "with bubblewrap, or macOS (on Windows, DGC inside WSL 2), and this computer has neither.")

    def test_the_card_says_once_what_is_weaker_on_a_mac_and_linux_is_unchanged(self):
        from dgc.pip_setup import live_scope
        plan = {"schema_version": 1, "commands": ["df -h ."]}
        if not sys.platform.startswith("darwin"):
            self.assertEqual(live_scope(plan), live.SETUP_NOTICE, "Linux's card is as it was")
        with On():
            said = live_scope(plan)
        self.assertEqual(said, live.SETUP_NOTICE + " " + checker_box.MAC_NOTICE)
        self.assertEqual(said.count("sandbox-exec"), 1)
        self.assertIn("can see which other programs are running", said)

    def test_doctor_has_one_plain_row_on_a_mac_and_none_on_linux(self):
        from dgc import cli
        with patch.object(cli.sys, "platform", "linux"):
            self.assertEqual(cli.pips_box_row(), "")
        with On():
            self.assertEqual(cli.pips_box_row(), "Seatbelt (sandbox-exec): live-data Pips' commands and Troupe "
                                                 "checkers' shell run read only")
        with patch.object(checker_box.sys, "platform", "darwin"), \
                patch.object(checker_box, "seatbelt_confines", return_value=False):
            self.assertIn("unavailable: a checker's read-only shell runs in a Seatbelt box", cli.pips_box_row())


class ProfileTests(Project):
    def test_the_mac_box_reads_the_project_writes_one_private_folder_and_reaches_only_its_ports(self):
        database = readonly_database.parse("postgresql://ro:hunter2@localhost:5433/erp")
        with On():
            settings, note = self.box(database)
            self.assertEqual(note, "")
            self.assertEqual(settings["env"], {readonly_database.ENV: "postgresql://ro:hunter2@127.0.0.1:5433/erp"},
                             "straight at the database: no relay")
            self.assertEqual(settings["secrets"], ["hunter2"])
            self.assertEqual(checker_box.reach(settings, [8000, 5433, 8000]), [], "nothing to close on a Mac")
            argv = checker_box.wrap("cat app.py", self.root, settings)
        run = Path(settings["seatbelt"]["tmp"])
        self.assertEqual(oct(run.stat().st_mode & 0o777), "0o700")
        private = next(run.iterdir())
        self.assertEqual(oct(private.stat().st_mode & 0o777), "0o700")
        self.assertEqual(argv[:2], ["/usr/bin/sandbox-exec", "-p"])
        self.assertEqual(argv[3:8], ["/usr/bin/env", f"HOME={private}/home", f"TMPDIR={private}/tmp/",
                                     f"TMP={private}/tmp", f"TEMP={private}/tmp"])
        self.assertTrue(argv[8].startswith("PATH="))
        self.assertTrue({"/opt/homebrew/bin", "/usr/local/bin"} <= set(argv[8][5:].split(":")), "psql, jq from Homebrew")
        self.assertEqual(argv[9:], ["/bin/bash", "-o", "pipefail", "-c", "cat app.py"])
        profile = argv[2]
        order = [f'(allow file-write* (subpath "{private}")', '(deny file-read* (subpath "/private/tmp"))',
                 '(deny file-read* (subpath "/private/var/folders"))', '(deny file-read* (subpath "/private/var/run"))',
                 f'(allow file-read* (subpath "{self.root}"))', f'(allow file-read* (subpath "{private}"))',
                 f'(deny file-read* (subpath "{self.root}/.env"))', f'(deny file-read* (subpath "{self.root}/.git"))',
                 f'(deny file-read* (subpath "{self.root}/config/server.pem"))', "(deny mach-lookup)",
                 "(deny network*)", '(allow network-outbound (remote tcp "localhost:5433"))',
                 '(allow network-outbound (remote tcp "localhost:8000"))']
        at = [profile.find(rule) for rule in order]
        self.assertNotIn(-1, at, [rule for rule, i in zip(order, at) if i < 0])
        self.assertEqual(at, sorted(at), "Seatbelt applies the last match: credentials are denied after the project")
        self.assertTrue(profile.startswith("(version 1)(allow default)(deny file-write*)"))
        self.assertIn(f'(deny file-read* (subpath "{Path.home().resolve()}"))', profile)
        for rule in ("(deny signal)(allow signal (target same-sandbox))", "(deny job-creation)",
                     '(deny sysctl-read (sysctl-name-prefix "kern.procargs"))'):
            self.assertIn(rule, profile)
        allowed = profile.split("(deny mach-lookup)", 1)[1]
        for service in ("com.apple.SecurityServer", "com.apple.securityd", "com.apple.secd", "com.apple.pasteboard",
                        "com.apple.coreservices", "com.apple.metadata"):
            self.assertNotIn(service, allowed, "no Keychain, clipboard, Apple Events, Launch Services or Spotlight")
        self.assertEqual(profile.count("network-outbound"), 2, "no other way out")
        self.assertNotIn("(allow network*", profile)
        checker_box.release(settings)
        self.assertFalse(run.exists(), "removed after the run")

    def test_each_command_has_its_own_empty_folder_and_none_after_release(self):
        with On():
            settings, _ = self.box()
            first = checker_box.wrap("true", self.root, settings)
            second = checker_box.wrap("true", self.root, settings)
        self.assertNotEqual(first[4], second[4], "a private folder per command, as Linux's /tmp is per command")
        checker_box.release(settings)
        with On():
            self.assertIsNone(checker_box.wrap("true", self.root, settings), "after the run: no box (fail closed)")

    def test_a_credential_link_is_denied_where_it_points_too(self):
        secret = self.root / "config" / "real-secret.txt"
        secret.write_text("x")
        (self.root / ".env.local").symlink_to(secret)
        with On():
            settings, _ = self.box()
            profile = checker_box.wrap("true", self.root, settings)[2]
        self.assertIn(f'(deny file-read* (subpath "{self.root}/.env.local"))', profile)
        self.assertIn(f'(deny file-read* (subpath "{secret}"))', profile)

    def test_no_seatbelt_or_another_system_builds_nothing(self):
        with On():
            settings, _ = self.box()
        with patch.object(checker_box.sys, "platform", "darwin"), \
                patch.object(checker_box, "seatbelt_confines", return_value=False):
            self.assertIsNone(checker_box.wrap("true", self.root, settings))
        with patch.object(checker_box.sys, "platform", "linux"):
            self.assertIsNone(checker_box.wrap("true", self.root, settings), "a Mac's box never runs elsewhere")


class LiveDataTests(Project):
    def test_a_live_data_run_on_a_mac_runs_in_the_project_reaches_its_ports_and_cleans_up(self):
        lines = ["cat app.py", "curl -s http://127.0.0.1:8765/health"]
        plan = live.validate({"schema_version": 1, "commands": lines})
        seen = []

        def capture(argv, **kwargs):
            self.assertTrue(kwargs.get("monitor"), "no PID namespace: the sampler stops what a line leaves running")
            seen.append((argv, kwargs.get("cwd"), dict(kwargs["env"])))
            return {"status": "passed", "exit_code": 0, "data": b"ok\n", "truncated": False}
        with On(), patch("dgc.pip_execution._capture", side_effect=capture):
            out = live.run(self.root, lines, approved=plan)
        self.assertEqual([c["status"] for c in out], ["ok", "ok"])
        self.assertEqual([cwd for _, cwd, _ in seen], [str(self.root)] * 2, "its own path: no /mnt on a Mac")
        argv = seen[1][0]
        self.assertEqual(argv[0], "/usr/bin/sandbox-exec")
        self.assertIn('(allow network-outbound (remote tcp "localhost:8765"))', argv[2])
        run = Path(argv[4].split("=", 1)[1]).parent.parent
        self.assertFalse(run.exists(), "the run's private folders are removed after it")


class TroupeCheckerTests(unittest.TestCase):
    def test_a_mac_verifier_is_told_its_own_box_and_its_database(self):
        said = troupe_agent.verifier_role(shell=True, database=True, seatbelt=True)
        self.assertIn("the project is your working folder, at its own path, and read only", said)
        self.assertIn("private temporary folder ($TMPDIR; /tmp itself is closed, so here-documents (<<) fail", said)
        self.assertNotIn("/mnt", said)
        self.assertIn("$DGC_READONLY_DATABASE_URL", said)
        self.assertEqual(troupe_agent.verifier_role(shell=True, database=False),
                         troupe_agent.VERIFIER_SHELL.format(database=troupe_agent.VERIFIER_NO_DATABASE),
                         "Linux's verifier is told what it was")

    def test_a_checker_told_why_a_write_failed_on_a_mac_is_pointed_at_its_folder(self):
        from dgc import tools
        with patch.object(tools.sys, "platform", "darwin"):
            said = tools._explain_sandbox_denial("exit code: 1\nbash: x: Operation not permitted", 1, True, checker=True)
        self.assertIn("only your private temporary folder ($TMPDIR) is writable", said)


class TroupeStageTests(AgentCase):
    def test_a_mac_checker_stage_gets_the_database_without_a_relay_and_its_folder_is_removed(self):
        from dgc.agent import Agent
        agent = self.make_agent(ultra=True)
        url = "postgresql://ro:hunter2@127.0.0.1:5433/erp"
        made = []

        def prepare(root, database):
            folder = tempfile.mkdtemp(prefix="dgc-box-test-")
            made.append(folder)
            return ({"hidden": [], "env": {readonly_database.ENV: url}, "secrets": ["hunter2"],
                     "seatbelt": {"tmp": folder, "ports": [5433]}}, None, "")
        run, calls = fake_child(lambda prompt, workspace: '```json\n{"real": true, "why": "ran it"}\n```'
                                if "Review this" not in prompt else
                                '```json\n{"findings": [{"title": "Stuck invoice", "where": "db", "why": "x"}]}\n```')
        with patch.object(checker_box, "prepare", side_effect=prepare), \
                patch.object(Agent, "_execute_prepared_subagent", run):
            self.assertIn("State: done", troupe_agent.start(agent, REVIEW, "c1"))
        verifier = next(c for c in calls if c["prompt"].startswith("You are a verifier"))
        self.assertIn("$DGC_READONLY_DATABASE_URL", verifier["prompt"], "a database with no relay is still there")
        self.assertIn("($TMPDIR", verifier["prompt"])
        self.assertTrue(made and not any(os.path.exists(folder) for folder in made), "released after the stage")


# ---- the real box, on a Mac ---------------------------------------------------------------------------------------
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
                client.sendall(b"db:" + client.recv(1024))

    def close(self):
        self.server.close()


@unittest.skipUnless(MAC, "a Mac's sandbox-exec")
class RealMacBoxTests(Project):
    def run_boxed(self, command, settings):
        argv = checker_box.wrap(command, self.root, settings)
        env = sandbox.process_env(Cfg(settings))
        return subprocess.run(argv, capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL, env=env,
                              cwd=str(self.root))

    def test_it_reads_the_project_writes_only_its_folder_and_hides_credentials_and_the_home(self):
        settings, _ = self.box()
        result = self.run_boxed(
            "echo read=$(cat app.py);"
            " (echo x > app.py) 2>&1 | sed 's/^/write project: /';"
            " (echo y > /tmp/dgc-mac-box-probe) 2>&1 | sed 's/^/write tmp: /';"
            " echo ok > \"$TMPDIR/scratch\" && echo tmpdir=$(cat \"$TMPDIR/scratch\");"
            " (cat .env) 2>&1 | sed 's/^/env: /'; (ls .git) 2>&1 | sed 's/^/git: /';"
            " (cat config/server.pem) 2>&1 | sed 's/^/pem: /';"
            f" (ls {Path.home()}) 2>&1 | sed 's/^/home: /'; (ls /private/var/folders) 2>&1 | sed 's/^/folders: /'",
            settings)
        lines = result.stdout.splitlines()
        self.assertEqual(lines[0], "read=print('erp')", result.stderr)
        self.assertEqual(lines[3], "tmpdir=ok", "its private folder is the one writable place")
        for line, label in zip(lines[1:3] + lines[4:], ("write project: ", "write tmp: ", "env: ", "git: ", "pem: ",
                                                        "home: ", "folders: ")):
            self.assertTrue(line.startswith(label) and line.endswith("Operation not permitted"), lines)
        self.assertEqual((self.root / "app.py").read_text(), "print('erp')\n")
        self.assertFalse(os.path.exists("/tmp/dgc-mac-box-probe"))

    def test_it_reaches_only_the_local_ports_it_is_given(self):
        echo, other = Echo(), Echo()
        self.addCleanup(echo.close)
        self.addCleanup(other.close)
        settings, _ = self.box(readonly_database.parse(f"postgresql://ro:hunter2@localhost:{echo.port}/erp"))
        unix = self.root / "s.sock"                     # in the readable project: only the network rule stops it
        listener = socket.socket(socket.AF_UNIX)
        listener.bind(str(unix))
        listener.listen(1)
        self.addCleanup(listener.close)
        (self.root / "probe.py").write_text(
            "import os, socket\nfrom urllib.parse import urlsplit\n"
            "url = urlsplit(os.environ['DGC_READONLY_DATABASE_URL'])\n"
            "s = socket.create_connection((url.hostname, url.port), 5); s.sendall(b'select 1'); print(s.recv(100).decode())\n"
            "def tried(what, connect):\n"
            "    try:\n        connect(); print(what, 'yes')\n"
            "    except OSError as e:\n        print(what, 'no', e.errno)\n"
            f"tried('other port', lambda: socket.create_connection(('127.0.0.1', {other.port}), 2))\n"
            "tried('internet', lambda: socket.create_connection(('1.1.1.1', 443), 2))\n"
            f"tried('unix socket', lambda: socket.socket(socket.AF_UNIX).connect({str(unix)!r}))\n")
        result = self.run_boxed("/usr/bin/python3 probe.py", settings)
        self.assertEqual(result.stdout.splitlines(), ["db:select 1", "other port no 1", "internet no 1",
                                                      "unix socket no 1"], result.stderr)

    def test_macos_bash_cannot_make_a_here_document_in_the_box(self):
        # A known limit, written down (checker_box.MAC_LIMITATIONS): bash 3.2 writes one to /var/tmp, which is closed.
        settings, _ = self.box()
        result = self.run_boxed("cat <<< here", settings)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("cannot create temp file for here document", result.stderr)

    def test_no_keychain_no_signals_outside_and_no_launchd_jobs(self):
        settings, _ = self.box()
        sleeper = subprocess.Popen(["/bin/sleep", "60"])
        self.addCleanup(sleeper.wait)
        self.addCleanup(sleeper.kill)
        roots = "/System/Library/Keychains/SystemRootCertificates.keychain"
        find = ["/usr/bin/security", "find-certificate", "-c", "Apple Root CA", roots]
        self.assertEqual(subprocess.run(find, capture_output=True).returncode, 0, "outside the box it is found")
        result = self.run_boxed(f"(kill -TERM {sleeper.pid}) 2>&1 | sed 's/^/kill: /';"
                                f" security find-certificate -c 'Apple Root CA' {roots} >/dev/null 2>&1;"
                                " echo keychain=$?; launchctl submit -l com.dgc.box-test -- /usr/bin/true;"
                                " echo job=$?", settings)
        self.assertIn(f"kill: ({sleeper.pid}) - Operation not permitted", result.stdout)
        self.assertIn("keychain=44", result.stdout, "no Keychain service: a world-readable keychain can't be read")
        self.assertNotIn("job=0", result.stdout, "no launchd job from the box")
        subprocess.run(["/bin/launchctl", "remove", "com.dgc.box-test"], capture_output=True)
        self.assertIsNone(sleeper.poll(), "the process outside the box is untouched")

    def test_a_live_data_run_really_runs_in_the_box(self):
        import http.server
        (self.root / "health").write_text('{"status":"ok","queue":3}\n')
        handler = lambda *a, **k: http.server.SimpleHTTPRequestHandler(*a, directory=str(self.root), **k)
        http.server.SimpleHTTPRequestHandler.log_message = lambda *a, **k: None
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        port = server.server_address[1]
        lines = ["cat app.py", "df -h .", f"curl -s http://127.0.0.1:{port}/health", "wc -c < .env"]
        out = live.run(self.root, lines, approved=live.validate({"schema_version": 1, "commands": lines}))
        self.assertEqual([c["status"] for c in out[:3]], ["ok"] * 3, out)
        self.assertEqual(out[0]["output"], "print('erp')\n")
        self.assertIn("Capacity", out[1]["output"])
        self.assertIn('"queue":3', out[2]["output"])
        self.assertEqual(out[3]["status"], "failed")
        self.assertIn("Operation not permitted", out[3]["output"], "credential files are denied, as from a checker")

    def test_a_program_a_live_data_line_leaves_running_is_stopped(self):
        import time
        line = ('python3 -c "import os,time; pid=os.fork(); (print(pid, flush=True), os._exit(0)) if pid '
                'else (os.setsid(), time.sleep(30))"')
        started = time.monotonic()
        out = live.run(self.root, [line], approved=live.validate({"schema_version": 1, "commands": [line]}))
        self.assertLess(time.monotonic() - started, 20, out)
        left = int(out[0]["output"].split()[0])
        for _ in range(50):
            try:
                os.kill(left, 0)
            except ProcessLookupError:
                break
            time.sleep(0.1)
        else:
            os.kill(left, 9)
            self.fail("the detached program outlived its line")


if __name__ == "__main__":
    unittest.main()
