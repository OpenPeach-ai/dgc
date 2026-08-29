#!/usr/bin/env python3
"""Endpoint-free microbenchmark for DGC's local runtime boundaries.

This is diagnostic evidence, not a coding-quality score. It measures the fixed local costs that are
often blamed for harness regressions: crash-safe checkout leases, exact file reads/writes, the
crash-safe activity journal, ordinary shell startup, and OS-confined shell startup. It never contacts
a model endpoint and performs every write inside a temporary directory.
"""
from __future__ import annotations

import argparse
import copy
import json
import math
import platform
import statistics
import sys
import tempfile
import threading
import time
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent
if str(PROJECT) not in sys.path:
    sys.path.insert(0, str(PROJECT))

from dgc import scheduler, sessions  # noqa: E402
from dgc.agent import Agent, AgentContext  # noqa: E402
from dgc.config import DEFAULTS, Config  # noqa: E402
from dgc.sandbox import available as sandbox_available  # noqa: E402
from dgc.sandbox import wrap as sandbox_wrap  # noqa: E402
from dgc.scheduler import workspace_mutation_lock  # noqa: E402
from dgc.tools import direct_bash, read_file, write_file  # noqa: E402


def _sample_count(value: str) -> int:
    try:
        count = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError("sample count must be an integer") from None
    if not 1 <= count <= 10_000:
        raise argparse.ArgumentTypeError("sample count must be between 1 and 10000")
    return count


def summarize_ms(samples: list[float]) -> dict[str, float | int]:
    """Return deterministic, JSON-safe distribution fields for non-empty millisecond samples."""
    if not samples:
        raise ValueError("at least one timing sample is required")
    ordered = sorted(max(0.0, float(value)) for value in samples)
    p95_index = min(len(ordered) - 1, max(0, math.ceil(len(ordered) * 0.95) - 1))
    return {
        "samples": len(ordered),
        "median_ms": round(statistics.median(ordered), 3),
        "p95_ms": round(ordered[p95_index], 3),
        "mean_ms": round(statistics.mean(ordered), 3),
    }


def _measure(count: int, operation, *, validate=None, warmups: int = 3) -> dict[str, float | int]:
    for _ in range(max(0, warmups)):
        value = operation()
        if validate is not None:
            validate(value)
    samples: list[float] = []
    for _ in range(count):
        started = time.perf_counter_ns()
        value = operation()
        elapsed_ms = (time.perf_counter_ns() - started) / 1_000_000
        if validate is not None:
            validate(value)
        samples.append(elapsed_ms)
    return summarize_ms(samples)


def _isolated_config(root: Path) -> Config:
    """Build a default config without reading, migrating, or writing the user's real config."""
    config = object.__new__(Config)
    config.project_root = root
    config.project_dir = root / ".dgc"
    config._persist = False
    config.data = copy.deepcopy(DEFAULTS)
    config._stored_secrets = {}
    config._env_secret_keys = set()
    config.permissions = {"allow": [], "ask": [], "deny": []}
    return config


class _QuietUI:
    def __getattr__(self, _name):
        return lambda *args, **kwargs: None


def run_probe(*, fast_samples: int = 500, write_samples: int = 100,
              command_samples: int = 30) -> dict:
    measurements: dict[str, dict | None] = {}
    backend = sandbox_available()
    shell_available = Path("/bin/bash").is_file()
    with tempfile.TemporaryDirectory(prefix="dgc-runtime-micro-") as raw:
        root = Path(raw)
        session_dir = root / "sessions"
        lock_dir = root / "locks"
        original_sessions_dir = sessions.SESSIONS_DIR
        original_lock_directory = scheduler._lock_directory

        def isolated_lock_directory() -> Path:
            lock_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
            return lock_dir

        # Keep even DGC's normally owner-private session/lock sidecars inside the disposable probe.
        sessions.SESSIONS_DIR = session_dir
        scheduler._lock_directory = isolated_lock_directory
        try:
            config = _isolated_config(root)
            context = AgentContext(root, config, cancelled=threading.Event())
            target = root / "sample.py"
            target.write_text("x = 1\n" * 128, encoding="utf-8")

            lease = workspace_mutation_lock(root)

            def lease_once():
                if not lease.acquire():
                    raise RuntimeError(lease.last_error or "workspace lease was unavailable")
                lease.release()

            measurements["workspace_lease"] = _measure(
                fast_samples, lease_once, warmups=min(10, fast_samples))
            measurements["read_file_768b"] = _measure(
                fast_samples, lambda: read_file({"path": "sample.py"}, context),
                validate=lambda out: _require_prefix(out, "sha256\t"))

            generation = 0

            def write_once():
                nonlocal generation
                generation += 1
                return write_file(
                    {"path": "sample.py", "content": ("x = 1\n" * 128) + f"# {generation}\n"},
                    context)

            measurements["write_file_approx_800b"] = _measure(
                write_samples, write_once, validate=lambda out: _require_prefix(out, "wrote "))

            agent = Agent(config, _QuietUI())
            try:
                agent.session_file = sessions.new_path(root)
                measurements["crash_safe_activity_journal"] = _measure(
                    write_samples, lambda: agent._record_activity("read_file"))
            finally:
                agent.mcp.stop_all()

            config.data["sandbox"] = False
            measurements["direct_bash_unconfined"] = (_measure(
                command_samples, lambda: direct_bash("true", context),
                validate=lambda out: _require_prefix(out, "exit code: 0"))
                if shell_available else None)

            if backend and shell_available:
                config.data["sandbox"] = True
                measurements["sandbox_policy_build"] = _measure(
                    fast_samples, lambda: sandbox_wrap("true", root, config),
                    validate=lambda argv: _require_truthy(argv, "sandbox policy was unavailable"))
                measurements["direct_bash_confined"] = _measure(
                    command_samples, lambda: direct_bash("true", context),
                    validate=lambda out: _require_prefix(out, "exit code: 0"))
            else:
                measurements["sandbox_policy_build"] = None
                measurements["direct_bash_confined"] = None
        finally:
            sessions.SESSIONS_DIR = original_sessions_dir
            scheduler._lock_directory = original_lock_directory

    return {
        "schema_version": 1,
        "kind": "dgc_runtime_microbenchmark",
        "platform": platform.platform(),
        "python": platform.python_version(),
        "shell_available": shell_available,
        "sandbox_backend": backend,
        "measurements": measurements,
        "interpretation": (
            "Fixed local runtime overhead only; this is not model quality, task latency, or league evidence."
        ),
    }


def _require_prefix(value, prefix: str) -> None:
    if not str(value).startswith(prefix):
        raise RuntimeError(f"probe operation failed: {str(value)[:300]}")


def _require_truthy(value, message: str) -> None:
    if not value:
        raise RuntimeError(message)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fast-samples", type=_sample_count, default=500,
                        help="samples for lease/read/policy operations (default: 500)")
    parser.add_argument("--write-samples", type=_sample_count, default=100,
                        help="samples for atomic writes and journal updates (default: 100)")
    parser.add_argument("--command-samples", type=_sample_count, default=30,
                        help="samples for shell process startup (default: 30)")
    parser.add_argument("--quick", action="store_true",
                        help="use 50 fast, 10 write, and 5 command samples")
    parser.add_argument("--json", action="store_true", help="emit compact JSON")
    args = parser.parse_args(argv)
    if args.quick:
        args.fast_samples, args.write_samples, args.command_samples = 50, 10, 5
    report = run_probe(fast_samples=args.fast_samples, write_samples=args.write_samples,
                       command_samples=args.command_samples)
    if args.json:
        print(json.dumps(report, separators=(",", ":"), sort_keys=True))
    else:
        print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
