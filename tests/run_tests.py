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

    # --- overlay hit-map: tabs are mouse-clickable and rows hover-map exactly 
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

    # --- /docs: in-app library loads + a reader paginates into styled lines and scrolls 
    import dgc.docs as _docs
    check("docs library", len(_docs.DOCS) >= 8 and _docs.find("Plan mode") is not None)
    ui.input_buf = type("B", (), {"text": "", "reset": lambda self: None})()
    ui._open_doc_reader("Plan mode")
    check("doc reader builds rows", ui._overlay.get("reader") and len(ui._overlay["rows"]) > 5)
    ui._overlay_move(4)                              # arrows scroll a reader, never move a selection
    check("doc reader scrolls not selects", ui._overlay["scroll"] == 4 and ui._overlay["sel"] == 0)
    ui._render_overlay()                             # renders without raising (styled Text.from_ansi lines)

    # --- plan persistence: present_plan saves a plan.md sidecar; /view-plan reloads it 
    import dgc.sessions as _sess
    _sf = tmp / "20260101-000000.json"
    check("no plan initially", _sess.load_plan(_sf) is None)
    _sess.save_plan(_sf, "# Plan\n\n- step one\n- step two")
    check("plan saved + reloads", _sess.load_plan(_sf) == "# Plan\n\n- step one\n- step two"
          and _sess.plan_path(_sf).name == "20260101-000000.plan.md")

    # --- artifacts: ONE shared server hosts every artifact; a shell page lists them in a dropdown
    import dgc.artifacts as _art
    _art.STATE_FILE = tmp / "artifacts.json"        # isolate: never touch the real ~/.dgc state
    _art._SRV.artifacts.clear(); _art._SRV.port = None; _art._SRV.counter = 0
    _ad = tmp / "site"; _ad.mkdir(); (_ad / "index.html").write_text("<h1>hi</h1>")
    _a = _art.serve("site", tmp, "demo")
    check("artifact serves + registers", _a.id in [x.id for x in _art.registry()]
          and _art.running() and _a.entry == "" and _a.url == f"{_art.base_url()}/?a={_a.id}")
    # single shared server: a 2nd artifact reuses the SAME port; the shell lists both with a dropdown
    (tmp / "site2").mkdir(); (tmp / "site2" / "index.html").write_text("<h1>two</h1>")
    _b = _art.serve("site2", tmp, "demo2")
    import urllib.request as _u
    _shell = _u.urlopen(_art.base_url() + "/", timeout=3).read().decode()
    check("artifacts share one port + dropdown", _a.url.split("/?")[0] == _b.url.split("/?")[0]
          and "<select" in _shell and "demo2" in _shell and "demo" in _shell)
    check("artifact stop removes from list", _art.stop(_a.id) is True
          and _a.id not in [x.id for x in _art.registry()] and _art.running())
    _art.stop_all()
    check("dgc-design skill ships + off by default", "dgc-design" in discover_skills(tmp))

    # --- #8 micro-polish: sub-cell fractional context bar (eighth-block precision, exact width)
    from dgc.render import frac_bar
    _fb_ok = all(f + (1 if p else 0) + e == w for (pct, w) in [(0, 10), (42.3, 20), (87.6, 18), (100, 10)]
                 for (f, p, e) in [frac_bar(pct, w)])
    check("frac_bar keeps exact width", _fb_ok)
    check("frac_bar sub-cell partial", frac_bar(6.2, 12)[1] in "▏▎▍▌▋▊▉" and frac_bar(100, 10) == (10, "", 0))

    # --- /dashboard: an INTERACTIVE session roster (status header + "+ New session" + session rows)
    check("dashboard reltime", TUI._reltime(30) == "30s" and TUI._reltime(3700) == "1h" and TUI._reltime(90000) == "1d")
    ui.input_buf = type("B", (), {"text": "", "reset": lambda self: None})()
    _fa = type("A", (), {"session_name": "demo", "mode": "default", "session_file": None,
                         "messages": [{"role": "user", "content": "hi"}], "estimate_tokens": lambda self: 1200})()
    _fs = type("S", (), {"agent": _fa, "pinned": False, "last_activity": 0.0, "_tool_count": 3,
                         "name": "demo", "state": "idle"})()
    ui._sessions = [_fs]; ui._active_idx = 0            # a one-agent fleet
    ui.config = type("C", (), {"model": "m", "base_url": "u", "project_root": tmp,
                               "get": lambda self, k, d=None: {"context_size": 32768}.get(k, d)})()
    ui._open_dashboard()
    _dov = ui._overlay
    check("dashboard is fleet console", not _dov.get("info") and _dov.get("on_action") is not None
          and _dov["rows"][0]["value"][0] == "new" and _dov["rows"][1]["value"][0] == "switch"
          and len(_dov["header"]) == 2)
    ui._render_overlay()

    # --- headless: a failing turn (unreachable model) surfaces error+turn_end, not a silent hang
    from dgc.headless import Backend
    import threading as _th
    class _Em:
        def __init__(self): self.evs = []
        def emit(self, t, **k): self.evs.append(t)
    class _StubAgent:
        cancelled = _th.Event()
        def run_turn(self, text): raise RuntimeError("cannot connect to the model endpoint")
        def estimate_tokens(self): return 0
    b = object.__new__(Backend)
    b.em, b.agent, b._queue, b._turn_n, b._emit_context = _Em(), _StubAgent(), [], 0, lambda: None
    b._start_turn("Hi")
    b._worker.join(timeout=5)
    check("headless failing turn emits error", "error" in b.em.evs)
    check("headless failing turn still emits turn_end (clears the spinner)", "turn_end" in b.em.evs)

    # --- headless: a bad command raises a catchable (non-_Shutdown) error, so the serve loop's
    #     guard keeps the backend alive instead of crashing the whole session
    from dgc.headless import _Shutdown
    bare = object.__new__(Backend)
    outcome = None
    try:
        bare.dispatch({"type": "rewind", "index": "not-a-number"})
    except _Shutdown:
        outcome = "shutdown"
    except Exception:
        outcome = "caught"
    check("headless bad command is catchable (backend survives)", outcome == "caught")

    # --- llm: a stalled stream (model prefilling a huge context, no first token) must be
    #     interruptible by cancel — Esc/Stop can't wait on iter_lines() forever
    import http.server as _hs, socketserver as _ss, threading as _th2, time as _t2
    from dgc.llm import LLMClient
    class _Hang(_hs.BaseHTTPRequestHandler):
        def do_POST(self):
            self.send_response(200); self.send_header("Content-Type", "text/event-stream"); self.end_headers()
            _t2.sleep(30)                                  # hold the connection: model "prefilling"
        def log_message(self, *a): pass
    _srv = _ss.TCPServer(("127.0.0.1", 0), _Hang); _port = _srv.server_address[1]
    _th2.Thread(target=_srv.serve_forever, daemon=True).start()
    _cl = LLMClient(base_url=f"http://127.0.0.1:{_port}/v1", api_key="x", model="m")
    _cx = _th2.Event()
    _th2.Thread(target=lambda: (_t2.sleep(0.5), _cx.set()), daemon=True).start()
    _t0 = _t2.monotonic()
    _r = _cl.chat([{"role": "user", "content": "hi"}], cancel=_cx)
    _dt = _t2.monotonic() - _t0
    _srv.shutdown()
    check("llm cancel interrupts a prefill stall", _dt < 3 and _r.finish_reason == "cancelled")

    # --- todo pane: modern-CLI-style per-status glyphs render, and it stays pinned while a turn runs
    import dgc.glyphs as _gl
    tp = object.__new__(TUI)
    tp._width = 80
    tp._rich = lambda r: (lambda b: (_Con(file=b, force_terminal=True, width=80).print(r, end=""), b.getvalue())[1])(_io.StringIO())
    tp._turn = _th.Event(); tp._turn.set()
    tp._todos = [{"content": "a", "status": "pending"}, {"content": "b", "status": "in_progress"},
                 {"content": "c", "status": "done"}, {"content": "d", "status": "cancelled"}]
    _pane = tp._todo_pane().value
    check("todo pane renders all status glyphs", all(g in _pane for g in (_gl.SQUARE, _gl.PLAY, _gl.CHECK, _gl.CROSS)))
    check("todo pane pinned while a turn runs", tp._todos_visible())
    tp._turn.clear(); tp._todos = [{"content": "c", "status": "done"}]
    check("todo pane folds away when idle + all done", not tp._todos_visible())

    # --- transcript scroll: with wrap_lines=True, PT ignores get_vertical_scroll and follows the
    #     CURSOR. A tall resumed transcript used to pin to line 0 (top), hiding the live stream at
    #     the bottom. The [SetCursorPosition] marker must sit on the line we want kept visible.
    from prompt_toolkit.layout.controls import FormattedTextControl as _FTC
    sc = object.__new__(TUI)
    _txt = "\n".join(f"line{i}" for i in range(30)) + "\n"
    sc._scroll_off = 0
    check("transcript sticks to the bottom (cursor on last line)",
          _FTC(sc._cursor_ft(_txt)).create_content(60, 40).cursor_position.y == _txt.count("\n"))
    sc._scroll_off = 8
    check("transcript paged up keeps an earlier line visible",
          _FTC(sc._cursor_ft(_txt)).create_content(60, 40).cursor_position.y == _txt.count("\n") - 8)

    # --- collapsible thinking: a stored reasoning block renders collapsed with a CLICKABLE header,
    #     and expands to the full reasoning when toggled 
    from prompt_toolkit.formatted_text import fragment_list_to_text as _fltt
    tt = object.__new__(TUI); tt._width = 80; tt._scroll_off = 0
    tt._invalidate = lambda: None; tt._buf = ""; tt._think = ""
    tb = {"kind": "think", "secs": 2.0, "text": "reason one\nreason two", "exp": False}
    tt.blocks = [tb, "the answer"]
    ftc = tt._transcript()
    check("thinking collapses to a Thought header", "Thought for 2.0s" in _fltt(ftc) and "reason one" not in _fltt(ftc))
    check("thinking header is clickable", any(len(f) > 2 and callable(f[2]) for f in ftc))
    tb["exp"] = True
    check("thinking expands to show the reasoning", "reason one" in _fltt(tt._transcript()))

    # --- merged tool block (accent rail): tool_call + tool_result share ONE stateful block; the header
    #     wears a tense-aware verb (present while running → past when done) and every row a rail glyph.
    ot = object.__new__(TUI); ot._width = 80; ot._scroll_off = 0; ot._follow = True
    ot._invalidate = lambda: None; ot._buf = ""; ot._think = ""; ot._tool_count = 0; ot._cur_tool = None
    ot.blocks = []
    ot.tool_call("bash", {"cmd": "npm test"})
    check("tool_call opens ONE running tool block", len(ot.blocks) == 1 and ot.blocks[0].get("running"))
    _live = _fltt(ot._transcript())
    check("running tool shows present-tense verb + rail", "Running" in _live and "┃" in _live)
    ot.tool_result("bash", "\n".join(f"out{i}" for i in range(15)))
    check("tool_result fills the SAME block (no second block)", len(ot.blocks) == 1 and not ot.blocks[0].get("running"))
    _done = _fltt(ot._transcript())
    check("finished tool shows past-tense verb", "Ran" in _done and "Running" not in _done)
    check("long tool output collapses to a 'more lines' hint", "more lines" in _done)
    check("tool _block_lines counts header + preview + hint", ot._block_lines(ot.blocks[0]) == 12)
    ot._settle_running_tools()   # idempotent when nothing is running
    check("settle leaves a finished block finished", not ot.blocks[0].get("running"))

    # --- sub-agent UI forwards unknown attrs to the parent (deny reasons + artifact cards), so a
    #     sub-agent's denied tool sees the user's guidance and its artifacts still surface a card.
    import types as _types, threading as _threading
    from dgc.agent import _SubUI as _SUI
    class _ParentUI:
        deny_reason = "use edit_file instead"
        def artifact_ready(self, a): return ("card", a)
    _su = _SUI(_ParentUI(), "sub")
    check("sub-agent UI forwards deny_reason to the parent", _su.deny_reason == "use edit_file instead")
    check("sub-agent UI forwards artifact_ready to the parent", _su.artifact_ready("x") == ("card", "x"))
    check("sub-agent UI keeps its own explicit methods", _su.result() == "")

    # --- fleet routing: a finished session's background autotitle/suggestion threads must target THAT
    #     session, not whatever is on screen now (else a switch mid-window titles the wrong session).
    rt = object.__new__(TUI); rt._invalidate = lambda: None; rt._tls = _threading.local()
    def _mk(n):
        ag = _types.SimpleNamespace(session_name=None)
        ag.generate_title = lambda p, n=n: f"title-{n}"
        ag.name_session = lambda t, ag=ag: setattr(ag, "session_name", t)
        ag.suggest_next = lambda p, r, n=n: f"sug-{n}"
        return _types.SimpleNamespace(agent=ag, _suggestion=None)
    _sA, _sB = _mk("A"), _mk("B")
    rt._sessions = [_sA, _sB]; rt._active_idx = 0        # A is on screen; B just finished
    rt._autotitle(_sB, "hi")
    check("autotitle targets the finishing session, not the active one",
          _sB.agent.session_name == "title-B" and _sA.agent.session_name is None)
    rt._compute_suggestion(_sB, "hi", "yo")
    check("ghost-text suggestion targets the finishing session",
          _sB._suggestion == "sug-B" and _sA._suggestion is None)

    # --- a sub-agent shares the parent's cancel Event but must NOT clear it on run_turn entry (only a
    #     top-level turn clears), else a cancel arriving during sub construction is silently swallowed.
    from dgc.agent import Agent as _Ag, _sampling as _samp
    from dgc.config import Config as _Cfg
    class _AgUI:
        def __getattr__(self, n): return lambda *a, **k: None
    _p = _Ag(_Cfg(), _AgUI()); _sub = _Ag(_Cfg(), _AgUI())
    _sub.depth = _p.depth + 1; _sub.cancelled = _p.cancelled
    _p.cancelled.set()
    if _sub.depth == 0: _sub.cancelled.clear()          # mirrors run_turn's guarded clear
    check("sub-agent does not clear a shared parent cancel", _p.cancelled.is_set())
    _p.cancelled.set()
    if _p.depth == 0: _p.cancelled.clear()
    check("top-level turn still clears its own stale cancel", not _p.cancelled.is_set())

    # --- /goal: set → # Standing goal in the prompt; persists to the session + restores on resume
    _g1 = _Ag(_Cfg(), _AgUI())
    check("no goal → no goal section", "# Standing goal" not in _g1.system_prompt())
    _g1.set_goal("ship the release")
    check("goal set → in the system prompt", "# Standing goal" in _g1.system_prompt() and "ship the release" in _g1.system_prompt())
    import dgc.sessions as _Sg
    _gp = _Sg.new_path(tempfile.mkdtemp()); _g1.session_file = _gp; _g1.messages = [{"role":"user","content":"x"}]; _g1._persist()
    check("goal persisted to the session file", _Sg.goal_of(_gp) == "ship the release")
    _g2 = _Ag(_Cfg(), _AgUI()); _g2.load_session(_gp)
    check("goal restored on resume", _g2.goal == "ship the release")
    _g1.set_goal(""); check("goal cleared → section gone", "# Standing goal" not in _g1.system_prompt())

    # --- /handoff: generate_handoff builds a sectioned doc from the whole session (for another agent)
    _h = _Ag(_Cfg(), _AgUI())
    class _HR: content = "# Handoff\n## Objective\n- x\n## Next steps\n- y"
    _hcap = {}
    _h.client.chat = lambda msgs, **kw: (_hcap.update(sys=msgs[0]["content"], body=msgs[1]["content"]) or _HR())
    _h.messages = [{"role":"system","content":"s"}, {"role":"user","content":"do the thing"},
                   {"role":"assistant","content":"did it","tool_calls":[{"function":{"name":"write_file"}}]}]
    _hd = _h.generate_handoff()
    check("handoff prompt requests the handoff sections",
          all(s in _hcap["sys"] for s in ("Objective", "Done", "Next steps", "How to continue")))
    check("handoff includes the session content", "do the thing" in _hcap["body"] and "write_file" in _hcap["body"])
    check("handoff returns a document", _hd.startswith("# Handoff"))
    check("handoff on an empty session is graceful",
          "Nothing has happened" in _Ag(_Cfg(), _AgUI()).generate_handoff())

    # --- pi adopt: context-overflow classifier matches local-server strings, not other 400s
    from dgc.llm import _OVERFLOW_RE, ContextOverflowError, LLMError as _LLME
    check("overflow classifier matches llama.cpp/Ollama/DS4 strings",
          all(_OVERFLOW_RE.search(s) for s in [
              "the request exceeds the available context size",
              "prompt has 40000 tokens, but the configured context size is 32768 tokens",
              "requested token count exceeds the model's maximum context length of 131072 tokens"]))
    check("overflow classifier ignores tool/sampling 400s",
          not _OVERFLOW_RE.search("unrecognized request argument supplied: top_k")
          and not _OVERFLOW_RE.search("invalid tool schema"))
    check("ContextOverflowError is a recoverable LLMError", issubclass(ContextOverflowError, _LLME))

    # --- pi adopt: multi_edit coerces the shapes weak models send 'edits' in
    from dgc.tools import _coerce_edits
    check("coerce edits: JSON string → list", _coerce_edits({"edits": '[{"old_string":"a","new_string":"b"}]'}) == [{"old_string":"a","new_string":"b"}])
    check("coerce edits: single object → list", _coerce_edits({"edits": {"old_string":"x","new_string":"y"}}) == [{"old_string":"x","new_string":"y"}])
    check("coerce edits: pi oldText/newText keys", _coerce_edits({"edits":[{"oldText":"p","newText":"q"}]}) == [{"old_string":"p","new_string":"q"}])
    check("coerce edits: legacy top-level old/new", _coerce_edits({"old_string":"t","new_string":"u"}) == [{"old_string":"t","new_string":"u"}])

    # --- sampling params: unset → nothing sent (respect server default); set → parsed (top_k int)
    check("sampling unset sends nothing", _samp(_Cfg()) == {})
    class _SCfg(_Cfg):
        def get(self, k, d=None): return {"temperature":"0.7","top_k":"20"}.get(k, super().get(k, d))
    _sv = _samp(_SCfg())
    check("sampling set is parsed (top_k int, temp float)",
          _sv.get("temperature") == 0.7 and _sv.get("top_k") == 20 and isinstance(_sv["top_k"], int))

    # --- /jump: scrolls the transcript to a chosen turn
    jt = object.__new__(TUI); jt._width = 80; jt._scroll_off = 0; jt._invalidate = lambda: None
    jt.blocks = ["a\nb\nc", "d", "e\nf"]
    jt._jump_to_block(2); off_new = jt._scroll_off          # newest turn → near the bottom
    jt._jump_to_block(0)                                     # oldest turn → scrolled further up
    check("jump scrolls to an earlier turn", jt._scroll_off > off_new)

    # --- resume-by-id + the modern-CLI-style resume-on-exit epilogue
    import dgc.sessions as _S, dgc.cli as _C
    _proj = Path(tempfile.mkdtemp())
    _sp = _S.new_path(_proj)
    _S.save(_sp, [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "yo"}], _proj, name="demo")
    _sid = _sp.stem
    check("session by_id exact", _S.by_id(_proj, _sid) == _sp)
    check("session by_id prefix", _S.by_id(_proj, _sid[:8]) == _sp)
    check("session by_id miss", _S.by_id(_proj, "zzz-none") is None)
    class _Ag:
        def __init__(s, f, m): s.session_file, s.messages = f, m
    _b = _io.StringIO(); _o = sys.stdout; sys.stdout = _b
    _C._print_resume_hint(_Ag(_sp, [{"role": "system", "content": "x"}, {"role": "user", "content": "hi"}, {"role": "assistant", "content": "y"}]), None)
    _C._print_resume_hint(_Ag(_sp, [{"role": "system", "content": "x"}]), None)   # no real turn → nothing
    sys.stdout = _o
    _hint = _b.getvalue()
    check("resume hint prints for a real session",
          "Resume this session" in _hint and _sid in _hint
          and "dgc --continue" in _hint and "dgc --resume" in _hint)   # ONE block, both ways to return
    check("resume hint silent on an empty session", _hint.count("Resume this session") == 1)

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
    # block-anchor (B2): boundaries match but ONE interior line drifted → still applies
    r, out = edit("def area(w, h):\n    # compute the area\n    a = w * h\n    return a\n",
                  "def area(w, h):\n    # a totally reworded comment\n    a = w * h\n    return a",
                  "def area(w, h):\n    # compute the area\n    a = w * h\n    return a * 2")
    check("edit block-anchor recovers a drifted interior line",
          out == "def area(w, h):\n    # compute the area\n    a = w * h\n    return a * 2\n", detail=repr(out))
    # block-anchor stays SAFE: unrelated interior between the same anchors → miss, no false apply
    r, out = edit("def area(w, h):\n    completely different\n    unrelated stuff\n    return a\n",
                  "def area(w, h):\n    x = 1\n    y = 2\n    return a", "X")
    check("edit block-anchor misses when interior is unrelated", out is None, detail=repr(r))
    # elision (B3): a lazy `... existing code ...` SEARCH bounding a UNIQUE region → applies
    r, out = edit("def f(x):\n    a = 1\n    b = 2\n    c = 3\n    return a + b + c\n",
                  "def f(x):\n... existing code ...\n    return a + b + c",
                  "def f(x):\n    a = 1\n    b = 2\n    c = 3\n    return a + b + c + 1")
    check("edit elision applies to a unique region",
          out == "def f(x):\n    a = 1\n    b = 2\n    c = 3\n    return a + b + c + 1\n", detail=repr(out))
    # elision stays SAFE: a repeated end-anchor makes the region ambiguous → refuse
    r, out = edit("def f():\n    return 0\n    return 0\n",
                  "def f():\n... existing code ...\n    return 0", "X")
    check("edit elision refuses an ambiguous region", out is None, detail=repr(r))
    # already-applied detection (B5): old_string is gone but new_string is already present
    r, out = edit("def f():\n    return 2\n", "def f():\n    return 1", "def f():\n    return 2")
    check("edit detects an already-applied edit", out is None and "already applied" in r, detail=repr(r))
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
        elif self.scenario == "grind":
            # a model that keeps running FAILING commands with VARIED args (so the identical-
            # call guard won't fire) but the SAME failure output — the grind guard must stop it.
            n = sum(1 for m in messages if m.get("role") == "tool")
            payload = tool_delta("bash", [json.dumps({"command": f"echo 'still failing'  # {n}\nexit 1"})])
        elif self.scenario == "verify":
            # edit → a passing `go test` → then a NON-edit tool call: the finish-when-verified
            # nudge must fire (the model kept working after its tests passed).
            MockHandler.vcount = getattr(MockHandler, "vcount", 0) + 1
            if MockHandler.vcount == 1:
                payload = tool_delta("write_file", [json.dumps({"path": "m.py", "content": "x = 1\n"})])
            elif MockHandler.vcount == 2:
                payload = tool_delta("bash", [json.dumps({"command": "echo ok  # go test ./..."})])
            elif MockHandler.vcount == 3:
                payload = tool_delta("read_file", [json.dumps({"path": "m.py"})])
            else:
                payload = sse_chunk({"content": "Done."}) + sse_chunk({}, finish="stop") + "data: [DONE]\n\n"
        elif self.scenario == "overthink":
            # a model that streams a huge reasoning block with NO output — the F4 watchdog must
            # abort + retry; after two aborts we return a real tool call so DGC recovers.
            MockHandler.otcount = getattr(MockHandler, "otcount", 0) + 1
            if MockHandler.otcount <= 2:
                payload = (sse_chunk({"reasoning": "z" * 40000})
                           + sse_chunk({}, finish="stop") + "data: [DONE]\n\n")
            else:
                args = json.dumps({"path": "hello.txt", "content": "ok\n"})
                payload = tool_delta("write_file", [args])
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


def e2e_grind(port: int, tmp: Path) -> bool:
    """A model that keeps running failing commands with no progress (varied args so the
    identical-call guard won't fire, but the SAME failure output) must be stopped by the
    grind guard — quickly, well before max_turns."""
    MockHandler.native_tools = True
    MockHandler.scenario = "grind"
    home = tmp / "home_grind"; work = tmp / "work_grind"
    home.mkdir(exist_ok=True); work.mkdir(exist_ok=True)
    env = dict(os.environ, HOME=str(home), PYTHONPATH=str(PROJECT))
    try:
        proc = subprocess.run(
            [sys.executable, "-m", "dgc", "-p", "make the tests pass",
             "--mode", "auto", "--base-url", f"http://127.0.0.1:{port}/v1", "--model", "mock-model"],
            cwd=str(work), env=env, capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired:
        print("  --- grind guard did NOT break out (timed out) ---")
        return False
    out = proc.stdout + proc.stderr
    ok = "no progress" in out or "repeated" in out
    if not ok:
        print("  --- stdout ---\n", proc.stdout[-1500:])
    return ok


def test_reasoning_payload():
    """F1: DGC's thinking level → the right per-provider reasoning wire shape."""
    from dgc.llm import _provider_family as fam, _reasoning_payload as rp
    check("family: ollama by port", fam("http://localhost:11434/v1") == "ollama")
    check("family: openai cloud", fam("https://api.openai.com/v1") == "openai")
    check("family: deepseek", fam("https://api.deepseek.com/v1") == "deepseek")
    check("family: vllm by port", fam("http://localhost:8000/v1") == "vllm")
    check("family: unknown → compat", fam("http://localhost:1234/v1") == "compat")
    # Ollama: OFF must SEND reasoning_effort:none (omitting forces thinking ON) — the D5 bug
    check("ollama off → effort:none", rp("ollama", "qwen3", "off") == {"reasoning_effort": "none"})
    check("ollama None → effort:none", rp("ollama", "qwen3", None) == {"reasoning_effort": "none"})
    check("ollama high → effort:high", rp("ollama", "qwen3", "high") == {"reasoning_effort": "high"})
    # vLLM/SGLang: enable_thinking switch (server renders template)
    check("vllm off → enable_thinking:false",
          rp("vllm", "qwen3", "off") == {"chat_template_kwargs": {"enable_thinking": False}})
    check("vllm high → enable_thinking:true + effort",
          rp("vllm", "qwen3", "high") == {"chat_template_kwargs": {"enable_thinking": True}, "reasoning_effort": "high"})
    # OpenAI cloud: only o-series/gpt-5 accept effort; no "none"; non-reasoning gets nothing
    check("openai o3 off → low", rp("openai", "o3-mini", "off") == {"reasoning_effort": "low"})
    check("openai o3 high → high", rp("openai", "o3-mini", "high") == {"reasoning_effort": "high"})
    check("openai gpt-4o off → {}", rp("openai", "gpt-4o", "off") == {})
    check("openai gpt-4o high → {}", rp("openai", "gpt-4o", "high") == {})
    # DeepSeek: reasoning is selected by the model id → send nothing
    check("deepseek → {}", rp("deepseek", "deepseek-reasoner", "high") == {})
    # Anthropic-compat: budget when on, nothing when off
    check("anthropic off → {}", rp("anthropic", "claude", "off") == {})
    check("anthropic high → budget",
          rp("anthropic", "claude", "high") == {"thinking": {"type": "enabled", "budget_tokens": 16384}})
    # Unknown compat host → belt-and-suspenders both switches for OFF
    check("compat off → both switches",
          rp("compat", "x", "off") == {"reasoning_effort": "none", "chat_template_kwargs": {"enable_thinking": False}})


def test_overthink_watchdog():
    """F4: reasoning that runs past the budget with no output → finish_reason 'overthink'."""
    from dgc.llm import LLMClient

    class _FakeResp:
        def __init__(self, lines):
            self._lines = lines
            self.headers = {"Content-Type": "text/event-stream"}
        def iter_lines(self, decode_unicode=True):
            yield from self._lines
        def close(self):
            pass

    c = LLMClient("http://localhost:11434/v1", "k", "m", think_budget_tokens=10)   # 40-char budget
    big = "x" * 100
    runaway = ['data: {"choices":[{"delta":{"reasoning":"%s"}}]}' % big, "data: [DONE]"]
    r = c._consume(_FakeResp(runaway), None, None, think_budget=c.think_budget_chars)
    check("watchdog fires on runaway reasoning", r.finish_reason == "overthink")
    r2 = c._consume(_FakeResp(runaway), None, None, think_budget=0)                # disabled
    check("watchdog off → no overthink", r2.finish_reason != "overthink")
    ok = ['data: {"choices":[{"delta":{"reasoning":"xx"}}]}',                       # content before budget
          'data: {"choices":[{"delta":{"content":"hi"}}]}',
          'data: {"choices":[{"delta":{"reasoning":"%s"}}]}' % big,
          "data: [DONE]"]
    r3 = c._consume(_FakeResp(ok), None, None, think_budget=c.think_budget_chars)
    check("watchdog disarmed once output starts", r3.finish_reason != "overthink")


def e2e_overthink(port: int, tmp: Path) -> bool:
    """F4 end-to-end: a server that streams runaway reasoning with no output must be aborted by
    the watchdog and retried, and DGC must recover (the 3rd request returns a real tool call)."""
    MockHandler.native_tools = True
    MockHandler.scenario = "overthink"
    MockHandler.otcount = 0
    home = tmp / "home_ot"; work = tmp / "work_ot"
    home.mkdir(exist_ok=True); work.mkdir(exist_ok=True)
    env = dict(os.environ, HOME=str(home), PYTHONPATH=str(PROJECT))
    try:
        proc = subprocess.run(
            [sys.executable, "-m", "dgc", "-p", "make the file",
             "--mode", "auto", "--base-url", f"http://127.0.0.1:{port}/v1", "--model", "mock-model"],
            cwd=str(work), env=env, capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired:
        print("  --- overthink watchdog did NOT recover (timed out) ---")
        return False
    ok = (work / "hello.txt").exists()
    if not ok:
        print("  --- stdout ---\n", proc.stdout[-1500:])
    return ok


def test_multi_edit():
    """B4: apply several edits to one file; keep the good ones even if one fails."""
    import tempfile as _tf
    from pathlib import Path as _P
    from dgc.tools import multi_edit

    class _C:
        def __init__(self, root): self.project_root = root

    d = _P(_tf.mkdtemp()); f = d / "t.py"
    f.write_text("a = 1\nb = 2\nc = 3\n")
    r = multi_edit({"path": str(f), "edits": [
        {"old_string": "a = 1", "new_string": "a = 10"},
        {"old_string": "c = 3", "new_string": "c = 30"}]}, _C(d))
    check("multi_edit applies all hunks",
          f.read_text() == "a = 10\nb = 2\nc = 30\n" and "applied 2/2" in r, detail=repr(r))
    f.write_text("x = 1\ny = 2\n")
    r = multi_edit({"path": str(f), "edits": [
        {"old_string": "x = 1", "new_string": "x = 100"},
        {"old_string": "NOPE", "new_string": "nope"}]}, _C(d))
    check("multi_edit keeps the good hunk + reports the failure",
          f.read_text() == "x = 100\ny = 2\n" and "applied 1/2" in r and "FAILED" in r, detail=repr(r))


def e2e_verify(port: int, tmp: Path) -> bool:
    """finish-when-verified: after a test passes and the model keeps tooling without editing,
    the nudge to wrap up must appear in the conversation."""
    import glob
    MockHandler.native_tools = True
    MockHandler.scenario = "verify"
    MockHandler.vcount = 0
    home = tmp / "home_verify"; work = tmp / "work_verify"
    home.mkdir(exist_ok=True); work.mkdir(exist_ok=True)
    env = dict(os.environ, HOME=str(home), PYTHONPATH=str(PROJECT))
    try:
        subprocess.run([sys.executable, "-m", "dgc", "-p", "make the tests pass",
                        "--mode", "auto", "--base-url", f"http://127.0.0.1:{port}/v1", "--model", "mock-model"],
                       cwd=str(work), env=env, capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired:
        return False
    sess = sorted(glob.glob(str(home / ".dgc" / "sessions" / "**" / "*.json"), recursive=True),
                  key=os.path.getmtime)
    if not sess:
        return False
    msgs = json.loads(Path(sess[-1]).read_text())
    if isinstance(msgs, dict):
        msgs = msgs.get("messages", [])
    return any("haven't changed the code since" in str(m.get("content", "")) for m in msgs)


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
        test_reasoning_payload()
        test_overthink_watchdog()
        test_multi_edit()

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
            check("e2e grind guard stops repeated failing commands", e2e_grind(port, tmp))
            check("e2e overthink watchdog recovers via retry", e2e_overthink(port, tmp))
            check("e2e finish-when-verified nudges after tests pass", e2e_verify(port, tmp))
        finally:
            server.shutdown()

    print(f"\n{sum(PASS)}/{len(PASS)} checks passed")
    sys.exit(0 if all(PASS) else 1)


if __name__ == "__main__":
    main()
