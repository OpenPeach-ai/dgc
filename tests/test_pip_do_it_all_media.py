"""A Pip at Do it all makes a paid picture or video without asking first (his call, 17 Nov: "Image and video costs
don't carry that risk, so for them, drop all limits" -- "yes agreed"), in its chat and in a routine with nobody there.
What it cost is in the result. A monthly limit the user set on a generator still holds: past it, or at a price DGC
can't hold to it, the Pip asks in its reply as before. The other levels ask as they always did."""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from image_fakes import FakeImages  # noqa: E402
from video_fakes import FakeVideos  # noqa: E402

from dgc import images, pip_chat, pip_images, pip_levels, pip_videos, videos  # noqa: E402
from tests import test_pips_local as fixtures  # noqa: E402


class Base(unittest.TestCase):
    setUp_pips = fixtures.LocalPipsTests.setUp
    git = fixtures.LocalPipsTests.git
    commit = fixtures.LocalPipsTests.commit
    create = fixtures.LocalPipsTests.create

    def setUp(self):
        self.setUp_pips()
        self.commit()
        self.job = self.create()

    def does_it_all(self):
        pip_levels.set_level(self.registry, self.job["id"], pip_levels.FULL, "editor-user")

    def send(self, text, key):
        return pip_chat.send(self.store, self.job["id"], text, key, "device_1", self.cfg)


class Pictures(Base):
    def setUp(self):
        super().setUp()
        self.fake = FakeImages()
        self.addCleanup(self.fake.close)
        self.cfg.set_images({"generators": [{"id": "fal", "name": "fal FLUX schnell", "provider": "fal",
                                             "base_url": self.fake.url, "model": "fal-ai/flux/schnell"}]},
                            persist=False)
        self.cfg.set_image_key("fal", "fal-key", persist=False)

    def session(self, run_id, *, unattended=False):
        session = pip_images.Session(self.registry.directory, self.cfg, self.job["id"], self.job["workspace_id"],
                                     run_id, unattended=unattended)
        session.user_turn = not unattended
        session.user_message = "" if unattended else "Make me a logo"
        return session

    def spent(self):
        return [r for r in self.fake.requests if r["path"].startswith("/fal-ai/")]

    def test_at_do_it_all_a_paid_picture_is_made_at_once_with_its_price(self):
        self.does_it_all()
        sent = self.send("Make me a logo", "m1")
        said = self.session(sent["run"]["id"]).call("generate_image", {"prompt": "a minimal fox logo"})
        self.assertTrue(said.startswith("Made 1 image with fal FLUX schnell"), said)
        self.assertIn("$", said, "what it cost")
        self.assertEqual(len(self.spent()), 1)

    def test_a_routine_at_do_it_all_makes_it_too(self):
        self.does_it_all()
        sent = self.send("Make me a logo", "m1")
        said = self.session(sent["run"]["id"], unattended=True).call("generate_image", {"prompt": "a fox logo"})
        self.assertTrue(said.startswith("Made 1 image"), said)

    def test_a_limit_the_user_set_still_asks_in_the_reply(self):
        self.does_it_all()
        block = images.settings(self.cfg)
        block["generators"][0].update(monthly_limit_usd=5)
        self.cfg.set_images(block, persist=False)
        sent = self.send("Make me a logo", "m1")
        said = self.session(sent["run"]["id"]).call("generate_image", {"prompt": "a fox", "model": "fal-ai/brand-new"})
        self.assertIn("Not made", said, "a price DGC can't hold to the user's own limit asks, at every level")
        self.assertEqual(self.spent(), [])

    def test_the_other_levels_still_ask(self):
        for level in (pip_levels.ASK, pip_levels.APPROVE):
            pip_levels.set_level(self.registry, self.job["id"], level, "editor-user")
            sent = self.send(f"Make me a logo ({level})", f"m-{level}")
            said = self.session(sent["run"]["id"]).call("generate_image", {"prompt": "a fox"})
            self.assertTrue(said.startswith("Not made yet"), f"{level}: {said}")
        self.assertEqual(self.spent(), [])


class Videos(Base):
    def setUp(self):
        super().setUp()
        self.fake = FakeVideos()
        self.addCleanup(self.fake.close)
        env = patch.dict(os.environ, {"DGC_VIDEO_POLL_S": "0.02"})
        env.start()
        self.addCleanup(env.stop)
        ctx = videos.fresh_jobs()
        ctx.__enter__()
        self.addCleanup(ctx.__exit__, None, None, None)
        wan = {"id": "fal-wan", "name": "fal Wan 2.2", "provider": "fal", "base_url": self.fake.url,
               "model": "fal-ai/wan/v2.2-5b/text-to-video", "makes": "videos"}
        self.cfg.set_images({"generators": [{"id": "fal", "name": "fal FLUX", "provider": "fal", "base_url": self.fake.url,
                                             "model": "fal-ai/flux/schnell"}, wan]}, persist=False)
        self.cfg.set_image_key("fal", "fal-key", persist=False)

    def session(self, run_id, *, unattended=False):
        session = pip_videos.Session(self.registry.directory, self.cfg, self.job["id"], self.job["workspace_id"],
                                     run_id, unattended=unattended)
        session.user_turn = not unattended
        session.user_message = "" if unattended else "Make a clip"
        return session

    def posts(self):
        return [r for r in self.fake.requests if r["method"] == "POST" and r["path"].startswith("/fal-ai/")]

    def test_at_do_it_all_a_video_starts_at_once(self):
        self.does_it_all()
        sent = self.send("Make a clip of a felt ball", "m1")
        said = self.session(sent["run"]["id"]).call("generate_video", {"prompt": "a felt ball rolls"})
        self.assertNotIn("Not made", said)
        self.assertEqual(len(self.posts()), 1)

    def test_a_routine_at_do_it_all_starts_one_too(self):
        self.does_it_all()
        sent = self.send("Make a clip", "m1")
        said = self.session(sent["run"]["id"], unattended=True).call("generate_video", {"prompt": "a ball"})
        self.assertNotIn("Not made", said)
        self.assertEqual(len(self.posts()), 1)

    def test_ask_me_first_still_asks(self):
        sent = self.send("Make a clip", "m1")
        said = self.session(sent["run"]["id"]).call("generate_video", {"prompt": "a ball"})
        self.assertTrue(said.startswith("Not made yet"), said)
        self.assertEqual(self.posts(), [])


if __name__ == "__main__":
    unittest.main()
