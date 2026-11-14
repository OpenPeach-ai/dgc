"""Sub-agents in a Pip's chat (0.52, his calls of 14 Nov; 052-plan/pip-subagents-plan.md, Phase 1).

A fix is a sub-agent's job: Allow (or the level) starts it in a copy of its own made from the Pip's copy; its turns are
runs with no chat rows that run beside the Pip's chat, at most the Pip's slots at once; when it ends the Pip checks its
work in its own chat; PASS puts the change into the Pip's copy three-way (a file the Pip's copy changed meanwhile is held,
never overwritten) and it is the Pip's change as before (Apply, or applied at Do it all); RETRY sends it back with the
Pip's notes, three tries at most, then the Pip says what it tried. The Pip asks in its own words above the Allow card.

Real registry, real runs claimed and finished through PipStore, the real chat send, the real control seam.
"""
from __future__ import annotations

import json
import unittest

from dgc import pip_agents, pip_chat, pip_fixes as fixes, pip_levels as levels
from tests.test_pip_fixes import DONE, TOTAL, FixWorld

PASS = "I checked it: the total now takes the discount off.\nFINDING 1: fixed — the discount is applied\nRESULT: PASS"
RETRY = "Not yet: an empty cart breaks it.\nRESULT: RETRY — handle an empty cart too"


class AgentWorld(FixWorld):
    def allowed(self, findings=(TOTAL,)):
        self.check(list(findings))
        fix = self.one()
        self.control("decide_pip_fix", pip_id=self.helper["id"], fix_id=fix["id"], expected_digest=fix["digest"], allow=True)
        return fix

    def job(self):
        return self.registry.db.execute("SELECT * FROM pip_agent_jobs ORDER BY created_at DESC, rowid DESC LIMIT 1").fetchone()

    def agent_copy(self):
        return pip_agents.copy_root(self.registry, self.helper["id"], self.job()["copy"])

    def try_ends(self, text=DONE, *, edit="def total(items, discount=0):\n    return sum(items) - discount\n"):
        """The sub-agent's try: its run is claimed, it edits its own copy, and ends."""
        row = self.store.claim_next()
        self.assertIsNotNone(row, "its run was queued")
        manifest = json.loads(row["manifest"])
        self.assertIn("agent", manifest, "the claimed run is the sub-agent's")
        if edit is not None:
            (self.agent_copy() / "app.py").write_text(edit)
        self.store.finish(row["id"], result={"text": text, "usage": {"input_tokens": 900, "output_tokens": 200}})
        return row["id"]

    def check_ends(self, text=PASS):
        """The Pip's check: sent on the tick, claimed, and ended with its verdict."""
        self.send()
        row = self.store.claim_next()
        self.assertIsNotNone(row, "the Pip's check was queued in its chat")
        self.assertNotIn("agent", json.loads(row["manifest"]))
        self.store.finish(row["id"], result={"text": text})
        return row["id"]


class AFixIsASubAgentsJob(AgentWorld, unittest.TestCase):
    def test_the_pip_asks_in_its_own_words_above_the_allow_card(self):
        self.check([TOTAL])
        self.assertEqual(self.one()["message"], "Want me to fix this?")

    def test_allow_starts_a_sub_agent_in_its_own_copy_with_no_chat_rows(self):
        self.allowed()
        job = self.job()
        self.assertEqual((job["state"], job["tries"], job["kind"]), ("working", 1, "fix"))
        self.assertTrue((self.agent_copy() / "app.py").is_file(), "its own copy, made from the Pip's")
        self.assertNotEqual(self.agent_copy(), self.home(), "never the Pip's copy")
        rows = self.registry.db.execute("SELECT count(*) FROM pip_chat_messages WHERE run_id=?", (job["run_id"],)).fetchone()[0]
        self.assertEqual(rows, 0, "a sub-agent's turn is never in the Pip's chat")
        fix = self.one()
        self.assertEqual(fix["state"], "running")
        self.assertEqual((fix["agent"]["try"], fix["agent"]["tries"]), (1, 3))

    def test_its_run_passes_the_executors_own_check_of_a_turn(self):
        # Live test 15 Nov: every sub-agent run failed at once ("The conversation a reply belongs to is named by its
        # id"): its manifest named no conversation as None, which the executor's check refuses. Run the same check.
        self.allowed()
        manifest = json.loads(self.registry.db.execute("SELECT manifest FROM pip_runs WHERE id=?", (self.job()["run_id"],)).fetchone()[0])
        pip_chat.validate_context(manifest["conversation"])

    def test_a_sub_agents_run_is_never_the_pips_last_report(self):
        # Live test 15 Nov: the Pip's chat attaches "the last report" (its latest finished run with no chat rows); a
        # sub-agent's run has none by design, so every message into that chat (the Pip's check, and yours) failed:
        # "The previous source result has an unsupported kind." (The fake clock tied every finish, which hid it.)
        self.allowed()
        run_id = self.try_ends()
        with self.registry.transaction():
            self.registry.db.execute("UPDATE pip_runs SET finished_at='2999-01-01T00:00:00.000Z' WHERE id=?", (run_id,))
        report = pip_chat._last_report(self.store, self.helper["id"])
        self.assertTrue(report is None or report.get("run_id") != run_id)
        pip_chat.send(self.store, self.helper["id"], "how did it go?", "you-after", "editor-user", self.cfg)

    def test_it_runs_beside_the_pips_chat(self):
        self.allowed()
        agent_run = self.store.claim_next()
        self.assertIn("agent", json.loads(agent_run["manifest"]))
        pip_chat.send(self.store, self.helper["id"], "how is it going?", "you-1", "editor-user", self.cfg)
        chat_run = self.store.claim_next()
        self.assertIsNotNone(chat_run, "the Pip answers you while its sub-agent works")
        self.assertNotIn("agent", json.loads(chat_run["manifest"]))

    def test_pass_puts_the_change_in_the_pips_copy_and_it_is_the_pips_change(self):
        self.allowed()
        before = (self.root / "app.py").read_text()
        self.try_ends()
        self.assertEqual(self.job()["state"], "check_due")
        self.check_ends(PASS)
        self.assertEqual(self.job()["state"], "merged")
        self.assertIn("discount", (self.home() / "app.py").read_text(), "in the Pip's copy now")
        self.assertEqual((self.root / "app.py").read_text(), before, "your folder untouched until you apply it")
        fix = self.one()
        self.assertEqual(fix["state"], "ready")
        self.assertEqual(fix["findings"][0]["verdict"], "fixed")
        self.assertEqual(fix.get("tests"), "passed")
        self.assertIn("discount", fix["message"], "the Pip's own words from its check")

    def test_the_check_is_a_message_from_dgc_with_the_change(self):
        self.allowed()
        self.try_ends()
        self.send()
        message = self.registry.db.execute("SELECT text,request_key FROM pip_chat_messages WHERE pip_id=? AND role='user' "
                                           "ORDER BY seq DESC LIMIT 1", (self.helper["id"],)).fetchone()
        self.assertTrue(message["request_key"].startswith(pip_agents.CHECK_KEY))
        self.assertIn("This message is from DGC", message["text"])
        self.assertIn("+    return sum(items) - discount", message["text"], "the change, as a diff")
        listed = pip_chat.list_messages(self.store, self.helper["id"])["messages"]
        self.assertTrue(all(m.get("intro") for m in listed if m["role"] == "user"), "no bubble for DGC's message")

    def test_retry_sends_it_back_with_the_notes_three_tries_at_most(self):
        self.allowed()
        for attempt in (1, 2, 3):
            self.try_ends()
            self.check_ends(RETRY)
            if attempt < 3:
                self.assertEqual(self.job()["state"], "retry_due")
                self.send()
                self.assertEqual(self.job()["tries"], attempt + 1)
                manifest = self.registry.db.execute("SELECT manifest FROM pip_runs WHERE id=?", (self.job()["run_id"],)).fetchone()[0]
                self.assertIn("handle an empty cart too", json.loads(manifest)["conversation"]["text"], "the Pip's notes go with it")
        self.assertEqual(self.job()["state"], "asked")
        fix = self.one()
        self.assertIn("It tried 3 times", fix["message"])
        self.assertNotIn("discount", (self.home() / "app.py").read_text(), "nothing reached the Pip's copy")

    def test_a_file_the_pips_copy_changed_meanwhile_is_held_never_overwritten(self):
        self.allowed()
        (self.home() / "app.py").write_text("def total(items):\n    return sum(items)  # the Pip changed this\n")
        self.try_ends()
        self.check_ends(PASS)
        self.assertEqual(self.job()["state"], "held")
        self.assertIn("the Pip changed this", (self.home() / "app.py").read_text())
        fix = self.one()
        self.assertEqual(fix["state"], "held")
        self.assertIn("app.py", fix["message"])

    def test_do_it_all_applies_what_the_pip_passed(self):
        self.choose(levels.FULL)
        self.check([TOTAL])
        self.send()
        self.try_ends()
        self.check_ends(PASS)
        self.assertIn("discount", (self.root / "app.py").read_text(), "applied to your folder, with Undo")
        self.assertEqual(self.one()["state"], "applied")

    def test_a_failed_try_is_said_never_retried_by_itself(self):
        self.allowed()
        row = self.store.claim_next()
        self.store.finish(row["id"], error={"code": "model_error", "message": "the model refused"})
        self.assertEqual(self.job()["state"], "failed")
        self.assertEqual(self.one()["state"], "failed")

    def test_its_slots_one_at_a_time_unless_raised(self):
        self.allowed()
        second = pip_agents.start(self.store, self.cfg, self.helper["id"], kind="fix", title="Another", brief="Do another thing.")
        first_run = self.store.claim_next()
        self.assertIn("agent", json.loads(first_run["manifest"]))
        self.assertIsNone(self.store.claim_next(), "one sub-agent at a time by default")
        pip_agents.set_slots(self.registry, self.helper["id"], 2)
        again = self.store.claim_next()
        jobs = {json.loads(run["manifest"])["agent"]["job_id"] for run in (first_run, again)}
        self.assertEqual(len(jobs), 2, "the other one runs once the Pip may run two")
        self.assertIn(second["id"], jobs)
        with self.assertRaises(Exception):
            pip_agents.set_slots(self.registry, self.helper["id"], 5)        # 4 at most, unless Dev Mode lifts it

    def test_stop_ends_it_and_nothing_reaches_the_pips_copy(self):
        self.allowed()
        self.store.claim_next()
        job = self.job()
        pip_agents.stop(self.store, self.helper["id"], job["id"], "editor-user")
        self.assertEqual(self.job()["state"], "stopped")
        self.assertEqual(self.one()["state"], "stopped")

    def test_the_commands_list_stop_and_set_are_yours_alone(self):
        self.allowed()
        listed = self.control("list_pip_agents", pip_id=self.helper["id"])
        self.assertEqual((listed["slots"], len(listed["agents"]), listed["agents"][0]["state"]), (1, 1, "working"))
        self.assertEqual(self.control("set_pip_agents", pip_id=self.helper["id"], slots=4)["slots"], 4)
        stopped = self.control("stop_pip_agent", pip_id=self.helper["id"], agent_id=listed["agents"][0]["id"])
        self.assertEqual(stopped["agent"]["state"], "stopped")
        from dgc import pips
        with self.assertRaises(Exception):
            pip_fixes_control = fixes.control(self.store, "list_pip_agents", {"pip_id": self.helper["id"]}, "device_1", self.cfg)

    def test_only_dgc_starts_a_sub_agent(self):
        with self.assertRaises(Exception):
            self.store.enqueue(self.helper["id"], "k", "editor-user", self.cfg, conversation_request={
                "text": "x", "request_key": "dgcagent_x", "agent": {"job_id": "pipagent_" + "a" * 32, "copy": "agents/x/y"}})


class TryAgainLeaveItAndWhatTheChatShows(AgentWorld, unittest.TestCase):
    """What the Pip's chat needs (the screens' report, 14 Nov): Try again / Leave it after the last try, an asked fix that
    reads "asked", the check's reply marked with its machine lines hidden, the Pip's own reason for a retry, times."""

    def asked(self):
        fix = self.allowed()
        for _ in range(3):
            self.try_ends()
            self.check_ends(RETRY)
            if self.job()["state"] == "retry_due":
                self.send()
        return fix

    def test_an_asked_fix_reads_asked(self):
        self.asked()
        self.assertEqual(self.one()["state"], "asked")
        self.assertEqual(self.one()["agent"]["state"], "asked")

    def test_try_again_starts_a_fresh_sub_agent_with_what_it_learned(self):
        fix = self.asked()
        first = self.job()["id"]
        out = self.control("retry_pip_fix", pip_id=self.helper["id"], fix_id=fix["id"], again=True)
        self.assertEqual(out["fix"]["state"], "running")
        job = self.job()
        self.assertNotEqual(job["id"], first, "a fresh sub-agent job")
        self.assertEqual((job["state"], job["tries"]), ("working", 1))
        manifest = self.registry.db.execute("SELECT manifest FROM pip_runs WHERE id=?", (job["run_id"],)).fetchone()[0]
        self.assertIn("handle an empty cart too", json.loads(manifest)["conversation"]["text"], "what the last check said")

    def test_leave_it_ends_it_and_it_is_never_asked_again(self):
        fix = self.asked()
        out = self.control("retry_pip_fix", pip_id=self.helper["id"], fix_id=fix["id"], again=False)
        self.assertEqual(out["fix"]["state"], "left")
        self.assertEqual(out["fix"]["agent"]["state"], "left")
        self.assertIsNone(self.store.claim_next(), "nothing starts")
        with self.assertRaises(Exception):
            self.control("retry_pip_fix", pip_id=self.helper["id"], fix_id=fix["id"], again=True)

    def test_a_held_fix_can_be_tried_again_from_the_pips_copy_as_it_is_now(self):
        fix = self.allowed()
        (self.home() / "app.py").write_text("def total(items):\n    return sum(items)  # the Pip changed this\n")
        self.try_ends()
        self.check_ends(PASS)
        self.assertEqual(self.one()["state"], "held")
        self.control("retry_pip_fix", pip_id=self.helper["id"], fix_id=fix["id"], again=True)
        self.assertIn("the Pip changed this", (self.agent_copy() / "app.py").read_text(), "made from the Pip's copy now")

    def test_only_an_ended_fix_is_tried_again(self):
        fix = self.allowed()
        with self.assertRaises(Exception):
            self.control("retry_pip_fix", pip_id=self.helper["id"], fix_id=fix["id"], again=True)

    def test_the_checks_reply_is_marked_and_its_machine_lines_are_hidden(self):
        self.allowed()
        self.try_ends()
        check_run = self.check_ends(PASS)
        reply = self.registry.db.execute("SELECT id FROM pip_chat_messages WHERE run_id=? AND role='assistant'",
                                         (check_run,)).fetchone()
        if reply is None:            # the stand-in finish writes no reply row: write the Pip's reply as the chat would
            pip_chat.insert_reply(self.store, self.store.run(check_run), PASS) if hasattr(pip_chat, "insert_reply") else None
        listed = pip_chat.list_messages(self.store, self.helper["id"])["messages"]
        mine = [m for m in listed if m["role"] == "assistant" and m["run_id"] == check_run]
        self.assertEqual(len(mine), 1)
        self.assertTrue(mine[0].get("check"), "marked: the chat shows the fix's message instead")
        self.assertNotIn("RESULT:", mine[0]["text"])
        self.assertNotIn("FINDING 1", mine[0]["text"])
        self.assertIn("discount", mine[0]["text"])

    def test_an_older_fix_turns_reply_never_shows_the_lines_meant_for_dgc(self):
        # Live test 14 Nov: a fix's reply from before sub-agents showed "FINDING 1: fixed — … TESTS: not run" run
        # together in the chat. Those lines are for DGC; the chat shows the rest.
        pip_chat.send(self.store, self.helper["id"], "fix these", "you-older", "editor-user", self.cfg)
        run = self.store.claim_next()
        self.store.finish(run["id"], result={"text": "I fixed all three.\nFINDING 1: fixed — the discount\nTESTS: not run"})
        with self.registry.transaction():                     # as an older DGC's fix turn kept it
            self.registry.db.execute("UPDATE pip_chat_messages SET request_key=? WHERE run_id=? AND role='user'",
                                     ("dgcfix_" + "e" * 32, run["id"]))
        listed = pip_chat.list_messages(self.store, self.helper["id"])["messages"]
        reply = [m for m in listed if m["role"] == "assistant" and m["run_id"] == run["id"]][0]
        self.assertEqual(reply["text"], "I fixed all three.")

    def test_the_pip_says_why_it_sent_it_back(self):
        self.allowed()
        self.try_ends()
        self.check_ends(RETRY)
        agent = self.one()["agent"]
        self.assertEqual(agent["said"], "Not yet: an empty cart breaks it.")

    def test_its_check_run_and_times_are_shown(self):
        self.allowed()
        self.try_ends()
        self.send()
        self.assertTrue(self.one()["agent"].get("check_run_id"), "the editor hides the check's live words by this run")
        row = self.store.claim_next()
        self.store.finish(row["id"], result={"text": PASS})
        agent = self.one()["agent"]
        self.assertTrue(agent["started_at"] and agent["ended_at"])
        self.assertLessEqual(agent["started_at"], agent["ended_at"])

    def test_a_sub_agents_steps_are_kept(self):
        self.allowed()
        run = self.store.claim_next()
        page = self.store.run_activity(run["id"])
        events = page.get("events") or page.get("activity") or []
        self.assertTrue(events, "Steps reads list_pip_run_activity on the sub-agent's run")


class BuildLeftoversNeverBecomeAChange(AgentWorld, unittest.TestCase):
    """Live test 14 Nov (DeepSeek, Tile checker): the fix ran the tests in its copy, and Apply then offered a second card
    of four __pycache__/*.pyc files ("new, not text"). What running code leaves behind is never offered as a change, even
    when the project's own ignore rules don't name it."""

    LEFTOVERS = ("__pycache__/app.cpython-312.pyc", "tests/__pycache__/test_app.cpython-312.pyc", ".pytest_cache/v/cache/nodeids",
                 "app.pyc", ".DS_Store", ".mypy_cache/3.12/app.meta.json", "node_modules/left/index.js", ".coverage")

    def leave_leftovers(self, root):
        for rel in self.LEFTOVERS:
            (root / rel).parent.mkdir(parents=True, exist_ok=True)
            (root / rel).write_bytes(b"\x00leftover")

    def test_a_sub_agents_leftovers_never_reach_the_pips_copy(self):
        self.allowed()
        row = self.store.claim_next()
        (self.agent_copy() / "app.py").write_text("def total(items, discount=0):\n    return sum(items) - discount\n")
        self.leave_leftovers(self.agent_copy())
        self.store.finish(row["id"], result={"text": DONE})
        self.assertEqual([f["path"] for f in pip_agents.change(self.registry, self.job())], ["app.py"])
        self.check_ends(PASS)
        for rel in self.LEFTOVERS:
            self.assertFalse((self.home() / rel).exists(), rel)

    def test_leftovers_already_in_the_copy_are_never_its_change_either(self):
        # Live test 15 Nov: the Pip's copy already held __pycache__ from an earlier run, so the sub-agent's new .pyc
        # counted as "changed"; their bytes went into the check, and the chat refused it (a NUL): it hung at check_due.
        self.check([TOTAL])
        fix = self.one()
        (self.home() / "__pycache__").mkdir(parents=True, exist_ok=True)
        (self.home() / "__pycache__" / "app.cpython-312.pyc").write_bytes(b"\x00old")
        self.control("decide_pip_fix", pip_id=self.helper["id"], fix_id=fix["id"], expected_digest=fix["digest"], allow=True)
        row = self.store.claim_next()
        (self.agent_copy() / "__pycache__").mkdir(exist_ok=True)
        (self.agent_copy() / "app.py").write_text("def total(items, discount=0):\n    return sum(items) - discount\n")
        (self.agent_copy() / "__pycache__" / "app.cpython-312.pyc").write_bytes(b"\x00new\x00bytes")
        base = json.loads(self.job()["base"])                 # as when its copy started with the old .pyc in it
        base["__pycache__/app.cpython-312.pyc"] = "0" * 64
        with self.registry.transaction():
            self.registry.db.execute("UPDATE pip_agent_jobs SET base=? WHERE id=?", (json.dumps(base), self.job()["id"]))
        self.store.finish(row["id"], result={"text": DONE})
        self.assertEqual([f["path"] for f in pip_agents.change(self.registry, self.job())], ["app.py"])

    def test_a_binary_file_is_named_in_the_check_never_pasted(self):
        self.allowed()
        row = self.store.claim_next()
        (self.agent_copy() / "logo.png").write_bytes(b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR")
        self.store.finish(row["id"], result={"text": DONE})
        text = pip_agents.diff_text(self.registry, self.job(), pip_agents.change(self.registry, self.job()))
        self.assertNotIn("\x00", text)
        self.assertIn("logo.png", text)
        self.assertIn("binary", text)

    def test_a_check_that_cant_be_sent_ends_the_job_and_says_why(self):
        # The tick swallowed the error and tried again forever: "1 sub-agent" with nothing happening. A refusal that
        # isn't a busy chat ends the job, and the Pip's message says it.
        from unittest import mock
        from dgc.workspace_registry import RegistryError
        self.allowed()
        self.try_ends()
        with mock.patch.object(pip_chat, "_send_in", side_effect=RegistryError("invalid_request", "Conversation message is empty or not text.")):
            self.send()
        self.assertEqual(self.job()["state"], "failed")
        fix = self.one()
        self.assertEqual(fix["state"], "failed")
        self.assertIn("check", fix["message"])

    def test_the_pips_change_never_lists_leftovers_in_its_copy(self):
        self.allowed()
        self.try_ends()
        self.check_ends(PASS)
        self.leave_leftovers(self.home())                     # the Pip itself ran the tests in its copy afterwards
        from dgc import pip_project_copies
        pip_project_copies.refresh(self.store, self.helper["id"])
        changes = self.control("list_pip_project_changes", pip_id=self.helper["id"])["changes"]
        paths = sorted({f["path"] for c in changes for f in c.get("files", [])})
        self.assertEqual(paths, ["app.py"])


if __name__ == "__main__":
    unittest.main()
