"""Real installs of the versioned layout, entirely under a temporary directory.

Every scenario runs the repository's install.sh (and the installed `dgc update`) against release
archives built from this checkout the way scripts/build-release.sh shapes them (a `dgc/` prefix
around LICENSE, README.md, pyproject.toml, requirements.lock and the dgc package), served by a
local HTTP server on 127.0.0.1:4880-4889 through DGC_BASE_URL. HOME, XDG_DATA_HOME, DGC_BIN and
the pip index are all private to the test: pip installs from a wheelhouse filled once per
requirements.lock, so a scenario never touches the developer's ~/dgc, ~/.local or ~/.dgc.
"""
from __future__ import annotations

import contextlib
import hashlib
import http.server
import io
import json
import os
import shlex
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

PROJECT = Path(__file__).resolve().parent.parent
INSTALLER = PROJECT / "install.sh"
PORTS = range(4880, 4890)
BUILD_TIMEOUT = 600

sys.path.insert(0, str(PROJECT))
from dgc import install_layout as L  # noqa: E402


# ------------------------------------------------------------------ fixtures ---

def _installer_path() -> str:
    """The PATH every scenario runs install.sh (and the installed `dgc`) with: the caller's PATH
    without the bin directory of the interpreter running these tests, so an install never borrows
    that interpreter's environment or the `dgc` an editable install put next to it."""
    own_bin = str(Path(sys.prefix) / "bin")
    return os.pathsep.join(part for part in os.environ.get("PATH", "").split(os.pathsep)
                           if part and part != own_bin)


def _wheelhouse() -> Path:
    """Wheels for requirements.lock plus the build backend, downloaded once and reused.

    install.sh builds every venv with the first `python3` on the scenario's PATH, which need not
    be the interpreter running the tests: under actions/setup-python that interpreter's bin
    directory is exactly what _installer_path() removes, so the builds use the runner image's own
    python3 (/usr/bin/python3, 3.12, on ubuntu-24.04). Wheels resolved for sys.executable carry
    its tags (a cp313 charset-normalizer) and that pip finds nothing it can install. So the
    wheelhouse is downloaded by a scratch venv of that very python3 — the same version, ABI,
    platform tags and bundled pip as the builds that install from it — and cached per interpreter.
    """
    installer_path = _installer_path()
    python3 = shutil.which("python3", path=installer_path)
    if python3 is None:
        raise RuntimeError(f"install.sh needs python3, and there is none on PATH={installer_path}")
    # The builds' interpreter environment (clean_env), keeping any pip index settings for the fetch.
    fetch_env = {key: value for key, value in os.environ.items()
                 if not key.startswith(("PYTHON", "VIRTUAL_ENV"))}
    fetch_env["PATH"] = installer_path
    identity = subprocess.run(
        [python3, "-c", "import sys, sysconfig; print(sys.version, sysconfig.get_platform())"],
        capture_output=True, text=True, check=True, stdin=subprocess.DEVNULL, env=fetch_env).stdout
    lock = (PROJECT / "requirements.lock").read_bytes()
    key = hashlib.sha256(lock + b"setuptools>=68 wheel" + os.path.realpath(python3).encode()
                         + identity.encode()).hexdigest()[:16]
    target = Path(tempfile.gettempdir()) / f"dgc-installer-wheelhouse-{key}"
    if (target / ".complete").is_file():
        return target
    staging = Path(tempfile.mkdtemp(prefix="dgc-installer-wheelhouse-"))
    scratch = Path(tempfile.mkdtemp(prefix="dgc-installer-wheelhouse-venv-"))
    try:
        subprocess.run([python3, "-m", "venv", str(scratch / "venv")], check=True,
                       timeout=BUILD_TIMEOUT, stdin=subprocess.DEVNULL, env=fetch_env)
        subprocess.run([str(scratch / "venv" / "bin" / "pip"), "download", "-q",
                        "--disable-pip-version-check", "-d", str(staging),
                        "-r", str(PROJECT / "requirements.lock"), "setuptools>=68", "wheel"],
                       check=True, timeout=BUILD_TIMEOUT, stdin=subprocess.DEVNULL, env=fetch_env)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
    (staging / ".complete").write_text("ok\n")
    try:
        staging.rename(target)
    except OSError:
        shutil.rmtree(staging, ignore_errors=True)   # a concurrent run filled it first
    return target


def build_release(version: str, *, extra: dict[str, str] | None = None,
                  requirements: str | None = None, omit: tuple[str, ...] = ()) -> bytes:
    """A release archive of this checkout with its version rewritten — the layout of build-release.sh."""
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        def add(name: str, data: bytes) -> None:
            info = tarfile.TarInfo(f"dgc/{name}")
            info.size, info.mode, info.mtime = len(data), 0o644, 1_700_000_000
            archive.addfile(info, io.BytesIO(data))
        for name in ("LICENSE", "README.md", "pyproject.toml"):
            add(name, (PROJECT / name).read_bytes())
        add("requirements.lock", (requirements if requirements is not None
                                  else (PROJECT / "requirements.lock").read_text()).encode())
        for path in sorted((PROJECT / "dgc").rglob("*")):
            if not path.is_file() or "__pycache__" in path.parts or path.suffix == ".pyc":
                continue
            relative = path.relative_to(PROJECT).as_posix()
            if relative in omit:
                continue
            data = path.read_bytes()
            if relative == "dgc/__init__.py":
                text = data.decode()
                start = text.index('__version__ = "')
                end = text.index('"', start + len('__version__ = "'))
                data = (text[:start] + f'__version__ = "{version}"' + text[end + 1:]).encode()
            add(relative, data)
        for name, text in (extra or {}).items():
            add(name, text.encode())
    return buffer.getvalue()


class Site:
    """A local release mirror: path -> bytes, optional delay on the archive."""

    def __init__(self):
        self.files: dict[str, bytes] = {}
        self.delay = 0.0
        site = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802 - http.server API
                body = site.files.get(self.path.split("?", 1)[0])
                if body is None:
                    self.send_error(404)
                    return
                if self.path.endswith("dgc.tar.gz") and site.delay:
                    time.sleep(site.delay)
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        last = None
        for port in PORTS:
            try:
                self.server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
                break
            except OSError as exc:
                last = exc
        else:
            raise RuntimeError(f"no free port in 4880-4889: {last}")
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def publish(self, archive: bytes, *, installer: bool = True, checksum: bool = True) -> None:
        self.files = {"/dgc.tar.gz": archive}
        if checksum:
            self.files["/dgc.tar.gz.sha256"] = (hashlib.sha256(archive).hexdigest() + "  dgc.tar.gz\n").encode()
        if installer:
            self.files["/install.sh"] = INSTALLER.read_bytes()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


SITE: Site | None = None
WHEELS: Path | None = None
RELEASES: dict[str, bytes] = {}
_TMP_ROOTS: list[str] = []


def setUpModule():  # noqa: N802 - unittest API
    global SITE, WHEELS
    WHEELS = _wheelhouse()
    SITE = Site()


def tearDownModule():  # noqa: N802 - unittest API
    if SITE is not None:
        SITE.close()
    for root in _TMP_ROOTS:
        shutil.rmtree(root, ignore_errors=True)


def release(version: str, **kwargs) -> bytes:
    key = version + json.dumps(kwargs, sort_keys=True)
    if key not in RELEASES:
        RELEASES[key] = build_release(version, **kwargs)
    return RELEASES[key]


def new_home(tag: str) -> Path:
    root = tempfile.mkdtemp(prefix=f"dgc-installer-{tag}-", dir="/tmp" if os.path.isdir("/tmp") else None)
    _TMP_ROOTS.append(root)
    home = Path(os.path.realpath(root)) / "home"
    home.mkdir()
    return home


def clean_env(home: Path, **extra: str) -> dict[str, str]:
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(("DGC_", "XDG_", "PIP_", "PYTHON", "VIRTUAL_ENV"))}
    env["PATH"] = _installer_path()
    env.update({
        "HOME": str(home), "USERPROFILE": str(home),
        "XDG_DATA_HOME": str(home / ".local" / "share"),
        "DGC_BASE_URL": SITE.url, "DGC_SKIP_EXTENSION": "1",
        "PIP_NO_INDEX": "1", "PIP_FIND_LINKS": str(WHEELS),
        "PIP_DISABLE_PIP_VERSION_CHECK": "1", "PIP_NO_CACHE_DIR": "1",
    })
    env.update(extra)
    return env


def run_installer(env: dict[str, str], timeout: float = BUILD_TIMEOUT) -> subprocess.CompletedProcess:
    return subprocess.run(["bash", str(INSTALLER)], env=env, capture_output=True, text=True,
                          timeout=timeout, stdin=subprocess.DEVNULL, cwd=env["HOME"])


def run_dgc(launcher: Path, args: list[str], env: dict[str, str],
            timeout: float = BUILD_TIMEOUT) -> subprocess.CompletedProcess:
    return subprocess.run([str(launcher), *args], env=env, capture_output=True, text=True,
                          timeout=timeout, stdin=subprocess.DEVNULL, cwd=env["HOME"])


def output(done: subprocess.CompletedProcess) -> str:
    return (done.stdout or "") + (done.stderr or "")


def link_target(path: Path) -> str:
    return os.path.realpath(path)


# ------------------------------------------------------- the versioned life ---

class VersionedInstallLifecycle(unittest.TestCase):
    """Fresh install -> update -> failed update -> retention -> rollback -> lock, on one HOME.

    The steps build on each other the way a user's machine does, so they run in order and a
    failure stops the ones after it."""

    home: Path
    env: dict[str, str]
    failed = False

    @classmethod
    def setUpClass(cls):
        cls.home = new_home("life")
        cls.data = cls.home / ".local" / "share" / "dgc"
        cls.bin = cls.home / ".local" / "bin"
        cls.launcher = cls.bin / "dgc"
        cls.env = clean_env(cls.home)
        cls.processes: list[subprocess.Popen] = []

    @classmethod
    def tearDownClass(cls):
        for proc in cls.processes:
            if proc.poll() is None:
                os.kill(proc.pid, signal.SIGKILL)
                proc.wait(timeout=10)
            for stream in (proc.stdin, proc.stdout):
                if stream and not stream.closed:
                    stream.close()

    def setUp(self):
        if type(self).failed:
            self.skipTest("an earlier lifecycle step failed")

    def run(self, result=None):
        before = len(result.failures) + len(result.errors) if result is not None else 0
        outcome = super().run(result)
        if result is not None and len(result.failures) + len(result.errors) > before:
            type(self).failed = True
        return outcome

    def target_version(self) -> str | None:
        launcher = L.inspect_launcher(self.launcher)
        return launcher.tree.name if launcher.kind == "managed" else None

    def test_01_fresh_install_builds_a_complete_version_and_every_editor_gets_the_extension(self):
        fake_bin = self.home / "fake-editors"
        fake_bin.mkdir()
        for editor in ("cursor", "code", "codium"):
            script = fake_bin / editor
            script.write_text(f'#!/usr/bin/env bash\necho "$*" >> "{self.home}/{editor}.log"\n')
            script.chmod(0o755)
        vsix = b"not really a vsix, but checksummed"
        SITE.publish(release("0.90.1", extra={"dgc/stale_only_in_A.py": "MARKER = 'A'\n"}))
        SITE.files["/vscode/dgc.vsix"] = vsix
        SITE.files["/vscode/dgc.vsix.sha256"] = (hashlib.sha256(vsix).hexdigest() + "  dgc.vsix\n").encode()
        env = dict(self.env, PATH=str(fake_bin) + os.pathsep + self.env["PATH"])
        env.pop("DGC_SKIP_EXTENSION")
        done = run_installer(env)
        self.assertEqual(done.returncode, 0, output(done)[-3000:])
        vdir = self.data / "versions" / "0.90.1"
        self.assertTrue(self.launcher.is_symlink())
        self.assertEqual(link_target(self.launcher), str(vdir / ".venv" / "bin" / "dgc"))
        self.assertEqual(L.read_complete(vdir)["sha256"],
                         hashlib.sha256(release("0.90.1", extra={"dgc/stale_only_in_A.py": "MARKER = 'A'\n"})).hexdigest())
        version = run_dgc(self.launcher, ["--version"], self.env)
        self.assertEqual(version.stdout.strip(), "dgc 0.90.1", output(version))
        # Non-editable: the package the venv imports is a copy in site-packages, not the tree.
        where = subprocess.run([str(vdir / ".venv" / "bin" / "python"), "-I", "-c",
                                "import dgc; print(dgc.__file__)"], capture_output=True, text=True,
                               cwd="/", env=self.env)
        self.assertIn(str(vdir / ".venv" / "lib"), where.stdout, output(where))
        self.assertEqual(list((vdir / ".venv").rglob("__editable__*")), [])
        record = json.loads((self.home / ".dgc" / "install.json").read_text())
        self.assertEqual((record["data_dir"], record["bin_dir"], record["version"]),
                         (str(self.data), str(self.bin), "0.90.1"))
        self.assertFalse((self.home / "dgc").exists(), "the old default tree must not be created")
        for editor in ("cursor", "code", "codium"):
            log = (self.home / f"{editor}.log").read_text()
            self.assertIn("--install-extension", log, editor)
            self.assertIn("--force", log, editor)

    def test_02_dgc_update_self_locates_and_never_swaps_code_under_a_running_process(self):
        vdir_a = self.data / "versions" / "0.90.1"
        # A backend started from A: main() marks A as in use.
        serve = subprocess.Popen([str(self.launcher), "serve"], env=self.env, cwd=str(self.home),
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 stderr=subprocess.DEVNULL, text=True)
        type(self).processes.append(serve)
        type(self).serve = serve
        self.assertIn('"ready"', serve.stdout.readline())
        self.assertTrue((self.data / "locks" / "0.90.1" / str(serve.pid)).is_file())
        # A second process from A that imports lazily, after the update.
        lazy = subprocess.Popen([str(vdir_a / ".venv" / "bin" / "python"), "-I", "-c",
                                 "import sys, dgc; sys.stdin.readline(); import dgc.update as u; "
                                 "print(u.__file__, hasattr(u, 'MARKER_ONLY_IN_B'), dgc.__version__)"],
                                env=self.env, cwd="/", stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, text=True)
        type(self).processes.append(lazy)

        update_py = (PROJECT / "dgc" / "update.py").read_text() + "\nMARKER_ONLY_IN_B = True\n"
        SITE.publish(release("0.90.2", extra={"dgc/update.py": update_py}))
        # No DGC_DATA_DIR / DGC_BIN: the running dgc says where it lives.
        done = run_dgc(self.launcher, ["update"], self.env)
        self.assertEqual(done.returncode, 0, output(done)[-3000:])
        self.assertEqual(self.target_version(), "0.90.2")
        self.assertTrue((vdir_a / ".complete").is_file(), "the running version must be kept")
        self.assertFalse((self.data / "versions" / "0.90.2" / "dgc" / "stale_only_in_A.py").exists())
        self.assertFalse(list((self.data / "versions" / "0.90.2" / ".venv").rglob("stale_only_in_A.py")))
        lazy_out, _ = lazy.communicate("go\n", timeout=60)
        lazy.stdin and lazy.stdin.close()
        path, has_marker, version = lazy_out.split()
        self.assertTrue(path.startswith(str(vdir_a)), lazy_out)
        self.assertEqual((has_marker, version), ("False", "0.90.1"))

    def test_03_a_failed_download_exits_non_zero_and_leaves_the_launcher_alone(self):
        before = link_target(self.launcher)
        SITE.files.pop("/dgc.tar.gz")
        done = run_installer(self.env)
        self.assertEqual(done.returncode, 1, output(done)[-2000:])
        self.assertIn("download failed", output(done))
        via_cli = run_dgc(self.launcher, ["update"], self.env)
        self.assertEqual(via_cli.returncode, 1, output(via_cli)[-2000:])
        self.assertIn("update failed", output(via_cli))
        self.assertNotIn("updated —", output(via_cli))
        # A release from before the versioned layout is refused before anything is built.
        SITE.publish(release("0.90.9", omit=("dgc/install_layout.py",)))
        predates = run_installer(self.env)
        self.assertEqual(predates.returncode, 1, output(predates)[-2000:])
        self.assertIn("predates this installer", output(predates))
        self.assertFalse((self.data / "versions" / "0.90.9").exists())
        SITE.files.pop("/install.sh")
        no_installer = run_dgc(self.launcher, ["update"], self.env)
        self.assertEqual(no_installer.returncode, 1, output(no_installer)[-2000:])
        self.assertIn("could not download", output(no_installer))
        self.assertEqual(link_target(self.launcher), before)
        self.assertEqual(sorted(p.name for p in (self.data / "versions").iterdir()), ["0.90.1", "0.90.2"])

    def test_04_a_failed_build_keeps_the_previous_version_active(self):
        broken = (PROJECT / "requirements.lock").read_text() + "dgc-no-such-package-anywhere==9.9.9\n"
        SITE.publish(release("0.90.3", requirements=broken))
        done = run_dgc(self.launcher, ["update"], self.env)
        self.assertEqual(done.returncode, 1, output(done)[-3000:])
        self.assertIn("previous version is still active", output(done))
        self.assertEqual(self.target_version(), "0.90.2")
        self.assertFalse((self.data / "versions" / "0.90.3").exists(), "a failed build is removed")
        version = run_dgc(self.launcher, ["--version"], self.env)
        self.assertEqual(version.stdout.strip(), "dgc 0.90.2")

    def test_05_retention_keeps_current_plus_two_and_any_version_still_running(self):
        for version in ("0.90.3", "0.90.4"):
            SITE.publish(release(version))
            done = run_installer(self.env)
            self.assertEqual(done.returncode, 0, output(done)[-3000:])
        self.assertEqual(self.target_version(), "0.90.4")
        # 0.90.1 is beyond current + 2, but the backend started in step 2 still runs it.
        self.assertEqual(L.installed_versions(self.data), ["0.90.4", "0.90.3", "0.90.2", "0.90.1"])
        serve = type(self).serve
        os.kill(serve.pid, signal.SIGKILL)          # no atexit: the lock file stays, stale
        serve.wait(timeout=10)
        serve.stdin.close()
        serve.stdout.close()
        self.assertTrue((self.data / "locks" / "0.90.1" / str(serve.pid)).exists())
        again = run_dgc(self.launcher, ["update"], self.env)   # same release: retention only
        self.assertEqual(again.returncode, 0, output(again)[-3000:])
        self.assertIn("already installed", output(again))
        self.assertIn("up to date", output(again))
        self.assertEqual(L.installed_versions(self.data), ["0.90.4", "0.90.3", "0.90.2"])
        self.assertFalse((self.data / "versions" / "0.90.1").exists())

    def test_06_rollback_and_version_switch_work_offline(self):
        offline = dict(self.env, DGC_BASE_URL="http://127.0.0.1:9")
        done = run_dgc(self.launcher, ["update", "--rollback"], offline)
        self.assertEqual(done.returncode, 0, output(done)[-2000:])
        self.assertEqual(self.target_version(), "0.90.3")
        listed = run_dgc(self.launcher, ["update", "--list"], offline)
        self.assertEqual(listed.returncode, 0, output(listed))
        self.assertRegex(listed.stdout, r"\*\s+0\.90\.3\s+active")
        forward = run_dgc(self.launcher, ["update", "--version", "0.90.4"], offline)
        self.assertEqual(forward.returncode, 0, output(forward)[-2000:])
        self.assertEqual(self.target_version(), "0.90.4")
        self.assertEqual(json.loads((self.home / ".dgc" / "install.json").read_text())["version"], "0.90.4")
        # A version neither kept nor published fails without touching the launcher.
        SITE.publish(release("0.90.4"))
        missing = run_dgc(self.launcher, ["update", "--version", "0.90.1"], self.env)
        self.assertEqual(missing.returncode, 1, output(missing)[-2000:])
        self.assertIn("publishes 0.90.4", output(missing))
        self.assertEqual(self.target_version(), "0.90.4")
        bad = run_dgc(self.launcher, ["update", "--sideways"], offline)
        self.assertEqual(bad.returncode, 2, output(bad))

    def test_07_one_update_at_a_time(self):
        before = link_target(self.launcher)
        fd = L.acquire_update_lock(self.data)
        self.assertIsNotNone(fd)
        try:
            blocked = run_installer(self.env)
            self.assertEqual(blocked.returncode, 3, output(blocked)[-2000:])
            self.assertIn("another DGC update is running", output(blocked))
            self.assertNotIn("downloading DGC", output(blocked))
            cli = run_dgc(self.launcher, ["update"], self.env)
            self.assertEqual(cli.returncode, 3, output(cli)[-2000:])
            rollback = run_dgc(self.launcher, ["update", "--rollback"], self.env)
            self.assertEqual(rollback.returncode, 3, output(rollback)[-2000:])
            self.assertEqual(link_target(self.launcher), before)
        finally:
            L.release_update_lock(fd)
        # Two installers started together: the archive is served slowly, so the first holds the
        # lock while the second arrives.
        SITE.publish(release("0.90.4"))
        SITE.delay = 3.0
        try:
            procs = [subprocess.Popen(["bash", str(INSTALLER)], env=self.env, cwd=str(self.home),
                                      stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                      stdin=subprocess.DEVNULL, text=True) for _ in range(2)]
            results = []
            for proc in procs:
                with proc.stdout:
                    text = proc.stdout.read()
                results.append((proc.wait(timeout=BUILD_TIMEOUT), text))
        finally:
            SITE.delay = 0.0
        codes = sorted(code for code, _ in results)
        self.assertEqual(codes, [0, 3], results)
        self.assertEqual(self.target_version(), "0.90.4")
        self.assertIsNotNone(L.read_complete(self.data / "versions" / "0.90.4"))

    def test_08_the_same_version_published_again_keeps_the_build_in_use(self):
        # A version re-cut from a different commit without a version bump. Rebuilding it in place
        # would pull the tree out from under the launcher; refusing failed every later update.
        vdir = self.data / "versions" / "0.90.4"
        built_from = L.read_complete(vdir)["sha256"]
        before = link_target(self.launcher)
        SITE.publish(release("0.90.4", extra={"dgc/recut_marker.py": "RECUT = True\n"}))
        done = run_dgc(self.launcher, ["update"], self.env)
        self.assertEqual(done.returncode, 0, output(done)[-3000:])
        self.assertIn("DGC 0.90.4 is already active — keeping it", output(done))
        self.assertIn("up to date", output(done))
        self.assertEqual(link_target(self.launcher), before)
        self.assertEqual(L.read_complete(vdir)["sha256"], built_from)
        self.assertFalse(list(vdir.rglob("recut_marker.py")))
        again = run_installer(self.env)
        self.assertEqual(again.returncode, 0, output(again)[-3000:])

        # Not active, but a process still runs it: keep that build too, and switch back to it.
        rolled = run_dgc(self.launcher, ["update", "--rollback"], self.env)
        self.assertEqual(rolled.returncode, 0, output(rolled)[-2000:])
        self.assertEqual(self.target_version(), "0.90.3")
        serve = subprocess.Popen([str(vdir / ".venv" / "bin" / "dgc"), "serve"], env=self.env,
                                 cwd=str(self.home), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 stderr=subprocess.DEVNULL, text=True)
        type(self).processes.append(serve)
        try:
            self.assertIn('"ready"', serve.stdout.readline())
            self.assertEqual(L.live_pids(self.data, "0.90.4"), [serve.pid])
            in_use = run_dgc(self.launcher, ["update"], self.env)
            self.assertEqual(in_use.returncode, 0, output(in_use)[-3000:])
            self.assertIn("already installed and in use — keeping it", output(in_use))
            self.assertEqual(self.target_version(), "0.90.4")
            self.assertEqual(L.read_complete(vdir)["sha256"], built_from)
        finally:
            serve.stdin.close()
            serve.wait(timeout=30)
            serve.stdout.close()

    def test_09_doctor_reports_the_install_it_runs_and_the_one_update_changes(self):
        (self.home / ".dgc").mkdir(exist_ok=True)
        config = self.home / ".dgc" / "config.json"
        if not config.exists():
            config.write_text(json.dumps({"base_url": "http://127.0.0.1:9/v1"}))
        env = dict(self.env, PATH=str(self.bin) + os.pathsep + self.env["PATH"])
        done = run_dgc(self.launcher, ["doctor"], env, timeout=120)
        text = output(done)
        self.assertIn("installation", text)
        self.assertIn("versioned install, DGC 0.90.4", text)
        self.assertIn(f"{self.launcher} → {self.data / 'versions' / '0.90.4' / '.venv' / 'bin' / 'dgc'} (managed)", text)
        self.assertIn(f"update target  {self.data / 'versions'}, launcher {self.launcher}", text)
        self.assertRegex(text, r"versions\s+0\.90\.4 \(active\), 0\.90\.3, 0\.90\.2")
        self.assertRegex(text, r"update lock\s+free")
        self.assertRegex(text, r"on PATH\s+yes")
        self.assertNotIn("not this dgc", text)
        # An older version started directly: doctor names the mismatch rather than hiding it.
        older = self.data / "versions" / "0.90.3" / ".venv" / "bin" / "dgc"
        stale = run_dgc(older, ["doctor"], env, timeout=120)
        self.assertIn("versioned install, DGC 0.90.3", output(stale))
        self.assertIn(f"{self.launcher} runs {self.data / 'versions' / '0.90.4'}, not this dgc", output(stale))
        fd = L.acquire_update_lock(self.data)
        try:
            held = run_dgc(self.launcher, ["doctor"], env, timeout=120)
            self.assertRegex(output(held), rf"update lock\s+held by pid {os.getpid()}")
        finally:
            L.release_update_lock(fd)


# ------------------------------------------------------------ old installs ---

def old_style_install(home: Path, tree: Path, bin_dir: Path, archive: bytes, env: dict[str, str]) -> None:
    """Exactly what the pre-0.39 installer did: untar over one tree, one venv, an EDITABLE
    install, and `ln -sf` into the launcher directory."""
    tree.mkdir(parents=True)
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as handle:
        for member in handle.getmembers():
            member.name = member.name.split("/", 1)[1]
            try:
                handle.extract(member, tree, filter="data")
            except TypeError:           # Python without extraction filters
                handle.extract(member, tree)
    subprocess.run(["python3", "-m", "venv", str(tree / ".venv")], check=True, env=env,
                   timeout=BUILD_TIMEOUT)
    pip = str(tree / ".venv" / "bin" / "pip")
    subprocess.run([pip, "install", "-q", "-r", str(tree / "requirements.lock")], check=True,
                   env=env, timeout=BUILD_TIMEOUT, stdout=subprocess.DEVNULL)
    subprocess.run([pip, "install", "-q", "--no-deps", "-e", str(tree)], check=True, env=env,
                   timeout=BUILD_TIMEOUT, stdout=subprocess.DEVNULL)
    bin_dir.mkdir(parents=True, exist_ok=True)
    subprocess.run(["ln", "-sf", str(tree / ".venv" / "bin" / "dgc"), str(bin_dir / "dgc")], check=True)


class LegacyInstallMigration(unittest.TestCase):

    def test_an_old_custom_location_install_is_updated_in_place_by_the_editor_bootstrap(self):
        home = new_home("legacy-custom")
        env = clean_env(home)
        tree, bin_dir = home / "custom-dgc", home / "custom-bin"
        old_style_install(home, tree, bin_dir, release("0.38.9"), env)
        self.assertEqual(run_dgc(bin_dir / "dgc", ["--version"], env).stdout.strip(), "dgc 0.38.9")

        # An OLD CLI's `dgc update` pipes the live installer into bash and passes no location of
        # its own; the environment it inherits is all the installer learns. The editor derives
        # that environment from realpath(dgc.command) (editors/vscode/src/cliupdate.ts).
        SITE.publish(release("0.90.2"))
        bootstrap = dict(env, DGC_DIR=str(tree), DGC_BIN=str(bin_dir))
        done = subprocess.run(["bash", "-c", f'curl -fsSL "{SITE.url}/install.sh" | bash'],
                              env=bootstrap, capture_output=True, text=True, timeout=BUILD_TIMEOUT,
                              cwd=str(home))
        self.assertEqual(done.returncode, 0, output(done)[-3000:])
        self.assertEqual(link_target(bin_dir / "dgc"),
                         str(tree / "versions" / "0.90.2" / ".venv" / "bin" / "dgc"))
        self.assertEqual(run_dgc(bin_dir / "dgc", ["--version"], env).stdout.strip(), "dgc 0.90.2")
        self.assertTrue((tree / ".venv" / "bin" / "dgc").exists(), "the old tree is left in place")
        self.assertTrue((tree / "dgc" / "__init__.py").exists())
        self.assertIn(str(tree), output(done))
        self.assertFalse((home / "dgc").exists())
        self.assertFalse((home / ".local" / "bin" / "dgc").exists())
        self.assertFalse((home / ".local" / "share" / "dgc" / "versions").exists())
        record = json.loads((home / ".dgc" / "install.json").read_text())
        self.assertEqual((record["data_dir"], record["bin_dir"]), (str(tree), str(bin_dir)))

        # From here on the NEW CLI finds its own location with no help from the environment.
        SITE.publish(release("0.90.3"))
        again = run_dgc(bin_dir / "dgc", ["update"], env)
        self.assertEqual(again.returncode, 0, output(again)[-3000:])
        self.assertEqual(link_target(bin_dir / "dgc"),
                         str(tree / "versions" / "0.90.3" / ".venv" / "bin" / "dgc"))
        self.assertFalse((home / ".local" / "bin" / "dgc").exists())

    def test_the_old_default_tree_migrates_to_the_data_dir_and_is_left_in_place(self):
        home = new_home("legacy-default")
        env = clean_env(home)
        tree = home / "dgc"
        (tree / ".venv" / "bin").mkdir(parents=True)
        (tree / "requirements.lock").write_text("rich==15.0.0\n")
        (tree / ".venv" / "bin" / "dgc").write_text("#!/bin/sh\necho 'dgc 0.38.1'\n")
        (tree / ".venv" / "bin" / "dgc").chmod(0o755)
        launcher = home / ".local" / "bin" / "dgc"
        launcher.parent.mkdir(parents=True)
        launcher.symlink_to(tree / ".venv" / "bin" / "dgc")
        SITE.publish(release("0.90.2"))
        # The extension passes DGC_DIR=~/dgc for this launcher too; ~/dgc was the old default,
        # not a choice, so it still moves to the XDG data directory.
        done = run_installer(dict(env, DGC_DIR=str(tree), DGC_BIN=str(launcher.parent)))
        self.assertEqual(done.returncode, 0, output(done)[-3000:])
        data = home / ".local" / "share" / "dgc"
        self.assertEqual(link_target(launcher), str(data / "versions" / "0.90.2" / ".venv" / "bin" / "dgc"))
        self.assertIn(f"previous install left at {tree}", output(done))
        self.assertTrue((tree / ".venv" / "bin" / "dgc").exists())
        self.assertFalse((tree / "versions").exists())


# ------------------------------------------------------------------- units ---

class LayoutUnits(unittest.TestCase):

    def test_retention_only_sweeps_what_an_installer_could_have_started(self):
        data = new_home("retain") / "chosen"
        versions = data / "versions"
        for name in ("1.0.0", "1.0.1", "1.0.2", "1.0.3", "1.0.4"):
            (versions / name).mkdir(parents=True)
            (versions / name / ".complete").write_text(f"version={name}\nsha256=x\n")
        old = time.time() - 2 * 3600
        for name in ("my-notes", "0.9.9", "backup of 1.0.0"):
            (versions / name).mkdir()
            (versions / name / "keep.txt").write_text("mine\n")
            os.utime(versions / name, (old, old))
        (versions / "0.9.8").mkdir()                      # an unfinished build started just now
        removed = L.retain(data, "1.0.4")
        self.assertEqual(sorted(removed, key=L.version_key), ["0.9.9", "1.0.0", "1.0.1"])
        self.assertEqual(sorted(p.name for p in versions.iterdir()),
                         ["0.9.8", "1.0.2", "1.0.3", "1.0.4", "backup of 1.0.0", "my-notes"])
        self.assertEqual((versions / "my-notes" / "keep.txt").read_text(), "mine\n")

    def test_the_launcher_flip_is_never_seen_half_done(self):
        home = new_home("flip")
        a, b = home / "a" / "dgc", home / "b" / "dgc"
        for target in (a, b):
            target.parent.mkdir()
            target.write_text("#!/bin/sh\n")
        launcher = home / "bin" / "dgc"
        L.flip_launcher(launcher, a)
        bad: list[object] = []
        reads = [0]
        stop = threading.Event()

        def reader():
            while not stop.is_set():
                try:
                    seen = os.readlink(launcher)
                except OSError as exc:            # missing, even for an instant, is a failure
                    bad.append(exc)
                    continue
                if seen not in (str(a), str(b)):
                    bad.append(seen)
                reads[0] += 1

        threads = [threading.Thread(target=reader) for _ in range(3)]
        for thread in threads:
            thread.start()
        try:
            for index in range(4000):
                L.flip_launcher(launcher, b if index % 2 == 0 else a)
        finally:
            stop.set()
            for thread in threads:
                thread.join()
        self.assertEqual(bad, [])
        self.assertGreater(reads[0], 1000)
        self.assertEqual(os.readlink(launcher), str(a))
        self.assertEqual(sorted(p.name for p in launcher.parent.iterdir()), ["dgc"], "no temporary links left")


# ---------------------------------------------------------- interrupted builds ---

class InterruptedBuilds(unittest.TestCase):
    """Ctrl-C and SIGKILL in the middle of a build, in directories whose names have spaces."""

    def test_an_interrupted_build_is_never_switched_to_and_the_next_update_rebuilds_it(self):
        home = new_home("interrupt")
        data, bin_dir = home / "Data Dir" / "dgc data", home / "my bin"
        launcher = bin_dir / "dgc"
        env = clean_env(home, DGC_DATA_DIR=str(data), DGC_BIN=str(bin_dir))
        SITE.publish(release("0.91.1"))
        first = run_installer(env)
        self.assertEqual(first.returncode, 0, output(first)[-3000:])
        good = str(data / "versions" / "0.91.1" / ".venv" / "bin" / "dgc")
        self.assertEqual(link_target(launcher), good)

        # A python3 that parks before creating the new version's virtualenv — by then the release
        # is unpacked into versions/<v> and the build is under way.
        real_python = shutil.which("python3", path=env["PATH"])
        slow_dir = home / "slow python"
        slow_dir.mkdir()
        (slow_dir / "python3").write_text(
            "#!/usr/bin/env bash\n"
            'if [ "${1:-}" = -m ] && [ "${2:-}" = venv ] && [ -n "${DGC_TEST_SLOW_VENV:-}" ]; then\n'
            '  : > "$DGC_TEST_SLOW_VENV"; sleep 300\n'
            "fi\n"
            f'exec "{real_python}" "$@"\n')
        (slow_dir / "python3").chmod(0o755)
        marker = home / "venv-started"
        SITE.publish(release("0.91.2"))
        vdir = data / "versions" / "0.91.2"

        def interrupted(sig: int) -> subprocess.CompletedProcess:
            marker.unlink(missing_ok=True)
            slow = dict(env, PATH=str(slow_dir) + os.pathsep + env["PATH"], DGC_TEST_SLOW_VENV=str(marker))
            proc = subprocess.Popen(["bash", str(INSTALLER)], env=slow, cwd=str(home), text=True,
                                    stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT, start_new_session=True)
            deadline = time.monotonic() + BUILD_TIMEOUT
            while not marker.exists() and proc.poll() is None and time.monotonic() < deadline:
                time.sleep(0.05)
            try:
                self.assertTrue(marker.exists(), "the build never reached the virtualenv step")
                self.assertTrue(vdir.is_dir())
                self.assertFalse((vdir / ".complete").exists())
                os.killpg(proc.pid, sig)
            finally:
                if proc.poll() is None and not marker.exists():
                    os.killpg(proc.pid, signal.SIGKILL)
                text = proc.stdout.read()
                proc.stdout.close()
                code = proc.wait(timeout=60)
            return subprocess.CompletedProcess(proc.args, code, text, "")

        stopped = interrupted(signal.SIGINT)
        self.assertEqual(stopped.returncode, 130, stopped.stdout[-2000:])
        self.assertFalse(vdir.exists(), "Ctrl-C removes the unfinished build")
        self.assertEqual(link_target(launcher), good)

        killed = interrupted(signal.SIGKILL)
        self.assertEqual(killed.returncode, -signal.SIGKILL)
        self.assertTrue(vdir.is_dir(), "nothing runs after SIGKILL: the unfinished build stays behind")
        self.assertEqual(link_target(launcher), good)
        fd = L.acquire_update_lock(data)
        self.assertIsNotNone(fd, "the kernel released the killed installer's lock")
        L.release_update_lock(fd)
        offline = dict(env, DGC_BASE_URL="http://127.0.0.1:9")
        offline.pop("DGC_DATA_DIR")
        offline.pop("DGC_BIN")
        listed = run_dgc(launcher, ["update", "--list"], offline)
        self.assertEqual(listed.returncode, 0, output(listed))
        self.assertIn("0.91.1", listed.stdout)
        self.assertNotIn("0.91.2", listed.stdout)
        refused = run_dgc(launcher, ["update", "--version", "0.91.2"], offline)
        self.assertEqual(refused.returncode, 1, output(refused)[-2000:])
        self.assertEqual(link_target(launcher), good)

        # The next update, self-located from the spaced paths, rebuilds and switches.
        plain = {key: value for key, value in env.items() if key not in ("DGC_DATA_DIR", "DGC_BIN")}
        done = run_dgc(launcher, ["update"], plain)
        self.assertEqual(done.returncode, 0, output(done)[-3000:])
        self.assertEqual(link_target(launcher), str(vdir / ".venv" / "bin" / "dgc"))
        self.assertIsNotNone(L.read_complete(vdir))
        self.assertEqual(run_dgc(launcher, ["--version"], plain).stdout.strip(), "dgc 0.91.2")
        record = json.loads((home / ".dgc" / "install.json").read_text())
        self.assertEqual((record["data_dir"], record["bin_dir"], record["channel"]),
                         (str(data), str(bin_dir), "latest"))


# ---------------------------------------------------------------- refusals ---

class LauncherRefusals(unittest.TestCase):

    def _checkout_launcher(self, home: Path) -> tuple[Path, Path]:
        checkout = home / "src" / "dgc"
        (checkout / ".git").mkdir(parents=True)
        (checkout / "requirements.lock").write_text("rich==15.0.0\n")
        (checkout / ".venv" / "bin").mkdir(parents=True)
        (checkout / ".venv" / "bin" / "dgc").write_text("#!/bin/sh\necho dev\n")
        (checkout / ".venv" / "bin" / "dgc").chmod(0o755)
        (checkout / "dgc").mkdir()
        (checkout / "dgc" / "agent.py").write_text("# uncommitted work\n")
        launcher = home / ".local" / "bin" / "dgc"
        launcher.parent.mkdir(parents=True)
        launcher.symlink_to(checkout / ".venv" / "bin" / "dgc")
        return checkout, launcher

    def test_a_launcher_that_runs_a_git_checkout_is_never_repointed(self):
        home = new_home("refuse-checkout")
        checkout, launcher = self._checkout_launcher(home)
        SITE.publish(release("0.90.2"))
        done = run_installer(clean_env(home))
        text = output(done)
        self.assertNotEqual(done.returncode, 0, text)
        self.assertIn("is a git checkout", text)
        self.assertIn("DGC_FORCE_OVERWRITE=1", text)
        self.assertIn("DGC_BIN=", text)
        self.assertNotIn("downloading DGC", text, "the refusal costs no download")
        self.assertEqual(link_target(launcher), str(checkout / ".venv" / "bin" / "dgc"))
        self.assertEqual((checkout / "dgc" / "agent.py").read_text(), "# uncommitted work\n")
        self.assertFalse((home / ".local" / "share" / "dgc").exists())

        # The override gets past the guard (to a download that fails here) — still no switch.
        forced = run_installer(clean_env(home, DGC_FORCE_OVERWRITE="1", DGC_BASE_URL="http://127.0.0.1:9"))
        self.assertIn("downloading DGC", output(forced))
        self.assertEqual(forced.returncode, 1, output(forced))
        self.assertEqual(link_target(launcher), str(checkout / ".venv" / "bin" / "dgc"))

    def test_a_launcher_the_installer_did_not_make_is_not_replaced(self):
        home = new_home("refuse-foreign")
        launcher = home / ".local" / "bin" / "dgc"
        launcher.parent.mkdir(parents=True)
        launcher.write_text("#!/bin/sh\necho mine\n")
        done = run_installer(clean_env(home))
        self.assertNotEqual(done.returncode, 0, output(done))
        self.assertIn("not created by the DGC installer", output(done))
        self.assertEqual(launcher.read_text(), "#!/bin/sh\necho mine\n")
        elsewhere = home / "bin" / "dgc"
        elsewhere.parent.mkdir()
        elsewhere.write_text("x")
        link = home / "other-bin" / "dgc"
        link.parent.mkdir()
        link.symlink_to(elsewhere)
        refused = run_installer(clean_env(home, DGC_BIN=str(link.parent)))
        self.assertNotEqual(refused.returncode, 0, output(refused))
        self.assertEqual(os.readlink(link), str(elsewhere))

    def test_dgc_update_from_a_checkout_refuses_before_downloading(self):
        home = new_home("update-checkout")
        checkout, _launcher = self._checkout_launcher(home)
        location = L.locate(env={}, prefix=str(checkout / ".venv"), argv0="")
        self.assertEqual(location.kind, "checkout")
        from dgc import update
        printed = io.StringIO()
        with mock.patch.object(L, "locate", return_value=location), \
                mock.patch.object(update, "_download_installer", side_effect=AssertionError("downloaded")), \
                mock.patch.dict(os.environ, {"DGC_FORCE_OVERWRITE": ""}), \
                contextlib.redirect_stdout(printed):
            code = update.run_update([])
        self.assertEqual(code, 1, printed.getvalue())
        self.assertIn("git checkout", printed.getvalue())

    def test_self_location_reads_sys_prefix_not_the_interpreter_symlink(self):
        home = new_home("locate")
        vdir = home / "data" / "versions" / "1.2.3"
        (vdir / ".venv" / "bin").mkdir(parents=True)
        (vdir / ".complete").write_text("version=1.2.3\nsha256=x\n")
        # A venv's python is a symlink to the system interpreter: realpath(sys.executable) says
        # nothing about the install. sys.prefix does.
        (vdir / ".venv" / "bin" / "python").symlink_to(os.path.realpath(sys.executable))
        (vdir / ".venv" / "bin" / "dgc").write_text("#!/bin/sh\n")
        launcher = home / "bin" / "dgc"
        launcher.parent.mkdir()
        launcher.symlink_to(vdir / ".venv" / "bin" / "dgc")
        with mock.patch.object(L.Path, "home", return_value=home):
            location = L.locate(env={}, prefix=str(vdir / ".venv"), argv0=str(launcher))
        self.assertEqual((location.kind, location.data_dir, location.bin_dir, location.version),
                         ("versions", home / "data", home / "bin", "1.2.3"))
        self.assertIsNone(L.running_version_dir(os.path.dirname(os.path.dirname(
            os.path.realpath(vdir / ".venv" / "bin" / "python")))))



# --------------------------------------------------------- QA 0.39 regressions ---

def fake_version(data: Path, name: str) -> Path:
    """A complete versions/<name> whose dgc just names itself (no build)."""
    vdir = data / "versions" / name
    (vdir / ".venv" / "bin").mkdir(parents=True)
    (vdir / ".complete").write_text(f"version={name}\nsha256=x\n")
    script = vdir / ".venv" / "bin" / "dgc"
    script.write_text(f"#!/bin/sh\necho 'dgc {name}'\n")
    script.chmod(0o755)
    return vdir


def fake_legacy_tree(tree: Path, launcher: Path) -> None:
    """The shape of a 0.38 single-tree install: requirements.lock, .venv/bin/dgc and a link to it."""
    (tree / ".venv" / "bin").mkdir(parents=True)
    (tree / "requirements.lock").write_text("rich==15.0.0\n")
    (tree / ".venv" / "bin" / "dgc").write_text("#!/bin/sh\necho 'dgc 0.38.1'\n")
    (tree / ".venv" / "bin" / "dgc").chmod(0o755)
    launcher.parent.mkdir(parents=True, exist_ok=True)
    launcher.symlink_to(tree / ".venv" / "bin" / "dgc")


class QaInstallerRegressions(unittest.TestCase):

    def test_a_custom_install_on_path_is_updated_in_place_when_no_location_is_given(self):
        # A 0.38 CLI's `dgc update` pipes the installer into bash with no DGC_DIR or DGC_BIN. The
        # installer used to build a second copy in the defaults and say "updated" while the
        # user's `dgc` stayed on 0.38 forever.
        home = new_home("adopt-path")
        tree, bin_dir = home / "tools" / "dgc", home / "tools" / "bin"
        fake_legacy_tree(tree, bin_dir / "dgc")
        env = clean_env(home)
        env["PATH"] = str(bin_dir) + os.pathsep + env["PATH"]
        SITE.publish(release("0.90.2"))
        done = subprocess.run(["bash", "-c", f'curl -fsSL "{SITE.url}/install.sh" | bash'],
                              env=env, capture_output=True, text=True, timeout=BUILD_TIMEOUT,
                              cwd=str(home))
        text = output(done)
        self.assertEqual(done.returncode, 0, text[-3000:])
        self.assertIn(f"found DGC on your PATH at {bin_dir / 'dgc'}", text)
        self.assertEqual(link_target(bin_dir / "dgc"),
                         str(tree / "versions" / "0.90.2" / ".venv" / "bin" / "dgc"))
        self.assertFalse(os.path.lexists(home / ".local" / "bin" / "dgc"), "no second launcher")
        self.assertFalse((home / ".local" / "share" / "dgc" / "versions").exists())
        self.assertNotIn("`dgc` on your PATH is", text)
        # An update prints an update result, not first-install guidance; nothing else is kept, so
        # there is no rollback hint, and a skipped extension is not said to be installed.
        self.assertNotIn("DGC is installed. Next", text)
        self.assertNotIn("dgc update --rollback", text)
        self.assertNotIn("Editor extension", text)

        again = run_installer(env)
        self.assertEqual(again.returncode, 0, output(again)[-3000:])
        self.assertIn("DGC 0.90.2 is already installed and active", output(again))
        self.assertIn("DGC 0.90.2 is active →", output(again))
        self.assertNotIn("installed DGC 0.90.2", output(again))
        self.assertNotIn("switching to it", output(again))

    def test_a_launcher_outside_home_is_not_adopted_and_the_path_mismatch_is_named(self):
        home = new_home("adopt-outside")
        outside = home.parent / "elsewhere"
        fake_legacy_tree(outside / "dgc", outside / "bin" / "dgc")
        env = clean_env(home)
        env["PATH"] = str(outside / "bin") + os.pathsep + env["PATH"]
        SITE.publish(release("0.90.2"))
        done = run_installer(env)
        text = output(done)
        self.assertEqual(done.returncode, 0, text[-3000:])
        self.assertNotIn("found DGC on your PATH", text)
        launcher = home / ".local" / "bin" / "dgc"
        self.assertEqual(link_target(launcher), str(home / ".local" / "share" / "dgc" / "versions"
                                                     / "0.90.2" / ".venv" / "bin" / "dgc"))
        self.assertIn(f"`dgc` on your PATH is {outside / 'bin' / 'dgc'}", text)
        self.assertIn("DGC is installed. Next", text, "a first install still gets the guidance")
        self.assertNotIn("Editor extension", text, "DGC_SKIP_EXTENSION=1: nothing was installed")
        self.assertNotIn("dgc update --rollback", text, "nothing to roll back to")

    def test_a_damaged_archive_with_a_matching_checksum_is_reported_as_damaged(self):
        home = new_home("damaged")
        SITE.publish(release("0.90.2")[:4000])
        done = run_installer(clean_env(home))
        self.assertEqual(done.returncode, 1, output(done))
        self.assertIn("the downloaded archive is damaged", output(done))
        self.assertNotIn("does not name a valid version", output(done))
        self.assertFalse(os.path.lexists(home / ".local" / "bin" / "dgc"))

    def test_a_stale_runtime_lock_with_an_unrelated_live_pid_does_not_keep_a_republished_build(self):
        home = new_home("stale-lock")
        env = clean_env(home)
        data = home / ".local" / "share" / "dgc"
        active = fake_version(data, "0.90.3")
        vdir = fake_version(data, "0.90.4")                       # built from another archive
        launcher = home / ".local" / "bin" / "dgc"
        launcher.parent.mkdir(parents=True)
        launcher.symlink_to(active / ".venv" / "bin" / "dgc")
        unrelated = subprocess.Popen(["sleep", "120"])
        try:
            (data / "locks" / "0.90.4").mkdir(parents=True)
            (data / "locks" / "0.90.4" / str(unrelated.pid)).write_text("{}\n")
            SITE.publish(release("0.90.4"))
            done = run_installer(env)
        finally:
            unrelated.kill()
            unrelated.wait(10)
        text = output(done)
        self.assertEqual(done.returncode, 0, text[-3000:])
        self.assertIn("installed from a different archive — rebuilding it", text)
        self.assertNotIn("in use — keeping it", text)
        self.assertEqual(L.read_complete(vdir)["sha256"], hashlib.sha256(release("0.90.4")).hexdigest())

    def test_a_process_that_dies_of_sigterm_releases_its_runtime_lock(self):
        home = new_home("lock-sigterm")
        vdir = fake_version(home / "data", "1.2.3")
        program = ("import os, signal, sys\n"
                   "from dgc import install_layout, termbg\n"
                   "lock = install_layout.hold_runtime_lock(prefix=sys.argv[1])\n"
                   "print(lock, flush=True)\n"
                   "termbg.resend(signal.SIGTERM, {})\n")
        done = subprocess.run([sys.executable, "-c", program, str(vdir / ".venv")],
                              capture_output=True, text=True, timeout=60,
                              env=dict(os.environ, PYTHONPATH=str(PROJECT)))
        self.assertEqual(done.returncode, -signal.SIGTERM, done.stderr)
        lock = Path(done.stdout.strip())
        self.assertEqual(lock.parent, home / "data" / "locks" / "1.2.3")
        self.assertFalse(lock.exists(), "dying of the signal must not leave the lock behind")

    def test_rollback_returns_to_the_previous_version_and_a_no_op_keeps_it_recorded(self):
        home = new_home("rollback-previous")
        data, bin_dir = home / "data", home / "bin"
        for name in ("0.39.1", "0.39.0", "0.38.7"):
            fake_version(data, name)
        from dgc import update
        with mock.patch.object(L.Path, "home", return_value=home):
            quiet = []
            self.assertEqual(L.activate(data, bin_dir, "0.39.0", out=quiet.append), 0)
            self.assertEqual(L.activate(data, bin_dir, "0.39.1", out=quiet.append), 0)
            self.assertEqual(L.read_record()["previous_version"], "0.39.0")
            # An update with nothing new re-activates the same version: not a switch.
            self.assertEqual(L.activate(data, bin_dir, "0.39.1", out=quiet.append), 0)
            self.assertEqual((L.read_record()["version"], L.read_record()["previous_version"]),
                             ("0.39.1", "0.39.0"))
            self.assertEqual(L.activate(data, bin_dir, "0.38.7", out=quiet.append), 0)
            location = L.Location("versions", data, bin_dir, data / "versions" / "0.38.7", "0.38.7")
            printed = io.StringIO()
            from rich.console import Console
            code = update._switch_to(Console(file=printed, width=200), location, None)
            self.assertEqual(code, 0, printed.getvalue())
            self.assertEqual(L.inspect_launcher(bin_dir / "dgc").tree.name, "0.39.1",
                             "rollback returns to the version before the last switch, even a newer one")
            self.assertEqual(L.read_record()["previous_version"], "0.38.7")

    def test_the_launcher_reached_through_another_link_is_the_one_that_points_at_the_venv(self):
        home = new_home("argv0-chain")
        vdir = fake_version(home / "opt" / "dgc", "0.39.0")
        inner = home / "opt" / "bin" / "dgc"
        inner.parent.mkdir(parents=True)
        inner.symlink_to(vdir / ".venv" / "bin" / "dgc")
        outer = home / ".local" / "bin" / "dgc"
        outer.parent.mkdir(parents=True)
        outer.symlink_to(inner)
        self.assertEqual(L._launcher_from_argv0(vdir / ".venv", str(outer)), inner.parent)
        self.assertEqual(L._launcher_from_argv0(vdir / ".venv", str(inner)), inner.parent)

    def test_update_list_runs_from_a_checkout_and_refusals_give_a_runnable_command(self):
        home = new_home("list-checkout")
        checkout = home / "src" / "dgc"
        (checkout / ".git").mkdir(parents=True)
        (checkout / ".venv").mkdir()
        location = L.locate(env={}, prefix=str(checkout / ".venv"), argv0="")
        self.assertEqual(location.kind, "checkout")
        from dgc import update
        printed = io.StringIO()
        with mock.patch.object(L, "locate", return_value=location), \
                mock.patch.object(update, "_download_installer", side_effect=AssertionError("downloaded")), \
                mock.patch.dict(os.environ, {"DGC_FORCE_OVERWRITE": "", "COLUMNS": "60"}), \
                contextlib.redirect_stdout(printed):
            listed = update.run_update(["--list"])
            refused = update.run_update([])
        self.assertEqual(listed, 0, printed.getvalue())
        self.assertIn("no versioned DGC installs in", printed.getvalue())
        self.assertEqual(refused, 1)
        self.assertIn("install.sh | DGC_DATA_DIR=", printed.getvalue())
        self.assertNotIn("bash install.sh", printed.getvalue())
        refusal = L.launcher_refusal(L.Launcher(home / "bin" / "dgc", "foreign"), False)
        self.assertIn("curl -fsSL https://vibedgc.com/install.sh | DGC_BIN=<dir> bash", refusal)
        installer = INSTALLER.read_text()
        self.assertNotIn("bash install.sh", installer.split("set -euo pipefail", 1)[1])

    def test_update_list_prints_long_paths_whole(self):
        home = new_home("soft-wrap")
        data = home / ("a-very-long-directory-name-" * 4) / "data"
        fake_version(data, "0.39.0")
        from dgc import update
        from rich.console import Console
        printed = io.StringIO()
        location = L.Location("versions", data, home / "bin", data / "versions" / "0.39.0", "0.39.0")
        update._list_versions(Console(file=printed, width=60), location)
        self.assertIn(str(L.versions_dir(data)), printed.getvalue())

    def test_rollback_and_version_switch_print_the_launcher_path_whole(self):
        # The 'switched <launcher> → DGC X (was Y)' line hard-wrapped at the terminal width and split
        # the launcher path across lines; every `dgc update` message now prints paths whole.
        home = new_home("switch-soft-wrap")
        root = home / ("a-very-long-directory-name-" * 4)
        data, bin_dir = root / "data", root / "bin"
        for name in ("0.39.0", "0.38.9"):
            fake_version(data, name)
        from dgc import update
        with mock.patch.object(L.Path, "home", return_value=home):
            quiet = []
            self.assertEqual(L.activate(data, bin_dir, "0.39.0", out=quiet.append), 0)
            self.assertEqual(L.activate(data, bin_dir, "0.38.9", out=quiet.append), 0)
            launcher = bin_dir / "dgc"
            for args, target in ((["--rollback"], "0.39.0"), (["--version", "0.38.9"], "0.38.9"),
                                 (["--version", "0.38.9"], "0.38.9")):
                location = L.Location("versions", data, bin_dir, None, None)
                printed = io.StringIO()
                with mock.patch.object(L, "locate", return_value=location), \
                        mock.patch.dict(os.environ, {"DGC_FORCE_OVERWRITE": "", "COLUMNS": "60"}), \
                        contextlib.redirect_stdout(printed):
                    code = update.run_update(args)
                self.assertEqual(code, 0, printed.getvalue())
                self.assertEqual(L.inspect_launcher(launcher).tree.name, target)
                self.assertIn(str(launcher), printed.getvalue(), printed.getvalue())

    def test_every_refusal_offers_an_override_command_that_runs_as_printed(self):
        # The refusals ended in a bare 'DGC_FORCE_OVERWRITE=1': a variable, not something to run.
        # Each now prints the install it refused, at the same place, with the guard lifted.
        home = new_home("forced-command")
        custom = home / "my tools"
        bin_dir, data = custom / "bin", custom / "data dir"
        launcher = bin_dir / "dgc"
        launcher.parent.mkdir(parents=True)
        launcher.write_text("#!/bin/sh\necho mine\n")
        checkout_data = home / "src" / "dgc"
        (checkout_data / ".git").mkdir(parents=True)
        saved = dict(SITE.files)
        self.addCleanup(lambda: setattr(SITE, "files", saved))
        SITE.files = {"/install.sh": INSTALLER.read_bytes()}     # no archive: the forced run stops at the download
        for env, refusal in ((clean_env(home, DGC_BIN=str(bin_dir), DGC_DATA_DIR=str(data)), "not created by the DGC installer"),
                             (clean_env(home, DGC_BIN=str(home / "bin"), DGC_DATA_DIR=str(checkout_data)), "is a git checkout")):
            done = run_installer(env)
            text = output(done)
            self.assertNotEqual(done.returncode, 0, text)
            self.assertIn(refusal, text)
            last = [line for line in text.replace("\x1b[0m", "").splitlines() if "anyway" in line][-1]
            command = last.split(":  ", 1)[1].strip()
            self.assertNotEqual(command, "DGC_FORCE_OVERWRITE=1", last)
            self.assertTrue(command.startswith(f"curl -fsSL {SITE.url}/install.sh | "), command)
            self.assertTrue(command.endswith("DGC_FORCE_OVERWRITE=1 bash"), command)
            bare = {key: value for key, value in env.items() if not key.startswith("DGC_")}
            bare["DGC_SKIP_EXTENSION"] = "1"
            forced = subprocess.run(["bash", "-c", command], env=bare, capture_output=True, text=True,
                                    timeout=BUILD_TIMEOUT, stdin=subprocess.DEVNULL, cwd=str(home))
            self.assertNotIn(refusal, output(forced), "the printed command gets past the guard")
            self.assertIn("downloading DGC", output(forced))
        self.assertEqual(launcher.read_text(), "#!/bin/sh\necho mine\n")
        refusal = L.launcher_refusal(L.Launcher(launcher, "foreign"), False)
        self.assertIn(f"DGC_BIN={shlex.quote(str(bin_dir))} DGC_FORCE_OVERWRITE=1 bash", refusal)
        # dgc update --version names itself as the override.
        fake_version(data, "0.39.0")
        location = L.Location("versions", data, bin_dir, None, None)
        printed = io.StringIO()
        from dgc import update
        from rich.console import Console
        with mock.patch.dict(os.environ, {"DGC_FORCE_OVERWRITE": ""}):
            code = update._switch_to(Console(file=printed, width=300), location, "0.39.0")
        self.assertEqual(code, 1, printed.getvalue())
        self.assertIn("Or replace it anyway:  DGC_FORCE_OVERWRITE=1 dgc update --version 0.39.0", printed.getvalue())

    def test_update_help_names_the_base_url_and_every_exit_status(self):
        from dgc import cli
        printed = io.StringIO()
        with contextlib.redirect_stdout(printed):
            cli._subcommand_help("update")
        text = printed.getvalue()
        self.assertIn("$DGC_BASE_URL", text)
        self.assertIn("2 usage error", text)
        self.assertIn("version that was active before the last switch", text)

    def test_the_upgrade_guide_names_the_current_protocol(self):
        from dgc.editor_protocol import PROTOCOL_VERSION
        guide = (PROJECT / "docs" / "UPGRADING.md").read_text()
        self.assertIn(f"use editor protocol v{PROTOCOL_VERSION}", guide)
        self.assertNotIn("0.30.1", guide)
        self.assertIn("dgc update --rollback", guide)

if __name__ == "__main__":
    unittest.main()
