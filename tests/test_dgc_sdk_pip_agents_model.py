"""Pips API 104 in the Python SDK: set_pip_agents's sub-agents model fields (model_choice, thinking, context_size,
fallback), known with the runtime's own fields, refused before API 104, then sent; slots alone as before."""
import unittest

from test_dgc_sdk_pips import CAPS, Wire, session
from dgc_sdk import DGCUnsupportedError
from dgc_sdk.pips import COMMAND_FIELDS, MUTATION_COMMANDS

PIP = "pip_" + "b" * 32
MODEL = {"pip_id": PIP, "model_choice": {"mode": "model", "model": "qwen3:8b"}, "thinking": "high",
         "context_size": 131072, "fallback": {"provider": "", "model": "llama3.3:70b"}}


class PipAgentsModelSDKTests(unittest.TestCase):
    def test_the_sdk_knows_the_runtimes_fields(self):
        from dgc.pips import _COMMAND_ARGS
        self.assertEqual(COMMAND_FIELDS["set_pip_agents"], _COMMAND_ARGS["set_pip_agents"])
        self.assertIn("set_pip_agents", MUTATION_COMMANDS)

    def test_its_model_is_refused_before_api104_then_sent(self):
        for field, value in MODEL.items():
            if field == "pip_id":
                continue
            with self.subTest(field=field):
                wire = Wire(); old = session(wire, caps={**CAPS, "pips_api_version": 103})
                with self.assertRaisesRegex(DGCUnsupportedError, "API 104"):
                    old.pips.mutate("set_pip_agents", {"pip_id": PIP, field: value}, approved=True)
                self.assertFalse(wire.calls)
        wire = Wire(); current = session(wire, caps={**CAPS, "pips_api_version": 104})
        self.assertEqual(current.pips.mutate("set_pip_agents", MODEL, approved=True)["request"]["type"], "set_pip_agents")

    def test_slots_alone_are_sent_from_api97(self):
        wire = Wire(); old = session(wire, caps={**CAPS, "pips_api_version": 97})
        self.assertEqual(old.pips.mutate("set_pip_agents", {"pip_id": PIP, "slots": 4}, approved=True)["request"]["slots"], 4)


if __name__ == "__main__":
    unittest.main()
