"""Voice (dgc/voice): the models, installing them safely, choosing them, and `dgc serve`'s voice_* commands.

The end-to-end test at the bottom runs the real engine on the real models: a model speaks a sentence and the
dictation models write it back. It needs the voice runtime's Python (DGC_VOICE_TEST_PYTHON) and the downloaded model
archives (DGC_VOICE_TEST_ARCHIVES, a folder of the catalog's .tar.bz2 files); without them it is skipped.
"""
from __future__ import annotations

import base64
import hashlib
import io
import os
import re
import shutil
import tarfile
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc.editor_protocol import command_error, event_error
from dgc.voice import catalog
from dgc.voice.manager import VoiceError, VoiceManager, speakable
from dgc.voice.service import VoiceService


def archive_for(model: dict, *, extra: dict | None = None) -> bytes:
    """A .tar.bz2 holding a model's folder with each of its files (tiny), plus `extra` {name: bytes}."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:bz2") as tar:
        for name in list(model["files"].values()) + list((extra or {}).keys()):
            data = (extra or {}).get(name, b"x")
            info = tarfile.TarInfo(name if name.startswith("..") else f"{model['folder']}/{name}")
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


class Fixture(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="dgc-voice-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.archives: dict[str, bytes] = {}
        self.runtimes = 0

        def make_runtime(runtime: Path, log) -> None:
            self.runtimes += 1
            runtime.mkdir(parents=True, exist_ok=True)

        def fetcher(url, target, on_bytes, cancel):
            data = self.archives[url]
            for at in range(0, len(data), 7):
                if cancel.is_set():
                    raise VoiceError("Stopped.", "cancelled")
                on_bytes(len(data[at:at + 7]))
            Path(target).write_bytes(data)

        self.manager = VoiceManager(self.root, runtime_maker=make_runtime, fetcher=fetcher)

    def offer(self, model_id: str, data: bytes | None = None, *, sha: str | None = None) -> dict:
        found = dict(catalog.model(model_id))
        data = archive_for(found) if data is None else data
        self.archives[found["url"]] = data
        patcher = patch.dict(next(m for m in catalog.MODELS if m["id"] == model_id),
                             {"sha256": sha or hashlib.sha256(data).hexdigest(), "size": len(data)})
        patcher.start()
        self.addCleanup(patcher.stop)
        return found


class CatalogTests(unittest.TestCase):
    def test_every_model_says_where_it_comes_from_what_it_is_and_its_licence(self):
        ids = [m["id"] for m in catalog.MODELS]
        self.assertEqual(len(ids), len(set(ids)))
        for m in catalog.MODELS:
            self.assertIn(m["role"], catalog.ROLES)
            self.assertTrue(m["url"].startswith("https://github.com/k2-fsa/sherpa-onnx/releases/download/"), m["id"])
            self.assertRegex(m["sha256"], r"^[0-9a-f]{64}$")
            self.assertTrue(m["licence"] and m["summary"] and m["languages"] and m["size"] > 10_000_000)
        self.assertEqual({m["role"] for m in catalog.MODELS}, set(catalog.ROLES), "something for each role")

    def test_pocket_tts_says_it_is_for_non_commercial_use(self):
        self.assertEqual(catalog.model("pocket-tts")["licence"], "Non-commercial use only")


class SpeakableTests(unittest.TestCase):
    def test_a_reply_is_read_without_code_links_citations_or_markdown(self):
        text = ("## Plan\n\n**Save** first [1], then *spend*. See [the guide](https://x.example/a).\n\n"
                "```python\nprint('never read')\n```\n\n| a | b |\n| - | - |\n\n- Track it `daily`.\nDone?")
        chunks = speakable(text)
        said = " ".join(chunks)
        self.assertNotIn("never read", said)
        self.assertNotIn("http", said)
        self.assertNotIn("[1]", said)
        self.assertNotRegex(said, r"[*#|`]")
        self.assertIn("Save first, then spend.", said)
        self.assertIn("See the guide.", said)
        self.assertIn("Track it daily.", said)

    def test_sentences_are_joined_into_short_pieces_and_a_question_ends_one(self):
        chunks = speakable("One. Two. Three? Four. " + "Long sentence here. " * 40)
        self.assertTrue(chunks[0].endswith("Three?"), chunks[0])
        self.assertTrue(all(len(c) < 400 for c in chunks))


class ManagerTests(Fixture):
    def test_install_makes_the_engine_once_checks_the_download_and_chooses_the_first_of_its_role(self):
        found = self.offer("moonshine-base-en")
        seen = []
        self.manager.install("moonshine-base-en", lambda stage, done, total: seen.append(stage))
        self.assertEqual(self.runtimes, 1)
        self.assertTrue(self.manager.installed("moonshine-base-en"))
        self.assertEqual(seen[0], "runtime")
        self.assertIn("download", seen)
        self.assertEqual(seen[-3:], ["verify", "unpack", "done"])
        state = self.manager.state()
        self.assertEqual(state["dictation"], "moonshine-base-en")
        self.assertEqual(state["read_aloud"], "")
        row = next(m for m in state["models"] if m["id"] == "moonshine-base-en")
        self.assertEqual((row["installed"], row["in_use"], row["installing"]), (True, True, None))
        self.assertTrue((self.root / "models" / "moonshine-base-en" / found["files"]["encoder"]).is_file())
        self.assertFalse(list((self.root / "downloads").iterdir()), "no download left behind")
        self.offer("nemotron-3.5-asr")
        self.manager.install("nemotron-3.5-asr", lambda *a: None)
        self.assertEqual(self.runtimes, 1, "the engine is made once")
        self.assertEqual(self.manager.choices()["dictation"], "moonshine-base-en", "a second model doesn't take over")
        self.manager.use("dictation", "nemotron-3.5-asr")
        self.assertEqual(self.manager.choices()["dictation"], "nemotron-3.5-asr")
        self.manager.remove("nemotron-3.5-asr")
        self.assertEqual(self.manager.choices()["dictation"], "moonshine-base-en", "removed: the other one is used")
        with self.assertRaises(VoiceError):
            self.manager.use("read_aloud", "moonshine-base-en")

    def test_a_download_that_doesnt_match_its_checksum_is_not_installed(self):
        self.offer("kitten-mini-en", sha="0" * 64)
        with self.assertRaisesRegex(VoiceError, "checksum"):
            self.manager.install("kitten-mini-en", lambda *a: None)
        self.assertFalse(self.manager.installed("kitten-mini-en"))
        self.assertFalse((self.root / "models" / "kitten-mini-en").exists())

    def test_an_archive_that_would_write_outside_its_folder_is_refused(self):
        found = catalog.model("kitten-mini-en")
        self.offer("kitten-mini-en", archive_for(found, extra={"../../escaped.txt": b"no"}))
        with self.assertRaisesRegex(VoiceError, "unsafe"):
            self.manager.install("kitten-mini-en", lambda *a: None)
        self.assertFalse((self.root.parent / "escaped.txt").exists())
        self.assertFalse(self.manager.installed("kitten-mini-en"))

    def test_an_archive_missing_a_models_file_is_refused(self):
        found = dict(catalog.model("kitten-mini-en"))
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w:bz2") as tar:
            info = tarfile.TarInfo(f"{found['folder']}/model.onnx")
            info.size = 1
            tar.addfile(info, io.BytesIO(b"x"))
        self.offer("kitten-mini-en", buf.getvalue())
        with self.assertRaisesRegex(VoiceError, "missing"):
            self.manager.install("kitten-mini-en", lambda *a: None)

    def test_nothing_installed_says_so_with_the_code_that_opens_settings(self):
        with self.assertRaises(VoiceError) as caught:
            self.manager.transcribe(b"\0\0" * 100)
        self.assertEqual(caught.exception.code, "no_model")
        self.assertIn("Settings → Voice models", str(caught.exception))


class ServiceTests(Fixture):
    def setUp(self):
        super().setUp()
        self.events = []
        self.service = VoiceService(lambda kind, **fields: self.events.append({"type": kind, **fields}), None, self.manager)

    def last(self, kind):
        return next(e for e in reversed(self.events) if e["type"] == kind)

    def wait_for(self, check, timeout=10.0):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if check():
                return
            time.sleep(0.02)
        self.fail("timed out")

    def test_the_models_install_with_progress_and_every_event_is_on_the_protocol(self):
        self.offer("kitten-mini-en")
        self.service.dispatch({"type": "voice_models", "request_id": "r1"})
        self.assertEqual(self.last("voice_state")["request_id"], "r1")
        self.service.dispatch({"type": "voice_install", "request_id": "r2", "id": "kitten-mini-en"})
        self.wait_for(lambda: any(e["type"] == "voice_state" and e.get("read_aloud") == "kitten-mini-en" for e in self.events))
        self.assertTrue(any(e["type"] == "voice_progress" and e["stage"] == "download" for e in self.events))
        for n, event in enumerate(self.events):
            self.assertIsNone(event_error({**event, "seq": n}), event)    # dgc serve stamps seq on every event

    def test_dictation_chunks_must_come_in_order_and_nothing_installed_says_no_model(self):
        part = base64.b64encode(b"\0\0" * 1600).decode()
        self.service.dispatch({"type": "voice_transcribe", "request_id": "d1", "part": 1, "audio": part, "done": True})
        self.assertIn("out of order", self.last("voice_error")["message"])
        self.service.dispatch({"type": "voice_transcribe", "request_id": "d2", "part": 0, "audio": part, "done": False})
        self.service.dispatch({"type": "voice_transcribe", "request_id": "d2", "part": 1, "audio": part, "done": True})
        self.assertEqual((self.last("voice_error")["request_id"], self.last("voice_error")["code"]), ("d2", "no_model"))
        self.service.dispatch({"type": "voice_speak", "request_id": "s1", "text": "Hello."})
        self.assertEqual(self.last("voice_error")["code"], "no_model")
        for n, event in enumerate(self.events):
            self.assertIsNone(event_error({**event, "seq": n}), event)    # dgc serve stamps seq on every event

    def test_the_commands_are_on_the_protocol(self):
        for cmd in ({"type": "voice_models", "request_id": "r"}, {"type": "voice_install", "request_id": "r", "id": "x"},
                    {"type": "voice_use", "request_id": "r", "role": "read_aloud", "id": "x"},
                    {"type": "voice_transcribe", "request_id": "r", "part": 0, "audio": "", "done": True, "language": "auto"},
                    {"type": "voice_speak", "request_id": "r", "text": "Hi"}, {"type": "voice_stop", "request_id": "r"}):
            self.assertIsNone(command_error(cmd), cmd)
        self.assertIsNotNone(command_error({"type": "voice_use", "request_id": "r", "role": "sing", "id": "x"}))


class ServeTests(unittest.TestCase):
    def test_dgc_serve_offers_voice_and_answers_its_commands(self):
        import json
        import subprocess
        import sys
        home = Path(tempfile.mkdtemp(prefix="dgc-voice-serve-"))
        self.addCleanup(shutil.rmtree, home, True)
        work = home / "work"
        work.mkdir()
        env = {**os.environ, "HOME": str(home), "PYTHONPATH": str(Path(__file__).resolve().parents[1])}
        env.pop("DGC_HOME", None)
        proc = subprocess.Popen([sys.executable, "-m", "dgc", "serve"], cwd=work, env=env, stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        # A backend that goes quiet ends the read (the loop below only looks at the clock when a line arrives).
        watchdog = threading.Timer(60, proc.kill)
        watchdog.start()

        def stop():
            watchdog.cancel()
            proc.kill()
            proc.wait(timeout=10)
            proc.stdin.close()
            proc.stdout.close()
        self.addCleanup(stop)
        seen = []
        deadline = time.monotonic() + 60
        for line in proc.stdout:
            event = json.loads(line)
            seen.append(event)
            if event["type"] == "ready":
                self.assertEqual(event["capabilities"]["voice"], {"version": 1})
                proc.stdin.write(json.dumps({"type": "voice_models", "request_id": "v1"}) + "\n")
                proc.stdin.write(json.dumps({"type": "voice_use", "request_id": "v2", "role": "sing", "id": "x"}) + "\n")
                proc.stdin.flush()
            if event["type"] == "command_rejected" and event.get("request_id") == "v2":
                break
            if time.monotonic() > deadline:
                self.fail("no answer")
        state = next(e for e in seen if e["type"] == "voice_state")
        self.assertEqual(state["request_id"], "v1")
        self.assertEqual([m["id"] for m in state["models"]], [m["id"] for m in catalog.MODELS])
        self.assertFalse(state["runtime"]["installed"])
        self.assertFalse((home / ".dgc" / "voice" / "runtime").exists(), "asking installs nothing")


@unittest.skipUnless(os.environ.get("DGC_VOICE_TEST_PYTHON") and os.environ.get("DGC_VOICE_TEST_ARCHIVES"),
                     "needs the voice runtime's Python and the downloaded model archives")
class RealEngineTests(unittest.TestCase):
    """The real models, installed through the real checksum and unpacking path (the archives come from a folder
    instead of the network), and run by the real worker: Kitten speaks; Moonshine and Nemotron write it back."""

    @classmethod
    def setUpClass(cls):
        cls.root = Path(tempfile.mkdtemp(prefix="dgc-voice-real-"))
        archives = Path(os.environ["DGC_VOICE_TEST_ARCHIVES"])

        def fetcher(url, target, on_bytes, cancel):
            source = archives / url.rsplit("/", 1)[1]
            shutil.copyfile(source, target)
            on_bytes(source.stat().st_size)

        cls.manager = VoiceManager(cls.root, fetcher=fetcher, python=os.environ["DGC_VOICE_TEST_PYTHON"])
        for model_id in ("kitten-mini-en", "moonshine-base-en", "nemotron-3.5-asr"):
            cls.manager.install(model_id, lambda *a: None)

    @classmethod
    def tearDownClass(cls):
        cls.manager.stop_worker()
        shutil.rmtree(cls.root, ignore_errors=True)

    @staticmethod
    def words(text: str) -> set[str]:
        return set(re.findall(r"[a-z]+", text.lower()))

    def test_what_kitten_says_both_dictation_models_write_back(self):
        sentence = "Please remind me to buy fresh vegetables and milk tomorrow morning."
        pieces = list(self.manager.speak(sentence))
        self.assertTrue(pieces)
        rate = pieces[0][1]
        pcm = b"".join(p for p, _ in pieces)
        self.assertGreater(len(pcm) / 2 / rate, 2.0, "a few seconds of speech")
        want = self.words(sentence)
        for model_id in ("moonshine-base-en", "nemotron-3.5-asr"):
            self.manager.use("dictation", model_id)
            heard = self.manager.transcribe(pcm, rate=rate)
            overlap = len(want & self.words(heard)) / len(want)
            self.assertGreaterEqual(overlap, 0.8, f"{model_id} heard {heard!r}")


if __name__ == "__main__":
    unittest.main()
