"""The apps on a Pip computer's desktop besides the browser, Files and Terminal (founder, 2026-10-20: "Pips use
the whole desktop"): an image editor, a document editor and a PDF viewer, on its dock and for the Pip to open.

- **Image editor:** LibreOffice Draw (text, shapes, colours, photos; File > Export makes a PNG). Picked for the
  founder's "design me my birthday shirts" because it is already on most Linux desktops, so nothing is downloaded
  or set up; GIMP and Inkscape are not here, and their downloads would be one more thing to keep working.
- **Document editor:** LibreOffice Writer.
- **PDF viewer:** Evince.

Each app opens in a box of its own (bubblewrap, like the browser and the Terminal): the system's programs
read-only, the computer's Files as the only folder it sees, its settings in a private folder beside Files
(``home/.apps``, which the Terminal never sees), and its window on the Pip's screen. **Online like the Terminal**
(founder, 2026-10-20, as OpenMausBot's desktops are): its only way out is the computer's egress proxy, through an
in-box relay and the standard proxy settings, which reaches public websites and never this computer, the local
network, link-local or cloud metadata addresses. An app can send to a public website without an Allow card, as the
Terminal can; only the browser holds what it would submit for the user's Allow.

Where they come from: this computer's own LibreOffice and Evince when it has them (most desktops do). When it
lacks them and uses apt, DGC offers, once, to download them from the distribution's own signed package servers
into its own folder (the way it gets the desktop's programs, pip_screen_setup): one plain line saying what and how
big, measured by apt for this computer. Nothing is installed system-wide and no password is asked.

A program is started from its own mount point inside the box (/opt/apps/...), never /usr's path: Ubuntu's
AppArmor profiles for LibreOffice and Evince can't follow a box's paths ("disconnected path") and refuse their X
connection, as Chrome's would if DGC ran it from /opt/google.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

from .workspace_registry import RegistryError

# key -> what the dock and the Pip call it, its program, and the packages it comes in.
APPS = {
    "images": {"name": "Image editor", "program": "LibreOffice Draw", "module": "libsdlo.so", "args": ["--draw"],
               "packages": ["libreoffice-draw", "libreoffice-gtk3"], "icon": "images.png"},
    "documents": {"name": "Documents", "program": "LibreOffice Writer", "module": "libswlo.so", "args": ["--writer"],
                  "packages": ["libreoffice-writer", "libreoffice-gtk3"], "icon": "documents.png"},
    "pdf": {"name": "PDF viewer", "program": "Evince", "module": None, "args": [], "packages": ["evince"],
            "icon": "pdf.png"},
}
OPENS = {"images": (".odg", ".png", ".jpg", ".jpeg", ".svg", ".gif", ".bmp", ".webp", ".pdf"),
         "documents": (".odt", ".docx", ".doc", ".rtf", ".txt", ".html", ".htm", ".md"),
         "pdf": (".pdf",)}
LIBREOFFICE = Path("/usr/lib/libreoffice")
EVINCE = Path("/usr/bin/evince")
APP_MEMORY = 2 * 1024 ** 3
MAX_RUNNING = 6
OFFER = "apps.json"
# LibreOffice opens with none of its first-run screens: no tip of the day, no "what's new" or donation bars, no
# crash reporter, no recovery dialog (a Pip's app that was stopped is not a crash to recover), macros off, and its
# Open, Save and Export dialogs start in the computer's Files (they opened in /tmp), and in Draw ctrl+shift+e is Export:
# a Pip makes a PNG with keys alone (its File menu and the export dialog's type list are small targets).
LIBREOFFICE_SETTINGS = """<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Common/Misc"><prop oor:name="ShowTipOfTheDay" oor:op="fuse"><value>false</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Misc"><prop oor:name="FirstRun" oor:op="fuse"><value>false</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Misc"><prop oor:name="CrashReport" oor:op="fuse"><value>false</value></prop></item>
<item oor:path="/org.openoffice.Setup/Product"><prop oor:name="ooSetupLastVersion" oor:op="fuse"><value>99.0</value></prop></item>
<item oor:path="/org.openoffice.Setup/Product"><prop oor:name="LastTimeGetInvolvedShown" oor:op="fuse"><value>4102444800</value></prop></item>
<item oor:path="/org.openoffice.Setup/Product"><prop oor:name="LastTimeDonateShown" oor:op="fuse"><value>4102444800</value></prop></item>
<item oor:path="/org.openoffice.Office.Recovery/AutoSave"><prop oor:name="Enabled" oor:op="fuse"><value>false</value></prop></item>
<item oor:path="/org.openoffice.Office.Recovery/RecoveryInfo"><prop oor:name="Enabled" oor:op="fuse"><value>false</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Save/Document"><prop oor:name="WarnAlienFormat" oor:op="fuse"><value>false</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Paths/Paths/org.openoffice.Office.Paths:NamedPath['Work']"><prop oor:name="WritePath" oor:op="fuse"><value>file:///home/pip/Files</value></prop></item>
<item oor:path="/org.openoffice.Office.Accelerators/PrimaryKeys/Modules/org.openoffice.Office.Accelerators:Module['com.sun.star.drawing.DrawingDocument']"><node oor:name="E_SHIFT_MOD1" oor:op="replace"><prop oor:name="Command"><value xml:lang="en-US">.uno:ExportTo</value></prop></node></item>
</oor:items>
"""


# --------------------------------------------------------------------------- where each app is

def _elf(path: Path) -> bool:
    try:
        with open(path, "rb") as handle:
            return handle.read(4) == b"\x7fELF"
    except OSError:
        return False


def _downloaded_root() -> Path | None:
    if not sys.platform.startswith("linux"):
        return None
    from . import pip_screen_setup
    return pip_screen_setup.current_root()


def find(key: str) -> dict | None:
    """Where an app's program is: {"source": "system"} or {"source": "dgc", "root": <unpacked packages>}, or None."""
    app = APPS.get(key)
    if app is None or not sys.platform.startswith("linux"):
        return None
    if key == "pdf":
        if _elf(EVINCE):
            return {"source": "system"}
        root = _downloaded_root()
        if root is not None and _elf(root / "usr" / "bin" / "evince"):
            return {"source": "dgc", "root": root}
        return None
    if (LIBREOFFICE / "program" / "soffice").is_file():
        # The system's LibreOffice: this app only when its part (Draw, Writer) is installed too. A LibreOffice split
        # between the system and DGC's folder can't run from one place, so it is never mixed.
        return {"source": "system"} if (LIBREOFFICE / "program" / app["module"]).is_file() else None
    root = _downloaded_root()
    if root is not None and (root / "usr/lib/libreoffice/program" / app["module"]).is_file():
        return {"source": "dgc", "root": root}
    return None


def status() -> list[dict]:
    """Each app: its key, its name, the program, and whether this computer has it."""
    return [{"key": key, "name": app["name"], "program": app["program"], "available": find(key) is not None}
            for key, app in APPS.items()]


def missing() -> list[str]:
    return [key for key in APPS if find(key) is None]


# --------------------------------------------------------------------------- the one offer to download

def _offer_path() -> Path:
    from . import pip_screen_setup
    return pip_screen_setup.home() / OFFER


def _read_offer() -> dict:
    try:
        value = json.loads(_offer_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _write_offer(**fields) -> None:
    path = _offer_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    value = {**_read_offer(), **fields}
    tmp = path.with_suffix(f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(value), encoding="utf-8")
    os.replace(tmp, path)


def wanted_packages(keys=None) -> list[str]:
    """The packages for the apps this computer lacks (and can get from DGC's download): never a LibreOffice
    part when the system has LibreOffice itself."""
    out = []
    for key in (missing() if keys is None else keys):
        if key != "pdf" and (LIBREOFFICE / "program" / "soffice").is_file():
            continue
        for name in APPS[key]["packages"]:
            if name not in out:
                out.append(name)
    return out


def record_measure(packages: dict, size: int) -> None:
    """The setup measured what the missing apps would download (apt, for this computer): kept for the offer."""
    _write_offer(measured={"packages": {str(k): str(v) for k, v in list(packages.items())[:200]},
                           "bytes": int(size), "at": time.time()})


def needs_measure() -> bool:
    """Whether the offer still waits for its size: apps are missing, DGC could fetch them, nobody has answered, and no
    measuring was tried in the last hour (one that can't finish never retries in a loop)."""
    from . import pip_screen_setup
    if not missing() or not wanted_packages() or not pip_screen_setup.supported()[0]:
        return False
    saved = _read_offer()
    if saved.get("answer") in ("yes", "no") or isinstance(saved.get("measured"), dict):
        return False
    tried = saved.get("tried")
    return not (isinstance(tried, (int, float)) and time.time() - tried < 3600)


def note_measuring() -> None:
    _write_offer(tried=time.time())


def consented() -> bool:
    return _read_offer().get("answer") == "yes"


def _mb(size: int) -> str:
    return f"{max(1, round(size / 1_000_000))} MB"


def offer() -> dict:
    """What the computer's screen says about its apps: {apps, missing, state, line, bytes}.

    ``state``: "ready" (every app is here), "offer" (the one line to ask with, and its size), "downloading",
    "declined", "unavailable" (this computer can't get them itself: ``line`` says what to install), or "measuring"
    (the size is not known yet; nothing is asked until it is)."""
    from . import pip_screen_setup
    lacking = missing()
    base = {"apps": status(), "missing": lacking, "bytes": None}
    if not lacking:
        return {**base, "state": "ready", "line": ""}
    # A part of the system's own LibreOffice (Draw, Writer) is the system's to add: never mixed with a download.
    system_lo = (LIBREOFFICE / "program" / "soffice").is_file()
    fetchable = [k for k in lacking if k == "pdf" or not system_lo] if pip_screen_setup.supported()[0] else []
    if not fetchable:
        packages = " ".join(dict.fromkeys(p for k in lacking for p in APPS[k]["packages"] if p != "libreoffice-gtk3"))
        return {**base, "state": "unavailable",
                "line": f"To add its {_what(lacking)}, install {packages} with your package manager."}
    names = " and ".join(sorted({"LibreOffice" if k != "pdf" else "Evince" for k in fetchable}))
    saved = _read_offer()
    setup = pip_screen_setup.status()
    measured = saved.get("measured") if isinstance(saved.get("measured"), dict) else None
    size = measured.get("bytes") if measured and isinstance(measured.get("bytes"), int) and measured["bytes"] > 0 else None
    if saved.get("answer") == "yes":
        if setup["state"] == "failed":
            return {**base, "state": "offer", "bytes": size,
                    "line": f"The download of {names} stopped ({setup['error'][:160]}). Try again?"}
        return {**base, "state": "downloading", "line": f"Downloading {names} for its {_what(fetchable)}…"}
    if saved.get("answer") == "no":
        return {**base, "state": "declined", "line": ""}
    if size is None:
        return {**base, "state": "measuring", "line": ""}
    return {**base, "state": "offer", "bytes": size,
            "line": f"Add {_what(fetchable, article=True)} to this computer? DGC downloads {names} from your system's "
                    f"own package servers into its own folder: {_mb(size)}, once."}


WHAT = {"images": ("image editor", "an image editor"), "documents": ("document editor", "a document editor"),
        "pdf": ("PDF viewer", "a PDF viewer")}


def _what(keys, *, article=False) -> str:
    names = [WHAT[k][1 if article else 0] for k in keys]
    return names[0] if len(names) == 1 else ", ".join(names[:-1]) + " and " + names[-1]


def answer(choice, actor: str) -> dict:
    """The user's answer to the offer: "download" starts it now; "not_now" keeps it from asking again."""
    if actor not in ("editor-user", "local-console"):
        raise RegistryError("local_only", "Choose the computer's apps on this computer.")
    if choice not in ("download", "not_now"):
        raise RegistryError("invalid_request", "Choose download or not_now.")
    if choice == "not_now":
        _write_offer(answer="no", at=time.time())
        return offer()
    from . import pip_screen_setup
    if not pip_screen_setup.supported()[0]:
        raise RegistryError("unsupported", "This computer can't download its apps itself.")
    _write_offer(answer="yes", at=time.time())
    pip_screen_setup.start(needs=pip_screen_setup.wanted())
    return offer()


def after_unpack(root: Path) -> None:
    """Make DGC's own Evince runnable from its folder: its settings schemas compiled where it is told to look."""
    schemas = root / "usr" / "share" / "glib-2.0" / "schemas"
    if (root / "usr" / "bin" / "evince").is_file() and schemas.is_dir():
        try:
            subprocess.run(["glib-compile-schemas", str(schemas)], capture_output=True, timeout=60,
                           stdin=subprocess.DEVNULL, check=False)
        except (OSError, subprocess.SubprocessError):
            pass


# --------------------------------------------------------------------------- an app's box

def _triplets(prefix: str) -> str:
    return ":".join(f"{prefix}/usr/lib/{t}" for t in ("aarch64-linux-gnu", "x86_64-linux-gnu")) + f":{prefix}/usr/lib"


def seed_settings(config: Path) -> None:
    """The app's private settings folder, made once: LibreOffice without its first-run screens."""
    user = config / "libreoffice" / "user"
    user.mkdir(mode=0o700, parents=True, exist_ok=True)
    settings = user / "registrymodifications.xcu"
    if not settings.exists() and not settings.is_symlink():
        settings.write_text(LIBREOFFICE_SETTINGS, encoding="utf-8")


def box_argv(key: str, *, x11_dir: Path, files: Path, config: Path, file: str | None = None,
             display: str = ":1", egress: Path | None = None, forwarder: Path | None = None) -> list[str]:
    """bubblewrap around one app: the system read-only, Files and its settings, the Pip's screen, and with ``egress``
    (the computer's egress proxy socket) and ``forwarder`` (pip_computer_box.FORWARDER) its way to public websites,
    as the Terminal's. Without them it has no network at all."""
    where = find(key)
    if where is None:
        raise RegistryError("app_missing", f"This computer has no {APPS[key]['name'].lower()} yet.")
    from .pip_computer_box import timezone_args
    argv = ["bwrap", "--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--clearenv",
            "--setenv", "HOME", "/home/pip", "--setenv", "DISPLAY", display, "--setenv", "LANG", "C.UTF-8",
            "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "TMPDIR", "/tmp", "--setenv", "NO_AT_BRIDGE", "1",
            "--setenv", "GDK_BACKEND", "x11", "--setenv", "XDG_CONFIG_HOME", "/home/pip/.config", *timezone_args(),
            "--ro-bind", "/usr", "/usr", "--symlink", "usr/lib", "/lib", "--symlink", "usr/bin", "/bin",
            "--symlink", "usr/lib64", "/lib64", "--symlink", "usr/sbin", "/sbin",
            "--ro-bind", "/etc/fonts", "/etc/fonts", "--ro-bind-try", "/etc/alternatives", "/etc/alternatives",
            "--ro-bind-try", "/etc/ld.so.cache", "/etc/ld.so.cache", "--ro-bind-try", "/etc/localtime", "/etc/localtime",
            "--ro-bind-try", "/etc/xdg", "/etc/xdg", "--ro-bind-try", "/etc/gtk-3.0", "/etc/gtk-3.0"]
    own = where["source"] == "dgc"
    root = where.get("root")
    if own:
        argv += ["--ro-bind", str(root), "/opt/desk", "--setenv", "LD_LIBRARY_PATH", _triplets("/opt/desk"),
                 "--setenv", "XDG_DATA_DIRS", "/opt/desk/usr/share:/usr/share"]
    if key == "pdf":
        if own:
            backends = next((p for p in (root / "usr/lib").glob("*/evince/4/backends")), None)
            if backends is not None:
                argv += ["--setenv", "EV_BACKENDS_DIR", "/opt/desk/" + str(backends.relative_to(root))]
            argv += ["--setenv", "GSETTINGS_SCHEMA_DIR", "/opt/desk/usr/share/glib-2.0/schemas"]
            program = ["/opt/desk/usr/bin/evince"]
        else:
            argv += ["--ro-bind", str(EVINCE), "/opt/apps/evince"]
            program = ["/opt/apps/evince"]
    else:
        source = (root / "usr/lib/libreoffice") if own else LIBREOFFICE
        argv += ["--ro-bind", str(source), "/opt/apps/libreoffice"]
        # Its links into ../../../../share land at /opt/share from here: the system's share, or DGC's.
        argv += (["--ro-bind", str(root / "usr" / "share"), "/opt/share"] if own else ["--symlink", "/usr/share", "/opt/share"])
        etc = root / "etc" / "libreoffice" if own else Path("/etc/libreoffice")
        var = root / "var" / "lib" / "libreoffice" if own else Path("/var/lib/libreoffice")
        argv += ["--ro-bind-try", str(etc), "/etc/libreoffice", "--ro-bind-try", str(var), "/var/lib/libreoffice",
                 "--ro-bind-try", "/var/spool/libreoffice", "/var/spool/libreoffice"]
        program = ["/opt/apps/libreoffice/program/soffice", "-env:UserInstallation=file:///home/pip/.config/libreoffice",
                   "--norestore", "--nologo", *APPS[key]["args"]]
    online = egress is not None and forwarder is not None
    if online:
        from .pip_computer_files import proxy_args
        argv += proxy_args(egress, forwarder)
    argv += ["--dev", "/dev", "--proc", "/proc", "--size", str(512 * 1024 * 1024), "--tmpfs", "/tmp",
             "--bind", str(x11_dir), "/tmp/.X11-unix", "--tmpfs", "/home/pip",
             "--bind", str(files), "/home/pip/Files", "--bind", str(config), "/home/pip/.config",
             "--chdir", "/home/pip/Files"]
    command = program + ([file] if file else [])
    if online:
        # The relay to the egress proxy listens inside the app's own box, then the app starts.
        return argv + ["/bin/sh", "-c", 'python3 /run/dgc/forward.py >/dev/null 2>&1 & sleep 0.2; exec "$@"', "app", *command]
    return argv + command


def inside_path(files: Path, path) -> str:
    """A file from the computer's Files as an app inside its box sees it, checked like every Files path: one name
    at a time, no link followed, a regular file."""
    import stat as statmod
    from . import pip_computer_files as desk
    parts = desk._parts(path)
    if not parts:
        raise ValueError("say which file in your Files to open (path), such as Downloads/bill.pdf")
    fd = desk._open_dir(files, parts[:-1])
    try:
        info = os.stat(parts[-1], dir_fd=fd, follow_symlinks=False)
    except OSError:
        raise ValueError(f"Files/{'/'.join(parts)} is not in your Files; list them with files") from None
    finally:
        os.close(fd)
    if not statmod.S_ISREG(info.st_mode):
        raise ValueError(f"Files/{'/'.join(parts)} is not a file")
    return "/home/pip/Files/" + "/".join(parts)


def app_for(path: str) -> str | None:
    """The app that opens a file of this kind (a PDF in the PDF viewer, a .docx in Documents...)."""
    lower = str(path or "").lower()
    for key in ("pdf", "documents", "images"):
        if lower.endswith(OPENS[key]):
            return key
    return None


class Apps:
    """The apps a computer has open: each its own box, started on the computer's keeper thread (the box ends with
    that thread) and stopped with the computer."""

    def __init__(self, home: Path, files: Path):
        self.config = Path(home) / ".apps"
        self.files = Path(files)
        self.running: list[tuple[str, subprocess.Popen]] = []
        self._lock = threading.Lock()

    def open(self, key: str, x11_dir: Path, *, file: str | None = None, launch=lambda start: start(), log: Path | None = None,
             egress: Path | None = None) -> str:
        if key not in APPS:
            raise ValueError("open images, documents or pdf")
        self.config.mkdir(mode=0o700, parents=True, exist_ok=True)
        seed_settings(self.config)
        forwarder = None
        if egress is not None:
            from .pip_computer_box import FORWARDER
            forwarder = self.config.parent.parent / "forward.py"      # the computer's own, as its browser box writes it
            forwarder.write_text(FORWARDER)
        argv = box_argv(key, x11_dir=x11_dir, files=self.files, config=self.config, file=file, egress=egress,
                        forwarder=forwarder)
        with self._lock:
            self.running = [(k, p) for k, p in self.running if p.poll() is None]
            if len(self.running) >= MAX_RUNNING:
                raise RegistryError("too_many_apps", "Six apps are open on this computer: close one first.")
            started = {}

            def begin():
                out = open(log, "ab") if log is not None else subprocess.DEVNULL
                try:
                    started["proc"] = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=out, stderr=out,
                                                       start_new_session=True, preexec_fn=_limits,
                                                       env={"PATH": os.environ.get("PATH", "/usr/bin:/bin")})
                finally:
                    if log is not None:
                        out.close()
            launch(begin)
            self.running.append((key, started["proc"]))
        return APPS[key]["program"]

    def stop(self) -> None:
        with self._lock:
            for _, proc in self.running:
                if proc.poll() is None:
                    try:
                        os.killpg(proc.pid, 9)
                    except OSError:
                        pass
            for _, proc in self.running:
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    pass
            self.running = []


def _limits() -> None:
    import resource
    resource.setrlimit(resource.RLIMIT_FSIZE, (1024 ** 3, 1024 ** 3))


def describe() -> str:
    """The apps line a Pip is told: what each is and whether it is here."""
    parts = []
    for item in status():
        parts.append(f"{item['key']} ({item['name'].lower()}: {item['program']}" + ("" if item["available"] else ", not on this computer yet") + ")")
    return ", ".join(parts)


NAMES = re.compile(r"^(images|documents|pdf|files|terminal|browser)$")
