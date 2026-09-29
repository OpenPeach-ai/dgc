"""`write_file` must not discard a save somebody made while the model was composing.

`write_file` replaces a file wholesale with content the model built from what it read. If anyone
saved that file in between — the user in their editor, another tool, a peer DGC — their work is
gone, silently, and the tool reports success.

The existing guard does not cover this and was never meant to. `write_file` reads the file to build
its own `expected` FileVersion *microseconds before* it writes, which closes a TOCTOU race inside
the tool; a save made seconds earlier is already inside that read. Measured before the fix:

    edit_file   -> the other writer's line SURVIVED   (a targeted replacement patches what is there)
    write_file  -> the other writer's line was LOST

So the anchor is taken where the model actually looked: `read_file` records the version it showed
the model, and `write_file` refuses if the file has moved since. DGC's own writes refresh the
anchor, so its `edit_file` never makes its next `write_file` look foreign.

This is DGC's form of the staleness check Grok Build does with a hashline anchor, adapted to a tool
that replaces whole files rather than lines -- but the two differ on what happens next, and the
earlier version of this comment had Grok's half backwards. Grok returns FRESH ANCHORS and says
outright "Use these anchors to immediately retry your edit -- do not re-read the file"
(xai-org/grok-build, crates/codegen/xai-grok-tools/src/implementations/grok_build_hashline/edit/mod.rs,
"Follow-up edits"). DGC refuses and asks for a re-read, because a whole-file write has no anchor to
hand back. Cheaper for Grok; the two are not the same contract.

A file the model never read is one it is creating or deliberately replacing. Those are not refused.
"""
from __future__ import annotations

import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace

PROJECT = Path(__file__).resolve().parents[1]
if str(PROJECT) not in sys.path:
    sys.path.insert(0, str(PROJECT))

from dgc import tools                                            # noqa: E402

BODY = "".join(f"line {n}\n" for n in range(10))


def context() -> tuple[Path, SimpleNamespace]:
    """A project and the tool context shape the agent really passes."""
    root = Path(tempfile.mkdtemp(prefix="dgc-stale-"))
    return root, SimpleNamespace(project_root=root, config=None,
                                 seen_versions={}, seen_lock=threading.RLock())


def run(name: str, args: dict, ctx) -> str:
    return tools.EXECUTORS[name](args, ctx)


class AForeignSaveIsRefusedTest(unittest.TestCase):
    def test_a_save_between_the_read_and_the_write_is_not_overwritten(self) -> None:
        root, ctx = context()
        (root / "f.py").write_text(BODY, encoding="utf-8")
        run("read_file", {"path": "f.py"}, ctx)
        (root / "f.py").write_text(BODY + "SOMEBODY ELSE SAVED THIS\n", encoding="utf-8")

        result = run("write_file", {"path": "f.py", "content": "the model's whole file\n"}, ctx)
        self.assertTrue(result.startswith("error:"), result[:160])
        self.assertIn("changed after you read it", result)
        self.assertIn("SOMEBODY ELSE SAVED THIS", (root / "f.py").read_text(encoding="utf-8"),
                      "the refusal must leave their work exactly where it was")

    def test_the_message_names_the_way_out_and_it_works(self) -> None:
        root, ctx = context()
        (root / "f.py").write_text(BODY, encoding="utf-8")
        run("read_file", {"path": "f.py"}, ctx)
        (root / "f.py").write_text(BODY + "theirs\n", encoding="utf-8")
        refusal = run("write_file", {"path": "f.py", "content": "mine\n"}, ctx)
        self.assertIn("Read it again", refusal)
        self.assertIn("edit_file", refusal, "the other route out must be named too")

        run("read_file", {"path": "f.py"}, ctx)          # do what the message says
        again = run("write_file", {"path": "f.py", "content": "mine\n"}, ctx)
        self.assertFalse(again.startswith("error:"), again[:160])
        self.assertEqual((root / "f.py").read_text(encoding="utf-8"), "mine\n")

    def test_edit_file_needs_no_guard_because_it_patches_what_is_there(self) -> None:
        root, ctx = context()
        (root / "f.py").write_text(BODY, encoding="utf-8")
        run("read_file", {"path": "f.py"}, ctx)
        (root / "f.py").write_text(BODY.replace("line 9", "THEIRS"), encoding="utf-8")
        result = run("edit_file", {"path": "f.py", "old_string": "line 2",
                                   "new_string": "line 2 MINE"}, ctx)
        self.assertFalse(result.startswith("error:"), result[:160])
        body = (root / "f.py").read_text(encoding="utf-8")
        self.assertIn("THEIRS", body, "a targeted replacement keeps the other writer's line")
        self.assertIn("line 2 MINE", body)


class EverythingElseStillWritesTest(unittest.TestCase):
    """A guard that refuses a legitimate write is worse than the bug it fixes."""

    def test_a_file_the_model_never_read(self) -> None:
        root, ctx = context()
        result = run("write_file", {"path": "new.py", "content": "fresh\n"}, ctx)
        self.assertFalse(result.startswith("error:"), result[:160])

    def test_a_file_the_model_read_that_nobody_touched(self) -> None:
        root, ctx = context()
        (root / "f.py").write_text(BODY, encoding="utf-8")
        run("read_file", {"path": "f.py"}, ctx)
        result = run("write_file", {"path": "f.py", "content": "rewritten\n"}, ctx)
        self.assertFalse(result.startswith("error:"), result[:160])

    def test_two_writes_in_a_row(self) -> None:
        root, ctx = context()
        (root / "f.py").write_text(BODY, encoding="utf-8")
        run("read_file", {"path": "f.py"}, ctx)
        run("write_file", {"path": "f.py", "content": "one\n"}, ctx)
        result = run("write_file", {"path": "f.py", "content": "two\n"}, ctx)
        self.assertFalse(result.startswith("error:"),
                         f"DGC's own previous write must not read as a foreign save: {result[:140]}")

    def test_an_edit_then_a_write(self) -> None:
        root, ctx = context()
        (root / "f.py").write_text(BODY, encoding="utf-8")
        run("read_file", {"path": "f.py"}, ctx)
        run("edit_file", {"path": "f.py", "old_string": "line 1", "new_string": "line 1 X"}, ctx)
        result = run("write_file", {"path": "f.py", "content": "after the edit\n"}, ctx)
        self.assertFalse(result.startswith("error:"),
                         f"DGC's own edit_file must refresh the anchor: {result[:140]}")

    def test_a_context_without_the_store_behaves_as_before(self) -> None:
        """Every duck-typed ctx in the suites, and any embedder's own, lacks these fields."""
        root = Path(tempfile.mkdtemp(prefix="dgc-stale-"))
        bare = SimpleNamespace(project_root=root, config=None)
        (root / "f.py").write_text(BODY, encoding="utf-8")
        self.assertFalse(run("read_file", {"path": "f.py"}, bare).startswith("error:"))
        (root / "f.py").write_text("moved\n", encoding="utf-8")
        result = run("write_file", {"path": "f.py", "content": "mine\n"}, bare)
        self.assertFalse(result.startswith("error:"),
                         "no store means no anchor; the guard must not invent one")


class TheAgentCarriesTheStoreTest(unittest.TestCase):
    def test_agent_context_declares_the_fields(self) -> None:
        # The guard is dead code unless the object the agent really passes carries them.
        import dataclasses
        from dgc.agent import AgentContext
        names = {f.name for f in dataclasses.fields(AgentContext)}
        self.assertIn("seen_versions", names)
        self.assertIn("seen_lock", names)


if __name__ == "__main__":
    unittest.main()
