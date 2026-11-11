"""How much a Project Pip asks (0.52, pips-11, the user's 4 Nov message; D12): the same level chip as a Personal Pip's.

- Ask me first: as today, every handoff waits for your review.
- Approve for me: a read-only handoff (a review Pip looking at a finding) runs by itself, and so does a check whose
  exact commands you already approved once for that Pip.
- Do it all: a fix (Patch) runs by itself too, in its own copy; its diff waits as a card. A fix with a check you never
  approved still waits.
- Never, at any level: changing your project files, committing, pushing, or running a command nobody reviewed.

What its level did is listed on its page ("on its own"), and the old `level()` that Personal Pips' tools read stays
Ask for a Project Pip, so nothing a Personal Pip does changes.
"""
from __future__ import annotations

import hashlib
import json
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import pip_execution, pip_handoffs as handoffs, pip_levels as levels, pips
from dgc.workspace_registry import RegistryError, WorkspaceRegistry
from tests import test_pip_handoffs as base

CHECK = {"kind": "test", "tests": [{"argv": ["/usr/bin/python3", "-m", "unittest"], "cwd": "."}]}
OTHER_CHECK = {"kind": "test", "tests": [{"argv": ["/usr/bin/python3", "-m", "pytest"], "cwd": "."}]}
FIX = {"kind": "patch", "write_paths": ["source.py"], "tests": []}


class ProjectLevels(unittest.TestCase):
    # The handoff tests' fixtures, without their tests: a workspace, a reviewed source finding, a read-only target.
    git, commit = base.PipHandoffTests.git, base.PipHandoffTests.commit
    setup_source, propose, accept = base.PipHandoffTests.setup_source, base.PipHandoffTests.propose, base.PipHandoffTests.accept
    control = base.PipHandoffTests.control

    def setUp(self):
        base.fixtures.LocalPipsTests.setUp(self)
        capability = patch.object(pip_execution, "capability", return_value={"available": True})
        capability.start()
        self.addCleanup(capability.stop)
        self.setup_source()

    def tree(self):
        """Every file of the project, by hash: a level never changes one."""
        return {str(p.relative_to(self.root)): hashlib.sha256(p.read_bytes()).hexdigest()
                for p in sorted(Path(self.root).rglob("*")) if p.is_file() and ".git" not in p.parts}

    def job(self, pip_type, name=None):
        return self.store.create(self.workspace["id"], name or pip_type, "Reviewed isolated task", "device", pip_type=pip_type)

    def set_level(self, pip_id, value):
        return levels.set_level(self.registry, pip_id, value, "editor-user")

    def offer(self, target, action, key):
        proposed = self.propose(target_pip_id=target, action=action, idempotency_key=key)
        return handoffs.by_level(self.store, proposed, self.cfg) or handoffs.get(self.store, proposed["id"])

    # ------------------------------------------------------------------------------------------------
    def test_a_project_pip_has_a_level_with_its_own_lines_and_personal_tools_still_read_ask(self):
        shown = levels.listing(self.registry, self.target["id"])
        self.assertEqual(shown["level"], levels.ASK, "a new Project Pip asks, as today")
        self.assertEqual(shown["kind"], "project")
        self.assertEqual([row["name"] for row in shown["levels"]], ["Ask me first", "Approve for me", "Do it all"])
        for row in shown["levels"]:
            self.assertLessEqual(len(row["says"]), 160, row)
        self.assertIn("never", shown["levels"][2]["says"].lower(), "Do it all says what it never does")
        self.set_level(self.target["id"], levels.FULL)
        self.assertEqual(levels.listing(self.registry, self.target["id"])["level"], levels.FULL)
        self.assertEqual(levels.project_level(self.registry, self.target["id"]), levels.FULL)
        self.assertEqual(levels.level(self.registry, self.target["id"]), levels.ASK,
                         "what Personal Pips' sites, apps and sends read is unchanged for a Project Pip")
        with self.assertRaisesRegex(RegistryError, "Only you"):
            levels.set_level(self.registry, self.target["id"], levels.ASK, "device")

    def test_ask_me_first_leaves_every_handoff_for_you(self):
        handed = self.offer(self.target["id"], {"kind": "read_only"}, "ask-1")
        self.assertEqual(handed["status"], "pending")
        self.assertEqual(self.store.runs(self.target["id"]), [])

    def test_approve_for_me_runs_a_review_by_itself_and_says_so_on_its_page(self):
        before = self.tree()
        self.set_level(self.target["id"], levels.APPROVE)
        handed = self.offer(self.target["id"], {"kind": "read_only"}, "approve-1")
        self.assertEqual(handed["handoff"]["status"], "accepted")
        self.assertEqual(handed["handoff"]["resolved_by"], "pip-level:approve")
        self.assertEqual(handed["run"]["status"], "queued")
        self.assertEqual(handed["run"]["manifest"]["tools"], sorted(pips.READ_TOOLS), "read-only, as a reviewed one")
        own = levels.listing(self.registry, self.target["id"])["on_its_own"]
        self.assertEqual([(row["kind"], row["level"]) for row in own], [("handoff", "approve")])
        self.assertIn("Assess return value", own[0]["what"])
        self.assertEqual(self.tree(), before, "no project file changed")

    def test_approve_for_me_reruns_only_a_check_you_already_approved(self):
        pulse = self.job("pulse", "Checks")
        self.set_level(pulse["id"], levels.APPROVE)
        first = self.offer(pulse["id"], CHECK, "check-1")
        self.assertEqual(first["status"], "pending", "a command nobody reviewed waits, at every level")
        self.accept(first, actor="device")                  # you approve it once
        again = self.offer(pulse["id"], CHECK, "check-2")
        self.assertEqual(again["handoff"]["status"], "accepted", "the same commands again: by itself")
        other = self.offer(pulse["id"], OTHER_CHECK, "check-3")
        self.assertEqual(other["status"], "pending", "other commands: they wait")

    def test_a_fix_waits_at_approve_and_runs_in_its_copy_at_do_it_all(self):
        before = self.tree()
        fixer = self.job("patch", "Fixer")
        self.set_level(fixer["id"], levels.APPROVE)
        self.assertEqual(self.offer(fixer["id"], FIX, "fix-1")["status"], "pending")
        self.set_level(fixer["id"], levels.FULL)
        handed = self.offer(fixer["id"], {**FIX, "write_paths": ["source.py", "other.py"]}, "fix-2")
        self.assertEqual(handed["handoff"]["status"], "accepted")
        self.assertEqual(handed["handoff"]["resolved_by"], "pip-level:full")
        self.assertEqual(handed["run"]["manifest"]["run_kind"], "patch", "a fix in its own copy, its diff a card")
        self.assertNotIn("bash", handed["run"]["manifest"]["tools"])
        self.assertEqual(self.tree(), before, "your files are untouched")
        tested = self.offer(fixer["id"], {**FIX, "tests": CHECK["tests"]}, "fix-3")
        self.assertEqual(tested["status"], "pending", "a fix with a check nobody reviewed waits, even at Do it all")

    def test_never_a_workflows_or_a_personal_handoff(self):
        self.set_level(self.target["id"], levels.FULL)
        proposed = self.propose(idempotency_key="flow-1", actor="pip-flow:flow_" + "a" * 32)
        self.assertIsNone(handoffs.by_level(self.store, proposed, self.cfg), "a workflow keeps its own review")
        self.assertEqual(handoffs.get(self.store, proposed["id"])["status"], "pending")

    def test_the_pips_page_and_the_chat_tool_hand_off_by_level(self):
        self.set_level(self.target["id"], levels.APPROVE)
        answered = self.control("propose_pip_handoff", source_run_id=self.source_run["id"], finding_index=0,
                                target_pip_id=self.target["id"], task="Investigate this finding.",
                                action={"kind": "read_only"}, idempotency_key="page-1")
        self.assertTrue(answered["ok"], answered)
        self.assertEqual(answered["result"]["handoff"]["status"], "accepted")
        self.assertEqual(answered["result"]["handoff"]["resolved_by"], "pip-level:approve")
        self.assertEqual(answered["result"]["run"]["id"], answered["result"]["handoff"]["run_id"])
