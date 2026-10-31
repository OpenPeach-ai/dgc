"""Work's artifact tool keeps every publish of a page as a version of it, in the one artifact store.

The page is still served live from the project. What a version keeps is exactly what the server would serve: the
page and the files it links to, never the project's secrets, manifests or anything the page doesn't reach. Publishing
the same page again updates the same artifact (same address, same entry in the list) with a new version, and an
unchanged page makes no empty version.
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import dgc.artifacts as A
from dgc import artifact_store


def _write(path: Path, text) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(text if isinstance(text, bytes) else text.encode())
    return path


class PublishKeepsVersions(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(os.path.realpath(tempfile.mkdtemp(prefix="dgc-publish-")))
        self._env = os.environ.get("DGC_HOME")
        os.environ["DGC_HOME"] = str(self.tmp / "home")
        self._state, A.STATE_FILE = A.STATE_FILE, self.tmp / "artifacts.json"
        self.srv, A._SRV = A._SRV, A._Server(persistent=True)
        self.proj = self.tmp / "proj"
        _write(self.proj / ".env", "OPENAI_API_KEY=sk-never-kept\n")
        _write(self.proj / "package.json", '{"name": "proj"}')
        _write(self.proj / "src" / "server.py", "SECRET = 1\n")

    def tearDown(self):
        A._SRV.shutdown()
        A._SRV, A.STATE_FILE = self.srv, self._state
        if self._env is None:
            os.environ.pop("DGC_HOME", None)
        else:
            os.environ["DGC_HOME"] = self._env

    def test_a_publish_is_a_page_in_the_store_linked_to_the_project(self):
        _write(self.proj / "report" / "index.html", '<link rel="stylesheet" href="style.css"><h1>Q3</h1>')
        _write(self.proj / "report" / "style.css", "h1{color:#7C5CFF}")
        _write(self.proj / "report" / "notes.txt", "not linked")
        art, why = A.publish("report", self.proj, "Q3 report", preferred_port=5101)
        self.assertEqual(why, "")
        page = artifact_store.store().get(art.store_id)
        self.assertEqual((page.type, page.title, page.entry), ("page", "Q3 report", "index.html"))
        self.assertEqual(page.link["path"], str(self.proj / "report"))
        self.assertEqual(page.origin["surface"], "work")
        self.assertEqual(sorted(artifact_store.store().files(page.id)), ["index.html", "style.css"])

    def test_publishing_the_same_page_again_is_a_new_version_of_the_same_artifact(self):
        _write(self.proj / "report" / "index.html", "<h1>draft</h1>")
        first, _ = A.publish("report", self.proj, "Report", preferred_port=5101)
        port = first.port
        again, _ = A.publish("report", self.proj, "Report", preferred_port=5101)     # unchanged
        self.assertIs(again, first)
        self.assertEqual(artifact_store.store().get(first.store_id).version, 1)
        _write(self.proj / "report" / "index.html", "<h1>final</h1>")
        later, _ = A.publish("report/index.html", self.proj, "Report", preferred_port=5101)
        self.assertEqual((later.id, later.port), (first.id, port))
        self.assertEqual(len(A._SRV.list()), 1)
        store = artifact_store.store()
        self.assertEqual(store.get(first.store_id).version, 2)
        self.assertEqual(store.read_file(first.store_id, "index.html", 1), b"<h1>draft</h1>")
        self.assertEqual(store.read_file(first.store_id, "index.html"), b"<h1>final</h1>")

    def test_a_page_at_the_project_root_keeps_only_what_it_links_never_secrets(self):
        _write(self.proj / "index.html", '<script src="app.js"></script><h1>root</h1>')
        _write(self.proj / "app.js", "console.log(1)")
        art, _ = A.publish("index.html", self.proj, "Root page", preferred_port=5101)
        kept = artifact_store.store().files(art.store_id)
        self.assertEqual(sorted(kept), ["app.js", "index.html"])
        self.assertNotIn(b"sk-never-kept", b"".join(kept.values()))

    def test_a_late_symlink_swap_cannot_enter_a_saved_page_version(self):
        page = _write(self.proj / "report" / "index.html", '<link rel="stylesheet" href="style.css">')
        style = _write(page.parent / "style.css", "body{color:red}")
        original = A.resolve_request

        def swap_after_validation(art, rel):
            result = original(art, rel)
            if rel == "style.css" and result[0] is not None:
                style.unlink()
                style.symlink_to(self.proj / ".env")
            return result

        with patch.object(A, "resolve_request", side_effect=swap_after_validation):
            art, why = A.publish("report", self.proj, "Report", preferred_port=5101)
        self.assertFalse(art.store_id)
        self.assertIn("not versioned", why)

    def test_the_store_link_survives_a_restart(self):
        _write(self.proj / "report" / "index.html", "<h1>x</h1>")
        art, _ = A.publish("report", self.proj, "Report", preferred_port=5101)
        A._SRV.shutdown()
        reloaded = A._Server(persistent=True)
        self.assertEqual(reloaded.artifacts[art.id].store_id, art.store_id)
        reloaded.shutdown()


if __name__ == "__main__":
    unittest.main()
