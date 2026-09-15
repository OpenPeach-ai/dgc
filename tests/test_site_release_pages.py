"""The built site: every note of the current release is visible, the extension card lists its notes,
and the /vscode page is named by the URL Cloudflare Pages actually serves (with its trailing slash)."""
from __future__ import annotations

import importlib.util
import json
import re
import sys
import unittest
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
SCRIPTS = PROJECT / "scripts"
SITE = PROJECT / "site"


def _load(name: str, filename: str):
    sys.path.insert(0, str(SCRIPTS))
    try:
        spec = importlib.util.spec_from_file_location(f"dgc_site_release_{name}", SCRIPTS / filename)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path.remove(str(SCRIPTS))


class ReleaseNotesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.build = _load("build", "build-site.py")

    def test_the_current_release_shows_every_note_and_an_older_one_says_how_many_more(self):
        rows = [
            {"version": "9.1.0", "date": "2026-09-14", "status": "current", "url": "https://x/9.1.0",
             "notes": [f"current note {i}" for i in range(1, 7)]},
            {"version": "9.0.0", "date": "2026-09-01", "status": "past", "url": "https://x/9.0.0",
             "notes": [f"past note {i}" for i in range(1, 6)]},
        ]
        html = self.build.release_rows(rows)
        current = re.search(r'id="release-9-1-0".*?</article>', html, re.S).group(0)
        self.assertEqual(len(re.findall(r"<li>", current)), 6)
        self.assertIn("current note 6", current)
        past = re.search(r'id="release-9-0-0".*?</article>', html, re.S).group(0)
        self.assertNotIn("past note 4", past)
        self.assertIn('<a href="https://x/9.0.0">2 more notes on the release page ↗</a>', past)

    def test_the_extension_card_lists_its_notes_escaped(self):
        rest = self.build._ext_note_rest({"extension": [{"notes": ["Headline", "Tasks <row>", "Undo & more"]}]})
        self.assertEqual(rest, '<ul class="card-notes"><li>Tasks &lt;row&gt;</li><li>Undo &amp; more</li></ul>')
        self.assertEqual(self.build._ext_note_rest({"extension": [{"notes": ["Only"]}]}), "")

    def test_the_committed_pages_show_all_current_notes(self):
        releases = json.loads((PROJECT / "site-src" / "data" / "releases.json").read_text(encoding="utf-8"))
        changelog = (SITE / "changelog.html").read_text(encoding="utf-8")
        for key, prefix in (("cli", "release"), ("extension", "release-ext")):
            row = releases[key][0]
            anchor = f'{prefix}-{row["version"].replace(".", "-")}'
            article = re.search(rf'id="{anchor}".*?</article>', changelog, re.S).group(0)
            self.assertEqual(len(re.findall(r"<li>", article)), len(row["notes"]), anchor)
        card = re.search(r'<aside class="card reveal"><span class="micro">Extension.*?</aside>',
                         (SITE / "vscode" / "index.html").read_text(encoding="utf-8"), re.S).group(0)
        self.assertEqual(len(re.findall(r"<li>", card)), len(releases["extension"][0]["notes"]) - 1)


class VscodeUrlTests(unittest.TestCase):
    def test_the_vscode_page_is_named_by_its_trailing_slash_url(self):
        site_common = _load("common", "site_common.py")
        head = site_common.head(title="DGC for VS Code", description="d", path="vscode/index.html")
        self.assertIn('<link rel="canonical" href="https://vibedgc.com/vscode/">', head)
        about = site_common.head(title="About", description="d", path="about.html")
        self.assertIn('<link rel="canonical" href="https://vibedgc.com/about">', about)
        sitemap = (SITE / "sitemap.xml").read_text(encoding="utf-8")
        self.assertIn("<loc>https://vibedgc.com/vscode/</loc>", sitemap)
        self.assertNotIn("<loc>https://vibedgc.com/vscode</loc>", sitemap)
        routes = json.loads((SITE / "routes.json").read_text(encoding="utf-8"))["html"]
        for route in routes:
            relative = ("index.html" if route == "/" else
                        f"{route.strip('/')}/index.html" if route in ("/docs", "/vscode") else
                        f"{route.strip('/')}.html")
            source = (SITE / relative).read_text(encoding="utf-8")
            self.assertNotRegex(source, r'href="https://vibedgc\.com/vscode"', relative)

    def test_the_local_qa_server_redirects_the_slashless_form_like_pages(self):
        server = (PROJECT / "qa" / "site" / "server.mjs").read_text(encoding="utf-8")
        self.assertIn('if (pathname === "/vscode") {', server)
        self.assertIn("writeHead(308", server)


if __name__ == "__main__":
    unittest.main()
