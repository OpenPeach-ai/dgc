"""Test suite for dgc: unit tests + end-to-end tests against a mock
OpenAI-compatible server (no real LLM needed).

Run:  .venv/bin/python tests/run_tests.py
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT))

from dgc.llm import _ThinkFilter, parse_text_tool_calls  # noqa: E402
from dgc.permissions import PermissionEngine, Rule, _is_readonly_bash  # noqa: E402
from dgc.skills import _parse_skill, discover_skills  # noqa: E402
from dgc.memory import add_memory, load_memories  # noqa: E402
from dgc.tools import execute  # noqa: E402

PASS = []


def check(name: str, cond: bool, detail: str = ""):
    PASS.append(cond)
    print(f"  {'ok ' if cond else 'FAIL'} {name}" + (f"  -- {detail}" if not cond and detail else ""))


# ------------------------------------------------------------------ units ---

class Ctx:
    def __init__(self, root):
        self.project_root = root
        self.todos = []
        self.skills = {}
        self.on_todo = None

        class Cfg:
            def get(self, k, d=None):
                return d
        self.config = Cfg()


def unit_tests(tmp: Path):
    print("unit tests:")

    # --- ThinkFilter with tags split across chunks
    f = _ThinkFilter()
    events = []
    for chunk in ["hel", "lo <thi", "nk>sec", "ret</th", "ink> wo", "rld"]:
        events += f.feed(chunk)
    events += f.flush()
    text = "".join(c for k, c in events if k == "text")
    think = "".join(c for k, c in events if k == "think")
    check("thinkfilter text", text == "hello  world", text)
    check("thinkfilter think", think == "secret", think)

    # --- text protocol parsing
    content = 'Let me act.\n```tool_call\n{"name": "bash", "arguments": {"command": "ls"}}\n```\ndone'
    clean, calls = parse_text_tool_calls(content)
    check("text protocol parses", len(calls) == 1 and calls[0].name == "bash"
          and calls[0].arguments["command"] == "ls")
    check("text protocol strips block", "```" not in clean and "Let me act." in clean)

    # --- permission rules
    r = Rule.parse("Bash(npm run *)", "allow")
    check("rule match glob", r.matches("bash", {"command": "npm run build"}))
    check("rule no match", not r.matches("bash", {"command": "npm test"}))
    r2 = Rule.parse("Bash(git status:*)", "allow")
    check("rule prefix syntax", r2.matches("bash", {"command": "git status --short"}))
    r3 = Rule.parse("Edit(src/**)", "deny")
    check("rule path glob", r3.matches("edit_file", {"path": "src/a/b.py"}))
    # compound commands: allow needs ALL subcommands to match
    check("compound allow blocked", not r.matches("bash", {"command": "npm run build && rm -rf x"}))
    rd = Rule.parse("Bash(rm *)", "deny")
    check("compound deny fires", rd.matches("bash", {"command": "ls && rm -rf x"}))

    # --- readonly bash detection
    check("readonly ls", _is_readonly_bash("ls -la"))
    check("readonly git log", _is_readonly_bash("git log --oneline | head"))
    check("not readonly git push", not _is_readonly_bash("git push"))
    check("not readonly rm", not _is_readonly_bash("rm x"))
    check("wrapper stripped", _is_readonly_bash("timeout 10 cat f.txt"))

    # --- modes
    eng = PermissionEngine("default", {"allow": [], "ask": [], "deny": []})
    check("default: read allowed", eng.decide("read_file", {"path": "x"})[0] == "allow")
    check("default: write asks", eng.decide("write_file", {"path": "x"})[0] == "ask")
    check("default: readonly bash allowed", eng.decide("bash", {"command": "ls"})[0] == "allow")
    check("default: mutating bash asks", eng.decide("bash", {"command": "make"})[0] == "ask")

    eng = PermissionEngine("acceptEdits", {"allow": [], "ask": [], "deny": []})
    check("acceptEdits: edit allowed", eng.decide("edit_file", {"path": "x"})[0] == "allow")
    check("acceptEdits: bash asks", eng.decide("bash", {"command": "make"})[0] == "ask")

    eng = PermissionEngine("plan", {"allow": [], "ask": [], "deny": []})
    check("plan: read allowed", eng.decide("read_file", {"path": "x"})[0] == "allow")
    check("plan: write denied", eng.decide("write_file", {"path": "x"})[0] == "deny")
    check("plan: mutating bash denied", eng.decide("bash", {"command": "make"})[0] == "deny")
    check("plan: readonly bash allowed", eng.decide("bash", {"command": "ls"})[0] == "allow")
    check("plan: present_plan allowed", eng.decide("present_plan", {"plan": "p"})[0] == "allow")

    eng = PermissionEngine("auto", {"allow": [], "ask": [], "deny": ["Bash(rm -rf *)"]})
    check("auto: bash allowed", eng.decide("bash", {"command": "make install"})[0] == "allow")
    check("auto: deny rule wins", eng.decide("bash", {"command": "rm -rf /tmp/x"})[0] == "deny")

    # --- tools: write / read / edit / grep / glob / todo
    ctx = Ctx(tmp)
    out = execute("write_file", {"path": "a/b.txt", "content": "one\ntwo\nthree\n"}, ctx)
    check("write_file", (tmp / "a" / "b.txt").exists(), out[:100])
    out = execute("read_file", {"path": "a/b.txt"}, ctx)
    check("read_file numbered", "1\tone" in out and "3\tthree" in out, out[:80])
    out = execute("edit_file", {"path": "a/b.txt", "old_string": "two", "new_string": "TWO"}, ctx)
    check("edit_file", "TWO" in (tmp / "a" / "b.txt").read_text())
    out = execute("edit_file", {"path": "a/b.txt", "old_string": "e", "new_string": "E"}, ctx)
    check("edit_file ambiguous rejected", "matches" in out and "error" in out)
    out = execute("edit_file", {"path": "a/b.txt", "old_string": "o", "new_string": "0",
                                "replace_all": True}, ctx)
    check("edit_file replace_all", "0" in (tmp / "a" / "b.txt").read_text())
    out = execute("grep", {"pattern": "TWO", "path": "a"}, ctx)
    check("grep finds", "b.txt:2" in out, out[:80])
    out = execute("glob", {"pattern": "**/*.txt"}, ctx)
    check("glob finds", "b.txt" in out)
    out = execute("bash", {"command": "echo hi && pwd"}, ctx)
    check("bash runs", "hi" in out and "exit code: 0" in out)
    out = execute("todo", {"todos": [{"content": "x", "status": "done"}]}, ctx)
    check("todo", ctx.todos and ctx.todos[0]["status"] == "done")

    # --- skills
    skdir = tmp / ".dgc" / "skills" / "demo"
    skdir.mkdir(parents=True)
    (skdir / "SKILL.md").write_text("---\nname: demo\ndescription: demo skill\n---\nDo $ARGUMENTS now.\n")
    sk = _parse_skill(skdir / "SKILL.md")
    check("skill frontmatter", sk.name == "demo" and sk.description == "demo skill")
    check("skill args substitution", sk.render("things") == "Do things now.")
    check("skill discovery", "demo" in discover_skills(tmp))

    # --- memory
    p = add_memory("always run pytest", tmp)
    proj, _ = load_memories(tmp)
    check("memory add+load", "- always run pytest" in proj)
    add_memory("second fact", tmp)
    proj, _ = load_memories(tmp)
    check("memory appends", "second fact" in proj and "always run pytest" in proj)


# ------------------------------------------------------------- mock server ---

def sse_chunk(delta: dict, finish: str | None = None) -> str:
    obj = {"id": "mock", "object": "chat.completion.chunk",
           "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
    return f"data: {json.dumps(obj)}\n\n"


def tool_delta(name: str, arg_chunks: list[str]) -> str:
    """One native tool call, arguments streamed in fragments."""
    out = sse_chunk({"tool_calls": [{"index": 0, "id": "call_1", "type": "function",
                                     "function": {"name": name, "arguments": ""}}]})
    for frag in arg_chunks:
        out += sse_chunk({"tool_calls": [{"index": 0, "function": {"arguments": frag}}]})
    return out + sse_chunk({}, finish="tool_calls") + "data: [DONE]\n\n"


class MockHandler(BaseHTTPRequestHandler):
    # scenario state set by the test before each run
    native_tools = True
    scenario = "write"   # "write" | "plan"

    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path == "/v1/models":
            body = json.dumps({"data": [{"id": "mock-model"}]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404); self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        req = json.loads(self.rfile.read(length) or b"{}")

        if "tools" in req and not self.native_tools:
            body = b'{"error": {"message": "tools are not supported by this model"}}'
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        messages = req.get("messages", [])
        has_tool_result = any(m.get("role") == "tool" for m in messages) or \
            any("<tool_results>" in str(m.get("content", "")) for m in messages)
        approved = any("Plan APPROVED" in str(m.get("content", "")) for m in messages)

        if self.scenario == "plan":
            if not has_tool_result:
                payload = tool_delta("present_plan", [json.dumps({"plan": "1. write planned.txt"})])
            elif approved and not any("wrote" in str(m.get("content", "")) for m in messages):
                args = json.dumps({"path": "planned.txt", "content": "planned\n"})
                payload = tool_delta("write_file", [args])
            else:
                payload = sse_chunk({"content": "Plan executed."})
                payload += sse_chunk({}, finish="stop") + "data: [DONE]\n\n"
        elif not has_tool_result:
            if self.native_tools and "tools" in req:
                args = json.dumps({"path": "hello.txt", "content": "hello from dgc\n"})
                mid = len(args) // 2
                payload = tool_delta("write_file", [args[:mid], args[mid:]])
            else:
                payload = sse_chunk({"content": 'I will create the file now.\n```tool_call\n'
                                                '{"name": "write_file", "arguments": '
                                                '{"path": "fallback.txt", "content": "via text protocol\\n"}}\n```'})
                payload += sse_chunk({}, finish="stop") + "data: [DONE]\n\n"
        else:
            payload = sse_chunk({"content": "<think>checking</think>File created successfully."})
            payload += sse_chunk({}, finish="stop") + "data: [DONE]\n\n"

        body = payload.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def e2e(port: int, native: bool, expect_file: str, tmp: Path,
        mode: str = "auto", scenario: str = "write", stdin: str = "") -> bool:
    MockHandler.native_tools = native
    MockHandler.scenario = scenario
    home = tmp / f"home_{scenario}_{'native' if native else 'text'}"
    work = tmp / f"work_{scenario}_{'native' if native else 'text'}"
    home.mkdir(exist_ok=True); work.mkdir(exist_ok=True)
    env = dict(os.environ, HOME=str(home), PYTHONPATH=str(PROJECT))
    proc = subprocess.run(
        [sys.executable, "-m", "dgc", "-p", "create the file please",
         "--mode", mode, "--base-url", f"http://127.0.0.1:{port}/v1", "--model", "mock-model"],
        cwd=str(work), env=env, capture_output=True, text=True, timeout=120, input=stdin)
    ok = (work / expect_file).exists() and proc.returncode == 0
    if not ok:
        print("  --- stdout ---\n", proc.stdout[-2000:])
        print("  --- stderr ---\n", proc.stderr[-2000:])
    return ok


def main():
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        unit_dir = tmp / "unit"   # keep .dgc markers out of the e2e project roots
        unit_dir.mkdir()
        unit_tests(unit_dir)

        print("end-to-end tests (mock LLM server):")
        server = HTTPServer(("127.0.0.1", 0), MockHandler)
        port = server.server_address[1]
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            check("e2e native tool calling (auto mode)", e2e(port, True, "hello.txt", tmp))
            check("e2e text-protocol fallback", e2e(port, False, "fallback.txt", tmp))
            check("e2e plan mode → approve → build",
                  e2e(port, True, "planned.txt", tmp, mode="plan", scenario="plan", stdin="1\n"))
        finally:
            server.shutdown()

    print(f"\n{sum(PASS)}/{len(PASS)} checks passed")
    sys.exit(0 if all(PASS) else 1)


if __name__ == "__main__":
    main()
