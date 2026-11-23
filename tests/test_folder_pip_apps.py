"""Every Pip has its own box, step 2b: a folder Pip's chat gets the user's apps, plugins and the web (0.52).

Asked (13 Nov): "it gets folder access, read and write, web and apps, and personal computer, it gets all". A
folder Pip with its own box has, in its chat, what a Personal Pip's chat has for the outside world: its apps through
DGC (Composio and the user's DGC plugins; keys stay in DGC), web_search, images and video, its own keys, borrowing the
user's Chrome when allowed; and its level said to it. What crosses the wall follows its level, as for a Personal Pip.
Not in this step: the user's personal notes, routines, goals and skills (Personal Pips' own).
"""
from __future__ import annotations

import json
import os
import unittest
from unittest.mock import patch

from tests.test_folder_pip_wall import WithABox  # noqa: E402
from dgc import pip_chat, pip_levels as levels, pips  # noqa: E402
from dgc.llm import ChatResult, LLMClient  # noqa: E402

APPS = {"socket": "/nonexistent", "token": "t", "apps": [], "composio": False, "microsoft": False,
        "plugins": [{"plugin": "board", "name": "Board", "tools": 1}]}
WORLD = {"connect_app", "read_app", "web_search", "generate_image", "generate_video", "fetch_with_key",
         "plugin_tools", "call_plugin", "borrow_chrome"}


class ItsChatHasTheWorld(WithABox, unittest.TestCase):
    def turn(self, *, apps=True, level=None):
        sent = pip_chat.send(self.store, self.helper["id"], "Check the shop's Stripe dashboard", "a-1", "device_1", self.cfg)
        manifest = json.loads(self.registry.db.execute("SELECT manifest FROM pip_runs WHERE id=?",
                                                       (sent["run"]["id"],)).fetchone()[0])
        manifest["computer_socket"] = {"socket": str(self.base / "absent.sock"), "token": "t" * 32}
        manifest["own_folder"] = {"name": "shop", "folder": "projects/shop", "files": 5, "kept": False, "updated": 5}
        if apps:
            manifest["app_socket"] = dict(APPS)
        if level:
            manifest["approval_level"] = {"level": level, "unattended": False, "pays": False}
        seen = {}

        def chat(client, messages, tools=None, on_text=None, **kwargs):
            seen["tools"] = {t["function"]["name"] for t in tools}
            seen["system"] = messages[0]["content"]
            return ChatResult(content="Looking.")
        with patch.dict(os.environ, {"DGC_SESSION_POLICY": pips._json(pips.native_policy())}), \
             patch.object(LLMClient, "chat", chat), patch("dgc.agent.discover_skills", return_value={}), \
             patch("requests.sessions.Session.request", side_effect=AssertionError("No network")):
            pips.execute_native(self.cfg, self.root, manifest, lambda event: None)
        return seen

    def test_its_chat_has_the_apps_plugins_and_the_web(self):
        seen = self.turn()
        self.assertTrue(WORLD <= seen["tools"], WORLD - seen["tools"])
        self.assertIn("The user's apps", seen["system"])
        self.assertIn("web_search", seen["system"])

    def test_its_level_is_said_to_it(self):
        seen = self.turn(level=levels.APPROVE)
        self.assertIn(levels.instructions(levels.APPROVE, unattended=False, pays=False, drafting=False), seen["system"])

    def test_without_the_apps_pin_it_has_none_of_them(self):
        seen = self.turn(apps=False)
        self.assertFalse(WORLD & seen["tools"])


class TheRunnerConnectsThem(WithABox, unittest.TestCase):
    def handed(self):
        from tests.test_folder_pip_box import TheRunnerOpensIt
        return TheRunnerOpensIt.handed(self)

    def test_its_chat_turn_gets_the_apps_socket_and_its_level(self):
        levels.set_level(self.registry, self.helper["id"], levels.APPROVE, "editor-user")
        manifest = self.handed()
        self.assertEqual({"socket", "token"} <= set(manifest["app_socket"]), True)
        self.assertEqual(manifest["approval_level"]["level"], levels.APPROVE)

    def test_no_box_no_apps(self):
        with patch.object(pips, "folder_boxes", return_value=False):
            from tests.test_folder_pip_box import TheRunnerOpensIt
            manifest = TheRunnerOpensIt.handed(self, boxes=False)
        self.assertNotIn("app_socket", manifest)
        self.assertNotIn("approval_level", manifest)


if __name__ == "__main__":
    unittest.main()
