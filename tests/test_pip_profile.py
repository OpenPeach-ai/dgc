"""A Personal Pip's own page (pip_profile), its computer settings, its apps, and what it tells you."""
import base64
import os
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import pip_app_links, pip_chat, pip_computer, pip_desktop, pip_profile, pip_routines, pips
from dgc.workspace_registry import RegistryError, WorkspaceRegistry
from tests import test_pips_local as fixtures

PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=")
DOT = "data:image/png;base64," + base64.b64encode(PNG).decode()
NOTES = {"name": "notes.txt", "data": "data:text/plain;base64," + base64.b64encode(b"Buy milk.\n").decode()}
DAILY = {"kind": "schedule", "schedule": {"type": "daily", "time": "08:00", "timezone": "Asia/Kolkata"}}


class ProfileTests(unittest.TestCase):
    setUp_base = fixtures.LocalPipsTests.setUp

    def setUp(self):
        self.setUp_base()
        self.cfg.data["pips_enabled"] = True
        self.pip = self.store.create(self.registry.personal()["id"], "Ava", None, "editor-user", pip_type="scout")
        here = patch.object(pips, "WorkspaceRegistry", lambda *a, **k: WorkspaceRegistry(self.registry.directory))
        here.start()
        self.addCleanup(here.stop)

    def control(self, request, actor="editor-user"):
        return pips.handle_control(self.cfg, {"request_id": "r1", **request}, actor)

    def reply(self, text, key, said, **extra):
        sent = pip_chat.send(self.store, self.pip["id"], text, key, "editor-user", self.cfg, **extra)
        self.store.claim_next()
        self.store.finish(sent["run"]["id"], result={"text": said})

    def link(self, pip_id, toolkit, status, label=None, suffix="a"):
        now = self.registry.clock()
        link_id = "applink_" + suffix * 32
        with self.registry.transaction():
            self.registry.db.execute(
                "INSERT INTO pip_app_links(id,pip_id,workspace_id,toolkit,reason,status,server,connection_digest,account,label,"
                "created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (link_id, pip_id, self.pip["workspace_id"], toolkit, "to read your mail", status,
                 "composio" if status == "connected" else None, "d" * 64 if status == "connected" else None,
                 "ca_test" if status == "connected" else None, label, now, now))
        return link_id

    # ---------------------------------------------------------------- its look, title and notifications

    def test_a_pip_has_a_default_look_until_you_change_it_and_reset_brings_it_back(self):
        got = self.control({"type": "get_pip", "pip_id": self.pip["id"]})
        self.assertEqual(got["result"]["pip"]["profile"], {"title": "", "body": None, "color": None, "notify": True})
        changed = self.control({"type": "set_pip_profile", "pip_id": self.pip["id"],
                                "changes": {"title": "  Inbox helper ", "body": "lens", "color": "mint", "notify": False}})
        self.assertTrue(changed["ok"], changed)
        self.assertEqual(changed["result"]["profile"], {"title": "Inbox helper", "body": "lens", "color": "mint", "notify": False})
        listed = self.control({"type": "list_pips", "workspace_id": self.pip["workspace_id"]})
        self.assertEqual(listed["result"]["pips"][0]["profile"]["body"], "lens", "the list shows its face too")
        reset = pip_profile.update(self.store, self.pip["id"], {"body": None, "color": None}, "editor-user")
        self.assertEqual(reset["profile"], {"title": "Inbox helper", "body": None, "color": None, "notify": False},
                         "Reset to default: its face and colour only")

    def test_only_you_change_it_and_only_to_what_exists(self):
        for bad in ({"body": "dragon"}, {"color": "plaid"}, {"title": "x" * 61}, {"title": "two\nlines"},
                    {"notify": "yes"}, {"name": "Bob"}, {}):
            with self.subTest(bad=bad), self.assertRaises(RegistryError):
                pip_profile.update(self.store, self.pip["id"], bad, "editor-user")
        refused = self.control({"type": "set_pip_profile", "pip_id": self.pip["id"], "changes": {"color": "rose"}}, "main-chat")
        self.assertEqual(refused["error"]["code"], "local_only")
        self.assertIsNone(pip_profile.get(self.registry.db, self.pip["id"])["color"])

    # ---------------------------------------------------------------- Links, Media, Files

    def test_links_media_and_files_list_what_was_shared_in_its_chat_newest_first(self):
        self.reply("Look at https://example.com/a. And (https://news.example.org/story?id=4).", "k1",
                   "Saved. Also see https://example.com/a and https://docs.example.net/guide,")
        self.reply("What is in this picture?", "k2", "A dot.", images=[DOT])
        self.reply("Keep this", "k3", "Kept.", files=[NOTES])
        pip_chat.send(self.store, self.pip["id"], "Check https://hidden.example.com now", "routine_" + "1" * 16 + "_" + "2" * 24,
                      "local-routine", self.cfg, _intro=True)
        links = self.control({"type": "list_pip_shared", "pip_id": self.pip["id"], "kind": "links"})["result"]["items"]
        self.assertEqual([item["url"] for item in links],
                         ["https://example.com/a", "https://docs.example.net/guide", "https://news.example.org/story?id=4"],
                         "newest message first, once each, no trailing punctuation, nothing from a turn DGC wrote")
        self.assertEqual((links[1]["host"], links[1]["from"]), ("docs.example.net", "pip"))
        [image] = self.control({"type": "list_pip_shared", "pip_id": self.pip["id"], "kind": "media"})["result"]["items"]
        self.assertEqual((image["index"], image["mime"], image["from"]), (0, "image/png", "you"))
        got = pip_chat.get_image(self.store, self.pip["id"], image["message_id"], image["index"])
        self.assertTrue(got["image"].startswith("data:image/png;base64,"), "the tab opens it with the existing read")
        [file] = self.control({"type": "list_pip_shared", "pip_id": self.pip["id"], "kind": "files"})["result"]["items"]
        self.assertEqual((file["name"], file["bytes"]), ("notes.txt", 10))
        self.assertFalse(self.control({"type": "list_pip_shared", "pip_id": self.pip["id"], "kind": "secrets"})["ok"])

    # ---------------------------------------------------------------- Settings → Computer

    def test_reset_starts_its_computer_fresh_but_keeps_its_files(self):
        root = pip_computer.computer_root(self.registry.directory, self.pip["id"])
        (root / "home" / ".browser").mkdir()
        (root / "home" / ".browser" / "Cookies").write_bytes(b"signed in" * 100)
        (root / "home" / "Files").mkdir()
        (root / "home" / "Files" / "report.pdf").write_bytes(b"%PDF" * 1000)
        seen = self.control({"type": "get_pip_computers"})["result"]
        [computer] = seen["computers"]
        self.assertEqual((computer["pip_id"], computer["name"]), (self.pip["id"], "Ava"))
        self.assertGreaterEqual(computer["bytes"], computer["files_bytes"])
        self.assertGreater(computer["files_bytes"], 0)
        self.assertIn("free_bytes", seen)
        done = self.control({"type": "reset_pip_computer", "pip_id": self.pip["id"]})["result"]
        self.assertTrue(done["reset"], "no runner holds its browser, so it is reset at once")
        self.assertFalse((root / "home" / ".browser").exists(), "signed out, no history")
        self.assertTrue((root / "home" / "Files" / "report.pdf").exists(), "its Files stay")

    def test_reset_waits_for_a_running_supervisor_and_refuses_while_it_works(self):
        root = pip_computer.computer_root(self.registry.directory, self.pip["id"])
        (root / "home" / ".browser").mkdir()
        with patch("dgc.pip_daemon.runner_status", return_value={"online": True}):
            asked = pip_computer.request_reset(self.registry, self.pip["id"], "editor-user")
        self.assertEqual((asked["resetting"], asked["reset"]), (True, False))
        self.assertTrue((root / "home" / ".browser").exists(), "the supervisor does it, after closing its browser")
        with patch.object(pip_computer, "stop_host") as stop:
            self.assertEqual(pip_computer.handle_stops(self.registry), 1)
        stop.assert_called_once_with(self.pip["id"])
        self.assertFalse((root / "home" / ".browser").exists())
        pip_chat.send(self.store, self.pip["id"], "Find me a flight", "k1", "editor-user", self.cfg)
        with self.assertRaisesRegex(RegistryError, "is working"):
            pip_computer.request_reset(self.registry, self.pip["id"], "editor-user")
        with self.assertRaises(RegistryError):
            pip_computer.request_reset(self.registry, self.pip["id"], "main-chat")

    # ---------------------------------------------------------------- one place for apps

    def test_an_account_another_pip_uses_is_asked_for_not_signed_into_again(self):
        other = self.store.create(self.registry.personal()["id"], "Max", None, "editor-user", pip_type="rook")
        self.link(other["id"], "gmail", "connected", label="me@example.com", suffix="b")
        self.link(self.pip["id"], "gmail", "requested", suffix="c")
        [card] = pip_app_links.listing(self.registry, self.pip["id"])
        self.assertEqual(card["known_label"], "me@example.com", "the card asks to let Ava use it")
        [app] = self.control({"type": "list_pip_apps"})["result"]["apps"]
        self.assertEqual((app["app"], app["label"], [p["name"] for p in app["pips"]]), ("Gmail", "me@example.com", ["Max"]))

    # ---------------------------------------------------------------- what it tells you

    def test_it_tells_you_when_a_routine_is_done_or_it_needs_you_unless_you_turned_that_off(self):
        sent_bodies = []
        notifier = pip_desktop.Notifier(self.cfg, clock=iter(range(0, 10_000, 120)).__next__,
                                        send=lambda title, body: sent_bodies.append(body) or True)
        routine = pip_routines.add(self.store, self.pip["id"], "Morning brief", "Send me the news.", DAILY)
        key = pip_routines.KEY + routine["id"][-16:] + "_" + "0" * 24
        sent = pip_chat.send(self.store, self.pip["id"], "It is time.", key, "local-routine", self.cfg, _intro=True)
        self.store.claim_next()
        self.store.finish(sent["run"]["id"], result={"text": "Good morning! Three stories today."})
        self.assertEqual(notifier.tick(self.registry), "Ava: Good morning! Three stories today.")
        self.assertIsNone(notifier.tick(self.registry), "once")
        self.link(self.pip["id"], "googlecalendar", "requested", suffix="e")
        self.assertEqual(notifier.tick(self.registry), "Ava asks to use Google Calendar. Answer in its chat.")
        pip_profile.update(self.store, self.pip["id"], {"notify": False}, "editor-user")
        self.link(self.pip["id"], "gmail", "requested", suffix="f")
        self.assertIsNone(notifier.tick(self.registry), "its page says not to")


if __name__ == "__main__":
    unittest.main()
