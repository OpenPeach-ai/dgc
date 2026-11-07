"""A Personal Pip's own apps, connected from its chat like Grok's connectors (pip_app_links)."""
import json
import socket
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from dgc import pip_app_access as apps, pip_app_links as links, pips
from dgc.workspace_registry import RegistryError
from tests.test_pip_app_access import MetaManager
from tests import test_pips_local as fixtures

COMPOSIO = {"transport": "remote", "url": "https://connect.composio.dev/mcp"}


class Composio(MetaManager):
    """Composio's meta tools: MANAGE_CONNECTIONS (list/add), MULTI_EXECUTE and GET_TOOL_SCHEMAS."""
    def __init__(self, world):
        super().__init__()
        self.world = world
        self._routes["manage"] = ("composio", "COMPOSIO_MANAGE_CONNECTIONS")

    def tool_schemas(self):
        return super().tool_schemas() + [{"function": {"name": "manage", "parameters": {"type": "object"}}}]

    def call(self, name, args, **kwargs):
        if name != "manage":
            return super().call(name, args, **kwargs)
        self.calls.append((name, args))
        self.world["calls"].append(args["toolkits"][0])
        item = args["toolkits"][0]
        result = {"toolkit": item["name"], "status": "active" if self.world["accounts"] else "initiated",
                  "accounts": list(self.world["accounts"])}
        if item.get("action", "add") == "add":
            result["redirect_url"] = self.world["redirect"]
        return json.dumps({"successful": True, "error": None, "data": {"results": {item["name"]: result}}})


class AppLinkTests(unittest.TestCase):
    def setUp(self):
        fixtures.LocalPipsTests.setUp(self)
        self.cfg.data["mcp_servers"] = {"composio": dict(COMPOSIO)}
        self.world = {"accounts": [], "redirect": "https://connect.composio.dev/link/ln_abc", "calls": []}
        self.managers = []
        def factory(*a, **k):
            manager = Composio(self.world)
            self.managers.append(manager)
            return manager
        self.factory = factory
        self.pip = self.store.create(self.registry.personal()["id"], "Inbox", "Help with my mail", "local-console")

    def ask(self, app="gmail", why="To read your new mail each morning."):
        return links.request(self.registry, self.pip["id"], self.pip["workspace_id"], app, why, None)

    def test_the_pip_asks_once_per_app_and_asking_again_refreshes_the_card(self):
        first = self.ask()
        self.assertEqual((first["toolkit"], first["app"], first["status"]), ("gmail", "Gmail", "requested"))
        again = self.ask(why="To find the invoice from Acme.")
        self.assertEqual(again["id"], first["id"])
        self.assertEqual(again["reason"], "To find the invoice from Acme.")
        self.assertEqual(self.ask("Google Calendar".replace(" ", "")).get("toolkit"), "googlecalendar")
        self.assertEqual([i["toolkit"] for i in links.listing(self.registry, self.pip["id"])], ["googlecalendar", "gmail"])
        for bad in ("", "../etc", "x" * 60, "gmail; rm -rf /"):
            with self.subTest(app=bad), self.assertRaises(RegistryError):
                self.ask(bad)

    def test_apps_asked_for_in_the_same_millisecond_are_listed_newest_first(self):
        # A fast machine asks for two apps within a millisecond: the cards tied on their time and came back in the
        # order of their random ids, oldest first half the time (the Mac Studio, 2026-10-24). Here each new card's
        # id sorts before the last one's.
        ids = (uuid.UUID(int=n) for n in range(2 ** 120, 0, -1))
        with patch.object(links, "utc_now", lambda: "2026-10-24T00:00:00.000Z"), \
                patch.object(links.uuid, "uuid4", lambda: next(ids)):
            for app in ("gmail", "googlecalendar", "slack"):
                self.ask(app)
        self.assertEqual([i["toolkit"] for i in links.listing(self.registry, self.pip["id"])],
                         ["slack", "googlecalendar", "gmail"])

    def test_connect_lists_first_then_starts_a_sign_in_and_only_the_user_may(self):
        card = self.ask()
        with self.assertRaises(RegistryError):
            links.start(self.registry, self.cfg, card["id"], "main-chat", manager_factory=self.factory)
        started = links.start(self.registry, self.cfg, card["id"], "editor-user", manager_factory=self.factory)
        self.assertEqual(started["link"]["status"], "authorizing")
        self.assertEqual(started["redirect_url"], "https://connect.composio.dev/link/ln_abc")
        self.assertEqual(started["sign_in_host"], "connect.composio.dev")
        self.assertEqual(self.world["calls"], [{"name": "gmail", "action": "list"}, {"name": "gmail", "action": "add"}])
        self.assertTrue(all(m.closed for m in self.managers), "every Composio session is closed")

    def test_an_account_composio_already_has_is_listed_and_only_the_one_chosen_is_linked(self):
        self.world["accounts"] = [{"id": "gmail_A1b2C3d4E5f6G7h8", "status": "ACTIVE", "user_info": {"email": "pitch@example.com"}},
                                  {"id": "gmail_Z9y8X7w6V5u4T3s2", "status": "ACTIVE", "user_info": {"email": "dev@example.com"}},
                                  {"id": "gmail_N0tActiveYet00000", "status": "INITIATED", "user_info": {"email": "new@example.com"}}]
        card = self.ask()
        started = links.start(self.registry, self.cfg, card["id"], "editor-user", manager_factory=self.factory)
        # Two accounts, and the first one was bound without a word: the wrong inbox.
        self.assertEqual((started["link"]["status"], started["link"]["label"], started["redirect_url"]), ("requested", None, None))
        self.assertEqual([a["label"] for a in started["accounts"]], ["pitch@example.com", "dev@example.com"], "by address, active only")
        self.assertEqual(started["wanted"], "")
        self.assertEqual(links.connected(self.registry, self.pip["id"]), [], "nothing is linked until the person chooses")
        self.assertEqual(self.world["calls"], [{"name": "gmail", "action": "list"}], "no new auth link")
        linked = links.start(self.registry, self.cfg, card["id"], "editor-user", account="gmail_Z9y8X7w6V5u4T3s2", manager_factory=self.factory)
        self.assertEqual((linked["link"]["status"], linked["link"]["label"], linked["connected"]), ("connected", "dev@example.com", True))
        self.assertEqual(links.connected(self.registry, self.pip["id"])[0]["account"], "gmail_Z9y8X7w6V5u4T3s2", "the one chosen, not the first")

    def test_one_account_is_still_the_persons_to_choose(self):
        self.world["accounts"] = [{"id": "ca_only", "status": "ACTIVE", "user_info": {"email": "me@example.com"}}]
        card = self.ask()
        started = links.start(self.registry, self.cfg, card["id"], "editor-user", manager_factory=self.factory)
        self.assertEqual(started["link"]["status"], "requested")
        self.assertEqual([a["id"] for a in started["accounts"]], ["ca_only"])
        self.assertEqual(links.connected(self.registry, self.pip["id"]), [])

    def test_an_address_the_pip_names_comes_first_and_never_binds_anything(self):
        pitch = {"id": "ca_pitch", "status": "ACTIVE", "user_info": {"email": "pitch@example.com"}}
        dev = {"id": "ca_dev", "status": "ACTIVE", "user_info": {"email": "dev@example.com"}}
        self.world["accounts"] = [pitch, dev]
        card = self.ask(why="To read the company inbox, Dev@Example.com, each morning.")
        started = links.start(self.registry, self.cfg, card["id"], "editor-user", manager_factory=self.factory)
        self.assertEqual([(a["label"], a.get("named", False)) for a in started["accounts"]],
                         [("dev@example.com", True), ("pitch@example.com", False)])
        self.assertEqual(started["wanted"], "")
        self.assertEqual(started["link"]["status"], "requested", "a match is first on the list, and still not linked")
        self.assertEqual(links.connected(self.registry, self.pip["id"]), [])

    def test_an_address_no_account_matches_is_said_and_nothing_is_guessed(self):
        self.world["accounts"] = [{"id": "ca_pitch", "status": "ACTIVE", "user_info": {"email": "pitch@example.com"}}]
        card = self.ask(why="To read dev@example.com for the company.")
        started = links.start(self.registry, self.cfg, card["id"], "editor-user", manager_factory=self.factory)
        self.assertEqual(started["wanted"], "dev@example.com")
        self.assertEqual([a["label"] for a in started["accounts"]], ["pitch@example.com"])
        self.assertEqual(started["link"]["status"], "requested")
        self.assertEqual(links.connected(self.registry, self.pip["id"]), [])

    def test_a_chosen_account_composio_no_longer_has_links_nothing(self):
        self.world["accounts"] = [{"id": "ca_pitch", "status": "ACTIVE", "user_info": {"email": "pitch@example.com"}}]
        card = self.ask()
        said = links.start(self.registry, self.cfg, card["id"], "editor-user", account="ca_gone", manager_factory=self.factory)
        self.assertEqual(said["link"]["status"], "requested")
        self.assertIn("isn't in Composio now", said["error"])
        self.assertEqual([a["id"] for a in said["accounts"]], ["ca_pitch"], "the list again, to choose from")
        self.assertEqual(links.connected(self.registry, self.pip["id"]), [])

    def test_use_another_account_opens_a_sign_in_and_links_only_the_one_it_added(self):
        pitch = {"id": "ca_pitch", "status": "ACTIVE", "user_info": {"email": "pitch@example.com"}}
        self.world["accounts"] = [pitch]
        card = self.ask()
        opened = links.start(self.registry, self.cfg, card["id"], "editor-user", another=True, manager_factory=self.factory)
        self.assertEqual(opened["link"]["status"], "authorizing")
        self.assertEqual(opened["redirect_url"], "https://connect.composio.dev/link/ln_abc")
        self.assertEqual([c["action"] for c in self.world["calls"]], ["list", "add"])
        # The sign-in isn't done: the account that was already there is not taken for it.
        waiting = links.check(self.registry, self.cfg, card["id"], "editor-user", manager_factory=self.factory)
        self.assertEqual((waiting["connected"], waiting["link"]["status"]), (False, "authorizing"))
        self.world["accounts"] = [pitch, {"id": "ca_dev", "status": "ACTIVE", "user_info": {"email": "dev@example.com"}}]
        done = links.check(self.registry, self.cfg, card["id"], "editor-user", manager_factory=self.factory)
        self.assertEqual((done["connected"], done["link"]["label"]), (True, "dev@example.com"))
        self.assertEqual(links.connected(self.registry, self.pip["id"])[0]["account"], "ca_dev", "not the first one listed")

    def test_two_new_accounts_or_a_sign_in_this_process_did_not_open_go_back_to_the_list(self):
        pitch = {"id": "ca_pitch", "status": "ACTIVE", "user_info": {"email": "pitch@example.com"}}
        self.world["accounts"] = [pitch]
        card = self.ask()
        links.start(self.registry, self.cfg, card["id"], "editor-user", another=True, manager_factory=self.factory)
        self.world["accounts"] = [pitch, {"id": "ca_a", "status": "ACTIVE", "alias": "a"}, {"id": "ca_b", "status": "ACTIVE", "alias": "b"}]
        back = links.check(self.registry, self.cfg, card["id"], "editor-user", manager_factory=self.factory)
        self.assertEqual((back["connected"], back["link"]["status"], len(back["accounts"])), (False, "requested", 3))
        links.start(self.registry, self.cfg, card["id"], "editor-user", another=True, manager_factory=self.factory)
        links._SIGN_INS.clear()                                  # the window was reloaded while the browser was open
        back = links.check(self.registry, self.cfg, card["id"], "editor-user", manager_factory=self.factory)
        self.assertEqual((back["connected"], back["link"]["status"]), (False, "requested"))
        self.assertEqual(links.connected(self.registry, self.pip["id"]), [])

    def test_an_add_that_opens_no_sign_in_never_binds_what_it_answers_with(self):
        # Whether Composio's "add" makes a second account when one exists can't be told from a stand-in. If it answers
        # with the existing one and no link, the card says so and links nothing.
        self.world["accounts"] = [{"id": "ca_pitch", "status": "ACTIVE", "user_info": {"email": "pitch@example.com"}}]
        self.world["redirect"] = None
        card = self.ask()
        said = links.start(self.registry, self.cfg, card["id"], "editor-user", another=True, manager_factory=self.factory)
        self.assertEqual((said["link"]["status"], said["redirect_url"]), ("requested", None))
        self.assertIn("didn't offer a sign-in for another Gmail account", said["error"])
        self.assertEqual(links.connected(self.registry, self.pip["id"]), [])

    def test_an_unattended_run_asks_and_never_links(self):
        self.world["accounts"] = [{"id": "ca_pitch", "status": "ACTIVE", "user_info": {"email": "pitch@example.com"}}]
        server = links.RunSocket(self.registry.directory, self.cfg, self.pip["id"], self.pip["workspace_id"], "run_" + "d" * 32,
                                 manager_factory=self.factory)
        self.addCleanup(server.close)
        server.call("connect_app", {"app": "gmail", "why": "A routine wants my mail."})
        self.assertEqual(links.connected(self.registry, self.pip["id"]), [])
        self.assertEqual(links.listing(self.registry, self.pip["id"])[0]["status"], "requested")
        self.assertEqual(self.world["calls"], [], "Composio isn't even asked until the person acts")
        card = links.listing(self.registry, self.pip["id"])[0]
        with self.assertRaises(RegistryError):
            links.start(self.registry, self.cfg, card["id"], "run-worker", account="ca_pitch", manager_factory=self.factory)

    def test_check_waits_for_the_browser_then_connects_and_notices_a_changed_connection(self):
        card = self.ask()
        links.start(self.registry, self.cfg, card["id"], "editor-user", manager_factory=self.factory)
        waiting = links.check(self.registry, self.cfg, card["id"], "editor-user", manager_factory=self.factory)
        self.assertEqual((waiting["connected"], waiting["link"]["status"]), (False, "authorizing"))
        self.world["accounts"] = [{"id": "ca_new", "status": "INITIATED"}, {"id": "ca_done", "status": "ACTIVE", "alias": "personal"}]
        done = links.check(self.registry, self.cfg, card["id"], "editor-user", manager_factory=self.factory)
        self.assertEqual((done["connected"], done["link"]["status"], done["link"]["label"]), (True, "connected", "personal"))
        self.assertEqual(links.connected(self.registry, self.pip["id"])[0]["account"], "ca_done")
        self.world["accounts"] = []
        other = self.ask("slack", "To post the summary.")
        links.start(self.registry, self.cfg, other["id"], "editor-user", manager_factory=self.factory)
        self.cfg.data["mcp_servers"]["composio"]["url"] = "https://connect.composio.dev/other"
        changed = links.check(self.registry, self.cfg, other["id"], "editor-user", manager_factory=self.factory)
        self.assertEqual(changed["link"]["status"], "failed")

    def test_without_composio_the_card_says_to_add_it_and_a_bad_link_is_never_opened(self):
        self.cfg.data["mcp_servers"] = {}
        failed = links.start(self.registry, self.cfg, self.ask()["id"], "editor-user", manager_factory=self.factory)
        self.assertEqual(failed["link"]["status"], "failed")
        self.assertIn("Add Composio in Settings", failed["link"]["error"])
        self.cfg.data["mcp_servers"] = {"composio": dict(COMPOSIO)}
        for url in ("http://connect.composio.dev/link/x", "https://user:pw@evil.example/x", "javascript:alert(1)", None):
            with self.subTest(url=url):
                self.world["redirect"] = url
                card = self.ask("notion", "To find my notes.")
                result = links.start(self.registry, self.cfg, card["id"], "editor-user", manager_factory=self.factory)
                self.assertIsNone(result["redirect_url"])
                self.assertEqual(result["link"]["status"], "failed")

    def test_outlook_uses_existing_microsoft_mail_without_composio(self):
        self.cfg.data["mcp_servers"] = {}
        card = self.ask("outlook", "To review Outlook mail.")
        attached = {"server": "microsoft--mail", "connection_digest": "a" * 64,
                    "account": "ca_ms_123", "label": "me@example.com"}
        with patch.object(links.microsoft_mail, "connect", return_value=attached) as connect:
            result = links.start(self.registry, self.cfg, card["id"], "editor-user")
        connect.assert_called_once_with(self.cfg)
        self.assertTrue(result["connected"])
        self.assertIsNone(result["redirect_url"])
        self.assertEqual(result["link"]["label"], "me@example.com")
        app = links.connected(self.registry, self.pip["id"])[0]
        with patch.object(links.microsoft_mail, "read", return_value='{"messages":[]}') as read:
            self.assertEqual(links.read(self.cfg, app, "MICROSOFT_SEARCH_MAIL", {"limit": 1}), '{"messages":[]}')
        self.assertEqual(read.call_args.args[:4], (self.cfg, app, "MICROSOFT_SEARCH_MAIL", {"limit": 1}))

    def test_enabled_plugin_is_used_before_a_second_composio_sign_in(self):
        from dgc import pip_plugins
        available = {"notion": {"servers": {"notion--api": {}}},
                     "google-workspace": {"servers": {"google-workspace--drive": {}}}}
        with patch.object(pip_plugins, "installed", return_value=available):
            self.assertEqual(links.enabled_plugin(self.cfg, "notion"), "notion")
            self.assertEqual(links.enabled_plugin(self.cfg, "googledrive"), "google-workspace")
            self.assertIsNone(links.enabled_plugin(self.cfg, "gmail"), "only selected Google apps count")
            card = self.ask("notion", "To find my notes.")
            result = links.start(self.registry, self.cfg, card["id"], "editor-user", manager_factory=self.factory)
        self.assertIsNone(result["redirect_url"])
        self.assertEqual(result["link"]["status"], "failed")
        self.assertIn("already enabled through the notion plugin", result["link"]["error"])
        self.assertEqual(self.world["calls"], [], "no Composio account was created")

    def test_pip_connect_app_uses_existing_plugin_without_creating_a_card(self):
        from dgc import pip_plugins
        run = "run_" + "c" * 32
        server = links.RunSocket(self.registry.directory, self.cfg, self.pip["id"], self.pip["workspace_id"], run,
                                 manager_factory=self.factory)
        self.addCleanup(server.close)
        with patch.object(pip_plugins, "installed", return_value={"notion": {"servers": {"notion--api": {}}}}):
            said = server.call("connect_app", {"app": "notion", "why": "Read my notes."})
        self.assertIn("Use plugin_tools", said)
        self.assertEqual(links.listing(self.registry, self.pip["id"]), [])
        self.assertEqual(self.world["calls"], [])
        self.world["accounts"] = [{"id": "ca_existing", "status": "ACTIVE"}]
        links.start(self.registry, self.cfg, self.ask("notion", "Read my notes.")["id"], "editor-user", account="ca_existing",
                    manager_factory=self.factory)
        with patch.object(pip_plugins, "installed", return_value={"notion": {"servers": {"notion--api": {}}}}):
            said = server.call("connect_app", {"app": "notion", "why": "Read my notes."})
        self.assertIn("Read it with read_app", said, "an existing Pip-specific account keeps priority")

    def test_local_plugin_without_a_pip_adapter_never_starts_a_second_login(self):
        from dgc import pip_plugins
        spec = {"transport": "stdio", "command": "python3", "args": ["-m", "dgc.microsoft_graph", "calendar"]}
        record = {"name": "microsoft", "registered_specs": {"microsoft--calendar": spec}}
        with patch.object(pip_plugins, "_records", return_value=[record]), \
             patch.object(pip_plugins, "_saved", return_value=({"microsoft--calendar": spec}, set())), \
             patch.object(pip_plugins, "installed", return_value={}):
            self.assertEqual(links.unavailable_native_plugin(self.cfg, "outlookcalendar"), "microsoft")
            server = links.RunSocket(self.registry.directory, self.cfg, self.pip["id"], self.pip["workspace_id"],
                                     "run_" + "d" * 32, manager_factory=self.factory)
            self.addCleanup(server.close)
            said = server.call("connect_app", {"app": "Outlook Calendar", "why": "Read my schedule."})
            card = self.ask("Outlook Calendar", "Read my schedule.")
            result = links.start(self.registry, self.cfg, card["id"], "editor-user", manager_factory=self.factory)
        self.assertIn("no reviewed adapter", said)
        self.assertIsNone(result["redirect_url"])
        self.assertEqual(self.world["calls"], [])

    def test_not_now_and_disconnect(self):
        card = self.ask()
        self.assertEqual(links.decline(self.registry, card["id"], "editor-user")["link"]["status"], "declined")
        self.world["accounts"] = [{"id": "ca_x", "status": "ACTIVE"}]
        card = self.ask()
        self.assertNotEqual(card["status"], "declined", "asking again after Not now is a fresh card")
        links.start(self.registry, self.cfg, card["id"], "editor-user", account="ca_x", manager_factory=self.factory)
        with self.assertRaises(RegistryError):
            links.decline(self.registry, card["id"], "editor-user")
        gone = links.disconnect(self.registry, card["id"], "editor-user")["link"]
        self.assertEqual((gone["status"], gone["label"]), ("declined", None))
        self.assertEqual(links.connected(self.registry, self.pip["id"]), [])

    def test_reads_are_this_pips_account_and_only_that_apps_reads(self):
        self.world["accounts"] = [{"id": "ca_mine", "status": "ACTIVE"}]
        links.start(self.registry, self.cfg, self.ask()["id"], "editor-user", account="ca_mine", manager_factory=self.factory)
        app = links.connected(self.registry, self.pip["id"])[0]
        text = links.read(self.cfg, app, "GMAIL_FETCH_EMAILS", {"query": "is:unread"}, manager_factory=self.factory)
        self.assertIn("messages", text)
        name, args = self.managers[-1].calls[-1]
        self.assertEqual(name, "execute")
        self.assertEqual(args["tools"][0]["account"], "ca_mine")
        self.assertEqual(args["tools"][0]["arguments"], {"query": "is:unread", "user_id": "me", "max_results": 10})
        for tool in ("GMAIL_SEND_EMAIL", "COMPOSIO_MANAGE_CONNECTIONS", "GOOGLECALENDAR_FIND_EVENT", "COMPOSIO_MULTI_EXECUTE_TOOL"):
            with self.subTest(tool=tool), self.assertRaises(RegistryError):
                links.read(self.cfg, app, tool, {}, manager_factory=self.factory)
        with self.assertRaises(RegistryError):
            links.read(self.cfg, app, "GMAIL_FETCH_EMAILS", {"max_results": 500}, manager_factory=self.factory)

    def test_the_run_socket_takes_only_its_token_and_its_two_operations(self):
        run = "run_" + "a" * 32
        server = links.RunSocket(self.registry.directory, self.cfg, self.pip["id"], self.pip["workspace_id"], run,
                                 manager_factory=self.factory)
        self.addCleanup(server.close)
        pin = server.pin()
        self.assertEqual(pin["apps"], [])
        self.assertIn("error: refused", links.worker_call({**pin, "token": "x"}, "connect_app", {"app": "gmail", "why": "w"}))
        self.assertIn("invalid app arguments", links.worker_call(pin, "connect_app", []))
        self.assertIn("unknown app operation", links.worker_call(pin, "start", {}))
        said = links.worker_call(pin, "connect_app", {"app": "gmail", "why": "To read your mail."})
        self.assertIn("A Link Gmail card is now below your reply", said)
        self.assertNotIn("http", said, "the model never gets the sign-in link")
        self.assertIn("not connected", links.worker_call(pin, "read_app", {"app": "gmail", "tool": "GMAIL_FETCH_EMAILS", "arguments": {}}))
        self.assertEqual(links.listing(self.registry, self.pip["id"])[0]["status"], "requested")

    def test_a_pip_is_told_its_app_tools_and_whether_composio_is_set_up_beside_your_message(self):
        # A user's Test Pip (2026-10-08) kept saying "I don't have a Composio connector": its
        # chat held replies from before it had app tools, and "Nothing is connected yet" read as
        # "Composio is not connected".
        run = "run_" + "b" * 32
        server = links.RunSocket(self.registry.directory, self.cfg, self.pip["id"], self.pip["workspace_id"], run,
                                 manager_factory=self.factory)
        self.addCleanup(server.close)
        self.assertIs(server.pin()["composio"], True)
        note = pips._app_tools_note(server.pin())
        self.assertIn("connect_app and read_app", note)
        self.assertIn("(set up in DGC)", note)
        self.assertIn("out of date", note)
        self.assertIn("exists only when connect_app made one", note)
        self.assertIn("not set up in DGC yet", pips._app_tools_note({"composio": False}))
        described = links.schemas([])[0]["function"]["description"]
        self.assertIn("No direct app links to you yet; enabled plugins may still provide app access", described)
        self.assertNotIn("Nothing is connected yet", described)
        self.assertIn("Composio", described)

    def test_the_editor_connects_and_the_pip_carries_on_in_its_chat(self):
        from dgc.workspace_registry import WorkspaceRegistry
        def control(command, actor="editor-user", **fields):
            with patch.object(pips, "WorkspaceRegistry", lambda *a, **k: WorkspaceRegistry(self.registry.directory)):
                response = pips.handle_control(self.cfg, {"type": command, "request_id": "r1",
                                                          "pip_id": self.pip["id"], **fields}, actor, start_worker=False)
            if not response.get("ok"):
                raise RegistryError(response["error"]["code"], response["error"]["message"])
            return response["result"]
        card = self.ask()
        listed = control("list_pip_app_links")
        self.assertEqual(([l["id"] for l in listed["links"]], listed["composio"]), ([card["id"]], True))
        with self.assertRaises(RegistryError):
            control("list_pip_app_links", actor="device_1")
        with patch.object(apps, "_manager", self.factory):
            started = control("start_pip_app_link", link_id=card["id"])
            self.assertEqual(started["link"]["status"], "authorizing")
            self.world["accounts"] = [{"id": "ca_done", "status": "ACTIVE", "user_info": {"email": "me@example.com"}}]
            done = control("check_pip_app_link", link_id=card["id"])
        self.assertEqual(done["link"]["status"], "connected")
        turn = self.registry.db.execute("SELECT text FROM pip_chat_messages WHERE pip_id=? AND role='user' ORDER BY rowid DESC LIMIT 1",
                                        (self.pip["id"],)).fetchone()
        self.assertIsNotNone(turn, "the Pip is asked to carry on")
        self.assertIn("connected Gmail to you (me@example.com)", turn["text"])
        # With two accounts: the same command lists them, and its account links the one chosen, which is what the Pip hears.
        self.world["accounts"] = [{"id": "ca_one", "status": "ACTIVE", "user_info": {"email": "one@example.com"}},
                                  {"id": "ca_two", "status": "ACTIVE", "user_info": {"email": "two@example.com"}}]
        other = self.ask("slack", "To read the team channel.")
        with patch.object(apps, "_manager", self.factory):
            listed = control("start_pip_app_link", link_id=other["id"])
            self.assertEqual((listed["link"]["status"], [a["id"] for a in listed["accounts"]]), ("requested", ["ca_one", "ca_two"]))
            with self.assertRaises(RegistryError):
                control("start_pip_app_link", link_id=other["id"], account=7)
            with patch("dgc.pip_chat.continue_after_app") as carried_on:
                chosen = control("start_pip_app_link", link_id=other["id"], account="ca_two")
        self.assertEqual(chosen["link"]["label"], "two@example.com")
        self.assertEqual(carried_on.call_args.args[2]["label"], "two@example.com", "what the Pip is told names the one chosen")


if __name__ == "__main__":
    unittest.main()
