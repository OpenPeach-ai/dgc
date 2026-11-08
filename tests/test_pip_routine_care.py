"""Routines recover and tell you (Pips package 2).

A routine's run that fails for a reason a second go can fix starts again by itself once, unseen; one that keeps
failing, or that only the user can fix, is said once on the desktop and in a line in its chat, never once per run. A
routine that couldn't start says so once and tries again every few minutes, not every heartbeat. A missed routine runs
if it is under 12 hours late and is said otherwise. A routine with nothing to say can stay quiet. Each Pip has one line
of health. Core mentions a question that has waited a day, once. The computer stays awake the hour before a routine.

The stand-in model is a real worker process whose model call fails (a provider error, a rate limit) until DGC's
"started again" note is in its prompt, or always.
"""
import json
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from dgc import pip_chat, pip_daemon, pip_desktop, pip_keep_awake, pip_routine_care as care, pip_routines, pip_unread, pips
from dgc import pip_run_watchdog as watchdog
from dgc.workspace_registry import RegistryError
from tests import test_pips_local as fixtures

DAILY = {"kind": "schedule", "schedule": {"type": "daily", "time": "08:00", "timezone": "Asia/Kolkata"}}

# Fails with ERROR until DGC's "failed, started again" note is in its prompt; an empty NOTE: it always fails.
FAILS_UNTIL_TOLD = r'''
import json
from unittest.mock import patch
from dgc.llm import LLMClient, ChatResult, LLMError
from dgc.pips import _worker_main
NOTE, ERROR = %r, %r
def chat(self, messages, tools=None, **kwargs):
    if NOTE and NOTE in json.dumps(messages):
        return ChatResult(content="Here is your morning brief. I checked what I had already done first.")
    raise LLMError(ERROR)
with patch.object(LLMClient, "chat", chat):
    raise SystemExit(_worker_main())
'''
PROVIDER_DOWN = "HTTP 503 from https://api.example/v1: Service Unavailable"
RATE_LIMITED = "rate limited (429) after 3 tries: 429 rate limited: slow down"
SIGNED_OUT = "Claude Code isn't signed in on this computer. Run `claude  (then authenticate in the browser)` once."


class Classify(unittest.TestCase):
    def test_what_a_second_go_can_fix_and_what_only_the_user_can(self):
        table = [
            (("model_failed", PROVIDER_DOWN), ("retry", "provider")),
            (("model_failed", RATE_LIMITED), ("retry", "rate_limited")),
            (("model_failed", "The audit worker stopped before it reported a result."), ("retry", "failed")),
            (("unsupported_model", SIGNED_OUT), ("owner", "signed_out")),
            (("model_failed", "Error: 401 Unauthorized: invalid x-api-key"), ("owner", "signed_out")),
            (("model_failed", "Your credit balance is too low to access the Anthropic API."), ("owner", "credits")),
            (("model_failed", "429 You exceeded your current quota, please check your plan and billing details."), ("owner", "credits")),
            (("model_failed", "Claude usage limit reached|1762588800"), ("owner", "usage_limit")),
            (("model_failed", "You've hit your usage limit. Upgrade or try again at 3:00 PM."), ("owner", "usage_limit")),
            (("model_failed", "HTTP 404: model 'qwen9:cloud' not found"), ("owner", "setup")),
            (("cancelled", "Stopped."), ("final", "cancelled")),
            (("stalled", "Got stuck again, so it stopped."), ("final", "stalled")),
            (("interrupted_after_send", "DGC restarted after it had sent something"), ("final", "interrupted_after_send")),
            (("permission_denied", "Not allowed."), ("final", "permission_denied")),
        ]
        for (code, message), expected in table:
            with self.subTest(message=message):
                self.assertEqual(care.classify(code, message), expected)
        self.assertEqual(care.retry_delay("rate_limited"), 60)
        self.assertEqual(care.retry_delay("provider"), 15)
        self.assertEqual(care.retry_delay("failed"), 15)

    def test_a_reply_that_stays_quiet_is_only_its_word(self):
        for said in ("NOTHING_NEW", "nothing_new", "**NOTHING_NEW**", "`NOTHING_NEW`.", "Nothing new."):
            self.assertTrue(care.is_quiet(said), said)
        for said in ("Nothing new in your inbox, but your bank wrote yesterday.", "", "NOTHING_NEW and one more thing"):
            self.assertFalse(care.is_quiet(said), said)


class RoutineCare(unittest.TestCase):
    setUp_base = fixtures.LocalPipsTests.setUp

    def setUp(self):
        self.setUp_base()
        self.cfg.data["pips_enabled"] = True
        self.pip = self.store.create(self.registry.personal()["id"], "Morning", None, "editor-user", pip_type="quill")
        self.routine = pip_routines.add(self.store, self.pip["id"], "Morning brief", "Send me the three biggest tech stories.", DAILY)

    # -- helpers --------------------------------------------------------------------------------------------------

    def next_due(self):
        return pip_routines._instant(self.registry.db.execute(
            "SELECT next_due_at FROM pip_routines WHERE id=?", (self.routine["id"],)).fetchone()[0])

    def clock(self, moment):
        self.registry.clock = lambda: pip_routines.stamp(moment)

    def due_now(self, late=timedelta(minutes=1)):
        """Move the clock just past the routine's next time, and look at it."""
        self.clock(self.next_due() + late)
        return pip_routines.tick(self.registry, self.cfg)[self.routine["id"]]

    def workers(self, script):
        launches, popen = [], subprocess.Popen

        def process(argv, *a, **kw):
            if argv[1:] == ["-m", "dgc.pips", "--worker"]:
                launches.append(1)
                argv = [sys.executable, "-c", script]
            return popen(argv, *a, **kw)
        return patch.object(pips.subprocess, "Popen", side_effect=process), launches

    def run_routine(self, error, *, until_told=True):
        """Its routine's turn, run by a worker whose model fails with ERROR (until DGC's note, or always)."""
        self.assertEqual(self.due_now(), "ran")
        row = self.store.claim_next()
        waits = []
        replaced, launches = self.workers(FAILS_UNTIL_TOLD % (watchdog.NOTES.get("failed", "your first try at this failed") if until_told else "", error))
        with replaced, patch.object(care, "wait_of", lambda seconds: (waits.append(seconds), 0.05)[1]):
            pips._run_claimed(self.registry, self.store, row, self.cfg, self.registry.directory)
        return self.store.run(row["id"]), launches, waits

    def notices(self):
        """What the desktop says now, once its minute has passed."""
        shown = []
        notifier = pip_desktop.Notifier(self.cfg, clock=iter(range(0, 10**6, 120)).__next__,
                                        send=lambda title, body: (shown.append(body), True)[1])
        notifier.tick(self.registry)
        return shown

    def messages(self):
        return pip_chat.list_messages(self.store, self.pip["id"], limit=50)

    # -- One quiet retry --------------------------------------------------------------------------------------------

    def test_a_routine_that_fails_once_then_works_retries_unseen(self):
        run, launches, waits = self.run_routine(PROVIDER_DOWN)
        self.assertEqual(run["status"], "succeeded", run.get("error"))
        self.assertEqual(len(launches), 2, "started again once, as the same run")
        self.assertEqual(waits, [15], "after 15 seconds")
        replies = [m for m in self.messages()["messages"] if m["role"] == "assistant"]
        self.assertEqual(len(replies), 1)
        self.assertNotIn("started_again", replies[0], "nothing in its chat says it was tried twice")
        self.assertEqual(care.troubles(self.registry.db, self.pip["id"]), {})
        self.assertEqual([n for n in self.notices() if "keeps failing" in n or "can't run" in n], [], "no notice")
        self.assertEqual(watchdog.attempts(self.registry.db, run["id"])["failed"], 1)
        self.assertIn("Don't mention the retry to the user", watchdog.NOTES["failed"],
                      "unseen: told only that it started again, a Pip wrote about the retry in its reply (8 Nov)")

    def test_a_rate_limit_waits_a_minute_before_its_one_retry(self):
        run, launches, waits = self.run_routine(RATE_LIMITED)
        self.assertEqual(run["status"], "succeeded", run.get("error"))
        self.assertEqual((len(launches), waits), (2, [60]))

    def test_a_routine_that_keeps_failing_is_told_once_not_once_per_run(self):
        run, launches, _ = self.run_routine(PROVIDER_DOWN, until_told=False)
        self.assertEqual((run["status"], len(launches)), ("failed", 2), "one retry, then it fails")
        first = self.notices()
        self.assertEqual(len([n for n in first if "keeps failing" in n]), 1, first)
        self.assertIn("Morning's routine “Morning brief” keeps failing: the model provider is too busy.", first,
                      "in words: the provider's raw answer stays on the run, for Details")
        # The next morning it fails the same way: its chat has a second line, the desktop says nothing more.
        run, launches, _ = self.run_routine(PROVIDER_DOWN, until_told=False)
        self.assertEqual(run["status"], "failed")
        self.assertEqual([n for n in self.notices() if "keeps failing" in n], [], "not once per run")
        failed = [m for m in self.messages()["messages"] if m["role"] == "user" and m.get("intro") and m["status"] == "failed"]
        self.assertEqual(len(failed), 2)
        self.assertTrue(all(m.get("error") for m in failed), "each failed run's turn carries its reason for its line")
        # A run of that Pip that works ends it: the next trouble is told again.
        with self.registry.transaction():
            care.clear_trouble(self.registry.db, self.pip["id"])
        self.assertEqual(care.troubles(self.registry.db, self.pip["id"]), {})

    def test_a_pip_set_not_to_notify_gets_no_notice(self):
        from dgc import pip_profile
        pip_profile.update(self.store, self.pip["id"], {"notify": False}, "editor-user")
        self.run_routine(PROVIDER_DOWN, until_told=False)
        self.assertEqual([n for n in self.notices() if "keeps failing" in n], [])

    def test_no_retry_after_it_sent_something_or_for_a_chat_the_user_started(self):
        self.assertEqual(self.due_now(), "ran")
        row = self.store.claim_next()
        with self.registry.transaction():
            self.registry.db.execute(
                "INSERT INTO pip_computer_actions(id,pip_id,workspace_id,run_id,host_id,request_ref,summary,digest,status,"
                "created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                ("action_sent", row["pip_id"], row["workspace_id"], row["id"], "host_1", "ref_1",
                 json.dumps({"method": "POST", "host": "shop.example"}), "digest", "sent",
                 "2026-10-01T09:59:00.000Z", "2026-10-02T09:59:00.000Z"))
        self.assertIsNone(pips._routine_retry_wait(self.registry, row, RegistryError("model_failed", PROVIDER_DOWN)))
        self.store.finish(row["id"], result={"text": "Done."})
        sent = pip_chat.send(self.store, self.pip["id"], "Hello", "chat-1", "editor-user", self.cfg)
        self.assertIsNone(care.routine_of(self.registry.db, sent["run"]["id"]), "a chat the user started isn't a routine")

    # -- A routine that couldn't start ------------------------------------------------------------------------------

    def test_a_signed_out_routine_says_so_once_and_backs_off(self):
        refused = RegistryError("unsupported_model", SIGNED_OUT)
        with patch.object(pip_chat, "send", side_effect=refused):
            self.assertEqual(self.due_now(), "blocked")
            notes = care.notes(self.registry.db, self.pip["id"])
            self.assertEqual(len(notes), 1)
            self.assertEqual(notes[0]["kind"], "blocked")
            self.assertEqual(notes[0]["text"], "Couldn't start: Claude Code isn't signed in on this computer.")
            shown = [n for n in self.notices() if "can't run" in n]
            self.assertEqual(shown, ["Morning can't run “Morning brief”: Claude Code isn't signed in on this computer."])
            # A heartbeat later it does not try again (it used to, every two seconds, saying nothing).
            self.assertEqual(pip_routines.tick(self.registry, self.cfg)[self.routine["id"]], "waiting")
            self.clock(self.next_due() + timedelta(minutes=7))
            self.assertEqual(pip_routines.tick(self.registry, self.cfg)[self.routine["id"]], "blocked")
            self.assertEqual(care.notes(self.registry.db, self.pip["id"])[0]["count"], 1, "one line for one morning")
            self.assertEqual([n for n in self.notices() if "can't run" in n], [], "one notice")
        health = care.health(self.registry.db, self.pip["id"])
        self.assertEqual(health["blocked"]["text"], "Claude Code signed out")
        self.assertEqual(health["blocked"]["fix"]["kind"], "sign_in")
        self.assertEqual(health["blocked"]["fix"]["engine"], "claude")
        page = self.messages()
        self.assertEqual([n["kind"] for n in page["routine_notes"]], ["blocked"], "its chat shows the line")
        # Signed in again: it runs on the same morning, and its trouble ends when the run works.
        self.clock(self.next_due() + timedelta(minutes=14))
        self.assertEqual(pip_routines.tick(self.registry, self.cfg)[self.routine["id"]], "ran")
        run = self.store.claim_next()
        self.store.finish(run["id"], result={"text": "Here is your brief."})
        pips._routine_after_run(self.registry, run, None)
        self.assertIsNone(care.health(self.registry.db, self.pip["id"])["blocked"])

    # -- A missed routine -------------------------------------------------------------------------------------------

    def test_a_routine_up_to_twelve_hours_late_still_runs_once(self):
        self.assertEqual(self.due_now(late=timedelta(hours=11)), "ran")
        self.assertEqual(care.notes(self.registry.db, self.pip["id"]), [])

    def test_a_routine_more_than_twelve_hours_late_is_said_and_waits_for_its_next_time(self):
        due = self.next_due()
        self.assertEqual(self.due_now(late=timedelta(hours=13)), "missed")
        notes = care.notes(self.registry.db, self.pip["id"])
        self.assertEqual([(n["kind"], n["text"]) for n in notes], [("missed", "Missed 8:00; the computer was off")])
        self.assertEqual(self.next_due(), due + timedelta(days=1), "its next time")
        self.assertFalse([m for m in self.messages()["messages"] if m["role"] == "user"], "no turn was written")
        self.assertEqual(care.health(self.registry.db, self.pip["id"])["last"]["outcome"], "missed")

    def test_a_missed_routine_says_why_when_dgc_was_running(self):
        due = self.next_due()
        self.registry.event(self.pip["workspace_id"], "pip_runtime_stopped", payload={"actor": "editor-user"})
        self.registry.db.execute("UPDATE workspace_events SET created_at=? WHERE event_type='pip_runtime_stopped'",
                                 (pip_routines.stamp(due - timedelta(hours=1)),))
        self.registry.db.commit()
        self.assertEqual(self.due_now(late=timedelta(hours=13)), "missed")
        self.assertEqual(care.notes(self.registry.db, self.pip["id"])[0]["text"], "Missed 8:00; Pips were turned off then")

    def test_the_runner_keeps_when_it_has_been_awake_since(self):
        self.assertFalse(pip_daemon._gap("2026-10-01T10:00:00.000Z", "2026-10-01T10:00:02.000Z"))
        self.assertTrue(pip_daemon._gap("2026-10-01T10:00:00.000Z", "2026-10-01T11:00:00.000Z"), "the computer slept")

    # -- Stay quiet ---------------------------------------------------------------------------------------------------

    def test_the_computer_waits_awake_for_the_next_routine_not_one_long_overdue(self):
        upcoming = pip_routines.add(self.store, self.pip["id"], "Noon", "Sum up my morning.",
                                    {"kind": "schedule", "schedule": {"type": "daily", "time": "12:00", "timezone": "Asia/Kolkata"}})
        now = self.next_due() + timedelta(hours=3)          # the 8:00 one overdue (it couldn't start), the noon one ahead
        noon = pip_routines._instant(self.registry.db.execute(
            "SELECT next_due_at FROM pip_routines WHERE id=?", (upcoming["id"],)).fetchone()[0])
        self.assertGreater(noon, now)
        self.assertEqual(pip_keep_awake.next_due(self.registry, now), noon)

    def test_a_routine_told_to_stay_quiet_can(self):
        self.assertIn("reply with only NOTHING_NEW", pip_routines.ROUTINE_TURN)
        self.assertEqual(self.due_now(), "ran")
        run = self.store.claim_next()
        self.store.finish(run["id"], result={"text": "NOTHING_NEW"})
        reply = [m for m in self.messages()["messages"] if m["role"] == "assistant"][0]
        self.assertIs(reply.get("quiet"), True)
        self.assertEqual(pip_unread.list_unread(self.store, self.pip["workspace_id"])["total"], 0, "never unread")
        self.assertEqual([n for n in self.notices() if n.startswith("Morning:")], [], "never notified")
        self.assertEqual(care.health(self.registry.db, self.pip["id"])["last"]["outcome"], "nothing_new")
        # A person's own chat is answered in words: the same word there is a reply like any other.
        sent = pip_chat.send(self.store, self.pip["id"], "Say only NOTHING_NEW", "chat-1", "editor-user", self.cfg)
        self.store.finish(self.store.claim_next()["id"], result={"text": "NOTHING_NEW"})
        mine = [m for m in self.messages()["messages"] if m["role"] == "assistant" and m["run_id"] == sent["run"]["id"]][0]
        self.assertNotIn("quiet", mine)
        self.assertEqual(pip_unread.list_unread(self.store, self.pip["workspace_id"])["total"], 1)

    # -- Health -------------------------------------------------------------------------------------------------------

    def test_the_health_line_for_a_working_and_a_failing_pip(self):
        self.assertEqual(care.health(self.registry.db, self.pip["id"])["last"], None, "not run yet")
        self.assertEqual(self.due_now(), "ran")
        run = self.store.claim_next()
        self.store.finish(run["id"], result={"text": "Here is your brief."})
        health = self.store.get(self.pip["id"])["routine_health"]
        self.assertEqual(health["last"]["outcome"], "worked")
        self.assertEqual(health["next_at"], pip_routines.stamp(self.next_due()))
        self.assertIsNone(health["blocked"])
        run, _, _ = self.run_routine(PROVIDER_DOWN, until_told=False)
        self.assertEqual(self.store.get(self.pip["id"])["routine_health"]["last"]["outcome"], "failed")
        bare = self.store.create(self.registry.personal()["id"], "Plain", None, "editor-user", pip_type="quill")
        self.assertNotIn("routine_health", self.store.get(bare["id"]), "a Pip with no routines has no line")


class CoreMentionsLongWaits(unittest.TestCase):
    setUp_base = fixtures.LocalPipsTests.setUp

    def setUp(self):
        self.setUp_base()
        self.cfg.data["pips_enabled"] = True
        self.core = self.store.create(self.registry.personal()["id"], "Core", None, "editor-user", pip_type="core")
        self.other = self.store.create(self.registry.personal()["id"], "Bills", None, "editor-user", pip_type="quill")

    def suggest(self, created_at):
        with self.registry.transaction():
            self.registry.db.execute(
                "INSERT INTO pip_routines(id,pip_id,workspace_id,title,prompt,trigger,status,created_by,anchor_at,created_at,"
                "updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                ("routine_" + "b" * 32, self.other["id"], self.other["workspace_id"], "Pay the electricity bill",
                 "Pay it.", json.dumps(DAILY), "suggested", "pip", created_at, created_at, created_at))

    def test_core_says_once_what_has_waited_a_day(self):
        now = datetime(2026, 10, 3, 10, 0, tzinfo=timezone.utc)
        self.suggest("2026-10-01T09:00:00.000Z")
        waits = care.long_waits(self.registry, now)
        self.assertEqual(len(waits), 1, waits)
        self.assertEqual((waits[0]["pip"], waits[0]["waited"]), ("Bills", "for 2 days"))
        self.assertIn("Pay the electricity bill", waits[0]["what"])
        with self.registry.transaction():
            care.mark_told(self.registry.db, [waits[0]["id"]])
        self.assertEqual(care.long_waits(self.registry, now), [], "once")

    def test_a_question_waiting_less_than_a_day_is_not_mentioned(self):
        self.suggest("2026-10-03T08:00:00.000Z")
        self.assertEqual(care.long_waits(self.registry, datetime(2026, 10, 3, 10, 0, tzinfo=timezone.utc)), [])

    def test_only_core_is_told_and_its_reply_marks_it_said(self):
        self.suggest("2020-01-01T00:00:00.000Z")
        req = pip_chat.request("What's on today?", "chat-1")
        context = pip_chat.prepare(self.store, self.store._job(self.core["id"]), req)
        self.assertEqual(len(context.get("long_waits") or []), 1)
        pip_chat.validate_context(context)
        self.assertNotIn("long_waits", pip_chat.prepare(self.store, self.store._job(self.other["id"]), req))
        self.assertIn("Unless you already said so", care.SAY_LONG_WAITS)


class KeepAwake(unittest.TestCase):
    def power(self, *supplies):
        root = Path(tempfile.mkdtemp())
        for name, kind, online in supplies:
            (root / name).mkdir()
            (root / name / "type").write_text(kind)
            if online is not None:
                (root / name / "online").write_text("1" if online else "0")
        return root

    @unittest.skipUnless(sys.platform.startswith("linux"), "Linux power supplies")
    def test_plugged_in_is_mains_power_or_no_battery(self):
        with patch("dgc.wsl.version", return_value=None):
            self.assertTrue(pip_keep_awake.plugged_in(self.power()), "a desktop has no battery")
            self.assertTrue(pip_keep_awake.plugged_in(self.power(("BAT0", "Battery", None), ("AC", "Mains", True))))
            self.assertFalse(pip_keep_awake.plugged_in(self.power(("BAT0", "Battery", None), ("AC", "Mains", False))))

    @unittest.skipUnless(sys.platform.startswith("linux"), "systemd-inhibit")
    def test_it_holds_sleep_off_only_the_hour_before_a_routine(self):
        now = datetime(2026, 10, 2, 2, 0, tzinfo=timezone.utc)
        spawned = []

        class Proc:
            def __init__(self):
                self.done = None

            def poll(self):
                return self.done

            def terminate(self):
                self.done = 0

            def wait(self, timeout=None):
                return 0

        def spawn(argv):
            spawned.append(argv)
            return Proc()

        class Refused(Proc):
            def __init__(self):
                self.done = 1                   # "Failed to inhibit: Access denied": exits at once
        due = {"value": now + timedelta(minutes=30)}
        clock = iter(range(0, 10**6, 120))
        awake = pip_keep_awake.KeepAwake(clock=clock.__next__, now=lambda: now, spawn=spawn, power=self.power())
        held_off = {k: v for k, v in __import__("os").environ.items() if k != "DGC_PIP_KEEP_AWAKE"}
        with patch.object(pip_keep_awake, "next_due", lambda registry, now: due["value"]), \
                patch.dict("os.environ", held_off, clear=True), \
                patch.object(pip_keep_awake, "hold_argv", lambda seconds, why, what="sleep:idle": ["systemd-inhibit", why, str(seconds)]):
            self.assertTrue(awake.tick(None))
            self.assertEqual(len(spawned), 1)
            self.assertIn("A Pip routine is due at", spawned[0][1])
            self.assertEqual(int(spawned[0][2]), 40 * 60 + 1, "until ten minutes after it is due")
            self.assertTrue(awake.tick(None))
            self.assertEqual(len(spawned), 1, "held, not started again")
            due["value"] = now + timedelta(hours=3)
            self.assertFalse(awake.tick(None), "three hours away: let go")
            self.assertFalse(awake.holding())
        # Where sleep may not be held (a runner started as a user service, or over SSH), idle is held instead.
        spawned.clear()
        awake = pip_keep_awake.KeepAwake(clock=clock.__next__, now=lambda: now, power=self.power(),
                                         spawn=lambda argv: (spawned.append(argv), Refused() if "--what=sleep:idle" in argv else Proc())[1])
        due["value"] = now + timedelta(minutes=30)
        with patch.object(pip_keep_awake, "next_due", lambda registry, now: due["value"]), patch.dict("os.environ", held_off, clear=True):
            self.assertTrue(awake.tick(None))
        self.assertEqual([a[1] for a in spawned], ["--what=sleep:idle", "--what=idle"])
        self.assertEqual(awake.what, "idle")
        awake.stop()
        with patch.dict("os.environ", {"DGC_PIP_KEEP_AWAKE": "0"}):
            due["value"] = now + timedelta(minutes=30)
            awake.last = None
            self.assertFalse(awake.tick(None), "turned off for a test run: never holds")


if __name__ == "__main__":
    unittest.main()
