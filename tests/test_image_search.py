"""Image search, for the pictures ChatDGC shows above a reply: every provider's results come back the same shape
(what it is, the picture, a small copy to show, the page it's on and its site), only with an https small copy, and a
failure is a SearchError that says which provider failed."""
from __future__ import annotations

import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

PROJECT = Path(__file__).resolve().parents[1]
if str(PROJECT) not in sys.path:
    sys.path.insert(0, str(PROJECT))

import requests  # noqa: E402

from dgc import search  # noqa: E402


class _Response:
    def __init__(self, data):
        self.data = data

    def raise_for_status(self):
        pass

    def json(self):
        return self.data


class ImageSearchTests(unittest.TestCase):
    def test_duckduckgo_through_the_ddgs_package(self):
        asked = {}

        class DDGS:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def images(self, query, max_results, safesearch):
                asked.update(query=query, n=max_results, safe=safesearch)
                return [{"title": "Hagia Sophia Interior", "image": "https://cdn.example/full.jpg",
                         "thumbnail": "https://tse1.mm.bing.net/th?id=1", "url": "https://www.designboyo.com/topic/",
                         "height": "1113", "width": "1600", "source": "Bing"},
                        {"title": "No https copy", "image": "http://x.example/a.jpg", "thumbnail": "http://x.example/t",
                         "url": "https://x.example/"}]
        with patch.dict(sys.modules, {"ddgs": types.SimpleNamespace(DDGS=DDGS)}):
            found = search.images("Hagia Sophia interior", "duckduckgo")
        self.assertEqual(asked, {"query": "Hagia Sophia interior", "n": 8, "safe": "moderate"})
        self.assertEqual(found, [{"title": "Hagia Sophia Interior", "image": "https://cdn.example/full.jpg",
                                  "thumbnail": "https://tse1.mm.bing.net/th?id=1", "url": "https://www.designboyo.com/topic/",
                                  "site": "designboyo.com", "width": 1600, "height": 1113}],
                         "the one without an https small copy isn't shown")

    def test_brave_searxng_and_tavily_come_back_the_same_shape(self):
        brave = {"results": [{"title": "Red panda", "url": "https://zoo.example/red-panda", "thumbnail": {"src": "https://imgs.search.brave.com/t"},
                              "properties": {"url": "https://zoo.example/rp.jpg", "width": 800, "height": 600}}]}
        with patch.object(search.requests, "get", return_value=_Response(brave)) as get:
            found = search.images("red panda", "brave", api_key="k")
        self.assertEqual(get.call_args.args[0], "https://api.search.brave.com/res/v1/images/search")
        self.assertEqual(get.call_args.kwargs["params"]["safesearch"], "strict")
        self.assertEqual(found, [{"title": "Red panda", "image": "https://zoo.example/rp.jpg", "thumbnail": "https://imgs.search.brave.com/t",
                                  "url": "https://zoo.example/red-panda", "site": "zoo.example", "width": 800, "height": 600}])

        searx = {"results": [{"title": "Kingfisher", "url": "https://birds.example/kf", "img_src": "https://birds.example/kf.jpg",
                              "thumbnail_src": "//thumbs.example/kf", "resolution": "1024 × 768"}]}
        with patch.object(search.requests, "get", return_value=_Response(searx)) as get:
            found = search.images("kingfisher", "searxng", url="http://127.0.0.1:8888/")
        self.assertEqual((get.call_args.args[0], get.call_args.kwargs["params"]["categories"]), ("http://127.0.0.1:8888/search", "images"))
        self.assertEqual(found[0]["thumbnail"], "https://thumbs.example/kf")
        self.assertEqual((found[0]["width"], found[0]["height"], found[0]["site"]), (1024, 768, "birds.example"))

        tavily = {"images": [{"url": "https://pics.example/a.jpg", "description": "A pangolin"}, "https://pics.example/b.jpg"]}
        with patch.object(search.requests, "post", return_value=_Response(tavily)) as post:
            found = search.images("pangolin", "tavily", api_key="k")
        self.assertTrue(post.call_args.kwargs["json"]["include_images"])
        self.assertEqual([(x["title"], x["thumbnail"], x["url"], x["site"]) for x in found],
                         [("A pangolin", "https://pics.example/a.jpg", "https://pics.example/a.jpg", "pics.example"),
                          ("", "https://pics.example/b.jpg", "https://pics.example/b.jpg", "pics.example")],
                         "no page named: the picture is where Open page goes")

    def test_a_failure_says_which_provider_and_why(self):
        with patch.object(search.requests, "get", side_effect=requests.ConnectionError("down")):
            with self.assertRaisesRegex(search.SearchError, r"image search failed \(brave\): down"):
                search.images("x", "brave", api_key="k")
        with self.assertRaisesRegex(search.SearchError, "Brave needs an API key"):
            search.images("x", "brave")
        with self.assertRaisesRegex(search.SearchError, "empty image search query"):
            search.images("  ", "duckduckgo")

        class Broken:
            def __enter__(self):
                raise RuntimeError("TLS fingerprint\nrejected")

            def __exit__(self, *a):
                return False
        with patch.dict(sys.modules, {"ddgs": types.SimpleNamespace(DDGS=Broken)}):
            with self.assertRaisesRegex(search.SearchError, r"image search failed \(duckduckgo\): TLS fingerprint rejected"):
                search.images("x", "duckduckgo")


if __name__ == "__main__":
    unittest.main()
