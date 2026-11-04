"""Outlook Pips use only the approved Microsoft mailbox and three bounded read tools."""
import json
import unittest
from unittest.mock import patch

from dgc import pip_microsoft_mail as mail
from dgc.pip_app_access import digest
from dgc.workspace_registry import RegistryError


SPEC = {"transport": "stdio", "command": "python3", "args": ["-m", "dgc.microsoft_graph", "mail"]}


class Config:
    def __init__(self):
        self.servers = {mail.SERVER: dict(SPEC)}

    def get(self, name, default=None):
        return {"mcp_servers": self.servers}.get(name, default)


class Manager:
    def __init__(self, account="user-123"):
        self.account = account
        self.calls = []
        self.closed = False
        self._routes = {f"route_{name}": (mail.SERVER, name) for name in
                        ("mail_account", "search_mail", "read_mail", "list_mail_folders", "send_mail")}

    def tool_schemas(self):
        return [{"function": {"name": name}} for name in self._routes]

    def call(self, route, args, **_kw):
        self.calls.append((route, args))
        if route == "route_mail_account":
            return json.dumps({"id": self.account, "email": "me@example.com"})
        return json.dumps({"messages": [{"id": "m1", "subject": "Invoice"}]})

    def stop_all(self):
        self.closed = True


class MicrosoftMailPipTests(unittest.TestCase):
    def setUp(self):
        self.cfg = Config()
        self.managers = []
        def factory(_cfg, _cancel):
            manager = Manager()
            self.managers.append(manager)
            return manager
        self.factory = factory
        self.saved = patch.object(mail, "saved_servers", lambda config: config.servers)
        self.saved.start()
        self.addCleanup(self.saved.stop)

    def linked(self):
        return {"toolkit": "outlook", **mail.connect(self.cfg, manager_factory=self.factory)}

    def test_connect_pins_identity_and_closes_the_plugin(self):
        linked = self.linked()
        self.assertEqual(linked["server"], mail.SERVER)
        self.assertEqual(linked["connection_digest"], digest(SPEC))
        self.assertRegex(linked["account"], r"^ca_ms_[0-9a-f]{32}$")
        self.assertTrue(self.managers[0].closed)
        self.assertEqual(self.managers[0].calls, [("route_mail_account", {})])

    def test_connect_sees_a_login_saved_after_the_pip_runner_started(self):
        stale = Config()
        stale.servers = {}
        with patch.object(mail, "saved_servers", return_value={mail.SERVER: SPEC}):
            self.assertEqual(mail.connect(stale, manager_factory=self.factory)["server"], mail.SERVER)

    def test_bounded_read_checks_account_and_never_calls_a_write_tool(self):
        linked = self.linked()
        text = mail.read(self.cfg, linked, "MICROSOFT_SEARCH_MAIL", {"query": "invoice", "limit": 3},
                         manager_factory=self.factory)
        self.assertIn("Invoice", text)
        self.assertEqual(self.managers[-1].calls,
                         [("route_mail_account", {}), ("route_search_mail", {"limit": 3, "query": "invoice"})])
        self.assertTrue(all(m.closed for m in self.managers))
        for tool, args in (("send_mail", {}), ("MICROSOFT_SEARCH_MAIL", {"limit": 21}),
                           ("MICROSOFT_READ_MAIL", {"id": "x", "send": True})):
            with self.subTest(tool=tool), self.assertRaises(RegistryError):
                mail.read(self.cfg, linked, tool, args, manager_factory=self.factory)

    def test_a_long_message_is_read_with_its_body_cut_to_fit(self):
        from dgc import microsoft_graph
        linked = self.linked()
        for name, line in (("a long thread", "A long quoted reply thread line. "),
                           ("Hindi, three bytes a character", "यह एक लंबा संदेश है। ")):
            body = (line * 6000)[:microsoft_graph.MAX_TEXT]

            class Long(Manager):
                def call(self, route, args, **_kw):
                    if route == "route_mail_account":
                        return super().call(route, args)
                    # What GraphServer.read_mail answers: the message pretty-printed, its body cut at MAX_TEXT.
                    return microsoft_graph._result({"id": args["id"], "subject": "Thread", "from": "ana@example.com",
                                                    "body": microsoft_graph._cut(body)})
            with self.subTest(name):
                text = mail.read(self.cfg, linked, "MICROSOFT_READ_MAIL", {"id": "AAMk1"},
                                 manager_factory=lambda _c, _x: Long())
                self.assertLessEqual(len(text.encode()), mail.MAX_RESULT)
                value = json.loads(text)
                self.assertEqual((value["subject"], value["from"]), ("Thread", "ana@example.com"))
                self.assertTrue(value["body"].startswith(line * 3))
                self.assertRegex(value["body"], r"\[… \d+ more characters of this message not shown\]$")
                self.assertGreater(len(value["body"]), 8000, "as much of it as fits")
        class Huge(Manager):
            def call(self, route, args, **_kw):
                return super().call(route, args) if route == "route_mail_account" else "x" * (mail.MAX_RAW + 1)
        with self.assertRaisesRegex(RegistryError, "did not complete the bounded read"):
            mail.read(self.cfg, linked, "MICROSOFT_READ_MAIL", {"id": "AAMk1"}, manager_factory=lambda _c, _x: Huge())

    def test_account_or_saved_connection_change_fails_closed(self):
        linked = self.linked()
        def changed(_cfg, _cancel):
            manager = Manager("someone-else")
            self.managers.append(manager)
            return manager
        with self.assertRaisesRegex(RegistryError, "different mailbox"):
            mail.read(self.cfg, linked, "MICROSOFT_LIST_MAIL_FOLDERS", {}, manager_factory=changed)
        self.assertEqual(self.managers[-1].calls, [("route_mail_account", {})])
        self.cfg.servers[mail.SERVER] = {**SPEC, "enabled": False}
        with self.assertRaises(RegistryError):
            mail.read(self.cfg, linked, "MICROSOFT_LIST_MAIL_FOLDERS", {}, manager_factory=self.factory)


if __name__ == "__main__":
    unittest.main()
