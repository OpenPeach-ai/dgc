"""Video generation (0.51): each provider's long job against its documented answers (fal's queue, Gemini's interactions
and Veo operations, Replicate's predictions, a ComfyUI video workflow), the plan and its card (price, limit, the
generator's own key shared with pictures), a start image, save_to, Stop, and a job polled again after a reload."""
from __future__ import annotations

import json
import os
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from image_fakes import png  # noqa: E402
from test_images_config import Home  # noqa: E402
from video_fakes import WAN_WORKFLOW, FakeVideos  # noqa: E402

from dgc import image_providers as P  # noqa: E402
from dgc import image_tools, images  # noqa: E402
from dgc import video_providers as V  # noqa: E402
from dgc import video_tools as T  # noqa: E402
from dgc import videos  # noqa: E402


class VideoCase(unittest.TestCase):
    def setUp(self):
        self.fake = FakeVideos()
        self.addCleanup(self.fake.close)
        self.home = Home()
        self.home.__enter__()
        self.addCleanup(self.home.__exit__)
        self.config = self.home.config()
        self.root = Path(self.config.project_root)
        env = patch.dict(os.environ, {"DGC_VIDEO_POLL_S": "0.02"})
        env.start()
        self.addCleanup(env.stop)
        self.jobs_ctx = videos.fresh_jobs()
        self.jobs = self.jobs_ctx.__enter__()
        self.addCleanup(self.jobs_ctx.__exit__, None, None, None)
        self.heard: list = []
        self.jobs.add_listener(lambda job, change: self.heard.append((job["id"], change, job.get("state"))))

    def setup(self, *names, **extra):
        rows = {
            "fal": {"id": "fal", "name": "fal FLUX schnell", "provider": "fal", "base_url": self.fake.url,
                    "model": "fal-ai/flux/schnell"},
            "fal-wan": {"id": "fal-wan", "name": "fal Wan 2.2", "provider": "fal", "base_url": self.fake.url,
                        "model": "fal-ai/wan/v2.2-5b/text-to-video", "makes": "videos"},
            "fal-veo": {"id": "fal-veo", "name": "fal Veo 3.1 Fast", "provider": "fal", "base_url": self.fake.url,
                        "model": "fal-ai/veo3/fast", "makes": "videos"},
            "omni": {"id": "omni", "name": "Gemini Omni Flash", "provider": "gemini", "base_url": self.fake.url,
                     "model": "gemini-omni-1.1-flash", "makes": "videos"},
            "veo": {"id": "veo", "name": "Veo 3.1 Fast", "provider": "gemini", "base_url": self.fake.url,
                    "model": "veo-3.1-fast-generate-preview", "makes": "videos"},
            "rep": {"id": "rep", "name": "Replicate Wan", "provider": "replicate", "base_url": self.fake.url,
                    "model": "wan-video/wan-2.2-t2v-fast", "makes": "videos"},
            "comfy-video": {"id": "comfy-video", "name": "ComfyUI Wan", "provider": "comfyui",
                            "base_url": self.fake.url, "makes": "videos"},
        }
        chosen = []
        for name in names:
            row = dict(rows[name])
            row.update(extra.get(name, {}))
            chosen.append(row)
        if "comfy-video" in names:
            name = images.save_workflow("comfy-video", WAN_WORKFLOW)
            for row in chosen:
                if row["id"] == "comfy-video":
                    row["workflow"] = name
                    row["mapping"] = V.detect_video_mapping(WAN_WORKFLOW)[0]
        self.config.set_images({"generators": chosen})
        keys = {"fal": "fal-key", "fal-wan": None, "fal-veo": None, "omni": "gemini-key", "veo": "gemini-key",
                "rep": "r8_key"}
        for name in names:
            if keys.get(name):
                self.config.set_image_key(name, keys[name])
        if ("fal-wan" in names or "fal-veo" in names) and "fal" not in names:
            self.config.set_image_key(names[0], "fal-key")

    def surface(self, **extra):
        return image_tools.Surface(name="work", root=self.root, project_root=self.root, interactive=False,
                                   where={"project": str(self.root), "session": "s1"},
                                   video_home=videos.session_folder("s1"), **extra)

    def run_job(self, args, *, target=None, surface=None):
        surface = surface or self.surface()
        plan = T.prepare(self.config, args, surface)
        started = T.start(self.config, plan, surface, target=target or {"session": "s1", "call_id": "c1"})
        self.assertIsNotNone(started.job, started.text)
        job = self.jobs.wait(started.job["id"], timeout=20)
        return plan, started, job


class Fal(VideoCase):
    def test_a_broken_job_record_does_not_hide_valid_jobs(self):
        folder = videos.jobs_dir()
        (folder / "vid_aaaaaaaaaaaa.json").write_text("[]")
        (folder / "vid_bbbbbbbbbbbb.json").write_text('{"id":"vid_bbbbbbbbbbbb","started":"bad"}')
        (folder / "vid_cccccccccccc.json").write_text('{"id":"vid_other","started":999}')
        self.assertEqual([job["id"] for job in videos.all_jobs()], ["vid_bbbbbbbbbbbb"])
        self.assertIsNone(videos.load("vid_aaaaaaaaaaaa"))

    def test_queue_submit_status_result_and_the_file_with_its_sidecar(self):
        self.setup("fal", "fal-wan")
        plan, started, job = self.run_job({"prompt": "a felt ball rolls across a desk", "duration_s": 5})
        self.assertIn("Started a 5 s video with fal Wan 2.2 5B (720p, about $0.15)", started.text)
        self.assertIn("about 1–2 min", started.text)
        self.assertIn("Don't wait or poll", started.text)
        self.assertEqual(job["state"], "done", job)
        submitted = self.fake.requests[0]
        self.assertEqual(submitted["path"], "/fal-ai/wan/v2.2-5b/text-to-video")
        self.assertEqual(submitted["body"]["num_frames"], 121, "5 s at 24 fps")
        self.assertEqual(submitted["body"]["frames_per_second"], 24)
        self.assertEqual(submitted["body"]["aspect_ratio"], "16:9")
        self.assertTrue(any(p.endswith("/status") for p in self.fake.paths("GET")), "it polled the status")
        result = job["result"]
        path = Path(result["path"])
        self.assertTrue(path.is_file())
        self.assertEqual(path.read_bytes(), self.fake.video, "the bytes as the provider sent them")
        self.assertEqual(path.parent, videos.session_folder("s1"), "DGC's own folder, not the project")
        self.assertEqual((result["seconds"], result["width"], result["height"]), (5.0, 1280, 720))
        sidecar = json.loads(Path(result["sidecar"]).read_text())
        self.assertEqual((sidecar["provider"], sidecar["model"], sidecar["seed"], sidecar["duration_s"],
                          sidecar["cost_usd"]), ("fal", "fal-ai/wan/v2.2-5b/text-to-video", 4242, 5.0, 0.15))
        self.assertEqual(sidecar["prompt"], "a felt ball rolls across a desk")
        self.assertEqual(images.spent("fal-wan"), 0.15)
        self.assertEqual(videos.line(job), "Made a 5 s video with fal Wan 2.2 5B · 720p · $0.15")
        self.assertEqual([change for _, change, _ in self.heard][0], "started")
        self.assertEqual(self.heard[-1][1:], ("done", "done"))
        listed = videos.library()
        self.assertEqual(listed["total"], 1)
        self.assertEqual(listed["videos"][0]["generator"], "fal-wan")
        self.assertEqual(images.library()["total"], 0, "a video isn't listed with the pictures")

    def test_a_video_generator_uses_the_key_saved_for_the_fal_picture_generator(self):
        self.setup("fal", "fal-wan")
        generator = images.find(images.settings(self.config), "fal-wan")
        self.assertEqual(images.key_for(self.config, generator), "fal-key")
        self.assertEqual(images.key_source(self.config, generator), "saved")

    def test_a_start_image_goes_to_the_image_to_video_endpoint(self):
        self.setup("fal", "fal-wan")
        picture = self.root / "ball.png"
        picture.write_bytes(png(32, 32))
        _plan, _started, job = self.run_job({"prompt": "animate the felt ball", "image": "ball.png"})
        submitted = self.fake.requests[0]
        self.assertEqual(submitted["path"], "/fal-ai/wan/v2.2-5b/image-to-video")
        self.assertTrue(submitted["body"]["image_url"].startswith("data:image/png;base64,"))
        self.assertNotIn("aspect_ratio", submitted["body"], "a start image keeps its own shape")
        self.assertEqual(job["state"], "done")
        self.assertEqual(json.loads(Path(job["result"]["sidecar"]).read_text())["start_image"], "ball.png")

    def test_a_picture_dgc_made_can_be_the_start_image(self):
        self.setup("fal", "fal-wan")
        made = images.session_folder("s1") / "felt-ball.png"
        made.parent.mkdir(parents=True)
        made.write_bytes(png(16, 16))
        plan = T.prepare(self.config, {"prompt": "animate it", "image": str(made)}, self.surface())
        self.assertEqual(plan.image_name, "felt-ball.png")
        self.assertEqual(plan.card()["start_image"], "felt-ball.png")

    def test_save_to_puts_it_in_the_project(self):
        self.setup("fal", "fal-wan")
        plan, _started, job = self.run_job({"prompt": "intro", "save_to": "assets/intro.mp4"})
        self.assertTrue(plan.into_project)
        self.assertEqual(plan.card()["saves_to"], "assets/intro.mp4")
        self.assertEqual(Path(job["result"]["path"]), self.root / "assets" / "intro.mp4")
        self.assertEqual(job["result"]["rel"], "assets/intro.mp4")
        (self.root / "assets" / "outro.mp4").write_bytes(b"x")
        with self.assertRaises(T.Refused) as said:
            T.prepare(self.config, {"prompt": "outro", "save_to": "assets/outro.mp4"}, self.surface())
        self.assertIn("doesn't replace a file without asking", str(said.exception))

    def test_needs_credit_at_submit_is_said_in_plain_words_and_nothing_else_is_tried(self):
        self.setup("fal", "fal-wan")
        self.fake.mode["fal"] = "locked"
        plan = T.prepare(self.config, {"prompt": "a fox"}, self.surface())
        started = T.start(self.config, plan, self.surface(), target={"session": "s1"})
        self.assertIsNone(started.job)
        self.assertIn("needs credit", started.text)
        self.assertIn("TOP_UP", started.text)
        self.assertIn("Stop here and tell the user what to fix", started.text)
        self.assertIn("never switches to another paid generator", started.text)
        self.assertEqual(len(self.fake.paths("POST")), 1, "one try, no fallback")

    def test_a_content_refusal_from_the_result_fails_the_job_in_words(self):
        self.setup("fal", "fal-wan")
        self.fake.mode["fal"] = "policy"
        _plan, _started, job = self.run_job({"prompt": "something"})
        self.assertEqual(job["state"], "failed")
        self.assertEqual(job["error"]["kind"], "refused")
        self.assertIn("refused by the provider's policy", T.ready_text(job))
        self.assertEqual(images.spent("fal-wan"), 0, "nothing made, nothing counted")

    def test_stop_cancels_at_fal_and_says_what_was_charged(self):
        self.setup("fal", "fal-wan")
        self.fake.steps = 10_000
        plan = T.prepare(self.config, {"prompt": "slow"}, self.surface())
        started = T.start(self.config, plan, self.surface(), target={"session": "s1"})
        job_id = started.job["id"]
        deadline = time.time() + 5
        while (videos.load(job_id) or {}).get("state") != "queued" and time.time() < deadline:
            time.sleep(0.02)
        stopped = self.jobs.stop(self.config, job_id)
        self.assertEqual(stopped["state"], "cancelled")
        self.assertIn("nothing was charged", stopped["charged"])
        self.assertTrue(any(r["method"] == "PUT" and r["path"].endswith("/cancel") for r in self.fake.requests))
        final = self.jobs.wait(job_id, timeout=5)
        self.assertEqual(final["state"], "cancelled", "a poll after the Stop never writes over it")
        self.assertIn("Stopped the video with fal Wan 2.2 5B", videos.line(final))

    def test_a_job_outlives_a_reload_and_is_polled_again(self):
        self.setup("fal", "fal-wan")
        self.fake.steps = 4
        plan = T.prepare(self.config, {"prompt": "after a reload"}, self.surface())
        with patch.object(videos.Jobs, "_track", lambda self, config, job: True):
            started = T.start(self.config, plan, self.surface(), target={"session": "s1"})   # the window went away
        job_id = started.job["id"]
        self.assertEqual(videos.load(job_id)["state"], "queued", "kept on disk from the start")
        self.assertFalse(self.jobs.polling(job_id))
        later = videos.Jobs()                                # the next DGC
        self.assertEqual(later.resume(self.config), [job_id])
        self.assertEqual(later.resume(self.config), [], "asking twice polls it once")
        final = later.wait(job_id, timeout=20)
        self.assertEqual(final["state"], "done")
        self.assertTrue(Path(final["result"]["path"]).is_file())
        self.assertEqual(videos.untold(session="s1")[0]["id"], job_id, "its chat hasn't been told yet")
        videos.mark_told(job_id)
        self.assertEqual(videos.untold(session="s1"), [])


class TwoDGCs(VideoCase):
    """A reload can leave the backend that started a job running beside the new one, and two windows share jobs:
    the DGC that doesn't poll a job watches its record and hears how it ends; when the poller goes, it takes over."""

    def setUp(self):
        super().setUp()
        env = patch.dict(os.environ, {"DGC_VIDEO_WATCH_S": "0.02"})
        env.start()
        self.addCleanup(env.stop)

    def test_the_other_dgc_hears_each_change_from_the_record(self):
        self.setup("fal", "fal-wan")
        self.fake.steps = 6
        plan = T.prepare(self.config, {"prompt": "x"}, self.surface())
        started = T.start(self.config, plan, self.surface(), target={"session": "s1"})   # polled by self.jobs
        other = videos.Jobs()
        heard = []
        other.add_listener(lambda job, change: heard.append((change, job["state"])))
        self.assertTrue(other.follow(self.config, started.job["id"]), "watched, since another DGC polls it")
        self.assertFalse(other.polling(started.job["id"]))
        self.assertEqual(other.resume(self.config), [], "and not polled twice")
        self.jobs.wait(started.job["id"], timeout=20)
        deadline = time.time() + 5
        while time.time() < deadline and ("done", "done") not in heard:
            time.sleep(0.02)
        self.assertIn(("done", "done"), heard)

    def test_when_the_poller_goes_the_watcher_takes_over(self):
        self.setup("fal", "fal-wan")
        self.fake.steps = 6
        plan = T.prepare(self.config, {"prompt": "x"}, self.surface())
        with patch.object(videos.Jobs, "_track", lambda self, config, job: True):
            started = T.start(self.config, plan, self.surface(), target={"session": "s1"})
        job_id = started.job["id"]
        first = videos.Jobs()
        fd = first._claim(job_id)                        # a DGC holds it (and polls nothing): then it goes
        later = videos.Jobs()
        heard = []
        later.add_listener(lambda job, change: heard.append(job["state"]))
        later.follow(self.config, job_id)
        self.assertTrue(later.watching(job_id))
        os.close(fd)
        deadline = time.time() + 20
        while time.time() < deadline and "done" not in heard:
            time.sleep(0.05)
        self.assertEqual(videos.load(job_id)["state"], "done")
        self.assertIn("done", heard)

    def test_a_chats_resume_takes_on_only_its_own_jobs(self):
        self.setup("fal", "fal-wan")
        plan = T.prepare(self.config, {"prompt": "x"}, self.surface())
        with patch.object(videos.Jobs, "_track", lambda self, config, job: True):
            mine = T.start(self.config, plan, self.surface(), target={"session": "s1"}).job["id"]
            theirs = T.start(self.config, plan, self.surface(), target={"session": "s2"}).job["id"]
        later = videos.Jobs()
        self.assertEqual(later.resume(self.config, keep=lambda job: job["target"].get("session") == "s1"), [mine])
        self.assertFalse(later.polling(theirs))


class Plans(VideoCase):
    def test_invalid_numeric_video_arguments_are_refused_before_a_provider_call(self):
        self.setup("fal-wan")
        for field, values in (("duration_s", (float("nan"), float("inf"), 1.5, True, 0, 61)),
                              ("seed", (float("nan"), float("-inf"), 1.5, True, 2**80))):
            for value in values:
                with self.subTest(field=field, value=value), self.assertRaises(T.Refused):
                    T.prepare(self.config, {"prompt": "a safe clip", field: value}, self.surface())
        self.assertFalse(self.fake.requests)

    def test_the_card_has_length_resolution_price_spend_and_the_prompt(self):
        self.setup("fal", "fal-wan", **{"fal-wan": {"monthly_limit_usd": 5}})
        images.add_spend("fal", 0.2)                       # pictures on the same key
        plan = T.prepare(self.config, {"prompt": "a felt ball", "duration_s": 5}, self.surface())
        card = plan.card()
        self.assertEqual(card["facts"], "5 s · 720p · about $0.15")
        self.assertEqual(card["this_month"], "$0.20 of your $5.00 limit", "the limit is shared with pictures")
        self.assertEqual(card["prompt"], "a felt ball")
        self.assertTrue(plan.asks, "every video asks by default")
        self.assertFalse(card.get("over_limit"))

    def test_a_job_that_would_pass_the_limit_says_so_and_is_not_sent(self):
        self.setup("fal", "fal-wan", **{"fal-wan": {"monthly_limit_usd": 0.3}})
        images.add_spend("fal", 0.2)
        plan = T.prepare(self.config, {"prompt": "too much"}, self.surface())
        self.assertTrue(plan.over_limit)
        self.assertTrue(plan.card()["over_limit"])
        self.assertIn("can't be made", plan.card()["note"])
        started = T.start(self.config, plan, self.surface())
        self.assertIsNone(started.job)
        self.assertIn("would pass this month's $0.30 limit", started.text)
        self.assertEqual(self.fake.requests, [], "nothing was sent")

    def test_running_jobs_count_against_the_limit(self):
        self.setup("fal", "fal-wan", **{"fal-wan": {"monthly_limit_usd": 0.25}})
        self.fake.steps = 10_000
        first = T.prepare(self.config, {"prompt": "one"}, self.surface())
        self.assertFalse(first.over_limit)
        T.start(self.config, first, self.surface())
        second = T.prepare(self.config, {"prompt": "two"}, self.surface())
        self.assertTrue(second.over_limit, "the first clip's $0.15 is on its way")

    def capped(self, cap=0.15):
        self.setup("fal", "fal-wan", **{"fal-wan": {"monthly_limit_usd": cap}})
        self.fake.steps = 10_000                             # they stay running: their estimates stay on the way

    def posts(self):
        return [r for r in self.fake.requests if r["method"] == "POST"]

    def test_two_plans_made_before_either_started_send_only_what_the_limit_holds(self):
        # A $0.15 limit and two $0.15 clips, each worked out (and its card shown) before either started.
        self.capped()
        plans = [T.prepare(self.config, {"prompt": f"clip {n}"}, self.surface()) for n in (1, 2)]
        self.assertFalse(any(plan.over_limit for plan in plans), "each fits when it is worked out")
        first = T.start(self.config, plans[0], self.surface())
        second = T.start(self.config, plans[1], self.surface())
        self.assertIsNotNone(first.job)
        self.assertIsNone(second.job, "the final check, just before it is sent, finds no room")
        self.assertEqual(second.error.kind, "over_limit")
        self.assertIn("would pass this month's $0.15 limit", second.text)
        self.assertIn("No video was made", second.text)
        self.assertEqual(len(self.posts()), 1, "one sent")
        self.assertEqual(videos.pending_spend(self.config, plans[0].generator), 0.15)

    def test_two_starting_at_the_same_moment_send_one(self):
        import threading
        self.capped()
        plans = [T.prepare(self.config, {"prompt": f"clip {n}"}, self.surface()) for n in (1, 2)]
        gate, out = threading.Barrier(2), []

        def go(plan):
            gate.wait()
            out.append(T.start(self.config, plan, self.surface()))
        threads = [threading.Thread(target=go, args=(plan,)) for plan in plans]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(20)
        self.assertEqual(sorted(started.job is not None for started in out), [False, True])
        self.assertEqual(len(self.posts()), 1)

    def test_another_dgc_cant_use_the_same_room(self):
        # Two windows are two processes: each worked out its clip before either started; only the first is sent.
        import subprocess
        import textwrap
        self.capped()
        mine = T.prepare(self.config, {"prompt": "mine"}, self.surface())
        script = textwrap.dedent("""
            import json, sys
            from pathlib import Path
            from dgc import config as C, image_tools, video_tools as T, videos
            config = C.Config(Path(sys.argv[1]))
            surface = image_tools.Surface(name="work", root=config.project_root, project_root=config.project_root,
                                          video_home=videos.session_folder("s2"))
            plan = T.prepare(config, {"prompt": "theirs"}, surface)
            print(json.dumps({"over_limit": plan.over_limit}), flush=True)
            sys.stdin.readline()                     # the first window starts its clip now
            started = T.start(config, plan, surface, target={"session": "s2"})
            print(json.dumps({"job": started.job is not None, "kind": getattr(started.error, "kind", "")}), flush=True)
        """)
        repo = str(Path(__file__).resolve().parent.parent)
        child = subprocess.Popen([sys.executable, "-c", script, str(self.root)], stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, text=True, cwd=repo,
                                 env={**os.environ, "DGC_HOME": str(self.home.root), "HOME": str(self.home.root),
                                      "PYTHONPATH": repo})
        try:
            self.assertEqual(json.loads(child.stdout.readline()), {"over_limit": False})
            self.assertIsNotNone(T.start(self.config, mine, self.surface()).job)
            child.stdin.write("go\n")
            child.stdin.flush()
            self.assertEqual(json.loads(child.stdout.readline()), {"job": False, "kind": "over_limit"})
        finally:
            child.kill()
            child.wait(10)
            child.stdout.close()
            child.stdin.close()
        self.assertEqual(len(self.posts()), 1)

    def test_a_job_being_sent_holds_its_estimate_and_its_record(self):
        # Written to disk (and counted) before it is sent, so a window that looks meanwhile sees it on its way; no
        # other DGC takes it on while it is sent.
        self.capped()
        plan = T.prepare(self.config, {"prompt": "x"}, self.surface())
        seen = {}
        real = V.FalVideo.submit

        def submit(adapter, generator, key, request):
            [job] = videos.all_jobs()
            seen.update(state=job["state"], pending=videos.pending_spend(self.config, generator),
                        other=videos.Jobs()._claim(job["id"]))
            return real(adapter, generator, key, request)
        with patch.object(V.FalVideo, "submit", submit):
            started = T.start(self.config, plan, self.surface())
        self.assertEqual((seen["state"], seen["pending"], seen["other"]), ("sending", 0.15, None))
        self.assertEqual(videos.load(started.job["id"])["state"] in ("queued", "running"), True)
        self.assertTrue(T.prepare(self.config, {"prompt": "y"}, self.surface()).over_limit)

    def test_a_job_its_sender_left_mid_send_ends(self):
        self.capped()
        plan = T.prepare(self.config, {"prompt": "x"}, self.surface())

        def gone(adapter, generator, key, request):
            raise KeyboardInterrupt                 # the window closed while it was being sent
        with patch.object(V.FalVideo, "submit", gone), self.assertRaises(KeyboardInterrupt):
            T.start(self.config, plan, self.surface())
        [job] = videos.all_jobs()
        self.assertEqual((job["state"], job["handle"]), ("sending", None))
        later = videos.Jobs()                        # the next DGC
        self.assertEqual(later.resume(self.config), [job["id"]])
        final = later.wait(job["id"], timeout=10)
        self.assertEqual(final["state"], "failed")
        self.assertIn("stopped while it was sending", final["error"]["message"])

    def test_a_refused_submit_leaves_no_record_and_frees_the_room(self):
        self.capped()
        self.fake.mode["fal"] = "locked"
        plan = T.prepare(self.config, {"prompt": "x"}, self.surface())
        self.assertIsNone(T.start(self.config, plan, self.surface()).job)
        self.assertEqual(videos.all_jobs(), [], "nothing to follow, and nothing for the chat to be told again")
        self.assertEqual(videos.pending_spend(self.config, plan.generator), 0)
        self.assertEqual(images.spent("fal-wan"), 0, "fal refused it: nothing charged")

    def test_pictures_being_made_count_against_a_videos_limit(self):
        self.capped()
        token = images.reserve(self.config, images.find(images.settings(self.config), "fal"), 0.1)
        try:
            self.assertTrue(T.prepare(self.config, {"prompt": "x"}, self.surface()).over_limit,
                            "a $0.10 picture on the same key is on its way")
        finally:
            images.settle(token, "fal", None)
        self.assertFalse(T.prepare(self.config, {"prompt": "x"}, self.surface()).over_limit)

    def test_an_unknown_price_under_a_limit_always_asks_and_says_why(self):
        # A model DGC has no price for, on a generator with a $0 limit (and asking turned off): it can't be held to
        # the limit, so it is never made without a yes to a card that says so.
        self.setup("fal", "fal-wan", **{"fal-wan": {"monthly_limit_usd": 0, "video_asks": False}})
        plan = T.prepare(self.config, {"prompt": "x", "model": "fal-ai/custom-paid-video"}, self.surface())
        self.assertIsNone(plan.estimate)
        self.assertTrue(plan.unpriced and plan.asks)
        self.assertFalse(plan.over_limit)
        card = plan.card()
        self.assertEqual((card["price"], card["price_unknown"]), ("price unknown", True))
        self.assertIn("DGC doesn't know what", card["note"])
        self.assertIn("can't keep this within your $0.00 monthly limit: it may cost more", card["note"])
        self.setup("fal", "fal-wan", **{"fal-wan": {"video_asks": False}})
        no_limit = T.prepare(self.config, {"prompt": "x", "model": "fal-ai/custom-paid-video"}, self.surface())
        self.assertFalse(no_limit.unpriced or no_limit.asks, "without a limit, the user's own switch stands")

    def test_only_video_generators_make_videos_and_pictures_skip_them(self):
        self.setup("fal", "fal-wan")
        with self.assertRaises(T.Refused) as said:
            T.prepare(self.config, {"prompt": "x", "generator": "fal"}, self.surface())
        self.assertIn("makes pictures, not videos", str(said.exception))
        picture = image_tools.prepare(self.config, {"prompt": "a fox"}, image_tools.Surface(
            name="work", root=self.root, project_root=self.root))
        self.assertEqual(picture.generator["id"], "fal", "the video model is never used for a picture")
        with self.assertRaises(image_tools.Refused):
            image_tools.prepare(self.config, {"prompt": "a fox", "generator": "fal-wan"}, image_tools.Surface(
                name="work", root=self.root, project_root=self.root))

    def test_lengths_and_resolutions_snap_to_what_the_model_makes(self):
        self.setup("fal", "fal-veo")
        plan = T.prepare(self.config, {"prompt": "x", "duration_s": 5, "resolution": "480p"}, self.surface())
        self.assertEqual((plan.request.duration_s, plan.request.resolution), (4, "720p"))
        self.assertIn("makes 4 s, 6 s, 8 s clips", plan.card()["note"])
        self.assertEqual(plan.estimate, 0.6)

    def test_no_video_generator_says_where_to_add_one(self):
        self.setup("fal")
        with self.assertRaises(T.Refused) as said:
            T.prepare(self.config, {"prompt": "x"}, self.surface())
        self.assertIn("Images & video", str(said.exception))
        self.assertIn("Runway and Higgsfield", str(said.exception))

    def test_list_video_generators_says_what_each_makes_and_costs(self):
        self.setup("fal", "fal-wan", "omni")
        text = T.list_text(self.config, {}, self.surface())
        self.assertIn('fal-wan "fal Wan 2.2"', text)
        self.assertIn("about $0.03/s ($0.15 a 5 s clip at 720p)", text)
        self.assertIn("asks before each video", text)
        self.assertIn('omni "Gemini Omni Flash"', text)
        self.assertIn("with sound", text)
        self.assertNotIn('fal "fal FLUX schnell"', text)
        pictures = images.listing_text(images.listing(self.config))
        self.assertIn("2 more make videos only", pictures)


class Charges(VideoCase):
    """A charge the provider may have made stays in this month's spend, whatever happens on DGC's side (a Stop after
    it finished, a download or a save that failed); it goes only when the provider says nothing was charged."""

    def capped(self, cap=0.15, steps=10_000):
        self.setup("fal", "fal-wan", **{"fal-wan": {"monthly_limit_usd": cap}})
        self.fake.steps = steps

    def wan(self):
        return images.find(images.settings(self.config), "fal-wan")

    def begun(self, state="queued"):
        plan = T.prepare(self.config, {"prompt": "x"}, self.surface())
        started = T.start(self.config, plan, self.surface(), target={"session": "s1"})
        deadline = time.time() + 5
        while (videos.load(started.job["id"]) or {}).get("state") != state and time.time() < deadline:
            time.sleep(0.02)
        return started.job["id"]

    def assertCounted(self, amount):
        self.assertAlmostEqual(images.spent("fal-wan"), amount, places=4)
        self.assertEqual(videos.pending_spend(self.config, self.wan()), 0, "and never twice")
        self.assertEqual(images.committed(self.config, self.wan()), amount)

    def test_a_stop_after_the_provider_finished_it_stays_counted(self):
        self.capped()
        job_id = self.begun()
        with patch.object(V.FalVideo, "cancel", return_value="finished"):
            stopped = self.jobs.stop(self.config, job_id)
        self.assertIn("so it is charged", stopped["charged"])
        self.assertCounted(0.15)
        self.assertTrue(T.prepare(self.config, {"prompt": "another"}, self.surface()).over_limit,
                        "the limit is used: the next clip isn't made")

    def test_a_stop_once_it_had_started_stays_counted(self):
        self.capped()
        job_id = self.begun("running")
        stopped = self.jobs.stop(self.config, job_id)
        self.assertIn("may still charge", stopped["charged"])
        self.assertCounted(0.15)

    def test_a_stop_before_it_started_frees_its_room(self):
        self.capped()
        job_id = self.begun("queued")
        stopped = self.jobs.stop(self.config, job_id)
        self.assertIn("nothing was charged", stopped["charged"])
        self.assertCounted(0)
        self.assertFalse(T.prepare(self.config, {"prompt": "another"}, self.surface()).over_limit)

    def test_a_video_made_but_not_downloaded_stays_counted(self):
        self.capped(steps=3)
        with patch.object(V, "download_to", side_effect=P.ImageError("server_down", "the download was cut off")):
            _plan, _started, job = self.run_job({"prompt": "x"})
        self.assertEqual(job["state"], "failed")
        self.assertIn("The provider made it, so it is charged", job["charged"])
        self.assertCounted(0.15)

    def test_a_video_dgc_couldnt_save_stays_counted(self):
        self.capped(steps=3)
        with patch.object(videos, "keep", side_effect=OSError(28, "No space left on device")):
            _plan, _started, job = self.run_job({"prompt": "x"})
        self.assertEqual(job["state"], "failed")
        self.assertIn("couldn't save the video", job["error"]["message"])
        self.assertCounted(0.15)

    def test_a_stop_racing_the_download_counts_it_once(self):
        self.capped(steps=3)
        real = V.VideoAdapter.fetch

        def fetch(adapter, generator, key, handle, status, dest, cancel=None):
            [job] = videos.all_jobs()
            with patch.object(V.FalVideo, "cancel", return_value="finished"):
                self.jobs.stop(self.config, job["id"])      # the user's Stop, as the file comes down
            return real(adapter, generator, key, handle, status, dest)
        with patch.object(V.FalVideo, "fetch", fetch):
            _plan, _started, job = self.run_job({"prompt": "x"})
        self.assertEqual(job["state"], "cancelled", "the Stop came first, and stands")
        self.assertCounted(0.15)
        self.assertEqual(videos.library()["total"], 0, "a stopped download must not enter the Library")

    def test_a_job_the_provider_says_failed_frees_its_room(self):
        self.setup("rep", **{"rep": {"monthly_limit_usd": 0.1}})
        self.fake.mode["replicate"] = "failed"
        _plan, _started, job = self.run_job({"prompt": "x"})
        self.assertEqual(job["state"], "failed")
        self.assertNotIn("charged", job)
        self.assertEqual(images.spent("rep"), 0)
        self.assertFalse(T.prepare(self.config, {"prompt": "y"}, self.surface()).over_limit)

    def test_a_job_dgc_lost_sight_of_stays_counted(self):
        # Its poll can't be read any more (the key was replaced, say): the provider may still make and charge it.
        self.capped()
        with patch.object(V.FalVideo, "poll", return_value=V.Status("failed", "no", error=P.ImageError(
                "bad_key", "Authentication is required", status=401))):
            _plan, _started, job = self.run_job({"prompt": "x"})
        self.assertEqual(job["state"], "failed")
        self.assertIn("may still charge", job["charged"])
        self.assertCounted(0.15)

    def test_a_job_left_mid_send_is_counted_when_it_ends(self):
        self.capped()
        plan = T.prepare(self.config, {"prompt": "x"}, self.surface())
        with patch.object(V.FalVideo, "submit", side_effect=KeyboardInterrupt), self.assertRaises(KeyboardInterrupt):
            T.start(self.config, plan, self.surface())
        self.assertEqual(images.committed(self.config, self.wan()), 0.15, "on its way meanwhile")
        later = videos.Jobs()
        later.resume(self.config)
        [job] = videos.all_jobs()
        self.assertEqual(later.wait(job["id"], timeout=10)["state"], "failed")
        self.assertCounted(0.15)

    def test_a_submit_whose_answer_never_came_stays_counted(self):
        import socket
        import threading
        server = socket.socket()
        server.bind(("127.0.0.1", 0))
        server.listen(1)
        self.addCleanup(server.close)

        def hang_up():                               # reads the request, then closes without an answer
            conn, _ = server.accept()
            conn.recv(65536)
            conn.close()
        threading.Thread(target=hang_up, daemon=True).start()
        self.setup("fal-wan", **{"fal-wan": {"monthly_limit_usd": 1,
                                             "base_url": f"http://127.0.0.1:{server.getsockname()[1]}"}})
        plan = T.prepare(self.config, {"prompt": "x"}, self.surface())
        started = T.start(self.config, plan, self.surface())
        self.assertIsNone(started.job)
        self.assertIn("The provider may still charge for it", started.text)
        self.assertEqual(videos.all_jobs(), [])
        self.assertAlmostEqual(images.spent("fal-wan"), 0.15, places=4)


class CutOff(VideoCase):
    """A file that is cut off or odd says less about itself; it never stops the job from ending."""

    def test_probe_reads_what_is_there_of_a_cut_off_file(self):
        import struct
        from video_fakes import mp4
        path = self.root / "clip.mp4"
        whole = mp4()
        path.write_bytes(whole)
        self.assertEqual(videos.probe(path), {"seconds": 5.0, "width": 1280, "height": 720})
        for size in range(0, len(whole), 7):
            path.write_bytes(whole[:size])
            with self.subTest(size=size):
                self.assertIsInstance(videos.probe(path), dict)
        path.write_bytes(whole[:28] + struct.pack(">I4sI4s", 16, b"moov", 8, b"mvhd"))      # an empty mvhd
        self.assertEqual(videos.probe(path), {})
        path.write_bytes(whole[:28] + struct.pack(">I4sI4s", 16, b"moov", 8, b"trak") + struct.pack(">I4s", 8, b"tkhd"))
        self.assertEqual(videos.probe(path), {})

    def test_a_cut_off_video_from_the_provider_still_ends_its_job(self):
        import struct
        self.setup("fal", "fal-wan")
        self.fake.video = self.fake.video[:28] + struct.pack(">I4sI4s", 16, b"moov", 8, b"mvhd")
        _plan, _started, job = self.run_job({"prompt": "x"})
        self.assertEqual(job["state"], "done", "kept as the provider sent it")
        self.assertTrue(Path(job["result"]["path"]).is_file())
        self.assertNotIn("seconds", job["result"])
        self.assertEqual(images.spent("fal-wan"), 0.15)
        self.assertFalse(self.jobs.polling(job["id"]))

    def test_a_file_dgc_cant_read_fails_its_job_instead_of_leaving_it_running(self):
        self.setup("fal", "fal-wan")
        with patch.object(videos, "probe", side_effect=IndexError("index out of range")):
            _plan, _started, job = self.run_job({"prompt": "x"})
        self.assertEqual(job["state"], "failed")
        self.assertIn("couldn't read the video", job["error"]["message"])
        self.assertEqual(videos.Jobs().resume(self.config), [], "nothing left to poll again after a reload")


class Gemini(VideoCase):
    def test_omni_flash_in_the_background_then_its_inline_video(self):
        self.setup("omni")
        plan, started, job = self.run_job({"prompt": "waves at dusk", "aspect": "9:16"})
        self.assertIsNone(plan.request.duration_s, "Omni Flash chooses the length")
        self.assertEqual(plan.card()["facts"], "about 8 s (the model chooses) · 720p · about $0.80")
        body = self.fake.requests[0]["body"]
        self.assertEqual((body["model"], body["background"], body["response_format"]["aspect_ratio"]),
                         ("gemini-omni-1.1-flash", True, "9:16"))
        self.assertEqual(job["state"], "done")
        self.assertEqual(Path(job["result"]["path"]).read_bytes(), self.fake.video)

    def test_omni_flash_by_uri_downloads_the_file(self):
        self.setup("omni")
        self.fake.mode["gemini"] = "uri"
        _plan, _started, job = self.run_job({"prompt": "waves"})
        self.assertEqual(job["state"], "done")
        self.assertIn("/v1beta/files/abc123:download", self.fake.paths("GET")[-1])

    def test_a_veo_model_runs_as_an_operation(self):
        self.setup("veo")
        _plan, _started, job = self.run_job({"prompt": "a lighthouse", "duration_s": 8})
        self.assertTrue(self.fake.requests[0]["path"].endswith(":predictLongRunning"))
        self.assertEqual(self.fake.requests[0]["body"]["parameters"]["durationSeconds"], 8)
        self.assertTrue(any("/operations/" in p for p in self.fake.paths("GET")))
        self.assertEqual(job["state"], "done")

    def test_no_billing_says_plainly_that_video_needs_a_paid_project(self):
        self.setup("omni")
        self.fake.mode["gemini"] = "no_billing"
        plan = T.prepare(self.config, {"prompt": "x"}, self.surface())
        started = T.start(self.config, plan, self.surface())
        self.assertIsNone(started.job)
        self.assertIn("needs credit", started.text)
        self.assertIn("needs a paid Gemini API project (it has no free tier)", started.text)
        self.assertEqual(images.last_state(plan.generator)["kind"], "needs_credit")


class ProviderKeys(VideoCase):
    """A provider's key goes to the provider's own address only: never to a video address it points elsewhere, never
    along a redirect to another host, and a job's poll addresses stay on the provider's own."""

    def elsewhere(self, **extra):
        from video_fakes import Elsewhere
        server = Elsewhere(self.fake.video, **extra)
        self.addCleanup(server.close)
        return server

    def gemini(self, base=None):
        self.setup("omni")
        generator = images.find(images.settings(self.config), "omni")
        return {**generator, "base_url": base or generator["base_url"]}

    def test_a_gemini_video_at_another_private_address_is_blocked_without_the_key(self):
        generator, other = self.gemini(), self.elsewhere()
        dest = self.root / "clip.mp4"
        with self.assertRaisesRegex(P.ImageError, "unsafe video address"):
            V.GeminiVideo().fetch(generator, "gemini-key", {},
                                  V.Status("done", result={"url": other.url + "/collect"}), dest)
        self.assertFalse(other.requests, "a provider result must never reach a second local service")
        self.assertFalse(dest.exists())
        V.GeminiVideo().fetch(generator, "gemini-key", {}, V.Status("done", result={
            "url": self.fake.url + "/v1beta/files/abc123:download?alt=media"}), self.root / "own.mp4")
        self.assertEqual(self.fake.requests[-1]["headers"].get("x-goog-api-key"), "gemini-key",
                         "Gemini's own file download still carries it")

    def test_a_local_download_redirect_to_another_address_is_blocked(self):
        other = self.elsewhere()
        door = self.elsewhere(to=other.url)
        generator = self.gemini(base=door.url)
        with self.assertRaisesRegex(P.ImageError, "redirected outside"):
            V.GeminiVideo().fetch(generator, "gemini-key", {}, V.Status("done", result={
                "url": door.url + "/v1beta/files/abc:download?alt=media"}), self.root / "clip.mp4")
        self.assertEqual(door.requests[0]["headers"].get("x-goog-api-key"), "gemini-key", "to its own address")
        self.assertFalse(other.requests, "a redirect must not reach a second local service")
        # Every provider's requests (image_providers.http): a poll redirected elsewhere loses its Authorization.
        P.http("GET", door.url + "/status", headers={"Authorization": "Key fal-key"})
        self.assertNotIn("authorization", other.requests[-1]["headers"])
        self.assertEqual(door.requests[-1]["headers"].get("authorization"), "Key fal-key")

    def test_a_public_download_redirect_drops_the_providers_key(self):
        # The fake servers use loopback. Substitute only the public-address validator's checked
        # address so this exercises the production redirect and pinned-connection path locally.
        from dgc import tools
        other = self.elsewhere()
        door = self.elsewhere(to=other.url)
        with patch.object(tools, "_public_destination", side_effect=lambda url: (url, ("127.0.0.1",))):
            mime = V.download_to(door.url + "/video", self.root / "redirect.mp4",
                                 headers={"x-goog-api-key": "gemini-key"}, provider="gemini")
        self.assertEqual(mime, "video/mp4")
        self.assertEqual(door.requests[0]["headers"].get("x-goog-api-key"), "gemini-key")
        self.assertNotIn("x-goog-api-key", other.requests[0]["headers"])

    def test_a_redirect_on_the_same_address_keeps_it(self):
        door = self.elsewhere()
        door.to = door.url
        from dgc import image_providers as P
        P.http("GET", door.url + "/status", headers={"Authorization": "Key fal-key"})
        self.assertEqual([r["path"] for r in door.requests], ["/status", "/landed/status"])
        self.assertEqual(door.requests[-1]["headers"].get("authorization"), "Key fal-key")

    def test_a_jobs_poll_addresses_stay_on_the_providers_own(self):
        from dgc import image_providers as P
        self.setup("fal", "fal-wan", "rep")
        rows = {g["id"]: g for g in images.settings(self.config)["generators"]}
        away = "https://collector.example.com/steal"
        answer = P.Answer(200, json.dumps({"request_id": "r1", "status_url": away, "response_url": away,
                                           "cancel_url": away, "id": "p1", "urls": {"get": away, "cancel": away}})
                          .encode(), {})
        with patch.object(V, "http", return_value=answer):
            fal = V.FalVideo().submit(rows["fal-wan"], "fal-key", V.VideoRequest(prompt="x"))
            rep = V.ReplicateVideo().submit(rows["rep"], "r8_key", V.VideoRequest(prompt="x"))
        base = f"{self.fake.url}/fal-ai/wan/v2.2-5b/text-to-video/requests/r1"
        self.assertEqual((fal["status_url"], fal["response_url"], fal["cancel_url"]),
                         (base + "/status", base, base + "/cancel"))
        self.assertEqual((rep["get"], rep["cancel"]), (f"{self.fake.url}/v1/predictions/p1",
                                                       f"{self.fake.url}/v1/predictions/p1/cancel"))


class Replicate(VideoCase):
    def test_a_prediction_then_its_output(self):
        self.setup("rep")
        _plan, _started, job = self.run_job({"prompt": "a paper boat", "resolution": "480p"})
        body = self.fake.requests[0]["body"]
        self.assertEqual(self.fake.requests[0]["path"], "/v1/models/wan-video/wan-2.2-t2v-fast/predictions")
        self.assertEqual((body["input"]["num_frames"], body["input"]["resolution"]), (81, "480p"))
        self.assertEqual(job["state"], "done")
        self.assertEqual(job["cost_usd"], 0.05)

    def test_a_failed_prediction(self):
        self.setup("rep")
        self.fake.mode["replicate"] = "failed"
        _plan, _started, job = self.run_job({"prompt": "x"})
        self.assertEqual((job["state"], job["error"]["kind"]), ("failed", "failed"))
        self.assertIn("CUDA out of memory", job["error"]["message"])


class Comfy(VideoCase):
    def test_a_wan_workflow_is_mapped_with_its_length_and_frame_rate(self):
        mapping, notes = V.detect_video_mapping(WAN_WORKFLOW)
        self.assertEqual({k: mapping[k] for k in ("prompt", "negative", "seed", "width", "height", "frames", "fps")},
                         {"prompt": "6.text", "negative": "7.text", "seed": "3.seed", "width": "55.width",
                          "height": "55.height", "frames": "55.length", "fps": "57.fps"})
        self.assertEqual(notes, [])

    def test_the_workflow_runs_with_the_prompt_size_and_length_set(self):
        self.setup("comfy-video")
        plan, _started, job = self.run_job({"prompt": "a koi pond", "duration_s": 4, "aspect": "9:16"})
        self.assertEqual(plan.estimate, 0.0)
        queued = next(r for r in self.fake.requests if r["path"] == "/prompt")["body"]["prompt"]
        self.assertEqual(queued["6"]["inputs"]["text"], "a koi pond")
        self.assertEqual((queued["55"]["inputs"]["width"], queued["55"]["inputs"]["height"]), (720, 1280))
        self.assertEqual(queued["55"]["inputs"]["length"], 97, "4 s at 24 fps, as Wan's 4n+1")
        self.assertEqual(job["state"], "done")
        self.assertTrue(any(p == "/view" for p in self.fake.paths("GET")))
        self.assertEqual(videos.line(job), "Made a 5 s video with ComfyUI Wan · 720p · free")


if __name__ == "__main__":
    unittest.main()
