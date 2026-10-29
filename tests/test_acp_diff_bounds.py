"""ACP diff projections must keep file reads within their display budget."""

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace


class ACPDiffBoundsTests(unittest.TestCase):
    def test_diff_uses_small_file_but_falls_back_for_large_file(self):
        from dgc.acp import _ACPUi
        notices = []
        server = SimpleNamespace(
            notify=lambda _method, params: notices.append(params["update"]),
            _safe_text=lambda value: value,
        )
        diff = "--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n"
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "file.txt"
            ui = _ACPUi(server, "session", Path(directory))
            ui.tool_call("edit_file", {"path": str(path)}, "small")
            path.write_text("new", encoding="utf-8")
            ui.tool_result("edit_file", diff, "small")
            self.assertEqual(notices[-1]["content"][0]["newText"], "new")

            ui.tool_call("edit_file", {"path": str(path)}, "large")
            with path.open("wb") as target:
                target.truncate(1_000_002)
            ui.tool_result("edit_file", diff, "large")
            self.assertEqual(notices[-1]["content"][0]["content"]["text"], diff)


if __name__ == "__main__":
    unittest.main()
