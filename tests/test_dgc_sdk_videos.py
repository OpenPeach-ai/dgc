"""Video generation in the Python SDK: session.videos (generators, generate with approve and wait, jobs, stop,
library), and the CLI's videos_* commands and events on the wire, answered by a real `dgc serve`."""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "sdk/python"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from video_fakes import FakeVideos  # noqa: E402

from dgc_sdk import AsyncSession, DGCTimeoutError, DGCConfigError, DGCUnsupportedError, Videos  # noqa: E402
from dgc_sdk.session import Session  # noqa: E402
from dgc_sdk.wire.editor_protocol import command_error, event_error  # noqa: E402

STATUS = {"generators": [{"id": "fal", "name": "fal FLUX", "makes": "images"},
                         {"id": "fal-wan", "name": "fal Wan", "makes": "videos", "video": {"label": "Wan 2.2 5B"}}]}


class Wire:
    def __init__(self):
        self.calls = []
        self.polls = 0

    def request(self, payload, response, **kwargs):
        self.calls.append((dict(payload), response))
        assert command_error(payload) is None, command_error(payload)
        rid = payload["request_id"]
        if payload["type"] == "images_list":
            answer = {"type": "images_status", "seq": 1, "request_id": rid, "status": STATUS}
        elif payload["type"] == "videos_generate":
            if not payload.get("approve"):
                answer = {"type": "video_jobs", "seq": 1, "request_id": rid, "jobs": [],
                          "card": {"facts": "5 s · 720p · about $0.15"}, "change": "send approve",
                          "error": {"kind": "needs_approval", "message": "a video with fal Wan"}}
            else:
                answer = {"type": "video_jobs", "seq": 1, "request_id": rid, "change": "Started",
                          "jobs": [{"id": "vid_000000000001", "state": "queued"}]}
        elif payload["type"] == "videos_jobs":
            self.polls += 1
            state = "done" if self.polls >= 2 else "running"
            answer = {"type": "video_jobs", "seq": 1, "request_id": rid,
                      "jobs": [{"id": "vid_000000000001", "state": state,
                                **({"result": {"path": "/home/me/.dgc/videos/sessions/sdk/ball.mp4"}}
                                   if state == "done" else {})}]}
        elif payload["type"] == "videos_stop":
            answer = {"type": "video_jobs", "seq": 1, "request_id": rid, "change": "Stopped.",
                      "jobs": [{"id": payload["job"], "state": "cancelled", "charged": "nothing was charged"}]}
        else:
            answer = {"type": "videos_library", "seq": 1, "request_id": rid, "videos": [], "total": 0}
        assert event_error(answer) is None, event_error(answer)
        return answer


def session(wire, caps):
    return Session(wire, {"capabilities": caps}, unhandled="deny", on_permission=None, on_plan=None,
                   on_question=None, isolated=False)


class SessionVideos(unittest.TestCase):
    def test_needs_the_capability(self):
        with self.assertRaises(DGCUnsupportedError):
            session(Wire(), {}).videos

    def test_each_call_is_one_valid_command(self):
        wire = Wire()
        videos = session(wire, {"videos": {"version": 1}}).videos
        self.assertIsInstance(videos, Videos)
        self.assertEqual([g["id"] for g in videos.generators()], ["fal-wan"], "only those that make videos")
        held = videos.generate("a felt ball", duration_s=5)
        self.assertEqual((held["ok"], held["error"]["kind"]), (False, "needs_approval"))
        self.assertEqual(held["card"]["facts"], "5 s · 720p · about $0.15")
        made = videos.generate("a felt ball", duration_s=5, aspect="9:16", save_to="assets", approve=True, poll_s=0.01)
        self.assertTrue(made["ok"])
        self.assertTrue(made["job"]["result"]["path"].endswith("ball.mp4"))
        self.assertEqual(videos.stop("vid_000000000001")["state"], "cancelled")
        self.assertEqual(videos.library(query="ball")["total"], 0)
        sent = [payload for payload, _ in wire.calls]
        self.assertEqual([p["type"] for p in sent], ["images_list", "videos_generate", "videos_generate", "videos_jobs",
                                                       "videos_jobs", "videos_stop", "videos_library"])
        self.assertEqual((sent[2]["duration_s"], sent[2]["aspect"], sent[2]["save_to"], sent[2]["approve"]),
                         (5, "9:16", "assets", True))

    def test_arguments_are_checked(self):
        videos = session(Wire(), {"videos": {"version": 1}}).videos
        for bad in ({"prompt": ""}, {"prompt": "x", "duration_s": 0}, {"prompt": "x", "aspect": "4:3"}):
            with self.assertRaises(DGCConfigError):
                videos.generate(**bad)

    def test_polling_deadline_raises_timeout(self):
        videos = session(Wire(), {"videos": {"version": 1}}).videos
        with self.assertRaises(DGCTimeoutError):
            videos.wait("vid_000000000001", timeout=-1)

    def test_async_parity(self):
        wire = Wire()
        async_session = AsyncSession(session(wire, {"videos": {"version": 1}}))

        async def go():
            return (await async_session.videos.generators(),
                    await async_session.videos.generate("x", approve=True, poll_s=0.01))
        listed, made = asyncio.run(go())
        self.assertEqual(listed[0]["id"], "fal-wan")
        self.assertTrue(made["ok"])


class TheBackendOnTheWire(unittest.TestCase):
    """A real `dgc serve`: the capability, a video generator added on the fal key pictures use, a video held for
    approve, made with it and followed to the end, the Library, and a Stop."""

    def test_commands_and_events(self):
        fake = FakeVideos()
        self.addCleanup(fake.close)
        home = Path(tempfile.mkdtemp(prefix="dgc-videos-wire-"))
        project = home / "project"
        project.mkdir()
        (project / ".git").mkdir()
        (home / ".dgc").mkdir()
        (home / ".dgc" / "config.json").write_text(json.dumps({"base_url": "http://127.0.0.1:9/v1", "model": "m",
                                                               "pips_enabled": False}))
        env = {key: value for key, value in os.environ.items() if not key.startswith("DGC_")}
        env.update(HOME=str(home), PYTHONPATH=str(ROOT), DGC_VIDEO_POLL_S="0.05")
        proc = subprocess.Popen([sys.executable, "-m", "dgc", "serve"], cwd=project, env=env, stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        events = []

        def send(command):
            proc.stdin.write(json.dumps(command) + "\n")
            proc.stdin.flush()

        def until(predicate, timeout=60):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                line = proc.stdout.readline()
                if not line:
                    break
                event = json.loads(line)
                events.append(event)
                self.assertIsNone(event_error(event), event)
                if predicate(event):
                    return event
            self.fail(f"no matching event; saw {[e.get('type') for e in events][-12:]}")

        def answer(request_id, kind=None):
            return until(lambda e: e.get("request_id") == request_id and (kind is None or e["type"] == kind))
        try:
            ready = until(lambda e: e["type"] == "ready")
            self.assertEqual(ready["capabilities"]["videos"],
                             {"version": 1, "commands": ["videos_jobs", "videos_stop", "videos_generate",
                                                         "videos_library"], "generators": 0})
            send({"type": "images_update", "request_id": "v1", "action": "add_generator", "provider": "fal",
                  "base_url": fake.url, "id": "fal"})
            answer("v1", "images_status")
            send({"type": "images_update", "request_id": "v2", "action": "set_key", "generator": "fal",
                  "key": "fal-key"})
            answer("v2", "images_status")
            send({"type": "images_update", "request_id": "v3", "action": "add_generator", "provider": "fal",
                  "base_url": fake.url, "makes": "videos"})
            added = answer("v3", "images_status")
            row = next(g for g in added["status"]["generators"] if g.get("makes") == "videos")
            self.assertEqual((row["id"], row["model"], row["has_key"]),
                             ("fal-wan-2-2-5b", "fal-ai/wan/v2.2-5b/text-to-video", True),
                             "the cheapest good fal model, on the key pictures use")
            self.assertEqual(row["video"]["price_per_s"], "about $0.03/s ($0.15 a 5 s clip at 720p)")
            self.assertEqual((row["price"], row["price_usd"]), (row["video"]["price_per_s"], None),
                             "it makes no pictures: its price is its video's")
            send({"type": "videos_generate", "request_id": "v4", "prompt": "a felt ball"})
            held = answer("v4", "video_jobs")
            self.assertEqual((held["jobs"], held["error"]["kind"]), ([], "needs_approval"))
            self.assertEqual(held["card"]["facts"], "5 s · 720p · about $0.15")
            self.assertFalse(any(r["method"] == "POST" and r["path"].startswith("/fal-ai/") for r in fake.requests),
                             "nothing sent before approve")
            send({"type": "videos_generate", "request_id": "v5", "prompt": "a felt ball", "approve": True})
            started = answer("v5", "video_jobs")
            job_id = started["jobs"][0]["id"]
            self.assertIn("Started a 5 s video with fal Wan 2.2 5B", started["change"])
            done = until(lambda e: e["type"] == "video_job" and e["job"]["id"] == job_id
                         and e["job"]["state"] == "done")
            self.assertTrue(done["job"]["result"]["path"].startswith(str(home / ".dgc" / "videos" / "sessions" / "sdk")))
            send({"type": "videos_library", "request_id": "v6"})
            self.assertEqual(answer("v6", "videos_library")["total"], 1)
            fake.steps = 10_000
            send({"type": "videos_generate", "request_id": "v7", "prompt": "a slow one", "approve": True})
            slow = answer("v7", "video_jobs")["jobs"][0]["id"]
            send({"type": "videos_stop", "request_id": "v8", "job": slow})
            stopped = answer("v8", "video_jobs")
            self.assertEqual(stopped["jobs"][0]["state"], "cancelled")
            self.assertTrue(stopped["change"].startswith("Stopped the video with fal Wan 2.2 5B."))
            send({"type": "videos_jobs", "request_id": "v9", "job": slow})
            self.assertEqual(answer("v9", "video_jobs")["jobs"][0]["state"], "cancelled")
            send({"type": "videos_stop", "request_id": "v10", "job": "nope"})
            self.assertEqual(answer("v10", "command_rejected")["reason"], "invalid_change")
            self.assertNotIn("fal-key", json.dumps(events))
        finally:
            try:
                send({"type": "shutdown"})
                proc.wait(timeout=20)
            except Exception:                  # noqa: BLE001
                proc.kill()
                proc.wait()
            for stream in (proc.stdin, proc.stdout):
                try:
                    stream.close()
                except OSError:
                    pass


if __name__ == "__main__":
    unittest.main()


class PriceThroughTheSdk(unittest.TestCase):
    """Release check, 2026-11-03: through the SDK, a fal video generator's `price` read "price unknown", while
    Settings and `dgc videos list` know it (about $0.15 a clip). A real `dgc serve` in an isolated home; the fal
    address is a local fake, so nothing leaves the machine and nothing is made."""

    def test_a_video_generators_price_is_its_video_price(self):
        from dgc_sdk import DGC
        fake = FakeVideos()
        self.addCleanup(fake.close)
        project = Path(tempfile.mkdtemp(prefix="dgc-videos-price-"))
        (project / ".git").mkdir()
        with DGC(runtime=[sys.executable, "-m", "dgc", "serve"], extra_env={"PYTHONPATH": str(ROOT)},
                 base_url="http://127.0.0.1:9/v1", model="m") as dgc, dgc.session(cwd=project) as session:
            session.images.update("add_generator", provider="fal", base_url=fake.url, makes="videos")
            [row] = session.videos.generators()
            self.assertEqual((row["price"], row["price_usd"]), ("about $0.03/s ($0.15 a 5 s clip at 720p)", None))
            self.assertEqual(row["video"]["price_usd_default"], 0.15)
            listed = next(g for g in session.images.generators()["generators"] if g["id"] == row["id"])
            self.assertEqual(listed["price"], row["price"])
        self.assertFalse(any(r["method"] == "POST" for r in fake.requests), "nothing was made")
