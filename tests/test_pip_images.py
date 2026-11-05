"""Image generation for Pips (0.51): made by the controller with the user's generators (the worker never holds a key),
kept with the Pip's reply in its chat, and a paid image only after the user's own yes in a later turn; a routine's run
never makes one."""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from image_fakes import FakeImages  # noqa: E402

from dgc import images, pip_chat, pip_images  # noqa: E402
from tests import test_pips_local as fixtures  # noqa: E402


class PipImages(unittest.TestCase):
    setUp_pips = fixtures.LocalPipsTests.setUp
    git = fixtures.LocalPipsTests.git
    commit = fixtures.LocalPipsTests.commit
    create = fixtures.LocalPipsTests.create

    def setUp(self):
        self.setUp_pips()
        self.fake = FakeImages()
        self.addCleanup(self.fake.close)
        self.commit()
        self.job = self.create()

    def generators(self, *names):
        rows = {"comfy": {"id": "comfy", "name": "ComfyUI on gpu-box", "provider": "comfyui",
                          "base_url": self.fake.url, "model": "sd_xl_turbo_1.0_fp16.safetensors", "size": "512x512"},
                "fal": {"id": "fal", "name": "fal FLUX schnell", "provider": "fal", "base_url": self.fake.url,
                        "model": "fal-ai/flux/schnell"}}
        self.cfg.set_images({"generators": [rows[n] for n in names]}, persist=False)
        if "fal" in names:
            self.cfg.set_image_key("fal", "fal-key", persist=False)

    def send(self, text, key):
        return pip_chat.send(self.store, self.job["id"], text, key, "device_1", self.cfg)

    def session(self, run_id, *, user_turn=True, unattended=False, user_message="Yes please"):
        session = pip_images.Session(self.registry.directory, self.cfg, self.job["id"], self.job["workspace_id"],
                                     run_id, unattended=unattended)
        session.user_turn = user_turn
        session.user_message = user_message if user_turn else ""
        return session

    def reply(self):
        return [m for m in pip_chat.list_messages(self.store, self.job["id"])["messages"] if m["role"] == "assistant"]

    def fal_calls(self):
        return [r for r in self.fake.requests if r["path"].startswith("/fal-ai/")]

    def test_a_free_generator_makes_it_and_the_reply_shows_it(self):
        self.generators("comfy")
        sent = self.send("Draw me a fox", "m1")
        said = self.session(sent["run"]["id"]).call("generate_image", {"prompt": "a red fox"})
        self.assertTrue(said.startswith("Made 1 image with ComfyUI on gpu-box"), said)
        self.assertIn("It shows with your reply in your chat.", said)
        self.store.claim_next()
        self.store.finish(sent["run"]["id"], result={"text": "Here's your fox."})
        [reply] = self.reply()
        self.assertEqual(reply["images"], [{"index": 0, "mime": "image/png", "bytes": len(self.fake.picture)}])
        got = pip_chat.get_image(self.store, self.job["id"], reply["id"], 0)
        self.assertTrue(got["image"].startswith("data:image/png;base64,"))
        kept = list(pip_images.folder(self.job["id"]).glob("*.png"))
        self.assertEqual(len(kept), 1, "its own folder, with a sidecar")
        self.assertTrue(kept[0].with_suffix(".json").exists())
        self.assertEqual(images.library(surface="pip")["total"], 1)

    def test_a_paid_one_waits_for_the_users_own_yes_in_a_later_turn(self):
        self.generators("fal")
        first = self.send("Make me a logo", "m1")
        asked = self.session(first["run"]["id"])
        said = asked.call("generate_image", {"prompt": "a minimal fox logo"})
        self.assertTrue(said.startswith("Not made yet: 1 image with fal FLUX schnell"), said)
        self.assertIn("about $0.003", said)
        again = asked.call("generate_image", {"prompt": "a minimal fox logo", "confirm": True})
        self.assertTrue(again.startswith("Not made: the user hasn't answered yet: ask in your reply, with the price, "
                                         "and wait for their yes."), "the same run can't confirm its own question")
        self.assertEqual(self.fal_calls(), [])
        self.store.claim_next()
        self.store.finish(first["run"]["id"], result={"text": "It costs about $0.003. Shall I?"})
        second = self.send("Yes please", "m2")
        answering = self.session(second["run"]["id"])
        hint = answering.call("generate_image", {"prompt": "a minimal fox logo"})
        self.assertIn("call generate_image again with confirm: true now", hint, "a call without confirm keeps the question")
        made = answering.call("generate_image", {"prompt": "a minimal fox logo", "confirm": True})
        self.assertTrue(made.startswith("Made 1 image with fal FLUX schnell"), made)
        self.assertEqual(len(self.fal_calls()), 1)

    def test_a_yes_covers_only_the_exact_request_and_a_routine_never_spends(self):
        self.generators("fal")
        first = self.send("Make me a logo", "m1")
        self.session(first["run"]["id"]).call("generate_image", {"prompt": "a minimal fox logo"})
        later = self.session("run_" + "e" * 32)
        more = later.call("generate_image", {"prompt": "a minimal fox logo", "count": 2, "confirm": True})
        self.assertIn("costs more than what the user said yes to (about $0.003)", more)
        routine_pending = pip_images.folder(self.job["id"]) / "pending.json"
        pending_before = routine_pending.read_text()
        routine = self.session("run_" + "f" * 32, user_turn=False, unattended=True)
        said = routine.call("generate_image", {"prompt": "a minimal fox logo", "confirm": True})
        self.assertIn("only your reply to the user's own message", said)
        self.assertEqual(routine_pending.read_text(), pending_before,
                         "an unattended run cannot create or change a pending yes")
        self.assertEqual(self.fal_calls(), [])
        self.assertEqual(len(self.fal_calls()), 0)
        third = self.session("run_" + "9" * 32)
        reworded = third.call("generate_image", {"prompt": "minimal geometric fox logo", "confirm": True})
        self.assertIn("image request changed", reworded)
        self.assertEqual(len(self.fal_calls()), 0)

    def test_no_or_unrelated_reply_never_confirms_an_image(self):
        self.generators("fal")
        first = self.send("Make me a logo", "m1")
        self.session(first["run"]["id"]).call("generate_image", {"prompt": "a fox logo"})
        for index, reply in enumerate(("No", "Yes, but not yet", "Maybe", "", "yes to a different question")):
            said = self.session("run_" + str(index) * 32, user_message=reply).call(
                "generate_image", {"prompt": "a fox logo", "confirm": True})
            self.assertIn("did not explicitly say yes", said)
        self.assertEqual(self.fal_calls(), [])

    def test_same_price_but_changed_image_options_need_another_yes(self):
        self.generators("fal")
        first = self.send("Make me a logo", "m1")
        self.session(first["run"]["id"]).call("generate_image", {"prompt": "a fox logo"})
        said = self.session("run_" + "c" * 32).call(
            "generate_image", {"prompt": "a fox logo", "size": "512x512", "confirm": True})
        self.assertIn("image request changed", said)
        self.assertEqual(self.fal_calls(), [])

    def test_a_yes_given_within_the_limit_never_passes_it(self):
        # The user said yes to a picture within this month's limit; another one filled it before the Pip made it.
        self.generators("fal")
        block = images.settings(self.cfg)
        block["generators"][0]["monthly_limit_usd"] = 1
        self.cfg.set_images(block, persist=False)
        first = self.send("Make me a logo", "m1")
        self.session(first["run"]["id"]).call("generate_image", {"prompt": "a fox logo"})
        images.add_spend("fal", 0.999)
        said = self.session("run_" + "e" * 32).call("generate_image", {"prompt": "a fox logo", "confirm": True})
        self.assertIn("would now pass this month's limit", said)
        self.assertIn("Tell them too: This would pass this month's limit", said, "the new question says so")
        self.assertEqual(self.fal_calls(), [])
        made = self.session("run_" + "d" * 32).call("generate_image", {"prompt": "a fox logo", "confirm": True})
        self.assertTrue(made.startswith("Made 1 image"), "a yes to that question may pass it")

    def test_a_yes_to_a_price_never_covers_one_dgc_doesnt_know(self):
        self.generators("fal")
        block = images.settings(self.cfg)
        block["generators"][0]["monthly_limit_usd"] = 5
        self.cfg.set_images(block, persist=False)
        first = self.send("Make me a logo", "m1")
        self.session(first["run"]["id"]).call("generate_image", {"prompt": "a fox logo"})        # asked: $0.003
        said = self.session("run_" + "e" * 32).call("generate_image", {"prompt": "a fox logo", "confirm": True,
                                                                       "model": "fal-ai/brand-new-model"})
        self.assertIn("doesn't cover it", said)
        self.assertIn("Tell them too: DGC doesn't know what fal-ai/brand-new-model charges", said)
        self.assertEqual(self.fal_calls(), [])
        made = self.session("run_" + "d" * 32).call("generate_image", {"prompt": "a fox logo", "confirm": True,
                                                                       "model": "fal-ai/brand-new-model"})
        self.assertTrue(made.startswith("Made 1 image"), "a yes to that question, its price said unknown, makes it")
        other = self.session("run_" + "c" * 32).call("generate_image", {"prompt": "a fox logo", "confirm": True,
                                                                        "model": "fal-ai/another-new-model"})
        self.assertTrue(other.startswith("Not made"), "another unknown model is another question")

    def test_a_question_left_from_before_never_blocks_the_next_yes(self):
        self.generators("fal")
        (pip_images.folder(self.job["id"])).mkdir(parents=True, exist_ok=True)
        (pip_images.folder(self.job["id"]) / "pending.json").write_text(
            '{"run_id": "run_old", "generator": "fal", "prompt": "x", "at": 1}')      # an older DGC's, no price
        asking = self.session("run_" + "7" * 32)
        said = asking.call("generate_image", {"prompt": "a fox sticker", "confirm": True})
        self.assertIn("too long ago", said)
        self.assertIn("Not made yet: 1 image with fal FLUX schnell", said, "this request is the question now")
        made = self.session("run_" + "8" * 32).call("generate_image", {"prompt": "a fox sticker", "confirm": True})
        self.assertTrue(made.startswith("Made 1 image"), made)

    def test_allowed_it_makes_it_at_once(self):
        self.generators("fal")
        block = images.settings(self.cfg)
        block["generators"][0]["asks"] = False
        self.cfg.set_images(block, persist=False)
        sent = self.send("Make me a logo", "m1")
        said = self.session(sent["run"]["id"]).call("generate_image", {"prompt": "a fox logo"})
        self.assertTrue(said.startswith("Made 1 image"), said)

    def test_the_worker_is_offered_both_with_confirm_and_no_paths(self):
        names = {s["function"]["name"]: s["function"]["parameters"]["properties"] for s in pip_images.schemas()}
        self.assertEqual(set(names), {"generate_image", "list_image_generators"})
        self.assertIn("confirm", names["generate_image"])
        self.assertNotIn("save_to", names["generate_image"])

    def test_the_run_socket_answers_both(self):
        from dgc import pip_app_links as links
        self.generators("comfy")
        server = links.RunSocket(self.registry.directory, self.cfg, self.job["id"], self.job["workspace_id"],
                                 "run_" + "a" * 32)
        self.addCleanup(server.close)
        self.assertIn("Image generators (1)", links.worker_call(server.pin(), "list_image_generators", {}))
        self.assertTrue(links.worker_call(server.pin(), "generate_image", {"prompt": "x"}).startswith("Made 1 image"))


if __name__ == "__main__":
    unittest.main()
