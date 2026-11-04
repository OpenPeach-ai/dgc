"""generate_image and list_image_generators (0.51), surface by surface the same: which generator a call uses (asking
once when several fit, then remembering it), the price and the Allow card, saving with sidecars, the monthly limit,
and what happens on "needs credit": a free generator by itself, a paid one never silently."""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from image_fakes import FakeImages, png  # noqa: E402
from test_images_config import Home  # noqa: E402

from dgc import image_tools as T  # noqa: E402
from dgc import images  # noqa: E402


class ToolsCase(unittest.TestCase):
    def setUp(self):
        self.fake = FakeImages()
        self.addCleanup(self.fake.close)
        self.home = Home()
        self.home.__enter__()
        self.addCleanup(self.home.__exit__)
        self.config = self.home.config()
        self.root = Path(self.config.project_root)
        self.asked: list = []
        self.answer = 0

    def setup(self, *generators, **block):
        rows = {"comfy": {"id": "comfy", "name": "ComfyUI on gpu-box", "provider": "comfyui",
                          "base_url": self.fake.url, "model": "sd_xl_turbo_1.0_fp16.safetensors", "size": "512x512"},
                "fal": {"id": "fal", "name": "fal FLUX schnell", "provider": "fal", "base_url": self.fake.url,
                        "model": "fal-ai/flux/schnell"},
                "gemini": {"id": "gemini", "name": "Gemini Flash Image", "provider": "gemini",
                           "base_url": self.fake.url, "model": "gemini-2.5-flash-image"}}
        self.config.set_images({"generators": [rows[name] for name in generators], **block})
        for name in generators:
            if name in ("fal", "gemini"):
                self.config.set_image_key(name, f"{name}-key")

    def surface(self, *, interactive=True, approve="once", **extra):
        def ask(title, options, recommended):
            self.asked.append((title, options, recommended))
            return self.answer
        return T.Surface(name="work", root=self.root, project_root=self.root, interactive=interactive,
                         ask=ask if interactive else None, approve=lambda card: approve, **extra)


class Choosing(ToolsCase):
    def test_one_generator_is_used_without_asking(self):
        self.setup("comfy")
        plan = T.prepare(self.config, {"prompt": "a fox"}, self.surface())
        self.assertEqual((plan.generator["id"], plan.why, plan.asks), ("comfy", "only", False))
        self.assertEqual(self.asked, [])
        self.assertEqual(images.project_choice(self.root), "", "nothing to remember with one generator")

    def test_several_fit_asks_once_and_remembers_for_the_project(self):
        self.setup("comfy", "fal")
        self.answer = 1
        plan = T.prepare(self.config, {"prompt": "a fox"}, self.surface())
        self.assertEqual(plan.generator["id"], "fal")
        self.assertTrue(plan.approved, "its price was on the question, so no second card")
        self.assertFalse(plan.asks)
        title, options, recommended = self.asked[0]
        self.assertIn("this project", title)
        self.assertEqual([label for label, _ in options], ["ComfyUI on gpu-box", "fal FLUX schnell"],
                         "free and local first")
        self.assertIn("free, local", options[0][1])
        self.assertIn("about $0.003 an image", options[1][1])
        self.assertEqual(images.project_choice(self.root), "fal")
        again = T.prepare(self.config, {"prompt": "another"}, self.surface())
        self.assertEqual((again.generator["id"], again.why), ("fal", "project"))
        self.assertTrue(again.asks, "the next one asks: a paid generator asks before each image")
        self.assertEqual(len(self.asked), 1, "asked once")

    def test_the_user_naming_one_wins_and_the_first_named_is_remembered(self):
        self.setup("comfy", "fal")
        plan = T.prepare(self.config, {"prompt": "x", "generator": "ComfyUI"}, self.surface())
        self.assertEqual((plan.generator["id"], plan.why), ("comfy", "named"))
        self.assertEqual(images.project_choice(self.root), "comfy")
        plan = T.prepare(self.config, {"prompt": "x", "generator": "fal"}, self.surface())
        self.assertEqual(plan.generator["id"], "fal")
        self.assertEqual(images.project_choice(self.root), "comfy", "naming one for this image changes no choice")

    def test_nobody_to_ask_uses_the_default_else_free_first(self):
        self.setup("fal", "comfy", default="fal")
        plan = T.prepare(self.config, {"prompt": "x"}, self.surface(interactive=False))
        self.assertEqual((plan.generator["id"], plan.why), ("fal", "default"))
        self.setup("fal", "comfy")
        plan = T.prepare(self.config, {"prompt": "x"}, self.surface(interactive=False))
        self.assertEqual((plan.generator["id"], plan.why), ("comfy", "first"))

    def test_an_edit_skips_a_generator_that_cant_edit(self):
        self.setup("comfy", "fal")
        (self.root / "in.png").write_bytes(png())
        plan = T.prepare(self.config, {"prompt": "make it night", "images": ["in.png"]}, self.surface())
        self.assertEqual(plan.generator["id"], "comfy", "fal's schnell model makes new images only")
        self.assertEqual(plan.request.images[0].name, "in.png")

    def test_calls_that_cant_run_are_refused_before_anyone_is_asked(self):
        with self.assertRaises(T.Refused) as caught:
            T.prepare(self.config, {"prompt": "x"}, self.surface())
        self.assertIn("no image generator is set up", str(caught.exception))
        self.setup("comfy")
        for args, words in (({"prompt": ""}, "say what the image shows"), ({"prompt": "x", "count": 9}, "count"),
                            ({"prompt": "x", "images": ["../../etc/passwd"]}, "outside"),
                            ({"prompt": "x", "images": ["missing.png"]}, "no image at"),
                            ({"prompt": "x", "generator": "nope"}, "no image generator 'nope'"),
                            ({"prompt": "x", "save_to": "/tmp/x"}, "outside"),
                            ({"prompt": "x", "size": "big"}, "WIDTHxHEIGHT")):
            with self.subTest(words=words), self.assertRaises(T.Refused) as caught:
                T.prepare(self.config, args, self.surface())
            self.assertIn(words, str(caught.exception))

    def test_size_and_aspect(self):
        self.setup("comfy")
        plan = T.prepare(self.config, {"prompt": "x", "aspect": "16:9"}, self.surface())
        self.assertEqual((plan.request.width, plan.request.height), (704, 384), "the generator's own area")
        plan = T.prepare(self.config, {"prompt": "x", "size": "4096x4096"}, self.surface())
        self.assertEqual((plan.request.width, plan.request.height), (2048, 2048), "its largest side")


class Money(ToolsCase):
    def test_the_card_has_provider_model_size_count_and_price(self):
        self.setup("fal")
        plan = T.prepare(self.config, {"prompt": "a cat", "count": 2, "size": "1024x1024"}, self.surface())
        self.assertTrue(plan.asks)
        card = plan.card()
        self.assertEqual({k: card[k] for k in ("generator", "provider", "model", "size", "count")},
                         {"generator": "fal FLUX schnell", "provider": "fal.ai", "model": "fal-ai/flux/schnell",
                          "size": "1024x1024", "count": 2})
        self.assertEqual(card["price"], "about $0.006 (about $0.003 each)")

    def test_always_allow_stops_asking_but_the_monthly_limit_still_holds(self):
        self.setup("fal")
        T.allow_always(self.config, "fal")
        self.assertFalse(images.settings(self.config)["generators"][0]["asks"])
        plan = T.prepare(self.config, {"prompt": "x"}, self.surface())
        self.assertFalse(plan.asks)
        block = images.settings(self.config)
        block["generators"][0]["monthly_limit_usd"] = 0.01
        self.config.set_images(block)
        images.add_spend("fal", 0.009)
        plan = T.prepare(self.config, {"prompt": "x"}, self.surface())
        self.assertTrue(plan.asks and plan.over_limit)
        self.assertIn("limit", plan.card()["note"])
        self.assertEqual(plan.card()["this_month"], "$0.009 of your $0.010 limit")


class TheLimitHolds(ToolsCase):
    """The monthly limit is read again just before a picture is sent, against everything on its key, the pictures
    being made right now included (in this DGC or another), so plans made before any was sent can't pass it."""

    def capped(self, cap, *, asks=False):
        self.setup("fal")
        block = images.settings(self.config)
        block["generators"][0].update(monthly_limit_usd=cap, asks=asks)
        self.config.set_images(block)

    def posts(self):
        return [r for r in self.fake.requests if r["path"].startswith("/fal-ai/")]

    def test_two_plans_within_the_limit_cant_both_pass_it(self):
        self.capped(0.01)                            # two FLUX Schnell images are $0.0062: one such plan fits
        plans = [T.prepare(self.config, {"prompt": f"fox {n}", "count": 2}, self.surface()) for n in (1, 2)]
        self.assertFalse(any(plan.asks or plan.over_limit for plan in plans), "each fits when it is worked out")
        self.assertIsNotNone(T.execute(self.config, plans[0], self.surface()).result)
        second = T.execute(self.config, plans[1], self.surface())
        self.assertIsNone(second.result)
        self.assertEqual(second.error.kind, "over_limit")
        self.assertIn("would pass the $0.010 monthly limit", second.text)
        self.assertIn("No image was made", second.text)
        self.assertEqual(len(self.posts()), 1, "the second was never sent")
        self.assertAlmostEqual(images.spent("fal"), 0.0062, places=4)
        self.assertEqual(images.last_state(plans[0].generator).get("ok"), True, "the generator itself works")

    def test_a_picture_being_made_holds_its_room(self):
        from dgc import image_providers as P
        self.capped(0.01)
        plan = T.prepare(self.config, {"prompt": "x", "count": 2}, self.surface())
        seen = []
        real = P.Fal.generate

        def slow(adapter, generator, key, request, *, progress=None, cancel=None):
            seen.append(T.prepare(self.config, {"prompt": "y", "count": 2}, self.surface()).over_limit)
            return real(adapter, generator, key, request, progress=progress, cancel=cancel)
        with patch.object(P.Fal, "generate", slow):
            self.assertIsNotNone(T.execute(self.config, plan, self.surface()).result)
        self.assertEqual(seen, [True], "its $0.0062 was on its way")
        self.assertEqual(images.committed(self.config, plan.generator), 0.0062, "and is spent now, held no more")

    def test_a_card_that_said_it_passes_the_limit_may_pass_it(self):
        self.capped(0, asks=True)
        plan = T.prepare(self.config, {"prompt": "x"}, self.surface())
        self.assertTrue(plan.over_limit and plan.asks)
        self.assertTrue(plan.card()["over_limit"])
        self.assertIsNotNone(T.execute(self.config, plan, self.surface()).result, "the user said yes to that card")

    def test_the_generator_question_still_asks_when_it_would_pass_the_limit(self):
        self.setup("comfy", "fal")
        block = images.settings(self.config)
        block["generators"][1]["monthly_limit_usd"] = 0
        self.config.set_images(block)
        self.answer = 1
        plan = T.prepare(self.config, {"prompt": "a fox"}, self.surface())
        self.assertEqual(plan.generator["id"], "fal")
        self.assertTrue(plan.approved)
        self.assertTrue(plan.over_limit and plan.asks, "its price was on the question; passing the limit wasn't")

    def test_a_picture_a_dgc_left_mid_generation_counts_as_spent(self):
        import json as _json
        import subprocess
        self.capped(1)
        gone = subprocess.Popen([sys.executable, "-c", "pass"])
        gone.wait()
        images._ensure_dir()
        (images.directory() / "reserved.json").write_text(_json.dumps({"old": {
            "generator": "fal", "amount": 0.25, "month": images.month(), "pid": gone.pid, "at": 0}}))
        self.assertEqual(images.committed(self.config, images.settings(self.config)["generators"][0]), 0.25)
        plan = T.prepare(self.config, {"prompt": "x"}, self.surface())
        T.execute(self.config, plan, self.surface())
        self.assertAlmostEqual(images.spent("fal"), 0.2531, places=4, msg="the provider may have made it")
        self.assertNotIn("old", _json.loads((images.directory() / "reserved.json").read_text()))


class UnknownPrice(ToolsCase):
    """A price DGC doesn't know can't be held to a monthly limit: under one, it is never made without a yes to a card
    that says so, whatever Always allow or the generator's own asking says."""

    def capped(self, cap):
        self.setup("fal")
        T.allow_always(self.config, "fal")                  # asking turned off
        block = images.settings(self.config)
        block["generators"][0]["monthly_limit_usd"] = cap
        self.config.set_images(block)

    def test_it_asks_and_its_card_says_why(self):
        self.capped(5)
        plan = T.prepare(self.config, {"prompt": "x", "model": "fal-ai/brand-new-model"}, self.surface())
        self.assertIsNone(plan.total)
        self.assertTrue(plan.unpriced and plan.asks)
        card = plan.card()
        self.assertEqual((card["price"], card["price_unknown"]), ("price unknown", True))
        self.assertIn("DGC doesn't know what fal-ai/brand-new-model charges, so it can't keep this within your $5.00 "
                      "monthly limit: it may cost more", card["note"])
        known = T.prepare(self.config, {"prompt": "x"}, self.surface())
        self.assertFalse(known.unpriced or known.asks, "a known price under the limit still goes without asking")

    def test_the_final_check_fails_closed_without_that_yes(self):
        from dgc import image_providers as P
        self.capped(5)
        generator = images.settings(self.config)["generators"][0]
        with self.assertRaises(P.ImageError) as said:
            images.generate(self.config, generator, P.Request("x", 1024, 1024, model="fal-ai/brand-new-model"),
                            folder=self.root / "out", root=self.root, surface="work")
        self.assertEqual(said.exception.kind, "over_limit")
        self.assertIn("doesn't know what fal FLUX schnell charges", said.exception.message)
        self.assertEqual([r for r in self.fake.requests if r["path"].startswith("/fal-ai/")], [], "never sent")
        plan = T.prepare(self.config, {"prompt": "x", "model": "fal-ai/brand-new-model"}, self.surface())
        self.assertIsNotNone(T.execute(self.config, plan, self.surface()).result, "the yes to its card makes it")


class ChargesStay(ToolsCase):
    """A picture the provider may have charged for stays in this month's spend though DGC didn't keep it; one every
    request of which the provider refused costs nothing."""

    def test_a_picture_the_provider_made_but_dgc_couldnt_save_stays_counted(self):
        self.setup("fal")
        plan = T.prepare(self.config, {"prompt": "x"}, self.surface())
        with patch.object(images, "save", side_effect=OSError(28, "No space left on device")), \
                self.assertRaises(OSError):
            T.execute(self.config, plan, self.surface())
        self.assertAlmostEqual(images.spent("fal"), 0.0031, places=4)

    def test_a_download_cut_off_after_the_provider_made_it_stays_counted(self):
        from dgc import image_providers as P
        self.config.set_images({"generators": [{"id": "rep", "name": "Replicate FLUX", "provider": "replicate",
                                                "base_url": self.fake.url}]})
        self.config.set_image_key("rep", "r8_key")
        plan = T.prepare(self.config, {"prompt": "x"}, self.surface())
        with patch.object(P, "download", side_effect=P.ImageError("server_down", "the download was cut off")):
            out = T.execute(self.config, plan, self.surface())
        self.assertIsNone(out.result)
        self.assertAlmostEqual(images.spent("rep"), 0.003, places=4, msg="the prediction was made")
        self.assertEqual(images.committed(self.config, plan.generator), 0.003, "held no more, spent")

    def test_a_request_the_provider_refused_costs_nothing(self):
        self.setup("fal")
        self.fake.mode["fal"] = "locked"
        plan = T.prepare(self.config, {"prompt": "x"}, self.surface())
        self.assertIsNone(T.execute(self.config, plan, self.surface()).result)
        self.assertEqual(images.spent("fal"), 0)
        self.assertEqual(images.committed(self.config, plan.generator), 0)


class Making(ToolsCase):
    def test_saved_with_a_sidecar_in_the_project_and_listed(self):
        self.setup("comfy")
        steps = []
        surface = self.surface(progress=lambda text, value, total: steps.append(text))
        plan = T.prepare(self.config, {"prompt": "A red fox, watercolor", "count": 2, "seed": 77}, surface)
        out = T.execute(self.config, plan, surface)
        self.assertTrue(out.text.startswith("Made 2 images with ComfyUI on gpu-box"), out.text)
        self.assertIn("assets/generated/a-red-fox-watercolor-", out.text)
        self.assertIn("free", out.text)
        saved = out.result.saved
        self.assertEqual(len(saved), 2)
        self.assertEqual(saved[0].path.read_bytes(), self.fake.picture, "the provider's bytes, untouched")
        sidecar = json.loads(saved[0].sidecar.read_text())
        self.assertEqual({k: sidecar[k] for k in ("prompt", "provider", "generator", "model", "seed", "cost_usd")},
                         {"prompt": "A red fox, watercolor", "provider": "comfyui", "generator": "comfy",
                          "model": "sd_xl_turbo_1.0_fp16.safetensors", "seed": 77, "cost_usd": 0.0})
        self.assertTrue(steps and "step 1 of 2" in steps[0])
        found = images.library()
        self.assertEqual(found["total"], 2)
        self.assertEqual(found["images"][0]["surface"], "work")
        self.assertEqual(images.last_state(plan.generator)["ok"], True)

    def test_save_to_a_named_file_and_spend_is_counted(self):
        self.setup("fal")
        plan = T.prepare(self.config, {"prompt": "logo", "save_to": "art/logo.png"}, self.surface())
        out = T.execute(self.config, plan, self.surface())
        self.assertEqual(out.result.saved[0].rel, "art/logo.png")
        self.assertAlmostEqual(images.spent("fal"), 0.0031, places=4, msg="1.05 megapixels at $0.003 each")

    def test_a_model_the_user_asked_for_is_charged_at_its_own_price(self):
        # The card priced Ideogram ($0.08); the result, its sidecar, the Library and this month's spend say the same,
        # not the generator's own FLUX Schnell price.
        self.setup("fal")
        plan = T.prepare(self.config, {"prompt": "a sign that says OPEN", "model": "fal-ai/ideogram/v2"},
                         self.surface())
        self.assertEqual((plan.total, plan.card()["model"]), (0.08, "fal-ai/ideogram/v2"))
        out = T.execute(self.config, plan, self.surface())
        self.assertTrue(any(r["path"] == "/fal-ai/ideogram/v2" for r in self.fake.requests), "Ideogram was sent")
        self.assertEqual((out.result.model, out.result.cost), ("fal-ai/ideogram/v2", 0.08))
        self.assertIn("about $0.08", out.text)
        self.assertEqual(json.loads(out.result.saved[0].sidecar.read_text())["cost_usd"], 0.08)
        self.assertEqual(images.library()["images"][0]["cost_usd"], 0.08)
        self.assertEqual(images.spent("fal"), 0.08)


class NeedsCredit(ToolsCase):
    def test_gemini_needs_credit_so_dgc_uses_the_free_one_by_itself(self):
        self.setup("gemini", "comfy")
        self.fake.mode["gemini"] = "no_billing"
        images.remember_project_choice(self.root, "gemini")
        plan = T.prepare(self.config, {"prompt": "x"}, self.surface())
        out = T.execute(self.config, plan, self.surface())
        self.assertIn("Gemini Flash Image needs credit: The Gemini API free tier is not available", out.text)
        self.assertIn("So DGC used ComfyUI on gpu-box instead (free).", out.text)
        self.assertEqual(out.used["id"], "comfy")
        self.assertEqual(images.last_state({"id": "gemini"})["kind"], "needs_credit")

    def test_only_paid_others_are_offered_never_used_silently(self):
        self.setup("gemini", "fal")
        self.fake.mode["gemini"] = "no_billing"
        images.remember_project_choice(self.root, "gemini")
        plan = T.prepare(self.config, {"prompt": "x"}, self.surface(interactive=False))
        out = T.execute(self.config, plan, self.surface(interactive=False))
        self.assertTrue(out.text.startswith("error: Gemini Flash Image needs credit"), out.text)
        self.assertIn("Other generators that fit: fal (fal FLUX schnell, about $0.003 an image", out.text)
        self.assertIn("never switch to a paid one without their answer", out.text)
        self.assertEqual([r for r in self.fake.requests if r["path"].startswith("/fal-ai/")], [], "fal never called")

    def test_interactively_the_user_is_offered_the_others_and_their_pick_is_used(self):
        self.setup("gemini", "fal")
        self.fake.mode["gemini"] = "no_billing"
        images.remember_project_choice(self.root, "gemini")
        plan = T.prepare(self.config, {"prompt": "x"}, self.surface())
        out = T.execute(self.config, plan, self.surface())
        self.assertIn("Use another generator?", self.asked[-1][0])
        self.assertEqual([label for label, _ in self.asked[-1][1]], ["fal FLUX schnell", "Don't make it"],
                         "one other generator is still a choice, with a way out")
        self.assertIn("The user chose fal FLUX schnell instead.", out.text)
        self.assertEqual(images.project_choice(self.root), "fal", "the pick is this project's choice now")

    def test_dont_make_it_makes_nothing(self):
        self.setup("gemini", "fal")
        self.fake.mode["gemini"] = "no_billing"
        images.remember_project_choice(self.root, "gemini")
        self.answer = 1
        plan = T.prepare(self.config, {"prompt": "x"}, self.surface())
        out = T.execute(self.config, plan, self.surface())
        self.assertIn("The user chose no other generator", out.text)
        self.assertEqual([r for r in self.fake.requests if r["path"].startswith("/fal-ai/")], [])

    def test_automatic_fallback_to_a_paid_one_still_shows_its_card(self):
        self.setup("gemini", "fal", auto_fallback=True)
        self.fake.mode["gemini"] = "no_billing"
        images.remember_project_choice(self.root, "gemini")
        plan = T.prepare(self.config, {"prompt": "x"}, self.surface())
        cards = []
        surface = self.surface(approve="no")
        surface.approve = lambda card: cards.append(card) or "no"
        out = T.execute(self.config, plan, surface)
        self.assertEqual(cards[0]["generator"], "fal FLUX schnell")
        self.assertIn("the user didn't allow it", out.text)
        surface.approve = lambda card: "once"
        out = T.execute(self.config, plan, surface)
        self.assertIn("Automatic fallback is on, so DGC used fal FLUX schnell instead.", out.text)

    def test_a_policy_refusal_is_not_a_fallback(self):
        self.setup("gemini", "comfy")
        self.fake.mode["gemini"] = "blocked"
        plan = T.prepare(self.config, {"prompt": "x", "generator": "gemini"}, self.surface())
        out = T.execute(self.config, plan, self.surface())
        self.assertIn("refused by the provider's policy", out.text)
        self.assertIsNone(out.used)


class Listing(ToolsCase):
    def test_what_each_can_do_its_price_and_whether_it_works(self):
        self.setup("comfy", "fal", "gemini", default="comfy")
        self.fake.mode["gemini"] = "no_billing"
        images.remember_project_choice(self.root, "fal")
        text = T.list_text(self.config, {"refresh": True}, self.surface())
        self.assertIn("This project uses fal.", text)
        self.assertIn('- comfy "ComfyUI on gpu-box": ComfyUI · sd_xl_turbo_1.0_fp16.safetensors · free, local', text)
        self.assertIn("about $0.003 an image", text)
        self.assertIn("works", text)
        self.assertIn("Runway and Higgsfield", text)
        with patch.object(images.P.Gemini, "generate", side_effect=images.P.ImageError("needs_credit", "billing")):
            try:
                images.generate(self.config, images.find(images.settings(self.config), "gemini"),
                                images.P.Request("x"), folder=self.root / "o", root=self.root, surface="work")
            except images.P.ImageError:
                pass
        text = T.list_text(self.config, {"refresh": True}, self.surface())
        gemini_line = next(line for line in text.splitlines() if line.startswith("- gemini"))
        self.assertIn("needs credit", gemini_line, "a key that lists models but can't pay still needs credit")

    def test_its_key_is_said_as_this_dgc_has_it_and_a_test_elsewhere_doesnt_say_it_works_without_one(self):
        import os
        self.config.set_images({"generators": [{"id": "fal", "name": "fal FLUX schnell", "provider": "fal"}]})
        images.record_check("fal", {"ok": True, "detail": "made 1 image"})     # another DGC, with FAL_KEY set
        with patch.dict(os.environ, {"FAL_KEY": "", "FAL_API_KEY": ""}):
            line = next(l for l in T.list_text(self.config, {}, self.surface()).splitlines() if l.startswith("- fal"))
        self.assertIn("no key yet (the user adds it in Settings → Models → Images & video, or with /images key fal)", line)
        self.assertNotIn("works", line, "not here: there is no key")
        with patch.dict(os.environ, {"FAL_KEY": "fal-from-env"}):
            line = next(l for l in T.list_text(self.config, {}, self.surface()).splitlines() if l.startswith("- fal"))
        self.assertIn("works", line)
        self.assertIn("key from FAL_KEY", line, "an environment key counts, and says where it came from")
        self.assertNotIn("no key", line)
        self.assertNotIn("fal-from-env", line)
        self.config.set_image_key("fal", "fal-saved")
        line = next(l for l in T.list_text(self.config, {}, self.surface()).splitlines() if l.startswith("- fal"))
        self.assertIn("key saved", line)

    def test_nothing_set_up_says_how_to_add_one(self):
        self.assertIn("No image generator is set up", T.list_text(self.config, {}, self.surface()))


class ToolRow(ToolsCase):
    """What the person reads in their tool row (ui.shown_output): a short plain line, never the sentences written for
    the model, which still reads every one of them."""

    def shown(self, text):
        from dgc.ui import shown_output
        return shown_output("generate_image", text)

    def test_made_images_read_as_one_line_and_where_they_are(self):
        self.setup("comfy")
        plan = T.prepare(self.config, {"prompt": "a fox", "count": 2}, self.surface())
        out = T.execute(self.config, plan, self.surface())
        self.assertIn("A sidecar .json with the prompt, provider, model, seed and cost is beside each file.", out.text)
        self.assertIn("The user sees them in the chat.", out.text, "the model is still told")
        lines = self.shown(out.text).splitlines()
        self.assertEqual(lines[0], "Made 2 images with ComfyUI on gpu-box · 16×16 · free")
        self.assertEqual(lines[1], ", ".join(item.rel for item in out.result.saved))
        self.assertEqual(len(lines), 2)

    def test_a_paid_one_says_its_price(self):
        self.setup("fal")
        out = T.execute(self.config, T.prepare(self.config, {"prompt": "a cat"}, self.surface()), self.surface())
        self.assertEqual(self.shown(out.text).splitlines()[0], "Made 1 image with fal FLUX schnell · 16×16 · about $0.003")

    def test_a_fallback_says_why_without_the_models_options(self):
        self.setup("gemini", "comfy", "fal")
        self.fake.mode["gemini"] = "no_billing"
        images.remember_project_choice(self.root, "gemini")
        out = T.execute(self.config, T.prepare(self.config, {"prompt": "x"}, self.surface()), self.surface())
        self.assertIn("Also there, if the user wants it: fal", out.text, "the model may offer fal")
        self.assertIn("The Gemini API free tier is not available", out.text, "the model reads what the provider said")
        lines = self.shown(out.text).splitlines()
        self.assertEqual(lines[0], "Gemini Flash Image: needs credit. So DGC used ComfyUI on gpu-box instead (free).")
        self.assertEqual(lines[1], "Made 1 image with ComfyUI on gpu-box · 16×16 · free")
        other = ("fal rate limited: slow down. Automatic fallback is on, so DGC used Gemini instead. Made 1 image with "
                 "Gemini (Google Gemini, gemini-2.5-flash-image, about $0.039) in 4 s: a.png (1024×1024). " + T._SIDECAR)
        self.assertEqual(self.shown(other).splitlines()[0], "fal: rate limited. Automatic fallback is on, so DGC used Gemini instead.")

    def test_no_image_made_reads_as_what_happened(self):
        self.setup("gemini", "fal")
        self.fake.mode["gemini"] = "no_billing"
        images.remember_project_choice(self.root, "gemini")
        out = T.execute(self.config, T.prepare(self.config, {"prompt": "x"}, self.surface(interactive=False)),
                        self.surface(interactive=False))
        self.assertIn("Ask the user which to use", out.text, "the model is told what to do")
        shown = self.shown(out.text)
        self.assertTrue(shown.startswith("error: Gemini Flash Image needs credit"), shown)
        self.assertTrue(shown.endswith("No image was made."), shown)

    def test_the_prompt_the_provider_rewrote_stays(self):
        text = ("Made 1 image with OpenAI images (OpenAI, gpt-image-1, about $0.04) in 3.1 s: assets/generated/a.png "
                "(1024×1024). A sidecar .json with the prompt, provider, model, seed and cost is beside each file. The "
                "user sees it in the chat. The provider rewrote the prompt as: a red fox in snow")
        self.assertEqual(self.shown(text), "Made 1 image with OpenAI images · 1024×1024 · about $0.04\n"
                                           "assets/generated/a.png\nThe provider rewrote the prompt as: a red fox in snow")

    def test_a_name_with_brackets_and_anything_else_is_left_alone(self):
        text = ("Made 1 image with ComfyUI (desk) (ComfyUI, sd_xl_turbo, free) in 2 s: out/a.png (512×512; seed 7). "
                "A sidecar .json with the prompt, provider, model, seed and cost is beside each file. The user sees "
                "it in the chat.")
        self.assertEqual(self.shown(text), "Made 1 image with ComfyUI (desk) · 512×512 · free\nout/a.png")
        for other in ("Stopped: no image was made.", "The user DENIED this action", "something else entirely"):
            self.assertEqual(self.shown(other), other)
        from dgc.ui import shown_output
        self.assertEqual(shown_output("bash", text), text, "only generate_image's own result")



class WhenNothingCanBeMade(ToolsCase):
    """Seen in testing, 2026-11-02: a fal key pasted in part was saved, every picture failed, and the model, told only
    "Tell the user", went on in auto mode to write and run a drawing script in a company repository."""

    def test_a_refused_key_says_what_to_fix_and_not_to_make_it_some_other_way(self):
        self.setup("gemini")
        self.fake.mode["gemini"] = "bad_key"
        plan = T.prepare(self.config, {"prompt": "x", "generator": "gemini"}, self.surface())
        out = T.execute(self.config, plan, self.surface())
        self.assertIn("No image was made, and no other generator fits. Stop here and tell the user: its key wasn't "
                      "accepted, so they should paste the whole key again in Settings → Models → Images", out.text)
        self.assertIn("Don't make the picture some other way", out.text)
        self.assertTrue(T.shown_text(out.text).endswith("No image was made, and no other generator fits."),
                        "the person's row stays one plain line")

    def test_a_key_pasted_in_part_is_kept_with_a_plain_warning(self):
        from dgc import images_admin as admin
        self.setup("fal")
        said = admin.set_key(self.config, "fal", "0123456789abcdef0123456789abcdef01234567")
        self.assertIn("doesn't look like a whole fal key", said["summary"])
        self.assertIn("doesn't look like a whole fal key", said["note"])
        self.assertNotIn("0123456789abcdef", said["summary"], "never says the key")
        self.assertNotIn("note", admin.set_key(self.config, "fal", "1b2c3d4e-0000-1111-2222-333344445555:" + "f" * 32))

    def test_key_shapes(self):
        from dgc.images_admin import key_shape_note
        self.assertEqual(key_shape_note("fal", "id:secret"), "")
        self.assertIn("fal", key_shape_note("fal", ":secret"))
        self.assertIn("r8_", key_shape_note("replicate", "abc"))
        self.assertEqual(key_shape_note("replicate", "r8_abc"), "")
        self.assertIn("AIza", key_shape_note("gemini", "AIzaShort"))
        self.assertEqual(key_shape_note("gemini", "AIza" + "x" * 35), "")
        self.assertEqual(key_shape_note("openai_compatible", "anything"), "", "no check where no shape is documented")


class PictureShownOnce(unittest.TestCase):
    """A picture generate_image made this turn is on screen already: show_file of it isn't drawn a second time."""

    def test_show_file_of_a_picture_made_this_turn_is_recognised(self):
        import tempfile
        from types import SimpleNamespace
        from dgc.agent import Agent
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            made = root / "assets" / "generated" / "ball.png"
            made.parent.mkdir(parents=True)
            made.write_bytes(png(8, 8))
            agent = SimpleNamespace(config=SimpleNamespace(project_root=root),
                                    _turn_made_pictures={str(made.resolve())})
            self.assertTrue(Agent._already_shown_picture(agent, {"path": "assets/generated/ball.png"}))
            self.assertTrue(Agent._already_shown_picture(agent, {"path": str(made)}))
            other = root / "shot.png"
            other.write_bytes(png(8, 8))
            self.assertFalse(Agent._already_shown_picture(agent, {"path": "shot.png"}))
            agent._turn_made_pictures = set()
            self.assertFalse(Agent._already_shown_picture(agent, {"path": "assets/generated/ball.png"}),
                             "a later turn may show it again")

if __name__ == "__main__":
    unittest.main()
