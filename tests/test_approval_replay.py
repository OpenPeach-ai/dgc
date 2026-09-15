"""An explicit decision survives save/reopen without becoming an executable approval."""
import json
import unittest
from unittest.mock import patch
from tests import test_todo_lifecycle as fixtures
from dgc.llm import ChatResult, ToolCall


class ApprovalReplayTests(unittest.TestCase):
    setUp = fixtures.TodoLifecycleTests.setUp
    script = staticmethod(fixtures.TodoLifecycleTests.script)

    def run_decision(self, verdict, *, text_protocol=False, decide=None, save_rule=None):
        self.agent.config.data["mode"] = "default"
        self.ui.approve = decide or (lambda *args: verdict)
        self.ui.add_permission_rule = save_rule or (lambda *args: "Write(a.txt)")
        self.ui.deny_reason = "Keep the existing fixture"
        denied = []
        self.ui.tool_denied = lambda *args: denied.append(args)
        (self.root / "a.txt").write_text("original")
        call_id = "textcall_approval" if text_protocol else "approval"
        chat, _ = self.script(ChatResult(tool_calls=[ToolCall(call_id, "write_file",
                              {"path": "a.txt", "content": "changed"})]),
                              ChatResult(content="Finished."))
        with patch.object(self.agent.client, "chat", side_effect=chat):
            self.assertTrue(self.agent.run_turn("Change the scratch file."))
        saved = self.agent.session_file
        self.assertTrue(self.agent.load_session(saved))
        return self.backend._history(), denied

    def test_deny_with_note_is_saved_and_replayed_without_running_the_edit(self):
        history, denied = self.run_decision("no")
        self.assertEqual((self.root / "a.txt").read_text(), "original")
        self.assertEqual(len(denied), 1)
        cards = [i for i in history if i["type"] == "permission_decision"]
        self.assertEqual(len(cards), 1)
        self.assertEqual(cards[0]["decision"], "no")
        self.assertIn("Keep the existing fixture", cards[0]["message"])
        self.assertEqual(len([i for i in history if i["type"] == "tool_denied"]), 1)
        self.assertFalse(any(i["type"] == "tool_result" for i in history),
                         "a denied edit must never replay as a successful mutation")

    def test_allow_once_is_replayed_as_allowed_once(self):
        history, _ = self.run_decision("once")
        self.assertEqual((self.root / "a.txt").read_text(), "changed")
        self.assertEqual([i["message"] for i in history if i["type"] == "permission_decision"], ["Allowed once"])

    def test_always_allowed_keeps_its_rule(self):
        history, _ = self.run_decision("always")
        decision = next(i for i in history if i["type"] == "permission_decision")
        self.assertIn("Always allowed", decision["message"])
        self.assertIn("a.txt", decision["message"])

    def test_custom_saved_rule_is_the_one_replayed(self):
        history, _ = self.run_decision("always", save_rule=lambda *args: "Write(fixtures/**)")
        decision = next(i for i in history if i["type"] == "permission_decision")
        self.assertIn("Write(fixtures/**)", decision["message"])

    def test_secret_bearing_approval_does_not_claim_a_saved_rule(self):
        with patch("dgc.agent.contains_secret", return_value=True):
            history, _ = self.run_decision("always", save_rule=lambda *args: self.fail("must not save a rule"))
        decision = next(i for i in history if i["type"] == "permission_decision")
        self.assertEqual(decision["message"], "Allowed once")

    def test_policy_changed_during_approval_still_denies_the_tool_on_replay(self):
        def changed_policy(*args):
            self.agent.config.permissions["deny"].append("Write(*)")
            return "once"
        history, denied = self.run_decision("once", decide=changed_policy)
        self.assertEqual((self.root / "a.txt").read_text(), "original")
        self.assertEqual(len(denied), 1)
        self.assertTrue(any(i["type"] == "permission_decision" for i in history))
        self.assertTrue(any(i["type"] == "tool_denied" for i in history))

    def test_a_failed_rule_save_does_not_claim_always_allowed(self):
        history, _ = self.run_decision("always", save_rule=lambda *args: None)
        decision = next(i for i in history if i["type"] == "permission_decision")
        self.assertEqual(decision["message"], "Allowed once")

    def test_text_tool_decisions_also_survive_reload(self):
        history, _ = self.run_decision("no", text_protocol=True)
        self.assertEqual((self.root / "a.txt").read_text(), "original")
        self.assertTrue(any(i["type"] == "permission_decision" and i["decision"] == "no" for i in history))

    def test_legacy_denial_is_not_replayed_as_an_edit_or_an_invented_decision(self):
        self.run_decision("no")
        for message in self.agent.messages:
            message.pop("_dgc_approval", None)
        history = self.backend._history()
        self.assertTrue(any(i["type"] == "tool_denied" for i in history))
        self.assertFalse(any(i["type"] in ("tool_result", "permission_decision") for i in history))
        self.assertEqual((self.root / "a.txt").read_text(), "original")

    def test_unrecognised_history_data_cannot_create_an_approval(self):
        for value in [None, [], "once", {"decision": "approve-all"}, {"name": "bash"}]:
            self.assertEqual(self.backend._history_approval(value, "call"), [])


if __name__ == "__main__":
    unittest.main()
