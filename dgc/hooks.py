"""Bounded lifecycle-hook execution for user-configured agent events.

Config (~/.dgc/config.json):
    "hooks": {
      "PreToolUse":  [{"matcher": "bash", "command": "./scripts/guard.sh"}],
      "PostToolUse": [{"command": "./scripts/format.sh"}],
      "UserPromptSubmit": [{"command": "./scripts/log-prompt.sh"}]
    }
The event payload is passed to each command as JSON on stdin. A PreToolUse or
UserPromptSubmit hook that exits non-zero BLOCKS the action (its output is the reason);
PostToolUse output is appended to the tool result as feedback.
"""
from __future__ import annotations

import codecs
import json
import math
import os
import signal
import subprocess
import threading
import time
import unicodedata


_MAX_HOOKS = 32
_MAX_COMMAND_CHARS = 16_384
_MAX_PAYLOAD_BYTES = 1024 * 1024
_MAX_OUTPUT_BYTES = 64 * 1024
_OUTPUT_HALF = _MAX_OUTPUT_BYTES // 2
HOOK_EVENTS = (
    "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PreCompact", "Stop",
)
_MAX_CATALOG_MATCHERS = 32
_MAX_MATCHER_CHARS = 128


def hook_catalog(config) -> dict:
    """Return bounded hook metadata without disclosing configured shell commands.

    Hook commands may contain paths, arguments, or inline credentials. The public catalog therefore
    exposes only the six lifecycle names DGC actually calls, bounded entry counts, and redacted exact
    tool matchers. Invalid/unknown configuration is counted rather than echoed.
    """
    from .redaction import redact_text, secret_values

    raw = config.get("hooks") or {}
    if not isinstance(raw, dict):
        return {"items": [
            {"event": event, "configured": 0, "matchers": [],
             "valid": False, "truncated": False}
            for event in HOOK_EVENTS
        ], "total": 0, "invalid": 1}
    items = []
    total = 0
    invalid = min(1_000_000, sum(1 for key in raw if key not in HOOK_EVENTS))
    secrets = secret_values(config)
    for event in HOOK_EVENTS:
        configured = raw.get(event, []) or []
        if not isinstance(configured, list):
            items.append({"event": event, "configured": 0, "matchers": [],
                          "valid": False, "truncated": False})
            invalid = min(1_000_000, invalid + 1)
            continue
        count = min(len(configured), _MAX_HOOKS)
        total += count
        matchers = []
        valid = True
        for hook in configured[:_MAX_HOOKS]:
            if not isinstance(hook, dict):
                valid = False
                invalid = min(1_000_000, invalid + 1)
                continue
            command = hook.get("command")
            if (not isinstance(command, str) or not command.strip()
                    or len(command) > _MAX_COMMAND_CHARS or "\x00" in command):
                valid = False
                invalid = min(1_000_000, invalid + 1)
            matcher = hook.get("matcher")
            if matcher is None:
                matcher = "*"
            if not isinstance(matcher, str) or "\x00" in matcher:
                valid = False
                invalid = min(1_000_000, invalid + 1)
                continue
            safe = "".join(
                " " if unicodedata.category(ch) in ("Cc", "Cf") else ch
                for ch in redact_text(matcher, secrets))
            safe = " ".join(safe.split())[:_MAX_MATCHER_CHARS]
            if safe and safe not in matchers and len(matchers) < _MAX_CATALOG_MATCHERS:
                matchers.append(safe)
        truncated = len(configured) > _MAX_HOOKS
        if truncated:
            invalid = min(1_000_000, invalid + len(configured) - _MAX_HOOKS)
        items.append({"event": event, "configured": count, "matchers": matchers,
                      "valid": valid and not truncated, "truncated": truncated})
    return {"items": items, "total": min(total, len(HOOK_EVENTS) * _MAX_HOOKS),
            "invalid": min(invalid, 1_000_000)}


class _BoundedOutput:
    """Drain a hook completely while retaining a truthful bounded head and tail."""

    def __init__(self):
        self.head = bytearray()
        self.tail = bytearray()
        self.total = 0

    def feed(self, chunk: bytes) -> None:
        if not chunk:
            return
        self.total += len(chunk)
        remaining = _OUTPUT_HALF - len(self.head)
        if remaining > 0:
            self.head.extend(chunk[:remaining])
            chunk = chunk[remaining:]
        if chunk:
            self.tail.extend(chunk)
            if len(self.tail) > _OUTPUT_HALF:
                del self.tail[:-_OUTPUT_HALF]

    def text(self) -> str:
        if self.total <= _MAX_OUTPUT_BYTES:
            raw = bytes(self.head + self.tail)
        else:
            omitted = self.total - len(self.head) - len(self.tail)
            marker = f"\n… [{omitted} hook-output bytes omitted] …\n".encode("utf-8")
            raw = bytes(self.head) + marker + bytes(self.tail)
        return raw.decode("utf-8", errors="replace").strip()


def _timeout_seconds(value) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        parsed = 20.0
    if not math.isfinite(parsed):
        parsed = 20.0
    return max(0.1, min(120.0, parsed))


def _terminate_tree(proc: subprocess.Popen) -> None:
    """Terminate the complete POSIX hook group, or the direct child on other platforms."""
    try:
        if os.name == "posix":
            os.killpg(proc.pid, signal.SIGKILL)
        else:  # Windows process-tree Job Object coverage remains a cross-platform evidence gap.
            proc.kill()
    except (OSError, ProcessLookupError, PermissionError):
        pass
    try:
        proc.wait(timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        pass
    for stream in (proc.stdin, proc.stdout):
        try:
            if stream is not None:
                stream.close()
        except (OSError, ValueError):
            pass


def _run_one(command: str, payload: bytes, config, cwd, timeout: float,
             cancelled=None) -> tuple[int | None, str, str]:
    """Return ``(returncode, bounded_output, failure_kind)`` for one hook."""
    from . import sandbox

    sandbox_requested = sandbox.requested(config)
    argv = sandbox.wrap(command, cwd, config) if sandbox_requested else [
        "/bin/bash", "-o", "pipefail", "-c", command]
    if argv is None:
        return None, "", "sandbox policy cannot safely confine this hook"
    popen_kwargs = {
        "cwd": str(cwd),
        "stdin": subprocess.PIPE,
        "stdout": subprocess.PIPE,
        "stderr": subprocess.STDOUT,
        "env": sandbox.process_env(config) if sandbox_requested else None,
    }
    if os.name == "posix":
        popen_kwargs["start_new_session"] = True
    elif os.name == "nt":  # pragma: no cover - Windows full-suite runner remains outstanding
        popen_kwargs["creationflags"] = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    try:
        proc = subprocess.Popen(argv, **popen_kwargs)
    except OSError as exc:
        return None, "", f"launch failed ({type(exc).__name__}: {str(exc)[:240]})"

    from .redaction import StreamingRedactor, secret_values

    capture = _BoundedOutput()
    decoder = codecs.getincrementaldecoder("utf-8")("replace")
    redactor = StreamingRedactor(lambda: secret_values(config))
    io_errors: list[str] = []

    def write_payload() -> None:
        try:
            if proc.stdin is not None:
                proc.stdin.write(payload)
                proc.stdin.close()
        except (BrokenPipeError, OSError, ValueError):
            # A successful hook is allowed to ignore stdin and exit before the writer finishes.
            pass

    def read_output() -> None:
        try:
            if proc.stdout is not None:
                while True:
                    chunk = proc.stdout.read(16_384)
                    if not chunk:
                        break
                    safe = redactor.feed(decoder.decode(chunk))
                    if safe:
                        capture.feed(safe.encode("utf-8"))
                final = redactor.feed(decoder.decode(b"", final=True)) + redactor.flush()
                if final:
                    capture.feed(final.encode("utf-8"))
        except (OSError, ValueError) as exc:
            io_errors.append(f"output failed ({type(exc).__name__})")

    writer = threading.Thread(target=write_payload, daemon=True)
    reader = threading.Thread(target=read_output, daemon=True)
    writer.start()
    reader.start()
    deadline = time.monotonic() + timeout
    failure = ""
    while True:
        if cancelled is not None and cancelled.is_set():
            failure = "cancelled"
            break
        if proc.poll() is not None and not writer.is_alive() and not reader.is_alive():
            break
        if time.monotonic() >= deadline:
            failure = "timed out"
            break
        time.sleep(0.02)
    if failure:
        _terminate_tree(proc)
    writer.join(timeout=1)
    reader.join(timeout=1)
    if writer.is_alive() or reader.is_alive():
        _terminate_tree(proc)
        failure = failure or "I/O did not close"
        writer.join(timeout=1)
        reader.join(timeout=1)
    output = capture.text()
    if io_errors:
        failure = failure or "; ".join(io_errors[:2])
    return proc.returncode, output, failure


def run_hooks(event: str, payload: dict, config, cwd, timeout: int | float = 20,
              *, cancelled=None, lease_held: bool = False) -> tuple[bool, str]:
    """Run hooks and return ``(blocked, bounded_output)`` under the workspace lease."""
    hook_config = config.get("hooks") or {}
    if not isinstance(hook_config, dict):
        return True, "[hooks configuration must be an object]"
    configured = hook_config.get(event, []) or []
    if not configured:
        return False, ""
    if not isinstance(configured, list):
        return True, f"[hook configuration for {event} must be a list]"
    try:
        encoded = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
    except (RecursionError, TypeError, ValueError):
        return True, f"[hook payload for {event} is not serializable]"
    if len(encoded) > _MAX_PAYLOAD_BYTES:
        return True, f"[hook payload for {event} exceeded {_MAX_PAYLOAD_BYTES} bytes]"

    batch_deadline = time.monotonic() + _timeout_seconds(timeout)
    lease = None
    if not lease_held:
        from .scheduler import workspace_mutation_lock
        lease = workspace_mutation_lock(cwd)
        while True:
            if cancelled is not None and cancelled.is_set():
                return True, f"[hook batch for {event} was cancelled before launch]"
            remaining = batch_deadline - time.monotonic()
            if remaining <= 0:
                return True, f"[hook batch for {event} timed out waiting for the workspace lease]"
            if lease.acquire(timeout=min(0.1, remaining)):
                break
            if lease.last_error:
                return True, f"[hook batch for {event} was not run: {lease.last_error}]"

    blocked = len(configured) > _MAX_HOOKS
    outputs: list[str] = []
    if blocked:
        outputs.append(f"[hook configuration for {event} exceeded {_MAX_HOOKS} entries]")
    try:
        for index, hook in enumerate(configured[:_MAX_HOOKS], 1):
            if cancelled is not None and cancelled.is_set():
                blocked = True
                outputs.append(f"[hook batch for {event} cancelled before hook #{index}]")
                break
            remaining = batch_deadline - time.monotonic()
            if remaining <= 0:
                blocked = True
                outputs.append(f"[hook batch for {event} timed out before hook #{index}]")
                break
            if not isinstance(hook, dict):
                blocked = True
                outputs.append(f"[hook {event} #{index} must be an object]")
                continue
            matcher = hook.get("matcher")
            tool = payload.get("tool")
            if matcher and matcher not in ("*", tool):
                continue
            command = hook.get("command")
            if (not isinstance(command, str) or not command.strip()
                    or len(command) > _MAX_COMMAND_CHARS or "\x00" in command):
                blocked = True
                outputs.append(f"[hook {event} #{index} has an invalid command]")
                continue
            returncode, output, failure = _run_one(
                command, encoded, config, cwd, remaining, cancelled)
            if failure:
                blocked = True
                outputs.append(f"[hook {event} #{index} {failure}]" +
                               (f"\n{output}" if output else ""))
                if failure == "cancelled":
                    break
            elif returncode != 0:
                blocked = True
                outputs.append(output or f"[hook {event} #{index} blocked, exit {returncode}]")
            elif output:
                outputs.append(output)
    finally:
        if lease is not None:
            lease.release()
    combined = "\n".join(outputs)
    if len(combined) > _MAX_OUTPUT_BYTES * 2:
        combined = combined[:_MAX_OUTPUT_BYTES] + "\n… [additional hook feedback omitted]"
    from .redaction import redact_text, secret_values
    return blocked, redact_text(combined, secret_values(config))
