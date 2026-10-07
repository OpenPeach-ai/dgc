"""The Sessions list holds thousands and searches them: a per-project index (session_index)."""
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import session_index, sessions


def write(directory, name, *, messages, title="", updated=1.0):
    path = Path(directory) / f"{name}.json"
    path.write_text(json.dumps({"name": title, "updated": updated, "messages": messages}))
    return path


class SessionIndexTests(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())

    def test_lists_newest_first_and_reads_only_what_changed(self):
        write(self.dir, "a", messages=[{"role": "user", "content": "Plan the release"}], title="Release", updated=1)
        write(self.dir, "b", messages=[{"role": "user", "content": "Fix the build"}], updated=2)
        rows = session_index.page(self.dir)
        self.assertEqual([r[4] or r[2] for r in rows], ["Fix the build", "Release"])
        with patch.object(session_index, "_read", side_effect=AssertionError("nothing changed")):
            self.assertEqual(len(session_index.page(self.dir)), 2, "an unchanged file is not read again")
        write(self.dir, "a", messages=[{"role": "user", "content": "Plan the release"}, {"role": "assistant", "content": "Done"}], title="Release", updated=3)
        rows = session_index.page(self.dir)
        self.assertEqual((rows[0][4], rows[0][3]), ("Release", 2), "the changed one is read again, and is newest")
        os.remove(self.dir / "b.json")
        self.assertEqual([r[4] for r in session_index.page(self.dir)], ["Release"], "a deleted one is gone")

    def test_search_reaches_names_first_messages_and_everything_said(self):
        write(self.dir, "a", messages=[{"role": "user", "content": "Plan the launch"}, {"role": "assistant",
              "content": [{"type": "text", "text": "The sourdough starter needs feeding before the launch party."}]}], title="Launch", updated=1)
        write(self.dir, "b", messages=[{"role": "user", "content": "Mortgage questions"}], updated=2)
        by_name = session_index.page(self.dir, query="launch")
        self.assertEqual([(r[4], r[5]) for r in by_name], [("Launch", None)], "found by its name: nothing to explain")
        by_content = session_index.page(self.dir, query="sourdough")
        self.assertEqual(len(by_content), 1)
        self.assertIn("sourdough starter", by_content[0][5])
        self.assertEqual(session_index.page(self.dir, query="mortgage")[0][2], "Mortgage questions")
        self.assertEqual(session_index.page(self.dir, query="100%"), [], "a % is a %")
        page = session_index.page(self.dir, limit=1, offset=1)
        self.assertEqual([r[4] for r in page], ["Launch"])

    def test_a_snippet_never_shows_a_saved_credential(self):
        write(self.dir, "a", messages=[{"role": "user", "content": "hello"}, {"role": "assistant", "content": "use key sk-live-0123456789abcdef0123 for the deploy"}])
        [row] = session_index.page(self.dir, query="deploy", redact_secrets=["sk-live-0123456789abcdef0123"])
        self.assertNotIn("sk-live-0123456789abcdef0123", row[5])

    def test_a_snippet_opens_and_closes_on_whole_words(self):
        said = ("We baked a loaf yesterday and it came out flat, so today I want to talk about the sourdough "
                "starter, feeding it twice a day and keeping it warm near the oven while the dough proves for "
                "hours, which is a long sentence written to run past the end of what a snippet shows.")
        for query in ("sourdough", "SOURDOUGH", "dough"):
            text = session_index.snippet(said, query)
            self.assertTrue(text.startswith("…"), text)
            body = text.strip("…")
            self.assertIn(body.split()[0], said.split(), f"opens on a whole word: {text!r}")
            self.assertIn(body.split()[-1], said.split(), f"closes on a whole word: {text!r}")
        self.assertTrue(session_index.snippet(said, "sourdough").endswith("…"))
        self.assertIn("the dough proves", session_index.snippet(said, "dough"),
                      "the word itself is found, not the inside of an earlier word (sourdough)")
        self.assertEqual(session_index.snippet("Short note", "note"), "Short note")
        from dgc import pip_search
        self.assertIs(pip_search.snippet, session_index.snippet, "the Pips list cuts snippets the same way")

    def test_two_thousand_sessions_list_fast_after_the_first_time(self):
        for i in range(2000):
            write(self.dir, f"s{i:04d}", messages=[{"role": "user", "content": f"Question {i}"}, {"role": "assistant", "content": "Answer " * 200}], updated=i)
        started = time.monotonic()
        self.assertEqual(len(session_index.page(self.dir)), 2000)
        first = time.monotonic() - started
        started = time.monotonic()
        rows = session_index.page(self.dir, limit=200)
        again = time.monotonic() - started
        self.assertEqual((len(rows), rows[0][2]), (200, "Question 1999"))
        self.assertLess(again, max(1.0, first / 3), f"first {first:.2f}s, again {again:.2f}s")

    def test_listing_keeps_its_shape_and_never_hides_sessions_when_the_index_breaks(self):
        root = Path(tempfile.mkdtemp())
        with patch.object(sessions, "SESSIONS_DIR", self.dir):
            directory = sessions.project_dir(root)
            write(directory, "a", messages=[{"role": "user", "content": "Hello"}], updated=5)
            [row] = sessions.listing(root)
            self.assertEqual((row[2], row[3], row[4]), ("Hello", 1, ""))
            with patch.object(session_index, "page", side_effect=RuntimeError("locked")):
                self.assertEqual(sessions.listing(root)[0][2], "Hello")


if __name__ == "__main__":
    unittest.main()


class ListSessionsCommandTests(unittest.TestCase):
    """The editor's list_sessions: pages and a search, behind the session_paging capability."""

    def backend(self, root):
        import threading
        from types import SimpleNamespace
        from dgc import headless
        backend = object.__new__(headless.Backend)
        backend.config = SimpleNamespace(project_root=root, get=lambda key, default=None: default)
        backend.events = []
        backend.em = SimpleNamespace(emit=lambda kind, **payload: backend.events.append({"type": kind, **payload}))
        return backend

    def test_pages_and_search_through_the_backend_and_the_protocol_allows_them(self):
        from dgc import editor_protocol
        root = Path(tempfile.mkdtemp())
        with patch.object(sessions, "SESSIONS_DIR", Path(tempfile.mkdtemp())):
            directory = sessions.project_dir(root)
            for i in range(30):
                write(directory, f"s{i:02d}", messages=[{"role": "user", "content": f"Question {i}"},
                      {"role": "assistant", "content": "The answer mentions sourdough." if i == 7 else "Fine."}], updated=i)
            backend = self.backend(root)
            backend._dispatch({"type": "list_sessions", "request_id": "r1"})
            self.assertEqual(len(backend.events[-1]["items"]), 30, "no arguments: every session, as before")
            backend._dispatch({"type": "list_sessions", "request_id": "r2", "limit": 11, "offset": 10})
            page = backend.events[-1]["items"]
            self.assertEqual((len(page), page[0]["preview"]), (11, "Question 19"))
            backend._dispatch({"type": "list_sessions", "request_id": "r3", "query": "sourdough"})
            [found] = backend.events[-1]["items"]
            self.assertEqual(found["preview"], "Question 7")
            self.assertIn("sourdough", found["match"])
            backend._dispatch({"type": "list_sessions", "request_id": "r4", "limit": 0})
            self.assertEqual(backend.events[-1]["type"], "error")
        spec = editor_protocol.COMMAND_FIELDS["list_sessions"] if hasattr(editor_protocol, "COMMAND_FIELDS") else None
        if spec is not None:
            self.assertTrue({"limit", "offset", "query"} <= set(spec))
