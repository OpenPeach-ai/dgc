"""A reopened session comes back in the mode it ran in, when that asks no less than the mode it
replaces.

Mode is per chat -- a risky refactor sits in default while a scratch chat runs auto -- so it belongs
to the conversation, the way Codex keeps it per thread. Reopening is re-checked rather than trusted
from the file, never rewrites the user's own default, never overrides a mode named for the run, and
never raises the mode: a session last run in auto, reopened by `dgc -p --mode plan --continue`,
ran in auto.
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


if __name__ == "__main__":
    unittest.main()
