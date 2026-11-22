"""Favorites in the Library (0.52): any Library item can be marked a Favorite, and the Library filters by them.

One store for every kind (dgc/favorites.py): an artifact, a ChatDGC widget, a chart a reply drew, an image, a video, a
chat's or a space's file, and something attached in a Work session. Each is kept by its own identity (its kind and the
id or path the Library already lists it by), in DGC's home, so every window and a reload read the same list. An id that
is not one of that kind's is refused, and so is an artifact, an image or a video that is not in DGC's own lists.
The editor asks through `favorites_list` and `favorites_set`, each answered by one `favorites` event
(ready.capabilities.favorites)."""
import io
import json
import os
import sys
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

PNG = bytes.fromhex("89504e470d0a1a0a0000000d4948445200000001000000010806000000"
                    "1f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082")
AR = "ar_" + "1" * 16
CHAT = "chat_" + "a" * 32
MSG = "msg_" + "b" * 32
# One of every kind, by the identity the Library lists it by (the image and the video are made in setUp).
PLAIN = [("widget", "wg_" + "4" * 16), ("chart", f"{CHAT}:{MSG}:0"), ("file", "att_" + "3" * 32),
         ("workfile", "wa_" + "2" * 16)]


class Home(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(os.path.realpath(tempfile.mkdtemp(prefix="dgc-fav-")))
        patcher = mock.patch.dict(os.environ, {"DGC_HOME": str(self.tmp)})
        patcher.start()
        self.addCleanup(patcher.stop)
        from dgc import artifact_store, favorites, images, videos
        self.favorites, self.images, self.videos = favorites, images, videos
        self.home = self.tmp / ".dgc"
        for module, folder in ((images, "images"), (videos, "videos")):
            patch = mock.patch.object(module, "directory", return_value=self.home / folder)
            patch.start()
            self.addCleanup(patch.stop)
        self.artifacts = artifact_store.Store(self.home / "artifacts")
        patch = mock.patch.object(artifact_store, "store", return_value=self.artifacts)
        patch.start()
        self.addCleanup(patch.stop)
        self.image = self.home / "images" / "fox.png"
        self.image.parent.mkdir(parents=True, exist_ok=True)
        self.image.write_bytes(PNG)
        images._index({"path": str(self.image), "surface": "pip", "prompt": "a fox", "created_at": "2026-11-19T00:00:00Z"})
        self.video = self.home / "videos" / "tiles.mp4"
        self.video.parent.mkdir(parents=True, exist_ok=True)
        self.video.write_bytes(b"\x00\x00\x00\x18ftypmp42")
        with (self.home / "videos" / "library.jsonl").open("a", encoding="utf-8") as out:
            out.write(json.dumps({"path": str(self.video), "surface": "work", "prompt": "tiles"}) + "\n")
        self.artifact = self.artifacts.create("doc", "Launch notes", "# Notes\n", origin={"surface": "work"}).id

    def every_kind(self):
        return [("artifact", self.artifact), ("image", str(self.image)), ("video", str(self.video)), *PLAIN]

    def keys(self):
        return [(row["kind"], row["id"]) for row in self.favorites.listing()]


class Store(Home):
    def test_every_kind_is_set_and_cleared(self):
        self.assertEqual(self.favorites.listing(), [], "nothing is a favorite to begin with")
        for kind, ident in self.every_kind():
            rows = self.favorites.mark(kind, ident, True)
            self.assertIn((kind, ident), [(r["kind"], r["id"]) for r in rows], kind)
        self.assertEqual(sorted(self.keys()), sorted(self.every_kind()))
        self.assertEqual(sorted(self.favorites.KINDS), sorted({kind for kind, _ in self.every_kind()}), "one of every kind there is")
        for kind, ident in self.every_kind():
            self.favorites.mark(kind, ident, False)
        self.assertEqual(self.favorites.listing(), [])

    def test_a_favorite_is_kept_once_and_says_when(self):
        first = self.favorites.mark("artifact", self.artifact, True)
        again = self.favorites.mark("artifact", self.artifact, True)
        self.assertEqual(len(again), 1, "starred twice, it is there once")
        self.assertEqual(first[0]["at"], again[0]["at"], "and keeps when it was first starred")
        self.assertRegex(first[0]["at"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d")
        self.assertEqual(set(first[0]), {"kind", "id", "at"}, "its kind, its id and when: never a title or content")

    def test_the_list_is_read_from_disk_every_time(self):
        """A reload, another window, another DGC process: all read the one file in DGC's home."""
        self.favorites.mark("image", str(self.image), True)
        self.favorites.mark("widget", PLAIN[0][1], True)
        path = self.favorites.path()
        self.assertEqual(path, self.home / "library" / "favorites.json")
        self.assertEqual(stat_mode(path), 0o600)
        kept = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual([(r["kind"], r["id"]) for r in kept["items"]], [("image", str(self.image)), ("widget", PLAIN[0][1])])
        import importlib
        fresh = importlib.reload(self.favorites)
        self.addCleanup(importlib.reload, self.favorites)
        self.assertEqual([(r["kind"], r["id"]) for r in fresh.listing()], [("image", str(self.image)), ("widget", PLAIN[0][1])])
        # Written by another process since: the next reading has it.
        kept["items"].append({"kind": "file", "id": PLAIN[2][1], "at": "2026-11-19T00:00:00Z"})
        path.write_text(json.dumps(kept), encoding="utf-8")
        self.assertIn(("file", PLAIN[2][1]), self.keys())

    def test_unknown_kinds_and_ids_are_refused(self):
        bad = [("pip", "pip_" + "a" * 32), ("", self.artifact), ("artifact", ""), ("artifact", "ar_123"), ("artifact", "../../etc/passwd"),
               ("widget", "wg_zz"), ("chart", f"{CHAT}:{MSG}"), ("chart", f"{CHAT}:{MSG}:x"), ("file", "att_1"), ("workfile", "wa_" + "g" * 16),
               ("image", "relative/fox.png"), ("image", "x" * 5000), ("video", ""), ("artifact", None), (None, None), ("file", 7)]
        for kind, ident in bad:
            with self.assertRaises(self.favorites.FavoriteError, msg=(kind, ident)) as said:
                self.favorites.mark(kind, ident, True)
            self.assertEqual(said.exception.reason, "invalid_favorite", (kind, ident))
        self.assertEqual(self.favorites.listing(), [], "nothing was kept")

    def test_an_item_dgc_does_not_list_is_refused(self):
        gone = [("artifact", "ar_" + "9" * 16), ("image", str(self.home / "images" / "nope.png")), ("image", "/etc/hostname"),
                ("video", str(self.home / "videos" / "nope.mp4")), ("video", str(self.image))]
        for kind, ident in gone:
            with self.assertRaises(self.favorites.FavoriteError, msg=(kind, ident)) as said:
                self.favorites.mark(kind, ident, True)
            self.assertEqual(said.exception.reason, "unknown_favorite", (kind, ident))
        self.assertEqual(self.favorites.listing(), [])

    def test_a_favorite_whose_item_is_gone_can_still_be_cleared(self):
        self.favorites.mark("image", str(self.image), True)
        self.image.unlink()
        self.assertEqual(self.favorites.mark("image", str(self.image), False), [])

    def test_a_damaged_file_reads_as_no_favorites_and_is_written_whole_again(self):
        path = self.favorites.path()
        path.parent.mkdir(parents=True, exist_ok=True)
        for junk in ("{not json", "[]", json.dumps({"items": [{"kind": "pip", "id": "x"}, {"kind": "widget"}, 3, {"kind": "widget", "id": PLAIN[0][1]}]})):
            path.write_text(junk, encoding="utf-8")
            rows = self.favorites.listing()
            self.assertLessEqual(len(rows), 1, junk)
        self.assertEqual(self.keys(), [("widget", PLAIN[0][1])], "a row that is one is kept; the rest are not read")
        self.favorites.mark("file", PLAIN[2][1], True)
        self.assertEqual(self.keys(), [("widget", PLAIN[0][1]), ("file", PLAIN[2][1])])

    def test_the_list_has_a_most(self):
        with mock.patch.object(self.favorites, "MOST", 3):
            for n in range(3):
                self.favorites.mark("widget", "wg_" + f"{n:016x}", True)
            with self.assertRaises(self.favorites.FavoriteError) as said:
                self.favorites.mark("widget", "wg_" + "f" * 16, True)
            self.assertEqual(said.exception.reason, "too_many_favorites")
            self.assertIn("3", str(said.exception))

    def test_two_writers_at_once_lose_nothing(self):
        ids = ["wg_" + f"{n:016x}" for n in range(24)]
        threads = [threading.Thread(target=self.favorites.mark, args=("widget", ident, True)) for ident in ids]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(sorted(i for _, i in self.keys()), sorted(ids))


def stat_mode(path: Path) -> int:
    return path.stat().st_mode & 0o777


class Wire(Home):
    """`favorites_list` and `favorites_set`, each answered by one `favorites` event naming its request."""

    def setUp(self):
        super().setUp()
        from dgc import editor_protocol as ep
        from dgc.headless import Backend
        from dgc.protocol import Emitter, PendingRequests
        from tests.test_image_views import fixture_config
        self.ep = ep
        self.stream = io.StringIO()
        backend = object.__new__(Backend)
        backend.em = Emitter(self.stream, validator=ep.event_error)
        backend.config = fixture_config(self.tmp / "proj")
        backend.pending = PendingRequests()
        backend._queue = []
        backend.agent = types.SimpleNamespace(session_file=self.tmp / "s.json", image_views=[], cancelled=threading.Event(), monitors=None)
        backend._busy = lambda: True          # (a reply is running: a favorite is still set, and the list still read)
        self.backend = backend

    def events(self, wait_for, timeout=10.0):
        deadline = time.monotonic() + timeout
        while True:
            frames = [json.loads(line) for line in self.stream.getvalue().splitlines() if line]
            found = [f for f in frames if f["type"] in ("favorites", "command_rejected")]
            if len(found) >= wait_for or time.monotonic() > deadline:
                for frame in frames:
                    self.assertIsNone(self.ep.event_error(frame), frame)
                return found

    def test_the_commands_and_the_event_are_in_the_protocol(self):
        self.assertIsNone(self.ep.command_error({"type": "favorites_list", "request_id": "f1"}))
        self.assertIsNone(self.ep.command_error({"type": "favorites_set", "request_id": "f2", "kind": "artifact", "id": AR, "on": True}))
        self.assertIsNotNone(self.ep.command_error({"type": "favorites_set", "request_id": "f2", "kind": "artifact", "id": AR}), "on is said")
        self.assertIsNotNone(self.ep.command_error({"type": "favorites_list"}), "a request is named")
        self.assertIsNone(self.ep.event_error({"type": "favorites", "seq": 1, "request_id": "f1", "items": []}))
        self.assertEqual(self.backend._favorites_capability(), 1)
        source = (Path(__file__).resolve().parent.parent / "dgc" / "headless.py").read_text(encoding="utf-8")
        self.assertIn('"favorites": self._favorites_capability(),', source, "said in ready.capabilities")

    def test_set_then_list_then_clear(self):
        self.backend.dispatch({"type": "favorites_list", "request_id": "l0"})
        [empty] = self.events(1)
        self.assertEqual((empty["type"], empty["request_id"], empty["items"]), ("favorites", "l0", []))
        self.backend.dispatch({"type": "favorites_set", "request_id": "s1", "kind": "artifact", "id": self.artifact, "on": True})
        starred = self.events(2)[1]
        self.assertEqual((starred["request_id"], [(r["kind"], r["id"]) for r in starred["items"]]), ("s1", [("artifact", self.artifact)]))
        self.backend.dispatch({"type": "favorites_set", "request_id": "s2", "kind": "image", "id": str(self.image), "on": True})
        self.backend.dispatch({"type": "favorites_list", "request_id": "l1"})
        listed = [f for f in self.events(4) if f.get("request_id") == "l1"][0]
        self.assertEqual(sorted((r["kind"], r["id"]) for r in listed["items"]), sorted([("artifact", self.artifact), ("image", str(self.image))]))
        self.backend.dispatch({"type": "favorites_set", "request_id": "s3", "kind": "artifact", "id": self.artifact, "on": False})
        cleared = [f for f in self.events(5) if f.get("request_id") == "s3"][0]
        self.assertEqual([(r["kind"], r["id"]) for r in cleared["items"]], [("image", str(self.image))])
        # Another backend (another window) reads the same list.
        self.assertEqual([(r["kind"], r["id"]) for r in self.favorites.listing()], [("image", str(self.image))])

    def test_an_unknown_item_is_rejected_in_words(self):
        self.backend.dispatch({"type": "favorites_set", "request_id": "b1", "kind": "artifact", "id": "ar_" + "9" * 16, "on": True})
        self.backend.dispatch({"type": "favorites_set", "request_id": "b2", "kind": "pip", "id": "x", "on": True})
        found = {f["request_id"]: f for f in self.events(2)}
        self.assertEqual((found["b1"]["type"], found["b1"]["reason"], found["b1"]["command"]), ("command_rejected", "unknown_favorite", "favorites_set"))
        self.assertEqual((found["b2"]["type"], found["b2"]["reason"]), ("command_rejected", "invalid_favorite"))
        self.assertTrue(found["b1"]["message"] and "Traceback" not in found["b1"]["message"])
        self.assertEqual(self.favorites.listing(), [])

    def test_reading_the_list_is_not_the_person_acting_on_the_chat(self):
        from dgc import headless
        self.assertIn("favorites_list", headless._WAKE_NEUTRAL_COMMANDS)
        self.assertNotIn("favorites_set", headless._WAKE_NEUTRAL_COMMANDS)


if __name__ == "__main__":
    unittest.main()
