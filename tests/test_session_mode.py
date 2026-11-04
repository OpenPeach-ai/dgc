"""A reopened session comes back in the mode it ran in: as it was when the person reopens it (the editor, the
interactive terminal), and only when that asks no less than the mode it replaces for a script or an app.

Mode is per chat -- a risky refactor sits in default while a scratch chat runs auto -- so it belongs
to the conversation, the way Codex keeps it per thread. Reopening is re-checked rather than trusted
from the file, never rewrites the user's own default and never overrides a mode named for the run. A
script, an SDK app or an ACP client never raises the mode: a session last run in auto, reopened by
`dgc -p --mode plan --continue`, ran in auto. The person does: a chat they set to Auto, closed and
reopened, came back in Default (0.51.0 release candidate).
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

# Hermetic like tests/test_todo_lifecycle.py: redirect HOME before any dgc module reads it.


def _real_account_home() -> Path:
    try:
        import pwd
        return Path(pwd.getpwuid(os.getuid()).pw_dir).resolve(strict=False)
    except (ImportError, KeyError, AttributeError):
        return Path(os.path.expanduser("~")).resolve(strict=False)


if "dgc.config" in sys.modules:
    _user_home = Path(sys.modules["dgc.config"].USER_HOME).resolve(strict=False)
    _account_home = _real_account_home()
    if _user_home == _account_home or _account_home in _user_home.parents:
        raise RuntimeError(
            "tests/test_session_mode.py needs HOME redirected before dgc is imported — run it "
            "through tests/run_tests.py or with HOME=<tmp>")
else:
    _ISOLATED_HOME = tempfile.TemporaryDirectory(prefix="dgc-session-mode-home-")
    os.environ["HOME"] = os.path.realpath(_ISOLATED_HOME.name)
    os.environ["USERPROFILE"] = os.environ["HOME"]
    os.environ.pop("XDG_CONFIG_HOME", None)
    os.environ.pop("XDG_DATA_HOME", None)

from dgc import config as config_module  # noqa: E402
from dgc import sessions  # noqa: E402
from dgc.agent import Agent  # noqa: E402
from dgc.config import Config  # noqa: E402
from dgc.trust import mark_trusted, revoke_trust  # noqa: E402


class _QuietUI:
    non_interactive = False

    def __getattr__(self, name):
        if name.startswith("_") or name == "console":
            raise AttributeError(name)
        return lambda *args, **kwargs: None


class SessionModeTest(unittest.TestCase):
    def setUp(self):
        tmp = Path(tempfile.mkdtemp(prefix="dgc-session-mode-")).resolve()
        self.user_dgc = tmp / "user-dgc"
        self.user_dgc.mkdir()
        for name, value in (("USER_HOME", self.user_dgc), ("USER_CONFIG", self.user_dgc / "config.json"),
                            ("USER_SECRETS", self.user_dgc / "secrets.json")):
            patcher = patch.object(config_module, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        (self.user_dgc / "config.json").write_text(json.dumps({
            "model": "fixture", "base_url": "http://localhost.invalid/v1", "suggest": False,
            "artifact_autostart": False, "mcp_servers": {}, "mode": "default"}))
        scoped = patch.object(sessions, "SESSIONS_DIR", tmp / "sessions")
        scoped.start()
        self.addCleanup(scoped.stop)
        self.root = tmp / "project"
        self.root.mkdir()

    def stored_mode(self) -> str:
        return json.loads((self.user_dgc / "config.json").read_text()).get("mode", "")

    def store(self, mode: str) -> None:
        """The user's own mode, as `~/.dgc/config.json` holds it."""
        path = self.user_dgc / "config.json"
        data = json.loads(path.read_text())
        data["mode"] = mode
        path.write_text(json.dumps(data))

    def agent(self) -> Agent:
        agent = Agent(Config(project_root=self.root), _QuietUI())
        self.addCleanup(agent.mcp.stop_all)
        return agent

    def saved_in(self, mode: str, *, trusted: bool = True) -> Path:
        agent = self.agent()
        if trusted:
            mark_trusted(agent.config, self.root)
        agent.session_file = sessions.new_path(self.root)
        agent.config.data["mode"] = mode            # the chat ran in this mode
        agent.messages.append({"role": "user", "content": "hello"})
        self.assertTrue(agent._persist(), agent._last_persist_error)
        return agent.session_file

    def test_a_chat_reopens_in_the_mode_it_ran_in(self):
        path = self.saved_in("plan")
        reopened = self.agent()
        self.assertEqual(reopened.mode, "default", "premise: a fresh chat starts in the default")
        reopened.load_session(path)
        self.assertEqual(reopened.mode, "plan")

    def test_reopening_never_rewrites_the_users_default(self):
        path = self.saved_in("acceptEdits")
        self.store("auto")
        reopened = self.agent()
        reopened.load_session(path)
        self.assertEqual(reopened.mode, "acceptEdits")
        reopened.config.set("thinking", "high")     # any later save
        self.assertEqual(self.stored_mode(), "auto", "reopening a chat changed every new chat's mode")

    def test_a_mode_chosen_after_reopening_is_saved_as_the_default(self):
        path = self.saved_in("plan")
        reopened = self.agent()
        reopened.load_session(path)
        reopened.set_mode("acceptEdits")
        self.assertEqual(self.stored_mode(), "acceptEdits")

    def test_editor_auto_applies_only_to_the_current_chat(self):
        current = self.agent()
        current.set_mode("auto", persist=False)
        self.assertEqual(current.mode, "auto")
        current.config.set("thinking", "high")
        self.assertEqual(self.stored_mode(), "default", "a later settings save persisted the editor's Auto")
        self.assertEqual(self.agent().mode, "default", "a new backend inherited the editor's Auto")
        current.reset()
        self.assertEqual(current.mode, "default", "New chat inherited the previous chat's Auto")

    def test_an_editor_process_never_starts_in_auto_whoever_saved_it(self):
        # Auto is confirmed for one Work chat at a time in the editor (Settings says so), so a saved auto, from
        # 0.50.0 or from `dgc` in a terminal, starts an editor chat in default. The saved choice stays the CLI's.
        from dgc import cli
        self.store("auto")
        with patch.dict(os.environ, {"DGC_SDK_ISOLATED": "", "DGC_EDITOR_SESSION": "1"}):
            config = cli._serve_config()
        self.assertEqual(config.get("mode"), "default")
        self.assertEqual(self.stored_mode(), "auto", "the editor changed the CLI's saved choice")
        with patch.dict(os.environ, {"DGC_SDK_ISOLATED": "1", "DGC_EDITOR_SESSION": "1"}):
            isolated = cli._serve_config()
        self.assertEqual(isolated.get("mode"), "auto")
        self.assertTrue(isolated.mode_explicit)
        with patch.dict(os.environ, {"DGC_SDK_ISOLATED": "", "DGC_EDITOR_SESSION": ""}):
            external_serve = cli._serve_config()
        self.assertEqual(external_serve.get("mode"), "auto")

    def test_editor_set_mode_command_does_not_change_global_mode(self):
        from types import SimpleNamespace
        from dgc import headless
        backend = object.__new__(headless.Backend)
        events = []
        backend.em = SimpleNamespace(emit=lambda kind, **fields: events.append((kind, fields)))
        backend._busy = lambda: False
        backend.agent = self.agent()
        backend.config = backend.agent.config
        backend.workspace_trusted = True
        backend._dispatch({"type": "set_mode", "mode": "auto", "request_id": "r1"})
        self.assertEqual(backend.agent.mode, "auto")
        self.assertEqual(self.stored_mode(), "default")
        self.assertTrue(any(kind == "mode_changed" and fields.get("mode") == "auto"
                            for kind, fields in events))

    # ---- approving a plan into auto is for that chat only ----------------------------------------

    def approve_plan(self, agent, choice: str) -> str:
        """The plan card, as every surface draws it: the editor, the terminal and ACP each return the choice."""
        from dgc.llm import ToolCall

        class Approve(_QuietUI):
            def present_plan(self, plan):
                return choice
        agent.ui = Approve()
        agent.config.data["plan_artifact"] = False
        return agent._handle_call(ToolCall("p1", "present_plan", {"plan": "1. patch the parser"}))

    def test_an_editor_plan_approved_into_auto_or_accept_edits_leaves_the_saved_mode_alone(self):
        for choice in ("auto", "acceptEdits"):
            with self.subTest(choice=choice):
                agent = self.agent()
                mark_trusted(agent.config, self.root)
                agent.set_mode("plan", persist=False)        # the editor's mode menu: this chat only
                self.assertIn(f"permission mode is now '{choice}'", self.approve_plan(agent, choice))
                self.assertEqual(agent.mode, choice)
                agent.config.set("thinking", "high")         # any later save
                self.assertEqual(self.stored_mode(), "default", "the plan card saved its mode for every session")
                self.assertEqual(self.agent().mode, "default", "the next terminal or SDK session took it")
                agent.reset()
                self.assertEqual(agent.mode, "default", "a New chat kept the approved plan's mode")

    def test_a_terminal_or_acp_plan_approved_into_auto_runs_in_auto_and_never_saves_it(self):
        for before in ("default", "acceptEdits", "auto"):
            with self.subTest(before=before):
                self.store(before)
                agent = self.agent()
                mark_trusted(agent.config, self.root)
                agent.set_mode("plan")                       # /plan, Shift+Tab or ACP's session/set_mode: saved
                self.assertEqual(self.stored_mode(), "plan")
                self.assertIn("permission mode is now 'auto'", self.approve_plan(agent, "auto"))
                self.assertEqual(agent.mode, "auto")
                agent.config.set("thinking", "high")
                self.assertEqual(self.stored_mode(), "acceptEdits" if before == "acceptEdits" else "default")
                self.assertEqual(self.agent().mode, self.stored_mode())

    def test_the_editor_and_acp_are_told_the_mode_an_approved_plan_runs_in(self):
        # Approved into auto, the chat ran in auto while the editor's mode chip and status bar (and an ACP
        # client's mode) still said "plan", through the plan's run and the next turn: exit_plan holds the mode
        # for this chat (set_mode persist=False) and nothing said so.
        import io
        import threading
        import time
        from dgc import editor_protocol as ep
        from dgc.acp import _ACPUi
        from dgc.headless import HeadlessUI
        from dgc.llm import ToolCall
        from dgc.protocol import Emitter, PendingRequests

        def run(agent, answer):
            """The real plan card: present_plan blocks for the front-end's answer, then exit_plan runs."""
            agent.config.data["plan_artifact"] = False
            done = {}
            worker = threading.Thread(target=lambda: done.setdefault(
                "out", agent._handle_call(ToolCall("p1", "present_plan", {"plan": "1. patch the parser"}))))
            worker.start()
            answer()
            worker.join(10)
            self.assertFalse(worker.is_alive())
            return done.get("out", "")

        for scoped in (True, False):
            for choice in ("auto", "acceptEdits", "default"):
                with self.subTest(surface="editor", scoped=scoped, choice=choice):
                    self.store("default")
                    stream, pending = io.StringIO(), PendingRequests()
                    agent = self.agent()
                    mark_trusted(agent.config, self.root)
                    agent.set_mode("plan", persist=not scoped)   # the editor's menu holds it; the terminal saves
                    agent.ui = HeadlessUI(Emitter(stream, validator=ep.event_error), pending, approval_timeout_s=5)

                    def frames():
                        return [json.loads(line) for line in stream.getvalue().splitlines() if line]

                    def answer():
                        deadline = time.monotonic() + 5
                        while time.monotonic() < deadline:
                            asked = [f for f in frames() if f["type"] == "plan_proposal"]
                            if asked:
                                self.assertTrue(pending.resolve(asked[0]["id"], {"decision": choice}))
                                return
                            time.sleep(0.01)
                        self.fail("no plan card")
                    self.assertIn(f"permission mode is now '{choice}'", run(agent, answer))
                    self.assertEqual(agent.mode, choice)
                    told = [f["mode"] for f in frames() if f["type"] == "mode_changed"]
                    self.assertEqual(told, [choice], "the editor kept showing plan")
                    if choice == "auto":
                        self.assertEqual(self.stored_mode(), "default", "auto was saved for every session")

        with self.subTest(surface="acp"):
            updates = []

            class Server:
                def notify(self, method, params):
                    updates.append(params["update"])

                def request(self, method, params, **kwargs):
                    return {"outcome": {"outcome": "selected", "optionId": "auto"}}
            agent = self.agent()
            mark_trusted(agent.config, self.root)
            agent.set_mode("plan")                               # ACP's session/set_mode
            agent.ui = _ACPUi(Server(), "s1", self.root)
            self.assertIn("permission mode is now 'auto'", run(agent, lambda: None))
            self.assertEqual([u["currentModeId"] for u in updates if u["sessionUpdate"] == "current_mode_update"],
                             ["auto"], "an ACP client kept showing plan")
            self.assertEqual(self.stored_mode(), "default")

        with self.subTest(surface="helper"):
            told = []

            class Recorder(_QuietUI):
                def present_plan(self, plan):
                    return "auto"

                def current_mode(self, mode):
                    told.append(mode)
            child = self.agent()
            mark_trusted(child.config, self.root)
            child.set_mode("plan", persist=False)
            child._parent_agent = self.agent()                   # a helper's mode is its own, never the chat's
            child.ui = Recorder()
            run(child, lambda: None)
            self.assertEqual(told, [])

    def test_a_terminal_plan_approved_into_accept_edits_is_saved_as_before(self):
        agent = self.agent()
        mark_trusted(agent.config, self.root)
        agent.set_mode("plan")
        self.approve_plan(agent, "acceptEdits")
        self.assertEqual((agent.mode, self.stored_mode()), ("acceptEdits", "acceptEdits"))

    def test_auto_comes_back_only_while_the_folder_is_trusted(self):
        path = self.saved_in("auto")
        self.store("auto")
        reopened = self.agent()
        reopened.config.data["mode"] = "auto"
        revoke_trust(reopened.config, self.root)
        reopened.load_session(path)
        self.assertEqual(reopened.mode, "default", "an untrusted folder reopened in auto")

    def test_a_session_saved_before_modes_were_recorded_keeps_the_current_mode(self):
        path = self.saved_in("plan")
        record = json.loads(path.read_text())
        record.pop("mode", None)
        path.write_text(json.dumps(record))
        reopened = self.agent()
        reopened.load_session(path)
        self.assertEqual(reopened.mode, "default")

    def test_the_editor_is_told_when_a_reopened_chat_changes_mode(self):
        from types import SimpleNamespace
        from dgc import headless
        path = self.saved_in("plan")
        backend = object.__new__(headless.Backend)
        events = []
        backend.em = SimpleNamespace(emit=lambda event_type, **fields: events.append({"type": event_type, **fields}))
        backend._busy = lambda: False
        backend.agent = self.agent()
        backend.config = backend.agent.config
        backend.workspace_trusted = True
        for name in ("_emit_history", "_emit_agents", "_emit_context", "_emit_goal", "_emit_monitors"):
            setattr(backend, name, lambda *args, **kwargs: None)
        backend._dispatch({"type": "resume_session", "path": path.name, "request_id": "r1"})
        changed = [e for e in events if e["type"] == "mode_changed"]
        self.assertEqual([e["mode"] for e in changed], ["plan"], events)


    def test_a_reopened_chats_mode_change_follows_its_replay(self):
        # Published SDK 0.6.9 drains a resume's replay until the first event it does not count as
        # replay. mode_changed was not one, and sent first it put the whole history, agents,
        # context and goal into the app's first stream(). It comes after them now.
        from types import SimpleNamespace
        from dgc import headless
        path = self.saved_in("plan")
        backend = object.__new__(headless.Backend)
        events = []
        backend.em = SimpleNamespace(emit=lambda event_type, **fields: events.append({"type": event_type, **fields}))
        backend._busy = lambda: False
        backend.agent = self.agent()
        backend.config = backend.agent.config
        backend.workspace_trusted = True
        for name, kind in (("_emit_history", "history"), ("_emit_agents", "agents"),
                           ("_emit_context", "context"), ("_emit_goal", "goal_changed"),
                           ("_emit_monitors", "monitors")):
            setattr(backend, name, lambda *args, _kind=kind, **kwargs: events.append({"type": _kind}))
        backend._dispatch({"type": "resume_session", "path": path.name, "request_id": "r1"})
        kinds = [event["type"] for event in events]
        self.assertIn("mode_changed", kinds, events)
        replay = {"history", "agents", "context", "goal_changed", "monitors"}
        self.assertGreater(kinds.index("mode_changed"), max(i for i, kind in enumerate(kinds) if kind in replay), kinds)
        # 0.48: only the prompt cache's clock follows it, a new event no older SDK counts as replay.
        self.assertEqual(kinds[kinds.index("mode_changed") + 1:], ["cache_clock"], kinds)

    def test_an_sdk_apps_session_runs_in_the_mode_the_app_asked_for(self):
        # SDK 0.6.9 cannot correct a mode a reopen restored (0.6.10 sends set_mode afterwards), so
        # an isolated SDK session takes its configured mode as named, the way `dgc --mode` does.
        import os
        from dgc import cli
        with patch.dict(os.environ, {"DGC_SDK_ISOLATED": "1"}):
            self.assertTrue(cli._serve_config().mode_explicit)
        with patch.dict(os.environ, {}):
            os.environ.pop("DGC_SDK_ISOLATED", None)
            self.assertFalse(cli._serve_config().mode_explicit,
                             "an editor's dgc serve still reopens chats in the mode they ran in")

    # ---- never more than the mode it replaces -------------------------------------------------

    def test_a_reopened_chat_never_asks_less_than_the_mode_it_replaces(self):
        for saved in ("acceptEdits", "auto"):
            with self.subTest(saved=saved):
                path = self.saved_in(saved)
                reopened = self.agent()
                reopened.load_session(path)
                self.assertEqual(reopened.mode, "default",
                                 f"a chat last run in {saved} reopened in it over the user's default")
                self.assertNotIn("mode", getattr(reopened.config, "_held_keys", set()),
                                 "nothing changed, so nothing is held")

    def test_auto_comes_back_when_auto_is_the_mode_it_replaces(self):
        path = self.saved_in("auto")
        self.store("auto")
        reopened = self.agent()
        reopened.load_session(path)
        self.assertEqual(reopened.mode, "auto")

    def test_a_mode_named_for_the_run_wins_both_ways(self):
        for named, saved in (("plan", "auto"), ("default", "auto"), ("auto", "plan")):
            with self.subTest(named=named, saved=saved):
                path = self.saved_in(saved)
                reopened = self.agent()
                mark_trusted(reopened.config, self.root)
                reopened.config.data["mode"] = named        # what `dgc --mode` does
                reopened.config.mode_explicit = True
                reopened.load_session(path)
                self.assertEqual(reopened.mode, named,
                                 f"--mode {named} ran in the {saved} the session was saved in")

    def test_the_cli_marks_a_mode_named_on_the_command_line(self):
        source = (Path(__file__).resolve().parents[1] / "dgc" / "cli.py").read_text()
        start = source.index("    if args.mode:\n        config.data[\"mode\"] = args.mode\n")
        self.assertIn("config.mode_explicit = True", source[start:start + 300])
        self.assertLess(start, source.index("    if args.cont:\n"),
                        "the mark must be in place before --continue reopens a session")
        self.assertFalse(Config.mode_explicit, "a mode nobody named is not explicit")

    def test_a_plan_approved_after_reopening_goes_no_further_than_the_mode_replaced(self):
        path = self.saved_in("plan")
        record = json.loads(path.read_text())
        record["plan_return_mode"] = "auto"
        path.write_text(json.dumps(record))
        reopened = self.agent()
        reopened.load_session(path)
        self.assertEqual((reopened.mode, reopened.plan_return_mode), ("plan", "default"))
        self.assertEqual(reopened.exit_plan(), "default")

    def test_a_second_reopen_measures_against_the_mode_the_first_replaced(self):
        planning, auto = self.saved_in("plan"), self.saved_in("auto")
        reopened = self.agent()
        reopened.load_session(planning)
        reopened.load_session(auto)
        self.assertEqual(reopened.mode, "default", "the second chat took the first one's plan")
        self.store("auto")
        again = self.agent()
        again.load_session(planning)
        again.load_session(auto)
        self.assertEqual(again.mode, "auto", "the first chat's plan capped the second")

    def test_the_tui_renames_a_session_mid_turn(self):
        from dgc.commands import resolve_command
        self.assertTrue(resolve_command("name", "tui").available_while_running,
                        "/name was refused mid-turn though renaming joins the running turn")

    # ---- a new chat ------------------------------------------------------------------------------

    def test_a_new_chat_goes_back_to_the_mode_the_reopened_one_replaced(self):
        path = self.saved_in("plan")
        self.store("auto")
        reopened = self.agent()
        reopened.load_session(path)
        self.assertEqual(reopened.mode, "plan")
        reopened.reset()
        self.assertEqual(reopened.mode, "auto", "the new chat kept the reopened chat's mode")
        self.assertNotIn("mode", reopened.config._held_keys)
        self.assertIn("# Permission mode: auto", reopened.messages[0]["content"],
                      "the new chat's prompt still names the reopened chat's mode")
        reopened.set_mode("acceptEdits")
        self.assertEqual(self.stored_mode(), "acceptEdits", "a choice after the new chat is not saved")

    def test_a_new_chat_keeps_an_untrusted_folders_hold(self):
        path = self.saved_in("plan", trusted=False)
        self.store("auto")
        reopened = self.agent()
        self.assertTrue(reopened.config.hold_untrusted_mode())
        reopened.load_session(path)
        self.assertEqual(reopened.mode, "plan")
        reopened.reset()
        self.assertEqual(reopened.mode, "default")
        reopened.config.set("thinking", "high")
        self.assertEqual(self.stored_mode(), "auto", "the untrusted folder's default was saved")

    def test_a_mode_chosen_after_reopening_survives_a_new_chat(self):
        path = self.saved_in("plan")
        self.store("auto")
        reopened = self.agent()
        reopened.load_session(path)
        reopened.set_mode("acceptEdits")
        reopened.reset()
        self.assertEqual(reopened.mode, "acceptEdits")

    def test_a_mode_chosen_after_reopening_is_what_the_next_reopen_measures_against(self):
        planning, auto = self.saved_in("plan"), self.saved_in("auto")
        reopened = self.agent()
        reopened.load_session(planning)
        reopened.set_mode("auto")
        reopened.load_session(auto)
        self.assertEqual(reopened.mode, "auto", "the chosen auto was measured as the old default")

    def test_a_mode_set_past_the_agent_survives_a_new_chat(self):
        path = self.saved_in("plan")
        self.store("auto")
        reopened = self.agent()
        reopened.load_session(path)
        reopened.config.set("mode", "acceptEdits")      # e.g. the provider picker
        reopened.reset()
        self.assertEqual(reopened.mode, "acceptEdits")

    def test_the_editor_is_told_when_a_new_chat_changes_mode(self):
        from types import SimpleNamespace
        from dgc import headless
        path = self.saved_in("plan")
        backend = object.__new__(headless.Backend)
        events = []
        backend.em = SimpleNamespace(emit=lambda event_type, **fields: events.append({"type": event_type, **fields}))
        backend._busy = lambda: False
        backend.agent = self.agent()
        backend.config = backend.agent.config
        backend.workspace_trusted = True
        for name in ("_emit_history", "_emit_agents", "_emit_context", "_emit_goal", "_emit_monitors"):
            setattr(backend, name, lambda *args, **kwargs: None)
        for kind in ("new_session", "clear_session"):
            with self.subTest(kind=kind):
                events.clear()
                backend._dispatch({"type": "resume_session", "path": path.name, "request_id": "r2"})
                backend._dispatch({"type": kind, "request_id": "r3"})
                changed = [e["mode"] for e in events if e["type"] == "mode_changed"]
                self.assertEqual(changed, ["plan", "default"], events)

    # ---- a held mode is never saved as the user's own -------------------------------------------

    def test_approving_a_reopened_plan_in_an_untrusted_folder_keeps_the_stored_mode(self):
        path = self.saved_in("plan", trusted=False)
        self.store("auto")
        reopened = self.agent()
        reopened.load_session(path)
        self.assertEqual(reopened.exit_plan("auto"), "default")
        self.assertEqual(reopened.mode, "default")
        reopened.config.set("thinking", "high")
        self.assertEqual(self.stored_mode(), "auto", "an untrusted plan approval saved default")

    def test_a_failed_save_leaves_a_held_mode_held(self):
        path = self.saved_in("plan")
        self.store("auto")
        reopened = self.agent()
        reopened.load_session(path)
        with patch.object(Config, "save", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                reopened.set_mode("default")
        self.assertEqual(reopened.mode, "plan")
        self.assertIn("mode", reopened.config._held_keys)
        reopened.config.set("thinking", "high")
        self.assertEqual(self.stored_mode(), "auto", "the held plan was saved as the user's mode")


    # ---- the person reopens it: the editor and the interactive terminal ---------------------------
    # The maintainer: "for a session if i set it to auto, and then close that session, and reopen, it should reopen in
    # Auto mode only." A chat the person reopens themselves (the editor's list, a Work tab after a window reload, a
    # closed chat opened again, `dgc --resume` / `--continue` / /resume at the terminal) comes back in the mode it had,
    # even one that asks less than the default. Lower only stays for `dgc -p`, the SDK and ACP.

    def editor_backend(self, agent=None):
        """A Backend as `dgc serve` dispatches the editor's commands to it, recording what it emits."""
        from types import SimpleNamespace
        from dgc import headless
        backend = object.__new__(headless.Backend)
        events = []
        backend.em = SimpleNamespace(emit=lambda event_type, **fields: events.append({"type": event_type, **fields}))
        backend._busy = lambda: False
        backend.agent = agent or self.agent()
        backend.config = backend.agent.config
        from dgc.trust import is_trusted
        backend.workspace_trusted = is_trusted(backend.config, self.root)
        for name, kind in (("_emit_history", "history"), ("_emit_agents", "agents"),
                           ("_emit_context", "context"), ("_emit_goal", "goal_changed"),
                           ("_emit_monitors", "monitors")):
            setattr(backend, name, lambda *args, _kind=kind, **kwargs: events.append({"type": _kind}))
        return backend, events

    def test_a_chat_the_editor_reopens_comes_back_in_auto_over_a_default(self):
        # Fails on 5d18f4ba: a chat set to Auto, closed and reopened from the list came back in Default.
        path = self.saved_in("auto")
        backend, events = self.editor_backend()
        self.assertEqual(backend.agent.mode, "default", "premise: the default is Default")
        backend._dispatch({"type": "resume_session", "path": path.name, "saved_mode": True, "request_id": "r1"})
        self.assertEqual(backend.agent.mode, "auto", "the chat set to Auto reopened in Default")
        self.assertEqual([e["mode"] for e in events if e["type"] == "mode_changed"], ["auto"],
                         "the mode chip was not told at once")
        self.assertFalse(any(e["type"] == "info" for e in events), "no note when the mode came back as it was")
        backend.agent.config.set("thinking", "high")                       # any later save
        self.assertEqual(self.stored_mode(), "default", "reopening wrote the chat's Auto into config.json")
        self.assertIn("mode", backend.agent.config._held_keys, "held for that chat")

    def test_every_mode_comes_back_as_it_was_whatever_the_default(self):
        for stored in ("default", "acceptEdits", "plan", "auto"):
            for saved in ("default", "acceptEdits", "plan", "auto"):
                with self.subTest(stored=stored, saved=saved):
                    path = self.saved_in(saved)
                    self.store(stored)
                    reopened = self.agent()
                    reopened.load_session(path, saved_mode=True)
                    self.assertEqual(reopened.mode, saved, f"saved in {saved}, the default {stored}")
                    self.assertEqual(reopened.take_mode_restore_note(), "")
                    reopened.reset()                                       # New chat
                    self.assertEqual(reopened.mode, stored, "a new chat kept the reopened chat's mode")
                    self.assertIn(f"# Permission mode: {stored}", reopened.messages[0]["content"])
                    self.assertEqual(self.stored_mode(), stored, "the default was rewritten")

    def test_the_sdk_and_an_older_editor_still_only_lower_it(self):
        # No saved_mode: an SDK app's resume, or an editor that doesn't send it. A transcript saved in Auto never runs
        # an app in more autonomy than the mode it asked for.
        path = self.saved_in("auto")
        backend, events = self.editor_backend()
        backend._dispatch({"type": "resume_session", "path": path.name, "request_id": "r1"})
        self.assertEqual(backend.agent.mode, "default")
        self.assertFalse([e for e in events if e["type"] == "mode_changed"], events)
        reopened = self.agent()
        reopened.load_session(path)
        self.assertEqual(reopened.mode, "default")
        planning = self.saved_in("plan")
        reopened.load_session(planning)
        self.assertEqual(reopened.mode, "plan", "lowering still brings a plan back")

    def test_acp_still_only_lowers_it(self):
        from dgc import acp
        source = Path(acp.__file__).read_text()
        self.assertIn("agent.load_session(path)\n", source)
        self.assertNotIn("saved_mode", source, "an ACP client's reopen brings back no more than the mode it asked for")

    def test_never_over_a_mode_named_for_the_run(self):
        for named, saved in (("plan", "auto"), ("default", "auto"), ("auto", "plan"), ("acceptEdits", "default")):
            with self.subTest(named=named, saved=saved):
                path = self.saved_in(saved)
                reopened = self.agent()
                mark_trusted(reopened.config, self.root)
                reopened.config.data["mode"] = named                       # `dgc --mode`, an isolated SDK session
                reopened.config.mode_explicit = True
                reopened.load_session(path, saved_mode=True)
                self.assertEqual(reopened.mode, named)

    def test_an_untrusted_folder_reopens_in_default_and_says_so_once(self):
        for saved, label in (("auto", "Auto"), ("acceptEdits", "Accept edits")):
            with self.subTest(saved=saved):
                path = self.saved_in(saved)
                backend, events = self.editor_backend()
                revoke_trust(backend.config, self.root)
                backend.workspace_trusted = False
                backend._dispatch({"type": "resume_session", "path": path.name, "saved_mode": True,
                                   "request_id": "r1"})
                self.assertEqual(backend.agent.mode, "default", f"an untrusted folder reopened in {saved}")
                notes = [e["message"] for e in events if e["type"] == "info"]
                self.assertEqual(len(notes), 1, events)
                self.assertEqual(notes[0], f"This chat ran in {label}. This folder is not trusted now, so it "
                                           "reopened in Default, which asks before each change.")
                kinds = [e["type"] for e in events]
                self.assertGreater(kinds.index("info"), kinds.index("history"), "said where the chat shows it")
                self.assertEqual(backend.agent.take_mode_restore_note(), "", "said once")

    def test_a_trusted_reopen_after_an_untrusted_one_has_no_note(self):
        path = self.saved_in("auto")
        reopened = self.agent()
        revoke_trust(reopened.config, self.root)
        reopened.load_session(path, saved_mode=True)
        mark_trusted(reopened.config, self.root)
        reopened.load_session(path, saved_mode=True)
        self.assertEqual(reopened.mode, "auto")
        self.assertEqual(reopened.take_mode_restore_note(), "", "a stale note from the earlier reopen")

    def test_only_a_mode_the_subscription_engine_supports(self):
        # Kimi always approves tools, so DGC runs it only in auto: a chat saved in plan keeps auto.
        path = self.saved_in("plan")
        reopened = self.agent()
        mark_trusted(reopened.config, self.root)
        reopened.config.data["subscription_engine"] = "kimi"
        reopened.config.data["mode"] = "auto"
        reopened.load_session(path, saved_mode=True)
        self.assertEqual(reopened.mode, "auto")

    def test_a_reopened_plan_keeps_its_way_back(self):
        path = self.saved_in("plan")
        record = json.loads(path.read_text())
        record["plan_return_mode"] = "auto"
        path.write_text(json.dumps(record))
        reopened = self.agent()
        reopened.load_session(path, saved_mode=True)
        self.assertEqual((reopened.mode, reopened.plan_return_mode), ("plan", "auto"))
        revoke_trust(reopened.config, self.root)
        self.assertEqual(reopened.exit_plan(), "default", "approving it still re-checks trust")

    def test_reopening_another_chat_from_the_list_takes_that_chats_mode(self):
        # One tab, chats opened from the list one after another: each in its own mode, and New chat in the default.
        auto, plan, default = self.saved_in("auto"), self.saved_in("plan"), self.saved_in("default")
        backend, events = self.editor_backend()
        backend._dispatch({"type": "set_mode", "mode": "acceptEdits", "request_id": "m1"})   # chosen for this chat
        for path, mode in ((auto, "auto"), (plan, "plan"), (default, "default"), (auto, "auto")):
            backend._dispatch({"type": "resume_session", "path": path.name, "saved_mode": True, "request_id": "r"})
            self.assertEqual(backend.agent.mode, mode)
        backend._dispatch({"type": "new_session", "request_id": "n1"})
        self.assertEqual(backend.agent.mode, "default")
        self.assertEqual(self.stored_mode(), "default")

    def test_a_helper_never_runs_above_its_reopened_chat(self):
        # The terminal's saved default is Auto; the person reopens a chat they ran in Default. Its helper's config is a
        # copy of the chat's, and it follows the chat's mode as it is now (b26e074a): Default, never the stored Auto.
        path = self.saved_in("default")
        self.store("auto")
        chat = self.agent()
        mark_trusted(chat.config, self.root)
        chat.load_session(path, saved_mode=True)
        self.assertEqual(chat.mode, "default")
        helper = Agent(chat.config.clone_for_root(self.root), _QuietUI())
        self.addCleanup(helper.mcp.stop_all)
        helper.config.data["mode"] = "auto"             # a copy made before the reopen, at its worst
        helper._parent_agent = chat
        helper.depth = 1
        self.assertEqual(helper.mode, "default", "a helper ran above its chat")
        helper.load_session(self.saved_in("auto"), saved_mode=True)
        self.assertEqual(helper.mode, "default", "a helper restored a mode of its own")

    def test_the_interactive_terminal_reopens_it_as_saved_and_dgc_p_does_not(self):
        from dgc import cli
        path = self.saved_in("auto")
        seen = {}

        def repl(this):
            seen["mode"] = this.agent.mode
        for flags, person, expected in ((["--continue"], True, "auto"), (["--resume", path.stem], True, "auto"),
                                        (["--continue"], False, "default")):
            with self.subTest(flags=flags, person=person):
                seen.clear()
                with patch.object(cli, "_stdin_is_terminal", return_value=person), \
                        patch.object(cli.CLI, "repl", repl), \
                        patch.object(cli.CLI, "_check_owner", lambda this, **kw: None), \
                        patch.object(cli, "refresh_update_async", lambda: None), \
                        patch("dgc.termbg.apply", lambda config: None), patch("os.getcwd", return_value=str(self.root)):
                    cli.main([*flags, "--classic"])
                self.assertEqual(seen.get("mode"), expected, f"dgc {' '.join(flags)} (a person: {person})")
                self.assertEqual(self.stored_mode(), "default")
        source = (Path(cli.__file__)).read_text()
        start = source.index("    person_reopens = args.prompt is None and _stdin_is_terminal()\n")
        self.assertLess(start, source.index("    if args.cont:\n"))
        self.assertEqual(source.count("load_session(p, saved_mode=person_reopens)"), 2)

    def test_the_tui_reopens_what_the_person_picks_in_its_own_mode(self):
        source = (Path(__file__).resolve().parents[1] / "dgc" / "tui.py").read_text()
        calls = [line.strip() for line in source.splitlines() if ".load_session(" in line]
        self.assertTrue(calls)
        for line in calls:
            self.assertIn("saved_mode=True", line, line)
        self.assertIn("take_mode_restore_note", source, "the full screen never says the folder lost its trust")


if __name__ == "__main__":
    unittest.main()
