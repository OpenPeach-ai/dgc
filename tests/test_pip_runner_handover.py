"""A newer install takes the Pips runner over without waiting for an idle moment that never comes (his machine,
15 Nov: his runner ran a build from the morning for eight hours through two installs; some Pip was always working, and
the runner was moved only while nothing was queued or running).

Now a newer install that finds another install's runner busy asks it to hand over: that runner starts no new reply,
lets the ones running finish, and stops once none runs, with queued work left queued. Nothing running is ended. Work
asked for meanwhile is queued, never refused. The newer install then clears that stop and starts its own runner, which
takes the queue."""
import unittest
from unittest.mock import patch

from dgc import pip_daemon as daemon, pip_runtime as runtime, pips
from dgc.workspace_registry import RegistryError
from tests import test_pip_daemon as daemon_tests, test_pip_runtime as runtime_tests

ELSEWHERE = "/elsewhere/0.52-test-old/src"


class AskedToHandOver(unittest.TestCase):
    setUp = runtime_tests.LocalStartupTests.setUp

    def test_a_busy_runner_from_another_install_is_asked_to_hand_over_and_nothing_is_refused(self):
        old = {**self.online, "install": ELSEWHERE}
        asked = []
        with patch.object(runtime, "_state", return_value=(old, "old")), \
             patch.object(runtime, "supervisor_is_live", return_value=True), \
             patch("dgc.pip_daemon.pause_if_idle", return_value=False), \
             patch("dgc.pip_daemon.ask_handover", side_effect=lambda registry, to: asked.append(to)), \
             patch.object(runtime, "_take_over_when_free", side_effect=lambda config, directory: None), \
             patch.object(runtime, "resume_runtime", side_effect=AssertionError("nothing is stopped")), \
             patch.object(runtime.subprocess, "Popen", side_effect=AssertionError("no second runner")):
            with self.assertRaises(RegistryError) as caught:
                runtime.start_runtime(self.config)
            self.assertEqual(caught.exception.code, "runner_handing_over")
            self.assertIn("finishes the replies it is running", str(caught.exception))
            self.assertEqual(runtime.require_supervisor(self.config), old, "work asked for meanwhile is queued")
        self.assertEqual(asked, [runtime.this_install()] * 2)

    def test_once_it_has_stopped_this_install_clears_that_stop_and_starts_its_own(self):
        stopped = {**self.offline, "paused": True}
        resumed = []
        states = iter([(stopped, "old"), (self.offline, "old")])
        with patch.object(runtime, "_state", side_effect=lambda directory: next(states, (self.online, "new"))), \
             patch.object(runtime, "_handed_over_here", return_value=True), \
             patch.object(runtime, "resume_runtime", side_effect=lambda config, actor: resumed.append(actor)), \
             patch.object(runtime, "supervisor_is_live", side_effect=lambda directory, status: status.get("online", False)), \
             patch.object(runtime, "_keep_running", return_value=None), \
             patch.object(runtime.subprocess, "Popen", return_value=self.process), \
             patch.object(runtime, "_log"):
            runtime.start_runtime(self.config)
        self.assertEqual(resumed, ["dgc-update"], "only the hand-over's own stop is cleared")

    def test_a_stop_the_user_set_is_never_cleared_by_a_hand_over(self):
        with patch.object(runtime, "_state", return_value=({**self.offline, "paused": True}, "old")), \
             patch.object(runtime, "_handed_over_here", return_value=False), \
             patch.object(runtime, "resume_runtime", side_effect=AssertionError("the user's stop stays")), \
             self.assertRaisesRegex(RegistryError, "Global stop"):
            runtime.start_runtime(self.config)


class Draining(unittest.TestCase):
    setUp = daemon_tests.PipDaemonTests.setUp
    job = daemon_tests.PipDaemonTests.job
    run_row = daemon_tests.PipDaemonTests.run_row

    def started(self):
        started = []
        self.addCleanup(patch.stopall)
        patch.object(pips, "start_queued", side_effect=lambda config: started.append(1)).start()
        return started

    def test_no_hand_over_asked_it_starts_queued_work_as_always(self):
        started = self.started()
        self.assertFalse(daemon.claim_or_hand_over(self.registry, self.config, "/here/src"))
        self.assertEqual(started, [1])

    def test_asked_it_starts_nothing_new_and_waits_for_the_running_reply(self):
        started = self.started()
        job = self.job()
        self.run_row(job, "running", "1")
        self.run_row(job, "queued", "2")
        with self.registry.transaction():
            daemon.ask_handover(self.registry, "/newer/src")
        self.assertFalse(daemon.claim_or_hand_over(self.registry, self.config, "/here/src"), "a reply is running")
        self.assertEqual(started, [], "no new reply starts here")
        self.assertFalse(daemon.is_runtime_paused(self.registry), "nothing running is ended")

    def test_once_none_runs_it_stops_with_queued_work_left_for_the_new_runner(self):
        started = self.started()
        self.run_row(self.job(), "queued", "2")
        with self.registry.transaction():
            daemon.ask_handover(self.registry, "/newer/src")
        self.assertTrue(daemon.claim_or_hand_over(self.registry, self.config, "/here/src"))
        self.assertTrue(daemon.is_runtime_paused(self.registry))
        self.assertEqual(daemon._read(self.registry, daemon.CONTROL_KEY)["actor"], "dgc-update")
        self.assertEqual(self.registry.db.execute("SELECT status FROM pip_runs WHERE id='run_fixture_2'").fetchone()[0],
                         "queued", "queued work waits for the new runner")
        self.assertEqual(started, [])
        self.assertEqual(daemon.handover_to(self.registry), "/newer/src")

    def test_its_own_install_named_is_no_hand_over(self):
        started = self.started()
        with self.registry.transaction():
            daemon.ask_handover(self.registry, "/here/src")
        self.assertFalse(daemon.claim_or_hand_over(self.registry, self.config, "/here/src"))
        self.assertEqual(started, [1])


class TheEditorsFirstLook(unittest.TestCase):
    """His machine, 18 Nov: after an install, opening a Pip's computer still showed the old desktop. The runner of the
    install before kept running, and the takeover only came with the next run asked for. Now the editor's first Pips
    request moves it (idle) or asks it to hand over (busy), once, in the background."""
    setUp = runtime_tests.LocalStartupTests.setUp

    def test_another_installs_runner_is_taken_over_at_the_first_look(self):
        started = []
        with patch.object(runtime, "_state", return_value=({**self.online, "install": ELSEWHERE}, "old")), \
             patch.object(runtime, "supervisor_is_live", return_value=True), \
             patch.object(runtime, "start_runtime", side_effect=lambda config: started.append(config) or {}):
            self.assertTrue(runtime.adopt_older_runner(self.config))
        self.assertEqual(len(started), 1)

    def test_this_installs_own_or_a_newer_runner_is_left_alone(self):
        from dgc import __version__
        for status in ({**self.online, "install": runtime.this_install(), "version": __version__},
                       {**self.online, "install": ELSEWHERE, "version": "9.9.9"}):
            with self.subTest(status=status.get("version")), \
                 patch.object(runtime, "_state", return_value=(status, "x")), \
                 patch.object(runtime, "supervisor_is_live", return_value=True), \
                 patch.object(runtime, "start_runtime", side_effect=AssertionError("left alone")):
                self.assertFalse(runtime.adopt_older_runner(self.config))

    def test_a_busy_one_handing_over_is_not_an_error(self):
        def busy(config):
            raise RegistryError("runner_handing_over", "busy")
        with patch.object(runtime, "_state", return_value=({**self.online, "install": ELSEWHERE}, "old")), \
             patch.object(runtime, "supervisor_is_live", return_value=True), \
             patch.object(runtime, "start_runtime", side_effect=busy):
            self.assertTrue(runtime.adopt_older_runner(self.config))

    def test_the_backend_looks_once_per_process_off_its_own_thread(self):
        import inspect
        from dgc import headless
        source = inspect.getsource(headless)
        self.assertIn("adopt_older_runner", source)
        self.assertIn("_pips_runner_looked", source)
