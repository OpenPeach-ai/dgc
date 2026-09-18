"""A strictly typed consumer of every public dgc_sdk name. Checked, never executed:

    python -m mypy --strict tests/sdk_typing/public_api.py

mypy reports no errors inside an installed package, so this file is how CI proves the public
surface is typed: an unannotated signature shows up here as a call to an untyped function, and a
wrong annotation as a type error.
"""
from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from typing import Any, Literal

import dgc_sdk
from dgc_sdk import (
    PROTOCOL, REQUIRES_CLI, AgentInfo, Artifact, AsyncDGC, AsyncRunHandle, AsyncSession, Checkpoint,
    DGC, DGCConfigError, DGCError, DGCProtocolError, DGCRuntimeError, DGCTimeoutError,
    DGCUnsupportedError, FileChange, Goal, HookInfo, McpInputRequest, McpInputResponse, McpServerInfo,
    Monitor, OnMcpInput, OnPermission, OnPlan, OnQuestion, PermissionAction, PermissionMode,
    PermissionPolicy, PermissionRequest, PermissionRule, PlanAction, PlanRequest, Pricing, Question,
    QuestionAnswer, QuestionOption, QuestionRequest, RetryPolicy, RunEvent, RunHandle, RunResult,
    RunStatus, RuntimePolicy, SandboxPolicy, SandboxRequirement, Session, SessionInfo, SkillInfo,
    TaskItem, TaskStatus, ToolRecord, ToolSpec, UnhandledPolicy, VerificationResult, cost_usd,
    define_tool, redact, redact_text,
)

VERSION: str = dgc_sdk.__version__
PROTOCOL_VERSION: int = PROTOCOL
MINIMUM_CLI: str = REQUIRES_CLI
MODE: PermissionMode = "plan"
UNHANDLED: UnhandledPolicy = "deny"
REQUIREMENT: SandboxRequirement = "off"
TERMINAL: tuple[RunStatus, ...] = ("completed", "failed", "cancelled", "blocked")
TASK: TaskStatus = "pending"
ERRORS: tuple[type[DGCError], ...] = (DGCConfigError, DGCProtocolError, DGCRuntimeError,
                                      DGCTimeoutError, DGCUnsupportedError)


def allow_reads(request: PermissionRequest) -> PermissionAction:
    return "once" if request.name in ("read_file", "grep") else "deny"


def approve_plan(request: PlanRequest) -> PlanAction:
    return "default" if request.plan else "reject"


def answer(request: QuestionRequest) -> Mapping[str, QuestionAnswer] | Literal["dismiss"]:
    answers: dict[str, QuestionAnswer] = {}
    for question in request.questions:
        option: QuestionOption = question.options[0]
        answers[question.id] = QuestionAnswer(selected=(0,), other=option.label)
    return answers or "dismiss"


def decline(request: McpInputRequest) -> McpInputResponse:
    return McpInputResponse(action="decline", content={"server": request.server})


ON_PERMISSION: OnPermission = allow_reads
ON_PLAN: OnPlan = approve_plan
ON_QUESTION: OnQuestion = answer
ON_MCP_INPUT: OnMcpInput = decline


def lookup(args: Mapping[str, Any]) -> dict[str, Any]:
    return {"sku": args.get("sku"), "stock": 3}


TOOL: ToolSpec = define_tool("sku_lookup", "Look up a SKU", {"type": "object"}, lookup, timeout=5.0)


def summarize(result: RunResult) -> str:
    tools: list[ToolRecord] = result.tools
    changes: list[FileChange] = result.changes
    artifacts: list[Artifact] = result.artifacts
    tasks: list[TaskItem] = result.tasks
    agents: list[AgentInfo] = result.agents
    verification: VerificationResult | None = result.verification
    status: RunStatus = result.status
    parts = [status, result.reason, result.final_text, str(result.error), str(result.output)]
    parts += [tool.name for tool in tools] + [change.path for change in changes]
    parts += [item.url for item in artifacts] + [task.content for task in tasks]
    parts += [agent.id for agent in agents]
    if verification is not None:
        parts.append(str(verification.ok))
    return " ".join(parts)


def use_session(session: Session) -> str:
    result: RunResult = session.run("Summarize.", timeout=60.0, max_turns=4,
                                    output_schema={"type": "object"}, repair_attempts=1)
    handle: RunHandle = session.stream("Summarize.", timeout=60.0)
    with handle:
        for event in handle:
            kind: str = event.type
            data: Mapping[str, Any] = event.data
            if kind == "text_delta":
                print(data.get("text"))
        streamed: RunResult = handle.result()
    handle.cancel()
    session.cancel()
    session.steer("Prefer the smaller fix.")
    session.followup("Then run the tests.")
    sessions: list[SessionInfo] = session.list_sessions()
    checkpoints: list[Checkpoint] = session.list_checkpoints()
    skills: list[SkillInfo] = session.list_skills()
    hooks: list[HookInfo] = session.list_hooks()
    rules: list[PermissionRule] = session.list_permissions()
    rules = session.add_permission_rule("deny", "Bash(rm *)")
    rules = session.remove_permission_rule("deny", "Bash(rm *)")
    servers: list[McpServerInfo] = session.list_mcp_servers()
    monitors: list[Monitor] = session.list_monitors()
    goal: Goal = session.get_goal()
    goal = session.set_goal("ship it", status="active")
    memory: Mapping[str, str] = session.get_memory()
    session.add_memory("uses pytest")
    session.rewind(0)
    session.fork("branch")
    session.history()
    session.get_config()
    session.get_plan()
    session.get_usage()
    session.list_artifacts()
    session.list_agents()
    session.clear_todos()
    session.get_skill("review")
    session.set_skill_enabled("review", True)
    session.add_mcp_server("docs", "docs-mcp", ["--stdio"])
    session.stop_monitor()
    session.generate_handoff()
    session.name_session("checkout")
    session.new_session()
    session.delete_session(sessions[0].path)
    session.bind_identity()
    identity: str = session.session_id + session.session_path
    session.close()
    return " ".join([summarize(result), summarize(streamed), identity, goal.text, str(len(memory)),
                     str(len(checkpoints) + len(skills) + len(hooks) + len(rules) + len(servers)
                         + len(monitors))])


def use_client(state: Path) -> str:
    with DGC(state_dir=state, model="qwen3:8b", base_url="http://127.0.0.1:11434/v1", api_key=None,
             mode="plan", pricing=Pricing(input_per_million=1.0, output_per_million=2.0),
             department="erp", policy=RuntimePolicy(network="deny", deny_tools=("write_file",)),
             retry=RetryPolicy(max_attempts=2), sandbox={"requirement": REQUIREMENT}) as dgc:
        version: str = dgc.version
        runtime: list[str] = dgc.raw_runtime
        session = dgc.session(cwd=state, permissions={"mode": MODE, "unhandled": UNHANDLED},
                              on_permission=ON_PERMISSION, on_plan=ON_PLAN, on_question=ON_QUESTION,
                              on_mcp_input=ON_MCP_INPUT, tools=[TOOL], decision_timeout=None)
        text = use_session(session)
        resumed: Session = dgc.resume(session.session_id, cwd=state)
        latest: Session = dgc.resume(latest=True, cwd=state)
        report: Mapping[str, Any] = dgc.usage_report(department="erp")
        rows: list[dict[str, Any]] = dgc.export_audit(session.session_id)
        resumed.close()
        latest.close()
    cost: float | None = cost_usd(1000, 500, 0, Pricing(output_per_million=10.0))
    safe: Any = redact({"api_key": "x"})
    return " ".join([version, runtime[0], text, str(report.get("runs")), str(len(rows)), str(cost),
                     redact_text("Bearer x"), str(safe),
                     str(PermissionPolicy(mode=MODE, unhandled=UNHANDLED)),
                     str(SandboxPolicy(requirement=REQUIREMENT)), str(Question(id="q", question="?")),
                     str(TASK), str(ERRORS)])


async def use_async(state: Path) -> str:
    async with AsyncDGC(state_dir=state, model="qwen3:8b", base_url="http://127.0.0.1:11434/v1") as dgc:
        version: str = dgc.version
        session: AsyncSession = await dgc.session(cwd=state, permissions={"mode": "plan", "unhandled": "deny"})
        result: RunResult = await session.run("Summarize.", timeout=60.0)
        handle: AsyncRunHandle = await session.stream("Summarize.")
        async with handle:
            async for event in handle:
                seen: RunEvent = event
                print(seen.type)
            streamed: RunResult = await handle.result()
        await session.cancel()
        sessions: list[SessionInfo] = await session.list_sessions()
        checkpoints: list[Checkpoint] = await session.list_checkpoints()
        goal: Goal = await session.get_goal()
        rules: list[PermissionRule] = await session.list_permissions()
        servers: list[McpServerInfo] = await session.list_mcp_servers()
        await session.close()
        resumed: AsyncSession = await dgc.resume(latest=True, cwd=state)
        await resumed.close()
    return " ".join([version, summarize(result), summarize(streamed), goal.text,
                     str(len(sessions) + len(checkpoints) + len(rules) + len(servers))])
