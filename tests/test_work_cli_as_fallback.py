"""A Work session whose fallback is Claude Code or Codex (D14, 9 Nov; fallback on every surface, part E): when its own
model (DGC's) fails, the CLI takes the turn with the whole chat (the prompt once), its answer joins the chat marked as the
fallback's, the prompt box shows it in olive and Trace keeps the change; each turn tries its own model first. A session on
Codex can have Claude Code as its fallback the same way (and Codex, back, is told what it missed). The fallback is kept
with the session and never names the CLI that is its main."""
import json
import sys
import types
import unittest
from unittest import mock

from dgc import config as config_mod, headless, sessions, subscriptions
from tests import test_model_retry as retry
from tests import test_server_window as window
from tests import test_work_cli_fallback as cli_fallback

closed_port, stall = retry.closed_port, retry.stall
OK = cli_fallback.OK
LIMIT = cli_fallback.LIMIT
OK_TOOL = cli_fallback.OK_TOOL


class _Told(retry._Recorder):
    def __init__(self):
        super().__init__()
        self.fallbacks, self.handed = [], []

    def model_fallback(self, model, active):
        self.fallbacks.append((model, active))

    def trace_handed_over(self, why, to, last_round=False):
        self.handed.append((why, to, last_round))


def fixture_engine(key, short_label, out, sent):
    """A stand-in CLI: prints ``out`` (Codex's JSON lines) and records what it was given."""
    script = f"import sys\nsys.stdout.write({out!r})\nsys.stdout.flush()\n"
    return types.SimpleNamespace(key=key, label=f"{short_label} (fixture)", short_label=short_label, stream="codex",
                                 supports_effort=lambda: False,
                                 build_argv=lambda binary, prompt, **k: (sent.append((prompt, k.get("session_id", ""), k.get("model", ""))),
                                                                         [sys.executable, "-c", script])[1])


class ItsOwnModelOut(retry.RetryTestCase):
    def test_its_own_model_out_claude_code_takes_the_turn_with_the_whole_chat_and_each_turn_tries_its_own_first(self):
        self.server.behaviours["/chat/completions"] = stall.chat_answer("There is one file, app.py.")
        agent, ui = self.agent(_Told())
        self.assertTrue(agent.run_turn("What is in src?", reset_cancel=False))
        agent.config.data.update({"base_url": f"http://127.0.0.1:{closed_port()}/v1", "fallback_engine": "claude"})
        agent.refresh_client()
        sent = []
        claude = fixture_engine("claude", "Claude Code", OK, sent)
        with mock.patch.object(subscriptions, "get_engine", lambda key: claude if key == "claude" else None), \
                mock.patch.object(subscriptions, "preflight", return_value=sys.executable):
            self.assertTrue(agent.run_turn("Now add a README.", reset_cancel=False))
            prompt, session, _ = sent[-1]
            self.assertEqual(session, "", "a fresh CLI session: it is told the chat, not resumed")
            self.assertIn("What is in src?", prompt, "the whole chat, so it doesn't start blind")
            self.assertIn("There is one file, app.py.", prompt)
            self.assertEqual(prompt.count("Now add a README."), 1, "your message once")
            asked = [m for m in agent.messages if m.get("role") == "user" and "Now add a README." in str(m.get("content"))]
            self.assertEqual(len(asked), 1, "kept once in the chat")
            answered = [m for m in agent.messages if m.get("role") == "assistant"][-1]
            self.assertEqual(answered.get("content"), "Back, and caught up.")
            self.assertEqual(answered.get("_dgc_fallback"), "Claude Code")
            self.assertIn("Back, and caught up.", "".join(ui.text), "its answer streams as any answer does")
            self.assertEqual(ui.fallbacks, [("Claude Code", True)], "the prompt box shows Claude Code answering")
            self.assertEqual(ui.handed[-1][1], "Claude Code")
            self.assertTrue(ui.handed[-1][0].startswith("retry-model didn't answer: "), ui.handed)
            self.assertEqual([line for line in ui.infos if "⤳" in line], ["⤳ primary model failed; falling back to Claude Code"])
            self.assertEqual(ui.errors, [])
            # Still out: the next turn tries its own model first, then Claude Code, and says nothing more.
            self.assertTrue(agent.run_turn("And a licence.", reset_cancel=False))
            self.assertEqual(len(sent), 2)
            self.assertIn("Back, and caught up.", sent[-1][0], "what it answered before is part of the chat it is told")
            self.assertEqual(len([line for line in ui.infos if "⤳" in line]), 1, "said once an outage")
            self.assertEqual(len(ui.handed), 2, "but its Trace keeps every change")
        # Its own model back: it answers, reading what Claude Code said, and the prompt box is normal again.
        agent.config.data["base_url"] = self.server.url + "/v1"
        self.assertTrue(agent.run_turn("Thanks.", reset_cancel=False))
        self.assertEqual(ui.fallbacks[-1], ("", False))
        body = json.dumps(self.server.chat_posts("/chat/completions")[-1]["body"])
        self.assertIn("Back, and caught up.", body)

    def test_claude_code_out_too_the_turn_fails_saying_both(self):
        agent, ui = self.agent(_Told(), base_url=f"http://127.0.0.1:{closed_port()}/v1", fallback_engine="claude")
        sent = []
        claude = fixture_engine("claude", "Claude Code", LIMIT, sent)
        with mock.patch.object(subscriptions, "get_engine", lambda key: claude if key == "claude" else None), \
                mock.patch.object(subscriptions, "preflight", return_value=sys.executable):
            self.assertFalse(agent.run_turn("Hello?", reset_cancel=False))
        self.assertTrue(ui.errors, "says what went wrong")
        self.assertIn("Claude Code", ui.errors[-1][0])
        self.assertIn("usage limit", ui.errors[-1][0])

    def test_signed_out_it_fails_saying_so_and_a_helper_never_hands_over(self):
        agent, ui = self.agent(_Told(), base_url=f"http://127.0.0.1:{closed_port()}/v1", fallback_engine="codex")

        def signed_out(engine):
            raise subscriptions.EngineNotAuthenticated("Codex is not signed in — run: codex login")
        codex = fixture_engine("codex", "Codex", OK, [])
        with mock.patch.object(subscriptions, "get_engine", lambda key: codex if key == "codex" else None), \
                mock.patch.object(subscriptions, "preflight", signed_out):
            self.assertFalse(agent.run_turn("Hello?", reset_cancel=False))
        self.assertIn("not signed in", ui.errors[-1][0])


class AnotherCliAsFallback(unittest.TestCase):
    """A session on Codex whose fallback is Claude Code."""
    engine = cli_fallback.CliFallback.engine
    cli = cli_fallback.CliFallback.cli

    def setUp(self):
        cli_fallback.CliFallback.setUp(self)
        self.cfg.data.update({"fallback_model": "", "fallback_engine": "claude"})
        self.claude_sent = []

    def claude(self, out):
        engine = fixture_engine("claude", "Claude Code", out, self.claude_sent)
        return mock.patch.object(subscriptions, "get_engine", lambda key: engine if key == "claude" else None)

    def test_codex_out_claude_code_takes_the_turn_with_the_whole_chat_and_codex_back_is_told_what_it_missed(self):
        self.assertTrue(self.cli(OK_TOOL, "What is in src?"))
        with self.claude(OK):
            self.assertTrue(self.cli(LIMIT, "Now add a README."))
        self.assertEqual(self.asked, [], "DGC's own model wasn't asked")
        prompt, session, model = self.claude_sent[-1]
        self.assertEqual((session, model), ("", ""), "a fresh session of Claude Code, on its own default model")
        self.assertIn("What is in src?", prompt, "the whole chat")
        self.assertIn("shell: ls src", prompt, "and what Codex did with its tools")
        self.assertEqual(prompt.count("Now add a README."), 1)
        asked = [m for m in self.agent_obj.messages if m.get("role") == "user" and "Now add a README." in str(m.get("content"))]
        self.assertEqual(len(asked), 1, "your message once in the chat")
        answered = [m for m in self.agent_obj.messages if m.get("role") == "assistant"][-1]
        self.assertEqual(answered.get("_dgc_fallback"), "Claude Code")
        self.assertEqual(self.ui.fallbacks, [("Claude Code", True)])
        self.assertEqual(self.ui.handed[-1][1], "Claude Code")
        self.assertIn("usage limit", self.ui.handed[-1][0])
        self.assertTrue(self.ui.last_round, "its Trace marks Codex's round as the failed try")
        self.assertNotIn("claude", self.agent_obj.subscription_sessions, "Claude Code's run isn't this chat's own session")
        # Codex back, on its own session: told what Claude Code answered, once; the prompt box normal again.
        self.assertTrue(self.cli(OK, "Thanks."))
        prompt, session = self.sent[-1]
        self.assertEqual(session, "th_1")
        self.assertIn("Claude Code answered", prompt)
        self.assertIn("Back, and caught up.", prompt)
        self.assertEqual(self.ui.fallbacks[-1], ("", False))

    def test_a_cli_out_its_other_cli_answers_and_the_trace_is_kept_with_the_answer(self):
        ui = _traced_ui()
        self.agent_obj.ui = ui
        with self.claude(OK):
            ui.begin_turn_trace()
            self.assertTrue(subscriptions.run_cli_turn(self.cfg, self.agent_obj, ui, self.engine(LIMIT), "Hello?"))
        models = [step for step in _trace_of(self.agent_obj).get("steps", []) if step.get("kind") == "model"]
        self.assertTrue(models and models[0].get("error") and models[0].get("to") == "Claude Code", models)
        self.assertIn("usage limit", models[0].get("detail", ""))
        self.assertEqual(models[-1].get("label"), "model.response · fallback")

    def test_a_cli_turn_keeps_its_trace_with_its_answer_too(self):
        ui = _traced_ui()
        self.agent_obj.ui = ui
        ui.begin_turn_trace()
        self.assertTrue(subscriptions.run_cli_turn(self.cfg, self.agent_obj, ui, self.engine(OK_TOOL), "What is in src?"))
        steps = _trace_of(self.agent_obj).get("steps", [])
        self.assertTrue([step for step in steps if step.get("kind") == "model"], steps)

    def test_the_cli_that_is_its_main_is_never_its_fallback(self):
        self.cfg.data["fallback_engine"] = "codex"
        self.assertFalse(self.cli(LIMIT, "Hello?"))
        self.assertEqual(self.ui.fallbacks, [])

    def test_claude_code_out_too_it_fails_saying_so(self):
        with self.claude(LIMIT):
            self.assertFalse(self.cli(LIMIT, "Hello?"))
        self.assertIn("Claude Code", self.ui.errors[-1][0])


def _traced_ui():
    """The editor host's own UI, which records the turn's Trace as the editor does (begin_turn_trace per turn)."""
    import io
    from dgc.protocol import Emitter
    ui = headless.HeadlessUI(Emitter(io.StringIO()), None)
    ui.turn_id = "t1"
    return ui


def _trace_of(agent):
    answered = [m for m in agent.messages if m.get("role") == "assistant"][-1]
    return answered.get("_dgc_turn_trace") or {}


class TraceKeepsIt(retry.RetryTestCase):
    def test_its_own_model_out_the_trace_keeps_the_failed_try_then_the_clis_round_as_the_fallbacks(self):
        agent, _ = self.agent(_traced_ui(), base_url=f"http://127.0.0.1:{closed_port()}/v1", fallback_engine="codex")
        codex = fixture_engine("codex", "Codex", OK, [])
        with mock.patch.object(subscriptions, "get_engine", lambda key: codex if key == "codex" else None), \
                mock.patch.object(subscriptions, "preflight", return_value=sys.executable):
            agent.ui.begin_turn_trace()
            self.assertTrue(agent.run_turn("Hello?", reset_cancel=False))
        models = [step for step in _trace_of(agent).get("steps", []) if step.get("kind") == "model"]
        self.assertTrue(models and models[0].get("error") and models[0].get("to") == "Codex", models)
        self.assertEqual(models[-1].get("label"), "model.response · fallback", "Codex's answer is a round of its own")
        self.assertFalse(models[-1].get("error"))


class KeptWithTheSession(window.IsolatedHome):
    host = window.TheEditorIsTold.host
    frames = window.TheEditorIsTold.frames

    def test_a_cli_fallback_is_this_sessions_own_kept_with_it_and_told_to_the_editor(self):
        host = self.host(model="qwen2.5-0.5b", base_url=self.server.url + "/v1", fallback_model="glm-default")
        config = host.default.config
        host.dispatch({"type": "set_config", "scope": "session", "request_id": "fb", "values": {
            "fallback_engine": "claude", "fallback_model": "", "fallback_base_url": "", "fallback_api_mode": "",
            "fallback_api_key": ""}})
        self.assertFalse([f for f in self.frames("command_rejected") if f.get("request_id") == "fb"], self.frames("command_rejected"))
        self.assertEqual((config.get("fallback_engine"), config.get("fallback_model")), ("claude", ""))
        host.dispatch({"type": "set_config", "scope": "session", "request_id": "bad", "values": {"fallback_engine": "gemini"}})
        self.assertTrue([f for f in self.frames("command_rejected") if f.get("request_id") == "bad"], "only Claude Code or Codex")
        host.dispatch({"type": "get_config", "request_id": "cfg", "fields": ["fallback_engine"]})
        said = [f for f in self.frames("config") if f.get("request_id") == "cfg"][-1]
        self.assertEqual(said.get("fallback_engine"), "claude", "the editor, asking, is told (an opt-in field)")
        host.dispatch({"type": "get_config", "request_id": "plain"})
        self.assertEqual([f for f in self.frames("config") if f.get("request_id") == "plain"][-1].get("fallback_engine"), "claude",
                         "asked once, told from then on")
        saved = host.default.agent.session_file
        host.default.agent._persist()
        record = json.loads(saved.read_text())
        self.assertEqual(record["fallback_route"], {"model": "", "base_url": "", "api_mode": "", "engine": "claude"})
        host.dispatch({"type": "new_session", "request_id": "fresh"})
        self.assertEqual((config.get("fallback_engine"), config.get("fallback_model")), ("", "glm-default"),
                         "a new session starts from the one in Settings")
        host.dispatch({"type": "resume_session", "path": str(saved), "saved_mode": True, "request_id": "back"})
        self.assertEqual((config.get("fallback_engine"), config.get("fallback_model")), ("claude", ""))

    def test_the_saved_route_takes_only_claude_code_or_codex(self):
        base = {"model": "", "base_url": "", "api_mode": ""}
        self.assertEqual(sessions._clean_fallback_route({**base, "engine": "codex"}), {**base, "engine": "codex"})
        self.assertEqual(sessions._clean_fallback_route(dict(base)), {**base, "engine": ""}, "a file from before keeps working")
        self.assertIsNone(sessions._clean_fallback_route({**base, "engine": "gemini"}))
        self.assertIn("fallback_engine", config_mod.DEFAULTS)
        self.assertIn("fallback_engine", headless._CONFIG_OPT_IN_FIELDS)


if __name__ == "__main__":
    unittest.main()
