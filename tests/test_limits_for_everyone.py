"""Limits for everyone (agreed 10 Nov): the ones that hurt are raised for every user, not only in Dev Mode.

The image library lists up to 100,000 images (it was the newest 5,000), and its index is trimmed rarely, never rewritten
on every new image; a saved login can be shared with any number of chosen Pips (it was 64); a project keeps 50,000 notes
(it was 5,000).
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


class Limits(unittest.TestCase):
    def test_the_raised_numbers(self):
        from dgc import images, notes, pip_logins
        from dgc.config import DEFAULTS
        self.assertEqual(images.LIBRARY_MAX, 100_000)
        self.assertGreaterEqual(pip_logins.MAX_PIPS, 10_000)
        self.assertEqual(notes.MAX_ROWS, 50_000)
        self.assertEqual(DEFAULTS["notes_max_rows"], 50_000)

    def test_the_library_index_is_trimmed_rarely_and_keeps_the_newest(self):
        from dgc import images
        folder = Path(tempfile.mkdtemp())
        writes = []
        real = Path.write_text
        def counting(self, *args, **kwargs):
            if self.name == "library.jsonl":
                writes.append(1)
            return real(self, *args, **kwargs)
        with patch.object(images, "LIBRARY_MAX", 4), patch.object(images, "LIBRARY_TRIM_BYTES", 600), \
                patch.object(Path, "write_text", counting):
            for n in range(40):
                images._index({"path": f"/x/{n}.png", "prompt": "p" * 20, "n": n}, folder=folder)
        kept = [json.loads(line)["n"] for line in (folder / "library.jsonl").read_text().splitlines()]
        self.assertEqual(kept[-1], 39, "the newest is always there")
        self.assertLessEqual(len(writes), 10, "trimmed now and then, not rewritten on every image")

    def test_a_saved_login_can_be_shared_with_a_hundred_pips(self):
        from dgc import pip_logins
        item = {"id": "login_" + "a" * 32, "site": "Bank", "username": "me", "password": "x", "hosts": ["bank.example"],
                "exact": False, "totp": None, "pips": ["pip_" + f"{n:032x}" for n in range(100)],
                "sign_in_page": "", "source": "card", "created_at": "2026-11-10T00:00:00Z", "updated_at": "2026-11-10T00:00:00Z"}
        self.assertTrue(pip_logins._valid_login(item), "a login shared with 100 chosen Pips is valid")


if __name__ == "__main__":
    unittest.main()
