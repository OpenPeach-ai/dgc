import unittest
from types import SimpleNamespace

from dgc.mcp_remote import _allowed, _get_json


class MetadataRedirectTests(unittest.TestCase):
    def test_malformed_metadata_url_is_refused(self):
        self.assertFalse(_allowed("https://[broken"))

    def test_redirect_is_checked_before_following(self):
        class Session:
            def __init__(self):
                self.urls = []

            def get(self, url, **kwargs):
                self.urls.append(url)
                return SimpleNamespace(status_code=302, headers={"Location": "http://10.0.0.2/admin"},
                                       close=lambda: None)

        session = Session()
        self.assertIsNone(_get_json(session, "https://example.com/.well-known/openid-configuration"))
        self.assertEqual(session.urls, ["https://example.com/.well-known/openid-configuration"])
