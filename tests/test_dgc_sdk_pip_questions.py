"""Pips API 106 in the Python SDK: a question card in a Pip's chat (send_pip_message's `questions`;
answer_pip_questions), known with the runtime's own fields, refused before API 106, then sent."""
import unittest

from test_dgc_sdk_pips import CAPS, Wire, session
from dgc_sdk import DGCConfigError, DGCUnsupportedError
from dgc_sdk.pips import COMMAND_FIELDS, MUTATION_COMMANDS

REPLY = "message_" + "a" * 32
ANSWER = {"pip_id": "pip_" + "b" * 32, "message_id": REPLY, "idempotency_key": "answer-1",
          "answers": {"q1": {"selected": [0], "other": ""}}}
DISMISS = {"pip_id": "pip_" + "b" * 32, "message_id": REPLY, "dismissed": True}
SEND = {"pip_id": "pip_" + "b" * 32, "text": "Propose me options", "idempotency_key": "k-1", "questions": True}


class PipQuestionsSDKTests(unittest.TestCase):
    def test_the_sdk_knows_the_runtimes_fields(self):
        from dgc.pips import _COMMAND_ARGS
        for command in ("answer_pip_questions", "send_pip_message"):
            with self.subTest(command=command):
                self.assertEqual(COMMAND_FIELDS[command], _COMMAND_ARGS[command])
        self.assertIn("answer_pip_questions", MUTATION_COMMANDS)

    def test_refused_before_api106_then_sent(self):
        wire = Wire(); old = session(wire, caps={**CAPS, "pips_api_version": 105})
        for fields in (ANSWER, DISMISS):
            with self.assertRaisesRegex(DGCUnsupportedError, "API 106"):
                old.pips.mutate("answer_pip_questions", fields, approved=True)
        with self.assertRaisesRegex(DGCUnsupportedError, "API 106"):
            old.pips.mutate("send_pip_message", SEND, approved=True)
        self.assertFalse(wire.calls)
        wire = Wire(); current = session(wire, caps={**CAPS, "pips_api_version": 106})
        for command, fields in (("answer_pip_questions", ANSWER), ("answer_pip_questions", DISMISS), ("send_pip_message", SEND)):
            with self.subTest(command=command, fields=fields):
                self.assertEqual(current.pips.mutate(command, fields, approved=True)["request"]["type"], command)

    def test_a_malformed_answer_is_refused_before_it_is_sent(self):
        wire = Wire(); current = session(wire, caps={**CAPS, "pips_api_version": 106})
        for fields in ({**ANSWER, "message_id": "m1"}, {**ANSWER, "dismissed": True}, {**DISMISS, "dismissed": False},
                       {k: v for k, v in ANSWER.items() if k != "idempotency_key"}, {**ANSWER, "answers": {}},
                       {"pip_id": ANSWER["pip_id"], "message_id": REPLY}):
            with self.subTest(fields=fields), self.assertRaises(DGCConfigError):
                current.pips.mutate("answer_pip_questions", fields, approved=True)
        with self.assertRaises(DGCConfigError):
            current.pips.mutate("send_pip_message", {**SEND, "questions": "yes"}, approved=True)
        self.assertFalse(wire.calls)


if __name__ == "__main__":
    unittest.main()
