"""`list_tasks` and `wait_tasks` must never appear in the `ready` event's tool list.

The trap is a compatibility one, and it fires on the day the CLI updates rather than the day the
code changes. `dgc serve` publishes every name in `TOOL_SCHEMAS` as `ready.tools`. An ALREADY
INSTALLED dgc-sdk whose `RuntimePolicy` sets `allow_tools` runs that list through
`_confirm_tools`, which raises `DGCUnsupportedError` for any name its own table does not know --
so putting a new runtime tool in `TOOL_SCHEMAS` kills every such embedder's session, and the
embedder has no way to fix it except to upgrade a pinned dependency.

So the supervision pair lives in its own list and reaches the model through
`Agent._tool_schemas`. `dgc/tools.py` names this file as the mutation guard for exactly that, and
for a while it named a file that did not exist. These tests are that guard: move either name into
`TOOL_SCHEMAS` and the first test fails, against the real installed SDK's real refusal path.

Nothing here sleeps or starts a child. The gate is called directly.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

PROJECT = Path(__file__).resolve().parents[1]
for extra in (PROJECT, PROJECT / "sdk" / "python"):
    if str(extra) not in sys.path:
        sys.path.insert(0, str(extra))

from dgc import tools                                         # noqa: E402
from dgc.agent import Agent                                   # noqa: E402

SUPERVISION = {fn["function"]["name"] for fn in tools.SUPERVISION_TOOL_SCHEMAS}


class WhereTheSchemasLiveTest(unittest.TestCase):
    def test_the_pair_exists_and_is_the_pair_the_docs_name(self):
        self.assertEqual(SUPERVISION, {"list_tasks", "wait_tasks"})

    def test_neither_name_is_published_in_ready_tools(self):
        """The invariant, against the real SDK's real refusal rather than a restatement of it."""
        published = [fn["function"]["name"] for fn in tools.TOOL_SCHEMAS]
        self.assertEqual(sorted(set(published) & SUPERVISION), [],
                         "a name in TOOL_SCHEMAS reaches ready.tools, and an installed dgc-sdk "
                         "with allow_tools set raises DGCUnsupportedError on a name it does not "
                         "know -- its session dies when the CLI updates, not when we change this")
        # The refusal path itself, not a restatement of it: this is the check an ALREADY INSTALLED
        # dgc-sdk runs against the `ready` event, so it is also the check a name added to
        # TOOL_SCHEMAS would walk into.
        from dgc_sdk import DGCUnsupportedError
        from dgc_sdk.policy import RuntimePolicy, SessionPlan
        plan = SessionPlan(env={}, requirement="off",
                           policy=RuntimePolicy(allow_tools=["read_file"]))
        plan._confirm_tools({"tools": published})   # today's list is accepted, as it must be
        for name in sorted(SUPERVISION):
            with self.subTest(name=name):
                with self.assertRaises(DGCUnsupportedError):
                    plan._confirm_tools({"tools": [*published, name]})

    def test_the_comment_names_this_file(self):
        # The comment was load-bearing and named a file that did not exist, so the guard it
        # promised was never run. Keep the promise checkable.
        source = (PROJECT / "dgc" / "tools.py").read_text(encoding="utf-8")
        self.assertIn("tests/test_task_supervision.py", source)


class WhoIsOfferedThePairTest(unittest.TestCase):
    """Three gates, and the request's wording is not one of them."""

    def gate(self, *, depth=0, jobs=None, waiting=False) -> bool:
        agent = SimpleNamespace(depth=depth, _detached_jobs=jobs or {},
                                _detached_result_waiting=lambda: waiting)
        return Agent._supervision_exposed.__get__(agent)()

    def test_nothing_running_and_nothing_unread_means_not_offered(self):
        self.assertFalse(self.gate())

    def test_a_live_background_child_makes_them_useful(self):
        self.assertTrue(self.gate(jobs={"sub-1": object()}))

    def test_so_does_a_result_nobody_has_read(self):
        self.assertTrue(self.gate(waiting=True))

    def test_a_child_is_never_offered_them(self):
        # `_run_subagent`'s detach gate is `depth == 0`, so a child's `background: true` runs
        # inline: at depth > 0 the pair could only ever be two schemas of pure cost.
        self.assertFalse(self.gate(depth=1, jobs={"sub-1": object()}, waiting=True))

    def test_a_session_whose_host_set_a_tool_allowlist_is_not_offered_them(self):
        """Fail closed. `ready.tools` cannot carry these names, so such a session cannot refuse
        them by name -- and a policy that could not have named a tool never silently receives it."""
        from unittest.mock import patch
        with patch("dgc.permissions.session_policy", return_value={"allow_tools": ["read_file"]}):
            self.assertFalse(self.gate(jobs={"sub-1": object()}, waiting=True))
        # And with no host policy the same agent is offered them, so the patch is what decided it.
        self.assertTrue(self.gate(jobs={"sub-1": object()}, waiting=True))


if __name__ == "__main__":
    unittest.main()
