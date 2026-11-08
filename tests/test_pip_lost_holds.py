"""A held submit lost to a restart says so, and the Pip redoes that step (Pips package 3).

A Pip's computer holds a form submit or a payment for the user's Allow in its own browser, so an update, a restart or
Stop computer loses it, unsent. Before this, `tick` marked it lost and told nobody: the card's line read "Not sent" and
the Pip never knew. Now the line says why, and after a restart the Pip is told, once, that nothing was sent and does that
step again (held for the user's Allow again). After the user's own Stop computer it isn't redone.
"""
import json
import unittest
import unittest.mock

from dgc import pip_chat, pip_computer
from tests import test_pip_three_asks as three_asks


class LostToARestart(unittest.TestCase):
    setUp, held, follow_ups = three_asks.RejectFollowUp.setUp, three_asks.RejectFollowUp.held, three_asks.RejectFollowUp.follow_ups

    def tick(self, times=2):
        for _ in range(times):                 # one marks it lost (no browser holds it now), the next tells the Pip
            pip_computer.tick(self.registry, self.cfg)

    def lost_turns(self, pip):
        return sum(1 for (key,) in self.registry.db.execute("SELECT request_key FROM pip_chat_messages WHERE pip_id=?", (pip["id"],))
                   if str(key or "").startswith("computer_lost_"))

    def row(self, pip, action_id):
        [row] = [a for a in pip_computer.list_actions(self.registry, pip["id"]) if a["id"] == action_id]
        return row

    def test_a_restart_loses_a_held_payment_and_the_pip_redoes_that_step_once(self):
        pip, run, action_id, _ = self.held(payment=True)
        self.tick()
        row = self.row(pip, action_id)
        self.assertEqual((row["status"], row["resolved_by"]), ("lost", "pip-restart"))
        [told] = self.follow_ups(pip)
        self.assertIn("DGC restarted before a payment: POST to pay.sunrisehospital.example/api/pay could be sent, "
                      "so nothing was sent", told["text"])
        self.assertIn("Do that step once more now", told["text"])
        self.assertIn("DGC holds it for the user's Allow again", told["text"])
        self.assertEqual(self.row(pip, action_id)["continuation_run_id"], told["run_id"])
        self.assertEqual(self.lost_turns(pip), 1, "its own key, computer_lost_<action>")
        self.store.cancel(told["run_id"], "local-console")
        self.tick()
        self.assertEqual(len(self.follow_ups(pip)), 1, "once")

    def test_an_allowed_submit_lost_before_it_went_is_redone_too(self):
        pip, run, action_id, digest = self.held()
        pip_computer.decide(self.registry, action_id, digest, True, "editor-user")
        self.tick()
        self.assertEqual(self.row(pip, action_id)["status"], "lost")
        self.assertEqual(self.row(pip, action_id)["resolved_by"], "pip-restart")
        [told] = self.follow_ups(pip)
        self.assertIn("POST to pay.sunrisehospital.example/api/pay", told["text"])

    def test_a_busy_chat_gets_it_on_a_later_tick(self):
        pip, run, action_id, _ = self.held(payment=True)
        pip_computer.tick(self.registry, self.cfg)                       # lost
        with unittest.mock.patch.object(pip_chat, "send", side_effect=pip_computer.RegistryError("conversation_busy", "busy")):
            pip_computer.tick(self.registry, self.cfg)
        self.assertEqual(self.follow_ups(pip), [])
        pip_computer.tick(self.registry, self.cfg)
        self.assertEqual(len(self.follow_ups(pip)), 1)

    def test_not_redone_after_the_users_own_stop_once_they_wrote_or_when_it_would_have_lapsed(self):
        pip, run, action_id, _ = self.held(payment=True)
        with self.registry.transaction():
            self.registry.db.execute("INSERT INTO metadata VALUES(?,?)", ("computer_stop:" + pip["id"], pip_computer._now()))
        pip_computer.handle_stops(self.registry)
        self.tick()
        row = self.row(pip, action_id)
        self.assertEqual((row["status"], row["resolved_by"]), ("lost", "pip-computer-stop"))
        self.assertEqual(self.follow_ups(pip), [], "the user stopped it: nothing is redone")

        pip2, _, action2, _ = self.held(payment=True)
        later = pip_chat.send(self.store, pip2["id"], "never mind that bill", "k-later", "editor-user", self.cfg)["run"]
        self.tick()
        self.assertEqual(self.follow_ups(pip2), [], "the user moved on")
        self.store.cancel(later["id"], "local-console")

        pip3, _, action3, _ = self.held(payment=True)
        with self.registry.transaction():
            self.registry.db.execute("PRAGMA defer_foreign_keys=ON")
            self.registry.db.execute("DROP TRIGGER immutable_pip_computer_action")
            self.registry.db.execute("UPDATE pip_computer_actions SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?", (action3,))
        self.tick()
        self.assertEqual(self.follow_ups(pip3), [], "it would have lapsed anyway")

    def test_a_run_going_again_after_the_restart_redoes_it_itself(self):
        pip, run, action_id, _ = self.held(payment=True)
        with self.registry.transaction():
            self.registry.db.execute("UPDATE pip_runs SET status='queued',finished_at=NULL WHERE id=?", (run["id"],))
        self.tick()
        self.assertEqual(self.lost_turns(pip), 0, "no second turn beside the run's own")
        self.assertEqual(self.row(pip, action_id)["continuation_run_id"], run["id"])


if __name__ == "__main__":
    unittest.main()
