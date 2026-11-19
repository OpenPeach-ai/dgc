"""Pips API 111 in the Python SDK: @ a Pip hands it a job (get_pip_job, list_pip_jobs, start_pip_job, decline_pip_job),
known with the runtime's own fields, refused before API 111, then sent."""
import unittest

from test_dgc_sdk_pips import CAPS, Wire, session
from dgc_sdk import DGCUnsupportedError
from dgc_sdk.pips import COMMAND_FIELDS, MUTATION_COMMANDS, READ_COMMANDS

JOB = "pipjob_" + "a" * 32
PIP = "pip_" + "b" * 32
READS = {"get_pip_job": {"job_id": JOB}, "list_pip_jobs": {"pip_id": PIP}}
MUTATIONS = {"start_pip_job": {"pip_id": PIP, "job_id": JOB}, "decline_pip_job": {"pip_id": PIP, "job_id": JOB}}


class PipJobsSDKTests(unittest.TestCase):
    def test_the_sdk_knows_the_runtimes_fields(self):
        from dgc.pips import _COMMAND_ARGS
        for command in (*READS, *MUTATIONS):
            with self.subTest(command=command):
                self.assertEqual(COMMAND_FIELDS[command], _COMMAND_ARGS[command])
                self.assertIn(command, READ_COMMANDS if command in READS else MUTATION_COMMANDS)

    def test_refused_before_api111_then_sent(self):
        for command, fields in (*READS.items(), *MUTATIONS.items()):
            with self.subTest(command=command):
                wire = Wire(); old = session(wire, caps={**CAPS, "pips_api_version": 110})
                call = (lambda s: s.pips.read(command, fields)) if command in READS else (
                    lambda s: s.pips.mutate(command, fields, approved=True))
                with self.assertRaisesRegex(DGCUnsupportedError, "API 111"):
                    call(old)
                self.assertFalse(wire.calls)
                wire = Wire(); current = session(wire, caps={**CAPS, "pips_api_version": 111})
                self.assertEqual(call(current)["request"]["type"], command)


if __name__ == "__main__":
    unittest.main()
