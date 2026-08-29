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
  python3 run_bench.py --model qwen3.8-bench-64k --context-size 65536 \
    --out results/ --langs python --limit 3
  python3 run_bench.py --model qwen122b-code-bench --context-size 65536 \
    --base-url http://localhost:11434/v1 --out results/
"""
from __future__ import annotations
import argparse, hashlib, json, math, os, platform, re, shlex, shutil, signal, subprocess, sys, tempfile, time
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlsplit, urlunsplit
from urllib.request import Request, urlopen

RESULT_SCHEMA_VERSION = 3
TRACE_LIMIT = 120_000
MODEL_METADATA_LIMIT = 2 * 1024 * 1024
EXPECTED_PROVIDER_TRANSPORTS = {
    "dgc": "ollama_chat", "goose": "ollama_chat", "codex": "responses",
    "aider": "chat_completions", "opencode": "chat_completions", "pi": "chat_completions",
}
_PROVIDER_TRANSPORTS = frozenset(EXPECTED_PROVIDER_TRANSPORTS.values())
_REQUEST_REASON_LABELS = frozenset({
    "user_turn", "tool_result", "steering", "output_continue", "tool_reissue",
    "todo_gate", "empty_final", "goal_gate", "verifier_evidence", "convergence_nudge",
    "transport_retry", "context_retry", "provider_pause", "fallback", "title", "suggestion",
    "handoff",
    "compaction", "mcp_sampling", "subagent", "unattributed", "other",
})


class UsageSynchronizationError(RuntimeError):
    """Provider activity did not drain, so offset-based round attribution is unsafe."""


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


def provider_context_preflight(base_url: str, model: str, api_key: str,
                               requested: int) -> dict:
    """Verify a baked Ollama context so every transport uses the same model allocation.

    OpenAI-compatible requests cannot set Ollama's ``num_ctx``. A publishable league therefore
    uses a dedicated model alias whose Modelfile declares the context, while the proxy pins native
    requests to the same value. Metadata is bounded and never includes the key or model body.
    """
    try:
        expected = int(requested or 0)
    except (TypeError, ValueError, OverflowError):
        expected = 0
    result = {"status": "unverified", "source": "ollama_show",
              "requested_context": expected, "configured_context": 0,
              "model_context_limit": 0}
    if not 2_048 <= expected <= 10_000_000:
        result["error"] = "set --context-size to 2048..10000000"
        return result
    parsed = urlsplit(str(base_url).rstrip("/"))
    if (parsed.scheme not in ("http", "https") or not parsed.hostname
            or parsed.username is not None or parsed.password is not None):
        result["status"] = "failed"
        result["error"] = "provider endpoint must be http(s) without embedded credentials"
        return result
    root_path = parsed.path.rstrip("/")
    if root_path.lower().endswith("/v1"):
        root_path = root_path[:-3]
    endpoint = urlunsplit((parsed.scheme, parsed.netloc, root_path + "/api/show", "", ""))
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    request = Request(endpoint, data=json.dumps({"model": model, "verbose": False}).encode(),
                      headers=headers, method="POST")
    try:
        with urlopen(request, timeout=10) as response:
            body = response.read(MODEL_METADATA_LIMIT + 1)
        if len(body) > MODEL_METADATA_LIMIT:
            result["status"], result["error"] = "failed", "model metadata exceeded 2 MiB"
            return result
        value = json.loads(body.decode("utf-8"))
    except Exception as exc:
        result["status"] = "failed"
        result["error"] = f"model metadata unavailable ({type(exc).__name__})"
        return result
    if not isinstance(value, dict):
        result["status"], result["error"] = "failed", "model metadata had an invalid shape"
        return result
    parameters = value.get("parameters")
    match = (re.search(r"(?im)^\s*num_ctx\s+(\d+)\s*$", parameters)
             if isinstance(parameters, str) and len(parameters) <= 64_000 else None)
    configured = int(match.group(1)) if match else 0
    info = value.get("model_info") if isinstance(value.get("model_info"), dict) else {}
    limits = []
    for index, (key, raw) in enumerate(info.items()):
        if index >= 4_096:
            break
        normalized = str(key).lower()
        if (not normalized.endswith(".context_length")
                or ".vision." in normalized or ".mm." in normalized):
            continue
        try:
            limit = int(raw)
        except (TypeError, ValueError, OverflowError):
            continue
        if 0 < limit <= 10_000_000:
            limits.append(limit)
    trained = max(limits, default=0)
    result.update(configured_context=configured, model_context_limit=trained)
    if configured != expected:
        result["status"] = "failed"
        result["error"] = (f"model alias declares num_ctx={configured or 'none'}, "
                           f"expected {expected}")
    elif trained and expected > trained:
        result["status"] = "failed"
        result["error"] = f"requested context {expected} exceeds model limit {trained}"
    else:
        result["status"] = "pass"
    return result


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


def _wait_usage_quiescent(control: str, timeout: float) -> bool:
    """Wait until requests predating the barrier have produced their usage records.

    The proxy deliberately drains an Ollama stream after a deadline-cancelled harness disconnects,
    because the final event contains authoritative usage. Such a request can outlive the harness by
    minutes. Repeated 503 responses mean "still draining"; any other transport failure means the
    evidence channel itself is unavailable and should fail closed.
    """
    deadline = time.monotonic() + max(1.0, float(timeout))
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return False
        try:
            with urlopen(control, timeout=max(1.0, min(20.0, remaining))) as response:
                if response.status == 204:
                    return True
                if response.status != 503:
                    return False
        except HTTPError as exc:
            code = exc.code
            exc.close()
            if code != 503:
                return False
        except OSError:
            return False
        time.sleep(min(0.25, max(0.0, deadline - time.monotonic())))


def _usage_log_since(mark: tuple[Path, int] | None, env: dict | None = None) -> dict | None:
    """Sum provider-proxy usage appended since a round began."""
    if mark is None:
        return None
    control = (env or {}).get("DGC_BENCH_PROXY_CONTROL") or os.environ.get("DGC_BENCH_PROXY_CONTROL")
    synchronized = False
    if control:
        values = env or {}
        try:
            sync_timeout = float(values.get("DGC_BENCH_USAGE_SYNC_TIMEOUT")
                                 or os.environ.get("DGC_BENCH_USAGE_SYNC_TIMEOUT") or 1860)
        except (TypeError, ValueError):
            sync_timeout = 1860
        synchronized = _wait_usage_quiescent(control, sync_timeout)
        if not synchronized:
            raise UsageSynchronizationError(
                f"provider usage did not become quiescent within {sync_timeout:g}s; "
                "aborting before a late request can be attributed to the next round")
    path, offset = mark
    totals = {"input_tokens": 0, "output_tokens": 0, "reasoning_tokens": 0,
              "cached_input_tokens": 0, "requests": 0,
              "client_disconnected_requests": 0, "provider_duration_s": 0.0,
              "provider_wall_s": 0.0, "provider_max_duration_s": 0.0,
              "provider_transports": {},
              "synchronized": synchronized}
    try:
        with path.open("r", encoding="utf-8") as stream:
            stream.seek(offset)
            lines = stream.readlines()
    except OSError:
        return totals
    provider_intervals: list[tuple[float, float]] = []

    def finite_float(value) -> float:
        try:
            parsed = float(value or 0.0)
        except (TypeError, ValueError):
            return 0.0
        return parsed if math.isfinite(parsed) else 0.0

    for line in lines:
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not record.get("normalization"):
            continue
        duration = max(0.0, finite_float(record.get("duration_s")))
        finished = finite_float(record.get("time"))
        started = finite_float(record.get("started_at"))
        totals["provider_duration_s"] += duration
        totals["provider_max_duration_s"] = max(
            totals["provider_max_duration_s"], duration)
        if duration > 0 and started > 0:
            provider_intervals.append((started, started + duration))
        elif duration > 0 and finished > 0:  # compatibility with earlier proxy logs
            provider_intervals.append((finished - duration, finished))
        usage = record.get("usage") if isinstance(record.get("usage"), dict) else {}
        totals["requests"] += 1
        transport = str(record.get("transport") or "")
        if transport in _PROVIDER_TRANSPORTS:
            transports = totals["provider_transports"]
            transports[transport] = transports.get(transport, 0) + 1
        if record.get("client_disconnected") is True:
            totals["client_disconnected_requests"] += 1
        for key in ("input_tokens", "output_tokens", "reasoning_tokens", "cached_input_tokens"):
            totals[key] += max(0, int(usage.get(key, 0) or 0))
    merged: list[list[float]] = []
    for start, end in sorted(provider_intervals):
        if not merged or start > merged[-1][1]:
            merged.append([start, end])
        else:
            merged[-1][1] = max(merged[-1][1], end)
    totals["provider_duration_s"] = round(totals["provider_duration_s"], 3)
    totals["provider_wall_s"] = round(sum(end - start for start, end in merged), 3)
    totals["provider_max_duration_s"] = round(totals["provider_max_duration_s"], 3)
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
        "context_tokens": int(a.context_size or 0),
        "context_policy": "baked-model-alias+native-proxy",
        "home_isolation": "per-exercise",
        "round_two_context": "resume-harness-session",
    }
    runner, dataset = _git_revision(REPO.parent), _git_revision(DATA)
    evidence = {"settings": settings, "runner": runner, "dataset": dataset,
                "engine": preflight.get("engine", {}),
                "provider_transport": EXPECTED_PROVIDER_TRANSPORTS.get(a.engine)}
    fingerprint = hashlib.sha256(json.dumps(evidence, sort_keys=True).encode()).hexdigest()
    return {
        "schema_version": RESULT_SCHEMA_VERSION, "run_id": fingerprint[:16],
        "created_at": datetime.now(timezone.utc).isoformat(), "settings": settings,
        "provider_transport": EXPECTED_PROVIDER_TRANSPORTS.get(a.engine),
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

FIX_PROMPT = """The tests still fail. Here is the path-normalized output of `{testcmd}`. Paths
beginning with `./` refer to files in the current exercise directory:

--- test output ---
{output}
--- end ---

The tests and expected values are authoritative and reference-validated. Do not dismiss them as
inconsistent or hard-code the displayed fixture. Preserve working code and the tested public API;
make the smallest focused correction implied by the diagnostics instead of broadly rewriting the
solution. Re-read the exact test declarations and current implementation, then fix {sol} so the
whole suite passes. Do not modify the tests."""


def _portable_grader_output(output: str, grade: Path) -> str:
    """Replace the disposable isolated-grader root with a path valid in the agent worktree.

    Grading happens in a clean copy that is deleted before round two. Compiler diagnostics often
    contain its absolute path; feeding that path back makes a harness chase a nonexistent file and
    distrust the real test. The diagnostic contents and line numbers remain unchanged.
    """
    candidates = {str(grade), grade.as_posix()}
    try:
        resolved = grade.resolve()
        candidates.update((str(resolved), resolved.as_posix()))
    except OSError:
        pass
    mapped = str(output or "")
    for candidate in sorted((value for value in candidates if value), key=len, reverse=True):
        mapped = mapped.replace(candidate, ".")
    return mapped


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
              turn_budget_s: int = 0, verify_command: str = "",
              context_size: int = 32768) -> None:
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
        # The controlled provider is an Ollama origin behind a loopback accounting proxy. Its URL
        # cannot identify the upstream family, so auto mode would silently benchmark generic Chat
        # Completions instead of DGC's native local-model transport.
        "api_mode": "ollama",
        "thinking": "off", "suggest": False, "logo_animation": False,
        "artifact_autostart": False, "background": "inherit",
        "show_reasoning": False, "max_turns": max_turns,
        "context_size": max(2_048, int(context_size)),
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
        transcript_has_timing = isinstance(data.get("timing"), dict)
        timing = data.get("timing") if transcript_has_timing else {}
        journal_usage = journal.get("usage") if isinstance(journal.get("usage"), dict) else {}
        journal_activity = (journal.get("activity")
                            if isinstance(journal.get("activity"), dict) else None)
        journal_has_timing = isinstance(journal.get("timing"), dict)
        journal_timing = journal.get("timing") if journal_has_timing else {}
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
        def timing_counter(value) -> int:
            try:
                return min((1 << 63) - 1, max(0, int(value or 0)))
            except (OverflowError, TypeError, ValueError):
                return 0

        def timing_scalar(key: str) -> int:
            return max(timing_counter(timing.get(key)),
                       timing_counter(journal_timing.get(key)))

        def timing_map(key: str) -> dict[str, int]:
            left = timing.get(key) if isinstance(timing.get(key), dict) else {}
            right = (journal_timing.get(key)
                     if isinstance(journal_timing.get(key), dict) else {})
            names = {str(name) for name in left} | {str(name) for name in right}
            valid_names = [name for name in sorted(names)
                           if re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", name)
                           and (key != "by_request_reason"
                                or name in _REQUEST_REASON_LABELS)][:64]
            return {
                name: max(timing_counter(left.get(name)), timing_counter(right.get(name)))
                for name in valid_names
            }

        stats = {"tool_calls": tool_calls, "edits": edits, "edit_fails": edit_fail,
                 "input_tokens": max(0, int(usage.get("input_tokens", 0) or 0),
                                     int(journal_usage.get("input_tokens", 0) or 0)),
                 "output_tokens": max(0, int(usage.get("output_tokens", 0) or 0),
                                      int(journal_usage.get("output_tokens", 0) or 0)),
                 "requests": max(0, int(usage.get("requests", 0) or 0),
                                 int(journal_usage.get("requests", 0) or 0))}
        request_reasons = timing_map("by_request_reason")
        explained_requests = sum(request_reasons.values())
        if explained_requests > stats["requests"]:
            request_reasons = ({"unattributed": stats["requests"]}
                               if stats["requests"] else {})
        elif stats["requests"] > explained_requests:
            request_reasons["unattributed"] = (
                request_reasons.get("unattributed", 0)
                + stats["requests"] - explained_requests)
        if stats["requests"] or request_reasons:
            stats["by_request_reason"] = request_reasons
        if transcript_has_timing or journal_has_timing:
            stats.update({
                "builtin_tool_us": timing_scalar("builtin_tool_us"),
                "builtin_tool_samples": timing_scalar("builtin_tool_samples"),
                "by_tool_us": timing_map("by_tool_us"),
                "by_tool_samples": timing_map("by_tool_samples"),
            })
        return stats
    except Exception as e:      # noqa
        return {"stats_error": str(e)[:200]}


def _reconcile_dgc_usage(run: dict, stats: dict) -> None:
    """Cross-check independent provider and crash-safe session request counters in-place.

    Provider usage is authoritative for consumed compute. A timed-out client may abandon a
    request while the provider is still generating; the proxy drains and charges that response,
    but DGC correctly has no completed-response journal entry for it. Treat only the explainable
    provider surplus as synchronized and retain the independent counts in the evidence record.
    """
    usage = run.get("usage")
    if not isinstance(usage, dict):
        return
    provider_requests = max(0, int(usage.get("requests", 0) or 0))
    journal_requests = max(0, int(stats.get("requests", 0) or 0))
    disconnected_requests = max(
        0, int(usage.get("client_disconnected_requests", 0) or 0))
    provider_surplus = provider_requests - journal_requests
    if provider_surplus == 0:
        return
    if 0 < provider_surplus <= disconnected_requests:
        usage["provider_only_cancelled_requests"] = provider_surplus
        usage["request_reconciliation"] = {
            "provider": provider_requests,
            "session_journal": journal_requests,
            "client_disconnected": disconnected_requests,
        }
        return
    usage["synchronized"] = False
    usage["request_mismatch"] = {
        "provider": provider_requests,
        "session_journal": journal_requests,
        "client_disconnected": disconnected_requests,
    }


# ---------------------------------------------------------------- one run -----
def _monotonic_stats_delta(cumulative: dict, previous: dict) -> dict:
    """Return exact per-round deltas for additive crash-journal counters."""
    stats: dict = {}
    for key, value in cumulative.items():
        if isinstance(value, int):
            stats[key] = max(0, value - int(previous.get(key, 0) or 0))
        elif isinstance(value, dict):
            old = previous.get(key) if isinstance(previous.get(key), dict) else {}
            deltas = {
                name: max(0, int(amount or 0) - int(old.get(name, 0) or 0))
                for name, amount in value.items()
            }
            stats[key] = {name: amount for name, amount in deltas.items() if amount > 0}
        else:
            stats[key] = value
    return stats


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
    seed_home(exercise_home, a.model, a.base_url, a.api_key, a.max_turns, a.dgc_timeout,
              tcmd, context_size=a.context_size)
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
            out = _portable_grader_output(out, grade)
            solution_sha = _sha256_files(grade, sol)
            tests_sha = _sha256_files(grade, test)
        finally:
            shutil.rmtree(grade.parent, ignore_errors=True)
        last_out = out
        # session_stats only applies to DGC's own session dir; other engines have none.
        cumulative = session_stats(exercise_home, work) if a.engine == "dgc" else {}
        stats = _monotonic_stats_delta(cumulative, prior_stats)
        prior_stats = cumulative
        if "usage" not in run and a.engine == "dgc" and cumulative:
            run["usage"] = {key: stats.get(key, 0)
                            for key in ("input_tokens", "output_tokens", "requests")}
        if a.engine == "dgc":
            _reconcile_dgc_usage(run, stats)
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
                                       "provider_requests": 0,
                                       "usage_rounds": 0, "rounds": 0,
                                       "provider_duration_s": 0.0,
                                       "provider_wall_s": 0.0,
                                       "provider_max_duration_s": 0.0,
                                       "provider_timing_rounds": 0,
                                       "builtin_tool_s": 0.0,
                                       "builtin_tool_samples": 0,
                                       "builtin_timing_rounds": 0,
                                       "by_tool_us": {}, "by_tool_samples": {},
                                       "by_request_reason": {}})
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
            stats = rd.get("stats") or {}
            p["edit_fails"] += stats.get("edit_fails", 0) or 0
            reason_values = (
                stats.get("by_request_reason")
                if str(r.get("engine") or "") == "dgc"
                and isinstance(stats.get("by_request_reason"), dict) else {})
            valid_reasons = [str(name) for name in sorted(reason_values)
                             if re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", str(name))
                             and str(name) in _REQUEST_REASON_LABELS][:64]
            for name in valid_reasons:
                p["by_request_reason"][name] = (
                    p["by_request_reason"].get(name, 0)
                    + max(0, int(reason_values.get(name, 0) or 0)))
            if "builtin_tool_us" in stats:
                p["builtin_timing_rounds"] += 1
                p["builtin_tool_s"] += max(0, int(stats.get("builtin_tool_us", 0) or 0)) / 1_000_000
                p["builtin_tool_samples"] += max(
                    0, int(stats.get("builtin_tool_samples", 0) or 0))
                for source_key, target_key in (("by_tool_us", "by_tool_us"),
                                               ("by_tool_samples", "by_tool_samples")):
                    values = stats.get(source_key) if isinstance(stats.get(source_key), dict) else {}
                    valid_names = [str(name) for name in sorted(values)
                                   if re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", str(name))][:64]
                    for name in valid_names:
                        amount = values.get(name, 0)
                        p[target_key][name] = p[target_key].get(name, 0) + max(
                            0, int(amount or 0))
            if (isinstance(agent_run.get("usage"), dict)
                    and int(agent_run["usage"].get("requests", 0) or 0) > 0
                    and agent_run["usage"].get("synchronized", True) is not False):
                usage = agent_run["usage"]
                p["usage_rounds"] += 1
                for key in ("input_tokens", "output_tokens", "reasoning_tokens"):
                    p[key] += max(0, int(usage.get(key, 0) or 0))
                p["provider_requests"] += max(0, int(usage.get("requests", 0) or 0))
                timing_values = []
                for key in ("provider_duration_s", "provider_wall_s",
                            "provider_max_duration_s"):
                    try:
                        value = float(usage[key]) if usage.get(key) is not None else None
                    except (KeyError, TypeError, ValueError):
                        value = None
                    timing_values.append(
                        value if value is not None and math.isfinite(value) and value >= 0 else None)
                if all(value is not None for value in timing_values):
                    p["provider_timing_rounds"] += 1
                    p["provider_duration_s"] += timing_values[0]
                    p["provider_wall_s"] += timing_values[1]
                    p["provider_max_duration_s"] = max(
                        p["provider_max_duration_s"], timing_values[2])
    return per


def print_report(jsonl_path: Path, langs: list[str] | None = None) -> None:
    per = aggregate(jsonl_path)
    order = langs or sorted(per)
    tot = {"n": 0, "p1": 0, "p2": 0, "agent_s": 0.0, "edit_fails": 0,
           "timeouts": 0, "input_tokens": 0, "output_tokens": 0,
           "reasoning_tokens": 0, "provider_requests": 0,
           "usage_rounds": 0, "rounds": 0,
           "provider_duration_s": 0.0, "provider_wall_s": 0.0,
           "provider_max_duration_s": 0.0, "provider_timing_rounds": 0,
           "builtin_tool_s": 0.0, "builtin_tool_samples": 0,
           "builtin_timing_rounds": 0, "by_tool_us": {}, "by_tool_samples": {},
           "by_request_reason": {}}
    print(f"\n==== {Path(jsonl_path).name} ====")
    print(f"{'lang':11s} {'n':>4} {'pass@1':>14} {'pass@2':>14} {'avg_s':>7} "
          f"{'prov_s':>7} {'other_s':>7} {'tool_s':>7} {'req/t':>6} {'avg_out':>9} "
          f"{'out/req':>8} {'editfail':>8} {'t/o':>4}")
    for lang in order:
        p = per.get(lang)
        if not p:
            continue
        for k in tot:
            if k == "provider_max_duration_s":
                tot[k] = max(tot[k], p[k])
            elif isinstance(tot[k], dict):
                for name, amount in p[k].items():
                    tot[k][name] = tot[k].get(name, 0) + amount
            else:
                tot[k] += p[k]
        avg = p["agent_s"] / p["n"] if p["n"] else 0
        avg_out = (str(round(p["output_tokens"] / p["n"]))
                   if p["usage_rounds"] == p["rounds"] else "?")
        avg_requests = (f"{p['provider_requests'] / p['n']:.1f}"
                        if p["usage_rounds"] == p["rounds"] else "?")
        output_per_request = (str(round(p["output_tokens"] / p["provider_requests"]))
                              if (p["usage_rounds"] == p["rounds"]
                                  and p["provider_requests"] > 0) else "?")
        avg_provider = (f"{p['provider_wall_s'] / p['n']:.0f}"
                        if p["provider_timing_rounds"] == p["rounds"] else "?")
        avg_outside_provider = (
            f"{max(0.0, p['agent_s'] - p['provider_wall_s']) / p['n']:.0f}"
            if p["provider_timing_rounds"] == p["rounds"] else "?")
        avg_tool = (f"{p['builtin_tool_s'] / p['n']:.1f}"
                    if p["builtin_timing_rounds"] == p["rounds"] else "?")
        print(f"{lang:11s} {p['n']:4d} {p['p1']:4d} ({100*p['p1']/p['n']:5.1f}%) "
              f"{p['p2']:4d} ({100*p['p2']/p['n']:5.1f}%) {avg:7.0f} "
              f"{avg_provider:>7} {avg_outside_provider:>7} {avg_tool:>7} "
              f"{avg_requests:>6} {avg_out:>9} {output_per_request:>8} "
              f"{p['edit_fails']:8d} {p['timeouts']:4d}")
    if tot["n"]:
        avg = tot["agent_s"] / tot["n"]
        avg_out = (str(round(tot["output_tokens"] / tot["n"]))
                   if tot["usage_rounds"] == tot["rounds"] else "?")
        avg_requests = (f"{tot['provider_requests'] / tot['n']:.1f}"
                        if tot["usage_rounds"] == tot["rounds"] else "?")
        output_per_request = (str(round(tot["output_tokens"] / tot["provider_requests"]))
                              if (tot["usage_rounds"] == tot["rounds"]
                                  and tot["provider_requests"] > 0) else "?")
        avg_provider = (f"{tot['provider_wall_s'] / tot['n']:.0f}"
                        if tot["provider_timing_rounds"] == tot["rounds"] else "?")
        avg_outside_provider = (
            f"{max(0.0, tot['agent_s'] - tot['provider_wall_s']) / tot['n']:.0f}"
            if tot["provider_timing_rounds"] == tot["rounds"] else "?")
        avg_tool = (f"{tot['builtin_tool_s'] / tot['n']:.1f}"
                    if tot["builtin_timing_rounds"] == tot["rounds"] else "?")
        print(f"{'TOTAL':11s} {tot['n']:4d} {tot['p1']:4d} ({100*tot['p1']/tot['n']:5.1f}%) "
              f"{tot['p2']:4d} ({100*tot['p2']/tot['n']:5.1f}%) {avg:7.0f} "
              f"{avg_provider:>7} {avg_outside_provider:>7} {avg_tool:>7} "
              f"{avg_requests:>6} {avg_out:>9} {output_per_request:>8} "
              f"{tot['edit_fails']:8d} {tot['timeouts']:4d}")
        if tot["builtin_timing_rounds"] == tot["rounds"] and tot["by_tool_us"]:
            ranked = sorted(tot["by_tool_us"].items(), key=lambda item: (-item[1], item[0]))
            details = ", ".join(
                f"{name}={elapsed / 1_000_000:.1f}s/{tot['by_tool_samples'].get(name, 0)}"
                for name, elapsed in ranked[:8])
            print("built-in tool-seconds (sum; parallel calls may overlap): " + details)
        if tot["by_request_reason"]:
            ranked = sorted(
                tot["by_request_reason"].items(), key=lambda item: (-item[1], item[0]))
            details = ", ".join(f"{name}={count}" for name, count in ranked[:10])
            print("DGC completed-request reasons (argument-free): " + details)


def summary_line(rec: dict) -> str:
    if rec.get("dry_run"):
        return f"[dry] {rec['lang']}/{rec['ex']}  test: {rec['dry_run']['testcmd'][:70]}"
    mark = "✅" if rec["solved"] else "❌"
    rnd = rec.get("solved_round", "-")
    t = sum((x.get("agent") or x.get("dgc") or {}).get("time", 0) for x in rec["rounds"])
    round_stats = [rd.get("stats", {}) for rd in rec.get("rounds", [])]
    known_edit_counts = [st.get("edit_fails") for st in round_stats
                         if isinstance(st.get("edit_fails"), int)]
    ef = sum(known_edit_counts) if known_edit_counts else "?"
    usages = [(rd.get("agent") or rd.get("dgc") or {}).get("usage") for rd in rec["rounds"]]
    out_tokens = (sum(int((usage or {}).get("output_tokens", 0) or 0) for usage in usages)
                  if usages and all(isinstance(usage, dict)
                                    and int(usage.get("requests", 0) or 0) > 0
                                    and usage.get("synchronized", True) is not False
                                    for usage in usages) else None)
    requests = (sum(int((usage or {}).get("requests", 0) or 0) for usage in usages)
                if out_tokens is not None else None)
    usage_text = (f"  req={requests}  out={out_tokens}" if requests is not None else "")
    return f"{mark} {rec['lang']}/{rec['ex']}  solved@{rnd}  {t:.0f}s{usage_text}  editfail={ef}"


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
    ap.add_argument("--context-size", type=int,
                    default=os.environ.get("DGC_BENCH_CONTEXT_SIZE", "0"),
                    help="verified baked model context shared by every harness (required for scoring)")
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
    if not 2_048 <= a.context_size <= 10_000_000:
        ap.error("--context-size is required and must be between 2048 and 10000000")
    env = bench_env()
    try:
        preflight = preflight_environment(langs, a.engine, env, dry_run=a.dry_run)
    except RuntimeError as exc:
        ap.error(str(exc))
    if a.dry_run:
        preflight["provider_context"] = {
            "status": "not-run", "source": "ollama_show",
            "requested_context": a.context_size}
    else:
        provider_context = provider_context_preflight(
            a.base_url, a.model, a.api_key, a.context_size)
        preflight["provider_context"] = provider_context
        if provider_context.get("status") != "pass":
            ap.error(str(provider_context.get("error") or "provider context preflight failed"))
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
            except UsageSynchronizationError:
                # Offset-based accounting becomes corrupt if a late provider request is allowed to
                # cross into the next task's mark. Fail immediately and let the league launcher reap
                # the proxy rather than manufacturing misleading evidence.
                raise
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
