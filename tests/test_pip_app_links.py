"""A Personal Pip's own apps, connected from its chat like Grok's connectors (pip_app_links)."""
import json
import socket
import unittest
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

    def test_an_account_composio_already_has_is_used_without_a_second_sign_in(self):
        self.world["accounts"] = [{"id": "ca_work", "status": "ACTIVE", "user_info": {"email": "me@example.com"}}]
        started = links.start(self.registry, self.cfg, self.ask()["id"], "editor-user", manager_factory=self.factory)
        self.assertEqual((started["link"]["status"], started["link"]["label"], started["redirect_url"]),
                         ("connected", "me@example.com", None))
        self.assertEqual(self.world["calls"], [{"name": "gmail", "action": "list"}], "no new auth link")

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

    def test_not_now_and_disconnect(self):
        card = self.ask()
        self.assertEqual(links.decline(self.registry, card["id"], "editor-user")["link"]["status"], "declined")
        self.world["accounts"] = [{"id": "ca_x", "status": "ACTIVE"}]
        card = self.ask()
        self.assertNotEqual(card["status"], "declined", "asking again after Not now is a fresh card")
        links.start(self.registry, self.cfg, card["id"], "editor-user", manager_factory=self.factory)
        with self.assertRaises(RegistryError):
            links.decline(self.registry, card["id"], "editor-user")
        gone = links.disconnect(self.registry, card["id"], "editor-user")["link"]
        self.assertEqual((gone["status"], gone["label"]), ("declined", None))
        self.assertEqual(links.connected(self.registry, self.pip["id"]), [])

    def test_reads_are_this_pips_account_and_only_that_apps_reads(self):
        self.world["accounts"] = [{"id": "ca_mine", "status": "ACTIVE"}]
        links.start(self.registry, self.cfg, self.ask()["id"], "editor-user", manager_factory=self.factory)
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
        self.assertIn("unknown app operation", links.worker_call(pin, "start", {}))
        said = links.worker_call(pin, "connect_app", {"app": "gmail", "why": "To read your mail."})
        self.assertIn("A Connect Gmail card is now in your chat", said)
        self.assertNotIn("http", said, "the model never gets the sign-in link")
        self.assertIn("not connected", links.worker_call(pin, "read_app", {"app": "gmail", "tool": "GMAIL_FETCH_EMAILS", "arguments": {}}))
        self.assertEqual(links.listing(self.registry, self.pip["id"])[0]["status"], "requested")

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


if __name__ == "__main__":
    unittest.main()
