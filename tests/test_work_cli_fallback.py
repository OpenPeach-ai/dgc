"""A Work session on Claude Code or Codex with a fallback model (D14, 9 Nov; fallback on every surface, part D): when the
CLI fails before it wrote or did anything, the fallback takes the turn on DGC's own model with the whole chat (the
prompt once), and the CLI's tool steps, which DGC kept, are part of what the fallback reads; when the CLI is back it is
first told what it missed (the fallback's turns and the files it changed), or given the whole chat when its own session
is gone. A CLI turn that already wrote or did something is never redone."""
import json
import sys
import types
import unittest
from unittest import mock

from tests import test_model_retry as retry
from dgc import subscriptions

OK_TOOL = "\n".join(json.dumps(line) for line in (
    {"type": "thread.started", "thread_id": "th_1"},
    {"type": "item.started", "item": {"id": "c1", "type": "command_execution", "command": "ls src"}},
    {"type": "item.completed", "item": {"id": "c1", "type": "command_execution", "aggregated_output": "app.py", "exit_code": 0}},
    {"type": "item.completed", "item": {"id": "m1", "type": "agent_message", "text": "There is one file, app.py."}},
    {"type": "turn.completed", "usage": {"input_tokens": 5, "output_tokens": 5}})) + "\n"
LIMIT = "\n".join(json.dumps(line) for line in (
    {"type": "thread.started", "thread_id": "th_1"},
    {"type": "turn.failed", "error": {"message": "You've hit your usage limit. It resets at 3pm."}})) + "\n"
SAID_THEN_FAILED = "\n".join(json.dumps(line) for line in (
    {"type": "item.completed", "item": {"id": "m1", "type": "agent_message", "text": "Looking now."}},
    {"type": "turn.failed", "error": {"message": "stream cut"}})) + "\n"
OK = "\n".join(json.dumps(line) for line in (
    {"type": "thread.started", "thread_id": "th_1"},
    {"type": "item.completed", "item": {"id": "m2", "type": "agent_message", "text": "Back, and caught up."}},
    {"type": "turn.completed", "usage": {"input_tokens": 5, "output_tokens": 5}})) + "\n"


class _Told(retry._Recorder):
    def __init__(self):
        super().__init__()
        self.fallbacks, self.handed = [], []

    def model_fallback(self, model, active):
        self.fallbacks.append((model, active))

    def trace_handed_over(self, why, to, last_round=False):
        self.handed.append((why, to))
        self.last_round = last_round


class CliFallback(unittest.TestCase):
    def setUp(self):
        self.agent_obj, _, self.cfg = retry.EngineRetryTests.agent(self)
        self.ui = _Told()
        self.agent_obj.ui = self.ui
        self.cfg.data.update({"fallback_model": "backup", "subscription_engine": "codex"})
        self.sent = []                         # what each CLI run was given: (prompt, session id)
        patcher = mock.patch.object(subscriptions, "preflight", return_value=sys.executable)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.asked = []                        # what DGC's own model (the fallback) was sent

        def chat(client, messages, tools=None, on_text=None, **kwargs):
            from dgc.llm import ChatResult
            self.asked.append((client.model, [dict(m) for m in messages]))
            if on_text:
                on_text("Done on the fallback.")
            return ChatResult(content="Done on the fallback.")
        patcher = mock.patch("dgc.llm.LLMClient.chat", chat)
        patcher.start()
        self.addCleanup(patcher.stop)

    def engine(self, out):
        script = f"import sys\nsys.stdout.write({out!r})\nsys.stdout.flush()\n"
        return types.SimpleNamespace(key="codex", label="Codex (fixture)", short_label="Codex", stream="codex",
                                     supports_effort=lambda: False,
                                     build_argv=lambda binary, prompt, **k: (self.sent.append((prompt, k.get("session_id", ""))),
                                                                             [sys.executable, "-c", script])[1])

    def cli(self, out, prompt):
        return subscriptions.run_cli_turn(self.cfg, self.agent_obj, self.ui, self.engine(out), prompt)

    def test_the_cli_out_before_anything_the_fallback_takes_the_turn_with_the_whole_chat_and_the_cli_catches_up(self):
        self.assertTrue(self.cli(OK_TOOL, "What is in src?"))
        kept = [m for m in self.agent_obj.messages if m.get("role") == "assistant"][-1]
        self.assertIn("shell: ls src", kept.get("_dgc_cli_steps", ""), "DGC keeps the CLI's tool steps")
        # Codex at its usage limit before it wrote or did anything: the fallback takes the whole turn.
        self.assertTrue(self.cli(LIMIT, "Now add a README."))
        model, messages = self.asked[-1]
        self.assertEqual(model, "backup")
        users = [str(m.get("content")) for m in messages if m.get("role") == "user"]
        self.assertEqual(sum("Now add a README." in u for u in users), 1, "your message once, not twice")
        self.assertTrue(any("What is in src?" in u for u in users), "the whole chat, so it doesn't start blind")
        said = " ".join(str(m.get("content")) for m in messages if m.get("role") == "assistant")
        self.assertIn("shell: ls src", said, "and what the CLI did with its tools")
        self.assertEqual(self.ui.fallbacks, [("backup", True)])
        self.assertTrue(self.ui.handed and self.ui.handed[-1][1] == "backup")
        self.assertIn("usage limit", self.ui.handed[-1][0])
        self.assertTrue(self.ui.last_round, "its Trace marks the CLI's own round as the failed try")
        answered = [m for m in self.agent_obj.messages if m.get("role") == "assistant"][-1]
        self.assertEqual(answered.get("_dgc_fallback"), "backup")
        # Codex back, on its own session: first told what it missed, once.
        self.assertTrue(self.cli(OK, "Thanks. Anything else?"))
        prompt, session = self.sent[-1]
        self.assertEqual(session, "th_1", "its own session resumes")
        self.assertIn("backup answered", prompt)
        self.assertIn("Now add a README.", prompt)
        self.assertIn("Done on the fallback.", prompt)
        self.assertLess(prompt.index("backup answered"), prompt.index("Thanks. Anything else?"), "told first, then asked")
        self.assertEqual(self.ui.fallbacks[-1], ("", False), "its own model answered: the prompt box is normal again")
        self.assertTrue(self.cli(OK, "One more."))
        self.assertNotIn("answered", self.sent[-1][0], "said once")

    def test_its_own_session_gone_the_cli_is_given_the_whole_chat(self):
        self.assertTrue(self.cli(OK_TOOL, "What is in src?"))
        self.assertTrue(self.cli(LIMIT, "Now add a README."))
        self.agent_obj.subscription_sessions = {}            # its session is gone (signed out and back, a new model)
        self.assertTrue(self.cli(OK, "Thanks."))
        prompt, session = self.sent[-1]
        self.assertEqual(session, "")
        self.assertIn("What is in src?", prompt, "the whole chat, not only what it missed")
        self.assertIn("Now add a README.", prompt)

    def test_a_cli_turn_that_already_wrote_is_never_redone_and_none_set_fails_as_before(self):
        self.assertFalse(self.cli(SAID_THEN_FAILED, "Check the build."))
        self.assertEqual(self.asked, [], "what it said stands; a second go could repeat it")
        self.cfg.data["fallback_model"] = ""
        self.assertFalse(self.cli(LIMIT, "Again."))
        self.assertEqual(self.asked, [])


if __name__ == "__main__":
    unittest.main()
