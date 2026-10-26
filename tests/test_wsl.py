"""DGC inside WSL (founder, 2026-10-14: "WSL fixes now"). A Windows user's DGC is a Linux install inside WSL, and four
things differ there: WSL 1 can't box anything, WSL stops a distro when nothing on Windows holds it open, the user's own
Chrome runs on Windows, and notifications are Windows' own.

No Windows machine was reachable, so Windows is faked at its edges, exactly: the kernel's name, WSL's interop entry,
/etc/wsl.conf, the system drive (a folder), and the Windows programs DGC starts (cmd.exe, reg.exe, powershell.exe,
wslg.exe on that drive). The fake PowerShell decodes what DGC sends it and does what that script says, so every script
is checked as Windows would receive it. The relay to Windows' loopback carries a real Chromium's DevTools connection,
and the keep-running script runs for real, down to a real `dgc pips serve --service`."""
import base64
import json
import os
import re
import shutil
import socket
import socketserver
import stat
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import browser, browser_user, pip_computer_box, pip_desktop, pip_execution, pip_keep_running as keep, wsl
from dgc.workspace_registry import RegistryError
from tests.host_python import trust_host_python

REPO = Path(__file__).resolve().parent.parent

# PowerShell, as far as DGC uses it: it decodes -EncodedCommand (UTF-16LE), reads the base64 strings DGC put in the
# script, and does what each of DGC's scripts asks -- a registry value set or removed, a program started, a
# notification, or a relay to 127.0.0.1:PORT -- logging each to $FAKE_WINDOWS/log.jsonl.
FAKE_POWERSHELL = textwrap.dedent('''\
    import base64, json, os, re, socket, sys, threading
    state = os.environ["FAKE_WINDOWS"]
    script = base64.b64decode(sys.argv[sys.argv.index("-EncodedCommand") + 1]).decode("utf-16-le")
    texts = [base64.b64decode(t).decode("utf-8") for t in re.findall(r"FromBase64String\\('([A-Za-z0-9+/=]*)'\\)", script)]
    def log(**entry):
        with open(os.path.join(state, "log.jsonl"), "a") as f:
            f.write(json.dumps({"pid": os.getpid(), **entry}) + "\\n")
    registry_path = os.path.join(state, "registry.json")
    registry = json.load(open(registry_path)) if os.path.exists(registry_path) else {}
    if os.path.exists(os.path.join(state, "fail")):
        sys.exit(1)
    if script.startswith("Set-ItemProperty -Path 'HKCU:\\\\Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Run'"):
        registry[texts[0]] = texts[1]; json.dump(registry, open(registry_path, "w")); log(op="set", name=texts[0], value=texts[1])
    elif script.startswith("Remove-ItemProperty -Path 'HKCU:\\\\Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Run'"):
        registry.pop(texts[0], None); json.dump(registry, open(registry_path, "w")); log(op="remove", name=texts[0])
    elif script.startswith("Start-Process"):
        log(op="start", file=texts[0], arguments=texts[1])
    elif "ToastNotificationManager" in script:
        log(op="toast", title=texts[0], body=texts[1], script=script)
    elif "$client.Connect('127.0.0.1'," in script:
        port = int(re.search(r"Connect\\('127\\.0\\.0\\.1', (\\d+)\\)", script).group(1))
        log(op="relay", port=port)
        try:
            conn = socket.create_connection(("127.0.0.1", port), timeout=5)
        except OSError:
            sys.exit(1)
        conn.settimeout(None)
        def up():
            while True:
                data = sys.stdin.buffer.read1(65536)
                if not data:
                    break
                conn.sendall(data)
            conn.close()
        threading.Thread(target=up, daemon=True).start()
        while True:
            try:
                data = conn.recv(65536)
            except OSError:
                break
            if not data:
                break
            sys.stdout.buffer.write(data); sys.stdout.buffer.flush()
    else:
        log(op="unknown", script=script); sys.exit(2)
''')

# cmd.exe /d /c echo %NAME%: Windows' environment, from $FAKE_WINDOWS/env.json; an unknown name echoes itself.
FAKE_CMD = textwrap.dedent('''\
    import json, os, sys
    env = json.load(open(os.path.join(os.environ["FAKE_WINDOWS"], "env.json")))
    name = sys.argv[-1].removeprefix("echo ").strip("%")
    print(env.get(name, "%" + name + "%"))
''')

# reg.exe query KEY /v NAME: 0 when the value is in the fake registry.
FAKE_REG = textwrap.dedent('''\
    import json, os, sys
    path = os.path.join(os.environ["FAKE_WINDOWS"], "registry.json")
    registry = json.load(open(path)) if os.path.exists(path) else {}
    assert sys.argv[1:3] == ["query", "HKCU\\\\Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Run"], sys.argv
    sys.exit(0 if sys.argv[4] in registry else 1)
''')


class FakeWsl:
    """A WSL 2 distro named Ubuntu-24.04 on a Windows whose C: drive is a folder."""

    def __init__(self, case: unittest.TestCase, *, version="6.6.87.2-microsoft-standard-WSL2", interop=True):
        self.root = Path(tempfile.mkdtemp(prefix="dgc-fake-wsl-")).resolve()
        case.addCleanup(shutil.rmtree, self.root, True)
        self.windows = self.root / "windows-state"
        self.windows.mkdir()
        (self.windows / "env.json").write_text(json.dumps({"LOCALAPPDATA": "C:\\Users\\me\\AppData\\Local",
                                                           "USERPROFILE": "C:\\Users\\me"}))
        self.drive = self.root / "mnt" / "c"
        self.local = self.drive / "Users" / "me" / "AppData" / "Local"
        self.local.mkdir(parents=True)
        (self.root / "osrelease").write_text(version + "\n")
        binfmt = self.root / "binfmt"
        binfmt.mkdir()
        (binfmt / "WSLInterop").write_text(("enabled" if interop else "disabled") + "\ninterpreter /init\n")
        (self.root / "wsl.conf").write_text(f"[automount]\nroot = {self.root / 'mnt'}/\n")
        for parts, source in ((("Windows", "System32", "cmd.exe"), FAKE_CMD), (("Windows", "System32", "reg.exe"), FAKE_REG),
                              (("Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), FAKE_POWERSHELL),
                              (("Program Files", "WSL", "wslg.exe"), "raise SystemExit('never run in a test')\n")):
            path = self.drive.joinpath(*parts)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(f"#!{sys.executable}\n{source}")
            path.chmod(0o755)
        for name, value in (("OSRELEASE", self.root / "osrelease"), ("BINFMT", binfmt), ("WSL_CONF", self.root / "wsl.conf")):
            p = patch.object(wsl, name, value)
            p.start()
            case.addCleanup(p.stop)
        env = patch.dict(os.environ, {"WSL_DISTRO_NAME": "Ubuntu-24.04", "FAKE_WINDOWS": str(self.windows),
                                      "PATH": "/usr/bin:/bin"})
        env.start()
        case.addCleanup(env.stop)
        wsl._ENV_CACHE.clear()
        case.addCleanup(wsl._ENV_CACHE.clear)

    def log(self) -> list[dict]:
        path = self.windows / "log.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def registry(self) -> dict:
        path = self.windows / "registry.json"
        return json.loads(path.read_text()) if path.exists() else {}


class DetectionTests(unittest.TestCase):
    def kernel(self, text):
        path = Path(tempfile.mkdtemp(prefix="dgc-osrelease-")) / "osrelease"
        self.addCleanup(shutil.rmtree, path.parent, True)
        path.write_text(text)
        return patch.object(wsl, "OSRELEASE", path)

    def test_which_wsl_by_the_kernel_it_runs(self):
        for text, expected in (("6.6.87.2-microsoft-standard-WSL2\n", 2), ("5.15.167.4-microsoft-standard-WSL2", 2),
                               ("4.4.0-19041-Microsoft\n", 1), ("6.14.0-1015-nvidia\n", 0), ("6.8.0-45-generic", 0)):
            with self.subTest(text=text), self.kernel(text), patch.dict(os.environ, {"WSL_DISTRO_NAME": ""}):
                self.assertEqual(wsl.version(), expected)
        with patch.object(wsl, "OSRELEASE", Path("/nonexistent/osrelease")):
            self.assertEqual(wsl.version(), 0)

    def test_a_custom_wsl2_kernel_is_known_by_wsls_own_marks(self):
        FakeWsl(self, version="6.6.0-my-own-kernel")
        self.assertEqual(wsl.version(), 2)
        with patch.dict(os.environ, {"WSL_DISTRO_NAME": ""}):
            self.assertEqual(wsl.version(), 0, "a plain Linux with no distro name is not WSL")

    def test_interop_on_off_and_missing(self):
        FakeWsl(self)
        self.assertTrue(wsl.interop())
        (wsl.BINFMT / "WSLInterop").write_text("disabled\n")
        self.assertFalse(wsl.interop())
        (wsl.BINFMT / "WSLInterop").unlink()
        self.assertFalse(wsl.interop())
        (wsl.BINFMT / "WSLInterop-late").write_text("enabled\n")
        self.assertTrue(wsl.interop(), "newer WSL registers it late")

    def test_the_distro_name_is_only_what_windows_accepts(self):
        for name, expected in (("Ubuntu-24.04", "Ubuntu-24.04"), ("Debian", "Debian"), ("bad name", ""),
                               ("a;rm -rf /", ""), ("", ""), ("x" * 65, "")):
            with self.subTest(name=name), patch.dict(os.environ, {"WSL_DISTRO_NAME": name}):
                self.assertEqual(wsl.distro(), expected)

    def test_drives_where_wsl_conf_puts_them(self):
        conf = Path(tempfile.mkdtemp(prefix="dgc-wslconf-")) / "wsl.conf"
        self.addCleanup(shutil.rmtree, conf.parent, True)
        with patch.object(wsl, "WSL_CONF", conf):
            self.assertEqual(wsl.drive_root(), Path("/mnt"), "no file: the default")
            conf.write_text('[automount]\nroot = "/win/"\n')
            self.assertEqual(wsl.system_drive(), Path("/win/c"))
            conf.write_text("[automount\nbroken")
            self.assertEqual(wsl.drive_root(), Path("/mnt"))

    def test_windows_and_linux_paths(self):
        with patch.object(wsl, "WSL_CONF", Path("/nonexistent")):
            self.assertEqual(wsl.linux_path("C:\\Users\\me\\AppData\\Local"), Path("/mnt/c/Users/me/AppData/Local"))
            self.assertEqual(wsl.linux_path("d:\\Data"), Path("/mnt/d/Data"))
            for bad in ("\\\\server\\share\\x", "relative\\path", "C:relative", "", "/home/me"):
                with self.subTest(bad=bad):
                    self.assertIsNone(wsl.linux_path(bad))
            self.assertEqual(wsl.windows_path(Path("/mnt/c/Program Files/WSL/wslg.exe")), "C:\\Program Files\\WSL\\wslg.exe")
            self.assertEqual(wsl.windows_path(Path("/home/me/x")), "")
            self.assertEqual(wsl.windows_path(Path("/mnt/wsl/x")), "", "not a drive letter")
            self.assertTrue(wsl.on_windows_drive(Path("/mnt/c/Users")))
            self.assertFalse(wsl.on_windows_drive(Path("/home")))

    def test_networking_mode_from_wslinfo(self):
        tools = Path(tempfile.mkdtemp(prefix="dgc-wslinfo-"))
        self.addCleanup(shutil.rmtree, tools, True)
        with patch.dict(os.environ, {"PATH": str(tools)}), patch.object(wsl, "WSLINFO", str(tools / "absent")):
            self.assertEqual(wsl.networking_mode(), "", "an older WSL without wslinfo")
            tool = tools / "wslinfo"
            tool.write_text("#!/bin/sh\n[ \"$1\" = --networking-mode ] && echo mirrored\n")
            tool.chmod(0o755)
            self.assertEqual(wsl.networking_mode(), "mirrored")
            tool.write_text("#!/bin/sh\necho 'not; a mode'\n")
            self.assertEqual(wsl.networking_mode(), "")


class WindowsSideTests(unittest.TestCase):
    def test_windows_programs_are_found_on_the_drive_and_not_without_interop(self):
        fake = FakeWsl(self)
        self.assertEqual(wsl.windows_program("powershell.exe"),
                         fake.drive / "Windows" / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe")
        self.assertEqual(wsl.windows_program("wslg.exe"), fake.drive / "Program Files" / "WSL" / "wslg.exe")
        self.assertIsNone(wsl.windows_program("nothing.exe"))
        (wsl.BINFMT / "WSLInterop").write_text("disabled\n")
        self.assertIsNone(wsl.windows_program("powershell.exe"), "interop off: nothing on Windows can be started")

    def test_windows_environment_through_cmd(self):
        FakeWsl(self)
        self.assertEqual(wsl.windows_env("LOCALAPPDATA"), "C:\\Users\\me\\AppData\\Local")
        self.assertEqual(wsl.windows_env("NOT_SET_ANYWHERE"), "", "cmd echoes an unknown name back")
        self.assertEqual(wsl.windows_env("A&calc"), "", "never a name cmd could read as a command")

    def test_text_reaches_powershell_as_data_never_as_script(self):
        hostile = "x') ; Remove-Item -Recurse C:\\ ; ('\n$(evil) `n \u00e9\u4e2d"
        expression = wsl.ps_text(hostile)
        self.assertNotIn("Remove-Item", expression)
        encoded = re.search(r"FromBase64String\('([^']*)'\)", expression).group(1)
        self.assertEqual(base64.b64decode(encoded).decode("utf-8"), hostile)
        FakeWsl(self)
        argv = wsl.powershell_argv("Write-Output 1")
        self.assertEqual(argv[1:6], ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"])
        self.assertEqual(base64.b64decode(argv[-1]).decode("utf-16-le"), "Write-Output 1")

    def test_the_relay_script_only_takes_a_port(self):
        self.assertIn("$client.Connect('127.0.0.1', 9222)", wsl.relay_script(9222))
        for bad in (0, 65536, -1, "9222", 9222.0):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                wsl.relay_script(bad)

    def test_the_toast_carries_its_words_as_data(self):
        script = wsl.toast_script("Gmail Pip", "Needs you: 'Send it?'")
        self.assertNotIn("Needs you", script)
        self.assertIn("ToastText02", script)
        self.assertIn("{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe", script)


class Echo(socketserver.BaseRequestHandler):
    def handle(self):
        while True:
            data = self.request.recv(65536)
            if not data:
                return
            self.request.sendall(data)


class RelayTests(unittest.TestCase):
    """windows_loopback, through the PowerShell stand-in (which does what the PowerShell script does)."""

    def setUp(self):
        self.fake = FakeWsl(self)
        self.server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), Echo)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(lambda: (self.server.shutdown(), self.server.server_close()))

    def test_bytes_go_both_ways_whole_and_closing_ends_powershell(self):
        sock = wsl.windows_loopback(self.server.server_address[1], timeout=10)
        payload = os.urandom(3 * 1024 * 1024)
        threading.Thread(target=sock.sendall, args=(payload,), daemon=True).start()
        got = bytearray()
        while len(got) < len(payload):
            chunk = sock.recv(1 << 20)
            self.assertTrue(chunk, "the relay closed early")
            got += chunk
        self.assertEqual(bytes(got), payload, "3 MB out and back, byte for byte")
        relay = [e for e in self.fake.log() if e["op"] == "relay"]
        self.assertEqual([e["port"] for e in relay], [self.server.server_address[1]])
        sock.close()
        deadline = time.monotonic() + 10
        while Path(f"/proc/{relay[0]['pid']}").exists() and time.monotonic() < deadline:
            time.sleep(0.1)
        self.assertFalse(Path(f"/proc/{relay[0]['pid']}").exists(), "PowerShell ends with the connection")

    def test_nothing_listening_on_windows_closes_at_once(self):
        with socketserver.TCPServer(("127.0.0.1", 0), Echo) as free:
            port = free.server_address[1]
        sock = wsl.windows_loopback(port, timeout=10)
        started = time.monotonic()
        self.assertEqual(sock.recv(10), b"")
        self.assertLess(time.monotonic() - started, 8)
        sock.close()

    def test_without_interop_there_is_no_relay(self):
        (wsl.BINFMT / "WSLInterop").write_text("disabled\n")
        with self.assertRaises(OSError):
            wsl.windows_loopback(9222)


@unittest.skipUnless(sys.platform.startswith("linux"), "WSL is Linux: its paths run only there")
class _Echo(socketserver.BaseRequestHandler):
    """A stand-in for Ollama on Windows: answers every request with what it received, upper-cased."""
    def handle(self):
        data = self.request.recv(65536)
        if data:
            self.request.sendall(b"HTTP/1.0 200 OK\r\n\r\n" + data.upper())


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


@unittest.skipUnless(sys.platform.startswith("linux"), "SO_REUSEPORT on loopback, as in WSL")
class ModelOnWindowsTests(unittest.TestCase):
    """DGC on Windows runs in its own distro, where localhost isn't Windows': a model there is bridged."""

    def setUp(self):
        self.windows = socketserver.ThreadingTCPServer(("127.0.0.1", 0), _Echo)
        self.windows.daemon_threads = True
        threading.Thread(target=self.windows.serve_forever, daemon=True).start()
        self.addCleanup(self.windows.server_close)
        self.addCleanup(self.windows.shutdown)
        self.addCleanup(wsl._close_bridges)
        self.port = _free_port()                 # nothing listens here: "WSL's own localhost"
        self.opened = []

    def connect(self, port, timeout=10.0):
        """windows_loopback, here: the relay reaches 'Windows' 127.0.0.1:port, which is the stand-in."""
        self.opened.append(port)
        return socket.create_connection(("127.0.0.1", self.windows.server_address[1]), timeout=timeout)

    def ask(self, payload: bytes) -> bytes:
        with socket.create_connection(("127.0.0.1", self.port), timeout=5) as client:
            client.sendall(payload)
            client.shutdown(socket.SHUT_WR)
            chunks = []
            while chunk := client.recv(65536):
                chunks.append(chunk)
        return b"".join(chunks)

    def test_a_model_on_windows_answers_on_this_distros_localhost(self):
        self.assertTrue(wsl.bridge_windows_port(self.port, connect=self.connect, own_distro=True))
        self.assertTrue(self.ask(b"post /v1/chat/completions").endswith(b"POST /V1/CHAT/COMPLETIONS"))
        self.assertTrue(self.ask(b"get /v1/models").endswith(b"GET /V1/MODELS"), "every connection, carried anew")
        time.sleep(0.2)                          # the next spare
        self.assertEqual(self.opened, [self.port] * 4, "the probe, one spare ready, and the next after each is taken")
        self.assertTrue(wsl.bridge_windows_port(self.port, connect=self.connect, own_distro=True), "once per process")
        self.assertEqual(len(self.opened), 4)

    def test_a_request_takes_a_relay_that_is_already_connected(self):
        """Each relay is a PowerShell (1.2 s to start on Windows 11): one waits connected, and is replaced when taken."""
        slow = []

        def slow_connect(port, timeout=10.0):
            slow.append(time.monotonic())
            time.sleep(0.4)
            return self.connect(port, timeout)
        self.assertTrue(wsl.bridge_windows_port(self.port, connect=slow_connect, own_distro=True))
        time.sleep(0.6)                          # the spare connects while nothing is asked
        started = time.monotonic()
        self.assertTrue(self.ask(b"ping").endswith(b"PING"))
        self.assertLess(time.monotonic() - started, 0.3, "no relay start on the request's own time")

    def test_a_spare_the_server_closed_is_not_used(self):
        self.assertTrue(wsl.bridge_windows_port(self.port, connect=self.connect, own_distro=True))
        time.sleep(0.2)
        spare = socket.socket()
        spare.close()                             # a relay whose remote end went away
        dead_a, dead_b = socket.socketpair()
        dead_b.close()
        spares = wsl._Spares(self.port, self.connect, keep=0)
        spares.ready.append(dead_a)
        relay = spares.take()
        relay.sendall(b"hello")
        relay.shutdown(socket.SHUT_WR)
        self.assertTrue(relay.recv(100).endswith(b"HELLO"), "a fresh relay instead of the dead one")
        relay.close()

    def test_only_in_dgcs_own_distro_and_only_when_needed(self):
        self.assertFalse(wsl.bridge_windows_port(self.port, connect=self.connect, own_distro=False),
                         "a distro of the user's own: their port stays theirs")
        self.assertEqual(self.opened, [])
        with socket.socket() as here:                    # something already answers in WSL
            here.bind(("127.0.0.1", self.port))
            here.listen(1)
            self.assertFalse(wsl.bridge_windows_port(self.port, connect=self.connect, own_distro=True))
        self.assertEqual(self.opened, [], "never asks Windows when this side answers")

    def test_nothing_on_windows_is_remembered_for_a_minute(self):
        def refused(port, timeout=10.0):
            self.opened.append(port)
            raise ConnectionRefusedError("nothing on Windows")
        self.assertFalse(wsl.bridge_windows_port(self.port, connect=refused, own_distro=True))
        self.assertFalse(wsl.bridge_windows_port(self.port, connect=refused, own_distro=True))
        self.assertEqual(len(self.opened), 1, "one PowerShell, not one per model client")

    def test_only_a_loopback_url_in_dgcs_own_distro(self):
        with patch.object(wsl, "bridge_windows_port", return_value=True) as bridge, \
                patch.object(wsl, "version", return_value=2), patch.object(wsl, "OWN_DISTRO_MARK") as mark:
            mark.exists.return_value = True
            self.assertTrue(wsl.bridge_model_url("http://localhost:11434/v1"))
            bridge.assert_called_once_with(11434, own_distro=True)
            self.assertFalse(wsl.bridge_model_url("https://api.example.com/v1"))
            self.assertFalse(wsl.bridge_model_url("http://192.168.1.10:11434/v1"))
            mark.exists.return_value = False
            self.assertFalse(wsl.bridge_model_url("http://127.0.0.1:1234/v1"))
        self.assertEqual(bridge.call_count, 1)


@unittest.skipUnless(sys.platform.startswith("linux"), "WSL is Linux: its paths run only there")
class SignedInChromeTests(unittest.TestCase):
    """The user's Chrome, on Windows, from DGC in WSL."""

    def setUp(self):
        self.fake = FakeWsl(self)
        self.chrome = self.fake.local / "Google" / "Chrome" / "User Data"
        self.chrome.mkdir(parents=True)

    def free_port(self):
        with socketserver.TCPServer(("127.0.0.1", 0), Echo) as free:
            return free.server_address[1]

    def test_windows_browsers_come_first_then_linux_ones(self):
        rows = browser_user.profile_folders()
        self.assertEqual(rows[0], ("Google Chrome", self.chrome))
        names = [name for name, folder in rows if wsl.on_windows_drive(folder)]
        self.assertEqual(names, ["Google Chrome", "Google Chrome Beta", "Microsoft Edge", "Brave", "Chromium"])
        self.assertTrue(any(".config/google-chrome" in folder.as_posix() for _, folder in rows), "WSLg's Chrome after")

    def test_without_interop_every_windows_account_is_looked_at(self):
        (self.fake.drive / "Users" / "Public").mkdir()
        (self.fake.drive / "Users" / "other").mkdir()
        (wsl.BINFMT / "WSLInterop").write_text("disabled\n")
        folders = [folder for _, folder in browser_user.profile_folders() if wsl.on_windows_drive(folder)]
        self.assertIn(self.chrome, folders)
        self.assertIn(self.fake.drive / "Users" / "other" / "AppData" / "Local" / "Google" / "Chrome" / "User Data", folders)
        self.assertFalse(any("/Users/Public/" in f.as_posix() for f in folders))

    def test_a_windows_chrome_wsl_cannot_reach_directly_goes_through_powershell(self):
        port = self.free_port()
        (self.chrome / "DevToolsActivePort").write_text(f"{port}\n/devtools/browser/win-1\n")
        self.assertEqual(browser_user.find_route(), ("Google Chrome", port, "/devtools/browser/win-1", browser_user.THROUGH_WINDOWS))
        self.assertEqual(browser_user.find(), ("Google Chrome", port, "/devtools/browser/win-1"))

    def test_with_interop_off_it_says_both_ways_to_fix_it(self):
        port = self.free_port()
        (self.chrome / "DevToolsActivePort").write_text(f"{port}\n/devtools/browser/win-1\n")
        (wsl.BINFMT / "WSLInterop").write_text("disabled\n")
        with self.assertRaises(browser.BrowserError) as raised:
            browser_user.find_route([("Google Chrome", self.chrome)])
        message = str(raised.exception)
        for words in ("running on Windows", "[interop] enabled=true", "networkingMode=mirrored", "wsl --shutdown"):
            self.assertIn(words, message)

    def test_a_linux_profile_left_by_a_chrome_that_quit_is_still_not_a_chrome(self):
        linux = Path(tempfile.mkdtemp(prefix="dgc-linux-profile-"))
        self.addCleanup(shutil.rmtree, linux, True)
        (linux / "DevToolsActivePort").write_text(f"{self.free_port()}\n/devtools/browser/x\n")
        with self.assertRaises(browser.BrowserError) as raised:
            browser_user.find_route([("Google Chrome", linux)])
        self.assertIn("isn't running", str(raised.exception))


def _chromium():
    root = os.environ.get("PLAYWRIGHT_BROWSERS_PATH")
    builds = sorted(Path(root).glob("chromium-*/chrome-*/chrome"), reverse=True) if root else []
    return builds[0] if builds else None


@unittest.skipUnless(sys.platform.startswith("linux"), "WSL is Linux: its paths run only there")
class LiveRelayTests(unittest.TestCase):
    """A real Chromium stands in for the user's Chrome on Windows: its profile is on the fake C: drive, and WSL's own
    loopback is made unreachable, so DGC must go through the PowerShell relay -- and does a whole session over it."""

    def test_a_signed_in_session_over_the_relay(self):
        binary = _chromium()
        if binary is None:
            self.skipTest("no Chromium here (set PLAYWRIGHT_BROWSERS_PATH)")
        fake = FakeWsl(self)
        profile = fake.local / "Google" / "Chrome" / "User Data"
        profile.mkdir(parents=True)
        page = Path(tempfile.mkdtemp(prefix="dgc-wsl-page-"))
        self.addCleanup(shutil.rmtree, page, True)
        (page / "index.html").write_text("<title>Inbox</title><h1>3 unread</h1>")
        chrome = subprocess.Popen([str(binary), "--headless=new", "--no-sandbox", "--no-first-run", "--disable-gpu",
                                   "--disable-background-networking", "--no-proxy-server", "--remote-debugging-port=0",
                                   f"--user-data-dir={profile}", "about:blank"],
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(lambda: (chrome.kill(), chrome.wait()))
        deadline = time.monotonic() + 30
        while browser_user.active_port(profile) is None and time.monotonic() < deadline:
            time.sleep(0.2)
        port, _ = browser_user.active_port(profile)
        real = socket.create_connection

        def windows_only(address, *args, **kwargs):     # WSL's loopback isn't Windows' (NAT networking)
            if address == ("127.0.0.1", port):
                raise ConnectionRefusedError("WSL's own loopback")
            return real(address, *args, **kwargs)
        with patch.object(browser_user.socket, "create_connection", side_effect=windows_only):
            session = browser_user.UserChromeSession()
            session.navigate((page / "index.html").as_uri())
            lines = session.snapshot()["lines"]
            self.assertIn('- heading level=1 "3 unread" [e1]', lines)
            self.assertEqual(session.browser_name, "Google Chrome on Windows")
            session.close()
        self.assertEqual([e["port"] for e in fake.log() if e["op"] == "relay"], [port])
        self.assertIsNone(chrome.poll(), "the user's Chrome keeps running")


@unittest.skipUnless(sys.platform.startswith("linux"), "WSL is Linux: its paths run only there")
class KeepRunningTests(unittest.TestCase):
    """Keep Pips running, in WSL: Windows starts the runner at sign-in through wslg.exe, from the user's Run list."""

    def setUp(self):
        trust_host_python(self)
        self.fake = FakeWsl(self)
        self.home = Path(tempfile.mkdtemp(prefix="dgc-wsl-home-")).resolve()
        self.addCleanup(shutil.rmtree, self.home, True)
        self.home.chmod(0o700)
        bindir = Path(os.path.realpath(os.path.dirname(sys.executable)))
        self.options = {"python_executable": bindir / Path(sys.executable).name, "package_root": REPO}

    def spec(self):
        return keep._wsl_spec(self.home, **self.options)

    def test_on_writes_the_runner_loop_registers_it_with_windows_and_starts_it(self):
        value = keep.set_on(True, runner_online=False, dgc_home=self.home, **self.options)
        self.assertEqual(value, {"platform": "wsl", "supported": True, "reason": "", "on": True, "starts_at_login": True,
                                 "restarts_after_failure": True, "while_logged_out": False})
        spec = self.spec()
        self.assertEqual(stat.S_IMODE(spec["script"].stat().st_mode), 0o700)
        self.assertTrue(spec["mark"].is_file())
        wslg = "C:\\Program Files\\WSL\\wslg.exe"
        self.assertEqual(self.fake.registry(), {spec["name"]: f'"{wslg}" -d Ubuntu-24.04 --shell-type none -- /bin/sh {spec["script"]}'})
        self.assertRegex(spec["name"], r"^DGC-Pips-Ubuntu-24\.04-[0-9a-f]{12}$")
        starts = [e for e in self.fake.log() if e["op"] == "start"]
        self.assertEqual(starts, [{"pid": starts[0]["pid"], "op": "start", "file": wslg,
                                   "arguments": f"-d Ubuntu-24.04 --shell-type none -- /bin/sh {spec['script']}"}])
        self.assertTrue(keep.status(dgc_home=self.home, **self.options)["on"])

    def test_wslg_is_given_only_the_options_it_has(self):
        """wslg.exe takes --cd, -d, -u, --shell-type and `--` (its own usage, on Windows 11 with WSL 3.0.3). Handed
        --exec, which only wsl.exe has, it showed that usage in a dialog at every sign-in and started nothing."""
        import shlex as _shlex
        words = _shlex.split(self.spec()["arguments"])
        options, command = words[:words.index("--")], words[words.index("--") + 1:]
        known = {"--cd": 1, "-d": 1, "--distribution": 1, "-u": 1, "--user": 1, "--shell-type": 1}
        index = 0
        while index < len(options):
            self.assertIn(options[index], known, f"wslg.exe has no {options[index]}")
            index += 1 + known[options[index]]
        self.assertIn("none", options, "no shell between wslg and the script")
        self.assertEqual(command, ["/bin/sh", str(self.spec()["script"])])

    def test_a_runner_already_running_is_not_started_twice(self):
        keep.set_on(True, runner_online=True, dgc_home=self.home, **self.options)
        self.assertEqual([e for e in self.fake.log() if e["op"] == "start"], [])

    def test_off_unregisters_it_and_never_stops_the_runner(self):
        keep.set_on(True, runner_online=True, dgc_home=self.home, **self.options)
        value = keep.set_on(False, runner_online=True, dgc_home=self.home, **self.options)
        self.assertFalse(value["on"])
        spec = self.spec()
        self.assertFalse(spec["mark"].exists())
        self.assertFalse(spec["script"].exists())
        self.assertEqual(self.fake.registry(), {})
        self.assertEqual([e["op"] for e in self.fake.log()], ["set", "remove"], "nothing was stopped")

    def test_a_value_removed_in_windows_reads_as_off(self):
        keep.set_on(True, runner_online=True, dgc_home=self.home, **self.options)
        (self.fake.windows / "registry.json").write_text("{}")
        self.assertFalse(keep.status(dgc_home=self.home, **self.options)["on"])

    def test_windows_refusing_is_said_and_nothing_claims_on(self):
        (self.fake.windows / "fail").write_text("")
        with self.assertRaises(RegistryError) as raised:
            keep.set_on(True, runner_online=False, dgc_home=self.home, **self.options)
        self.assertEqual(raised.exception.code, "service_manager_error")
        self.assertFalse(keep.status(dgc_home=self.home, **self.options)["on"])

    def test_where_it_cannot_work_it_says_why(self):
        cases = (
            ("4.4.0-19041-Microsoft", {}, "needs WSL 2", "wsl --set-version"),
            (None, {"WSL_DISTRO_NAME": ""}, "can't tell which WSL distro", "Pips view"),
            (None, {}, "interop", "/etc/wsl.conf"),
        )
        for kernel, env, words, more in cases:
            with self.subTest(words=words), patch.dict(os.environ, env):
                if kernel:
                    wsl.OSRELEASE.write_text(kernel + "\n")
                if words == "interop":
                    (wsl.BINFMT / "WSLInterop").write_text("disabled\n")
                value = keep.status(dgc_home=self.home, **self.options)
                self.assertEqual((value["platform"], value["supported"], value["on"]), ("wsl", False, False))
                self.assertIn(words, value["reason"])
                self.assertIn(more, value["reason"])
                with self.assertRaises(RegistryError):
                    keep.set_on(True, runner_online=False, dgc_home=self.home, **self.options)
            wsl.OSRELEASE.write_text("6.6.87.2-microsoft-standard-WSL2\n")
            (wsl.BINFMT / "WSLInterop").write_text("enabled\n")
        (self.fake.drive / "Program Files" / "WSL" / "wslg.exe").unlink()
        self.assertIn("wsl --update", keep.status(dgc_home=self.home, **self.options)["reason"])

    def run_script(self, spec, timeout=60):
        return subprocess.run(["/bin/sh", str(spec["script"])], capture_output=True, timeout=timeout,
                              env={"PATH": "/usr/bin:/bin", "WSL_DISTRO_NAME": "Ubuntu-24.04", "WSL_INTEROP": "/run/WSL/7_interop",
                                   "SECRET_TOKEN": "never-passed-on"})

    def test_the_loop_restarts_a_failed_runner_and_stops_when_it_stops_or_is_turned_off(self):
        calls = self.home / "calls.jsonl"
        stand_in = self.home / "bin" / "python"
        stand_in.parent.mkdir(mode=0o700)
        # Fails once, then exits 0 as `serve --service` does when Pips are off or already running.
        stand_in.write_text(f"#!{os.path.realpath(sys.executable)}\nimport json, os, sys\n"
                            f"open({str(calls)!r}, 'a').write(json.dumps({{'argv': sys.argv[1:], 'env': dict(os.environ)}}) + '\\n')\n"
                            f"n = sum(1 for _ in open({str(calls)!r}))\nsys.exit(1 if n == 1 else 0)\n")
        stand_in.chmod(0o700)
        options = {**self.options, "python_executable": stand_in}
        with patch.object(keep, "WSL_RESTART_SECONDS", 0):
            keep.set_on(True, runner_online=True, dgc_home=self.home, **options)
            spec = keep._wsl_spec(self.home, **options)
        done = self.run_script(spec)
        self.assertEqual(done.returncode, 0, done.stderr)
        runs = [json.loads(line) for line in calls.read_text().splitlines()]
        self.assertEqual(len(runs), 2, "restarted once after failing, stopped when it exited cleanly")
        first = runs[0]
        self.assertEqual(first["argv"][:3], ["-I", "-B", "-c"])
        self.assertEqual(first["argv"][4:], [str(REPO), "pips", "serve", "--service"])
        env = first["env"]
        self.assertEqual((env["HOME"], env["DGC_HOME"], env["WSL_DISTRO_NAME"], env["WSL_INTEROP"]),
                         (str(self.home), str(self.home), "Ubuntu-24.04", "/run/WSL/7_interop"))
        self.assertNotIn("SECRET_TOKEN", env, "nothing else of the environment it started in")
        # Turned off while it runs: a failing runner is not started again.
        calls.unlink()
        stand_in.write_text(f"#!{os.path.realpath(sys.executable)}\nimport os, sys\n"
                            f"open({str(calls)!r}, 'a').write('x\\n')\nos.unlink({str(spec['mark'])!r})\nsys.exit(1)\n")
        done = self.run_script(spec)
        self.assertEqual((done.returncode, calls.read_text()), (0, "x\n"))

    def test_the_real_runner_runs_from_it_and_the_loop_ends_when_pips_are_off(self):
        keep.set_on(True, runner_online=True, dgc_home=self.home, **self.options)
        spec = self.spec()
        # Pips on (the default): the real `dgc pips serve --service` starts from the script and keeps running.
        script = subprocess.Popen(["/bin/sh", str(spec["script"])], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                  start_new_session=True, env={"PATH": "/usr/bin:/bin", "WSL_DISTRO_NAME": "Ubuntu-24.04"})
        try:
            time.sleep(8)
            self.assertIsNone(script.poll(), "the runner keeps running, so the script does")
            children = [p for p in Path("/proc").iterdir() if p.name.isdigit() and (p / "stat").exists()
                        and (p / "stat").read_text().split(") ")[-1].split()[1] == str(script.pid)]
            commands = [(p / "cmdline").read_bytes().split(b"\0") for p in children]
            self.assertTrue(any(c[-4:-1] == [b"pips", b"serve", b"--service"] for c in commands), commands)
        finally:
            os.killpg(script.pid, 15)
            script.wait(timeout=30)
        # Pips off: the runner says so and exits 0, and the loop ends rather than restarting it.
        (self.home / ".dgc").mkdir(exist_ok=True)
        (self.home / ".dgc" / "config.json").write_text(json.dumps({"pips_enabled": False}))
        started = time.monotonic()
        done = self.run_script(spec, timeout=90)
        self.assertEqual(done.returncode, 0, (done.stdout + done.stderr).decode(errors="replace")[-2000:])
        self.assertIn(b"not started", done.stderr)
        self.assertLess(time.monotonic() - started, 60)


@unittest.skipUnless(sys.platform.startswith("linux"), "WSL is Linux: its paths run only there")
class NotificationTests(unittest.TestCase):
    def test_in_wsl_windows_shows_them(self):
        fake = FakeWsl(self)
        self.assertTrue(pip_desktop.available())
        with patch.object(pip_desktop, "_which", side_effect=AssertionError("notify-send is not asked")):
            self.assertTrue(pip_desktop.deliver("Gmail Pip", "Needs you:\n'Send it?' \x07"))
        toast = [e for e in fake.log() if e["op"] == "toast"]
        self.assertEqual([(t["title"], t["body"]) for t in toast], [("Gmail Pip", "Needs you: 'Send it?'")])
        self.assertNotIn("Send it", toast[0]["script"])

    def test_when_windows_refuses_linux_is_tried_and_otherwise_it_is_not_shown(self):
        fake = FakeWsl(self)
        (fake.windows / "fail").write_text("")
        with patch.object(pip_desktop, "_which", return_value=None):
            self.assertFalse(pip_desktop.deliver("Pip", "body"))


@unittest.skipUnless(sys.platform.startswith("linux"), "WSL is Linux: its paths run only there")
class WslOneTests(unittest.TestCase):
    def test_a_pip_computer_and_pip_commands_say_to_switch_to_wsl2(self):
        FakeWsl(self, version="4.4.0-19041-Microsoft")
        computer = pip_computer_box.capability()
        self.assertFalse(computer["available"])
        self.assertIn("`wsl --set-version Ubuntu-24.04 2`", computer["reason"])
        with patch.object(pip_execution, "_runtime", side_effect=OSError("no bwrap")):
            execution = pip_execution.capability()
        self.assertFalse(execution["available"])
        self.assertIn("WSL 1", execution["reason"])
        self.assertIn("`wsl --set-version Ubuntu-24.04 2`", execution["reason"])


class NativeWindowsBrowserTests(unittest.TestCase):
    def test_edge_and_chrome_wherever_windows_installed_them(self):
        found = browser._windows_candidates({"PROGRAMFILES": "D:\\Apps", "PROGRAMFILES(X86)": "D:\\Apps (x86)",
                                             "LOCALAPPDATA": "C:\\Users\\me\\AppData\\Local"})
        as_text = [str(p).replace("/", "\\") for p in found]
        self.assertEqual(as_text[:5], ["D:\\Apps\\Google\\Chrome\\Application\\chrome.exe",
                                       "D:\\Apps (x86)\\Google\\Chrome\\Application\\chrome.exe",
                                       "C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
                                       "D:\\Apps (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
                                       "D:\\Apps\\Microsoft\\Edge\\Application\\msedge.exe"])
        self.assertIn("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", as_text, "the usual places too")
        self.assertEqual(len(as_text), len(set(as_text)))


if __name__ == "__main__":
    unittest.main()
