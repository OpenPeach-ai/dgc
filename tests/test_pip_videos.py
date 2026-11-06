"""Video generation for Pips (0.51): started by the controller with the user's generators (the worker never holds a
key), every video only after the user's own yes in a later turn of the Pip's chat, its job shown with the reply (then
its player), and a routine never making one unless the user allowed that Pip for that generator."""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from video_fakes import FakeVideos  # noqa: E402

from dgc import pip_chat, pip_videos, videos  # noqa: E402
from tests import test_pips_local as fixtures  # noqa: E402


class PipVideos(unittest.TestCase):
    setUp_pips = fixtures.LocalPipsTests.setUp
    git = fixtures.LocalPipsTests.git
    commit = fixtures.LocalPipsTests.commit
    create = fixtures.LocalPipsTests.create

    def setUp(self):
        self.setUp_pips()
        self.fake = FakeVideos()
        self.addCleanup(self.fake.close)
        env = patch.dict(os.environ, {"DGC_VIDEO_POLL_S": "0.02"})
        env.start()
        self.addCleanup(env.stop)
        ctx = videos.fresh_jobs()
        self.jobs = ctx.__enter__()
        self.addCleanup(ctx.__exit__, None, None, None)
        self.commit()
        self.job = self.create()

    def generators(self, **extra):
        wan = {"id": "fal-wan", "name": "fal Wan 2.2", "provider": "fal", "base_url": self.fake.url,
               "model": "fal-ai/wan/v2.2-5b/text-to-video", "makes": "videos", **extra}
        self.cfg.set_images({"generators": [{"id": "fal", "name": "fal FLUX", "provider": "fal",
                                             "base_url": self.fake.url, "model": "fal-ai/flux/schnell"}, wan]},
                            persist=False)
        self.cfg.set_image_key("fal", "fal-key", persist=False)

    def send(self, text, key):
        return pip_chat.send(self.store, self.job["id"], text, key, "device_1", self.cfg)

    def session(self, run_id, *, user_turn=True, unattended=False, user_message="Yes, make it"):
        session = pip_videos.Session(self.registry.directory, self.cfg, self.job["id"], self.job["workspace_id"],
                                     run_id, unattended=unattended)
        session.user_turn = user_turn
        session.user_message = user_message if user_turn else ""
        return session

    def reply(self):
        return [m for m in pip_chat.list_messages(self.store, self.job["id"])["messages"] if m["role"] == "assistant"]

    def fal_posts(self):
        return [r for r in self.fake.requests if r["method"] == "POST" and r["path"].startswith("/fal-ai/")]

    def test_it_waits_for_the_users_own_yes_then_the_reply_shows_the_video(self):
        self.generators()
        first = self.send("Make a clip of a felt ball", "m1")
        said = self.session(first["run"]["id"]).call("generate_video", {"prompt": "a felt ball rolls"})
        self.assertTrue(said.startswith("Not made yet: a video with fal Wan 2.2 5B: 5 s · 720p · about $0.15"), said)
        again = self.session(first["run"]["id"]).call("generate_video", {"prompt": "a felt ball rolls",
                                                                         "confirm": True})
        self.assertIn("the user hasn't answered yet", again, "its own yes in the same turn doesn't count")
        self.assertEqual(self.fal_posts(), [])
        self.store.claim_next()
        self.store.finish(first["run"]["id"], result={"text": "It costs about $0.15. Make it?"})
        second = self.send("Yes, make it", "m2")
        made = self.session(second["run"]["id"]).call("generate_video", {"prompt": "a felt ball rolls",
                                                                        "confirm": True})
        self.assertTrue(made.startswith("Started a 5 s video with fal Wan 2.2 5B"), made)
        self.assertIn("it shows with your reply in your chat when it's ready", made)
        job_id = made.split("(job ")[1].split(")")[0]
        self.store.claim_next()
        self.store.finish(second["run"]["id"], result={"text": "Started it."})
        self.jobs.wait(job_id, timeout=20)
        reply = self.reply()[-1]
        [clip] = reply["videos"]
        self.assertEqual((clip["id"], clip["state"]), (job_id, "done"))
        self.assertTrue(Path(clip["result"]["path"]).is_relative_to(videos.pip_folder(self.job["id"])))
        self.assertEqual(videos.load(job_id)["target"]["message"], reply["id"])

    def test_a_routine_never_makes_one_unless_the_user_allowed_this_pip(self):
        self.generators()
        sent = self.send("run", "m1")
        said = self.session(sent["run"]["id"], user_turn=False, unattended=True).call(
            "generate_video", {"prompt": "x", "confirm": True})
        self.assertIn("A routine makes a video only for a Pip the user allowed", said)
        self.assertFalse(self.session(sent["run"]["id"])._pending_path().exists(),
                         "an unattended run cannot leave a pending yes")
        self.assertEqual(self.fal_posts(), [])
        self.generators(video_pips=[self.job["id"]])
        said = self.session(sent["run"]["id"], user_turn=False, unattended=True).call("generate_video", {"prompt": "x"})
        self.assertTrue(said.startswith("Started a 5 s video"), said)
        self.assertEqual(len(self.fal_posts()), 1)

    def test_video_confirmation_requires_yes_and_exact_request(self):
        self.generators()
        first = self.send("Make a clip", "m1")
        self.session(first["run"]["id"]).call("generate_video", {"prompt": "a felt ball rolls"})
        refused = self.session("run_" + "5" * 32, user_message="No").call(
            "generate_video", {"prompt": "a felt ball rolls", "confirm": True})
        self.assertIn("did not explicitly say yes", refused)
        changed = self.session("run_" + "6" * 32).call(
            "generate_video", {"prompt": "a blue ball rolls", "confirm": True})
        self.assertIn("video request changed", changed)
        self.assertEqual(self.fal_posts(), [])

    def test_a_yes_to_a_price_never_covers_one_dgc_doesnt_know(self):
        # The user was asked about a $0.15 clip; the Pip then makes it with a model DGC has no price for, under a $0
        # limit, and says confirm.
        self.generators(monthly_limit_usd=5)
        first = self.send("Make a clip", "m1")
        self.session(first["run"]["id"]).call("generate_video", {"prompt": "a felt ball rolls"})
        self.assertEqual(self.session("run_" + "2" * 32)._pending()["total"], 0.15)
        self.generators(monthly_limit_usd=0)
        said = self.session("run_" + "3" * 32).call("generate_video", {"prompt": "a felt ball rolls",
                                                                       "model": "fal-ai/custom-paid-video",
                                                                       "confirm": True})
        self.assertIn("doesn't cover it", said)
        self.assertIn("DGC doesn't know what", said, "the new question says its price is unknown")
        self.assertEqual(self.fal_posts(), [])
        made = self.session("run_" + "4" * 32).call("generate_video", {"prompt": "a felt ball rolls",
                                                                       "model": "fal-ai/custom-paid-video",
                                                                       "confirm": True})
        self.assertTrue(made.startswith("Started"), "a yes to that question, its risk said, makes it")
        self.assertEqual(len(self.fal_posts()), 1)

    def test_a_routine_never_makes_one_at_a_price_dgc_doesnt_know(self):
        self.generators(video_pips=[self.job["id"]], monthly_limit_usd=5)
        sent = self.send("run", "m1")
        said = self.session(sent["run"]["id"], user_turn=False, unattended=True).call(
            "generate_video", {"prompt": "x", "model": "fal-ai/custom-paid-video"})
        self.assertTrue(said.startswith("Not made"), said)
        self.assertIn("only at a price DGC knows", said)
        self.assertEqual(self.fal_posts(), [])

    def test_one_video_a_run(self):
        self.generators(video_asks=False)
        sent = self.send("two clips", "m1")
        session = self.session(sent["run"]["id"])
        self.assertTrue(session.call("generate_video", {"prompt": "one"}).startswith("Started"))
        self.assertIn("started a video already", session.call("generate_video", {"prompt": "two"}))

    def test_offered_to_a_personal_pip_through_its_app_socket(self):
        from dgc import pip_app_links
        self.assertTrue(set(pip_videos.TOOLS) <= {s["function"]["name"] for s in pip_videos.schemas()})
        self.assertNotIn("save_to", pip_videos.GENERATE["function"]["parameters"]["properties"])
        self.assertIn("confirm", pip_videos.GENERATE["function"]["parameters"]["properties"])
        self.assertTrue(hasattr(pip_app_links.RunSocket, "call"))


if __name__ == "__main__":
    unittest.main()
