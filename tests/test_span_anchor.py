"""An edit that swaps a whole region must not do it from a stale read.

`edit_file` matches in seven tiers. Six of them patch what is actually in the file, and they were
measured against a colleague's concurrent change:

    exact / normalized quotes / normalized line endings -> splice a located string; nothing to lose
    corroborated line drift  -> the colleague's line SURVIVED (the tier re-checks it)
    block anchor             -> refused outright
    elision                  -> the colleague's inserted line was GONE, reported as a clean success

The elision tier anchors on a head and a tail and replaces everything between them with `new`. When
`new` was composed from a read taken before someone else wrote the file, whatever arrived in between
is deleted, the tool reports "1 replacement(s)", and nothing tells anyone.

So the guard is deliberately narrow: only the tier that replaces a region, and only when the file
moved since the model read it. Widening it to the tiers proven safe above would buy nothing and
refuse legitimate edits. `write_file` already refuses wholesale on the same signal
(`tests/test_write_staleness.py`); this is the same rule for the one edit path that behaves like a
wholesale write.
"""
from __future__ import annotations

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

SETUP = ("def setup():\n"
         "    connect()\n"
         "    warm_cache()\n"
         "    prime_index()\n"
         "    return True\n")


def project(body: str = SETUP):
    root = Path(tempfile.mkdtemp(prefix="dgc-span-"))
    path = root / "h.py"
    path.write_text(body, encoding="utf-8")
    return path, SimpleNamespace(project_root=root, config=None,
                                 seen_versions={}, seen_lock=threading.RLock())


def run(name: str, args: dict, ctx) -> str:
    return tools.EXECUTORS[name](args, ctx)


ELIDED_OLD = "def setup():\n...\n    return True\n"
ELIDED_NEW = ("def setup(trace=False):\n    connect()\n    warm_cache()\n"
              "    prime_index()\n    return True\n")


class AnElidedEditIsRefusedAfterAForeignWriteTest(unittest.TestCase):
    def test_the_measured_loss_case_now_refuses(self) -> None:
        path, ctx = project()
        run("read_file", {"path": "h.py"}, ctx)
        path.write_text(SETUP.replace("    prime_index()\n",
                                      "    prime_index()\n    audit_log()   # colleague\n"),
                        encoding="utf-8")
        result = run("edit_file", {"path": "h.py", "old_string": ELIDED_OLD,
                                   "new_string": ELIDED_NEW}, ctx)
        self.assertTrue(result.startswith("error:"), result[:200])
        self.assertIn("changed after you read it", result)
        self.assertIn("audit_log", path.read_text(encoding="utf-8"),
                      "the colleague's line is exactly what this guard exists to keep")

    def test_the_message_names_the_way_out_and_it_works(self) -> None:
        path, ctx = project()
        run("read_file", {"path": "h.py"}, ctx)
        path.write_text(SETUP.replace("    prime_index()\n",
                                      "    prime_index()\n    audit_log()\n"), encoding="utf-8")
        refusal = run("edit_file", {"path": "h.py", "old_string": ELIDED_OLD,
                                    "new_string": ELIDED_NEW}, ctx)
        self.assertIn("Read the file again", refusal)
        run("read_file", {"path": "h.py"}, ctx)          # do what it says
        again = run("edit_file", {"path": "h.py", "old_string": "    connect()\n",
                                  "new_string": "    connect(timeout=5)\n"}, ctx)
        self.assertFalse(again.startswith("error:"), again[:200])

    def test_multi_edit_is_covered_too(self) -> None:
        path, ctx = project()
        run("read_file", {"path": "h.py"}, ctx)
        path.write_text(SETUP.replace("    prime_index()\n",
                                      "    prime_index()\n    audit_log()\n"), encoding="utf-8")
        result = run("multi_edit", {"path": "h.py", "edits": [
            {"old_string": ELIDED_OLD, "new_string": ELIDED_NEW}]}, ctx)
        self.assertIn("audit_log", path.read_text(encoding="utf-8"),
                      "multi_edit runs the same matcher and needs the same guard")


class EverythingElseStillAppliesTest(unittest.TestCase):
    """A guard that refuses a legitimate edit is worse than the bug it fixes."""

    def test_an_elided_edit_on_an_untouched_file(self) -> None:
        path, ctx = project()
        run("read_file", {"path": "h.py"}, ctx)
        result = run("edit_file", {"path": "h.py", "old_string": ELIDED_OLD,
                                   "new_string": ELIDED_NEW}, ctx)
        self.assertFalse(result.startswith("error:"), result[:200])
        self.assertIn("trace=False", path.read_text(encoding="utf-8"))

    def test_an_elided_edit_on_a_file_the_model_never_read(self) -> None:
        path, ctx = project()
        result = run("edit_file", {"path": "h.py", "old_string": ELIDED_OLD,
                                   "new_string": ELIDED_NEW}, ctx)
        self.assertFalse(result.startswith("error:"), result[:200])

    def test_a_located_edit_still_applies_after_a_foreign_write(self) -> None:
        """The tiers that patch what is there were measured to preserve the other writer's line."""
        path, ctx = project()
        run("read_file", {"path": "h.py"}, ctx)
        path.write_text(SETUP.replace("    prime_index()\n",
                                      "    prime_index(retry=3)   # colleague\n"), encoding="utf-8")
        result = run("edit_file", {"path": "h.py", "old_string": "    connect()\n",
                                   "new_string": "    connect(timeout=5)\n"}, ctx)
        self.assertFalse(result.startswith("error:"), result[:200])
        body = path.read_text(encoding="utf-8")
        self.assertIn("colleague", body, "a located splice keeps the other writer's line")
        self.assertIn("timeout=5", body)

    def test_dgc_own_edit_then_an_elided_edit(self) -> None:
        path, ctx = project()
        run("read_file", {"path": "h.py"}, ctx)
        run("edit_file", {"path": "h.py", "old_string": "    connect()\n",
                          "new_string": "    connect(timeout=5)\n"}, ctx)
        result = run("edit_file", {"path": "h.py", "old_string": "def setup():\n...\n    return True\n",
                                   "new_string": "def setup(trace=False):\n    connect(timeout=5)\n"
                                                 "    warm_cache()\n    prime_index()\n"
                                                 "    return True\n"}, ctx)
        self.assertFalse(result.startswith("error:"),
                         f"DGC's own write must refresh the anchor: {result[:180]}")

    def test_a_context_without_the_store_behaves_as_before(self) -> None:
        root = Path(tempfile.mkdtemp(prefix="dgc-span-"))
        (root / "h.py").write_text(SETUP, encoding="utf-8")
        bare = SimpleNamespace(project_root=root, config=None)
        self.assertFalse(run("read_file", {"path": "h.py"}, bare).startswith("error:"))
        (root / "h.py").write_text(SETUP + "extra()\n", encoding="utf-8")
        result = run("edit_file", {"path": "h.py", "old_string": ELIDED_OLD,
                                   "new_string": ELIDED_NEW}, bare)
        self.assertFalse(result.startswith("error:"),
                         "no store means no anchor; the guard must not invent one")


class TheGuardIsNarrowOnPurposeTest(unittest.TestCase):
    def test_only_the_region_replacing_tier_is_guarded(self) -> None:
        self.assertEqual(set(tools._SPAN_REPLACING_TIERS), {"elision"},
                         "the other tiers were measured preserving a concurrent change; guarding "
                         "them would refuse legitimate edits and buy nothing")


if __name__ == "__main__":
    unittest.main()
