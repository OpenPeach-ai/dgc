"""Artifact previews — one persistent server hosting every artifact, with a
frontend dropdown to switch between them.

One fixed port, one URL. Each artifact is a directory (or an .html file's directory)
served under `/a/<id>/`. The root `/` is a dgc-design *shell*: a top-left dropdown that
lists every artifact and an iframe showing the selected one. The registry is saved to
`~/.dgc/artifacts.json`, so it survives `dgc` restarts and reloads on launch (when
`artifact_autostart` is on). It binds to loopback by default; an explicit LAN setting can expose
ordinary project artifacts to the local network. Automatically rendered plans always use loopback.

Security model (what a page on the network or in the browser can and cannot reach):

- Host allowlist. Every route answers only to `localhost`, `127.0.0.1` and `[::1]`, the exact IP the
  connection arrived on, a configured `artifact_hostname`, and in LAN mode this machine's LAN IP and
  host name. A DNS-rebinding page (evil.example resolving to 127.0.0.1) sends its own name in Host and
  gets 421. The port is not pinned: the hostname is what a rebinding page cannot forge, and SSH or
  editor port forwarding legitimately reaches the server on another local port.
- No dot paths at any depth (`.env`, `.git/`, `.dgc/`, `.ssh/`), no private-key-like files, no
  symlink that resolves outside the artifact directory, and no directory listings.
- Workspace roots are never served whole. An artifact whose directory is the project root, the home
  directory, or any folder that looks like a project (`.git`, `package.json`, `pyproject.toml`, …) is
  *scoped*: only its page and the web assets that page references (transitively, through HTML, CSS
  and JS) are reachable, and manifests, config and source files never are. A page in its own folder
  keeps working as a whole site. Scoping, rather than refusing, keeps the common single page written
  at a project root working without a retry, while the rest of the project stays unreachable.
- `POST /_stop/` needs the per-process token embedded in the shell page (a cross-origin page cannot
  read it, and the custom header forces a CORS preflight that is never granted) and, when present, a
  same-origin `Origin`/`Sec-Fetch-Site`.
- Artifact ids carry 64 random bits, so an id cannot be guessed from a counter.
- Responses carry nosniff, no-referrer, same-origin framing/resource policy, and a nonce CSP on the
  shell; plan pages get a CSP that forbids scripts and every network load.
"""
from __future__ import annotations

import atexit
import collections
import hmac
import html as _html_mod
import json
import mimetypes
import os
import posixpath
import re
import secrets
import socket
import threading
import time
from dataclasses import asdict, dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from .config import USER_HOME, _write_private_json

STATE_FILE = USER_HOME / "artifacts.json"
DEFAULT_PORT = 45000
PORT_SPAN = 100          # scan DEFAULT_PORT .. DEFAULT_PORT+SPAN for a free one

_ID_RE = re.compile(r"[a-z][0-9a-f]{16}")
_LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})
TOKEN_HEADER = "X-DGC-Artifact-Token"

# Directories that are never a site: refusing them as an artifact's own location (or any of its
# ancestors inside the project) keeps a model from serving VCS metadata, DGC state or credentials.
_SENSITIVE_DIRS = frozenset({
    ".git", ".hg", ".svn", ".dgc", ".ssh", ".gnupg", ".aws", ".azure", ".gcloud", ".kube", ".docker",
    ".config", ".claude", ".codex", ".cursor", ".vscode", ".idea", ".venv", ".env"})
# A directory holding one of these is a workspace root, not a dedicated page folder.
_WORKSPACE_MARKERS = (
    ".git", ".hg", ".svn", ".dgc", "package.json", "pyproject.toml", "setup.py", "setup.cfg",
    "requirements.txt", "Pipfile", "Cargo.toml", "go.mod", "pom.xml", "build.gradle",
    "build.gradle.kts", "Gemfile", "composer.json", "deno.json", "Makefile", "CMakeLists.txt",
    "AGENTS.md", "CLAUDE.md")
# Private-key and credential stores, refused in every artifact.
_SECRET_SUFFIXES = (".pem", ".key", ".p12", ".pfx", ".jks", ".keystore", ".kdbx", ".ppk")
_SECRET_NAMES = frozenset({"credentials", "credentials.json", "htpasswd", "_netrc", "authorized_keys",
                           "known_hosts"})
_SECRET_PREFIXES = ("id_rsa", "id_dsa", "id_ecdsa", "id_ed25519")
# What a scoped (workspace-root) artifact may serve: browser-loadable web assets only.
_WEB_EXT = frozenset({
    ".html", ".htm", ".css", ".js", ".mjs", ".json", ".geojson", ".csv", ".tsv", ".svg", ".png",
    ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".bmp", ".woff", ".woff2", ".ttf", ".otf",
    ".mp3", ".mp4", ".webm", ".ogg", ".oga", ".ogv", ".wav", ".m4a", ".flac", ".glb", ".gltf",
    ".wasm", ".pdf"})
_ENTRY_EXT = frozenset({".html", ".htm", ".svg", ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif"})
# Never a browser asset, so never served even from a dedicated folder: server-side source, shell
# scripts, databases, logs and machine config.
_SOURCE_EXT = frozenset({
    ".py", ".pyc", ".pyo", ".pyd", ".ipynb", ".rb", ".php", ".pl", ".go", ".rs", ".java", ".class",
    ".jar", ".kt", ".kts", ".scala", ".cs", ".c", ".cc", ".cpp", ".cxx", ".h", ".hpp", ".m", ".mm",
    ".swift", ".dart", ".lua", ".ex", ".exs", ".erl", ".hs", ".sh", ".bash", ".zsh", ".fish", ".ps1",
    ".bat", ".cmd", ".sql", ".sqlite", ".sqlite3", ".db", ".ini", ".toml", ".cfg", ".conf",
    ".properties", ".lock", ".log", ".env", ".tfstate", ".tfvars"})
_PARSED_EXT = frozenset({".html", ".htm", ".css", ".js", ".mjs", ".svg"})
_SCOPED_DENY_NAMES = frozenset({
    "package.json", "package-lock.json", "composer.json", "composer.lock", "tsconfig.json",
    "jsconfig.json", "deno.json", "deno.jsonc", "bower.json", "manifest.webapp", "firebase.json",
    "vercel.json", "netlify.json", "now.json", "app.json", "angular.json", "nx.json", "lerna.json",
    "turbo.json", "renovate.json", "biome.json", "wrangler.json"})
_SCOPED_DENY_WORDS = ("secret", "credential", "service-account", "service_account", "serviceaccount",
                      "password", "passwd", "apikey", "api_key", "api-key", "private-key",
                      "private_key")
_MAX_CLOSURE = 2000
_MAX_PARSE_BYTES = 4 * 1024 * 1024
SCOPED_NOTE = ("This page sits in a workspace root, so only the page and the files it links to are "
               "served; put a multi-file site in its own folder to serve all of it.")
_SHELL_CSP = ("default-src 'none'; script-src 'nonce-{n}'; style-src 'nonce-{n}'; img-src 'self' data:; "
              "connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'; "
              "frame-ancestors 'self'")
_PLAN_CSP = ("default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; "
             "form-action 'none'; frame-ancestors 'self'")
_FILE_CSP = "frame-ancestors 'self'"
_PLAIN_CSP = "default-src 'none'; frame-ancestors 'self'"


def _new_id(prefix: str, taken) -> str:
    while True:
        aid = f"{prefix}{secrets.token_hex(8)}"
        if aid not in taken:
            return aid


def split_host(value) -> str | None:
    """The lowercase host name from a Host header or authority (`name`, `name:port`, `[v6]:port`),
    or None when it is malformed."""
    if not isinstance(value, str):
        return None
    value = value.strip().lower()
    if not value or any(c in value for c in "/\\@ \t,;?#") or not value.isascii():
        return None
    if value.startswith("["):
        end = value.find("]")
        if end < 0:
            return None
        host, rest = value[1:end], value[end + 1:]
        if rest and not (rest.startswith(":") and rest[1:].isdigit()):
            return None
    else:
        host, sep, port = value.partition(":")
        if sep and not port.isdigit():
            return None
    host = host.rstrip(".")
    return host or None


def _hostname_of(configured) -> str | None:
    """The host part of a configured `artifact_hostname` (a bare name, host:port, or a full URL)."""
    raw = str(configured or "").strip()
    if not raw:
        return None
    if "://" in raw:
        try:
            return (urlparse(raw).hostname or "").rstrip(".").lower() or None
        except ValueError:
            return None
    return split_host(raw)


def _private_rel(rel: str) -> bool:
    """True for a path that must never leave the machine: a dot segment anywhere, a private key or
    credential store, or (Windows) an alternate data stream."""
    parts = [p for p in rel.replace("\\", "/").split("/") if p]
    if not parts:
        return False
    for part in parts:
        if part.startswith(".") or "\x00" in part or (os.name == "nt" and ":" in part):
            return True
    name = parts[-1].lower()
    return name in _SECRET_NAMES or name.endswith(_SECRET_SUFFIXES) or name.startswith(_SECRET_PREFIXES)


def _forbidden_rel(rel: str) -> bool:
    """True for a path no artifact serves: a private path, or server-side source/config/data."""
    return _private_rel(rel) or posixpath.splitext(rel.rsplit("/", 1)[-1].lower())[1] in _SOURCE_EXT


def _scoped_asset_ok(rel: str) -> bool:
    """A file a scoped artifact may serve: a web asset that is not a manifest, a build/tool config,
    or named like a secret."""
    name = rel.rsplit("/", 1)[-1].lower()
    ext = posixpath.splitext(name)[1]
    if ext not in _WEB_EXT or name in _SCOPED_DENY_NAMES:
        return False
    if re.search(r"\.config\.[a-z]+$", name) or re.search(r"(^|[._-])(eslintrc|babelrc|prettierrc)", name):
        return False
    return not any(word in name for word in _SCOPED_DENY_WORDS)


def is_workspace_root(directory, project_root=None) -> bool:
    """True when `directory` is a project/workspace root rather than a dedicated page folder."""
    try:
        d = Path(directory).resolve(strict=False)
    except (OSError, RuntimeError, ValueError):
        return True
    if project_root is not None:
        try:
            if d == Path(project_root).resolve(strict=False):
                return True
        except (OSError, RuntimeError, ValueError):
            return True
    try:
        home = Path.home().resolve(strict=False)
    except (OSError, RuntimeError, KeyError):
        home = None
    if d == Path(d.anchor) or (home is not None and (d == home or d in home.parents)):
        return True
    for marker in _WORKSPACE_MARKERS:
        try:
            if (d / marker).exists():
                return True
        except OSError:
            continue
    return False


_REF_ATTR = re.compile(
    r"""(?:^|[\s"'/])(?:src|href|poster|data|srcset|imagesrcset|content|xlink:href)\s*=\s*"""
    r"""(?:"([^"]*)"|'([^']*)'|([^\s>"']+))""", re.I)
_REF_CSS = re.compile(r"""url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)|@import\s+(?:"([^"]*)"|'([^']*)')""",
                      re.I)
_REF_LITERAL = re.compile(
    r"""["'`]([^"'`\s<>(){}|^]+?\.(?:html?|css|m?js|json|geojson|csv|tsv|svg|png|jpe?g|gif|webp|avif|ico|"""
    r"""bmp|woff2?|ttf|otf|mp3|mp4|webm|og[gav]|wav|m4a|flac|glb|gltf|wasm))(?:[?#][^"'`\s]*)?["'`]""", re.I)
_SCHEME = re.compile(r"^[a-z][a-z0-9+.-]*:", re.I)
_REF_CACHE: dict[str, tuple[int, int, tuple[str, ...]]] = {}
_REF_CACHE_LOCK = threading.Lock()


def _extract_refs(path: Path) -> tuple[str, ...]:
    """Every relative reference a web text file makes (HTML attributes, CSS url()/@import, and quoted
    asset-like literals in scripts), cached by mtime and size."""
    try:
        st = path.stat()
    except OSError:
        return ()
    key = str(path)
    with _REF_CACHE_LOCK:
        hit = _REF_CACHE.get(key)
    if hit and hit[0] == st.st_mtime_ns and hit[1] == st.st_size:
        return hit[2]
    if st.st_size > _MAX_PARSE_BYTES:
        return ()
    try:
        text = path.read_bytes().decode("utf-8", "replace")
    except OSError:
        return ()
    refs: list[str] = []
    for m in _REF_ATTR.finditer(text):
        value = next((g for g in m.groups() if g is not None), "")
        if "srcset" in m.group(0)[:20].lower():
            refs.extend(c.strip().split(" ")[0] for c in value.split(",") if c.strip())
        else:
            refs.append(value)
    for m in _REF_CSS.finditer(text):
        refs.append(next((g for g in m.groups() if g is not None), ""))
    refs.extend(m.group(1) for m in _REF_LITERAL.finditer(text))
    out = tuple(dict.fromkeys(r for r in refs if r))
    with _REF_CACHE_LOCK:
        if len(_REF_CACHE) > 4096:
            _REF_CACHE.clear()
        _REF_CACHE[key] = (st.st_mtime_ns, st.st_size, out)
    return out


def _normalize_ref(ref: str, from_dir: str) -> str | None:
    ref = _html_mod.unescape(ref.strip())
    if not ref or ref.startswith(("#", "/", "\\")) or _SCHEME.match(ref):
        return None
    ref = unquote(ref.split("#", 1)[0].split("?", 1)[0])
    if not ref or "\x00" in ref:
        return None
    if ref.endswith("/"):
        ref += "index.html"
    joined = posixpath.normpath(posixpath.join(from_dir, ref))
    if joined in (".", "") or joined == ".." or joined.startswith("../"):
        return None
    return joined


def _inside(base: Path, rel: str) -> Path | None:
    """The real path of `rel` under `base`, or None when it (or a symlink on the way) leaves `base`
    or lands on a forbidden path."""
    if _forbidden_rel(rel):
        return None
    try:
        target = base.joinpath(*rel.split("/")).resolve(strict=False)
        real_rel = target.relative_to(base).as_posix()
    except (OSError, RuntimeError, ValueError):
        return None
    if real_rel != "." and _forbidden_rel(real_rel):
        return None
    return target


def scoped_files(base: Path, entry: str) -> set[str]:
    """The files a scoped artifact serves: its entry page plus the web assets reachable from it."""
    allowed: set[str] = set()
    seen: set[str] = set()
    queue = collections.deque([entry])
    while queue and len(seen) < _MAX_CLOSURE:
        rel = queue.popleft()
        if rel in seen:
            continue
        seen.add(rel)
        if not _scoped_asset_ok(rel):
            continue
        target = _inside(base, rel)
        try:
            if target is None or not target.is_file():
                continue
            real_rel = target.relative_to(base).as_posix()
        except (OSError, ValueError):
            continue
        if not _scoped_asset_ok(real_rel):
            continue
        allowed.add(rel)
        if posixpath.splitext(rel)[1].lower() in _PARSED_EXT:
            for ref in _extract_refs(target):
                nxt = _normalize_ref(ref, posixpath.dirname(rel))
                if nxt and nxt not in seen:
                    queue.append(nxt)
    return allowed


def _clean_name(s) -> str:
    """Repair a name that was UTF-8 wrongly decoded as latin-1 (em-dash '—' shows as 'â\x80\x94',
    arrow '→' as a double-mangle) — up to two rounds — then drop any residual control/non-printable
    chars that garble the display AND break the overlay's width math. Idempotent on clean text.
    Names created before the SSE-decoding fix carry this corruption on disk; this heals them on load."""
    if not isinstance(s, str):
        return ""
    for _ in range(2):
        if not any(0x80 <= ord(c) <= 0x9f for c in s):    # C1 controls = the latin-1-decoded UTF-8 tail
            break
        try:
            fixed = s.encode("latin-1").decode("utf-8")
        except (UnicodeEncodeError, UnicodeDecodeError):
            break
        if fixed == s:
            break
        s = fixed
    return "".join(c for c in s if c == " " or c.isprintable())


@dataclass
class Artifact:
    id: str
    name: str
    directory: str          # absolute served root
    entry: str              # "" for a directory index, else the file to open
    created: float = field(default_factory=time.time)
    temporary: bool = False # generated preview directory; safe to remove with the registry entry
    scoped: bool = False    # a workspace root: serve only the entry and the assets it references

    @property
    def path(self) -> str:
        return f"/a/{self.id}/" + (self.entry or "")

    @property
    def url(self) -> str:
        """The single-port shell URL, with this artifact pre-selected in the dropdown."""
        owner = getattr(self, "_owner", _SRV)
        return f"http://{owner.host}:{owner.port}/?a={self.id}" if owner.port else f"/?a={self.id}"

    @property
    def rel(self) -> str:
        return self.entry or Path(self.directory).name

    @property
    def uptime(self) -> str:
        s = int(time.time() - self.created)
        if s < 60:
            return f"{s}s"
        if s < 3600:
            return f"{s // 60}m"
        return f"{s // 3600}h{(s % 3600) // 60:02d}"


def _port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def _lan_ip() -> str:
    """This machine's primary LAN IP (best effort) — used to build a shareable URL in LAN mode."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))          # no packets sent; just picks the outbound interface
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def _lan_host_names(lan_ip: str) -> frozenset[str]:
    """The names another device on the network uses for this machine: its LAN IP, its host name and
    the mDNS `.local` form, and the Tailscale IP when it was already looked up."""
    names = {lan_ip}
    try:
        short = socket.gethostname().strip().lower().rstrip(".")
    except OSError:
        short = ""
    if short:
        names.update({short, short.split(".")[0], short.split(".")[0] + ".local"})
    if _TS_IP_CACHE:
        names.add(_TS_IP_CACHE)
    return frozenset(n for n in names if n)


_TS_IP_CACHE: str | None = None


def _tailscale_ip() -> str:
    """This machine's Tailscale IP (100.64.0.0/10), best-effort — empty if Tailscale isn't up.
    Cached after the first lookup so opening /artifact doesn't shell out (3s timeout) every time."""
    global _TS_IP_CACHE
    if _TS_IP_CACHE is not None:
        return _TS_IP_CACHE
    _TS_IP_CACHE = ""
    import subprocess
    try:
        out = subprocess.run(["tailscale", "ip", "-4"], stdin=subprocess.DEVNULL,
                             capture_output=True, text=True, timeout=3).stdout
        for ln in out.splitlines():
            ip = ln.strip()
            if ip.startswith("100."):       # CGNAT range Tailscale assigns
                _TS_IP_CACHE = ip
                break
    except Exception:
        pass
    return _TS_IP_CACHE


def reachable_urls(port: int, hostname: str = "") -> list[tuple[str, str]]:
    """Every base URL this artifact server is reachable at while bound to 0.0.0.0 (LAN mode): the
    localhost loopback, the primary LAN IP, the Tailscale IP if up, and a configured public hostname.
    Returns [(label, url)] with duplicates/blanks removed — so /artifact can show ALL the ways to open it
    (on another device via LAN, over Tailscale from anywhere, or through a reverse proxy / your domain)."""
    if not port:
        return []
    def _u(host: str) -> str:
        host = host.strip()
        if not host:
            return ""
        if "://" in host:                   # a full URL configured as the hostname → use verbatim
            return host.rstrip("/")
        if ":" in host:                     # already host:port → don't append a second port
            return f"http://{host}"
        return f"http://{host}:{port}"
    rows: list[tuple[str, str]] = [("this machine", f"http://127.0.0.1:{port}")]
    lan = _lan_ip()
    if lan and lan != "127.0.0.1":
        rows.append(("LAN", f"http://{lan}:{port}"))
    ts = _tailscale_ip()
    if ts:
        rows.append(("Tailscale", f"http://{ts}:{port}"))
    if hostname:
        rows.append(("hostname", _u(hostname)))
    seen, out = set(), []
    for label, url in rows:
        if url and url not in seen:
            seen.add(url)
            out.append((label, url))
    return out


class _Server:
    """The single shared artifact server + registry (module singleton)."""

    def __init__(self, *, persistent: bool = True, id_prefix: str = "a", file_csp: str = _FILE_CSP):
        self.persistent = persistent
        self.id_prefix = id_prefix
        self.file_csp = file_csp
        self.port: int | None = None
        self.host = "127.0.0.1"     # the host shown in URLs (LAN IP when bound to 0.0.0.0)
        self.lan = False
        self.lan_hosts: frozenset[str] = frozenset()   # this machine's names/IPs accepted in LAN mode
        self.public_host: str | None = None            # a configured artifact_hostname
        self.token = secrets.token_urlsafe(24)         # authorizes POST /_stop from the shell page
        self.httpd = None
        self.thread = None
        self.counter = 0
        self.artifacts: dict[str, Artifact] = {}
        self.lock = threading.Lock()
        if persistent:
            self._load()

    # ---- persistence -----------------------------------------------------
    def _load(self):
        try:
            data = json.loads(STATE_FILE.read_text())
        except (OSError, ValueError):
            return
        self.port = data.get("port")
        self.counter = int(data.get("counter", 0))
        rekeyed = False
        for a in data.get("artifacts", []):
            try:
                if not Path(a["directory"]).exists():      # drop artifacts whose files are gone
                    continue
                entry = str(a.get("entry", ""))
                if _forbidden_rel(entry):                   # a dot/secret entry is never served
                    rekeyed = True
                    continue
                aid = str(a["id"])
                if not _ID_RE.fullmatch(aid) or aid in self.artifacts:
                    aid = _new_id(self.id_prefix, self.artifacts)   # retire guessable counter ids
                    rekeyed = True
                # A record from before scoping existed carries no flag: scope it (its entry and the
                # assets that entry references still load) rather than trusting a whole directory.
                scoped = (bool(a.get("scoped", True)) or is_workspace_root(a["directory"]))
                art = Artifact(
                    id=aid, name=_clean_name(a["name"]), directory=a["directory"],
                    entry=entry, created=float(a.get("created", time.time())),
                    temporary=False,  # never delete paths resurrected from persisted state
                    scoped=scoped)
                art._owner = self
                self.artifacts[aid] = art
            except (KeyError, TypeError, ValueError):
                continue
        if rekeyed:
            self._save()

    def _save(self):
        if not self.persistent:
            return
        try:
            _write_private_json(
                STATE_FILE,
                {"port": self.port, "counter": self.counter,
                 "artifacts": [asdict(a) for a in self.artifacts.values()]})
        except OSError:
            pass

    # ---- lifecycle -------------------------------------------------------
    def ensure_started(self, preferred: int | None = None, lan: bool = False) -> int:
        """Start the server if it isn't running; return the bound port.
        lan=True binds 0.0.0.0 so other devices on your network can view; else 127.0.0.1 only."""
        with self.lock:
            if self.httpd is not None:
                return self.port
            port = self._pick_port(preferred)
            bind = "0.0.0.0" if lan else "127.0.0.1"
            handler = _make_handler(self)
            self.httpd = ThreadingHTTPServer((bind, port), handler)
            self.port = port
            self.lan = lan
            self.host = _lan_ip() if lan else "127.0.0.1"
            self.lan_hosts = _lan_host_names(self.host) if lan else frozenset()
            self.thread = threading.Thread(target=self.httpd.serve_forever,
                                           name="artifact-server", daemon=True)
            self.thread.start()
            self._save()
            return port

    def _pick_port(self, preferred: int | None = None) -> int:
        # the port we last bound wins (stable across restarts), then the configured/default one,
        # then a scan, then any OS-assigned free port.
        base = preferred or DEFAULT_PORT
        for cand in ([self.port] if self.port else []) + list(range(base, base + PORT_SPAN)):
            if cand and _port_free(cand):
                return cand
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:     # OS-assigned fallback
            s.bind(("127.0.0.1", 0))
            return s.getsockname()[1]

    def running(self) -> bool:
        return self.httpd is not None

    # ---- registry --------------------------------------------------------
    def add(self, path: str, project_root, name: str = "", preferred_port: int | None = None,
            lan: bool = False, hostname: str | None = None) -> Artifact:
        from .workspace import canonical_root, resolve_path
        root = Path(project_root)
        target = resolve_path(path, root)
        if not target.exists():
            raise FileNotFoundError(f"{path} does not exist")
        try:
            inner = target.relative_to(canonical_root(root)).parts
        except ValueError:
            inner = ()
        if any(part in _SENSITIVE_DIRS for part in inner) or (
                target.is_file() and _private_rel(target.name)):
            raise PermissionError(
                f"{path} is private (a dot-file, VCS/credential directory or key file) and is never "
                "served; write the page into its own folder, e.g. artifacts/<name>/index.html")
        if target.is_dir():
            directory, entry = target, ""
            if not (target / "index.html").is_file():
                htmls = sorted([*target.glob("*.html"), *target.glob("*.htm")])
                if not htmls:
                    raise ValueError(
                        f"{path} has no .html page to serve. Write the page first, ideally in its own "
                        "folder (e.g. artifacts/<name>/index.html), then pass that folder or file")
                entry = htmls[0].name
        else:
            directory, entry = target.parent, target.name
            if posixpath.splitext(entry)[1].lower() not in _ENTRY_EXT:
                raise ValueError(
                    f"{path} is not a page. Pass an .html file (or a folder holding index.html); "
                    "put a multi-file site in its own folder, e.g. artifacts/<name>/")
        scoped = is_workspace_root(directory, root)
        if scoped:
            entry = entry or "index.html"
        if hostname is not None:
            self.public_host = _hostname_of(hostname)
        self.ensure_started(preferred_port, lan)
        with self.lock:
            self.counter += 1
            aid = _new_id(self.id_prefix, self.artifacts)
            art = Artifact(id=aid, name=(_clean_name(name) or target.stem or f"artifact {self.counter}"),
                           directory=str(directory), entry=entry, scoped=scoped)
            art._owner = self
            self.artifacts[aid] = art
            self._save()
        return art

    def remove(self, aid: str) -> bool:
        with self.lock:
            art = self.artifacts.pop(aid, None)
            if art:
                self._save()
        if art and art.temporary:
            import shutil, tempfile
            try:
                directory = Path(art.directory).resolve(strict=True)
                temp_root = Path(tempfile.gettempdir()).resolve(strict=True)
                if directory.parent == temp_root and directory.name.startswith("dgc-plan-"):
                    shutil.rmtree(directory)
            except OSError:
                pass
        return art is not None

    def base_url(self) -> str:
        return f"http://{self.host}:{self.port}" if self.port else ""

    def set_bind(self, lan: bool, preferred: int | None = None, hostname: str | None = None) -> None:
        """Switch localhost<->LAN. Restarts the server (same registry) if the mode changed."""
        if hostname is not None:
            self.public_host = _hostname_of(hostname)
        if self.running() and self.lan == lan:
            return
        was_running = self.running()
        if was_running:
            self.shutdown()
        if was_running or self.artifacts:
            self.ensure_started(preferred or self.port, lan)

    def url_for(self, aid: str) -> str:
        return f"{self.base_url()}/?a={aid}"

    def list(self) -> list[Artifact]:
        with self.lock:
            return sorted(self.artifacts.values(), key=lambda a: a.created, reverse=True)

    def shutdown(self):
        with self.lock:
            if self.httpd is not None:
                try:
                    self.httpd.shutdown()
                    self.httpd.server_close()
                except Exception:
                    pass
                self.httpd = None
                self.thread = None


_SRV = _Server()
_PLAN_SRV = _Server(persistent=False, id_prefix="p",  # can never inherit the optional LAN bind
                    file_csp=_PLAN_CSP)                # plan pages are static: no scripts, no loads

# ---- render a plan (markdown) as a fancy dgc-design page served on localhost --------
def _md_inline(t: str) -> str:
    import re, html
    t = html.escape(t, quote=False)
    t = re.sub(r"`([^`]+)`", r"<code>\1</code>", t)
    t = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", t)
    t = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"<em>\1</em>", t)
    return t


def _md_to_html(md: str) -> str:
    """A small, dependency-free markdown → HTML pass covering what a plan.md uses:
    headings, ordered/unordered lists, fenced code, and inline code/bold/italic."""
    out, i, lines = [], 0, md.replace("\r\n", "\n").split("\n")
    import html as _html
    while i < len(lines):
        ln = lines[i]
        if ln.strip().startswith("```"):                       # fenced code
            i += 1; buf = []
            while i < len(lines) and not lines[i].strip().startswith("```"):
                buf.append(_html.escape(lines[i])); i += 1
            i += 1
            out.append("<pre><code>" + "\n".join(buf) + "</code></pre>"); continue
        m_h = len(ln) - len(ln.lstrip("#"))
        if 1 <= m_h <= 4 and ln[m_h:m_h + 1] == " ":            # heading
            out.append(f"<h{m_h}>{_md_inline(ln[m_h + 1:].strip())}</h{m_h}>"); i += 1; continue
        import re
        if re.match(r"^\s*\d+\.\s+", ln):                        # ordered list
            items = []
            while i < len(lines) and re.match(r"^\s*\d+\.\s+", lines[i]):
                items.append("<li>" + _md_inline(re.sub(r"^\s*\d+\.\s+", "", lines[i])) + "</li>"); i += 1
            out.append("<ol>" + "".join(items) + "</ol>"); continue
        if re.match(r"^\s*[-*]\s+", ln):                        # unordered list
            items = []
            while i < len(lines) and re.match(r"^\s*[-*]\s+", lines[i]):
                items.append("<li>" + _md_inline(re.sub(r"^\s*[-*]\s+", "", lines[i])) + "</li>"); i += 1
            out.append("<ul>" + "".join(items) + "</ul>"); continue
        if not ln.strip():                                      # blank
            i += 1; continue
        para = [ln]                                             # paragraph (gather until blank)
        i += 1
        while i < len(lines) and lines[i].strip() and not lines[i].strip().startswith(("#", "```", "- ", "* ")) \
                and not re.match(r"^\s*\d+\.\s+", lines[i]):
            para.append(lines[i]); i += 1
        out.append("<p>" + _md_inline(" ".join(para)) + "</p>")
    return "\n".join(out)


def render_plan_html(md: str, title: str = "Plan") -> str:
    """The plan as a clean, dgc-design page (the same look as vibedgc.com)."""
    body = _md_to_html(md)
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>{_esc(title)}</title>
<style>
  :root{{--bg:#0B0B0C;--surface:#141416;--surface2:#1A1A1D;--code:#0E0E10;--border:#232326;--border-strong:#303034;
    --text:#F5F5F5;--text-strong:#FFFFFF;--muted:#9A9A9E;--faint:#6A6A6E;--accent:#7C5CFF;--lav:#A78BFA;
    --ui:'Inter',system-ui,-apple-system,Segoe UI,Roboto,sans-serif;--mono:'JetBrains Mono','SF Mono',ui-monospace,Menlo,monospace;}}
  *{{box-sizing:border-box}} body{{margin:0;background:var(--bg);color:var(--text);font-family:var(--ui);line-height:1.65;
    -webkit-font-smoothing:antialiased}}
  .wrap{{max-width:760px;margin:0 auto;padding:64px 28px 96px}}
  .mark{{font:800 15px/1 var(--mono);letter-spacing:.1em;color:var(--accent)}}
  .eyebrow{{font:600 12px/1 var(--mono);letter-spacing:.16em;color:var(--faint);margin:22px 0 6px}}
  h1{{font:800 34px/1.15 var(--ui);letter-spacing:-.02em;color:var(--text-strong);margin:0 0 10px}}
  h2{{font:800 21px/1.2 var(--ui);letter-spacing:-.01em;color:var(--text-strong);margin:34px 0 10px}}
  h3{{font:700 16px/1.3 var(--ui);color:var(--text);margin:26px 0 8px}}
  h4{{font:700 14px/1.3 var(--ui);color:var(--muted);margin:22px 0 6px}}
  p{{color:var(--text);margin:12px 0}}
  ol,ul{{margin:12px 0;padding-left:0;list-style:none;counter-reset:step}}
  ol>li{{counter-increment:step;position:relative;padding:11px 14px 11px 46px;margin:8px 0;background:var(--surface);
    border:1px solid var(--border);border-radius:10px}}
  ol>li::before{{content:counter(step);position:absolute;left:12px;top:11px;width:22px;height:22px;border-radius:7px;
    background:var(--accent);color:#fff;font:700 12px/22px var(--mono);text-align:center}}
  ul>li{{position:relative;padding:6px 0 6px 22px;margin:2px 0}}
  ul>li::before{{content:"›";position:absolute;left:4px;color:var(--accent);font-weight:700}}
  code{{font-family:var(--mono);font-size:.86em;background:var(--surface2);color:var(--lav);padding:.12em .4em;border-radius:5px}}
  pre{{background:var(--code);border:1px solid var(--border);border-radius:10px;padding:14px 16px;overflow-x:auto;margin:14px 0}}
  pre code{{background:none;color:var(--text);padding:0;font-size:13px;line-height:1.6}}
  strong{{color:var(--text-strong)}} em{{color:var(--muted)}}
  .foot{{margin-top:44px;padding-top:18px;border-top:1px solid var(--border);color:var(--faint);font:400 13px/1.5 var(--ui)}}
</style></head>
<body><div class="wrap">
  <div class="mark">///</div>
  <div class="eyebrow">PROPOSED PLAN</div>
  {body}
  <div class="foot">Proposed by DGC. Approve it in your terminal, or keep planning.</div>
</div></body></html>"""


def serve_plan(md: str, project_root, name: str = "Plan", preferred_port: int | None = None,
               lan: bool = False) -> Artifact:
    """Render `md` as a dgc-design page on a dedicated loopback-only server."""
    import tempfile
    d = Path(tempfile.mkdtemp(prefix="dgc-plan-"))
    (d / "index.html").write_text(render_plan_html(md, name), encoding="utf-8")
    art = _PLAN_SRV.add("index.html", d, name, preferred_port, False)
    art.temporary = True
    return art




# ---- public API (kept stable for callers) --------------------------------
def add(path: str, project_root, name: str = "", preferred_port: int | None = None,
        lan: bool = False, hostname: str | None = None) -> Artifact:
    return _SRV.add(path, project_root, name, preferred_port, lan, hostname)


# back-compat alias for the old per-port name
def serve(path: str, project_root, name: str = "", preferred_port: int | None = None,
          lan: bool = False, hostname: str | None = None) -> Artifact:
    return _SRV.add(path, project_root, name, preferred_port, lan, hostname)


def registry() -> list[Artifact]:
    return sorted([*_PLAN_SRV.list(), *_SRV.list()], key=lambda a: a.created, reverse=True)


def get(aid: str) -> Artifact | None:
    return _PLAN_SRV.artifacts.get(aid) or _SRV.artifacts.get(aid)


def stop(aid: str) -> bool:
    return _PLAN_SRV.remove(aid) or _SRV.remove(aid)


def stop_all() -> None:
    _SRV.shutdown()
    _PLAN_SRV.shutdown()
    for aid in list(_PLAN_SRV.artifacts):
        _PLAN_SRV.remove(aid)


def base_url() -> str:
    return _SRV.base_url()


def url_for(aid: str) -> str:
    return _SRV.url_for(aid)


def running() -> bool:
    return _SRV.running()


def is_lan() -> bool:
    return _SRV.lan


def set_bind(lan: bool, preferred_port: int | None = None, hostname: str | None = None) -> None:
    _SRV.set_bind(lan, preferred_port, hostname)


def autostart_if_pending(preferred_port: int | None = None, lan: bool = False,
                         hostname: str | None = None) -> bool:
    """On dgc launch: bring the server up if there are saved artifacts. Returns True if started."""
    if hostname is not None:
        _SRV.public_host = _hostname_of(hostname)
    if _SRV.artifacts and not _SRV.running():
        _SRV.ensure_started(preferred_port, lan)
        return True
    return False


atexit.register(stop_all)


# ---- the HTTP handler + shell page ---------------------------------------
def _guess_type(p: Path) -> str:
    t, _ = mimetypes.guess_type(str(p))
    return t or "application/octet-stream"


def host_allowed(server: "_Server", host_header, local_ip: str = "") -> bool:
    """Whether a request's Host names this server (see the module docstring for why)."""
    host = split_host(host_header)
    if host is None:
        return False
    if host in _LOOPBACK_HOSTS or (local_ip and host == local_ip.lower()):
        return True
    if server.public_host and host == server.public_host:
        return True
    return bool(server.lan and host in server.lan_hosts)


def resolve_request(art: Artifact, sub: str) -> tuple[Path | None, int, bytes]:
    """Map `/a/<id>/<sub>` to a file this artifact may serve: (path, 200, b"") or (None, status, why)."""
    not_found = (None, 404, b"not found")
    try:
        base = Path(art.directory).resolve(strict=True)
    except (OSError, RuntimeError, ValueError):
        return not_found
    sub = sub.replace("\\", "/")
    parts = [p for p in sub.split("/") if p not in ("", ".")]
    if any(p == ".." for p in parts) or "\x00" in sub:
        return None, 403, b"forbidden"
    if not parts:
        parts = [art.entry or "index.html"]
    elif sub.endswith("/"):
        parts.append("index.html")
    rel = "/".join(parts)
    target = _inside(base, rel)
    if target is None:
        return not_found
    try:
        if target.is_dir():                              # never a listing: its index page or nothing
            rel += "/index.html"
            target = _inside(base, rel)
            if target is None:
                return not_found
        if not target.is_file():
            return not_found
    except OSError:
        return not_found
    if art.scoped or is_workspace_root(base):
        if rel not in scoped_files(base, art.entry or "index.html"):
            return None, 404, ("not found. " + SCOPED_NOTE).encode()
    return target, 200, b""


def _make_handler(server: "_Server"):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code, body: bytes, ctype="text/html; charset=utf-8", csp: str = _PLAIN_CSP,
                  headers: dict | None = None):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Frame-Options", "SAMEORIGIN")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Cross-Origin-Resource-Policy", "same-origin")
            if csp:
                self.send_header("Content-Security-Policy", csp)
            for key, value in (headers or {}).items():
                self.send_header(key, value)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _text(self, code, body: bytes):
            self._send(code, body, "text/plain; charset=utf-8")

        def _local_ip(self) -> str:
            try:
                return str(self.connection.getsockname()[0])
            except (OSError, AttributeError, IndexError):
                return ""

        def _host_ok(self) -> bool:
            hosts = self.headers.get_all("Host") or []
            if len(hosts) == 1 and host_allowed(server, hosts[0], self._local_ip()):
                return True
            self.close_connection = True
            self._text(421, b"misdirected request: this DGC artifact server answers only to "
                            b"localhost and this machine's own addresses")
            return False

        def _same_origin_write(self) -> bool:
            token = self.headers.get(TOKEN_HEADER, "")
            if not hmac.compare_digest(token.encode("utf-8", "replace"),
                                       server.token.encode("utf-8")):
                return False
            site = self.headers.get("Sec-Fetch-Site")
            if site is not None and site.strip().lower() != "same-origin":
                return False
            origin = self.headers.get("Origin")
            if origin is not None:
                try:
                    parsed = urlparse(origin.strip())
                except ValueError:
                    return False
                if parsed.scheme not in ("http", "https") or not host_allowed(
                        server, parsed.netloc, self._local_ip()):
                    return False
            return True

        def do_GET(self):
            if not self._host_ok():
                return
            parsed = urlparse(self.path)
            path = unquote(parsed.path)
            if path in ("/", "/index.html"):
                q = parse_qs(parsed.query)
                sel = (q.get("a") or [""])[0]
                nonce = secrets.token_urlsafe(18)
                self._send(200, _shell_html(server, sel, nonce).encode("utf-8"),
                           csp=_SHELL_CSP.format(n=nonce))
                return
            if path == "/_list":
                items = [{"id": a.id, "name": a.name, "path": a.path, "uptime": a.uptime}
                         for a in server.list()]
                self._send(200, json.dumps({"artifacts": items}).encode(),
                           "application/json")
                return
            if path.startswith("/a/"):
                self._serve_artifact_file(path)
                return
            self._text(404, b"not found")

        do_HEAD = do_GET

        def do_POST(self):
            if not self._host_ok():
                return
            path = unquote(urlparse(self.path).path)
            if path.startswith("/_stop/"):
                if not self._same_origin_write():
                    self._send(403, json.dumps({"ok": False, "error": "cross-origin stop refused"}).encode(),
                               "application/json")
                    return
                aid = path[len("/_stop/"):].strip("/")
                ok = server.remove(aid)
                self._send(200, json.dumps({"ok": ok}).encode(), "application/json")
                return
            self._text(404, b"not found")

        def _serve_artifact_file(self, path: str):
            rest = path[len("/a/"):]
            aid, _, sub = rest.partition("/")
            art = server.artifacts.get(aid)
            if not art:
                self._text(404, b"unknown artifact")
                return
            target, status, why = resolve_request(art, sub)
            if target is None:
                self._text(status, why)
                return
            try:
                self._send(200, target.read_bytes(), _guess_type(target), csp=server.file_csp)
            except OSError:
                self._text(500, b"read error")

    return Handler


def _shell_html(server: "_Server", selected: str, nonce: str = "") -> str:
    """The dgc-design shell: a top-left dropdown listing every artifact + an iframe. `nonce` marks the
    inline style and script the response's CSP allows; the stop token rides in the script."""
    na = f' nonce="{_esc(nonce)}"' if nonce else ""
    arts = server.list()
    if not selected and arts:
        selected = arts[0].id
    opts = "".join(
        f'<option value="{a.id}"{" selected" if a.id == selected else ""}>{_esc(a.name)}</option>'
        for a in arts)
    initial = next((a.path for a in arts if a.id == selected), "")
    empty = "" if arts else '<div class="empty">No artifacts yet — the agent serves one with the <code>artifact</code> tool.</div>'
    reach = (f'<span class="reach" title="reachable by other devices on your network">◈ LAN · {server.host}</span>'
             if server.lan else '')
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DGC Artifacts</title>
<style{na}>
  :root{{--bg:#0B0B0C;--surface:#141416;--surface-2:#1A1A1D;--border:#232326;--border-strong:#303034;
    --text:#F5F5F5;--muted:#9A9A9E;--faint:#6A6A6E;--accent:#7C5CFF;--accent-hover:#6A4BF0;
    --ui:'Inter',system-ui,-apple-system,Segoe UI,Roboto,sans-serif;--mono:'JetBrains Mono','SF Mono',ui-monospace,Menlo,monospace;}}
  *{{box-sizing:border-box}} html,body{{height:100%}}
  body{{margin:0;background:var(--bg);color:var(--text);font-family:var(--ui);display:flex;flex-direction:column}}
  .bar{{display:flex;align-items:center;gap:12px;padding:9px 14px;background:var(--surface);
    border-bottom:1px solid var(--border);flex:none}}
  .mark{{font:800 14px/1 var(--mono);letter-spacing:.06em;color:var(--accent)}}
  .sel-wrap{{position:relative;display:inline-flex;align-items:center}}
  select{{appearance:none;-webkit-appearance:none;background:var(--surface-2);color:var(--text);
    border:1px solid var(--border-strong);border-radius:8px;padding:7px 30px 7px 12px;
    font:600 13px/1 var(--ui);cursor:pointer;min-width:190px}}
  select:hover{{border-color:var(--accent)}}
  .sel-wrap::after{{content:"▾";position:absolute;right:11px;color:var(--muted);pointer-events:none;font-size:11px}}
  .spacer{{flex:1}}
  a.act,button.act{{font:600 12.5px/1 var(--ui);text-decoration:none;cursor:pointer;border-radius:7px;
    padding:7px 12px;border:1px solid var(--border-strong);background:transparent;color:var(--text)}}
  a.act:hover,button.act:hover{{border-color:var(--accent)}}
  button.stop:hover{{border-color:#F7768E;color:#F7768E}}
  .stage{{flex:1;position:relative;background:var(--bg)}}
  iframe{{position:absolute;inset:0;width:100%;height:100%;border:0;background:#fff}}
  .empty{{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
    color:var(--muted);font-size:14px;padding:24px;text-align:center}}
  .empty code{{font-family:var(--mono);color:var(--accent);background:var(--surface-2);padding:2px 6px;border-radius:5px}}
  .count{{color:var(--faint);font:500 12px/1 var(--mono)}}
  .reach{{color:#E0AF68;font:600 11px/1 var(--mono);border:1px solid rgba(224,175,104,.4);
    border-radius:6px;padding:4px 8px;letter-spacing:.02em}}
</style></head>
<body>
  <div class="bar">
    <span class="mark">///</span>
    <span class="sel-wrap"><select id="sel" title="Switch artifact">{opts}</select></span>
    <span class="count" id="count"></span>
    {reach}
    <span class="spacer"></span>
    <a class="act" id="open" href="#" target="_blank" rel="noopener">Open in new tab ↗</a>
    <button class="act stop" id="stop">Stop</button>
  </div>
  <div class="stage">
    {empty}
    <iframe id="frame" src="{initial}" title="artifact"></iframe>
  </div>
<script{na}>
  const TOKEN = {_script_json(server.token)};
  const sel = document.getElementById('sel'), frame = document.getElementById('frame'),
        open = document.getElementById('open'), stop = document.getElementById('stop'),
        count = document.getElementById('count');
  let items = {_script_json([{ "id": a.id, "name": a.name, "path": a.path } for a in arts])};
  function pathFor(id){{ const it = items.find(x=>x.id===id); return it ? it.path : ''; }}
  function show(id){{ const p = pathFor(id); if(!p) return; frame.src = p; open.href = p;
    history.replaceState(null,'', '/?a='+encodeURIComponent(id)); }}
  function render(){{
    count.textContent = items.length ? items.length + (items.length===1?' artifact':' artifacts') : '';
    if(!items.length){{ return; }}
    if(!items.find(x=>x.id===sel.value)) sel.value = items[0].id;
  }}
  sel.addEventListener('change', ()=>show(sel.value));
  stop.addEventListener('click', async ()=>{{
    const id = sel.value; if(!id) return;
    await fetch('/_stop/'+encodeURIComponent(id), {{method:'POST', headers:{{'X-DGC-Artifact-Token': TOKEN}}}}).catch(()=>{{}});
    await refresh(); if(items.length) show(sel.value); else location.reload();
  }});
  async function refresh(){{
    try{{ const r = await fetch('/_list'); const d = await r.json();
      items = d.artifacts.map(a=>({{id:a.id,name:a.name,path:a.path}}));
      const cur = sel.value;
      sel.replaceChildren(...items.map(a=>{{
        const option = document.createElement('option'); option.value = a.id; option.textContent = a.name;
        return option;
      }}));
      if(items.find(x=>x.id===cur)) sel.value = cur;
      render();
    }}catch(e){{}}
  }}
  render(); if(sel.value) open.href = pathFor(sel.value);
  setInterval(refresh, 4000);        // keep the dropdown live as new artifacts arrive
</script>
</body></html>"""


def _esc(s: str) -> str:
    return (s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _script_json(value) -> str:
    """JSON safe to embed in an inline script, including hostile `</script>` names."""
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":"))
            .replace("&", "\\u0026").replace("<", "\\u003c").replace(">", "\\u003e")
            .replace("\u2028", "\\u2028").replace("\u2029", "\\u2029"))
