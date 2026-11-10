"""A message to a Pip can be up to 256 KB (Limits for everyone, Pips API 79). Found live on 11 Nov: a 100 KB message was
refused on its way, first by the editor host (16 KiB) and then by the backend's own check of every Pips request
(headless._bounded_pips_command, 32 KiB), though DGC's Pips handler takes it. Each hop now lets a message as large as
the Pips handler's own request limit through; everything else keeps 32 KiB."""
import unittest

from dgc import headless, pips
from dgc.workspace_registry import RegistryError


def message(chars):
    return {"type": "pips_control", "request": {"type": "send_pip_message", "pip_id": "pip_" + "a" * 32,
                                                "text": ("garden log " * (chars // 11 + 1))[:chars], "idempotency_key": "k1",
                                                "request_id": "r1"}}


class EveryHop(unittest.TestCase):
    def test_a_100_kb_and_a_256_kb_message_pass_the_backends_check(self):
        for chars in (100 * 1024, 256 * 1024):
            with self.subTest(chars=chars):
                bounded = headless._bounded_pips_command(message(chars))
                request = bounded[0] if isinstance(bounded, tuple) else bounded
                self.assertEqual(len((request.get("request") or request)["text"]), chars)

    def test_past_the_handlers_own_limit_and_for_anything_else_it_still_refuses(self):
        with self.assertRaises(RegistryError):
            headless._bounded_pips_command(message(pips.CHAT_REQUEST_BYTES + 1))
        with self.assertRaisesRegex(RegistryError, "32 KiB"):
            headless._bounded_pips_command({"type": "pips_control", "request": {"type": "add_pip_note", "pip_id": "pip_" + "a" * 32,
                                                                                "text": "n" * 40000, "shared": False,
                                                                                "request_id": "r2"}})


if __name__ == "__main__":
    unittest.main()
