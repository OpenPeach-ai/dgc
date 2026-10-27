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


# ------------------------------------------------------------------------------------ the reads ---
# A terminal review helper, in a copy of its own, searched up the tree into other scratch folders:
# only its brief asked it not to. DGC's own read and search tools now read only its copy.
PNG_1X1 = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
    "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082")


def in_copy(path, own) -> str:
    return f"Read {own / path} instead: this helper works in its own copy."


class ReadToolsStayInTheCopyTest(Case):
    def test_each_read_tool_refuses_the_users_checkout_and_names_the_copys_path(self):
        h = self.make_repo()
        root = h.root.resolve()
        (root / "shot.png").write_bytes(PNG_1X1)
        git(root, "add", "-A")
        git(root, "commit", "-qm", "image")
        (root / "billing.py").write_text(BILLING + "# the user's own unsaved idea\n")

        def calls(messages):
            return [
                ToolCall("r1", "read_file", {"path": str(root / "billing.py")}),
                ToolCall("r2", "glob", {"pattern": "*.py", "path": str(root)}),
                ToolCall("r3", "grep", {"pattern": "def total", "path": str(root / "billing.py")}),
                ToolCall("r4", "repo_map", {"path": str(root)}),
                ToolCall("r5", "code_intel", {"operation": "symbols", "path": str(root / "billing.py")}),
                ToolCall("r6", "git_diff", {"path": str(root / "billing.py")}),
                ToolCall("r7", "read_file", {"path": str(root)}),
            ]
        child = Recorder(calls, "looked")
        self.run_parent(h, [[ToolCall("t1", "task", {"description": "review",
                                                     "prompt": "READER-1 review billing"})],
                            ("READER-1", child)], "parent: delegate")
        own = system_root(child.messages)
        bill = root / "billing.py"
        self.assertEqual(child.results, [
            f"error: not read: {bill} is in the user's checkout. {in_copy('billing.py', own)}",
            f"error: not searched: {root} is in the user's checkout. Search {own} instead: this "
            "helper works in its own copy.",
            f"error: not searched: {bill} is in the user's checkout. Search {own / 'billing.py'} "
            "instead: this helper works in its own copy.",
            f"error: not mapped: {root} is in the user's checkout. Map {own} instead: this helper "
            "works in its own copy.",
            f"error: not searched: {bill} is in the user's checkout. Search {own / 'billing.py'} "
            "instead: this helper works in its own copy.",
            f"error: not read: {bill} is in the user's checkout. Use {own / 'billing.py'} instead: "
            "this helper works in its own copy.",
            f"error: not read: {root} is in the user's checkout. Read {own} instead: this helper "
            "works in its own copy.",
        ])
        self.assertNotIn("unsaved idea", "\n".join(child.results), "nothing of the user's file was read")

    def test_view_image_is_refused_the_same_way(self):
        h = self.make_repo()
        root = h.root.resolve()
        (root / "shot.png").write_bytes(PNG_1X1)
        git(root, "add", "-A")
        git(root, "commit", "-qm", "image")
        seen = {}

        def calls(messages):
            seen["own"] = system_root(messages)
            return [ToolCall("v1", "view_image", {"path": str(root / "shot.png"),
                                                  "question": "What does it show?"})]

        child = Recorder(calls, "looked")
        self.run_parent(h, [[ToolCall("t1", "task", {"description": "look", "prompt": "READER-2 look at shot.png"})],
                            ("READER-2", child)], "parent: delegate")
        own = seen["own"]
        self.assertEqual(child.results, [
            f"error: not viewed: {root / 'shot.png'} is in the user's checkout. View "
            f"{own / 'shot.png'} instead: this helper works in its own copy."])

    def test_a_path_outside_both_is_refused_plainly_and_so_is_a_search_up_the_tree(self):
        h = self.make_repo()
        scratch = Path(tempfile.mkdtemp(prefix="dgc-other-scratch-")).resolve()
        self.addCleanup(shutil.rmtree, scratch, True)
        (scratch / "secret.txt").write_text("another task's notes\n")
        seen = {}

        def calls(messages):
            own = seen["own"] = system_root(messages)
            return [ToolCall("o1", "read_file", {"path": str(scratch / "secret.txt")}),
                    ToolCall("o2", "grep", {"pattern": "notes", "path": f"{own}/.."}),
                    ToolCall("o3", "glob", {"pattern": "**/*.txt", "path": str(scratch)})]

        child = Recorder(calls, "searched")
        self.run_parent(h, [[ToolCall("t1", "task", {"description": "search", "prompt": "READER-3 find notes"})],
                            ("READER-3", child)], "parent: delegate")
        own = seen["own"]
        tail = (f" is outside this helper's own copy ({own}), and a helper reads only its own copy. "
                "If the task needs it, say so in your report.")
        self.assertEqual(child.results, [
            f"error: not read: {scratch / 'secret.txt'}{tail}",
            f"error: not searched: {own}/..{tail}",
            f"error: not searched: {scratch}{tail}",
        ])
        self.assertNotIn("another task's notes", "\n".join(child.results))

    def test_a_file_its_task_names_outside_every_checkout_is_read_and_its_neighbour_is_not(self):
        h = self.make_repo()
        downloads = Path(tempfile.mkdtemp(prefix="dgc-downloads-")).resolve()
        self.addCleanup(shutil.rmtree, downloads, True)
        (downloads / "spec.txt").write_text("Totals round once, at the end.\n")
        (downloads / "bank.txt").write_text("account 0000\n")
        seen = {}

        def calls(messages):
            seen["own"] = system_root(messages)
            return [ToolCall("n1", "read_file", {"path": str(downloads / "spec.txt")}),
                    ToolCall("n2", "read_file", {"path": str(downloads / "bank.txt")})]

        child = Recorder(calls, "read the spec")
        self.run_parent(h, [[ToolCall("t1", "task", {"description": "spec", "prompt":
                                                     f"READER-9 implement what {downloads / 'spec.txt'} says"})],
                            ("READER-9", child)], "parent: delegate")
        self.assertIn("Totals round once", child.results[0], "the file the task named")
        self.assertEqual(child.results[1], f"error: not read: {downloads / 'bank.txt'} is outside this helper's own "
                         f"copy ({seen['own']}), and a helper reads only its own copy. If the task needs it, say so "
                         "in your report.")

    def test_a_shared_folder_stays_readable_and_an_ignored_folder_it_was_not_given_does_not(self):
        h = self.make_repo(subagent_link_paths=["assets"])
        root = h.root.resolve()
        commit(root, {".gitignore": "assets/\nbuild/\n"})
        (root / "assets" / "pkg").mkdir(parents=True)
        (root / "assets" / "pkg" / "index.js").write_text("module.exports = 'shared';\n")
        (root / "build").mkdir()
        (root / "build" / "out.txt").write_text("built\n")
        seen = {}

        def calls(messages):
            own = seen["own"] = system_root(messages)
            seen["linked"] = os.path.islink(own / "assets")
            return [ToolCall("s1", "read_file", {"path": "assets/pkg/index.js"}),
                    ToolCall("s2", "read_file", {"path": str(own / "assets" / "pkg" / "index.js")}),
                    ToolCall("s3", "read_file", {"path": str(root / "assets" / "pkg" / "index.js")}),
                    ToolCall("s4", "grep", {"pattern": "shared", "path": "assets"}),
                    ToolCall("s5", "read_file", {"path": str(root / "build" / "out.txt")})]

        child = Recorder(calls, "read")
        self.run_parent(h, [[ToolCall("t1", "task", {"description": "deps", "prompt": "READER-4 read deps"})],
                            ("READER-4", child)], "parent: delegate")
        own = seen["own"]
        self.assertTrue(seen["linked"], "the folder was shared into the copy")
        for result in child.results[:3]:
            self.assertIn("module.exports = 'shared';", result)
        self.assertIn("1 match(es) in 1 file(s)", child.results[3])
        self.assertEqual(child.results[4],
                         f"error: not read: {root / 'build' / 'out.txt'} is in the user's checkout, "
                         f"outside this helper's own copy, and the copy has no {own / 'build' / 'out.txt'}: "
                         "a file Git ignores is not copied into it. Work from what your copy has; if "
                         "the task needs that file, say so in your report.")

    def test_dot_dot_and_a_link_out_of_the_copy_are_refused(self):
        h = self.make_repo()
        root = h.root.resolve()
        scratch = Path(tempfile.mkdtemp(prefix="dgc-link-target-")).resolve()
        self.addCleanup(shutil.rmtree, scratch, True)
        (scratch / "secret.txt").write_text("not the project\n")
        (root / "to_user").symlink_to(root)          # committed links: the copy has them too
        (root / "to_scratch").symlink_to(scratch)
        git(root, "add", "-A")
        git(root, "commit", "-qm", "links")
        seen = {}

        def calls(messages):
            own = seen["own"] = system_root(messages)
            up = os.path.relpath(root / "billing.py", own)
            seen["up"] = up
            return [ToolCall("d1", "read_file", {"path": up}),
                    ToolCall("d2", "read_file", {"path": "to_user/billing.py"}),
                    ToolCall("d3", "read_file", {"path": "to_scratch/secret.txt"}),
                    ToolCall("d4", "grep", {"pattern": "project", "path": "to_scratch"})]

        child = Recorder(calls, "followed")
        self.run_parent(h, [[ToolCall("t1", "task", {"description": "links", "prompt": "READER-5 links"})],
                            ("READER-5", child)], "parent: delegate")
        own, up = seen["own"], seen["up"]
        self.assertIn("..", Path(up).parts)
        tail = (f" is outside this helper's own copy ({own}), and a helper reads only its own copy. "
                "If the task needs it, say so in your report.")
        self.assertEqual(child.results, [
            f"error: not read: {up} is in the user's checkout. {in_copy('billing.py', own)}",
            f"error: not read: to_user/billing.py is in the user's checkout. {in_copy('billing.py', own)}",
            f"error: not read: to_scratch/secret.txt{tail}",
            f"error: not searched: to_scratch{tail}",
        ])

    def test_a_file_the_helper_wrote_outside_its_copy_reads_back_and_nothing_else_there_does(self):
        h = self.make_repo()
        scratch = Path(tempfile.mkdtemp(prefix="dgc-helper-own-")).resolve()
        self.addCleanup(shutil.rmtree, scratch, True)
        (scratch / "neighbour.txt").write_text("someone else's\n")
        seen = {}

        def calls(messages):
            seen["own"] = system_root(messages)
            return [ToolCall("w1", "write_file", {"path": str(scratch / "runner.sh"), "content": "echo hi\n"}),
                    ToolCall("w2", "read_file", {"path": str(scratch / "runner.sh")}),
                    ToolCall("w3", "read_file", {"path": str(scratch / "neighbour.txt")})]

        child = Recorder(calls, "wrote")
        self.run_parent(h, [[ToolCall("t1", "task", {"description": "runner", "prompt": "READER-6 runner"})],
                            ("READER-6", child)], "parent: delegate")
        self.assertTrue(child.results[0].startswith("wrote "), child.results)
        self.assertIn("echo hi", child.results[1])
        self.assertEqual(child.results[2],
                         f"error: not read: {scratch / 'neighbour.txt'} is outside this helper's own "
                         f"copy ({seen['own']}), and a helper reads only its own copy. If the task "
                         "needs it, say so in your report.")

    def test_its_instructions_say_its_reads_stay_in_its_copy(self):
        agent = type("Agent", (), {})()
        agent._user_checkouts = (Path("/w/app"),)
        agent.config = type("C", (), {"project_root": Path("/w/.dgc/wt/t")})()
        self.assertIn("DGC's file tools refuse writes into it, and read and search only inside your copy",
                      helper_checkout.prompt_lines(agent)[0])


class ReadRulesTest(unittest.TestCase):
    """read_refusal on its own: where a helper's read is decided."""

    def setUp(self):
        base = Path(tempfile.mkdtemp(prefix="dgc-reads-")).resolve()
        self.addCleanup(shutil.rmtree, base, True)
        self.base = base
        self.user = base / "app"
        self.own = base / "copies" / "app-task"
        for folder in (self.user, self.own):
            (folder / "src").mkdir(parents=True)
            (folder / "src" / "a.py").write_text("x = 1\n")
        (base / "elsewhere").mkdir()
        (base / "elsewhere" / "x.txt").write_text("x\n")

    def agent(self, own=None, user=None, shared=(), roots=None):
        agent = type("Agent", (), {})()
        agent._user_checkouts = tuple(roots) if roots is not None else (user or self.user,)
        agent._shared_dirs = list(shared)
        agent.config = type("C", (), {"project_root": own or self.own})()
        return agent

    def outside(self, path, own=None) -> str:
        return (f"error: not read: {path} is outside this helper's own copy ({own or self.own}), and a "
                "helper reads only its own copy. If the task needs it, say so in your report.")

    def mapped(self, path, mine, done="not read", verb="Read") -> str:
        return (f"error: {done}: {path} is in the user's checkout. {verb} {mine} instead: this helper "
                "works in its own copy.")

    def test_a_path_its_task_names_outside_every_checkout_is_read(self):
        agent = self.agent()
        other = self.base / "elsewhere"
        (other / "y.txt").write_text("y\n")
        helper_checkout.note_named(agent, f"Implement what {other / 'x.txt'} says.")
        self.assertIsNone(helper_checkout.read_refusal(agent, "read_file", str(other / "x.txt")))
        self.assertEqual(helper_checkout.read_refusal(agent, "read_file", str(other / "y.txt")),
                         self.outside(other / "y.txt"), "only what it named")

    def test_a_named_folder_is_read_inside_but_never_one_that_holds_a_checkout(self):
        agent = self.agent()
        other = self.base / "elsewhere"
        helper_checkout.note_named(agent, f"The fixtures are in {other}/, and everything is under {self.base}.")
        self.assertIsNone(helper_checkout.read_refusal(agent, "read_file", str(other / "x.txt")))
        self.assertIsNone(helper_checkout.read_refusal(agent, "grep", str(other)))
        (self.base / "notes.txt").write_text("n\n")
        self.assertEqual(helper_checkout.read_refusal(agent, "read_file", str(self.base / "notes.txt")),
                         self.outside(self.base / "notes.txt"), "a folder that holds the checkout opens nothing")
        target = self.user / "src" / "a.py"
        self.assertEqual(helper_checkout.read_refusal(agent, "read_file", str(target)),
                         self.mapped(target, self.own / "src" / "a.py"), "the user's checkout is still the copy's")

    def test_the_home_folder_or_the_root_named_opens_nothing_and_a_url_names_no_path(self):
        home = self.base / "home"
        (home / "Downloads").mkdir(parents=True)
        (home / "Downloads" / "spec.pdf").write_bytes(b"%PDF-1.4\n")
        (home / "diary.txt").write_text("d\n")
        with patch.dict(os.environ, {"HOME": str(home)}):
            agent = self.agent()
            helper_checkout.note_named(agent, "Read ~/Downloads/spec.pdf; my files are in ~ and / anyway.")
            self.assertIsNone(helper_checkout.read_refusal(agent, "read_file", str(home / "Downloads" / "spec.pdf")))
            self.assertIsNotNone(helper_checkout.read_refusal(agent, "read_file", str(home / "diary.txt")))
            self.assertIsNotNone(helper_checkout.read_refusal(agent, "read_file", "/etc/hostname"))
        agent = self.agent()
        helper_checkout.note_named(agent, "See https://example.com/elsewhere/x.txt and src/a.py")
        self.assertEqual(getattr(agent, "_task_paths", []), [])

    def test_a_later_message_from_the_agent_that_started_it_names_paths_too(self):
        agent = self.agent()
        other = self.base / "elsewhere"
        self.assertIsNotNone(helper_checkout.read_refusal(agent, "read_file", str(other / "x.txt")))
        said = helper_checkout.hand_to(agent, f"Also check {other / 'x.txt'} against {self.user / 'src' / 'a.py'}")
        self.assertIn(str(self.own / "src" / "a.py"), said, "its own copy, as before")
        self.assertIsNone(helper_checkout.read_refusal(agent, "read_file", str(other / "x.txt")))

    def test_the_main_chat_keeps_no_named_paths(self):
        agent = self.agent(roots=())
        helper_checkout.note_named(agent, f"Read {self.base / 'elsewhere' / 'x.txt'}")
        self.assertFalse(getattr(agent, "_task_paths", None))

    def test_its_own_copy_is_read_relative_absolute_and_by_default(self):
        agent = self.agent()
        for path in ("src/a.py", str(self.own / "src" / "a.py"), "src/../src/a.py", "", None, "."):
            self.assertIsNone(helper_checkout.read_refusal(agent, "read_file", path), path)

    def test_the_users_checkout_is_refused_naming_the_copys_path_for_every_read_tool(self):
        agent = self.agent()
        target = self.user / "src" / "a.py"
        words = {"read_file": ("not read", "Read"), "view_image": ("not viewed", "View"),
                 "glob": ("not searched", "Search"), "grep": ("not searched", "Search"),
                 "repo_map": ("not mapped", "Map"), "code_intel": ("not searched", "Search"),
                 "git_diff": ("not read", "Use")}
        self.assertEqual(set(words), set(helper_checkout.READ_TOOLS))
        for name, (done, verb) in words.items():
            self.assertEqual(helper_checkout.read_refusal(agent, name, str(target)),
                             self.mapped(target, self.own / "src" / "a.py", done, verb), name)
        self.assertEqual(helper_checkout.read_refusal(agent, "read_file", str(self.user)),
                         self.mapped(self.user, self.own))
        # A tool that is not a read is not decided here (writes have their own refusal).
        self.assertIsNone(helper_checkout.read_refusal(agent, "write_file", str(target)))
        self.assertIsNone(helper_checkout.read_refusal(agent, "bash", str(target)))

    def test_a_path_outside_both_is_refused_plainly(self):
        agent = self.agent()
        for path in (str(self.base / "elsewhere" / "x.txt"), str(self.base), f"{self.own}/..", "/etc/hosts"):
            self.assertEqual(helper_checkout.read_refusal(agent, "read_file", path), self.outside(path), path)

    def test_dot_dot_and_links_are_resolved_before_deciding(self):
        agent = self.agent()
        sneaky = f"{self.own}/../../app/src/a.py"
        self.assertEqual(helper_checkout.read_refusal(agent, "read_file", sneaky),
                         self.mapped(sneaky, self.own / "src" / "a.py"))
        self.assertEqual(helper_checkout.read_refusal(agent, "read_file", "../../app/src/a.py"),
                         self.mapped("../../app/src/a.py", self.own / "src" / "a.py"))
        (self.own / "docs").symlink_to(self.user / "src")
        self.assertEqual(helper_checkout.read_refusal(agent, "read_file", "docs/a.py"),
                         self.mapped("docs/a.py", self.own / "src" / "a.py"),
                         "a link out of the copy is followed to where it really reads")
        (self.own / "escape").symlink_to(self.base / "elsewhere")
        self.assertEqual(helper_checkout.read_refusal(agent, "read_file", "escape/x.txt"),
                         self.outside("escape/x.txt"))
        # A link that stays inside the copy is the copy.
        (self.own / "alias").symlink_to(self.own / "src")
        self.assertIsNone(helper_checkout.read_refusal(agent, "read_file", "alias/a.py"))

    def test_a_shared_folder_reads_by_either_name_and_cannot_be_climbed_out_of(self):
        (self.user / "node_modules" / "pkg").mkdir(parents=True)
        (self.user / "node_modules" / "pkg" / "index.js").write_text("x\n")
        (self.own / "node_modules").symlink_to(self.user / "node_modules")
        agent = self.agent(shared=["node_modules"])
        for path in ("node_modules/pkg/index.js", str(self.own / "node_modules" / "pkg"),
                     str(self.user / "node_modules" / "pkg" / "index.js"), "node_modules"):
            self.assertIsNone(helper_checkout.read_refusal(agent, "grep", path), path)
        climbed = "node_modules/../src/a.py"         # through the link, `..` lands in the user's src
        self.assertEqual(helper_checkout.read_refusal(agent, "read_file", climbed),
                         self.mapped(climbed, self.own / "src" / "a.py"))
        (self.own / "node_modules").unlink()          # a copy it was not shared into
        unshared = self.agent()
        theirs = self.user / "node_modules" / "pkg" / "index.js"
        self.assertEqual(helper_checkout.read_refusal(unshared, "read_file", str(theirs)),
                         f"error: not read: {theirs} is in the user's checkout, outside this helper's own "
                         f"copy, and the copy has no {self.own / 'node_modules' / 'pkg' / 'index.js'}: a file "
                         "Git ignores is not copied into it. Work from what your copy has; if the task needs "
                         "that file, say so in your report.")

    def test_a_skills_folder_reads_and_nothing_beside_it_does(self):
        skills = self.base / "skills"
        (skills / "deploy").mkdir(parents=True)
        (skills / "deploy" / "SKILL.md").write_text("---\nname: deploy\n---\nRead steps.md.\n")
        (skills / "deploy" / "steps.md").write_text("1. go\n")
        (skills / "off").mkdir()
        (skills / "off" / "notes.md").write_text("off\n")
        agent = self.agent()
        skill = type("Skill", (), {})
        on, off = skill(), skill()
        on.path, on.enabled = skills / "deploy" / "SKILL.md", True
        off.path, off.enabled = skills / "off" / "SKILL.md", False
        agent.skills = {"deploy": on, "off": off}
        self.assertIsNone(helper_checkout.read_refusal(agent, "read_file", str(skills / "deploy" / "steps.md")))
        for path in (str(skills / "off" / "notes.md"), str(skills)):
            self.assertEqual(helper_checkout.read_refusal(agent, "read_file", path), self.outside(path), path)
        # A skill kept inside the user's checkout is no way into it.
        inside = self.user / ".dgc" / "skills" / "local"
        inside.mkdir(parents=True)
        (inside / "SKILL.md").write_text("---\nname: local\n---\nRead ref.md.\n")
        (inside / "ref.md").write_text("ref\n")
        mine = skill()
        mine.path, mine.enabled = inside / "SKILL.md", True
        agent.skills["local"] = mine
        refused = helper_checkout.read_refusal(agent, "read_file", str(inside / "ref.md"))
        self.assertTrue(refused.startswith(f"error: not read: {inside / 'ref.md'} is in the user's checkout"),
                        refused)

    def test_what_it_wrote_outside_its_copy_reads_back(self):
        agent = self.agent()
        written = self.base / "elsewhere" / "runner.sh"
        self.assertEqual(helper_checkout.read_refusal(agent, "read_file", str(written)), self.outside(written))
        helper_checkout.note_write(agent, str(written))
        self.assertIsNone(helper_checkout.read_refusal(agent, "read_file", str(written)))
        self.assertEqual(helper_checkout.read_refusal(agent, "read_file", str(self.base / "elsewhere" / "x.txt")),
                         self.outside(self.base / "elsewhere" / "x.txt"), "only that file")
        helper_checkout.note_write(agent, "src/new.py")
        self.assertEqual(agent._outside_writes, {str(written)}, "a write in its copy needs no note")

    def test_the_main_chat_and_a_helper_without_a_copy_are_never_refused(self):
        for agent in (type("Main", (), {"config": type("C", (), {"project_root": self.user})()})(),
                      type("Shared", (), {"config": type("C", (), {"project_root": self.user})(),
                                          "_user_checkouts": ()})()):
            for path in (str(self.own / "src" / "a.py"), str(self.base / "elsewhere"), "../x", "/etc/hosts"):
                self.assertIsNone(helper_checkout.read_refusal(agent, "read_file", path), path)
            helper_checkout.note_write(agent, str(self.base / "elsewhere" / "x.txt"))
            self.assertFalse(hasattr(agent, "_outside_writes"))

    def test_a_folder_reached_by_another_name_is_the_same_folder(self):
        """macOS spells /tmp as /private/tmp once a link is followed: either spelling is the same place."""
        alias = self.base / "alias"
        alias.symlink_to(self.base)
        by_alias = self.agent(own=alias / "copies" / "app-task", user=alias / "app")
        self.assertIsNone(helper_checkout.read_refusal(by_alias, "read_file", str(self.own / "src" / "a.py")))
        self.assertEqual(helper_checkout.read_refusal(by_alias, "read_file", str(self.user / "src" / "a.py")),
                         self.mapped(self.user / "src" / "a.py", alias / "copies" / "app-task" / "src" / "a.py"))
        by_real = self.agent()
        self.assertIsNone(helper_checkout.read_refusal(by_real, "read_file",
                                                       str(alias / "copies" / "app-task" / "src" / "a.py")))
        self.assertEqual(helper_checkout.read_refusal(by_real, "read_file", str(alias / "app" / "src" / "a.py")),
                         self.mapped(alias / "app" / "src" / "a.py", self.own / "src" / "a.py"))

    @unittest.skipUnless(os.path.islink("/tmp"), "/tmp is a link only on macOS")
    def test_tmp_and_private_tmp_are_one_place(self):
        base = Path(tempfile.mkdtemp(dir="/tmp", prefix="dgc-reads-tmp-"))
        self.addCleanup(shutil.rmtree, base, True)
        tmp = Path("/tmp") / base.name
        private = Path(os.path.realpath(tmp))
        self.assertNotEqual(str(tmp), str(private))
        for folder in ("app/src", "copy/src"):
            (private / folder).mkdir(parents=True)
        (private / "app" / "src" / "a.py").write_text("x\n")
        (private / "copy" / "src" / "a.py").write_text("x\n")
        agent = self.agent(own=tmp / "copy", user=tmp / "app")
        self.assertIsNone(helper_checkout.read_refusal(agent, "read_file", str(private / "copy" / "src" / "a.py")))
        self.assertEqual(helper_checkout.read_refusal(agent, "read_file", str(private / "app" / "src" / "a.py")),
                         self.mapped(private / "app" / "src" / "a.py", tmp / "copy" / "src" / "a.py"))

    def test_a_project_inside_a_bigger_repository_reads_its_whole_worktree(self):
        repo, tree = self.base / "repo", self.base / "wt"
        for top in (repo, tree):
            (top / "app").mkdir(parents=True)
            (top / "app" / "a.py").write_text("x\n")
            (top / "lib").mkdir()
            (top / "lib" / "shared.py").write_text("x\n")
        agent = self.agent(own=tree / "app", user=repo / "app")
        agent._copy_tree, agent._user_trees = tree, (repo,)
        self.assertIsNone(helper_checkout.read_refusal(agent, "read_file", "../lib/shared.py"))
        self.assertEqual(helper_checkout.read_refusal(agent, "read_file", str(repo / "lib" / "shared.py")),
                         self.mapped(repo / "lib" / "shared.py", tree / "lib" / "shared.py"))
        self.assertEqual(helper_checkout.read_refusal(agent, "read_file", str(repo / "app" / "a.py")),
                         self.mapped(repo / "app" / "a.py", tree / "app" / "a.py"))
        self.assertEqual(helper_checkout.read_refusal(agent, "read_file", str(self.base)),
                         self.outside(self.base, tree / "app"))

    def test_a_helpers_own_helper_is_sent_from_its_parents_copy_to_its_own(self):
        middle = self.base / "copies" / "middle"
        (middle / "src").mkdir(parents=True)
        (middle / "src" / "a.py").write_text("x\n")
        agent = self.agent(roots=(middle, self.user))
        self.assertEqual(helper_checkout.read_refusal(agent, "read_file", str(middle / "src" / "a.py")),
                         f"error: not read: {middle / 'src' / 'a.py'} is in the copy of the helper that "
                         f"started you. Read {self.own / 'src' / 'a.py'} instead: this helper works in its "
                         "own copy.")
        self.assertEqual(helper_checkout.read_refusal(agent, "read_file", str(self.user / "src" / "a.py")),
                         self.mapped(self.user / "src" / "a.py", self.own / "src" / "a.py"))


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

    def test_a_helper_without_its_own_copy_and_the_main_chat_read_anywhere_as_before(self):
        h = self.make(git=False, mode="auto")
        root = h.root.resolve()
        (root / "billing.py").write_text(BILLING)
        scratch = Path(tempfile.mkdtemp(prefix="dgc-shared-reads-")).resolve()
        self.addCleanup(shutil.rmtree, scratch, True)
        (scratch / "notes.txt").write_text("outside the project\n")
        child = Recorder(lambda messages: [
            ToolCall("c1", "read_file", {"path": str(root / "billing.py")}),
            ToolCall("c2", "read_file", {"path": str(scratch / "notes.txt")}),
            ToolCall("c3", "grep", {"pattern": "outside", "path": str(scratch)})], "read")
        self.run_parent(h, [[ToolCall("t1", "task", {"description": "read", "prompt": "READER-7 read"})],
                            ("READER-7", child)], "parent: delegate")
        self.assertIn("def total(lines):", child.results[0])
        self.assertIn("outside the project", child.results[1])
        self.assertIn("1 match(es) in 1 file(s)", child.results[2])
        main = h.agent._handle_call(ToolCall("m1", "read_file", {"path": str(scratch / "notes.txt")}))
        self.assertIn("outside the project", main)

    def test_the_main_chat_reads_what_its_isolated_helper_was_refused(self):
        h = self.make_repo()
        root = h.root.resolve()
        scratch = Path(tempfile.mkdtemp(prefix="dgc-main-reads-")).resolve()
        self.addCleanup(shutil.rmtree, scratch, True)
        (scratch / "notes.txt").write_text("outside the project\n")
        child = Recorder(lambda messages: [
            ToolCall("c1", "read_file", {"path": str(root / "billing.py")}),
            ToolCall("c2", "read_file", {"path": str(scratch / "notes.txt")})], "refused")
        self.run_parent(h, [[ToolCall("t1", "task", {"description": "read", "prompt": "READER-8 read"})],
                            ("READER-8", child)], "parent: delegate")
        self.assertTrue(all(result.startswith("error: not read: ") for result in child.results), child.results)
        self.assertIn("def total(lines):", h.agent._handle_call(
            ToolCall("m1", "read_file", {"path": str(root / "billing.py")})))
        self.assertIn("outside the project", h.agent._handle_call(
            ToolCall("m2", "read_file", {"path": str(scratch / "notes.txt")})))
        self.assertIn("1 match(es) in 1 file(s)", h.agent._handle_call(
            ToolCall("m3", "grep", {"pattern": "outside", "path": str(scratch)})))

    def test_a_helpers_own_helper_reads_neither_checkout_above_it(self):
        h = self.make_repo(max_subagent_depth=2)
        root = h.root.resolve()
        seen = {}

        def level_one(messages):
            seen["one"] = system_root(messages)
            return [ToolCall("d1", "task", {"description": "deeper", "prompt": "LEVEL-2R read"})]

        def level_two(messages):
            seen["two"] = system_root(messages)
            return [ToolCall("e1", "read_file", {"path": str(seen["one"] / "billing.py")}),
                    ToolCall("e2", "grep", {"pattern": "total", "path": str(root)})]

        first, second = Recorder(level_one, "level one done"), Recorder(level_two, "level two done")
        self.run_parent(h, [[ToolCall("t1", "task", {"description": "top", "prompt": "LEVEL-1R go"})],
                            ("LEVEL-1R", first), ("LEVEL-2R", second)], "parent: delegate")
        one, two = seen["one"], seen["two"]
        self.assertEqual(second.results, [
            f"error: not read: {one / 'billing.py'} is in the copy of the helper that started you. "
            f"Read {two / 'billing.py'} instead: this helper works in its own copy.",
            f"error: not searched: {root} is in the user's checkout. Search {two} instead: this "
            "helper works in its own copy."])

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
