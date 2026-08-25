#!/usr/bin/env python3
"""DGC polyglot benchmark runner.

Runs DGC *headless* (`dgc -p ... --mode auto`) over the Aider "polyglot"
benchmark (225 Exercism problems across C++, Go, Java, JavaScript, Python,
Rust) and scores each by running the exercise's REAL test suite.

Protocol (mirrors Aider's two-attempt structure):
  round 1  — a fresh DGC session implements the stub (it may read/edit/run
             tests itself, max_turns budget). Then we run the official tests.
  round 2  — only if round 1's official tests fail: continue the session
             (`dgc -c`) fed the exact failing test output, then re-test.
  solved@1 = passed after round 1;  solved@2 = passed by end of round 2.

Isolation: every DGC call runs under a throwaway $HOME, so the benchmark never
reads or writes your real ~/.dgc (config, sessions, skills, memory).

Usage:
  python3 run_bench.py --model qwen3.8:27b-q4km --out results/ --langs python --limit 3
  python3 run_bench.py --model qwen122b-code:latest --base-url http://localhost:11434/v1 --out results/
"""
from __future__ import annotations
import argparse, hashlib, json, os, platform, re, shlex, shutil, signal, subprocess, sys, tempfile, time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit
from urllib.request import urlopen

RESULT_SCHEMA_VERSION = 3
TRACE_LIMIT = 120_000


def _dec(x):        # subprocess bytes → str (TimeoutExpired.stdout is bytes even under text=True)
    return x.decode("utf-8", "replace") if isinstance(x, (bytes, bytearray)) else (x or "")


def _run_capture(argv, cwd, env, timeout, merge=False):
    """Run a command in its OWN process group and, on timeout, SIGKILL the whole tree — so a
    hung cmake/compiler (or a dgc-spawned build) can't survive as a CPU-eating orphan.
    Returns (returncode_or_None, stdout_str, stderr_str, timed_out)."""
    proc = subprocess.Popen(
        argv, cwd=cwd, env=env, text=True, start_new_session=True,
        stdout=subprocess.PIPE,
        stderr=(subprocess.STDOUT if merge else subprocess.PIPE))
    try:
        out, err = proc.communicate(timeout=timeout)
        return proc.returncode, _dec(out), _dec(err), False
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except Exception:
            try: proc.kill()
            except Exception: pass
        try:
            out, err = proc.communicate(timeout=10)
        except Exception:
            out, err = "", ""
        return None, _dec(out), _dec(err), True
    except BaseException:
        # Ctrl-C/SystemExit must not orphan a harness (or anything it spawned). The benchmark
        # launcher may be resumed, but an old model client/compiler/browser must never overlap it.
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
        try:
            proc.communicate(timeout=10)
        except Exception:
            pass
        raise

REPO = Path(__file__).resolve().parent
DATA = REPO / "data" / "polyglot-benchmark"
TOOLS = Path(os.environ.get("BENCH_TOOLS", str(Path.home() / "bench-tools"))).expanduser()
_LOCAL_DGC = REPO.parent / ".venv" / "bin" / "dgc"
DGC = os.environ.get("DGC_BIN") or (str(_LOCAL_DGC) if _LOCAL_DGC.exists() else (shutil.which("dgc") or "dgc"))

GO_BIN   = TOOLS / "go" / "bin"
JDK_HOME = TOOLS / "jdk21"
CARGO    = TOOLS / "cargo"
PYTEST   = TOOLS / "pyvenv" / "bin" / "pytest"

LANGS = ["cpp", "go", "java", "javascript", "python", "rust"]


# ---------------------------------------------------------------- exercises ---
def practice_dir(lang: str) -> Path:
    return DATA / lang / "exercises" / "practice"


def list_exercises(lang: str) -> list[str]:
    d = practice_dir(lang)
    return sorted(p.name for p in d.iterdir() if p.is_dir()) if d.exists() else []


def read_meta(exdir: Path) -> tuple[list[str], list[str]]:
    cfg = json.loads((exdir / ".meta" / "config.json").read_text())
    files = cfg.get("files", {})
    return files.get("solution", []), files.get("test", [])


def read_instructions(exdir: Path) -> str:
    parts = []
    for name in ("introduction.md", "instructions.md", "instructions.append.md"):
        f = exdir / ".docs" / name
        if f.exists():
            parts.append(f.read_text())
    return "\n\n".join(parts).strip()


def make_workdir(lang: str, ex: str) -> Path:
    """A unique temp parent with the leaf dir named EXACTLY after the exercise.
    Exercism's C++ CMakeLists derives the source filenames from the directory
    name, so the leaf must be `<exercise>`, not a random tempfile name."""
    parent = tempfile.mkdtemp(prefix=f"dgcb-{lang}-")
    return Path(parent) / ex


def prep_workdir(exdir: Path, dest: Path) -> Path:
    """Copy the exercise into a fresh dir, WITHOUT .meta (holds the reference
    solution) or .approaches (holds hints). Anchor DGC's project root here."""
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(exdir, dest, ignore=shutil.ignore_patterns(".meta", ".approaches"))
    (dest / ".dgc").mkdir(exist_ok=True)   # makes find_project_root() stop here
    return dest


def prep_grade_workdir(exdir: Path, work: Path, dest: Path, solution_files: list[str]) -> Path:
    """Build a clean official-test fixture and copy in ONLY the submitted solution files.

    The agent may alter tests, build manifests, or add helper files in its worktree. Grading a clean
    fixture prevents any of those changes from weakening the official tests or inflating a score.
    """
    prep_workdir(exdir, dest)
    for rel in solution_files:
        source, target = work / rel, dest / rel
        if source.is_file():
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
        elif target.exists():
            target.unlink()
    return dest


def _sha256_files(root: Path, paths: list[str]) -> str:
    digest = hashlib.sha256()
    for rel in sorted(paths):
        p = root / rel
        digest.update(rel.encode() + b"\0")
        if p.is_file():
            digest.update(p.read_bytes())
        else:
            digest.update(b"<missing>")
    return digest.hexdigest()


def _safe_base_url(value: str) -> str:
    """Keep endpoint provenance without ever recording embedded URL credentials."""
    p = urlsplit(value)
    host = p.hostname or ""
    if p.port:
        host += f":{p.port}"
    return urlunsplit((p.scheme, host, p.path, "", ""))


def _trace_record(stdout: str, stderr: str = "", secrets=()) -> dict:
    """Preserve useful killed/failed harness output without persisting credentials or unbounded logs."""
    def clean(value: str) -> tuple[str, str, int, bool]:
        value = _dec(value)
        for secret in secrets:
            if secret and len(str(secret)) >= 4:
                value = value.replace(str(secret), "[REDACTED]")
        value = re.sub(r"(?i)(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s\"']+",
                       r"\1[REDACTED]", value)
        digest = hashlib.sha256(value.encode("utf-8", "replace")).hexdigest()
        size = len(value)
        truncated = size > TRACE_LIMIT
        if truncated:
            half = TRACE_LIMIT // 2
            value = (value[:half] + f"\n… benchmark trace truncated ({size} chars total) …\n"
                     + value[-half:])
        return value, digest, size, truncated

    out, out_sha, out_chars, out_cut = clean(stdout)
    err, err_sha, err_chars, err_cut = clean(stderr)
    return {"stdout": out, "stderr": err, "stdout_sha256": out_sha, "stderr_sha256": err_sha,
            "stdout_chars": out_chars, "stderr_chars": err_chars,
            "truncated": out_cut or err_cut}


def _usage_log_mark(env: dict) -> tuple[Path, int] | None:
    raw = env.get("DGC_BENCH_USAGE_LOG") or os.environ.get("DGC_BENCH_USAGE_LOG")
    if not raw:
        return None
    path = Path(raw)
    try:
        return path, path.stat().st_size
    except OSError:
        return path, 0


def _usage_log_since(mark: tuple[Path, int] | None, env: dict | None = None) -> dict | None:
    """Sum provider-proxy usage appended since a round began."""
    if mark is None:
        return None
    control = (env or {}).get("DGC_BENCH_PROXY_CONTROL") or os.environ.get("DGC_BENCH_PROXY_CONTROL")
    synchronized = False
    if control:
        try:
            with urlopen(control, timeout=20) as response:
                synchronized = response.status == 204
        except OSError:
            synchronized = False
    path, offset = mark
    totals = {"input_tokens": 0, "output_tokens": 0, "reasoning_tokens": 0,
              "cached_input_tokens": 0, "requests": 0, "synchronized": synchronized}
    try:
        with path.open("r", encoding="utf-8") as stream:
            stream.seek(offset)
            lines = stream.readlines()
    except OSError:
        return totals
    for line in lines:
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not record.get("normalization"):
            continue
        usage = record.get("usage") or {}
        totals["requests"] += 1
        for key in ("input_tokens", "output_tokens", "reasoning_tokens", "cached_input_tokens"):
            totals[key] += max(0, int(usage.get(key, 0) or 0))
    return totals


def _sha256_path(path: str | Path | None) -> str | None:
    if not path:
        return None
    p = Path(path)
    if not p.is_file():
        return None
    digest = hashlib.sha256()
    with p.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _hardware() -> dict:
    memory = None
    try:
        memory = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
    except (AttributeError, OSError, ValueError):
        pass
    return {"python": platform.python_version(), "platform": platform.platform(),
            "machine": platform.machine(), "processor": platform.processor() or None,
            "cpu_count": os.cpu_count(), "memory_bytes": memory,
            "hardware_label": os.environ.get("DGC_BENCH_HARDWARE") or None,
            "accelerator": os.environ.get("DGC_BENCH_ACCELERATOR") or None}


def _git_revision(path: Path) -> dict:
    try:
        commit = subprocess.check_output(["git", "-C", str(path), "rev-parse", "HEAD"],
                                         text=True, stderr=subprocess.DEVNULL, timeout=5).strip()
        dirty = bool(subprocess.check_output(["git", "-C", str(path), "status", "--porcelain"],
                                             text=True, stderr=subprocess.DEVNULL, timeout=5).strip())
        return {"commit": commit, "dirty": dirty}
    except Exception:
        return {"commit": None, "dirty": None}


def build_manifest(a, langs: list[str], preflight: dict) -> dict:
    settings = {
        "engine": a.engine, "model": a.model,
        "base_url": _safe_base_url(os.environ.get("DGC_BENCH_PROVIDER_IDENTITY", a.base_url)),
        "model_digest": a.model_digest or None,
        "provider_capabilities": sorted(x.strip() for x in a.provider_capabilities.split(",") if x.strip()),
        "langs": langs, "limit": a.limit, "exercises": a.exercises, "rounds": a.rounds,
        "max_turns": a.max_turns, "agent_timeout_s": a.dgc_timeout,
        "test_timeout_s": a.test_timeout,
        "thinking": os.environ.get("DGC_BENCH_THINKING_POLICY", "harness-default"),
        "usage_source": os.environ.get("DGC_BENCH_USAGE_SOURCE", "harness-output-if-available"),
        "context_tokens": 32768, "home_isolation": "per-exercise",
        "round_two_context": "resume-harness-session",
    }
    runner, dataset = _git_revision(REPO.parent), _git_revision(DATA)
    evidence = {"settings": settings, "runner": runner, "dataset": dataset,
                "engine": preflight.get("engine", {})}
    fingerprint = hashlib.sha256(json.dumps(evidence, sort_keys=True).encode()).hexdigest()
    return {
        "schema_version": RESULT_SCHEMA_VERSION, "run_id": fingerprint[:16],
        "created_at": datetime.now(timezone.utc).isoformat(), "settings": settings,
        "runner": runner, "dataset": dataset, "environment": _hardware(), "preflight": preflight,
    }


# ------------------------------------------------------------------ prompts ---
PROMPT = """You are completing a programming exercise in the current directory.

Implement the solution by editing ONLY this/these file(s): {sol}
Do NOT modify the test file(s): {test}

Read the stub and the test file(s), then write a correct, complete
implementation that makes the ENTIRE test suite pass. You can compile and run
the tests yourself with:

    {testcmd}

The provided tests and expected values are authoritative and have already been validated against the
canonical reference solution. Do not dismiss a failing test as inconsistent, and do not hard-code a
single fixture. Re-read the relevant test/API and correct the general implementation.

Iterate until every test passes. Do not stop until the implementation is done.

=== EXERCISE ===
{instr}
"""

FIX_PROMPT = """The tests still fail. Here is the exact output of `{testcmd}`:

--- test output ---
{output}
--- end ---

The tests and expected values are authoritative and reference-validated. Do not dismiss them as
inconsistent or hard-code the displayed fixture. Preserve working code and the tested public API;
make the smallest focused correction implied by the diagnostics instead of broadly rewriting the
solution. Re-read the exact test declarations and current implementation, then fix {sol} so the
whole suite passes. Do not modify the tests."""


# -------------------------------------------------------------- environment ---
def bench_env() -> dict:
    """Env for running the *tests* — real toolchains on PATH. Uses the real
    HOME so gradle/npm/cargo build caches persist across exercises."""
    env = dict(os.environ)
    prefixes = [str(p) for p in (GO_BIN, CARGO / "bin", JDK_HOME / "bin") if p.is_dir()]
    env["PATH"] = os.pathsep.join([*prefixes, env.get("PATH", "")])
    if JDK_HOME.is_dir():
        env["JAVA_HOME"] = str(JDK_HOME)
    if CARGO.is_dir():
        env["CARGO_HOME"] = str(CARGO)
    if (TOOLS / "rustup").is_dir():
        env["RUSTUP_HOME"] = str(TOOLS / "rustup")
    env["GOTOOLCHAIN"] = "local"
    env["PYTHONDONTWRITEBYTECODE"] = "1"  # never dirty the vendored benchmark dataset with pyc files
    # `bench-tools/boost` may be a user-owned extraction of distro packages. This keeps the benchmark
    # hermetic and avoids requiring root while allowing CMake's FindBoost to locate headers/libs.
    boost = TOOLS / "boost" / "usr"
    if (boost / "include" / "boost").is_dir():
        lib_root = boost / "lib"
        lib_dir = next(iter(sorted(lib_root.glob("*-linux-gnu"))), lib_root)
        env["BOOST_ROOT"] = str(boost)
        env["BOOST_INCLUDEDIR"] = str(boost / "include")
        env["BOOST_LIBRARYDIR"] = str(lib_dir)
        env["CMAKE_PREFIX_PATH"] = os.pathsep.join(
            [str(boost), env.get("CMAKE_PREFIX_PATH", "")]).rstrip(os.pathsep)
        env["LD_LIBRARY_PATH"] = os.pathsep.join(
            [str(lib_dir), env.get("LD_LIBRARY_PATH", "")]).rstrip(os.pathsep)
    return env


def test_cmd_str(lang: str, ex: str) -> str:
    pytest_cmd = (shlex.quote(str(PYTEST)) if PYTEST.is_file()
                  else (shlex.quote(shutil.which("pytest")) if shutil.which("pytest")
                        else f"{shlex.quote(sys.executable)} -m pytest"))
    return {
        "python":     f"{pytest_cmd} -q",
        "go":         "go test ./...",
        "rust":       "cargo test -- --include-ignored",
        "javascript": "npm install --no-audit --no-fund --silent && npx jest",
        "cpp":        (f"cmake -B build -S . -DEXERCISM_RUN_ALL_TESTS=1 -DCMAKE_BUILD_TYPE=Debug >/dev/null "
                       f"&& cmake --build build -j 2>&1 | tail -40 && ./build/'{ex}'"),
        "java":       "./gradlew test --console=plain --offline || ./gradlew test --console=plain",
    }[lang]


def run_tests(lang: str, ex: str, workdir: Path, env: dict, timeout: int):
    cmd = test_cmd_str(lang, ex)
    t0 = time.time()
    rc, out, _err, timed_out = _run_capture(["bash", "-lc", cmd], workdir, env, timeout, merge=True)
    if timed_out:
        ok, out = False, f"[TEST TIMEOUT after {timeout}s]\n{out}"
    else:
        ok = (rc == 0)
    return ok, out[-6000:].strip(), round(time.time() - t0, 1)


def _resolve_command(value: str | Path, env: dict) -> str | None:
    raw = str(value)
    if os.path.sep in raw:
        return str(Path(raw).resolve()) if Path(raw).is_file() and os.access(raw, os.X_OK) else None
    return shutil.which(raw, path=env.get("PATH"))


def _command_version(path: str, env: dict) -> str:
    rc, out, err, timed_out = _run_capture([path, "--version"], REPO, env, 15, merge=False)
    text = (out or err).strip().splitlines()
    status = "timeout" if timed_out else f"exit-{rc}"
    return (text[0][:300] if text else status)


def preflight_environment(langs: list[str], engine: str, env: dict, dry_run: bool = False) -> dict:
    """Fail before spending model time when a dataset, harness, compiler, or shared C++ dep is absent."""
    unknown = sorted(set(langs) - set(LANGS))
    if unknown:
        raise RuntimeError(f"unknown benchmark language(s): {', '.join(unknown)}")
    tasks = {lang: len(list_exercises(lang)) for lang in langs}
    empty = [lang for lang, count in tasks.items() if not count]
    if empty:
        raise RuntimeError(f"benchmark dataset missing exercises for: {', '.join(empty)} (expected {DATA})")

    required = {
        "cpp": ["cmake", "g++"], "go": ["go"], "java": ["java"],
        "javascript": ["node", "npm"], "python": [str(PYTEST) if PYTEST.is_file() else "pytest"],
        "rust": ["cargo"],
    }
    resolved: dict[str, str] = {}
    missing = []
    for lang in langs:
        for command in required[lang]:
            key = Path(command).name
            if key in resolved:
                continue
            found = _resolve_command(command, env)
            if found:
                resolved[key] = found
            else:
                missing.append(f"{lang}:{command}")

    from engines import AIDER, CODEX, GOOSE, OPENCODE, PI
    engine_cmd = {"dgc": DGC, "aider": AIDER, "codex": CODEX, "goose": GOOSE,
                  "opencode": OPENCODE, "pi": PI}[engine]
    engine_path = _resolve_command(engine_cmd, env)
    if not dry_run and not engine_path:
        missing.append(f"engine:{engine_cmd}")
    if missing:
        raise RuntimeError("benchmark preflight missing executable(s): " + ", ".join(missing))

    # Two official C++ exercises require Boost date_time. Configure one before launching any model
    # rounds so a missing package is infrastructure failure, never a scored model failure.
    boost_probe = "not-selected"
    if "cpp" in langs:
        exdir = practice_dir("cpp") / "gigasecond"
        work = make_workdir("cpp", "gigasecond")
        prep_workdir(exdir, work)
        try:
            rc, out, err, timed_out = _run_capture(
                [resolved["cmake"], "-B", "build", "-S", ".", "-DEXERCISM_RUN_ALL_TESTS=1",
                 "-DCMAKE_BUILD_TYPE=Debug"], work, env, 45, merge=False)
        finally:
            shutil.rmtree(work.parent, ignore_errors=True)
        if timed_out or rc != 0:
            detail = (err or out)[-1200:].strip()
            raise RuntimeError("C++ preflight cannot configure Boost date_time: " + detail)
        boost_probe = "pass"

    tools = {name: {"path": path, "version": _command_version(path, env),
                    "sha256": _sha256_path(path)} for name, path in sorted(resolved.items())}
    engine_meta = ({"path": engine_path, "version": _command_version(engine_path, env),
                    "sha256": _sha256_path(engine_path)} if engine_path else
                   {"path": None, "version": "dry-run", "sha256": None})
    return {"status": "pass", "tasks": tasks, "tools": tools,
            "engine": engine_meta, "boost_date_time": boost_probe}


# ---------------------------------------------------------------------- DGC ---
def seed_home(home: Path, model: str, base_url: str, api_key: str, max_turns: int = 40,
              turn_budget_s: int = 0, verify_command: str = "") -> None:
    home.mkdir(parents=True, exist_ok=True)
    try:
        home.chmod(0o700)
    except OSError:
        pass
    d = home / ".dgc"
    d.mkdir(parents=True, exist_ok=True)
    try:
        d.chmod(0o700)
    except OSError:
        pass
    external_budget = max(0, int(turn_budget_s))
    # The benchmark's timeout is a hard process-group SIGKILL. Give DGC a small earlier deadline so
    # its cancellation/finally path can restore snapshots and atomically persist the session before
    # the supervisor fires. Fifteen seconds is enough for local cleanup while preserving 98.75% of
    # a 1,200-second model round; scale down for tiny diagnostics.
    cleanup_reserve = min(15, max(1, external_budget // 10)) if external_budget else 0
    internal_budget = max(1, external_budget - cleanup_reserve) if external_budget else 0
    cfg = {
        "base_url": base_url, "api_key": api_key, "model": model, "mode": "auto",
        "thinking": "off", "suggest": False, "logo_animation": False,
        "artifact_autostart": False, "background": "inherit",
        "show_reasoning": False, "max_turns": max_turns, "context_size": 32768,
        # Let DGC stop and persist the last verified state before the external process-group kill.
        # AgentRuntime reserves the final 6% of this budget for graceful convergence/restore.
        "turn_budget_s": internal_budget,
        # If the model tries to stop after a partial/failing self-test, DGC runs the exact official
        # command and feeds the failure back before allowing the turn to end. This is bounded by the
        # agent's existing two-attempt verification gate and outer wall-clock deadline.
        "verify_before_done": bool(verify_command),
        "verify_command": str(verify_command or ""),
        # a single stalled stream shouldn't eat the whole 600s budget: the default read timeout is
        # 1800s (3× the wall). Fail a stall fast instead. (The happy path never nears 300s.)
        "request_timeout": 300,
    }
    path = d / "config.json"
    path.write_text(json.dumps(cfg, indent=2))
    try:
        path.chmod(0o600)
    except OSError:
        pass


def dgc_run(prompt: str, workdir: Path, model: str, base_url: str, api_key: str,
            home: Path, cont: bool, timeout: int, env: dict) -> dict:
    args = [DGC]
    if cont:
        args += ["-c"]
    # Model configuration is already in the isolated HOME. Keep credentials out of process argv.
    args += ["-p", prompt, "--mode", "auto", "--trust"]
    e = dict(env)
    e["HOME"] = str(home)          # <-- isolation: DGC reads/writes this ~/.dgc only
    t0 = time.time()
    rc, out, err, timed_out = _run_capture(args, workdir, e, timeout, merge=False)
    trace = _trace_record(out, err, (api_key,))
    if timed_out:                  # SIGKILLs dgc AND every build it spawned (no orphans)
        return {"rc": None, "time": round(time.time() - t0, 1), "timeout": True,
                "exit_reason": "timeout", "trace": trace,
                "output_tail": trace["stdout"][-2000:], "stderr_tail": "[DGC TIMEOUT]"}
    return {"rc": rc, "time": round(time.time() - t0, 1), "timeout": False,
            "exit_reason": "completed" if rc == 0 else "nonzero_exit", "trace": trace,
            "output_tail": trace["stdout"][-2000:], "stderr_tail": trace["stderr"][-1200:]}


def session_stats(home: Path, work: Path | None = None) -> dict:
    """Parse monotonic DGC activity/usage for THIS exercise. Best-effort — never raises.

    A timed-out run is SIGKILLed before DGC can persist its full transcript, so schema-v5+ agents
    also maintain a small atomic ``.metrics`` journal after each completed request/tool call.  Read
    the newest transcript/journal pair and merge monotonic counters.  Scoping to this exercise's
    sessions/<slug>/ directory prevents attribution from another task.  Schema <=4 transcripts did
    not persist activity, so only those use transcript reconstruction."""
    try:
        sess_root = home / ".dgc" / "sessions"
        if work is not None:                        # scope to this exercise's project slug (matches
            slug = re.sub(r"[^a-zA-Z0-9]+", "-", str(work)).strip("-").lower()[-70:] or "root"
            sess_root = sess_root / slug            #   dgc/sessions.py:_slug)
        transcripts = list(sess_root.rglob("*.json")) if sess_root.exists() else []
        journals = list(sess_root.rglob("*.metrics")) if sess_root.exists() else []
        sessions = {p.with_suffix(".json") for p in transcripts}
        sessions.update(p.with_suffix(".json") for p in journals)
        if not sessions:
            return {}
        def _latest_mtime(p: Path) -> float:
            candidates = (p, p.with_suffix(".metrics"))
            return max((candidate.stat().st_mtime for candidate in candidates if candidate.exists()),
                       default=0.0)
        newest = max(sessions, key=_latest_mtime)
        data = json.loads(newest.read_text()) if newest.exists() else {}
        journal_path = newest.with_suffix(".metrics")
        journal = json.loads(journal_path.read_text()) if journal_path.exists() else {}
        if not isinstance(data, dict):
            data = {}
        if not isinstance(journal, dict):
            journal = {}
        usage = data.get("usage", {}) if isinstance(data, dict) else {}
        msgs = data.get("messages", []) if isinstance(data, dict) else data
        activity = data.get("activity") if isinstance(data, dict) else None
        journal_usage = journal.get("usage") if isinstance(journal.get("usage"), dict) else {}
        journal_activity = (journal.get("activity")
                            if isinstance(journal.get("activity"), dict) else None)
        if isinstance(activity, dict) or isinstance(journal_activity, dict):
            activity = activity if isinstance(activity, dict) else {}
            journal_activity = journal_activity if isinstance(journal_activity, dict) else {}
            tool_calls = max(0, int(activity.get("tool_calls", 0) or 0),
                             int(journal_activity.get("tool_calls", 0) or 0))
            edits = max(0, int(activity.get("edits", 0) or 0),
                        int(journal_activity.get("edits", 0) or 0))
            edit_fail = max(0, int(activity.get("edit_fails", 0) or 0),
                            int(journal_activity.get("edit_fails", 0) or 0))
        else:                                      # legacy, necessarily compaction-sensitive
            tool_calls = edits = edit_fail = 0
            for m in msgs:
                if m.get("role") == "assistant":
                    for c in (m.get("tool_calls") or []):
                        tool_calls += 1
                        fn = (c.get("function") or {}).get("name", "")
                        if fn == "edit_file":
                            edits += 1
                if m.get("role") == "tool":
                    txt = str(m.get("content", ""))
                    if re.search(r"not found|no exact match|appears \d+ times|ambiguous|match.*exactly", txt, re.I):
                        edit_fail += 1
        return {"tool_calls": tool_calls, "edits": edits, "edit_fails": edit_fail,
                "input_tokens": max(0, int(usage.get("input_tokens", 0) or 0),
                                    int(journal_usage.get("input_tokens", 0) or 0)),
                "output_tokens": max(0, int(usage.get("output_tokens", 0) or 0),
                                     int(journal_usage.get("output_tokens", 0) or 0)),
                "requests": max(0, int(usage.get("requests", 0) or 0),
                                int(journal_usage.get("requests", 0) or 0))}
    except Exception as e:      # noqa
        return {"stats_error": str(e)[:200]}


# ---------------------------------------------------------------- one run -----
def run_one(lang: str, ex: str, a, home: Path, env: dict, run_id: str = "") -> dict:
    exdir = practice_dir(lang) / ex
    sol, test = read_meta(exdir)
    instr = read_instructions(exdir)
    tcmd = test_cmd_str(lang, ex)
    prompt = PROMPT.format(sol=", ".join(sol) or "(the solution file)",
                           test=", ".join(test) or "(the test file)",
                           testcmd=tcmd, instr=instr)
    inputs = sol + test + [str(p.relative_to(exdir)) for p in (exdir / ".docs").glob("*.md")]
    rec = {"schema_version": RESULT_SCHEMA_VERSION, "run_id": run_id, "engine": a.engine,
           "lang": lang, "ex": ex, "model": a.model, "input_sha256": _sha256_files(exdir, inputs),
           "sol": sol, "test": test, "rounds": []}

    if a.dry_run:
        rec["dry_run"] = {"testcmd": tcmd, "prompt_head": prompt[:600]}
        return rec

    # Every exercise gets a private HOME. This prevents model/config/session state from one task
    # leaking into another while preserving the same harness session across round 1 and round 2.
    exercise_home = home / lang / ex
    seed_home(exercise_home, a.model, a.base_url, a.api_key, a.max_turns, a.dgc_timeout, tcmd)
    work = make_workdir(lang, ex)
    prep_workdir(exdir, work)
    solved = False
    last_out = ""
    prior_stats: dict = {}
    from engines import ENGINES
    engine = ENGINES[a.engine]
    for r in range(1, a.rounds + 1):
        usage_mark = _usage_log_mark(env)
        if r == 1:
            run = engine(prompt, work, sol, tcmd, a, exercise_home, False, env)
        else:
            fp = FIX_PROMPT.format(testcmd=tcmd, output=last_out[-3500:], sol=", ".join(sol))
            run = engine(fp, work, sol, tcmd, a, exercise_home, True, env)
        proxy_usage = _usage_log_since(usage_mark, env)
        if proxy_usage is not None:
            run["usage"] = proxy_usage
        grade = make_workdir(lang, ex)
        prep_grade_workdir(exdir, work, grade, sol)
        try:
            ok, out, ttime = run_tests(lang, ex, grade, env, a.test_timeout)
            solution_sha = _sha256_files(grade, sol)
            tests_sha = _sha256_files(grade, test)
        finally:
            shutil.rmtree(grade.parent, ignore_errors=True)
        last_out = out
        # session_stats only applies to DGC's own session dir; other engines have none.
        cumulative = session_stats(exercise_home, work) if a.engine == "dgc" else {}
        stats = {}
        for key, value in cumulative.items():
            if isinstance(value, int):
                stats[key] = max(0, value - int(prior_stats.get(key, 0) or 0))
            else:
                stats[key] = value
        prior_stats = cumulative
        if "usage" not in run and a.engine == "dgc" and cumulative:
            run["usage"] = {key: stats.get(key, 0)
                            for key in ("input_tokens", "output_tokens", "requests")}
        rec["rounds"].append({"round": r, "agent": run, "stats": stats,
                              "grader_isolated": True, "solution_sha256": solution_sha,
                              "tests_sha256": tests_sha, "test_pass": ok,
                              "test_time": ttime, "test_tail": out[-1200:]})
        if ok:
            solved = True
            rec["solved_round"] = r
            break
    rec["solved"] = solved
    if not a.keep_work:
        shutil.rmtree(work.parent, ignore_errors=True)
    else:
        rec["workdir"] = str(work)
    return rec


def aggregate(jsonl_path: Path) -> dict:
    """Read a results jsonl and compute per-language + overall pass@1/pass@2,
    plus timing and edit-failure stats. The source of truth for publishing."""
    per: dict[str, dict] = {}
    for line in Path(jsonl_path).read_text().splitlines():
        try:
            r = json.loads(line)
        except Exception:
            continue
        if r.get("dry_run"):
            continue
        p = per.setdefault(r["lang"], {"n": 0, "p1": 0, "p2": 0, "agent_s": 0.0,
                                       "edit_fails": 0, "timeouts": 0, "input_tokens": 0,
                                       "output_tokens": 0, "reasoning_tokens": 0,
                                       "usage_rounds": 0, "rounds": 0})
        p["n"] += 1
        if r.get("solved") and r.get("solved_round") == 1:
            p["p1"] += 1
        if r.get("solved"):
            p["p2"] += 1
        for rd in r.get("rounds", []):
            agent_run = rd.get("agent") or rd.get("dgc") or {}  # schema-v1 compatibility
            p["rounds"] += 1
            p["agent_s"] += agent_run.get("time", 0) or 0
            if agent_run.get("timeout"):
                p["timeouts"] += 1
            p["edit_fails"] += (rd.get("stats") or {}).get("edit_fails", 0) or 0
            if (isinstance(agent_run.get("usage"), dict)
                    and int(agent_run["usage"].get("requests", 0) or 0) > 0
                    and agent_run["usage"].get("synchronized", True) is not False):
                usage = agent_run["usage"]
                p["usage_rounds"] += 1
                for key in ("input_tokens", "output_tokens", "reasoning_tokens"):
                    p[key] += max(0, int(usage.get(key, 0) or 0))
    return per


def print_report(jsonl_path: Path, langs: list[str] | None = None) -> None:
    per = aggregate(jsonl_path)
    order = langs or sorted(per)
    tot = {"n": 0, "p1": 0, "p2": 0, "agent_s": 0.0, "edit_fails": 0,
           "timeouts": 0, "input_tokens": 0, "output_tokens": 0,
           "reasoning_tokens": 0, "usage_rounds": 0, "rounds": 0}
    print(f"\n==== {Path(jsonl_path).name} ====")
    print(f"{'lang':11s} {'n':>4} {'pass@1':>14} {'pass@2':>14} {'avg_s':>7} "
          f"{'avg_out':>9} {'editfail':>8} {'t/o':>4}")
    for lang in order:
        p = per.get(lang)
        if not p:
            continue
        for k in tot:
            tot[k] += p[k]
        avg = p["agent_s"] / p["n"] if p["n"] else 0
        avg_out = (str(round(p["output_tokens"] / p["n"]))
                   if p["usage_rounds"] == p["rounds"] else "?")
        print(f"{lang:11s} {p['n']:4d} {p['p1']:4d} ({100*p['p1']/p['n']:5.1f}%) "
              f"{p['p2']:4d} ({100*p['p2']/p['n']:5.1f}%) {avg:7.0f} "
              f"{avg_out:>9} {p['edit_fails']:8d} {p['timeouts']:4d}")
    if tot["n"]:
        avg = tot["agent_s"] / tot["n"]
        avg_out = (str(round(tot["output_tokens"] / tot["n"]))
                   if tot["usage_rounds"] == tot["rounds"] else "?")
        print(f"{'TOTAL':11s} {tot['n']:4d} {tot['p1']:4d} ({100*tot['p1']/tot['n']:5.1f}%) "
              f"{tot['p2']:4d} ({100*tot['p2']/tot['n']:5.1f}%) {avg:7.0f} "
              f"{avg_out:>9} {tot['edit_fails']:8d} {tot['timeouts']:4d}")


def summary_line(rec: dict) -> str:
    if rec.get("dry_run"):
        return f"[dry] {rec['lang']}/{rec['ex']}  test: {rec['dry_run']['testcmd'][:70]}"
    mark = "✅" if rec["solved"] else "❌"
    rnd = rec.get("solved_round", "-")
    t = sum((x.get("agent") or x.get("dgc") or {}).get("time", 0) for x in rec["rounds"])
    st = rec["rounds"][-1].get("stats", {}) if rec["rounds"] else {}
    ef = st.get("edit_fails", "?")
    usages = [(rd.get("agent") or rd.get("dgc") or {}).get("usage") for rd in rec["rounds"]]
    out_tokens = (sum(int((usage or {}).get("output_tokens", 0) or 0) for usage in usages)
                  if usages and all(isinstance(usage, dict)
                                    and int(usage.get("requests", 0) or 0) > 0
                                    and usage.get("synchronized", True) is not False
                                    for usage in usages) else None)
    token_text = f"  out={out_tokens}" if out_tokens is not None else ""
    return f"{mark} {rec['lang']}/{rec['ex']}  solved@{rnd}  {t:.0f}s{token_text}  editfail={ef}"


# ------------------------------------------------------------------- main -----
def main() -> None:
    ap = argparse.ArgumentParser(allow_abbrev=False)
    ap.add_argument("--model", required=True)
    ap.add_argument("--engine", default="dgc",
                    choices=["dgc", "aider", "codex", "goose", "opencode", "pi"],
                    help="which coding harness to drive (all on the same model + tasks + scoring)")
    ap.add_argument("--base-url", default="http://localhost:11434/v1")
    ap.add_argument("--api-key-env", metavar="NAME",
                    help="read the endpoint key from environment variable NAME; defaults to "
                         "DGC_BENCH_API_KEY or the local-endpoint placeholder 'ollama'")
    ap.add_argument("--model-digest", default=os.environ.get("DGC_BENCH_MODEL_DIGEST", ""),
                    help="immutable model weight/build digest recorded in provenance")
    ap.add_argument("--provider-capabilities", default=os.environ.get("DGC_BENCH_CAPABILITIES", ""),
                    help="comma-separated endpoint capabilities recorded in provenance")
    ap.add_argument("--langs", default="all", help="'all' or comma list of: " + ",".join(LANGS))
    ap.add_argument("-n", "--limit", type=int, default=0, help="cap exercises per language (0=all)")
    ap.add_argument("--exercises", default="", help="explicit comma list (use with a single --langs)")
    ap.add_argument("--rounds", type=int, default=2)
    ap.add_argument("--max-turns", type=int, default=40, help="DGC tool-use iterations per session")
    ap.add_argument("--dgc-timeout", type=int, default=600)
    ap.add_argument("--test-timeout", type=int, default=300)
    ap.add_argument("--out", required=True)
    ap.add_argument("--tag", default="")
    ap.add_argument("--dry-run", action="store_true", help="print prompt+test cmd, don't call DGC")
    ap.add_argument("--keep-work", action="store_true", help="keep per-exercise workdirs")
    ap.add_argument("--redo", action="store_true", help="re-run exercises already in the results jsonl")
    a = ap.parse_args()
    if a.api_key_env:
        if a.api_key_env not in os.environ:
            ap.error(f"environment variable {a.api_key_env!r} is not set")
        a.api_key = os.environ[a.api_key_env]
    else:
        a.api_key = os.environ.get("DGC_BENCH_API_KEY", "ollama")

    langs = LANGS if a.langs == "all" else [l.strip() for l in a.langs.split(",") if l.strip()]
    if a.exercises and len(langs) != 1:
        ap.error("--exercises requires exactly one selected language")
    env = bench_env()
    try:
        preflight = preflight_environment(langs, a.engine, env, dry_run=a.dry_run)
    except RuntimeError as exc:
        ap.error(str(exc))
    outdir = Path(a.out)
    outdir.mkdir(parents=True, exist_ok=True)
    safe_model = re.sub(r"[^A-Za-z0-9._-]", "_", a.model)
    stem = f"{a.engine}-{safe_model}{('-' + a.tag) if a.tag else ''}"
    jsonl_path = outdir / f"results-{stem}.jsonl"
    manifest_path = outdir / f"manifest-{stem}.json"
    manifest = build_manifest(a, langs, preflight)
    if manifest_path.exists() and jsonl_path.exists():
        old_manifest = json.loads(manifest_path.read_text())
        if old_manifest.get("run_id") != manifest["run_id"]:
            ap.error(f"existing results have different settings ({manifest_path}); use a new --tag")
        manifest = old_manifest
    else:
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    done: set[tuple[str, str]] = set()
    if jsonl_path.exists() and not a.redo:
        for line in jsonl_path.read_text().splitlines():
            try:
                r = json.loads(line)
                done.add((r["lang"], r["ex"]))
            except Exception:
                pass
        if done:
            print(f"# resuming: {len(done)} exercises already done, will skip them\n")
    jf = open(jsonl_path, "a")

    home = Path(tempfile.mkdtemp(prefix="dgc-bench-home-"))
    print(f"# engine={a.engine}  model={a.model}  base={_safe_base_url(a.base_url)}")
    print(f"# preflight=pass  tasks={sum(preflight['tasks'].values())}  "
          f"engine={preflight['engine'].get('version')}\n"
          f"# run_id={manifest['run_id']}  HOME(isolated)={home}\n# results -> {jsonl_path}\n")

    started = time.time()
    for lang in langs:
        exs = ([e.strip() for e in a.exercises.split(",") if e.strip()]
               if a.exercises else list_exercises(lang))
        if a.limit:
            exs = exs[:a.limit]
        for ex in exs:
            if (lang, ex) in done:
                continue
            try:
                rec = run_one(lang, ex, a, home, env, manifest["run_id"])
            except Exception as e:                       # never let one exercise kill the whole run
                import traceback
                rec = {"schema_version": RESULT_SCHEMA_VERSION, "run_id": manifest["run_id"],
                       "engine": a.engine, "lang": lang, "ex": ex, "model": a.model,
                       "solved": False, "rounds": [],
                       "error": f"{type(e).__name__}: {e}", "trace": traceback.format_exc()[-1500:]}
                print(f"‼ {lang}/{ex} errored: {e}", flush=True)
            jf.write(json.dumps(rec) + "\n"); jf.flush()
            print(summary_line(rec), flush=True)
    jf.close()

    if not a.dry_run:
        print_report(jsonl_path, langs)                      # aggregates the FULL jsonl
        print(f"wall this run: {(time.time()-started)/60:.1f} min")
        (outdir / f"summary-{stem}.json").write_text(
            json.dumps({"schema_version": RESULT_SCHEMA_VERSION, "run_id": manifest["run_id"],
                        "engine": a.engine, "model": a.model,
                        "aggregate": aggregate(jsonl_path)}, indent=2) + "\n")
    shutil.rmtree(home, ignore_errors=True)


if __name__ == "__main__":
    main()
