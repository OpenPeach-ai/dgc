"""One kind of Pip (decided 13 Nov; finishing it 15 Nov): every Pip gets everything, a folder if it was given one,
and the safety is the wall of its box, its level and Allow cards. What was left of "Personal" vs "Project" Pips that
kept something from a Pip with a folder goes, gate by gate."""
import unittest
from unittest.mock import patch

from dgc import pip_chat_options, pip_logins, pip_memory_review
from tests import test_pips_local as fixtures


class OneKind(unittest.TestCase):
    def setUp(self):
        fixtures.LocalPipsTests.setUp(self)
        self.folder_pip = self.store.create(self.workspace["id"], "Auditor", "Read source", "editor-user")
        self.assertNotEqual(self.folder_pip["source_policy"], {"mode": "personal"}, "a Pip with a folder")

    def test_a_pip_with_a_folder_shows_how_full_its_context_is(self):
        # A9: "Context use is shown for Personal Pips." The estimate itself works for any Pip's chat.
        out = pip_chat_options.context_estimate(self.store, self.folder_pip["id"], self.cfg)
        self.assertEqual(out["pip_id"], self.folder_pip["id"])
        self.assertIn("used_tokens", out)
        self.assertIn("breakdown", out)


    def test_a_pip_with_a_folder_lists_and_saves_logins(self):
        # A7: "Saved logins are for Personal Pips." A Pip with a folder has its own computer and browser too.
        listed = pip_logins.handle(self.registry, "list_pip_logins", {"pip_id": self.folder_pip["id"]}, "editor-user")
        self.assertEqual(listed["logins"], [])
        pips = pip_logins._pips_list(self.registry, [self.folder_pip["id"]])
        self.assertEqual(pips, [self.folder_pip["id"]])

    def test_a_chat_with_a_pip_with_a_folder_feeds_the_one_memory_too(self):
        # A14: the look back over a chat (which feeds the user's one memory) skipped Pips with a folder.
        import json
        run = {"id": "run_" + "e" * 32}
        db = self.registry.db
        db.execute("PRAGMA foreign_keys=OFF")
        with self.registry.transaction():
            db.execute("INSERT INTO pip_runs(id,pip_id,workspace_id,binding_id,idempotency_key,requested_by,manifest,"
                       "status,created_at) VALUES(?,?,?,'b','k','editor-user',?,'succeeded',?)",
                       (run["id"], self.folder_pip["id"], self.folder_pip["workspace_id"],
                        json.dumps({"run_kind": "conversation"}), self.registry.clock()))
        db.execute("PRAGMA foreign_keys=ON")
        ended = []
        with patch.object(pip_memory_review, "_reviews", return_value=type("R", (), {"ended": lambda self, pip: ended.append(pip)})()), \
             patch("dgc.pip_notes.user_turn", return_value={"text": "I prefer short answers"}):
            pip_memory_review.after_run(self.registry, self.cfg, run["id"])
        self.assertEqual(ended, [self.folder_pip["id"]])


    def control(self, request, actor="editor-user"):
        from dgc import pips
        with patch("dgc.pips.WorkspaceRegistry", return_value=self.registry), patch.object(self.registry, "close"):
            return pips.handle_control(self.cfg, {"request_id": "r", **request}, actor, start_worker=False)

    def test_a_pip_with_a_folder_has_working_notes_and_a_daily_log_on_its_page(self):
        # A10: "Working notes and a daily log belong to a Personal Pip." Its page showed them, and they errored.
        for command in ("get_pip_working_notes", "list_pip_daily_log"):
            with self.subTest(command=command):
                out = self.control({"type": command, "pip_id": self.folder_pip["id"]})
                self.assertTrue(out["ok"], out)

    def test_a_pip_with_a_folder_writes_its_daily_log_line(self):
        from dgc import pip_daily_log
        run = {"id": "run_" + "d" * 32, "pip_id": self.folder_pip["id"], "manifest": {"run_kind": "personal_task"}}
        pip_daily_log.after_run(self.registry.directory, self.registry.db, run, status="succeeded",
                                result={"text": "Checked the build."})
        days = pip_daily_log.days(self.registry.directory, self.folder_pip["id"])
        self.assertTrue(days["days"], days)



# ------------------------------------------------------------------------------------- the backend half (16 Nov)
# "Nothing related ships half" (the rule, 16 Nov): what the backend still kept from a Pip with a folder goes, and a
# folder Pip's chat is the Personal chat plus its folder. The real worker with its model stood in, the real runner
# stopped at the hand-off, the real controls.

import json  # noqa: E402
import os  # noqa: E402

from tests.test_folder_pip_wall import WithABox  # noqa: E402
from dgc import pip_chat, pips  # noqa: E402
from dgc.llm import ChatResult, LLMClient  # noqa: E402

APPS = {"socket": "/nonexistent", "token": "t", "apps": [], "composio": False, "microsoft": False,
        "plugins": [{"plugin": "board", "name": "Board", "tools": 1}]}
OWN = {"name": "shop", "folder": "projects/shop", "files": 5, "kept": False, "updated": 5}


class FolderChat(WithABox):
    """A folder Pip (self.helper, in the "shop" project) and a Personal Pip with its computer (self.pip)."""

    def queued(self, pip=None, text="Tidy util.py", key="m-1", boxes=True):
        with patch.object(pips, "folder_boxes", return_value=boxes):
            sent = pip_chat.send(self.store, (pip or self.helper)["id"], text, key, "device_1", self.cfg)
        return json.loads(self.registry.db.execute("SELECT manifest FROM pip_runs WHERE id=?",
                                                   (sent["run"]["id"],)).fetchone()[0])

    def turn(self, manifest, *, box=True, apps=True, sees=True, **pins):
        manifest = dict(manifest)
        if box:
            manifest["computer_socket"] = {"socket": str(self.base / "absent.sock"), "token": "t" * 32}
            if manifest["source_policy"] != {"mode": "personal"}:
                manifest["own_folder"] = dict(OWN)
        if apps:
            manifest["app_socket"] = dict(APPS)
        manifest.update(pins)
        seen = {}

        def chat(client, messages, tools=None, on_text=None, **kwargs):
            seen["tools"] = {t["function"]["name"]: t for t in tools}
            seen["system"] = messages[0]["content"]
            seen["prompt"] = "\n".join(str(m.get("content")) for m in messages[1:] if m.get("role") == "user")
            return ChatResult(content="On it.")
        personal = manifest["source_policy"] == {"mode": "personal"}
        with patch.dict(os.environ, {"DGC_SESSION_POLICY": pips._json(pips.native_policy(personal=personal))}), \
             patch.object(LLMClient, "chat", chat), patch("dgc.agent.discover_skills", return_value={}), \
             patch("dgc.vision.has_vision", return_value=sees), \
             patch("requests.sessions.Session.request", side_effect=AssertionError("No network")):
            pips.execute_native(self.cfg, self.root, manifest, lambda event: None)
        return seen

    def handed(self):
        from tests.test_folder_pip_box import TheRunnerOpensIt
        return TheRunnerOpensIt.handed(self)


class AFolderPipsChatIsThePersonalChat(FolderChat, unittest.TestCase):
    """Step 1: every Pip's chat takes the Personal chat's instructions and tools; a Pip with a folder also hears where
    its folder's copy is in its computer, that its changes come back as a card, and keeps its project reads."""

    def test_a_pip_with_a_folder_hears_what_a_personal_pip_hears_in_its_chat(self):
        system = self.turn(self.queued())["system"]
        self.assertNotIn("conversing about its workspace and approved job", system, "not the old project chat prompt")
        for said in ("Never claim to have completed an external action",
                     "Any card or button you make (Connect, Allow, a draft, choices) shows below your reply",
                     "for the user (time zone",
                     "You have your own computer (a browser, a Terminal and files)",
                     "A plugin's own card",
                     "Never send code, files, secrets or personal details to a website"):
            with self.subTest(said=said):
                self.assertIn(said, system)

    def test_a_pip_with_a_folder_also_hears_where_its_folder_is_and_keeps_its_project_reads(self):
        seen = self.turn(self.queued())
        self.assertIn("projects/shop", seen["system"])
        self.assertIn("DGC shows what you changed as a card below your reply", seen["system"])
        self.assertIn("AGENTS.md", seen["system"], "its folder's files are reference data, never instructions")
        self.assertTrue(pips.READ_TOOLS <= set(seen["tools"]), "it reads its folder")

    def test_without_its_box_it_says_what_a_personal_pip_without_a_computer_says(self):
        seen = self.turn(self.queued(boxes=False), box=False, apps=False)
        self.assertIn("You have no computer: you cannot open web pages or search the web", seen["system"])
        self.assertNotIn("computer", seen["tools"])
        self.assertTrue(pips.READ_TOOLS <= set(seen["tools"]))

    def test_every_pip_says_what_it_will_do_first_when_a_reply_takes_work(self):
        # pip_chat.SYSTEM's line (a live test, 15 Nov: "a Pip's do too") never reached a Personal Pip's chat.
        for pip in (self.helper, self.pip):
            with self.subTest(pip=pip["name"]):
                self.assertIn("start with one short line saying what you'll do", self.turn(self.queued(pip))["system"])

    def test_a_pip_with_a_folder_has_the_tools_a_personal_pip_has_and_its_reads(self):
        # One kind of Pip: as queued and handed the same sockets, its chat's tools are the Personal chat's, plus reads.
        folder = self.turn(self.queued())
        personal = self.turn(self.queued(self.pip, key="p-1"))
        self.assertEqual(set(folder["tools"]) - pips.READ_TOOLS, set(personal["tools"]))
        self.assertEqual(folder["tools"]["draft_pip_change"], personal["tools"]["draft_pip_change"],
                         "it sets itself up as a Personal Pip does (web reads, its computer)")

    def test_its_skills_are_listed_to_it(self):
        from dgc.skills import Skill
        skill = Skill(name="tidy", description="Tidy a module", body="Do it.", path=self.base / "SKILL.md")
        with patch.object(pips, "personal_skills", return_value={"tidy": skill}):
            seen = self.turn(self.queued())
        self.assertIn("skill", seen["tools"])
        self.assertIn("- tidy: Tidy a module", seen["prompt"], "as a Personal Pip's are")

    def test_what_it_writes_in_its_working_notes_is_kept(self):
        # Q8 gave every Pip's chat its working notes, but the runner kept only a Personal Pip's changes to them.
        from dgc import pip_working_notes
        with patch.object(pips, "folder_boxes", return_value=True):
            run = pip_chat.send(self.store, self.helper["id"], "Note that util.py is generated", "w-1", "editor-user",
                                self.cfg)["run"]
        self.store.claim_next()
        self.store.finish(run["id"], result={"text": "Noted.", "working_notes": [
            {"op": "add", "line": "util.py is generated: never edit it by hand"}]})
        self.assertEqual(pip_working_notes.read(self.registry.directory, self.helper["id"]),
                         ["util.py is generated: never edit it by hand"])


class TheGatesThatFollow(FolderChat, unittest.TestCase):
    """Step 2: one test a gate, "a Pip with a folder now ..."."""

    def test_a13_a_pip_with_a_folder_now_hears_the_setup_questions_on_slash_setup(self):
        from dgc.pip_own_changes import SETUP
        system = self.turn(self.queued(text="/setup review my pull requests"))["system"]
        self.assertIn(SETUP.split("{job}")[0], system)

    def test_a8_a_pip_with_a_folder_now_has_eyes_on_its_page(self):
        status = self.control("get_pip_eyes", pip_id=self.helper["id"])["eyes"]
        self.assertEqual(status["pip_id"], self.helper["id"])
        self.assertEqual(self.control("set_pip_eyes", pip_id=self.helper["id"], choice="off")["eyes"]["choice"], "off")

    def test_a8_a_pip_with_a_folder_now_is_told_how_it_sees_in_its_chat(self):
        self.assertIn("computer_eyes", self.handed(), "its chat's run is told how it sees")

    def test_a8_a_pip_with_a_folder_now_sees_through_the_model_chosen_for_it(self):
        from dgc import pip_computer
        seen = self.turn(self.queued(), sees=False,
                         computer_eyes={"choice": "relay", "vision_model": "seer", "convention": "pixels"})
        self.assertIn(pip_computer.RELAY_NOTICE, seen["system"], "a model that sees looks for it, as chosen")

    def test_a6_a_pip_with_a_folder_now_has_its_own_keys(self):
        from dgc import pip_keys
        listed = self.control("list_pip_keys", pip_id=self.helper["id"])
        self.assertEqual(listed["keys"], [])
        pip_keys.request(self.registry, self.cfg, self.helper["id"], self.helper["workspace_id"], None,
                         {"name": "Invoicely API key", "why": "To read invoices.", "host": "api.invoicely.example"})
        [card] = self.control("list_pip_keys", pip_id=self.helper["id"])["keys"]
        with patch("dgc.pip_chat.continue_after_key"):
            saved = self.control("save_pip_key", pip_id=self.helper["id"], key_id=card["id"], value="inv_live_0123456789abcdef")
        self.assertEqual(saved["key"]["status"], "saved")
        names = [{"name": "INVOICELY_API_KEY", "host": "api.invoicely.example"}]
        seen = self.turn(self.queued(), terminal_keys=names)
        self.assertIn(pip_keys.terminal_notice(names).split(". Use them")[0], seen["system"], "its Terminal's keys at Do it all")

    def test_a5_a_pip_with_a_folder_now_borrows_the_users_chrome_in_its_chat(self):
        from dgc import pip_borrow
        self.assertEqual(self.control("list_pip_borrows", pip_id=self.helper["id"])["pip_id"], self.helper["id"])
        lent = {"id": "borrow_" + "a" * 32, "sites": ["bank.example"]}
        seen = self.turn(self.queued(), app_socket={**APPS, "borrow": lent})
        self.assertIn(pip_borrow.use_notice(lent), seen["system"])
        self.assertIn(pip_borrow.USE, seen["tools"])

    def test_a3_a_pip_with_a_folder_now_connects_apps(self):
        listed = self.control("list_pip_app_links", pip_id=self.helper["id"])
        self.assertEqual((listed["pip_id"], listed["links"]), (self.helper["id"], []))

    def test_a4_a_pip_with_a_folder_now_has_its_plugin_switch_and_plugin_drafts(self):
        listed = self.control("list_pip_plugins", pip_id=self.helper["id"])
        self.assertIn("plugins", listed)
        run = self.finished_chat()
        from dgc import pip_app_actions
        source = pip_app_actions._source(self.store, run["id"])
        self.assertEqual((source["pip_id"], source["workspace_id"]), (self.helper["id"], self.helper["workspace_id"]))
        self.assertEqual(self.control("list_pip_connector_drafts", pip_id=self.helper["id"])["drafts"], [])

    def finished_chat(self, result=None):
        with patch.object(pips, "folder_boxes", return_value=True):
            run = pip_chat.send(self.store, self.helper["id"], "Email the team that the build is green", "d-1",
                                "editor-user", self.cfg)["run"]
        self.store.claim_next()
        return self.store.finish(run["id"], result=result or {"text": "Done."})

    def test_a11_a_pip_with_a_folder_now_drafts_email_events_and_app_actions_and_its_level_decides(self):
        from dgc import pip_levels, pip_message_drafts
        queued = self.queued()
        for pin in ("email_draft", "calendar_draft", "connector_draft", "action_grants"):
            with self.subTest(pin=pin):
                self.assertIn(pin, queued, "pinned for its chat as for a Personal Pip's")
        seen = self.turn(queued, approval_level={"level": pip_levels.APPROVE, "unattended": False, "pays": False})
        self.assertTrue({pip_message_drafts.TOOL, "draft_calendar_event"} <= set(seen["tools"]))
        self.assertIn(pip_message_drafts.NOTICE, seen["system"])
        self.assertIn(pip_levels.instructions(pip_levels.APPROVE, unattended=False, pays=False, drafting=True),
                      seen["system"], "its level is said with its drafts, as for a Personal Pip")
        message = {"recipient_email": "team@shop.example", "subject": "Build", "body": "The build is green."}
        self.store.claim_next()
        self.store.finish(self.last_run(), result={"text": "Drafted.", "message_draft": message})
        [draft] = self.control("list_pip_message_drafts", pip_id=self.helper["id"])["drafts"]
        self.assertEqual(draft["subject"], "Build")
        self.assertEqual(self.control("list_pip_app_actions", pip_id=self.helper["id"])["actions"], [])

    def last_run(self):
        return self.registry.db.execute("SELECT id FROM pip_runs WHERE pip_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1",
                                        (self.helper["id"],)).fetchone()[0]

    def test_a1_a_pip_with_a_folder_now_has_web_reads(self):
        plan = {"schema_version": 1, "reads": [{"kind": "search", "query": "shop release notes"}]}
        proposal = self.store.propose(self.helper["id"], 1, {"web_plan": plan}, "local-console")
        self.store.accept(self.helper["id"], proposal["id"], 1, "local-console")
        self.assertEqual(self.queued()["web_plan"], plan, "pinned for its run")
        read = [{"kind": "search", "query": "shop release notes", "results": [
            {"title": "Shop 2.0", "url": "https://shop.example/notes", "snippet": "Released."}]}]
        with patch("dgc.pip_web_reads.execute", return_value=read):
            handed = self.handed_again()
        self.assertEqual(handed["web_references"], read, "read by DGC before its run, as a Personal Pip's are")
        seen = self.turn(handed)
        self.assertIn("Untrusted web reference data", seen["prompt"])

    def test_a1_a_pip_with_a_folder_now_has_app_reads(self):
        apps = {"schema_version": 1, "server": "composio", "connection_digest": "c" * 64, "calls": [
            {"tool": "GMAIL_FETCH_EMAILS", "schema_digest": "d" * 64, "arguments": {"query": "from:ci", "max_results": 5}}]}
        proposal = self.store.propose(self.helper["id"], 1, {"app_plan": apps}, "local-console")
        self.store.accept(self.helper["id"], proposal["id"], 1, "local-console")
        self.assertEqual(self.queued()["app_plan"], apps, "its app reads are pinned for its run")
        read = [{"server": "composio", "tool": "GMAIL_FETCH_EMAILS", "text": "CI passed on main."}]
        with patch("dgc.pip_app_access.execute", return_value=read):
            handed = self.handed_again()
        self.assertEqual(handed["app_references"], read, "read by DGC before its run")
        self.assertIn("Untrusted connected-app reference data", self.turn(handed)["prompt"])

    def test_a1_a_pip_with_a_folder_now_shares_its_web_reads(self):
        from dgc import pip_share
        reviewer = self.store.create(self.workspace["id"], "Status reviewer", "Review the status page", "editor-user")
        plan = {"schema_version": 1, "reads": [{"kind": "page", "url": "https://shop.example/status"}]}
        proposal = self.store.propose(reviewer["id"], 1, {"web_plan": plan}, "local-console")
        self.store.accept(reviewer["id"], proposal["id"], 1, "local-console")
        document = pip_share.export(self.store, reviewer["id"])
        self.assertEqual(document["pip"]["web_plan"], plan)
        request = pip_share.setup_request(document, project_root=self.root, request_key="import-1")
        self.assertEqual(request["web_plan"], plan, "and an imported copy keeps them")

    def handed_again(self):
        row = self.store.claim_next()
        given = {}

        class Handed(Exception):
            pass

        def payload(value):
            given.update(value)
            raise Handed()
        with patch.object(pips, "folder_boxes", return_value=True), patch.object(pips, "_worker_payload", side_effect=payload):
            try:
                pips._execute_run(self.registry, row, self.cfg)
            except Handed:
                pass
        return given.get("manifest") or {}

    def test_a2_a_pip_with_a_folder_now_is_given_and_loses_its_computer_like_any_pip(self):
        plan = {"schema_version": 1}
        with patch.object(pips, "folder_boxes", return_value=True):
            self.assertTrue(pips.has_box(self.store._job(self.helper["id"])), "its box by default, as before")
            removal = self.store.propose(self.helper["id"], 1, {"computer_plan": None}, "local-console")
            self.store.accept(self.helper["id"], removal["id"], 1, "local-console")
            self.assertFalse(pips.has_box(self.store._job(self.helper["id"])), "Remove computer takes its box away")
            self.assertNotIn("computer", self.queued(boxes=True), "and its chat runs without one")
            given = self.store.propose(self.helper["id"], 2, {"computer_plan": plan}, "local-console")
            self.store.accept(self.helper["id"], given["id"], 2, "local-console")
            self.assertEqual(self.store.get(self.helper["id"])["computer_plan"], plan)
            self.assertTrue(pips.has_box(self.store._job(self.helper["id"])), "Give a computer gives it back")
            renamed = self.store.propose(self.helper["id"], 3, {"name": "Shop keeper"}, "local-console")
            self.store.accept(self.helper["id"], renamed["id"], 3, "local-console")
            self.assertTrue(pips.has_box(self.store._job(self.helper["id"])), "a rename keeps it")
            made = self.control("create_pip", workspace_id=self.workspace["id"], name="No box", goal="Read",
                                pip_type="rook", computer=False)["pip"]
            self.assertFalse(pips.has_box(self.store._job(made["id"])), "made without one, it has none")
            made = self.control("create_pip", workspace_id=self.workspace["id"], name="Boxed", goal="Read",
                                pip_type="rook", computer=True)["pip"]
            self.assertEqual(made["computer_plan"], plan)

    def test_a1_a2_its_chat_may_ask_for_web_reads_and_a_computer(self):
        # Its reply's setup draft was refused for anything but its name, goal, schedule and model ("A Pip in a project
        # folder changes only ..."): now it asks for web reads and a computer as a Personal Pip does, for the user's review.
        plan = {"schema_version": 1, "reads": [{"kind": "page", "url": "https://shop.example/status"}]}
        with patch.object(pips, "folder_boxes", return_value=False):
            run = pip_chat.send(self.store, self.helper["id"], "Watch the status page", "s-1", "editor-user", self.cfg)["run"]
            self.store.claim_next()
            self.store.finish(run["id"], result={"text": "Set.", "setup_draft": {
                "changes": {"web_plan": plan, "computer_plan": {"schema_version": 1}}, "reason": "The user asked."}})
        [proposal] = self.store.get(self.helper["id"])["proposals"]
        self.assertEqual((proposal["definition"]["web_plan"], proposal["definition"]["computer_plan"]),
                         (plan, {"schema_version": 1}))

    def test_a1_a2_the_main_chat_may_set_up_a_folder_pip_with_web_reads_and_a_computer(self):
        from dgc import pip_setup
        request = pip_setup.validate_request({
            "target_root": str(self.root), "name": "Status watcher", "goal": "Watch the status page", "pip_type": "rook",
            "work_kind": "source_review", "scope": "project", "schedule": None, "run_now": False,
            "reason": "The user asked", "request_key": "web-setup", "computer": True,
            "web_plan": {"schema_version": 1, "reads": [{"kind": "page", "url": "https://shop.example/status"}]}})
        self.assertTrue(request["computer"])
        self.assertIn("web_plan", request)

    def test_a12_a_pip_with_a_folder_now_takes_an_at_project_into_its_box(self):
        from dgc import pip_project_copies as copies
        with patch.object(pips, "folder_boxes", return_value=True):
            told = copies.prepare(self.store, self.helper["id"], [self.mark()], "k-1")
        self.assertEqual([t["folder"] for t in told], ["projects/shop"])
        with patch.object(pips, "folder_boxes", return_value=False):
            with self.assertRaises(pips.RegistryError) as raised:
                copies.prepare(self.store, self.helper["id"], [self.mark()], "k-2")
        self.assertEqual(raised.exception.code, "needs_computer", "without its box it has nowhere to put it")

    def test_core_stays_the_primary_pip_in_personal_and_paired_controls_still_cant_reach_personal_pips(self):
        # Kept by design (C list): unchanged, pinned here so the one-kind work never moves them.
        with self.assertRaises(pips.RegistryError):
            self.store.create(self.workspace["id"], "Core", None, "editor-user", pip_type="core")
        with self.assertRaises(pips.RegistryError) as raised:
            self.control("get_pip", pip_id=self.pip["id"], actor="device_1")
        self.assertIn(raised.exception.code, ("local_only", "not_found", "workspace_mismatch", "permission_denied"))


if __name__ == "__main__":
    unittest.main()
