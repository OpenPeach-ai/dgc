"""pips-12 and pips-18: a team file (256 KiB) or what a Grok bot wrote (64 KiB) reaches DGC as one string inside the
request. Its quotes and line ends are escaped on the way, so the request's size check allows for that, and a request that
is too big says so in KiB, never "0 MiB". The files' own size checks (pip_share.parse_team, parse_grok) keep their limits."""
import json
import unittest

from dgc.headless import _bounded_pips_command
from dgc.pip_import_sources import MAX_ANSWER
from dgc.pip_share import MAX_TEAM_BYTES
from dgc.workspace_registry import RegistryError


def team_text(size):
    """A team file's text near `size` bytes: indented JSON, every key quoted, many line ends."""
    pips, text = [], ""
    while True:
        pips.append({"format": "dgc-pip", "version": 1, "left_out": ["Memory stays with the original Pip."],
                     "pip": {"name": f"Pip {len(pips)}", "goal": "Watch the \"weekly\" numbers and say what changed.",
                             "pip_type": "lens", "scope": "personal", "schedule": None}})
        nxt = json.dumps({"format": "dgc-team", "version": 1, "name": "Ops", "pips": pips}, indent=2)
        if len(nxt.encode()) > size:
            return text
        text = nxt


class EscapedFilesFit(unittest.TestCase):
    def control(self, request):
        return _bounded_pips_command({"type": "pips_control", "request": {"request_id": "r1", **request}})

    def test_a_team_file_near_its_limit_fits(self):
        text = team_text(MAX_TEAM_BYTES - 1024)
        self.assertGreater(len(json.dumps(text)), MAX_TEAM_BYTES + 4096, "escaping makes it longer than the file")
        self.control({"type": "import_pip_team", "document": text})

    def test_a_grok_reply_near_its_limit_fits(self):
        line = 'He said "check the fares" every Monday.\n'
        text = line * ((MAX_ANSWER - 512) // len(line.encode()))
        self.assertGreater(len(json.dumps(text)), MAX_ANSWER + 4096)
        self.control({"type": "import_pip_source", "source": "grok", "text": text})

    def test_too_big_says_kib(self):
        for request in ({"type": "import_pip_team", "document": "x" * (3 * MAX_TEAM_BYTES)},
                        {"type": "import_pip_source", "source": "grok", "text": "x" * (3 * MAX_ANSWER)}):
            with self.subTest(kind=request["type"]), self.assertRaises(RegistryError) as caught:
                self.control(request)
            self.assertIn("KiB", str(caught.exception))
            self.assertNotIn("0 MiB", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
