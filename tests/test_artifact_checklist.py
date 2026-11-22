"""DGC keeps a checklist: an artifact of items (title, what done means, a status, a note, proof) it makes and keeps
current as it works.

What the user asked for: "make a checklist for X and work through it" makes one; DGC marks an item Done with a note and
its proof, one item at a time, never rewriting the rest; the user ticks or reopens an item, or changes what done means,
and DGC sees that at its next look and goes by it; it is pinned to the project, so a new chat there picks it up and
carries on from the first item not done; /goal can run from it item by item, ending when every item is Done or one
needs the user; and the views carry how far along it is, for Work's list.
"""
from __future__ import annotations

import base64
import copy
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dgc import artifact_service as service
from dgc import artifact_store, artifact_tools, tools
from dgc.agent import Agent, AgentContext
from dgc.config import Config, DEFAULTS

PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")
ITEMS = [{"title": "Write the parser", "done_when": "parse() reads every sample file"},
         {"title": "Add the tests", "done_when": "pytest passes with 10 or more tests"},
         {"title": "Write the README", "done_when": "README says how to run it"}]


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(os.path.realpath(tempfile.mkdtemp(prefix="dgc-checklist-")))
        self._env = os.environ.get("DGC_HOME")
        os.environ["DGC_HOME"] = str(self.tmp / "home")
        self.root = self.tmp / "proj"
        self.root.mkdir()
        self.ctx = self.context("s1")
        from dgc import checklists
        checklists.forget()

    def tearDown(self):
        if self._env is None:
            os.environ.pop("DGC_HOME", None)
        else:
            os.environ["DGC_HOME"] = self._env

    def context(self, session, root=None):
        root = root or self.root
        return AgentContext(root, Config(root), on_artifact=lambda v, op: None,
                            artifact_origin=lambda: {"surface": "work", "project": str(root), "session": session})

    def make(self, title="Ship the parser", items=None, ctx=None):
        out = tools.execute("make_artifact", {"type": "checklist", "title": title,
                                              "data": {"items": copy.deepcopy(items or ITEMS)}}, ctx or self.ctx)
        self.assertTrue(out.startswith("Made Checklist"), out)
        return out.split("(")[1].split(",")[0]

    def edit(self, aid, *edits, ctx=None, **more):
        return tools.execute("edit_artifact", {"id": aid, "edits": list(edits), **more}, ctx or self.ctx)

    def items(self, aid, n=None):
        return artifact_store.store().source(aid, n)["items"]


class MakingOne(Base):
    def test_a_checklist_is_a_kind_of_artifact_with_each_items_title_done_when_and_status(self):
        aid = self.make()
        view = service.view(aid)
        self.assertEqual((view["type"], view["label"]), ("checklist", "Checklist"))
        items = self.items(aid)
        self.assertEqual([i["id"] for i in items], ["c1", "c2", "c3"])
        self.assertEqual([i["title"] for i in items], [i["title"] for i in ITEMS])
        self.assertEqual([i["done_when"] for i in items], [i["done_when"] for i in ITEMS])
        self.assertEqual({i["status"] for i in items}, {"Not started"})
        self.assertIn("checklist", artifact_store.TYPES)
        self.assertIn("checklist", artifact_tools.MAKE_ARTIFACT["function"]["parameters"]["properties"]["type"]["enum"])

    def test_the_six_statuses_and_no_other(self):
        from dgc import artifact_checklist as checklist
        self.assertEqual(checklist.STATUSES, ("Not started", "Building", "Testing", "Checked live", "Needs you", "Done"))
        with self.assertRaises(ValueError):
            checklist.normalize({"items": [{"title": "x", "status": "Half way"}]})
        # (However a model spells one of the six.)
        got = checklist.normalize({"items": [{"title": "x", "status": "needs_you"}, {"title": "y", "status": "DONE"}]})
        self.assertEqual([i["status"] for i in got["items"]], ["Needs you", "Done"])

    def test_it_needs_items_and_each_needs_a_title(self):
        out = tools.execute("make_artifact", {"type": "checklist", "title": "Empty", "data": {"items": []}}, self.ctx)
        self.assertTrue(out.startswith("error:"), out)
        out = tools.execute("make_artifact", {"type": "checklist", "title": "Bad", "data": {"items": [{"done_when": "x"}]}},
                            self.ctx)
        self.assertTrue(out.startswith("error:"), out)

    def test_what_the_model_reads_back_says_where_it_stands_and_what_is_next(self):
        aid = self.make()
        out = tools.execute("edit_artifact", {"id": aid}, self.ctx)
        self.assertIn("0 of 3 done", out)
        self.assertIn("c1 [Not started] Write the parser", out)
        self.assertIn("done when: parse() reads every sample file", out)
        self.assertIn("Next: c1", out)

    def test_one_checklist_per_name_per_project_and_a_second_ask_works_from_the_one_there(self):
        aid = self.make("Launch")
        out = tools.execute("make_artifact", {"type": "checklist", "title": "launch", "data": {"items": ITEMS}}, self.ctx)
        self.assertTrue(out.startswith("error:"), out)
        self.assertIn(aid, out)
        self.assertIn("carry on from", out)
        self.assertEqual(len(service.listing(type="checklist")), 1)
        # Another project may have its own "Launch".
        other = self.tmp / "other"
        other.mkdir()
        self.make("Launch", ctx=self.context("s9", other))
        self.assertEqual(len(service.listing(type="checklist")), 2)

    def test_the_view_says_how_far_along_it_is(self):
        aid = self.make()
        self.edit(aid, {"op": "set", "item": "c1", "status": "Done", "note": "Wrote parse()", "proof": ["3 samples read"]})
        self.edit(aid, {"op": "set", "item": "c2", "status": "Building"})
        progress = service.view(aid, versions=False)["progress"]
        self.assertEqual((progress["done"], progress["total"]), (1, 3))
        self.assertEqual(progress["next"], {"id": "c2", "title": "Add the tests", "status": "Building"})
        self.assertEqual(progress["needs"], [])
        self.assertTrue(progress["pinned"])
        listed = [v for v in service.listing(type="checklist") if v["id"] == aid][0]
        self.assertEqual(listed["progress"]["done"], 1)


class OneItemAtATime(Base):
    def test_done_carries_a_note_and_its_proof_and_only_that_item_changes(self):
        aid = self.make()
        before = self.items(aid)
        out = self.edit(aid, {"op": "set", "item": "c1", "status": "Done", "note": "Wrote parse() in parser.py",
                              "proof": ["pytest: 4 passed"]})
        self.assertTrue(out.startswith("Changed Checklist"), out)
        self.assertIn("1 of 3 done", out)
        self.assertIn("Next: c2", out)
        after = self.items(aid)
        self.assertEqual(after[0]["status"], "Done")
        self.assertEqual(after[0]["note"], "Wrote parse() in parser.py")
        self.assertEqual(after[0]["proof"], [{"kind": "text", "text": "pytest: 4 passed"}])
        self.assertEqual(after[0]["by"], "DGC")
        self.assertEqual(after[1:], before[1:])

    def test_done_without_a_note_or_without_proof_is_refused(self):
        aid = self.make()
        out = self.edit(aid, {"op": "set", "item": "c1", "status": "Done"})
        self.assertTrue(out.startswith("error:"), out)
        self.assertIn("note", out)
        out = self.edit(aid, {"op": "set", "item": "c1", "status": "Done", "note": "did it"})
        self.assertTrue(out.startswith("error:"), out)
        self.assertIn("proof", out)
        self.assertEqual(service.view(aid)["version"], 1)

    def test_needs_you_says_why(self):
        aid = self.make()
        out = self.edit(aid, {"op": "set", "item": "c2", "status": "Needs you"})
        self.assertTrue(out.startswith("error:"), out)
        out = self.edit(aid, {"op": "set", "item": "c2", "status": "Needs you", "note": "Which test runner: pytest or unittest?"})
        self.assertTrue(out.startswith("Changed Checklist"), out)
        self.assertEqual(service.view(aid)["progress"]["needs"], ["c2"])

    def test_one_call_changes_one_item(self):
        aid = self.make()
        out = self.edit(aid, {"op": "set", "item": "c1", "status": "Building"}, {"op": "set", "item": "c2", "status": "Building"})
        self.assertTrue(out.startswith("error:"), out)
        self.assertIn("one item", out.lower())
        self.assertEqual(service.view(aid)["version"], 1)

    def test_the_whole_list_is_never_rewritten_by_the_model(self):
        aid = self.make()
        out = tools.execute("edit_artifact", {"id": aid, "data": {"items": [{"title": "Everything", "status": "Done"}]}},
                            self.ctx)
        self.assertTrue(out.startswith("error:"), out)
        self.assertIn("one item at a time", out)
        self.assertEqual([i["title"] for i in self.items(aid)], [i["title"] for i in ITEMS])

    def test_the_version_history_shows_each_item_change(self):
        aid = self.make()
        self.edit(aid, {"op": "set", "item": "c1", "status": "Building"})
        self.edit(aid, {"op": "set", "item": "c1", "status": "Done", "note": "Wrote it", "proof": ["4 passed"]})
        self.edit(aid, {"op": "set", "item": "c2", "status": "Testing"})
        versions = service.view(aid)["versions"]
        self.assertEqual([v["n"] for v in versions], [1, 2, 3, 4])
        self.assertEqual(versions[1]["summary"], "c1 “Write the parser”: Not started → Building")
        self.assertEqual(versions[2]["summary"], "c1 “Write the parser”: Building → Done")
        self.assertEqual(versions[3]["summary"], "c2 “Add the tests”: Not started → Testing")
        # Each version holds the list as it was then.
        self.assertEqual(self.items(aid, 2)[0]["status"], "Building")
        self.assertEqual(self.items(aid, 2)[1]["status"], "Not started")

    def test_an_item_is_named_by_its_id_its_number_or_its_title(self):
        aid = self.make()
        self.assertTrue(self.edit(aid, {"op": "set", "item": 2, "status": "Building"}).startswith("Changed"))
        self.assertEqual(self.items(aid)[1]["status"], "Building")
        self.assertTrue(self.edit(aid, {"op": "set", "item": "write the readme", "status": "Building"}).startswith("Changed"))
        self.assertEqual(self.items(aid)[2]["status"], "Building")
        self.assertTrue(self.edit(aid, {"op": "set", "item": "c9", "status": "Building"}).startswith("error:"))

    def test_items_can_be_added_and_keep_the_ids_of_the_rest(self):
        aid = self.make()
        out = self.edit(aid, {"op": "add", "title": "Publish it", "done_when": "the package is on the index"})
        self.assertTrue(out.startswith("Changed"), out)
        self.assertEqual([i["id"] for i in self.items(aid)], ["c1", "c2", "c3", "c4"])
        self.edit(aid, {"op": "remove", "item": "c2"})
        self.edit(aid, {"op": "add", "title": "Tag it"})
        self.assertEqual([i["id"] for i in self.items(aid)], ["c1", "c3", "c4", "c5"])

    def test_a_picture_is_kept_with_the_version_as_proof(self):
        aid = self.make()
        shots = self.root / "shots"
        shots.mkdir()
        (shots / "parser.png").write_bytes(PNG)
        out = self.edit(aid, {"op": "set", "item": "c1", "status": "Done", "note": "It reads all three",
                              "proof": ["3 samples read", {"image": "shots/parser.png", "caption": "The run"}]})
        self.assertTrue(out.startswith("Changed"), out)
        proof = self.items(aid)[0]["proof"]
        self.assertEqual(proof[0], {"kind": "text", "text": "3 samples read"})
        self.assertEqual(proof[1]["kind"], "image")
        self.assertEqual(proof[1]["caption"], "The run")
        files = artifact_store.store().files(aid)
        self.assertEqual(files[proof[1]["file"]], PNG)
        # The file can go: the checklist keeps its own copy, in this version and the ones after.
        (shots / "parser.png").unlink()
        self.edit(aid, {"op": "set", "item": "c2", "status": "Building"})
        self.assertEqual(artifact_store.store().files(aid)[proof[1]["file"]], PNG)
        html = service.render(aid)[0]["index.html"].decode()
        self.assertIn("data:image/png;base64,", html)

    def test_a_picture_outside_the_project_or_not_a_picture_is_refused(self):
        aid = self.make()
        (self.tmp / "secret.png").write_bytes(PNG)
        (self.root / "notes.png").write_text("not a picture")
        for path in ("../secret.png", "notes.png", "missing.png"):
            out = self.edit(aid, {"op": "set", "item": "c1", "status": "Done", "note": "x", "proof": [{"image": path}]})
            self.assertTrue(out.startswith("error:"), (path, out))
        self.assertEqual(service.view(aid)["version"], 1)


class TheUserTicksToo(Base):
    def by_you(self, aid, change, note=""):
        """What the checklist's panel sends: the list with the user's one change, from the version it showed."""
        view = service.view(aid, versions=False)
        data = artifact_store.store().source(aid)
        change(data)
        return service.edit(aid, content=data, author="you", note=note, base_version=view["version"])

    def test_a_tick_is_the_users_version_and_says_what_changed(self):
        aid = self.make()
        self.by_you(aid, lambda d: d["items"][0].update(status="Done"))
        last = service.view(aid)["versions"][-1]
        self.assertEqual(last["author"], "you")
        self.assertEqual(last["summary"], "c1 “Write the parser”: Not started → Done")
        self.assertEqual(self.items(aid)[0]["by"], "you")

    def test_dgc_sees_a_reopened_item_and_a_changed_done_when_at_its_next_look(self):
        aid = self.make()
        self.edit(aid, {"op": "set", "item": "c1", "status": "Done", "note": "Wrote it", "proof": ["4 passed"]})
        self.by_you(aid, lambda d: d["items"][0].update(status="Not started"))
        self.by_you(aid, lambda d: d["items"][1].update(done_when="pytest passes with 25 or more tests"))
        out = self.edit(aid, {"op": "set", "item": "c3", "status": "Building"})
        self.assertTrue(out.startswith("Changed"), out)
        self.assertIn("The user changed it since you last read it", out)
        self.assertIn("c1 “Write the parser”: Done → Not started", out)
        self.assertIn("pytest passes with 25 or more tests", out)
        self.assertIn("Next: c1", out)
        # Said once.
        out = self.edit(aid, {"op": "set", "item": "c3", "status": "Testing"})
        self.assertNotIn("The user changed it", out)

    def test_a_change_to_the_item_the_user_just_changed_is_held_until_dgc_has_read_theirs(self):
        aid = self.make()
        self.edit(aid, {"op": "set", "item": "c1", "status": "Building"})
        self.by_you(aid, lambda d: d["items"][0].update(status="Done"))
        out = self.edit(aid, {"op": "set", "item": "c1", "status": "Testing"})
        self.assertTrue(out.startswith("error:"), out)
        self.assertIn("the user changed", out.lower())
        self.assertIn("Not started → Done", out.replace("Building → Done", "Not started → Done"))
        self.assertEqual(self.items(aid)[0]["status"], "Done")

    def test_the_users_stale_save_is_a_conflict_not_an_overwrite(self):
        aid = self.make()
        data = artifact_store.store().source(aid)
        self.edit(aid, {"op": "set", "item": "c2", "status": "Building"})
        data["items"][0]["status"] = "Done"
        with self.assertRaises(service.ArtifactUseError) as caught:
            service.edit(aid, content=data, author="you", base_version=1)
        self.assertIn("changed since version", str(caught.exception))
        self.assertEqual(self.items(aid)[1]["status"], "Building")

    def test_the_user_can_unpin_it(self):
        aid = self.make()
        self.by_you(aid, lambda d: d.update(pinned=False))
        self.assertFalse(service.view(aid, versions=False)["progress"]["pinned"])
        self.assertEqual(service.view(aid)["versions"][-1]["summary"], "Unpinned from the project")


class PinnedToTheProject(Base):
    def note(self, session="s2", root=None):
        from dgc import checklists
        return checklists.turn_note(str(root or self.root), session)

    def test_a_new_chat_in_the_project_is_told_the_checklist_and_where_to_carry_on(self):
        aid = self.make()
        self.edit(aid, {"op": "set", "item": "c1", "status": "Done", "note": "Wrote it", "proof": ["4 passed"]})
        key, text = self.note("s2")
        self.assertIn(aid, key)
        self.assertIn("Ship the parser", text)
        self.assertIn(aid, text)
        self.assertIn("1 of 3 done", text)
        self.assertIn("c2 [Not started] Add the tests", text)
        self.assertIn("Carry on from c2", text)

    def test_it_is_said_once_until_it_changes(self):
        aid = self.make()
        self.assertIsNotNone(self.note("s2"))
        self.assertIsNone(self.note("s2"))
        service.edit(aid, content={**artifact_store.store().source(aid), "about": "v2"}, author="you",
                     base_version=1)
        self.assertIsNotNone(self.note("s2"))
        # The chat that made it is told the user's change too, in a line, and never its own change back.
        key, text = self.note("s1")
        self.assertIn("The user changed it since you last read it: Description changed", text)
        self.assertNotIn("c2 [Not started]", text)
        self.edit(aid, {"op": "set", "item": "c1", "status": "Building"})
        self.assertIsNone(self.note("s1"))

    def test_a_compacted_chat_is_told_it_whole_again(self):
        from dgc import checklists
        self.make()
        self.assertIsNotNone(self.note("s2"))
        self.assertIsNone(self.note("s2"))
        checklists.unsee("s2")
        key, text = self.note("s2")
        self.assertIn("# This project's checklist\n", text)
        self.assertIn("c1 [Not started] Write the parser", text)
        agent = _agent(self.root)
        self.addCleanup(agent.mcp.stop_all)
        self.assertIn("# This project's checklist", agent._turn_notes())
        agent._turn_notes_given = set()
        agent._checklist_unseen()
        self.assertIn("# This project's checklist", agent._turn_notes())

    def test_another_project_an_unpinned_one_and_a_finished_one_say_nothing(self):
        aid = self.make()
        other = self.tmp / "other"
        other.mkdir()
        self.assertIsNone(self.note("s2", other))
        service.edit(aid, content={**artifact_store.store().source(aid), "pinned": False}, author="you", base_version=1)
        self.assertIsNone(self.note("s3"))
        done = self.make("Small", [{"title": "One thing", "done_when": "it is done"}])
        self.edit(done, {"op": "set", "item": "c1", "status": "Done", "note": "Did it", "proof": ["seen"]})
        self.assertIsNone(self.note("s4"))

    def test_the_work_agent_carries_it_in_its_turn_notes(self):
        aid = self.make()
        agent = _agent(self.root)
        self.addCleanup(agent.mcp.stop_all)
        notes = agent._turn_notes()
        self.assertIn("# This project's checklist", notes)
        self.assertIn(aid, notes)
        self.assertIn("Carry on from c1", notes)
        agent._turn_notes_given = set()
        self.assertNotIn("checklist", agent._turn_notes())


class QuietUI:
    def __init__(self):
        self.events = []

    def __getattr__(self, name):
        return lambda *args, **kw: self.events.append((name, args))


def _agent(root):
    config = object.__new__(Config)
    config.project_root = root
    config.project_dir = root / ".dgc"
    config._persist = False
    config.data = copy.deepcopy(DEFAULTS)
    config.data.update(base_url="http://localhost.invalid/v1", api_key="fixture-placeholder", model="fixture",
                       mode="auto", hooks={}, mcp_servers={}, suggest=False, artifact_autostart=False)
    config._stored_secrets, config._env_secret_keys = {}, set()
    config.permissions = {"allow": [], "ask": [], "deny": []}
    return Agent(config, QuietUI())


class AGoalRunsFromIt(Base):
    def setUp(self):
        super().setUp()
        self.agent = _agent(self.root)
        self.addCleanup(self.agent.mcp.stop_all)

    def done(self, aid, item):
        out = self.edit(aid, {"op": "set", "item": item, "status": "Done", "note": f"Did {item}", "proof": ["seen"]})
        self.assertTrue(out.startswith("Changed"), out)

    def test_goal_checklist_takes_the_projects_checklist_as_its_objective(self):
        aid = self.make()
        self.assertTrue(self.agent.set_goal("checklist"), self.agent._last_persist_error)
        self.assertEqual(self.agent._goal_details["checklist"], aid)
        self.assertIn("Ship the parser", self.agent.goal)
        self.assertIn(aid, self.agent.goal)
        self.assertIn("item by item", self.agent.goal)
        self.assertEqual(self.agent.goal_snapshot()["checklist"], aid)

    def test_by_name_when_the_project_has_two(self):
        self.make("Alpha")
        beta = self.make("Beta release")
        self.assertTrue(self.agent.set_goal("checklist beta"), self.agent._last_persist_error)
        self.assertEqual(self.agent._goal_details["checklist"], beta)

    def test_with_no_checklist_it_says_so_and_sets_no_goal(self):
        self.assertFalse(self.agent.set_goal("checklist"))
        self.assertIn("no checklist", self.agent._last_persist_error)
        self.assertEqual(self.agent.goal, "")

    def test_an_ordinary_goal_is_not_tied_to_a_checklist(self):
        self.make()
        self.assertTrue(self.agent.set_goal("fix the checklist page's colours"))
        self.assertNotIn("checklist", self.agent._goal_details)

    def test_the_link_survives_a_saved_session(self):
        from dgc.goals import clean_details
        aid = self.make()
        self.assertTrue(self.agent.set_goal("checklist"))
        self.assertEqual(clean_details(copy.deepcopy(self.agent._goal_details))["checklist"], aid)
        self.assertNotIn("checklist", clean_details({"checklist": "../../etc"}))

    def run_goal(self, steps):
        """Run the goal with ``steps``: each is called for one goal turn, in order; after the last, the run must have ended."""
        calls = []

        def step(prompt):
            calls.append(prompt)
            if len(calls) > len(steps):
                self.agent.cancelled.set()
                return False
            steps[len(calls) - 1](prompt)
            return True
        self.agent.cancelled.clear()
        self.agent._run_goal_steps(self.agent.goal, step)
        return calls

    def test_it_ends_completed_when_every_item_is_done(self):
        aid = self.make()
        self.assertTrue(self.agent.set_goal("checklist"))
        calls = self.run_goal([lambda p: self.done(aid, "c1"), lambda p: self.done(aid, "c2"), lambda p: self.done(aid, "c3")])
        self.assertEqual(len(calls), 3)
        self.assertEqual(self.agent.goal_status, "completed")
        self.assertIn("3 of 3", self.agent._goal_details["reason"])
        self.assertTrue(any("Did c3" in line for line in self.agent._goal_details["evidence"]))

    def test_each_turn_is_told_the_next_item(self):
        aid = self.make()
        self.assertTrue(self.agent.set_goal("checklist"))
        calls = self.run_goal([lambda p: self.done(aid, "c1"), lambda p: self.done(aid, "c2"), lambda p: self.done(aid, "c3")])
        self.assertIn("c2 [Not started] Add the tests", calls[1])
        self.assertIn("1 of 3 done", calls[1])
        self.assertIn("c3 [Not started] Write the README", calls[2])

    def test_it_ends_when_an_item_needs_the_user_and_says_which_and_why(self):
        aid = self.make()
        self.assertTrue(self.agent.set_goal("checklist"))

        def stuck(prompt):
            out = self.edit(aid, {"op": "set", "item": "c2", "status": "Needs you", "note": "No API key for the test server"})
            self.assertTrue(out.startswith("Changed"), out)
        calls = self.run_goal([lambda p: self.done(aid, "c1"), stuck])
        self.assertEqual(len(calls), 2)
        self.assertEqual(self.agent.goal_status, "blocked")
        reason = self.agent._goal_details["reason"]
        self.assertIn("c2 “Add the tests” needs you", reason)
        self.assertIn("No API key for the test server", reason)

    def test_a_completion_report_with_items_open_is_not_accepted(self):
        aid = self.make()
        self.assertTrue(self.agent.set_goal("checklist"))

        def claims(prompt):
            self.done(aid, "c1")
            self.agent._pending_goal_report = {"status": "completed", "summary": "All done", "evidence": ["trust me"]}
        calls = self.run_goal([claims, lambda p: self.done(aid, "c2"), lambda p: self.done(aid, "c3")])
        self.assertEqual(len(calls), 3)
        self.assertIn("not accepted", calls[1])
        self.assertIn("c2 “Add the tests”", calls[1])
        self.assertEqual(self.agent.goal_status, "completed")


class EverySurface(Base):
    def test_the_editor_protocol_and_the_capability_name_it(self):
        from dgc import artifact_commands, editor_protocol
        self.assertIn("checklist", editor_protocol.ARTIFACT_TYPES)
        self.assertIn("checklist", artifact_commands.CAPABILITY["artifacts"]["types"])
        self.assertIn("checklist", artifact_commands.CAPABILITY["artifacts"]["exports"])

    def test_the_editors_panel_gets_the_list_and_its_pictures(self):
        from dgc.artifact_commands import ArtifactCommands
        aid = self.make()
        (self.root / "shot.png").write_bytes(PNG)
        self.edit(aid, {"op": "set", "item": "c1", "status": "Done", "note": "Did it", "proof": [{"image": "shot.png"}]})
        sent = []
        ArtifactCommands(lambda kind, **fields: sent.append((kind, fields))).dispatch(
            {"type": "artifact_get", "request_id": "r1", "id": aid, "content": True})
        kind, fields = sent[-1]
        self.assertEqual(kind, "artifact_detail")
        name = fields["content"]["items"][0]["proof"][0]["file"]
        self.assertTrue(fields["state"]["pictures"][name].startswith("data:image/png;base64,"))

    def test_the_editors_save_is_one_version_by_you(self):
        from dgc.artifact_commands import ArtifactCommands
        aid = self.make()
        data = artifact_store.store().source(aid)
        data["items"][1]["status"] = "Done"
        sent = []
        ArtifactCommands(lambda kind, **fields: sent.append((kind, fields))).dispatch(
            {"type": "artifact_update", "request_id": "r2", "id": aid, "content": data, "base_version": 1})
        kind, fields = sent[-1]
        self.assertEqual(kind, "artifact_changed", fields)
        self.assertEqual(fields["artifact"]["progress"]["done"], 1)
        self.assertEqual(fields["artifact"]["versions"][-1]["summary"], "c2 “Add the tests”: Not started → Done")

    def test_it_shows_as_a_page_of_its_own_and_downloads(self):
        aid = self.make()
        self.edit(aid, {"op": "set", "item": "c1", "status": "Done", "note": "Wrote <b>it</b>", "proof": ["4 passed"]})
        html = service.render(aid)[0]["index.html"].decode()
        for words in ("Ship the parser", "Write the parser", "parse() reads every sample file", "Not started", "Done",
                      "1 of 3 done", "Wrote &lt;b&gt;it&lt;/b&gt;", "4 passed"):
            self.assertIn(words, html)
        self.assertNotIn("<script", html.lower())
        self.assertIn("md", service.view(aid)["exports"])
        text = service.export(aid, "md").read_text(encoding="utf-8")
        self.assertIn("- [x] **Write the parser**", text)
        self.assertIn("- [ ] **Add the tests**", text)

    def test_versions_compare_item_by_item_and_restore(self):
        aid = self.make()
        self.edit(aid, {"op": "set", "item": "c1", "status": "Building"})
        found = service.compare(aid, 1, 2)
        self.assertEqual([c["label"] for c in found["changes"]], ["c1 “Write the parser”"])
        service.restore(aid, 1)
        self.assertEqual(self.items(aid)[0]["status"], "Not started")

    def test_a_pip_may_keep_one(self):
        from dgc import pip_library
        self.assertIn("checklist", pip_library._ARTIFACT_TYPES)

    def test_find_artifacts_lists_it(self):
        aid = self.make()
        out = tools.execute("find_artifacts", {"query": "parser", "type": "checklist"}, self.ctx)
        self.assertIn(aid, out)
        self.assertIn("Checklist", out)


if __name__ == "__main__":
    unittest.main()
