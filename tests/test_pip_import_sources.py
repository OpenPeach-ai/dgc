"""pips-18: import a bot. A team file or one Pip's file from a GitHub link (github.com, raw or gist addresses only, a
small file, nothing else fetched), or a Grok bot: Grok has no export, so DGC gives a prompt to paste into the Grok bot,
and the user pastes back what it writes. Either way it arrives as setup cards to approve, with no keys and no grants."""
import json
import unittest
from unittest.mock import patch

from dgc import pip_import_sources as sources, pip_share
from dgc.workspace_registry import RegistryError
from tests import test_pip_share as share_tests
from tests import test_pips_local as fixtures

GROK_ANSWER = """Here is my description:
```json
{"dgc_import": 1, "name": "Deal Finder", "job": "Find the best deals on flights to Goa each week and tell me.",
 "kind": "scout", "skills": ["compare prices", "watch fares"],
 "routines": [{"when": "every Monday at 9:00", "what": "Check fares to Goa"}]}
```"""


class GrokTests(unittest.TestCase):
    def test_the_prompt_asks_for_the_one_json_block_and_no_secrets(self):
        for words in ("dgc_import", "name", "job", "routines", "password", "Reply with only"):
            self.assertIn(words.lower(), sources.GROK_PROMPT.lower())

    def test_what_grok_writes_becomes_one_pip_file(self):
        document, notes = sources.parse_grok(GROK_ANSWER)
        pip = pip_share.check(document)["pip"]
        self.assertEqual((pip["name"], pip["pip_type"], pip["scope"], pip["schedule"]), ("Deal Finder", "scout", "personal", None))
        self.assertIn("Goa", pip["goal"])
        self.assertTrue(any("every Monday at 9:00" in n and "Check fares to Goa" in n for n in notes), notes)
        self.assertTrue(any("compare prices" in n for n in notes))
        # A kind DGC doesn't have is a scout; a Pulse (projects only) too.
        other, _ = sources.parse_grok(GROK_ANSWER.replace('"kind": "scout"', '"kind": "astronaut"'))
        self.assertEqual(other["pip"]["pip_type"], "scout")

    def test_anything_else_is_refused_in_plain_words(self):
        for text in ("", "no json here", "```json\n{\"name\": \"x\"}\n```", "```json\n[1,2]\n```",
                     "```json\n{\"dgc_import\": 1, \"name\": \"\", \"job\": \"x\"}\n```", "x" * 70000):
            with self.subTest(text=text[:30]), self.assertRaises(RegistryError):
                sources.parse_grok(text)


class GitHubTests(unittest.TestCase):
    def test_only_github_addresses_and_their_raw_files(self):
        self.assertEqual(sources.raw_url("https://github.com/acme/pips/blob/main/team.dgc-team.json"),
                         "https://raw.githubusercontent.com/acme/pips/main/team.dgc-team.json")
        for same in ("https://raw.githubusercontent.com/acme/pips/main/a.json", "https://gist.githubusercontent.com/u/abc/raw/a.json"):
            self.assertEqual(sources.raw_url(same), same)
        for bad in ("http://github.com/a/b/blob/main/x.json", "https://evil.example/a.json", "https://github.com/a/b",
                    "https://github.com.evil.example/a/b/blob/m/x", "https://user:pw@raw.githubusercontent.com/a/b/c", "file:///etc/passwd"):
            with self.subTest(url=bad), self.assertRaises(RegistryError):
                sources.raw_url(bad)

    def test_the_fetch_is_small_and_never_follows_a_redirect_elsewhere(self):
        class Reply:
            def __init__(self, body, url): self.body, self.url = body, url
            def read(self, n=-1): return self.body[:n] if n >= 0 else self.body
            def geturl(self): return self.url
            def __enter__(self): return self
            def __exit__(self, *a): return False
        ok = lambda request, timeout=None: Reply(b'{"format": "dgc-pip"}', request.full_url)
        self.assertEqual(sources.fetch("https://raw.githubusercontent.com/a/b/c.json", opener=ok), '{"format": "dgc-pip"}')
        moved = lambda request, timeout=None: Reply(b"{}", "https://evil.example/x")
        with self.assertRaises(RegistryError):
            sources.fetch("https://raw.githubusercontent.com/a/b/c.json", opener=moved)
        big = lambda request, timeout=None: Reply(b"x" * (sources.MAX_FETCH + 10), request.full_url)
        with self.assertRaises(RegistryError):
            sources.fetch("https://raw.githubusercontent.com/a/b/c.json", opener=big)


class ImportSourceTests(unittest.TestCase):
    setUp = share_tests.ImportControlTests.setUp
    git = fixtures.LocalPipsTests.git

    def importing(self, request):
        with patch("dgc.workspace_registry.WorkspaceRegistry", return_value=self.registry), patch.object(self.registry, "close"):
            return self.backend._pip_source_import(self.cfg, {"type": "import_pip_source", "request_id": "r", **request})

    def test_a_grok_answer_and_a_github_team_become_setup_cards(self):
        value = self.importing({"source": "grok", "text": GROK_ANSWER})
        self.assertEqual([card["status"] for card in value["setups"]], ["pending"])
        self.assertTrue(any("Check fares" in note for note in value["left_out"]))
        team = {"format": pip_share.TEAM_FORMAT, "version": 1, "name": "Ops", "pips": [
            {"format": "dgc-pip", "version": 1, "left_out": [], "pip": {"name": "A", "goal": "Do A.", "pip_type": "lens",
                                                                        "scope": "personal", "schedule": None}}]}
        with patch.object(sources, "fetch", return_value=json.dumps(team)):
            value = self.importing({"source": "github", "url": "https://github.com/acme/pips/blob/main/ops.dgc-team.json"})
        self.assertEqual(len(value["setups"]), 1)
        self.assertIsNone(self.registry.db.execute("SELECT 1 FROM pips").fetchone(), "nothing created until approved")
        with self.assertRaises(RegistryError):
            self.importing({"source": "ftp", "url": "x"})


if __name__ == "__main__":
    unittest.main()
