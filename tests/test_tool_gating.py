"""A tool the user switched off must be refused where it RUNS, not only where it is advertised.

Every gate DGC had on `python`, on a sub-agent's `tools:` allow-list and on plan mode filtered the
schema list sent to the model. None of them was consulted by the executor. That is only a catalog,
and a catalog is not a boundary, because DGC also accepts tool calls the model writes as prose
(`parse_text_tool_calls`): text in a file, a web page or an MCP result can steer a model into
emitting `<tool_call>{"name": "python", ...}`, which DGC then parses into a real call and runs.

So each test here drives the EXECUTION path with a call the schema never offered.
"""
from __future__ import annotations

import copy
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import os as _os, sys as _sys                             # noqa: E402
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))

if "dgc.config" not in sys.modules and "dgc-tests-home-" not in os.environ.get("HOME", ""):
    _HOME = tempfile.mkdtemp(prefix="dgc-tests-home-")
    os.environ["HOME"] = os.environ["USERPROFILE"] = os.path.realpath(_HOME)

from dgc import tools                                      # noqa: E402
from dgc.agent import Agent                                # noqa: E402
from dgc.config import Config, DEFAULTS                    # noqa: E402
from dgc.llm import LLMClient, ToolCall                    # noqa: E402


class QuietUI:
    """Every UI hook the agent may touch, recording nothing."""
    non_interactive = True

    def __getattr__(self, _name):
        return lambda *a, **k: None


def fixture_config(root: Path, **data) -> Config:
    config = object.__new__(Config)
    config.project_root, config.project_dir, config._persist = root, root / ".dgc", False
    config.data = copy.deepcopy(DEFAULTS)
    config.data.update(base_url="http://localhost.invalid/v1", model="fixture", mode="auto",
                       hooks={}, mcp_servers={}, suggest=False, artifact_autostart=False,
                       plan_artifact=False, notes=False)
    config.data.update(data)
    config._stored_secrets, config._env_secret_keys, config._explicit_keys = {}, set(), set()
    config.credential_warnings = ()
    config.permissions = {"allow": [], "ask": [], "deny": []}
    return config


def offer(agent):
    """Do what sending a request does: build the catalog AND record what it offered.

    `_tool_schemas` is deliberately pure — it is also called to estimate tokens and to probe the
    options picker, including from the UI thread mid-turn, so it must not decide what the current
    request offered. The turn loop records the set; this mirrors that for a test that is not
    running a whole turn. `test_the_request_site_records_what_it_offered` pins the real one.
    """
    tools = agent._tool_schemas()
    agent._offered_tool_names = (
        {str(t.get("function", {}).get("name") or "") for t in tools} if tools else None)
    return tools


def make_agent(root: Path, **data) -> Agent:
    client = LLMClient("http://localhost.invalid/v1", "", "fixture")
    with patch.object(Agent, "_new_client", lambda self, *a, **k: client):
        return Agent(fixture_config(root, **data), QuietUI())


class ToolGatingTests(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.TemporaryDirectory(prefix="dgc-gating-")
        self.root = Path(self._dir.name)
        self.addCleanup(self._dir.cleanup)

    # ---- the switch the user actually turns ---------------------------------------------------

    def test_python_is_refused_at_execution_when_code_action_is_off(self):
        agent = make_agent(self.root, code_action=False)
        offered = {t.get("function", {}).get("name") for t in offer(agent)}
        self.assertNotIn("python", offered, "precondition: it is not advertised")

        marker = self.root / "pwned.txt"
        out = agent._handle_call(ToolCall(
            "textcall_1", "python", {"code": f"open({str(marker)!r}, 'w').write('x')"}))

        self.assertIn("not offered", out)
        self.assertFalse(marker.exists(),
                         "the interpreter ran although the user never enabled code_action")

    def test_python_still_runs_when_the_user_did_enable_it(self):
        agent = make_agent(self.root, code_action=True)
        offered = {t.get("function", {}).get("name") for t in offer(agent)}
        self.assertIn("python", offered)
        out = agent._handle_call(ToolCall("textcall_1", "python", {"code": "print(6 * 7)"}))
        self.assertNotIn("was not offered", out)
        self.assertIn("42", out)

    # ---- a sub-agent the user bounded to reading ----------------------------------------------

    def test_a_read_only_subagent_cannot_write_files(self):
        agent = make_agent(self.root)
        agent._agent_tool_allowlist = frozenset({"read_file", "grep"})
        offer(agent)                                       # the request the child would have made

        target = self.root / "written-by-a-read-only-agent.txt"
        out = agent._handle_call(ToolCall(
            "textcall_1", "write_file", {"path": str(target), "content": "x"}))

        self.assertIn("not offered", out)
        self.assertFalse(target.exists(),
                         "a child declared read-only wrote a file in auto mode")

    def test_a_read_only_subagent_cannot_shell_out(self):
        agent = make_agent(self.root)
        agent._agent_tool_allowlist = frozenset({"read_file", "grep"})
        offer(agent)
        marker = self.root / "shelled.txt"
        out = agent._handle_call(ToolCall("textcall_1", "bash", {"command": f"touch {marker}"}))
        self.assertIn("not offered", out)
        self.assertFalse(marker.exists())

    def test_the_tools_it_was_given_still_work(self):
        source = self.root / "app.py"
        source.write_text("def login():\n    return True\n", encoding="utf-8")
        agent = make_agent(self.root)
        agent._agent_tool_allowlist = frozenset({"read_file", "grep"})
        offer(agent)
        out = agent._handle_call(ToolCall("textcall_1", "read_file", {"path": str(source)}))
        self.assertIn("def login", out)

    def test_an_agent_with_no_tools_line_keeps_everything(self):
        # agents.py hands an empty frozenset when a definition names no tools; that means
        # "unrestricted", and the gate must not read it as "nothing allowed".
        agent = make_agent(self.root)
        agent._agent_tool_allowlist = frozenset()
        offer(agent)
        target = self.root / "ok.txt"
        out = agent._handle_call(ToolCall(
            "textcall_1", "write_file", {"path": str(target), "content": "x"}))
        self.assertNotIn("was not offered", out)

    # ---- the control tools _handle_call answers itself ------------------------------------------

    def test_a_control_tool_keeps_its_own_precise_refusal(self):
        # present_plan is answered inside _handle_call and never dispatched. Its own message names
        # plan mode; the generic "not offered" would be a worse answer, not a safer one.
        agent = make_agent(self.root, mode="auto")
        offer(agent)
        out = agent._handle_call(ToolCall("textcall_1", "present_plan", {"plan": "do the thing"}))
        self.assertIn("plan mode", out)

    # ---- before any request has been made -------------------------------------------------------

    def test_nothing_is_refused_before_a_catalog_exists(self):
        # _offered_tool_names is unset until the first request is built (the SDK and headless
        # callers reach tools directly). An empty set must not mean "refuse everything".
        agent = make_agent(self.root)
        self.assertIsNone(getattr(agent, "_offered_tool_names", None))
        source = self.root / "a.txt"
        source.write_text("hello", encoding="utf-8")
        out = agent._handle_call(ToolCall("t1", "read_file", {"path": str(source)}))
        self.assertIn("hello", out)


class OfferedSetIsPerRequestTests(unittest.TestCase):
    """The set must describe the request that was sent, not the last caller of _tool_schemas."""

    def test_building_a_catalog_does_not_change_what_the_last_request_offered(self):
        # _tool_schemas is called to estimate tokens and to probe the picker — and the TUI calls
        # the token estimate from its render thread on every status-line repaint. While it also
        # assigned the offered set, a repaint mid-batch could replace it, and a batch following an
        # approved plan was refused with "not offered on this request".
        with tempfile.TemporaryDirectory(prefix="dgc-offer-") as tmp:
            agent = make_agent(Path(tmp))
            agent._offered_tool_names = {"sentinel"}
            agent._tool_schemas()
            self.assertEqual(agent._offered_tool_names, {"sentinel"},
                             "_tool_schemas rewrote the offered set as a side effect")

    def test_the_request_site_records_what_it_offered(self):
        from pathlib import Path as _Path
        source = (_Path(__file__).resolve().parents[1] / "dgc" / "agent.py").read_text(encoding="utf-8")
        index = source.index("tools = self._tool_schemas() if self.client.tools_supported else None")
        window = source[index:index + 900]
        self.assertIn("self._offered_tool_names", window,
                      "the turn loop must record the set for the request it is about to send")


class SandboxCoversPythonTests(unittest.TestCase):
    """`--sandbox` confines the shell. The Python interpreter is not run through the shell."""

    def setUp(self):
        self._dir = tempfile.TemporaryDirectory(prefix="dgc-sandbox-")
        self.root = Path(self._dir.name)
        self.addCleanup(self._dir.cleanup)

    def _sandbox_deny(self, choice):
        """The session deny list `dgc --sandbox <choice>` installs, from the real flag handler."""
        from types import SimpleNamespace
        from dgc import cli as cli_mod
        config = fixture_config(self.root)
        config.session_permissions = {}
        cli_mod.apply_run_flags(
            config, SimpleNamespace(add_dir=None, allow_tool=None, sandbox=choice),
            type("P", (), {"error": staticmethod(lambda m: (_ for _ in ()).throw(SystemExit(m)))})())
        return list((getattr(config, "session_permissions", None) or {}).get("deny") or [])

    def test_read_only_denies_python_alongside_the_edit_tools(self):
        deny = self._sandbox_deny("read-only")
        self.assertIn("Python", deny,
                      "--sandbox read-only must deny the one tool the sandbox cannot confine")
        for tool in ("Write", "Edit", "MultiEdit", "ApplyPatch"):
            self.assertIn(tool, deny)

    def test_sandbox_on_denies_python_too(self):
        # The interpreter is unconfined under `on` exactly as it is under `read-only`; only the
        # edit tools differ. Leaving it available there was the other half of the same hole.
        deny = self._sandbox_deny("on")
        self.assertIn("Python", deny, "--sandbox on leaves the interpreter unconfined")
        self.assertNotIn("Write", deny, "--sandbox on is not read-only; edits are still allowed")

    def test_sandbox_off_denies_nothing(self):
        self.assertEqual(self._sandbox_deny("off"), [])

    def test_the_executor_does_not_override_the_host(self):
        """python() must not refuse on its own: the permission layer owns that decision.

        An SDK host is promised (sdk/python/dgc_sdk/policy.py) that python is refused in auto mode
        — nobody is there to review — and is an ordinary permission request its `on_permission`
        callback answers in every other mode. A refusal inside the tool overrode that host in all
        modes, with no way to switch it off, including under the SDK's DEFAULT policy.
        """
        config = fixture_config(self.root, code_action=True, sandbox=True)
        ctx = type("Ctx", (), {"config": config, "project_root": self.root, "tool_owner": "sdk"})()
        out = tools.python({"code": "print(6 * 7)"}, ctx)
        self.assertNotIn("cannot confine the python interpreter", out,
                         "the executor decided something the permission layer owns")
        self.assertIn("42", out)


if __name__ == "__main__":
    unittest.main()


class ControlToolDenyTests(unittest.TestCase):
    """A deny rule on a control tool has to be read where that tool is answered.

    `present_plan`, `propose_options`, `ask_user` and `update_goal` are answered inside
    `_handle_call` and return before the permission engine is consulted, so `deny: ProposeOptions`
    -- a user who does not want to be interrupted with a picker, or `deny: PresentPlan` in an
    unattended run -- silently did nothing. `artifact` is in the same position and already checked.
    """

    def setUp(self):
        self._dir = tempfile.TemporaryDirectory(prefix="dgc-control-deny-")
        self.root = Path(self._dir.name)
        self.addCleanup(self._dir.cleanup)

    def _agent(self, denied):
        agent = make_agent(self.root, mode="plan")
        agent.config.permissions = {"allow": [], "ask": [], "deny": list(denied)}
        offer(agent)
        return agent

    def test_a_denied_plan_is_refused(self):
        agent = self._agent(["PresentPlan"])
        out = agent._handle_call(ToolCall("t1", "present_plan", {"plan": "1. do the thing"}))
        self.assertIn("PERMISSION DENIED", out)
        self.assertFalse(getattr(agent, "_plan_presented", False),
                         "a denied plan was still recorded as presented")

    def test_a_denied_picker_is_refused(self):
        agent = self._agent(["ProposeOptions"])
        out = agent._handle_call(ToolCall("t1", "propose_options", {
            "question": "which?", "options": [{"label": "a"}, {"label": "b"}]}))
        self.assertIn("PERMISSION DENIED", out)

    def test_an_unrelated_deny_leaves_them_alone(self):
        agent = self._agent(["Bash"])
        out = agent._handle_call(ToolCall("t1", "present_plan", {"plan": "1. do the thing"}))
        self.assertNotIn("PERMISSION DENIED", out)


class InvalidPermissionRuleVisibilityTests(unittest.TestCase):
    """A deny rule that does not parse is dropped. The listing must not show it as in force."""

    def test_invalid_rules_are_reported(self):
        from dgc.permissions import invalid_rules, parse_rules
        rules = {"allow": [], "ask": [],
                 "deny": ["Bash(rm -rf *)", "Pyton", "Write(secrets/**)", "Bash(curl"]}
        kept = parse_rules(rules)
        dropped = invalid_rules(rules)
        self.assertEqual(len(kept) + len(dropped), 4, "every line is either kept or reported")
        self.assertEqual({text for _a, text, _w in dropped}, {"Pyton", "Bash(curl"})
        for action, _text, why in dropped:
            self.assertEqual(action, "deny")
            self.assertTrue(why, "a dropped rule must carry the reason")

    def test_a_valid_file_reports_nothing(self):
        from dgc.permissions import invalid_rules
        self.assertEqual(invalid_rules({"allow": ["Read(**)"], "ask": [], "deny": ["Bash(*)"]}), [])

    def test_both_listings_mark_them(self):
        from pathlib import Path
        root = Path(__file__).resolve().parents[1]
        for rel in ("dgc/cli.py", "dgc/tui.py"):
            text = (root / rel).read_text(encoding="utf-8")
            self.assertIn("invalid — NOT in force", text,
                          f"{rel} lists permission rules and must mark the ones that were dropped")


class OllamaCloudStreamCloseTests(unittest.TestCase):
    """The 0.41.9 stall-watcher fix missed the body Ollama's cloud actually sends.

    It wrapped the line-streaming reader only. Ollama cloud serves its newline-delimited stream
    under `application/json`, which takes the buffered reader — so a watcher close there still
    surfaced as `AttributeError: 'NoneType' object has no attribute 'read'`, burying the stall
    message and the retry that 0.41.9 added.
    """

    def test_both_buffered_readers_go_through_the_watcher_guard(self):
        from pathlib import Path
        source = (Path(__file__).resolve().parents[1] / "dgc" / "llm.py").read_text(encoding="utf-8")
        self.assertEqual(source.count("for chunk in iterator(chunk_size=65_536):"), 0,
                         "every bounded body reader must go through _until_watcher_closes")
        self.assertGreaterEqual(
            source.count("_until_watcher_closes(iterator(chunk_size=65_536), response)"), 2)

    def test_a_watcher_close_ends_the_buffered_read_quietly(self):
        from dgc.llm import _until_watcher_closes

        class Response:
            _dgc_closed = True
            raw = None
            headers = {}

        def chunks():
            yield b'{"response": "hi"}\n'
            raise AttributeError("'NoneType' object has no attribute 'read'")

        out = list(_until_watcher_closes(chunks(), Response()))
        self.assertEqual(out, [b'{"response": "hi"}\n'],
                         "the bytes already received survive, and the close ends the stream")

    def test_a_real_transport_fault_still_raises(self):
        from dgc.llm import _until_watcher_closes

        class Response:
            _dgc_closed = False
            raw = None
            headers = {}

        def chunks():
            raise AttributeError("a genuine bug")

        with self.assertRaises(AttributeError):
            list(_until_watcher_closes(chunks(), Response()))


class DelegationAndArtifactAreGatedTests(unittest.TestCase):
    """A read-only sub-agent must not reach a writer by delegating to one.

    The gate first checked `name in EXECUTORS`, and neither `task` nor `artifact` is in that
    table — so a child bounded by `tools: [read_file, grep]` could still emit `task` (prose-parsed
    like any other injected call) and let an unrestricted grandchild do the writing, or `artifact`
    to serve repo files over HTTP. Every MCP route was outside the table for the same reason.
    """

    def setUp(self):
        self._dir = tempfile.TemporaryDirectory(prefix="dgc-delegate-")
        self.root = Path(self._dir.name)
        self.addCleanup(self._dir.cleanup)

    def bounded_agent(self):
        agent = make_agent(self.root)
        agent._agent_tool_allowlist = frozenset({"read_file", "grep"})
        offer(agent)
        return agent

    def test_a_read_only_child_cannot_delegate(self):
        agent = self.bounded_agent()
        out = agent._handle_call(ToolCall("textcall_1", "task", {
            "description": "write the file", "prompt": "create app.py"}))
        self.assertIn("not offered", out,
                      "a bounded child reached an unrestricted grandchild through task")

    def test_a_read_only_child_cannot_publish_an_artifact(self):
        agent = self.bounded_agent()
        out = agent._handle_call(ToolCall("textcall_1", "artifact", {
            "name": "leak", "path": str(self.root)}))
        self.assertIn("not offered", out)

    def test_a_read_only_child_cannot_reach_an_mcp_server(self):
        agent = self.bounded_agent()
        for name in ("mcp_call", "mcp__someserver__do_thing"):
            with self.subTest(name=name):
                out = agent._handle_call(ToolCall("textcall_1", name, {"arguments": {}}))
                self.assertIn("not offered", out)

    def test_an_unknown_name_is_still_left_to_the_executor(self):
        # Not a hole, and refusing it here would hide a call the user should see the model make.
        agent = self.bounded_agent()
        out = agent._handle_call(ToolCall("textcall_1", "ls", {"path": "."}))
        self.assertNotIn("was not offered", out)

    def test_an_unbounded_agent_still_delegates(self):
        agent = make_agent(self.root)
        offer(agent)
        out = agent._handle_call(ToolCall("t1", "task", {
            "description": "look around", "prompt": "find the entrypoint"}))
        self.assertNotIn("was not offered", out)
