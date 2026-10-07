"""Pip computers on macOS: one Linux VM per computer through Apple's container tool (pip_container),
and its way out (pip_boxd). Runs anywhere: boxd in-process on temporary sockets; the container tool
replaced by a stand-in script that records what it is asked and answers like the real one (verified
live on a Mac Studio, macOS 26.5.1, container 1.5.0)."""
import json
import os
import queue
import socket
import stat
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import pip_boxd, pip_container
# Imported before any test pretends to be a Mac: urllib.request imports a macOS-only module there.
from dgc import pip_computer_box, pip_screen, pip_computer_files  # noqa: F401

FAKE_CLI = r'''#!/usr/bin/env python3
import json, os, sys
state = os.environ["FAKE_CONTAINER_STATE"]
with open(os.path.join(state, "calls.jsonl"), "a") as log:
    log.write(json.dumps(sys.argv[1:]) + "\n")
args = sys.argv[1:]
def flag(name):
    return os.path.exists(os.path.join(state, name))
if args[:2] == ["system", "status"]:
    print("status running" if flag("system-running") else "apiserver is not running"); sys.exit(0 if flag("system-running") else 1)
if args[:2] == ["system", "start"]:
    open(os.path.join(state, "system-running"), "w").close(); sys.exit(0)
if args[:2] == ["image", "inspect"]:
    sys.exit(0 if flag("image-" + args[2].replace(":", "_")) else 1)
if args[:2] == ["image", "list"]:
    names = [n[6:].replace("_", ":", 1) for n in os.listdir(state) if n.startswith("image-")]
    print(json.dumps([{"configuration": {"descriptor": {"annotations": {"com.apple.containerization.image.name": n}}}} for n in names])); sys.exit(0)
if args[:2] == ["image", "delete"]:
    os.unlink(os.path.join(state, "image-" + args[2].replace(":", "_"))); sys.exit(0)
if args[0] == "build":
    if flag("build-fails"):
        print("#5 [1/2] RUN apt-get update"); print("E: Unable to fetch some archives"); sys.exit(1)
    print("#4 [1/2] FROM docker.io/library/debian:trixie-slim"); print("#5 [2/2] RUN apt-get update")
    open(os.path.join(state, "image-" + args[args.index("-t") + 1].replace(":", "_")), "w").close(); sys.exit(0)
if args[0] == "run" and "--version" in args:
    print("Google Chrome 155.0.8059.39"); sys.exit(0)
if args[0] == "run":
    open(os.path.join(state, "running"), "w").close(); print(args[args.index("--name") + 1]); sys.exit(0)
if args[:2] == ["list", "--all"]:
    path = os.path.join(state, "containers.json")
    print(open(path).read() if os.path.exists(path) else "[]"); sys.exit(0)
if args[0] == "inspect":
    print('[{"status":"running"}]' if flag("running") else "[]"); sys.exit(0 if flag("running") else 1)
if args[0] == "delete":
    try:
        os.unlink(os.path.join(state, "running"))
    except OSError:
        pass
    sys.exit(0)
sys.exit(0)
'''


class FakeContainerTests(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp(prefix="pc"))
        self.addCleanup(__import__("shutil").rmtree, self.base, True)
        self.state = self.base / "state"
        self.state.mkdir()
        tool = self.base / "container"
        tool.write_text(FAKE_CLI.replace("#!/usr/bin/env python3", "#!" + sys.executable))
        tool.chmod(0o755)
        for target in (patch.dict(os.environ, {"FAKE_CONTAINER_STATE": str(self.state)}),
                       patch.object(pip_container, "cli", lambda: str(tool)),
                       patch.object(pip_container, "home", lambda: self.base / "dgc-desktop"),
                       patch.object(sys, "platform", "darwin"),
                       patch("platform.machine", return_value="arm64"),
                       patch("platform.mac_ver", return_value=("26.5.1", ("", "", ""), "arm64"))):
            target.start()
            self.addCleanup(target.stop)

    def calls(self):
        path = self.state / "calls.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def wait_for_setup(self):
        end = time.monotonic() + 20
        while time.monotonic() < end and pip_container.status()["state"] in ("none", "running"):
            time.sleep(0.05)
        return pip_container.status()


class SupportedTests(unittest.TestCase):
    """Apple's tool runs on Apple silicon with macOS 26 or later; anything else is said plainly."""

    def test_what_a_mac_needs(self):
        with patch.object(sys, "platform", "linux"):
            self.assertEqual(pip_container.supported()[0], False)
        cases = [("x86_64", "26.5", "/usr/local/bin/container", "Apple silicon"),
                 ("arm64", "15.6", "/usr/local/bin/container", "macOS 26 or later"),
                 ("arm64", "26.5", None, "github.com/apple/container"),
                 ("arm64", "26.5", "/usr/local/bin/container", "")]
        for machine, version, tool, why in cases:
            with self.subTest(machine=machine, version=version), patch.object(sys, "platform", "darwin"), \
                    patch("platform.machine", return_value=machine), \
                    patch("platform.mac_ver", return_value=(version, ("", "", ""), machine)), \
                    patch.object(pip_container, "cli", lambda tool=tool: tool):
                ok, reason = pip_container.supported()
                self.assertEqual(ok, not why)
                self.assertIn(why, reason)


class SetupTests(FakeContainerTests):
    def test_setting_up_starts_the_service_builds_the_image_and_says_chrome(self):
        self.assertEqual(pip_container.status()["state"], "none")
        self.assertTrue(pip_container.due())
        self.assertTrue(pip_container.start_setup())
        done = self.wait_for_setup()
        self.assertEqual((done["state"], done["chrome"]), ("ready", "155.0.8059.39"))
        calls = self.calls()
        self.assertIn(["system", "start", "--enable-kernel-install"], calls, "the service and its kernel, once")
        build = next(c for c in calls if c[0] == "build")
        self.assertEqual(build[build.index("-t") + 1], pip_container.image())
        dockerfile = (self.base / "dgc-desktop" / "build" / "Dockerfile").read_text()
        self.assertIn(pip_container.GOOGLE_KEY_FINGERPRINT, dockerfile, "Chrome only through Google's pinned key")
        self.assertIn("curl", dockerfile.split("apt-get purge", 1)[0], "the Terminal keeps curl")
        self.assertNotIn("curl", dockerfile.split("apt-get purge", 1)[1].split("&&")[0])
        self.assertFalse(pip_container.due(), "nothing to do once it is ready")

    def test_a_failed_build_says_why_and_is_retried_after_an_hour(self):
        (self.state / "system-running").touch()
        (self.state / "build-fails").touch()
        pip_container.start_setup()
        failed = self.wait_for_setup()
        self.assertEqual(failed["state"], "failed")
        self.assertIn("Unable to fetch", failed["error"])
        self.assertFalse(pip_container.due(), "not again at once")
        status = json.loads((self.base / "dgc-desktop" / "status.json").read_text())
        status["at"] -= 3700
        (self.base / "dgc-desktop" / "status.json").write_text(json.dumps(status))
        self.assertTrue(pip_container.due(), "after an hour")

    def test_an_older_dgcs_image_is_deleted_and_a_new_dockerfile_builds_again(self):
        (self.state / "system-running").touch()
        (self.state / "image-dgc-pip-computer_oldtag12345").touch()
        pip_container.start_setup()
        self.wait_for_setup()
        self.assertFalse((self.state / "image-dgc-pip-computer_oldtag12345").exists())
        with patch.object(pip_container, "DOCKERFILE", pip_container.DOCKERFILE + "# changed\n"):
            self.assertEqual(pip_container.status()["state"], "none", "a changed image is set up again")


class ComputerTests(FakeContainerTests):
    def setUp(self):
        super().setUp()
        (self.state / "system-running").touch()
        (self.state / ("image-" + pip_container.image().replace(":", "_"))).touch()
        self.root = self.base / "computers" / "pip_x"
        (self.root / "home" / "Files").mkdir(parents=True)
        self.sockets = self.base / "s"
        self.computer = pip_container.Computer(self.root, self.base / "egress.sock", self.sockets)
        self.addCleanup(self.computer.stop)

    def test_the_vm_has_no_network_its_home_and_three_sockets_out(self):
        with patch.object(pip_container, "_host_timezone", lambda: "Asia/Kolkata"), \
                patch.object(pip_container, "START_SECONDS", 0.2):
            self.computer.start()
        run = next(c for c in self.calls() if c[0] == "run")
        value = lambda flag: [run[i + 1] for i, a in enumerate(run) if a == flag]
        self.assertEqual(value("--network"), ["none"], "no network of its own")
        self.assertEqual((value("--memory"), value("--cpus")), ([pip_container.MEMORY], [pip_container.CPUS]))
        self.assertEqual(value("--env"), ["LANG=C.UTF-8", "TZ=Asia/Kolkata"])
        self.assertEqual(value("--volume"), [f"{self.root / 'home'}:/home/pip"], "only its own home")
        self.assertTrue(all(m.endswith(",readonly") for m in value("--mount")), value("--mount"))
        published = value("--publish-socket")
        self.assertEqual([p.split(":")[1] for p in published], [f"/run/dgc/sock/{n}.sock" for n in ("pool", "events", "vnc")])
        self.assertTrue(all(len(p.split(":")[0]) < 104 for p in published), "macOS socket paths stay short")
        self.assertTrue((self.root / "vm" / "conf" / "desktop.sh").is_file(), "the same desktop as on Linux")
        self.assertTrue((self.root / "vm" / "boxd" / "pip_boxd.py").is_file())
        boxd = next(c for c in self.calls() if c[0] == "exec" and "--detach" in c)
        self.assertEqual(boxd[boxd.index("--user") + 1], "pip", "boxd runs as the computer's user")
        self.computer.stop()
        self.assertIn(["delete", "--force", self.computer.name], self.calls())

    def test_vms_a_stopped_dgc_left_are_deleted_and_nothing_else(self):
        listing = [{"configuration": {"id": "dgc-pip-0123456789ab", "labels": {"dgc.pip-computer": "1"}}},
                   {"configuration": {"id": "buildkit", "labels": {"com.apple.container.plugin": "builder"}}},
                   {"configuration": {"id": "dgc-pip-mine", "labels": {"dgc.pip-computer": "1"}}},
                   {"configuration": {"id": "dgc-pip-someone", "labels": {}}}]
        (self.state / "containers.json").write_text(json.dumps(listing))
        mine = pip_container.Computer(self.root, self.base / "egress.sock", self.sockets)
        mine.name, mine._started = "dgc-pip-mine", True
        with patch.dict(pip_container._COMPUTERS, {"k": mine}, clear=True):
            self.assertEqual(pip_container.reap_orphans(), ["dgc-pip-0123456789ab"])
        deleted = [c[2] for c in self.calls() if c[:2] == ["delete", "--force"]]
        self.assertEqual(deleted, ["dgc-pip-0123456789ab"], "not the builder, not ours, not an unlabelled one")

    def test_chrome_keeps_its_own_sandbox_and_goes_out_only_through_boxd(self):
        box = pip_container.ContainerBox.__new__(pip_container.ContainerBox)
        box.viewport, box.on_screen = (1280, 800), False
        headless = box.chrome_argv()
        self.assertNotIn("--no-sandbox", headless, "the VM allows Chrome's sandbox")
        self.assertIn("--proxy-server=http://127.0.0.1:8899", headless)
        self.assertIn("--headless=new", headless)
        self.assertIn("--disable-blink-features=AutomationControlled", headless)
        box.on_screen = True
        windowed = box.chrome_argv()
        self.assertNotIn("--headless=new", windowed)
        self.assertIn("--no-startup-window", windowed)

    def test_the_pool_splices_each_channel_to_its_own_egress_proxy(self):
        # The Mac side of boxd's pool: an idle connection the VM uses on channel 1 (the browser)
        # reaches the computer's proxy; on channel 2 (the Terminal), the running command's proxy.
        self.sockets.mkdir(mode=0o700)
        pool = socket.socket(socket.AF_UNIX)
        pool.bind(str(self.computer.socket("pool")))
        pool.listen(8)
        heard = {}

        def proxy(path, name):
            server = socket.socket(socket.AF_UNIX)
            server.bind(str(path))
            server.listen(8)

            def serve():
                conn, _ = server.accept()
                heard[name] = conn.recv(100)
                conn.sendall(b"HTTP/1.1 200 OK\r\n\r\n")
            threading.Thread(target=serve, daemon=True).start()
        proxy(self.base / "egress.sock", "browser")
        proxy(self.base / "term.sock", "terminal")
        self.computer.terminal_egress = self.base / "term.sock"
        self.computer._started = True
        for _ in range(2):
            threading.Thread(target=self.computer._offer, daemon=True).start()
        for channel, request in ((b"\x01", b"CONNECT example.com:443"), (b"\x02", b"CONNECT pypi.org:443")):
            conn, _ = pool.accept()
            conn.settimeout(5)
            conn.sendall(channel + request)
            self.assertEqual(conn.recv(100), b"HTTP/1.1 200 OK\r\n\r\n")
        self.assertEqual(heard, {"browser": b"CONNECT example.com:443", "terminal": b"CONNECT pypi.org:443"})
        self.computer._stopped.set()


class MacBranchTests(FakeContainerTests):
    """On a Mac the computer, its screen and its Terminal say what the VM's setup says."""

    def test_capability_desktop_and_terminal_follow_the_setup(self):
        (self.state / "system-running").touch()
        self.assertEqual(pip_computer_box.capability()["reason"], "Setting up its computer. This happens once.")
        self.assertFalse(pip_screen.availability()["available"])
        self.assertIsNone(pip_computer_box.find_chrome())
        self.assertEqual(pip_computer_files.available(), (False, "Setting up its computer. This happens once."))
        pip_container.start_setup()
        self.wait_for_setup()
        self.assertTrue(pip_computer_box.capability()["available"])
        self.assertTrue(pip_screen.availability()["available"])
        self.assertEqual(str(pip_computer_box.find_chrome()), pip_container.CHROME)
        self.assertEqual(pip_computer_files.available(), (True, ""))
        self.assertIsInstance(pip_screen.make_desktop(self.base / "rt", self.base / "c" / "home" / "Files", "Pip",
                                                      egress=self.base / "e.sock"), pip_container.ContainerDesktop)


class BoxdTests(unittest.TestCase):
    """pip_boxd in the VM: local proxy clients take the Mac's idle connections, by channel."""

    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="bd"))
        self.addCleanup(__import__("shutil").rmtree, self.dir, True)
        ports = []
        for _ in range(2):
            s = socket.socket(); s.bind(("127.0.0.1", 0)); ports.append(s.getsockname()[1]); s.close()
        for target in (patch.object(pip_boxd, "SOCKETS", str(self.dir)), patch.object(pip_boxd, "CONTROL", str(self.dir / "control")),
                       patch.object(pip_boxd, "BROWSER_PORT", ports[0]), patch.object(pip_boxd, "TERMINAL_PORT", ports[1]),
                       patch.object(pip_boxd, "CHANNELS", {ports[0]: b"\x01", ports[1]: b"\x02"}),
                       patch.object(pip_boxd, "idle", queue.Queue()), patch.object(pip_boxd, "WAIT_SECONDS", 1)):
            target.start(); self.addCleanup(target.stop)
        self.ports = ports
        pool, events = pip_boxd.listen_unix("pool.sock"), pip_boxd.listen_unix("events.sock")
        for target, args in ((pip_boxd.accept_pool, (pool,)), (pip_boxd.accept_watchers, (events,)),
                             (pip_boxd.serve_port, (ports[0],)), (pip_boxd.serve_port, (ports[1],)), (pip_boxd.read_control, ())):
            threading.Thread(target=target, args=args, daemon=True).start()
        time.sleep(0.2)

    def offer(self):
        conn = socket.socket(socket.AF_UNIX); conn.settimeout(5)
        conn.connect(str(self.dir / "pool.sock"))
        return conn

    def test_each_client_takes_an_idle_connection_and_names_its_channel(self):
        self.assertEqual(stat.S_IMODE(os.stat(self.dir / "pool.sock").st_mode), 0o600)
        mac = [self.offer(), self.offer()]
        time.sleep(0.2)
        for port, channel in ((self.ports[0], b"\x01"), (self.ports[1], b"\x02")):
            client = socket.create_connection(("127.0.0.1", port), timeout=5)
            client.sendall(b"CONNECT example.com:443 HTTP/1.1\r\n\r\n")
            upstream = next(c for c in mac if self._ready(c))
            self.assertEqual(upstream.recv(1), channel)
            self.assertEqual(upstream.recv(100), b"CONNECT example.com:443 HTTP/1.1\r\n\r\n")
            upstream.sendall(b"HTTP/1.1 200 Connection established\r\n\r\n")
            self.assertEqual(client.recv(100), b"HTTP/1.1 200 Connection established\r\n\r\n")
            mac.remove(upstream)

    def test_without_the_mac_a_client_is_closed_not_left_waiting(self):
        client = socket.create_connection(("127.0.0.1", self.ports[0]), timeout=5)
        self.assertEqual(client.recv(10), b"", "no way out: the connection closes")

    def test_the_docks_browser_click_reaches_the_mac(self):
        watcher = socket.socket(socket.AF_UNIX); watcher.settimeout(5)
        watcher.connect(str(self.dir / "events.sock"))
        time.sleep(0.2)
        with open(self.dir / "control", "w") as control:
            control.write("ignored\nbrowser\n")
        self.assertEqual(watcher.recv(64), b"browser\n")

    @staticmethod
    def _ready(conn):
        import select
        return bool(select.select([conn], [], [], 2)[0])


if __name__ == "__main__":
    unittest.main()
