"""/goal for one Pip (pips-15): "Keep going until done", with a card showing turns and status, and a real ending:
done, needs you or blocked.

A Personal Pip's conversation can hold one goal. Setting it starts the first turn; each turn is a hidden turn in that
conversation carrying Work's continuation prompt (goals.cycle_prompt: the objective, the completion audit, blocked only
after three turns). The Pip reports with update_goal (offered only in a goal's turn); when a turn ends without it, DGC
starts the next, until done, blocked, a question or card waiting for the user (needs you), the user's Stop, or
MAX_TURNS. The runner's check starts the next turn only when the last one has finished.
"""
import unittest
from unittest import mock

from dgc import goals, pip_chat, pip_goals
from dgc.workspace_registry import RegistryError
from tests import test_pips_local as fixtures


class GoalWorld(unittest.TestCase):
    setUp_base = fixtures.LocalPipsTests.setUp

    def setUp(self):
        self.setUp_base()
        self.cfg.data["pips_enabled"] = True
        self.pip = self.store.create(self.registry.personal()["id"], "Planner", None, "editor-user", pip_type="quill")

    def start(self, objective="Plan my week: list my three priorities, block time for each, and draft the plan."):
        return pip_goals.set_goal(self.store, self.pip["id"], objective, None, "editor-user", self.cfg)

    def hidden(self):
        return [m for m in pip_chat.list_messages(self.store, self.pip["id"], limit=50)["messages"]
                if m["role"] == "user" and m.get("intro")]

    def finish(self, **result):
        run = self.store.claim_next()
        self.store.finish(run["id"], result={"text": result.pop("text", "Worked on it."), **result})
        return run

    def tick(self):
        return pip_goals.tick(self.registry, self.cfg)

    def goal(self):
        return pip_goals.get(self.store, self.pip["id"])["goal"]


class Starting(GoalWorld):
    def test_setting_a_goal_starts_its_first_turn_with_works_continuation_prompt(self):
        goal = self.start()
        self.assertEqual((goal["status"], goal["turns"]), ("active", 0))
        [turn] = self.hidden()
        self.assertIn(goals.CYCLE_MARKER, turn["text"])
        self.assertIn("Plan my week", turn["text"])
        self.assertIn("update_goal", turn["text"])
        # Live, 12 Nov: asked only in words, the question didn't pause it, and the next turn said "still waiting".
        self.assertIn("offer_choices", turn["text"], "it is told how to ask so the goal waits")

    def test_only_a_personal_pip_and_a_real_objective(self):
        with self.assertRaises(RegistryError):
            pip_goals.set_goal(self.store, self.pip["id"], "   ", None, "editor-user", self.cfg)
        project = self.store.create(self.registry.resolve(self.base)["id"], "Reviewer", "Review.", "local-console",
                                    pip_type="rook")
        with self.assertRaises(RegistryError):
            pip_goals.set_goal(self.store, project["id"], "Review everything", None, "editor-user", self.cfg)

    def test_a_new_goal_replaces_the_old_one(self):
        first = self.start("First goal")
        self.finish()
        second = self.start("Second goal")
        self.assertNotEqual(first["id"], second["id"])
        self.assertEqual(pip_goals.get(self.store, self.pip["id"])["goal"]["objective"], "Second goal")


class Carrying(GoalWorld):
    def test_a_turn_without_update_goal_leads_to_the_next_turn(self):
        self.start()
        self.finish(text="Listed the priorities; next I block the time.")
        self.assertEqual((self.goal()["status"], self.goal()["turns"]), ("active", 1))
        self.assertEqual(len(self.hidden()), 1, "the runner starts the next one")
        self.tick()
        self.assertEqual(len(self.hidden()), 2)
        self.tick()
        self.assertEqual(len(self.hidden()), 2, "never a second while the last is still to run")

    def test_completed_is_done(self):
        self.start()
        self.finish(text="All three are planned.", goal_update={"status": "completed", "reason": "Plan written",
                                                               "evidence": ["three priorities listed", "time blocked"]})
        goal = self.goal()
        self.assertEqual((goal["status"], goal["turns"]), ("done", 1))
        self.assertEqual(goal["reason"], "Plan written")
        self.tick()
        self.assertEqual(len(self.hidden()), 1, "a finished goal starts nothing")

    def test_blocked_and_needs_you(self):
        self.start()
        self.finish(goal_update={"status": "blocked", "reason": "No calendar to read"})
        self.assertEqual(self.goal()["status"], "blocked")
        self.start("Another")
        self.finish(text="Which day suits you?", choices=["Monday", "Tuesday"])
        self.assertEqual(self.goal()["status"], "needs_you", "a question waiting for the user pauses it")
        self.tick()
        self.assertEqual(len([m for m in self.hidden() if "Another" in m["text"]]), 1)

    def test_the_turn_limit_ends_it(self):
        self.start()
        for _ in range(pip_goals.MAX_TURNS):
            self.finish()
            self.tick()
        goal = self.goal()
        self.assertEqual((goal["status"], goal["turns"]), ("blocked", pip_goals.MAX_TURNS))
        self.assertIn(str(pip_goals.MAX_TURNS), goal["reason"])

    def test_stop(self):
        goal = self.start()
        stopped = pip_goals.stop(self.store, self.pip["id"], goal["id"], "editor-user")
        self.assertEqual(stopped["status"], "stopped")
        self.finish()
        self.tick()
        self.assertEqual(len(self.hidden()), 1)


class Answering(GoalWorld):
    def test_the_users_answer_carries_it_on(self):
        self.start()
        self.finish(text="Which day suits you?", choices=["Monday", "Tuesday"])
        self.assertEqual(self.goal()["status"], "needs_you")
        pip_chat.send(self.store, self.pip["id"], "Monday", "msg-answer", "editor-user", self.cfg)
        self.tick()
        self.assertEqual(len(self.hidden()), 1, "never while its reply to the answer is still to run")
        self.finish(text="Monday it is.")
        self.assertEqual(self.goal()["status"], "active")
        self.tick()
        self.assertEqual(len(self.hidden()), 2)

    def test_a_card_its_turn_left_waiting_pauses_it(self):
        self.start()                                   # no card waiting when its turn began
        with mock.patch.object(pip_chat, "_cards_waiting", return_value=1):
            self.finish(text="The email is below for you to send.")
        self.assertEqual(self.goal()["status"], "needs_you")

    def test_a_card_from_before_does_not(self):
        with mock.patch.object(pip_chat, "_cards_waiting", return_value=1):
            self.start()
            self.finish(text="Blocked out Monday morning.")
        self.assertEqual(self.goal()["status"], "active")

    def test_a_turn_you_stopped_stops_the_goal(self):
        self.start()
        run = self.store.claim_next()
        self.store.cancel(run["id"], "editor-user")
        self.store.finish(run["id"], result={"text": "Stopped."})
        self.tick()
        goal = self.goal()
        self.assertEqual(goal["status"], "stopped")
        self.tick()
        self.assertEqual(len(self.hidden()), 1)

    def test_its_turn_carries_the_goal_and_the_users_own_message_does_not(self):
        self.start()
        run = self.store.claim_next()
        self.assertEqual(self.store.run(run["id"])["manifest"]["conversation"]["goal"]["turn"], 1)
        self.store.finish(run["id"], result={"text": "Started."})
        pip_chat.send(self.store, self.pip["id"], "How is it going?", "msg-2", "editor-user", self.cfg)
        self.assertNotIn("goal", self.store.run(self.store.claim_next()["id"])["manifest"]["conversation"])


class TheTool(GoalWorld):
    def test_update_goal_is_offered_only_in_a_goals_turn(self):
        self.start()
        [turn] = self.hidden()
        key = self.store.db.execute("SELECT request_key FROM pip_chat_messages WHERE id=?", (turn["id"],)).fetchone()[0]
        context = pip_goals.context_for(self.store, self.pip, {"request_key": key})
        self.assertEqual(context["objective"][:12], "Plan my week")
        self.assertIsNone(pip_goals.context_for(self.store, self.pip, {"request_key": "msg-1"}))
        self.assertEqual(pip_goals.schema()["function"]["name"], "update_goal")

    def test_what_the_tool_takes(self):
        update, told = pip_goals.tool_result({"status": "completed", "reason": "Done", "evidence": ["checked"]})
        self.assertEqual(update["status"], "completed")
        self.assertIn("ends", told)
        bad, told = pip_goals.tool_result({"status": "paused"})
        self.assertIsNone(bad)

    def test_evidence_sent_as_text_is_still_its_lines(self):
        # deepseek-v4.1-flash:cloud, live 12 Nov: evidence came as a JSON string, and was kept one character a line.
        update, _ = pip_goals.tool_result({"status": "completed", "summary": "Plan written",
                                           "evidence": '["Day 1 written: greetings", "Day 2 written: numbers"]'})
        self.assertEqual(update["evidence"], ["Day 1 written: greetings", "Day 2 written: numbers"])
        update, _ = pip_goals.tool_result({"status": "completed", "summary": "Plan written",
                                           "evidence": "All five days written\nEvery day has three tasks"})
        self.assertEqual(update["evidence"], ["All five days written", "Every day has three tasks"])


class TheWorker(GoalWorld):
    def work(self, run, replies):
        import json
        import os
        from dgc import pip_notes, pips
        from dgc.llm import LLMClient
        raw = pip_notes.runtime(self.registry, run, json.loads(self.registry.db.execute(
            "SELECT manifest FROM pip_runs WHERE id=?", (run["id"],)).fetchone()[0]))
        seen, turns = [], iter(replies)

        def chat(client, messages, tools=None, **kwargs):
            seen.append(([t["function"]["name"] for t in (tools or [])], json.dumps(messages)))
            return next(turns)
        with mock.patch.dict(os.environ, {"DGC_SESSION_POLICY": pips._json(pips.native_policy(personal=True))}), \
             mock.patch.object(LLMClient, "chat", chat), mock.patch("dgc.agent.discover_skills", return_value={}), \
             mock.patch("dgc.agent.load_memories", side_effect=AssertionError("No ambient memory")), \
             mock.patch("requests.sessions.Session.request", side_effect=AssertionError("No network")):
            return seen, pips.execute_native(self.cfg, self.root, raw, lambda e: None)

    def test_a_goals_turn_offers_update_goal_and_its_word_ends_the_goal(self):
        from dgc.llm import ChatResult, ToolCall
        self.start()
        run = self.store.claim_next()
        done = {"status": "completed", "summary": "The week is planned",
                "evidence": ["three priorities listed", "time blocked for each", "plan drafted"]}
        seen, result = self.work(run, [ChatResult(content="", tool_calls=[ToolCall("g1", "update_goal", done)]),
                                       ChatResult(content="Your week is planned.")])
        self.assertIn("update_goal", seen[0][0])
        self.assertIn(goals.CYCLE_MARKER, seen[0][1])
        self.assertIn("ends as done", seen[1][1], "it is told what its word does")
        self.assertEqual(result["goal_update"], {"status": "completed", "reason": "The week is planned",
                                                 "evidence": done["evidence"]})
        self.store.finish(run["id"], result=result)
        self.assertEqual((self.goal()["status"], self.goal()["reason"]), ("done", "The week is planned"))
        pip_chat.send(self.store, self.pip["id"], "Thanks!", "msg-thanks", "editor-user", self.cfg)
        seen, result = self.work(self.store.claim_next(), [ChatResult(content="Any time.")])
        self.assertNotIn("update_goal", seen[0][0], "only a goal's turn offers it")
        self.assertNotIn("goal_update", result)


class TheCommands(GoalWorld):
    def test_api_92(self):
        from dgc import pips
        from dgc.headless import PIPS_API_VERSION
        self.assertGreaterEqual(PIPS_API_VERSION, 92)
        for name, args in (("set_pip_goal", {"pip_id", "objective", "conversation_id"}),
                           ("get_pip_goal", {"pip_id", "conversation_id"}), ("stop_pip_goal", {"pip_id", "goal_id"})):
            with self.subTest(name=name):
                self.assertIn(name, pips.CONTROL_COMMANDS)
                self.assertEqual(pips._COMMAND_ARGS[name], args)


if __name__ == "__main__":
    unittest.main()
