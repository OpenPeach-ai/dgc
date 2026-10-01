"""Configuration for dgc: global (~/.dgc/config.json) + project (.dgc/)."""
from __future__ import annotations

import copy
import hashlib
import contextlib
import json
import os
import re
import tempfile
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit, urlunsplit

APP = "dgc"


def _user_home_root() -> Path:
    """Directory whose ``.dgc`` holds user state.

    ``DGC_HOME`` lets an SDK child keep state off the host account without relying only on
    ``HOME``. Unset, this is ``Path.home()`` and editor/CLI behavior is unchanged.
    """
    override = os.environ.get("DGC_HOME")
    if override:
        return Path(override).expanduser()
    return Path.home()


USER_HOME = _user_home_root() / ".dgc"
USER_CONFIG = USER_HOME / "config.json"
USER_SECRETS = USER_HOME / "secrets.json"
USER_MEMORY = USER_HOME / "DGC.md"
USER_SKILLS = USER_HOME / "skills"
PORTABLE_USER_SKILLS = _user_home_root() / ".agents" / "skills"
USER_AGENTS = USER_HOME / "agents"
BUILTIN_SKILLS = Path(__file__).resolve().parent / "skills_builtin"  # skills shipped with dgc
SECRET_KEYS = frozenset({"api_key", "search_api_key", "subagent_api_key", "fallback_api_key"})
SECRET_ENV = {"api_key": "DGC_API_KEY", "search_api_key": "DGC_SEARCH_API_KEY",
              "subagent_api_key": "DGC_SUBAGENT_API_KEY",
              "fallback_api_key": "DGC_FALLBACK_API_KEY"}
_PROVIDER_SECRET_KEYS = frozenset({"api_key", "subagent_api_key", "fallback_api_key"})
_PROVIDER_SECRET_ENDPOINTS = {
    "api_key": "base_url",
    "subagent_api_key": "subagent_base_url",
    "fallback_api_key": "fallback_base_url",
}
_MCP_ENV_NAME_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,127}")
_MAX_MCP_SECRET_SERVERS = 64
_MAX_MCP_SECRET_VARS = 64
_MAX_MCP_SECRET_VALUE = 16_384
_MCP_SENSITIVE_QUERY_NAMES = frozenset({
    "token", "accesstoken", "apikey", "key", "secret", "password", "credential",
    "authorization", "auth",
})
_MCP_SENSITIVE_NAME_PARTS = frozenset({
    "token", "apikey", "key", "secret", "password", "passwd", "credential",
    "credentials", "authorization", "auth", "bearer",
})
_MCP_SENSITIVE_NAME_SUFFIXES = (
    "apikey", "token", "secret", "password", "passwd", "credential", "credentials",
    "authorization", "bearer", "auth",
)
_MCP_SECRET_FLAGS = frozenset({
    "--header", "--api-key", "--apikey", "--api_key", "--token", "--access-token",
    "--auth", "--authorization", "--password", "--passwd", "--secret", "--bearer",
    "--key", "--credential", "--credentials", "--env", "--env-file", "-e",
    "--client-secret", "--client_secret", "--clientsecret", "--refresh-token",
    "--refresh_token", "--refreshtoken", "--access_token", "--accesstoken",
    "--user", "-u",
})
_MCP_SECRET_FLAG_NAMES = frozenset({
    "apikey", "token", "accesstoken", "refreshtoken", "clientsecret", "auth",
    "authorization", "password", "passwd", "secret", "bearer", "key", "credential",
    "credentials", "env", "envfile", "user",
})
_MCP_SECRET_ASSIGNMENT_RE = re.compile(
    r"(?:[A-Za-z_][A-Za-z0-9_]*)?(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)"
    r"[A-Za-z0-9_]*=", re.IGNORECASE,
)


def _mcp_sensitive_name(value: object) -> bool:
    """Recognize credential fields even when vendors add a prefix or change separators."""
    if not isinstance(value, str):
        return False
    lowered = value.lower()
    normalized = re.sub(r"[^a-z0-9]", "", lowered)
    parts = {part for part in re.split(r"[^a-z0-9]+", lowered) if part}
    return (normalized in _MCP_SENSITIVE_QUERY_NAMES
            or bool(parts & _MCP_SENSITIVE_NAME_PARTS)
            or any(normalized.endswith(suffix) for suffix in _MCP_SENSITIVE_NAME_SUFFIXES))


def mcp_url_has_credentials(value: object) -> bool:
    """Detect userinfo and credential-shaped query/fragment fields in a URL-like argument."""
    if not isinstance(value, str):
        return False
    raw = value.strip()
    candidates = [raw]
    if "=" in raw:
        candidates.append(raw.split("=", 1)[1].strip())
    for candidate in candidates:
        if not candidate.lower().startswith(("http://", "https://")):
            continue
        try:
            parsed = urlsplit(candidate)
            parameters = (
                *parse_qsl(parsed.query, keep_blank_values=True),
                *parse_qsl(parsed.fragment, keep_blank_values=True),
            )
            if bool(parsed.username or parsed.password) or any(
                    _mcp_sensitive_name(key) for key, _item in parameters):
                return True
        except ValueError:
            return True
    return False


def persisted_mcp_args_safe(value: object) -> bool:
    """Return false when argv could persist a credential outside owner-private storage."""
    if not isinstance(value, list):
        return False
    for index, arg in enumerate(value):
        if not isinstance(arg, str):
            return False
        raw = arg.strip()
        lowered = raw.lower()
        prior_raw = value[index - 1].strip() if index and isinstance(value[index - 1], str) else ""
        prior = prior_raw.lower()
        head = lowered.split("=", 1)[0]
        prior_head = prior.split("=", 1)[0]
        normalized_head = re.sub(r"[^a-z0-9]", "", head.lstrip("-"))
        normalized_prior = re.sub(r"[^a-z0-9]", "", prior_head.lstrip("-"))
        combined_env = bool(re.fullmatch(r"-e(?:=.*|[A-Za-z_][A-Za-z0-9_]*(?:=.*)?)", raw))
        combined_user = raw.startswith("-u") and len(raw) > 2 and ":" in raw[2:]
        if (lowered.startswith("authorization:") or lowered == "--header"
                or prior == "--header" or raw == "-H" or prior_raw == "-H"
                or raw.startswith("-H")
                or head in _MCP_SECRET_FLAGS or prior_head in _MCP_SECRET_FLAGS
                or normalized_head in _MCP_SECRET_FLAG_NAMES
                or normalized_prior in _MCP_SECRET_FLAG_NAMES
                or _mcp_sensitive_name(head.lstrip("-"))
                or _mcp_sensitive_name(prior_head.lstrip("-"))
                or combined_env or combined_user
                or bool(_MCP_SECRET_ASSIGNMENT_RE.match(raw))
                or mcp_url_has_credentials(raw)):
            return False
    return True


def valid_remote_mcp_url(value: object) -> bool:
    """Accept only credential-free remote URLs produced by the current setup flow."""
    if not isinstance(value, str) or not value or len(value) > 4096 or any(
            char.isspace() for char in value):
        return False
    try:
        parsed = urlsplit(value)
        loopback = parsed.hostname in ("localhost", "127.0.0.1", "::1")
        return bool(parsed.netloc) and not mcp_url_has_credentials(value) and (
            parsed.scheme == "https" or (parsed.scheme == "http" and loopback)
        )
    except ValueError:
        return False


def _clean_mcp_secret_map(value) -> dict[str, dict[str, str]]:
    """Bound the owner-private MCP secret map before it can reach a child process."""
    if not isinstance(value, dict):
        return {}
    clean: dict[str, dict[str, str]] = {}
    for raw_server, raw_env in list(value.items())[:_MAX_MCP_SECRET_SERVERS]:
        server = str(raw_server)
        if not server or len(server) > 128 or not isinstance(raw_env, dict):
            continue
        env: dict[str, str] = {}
        for raw_name, raw_secret in list(raw_env.items())[:_MAX_MCP_SECRET_VARS]:
            name = str(raw_name)
            if (not _MCP_ENV_NAME_RE.fullmatch(name) or not isinstance(raw_secret, str)
                    or not raw_secret or len(raw_secret) > _MAX_MCP_SECRET_VALUE
                    or "\x00" in raw_secret):
                continue
            env[name] = raw_secret
        if env:
            clean[server] = env
    return clean


def _mcp_spec_fingerprint(value) -> str:
    """Bind an owner-private MCP credential to one exact public server identity."""
    if not isinstance(value, dict):
        return ""
    try:
        # ``env`` is deliberately runtime-only.  Every persisted field, including env_names and
        # the remote URL/argv identity, remains part of the binding.
        public_value = {key: item for key, item in value.items() if key != "env"}
        payload = json.dumps(public_value, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
                             allow_nan=False).encode("utf-8")
    except (RecursionError, TypeError, ValueError, UnicodeError):
        return ""
    return hashlib.sha256(payload).hexdigest()


def _clean_mcp_identity_map(value) -> dict[str, str]:
    if not isinstance(value, dict):
        return {}
    return {str(name): fingerprint for name, fingerprint in list(value.items())[:_MAX_MCP_SECRET_SERVERS]
            if isinstance(fingerprint, str) and re.fullmatch(r"[0-9a-f]{64}", fingerprint)}


def _normalized_provider_endpoint(value: object) -> str:
    """Canonicalize harmless URL spelling differences without merging distinct request paths."""
    raw = str(value or "").strip()
    if not raw:
        return ""
    try:
        parsed = urlsplit(raw)
        if not parsed.scheme or not parsed.netloc:
            return raw.rstrip("/")
        port = parsed.port
        scheme = parsed.scheme.lower()
        host = (parsed.hostname or "").lower()
        if ":" in host and not host.startswith("["):
            host = f"[{host}]"
        userinfo = parsed.netloc.rsplit("@", 1)[0] + "@" if "@" in parsed.netloc else ""
        if port is not None and not ((scheme == "https" and port == 443)
                                     or (scheme == "http" and port == 80)):
            host = f"{host}:{port}"
        path = parsed.path.rstrip("/")
        return urlunsplit((scheme, userinfo + host, path, parsed.query, parsed.fragment))
    except (TypeError, ValueError):
        # Invalid hand-edited endpoints remain bound to their exact spelling and cannot inherit a
        # credential merely because parsing failed.
        return raw.rstrip("/")


def _provider_secret_identity(data: dict, secret_key: str) -> str:
    if not isinstance(data, dict):
        return ""
    endpoint_key = _PROVIDER_SECRET_ENDPOINTS.get(secret_key)
    if endpoint_key is None:
        return ""
    endpoint = data.get(endpoint_key, "")
    if secret_key != "api_key" and not endpoint:
        endpoint = data.get("base_url", "")
    normalized = _normalized_provider_endpoint(endpoint)
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest() if normalized else ""


def _clean_provider_identity_map(value) -> dict[str, str]:
    if not isinstance(value, dict):
        return {}
    return {key: fingerprint for key, fingerprint in value.items()
            if key in _PROVIDER_SECRET_KEYS and isinstance(fingerprint, str)
            and re.fullmatch(r"[0-9a-f]{64}", fingerprint)}


def _read_secret_file(path: str | None) -> str | None:
    """Read a provider key a launcher wrote to a private file, then delete the file.

    The key must not linger where an unsandboxed shell tool (same user) could read it, so the file
    is removed immediately, before any tool runs. A missing or unreadable path yields None.
    """
    if not path:
        return None
    try:
        with open(path, "r", encoding="utf-8") as handle:
            value = handle.read()
    except OSError:
        return None
    try:
        os.unlink(path)
    except OSError:
        pass
    return value


@contextlib.contextmanager
def _config_write_lock():
    """Serialise config writes across every backend on this machine.

    flock on a sidecar, so the kernel drops it if a holder is killed. A platform without fcntl
    (Windows) still gets the read-modify-write below, which is what actually preserves another
    backend's changes; the lock only removes the last, narrow interleaving between reading the
    file and replacing it.
    """
    try:
        import fcntl
    except ImportError:
        yield
        return
    path = USER_CONFIG.parent / "config.lock"
    fd = None
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(str(path), os.O_CREAT | os.O_RDWR | getattr(os, "O_CLOEXEC", 0), 0o600)
        fcntl.flock(fd, fcntl.LOCK_EX)
    except OSError:
        if fd is not None:
            try: os.close(fd)
            except OSError: pass
            fd = None
    try:
        yield
    finally:
        if fd is not None:
            try:
                fcntl.flock(fd, fcntl.LOCK_UN)
            except OSError:
                pass
            try: os.close(fd)
            except OSError: pass


def _read_config_payload(path: Path) -> dict | None:
    """The config as it is on disk right now, or None when there is nothing usable there.

    None means "write mine whole": either the file does not exist yet, or it is unreadable. It
    deliberately does NOT mean an empty dict, because merging into {} would silently drop every
    key another backend had written.
    """
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, ValueError):
        return None
    return raw if isinstance(raw, dict) else None


def _write_private_json(path: Path, payload: dict) -> None:
    """Atomically persist user configuration with owner-only permissions."""
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        path.parent.chmod(0o700)
    except OSError:
        pass
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        try:
            os.fchmod(fd, 0o600)
        except OSError:
            pass
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(json.dumps(payload, indent=2) + "\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        try:
            Path(tmp).unlink()
        except OSError:
            pass

DEFAULTS: dict = {
    "base_url": "http://localhost:11434/v1",   # supported native or OpenAI-compatible endpoint
    "api_key": "ollama",                        # dummy key works for ollama/lm-studio
    "model": "qwen3:8b",
    "api_mode": "auto",                         # auto | ollama | anthropic | chat_completions | responses
    "subscription_engine": "",                  # "" = drive the model directly (above). Else one of
                                                #   claude | codex | qwen | kimi | copilot: delegate each turn
                                                #   to the user's own logged-in first-party CLI (subscription).
    "subscription_model": "",                   # optional model override passed to that CLI ("" = its default)
    "subscription_effort": "",                  # optional reasoning effort for CLIs that take one (claude/codex)
    "provider_state": "stateless",              # stateless | server; server permits provider-side storage
    "prompt_cache": True,                        # send a privacy-safe stable cache-routing key when supported
    "prompt_cache_key": "",                     # optional explicit key (never derived from prompt text verbatim)
    "provider_capabilities": {},                 # explicit feature -> bool overrides for compatible endpoints
    "capability_cache_ttl_s": 300,               # retry a rejected endpoint/model feature after this interval
    "mode": "default",                          # default | acceptEdits | plan | auto
    "thinking": "off",                          # off | low | medium | high
    "ultra_mode": False,                        # extended reasoning + proactive bounded sub-agents;
                                                 #   never broadens the selected permission mode
    "think_budget_tokens": "auto",              # over-thinking watchdog: abort+retry-with-less if a
                                                #   model reasons past this many tokens with no output.
                                                #   "auto" = per level (llm.AUTO_THINK_BUDGET_TOKENS:
                                                #   8k off/low … 64k xhigh); a number applies to every
                                                #   level; 0 = off
    "max_tokens": 16384,                        # output-token backstop per request; length-truncation
                                                #   auto-continues (0=don't send, respect the server)
    # sampling knobs — "" = respect the server default. Set these to tame a LOCAL model that loops or
    # repeats (raw llama.cpp/Ollama defaults often do). Qwen likes temperature 0.7 / top_p 0.8 / top_k 20.
    "temperature": "",                          # 0.0–2.0; lower = more deterministic
    "top_p": "",                                # nucleus sampling, 0.0–1.0
    "top_k": "",                                # only the top-K tokens (Ollama/llama.cpp/vLLM/SGLang)
    "min_p": "",                                # min-probability floor (llama.cpp/vLLM/SGLang)
    "context_size": 32768,
    "max_turns": 0,                             # no fixed tool-iteration cap by default: a progressing turn
                                                #   runs until completion/cancel/deadline. Set >0 only as an
                                                #   explicit emergency backstop; no-progress guards still apply.
    "turn_budget_s": 0,                         # wall-clock seconds per turn before DGC triages to finish
    "turn_token_budget": 0,                     # tokens per turn, sub-agents included, before DGC triages
                                                #   (0 = OFF: no time pressure — for slow local models). When
                                                #   >0 (e.g. a benchmark cap), DGC nudges itself to land+verify
                                                #   the fix as the clock runs down and preserves the last
                                                #   test-passing files if it runs out of time (no 0-credit).
    "tool_profile": "standard",                 # standard every product tool | adaptive intent-aware
                                                #   catalog (small local contexts) | full catalog
    "tool_profile_chosen": False,               # the one-shot 0.41.7 "adaptive" migration has run,
                                                #   so a later `adaptive` is the user's own choice
    "code_action": False,                       # optional "code action" power tool: advertise a `python`
                                                #   tool that runs code in a PERSISTENT per-session
                                                #   interpreter (variables/imports persist across calls, so
                                                #   the model loads data once and computes over it across
                                                #   turns instead of re-reading it every call). Off by
                                                #   default: it executes arbitrary code and is gated by the
                                                #   same approval path as `bash` (asks in default/acceptEdits,
                                                #   denied in plan).
    "ollama_keep_alive": "30m",                 # keep an Ollama model resident between turns (D2 speedup;
                                                #   only sent to the ollama provider; "" = don't send)
    "verify_before_done": False,                # E: after edits, run verify_command before ending the turn;
    "verify_command": "",                       #   timed auto runs it after edit-only batches so red evidence
                                                #   skips a model round. e.g. "npm test" / "pytest -q"
    "finish_on_verified": False,                 # opt-in: the configured verifier defines the whole timed task
    "autonomous_gate": "",                      # "" = OFF. A check command that must exit 0 before the model may
                                                #   stop; a nonzero exit feeds its output back and continues.
    "autonomous_max_turns": 30,                 # bound on failed autonomous_gate retries before the turn stops
    "bash_timeout": 120,
    "search_timeout": 15,                       # bounded internal grep/glob helper lifetime (1-60s)
    "request_timeout": 1800,                    # hard ceiling on socket silence, including the wait for
                                                #   response headers; the stall watcher normally acts first
    # Stall watcher: a model request that hangs without an error (no headers, a silent stream, or
    # keep-alives with no tokens) is closed, retried, then reported by model and endpoint.
    "model_first_token_timeout_s": "auto",      # seconds until the first real delta; "auto" = 900 for a
                                                #   local endpoint (load + large prefill), 300 remote; 0 = off
    "model_idle_timeout_s": 300,                # seconds without a token mid-stream before it is a stall
                                                #   (partial output is continued, not discarded); 0 = off
    "model_stall_notice_s": 45,                 # say "no response from the model" after this long; 0 = never
    "model_stall_retries": 2,                   # re-issues after a stall before fallback_model or failing
    "model_load_timeout_s": 900,                # self-hosted Ollama: how long a model may take to load
    "approval_timeout_s": 300,                  # bounded MCP input; native human decisions wait for reply/Stop
    "compact_threshold": 0.85,                  # summarize older turns at this fraction of context_size
    "recall_max_bytes": 524288,                 # /recall scrollback archive per session (0.5 MiB)
    "notes": True,                              # keep a searchable per-project trace of what was learned
    "notes_max_rows": 5000,                     # oldest notes are pruned past this, per project
    "mouse": "capture",                         # capture (wheel scrolls DGC, rows clickable) | off (terminal selection)
    "session_redaction": True,                  # strip credentials from durable transcript/plan history;
                                                # exact file rewind snapshots stay private and unchanged
    "search_provider": "duckduckgo",            # duckduckgo (keyless) | brave | tavily | searxng
    "search_api_key": "",                       # for brave / tavily
    "search_url": "",                           # for searxng (self-hosted base URL)
    "browser_path": "",                         # explicit Chrome/Chromium; else CHROME_PATH, the
                                                # Playwright cache, PATH, then the usual locations
    "browser_allow_unsandboxed": False,         # run the browser with --no-sandbox where the distro
                                                # blocks user namespaces; a page exploit is then
                                                # no longer contained, so this stays opt-in
    "mcp_servers": {},                          # name -> {command, args, env} stdio MCP servers
    "disabled_skills": [],                     # skill names disabled across native/delegated clients
    "disabled_mcp_servers": [],                # lifecycle state separate from credential identity
    "language_servers": {},                     # language/ext -> {command, args, env, extensions}
    "code_intel_timeout": 15,                   # configured LSP request timeout (0.1-60s)
    "code_intel_lsp_idle_s": 120,               # reuse per-project LSP this long; 0 = one-shot
    "hooks": {},                                # event -> [{matcher?, command}] lifecycle hooks
    "fallback_model": "",                       # retried if the primary model errors
    "fallback_base_url": "",                    # optional endpoint for the fallback (default: same)
    "fallback_api_key": "",                     # credential for another fallback endpoint
    "fallback_api_mode": "",                    # transport override; empty=infer for another endpoint
    "subagent_model": "",                       # model for `task` sub-agents (empty: inherit main)
    "subagent_base_url": "",                    # host for sub-agents (empty: inherit main host)
    "subagent_api_key": "",                     # key for another sub-agent endpoint
    "subagent_api_mode": "",                    # transport override; empty=infer for another endpoint
    "subagent_context_size": 0,                 # sub-agents' context window in tokens (0: the main one's)
    "subagent_worktree_root": "",                # private task checkout storage (empty: ~/.dgc/worktrees)
    "subagent_link_paths": [],                   # opt-in: ignored dirs shared INTO task checkouts (e.g. node_modules)
    "fleet_worktree_root": "",                   # private TUI fleet checkouts (empty: ~/.dgc/fleet-worktrees)
    "max_parallel_tasks": 4,                     # 1 disables; max 8 concurrent isolated task workers
    "max_subagent_depth": 1,                     # how deep `task` may nest; 1 = a child cannot delegate (0-8)
    "trash_mode": "dgc",                        # /files deletes: dgc (~/.dgc/trash, 30-day) | os (system trash)
    "eta": True,                                # show a calibrated "~2–4 min left" range while a turn runs
    "notify": "off",                            # off | on — terminal/editor ping when a turn ≥20 s finishes
    "monitor_wake": True,                       # an idle TUI/editor session starts a turn on a monitor event
    "monitor_wake_delay_s": 2,                  # idle seconds after any turn before a wake (1-300)
    "monitor_wake_cooldown_s": 5,               # seconds between the end of a wake turn and the next (1-3600)
    "monitor_max_consecutive_wakes": 10,        # wake turns without a prompt before wakes pause (1-100)
    "logo_animation": True,                     # animate the startup wordmark (TTY only)
    "theme": "auto",                            # auto (match the terminal) | dark | light
    "suggest": True,                            # ghost-text: predict the next prompt after each turn
    "aux_idle_delay_ms": 750,                   # wait for foreground activity before title/suggestion
    "artifact_port": 45000,                     # the single fixed port the artifact server binds
    "artifact_autostart": True,                 # bring the artifact server up on launch if any are saved
    "artifact_bind": "localhost",               # localhost (127.0.0.1 only) | lan (0.0.0.0 — your local network)
    "artifact_hostname": "",                    # optional public host/URL (Tailscale MagicDNS, a reverse-proxy
    #                                             domain) shown alongside LAN + Tailscale in /artifact
    "plan_artifact": True,                      # render every proposed plan as a sanitized loopback-only page
    "artifact_in_plan": False,                  # expose the arbitrary project artifact tool in read-only plan
    #                                             mode; independent of the safe automatic plan page
    "background": "inherit",                    # inherit (respect terminal) | auto | dark | light
    "sandbox": False,                           # OS-confine bash; approval policy remains independent
    "sandbox_network": False,                   # deny sandboxed bash network unless explicitly enabled
    "sandbox_env_allow": [],                    # extra parent env names; runtime injection vars stay blocked
    "show_reasoning": True,                      # show the model's thinking (muted) in the chat
    "thinking_inline": True,                     # short provider-summarized thinking beside tool calls
                                                #   shows inline and muted (raw/unknown never inline)
    "thinking_inline_max_chars": 280,            # longest summary shown inline (0..1000; 0 = none)
    "preserve_thinking": False,                  # keep the model's prior-turn reasoning in the context sent
                                                #   back (helps multi-turn coherence, costs tokens; only
                                                #   affects OpenAI-compatible/chat_completions — Anthropic/
                                                #   Ollama already round-trip their own reasoning)
}

# Web-search providers — DuckDuckGo is keyless (the default floor); the rest need a key or a URL.
SEARCH_PROVIDERS: dict[str, dict] = {
    "duckduckgo": {"label": "DuckDuckGo (keyless, default)",  "needs_key": False, "needs_url": False},
    "brave":      {"label": "Brave Search (API key)",         "needs_key": True,  "needs_url": False},
    "tavily":     {"label": "Tavily (API key)",               "needs_key": True,  "needs_url": False},
    "searxng":    {"label": "SearXNG (self-hosted base URL)", "needs_key": False, "needs_url": True},
}

# One-command connection presets — used by `dgc setup`, `/connect <name>`, and the docs.
# Local presets need no real key; cloud presets prompt and use their provider-native auth contract.
PROVIDERS: dict[str, dict] = {
    "ollama":     {"base_url": "http://localhost:11434/v1",      "api_key": "ollama",    "needs_key": False, "label": "Ollama (local)"},
    "llamacpp":   {"base_url": "http://localhost:8080/v1",       "api_key": "sk-local",  "needs_key": False, "label": "llama.cpp / llama-server — also serves unsloth GGUFs (local)"},
    "lmstudio":   {"base_url": "http://localhost:1234/v1",       "api_key": "lm-studio", "needs_key": False, "label": "LM Studio (local)"},
    "vllm":       {"base_url": "http://localhost:8000/v1",       "api_key": "sk-local",  "needs_key": False, "label": "vLLM (local)"},
    "openai":     {"base_url": "https://api.openai.com/v1",      "api_key": "",          "needs_key": True,  "label": "OpenAI (cloud)"},
    "anthropic":  {"base_url": "https://api.anthropic.com/v1",   "api_key": "",          "needs_key": True,  "label": "Anthropic (cloud)"},
    "openrouter": {"base_url": "https://openrouter.ai/api/v1",   "api_key": "",          "needs_key": True,  "label": "OpenRouter (cloud — 100s of models)"},
    "groq":       {"base_url": "https://api.groq.com/openai/v1", "api_key": "",          "needs_key": True,  "label": "Groq (cloud)"},
    "deepseek":   {"base_url": "https://api.deepseek.com/v1",    "api_key": "",          "needs_key": True,  "label": "DeepSeek (cloud)"},
    "together":   {"base_url": "https://api.together.xyz/v1",    "api_key": "",          "needs_key": True,  "label": "Together AI (cloud)"},
    "mistral":    {"base_url": "https://api.mistral.ai/v1",      "api_key": "",          "needs_key": True,  "label": "Mistral (cloud)"},
}


def normalize_custom_base_url(url: str) -> tuple[str, bool]:
    """Best-effort `/v1` completion for a MANUALLY entered OpenAI-compatible endpoint.

    A user who types a bare host (`http://localhost:8080`) for llama.cpp `llama-server`, vLLM, or
    LM Studio almost always means the OpenAI-compatible `/v1` path; without it the chat-completions
    calls 404. Append `/v1` and report the change so the caller can tell the user.

    Left untouched (returns the input with only its trailing slash trimmed): Anthropic hosts (own
    Messages wire shape, not `/v1` chat completions), native Ollama (`:11434` serves its own API
    without `/v1`), any URL that already ends in a `/vN` path segment, and unparseable input. Only
    the custom/manual connect path calls this — the built-in presets already carry `/v1`.
    """
    import re
    from urllib.parse import urlparse
    raw = str(url or "").strip()
    if not raw:
        return raw, False
    trimmed = raw.rstrip("/")
    low = trimmed.lower()
    if "anthropic" in low or "11434" in low or "ollama" in low:
        return trimmed, False
    try:
        parsed = urlparse(trimmed if "://" in trimmed else "http://" + trimmed)
    except ValueError:
        return trimmed, False
    if not parsed.netloc:                       # not a host-shaped URL — leave it alone
        return trimmed, False
    segments = [seg for seg in parsed.path.split("/") if seg]
    if segments and re.fullmatch(r"v\d+", segments[-1]):
        return trimmed, False                   # already a versioned OpenAI path (…/v1, …/v2)
    return trimmed + "/v1", True


# Recommended operating windows (tokens) by model-name substring. For local models this may be
# deliberately smaller than the trained maximum because larger KV caches cost RAM/VRAM. Provider
# metadata still supplies a hard upper bound. First match wins; unknown → keep the current setting.
MODEL_CATALOG: list[tuple[str, int]] = [
    # Qwen3.8's native maximum is 256K. Use Ollama's 64K coding-agent recommendation as
    # the default operating window so model selection improves horizon without surprising local
    # users with the full maximum's RAM/VRAM allocation.
    ("qwen3.8", 65536),
    ("qwen3", 32768), ("qwen2.5", 32768), ("qwen2", 32768), ("qwen", 32768),
    ("gpt-oss", 131072), ("llama3.1", 131072), ("llama-3.1", 131072), ("llama3.3", 131072),
    ("llama-3.3", 131072), ("deepseek-v3", 65536), ("deepseek", 65536),
    ("mixtral", 32768), ("mistral", 32768), ("codestral", 32768),
    ("gpt-4o", 128000), ("gpt-5", 400000), ("gpt-4", 128000), ("o1", 200000), ("o3", 200000),
    ("gemma", 8192), ("phi", 16384), ("command-r", 131072), ("claude", 200000),
    ("kimi", 131072), ("glm", 131072),
]


# The windows a sub-agent picker offers, as the editor's context menu does for the main model.
SUBAGENT_WINDOWS = (8_192, 16_384, 32_768, 65_536, 131_072, 262_144)


def subagent_window_arg(text: str) -> int | None:
    """``/subagent context N``: a token count of at least 2048, a size like ``64k``, or 0 for the
    main model's window. None when it is neither."""
    raw = str(text or "").strip().lower().replace(",", "").replace("_", "")
    scale = 1024 if raw.endswith("k") else 1
    try:
        size = int(float(raw[:-1] if scale > 1 else raw) * scale)
    except ValueError:
        return None
    return size if size == 0 or 2_048 <= size <= 16_777_216 else None


def subagent_window_text(config) -> str:
    """What a sub-agent's window is, for a listing: its tokens, or that it follows the main one."""
    try:
        size = int(config.get("subagent_context_size", 0) or 0)
    except (TypeError, ValueError):
        size = 0
    return f"{max(2_048, size):,} tokens" if size > 0 else "(inherit main)"


def context_for_model(model: str) -> int | None:
    """A recommended operating window for `model`, or None to keep the current setting."""
    m = (model or "").lower()
    for pat, ctx in MODEL_CATALOG:
        if pat in m:
            return ctx
    return None


def find_project_root(start: Path | None = None) -> Path:
    """Walk up from `start` looking for a project marker (.git, DGC.md, .dgc).

    ``DGC_PROJECT_ROOT`` pins the workspace (SDK sessions). Isolated SDK children also
    refuse to walk up to a parent git root, so a job directory inside a repo stays the
    project root and relative writes cannot escape it.
    """
    pinned = (os.environ.get("DGC_PROJECT_ROOT") or "").strip()
    if pinned:
        path = Path(pinned).expanduser()
        try:
            path = path.resolve(strict=True)
        except OSError:
            path = path.resolve()
        if path.is_dir():
            return path
    p = Path(start or os.getcwd()).resolve()
    if os.environ.get("DGC_SDK_ISOLATED") == "1":
        return p
    for d in (p, *p.parents):
        dgc_dir = d / ".dgc"
        # a project's own .dgc counts, but NOT the global ~/.dgc config dir — otherwise every
        # folder under $HOME resolves its project root all the way up to $HOME.
        if (d / ".git").exists() or (d / "DGC.md").exists() or \
           (dgc_dir.is_dir() and dgc_dir != USER_HOME):
            return d
    return p


# What a running conversation is: its permission mode, its model route (and the credentials bound
# to it), and how it samples. A change in one session is still written -- it is the default the
# next session starts from -- but no OTHER running session adopts it at its next save. Adopted, a
# model switch in one window moved every other window's chat to that model mid-conversation, a
# mode switch put a chat sitting in `default` into `auto`, and an endpoint switch left the other
# sessions on the new endpoint holding the old endpoint's key.
_SESSION_KEYS = frozenset({
    "mode", "model", "base_url", "api_mode", "context_size", "thinking", "ultra_mode",
    "think_budget_tokens", "max_tokens", "temperature", "top_p", "top_k", "min_p",
    "tool_profile", "tool_profile_chosen", "subscription_engine", "subscription_model",
    "subscription_effort", "provider_state", "prompt_cache", "prompt_cache_key",
    "provider_capabilities", "fallback_model", "fallback_base_url", "fallback_api_mode",
    "subagent_model", "subagent_base_url", "subagent_api_mode", "subagent_context_size",
})


# Lists several processes edit one entry at a time. Written whole, a Config that loaded before
# another revoked a trusted folder wrote it back the next time it trusted a different one: the
# revoke was undone in the unsafe direction.
_ENTRY_MERGED_KEYS = ("trusted_dirs",)


def _merge_entries(on_disk, baseline, now) -> list:
    """`on_disk` with exactly this process's additions and removals since `baseline` applied."""
    def entries(value):
        return [item for item in value if isinstance(item, str)] if isinstance(value, list) else []
    was, mine = entries(baseline), entries(now)
    removed = {item for item in was if item not in mine}
    merged = [item for item in entries(on_disk) if item not in removed]
    merged += [item for item in mine if item not in was and item not in merged]
    return merged


def _policy_strips_allow() -> bool:
    """Whether the launching process reviews commands itself (an SDK RuntimePolicy with
    project_allow=False, or an invalid policy). Stored and workspace allow rules then pre-approve
    nothing: only the callback's own "always" answers in this session may."""
    from .permissions import session_policy
    policy = session_policy()
    return policy is not None and bool(policy.error or not policy.project_allow)


class Config:
    def __init__(self, project_root: Path | None = None):
        self.project_root = project_root or find_project_root()
        self.project_dir = self.project_root / ".dgc"
        self._persist = True
        # Deep: a shallow copy shared every list and dict in DEFAULTS, so a setting mutated in place
        # (`setdefault(...).append`) changed the default for every Config built after it -- and
        # one process holds several Configs (ACP, the TUI fleet, every chat).
        self.data: dict = copy.deepcopy(DEFAULTS)
        self._stored_secrets: dict = {}
        self._stored_provider_identity: dict[str, str] = {}
        self._provider_secret_identity: dict[str, str] = {}
        self._stored_mcp_env: dict[str, dict[str, str]] = {}
        self._stored_mcp_identity: dict[str, str] = {}
        self._env_secret_keys: set[str] = set()
        self.credential_warnings: tuple[str, ...] = ()
        self.permissions: dict[str, list[str]] = {"allow": [], "ask": [], "deny": []}
        self.load()

    def load(self) -> None:
        raw: dict = {}
        if USER_CONFIG.exists():
            try:
                value = json.loads(USER_CONFIG.read_text())
                raw = value if isinstance(value, dict) else {}
            except (OSError, json.JSONDecodeError):
                raw = {}
        secrets: dict = {}
        if USER_SECRETS.exists():
            try:
                value = json.loads(USER_SECRETS.read_text())
                secrets = value if isinstance(value, dict) else {}
            except (OSError, json.JSONDecodeError):
                secrets = {}
        migrated = False
        migrated_provider_keys: set[str] = set()
        for key in SECRET_KEYS:                 # migrate legacy keys out of config.json on first load
            if key in raw:
                secrets[key] = raw.pop(key)
                if key in _PROVIDER_SECRET_KEYS:
                    migrated_provider_keys.add(key)
                migrated = True
        self._stored_mcp_env = _clean_mcp_secret_map(secrets.get("mcp_env", {}))
        prior_mcp_identity = _clean_mcp_identity_map(secrets.get("mcp_identity", {}))
        moved_mcp_names: set[str] = set()
        # Older TUI builds stored local MCP environment values directly in config.json and put a
        # remote Bearer value in mcp-remote's arguments. Move both generated shapes into the
        # owner-private secret file while retaining only environment references in normal config.
        raw_servers = raw.get("mcp_servers")
        if isinstance(raw_servers, dict):
            migrated_servers = dict(raw_servers)
            for server_index, (raw_name, raw_spec) in enumerate(raw_servers.items()):
                if not isinstance(raw_spec, dict):
                    continue
                name = str(raw_name)
                spec = copy.deepcopy(raw_spec)
                moved: dict[str, str] = {}
                generated_remote = False
                removed_bearer = False
                raw_auth_env = spec.get("auth_env")
                auth_env = (raw_auth_env if isinstance(raw_auth_env, str)
                            and _MCP_ENV_NAME_RE.fullmatch(raw_auth_env) else "")
                if raw_auth_env is not None and not auth_env:
                    spec.pop("auth_env", None)
                    migrated = True
                had_legacy_env = "env" in spec
                legacy_env = spec.pop("env", None)
                if had_legacy_env:
                    migrated = True
                if isinstance(legacy_env, dict):
                    # Preserve credentials only for servers DGC can actually start.  Every entry
                    # is still scrubbed below, so an oversized hand-edited catalog cannot hide a
                    # plaintext secret after the migration boundary.
                    if server_index < _MAX_MCP_SECRET_SERVERS:
                        moved.update(_clean_mcp_secret_map({name: legacy_env}).get(name, {}))
                args = spec.get("args")
                if isinstance(args, list):
                    generated_remote = (
                        spec.get("command") == "npx" and len(args) >= 3
                        and args[:2] == ["-y", "mcp-remote"]
                        and isinstance(args[2], str)
                    )
                    if generated_remote and not valid_remote_mcp_url(args[2]):
                        # Pre-hardening TUI builds accepted arbitrary remote targets.  A URL with
                        # userinfo or credential-like query data cannot be migrated safely: drop
                        # the whole unusable definition instead of retaining the secret twice in
                        # argv/url or guessing how that server authenticates.
                        migrated_servers.pop(raw_name, None)
                        self._stored_mcp_env.pop(name, None)
                        migrated = True
                        continue
                    if generated_remote and (
                            (spec.get("url") not in (None, "") and spec.get("url") != args[2])
                            or spec.get("transport") not in (None, "", "remote")):
                        migrated_servers.pop(raw_name, None)
                        self._stored_mcp_env.pop(name, None)
                        migrated = True
                        continue
                    # The old TUI did not persist a transport marker.  Retain the exact generated
                    # identity so its migrated Bearer reference is restored at runtime.
                    if generated_remote:
                        if not spec.get("transport"):
                            spec["transport"] = "remote"
                            migrated = True
                        if not spec.get("url"):
                            spec["url"] = args[2]
                            migrated = True
                    cleaned_args: list = []
                    index = 0
                    while index < len(args):
                        arg = args[index]
                        if (arg == "--header" and index + 1 < len(args)
                                and isinstance(args[index + 1], str)):
                            match = re.fullmatch(r"Authorization:\s*Bearer\s+(.+)",
                                                 args[index + 1], re.IGNORECASE)
                            if match:
                                removed_bearer = True
                                token = match.group(1)
                                reference = re.fullmatch(
                                    r"\$\{([A-Za-z_][A-Za-z0-9_]{0,127})\}", token)
                                if generated_remote and reference:
                                    auth_env = reference.group(1)
                                elif generated_remote:
                                    safe = re.sub(r"[^A-Za-z0-9]+", "_", name).strip("_").upper()
                                    env_name = (f"DGC_MCP_{safe or 'SERVER'}_TOKEN")[:128]
                                    if (server_index < _MAX_MCP_SECRET_SERVERS
                                            and _MCP_ENV_NAME_RE.fullmatch(env_name) and token
                                            and len(token) <= _MAX_MCP_SECRET_VALUE
                                            and "\x00" not in token):
                                        moved[env_name] = token
                                        auth_env = env_name
                                # Bearer headers are always removed from the public config.  Only
                                # the exact generated mcp-remote shape may retain a named runtime
                                # auth reference; malformed/oversized literals fail closed.
                                index += 2
                                migrated = True
                                continue
                        cleaned_args.append(arg)
                        index += 1
                    if removed_bearer and (not generated_remote or not auth_env):
                        # Stripping an Authorization header from an arbitrary command changes its
                        # identity and can make it contact a target without the intended auth.
                        # Only the exact DGC-generated bridge has a private, reconstructable
                        # replacement; all other legacy definitions fail closed.
                        migrated_servers.pop(raw_name, None)
                        self._stored_mcp_env.pop(name, None)
                        migrated = True
                        continue
                    if not persisted_mcp_args_safe(cleaned_args):
                        migrated_servers.pop(raw_name, None)
                        self._stored_mcp_env.pop(name, None)
                        migrated = True
                        continue
                    spec["args"] = cleaned_args
                declares_remote = spec.get("transport") == "remote" or bool(spec.get("url"))
                if declares_remote:
                    args = spec.get("args")
                    url = spec.get("url")
                    exact_remote = (
                        generated_remote and spec.get("transport") == "remote"
                        and isinstance(args, list) and len(args) >= 3
                        and isinstance(url, str) and args[2] == url
                        and valid_remote_mcp_url(url)
                    )
                    if not exact_remote:
                        # Runtime supports one auditable remote transport.  Drop malformed/custom
                        # remote definitions at the persistence boundary too, particularly URLs
                        # carrying userinfo or credential-like query parameters.
                        migrated_servers.pop(raw_name, None)
                        self._stored_mcp_env.pop(name, None)
                        migrated = True
                        continue
                if moved:
                    self._stored_mcp_env.setdefault(name, {}).update(moved)
                    moved_mcp_names.add(name)
                declared = spec.get("env_names") if isinstance(spec.get("env_names"), list) else []
                if not generated_remote or spec.get("transport") != "remote":
                    auth_env = ""
                ordered_names = [*declared, *moved, *([auth_env] if auth_env else [])]
                names = [item for item in ordered_names
                         if isinstance(item, str) and _MCP_ENV_NAME_RE.fullmatch(item)]
                if names:
                    spec["env_names"] = list(dict.fromkeys(names))[:_MAX_MCP_SECRET_VARS]
                elif "env_names" in spec:
                    spec["env_names"] = []
                if auth_env and auth_env in spec.get("env_names", []):
                    spec["auth_env"] = auth_env
                else:
                    spec.pop("auth_env", None)
                migrated_servers[raw_name] = spec
            raw["mcp_servers"] = migrated_servers
        # A private credential is usable only with the exact public server specification that
        # owned it.  This also fails closed if a user or sync tool edits config.json behind DGC's
        # mutation APIs, or when upgrading from a transient build that lacked identity binding.
        current_mcp_identity: dict[str, str] = {}
        if isinstance(raw.get("mcp_servers"), dict):
            for raw_name, raw_spec in list(raw["mcp_servers"].items())[:_MAX_MCP_SECRET_SERVERS]:
                fingerprint = _mcp_spec_fingerprint(raw_spec)
                if fingerprint:
                    current_mcp_identity[str(raw_name)] = fingerprint
        retained_mcp_env: dict[str, dict[str, str]] = {}
        for name, env in self._stored_mcp_env.items():
            fingerprint = current_mcp_identity.get(name, "")
            if fingerprint and (name in moved_mcp_names
                                or prior_mcp_identity.get(name) == fingerprint):
                retained_mcp_env[name] = env
            else:
                migrated = True
        self._stored_mcp_env = retained_mcp_env
        self._stored_mcp_identity = {
            name: current_mcp_identity[name] for name in retained_mcp_env
        }
        perms = raw.pop("permissions", {})
        # Remember which keys the user actually wrote, so a stored value that happens to equal a
        # default is never mistaken for "unset".
        self._explicit_keys = set(raw)
        # Releases through 0.26 wrote their then-default 40/80 iteration ceiling into every config,
        # making long, productive coding turns stop and ask the user to say "continue". Those values
        # were not evidence of an intentional limit, so migrate both historical defaults to the new
        # Codex-like unlimited setting. Any other positive custom value remains an explicit backstop.
        if raw.get("max_turns") in (40, 80):
            raw["max_turns"] = 0
            migrated = True
        # Releases through 0.41.7 defaulted think_budget_tokens to 8000 and save() writes every
        # default into config.json, so a stored 8000 is almost always that old default rather than
        # a chosen cap. It cut off Extra high below the thinking budget DGC itself requests, so it
        # becomes the per-level "auto" schedule. Any other number stays an explicit override.
        if raw.get("think_budget_tokens") == 8000:
            raw["think_budget_tokens"] = "auto"
            migrated = True
        # Releases through 0.41.7 defaulted tool_profile to "adaptive", which offered tools like
        # delegation, the background monitor or image reading only when the prompt's wording matched
        # a pattern — so an ask phrased differently (or with a typo) was told the tool did not
        # exist. save() wrote that default into every config, so a stored "adaptive" is almost
        # always the old default rather than a choice, and it becomes "standard" (every product
        # tool, every turn). It runs ONCE: `tool_profile_chosen` then marks the value as the user's,
        # so anyone who picks `adaptive` afterwards (a small local context window) keeps it.
        if raw.get("tool_profile") == "adaptive" and not raw.get("tool_profile_chosen"):
            raw["tool_profile"] = "standard"
            raw["tool_profile_chosen"] = True
            migrated = True
        self.data.update(raw)
        prior_provider_identity = _clean_provider_identity_map(
            secrets.get("provider_identity", {}))
        accepted_secrets: dict[str, str] = {}
        accepted_provider_identity: dict[str, str] = {}
        credential_warnings: list[str] = []
        search_secret = secrets.get("search_api_key")
        if isinstance(search_secret, str):
            accepted_secrets["search_api_key"] = search_secret
        elif "search_api_key" in secrets:
            migrated = True
        for key in _PROVIDER_SECRET_KEYS:
            if key not in secrets:
                continue
            value = secrets.get(key)
            identity = _provider_secret_identity(self.data, key)
            bound = prior_provider_identity.get(key, "")
            if isinstance(value, str) and (not value or (identity and (
                    key in migrated_provider_keys or bound == identity))):
                accepted_secrets[key] = value
                if value and identity:
                    accepted_provider_identity[key] = identity
                if value and key in migrated_provider_keys and bound != identity:
                    migrated = True
            else:
                # An unbound separate-file key is indistinguishable from a key left behind by a
                # crash after config.json changed. Never guess: the user can explicitly re-enter
                # it for the current endpoint, while the stale value is scrubbed from disk below.
                self.data[key] = ""
                migrated = True
                if isinstance(value, str) and value:
                    endpoint_key = _PROVIDER_SECRET_ENDPOINTS[key]
                    credential_warnings.append(
                        f"Stored {key} was not used because it was not bound to the configured "
                        f"{endpoint_key}; re-enter it or set {SECRET_ENV[key]} for this launch.")
        if set(prior_provider_identity) != set(accepted_provider_identity):
            migrated = True
        self._stored_secrets = accepted_secrets
        self._stored_provider_identity = accepted_provider_identity
        self.data.update(accepted_secrets)
        self._provider_secret_identity = {
            key: _provider_secret_identity(self.data, key) for key in _PROVIDER_SECRET_KEYS
        }
        self.credential_warnings = tuple(credential_warnings)
        for key, env_name in SECRET_ENV.items():
            # A launcher (the SDK) can hand a provider key through a private 0600 file instead of
            # the environment, whose initial block stays readable in /proc/<pid>/environ. We read
            # it and delete it here, at load — long before any tool subprocess can run.
            value = os.environ.get(env_name)
            if value is None:
                value = _read_secret_file(os.environ.get(env_name + "_FILE"))
            if value is not None:
                self.data[key] = value
                self._env_secret_keys.add(key)
                if key in _PROVIDER_SECRET_KEYS:
                    self._provider_secret_identity[key] = _provider_secret_identity(self.data, key)
        for action in ("allow", "ask", "deny"):
            self.permissions[action] = list(perms.get(action, []))
        # A launching process's policy that reviews permissions itself (project_allow=False, set by
        # an SDK session without workspace trust) must not let even the user's own stored allow
        # rules pre-approve a command — only its callback's runtime "always" answers may. This is
        # what makes the RuntimePolicy promise hold under inherit_user_state=True, where these
        # rules come from the real ~/.dgc. Ask/deny (which only tighten) are kept.
        if _policy_strips_allow():
            self.permissions["allow"] = []
        # Project-local permission rules load ONLY once the directory is trusted. Loading them
        # first and asking afterwards meant a cloned repository's `.dgc/permissions.json` was in
        # force before the trust gate ran — and under `dgc -p` the gate never runs at all.
        # trust.mark_trusted() applies them the moment trust is granted.
        self._project_permissions_applied = False
        from .trust import is_trusted
        if is_trusted(self, self.project_root):
            self.apply_project_permissions()
        # AFTER the migration write, not before. load() mutates `data` as it migrates old keys,
        # and those mutations are this process's changes: baselining first made them look like no
        # change at all, so a migrated config was never written. With no baseline yet, save()
        # writes everything, which is exactly right for a migration.
        if migrated:
            self.save()
        self._rebaseline()
        self._baseline_secrets = self._own_secrets()

    # ---- concurrent writers -----------------------------------------------------------------
    # Several backends share ~/.dgc/config.json: two VS Code windows today, and one per chat once
    # chats own their own backend. save() used to write this process's whole in-memory copy, so
    # the last writer won and everything the other had changed since IT loaded was reverted --
    # including permission rules. A `deny` added in one chat was erased by an unrelated settings
    # change in another, which fails OPEN.
    #
    # The fix is a locked read-modify-write that applies only what THIS process changed. What it
    # changed is computed against a baseline taken at load, so it catches direct mutation of
    # `data` and `permissions` too, not only calls to set(). `_explicit_keys` is NOT that baseline:
    # it is seeded with every key already on disk.
    def _rebaseline(self) -> None:
        import copy
        self._baseline_data = copy.deepcopy(self.data)
        self._baseline_permissions = copy.deepcopy(self.user_permissions())

    def hold_untrusted_mode(self) -> bool:
        """Run an untrusted workspace in `default`, without touching the user's stored mode.

        acceptEdits and auto act without asking, so they need workspace trust. The downgrade was
        written straight into `data` under a comment saying it was not persisted -- and the next
        save of anything wrote it: opening one untrusted folder reset the user's global `auto` to
        `default` everywhere. Ephemeral, so no save writes it and none adopts `auto` back over it.
        Returns whether it downgraded.
        """
        from .trust import is_trusted
        if self.mode not in ("acceptEdits", "auto") or is_trusted(self, self.project_root):
            return False
        ephemeral = self.__dict__.setdefault("_ephemeral_keys", set())
        if "mode" not in ephemeral:
            # Held, not one-shot: the hold stands in for the user only until they choose. Kept
            # ephemeral for life, every mode they chose afterwards was dropped too, and the stored
            # auto came back on the next launch even after they lowered it. See set().
            ephemeral.add("mode")
            self.__dict__.setdefault("_held_keys", set()).add("mode")
        self.data["mode"] = "default"
        return True

    def mark_ephemeral(self, *keys: str) -> None:
        """Hold these settings for THIS process only; no save may write them.

        A one-shot run (`dgc -p`) is a script or a benchmark: `--mode auto`, `--think high` and
        `--ultra` are for that invocation. They were applied straight into `self.data`, so the next
        `save()` from anywhere in the process -- `--trust` marking the workspace, a permission rule,
        a slash command -- persisted them as the user's standing configuration. Trusting a folder
        silently made `auto` the permanent permission mode.
        """
        self.__dict__.setdefault("_ephemeral_keys", set()).update(k for k in keys if k)

    def _my_changes(self) -> tuple[dict, dict, set]:
        """(changed keys, permission rules added, permission rules removed) since the baseline."""
        base = getattr(self, "_baseline_data", None)
        ephemeral = getattr(self, "_ephemeral_keys", None) or set()
        if base is None:
            return {k: v for k, v in self.data.items() if k not in ephemeral}, {}, set()
        changed = {k: v for k, v in self.data.items()
                   if k not in ephemeral and (k not in base or base[k] != v)}
        dropped = {k for k in base if k not in self.data}
        base_perms = getattr(self, "_baseline_permissions", None) or {}
        added: dict[str, list[str]] = {}
        removed: dict[str, list[str]] = {}
        for action in ("allow", "ask", "deny"):
            was = list(base_perms.get(action, []))
            now = list(self.user_permissions().get(action, []))
            added[action] = [r for r in now if r not in was]
            removed[action] = [r for r in was if r not in now]
        return changed, {"added": added, "removed": removed}, dropped

    def apply_project_permissions(self) -> bool:
        """Merge `<project>/.dgc/permissions.json` into the live rules (never persisted back).

        Idempotent, and the only path by which project-controlled rules reach the engine, so the
        caller must have established trust first. Returns whether anything was merged.
        """
        if getattr(self, "_project_permissions_applied", False):
            return False
        self._project_permissions_applied = True
        return self._add_project_rules(self._read_project_rules())

    def _read_project_rules(self) -> dict:
        """`<project>/.dgc/permissions.json` as rules per action; empty lists when there is none."""
        rules: dict = {"allow": [], "ask": [], "deny": []}
        proj_perms = self.project_dir / "permissions.json"
        try:
            pp = json.loads(proj_perms.read_text()) if proj_perms.exists() else {}
        except (OSError, json.JSONDecodeError):
            return rules
        if not isinstance(pp, dict):
            return rules
        actions = ("allow", "ask", "deny")
        if _policy_strips_allow():
            # The process that launched this session reviews commands itself (the SDK with a
            # RuntimePolicy): rules the workspace brings may narrow what runs, not pre-approve it.
            actions = ("ask", "deny")
        for action in actions:
            value = pp.get(action, [])
            if isinstance(value, list):
                rules[action] = [str(rule) for rule in value]
        return rules

    def _add_project_rules(self, rules: dict) -> bool:
        """Make `rules` live as the trusted project's. Returns whether there were any.

        Workspace rules are live for THIS project and never persisted. They are recorded rather
        than folded into the baseline, because save() needs them in two places: subtracted from
        what it writes, and put back after it rebuilds the live set from disk. Each list is
        replaced in one assignment, never grown in place, so a permission decision on another
        thread sees all of them or none.
        """
        contributed = self.__dict__.setdefault("_project_rules", {"allow": [], "ask": [], "deny": []})
        merged = False
        for action, added in rules.items():
            if added:
                self.permissions[action] = list(self.permissions.get(action, [])) + list(added)
                contributed[action] = list(contributed.get(action, [])) + list(added)
                merged = True
        return merged

    def inherit_trust(self, source: "Config") -> bool:
        """Take the trust of the project this checkout was made from.

        A TUI worktree or fleet agent works in a checkout of the launch project, rooted outside
        trusted_dirs (a sibling folder, or under ~/.dgc), so nothing loaded the project's rules:
        auto carried over and the project's deny vanished for any work moved there. A sub-agent's
        clone_for_root() view already shares its parent's rules; this gives the TUI's sessions the
        same. An untrusted source holds the mode instead. Returns whether the source is trusted.
        """
        from .trust import is_trusted
        if not is_trusted(source, source.project_root):
            self.hold_untrusted_mode()
            return False
        if not getattr(self, "_project_permissions_applied", False):
            self._project_permissions_applied = True
            self._add_project_rules(source._project_contribution())
        return True

    def _project_contribution(self) -> dict:
        """The trusted project's recorded rules that the live set still holds.

        The editor lists project and user rules together, so a project rule can be removed like
        any other. It stays removed for this session (there is nothing to write: it was never in
        the user's config) and returns with the project's file next session; save() drops it
        from the record. Read-only, and that is load-bearing: a read that pruned could land in
        another thread's save while the live lists were being rebuilt, and forget the project's
        deny for the rest of the session.
        """
        still: dict = {}
        for action, rules in (getattr(self, "_project_rules", None) or {}).items():
            live = list(self.permissions.get(action, []))
            kept = []
            for rule in rules:
                if rule in live:
                    live.remove(rule)
                    kept.append(rule)
            still[action] = kept
        return still

    def user_permissions(self) -> dict:
        """The live rules minus what the trusted project contributes: the user's own, which save()
        may write.

        One occurrence is removed per contributed rule, so a user rule that happens to equal a
        project rule survives: the live list holds it twice, and only the project's copy goes.
        """
        user = {a: list(self.permissions.get(a, [])) for a in ("allow", "ask", "deny")}
        for action, rules in self._project_contribution().items():
            for rule in rules:
                if rule in user.get(action, []):
                    user[action].remove(rule)
        return user

    def save(self) -> None:
        if not self._persist:
            return
        with _config_write_lock():
            on_disk = _read_config_payload(USER_CONFIG)
            changed, perms, dropped = self._my_changes()
            ephemeral = getattr(self, "_ephemeral_keys", None) or set()
            if on_disk is None:
                # First save on this machine: there is no baseline to diff against, so the whole
                # of self.data is written. Ephemeral keys must still be held back, or a one-shot
                # flag becomes the permanent configuration on exactly the machines that have none
                # yet -- which is every new install. Fall back to the DEFAULT for such a key so the
                # file states something true rather than omitting it.
                ephemeral = getattr(self, "_ephemeral_keys", None) or set()
                payload = {k: (DEFAULTS[k] if k in ephemeral and k in DEFAULTS else v)
                           for k, v in self.data.items()
                           if k not in SECRET_KEYS and not (k in ephemeral and k not in DEFAULTS)}
                # NOT self.permissions: on every new install the first save wrote a trusted project's
                # rules into the global file, and every other project -- untrusted ones included --
                # then inherited them. A project's `allow` became a global allow.
                payload["permissions"] = self.user_permissions()
            else:
                payload = {k: v for k, v in on_disk.items() if k != "permissions"}
                for key in dropped:
                    payload.pop(key, None)
                payload.update({k: v for k, v in changed.items() if k not in SECRET_KEYS})
                for key in _ENTRY_MERGED_KEYS:          # over the whole list `changed` holds
                    if key in changed:
                        # getattr: load() saves a migration BEFORE its first baseline, and a bare
                        # attribute read here made Config() raise at startup on every surface.
                        baseline = getattr(self, "_baseline_data", None) or {}
                        payload[key] = _merge_entries(on_disk.get(key), baseline.get(key),
                                                      self.data.get(key))
                for key in SECRET_KEYS:
                    payload.pop(key, None)
                base = on_disk.get("permissions")
                merged = {a: list((base or {}).get(a, [])) for a in ("allow", "ask", "deny")}
                for action in merged:
                    for rule in perms.get("removed", {}).get(action, []):
                        while rule in merged[action]:
                            merged[action].remove(rule)
                    for rule in perms.get("added", {}).get(action, []):
                        if rule not in merged[action]:
                            merged[action].append(rule)
                payload["permissions"] = merged
                # What is on disk is now what this process believes; anything another backend
                # wrote in the meantime is adopted rather than fought over.
                for key in _ENTRY_MERGED_KEYS:
                    if key in changed:
                        self.data[key] = list(payload[key])
                for key, value in payload.items():
                    # An ephemeral key is deliberately absent from `changed`, so without this it
                    # would be adopted back FROM DISK over the value this run was given -- a
                    # `--mode auto` would quietly stop applying the moment anything saved, and a
                    # stored `mode: auto` would be restored over an explicit one-shot downgrade.
                    if (key != "permissions" and key not in changed and key not in _SESSION_KEYS
                            and key not in ephemeral and key not in self._env_secret_keys):
                        self.data[key] = value
                own_allow = self.user_permissions()["allow"]
                contributed = self._project_contribution()     # a rule the user removed drops here
                # Trust another session granted arrives through the adopt loop above, but only load()
                # and mark_trusted() applied a project's rules: a second session in the same folder
                # became trusted -- auto allowed -- without the project's deny. Fails OPEN.
                if not getattr(self, "_project_permissions_applied", False):
                    from .trust import is_trusted
                    if is_trusted(self, self.project_root):
                        self._project_permissions_applied = True
                        for action, rules in self._read_project_rules().items():
                            contributed[action] = contributed.get(action, []) + rules
                # The disk never holds project rules, so a live set rebuilt from it had silently lost
                # them: one unrelated save -- changing the model -- and a trusted project's `deny`
                # stopped applying. Fails OPEN. Put back exactly what the project contributes.
                rebuilt = {a: list(merged[a]) + list(contributed.get(a, [])) for a in merged}
                if _policy_strips_allow():
                    # The user's stored allow rules were stripped at load because the launcher
                    # reviews commands itself. The rebuild from disk re-armed every one of them, and
                    # the callback's own first "always" answer is a save. Keep what THIS process
                    # approved, nothing else.
                    rebuilt["allow"] = list(own_allow)
                self._project_rules = contributed
                # Each final list is published in ONE assignment, and into this same dict: built
                # step by step in the live dict, a permission decision on another thread could land
                # between steps and see the stored allows re-armed or the project's deny missing.
                # And never rebound: clone_for_root() hands every running sub-agent THIS dict, so a
                # rule the user adds mid-run reaches them; rebinding cut them off at the first save.
                for action in ("allow", "ask", "deny"):
                    self.permissions[action] = rebuilt[action]
            _write_private_json(USER_CONFIG, payload)
            self._rebaseline()
            self._save_secrets()

    def _own_secrets(self) -> dict:
        """What this process would store: each key with the endpoint identity it is bound to.

        Environment-provided credentials are ephemeral references. A harmless settings change
        must never copy a CI/process secret into ~/.dgc/secrets.json. Provider credentials carry
        the normalized endpoint identity they were issued for, so either half of an interrupted
        two-file update fails closed on the next load.
        """
        search_value = (self._stored_secrets.get("search_api_key", "")
                        if "search_api_key" in self._env_secret_keys
                        else self.data.get("search_api_key", ""))
        own: dict = {"search_api_key": (search_value if isinstance(search_value, str) else "", "")}
        for key in _PROVIDER_SECRET_KEYS:
            if key in self._env_secret_keys:
                value = self._stored_secrets.get(key, "")
                bound = self._stored_provider_identity.get(key, "")
            else:
                value = self.data.get(key, "")
                bound = self._provider_secret_identity.get(key, "")
            expected = _provider_secret_identity(self.data, key)
            if isinstance(value, str) and value and expected and bound == expected:
                own[key] = (value, expected)
            else:
                own[key] = ("", "")
        own["mcp"] = {name: (copy.deepcopy(env), self._stored_mcp_identity.get(name, ""))
                      for name, env in self._stored_mcp_env.items()}
        return own

    def _save_secrets(self) -> None:
        """Write ~/.dgc/secrets.json the way save() writes config.json: what is on disk, with this
        process's own changes since its baseline applied.

        It was written whole. With two sessions open, one switching endpoint and key, the other's
        next save of anything wrote its own view back: the new key was wiped, and every new session
        failed to authenticate until the key was entered again.
        """
        now, was = self._own_secrets(), getattr(self, "_baseline_secrets", None)
        disk: dict = {}
        if was is not None and USER_SECRETS.exists():
            try:
                value = json.loads(USER_SECRETS.read_text())
                disk = value if isinstance(value, dict) else {}
            except (OSError, json.JSONDecodeError):
                disk = {}
        disk_identity = disk.get("provider_identity") if isinstance(disk.get("provider_identity"), dict) else {}
        secrets: dict = {}
        stored_provider_identity: dict[str, str] = {}
        for key in ("search_api_key", *sorted(_PROVIDER_SECRET_KEYS)):
            if was is None or now[key] != was.get(key):
                value, identity = now[key]
            else:
                value = disk.get(key, "") if isinstance(disk.get(key, ""), str) else ""
                identity = str(disk_identity.get(key, "") or "")
            secrets[key] = value
            if key in _PROVIDER_SECRET_KEYS and value and identity:
                stored_provider_identity[key] = identity
        mcp_env = _clean_mcp_secret_map(disk.get("mcp_env", {})) if was is not None else {}
        mcp_identity = _clean_mcp_identity_map(disk.get("mcp_identity", {})) if was is not None else {}
        before = (was or {}).get("mcp", {})
        for name in set(now["mcp"]) | set(before):
            if was is not None and now["mcp"].get(name) == before.get(name):
                continue                                  # not ours to change: disk's stands
            mcp_env.pop(name, None)
            mcp_identity.pop(name, None)
            if name in now["mcp"]:
                mcp_env[name], mcp_identity[name] = now["mcp"][name]
        self._stored_secrets = {key: value for key, value in secrets.items() if key in SECRET_KEYS}
        self._stored_provider_identity = stored_provider_identity
        if stored_provider_identity:
            secrets["provider_identity"] = copy.deepcopy(stored_provider_identity)
        if mcp_env:
            secrets["mcp_env"] = copy.deepcopy(mcp_env)
            secrets["mcp_identity"] = {name: mcp_identity.get(name, "") for name in mcp_env}
        _write_private_json(USER_SECRETS, secrets)
        self._baseline_secrets = self._own_secrets()

    def clone_for_root(self, project_root: Path) -> "Config":
        """Return a non-persisting configuration view rooted at an isolated checkout.

        Sub-agents must inherit the live provider and permission state, but changing their mode or
        route must not rewrite the user's global settings. Project-relative permission rules remain
        valid at the new root; sharing the permission containers also makes a user's live "always"
        approval visible to both the parent and child for the rest of the session.
        """
        clone = object.__new__(Config)
        clone.project_root = Path(project_root).resolve(strict=False)
        clone.project_dir = clone.project_root / ".dgc"
        clone._persist = False
        clone.data = copy.deepcopy(self.data)
        clone._stored_secrets = dict(self._stored_secrets)
        clone._stored_provider_identity = dict(self._stored_provider_identity)
        clone._provider_secret_identity = dict(self._provider_secret_identity)
        clone._stored_mcp_env = copy.deepcopy(self._stored_mcp_env)
        clone._stored_mcp_identity = dict(self._stored_mcp_identity)
        clone._env_secret_keys = set(self._env_secret_keys)
        clone._explicit_keys = set(getattr(self, "_explicit_keys", set()))
        clone.credential_warnings = tuple(self.credential_warnings)
        clone.permissions = self.permissions
        if hasattr(self, "session_permissions"):
            clone.session_permissions = self.session_permissions
        return clone

    def get(self, key: str, default=None):
        data = getattr(self, "data", {})
        bindings = getattr(self, "_provider_secret_identity", None)
        if key in _PROVIDER_SECRET_KEYS and bindings is not None:
            bound = bindings.get(key, "") if isinstance(bindings, dict) else ""
            if bound != _provider_secret_identity(data, key):
                return ""
        return data.get(key, default) if isinstance(data, dict) else default

    def is_explicit(self, key: str) -> bool:
        """True when `key` was present in the user's config.json rather than inherited."""
        return key in getattr(self, "_explicit_keys", set())

    def set(self, key: str, value, *, persist: bool = True) -> None:
        # Provider credentials are endpoint-scoped. Reusing an old key after a host change can
        # disclose a cloud credential to an unrelated server, so invalidate both the live and
        # persisted value before saving the new route. A caller that owns the new key sets it next.
        if key in _PROVIDER_SECRET_ENDPOINTS.values():
            future = dict(self.data)
            future[key] = value
            for secret in _PROVIDER_SECRET_KEYS:
                if (_provider_secret_identity(self.data, secret)
                        != _provider_secret_identity(future, secret)):
                    self.data[secret] = ""
                    self._stored_secrets[secret] = ""
                    self._stored_provider_identity.pop(secret, None)
                    self._provider_secret_identity.pop(secret, None)
                    self._env_secret_keys.discard(secret)
        if key == "mcp_servers" and isinstance(value, dict):
            previous = self.data.get("mcp_servers", {})
            previous = previous if isinstance(previous, dict) else {}
            # A catalog replacement must never make a credential migrated for an older executable
            # available to a different same-name server.  Explicit UI upserts additionally clear
            # the name even when only a process-local credential changed.
            for name in list(self._stored_mcp_env):
                if name not in value or previous.get(name) != value.get(name):
                    self._stored_mcp_env.pop(name, None)
                    self._stored_mcp_identity.pop(name, None)
        held = getattr(self, "_held_keys", None)
        if held and key in held:
            held.discard(key)                          # the user chose: the hold is over
            self._ephemeral_keys.discard(key)
        self.data[key] = value
        if key == "tool_profile":
            # Setting it is choosing it: the one-shot 0.41.7 migration must never take it back.
            self.data["tool_profile_chosen"] = True
            self._explicit_keys.add("tool_profile_chosen")
        if key in _PROVIDER_SECRET_KEYS:
            identity = _provider_secret_identity(self.data, key)
            if value and identity:
                self._provider_secret_identity[key] = identity
            else:
                self._provider_secret_identity.pop(key, None)
                self._stored_provider_identity.pop(key, None)
        if key not in SECRET_KEYS:
            self._explicit_keys.add(key)
        if persist:
            self.save()

    def set_runtime_secret(self, key: str, value: str) -> None:
        """Install an environment/editor-owned provider key without persisting its value."""
        if key not in _PROVIDER_SECRET_KEYS:
            raise KeyError(key)
        self.data[key] = str(value or "")
        identity = _provider_secret_identity(self.data, key)
        if self.data[key] and identity:
            self._provider_secret_identity[key] = identity
        else:
            self._provider_secret_identity.pop(key, None)
        self._env_secret_keys.add(key)

    def mcp_runtime_servers(self, servers=None) -> dict:
        """Return a detached MCP catalog with owner-private legacy secrets restored at runtime."""
        source = self.data.get("mcp_servers", {}) if servers is None else servers
        if not isinstance(source, dict):
            return {}
        runtime = copy.deepcopy(source)
        for raw_name, raw_spec in list(runtime.items())[:_MAX_MCP_SECRET_SERVERS]:
            if not isinstance(raw_spec, dict):
                continue
            name = str(raw_name)
            declared = raw_spec.get("env_names")
            declared = declared if isinstance(declared, list) else []
            stored = self._stored_mcp_env.get(name, {})
            if self._stored_mcp_identity.get(name) != _mcp_spec_fingerprint(raw_spec):
                stored = {}
            env = {key: value for key, value in stored.items() if key in declared}
            if env:
                raw_spec["env"] = env
        return runtime

    def drop_mcp_secrets(self, name: str) -> None:
        """Forget migrated MCP credentials when their server is removed."""
        key = str(name)
        removed = self._stored_mcp_env.pop(key, None) is not None
        removed = self._stored_mcp_identity.pop(key, None) is not None or removed
        if removed:
            self.save()

    # convenience accessors -------------------------------------------------
    @property
    def base_url(self) -> str:
        return str(self.data["base_url"]).rstrip("/")

    @property
    def api_key(self) -> str:
        return str(self.get("api_key", ""))

    @property
    def model(self) -> str:
        return str(self.data["model"])

    @property
    def mode(self) -> str:
        return str(self.data["mode"])

    @mode.setter
    def mode(self, value: str) -> None:
        self.set("mode", value)

    @property
    def thinking(self) -> str:
        return str(self.data["thinking"])

    @thinking.setter
    def thinking(self, value: str) -> None:
        self.set("thinking", value)
