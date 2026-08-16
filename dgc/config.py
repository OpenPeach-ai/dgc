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


def find_project_root(start: Path | None = None) -> Path:
    """Walk up from `start` looking for a project marker (.git, DGC.md, .dgc)."""
    p = Path(start or os.getcwd()).resolve()
    for d in (p, *p.parents):
        if (d / ".git").exists() or (d / "DGC.md").exists() or (d / ".dgc").is_dir():
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
