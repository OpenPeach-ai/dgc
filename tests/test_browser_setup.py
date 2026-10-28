"""Work's own Chrome (reported 2026-10-13): a Chrome you have is used; with none, DGC fetches one (on Linux
the one Pip computers download, on a Mac Google's installer, kept only when Google signed it); where Chrome's
own sandbox can't start, it runs in a bubblewrap box that holds nothing of yours."""
import io
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from dgc import browser, browser_setup

HINT = browser.BrowserError(browser.INSTALL_HINT)
# The fetch tests are about a computer where Chrome can sandbox itself. Where Ubuntu keeps unprivileged user namespaces
# from programs an admin did not install (GitHub's runners), DGC rightly asks for Google's package instead
# (needs_installed_chrome); that branch has its own tests.


class EnsureBrowserTests(unittest.TestCase):
    def test_a_browser_you_have_is_used_and_nothing_is_fetched(self):
        with patch.object(browser, "discover_browser", return_value=Path("/usr/bin/chromium")), \
                patch.object(browser_setup, "own_chrome", return_value=None), \
                patch.object(browser_setup, "fetch") as fetch:
            self.assertEqual(browser.ensure_browser(""), (Path("/usr/bin/chromium"), ""))
        fetch.assert_not_called()

    def test_a_wrong_browser_path_is_said_and_never_replaced_by_a_download(self):
        with patch.object(browser_setup, "fetch") as fetch, self.assertRaisesRegex(browser.BrowserError, "does not exist"):
            browser.ensure_browser("/definitely/not/a/browser")
        fetch.assert_not_called()

    def test_with_none_dgc_fetches_one_and_the_model_is_told_once(self):
        stop = threading.Event()
        with patch.object(browser, "discover_browser", side_effect=HINT), \
                patch.object(browser_setup, "needs_installed_chrome", return_value=False), \
                patch.object(browser_setup, "supported", return_value=(True, "")), \
                patch.object(browser_setup, "fetch", return_value=(Path("/x/chrome"), "DGC downloaded Google Chrome")) as fetch:
            self.assertEqual(browser.ensure_browser("", cancelled=stop), (Path("/x/chrome"), "DGC downloaded Google Chrome"))
        fetch.assert_called_once_with(cancelled=stop)

    def test_where_dgc_cannot_fetch_one_it_says_how_to_install_one(self):
        with patch.object(browser, "discover_browser", side_effect=HINT), \
                patch.object(browser_setup, "needs_installed_chrome", return_value=False), \
                patch.object(browser_setup, "supported", return_value=(False, "DGC fetches Chrome on Linux and macOS for now.")):
            with self.assertRaises(browser.BrowserError) as raised:
                browser.ensure_browser("")
        self.assertIn("Install one from your package manager", str(raised.exception))
        self.assertIn("Linux and macOS", str(raised.exception))

    def test_a_fetch_that_fails_says_why_and_how_to_install_one(self):
        with patch.object(browser, "discover_browser", side_effect=HINT), \
                patch.object(browser_setup, "needs_installed_chrome", return_value=False), \
                patch.object(browser_setup, "supported", return_value=(True, "")), \
                patch.object(browser_setup, "fetch", side_effect=RuntimeError("DGC could not download Chrome: 404.")):
            with self.assertRaises(browser.BrowserError) as raised:
                browser.ensure_browser("")
        self.assertIn("DGC could not download Chrome: 404.", str(raised.exception))
        self.assertIn("browser_path", str(raised.exception))

    def test_dgcs_own_copy_is_found_after_everything_you_have(self):
        empty = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, empty, True)
        with patch.dict(os.environ, {"PATH": empty, "CHROME_PATH": "", "HOME": empty}), \
                patch.object(browser, "_playwright_browsers", return_value=[]), \
                patch.object(browser, "_MAC_CANDIDATES", ()), patch.object(browser, "_WINDOWS_CANDIDATES", ()), \
                patch.object(browser, "_LINUX_CANDIDATES", ()), \
                patch.object(browser_setup, "own_chrome", return_value=Path("/dgc/own/chrome")):
            self.assertEqual(browser.discover_browser(""), Path("/dgc/own/chrome"))
            with patch.object(browser, "_playwright_browsers", return_value=[Path("/pw/chrome")]):
                self.assertEqual(browser.discover_browser(""), Path("/pw/chrome"), "yours first")


class FetchTests(unittest.TestCase):
    def fetch(self, own, *, busy=True, state=None, started=True, wait=5.0, cancelled=None):
        with patch.object(browser_setup, "supported", return_value=(True, "")), \
                patch.object(browser_setup, "own_chrome", side_effect=own), \
                patch.object(browser_setup, "_start", return_value=started), \
                patch.object(browser_setup, "_busy", return_value=busy), \
                patch.object(browser_setup, "status", return_value=state or {"state": "running"}), \
                patch.object(browser_setup, "_refresh_later") as refresh, \
                patch.object(browser_setup, "POLL", 0.01):
            result = browser_setup.fetch(wait=wait, cancelled=cancelled)
        return result, refresh

    def test_one_already_here_is_used_at_once_and_kept_current_in_the_background(self):
        (binary, note), refresh = self.fetch([Path("/own/chrome")])
        self.assertEqual((binary, note), (Path("/own/chrome"), ""))
        refresh.assert_called_once()

    def test_the_first_call_waits_for_the_download_and_says_what_dgc_did(self):
        (binary, note), _ = self.fetch([None, None, None, Path("/own/chrome")])
        self.assertEqual(binary, Path("/own/chrome"))
        self.assertIn("DGC downloaded Google Chrome", note)
        self.assertIn("no Pip's browser, cookies or tabs", note)

    def test_a_download_that_failed_says_why(self):
        with self.assertRaisesRegex(RuntimeError, "DGC could not download Chrome: Updating package lists failed"):
            self.fetch(lambda: None, busy=False, state={"state": "failed", "error": "Updating package lists failed"})

    def test_stop_leaves_the_download_running_and_says_so(self):
        stop = threading.Event()
        stop.set()
        with self.assertRaisesRegex(RuntimeError, "Stopped while DGC was downloading Chrome. The download carries on"):
            self.fetch(lambda: None, cancelled=stop)

    def test_a_slow_download_says_how_far_it_got(self):
        with self.assertRaisesRegex(RuntimeError, r"still downloading Chrome \(10 of 130 MB\)"):
            self.fetch(lambda: None, wait=0, state={"state": "running", "done": 10 * 2**20, "total": 130 * 2**20})

    def test_nothing_to_fetch_is_said(self):
        with self.assertRaisesRegex(RuntimeError, "not in what DGC downloads"):
            self.fetch([None], started=False)

    @unittest.skipUnless(sys.platform.startswith("linux"), "Linux reuses the Pips' download")
    def test_on_linux_it_is_the_pips_download_with_the_whole_desktop_set(self):
        from dgc import pip_screen_setup
        needs = ["tigervnc-standalone-server", pip_screen_setup.CHROME_PACKAGE]
        with patch.object(pip_screen_setup, "wanted", return_value=needs), \
                patch.object(pip_screen_setup, "start") as start:
            self.assertTrue(browser_setup._start())
        start.assert_called_once_with(needs=needs)
        with patch.object(pip_screen_setup, "wanted", return_value=["xterm"]), \
                patch.object(pip_screen_setup, "start") as start:
            self.assertFalse(browser_setup._start(), "the system has Chrome: nothing to fetch")
        start.assert_not_called()


@unittest.skipUnless(sys.platform.startswith("linux"), "the box is bubblewrap, on Linux")
class BoxTests(unittest.TestCase):
    PROFILE = "/tmp/dgc-browser-abc"

    def argv(self, binary, readable=(), root=None, libs=""):
        command = [str(binary), "--headless=new", f"--user-data-dir={self.PROFILE}", "about:blank"]
        with patch.object(browser_setup, "download_root", return_value=root), \
                patch.object(browser_setup, "library_path", return_value=libs):
            return browser.box_argv(Path(binary), self.PROFILE, command, readable)

    def test_the_box_holds_the_system_and_the_profile_and_nothing_of_yours(self):
        home = os.path.expanduser("~")
        argv = self.argv("/usr/lib/chromium/chromium")
        self.assertEqual(argv[:2], ["bwrap", "--unshare-all"])
        self.assertIn("--die-with-parent", argv)
        self.assertEqual(argv[argv.index("--cap-drop") + 1], "ALL")
        self.assertEqual(argv[argv.index("--bind") + 1:argv.index("--bind") + 3], [self.PROFILE, self.PROFILE])
        self.assertEqual([a for a in argv if a == "--bind"], ["--bind"], "only the profile is writable")
        self.assertFalse(any(a == home or a.startswith(home + "/") for a in argv), "the home folder is not in it")
        self.assertEqual(argv[argv.index("/usr/lib/chromium/chromium"):],
                         ["/usr/lib/chromium/chromium", "--headless=new", f"--user-data-dir={self.PROFILE}", "about:blank"])

    def test_dgcs_environment_its_keys_and_tokens_stay_outside(self):
        env = {"OPENAI_API_KEY": "sk-secret", "GITHUB_TOKEN": "ghp_secret", "SSH_AUTH_SOCK": "/run/a.sock", "DISPLAY": ":1",
               "LD_PRELOAD": "/x.so", "LANG": "C.UTF-8", "LC_TIME": "en_GB.UTF-8", "https_proxy": "http://me:pw@p:3128"}
        with patch.dict(os.environ, env):
            argv, kept = self.argv("/usr/lib/chromium/chromium"), browser.box_env()
        self.assertEqual({k: kept[k] for k in ("LANG", "LC_TIME", "https_proxy")},
                         {"LANG": "C.UTF-8", "LC_TIME": "en_GB.UTF-8", "https_proxy": "http://me:pw@p:3128"})
        for name in ("OPENAI_API_KEY", "GITHUB_TOKEN", "SSH_AUTH_SOCK", "DISPLAY", "LD_PRELOAD"):
            self.assertNotIn(name, kept)
        joined = "\n".join(argv)
        for secret in ("sk-secret", "ghp_secret", "/run/a.sock", "me:pw"):
            self.assertNotIn(secret, joined, "nothing secret on a command line every user can read")

    def test_a_browser_right_in_the_home_folder_never_brings_the_folder(self):
        home = Path.home()
        argv = self.argv(str(home / "chrome"))
        rows = [argv[i:i + 3] for i in range(len(argv))]
        self.assertIn(["--ro-bind", str(home / "chrome"), str(home / "chrome")], rows)
        self.assertNotIn(["--ro-bind", str(home), str(home)], rows)

    def test_installed_is_not_enough_bubblewrap_must_be_allowed_to_lend_namespaces(self):
        browser._BOX_PROBE.clear()
        self.addCleanup(browser._BOX_PROBE.clear)
        refused = subprocess.CompletedProcess([], 1)
        with patch.object(browser.shutil, "which", side_effect=lambda name: f"/usr/bin/{name}"), \
                patch.object(browser.os, "stat", return_value=SimpleNamespace(st_size=1, st_mtime=2)), \
                patch.object(browser.subprocess, "run", return_value=refused) as run:
            self.assertFalse(browser.box_available(), "stock Ubuntu: bwrap installed, uid map refused")
            self.assertFalse(browser.box_available())
        self.assertEqual(run.call_count, 2, "a refusal is asked again: the user may have just allowed it")
        with patch.object(browser.shutil, "which", side_effect=lambda name: f"/usr/bin/{name}"), \
                patch.object(browser.os, "stat", return_value=SimpleNamespace(st_size=1, st_mtime=2)), \
                patch.object(browser.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as run:
            self.assertTrue(browser.box_available())
            self.assertTrue(browser.box_available())
        self.assertEqual(run.call_count, 1, "a box that works is asked once")
        probe = run.call_args.args[0]
        self.assertIn("--cap-drop", probe)
        self.assertEqual(probe[probe.index("/usr/bin/unshare"):], ["/usr/bin/unshare", "--user", "--map-root-user",
                                                                    "--mount", "--pid", "--fork", "true"])
        self.assertNotIn("OPENAI_API_KEY", run.call_args.kwargs["env"])

    def test_chromes_own_sandbox_runs_in_the_box(self):
        # The box lends Chrome the user namespaces Ubuntu refuses it; Chrome's sandbox does the containing.
        # (A box running Chrome --no-sandbox shared the network: a page exploit reached the X server.)
        seen = {}
        session = browser.BrowserSession(Path("/usr/lib/chromium/chromium"))
        session._profile = tempfile.mkdtemp(prefix="dgc-browser-")
        self.addCleanup(shutil.rmtree, session._profile, True)

        def started(argv, log):
            seen["argv"] = argv
            return SimpleNamespace(poll=lambda: 1, kill=lambda: None)
        with patch.object(browser, "_start_boxed", side_effect=started), patch.object(browser, "LAUNCH_TIMEOUT", 0.2):
            session._spawn(sandbox=True, box=True)
        command = seen["argv"][seen["argv"].index("/usr/lib/chromium/chromium"):]
        self.assertNotIn("--no-sandbox", command)
        self.assertIn("--disable-dev-shm-usage", command)

    def test_a_chrome_outside_the_system_brings_its_own_folder_read_only(self):
        argv = self.argv("/opt/pw/chromium-1234/chrome-linux/chrome")
        self.assertIn(["--ro-bind", "/opt/pw/chromium-1234/chrome-linux", "/opt/pw/chromium-1234/chrome-linux"],
                      [argv[i:i + 3] for i in range(len(argv))])

    def test_dgcs_own_chrome_brings_its_download_and_libraries(self):
        argv = self.argv("/d/root/opt/google/chrome/chrome", root=Path("/d/root"), libs="/d/root/usr/lib/aarch64-linux-gnu")
        rows = [argv[i:i + 3] for i in range(len(argv))]
        self.assertIn(["--ro-bind", "/d/root", "/d/root"], rows)
        self.assertIn(["--setenv", "LD_LIBRARY_PATH", "/d/root/usr/lib/aarch64-linux-gnu"], rows)

    def test_a_page_dgc_wrote_is_readable_and_nothing_else(self):
        argv = self.argv("/usr/bin/chromium", readable=("/tmp/dgc-made-x",))
        self.assertIn(["--ro-bind", "/tmp/dgc-made-x", "/tmp/dgc-made-x"], [argv[i:i + 3] for i in range(len(argv))])

    def test_only_a_sandbox_refusal_is_a_reason_to_box_it(self):
        for log in ("[FATAL] No usable sandbox! Update your kernel", "The SUID sandbox helper binary was found, but is not "
                    "configured correctly", "FATAL:sandbox/linux/suid/client/setuid_sandbox_host.cc:172"):
            self.assertTrue(browser.sandbox_refused(log), log)
        self.assertFalse(browser.sandbox_refused("Segmentation fault"))

    @unittest.skipUnless(shutil.which("bwrap"), "needs bubblewrap")
    def test_inside_the_box_there_is_no_secret_and_no_home(self):
        profile = tempfile.mkdtemp(prefix="dgc-browser-")
        self.addCleanup(shutil.rmtree, profile, True)
        sh = shutil.which("sh")
        # Chrome's environment and the box's process 1 (bwrap's own, which Chrome could read): neither has it.
        script = ('env; tr "\\0" "\\n" < /proc/1/environ; '
                  'for p in "$1" "$1/.ssh" "$1/.dgc"; do [ -e "$p" ] && echo "SEEN $p"; done; true')
        with patch.dict(os.environ, {"OPENAI_API_KEY": "sk-planted-secret", "LANG": "C.UTF-8"}):
            argv = browser.box_argv(Path(sh), profile, [sh, "-c", script, "sh", os.path.expanduser("~")])
            with open(os.path.join(profile, "out"), "wb") as out:          # started the way a browser's box is
                browser._start_boxed(argv, out).wait(timeout=30)
            ran = SimpleNamespace(returncode=0, stdout=Path(profile, "out").read_text(), stderr="")
        if "LANG=" not in ran.stdout:
            self.skipTest("bubblewrap cannot run here: " + ran.stdout[:120])
        self.assertNotIn("sk-planted-secret", ran.stdout)
        self.assertNotIn("SEEN", ran.stdout, "the home folder is not in the box")
        self.assertIn("LANG=C.UTF-8", ran.stdout)
        self.assertIn(f"HOME={profile}", ran.stdout)

    @unittest.skipUnless(shutil.which("bwrap"), "needs bubblewrap")
    def test_a_box_outlives_the_tool_call_that_started_it_but_never_dgc(self):
        profile = tempfile.mkdtemp(prefix="dgc-browser-")
        self.addCleanup(shutil.rmtree, profile, True)
        sleep = shutil.which("sleep")
        argv = browser.box_argv(Path(sleep), profile, [sleep, "60"])          # the box a browser gets, around sleep
        probe = subprocess.run(browser.box_argv(Path(shutil.which("true")), profile, ["true"]), capture_output=True, timeout=30)
        if probe.returncode != 0:
            self.skipTest("bubblewrap cannot run here: " + probe.stderr.decode(errors="replace")[:120])
        procs = []
        with open(os.devnull, "wb") as log:
            call = threading.Thread(target=lambda: procs.append(browser._start_boxed(argv, log)))
            call.start()
            call.join()                         # the tool call is over
        time.sleep(1.0)
        try:
            self.assertIsNone(procs[0].poll(), "the box outlives the call that started it")
        finally:
            procs[0].kill()
            procs[0].wait()
        # DGC killed outright (a crash): the box goes with it, instead of a browser left running.
        dgc = subprocess.Popen([sys.executable, "-c", (
            "import os,sys,time; from dgc import browser; "
            f"p = browser._start_boxed({argv!r}, open(os.devnull, 'wb')); print(p.pid, flush=True); time.sleep(60)")],
            stdout=subprocess.PIPE, text=True, env={**os.environ, "PYTHONPATH": str(Path(browser.__file__).parents[1])})
        box = int(dgc.stdout.readline())
        inner = _children(box)
        dgc.kill()
        dgc.wait()
        dgc.stdout.close()
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and any(_alive(pid) for pid in [box, *inner]):
            time.sleep(0.1)
        self.assertFalse(any(_alive(pid) for pid in [box, *inner]), "the box and what ran in it ended with DGC")


def _children(pid: int, tries: int = 50) -> list:
    """Every process under ``pid`` (the box's own pid-1 and what it runs), once they exist."""
    for _ in range(tries):
        found, frontier = [], [pid]
        while frontier:
            parent = frontier.pop()
            try:
                kids = Path(f"/proc/{parent}/task/{parent}/children").read_text().split()
            except OSError:
                kids = []
            found += [int(k) for k in kids]
            frontier += [int(k) for k in kids]
        if len(found) >= 2:
            return found
        time.sleep(0.1)
    return found


def _alive(pid: int) -> bool:
    try:
        with open(f"/proc/{pid}/stat", encoding="utf-8") as handle:
            return handle.read().split(")")[-1].split()[0] != "Z"
    except OSError:
        return False


def _a_real_chromium():
    """A Chromium this machine has (a fetch is never started for a test): yours, or Playwright's build."""
    try:
        return browser.discover_browser("")
    except browser.BrowserError:
        pass
    root = os.environ.get("PLAYWRIGHT_BROWSERS_PATH")
    builds = sorted(Path(root).glob("chromium-*/chrome-*/chrome"), reverse=True) if root else []
    return builds[0] if builds else None


class LiveBrowserTests(unittest.TestCase):
    """A real Chromium, started the way a Work session starts it (its own sandbox, or DGC's box where the system
    refuses that), reads a page from a dev server on localhost and leaves nothing running."""

    def test_a_local_page_is_read_and_nothing_is_left_running(self):
        binary = _a_real_chromium()
        if binary is None:
            self.skipTest("no Chromium on this machine (set PLAYWRIGHT_BROWSERS_PATH)")
        import http.server
        import socketserver
        site = Path(tempfile.mkdtemp(prefix="dgc-site-"))
        self.addCleanup(shutil.rmtree, site, True)
        (site / "index.html").write_text("<title>Pomodoro</title><h1>25:00</h1><button>Start</button>")
        quiet = type("Quiet", (http.server.SimpleHTTPRequestHandler,), {"log_message": lambda *a: None})
        server = socketserver.TCPServer(("127.0.0.1", 0), lambda *a, **k: quiet(*a, directory=str(site), **k))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        session = browser.BrowserSession(binary)
        try:
            session.start()
        except browser.BrowserError as error:
            if "cannot start its sandbox" in str(error):
                self.skipTest(f"neither Chrome's sandbox nor bubblewrap runs here: {error}"[:200])
            if "still starting after" not in str(error):
                raise
            # Slow, not broken (a loaded CI runner took more than 25 s once): DGC's message says to try again, and
            # so does the test, once.
            session = browser.BrowserSession(binary)
            session.start()
        profile = session._profile
        try:
            try:
                loaded = session.navigate(f"http://127.0.0.1:{server.server_address[1]}/")
            except Exception as error:                   # say what the browser said, where only a CI runner fails
                try:
                    log = Path(profile, "launch.log").read_text(errors="replace")[-3000:]
                except OSError:
                    log = "(no launch log)"
                raise AssertionError(f"{binary}: {error!r}\nlaunch.log:\n{log}") from error
            self.assertEqual(loaded, "loaded")
            lines = session.snapshot()["lines"]
            self.assertIn('- heading level=1 "25:00" [e1]', lines)
            self.assertIn('- button "Start" [e2]', lines)
            # Whichever way it started (its own sandbox, or in DGC's box), every page is sandboxed: Chrome says so. That
            # page is Linux's: Chrome on a Mac has no chrome://sandbox (ERR_INVALID_URL), and always runs in Seatbelt.
            if sys.platform.startswith("linux"):
                session.navigate("chrome://sandbox")
                self.assertTrue(any("You are adequately sandboxed." in line for line in session.snapshot()["lines"]),
                                session.snapshot()["lines"])
        finally:
            session.close()
        time.sleep(1.0)
        left = subprocess.run(["pgrep", "-f", profile], capture_output=True, text=True).stdout.split()
        self.assertEqual(left, [], "the browser ended with the session")
        self.assertFalse(os.path.exists(profile), "its throwaway profile is gone")


@unittest.skipUnless(hasattr(os, "killpg"), "process groups")
class HelpersOutlivingTheBrowserTests(unittest.TestCase):
    """Chrome's helpers share its process group; one that outlived it kept writing into the throwaway profile, and
    the profile was left behind (GitHub's ubuntu runner: the network service, a moment after the browser)."""

    def test_closing_ends_a_helper_that_outlives_the_browser_and_removes_the_profile(self):
        profile = tempfile.mkdtemp(prefix="dgc-browser-")
        self.addCleanup(shutil.rmtree, profile, True)
        helper_pid = Path(profile, "helper.pid")
        # The "browser" forks a helper that ignores SIGTERM and writes into the profile until killed, then ends.
        code = ("import os, signal, sys, time\n"
                "p = sys.argv[1]\n"
                "if os.fork() == 0:\n"
                "    signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
                "    open(os.path.join(p, 'helper.pid'), 'w').write(str(os.getpid()))\n"
                "    while True:\n"
                "        os.makedirs(os.path.join(p, 'Default', 'Network'), exist_ok=True)\n"
                "        open(os.path.join(p, 'Default', 'Network', 'Cookies'), 'w').write('x')\n"
                "        time.sleep(0.02)\n"
                "signal.pause()\n")
        proc = subprocess.Popen([sys.executable, "-c", code, profile], start_new_session=True,
                                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(200):
            if helper_pid.exists() and helper_pid.read_text():
                break
            time.sleep(0.02)
        helper = int(helper_pid.read_text())
        self.addCleanup(lambda: os.kill(helper, signal.SIGKILL) if _alive(helper) else None)
        session = browser.BrowserSession(Path("/x/chrome"))
        session._proc, session._profile = proc, profile
        session.close()
        self.assertFalse(_alive(helper), "the helper ended with the browser")
        self.assertFalse(os.path.exists(profile), "its throwaway profile is gone")


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    try:                                     # a zombie no one reaped yet has ended
        with open(f"/proc/{pid}/stat") as stat:
            return stat.read().rsplit(")", 1)[1].split()[0] != "Z"
    except OSError:
        return subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True,
                              text=True).stdout.strip()[:1] not in ("Z", "")


class StartOrderTests(unittest.TestCase):
    """Chrome's own sandbox first; where the system refuses it, DGC's box; bare only when you said so."""

    def start(self, results, *, box=True, allowed=False):
        calls = []

        def spawn(self_, sandbox, box=False):
            calls.append((sandbox, box))
            port, log = results.pop(0)
            return SimpleNamespace(poll=lambda: 0, kill=lambda: None), port, log
        session = browser.BrowserSession(Path("/x/chrome"), allow_unsandboxed=allowed)
        self.addCleanup(session.close)
        with patch.object(browser.BrowserSession, "_spawn", spawn), \
                patch.object(browser, "box_available", return_value=box), \
                patch.object(browser.BrowserSession, "_targets", side_effect=OSError("stop here")):
            try:
                session.start()
            except browser.BrowserError as error:
                return calls, session, str(error)
        return calls, session, ""

    REFUSED = ("", "FATAL: No usable sandbox!")

    def test_chromes_own_sandbox_comes_first(self):
        calls, session, error = self.start([("9222", "")])
        self.assertEqual(calls, [(True, False)])
        self.assertIn("could not reach devtools", error, "it started")
        self.assertFalse(session.boxed)

    def test_where_the_system_refuses_it_the_box_lends_it_what_it_needs(self):
        calls, session, error = self.start([self.REFUSED, ("9222", "")])
        self.assertEqual(calls, [(True, False), (True, True)], "in the box, with Chrome's own sandbox")
        self.assertIn("could not reach devtools", error)
        self.assertTrue(session.boxed)

    def test_a_box_that_fails_is_said_and_nothing_runs_bare_unless_you_said_so(self):
        calls, _, error = self.start([self.REFUSED, ("", "bwrap: setting up uid map: Permission denied")])
        self.assertEqual(calls, [(True, False), (True, True)])
        self.assertIn("bubblewrap box did not start either: bwrap: setting up uid map: Permission denied", error)
        self.assertIn("browser_allow_unsandboxed", error)
        calls, _, error = self.start([self.REFUSED, ("", "bwrap: no"), ("9222", "")], allowed=True)
        self.assertEqual(calls, [(True, False), (True, True), (False, False)], "you allowed it: bare, last")

    def test_without_bubblewrap_it_says_how_to_get_it(self):
        calls, _, error = self.start([self.REFUSED], box=False)
        self.assertEqual(calls, [(True, False)])
        self.assertIn("Install Google Chrome from google.com/chrome", error)

    def test_any_other_failure_is_not_a_reason_to_box_it(self):
        calls, _, error = self.start([("", "Segmentation fault")])
        self.assertEqual(calls, [(True, False)])
        self.assertIn("the browser did not start: Segmentation fault", error)


class MacInstallerTests(unittest.TestCase):
    """Google's installer, opened read-only; its app is kept only when codesign says Google LLC signed it."""

    def setUp(self):
        self.home = Path(tempfile.mkdtemp(prefix="dgc-mac-browser-"))
        self.addCleanup(shutil.rmtree, self.home, True)
        patcher = patch.object(browser_setup, "_mac_home", return_value=self.home / "browser" / "mac")
        patcher.start()
        self.addCleanup(patcher.stop)
        self.signed, self.tag, self.got, self.detached, self.attach_fails = "EQHXZ8M8AV", '"v1"', [], [], False
        self.attached = []

    def urlopen(self, request, timeout=None):
        head = getattr(request, "get_method", lambda: "GET")() == "HEAD"
        self.got.append("HEAD" if head else "GET")
        body = io.BytesIO(b"" if head else b"x" * 4096)
        return SimpleNamespace(__enter__=lambda: None, headers={"ETag": self.tag, "Content-Length": "4096"},
                               read=body.read)

    def run_(self, argv, **kw):
        tool = argv[0]
        if tool == "hdiutil" and argv[1] == "attach":
            self.attached.append(argv[argv.index("-mountpoint") + 1])
        if tool == "hdiutil" and argv[1] == "attach" and self.attach_fails:
            return subprocess.CompletedProcess(argv, 1, "", "hdiutil: attach failed - Resource busy")
        if tool == "hdiutil" and argv[1] == "attach":
            app = Path(argv[argv.index("-mountpoint") + 1]) / browser_setup.MAC_APP / "Contents" / "MacOS"
            app.mkdir(parents=True)
            (app / "Google Chrome").write_text("#!/bin/sh\n")
            os.chmod(app / "Google Chrome", 0o755)
        elif tool == "ditto":
            shutil.copytree(argv[1], argv[2], symlinks=True)
        elif tool == "hdiutil" and argv[1] == "detach":
            self.detached.append(argv[2])
        elif tool == "codesign":
            asked = next(a for a in argv if a.startswith("-R="))
            self.assertIn('"EQHXZ8M8AV"', asked)
            self.assertIn('identifier "com.google.Chrome"', asked)
            return subprocess.CompletedProcess(argv, 0 if self.signed == "EQHXZ8M8AV" else 3, "",
                                               "" if self.signed == "EQHXZ8M8AV" else "test-requirement: code failed to satisfy")
        elif tool == "defaults":
            return subprocess.CompletedProcess(argv, 0, "155.0.8059.40\n", "")
        return subprocess.CompletedProcess(argv, 0, "", "")

    def mounted(self, path):
        return str(path) in self.attached and str(path) not in self.detached

    def install(self):
        class Opened:
            def __init__(inner, request, timeout=None):
                inner.response = self.urlopen(request, timeout)

            def __enter__(inner):
                return inner.response

            def __exit__(inner, *exc):
                return False
        with patch.object(browser_setup.urllib.request, "urlopen", Opened), \
                patch.object(browser_setup.subprocess, "run", side_effect=self.run_), \
                patch.object(browser_setup.os.path, "ismount", side_effect=self.mounted):
            browser_setup._mac_run_logged()          # what a fetch runs: a failure is written down, not raised
        raw = browser_setup._mac_raw_status()
        return str(raw.get("error") or "") if raw.get("state") == "failed" else ""

    def test_googles_signed_chrome_is_kept_and_used(self):
        self.assertEqual(self.install(), "")
        self.assertEqual(len(self.detached), 1, "the installer image is closed again")
        current = browser_setup._mac_current()
        self.assertEqual(current.name, browser_setup.MAC_APP)
        manifest = json.loads((current.parent / "manifest.json").read_text())
        self.assertEqual((manifest["version"], manifest["source"]), ("155.0.8059.40", '"v1"'))
        self.assertFalse((self.home / "browser" / "mac" / "download").exists(), "the installer is not kept")
        with patch.object(browser_setup.sys, "platform", "darwin"):
            self.assertEqual(browser_setup.own_chrome(), current / "Contents" / "MacOS" / "Google Chrome")

    def test_the_same_installer_is_not_downloaded_again(self):
        self.install()
        self.got.clear()
        self.assertEqual(self.install(), "")
        self.assertEqual(self.got, ["HEAD"], "Google serves what DGC has: nothing downloaded")
        self.tag = '"v2"'
        self.got.clear()
        self.install()
        self.assertEqual(self.got, ["HEAD", "GET"], "a new Chrome is")

    def test_a_chrome_google_did_not_sign_is_never_kept(self):
        self.signed = "not set"
        self.assertIn("not signed by Google", self.install())
        self.assertIsNone(browser_setup._mac_current())
        self.assertEqual(list((self.home / "browser" / "mac").glob("v-*")), [], "nothing of it is left")

    def test_the_signature_check_is_one_requirement_macos_checks_itself(self):
        def codesign(rc, said=""):
            return lambda argv, **kw: subprocess.CompletedProcess(argv, rc, "", said)
        for rc, said, ok in ((0, "", True), (3, "test-requirement: code failed to satisfy", False),
                             (1, "a sealed resource is missing or invalid", False)):
            with patch.object(browser_setup.subprocess, "run", side_effect=codesign(rc, said)) as run:
                self.assertEqual(browser_setup._mac_signed_by_google(Path("/x.app")) is True, ok, (rc, said))
            argv = run.call_args.args[0]
            self.assertEqual(argv[:4], ["codesign", "--verify", "--deep", "--strict"])
            self.assertEqual(argv[4], "-R=" + browser_setup.MAC_REQUIREMENT)

    def test_a_failed_weekly_check_waits_an_hour_with_a_copy_in_use(self):
        self.assertEqual(self.install(), "")
        self.tag, self.signed = '"v2"', "not set"
        self.assertIn("not signed by Google", self.install())
        self.assertIsNotNone(browser_setup._mac_current(), "the copy in use stays")
        with patch.object(browser_setup, "_busy", return_value=False):
            self.assertFalse(browser_setup._mac_due(), "not downloaded again at once")
            status = self.home / "browser" / "mac" / "status.json"
            raw = json.loads(status.read_text())
            status.write_text(json.dumps({**raw, "at": time.time() - 3601}))
            self.assertTrue(browser_setup._mac_due(), "after an hour it is")

    def test_an_installer_that_would_not_open_leaves_nothing_mounted_or_in_the_way(self):
        self.attach_fails = True
        self.assertIn("Opening the installer failed", self.install())
        self.assertEqual(len(self.detached), 1, "an attach that failed half way is detached too")
        self.assertIsNone(browser_setup._mac_current())
        self.assertEqual(list((self.home / "browser" / "mac").glob("download-*")), [], "no download folder left")
        self.attach_fails = False
        self.assertEqual(self.install(), "", "the next try is not blocked")


class FetchFailureTests(unittest.TestCase):
    def test_a_download_that_failed_within_the_hour_is_said_not_started_again(self):
        with patch.object(browser_setup, "supported", return_value=(True, "")), \
                patch.object(browser_setup, "own_chrome", return_value=None), \
                patch.object(browser_setup, "_busy", return_value=False), \
                patch.object(browser_setup, "_recent_failure", return_value="Updating package lists failed."), \
                patch.object(browser_setup, "_start") as start:
            with self.assertRaisesRegex(RuntimeError, "Updating package lists failed. It tries again after an hour."):
                browser_setup.fetch()
        start.assert_not_called()

    def test_a_start_that_met_another_lock_check_is_tried_once_more(self):
        own = iter([None, None, None, Path("/own/chrome")])
        busy = iter([False, True])
        with patch.object(browser_setup, "supported", return_value=(True, "")), \
                patch.object(browser_setup, "own_chrome", side_effect=lambda: next(own)), \
                patch.object(browser_setup, "_busy", side_effect=lambda: next(busy, True)), \
                patch.object(browser_setup, "_recent_failure", return_value=""), \
                patch.object(browser_setup, "status", return_value={"state": "none"}), \
                patch.object(browser_setup, "_start", return_value=True) as start, \
                patch.object(browser_setup, "POLL", 0.01):
            binary, note = browser_setup.fetch(wait=5)
        self.assertEqual(binary, Path("/own/chrome"))
        self.assertEqual(start.call_count, 2)

    @unittest.skipUnless(sys.platform.startswith("linux"), "Linux")
    def test_no_download_where_the_chrome_could_not_run(self):
        from dgc import pip_screen_setup
        with patch.object(pip_screen_setup, "supported", return_value=(True, "")), \
                patch.object(browser_setup, "userns_restricted", return_value=True), \
                patch.object(browser, "box_available", return_value=False):
            ok, why = browser_setup.supported()
        self.assertFalse(ok, "bubblewrap missing or not allowed: a Chrome DGC unpacked could not start")
        self.assertIn("Google Chrome's package, installed once, can", why)
        with patch.object(pip_screen_setup, "supported", return_value=(True, "")), \
                patch.object(browser_setup, "userns_restricted", return_value=True), \
                patch.object(browser, "box_available", return_value=True):
            self.assertEqual(browser_setup.supported(), (True, ""))
        with patch.object(pip_screen_setup, "supported", return_value=(False, "This Linux has no apt-get: install it.")):
            ok, why = browser_setup.supported()
        self.assertIn("DGC fetches Chrome with apt, on Debian, Ubuntu and their family", why)

    @unittest.skipUnless(sys.platform.startswith("linux"), "Linux")
    def test_an_interrupted_download_is_tried_again_at_once_a_failed_one_after_an_hour(self):
        from dgc import pip_screen_setup
        status = Path(tempfile.mkdtemp(prefix="dgc-desk-")) / "status.json"
        self.addCleanup(shutil.rmtree, status.parent, True)
        with patch.object(pip_screen_setup, "_status_path", return_value=status):
            for raw, recent in (({"state": "running", "at": time.time() - 7200}, ""),       # DGC exited mid-download
                                ({"state": "failed", "error": "apt said no", "at": time.time() - 600}, "apt said no"),
                                ({"state": "failed", "error": "apt said no", "at": time.time() - 7200}, ""),
                                ({"state": "ready", "at": time.time()}, "")):
                status.write_text(json.dumps(raw))
                self.assertEqual(browser_setup._recent_failure(), recent, raw)

    @unittest.skipUnless(sys.platform.startswith("linux"), "Linux")
    def test_a_home_reached_through_a_symlink_still_finds_dgcs_chrome(self):
        from dgc import pip_screen_setup
        real = Path(tempfile.mkdtemp(prefix="dgc-real-home-"))
        self.addCleanup(shutil.rmtree, real, True)
        link = real.parent / (real.name + "-link")
        link.symlink_to(real)
        self.addCleanup(link.unlink)
        version = real / "v-1"
        (version / "root").mkdir(parents=True)
        (version / "manifest.json").write_text("{}")
        (real / "current").symlink_to("v-1")
        with patch.object(pip_screen_setup, "home", return_value=link):
            self.assertEqual(pip_screen_setup.current_root(), (real / "v-1" / "root").resolve())



@unittest.skipUnless(sys.platform.startswith("linux"), "Linux")
class InstalledChromeTests(unittest.TestCase):
    """A stock Ubuntu (23.10+): only a Chrome an admin installed can sandbox itself, and bubblewrap may not lend the
    namespaces. The browser asks the user, through the model, to install Google's package once; it never works around."""

    def stock(self, restricted=True, box=False):
        from dgc import pip_screen_setup
        return [patch.object(browser_setup, "userns_restricted", return_value=restricted),
                patch.object(browser, "box_available", return_value=box),
                patch.object(pip_screen_setup, "supported", return_value=(True, ""))]

    def test_only_where_it_must_be(self):
        for restricted, box, expected in ((True, False, True), (True, True, False), (False, False, False)):
            patches = self.stock(restricted, box)
            for p in patches:
                p.start()
            try:
                self.assertEqual(browser_setup.needs_installed_chrome(), expected, (restricted, box))
            finally:
                for p in patches:
                    p.stop()

    def test_with_no_browser_the_model_is_given_the_one_command_to_ask_for(self):
        package = Path("/home/u/.dgc/browser/linux/google-chrome-stable_155.0_arm64.deb")
        patches = self.stock() + [patch.object(browser, "discover_browser", side_effect=HINT),
                                  patch.object(browser_setup, "chrome_package", return_value=package)]
        for p in patches:
            p.start()
        self.addCleanup(lambda: [p.stop() for p in patches])
        with self.assertRaises(browser.BrowserError) as raised:
            browser.ensure_browser("")
        said = str(raised.exception)
        self.assertIn(f"`sudo apt update && sudo apt install {package}`", said)
        self.assertIn("Don't run it yourself: it's theirs to run", said)
        self.assertIn("apt checked it against Google's signing key", said)
        self.assertIn("Don't work around this: no browser with --no-sandbox, and no change to browser_allow_unsandboxed", said)

    def test_a_browser_that_cannot_sandbox_itself_leads_to_the_same_request(self):
        refused = browser.BrowserError("Chromium cannot start its sandbox on this system (unprivileged user namespaces are restricted)")
        package = Path("/p/google-chrome-stable_1_arm64.deb")
        patches = self.stock() + [patch.object(browser_setup, "chrome_package", return_value=package)]
        for p in patches:
            p.start()
        self.addCleanup(lambda: [p.stop() for p in patches])
        self.assertIn(f"sudo apt install {package}", browser.install_request_for(refused))
        self.assertEqual(browser.install_request_for(browser.BrowserError("the browser did not start: Segfault")),
                         "the browser did not start: Segfault", "any other failure is said as it was")

    def test_the_tool_asks_and_forgets_the_browser_so_an_installed_chrome_is_used_next(self):
        from dgc import tools
        refused = browser.BrowserError("Chromium cannot start its sandbox on this system")
        session = SimpleNamespace(navigate=lambda url: (_ for _ in ()).throw(refused), close=lambda: None, note="")
        ctx = SimpleNamespace(config={}, cancelled=threading.Event(), tool_owner="stock-ubuntu")
        patches = self.stock() + [patch.object(browser_setup, "chrome_package", return_value=Path("/p/chrome.deb")),
                                  patch.object(tools, "_browser_session", return_value=session)]
        for p in patches:
            p.start()
        self.addCleanup(lambda: [p.stop() for p in patches])
        with tools._BROWSERS_LOCK:
            tools._BROWSERS["stock-ubuntu"] = session
        said = tools.browser_tool({"operation": "open", "url": "http://127.0.0.1:8765/"}, ctx)
        self.assertTrue(said.startswith("error: Chrome can't sandbox itself on this computer"), said)
        self.assertIn("sudo apt install /p/chrome.deb", said)
        self.assertNotIn("stock-ubuntu", tools._BROWSERS, "found again next time")

    def test_an_installed_google_chrome_comes_before_playwrights_where_only_it_can_sandbox(self):
        with patch.object(browser_setup, "userns_restricted", return_value=True), \
                patch("dgc.pip_computer_box._real_binary", side_effect=lambda p: str(p) == "/opt/google/chrome/chrome"), \
                patch.object(browser, "_playwright_browsers", return_value=[Path("/pw/chrome")]), \
                patch.dict(os.environ, {"CHROME_PATH": ""}):
            self.assertEqual(browser.discover_browser(""), Path("/opt/google/chrome/chrome"))
        with patch.object(browser_setup, "userns_restricted", return_value=False), \
                patch.object(browser, "_playwright_browsers", return_value=[Path("/pw/chrome")]), \
                patch.dict(os.environ, {"CHROME_PATH": ""}):
            self.assertEqual(browser.discover_browser(""), Path("/pw/chrome"), "elsewhere, as before")

    def test_the_package_comes_from_googles_list_alone_checked_by_apt_and_is_kept_a_week(self):
        from dgc import pip_screen_setup
        home = Path(tempfile.mkdtemp(prefix="dgc-home-"))
        self.addCleanup(shutil.rmtree, home, True)
        ran = []

        def apt(argv, step, cwd, cancelled):
            ran.append(argv[-1] if argv[-1] != "update" else "update")
            lists = list((home / "browser" / "linux" / "apt" / "parts").glob("*.list"))
            self.assertEqual(len(lists), 1, "Google's repository alone, not the system's")
            line = lists[0].read_text()
            self.assertIn("signed-by=", line)
            self.assertIn(pip_screen_setup.GOOGLE_REPOSITORY, line)
            if argv[-1] == pip_screen_setup.CHROME_PACKAGE:
                deb = cwd / "google-chrome-stable_155.0.8059.39-1_arm64.deb"
                deb.write_bytes(b"deb")
                os.utime(deb, (time.time() - 30 * 24 * 3600,) * 2)       # apt dates it by Google's Last-Modified
        with patch("dgc.config.USER_HOME", home), patch.object(pip_screen_setup, "_google_key", side_effect=lambda t: t.write_text("key")), \
                patch.object(pip_screen_setup, "arch", return_value="arm64"), patch.object(browser_setup, "_run_cancellable", side_effect=apt):
            first = browser_setup.chrome_package()
            again = browser_setup.chrome_package()
        self.assertEqual(first.name, "google-chrome-stable_155.0.8059.39-1_arm64.deb")
        self.assertGreater(first.stat().st_mtime, time.time() - 60, "dated when DGC fetched it, not by Google's upload")
        self.assertEqual(again, first)
        self.assertEqual(ran, ["update", pip_screen_setup.CHROME_PACKAGE], "kept: not downloaded again")
        self.assertFalse((home / "browser" / "linux" / "apt").exists(), "apt's lists are not kept")


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux")
class PipBoxProbeTests(unittest.TestCase):
    """A Pip's computer on a stock Ubuntu: bubblewrap installed but refused. Said, with Ubuntu's own fix; nothing downloaded."""

    def setUp(self):
        from dgc import pip_computer_box
        self.box = pip_computer_box
        pip_computer_box._BOX_PROBE.clear()
        self.addCleanup(pip_computer_box._BOX_PROBE.clear)

    def test_installed_but_refused_says_how_to_turn_on_ubuntus_own_profile(self):
        refused = subprocess.CompletedProcess([], 1, "", "bwrap: setting up uid map: Permission denied\n")
        with patch.object(self.box.shutil, "which", return_value="/usr/bin/bwrap"), \
                patch.object(self.box.os, "stat", return_value=SimpleNamespace(st_size=1, st_mtime=2)), \
                patch.object(self.box.subprocess, "run", return_value=refused) as run, \
                patch("dgc.browser_setup.userns_restricted", return_value=True):
            result = self.box.capability()
            self.box.capability()
        self.assertFalse(result["available"])
        self.assertIn("Turn on Ubuntu's own profile for it, once, in a terminal: sudo apt update && sudo apt install apparmor-profiles", result["reason"])
        self.assertIn("bwrap-userns-restrict", result["reason"])
        self.assertEqual(run.call_count, 2, "a refusal is asked again: the user may have just turned the profile on")
        probe = run.call_args.args[0]
        self.assertEqual(probe[:2], ["/usr/bin/bwrap", "--unshare-all"], "the computer's own isolation, network included")

    def test_elsewhere_bubblewraps_own_words(self):
        refused = subprocess.CompletedProcess([], 1, "", "bwrap: Creating new namespace failed: Operation not permitted\n")
        with patch.object(self.box.shutil, "which", return_value="/usr/bin/bwrap"), \
                patch.object(self.box.os, "stat", return_value=SimpleNamespace(st_size=1, st_mtime=3)), \
                patch.object(self.box.subprocess, "run", return_value=refused), \
                patch("dgc.browser_setup.userns_restricted", return_value=False):
            reason = self.box.capability()["reason"]
        self.assertIn("Creating new namespace failed", reason)


if __name__ == "__main__":
    unittest.main()
