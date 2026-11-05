"""Image generators (0.51): each adapter against a fake of its provider's API, and every provider's errors mapped to
the kinds DGC acts on (needs credit, rate limited, bad key, server down, refused by the provider's policy)."""
from __future__ import annotations

import json
import socket
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from image_fakes import FakeImages, png  # noqa: E402

from dgc import image_providers as P  # noqa: E402


def generator(provider, base, **extra):
    return {"id": provider, "name": f"{provider} test", "provider": provider, "base_url": base, "model": "",
            "size": "1024x1024", **extra}


class Fakes(unittest.TestCase):
    def setUp(self):
        self.fake = FakeImages()
        self.addCleanup(self.fake.close)

    def last(self, path_part):
        return [r for r in self.fake.requests if path_part in r["path"]][-1]


class OpenAICompatible(Fakes):
    def test_generations_returns_the_providers_bytes_and_its_revised_prompt(self):
        gen = generator("openai", self.fake.url, model="gpt-image-1")
        pictures = P.adapter_for("openai").generate(gen, "sk-test", P.Request("a cat", 1024, 1024, count=2))
        self.assertEqual(len(pictures), 2)
        self.assertEqual(pictures[0].data, self.fake.picture, "kept exactly as sent, metadata and all")
        self.assertEqual(pictures[0].revised_prompt, "a revised prompt")
        sent = self.last("/images/generations")
        self.assertEqual(sent["headers"]["Authorization"], "Bearer sk-test")
        self.assertEqual(sent["json"], {"prompt": "a cat", "n": 2, "model": "gpt-image-1", "size": "1024x1024"})

    def test_presets_shape_the_request_for_their_server(self):
        P.adapter_for("together").generate(generator("together", self.fake.url, model="m"), "k",
                                           P.Request("x", 512, 768, steps=4, seed=3))
        sent = self.last("/images/generations")["json"]
        self.assertEqual((sent["width"], sent["height"], sent["steps"], sent["seed"]), (512, 768, 4, 3))
        P.adapter_for("xai").generate(generator("xai", self.fake.url, model="grok-2-image"), "k", P.Request("x"))
        sent = self.last("/images/generations")["json"]
        self.assertNotIn("size", sent, "xAI takes no size")
        self.assertEqual(sent["response_format"], "b64_json")

    def test_an_image_by_url_is_downloaded(self):
        self.fake.mode["openai"] = "url"
        pictures = P.adapter_for("localai").generate(generator("localai", self.fake.url), "", P.Request("x"))
        self.assertEqual(pictures[0].mime, "image/png")

    def test_a_provider_cannot_point_an_image_download_at_another_local_service(self):
        with self.assertRaises(P.ImageError) as caught:
            P.download(f"{self.fake.url}/files/a.png", provider="openai", base="https://api.example.test/v1")
        self.assertIn("unsafe image address", caught.exception.message)
        self.assertFalse(any(row["path"] == "/files/a.png" for row in self.fake.requests))

    def test_a_local_generator_image_cannot_redirect_to_another_local_service(self):
        with self.assertRaises(P.ImageError) as caught:
            P.download(f"{self.fake.url}/files/redirect-private", provider="localai", base=self.fake.url)
        self.assertIn("outside its own address", caught.exception.message)

    def test_an_edit_goes_to_images_edits_as_multipart_with_its_mask(self):
        request = P.Request("make it blue", images=[P.InputImage(png(), "image/png", "in.png")],
                            mask=P.InputImage(png(), "image/png", "mask.png"))
        P.adapter_for("openai").generate(generator("openai", self.fake.url, model="gpt-image-1"), "k", request)
        sent = self.last("/images/edits")
        self.assertIn(b'name="image"', sent["body"])
        self.assertIn(b'name="mask"', sent["body"])
        self.assertIn(b"make it blue", sent["body"])

    def test_errors_map_to_their_kinds(self):
        for mode, kind in (("quota", "needs_credit"), ("bad_key", "bad_key"), ("policy", "refused"),
                           ("rate", "rate_limited")):
            with self.subTest(mode=mode):
                self.fake.mode["openai"] = mode
                with self.assertRaises(P.ImageError) as caught:
                    P.adapter_for("openai").generate(generator("openai", self.fake.url), "k", P.Request("x"))
                self.assertEqual(caught.exception.kind, kind)

    def test_an_ollama_without_an_image_endpoint_says_so(self):
        self.fake.mode["openai"] = "missing"
        with self.assertRaises(P.ImageError) as caught:
            P.adapter_for("ollama").generate(generator("ollama", self.fake.url), "", P.Request("x"))
        self.assertIn("no image endpoint", caught.exception.message)

    def test_check_lists_the_image_models(self):
        found = P.adapter_for("openai").check(generator("openai", self.fake.url), "k")
        self.assertTrue(found["ok"])
        self.assertEqual(found["models"], ["gpt-image-1", "dall-e-3"])

    def test_a_server_that_is_not_there_is_server_down(self):
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        with self.assertRaises(P.ImageError) as caught:
            P.adapter_for("localai").generate(generator("localai", f"http://127.0.0.1:{port}"), "", P.Request("x"))
        self.assertEqual(caught.exception.kind, "server_down")


class ComfyUIWorkflows(unittest.TestCase):
    SDXL = {
        "3": {"class_type": "KSampler", "inputs": {"seed": 5, "steps": 20, "cfg": 7, "denoise": 1.0,
                                                   "model": ["4", 0], "positive": ["6", 0], "negative": ["7", 0],
                                                   "latent_image": ["5", 0]}},
        "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "sdxl.safetensors"}},
        "5": {"class_type": "EmptyLatentImage", "inputs": {"width": 512, "height": 512, "batch_size": 1}},
        "6": {"class_type": "CLIPTextEncode", "inputs": {"text": "a cat", "clip": ["4", 1]}},
        "7": {"class_type": "CLIPTextEncode", "inputs": {"text": "blurry", "clip": ["4", 1]}},
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": ["4", 2]}},
        "9": {"class_type": "SaveImage", "inputs": {"images": ["8", 0]}},
    }
    FLUX = {
        "6": {"class_type": "CLIPTextEncode", "inputs": {"text": "x", "clip": ["11", 0]},
              "_meta": {"title": "CLIP Text Encode (Positive Prompt)"}},
        "26": {"class_type": "FluxGuidance", "inputs": {"guidance": 3.5, "conditioning": ["6", 0]}},
        "22": {"class_type": "BasicGuider", "inputs": {"model": ["12", 0], "conditioning": ["26", 0]}},
        "25": {"class_type": "RandomNoise", "inputs": {"noise_seed": 1}},
        "17": {"class_type": "BasicScheduler", "inputs": {"steps": 20, "scheduler": "simple", "denoise": 1}},
        "27": {"class_type": "EmptySD3LatentImage", "inputs": {"width": 1024, "height": 1024, "batch_size": 1}},
        "13": {"class_type": "SamplerCustomAdvanced", "inputs": {"noise": ["25", 0], "guider": ["22", 0],
                                                                 "latent_image": ["27", 0]}},
        "9": {"class_type": "SaveImage", "inputs": {"images": ["8", 0]}},
    }

    def test_an_sdxl_workflow_maps_prompt_negative_seed_steps_and_size(self):
        mapping, notes = P.detect_mapping(self.SDXL)
        self.assertEqual(mapping, {"prompt": "6.text", "negative": "7.text", "seed": "3.seed", "steps": "3.steps",
                                   "denoise": "3.denoise", "width": "5.width", "height": "5.height",
                                   "batch": "5.batch_size"})
        self.assertEqual(notes, [])
        lines = P.mapping_lines(self.SDXL, mapping)
        self.assertEqual(lines[0], "Prompt → node 6 (CLIPTextEncode).text")

    def test_a_flux_workflow_follows_the_guider_back_to_its_prompt(self):
        mapping, _notes = P.detect_mapping(self.FLUX)
        self.assertEqual(mapping["prompt"], "6.text")
        self.assertEqual(mapping["seed"], "25.noise_seed")
        self.assertEqual(mapping["steps"], "17.steps")
        self.assertEqual((mapping["width"], mapping["height"]), ("27.width", "27.height"))

    def test_an_editor_format_workflow_is_refused_with_how_to_export_it(self):
        with self.assertRaises(P.WorkflowError) as caught:
            P.load_workflow({"nodes": [], "links": []})
        self.assertIn("Export (API)", str(caught.exception))

    def test_a_workflow_with_nothing_to_map_says_what_is_missing(self):
        mapping, notes = P.detect_mapping({"1": {"class_type": "LoadImage", "inputs": {"image": "a.png"}}})
        self.assertNotIn("prompt", mapping)
        self.assertTrue(any("prompt" in note for note in notes))
        self.assertTrue(any("SaveImage" in note for note in notes))

    def test_a_turbo_checkpoint_gets_its_few_steps(self):
        self.assertEqual(P.turbo_settings("sd_xl_turbo_1.0_fp16.safetensors")["steps"], 2)
        self.assertEqual(P.turbo_settings("v1-5.safetensors"), {})


class ComfyUIServer(Fakes):
    def test_default_workflow_queues_follows_progress_and_fetches_the_result(self):
        gen = generator("comfyui", self.fake.url, model="sd_xl_turbo_1.0_fp16.safetensors", size="512x512")
        steps = []
        pictures = P.adapter_for("comfyui").generate(gen, "", P.Request("a red fox", 512, 512, count=2, seed=9),
                                                     progress=lambda value, total: steps.append((value, total)))
        self.assertEqual(len(pictures), 2, "the batch size carried the count")
        self.assertEqual(steps, [(1, 2), (2, 2)], "the websocket's progress, binary previews skipped")
        workflow = self.fake.comfy_prompt["prompt"]
        self.assertEqual(workflow["6"]["inputs"]["text"], "a red fox")
        self.assertEqual(workflow["3"]["inputs"]["seed"], 9)
        self.assertEqual(workflow["3"]["inputs"]["steps"], 2, "SDXL Turbo's own step count")
        self.assertEqual(workflow["5"]["inputs"]["batch_size"], 2)

    def test_an_edit_uploads_its_image_first(self):
        gen = generator("comfyui", self.fake.url, model="v1-5.safetensors")
        request = P.Request("make it night", images=[P.InputImage(png(), "image/png", "day.png")], seed=1)
        P.adapter_for("comfyui").generate(gen, "", request)
        self.assertEqual(len(self.fake.uploads), 1)
        workflow = self.fake.comfy_prompt["prompt"]
        self.assertEqual(workflow["10"]["inputs"]["image"], self.fake.uploads[0])
        self.assertLess(workflow["3"]["inputs"]["denoise"], 1.0)

    def test_the_users_own_workflow_with_its_confirmed_mapping(self):
        gen = generator("comfyui", self.fake.url, workflow="mine.json",
                        mapping={"prompt": "6.text", "seed": "3.seed", "width": "5.width", "height": "5.height"})
        adapter = P.adapter_for("comfyui", workflow_reader=lambda name: json.dumps(ComfyUIWorkflows.SDXL))
        adapter.generate(gen, "", P.Request("lighthouse", 768, 512, seed=4))
        workflow = self.fake.comfy_prompt["prompt"]
        self.assertEqual(workflow["6"]["inputs"]["text"], "lighthouse")
        self.assertEqual((workflow["5"]["inputs"]["width"], workflow["5"]["inputs"]["height"]), (768, 512))
        self.assertEqual(workflow["7"]["inputs"]["text"], "blurry", "an input not mapped is left as it was")

    def test_a_workflow_the_server_refuses_says_its_node_error(self):
        self.fake.mode["comfyui"] = "bad_node"
        with self.assertRaises(P.ImageError) as caught:
            P.adapter_for("comfyui").generate(generator("comfyui", self.fake.url, model="x"), "", P.Request("x"))
        self.assertEqual(caught.exception.kind, "bad_request")
        self.assertIn("Value not in list", caught.exception.message)

    def test_check_names_the_device_and_a_missing_checkpoint(self):
        adapter = P.adapter_for("comfyui")
        ok = adapter.check(generator("comfyui", self.fake.url, model="v1-5.safetensors"), "")
        self.assertTrue(ok["ok"])
        self.assertIn("RTX 4090", ok["detail"])
        missing = adapter.check(generator("comfyui", self.fake.url, model="nope.safetensors"), "")
        self.assertFalse(missing["ok"])
        self.assertIn("no checkpoint", missing["detail"])


class Automatic1111(Fakes):
    def test_txt2img_with_its_seeds_and_img2img_for_an_edit(self):
        adapter = P.adapter_for("a1111")
        gen = generator("a1111", self.fake.url, model="sdxl_turbo")
        pictures = adapter.generate(gen, "", P.Request("x", 512, 512, count=2))
        self.assertEqual([p.seed for p in pictures], [42, 43])
        sent = self.last("txt2img")["json"]
        self.assertEqual(sent["override_settings"], {"sd_model_checkpoint": "sdxl_turbo"})
        adapter.generate(gen, "", P.Request("y", images=[P.InputImage(png(), "image/png")]))
        self.assertIn("init_images", self.last("img2img")["json"])

    def test_a_server_without_its_api_says_how_to_turn_it_on(self):
        self.fake.mode["a1111"] = "no_api"
        found = P.adapter_for("a1111").check(generator("a1111", self.fake.url), "")
        self.assertFalse(found["ok"])
        self.assertIn("--api", found["detail"])


class GoogleGemini(Fakes):
    def test_generate_content_returns_the_image_part(self):
        gen = generator("gemini", self.fake.url, model="gemini-2.5-flash-image")
        pictures = P.adapter_for("gemini").generate(gen, "g-key", P.Request("x", 1280, 720,
                                                                             images=[P.InputImage(png(), "image/png")]))
        self.assertEqual(len(pictures), 1)
        sent = self.last(":generateContent")
        self.assertEqual(sent["headers"]["X-Goog-Api-Key"], "g-key")
        self.assertEqual(sent["json"]["generationConfig"]["imageConfig"]["aspectRatio"], "16:9")
        self.assertIn("inline_data", sent["json"]["contents"][0]["parts"][1])

    def test_imagen_has_its_own_call(self):
        gen = generator("gemini", self.fake.url, model="imagen-4.0-generate-001")
        self.assertEqual(len(P.adapter_for("gemini").generate(gen, "k", P.Request("x", count=3))), 3)

    def test_the_free_tier_403_is_needs_credit_and_the_others_their_kinds(self):
        for mode, kind in (("no_billing", "needs_credit"), ("bad_key", "bad_key"), ("rate", "rate_limited"),
                           ("blocked", "refused")):
            with self.subTest(mode=mode):
                self.fake.mode["gemini"] = mode
                with self.assertRaises(P.ImageError) as caught:
                    P.adapter_for("gemini").generate(generator("gemini", self.fake.url), "k", P.Request("x"))
                self.assertEqual(caught.exception.kind, kind)
                if mode == "no_billing":
                    self.assertIn("free tier is not available", caught.exception.message)

    def test_check_is_a_free_listing(self):
        found = P.adapter_for("gemini").check(generator("gemini", self.fake.url), "k")
        self.assertTrue(found["ok"])
        self.assertIn("gemini-2.5-flash-image", found["models"])
        self.assertNotIn("gemini-2.5-pro", found["models"])


class BlackForestLabs(Fakes):
    def test_submit_then_poll_then_download(self):
        gen = generator("bfl", self.fake.url, model="flux-pro-1.1")
        pictures = P.adapter_for("bfl").generate(gen, "b-key", P.Request("x", 1000, 1000, seed=5))
        self.assertEqual(len(pictures), 1)
        sent = self.last("/v1/flux-pro-1.1")
        self.assertEqual(sent["headers"]["X-Key"], "b-key")
        self.assertEqual((sent["json"]["width"], sent["json"]["height"]), (992, 992), "multiples of 32")
        self.assertGreaterEqual(len([r for r in self.fake.requests if "get_result" in r["path"]]), 2)

    def test_its_key_goes_to_its_own_hosts_only(self):
        # Black Forest Labs answers with a regional poll address (api.us1.bfl.ai for api.bfl.ai): that keeps the key; a
        # poll address anywhere else is replaced by its own get_result.
        own = P.own_address
        self.assertTrue(own("https://api.us1.bfl.ai/v1/get_result?id=1", "https://api.bfl.ai", family=True))
        self.assertTrue(own("https://api.bfl.ai/v1/get_result?id=1", "https://api.bfl.ai"))
        self.assertFalse(own("https://api.us1.bfl.ai/v1/get_result?id=1", "https://api.bfl.ai"), "family only")
        self.assertFalse(own("http://api.us1.bfl.ai/x", "https://api.bfl.ai", family=True), "never plain http")
        self.assertFalse(own("https://bfl.ai.example.com/x", "https://api.bfl.ai", family=True))
        self.assertFalse(own("https://collector.example.com/x", "https://api.bfl.ai", family=True))
        self.assertFalse(P.same_origin("https://api.replicate.com:8443/x", "https://api.replicate.com"))
        self.assertTrue(P.same_origin("https://API.replicate.com:443/x", "https://api.replicate.com/"))
        self.fake.bfl_polling = "https://collector.example.com/v1/get_result"
        gen = generator("bfl", self.fake.url, model="flux-pro-1.1")
        pictures = P.adapter_for("bfl").generate(gen, "b-key", P.Request("x", 1000, 1000))
        self.assertEqual(len(pictures), 1)
        polled = [r for r in self.fake.requests if "get_result" in r["path"]]
        self.assertTrue(polled and all(r["headers"]["X-Key"] == "b-key" for r in polled), "polled on its own address")

    def test_credits_moderation_and_the_credit_check(self):
        adapter = P.adapter_for("bfl")
        gen = generator("bfl", self.fake.url, model="flux-pro-1.1")
        for mode, kind in (("credits", "needs_credit"), ("moderated", "refused")):
            with self.subTest(mode=mode):
                self.fake.mode["bfl"] = mode
                with self.assertRaises(P.ImageError) as caught:
                    adapter.generate(gen, "k", P.Request("x"))
                self.assertEqual(caught.exception.kind, kind)
        self.fake.mode["bfl"] = "empty"
        self.assertEqual(adapter.check(gen, "k")["kind"], "needs_credit")
        self.fake.mode["bfl"] = "bad_key"
        self.assertEqual(adapter.check(gen, "k")["kind"], "bad_key")


class FalAndReplicate(Fakes):
    def test_fal_returns_its_images_with_their_seed(self):
        gen = generator("fal", self.fake.url, model="fal-ai/flux/schnell")
        pictures = P.adapter_for("fal").generate(gen, "f-key", P.Request("x", 1024, 768, count=2))
        self.assertEqual([p.seed for p in pictures], [1234, 1234])
        sent = self.last("/fal-ai/flux/schnell")
        self.assertEqual(sent["headers"]["Authorization"], "Key f-key")
        self.assertEqual(sent["json"]["image_size"], {"width": 1024, "height": 768})
        self.assertTrue(sent["json"]["sync_mode"], "the image comes back inline, not left on a CDN")

    def test_fal_locked_for_top_up_is_needs_credit_and_its_safety_checker_is_refused(self):
        adapter = P.adapter_for("fal")
        gen = generator("fal", self.fake.url, model="fal-ai/flux/schnell")
        self.fake.mode["fal"] = "locked"
        with self.assertRaises(P.ImageError) as caught:
            adapter.generate(gen, "k", P.Request("x"))
        self.assertEqual(caught.exception.kind, "needs_credit")
        self.assertIn("TOP_UP", caught.exception.message)
        self.assertEqual(adapter.check(gen, "k")["kind"], "needs_credit")
        self.fake.mode["fal"] = "nsfw"
        with self.assertRaises(P.ImageError) as caught:
            adapter.generate(gen, "k", P.Request("x"))
        self.assertEqual(caught.exception.kind, "refused")

    def test_fal_check_is_free_and_accepts_a_good_key(self):
        found = P.adapter_for("fal").check(generator("fal", self.fake.url, model="fal-ai/flux/schnell"), "k")
        self.assertTrue(found["ok"])

    def test_replicate_polls_its_prediction_and_maps_its_errors(self):
        adapter = P.adapter_for("replicate")
        gen = generator("replicate", self.fake.url, model="black-forest-labs/flux-schnell")
        self.assertEqual(len(adapter.generate(gen, "r-key", P.Request("x"))), 1)
        self.assertEqual(self.last("/predictions")["headers"]["Authorization"], "Bearer r-key")
        for mode, kind in (("credit", "needs_credit"), ("nsfw", "refused")):
            with self.subTest(mode=mode):
                self.fake.mode["replicate"] = mode
                with self.assertRaises(P.ImageError) as caught:
                    adapter.generate(gen, "k", P.Request("x"))
                self.assertEqual(caught.exception.kind, kind)
        self.fake.mode["replicate"] = "bad_key"
        self.assertEqual(adapter.check(gen, "k")["kind"], "bad_key")


if __name__ == "__main__":
    unittest.main()
