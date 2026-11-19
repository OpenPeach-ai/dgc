"""A Pip works in any folder (19 Nov, for 0.52): a folder that isn't a Git project is never refused.

A folder Pip in a folder that isn't a Git project (or a Git project with no commit yet) chats, checks, changes its copy,
applies, undoes, and is given or loses its folder, exactly as one in a Git project does. The folder is never written
except by what the user applies: no .git is added. DGC keeps its own Git of the folder on its side (for the commits a
check and its "what changed since" pin), and reads the folder's files as they are, never copying what must never be
copied (.env and .env.*, keys and certificates, credential files, dependency, virtual environment, build and cache
folders). A Git project with commits is read exactly as before.

A real registry, real folders, real Git where a test makes one, the real controls; the worker's model only where a
test runs a real check, as a fixture.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import pip_chat, pip_commit_detector as detector, pip_event_triggers as triggers, pip_folder_git, \
    pip_project_copies as copies, pip_schedules as schedules, pip_source_check, pips, sessions
from dgc.workspace_registry import RegistryError, _execute_schema
from tests import test_pips_local as fixtures
from tests.test_pip_give_folder import GiveWorld
from tests.test_pip_project_copies import git

NEVER = "never-copied"
LIME = {
    "billing/tax.py": "def tax(amount):\n    return round(amount * 0.18, 1)\n",
    "billing/__init__.py": "",
    "README.md": "# Lime tiles\n",
    ".env": f"API_KEY={NEVER}-env\n",
    ".env.local": f"TOKEN={NEVER}-env-local\n",
    "keys/server.pem": f"-----BEGIN {NEVER}-pem-----\n",
    "deploy/id_rsa": f"{NEVER}-rsa\n",
    "secrets.json": f'{{"token": "{NEVER}-secrets"}}\n',
    "node_modules/left/index.js": f"// {NEVER}-module\n",
    "env/pyvenv.cfg": "home = /usr/bin\n",
    "env/lib/site.py": f"# {NEVER}-venv\n",
    "build/out.js": f"// {NEVER}-build\n",
    "billing/__pycache__/tax.cpython-312.pyc": f"{NEVER}-pyc",
}
READ = ["README.md", "billing/__init__.py", "billing/tax.py"]


def make_folder(root: Path, files=LIME) -> Path:
    for rel, text in files.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    return root


def everything(root: Path) -> dict:
    """Every entry under a folder, with its kind, bytes and time: a folder DGC never writes stays exactly this."""
    out = {}
    for path in sorted(root.rglob("*")):
        info = path.lstat()
        out[str(path.relative_to(root))] = ("dir" if path.is_dir() else path.read_bytes(), info.st_mtime_ns)
    return out


def files_in(box: Path) -> list[str]:
    return sorted(str(p.relative_to(box)) for p in box.rglob("*") if p.is_file())


def tree(place: Path, revision: str) -> list[str]:
    out = subprocess.run(["git", "-C", str(place), "ls-tree", "-r", "--name-only", revision], capture_output=True,
                         text=True, check=True).stdout
    return sorted(out.split())


class PlainWorld(GiveWorld):
    """self.lime: a folder with no Git, holding things that must never be copied; self.lime_space its workspace."""

    def setUp(self):
        super().setUp()
        self.lime = make_folder(Path(self.base) / "lime")
        self.lime_space = self.registry.resolve(self.lime)
        self.before = everything(self.lime)

    def lime_pip(self, name="Lime helper", **more):
        return self.store.create(self.lime_space["id"], name, None, "editor-user", pip_type="patch", **more)

    def untouched(self):
        self.assertFalse((self.lime / ".git").exists(), "no .git is ever added to the folder")
        self.assertEqual(everything(self.lime), self.before, "nothing in the folder changed")

    def manifest(self, run_id):
        return json.loads(self.registry.db.execute("SELECT manifest FROM pip_runs WHERE id=?", (run_id,)).fetchone()[0])


class AFolderWithoutGit(PlainWorld, unittest.TestCase):
    def test_a_new_pip_there_chats_and_reads_the_files_as_they_are_never_what_must_not_be_copied(self):
        pip = self.lime_pip()
        sent = pip_chat.send(self.store, pip["id"], "What does billing/tax.py do?", "m-1", "editor-user", self.cfg)
        manifest = self.manifest(sent["run"]["id"])
        self.assertRegex(manifest["source_revision"] or "", r"^[0-9a-f]{40}$", "its turn pins one exact snapshot")
        told = copies.own_folder(self.store, pip["id"])
        self.assertNotIn("error", told)
        self.assertEqual((told["name"], told["folder"], told["files"]), ("lime", "projects/lime", 3))
        self.assertTrue(told.get("plain"), "the Pip is told its copy is the files as they are")
        box = self.own_copy(pip).parent / "lime"
        self.assertEqual(files_in(box), READ)
        for path in box.rglob("*"):
            if path.is_file():
                self.assertNotIn(NEVER, path.read_text(errors="replace"), path)
        words = pips._own_box_words(told)
        self.assertIn(".env", words)
        self.assertNotIn("Git ignores", words, "there is no Git here to ignore anything")
        self.untouched()

    def test_dgcs_own_git_of_the_folder_is_on_dgcs_side_and_holds_what_the_copy_holds(self):
        pip = self.lime_pip()
        sent = pip_chat.send(self.store, pip["id"], "Hello", "m-1", "editor-user", self.cfg)
        place = pip_folder_git.location(self.registry.directory, self.lime)
        self.assertTrue((place / ".git").is_dir())
        self.assertTrue(str(place).startswith(str(self.registry.directory)))
        revision = self.manifest(sent["run"]["id"])["source_revision"]
        self.assertEqual(tree(place, revision), READ)
        self.assertEqual([p.name for p in place.iterdir()], [".git"], "its own work tree stays empty")
        self.untouched()

    def test_its_change_applies_to_the_folder_and_undo_puts_it_back(self):
        pip = self.lime_pip()
        copies.own_folder(self.store, pip["id"])
        box = self.own_copy(pip).parent / "lime"
        fixed = "def tax(amount):\n    return round(amount * 0.18, 2)\n"
        (box / "billing" / "tax.py").write_text(fixed)
        (box / ".env").write_text("API_KEY=the-pips-own\n")                # never a change: DGC never copies it
        (box / "build").mkdir()
        (box / "build" / "out.js").write_text("// built in its copy\n")
        [change] = self.control("list_pip_project_changes", pip_id=pip["id"])["changes"]
        self.assertEqual([(f["path"], f["change"]) for f in change["files"]], [("billing/tax.py", "modified")])
        diff = self.control("get_pip_project_change", pip_id=pip["id"], change_id=change["id"], path="billing/tax.py")
        self.assertIn("+    return round(amount * 0.18, 2)", diff["diff"])
        self.assertNotIn("git", diff, "no Commit these files: the folder isn't a Git project")
        applied = self.control("apply_pip_project_change", pip_id=pip["id"], change_id=change["id"],
                               expected_digest=change["digest"])
        self.assertEqual((applied["status"], applied["result"]["applied"]), ("applied", ["billing/tax.py"]))
        self.assertEqual((self.lime / "billing" / "tax.py").read_text(), fixed)
        self.assertEqual((self.lime / ".env").read_text(), LIME[".env"], "its .env never reached the folder")
        self.assertFalse((self.lime / ".git").exists())
        undone = self.control("undo_pip_project_change", pip_id=pip["id"], change_id=change["id"])
        self.assertEqual((undone["status"], undone["result"]["restored"]), ("undone", ["billing/tax.py"]))
        self.assertEqual((self.lime / "billing" / "tax.py").read_text(), LIME["billing/tax.py"])
        self.assertEqual({k: v[0] for k, v in everything(self.lime).items()}, {k: v[0] for k, v in self.before.items()},
                         "the folder holds exactly what it held")

    def test_what_changed_since_its_last_check_is_read_from_dgcs_own_git(self):
        pip = self.lime_pip()
        first = pips.source_revision(pip_folder_git.source_root(self.registry, self.lime, sync=True), "HEAD")
        again = pips.source_revision(pip_folder_git.source_root(self.registry, self.lime, sync=True), "HEAD")
        self.assertEqual(first, again, "nothing changed: the same snapshot")
        (self.lime / "node_modules" / "left" / "index.js").write_text("// changed, and never copied\n")
        (self.lime / ".env").write_text("API_KEY=changed\n")
        self.assertEqual(pips.source_revision(pip_folder_git.source_root(self.registry, self.lime, sync=True), "HEAD"),
                         first, "what DGC never copies never makes a new snapshot")
        (self.lime / "billing" / "tax.py").write_text("def tax(amount):\n    return round(amount * 0.18, 2)\n")
        (self.lime / "README.md").unlink()
        (self.lime / "billing" / "rates.py").write_text("GST = 0.18\n")
        second = pips.source_revision(pip_folder_git.source_root(self.registry, self.lime, sync=True), "HEAD")
        self.assertNotEqual(first, second)
        from dgc.pip_source_changes import snapshot as changes
        checkpoint = {"checkpoint": {"id": 1, "source_revision": first}}
        found = changes(pip_folder_git.source_root(self.registry, self.lime), second, checkpoint)
        self.assertEqual(found["status"], "compared")
        self.assertEqual(sorted((c["path"], c["status"]) for c in found["changes"]),
                         [("README.md", "deleted"), ("billing/rates.py", "added"), ("billing/tax.py", "modified")])

    def test_its_source_fits_and_is_said(self):
        pip = self.lime_pip()
        checked = pip_source_check.check(self.registry, self.store._job(pip["id"]))
        self.assertTrue(checked["fits"], checked)
        self.assertEqual(checked["files"], 3)

    def test_give_it_a_folder_takes_a_folder_without_git_and_says_how_it_reads_it(self):
        said = self.give(folder=self.lime, dry_run=True)
        self.assertFalse(said["done"])
        words = " ".join(said["changes"])
        self.assertIn("as they are", words)
        self.assertIn(".env", words)
        self.assertNotIn("committed", words)
        done = self.give(folder=self.lime)
        self.assertTrue(done["done"])
        self.assertEqual(self.store._job(self.pip["id"])["workspace_id"], self.lime_space["id"])
        sent = pip_chat.send(self.store, self.pip["id"], "Look at billing", "m-9", "editor-user", self.cfg)
        self.assertRegex(self.manifest(sent["run"]["id"])["source_revision"] or "", r"^[0-9a-f]{40}$")
        self.store.claim_next()
        self.store.finish(sent["run"]["id"], result={"text": "Looked."})
        self.assertTrue(self.remove(self.pip)["done"])
        self.assertEqual(self.store._job(self.pip["id"])["workspace_id"], self.personal["id"])
        self.untouched()

    def test_an_at_copy_of_a_folder_without_git_never_copies_what_must_not_be_copied(self):
        mark = {"start": 0, "kind": "project", "label": "lime", "identity": self.lime_space["id"]}
        [told] = copies.prepare(self.store, self.pip["id"], [mark], "key-1")
        self.assertTrue(told.get("plain"))
        self.assertEqual(files_in(self.own_copy(self.pip).parent / "lime"), READ)
        self.untouched()

    def test_the_folder_list_says_which_folders_have_their_own_git(self):
        self.lime_pip()
        rows = {r["folder"]: r for r in self.control("list_project_folders")["folders"]}
        self.assertIs(rows[str(self.lime)]["git"], False)
        self.assertIs(rows[str(self.root)]["git"], True)

    def test_temporary_folders_stay_refused(self):
        with patch.object(sessions, "_temporary_roots", lambda: (Path(self.base).resolve(),)):
            self.assertIn("temporary", self.refused("invalid_request", self.give, folder=self.lime))


class AGitProjectWithNoCommit(PlainWorld, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.fresh = make_folder(Path(self.base) / "fresh", {"app.py": "print('hi')\n", ".env": f"K={NEVER}\n",
                                                               ".gitignore": "local.txt\n", "local.txt": f"{NEVER}-ignored\n"})
        git(self.fresh, "init", "-q")
        self.fresh_space = self.registry.resolve(self.fresh)

    def test_it_works_like_a_folder_without_git_until_it_has_a_commit(self):
        pip = self.store.create(self.fresh_space["id"], "Fresh", None, "editor-user", pip_type="patch")
        sent = pip_chat.send(self.store, pip["id"], "Hello", "m-1", "editor-user", self.cfg)
        private = self.manifest(sent["run"]["id"])["source_revision"]
        self.assertTrue(pip_folder_git.location(self.registry.directory, self.fresh).is_dir())
        told = copies.own_folder(self.store, pip["id"])
        self.assertEqual(files_in(self.own_copy(pip).parent / "fresh"), [".gitignore", "app.py"],
                         "what its .gitignore and DGC's own list leave out stays out")
        self.assertTrue(told.get("plain"))
        self.store.claim_next()
        self.store.finish(sent["run"]["id"], result={"text": "Hi."})
        self.assertEqual(subprocess.run(["git", "-C", str(self.fresh), "rev-list", "--all"], capture_output=True,
                                        text=True).stdout, "", "its own Git is untouched: still no commit")
        git(self.fresh, "add", "app.py", ".gitignore")
        git(self.fresh, "commit", "-qm", "first")
        pip_folder_git.forget()
        head = subprocess.run(["git", "-C", str(self.fresh), "rev-parse", "HEAD"], capture_output=True,
                              text=True).stdout.strip()
        sent = pip_chat.send(self.store, pip["id"], "Again", "m-2", "editor-user", self.cfg)
        self.assertEqual(self.manifest(sent["run"]["id"])["source_revision"], head, "now its own commits")
        self.assertNotEqual(private, head)

    def test_give_it_a_folder_takes_it(self):
        self.assertTrue(self.give(folder=self.fresh)["done"])


class AGitProjectWithCommits(PlainWorld, unittest.TestCase):
    def test_it_is_read_exactly_as_before_and_dgc_keeps_no_git_of_its_own_for_it(self):
        pip = self.store.create(self.workspace["id"], "Shop reader", None, "editor-user", pip_type="patch")
        sent = pip_chat.send(self.store, pip["id"], "Hello", "m-1", "editor-user", self.cfg)
        head = subprocess.run(["git", "-C", str(self.root), "rev-parse", "HEAD"], capture_output=True,
                              text=True).stdout.strip()
        self.assertEqual(self.manifest(sent["run"]["id"])["source_revision"], head)
        self.assertEqual(pip_folder_git.source_root(self.registry, self.root, sync=True), str(self.root))
        self.assertFalse(pip_folder_git.location(self.registry.directory, self.root).exists())
        told = copies.own_folder(self.store, pip["id"])
        self.assertFalse(told.get("plain"))
        self.assertIn("Git ignores", pips._own_box_words(told))


class AScheduledCheckOfAFolderWithoutGit(unittest.TestCase):
    """fixtures' folder is a plain folder until a test commits it: a scheduled auditor of it, end to end."""

    def setUp(self):
        fixtures.LocalPipsTests.setUp(self)
        make_folder(self.root)
        self.now = "2026-10-01T10:00:00.000Z"
        self.registry.clock = lambda: self.now
        patched = patch.object(pips, "_require_runner_platform", return_value=None)
        patched.start()
        self.addCleanup(patched.stop)
        guard = patch("requests.sessions.Session.request", side_effect=AssertionError("No network"))
        guard.start()
        self.addCleanup(guard.stop)

    def job(self):
        job = self.store.create(self.workspace["id"], "Auditor", "Inspect billing", "user")
        proposal = self.store.propose(job["id"], 1, {"schedule": {"type": "interval", "minutes": 5}}, "user")
        return self.store.accept(job["id"], proposal["id"], 1, "user")

    def run_check(self, row):
        fixture = '''
import json
from unittest.mock import patch
from dgc.llm import LLMClient, ChatResult, ToolCall
from dgc.pips import _worker_main
calls = 0
def chat(self, messages, tools=None, on_text=None, **kwargs):
    global calls
    calls += 1
    joined = json.dumps(messages)
    if calls == 1:
        return ChatResult(tool_calls=[ToolCall("read1", "read_file", {"path": "billing/tax.py"})])
    assert "round(amount * 0.18, 1)" in joined, "it read the folder's file as it is"
    report = json.dumps({"summary": "Tax rounds to one place", "findings": [], "limitations": ["Source only"]})
    if on_text: on_text(report)
    return ChatResult(content=report)
with patch.object(LLMClient, "chat", chat), patch("requests.sessions.Session.request", side_effect=AssertionError("No network")):
    raise SystemExit(_worker_main())
'''
        original, seen = subprocess.Popen, {}
        copied = pips.copy_committed

        def process(argv, *args, **kwargs):
            if argv[1:] == ["-m", "dgc.pips", "--worker"]:
                argv = [sys.executable, "-c", fixture]
            return original(argv, *args, **kwargs)

        def spy(root, revision, destination, policy):
            out = copied(root, revision, destination, policy)
            seen["files"] = sorted(str(p.relative_to(destination)) for p in destination.rglob("*") if p.is_file())
            seen["text"] = "".join(p.read_text(errors="replace") for p in destination.rglob("*") if p.is_file())
            return out
        with patch.object(pips.subprocess, "Popen", side_effect=process), patch.object(pips, "copy_committed", spy):
            result = pips._execute_run(self.registry, row, self.cfg)
        return result, seen

    def test_it_runs_on_time_reads_the_files_as_they_are_and_never_sees_env(self):
        before = everything(self.root)
        job = self.job()
        self.now = "2026-10-01T10:05:00.000Z"
        self.assertEqual(schedules.tick(self.registry, self.cfg)["enqueued"], 1)
        [run] = self.store.runs(job["id"])
        self.assertRegex(run["manifest"]["source_revision"], r"^[0-9a-f]{40}$")
        row = self.store.claim_next()
        result, seen = self.run_check(row)
        self.assertEqual(seen["files"], READ)
        self.assertNotIn(NEVER, seen["text"])
        finished = self.store.finish(run["id"], result=result)
        self.assertEqual(finished["status"], "succeeded")
        self.assertEqual(everything(self.root), before, "a check never writes the folder")
        self.assertFalse((self.root / ".git").exists())


class TheCommitWatchOfAFolderWithoutGit(unittest.TestCase):
    """A Pip that runs when its folder's commits change: in a folder without Git, when its files change."""

    def setUp(self):
        fixtures.LocalPipsTests.setUp(self)
        make_folder(self.root)
        self.now = "2026-10-01T10:00:00.000Z"
        self.registry.clock = lambda: self.now
        for table, schema in (("pip_event_trigger_state", triggers.SCHEMA_V10),
                              ("pip_commit_observations", detector.SCHEMA_V10)):
            if not self.registry.db.execute("SELECT 1 FROM sqlite_master WHERE name=?", (table,)).fetchone():
                with self.registry.transaction():
                    _execute_schema(self.registry.db, schema)

    def test_a_change_of_its_files_is_a_new_commit_and_a_change_of_what_is_never_copied_is_not(self):
        from tests.test_pip_commit_detector import CommitDetectorTests
        job = self.store.create(self.workspace["id"], "Observer", "Inspect the code", "user")
        CommitDetectorTests.revise(self, job, event_trigger={"events": ["commit_changed"]})
        self.assertEqual(detector.tick(self.registry, self.cfg)["baselined"], 1)
        (self.root / ".env").write_text("API_KEY=changed\n")
        self.now = "2026-10-01T10:00:31.000Z"
        self.assertEqual(detector.tick(self.registry, self.cfg)["changed"], 0)
        (self.root / "billing" / "tax.py").write_text("def tax(amount):\n    return round(amount * 0.18, 2)\n")
        self.now = "2026-10-01T10:01:02.000Z"
        self.assertEqual(detector.tick(self.registry, self.cfg)["changed"], 1)
        self.assertFalse((self.root / ".git").exists())


class TheNeverCopiedList(unittest.TestCase):
    def test_one_list_with_the_checkers_credential_rules(self):
        from dgc import checker_box
        for rel in (".env", ".env.production", "a/.envrc", "keys/site.pem", "x/server.key", "id_rsa", "id_ed25519",
                    ".ssh/config", ".aws/credentials", "credentials.json", "secrets.yaml", "node_modules/a.js",
                    ".venv/bin/python", "venv/x.py", "build/a.js", "dist/a.js", "target/a.o", "__pycache__/a.pyc",
                    "a/b/node_modules/c.js", ".git/config", ".pytest_cache/v"):
            self.assertTrue(copies.never_copied(rel), rel)
        for rel in ("app.py", "billing/tax.py", "README.md", "src/environment.ts", "docs/keys.md", "envoy.yaml"):
            self.assertFalse(copies.never_copied(rel), rel)
        self.assertTrue(all(copies.never_copied(f"{name}/x") for name in checker_box.SECRET_DIRS))
        self.assertTrue(all(copies.never_copied(f"x{suffix}") for suffix in checker_box.SECRET_SUFFIXES))


if __name__ == "__main__":
    unittest.main()
