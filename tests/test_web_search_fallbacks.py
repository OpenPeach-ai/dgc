"""Keyless DuckDuckGo search is tried three ways, in order.

The bundled `ddgs` client first (it presents itself as a browser, so it is not refused the way a
plain scrape is), then DGC's own parse of the HTML endpoint, then the lite endpoint. An install
without the package, or a version of it that breaks, falls through instead of failing. Only when
all three come back empty does the user see an error, and it names what failed and what to do.
"""
from __future__ import annotations

import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

PROJECT = Path(__file__).resolve().parents[1]
if str(PROJECT) not in sys.path:
    sys.path.insert(0, str(PROJECT))

from dgc import search as search_mod  # noqa: E402

HTML_PAGE = """
<div class="result">
  <a class="result__a" href="/l/?uddg=https%3A%2F%2Fdocs.python.org%2F3%2F">Python docs</a>
  <a class="result__snippet">The official documentation</a>
</div>
"""

LITE_PAGE = """
<tr><td valign="top">1.&nbsp;</td>
    <td><a rel="nofollow" href="https://docs.python.org/3/" class='result-link'>Python docs</a></td></tr>
<tr><td>&nbsp;</td><td class='result-snippet'>The <b>official</b> documentation</td></tr>
"""


class _Response:
    def __init__(self, text: str = "", status: int = 200) -> None:
        self.text = text
        self.status_code = status

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise search_mod.requests.HTTPError(f"{self.status_code}")


class FakeDDGS:
    """Stands in for the ddgs package's client."""

    rows: list[dict] = []
    used = False

    def __enter__(self):
        type(self).used = True
        return self

    def __exit__(self, *exc):
        return False

    def text(self, query, max_results=6):
        return self.rows[:max_results]


def install_fake_package(rows: list[dict]) -> dict:
    FakeDDGS.rows = rows
    FakeDDGS.used = False
    module = types.ModuleType("ddgs")
    module.DDGS = FakeDDGS                                  # type: ignore[attr-defined]
    return {"ddgs": module}


class SearchChainTest(unittest.TestCase):
    def setUp(self):
        self.calls: list[str] = []

    def post(self, html_text: str = "", lite_text: str = "", fail: set[str] = frozenset()):
        def _post(url, data=None, headers=None, timeout=None):
            where = "lite" if "lite.duckduckgo" in url else "html"
            self.calls.append(where)
            if where in fail:
                raise search_mod.requests.ConnectionError("blocked")
            return _Response(lite_text if where == "lite" else html_text)
        return _post

    def test_the_package_is_used_first_when_installed(self):
        modules = install_fake_package([
            {"title": "Python docs", "href": "https://docs.python.org/3/", "body": "official"}])
        with patch.dict(sys.modules, modules), patch.object(search_mod.requests, "post", self.post()):
            results = search_mod._duckduckgo("python", 3)
        self.assertTrue(FakeDDGS.used)
        self.assertEqual(results, [("Python docs", "https://docs.python.org/3/", "official")])
        self.assertEqual(self.calls, [], "no HTTP of our own when the package answered")

    def test_without_the_package_the_html_endpoint_answers(self):
        with patch.dict(sys.modules, {"ddgs": None, "duckduckgo_search": None}), \
                patch.object(search_mod.requests, "post", self.post(html_text=HTML_PAGE)):
            results = search_mod._duckduckgo("python", 3)
        self.assertEqual(results[0][0], "Python docs")
        self.assertEqual(results[0][1], "https://docs.python.org/3/", "the redirect wrapper is unwrapped")
        self.assertEqual(self.calls, ["html"])

    def test_a_blocked_html_endpoint_falls_through_to_lite(self):
        with patch.dict(sys.modules, {"ddgs": None, "duckduckgo_search": None}), \
                patch.object(search_mod.requests, "post",
                             self.post(lite_text=LITE_PAGE, fail={"html"})):
            results = search_mod._duckduckgo("python", 3)
        self.assertEqual(self.calls, ["html", "lite"])
        self.assertEqual(results, [("Python docs", "https://docs.python.org/3/",
                                    "The official documentation")])

    def test_an_empty_html_page_also_falls_through(self):
        with patch.dict(sys.modules, {"ddgs": None, "duckduckgo_search": None}), \
                patch.object(search_mod.requests, "post",
                             self.post(html_text="<html>nothing</html>", lite_text=LITE_PAGE)):
            results = search_mod._duckduckgo("python", 3)
        self.assertEqual(self.calls, ["html", "lite"])
        self.assertEqual(len(results), 1)

    def test_a_broken_package_does_not_stop_the_chain(self):
        class Exploding(FakeDDGS):
            def text(self, query, max_results=6):
                raise RuntimeError("primp said no")
        module = types.ModuleType("ddgs")
        module.DDGS = Exploding                             # type: ignore[attr-defined]
        with patch.dict(sys.modules, {"ddgs": module}), \
                patch.object(search_mod.requests, "post", self.post(html_text=HTML_PAGE)):
            results = search_mod._duckduckgo("python", 3)
        self.assertEqual(results[0][0], "Python docs")

    def test_all_three_failing_says_what_to_do(self):
        with patch.dict(sys.modules, {"ddgs": None, "duckduckgo_search": None}), \
                patch.object(search_mod.requests, "post",
                             self.post(fail={"html", "lite"})):
            with self.assertRaises(search_mod.SearchError) as caught:
                search_mod._duckduckgo("python", 3)
        message = str(caught.exception)
        self.assertIn("/search brave", message)
        self.assertIn("html endpoint", message)
        self.assertIn("lite endpoint", message)
        self.assertIn("ConnectionError", message, "the user is told what actually failed")

    def test_the_provider_surface_reports_the_error_without_raising(self):
        with patch.dict(sys.modules, {"ddgs": None, "duckduckgo_search": None}), \
                patch.object(search_mod.requests, "post", self.post(fail={"html", "lite"})):
            out = search_mod.search("python", "duckduckgo")
        self.assertTrue(out.startswith("error: "), out)


class ToolProfileChoiceTest(unittest.TestCase):
    """Upgrading rewrites the old `adaptive` default once; a choice made after that is kept."""

    def test_the_old_default_migrates_once_and_a_later_choice_survives(self):
        import json
        import tempfile
        from dgc import config as config_mod
        home = Path(tempfile.mkdtemp(prefix="dgc-profile-home-"))
        project = Path(tempfile.mkdtemp(prefix="dgc-profile-project-"))
        (home / "config.json").write_text(json.dumps({"model": "m", "tool_profile": "adaptive"}))
        with patch.object(config_mod, "USER_CONFIG", home / "config.json"), \
                patch.object(config_mod, "USER_SECRETS", home / "secrets.json"):
            first = config_mod.Config(project)
            self.assertEqual(first.get("tool_profile"), "standard",
                             "the 0.41.7 default is not a choice")
            first.set("tool_profile", "adaptive")
            self.assertEqual(json.loads((home / "config.json").read_text())["tool_profile"],
                             "adaptive")
            self.assertEqual(config_mod.Config(project).get("tool_profile"), "adaptive",
                             "a chosen profile is kept")
            self.assertEqual(config_mod.Config(project).get("tool_profile"), "adaptive")


if __name__ == "__main__":
    unittest.main()
