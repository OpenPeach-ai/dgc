"""Pluggable coding-harness drivers for the polyglot benchmark.

Each engine runs a harness HEADLESS on the SAME local model, in the exercise
workdir, so it edits the solution file(s) in place; run_bench.py then scores the
result by running the exercise's REAL test suite. Same model + same tasks + same
scoring for every harness — only the harness changes.

Binaries resolve from explicit environment overrides first, then from the pinned
user-owned toolchain installed by ``bench/install_harnesses.sh``, then PATH.
DGC uses run_bench's own dgc_run.
"""
from __future__ import annotations
import json, os, time
from pathlib import Path

_BENCH_TOOLS = Path(os.environ.get("BENCH_TOOLS", str(Path.home() / "bench-tools"))).expanduser()
_HARNESS_ROOT = Path(os.environ.get("DGC_HARNESS_ROOT",
                                    str(_BENCH_TOOLS / "harnesses"))).expanduser()


def _binary(env_name: str, local: Path, fallback: str) -> str:
    override = os.environ.get(env_name)
    if override:
        return override
    return str(local) if local.is_file() and os.access(local, os.X_OK) else fallback


_NPM_BIN = _HARNESS_ROOT / "npm" / "node_modules" / ".bin"
AIDER    = _binary("AIDER", _HARNESS_ROOT / "aider" / "venv" / "bin" / "aider", "aider")
GOOSE    = _binary("GOOSE", _HARNESS_ROOT / "goose" / "bin" / "goose", "goose")
CODEX    = _binary("CODEX", _NPM_BIN / "codex", "codex")
OPENCODE = _binary("OPENCODE", _NPM_BIN / "opencode", "opencode")
PI       = _binary("PI", _NPM_BIN / "pi", "pi")


def _cap(args, workdir, env, timeout):
    from run_bench import _run_capture          # process-group-kill capture (no orphans)
    return _run_capture(args, workdir, env, timeout, merge=True)


def _result(t0, rc, out, timed_out, secrets=()) -> dict:
    from run_bench import _trace_record
    trace = _trace_record(out, "", secrets)
    return {"rc": None if timed_out else rc, "time": round(time.time() - t0, 1),
            "timeout": timed_out,
            "exit_reason": "timeout" if timed_out else ("completed" if rc == 0 else "nonzero_exit"),
            "trace": trace, "output_tail": trace["stdout"][-2000:]}


# ---------------------------------------------------------------- DGC ---------
def dgc_engine(prompt, workdir, sol, tcmd, a, home, cont, env) -> dict:
    from run_bench import dgc_run
    return dgc_run(prompt, workdir, a.model, a.base_url, a.api_key, home, cont, a.dgc_timeout, env)


# ---------------------------------------------------------------- Aider -------
def aider_engine(prompt, workdir, sol, tcmd, a, home, cont, env) -> dict:
    """Aider, driven headless. Talks to the local ollama via its OpenAI-compatible
    endpoint. The solution files are added to the chat; --message runs one non-interactive pass."""
    e = dict(env, HOME=str(home),
             OPENAI_API_BASE=a.base_url, OPENAI_API_KEY=(a.api_key or "ollama"),
             AIDER_ANALYTICS="false")
    history = Path(workdir) / ".dgc-bench-aider-history.md"
    args = [AIDER, "--model", f"openai/{a.model}",
            "--yes-always", "--no-git", "--no-auto-commits", "--no-check-update",
            "--no-show-release-notes", "--no-browser",
            "--no-show-model-warnings", "--no-stream", "--map-tokens", "0",
            "--reasoning-effort", "none", "--thinking-tokens", "0",
            "--no-check-model-accepts-settings",
            # match DGC/Codex/goose (agentic): let Aider RUN the tests and self-correct in a loop,
            # which is also how Aider's own polyglot benchmark drives it. Without this Aider is
            # one-shot and unfairly handicapped vs agentic harnesses.
            "--auto-test", "--test-cmd", tcmd, "--chat-history-file", str(history)]
    if cont:
        args.append("--restore-chat-history")
    args += [str(s) for s in sol]                 # files Aider may edit
    args += ["--message", prompt]
    t0 = time.time()
    rc, out, _err, to = _cap(args, workdir, e, a.dgc_timeout)
    return _result(t0, rc, out, to, (a.api_key,))


# ---------------------------------------------------------------- Codex -------
def codex_engine(prompt, workdir, sol, tcmd, a, home, cont, env) -> dict:
    """OpenAI Codex CLI headless through an explicit Responses provider.

    The built-in ``--oss --local-provider ollama`` path fixes its own localhost origin and ignores
    the benchmark proxy. A named custom provider makes the measured base URL authoritative.
    """
    e = dict(env, HOME=str(home))
    provider = [
        "-c", 'model_provider="dgc_benchmark"',
        "-c", 'model_providers.dgc_benchmark.name="DGC benchmark proxy"',
        "-c", f"model_providers.dgc_benchmark.base_url={json.dumps(a.base_url)}",
        "-c", 'model_providers.dgc_benchmark.wire_api="responses"',
        "-c", "model_providers.dgc_benchmark.requires_openai_auth=false",
    ]
    if cont:
        args = [CODEX, "exec", "resume", "--last", "-m", a.model, *provider,
                "-c", 'model_reasoning_effort="none"', "--json",
                "--skip-git-repo-check", "--ignore-user-config",
                "--dangerously-bypass-approvals-and-sandbox", prompt]
    else:
        args = [CODEX, "exec", "-m", a.model, *provider,
                "-c", 'model_reasoning_effort="none"', "--json",
                "--skip-git-repo-check", "--ignore-user-config", "-C", str(workdir),
                "--dangerously-bypass-approvals-and-sandbox", prompt]
    t0 = time.time()
    rc, out, _err, to = _cap(args, workdir, e, a.dgc_timeout)
    return _result(t0, rc, out, to, (a.api_key,))


# ---------------------------------------------------------------- goose -------
def goose_engine(prompt, workdir, sol, tcmd, a, home, cont, env) -> dict:
    """Block goose headless (`goose run -t`). Provider/model via env (ollama)."""
    host = a.base_url.rstrip("/").removesuffix("/v1")
    e = dict(env, HOME=str(home), GOOSE_PROVIDER="ollama", GOOSE_MODEL=a.model,
             OLLAMA_HOST=host, GOOSE_THINKING_EFFORT="none")
    args = [GOOSE, "run", "--no-profile", "--with-builtin", "developer",
            "--provider", "ollama", "--model", a.model,
            "--max-turns", str(a.max_turns), "--stats", "--output-format", "stream-json"]
    if cont:
        args.append("--resume")
    args += ["-t", prompt]
    t0 = time.time()
    rc, out, _err, to = _cap(args, workdir, e, a.dgc_timeout)
    return _result(t0, rc, out, to, (a.api_key,))


# ---------------------------------------------------------------- OpenCode ----
def opencode_engine(prompt, workdir, sol, tcmd, a, home, cont, env) -> dict:
    """sst OpenCode headless (`opencode run`). Model as provider/model."""
    # seed an ollama provider config (OpenAI-compatible) into the run's HOME
    cfgdir = Path(home) / ".config" / "opencode"
    cfgdir.mkdir(parents=True, exist_ok=True)
    (cfgdir / "opencode.json").write_text(json.dumps({
        "$schema": "https://opencode.ai/config.json",
        # auto-approve so headless runs aren't blocked by opencode's own permission prompts
        "permission": {"edit": "allow", "bash": "allow", "webfetch": "allow"},
        "provider": {"ollama": {
            "npm": "@ai-sdk/openai-compatible", "name": "Ollama",
            "options": {"baseURL": a.base_url},
            "models": {a.model: {"name": a.model,
                                  "options": {"reasoningEffort": "none"}}}}}}))
    e = dict(env, HOME=str(home))
    # --dir pins opencode to the EXERCISE workdir (else it walks up and edits the wrong files)
    args = [OPENCODE, "run", "--pure", "--auto", "--format", "json", "--dir", str(workdir),
            "-m", f"ollama/{a.model}"]
    if cont:
        args.append("--continue")
    args.append(prompt)
    t0 = time.time()
    rc, out, _err, to = _cap(args, workdir, e, a.dgc_timeout)
    return _result(t0, rc, out, to, (a.api_key,))


# ---------------------------------------------------------------- pi ----------
def pi_engine(prompt, workdir, sol, tcmd, a, home, cont, env) -> dict:
    """Pi coding agent (earendil-works/pi) headless (`pi -p`). Ollama via a models.json provider.
    Fully agentic (its own shell tool runs the tests), like codex/goose — no --auto-test needed."""
    cfgdir = Path(home) / ".pi" / "agent"
    cfgdir.mkdir(parents=True, exist_ok=True)
    # register the local OpenAI-compatible endpoint as an 'ollama' provider (docs/models.md)
    (cfgdir / "models.json").write_text(json.dumps({
        "providers": {"ollama": {
            "baseUrl": a.base_url, "api": "openai-completions", "apiKey": (a.api_key or "ollama"),
            # many OpenAI-compatible local servers reject the `developer` role / reasoning_effort
            "compat": {"supportsDeveloperRole": False, "supportsReasoningEffort": False},
            "models": [{"id": a.model}]}}}))
    # non-interactive print mode runs tools with no per-call approval (pi has no sandbox by design) and
    # shows no trust prompt, so no approve flag is needed (older pi has no -a/--approve).
    e = dict(env, HOME=str(home))
    args = [PI, "-p", "--mode", "json", "--provider", "ollama", "--model", a.model,
            "--thinking", "off"]
    if cont:
        args.append("--continue")
    args.append(prompt)
    t0 = time.time()
    rc, out, _err, to = _cap(args, workdir, e, a.dgc_timeout)
    return _result(t0, rc, out, to, (a.api_key,))


ENGINES = {
    "dgc": dgc_engine, "aider": aider_engine, "codex": codex_engine,
    "goose": goose_engine, "opencode": opencode_engine, "pi": pi_engine,
}
