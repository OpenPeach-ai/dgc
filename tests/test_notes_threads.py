"""The project's note store is one SQLite connection used from several threads: a turn's worker writes notes, a tool's
thread reads them, and the thread that closes a chat closes the store. sqlite3 refused all but the opening thread, so a
note written from another thread was dropped without a word, and close() from the closing thread was refused too: the
file stayed open until the garbage collector found it (a long-running backend collected one per chat)."""
import gc
import os
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import notes, sessions


def notes_files_open() -> int:
    count = 0
    for name in os.listdir("/proc/self/fd"):
        try:
            if os.readlink(f"/proc/self/fd/{name}").endswith("notes.sqlite"):
                count += 1
        except OSError:
            pass
    return count


@unittest.skipUnless(os.path.isdir("/proc/self/fd"), "counts the process's open files through /proc")
class NoteStoreThreadTests(unittest.TestCase):
    def setUp(self):
        tmp = Path(tempfile.mkdtemp(prefix="dgc-notes-threads-")).resolve()
        scoped = patch.object(sessions, "SESSIONS_DIR", tmp / "sessions")
        scoped.start()
        self.addCleanup(scoped.stop)
        (tmp / "project").mkdir()
        notes.notes_path(tmp / "project").parent.mkdir(parents=True, exist_ok=True)   # a session made it, in real use
        self.store = notes.NoteStore(tmp / "project")
        self.addCleanup(self.store.close)

    def in_thread(self, fn):
        out = []
        worker = threading.Thread(target=lambda: out.append(fn()))
        worker.start()
        worker.join(10)
        return out[0]

    def test_a_note_written_from_another_thread_is_kept(self):
        self.assertIsNotNone(self.store.add("outcome", "opened here", tool="bash"))
        written = self.in_thread(lambda: self.store.add("outcome", "written from a worker", tool="bash"))
        self.assertIsNotNone(written, "a worker's note was dropped")
        self.assertEqual(self.in_thread(self.store.count), 2, "and another thread reads both")

    def test_close_from_another_thread_lets_go_of_the_file_at_once(self):
        gc.disable()                       # the garbage collector must not be what closes it
        self.addCleanup(gc.enable)
        before = notes_files_open()
        self.store.add("outcome", "the build uses make", tool="bash")
        self.assertEqual(notes_files_open(), before + 1)
        self.in_thread(self.store.close)
        self.assertEqual(notes_files_open(), before, "closing from the chat's closing thread left the file open")

    def test_many_threads_writing_at_once_lose_nothing(self):
        def write(n):
            return [self.store.add("outcome", f"note {n}-{i}", tool="bash") for i in range(20)]
        workers = [threading.Thread(target=write, args=(n,)) for n in range(6)]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join(20)
        self.assertEqual(self.store.count(), 120)


if __name__ == "__main__":
    unittest.main()
