"""A chat's editor roots: never the window's folders for a chat whose project is not among them.

The editor sends `set_workspace_roots` in every chat's handshake, and `dgc serve` turns each root
outside the chat's project into an `ExternalDirectory` allow. A chat opened in another folder was
sent the window's folders, so it could write into the window's project with no approval card while
a write to its own files still asked. The same roots replaced the folders the chat inspects, so its
"Changes in this chat" was always empty: its changes are recorded in its own folder.
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_subagents import HarnessCase  # noqa: E402


class ChatFolderRootsTests(HarnessCase):
    def roots(self, h, *paths) -> dict:
        h.backend.dispatch({"type": "set_workspace_roots", "roots": [str(p) for p in paths],
                            "request_id": f"roots-{len(paths)}"})
        return [e for e in h.of("workspace_roots")][-1]

    def elsewhere(self) -> Path:
        return Path(tempfile.mkdtemp(prefix="dgc-window-folder-")).resolve()

    def workspace_changes(self, h) -> dict:
        import time
        before = len(h.of("workspace_changes"))
        h.backend.dispatch({"type": "get_workspace_changes", "request_id": f"changes-{before}"})
        deadline = time.monotonic() + 20
        while len(h.of("workspace_changes")) == before and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertGreater(len(h.of("workspace_changes")), before, "no workspace_changes arrived")
        inspection = getattr(h.backend, "_editor_inspection", None)
        if inspection is not None:
            self.addCleanup(inspection.close)
        return h.of("workspace_changes")[-1]

    @staticmethod
    def spelled_out(roots) -> list[str]:
        """The roots as real paths: the event names the chat's own folder as it was given, and a
        temporary folder on macOS is given as /var/... while its real path is /private/var/..."""
        return [str(Path(root).resolve()) for root in roots]

    def test_a_chat_in_another_folder_is_granted_none_of_the_windows_folders(self):
        h = self.make(git=True)
        window = self.elsewhere()
        event = self.roots(h, window)
        self.assertEqual(h.backend.config.session_permissions["allow"], [],
                         "the window's folder became an allow rule for a chat in another folder")
        self.assertEqual(self.spelled_out(event["roots"]), [str(h.root.resolve())])

    def test_a_chat_in_another_folder_asks_before_writing_into_the_window(self):
        from dgc.permissions import ALLOW, PermissionEngine
        h = self.make(git=True)
        window = self.elsewhere()
        self.roots(h, window)
        config = h.backend.config
        rules = {action: [*(config.permissions.get(action, []) or []),     # as Agent builds it
                          *(config.session_permissions.get(action, []) or [])]
                 for action in ("allow", "ask", "deny")}
        decision, reason = PermissionEngine("default", rules, config.project_root).decide(
            "write_file", {"path": str(window / "ci.yml"), "content": "x"})
        self.assertNotEqual(decision, ALLOW, f"a write into the window's project needed no approval: {reason}")

    def test_a_chat_in_the_windows_folder_keeps_the_other_folders(self):
        h = self.make(git=True)
        other = self.elsewhere()
        event = self.roots(h, h.root, other)
        self.assertEqual(h.backend.config.session_permissions["allow"], [f"ExternalDirectory({other})"])
        self.assertEqual(self.spelled_out(event["roots"]), [str(h.root.resolve()), str(other)])

    def test_a_window_folder_that_holds_the_chats_project_is_its_workspace(self):
        h = self.make(git=True)
        h.backend.dispatch({"type": "set_workspace_roots", "roots": [str(h.root.parent)],
                            "request_id": "parent"})
        self.assertEqual(h.backend.config.session_permissions["allow"],
                         [f"ExternalDirectory({h.root.parent.resolve()})"])

    def test_a_chat_always_inspects_its_own_folder(self):
        h = self.make(git=True)
        window = self.elsewhere()
        self.roots(h, window)
        self.assertEqual(h.backend._editor_inspection_roots, [h.root.resolve()],
                         "the window's folder replaced the chat's own")
        other = self.elsewhere()
        self.roots(h, h.root, other)
        self.assertEqual(h.backend._editor_inspection_roots, [h.root.resolve(), other])


    def test_a_window_on_a_folder_inside_the_project_lists_that_folders_changes(self):
        # The window opened on a package of a larger repository: the chat's project is the
        # repository (DGC walks up to its .git), the editor's folder is the package. 0.46.4 listed
        # the package's pending changes. Scanning the project root instead swallowed the package (a
        # nested root is skipped), and the editor, which keeps only the report for its own folder,
        # said "pkg: no change report was returned".
        h = self.make(git=True)
        package = h.root / "pkg"
        package.mkdir()
        (package / "app.py").write_text("x = 1\n")
        self.roots(h, package)
        self.assertEqual(h.backend._editor_scan_roots, [package.resolve()])
        self.assertEqual(h.backend._editor_inspection_roots, [h.root.resolve(), package.resolve()],
                         "the chat's own folder stays inspectable: its changes are recorded there")
        report = self.workspace_changes(h)
        self.assertEqual(self.spelled_out(r["root"] for r in report["roots"]), [str(package.resolve())])
        self.assertEqual([f["path"] for f in report["roots"][0]["files"]], ["app.py"])

    def test_a_chat_in_another_folder_lists_its_own_folder(self):
        h = self.make(git=True)
        self.roots(h, self.elsewhere())
        self.assertEqual(h.backend._editor_scan_roots, [h.root.resolve()])


if __name__ == "__main__":
    import unittest
    unittest.main()
