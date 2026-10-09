"""A Pip computer on macOS: one small Linux VM per computer, through Apple's `container` tool.

On Linux a Pip's computer is three bubblewrap boxes sharing the machine's kernel (pip_computer_box,
pip_screen, pip_computer_files). On a Mac it is one VM with the same desktop and Google Chrome, built
once from DOCKERFILE ("Setting up your Pip…"), with no network of its own (--network none):

- the screen: Xtigervnc in the VM on a Unix socket, published to the Mac (--publish-socket), read
  by the same viewer stream as on Linux;
- Chrome: driven over its DevTools pipe on `container exec -i` stdin/stdout, with Chrome's own
  sandbox on (the VM allows it; Ubuntu's AppArmor does not, so Linux runs it without);
- the way out: the VM cannot connect to the Mac, so pip_boxd.py in the VM takes local proxy clients
  and the Mac keeps idle connections open into it (POOL_SIZE), splicing each used one to DGC's egress
  proxy -- public websites only, exactly as on Linux; the Terminal's commands use their own channel,
  so each command's sites are still recorded;
- Files and the browser's profile: the computer's home folder, mounted into the VM.

Apple's tool runs on Apple silicon with macOS 26 or later; supported() says why not otherwise.
"""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
import platform
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

from .workspace_registry import RegistryError

IMAGE = "dgc-pip-computer"
CLI_PATHS = ("/usr/local/bin/container",)        # its installer's place; a GUI app's PATH may lack it
INSTALL = "Install Apple's container tool from github.com/apple/container/releases, then open the computer again."
MEMORY, CPUS = "4G", "4"
POOL_SIZE = 6
START_SECONDS = 20
DISPLAY = ":1"
GOOGLE_KEY_FINGERPRINT = "EB4C1BFD4F042F6DDDCCEC917721F63BD38B4796"
DOCKERFILE = f"""\
# A Pip computer on macOS: the same desktop and Google Chrome as DGC sets up on Linux, and the
# Terminal's usual tools (on Linux the Terminal borrows the machine's own).
# Google's repository is trusted only through its pinned signing key.
FROM docker.io/library/debian:trixie-slim
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8
RUN apt-get update \\
 && apt-get install -y --no-install-recommends ca-certificates curl wget git unzip gnupg python3 tzdata procps \\
      fontconfig fonts-dejavu-core fonts-liberation fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji \\
      tigervnc-standalone-server openbox tint2 pcmanfm xterm \\
 && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub -o /tmp/google.pub \\
 && gpg --show-keys --with-colons /tmp/google.pub | grep -q '^fpr:::::::::{GOOGLE_KEY_FINGERPRINT}:' \\
 && gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg /tmp/google.pub \\
 && echo "deb [arch=arm64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \\
      > /etc/apt/sources.list.d/google-chrome.list \\
 && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable \\
 && apt-get purge -y gnupg && apt-get autoremove -y && apt-get clean \\
 && rm -rf /var/lib/apt/lists/* /tmp/google.pub \\
 && useradd -m -u 1000 -s /bin/bash pip
"""
CHROME = "/usr/bin/google-chrome-stable"


def tag() -> str:
    """The image for this DGC: a changed DOCKERFILE builds a new one."""
    return hashlib.sha256(DOCKERFILE.encode()).hexdigest()[:12]


def image() -> str:
    return f"{IMAGE}:{tag()}"


# ---------------------------------------------------------------- can this Mac have one

def cli() -> str | None:
    found = shutil.which("container")
    if found:
        return found
    return next((path for path in CLI_PATHS if os.access(path, os.X_OK)), None)


def _macos_major() -> int:
    try:
        return int((platform.mac_ver()[0] or "0").split(".")[0])
    except ValueError:
        return 0


def supported() -> tuple[bool, str]:
    if sys.platform != "darwin":
        return False, "Pip computers in a VM are for macOS."
    if platform.machine() != "arm64":
        return False, "Pip computers on a Mac need Apple silicon."
    if _macos_major() < 26:
        return False, "Pip computers need macOS 26 or later. Update in System Settings, Software Update."
    if cli() is None:
        return False, INSTALL
    return True, ""


def run(*argv: str, timeout: float = 60, input: bytes | None = None) -> subprocess.CompletedProcess:
    tool = cli()
    if tool is None:
        raise RegistryError("computer_unavailable", INSTALL)
    try:
        return subprocess.run([tool, *argv], capture_output=True, timeout=timeout, input=input,
                              stdin=None if input is not None else subprocess.DEVNULL)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RegistryError("computer_unavailable", f"Apple's container tool did not answer ({type(exc).__name__}).") from exc


def system_running() -> bool:
    try:
        result = run("system", "status", timeout=20)
    except RegistryError:
        return False
    return result.returncode == 0 and b"running" in result.stdout


def ensure_system() -> None:
    """Start Apple's container service for this user (it fetches its Linux kernel the first time)."""
    if system_running():
        return
    result = run("system", "start", "--enable-kernel-install", timeout=600)
    if result.returncode != 0 or not system_running():
        raise RegistryError("computer_unavailable", "Apple's container service did not start: "
                            + _last_line(result.stderr or result.stdout))


def _last_line(data: bytes) -> str:
    lines = [line.strip() for line in data.decode("utf-8", "replace").splitlines() if line.strip()]
    return (lines[-1] if lines else "no reason given")[:300]


def image_ready() -> bool:
    try:
        return run("image", "inspect", image(), timeout=30).returncode == 0
    except RegistryError:
        return False


# ---------------------------------------------------------------- setting it up, once

def home() -> Path:
    from .config import USER_HOME
    return Path(USER_HOME) / "desktop" / "container"


def _status_path() -> Path:
    return home() / "status.json"


def _write_status(**fields) -> None:
    path = _status_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps({**fields, "tag": tag(), "at": time.time()}), encoding="utf-8")
    os.replace(tmp, path)


def _setting_up() -> bool:
    """Whether some process holds the setup lock right now."""
    home().mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(home() / ".lock", os.O_RDWR | os.O_CREAT, 0o600)
    except OSError:
        return False
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return True
    else:
        fcntl.flock(fd, fcntl.LOCK_UN)
        return False
    finally:
        os.close(fd)


def status() -> dict:
    """The same shape as pip_screen_setup.status(): {state, step, done, total, error, chrome, checked_at}."""
    ok, why = supported()
    if not ok:
        return {"state": "unsupported", "step": "", "done": 0, "total": 0, "error": why, "chrome": "", "checked_at": None}
    try:
        value = json.loads(_status_path().read_text(encoding="utf-8"))
        value = value if isinstance(value, dict) and value.get("tag") == tag() else {}
    except (OSError, ValueError):
        value = {}
    state = value.get("state") if value.get("state") in ("running", "ready", "failed") else "none"
    if state == "running" and not _setting_up():
        state, value["error"] = "failed", value.get("error") or "Setting up stopped before it finished. Open the computer again to retry."
    if state == "ready" and not image_ready():
        state = "none"                     # the image was deleted: build it again
    return {"state": state, "step": str(value.get("step") or "")[:200], "done": int(value.get("done") or 0),
            "total": int(value.get("total") or 0), "error": str(value.get("error") or "")[:400] if state == "failed" else "",
            "chrome": str(value.get("chrome") or "")[:40], "checked_at": value.get("at") if state == "ready" else None}


def due() -> bool:
    """A setup is wanted: no image for this DGC yet (a failed one is retried after an hour)."""
    if not supported()[0] or _setting_up():
        return False
    current = status()
    if current["state"] == "ready":
        return False
    if current["state"] == "failed":
        try:
            at = json.loads(_status_path().read_text(encoding="utf-8")).get("at")
        except (OSError, ValueError, AttributeError):
            at = None
        return not isinstance(at, (int, float)) or time.time() - at > 3600
    return True


_THREAD: threading.Thread | None = None
_THREAD_LOCK = threading.Lock()


def start_setup() -> bool:
    """Build the computer's image in the background; False when a setup is already running."""
    global _THREAD
    with _THREAD_LOCK:
        if _THREAD is not None and _THREAD.is_alive() or _setting_up():
            return False
        _THREAD = threading.Thread(target=_setup_logged, name="dgc-computer-image", daemon=True)
        _THREAD.start()
        return True


def _setup_logged() -> None:
    try:
        _setup()
    except Exception as exc:                 # noqa: BLE001 -- said in the status, never raised into a caller
        _write_status(state="failed", step="", done=0, total=0, error=str(exc)[:400] or type(exc).__name__)


_STEP = re.compile(rb"^#\d+ \[(?:[^\]]*? )?(\d+)/(\d+)\]")


def _setup() -> None:
    home().mkdir(parents=True, exist_ok=True)
    with open(home() / ".lock", "w") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        try:
            _build()
        except Exception as exc:             # noqa: BLE001 -- said in the status, never raised into a caller
            # Said while the lock is still held: written after it, a status read in between saw a running
            # setup that no one held and said it "stopped before it finished" instead of why it failed.
            _write_status(state="failed", step="", done=0, total=0, error=str(exc)[:400] or type(exc).__name__)


def _build() -> None:
    _write_status(state="running", step="Starting Apple's container service", done=0, total=0)
    ensure_system()
    context = home() / "build"
    context.mkdir(exist_ok=True)
    (context / "Dockerfile").write_text(DOCKERFILE, encoding="utf-8")
    _write_status(state="running", step="Building its computer", done=0, total=0)
    tool = cli()
    tail: list[bytes] = []
    with subprocess.Popen([tool, "build", "--progress", "plain", "-t", image(), str(context)],
                          stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT) as proc:
        for line in proc.stdout:
            tail = (tail + [line])[-20:]
            step = _STEP.match(line)
            if step:
                _write_status(state="running", step="Building its computer", done=int(step.group(1)), total=int(step.group(2)))
        code = proc.wait()
    if code != 0 or not image_ready():
        raise RegistryError("computer_unavailable", "Building its computer failed: " + _last_line(b"".join(tail)))
    chrome = run("run", "--rm", "--network", "none", image(), CHROME, "--version", timeout=120)
    version = re.search(rb"(\d+\.\d+\.\d+\.\d+)", chrome.stdout or b"")
    _write_status(state="ready", step="", done=0, total=0, chrome=version.group(1).decode() if version else "")
    _prune_old()


def _prune_old() -> None:
    """Delete images an earlier DGC built; the current one stays."""
    try:
        listed = json.loads(run("image", "list", "--format", "json", timeout=30).stdout or b"[]")
    except (RegistryError, ValueError):
        return
    for item in listed if isinstance(listed, list) else []:
        try:
            name = item["configuration"]["descriptor"]["annotations"]["com.apple.containerization.image.name"]
        except (KeyError, TypeError):
            continue
        if isinstance(name, str) and name.startswith(IMAGE + ":") and name != image():
            try:
                run("image", "delete", name, timeout=60)
            except RegistryError:
                pass


# ---------------------------------------------------------------- one computer

def _host_timezone() -> str | None:
    from .pip_computer_box import host_timezone
    return host_timezone()


class Computer:
    """One Pip's VM: started on first use, its screen, browser and Terminal all inside it."""

    def __init__(self, root: Path, egress: Path, sockets: Path):
        self.root, self.egress, self.sockets = Path(root), Path(egress), Path(sockets)
        digest = hashlib.sha256(str(self.root.resolve()).encode()).hexdigest()[:12]
        self.name = "dgc-pip-" + digest
        self.terminal_egress: Path | None = None     # the running command's own proxy (its sites are recorded)
        self.on_event = None                          # called with "browser" when the dock asks for it
        self._stopped = threading.Event()
        self._lock = threading.Lock()
        self._started = False

    def socket(self, name: str) -> Path:
        return self.sockets / f"{self.name[-12:]}-{name}.sock"

    def running(self) -> bool:
        if not self._started:
            return False
        try:
            result = run("inspect", self.name, timeout=20)
        except RegistryError:
            return False
        return result.returncode == 0 and b'"running"' in result.stdout

    def start(self) -> None:
        with self._lock:
            if self.running():
                return
            ok, why = supported()
            if not ok:
                raise RegistryError("computer_unavailable", why)
            if not image_ready():
                raise RegistryError("computer_unavailable", "Setting up its computer. This happens once.")
            ensure_system()
            global _REAPED
            if not _REAPED:
                _REAPED = True
                reap_orphans()                                      # VMs a stopped DGC left behind
            run("delete", "--force", self.name, timeout=60)        # one left from before, if any
            runtime = self.root / "vm"
            (runtime / "boxd").mkdir(parents=True, exist_ok=True)
            shutil.copyfile(Path(__file__).with_name("pip_boxd.py"), runtime / "boxd" / "pip_boxd.py")
            from . import pip_screen
            pip_screen.write_config(runtime / "conf", "Pip")   # the same dock, apps and desktop.sh as on Linux
            home = self.root / "home"
            home.mkdir(parents=True, exist_ok=True)
            self.sockets.mkdir(mode=0o700, parents=True, exist_ok=True)
            for name in ("pool", "events", "vnc"):
                try:
                    self.socket(name).unlink()
                except OSError:
                    pass
            zone = _host_timezone()
            argv = ["run", "--detach", "--name", self.name, "--network", "none", "--memory", MEMORY, "--cpus", CPUS,
                    "--label", f"{LABEL}=1", "--env", "LANG=C.UTF-8", *(["--env", f"TZ={zone}"] if zone else []),
                    "--volume", f"{home}:/home/pip",
                    "--mount", f"type=bind,source={runtime / 'conf'},target=/run/dgc/conf,readonly",
                    "--mount", f"type=bind,source={runtime / 'boxd'},target=/run/dgc/boxd,readonly"]
            for name in ("pool", "events", "vnc"):
                argv += ["--publish-socket", f"{self.socket(name)}:/run/dgc/sock/{name}.sock"]
            result = run(*argv, image(), "sleep", "infinity", timeout=120)
            if result.returncode != 0:
                raise RegistryError("computer_unavailable", "Its computer did not start: " + _last_line(result.stderr))
            setup = run("exec", self.name, "sh", "-c", "mkdir -p /run/dgc/sock /run/dgc/log && chown -R pip:pip /run/dgc/sock "
                        "/run/dgc/log && chmod 700 /run/dgc/sock", timeout=30)
            boxd = run("exec", "--detach", "--user", "pip", self.name, "sh", "-c",
                       "exec python3 /run/dgc/boxd/pip_boxd.py > /run/dgc/log/boxd.log 2>&1", timeout=30)
            if setup.returncode != 0 or boxd.returncode != 0:
                self.stop()
                raise RegistryError("computer_unavailable", "Its computer did not start its way online.")
            self._started = True
            self._stopped.clear()
            deadline = time.monotonic() + START_SECONDS
            while time.monotonic() < deadline and not self._connectable("pool"):
                time.sleep(0.2)
            for _ in range(POOL_SIZE):
                threading.Thread(target=self._offer, name=f"pip-vm-pool-{self.name[-6:]}", daemon=True).start()
            threading.Thread(target=self._events, name=f"pip-vm-events-{self.name[-6:]}", daemon=True).start()

    def _connectable(self, name: str) -> bool:
        probe = socket.socket(socket.AF_UNIX)
        probe.settimeout(2)
        try:
            probe.connect(str(self.socket(name)))
            return True
        except OSError:
            return False
        finally:
            probe.close()

    def _offer(self) -> None:
        """One idle connection into the VM: when boxd uses it, splice it to the channel's egress proxy
        and offer the next one at once, so a page opening many connections never waits."""
        while not self._stopped.is_set():
            conn = socket.socket(socket.AF_UNIX)
            try:
                conn.connect(str(self.socket("pool")))
                channel = conn.recv(1)
            except OSError:
                conn.close()
                self._stopped.wait(1)
                continue
            if not channel or self._stopped.is_set():
                conn.close()
                continue
            threading.Thread(target=self._offer, daemon=True).start()
            proxy = self.terminal_egress if channel == b"\x02" and self.terminal_egress is not None else self.egress
            upstream = socket.socket(socket.AF_UNIX)
            try:
                upstream.connect(str(proxy))
            except OSError:
                conn.close()
                upstream.close()
                return
            _pump(conn, upstream)
            return

    def _events(self) -> None:
        while not self._stopped.is_set():
            conn = socket.socket(socket.AF_UNIX)
            try:
                conn.connect(str(self.socket("events")))
                stream = conn.makefile("rb")
                for line in stream:
                    if line.strip() == b"browser" and self.on_event is not None:
                        try:
                            self.on_event("browser")
                        except Exception:              # noqa: BLE001 - a dock click never takes the computer down
                            pass
            except OSError:
                pass
            finally:
                conn.close()
            self._stopped.wait(1)

    def exec_argv(self, command: list[str], *, interactive: bool = False, detach: bool = False,
                  env: dict | None = None, workdir: str | None = None, user: str = "pip") -> list[str]:
        argv = [cli() or "container", "exec", "--user", user]
        if interactive:
            argv.append("--interactive")
        if detach:
            argv.append("--detach")
        if workdir:
            argv += ["--workdir", workdir]
        for key, value in (env or {}).items():
            argv += ["--env", f"{key}={value}"]
        return argv + [self.name, *command]

    def stop(self) -> None:
        self._stopped.set()
        self._started = False
        try:
            run("delete", "--force", self.name, timeout=60)
        except RegistryError:
            pass


def _pump(a: socket.socket, b: socket.socket) -> None:
    import select
    try:
        while True:
            ready, _, _ = select.select([a, b], [], [], 600)
            if not ready:
                return
            for s in ready:
                data = s.recv(65536)
                if not data:
                    return
                (b if s is a else a).sendall(data)
    except OSError:
        pass
    finally:
        a.close()
        b.close()


_COMPUTERS: dict[str, Computer] = {}
_COMPUTERS_LOCK = threading.Lock()
_REAPED = False
LABEL = "dgc.pip-computer"


def reap_orphans() -> list[str]:
    """Delete DGC's computer VMs that no Host in this process owns: ones left by a DGC that stopped
    without closing them (a crash, a kill) would otherwise keep 4 GB each. Only the Pips supervisor
    hosts computers, one per machine, so a VM it does not own is nobody's."""
    try:
        listed = json.loads(run("list", "--all", "--format", "json", timeout=30).stdout or b"[]")
    except (RegistryError, ValueError):
        return []
    with _COMPUTERS_LOCK:
        owned = {computer.name for computer in _COMPUTERS.values() if computer._started}
    gone = []
    for item in listed if isinstance(listed, list) else []:
        config = item.get("configuration") if isinstance(item, dict) else None
        name = config.get("id") if isinstance(config, dict) else None
        labels = config.get("labels") if isinstance(config, dict) else None
        if (isinstance(name, str) and name.startswith("dgc-pip-") and isinstance(labels, dict)
                and labels.get(LABEL) == "1" and name not in owned):
            try:
                run("delete", "--force", name, timeout=60)
                gone.append(name)
            except RegistryError:
                pass
    return gone


def computer_for(root: Path, egress: Path | None = None) -> Computer:
    """The one Computer for a Pip computer's folder (the Host's root), made on first use."""
    from .pip_computer import socket_dir
    key = str(Path(root).resolve())
    with _COMPUTERS_LOCK:
        found = _COMPUTERS.get(key)
        if found is None:
            if egress is None:
                raise RegistryError("computer_unavailable", "This computer is not open.")
            found = _COMPUTERS[key] = Computer(Path(root), Path(egress), socket_dir())
        return found


def release(root: Path) -> None:
    """Stop a Pip computer's VM (its Host closed)."""
    with _COMPUTERS_LOCK:
        found = _COMPUTERS.pop(str(Path(root).resolve()), None)
    if found is not None:
        found.stop()


# ---------------------------------------------------------------- the browser and the screen in it

class ContainerBox:
    """The Box (pip_computer_box) for a Mac: Chrome in the computer's VM, its DevTools pipe on the
    stdin and stdout of `container exec -i`."""

    def __init__(self, home: Path, egress_socket: Path, viewport, on_screen: bool):
        self.home, self.viewport, self.on_screen = Path(home), viewport, on_screen
        self.computer = computer_for(self.home.parent, egress_socket)
        self.proc: subprocess.Popen | None = None
        self.read_fd = self.write_fd = -1

    def chrome_argv(self) -> list[str]:
        from .pip_computer_box import _CHROME_FLAGS, BOX_PROXY_PORT
        flags = [f for f in _CHROME_FLAGS if f != "--no-sandbox"]       # the VM allows Chrome's own sandbox
        flags = [f"--proxy-server=http://127.0.0.1:{BOX_PROXY_PORT}" if f.startswith("--proxy-server=") else f for f in flags]
        if self.on_screen:
            flags = [f for f in flags if f != "--headless=new"] + ["--window-position=0,0", "--password-store=basic",
                                                                  "--disable-session-crashed-bubble", "--window-size=1280,724",
                                                                  "--no-startup-window"]
        else:
            flags += [f"--window-size={self.viewport[0]},{self.viewport[1]}", "about:blank"]
        return [CHROME, *flags]

    def start(self, log_path: Path) -> None:
        import shlex
        self.computer.start()
        # A Chrome left from before still holds the profile's lock: end it first.
        run("exec", "--user", "pip", self.computer.name, "sh", "-c",
            # ([.]: the pattern must not match this shell's own command line, or pkill ends it here.)
            "pkill -f -- '--user-data-dir=/home/pip/[.]browser' ; sleep 0.3; rm -f /home/pip/.browser/Singleton*", timeout=30)
        inner = ("exec 3<&0 4>&1 >>/run/dgc/log/chrome.log 2>&1 </dev/null; exec " + shlex.join(self.chrome_argv()))
        env = {"HOME": "/home/pip", "DISPLAY": DISPLAY} if self.on_screen else {"HOME": "/home/pip"}
        self.proc = subprocess.Popen(self.computer.exec_argv(["sh", "-c", inner], interactive=True, env=env),
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=open(log_path, "ab"),
                                     start_new_session=True)
        self.read_fd, self.write_fd = self.proc.stdout.fileno(), self.proc.stdin.fileno()

    def stop(self) -> None:
        if self.proc is not None:
            try:
                self.proc.kill()
                self.proc.wait(timeout=5)
            except (OSError, subprocess.TimeoutExpired):
                pass
            for stream in (self.proc.stdin, self.proc.stdout):
                try:
                    stream.close()
                except OSError:
                    pass
            self.proc = None
        if self.computer.running():
            try:
                run("exec", "--user", "pip", self.computer.name, "sh", "-c",
                    "pkill -f -- '--user-data-dir=/home/pip/[.]browser' || true", timeout=30)
            except RegistryError:
                pass


class ContainerDesktop:
    """pip_screen.Desktop for a Mac: the same desktop.sh, run in the computer's VM."""

    def __init__(self, runtime: Path, files: Path, name: str, egress: Path | None = None):
        self.files, self.name = Path(files), name
        self.computer = computer_for(self.files.parent.parent, egress)
        self.on_launch = None
        self._up = False

    @property
    def vnc_socket(self) -> Path:
        return self.computer.socket("vnc")

    @property
    def x11_dir(self) -> Path:
        return Path("/vm") / self.computer.name       # a marker: the browser draws on the VM's own screen

    def running(self) -> bool:
        return self._up and self.computer.running()

    def start(self, launch=lambda start: start()) -> None:
        if self.running():
            return
        self.computer.on_event = lambda what: self.on_launch(what) if self.on_launch is not None else None
        launch(self.computer.start)
        env = {"HOME": "/home/pip", "DESK_VNC": "/usr/bin/Xtigervnc", "DESK_WM": "/usr/bin/openbox",
               "DESK_DOCK": "/usr/bin/tint2", "DESK_FILES": "/usr/bin/pcmanfm", "DESK_BIN": "/usr/bin",
               "XDG_DATA_DIRS": "/usr/share", "SHELL": "/bin/bash", "TERM": "xterm-256color",
               **{key: "http://127.0.0.1:8899" for key in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY")},
               "no_proxy": "localhost,127.0.0.1", "NO_PROXY": "localhost,127.0.0.1"}
        result = subprocess.run(self.computer.exec_argv(["sh", "/run/dgc/conf/desktop.sh"], detach=True, env=env),
                                stdin=subprocess.DEVNULL, capture_output=True, timeout=60)
        deadline = time.monotonic() + START_SECONDS
        while time.monotonic() < deadline and not self.computer._connectable("vnc"):
            time.sleep(0.2)
        if result.returncode != 0 or not self.computer._connectable("vnc"):
            raise RegistryError("desktop_unavailable", "The computer's screen did not start. See its desktop logs.")
        self._up = True

    def stop(self) -> None:
        self._up = False
        if self.computer.running():
            try:
                run("exec", self.computer.name, "sh", "-c", "pkill -u pip -f 'Xtigervnc|openbox|tint2|pcmanfm' || true", timeout=30)
            except RegistryError:
                pass
