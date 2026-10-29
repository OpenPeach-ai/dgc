"""The editor's artifact_* commands: every answer is a valid protocol event, a stale editor save writes nothing,
and the slow ones (export, open) answer later without holding the wire."""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import dgc.artifacts as A
from dgc import artifact_service as S
from dgc.artifact_commands import CAPABILITY, ArtifactCommands
from dgc.editor_protocol import command_error, event_error


class Wire:
    def __init__(self):
        self.events, self.lock = [], threading.Lock()

    def emit(self, kind, **fields):
        event = {"type": kind, "seq": 1, **fields}
        problem = event_error(event)
        assert problem is None, problem
        with self.lock:
            self.events.append(event)

    def wait(self, kind, request_id, seconds=30.0):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            with self.lock:
                for event in self.events:
                    if event.get("request_id") == request_id and event["type"] in (kind, "command_rejected"):
                        return event
            time.sleep(0.05)
        raise AssertionError(f"no {kind} for {request_id}")


class ArtifactCommandsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(os.path.realpath(tempfile.mkdtemp(prefix="dgc-artcmd-")))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self._env = os.environ.get("DGC_HOME")
        os.environ["DGC_HOME"] = str(self.tmp)
        self._server, A._SRV = A._SRV, A._Server(persistent=False)
        self.wire = Wire()
        self.commands = ArtifactCommands(self.wire.emit)
        self.doc = S.make("doc", "Plan", "# Plan\n\nOne.\n", origin={"surface": "chat", "chat": "c"})

    def tearDown(self):
        A._SRV.shutdown()
        A._SRV = self._server
        if self._env is None:
            os.environ.pop("DGC_HOME", None)
        else:
            os.environ["DGC_HOME"] = self._env

    def send(self, cmd):
        self.assertIsNone(command_error(cmd), cmd)
        self.commands.dispatch(cmd)

    def test_the_capability_names_every_type_output_and_export(self):
        caps = CAPABILITY["artifacts"]
        self.assertEqual(set(caps["types"]), {"page", "doc", "slides", "sheet", "dashboard"})
        self.assertIn("slides", caps["outputs"])
        self.assertEqual(caps["exports"]["slides"], ["pptx", "pdf", "html"])

    def test_list_and_get_with_content(self):
        self.send({"type": "artifact_list", "request_id": "l"})
        items = self.wire.wait("artifact_items", "l")["items"]
        self.assertEqual([i["title"] for i in items], ["Plan"])
        self.send({"type": "artifact_get", "request_id": "g", "id": self.doc["id"], "content": True})
        got = self.wire.wait("artifact_detail", "g")
        self.assertEqual(got["content"], "# Plan\n\nOne.\n")
        self.assertEqual(got["artifact"]["versions"][0]["author"], "DGC")

    def test_an_editor_save_is_the_users_version_and_a_stale_one_writes_nothing(self):
        self.send({"type": "artifact_update", "request_id": "u", "id": self.doc["id"], "content": "# Plan\n\nTwo.\n",
                   "base_version": 1})
        changed = self.wire.wait("artifact_changed", "u")
        self.assertEqual((changed["op"], changed["artifact"]["version"]), ("changed", 2))
        self.assertEqual(changed["artifact"]["versions"][-1]["author"], "you")
        self.send({"type": "artifact_update", "request_id": "s", "id": self.doc["id"], "content": "stale",
                   "base_version": 1})
        refused = self.wire.wait("artifact_changed", "s")
        self.assertEqual((refused["type"], refused["reason"]), ("command_rejected", "conflict"))
        self.assertEqual(S.view(self.doc["id"])["version"], 2)

    def test_restore_and_remove(self):
        S.edit(self.doc["id"], content="# Plan\n\nTwo.\n")
        self.send({"type": "artifact_restore", "request_id": "r", "id": self.doc["id"], "version": 1})
        self.assertEqual(self.wire.wait("artifact_changed", "r")["op"], "restored")
        self.send({"type": "artifact_remove", "request_id": "x", "id": self.doc["id"]})
        self.assertEqual(self.wire.wait("artifact_changed", "x")["op"], "removed")
        self.assertEqual(S.listing(), [])

    def test_compare_returns_a_new_valid_event_without_changing_either_version(self):
        S.edit(self.doc["id"], content="# Plan\n\nTwo.\n")
        self.send({"type": "artifact_compare", "request_id": "cmp", "id": self.doc["id"], "before": 1})
        result = self.wire.wait("artifact_comparison", "cmp")["comparison"]
        self.assertEqual((result["before"], result["after"]), (1, 2))
        self.assertIn("+Two.", result["diff"])
        self.assertEqual(S.view(self.doc["id"])["version"], 2)

    def test_export_answers_later_with_the_file(self):
        self.send({"type": "artifact_export", "request_id": "e", "id": self.doc["id"], "format": "md"})
        done = self.wire.wait("artifact_exported", "e")
        self.assertEqual(Path(done["path"]).read_text(), "# Plan\n\nOne.\n")
        self.send({"type": "artifact_export", "request_id": "bad", "id": self.doc["id"], "format": "pptx"})
        self.assertEqual(self.wire.wait("artifact_exported", "bad")["type"], "command_rejected")

    def test_open_serves_it_at_its_own_address(self):
        state, A.STATE_FILE = A.STATE_FILE, self.tmp / "artifacts.json"
        server, A._SRV = A._SRV, A._Server(persistent=False)
        try:
            self.send({"type": "artifact_open", "request_id": "o", "id": self.doc["id"]})
            served = self.wire.wait("artifact_served", "o")
            self.assertTrue(served["url"].startswith("http://127.0.0.1:"))
            # A deck's present mode has an address of its own, beside its view; only a deck has one.
            deck = S.make("slides", "Q3", {"slides": [{"layout": "title", "title": "Q3"}]}, origin={"surface": "work"})
            self.send({"type": "artifact_open", "request_id": "p", "id": deck["id"], "mode": "present"})
            present = self.wire.wait("artifact_served", "p")["url"]
            self.assertTrue(present.endswith("/present.html"), present)
            with urllib.request.urlopen(present, timeout=10) as answer:
                page = answer.read().decode()
            self.assertIn('<body class="present">', page)
            self.send({"type": "artifact_open", "request_id": "v", "id": deck["id"]})
            self.assertTrue(self.wire.wait("artifact_served", "v")["url"].endswith("/index.html"))
            self.send({"type": "artifact_open", "request_id": "bad", "id": self.doc["id"], "mode": "present"})
            self.assertIn("present mode", self.wire.wait("command_rejected", "bad")["message"])
        finally:
            A._SRV.shutdown()
            A._SRV, A.STATE_FILE = server, state

    def test_a_save_of_a_documents_file_is_the_users_version_and_every_screen_hears_it(self):
        path = Path(S.view(self.doc["id"])["file"])
        path.write_text("# Plan\n\nOne, saved.\n")
        self.commands.user_saved([str(path), str(self.tmp / "unrelated.py")])
        with self.wire.lock:
            heard = [e for e in self.wire.events if e["type"] == "artifact_changed"]
        self.assertEqual(len(heard), 1)
        self.assertEqual(heard[0]["artifact"]["versions"][-1]["author"], "you")
        self.commands.user_saved([str(path)])                            # saved again, unchanged: nothing new
        with self.wire.lock:
            self.assertEqual(len([e for e in self.wire.events if e["type"] == "artifact_changed"]), 1)

    def test_an_unknown_artifact_or_a_bad_command_is_refused_plainly(self):
        self.send({"type": "artifact_get", "request_id": "n", "id": "ar_" + "0" * 16})
        self.assertEqual(self.wire.wait("artifact_detail", "n")["type"], "command_rejected")
        self.commands.dispatch({"type": "artifact_get", "request_id": "m"})            # no id
        self.assertEqual(self.wire.wait("artifact_detail", "m")["reason"], "invalid_command")


if __name__ == "__main__":
    unittest.main()
