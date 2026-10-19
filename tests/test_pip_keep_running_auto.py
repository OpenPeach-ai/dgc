"""Keep Pips running is turned on when a Pip gets a schedule, unless the user chose it off.

The service manager is never touched: status and the switch are replaced, and the account-home
check is explicit. New functions are imported inside the tests so each fails on its own against
the code before this change.
"""
import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from dgc import pips
from tests import test_pips_local as local

OFF = {"platform": "linux", "supported": True, "reason": "", "on": False, "starts_at_login": False,
       "restarts_after_failure": False, "while_logged_out": False}
ON = {**OFF, "on": True, "starts_at_login": True, "restarts_after_failure": True, "while_logged_out": True}


class KeepRunningForScheduleTests(unittest.TestCase):
    setUp = local.LocalPipsTests.setUp
    git = local.LocalPipsTests.git
    commit = local.LocalPipsTests.commit

    def switch(self, state=OFF, after=ON, account=True, before=False):
        from dgc import pip_keep_running as keep
        calls = []
        def set_on(enabled, **kwargs):
            calls.append((enabled, kwargs.get("runner_online")))
            return after
        patches = [patch.object(keep, "status", return_value=state), patch.object(keep, "set_on", side_effect=set_on),
                   patch.object(keep, "_account_home", return_value=account),
                   patch.object(keep, "_turned_off_before", return_value=before)]
        for item in patches:
            item.start()
            self.addCleanup(item.stop)
        return calls

    def control(self, request):
        with patch("dgc.workspace_registry.state_directory", return_value=self.registry.directory):
            return pips.handle_control(self.cfg, {"request_id": "keep", **request}, "editor-user", start_worker=False)

    def propose(self, job, version, changes):
        # Through the control, so the review and its acceptance share one clock.
        answer = self.control({"type": "propose_pip_update", "pip_id": job["id"], "expected_version": version,
                               "changes": changes, "reason": "Fixture change"})
        self.assertTrue(answer["ok"], answer)
        return answer["result"]["proposal"]

    def scheduled(self):
        self.commit()
        job = self.store.create(self.workspace["id"], "Nightly reviewer", "Review the code.", "user")
        return job, self.propose(job, 1, {"schedule": {"type": "interval", "minutes": 60}})

    def test_a_schedule_turns_keep_running_on_once_and_says_so(self):
        from dgc import pip_keep_running as keep
        calls = self.switch()
        job, proposal = self.scheduled()
        answer = self.control({"type": "accept_pip_update", "pip_id": job["id"], "proposal_id": proposal["id"], "expected_version": 1})
        self.assertTrue(answer["ok"], answer)
        self.assertEqual(calls, [(True, False)])
        self.assertEqual(answer["result"]["keep_running_notice"], keep.TURNED_ON)
        self.assertIn("now run even when VS Code is closed", keep.TURNED_ON)
        self.assertIsNone(keep.choice(self.registry))          # DGC's own turn-on is not the user's choice

    def test_an_explicit_off_is_respected_and_recorded_by_the_switch(self):
        from dgc import pip_keep_running as keep
        calls = self.switch()
        answer = self.control({"type": "set_pips_keep_running", "enabled": False})
        self.assertTrue(answer["ok"], answer)
        self.assertEqual(keep.choice(self.registry), "off")
        calls.clear()
        job, proposal = self.scheduled()
        answer = self.control({"type": "accept_pip_update", "pip_id": job["id"], "proposal_id": proposal["id"], "expected_version": 1})
        self.assertTrue(answer["ok"], answer)
        self.assertEqual(calls, [])                              # never flipped back on
        self.assertIn("off, as you chose", answer["result"]["keep_running_notice"])

    def test_an_off_chosen_before_choices_were_recorded_is_respected(self):
        from dgc import pip_keep_running as keep
        calls = self.switch(before=True)
        job, proposal = self.scheduled()
        answer = self.control({"type": "accept_pip_update", "pip_id": job["id"], "proposal_id": proposal["id"], "expected_version": 1})
        self.assertEqual(calls, [])
        self.assertEqual(keep.choice(self.registry), "off")
        self.assertIn("Turn it on in the Pips view", answer["result"]["keep_running_notice"])

    def test_no_schedule_no_change_and_already_on_says_nothing(self):
        calls = self.switch()
        self.commit()
        job = self.store.create(self.workspace["id"], "Reviewer", "Review the code.", "user")
        proposal = self.propose(job, 1, {"goal": "Review the backend."})
        answer = self.control({"type": "accept_pip_update", "pip_id": job["id"], "proposal_id": proposal["id"], "expected_version": 1})
        self.assertNotIn("keep_running_notice", answer["result"])
        self.assertEqual(calls, [])
        calls = self.switch(state=ON)
        proposal = self.propose(job, 2, {"schedule": {"type": "interval", "minutes": 60}})
        answer = self.control({"type": "accept_pip_update", "pip_id": job["id"], "proposal_id": proposal["id"], "expected_version": 2})
        self.assertNotIn("keep_running_notice", answer["result"])
        self.assertEqual(calls, [])

    def test_failure_or_a_missing_step_is_said_plainly_and_never_blocks_the_pip(self):
        from dgc import pip_keep_running as keep
        from dgc.workspace_registry import RegistryError
        with patch.object(keep, "status", return_value=OFF), patch.object(keep, "_account_home", return_value=True), \
             patch.object(keep, "_turned_off_before", return_value=False), \
             patch.object(keep, "set_on", side_effect=RegistryError("service_manager_error", "The service manager refused the change.")):
            told = keep.for_schedule(self.registry, runner_online=False)
        self.assertFalse(told["turned_on"])
        self.assertIn("dgc pips keep-running on", told["notice"])
        with patch.object(keep, "status", return_value=OFF), patch.object(keep, "_account_home", return_value=True), \
             patch.object(keep, "_turned_off_before", return_value=False), \
             patch.object(keep, "set_on", return_value={**ON, "while_logged_out": False}), patch.dict("os.environ", {"USER": "founder"}):
            told = keep.for_schedule(self.registry, runner_online=False)
        self.assertTrue(told["turned_on"])
        self.assertIn("sudo loginctl enable-linger founder", told["notice"])
        with patch.object(keep, "status", return_value={**OFF, "supported": False, "reason": "Keeping Pips running is available on Linux and macOS."}), \
             patch.object(keep, "_account_home", return_value=True):
            told = keep.for_schedule(self.registry, runner_online=False)
        self.assertIn("available on Linux and macOS", told["notice"])
        with patch.object(keep, "status", return_value=OFF), patch.object(keep, "_account_home", return_value=False), \
             patch.object(keep, "set_on", side_effect=AssertionError("No login service for a borrowed home")):
            told = keep.for_schedule(self.registry, runner_online=False)
        self.assertIsNone(told)                 # a borrowed HOME: nothing is set up and nothing is said

    def test_the_model_and_the_card_hear_the_same_sentence(self):
        from dgc import pip_keep_running as keep, pip_setup, pip_setup_tool
        from dgc.workspace_registry import WorkspaceRegistry
        calls = self.switch()
        self.commit()
        self.registry.associate_session("main-chat", self.root)
        request = {"target_root": str(self.root), "name": "Nightly reviewer", "goal": "Review committed source.",
                   "pip_type": "rook", "work_kind": "source_review", "schedule": {"type": "interval", "minutes": 60},
                   "run_now": False, "request_key": "nightly", "reason": "Asked for a nightly reviewer."}
        card = pip_setup.propose(self.registry, dict(request, request_key="card"), self.root, "main-chat")
        self.assertIn("turns on Keep Pips running", card["runner_notice"])
        ctx = SimpleNamespace(config=self.cfg, project_root=self.root,
                              pip_proposal_origin=lambda: {"session_id": "main-chat", "workspace_id": self.workspace["id"]})
        with patch.object(pip_setup_tool, "WorkspaceRegistry", lambda: WorkspaceRegistry(self.registry.directory)):
            answer = json.loads(pip_setup_tool.propose({**request, "_dgc_create_now": True}, ctx))
        self.assertTrue(answer["created"])
        self.assertIn(keep.TURNED_ON, answer["message"])
        self.assertEqual(calls, [(True, False)])


if __name__ == "__main__":
    unittest.main()
