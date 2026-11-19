"""Give a Pip a folder later, and Remove its folder (his call 14 Nov, for 0.52: "yes, makes sense, lets do it").

A Pip made without a folder (a Pip for anything) becomes a folder Pip for the folder you give it; Remove its folder makes
a folder Pip a Pip for anything again. Either way it keeps its chat, notes, routines, computer (its Files), level, model,
sub-agents and history. How: the Pip MOVES into the folder's workspace (and back to the personal one) in one
transaction, with a new version of its job whose scope is the new one, exactly as a Pip made there from the start would
have. Its history keeps the workspace it happened in (runs, chat rows, findings), and every read keeps working.

Pending things each have an outcome: refused while a run or a sub-agent is working; a change waiting at Apply, an
applied change's Undo and the copy in its Files carry over (they belong to the folder's copy, never to the Pip's scope);
a reviewed change waiting for the user is carried to the new version where it still fits, else closed; a fix that asks
and what only you can do for the folder close when the folder goes; a handoff waiting for it closes.

A real registry, a real Git project, the real controls; the worker's model never runs.
"""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import pip_chat, pip_levels, pip_project_copies as copies, pip_routines, pips, sessions
from dgc.pip_computer import computer_root
from dgc.pip_computer_files import files_root
from dgc.workspace_registry import RegistryError
from tests.test_pip_project_copies import ProjectWorld, git

DAILY = {"kind": "schedule", "schedule": {"type": "daily", "time": "08:00", "timezone": "Asia/Kolkata"}}
# Reads a Pip's page and chat make. Each one that answered before a move must answer after it (and with the same
# history where it lists history).
SKIP_READS = {"get_pip_computer_frame", "list_pip_computer_frames", "get_pip_computer_desktop",
              "list_pip_computer_terminal", "get_pip_message_image", "get_pip_message_file", "get_pip_run_source",
              "get_pip_exception_source", "get_pip_statement_anchor"}


def page_reads() -> list[str]:
    return sorted(c for c, args in pips._COMMAND_ARGS.items()
                  if c.startswith(("get_pip", "list_pip")) and "pip_id" in args and c not in SKIP_READS)


class GiveWorld(ProjectWorld):
    """self.pip: a Pip for anything with its computer (Coder); self.helper: a folder Pip in "shop"; boxes on."""

    def setUp(self):
        super().setUp()
        for patcher in (patch.object(pips, "folder_boxes", return_value=True),
                        patch.object(sessions, "_temporary_roots", lambda: ())):   # (these folders are in the temp folder)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.helper = self.store.create(self.workspace["id"], "Shop helper", None, "editor-user", pip_type="patch")
        self.personal = self.registry.personal()

    def give(self, pip=None, folder=None, actor="editor-user", **more):
        return self.control("give_pip_folder", actor=actor, pip_id=(pip or self.pip)["id"],
                            folder=str(folder or self.root), **more)

    def remove(self, pip=None, actor="editor-user", **more):
        return self.control("remove_pip_folder", actor=actor, pip_id=(pip or self.helper)["id"], **more)

    def refused(self, code, call, *args, **kwargs):
        with self.assertRaises(RegistryError) as caught:
            call(*args, **kwargs)
        self.assertEqual(caught.exception.code, code, str(caught.exception))
        return str(caught.exception)

    def talk(self, pip, text="Hello", key="m-1", reply="Hi there.", brief=False):
        """A turn of its chat; with `brief`, its reply also writes the chat's running summary (its continuity)."""
        sent = pip_chat.send(self.store, pip["id"], text, key, "editor-user", self.cfg)
        self.store.claim_next()
        result = {"text": reply}
        if brief:
            pin = sent["run"]["manifest"]["conversation"]["continuity"]
            result["continuity"] = {"version": 1, "base_digest": pin["base_digest"], "head_digest": pin["head"]["archive_digest"],
                                    "advance": True, "strategy": "model",
                                    "summary": "## The ask\nKnow util.py.\n## Done so far\nRead it.\n## Next step\nNone."}
        self.store.finish(sent["run"]["id"], result=result)
        return sent

    def messages(self, pip):
        page = self.control("list_pip_messages", pip_id=pip["id"])
        # An editor reads a page only when every message on it names the Pip's place (src/pipsModel.js messagesPage):
        # live check, 19 Nov, the chat of a Pip just given a folder said "Conversation contains an invalid or unrelated
        # message" and stayed empty.
        place = self.store._job(pip["id"])["workspace_id"]
        self.assertEqual(page["workspace_id"], place)
        self.assertEqual({m["workspace_id"] for m in page["messages"]} - {place}, set(), "every message under its place")
        if page.get("continuity"):
            self.assertEqual(page["continuity"]["workspace_id"], place, "and the chat's summary (live check, 19 Nov)")
        return [(m["role"], m["text"]) for m in page["messages"]]

    def notes(self, pip):
        return [n["text"] for n in self.control("list_pip_notes", pip_id=pip["id"])["notes"]]

    def reads(self, pip) -> dict:
        out = {}
        for command in page_reads():
            try:
                out[command] = self.control(command, pip_id=pip["id"])
            except RegistryError as exc:
                out[command] = exc
            except Exception as exc:                    # noqa: BLE001 - a crash is a broken read too
                out[command] = exc
        return out

    def still_read(self, before, after):
        broken = {c: f"{type(after[c]).__name__}: {after[c]}" for c in before
                  if not isinstance(before[c], Exception) and isinstance(after[c], Exception)}
        self.assertEqual(broken, {}, "every read that answered before the move answers after it")

    def own_copy(self, pip):
        return files_root(computer_root(self.registry.directory, pip["id"])) / "projects" / "shop"


class GiveItAFolder(GiveWorld, unittest.TestCase):
    def test_a_pip_for_anything_becomes_a_folder_pip_and_keeps_its_chat_notes_routines_level_and_computer(self):
        self.talk(self.pip, "Remember my shop runs on Python", reply="Got it.")
        self.control("add_pip_note", pip_id=self.pip["id"], text="The shop is my side project")
        routine = pip_routines.add(self.store, self.pip["id"], "Morning check", "Look at the shop.", DAILY)
        pip_levels.set_level(self.registry, self.pip["id"], pip_levels.APPROVE, "editor-user")
        before_reads = self.reads(self.pip)
        before = self.messages(self.pip)

        said = self.give()

        now = self.control("get_pip", pip_id=self.pip["id"])["pip"]
        self.assertEqual(now["workspace_id"], self.workspace["id"], "it lives in the folder's workspace now")
        self.assertNotEqual(now["source_policy"], {"mode": "personal"})
        self.assertEqual(now["source_policy"], pips._definition("x", "y", pip_type="patch")["source_policy"],
                         "the scope a Pip made there from the start has")
        self.assertEqual(now["computer_plan"], {"schema_version": 1}, "its computer stays")
        self.assertEqual(now["current_version"], self.pip["current_version"] + 1)
        self.assertEqual((now["name"], now["goal"], now["model_choice"]),
                         (self.pip["name"], self.pip["goal"], self.pip["model_choice"]))
        self.assertEqual(said["pip"]["workspace_id"], self.workspace["id"])
        self.assertEqual(said["folder"]["name"], "shop")
        self.assertTrue(said["done"])
        self.assertTrue(said["keeps"] and all(isinstance(line, str) for line in said["keeps"]))
        self.assertEqual(self.messages(self.pip), before, "its chat stays, word for word")
        self.assertEqual(self.notes(self.pip), ["The shop is my side project"])
        [kept] = self.control("list_pip_routines", pip_id=self.pip["id"])["routines"]
        self.assertEqual((kept["id"], kept["title"]), (routine["id"], "Morning check"))
        self.assertEqual(pip_levels.level(self.registry, self.pip["id"]), pip_levels.APPROVE, "its level governs its box")
        self.assertTrue(pips.has_box(self.store._job(self.pip["id"])))
        self.still_read(before_reads, self.reads(self.pip))
        # It says so in both places' activity.
        events = {(r["workspace_id"], r["event_type"]) for r in self.registry.db.execute(
            "SELECT workspace_id,event_type FROM workspace_events WHERE pip_id=?", (self.pip["id"],))}
        self.assertIn((self.workspace["id"], "pip_folder_given"), events)
        self.assertIn((self.personal["id"], "pip_folder_given"), events)
        listed = {p["id"]: p["workspace_id"] for p in self.control("list_pips", scope="all")["pips"]}
        self.assertEqual(listed[self.pip["id"]], self.workspace["id"], "one list says where it works now")
        found = [p["id"] for p in self.control("list_pips", workspace_id=self.workspace["id"], query="Python")["pips"]]
        self.assertIn(self.pip["id"], found, "its folder's list finds it by what was said in its chat before")

    def test_its_next_chat_turn_is_a_folder_pips_turn_with_its_own_copy(self):
        self.give()
        sent = pip_chat.send(self.store, self.pip["id"], "What does app.py do?", "m-2", "editor-user", self.cfg)
        manifest = json.loads(self.registry.db.execute("SELECT manifest FROM pip_runs WHERE id=?",
                                                       (sent["run"]["id"],)).fetchone()[0])
        self.assertEqual(manifest["workspace_id"], self.workspace["id"])
        self.assertNotEqual(manifest["source_policy"], {"mode": "personal"})
        self.assertRegex(manifest["source_revision"] or "", r"^[0-9a-f]{40}$", "it reads the folder's committed source")
        told = copies.own_folder(self.store, self.pip["id"])
        self.assertEqual((told["name"], told["folder"]), ("shop", "projects/shop"))
        self.assertEqual((self.own_copy(self.pip) / "app.py").read_text(), (self.root / "app.py").read_text())

    def test_its_routine_turn_after_the_move_works_on_the_folder(self):
        routine = pip_routines.add(self.store, self.pip["id"], "Morning check", "Look at app.py.", DAILY)
        self.give()
        row = self.registry.db.execute("SELECT * FROM pip_routines WHERE id=?", (routine["id"],)).fetchone()
        self.assertEqual(row["workspace_id"], self.workspace["id"], "its own rows moved with it")
        sent = pip_routines._fire(self.store, row, self.cfg, "", "schedule:2026-10-01T08:00")
        manifest = json.loads(self.registry.db.execute("SELECT manifest FROM pip_runs WHERE id=?",
                                                       (sent["run"]["id"],)).fetchone()[0])
        self.assertEqual(manifest["workspace_id"], self.workspace["id"])
        self.assertRegex(manifest["source_revision"] or "", r"^[0-9a-f]{40}$", "a routine's turn reads the folder too")

    def test_at_do_it_all_it_applies_what_it_changed_in_its_folder_by_itself_with_undo(self):
        pip_levels.set_level(self.registry, self.pip["id"], pip_levels.FULL, "editor-user")
        self.give()
        self.assertEqual(pip_levels.effective(self.registry, self.pip["id"]), pip_levels.FULL, "Do it all, still")
        copies.own_folder(self.store, self.pip["id"])
        (self.own_copy(self.pip) / "app.py").write_text("def total(items):\n    return sum(items) + 0\n")
        [applied] = copies.auto_apply(self.store, self.pip["id"])
        self.assertEqual((applied["status"], applied["result"]["by"]), ("applied", "pip-level:full"))
        self.assertIn("+ 0", (self.root / "app.py").read_text())
        self.control("undo_pip_project_change", pip_id=self.pip["id"], change_id=applied["id"])
        self.assertNotIn("+ 0", (self.root / "app.py").read_text())

    def test_a_pip_with_an_earlier_report_still_chats_after_the_move(self):
        # self.source has a finished task of its own (a report, not a chat turn) from before. The chat reads the latest
        # report as reference; one from its old place must not refuse every message after the move.
        self.give(self.source)
        sent = pip_chat.send(self.store, self.source["id"], "Hello again", "m-3", "editor-user", self.cfg)
        self.assertEqual(sent["run"]["status"], "queued")

    def test_an_at_copy_of_the_same_folder_becomes_its_own_and_its_waiting_change_stays(self):
        self.copy()                                                  # an @shop copy, from a message before
        (self.box() / "app.py").write_text("def total(items):\n    return sum(items) + 0\n")
        [waiting] = self.changes()
        self.give()
        told = copies.own_folder(self.store, self.pip["id"])
        self.assertTrue(told["kept"], "its work waits for you, as it did")
        [still] = self.changes()
        self.assertEqual((still["id"], still["status"]), (waiting["id"], "pending"))
        applied = self.control("apply_pip_project_change", pip_id=self.pip["id"], change_id=still["id"],
                               expected_digest=still["digest"])
        self.assertEqual(applied["status"], "applied")
        self.assertIn("+ 0", (self.root / "app.py").read_text())

    def test_a_pip_without_a_computer_stays_without_one(self):
        bare = self.store.create(self.personal["id"], "Bare", None, "editor-user", pip_type="rook", computer_plan=None)
        self.assertIsNone(bare.get("computer_plan"))
        self.give(bare)
        self.assertFalse(pips.has_box(self.store._job(bare["id"])), "you took its computer away; a folder gives none")

    def test_what_stays_and_what_changes_is_said_first_and_nothing_moves(self):
        said = self.give(dry_run=True)
        self.assertFalse(said["done"])
        self.assertEqual(said["folder"]["name"], "shop")
        words = " ".join(said["keeps"] + said["changes"])
        for word in ("chat", "notes", "routines", "computer", "shop"):
            self.assertIn(word, words)
        self.assertEqual(self.store._job(self.pip["id"])["workspace_id"], self.personal["id"])
        self.assertEqual(self.store._job(self.pip["id"])["current_version"], self.pip["current_version"])

    def test_a_reviewed_change_waiting_for_you_waits_on_against_the_new_version(self):
        waiting = self.store.propose(self.pip["id"], self.pip["current_version"], {"name": "Coder Two"}, "editor-user")
        self.give()
        rows = self.registry.db.execute("SELECT id,status,expected_version,definition FROM pip_proposals WHERE pip_id=? "
                                        "ORDER BY rowid", (self.pip["id"],)).fetchall()
        self.assertEqual({r["id"]: r["status"] for r in rows}[waiting["id"]], "superseded")
        carried = [r for r in rows if r["status"] == "proposed"]
        self.assertEqual(len(carried), 1, "carried, as when a Pip changes itself")
        self.assertEqual(json.loads(carried[0]["definition"])["name"], "Coder Two")
        self.assertNotEqual(json.loads(carried[0]["definition"])["source_policy"], {"mode": "personal"},
                            "written for its folder scope, never back to the old one")
        accepted = self.store.accept(self.pip["id"], carried[0]["id"], carried[0]["expected_version"], "editor-user")
        self.assertEqual((accepted["name"], accepted["workspace_id"]), ("Coder Two", self.workspace["id"]))

    def test_a_schedule_stops_and_is_said_its_routines_go_on(self):
        planner = self.store.create(self.personal["id"], "Planner", None, "editor-user", pip_type="patch")
        proposal = self.store.propose(planner["id"], 1, {"schedule": {"type": "daily", "time": "07:00",
                                                                     "timezone": "UTC"}}, "editor-user")
        self.store.accept(planner["id"], proposal["id"], 1, "editor-user")
        said = self.give(self.store.get(planner["id"]), dry_run=True)
        self.assertTrue(any("schedule" in line for line in said["changes"]), said["changes"])
        routine = pip_routines.add(self.store, planner["id"], "Morning plan", "Plan my day.", DAILY)
        self.give(self.store.get(planner["id"]))
        self.assertIsNone(self.store._job(planner["id"])["schedule"])
        [kept] = self.control("list_pip_routines", pip_id=planner["id"])["routines"]
        self.assertEqual((kept["id"], kept["status"]), (routine["id"], "on"), "its routine goes on")

    def test_a_handoff_waiting_for_it_is_closed_in_plain_words(self):
        from tests.test_pip_personal_handoffs import PersonalHandoffTests
        handoff = PersonalHandoffTests.propose(self)
        self.assertEqual(handoff["status"], "pending")
        said = self.give(self.target, dry_run=True)
        self.assertTrue(any("handoff" in line.lower() or "hand" in line.lower() for line in said["changes"]), said)
        self.give(self.target)
        row = self.registry.db.execute("SELECT status,resolution_reason FROM pip_handoffs WHERE id=?",
                                       (handoff["id"],)).fetchone()
        self.assertEqual(row["status"], "expired")
        self.assertTrue(row["resolution_reason"])


class RemoveItsFolder(GiveWorld, unittest.TestCase):
    def test_a_folder_pip_becomes_a_pip_for_anything_and_keeps_its_chat_notes_and_computer(self):
        self.talk(self.helper, "What is in util.py?", reply="X = 1.", brief=True)
        self.assertIsNotNone(self.control("list_pip_messages", pip_id=self.helper["id"]).get("continuity"))
        self.control("add_pip_note", pip_id=self.helper["id"], text="Answer briefly")
        pip_levels.set_level(self.registry, self.helper["id"], pip_levels.APPROVE, "editor-user")
        before_reads = self.reads(self.helper)
        before = self.messages(self.helper)

        said = self.remove()

        now = self.control("get_pip", pip_id=self.helper["id"])["pip"]
        self.assertEqual(now["workspace_id"], self.personal["id"])
        self.assertEqual(now["source_policy"], {"mode": "personal"})
        self.assertEqual(now["computer_plan"], {"schema_version": 1}, "the box it had is its computer now")
        self.assertTrue(said["done"])
        self.assertEqual(self.messages(self.helper), before)
        self.assertEqual(self.notes(self.helper), ["Answer briefly"])
        self.assertEqual(pip_levels.level(self.registry, self.helper["id"]), pip_levels.APPROVE)
        self.still_read(before_reads, self.reads(self.helper))
        self.assertIsNone(copies.own_folder(self.store, self.helper["id"]), "no folder of its own now")
        sent = pip_chat.send(self.store, self.helper["id"], "And now?", "m-9", "editor-user", self.cfg)
        manifest = json.loads(self.registry.db.execute("SELECT manifest FROM pip_runs WHERE id=?",
                                                       (sent["run"]["id"],)).fetchone()[0])
        self.assertEqual((manifest["workspace_id"], manifest["source_policy"]), (self.personal["id"], {"mode": "personal"}))
        events = {r[0] for r in self.registry.db.execute(
            "SELECT workspace_id FROM workspace_events WHERE pip_id=? AND event_type='pip_folder_removed'", (self.helper["id"],))}
        self.assertEqual(events, {self.workspace["id"], self.personal["id"]})

    def test_its_copy_and_a_change_waiting_at_apply_stay_and_still_apply(self):
        copies.own_folder(self.store, self.helper["id"])
        (self.own_copy(self.helper) / "app.py").write_text("def total(items):\n    return sum(items) + 0\n")
        [waiting] = self.control("list_pip_project_changes", pip_id=self.helper["id"])["changes"]
        said = self.remove()
        self.assertTrue(any("waits" in line or "Apply" in line for line in said["keeps"] + said["changes"]), said)
        self.assertTrue((self.own_copy(self.helper) / "app.py").exists(), "its copy stays in its Files")
        [still] = self.control("list_pip_project_changes", pip_id=self.helper["id"])["changes"]
        self.assertEqual((still["id"], still["status"]), (waiting["id"], "pending"))
        applied = self.control("apply_pip_project_change", pip_id=self.helper["id"], change_id=still["id"],
                               expected_digest=still["digest"])
        self.assertEqual(applied["status"], "applied")
        undone = self.control("undo_pip_project_change", pip_id=self.helper["id"], change_id=still["id"])
        self.assertEqual(undone["status"], "undone")
        self.assertNotIn("+ 0", (self.root / "app.py").read_text())

    def test_a_fix_that_asks_and_what_only_you_can_do_close_with_the_folder(self):
        from dgc import pip_fixes
        now = self.registry.clock()
        with self.registry.transaction():
            pip_fixes.ensure(self.registry.db)
            self.registry.db.execute(
                "INSERT INTO pip_fixes(id,pip_id,workspace_id,run_id,state,findings,count,created_at,updated_at) "
                "VALUES(?,?,?,?,?,?,?,?,?)", ("pipfix_" + "a" * 32, self.helper["id"], self.workspace["id"],
                                              "run_" + "a" * 32, "ask", "[]", 1, now, now))
            self.registry.db.execute(
                "INSERT INTO pip_waiting(id,pip_id,workspace_id,fix_id,identity,title,blocks,state,since,created_at,"
                "updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)", ("pipwait_" + "b" * 32, self.helper["id"],
                                                              self.workspace["id"], None, "i1", "Set the key", "[]",
                                                              "waiting", now, now, now))
        said = self.remove(dry_run=True)
        self.assertTrue(any("fix" in line.lower() for line in said["changes"]), said)
        self.remove()
        fix = self.registry.db.execute("SELECT state,note FROM pip_fixes WHERE pip_id=?", (self.helper["id"],)).fetchone()
        self.assertEqual(fix["state"], "ended")
        self.assertTrue(fix["note"])
        wait = self.registry.db.execute("SELECT state FROM pip_waiting WHERE pip_id=?", (self.helper["id"],)).fetchone()
        self.assertEqual(wait["state"], "dismissed")

    def test_given_back_its_folder_it_is_that_folders_pip_again(self):
        self.talk(self.helper, "First", reply="One.")
        self.remove()
        self.talk(self.helper, "Second", key="m-2", reply="Two.")
        self.give(self.helper)
        self.assertEqual(self.store._job(self.helper["id"])["workspace_id"], self.workspace["id"])
        self.assertEqual(self.messages(self.helper),
                         [("user", "First"), ("assistant", "One."), ("user", "Second"), ("assistant", "Two.")])


class WhatItLearnedStaysWithTheFolder(unittest.TestCase):
    """A folder Pip that audited its folder (a checkpoint) and was told a finding is fine (an exception): Remove keeps
    them with the folder and every page read still answers; given the folder back, they are its again."""

    def setUp(self):
        from tests.test_pip_checkpoint_integration import CheckpointIntegrationTests
        CheckpointIntegrationTests.setUp(self)
        temporary = patch.object(sessions, "_temporary_roots", lambda: ())
        temporary.start()
        self.addCleanup(temporary.stop)

    from tests.test_pip_checkpoint_integration import CheckpointIntegrationTests as _Fixture
    git, commit, create, completed = _Fixture.git, _Fixture.commit, _Fixture.create, _Fixture.completed

    def call(self, type, actor="editor-user", **fields):
        with patch("dgc.workspace_registry.state_directory", return_value=self.registry.directory):
            out = pips.handle_control(self.cfg, {"request_id": "r", "type": type, **fields}, actor, start_worker=False)
        if not out["ok"]:
            raise RegistryError(out["error"]["code"], out["error"]["message"])
        return out["result"]

    def learned(self, job):
        return (len(self.call("list_pip_checkpoints", pip_id=job["id"])["checkpoints"]),
                len(self.call("list_pip_memories", pip_id=job["id"])["memories"]))

    def test_its_findings_and_exceptions_stay_with_the_folder_and_come_back(self):
        job = self.create()
        run = self.completed(job, "first")
        source = self.call("get_pip_exception_source", actor="review-device", pip_id=job["id"], run_id=run["id"],
                           finding_index=0)
        self.call("record_pip_exception", actor="review-device", pip_id=job["id"], run_id=run["id"], finding_index=0,
                  expected_source_digest=source["digest"], reason="Reviewed: fine as it is.", request_key="k1",
                  expires_at=None)
        self.assertEqual(self.learned(job), (1, 1))
        said = self.call("remove_pip_folder", pip_id=job["id"], dry_run=True)
        self.assertTrue(any("learned" in line for line in said["changes"]), said)
        self.call("remove_pip_folder", pip_id=job["id"])
        self.assertEqual(self.learned(job), (0, 0), "they stay with the folder")
        for command in ("get_pip", "list_pip_runs", "get_pip_outcomes", "list_pip_run_posts"):
            with self.subTest(command=command):
                self.call(command, pip_id=job["id"])
        self.call("give_pip_folder", pip_id=job["id"], folder=str(self.root))
        self.assertEqual(self.learned(job), (1, 1), "given the folder back, what it learned there is its again")
        self.store.enqueue(job["id"], "second", "device_1", self.cfg)      # its next audit reads its checkpoint


class WhoAndWhen(GiveWorld, unittest.TestCase):
    def test_only_you_on_this_computer_never_a_pip_a_model_or_another_device(self):
        for actor in ("device_1", "core_proposal", "pip-routine", "pip-level:full"):
            with self.subTest(actor=actor):
                self.refused("local_only", self.give, actor=actor)
                self.refused("local_only", self.remove, actor=actor)
        self.assertEqual(self.store._job(self.pip["id"])["workspace_id"], self.personal["id"])

    def test_refused_while_it_is_working(self):
        pip_chat.send(self.store, self.pip["id"], "Busy", "m-1", "editor-user", self.cfg)
        said = self.refused("busy", self.give)
        self.assertIn("working", said)
        pip_chat.send(self.store, self.helper["id"], "Busy", "m-1", "editor-user", self.cfg)
        self.refused("busy", self.remove)

    def test_the_folder_must_be_one_a_folder_pip_can_work_in(self):
        plain = Path(self.base) / "plain"
        plain.mkdir()
        (plain / "a.txt").write_text("hi")
        said = self.refused("unsupported_source", self.give, folder=plain)
        self.assertIn("Git", said)
        self.refused("not_found", self.give, folder=Path(self.base) / "gone")
        self.refused("invalid_request", self.give, folder="relative/path")
        with patch("dgc.project_folders._home", return_value=self.root):
            self.refused("invalid_request", self.give)
        with patch.object(sessions, "_temporary_roots", lambda: (Path(self.base).resolve(),)):
            self.assertIn("temporary", self.refused("invalid_request", self.give))
        self.assertEqual(self.store._job(self.pip["id"])["workspace_id"], self.personal["id"])

    def test_the_right_kind_of_pip_for_each(self):
        self.refused("invalid_request", self.give, self.helper)                 # it has a folder: remove it first
        self.refused("invalid_request", self.remove, self.pip)                  # it has none
        core = self.store.create(self.personal["id"], "Core", None, "editor-user", pip_type="core")
        said = self.refused("unavailable_pip_type", self.give, core)
        self.assertIn("Core", said)

    def test_an_archived_pip_is_restored_first(self):
        self.control("archive_pip", pip_id=self.pip["id"], expected_version=self.pip["current_version"],
                     expected_lifecycle_revision=self.store._job(self.pip["id"])["lifecycle_revision"],
                     request_key="arch-1", reason="Done for now")
        self.refused("archived", self.give)


if __name__ == "__main__":
    unittest.main()
