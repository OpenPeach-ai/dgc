"""Configuration for dgc: global (~/.dgc/config.json) + project (.dgc/)."""
from __future__ import annotations

import copy
import json
import os
import tempfile
from pathlib import Path

APP = "dgc"
USER_HOME = Path.home() / ".dgc"
USER_CONFIG = USER_HOME / "config.json"
USER_SECRETS = USER_HOME / "secrets.json"
USER_MEMORY = USER_HOME / "DGC.md"
USER_SKILLS = USER_HOME / "skills"
USER_AGENTS = USER_HOME / "agents"
BUILTIN_SKILLS = Path(__file__).resolve().parent / "skills_builtin"  # skills shipped with dgc
SECRET_KEYS = frozenset({"api_key", "search_api_key", "subagent_api_key", "fallback_api_key"})
SECRET_ENV = {"api_key": "DGC_API_KEY", "search_api_key": "DGC_SEARCH_API_KEY",
              "subagent_api_key": "DGC_SUBAGENT_API_KEY",
              "fallback_api_key": "DGC_FALLBACK_API_KEY"}


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
    "think_budget_tokens": 8000,                # over-thinking watchdog: abort+retry-with-less if a
                                                #   model reasons past this many tokens with no output (0=off)
    "max_tokens": 16384,                        # output-token backstop per request; length-truncation
                                                #   auto-continues (0=don't send, respect the server)
    # sampling knobs — "" = respect the server default. Set these to tame a LOCAL model that loops or
    # repeats (raw llama.cpp/Ollama defaults often do). Qwen likes temperature 0.7 / top_p 0.8 / top_k 20.
    "temperature": "",                          # 0.0–2.0; lower = more deterministic
    "top_p": "",                                # nucleus sampling, 0.0–1.0
    "top_k": "",                                # only the top-K tokens (Ollama/llama.cpp/vLLM/SGLang)
    "min_p": "",                                # min-probability floor (llama.cpp/vLLM/SGLang)
    "context_size": 32768,
    "max_turns": 80,                            # max tool-use iterations per user turn (the grind +
                                                #   doom-loop guards catch thrash, so this is a backstop)
    "turn_budget_s": 0,                         # wall-clock seconds per turn before DGC triages to finish
                                                #   (0 = OFF: no time pressure — for slow local models). When
                                                #   >0 (e.g. a benchmark cap), DGC nudges itself to land+verify
                                                #   the fix as the clock runs down and preserves the last
                                                #   test-passing files if it runs out of time (no 0-credit).
    "tool_profile": "adaptive",                 # adaptive intent-aware catalog | full catalog every round
    "ollama_keep_alive": "30m",                 # keep an Ollama model resident between turns (D2 speedup;
                                                #   only sent to the ollama provider; "" = don't send)
    "verify_before_done": False,                # E: after edits, run verify_command before ending the turn;
    "verify_command": "",                       #   timed auto runs it after edit-only batches so red evidence
                                                #   skips a model round. e.g. "npm test" / "pytest -q"
    "bash_timeout": 120,
    "search_timeout": 15,                       # bounded internal grep/glob helper lifetime (1-60s)
    "request_timeout": 1800,                    # seconds to wait BETWEEN streamed chunks (slow-prefill guard)
    "approval_timeout_s": 300,                  # abandoned IDE permission prompts fail closed
    "compact_threshold": 0.85,                  # summarize older turns at this fraction of context_size
    "session_redaction": True,                  # strip credentials from durable transcript/plan history;
                                                # exact file rewind snapshots stay private and unchanged
    "search_provider": "duckduckgo",            # duckduckgo (keyless) | brave | tavily | searxng
    "search_api_key": "",                       # for brave / tavily
    "search_url": "",                           # for searxng (self-hosted base URL)
    "mcp_servers": {},                          # name -> {command, args, env} stdio MCP servers
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
    "subagent_worktree_root": "",                # private task checkout storage (empty: ~/.dgc/worktrees)
    "fleet_worktree_root": "",                   # private TUI fleet checkouts (empty: ~/.dgc/fleet-worktrees)
    "max_parallel_tasks": 4,                     # 1 disables; max 8 concurrent isolated task workers
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
    "background": "inherit",                    # inherit (never repaint — respect the terminal) | auto | dark
    "sandbox": False,                           # OS-confine bash; approval policy remains independent
    "sandbox_network": False,                   # deny sandboxed bash network unless explicitly enabled
    "sandbox_env_allow": [],                    # extra parent env names; runtime injection vars stay blocked
    "show_reasoning": True,                      # show the model's thinking (muted) in the chat
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
    "llamacpp":   {"base_url": "http://localhost:8080/v1",       "api_key": "sk-local",  "needs_key": False, "label": "llama.cpp / llama-server (local)"},
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


def context_for_model(model: str) -> int | None:
    """A recommended operating window for `model`, or None to keep the current setting."""
    m = (model or "").lower()
    for pat, ctx in MODEL_CATALOG:
        if pat in m:
            return ctx
    return None


def find_project_root(start: Path | None = None) -> Path:
    """Walk up from `start` looking for a project marker (.git, DGC.md, .dgc)."""
    p = Path(start or os.getcwd()).resolve()
    for d in (p, *p.parents):
        dgc_dir = d / ".dgc"
        # a project's own .dgc counts, but NOT the global ~/.dgc config dir — otherwise every
        # folder under $HOME resolves its project root all the way up to $HOME.
        if (d / ".git").exists() or (d / "DGC.md").exists() or \
           (dgc_dir.is_dir() and dgc_dir != USER_HOME):
            return d
    return p


class Config:
    def __init__(self, project_root: Path | None = None):
        self.project_root = project_root or find_project_root()
        self.project_dir = self.project_root / ".dgc"
        self._persist = True
        self.data: dict = dict(DEFAULTS)
        self._stored_secrets: dict = {}
        self._env_secret_keys: set[str] = set()
        self.permissions: dict[str, list[str]] = {"allow": [], "ask": [], "deny": []}
        self.load()

    def load(self) -> None:
        raw: dict = {}
        if USER_CONFIG.exists():
            try:
                raw = json.loads(USER_CONFIG.read_text())
            except json.JSONDecodeError:
                raw = {}
        secrets: dict = {}
        if USER_SECRETS.exists():
            try:
                value = json.loads(USER_SECRETS.read_text())
                secrets = value if isinstance(value, dict) else {}
            except (OSError, json.JSONDecodeError):
                secrets = {}
        migrated = False
        for key in SECRET_KEYS:                 # migrate legacy keys out of config.json on first load
            if key in raw:
                secrets[key] = raw.pop(key)
                migrated = True
        perms = raw.pop("permissions", {})
        self.data.update(raw)
        self._stored_secrets = {k: secrets[k] for k in SECRET_KEYS if k in secrets}
        self.data.update(self._stored_secrets)
        for key, env_name in SECRET_ENV.items():
            if env_name in os.environ:
                self.data[key] = os.environ[env_name]
                self._env_secret_keys.add(key)
        for action in ("allow", "ask", "deny"):
            self.permissions[action] = list(perms.get(action, []))
        # project-level permission rules merge in (never persisted back to global)
        proj_perms = self.project_dir / "permissions.json"
        if proj_perms.exists():
            try:
                pp = json.loads(proj_perms.read_text())
                for action in ("allow", "ask", "deny"):
                    self.permissions[action] += list(pp.get(action, []))
            except json.JSONDecodeError:
                pass
        if migrated:
            self.save()

    def save(self) -> None:
        if not self._persist:
            return
        payload = {k: v for k, v in self.data.items() if k not in SECRET_KEYS}
        payload["permissions"] = self.permissions
        _write_private_json(USER_CONFIG, payload)
        # Environment-provided credentials are ephemeral references. A harmless settings change
        # must never copy a CI/process secret into ~/.dgc/secrets.json.
        secrets = {k: (self._stored_secrets.get(k, "") if k in self._env_secret_keys
                       else self.data.get(k, "")) for k in SECRET_KEYS}
        self._stored_secrets = dict(secrets)
        _write_private_json(USER_SECRETS, secrets)

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
        clone._env_secret_keys = set(self._env_secret_keys)
        clone.permissions = self.permissions
        if hasattr(self, "session_permissions"):
            clone.session_permissions = self.session_permissions
        return clone

    def get(self, key: str, default=None):
        return self.data.get(key, default)

    def set(self, key: str, value) -> None:
        # Provider credentials are endpoint-scoped. Reusing an old key after a host change can
        # disclose a cloud credential to an unrelated server, so invalidate both the live and
        # persisted value before saving the new route. A caller that owns the new key sets it next.
        route_secrets = {
            "base_url": "api_key",
            "subagent_base_url": "subagent_api_key",
            "fallback_base_url": "fallback_api_key",
        }
        secret = route_secrets.get(key)
        current = str(self.data.get(key, "")).rstrip("/").lower()
        incoming = str(value).rstrip("/").lower()
        if secret and current != incoming:
            self.data[secret] = ""
            self._stored_secrets[secret] = ""
            self._env_secret_keys.discard(secret)
        self.data[key] = value
        self.save()

    # convenience accessors -------------------------------------------------
    @property
    def base_url(self) -> str:
        return str(self.data["base_url"]).rstrip("/")

    @property
    def api_key(self) -> str:
        return str(self.data["api_key"])

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
