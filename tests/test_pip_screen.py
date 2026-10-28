"""A Pip computer's full screen, like Grok's bots: the desktop box, the viewer's input filter, who
a submit belongs to, and the stream `dgc serve` carries to the editor."""
import base64
import json
import os
import socket
import struct
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import pip_computer, pip_screen, pip_screen_stream
from dgc.workspace_registry import RegistryError

HELLO = b"RFB 003.008\n" + b"\x01" + b"\x01"           # version, security type None, shared
KEY = struct.pack(">BBxxI", 4, 1, 0x61)
POINTER = struct.pack(">BBHH", 5, 1, 40, 50)
UPDATE = struct.pack(">BBHHHH", 3, 1, 0, 0, 1280, 800)
ENCODINGS = struct.pack(">BxH", 2, 2) + struct.pack(">ii", 0, -223)


class ViewerInputTests(unittest.TestCase):
    def test_messages_pass_whole_however_they_are_split(self):
        seen = []
        gate = pip_screen.ClientFilter(on_input=lambda: seen.append(1))
        stream = HELLO + ENCODINGS + UPDATE + KEY + POINTER + struct.pack(">BxxxI", 6, 2) + b"hi"
        out = b"".join(gate.feed(stream[i:i + 3]) for i in range(0, len(stream), 3))
        self.assertEqual(out, stream)
        self.assertEqual(len(seen), 3, "a key, a pointer move and a paste are the user's input")

    def test_while_a_pip_works_the_user_watches(self):
        seen = []
        gate = pip_screen.ClientFilter(watching=lambda: True, on_input=lambda: seen.append(1))
        self.assertEqual(gate.feed(HELLO + KEY + POINTER + UPDATE), HELLO + UPDATE, "screen requests pass; input does not")
        self.assertEqual(seen, [])

    def test_a_message_it_cannot_frame_ends_the_stream(self):
        gate = pip_screen.ClientFilter()
        gate.feed(HELLO)
        with self.assertRaises(ValueError):
            gate.feed(b"\x63" + b"\x00" * 20)

    def test_every_message_the_editors_novnc_sends_passes_whole(self):
        """A user typed a web address on a Pip's screen and it closed: noVNC sends keys as QEMU
        extended key events (255) once Xtigervnc offers them, which the filter could not frame. These
        bytes come from the noVNC the editor ships, so a new message there fails here, not live."""
        import shutil
        import subprocess
        editor = Path(__file__).resolve().parents[1] / "editors" / "vscode"
        node = shutil.which("node")
        if not node or not (editor / "node_modules" / "@novnc" / "novnc" / "core" / "rfb.js").exists():
            self.skipTest("needs node and the editor's node_modules (npm ci in editors/vscode)")
        built = subprocess.run([node, "--input-type=module", "-e", NOVNC_MESSAGES], cwd=editor, stdin=subprocess.DEVNULL,
                               capture_output=True, text=True, timeout=60, check=True).stdout
        messages = [(name, bytes.fromhex(data)) for name, data in (line.split() for line in built.splitlines())]
        self.assertEqual({name for name, _ in messages}, NOVNC_BUILDERS, "a noVNC message without a case here")
        for name, message in messages:
            with self.subTest(message=name):
                seen = []
                gate = pip_screen.ClientFilter(on_input=lambda: seen.append(1))
                stream = HELLO + message + UPDATE
                self.assertEqual(b"".join(gate.feed(stream[i:i + 5]) for i in range(0, len(stream), 5)), stream)
                user_input = name.startswith(("key", "QEMU", "pointer", "extendedPointer", "clientCut", "extendedClipboard"))
                self.assertEqual(len(seen), int(user_input), "keys, the mouse and the clipboard are the user's input")
                watched = pip_screen.ClientFilter(watching=lambda: True)
                self.assertEqual(watched.feed(stream), HELLO + (b"" if user_input else message) + UPDATE)

    def test_a_qemu_message_other_than_keys_ends_the_stream(self):
        gate = pip_screen.ClientFilter()
        gate.feed(HELLO)
        with self.assertRaises(ValueError):
            gate.feed(b"\xff\x01" + b"\x00" * 10)


# noVNC's own message builders (RFB.messages), each called once, printed as "name hex".
NOVNC_BUILDERS = {"keyEvent", "QEMUExtendedKeyEvent", "pointerEvent", "extendedPointerEvent", "clientCutText",
                  "clientCutTextExtended", "extendedClipboardProvide", "extendedClipboardNotify",
                  "extendedClipboardRequest", "extendedClipboardCaps", "setDesktopSize", "clientFence",
                  "enableContinuousUpdates", "pixelFormat", "clientEncodings", "fbUpdateRequest", "xvpOp"}
NOVNC_MESSAGES = r"""
import {JSDOM} from 'jsdom';
const dom = new JSDOM('<!doctype html><body></body>');
for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Image', 'KeyboardEvent', 'MutationObserver', 'Event', 'CustomEvent', 'EventTarget'])
  Object.defineProperty(globalThis, k, {value: k === 'window' ? dom.window : dom.window[k], configurable: true});
const {default: RFB} = await import(process.cwd() + '/node_modules/@novnc/novnc/core/rfb.js');
const m = RFB.messages, text = new TextEncoder().encode('https://example.com');
const calls = {
  keyEvent: s => m.keyEvent(s, 0x61, 1),
  QEMUExtendedKeyEvent: s => m.QEMUExtendedKeyEvent(s, 0x61, 1, 0x1e),
  pointerEvent: s => m.pointerEvent(s, 40, 50, 1),
  extendedPointerEvent: s => m.extendedPointerEvent(s, 40, 50, 1 << 7),
  clientCutText: s => m.clientCutText(s, text),
  clientCutTextExtended: s => m.clientCutText(s, text, true),
  extendedClipboardProvide: s => m.extendedClipboardProvide(s, [1], ['https://example.com']),
  extendedClipboardNotify: s => m.extendedClipboardNotify(s, [1]),
  extendedClipboardRequest: s => m.extendedClipboardRequest(s, [1]),
  extendedClipboardCaps: s => m.extendedClipboardCaps(s, [1, 2, 4, 8, 16], {1: 4096}),
  setDesktopSize: s => m.setDesktopSize(s, 1280, 800, 0, 0),
  clientFence: s => m.clientFence(s, 1 << 31, 'ab'),
  enableContinuousUpdates: s => m.enableContinuousUpdates(s, true, 0, 0, 1280, 800),
  pixelFormat: s => m.pixelFormat(s, 24, true),
  clientEncodings: s => m.clientEncodings(s, [7, -258, -223, -316]),
  fbUpdateRequest: s => m.fbUpdateRequest(s, true, 0, 0, 1280, 800),
  xvpOp: s => m.xvpOp(s, 1, 2),
};
const extra = Object.keys(m).filter(k => !k.startsWith('_') && !(k in calls));
if (extra.length) throw new Error('noVNC message without a case: ' + extra.join(' '));
for (const [name, call] of Object.entries(calls)) {
  const out = [];
  const push = (v, n) => { for (let i = n - 1; i >= 0; i--) out.push((v >>> (8 * i)) & 255); };
  call({sQpush8: v => push(v, 1), sQpush16: v => push(v, 2), sQpush32: v => push(v, 4),
        sQpushBytes: b => out.push(...b), sQpushString: t => { for (const c of t) out.push(c.charCodeAt(0) & 255); }, flush() {}});
  console.log(name, Buffer.from(out).toString('hex'));
}
"""


class DesktopBoxTests(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp())
        self.addCleanup(__import__("shutil").rmtree, self.base, True)

    def test_the_dock_has_three_apps_and_the_browser_icon_only_asks_dgc(self):
        conf = self.base / "conf"
        pip_screen.write_config(conf, "Gmail")
        apps = {p.stem: p.read_text() for p in (conf / "apps").iterdir()}
        self.assertEqual(sorted(apps), ["browser", "files", "terminal"])
        self.assertIn("echo browser > /run/dgc/sock/control", apps["browser"])
        self.assertNotIn("chrome", apps["browser"].lower(), "the dock never starts a browser of its own")
        self.assertIn("pcmanfm /home/pip/Files", apps["files"])
        self.assertIn("cd /home/pip/Files", apps["terminal"])
        rc = (conf / "tint2rc").read_text()
        self.assertIn("panel_position = bottom center horizontal", rc)
        self.assertEqual(rc.count("launcher_item_app"), 3)
        self.assertIn("-rfbport -1", (conf / "desktop.sh").read_text(), "no network listener, only the Unix socket")
        self.assertIn("-nolisten tcp", (conf / "desktop.sh").read_text())

    def test_the_desktop_box_has_no_network_and_only_the_computers_files(self):
        found = {role: Path("/usr/bin") / name for role, name in pip_screen.PROGRAMS.items()}
        with patch.object(pip_screen, "components", return_value={"found": found, "missing": [], "prefix": None}):
            argv = pip_screen.desktop_argv(self.base / "rt", self.base / "Files", "Gmail")
        self.assertIn("--unshare-all", argv)
        binds = [(argv[i + 1], argv[i + 2]) for i, a in enumerate(argv) if a == "--bind"]
        self.assertIn((str(self.base / "Files"), "/home/pip/Files"), binds)
        self.assertFalse(any(src == str(Path.home()) for src, _ in binds), "never the user's own home")
        self.assertNotIn("/run/dgc/egress.sock", argv, "no way online without the computer's egress socket")

    def test_the_desktop_terminal_is_online_only_through_the_computers_egress(self):
        # Like Grok's: the desktop's Terminal app reaches public sites through DGC's egress proxy, the
        # same way out as the browser; the box itself still has no network.
        found = {role: Path("/usr/bin") / name for role, name in pip_screen.PROGRAMS.items()}
        egress = self.base / "egress.sock"
        with patch.object(pip_screen, "components", return_value={"found": found, "missing": [], "prefix": None}):
            argv = pip_screen.desktop_argv(self.base / "rt", self.base / "Files", "Gmail", egress)
        self.assertIn("--unshare-all", argv)
        binds = [(argv[i + 1], argv[i + 2]) for i, a in enumerate(argv) if a in ("--bind", "--ro-bind")]
        self.assertIn((str(egress), "/run/dgc/egress.sock"), binds)
        self.assertIn((str(self.base / "rt" / "forward.py"), "/run/dgc/forward.py"), binds)
        env = {argv[i + 1]: argv[i + 2] for i, a in enumerate(argv) if a == "--setenv"}
        self.assertEqual(env["https_proxy"], "http://127.0.0.1:8899")
        self.assertEqual(env["no_proxy"], "localhost,127.0.0.1")
        conf = self.base / "conf"
        pip_screen.write_config(conf, "Gmail")
        self.assertIn("python3 /run/dgc/forward.py", (conf / "desktop.sh").read_text())

    def test_without_the_programs_dgc_sets_them_up_itself_and_shows_no_install_command(self):
        from dgc import pip_screen_setup
        with patch.object(pip_screen, "components", return_value={"found": {}, "missing": ["Xtigervnc", "tint2"], "prefix": None}), \
                patch.object(pip_screen.shutil, "which", return_value="/usr/bin/bwrap"), \
                patch.object(pip_screen.sys, "platform", "linux"), \
                patch.object(pip_screen_setup, "status", return_value={"state": "running", "error": ""}):
            shown = pip_screen.availability()
        self.assertFalse(shown["available"])
        self.assertEqual((shown["reason"], shown["install"]), ("Setting up this computer's desktop.", ""))

    def test_where_dgc_cannot_set_them_up_it_says_what_to_install(self):
        from dgc import pip_screen_setup
        with patch.object(pip_screen, "components", return_value={"found": {}, "missing": ["Xtigervnc", "tint2"], "prefix": None}), \
                patch.object(pip_screen.shutil, "which", return_value="/usr/bin/bwrap"), \
                patch.object(pip_screen.sys, "platform", "linux"), \
                patch.object(pip_screen_setup, "status", return_value={"state": "unsupported", "error": ""}):
            shown = pip_screen.availability()
        self.assertFalse(shown["available"])
        self.assertIn("Xtigervnc, tint2", shown["reason"])
        self.assertEqual(shown["install"], pip_screen.INSTALL)


class WhoseSubmitTests(unittest.TestCase):
    """With no run, a submit right after the user's own input is theirs; anything else waits."""

    def host(self, quiet_for):
        released, recorded = [], []
        held = types.SimpleNamespace(request_id="r1")
        browser = types.SimpleNamespace(held={"r1": held}, release=released.append)
        host = types.SimpleNamespace(run_id=None, _queued=[held], browser=browser,
                                     user_input_at=time.monotonic() - quiet_for)
        host._record_held = lambda: (recorded.append(host._queued.pop(0)), [])[1]
        return host, released, recorded

    def test_a_submit_right_after_your_click_is_sent(self):
        host, released, recorded = self.host(0.5)
        pip_computer._settle_writes(host)
        self.assertEqual((released, recorded), (["r1"], []))

    def test_a_page_submitting_on_its_own_waits_for_you(self):
        host, released, recorded = self.host(60)
        pip_computer._settle_writes(host)
        self.assertEqual(released, [])
        self.assertEqual(len(recorded), 1, "held as an action to approve")

    def test_during_a_run_the_run_decides(self):
        host, released, recorded = self.host(0.5)
        host.run_id = "run_x"
        pip_computer._settle_writes(host)
        self.assertEqual((released, recorded), ([], []))


class DesktopWithoutBrowserTests(unittest.TestCase):
    """A browser that cannot start does not take the screen down: Terminal and Files still work."""

    def test_the_screen_opens_when_the_browser_fails_to_start(self):
        from dgc.pip_computer_box import BoxError
        root = Path(tempfile.mkdtemp()); self.addCleanup(__import__("shutil").rmtree, root, True)
        closed = []

        def no_browser():
            raise BoxError("Setting up its computer. This happens once.")
        browser = types.SimpleNamespace(display_dir=None, start=no_browser, close=lambda: closed.append(1))
        host = types.SimpleNamespace(lock=threading.RLock(), desktop=None, pip_id="pip_" + "a" * 32, root=root,
                                     proxy=types.SimpleNamespace(path=root / "egress.sock"), browser=browser,
                                     _dock_launch=lambda what: None, _launch=lambda start: start(),
                                     _pump_thread=object())

        class Screen:
            def __init__(self, runtime, files, name, egress=None):
                self.x11_dir = runtime / "x11"
                self.on_launch = None

            def start(self, launch):
                self.started = True

            def running(self):
                return True
        # This machine's kind of screen is the stand-in: a box on Linux, the computer's VM on a Mac. Replacing only
        # Linux's let this test start a real VM on a Mac and leave it running.
        with patch.object(pip_screen, "availability", return_value={"available": True, "reason": ""}), \
                patch.object(pip_screen, "make_desktop", lambda runtime, files, name, egress=None: Screen(runtime, files, name, egress)):
            self.assertTrue(pip_computer.Host.ensure_desktop(host))
        self.assertIsInstance(host.desktop, Screen)
        self.assertTrue(host.desktop.started)
        self.assertEqual(browser.display_dir, host.desktop.x11_dir)
        self.assertGreaterEqual(len(closed), 2, "the failed browser is closed, so the dock or the next step retries")


class BrowserOnTheScreenTests(unittest.TestCase):
    """A Pip's browser steps run Chrome as a window on its screen when the machine can show one, as on
    Grok's bots (headless Chrome names itself HeadlessChrome and Google asked it for a robot check)."""

    def host(self, shown):
        steps = []
        browser = types.SimpleNamespace(navigate=lambda url: steps.append(("open", url)), pump=lambda s: None)
        host = types.SimpleNamespace(lock=threading.RLock(), last_used=0, waiting=False, desktop=None,
                                     browser=browser, _record_held=lambda: [], _frame=lambda label: None,
                                     _read=lambda: "page text")

        def ensure_desktop():
            steps.append("screen")
            if shown is True:
                host.desktop = types.SimpleNamespace(running=lambda: True)
                return True
            if shown is False:
                return False
            raise shown
        host.ensure_desktop = ensure_desktop
        return host, steps

    def test_the_screen_comes_up_before_the_first_browser_step_and_once(self):
        host, steps = self.host(True)
        self.assertEqual(pip_computer.Host.call(host, "open", {"url": "https://example.com/"}), "page text")
        pip_computer.Host.call(host, "open", {"url": "https://example.com/b"})
        self.assertEqual(steps, ["screen", ("open", "https://example.com/"), ("open", "https://example.com/b")])

    def test_without_a_screen_the_browser_still_works_headless(self):
        from dgc.pip_computer_box import BoxError
        for shown in (False, BoxError("no desktop here"), OSError("no display")):
            host, steps = self.host(shown)
            with self.subTest(shown=shown):
                self.assertEqual(pip_computer.Host.call(host, "open", {"url": "https://example.com/"}), "page text")
                self.assertEqual(steps, ["screen", ("open", "https://example.com/")])


class StreamTests(unittest.TestCase):
    """`dgc serve` joins the editor's viewer to the computer's view socket, in base64."""

    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(dir="/tmp"))
        self.addCleanup(__import__("shutil").rmtree, self.dir, True)
        self.path = self.dir / "v.sock"
        self.server = socket.socket(socket.AF_UNIX)
        self.server.bind(str(self.path))
        self.server.listen(1)
        self.addCleanup(self.server.close)
        self.received = []

        def serve():
            client, _ = self.server.accept()
            line = b""
            while not line.endswith(b"\n"):
                line += client.recv(1)
            self.request = json.loads(line)
            client.sendall(b'{"ok": true}\n' + b"RFB 003.008\n")
            while True:
                data = client.recv(1024)
                if not data:
                    break
                self.received.append(data)
                client.sendall(b"echo:" + data)
            client.close()
        threading.Thread(target=serve, daemon=True).start()
        self.events = []
        self.streams = pip_screen_stream.DesktopStreams(lambda kind, **fields: self.events.append((kind, fields)), {})

    def wait(self, check, seconds=5):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline and not check():
            time.sleep(0.02)
        self.assertTrue(check())

    def test_the_viewer_and_the_screen_talk_through_serve_events(self):
        pip = "pip_" + "a" * 32
        with patch("dgc.pip_screen_stream.WorkspaceRegistry"), \
                patch.object(pip_computer, "request_open", return_value={"pip_id": pip, "ready": False}), \
                patch.object(pip_computer, "view_endpoint", return_value={"socket": str(self.path), "token": "t0k"}):
            self.streams.handle({"pip_id": pip, "op": "open"})
            self.wait(lambda: any(k == "pip_desktop_data" for k, _ in self.events))
        self.assertEqual(self.request, {"token": "t0k", "op": "desktop"}, "the token stays in the backend")
        first = [f for k, f in self.events if k == "pip_desktop_data"][0]
        self.assertEqual(base64.b64decode(first["data"]), b"RFB 003.008\n")
        self.streams.handle({"pip_id": pip, "op": "send", "data": base64.b64encode(b"hello").decode()})
        self.wait(lambda: self.received == [b"hello"])
        self.streams.handle({"pip_id": pip, "op": "send", "data": "not base64!!"})
        opened = []
        with patch("dgc.pip_screen_stream.WorkspaceRegistry"), patch.object(pip_screen_stream, "OPEN_SECONDS", 0.2), \
                patch.object(pip_computer, "request_open", side_effect=lambda registry, pip_id, actor: opened.append(pip_id)), \
                patch.object(pip_computer, "view_endpoint", return_value=None):
            self.streams.handle({"pip_id": "../etc", "op": "open"})
            time.sleep(0.5)
        self.assertEqual(opened, [], "a bad id is ignored, never opened")
        self.assertFalse(any(f.get("pip_id") == "../etc" for _, f in self.events))
        self.streams.handle({"pip_id": pip, "op": "close"})
        self.wait(lambda: ("pip_desktop_closed", {"pip_id": pip, "reason": "closed"}) in self.events)
        self.assertEqual(self.received, [b"hello"], "bad input is dropped")

    def test_no_screen_says_why(self):
        pip = "pip_" + "b" * 32
        with patch("dgc.pip_screen_stream.WorkspaceRegistry"), patch.object(pip_screen_stream, "OPEN_SECONDS", 0.3), \
                patch.object(pip_computer, "request_open", return_value={"pip_id": pip, "ready": False}), \
                patch.object(pip_computer, "view_endpoint", return_value=None):
            self.streams.handle({"pip_id": pip, "op": "open"})
            self.wait(lambda: self.events)
        self.assertEqual(self.events[0][0], "pip_desktop_closed")
        self.assertIn("runner", self.events[0][1]["reason"])


class ServeRefusalTests(unittest.TestCase):
    """`dgc serve` refuses a screen exactly where it refuses Pips controls."""

    def test_pips_off_a_restricted_session_and_a_models_shell_are_refused(self):
        from dgc import headless
        owner = next(c for c in (headless.Chat, headless.Backend) if hasattr(c, "_pip_desktop"))
        pip = "pip_" + "a" * 32
        for name, config, env in (("pips off", {"pips_enabled": False}, {}),
                                  ("a model's own shell", {"pips_enabled": True}, {"DGC_AGENT_SHELL": "1"})):
            with self.subTest(name), patch.dict(os.environ, env):
                events = []
                fake = types.SimpleNamespace(em=types.SimpleNamespace(emit=lambda kind, **f: events.append((kind, f))),
                                             config=config)
                with patch("dgc.pip_screen_stream.DesktopStreams") as streams:
                    owner._pip_desktop(fake, {"type": "pip_desktop", "pip_id": pip, "op": "open"})
                self.assertEqual(events[0][0], "pip_desktop_closed")
                streams.assert_not_called()
        events = []
        fake = types.SimpleNamespace(em=types.SimpleNamespace(emit=lambda kind, **f: events.append((kind, f))),
                                     config={"pips_enabled": True})
        with patch("dgc.pip_screen_stream.DesktopStreams") as streams:
            owner._pip_desktop(fake, {"type": "pip_desktop", "pip_id": pip, "op": "open"})
        streams.return_value.handle.assert_called_once()
        self.assertEqual(events, [])


def _drain(sock):
    try:
        while sock.recv(65536):
            pass
    except OSError:
        pass


def _desktop_ready():
    from dgc.pip_computer_box import capability
    return bool(os.environ.get("DGC_DESKTOP_PREFIX") or not pip_screen.components()["missing"]) \
        and pip_screen.availability()["available"] and capability().get("available")


@unittest.skipUnless(_desktop_ready(), "needs Linux, bubblewrap, a Chromium and the desktop programs (or DGC_DESKTOP_PREFIX)")
class RealScreenTests(unittest.TestCase):
    """End to end: a Pip computer's screen with the browser on it, through the view socket."""

    def setUp(self):
        from tests import test_pips_local as fixtures
        fixtures.LocalPipsTests.setUp(self)
        self.addCleanup(pip_computer.stop_all)

    def frame(self, viewer):
        """Speak RFB through the relay and read one whole frame (Raw encoding)."""
        def recv(n):
            data = b""
            while len(data) < n:
                chunk = viewer.recv(n - len(data))
                if not chunk:
                    raise EOFError
                data += chunk
            return data
        recv(12); viewer.sendall(b"RFB 003.008\n")
        count = recv(1)[0]; types_ = recv(count); self.assertIn(1, types_)
        viewer.sendall(b"\x01"); self.assertEqual(struct.unpack(">I", recv(4))[0], 0)
        viewer.sendall(b"\x01")
        width, height = struct.unpack(">HH", recv(4)); recv(16); recv(struct.unpack(">I", recv(4))[0])
        viewer.sendall(struct.pack(">BxxxBBBBHHHBBBxxx", 0, 32, 24, 0, 1, 255, 255, 255, 16, 8, 0))
        viewer.sendall(struct.pack(">BxH i", 2, 1, 0))
        viewer.sendall(UPDATE)
        self.assertEqual(recv(1)[0], 0)
        recv(1); rects = struct.unpack(">H", recv(2))[0]
        pixels = b""
        for _ in range(rects):
            x, y, w, h, encoding = struct.unpack(">HHHHi", recv(12))
            pixels += recv(w * h * 4)
        return width, height, pixels

    def test_the_screen_shows_the_desktop_and_input_waits_while_a_pip_works(self):
        pip = self.store.create(self.registry.personal()["id"], "Shopper", "Shop", "local-console")
        proposal = self.store.propose(pip["id"], 1, {"computer_plan": {"schema_version": 1}}, "local-console")
        self.store.accept(pip["id"], proposal["id"], 1, "local-console")
        host = pip_computer.host_for(self.registry.directory, pip["id"], pip["workspace_id"])
        host.viewer = pip_computer.ViewServer(host)
        viewer = socket.socket(socket.AF_UNIX)
        viewer.settimeout(60)
        viewer.connect(str(host.viewer.path))
        viewer.sendall(json.dumps({"token": host.viewer.token, "op": "desktop"}).encode() + b"\n")
        line = b""
        while not line.endswith(b"\n"):
            line += viewer.recv(1)
        self.assertEqual(json.loads(line), {"ok": True})
        self.assertTrue(host.browser.alive(), "the browser runs as a window on the screen")
        self.assertEqual(host.browser.display_dir, host.desktop.x11_dir)
        # The desktop's Terminal is online through the computer's egress, like the browser: the desktop
        # box runs its own relay to it (Grok's terminal has internet; a user: "lets copy grok").
        def parent(pid):
            try:
                return int(next(l for l in open(f"/proc/{pid}/status") if l.startswith("PPid:")).split()[1])
            except (OSError, StopIteration, ValueError):
                return 0
        def relay_in_desktop():
            for pid in filter(str.isdigit, os.listdir("/proc")):
                try:
                    argv = open(f"/proc/{pid}/cmdline", "rb").read().split(b"\0")
                except OSError:
                    continue
                if argv[:2] == [b"python3", b"/run/dgc/forward.py"]:
                    node = int(pid)
                    while node > 1:
                        if node == host.desktop.proc.pid:
                            return True
                        node = parent(node)
            return False
        deadline = time.monotonic() + 10
        while not relay_in_desktop() and time.monotonic() < deadline:
            time.sleep(0.2)
        self.assertTrue(relay_in_desktop(), "the desktop box runs its own relay to the computer's egress")
        width, height, pixels = self.frame(viewer)
        self.assertEqual((width, height), (pip_screen.WIDTH, pip_screen.HEIGHT))
        self.assertGreater(len(set(pixels[i:i + 4] for i in range(0, len(pixels), 4 * 997))), 8, "a real picture, not one colour")
        before = host.user_input_at
        host.run_id = "run_" + "c" * 32
        viewer.sendall(POINTER)
        time.sleep(0.5)
        self.assertEqual(host.user_input_at, before, "while a Pip works, the user's input is dropped")
        host.run_id = None
        viewer.sendall(POINTER)
        deadline = time.monotonic() + 5
        while host.user_input_at == before and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertGreater(host.user_input_at, before, "the user's own input is noted")
        # Typed as the editor's noVNC types once Xtigervnc offers it: QEMU extended key events. The
        # screen stays open (it closed on the first key before) and the keys are the user's input.
        before = host.user_input_at
        for down in (1, 0):
            viewer.sendall(struct.pack(">BBHII", 255, 0, down, 0x61, 0x1e))
        deadline = time.monotonic() + 5
        while host.user_input_at == before and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertGreater(host.user_input_at, before, "a typed key is the user's input")
        viewer.sendall(struct.pack(">BBHHHH", 3, 0, 0, 0, pip_screen.WIDTH, pip_screen.HEIGHT))
        self.assertNotEqual(viewer.recv(1), b"", "the screen is still open after typing")
        threading.Thread(target=_drain, args=(viewer,), daemon=True).start()     # the rest of that frame
        # Closed by the user, the browser comes back from the dock's Browser icon, through DGC.
        with host.lock:
            host.browser.close()
        self.assertFalse(host.browser.alive())
        from dgc import pip_apps
        icons = 3 + sum(pip_apps.find(key) is not None for key in pip_apps.APPS)    # the apps this machine has join the dock
        x, y = pip_screen.dock_icon(0, icons)
        for button in (0, 1, 0):
            viewer.sendall(struct.pack(">BBHH", 5, button, x, y))
            time.sleep(0.15)
        deadline = time.monotonic() + 20
        while not host.browser.alive() and time.monotonic() < deadline:
            time.sleep(0.2)
        self.assertTrue(host.browser.alive(), "the dock's Browser icon restarted the Pip's own browser")
        viewer.close()


if __name__ == "__main__":
    unittest.main()
