"""Showing the user a file the model produced.

The founder's case: "I ask the model to record a video and show me, and it shows me a chip I can
click." DGC could not do that. It could show an IMAGE -- as a thumbnail inside a collapsed tool
card -- and nothing else.

The design constraint that decided everything here: the event carries a PATH, never bytes. A
screen recording is hundreds of megabytes and the editor protocol's frame ceiling is 4 MiB, so
anything that tried to carry content would work in testing on a small file and fail on the exact
case that prompted the request. Codex reached the same answer: its file citations carry a path and
the editor opens it.

It also rules out the obvious alternative. Deriving chips from the turn's changed files cannot
work: chat_changes hashes what it tracks, capture_file_state raises above 1 MiB, and the file
lands in `skipped`. Every video is invisible to it. That is tested here too, so nobody rebuilds
this on that foundation later.
"""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dgc import tools                                        # noqa: E402


class ShowFile(unittest.TestCase):
    def setUp(self):
        self.work = Path(tempfile.mkdtemp())
        self.ctx = SimpleNamespace(project_root=str(self.work), tool_owner=self.id())

    def tearDown(self):
        tools.take_pending_files(self.id())

    def make(self, rel: str, size: int = 16) -> Path:
        path = self.work / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"\0" * size)
        return path

    def show(self, **args):
        return tools.show_file(args, self.ctx)

    def queued(self):
        return tools.take_pending_files(self.id())

    # ---- the case this exists for --------------------------------------------------

    def test_a_recording_far_past_the_frame_ceiling_still_chips(self):
        """300 MB is the point. Nothing here reads the file, so its size is irrelevant."""
        self.make("out/demo.mp4", size=300 * 1024 * 1024)
        answer = self.show(path="out/demo.mp4")
        self.assertNotIn("error", answer)
        [item] = self.queued()
        self.assertEqual(item["rel"], "out/demo.mp4")
        self.assertEqual(item["bytes"], 300 * 1024 * 1024)

    def test_nothing_queued_carries_bytes(self):
        """A content field would work on a README and blow the protocol frame on a video."""
        self.make("out/demo.mp4", size=2_000_000)
        self.show(path="out/demo.mp4")
        [item] = self.queued()
        self.assertEqual(set(item), {"name", "rel", "bytes", "caption"},
                         "the event is a path and its metadata; bytes never travel")

    def test_the_workspace_diff_could_not_have_done_this(self):
        """Why the obvious fallback was rejected, pinned so it is not rebuilt on that foundation.

        chat_changes reads every file it tracks to hash it, and refuses above 1 MiB.
        """
        from dgc.git_review import MAX_FILE_BYTES
        from dgc.workspace import capture_file_state
        big = self.make("out/demo.mp4", size=MAX_FILE_BYTES + 1)
        with self.assertRaises(OSError):
            capture_file_state(big, maximum=MAX_FILE_BYTES)

    # ---- refusals a model can act on -----------------------------------------------

    def test_a_missing_file_is_refused_not_chipped(self):
        answer = self.show(path="out/nope.mp4")
        self.assertTrue(answer.startswith("error:"))
        self.assertEqual(self.queued(), [], "never a chip for a file that is not there")

    def test_a_directory_is_refused(self):
        (self.work / "out").mkdir()
        self.assertIn("directory", self.show(path="out"))
        self.assertEqual(self.queued(), [])

    def test_an_empty_path_is_refused(self):
        self.assertTrue(self.show(path="   ").startswith("error:"))

    def test_a_file_outside_the_workspace_names_the_remedy(self):
        outside = Path(tempfile.mkdtemp()) / "x.bin"
        outside.write_bytes(b"x")
        answer = self.show(path=str(outside))
        self.assertTrue(answer.startswith("error:"))
        self.assertIn("outside this workspace", answer)
        self.assertIn("Copy it into the workspace", answer,
                      "a class name is not something a model can act on")
        self.assertEqual(self.queued(), [])

    def test_one_step_cannot_flood_the_transcript(self):
        for i in range(tools.MAX_SHOWN_FILES + 3):
            self.make(f"f{i}.txt")
            self.show(path=f"f{i}.txt")
        self.assertEqual(len(self.queued()), tools.MAX_SHOWN_FILES)

    # ---- the shape the frontends rely on -------------------------------------------

    def test_the_caption_reaches_the_chip(self):
        self.make("out/report.pdf")
        self.show(path="out/report.pdf", caption="the audit")
        self.assertEqual(self.queued()[0]["caption"], "the audit")

    def test_the_path_is_workspace_relative_and_posix(self):
        self.make("a/b/c.txt")
        self.show(path="a/b/c.txt")
        self.assertEqual(self.queued()[0]["rel"], "a/b/c.txt")

    def test_draining_is_once(self):
        self.make("x.txt")
        self.show(path="x.txt")
        self.assertEqual(len(self.queued()), 1)
        self.assertEqual(self.queued(), [], "a second drain must not repeat the chip")

    def test_the_tool_is_offered_and_executable(self):
        names = [f["function"]["name"] for f in tools.TOOL_SCHEMAS]
        self.assertIn("show_file", names)
        self.assertIn("show_file", tools.EXECUTORS)
        schema = next(f for f in tools.TOOL_SCHEMAS if f["function"]["name"] == "show_file")
        self.assertEqual(schema["function"]["parameters"]["required"], ["path"])
        self.assertIn("caption", schema["function"]["parameters"]["properties"])

    def test_the_answer_tells_the_model_not_to_paste_the_file_too(self):
        self.make("out/report.pdf")
        answer = self.show(path="out/report.pdf")
        self.assertIn("Do not also paste", answer,
                      "otherwise the model shows the chip AND dumps the contents into the reply")


class ProtocolShape(unittest.TestCase):
    def test_files_ready_is_declared(self):
        from dgc.editor_protocol import EVENT_FIELDS as EVENTS
        self.assertIn("files_ready", EVENTS)
        self.assertEqual(set(EVENTS["files_ready"]), {"call_id", "items", "caption"})

    def test_it_is_a_new_event_not_a_new_field(self):
        """A field added to an existing event makes the SDK refuse that event outright."""
        from dgc.editor_protocol import EVENT_FIELDS as EVENTS
        self.assertNotIn("items", EVENTS["tool_result"])
        self.assertNotIn("files", EVENTS["tool_result"])

    def test_the_capability_is_advertised(self):
        import inspect
        from dgc import headless
        source = inspect.getsource(headless.Backend.start)
        self.assertIn('"produced_files": True', source,
                      "a panel that cannot render chips must be able to tell it will not get them")


if __name__ == "__main__":
    unittest.main()
