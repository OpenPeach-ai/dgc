"""Image generators in config (0.51): the `images` block, its validation, and each generator's key in secrets.json,
bound to its address like the Router's. Never set up, config.json is written as 0.50 wrote it."""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dgc import config as C  # noqa: E402
from dgc import images  # noqa: E402


class Home:
    def __init__(self):
        self.root = Path(tempfile.mkdtemp(prefix="dgc-images-config-"))
        self.home = self.root / ".dgc"
        self.home.mkdir()
        self._patches = [patch.object(C, "USER_HOME", self.home),
                         patch.object(C, "USER_CONFIG", self.home / "config.json"),
                         patch.object(C, "USER_SECRETS", self.home / "secrets.json"),
                         patch.dict(os.environ, {"DGC_HOME": str(self.root)})]

    def __enter__(self):
        for item in self._patches:
            item.start()
        return self

    def __exit__(self, *exc):
        for item in reversed(self._patches):
            item.stop()

    def config(self):
        project = self.root / "project"
        project.mkdir(exist_ok=True)
        (project / ".git").mkdir(exist_ok=True)
        return C.Config(project)

    def disk(self, name="config.json") -> dict:
        path = self.home / name
        return json.loads(path.read_text()) if path.exists() else {}


class Validation(unittest.TestCase):
    def test_never_set_up_is_empty_and_absent_from_config(self):
        block, problems = C.validate_images(None)
        self.assertEqual(problems, [])
        self.assertEqual(block, {"default": "", "auto_fallback": False, "save_dir": "",
                                 "generators": []}, "pictures go to DGC's own folder")
        with Home() as home:
            config = home.config()
            config.set("model", "qwen3:8b")
            self.assertNotIn("images", home.disk(), "nothing new in config.json until a generator is added")

    def test_defaults_per_provider_paid_asks_local_does_not(self):
        block, problems = C.validate_images({"generators": [
            {"provider": "fal", "model": "fal-ai/flux/schnell"},
            {"provider": "comfyui", "name": "ComfyUI on gpu-box", "base_url": "gpu-box.local:8188",
             "model": "sd_xl_turbo_1.0_fp16.safetensors", "size": "512x512"}]})
        self.assertEqual(problems, [])
        fal, comfy = block["generators"]
        self.assertEqual((fal["id"], fal["base_url"], fal["asks"], fal["enabled"]), ("fal", "https://fal.run", True, True))
        self.assertEqual((comfy["id"], comfy["base_url"], comfy["asks"], comfy["size"]),
                         ("comfyui-on-gpu-box", "http://gpu-box.local:8188", False, "512x512"))

    def test_a_public_openai_compatible_server_asks_by_default_a_local_one_does_not(self):
        # A hosted OpenAI-compatible service charges (images.is_paid counts it paid): it starts asking, as fal does.
        block, problems = C.validate_images({"generators": [
            {"provider": "openai_compatible", "id": "hosted", "base_url": "https://images.example.com"},
            {"provider": "openai_compatible", "id": "lan", "base_url": "http://gpu-box.local:8080"},
            {"provider": "openai_compatible", "id": "here", "base_url": "http://127.0.0.1:8080"},
            {"provider": "openai_compatible", "id": "chosen", "base_url": "https://images.example.com",
             "asks": False}]})
        self.assertEqual(problems, [])
        rows = {g["id"]: g for g in block["generators"]}
        self.assertTrue(rows["hosted"]["asks"])
        self.assertTrue(images.is_paid(rows["hosted"]))
        self.assertEqual((rows["lan"]["asks"], rows["here"]["asks"]), (False, False), "free on the user's network")
        self.assertFalse(rows["chosen"]["asks"], "the user's own choice stands")

    def test_moving_a_local_server_to_a_public_address_makes_it_ask(self):
        from dgc import images_admin
        with Home() as home:
            config = home.config()
            config.set_images({"generators": [{"provider": "openai_compatible", "id": "compat",
                                               "base_url": "http://gpu-box.local:8080"}]})
            self.assertFalse(images.settings(config)["generators"][0]["asks"])
            images_admin.edit(config, "compat", {"base_url": "images.example.com"})
            self.assertTrue(images.settings(config)["generators"][0]["asks"], "a paid address asks again")
            images_admin.edit(config, "compat", {"base_url": "http://gpu-box.local:8080"})
            images_admin.edit(config, "compat", {"base_url": "https://images.example.com", "asks": False})
            self.assertFalse(images.settings(config)["generators"][0]["asks"], "unless the same change says not to")

    def test_problems_are_named_and_a_key_never_sits_in_the_block(self):
        cases = [
            ({"generators": [{"provider": "midjourney"}]}, "provider"),
            ({"generators": [{"provider": "fal", "api_key": "fal-1"}]}, "key is never kept"),
            ({"generators": [{"provider": "openai_compatible"}]}, "needs its address"),
            ({"generators": [{"provider": "fal", "size": "huge"}]}, "size"),
            ({"generators": [{"provider": "fal", "workflow": "x.json"}]}, "workflow is for a ComfyUI"),
            ({"generators": [{"provider": "comfyui", "mapping": {"seed": "3.seed"}}]}, "where the prompt goes"),
            ({"generators": [{"provider": "fal", "monthly_limit_usd": -1}]}, "monthly_limit_usd"),
            ({"generators": [{"provider": "fal"}, {"provider": "fal"}]}, "two generators"),
            ({"default": "nope", "generators": [{"provider": "fal"}]}, "default"),
            ({"save_dir": "../outside"}, "save_dir"),
            ({"save_dir": "/etc"}, "save_dir"),
            ({"surprise": 1}, "unknown setting"),
        ]
        for value, word in cases:
            with self.subTest(word=word):
                _block, problems = C.validate_images(value)
                self.assertTrue(any(word in problem for problem in problems), problems)

    def test_set_images_refuses_a_block_with_problems(self):
        with Home() as home:
            config = home.config()
            with self.assertRaises(ValueError):
                config.set_images({"generators": [{"provider": "fal", "key": "x"}]})
            saved = config.set_images({"default": "fal", "generators": [{"provider": "fal"}]})
            self.assertEqual(home.disk()["images"], saved)


class Keys(unittest.TestCase):
    def test_a_key_lives_in_secrets_bound_to_its_address(self):
        with Home() as home:
            config = home.config()
            config.set_images({"generators": [{"provider": "fal", "id": "fal"},
                                              {"provider": "comfyui", "id": "comfy", "base_url": "gpu-box.local:8188"}]})
            config.set_image_key("fal", "fal-secret-123")
            self.assertNotIn("fal-secret-123", (home.home / "config.json").read_text())
            secrets = home.disk("secrets.json")
            self.assertEqual(secrets["image_key_fal"], "fal-secret-123")
            self.assertIn("fal", secrets["image_identity"])
            again = C.Config(config.project_root)
            self.assertEqual(again.image_key("fal"), "fal-secret-123")
            self.assertEqual(again.image_key_ids(), ["fal"])
            # The address changes: the key is not sent there, and is dropped from disk.
            block = again.images_block()
            block["generators"][0]["base_url"] = "https://fal.example.com"
            again.set_images(block)
            self.assertEqual(again.image_key("fal"), "")
            third = C.Config(config.project_root)
            self.assertEqual(third.image_key("fal"), "")
            self.assertNotIn("image_key_fal", home.disk("secrets.json"))

    def test_router_and_image_keys_stay_apart(self):
        with Home() as home:
            config = home.config()
            config.set_router({"systems": [{"id": "nas", "base_url": "nas.local"}]})
            config.set_router_key("nas", "router-k")
            config.set_images({"generators": [{"provider": "bfl", "id": "bfl"}]})
            config.set_image_key("bfl", "bfl-k")
            again = C.Config(config.project_root)
            self.assertEqual((again.router_key("nas"), again.image_key("bfl")), ("router-k", "bfl-k"))
            again.set_image_key("bfl", "")
            third = C.Config(config.project_root)
            self.assertEqual((third.router_key("nas"), third.image_key("bfl")), ("router-k", ""))

    def test_a_key_written_into_config_json_by_hand_moves_to_secrets(self):
        with Home() as home:
            (home.home / "config.json").write_text(json.dumps({
                "images": {"generators": [{"provider": "fal", "id": "fal"}]}, "image_key_fal": "hand-key"}))
            config = home.config()
            self.assertEqual(config.image_key("fal"), "hand-key")
            self.assertNotIn("image_key_fal", home.disk())
            self.assertEqual(home.disk("secrets.json")["image_key_fal"], "hand-key")

    def test_an_environment_key_is_used_only_for_the_providers_own_address(self):
        with Home() as home:
            config = home.config()
            config.set_images({"generators": [{"provider": "fal", "id": "fal"},
                                              {"provider": "fal", "id": "proxy", "base_url": "https://fal.example.com"}]})
            block = images.settings(config)
            with patch.dict(os.environ, {"FAL_KEY": "env-key"}):
                self.assertEqual(images.key_for(config, block["generators"][0]), "env-key")
                self.assertEqual(images.key_source(config, block["generators"][0]), "env:FAL_KEY")
                self.assertEqual(images.key_for(config, block["generators"][1]), "", "never to another address")

    def test_keys_are_redacted(self):
        from dgc.redaction import secret_values
        with Home() as home:
            config = home.config()
            config.set_images({"generators": [{"provider": "fal", "id": "fal"}]})
            config.set_image_key("fal", "fal-redact-me-123456")
            with patch.dict(os.environ, {"GEMINI_API_KEY": "gem-env-redact-123456"}):
                values = secret_values(config)
            self.assertIn("fal-redact-me-123456", values)
            self.assertIn("gem-env-redact-123456", values)


class LongRunning(unittest.TestCase):
    """A process that started earlier (the Pips supervisor, `dgc serve`) sees what another DGC changed since: a
    generator told to ask again asks, and a key saved or removed elsewhere counts."""

    def test_asks_and_keys_changed_elsewhere_count_at_once(self):
        with Home() as home:
            config = home.config()
            config.set_images({"generators": [{"provider": "fal", "id": "fal", "asks": False}]})
            running = C.Config(config.project_root)                 # started now, runs for hours
            other = C.Config(config.project_root)                   # `dgc images edit fal --asks`, later
            block = other.images_block()
            block["generators"][0]["asks"] = True
            other.set_images(block)
            self.assertTrue(running.images_block()["generators"][0]["asks"], "never spend on what it remembered")
            other.set_images({"generators": [*other.images_block()["generators"],
                                             {"provider": "bfl", "id": "bfl"}]})
            other.set_image_key("bfl", "bfl-later")
            self.assertEqual(running.image_key("bfl"), "bfl-later")
            running.set_image_key("bfl", "bfl-from-the-running-one")
            self.assertEqual(C.Config(config.project_root).image_key("bfl"), "bfl-from-the-running-one",
                             "a generator it never had in memory keeps the key it saved")
            other.set_image_key("bfl", "")
            self.assertEqual(running.image_key("bfl"), "")


    def test_a_change_back_to_what_this_process_last_wrote_is_saved(self):
        # Settings' DGC added fal (asks); a chat's DGC wrote "Always allow" (asks off); Settings turns asking back on.
        # Its own last write said asks: on, so the change looked like no change and the chat's value stayed.
        with Home() as home:
            settings = home.config()
            settings.set_images({"generators": [{"provider": "fal", "id": "fal", "asks": True}]})
            chat = C.Config(settings.project_root)
            block = chat.images_block()
            block["generators"][0]["asks"] = False
            chat.set_images(block)
            self.assertFalse(settings.images_block()["generators"][0]["asks"], "Settings shows it off")
            block = settings.images_block()
            block["generators"][0]["asks"] = True
            settings.set_images(block)
            self.assertTrue(home.disk()["images"]["generators"][0]["asks"], "and turning it on again sticks")
            self.assertTrue(C.Config(settings.project_root).images_block()["generators"][0]["asks"])
            self.assertTrue(chat.images_block()["generators"][0]["asks"])

class ProjectChoice(unittest.TestCase):
    def test_remembered_in_the_projects_dgc_folder(self):
        root = Path(tempfile.mkdtemp(prefix="dgc-images-project-"))
        self.assertEqual(images.project_choice(root), "")
        images.remember_project_choice(root, "comfy")
        self.assertEqual(images.project_choice(root), "comfy")
        self.assertEqual(json.loads((root / ".dgc" / "images.json").read_text())["generator"], "comfy")
        images.remember_project_choice(root, "")
        self.assertEqual(images.project_choice(root), "")


if __name__ == "__main__":
    unittest.main()
