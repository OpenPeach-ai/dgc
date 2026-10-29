import unittest

from dgc.chatdgc.research import Research


class BadSearchURLTests(unittest.TestCase):
    def test_malformed_ipv6_search_result_does_not_stop_research(self):
        results = [{"url": "https://[bad", "title": "Broken"},
                   {"url": "https://example.com/fact", "title": "Fact"}]
        state = {"question": "A fact", "plan": {"steps": ["Find fact"], "sites": []}}
        research = Research(None, state, client_for=lambda: None, room=16384,
                            search=lambda _query: results)
        self.assertEqual([page["url"] for page in research._candidates(["fact"])],
                         ["https://example.com/fact"])
