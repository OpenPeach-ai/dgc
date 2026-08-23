"""Localhost artifact previews — ONE persistent server hosting every artifact, with a
frontend dropdown to switch between them.

One fixed port, one URL. Each artifact is a directory (or an .html file's directory)
served under `/a/<id>/`. The root `/` is a dgc-design *shell*: a top-left dropdown that
lists every artifact and an iframe showing the selected one. The registry is saved to
`~/.dgc/artifacts.json`, so it survives `dgc` restarts and reloads on launch (when
`artifact_autostart` is on). Bound to 127.0.0.1 only — nothing is ever exposed off the box.
"""
from __future__ import annotations

import atexit
import json
import mimetypes
import socket
import threading
import time
from dataclasses import asdict, dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from .config import USER_HOME

STATE_FILE = USER_HOME / "artifacts.json"
DEFAULT_PORT = 45000
PORT_SPAN = 100          # scan DEFAULT_PORT .. DEFAULT_PORT+SPAN for a free one


@dataclass
class Artifact:
    id: str
    name: str
    directory: str          # absolute served root
    entry: str              # "" for a directory index, else the file to open
    created: float = field(default_factory=time.time)

    @property
    def path(self) -> str:
        return f"/a/{self.id}/" + (self.entry or "")

    @property
    def url(self) -> str:
        """The single-port shell URL, with this artifact pre-selected in the dropdown."""
        return f"http://{_SRV.host}:{_SRV.port}/?a={self.id}" if _SRV.port else f"/?a={self.id}"

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
        out = subprocess.run(["tailscale", "ip", "-4"], capture_output=True, text=True, timeout=3).stdout
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

    def __init__(self):
        self.port: int | None = None
        self.host = "127.0.0.1"     # the host shown in URLs (LAN IP when bound to 0.0.0.0)
        self.lan = False
        self.httpd = None
        self.thread = None
        self.counter = 0
        self.artifacts: dict[str, Artifact] = {}
        self.lock = threading.Lock()
        self._load()

    # ---- persistence -----------------------------------------------------
    def _load(self):
        try:
            data = json.loads(STATE_FILE.read_text())
        except (OSError, ValueError):
            return
        self.port = data.get("port")
        self.counter = int(data.get("counter", 0))
        for a in data.get("artifacts", []):
            try:
                if Path(a["directory"]).exists():          # drop artifacts whose files are gone
                    self.artifacts[a["id"]] = Artifact(
                        id=a["id"], name=a["name"], directory=a["directory"],
                        entry=a.get("entry", ""), created=float(a.get("created", time.time())))
            except (KeyError, TypeError, ValueError):
                continue

    def _save(self):
        try:
            USER_HOME.mkdir(parents=True, exist_ok=True)
            STATE_FILE.write_text(json.dumps(
                {"port": self.port, "counter": self.counter,
                 "artifacts": [asdict(a) for a in self.artifacts.values()]}))
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
            lan: bool = False) -> Artifact:
        root = Path(project_root)
        target = (root / path).resolve() if not Path(path).is_absolute() else Path(path).resolve()
        if not target.exists():
            raise FileNotFoundError(f"{path} does not exist")
        if target.is_dir():
            directory, entry = target, ""
            if not (target / "index.html").exists():
                htmls = sorted(target.glob("*.html"))
                if htmls:
                    entry = htmls[0].name
        else:
            directory, entry = target.parent, target.name
        self.ensure_started(preferred_port, lan)
        with self.lock:
            self.counter += 1
            aid = f"a{self.counter}"
            art = Artifact(id=aid, name=(name.strip() or target.stem or f"artifact {self.counter}"),
                           directory=str(directory), entry=entry)
            self.artifacts[aid] = art
            self._save()
        return art

    def remove(self, aid: str) -> bool:
        with self.lock:
            gone = self.artifacts.pop(aid, None) is not None
            if gone:
                self._save()
            return gone

    def base_url(self) -> str:
        return f"http://{self.host}:{self.port}" if self.port else ""

    def set_bind(self, lan: bool, preferred: int | None = None) -> None:
        """Switch localhost<->LAN. Restarts the server (same registry) if the mode changed."""
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
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
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
    """Render `md` as a dgc-design page and serve it as an artifact on localhost."""
    import tempfile
    d = Path(tempfile.mkdtemp(prefix="dgc-plan-"))
    (d / "index.html").write_text(render_plan_html(md, name), encoding="utf-8")
    return _SRV.add("index.html", d, name, preferred_port, lan)




# ---- public API (kept stable for callers) --------------------------------
def add(path: str, project_root, name: str = "", preferred_port: int | None = None,
        lan: bool = False) -> Artifact:
    return _SRV.add(path, project_root, name, preferred_port, lan)


# back-compat alias for the old per-port name
def serve(path: str, project_root, name: str = "", preferred_port: int | None = None,
          lan: bool = False) -> Artifact:
    return _SRV.add(path, project_root, name, preferred_port, lan)


def registry() -> list[Artifact]:
    return _SRV.list()


def get(aid: str) -> Artifact | None:
    return _SRV.artifacts.get(aid)


def stop(aid: str) -> bool:
    return _SRV.remove(aid)


def stop_all() -> None:
    _SRV.shutdown()


def base_url() -> str:
    return _SRV.base_url()


def url_for(aid: str) -> str:
    return _SRV.url_for(aid)


def running() -> bool:
    return _SRV.running()


def is_lan() -> bool:
    return _SRV.lan


def set_bind(lan: bool, preferred_port: int | None = None) -> None:
    _SRV.set_bind(lan, preferred_port)


def autostart_if_pending(preferred_port: int | None = None, lan: bool = False) -> bool:
    """On dgc launch: bring the server up if there are saved artifacts. Returns True if started."""
    if _SRV.artifacts and not _SRV.running():
        _SRV.ensure_started(preferred_port, lan)
        return True
    return False


atexit.register(stop_all)


# ---- the HTTP handler + shell page ---------------------------------------
def _guess_type(p: Path) -> str:
    t, _ = mimetypes.guess_type(str(p))
    return t or "application/octet-stream"


def _make_handler(server: "_Server"):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code, body: bytes, ctype="text/html; charset=utf-8"):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def do_GET(self):
            parsed = urlparse(self.path)
            path = unquote(parsed.path)
            if path in ("/", "/index.html"):
                q = parse_qs(parsed.query)
                sel = (q.get("a") or [""])[0]
                self._send(200, _shell_html(server, sel).encode("utf-8"))
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
            self._send(404, b"not found", "text/plain; charset=utf-8")

        do_HEAD = do_GET

        def do_POST(self):
            path = unquote(urlparse(self.path).path)
            if path.startswith("/_stop/"):
                aid = path[len("/_stop/"):].strip("/")
                ok = server.remove(aid)
                self._send(200, json.dumps({"ok": ok}).encode(), "application/json")
                return
            self._send(404, b"not found", "text/plain; charset=utf-8")

        def _serve_artifact_file(self, path: str):
            rest = path[len("/a/"):]
            aid, _, sub = rest.partition("/")
            art = server.artifacts.get(aid)
            if not art:
                self._send(404, b"unknown artifact", "text/plain; charset=utf-8")
                return
            base = Path(art.directory).resolve()
            if not sub or sub.endswith("/"):
                sub = (sub + (art.entry or "index.html"))
            target = (base / sub).resolve()
            try:
                target.relative_to(base)                    # directory-traversal guard
            except ValueError:
                self._send(403, b"forbidden", "text/plain; charset=utf-8")
                return
            if target.is_dir():
                target = target / (art.entry or "index.html")
            if not target.is_file():
                self._send(404, b"not found", "text/plain; charset=utf-8")
                return
            try:
                self._send(200, target.read_bytes(), _guess_type(target))
            except OSError:
                self._send(500, b"read error", "text/plain; charset=utf-8")

    return Handler


def _shell_html(server: "_Server", selected: str) -> str:
    """The dgc-design shell: a top-left dropdown listing every artifact + an iframe."""
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
<style>
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
<script>
  const sel = document.getElementById('sel'), frame = document.getElementById('frame'),
        open = document.getElementById('open'), stop = document.getElementById('stop'),
        count = document.getElementById('count');
  let items = {json.dumps([{ "id": a.id, "name": a.name, "path": a.path } for a in arts])};
  function pathFor(id){{ const it = items.find(x=>x.id===id); return it ? it.path : ''; }}
  function show(id){{ const p = pathFor(id); if(!p) return; frame.src = p; open.href = p;
    history.replaceState(null,'', '/?a='+id); }}
  function render(){{
    count.textContent = items.length ? items.length + (items.length===1?' artifact':' artifacts') : '';
    if(!items.length){{ return; }}
    if(!items.find(x=>x.id===sel.value)) sel.value = items[0].id;
  }}
  sel.addEventListener('change', ()=>show(sel.value));
  stop.addEventListener('click', async ()=>{{
    const id = sel.value; if(!id) return;
    await fetch('/_stop/'+id, {{method:'POST'}}).catch(()=>{{}});
    await refresh(); if(items.length) show(sel.value); else location.reload();
  }});
  async function refresh(){{
    try{{ const r = await fetch('/_list'); const d = await r.json();
      items = d.artifacts.map(a=>({{id:a.id,name:a.name,path:a.path}}));
      const cur = sel.value;
      sel.innerHTML = items.map(a=>`<option value="${{a.id}}">${{a.name.replace(/</g,'&lt;')}}</option>`).join('');
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
