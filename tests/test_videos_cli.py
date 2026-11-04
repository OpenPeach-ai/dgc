"""`dgc videos` and `/videos` (0.51): list, add a video generator on the key pictures use, make (asks in a terminal,
--yes for a script, refused from the agent's own shell), jobs, show, stop and open, each with --json; and the
terminal's line for a finished video with its path and how to open it."""
from __future__ import annotations

import io
import json
import os
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_images_config import Home  # noqa: E402
from video_fakes import FakeVideos  # noqa: E402

from dgc import config as C  # noqa: E402
from dgc import videos, videos_cli  # noqa: E402


class VideosCli(unittest.TestCase):
    def setUp(self):
        self.fake = FakeVideos()
        self.addCleanup(self.fake.close)
        self.home = Home()
        self.home.__enter__()
        self.addCleanup(self.home.__exit__)
        self.project = self.home.root / "project"
        self.project.mkdir(exist_ok=True)
        (self.project / ".git").mkdir(exist_ok=True)
        for item in (patch.object(videos_cli, "_project_root", lambda: self.project),
                     patch.object(C, "find_project_root", lambda *a, **k: self.project),
                     patch.dict(os.environ, {"DGC_VIDEO_POLL_S": "0.02"})):
            item.start()
            self.addCleanup(item.stop)
        ctx = videos.fresh_jobs()
        ctx.__enter__()
        self.addCleanup(ctx.__exit__, None, None, None)
        os.environ.pop("DGC_AGENT_SHELL", None)
        config = C.Config(self.project)
        config.set_images({"generators": [{"id": "fal", "name": "fal FLUX", "provider": "fal",
                                           "base_url": self.fake.url, "model": "fal-ai/flux/schnell"}]})
        config.set_image_key("fal", "fal-key")

    def run_cli(self, *argv, stdin=""):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err), patch("sys.stdin", io.StringIO(stdin)), \
                patch.object(videos_cli.time, "sleep", lambda s: None):
            code = videos_cli.main(list(argv))
        return code, out.getvalue(), err.getvalue()

    def test_add_list_make_show_and_the_library(self):
        code, out, _ = self.run_cli("add", "fal", self.fake.url, "--json")
        self.assertEqual(code, 0, out)
        added = json.loads(out)["generator"]
        self.assertEqual((added["id"], added["makes"]), ("fal-wan-2-2-5b", "videos"))
        code, out, _ = self.run_cli("list")
        self.assertIn("about $0.03/s ($0.15 a 5 s clip at 720p)", out)
        self.assertNotIn("no key yet", out, "the fal picture generator's key is its key too")
        code, _out, err = self.run_cli("make", "a felt ball")
        self.assertEqual(code, 1)
        self.assertIn("costs money: run it with --yes", err)
        self.assertFalse([r for r in self.fake.requests if r["method"] == "POST"], "nothing sent")
        code, out, err = self.run_cli("make", "a felt ball", "--yes", "--duration", "5")
        self.assertEqual(code, 0, out + err)
        self.assertIn("Made a 5 s video with fal Wan 2.2 5B · 720p · $0.15", out)
        self.assertIn("Open: dgc videos open vid_", out)
        import re
        job_id = re.search(r"vid_[0-9a-f]{12}", out).group(0)
        self.assertIn(f"Started a 5 s video with fal Wan 2.2 5B (720p, about $0.15), about 1–2 min · {job_id}", out)
        code, out, _ = self.run_cli("show", job_id, "--json")
        self.assertEqual(json.loads(out)["state"], "done")
        code, out, _ = self.run_cli("library", "--json")
        self.assertEqual(json.loads(out)["total"], 1)
        with patch.object(videos_cli, "open_file", lambda path: False):
            code, out, _ = self.run_cli("open", job_id)
        self.assertTrue(out.strip().endswith(".mp4"), "no player here: its path")

    def test_stop_and_jobs(self):
        self.run_cli("add", "fal", self.fake.url)
        self.fake.steps = 10_000
        code, out, _ = self.run_cli("make", "slow", "--yes", "--no-wait", "--json")
        job_id = json.loads(out)["id"]
        code, out, _ = self.run_cli("stop", job_id)
        self.assertIn("Stopped the video with fal Wan 2.2 5B", out)
        code, out, _ = self.run_cli("jobs")
        self.assertIn(job_id, out)

    def test_the_agents_own_shell_cannot_spend(self):
        with patch.dict(os.environ, {"DGC_AGENT_SHELL": "1"}):
            code, _out, err = self.run_cli("make", "x", "--yes")
        self.assertEqual(code, 2)
        self.assertIn("your decision", err)

    def test_the_terminals_card_says_the_length_resolution_price_and_spend(self):
        from dgc.tui import _arg_summary
        from dgc.ui import arg_summary
        card = {"video": True, "generator": "fal Wan 2.2", "label": "fal Wan 2.2 5B", "price": "about $0.15",
                "facts": "5 s · 720p · about $0.15", "this_month": "$0.20 of your $5.00 limit", "prompt": "a felt ball"}
        self.assertEqual(arg_summary("generate_video", card),
                         "fal Wan 2.2 5B · 5 s · 720p · about $0.15 · this month $0.20 of your $5.00 limit")
        self.assertEqual(_arg_summary(card, "generate_video"),
                         "fal Wan 2.2 5B · 5 s · 720p · about $0.15 · this month $0.20 of your $5.00 limit")

    def test_slash_videos(self):
        self.run_cli("add", "fal", self.fake.url)
        body, _ = videos_cli.slash(C.Config(self.project), "", project_root=self.project)
        self.assertIn("Video generators (1)", body)
        body, _ = videos_cli.slash(C.Config(self.project), "jobs", project_root=self.project)
        self.assertIn("No video jobs yet", body)
        _, line = videos_cli.slash(C.Config(self.project), "stop vid_000000000000", project_root=self.project)
        self.assertIn("there is no video job", line)


if __name__ == "__main__":
    unittest.main()
