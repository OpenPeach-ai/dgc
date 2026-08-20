"""Configuration for dgc: global (~/.dgc/config.json) + project (.dgc/)."""
from __future__ import annotations

import json
import os
from pathlib import Path

APP = "dgc"
USER_HOME = Path.home() / ".dgc"
USER_CONFIG = USER_HOME / "config.json"
USER_MEMORY = USER_HOME / "DGC.md"
USER_SKILLS = USER_HOME / "skills"
USER_AGENTS = USER_HOME / "agents"
BUILTIN_SKILLS = Path(__file__).resolve().parent / "skills_builtin"  # skills shipped with dgc

DEFAULTS: dict = {
    "base_url": "http://localhost:11434/v1",   # any OpenAI-compatible endpoint
    "api_key": "ollama",                        # dummy key works for ollama/lm-studio
    "model": "qwen3:8b",
    "mode": "default",                          # default | acceptEdits | plan | auto
    "thinking": "off",                          # off | low | medium | high
    "context_size": 32768,
    "max_turns": 40,                            # max tool-use iterations per user turn
    "bash_timeout": 120,
    "compact_threshold": 0.85,                  # summarize older turns at this fraction of context_size
    "search_provider": "duckduckgo",            # duckduckgo (keyless) | brave | tavily | searxng
    "search_api_key": "",                       # for brave / tavily
    "search_url": "",                           # for searxng (self-hosted base URL)
    "mcp_servers": {},                          # name -> {command, args, env} stdio MCP servers
    "hooks": {},                                # event -> [{matcher?, command}] lifecycle hooks
    "fallback_model": "",                       # retried if the primary model errors
    "fallback_base_url": "",                    # optional endpoint for the fallback (default: same)
    "subagent_model": "",                       # model for `task` sub-agents (empty: inherit main)
    "subagent_base_url": "",                    # host for sub-agents (empty: inherit main host)
    "subagent_api_key": "",                     # key for the sub-agent host (empty: inherit main)
    "logo_animation": True,                     # animate the startup wordmark (TTY only)
    "theme": "auto",                            # auto (match the terminal) | dark | light
    "suggest": True,                            # ghost-text: predict the next prompt after each turn
    "artifact_port": 45000,                     # the single fixed port the artifact server binds
    "artifact_autostart": True,                 # bring the artifact server up on launch if any are saved
    "background": "inherit",                    # inherit (never repaint — respect the terminal) | auto | dark
    "sandbox": False,                           # confine bash to project dir + /tmp (bwrap/sandbox-exec)
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
# Every preset is an OpenAI-compatible endpoint. Local ones need no real key; cloud ones prompt.
PROVIDERS: dict[str, dict] = {
    "ollama":     {"base_url": "http://localhost:11434/v1",      "api_key": "ollama",    "needs_key": False, "label": "Ollama (local)"},
    "llamacpp":   {"base_url": "http://localhost:8080/v1",       "api_key": "sk-local",  "needs_key": False, "label": "llama.cpp / llama-server (local)"},
    "lmstudio":   {"base_url": "http://localhost:1234/v1",       "api_key": "lm-studio", "needs_key": False, "label": "LM Studio (local)"},
    "vllm":       {"base_url": "http://localhost:8000/v1",       "api_key": "sk-local",  "needs_key": False, "label": "vLLM (local)"},
    "openai":     {"base_url": "https://api.openai.com/v1",      "api_key": "",          "needs_key": True,  "label": "OpenAI (cloud)"},
    "openrouter": {"base_url": "https://openrouter.ai/api/v1",   "api_key": "",          "needs_key": True,  "label": "OpenRouter (cloud — 100s of models)"},
    "groq":       {"base_url": "https://api.groq.com/openai/v1", "api_key": "",          "needs_key": True,  "label": "Groq (cloud)"},
    "deepseek":   {"base_url": "https://api.deepseek.com/v1",    "api_key": "",          "needs_key": True,  "label": "DeepSeek (cloud)"},
    "together":   {"base_url": "https://api.together.xyz/v1",    "api_key": "",          "needs_key": True,  "label": "Together AI (cloud)"},
    "mistral":    {"base_url": "https://api.mistral.ai/v1",      "api_key": "",          "needs_key": True,  "label": "Mistral (cloud)"},
}


# Known context windows (tokens) by model-name substring — so the context budget auto-sizes to
# the model and long sessions compact at the right point. First match wins; unknown → keep current.
MODEL_CATALOG: list[tuple[str, int]] = [
    ("qwen3", 32768), ("qwen2.5", 32768), ("qwen2", 32768), ("qwen", 32768),
    ("gpt-oss", 131072), ("llama3.1", 131072), ("llama-3.1", 131072), ("llama3.3", 131072),
    ("llama-3.3", 131072), ("deepseek-v3", 65536), ("deepseek", 65536),
    ("mixtral", 32768), ("mistral", 32768), ("codestral", 32768),
    ("gpt-4o", 128000), ("gpt-5", 400000), ("gpt-4", 128000), ("o1", 200000), ("o3", 200000),
    ("gemma", 8192), ("phi", 16384), ("command-r", 131072), ("claude", 200000),
    ("kimi", 131072), ("glm", 131072),
]


def context_for_model(model: str) -> int | None:
    """The known context window for `model`, or None if unrecognised (keep the current setting)."""
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
        self.data: dict = dict(DEFAULTS)
        self.permissions: dict[str, list[str]] = {"allow": [], "ask": [], "deny": []}
        self.load()

    def load(self) -> None:
        raw: dict = {}
        if USER_CONFIG.exists():
            try:
                raw = json.loads(USER_CONFIG.read_text())
            except json.JSONDecodeError:
                raw = {}
        perms = raw.pop("permissions", {})
        self.data.update(raw)
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

    def save(self) -> None:
        USER_HOME.mkdir(parents=True, exist_ok=True)
        payload = dict(self.data)
        payload["permissions"] = self.permissions
        USER_CONFIG.write_text(json.dumps(payload, indent=2) + "\n")

    def get(self, key: str, default=None):
        return self.data.get(key, default)

    def set(self, key: str, value) -> None:
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
