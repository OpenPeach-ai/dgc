"""A Personal Pip the main chat made in Pulse's role, with a daily routine, broke every Pips list (2026-10-20).

Creating it skips the project command-plan check for Personal Pips, but reading Pips back checked every Pulse as a
project Pulse: "Pulse schedules require a reviewed verification plan", so `dgc pips list --personal` and the Pips view
failed for all of them.
"""
from __future__ import annotations

import unittest

from dgc import pips
from dgc.workspace_registry import RegistryError


class PersonalPulseTests(unittest.TestCase):
    def job(self, policy):
        return {"pip_type": "pulse", "source_policy": policy, "schedule": {"kind": "daily", "time": "08:00"},
                "event_trigger": None, "verification_plan": None}

    def test_a_personal_pip_in_pulses_role_reads_back_without_a_command_plan(self):
        job = self.job({"mode": "personal"})
        pips._project_pulse_plan(job)
        self.assertIsNone(job["verification_plan"])
        self.assertIsNone(job["verification_plan_digest"])

    def test_a_scheduled_project_pulse_still_needs_its_reviewed_plan(self):
        with self.assertRaises(RegistryError) as caught:
            pips._project_pulse_plan(self.job({"mode": "committed_only"}))
        self.assertEqual(caught.exception.code, "review_required")


if __name__ == "__main__":
    unittest.main()
