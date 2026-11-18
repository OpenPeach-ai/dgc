"""The fix by level, in the Pip's own chat (0.52, Pips API 96; pips-flow-design §1, Q3, Q6, his answers 14 Nov).

A folder Pip with a box finishes a check that found something. Its level decides: Ask me first waits at the ordinary
Allow card; Approve for me fixes new findings by itself and the change waits at Apply; Do it all fixes and applies by
itself with Undo, except a big, deleting or test-failing change, which waits at Apply. The fix is the Pip's own turn
in its chat (a message from DGC), ending with one verdict line per finding and its tests; "needs you" becomes one
waiting item (I've done it · Remind me later · Not a problem). One try per finding; Not now is never asked again.

Real registry, real runs finished through PipStore.finish, the real chat send, the real control seam.
"""
from __future__ import annotations

import json
import unittest
from unittest.mock import patch

from dgc import pip_attention, pip_chat, pip_fixes as fixes, pip_levels as levels, pip_project_copies as copies, pips
from dgc.workspace_context import ContextStore
from dgc.workspace_registry import RegistryError, identifier
from tests.test_folder_pip_wall import WithABox

TOTAL = {"title": "Total ignores the discount", "severity": "high", "path": "app.py", "line": 2,
         "evidence": "    return sum(items)", "verification": "source_excerpt_only"}
FLAG = {"title": "X is a magic number", "severity": "low", "path": "util.py", "line": 1,
        "evidence": "X = 1", "verification": "source_excerpt_only"}
DONE = ("I changed total to apply the discount and left X alone: it is used by the tests.\n"
        "FINDING 1: fixed — total now subtracts the discount\nTESTS: passed")


class FixWorld(WithABox):
    def check(self, findings, pip=None):
        """A check (an audit) of the helper that ended well, finished by PipStore as the runner does."""
        pip = pip or self.helper
        binding = self.registry.binding(self.workspace["id"])
        run_id = identifier("run")
        manifest = {"pip_id": pip["id"], "workspace_id": self.workspace["id"], "job_version": pip["current_version"],
                    "source_revision": "a" * 40, "model": "fixture-model", "run_kind": "audit",
                    "workspace_context": ContextStore(self.registry).snapshot(self.workspace["id"])}
        self.registry.db.execute("""INSERT INTO pip_runs
            (id,pip_id,workspace_id,binding_id,idempotency_key,requested_by,manifest,status,created_at,started_at)
            VALUES(?,?,?,?,?,?,?,?,?,?)""", (run_id, pip["id"], self.workspace["id"], binding["id"], run_id,
                                              "local-scheduler", json.dumps(manifest), "running",
                                              self.registry.clock(), self.registry.clock()))
        self.store.finish(run_id, result={"summary": "Checked the shop.", "findings": list(findings),
                                          "limitations": [], "tests_executed": False})
        return run_id

    def fixes(self):
        return self.control("list_pip_fixes", pip_id=self.helper["id"])

    def one(self):
        [fix] = self.fixes()["fixes"]
        return fix

    def send(self):
        return fixes.send_due(self.registry, self.cfg)

    def fix_turn_ends(self, text=DONE, *, edit=True):
        """Its fix (0.52, sub-agents): the sub-agent's try (claimed, it edits its own copy, it ends), then the Pip's
        check in its chat (its verdict lines and RESULT: PASS), which puts the change into the Pip's copy."""
        from dgc import pip_agents
        row = self.store.claim_next()
        self.assertIsNotNone(row, "the sub-agent's run was queued")
        self.assertIn("agent", json.loads(row["manifest"]), "a fix is a sub-agent's job")
        if edit:
            job = self.registry.db.execute("SELECT * FROM pip_agent_jobs WHERE run_id=?", (row["id"],)).fetchone()
            copy = pip_agents.copy_root(self.registry, self.helper["id"], job["copy"])
            (copy / "app.py").write_text("def total(items):\n    return sum(items) + 0\n")
        self.store.finish(row["id"], result={"text": text, "usage": {"input_tokens": 1200, "output_tokens": 340}})
        self.send()
        check = self.store.claim_next()
        self.assertIsNotNone(check, "the Pip's check was queued in its chat")
        self.store.finish(check["id"], result={"text": text + "\nRESULT: PASS"})
        return row["id"]


class AtAskMeFirst(FixWorld, unittest.TestCase):
    def test_a_check_that_found_something_asks_with_the_ordinary_allow_card(self):
        run = self.check([TOTAL, FLAG])
        fix = self.one()
        self.assertEqual((fix["state"], fix["count"], fix["run_id"], fix["by"]), ("ask", 2, run, ""))
        self.assertEqual([f["title"] for f in fix["findings"]], [TOTAL["title"], FLAG["title"]])
        self.assertTrue(all(f["verdict"] == "open" and f["state"] == "new" for f in fix["findings"]))
        self.assertTrue(fixes.FIX.match(fix["id"]))
        self.assertEqual(self.fixes()["folder"], "shop")
        self.assertEqual(self.send(), 0, "nothing runs before Allow")

    def test_allow_starts_the_fix_as_a_sub_agents_job(self):
        self.check([TOTAL])
        fix = self.one()
        answer = self.control("decide_pip_fix", pip_id=self.helper["id"], fix_id=fix["id"],
                              expected_digest=fix["digest"], allow=True)
        self.assertEqual((answer["fix"]["state"], answer["fix"]["by"]), ("running", "you"))
        job = self.registry.db.execute("SELECT * FROM pip_agent_jobs WHERE fix_id=?", (fix["id"],)).fetchone()
        self.assertIn("This message is from DGC", job["brief"])
        self.assertIn("Total ignores the discount — app.py:2", job["brief"])
        self.assertIn("FINDING n: fixed", job["brief"])
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM pip_chat_messages WHERE pip_id=?",
                                                  (self.helper["id"],)).fetchone()[0], 0, "nothing in the Pip's chat yet")

    def test_not_now_leaves_it_and_the_next_check_does_not_ask_again(self):
        self.check([TOTAL])
        fix = self.one()
        self.control("decide_pip_fix", pip_id=self.helper["id"], fix_id=fix["id"], expected_digest=fix["digest"], allow=False)
        self.assertEqual(self.one()["state"], "declined")
        self.check([TOTAL])
        self.assertEqual(len(self.fixes()["fixes"]), 1, "no re-ask")

    def test_an_answer_on_an_old_view_is_refused(self):
        self.check([TOTAL])
        old = self.one()
        self.check([TOTAL, FLAG])                         # it waits still: now it asks about both
        fix = self.one()
        self.assertEqual((fix["id"], fix["count"]), (old["id"], 2), "one row per Pip: the same Allow card, updated")
        with self.assertRaises(RegistryError) as raised:
            self.control("decide_pip_fix", pip_id=self.helper["id"], fix_id=old["id"], expected_digest=old["digest"], allow=True)
        self.assertEqual(raised.exception.code, "conflict")

    def test_only_you_answer_a_fix(self):
        self.check([TOTAL])
        fix = self.one()
        with self.assertRaises(RegistryError):
            self.control("decide_pip_fix", actor="device_1", pip_id=self.helper["id"], fix_id=fix["id"],
                         expected_digest=fix["digest"], allow=True)

    def test_its_allow_card_is_in_needs_attention(self):
        self.check([TOTAL, FLAG])
        fix = self.one()
        page = self.control("list_pip_attention", projects="all")
        [row] = [i for i in page["items"] if i["kind"] == "fix_ask"]
        self.assertEqual((row["card"], row["pip_id"], row["title"]), (fix["id"], self.helper["id"], "Fix 2 things?"))
        self.assertEqual(row["id"], "fix_ask:" + fix["id"])


class TheFixTurn(FixWorld, unittest.TestCase):
    def allowed(self, findings=(TOTAL,)):
        self.check(list(findings))
        fix = self.one()
        self.control("decide_pip_fix", pip_id=self.helper["id"], fix_id=fix["id"], expected_digest=fix["digest"], allow=True)
        return fix

    def test_when_it_ends_its_verdicts_tests_and_change_are_on_the_fix(self):
        self.allowed()
        run = self.fix_turn_ends()
        fix = self.one()
        self.assertEqual((fix["state"], fix["fix_run_id"], fix["tests"]), ("ready", run, "passed"))
        self.assertEqual(fix["tokens"], 1540, "what the fix cost (his answer 1: cost shown)")
        self.assertEqual((fix["findings"][0]["verdict"], fix["findings"][0]["why"]),
                         ("fixed", "total now subtracts the discount"))
        self.assertTrue(fixes.CHANGE.match(fix["change_id"]))
        self.assertIn("left X alone", fix["message"])
        self.assertNotIn("FINDING 1", fix["message"], "the card says what it did, not its verdict lines")
        [row] = [i for i in self.control("list_pip_attention", projects="all")["items"] if i["kind"] == "fix_ready"]
        self.assertEqual(row["card"], fix["change_id"])
        change = self.control("get_pip_project_change", pip_id=self.helper["id"], change_id=fix["change_id"])
        self.assertEqual(change["tests"], "passed", "the change card says tests passed in its copy")

    def test_apply_then_commit_these_files_commits_only_them(self):
        self.allowed()
        self.fix_turn_ends()
        fix = self.one()
        change = self.control("get_pip_project_change", pip_id=self.helper["id"], change_id=fix["change_id"])
        (self.root / "README.md").write_text("# Shop, edited by you\n")          # yours, not part of the fix
        from tests.test_pip_project_copies import git
        git(self.root, "config", "user.name", "You")                         # your own Git name, as on your machine
        git(self.root, "config", "user.email", "you@example.invalid")
        applied = self.control("apply_pip_project_change", pip_id=self.helper["id"], change_id=change["id"],
                               expected_digest=change["digest"])
        self.assertEqual(self.one()["state"], "applied")
        listed = self.control("get_pip_project_change", pip_id=self.helper["id"], change_id=applied["id"])
        self.assertEqual(listed["git"], {"committed": False})
        committed = self.control("commit_pip_project_change", pip_id=self.helper["id"], change_id=applied["id"])
        self.assertEqual(committed["git"], {"committed": True})
        import subprocess
        shown = subprocess.run(["git", "-C", str(self.root), "show", "--stat", "--format=%s", "HEAD"],
                               capture_output=True, text=True, check=True).stdout
        self.assertIn("app.py", shown)
        self.assertNotIn("README.md", shown, "only what the change wrote")
        self.assertIn("Shop helper:", shown.splitlines()[0])

    def test_needs_you_becomes_one_waiting_item_and_the_answers_work(self):
        self.allowed([TOTAL, FLAG])
        self.fix_turn_ends("Fixed the total.\nFINDING 1: fixed — done\nFINDING 2: needs you — the GSP wallet is empty\n"
                           "TESTS: not run")
        [waiting] = self.fixes()["waiting"]
        self.assertEqual((waiting["title"], waiting["blocks"], waiting["state"], waiting["can_undo"]),
                         (FLAG["title"], "the GSP wallet is empty", "waiting", False))
        [row] = [i for i in self.control("list_pip_attention", projects="all")["items"] if i["kind"] == "waiting"]
        self.assertEqual(row["card"], waiting["id"])
        answered = self.control("answer_pip_waiting", pip_id=self.helper["id"], waiting_id=waiting["id"], answer="later")
        self.assertEqual((answered["waiting"][0]["state"], answered["waiting"][0]["can_undo"]), ("later", True))
        self.assertTrue(answered["waiting"][0]["remind_at"])
        self.assertEqual([i for i in self.control("list_pip_attention", projects="all")["items"] if i["kind"] == "waiting"], [],
                         "Remind me later: gone until tomorrow")
        undone = self.control("answer_pip_waiting", pip_id=self.helper["id"], waiting_id=waiting["id"], answer="undo")
        self.assertEqual(undone["waiting"][0]["state"], "waiting")
        done = self.control("answer_pip_waiting", pip_id=self.helper["id"], waiting_id=waiting["id"], answer="done")
        self.assertEqual(done["waiting"][0]["state"], "done")

    def test_a_finding_fixed_once_that_comes_back_is_asked_about_never_fixed_again_by_itself(self):
        self.choose(levels.FULL)
        self.check([TOTAL])
        self.send()
        self.fix_turn_ends()
        self.assertEqual(self.one()["state"], "applied")
        self.check([TOTAL])                               # the same issue, found again
        # At Do it all it is asked in its chat, never a card (his rule, 17 Nov; 18 Nov: every card at Do it all).
        from dgc import pip_chat, pip_holds
        [asked] = pip_holds.asks(self.registry, self.helper["id"])
        self.assertEqual(asked["kind"], "fix")
        self.assertIn("came back after an earlier fix", asked["why"])
        self.assertEqual([f["state"] for f in self.fixes()["fixes"]], ["applied"], "no Allow card in its chat")
        self.assertEqual([i for i in self.control("list_pip_attention", projects="all")["items"]
                          if i["kind"] == "fix_ask"], [], "nor in Needs attention")
        newest = self.registry.db.execute("SELECT state,findings FROM pip_fixes WHERE id=?", (asked["ref"],)).fetchone()
        self.assertEqual((newest["state"], json.loads(newest["findings"])[0]["state"]), ("ask", "back"))
        self.assertEqual(pip_holds.announce_due(self.registry, self.cfg), 1, "the supervisor's pass asks in its chat")
        turn = self.store.claim_next()
        self.store.finish(turn["id"], result={"text": "Total ignores the discount again. Shall I fix it once more?"})
        mine = pip_chat.send(self.store, self.helper["id"], "Yes, fix it again", "fix-yes", "editor-user", self.cfg)["run"]
        self.store.claim_next()
        self.store.finish(mine["id"], result={"text": "On it.", "answers": [{"id": asked["id"], "answer": "yes"}]})
        [done] = pip_holds.apply_answers(self.registry, self.cfg, mine["id"])
        self.assertTrue(done["done"], done)
        state = self.registry.db.execute("SELECT state,by FROM pip_fixes WHERE id=?", (asked["ref"],)).fetchone()
        self.assertEqual(tuple(state), ("queued", "you"), "your yes, as your Allow")

    def test_a_failed_turn_says_it_failed(self):
        self.allowed()
        row = self.store.claim_next()
        self.store.finish(row["id"], error={"code": "worker_failed", "message": "It stopped."})
        self.assertEqual(self.one()["state"], "failed")


class ByLevel(FixWorld, unittest.TestCase):
    def test_approve_for_me_fixes_new_findings_by_itself_and_the_change_waits_at_apply(self):
        self.choose(levels.APPROVE)
        self.check([TOTAL])
        fix = self.one()
        self.assertEqual((fix["state"], fix["by"]), ("queued", "pip-level:approve"))
        self.assertEqual(self.send(), 1)
        self.fix_turn_ends()
        self.assertEqual(self.one()["state"], "ready")
        self.assertNotIn("discount", (self.root / "app.py").read_text().lower(), "your folder waits for Apply")

    def test_do_it_all_fixes_and_applies_by_itself_with_undo(self):
        self.choose(levels.FULL)
        self.check([TOTAL])
        self.assertEqual(self.one()["by"], "pip-level:full")
        self.send()
        self.fix_turn_ends()
        fix = self.one()
        self.assertEqual(fix["state"], "applied")
        self.assertIn("sum(items) + 0", (self.root / "app.py").read_text())
        change = self.control("get_pip_project_change", pip_id=self.helper["id"], change_id=fix["change_id"])
        self.assertEqual(change["result"]["by"], "pip-level:full")

    def test_do_it_all_applies_all_even_when_its_tests_failed(self):
        # His answer of 14 Nov ~02:10: "Do it all applies all" (with Undo, never over a file you changed): no size,
        # delete or test fuse. The card says the tests failed in its copy; Undo is there.
        self.choose(levels.FULL)
        self.check([TOTAL])
        self.send()
        self.fix_turn_ends("Changed it.\nFINDING 1: fixed — done\nTESTS: failed")
        fix = self.one()
        self.assertEqual((fix["state"], fix["tests"]), ("applied", "failed"))
        self.assertIn("+ 0", (self.root / "app.py").read_text())
        self.assertFalse(hasattr(fixes, "guard_hold"), "no fuse for the runner to call")

    def test_one_fix_at_a_time(self):
        self.choose(levels.APPROVE)
        self.check([TOTAL])
        self.check([TOTAL, FLAG])
        self.assertEqual(len(self.fixes()["fixes"]), 1, "the next check after it ends asks about the rest")

    def test_a_fix_whose_turn_ended_unrecorded_never_blocks_the_next(self):
        # Self-review, 14 Nov: a fix still marked queued after its turn ended (its end not recorded) blocked every later
        # fix of that Pip ("one at a time"). Its turn's own status decides.
        self.choose(levels.APPROVE)
        self.check([TOTAL])
        self.send()
        row = self.store.claim_next()
        with patch.object(fixes, "after_fix_turn", lambda *a, **k: None):
            self.store.finish(row["id"], result={"text": "Done."})
        self.check([TOTAL, FLAG])
        self.assertEqual(len(self.fixes()["fixes"]), 2, "the next check asks about what is new")

    def test_a_fix_that_failed_is_asked_about_again_never_rerun_by_itself(self):
        # Self-review, 14 Nov: a failed or stopped fix counted as tried, so its findings were never offered again. Now
        # the next check asks (Allow card) even at Approve for me: a fix that keeps failing never reruns every night.
        self.choose(levels.APPROVE)
        self.check([TOTAL])
        self.send()
        row = self.store.claim_next()
        self.store.finish(row["id"], error={"code": "worker_failed", "message": "It stopped."})
        self.assertEqual(self.one()["state"], "failed")
        self.check([TOTAL])
        newest = self.fixes()["fixes"][-1]
        self.assertEqual((len(self.fixes()["fixes"]), newest["state"]), (2, "ask"))

    def test_a_pip_with_no_box_gets_no_fix(self):
        with patch.object(pips, "folder_boxes", return_value=False):
            self.check([TOTAL])
        self.assertEqual(self.fixes()["fixes"], [])


class TheCommands(FixWorld, unittest.TestCase):
    def test_the_commands_are_pips_control_commands_with_exact_fields(self):
        for command in fixes_commands():
            self.assertIn(command, pips.CONTROL_COMMANDS)
        with self.assertRaises(RegistryError):
            self.control("list_pip_fixes", pip_id=self.helper["id"], extra=1)

    def test_start_pip_work_helper_starts_a_sub_agent_with_work_tools(self):
        # Changed on purpose (18 Nov, Pips API 106): it said "isn't ready yet" until the sub-agent with Work tools was
        # built (tests/test_pip_work_agents.py runs one end to end). The press starts it, at any level.
        self.check([TOTAL])
        answer = self.control("start_pip_work_helper", pip_id=self.helper["id"], fix_id=self.one()["id"])
        self.assertEqual((answer["fix"]["state"], answer["fix"]["agent"]["kind"]), ("running", "work"))


def fixes_commands():
    return ("list_pip_fixes", "decide_pip_fix", "start_pip_work_helper", "answer_pip_waiting", "commit_pip_project_change")


if __name__ == "__main__":
    unittest.main()
