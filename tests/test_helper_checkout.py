"""A helper in its own copy never changes the user's checkout silently.

Found in a real VS Code run (deepseek-v4.1-flash:cloud), twice. The parent started background
helpers whose briefs began "Project: /home/.../billing-app", the absolute path of the user's own
checkout. One helper, working in a Git worktree of its own, went to that path: once with
`multi_edit` on /home/.../billing-app/billing.py, once with `cd /home/.../billing-app && python3
<<'PY' ...`. Its own copy was untouched, so DGC reported "Sub-task '...' completed with no file
changes" and "integrated: no" over a change to the user's file.

These tests pin the three layers (dgc/helper_checkout.py): the brief names the copy, DGC's file
tools refuse a write into the user's checkout, and the report names what changed there.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dgc import helper_checkout                                     # noqa: E402
from dgc.config import Config                                       # noqa: E402
from dgc.llm import ChatResult, LLMClient, ToolCall                 # noqa: E402
from test_subagents import HarnessCase, Script, clone_fixture   # noqa: E402

BILLING = ('def total(lines):\n'
           '    result = 0\n'
           '    for quantity, unit_price in lines:\n'
           '        result += round(quantity * unit_price)\n'
           '    return result\n')


def git(root: Path, *args) -> str:
    return subprocess.run(["git", *args], cwd=root, check=True, capture_output=True,
                          text=True).stdout


def commit(root: Path, files: dict) -> None:
    for name, text in files.items():
        (root / name).write_text(text)
    git(root, "add", "-A")
    git(root, "commit", "-qm", "fixture")


def system_root(messages) -> Path:
    """The project root a child's system prompt names: its own copy, for an isolated child."""
    found = re.search(r"Project root \(cwd for all tools\): (.+)", str(messages[0].get("content")))
    assert found, "no project root line in the system prompt"
    return Path(found.group(1).strip())


class Recorder:
    """A scripted child: the first reply makes `calls` (a function of its own messages), the second
    ends with `summary`. Keeps what it saw."""

    def __init__(self, calls, summary="done", before=None):
        self.calls, self.summary, self.before = calls, summary, before
        self.messages = None
        self.results = []

    def __call__(self, messages, results, cancel):
        if self.messages is None:
            self.messages = list(messages)
        if not results:
            if self.before is not None:
                self.before()
            return ChatResult(tool_calls=list(self.calls(messages)))
        self.results = [str(r.get("content", "")) for r in results]
        return ChatResult(content=self.summary)

    @property
    def prompt(self) -> str:
        users = [m for m in self.messages if m.get("role") == "user"]
        return re.sub(r"\n\n<dgc-now>.*?</dgc-now>$", "", str(users[0].get("content", "")), flags=re.S)


class Case(HarnessCase):
    def make_repo(self, **config):
        h = self.make(git=True, mode="auto", **config)
        self.addCleanup(shutil.rmtree, h.root.parent / (h.root.name + "-worktrees"), True)
        commit(h.root, {"billing.py": BILLING, "notes.txt": "one\n"})
        return h

    def run_parent(self, h, routes, prompt, *, then=None):
        """Run the parent turn on a script; `then` runs while the script still answers, for a
        background helper that outlives the turn."""
        results = []

        def parent(messages, tool_results, cancel):
            if not tool_results:
                return ChatResult(tool_calls=[call for call in routes[0]])
            results.extend(str(r.get("content", "")) for r in tool_results)
            return ChatResult(content="parent done")

        script = [(prompt, parent), *routes[1:]]
        with patch.object(LLMClient, "chat", Script(script)), \
                patch.object(Config, "clone_for_root", clone_fixture):
            h.run(prompt, script)
            if then is not None:
                then()
        return results


# ------------------------------------------------------------------------------------ the brief ---
class TheBriefNamesTheCopyTest(Case):
    def test_the_users_checkout_root_becomes_the_copys_root_and_nothing_else_changes(self):
        h = self.make_repo()
        root = h.root.resolve()
        other = Path(tempfile.mkdtemp(prefix="dgc-not-the-checkout-"))
        self.addCleanup(shutil.rmtree, other, True)
        brief = (f"FIXER-1 Project: {root} (a small Python project, git repo).\n"
                 f"Edit {root}/billing.py and run `cd {root} && python3 -m pytest -q`.\n"
                 f"Leave {root}-old/x.py, {root}.bak and {other}/y.py alone; see file://{root}/README.md.")
        child = Recorder(lambda messages: [], "ok")
        self.run_parent(h, [[ToolCall("t1", "task", {"description": "fix", "prompt": brief})],
                            ("FIXER-1", child)], "parent: delegate")
        own = system_root(child.messages)
        self.assertNotEqual(own, root, "the child runs in its own copy")
        expected = (f"FIXER-1 Project: {own} (a small Python project, git repo).\n"
                    f"Edit {own}/billing.py and run `cd {own} && python3 -m pytest -q`.\n"
                    f"Leave {root}-old/x.py, {root}.bak and {other}/y.py alone; "
                    f"see file://{own}/README.md.")
        self.assertEqual(child.prompt, expected,
                         "only whole-path mentions of the user's checkout change, to the copy")
        system = str(child.messages[0]["content"])
        self.assertIn(f"This is your own copy of the user's project: {own}.", system)
        self.assertIn(f"The user's checkout, {root}, is not yours to change", system)
        self.assertIn("DGC brings your changes into the user's checkout itself", system)
        # What the parent wrote is the parent's: its own transcript keeps the call as made.
        call = next(m for m in h.agent.messages if m.get("role") == "assistant" and m.get("tool_calls"))
        self.assertIn(f"Project: {root} (", str(call["tool_calls"][0]["function"]["arguments"]))

    def test_map_paths_rules(self):
        user, own = "/w/app", "/w/.dgc/wt/app-task"
        self.assertEqual(helper_checkout.map_paths("cd /w/app && ls /w/app/src", [user], own),
                         "cd /w/.dgc/wt/app-task && ls /w/.dgc/wt/app-task/src")
        for untouched in ("/w/app2/x", "/w/app.py", "/x/w/app/y", "/w/apps", "w/app/x"):
            self.assertEqual(helper_checkout.map_paths(untouched, [user], own), untouched, untouched)
        self.assertEqual(helper_checkout.map_paths('"/w/app", (/w/app). /w/app:', [user], own),
                         f'"{own}", ({own}). {own}:')
        # A copy kept inside the user's checkout is the copy: its paths are left alone.
        inside = "/w/app/.dgc/worktrees/t"
        self.assertEqual(helper_checkout.map_paths(f"{inside}/a.py and /w/app/b.py", [user], inside),
                         f"{inside}/a.py and {inside}/b.py")

    def test_a_message_to_a_running_helper_names_its_copy_too(self):
        child = type("Child", (), {})()
        child._user_checkouts = (Path("/w/app"),)
        child.config = type("C", (), {"project_root": Path("/w/.dgc/wt/t")})()
        self.assertEqual(helper_checkout.hand_to(child, "also fix /w/app/b.py"),
                         "also fix /w/.dgc/wt/t/b.py")
        plain = type("Plain", (), {})()
        self.assertEqual(helper_checkout.hand_to(plain, "also fix /w/app/b.py"), "also fix /w/app/b.py")


# ------------------------------------------------------------------------------- the file tools ---
class FileToolsRefuseTheUsersCheckoutTest(Case):
    def test_every_file_tool_is_refused_into_the_users_checkout_with_the_copys_path(self):
        h = self.make_repo()
        root = h.root.resolve()
        target = root / "billing.py"

        def calls(messages):
            return [
                ToolCall("c1", "edit_file", {"path": str(target),
                                             "old_string": "round(quantity * unit_price)",
                                             "new_string": "quantity * unit_price"}),
                ToolCall("c2", "write_file", {"path": str(root / "new.py"), "content": "x = 1\n"}),
                ToolCall("c3", "multi_edit", {"path": str(target), "edits": [
                    {"old_string": "return result", "new_string": "return round(result)"}]}),
                ToolCall("c4", "apply_patch", {"path": str(target), "patch":
                    "@@ -1,1 +1,1 @@\n-def total(lines):\n+def total(rows):\n"}),
            ]
        child = Recorder(calls, "tried")
        results = self.run_parent(h, [[ToolCall("t1", "task", {"description": "fix",
                                                                "prompt": "FIXER-2 fix billing"})],
                                      ("FIXER-2", child)], "parent: delegate")
        own = system_root(child.messages)
        self.assertEqual(target.read_text(), BILLING, "the user's file was not touched")
        self.assertFalse((root / "new.py").exists())
        self.assertEqual(len(child.results), 4)
        for result, name in zip(child.results, ("billing.py", "new.py", "billing.py", "billing.py")):
            self.assertEqual(result, f"error: not changed: {root / name} is in the user's checkout, "
                             "which is not yours to change; make this edit in your own copy "
                             f"instead, at {own / name}.")
        self.assertIn("completed with no file changes", results[0], "nothing changed anywhere")

    def test_a_write_outside_every_checkout_is_still_recorded_in_the_parents_recovery_point(self):
        h = self.make_repo()
        scratch = Path(tempfile.mkdtemp(prefix="dgc-helper-scratch-"))
        self.addCleanup(shutil.rmtree, scratch, True)
        runner = scratch / "runner.sh"
        child = Recorder(lambda messages: [ToolCall("c1", "write_file", {
            "path": str(runner), "content": "echo hi\n"})], "wrote it")
        self.run_parent(h, [[ToolCall("t1", "task", {"description": "runner",
                                                     "prompt": "FIXER-3 write a runner"})],
                            ("FIXER-3", child)], "parent: delegate")
        self.assertTrue(child.results[0].startswith("wrote "), child.results)
        self.assertEqual(runner.read_text(), "echo hi\n")
        recorded = [path for point in h.agent.checkpoints.points for path in point["files"]]
        self.assertIn(str(runner.resolve()), recorded, "the parent's manager can take it back")


class ClaimRulesTest(unittest.TestCase):
    def setUp(self):
        base = Path(tempfile.mkdtemp(prefix="dgc-claim-")).resolve()
        self.addCleanup(shutil.rmtree, base, True)
        self.user = base / "app"
        self.own = base / "copies" / "app-task"
        (self.user / "src").mkdir(parents=True)
        (self.own / "src").mkdir(parents=True)
        self.base = base

    def agent(self, own=None, shared=()):
        agent = type("Agent", (), {})()
        agent._user_checkouts = (self.user,)
        agent._shared_dirs = list(shared)
        agent.config = type("C", (), {"project_root": own or self.own})()
        return agent

    def test_own_copy_relative_and_outside_paths_are_not_claimed(self):
        agent = self.agent()
        for path in ("src/a.py", str(self.own / "src" / "a.py"), "/tmp/x.sh", str(self.base / "elsewhere")):
            self.assertIsNone(helper_checkout.claim(agent, path), path)

    def test_dot_dot_and_a_link_into_the_users_checkout_are_claimed(self):
        agent = self.agent()
        sneaky = f"{self.own}/../../app/src/a.py"
        self.assertEqual(helper_checkout.claim(agent, sneaky), (self.own / "src" / "a.py", "user"))
        (self.own / "docs").symlink_to(self.user / "src")
        self.assertEqual(helper_checkout.claim(agent, "docs/a.py"), (self.own / "src" / "a.py", "user"),
                         "a link out of the copy is followed to where it really writes")

    def test_a_folder_the_user_shared_into_the_copy_stays_writable(self):
        (self.user / "node_modules").mkdir()
        (self.own / "node_modules").symlink_to(self.user / "node_modules")
        agent = self.agent(shared=["node_modules"])
        self.assertIsNone(helper_checkout.claim(agent, "node_modules/pkg/index.js"))

    def test_a_copy_inside_the_users_checkout_is_still_its_own(self):
        own = self.user / ".dgc" / "worktrees" / "t"
        own.mkdir(parents=True)
        agent = self.agent(own=own)
        self.assertIsNone(helper_checkout.claim(agent, str(own / "a.py")))
        self.assertEqual(helper_checkout.claim(agent, str(self.user / "a.py")), (own / "a.py", "user"))


# ------------------------------------------------------------------------- what the report says ---
class TheReportNamesShellChangesTest(Case):
    def test_a_shell_write_into_the_users_checkout_is_named_and_undoable(self):
        h = self.make_repo()
        root = h.root.resolve()
        script = ("import pathlib; p = pathlib.Path('billing.py'); "
                  "p.write_text(p.read_text().replace('round(quantity * unit_price)', 'quantity * unit_price'))")
        child = Recorder(lambda messages: [ToolCall("c1", "bash", {
            "command": f"cd {root} && {sys.executable} -c \"{script}\""})], "rounded once")
        results = self.run_parent(h, [[ToolCall("t1", "task", {"description": "Fix the rounding",
                                                                "prompt": "FIXER-4 fix rounding"})],
                                      ("FIXER-4", child)], "parent: delegate")
        self.assertIn("quantity * unit_price\n", (root / "billing.py").read_text(), "the shell did write it")
        out = results[0]
        self.assertNotIn("no file changes", out)
        self.assertIn("Sub-task 'Fix the rounding' completed. Its own copy holds no changes, so "
                      "nothing was integrated.", out)
        self.assertIn("While it ran, billing.py in the user's checkout changed outside its own copy, "
                      "at a moment one of its own commands was running, so it most likely changed "
                      "it directly.", out)
        self.assertIn("DGC put its earlier state in the recovery point, so Undo takes that change back.",
                      out)
        point = h.agent.checkpoints.points[-1]["files"]
        snapshot = point[str(root / "billing.py")]
        self.assertEqual(snapshot.data.decode(), BILLING, "the exact state from before the helper")
        self.assertEqual(h.agent.checkpoints.left_hash(str(root / "billing.py")),
                         __import__("hashlib").sha256((root / "billing.py").read_bytes()).hexdigest(),
                         "a later rewind recognises the helper's bytes and puts BILLING back")

    def test_a_file_that_was_already_changed_is_compared_with_its_own_bytes(self):
        h = self.make_repo()
        root = h.root.resolve()
        (root / "notes.txt").write_text("one\nmine, uncommitted\n")      # the user's own work
        child = Recorder(lambda messages: [ToolCall("c1", "bash", {
            "command": f"cd {root} && printf 'helper\\n' >> notes.txt"})], "noted")
        results = self.run_parent(h, [[ToolCall("t1", "task", {"description": "note",
                                                                "prompt": "FIXER-5 note"})],
                                      ("FIXER-5", child)], "parent: delegate")
        self.assertIn("notes.txt in the user's checkout changed outside its own copy", results[0])
        snapshot = h.agent.checkpoints.points[-1]["files"][str(root / "notes.txt")]
        self.assertEqual(snapshot.data.decode(), "one\nmine, uncommitted\n",
                         "the user's uncommitted bytes, as the helper's copy took them")

    def test_a_concurrent_change_by_the_parent_is_not_blamed_on_the_helper(self):
        h = self.make_repo()
        root = h.root.resolve()
        notices = []
        h.agent.on_detached_ended = notices.append
        scratch = Path(tempfile.mkdtemp(prefix="dgc-helper-marker-"))
        self.addCleanup(shutil.rmtree, scratch, True)
        started = scratch / "started"
        child = Recorder(lambda messages: [ToolCall("c1", "bash", {
            "command": f"touch {started} && sleep 1.5"})], "slept")

        def meanwhile():
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline and not started.exists():
                time.sleep(0.02)
            time.sleep(0.2)
            # The parent works in the user's checkout while the helper's own command runs: a shell
            # edit (its span overlaps the helper's) and a file tool write (DGC's own bytes).
            h.agent._handle_call(ToolCall("p1", "bash", {"command": "printf 'two\\n' >> notes.txt"}))
            h.agent._handle_call(ToolCall("p2", "write_file", {"path": "other.txt", "content": "parent\n"}))
            self.assertEqual((root / "notes.txt").read_text(), "one\ntwo\n")
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline and not notices:
                time.sleep(0.05)

        self.run_parent(h, [[ToolCall("t1", "task", {"description": "Review", "background": True,
                                                     "prompt": "FIXER-6 review"})],
                            ("FIXER-6", child)], "parent: delegate", then=meanwhile)
        self.assertTrue(notices, "the helper finished")
        out = notices[0]["message"]
        # Since the undo fixes (25 Oct) the parent's own shell command is looked at around it
        # (dgc/command_watch.py): its change to notes.txt is this chat's own work, as its file tool's
        # write to other.txt always was. It is in the parent's recovery point -- Git's copy, which Undo
        # puts back -- and the helper's report neither blames the helper for it nor calls it unknown.
        self.assertNotIn("most likely changed", out, "not blamed on the helper")
        self.assertNotIn("notes.txt", out, "the parent's own command's change is DGC's own work")
        self.assertNotIn("other.txt", out, "the parent's own file tool write is DGC's own work")
        self.assertFalse(notices[0]["integrated"])
        snapshot = h.agent.checkpoints.points[-1]["files"].get(str(root / "notes.txt"))
        self.assertIsNotNone(snapshot, "the parent's command's change is in the parent's recovery point")
        self.assertEqual(snapshot.data, b"one\n", "as Git's copy: exactly what it held before the command")


# --------------------------------------------------------------------------- unchanged and depth ---
class NonIsolatedAndNestedTest(Case):
    def test_a_helper_without_its_own_copy_is_unchanged(self):
        h = self.make(git=False, mode="auto")
        root = h.root.resolve()
        (root / "billing.py").write_text(BILLING)
        child = Recorder(lambda messages: [ToolCall("c1", "edit_file", {
            "path": str(root / "billing.py"), "old_string": "return result",
            "new_string": "return round(result)"})], "edited")
        results = self.run_parent(h, [[ToolCall("t1", "task", {
            "description": "fix", "prompt": f"FIXER-7 Project: {root}. Fix {root}/billing.py"})],
            ("FIXER-7", child)], "parent: delegate")
        self.assertEqual(child.prompt, f"FIXER-7 Project: {root}. Fix {root}/billing.py")
        self.assertNotIn("This is your own copy", str(child.messages[0]["content"]))
        self.assertIn("return round(result)", (root / "billing.py").read_text())
        self.assertIn("completed in the shared checkout", results[0])

    def test_a_helpers_own_helper_is_pointed_at_its_copy_and_refused_both_checkouts_above(self):
        h = self.make_repo(max_subagent_depth=2)
        root = h.root.resolve()
        seen = {}

        def level_one(messages):
            seen["one"] = system_root(messages)
            return [ToolCall("d1", "task", {"description": "deeper", "prompt":
                f"LEVEL-2 edit {seen['one']}/billing.py, not {root}/billing.py"})]

        def level_two(messages):
            seen["two"] = system_root(messages)
            return [ToolCall("e1", "write_file", {"path": str(seen["one"] / "billing.py"), "content": "x\n"}),
                    ToolCall("e2", "write_file", {"path": str(root / "billing.py"), "content": "x\n"})]

        first, second = Recorder(level_one, "level one done"), Recorder(level_two, "level two done")
        self.run_parent(h, [[ToolCall("t1", "task", {"description": "top", "prompt": f"LEVEL-1 in {root}"})],
                            ("LEVEL-1", first), ("LEVEL-2", second)], "parent: delegate")
        one, two = seen["one"], seen["two"]
        self.assertEqual(len({root, one, two}), 3, "three different checkouts")
        self.assertEqual(first.prompt, f"LEVEL-1 in {one}")
        self.assertEqual(second.prompt, f"LEVEL-2 edit {two}/billing.py, not {two}/billing.py")
        system = str(second.messages[0]["content"])
        self.assertIn(f"The user's checkout, {root}, is not yours to change", system)
        self.assertIn(f"Nor are the copies of the helpers that started you ({one})", system)
        self.assertEqual(second.results[0],
                         f"error: not changed: {one / 'billing.py'} is in the copy of the helper that "
                         "started you, which is not yours to change; make this edit in your own copy "
                         f"instead, at {two / 'billing.py'}.")
        self.assertEqual(second.results[1],
                         f"error: not changed: {root / 'billing.py'} is in the user's checkout, which "
                         "is not yours to change; make this edit in your own copy instead, at "
                         f"{two / 'billing.py'}.")
        self.assertEqual((root / "billing.py").read_text(), BILLING)

    def test_a_helpers_own_helper_lands_its_work_and_its_shell_change_goes_up_with_its_parents(self):
        """At depth 2 the grandchild's integration into its parent helper's copy used to fail
        outright -- "could not capture rewind checkpoint" -- because that helper's own checkpoint
        manager never has a recovery point. Its copy is disposable; its own integration records."""
        h = self.make_repo(max_subagent_depth=2)
        root = h.root.resolve()
        seen = {}

        def level_one(messages):
            seen["one"] = system_root(messages)
            return [ToolCall("d1", "task", {"description": "deeper", "prompt": "LEVEL-2 add deep.txt"})]

        def level_two(messages):
            return [ToolCall("e1", "write_file", {"path": "deep.txt", "content": "from the grandchild\n"}),
                    ToolCall("e2", "bash", {"command": f"cd {seen['one']} && printf 'two\\n' >> notes.txt"})]

        first, second = Recorder(level_one, "level one done"), Recorder(level_two, "level two done")
        results = self.run_parent(h, [[ToolCall("t1", "task", {"description": "top", "prompt": "LEVEL-1 go"})],
                                      ("LEVEL-1", first), ("LEVEL-2", second)], "parent: delegate")
        child_saw = first.results[0]
        self.assertIn("Sub-task 'deeper' completed and integrated 1 path(s): deep.txt.", child_saw)
        self.assertIn("notes.txt in your checkout changed outside its own copy", child_saw)
        self.assertIn("It is in your own copy now, so the change goes to the user with your own when "
                      "you finish.", child_saw)
        self.assertIn("Sub-task 'top' completed and integrated 2 path(s): deep.txt, notes.txt.", results[0])
        self.assertEqual((root / "deep.txt").read_text(), "from the grandchild\n")
        self.assertEqual((root / "notes.txt").read_text(), "one\ntwo\n")


if __name__ == "__main__":
    unittest.main()
