"""Clear browsing data in Your Browser (0.52, Pips API 112).

A right-click on Your Browser offers "Clear browsing data": the person ticks what goes (Browsing history, Sign-ins,
Saved passwords) and confirms. clear_your_browser {history, sign_ins, passwords} clears exactly that, in DGC's own
profile for Your Browser and nowhere else (never the person's own Chrome profile):

- history: pages visited, the downloads list, the recent links on Home's Browser card (DGC's own list of them too);
- sign_ins: cookies and site data (you are signed out of sites);
- passwords: the passwords Chrome saved in DGC's profile.

Chrome's files are cleared only with Chrome stopped: the supervisor closes Your Browser, clears, and opens it again if
it was open. With the Pips runner off nothing of DGC's runs Chrome, so the editor's side clears at once (unless a Chrome
still holds the profile). Where Chrome is signed in to a Google account, the answer says so: the account keeps its own
copy if sync is on. Only the person, locally, may ask.
"""
from __future__ import annotations

import http.server
import json
import os
import shutil
import sqlite3
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import your_browser
from tests.test_your_browser_own_tab import OwnHost, _installed_chrome
from tests.test_your_browser_window import Base, Host

HISTORY = ("History", "History-journal", "Visited Links", "Top Sites", "Top Sites-journal", "Shortcuts", "Shortcuts-journal",
           "Network Action Predictor", "Network Action Predictor-journal", "Favicons", "Favicons-journal",
           "Sessions/Session_1", "Sessions/Tabs_1", "Sessions_Encrypted/Session_1", "History Provider Cache")
SIGN_INS = ("Cookies", "Cookies-journal", "Network/Cookies", "Network/Cookies-journal", "Local Storage/leveldb/000003.log",
            "Session Storage/000003.log", "IndexedDB/https_mail.example.com_0.indexeddb.leveldb/LOG",
            "Service Worker/Database/LOG", "File System/000/p/00/0001", "databases/Databases.db", "WebStorage/1/x",
            "Shared Dictionary/db", "SharedStorage", "Trust Tokens", "Network/Trust Tokens")
PASSWORDS = ("Login Data", "Login Data-journal", "Login Data For Account", "Login Data For Account-journal")
KEPT = ("Preferences", "Secure Preferences", "Bookmarks", "Web Data", "Extensions/abc/1.0/manifest.json",
        "Local Extension Settings/abc/LOG", "Sync Data/LevelDB/LOG", "Network/TransportSecurity", "Storage/ext/abc/def/x",
        "Extension Cookies")


class Profile(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="yb-clear-")
        self.addCleanup(temp.cleanup)
        self.directory = Path(temp.name)
        self.root = your_browser.folder(self.directory)
        self.profile = self.root / "profile"
        for name in ("Default", "Profile 1"):
            for path in (*HISTORY, *SIGN_INS, *PASSWORDS, *KEPT):
                file = self.profile / name / path
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text("x")
        (self.profile / "Local State").write_text("{}")
        (self.root / your_browser.RECENT_FILE).write_text(json.dumps({"links": [{"url": "https://a.example.com/", "title": "A"}]}))

    def present(self, name="Default"):
        return {p for p in (*HISTORY, *SIGN_INS, *PASSWORDS, *KEPT) if (self.profile / name / p).exists()}

    def test_history_clears_history_and_homes_links_and_nothing_else(self):
        out = your_browser.clear_profile(self.directory, {"history"})
        self.assertEqual(out, ["history"])
        for name in ("Default", "Profile 1"):
            self.assertEqual(self.present(name), set(SIGN_INS) | set(PASSWORDS) | set(KEPT), name)
        self.assertFalse((self.root / your_browser.RECENT_FILE).exists(), "Home's Browser card forgets them too")
        self.assertEqual(your_browser.recent_links(self.directory), [])
        self.assertTrue((self.profile / "Local State").exists())

    def test_sign_ins_clear_cookies_and_site_data_and_nothing_else(self):
        your_browser.clear_profile(self.directory, {"sign_ins"})
        self.assertEqual(self.present(), set(HISTORY) | set(PASSWORDS) | set(KEPT))
        self.assertTrue((self.root / your_browser.RECENT_FILE).exists())

    def test_passwords_clear_the_saved_passwords_and_nothing_else(self):
        your_browser.clear_profile(self.directory, {"passwords"})
        self.assertEqual(self.present(), set(HISTORY) | set(SIGN_INS) | set(KEPT))

    def test_all_three(self):
        out = your_browser.clear_profile(self.directory, {"history", "sign_ins", "passwords"})
        self.assertEqual(out, ["history", "sign_ins", "passwords"])
        self.assertEqual(self.present(), set(KEPT), "bookmarks, settings, extensions and sync stay")

    def test_a_link_is_never_followed(self):
        outside = Path(tempfile.mkdtemp(prefix="yb-outside-"))
        self.addCleanup(shutil.rmtree, outside, True)
        (outside / "keep.log").write_text("mine")
        (outside / "History").write_text("theirs")
        shutil.rmtree(self.profile / "Default" / "Local Storage")
        (self.profile / "Default" / "Local Storage").symlink_to(outside)
        (self.profile / "Default" / "History").unlink()
        (self.profile / "Default" / "History").symlink_to(outside / "History")
        your_browser.clear_profile(self.directory, {"history", "sign_ins"})
        self.assertEqual((outside / "keep.log").read_text(), "mine")
        self.assertEqual((outside / "History").read_text(), "theirs")
        self.assertFalse(os.path.lexists(self.profile / "Default" / "Local Storage"), "the link itself goes, never what it points at")

    def test_a_profile_folder_that_is_a_link_is_refused(self):
        outside = Path(tempfile.mkdtemp(prefix="yb-outside-"))
        self.addCleanup(shutil.rmtree, outside, True)
        (outside / "Default").mkdir()
        (outside / "Default" / "History").write_text("theirs")
        shutil.rmtree(self.profile)
        self.profile.symlink_to(outside)
        with self.assertRaises(your_browser.RegistryError):
            your_browser.clear_profile(self.directory, {"history"})
        self.assertTrue((outside / "Default" / "History").exists())

    def test_never_the_persons_own_chrome(self):
        home = Path(tempfile.mkdtemp(prefix="yb-home-"))
        self.addCleanup(shutil.rmtree, home, True)
        theirs = home / ".config" / "google-chrome" / "Default" / "History"
        theirs.parent.mkdir(parents=True)
        theirs.write_text("theirs")
        with patch.dict(os.environ, {"HOME": str(home)}):
            your_browser.clear_profile(self.directory, {"history", "sign_ins", "passwords"})
        self.assertEqual(theirs.read_text(), "theirs")

    def test_a_chrome_account_is_seen_from_the_profiles_own_settings(self):
        prefs = self.profile / "Default" / "Preferences"
        prefs.write_text(json.dumps({"profile": {}}))
        self.assertFalse(your_browser.chrome_account(self.directory))
        prefs.write_text(json.dumps({"account_info": [{"email": "me@example.com", "gaia": "1"}]}))
        self.assertTrue(your_browser.chrome_account(self.directory))
        prefs.write_text("not json")
        self.assertFalse(your_browser.chrome_account(self.directory))


class OnlyRemoves(unittest.TestCase):
    def test_the_clearing_code_only_removes_and_never_reads_or_copies_what_it_clears(self):
        source = (Path(__file__).resolve().parents[1] / "dgc" / "your_browser_clear.py").read_text(encoding="utf-8")
        for word in ("sqlite3", "shutil.copy", "read_bytes", "open(", ".config/google-chrome", "Path.home", "expanduser"):
            with self.subTest(word=word):
                self.assertNotIn(word, source)
        self.assertEqual(source.count("read_text("), 1, "only the profile's own Preferences, for chrome_account")


class Supervisor(OwnHost):
    """The supervisor clears: Chrome closed first, then its files, then open again as it was."""

    def setUp(self):
        super().setUp()
        self.profile = your_browser.folder(self.directory) / "profile" / "Default"
        self.profile.mkdir(parents=True)
        for path in ("History", "Cookies", "Login Data", "Bookmarks"):
            (self.profile / path).write_text("x")

    def test_open_it_closes_clears_and_opens_again_as_it_was(self):
        self.host.open("https://example.com/", None, headless=True)
        self.host.recent.note("https://seen.example.com/", "Seen")
        self.assertEqual(len(self.launched), 1)
        out = self.host.clear({"history"})
        self.assertEqual((out["cleared"], out["reopened"]), (["history"], True))
        self.assertFalse((self.profile / "History").exists())
        self.assertTrue((self.profile / "Cookies").exists())
        self.assertEqual(len(self.launched), 2, "opened again")
        self.assertIn("--headless=new", self.launched[1], "as it was: the editor's streamed tab")
        self.assertTrue(self.host.headless)
        self.assertNotIn("https://seen.example.com/", [l["url"] for l in self.host.recent.links],
                         "Home's links forgotten in memory too, never written back")

    def test_closed_it_clears_and_stays_closed(self):
        out = self.host.clear({"sign_ins", "passwords"})
        self.assertEqual((sorted(out["cleared"]), out["reopened"]), (["passwords", "sign_ins"], False))
        self.assertEqual(self.launched, [])
        self.assertEqual({p.name for p in self.profile.iterdir()}, {"History", "Bookmarks"})


class Command(Base):
    def setUp(self):
        super().setUp()
        self.profile = your_browser.folder(self.registry.directory) / "profile" / "Default"
        self.profile.mkdir(parents=True)
        for path in ("History", "Cookies", "Login Data"):
            (self.profile / path).write_text("x")

    def test_what_is_asked_is_checked(self):
        for bad in ({}, {"history": "yes"}, {"history": False, "sign_ins": False, "passwords": False},
                    {"history": True, "cache": True}, {"history": 1}):
            with self.subTest(bad=bad):
                out = self.control("clear_your_browser", **bad)
                self.assertFalse(out["ok"], out)
        self.assertTrue((self.profile / "History").exists(), "nothing cleared by a bad ask")

    def test_only_the_person_locally(self):
        for actor in ("pip:" + "a" * 32, "remote-device", "model"):
            with self.subTest(actor=actor):
                self.assertFalse(self.control("clear_your_browser", actor=actor, history=True)["ok"])
        self.assertTrue((self.profile / "History").exists())

    def test_with_the_runner_the_supervisor_clears_it_and_the_answer_comes_back(self):
        seen = []

        def supervisor(seconds):
            # (The supervisor's own heartbeat, played here between two looks for its answer.)
            if seen:
                return
            row = self.registry.db.execute("SELECT value FROM metadata WHERE key=?", (your_browser.CLEAR_KEY,)).fetchone()
            ask = json.loads(row[0])
            seen.append(ask)
            cleared = your_browser.clear_profile(self.registry.directory, [k for k in your_browser.CLEAR_KINDS if ask[k]])
            your_browser.answer_clear(self.registry, ask["id"], {"ok": True, "cleared": cleared, "reopened": True})
        with patch.object(your_browser, "_nap", side_effect=supervisor):
            out = self.ok("clear_your_browser", history=True, sign_ins=False, passwords=False)
        self.assertEqual({k: seen[0][k] for k in ("history", "sign_ins", "passwords")}, {"history": True, "sign_ins": False, "passwords": False})
        self.assertEqual((out["cleared"], out["reopened"]), (["history"], True))
        self.assertFalse((self.profile / "History").exists())
        self.assertTrue((self.profile / "Cookies").exists())
        self.assertIsNone(self.registry.db.execute("SELECT value FROM metadata WHERE key=?", (your_browser.CLEARED_KEY,)).fetchone())

    def test_without_the_runner_it_clears_at_once(self):
        with patch.object(your_browser, "_runner_live", return_value=False):
            out = self.ok("clear_your_browser", passwords=True)
        self.assertEqual((out["cleared"], out["reopened"]), (["passwords"], False))
        self.assertFalse((self.profile / "Login Data").exists())
        self.assertTrue((self.profile / "History").exists())

    def test_without_the_runner_a_chrome_still_holding_the_profile_is_never_cleared_under_it(self):
        lock = self.profile.parent / "SingletonLock"
        os.symlink(f"{os.uname().nodename}-{os.getpid()}", lock)
        with patch.object(your_browser, "_runner_live", return_value=False):
            out = self.control("clear_your_browser", history=True)
        self.assertFalse(out["ok"])
        self.assertTrue((self.profile / "History").exists())

    def test_the_supervisor_tick_clears_what_was_asked(self):
        class FakeHost:
            def __init__(self):
                self.cleared = []

            def clear(self, kinds):
                self.cleared.append(sorted(kinds))
                return {"ok": True, "cleared": sorted(kinds), "reopened": False}

            def open(self, *a, **k):
                raise AssertionError("nothing to open")

            def tick(self, registry):
                pass
        fake = FakeHost()
        with self.registry.transaction():
            self.registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)", (your_browser.CLEAR_KEY, json.dumps(
                {"id": "c1", "history": True, "sign_ins": True, "passwords": False, "at": 1})))
        with patch.object(your_browser, "host_for", return_value=fake):
            your_browser.tick(self.registry)
        self.assertEqual(fake.cleared, [["history", "sign_ins"]])
        row = self.registry.db.execute("SELECT value FROM metadata WHERE key=?", (your_browser.CLEARED_KEY,)).fetchone()
        self.assertEqual(json.loads(row[0])["id"], "c1")
        self.assertIsNone(self.registry.db.execute("SELECT value FROM metadata WHERE key=?", (your_browser.CLEAR_KEY,)).fetchone())

    def test_get_your_browser_says_whether_chrome_is_signed_in_to_an_account(self):
        self.assertFalse(self.ok("get_your_browser")["chrome_account"])
        (self.profile / "Preferences").write_text(json.dumps({"account_info": [{"email": "me@example.com"}]}))
        self.assertTrue(self.ok("get_your_browser")["chrome_account"])
        self.assertTrue(self.ok("get_your_browser_recent")["chrome_account"])

    def test_it_is_pips_api_112(self):
        from dgc import headless
        self.assertGreaterEqual(headless.PIPS_API_VERSION, 112)
        self.assertIn("clear_your_browser", your_browser.COMMANDS)
        self.assertEqual(your_browser.COMMAND_ARGS["clear_your_browser"], {"history", "sign_ins", "passwords"})


# --------------------------------------------------------------------------- the real thing

class _CookieSite:
    def __init__(self):
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                body = b"<title>Visited</title><p>here</p>"
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.send_header("Set-Cookie", "sid=signed-in; Max-Age=86400; Path=/")
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def url(self, path="/visited"):
        return f"http://127.0.0.1:{self.server.server_address[1]}{path}"

    def stop(self):
        self.server.shutdown()
        self.server.server_close()


def _rows(path: Path, sql: str) -> list:
    if not path.exists():
        return []
    copy = Path(tempfile.mkdtemp(prefix="yb-db-")) / "db"
    try:
        shutil.copy(path, copy)
        with sqlite3.connect(copy) as db:
            return db.execute(sql).fetchall()
    finally:
        shutil.rmtree(copy.parent, True)


@unittest.skipUnless(_installed_chrome(), "needs Google Chrome installed from its package")
class RealClear(unittest.TestCase):
    """The installed Google Chrome with its sandbox on, headless (no display here): a visit and a sign-in cookie, then
    Clear history keeps the sign-in, and Clear sign-ins removes it."""

    def test_history_goes_and_the_sign_in_stays_then_the_sign_in_goes(self):
        temp = tempfile.TemporaryDirectory(prefix="yb-real-clear-")
        self.addCleanup(temp.cleanup)
        directory = Path(temp.name)
        site = _CookieSite()
        self.addCleanup(site.stop)
        profile = your_browser.folder(directory) / "profile" / "Default"
        env = {k: v for k, v in os.environ.items() if k not in ("DISPLAY", "WAYLAND_DISPLAY")}
        with patch.dict(os.environ, env, clear=True), patch.object(your_browser, "vnc_program", return_value=None):
            host = your_browser.YourBrowserHost(directory, chrome=_installed_chrome(), which=lambda name: None,
                                                test_flags=("--password-store=basic",))
            self.addCleanup(host.close)
            host.open(site.url(), None, headless=True)
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                time.sleep(0.3)
                with host.lock:
                    if host.browser.infos.get(host.own_tab() or "", {}).get("title") == "Visited":
                        break
                    host.refreshed = -1e9
                    host.refresh()
            host.close()                                 # (Chrome writes its history as it closes)
            self.assertTrue(_rows(profile / "History", "SELECT url FROM urls WHERE url LIKE '%/visited'"), "visited")
            self.assertTrue(_rows(profile / "Cookies", "SELECT name FROM cookies WHERE name='sid'")
                            or _rows(profile / "Network" / "Cookies", "SELECT name FROM cookies WHERE name='sid'"), "signed in")
            # Open again, then Clear history while it runs: it closes, clears and opens again.
            host.open("", None, headless=True)
            out = host.clear({"history"})
            self.assertEqual((out["cleared"], out["reopened"]), (["history"], True))
            self.assertTrue(host.running())
            host.close()
            self.assertEqual(_rows(profile / "History", "SELECT url FROM urls WHERE url LIKE '%/visited'"), [])
            self.assertTrue(_rows(profile / "Cookies", "SELECT name FROM cookies WHERE name='sid'")
                            or _rows(profile / "Network" / "Cookies", "SELECT name FROM cookies WHERE name='sid'"),
                            "the sign-in stays")
            out = host.clear({"sign_ins"})
            self.assertEqual((out["cleared"], out["reopened"]), (["sign_ins"], False))
            self.assertEqual(_rows(profile / "Cookies", "SELECT name FROM cookies WHERE name='sid'")
                             + _rows(profile / "Network" / "Cookies", "SELECT name FROM cookies WHERE name='sid'"), [])


if __name__ == "__main__":
    unittest.main()
