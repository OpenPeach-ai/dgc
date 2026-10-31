"""A save from an editor DGC can't hear is the person's, not the command's (reported: "Undo in the terminal knows
about files you save in VS Code, but not about saves from other editors such as vim").

While one of the chat's commands runs, the command's look (dgc/command_watch.py) took every file that changed in its
window for the command's: Undo put back Git's copy of a file the person had just saved in vim. A save in VS Code was
already heard (`user_saved`). These drive real editors, started the way the person's own editor runs (not a child of
this process, in a session of its own, on a terminal of its own), while the agent's real command runs:

- vim saving a file during the command and staying open (Linux and macOS: its swap file says so);
- vim saving and quitting during the command (Linux: the names its save leaves come and go while the command runs);
- nano with locking on;
- and the cases that must stay the command's: the command's own write with vim open on the file, a file opened in vim
  only to read it, a command that runs vim itself, and a save that leaves no trace (nano by default).

The behaviour tests import nothing new, so they run against the base too (where the first five fail). The tests of
dgc/editor_traces.py itself are at the end.
"""
from __future__ import annotations

import json
import os
import shutil
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import test_undo_fixes as undo_tests
from dgc.checkpoints import CheckpointManager
from dgc.llm import ChatResult, ToolCall
from test_subagents import HarnessCase

VIM = shutil.which("vim")
NANO = shutil.which("nano")
LINUX = sys.platform.startswith("linux")
FLAG = ".git/dgc-command-started"           # the command makes it first thing: only then does the person save

# Started as a session leader that takes the pty it is given as its terminal, then the editor itself.
_LAUNCH = ("import os, sys\n"
           "os.setsid()\n"
           "fd = int(sys.argv[1])\n"
           "if fd >= 0:\n"
           "    import fcntl, termios\n"
           "    fcntl.ioctl(fd, termios.TIOCSCTTY, 0)\n"
           "else:\n"
           "    fd = os.open(os.devnull, os.O_RDWR)\n"
           "for n in (0, 1, 2):\n"
           "    os.dup2(fd, n)\n"
           "os.close(fd)\n"
           "os.execvp(sys.argv[2], sys.argv[2:])\n")


class Editor:
    """A real editor the way the person runs one: its parent is not this process (the shell that started it is
    gone), it leads a session of its own and, with `tty`, has a pty of its own as its terminal, whose other end
    this keeps to type into it."""

    def __init__(self, case: unittest.TestCase, argv: list[str], cwd: Path, tty: bool = False):
        self.master = None
        slave = -1
        if tty:
            self.master, slave = os.openpty()
        env = dict(os.environ, TERM="xterm")
        shell = subprocess.Popen(["sh", "-c", '"$@" & echo $!', "sh", sys.executable, "-c", _LAUNCH, str(slave), *argv],
                                 cwd=str(cwd), env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                 stderr=subprocess.DEVNULL, pass_fds=(slave,) if slave >= 0 else ())
        self.pid = int(shell.stdout.readline())
        shell.stdout.close()
        shell.wait(10)
        if slave >= 0:
            os.close(slave)
        self.name = os.path.basename(argv[0])
        case.addCleanup(self.stop)
        if self.master is not None:
            threading.Thread(target=self._drain, daemon=True).start()

    def _drain(self):
        while self.master is not None:
            try:
                if not os.read(self.master, 65536):
                    return
            except OSError:
                return

    def type(self, keys: bytes, pause: float = 0.3):
        os.write(self.master, keys)
        time.sleep(pause)

    def alive(self) -> bool:
        try:
            os.kill(self.pid, 0)
        except ProcessLookupError:
            return False
        return True

    def stop(self):
        """Ended by its pid, once its command line says it is the editor this started."""
        try:
            with open(f"/proc/{self.pid}/cmdline", "rb") as handle:
                mine = self.name.encode() in handle.read()
        except OSError:
            mine = self.alive()                    # no /proc: the pid this started, still running
        if mine and self.alive():
            os.kill(self.pid, signal.SIGKILL)
        master, self.master = self.master, None
        if master is not None:
            os.close(master)


def wait_for(predicate, timeout=20.0):
    end = time.time() + timeout
    while time.time() < end:
        if predicate():
            return True
        time.sleep(0.05)
    return False


def vim_es(name: str, *commands: str) -> list[str]:
    """vim in Ex mode on `name`, no vimrc and no viminfo: it waits for the command to start, then runs `commands`.
    'backupskip' is emptied because its default skips /tmp, where these tests' folders are: a file there is
    written in place, a file in any other folder through `4913` and a backup, which is what a project gets."""
    argv = [VIM, "-es", "-N", "-u", "NONE", "-i", "NONE", "-c", "set backupskip=",
            "-c", f"while !filereadable('{FLAG}') | sleep 50m | endwhile"]
    for command in commands:
        argv += ["-c", command]
    return argv + [name]


def until(text: str, name: str) -> str:
    """The command's start: make the flag, then wait (at most 30 s) until the person's save is on disk."""
    return (f"touch {FLAG}; i=0; until grep -q '{text}' {name} || [ $i -ge 600 ]; do sleep 0.05; i=$((i+1)); done; "
            "sleep 0.3; ")


class EditorSavesCase(undo_tests.CommandHelpers, HarnessCase):
    def repo(self, files=None, **config):
        return super().repo(files or {"README.md": "# Billing\n", "rates.py": "REDUCED_RATE = 0.05\n"}, **config)

    def by_command(self, h):
        return {row["path"]: row.get("by_command", False) for row in h.agent.last_turn_files["files"]}

    def question(self, h):
        """The full-screen terminal's /rewind question, as the person reads it."""
        from dgc import tui as tui_mod
        fake = undo_tests.TerminalRewindTests.Fake(SimpleNamespace(checkpoints=h.agent.checkpoints,
                                                                   _turn_files_path=h.agent._turn_files_path))
        tui_mod.TUI._confirm_rewind.__get__(fake)(0)
        return [text.plain for text in fake.overlays[-1][1]["header"]]


@unittest.skipUnless(VIM, "vim is not installed")
class VimSavesTests(EditorSavesCase):
    def test_a_file_saved_in_vim_while_a_command_runs_is_the_persons_and_undo_leaves_it(self):
        h = self.repo()
        root = h.root.resolve()
        vim = Editor(self, vim_es("README.md", "call append('$', 'Saved in vim.')", "w", "sleep 60", "q"), root)
        self.assertTrue(wait_for(lambda: (root / ".README.md.swp").exists()), "vim has README.md open")
        self.turn(h, "long command", ToolCall("b1", "bash", {
            "command": until("Saved in vim", "README.md") + "perl -pi -e 's/0.05/0.07/' rates.py"}))
        self.assertTrue(vim.alive(), "vim is still open on README.md when the command ends")
        self.assertEqual(self.by_command(h), {"rates.py": True}, "README.md is the person's: not the command's")
        header = self.question(h)
        self.assertIn("README.md: edited in vim while a command ran; it is left as it is", header)
        self.assertIn("Also puts back 1 file changed while a command ran: rates.py.", header)
        (count, restored), outcome = self.undo(h)
        self.assertGreaterEqual(count, 0, outcome)
        self.assertEqual((root / "README.md").read_text(), "# Billing\nSaved in vim.\n", "Undo leaves the person's save")
        self.assertEqual((root / "rates.py").read_text(), "REDUCED_RATE = 0.05\n", "and puts the command's back")
        self.assertEqual(outcome["kept"], ["README.md"])
        from dgc import rewind_words
        self.assertEqual(rewind_words.done(restored, kept_paths=outcome["kept"]),
                         "↩ Undone; DGC restored 1 file. README.md was left as it is.")

    @unittest.skipUnless(LINUX, "the names a finished save leaves are heard on Linux only (inotify)")
    def test_vim_saving_and_quitting_during_the_command_is_heard_too(self):
        h = self.repo()
        root = h.root.resolve()
        vim = Editor(self, vim_es("README.md", "call append('$', 'Saved in vim, then :wq.')", "wq"), root)
        self.turn(h, "long command", ToolCall("b1", "bash", {
            "command": until(":wq", "README.md") + "perl -pi -e 's/0.05/0.07/' rates.py"}))
        self.assertTrue(wait_for(lambda: not vim.alive(), 10), "vim quit inside the command")
        self.assertFalse((root / ".README.md.swp").exists(), "nothing of vim's is left at the command's end")
        self.assertEqual(self.by_command(h), {"rates.py": True})
        self.assertGreaterEqual(self.undo(h)[0][0], 0)
        self.assertEqual((root / "README.md").read_text(), "# Billing\nSaved in vim, then :wq.\n")
        self.assertEqual((root / "rates.py").read_text(), "REDUCED_RATE = 0.05\n")

    def test_a_file_dgc_wrote_that_the_person_then_saves_in_vim_makes_undo_merge(self):
        # DGC's own edit, then the person opens the file in vim while a command runs and adds a line: not re-noted
        # as DGC's, so Undo takes DGC's edit out and keeps the person's line (it put the whole turn back, their
        # line too).
        h = self.repo({"a.py": undo_tests.MODULE.decode()})
        root = h.root.resolve()

        def person():
            if wait_for(lambda: (root / FLAG).exists()):
                Editor(self, vim_es("a.py", "call append('$', '# the person, in vim')", "w", "sleep 60", "q"), root)
        worker = threading.Thread(target=person, daemon=True)
        worker.start()
        self.turn(h, "edit then run", ToolCall("e1", "edit_file", {"path": "a.py", "old_string": "0.18",
                                                                  "new_string": "0.2"}),
                  ToolCall("b1", "bash", {"command": until("the person", "a.py") + "true"}))
        worker.join(10)
        (count, restored), outcome = self.undo(h)
        self.assertGreaterEqual(count, 0, outcome)
        self.assertEqual(outcome["merged"], ["a.py"])
        self.assertEqual((root / "a.py").read_text(), undo_tests.MODULE.decode() + "# the person, in vim\n")

    def test_the_commands_own_write_with_vim_open_on_the_file_is_still_the_commands(self):
        # vim has rates.py open and does nothing while the command changes it: the change is the command's.
        h = self.repo()
        root = h.root.resolve()
        vim = Editor(self, [VIM, "-es", "-N", "-u", "NONE", "-i", "NONE", "-c", "sleep 60", "-c", "q", "rates.py"],
                     root)
        self.assertTrue(wait_for(lambda: (root / ".rates.py.swp").exists()), "vim has rates.py open")
        self.turn(h, "sed", ToolCall("b1", "bash", {"command": "sleep 0.3; perl -pi -e 's/0.05/0.07/' rates.py"}))
        self.assertTrue(vim.alive())
        self.assertEqual(self.by_command(h), {"rates.py": True})
        self.assertGreaterEqual(self.undo(h)[0][0], 0)
        self.assertEqual((root / "rates.py").read_text(), "REDUCED_RATE = 0.05\n", "Undo puts the command's back")

    def test_a_file_opened_in_vim_to_read_it_during_the_command_is_still_the_commands(self):
        # The command changes rates.py; then the person opens it in vim to look. vim writes its swap and records the
        # file's time when it opens a file, but that swap is younger than the change: not the person's edit.
        h = self.repo()
        root = h.root.resolve()
        opened = []

        def route(messages, results, cancel):
            if not results:
                return ChatResult(tool_calls=[ToolCall("b1", "bash", {"command": (
                    "perl -pi -e 's/0.05/0.07/' rates.py; touch .git/dgc-changed; "
                    "until [ -e .git/dgc-opened ]; do sleep 0.05; done; sleep 0.3")})])
            return ChatResult(content="Done.")

        def person():
            if wait_for(lambda: (root / ".git" / "dgc-changed").exists()):
                time.sleep(1.2)                    # a moment later: not the same tick as the change
                opened.append(Editor(self, [VIM, "-es", "-N", "-u", "NONE", "-i", "NONE", "-c", "sleep 60",
                                            "-c", "q", "rates.py"], root))
                wait_for(lambda: (root / ".rates.py.swp").exists())
                time.sleep(0.3)
            (root / ".git" / "dgc-opened").touch()
        worker = threading.Thread(target=person, daemon=True)
        worker.start()
        self.assertTrue(h.run("sed then read", [("sed then read", route)]))
        worker.join(30)
        self.assertTrue(opened and opened[0].alive(), "vim had rates.py open at the command's end")
        self.assertEqual(self.by_command(h), {"rates.py": True})
        self.assertGreaterEqual(self.undo(h)[0][0], 0)
        self.assertEqual((root / "rates.py").read_text(), "REDUCED_RATE = 0.05\n")

    def test_a_command_that_runs_vim_itself_is_the_commands(self):
        h = self.repo()
        root = h.root.resolve()
        self.turn(h, "vim in a command", ToolCall("b1", "bash", {
            "command": f"{VIM} -es -N -u NONE -i NONE -c '%s/0.05/0.07/' -c wq rates.py"}))
        self.assertEqual((root / "rates.py").read_text(), "REDUCED_RATE = 0.07\n")
        self.assertEqual(self.by_command(h), {"rates.py": True}, "its own vim: the command's change")
        self.assertGreaterEqual(self.undo(h)[0][0], 0)
        self.assertEqual((root / "rates.py").read_text(), "REDUCED_RATE = 0.05\n")

    def test_a_file_the_command_deletes_while_vim_has_unsaved_changes_in_it_comes_back(self):
        # The person is typing in rates.py in vim (unsaved) when the command removes it: an editor does not delete
        # the file it edits, so the removal is the command's, and Undo brings the file back.
        h = self.repo()
        root = h.root.resolve()
        Editor(self, [VIM, "-es", "-N", "-u", "NONE", "-i", "NONE", "-c", "call append('$', '# typing')",
                      "-c", "sleep 60", "-c", "q!", "rates.py"], root)
        self.assertTrue(wait_for(lambda: (root / ".rates.py.swp").exists()
                                 and (root / ".rates.py.swp").read_bytes()[1007:1008] == b"\x55"),
                        "vim has unsaved changes in rates.py")
        self.turn(h, "remove", ToolCall("b1", "bash", {"command": "rm rates.py"}))
        self.assertEqual(self.by_command(h), {"rates.py": True})
        self.assertGreaterEqual(self.undo(h)[0][0], 0)
        self.assertEqual((root / "rates.py").read_text(), "REDUCED_RATE = 0.05\n")

    def test_the_note_survives_a_restart(self):
        h = self.repo()
        root = h.root.resolve()
        Editor(self, vim_es("README.md", "call append('$', 'Saved in vim.')", "w", "sleep 60", "q"), root)
        self.turn(h, "long command", ToolCall("b1", "bash", {
            "command": until("Saved in vim", "README.md") + "perl -pi -e 's/0.05/0.07/' rates.py"}))
        state = json.loads(json.dumps(h.agent.checkpoints.state()))
        revived = CheckpointManager.from_state(state, root)
        self.assertEqual(revived.undo_question(0, h.agent._turn_files_path).get("elsewhere"),
                         [{"path": "README.md", "editor": "vim"}])
        self.assertGreaterEqual(revived.rewind(0)[0], 0)
        self.assertEqual((root / "README.md").read_text(), "# Billing\nSaved in vim.\n")
        self.assertEqual(revived.last_rewind_kept, [str(root / "README.md")])


@unittest.skipUnless(NANO, "nano is not installed")
class NanoSavesTests(EditorSavesCase):
    def nano(self, root, *flags):
        return Editor(self, [NANO, "--ignorercfiles", *flags, "README.md"], root, tty=True)

    def save(self, h, editor, text):
        """The person types `text` at the top of README.md in nano and saves it (^O, Enter), once the command runs."""
        root = h.root.resolve()

        def person():
            if wait_for(lambda: (root / FLAG).exists()):
                editor.type(text.encode() + b"\r")
                editor.type(b"\x0f", 0.4)
                editor.type(b"\r", 0.6)
        worker = threading.Thread(target=person, daemon=True)
        worker.start()
        return worker

    def test_a_save_in_nano_with_locking_is_the_persons(self):
        h = self.repo()
        root = h.root.resolve()
        nano = self.nano(root, "--locking")
        self.assertTrue(wait_for(lambda: (root / ".README.md.swp").exists()), "nano's lock")
        worker = self.save(h, nano, "Typed in nano.")
        self.turn(h, "long command", ToolCall("b1", "bash", {
            "command": until("Typed in nano", "README.md") + "perl -pi -e 's/0.05/0.07/' rates.py"}))
        worker.join(10)
        self.assertEqual(self.by_command(h), {"rates.py": True})
        self.assertIn("README.md: edited in nano while a command ran; it is left as it is", self.question(h))
        self.assertGreaterEqual(self.undo(h)[0][0], 0)
        self.assertEqual((root / "README.md").read_text(), "Typed in nano.\n# Billing\n")

    def test_nano_without_locking_leaves_no_trace_and_stays_by_time(self):
        # The honest gap: nano by default writes the file in place and leaves nothing. As today, the file is taken
        # for the command's by time, and Undo's question names it with "Keep the ones I edited…".
        h = self.repo()
        root = h.root.resolve()
        nano = self.nano(root)
        time.sleep(0.8)
        worker = self.save(h, nano, "Typed in nano.")
        self.turn(h, "long command", ToolCall("b1", "bash", {"command": until("Typed in nano", "README.md") + "true"}))
        worker.join(10)
        self.assertEqual(self.by_command(h), {"README.md": True}, "by time, as before")
        self.assertIn("Also puts back 1 file changed while a command ran: README.md.", self.question(h))


class NamedLikeATraceTests(EditorSavesCase):
    def test_a_real_file_named_like_a_swap_that_a_command_removes_comes_back(self):
        # `.schema.sql` has the shape of a vim swap's name (`.x.s??`). It is the person's own file, not a swap:
        # the command's `rm` is undone, as before.
        h = self.repo()
        root = h.root.resolve()
        (root / ".schema.sql").write_text("CREATE TABLE rates (rate real);\n")      # untracked, uncommitted work
        self.turn(h, "clean up", ToolCall("b1", "bash", {"command": "rm .schema.sql"}))
        self.assertEqual(self.by_command(h), {".schema.sql": True})
        self.assertGreaterEqual(self.undo(h)[0][0], 0)
        self.assertEqual((root / ".schema.sql").read_text(), "CREATE TABLE rates (rate real);\n")


class UnrelatedWriterTests(EditorSavesCase):
    def test_a_process_with_no_editor_traces_stays_by_time(self):
        # Another process that is not an editor writes a tracked file while the command runs: nothing without
        # privileges tells it from the command, so it stays the command's by time, named by Undo's question.
        h = self.repo()
        root = h.root.resolve()
        script = (f"import os, time\nwhile not os.path.exists({FLAG!r}): time.sleep(0.05)\n"
                  "open('README.md', 'a').write('appended by another program\\n')\n")
        Editor(self, [sys.executable, "-c", script], root)
        self.turn(h, "long command", ToolCall("b1", "bash", {"command": until("another program", "README.md") + "true"}))
        self.assertEqual(self.by_command(h), {"README.md": True})


class ElsewhereNoteTests(unittest.TestCase):
    """The point's note of a file the person edited in another editor: named by Undo's question, left by Undo, saved
    with the session and checked when it is loaded."""

    def chat(self):
        c = undo_tests.Chat(self, {"a.py": b"a\n", "README.md": b"# r\n"})
        c.turn("t0")
        c.write("a.py", b"A\n")
        self.assertTrue(c.cp.note_elsewhere(str(c.p("README.md")), "vim"))
        c.p("README.md").write_bytes(b"# r\nmine\n")
        return c

    def test_named_left_and_saved(self):
        from dgc import rewind_words
        c = self.chat()
        self.assertFalse(c.cp.note_elsewhere(str(c.p("a.py")), "vim"), "a file the point restores needs no note")
        question = c.cp.undo_question(0, lambda path: Path(path).name)
        self.assertEqual(question["elsewhere"], [{"path": "README.md", "editor": "vim"}])
        self.assertEqual(rewind_words.question_lines(question),
                         ["README.md: edited in vim while a command ran; it is left as it is"])
        c.restart()
        self.assertEqual(c.cp.undo_question(0)["elsewhere"], [{"path": str(c.p("README.md")), "editor": "vim"}])
        self.assertGreaterEqual(c.cp.rewind(0)[0], 0)
        self.assertEqual((c.p("a.py").read_bytes(), c.p("README.md").read_bytes()), (b"a\n", b"# r\nmine\n"))
        self.assertEqual(c.cp.last_rewind_kept, [str(c.p("README.md"))])

    def test_a_malformed_note_refuses_the_saved_state(self):
        c = self.chat()
        state = json.loads(json.dumps(c.cp.state()))
        self.assertEqual(state["points"][0]["elsewhere"], {"README.md": "vim"})
        for bad in ({"README.md": 7}, {"README.md": ""}, {"a.py": "vim"}, {"../outside.py": "vim"}, ["README.md"]):
            broken = json.loads(json.dumps(state))
            broken["points"][0]["elsewhere"] = bad
            self.assertEqual(CheckpointManager.from_state(broken, c.root).points, [], bad)


# ---------------------------------------------------------------------------------------------------
# dgc/editor_traces.py itself
# ---------------------------------------------------------------------------------------------------
def swap_block(pid: int, name: str, *, dirty=False, wrote=0, version=b"VIM 9.1", user=None, host=None) -> bytes:
    """A vim-format swap's first block, as vim and nano write it."""
    import getpass
    block = bytearray(4096)
    block[0:2] = b"b0"
    block[2:2 + len(version)] = version
    block[12:16] = (4096).to_bytes(4, "little")
    block[16:20] = int(wrote).to_bytes(4, "little")
    block[24:28] = int(pid).to_bytes(4, "little")
    user_bytes = (user if user is not None else getpass.getuser()).encode()
    host_bytes = (host if host is not None else socket.gethostname()).encode()
    block[28:28 + len(user_bytes)] = user_bytes
    block[68:68 + len(host_bytes)] = host_bytes
    block[108:108 + len(name)] = name.encode()
    block[1007] = 0x55 if dirty else 0
    return bytes(block)


class TracesTests(unittest.TestCase):
    def setUp(self):
        from dgc import editor_traces
        self.et = editor_traces
        folder = tempfile.TemporaryDirectory(prefix="dgc-traces-")
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name).resolve()
        home = tempfile.TemporaryDirectory(prefix="dgc-traces-home-")
        self.addCleanup(home.cleanup)
        env = patch.dict(os.environ, {"HOME": home.name, "XDG_STATE_HOME": "", "XDG_DATA_HOME": ""})
        env.start()
        self.addCleanup(env.stop)
        self.home = Path(home.name)
        self.file = self.root / "a.py"
        self.file.write_text("x = 1\n")

    def person(self):
        """A live process that is not this one's child: what an editor the person runs is."""
        return Editor(self, [sys.executable, "-c", "import time; time.sleep(60)"], self.root).pid

    def traces(self, start=None, end=None, events=None, command=""):
        now = time.time()
        return self.et.Traces(now - 5 if start is None else start, now + 1 if end is None else end, events, command)

    @unittest.skipUnless(VIM, "vim is not installed")
    def test_a_real_vim_swap_is_read(self):
        vim = Editor(self, [VIM, "-es", "-N", "-u", "NONE", "-i", "NONE", "-c", "sleep 30", "-c", "q", "a.py"],
                     self.root)
        self.assertTrue(wait_for(lambda: (self.root / ".a.py.swp").exists()))
        block = self.et._block0(self.root / ".a.py.swp")
        self.assertEqual((block["pid"], os.path.basename(block["name"]), block["dirty"]), (vim.pid, "a.py", False))
        self.assertTrue(block["version"].startswith("VIM"))
        self.assertEqual(self.et.owner(vim.pid, block["mtime"]), "person")
        self.assertIsNone(self.traces().editor_of(self.file), "open and idle is not an edit")

    def test_who_a_swap_names(self):
        self.assertEqual(self.et.owner(os.getpid()), "dgc")
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
        self.addCleanup(child.wait)
        self.addCleanup(child.kill)
        if LINUX:
            self.assertEqual(self.et.owner(child.pid), "dgc", "a process this DGC started: a command's editor")
        person = self.person()
        self.assertEqual(self.et.owner(person), "person")
        if LINUX:
            self.assertEqual(self.et.owner(person, since=time.time() - 120), "gone",
                             "a pid that started after the swap was last written is a recycled one")
        dead = subprocess.Popen([sys.executable, "-c", "pass"])
        dead.wait()
        self.assertEqual(self.et.owner(dead.pid), "gone")

    def later(self):
        """A command that runs from 10 to 20 seconds from now: every trace made here is older than it."""
        return self.traces(start=time.time() + 10, end=time.time() + 20)

    def test_unsaved_changes_in_a_live_editor_are_evidence_and_a_stale_swap_is_not(self):
        swap = self.root / ".a.py.swp"
        swap.write_bytes(swap_block(self.person(), "~/a.py", dirty=True))
        self.assertEqual(self.later().editor_of(self.file), "vim", "unsaved changes now, whenever they were made")
        swap.write_bytes(swap_block(self.person(), "~/a.py", dirty=False))
        self.assertIsNone(self.later().editor_of(self.file), "open and saved before the command: not this one's edit")
        dead = subprocess.Popen([sys.executable, "-c", "pass"])
        dead.wait()
        swap.write_bytes(swap_block(dead.pid, "~/a.py", dirty=True))
        self.assertIsNone(self.later().editor_of(self.file), "a crash's leftover, written before the command")
        swap.write_bytes(swap_block(os.getpid(), "~/a.py", dirty=True))
        self.assertIsNone(self.later().editor_of(self.file), "this DGC's own")
        swap.write_bytes(swap_block(self.person(), "~/b.py", dirty=True))
        self.assertIsNone(self.later().editor_of(self.file), "another file's swap")
        swap.write_bytes(swap_block(self.person(), "~/a.py", dirty=True, host="elsewhere.example"))
        self.assertIsNone(self.later().editor_of(self.file), "another host's pid says nothing here")

    def test_a_swap_written_as_the_file_changed_is_a_save(self):
        swap = self.root / ".a.py.swp"
        person = self.person()
        swap.write_bytes(swap_block(person, "a.py"))
        time.sleep(0.2)
        self.file.write_text("x = 2\n")             # the save; vim rewrites its swap just after it
        changed = os.stat(self.file).st_ctime
        os.utime(swap, (changed + 0.003,) * 2)
        self.assertEqual(self.traces().editor_of(self.file), "vim")
        self.assertIsNone(self.traces(start=time.time() + 30, end=time.time() + 40).editor_of(self.file),
                          "outside the command's window")
        os.utime(swap, (changed - 0.5,) * 2)
        self.assertIsNone(self.traces().editor_of(self.file), "written half a second before: vim opening the file")
        # vim's own record of its write: the file's mtime and inode, a few seconds after the save.
        info = os.stat(self.file)
        swap.write_bytes(swap_block(person, "a.py", wrote=int(info.st_mtime)))
        block = bytearray(swap.read_bytes())
        block[20:24] = (info.st_ino & 0xFFFFFFFF).to_bytes(4, "little")
        swap.write_bytes(bytes(block))
        os.utime(swap, (changed + 4,) * 2)
        with patch.object(self.et, "_born", lambda path: changed + 1):
            self.assertIsNone(self.traces().editor_of(self.file), "a swap younger than the change: opened to read")
        with patch.object(self.et, "_born", lambda path: changed - 60):
            self.assertEqual(self.traces().editor_of(self.file), "vim", "a swap older than the change: vim wrote it")
        block[20:24] = ((info.st_ino + 1) & 0xFFFFFFFF).to_bytes(4, "little")
        swap.write_bytes(bytes(block))
        os.utime(swap, (changed + 4,) * 2)
        with patch.object(self.et, "_born", lambda path: changed - 60):
            self.assertIsNone(self.traces().editor_of(self.file), "another inode: what vim wrote is not there now")

    def test_nano_and_neovim_and_emacs(self):
        swap = self.root / ".a.py.swp"
        swap.write_bytes(swap_block(self.person(), "a.py", dirty=True, version=b"nano 7.2"))
        self.assertEqual(self.later().editor_of(self.file), "nano")
        swap.unlink()
        folder = self.home / ".local" / "state" / "nvim" / "swap"
        folder.mkdir(parents=True)
        (folder / (str(self.file).replace("/", "%") + ".swp")).write_bytes(
            swap_block(self.person(), str(self.file), dirty=True))
        self.assertEqual(self.later().editor_of(self.file), "Neovim")
        shutil.rmtree(folder)
        import getpass
        lock = self.root / ".#a.py"
        os.symlink(f"{getpass.getuser()}@{socket.gethostname()}.{self.person()}:1", lock)
        self.assertEqual(self.later().editor_of(self.file), "Emacs", "a live Emacs with unsaved changes")
        lock.unlink()
        os.symlink(f"{getpass.getuser()}@{socket.gethostname()}.{os.getpid()}:1", lock)
        self.assertIsNone(self.traces().editor_of(self.file), "this DGC's own")
        lock.unlink()
        os.symlink(f"someone@another-host.example.4242:1", lock)
        self.assertEqual(self.traces().editor_of(self.file), "Emacs", "another host's Emacs, locked in the window")
        self.assertIsNone(self.later().editor_of(self.file), "and not in a later one")

    def test_what_came_and_went_during_the_command(self):
        def events(*entries, folder=None):
            return self.et.Events({str(folder or self.root): [(name, mask, cookie) for name, mask, cookie in entries]})
        create, delete, moved_from, moved_to = 0x100, 0x200, 0x40, 0x80
        vim_save = events(("4913", create, 0), ("4913", delete, 0), ("a.py", moved_from, 7), ("a.py~", moved_to, 7),
                          ("a.py", create, 0), ("a.py~", delete, 0), (".a.py.swp", delete, 0))
        self.assertEqual(self.traces(events=vim_save).editor_of(self.file), "vim")
        self.assertIsNone(self.traces(events=vim_save, command="vim -es -c wq a.py").editor_of(self.file),
                          "the command ran vim itself")
        self.assertIsNone(self.traces(events=events((".a.py.swp", create, 0), (".a.py.swp", delete, 0)))
                          .editor_of(self.file), "vim opened and closed it: not a save")
        self.assertIsNone(self.traces(events=events(("sedXyZ123", create, 0), ("sedXyZ123", moved_from, 3),
                                                    ("a.py", moved_to, 3))).editor_of(self.file), "sed -i")
        self.assertEqual(self.traces(events=events((".#a.py", delete, 0))).editor_of(self.file), "Emacs")
        self.assertEqual(self.traces(events=events(("a.py___jb_tmp___", create, 0))).editor_of(self.file),
                         "a JetBrains IDE")
        self.assertEqual(self.traces(events=events((".goutputstream-ABC123", moved_from, 9), ("a.py", moved_to, 9)))
                         .editor_of(self.file), "another editor")
        self.assertIsNone(self.traces(events=vim_save).editor_of(self.root / "b.py"), "another file in the folder")

    def test_an_editors_own_files_are_traces(self):
        person = self.person()
        live = swap_block(person, "a.py")
        (self.root / ".a.py.swp").write_bytes(live)
        traces = self.traces()
        self.assertTrue(traces.is_trace(self.root / ".a.py.swp"), "a live vim's swap")
        self.assertTrue(traces.is_trace(self.root / ".b.py.swp", ("file", live)),
                        "a swap that is gone (vim closed the file), shown to be one by its copy from before")
        self.assertFalse(traces.is_trace(self.root / ".b.py.swp"), "gone, with nothing to show it was a swap")
        self.assertFalse(traces.is_trace(self.root / ".schema.sql", ("file", b"CREATE TABLE t (x int);\n")),
                         "a real file named like a swap, removed by the command: Undo puts it back")
        (self.root / ".c.py.swp").write_bytes(swap_block(os.getpid(), "c.py"))
        self.assertFalse(traces.is_trace(self.root / ".c.py.swp"), "this DGC's own vim's")
        (self.root / ".notes.sql").write_text("select 1;\n")
        self.assertFalse(self.traces().is_trace(self.root / ".notes.sql"), "a real file, there, named like a swap")
        import getpass
        lock = f"{getpass.getuser()}@{socket.gethostname()}.{person}:1"
        os.symlink(lock, self.root / ".#a.py")
        self.assertTrue(self.traces().is_trace(self.root / ".#a.py"), "a live Emacs's lock")
        self.assertTrue(self.traces().is_trace(self.root / ".#b.py", ("symlink", lock.encode())), "a lock gone")
        (self.root / "#a.py#").write_text("auto-saved\n")
        (self.root / ".a.py.kate-swp").write_bytes(b"kate")
        for name in ("#a.py#", ".a.py.kate-swp"):
            self.assertTrue(self.traces().is_trace(self.root / name), name)
        (self.root / "#todo#").write_text("a file of the person's\n")
        for name in ("a.py", "a.py~", "4913", "#todo#", ".goutputstream-AB12CD", "a.py___jb_tmp___"):
            self.assertFalse(self.traces().is_trace(self.root / name, ("file", b"x")), name)

    def test_it_never_raises(self):
        (self.root / ".a.py.swp").write_bytes(b"\xff" * 2048)
        os.symlink("not-an-emacs-lock", self.root / ".#a.py")
        self.assertIsNone(self.traces().editor_of(self.file))
        self.assertIsNone(self.traces().editor_of("\0bad"))
        self.assertIsNone(self.traces(command=None).editor_of(self.root / "missing.py"))

    @unittest.skipUnless(LINUX, "inotify")
    def test_the_listener_hears_names_and_closes(self):
        fds = len(os.listdir("/proc/self/fd"))
        listener = self.et.listen([str(self.root), str(self.root / "missing")])
        self.assertIsNotNone(listener)
        (self.root / "4913").write_text("")
        (self.root / "4913").unlink()
        heard = listener.stop()
        self.assertEqual([name for name, _mask, _cookie in heard.folders[str(self.root)]], ["4913", "4913"])
        self.assertEqual(len(os.listdir("/proc/self/fd")), fds, "its descriptor is closed")
        listener.stop()                             # twice is harmless
        many = [str(self.root)] * 1 + [str(self.root / f"d{n}") for n in range(300)]
        for folder in many[1:]:
            os.mkdir(folder)
        bounded = self.et.listen(many, cap=10)
        self.assertEqual(len(bounded.wds), 10)
        bounded.close()
        quick = self.et.listen(many, budget_s=0.0)
        self.assertEqual(list(quick.wds.values()), [str(self.root)], "no time: the first folder only")
        quick.close()

    def test_macos_has_the_end_of_command_checks_only(self):
        mac = SimpleNamespace(platform="darwin")
        with patch.object(self.et, "sys", mac), patch.object(self.et, "_CALLS", []):
            self.assertIsNone(self.et.listen([str(self.root)]), "no inotify")
            swap = self.root / ".a.py.swp"
            swap.write_bytes(swap_block(self.person(), "a.py", dirty=True))
            self.assertEqual(self.later().editor_of(self.file), "vim", "a live vim with unsaved changes")
            self.assertEqual(self.et.owner(os.getpid()), "dgc")

    def test_tracked_folder_listing_uses_its_own_limit(self):
        from dgc import worktree
        paths = b"\0".join(f"dir{n:05d}".encode() for n in range(4097)) + b"\0"
        result = subprocess.CompletedProcess([], 0, paths, b"")
        with patch.object(worktree, "_git_bytes", return_value=result):
            folders = self.et.tracked_folders(self.root, "test-head-4097", Path("."), ask=True)
        self.assertEqual(len(folders), 4097)


class OverheadTests(EditorSavesCase):
    def test_the_listener_stays_inside_its_budget(self):
        from dgc import command_watch, editor_traces
        h = self.repo()
        for n in range(40):
            (h.root / f"pkg{n}").mkdir()
            (h.root / f"pkg{n}" / "m.py").write_text("x\n")
        undo_tests.run_git(h.root, "add", "-A")
        undo_tests.run_git(h.root, "commit", "-qm", "more")
        watches = []
        real = command_watch.Watch.finish

        def finish(watch):
            watches.append(watch)
            return real(watch)
        with patch.object(command_watch.Watch, "finish", finish):
            self.turn(h, "two commands", ToolCall("b1", "bash", {"command": "true"}),
                      ToolCall("b2", "bash", {"command": "true"}))
        self.assertEqual(len(watches), 2)
        for watch in watches:
            self.assertLess(watch.listen_s, editor_traces.LISTEN_BUDGET_S + 0.01)
            self.assertIsNone(watch.listener, "closed when the command ended")
        if LINUX:
            # The first command watches the project and the folders of its changed files; Git is asked after it for
            # every folder it tracks, so the second watches all 41 of them too.
            self.assertGreaterEqual(watches[0].listen_folders, 1)
            self.assertGreaterEqual(watches[1].listen_folders, 41)
        costs = h.agent.__dict__.get("_command_watch_costs")
        self.assertTrue(all(cost < 2.0 for cost in costs), costs)


if __name__ == "__main__":
    unittest.main()
