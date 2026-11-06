"""Where a picture DGC makes is saved (reported 2026-11-02: a picture and its sidecar went into a company repository's
assets/generated/). DGC keeps generated pictures in its own home folder, one folder per session:
~/.dgc/images/sessions/<session>/ and puts one in the project only when the call names a place there (save_to), with
write_file's checks: inside the project, never .git or .dgc, no replacing a file without asking, and in Work the same
permission a write of that path gets. The Images setting's save folder still overrides the default for anyone who
chooses one."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_image_tools import ToolsCase  # noqa: E402
from test_images_agent import AgentCase  # noqa: E402

from dgc import image_tools as T  # noqa: E402
from dgc import images, images_admin  # noqa: E402
from dgc import config as C  # noqa: E402
from dgc.llm import ToolCall  # noqa: E402


class SavedWhere(ToolsCase):
    def work(self, **extra):
        return self.surface(home=images.session_folder("20261102-144709-0de64877"), **extra)

    def test_by_default_in_dgcs_own_folder_one_per_session_and_the_model_is_told(self):
        self.setup("comfy")
        out = T.execute(self.config, T.prepare(self.config, {"prompt": "a felt purple ball"}, self.work()), self.work())
        [item] = out.result.saved
        self.assertEqual(item.path.parent, images.directory() / "sessions" / "20261102-144709-0de64877")
        self.assertTrue(item.sidecar.exists(), "its sidecar beside it")
        self.assertEqual(item.rel, "", "not in the project")
        self.assertEqual(list(self.root.rglob("*.png")), [], "nothing written into the project")
        self.assertIn("That's DGC's own folder, not the project. If the user wants it in the project, call "
                      "generate_image again with save_to (a path in the project), or copy the file there.", out.text)
        self.assertEqual(images.library()["images"][0]["path"], str(item.path), "still in the Library")
        self.assertNotIn("DGC's own folder", T.shown_text(out.text), "the person's row stays short")

    def test_save_to_puts_it_in_the_project_and_says_so_on_the_card(self):
        self.setup("comfy")
        plan = T.prepare(self.config, {"prompt": "hero", "save_to": "site/assets/hero.png"}, self.work())
        self.assertTrue(plan.into_project)
        self.assertEqual(plan.card()["saves_to"], "site/assets/hero.png")
        out = T.execute(self.config, plan, self.work())
        self.assertEqual(out.result.saved[0].rel, "site/assets/hero.png")
        self.assertNotIn("DGC's own folder", out.text)
        folder = T.prepare(self.config, {"prompt": "hero", "save_to": "site/img"}, self.work())
        self.assertEqual(folder.card()["saves_to"], "site/img/")

    def test_never_replaces_a_file_without_asking_and_never_into_git_or_dgc(self):
        self.setup("comfy")
        (self.root / "art").mkdir()
        (self.root / "art" / "logo.png").write_bytes(b"theirs")
        with self.assertRaisesRegex(T.Refused, "art/logo.png already exists, and DGC doesn't replace a file without asking"):
            T.prepare(self.config, {"prompt": "logo", "save_to": "art/logo.png"}, self.work())
        plan = T.prepare(self.config, {"prompt": "logo", "save_to": "art/logo.png", "replace": True}, self.work())
        self.assertTrue(plan.card()["replaces"])
        out = T.execute(self.config, plan, self.work())
        self.assertEqual(out.result.saved[0].rel, "art/logo.png", "the very file, as the user said")
        self.assertEqual((self.root / "art" / "logo.png").read_bytes(), self.fake.picture)
        for bad in (".git/hooks/x.png", ".dgc/logo.png", "../outside.png", "/etc/x.png"):
            with self.subTest(save_to=bad), self.assertRaises(T.Refused):
                T.prepare(self.config, {"prompt": "x", "save_to": bad}, self.work())
        with self.assertRaisesRegex(T.Refused, "replace is true or false"):
            T.prepare(self.config, {"prompt": "x", "replace": "yes"}, self.work())

    def test_the_images_save_folder_still_overrides_for_anyone_who_chooses_one(self):
        self.setup("comfy")
        images_admin.set_option(self.config, "save_dir", "assets/img")
        plan = T.prepare(self.config, {"prompt": "x"}, self.work())
        self.assertEqual((plan.folder, plan.into_project), (self.root / "assets" / "img", True))
        self.assertEqual(images_admin.save_place(self.config), "Images are saved in assets/img/ in the project")
        images_admin.set_option(self.config, "save_dir", "")
        self.assertFalse(T.prepare(self.config, {"prompt": "x"}, self.work()).into_project)
        self.assertIn("DGC's own folder", images_admin.save_place(self.config))
        # Chosen, even the folder the first builds used by default.
        images_admin.set_option(self.config, "save_dir", "assets/generated")
        self.assertTrue(T.prepare(self.config, {"prompt": "x"}, self.work()).into_project)

    def test_the_first_builds_default_written_into_every_block_reads_as_dgcs_own_folder(self):
        block, problems = C.validate_images({"save_dir": "assets/generated", "generators": []})
        self.assertEqual((problems, block["save_dir"]), ([], ""))
        block, problems = C.validate_images({"save_dir": "assets/generated", "save_dir_set": True, "generators": []})
        self.assertEqual((problems, block["save_dir"], block["save_dir_set"]), ([], "assets/generated", True))
        block, _ = C.validate_images({"save_dir": "art", "generators": []})
        self.assertEqual(block["save_dir"], "art", "any other folder was someone's choice")

    def test_a_picture_in_dgcs_folder_can_be_edited_from_there(self):
        self.setup("comfy")
        made = T.execute(self.config, T.prepare(self.config, {"prompt": "a ball"}, self.work()), self.work())
        own = made.result.saved[0].path
        plan = T.prepare(self.config, {"prompt": "make it red", "images": [str(own)]}, self.work())
        self.assertEqual(plan.request.images[0].name, own.name)
        elsewhere = Path(self.home.home) / "secret.png" if hasattr(self.home, "home") else self.root.parent / "secret.png"
        elsewhere.write_bytes(self.fake.picture)
        with self.assertRaises(T.Refused):
            T.prepare(self.config, {"prompt": "x", "images": [str(elsewhere)]}, self.work())


class InWork(AgentCase):
    def test_save_to_gets_write_files_checks_on_one_card(self):
        harness = self.harness("comfy", mode="default")
        harness.answer("permission_request", {"decision": "no"})
        out = harness.agent._handle_call(ToolCall("g1", "generate_image", {"prompt": "hero", "save_to": "web/hero.png"}))
        self.assertIn("DENIED", out)
        [card] = self.frames(harness, "permission_request")
        self.assertEqual(card["args"]["saves_to"], "web/hero.png", "the card says where it's written")
        self.assertFalse((Path(harness.config.project_root) / "web" / "hero.png").exists())
        # Without save_to nothing in the project changes: a free generator needs no card.
        out = harness.agent._handle_call(ToolCall("g2", "generate_image", {"prompt": "hero"}))
        self.assertTrue(out.startswith("Made 1 image"), out)
        self.assertEqual(len(self.frames(harness, "permission_request")), 1)

    def test_in_auto_mode_save_to_goes_ahead_and_a_deny_rule_still_wins(self):
        harness = self.harness("comfy", mode="auto")
        out = harness.agent._handle_call(ToolCall("g1", "generate_image", {"prompt": "hero", "save_to": "web/hero.png"}))
        self.assertTrue(out.startswith("Made 1 image"), out)
        self.assertTrue((Path(harness.config.project_root) / "web" / "hero.png").exists())
        from dgc.permissions import rule_for
        harness.config.permissions["deny"] = [rule_for("write_file", {"path": "secret/**"})]
        out = harness.agent._handle_call(ToolCall("g2", "generate_image", {"prompt": "x", "save_to": "secret/x.png"}))
        self.assertIn("DENIED", out)
        self.assertFalse((Path(harness.config.project_root) / "secret").exists())


class TheModelReadsItWhole(AgentCase):
    """generate_image's result was seen cut at "The user sees it in the …" in a session file: the whole of it reaches
    the model's next request, and the session file keeps it whole."""

    def test_the_whole_result_reaches_the_model_and_the_session_file(self):
        import json
        from dgc import sessions
        from dgc.llm import ChatResult
        harness = self.harness("comfy")
        read = []

        def route(messages, results, cancel):
            if not results:
                return ChatResult(tool_calls=[ToolCall("g1", "generate_image", {"prompt": "a felt purple ball with a ribbon"})])
            read.append(results[-1]["content"])
            return ChatResult(content="Here it is.")
        harness.run("Make a 512x512 picture of a felt purple ball", [("felt purple ball", route)])
        [told] = read
        self.assertIn(" The user sees it in the chat. That's DGC's own folder, not the project. If the user wants it in "
                      "the project, call generate_image again with save_to (a path in the project), or copy the file "
                      "there.", told)
        self.assertTrue(told.endswith("or copy the file there."), told[-80:])
        path = sessions.project_dir(harness.config.project_root) / "whole.json"
        sessions.save(path, harness.agent.messages, harness.config.project_root)
        kept = [m["content"] for m in json.loads(path.read_text())["messages"] if m.get("role") == "tool"]
        self.assertEqual(kept, [told], "kept as the model read it")


if __name__ == "__main__":
    unittest.main()
