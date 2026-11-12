"""pips-19: Core keeps an eye on your day. Once, after the user's first reply from Core, DGC offers a daily routine on
Core as an ordinary card (Add or Not now): one short message a day about what needs the user today (what waits for their
answer, important email, today's meetings, what their Pips did), read only, and nothing on a day with nothing to say.
Offered once: Not now, or a routine of that name already there, means it never comes back."""
import unittest

from dgc import pip_chat, pip_core_daily as daily, pip_routines
from tests import test_pips_local as fixtures


class CoreDailyTests(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp

    def reply(self, pip, text="What can you do?", key=None, result_text="I can help with your day."):
        import hashlib
        sent = pip_chat.send(self.store, pip["id"], text, key or "k" + hashlib.sha256(text.encode()).hexdigest()[:20], "editor-user", self.cfg)
        run = self.store.claim_next()
        self.assertEqual(run["id"], sent["run"]["id"])
        self.store.finish(run["id"], result={"text": result_text})
        return run

    def suggested(self, pip):
        return [r for r in pip_routines.listing(self.store, pip["id"])["routines"] if r["status"] == "suggested"]

    def test_core_offers_its_day_routine_once_as_a_card_after_the_first_reply(self):
        core = self.store.create(self.registry.personal()["id"], "Core", None, "editor-user", pip_type="core")
        run = self.reply(core)
        [card] = self.suggested(core)
        self.assertEqual(card["title"], daily.TITLE)
        self.assertEqual(card["run_id"], run["id"], "under the reply it followed")
        self.assertEqual(card["trigger"]["kind"], "schedule")
        self.assertEqual((card["trigger"]["schedule"]["type"], card["trigger"]["schedule"]["time"]), ("daily", daily.TIME))
        for words in ("read only", "stay quiet", "meetings", "email", "Pips"):
            self.assertIn(words.lower(), card["prompt"].lower())
        # Not now: it never comes back, on later replies either.
        pip_routines.decide(self.store, core["id"], card["id"], False)
        self.reply(core, "And tomorrow?")
        self.assertEqual(self.suggested(core), [])

    def test_only_core_and_only_after_a_message_from_the_user(self):
        other = self.store.create(self.registry.personal()["id"], "Inbox", "Mail", "editor-user", pip_type="lens")
        self.reply(other)
        self.assertEqual(self.suggested(other), [], "another Pip is never offered it")

    def test_a_routine_of_that_name_already_there_means_no_card(self):
        core = self.store.create(self.registry.personal()["id"], "Core", None, "editor-user", pip_type="core")
        pip_routines.add(self.store, core["id"], daily.TITLE, "My own words.", {"kind": "schedule",
                         "schedule": {"type": "daily", "time": "07:00", "timezone": "UTC"}})
        self.reply(core)
        self.assertEqual(self.suggested(core), [])


if __name__ == "__main__":
    unittest.main()
