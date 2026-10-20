"""A stand-in for the user's Claude Code or Codex in tests of Pip subscription runs (pip_brain).

Installed as ``claude`` or ``codex`` in a temporary PATH. It speaks that CLI's real output format and reaches DGC's
tools the way the real one does: it starts the MCP server it was given (DGC's relay) and talks MCP to it. What it
does comes from ``script.json`` beside it, and it writes what it saw to ``seen.json`` there (its argv, cwd, the
names in its environment, the tools DGC offered, the answers it got), because the CLI's environment carries
nothing from the test.

Script steps: {"say": text} | {"call": tool, "args": {...}} | {"own": tool} (one of its own tools, which a locked-
down CLI must never reach) | {"fail": message}.
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(sys.argv[0]).resolve().parent
ENGINE = Path(sys.argv[0]).name
argv = sys.argv[1:]


def out(value):
    sys.stdout.write(json.dumps(value) + "\n")
    sys.stdout.flush()


if ENGINE == "codex" and argv[:2] == ["debug", "models"]:
    out({"models": [{"slug": "gpt-test", "priority": 1, "visibility": "list", "apply_patch_tool_type": "freeform",
                     "shell_type": "unified_exec", "supports_search_tool": True, "tool_mode": "code_mode_only"}]})
    sys.exit(0)

script = json.loads((HERE / "script.json").read_text())
seen = {"engine": ENGINE, "argv": argv, "cwd": os.getcwd(), "env": sorted(os.environ), "home": os.environ.get("HOME"),
        "answers": []}
stdin = sys.stdin.read()

if ENGINE == "claude":
    config = json.loads(Path(argv[argv.index("--mcp-config") + 1]).read_text())["mcpServers"]
    seen["servers"] = sorted(config)
    server = config["dgc"]
    command, env = [server["command"], *server["args"]], {**server["env"], "PATH": os.environ.get("PATH", "")}
    message = json.loads(stdin)
    seen["prompt"] = message["message"]["content"][0]["text"]
    seen["photos"] = [part["source"]["media_type"] for part in message["message"]["content"] if part["type"] == "image"]
    seen["system"] = Path(argv[argv.index("--system-prompt-file") + 1]).read_text()
else:
    pairs = dict(argv[i + 1].split("=", 1) for i, arg in enumerate(argv) if arg == "-c")
    seen["config"] = pairs
    command = [json.loads(pairs["mcp_servers.dgc.command"]), *json.loads(pairs["mcp_servers.dgc.args"])]
    env = {name: os.environ[name] for name in json.loads(pairs["mcp_servers.dgc.env_vars"]) if name in os.environ}
    env["PATH"] = os.environ.get("PATH", "")
    seen["prompt"] = stdin
    seen["system"] = Path(json.loads(pairs["model_instructions_file"])).read_text()
    seen["catalog"] = json.loads(Path(json.loads(pairs["model_catalog_json"])).read_text())
    seen["photos"] = [arg.split("=", 1)[1] for arg in argv if arg.startswith("--image=")]

relay = subprocess.Popen(command, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE)
ident = [0]


def rpc(method, params=None, notify=False):
    message = {"jsonrpc": "2.0", "method": method, **({"params": params} if params is not None else {})}
    if not notify:
        ident[0] += 1
        message["id"] = ident[0]
    relay.stdin.write((json.dumps(message) + "\n").encode())
    relay.stdin.flush()
    if notify:
        return None
    reply = json.loads(relay.stdout.readline())
    return reply.get("result", reply.get("error"))


rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": ENGINE, "version": "0"}})
rpc("notifications/initialized", notify=True)
seen["tools"] = [tool["name"] for tool in rpc("tools/list", {})["tools"]]
if ENGINE == "claude":
    out({"type": "system", "subtype": "init", "session_id": "s1", "tools": ["mcp__dgc__" + t for t in seen["tools"]]})
else:
    out({"type": "thread.started", "thread_id": "t1"})
last = ""
for number, step in enumerate(script, 1):
    if "say" in step:
        last = step["say"]
        out({"type": "assistant", "message": {"content": [{"type": "text", "text": last}]}} if ENGINE == "claude" else
            {"type": "item.completed", "item": {"id": f"i{number}", "type": "agent_message", "text": last}})
    elif "own" in step:
        out({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": f"u{number}", "name": step["own"],
                                                             "input": {"command": "ls ~"}}]}} if ENGINE == "claude" else
            {"type": "item.started", "item": {"id": f"i{number}", "type": "command_execution", "command": "ls ~"}})
        time.sleep(10)                              # a locked-down run is stopped before this ends
    elif "fail" in step:
        out({"type": "result", "subtype": "error_during_execution", "is_error": True, "error": step["fail"]}
            if ENGINE == "claude" else {"type": "turn.failed", "error": {"message": step["fail"]}})
        sys.exit(1)
    else:
        name, args = step["call"], step.get("args", {})
        if ENGINE == "claude":
            out({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": f"u{number}",
                                                                 "name": "mcp__dgc__" + name, "input": args}]}})
        else:
            out({"type": "item.started", "item": {"id": f"i{number}", "type": "mcp_tool_call", "server": "dgc", "tool": name,
                                                  "arguments": args}})
        answer = rpc("tools/call", {"name": name, "arguments": args})
        seen["answers"].append({"tool": name, "types": [part["type"] for part in answer.get("content", [])],
                                "text": " ".join(p.get("text", "") for p in answer.get("content", []) if p["type"] == "text"),
                                "error": answer.get("isError")})
        (HERE / "seen.json").write_text(json.dumps(seen))
        if ENGINE == "claude":
            out({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": f"u{number}",
                                                            "content": answer.get("content", [])}]}})
        else:
            out({"type": "item.completed", "item": {"id": f"i{number}", "type": "mcp_tool_call", "server": "dgc",
                                                    "tool": name, "result": answer}})
(HERE / "seen.json").write_text(json.dumps(seen))
usage = {"input_tokens": 120, "output_tokens": 30}
out({"type": "result", "subtype": "success", "result": last, "usage": usage, "session_id": "s1"} if ENGINE == "claude"
    else {"type": "turn.completed", "usage": usage})
relay.stdin.close()
relay.wait(timeout=5)
