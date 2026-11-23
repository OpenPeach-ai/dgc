"""One Pips (decided 13 Nov): one list of every Pip, and a Pip in a project folder made with only a name.

"Single Pips section becomes much cleaner": the editor shows one list, no Personal | Project tabs. `list_pips
{scope: "all"}` (Pips API 94) gives the Personal Pips and every project's together: Core first, then the Pip with the
latest message or report ("the new latest message pip should auto come on top, like it happens on messaging apps ...
Except of Core Pip"), temporary and DGC-owned folders left out as everywhere else. And "we don't want user to define the
goal while creating a Pip": a folder Pip with no goal starts with the same "help with what I ask in this chat" a
Personal Pip does, and is set up by talking to it.
"""
import json
import unittest
from unittest import mock

from dgc import pips, project_folders, sessions
from tests import test_pips_local as fixtures


def fill_row(db, table: str, given: dict) -> None:
    """Insert one row, giving every other NOT NULL column without a default a plain value."""
    values = dict(given)
    for _cid, name, kind, notnull, default, _pk in db.execute(f"PRAGMA table_info({table})"):
        if name in values or not notnull or default is not None:
            continue
        values[name] = 0 if "INT" in (kind or "").upper() else ("{}" if name in ("manifest", "post") else "x")
    keys = ",".join(values)
    db.execute(f"INSERT INTO {table}({keys}) VALUES({','.join('?' * len(values))})", list(values.values()))


class OneList(unittest.TestCase):
    setUp_base = fixtures.LocalPipsTests.setUp

    def setUp(self):
        self.setUp_base()
        for p in (mock.patch.object(sessions, "_temporary_roots", lambda: ()),):   # (these projects are in the temp folder)
            p.start()
            self.addCleanup(p.stop)
        self.personal = self.registry.personal()
        self.core = self.store.create(self.personal["id"], "Core", "", "local-console", pip_type="core")
        self.brief = self.store.create(self.personal["id"], "Morning brief", "", "local-console", pip_type="quill")
        self.reviewer = self.store.create(self.workspace["id"], "Reviewer", "Review the code.", "local-console", pip_type="rook")
        other = self.base / "elsewhere" / "garden"
        other.mkdir(parents=True)
        self.garden = self.registry.resolve(other)
        self.planner = self.store.create(self.garden["id"], "Bed planner", "Plan the beds.", "local-console", pip_type="lens")

    def all(self, **kw):
        return project_folders.pips_all(self.store, **kw)

    def said(self, pip, at):
        """A chat message from this Pip at `at`."""
        from dgc import pip_chat
        pip_chat.ensure(self.store.db) if hasattr(pip_chat, "ensure") else None
        import hashlib
        run = "run_" + hashlib.sha256((pip["id"] + at).encode()).hexdigest()[:24]
        fill_row(self.store.db, "pip_runs", {"id": run, "pip_id": pip["id"], "workspace_id": pip["workspace_id"],
                                             "binding_id": self.registry.get(pip["workspace_id"])["binding_id"] or "b",
                                             "created_at": at, "status": "succeeded", "manifest": "{}",
                                             "idempotency_key": run})
        fill_row(self.store.db, "pip_chat_messages", {"id": "msg_" + run, "pip_id": pip["id"], "workspace_id": pip["workspace_id"],
                                                      "run_id": run, "role": "assistant", "text": "Done.", "model": "m",
                                                      "created_at": at})

    def posted(self, pip, at):
        from dgc import pip_run_posts
        pip_run_posts.ensure(self.store.db)
        self.store.db.execute("INSERT INTO pip_run_posts VALUES(?,?,?,?,?)",
                              ("post_" + pip["id"][-6:] + at[-8:-5], pip["id"], pip["workspace_id"], at, json.dumps({"k": 1})))

    def test_every_pip_in_one_list_core_first_then_the_latest_activity(self):
        self.said(self.planner, "2026-10-03T09:00:00.000Z")
        self.posted(self.reviewer, "2026-10-04T09:00:00.000Z")
        self.said(self.brief, "2026-10-02T09:00:00.000Z")
        names = [p["name"] for p in self.all()["pips"]]
        self.assertEqual(names, ["Core", "Reviewer", "Bed planner", "Morning brief"])
        self.said(self.brief, "2026-10-05T09:00:00.000Z")          # a new message: it comes to the top, under Core
        self.assertEqual([p["name"] for p in self.all()["pips"]][:2], ["Core", "Morning brief"])

    def test_each_says_where_it_works_and_the_page_is_paged_and_searched(self):
        page = self.all()
        self.assertEqual(page["total"], 4)
        where = {p["name"]: p["workspace_id"] for p in page["pips"]}
        self.assertEqual(where["Core"], self.personal["id"])
        self.assertEqual(where["Bed planner"], self.garden["id"])
        first = self.all(limit=2)
        self.assertEqual((len(first["pips"]), first["next_offset"]), (2, 2))
        self.assertIsNone(self.all(limit=2, offset=2)["next_offset"])
        self.assertEqual([p["name"] for p in self.all(query="beds")["pips"]], ["Bed planner"])

    def test_a_temporary_folders_pips_are_left_out(self):
        with mock.patch.object(sessions, "_temporary_roots", lambda: (self.garden_root(),)):
            self.assertNotIn("Bed planner", [p["name"] for p in self.all()["pips"]])

    def garden_root(self):
        return (self.base / "elsewhere").resolve()

    def test_through_the_pips_api(self):
        from dgc.headless import PIPS_API_VERSION
        self.assertGreaterEqual(PIPS_API_VERSION, 94)
        self.assertIn("scope", pips._COMMAND_ARGS["list_pips"])
        source = open(pips.__file__).read()
        self.assertIn('"all"', source[source.index('elif command == "list_pips"'):][:3000])


class NameOnly(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp

    def test_a_folder_pip_with_only_a_name_is_set_up_in_its_chat(self):
        pip = self.store.create(self.workspace["id"], "Front end", "", "local-console", pip_type="rook")
        self.assertEqual(pip["goal"], pips.NAMED_GOAL)
        none = self.store.create(self.workspace["id"], "Docs", None, "local-console", pip_type="quill")
        self.assertEqual(none["goal"], pips.NAMED_GOAL)

    def test_core_is_still_only_personal(self):
        with self.assertRaises(Exception):
            self.store.create(self.workspace["id"], "Core", "", "local-console", pip_type="core")


if __name__ == "__main__":
    unittest.main()


class FolderSetsItselfUp(unittest.TestCase):
    """A Pip in a project folder sets itself up in its own chat (13 Nov: "if user gives it a goal in the chat, so pip
    auto sets it as a goal"), as a Personal Pip does: in a turn the user started, its name, instructions, schedule and
    model change when its reply is saved, with Undo. Its branch and the files it reads stay on its page for now, and it
    never drafts web reads or a computer (a folder Pip has neither yet)."""
    setUp = fixtures.LocalPipsTests.setUp
    git = fixtures.LocalPipsTests.git
    commit = fixtures.LocalPipsTests.commit

    def job(self):
        self.commit()
        return self.store.create(self.workspace["id"], "Front end", "", "user", pip_type="rook")

    def turn(self, job, key="reply", text="Look after the checkout page's front end"):
        from dgc import pip_chat
        dgc_turn = key.startswith(pip_chat.DGC_KEYS)
        run = pip_chat.send(self.store, job["id"], text, key, "local-routine" if dgc_turn else "user", self.cfg,
                            _intro=dgc_turn)["run"]
        self.store.claim_next()
        return run

    def test_your_turn_changes_it_at_once_and_undo_puts_it_back(self):
        from dgc import pip_own_changes as own
        job = self.job()
        run = self.turn(job)
        self.assertTrue(run["manifest"]["chat_setup"]["direct"], "you typed it")
        self.store.finish(run["id"], result={"text": "On it.", "setup_draft": {"changes": {
            "name": "Checkout UI", "goal": "Review the checkout page's front end and suggest fixes"},
            "reason": "The user asked for it."}})
        saved = self.store.get(job["id"])
        self.assertEqual((saved["name"], saved["goal"], saved["current_version"]),
                         ("Checkout UI", "Review the checkout page's front end and suggest fixes", 2))
        self.assertEqual(saved["proposals"], [], "no review card")
        [change] = own.for_runs(self.registry.db, [run["id"]])[run["id"]]
        self.assertEqual(own.undo(self.store, job["id"], change["id"], "editor-user")["status"], "undone")
        self.assertEqual(self.store.get(job["id"])["goal"], pips.NAMED_GOAL)

    def test_a_turn_dgc_started_is_not_direct(self):
        job = self.job()
        run = self.turn(job, key="routine_morning", text="This message is from DGC, not the user.")
        self.assertFalse(run["manifest"]["chat_setup"]["direct"])

    def test_it_drafts_web_reads_and_a_computer_as_a_personal_pip_does(self):
        # Changed on purpose (one kind of Pip, 16 Nov): it drafted only its name, goal, schedule and model ("never web
        # reads or a computer"). Now its chat sets itself up as a Personal Pip's does; web reads and a computer still
        # wait for the user's review (pip_chat_setup.commit), and its branch and files stay on its page.
        from dgc import pip_chat_setup
        asked = pip_chat_setup.validate({"changes": {"computer_plan": {"schema_version": 1}, "web_plan": {
            "schema_version": 1, "reads": [{"kind": "search", "query": "x"}]}}, "reason": "r"})
        self.assertEqual(set(asked["changes"]), {"computer_plan", "web_plan"})
        self.assertEqual(pip_chat_setup.validate({"changes": {"goal": "Review it"}, "reason": "r"})["changes"],
                         {"goal": "Review it"})
        schema = pip_chat_setup.schema()["function"]["parameters"]["properties"]["changes"]["properties"]
        self.assertEqual(set(schema), {"name", "goal", "schedule", "model_choice", "web_plan", "computer_plan"})
        self.assertIn(pip_chat_setup.FOLDER_NOTE, pip_chat_setup.notice(direct=True, project=True))
