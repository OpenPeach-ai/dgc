"""Image generation and DGC Router (0.51): a system can carry the images job (a ComfyUI or Automatic1111 box with its
queue), and a generator that names it holds one of its workers while it makes a picture, so a one-model-at-a-time box
never runs a big model and a picture together."""
from __future__ import annotations

import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from image_fakes import FakeImages  # noqa: E402
from test_images_config import Home  # noqa: E402

from dgc import config as C  # noqa: E402
from dgc import image_providers as P  # noqa: E402
from dgc import images, router as R, router_tools  # noqa: E402


class RouterCase(unittest.TestCase):
    def setUp(self):
        self.fake = FakeImages()
        self.addCleanup(self.fake.close)
        self.home = Home()
        self.home.__enter__()
        self.addCleanup(self.home.__exit__)
        self.config = self.home.config()
        self.router = R.Router()
        for item in (patch.object(R, "ROUTER", self.router),
                     patch.object(R.Router, "ensure_health", lambda self, config: None)):
            item.start()
            self.addCleanup(item.stop)


class Settings(RouterCase):
    def test_an_image_server_does_the_images_job_only(self):
        block, problems = C.validate_router({"systems": [{"id": "gpu", "base_url": "gpu-box.local:8188",
                                                          "server": "comfyui"}]})
        self.assertEqual(problems, [])
        self.assertEqual(block["systems"][0]["jobs"], ["images"])
        _block, problems = C.validate_router({"systems": [{"id": "gpu", "base_url": "gpu-box.local:8188",
                                                           "server": "comfyui", "jobs": ["subagents"]}]})
        self.assertTrue(any("images job only" in p for p in problems))
        block, problems = C.validate_router({"systems": [{"id": "gpu-box", "base_url": "gpu-box.local",
                                                          "server": "ollama", "jobs": ["subagents", "images"]}]})
        self.assertEqual((problems, block["systems"][0]["jobs"]), ([], ["subagents", "images"]))
        block, _ = C.validate_router({"systems": [{"id": "nas", "base_url": "nas.local", "server": "ollama"}]})
        self.assertEqual(block["systems"][0]["jobs"], ["subagents", "pips"], "a model server's default is unchanged")

    def test_router_update_adds_a_comfyui_box_now(self):
        self.fake.mode["openai"] = "absent"
        plan = router_tools.plan_update(self.config, {"action": "add_system", "base_url": self.fake.url,
                                                      "name": "GPU box images"})
        router_tools.apply_plan(self.config, plan)
        system = R.find_system(R.settings(self.config), "gpu-box-images")
        self.assertEqual((system["server"], system["jobs"], system["models"]), ("comfyui", ["images"], []))
        self.assertTrue(any("image server" in note for note in plan.notes))


class Leases(RouterCase):
    def setup(self, *, one_model=False, enabled=True, jobs=("images",)):
        self.config.set_router({"enabled": enabled, "systems": [
            {"id": "gpu", "name": "GPU box", "base_url": self.fake.url, "server": "comfyui" if jobs == ("images",)
             else "ollama", "jobs": list(jobs), "workers": 1, "one_model_at_a_time": one_model,
             "models": [] if jobs == ("images",) else [{"name": "qwen3:8b", "workers": 1}]}]})
        self.config.set_images({"generators": [{"id": "comfy", "name": "ComfyUI on GPU box", "provider": "comfyui",
                                                "base_url": self.fake.url, "model": "sd_xl_turbo_1.0_fp16.safetensors",
                                                "system": "gpu"}]})
        return images.find(images.settings(self.config), "comfy")

    def generate(self, generator):
        seen = []
        real = P.ComfyUI.generate

        def watching(adapter, gen, key, request, **kw):
            seen.append([(lease["system"], lease["job"], lease["model"]) for lease in self.router.leases()])
            return real(adapter, gen, key, request, **kw)
        with patch.object(P.ComfyUI, "generate", watching):
            images.generate(self.config, generator, P.Request("a fox", 512, 512), folder=Path(tempfile.mkdtemp()),
                            root=None, surface="work")
        return seen

    def test_a_generation_holds_one_worker_of_its_system_while_it_runs(self):
        generator = self.setup()
        self.assertEqual(self.generate(generator), [[("gpu", "images", "images")]])
        self.assertEqual(self.router.leases(), [], "given back")

    def test_with_the_router_off_nothing_is_held(self):
        generator = self.setup(enabled=False)
        self.assertEqual(self.generate(generator), [[]])

    def test_a_one_model_box_busy_with_a_chat_model_waits_for_it(self):
        generator = self.setup(one_model=True, jobs=("subagents", "images"))
        route, _ = self.router.acquire(self.config, "subagents", wait=False)
        self.assertIsNotNone(route)
        lease, why = self.router.lease_system(self.config, "gpu", owner="test", wait=False)
        self.assertEqual((lease, why), (None, "busy"), "never a picture beside a big model there")
        done = threading.Event()

        def later():
            self.generate(generator)
            done.set()
        worker = threading.Thread(target=later, daemon=True)
        worker.start()
        self.assertFalse(done.wait(0.6), "it waits for the worker")
        self.router.release(route)
        self.assertTrue(done.wait(10), "and runs once the chat model is done")

    def test_a_generator_naming_a_system_without_the_job_is_refused(self):
        generator = self.setup()
        self.config.set_router({"enabled": True, "systems": [{"id": "gpu", "base_url": self.fake.url,
                                                              "server": "ollama", "jobs": ["subagents"]}]})
        with self.assertRaises(P.ImageError) as caught:
            self.generate(generator)
        self.assertIn("doesn't have the images job", caught.exception.message)


if __name__ == "__main__":
    unittest.main()
