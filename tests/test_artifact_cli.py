"""`dgc artifacts` from the terminal: list, show, open, export, restore and remove, with no model and no session."""
from __future__ import annotations

import os
import io
import threading
from concurrent.futures import ThreadPoolExecutor, TimeoutError
from contextlib import redirect_stderr
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dgc import artifact_cli, artifact_service as S


class ArtifactCli(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(os.path.realpath(tempfile.mkdtemp(prefix="dgc-artcli-")))
        self._env = os.environ.get("DGC_HOME")
        os.environ["DGC_HOME"] = str(self.tmp)
        self.doc = S.make("doc", "Launch plan", "# Launch\n\nShip Friday.\n", origin={"surface": "work"})
        S.edit(self.doc["id"], content="# Launch\n\nShip Monday.\n")

    def tearDown(self):
        if self._env is None:
            os.environ.pop("DGC_HOME", None)
        else:
            os.environ["DGC_HOME"] = self._env

    def run_cli(self, *args):
        lines = []
        code = artifact_cli.main(list(args), out=lines.append)
        return code, "\n".join(lines)

    def test_list_show_and_the_versions(self):
        code, text = self.run_cli()
        self.assertEqual(code, 0)
        self.assertIn("Launch plan", text)
        self.assertIn("v2", text)
        code, text = self.run_cli("show", self.doc["id"])
        self.assertIn("Made", text)
        self.assertIn("exports: docx, pdf, md", text)
        self.assertEqual(self.run_cli("list", "--type", "design")[0], 2)

    def test_export_to_a_folder_and_restore(self):
        out = self.tmp / "out"
        out.mkdir()
        code, text = self.run_cli("export", self.doc["id"], "md", "--to", str(out))
        self.assertEqual((out / "Launch plan.md").read_text(), "# Launch\n\nShip Monday.\n")
        code, text = self.run_cli("restore", self.doc["id"], "1")
        self.assertIn("as version 3", text)

    def test_open_writes_its_page_and_opens_the_file(self):
        with patch("webbrowser.open", return_value=True) as opened:
            code, text = self.run_cli("open", self.doc["id"])
        self.assertEqual(code, 0)
        url = opened.call_args[0][0]
        self.assertTrue(url.startswith("file://") and url.endswith("/view/index.html"), url)
        self.assertIn("<h1>Launch</h1>", Path(url[len("file://"):]).read_text())

    def test_two_opens_do_not_remove_each_others_staging_files(self):
        wrote = threading.Event()
        release = threading.Event()
        started = threading.Event()
        original = Path.write_bytes
        first = True
        guard = threading.Lock()
        def write(path, data):
            nonlocal first
            result = original(path, data)
            with guard:
                hold, first = first, False
            if hold:
                wrote.set()
                if not release.wait(5):
                    raise TimeoutError("first preview was not released")
            return result
        def second_open():
            started.set()
            return self.run_cli("open", self.doc["id"])
        with patch("webbrowser.open", return_value=True), patch.object(Path, "write_bytes", write), ThreadPoolExecutor(2) as pool:
            a = pool.submit(self.run_cli, "open", self.doc["id"])
            try:
                self.assertTrue(wrote.wait(3))
                b = pool.submit(second_open)
                self.assertTrue(started.wait(3))
                try:
                    b.result(timeout=.5)
                except TimeoutError:
                    pass
            finally:
                release.set()
            self.assertEqual(a.result(timeout=3)[0], 0)
            self.assertEqual(b.result(timeout=3)[0], 0)
        folder = S._store(None)._dir(self.doc["id"])
        self.assertIn("Ship Monday", (folder / "view" / "index.html").read_text())
        self.assertFalse(list(folder.glob(".view-*")))

    def test_unwritable_export_returns_a_cli_error_without_a_traceback(self):
        errors = io.StringIO()
        with redirect_stderr(errors), patch.object(artifact_cli.shutil, "copyfile", side_effect=PermissionError("destination is read-only")):
            code, _ = self.run_cli("export", self.doc["id"], "md", "--to", str(self.tmp / "result.md"))
        self.assertEqual(code, 1)
        self.assertIn("destination is read-only", errors.getvalue())

    def test_remove_goes_to_the_trash_and_a_bad_id_says_so(self):
        code, text = self.run_cli("rm", self.doc["id"])
        self.assertIn("trash", text)
        self.assertEqual(self.run_cli("show", self.doc["id"])[0], 1)


if __name__ == "__main__":
    unittest.main()
