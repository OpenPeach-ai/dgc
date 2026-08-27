# Non-coding surface test reference

This is the wiring contract for plan mode, goals, sessions, skills, hooks, MCP, artifacts,
permissions, output presentation, and the VS Code/Cursor client. It is intentionally separate from
model-quality benchmarks. Run it against the exact candidate being evaluated; do not infer built-in
slash behavior by sending slash text through `dgc -p`.

## Discover and validate the installed interface

The installed runtime is authoritative:

```bash
dgc protocol describe --compact > protocol.json
jq '.slash_commands.tui' protocol.json
jq '.slash_commands.classic' protocol.json
jq '.slash_commands.editor' protocol.json
jq '.headless.commands, .headless.events' protocol.json
dgc protocol validate command docs/fixtures/noncoding-surface-commands.ndjson
```

The slash catalogs include canonical names, descriptions, usages, aliases, and editor actions.
Project commands from `.dgc/commands/*.md` are runtime data and appear in the `ready` event's
`custom_commands` field instead. The typed `slash_command` frame invokes only those custom prompt
templates. A built-in such as `/goal` sent through `dgc -p` or `slash_command` is model text, not a
control operation.

For deterministic orchestration, use the bundled dependency-free client:

```python
from dgc.client import DGCClient

with DGCClient(cwd="/absolute/path/to/project") as dgc:
    status = dgc.request({"type": "status"}, "status")
```

`request()` uses a wire-sequence barrier for legacy commands without IDs. Query and state commands
accept an optional bounded `request_id`; use one whenever more than one operation may be outstanding.
The `ready.capabilities.correlated_state_requests` flag confirms this extension is active.

## Plan mode and plan artifact

`dgc -p PROMPT --mode plan` enters plan mode, but a real `present_plan` call requires an approval
decision. CI should use `dgc serve` through `DGCClient`:

```python
with DGCClient(cwd=project) as dgc:
    dgc.request(
        {"type": "set_mode", "mode": "plan", "request_id": "mode-1"},
        "mode_changed",
        request_id="mode-1",
    )
    dgc.send({
        "type": "prompt",
        "text": "Inspect the repository and call present_plan with exactly two steps. Do not edit.",
    })
    proposal = dgc.wait_for("plan_proposal")

    saved = dgc.request(
        {"type": "get_plan", "request_id": "plan-read-1"},
        "saved_plan",
        request_id="plan-read-1",
    )
    assert saved["exists"] and saved["plan"] == proposal["plan"]

    # plan_artifact defaults on; unrelated events remain queued by DGCClient.
    preview = dgc.wait_for("artifact_ready")
    assert preview["url"].startswith("http://127.0.0.1:")

    dgc.send({
        "type": "plan_response",
        "id": proposal["id"],
        "decision": "reject",
        "feedback": "matrix probe complete",
    })
    dgc.send({"type": "cancel"})
```

The durable plan is the private `<session>.plan.md` sidecar. The preview is self-contained and
loopback-only. Use `default`, `acceptEdits`, or `auto` instead of `reject` only when the test intends
to execute the plan; mutation modes can require explicit workspace-trust acknowledgement.

## Skills

Create `.dgc/skills/matrix-fixture/SKILL.md`:

```markdown
---
name: matrix-fixture
description: Independent matrix fixture
---

Say MATRIX_SKILL_LOADED.
```

Then inspect the loaded precedence layer without exposing a host path:

```python
catalog = dgc.request(
    {"type": "list_skills", "request_id": "skills-1"},
    "skill_catalog",
    request_id="skills-1",
)
assert any(item == {
    "name": "matrix-fixture",
    "description": "Independent matrix fixture",
    "source": "project",
} for item in catalog["items"])
```

There is no typed headless equivalent of classic `/skill NAME ARGS`; listing is typed, while model
activation remains prompt/intent driven.

## Goal, handoff, and settings

```python
changed = dgc.request(
    {"type": "set_goal", "text": "finish matrix", "status": "active",
     "request_id": "goal-set-1"},
    "goal_changed",
    request_id="goal-set-1",
)
goal = dgc.request(
    {"type": "get_goal", "request_id": "goal-read-1"},
    "goal_changed",
    request_id="goal-read-1",
)
assert (goal["goal"], goal["status"]) == ("finish matrix", "active")

handoff = dgc.request(
    {"type": "generate_handoff", "request_id": "handoff-1", "save": False},
    "handoff",
    request_id="handoff-1",
)
assert handoff["status"] == "completed" and handoff["path"] is None

config = dgc.request(
    {"type": "set_config", "values": {"context_size": 40960},
     "request_id": "config-set-1"},
    "config",
    request_id="config-set-1",
)
readback = dgc.request(
    {"type": "get_config", "request_id": "config-read-1"},
    "config",
    request_id="config-read-1",
)
assert readback["context_size"] == 40960
```

Goal transitions are `active`, `completed`, `blocked`, and `none`. An empty-text state update changes
an existing goal; `none` clears it. Handoff generation requires a configured model. `save: false`
keeps the test side-effect-free.

`set_config` intentionally supports only the fields reported by the protocol-backed settings panel:

```text
subagent_model, subagent_base_url, subagent_api_key, subagent_api_mode,
api_mode, provider_state, prompt_cache, prompt_cache_key,
provider_capabilities, capability_cache_ttl_s,
fallback_model, fallback_base_url, fallback_api_key, fallback_api_mode,
context_size, search_provider
```

Use `set_model`, `set_mode`, and `set_think` for their respective state. Run persistence tests with a
disposable process environment whose `HOME` points at a temporary directory; set it before starting
the DGC child so imports resolve the intended config root.

## Sessions

Exact one-shot forms:

```bash
dgc --continue -p "Continue and report current state."
dgc -c -p "Continue and report current state."
dgc --resume SESSION_ID -p "Continue and report current state."
```

`dgc --resume` without an ID opens an interactive picker and is not a headless test. Typed forms:

```python
sessions = dgc.request(
    {"type": "list_sessions", "request_id": "sessions-1"},
    "sessions",
    request_id="sessions-1",
)
resumed = dgc.request(
    {"type": "resume_session", "latest": True, "request_id": "resume-1"},
    "session",
    request_id="resume-1",
)
# Or use the exact project-scoped path returned by list_sessions:
resumed = dgc.request(
    {"type": "resume_session", "path": session_path, "request_id": "resume-2"},
    "session",
    request_id="resume-2",
)
```

## MCP

MCP server definitions are startup configuration; protocol v3 deliberately does not accept an
arbitrary process command at runtime. In a disposable home, place this in `~/.dgc/config.json`:

```json
{
  "mcp_servers": {
    "fixture": {
      "command": "python3",
      "args": ["-u", "/absolute/path/to/matrix_mcp.py"]
    }
  }
}
```

A minimal legacy-compatible fixture is:

```python
import json
import sys

for line in sys.stdin:
    message = json.loads(line)
    request_id = message.get("id")
    method = message.get("method")
    if request_id is None:
        continue
    if method == "server/discover":
        body = {"error": {"code": -32601, "message": "legacy"}}
    elif method == "initialize":
        body = {"result": {
            "protocolVersion": "2025-11-25",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "fixture", "version": "1"},
        }}
    elif method == "tools/list":
        body = {"result": {"tools": [{
            "name": "echo",
            "description": "Echo text",
            "inputSchema": {
                "type": "object",
                "properties": {"text": {"type": "string"}},
                "required": ["text"],
            },
        }]}}
    elif method == "tools/call":
        text = (message.get("params") or {}).get("arguments", {}).get("text", "")
        body = {"result": {"content": [{"type": "text", "text": text}]}}
    else:
        body = {"error": {"code": -32601, "message": "unknown method"}}
    print(json.dumps({"jsonrpc": "2.0", "id": request_id, **body}), flush=True)
```

List and invoke the exact returned route:

```python
catalog = dgc.request(
    {"type": "list_mcp_tools", "request_id": "mcp-list", "offset": 0, "limit": 50},
    "mcp_tools",
    request_id="mcp-list",
)
assert any(tool["name"] == "mcp__fixture__echo" for tool in catalog["tools"])

dgc.send({
    "type": "call_mcp_tool",
    "request_id": "mcp-call",
    "call_id": "call-1",
    "name": "mcp__fixture__echo",
    "arguments": {"text": "ping"},
})
approval = dgc.wait_for("permission_request")
dgc.send({"type": "permission_response", "id": approval["id"], "decision": "once"})
complete = dgc.wait_for("mcp_call_complete", request_id="mcp-call")
assert complete["status"] == "completed" and complete["output"] == "ping"
```

## Hooks

Configure hooks in the disposable home's `~/.dgc/config.json`:

```json
{
  "hooks": {
    "SessionStart": [{"command": "printf 'SessionStart\\n' >> .dgc/hook.log"}],
    "Stop": [{"command": "printf 'Stop\\n' >> .dgc/hook.log"}],
    "PreCompact": [{"command": "printf 'PreCompact\\n' >> .dgc/hook.log"}]
  }
}
```

```python
catalog = dgc.request(
    {"type": "list_hooks", "request_id": "hooks-1"},
    "hook_catalog",
    request_id="hooks-1",
)
```

Natural triggers are authoritative; there is no direct `run_hook` command:

- `SessionStart`: first prompt in a new or resumed session, once per session.
- `Stop`: terminal lifecycle of each root prompt, including cancellation/failure.
- `PreCompact`: after at least two completed turns, send `{"type":"compact"}` so there is an
  older group to summarize.

Observe `hook_activity` with the exact event name and `started` followed by one terminal status.
Catalog and activity events never expose configured shell text or environment values.

## Permissions

Permission requests remain live while a foreground turn or direct MCP call waits:

```python
request = dgc.wait_for("permission_request")
dgc.send({"type": "permission_response", "id": request["id"], "decision": "once"})
```

Valid decisions are `once`, `always`, `deny`, and `no`. `always` may include the exact displayed
`rule`; credential-bearing approvals are downgraded to one-time execution. `cancel` expires every
outstanding request and late decisions are ignored. Permission-rule browsing/editing itself remains
terminal-only; headless exposes decisions, workspace-root grants, and trust acknowledgement.

## Output and interaction probes

These inputs exercise the current rendering seams without assuming model quality:

| Seam | Probe |
|---|---|
| Markdown | `Reply in Markdown with one heading, one list, bold text, and inline code.` |
| Table | `Return a two-column Markdown table with one data row.` In TUI/editor, expect a rendered table rather than visible delimiter pipes. |
| Fenced code | Stream `` ```html\n<img src=x onerror=bad()>\n**literal** `` before its closing fence; expect an inert code block immediately, then exact raw-source copy after closure. |
| Unicode cell layout | Enter `界界界界界 é 👩🏽‍💻 → ° —` in a 12–14-column TUI. |
| Prompt ownership | During a tool call, enter `Also check tests`; expect exactly one follow-up/steering band. |
| Tool lifecycle | `Run printf 'one\ntwo\n' and report its result.` |
| Cadence | `Read pyproject.toml, run the smallest relevant verification, then report the result.` |
| Bare-call fallback | Mock a provider response with empty assistant text plus a tool call; expect a preamble before the tool card. |
| Reasoning | Start `dgc --think high`; request a short calculation and confirm live reasoning collapses to `Thought for Ns`. |
| Collapse | Produce at least 12 lines of tool output, then exercise `/expand` and `/expandall`. |

Mojibake decoding and terminal Markdown styling were not changed by the frontier hardening. The
editor now renders aligned Markdown tables, treats closed and still-streaming fenced code as opaque
inert source, and copies the model's exact code rather than escaped HTML entities. Unicode
terminal-cell layout, prompt ownership, correlated tool settlement, semantic response cadence,
bare-tool narration, and editor accessibility also changed and require regression coverage.
Streaming has no artificial timer: provider chunks are forwarded as they arrive.

## VS Code and Cursor

No editor installation is needed for the jsdom/backend smoke:

```bash
cd editors/vscode
npm test
npm run compile
```

The real extension-host smoke needs an already-installed compatible executable; it never downloads
or publishes an editor:

```bash
npm run test:host
DGC_VSCODE_EXECUTABLE=/absolute/path/to/code-or-cursor npm run test:host
```

It verifies activation, registered commands, webview/backend handshake, live multi-root state,
SecretStorage migration/invalidation, and permission/plan decision lifecycles in disposable editor
state.
