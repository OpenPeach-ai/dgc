"""Pips API 79 in the Python SDK: several conversations per Pip. The four new commands and the optional conversation_id
on send, list, mark read and the context meter are known, refused before API 79, then sent."""
import unittest

from test_dgc_sdk_pips import CAPS, Wire, session
from dgc_sdk import DGCConfigError, DGCUnsupportedError
from dgc_sdk.pips import COMMAND_FIELDS, MUTATION_COMMANDS, READ_COMMANDS

PIP = "pip_" + "a" * 32
CONV = "conv_" + "b" * 32


class PipConversationsSDKTests(unittest.TestCase):
    def test_the_sdk_knows_the_runtimes_fields(self):
        from dgc.pips import _COMMAND_ARGS
        for command in ("list_pip_conversations", "create_pip_conversation", "rename_pip_conversation",
                        "archive_pip_conversation", "send_pip_message", "list_pip_messages", "mark_pip_read",
                        "get_pip_chat_context"):
            self.assertEqual(COMMAND_FIELDS[command], _COMMAND_ARGS[command], command)
        self.assertIn("list_pip_conversations", READ_COMMANDS)
        self.assertTrue({"create_pip_conversation", "rename_pip_conversation", "archive_pip_conversation"} <= MUTATION_COMMANDS)

    def test_the_commands_are_refused_before_api79_then_sent(self):
        wire = Wire(); old = session(wire, caps={**CAPS, "pips_api_version": 78})
        with self.assertRaisesRegex(DGCUnsupportedError, "API 79"):
            old.pips.read("list_pip_conversations", {"pip_id": PIP})
        with self.assertRaisesRegex(DGCUnsupportedError, "API 79"):
            old.pips.mutate("create_pip_conversation", {"pip_id": PIP, "title": "Trip"}, approved=True)
        self.assertFalse(wire.calls)
        wire = Wire(); current = session(wire, caps={**CAPS, "pips_api_version": 79})
        sent = current.pips.mutate("rename_pip_conversation", {"pip_id": PIP, "conversation_id": CONV, "title": "Goa"},
                                   approved=True)["request"]
        self.assertEqual((sent["type"], sent["conversation_id"], sent["title"]), ("rename_pip_conversation", CONV, "Goa"))
        sent = current.pips.mutate("archive_pip_conversation", {"pip_id": PIP, "conversation_id": CONV, "archived": False},
                                   approved=True)["request"]
        self.assertIs(sent["archived"], False)

    def test_a_conversation_on_the_chat_commands_needs_api79_and_its_id(self):
        wire = Wire(); old = session(wire, caps={**CAPS, "pips_api_version": 78})
        with self.assertRaisesRegex(DGCUnsupportedError, "API 79"):
            old.pips.read("list_pip_messages", {"pip_id": PIP, "conversation_id": CONV})
        sent = old.pips.read("list_pip_messages", {"pip_id": PIP})["request"]
        self.assertNotIn("conversation_id", sent, "without one, an older runtime is asked as before")
        wire = Wire(); current = session(wire, caps={**CAPS, "pips_api_version": 79})
        sent = current.pips.read("list_pip_messages", {"pip_id": PIP, "conversation_id": CONV})["request"]
        self.assertEqual(sent["conversation_id"], CONV)
        with self.assertRaises((DGCConfigError, DGCUnsupportedError)):
            current.pips.read("list_pip_messages", {"pip_id": PIP, "conversation_id": "../etc"})


if __name__ == "__main__":
    unittest.main()
