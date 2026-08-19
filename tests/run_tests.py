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
from dgc.headless import Backend  # noqa: E402

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

    # --- overlay hit-map: tabs are mouse-clickable and rows hover-map exactly (Grok parity)
    from dgc.tui import TUI
    import dgc.style as _sty
    _sty.set_theme("dark")
    ui = object.__new__(TUI)                       # bare — skip the heavy __init__
    ui._width, ui._OVERLAY_CAP = 100, 14
    ui.input_buf = type("B", (), {"text": ""})()
    ui._invalidate = lambda: None
    from rich.console import Console as _Con
    import io as _io
    ui._rich = lambda r: (lambda b: (_Con(file=b, force_terminal=True, width=ui._width).print(r, end=""), b.getvalue())[1])(_io.StringIO())
    ui._overlay = {"rows": [], "on_pick": lambda r: None, "title": None,
                   "tabs": ["Skills", "MCP Servers"], "tab": 0, "sel": 0, "scroll": 0,
                   "footer": "f", "rebuild": lambda ov: (
                       [{"label": f"s{i}", "desc": "d", "value": ("skill", i)} for i in range(3)]
                       if ov["tab"] == 0 else [{"label": "m0", "desc": "d", "value": ("mcp", 0)}])}
    ui._render_overlay()
    ov = ui._overlay
    x0, x1, _ = ov["_tabmap"][1]                    # the "MCP Servers" tab's x-range
    check("overlay tab hit-test", ui._overlay_tab_at((x0 + x1) // 2, ov["_tab_y"]) == 1)
    check("overlay off-strip = no tab", ui._overlay_tab_at(2, 999) is None)
    first_row_y = min(ov["_rowmap"])
    check("overlay row hit-test", ui._overlay_row_at(first_row_y) == 0)
    ui._overlay_switch_tab(1); ui._render_overlay()  # click the MCP tab → list rebuilds
    check("overlay tab switch rebuilds", ov["tab"] == 1 and [r["label"] for r in ui._overlay_rows()] == ["m0"])

    # --- memory
    p = add_memory("always run pytest", tmp)
    proj, _ = load_memories(tmp)
    check("memory add+load", "- always run pytest" in proj)
    add_memory("second fact", tmp)
    proj, _ = load_memories(tmp)
    check("memory appends", "second fact" in proj and "always run pytest" in proj)

    # --- resume transcript flattening (drives the extension's `history` event
    #     so a resumed session re-renders instead of showing blank)
    class _FakeAgent:
        def __init__(self, msgs): self.messages = msgs
    class _FakeBackend:
        def __init__(self, msgs): self.agent = _FakeAgent(msgs)
    msgs = [
        {"role": "system", "content": "you are dgc"},
        {"role": "user", "content": "add a weather widget"},
        {"role": "assistant", "content": "on it", "tool_calls": [
            {"function": {"name": "write_file"}}, {"function": {"name": "bash"}}]},
        {"role": "user", "content": "<tool_results>\n<result tool=\"bash\">ok</result>\n</tool_results>"},
        {"role": "assistant", "content": "done"},
        {"role": "user", "content": [{"type": "text", "text": "make it bold"},
                                     {"type": "image_url", "image_url": {"url": "data:x"}}]},
    ]
    items = Backend._history(_FakeBackend(msgs))
    check("resume history skips system", all(i["role"] != "system" for i in items))
    check("resume history keeps user turns",
          items[0] == {"role": "user", "text": "add a weather widget"})
    check("resume history captures assistant tools",
          items[1]["role"] == "assistant" and items[1]["tools"] == ["write_file", "bash"])
    check("resume history drops tool_results envelope",
          not any("<tool_results>" in i.get("text", "") for i in items))
    check("resume history keeps multimodal user text",
          items[-1]["role"] == "user" and "make it bold" in items[-1]["text"])

    # --- named sub-agent defs + model/host resolution
    from dgc.agents import _parse_agent, AgentDef
    from dgc.agent import Agent
    adir = tmp / "adefs"; adir.mkdir()
    (adir / "reviewer.md").write_text(
        "---\nname: reviewer\ndescription: careful reviewer\n"
        "model: qwen3:14b\nbase_url: http://gpu:11434/v1\napi_key: k\neffort: high\n---\n"
        "Be a meticulous reviewer.")
    ad = _parse_agent(adir / "reviewer.md")
    check("agentdef parses model+host+effort",
          ad.model == "qwen3:14b" and ad.base_url == "http://gpu:11434/v1"
          and ad.api_key == "k" and ad.effort == "high")
    check("agentdef keeps body", "meticulous reviewer" in ad.body)

    class _Cfg2:
        base_url, api_key, model = "http://localhost:11434/v1", "ollama", "main-model"
        def __init__(self, o): self._o = o
        def get(self, k, d=None): return self._o.get(k, d)
    class _FakeA:
        def __init__(self, cfg): self.config = cfg
    # no def, no global → reuse the parent client (None)
    check("subagent inherits main when unset",
          Agent._subagent_client(_FakeA(_Cfg2({})), None) is None)
    # global subagent_* selects a different host+model
    c = Agent._subagent_client(_FakeA(_Cfg2(
        {"subagent_model": "sub-model", "subagent_base_url": "http://gpu:11434/v1"})), None)
    check("subagent global host+model",
          c is not None and c.model == "sub-model" and c.base_url == "http://gpu:11434/v1")
    # a named agent def overrides the global default
    c2 = Agent._subagent_client(_FakeA(_Cfg2({"subagent_model": "sub-model"})),
                                AgentDef(name="r", description="", body="",
                                         model="def-model", base_url="http://def:1/v1"))
    check("agentdef overrides global",
          c2.model == "def-model" and c2.base_url == "http://def:1/v1")


def test_mono_markdown():
    """Assistant markdown renders mono+purple — never rich's default rainbow
    (green inline-code / cyan list-numbers / multicolor syntax highlighting)."""
    import io as _io
    from rich.console import Console
    from dgc import render, style as _style
    _style.set_theme("dark")
    th = _style.theme()
    accent_hex = th.accent_bright.lstrip("#")
    r, g, b = int(accent_hex[0:2], 16), int(accent_hex[2:4], 16), int(accent_hex[4:6], 16)

    def colors_of(text):
        c = Console(file=_io.StringIO(), force_terminal=True, color_system="truecolor",
                    width=60, highlight=False, theme=render.markdown_theme())
        c.print(render.render_markdown(text))
        import re as _re
        return set(_re.findall(r"38;2;(\d+);(\d+);(\d+)", c.file.getvalue()))

    # monokai (rich's default code theme) markers we must NEVER emit
    MONOKAI = {("102", "217", "239"), ("166", "226", "46"), ("249", "38", "114"),
               ("255", "70", "137"), ("174", "129", "255"), ("248", "248", "242")}

    def no_rainbow(cs):
        green_cyan = any(cc[0] == "0" and int(cc[1]) > 100 and int(cc[2]) < 120 for cc in cs)
        return not green_cyan and not (cs & MONOKAI)

    complete = colors_of("call `sign()` then:\n\n```python\ndef sign():\n    pass\n```")
    check("markdown emits our purple accent", (str(r), str(g), str(b)) in complete)
    check("markdown (complete fence) has no rainbow", no_rainbow(complete), detail=str(sorted(complete)))

    # THE bug that shipped: a still-open fence mid-stream fell back to rich's monokai rainbow
    streaming = colors_of("Here is the fix:\n\n```python\ndef sign(sub):\n    return enc(sub)")
    check("markdown (streaming/unclosed fence) has no rainbow", no_rainbow(streaming),
          detail=str(sorted(streaming)))
    # a fence with a language + attributes (regex-split missed these too)
    attrs = colors_of("```python title=x\nx = 1\n```")
    check("markdown (fence with lang attrs) has no rainbow", no_rainbow(attrs), detail=str(sorted(attrs)))


def test_logo_stays_in_family():
    """The wordmark shimmer must stay within a SINGLE colour family across the whole sweep, so it
    downsamples cleanly on 256-colour terminals instead of scattering into cyan/rainbow (Mac/SSH).
    The mark is brand PURPLE (blue-dominant): every colour in the sweep must keep blue on top and
    never let GREEN dominate (which is what reads as cyan when quantised)."""
    from dgc import logo, style  # noqa: F401

    def rgb(hexc):
        h = hexc.lstrip("#")
        return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)

    cols = set()
    for secs in (0.0, 0.4, 0.8, 1.2, 1.6, 2.0, 2.4, 2.8, 3.2):
        for c in range(logo._COLS):
            for r in range(logo._ROWS):
                cols.add(logo._char_style(r, c, secs, logo._GLINT).split()[-1])
    ok = True
    for hexc in cols:
        rr, gg, bb = rgb(hexc)
        if bb < rr or gg > rr or gg > bb:      # blue must lead; green must never dominate → no cyan
            ok = False
    check("logo shimmer stays in the purple family (no cyan/rainbow when downsampled)", ok,
          detail=f"{len(cols)} colours, e.g. {sorted(cols)[0]}..{sorted(cols)[-1]}")
    check("logo resting colour is the brand purple", logo._REST.upper() == "#7C5CFF", detail=logo._REST)


def test_trust():
    """The first-run directory-trust gate remembers trusted dirs (and their subtrees)."""
    import os as _os
    import tempfile as _tf
    from dgc import trust

    class _Cfg:
        def __init__(self): self.data = {}; self.saved = False
        def save(self): self.saved = True

    c = _Cfg()
    d = _tf.mkdtemp()
    check("fresh dir is untrusted", not trust.is_trusted(c, d))
    trust.mark_trusted(c, d)
    check("marked dir is trusted", trust.is_trusted(c, d))
    check("mark_trusted persisted (save called)", c.saved)
    sub = _os.path.join(d, "pkg", "src"); _os.makedirs(sub)
    check("subtree of a trusted dir is trusted", trust.is_trusted(c, sub))
    check("an unrelated dir stays untrusted", not trust.is_trusted(c, _tf.mkdtemp()))


def test_edit_tiers():
    """The edit tool tolerates a flaky local model's near-misses: smart quotes, nbsp,
    and wrong indentation — while staying strict about ambiguity and honest on a real miss."""
    import tempfile as _tf
    from pathlib import Path as _P
    from dgc.tools import edit_file

    class _C:
        def __init__(self, root): self.project_root = root

    def edit(content, old, new, **kw):
        d = _P(_tf.mkdtemp()); f = d / "t.py"; f.write_text(content)
        r = edit_file({"path": str(f), "old_string": old, "new_string": new, **kw}, _C(d))
        return r, (f.read_text() if "edited" in r else None)

    r, out = edit("def f():\n    return 1\n", "return 1", "return 2")
    check("edit exact match", out == "def f():\n    return 2\n")
    # curly quotes in old_string, straight quotes in the file
    r, out = edit('x = "hi"\n', 'x = “hi”', "x = 'yo'")
    check("edit tolerates smart quotes", out == "x = 'yo'\n", detail=repr(out))
    # non-breaking space in old_string
    r, out = edit("a = 1 + 2\n", "a = 1\u00a0+ 2", "a = 3")
    check("edit tolerates non-breaking space", out == "a = 3\n", detail=repr(out))
    # wrong indentation → matched, and the file's indentation is re-applied
    r, out = edit("class A:\n        def m(self):\n            return 7\n",
                  "def m(self):\n    return 7", "def m(self):\n    return 8")
    check("edit whitespace-flex re-indents the replacement",
          out == "class A:\n        def m(self):\n            return 8\n", detail=repr(out))
    # ambiguous without replace_all
    r, out = edit("x=1\nx=1\n", "x=1", "x=2")
    check("edit rejects ambiguous match", out is None and "matches 2 times" in r)
    r, out = edit("x=1\nx=1\n", "x=1", "x=2", replace_all=True)
    check("edit replace_all changes every occurrence", out == "x=2\nx=2\n")
    # a genuine miss returns the closest region so the model can self-correct
    r, out = edit("def alpha():\n    return 1\n", "def alpa():\n    return 9", "x")
    check("edit miss shows the closest region", out is None and "closest region" in r)
    # CRLF files keep their line endings (don't get flattened to LF)
    d = _P(_tf.mkdtemp()); f = d / "w.txt"; f.write_bytes(b"a\r\nb\r\nc\r\n")
    edit_file({"path": str(f), "old_string": "b", "new_string": "B"}, _C(d))
    check("edit preserves CRLF line endings", f.read_bytes() == b"a\r\nB\r\nc\r\n", detail=repr(f.read_bytes()))


def test_context_prune():
    """Tier-1 mechanical prune caps stale tool outputs, protecting system + the recent tail."""
    from dgc.agent import Agent

    class _F:
        pass

    f = _F()
    big = "Z" * 5000
    f.messages = [{"role": "system", "content": "sys"}]
    for i in range(12):
        f.messages.append({"role": "tool", "tool_call_id": str(i), "content": big})
    changed = Agent._mechanical_prune(f)
    check("mechanical prune reports a change", changed)
    check("system message is never pruned", f.messages[0]["content"] == "sys")
    check("an early tool output is pruned", len(f.messages[1]["content"]) < 5000 and "pruned" in f.messages[1]["content"])
    check("the most recent tool output is protected", f.messages[-1]["content"] == big)

    from dgc.config import context_for_model
    check("catalog sizes a qwen model", context_for_model("qwen3.5:122b") == 32768)
    check("catalog sizes a gpt-oss model", context_for_model("gpt-oss:120b") == 131072)
    check("catalog returns None for an unknown model", context_for_model("totally-unknown-xyz") is None)


def test_supply_chain_guard():
    """MCP server env is screened: process-hijacking vars are stripped, benign ones kept."""
    from dgc.guards import screen_mcp_env
    safe, dropped = screen_mcp_env({"API_KEY": "x", "LD_PRELOAD": "/evil.so",
                                    "NODE_OPTIONS": "--require /evil", "FOO": "bar"})
    check("guard keeps benign env vars", safe == {"API_KEY": "x", "FOO": "bar"})
    check("guard drops LD_PRELOAD", "LD_PRELOAD" in dropped)
    check("guard drops NODE_OPTIONS", "NODE_OPTIONS" in dropped)
    check("guard drops a PATH override", "PATH" in screen_mcp_env({"PATH": "/evil:$PATH"})[1])

    from dgc import sandbox
    if sandbox.available():                    # skip where no bwrap/sandbox-exec
        import tempfile as _tf
        from pathlib import Path as _P
        from dgc.tools import bash

        class _SCfg:
            def get(self, k, d=None): return {"sandbox": True, "bash_timeout": 30}.get(k, d)

        class _SCtx:
            def __init__(self, root): self.project_root = root; self.config = _SCfg()

        proj = _P(_tf.mkdtemp())
        check("sandbox allows a project write", "hi" in bash({"command": "echo hi > x && cat x"}, _SCtx(proj)))
        bash({"command": "echo evil > $HOME/.dgc_escape_test 2>&1; true"}, _SCtx(proj))
        escaped = (_P.home() / ".dgc_escape_test").exists()
        (_P.home() / ".dgc_escape_test").unlink(missing_ok=True)
        check("sandbox blocks a write outside the project", not escaped)


def test_sessions_and_worktree():
    """Named sessions persist a name; git worktrees are created/listed/removed."""
    import subprocess as _sp
    import tempfile as _tf
    from pathlib import Path as _P
    from dgc import sessions, worktree

    d = _P(_tf.mkdtemp()); sp = d / "s.json"
    sessions.save(sp, [{"role": "user", "content": "hi"}], d, name="my session")
    check("session name is saved", sessions.name_of(sp) == "my session")
    sessions.set_name(sp, "renamed")
    check("session name is updatable", sessions.name_of(sp) == "renamed")
    check("rename keeps the messages", sessions.load(sp) == [{"role": "user", "content": "hi"}])
    check("session delete removes the file", sessions.delete(sp) is True and not sp.exists())
    check("session delete on a missing file is False", sessions.delete(sp) is False)

    if _sp.run(["git", "--version"], capture_output=True).returncode != 0:
        return
    repo = _P(_tf.mkdtemp())
    _sp.run(["git", "init", "-q"], cwd=repo)
    _sp.run(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "i"], cwd=repo)
    check("worktree.in_repo detects a git repo", worktree.in_repo(repo))
    check("worktree.in_repo rejects a non-repo", not worktree.in_repo(_P(_tf.mkdtemp())))
    wt_path, branch, err = worktree.create(repo, "feature x")
    check("worktree is created", err is None and wt_path is not None and wt_path.exists(), detail=str(err))
    check("worktree branch is dgc/<slug>", branch == "dgc/feature-x")
    check("worktree appears in the list",
          any(w.get("branch") == "dgc/feature-x" for w in worktree.list_worktrees(repo)))
    check("worktree is removable", worktree.remove(repo, "feature x") is None)


def test_slash_palette():
    """The `/` command palette filters commands by prefix and never fires without a leading slash."""
    from prompt_toolkit.document import Document

    from dgc.tui import SLASH_COMMANDS, SlashCompleter
    c = SlashCompleter()

    def comps(s):
        return [x.text for x in c.get_completions(Document(s, len(s)), None)]

    check("`/` offers every command", len(comps("/")) == len(SLASH_COMMANDS))
    check("prefix filters (/th → think+thoughts+theme)", comps("/th") == ["/think", "/thoughts", "/theme"])
    check("no completions without a slash", comps("hello") == [])
    check("no completions after the command word", comps("/model q") == [])
    check("all descriptions are non-empty", all(d for _, d in SLASH_COMMANDS))


def test_steering():
    """A mid-turn message is folded into the running turn as a <user-interjection>, not a new turn."""
    import tempfile as _tf
    from pathlib import Path as _P
    from dgc.agent import Agent
    from dgc.config import Config

    class _UI:
        def __getattr__(self, k):
            return lambda *a, **kw: None
    a = Agent(Config(project_root=_P(_tf.mkdtemp())), _UI())
    a.steer("also write a test for it")
    check("steer + drain injects a user-interjection", a._drain_steer() is True
          and a.messages[-1]["role"] == "user"
          and "user-interjection" in a.messages[-1]["content"]
          and "write a test" in a.messages[-1]["content"])
    check("drain with an empty queue is a no-op", a._drain_steer() is False)


def test_add_skill_url():
    """add_skill installs a SKILL.md fetched over HTTP and makes it usable immediately."""
    import tempfile as _tf, threading as _th
    from http.server import HTTPServer, BaseHTTPRequestHandler
    from types import SimpleNamespace
    from pathlib import Path as _P
    import dgc.config as _C, dgc.tools as _T, dgc.skills as _S

    body = b"---\nname: pirate\ndescription: talk like a pirate\n---\nArrr. $ARGUMENTS"

    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200); self.end_headers(); self.wfile.write(body)
        def log_message(self, *a):
            pass
    srv = HTTPServer(("127.0.0.1", 0), H)
    _th.Thread(target=srv.serve_forever, daemon=True).start()
    port = srv.server_address[1]
    old = _C.USER_SKILLS
    _C.USER_SKILLS = _S.USER_SKILLS = _P(_tf.mkdtemp()) / "skills"   # patch both bindings
    _prox = {k: os.environ.get(k) for k in ("NO_PROXY", "no_proxy")}
    os.environ["NO_PROXY"] = os.environ["no_proxy"] = "127.0.0.1,localhost"
    try:
        ctx = SimpleNamespace(skills={}, project_root=_P(_tf.mkdtemp()))
        res = _T.add_skill({"url": f"http://127.0.0.1:{port}/SKILL.md"}, ctx)
        check("add_skill installs from a URL",
              "installed skill 'pirate'" in res and (_C.USER_SKILLS / "pirate" / "SKILL.md").exists())
        check("add_skill refreshes the live skill set", "pirate" in ctx.skills)
    finally:
        _C.USER_SKILLS = _S.USER_SKILLS = old
        for k, v in _prox.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        srv.shutdown()


def test_toolcall_recovery():
    """Recover tool calls local models emit as text: XML shapes, fence variants, near-JSON;
    and split reasoning from several think-marker styles."""
    from dgc.llm import _loads_lenient, _ThinkFilter, parse_text_tool_calls as P

    def calls(content):
        return P(content)[1]

    c = calls('```tool_call\n{"name":"read_file","arguments":{"path":"a"}}\n```')
    check("parse fenced tool_call", len(c) == 1 and c[0].name == "read_file" and c[0].arguments == {"path": "a"})
    c = calls('<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>')
    check("parse XML <tool_call>", len(c) == 1 and c[0].name == "bash" and c[0].arguments == {"command": "ls"})
    c = calls('<function=grep>{"pattern":"x"}</function>')
    check("parse XML <function=name>", len(c) == 1 and c[0].name == "grep" and c[0].arguments == {"pattern": "x"})
    c = calls('```tool_call\n{"name":"bash","arguments":{"command":"ls",}}\n```')
    check("parse tolerates trailing comma", len(c) == 1 and c[0].arguments == {"command": "ls"})
    c = calls("<tool_call>{'name':'bash','arguments':{'command':'pwd'}}</tool_call>")
    check("parse tolerates single quotes", len(c) == 1 and c[0].arguments == {"command": "pwd"})
    c = calls('{"name":"read_file","arguments":{"path":"z"}}')
    check("parse bare tool-call object", len(c) == 1 and c[0].name == "read_file")
    c = calls('<tool_call>{"name":"write_file","arguments":{"path":"a","content":"{x:1}"}}</tool_call>')
    check("parse preserves nested-brace args", len(c) == 1 and c[0].arguments.get("content") == "{x:1}")
    clean, cc = P("Here's how you'd read_file in Python — just prose.")
    check("no false-positive tool call in prose", len(cc) == 0 and "prose" in clean)

    def split(chunks):
        f = _ThinkFilter(); ev = []
        for ch in chunks:
            ev += f.feed(ch)
        ev += f.flush()
        return ("".join(t for k, t in ev if k == "text"), "".join(t for k, t in ev if k == "think"))

    check("think marker <think>", split(["<think>r</think>A"]) == ("A", "r"))
    check("think marker <thinking>", split(["<thinking>r</thinking>A"]) == ("A", "r"))
    check("think marker Kimi ◁think▷", split(["◁think▷z◁/think▷B"]) == ("B", "z"))
    check("think tag split across chunks", split(["<thi", "nk>a</th", "ink>C"]) == ("C", "a"))
    check("lenient loads python literals", _loads_lenient("{'a': True, 'b': None}") == {"a": True, "b": None})


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

        if self.scenario == "loop":
            # a stuck model: ALWAYS the same tool call, no matter the results — the agent's
            # doom-loop guard must break out instead of spinning to max_turns.
            payload = tool_delta("read_file", [json.dumps({"path": "nope.txt"})])
        elif self.scenario == "plan":
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


def e2e_loop(port: int, tmp: Path) -> bool:
    """A model that repeats one tool call forever must be broken out of by the loop guard —
    the process should exit quickly (well before max_turns=40) and say it stopped repeating."""
    MockHandler.native_tools = True
    MockHandler.scenario = "loop"
    home = tmp / "home_loop"; work = tmp / "work_loop"
    home.mkdir(exist_ok=True); work.mkdir(exist_ok=True)
    env = dict(os.environ, HOME=str(home), PYTHONPATH=str(PROJECT))
    try:
        proc = subprocess.run(
            [sys.executable, "-m", "dgc", "-p", "read the file",
             "--mode", "auto", "--base-url", f"http://127.0.0.1:{port}/v1", "--model", "mock-model"],
            cwd=str(work), env=env, capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired:
        print("  --- doom-loop did NOT break out (timed out) ---")
        return False
    out = proc.stdout + proc.stderr
    ok = "repeating" in out or "stuck" in out or "loop guard" in out
    if not ok:
        print("  --- stdout ---\n", proc.stdout[-1500:])
    return ok


def main():
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        unit_dir = tmp / "unit"   # keep .dgc markers out of the e2e project roots
        unit_dir.mkdir()
        unit_tests(unit_dir)
        test_mono_markdown()
        test_logo_stays_in_family()
        test_trust()
        test_edit_tiers()
        test_context_prune()
        test_supply_chain_guard()
        test_sessions_and_worktree()
        test_slash_palette()
        test_steering()
        test_add_skill_url()
        test_toolcall_recovery()

        print("end-to-end tests (mock LLM server):")
        server = HTTPServer(("127.0.0.1", 0), MockHandler)
        port = server.server_address[1]
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            check("e2e native tool calling (auto mode)", e2e(port, True, "hello.txt", tmp))
            check("e2e text-protocol fallback", e2e(port, False, "fallback.txt", tmp))
            check("e2e plan mode → approve → build",
                  e2e(port, True, "planned.txt", tmp, mode="plan", scenario="plan", stdin="1\n"))
            check("e2e doom-loop guard stops a stuck model", e2e_loop(port, tmp))
        finally:
            server.shutdown()

    print(f"\n{sum(PASS)}/{len(PASS)} checks passed")
    sys.exit(0 if all(PASS) else 1)


if __name__ == "__main__":
    main()
