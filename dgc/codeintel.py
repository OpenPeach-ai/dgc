"""Bounded static code intelligence with an optional managed stdio LSP escalation.

The static path is dependency-free and always available. LSP processes run only when the user has
explicitly configured one; they receive a minimal environment, no shell, bounded input/output, and
project-confined locations. Configured servers may be reused within the same project/spec behind a
serialized, capped, idle-reaped pool; one-shot mode remains available with an idle TTL of zero.
"""
from __future__ import annotations

import atexit
import ast
import hashlib
import itertools
import json
import math
import os
import re
import signal
import stat
import subprocess
import threading
import time
from pathlib import Path
from urllib.parse import unquote, urlparse
from urllib.request import url2pathname

from . import __version__
from .workspace import (
    WorkspaceBoundaryError,
    canonicalize_trusted_os_alias,
    read_regular_bytes,
    scan_directory_entries,
    stat_entry,
)

try:
    import tomllib
except ImportError:  # pragma: no cover - tomllib is unavailable on supported Python 3.10
    tomllib = None

_SOURCE_EXTS = {
    ".py", ".pyi", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".go", ".rs",
    ".java", ".kt", ".kts", ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".cs",
    ".rb", ".php", ".swift", ".scala", ".sh", ".bash", ".vue", ".svelte", ".json",
    ".toml",
}
_SKIP_DIRS = {".git", "node_modules", ".venv", "venv", "__pycache__", ".next",
              "dist", "build", ".pytest_cache", ".mypy_cache", "target"}
_IDENT = re.compile(r"[A-Za-z_$][\w$]*")
_MAX_FILE_BYTES = 2_000_000
_MAX_FILES = 2_000
_MAX_SCAN_ENTRIES = 100_000
_MAX_RESULTS = 200
_MAX_LSP_MESSAGE = 8_000_000
_MAX_LSP_SESSIONS = 4
_MAX_LSP_DOCUMENTS = 128

_LANGUAGE_IDS = {
    ".py": "python", ".pyi": "python", ".js": "javascript", ".jsx": "javascriptreact",
    ".ts": "typescript", ".tsx": "typescriptreact", ".mjs": "javascript",
    ".cjs": "javascript", ".go": "go", ".rs": "rust", ".java": "java",
    ".kt": "kotlin", ".kts": "kotlin", ".c": "c", ".h": "c",
    ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".cs": "csharp",
    ".rb": "ruby", ".php": "php", ".swift": "swift", ".scala": "scala",
    ".sh": "shellscript", ".bash": "shellscript", ".vue": "vue", ".svelte": "svelte",
    ".json": "json", ".toml": "toml",
}

_SYMBOL_KINDS = {
    1: "file", 2: "module", 3: "namespace", 4: "package", 5: "class", 6: "method",
    7: "property", 8: "field", 9: "constructor", 10: "enum", 11: "interface",
    12: "function", 13: "variable", 14: "constant", 15: "string", 16: "number",
    17: "boolean", 18: "array", 19: "object", 20: "key", 21: "null", 22: "enum-member",
    23: "struct", 24: "event", 25: "operator", 26: "type-parameter",
}


def _frozen_absolute(path: Path) -> Path:
    # Workspace descriptor operations canonicalize protected Darwin roots such as
    # /var -> /private/var. Keep comparison/display paths in that same spelling without resolving
    # any repository-controlled descendant symlink.
    normalized = Path(os.path.normpath(os.path.abspath(str(path))))
    return canonicalize_trusted_os_alias(normalized)


def _source_files(target: Path, *, cancel=None, deadline: float = float("inf")) -> list[Path]:
    """Discover source files through bounded no-follow directory snapshots."""
    try:
        target_info = stat_entry(target, missing_ok=True)
    except (OSError, WorkspaceBoundaryError):
        return []
    if target_info is None:
        return []
    if stat.S_ISREG(target_info.st_mode):
        return [target] if target.suffix.lower() in _SOURCE_EXTS else []
    if not stat.S_ISDIR(target_info.st_mode):
        return []
    files: list[Path] = []
    scanned = 0
    stack = [target]
    while stack and len(files) < _MAX_FILES and scanned < _MAX_SCAN_ENTRIES:
        if ((cancel is not None and cancel.is_set()) or time.monotonic() >= deadline):
            break
        directory = stack.pop()
        try:
            remaining = _MAX_SCAN_ENTRIES - scanned
            entries, truncated, count = scan_directory_entries(
                directory, maximum=remaining)
        except (OSError, WorkspaceBoundaryError):
            continue
        scanned += count
        child_directories: list[Path] = []
        for name, info in entries:
            path = directory / name
            if stat.S_ISLNK(info.st_mode):
                continue
            if stat.S_ISDIR(info.st_mode):
                if name not in _SKIP_DIRS:
                    child_directories.append(path)
            elif stat.S_ISREG(info.st_mode) and path.suffix.lower() in _SOURCE_EXTS:
                files.append(path)
                if len(files) >= _MAX_FILES:
                    return files
        stack.extend(reversed(child_directories))
        if truncated:
            break
    return files


def _read_source(path: Path) -> str | None:
    try:
        captured = read_regular_bytes(path, maximum=_MAX_FILE_BYTES, missing_ok=True)
    except (OSError, WorkspaceBoundaryError):
        return None
    if captured is None:
        return None
    raw, _version = captured
    if b"\x00" in raw[:8192]:
        return None
    return raw.decode("utf-8", errors="replace")


def _line_text(text: str, line: int) -> str:
    lines = text.splitlines()
    return lines[line - 1].strip() if 1 <= line <= len(lines) else ""


def symbol_records(path: Path, text: str) -> list[dict]:
    """Return language-aware definition records used by both repo_map and code_intel."""
    ext = path.suffix.lower()
    records: list[dict] = []
    if ext in (".py", ".pyi"):
        try:
            tree = ast.parse(text, filename=str(path))
            for node in ast.walk(tree):
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                    kind = "class" if isinstance(node, ast.ClassDef) else "function"
                    line = int(getattr(node, "lineno", 1))
                    records.append({"name": node.name, "line": line, "column": int(
                        getattr(node, "col_offset", 0)) + 1, "kind": kind,
                                    "signature": _line_text(text, line)})
            return sorted(records, key=lambda item: (item["line"], item["column"]))
        except SyntaxError:
            pass

    patterns: list[tuple[str, re.Pattern]] = []
    if ext in (".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".vue", ".svelte"):
        patterns = [
            ("type", re.compile(r"^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)")),
            ("function", re.compile(r"^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>")),
        ]
    elif ext == ".go":
        patterns = [("symbol", re.compile(r"^\s*(?:func|type)\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)"))]
    elif ext == ".rs":
        patterns = [("symbol", re.compile(r"^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait|type|mod)\s+([A-Za-z_]\w*)"))]
    elif ext in (".java", ".kt", ".kts", ".cs", ".swift", ".scala"):
        patterns = [("symbol", re.compile(r"^\s*(?:(?:public|private|protected|internal|static|final|open|abstract|sealed|data)\s+)*(?:class|interface|enum|record|object|struct|protocol|fun)\s+([A-Za-z_]\w*)"))]
    elif ext in (".c", ".h", ".cc", ".cpp", ".cxx", ".hpp"):
        patterns = [
            ("type", re.compile(r"^\s*(?:class|struct|enum)\s+([A-Za-z_]\w*)")),
            ("function", re.compile(r"^\s*[A-Za-z_][\w\s:*<>]*\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*\{?\s*$")),
        ]
    for lineno, line in enumerate(text.splitlines(), 1):
        for kind, pattern in patterns:
            match = pattern.match(line)
            if match:
                records.append({"name": match.group(1), "line": lineno,
                                "column": match.start(1) + 1, "kind": kind,
                                "signature": line.strip()})
                break
    return records


def _identifier_at(text: str, line: int, column: int) -> str:
    lines = text.splitlines()
    if not (1 <= line <= len(lines)):
        return ""
    source = lines[line - 1]
    index = max(0, min(len(source), column - 1))
    for match in _IDENT.finditer(source):
        if match.start() <= index <= match.end():
            return match.group(0)
    return ""


def _rel(path: Path, root: Path) -> str:
    try:
        candidate = _frozen_absolute(path)
        base = _frozen_absolute(root)
        if os.path.normcase(os.path.commonpath((str(base), str(candidate)))) != os.path.normcase(
                str(base)):
            return ""
        relative = os.path.relpath(candidate, base)
        return "" if relative == "." or ".." in Path(relative).parts else Path(relative).as_posix()
    except (OSError, ValueError):
        return ""


def _static_symbols(target: Path, root: Path, symbol: str = "", *, cancel=None,
                    deadline: float = float("inf")) -> list[str]:
    rows: list[str] = []
    for path in _source_files(target, cancel=cancel, deadline=deadline):
        text = _read_source(path)
        if text is None:
            continue
        rel = _rel(path, root)
        if not rel:
            continue
        for item in symbol_records(path, text):
            if symbol and item["name"] != symbol:
                continue
            rows.append(f"{rel}:{item['line']}:{item['column']}: {item['kind']} {item['name']} · {item['signature'][:300]}")
            if len(rows) >= _MAX_RESULTS:
                return rows
    return rows


def _static_references(target: Path, root: Path, symbol: str, *, cancel=None,
                       deadline: float = float("inf")) -> list[str]:
    if not _IDENT.fullmatch(symbol):
        return []
    pattern = re.compile(rf"(?<![\w$]){re.escape(symbol)}(?![\w$])")
    rows: list[str] = []
    for path in _source_files(target, cancel=cancel, deadline=deadline):
        text = _read_source(path)
        if text is None:
            continue
        rel = _rel(path, root)
        if not rel:
            continue
        for lineno, line in enumerate(text.splitlines(), 1):
            for match in pattern.finditer(line):
                rows.append(f"{rel}:{lineno}:{match.start() + 1}: {line.strip()[:500]}")
                if len(rows) >= _MAX_RESULTS:
                    return rows
    return rows


def _static_diagnostics(path: Path) -> list[str]:
    text = _read_source(path)
    if text is None:
        return ["file is unavailable, binary, or larger than 2 MB"]
    try:
        if path.suffix.lower() in (".py", ".pyi"):
            ast.parse(text, filename=str(path))
        elif path.suffix.lower() == ".json":
            json.loads(text)
        elif path.suffix.lower() == ".toml" and tomllib is not None:
            tomllib.loads(text)
        else:
            return ["no configured LSP and no dependency-free parser for this language"]
    except SyntaxError as exc:
        return [f"{exc.lineno or 1}:{exc.offset or 1}: error: {exc.msg}"]
    except (json.JSONDecodeError, ValueError) as exc:
        return [f"{getattr(exc, 'lineno', 1)}:{getattr(exc, 'colno', 1)}: error: {exc}"]
    return []


def _server_spec(config, path: Path) -> dict | None:
    servers = config.get("language_servers", {}) if config is not None else {}
    if not isinstance(servers, dict):
        return None
    ext = path.suffix.lower()
    language = _LANGUAGE_IDS.get(ext, ext.lstrip("."))
    direct = servers.get(ext) or servers.get(language)
    candidates = [direct] if isinstance(direct, dict) else []
    candidates += [spec for spec in servers.values() if isinstance(spec, dict) and spec not in candidates]
    for spec in candidates:
        extensions = spec.get("extensions") or []
        if not isinstance(extensions, (list, tuple, set)):
            extensions = []
        if spec is direct or ext in {str(item).lower() for item in extensions}:
            command = spec.get("command")
            if isinstance(command, str) and command.strip() and "\x00" not in command:
                return spec
    return None


class _LSPClient:
    def __init__(self, spec: dict, root: Path, timeout: float, cancel=None):
        self.spec = spec
        self.root = _frozen_absolute(root)
        self.timeout = max(0.1, min(60.0, float(timeout)))
        self.cancel = cancel
        self.proc: subprocess.Popen | None = None
        self._pgid: int | None = None
        self._ids = itertools.count(1)
        self._pending: dict[object, tuple[threading.Event, dict]] = {}
        self._pending_lock = threading.Lock()
        self._send_lock = threading.Lock()
        self._diagnostics: dict[str, list] = {}
        self._diagnostic_events: dict[str, threading.Event] = {}
        self._diagnostic_lock = threading.Lock()
        self._documents: dict[str, tuple[int, bytes]] = {}
        self._opening_documents: set[str] = set()
        self._io_failed = False
        self.position_encoding = "utf-16"
        self.error = ""

    def alive(self) -> bool:
        return bool(self.proc and self.proc.poll() is None and not self._io_failed)

    def start(self) -> bool:
        command = str(self.spec.get("command") or "")
        configured_args = self.spec.get("args") or []
        if not isinstance(configured_args, list):
            self.error = "language-server args must be a list"
            return False
        args = [str(item) for item in configured_args]
        if any("\x00" in item for item in args):
            self.error = "invalid language-server argument"
            return False
        from .guards import mcp_process_env
        env, _ = mcp_process_env(self.spec.get("env") if isinstance(self.spec.get("env"), dict) else None)
        try:
            self.proc = subprocess.Popen(
                [command, *args], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL, cwd=str(self.root), env=env,
                start_new_session=True,
            )
            if os.name == "posix":
                self._pgid = self.proc.pid
        except Exception as exc:
            self.error = f"could not launch ({type(exc).__name__})"
            return False
        threading.Thread(target=self._reader, name="dgc-lsp-reader", daemon=True).start()
        result, error = self.request("initialize", {
            "processId": os.getpid(), "rootUri": self.root.as_uri(),
            "workspaceFolders": [{"uri": self.root.as_uri(), "name": self.root.name}],
            "capabilities": {"textDocument": {
                "definition": {"linkSupport": True},
                "documentSymbol": {"hierarchicalDocumentSymbolSupport": True},
                "diagnostic": {},
            }, "general": {"positionEncodings": ["utf-8", "utf-16", "utf-32"]}},
            "clientInfo": {"name": "dgc", "version": __version__},
        })
        if error or not isinstance(result, dict):
            self.error = f"initialize failed ({error})"
            self.stop(graceful=False)
            return False
        capabilities = result.get("capabilities") or {}
        encoding = capabilities.get("positionEncoding") if isinstance(capabilities, dict) else None
        if encoding in ("utf-8", "utf-16", "utf-32"):
            self.position_encoding = encoding
        if not self.notify("initialized", {}):
            self.error = "initialized notification failed"
            self.stop(graceful=False)
            return False
        return True

    def _send(self, payload: dict) -> bool:
        proc = self.proc
        if not proc or not proc.stdin:
            return False
        try:
            body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            if len(body) > _MAX_LSP_MESSAGE:
                return False
            wire = f"Content-Length: {len(body)}\r\n\r\n".encode("ascii") + body
        except (TypeError, ValueError):
            return False

        done = threading.Event()
        outcome = {"ok": False}

        def write() -> None:
            try:
                with self._send_lock:
                    proc.stdin.write(wire)
                    proc.stdin.flush()
                outcome["ok"] = True
            except (OSError, ValueError):
                pass
            finally:
                done.set()

        threading.Thread(target=write, name="dgc-lsp-writer", daemon=True).start()
        deadline = time.monotonic() + min(self.timeout, 2.0)
        while not done.wait(min(0.05, max(0.0, deadline - time.monotonic()))):
            if ((self.cancel is not None and self.cancel.is_set())
                    or time.monotonic() >= deadline):
                self._io_failed = True
                return False
        if not outcome["ok"]:
            self._io_failed = True
        return outcome["ok"]

    def request(self, method: str, params: dict, timeout: float | None = None):
        request_id = next(self._ids)
        event = threading.Event()
        holder: dict = {}
        with self._pending_lock:
            self._pending[request_id] = (event, holder)
        if not self._send({"jsonrpc": "2.0", "id": request_id,
                           "method": method, "params": params}):
            with self._pending_lock:
                self._pending.pop(request_id, None)
            return None, "stdin unavailable"
        deadline = time.monotonic() + (self.timeout if timeout is None else max(0.1, timeout))
        while not event.wait(min(0.05, max(0.0, deadline - time.monotonic()))):
            if self.cancel is not None and self.cancel.is_set():
                reason = "cancelled"
            elif time.monotonic() >= deadline:
                reason = "timed out"
            else:
                continue
            with self._pending_lock:
                self._pending.pop(request_id, None)
            self.notify("$/cancelRequest", {"id": request_id})
            return None, reason
        if holder.get("error") is not None:
            error = holder["error"]
            code = error.get("code") if isinstance(error, dict) else "server error"
            return None, f"server error {code}"
        return holder.get("result"), None

    def notify(self, method: str, params: dict) -> bool:
        return self._send({"jsonrpc": "2.0", "method": method, "params": params})

    def _reader(self) -> None:
        proc = self.proc
        stream = proc.stdout if proc else None
        if stream is None:
            return
        try:
            while True:
                headers: dict[str, str] = {}
                header_bytes = 0
                while True:
                    line = stream.readline(8192)
                    if not line:
                        return
                    header_bytes += len(line)
                    if header_bytes > 65_536 or (len(line) >= 8192 and not line.endswith(b"\n")):
                        return
                    if line in (b"\r\n", b"\n"):
                        break
                    if b":" not in line:
                        return
                    key, value = line.decode("ascii", errors="ignore").split(":", 1)
                    headers[key.strip().lower()] = value.strip()
                try:
                    length = int(headers.get("content-length", "0"))
                except ValueError:
                    return
                if not (0 < length <= _MAX_LSP_MESSAGE):
                    return
                body = stream.read(length)
                if len(body) != length:
                    return
                try:
                    message = json.loads(body.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    continue
                if not isinstance(message, dict):
                    continue
                mid = message.get("id")
                if mid is not None and ("result" in message or "error" in message):
                    with self._pending_lock:
                        slot = self._pending.pop(mid, None)
                    if slot:
                        event, holder = slot
                        holder["result"] = message.get("result")
                        holder["error"] = message.get("error")
                        event.set()
                elif mid is not None and message.get("method"):
                    self._server_request(mid, str(message["method"]), message.get("params"))
                elif message.get("method") == "textDocument/publishDiagnostics":
                    params = message.get("params") or {}
                    if isinstance(params, dict):
                        uri = str(params.get("uri") or "")
                        diagnostics = params.get("diagnostics") or []
                        self._record_diagnostics(uri, diagnostics)
        finally:
            self._io_failed = True
            with self._pending_lock:
                pending, self._pending = list(self._pending.values()), {}
            for event, holder in pending:
                holder["error"] = {"code": -32000}
                event.set()

    def _server_request(self, request_id, method: str, params=None) -> None:
        if method == "workspace/workspaceFolders":
            result = [{"uri": self.root.as_uri(), "name": self.root.name}]
        elif method == "workspace/configuration":
            # LSP requires one response value for each requested configuration item.
            items = params.get("items") if isinstance(params, dict) else []
            result = [None] * len(items) if isinstance(items, list) else []
        elif method in ("client/registerCapability", "client/unregisterCapability",
                        "window/workDoneProgress/create"):
            result = None
        else:
            self._send({"jsonrpc": "2.0", "id": request_id,
                        "error": {"code": -32601, "message": "unsupported client method"}})
            return
        self._send({"jsonrpc": "2.0", "id": request_id, "result": result})

    def _record_diagnostics(self, uri: str, diagnostics) -> bool:
        """Accept diagnostics only for the client's bounded active document set."""
        with self._diagnostic_lock:
            if not uri or (uri not in self._documents and uri not in self._opening_documents):
                return False
            self._diagnostics[uri] = (
                list(diagnostics[:_MAX_RESULTS]) if isinstance(diagnostics, list) else [])
            self._diagnostic_events.setdefault(uri, threading.Event()).set()
            return True

    def _close_document(self, uri: str) -> bool:
        if not self.notify("textDocument/didClose", {"textDocument": {"uri": uri}}):
            return False
        with self._diagnostic_lock:
            self._documents.pop(uri, None)
            self._opening_documents.discard(uri)
            self._diagnostics.pop(uri, None)
            event = self._diagnostic_events.pop(uri, None)
        if event is not None:
            event.set()
        return True

    def sync_document(self, path: Path, text: str) -> str:
        """Open a file once and close/reopen it when its on-disk contents change."""
        uri = _frozen_absolute(path).as_uri()
        digest = hashlib.sha256(text.encode("utf-8", errors="replace")).digest()
        with self._diagnostic_lock:
            prior = self._documents.get(uri)
            if prior and prior[1] == digest:
                # Plain dicts retain insertion order: refresh this URI as the eviction LRU.
                self._documents.pop(uri, None)
                self._documents[uri] = prior
                return uri
        version = prior[0] + 1 if prior else 1
        if prior and not self._close_document(uri):
            return ""
        if not prior:
            with self._diagnostic_lock:
                oldest = (next(iter(self._documents))
                          if len(self._documents) >= _MAX_LSP_DOCUMENTS else "")
            if oldest and not self._close_document(oldest):
                return ""
        with self._diagnostic_lock:
            self._diagnostics.pop(uri, None)
            self._diagnostic_events.setdefault(uri, threading.Event()).clear()
            self._opening_documents.add(uri)
        sent = self.notify("textDocument/didOpen", {"textDocument": {
            "uri": uri, "languageId": _LANGUAGE_IDS.get(path.suffix.lower(), "plaintext"),
            "version": version, "text": text,
        }})
        failed_event = None
        with self._diagnostic_lock:
            self._opening_documents.discard(uri)
            if sent:
                self._documents[uri] = (version, digest)
            else:
                self._documents.pop(uri, None)
                self._diagnostics.pop(uri, None)
                failed_event = self._diagnostic_events.pop(uri, None)
        if failed_event is not None:
            failed_event.set()
        return uri if sent else ""

    def published_diagnostics(self, uri: str) -> tuple[bool, list]:
        with self._diagnostic_lock:
            event = self._diagnostic_events.setdefault(uri, threading.Event())
        event.wait(min(self.timeout, 1.0))
        with self._diagnostic_lock:
            return uri in self._diagnostics, list(self._diagnostics.get(uri, []))

    def stop(self, graceful: bool = True) -> None:
        proc = self.proc
        if not proc:
            return
        if graceful and not self._io_failed and proc.poll() is None:
            self.request("shutdown", {}, timeout=1.0)
            self.notify("exit", {})
        self.proc = None
        if proc.poll() is None:
            try:
                proc.wait(timeout=0.25)
            except subprocess.TimeoutExpired:
                pass
        if os.name == "posix" and self._pgid is not None:
            try:
                os.killpg(self._pgid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            except OSError:
                pass
            if proc.poll() is None:
                try:
                    proc.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    pass
            try:
                os.killpg(self._pgid, 0)
                os.killpg(self._pgid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            except OSError:
                pass
        elif proc.poll() is None:
            try:
                proc.terminate()
                proc.wait(timeout=1)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
        try:
            proc.wait(timeout=0.1)
        except Exception:
            pass
        with self._pending_lock:
            pending, self._pending = list(self._pending.values()), {}
        for event, holder in pending:
            holder["error"] = {"code": -32000}
            event.set()
        with self._diagnostic_lock:
            self._documents.clear()
            self._opening_documents.clear()
            self._diagnostics.clear()
            diagnostic_events, self._diagnostic_events = list(self._diagnostic_events.values()), {}
        for event in diagnostic_events:
            event.set()


def _lsp_file(uri: str, root: Path) -> tuple[Path | None, str]:
    try:
        parsed = urlparse(uri)
        if parsed.scheme != "file":
            return None, ""
        # url2pathname handles Windows drive/UNC forms while remaining a no-op for normal POSIX
        # paths. A non-local authority is still constrained by _rel below.
        decoded = url2pathname(unquote(parsed.path))
        if parsed.netloc and parsed.netloc not in ("", "localhost"):
            decoded = f"//{parsed.netloc}{decoded}"
        path = _frozen_absolute(Path(decoded))
        rel = _rel(path, root)
        info = stat_entry(path, missing_ok=True) if rel else None
        return (path, rel) if info is not None and stat.S_ISREG(info.st_mode) else (None, "")
    except (OSError, ValueError):
        return None, ""


def _unit_width(value: str, encoding: str) -> int:
    if encoding == "utf-8":
        return len(value.encode("utf-8"))
    if encoding == "utf-32":
        return len(value)
    return len(value.encode("utf-16-le")) // 2


def _position(record: dict, key: str = "range", *, text: str | None = None,
              encoding: str = "utf-16") -> tuple[int, int]:
    try:
        value = record.get(key) or {}
        start = value.get("start") or {}
        line_index = max(0, int(start.get("line", 0)))
        units = max(0, int(start.get("character", 0)))
    except (AttributeError, TypeError, ValueError):
        return 1, 1
    if text is None:
        return line_index + 1, units + 1
    lines = text.splitlines()
    source = lines[line_index] if line_index < len(lines) else ""
    consumed = 0
    characters = 0
    for character in source:
        width = _unit_width(character, encoding)
        if consumed + width > units:
            break
        consumed += width
        characters += 1
        if consumed >= units:
            break
    return line_index + 1, characters + 1


def _kind_name(value) -> str:
    try:
        return _SYMBOL_KINDS.get(int(value or 0), "symbol")
    except (TypeError, ValueError):
        return "symbol"


def _severity_name(value) -> str:
    try:
        return {1: "error", 2: "warning", 3: "info", 4: "hint"}.get(
            int(value or 0), "diagnostic")
    except (TypeError, ValueError):
        return "diagnostic"


def _lsp_position(text: str, line: int, column: int,
                  encoding: str = "utf-16") -> dict[str, int]:
    """Convert DGC's one-based Unicode column to an LSP position encoding."""
    source_lines = text.splitlines()
    line_index = max(0, int(line) - 1)
    source = source_lines[line_index] if line_index < len(source_lines) else ""
    prefix = source[:max(0, int(column) - 1)]
    character = _unit_width(prefix, encoding)
    return {"line": line_index, "character": character}


def _cached_source(path: Path | None, cache: dict[str, str | None]) -> str | None:
    if path is None:
        return None
    key = str(path)
    if key not in cache:
        cache[key] = _read_source(path)
    return cache[key]


def _render_locations(value, root: Path, encoding: str = "utf-16") -> list[str]:
    items = value if isinstance(value, list) else [value] if isinstance(value, dict) else []
    rows: list[str] = []
    sources: dict[str, str | None] = {}
    for item in items[:_MAX_RESULTS]:
        if not isinstance(item, dict):
            continue
        uri = str(item.get("uri") or item.get("targetUri") or "")
        path, rel = _lsp_file(uri, root)
        if not rel:
            continue
        range_value = item.get("range") or item.get("targetSelectionRange") or item.get("targetRange") or {}
        line, column = _position({"range": range_value}, text=_cached_source(path, sources),
                                 encoding=encoding)
        rows.append(f"{rel}:{line}:{column}")
    return rows


def _render_symbols(value, root: Path, default_uri: str,
                    encoding: str = "utf-16") -> list[str]:
    rows: list[str] = []
    sources: dict[str, str | None] = {}
    stack = [(item, default_uri) for item in reversed(value if isinstance(value, list) else [])]
    while stack and len(rows) < _MAX_RESULTS:
        item, inherited_uri = stack.pop()
        if not isinstance(item, dict):
            continue
        location = item.get("location") or {}
        if not isinstance(location, dict):
            location = {}
        uri = str(location.get("uri") or inherited_uri)
        path, rel = _lsp_file(uri, root)
        range_value = (item.get("selectionRange") or item.get("range")
                       or location.get("range") or {})
        line, column = _position({"range": range_value}, text=_cached_source(path, sources),
                                 encoding=encoding)
        if rel:
            kind = _kind_name(item.get("kind"))
            rows.append(f"{rel}:{line}:{column}: {kind} {str(item.get('name') or '')[:200]}")
        children = item.get("children") or []
        if isinstance(children, list):
            stack.extend((child, uri) for child in reversed(children))
    return rows


def _render_diagnostics(value, root: Path, uri: str,
                        encoding: str = "utf-16") -> list[str]:
    items = value if isinstance(value, list) else []
    path, rel = _lsp_file(uri, root)
    if not rel:
        return []
    text = _read_source(path) if path is not None else None
    rows: list[str] = []
    for item in items[:_MAX_RESULTS]:
        if not isinstance(item, dict):
            continue
        line, column = _position(item, text=text, encoding=encoding)
        severity = _severity_name(item.get("severity"))
        message = re.sub(r"\s+", " ", str(item.get("message") or "")).strip()[:500]
        code = item.get("code")
        suffix = f" [{str(code)[:80]}]" if code not in (None, "") else ""
        rows.append(f"{rel}:{line}:{column}: {severity}: {message}{suffix}")
    return rows


def _lsp_client_query(client: _LSPClient, path: Path, root: Path, operation: str,
                      line: int, column: int) -> tuple[list[str] | None, str]:
    text = _read_source(path)
    if text is None:
        return None, "target file is unavailable, binary, or larger than 2 MB"
    if not client.alive():
        return None, "language server exited"
    uri = client.sync_document(path, text)
    if not uri:
        return None, "language-server stdin stalled"
    document = {"uri": uri}
    position = _lsp_position(text, line, column, client.position_encoding)
    if operation == "definition":
        result, error = client.request("textDocument/definition", {
            "textDocument": document, "position": position})
        return (None, error) if error else (
            _render_locations(result, root, client.position_encoding), "")
    if operation == "references":
        result, error = client.request("textDocument/references", {
            "textDocument": document, "position": position,
            "context": {"includeDeclaration": True}})
        return (None, error) if error else (
            _render_locations(result, root, client.position_encoding), "")
    if operation == "symbols":
        result, error = client.request("textDocument/documentSymbol", {
            "textDocument": document})
        return (None, error) if error else (
            _render_symbols(result, root, uri, client.position_encoding), "")
    result, error = client.request("textDocument/diagnostic", {
        "textDocument": document, "identifier": None,
        "previousResultId": None})
    if not error and isinstance(result, dict):
        return _render_diagnostics(result.get("items") or [], root, uri,
                                   client.position_encoding), ""
    published_seen, published = client.published_diagnostics(uri)
    if published_seen or not error:
        return _render_diagnostics(published, root, uri, client.position_encoding), ""
    return None, error


def _lsp_query(spec: dict, path: Path, root: Path, operation: str,
               line: int, column: int, timeout: float, cancel=None) -> tuple[list[str] | None, str]:
    client = _LSPClient(spec, root, timeout, cancel)
    if not client.start():
        return None, client.error or "language server failed to start"
    try:
        return _lsp_client_query(client, path, root, operation, line, column)
    finally:
        client.stop()


class _PersistentLSPSession:
    """One serialized project/spec LSP connection owned by the bounded process pool."""

    def __init__(self, spec: dict, root: Path, idle_s: float):
        self.spec = dict(spec)
        self.root = _frozen_absolute(root)
        self.idle_s = idle_s
        self.last_used = time.monotonic()
        self.users = 0  # protected by _LSPPool._lock
        self.lock = threading.Lock()
        self.client: _LSPClient | None = None

    def query(self, path: Path, operation: str, line: int, column: int,
              timeout: float, cancel=None) -> tuple[list[str] | None, str]:
        deadline = time.monotonic() + max(0.1, min(60.0, timeout))
        while not self.lock.acquire(timeout=min(0.05, max(0.001, deadline - time.monotonic()))):
            if cancel is not None and cancel.is_set():
                return None, "cancelled while waiting for language server"
            if time.monotonic() >= deadline:
                return None, "language server busy"
        try:
            remaining = max(0.1, deadline - time.monotonic())
            if self.client is not None and not self.client.alive():
                self.client.stop(graceful=False)
                self.client = None
            if self.client is None:
                candidate = _LSPClient(self.spec, self.root, remaining, cancel)
                if not candidate.start():
                    return None, candidate.error or "language server failed to start"
                self.client = candidate
            else:
                self.client.timeout = remaining
                self.client.cancel = cancel
            rows, error = _lsp_client_query(
                self.client, path, self.root, operation, line, column)
            if error and (not self.client.alive() or error in {
                    "stdin unavailable", "timed out", "cancelled", "language server exited",
                    "language-server stdin stalled"}):
                self.client.stop(graceful=False)
                self.client = None
            return rows, error
        finally:
            if self.client is not None:
                self.client.cancel = None
            self.lock.release()

    def stop(self) -> None:
        with self.lock:
            if self.client is not None:
                self.client.stop()
                self.client = None


class _LSPPool:
    def __init__(self):
        self._lock = threading.Lock()
        self._sessions: dict[tuple[str, str], _PersistentLSPSession] = {}
        self._wake = threading.Event()
        self._reaper: threading.Thread | None = None

    @staticmethod
    def _key(spec: dict, root: Path) -> tuple[str, str]:
        encoded = json.dumps(spec, sort_keys=True, separators=(",", ":"), default=str).encode()
        return str(_frozen_absolute(root)), hashlib.sha256(encoded).hexdigest()

    def _ensure_reaper_locked(self) -> None:
        if self._reaper is not None and self._reaper.is_alive():
            return
        self._reaper = threading.Thread(
            target=self._reap_loop, name="dgc-lsp-reaper", daemon=True)
        self._reaper.start()

    def _reap_loop(self) -> None:
        while True:
            self._wake.wait(0.25)
            self._wake.clear()
            now = time.monotonic()
            victims: list[_PersistentLSPSession] = []
            with self._lock:
                for key, session in list(self._sessions.items()):
                    if session.users == 0 and now - session.last_used >= session.idle_s:
                        self._sessions.pop(key, None)
                        victims.append(session)
                finished = not self._sessions
                if finished:
                    self._reaper = None
            for session in victims:
                session.stop()
            if finished:
                return

    def query(self, spec: dict, path: Path, root: Path, operation: str,
              line: int, column: int, timeout: float, idle_s: float,
              cancel=None) -> tuple[list[str] | None, str]:
        key = self._key(spec, root)
        evicted: list[_PersistentLSPSession] = []
        session: _PersistentLSPSession | None
        with self._lock:
            session = self._sessions.get(key)
            if session is None:
                idle = sorted((item for item in self._sessions.items() if item[1].users == 0),
                              key=lambda item: item[1].last_used)
                while len(self._sessions) >= _MAX_LSP_SESSIONS and idle:
                    old_key, old = idle.pop(0)
                    self._sessions.pop(old_key, None)
                    evicted.append(old)
                if len(self._sessions) < _MAX_LSP_SESSIONS:
                    session = _PersistentLSPSession(spec, root, idle_s)
                    self._sessions[key] = session
            if session is not None:
                session.idle_s = idle_s
                session.users += 1
                self._ensure_reaper_locked()
        for old in evicted:
            old.stop()
        if session is None:
            return _lsp_query(spec, path, root, operation, line, column, timeout, cancel)
        try:
            return session.query(path, operation, line, column, timeout, cancel)
        finally:
            with self._lock:
                session.users = max(0, session.users - 1)
                session.last_used = time.monotonic()
                self._wake.set()

    def stop_all(self, root: Path | None = None) -> None:
        wanted = str(_frozen_absolute(root)) if root is not None else None
        with self._lock:
            chosen = [(key, session) for key, session in self._sessions.items()
                      if wanted is None or key[0] == wanted]
            for key, _ in chosen:
                self._sessions.pop(key, None)
            self._wake.set()
        for _, session in chosen:
            session.stop()


_LSP_POOL = _LSPPool()
atexit.register(_LSP_POOL.stop_all)


def stop_lsp_sessions(root: Path | None = None) -> None:
    """Stop managed language servers, primarily for explicit runtime/test teardown."""
    _LSP_POOL.stop_all(root)


def _configured_seconds(config, key: str, default: float,
                        minimum: float, maximum: float) -> float:
    raw = config.get(key, default) if config is not None else default
    try:
        value = float(raw)
    except (TypeError, ValueError):
        value = default
    if not math.isfinite(value):
        value = default
    return max(minimum, min(maximum, value))


def run_code_intel(*, root: Path, target: Path, operation: str, symbol: str = "",
                   line: int = 1, column: int = 1, config=None, cancel=None) -> str:
    """Execute a bounded code-intelligence query and render model-friendly locations."""
    if operation not in ("symbols", "definition", "references", "diagnostics"):
        return "error: operation must be symbols, definition, references, or diagnostics"
    try:
        target_info = stat_entry(target, missing_ok=True)
    except (OSError, WorkspaceBoundaryError):
        target_info = None
    if target_info is None:
        return f"error: code-intelligence path does not exist: {target}"
    target_is_file = stat.S_ISREG(target_info.st_mode)
    target_is_directory = stat.S_ISDIR(target_info.st_mode)
    if not target_is_file and not target_is_directory:
        return f"error: code-intelligence path is not a regular file/directory: {target}"
    try:
        line_number, column_number = max(1, int(line)), max(1, int(column))
    except (TypeError, ValueError):
        return "error: line and column must be positive integers"

    chosen_symbol = str(symbol or "").strip()
    if operation in ("definition", "references") and not chosen_symbol and target_is_file:
        text = _read_source(target) or ""
        chosen_symbol = _identifier_at(text, line_number, column_number)
    if operation in ("definition", "references") and not chosen_symbol:
        return "error: provide symbol, or a file path with line and column on an identifier"
    if chosen_symbol and (len(chosen_symbol) > 256 or not _IDENT.fullmatch(chosen_symbol)):
        return "error: symbol must be one identifier of at most 256 characters"

    lsp_note = ""
    if target_is_file:
        spec = _server_spec(config, target)
        if spec:
            query_line, query_column = line_number, column_number
            if chosen_symbol and line_number == 1 and column_number == 1:
                text = _read_source(target) or ""
                for lineno, source in enumerate(text.splitlines(), 1):
                    match = re.search(rf"(?<![\w$]){re.escape(chosen_symbol)}(?![\w$])", source)
                    if match:
                        query_line, query_column = lineno, match.start() + 1
                        break
            timeout = _configured_seconds(config, "code_intel_timeout", 15.0, 0.1, 60.0)
            idle_s = _configured_seconds(config, "code_intel_lsp_idle_s", 120.0, 0.0, 3600.0)
            # External files can be explicitly approved for a query, but never remain open in a
            # project-scoped warm server after that approval context has ended.
            if idle_s > 0 and _rel(target, root):
                rows, error = _LSP_POOL.query(
                    spec, target, root, operation, query_line, query_column,
                    timeout, idle_s, cancel)
            else:
                rows, error = _lsp_query(
                    spec, target, root, operation, query_line, query_column, timeout, cancel)
            if rows is not None:
                empty = "no diagnostics" if operation == "diagnostics" else "no results"
                body = "\n".join(rows) if rows else empty
                return f"code intelligence (lsp) · {operation}\n{body}"
            lsp_note = f"language server unavailable ({error or 'no result'}); static fallback\n"

    static_timeout = _configured_seconds(config, "code_intel_timeout", 15.0, 0.1, 60.0)
    static_deadline = time.monotonic() + static_timeout
    if operation in ("symbols", "definition"):
        rows = _static_symbols(
            target, root, chosen_symbol if operation == "definition" else "",
            cancel=cancel, deadline=static_deadline)
    elif operation == "references":
        rows = _static_references(
            target if target_is_directory else root, root, chosen_symbol,
            cancel=cancel, deadline=static_deadline)
    else:
        if not target_is_file:
            return "error: diagnostics requires a file path"
        rows = _static_diagnostics(target)
        if not rows:
            rows = ["no diagnostics"]
    body = "\n".join(rows) if rows else "no results"
    return f"code intelligence (static) · {operation}\n{lsp_note}{body}"
