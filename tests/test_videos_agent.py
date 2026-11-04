"""Video generation in Work (0.51): the tools are offered every turn, every video shows its Allow card first (auto mode
too) with no Always on it, Don't sends nothing, Edit comes back to the model as the user's new prompt, Make it starts
the job and returns at once, and the chat is woken with the result when the video is ready (once), including after a
reload left the job on disk."""
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

from test_subagents import Harness  # noqa: E402
from video_fakes import FakeVideos  # noqa: E402

from dgc import videos  # noqa: E402
from dgc.llm import ToolCall  # noqa: E402

WAN = "fal-ai/wan/v2.2-5b/text-to-video"


class AgentCase(unittest.TestCase):
    def setUp(self):
        self.fake = FakeVideos()
        self.addCleanup(self.fake.close)
        self.state = Path(tempfile.mkdtemp(prefix="dgc-videos-agent-"))
        env = patch.dict(os.environ, {"DGC_HOME": str(self.state), "DGC_VIDEO_POLL_S": "0.02"})
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop("DGC_SESSION_POLICY", None)
        ctx = videos.fresh_jobs()
        self.jobs = ctx.__enter__()
        self.addCleanup(ctx.__exit__, None, None, None)

    def harness(self, set_up=True, **data):
        directory = tempfile.TemporaryDirectory(prefix="dgc-videos-agent-project-")
        self.addCleanup(directory.cleanup)
        harness = Harness(Path(directory.name), **data)
        self.addCleanup(harness.close)
        if set_up:
            harness.config.set_images({"generators": [
                {"id": "fal", "name": "fal FLUX schnell", "provider": "fal", "base_url": self.fake.url,
                 "model": "fal-ai/flux/schnell"},
                {"id": "fal-wan", "name": "fal Wan 2.2", "provider": "fal", "base_url": self.fake.url, "model": WAN,
                 "makes": "videos"}]}, persist=False)
            harness.config.set_image_key("fal", "fal-key", persist=False)
        harness.agent.session_file = Path(directory.name) / "s-video.json"
        return harness

    def names(self, agent):
        return {tool["function"]["name"] for tool in agent._tool_schemas()}

    def frames(self, harness, kind):
        return [f for f in harness.stream.frames() if f["type"] == kind]


class Offered(AgentCase):
    def test_every_turn_set_up_or_not(self):
        harness = self.harness(set_up=False)
        self.assertTrue({"generate_video", "list_video_generators"} <= self.names(harness.agent))
        harness.agent._activate_tool_intents("fix the typo in README", replace=True)
        self.assertTrue({"generate_video", "list_video_generators"} <= self.names(harness.agent))

    def test_plan_mode_can_read_them_but_not_make_one(self):
        harness = self.harness(mode="plan")
        names = self.names(harness.agent)
        self.assertIn("list_video_generators", names)
        self.assertNotIn("generate_video", names)

    def test_not_to_a_sub_agent(self):
        harness = self.harness()
        harness.agent.depth = 1
        self.assertFalse({"generate_video", "list_video_generators"} & self.names(harness.agent))

    def test_the_description_says_it_is_expensive_and_slow_and_one_at_a_time(self):
        from dgc.video_tools import GENERATE_SCHEMA
        words = GENERATE_SCHEMA["function"]["description"]
        self.assertIn("EXPENSIVE and SLOW", words)
        self.assertIn("make ONE at a time unless the user asked for more", words)


class Card(AgentCase):
    def test_every_video_asks_in_auto_mode_with_its_price_and_no_always(self):
        harness = self.harness()
        self.assertEqual(harness.config.get("mode"), "auto")
        harness.answer("permission_request", {"decision": "no"})
        out = harness.agent._handle_call(ToolCall("v1", "generate_video", {"prompt": "a felt ball", "duration_s": 5}))
        self.assertIn("DENIED", out)
        card = self.frames(harness, "permission_request")[-1]
        self.assertEqual(card["name"], "generate_video")
        self.assertEqual(card["choices"], ["once", "deny"], "no Always on a video's card")
        self.assertEqual({k: card["args"][k] for k in ("generator", "label", "facts", "prompt", "video")},
                         {"generator": "fal Wan 2.2", "label": "fal Wan 2.2 5B", "facts": "5 s · 720p · about $0.15",
                          "prompt": "a felt ball", "video": True})
        self.assertEqual(self.fake.requests, [], "Don't sends nothing")

    def test_edit_comes_back_as_the_users_prompt(self):
        harness = self.harness()
        harness.answer("permission_request", {"decision": "no", "reason": "Changed the prompt to: a blue felt ball — "
                                              "make it with this prompt instead."})
        out = harness.agent._handle_call(ToolCall("v1", "generate_video", {"prompt": "a felt ball"}))
        self.assertIn("a blue felt ball", out)
        self.assertEqual(self.fake.requests, [])

    def test_an_always_from_an_older_editor_counts_as_once(self):
        harness = self.harness()
        harness.answer("permission_request", {"decision": "always"})
        harness.agent._handle_call(ToolCall("v1", "generate_video", {"prompt": "x"}))
        harness.answer("permission_request", {"decision": "no"})
        out = harness.agent._handle_call(ToolCall("v2", "generate_video", {"prompt": "y"}))
        self.assertIn("DENIED", out, "it asked again")
        self.assertEqual(len(self.frames(harness, "permission_request")), 2)
        self.assertTrue(harness.config.images_block()["generators"][1]["video_asks"], "nothing stops it asking")

    def test_the_settings_switch_makes_videos_without_a_card(self):
        harness = self.harness()
        block = harness.config.images_block()
        block["generators"][1]["video_asks"] = False
        harness.config.set_images(block, persist=False)
        out = harness.agent._handle_call(ToolCall("v1", "generate_video", {"prompt": "a koi pond"}))
        self.assertTrue(out.startswith("Started a 5 s video with fal Wan 2.2 5B"), out)
        self.assertEqual(self.frames(harness, "permission_request"), [])

    def test_a_monitor_turn_never_makes_one(self):
        harness = self.harness()
        harness.agent._monitor_turn = True
        out = harness.agent._handle_call(ToolCall("v1", "generate_video", {"prompt": "x"}))
        self.assertIn("PERMISSION NEEDED", out)
        self.assertEqual(self.fake.requests, [])


class Running(AgentCase):
    def test_make_it_starts_the_job_and_the_chat_is_woken_once_when_it_is_ready(self):
        harness = self.harness()
        harness.answer("permission_request", {"decision": "once"})
        started = time.monotonic()
        out = harness.agent._handle_call(ToolCall("v1", "generate_video", {"prompt": "a felt ball rolls"}))
        self.assertLess(time.monotonic() - started, 5, "the call comes back at once")
        self.assertTrue(out.startswith("Started a 5 s video with fal Wan 2.2 5B (720p, about $0.15), about 1–2 min"),
                        out)
        job_id = out.split("(job ")[1].split(")")[0]
        job = self.jobs.wait(job_id, timeout=20)
        self.assertEqual(job["state"], "done")
        self.assertEqual(job["target"], {"session": "s-video", "call_id": "v1"})
        deadline = time.monotonic() + 5
        while harness.agent.monitors.pending_count() == 0 and time.monotonic() < deadline:
            time.sleep(0.02)
        notice = harness.agent.monitors.take_pending()
        self.assertIsNotNone(notice, "the chat is woken")
        self.assertIn("the lines below say how a video job you started ended", notice.text)
        self.assertIn("Made a 5 s video with fal Wan 2.2 5B · 720p · $0.15", notice.text)
        self.assertIn("The user sees the player under the reply that asked for it", notice.text)
        deadline = time.monotonic() + 5
        while not videos.load(job_id).get("told") and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertTrue(videos.load(job_id)["told"], videos.load(job_id))
        self.assertFalse(harness.agent._tell_video(videos.load(job_id)), "told once")
        self.assertTrue(Path(job["result"]["path"]).is_relative_to(videos.session_folder("s-video")))

    def test_the_editor_hears_each_change_of_its_chats_job(self):
        harness = self.harness()
        harness.backend._videos_watch()
        harness.answer("permission_request", {"decision": "once"})
        out = harness.agent._handle_call(ToolCall("v1", "generate_video", {"prompt": "x"}))
        job_id = out.split("(job ")[1].split(")")[0]
        self.jobs.wait(job_id, timeout=20)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and not any(f["job"]["state"] == "done"
                                                       for f in self.frames(harness, "video_job")):
            time.sleep(0.02)
        states = [f["job"]["state"] for f in self.frames(harness, "video_job")]
        self.assertEqual(states[-1], "done")
        self.assertIn("queued", states)
        last = self.frames(harness, "video_job")[-1]["job"]
        self.assertEqual(last["call_id"], "v1")
        self.assertTrue(last["result"]["path"].endswith(".mp4"))
        self.assertNotIn("handle", last, "the provider's handle never goes to the screen")

    def test_after_a_reload_the_reopened_chat_is_told_and_its_job_polled_again(self):
        harness = self.harness()
        harness.answer("permission_request", {"decision": "once"})
        self.fake.steps = 4
        with patch.object(videos.Jobs, "_track", lambda self, config, job: True):
            out = harness.agent._handle_call(ToolCall("v1", "generate_video", {"prompt": "x"}))
        job_id = out.split("(job ")[1].split(")")[0]
        self.assertEqual(videos.load(job_id)["state"], "queued")
        # The window reloads: a new DGC, the same session opened again.
        later = self.harness()
        later.agent.session_file = harness.agent.session_file
        with videos.fresh_jobs() as fresh:
            later.agent._video_listener = None
            later.agent.tell_finished_videos()
            self.assertTrue(fresh.polling(job_id))
            fresh.wait(job_id, timeout=20)
            deadline = time.monotonic() + 5
            while later.agent.monitors.pending_count() == 0 and time.monotonic() < deadline:
                time.sleep(0.02)
            notice = later.agent.monitors.take_pending()
        self.assertIsNotNone(notice)
        self.assertIn("Made a 5 s video", notice.text)

    def test_a_reopened_chat_is_told_while_the_backend_a_reload_left_behind_still_polls_its_job(self):
        harness = self.harness()
        harness.answer("permission_request", {"decision": "once"})
        self.fake.steps = 8
        env = patch.dict(os.environ, {"DGC_VIDEO_WATCH_S": "0.02"})
        env.start()
        self.addCleanup(env.stop)
        out = harness.agent._handle_call(ToolCall("v1", "generate_video", {"prompt": "x"}))   # polled by self.jobs
        job_id = out.split("(job ")[1].split(")")[0]
        later = self.harness()                         # the window reloaded: a new backend opens the same chat
        later.agent.session_file = harness.agent.session_file
        harness.agent._video_listener and self.jobs.remove_listener(harness.agent._video_listener)   # the old one's
        with videos.fresh_jobs() as fresh:
            later.agent._video_listener = None
            later.agent.tell_finished_videos()
            self.assertFalse(fresh.polling(job_id), "the old backend still polls it")
            self.assertTrue(fresh.watching(job_id), "so the new one watches its record")
            self.jobs.wait(job_id, timeout=20)
            deadline = time.monotonic() + 10
            while later.agent.monitors.pending_count() == 0 and time.monotonic() < deadline:
                time.sleep(0.02)
            notice = later.agent.monitors.take_pending()
        self.assertIsNotNone(notice, "the reopened chat is told")
        self.assertIn("Made a 5 s video", notice.text)
        deadline = time.monotonic() + 5
        while not videos.load(job_id).get("told") and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertTrue(videos.load(job_id)["told"], videos.load(job_id))

    def test_list_video_generators_reads_without_a_card(self):
        harness = self.harness()
        out = harness.agent._handle_call(ToolCall("l1", "list_video_generators", {}))
        self.assertIn('fal-wan "fal Wan 2.2"', out)
        self.assertEqual(self.frames(harness, "permission_request"), [])


if __name__ == "__main__":
    unittest.main()
