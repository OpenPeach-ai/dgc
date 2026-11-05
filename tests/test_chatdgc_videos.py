"""Video generation in ChatDGC (0.51): generate_video in a reply puts a card with its length and price under the reply
and makes nothing until the user sends it; sending starts the job, the card follows it (running, then the player),
the card is kept with the chat so a reopened (or reloaded) chat shows it again, and a Stop ends it."""
from __future__ import annotations

import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_chatdgc_made import Model  # noqa: E402
from test_images_config import Home  # noqa: E402
from video_fakes import FakeVideos  # noqa: E402

from dgc import videos  # noqa: E402
from dgc.chatdgc.engine import ChatEngine  # noqa: E402
from dgc.chatdgc.store import ChatStore  # noqa: E402
from dgc.shared_memory import SharedMemory  # noqa: E402


class VideosInChat(unittest.TestCase):
    def setUp(self):
        self.fake = FakeVideos()
        self.addCleanup(self.fake.close)
        self.home = Home()
        self.home.__enter__()
        self.addCleanup(self.home.__exit__)
        env = patch.dict(os.environ, {"DGC_VIDEO_POLL_S": "0.02"})
        env.start()
        self.addCleanup(env.stop)
        ctx = videos.fresh_jobs()
        self.jobs = ctx.__enter__()
        self.addCleanup(ctx.__exit__, None, None, None)
        self.config = self.home.config()
        folder = Path(tempfile.mkdtemp(prefix="chatdgc-videos-"))
        self.world = {"script": [], "read": []}
        self.store = ChatStore(folder / "chat")
        self.engine = ChatEngine(self.config, self.store, searcher=lambda q: [], memory=SharedMemory(folder / "memory"),
                                 projects=lambda hidden: [], client_factory=lambda model: Model(self.world),
                                 plugins=lambda chat, said, taint: None)
        self.config.set_images({"generators": [
            {"id": "fal", "name": "fal FLUX schnell", "provider": "fal", "base_url": self.fake.url,
             "model": "fal-ai/flux/schnell"},
            {"id": "fal-wan", "name": "fal Wan 2.2", "provider": "fal", "base_url": self.fake.url,
             "model": "fal-ai/wan/v2.2-5b/text-to-video", "makes": "videos"}]})
        self.config.set_image_key("fal", "fal-key")

    def say(self, text, *steps, chat=None, **kwargs):
        self.world["script"] += list(steps)
        chat = chat or self.engine.open()
        return chat, self.engine.send(chat["id"], text, search="off", **kwargs)

    def told(self, n=-1):
        return [m["content"] for m in self.world["read"][n]["messages"] if m["role"] == "tool"]

    def card_now(self, chat_id, message_id):
        message = next(m for m in self.engine.open(chat_id)["messages"] if m["id"] == message_id)
        return message["actions"][0]

    def test_offered_in_every_reply(self):
        self.say("hi", {"parts": ["Hello."]})
        self.assertTrue({"generate_video", "list_video_generators"} <= set(self.world["read"][0]["tools"]))

    def test_a_card_with_its_price_then_the_job_then_the_player(self):
        chat, reply = self.say("Animate a felt ball.", {"parts": ["One moment."], "calls": [
            ("generate_video", {"prompt": "a felt ball rolls", "duration_s": 5})]}, {"parts": [" There's a card."]})
        [card] = reply["actions"]
        self.assertEqual((card["kind"], card["status"], card["price"]), ("video", "waiting", "about $0.15"))
        self.assertEqual(card["card"]["facts"], "5 s · 720p · about $0.15")
        self.assertIn("Nothing is made until the user sends it", self.told(1)[0])
        self.assertTrue(self.told(1)[0].startswith("A card is in the chat now: "), "never where it is (0.51: it sits in the reply)")
        self.assertIn("don't say where the card is", self.told(1)[0])
        self.assertEqual(self.fake.requests, [], "nothing sent")
        sent = self.engine.act(chat["id"], reply["id"], card["id"], "run")
        self.assertIn(sent["status"], ("running", "done"))
        self.assertTrue(sent["job"].startswith("vid_"))
        self.jobs.wait(sent["job"], timeout=20)
        from dgc.chatdgc import videos as chat_videos
        chat_videos.apply(self.engine, videos.load(sent["job"]))
        now = self.card_now(chat["id"], reply["id"])
        self.assertEqual(now["status"], "done")
        self.assertTrue(Path(now["video"]["path"]).is_file())
        self.assertEqual(Path(now["video"]["path"]).parent, videos.chat_folder(chat["id"]), "the chat's own folder")
        self.assertIn("Made a 5 s video with fal Wan 2.2 5B · 720p · $0.15", now["answer"])
        self.assertEqual(self.engine.open(chat["id"])["video_generator"], "fal-wan", "remembered for this chat")
        with self.assertRaises(Exception):
            self.engine.act(chat["id"], reply["id"], card["id"], "run")       # sent once

    def test_through_the_service_the_card_follows_its_job_and_survives_a_reopen(self):
        from dgc.chatdgc.service import ChatService
        from dgc.editor_protocol import event_error
        frames = []

        def emit(type, **fields):
            frame = {"type": type, "seq": len(frames), **fields}
            self.assertIsNone(event_error(frame), frame)
            frames.append(frame)
        service = ChatService(emit, self.config, engine=self.engine)
        self.addCleanup(service.close, 2.0)
        chat, reply = self.say("Make a clip.", {"calls": [("generate_video", {"prompt": "waves"})]},
                               {"parts": ["A card."]})
        card = reply["actions"][0]
        service.dispatch({"type": "chatdgc_action", "request_id": "a1", "conversation_id": chat["id"],
                          "message_id": reply["id"], "action_id": card["id"], "op": "run"})
        deadline = time.monotonic() + 20
        states = []
        while time.monotonic() < deadline:
            states = [f["action"]["status"] for f in frames if f["type"] == "chatdgc_action"
                      and f["action"]["id"] == card["id"]]
            if "done" in states:
                break
            time.sleep(0.02)
        self.assertEqual(states[-1], "done", states)
        self.assertIn("running", states)
        reopened = self.card_now(chat["id"], reply["id"])
        self.assertEqual(reopened["status"], "done", "kept with the chat")
        self.assertTrue(reopened["video"]["path"].endswith(".mp4"))

    def test_a_running_card_left_by_a_reload_is_finished_by_the_next_dgc(self):
        chat, reply = self.say("Make a clip.", {"calls": [("generate_video", {"prompt": "waves"})]},
                               {"parts": ["A card."]})
        card = reply["actions"][0]
        with patch.object(videos.Jobs, "_track", lambda self, config, job: True):     # the window goes away
            sent = self.engine.act(chat["id"], reply["id"], card["id"], "run")
        self.assertEqual(self.card_now(chat["id"], reply["id"])["status"], "running")
        from dgc.chatdgc.service import ChatService
        frames = []
        with videos.fresh_jobs() as fresh:
            service = ChatService(lambda type, **f: frames.append({"type": type, **f}), self.config,
                                  engine=self.engine)
            self.addCleanup(service.close, 2.0)
            self.assertTrue(fresh.polling(sent["job"]), "the next DGC polls it again")
            fresh.wait(sent["job"], timeout=20)
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline and self.card_now(chat["id"], reply["id"])["status"] != "done":
                time.sleep(0.02)
        self.assertEqual(self.card_now(chat["id"], reply["id"])["status"], "done")

    def test_a_card_does_not_start_on_changed_aspect_or_estimate(self):
        chat, reply = self.say("Make a clip.", {"calls": [("generate_video", {"prompt": "waves", "duration_s": 5})]},
                               {"parts": ["A card."]})
        [card] = reply["actions"]
        changed = self.engine.act(chat["id"], reply["id"], card["id"], "run", arguments={"aspect": "9:16"})
        self.assertEqual(changed["status"], "failed")
        self.assertIn("review a new card", changed["error"])
        self.assertEqual(self.fake.requests, [])

        another, later = self.say("Make another.", {"calls": [("generate_video", {"prompt": "rain", "duration_s": 5})]},
                                  {"parts": ["A card."]}, chat=chat)
        [second] = later["actions"]
        with patch("dgc.videos.price", return_value=2.0):
            changed_price = self.engine.act(another["id"], later["id"], second["id"], "run")
        self.assertEqual(changed_price["status"], "failed")
        self.assertIn("review a new card", changed_price["error"])
        self.assertEqual(self.fake.requests, [])

    def test_stop_ends_the_card(self):
        self.fake.steps = 10_000
        chat, reply = self.say("Make a clip.", {"calls": [("generate_video", {"prompt": "slow"})]},
                               {"parts": ["A card."]})
        card = reply["actions"][0]
        sent = self.engine.act(chat["id"], reply["id"], card["id"], "run")
        stopped = self.jobs.stop(self.config, sent["job"])
        from dgc.chatdgc import videos as chat_videos
        chat_videos.apply(self.engine, stopped)
        now = self.card_now(chat["id"], reply["id"])
        self.assertEqual(now["status"], "cancelled")
        self.assertIn("Stopped the video", now["answer"])


if __name__ == "__main__":
    unittest.main()
