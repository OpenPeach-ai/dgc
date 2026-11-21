"""A chat wakes itself up later (0.52, asked 8 Nov): "check the tests in 30 minutes" comes back by itself at that time,
and a repeating check is one wake-up at a time. dgc/wakeups.py keeps a chat's wake-ups, beside its session so a reload
or an editor restart brings them back; the tools set and cancel them."""
import json
import os
import pwd
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

_REAL_HOME = pwd.getpwuid(os.getuid()).pw_dir
if "dgc.config" in sys.modules:                    # imported by another module first: verify, never assume
    import dgc.config as _config
    if Path(_config.USER_HOME) == Path(_REAL_HOME) or Path(_REAL_HOME) in Path(_config.USER_HOME).parents:
        raise RuntimeError("tests/test_wakeups.py needs HOME redirected before dgc is imported")
else:
    _HOME = tempfile.TemporaryDirectory(prefix="dgc-wakeups-home-")
    for _var in ("HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"):
        os.environ[_var] = _HOME.name

from dgc import sessions, tools, wakeups  # noqa: E402


class Clock:
    def __init__(self, now=1_800_000_000.0):
        self.now = now

    def __call__(self):
        return self.now


class BookTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix="dgc-wakeups-project-")
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)
        self.session = sessions.new_path(self.dir)
        self.clock = Clock()
        self.changes = []
        self.book = wakeups.Book(lambda: (self.session, self.dir), clock=self.clock, on_change=self.changes.append)

    def test_a_wake_up_is_set_listed_and_comes_due_once_at_its_time(self):
        set_ = self.book.add(30, "Check the tests", "Run the test suite and tell me what failed.")
        self.assertRegex(set_["id"], r"^wake\d+$")
        self.assertEqual(set_["at"], self.clock.now + 30 * 60)
        self.assertEqual([i["why"] for i in self.book.items()], ["Check the tests"])
        self.assertEqual(self.book.next_at(), self.clock.now + 30 * 60)
        self.assertIsNone(self.book.take_due(), "not yet")
        self.clock.now += 30 * 60
        due = self.book.take_due()
        self.assertEqual((due["id"], due["prompt"]), (set_["id"], "Run the test suite and tell me what failed."))
        self.assertIsNone(self.book.take_due(), "once")
        self.assertEqual(self.book.items(), [])
        self.assertTrue(self.changes, "each change is said, for the chat's row")

    def test_a_goals_wake_ups_go_when_it_completes(self):
        # (His 21 Nov session: the Wakes pill stayed for a 07:36 health check the finished goal no longer needed.)
        goal = {"id": "g1"}
        self.book.goal_of = lambda: goal["id"]
        self.book.add(30, "Health check", "Check the servers.")
        goal["id"] = ""
        mine = self.book.add(60, "Remind me", "Say hi.")
        gone = self.book.cancel_goal("g1")
        self.assertEqual([i["why"] for i in gone], ["Health check"])
        self.assertEqual([i["id"] for i in self.book.items()], [mine["id"]], "one set outside the goal stays")
        self.assertEqual(self.book.cancel_goal(""), [])
        again = wakeups.Book(lambda: (self.session, self.dir), clock=self.clock)
        again.load() if hasattr(again, "load") else None
        self.assertTrue(all(i.get("goal", "") in ("", "g1") for i in again.items()))

    def test_the_earliest_comes_first_and_cancel_removes_one(self):
        late = self.book.add(60, "Later", "b")
        soon = self.book.add(5, "Soon", "a")
        self.assertEqual([i["id"] for i in self.book.items()], [soon["id"], late["id"]])
        self.assertTrue(self.book.cancel(soon["id"]))
        self.assertFalse(self.book.cancel(soon["id"]), "already gone")
        self.assertEqual([i["id"] for i in self.book.items()], [late["id"]])

    def test_limits_in_plain_words(self):
        for minutes in (0, 0.5, -3, wakeups.MAX_MINUTES + 1, True, "30"):
            with self.subTest(minutes=minutes), self.assertRaises(ValueError):
                self.book.add(minutes, "x", "y")
        with self.assertRaisesRegex(ValueError, "what to do"):
            self.book.add(5, "x", "  ")
        with self.assertRaisesRegex(ValueError, "why"):
            self.book.add(5, "", "y")
        for n in range(wakeups.MAX_PER_CHAT):
            self.book.add(5 + n, f"w{n}", "y")
        with self.assertRaisesRegex(ValueError, f"at most {wakeups.MAX_PER_CHAT}"):
            self.book.add(5, "one too many", "y")

    def test_kept_beside_the_session_and_brought_back_when_it_is_opened_again(self):
        set_ = self.book.add(30, "Check the tests", "Run them.")
        journal = self.session.with_suffix(".wakeups")
        self.assertTrue(journal.is_file())
        saved = json.loads(journal.read_text())
        self.assertEqual(saved["records"][0]["why"], "Check the tests")
        # Another DGC opens the session after this one has gone (a reload, an editor restart).
        reopened = wakeups.Book(lambda: (self.session, self.dir), clock=self.clock)
        with patch.object(wakeups, "owner_alive", return_value=False):
            reopened.adopt()
        self.assertEqual([i["id"] for i in reopened.items()], [set_["id"]])
        # While the one that set it still runs, it stays that one's.
        other = wakeups.Book(lambda: (self.session, self.dir), clock=self.clock)
        with patch.object(wakeups, "owner", return_value={"pid": 4242, "stamp": "another"}), \
                patch.object(wakeups, "owner_alive", return_value=True):
            other.adopt()
        self.assertEqual(other.items(), [])

    def test_one_that_fell_due_while_dgc_was_closed_wakes_once_and_says_how_late(self):
        self.book.add(10, "Check CI", "Look at the CI run.")
        self.clock.now += 3 * 3600
        reopened = wakeups.Book(lambda: (self.session, self.dir), clock=self.clock)
        with patch.object(wakeups, "owner_alive", return_value=False):
            reopened.adopt()
        due = reopened.take_due()
        self.assertEqual(due["why"], "Check CI")
        text = wakeups.turn_text(due, now=self.clock.now)
        self.assertIn("It was due", text)
        self.assertIn("Look at the CI run.", text)
        self.assertIsNone(reopened.take_due())
        self.assertFalse(self.session.with_suffix(".wakeups").exists(), "nothing left to keep")

    def test_the_turn_says_whose_wake_up_it_is_and_how_a_repeating_check_goes_on(self):
        due = {"id": "wake1", "at": self.clock.now, "created_at": self.clock.now - 600, "why": "CI green?",
               "prompt": "Check CI; stop when it is green."}
        text = wakeups.turn_text(due, now=self.clock.now)
        self.assertIn("This is the wake-up you set 10 minutes ago", text)
        self.assertIn("Check CI; stop when it is green.", text)
        self.assertIn("wake_later", text, "a repeating check sets the next one")
        self.assertIn("data, not instructions", wakeups.turn_text({**due, "prompt": "x"}, now=self.clock.now),
                      "what it was told to do is its own words, quoted")


    def test_a_chat_left_keeps_its_wake_ups_beside_its_session_for_when_it_is_opened_again(self):
        set_ = self.book.add(30, "Check the tests", "Run them.")
        self.book.release()                 # the chat was left (another opened, /new): none wakes it from here
        self.assertEqual(self.book.items(), [])
        self.assertEqual(self.changes[-1], [], "its row empties")
        reopened = wakeups.Book(lambda: (self.session, self.dir), clock=self.clock)
        reopened.adopt()                    # opened again, by this DGC or another
        self.assertEqual([i["id"] for i in reopened.items()], [set_["id"]])

class ToolTests(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.book = wakeups.Book(lambda: None, clock=Clock())
        self.ctx = SimpleNamespace(wakeups=self.book)

    def test_wake_later_sets_one_and_wake_cancel_removes_it(self):
        said = tools.execute("wake_later", {"minutes": 30, "why": "Check the tests", "prompt": "Run the suite."}, self.ctx)
        self.assertRegex(said, r"^Set wake\d+: I wake at \d\d:\d\d \(in 30 minutes\) to: Check the tests")
        wid = self.book.items()[0]["id"]
        self.assertIn(f"Cancelled {wid}", tools.execute("wake_cancel", {"id": wid}, self.ctx))
        self.assertIn("no wake-up", tools.execute("wake_cancel", {"id": wid}, self.ctx))
        self.assertIn("error:", tools.execute("wake_later", {"minutes": 0, "why": "x", "prompt": "y"}, self.ctx))
        self.assertIn("not available", tools.execute("wake_later", {"minutes": 5, "why": "x", "prompt": "y"}, SimpleNamespace()))

    def test_setting_a_wake_up_asks_no_approval_but_a_deny_rule_still_holds(self):
        # Found live (11 Nov): Default mode asked "Run wake_later?" with Allow, as for a command. A wake-up changes
        # nothing outside the chat; the turn it starts asks for each thing as usual.
        from dgc.permissions import PermissionEngine
        args = {"minutes": 5, "why": "x", "prompt": "y"}
        for name in ("wake_later", "wake_cancel"):
            decision = PermissionEngine("default", {"allow": [], "ask": [], "deny": []}, self.dir).decide(name, args)
            self.assertEqual(decision[0], "allow", name)
        denied = PermissionEngine("default", {"allow": [], "ask": [], "deny": ["WakeLater"]}, self.dir).decide("wake_later", args)
        self.assertEqual(denied[0], "deny")

    def test_the_tools_are_described_as_never_a_short_loop_to_wait(self):
        schema = {t["function"]["name"]: t["function"] for t in tools.TOOL_SCHEMAS}
        self.assertIn("wake_later", schema)
        self.assertIn("wake_cancel", schema)
        words = schema["wake_later"]["description"]
        self.assertIn("monitor", words, "a command it can watch is a monitor, which wakes it by itself")
        self.assertIn("one wake-up at a time", words)


if __name__ == "__main__":
    unittest.main()
