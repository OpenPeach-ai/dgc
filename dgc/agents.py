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
  built-in explorer / researcher / critic / verifier / worker
  ~/.dgc/agents/<name>.md
  <project>/.dgc/agents/<name>.md

Definitions must be regular UTF-8 files, at most 256 KiB. Unreadable or oversized files are skipped.

Invoked via the `task` tool's optional `agent` argument, or listed with `/agents`.
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace
from pathlib import Path

from .config import USER_AGENTS
from .workspace import read_regular_bytes

MAX_AGENT_FILE_BYTES = 256 * 1024

_READS = "read_file, glob, grep, repo_map, code_intel, git_diff, web_fetch, web_search, skill, view_image"
_HANDOFF = (
    "Keep going until the task's done-when holds, or you are blocked and can say exactly why: a "
    "helper that stops early hands its job back undone. End your result with a short summary: what "
    "you checked and how (each command and its result), and what you could not check. Then a line "
    "`FILES: path[, path…]` naming every file you wrote or the files a reader should open. If you "
    "wrote nothing, omit FILES."
)
# A reviewer judges the work against what was asked, never against what it would have asked for. The goal soak (16
# Nov): critics found committed items unmet against requirements no plan had written ("100 seeded-random cases",
# "365 days of moon phases"), and the model reworked those items to satisfy them.
_STATED_ONLY = (
    "Judge it against the requirements the task, its objective and its plan actually state. Quote each requirement "
    "you check, word for word, and say whether the evidence meets it. A real defect (a wrong result, a crash, broken "
    "behaviour, a failing test) always counts, stated or not. What never counts as unmet is a NEW requirement the task "
    "didn't state (more cases, more checks, another design): put those under a separate heading, \"Suggestions (not "
    "required)\"."
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
            description="Investigate until the question is answered; write findings when asked",
            body="You are a researcher. Investigate until the task's question is answered: read widely and "
                 "check each claim against the code or a source. Write a markdown findings file in the "
                 "project when the task asks for one. Do not implement the feature.\n" + _HANDOFF),
        "critic": AgentDef(
            name="critic", builtin=True,
            tools=_READS + ", edit_file, write_file, multi_edit",
            description="Review named files or a change; correct them or list blocking issues",
            body="You are a critic. Review the files or change named in the task: correctness, missed cases, "
                 "tests. " + _STATED_ONLY + " Correct those files or list blocking issues, each tied to a quoted "
                 "requirement. Do not implement the surrounding feature.\n" + _HANDOFF),
        # A troupe has its own verifier (troupe_agent.ROLE: read only, answers in JSON); this one is for `task`, and
        # verifying a change usually means running its tests, in the child's own checkout.
        "verifier": AgentDef(
            name="verifier", builtin=True, tools=_READS + ", bash",
            description="Try to disprove a claim or change by running checks; edits nothing",
            body="You are a verifier. Try to prove the claim or change named in the task wrong: read what it "
                 "names and run the tests or commands that would show it fails. Do not edit or write files. "
                 + _STATED_ONLY + " Start with CONFIRMED, REFUTED or UNSURE, then the evidence: path:line "
                 "references and each command you ran with its result.\n" + _HANDOFF),
        "worker": AgentDef(
            name="worker", builtin=True, tools="",
            description="Do a job: make the change and run its checks until done",
            body="You are a worker. Do the job in the task: make the change, run its checks yourself (its "
                 "tests, a build, the command it names) and fix what fails. Change only what the job needs.\n"
                 + _HANDOFF),
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


def _parse_agent(path: Path, *, project_root: Path | None = None) -> AgentDef | None:
    try:
        # Resolve the parent for account-home aliases, but leave the final
        # component untouched so a symlinked definition is refused on open.
        target = path.parent.resolve(strict=True) / path.name
        if project_root is not None:
            target.relative_to(project_root.resolve(strict=True))
        captured = read_regular_bytes(target, maximum=MAX_AGENT_FILE_BYTES)
        text = captured[0].decode("utf-8")
    except (OSError, UnicodeError, RuntimeError, ValueError):
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

    A launching process's session policy (the SDK) can additionally withhold project agents from a
    workspace it has not been told to trust, even one the isolated config marks trusted: choosing
    an endpoint and a credential env var is exactly the workspace-supplied capability an SDK
    session must not grant itself. Even when it opts in, a project definition under an SDK session
    keeps only its persona (body/tools): its ``base_url``, ``api_key_env``, ``api_mode`` and
    ``model`` are dropped, so a checkout — or the model rewriting one mid-run — cannot point a
    sub-agent (even a built-in it shadows) at an arbitrary host with this session's credential.
    """
    from .permissions import (session_policy, session_project_agents_allowed,
                              session_restricts_agent_routing)
    from .trust import is_trusted

    agents: dict[str, AgentDef] = dict(builtin_agents())
    bases: list[tuple[Path, bool]] = [(USER_AGENTS, False)]
    if (config is not None and is_trusted(config, project_root)
            and session_project_agents_allowed()):
        bases.append((Path(project_root) / ".dgc" / "agents", True))
    restrict_routing = session_restricts_agent_routing()
    for base, is_project in bases:
        if base.is_dir():
            for f in sorted(base.glob("*.md")):
                a = _parse_agent(f, project_root=Path(project_root) if is_project else None)
                if not a:
                    continue
                if is_project and restrict_routing:
                    a = replace(a, base_url="", api_key_env="", api_mode="", model="")
                agents[a.name] = a   # project scanned last → overrides personal and built-ins
    return agents
