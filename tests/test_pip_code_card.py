"""The code card (0.52; agreed design 13 Nov, pips-sandbox-design §4): a site asks a Pip's computer for a one-time code
its saved login has no authenticator key for. DGC shows the user a card in the Pip's chat; the user types the code
there; DGC fills it into that page and sends it once (the saved login's own sign-in: SignIn with a given code); the Pip
is told only that it was filled. The code is never stored, logged, answered or shown to the Pip; it reaches the live
page the way the user's own typing in the computer's view does. Not now tells the Pip; a page that moved is lost."""
from __future__ import annotations

import json
import os
import threading
import types
import unittest
from unittest.mock import patch

from dgc import pip_chat, pip_computer, pip_login_fill, pip_logins, pips
from dgc.workspace_registry import RegistryError
from tests import test_pips_local as fixtures
from tests.test_pip_logins import PASSWORD, Page

CODE = "482913"
BANK = [{"href": "https://login.northwind-bank.example/signin", "user": 1, "password": 1, "title": "Sign in"},
        {"href": "https://login.northwind-bank.example/verify", "code": 1, "title": "Your code"},
        {"href": "https://login.northwind-bank.example/account", "title": "Your account"}]


class CodeCard(unittest.TestCase):
    def setUp(self):
        fixtures.LocalPipsTests.setUp(self)
        self.pip = self.store.create(self.registry.personal()["id"], "Banker", None, "editor-user", pip_type="lens",
                                     computer_plan={"schema_version": 1})
        self.logins = pip_logins.Store(self.registry.directory)
        self.logins.save(address="login.northwind-bank.example", username="arjun", password=PASSWORD, totp=None,
                         pips=[self.pip["id"]], source="page")

    def control(self, request, actor="editor-user"):
        with patch("dgc.pips.WorkspaceRegistry", return_value=self.registry), patch.object(self.registry, "close"):
            return pips.handle_control(self.cfg, {"request_id": "r", **request}, actor, start_worker=False)

    def host(self, page):
        host = types.SimpleNamespace(browser=page, state_directory=self.registry.directory, pip_id=self.pip["id"],
                                     workspace_id=self.pip["workspace_id"], run_id=None, id="host_x", waiting=[],
                                     _queued=[], frames_dir=None, frames=0, lock=threading.RLock(), careful=False,
                                     desktop=None, ensure_desktop=lambda: False, last_used=0.0,
                                     secret_hold=None, secrets=pip_login_fill.Scrubber(
                                         lambda: pip_logins.values_for(self.registry.directory)))
        for name in ("_page_said", "_frame", "_held_text", "_record_held", "_act", "_read", "fill_code"):
            setattr(host, name, getattr(pip_computer.Host, name).__get__(host))
        return host

    def offer(self):
        """A chat turn whose sign_in reaches the code step: the card is made and the run ends."""
        run = pip_chat.send(self.store, self.pip["id"], "check my balance at northwind-bank.example",
                            "k-" + os.urandom(3).hex(), "editor-user", self.cfg)["run"]
        self.store.claim_next()
        page = Page(BANK)
        host = self.host(page)
        host.run_id = run["id"]
        told = pip_computer.Host.act(host, "sign_in", {})["text"]
        self.store.finish(run["id"], result={"text": "Northwind sent a code: type it on the card below.",
                                             "computer": {"calls": 2, "held": list(host.waiting)}})
        host.run_id = None
        [card] = [a for a in pip_computer.list_actions(self.registry, self.pip["id"]) if a["summary"].get("kind") == "code"]
        return host, page, told, card

    def test_a_code_step_with_no_key_makes_one_card_and_the_pip_stops(self):
        host, page, told, card = self.offer()
        self.assertEqual(card["status"], "pending")
        self.assertEqual((card["summary"]["site"], card["summary"]["host"]), ("northwind-bank.example", "login.northwind-bank.example"))
        self.assertIn("a card below your reply", told)
        self.assertIn("you never see it", told)
        self.assertNotIn("type the code on your screen", told, "never asks the user to type it on the Pip's screen")
        self.assertIn(card["id"], host.waiting)
        self.assertEqual(page.step, 1, "the password page was sent; the code page waits")
        again = pip_computer.Host.act(host, "sign_in", {})["text"]
        self.assertIn("below your reply", again, "the card is already there: it waits, never a second card")
        self.assertEqual(len([a for a in pip_computer.list_actions(self.registry, self.pip["id"])
                              if a["summary"].get("kind") == "code"]), 1, "one card, never two")

    def test_the_code_typed_on_the_card_is_filled_into_that_page_and_sent_once(self):
        host, page, _, card = self.offer()
        said = host.fill_code(card["id"], CODE, "editor-user")
        self.assertTrue(said["ok"], said)
        self.assertEqual(page.typed[1], {"code0": CODE})
        self.assertEqual(page.step, 2, "sent: the page moved on")
        self.assertEqual(pip_computer.projection(pip_computer._row(self.registry, card["id"]))["status"], "sent")
        self.assertNotIn(CODE, json.dumps(said), "the reply never carries the code")
        self.assertNotIn(CODE, str(host.secrets.scrub(f"your code {CODE} is")), "masked in what the Pip reads after")

    def test_the_pip_hears_only_that_it_was_filled_and_not_now_says_so(self):
        host, page, _, card = self.offer()
        host.fill_code(card["id"], CODE, "editor-user")
        pip_computer.tick(self.registry, self.cfg)
        told = [m for m in pip_chat.list_messages(self.store, self.pip["id"])["messages"] if m["role"] == "user" and m.get("intro")]
        self.assertTrue(told, "the Pip carries on")
        self.assertIn("filled", told[-1]["text"])
        self.assertNotIn(CODE, json.dumps(pip_chat.list_messages(self.store, self.pip["id"])))

    def test_not_now(self):
        host, page, _, card = self.offer()
        with self.assertRaises(RegistryError):
            pip_computer.decide(self.registry, card["id"], card["digest"], True, "editor-user")     # it needs the code
        self.control({"type": "decide_pip_computer_action", "action_id": card["id"], "expected_digest": card["digest"],
                      "approve": False})
        pip_computer.tick(self.registry, self.cfg)
        told = [m for m in pip_chat.list_messages(self.store, self.pip["id"])["messages"] if m["role"] == "user" and m.get("intro")]
        self.assertIn("chose not to give", told[-1]["text"])
        self.assertEqual(page.typed.get(1), None)

    def test_refusals_never_type_anything(self):
        host, page, _, card = self.offer()
        for code in ("12 34;--", "", "x" * 40):
            with self.subTest(code=code):
                self.assertFalse(host.fill_code(card["id"], code, "editor-user")["ok"])
        host.run_id = "run_busy"
        self.assertFalse(host.fill_code(card["id"], CODE, "editor-user")["ok"], "the Pip is using its computer")
        host.run_id = None
        page.step = 2                                      # the page moved on before the code came
        self.assertFalse(host.fill_code(card["id"], CODE, "editor-user")["ok"])
        self.assertEqual(pip_computer.projection(pip_computer._row(self.registry, card["id"]))["status"], "lost")
        self.assertEqual(page.typed.get(1), None)

    def test_the_command_is_local_checked_and_never_stores_the_code(self):
        host, page, _, card = self.offer()
        sent = {}

        def through_view(registry, pip_id, action, code, actor):
            sent.update(action=action["id"], code=code)
            return host.fill_code(action["id"], code, actor)
        with patch("dgc.pip_computer._code_to_view", side_effect=through_view):
            remote = self.control({"type": "fill_pip_code", "pip_id": self.pip["id"], "action_id": card["id"],
                                   "expected_digest": card["digest"], "code": CODE}, actor="device_1")
            self.assertFalse(remote["ok"], "local only")
            changed = self.control({"type": "fill_pip_code", "pip_id": self.pip["id"], "action_id": card["id"],
                                    "expected_digest": "0" * 64, "code": CODE})
            self.assertFalse(changed["ok"], "the card must be unchanged")
            self.assertEqual(sent, {}, "nothing reached the computer")
            out = self.control({"type": "fill_pip_code", "pip_id": self.pip["id"], "action_id": card["id"],
                                "expected_digest": card["digest"], "code": CODE})
        self.assertTrue(out["ok"], out)
        self.assertTrue(out["result"]["ok"], out)
        for response in (remote, changed, out):
            self.assertNotIn(CODE, json.dumps(response))
        self.assertEqual(sent, {"action": card["id"], "code": CODE})
        self.assertNotIn(CODE, json.dumps(out))
        db = self.registry.directory / "registry.sqlite3"
        for path in [db, db.with_name(db.name + "-wal")]:
            if path.exists():
                self.assertNotIn(CODE.encode(), path.read_bytes(), f"the code is never written to {path.name}")

    def test_it_is_in_pips_api_98(self):
        from dgc.headless import PIPS_API_VERSION
        self.assertGreaterEqual(PIPS_API_VERSION, 98)
        self.assertIn("fill_pip_code", pips.CONTROL_COMMANDS)


if __name__ == "__main__":
    unittest.main()
