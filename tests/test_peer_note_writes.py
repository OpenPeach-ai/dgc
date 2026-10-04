"""A peer note stays JSON while two threads of one DGC refresh it at once (the heartbeat and a
status change); a shared temp file left a longer record's tail behind a shorter one."""
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import peers


class PeerNoteWriteTests(unittest.TestCase):
    def test_concurrent_refreshes_always_leave_a_whole_note(self):
        temp = tempfile.TemporaryDirectory(prefix="dgc-peers-")
        self.addCleanup(temp.cleanup)
        directory = Path(temp.name) / "peers"
        stop, bad = threading.Event(), []

        def refresh(long):
            sessions = [{"session": f"s{i}", "cwd": "/w" * (60 if long else 1), "status": "busy"} for i in range(8 if long else 1)]
            while not stop.is_set():
                peers.announce(kind="serve", session="s", cwd="/w", status="busy" if long else "idle", sessions=sessions)

        with patch.object(peers, "peers_dir", lambda: directory):
            writers = [threading.Thread(target=refresh, args=(n % 2 == 0,)) for n in range(4)]
            for thread in writers:
                thread.start()
            try:
                for _ in range(400):
                    path = next(directory.glob("[0-9]*.json"), None)
                    if path is None:
                        continue
                    try:
                        json.loads(path.read_text())
                    except FileNotFoundError:
                        continue
                    except ValueError as exc:
                        bad.append(str(exc))
            finally:
                stop.set()
                for thread in writers:
                    thread.join()
        self.assertEqual(bad, [], "every note read was whole JSON")
        self.assertEqual(sorted(p.name for p in directory.iterdir() if p.name.endswith(".tmp")), [], "no temp file left")


if __name__ == "__main__":
    unittest.main()
