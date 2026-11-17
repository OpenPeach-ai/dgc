"""A Pip's computer keeps working in a process that holds many files (18 Nov).

select() refuses a descriptor above 1024 ("filedescriptor out of range in select()"). A busy Pips supervisor holds that
many (its runs, their sockets and pipes), and the full test run hit it: a Pip browser's devtools pipe and the egress
proxy's pump then failed. They wait with poll(), which has no such limit.
"""
from __future__ import annotations

import json
import os
import resource
import socket
import sys
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dgc import pip_computer_box as box  # noqa: E402

HIGH = 1500


class HighDescriptors(unittest.TestCase):
    def setUp(self):
        soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
        if hard != resource.RLIM_INFINITY and hard <= HIGH + 10:
            self.skipTest("this system won't allow a descriptor that high")
        if soft != resource.RLIM_INFINITY and soft <= HIGH + 10:
            resource.setrlimit(resource.RLIMIT_NOFILE, (HIGH + 64, hard))
            self.addCleanup(resource.setrlimit, resource.RLIMIT_NOFILE, (soft, hard))

    def high(self, fd: int, at: int) -> int:
        moved = os.dup2(fd, at)
        os.close(fd)
        self.addCleanup(lambda: os.close(moved) if _open(moved) else None)
        return moved

    def test_a_devtools_pipe_above_1024_still_reads(self):
        read_fd, write_fd = os.pipe()
        read_fd = self.high(read_fd, HIGH)
        self.addCleanup(os.close, write_fd)
        pipe = box._Pipe(read_fd, write_fd)
        pipe.settimeout(5)
        os.write(write_fd, json.dumps({"id": 1, "result": {"ok": True}}).encode() + b"\0")
        self.assertEqual(pipe.recv(), {"id": 1, "result": {"ok": True}})

    def test_the_proxy_pump_above_1024_still_carries_bytes(self):
        a1, a2 = socket.socketpair()
        b1, b2 = socket.socketpair()
        a = socket.socket(fileno=self.high(os.dup(a1.fileno()), HIGH + 1))
        b = socket.socket(fileno=self.high(os.dup(b1.fileno()), HIGH + 2))
        a1.close(); b1.close()
        self.addCleanup(a2.close); self.addCleanup(b2.close)
        a2.settimeout(5); b2.settimeout(5)            # a pump that died fails the test, never hangs it
        done = {}
        worker = threading.Thread(target=lambda: done.update(counts=box.EgressProxy._pump(a, b)), daemon=True)
        worker.start()
        a2.sendall(b"hello from the box")
        self.assertEqual(b2.recv(64), b"hello from the box")
        b2.sendall(b"and back")
        self.assertEqual(a2.recv(64), b"and back")
        a2.close()
        worker.join(5)
        self.assertFalse(worker.is_alive(), "the pump ends when one side does")
        self.assertEqual(done["counts"], (len(b"hello from the box"), len(b"and back")))


def _open(fd: int) -> bool:
    try:
        os.fstat(fd)
        return True
    except OSError:
        return False


if __name__ == "__main__":
    unittest.main()
