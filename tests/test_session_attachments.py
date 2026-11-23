"""What you attached in Work sessions, in the Library (decided 16 Nov: "Work attachments in the Library" into 0.52).

The Library's Files listed ChatDGC's files only; a picture or a file you attached in a Work session was in that
session's transcript and nowhere else ("What you attach in a Work session stays in that session"). Now
list_session_attachments lists them from every project's sessions, the newest first: each picture (kept in the
transcript) and each file you named with @ (kept where it is, in its project), with its session and project; and
get_session_attachment gives one back: a picture's bytes, or a file's place on this computer, only inside its own project
and only from DGC's own session store. Offered as ready.capabilities.session_attachments."""
import base64
import json
import shutil
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import session_attachments as sa, sessions

PNG = ("data:image/png;base64," + base64.b64encode(
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89"
    b"\x00\x00\x00\rIDATx\x9cc\xf8\x0f\x00\x00\x01\x01\x00\x05\x18\xd8N\x00\x00\x00\x00IEND\xaeB`\x82").decode())


class Listed(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="dgc-attach-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.store = self.root / "sessions"
        self.store.mkdir()
        self.patches = [patch.object(sessions, "SESSIONS_DIR", self.store),
                        patch.object(sessions, "not_a_project", return_value=False)]
        for p in self.patches:
            p.start()
            self.addCleanup(p.stop)
        self.tiles = self.project("lime_tiles", {"billing/totals.py": "x = 1\n"})
        self.shop = self.project("shop", {"README.md": "# Shop\n"})

    def project(self, name, files):
        folder = self.root / name
        for rel, text in files.items():
            (folder / rel).parent.mkdir(parents=True, exist_ok=True)
            (folder / rel).write_text(text)
        return folder

    def session(self, project, sid, messages, name="", updated=None):
        bucket = self.store / sessions._slug(project.resolve())
        bucket.mkdir(parents=True, exist_ok=True)
        path = bucket / f"{sid}.json"
        path.write_text(json.dumps({"schema_version": 1, "id": sid, "project": str(project), "name": name,
                                    "updated": updated or time.time(), "messages": messages}))
        return path

    def test_pictures_and_named_files_from_every_projects_sessions_newest_first(self):
        old = self.session(self.tiles, "20261115-100000-aaaa1111", [
            {"role": "user", "content": [{"type": "text", "text": "Fix @billing/totals.py"},
                                         {"type": "image_url", "image_url": {"url": PNG}}],
             "_dgc_at": 1000.0, "_dgc_display_mentions": [{"start": 4, "kind": "file", "label": "totals.py",
                                                          "identity": "billing/totals.py"}]}],
            name="Fix the totals", updated=1000.0)
        self.session(self.shop, "20261116-090000-bbbb2222", [
            {"role": "user", "content": "Read @README.md", "_dgc_at": 2000.0,
             "_dgc_display_mentions": [{"start": 5, "kind": "file", "label": "README.md", "identity": "README.md"}]}],
            updated=2000.0)
        out = sa.listing()
        self.assertEqual([(i["kind"], i["name"]) for i in out["items"]],
                         [("file", "README.md"), ("file", "totals.py"), ("image", "Picture 1.png")])
        picture = out["items"][-1]
        self.assertEqual((picture["path"], picture["session_name"], picture["project_name"], picture["mime"]),
                         (str(old), "Fix the totals", "lime_tiles", "image/png"))
        self.assertEqual(out["total"], 3)
        self.assertEqual([i["name"] for i in sa.listing(query="totals")["items"]], ["totals.py"])

    def test_one_given_back_a_picture_as_its_bytes_a_file_as_its_place_in_its_project(self):
        path = self.session(self.tiles, "20261115-100000-aaaa1111", [
            {"role": "user", "content": [{"type": "text", "text": "Fix @billing/totals.py"},
                                         {"type": "image_url", "image_url": {"url": PNG}}],
             "_dgc_display_mentions": [{"start": 4, "kind": "file", "label": "totals.py", "identity": "billing/totals.py"}]}])
        items = {i["kind"]: i for i in sa.listing()["items"]}
        picture = sa.get(str(path), items["image"]["id"])
        self.assertEqual((picture["kind"], picture["data"]), ("image", PNG))
        file = sa.get(str(path), items["file"]["id"])
        self.assertEqual(file["file_path"], str((self.tiles / "billing/totals.py").resolve()))

    def test_nothing_outside_dgcs_session_store_or_a_files_own_project(self):
        path = self.session(self.tiles, "20261115-100000-aaaa1111", [
            {"role": "user", "content": "Read @../shop/README.md",
             "_dgc_display_mentions": [{"start": 5, "kind": "file", "label": "README.md", "identity": "../shop/README.md"}]}])
        self.assertEqual(sa.listing()["items"], [], "a mark that leaves its project isn't listed")
        with self.assertRaises(sa.AttachmentError):
            sa.get(str(path), "0:0")                          # nor given back
        stray = self.root / "elsewhere.json"
        stray.write_text(path.read_text())
        with self.assertRaises(sa.AttachmentError):
            sa.get(str(stray), "0:0")                         # not DGC's session store
        with self.assertRaises(sa.AttachmentError):
            sa.get(str(path), "9:9")                          # no such attachment

    def test_offered_and_known_to_the_protocol(self):
        from dgc.editor_protocol import COMMAND_FIELDS, EVENT_FIELDS
        for command in ("list_session_attachments", "get_session_attachment"):
            self.assertIn(command, COMMAND_FIELDS)
        for event in ("session_attachments", "session_attachment"):
            self.assertIn(event, EVENT_FIELDS)


if __name__ == "__main__":
    unittest.main()
