"""Saved logins for Personal Pips (Pips API 56): sealed on this computer, typed into the page by DGC, never seen by the
Pip. The store, its seal and its redaction; the four requests; the card in the chat and what the Pip is told after;
the write gate's one exception; the computer's sign_in step on a fake browser and, where this machine can run one, a
real Chromium signing in through a username and password page and a one-time code page to an account page."""
from __future__ import annotations

import base64
import hashlib
import http.server
import json
import os
import re
import stat
import threading
import time
import types
import unittest
import urllib.parse
from pathlib import Path
from unittest.mock import patch

from dgc import pip_chat, pip_computer, pip_login_fill, pip_logins, pip_totp, pips
from dgc.workspace_registry import RegistryError
from tests import test_pips_local as fixtures

PASSWORD = "Nw-Pass-7Qx2-zz91"
SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP"
OTPAUTH = f"otpauth://totp/Northwind:arjun?secret={SECRET}&issuer=Northwind&algorithm=SHA1&digits=6&period=30"


class TotpTests(unittest.TestCase):
    # RFC 6238 appendix B: the seed "12345678901234567890" (repeated to the hash's size), 8 digits.
    SEEDS = {"SHA1": b"12345678901234567890", "SHA256": b"12345678901234567890123456789012",
             "SHA512": b"1234567890123456789012345678901234567890123456789012345678901234"}
    VECTORS = [(59, "94287082", "46119246", "90693936"), (1111111109, "07081804", "68084774", "25091201"),
               (1234567890, "89005924", "91819424", "93441116"), (20000000000, "65353130", "77737706", "47863826")]

    def key(self, algorithm):
        return {"secret": base64.b32encode(self.SEEDS[algorithm]).decode().rstrip("="), "algorithm": algorithm,
                "digits": 8, "period": 30}

    def test_the_rfc_6238_codes(self):
        for moment, sha1, sha256, sha512 in self.VECTORS:
            for algorithm, expected in (("SHA1", sha1), ("SHA256", sha256), ("SHA512", sha512)):
                with self.subTest(moment=moment, algorithm=algorithm):
                    self.assertEqual(pip_totp.code(self.key(algorithm), moment), expected)

    def test_a_key_is_a_base32_secret_or_an_otpauth_link_and_a_counter_key_is_refused(self):
        self.assertEqual(pip_totp.parse_key("jbsw y3dp ehpk 3pxp jbsw y3dp ehpk 3pxp"),
                         {"secret": SECRET, "algorithm": "SHA1", "digits": 6, "period": 30})
        self.assertEqual(pip_totp.parse_key(OTPAUTH)["secret"], SECRET)
        self.assertEqual(pip_totp.parse_key(f"otpauth://totp/x?secret={SECRET}&algorithm=SHA512&digits=8&period=60"),
                         {"secret": SECRET, "algorithm": "SHA512", "digits": 8, "period": 60})
        for bad, words in ((f"otpauth://hotp/x?secret={SECRET}&counter=3", "counter-based"),
                           (f"otpauth://totp/x?secret={SECRET}&algorithm=MD5", "SHA1, SHA256 or SHA512"),
                           (f"otpauth://totp/x?secret={SECRET}&digits=4", "6 to 8 digits"),
                           (f"otpauth://totp/x?secret={SECRET}&period=5", "10 to 300 seconds"),
                           ("not a key!", "isn't an authenticator key"), ("JBSWY3DP", "isn't an authenticator key")):
            with self.subTest(bad=bad):
                with self.assertRaisesRegex(pip_totp.TotpError, words) as caught:
                    pip_totp.parse_key(bad)
                self.assertNotIn(SECRET, str(caught.exception), "an error never repeats the key")


class StoreTests(unittest.TestCase):
    def setUp(self):
        import tempfile
        temp = tempfile.TemporaryDirectory(prefix="pl-")
        self.addCleanup(temp.cleanup)
        self.state = Path(temp.name) / "pips"
        self.store = pip_logins.Store(self.state)
        self.pip = "pip_" + "a" * 32

    def save(self, **kw):
        values = dict(address="https://login.northwind-bank.example/signin", username="arjun.mehta", password=PASSWORD,
                      totp=OTPAUTH, pips=[self.pip], source="page")
        values.update(kw)
        return self.store.save(**values)

    def test_a_login_is_sealed_in_files_only_you_can_read_and_never_comes_back_with_its_secrets(self):
        saved = self.save()
        folder = self.state / "logins"
        self.assertEqual(stat.S_IMODE(folder.stat().st_mode), 0o700)
        for name in ("logins.sealed", "logins.key"):
            self.assertEqual(stat.S_IMODE((folder / name).stat().st_mode), 0o600, name)
        everything = b"".join(p.read_bytes() for p in folder.iterdir() if p.is_file())
        for secret in (PASSWORD, SECRET, "arjun.mehta", "northwind"):
            self.assertNotIn(secret.encode(), everything, f"{secret} is not in the files as plain text")
        self.assertEqual(saved["site"], "northwind-bank.example")
        self.assertEqual(saved["hosts"], ["login.northwind-bank.example"])
        self.assertTrue(saved["has_code"])
        listing = json.dumps(self.store.listing(self.pip))
        self.assertNotIn(PASSWORD, listing)
        self.assertNotIn(SECRET, listing)
        self.assertEqual(set(saved), {"id", "site", "hosts", "username", "has_code", "pips", "source", "created_at",
                                      "last_used_at"})

    def test_a_changed_or_unkeyed_file_is_never_half_read(self):
        self.save()
        sealed = self.state / "logins" / "logins.sealed"
        raw = bytearray(sealed.read_bytes())
        raw[len(pip_logins.MAGIC) + 20] ^= 1
        sealed.write_bytes(bytes(raw))
        self.assertEqual(self.store.read()["logins"], [], "a file that fails its check opens as empty")
        self.save()
        self.assertEqual(len(self.store.read()["logins"]), 1)
        (self.state / "logins" / "logins.key").unlink()
        self.assertEqual(self.store.read()["logins"], [], "without its key, nothing")
        with self.assertRaises(pip_logins.LoginError):
            pip_logins.unseal(b"DGC-LOGINS-SEALED-1\n" + b"x" * 60, b"k" * 32)

    def test_the_same_account_saved_again_replaces_its_password_and_who_may_use_it_widens(self):
        first = self.save()
        other = "pip_" + "b" * 32
        again = self.save(address="www.northwind-bank.example", password="Changed-pass-00", totp="", pips=[other])
        self.assertEqual(again["id"], first["id"])
        self.assertEqual(again["pips"], [self.pip, other])
        self.assertEqual(again["hosts"], ["login.northwind-bank.example", "www.northwind-bank.example"])
        login = self.store.usable(other, "login.northwind-bank.example")[0]
        self.assertEqual((login["password"], login["totp"]["secret"]), ("Changed-pass-00", SECRET), "an empty key keeps the key")
        self.assertEqual(self.store.grant(first["id"], "all")["pips"], "all")
        self.assertTrue(self.store.remove(first["id"]))
        self.assertEqual(self.store.listing(), [])

    def test_a_login_fills_on_its_site_for_the_pips_it_names_and_on_secure_pages_only(self):
        self.save()
        self.assertEqual(len(self.store.usable(self.pip, "login.northwind-bank.example")), 1)
        self.assertEqual(len(self.store.usable(self.pip, "www.northwind-bank.example")), 1, "anywhere on its site")
        self.assertEqual(self.store.usable(self.pip, "northwind-bank.example.evil.test"), [])
        self.assertEqual(self.store.usable("pip_" + "c" * 32, "login.northwind-bank.example"), [], "another Pip may not")
        self.assertEqual(pip_logins.page_check("https://login.northwind-bank.example/signin")[:2],
                         (True, "login.northwind-bank.example"))
        self.assertEqual(pip_logins.page_check("http://login.northwind-bank.example/signin")[2], "insecure")
        self.assertTrue(pip_logins.page_check("http://127.0.0.1:8080/signin")[0], "plain http on this computer only")

    def test_what_the_user_types_is_checked_without_ever_repeating_it(self):
        for kw, words in (({"password": ""}, "Type the password"), ({"address": "not a site"}, "address"),
                          ({"totp": "otpauth://hotp/x?secret=" + SECRET}, "counter-based"), ({"pips": []}, "which Pips"),
                          ({"username": "a\nb"}, "line breaks")):
            with self.subTest(kw=kw):
                with self.assertRaisesRegex(pip_logins.LoginError, words) as caught:
                    self.save(**kw)
                self.assertNotIn(PASSWORD, str(caught.exception))

    def test_redaction_knows_every_saved_password_and_key(self):
        from dgc.redaction import redact_text, secret_values
        with patch("dgc.workspace_registry.state_directory", return_value=self.state):
            self.save()
            pip_logins._SEEN.clear()
            pip_logins._DEFAULT_CACHE.clear()
            known = secret_values()
            self.assertIn(PASSWORD, known)
            self.assertIn(SECRET, known)
            self.assertEqual(redact_text(f"my password is {PASSWORD} and my key {SECRET}", known),
                             "my password is [REDACTED] and my key [REDACTED]")


class ScrubberTests(unittest.TestCase):
    def test_every_form_of_a_saved_secret_and_a_recent_code_is_masked(self):
        clock = [100.0]
        scrub = pip_login_fill.Scrubber(lambda: (PASSWORD, SECRET), now=lambda: clock[0])
        scrub.remember("123456", "code")
        text = (f"{PASSWORD} {urllib.parse.quote_plus(PASSWORD)} {json.dumps(PASSWORD)} {SECRET} code 123456, "
                "order 91234567 and 1234567")
        out = scrub.scrub(text)
        for secret in (PASSWORD, SECRET, "123456 "):
            self.assertNotIn(secret, out)
        self.assertIn("91234567", out, "a code inside a longer number is left alone")
        clock[0] += pip_login_fill.CODE_SECONDS + 1
        self.assertIn("123456", scrub.scrub("code 123456"), "after five minutes a code is just a number")


class GateTests(unittest.TestCase):
    def browser(self):
        import tempfile
        from dgc import pip_computer_box as box
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        browser = box.BoxedBrowser(Path(temp.name), Path(temp.name) / "e.sock", chrome=None, log_path=Path(temp.name) / "l")
        fired, held = [], []
        browser._fire = lambda method, params=None, session=None: fired.append((method, params["requestId"]))
        browser.on_write = held.append
        return browser, fired, held

    def paused(self, browser, rid, url, body, kind="Document", content="application/x-www-form-urlencoded"):
        browser._gate({"requestId": rid, "resourceType": kind, "frameId": "f",
                       "request": {"method": "POST", "url": url, "postData": body, "headers": {"Content-Type": content}}}, "s")

    def test_only_the_sign_in_that_carries_what_dgc_typed_goes_to_its_site_once_and_every_other_submit_waits(self):
        browser, fired, held = self.browser()
        browser._pages.add("f")
        browser.acted_at = time.monotonic()
        browser.login_pass = pip_login_fill.LoginPass(frozenset({"login.northwind-bank.example"}), "northwind-bank.example",
                                                      False, ("arjun", PASSWORD), time.monotonic() + 10)
        form = "user=arjun&password=" + urllib.parse.quote_plus(PASSWORD)
        self.paused(browser, "elsewhere", "https://login.other.example/signin", form)
        self.paused(browser, "no-value", "https://login.northwind-bank.example/signin", "user=someone&password=x")
        self.paused(browser, "card", "https://login.northwind-bank.example/pay", form + "&cc=4242424242424242")
        self.assertEqual(fired, [], "another site, a body without the typed value, a card: all held")
        self.paused(browser, "login", "https://login.northwind-bank.example/signin", form)
        self.assertEqual(fired, [("Fetch.continueRequest", "login")])
        self.assertIsNone(browser.login_pass, "spent")
        self.assertEqual(browser.login_sent, ["POST login.northwind-bank.example/signin"])
        browser.acted_at = time.monotonic()
        self.paused(browser, "again", "https://login.northwind-bank.example/signin", form)
        self.assertEqual([h.request_id for h in held], ["elsewhere", "no-value", "card", "again"])
        self.assertIn("password", [f[0] for f in held[0].fields])
        self.assertEqual(dict(held[0].fields)["password"], "•••", "a held sign-in never shows the password")
        # JSON sign-ins (fetch) count too; an expired pass does not.
        browser.login_pass = pip_login_fill.LoginPass(frozenset({"login.northwind-bank.example"}), "northwind-bank.example",
                                                      False, ("123456",), time.monotonic() + 10)
        self.paused(browser, "json", "https://login.northwind-bank.example/api/verify", json.dumps({"otp": "123456"}),
                    kind="Fetch", content="application/json")
        self.assertEqual(fired[-1], ("Fetch.continueRequest", "json"))
        browser.login_pass = pip_login_fill.LoginPass(frozenset({"login.northwind-bank.example"}), "northwind-bank.example",
                                                      False, ("123456",), time.monotonic() - 1)
        browser.acted_at = time.monotonic()
        self.paused(browser, "late", "https://login.northwind-bank.example/api/verify", json.dumps({"otp": "123456"}),
                    kind="Fetch", content="application/json")
        self.assertEqual(fired[-1], ("Fetch.continueRequest", "json"))

    def test_a_pip_browser_never_keeps_passwords_itself(self):
        import tempfile
        from dgc import pip_computer_box as box
        with tempfile.TemporaryDirectory() as temp:
            profile = Path(temp) / ".browser"
            box.quiet_profile(profile)
            prefs = json.loads((profile / "Default" / "Preferences").read_text())
            self.assertIs(prefs["credentials_enable_service"], False)
            self.assertIs(prefs["profile"]["password_manager_enabled"], False)
            self.assertIs(prefs["autofill"]["credit_card_enabled"], False)


class ToolTests(unittest.TestCase):
    def test_sign_in_is_a_step_of_every_computer_and_of_a_subscription_brain_too(self):
        from dgc import pip_brain
        for eyes in (None, "own", "relay"):
            tool = pip_computer.schema(eyes)
            self.assertIn("sign_in", tool["function"]["parameters"]["properties"]["op"]["enum"])
            self.assertIn("site", tool["function"]["parameters"]["properties"])
        mcp = pip_brain.mcp_tool(pip_computer.schema(None))
        self.assertIn("sign_in", mcp["inputSchema"]["properties"]["op"]["enum"])
        self.assertIn("never a value", mcp["description"])
        self.assertIn("use sign_in", pip_computer.NOTICE)
        self.assertNotIn("ask the user to sign in on your computer's screen", pip_computer.NOTICE)


class Page:
    """A fake BoxedBrowser page for sign_in: its fields, what was typed into which, and what pressing Enter does."""

    def __init__(self, steps):
        self.steps, self.step, self.typed, self.focused, self.events, self.current_url = steps, 0, {}, None, [], steps[0]["href"]
        self.login_pass = None
        self.said = []

    def _isolated(self):
        return 1

    def _in_world(self, context, function, *args):
        page = self.steps[self.step]
        if function is pip_login_fill.FIND:
            return {"href": page["href"], "title": page.get("title", ""), "username": "user" in page,
                    "password": "password" in page, "code": 1 if "code" in page else 0, "other": 0,
                    "human": False, "alert": page.get("alert", "")}
        if function is pip_login_fill.FOCUS:
            nonce, key, mode, keep = args
            self.focused = key.rsplit(":", 1)[-1]
            return {"href": page["href"], "focused": True, "same": False, "busy": False}
        if function is pip_login_fill.CHECK:
            return {name: True for name in self.typed.get(self.step, {})}
        if function is pip_login_fill.STATE:
            return {"href": page["href"], "title": page.get("title", ""), "present": False, "busy": False,
                    "submitted": True, "leaving": False, "alert": "", "human": False}
        if function is pip_login_fill.SIGN_IN_PAGE:
            return {"href": page["href"], "password": "password" in page, "user": "user" in page}
        return {"href": page["href"], "cleared": 0}

    def insert_text(self, text):
        self.typed.setdefault(self.step, {})[self.focused] = text
        self.events.append(("insertText", self.focused))

    def press(self, key):
        self.events.append(("press", key))
        self.said.append(self.login_pass)
        if self.step + 1 < len(self.steps):
            self.step += 1

    def click_at(self, x, y):
        self.events.append(("click", x, y))

    def pump(self, seconds):
        pass

    def evaluate_json(self, expression):
        page = self.steps[self.step]
        return json.dumps([page["href"], page.get("title", "")])

    def navigate(self, url):
        self.events.append(("navigate", url))


class SignInTests(unittest.TestCase):
    """The computer's sign_in step, with the registry fixture's Personal Pip and a fake page."""

    def setUp(self):
        fixtures.LocalPipsTests.setUp(self)
        self.pip = self.store.create(self.registry.personal()["id"], "Banker", None, "editor-user", pip_type="lens",
                                     computer_plan={"schema_version": 1})
        self.logins = pip_logins.Store(self.registry.directory)

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
        for name in ("_page_said", "_frame", "_held_text", "_record_held", "_act", "_read"):
            setattr(host, name, getattr(pip_computer.Host, name).__get__(host))
        return host

    BANK = [{"href": "https://login.northwind-bank.example/signin", "user": 1, "password": 1, "title": "Sign in"},
            {"href": "https://login.northwind-bank.example/verify", "code": 1, "title": "Your code"},
            {"href": "https://login.northwind-bank.example/account", "title": "Your account"}]

    def test_no_saved_login_shows_one_card_and_saving_it_answers_the_card_and_the_pip_signs_in_by_itself(self):
        page = Page(self.BANK)
        host = self.host(page)
        told = pip_computer.Host.act(host, "sign_in", {})["text"]
        self.assertIn("No saved login for northwind-bank.example", told)
        self.assertEqual(len(host.waiting), 1)
        action = pip_computer.list_actions(self.registry, self.pip["id"])[0]
        self.assertEqual((action["status"], action["summary"]["kind"], action["summary"]["site"], action["summary"]["host"]),
                         ("pending", "login", "northwind-bank.example", "login.northwind-bank.example"))
        self.assertEqual(action["summary"]["sign_in_page"], "https://login.northwind-bank.example/signin")
        again = self.host(Page(self.BANK))
        self.assertIn("already below your reply", pip_computer.Host.act(again, "sign_in", {})["text"], "one card per site")
        from dgc import pip_attention
        from dgc.pip_schedules import timestamp
        waiting = pip_attention.collect(self.registry, timestamp(self.registry.clock()))
        self.assertIn("Save a login for northwind-bank.example?", [i["title"] for i in waiting["items"]])
        # Approving the card without a login is refused: Save login… saves it and answers the card in one step.
        refused = self.control({"type": "decide_pip_computer_action", "action_id": action["id"],
                                "expected_digest": action["digest"], "approve": True})
        self.assertEqual(refused["error"]["code"], "save_login")
        saved = self.control({"type": "save_pip_login", "pip_id": self.pip["id"], "action_id": action["id"],
                              "expected_digest": action["digest"], "username": "arjun.mehta", "password": PASSWORD,
                              "totp": OTPAUTH, "pips": "only"})
        self.assertTrue(saved["ok"], saved)
        self.assertNotIn(PASSWORD, json.dumps(saved))
        self.assertNotIn(SECRET, json.dumps(saved))
        self.assertEqual(saved["result"]["action"]["status"], "approved")
        self.assertEqual(saved["result"]["login"]["hosts"], ["login.northwind-bank.example"])
        # The supervisor's tick: the card is done, and the Pip is asked to sign in itself.
        sent = []
        with patch("dgc.pip_chat.send", side_effect=lambda *a, **k: sent.append(a) or {"run": {"id": "run_" + "f" * 32}}):
            pip_computer.tick(self.registry, self.cfg)
        self.assertEqual(sent, [], "a card from no chat run has no chat to continue")
        row = pip_computer.list_actions(self.registry, self.pip["id"])[0]
        self.assertEqual(row["status"], "sent")
        text = pip_chat.COMPUTER_LOGIN_SAVED.format(site="northwind-bank.example", where="")
        self.assertIn("Use sign_in", text)
        # Now it signs in: username and password, then the code, to the account page; nothing typed by a script.
        page = Page(self.BANK)
        host = self.host(page)
        with patch.object(pip_login_fill.time, "time", return_value=1_000_000_005.0):
            told = pip_computer.Host.act(host, "sign_in", {})["text"]
        self.assertIn("Signed in to northwind-bank.example", told)
        self.assertIn("the username, the password and the one-time code", told)
        self.assertIn("https://login.northwind-bank.example/account", told)
        self.assertEqual(page.typed[0], {"username": "arjun.mehta", "password": PASSWORD})
        code = pip_totp.code(pip_totp.parse_key(OTPAUTH), 1_000_000_005.0)
        self.assertEqual(page.typed[1], {"code0": code})
        self.assertEqual([e[0] for e in page.events], ["insertText", "insertText", "press", "insertText", "press"])
        self.assertTrue(all(isinstance(p, pip_login_fill.LoginPass) for p in page.said), "each submit had its one pass")
        self.assertEqual(page.said[0].values, ("arjun.mehta", PASSWORD))
        self.assertEqual(page.said[1].values, (code,))
        for secret in (PASSWORD, SECRET, code):
            self.assertNotIn(secret, told)
        self.assertIsNotNone(self.logins.listing()[0]["last_used_at"])

    def follow_ups(self):
        return [m for m in pip_chat.list_messages(self.store, self.pip["id"])["messages"] if m["role"] == "user" and m.get("intro")]

    def chat_offer(self, ask="check my balance at northwind-bank.example"):
        run = pip_chat.send(self.store, self.pip["id"], ask, "k-" + os.urandom(3).hex(), "editor-user", self.cfg)["run"]
        self.store.claim_next()
        host = self.host(Page(self.BANK))
        host.run_id = run["id"]
        told = pip_computer.Host.act(host, "sign_in", {})["text"]
        self.assertIn("they can save it on the card below", told)
        self.store.finish(run["id"], result={"text": "Northwind needs a sign-in: save it on the card below.",
                                             "computer": {"calls": 3, "held": list(host.waiting)}})
        return pip_computer.list_actions(self.registry, self.pip["id"])[0]

    def test_saving_from_the_card_in_its_chat_asks_the_pip_to_sign_in_itself_and_not_now_says_so(self):
        action = self.chat_offer()
        messages = pip_chat.list_messages(self.store, self.pip["id"])["messages"]
        self.assertNotIn("choices", messages[-1], "the card is the one decision under that reply")
        saved = self.control({"type": "save_pip_login", "pip_id": self.pip["id"], "action_id": action["id"],
                              "expected_digest": action["digest"], "username": "arjun.mehta", "password": PASSWORD,
                              "totp": OTPAUTH})
        self.assertTrue(saved["ok"], saved)
        pip_computer.tick(self.registry, self.cfg)
        [told] = self.follow_ups()
        self.assertIn("The user saved a login for northwind-bank.example.", told["text"])
        self.assertIn("Its sign-in page is https://login.northwind-bank.example/signin", told["text"])
        self.assertIn("Use sign_in there now", told["text"])
        for secret in (PASSWORD, SECRET, "arjun.mehta"):
            self.assertNotIn(secret, json.dumps(pip_chat.list_messages(self.store, self.pip["id"])))
        self.store.cancel(told["run_id"], "local-console")
        # Another site, and Not now this time.
        bank = self.BANK
        self.BANK = [{**page, "href": page["href"].replace("northwind-bank", "contoso-mail")} for page in bank]
        try:
            other = self.chat_offer("check my mail at contoso-mail.example")
        finally:
            self.BANK = bank
        self.control({"type": "decide_pip_computer_action", "action_id": other["id"], "expected_digest": other["digest"],
                      "approve": False})
        pip_computer.tick(self.registry, self.cfg)
        told = self.follow_ups()[-1]
        self.assertIn("The user chose Not now: they won't save a login for contoso-mail.example now.", told["text"])

    def test_on_a_page_without_sign_in_boxes_it_goes_to_the_sign_in_page_the_login_was_saved_from(self):
        self.logins.save(address="login.northwind-bank.example", username="arjun", password=PASSWORD, totp=OTPAUTH,
                         pips=[self.pip["id"]], source="card", page="https://login.northwind-bank.example/signin")
        home = Page([{"href": "https://www.northwind-bank.example/", "title": "Northwind Bank"}])
        pip_computer.Host.act(self.host(home), "sign_in", {})
        self.assertEqual(home.events[0], ("navigate", "https://login.northwind-bank.example/signin"))
        here = Page(self.BANK[:1])
        pip_computer.Host.act(self.host(here), "sign_in", {})
        self.assertNotIn("navigate", [e[0] for e in here.events], "already on a sign-in page: it fills there")

    def test_the_pip_is_told_plainly_when_the_page_wants_what_it_cannot_fill_or_says_no(self):
        self.logins.save(address="login.northwind-bank.example", username="arjun", password=PASSWORD, totp=None,
                         pips=[self.pip["id"]], source="page")
        no_key = pip_computer.Host.act(self.host(Page(self.BANK)), "sign_in", {})["text"]
        self.assertIn("asks for a one-time code, and the login saved for northwind-bank.example has no authenticator key", no_key)
        refused = Page([self.BANK[0], {**self.BANK[0], "alert": "Wrong password"}])
        said = pip_computer.Host.act(self.host(refused), "sign_in", {})["text"]
        self.assertIn("did not accept the saved login", said)
        self.assertIn("Wrong password", said)
        self.assertIn("cleared from the page", said)
        insecure = Page([{**self.BANK[0], "href": "http://login.northwind-bank.example/signin"}])
        self.assertIn("isn't secure", pip_computer.Host.act(self.host(insecure), "sign_in", {})["text"])
        self.assertEqual(insecure.typed, {}, "never typed into a plain-http page")

    def test_a_pip_another_login_belongs_to_gets_a_card_and_not_now_is_kept_for_a_day(self):
        other = self.store.create(self.registry.personal()["id"], "Other", None, "editor-user", pip_type="lens",
                                  computer_plan={"schema_version": 1})
        self.logins.save(address="login.northwind-bank.example", username="arjun", password=PASSWORD, totp=OTPAUTH,
                         pips=[other["id"]], source="page")
        page = Page(self.BANK)
        told = pip_computer.Host.act(self.host(page), "sign_in", {})["text"]
        self.assertIn("No saved login", told)
        self.assertEqual(page.typed, {}, "a login kept to another Pip is never typed for this one")
        action = pip_computer.list_actions(self.registry, self.pip["id"])[0]
        no = self.control({"type": "decide_pip_computer_action", "action_id": action["id"],
                           "expected_digest": action["digest"], "approve": False})
        self.assertEqual(no["result"]["action"]["status"], "rejected")
        self.assertIn("chose not to save a login", pip_computer.Host.act(self.host(Page(self.BANK)), "sign_in", {})["text"])
        text = pip_chat.COMPUTER_LOGIN_NOT_NOW.format(site="northwind-bank.example")
        self.assertIn("Don't ask again", text)
        # Letting this Pip use it too (grant_pip_login) is all it takes.
        login = self.logins.listing()[0]
        granted = self.control({"type": "grant_pip_login", "login_id": login["id"], "pips": [other["id"], self.pip["id"]]})
        self.assertEqual(granted["result"]["login"]["pips"], [other["id"], self.pip["id"]])
        self.assertTrue(self.logins.usable(self.pip["id"], "login.northwind-bank.example"))

    def test_the_four_requests_are_local_and_never_answer_with_a_secret(self):
        saved = self.control({"type": "save_pip_login", "pip_id": self.pip["id"], "site": "https://www.northwind-bank.example",
                              "username": "arjun", "password": PASSWORD, "totp": SECRET})
        self.assertTrue(saved["ok"], saved)
        self.assertEqual(saved["result"]["login"]["pips"], [self.pip["id"]], "only this Pip unless the user chose all")
        # Saving the same password again keeps it as typed (redaction knows it now, and must not turn it into a mask).
        again = self.control({"type": "save_pip_login", "pip_id": self.pip["id"], "site": "www.northwind-bank.example",
                              "username": "arjun", "password": PASSWORD, "pips": "all"})
        self.assertTrue(again["ok"], again)
        stored = self.logins.usable(self.pip["id"], "www.northwind-bank.example")[0]
        self.assertEqual(stored["password"], PASSWORD)
        self.assertEqual(stored["pips"], "all")
        listing = self.control({"type": "list_pip_logins", "pip_id": self.pip["id"]})
        self.assertEqual([(l["site"], l["username"], l["has_code"], l["usable"]) for l in listing["result"]["logins"]],
                         [("northwind-bank.example", "arjun", True, True)])
        for response in (saved, again, listing):
            self.assertNotIn(PASSWORD, json.dumps(response))
            self.assertNotIn(SECRET, json.dumps(response))
        bad = self.control({"type": "save_pip_login", "pip_id": self.pip["id"], "site": "www.northwind-bank.example",
                            "username": "arjun", "password": PASSWORD, "totp": "otpauth://hotp/x?secret=" + SECRET})
        self.assertFalse(bad["ok"])
        self.assertNotIn(PASSWORD, json.dumps(bad))
        remote = self.control({"type": "list_pip_logins"}, actor="device_1")
        self.assertFalse(remote["ok"])
        project = self.store.create(self.workspace["id"], "Auditor", "Inspect.", "editor-user")
        no = self.control({"type": "save_pip_login", "pip_id": project["id"], "site": "x.example", "username": "a",
                           "password": PASSWORD})
        self.assertEqual(no["error"]["message"], "Saved logins are for Personal Pips.")
        removed = self.control({"type": "remove_pip_login", "login_id": stored["id"]})
        self.assertEqual(removed["result"]["removed"], True)
        # Nothing of it is in the Pips database, its exports or a shared Pip.
        exported = pips.handle_control  # noqa: F841 -- exports below read the registry the same way
        from dgc import pip_share
        shared = json.dumps(pip_share.export(self.store, self.pip["id"]))
        self.assertNotIn(PASSWORD, shared)
        self.registry.db.commit()
        database = b"".join(p.read_bytes() for p in Path(self.registry.directory).glob("registry.sqlite3*"))
        for secret in (PASSWORD, SECRET):
            self.assertNotIn(secret.encode(), database)


class HoldTests(unittest.TestCase):
    def test_while_a_typed_secret_may_be_on_the_page_steps_that_could_copy_it_wait_and_then_it_is_cleared(self):
        page = Page([{"href": "https://login.example.com/signin", "user": 1, "password": 1}])
        cleared = []
        page._in_world = (lambda original: lambda context, function, *args:
                          cleared.append(1) or {"cleared": 1} if function is pip_login_fill.CLEAR else original(context, function, *args))(page._in_world)
        host = types.SimpleNamespace(browser=page, lock=threading.RLock(),
                                     secret_hold={"url": "https://login.example.com/signin", "until": time.monotonic() + 60})
        host._page_said = pip_computer.Host._page_said.__get__(host)
        self.assertEqual(pip_computer._secret_hold_refusal(host, "desktop_key"), pip_computer.SECRET_ON_PAGE)
        self.assertIsNone(pip_computer._secret_hold_refusal(host, "read"), "read and look work: the boxes are masked")
        host.secret_hold["until"] = time.monotonic() - 1
        self.assertIsNone(pip_computer._secret_hold_refusal(host, "desktop_key"))
        self.assertEqual(cleared, [1], "DGC empties the boxes itself when the hold ends")
        self.assertIsNone(host.secret_hold)


# --------------------------------------------------------------------------- a real browser

SIGN_IN = """<!doctype html><title>Sign in</title><body style="margin:0;font:16px sans-serif">
<form method="post" action="/signin"><label>Customer ID <input id="user" name="customer_id" autocomplete="username" style="width:300px"></label><br>
<label>Password <input id="pw" type="password" name="pass" style="width:300px"></label><br><button>Sign in</button></form>
<p id="err" role="alert">ERR</p></body>"""
VERIFY = """<!doctype html><title>Your code</title><body style="margin:0;font:16px sans-serif"><form method="post" action="/verify">
<label>Code from your authenticator app <input id="code" name="code" inputmode="numeric" style="width:300px"></label>
<button>Verify</button></form></body>"""
ACCOUNT = """<!doctype html><title>Your account</title><body><h1>Hello Arjun</h1><p>Balance: 84,213.50</p>
<form method="post" action="/transfer"><input name="to" value="x"><button id="send">Send money</button></form></body>"""


def _bank():
    received, sessions = [], set()

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def page(self, body, cookie=None, status=200, location=None):
            data = body.encode()
            self.send_response(status)
            if location:
                self.send_header("Location", location)
            if cookie:
                self.send_header("Set-Cookie", cookie)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            path = self.path.split("?", 1)[0]
            cookie = self.headers.get("Cookie", "")
            if path == "/account":
                if any(f"sid={s}" in cookie for s in sessions):
                    return self.page(ACCOUNT)
                return self.page("", status=302, location="/signin")
            if path == "/verify":
                return self.page(VERIFY)
            return self.page(SIGN_IN.replace("ERR", "Wrong customer ID or password." if "bad=1" in self.path else ""))

        def do_POST(self):
            body = self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode()
            fields = dict(urllib.parse.parse_qsl(body))
            received.append((self.path, fields))
            if self.path == "/signin":
                ok = fields.get("customer_id") == "arjun.mehta" and fields.get("pass") == PASSWORD
                return self.page("", status=302, location="/verify" if ok else "/signin?bad=1",
                                 cookie="pre=1; Path=/" if ok else None)
            if self.path == "/verify":
                key = pip_totp.parse_key(SECRET)
                good = {pip_totp.code(key, time.time() + d) for d in (-30, 0, 30)}
                if fields.get("code") in good:
                    sid = os.urandom(8).hex()
                    sessions.add(sid)
                    return self.page("", status=302, location="/account", cookie=f"sid={sid}; Path=/")
                return self.page(VERIFY)
            return self.page("ok")

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, received, sessions


from dgc import pip_computer_box as box  # noqa: E402


@unittest.skipUnless(box.capability().get("available") or os.environ.get("DGC_REQUIRE_CHROMIUM"),
                     "needs Linux, bubblewrap and a Chromium build")
class RealSignInTests(unittest.TestCase):
    def setUp(self):
        import tempfile
        temp = tempfile.TemporaryDirectory(prefix="pl-real-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        (self.root / "home" / "Files").mkdir(parents=True)
        self.server, self.received, self.sessions = _bank()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        port = self.server.server_address[1]
        self.base = f"http://127.0.0.1:{port}"
        policy = lambda host, p, **kw: ["127.0.0.1"] if host == "127.0.0.1" and p == port else []
        self.proxy = box.EgressProxy(Path(f"/tmp/pl-{os.getpid()}-{id(self)}.sock"), policy=policy)
        self.proxy.start()
        self.addCleanup(self.proxy.stop)
        self.held = []
        self.browser = box.BoxedBrowser(self.root / "home", self.proxy.path, chrome=box.find_chrome(),
                                        log_path=self.root / "box.log", on_write=self.held.append)
        self.addCleanup(self.browser.close)
        self.login = {"id": "login_" + "1" * 32, "site": "127.0.0.1", "hosts": ["127.0.0.1"], "exact": False,
                      "username": "arjun.mehta", "password": PASSWORD, "totp": pip_totp.parse_key(SECRET),
                      "pips": "all", "sign_in_page": "", "source": "page"}

    def brightness(self, jpeg, points):
        return self.browser.evaluate_json("""(async () => {
          const bin = atob(%s), bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const pic = await createImageBitmap(new Blob([bytes], {type: 'image/jpeg'}));
          const c = new OffscreenCanvas(pic.width, pic.height), g = c.getContext('2d'); g.drawImage(pic, 0, 0);
          return %s.map(([x, y]) => { const d = g.getImageData(x, y, 1, 1).data; return Math.round((d[0] + d[1] + d[2]) / 3); });
        })()""" % (json.dumps(base64.b64encode(jpeg).decode()), json.dumps(points)))

    def test_a_real_browser_signs_in_through_both_steps_to_the_account_and_the_pip_never_sees_a_value(self):
        self.assertEqual(self.browser.navigate(self.base + "/signin"), "loaded")
        self.assertEqual(pip_login_fill.sign_in_page(self.browser)["password"], True)
        scrub = pip_login_fill.Scrubber(lambda: (PASSWORD, SECRET))
        outcome = pip_login_fill.SignIn(self.browser, self.login, remember=scrub.remember).run()
        self.assertTrue(outcome.signed_in, outcome.text)
        self.assertEqual(outcome.filled, ["username", "password", "code"])
        self.assertIn("/account", outcome.text)
        self.assertIn("Hello Arjun", "\n".join(self.browser.snapshot()["lines"]))
        self.assertEqual([path for path, _ in self.received], ["/signin", "/verify"], "both sign-in posts went, once each")
        self.assertEqual(self.received[0][1], {"customer_id": "arjun.mehta", "pass": PASSWORD}, "typed as real input")
        self.assertEqual(self.held, [], "the saved login's own submits were let through")
        self.assertEqual(len(self.sessions), 1)
        self.assertEqual(scrub.scrub(outcome.text), outcome.text, "nothing to scrub: no value in what the Pip is told")
        # Every other submit still waits for the user.
        self.browser.click(next(re.search(r"\[(e\d+)\]", line).group(1) for line in self.browser.snapshot()["lines"]
                                if "Send money" in line))
        end = time.monotonic() + 10
        while not self.held and time.monotonic() < end:
            self.browser.pump(0.3)
        self.assertEqual([h.summary()["path"] for h in self.held], ["/transfer"])
        self.assertEqual([path for path, _ in self.received], ["/signin", "/verify"])

    def test_a_box_dgc_typed_a_secret_into_is_black_to_the_pip_and_hidden_in_its_read(self):
        self.assertEqual(self.browser.navigate(self.base + "/verify"), "loaded")
        run = pip_login_fill.SignIn(self.browser, self.login, remember=lambda *a: None)
        fields = run._find(0, 0)
        self.assertEqual(fields["code"], 1, "a plain text box named code is the one-time code box")
        self.assertEqual(run._type(f"{run.nonce}:0:code0", "424242"), "typed")
        self.assertIn("value=(hidden)", "\n".join(self.browser.snapshot()["lines"]))
        shot = self.browser.screenshot_for_model()
        x, y = json.loads(self.browser.evaluate_json("JSON.stringify((r => [r.left + 40, r.top + r.height / 2])("
                                                     "document.getElementById('code').getBoundingClientRect()))"))
        self.assertLess(self.brightness(shot["data"], [[round(x * shot["scale"]), round(y * shot["scale"])]])[0], 40)
        self.assertEqual(pip_login_fill.clear_secrets(self.browser), 1)
        self.assertEqual(self.browser.evaluate_json("document.getElementById('code').value"), "")

    def test_a_wrong_saved_password_is_said_cleared_and_never_sent_twice(self):
        self.assertEqual(self.browser.navigate(self.base + "/signin"), "loaded")
        wrong = {**self.login, "password": "Not-the-password-1"}
        outcome = pip_login_fill.SignIn(self.browser, wrong, remember=lambda *a: None).run()
        self.assertFalse(outcome.ok)
        self.assertIn("did not accept", outcome.text)
        self.assertEqual([path for path, _ in self.received], ["/signin"])


if __name__ == "__main__":
    unittest.main()
