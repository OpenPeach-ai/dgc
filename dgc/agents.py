"""Named sub-agent definitions — Markdown files that give the `task` tool a persona
plus (optionally) its OWN model and host.

A sub-agent is a Markdown file with frontmatter:

    ---
    name: reviewer
    description: Careful code reviewer
    model: qwen3:14b                 # optional — else subagent_model, else the main model
    base_url: http://gpu-box:11434/v1  # optional — run this agent on a DIFFERENT host
    api_mode: ollama                 # optional — auto | ollama | anthropic | chat_completions | responses
    api_key_env: REVIEWER_API_KEY    # optional — key from an environment variable
    effort: high                     # optional — off | low | medium | high
    ---

    System guidance the sub-agent follows for this kind of task...

Discovery (project overrides user):
  <project>/.dgc/agents/<name>.md
  ~/.dgc/agents/<name>.md

Invoked via the `task` tool's optional `agent` argument, or listed with `/agents`.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .config import USER_AGENTS


@dataclass
class AgentDef:
    name: str
    description: str
    body: str
    model: str = ""
    base_url: str = ""
    api_mode: str = ""
    api_key_env: str = ""
    effort: str = ""


def _parse_agent(path: Path) -> AgentDef | None:
    try:
        text = path.read_text()
    except OSError:
        return None
    fields = {"name": path.stem, "description": "", "model": "",
              "base_url": "", "api_mode": "", "api_key_env": "", "effort": ""}
    body = text
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            front = text[3:end].strip()
            body = text[end + 4:].strip()
            for line in front.splitlines():
                if ":" not in line:
                    continue
                key, _, value = line.partition(":")
                key, value = key.strip().lower(), value.strip()
                if key in fields and value:
                    fields[key] = value
    return AgentDef(body=body, **fields)


def discover_agents(project_root) -> dict[str, AgentDef]:
    agents: dict[str, AgentDef] = {}
    for base in (USER_AGENTS, Path(project_root) / ".dgc" / "agents"):
        if base.is_dir():
            for f in sorted(base.glob("*.md")):
                a = _parse_agent(f)
                if a:
                    agents[a.name] = a   # project scanned last → overrides personal
    return agents
