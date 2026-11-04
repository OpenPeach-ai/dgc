"""`dgc images` and `/images` (0.51): list, add (a ComfyUI workflow's inputs found and confirmed), edit, remove,
test, default and generate, each with --json; a key only from the terminal or a pipe; and in the terminal a
generated image's path with a small picture of it."""
from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from image_fakes import FakeImages, png  # noqa: E402
from test_image_providers import ComfyUIWorkflows  # noqa: E402
from test_images_config import Home  # noqa: E402

from dgc import image_preview, images, images_cli  # noqa: E402
from dgc import config as C  # noqa: E402


class CliCase(unittest.TestCase):
    def setUp(self):
        self.fake = FakeImages()
        self.addCleanup(self.fake.close)
        self.home = Home()
        self.home.__enter__()
        self.addCleanup(self.home.__exit__)
        self.project = self.home.root / "project"
        self.project.mkdir(exist_ok=True)
        (self.project / ".git").mkdir(exist_ok=True)
        for item in (patch.object(images_cli, "_project_root", lambda: self.project),
                     patch.object(C, "find_project_root", lambda *a, **k: self.project)):
            item.start()
            self.addCleanup(item.stop)
        os.environ.pop("DGC_AGENT_SHELL", None)

    def run_cli(self, *argv, stdin=""):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err), patch("sys.stdin", io.StringIO(stdin)):
            code = images_cli.main(list(argv))
        return code, out.getvalue(), err.getvalue()


class Commands(CliCase):
    def test_add_comfyui_picks_its_checkpoint_and_tests_it(self):
        code, out, _err = self.run_cli("add", "comfyui", self.fake.url, "--name", "ComfyUI on gpu-box", "--json")
        self.assertEqual(code, 0)
        value = json.loads(out)
        self.assertEqual(value["generator"]["model"], "sd_xl_turbo_1.0_fp16.safetensors")
        self.assertEqual(value["generator"]["size"], "512x512", "a turbo checkpoint's own size")
        self.assertFalse(value["generator"]["asks"])
        self.assertTrue(value["check"]["ok"])
        code, out, _ = self.run_cli("list", "--json")
        listing = json.loads(out)
        self.assertEqual(listing["default"], "comfyui-on-gpu-box", "the first one is the default")
        self.assertEqual(listing["generators"][0]["price"], "free")

    def test_a_workflow_shows_its_inputs_and_is_added_only_once_confirmed(self):
        workflow = self.home.root / "wf.json"
        workflow.write_text(json.dumps(ComfyUIWorkflows.SDXL))
        code, out, _ = self.run_cli("add", "comfyui", self.fake.url, "--workflow", str(workflow), "--json")
        self.assertEqual(code, 3, "not added: it waits to be confirmed")
        value = json.loads(out)
        self.assertTrue(value["pending"])
        self.assertIn("Prompt → node 6 (CLIPTextEncode).text", value["mapping_lines"])
        self.assertEqual(images.settings(C.Config(self.project))["generators"], [])
        code, out, _ = self.run_cli("add", "comfyui", self.fake.url, "--workflow", str(workflow), "--yes", "--json")
        self.assertEqual(code, 0)
        generator = json.loads(out)["generator"]
        self.assertEqual(generator["mapping"]["prompt"], "6.text")
        self.assertTrue(images.workflow_path(generator["workflow"]).exists())

    def test_a_key_comes_from_a_pipe_never_the_command_line(self):
        code, out, _ = self.run_cli("add", "fal", "--key", "--json", stdin="fal-from-pipe\n")
        self.assertEqual(code, 0)
        self.assertNotIn("fal-from-pipe", out)
        config = C.Config(self.project)
        self.assertEqual(config.image_key("fal"), "fal-from-pipe")
        self.assertNotIn("fal-from-pipe", (self.home.home / "config.json").read_text())
        code, _out, _ = self.run_cli("edit", "fal", "--remove-key")
        self.assertEqual(C.Config(self.project).image_key("fal"), "")

    def test_edit_remove_default_and_the_projects_choice(self):
        self.run_cli("add", "comfyui", self.fake.url, "--id", "comfy")
        self.run_cli("add", "fal", "--id", "fal")
        code, out, _ = self.run_cli("edit", "fal", "--no-asks", "--limit", "5", "--good-for", "quick drafts")
        self.assertEqual(code, 0, out)
        fal = images.find(images.settings(C.Config(self.project)), "fal")
        self.assertEqual((fal["asks"], fal["monthly_limit_usd"], fal["good_for"]), (False, 5.0, "quick drafts"))
        self.run_cli("default", "fal")
        self.assertEqual(images.settings(C.Config(self.project))["default"], "fal")
        self.run_cli("default", "comfy", "--project")
        self.assertEqual(images.project_choice(self.project), "comfy")
        code, out, _ = self.run_cli("default", "--json")
        self.assertEqual(json.loads(out), {"default": "fal", "project_choice": "comfy"})
        self.run_cli("remove", "fal")
        self.assertEqual(images.settings(C.Config(self.project))["default"], "comfy")

    def test_generate_saves_in_dgcs_own_folder_and_out_puts_it_in_the_project(self):
        self.run_cli("add", "comfyui", self.fake.url)
        code, out, _ = self.run_cli("generate", "a red fox", "--json")
        self.assertEqual(code, 0)
        value = json.loads(out)
        self.assertTrue(value["text"].startswith("Made 1 image"))
        self.assertTrue(Path(value["images"][0]["path"]).is_file())
        self.assertTrue(value["images"][0]["path"].startswith(str(images.directory() / "sessions" / "cli")), value)
        code, out, _ = self.run_cli("generate", "a red fox", "--out", "art", "--json")
        self.assertTrue(json.loads(out)["images"][0]["path"].startswith(str(self.project / "art")))

    def test_a_paid_generator_from_a_pipe_needs_yes(self):
        self.run_cli("add", "fal", "--key", stdin="k\n")
        block = images.settings(C.Config(self.project))
        block["generators"][0]["base_url"] = self.fake.url
        config = C.Config(self.project)
        config.set_images(block)
        config.set_image_key("fal", "k")
        code, _out, err = self.run_cli("generate", "x")
        self.assertEqual((code, err.strip()), (1, "Not made."))
        code, out, _ = self.run_cli("generate", "x", "--yes", "--json")
        self.assertEqual(code, 0, out)

    def test_the_agents_own_shell_cannot_change_or_spend(self):
        with patch.dict(os.environ, {"DGC_AGENT_SHELL": "1"}):
            for argv in (("add", "fal"), ("edit", "x", "--key"), ("generate", "x"), ("default", "x")):
                code, _out, err = self.run_cli(*argv)
                self.assertEqual(code, 2, argv)
                self.assertIn("your decision", err)
            self.assertEqual(self.run_cli("list")[0], 0, "reading is fine")

    def test_test_says_what_each_answered(self):
        self.run_cli("add", "comfyui", self.fake.url, "--id", "comfy")
        self.run_cli("add", "fal", "--id", "fal")
        code, out, _ = self.run_cli("test")
        self.assertEqual(code, 1, "fal has no key")
        self.assertIn("comfy: works", out)
        self.assertIn("fal: bad key: no key yet", out)


class Slash(CliCase):
    def test_images_list_add_test_default_and_use(self):
        config = C.Config(self.project)
        body, line = images_cli.slash(config, "", project_root=self.project)
        self.assertIn("No image generator is set up", body)
        body, line = images_cli.slash(config, f"add comfyui {self.fake.url} ComfyUI here", project_root=self.project)
        self.assertIn("**Added ComfyUI here", body)
        self.assertIn("Test: works", body)
        body, _ = images_cli.slash(config, "test", project_root=self.project)
        self.assertIn("comfyui-here: works", body)
        _body, line = images_cli.slash(config, "use comfyui-here", project_root=self.project)
        self.assertEqual(line, "This project uses ComfyUI here")
        _body, line = images_cli.slash(config, "bogus", project_root=self.project)
        self.assertTrue(line.startswith("usage: /images"))

    def test_images_key_asks_without_echo(self):
        config = C.Config(self.project)
        images_cli.slash(config, "add fal", project_root=self.project)
        asked = []
        images_cli.slash(config, "key fal", ask_key=lambda gid, done: (asked.append(gid), done("secret-1")),
                         project_root=self.project)
        self.assertEqual(asked, ["fal"])
        self.assertEqual(config.image_key("fal"), "secret-1")


class Preview(unittest.TestCase):
    def test_a_png_is_drawn_as_half_blocks(self):
        rows = image_preview.cells(png(32, 32, (10, 200, 30)), 8)
        self.assertEqual((len(rows), len(rows[0])), (4, 8))
        self.assertEqual(rows[0][0], ("#0ac81e", "#0ac81e"))
        self.assertIn("\x1b[38;2;10;200;30m", image_preview.ansi(rows))

    def test_what_it_cant_read_is_none(self):
        with patch.object(image_preview, "_pillow", lambda data: None):
            self.assertIsNone(image_preview.cells(b"\xff\xd8\xff" + b"\x00" * 64))

    def test_the_tui_row_reads_a_plain_line_not_the_models(self):
        from test_image_views_tui import bare_tui
        root = Path(tempfile.mkdtemp(prefix="dgc-images-tui-"))
        tui = bare_tui(root)
        tui._invalidate = lambda: None
        made = ("Made 1 image with ComfyUI on gpu-box (ComfyUI, sd_xl_turbo, free) in 2.1 s: assets/generated/fox.png "
                "(768×320; seed 4). A sidecar .json with the prompt, provider, model, seed and cost is beside each "
                "file. The user sees it in the chat.")
        card = ("the time is 10:42\n[DGC showed example's card for get-time in the chat. The user sees and can use "
                "it; its page is not part of this result.]")
        tui.tool_call("generate_image", {"prompt": "fox"}, "g1")
        tui.tool_result("generate_image", made, "g1")
        tui.tool_call("mcp__example__get-time", {}, "c1")
        tui.tool_result("mcp__example__get-time", card, "c1")
        rows = [block["out"] for block in tui.blocks if block.get("kind") == "tool"]
        self.assertEqual(rows, ["Made 1 image with ComfyUI on gpu-box · 768×320 · free\nassets/generated/fox.png",
                                "the time is 10:42\nOpened example's card"])

    def test_the_tui_shows_the_saved_path_and_a_picture(self):
        from test_image_views_tui import bare_tui, text_of
        root = Path(tempfile.mkdtemp(prefix="dgc-images-tui-"))
        tui = bare_tui(root)
        tui._invalidate = lambda: None
        tui.tool_call("generate_image", {"prompt": "fox"}, "g1")
        tui.tool_result("generate_image", "Made 1 image", "g1")
        path = root / "assets" / "generated" / "fox.png"
        path.parent.mkdir(parents=True)
        path.write_bytes(png(16, 16, (200, 30, 30)))
        with patch.dict(os.environ, {"TERM": "xterm-256color", "NO_COLOR": ""}):
            tui.tool_images("g1", ["data:image/png;base64,AAAA"], "generated image",
                            meta=[{"name": "fox.png", "path": str(path), "source_path": str(path), "width": 16,
                                   "height": 16, "source": "view_image"}])
            block = tui.blocks[0]
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline and not block["previews"][0]["rows"]:
                time.sleep(0.02)
            text = text_of(tui._tool_frags(block))
        self.assertIn("▣ assets/generated/fox.png  (16×16)", text)
        self.assertIn("▀", text)
        styled = [part for part in tui._tool_frags(block) if part[1] == "▀"]
        self.assertEqual(styled[0][0], "fg:#c81e1e bg:#c81e1e")


if __name__ == "__main__":
    unittest.main()
