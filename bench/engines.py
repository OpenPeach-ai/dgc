"""Pluggable coding-harness drivers for the polyglot benchmark.

Each engine runs a harness HEADLESS on the SAME local model, in the exercise
workdir, so it edits the solution file(s) in place; run_bench.py then scores the
result by running the exercise's REAL test suite. Same model + same tasks + same
scoring for every harness — only the harness changes.

Binaries resolve from env (see /root/harness/roster.env on the bench box):
  AIDER, GOOSE, CODEX, OPENCODE.  DGC uses run_bench's own dgc_run.
"""
from __future__ import annotations
import json, os, time
from pathlib import Path

AIDER    = os.environ.get("AIDER", "aider")
GOOSE    = os.environ.get("GOOSE", "goose")
CODEX    = os.environ.get("CODEX", "codex")
OPENCODE = os.environ.get("OPENCODE", "opencode")
PI       = os.environ.get("PI", "pi")


def _cap(args, workdir, env, timeout):
    from run_bench import _run_capture          # process-group-kill capture (no orphans)
    return _run_capture(args, workdir, env, timeout, merge=True)


def _result(t0, rc, out, timed_out) -> dict:
    return {"rc": None if timed_out else rc, "time": round(time.time() - t0, 1),
            "timeout": timed_out, "stderr_tail": (out or "")[-1200:]}


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
    args = [AIDER, "--model", f"openai/{a.model}",
            "--yes-always", "--no-git", "--no-auto-commits", "--no-check-update",
            "--no-show-model-warnings", "--no-stream", "--map-tokens", "0",
            # match DGC/Codex/goose (agentic): let Aider RUN the tests and self-correct in a loop,
            # which is also how Aider's own polyglot benchmark drives it. Without this Aider is
            # one-shot and unfairly handicapped vs agentic harnesses.
            "--auto-test", "--test-cmd", tcmd]
    args += [str(s) for s in sol]                 # files Aider may edit
    args += ["--message", prompt]
    t0 = time.time()
    rc, out, _err, to = _cap(args, workdir, e, a.dgc_timeout)
    return _result(t0, rc, out, to)


# ---------------------------------------------------------------- Codex -------
def codex_engine(prompt, workdir, sol, tcmd, a, home, cont, env) -> dict:
    """OpenAI Codex CLI headless (`codex exec`) with `--oss` pointing at the local ollama."""
    e = dict(env, HOME=str(home), OLLAMA_BASE_URL=a.base_url.rstrip("/").removesuffix("/v1"))
    args = [CODEX, "exec", "--oss", "--local-provider", "ollama", "-m", a.model,
            "--skip-git-repo-check", "-C", str(workdir),
            "--dangerously-bypass-approvals-and-sandbox", prompt]
    t0 = time.time()
    rc, out, _err, to = _cap(args, workdir, e, a.dgc_timeout)
    return _result(t0, rc, out, to)


# ---------------------------------------------------------------- goose -------
def goose_engine(prompt, workdir, sol, tcmd, a, home, cont, env) -> dict:
    """Block goose headless (`goose run -t`). Provider/model via env (ollama)."""
    host = a.base_url.rstrip("/").removesuffix("/v1")
    e = dict(env, HOME=str(home), GOOSE_PROVIDER="ollama", GOOSE_MODEL=a.model,
             OLLAMA_HOST=host)
    args = [GOOSE, "run", "--no-session", "-t", prompt]
    t0 = time.time()
    rc, out, _err, to = _cap(args, workdir, e, a.dgc_timeout)
    return _result(t0, rc, out, to)


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
            "models": {a.model: {"name": a.model}}}}}))
    e = dict(env, HOME=str(home))
    # --dir pins opencode to the EXERCISE workdir (else it walks up and edits the wrong files)
    args = [OPENCODE, "run", "--dir", str(workdir), "-m", f"ollama/{a.model}", prompt]
    t0 = time.time()
    rc, out, _err, to = _cap(args, workdir, e, a.dgc_timeout)
    return _result(t0, rc, out, to)


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
    args = [PI, "-p", "--no-session", "--provider", "ollama", "--model", a.model,
            "--api-key", (a.api_key or "ollama"), "--thinking", "off", prompt]
    t0 = time.time()
    rc, out, _err, to = _cap(args, workdir, e, a.dgc_timeout)
    return _result(t0, rc, out, to)


ENGINES = {
    "dgc": dgc_engine, "aider": aider_engine, "codex": codex_engine,
    "goose": goose_engine, "opencode": opencode_engine, "pi": pi_engine,
}
