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
    effort: high                     # optional — off | low | medium | high | xhigh
    context_size: 65536              # optional — its context window; else subagent_context_size, else the main one
    tools: read_file, glob, grep     # optional — allow-list; omit for the full child catalog
    ---

    System guidance the sub-agent follows for this kind of task...

Discovery (trusted project overrides user, which overrides built-ins):
  built-in explorer / researcher / critic / worker
  ~/.dgc/agents/<name>.md
  <project>/.dgc/agents/<name>.md

Invoked via the `task` tool's optional `agent` argument, or listed with `/agents`.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from .config import USER_AGENTS

_READS = "read_file, glob, grep, repo_map, code_intel, git_diff, web_fetch, web_search, skill, view_image"
_HANDOFF = (
    "End your result with a short summary, then a line `FILES: path[, path…]` naming every "
    "file you wrote or the files a reader should open. If you wrote nothing, omit FILES."
)


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
    context_size: str = ""
    tools: str = ""
    builtin: bool = False
    tool_allow: frozenset[str] = field(default_factory=frozenset)

    def __post_init__(self):
        names = {part.strip() for part in str(self.tools or "").split(",") if part.strip()}
        self.tool_allow = frozenset(names)


def builtin_agents() -> dict[str, AgentDef]:
    """Always-on specialists. A user or project file with the same name replaces one."""
    return {
        "explorer": AgentDef(
            name="explorer", builtin=True, tools=_READS,
            description="Read-only search and map of the codebase",
            body="You are a read-only explorer. Search and read. Do not write, edit, or run "
                 "mutating shell commands. Report where the relevant code lives and how it fits "
                 "together, with path:line references; quote only the lines that matter.\n"
                 + _HANDOFF),
        "researcher": AgentDef(
            name="researcher", builtin=True, tools=_READS + ", write_file, present_document",
            description="Investigate and write one findings file, then stop",
            body="You are a researcher. Investigate, then write one markdown findings file in "
                 "the project. Do not implement the feature.\n" + _HANDOFF),
        "critic": AgentDef(
            name="critic", builtin=True,
            tools=_READS + ", edit_file, write_file, multi_edit",
            description="Review named files or a change; correct them or list blocking issues",
            body="You are a critic. Review the files or change named in the task against its "
                 "requirements: correctness, missed cases, tests. Correct those files or list "
                 "blocking issues. Do not implement the surrounding feature.\n" + _HANDOFF),
        "worker": AgentDef(
            name="worker", builtin=True, tools="",
            description="Implement a bounded change",
            body="You are a worker. Implement the bounded change in the task. Keep the diff "
                 "small and verify when tests exist.\n" + _HANDOFF),
    }


def parse_handoff_files(text: str) -> list[str]:
    """Paths from a trailing `FILES:` line in a child's summary."""
    files: list[str] = []
    for raw in str(text or "").splitlines():
        line = raw.strip()
        if not line.upper().startswith("FILES:"):
            continue
        rest = line.split(":", 1)[1]
        files = [part.strip().strip("`") for part in rest.split(",") if part.strip().strip("`")]
    return files[:16]


def _parse_agent(path: Path) -> AgentDef | None:
    try:
        text = path.read_text()
    except OSError:
        return None
    fields = {"name": path.stem, "description": "", "model": "",
              "base_url": "", "api_mode": "", "api_key_env": "", "effort": "", "context_size": "",
              "tools": ""}
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


def discover_agents(project_root, *, config=None) -> dict[str, AgentDef]:
    """Built-ins, then personal definitions, then project definitions after directory trust.

    A project definition can select a model endpoint and an environment key. Even read-only
    automation must not load it before trust; permission-gating its later tools is too late.
    Callers without a trust-bearing config receive built-ins and personal definitions only.
    """
    from .trust import is_trusted

    agents: dict[str, AgentDef] = dict(builtin_agents())
    bases = [USER_AGENTS]
    if config is not None and is_trusted(config, project_root):
        bases.append(Path(project_root) / ".dgc" / "agents")
    for base in bases:
        if base.is_dir():
            for f in sorted(base.glob("*.md")):
                a = _parse_agent(f)
                if a:
                    agents[a.name] = a   # project scanned last → overrides personal and built-ins
    return agents
