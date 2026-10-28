"""Ask DGC to fix, as a Pip's own chat on the Pips page sees it (Pips API 65).

Reported 24 Oct: "when in chat we do Ask DGC to fix for a Pip card, and it gets fixed, the Pips page, for that
Pip under chat, its card still gives an option 'Ask DGC to fix'. Should its status also get updated as fixed?" Yes.
The fix runs in a Work chat (dgc/pip_fix.py) and keeps its record on disk, per project; list_pip_run_fixes {pip_id}
reads the latest fix of each of the Pip's runs from there, so the run's post can say fixing, Fixed, failed or undone,
and says the same after a window reload or a restart of the runner.

A real Backend runs a real fix (only the model is scripted), and the Pips page's read goes through the real control
seam the editor and the SDKs use.
"""
from __future__ import annotations

import os
import time
import unittest
import uuid
from unittest.mock import patch

from dgc import pip_fix, pips
from dgc.headless import PIPS_API_VERSION
from dgc.llm import LLMClient
from dgc.workspace_registry import WorkspaceRegistry
from tests.test_pip_fix import FixScene, fixer, wait_for
from tests.test_subagents import Script


class PipsPageFixTests(FixScene):
    def control(self, request, actor="editor-user"):
        return pips.handle_control(self.cfg, {"request_id": "r1", **request}, actor, start_worker=False)

    def page(self, pip=None):
        answer = self.control({"type": "list_pip_run_fixes", "pip_id": (pip or self.pip)["id"]})
        self.assertTrue(answer["ok"], answer)
        return answer["result"]

    def test_the_pips_page_reads_a_runs_fix_while_it_works_when_it_is_fixed_and_once_undone(self):
        backend = self.make()
        run = self.report(backend)
        self.assertEqual(self.page(), {"pip_id": self.pip["id"], "workspace_id": self.workspace["id"], "fixes": []},
                         "not asked yet: the post offers Ask DGC to fix")
        midway = []
        edits = {"app/gst.py": "def total(x):\n    return x * 118 // 100\n", "app/billing.py": "RATE = 2\n"}
        with patch.object(LLMClient, "chat", Script([("Fix what Pip", fixer(edits, before_final=lambda: midway.append(self.page())))])):
            self.start(backend, run)
            ended = self.ended(run)
        self.assertEqual(ended["state"], "applied")
        [working] = midway[0]["fixes"]
        self.assertEqual((working["run_id"], working["state"]), (run, "running"), "while it works: DGC is fixing this")
        [fixed] = self.page()["fixes"]
        self.assertEqual((fixed["fix_id"], fixed["run_id"], fixed["state"]), (ended["fix_id"], run, "applied"))
        self.assertEqual(sorted(f["path"] for f in fixed["files"]), ["app/billing.py", "app/gst.py"], "Fixed · 2 files")
        self.assertEqual(fixed["undo"], {"state": "available"})
        self.assertEqual(fixed["session_id"], self.session, "the Work chat it ran in, where its Undo is")
        for private in ("owner", "agent_id", "pip_id", "name", "deps", "step"):
            self.assertNotIn(private, fixed)
        # A window reload, or the runner started again: a new registry and a new read, from what is on disk.
        with WorkspaceRegistry() as again:
            self.assertEqual(pip_fix.for_pip(again.binding(self.workspace["id"])["canonical_root"], self.pip["id"]),
                             [fixed])
        backend.dispatch({"type": "undo_pip_fix", "fix_id": fixed["fix_id"], "request_id": "undo-1"})
        wait_for(lambda: any(f.get("request_id") == "undo-1" for f in self.wire.of("pip_fix")), what="the undo")
        [undone] = self.page()["fixes"]
        self.assertEqual(undone["state"], "undone", "undone: back to Ask DGC to fix")
        self.assertEqual(undone["undo"]["state"], "done")

    def test_the_latest_fix_of_each_run_wins_and_one_whose_process_stopped_reads_interrupted(self):
        project = pip_fix.FixProject(self.root)
        run, other_run = "run_" + "1" * 32, "run_" + "2" * 32
        stamp = time.time()

        def record(run_id, state, at, pip_id=None, **extra):
            project.put({"fix_id": "fix_" + uuid.uuid4().hex, "session_id": "chat-erp", "run_id": run_id,
                         "pip_id": pip_id or self.pip["id"], "name": "ERP daily audit", "state": state,
                         "created_at": at, **extra})

        record(run, "failed", stamp - 60, message="The fix didn't finish: the model stopped.")
        record(run, "running", stamp, owner={"pid": 2 ** 22 + 12345, "token": "another-process"})
        record(other_run, "applied", stamp - 30, files=[{"path": "app/gst.py", "kind": "edited"}])
        record("run_" + "3" * 32, "applied", stamp, pip_id="pip_" + "f" * 32)          # another Pip's
        fixes = self.page()["fixes"]
        self.assertEqual([(f["run_id"], f["state"]) for f in fixes], [(run, "interrupted"), (other_run, "applied")],
                         "one per run, the newest; another Pip's fix is not this Pip's")
        self.assertIn("Nothing in your project was changed", fixes[0]["message"])

    def test_a_personal_pip_has_none_and_another_device_is_refused(self):
        personal = self.store.create(self.registry.personal()["id"], "Planner", None, "editor-user", pip_type="lens")
        self.assertEqual(self.page(personal)["fixes"], [])
        refused = self.control({"type": "list_pip_run_fixes", "pip_id": self.pip["id"]}, actor="device-phone")
        self.assertEqual(refused["error"]["code"], "local_only")
        extra = self.control({"type": "list_pip_run_fixes", "pip_id": self.pip["id"], "run_id": "run_" + "1" * 32})
        self.assertFalse(extra["ok"], "only pip_id")

    def test_the_api_says_the_pips_page_can_read_fixes(self):
        self.assertGreaterEqual(PIPS_API_VERSION, 65)
        self.assertIn("list_pip_run_fixes", pips.CONTROL_COMMANDS)
        self.assertEqual(pips._COMMAND_ARGS["list_pip_run_fixes"], {"pip_id"})


class SDKGateTests(unittest.TestCase):
    """Both SDKs know list_pip_run_fixes; the Python one refuses it before Pips API 65, without a request (the
    TypeScript one: tests/test_dgc_sdk_pip_run_fixes.mjs)."""

    def test_python_sdk_refuses_it_before_api_65_and_sends_its_field(self):
        from tests.test_dgc_sdk_pips import CAPS, Wire, session      # puts sdk/python on the path first
        from dgc_sdk import DGCUnsupportedError
        from dgc_sdk.pips import COMMAND_FIELDS, READ_COMMANDS
        self.assertEqual(COMMAND_FIELDS["list_pip_run_fixes"], pips._COMMAND_ARGS["list_pip_run_fixes"])
        self.assertIn("list_pip_run_fixes", READ_COMMANDS)
        wire = Wire()
        old = session(wire, caps={**CAPS, "pips_api_version": 64})
        with self.assertRaisesRegex(DGCUnsupportedError, "API 65"):
            old.pips.run_fixes("pip_rook")
        self.assertFalse(wire.calls)
        current = session(wire, caps={**CAPS, "pips_api_version": 65})
        answer = current.pips.run_fixes("pip_rook")
        self.assertEqual((answer["request"]["type"], answer["request"]["pip_id"]), ("list_pip_run_fixes", "pip_rook"))


if __name__ == "__main__":
    unittest.main()
