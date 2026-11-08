"""A Pip run never hangs or dies silently (Pips package 1, decision D8).

A run that goes quiet for 20 minutes (2 hours while a tool runs) is stopped and started again once, told to check
what it already did, and its chat says "Got stuck, started again". Waiting on the user never counts as quiet. A
restart in the middle of a run reruns it once instead of failing it. A run that already sent something is never run
again, so nothing happens twice; it says so in one line instead.

The stand-in model is a real worker process whose model call never returns (or returns only once DGC's note is in
its prompt); the timing cases use a stand-in worker that writes the worker's own lines on a schedule. The limits are
shrunk to seconds for the test, never the code paths.
"""
import json
import subprocess
import sys
import unittest
from unittest.mock import patch

from dgc import pip_report_delivery, pip_run_watchdog as watchdog, pips
from dgc.workspace_registry import RegistryError
from tests import test_pips_local as fixtures

# Hangs, saying nothing at all, unless DGC's "started again" note is in its prompt. An empty NOTE: it always hangs.
HANGS_UNTIL_TOLD = r'''
import json, time
from unittest.mock import patch
from dgc.llm import LLMClient, ChatResult
from dgc.pips import _worker_main
NOTE = %r
def chat(self, messages, tools=None, **kwargs):
    if NOTE and NOTE in json.dumps(messages):
        return ChatResult(content="Done. I checked what I had already done first.")
    time.sleep(3600)
with patch.object(LLMClient, "chat", chat):
    raise SystemExit(_worker_main())
'''

# The worker's own protocol on a schedule: the policy handshake, then each step (a line, or a pause).
SCHEDULED = r'''
import json, sys, time
payload = json.loads(sys.stdin.buffer.read())
def say(value):
    print(json.dumps(value), flush=True)
say({"kind": "policy_ready", "digest": payload["manifest"]["policy_digest"]})
for step in %r:
    if isinstance(step, (int, float)):
        time.sleep(step)
    else:
        say(step)
'''


class Limits:
    """The watchdog's limits in seconds for one test."""

    def __init__(self, silence=1.0, tool=3.0):
        self.patches = [patch.object(watchdog, "SILENCE_SECONDS", silence),
                        patch.object(watchdog, "TOOL_SILENCE_SECONDS", tool)]

    def __enter__(self):
        for item in self.patches:
            item.start()
        return self

    def __exit__(self, *exc):
        for item in reversed(self.patches):
            item.stop()


class WatchdogTests(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp

    def personal_pip(self):
        return self.store.create(self.registry.personal()["id"], "Market brief", "Brief me before the open", "local-console")

    def claimed(self, key="one"):
        pip = self.personal_pip()
        queued = self.store.enqueue(pip["id"], key, "local-console", self.cfg)
        row = self.store.claim_next()
        self.assertEqual(row["id"], queued["id"])
        return row

    def workers(self, script):
        """Popen with each Pip worker replaced by SCRIPT; the list of worker launches."""
        launches, popen = [], subprocess.Popen

        def process(argv, *a, **kw):
            if argv[1:] == ["-m", "dgc.pips", "--worker"]:
                launches.append(1)
                argv = [sys.executable, "-c", script]
            return popen(argv, *a, **kw)
        return patch.object(pips.subprocess, "Popen", side_effect=process), launches

    def outcome(self, steps, *, silence=1.0, tool=3.0, waiting=False):
        """How a run with a scheduled worker ends: "stalled" when the watchdog stopped it, else anything else."""
        row = self.claimed()
        replaced, _launches = self.workers(SCHEDULED % (steps,))
        with Limits(silence, tool), replaced:
            hold = watchdog.waiting_on_you(row["id"]) if waiting else _nothing()
            with hold:
                try:
                    pips._execute_run(self.registry, row, self.cfg)
                except RegistryError as error:
                    return error.code
        return "finished"

    def execute(self, row, script, *, silence=1.0, tool=3.0):
        replaced, launches = self.workers(script)
        with Limits(silence, tool), replaced:
            pips._run_claimed(self.registry, self.store, row, self.cfg, self.registry.directory)
        return self.store.run(row["id"]), launches

    def progress_lines(self, run_id):
        rows = self.registry.db.execute(
            "SELECT payload FROM workspace_events WHERE run_id=? AND event_type='pip_run_progress' ORDER BY seq", (run_id,)).fetchall()
        return [json.loads(r[0]) for r in rows]

    def sent_computer_action(self, row, status="sent"):
        with self.registry.transaction():
            self.registry.db.execute(
                "INSERT INTO pip_computer_actions(id,pip_id,workspace_id,run_id,host_id,request_ref,summary,digest,status,"
                "created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                ("action_" + status + row["id"][-8:], row["pip_id"], row["workspace_id"], row["id"], "host_1", "ref_1",
                 json.dumps({"method": "POST", "host": "shop.example"}), "digest", status,
                 "2026-10-01T09:59:00.000Z", "2026-10-02T09:59:00.000Z"))

    # -- The silence it allows -----------------------------------------------------------------------------------

    def test_twenty_minutes_of_silence_stops_a_run(self):
        self.assertEqual(watchdog.SILENCE_SECONDS, 20 * 60)
        self.assertEqual(watchdog.TOOL_SILENCE_SECONDS, 2 * 60 * 60)
        self.assertEqual(self.outcome([3]), "stalled")

    def test_a_tool_running_gets_its_longer_limit_and_no_more(self):
        call = {"kind": "tool_call", "tool": "web_search", "call_id": "call_1", "path": ""}
        done = {"kind": "tool_result", "tool": "web_search", "call_id": "call_1", "status": "completed"}
        self.assertNotEqual(self.outcome([call, 2, done, {"kind": "result", "result": {}}]), "stalled",
                            "quiet longer than the plain limit, shorter than a tool's")
        self.assertEqual(self.outcome([call, 6]), "stalled", "a tool quiet past its own limit")
        self.assertEqual(self.outcome([call, done, 2]), "stalled", "the tool finished: the plain limit again")

    def test_a_pip_tool_step_counts_as_a_tool(self):
        start = {"kind": "step_start", "trace": {"t": 0.1, "call_id": "step_1", "tool": "web_search"}}
        self.assertNotEqual(self.outcome([start, 2, {"kind": "result", "result": {}}]), "stalled")

    def test_a_model_that_keeps_working_is_never_touched(self):
        alive = [step for _ in range(10) for step in ({"kind": "alive"}, 0.4)]
        self.assertNotEqual(self.outcome(alive + [{"kind": "result", "result": {}}]), "stalled",
                            "four seconds of work, never a second of silence")

    def test_waiting_on_you_never_counts_as_silence(self):
        self.assertNotEqual(self.outcome([3, {"kind": "result", "result": {}}], waiting=True), "stalled")
        self.assertFalse(watchdog.is_waiting("run_" + "0" * 32))

    def test_the_worker_says_it_is_alive_while_the_model_works_and_only_then(self):
        said, now = [], [1000.0]
        with patch.object(pips.time, "monotonic", lambda: now[0]):
            ui = pips._WorkerUI(said.append)
            ui.on_text("a")
            now[0] += 10
            ui.on_text("b")
            ui.on_thinking("c")
            self.assertEqual([s for s in said if s.get("kind") == "alive"], [{"kind": "alive"}], "once, not per chunk")
            now[0] += watchdog.PULSE_SECONDS
            ui.on_thinking("d")
            self.assertEqual(sum(s.get("kind") == "alive" for s in said), 2)
            now[0] += 3600
            self.assertEqual(sum(s.get("kind") == "alive" for s in said), 2, "no timer: a hung model says nothing")

    # -- Started again, once ---------------------------------------------------------------------------------------

    def test_a_hung_run_is_stopped_and_started_again_once(self):
        row = self.claimed()
        run, launches = self.execute(row, HANGS_UNTIL_TOLD % (watchdog.NOTES["stalled"],))
        self.assertEqual(run["status"], "succeeded", run.get("error"))
        self.assertEqual(len(launches), 2, "the stuck try, then one more")
        self.assertIn({"kind": "progress", "state": "restarted", "message": "Got stuck, started again"},
                      self.progress_lines(row["id"]))
        self.assertEqual(watchdog.attempts(self.registry.db, row["id"])["stalled"], 1)

    def test_the_reply_keeps_the_line_and_a_reload_says_it_once(self):
        pip = self.personal_pip()
        queued = self.store.enqueue(pip["id"], "chat-1", "local-console", self.cfg,
                                    conversation_request={"text": "What moved this morning?", "request_key": "chat-1"})
        row = self.store.claim_next()
        run, _launches = self.execute(row, HANGS_UNTIL_TOLD % (watchdog.NOTES["stalled"],))
        self.assertEqual(run["status"], "succeeded", run.get("error"))
        from dgc import pip_chat
        listed = pip_chat.list_messages(self.store, pip["id"])["messages"]
        reply = [m for m in listed if m["role"] == "assistant"][-1]
        self.assertEqual(reply["run_id"], queued["id"])
        self.assertEqual(reply["started_again"], "Got stuck, started again")
        self.assertNotIn("started_again", [m for m in listed if m["role"] == "user"][-1])
        restarted = [p for p in self.progress_lines(row["id"]) if p.get("state") == "restarted"]
        self.assertEqual(len(restarted), 1, "said once, not again on every look")

    def test_stuck_twice_it_stops_and_says_so(self):
        row = self.claimed()
        run, launches = self.execute(row, HANGS_UNTIL_TOLD % ("",))
        self.assertEqual(run["status"], "failed")
        self.assertEqual(len(launches), 2, "started again once, never twice")
        self.assertEqual(run["error"]["code"], "stalled")
        self.assertEqual(pip_report_delivery._reason(run["error"])[0], "Got stuck again, so it stopped.")

    def test_what_the_stuck_try_left_unsent_is_redone_not_sent_twice(self):
        row = self.claimed()
        self.sent_computer_action(row, status="pending")
        run, _launches = self.execute(row, HANGS_UNTIL_TOLD % (watchdog.NOTES["stalled"],))
        self.assertEqual(run["status"], "succeeded", run.get("error"))
        status, by = self.registry.db.execute("SELECT status,resolved_by FROM pip_computer_actions WHERE run_id=?",
                                              (row["id"],)).fetchone()
        self.assertEqual((status, by), ("expired", "pip-retry"), "the retry redoes it; the old card can't send it too")

    def test_a_stuck_run_that_already_sent_something_is_not_started_again(self):
        row = self.claimed()
        self.sent_computer_action(row)
        run, launches = self.execute(row, HANGS_UNTIL_TOLD % (watchdog.NOTES["stalled"],))
        self.assertEqual(len(launches), 1)
        self.assertEqual(run["status"], "failed")
        self.assertEqual(run["error"]["code"], "stalled_after_send")
        self.assertEqual(pip_report_delivery._reason(run["error"])[0],
                         "Got stuck after it had sent something, so it wasn't started again.")

    # -- A restart -------------------------------------------------------------------------------------------------

    def test_a_restart_mid_run_reruns_it_once_told_to_check_what_it_did(self):
        row = self.claimed()
        self.assertEqual(self.store.recover(), 1)
        again = self.store.run(row["id"])
        self.assertEqual(again["status"], "queued", "back in line, not failed")
        self.assertEqual(watchdog.attempts(self.registry.db, row["id"])["restarted"], 1)
        claimed = self.store.claim_next()
        self.assertEqual(claimed["id"], row["id"])
        run, launches = self.execute(claimed, HANGS_UNTIL_TOLD % (watchdog.NOTES["restart"],))
        self.assertEqual(run["status"], "succeeded", run.get("error"))
        self.assertEqual(len(launches), 1)
        self.assertIn({"kind": "progress", "state": "restarted", "message": "DGC restarted, so it started again"},
                      self.progress_lines(row["id"]))

    def test_a_second_restart_does_not_rerun_it_again(self):
        row = self.claimed()
        self.store.recover()
        self.store.claim_next()
        self.store.recover()
        run = self.store.run(row["id"])
        self.assertEqual(run["status"], "failed")
        self.assertEqual(run["error"]["code"], "interrupted")

    def test_a_restart_never_reruns_a_run_that_sent_something(self):
        row = self.claimed()
        self.sent_computer_action(row)
        self.store.recover()
        run = self.store.run(row["id"])
        self.assertEqual(run["status"], "failed")
        self.assertEqual(run["error"]["code"], "interrupted_after_send")
        self.assertEqual(pip_report_delivery._reason(run["error"])[0],
                         "DGC restarted after it had sent something, so it wasn't run again.")

    def test_a_restart_never_reruns_an_app_send(self):
        row = self.claimed()
        with self.registry.transaction():
            self.registry.db.execute(
                "INSERT INTO pip_app_actions(id,pip_id,workspace_id,source_run_id,request_key,requested_by,request_digest,"
                "payload,digest,created_at,expires_at,status,resolved_by,resolved_at,receipt) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                ("appaction_1", row["pip_id"], row["workspace_id"], row["id"], "key_1", "pip-worker", "d", "{}", "d",
                 "2026-10-01T09:59:00.000Z", "2026-10-02T09:59:00.000Z", "succeeded", "editor-user",
                 "2026-10-01T09:59:30.000Z", "{}"))
        self.assertTrue(watchdog.sent_something(self.registry.db, row["id"]))
        self.store.recover()
        self.assertEqual(self.store.run(row["id"])["error"]["code"], "interrupted_after_send")

    def test_a_rerun_after_a_restart_clears_what_the_cut_off_try_left(self):
        row = self.claimed()
        left = self.registry.directory / "runs" / row["id"] / "worker-home"
        left.mkdir(parents=True)
        (left / "half-done.txt").write_text("from the try that was cut off", encoding="utf-8")
        self.store.recover()
        run, launches = self.execute(self.store.claim_next(), HANGS_UNTIL_TOLD % (watchdog.NOTES["restart"],))
        self.assertEqual(run["status"], "succeeded", run.get("error"))
        self.assertEqual(len(launches), 1)

    def test_only_a_model_run_runs_again(self):
        for kind, again in (("conversation", True), ("personal_task", True), ("audit", True), ("draft", True),
                            ("live", False), ("patch", False), ("test", False)):
            with self.subTest(kind=kind):
                self.assertIs(watchdog.may_run_again({"run_kind": kind}), again)
        self.assertFalse(watchdog.may_run_again(None))

    def test_a_live_check_can_only_shorten_the_limit(self):
        with patch.dict("os.environ", {"DGC_PIP_SILENCE_SECONDS": "30"}):
            self.assertEqual(watchdog.limit_of("DGC_PIP_SILENCE_SECONDS", 1200), 30)
        with patch.dict("os.environ", {"DGC_PIP_SILENCE_SECONDS": "3"}):
            self.assertEqual(watchdog.limit_of("DGC_PIP_SILENCE_SECONDS", 1200), 10, "never under 10 s")
        with patch.dict("os.environ", {"DGC_PIP_SILENCE_SECONDS": "99999"}):
            self.assertEqual(watchdog.limit_of("DGC_PIP_SILENCE_SECONDS", 1200), 1200, "never longer")
        with patch.dict("os.environ", {"DGC_PIP_SILENCE_SECONDS": "soon"}):
            self.assertEqual(watchdog.limit_of("DGC_PIP_SILENCE_SECONDS", 1200), 1200)

    def test_a_stopping_run_is_still_cancelled_by_a_restart(self):
        row = self.claimed()
        self.store.cancel(row["id"], "editor-user")
        self.store.recover()
        self.assertEqual(self.store.run(row["id"])["status"], "cancelled")


class _nothing:
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


if __name__ == "__main__":
    unittest.main()
