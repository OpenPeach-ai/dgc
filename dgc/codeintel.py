"""Bounded static code intelligence with an optional one-shot stdio LSP escalation.

The static path is dependency-free and always available. LSP processes run only when the user has
explicitly configured one; they receive a minimal environment, no shell, bounded input/output, and
are terminated after the query so no long-lived server is shared across projects or sessions.
"""
from __future__ import annotations

import ast
import itertools
import json
import os
import re
import signal
import subprocess
import threading
import time
from pathlib import Path
from urllib.parse import unquote, urlparse
from urllib.request import url2pathname

from . import __version__

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
_MAX_RESULTS = 200
_MAX_LSP_MESSAGE = 8_000_000

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


def _source_files(target: Path) -> list[Path]:
    if target.is_file():
        return [target] if target.suffix.lower() in _SOURCE_EXTS else []
    files: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(target, followlinks=False):
        base = Path(dirpath)
        dirnames[:] = sorted(
            name for name in dirnames
            if name not in _SKIP_DIRS and not (base / name).is_symlink())
        for name in sorted(filenames):
            path = base / name
            if not path.is_symlink() and path.suffix.lower() in _SOURCE_EXTS:
                files.append(path)
                if len(files) >= _MAX_FILES:
                    return files
    return files


def _read_source(path: Path) -> str | None:
    try:
        raw = path.read_bytes()
    except OSError:
        return None
    if len(raw) > _MAX_FILE_BYTES or b"\x00" in raw[:8192]:
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
        return str(path.resolve(strict=False).relative_to(root.resolve(strict=False)))
    except (OSError, ValueError):
        return ""


def _static_symbols(target: Path, root: Path, symbol: str = "") -> list[str]:
    rows: list[str] = []
    for path in _source_files(target):
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


def _static_references(target: Path, root: Path, symbol: str) -> list[str]:
    if not _IDENT.fullmatch(symbol):
        return []
    pattern = re.compile(rf"(?<![\w$]){re.escape(symbol)}(?![\w$])")
    rows: list[str] = []
    for path in _source_files(target):
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
        self.root = root.resolve(strict=False)
        self.timeout = max(0.1, min(60.0, float(timeout)))
        self.cancel = cancel
        self.proc: subprocess.Popen | None = None
        self._pgid: int | None = None
        self._ids = itertools.count(1)
        self._pending: dict[object, tuple[threading.Event, dict]] = {}
        self._pending_lock = threading.Lock()
        self._send_lock = threading.Lock()
        self._diagnostics: dict[str, list] = {}
        self._diagnostic_event = threading.Event()
        self._io_failed = False
        self.position_encoding = "utf-16"
        self.error = ""

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
        self.notify("initialized", {})
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
                        diagnostics = params.get("diagnostics") or []
                        self._diagnostics[str(params.get("uri") or "")] = (
                            list(diagnostics) if isinstance(diagnostics, list) else [])
                        self._diagnostic_event.set()
        finally:
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

    def open_document(self, path: Path, text: str) -> str:
        uri = path.resolve(strict=False).as_uri()
        sent = self.notify("textDocument/didOpen", {"textDocument": {
            "uri": uri, "languageId": _LANGUAGE_IDS.get(path.suffix.lower(), "plaintext"),
            "version": 1, "text": text,
        }})
        return uri if sent else ""

    def published_diagnostics(self, uri: str) -> tuple[bool, list]:
        self._diagnostic_event.wait(min(self.timeout, 1.0))
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
        path = Path(decoded)
        rel = _rel(path, root)
        return (path.resolve(strict=False), rel) if rel else (None, "")
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


def _lsp_query(spec: dict, path: Path, root: Path, operation: str,
               line: int, column: int, timeout: float, cancel=None) -> tuple[list[str] | None, str]:
    text = _read_source(path)
    if text is None:
        return None, "target file is unavailable, binary, or larger than 2 MB"
    client = _LSPClient(spec, root, timeout, cancel)
    if not client.start():
        return None, client.error or "language server failed to start"
    try:
        uri = client.open_document(path, text)
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
    finally:
        client.stop()


def run_code_intel(*, root: Path, target: Path, operation: str, symbol: str = "",
                   line: int = 1, column: int = 1, config=None, cancel=None) -> str:
    """Execute a bounded code-intelligence query and render model-friendly locations."""
    if operation not in ("symbols", "definition", "references", "diagnostics"):
        return "error: operation must be symbols, definition, references, or diagnostics"
    if not target.exists():
        return f"error: code-intelligence path does not exist: {target}"
    try:
        line_number, column_number = max(1, int(line)), max(1, int(column))
    except (TypeError, ValueError):
        return "error: line and column must be positive integers"

    chosen_symbol = str(symbol or "").strip()
    if operation in ("definition", "references") and not chosen_symbol and target.is_file():
        text = _read_source(target) or ""
        chosen_symbol = _identifier_at(text, line_number, column_number)
    if operation in ("definition", "references") and not chosen_symbol:
        return "error: provide symbol, or a file path with line and column on an identifier"
    if chosen_symbol and (len(chosen_symbol) > 256 or not _IDENT.fullmatch(chosen_symbol)):
        return "error: symbol must be one identifier of at most 256 characters"

    lsp_note = ""
    if target.is_file():
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
            timeout = config.get("code_intel_timeout", 15) if config is not None else 15
            try:
                timeout = float(timeout)
            except (TypeError, ValueError):
                timeout = 15.0
            rows, error = _lsp_query(spec, target, root, operation,
                                     query_line, query_column, timeout, cancel)
            if rows is not None:
                empty = "no diagnostics" if operation == "diagnostics" else "no results"
                body = "\n".join(rows) if rows else empty
                return f"code intelligence (lsp) · {operation}\n{body}"
            lsp_note = f"language server unavailable ({error or 'no result'}); static fallback\n"

    if operation in ("symbols", "definition"):
        rows = _static_symbols(target, root, chosen_symbol if operation == "definition" else "")
    elif operation == "references":
        rows = _static_references(target if target.is_dir() else root, root, chosen_symbol)
    else:
        if not target.is_file():
            return "error: diagnostics requires a file path"
        rows = _static_diagnostics(target)
        if not rows:
            rows = ["no diagnostics"]
    body = "\n".join(rows) if rows else "no results"
    return f"code intelligence (static) · {operation}\n{lsp_note}{body}"
