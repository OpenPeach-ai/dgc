"""Configuration for dgc: global (~/.dgc/config.json) + project (.dgc/)."""
from __future__ import annotations

import copy
import hashlib
import contextlib
import json
import math
import os
import re
import stat
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


def _repair_user_home_permissions() -> None:
    """Narrow an older DGC home only when it is a real directory owned by us."""
    if os.name != "posix":
        return
    fd = None
    try:
        fd = os.open(USER_HOME, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
                     | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0))
        info = os.fstat(fd)
        if stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid() and info.st_mode & 0o077:
            os.fchmod(fd, 0o700)
    except OSError:
        pass                         # Pips Controls still refuses an unsafe directory
    finally:
        if fd is not None:
            os.close(fd)


def dgc_home() -> Path:
    """DGC's own folder (``~/.dgc``, or ``$DGC_HOME/.dgc``), read now: an isolated SDK session's runtime files (peer
    notes, the image spool) stay in its own home, never the account's. Workspace locks stay the account's
    (scheduler._lock_directory): they protect the user's project files, which every DGC shares."""
    return _user_home_root() / ".dgc"
USER_CONFIG = USER_HOME / "config.json"
# The most sub-agents that may run at once (max_parallel_tasks). A cautious bound, not a technical one: each is its
# own checkout of the project and its own stream of model requests, so the cost is disk, rate limits and a server's
# own parallelism (a local Ollama serves OLLAMA_NUM_PARALLEL at once; the rest wait). Every clamp reads this.
MAX_PARALLEL_TASKS = 32
USER_SECRETS = USER_HOME / "secrets.json"
USER_MEMORY = USER_HOME / "DGC.md"
USER_SKILLS = USER_HOME / "skills"
PORTABLE_USER_SKILLS = _user_home_root() / ".agents" / "skills"
USER_AGENTS = USER_HOME / "agents"
BUILTIN_SKILLS = Path(__file__).resolve().parent / "skills_builtin"  # skills shipped with dgc
# Web search keys: each provider that takes one keeps its own. One shared `search_api_key` stayed when the provider
# changed, so a Brave key was sent to Tavily, or to ollama.com as a Bearer token. A search sends only the key saved
# for the provider in use.
SEARCH_KEY_PROVIDERS = ("brave", "tavily", "ollama")
SEARCH_KEYS = {provider: f"search_api_key_{provider}" for provider in SEARCH_KEY_PROVIDERS}
# The one shared key older releases kept. It is never stored any more: load() moves it to the slot of the provider
# selected then, and `search_api_key` stays only as a name for "the selected provider's own key" (get/set below,
# set_config from an older editor).
LEGACY_SEARCH_KEY = "search_api_key"
# A shared key found while a provider that takes none (DuckDuckGo, SearXNG) was selected: whose it is can't be
# told, so it is kept here, in secrets.json, and never sent anywhere.
SEARCH_KEY_UNASSIGNED = "search_api_key_unassigned"
_SEARCH_SECRET_KEYS = (*SEARCH_KEYS.values(), SEARCH_KEY_UNASSIGNED)


# DGC_SEARCH_API_KEY belongs to the provider selected when this process first read it from this settings file.
# `dgc serve` builds a Config for every chat it opens: one opened after a switch of provider must not hand the key
# to the new provider. Keyed by (a hash of the key, the settings file); the value is that provider's slot, or "".
_SEARCH_ENV_SLOTS: dict[tuple[str, str], str] = {}


def search_key_name(provider) -> str:
    """The secrets.json name of `provider`'s own web search key; "" for a provider that takes none."""
    return SEARCH_KEYS.get(str(provider or "").strip().lower(), "")


def search_settings(config) -> tuple[str, str, str]:
    """(provider, the key saved for THAT provider, the SearXNG address), read together from one config, so a key is
    never paired with another provider's search."""
    provider = str(config.get("search_provider", "duckduckgo") or "duckduckgo")
    slot = search_key_name(provider)
    key = config.get(slot, "") if slot else ""
    return provider, (key if isinstance(key, str) else ""), str(config.get("search_url", "") or "")


SECRET_KEYS = frozenset({"api_key", "subagent_api_key", "fallback_api_key", LEGACY_SEARCH_KEY,
                         *_SEARCH_SECRET_KEYS})
# DGC_SEARCH_API_KEY is the key of the provider selected when DGC starts, and only that provider's (load()).
SECRET_ENV = {"api_key": "DGC_API_KEY", LEGACY_SEARCH_KEY: "DGC_SEARCH_API_KEY",
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


# Query fields that look like credentials by name but are fixed, public switches in a vendor's
# documented server address. AWS's MCP server starts OAuth only with ?oauth=initialize.
_MCP_PUBLIC_QUERY = frozenset({("oauth", "initialize")})


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
                    _mcp_sensitive_name(key) and (key, _item) not in _MCP_PUBLIC_QUERY
                    for key, _item in parameters):
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
        if lowered.startswith(("http://", "https://")):
            # A server address is judged as a URL (its userinfo, query and fragment), not as a
            # --name=value flag: "...mcp?oauth=initialize" is AWS's public switch, not a secret.
            # The flag before it still counts (--token https://... is a credential).
            if (mcp_url_has_credentials(raw) or prior == "--header" or prior_raw == "-H"
                    or prior_head in _MCP_SECRET_FLAGS or normalized_prior in _MCP_SECRET_FLAG_NAMES
                    or _mcp_sensitive_name(prior_head.lstrip("-"))):
                return False
            continue
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
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
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
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
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
    "prompt_cache_ttl": "5m",                   # Anthropic cache-entry lifetime: "5m" (a write costs 1.25x
                                                #   input) or "1h" (2x; for replies more than 5 minutes apart)
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
    "model_context_sizes": {},                  # the window you chose for each model ({model: tokens}):
                                                #   switching back to a model restores it (written by DGC)
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
                                                #   response headers; the stall watcher normally acts first.
                                                #   A model on this computer or network is checked with its
                                                #   server instead (a day's silence is the last backstop)
    # Stall watcher: a model request that hangs without an error (no headers, a silent stream, or
    # keep-alives with no tokens) is closed, retried, then reported by model and endpoint. A local
    # request is never re-sent while its server says it is still working on it (dgc/server_check.py).
    "model_first_token_timeout_s": "auto",      # seconds until the first real delta; "auto" = no limit
                                                #   for a model on this computer or network, 300 remote;
                                                #   0 = no limit (Settings: Wait for the first word)
    "model_idle_timeout_s": 300,                # seconds without a token mid-stream before it is a stall
                                                #   (partial output is continued, not discarded); 0 = off
                                                #   (Settings: Wait between words)
    "pips_enabled": True,                      # Pips: personal and project agents beside the chat
    "pips_parallel_runs": 4,                   # Pips running at once, one run per Pip (pips.parallel_runs)
    "pips_model": "",                          # the model every Pip on Default uses, on DGC's own connection;
                                               #   "" follows DGC (its model, or its subscription CLI)
    "model_stall_notice_s": 45,                 # say "no response from the model" after this long; 0 = never
    "model_stall_retries": 2,                   # re-issues after a stall before fallback_model or failing
    "model_load_timeout_s": "auto",             # self-hosted Ollama: how long a model may show as loading;
                                                #   "auto" = no limit on this computer or network, 900 elsewhere
    "approval_timeout_s": 300,                  # bounded MCP input; native human decisions wait for reply/Stop
    "compact_threshold": 0.85,                  # summarize older turns at this fraction of context_size
    "recall_max_bytes": 524288,                 # /recall scrollback archive per session (0.5 MiB)
    "notes": True,                              # keep a searchable per-project trace of what was learned
    "memory": True,                             # one memory about you, shared by ChatDGC, Work and Pips
    "memory_review_idle_s": 120,                # a chat this quiet is looked back over for what to remember
    "chatdgc_web": True,                        # ChatDGC searches the web when an answer depends on it
    "chatdgc_followups": True,                  # ChatDGC suggests next messages under a reply
    "notes_max_rows": 5000,                     # oldest notes are pruned past this, per project
    "mouse": "capture",                         # capture (wheel scrolls DGC, rows clickable) | off (terminal selection)
    "session_redaction": True,                  # strip credentials from durable transcript/plan history;
                                                # exact file rewind snapshots stay private and unchanged
    "search_provider": "duckduckgo",            # duckduckgo (keyless) | brave | tavily | searxng | ollama
    # Each provider's own key, kept in secrets.json (never here) and sent only to that provider. Ollama's is
    # an ollama.com key, used only when the Ollama on this computer can't search.
    "search_api_key_brave": "",
    "search_api_key_tavily": "",
    "search_api_key_ollama": "",
    "search_url": "",                           # for searxng (self-hosted base URL)
    "browser_path": "",                         # explicit Chrome/Chromium; else CHROME_PATH, the
                                                # Playwright cache, PATH, the usual locations, then
                                                # the Chrome DGC fetches (browser_setup)
    "browser_allow_unsandboxed": False,         # run the browser with --no-sandbox where the distro
                                                # blocks user namespaces and bubblewrap can't box it;
                                                # a page exploit is then no longer contained, so
                                                # this stays opt-in
    "mcp_servers": {},                          # name -> {command, args, env} stdio MCP servers
    "disabled_skills": [],                     # skill names disabled across native/delegated clients
    "disabled_mcp_servers": [],                # lifecycle state separate from credential identity
    "plugin_credentials_store": "auto",        # remote plugin sign-ins: auto (the system keychain, else an
                                                # owner-only file) | keyring (keychain or fail) | file
    # Sign in with GitHub on the GitHub plugin's page: the client id of a GitHub OAuth App with its device flow on
    # (no secret). Blank until DGC ships OpenPeach's in plugin_catalog.json; set here to try one before then.
    "github_sign_in_client_id": "",
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
    "subagent_thinking": "",                    # helpers' thinking: "" the main chat's | off | low | medium | high | xhigh
    "subagent_worktree_root": "",                # private task checkout storage (empty: ~/.dgc/worktrees)
    "subagent_link_paths": [],                   # opt-in: ignored dirs shared INTO task checkouts (e.g. node_modules)
    "fleet_worktree_root": "",                   # private TUI fleet checkouts (empty: ~/.dgc/fleet-worktrees)
    "max_parallel_tasks": 4,                     # 1 disables; up to MAX_PARALLEL_TASKS concurrent isolated workers
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

# Web-search providers — DuckDuckGo is keyless (the default floor); the rest need a key or a URL. Ollama's key is
# optional: a signed-in Ollama on this computer searches without one (dgc/search.py).
SEARCH_PROVIDERS: dict[str, dict] = {
    "duckduckgo": {"label": "DuckDuckGo (keyless, default)",  "needs_key": False, "needs_url": False},
    "brave":      {"label": "Brave Search (API key)",         "needs_key": True,  "needs_url": False},
    "tavily":     {"label": "Tavily (API key)",               "needs_key": True,  "needs_url": False},
    "searxng":    {"label": "SearXNG (self-hosted base URL)", "needs_key": False, "needs_url": True},
    "ollama":     {"label": "Ollama web search (your Ollama sign-in, or an ollama.com API key)",
                   "needs_key": False, "needs_url": False, "optional_key": True},
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


def bound_provider_key(config, secret_key: str, base_url: str) -> str:
    """The saved provider key ``secret_key`` (api_key, subagent_api_key, fallback_api_key) when ``base_url`` is the
    endpoint it is bound to, else "". A sub-agent or fallback key with no host of its own is bound to the main host,
    and "" for ``base_url`` means that inherited host, as the route resolves it. Endpoints compare as the binding
    does: canonical spelling, never a prefix or the same host on another path."""
    endpoint_key = _PROVIDER_SECRET_ENDPOINTS.get(secret_key)
    if endpoint_key is None:
        return ""
    try:
        key = config.get(secret_key, "")        # "" already when the stored binding no longer holds
    except Exception:                           # noqa: BLE001 -- a stub config: no saved key
        return ""
    data = getattr(config, "data", None)
    if not isinstance(key, str) or not key or not isinstance(data, dict):
        return ""
    bound = _provider_secret_identity(data, secret_key)
    asked = _provider_secret_identity({**data, endpoint_key: str(base_url or "").strip()}, secret_key)
    return key if bound and bound == asked else ""


# ---- Saved model providers a Pip runs on (0.51) ---------------------------------------------------
# The editor owns the list of saved providers (Settings -> Models). A Pip's runs happen with no window, so the provider
# a Pip was set to is kept here too: only that one, whole, in secrets.json. Its key sits beside its address in one
# record, so the two can't come apart. It is never in config.json or the `data` every listing reads.
SAVED_PROVIDERS = "saved_providers"
_SAVED_PROVIDER_ID = re.compile(r"provider_[0-9a-f]{32}\Z")
_SAVED_PROVIDER_FIELDS = ("name", "base_url", "api_mode", "model", "api_key")
_MAX_SAVED_PROVIDERS = 16


def _clean_saved_providers(value) -> dict[str, dict[str, str]]:
    """The saved providers that can be used; anything else in the block is left out."""
    if not isinstance(value, dict):
        return {}
    kept: dict[str, dict[str, str]] = {}
    for provider_id, record in list(value.items())[:_MAX_SAVED_PROVIDERS]:
        if (isinstance(provider_id, str) and _SAVED_PROVIDER_ID.match(provider_id) and isinstance(record, dict)
                and all(isinstance(record.get(field), str) for field in _SAVED_PROVIDER_FIELDS)
                and record["base_url"] and len(record["api_key"]) <= 16_384):
            kept[provider_id] = {field: record[field] for field in _SAVED_PROVIDER_FIELDS}
    return kept


# ---- DGC Router (0.51): the user's other computers that run models --------------------------------
# The `router` block is NOT in DEFAULTS: with the Router never set up, config.json, the editor's config event and every
# listing stay exactly as 0.50 had them. router_block() reads it (validated, with defaults); set_router() writes it.
# A system's key is never in the block: it lives in secrets.json as router_key_<id>, bound to that system's address
# the way subagent_api_key is bound to subagent_base_url (Config.router_key).
ROUTER_SERVERS = ("ollama", "llamacpp", "vllm", "sglang", "lmstudio", "tgi", "openai_compatible", "comfyui", "a1111")
# "images": an image generator that names the system holds one of its workers while it makes a picture (dgc/images.py).
ROUTER_JOBS = ("subagents", "pips", "images")
ROUTER_IMAGE_SERVERS = ("comfyui", "a1111")         # image servers: the images job only, and no models
ROUTER_WHEN_BUSY = ("wait", "default")
ROUTER_HARDWARE = ("none", "exporter", "node", "ssh")
ROUTER_API_MODES = ("", "auto", "ollama", "anthropic", "chat_completions", "responses")
ROUTER_MAX_SYSTEMS = 32
ROUTER_MAX_MODELS = 64
ROUTER_MAX_WORKERS = 64
ROUTER_DEFAULT_CONTEXT = 32_768
ROUTER_KEY_PREFIX = "router_key_"
_ROUTER_ID_RE = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?\Z")
_ROUTER_MODEL_RE = re.compile(r"[A-Za-z0-9_][A-Za-z0-9._:/@+\-]{0,255}\Z")
_ROUTER_SYSTEM_KEYS = frozenset({"id", "name", "base_url", "server", "api_mode", "enabled", "jobs", "workers",
                                 "one_model_at_a_time", "memory_gb", "models", "hardware"})
_ROUTER_MODEL_KEYS = frozenset({"name", "workers", "context", "note", "use", "params_b", "tools", "thinking"})
# How hard a helper thinks (Settings → Models → Sub-agents → Thinking): "" is the main chat's level.
SUBAGENT_THINKING = ("", "off", "low", "medium", "high", "xhigh")
# A DGC Router model's own choice: "" is the helper's level; a small model on a NAS usually runs best Off or Low.
ROUTER_MODEL_THINKING = ("", "off", "low", "medium", "high")


def router_defaults() -> dict:
    return {"enabled": False, "when_busy": "wait", "systems": []}


def router_slug(text) -> str:
    """A system id from a name: lowercase letters, digits and dashes, at most 32 ("" when nothing is left)."""
    slug = re.sub(r"[^a-z0-9]+", "-", str(text or "").strip().lower()).strip("-")[:32].strip("-")
    return slug


def router_base_url(value) -> tuple[str, str]:
    """(canonical address, problem). A bare host (``gpu-box.local``) becomes ``http://gpu-box.local``; a trailing
    ``/v1`` is dropped (DGC adds the path each server needs). Never credentials, a query or a fragment."""
    raw = str(value or "").strip()
    if not raw:
        return "", "an address is needed"
    if len(raw) > 2048 or any(ord(c) < 33 or ord(c) == 127 for c in raw):
        return "", "the address has spaces or control characters"
    if "://" not in raw:
        raw = "http://" + raw
    try:
        parts = urlsplit(raw)
        port = parts.port
    except ValueError:
        return "", "the address is not a valid URL"
    if parts.scheme.lower() not in ("http", "https") or not parts.hostname:
        return "", "the address must be http:// or https:// and name a host"
    if parts.username or parts.password or "@" in parts.netloc:
        return "", "the address must not hold a user name or password (keys go in the key field)"
    if parts.query or parts.fragment:
        return "", "the address must not have a query or fragment"
    host = parts.hostname.lower()
    if ":" in host:
        host = f"[{host}]"
    netloc = host + (f":{port}" if port is not None else "")
    path = parts.path.rstrip("/")
    if re.search(r"/v1\Z", path, re.IGNORECASE):
        path = path[:-3]
    return urlunsplit((parts.scheme.lower(), netloc, path, "", "")), ""


def router_hardware_url(value) -> tuple[str, str]:
    """(canonical address, problem) of a hardware readout: an exporter's page (``http://nas.local:9100/metrics``),
    Glances' API (``http://mac.local:61208/api/4``), Netdata's (``http://nas.local:19999/api/v1``) or a dgc node
    (``http://gpu-box.local:8577``). A bare host becomes ``http://host``; the path is kept. Never credentials, a
    query or a fragment: a token goes in secrets.json."""
    raw = str(value or "").strip()
    if not raw:
        return "", "an address is needed"
    if len(raw) > 2048 or any(ord(c) < 33 or ord(c) == 127 for c in raw):
        return "", "the address has spaces or control characters"
    if "://" not in raw:
        raw = "http://" + raw
    try:
        parts = urlsplit(raw)
        port = parts.port
    except ValueError:
        return "", "the address is not a valid URL"
    if parts.scheme.lower() not in ("http", "https") or not parts.hostname:
        return "", "the address must be http:// or https:// and name a host"
    if parts.username or parts.password or "@" in parts.netloc:
        return "", "the address must not hold a user name or password (a token goes in its own field)"
    if parts.query or parts.fragment:
        return "", "the address must not have a query or fragment (a token goes in its own field)"
    host = parts.hostname.lower()
    if ":" in host:
        host = f"[{host}]"
    netloc = host + (f":{port}" if port is not None else "")
    return urlunsplit((parts.scheme.lower(), netloc, parts.path.rstrip("/"), "", "")), ""


def _router_int(value, low: int, high: int, default: int, what: str, problems: list[str]) -> int:
    if value is None:
        return default
    if (isinstance(value, bool) or not isinstance(value, (int, float))
            or isinstance(value, float) and (not math.isfinite(value) or not value.is_integer())):
        problems.append(f"{what} must be a whole number")
        return default
    value = int(value)
    if not low <= value <= high:
        problems.append(f"{what} must be between {low:,} and {high:,}")
        return min(high, max(low, value))
    return value


def _router_model(raw, where: str, problems: list[str]) -> dict | None:
    if isinstance(raw, str):
        raw = {"name": raw}
    if not isinstance(raw, dict):
        problems.append(f"{where} must be an object with a model name")
        return None
    extra = sorted(set(raw) - _ROUTER_MODEL_KEYS)
    if extra:
        problems.append(f"{where} has an unknown setting: {extra[0]}")
    name = raw.get("name")
    if not isinstance(name, str) or not _ROUTER_MODEL_RE.fullmatch(name) or "://" in name:
        problems.append(f"{where} needs a model name (letters, digits and . _ : / @ + -)")
        return None
    model = {"name": name,
             "workers": _router_int(raw.get("workers"), 1, ROUTER_MAX_WORKERS, 1, f"{where}.workers", problems),
             "context": _router_int(raw.get("context"), 2_048, 16_777_216, ROUTER_DEFAULT_CONTEXT,
                                    f"{where}.context", problems)}
    note = raw.get("note", "")
    if not isinstance(note, str):
        problems.append(f"{where}.note must be text")
        note = ""
    note = " ".join(note.split())
    if len(note) > 200:
        problems.append(f"{where}.note is longer than 200 characters")
        note = note[:200]
    if note:
        model["note"] = note
    if "use" in raw:
        if not isinstance(raw["use"], bool):
            problems.append(f"{where}.use must be true or false")
        elif raw["use"] is False:
            model["use"] = False
    if raw.get("params_b") is not None:
        size = raw["params_b"]
        if isinstance(size, bool) or not isinstance(size, (int, float)) or not 0 < float(size) <= 100_000:
            problems.append(f"{where}.params_b must be the model's size in billions of parameters")
        else:
            model["params_b"] = round(float(size), 3)
    if "tools" in raw:
        if not isinstance(raw["tools"], bool):
            problems.append(f"{where}.tools must be true or false")
        else:
            model["tools"] = raw["tools"]
    if raw.get("thinking") not in (None, ""):
        if raw["thinking"] not in ROUTER_MODEL_THINKING:
            problems.append(f"{where}.thinking must be off, low, medium or high (or empty: the helper's own level)")
        else:
            model["thinking"] = raw["thinking"]
    return model


def _router_system(raw, place: int, problems: list[str]) -> dict | None:
    where = f"systems[{place}]"
    if not isinstance(raw, dict):
        problems.append(f"{where} must be an object")
        return None
    if any(str(key).lower() in ("key", "api_key", "token") for key in raw):
        problems.append(f"{where}: a key is never kept in the router settings; it goes in secrets.json "
                        f"(Settings, /router key or dgc router edit --key)")
    extra = sorted(str(key) for key in set(raw) - _ROUTER_SYSTEM_KEYS
                   if str(key).lower() not in ("key", "api_key", "token"))
    if extra:
        problems.append(f"{where} has an unknown setting: {extra[0]}")
    name = raw.get("name")
    system_id = raw.get("id")
    if system_id is None or system_id == "":
        system_id = router_slug(name)
    if not isinstance(system_id, str) or not _ROUTER_ID_RE.fullmatch(system_id):
        problems.append(f"{where}.id must be 1-32 lowercase letters, digits or dashes")
        return None
    if name is None or name == "":
        name = system_id
    if not isinstance(name, str) or not 1 <= len(" ".join(name.split())) <= 64:
        problems.append(f"{where}.name must be 1-64 characters")
        name = system_id
    base_url, problem = router_base_url(raw.get("base_url"))
    if problem:
        problems.append(f"{where}.base_url: {problem}")
        return None
    server = raw.get("server") or "openai_compatible"
    if server not in ROUTER_SERVERS:
        problems.append(f"{where}.server must be one of {', '.join(ROUTER_SERVERS)}")
        server = "openai_compatible"
    api_mode = raw.get("api_mode") or ""
    if api_mode not in ROUTER_API_MODES:
        problems.append(f"{where}.api_mode must be one of {', '.join(m for m in ROUTER_API_MODES if m)} or empty")
        api_mode = ""
    enabled = raw.get("enabled", True)
    if not isinstance(enabled, bool):
        problems.append(f"{where}.enabled must be true or false")
        enabled = True
    standard = ["images"] if server in ROUTER_IMAGE_SERVERS else ["subagents", "pips"]
    jobs = raw.get("jobs", standard)
    if not isinstance(jobs, list) or any(job not in ROUTER_JOBS for job in jobs):
        problems.append(f"{where}.jobs takes {', '.join(ROUTER_JOBS)}")
        jobs = [job for job in jobs if job in ROUTER_JOBS] if isinstance(jobs, list) else standard
    jobs = [job for job in ROUTER_JOBS if job in jobs]
    if server in ROUTER_IMAGE_SERVERS and set(jobs) - {"images"}:
        problems.append(f"{where}: an image server ({server}) does the images job only")
        jobs = ["images"]
    one = raw.get("one_model_at_a_time", False)
    if not isinstance(one, bool):
        problems.append(f"{where}.one_model_at_a_time must be true or false")
        one = False
    models_raw = raw.get("models", [])
    if not isinstance(models_raw, list):
        problems.append(f"{where}.models must be a list")
        models_raw = []
    if len(models_raw) > ROUTER_MAX_MODELS:
        problems.append(f"{where} lists more than {ROUTER_MAX_MODELS} models")
        models_raw = models_raw[:ROUTER_MAX_MODELS]
    models, seen = [], set()
    for index, item in enumerate(models_raw, 1):
        model = _router_model(item, f"{where}.models[{index}]", problems)
        if model is None:
            continue
        if model["name"] in seen:
            problems.append(f"{where} lists {model['name']} twice")
            continue
        seen.add(model["name"])
        models.append(model)
    workers = _router_int(raw.get("workers"), 1, ROUTER_MAX_WORKERS,
                          max([1, *(m["workers"] for m in models)]), f"{where}.workers", problems)
    system = {"id": system_id, "name": " ".join(name.split()), "base_url": base_url, "server": server,
              "api_mode": api_mode, "enabled": enabled, "jobs": jobs, "workers": workers,
              "one_model_at_a_time": one, "models": models}
    memory = raw.get("memory_gb")
    if memory not in (None, 0):
        if isinstance(memory, bool) or not isinstance(memory, (int, float)) or not 0 < float(memory) <= 65_536:
            problems.append(f"{where}.memory_gb must be the computer's memory in GB")
        else:
            system["memory_gb"] = round(float(memory), 1)
    hardware = raw.get("hardware", {"source": "none"})
    if not isinstance(hardware, dict) or set(hardware) - {"source", "url"} \
            or hardware.get("source", "none") not in ROUTER_HARDWARE:
        problems.append(f"{where}.hardware takes source ({', '.join(ROUTER_HARDWARE)}) and url")
        hardware = {"source": "none"}
    source = hardware.get("source", "none")
    system["hardware"] = {"source": source}
    if source in ("exporter", "node"):
        # Read by DGC itself, never the model: an exporter the user runs, or a dgc node (its token in secrets.json).
        url, problem = router_hardware_url(hardware.get("url"))
        if problem:
            problems.append(f"{where}.hardware.url: {problem}")
            system["hardware"] = {"source": "none"}
        else:
            system["hardware"]["url"] = url
    return system


def validate_router(value) -> tuple[dict, list[str]]:
    """The `router` block cleaned, and what is wrong with it as written ([] when nothing is).

    Callers that change it refuse a block with problems (set_router); reading it (router_block) uses the cleaned
    block, which leaves out a system or model that can't be used rather than guessing at it."""
    problems: list[str] = []
    block = router_defaults()
    if value is None:
        return block, problems
    if not isinstance(value, dict):
        return block, ["router must be an object"]
    extra = sorted(set(value) - {"enabled", "when_busy", "systems"})
    if extra:
        problems.append(f"router has an unknown setting: {extra[0]}")
    enabled = value.get("enabled", False)
    if not isinstance(enabled, bool):
        problems.append("router.enabled must be true or false")
        enabled = False
    block["enabled"] = enabled
    when_busy = value.get("when_busy", "wait")
    if when_busy not in ROUTER_WHEN_BUSY:
        problems.append("router.when_busy must be wait or default")
        when_busy = "wait"
    block["when_busy"] = when_busy
    systems = value.get("systems", [])
    if not isinstance(systems, list):
        problems.append("router.systems must be a list")
        systems = []
    if len(systems) > ROUTER_MAX_SYSTEMS:
        problems.append(f"router lists more than {ROUTER_MAX_SYSTEMS} systems")
        systems = systems[:ROUTER_MAX_SYSTEMS]
    seen = set()
    for place, raw in enumerate(systems, 1):
        system = _router_system(raw, place, problems)
        if system is None:
            continue
        if system["id"] in seen:
            problems.append(f"two systems have the id {system['id']}")
            continue
        seen.add(system["id"])
        block["systems"].append(system)
    return block, problems


ROUTER_HARDWARE_SLOT = ":hardware"


def _disk_json(path):
    """A settings file's JSON object as it is on disk now, or None when it is missing or unreadable."""
    try:
        value = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def _router_identity(block, system_id: str) -> str:
    """The endpoint identity a system's key is bound to: its address, canonical, hashed. ``<id>:hardware`` is its
    dgc node's pairing token, bound to the readout's address the same way."""
    systems = block.get("systems") if isinstance(block, dict) else None
    system_id, hardware = (system_id[:-len(ROUTER_HARDWARE_SLOT)], True) \
        if str(system_id).endswith(ROUTER_HARDWARE_SLOT) else (system_id, False)
    for system in systems if isinstance(systems, list) else ():
        if isinstance(system, dict) and system.get("id") == system_id:
            if hardware:
                readout = system.get("hardware") if isinstance(system.get("hardware"), dict) else {}
                if readout.get("source") != "node":
                    return ""
                base, problem = router_hardware_url(readout.get("url"))
                normalized = _normalized_provider_endpoint(base) if not problem else ""
                return hashlib.sha256(("hardware|" + normalized).encode("utf-8")).hexdigest() if normalized else ""
            base, problem = router_base_url(system.get("base_url"))
            normalized = _normalized_provider_endpoint(base) if not problem else ""
            return hashlib.sha256(normalized.encode("utf-8")).hexdigest() if normalized else ""
    return ""


# ---- Image generation (0.51): the user's image generators ----------------------------------------
# Like `router`, the `images` block is NOT in DEFAULTS: never set up, config.json and every listing stay as 0.50 had
# them. images_block() reads it (validated, with defaults); set_images() writes it. A generator's key is never in the
# block: it lives in secrets.json as image_key_<id>, bound to that generator's address (Config.image_key), and the
# model's tools never read or set one.
IMAGE_PROVIDERS = ("comfyui", "a1111", "openai", "xai", "together", "localai", "ollama", "openai_compatible",
                   "gemini", "bfl", "fal", "replicate")
# Where each provider answers when no address is given (the official API for a cloud one, the usual local port for
# a server on this computer). An OpenAI-compatible server has no default: its address is asked for.
IMAGE_PROVIDER_URLS = {
    "comfyui": "http://localhost:8188", "a1111": "http://localhost:7860", "openai": "https://api.openai.com",
    "xai": "https://api.x.ai", "together": "https://api.together.xyz", "localai": "http://localhost:8080",
    "ollama": "http://localhost:11434", "gemini": "https://generativelanguage.googleapis.com",
    "bfl": "https://api.bfl.ai", "fal": "https://fal.run", "replicate": "https://api.replicate.com"}
# The providers that charge for an image: "asks before each image" starts on for these, off for local servers.
IMAGE_PAID_PROVIDERS = frozenset({"openai", "xai", "together", "gemini", "bfl", "fal", "replicate"})
IMAGE_KEY_PREFIX = "image_key_"
IMAGES_MAX_GENERATORS = 32
# Where pictures go: "" is DGC's own folder (~/.dgc/images/<kind>/<session or chat>/);
# a folder here puts them in the project. 0.51's first builds wrote "assets/generated" as the default into
# every images block: without save_dir_set (written only when someone chooses a folder) that value is read as "".
IMAGES_DEFAULT_DIR = ""
IMAGES_OLD_DEFAULT_DIR = "assets/generated"
IMAGE_MAX_SIDE = 8192
_IMAGE_BLOCK_KEYS = frozenset({"default", "auto_fallback", "save_dir", "save_dir_set", "generators"})
_IMAGE_GENERATOR_KEYS = frozenset({"id", "name", "provider", "base_url", "model", "workflow", "mapping", "size",
                                   "steps", "negative_prompt", "asks", "good_for", "enabled", "monthly_limit_usd",
                                   "system", "makes", "video_asks", "video_pips"})
# Video (0.51, dgc/videos.py): a generator says what it makes. "images" is every generator written before video; a
# video model is its own generator on the same provider (and key). Every video asks before it is made unless the user
# turned that off in Settings for this generator (video_asks false); a Pip's routine makes one only for the Pips the
# user listed for this generator (video_pips).
IMAGE_MAKES = ("images", "videos", "both")
VIDEO_PROVIDERS = ("comfyui", "gemini", "fal", "replicate")
IMAGE_MAPPING_FIELDS = ("prompt", "negative", "seed", "steps", "width", "height", "batch", "image", "mask", "denoise",
                        "frames", "fps")
_IMAGE_MAPPING_RE = re.compile(r"[A-Za-z0-9_:.-]{1,64}\.[A-Za-z0-9_]{1,64}\Z")
_IMAGE_WORKFLOW_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,95}\.json\Z")
_IMAGE_SIZE_RE = re.compile(r"(\d{2,5})\s*[xX×]\s*(\d{2,5})\Z")


def images_defaults() -> dict:
    return {"default": "", "auto_fallback": False, "save_dir": IMAGES_DEFAULT_DIR, "generators": []}


def image_asks_by_default(provider: str, base_url: str) -> bool:
    """Whether a new generator asks before each image: a paid provider does, and so does an OpenAI-compatible server
    outside the user's own network (a hosted service that charges, as images.is_paid counts it). A server on this
    computer or the local network doesn't."""
    if provider in IMAGE_PAID_PROVIDERS:
        return True
    if provider == "openai_compatible":
        from .router import _private_host
        return not _private_host(base_url)
    return False


def image_size(value) -> tuple[int, int] | None:
    """(width, height) from "1024x1024" (or 1024×768), each 64-8192; None when it is not one."""
    match = _IMAGE_SIZE_RE.fullmatch(str(value or "").strip())
    if not match:
        return None
    width, height = int(match.group(1)), int(match.group(2))
    if not (64 <= width <= IMAGE_MAX_SIDE and 64 <= height <= IMAGE_MAX_SIDE):
        return None
    return width, height


def image_save_dir(value) -> tuple[str, str]:
    """(a project-relative folder, problem): never absolute, never above the project, never into .git or .dgc. "" is
    DGC's own folder, outside the project."""
    raw = str(value or "").strip().replace("\\", "/").strip("/")
    if not raw:
        return IMAGES_DEFAULT_DIR, ""
    parts = [part for part in raw.split("/") if part not in ("", ".")]
    if (str(value).strip().startswith(("/", "~")) or re.match(r"[A-Za-z]:", raw) or ".." in parts
            or any(part.lower() in (".git", ".dgc") for part in parts) or len(raw) > 240
            or any(ord(c) < 32 for c in raw)):
        return IMAGES_DEFAULT_DIR, ("save_dir must be a folder inside the project, such as assets/images (or empty for "
                                    "DGC's own folder)")
    return "/".join(parts) or IMAGES_DEFAULT_DIR, ""


def _image_generator(raw, place: int, problems: list[str]) -> dict | None:
    where = f"images.generators[{place}]"
    if not isinstance(raw, dict):
        problems.append(f"{where} must be an object")
        return None
    if any(str(key).lower() in ("key", "api_key", "token", "secret") for key in raw):
        problems.append(f"{where}: a key is never kept in the image settings; it goes in secrets.json "
                        f"(Settings, /images key or dgc images edit --key)")
    extra = sorted(str(key) for key in set(raw) - _IMAGE_GENERATOR_KEYS
                   if str(key).lower() not in ("key", "api_key", "token", "secret"))
    if extra:
        problems.append(f"{where} has an unknown setting: {extra[0]}")
    provider = raw.get("provider")
    if provider not in IMAGE_PROVIDERS:
        problems.append(f"{where}.provider must be one of {', '.join(IMAGE_PROVIDERS)}")
        return None
    name = raw.get("name")
    gen_id = raw.get("id")
    if gen_id is None or gen_id == "":
        gen_id = router_slug(name) or provider.replace("_", "-")
    if not isinstance(gen_id, str) or not _ROUTER_ID_RE.fullmatch(gen_id):
        problems.append(f"{where}.id must be 1-32 lowercase letters, digits or dashes")
        return None
    if name is None or name == "":
        name = gen_id
    if not isinstance(name, str) or not 1 <= len(" ".join(name.split())) <= 64:
        problems.append(f"{where}.name must be 1-64 characters")
        name = gen_id
    address = raw.get("base_url") or IMAGE_PROVIDER_URLS.get(provider, "")
    base_url, problem = router_base_url(address)
    if problem:
        problems.append(f"{where}.base_url: {problem}" if address else
                        f"{where}.base_url: an OpenAI-compatible server needs its address")
        return None
    model = raw.get("model", "")
    if not isinstance(model, str) or len(model) > 256 or (model and (not _ROUTER_MODEL_RE.fullmatch(model)
                                                                    or "://" in model)):
        problems.append(f"{where}.model must be a model name (letters, digits and . _ : / @ + -)")
        model = ""
    size = raw.get("size", "1024x1024")
    if image_size(size) is None:
        problems.append(f"{where}.size must be WIDTHxHEIGHT, each 64-{IMAGE_MAX_SIDE}")
        size = "1024x1024"
    width, height = image_size(size)
    generator = {"id": gen_id, "name": " ".join(name.split()), "provider": provider, "base_url": base_url,
                 "model": model, "size": f"{width}x{height}",
                 "asks": image_asks_by_default(provider, base_url), "enabled": True}
    for key in ("asks", "enabled"):
        if key in raw:
            if not isinstance(raw[key], bool):
                problems.append(f"{where}.{key} must be true or false")
            else:
                generator[key] = raw[key]
    workflow = raw.get("workflow", "")
    if workflow:
        if provider != "comfyui":
            problems.append(f"{where}.workflow is for a ComfyUI generator")
        elif not isinstance(workflow, str) or not _IMAGE_WORKFLOW_RE.fullmatch(workflow):
            problems.append(f"{where}.workflow must be the name of a saved workflow (NAME.json)")
        else:
            generator["workflow"] = workflow
    mapping = raw.get("mapping")
    if mapping is not None:
        if not isinstance(mapping, dict) or any(key not in IMAGE_MAPPING_FIELDS for key in mapping) or any(
                not isinstance(value, str) or not _IMAGE_MAPPING_RE.fullmatch(value) for value in mapping.values()):
            problems.append(f"{where}.mapping takes {', '.join(IMAGE_MAPPING_FIELDS)}, each \"NODE.input\"")
        elif "prompt" not in mapping:
            problems.append(f"{where}.mapping needs where the prompt goes (prompt)")
        else:
            generator["mapping"] = {key: mapping[key] for key in IMAGE_MAPPING_FIELDS if key in mapping}
    steps = raw.get("steps")
    if steps is not None:
        generator["steps"] = _router_int(steps, 1, 200, 20, f"{where}.steps", problems)
    for key, limit in (("negative_prompt", 2000), ("good_for", 200)):
        text = raw.get(key, "")
        if not isinstance(text, str):
            problems.append(f"{where}.{key} must be text")
            continue
        text = " ".join(text.split())
        if len(text) > limit:
            problems.append(f"{where}.{key} is longer than {limit} characters")
            text = text[:limit]
        if text:
            generator[key] = text
    cap = raw.get("monthly_limit_usd")
    if cap is not None:
        if isinstance(cap, bool) or not isinstance(cap, (int, float)) or not 0 <= float(cap) <= 100_000:
            problems.append(f"{where}.monthly_limit_usd must be an amount in US dollars")
        else:
            generator["monthly_limit_usd"] = round(float(cap), 2)
    system = raw.get("system", "")
    if system:
        if not isinstance(system, str) or not _ROUTER_ID_RE.fullmatch(system):
            problems.append(f"{where}.system must be a DGC Router system's id")
        else:
            generator["system"] = system
    makes = raw.get("makes", "images")
    if makes not in IMAGE_MAKES:
        problems.append(f"{where}.makes must be one of {', '.join(IMAGE_MAKES)}")
    elif makes != "images":
        if provider not in VIDEO_PROVIDERS:
            problems.append(f"{where}: DGC makes videos with {', '.join(VIDEO_PROVIDERS)} only")
        else:
            generator["makes"] = makes
            generator["video_asks"] = True
            if "video_asks" in raw:
                if not isinstance(raw["video_asks"], bool):
                    problems.append(f"{where}.video_asks must be true or false")
                else:
                    generator["video_asks"] = raw["video_asks"]
            pips = raw.get("video_pips", [])
            if not isinstance(pips, list) or len(pips) > 64 or any(
                    not isinstance(item, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,80}", item) for item in pips):
                problems.append(f"{where}.video_pips must be a list of Pip ids")
            elif pips:
                generator["video_pips"] = sorted(set(pips))
    return generator


def validate_images(value) -> tuple[dict, list[str]]:
    """The `images` block cleaned, and what is wrong with it as written ([] when nothing is). set_images refuses a
    block with problems; images_block uses the cleaned one, which leaves out a generator it can't use."""
    problems: list[str] = []
    block = images_defaults()
    if value is None:
        return block, problems
    if not isinstance(value, dict):
        return block, ["images must be an object"]
    extra = sorted(set(value) - _IMAGE_BLOCK_KEYS)
    if extra:
        problems.append(f"images has an unknown setting: {extra[0]}")
    fallback = value.get("auto_fallback", False)
    if not isinstance(fallback, bool):
        problems.append("images.auto_fallback must be true or false")
        fallback = False
    block["auto_fallback"] = fallback
    save_dir, problem = image_save_dir(value.get("save_dir"))
    if problem:
        problems.append(f"images.{problem}")
    chosen = value.get("save_dir_set", False)
    if not isinstance(chosen, bool):
        problems.append("images.save_dir_set must be true or false")
        chosen = False
    if save_dir == IMAGES_OLD_DEFAULT_DIR and not chosen:
        save_dir = IMAGES_DEFAULT_DIR          # the first builds' default, never chosen: DGC's own folder now
    block["save_dir"] = save_dir
    if save_dir and chosen:
        block["save_dir_set"] = True
    generators = value.get("generators", [])
    if not isinstance(generators, list):
        problems.append("images.generators must be a list")
        generators = []
    if len(generators) > IMAGES_MAX_GENERATORS:
        problems.append(f"images lists more than {IMAGES_MAX_GENERATORS} generators")
        generators = generators[:IMAGES_MAX_GENERATORS]
    seen = set()
    for place, raw in enumerate(generators, 1):
        generator = _image_generator(raw, place, problems)
        if generator is None:
            continue
        if generator["id"] in seen:
            problems.append(f"two generators have the id {generator['id']}")
            continue
        seen.add(generator["id"])
        block["generators"].append(generator)
    default = value.get("default", "")
    if default and (not isinstance(default, str) or default not in seen):
        problems.append("images.default must be the id of one of the generators")
        default = ""
    block["default"] = default or ""
    return block, problems


def _image_identity(block, generator_id: str) -> str:
    """The endpoint identity a generator's key is bound to: its address (and provider), canonical, hashed."""
    generators = block.get("generators") if isinstance(block, dict) else None
    for generator in generators if isinstance(generators, list) else ():
        if isinstance(generator, dict) and generator.get("id") == generator_id:
            provider = generator.get("provider")
            address = generator.get("base_url") or IMAGE_PROVIDER_URLS.get(str(provider), "")
            base, problem = router_base_url(address)
            normalized = _normalized_provider_endpoint(base) if not problem else ""
            return (hashlib.sha256(f"{provider}|{normalized}".encode("utf-8")).hexdigest()
                    if normalized and provider in IMAGE_PROVIDERS else "")
    return ""


def subagent_window_arg(text: str) -> int | None:
    """``/subagent context N``: a token count of at least 2048, a size like ``64k``, or 0 for the
    main model's window. None when it is neither."""
    raw = str(text or "").strip().lower().replace(",", "").replace("_", "")
    scale = 1024 if raw.endswith("k") else 1
    try:
        size = int(float(raw[:-1] if scale > 1 else raw) * scale)
    except (ValueError, OverflowError):
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
    # Redirecting user state does not turn the account's original ~/.dgc into
    # a project marker. Otherwise a non-Git child directory silently widens to
    # the account home whenever DGC_HOME points at a separate private instance.
    global_dgc_dirs = {USER_HOME.resolve(), (Path.home() / ".dgc").resolve()}
    for d in (p, *p.parents):
        dgc_dir = d / ".dgc"
        # a project's own .dgc counts, but NOT the global ~/.dgc config dir — otherwise every
        # folder under $HOME resolves its project root all the way up to $HOME.
        if (d / ".git").exists() or (d / "DGC.md").exists() or \
           (dgc_dir.is_dir() and dgc_dir.resolve() not in global_dgc_dirs):
            return d
    return p


# What a running conversation is: its permission mode, its model route (and the credentials bound
# to it), and how it samples. Settings owns the default for NEW chats; a model choice in a Work
# chat is saved with that chat. No other running session adopts it at its next save. Adopted, a
# model switch in one window moved every other window's chat to that model mid-conversation, a
# mode switch put a chat sitting in `default` into `auto`, and an endpoint switch left the other
# sessions on the new endpoint holding the old endpoint's key.
_SESSION_KEYS = frozenset({
    "mode", "model", "base_url", "api_mode", "context_size", "thinking", "ultra_mode",
    "think_budget_tokens", "max_tokens", "temperature", "top_p", "top_k", "min_p",
    "tool_profile", "tool_profile_chosen", "subscription_engine", "subscription_model",
    "subscription_effort", "provider_state", "prompt_cache", "prompt_cache_key", "prompt_cache_ttl",
    "provider_capabilities", "fallback_model", "fallback_base_url", "fallback_api_mode",
    "subagent_model", "subagent_base_url", "subagent_api_mode", "subagent_context_size", "subagent_thinking",
})


# Lists several processes edit one entry at a time. Written whole, a Config that loaded before
# another revoked a trusted folder wrote it back the next time it trusted a different one: the
# revoke was undone in the unsafe direction.
_ENTRY_MERGED_KEYS = ("trusted_dirs",)
# Mappings several processes edit one entry at a time: two editor windows each remembering the
# window chosen for their own model must not wipe out the other's.
_MAPPING_MERGED_KEYS = ("model_context_sizes",)


def _merge_mapping(on_disk, baseline, now) -> dict:
    """`on_disk` with exactly this process's own entry changes since `baseline` applied."""
    def mapping(value):
        return dict(value) if isinstance(value, dict) else {}
    was, mine = mapping(baseline), mapping(now)
    merged = mapping(on_disk)
    for key in was:
        if key not in mine:
            merged.pop(key, None)
    for key, value in mine.items():
        if was.get(key, object()) != value:
            merged.pop(key, None)
            merged[key] = value
    return merged


# The windows a model switch can restore: the most recently chosen ones win a place.
_MAX_REMEMBERED_WINDOWS = 64


def remembered_context_size(config, model: str) -> int | None:
    """The window the user chose for ``model`` (0.48), or None when they never chose one."""
    getter = getattr(config, "get", None)
    table = getter("model_context_sizes", {}) if callable(getter) else {}
    value = table.get(str(model or "")) if isinstance(table, dict) else None
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value if 2_048 <= value <= 16_777_216 else None


def _merge_entries(on_disk, baseline, now) -> list:
    """`on_disk` with exactly this process's additions and removals since `baseline` applied."""
    def entries(value):
        return [item for item in value if isinstance(item, str)] if isinstance(value, list) else []
    was, mine = entries(baseline), entries(now)
    removed = {item for item in was if item not in mine}
    merged = [item for item in entries(on_disk) if item not in removed]
    merged += [item for item in mine if item not in was and item not in merged]
    return merged


def _read_project_rules(project_dir: Path) -> dict:
    """`<project>/.dgc/permissions.json` as rules per action; empty lists when there is none."""
    rules: dict = {"allow": [], "ask": [], "deny": []}
    proj_perms = Path(project_dir) / "permissions.json"
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


def _add_project_rules(config, rules: dict) -> bool:
    """Make `rules` live as the trusted project's in `config`. Returns whether there were any.

    Workspace rules are live for THIS project and never persisted. They are recorded rather than
    folded into the baseline, because save() needs them in two places: subtracted from what it
    writes, and put back after it rebuilds the live set from disk. Each list is replaced in one
    assignment, never grown in place, so a permission decision on another thread sees all of them
    or none. Module-level, like _read_project_rules, so apply_project_permissions works on anything
    shaped like a Config -- the session-policy checks call it on a bare namespace.
    """
    contributed = config.__dict__.setdefault("_project_rules", {"allow": [], "ask": [], "deny": []})
    merged = False
    for action, added in rules.items():
        if added:
            config.permissions[action] = list(config.permissions.get(action, [])) + list(added)
            contributed[action] = list(contributed.get(action, [])) + list(added)
            merged = True
    return merged


def _policy_strips_allow() -> bool:
    """Whether the launching process reviews commands itself (an SDK RuntimePolicy with
    project_allow=False, or an invalid policy). Stored and workspace allow rules then pre-approve
    nothing: only the callback's own "always" answers in this session may."""
    from .permissions import session_policy
    policy = session_policy()
    return policy is not None and bool(policy.error or not policy.project_allow)


class Config:
    # The mode was named for this run (`dgc --mode`): reopening a session never changes it.
    mode_explicit = False

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
        # DGC Router keys, by system id: (key, the identity of the address it was saved for).
        self._router_keys: dict[str, tuple[str, str]] = {}
        # Image generators' keys, by generator id, the same way: (key, the identity of the address it was saved for).
        self._image_keys: dict[str, tuple[str, str]] = {}
        # Saved providers a Pip was set to, by provider id (see SAVED_PROVIDERS).
        self._saved_providers: dict[str, dict[str, str]] = {}
        self.credential_warnings: tuple[str, ...] = ()
        self.permissions: dict[str, list[str]] = {"allow": [], "ask": [], "deny": []}
        self.load()

    def load(self) -> None:
        _repair_user_home_permissions()
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
        # A DGC Router key written into config.json by hand belongs in secrets.json, bound to its system's address.
        moved_router_keys = {key[len(ROUTER_KEY_PREFIX):]: raw.pop(key) for key in list(raw)
                             if isinstance(key, str) and key.startswith(ROUTER_KEY_PREFIX)}
        if moved_router_keys:
            migrated = True
        moved_image_keys = {key[len(IMAGE_KEY_PREFIX):]: raw.pop(key) for key in list(raw)
                            if isinstance(key, str) and key.startswith(IMAGE_KEY_PREFIX)}
        if moved_image_keys:
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
        if not isinstance(perms, dict):
            perms = {}
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
        # Releases through 0.48 defaulted model_load_timeout_s to 900 and save() wrote it into every
        # config, so a stored 900 is that old default, not a choice. It gave a huge local model 15
        # minutes to load from a slow disk before its request was closed and sent again (which starts
        # the load over). It becomes "auto": no limit while a local Ollama shows the model loading.
        if raw.get("model_load_timeout_s") == 900:
            raw["model_load_timeout_s"] = "auto"
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
        for slot in _SEARCH_SECRET_KEYS:
            value = secrets.get(slot)
            if isinstance(value, str):
                accepted_secrets[slot] = value
            elif slot in secrets:
                migrated = True
        if LEGACY_SEARCH_KEY in secrets:
            # The one key older releases shared between providers belongs to the provider selected when it
            # was saved, which is the one selected now: it becomes that provider's own key. With a provider
            # that takes none selected, whose it is can't be told, so it is kept aside and never sent.
            migrated = True                     # and the shared name is never written back
            legacy = secrets.get(LEGACY_SEARCH_KEY)
            owner = search_key_name(self.data.get("search_provider"))
            if isinstance(legacy, str) and legacy:
                if owner and not accepted_secrets.get(owner):
                    accepted_secrets[owner] = legacy
                elif accepted_secrets.get(owner) != legacy and not accepted_secrets.get(SEARCH_KEY_UNASSIGNED):
                    accepted_secrets[SEARCH_KEY_UNASSIGNED] = legacy
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
        # DGC Router keys: each is used only while its system still has the address it was saved for. One that
        # isn't bound (the address changed in config.json, the system was removed) is never guessed at: it is
        # scrubbed from disk, and the user enters it again for the new address.
        router_identity = secrets.get("router_identity")
        router_identity = router_identity if isinstance(router_identity, dict) else {}
        router_keys: dict[str, tuple[str, str]] = {}
        router_block = self.data.get("router")
        stored_router = {key[len(ROUTER_KEY_PREFIX):]: value for key, value in secrets.items()
                         if isinstance(key, str) and key.startswith(ROUTER_KEY_PREFIX)}
        for system_id, value in {**stored_router, **moved_router_keys}.items():
            identity = _router_identity(router_block, system_id)
            bound = identity and (system_id in moved_router_keys or router_identity.get(system_id) == identity)
            if isinstance(value, str) and value and bound and len(value) <= 16_384:
                router_keys[system_id] = (value, identity)
            else:
                migrated = True
        if set(router_identity) != set(router_keys):
            migrated = True
        self._router_keys = router_keys
        # Image generators' keys: as the Router's, used only while the generator keeps the address they were saved for.
        image_identity = secrets.get("image_identity")
        image_identity = image_identity if isinstance(image_identity, dict) else {}
        image_keys: dict[str, tuple[str, str]] = {}
        images_block = self.data.get("images")
        stored_images = {key[len(IMAGE_KEY_PREFIX):]: value for key, value in secrets.items()
                         if isinstance(key, str) and key.startswith(IMAGE_KEY_PREFIX)}
        for generator_id, value in {**stored_images, **moved_image_keys}.items():
            identity = _image_identity(images_block, generator_id)
            bound = identity and (generator_id in moved_image_keys or image_identity.get(generator_id) == identity)
            if isinstance(value, str) and value and bound and len(value) <= 16_384:
                image_keys[generator_id] = (value, identity)
            else:
                migrated = True
        if set(image_identity) != set(image_keys):
            migrated = True
        self._image_keys = image_keys
        self._saved_providers = _clean_saved_providers(secrets.get(SAVED_PROVIDERS))
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
            if value is not None and key == LEGACY_SEARCH_KEY:
                # The selected provider's key, for this launch only, and never another provider's: switching
                # provider later doesn't carry it along. A provider that takes no key gets none.
                bound = (hashlib.sha256(value.encode("utf-8", "replace")).hexdigest(), str(USER_CONFIG))
                slot = _SEARCH_ENV_SLOTS.setdefault(bound, search_key_name(self.data.get("search_provider")))
                if slot:
                    self.data[slot] = value
                    self._env_secret_keys.add(slot)
                continue
            if value is not None:
                self.data[key] = value
                self._env_secret_keys.add(key)
                if key in _PROVIDER_SECRET_KEYS:
                    self._provider_secret_identity[key] = _provider_secret_identity(self.data, key)
        for action in ("allow", "ask", "deny"):
            rules = perms.get(action, [])
            self.permissions[action] = [rule for rule in rules if isinstance(rule, str)] if isinstance(rules, list) else []
        from . import plugin_credentials
        plugin_credentials.configure(self.data.get("plugin_credentials_store"))
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
        self.hold("mode", "default")
        return True

    def hold(self, key: str, value) -> None:
        """Set `key` for this process only, until the user chooses a value themselves.

        Held, not one-shot: no save writes it, none adopts the stored value back over it, and an
        explicit set() ends the hold and is saved like any other choice. Kept ephemeral for life
        instead, every mode the user chose afterwards was dropped too, and the stored auto came
        back on the next launch even after they lowered it. A key already one-shot (`dgc -p
        --mode`) stays one-shot.
        """
        ephemeral = self.__dict__.setdefault("_ephemeral_keys", set())
        if key not in ephemeral:
            ephemeral.add(key)
            self.__dict__.setdefault("_held_keys", set()).add(key)
        self.data[key] = value

    def mark_ephemeral(self, *keys: str) -> None:
        """Hold these settings for THIS process only; no save may write them.

        A one-shot run (`dgc -p`) is a script or a benchmark: `--mode auto`, `--think high` and
        `--ultra` are for that invocation. They were applied straight into `self.data`, so the next
        `save()` from anywhere in the process -- `--trust` marking the workspace, a permission rule,
        a slash command -- persisted them as the user's standing configuration. Trusting a folder
        silently made `auto` the permanent permission mode.
        """
        self.__dict__.setdefault("_ephemeral_keys", set()).update(k for k in keys if k)

    def restore_subscription_route(self, saved: dict | None = None) -> None:
        """Use a saved chat's CLI route, or the current default for a new chat.

        The route contains model names only. Vendor sign-in remains in the vendor CLI,
        and this per-chat choice must never become the next chat's default during an
        unrelated config save.
        """
        from .sessions import _clean_subscription_route
        route = _clean_subscription_route(saved)
        if route is None:
            defaults = _read_config_payload(USER_CONFIG) or {}
            route = _clean_subscription_route({
                "engine": defaults.get("subscription_engine", DEFAULTS["subscription_engine"]),
                "model": defaults.get("subscription_model", DEFAULTS["subscription_model"]),
                "effort": defaults.get("subscription_effort", DEFAULTS["subscription_effort"]),
            }) or {"engine": "", "model": "", "effort": ""}
        for key, value in (("subscription_engine", route["engine"]),
                           ("subscription_model", route["model"]),
                           ("subscription_effort", route["effort"])):
            self.hold(key, value)

    def restore_native_route(self, saved: dict | None = None) -> None:
        """Restore a chat's native endpoint/model without borrowing another host's key.

        A session file never contains credentials. For the user's saved default, use only its
        separately bound key. An editor may supply a different endpoint's key from its own
        SecretStorage after the route is restored; until then that route has no credential.
        """
        from .sessions import _clean_native_route
        route = _clean_native_route(saved)
        defaults = _read_config_payload(USER_CONFIG) or {}
        default_route = _clean_native_route({
            key: defaults.get(key, DEFAULTS[key])
            for key in ("base_url", "model", "api_mode", "thinking")
        })
        route = route or default_route or {key: DEFAULTS[key]
                                           for key in ("base_url", "model", "api_mode", "thinking")}
        identity = _provider_secret_identity({**self.data, "base_url": route["base_url"]}, "api_key")
        secret = ""
        if default_route and route["base_url"] == default_route["base_url"]:
            stored = _read_config_payload(USER_SECRETS) or {}
            bindings = stored.get("provider_identity")
            if isinstance(bindings, dict) and bindings.get("api_key") == identity:
                value = stored.get("api_key")
                if isinstance(value, str):
                    secret = value
            elif route["base_url"] == DEFAULTS["base_url"]:
                secret = DEFAULTS["api_key"]
        if not secret and getattr(self, "_provider_secret_identity", {}).get("api_key") == identity:
            # A launcher may have supplied this endpoint's key through
            # DGC_API_KEY(_FILE), or the editor may have supplied it at runtime.
            # It is already bound to this URL; clearing it on New chat would
            # make the same provider stop working until the process restarts.
            current = self.data.get("api_key")
            if isinstance(current, str):
                secret = current
        for key in ("base_url", "model", "api_mode", "thinking"):
            self.hold(key, route[key])
        # A Work chat may have selected a larger window for a different model.
        # Return to the saved default before opening a new chat or restoring
        # another one; that chat can then select its own model's window.
        self.hold("context_size", defaults.get("context_size", DEFAULTS["context_size"]))
        self._window_from_switch = ""
        previous = self.data.get("api_key")
        if isinstance(previous, str) and previous != secret and 8 <= len(previous) <= 16_384:
            # A previous route's credential must not authorize the restored route, but it
            # can still occur in saved text. Keep it redacted after clearing the live key.
            remembered = tuple(getattr(self, "_session_secret_values", ()))
            if previous not in remembered:
                self._session_secret_values = (*remembered[-255:], previous)
        self.hold("api_key", secret)
        bindings = self.__dict__.setdefault("_provider_secret_identity", {})
        if secret and identity:
            bindings["api_key"] = identity
        else:
            bindings.pop("api_key", None)

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
        return _add_project_rules(self, _read_project_rules(self.project_dir))

    def inherit_trust(self, source: "Config") -> bool:
        """Take the trust of the project this checkout was made from.

        A TUI worktree or fleet agent works in a checkout of the launch project, rooted outside
        trusted_dirs (a sibling folder, or under ~/.dgc), so nothing loaded the project's rules:
        auto carried over and the project's deny vanished for any work moved there. A sub-agent's
        clone_for_root() view already shares its parent's rules; this gives the TUI's sessions the
        same. An untrusted source holds the mode instead. Returns whether the source is trusted.

        The project, not the checkout it was made from: a second /worktree, or a /worktree run in
        a fleet agent, was given the previous checkout's Config, which no trusted folder contains
        -- the project's rules were dropped, and one Shift+Tab put that session in auto with no
        deny. The origin is recorded so the agent answers for the project's trust too (see
        Agent._workspace_trusted).
        """
        from .trust import is_trusted
        origin = getattr(source, "_trust_origin", None) or source
        self._trust_origin = origin
        if not is_trusted(origin, origin.project_root):
            self.hold_untrusted_mode()
            return False
        if not getattr(self, "_project_permissions_applied", False):
            self._project_permissions_applied = True
            _add_project_rules(self, origin._project_contribution())
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
                for key in _MAPPING_MERGED_KEYS:
                    if key in changed:
                        baseline = getattr(self, "_baseline_data", None) or {}
                        payload[key] = _merge_mapping(on_disk.get(key), baseline.get(key),
                                                      self.data.get(key))
                for key in SECRET_KEYS:
                    payload.pop(key, None)
                for key in [key for key in payload if isinstance(key, str)
                            and key.startswith((ROUTER_KEY_PREFIX, IMAGE_KEY_PREFIX))]:
                    payload.pop(key)            # a DGC Router or image generator key load() moved to secrets.json
                base = on_disk.get("permissions")
                base = base if isinstance(base, dict) else {}
                merged = {a: [rule for rule in base.get(a, []) if isinstance(rule, str)]
                          if isinstance(base.get(a), list) else [] for a in ("allow", "ask", "deny")}
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
                for key in _MAPPING_MERGED_KEYS:
                    if key in changed:
                        self.data[key] = dict(payload[key])
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
                        for action, rules in _read_project_rules(self.project_dir).items():
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
        # After the lock, never inside it: a listener refreshes OTHER Configs, and their save()
        # takes this same file lock through its own descriptor -- inside, that is a deadlock.
        notify = getattr(self, "on_saved", None)
        moved = set(changed) | set(dropped)
        rules_moved = any(perms.get("added", {}).values()) or any(perms.get("removed", {}).values())
        if callable(notify) and (moved or rules_moved):
            notify(self, moved, rules_moved)

    def _own_secrets(self) -> dict:
        """What this process would store: each key with the endpoint identity it is bound to.

        Environment-provided credentials are ephemeral references. A harmless settings change
        must never copy a CI/process secret into ~/.dgc/secrets.json. Provider credentials carry
        the normalized endpoint identity they were issued for, so either half of an interrupted
        two-file update fails closed on the next load.
        """
        own: dict = {}
        for slot in _SEARCH_SECRET_KEYS:
            search_value = (self._stored_secrets.get(slot, "") if slot in self._env_secret_keys
                            else self.data.get(slot, ""))
            own[slot] = (search_value if isinstance(search_value, str) else "", "")
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
        block = self._router_raw()
        own["router"] = {system_id: (value, identity)
                         for system_id, (value, identity) in getattr(self, "_router_keys", {}).items()
                         if value and identity and _router_identity(block, system_id) == identity}
        images = self._images_raw()
        own["images"] = {generator_id: (value, identity)
                         for generator_id, (value, identity) in getattr(self, "_image_keys", {}).items()
                         if value and identity and _image_identity(images, generator_id) == identity}
        own[SAVED_PROVIDERS] = copy.deepcopy(getattr(self, "_saved_providers", {}))
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
        for key in (*_SEARCH_SECRET_KEYS, *sorted(_PROVIDER_SECRET_KEYS)):
            if was is None or now[key] != was.get(key):
                value, identity = now[key]
            else:
                value = disk.get(key, "") if isinstance(disk.get(key, ""), str) else ""
                identity = str(disk_identity.get(key, "") or "")
            if key in _SEARCH_SECRET_KEYS and not value:
                continue                        # a web search provider with no key has no entry at all
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
        # DGC Router keys, merged as the MCP ones are: disk's stand, and this process's own changes apply.
        router: dict[str, tuple[str, str]] = {}
        if was is not None:
            disk_router_identity = disk.get("router_identity")
            disk_router_identity = disk_router_identity if isinstance(disk_router_identity, dict) else {}
            for key, value in disk.items():
                if isinstance(key, str) and key.startswith(ROUTER_KEY_PREFIX) and isinstance(value, str) and value:
                    system_id = key[len(ROUTER_KEY_PREFIX):]
                    identity = disk_router_identity.get(system_id)
                    if isinstance(identity, str) and identity:
                        router[system_id] = (value, identity)
        before_router = (was or {}).get("router", {})
        for system_id in set(now["router"]) | set(before_router):
            if was is not None and now["router"].get(system_id) == before_router.get(system_id):
                continue
            router.pop(system_id, None)
            if system_id in now["router"]:
                router[system_id] = now["router"][system_id]
        block = self._router_raw()
        router = {system_id: pair for system_id, pair in router.items()
                  if _router_identity(block, system_id) == pair[1]}
        if router:
            for system_id in sorted(router):
                secrets[ROUTER_KEY_PREFIX + system_id] = router[system_id][0]
            secrets["router_identity"] = {system_id: router[system_id][1] for system_id in sorted(router)}
        self._router_keys = dict(router)
        # Image generators' keys, merged the same way.
        images: dict[str, tuple[str, str]] = {}
        if was is not None:
            disk_image_identity = disk.get("image_identity")
            disk_image_identity = disk_image_identity if isinstance(disk_image_identity, dict) else {}
            for key, value in disk.items():
                if isinstance(key, str) and key.startswith(IMAGE_KEY_PREFIX) and isinstance(value, str) and value:
                    generator_id = key[len(IMAGE_KEY_PREFIX):]
                    identity = disk_image_identity.get(generator_id)
                    if isinstance(identity, str) and identity:
                        images[generator_id] = (value, identity)
        before_images = (was or {}).get("images", {})
        for generator_id in set(now["images"]) | set(before_images):
            if was is not None and now["images"].get(generator_id) == before_images.get(generator_id):
                continue
            images.pop(generator_id, None)
            if generator_id in now["images"]:
                images[generator_id] = now["images"][generator_id]
        images_block = self._images_raw()
        images = {generator_id: pair for generator_id, pair in images.items()
                  if _image_identity(images_block, generator_id) == pair[1]}
        if images:
            for generator_id in sorted(images):
                secrets[IMAGE_KEY_PREFIX + generator_id] = images[generator_id][0]
            secrets["image_identity"] = {generator_id: images[generator_id][1] for generator_id in sorted(images)}
        self._image_keys = dict(images)
        # Saved providers, merged the same way: disk's stand, and this process's own changes apply.
        providers = _clean_saved_providers(disk.get(SAVED_PROVIDERS)) if was is not None else {}
        before_providers = (was or {}).get(SAVED_PROVIDERS, {})
        for provider_id in set(now[SAVED_PROVIDERS]) | set(before_providers):
            if was is not None and now[SAVED_PROVIDERS].get(provider_id) == before_providers.get(provider_id):
                continue
            providers.pop(provider_id, None)
            if provider_id in now[SAVED_PROVIDERS]:
                providers[provider_id] = now[SAVED_PROVIDERS][provider_id]
        if providers:
            secrets[SAVED_PROVIDERS] = copy.deepcopy(providers)
        self._saved_providers = providers
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
        clone._session_secret_values = tuple(getattr(self, "_session_secret_values", ()))
        clone._stored_mcp_env = copy.deepcopy(self._stored_mcp_env)
        clone._stored_mcp_identity = dict(self._stored_mcp_identity)
        clone._env_secret_keys = set(self._env_secret_keys)
        clone._router_keys = dict(getattr(self, "_router_keys", {}))
        clone._image_keys = dict(getattr(self, "_image_keys", {}))
        clone._saved_providers = copy.deepcopy(getattr(self, "_saved_providers", {}))
        clone._explicit_keys = set(getattr(self, "_explicit_keys", set()))
        clone.credential_warnings = tuple(self.credential_warnings)
        clone.permissions = self.permissions
        clone._pinned_run_route = getattr(self, "_pinned_run_route", False)
        if hasattr(self, "session_permissions"):
            clone.session_permissions = self.session_permissions
        return clone

    def get(self, key: str, default=None):
        data = getattr(self, "data", {})
        if key == LEGACY_SEARCH_KEY and isinstance(data, dict):
            # The selected provider's own key, never another's (search_settings reads the pair together).
            slot = search_key_name(data.get("search_provider"))
            return data.get(slot, default) if slot else default
        bindings = getattr(self, "_provider_secret_identity", None)
        if key in _PROVIDER_SECRET_KEYS and bindings is not None:
            bound = bindings.get(key, "") if isinstance(bindings, dict) else ""
            if bound != _provider_secret_identity(data, key):
                return ""
        return data.get(key, default) if isinstance(data, dict) else default

    def _remember_window(self, value) -> None:
        """A window the user chose is the current model's own: switching back to it restores it."""
        model = str(self.data.get("model") or "").strip()
        if isinstance(value, bool) or not isinstance(value, int) or not model or len(model) > 512:
            return
        if not 2_048 <= value <= 16_777_216:
            return
        table = self.data.get("model_context_sizes")
        table = {k: v for k, v in table.items() if isinstance(k, str)} if isinstance(table, dict) else {}
        table.pop(model, None)
        table[model] = value
        while len(table) > _MAX_REMEMBERED_WINDOWS:
            table.pop(next(iter(table)))
        self.data["model_context_sizes"] = table
        self._explicit_keys.add("model_context_sizes")

    def set_model_window(self, size: int, *, persist: bool = True) -> None:
        """The window a model switch picked for the new model: restored, reported or recommended.

        Not the user's own choice, so it is not remembered as one (Config.set remembers those).
        """
        self._window_from_model = True
        try:
            self.set("context_size", int(size), persist=persist)
        finally:
            self._window_from_model = False
        self._window_from_switch = str(self.data.get("model") or "")

    def is_explicit(self, key: str) -> bool:
        """True when `key` was present in the user's config.json rather than inherited."""
        return key in getattr(self, "_explicit_keys", set())

    def set(self, key: str, value, *, persist: bool = True) -> None:
        if key == LEGACY_SEARCH_KEY:
            # The key of the provider selected now. A provider that takes none keeps none: stored anywhere,
            # it would become some other provider's key.
            key = search_key_name(self.data.get("search_provider"))
            if not key:
                return
        if key in _SEARCH_SECRET_KEYS:
            # Typed or removed here, the key is the user's own from now on: saved (or removed) in secrets.json,
            # not a value DGC_SEARCH_API_KEY handed to this launch.
            self._env_secret_keys.discard(key)
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
        was_held = bool(held and key in held)
        if was_held:
            held.discard(key)                          # the user chose: the hold is over
            self._ephemeral_keys.discard(key)
        if key == "context_size" and not getattr(self, "_window_from_model", False):
            self._window_from_switch = ""           # whatever it is now, the user set it
            if value != self.data.get("context_size"):
                self._remember_window(value)
        self.data[key] = value
        if key == "plugin_credentials_store":
            from . import plugin_credentials
            plugin_credentials.configure(value)
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
            try:
                self.save()
            except Exception:
                if was_held:
                    # Not saved, so not chosen: the hold stands. Ended here, the next save of
                    # anything wrote the held value -- a reopened chat's auto, an untrusted
                    # folder's default -- as the user's own.
                    held.add(key)
                    self._ephemeral_keys.add(key)
                raise

    # ---- DGC Router ---------------------------------------------------------------------------
    def _router_raw(self):
        """The `router` block as it is now. A long-running process (`dgc serve`, the Pips supervisor) reads it from
        config.json each time, as the `images` block: a system or a hardware readout set up in a terminal (`dgc router
        hardware ID ADDRESS --token`) counts in a window that was open before it, and that window's own saves keep it
        (release check, 2026-11-03: Settings showed no readout until a window reload)."""
        raw = self.data.get("router") if isinstance(getattr(self, "data", None), dict) else None
        if getattr(self, "_persist", False):
            disk = _disk_json(USER_CONFIG)
            if isinstance(disk, dict) and "router" in disk:
                raw = disk["router"]
        return raw

    def router_block(self) -> dict:
        """The `router` settings, validated: defaults when never set up; a system or model that can't be used is
        left out (validate_router)."""
        return validate_router(self._router_raw())[0]

    def set_router(self, block, *, persist: bool = True) -> dict:
        """Replace the `router` settings with ``block``, or raise ValueError naming every problem. Returns what
        was saved. A key never travels in the block; a system whose address changes loses its saved key."""
        cleaned, problems = validate_router(block)
        if problems:
            raise ValueError("; ".join(problems[:6]))
        # Changed against what config.json holds now (_router_raw), as set_images: against this process's last write, a
        # change back to it looked like no change, and save() kept the other process's block.
        if persist and getattr(self, "_persist", False) and isinstance(getattr(self, "_baseline_data", None), dict):
            disk = self._router_raw()
            if disk is None:
                self._baseline_data.pop("router", None)
            else:
                self._baseline_data["router"] = copy.deepcopy(disk)
        self.set("router", cleaned, persist=persist)
        return cleaned

    def _router_pair(self, system_id: str):
        """(key, the identity it is bound to) for ``system_id``, or None. As the block, read from secrets.json in a
        long-running process: a key or a dgc node's pairing token saved by another DGC since this one started counts."""
        pair = getattr(self, "_router_keys", {}).get(system_id)
        if getattr(self, "_persist", False):
            disk = _disk_json(USER_SECRETS)
            if isinstance(disk, dict):
                bound = disk.get("router_identity") if isinstance(disk.get("router_identity"), dict) else {}
                value = disk.get(ROUTER_KEY_PREFIX + system_id)
                pair = (value, str(bound.get(system_id) or "")) if isinstance(value, str) and value else None
        return pair

    def router_key(self, system_id: str) -> str:
        """The key saved for ``system_id``, while that system still has the address it was saved for; else ""."""
        system_id = str(system_id or "")
        pair = self._router_pair(system_id)
        if not pair:
            return ""
        value, identity = pair
        return value if identity and _router_identity(self._router_raw(), system_id) == identity else ""

    def router_key_ids(self) -> list[str]:
        """The systems that have a usable key saved (never the keys)."""
        ids = set(getattr(self, "_router_keys", {}))
        if getattr(self, "_persist", False):
            disk = _disk_json(USER_SECRETS)
            if isinstance(disk, dict):
                ids |= {key[len(ROUTER_KEY_PREFIX):] for key in disk
                        if isinstance(key, str) and key.startswith(ROUTER_KEY_PREFIX)}
        return sorted(system_id for system_id in ids
                      if not system_id.endswith(ROUTER_HARDWARE_SLOT) and self.router_key(system_id))

    def router_hardware_token(self, system_id: str) -> str:
        """The pairing token of a system's dgc node, while the readout still has the address it was saved for."""
        return self.router_key(str(system_id or "") + ROUTER_HARDWARE_SLOT)

    def set_router_hardware_token(self, system_id: str, value: str, *, persist: bool = True) -> None:
        """Save (or, with "", remove) a system's dgc node pairing token in secrets.json, bound to the readout's
        address. Raises ValueError when the system has no dgc node readout."""
        system_id = str(system_id or "")
        if not _router_identity(self._router_raw(), system_id + ROUTER_HARDWARE_SLOT):
            raise ValueError(f"{system_id!r} has no dgc node readout to keep a token for "
                             "(dgc router hardware SYSTEM URL first)")
        self.set_router_key(system_id + ROUTER_HARDWARE_SLOT, value, persist=persist)

    def set_router_key(self, system_id: str, value: str, *, persist: bool = True) -> None:
        """Save (or, with "", remove) a system's key in secrets.json, bound to its current address."""
        system_id = str(system_id or "")
        identity = _router_identity(self._router_raw(), system_id)
        if not identity:
            raise ValueError(f"there is no system {system_id!r} to keep a key for")
        value = str(value or "")
        if len(value) > 16_384 or any(ord(c) < 32 or ord(c) == 127 for c in value):
            raise ValueError("the key is too long or holds control characters")
        keys = dict(getattr(self, "_router_keys", {}))
        if value:
            keys[system_id] = (value, identity)
        else:
            keys.pop(system_id, None)
        self._router_keys = keys
        if persist:
            self.save()

    # ---- Saved model providers a Pip runs on (0.51) ----------------------------------------------
    def saved_provider(self, provider_id: str) -> dict[str, str] | None:
        """The saved provider a Pip was set to: name, base_url, api_mode, model, api_key; None when it was removed.
        Always as secrets.json has it now, in a private view too: the Pips runner outlives a provider's removal, and
        must never run on what it remembered. Holds the key: never put the record in a result, a log or an event."""
        disk = _disk_json(USER_SECRETS)
        if disk is not None:
            self._saved_providers = _clean_saved_providers(disk.get(SAVED_PROVIDERS))
        elif USER_SECRETS.exists():             # unreadable right now: what this process last read
            pass
        else:
            self._saved_providers = {}
        record = getattr(self, "_saved_providers", {}).get(str(provider_id or ""))
        return dict(record) if record else None

    def set_saved_provider(self, provider_id: str, record: dict | None) -> None:
        """Save a provider (the whole record, with its key), or with None forget it, in secrets.json."""
        provider_id = str(provider_id or "")
        if not _SAVED_PROVIDER_ID.match(provider_id):
            raise ValueError("that isn't a saved provider's id")
        providers = dict(getattr(self, "_saved_providers", {}))
        if record is None:
            providers.pop(provider_id, None)
        else:
            cleaned = _clean_saved_providers({provider_id: record})
            if not cleaned:
                raise ValueError("a saved provider needs a name, an address, an API, a model and a key field")
            providers[provider_id] = cleaned[provider_id]
        self._saved_providers = providers
        self._save_secrets()

    # ---- Image generators (0.51) ---------------------------------------------------------------
    def _images_raw(self):
        """The `images` block as it is now. A long-running process (the Pips supervisor, `dgc serve`) reads it from
        config.json each time: a generator the user told to ask again (`dgc images edit fal --asks`) must ask in a
        process that started before that, never spend on what it remembered."""
        raw = self.data.get("images") if isinstance(getattr(self, "data", None), dict) else None
        if getattr(self, "_persist", False):
            try:
                disk = json.loads(USER_CONFIG.read_text())
            except (OSError, ValueError):
                disk = None
            if isinstance(disk, dict) and "images" in disk:
                raw = disk["images"]
        return raw

    def images_block(self) -> dict:
        """The `images` settings, validated: defaults when never set up; a generator that can't be used is left out."""
        return validate_images(self._images_raw())[0]

    def set_images(self, block, *, persist: bool = True) -> dict:
        """Replace the `images` settings with ``block``, or raise ValueError naming its problems. Returns what was
        saved. A key never travels in the block; a generator whose address changes loses its saved key."""
        cleaned, problems = validate_images(block)
        if problems:
            raise ValueError("; ".join(problems[:6]))
        # The block is read from config.json each time (_images_raw), so it is changed against what is there now:
        # against this process's last write, a change back to it (asking turned on again in Settings after a chat's
        # Always allow turned it off) looked like no change, and save() kept the other process's value.
        if persist and getattr(self, "_persist", False) and isinstance(getattr(self, "_baseline_data", None), dict):
            import copy
            disk = self._images_raw()
            if disk is None:
                self._baseline_data.pop("images", None)
            else:
                self._baseline_data["images"] = copy.deepcopy(disk)
        self.set("images", cleaned, persist=persist)
        return cleaned

    def image_key(self, generator_id: str) -> str:
        """The key saved for ``generator_id``, while it still has the address it was saved for; else ""."""
        generator_id = str(generator_id or "")
        pair = getattr(self, "_image_keys", {}).get(generator_id)
        if getattr(self, "_persist", False):
            # As the block: a key saved (or removed) by another DGC since this one started counts now.
            try:
                disk = json.loads(USER_SECRETS.read_text())
            except (OSError, ValueError):
                disk = None
            if isinstance(disk, dict):
                bound = disk.get("image_identity") if isinstance(disk.get("image_identity"), dict) else {}
                value = disk.get(IMAGE_KEY_PREFIX + generator_id)
                pair = (value, str(bound.get(generator_id) or "")) if isinstance(value, str) and value else None
        if not pair:
            return ""
        value, identity = pair
        return value if identity and _image_identity(self._images_raw(), generator_id) == identity else ""

    def image_key_ids(self) -> list[str]:
        """The generators that have a usable key saved (never the keys)."""
        ids = {g["id"] for g in self.images_block()["generators"]} | set(getattr(self, "_image_keys", {}))
        return sorted(gid for gid in ids if self.image_key(gid))

    def set_image_key(self, generator_id: str, value: str, *, persist: bool = True) -> None:
        """Save (or, with "", remove) a generator's key in secrets.json, bound to its current address."""
        generator_id = str(generator_id or "")
        identity = _image_identity(self._images_raw(), generator_id)
        if not identity:
            raise ValueError(f"there is no image generator {generator_id!r} to keep a key for")
        value = str(value or "")
        if len(value) > 16_384 or any(ord(c) < 32 or ord(c) == 127 for c in value):
            raise ValueError("the key is too long or holds control characters")
        keys = dict(getattr(self, "_image_keys", {}))
        if value:
            keys[generator_id] = (value, identity)
        else:
            keys.pop(generator_id, None)
        self._image_keys = keys
        if persist:
            self.save()

    def adopt_runtime_secrets(self, base: "Config") -> None:
        """Take the runtime credentials the process's first Config was given.

        A launcher's DGC_*_FILE key is read -- and its file deleted -- by the first Config, and a
        key the editor installs with set_runtime_secret lives only in the Config that received it.
        A chat opened later builds its own Config from disk and had neither: every request it made
        went out with no key. Each key keeps the endpoint identity it was given for, so get()
        still refuses it to any other endpoint.
        """
        for key in sorted(getattr(base, "_env_secret_keys", ()) or ()):
            value = base.data.get(key)
            if key in self._env_secret_keys or not isinstance(value, str) or not value:
                continue                    # its own, from an environment still set, wins
            self.data[key] = value
            self._env_secret_keys.add(key)
            identity = getattr(base, "_provider_secret_identity", {}).get(key)
            if key in _PROVIDER_SECRET_KEYS and identity:
                self._provider_secret_identity[key] = identity

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
